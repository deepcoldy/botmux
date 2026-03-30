/**
 * Group chat topic/thread creation test:
 *
 * 1. Verifies bot uses TOPIC REPLIES (话题回复) in regular group chats
 * 2. Verifies only the @mentioned bot responds (not all bots)
 *
 * Feishu UI indicators for topic mode:
 *  - "查看更早 N 条话题回复" or "N 条话题回复" → topic mode
 *  - "N 条回复" (without "话题") → regular inline reply mode
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
  closeSession,
} from './helpers.js';

describe('group chat topic reply mode', () => {
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
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  }, 60_000);

  it('bot uses topic replies (话题回复) in regular group', async () => {
    const msg = testMessage('topic-mode');
    await sendMentionMessage(page, agent, 'Claude', msg);

    // Wait for bot to respond
    await agent.aiWaitFor(
      `聊天中"${msg}"消息附近出现了来自机器人的回复`,
      { timeoutMs: 90_000, checkIntervalMs: 5_000 },
    );

    await page.waitForTimeout(5000);

    // Verify topic reply mode by checking the thread structure.
    // In topic mode (reply_in_thread=true), bot replies are nested under
    // the original message as a thread. Indicators include:
    // - "查看更早 N 条话题回复" (when many replies)
    // - "回复话题" input at bottom of thread
    // - "N 条话题回复" counter
    // - Bot replies shown indented under the original message, not as
    //   separate top-level messages in the main chat
    //
    // We click into the message to open the thread panel, which confirms
    // topic mode is active.
    await agent.aiAct(
      `点击消息"${msg}"区域或附近的话题入口，打开话题详情`,
    );
    await page.waitForTimeout(3000);

    await agent.aiAssert(
      '右侧打开了话题详情面板，里面包含了机器人的回复（如卡片或文本消息），' +
        '这说明机器人的回复是以话题形式组织的',
    );
  }, 240_000);

  // "Only @mentioned bot responds" is covered by feishu-group-mention.e2e.ts
  // with a more robust approach (dedicated test with thread panel verification).
});
