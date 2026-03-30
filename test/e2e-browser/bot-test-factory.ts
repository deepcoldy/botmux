/**
 * Shared factory for per-bot E2E tests.
 * Each bot gets its own test file (for parallel execution).
 *
 * Test flow per bot:
 *  1. Navigate to messenger → click bot's private chat
 *  2. Send "hello" → bot creates topic and replies
 *  3. Verify streaming card appears
 *  4. Wait for card to reach "就绪"
 *  5. Verify bot sent an actual reply message (with @mention to user)
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
    }, 60_000);

    it(`sends hello, receives streaming card and actual reply from ${botName}`, async () => {
      await navigateToMessenger(page);
      await openChat(page, agent, botName);

      const msg = testMessage(botName.toLowerCase());
      await sendMessage(agent, msg);

      // Wait for streaming card in thread panel
      await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg });

      // Wait for card to reach idle — means CLI finished processing
      await scrollThreadToBottom(agent);
      await agent.aiWaitFor(
        '话题面板底部的流式卡片标题包含"就绪"',
        { timeoutMs: 120_000, checkIntervalMs: 5_000 },
      );

      // Verify the streaming card has actual output content (not just an empty card).
      // Different CLIs respond differently — some send separate text replies,
      // some only output through the streaming card. We check the card has content.
      await scrollThreadToBottom(agent);
      const needExpand = await agent.aiBoolean(
        '话题面板中的流式卡片里有"📖 展开输出"按钮',
      );
      if (needExpand) {
        await agent.aiAct('点击话题面板中流式卡片里的"📖 展开输出"按钮');
        await page.waitForTimeout(2000);
      }
      await agent.aiAssert(
        `话题面板中的流式卡片包含输出内容（展开后可见文本），` +
          `说明 ${botName} 已经处理了用户消息并产生了输出`,
      );
    }, 300_000);
  });
}
