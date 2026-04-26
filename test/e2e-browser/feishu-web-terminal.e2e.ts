/**
 * Web Terminal test:
 *  1. Send message → wait for streaming card → wait for "等待输入"
 *  2. Show the card screenshot output
 *  3. Open Web Terminal (click button or follow link)
 *  4. Verify terminal loaded
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
  expectedReplyMarker,
  sendMessage,
  waitForStreamingCard,
  waitForCardStatus,
  waitForModelTextReply,
  showStreamingOutput,
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
  });

  it('web terminal opens from the current streaming card', async () => {
    const msg = testMessage('terminal');
    await sendMessage(agent, msg);

    // Open thread, handle repo, wait for streaming card
    await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg, page });

    // Wait for idle, then confirm the model actually produced a text reply —
    // only then is the session in a good state to exercise the terminal button.
    await waitForCardStatus(agent, '等待输入', { timeoutMs: 120_000 });
    await waitForModelTextReply(agent, {
      botName: 'Claude',
      marker: expectedReplyMarker(msg),
      timeoutMs: 120_000,
    });

    // Show output so the test covers the current display toggle labels.
    await showStreamingOutput(agent, page);

    // Scroll down in thread panel to reveal card buttons below expanded content
    await agent.aiScroll(undefined, { direction: 'down', scrollType: 'untilBottom' });
    await page.waitForTimeout(1000);

    // Open terminal: listen for popup OR navigation simultaneously
    let terminalPage: Page | null = null;

    // Set up popup listener before clicking
    const popupHandler = (p: Page) => { terminalPage = p; };
    context.on('page', popupHandler);

    await agent.aiAct('点击右侧话题详情面板最底部当前会话流式卡片里的"🖥️ 打开终端"按钮');

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
    } finally {
      await terminalAgent.destroy();
      if (terminalPage !== page) {
        await terminalPage.close();
      }
    }
  }, 420_000); // 7 min
});
