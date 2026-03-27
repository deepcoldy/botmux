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
  waitForBotReply,
  waitForCardStatus,
  waitForStreamingCard,
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
      await agent?.destroy();
      await context?.close();
      await browser?.close();
    });

    it(`sends hello and receives reply from ${botName}`, async () => {
      // Navigate to bot's private chat
      await navigateToMessenger(page);
      await openChat(agent, botName);

      const msg = testMessage(botName.toLowerCase());
      await sendMessage(agent, msg);

      // Handle repo selection if it appears, then wait for streaming card
      await waitForStreamingCard(agent, { timeoutMs: 90_000 });

      // Verify the reply is from this bot
      await agent.aiAssert(
        `聊天中有来自 ${botName} 机器人的回复消息`,
      );
    }, 120_000);

    it(`card reaches idle status for ${botName}`, async () => {
      // This test continues from the previous test's state.
      // The card should eventually transition to "就绪".
      await waitForCardStatus(agent, '就绪', { timeoutMs: 90_000 });

      await agent.aiAssert(
        `有一个卡片的标题中包含"就绪"字样`,
      );
    }, 120_000);
  });
}
