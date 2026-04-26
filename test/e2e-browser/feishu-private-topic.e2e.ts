/**
 * Private chat topic reply test:
 *
 * Verifies that bot replies use TOPIC REPLIES (话题回复) in private chats.
 * Private chats correctly set reply_in_thread=true, so replies should
 * appear as "话题回复" (not "条回复").
 *
 * This serves as the control test for feishu-group-topic.e2e.ts.
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
  messageTag,
  sendMessage,
  navigateToMessenger,
  openChat,
  waitForStreamingCard,
  closeSession,
} from './helpers.js';

describe('private chat topic reply mode', () => {
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

  it('bot uses topic replies (话题回复) in private chat', async () => {
    const msg = testMessage('private-topic');
    await sendMessage(agent, msg);

    // Wait for bot to respond
    await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg, page });

    // Go back to main chat view to check thread indicator
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2000);

    // Verify the reply uses TOPIC mode:
    // The message should show "话题回复" or "条话题回复" indicator,
    // NOT just "条回复" (inline reply).
    // Wait for thread indicator
    await page.waitForTimeout(3000);

    await agent.aiAssert(
      `消息"${messageTag(msg)}"所在区域可以看到包含"话题回复"的文字（例如"查看更早 N 条话题回复"或"N 条话题回复"或"回复话题"），` +
        '说明机器人使用了话题模式回复',
    );
  }, 300_000);
});
