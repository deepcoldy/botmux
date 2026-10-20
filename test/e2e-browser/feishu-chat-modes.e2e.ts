/**
 * Claude and Codex in every private-chat (DM) mode and regular-group mode.
 *
 * Every probe is a recall request (`followUpMessage`): the bot answers
 * `ACK-<own tag> RECALL <oldest ACK its session holds>`. That one line shows
 * both that the bot answered (the line exists only in its reply, so the DOM
 * check is exact) and which session answered:
 *   - a fresh session recalls the probe's own ACK;
 *   - a continued session recalls the first probe's ACK.
 *
 * DM modes are per bot, so a DM case holds the bot's DM lease exclusively; a
 * group case holds the test group exclusively (chat-lease.ts). Every case reads
 * the current mode first and restores it afterwards, so it also runs safely
 * against a live daemon.
 */
import { describe, it, beforeAll, afterAll } from './midscene-suite.js';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { existsSync } from 'node:fs';
import {
  createBrowser,
  createPage,
  createAgent,
  checkPrerequisites,
  STORAGE_STATE_PATH,
  expectedReplyMarker,
  expectedRecallMarker,
  followUpMessage,
  getGroupChatName,
  messageTag,
  navigateToMessenger,
  openChat,
  openGroupChat,
  openThreadForMessage,
  sendMentionMessage,
  sendMentionInOpenTopic,
  testMessage,
  typeChatMessage,
  typeThreadReply,
  waitForReplyLine,
  reopenTopic,
  expectNoReplyLine,
  clickDirectStartAfter,
  sendAndAwaitReply,
  scrollConversation,
} from './helpers.js';
import { publishLabeledPageVideo } from './e2e-video.js';
import { dmLeaseKey, holdLeaseForPage } from './chat-lease.js';
import {
  CHAT_MODE_BOTS,
  CHAT_MODE_SCENARIOS,
  parseChatModeScenario,
  type ChatModeBot,
  type GroupMentionMode,
  type GroupReplyMode,
} from './chat-mode-scenarios.js';

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  agent: PlaywrightAgent;
}

async function openBrowser(): Promise<BrowserSession> {
  checkPrerequisites();
  if (!existsSync(STORAGE_STATE_PATH)) {
    throw new Error('storageState.json not found. Run: bun run test:e2e-browser:setup');
  }
  const browser = await createBrowser();
  const { context, page } = await createPage(browser);
  const agent = createAgent(page);
  await navigateToMessenger(page);
  return { browser, context, page, agent };
}

async function releaseBrowser(session: Partial<BrowserSession>): Promise<void> {
  await session.agent?.destroy();
  // Closing the context closes the page, which releases its chat leases.
  await session.context?.close();
  try {
    await publishLabeledPageVideo(session.page);
  } catch (error) {
    console.error('Feishu video publish failed:', error);
  }
  await session.browser?.close();
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** A recall probe; its tag starts `e2e-<label>-`, so labels stay [a-z0-9-]. */
function probe(label: string): string {
  return followUpMessage(label);
}

/** The reply line for `p`, sent in a session whose first probe was `first`. */
function line(p: string, first: string = p): string {
  return expectedRecallMarker(p, first);
}

/**
 * Any reply to `p`, whichever session answered. The @-policy cases only ask
 * whether the bot spoke; `RECALL ACK-` never occurs in the prompt itself
 * (it holds a `<…>` placeholder there).
 */
function answered(p: string): string {
  return `${expectedReplyMarker(p)} RECALL ACK-`;
}

function slug(bot: ChatModeBot): string {
  return bot.toLowerCase();
}

function otherBot(bot: ChatModeBot): ChatModeBot {
  return CHAT_MODE_BOTS.find((name) => name !== bot)!;
}

// ---------------------------------------------------------------------------
// Command replies
// ---------------------------------------------------------------------------

/**
 * Close whatever session currently owns this chat so the next probe opens a
 * fresh one. Best effort: the closed card may patch the old streaming card
 * above the command instead of arriving below it.
 */
async function resetSession(page: Page, send: () => Promise<void>): Promise<void> {
  try {
    await sendAndAwaitReply(page, send, '/close', /会话已关闭|没有活跃的会话/, 20_000);
  } catch {
    console.warn('[chat-modes] /close produced no confirmation below it; continuing');
  }
}

/**
 * The mode each setting had before the first case touched it, per process.
 * A restore that fails once (CI: a garbled command) must not become the next
 * case's "original" — that is how one miss left Codex's DM in `chat` for the
 * rest of a run and broke every later Codex topic case.
 */
const baselines = new Map<string, string>();

async function baselineMode(key: string, read: () => Promise<string>): Promise<string> {
  const known = baselines.get(key);
  if (known) return known;
  const mode = await read();
  baselines.set(key, mode);
  return mode;
}

/** Restore with fresh navigation each try; other lanes depend on it. */
async function restoreWithRetry(label: string, restore: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await restore();
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[chat-modes] Restoring ${label} failed (attempt ${attempt}/3):`, error);
    }
  }
  throw lastError;
}

/** Run `run`, then `restore` even if `run` failed; a restore failure never hides `run`'s error. */
async function withRestore(run: () => Promise<void>, restore: () => Promise<void>): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  try {
    await restore();
  } catch (error) {
    if (failure === undefined) throw error;
    console.error('[chat-modes] Restoring the chat mode failed after a test failure:', error);
  }
  if (failure !== undefined) throw failure;
}

// ---------------------------------------------------------------------------
// Private-chat modes
// ---------------------------------------------------------------------------

async function setDmMode({ agent, page }: BrowserSession, label: string): Promise<void> {
  // `topic` is reported as `new-topic`; `/reply-mode new-topic` is accepted too.
  const shown = label === 'topic' ? 'new-topic' : label;
  const command = `/reply-mode ${label}`;
  await sendAndAwaitReply(
    page,
    () => typeChatMessage(agent, page, command),
    command,
    new RegExp(`已切换私聊会话模式为：${shown}`),
  );
}

async function withDmMode(
  session: BrowserSession,
  bot: ChatModeBot,
  mode: 'chat' | 'topic' | 'group',
  run: () => Promise<void>,
): Promise<void> {
  const { agent, page } = session;
  // Before openChat: no other lane may use this bot's DM while its mode differs.
  await holdLeaseForPage(page, dmLeaseKey(bot), 'exclusive');
  await openChat(page, agent, bot);
  const original = await baselineMode(`dm:${bot}`, async () => {
    const [, label] = await sendAndAwaitReply(
      page,
      () => typeChatMessage(agent, page, '/reply-mode'),
      '/reply-mode',
      /当前私聊会话模式：\s*([a-z-]+)/,
    );
    return label;
  });
  await setDmMode(session, mode);
  await withRestore(run, () =>
    restoreWithRetry(`${bot} DM mode ${original}`, async () => {
      await navigateToMessenger(page);
      await openChat(page, agent, bot);
      await setDmMode(session, original);
    }),
  );
}

/** chat: replies inline in the DM, and every DM message shares one session. */
async function dmChatMode(session: BrowserSession, bot: ChatModeBot): Promise<void> {
  const { agent, page } = session;
  await withDmMode(session, bot, 'chat', async () => {
    await resetSession(page, () => typeChatMessage(agent, page, '/close'));
    const p1 = probe(`dmchat-${slug(bot)}-1`);
    await typeChatMessage(agent, page, p1);
    await waitForReplyLine(page, line(p1), { agent });

    const p2 = probe(`dmchat-${slug(bot)}-2`);
    await typeChatMessage(agent, page, p2);
    await waitForReplyLine(page, line(p2, p1), { agent });

    await resetSession(page, () => typeChatMessage(agent, page, '/close'));
  });
}

/** thread: each top-level DM opens its own topic with its own session. */
async function dmThreadMode(session: BrowserSession, bot: ChatModeBot): Promise<void> {
  const { agent, page } = session;
  await withDmMode(session, bot, 'topic', async () => {
    const p1 = probe(`dmthread-${slug(bot)}-1`);
    const p2 = probe(`dmthread-${slug(bot)}-2`);
    await typeChatMessage(agent, page, p1);
    await typeChatMessage(agent, page, p2);
    // Both recall their own ACK: two topics, two independent sessions.
    for (const p of [p1, p2]) {
      await openThreadForMessage(agent, { msgHint: p, page, timeoutMs: 180_000 });
      await waitForReplyLine(page, line(p), { agent, reopen: reopenTopic(agent, page, p) });
      await typeThreadReply(agent, page, '/close');
    }
  });
}

/** group: a DM births a dedicated 1-user + 1-bot group that hosts the session. */
async function dmGroupMode(session: BrowserSession, bot: ChatModeBot): Promise<void> {
  const { agent, page } = session;
  await withDmMode(session, bot, 'group', async () => {
    // The group is named after the first 20 characters of the DM (run-e2e
    // turns AI renaming off); `e2e-sg-` + a 13-digit timestamp is exactly 20.
    const p1 = probe('sg');
    const groupName = messageTag(p1);
    await typeChatMessage(agent, page, p1);
    await openSessionGroup(session, groupName);
    await withRestore(
      async () => {
        await waitForReplyLine(page, line(p1), { agent });
        await agent.aiAssert(
          `当前打开的是群聊"${groupName}"；群里有一条说明"从私聊发起了本次会话"的消息，` +
            `并且机器人以普通消息回复了包含"${expectedReplyMarker(p1)}"的内容`,
        );
        // Solo group with a live session: no @ needed, same session continues.
        const p2 = probe(`sg2-${slug(bot)}`);
        await typeChatMessage(agent, page, p2);
        await waitForReplyLine(page, line(p2, p1), { agent });
      },
      () => dismissSessionGroup(session),
    );
  });
}

/**
 * Open the session group the DM just created. The bot quote-replies the DM
 * with a group card; a group created seconds ago is often not searchable yet,
 * so the card is tried before the chat list.
 */
async function openSessionGroup({ agent, page }: BrowserSession, groupName: string): Promise<void> {
  try {
    await agent.aiWaitFor(
      `私聊里机器人回复了一张群名片（群名为"${groupName}"或以它开头），或一条"已为本次会话创建专属群"的消息`,
      { timeoutMs: 90_000, checkIntervalMs: 5_000 },
    );
    await agent.aiAct(`点击机器人回复的那张群名片（群名为"${groupName}"或以它开头）或其中的群链接，进入该群聊`);
    await agent.aiWaitFor(`右侧聊天区域打开了群聊"${groupName}"（标题栏显示该群名）`, {
      timeoutMs: 20_000,
      checkIntervalMs: 3_000,
    });
    return;
  } catch (error) {
    console.warn(`[chat-modes] Session group card did not open the group: ${(error as Error).message}`);
  }
  await openGroupChat(page, agent, groupName, { lease: false, timeoutMs: 90_000 });
}

/** `/dismiss` asks for a one-time confirmation token; send it back. */
async function dismissSessionGroup({ agent, page }: BrowserSession): Promise<void> {
  try {
    const [, token] = await sendAndAwaitReply(
      page,
      () => typeChatMessage(agent, page, '/dismiss'),
      '/dismiss',
      /\/dismiss --confirm=([0-9a-f]{64})/,
    );
    await typeChatMessage(agent, page, `/dismiss --confirm=${token}`);
    await page.waitForTimeout(5_000);
  } catch (error) {
    console.warn('[chat-modes] Dismissing the session group failed; it is left behind:', error);
  }
}

// ---------------------------------------------------------------------------
// Regular-group modes
// ---------------------------------------------------------------------------

const GROUP_SETTINGS = {
  reply: { command: '/reply-mode', status: '当前群回复模式：', updated: '已切换当前群回复模式为：' },
  mention: { command: '/mention-mode', status: '当前群 @ 策略：', updated: '已切换当前群 @ 策略为：' },
} as const;

async function reopenGroup({ agent, page }: BrowserSession): Promise<void> {
  // Reload resets the 「话题」 filter that openThreadForMessage leaves selected.
  await navigateToMessenger(page);
  await openGroupChat(page, agent, getGroupChatName());
}

/** Set a per-group mode for `bot`, run, then put the previous mode back. */
async function withGroupSetting(
  session: BrowserSession,
  bot: ChatModeBot,
  kind: keyof typeof GROUP_SETTINGS,
  mode: string,
  run: () => Promise<void>,
): Promise<void> {
  const { agent, page } = session;
  const setting = GROUP_SETTINGS[kind];
  const set = (label: string) =>
    sendAndAwaitReply(
      page,
      () => sendMentionMessage(page, agent, bot, `${setting.command} ${label}`),
      `${setting.command} ${label}`,
      new RegExp(`${setting.updated}${label}`),
    );
  const original = await baselineMode(`${kind}:${bot}`, async () => {
    const [, label] = await sendAndAwaitReply(
      page,
      () => sendMentionMessage(page, agent, bot, setting.command),
      setting.command,
      new RegExp(`${setting.status}\\s*([a-z-]+)`),
    );
    return label;
  });
  await set(mode);
  await withRestore(run, () =>
    restoreWithRetry(`${bot} group ${kind} ${original}`, async () => {
      await reopenGroup(session);
      await set(original);
    }),
  );
}

function resetGroupSession(session: BrowserSession, bot: ChatModeBot): Promise<void> {
  return resetSession(session.page, () => sendMentionMessage(session.page, session.agent, bot, '/close'));
}

/**
 * Open the native topic (reply thread) of the top-level group message `p`.
 *
 * Hovering a message shows an icon toolbar: 👍 reaction, 💬 quote reply,
 * ↪ forward, the topic icon, ⋯ more. CI recordings showed the vision agent
 * hovering the wrong message (a bot card) and hitting ↪ (a Forward dialog) or
 * 💬 (a quote reply, which the daemon treats as top-level). So Playwright
 * hovers the probe itself, the click names the icon by position, a Forward
 * dialog is dismissed and retried, and the result must be a topic panel:
 * in `chat` mode a quote reply would reach the same session and pass silently.
 */
async function openNativeTopic({ agent, page }: BrowserSession, p: string): Promise<void> {
  const bubble = page.getByText(messageTag(p), { exact: false }).last();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await bubble.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await bubble.hover({ timeout: 10_000 });
    await page.waitForTimeout(800);
    await agent.aiAct(
      `鼠标正悬停在我发出的、正文以"${messageTag(p)}"开头的那条群消息上，它右上方浮出一排小图标：` +
        '点赞、对话气泡（引用回复）、箭头（转发）、方框卡片形状的话题图标、"⋯"。' +
        '点击第 4 个、即"转发"箭头与"⋯"之间的话题图标（悬停提示为"回复话题"或"话题回复"）。' +
        '只点这条消息的图标，不要点机器人卡片上的图标，不要点对话气泡或转发箭头。',
    );
    await page.waitForTimeout(1_000);
    if (await page.getByText('创建群组并转发').isVisible().catch(() => false)) {
      console.warn(`[chat-modes] Opening the topic of ${messageTag(p)} hit Forward (attempt ${attempt}); retrying`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      continue;
    }
    try {
      await agent.aiWaitFor(
        `页面上打开了正文以"${messageTag(p)}"开头那条消息的话题面板：面板标题为"话题"，` +
          '底部输入框的提示文字为"回复话题"；不是转发对话框，也不是群聊主输入框上方出现的引用回复条',
        { timeoutMs: 15_000, checkIntervalMs: 2_000 },
      );
      return;
    } catch {
      console.warn(`[chat-modes] No topic panel for ${messageTag(p)} (attempt ${attempt}); retrying`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    }
  }
  throw new Error(`Could not open the native topic of ${messageTag(p)} after 3 attempts`);
}

/**
 * A first @ in the group posts the 「项目仓库管理」 repo card in the main stream
 * (CI: "Waiting for repo selection"); nothing replies, and no reply topic
 * exists, until it is clicked. Topic-mode probes are checked from the 「话题」
 * list, so start the session here. In `new-topic` the card sits inside the
 * new topic instead, where waitForReplyLine clicks it.
 */
async function startSessionBelow(page: Page, p: string, waitMs = 30_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await clickDirectStartAfter(page, messageTag(p))) return;
    await scrollConversation(page);
    await page.waitForTimeout(3_000);
  }
}

async function groupReplyMode(
  session: BrowserSession,
  bot: ChatModeBot,
  mode: GroupReplyMode,
): Promise<void> {
  const { agent, page } = session;
  await openGroupChat(page, agent, getGroupChatName());
  await withGroupSetting(session, bot, 'reply', mode, async () => {
    await resetGroupSession(session, bot);
    const label = `gr-${mode}-${slug(bot)}`;
    const p1 = probe(`${label}-1`);
    const p2 = probe(`${label}-2`);

    if (mode === 'chat' || mode === 'chat-topic') {
      // Top level: inline replies, one continuous group session.
      await sendMentionMessage(page, agent, bot, p1);
      await waitForReplyLine(page, line(p1), { agent });
      await sendMentionMessage(page, agent, bot, p2);
      await waitForReplyLine(page, line(p2, p1), { agent });
      // A native topic: `chat` folds it into the group session, `chat-topic`
      // gives the topic a session of its own. It hangs off a fresh plain
      // message — p2 already carries the bot's quote replies (「2 条回复」),
      // and CI could not open a native topic on such a message. Without an
      // @ no bot answers the seed (every bot requires one at top level here).
      const seed = testMessage(`${label}-seed`, { plain: true });
      await typeChatMessage(agent, page, seed);
      const p3 = probe(`${label}-3`);
      await openNativeTopic(session, seed);
      await sendMentionInOpenTopic(page, agent, bot, p3);
      await waitForReplyLine(page, line(p3, mode === 'chat' ? p1 : p3), { agent });
      return;
    }

    // topic / new-topic: each @ gets a reply topic under it. `topic` shares
    // one session across those topics; `new-topic` starts a session per topic.
    // p2 goes out only after p1 is answered: a message that arrives while the
    // session still waits for repo selection is held and merged into the first
    // turn (「您的消息已暂存，选择后会自动发送」), so its reply lands in p1's topic.
    await sendMentionMessage(page, agent, bot, p1);
    await startSessionBelow(page, p1);
    await openThreadForMessage(agent, { msgHint: p1, page, timeoutMs: 180_000 });
    await waitForReplyLine(page, line(p1), { agent, reopen: reopenTopic(agent, page, p1) });
    await reopenGroup(session);
    await sendMentionMessage(page, agent, bot, p2);
    await startSessionBelow(page, p2);
    await openThreadForMessage(agent, { msgHint: p2, page, timeoutMs: 180_000 });
    await waitForReplyLine(page, line(p2, mode === 'topic' ? p1 : p2), {
      agent,
      reopen: reopenTopic(agent, page, p2),
    });
  });
  await resetGroupSession(session, bot);
}

async function groupMentionMode(
  session: BrowserSession,
  bot: ChatModeBot,
  mode: GroupMentionMode,
): Promise<void> {
  const { agent, page } = session;
  await openGroupChat(page, agent, getGroupChatName());
  await withGroupSetting(session, bot, 'mention', mode, async () => {
    await resetGroupSession(session, bot);
    const label = `gm-${mode}-${slug(bot)}`;
    const p1 = probe(`${label}-1`);

    switch (mode) {
      case 'always': {
        // Without an @ the bot stays quiet; with one it answers.
        await typeChatMessage(agent, page, p1);
        await expectNoReplyLine(page, answered(p1));
        const p2 = probe(`${label}-2`);
        await sendMentionMessage(page, agent, bot, p2);
        await waitForReplyLine(page, answered(p2), { agent });
        return;
      }
      case 'never': {
        await typeChatMessage(agent, page, p1);
        await waitForReplyLine(page, answered(p1), { agent });
        return;
      }
      case 'ambient': {
        // Answers without an @, but yields when the message @s someone else.
        await typeChatMessage(agent, page, p1);
        await waitForReplyLine(page, answered(p1), { agent });
        const other = otherBot(bot);
        const redirect = testMessage(`${label}-2`, { plain: true });
        await sendMentionMessage(page, agent, other, redirect);
        await page.waitForTimeout(45_000);
        await agent.aiAssert(
          `群聊里在包含"${redirect}"的那条（@了 ${other} 的）消息之后，没有 ${bot} 发出的任何回复消息或卡片；` +
            `${other} 的回复可以有`,
        );
        return;
      }
      case 'topic': {
        // Inside the bot's own topic a reply continues the session without an @.
        await withGroupSetting(session, bot, 'reply', 'new-topic', async () => {
          await sendMentionMessage(page, agent, bot, p1);
          await startSessionBelow(page, p1);
          await openThreadForMessage(agent, { msgHint: p1, page, timeoutMs: 180_000 });
          await waitForReplyLine(page, line(p1), { agent, reopen: reopenTopic(agent, page, p1) });
          const p2 = probe(`${label}-2`);
          await typeThreadReply(agent, page, p2);
          await waitForReplyLine(page, line(p2, p1), { agent, reopen: reopenTopic(agent, page, p1) });
        });
        return;
      }
    }
  });
  await resetGroupSession(session, bot);
}

// ---------------------------------------------------------------------------
// Registration: one suite and one case per scenario, both named after it.
// ---------------------------------------------------------------------------

export function registerMidsceneSuites(): void {
  for (const scenario of CHAT_MODE_SCENARIOS) {
    describe(scenario, () => {
      let session: Partial<BrowserSession> = {};

      beforeAll(async () => {
        session = await openBrowser();
      }, 120_000);

      afterAll(async () => {
        await releaseBrowser(session);
      });

      it(scenario, async () => {
        const live = session as BrowserSession;
        const parsed = parseChatModeScenario(scenario);
        if (parsed.kind === 'dm') {
          if (parsed.mode === 'chat') await dmChatMode(live, parsed.bot);
          else if (parsed.mode === 'thread') await dmThreadMode(live, parsed.bot);
          else await dmGroupMode(live, parsed.bot);
        } else if (parsed.kind === 'group-reply') {
          await groupReplyMode(live, parsed.bot, parsed.mode);
        } else {
          await groupMentionMode(live, parsed.bot, parsed.mode);
        }
      }, 25 * 60_000);
    });
  }
}
