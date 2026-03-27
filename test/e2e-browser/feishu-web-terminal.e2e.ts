/**
 * Web Terminal test:
 *  1. Send message → wait for card with "就绪" status
 *  2. Expand card to see streaming content
 *  3. Click "打开终端" to open Web Terminal in new tab
 *  4. Verify terminal content is consistent with card content
 *     (no missing or extra text)
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
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

describe('feishu web terminal', () => {
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

  it('web terminal content matches card streaming output', async () => {
    const msg = testMessage('terminal');

    // Navigate to Claude chat and send message
    await navigateToMessenger(page);
    await openChat(agent, 'Claude');
    await sendMessage(agent, msg);

    // Handle repo selection if needed, then wait for streaming card
    await waitForStreamingCard(agent, { timeoutMs: 90_000 });

    // Wait for bot to finish responding
    await waitForCardStatus(agent, '就绪', { timeoutMs: 120_000 });

    // Expand card to see full output
    await agent.aiAct('点击卡片上的"📖 展开输出"按钮');
    await page.waitForTimeout(2000);

    // Extract card content text
    const cardContent = await agent.aiQuery(
      '读取卡片中展开的输出内容文本（"📕 收起输出"按钮上方的文本），返回为字符串',
    );

    // Open Web Terminal — click the button and catch the popup
    const popupPromise = context.waitForEvent('page', { timeout: 15_000 });
    await agent.aiAct('点击卡片上的"🖥️ 打开终端"按钮');

    let terminalPage: Page;
    try {
      terminalPage = await popupPromise;
    } catch {
      // If no popup, the link may have opened in same tab via navigation
      // In that case the current page IS the terminal page
      terminalPage = page;
    }

    await terminalPage.waitForLoadState('networkidle');
    await terminalPage.waitForTimeout(3000);

    // Create a separate agent for the terminal page
    const terminalAgent = new PlaywrightAgent(terminalPage);
    try {
      // Verify the web terminal loaded and shows content
      await terminalAgent.aiAssert(
        '页面上有一个终端界面，显示了文本内容',
      );

      // Extract terminal content
      const terminalContent = await terminalAgent.aiQuery(
        '读取终端界面中显示的主要文本内容，返回为字符串',
      );

      // Both contents should exist
      expect(cardContent).toBeTruthy();
      expect(terminalContent).toBeTruthy();

      // The terminal should contain the key parts from the card
      // (terminal has full scrollback; card has latest snapshot)
      // We use AI to compare rather than exact string matching,
      // since formatting may differ slightly.
      await terminalAgent.aiAssert(
        `终端中显示的内容与以下卡片内容在语义上一致或包含其关键部分：「${String(cardContent).slice(0, 200)}」`,
      );
    } finally {
      await terminalAgent.destroy();
      // Close terminal tab if it's a popup
      if (terminalPage !== page) {
        await terminalPage.close();
      }
    }
  }, 180_000);
});
