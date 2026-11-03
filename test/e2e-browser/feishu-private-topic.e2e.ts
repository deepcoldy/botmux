/**
 * Private chat topic reply test:
 *
 * Verifies that bot replies use TOPIC REPLIES (话题回复) in private chats.
 * Private chats correctly set reply_in_thread=true, so replies should
 * appear as "话题回复" (not "条回复").
 *
 * This serves as the control test for feishu-group-topic.e2e.ts.
 */
import { describe, it, beforeAll, afterAll } from './midscene-suite.js';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import {
  testMessage,
  messageTag,
  sendMessage,
  openChat,
  waitForStreamingCard,
} from './helpers.js';
import { openFeishuSession, releaseFeishuSession } from './feishu-session.js';

export function registerMidsceneSuites(): void {
  describe('private chat topic reply mode', () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let agent: PlaywrightAgent;

    beforeAll(async () => {
      ({ browser, context, page, agent } = await openFeishuSession((p, a) => openChat(p, a, 'Claude')));
    }, 90_000);

    afterAll(async () => {
      await releaseFeishuSession({ browser, context, page, agent }, { closeBotSession: true, publishVideo: false });
    });

    it('bot uses topic replies in a private chat', async () => {
      const msg = testMessage('private-topic');
      await sendMessage(agent, msg, page);

      // Wait for bot to respond
      await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg, page });

      // Go back to main chat view to check thread indicator
      await page.keyboard.press('Escape');
      await page.waitForTimeout(2000);

      // Verify the reply uses TOPIC mode:
      // The message should show "话题回复" or "条话题回复" indicator,
      // NOT just "条回复" (inline reply).
      // Wait for thread indicator
      await page.waitForTimeout(3000);

      await agent.aiAssert(
        `消息"${messageTag(msg)}"所在区域可以看到包含"话题回复"的文字（例如"查看更早 N 条话题回复"或"N 条话题回复"或"回复话题"），` +
          '说明机器人使用了话题模式回复',
      );
    }, 300_000);
  });
}
