/**
 * Group chat topic/thread creation test:
 *  - In a regular group chat, @mention a bot with a message
 *  - Verify the bot replies and creates a topic (thread structure)
 *  - The reply should be associated with the original message
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
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('bot creates topic when replying in regular group', async () => {
    const msg = testMessage('group-topic');
    await sendMentionMessage(page, agent, 'Claude', msg);

    // Wait for bot to respond (any reply card or message from Claude)
    await agent.aiWaitFor(
      `聊天中"${msg}"消息下方出现了来自 Claude 机器人的回复`,
      { timeoutMs: 90_000, checkIntervalMs: 5_000 },
    );

    // Verify the reply is in a topic/thread structure:
    // In Feishu, threaded replies show "N条回复" or "回复话题" under
    // the original message, indicating a topic was created.
    await agent.aiAssert(
      `消息"${msg}"区域可以看到"回复话题"或"条回复"的链接，` +
        '说明机器人的回复是以话题/线程形式组织的，而不是普通的群聊消息',
    );
  }, 240_000);
});
