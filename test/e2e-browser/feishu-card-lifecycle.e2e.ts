/**
 * Card lifecycle test:
 *  1. Card status transitions: 启动中… / 工作中 → 就绪
 *  2. Expand / collapse toggle
 *  3. Card content has no abnormal characters or CLI artifacts
 *  4. Card status label is correct when idle
 *
 * Navigates to Claude private chat via messenger sidebar.
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
  waitForCardStatus,
  waitForStreamingCard,
  navigateToMessenger,
  openChat,
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

    // Navigate once in beforeAll — saves ~20s of AI calls per test
    await navigateToMessenger(page);
    await openChat(agent, 'Claude');
  }, 60_000);

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('card shows active status after sending message', async () => {
    const msg = testMessage('card');
    await sendMessage(agent, msg);

    // Handle repo selection if it appears, then wait for streaming card
    await waitForStreamingCard(agent, { timeoutMs: 90_000 });
  }, 150_000);

  it('expand/collapse toggle works', async () => {
    // Expand
    await agent.aiAct('点击卡片上的"📖 展开输出"按钮');
    await page.waitForTimeout(2000);
    await agent.aiAssert('卡片中有"📕 收起输出"按钮，说明输出已展开');

    // Collapse
    await agent.aiAct('点击卡片上的"📕 收起输出"按钮');
    await page.waitForTimeout(1000);
    await agent.aiAssert('卡片中有"📖 展开输出"按钮，说明输出已收起');
  }, 120_000);

  it('expanded card content has no abnormal characters', async () => {
    // Re-expand to check content quality
    await agent.aiAct('点击卡片上的"📖 展开输出"按钮');
    await page.waitForTimeout(2000);

    await agent.aiAssert(
      '卡片展开的输出内容是可读的正常文本，' +
        '不包含类似 [32m 或 [0m 的 ANSI 转义序列，' +
        '不包含乱码或不可读字符',
    );
  }, 120_000);

  it('card transitions to idle status', async () => {
    await waitForCardStatus(agent, '就绪', { timeoutMs: 120_000 });
    await agent.aiAssert('有一个卡片标题中包含"就绪"字样');
  }, 180_000);
});
