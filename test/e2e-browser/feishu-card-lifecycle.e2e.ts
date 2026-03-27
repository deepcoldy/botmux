/**
 * Card lifecycle test:
 *  1. Card status transitions: 启动中… / 工作中 → 就绪
 *  2. Expand / collapse toggle
 *  3. Card content has no abnormal characters or CLI artifacts
 *  4. Card status label is correct when idle
 *
 * Runs against a bot private chat (FEISHU_TEST_GROUP_URL).
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
  getRequiredEnv,
  STORAGE_STATE_PATH,
  testMessage,
  sendMessage,
  waitForCardStatus,
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
  });

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('card shows working status, supports toggle, shows no artifacts, transitions to idle', async () => {
    const groupUrl = getRequiredEnv('FEISHU_TEST_GROUP_URL');
    const msg = testMessage('card');

    // Navigate to bot chat
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Send message
    await sendMessage(agent, msg);

    // --- Step 1: Card appears with active status ---
    // The card may show "启动中…" briefly then "工作中", or jump straight to "工作中".
    await agent.aiWaitFor(
      '页面上出现了一个卡片，其标题中包含"启动中"或"工作中"字样',
      { timeoutMs: 60_000, checkIntervalMs: 3_000 },
    );

    // --- Step 2: Expand output ---
    // Click the expand button to reveal streaming content
    await agent.aiAct('点击卡片上的"📖 展开输出"按钮');
    await page.waitForTimeout(2000);

    // Verify the card body now shows content and the toggle changed to collapse
    await agent.aiAssert(
      '卡片中有"📕 收起输出"按钮，说明输出已经展开',
    );

    // --- Step 3: Verify no abnormal characters in expanded content ---
    // Check that card content is clean text without terminal artifacts
    await agent.aiAssert(
      '卡片展开的输出内容是可读的文本，不包含乱码、' +
        '类似 [32m 或 [0m 的 ANSI 转义序列、' +
        '也不包含终端输入提示符（如 $ 或 > 开头的命令行提示）',
    );

    // --- Step 4: Collapse output ---
    await agent.aiAct('点击卡片上的"📕 收起输出"按钮');
    await page.waitForTimeout(1000);
    await agent.aiAssert(
      '卡片中有"📖 展开输出"按钮，说明输出已经收起',
    );

    // --- Step 5: Wait for card to transition to idle ---
    await waitForCardStatus(agent, '就绪', { timeoutMs: 90_000 });

    // Final assertions
    await agent.aiAssert(
      '有一个卡片的标题栏显示绿色背景，且包含"就绪"字样',
    );
  }, 180_000); // 3 minutes total
});
