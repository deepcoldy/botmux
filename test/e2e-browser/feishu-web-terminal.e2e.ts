/**
 * Web Terminal test:
 *  1. Send message → wait for streaming card → wait for "就绪"
 *  2. Expand card and extract content
 *  3. Click "打开终端" to open Web Terminal
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

    // Navigate once in beforeAll
    await navigateToMessenger(page);
    await openChat(agent, 'Claude');
  }, 90_000);

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('web terminal content matches card streaming output', async () => {
    const msg = testMessage('terminal');
    await sendMessage(agent, msg);

    // Open thread, handle repo, wait for streaming card
    await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg });

    // Wait for idle in the thread panel
    await agent.aiWaitFor(
      '话题面板中的流式卡片标题包含"就绪"',
      { timeoutMs: 120_000, checkIntervalMs: 5_000 },
    );

    // Ensure card is expanded
    const needExpand = await agent.aiBoolean(
      '话题面板中的流式卡片里有"📖 展开输出"按钮',
    );
    if (needExpand) {
      await agent.aiAct('点击话题面板中流式卡片里的"📖 展开输出"按钮');
      await page.waitForTimeout(2000);
    }

    // Extract card content as plain text
    const cardContent = await agent.aiString(
      '话题面板中流式卡片展开的输出内容文本是什么',
    );
    expect(cardContent).toBeTruthy();

    // Click "打开终端" and handle popup
    const popupPromise = context.waitForEvent('page', { timeout: 15_000 });
    await agent.aiAct('点击话题面板中流式卡片里的"🖥️ 打开终端"按钮');

    let terminalPage: Page;
    try {
      terminalPage = await popupPromise;
    } catch {
      // Link opened in same tab
      terminalPage = page;
    }

    await terminalPage.waitForLoadState('networkidle');
    await terminalPage.waitForTimeout(3000);

    const terminalAgent = new PlaywrightAgent(terminalPage);
    try {
      // Verify terminal loaded with content
      await terminalAgent.aiAssert('页面上有一个终端界面，显示了文本内容');

      // Compare: terminal should contain the key parts from the card
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
  }, 360_000); // 6 min — many steps
});
