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
  scrollThreadToBottom,
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

      // Verify the bot actually replied (not just repo/status messages).
      // The real reply is a message with @mention to the user, appearing
      // after the streaming card — NOT the "工作目录" or repo selection text.
      await scrollThreadToBottom(agent);
      await agent.aiAssert(
        `话题面板底部有来自 ${botName} 的流式卡片（标题含"启动中"或"工作中"或"就绪"）`,
      );
    }, 240_000);

    it(`card reaches idle status for ${botName}`, async () => {
      // Continues from the thread panel opened by previous test
      await scrollThreadToBottom(agent);
      await agent.aiWaitFor(
        '话题面板底部的流式卡片标题包含"就绪"',
        { timeoutMs: 120_000, checkIntervalMs: 5_000 },
      );
    }, 180_000);
  });
}
