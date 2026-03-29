/**
 * Group chat topic/thread creation test:
 *  - In a regular group chat, @mention a bot with a message
 *  - Verify the bot creates a topic/thread to reply (not inline)
 *  - The reply should appear in a thread panel when clicked
 *
 * Per requirements: bots must ALWAYS create topics in any chat type.
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
  sendMentionMessage,
  navigateToMessenger,
  openChat,
  getGroupChatName,
  waitForStreamingCard,
  closeSession,
} from './helpers.js';

describe('group chat topic creation', () => {
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
    await openChat(page, agent, getGroupChatName());
  }, 120_000);

  afterAll(async () => {
    // Clean up: close the session
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('bot creates topic thread when replying in regular group', async () => {
    const msg = testMessage('group-topic');
    await sendMentionMessage(page, agent, 'Claude', msg);

    // Wait for bot to respond — this opens the thread panel
    await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg });

    // Key assertion: the response is in a THREAD panel (topic),
    // not just an inline reply in the group chat
    await agent.aiAssert(
      '右侧打开了一个话题详情面板，里面有来自 Claude 的回复和流式卡片',
    );

    // Verify the thread panel title or context shows it's a thread
    await agent.aiAssert(
      '话题面板的顶部或上下文区域显示了原始消息内容，表明这是一个话题/线程',
    );
  }, 240_000);
});
