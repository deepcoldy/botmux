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

    await agent.aiAssert(
      '话题面板中流式卡片展开的输出内容是可读的正常文本，' +
        '不包含类似 [32m 或 [0m 的 ANSI 转义序列，' +
        '不包含乱码或不可读字符',
    );

    // --- Step 4: Wait for idle ---
    await agent.aiWaitFor(
      '话题面板中的流式卡片标题包含"就绪"',
      { timeoutMs: 120_000, checkIntervalMs: 5_000 },
    );
  }, 300_000);
});
