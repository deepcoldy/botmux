/**
 * Card lifecycle test (consolidated single test):
 *  1. Card status: 启动中… / 工作中 → 等待输入
 *  2. Toggle button exists
 *  3. Screenshot output mode can be shown
 *
 * All assertions reference the specific test message to avoid
 * confusion with old test threads in the chat.
 */
import { describe, it, beforeAll, afterAll } from './midscene-suite.js';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import {
  testMessage,
  expectedReplyMarker,
  sendMessage,
  waitForStreamingCard,
  waitForCardStatus,
  showStreamingOutput,
  waitForModelTextReply,
  scrollThreadToBottom,
  openChat,
} from './helpers.js';
import { openFeishuSession, releaseFeishuSession } from './feishu-session.js';

export function registerMidsceneSuites(): void {
  describe('feishu card lifecycle', () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let agent: PlaywrightAgent;

    beforeAll(async () => {
      ({ browser, context, page, agent } = await openFeishuSession((p, a) => openChat(p, a, 'Claude')));
    });

    afterAll(async () => {
      await releaseFeishuSession({ browser, context, page, agent }, { closeBotSession: true, publishVideo: false });
    });

    it('full card lifecycle: active status → toggle → no artifacts → idle', async () => {
      const msg = testMessage('card');
      await sendMessage(agent, msg, page);

      // Wait for bot to respond, open thread panel, handle repo selection
      await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg, page });

      // --- Step 1: Verify current display toggle exists ---
      await agent.aiAssert(
        '右侧话题详情面板最底部当前会话的流式卡片里有"📖 显示输出"或"📕 隐藏输出"按钮',
      );

      // --- Step 2: Ensure output is visible in the current screenshot mode ---
      await showStreamingOutput(agent, page);

      // Check for ANSI escape codes specifically. CLI output may contain JSON
      // fragments from tool calls, which are expected terminal output.
      await agent.aiAssert(
        '右侧话题详情面板最底部当前会话的流式卡片可见输出区域不包含 ANSI 终端转义序列' +
          '（如"[32m""[0m""[1;34m"这类带方括号和字母的颜色代码）',
      );

      // --- Step 4: Wait for idle ---
      await scrollThreadToBottom(agent);
      await waitForCardStatus(agent, '等待输入', { timeoutMs: 180_000 });

      // --- Step 5: Verify bot sent actual reply (not just card status) ---
      await scrollThreadToBottom(agent);
      await waitForModelTextReply(agent, {
        botName: 'Claude',
        marker: expectedReplyMarker(msg),
        timeoutMs: 180_000,
      });
    }, 420_000);
  });
}
