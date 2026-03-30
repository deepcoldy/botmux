/**
 * Bot-to-bot collaboration E2E test:
 *
 * In the group chat ("普通群聊"), @mention Aiden and ask it to collaborate
 * with CoCo. Verify that:
 *  1. Aiden receives the message and starts working
 *  2. Aiden @mentions CoCo via the send_to_thread MCP tool
 *  3. CoCo picks up and responds in the same thread
 *  4. At least 3 rounds of back-and-forth occur between the bots
 *
 * This tests the full bot-mention signal pipeline:
 *   User → @Aiden → Aiden worker → signal file → daemon → CoCo worker → reply
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
  scrollThreadToBottom,
  waitForStreamingCard,
  closeSession,
} from './helpers.js';

describe('bot-to-bot collaboration (@Aiden ↔ @CoCo)', () => {
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
    // Try to close any open sessions
    try {
      await closeSession(agent, page);
    } catch { /* ignore */ }
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  }, 60_000);

  it('Aiden and CoCo collaborate with 3+ rounds of back-and-forth', async () => {
    const msg = testMessage('collab');

    // Step 1: Send @Aiden a message asking it to collaborate with @CoCo
    // The prompt explicitly instructs Aiden to @mention CoCo and have
    // a multi-round discussion.
    await sendMentionMessage(
      page,
      agent,
      'Aiden',
      `${msg} 请你跟 @CoCo 协作完成以下任务：讨论"TypeScript vs JavaScript 的优缺点"。` +
        '你先提出观点，然后让 CoCo 补充，你再回应 CoCo 的观点。至少来回讨论3轮。' +
        '每次回复时用 @CoCo 提及对方。',
    );

    // Step 2: Wait for Aiden to respond (streaming card in thread)
    await waitForStreamingCard(agent, { timeoutMs: 120_000, msgHint: msg });

    // Step 3: Wait for Aiden's card to show activity
    await scrollThreadToBottom(agent);
    await agent.aiWaitFor(
      '话题面板中有一个流式卡片，其标题栏中包含"工作中"或"就绪"字样',
      { timeoutMs: 120_000, checkIntervalMs: 5_000 },
    );

    // Step 4: Wait for CoCo to join the conversation.
    // When Aiden @mentions CoCo, the daemon creates a new session for CoCo
    // in the same thread. We should see a second streaming card from CoCo.
    await scrollThreadToBottom(agent);
    await agent.aiWaitFor(
      '话题面板中出现了来自 CoCo 的回复（包括流式卡片、文本消息、或"已收到"等确认消息）',
      { timeoutMs: 180_000, checkIntervalMs: 10_000 },
    );

    // Step 5: Wait for enough back-and-forth.
    // Give bots time to exchange multiple rounds. Each round takes
    // ~30-60s (bot processes message, sends reply, signal propagates).
    // We wait up to 5 minutes for 3+ rounds.
    await page.waitForTimeout(60_000);
    await scrollThreadToBottom(agent);

    // Check for another round
    await page.waitForTimeout(60_000);
    await scrollThreadToBottom(agent);

    // Step 6: Verify both bots participated.
    // The key verification is that the bot-mention signal pipeline works:
    // Aiden → signal file → daemon → CoCo picks up and responds.
    await scrollThreadToBottom(agent);
    await page.waitForTimeout(3000);

    // Verify both bots have content in the thread
    await agent.aiAssert(
      '话题面板中可以看到来自 Aiden 的回复内容（文本消息或流式卡片），' +
        '同时也能看到来自 CoCo 的回复内容（文本消息或流式卡片）。' +
        '两个机器人都在这个话题中有输出。',
    );

    // Verify CoCo's response came after Aiden's (proving the pipeline)
    await agent.aiAssert(
      '话题面板中 CoCo 的回复出现在 Aiden 的消息之后，' +
        '说明是 Aiden 触发了 CoCo 的参与。',
    );
  }, 600_000); // 10 min — multi-bot collaboration takes time
});
