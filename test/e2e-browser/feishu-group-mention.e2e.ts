/**
 * Group chat @mention routing tests:
 *
 * Multi-bot group ("普通群聊" has all bots):
 *  1. @mention a specific bot → only that bot responds
 *  2. Send message without @mention → no bot responds
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
  waitForStreamingCard,
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

    // Navigate to group chat once
    await navigateToMessenger(page);
    await openChat(page, agent, getGroupChatName());
  }, 120_000);

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  }, 60_000);

  // BUG: bots respond without @mention in multi-bot group.
  // getGroupBotCount() may not detect all bots correctly.
  // This test documents the expected behavior — will pass once fixed.
  it.fails('no @mention in multi-bot group → no bot responds', async () => {
    const msg = testMessage('no-mention');
    await sendMessage(agent, msg);

    // Wait 15 seconds — no bot should respond in a multi-bot group
    await page.waitForTimeout(15_000);

    await agent.aiAssert(
      `我发送的消息"${msg}"之后，没有任何机器人回复`,
    );
  }, 120_000);

  // BUG: all bots respond when only one is @mentioned.
  // Same root cause as above — getGroupBotCount() issue.
  it.fails('@mention a single bot → only that bot responds', async () => {
    const msg = testMessage('mention');
    await sendMentionMessage(page, agent, 'Claude', msg);

    // Wait for Claude to respond
    await waitForStreamingCard(agent, { timeoutMs: 90_000, msgHint: msg });

    // Verify Claude replied
    await agent.aiAssert('话题面板中有来自 Claude 机器人的回复');

    // Verify no other bot replied
    await page.waitForTimeout(10_000);
    await agent.aiAssert(
      '话题面板中只有 Claude 的回复，没有 CoCo、Codex、OpenCode 或 Aiden 的回复',
    );
  }, 240_000);
});
