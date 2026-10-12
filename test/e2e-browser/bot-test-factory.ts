/**
 * Shared factory for per-bot E2E tests.
 * Each bot gets its own test file (for parallel execution).
 *
 * Test flow per bot:
 *  1. Navigate to messenger → click bot's private chat
 *  2. Send a tagged prompt → bot creates a topic
 *  3. Non-Codex: streaming card, then the model reply bubble (ACK-e2e-…).
 *     That bubble is the success gate. Do not hard-wait for the card title
 *     「等待输入」 first — the ACK can already be on screen while the card
 *     body still reads 「回复 — 工作中」.
 *  4. Codex: open the thread and click 「直接开启会话」 before any streaming
 *     wait, same order as Codex prompt submission, then accept a Codex-side
 *     response (marker, or a usage/rate-limit notice).
 *  5. Close session and verify 「会话已关闭」
 */
import { describe, it, beforeAll, afterAll } from './midscene-suite.js';
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
  openThreadForMessage,
  waitForStreamingCard,
  waitForCodexSideResponse,
  clickDirectStartIfPresent,
  showStreamingOutput,
  waitForModelTextReply,
  scrollThreadToBottom,
  closeSession,
  type BotName,
} from './helpers.js';
import { publishLabeledPageVideo } from './e2e-video.js';

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
      try {
        await publishLabeledPageVideo(page);
      } catch (error) {
        console.error('Feishu video publish failed:', error);
      }
      await browser?.close();
    });

    const title = opts?.allowCodexUsageLimitResponse
      ? `sends hello, opens the current thread, and receives a Codex-side response`
      : `sends hello, receives streaming card and actual reply from ${botName}`;
    const timeoutMs = opts?.allowCodexUsageLimitResponse ? 600_000 : 360_000;

    it(title, async () => {
      await navigateToMessenger(page);
      await openChat(page, agent, botName);

      if (opts?.allowCodexUsageLimitResponse) {
        // Match the passing Codex prompt submission case: open the thread
        // and click 「直接开启会话」 before any streaming-card wait.
        const marker = `CODEX_E2E_MARKER_${Date.now()}`;
        const msg = `${testMessage('codex-marker', { plain: true })} 请在最终回复中原样包含 ${marker}`;
        await sendMessage(agent, msg);
        await openThreadForMessage(agent, { timeoutMs: 120_000, msgHint: msg, page });
        await clickDirectStartIfPresent(agent, page);
        await scrollThreadToBottom(agent);
        await waitForCodexSideResponse(agent, { marker, timeoutMs: 180_000 });
        return;
      }

      const msg = testMessage(botName.toLowerCase());
      await sendMessage(agent, msg);

      // Session started. Title 「等待输入」 is not the success gate: Claude
      // can send ACK-e2e-… while the card body still reads 「回复 — 工作中」.
      await waitForStreamingCard(agent, {
        timeoutMs: 90_000,
        msgHint: msg,
        page,
      });

      await scrollThreadToBottom(agent);
      await waitForModelTextReply(agent, {
        botName,
        marker: expectedReplyMarker(msg),
        timeoutMs: 180_000,
      });

      // The ACK bubble is now the last item. showStreamingOutput scrolls the
      // streaming card itself into view; scrolling to the thread bottom
      // hides that card behind the bubble.
      await showStreamingOutput(agent, page);
    }, timeoutMs);
  });
}
