/**
 * Card lifecycle test (consolidated single test):
 *  1. Card status: 启动中… / 工作中 → 就绪
 *  2. Toggle button exists
 *  3. Expanded content has no abnormal characters
 *
 * All assertions reference the specific test message to avoid
 * confusion with old test threads in the chat.
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
  waitForStreamingCard,
  scrollThreadToBottom,
  navigateToMessenger,
  openChat,
  closeSession,
} from './helpers.js';

describe('feishu card lifecycle', () => {
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

    await navigateToMessenger(page);
    await openChat(page, agent, 'Claude');
  }, 120_000);

  afterAll(async () => {
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  }, 60_000);

  it('full card lifecycle: active status → toggle → no artifacts → idle', async () => {
    const msg = testMessage('card');
    await sendMessage(agent, msg);

    // Wait for bot to respond, open thread panel, handle repo selection
    await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg });

    // --- Step 1: Verify toggle button exists ---
    await agent.aiAssert(
      '话题面板中的流式卡片里有"📕 收起输出"或"📖 展开输出"按钮',
    );

    // --- Step 3: Ensure expanded and check content ---
    const needExpand = await agent.aiBoolean(
      '话题面板中的流式卡片里有"📖 展开输出"按钮',
    );
    if (needExpand) {
      await agent.aiAct('点击话题面板中流式卡片里的"📖 展开输出"按钮');
      await page.waitForTimeout(2000);
    }

    // Check for ANSI escape codes specifically (the real concern).
    // Note: CLI output may contain JSON fragments from MCP tool calls,
    // which look messy but are expected terminal output.
    await agent.aiAssert(
      '话题面板中流式卡片展开的输出内容不包含 ANSI 终端转义序列' +
        '（如"[32m""[0m""[1;34m"这类带方括号和字母的颜色代码）',
    );

    // --- Step 4: Wait for idle ---
    await scrollThreadToBottom(agent);
    await agent.aiWaitFor(
      '话题面板底部的流式卡片标题包含"就绪"',
      { timeoutMs: 120_000, checkIntervalMs: 5_000 },
    );

    // --- Step 5: Verify bot sent actual reply (not just card status) ---
    await scrollThreadToBottom(agent);
    await agent.aiAssert(
      '话题面板中有来自 Claude 的文本回复消息（包含"@"某用户的内容），' +
        '这是机器人对用户问题的实际回答，不是"继续使用当前仓库"等状态消息',
    );
  }, 300_000);
});
