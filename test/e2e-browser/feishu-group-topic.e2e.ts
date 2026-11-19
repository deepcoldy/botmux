/**
 * Group chat topic/thread creation test:
 *
 * 1. Verifies bot uses TOPIC REPLIES (话题回复) in regular group chats
 * 2. Verifies only the @mentioned bot responds (not all bots)
 *
 * Feishu UI indicators for topic mode:
 *  - "查看更早 N 条话题回复" or "N 条话题回复" → topic mode
 *  - "N 条回复" (without "话题") → regular inline reply mode
 */
import { describe, it, beforeAll, afterAll } from './midscene-suite.js';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import {
  testMessage,
  expectedReplyMarker,
  sendMentionMessage,
  openGroupChat,
  getGroupChatName,
  openThreadForMessage,
  scrollThreadToBottom,
  waitForModelTextReply,
} from './helpers.js';
import { openFeishuSession, releaseFeishuSession } from './feishu-session.js';

export function registerMidsceneSuites(): void {
  describe('group chat topic reply mode', () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let agent: PlaywrightAgent;

    beforeAll(async () => {
      ({ browser, context, page, agent } = await openFeishuSession((p, a) => openGroupChat(p, a, getGroupChatName())));
    });

    afterAll(async () => {
      await releaseFeishuSession({ browser, context, page, agent }, { closeBotSession: true, publishVideo: false });
    });

    it('bot uses topic replies in a regular group', async () => {
      const msg = testMessage('topic-mode');
      await sendMentionMessage(page, agent, 'Claude', msg);

      // 关键：用 openThreadForMessage（点消息列表里以这条消息为标题的话题条目）
      // 找到并打开这个测试话题。如果 bot 用的是普通内联回复而不是话题回复，
      // 列表里就不会有这样的话题条目 —— 所以这一步成功本身就证明了话题模式启用。
      await openThreadForMessage(agent, { msgHint: msg, timeoutMs: 120_000, page });

      await scrollThreadToBottom(agent);

      // 双重验证：既是话题模式（上面走通了），也要模型真的在话题里回了 ACK marker。
      await waitForModelTextReply(agent, {
        botName: 'Claude',
        marker: expectedReplyMarker(msg),
        timeoutMs: 180_000,
      });
    }, 360_000);

    // "Only @mentioned bot responds" is covered by feishu-group-mention.e2e.ts
    // with a more robust approach (dedicated test with thread panel verification).
  });
}
