/**
 * Scheduled task test:
 *  1. In a bot private chat, create a scheduled task via /schedule inside a thread
 *  2. Trigger it immediately via /schedule run <id>
 *  3. Verify the task replies INSIDE the ORIGINAL thread (no new top-level message
 *     in main chat) — this is the behavior introduced April 2026.
 *
 * Per requirements: scheduled tasks MUST reply into the original topic thread so
 * the user sees a coherent conversation, not a new thread per run.
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
  sendThreadReply,
  navigateToMessenger,
  openChat,
  waitForStreamingCard,
  waitForCardStatus,
  waitForModelTextReply,
  scrollThreadToBottom,
  closeSession,
} from './helpers.js';

describe('scheduled task thread continuity', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let agent: PlaywrightAgent;
  let createdTaskId: string | undefined;

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
  });

  afterAll(async () => {
    // Clean up the scheduled task before closing the session
    if (createdTaskId && agent && page) {
      try {
        await scrollThreadToBottom(agent);
        await agent.aiAct('点击右侧话题面板最底部的回复输入框');
        await page.waitForTimeout(500);
        await page.keyboard.type(`/schedule remove ${createdTaskId}`, { delay: 30 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
      } catch {
        // Best-effort cleanup — don't fail teardown
      }
    }
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('scheduled task replies inside the original thread when triggered', async () => {
    const label = `sched-${Date.now()}`;

    // Step 1: Start a session to get a thread.
    const setupMsg = testMessage('sched-setup');
    await sendMessage(agent, setupMsg);
    await waitForStreamingCard(agent, {
      timeoutMs: 90_000,
      msgHint: setupMsg,
      page,
    });

    // Wait for bot to be ready so it can process /schedule commands.
    await waitForCardStatus(agent, '等待输入', { timeoutMs: 120_000 });

    // Step 2: Create a scheduled task inside this thread.
    await scrollThreadToBottom(agent);
    await agent.aiAct('点击右侧话题面板最底部的回复输入框');
    await page.waitForTimeout(500);
    // Use "every 1h" (interval) — exercises the new one-shot/interval parsing path.
    await page.keyboard.type(`/schedule 每小时 ${label}`, { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);

    // Scroll thread panel to bottom to reveal the bot's response.
    await scrollThreadToBottom(agent);
    await page.waitForTimeout(2000);

    // Extract the task ID from the "✅ 定时任务已创建" reply.
    await agent.aiWaitFor(
      '话题面板中出现了包含"✅ 定时任务已创建"或"定时任务已创建"的消息',
      { timeoutMs: 60_000, checkIntervalMs: 5_000 },
    );
    const taskId = await agent.aiString(
      '话题面板中"定时任务已创建"消息里，"ID:"后面的值是什么（8个字符的ID）',
    );
    createdTaskId = taskId;

    // Step 3: Trigger the task immediately.
    await scrollThreadToBottom(agent);
    await agent.aiAct('点击右侧话题面板最底部的回复输入框');
    await page.waitForTimeout(500);
    await page.keyboard.type(`/schedule run ${taskId}`, { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);

    // Step 4: Verify the task executed INSIDE the current thread — the "🕐 定时任务
    // 「<label>」开始执行" message should appear in the thread panel, and the bot
    // should respond there, NOT in a new top-level message in the main chat.
    await scrollThreadToBottom(agent);
    await agent.aiWaitFor(
      '话题面板（右侧）中出现了包含"🕐 定时任务"或"定时任务「' + label + '」开始执行"的消息',
      { timeoutMs: 60_000, checkIntervalMs: 5_000 },
    );

    // The bot should produce a response in the same thread. 必须真拿到模型文本回复——
    // "🕐 定时任务 开始执行" 是 botmux 发的系统提示，不能当作模型的回复。
    // setupMsg 自带 ACK marker，触发任务后模型重跑该指令 → 同样的 marker 会再出现在话题里。
    await scrollThreadToBottom(agent);
    await waitForModelTextReply(agent, {
      botName: 'Claude',
      marker: expectedReplyMarker(setupMsg),
      timeoutMs: 180_000,
    });

    // Negative assertion: the main chat (not thread panel) should NOT show a new
    // top-level "🕐 定时任务" message — this is the thread-continuity fix.
    // Close the thread panel temporarily to inspect main chat.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2000);
    await agent.aiAssert(
      '主聊天区域（非右侧话题面板）没有新的顶层"🕐 定时任务「' + label + '」开始执行"消息作为独立话题出现；' +
        '即便有，它必须与最初创建任务的话题相同，而不是新开一个话题',
    );
  }, 480_000); // 8 min — many steps
});
