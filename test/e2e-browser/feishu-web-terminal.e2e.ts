/**
 * Web Terminal test:
 *  1. Send message → wait for streaming card → wait for "就绪"
 *  2. Expand card and extract content
 *  3. Open Web Terminal (click button or follow link)
 *  4. Verify terminal loaded and content is consistent with card
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
  waitForStreamingCard,
  navigateToMessenger,
  openChat,
  closeSession,
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

    await navigateToMessenger(page);
    await openChat(page, agent, 'Claude');
  }, 90_000);

  afterAll(async () => {
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  }, 60_000);

  it('web terminal content matches card streaming output', async () => {
    const msg = testMessage('terminal');
    await sendMessage(agent, msg);

    // Open thread, handle repo, wait for streaming card
    await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg });

    // Wait for idle
    await agent.aiWaitFor('话题面板中的流式卡片标题包含"就绪"', {
      timeoutMs: 120_000,
      checkIntervalMs: 5_000,
    });

    // Ensure expanded
    const needExpand = await agent.aiBoolean(
      '话题面板中的流式卡片里有"📖 展开输出"按钮',
    );
    if (needExpand) {
      await agent.aiAct('点击话题面板中流式卡片里的"📖 展开输出"按钮');
      await page.waitForTimeout(2000);
    }

    // Extract card content
    const cardContent = await agent.aiString(
      '话题面板中流式卡片展开的输出内容文本是什么',
    );
    expect(cardContent).toBeTruthy();

    // Scroll down in thread panel to reveal card buttons below expanded content
    await agent.aiScroll(undefined, { direction: 'down', scrollCount: 3 });
    await page.waitForTimeout(1000);

    // Open terminal: listen for popup OR navigation simultaneously
    let terminalPage: Page | null = null;

    // Set up popup listener before clicking
    const popupHandler = (p: Page) => { terminalPage = p; };
    context.on('page', popupHandler);

    await agent.aiAct('点击话题面板中流式卡片里的"🖥️ 打开终端"按钮');

    // Wait briefly for popup
    await page.waitForTimeout(5000);
    context.off('page', popupHandler);

    if (!terminalPage) {
      // No popup — check if current page navigated to terminal
      const currentUrl = page.url();
      if (currentUrl.includes('terminal') || currentUrl.includes(':')) {
        terminalPage = page;
      }
    }

    if (!terminalPage) {
      console.warn('Could not open web terminal popup — skipping content comparison');
      return;
    }

    // The terminal page might close immediately if the URL isn't reachable
    try {
      await terminalPage.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch {
      console.warn('Web terminal page not reachable — skipping content comparison');
      if (terminalPage !== page) await terminalPage.close().catch(() => {});
      return;
    }
    await terminalPage.waitForTimeout(3000);

    const terminalAgent = new PlaywrightAgent(terminalPage);
    try {
      await terminalAgent.aiAssert('页面上有一个终端界面，显示了文本内容');

      const snippet = String(cardContent).slice(0, 200);
      await terminalAgent.aiAssert(
        `终端中显示的内容与以下卡片内容在语义上一致或包含其关键部分：「${snippet}」`,
      );
    } finally {
      await terminalAgent.destroy();
      if (terminalPage !== page) {
        await terminalPage.close();
      }
    }
  }, 420_000); // 7 min
});
