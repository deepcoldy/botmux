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
  messageTag,
  expectedReplyMarker,
  sendMessage,
  sendMentionMessage,
  navigateToMessenger,
  openChat,
  getGroupChatName,
  openThreadForMessage,
  scrollThreadToBottom,
  waitForModelTextReply,
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
  });

  afterAll(async () => {
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('no @mention in multi-bot group → no bot responds', async () => {
    // Plain tag only — we're testing that NO bot replies, so we MUST NOT
    // instruct the bot to reply. Default testMessage() would ask for a reply.
    const msg = testMessage('no-mention', { plain: true });
    await sendMessage(agent, msg);

    // Wait 30 seconds — bots should NOT respond without @mention
    await page.waitForTimeout(30_000);

    // Scroll to bottom to see latest state
    await agent.aiScroll(undefined, { direction: 'down', scrollType: 'untilBottom' });
    await page.waitForTimeout(1000);

    // Verify: no bot created a thread/topic reply under this message.
    // In Feishu, when a bot replies in a thread, it shows "N 条话题回复"
    // counter. No counter = no bot replied.
    await agent.aiAssert(
      `消息"${messageTag(msg)}"附近没有显示"N 条话题回复"或"查看更早 N 条话题回复"这类回复计数。` +
        '注意："回复话题"输入框不算，那是所有消息都有的默认UI元素。',
    );
  }, 90_000);

  it('@mention a single bot → only that bot responds', async () => {
    // Ensure we're back at the bottom of the group chat with fresh state
    await agent.aiScroll(undefined, { direction: 'down', scrollType: 'untilBottom' });
    await page.waitForTimeout(2000);

    const msg = testMessage('mention-one');
    await sendMentionMessage(page, agent, 'Claude', msg);

    // 走「话题」tab 打开宽版话题视图，同时顺手点掉 repo 选择卡。
    await openThreadForMessage(agent, { msgHint: msg, timeoutMs: 180_000, page });
    try {
      await page.locator('text=直接开启会话').first().click({ timeout: 5_000 });
      await page.waitForTimeout(3000);
    } catch { /* not present, fine */ }

    // 必须等到 Claude 真的写出 ACK marker（模型自然文本回复，流式卡片不算数），
    // 才能进一步断言"只有 Claude 一个 bot 参与"。否则可能别的 bot 还在路上。
    await scrollThreadToBottom(agent);
    await waitForModelTextReply(agent, {
      botName: 'Claude',
      marker: expectedReplyMarker(msg),
      timeoutMs: 180_000,
    });

    // Wait extra time and verify ONLY Claude replied — no other bots
    await page.waitForTimeout(10_000);
    await scrollThreadToBottom(agent);
    await agent.aiAssert(
      '主内容区正在显示的测试话题里只有 Claude 一个机器人的回复和卡片，' +
        '没有看到 CoCo、Codex、OpenCode 或 Aiden 的回复消息或卡片',
    );
  }, 420_000);
});
