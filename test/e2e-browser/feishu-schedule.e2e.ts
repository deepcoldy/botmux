/**
 * Scheduled task test:
 *  1. In a bot private chat, create a scheduled task via /schedule
 *  2. Trigger it immediately via /schedule run <id>
 *  3. Verify a NEW topic thread is created with "🕐 定时任务" message
 *  4. Verify the bot responds within that thread
 *
 * Per requirements: scheduled tasks MUST always create topics,
 * in any chat type (private, regular group, topic group).
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
  sendThreadReply,
  navigateToMessenger,
  openChat,
  waitForStreamingCard,
  scrollThreadToBottom,
  closeSession,
} from './helpers.js';

describe('scheduled task topic creation', () => {
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
  }, 120_000);

  afterAll(async () => {
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('scheduled task creates a new topic thread when triggered', async () => {
    const label = `sched-${Date.now()}`;

    // Step 1: Start a session to have a thread for sending commands
    const setupMsg = testMessage('sched-setup');
    await sendMessage(agent, setupMsg);
    await waitForStreamingCard(agent, {
      timeoutMs: 90_000,
      msgHint: setupMsg,
    });

    // Wait for bot to be ready so it can process commands
    await agent.aiWaitFor('话题面板中的流式卡片标题包含"就绪"', {
      timeoutMs: 120_000,
      checkIntervalMs: 5_000,
    });

    // Step 2: Create a scheduled task in the thread
    await sendThreadReply(agent, `/schedule 每小时 ${label}`);
    await page.waitForTimeout(5000);

    // Scroll thread panel to bottom to reveal the bot's response
    await scrollThreadToBottom(agent);
    await page.waitForTimeout(2000);

    // Extract the task ID from the bot's response in the thread panel
    await agent.aiWaitFor(
      '话题面板中出现了包含"✅ 定时任务已创建"的消息',
      { timeoutMs: 30_000, checkIntervalMs: 3_000 },
    );
    const taskId = await agent.aiString(
      '话题面板中"定时任务已创建"消息里，"ID:"后面的值是什么（8个字符的ID）',
    );

    // Step 3: Trigger the task immediately
    await sendThreadReply(agent, `/schedule run ${taskId}`);
    await page.waitForTimeout(3000);

    // Step 4: Go back to main chat to look for the new topic thread
    // Close the current thread panel first
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2000);

    // Verify a NEW thread was created with the scheduled task marker
    await agent.aiWaitFor(
      '聊天中出现了包含"🕐 定时任务"或"定时任务"字样的新消息',
      { timeoutMs: 60_000, checkIntervalMs: 5_000 },
    );

    // Click into that thread to verify bot responded
    await agent.aiAct(
      '点击包含"定时任务"的消息或其"回复话题"链接，打开话题详情',
    );
    await page.waitForTimeout(3000);

    // Verify the task created a topic with bot response
    await agent.aiAssert(
      '页面上包含"定时任务"的消息区域有来自 Claude 的回复（流式卡片或文本消息）',
    );

    // Verify topic reply mode for the scheduled task thread
    await agent.aiAssert(
      '包含"定时任务"的消息区域可以看到包含"话题回复"的文字，说明定时任务使用了话题模式',
    );
  }, 480_000); // 8 min — many steps
});
