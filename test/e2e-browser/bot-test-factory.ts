/**
 * Shared factory for per-bot E2E tests.
 * Each bot gets its own test file (for parallel execution) that calls this factory.
 *
 * Test flow per bot:
 *  1. Navigate to messenger → click bot's private chat
 *  2. Send "hello" → bot creates topic and replies
 *  3. Verify card appears with status
 *  4. Verify bot sends a text reply
 *  5. Wait for card to reach "就绪" status
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
  sendMessage,
  navigateToMessenger,
  openChat,
  waitForStreamingCard,
  closeSession,
  type BotName,
} from './helpers.js';

export function createBotTest(botName: BotName): void {
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

    it(`sends hello and receives reply from ${botName}`, async () => {
      // Navigate to bot's private chat
      await navigateToMessenger(page);
      await openChat(page, agent, botName);

      const msg = testMessage(botName.toLowerCase());
      await sendMessage(agent, msg);

      // Handle repo selection if it appears, then wait for streaming card
      await waitForStreamingCard(agent, {
        timeoutMs: 90_000,
        msgHint: msg,
      });

      // Verify the reply is from this bot (we're now in the thread panel)
      await agent.aiAssert(
        `话题面板中有来自 ${botName} 机器人的回复`,
      );
    }, 240_000);

    it(`card reaches idle status for ${botName}`, async () => {
      // Continues from the thread panel opened by previous test
      await agent.aiWaitFor(
        '话题面板中的流式卡片标题包含"就绪"',
        { timeoutMs: 120_000, checkIntervalMs: 5_000 },
      );
    }, 180_000);
  });
}
