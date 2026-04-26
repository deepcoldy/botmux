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
  waitForModelTextReply,
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
  });

  afterAll(async () => {
    // Try to close any open sessions
    try {
      await closeSession(agent, page);
    } catch { /* ignore */ }
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('Aiden and CoCo collaborate with 3+ rounds of back-and-forth', async () => {
    // Plain tag — the collab prompt supplies its own bot instructions below.
    const msg = testMessage('collab', { plain: true });

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
    await waitForStreamingCard(agent, { timeoutMs: 120_000, msgHint: msg, page });

    // Step 3: Wait for Aiden's card to show activity
    await scrollThreadToBottom(agent);
    await agent.aiWaitFor(
      '右侧话题详情面板中有一个来自 Aiden 的流式卡片，其标题栏包含"工作中"或"等待输入"字样',
      { timeoutMs: 120_000, checkIntervalMs: 5_000 },
    );

    // Step 4: Wait for both bots to actually produce model-generated text replies.
    // 只看到卡片或"已收到"确认并不能证明模型真的回话了——必须分别等到 Aiden 和 CoCo
    // 的文本气泡里出现完整句子。
    await scrollThreadToBottom(agent);
    await waitForModelTextReply(agent, {
      botName: 'Aiden',
      timeoutMs: 240_000,
    });

    await scrollThreadToBottom(agent);
    await waitForModelTextReply(agent, {
      botName: 'CoCo',
      timeoutMs: 240_000,
    });

    // Step 5: Give bots time for another round, then scroll and verify.
    await page.waitForTimeout(60_000);
    await scrollThreadToBottom(agent);
    await page.waitForTimeout(3000);

    // Step 6: 结构性校验——两个机器人都真写出了内容，且 CoCo 出现在 Aiden 之后。
    await agent.aiAssert(
      '话题面板中可以看到至少一条来自 Aiden 的普通文本回复（完整的自然语言句子，不是流式卡片或"已收到"之类的系统提示），' +
        '同时也能看到至少一条来自 CoCo 的普通文本回复（完整的自然语言句子，不是流式卡片或"已收到"之类的系统提示）。',
    );
    await agent.aiAssert(
      '话题面板中 CoCo 的首条文本回复出现在 Aiden 的首条文本回复之后，说明是 Aiden 触发了 CoCo 的参与。',
    );
  }, 900_000); // 15 min — multi-bot collaboration + two model waits
});
