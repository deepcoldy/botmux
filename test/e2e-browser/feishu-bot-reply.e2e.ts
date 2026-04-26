/**
 * Basic smoke test: send a message to a bot → bot replies.
 * Navigates to messenger → opens Claude chat → sends message.
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
  waitForModelTextReply,
  navigateToMessenger,
  openChat,
  closeSession,
} from './helpers.js';

describe('feishu bot reply (smoke test)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let agent: PlaywrightAgent;

  beforeAll(async () => {
    checkPrerequisites();
    if (!existsSync(STORAGE_STATE_PATH)) {
      throw new Error(
        'storageState.json not found. Run setup first: pnpm test:e2e-browser:setup',
      );
    }
    browser = await createBrowser();
    ({ context, page } = await createPage(browser));
    agent = createAgent(page);
  });

  afterAll(async () => {
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('should receive bot reply after sending a message', async () => {
    const msg = testMessage();

    await navigateToMessenger(page);
    await openChat(page, agent, 'Claude');
    await sendMessage(agent, msg);
    await waitForStreamingCard(agent, { msgHint: msg, page });
    // 流式卡片只证明 CLI 被拉起了；必须等到模型真正输出一条文本气泡才算成功。
    await waitForModelTextReply(agent, {
      botName: 'Claude',
      marker: expectedReplyMarker(msg),
      timeoutMs: 180_000,
    });
  }, 360_000);
});
