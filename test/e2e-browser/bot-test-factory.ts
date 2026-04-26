/**
 * Shared factory for per-bot E2E tests.
 * Each bot gets its own test file (for parallel execution).
 *
 * Test flow per bot:
 *  1. Navigate to messenger → click bot's private chat
 *  2. Send "hello" → bot creates topic and replies
 *  3. Verify streaming card appears
 *  4. Wait for card to reach "等待输入", or for Codex to return a quota/rate-limit response
 *  5. Verify bot sent an actual text reply message, or that Codex reached Codex-side response handling
 *  6. Close session and verify "会话已关闭"
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { existsSync } from 'node:fs';
import {
  createBrowser,
  createPage,
  createAgent,
  checkPrerequisites,
  STORAGE_STATE_PATH,
  testMessage,
  expectedReplyMarker,
  sendMessage,
  navigateToMessenger,
  openChat,
  waitForStreamingCard,
  waitForCardStatus,
  waitForIdleOrCodexUsageLimit,
  waitForCodexSideResponse,
  clickDirectStartIfPresent,
  showStreamingOutput,
  waitForModelTextReply,
  scrollThreadToBottom,
  closeSession,
  type BotName,
} from './helpers.js';

type BotTestOptions = {
  allowCodexUsageLimitResponse?: boolean;
};

export function createBotTest(botName: BotName, opts?: BotTestOptions): void {
  describe(`${botName} basic flow`, () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let agent: PlaywrightAgent;

    beforeAll(async () => {
      checkPrerequisites();
      if (!existsSync(STORAGE_STATE_PATH)) {
        throw new Error(
          'storageState.json not found. Run: pnpm test:e2e-browser:setup',
        );
      }
      browser = await createBrowser();
      ({ context, page } = await createPage(browser));
      agent = createAgent(page);
    });

    afterAll(async () => {
      await closeSession(agent, page);
      await agent?.destroy();
      await context?.close();
      await browser?.close();
    });

    const title = opts?.allowCodexUsageLimitResponse
      ? `sends hello, opens the current thread, and receives a Codex-side response`
      : `sends hello, receives streaming card and actual reply from ${botName}`;
    const timeoutMs = opts?.allowCodexUsageLimitResponse ? 600_000 : 360_000;

    it(title, async () => {
      await navigateToMessenger(page);
      await openChat(page, agent, botName);

      const msg = testMessage(botName.toLowerCase());
      await sendMessage(agent, msg);

      // Wait for streaming card in thread panel
      await waitForStreamingCard(agent, {
        timeoutMs: 90_000,
        msgHint: msg,
        page,
      });
      if (opts?.allowCodexUsageLimitResponse) {
        await clickDirectStartIfPresent(agent, page);
      }

      // Wait for card to reach idle, or for Codex to return a quota/rate-limit response.
      await scrollThreadToBottom(agent);
      const outcome = opts?.allowCodexUsageLimitResponse
        ? await waitForIdleOrCodexUsageLimit(agent, { timeoutMs: 180_000 })
        : 'idle';
      if (outcome === 'idle') {
        await waitForCardStatus(agent, '等待输入', { timeoutMs: 120_000 });
      }

      if (outcome === 'codex-usage-limit') {
        await scrollThreadToBottom(agent);
        await waitForCodexSideResponse(agent, { timeoutMs: 60_000 });
        return;
      }

      // --- Step A: Wait for the model's actual text reply. This is the
      //      real "task succeeded" gate — card status "等待输入" only
      //      proves the CLI went idle, not that the model answered. ---
      await scrollThreadToBottom(agent);
      await waitForModelTextReply(agent, {
        botName,
        marker: expectedReplyMarker(msg),
        timeoutMs: 180_000,
      });

      // --- Step B: Verify the streaming card's display-toggle still works
      //      (i.e. the Feishu card feature is healthy). Running this AFTER
      //      the text reply is in place means the card has a real screenshot
      //      to show and the toggle isn't fighting a mid-flight re-render. ---
      await scrollThreadToBottom(agent);
      await showStreamingOutput(agent, page);
    }, timeoutMs);
  });
}
