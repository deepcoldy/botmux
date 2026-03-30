/**
 * Group chat @mention routing tests:
 *
 * Multi-bot group ("普通群聊" has all bots):
 *  1. No @mention → no bot responds at all
 *  2. @mention a specific bot → only that bot responds
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
  sendMentionMessage,
  navigateToMessenger,
  openChat,
  getGroupChatName,
  scrollThreadToBottom,
  waitForStreamingCard,
  closeSession,
} from './helpers.js';

describe('feishu group @mention routing', () => {
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
  }, 180_000);

  afterAll(async () => {
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  }, 60_000);

  it('no @mention in multi-bot group → no bot responds', async () => {
    const msg = testMessage('no-mention');
    await sendMessage(agent, msg);

    // Wait 30 seconds — bots should NOT respond without @mention
    await page.waitForTimeout(30_000);

    // Scroll to bottom to see latest state
    await agent.aiScroll(undefined, { direction: 'down', scrollCount: 3 });
    await page.waitForTimeout(1000);

    // Verify: no bot created a thread/topic reply under this message.
    // In Feishu, when a bot replies in a thread, it shows "N 条话题回复"
    // counter. No counter = no bot replied.
    await agent.aiAssert(
      `消息"${msg}"附近没有显示"N 条话题回复"或"查看更早 N 条话题回复"这类回复计数。` +
        '注意："回复话题"输入框不算，那是所有消息都有的默认UI元素。',
    );
  }, 120_000);

  it('@mention a single bot → only that bot responds', async () => {
    // Ensure we're back at the bottom of the group chat with fresh state
    await agent.aiScroll(undefined, { direction: 'down', scrollCount: 5 });
    await page.waitForTimeout(2000);

    const msg = testMessage('mention-one');
    await sendMentionMessage(page, agent, 'Claude', msg);

    // Wait for Claude to reply — look for any bot response near our message
    await agent.aiWaitFor(
      `聊天中"${msg}"消息附近出现了来自机器人的回复`,
      { timeoutMs: 120_000, checkIntervalMs: 5_000 },
    );

    // Click into the thread to see all replies
    await agent.aiAct(
      `点击消息"${msg}"区域或附近的话题入口，打开话题详情`,
    );
    await agent.aiWaitFor('右侧出现了话题详情面板', {
      timeoutMs: 15_000,
      checkIntervalMs: 3_000,
    });

    // Scroll thread panel to see all content
    await scrollThreadToBottom(agent);
    await page.waitForTimeout(5000);

    // Handle repo selection if present — click "直接开启会话" button
    try {
      await page.locator('text=直接开启会话').first().click({ timeout: 5_000 });
      await page.waitForTimeout(3000);
    } catch {
      // Button not present or already clicked — continue
    }

    // Wait for Claude to finish processing
    await scrollThreadToBottom(agent);
    await agent.aiWaitFor(
      '话题面板中有来自 Claude 的回复内容（流式卡片或文本消息）',
      { timeoutMs: 120_000, checkIntervalMs: 5_000 },
    );

    // Wait extra time and verify ONLY Claude replied — no other bots
    await page.waitForTimeout(10_000);
    await scrollThreadToBottom(agent);
    await agent.aiAssert(
      '话题面板中只有 Claude 一个机器人的回复和卡片，' +
        '没有看到 CoCo、Codex、OpenCode 或 Aiden 的回复消息或卡片',
    );
  }, 300_000);
});
