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
  sendMessage,
  waitForStreamingCard,
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
  }, 60_000);

  it('should receive bot reply after sending a message', async () => {
    const msg = testMessage();

    await navigateToMessenger(page);
    await openChat(page, agent, 'Claude');
    await sendMessage(agent, msg);
    await waitForStreamingCard(agent);
    await agent.aiAssert('聊天中有来自机器人的回复消息');
  }, 240_000);
});
