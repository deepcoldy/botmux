/**
 * Group chat @mention routing tests:
 *
 * Multi-bot group scenario (Agent群聊 has all bots):
 *  1. @mention a specific bot → only that bot responds
 *  2. Send message without @mention → no bot responds
 *  3. @所有人 → all bots respond
 *
 * Per the event-dispatcher logic:
 *  - Multi-bot group requires @mention to trigger a bot
 *  - Without @mention, bots stay silent in multi-bot groups
 *  - @all or @所有人 triggers all bots
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
  });

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  /**
   * Helper: navigate to the multi-bot group chat.
   */
  async function goToGroupChat() {
    await navigateToMessenger(page);
    await openChat(agent, getGroupChatName());
  }

  it('@mention a single bot → only that bot responds', async () => {
    await goToGroupChat();

    const msg = testMessage('mention-single');
    await sendMentionMessage(page, agent, 'Claude', msg);

    // Wait for Claude to reply (handle repo selection if needed)
    await waitForStreamingCard(agent, { timeoutMs: 90_000 });

    // Verify Claude replied
    await agent.aiAssert(
      '聊天中有来自 Claude 机器人的回复',
    );

    // Wait a bit more to check no other bot replied
    await page.waitForTimeout(10_000);
    await agent.aiAssert(
      `最近的消息中，只有 Claude 对消息"${msg}"做出了回复，` +
        '没有看到 CoCo、Codex、OpenCode 或 Aiden 的回复',
    );
  }, 180_000);

  it('no @mention in multi-bot group → no bot responds', async () => {
    await goToGroupChat();

    const msg = testMessage('no-mention');
    await sendMessage(agent, msg);

    // Wait 20 seconds — no bot should respond
    await page.waitForTimeout(20_000);

    await agent.aiAssert(
      `我发送的消息"${msg}"之后，没有任何机器人回复`,
    );
  }, 60_000);
});
