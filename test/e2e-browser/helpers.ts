import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import { E2E_VIDEO_DIR, e2eVideoRecordingEnabled } from './e2e-video.js';
import { RECALL_FIRST_MARKER_TOKEN } from '../helpers/mock-llm-server/marker-extractor.js';
import { chatLeaseKey, dmLeaseKey, holdLeaseForPage } from './chat-lease.js';
import { attachAgentToReportScope } from './report-scope.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

export const STORAGE_STATE_PATH = path.join(PROJECT_ROOT, 'storageState.json');

export const BROWSER_CONFIG = {
  viewport: { width: 1920, height: 1080 } as const,
  deviceScaleFactor: 1,
  locale: 'zh-CN',
};

/**
 * The test bots, named after their CLI. Claude, Codex and the public CLIs of
 * the core-clis lane run on CI against the mock LLM; ClaudeSandbox is Claude
 * Code with `sandbox: true` (core-sandbox lane); Aiden and CoCo are internal
 * CLIs that only run where they are installed.
 */
export const BOT_NAMES = ['Claude', 'CoCo', 'Codex', 'OpenCode', 'Aiden', 'Pi', 'OhMyPi', 'Kimi', 'Antigravity', 'Grok', 'ClaudeSandbox'] as const;
export type BotName = (typeof BOT_NAMES)[number];

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

/** `BOTMUX_MOCK_LLM=1`: CLIs talk to the synthetic model in test/helpers/mock-llm-server. */
export function mockLlmEnabled(): boolean {
  return process.env.BOTMUX_MOCK_LLM === '1' || process.env.BOTMUX_MOCK_LLM === 'true';
}

export function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required env var: ${key}. Copy .env.example to .env and fill in values.`,
    );
  }
  return value;
}

/** Derive messenger base URL from FEISHU_TEST_GROUP_URL. */
export function getMessengerUrl(): string {
  const groupUrl = getRequiredEnv('FEISHU_TEST_GROUP_URL');
  const url = new URL(groupUrl);
  return `${url.origin}/next/messenger`;
}

/** Regular group chat name (普通群). */
export function getGroupChatName(): string {
  return process.env.FEISHU_TEST_GROUP_CHAT_NAME ?? '普通群聊';
}

/** Topic group chat name (话题群). */
export function getTopicGroupChatName(): string {
  return process.env.FEISHU_TEST_TOPIC_GROUP_NAME ?? '话题群聊';
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

function isFontInstalled(fontPattern: string): boolean {
  try {
    const result = execSync(`fc-list | grep -i "${fontPattern}"`, {
      encoding: 'utf-8',
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

export function checkPrerequisites(): void {
  const requiredVars = [
    'FEISHU_TEST_GROUP_URL',
    'MIDSCENE_MODEL_NAME',
    'MIDSCENE_MODEL_API_KEY',
  ];
  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing env vars: ${missing.join(', ')}\n` +
      'Copy .env.example to .env and fill in your values.',
    );
  }

  const fontChecks = [
    { pattern: 'noto.*emoji', name: 'fonts-noto-color-emoji', purpose: 'emoji' },
    { pattern: 'noto.*cjk', name: 'fonts-noto-cjk', purpose: 'CJK' },
  ];
  const missingFonts = fontChecks.filter((f) => !isFontInstalled(f.pattern));
  if (missingFonts.length > 0) {
    const installCmd = missingFonts.map((f) => f.name).join(' ');
    console.warn(
      `Warning: missing fonts (${missingFonts.map((f) => f.purpose).join(', ')}):\n` +
      `  apt install ${installCmd}\n` +
      'Tests will run but emoji/CJK may render as squares.',
    );
  }
}

// ---------------------------------------------------------------------------
// Browser / page / agent creation
// ---------------------------------------------------------------------------

export async function createBrowser(headless = true): Promise<Browser> {
  return chromium.launch({ headless });
}

export async function createPage(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const contextOpts: BrowserContextOptions = {
    viewport: BROWSER_CONFIG.viewport,
    deviceScaleFactor: BROWSER_CONFIG.deviceScaleFactor,
    locale: BROWSER_CONFIG.locale,
  };
  if (existsSync(STORAGE_STATE_PATH)) {
    contextOpts.storageState = STORAGE_STATE_PATH;
  }
  // Continuous WebM of this context. Enabled only for Midscene runs
  // (`BOTMUX_E2E_RECORD_VIDEO=1`); the file is saved when the context closes.
  if (e2eVideoRecordingEnabled()) {
    await mkdir(E2E_VIDEO_DIR, { recursive: true });
    // Half resolution: a full-HD recording ran 40–60 MB per case. Midscene
    // screenshots still come from the full-size page.
    contextOpts.recordVideo = {
      dir: E2E_VIDEO_DIR,
      size: {
        width: BROWSER_CONFIG.viewport.width / 2,
        height: BROWSER_CONFIG.viewport.height / 2,
      },
    };
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  return { context, page };
}

export function createAgent(page: Page): PlaywrightAgent {
  const agent = new PlaywrightAgent(page);
  attachAgentToReportScope(agent);
  return agent;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

// Concurrent lanes log in the same account. Several Messenger pages booting
// at once leave the chat list on skeleton placeholders for minutes (seen in
// CI), so pages load one at a time; a loaded page then works normally.
let messengerLoadQueue: Promise<void> = Promise.resolve();

function messengerShellReady({ requireChatList, names }: { requireChatList: boolean; names: string[] }): boolean {
  const title = document.title;
  const titleReady = /messenger|飞书|lark/i.test(title);
  const body = document.body?.innerText ?? '';
  const searchReady = /search|搜索/i.test(body);
  const messengerReady = /messenger|消息/i.test(body);
  // The shell renders before the chat list; skeleton rows carry no text, so
  // require a real chat entry (every test account has the bot DMs).
  const chatListReady = !requireChatList || names.some((name) => body.includes(name));
  return titleReady && searchReady && messengerReady && chatListReady;
}

/** Navigate to the messenger page and wait until its chat list has loaded. */
export async function navigateToMessenger(page: Page, url = getMessengerUrl()): Promise<void> {
  const load = messengerLoadQueue.then(() => loadMessenger(page, url));
  messengerLoadQueue = load.catch(() => {});
  await load;
}

// While four lanes boot Chromium at once, CI recordings showed a Messenger
// page going blank → skeleton → loaded over 60–80s: three 45s waits, each
// restarted by a reload, failed cases whose own checks had passed.
const MESSENGER_LOAD_ATTEMPTS = 4;
const MESSENGER_LOAD_WAIT_MS = 60_000;

async function loadMessenger(page: Page, url: string): Promise<void> {
  // The saved account can render either the English ("Messenger - Feishu",
  // "Search"/"Messenger") or Chinese ("消息 - 飞书", "搜索"/"消息") UI, so do
  // not gate on a single language.
  for (let attempt = 1; attempt <= MESSENGER_LOAD_ATTEMPTS; attempt++) {
    // A fresh navigation each time: a reload keeps a stalled app's state.
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((error: Error) => {
      console.warn(`[e2e] Opening Feishu Messenger failed: ${error.message.split('\n')[0]}`);
    });
    try {
      // A deep link (the test group) may open a view without the chat list.
      await page.waitForFunction(
        messengerShellReady,
        { requireChatList: url === getMessengerUrl(), names: BOT_NAMES.flatMap(botDisplayNames) },
        { timeout: MESSENGER_LOAD_WAIT_MS },
      );
      return;
    } catch {
      console.warn(`[e2e] Feishu Messenger chat list not loaded (attempt ${attempt}/${MESSENGER_LOAD_ATTEMPTS}); reopening`);
    }
  }
  throw new Error(
    `Feishu Messenger chat list did not load after ${MESSENGER_LOAD_ATTEMPTS} attempts (URL: ${page.url()}, title: ${await page.title()}). ` +
      'A login redirect means the saved storage state expired; a skeleton list means Feishu web is stalling.',
  );
}

/**
 * Open a specific chat by clicking its entry in the left sidebar.
 * Works for both bot private chats ("Claude") and group chats.
 * Falls back to Feishu search (Ctrl+K) if not visible in sidebar.
 */
/**
 * Display names the bot's Feishu app may have, preferred first.
 *
 * The test bots are named after their CLI (`Claude`, `Codex`, …). They used to
 * be `[Botmux]<Name>`, and either may be live while the apps are renamed, so
 * both are accepted. Names compare exactly and case-sensitively: the test
 * tenant also holds unrelated apps such as `codex` and `Nash_Claude` that
 * never answer botmux traffic. The badge does not tell them apart: apps that
 * `botmux setup` creates from the agent template show 智能体, older ones 机器人.
 */
export function botDisplayNames(botName: string): string[] {
  const bare = botName.replace(/^\[Botmux\]/, '');
  return [bare, `[Botmux]${bare}`];
}

/** How the bot is described to the vision agent: either name counts. */
function botNameForVision(botName: string): string {
  const [bare, legacy] = botDisplayNames(botName);
  return `"${bare}" 或 "${legacy}"（两个名字任意一个都算，飞书上可能还是旧名）`;
}

/** A text box of TITLE_BOXES: `onTop` when hit-testing its middle lands on it. */
export interface TitleBox extends ScreenBox {
  onTop: boolean;
}

/**
 * The chat list's entry titled exactly with the bot's name: on top, left of 30%
 * of the width (the main area shows the name too, as its title and as the
 * bot's sender line). Text scrolled out of the list is not on top. A pinned
 * shortcut ahead of the list, if it holds the full name, opens the same chat.
 */
export function pickChatEntry(boxes: readonly TitleBox[], viewport: { width: number; height: number }): TitleBox | null {
  return boxes.find((box) => box.onTop && box.x < viewport.width * 0.3) ?? null;
}

/**
 * The main area's title bar names the chat: the name on top in the top 5%
 * right of the list (CI at 1920×1080: title at y ≈ 30, the bar ends at
 * y ≈ 72). A chat the bot posts in shows it as a sender line below the bar
 * (「普通群聊」, run 40280910196), or scrolled under it, where it is not on
 * top; an open topic's title bar reads 「话题」.
 */
export function chatOpenInMain(boxes: readonly TitleBox[], viewport: { width: number; height: number }): boolean {
  return boxes.some((box) => box.onTop && box.x >= viewport.width * 0.3 && box.y < viewport.height * 0.05);
}

/**
 * Click the bot DM's chat-list entry and confirm its title bar; false when
 * the entry is not listed or the click did not open it. CI: the vision agent
 * opened 「普通群聊」 or a restored topic instead (runs 40170880120,
 * 40217853930, 40280910196), failing a suite's setup.
 */
async function openChatFromList(page: Page, chatName: string): Promise<boolean> {
  const viewport = page.viewportSize() ?? BROWSER_CONFIG.viewport;
  const boxes = async () =>
    ((await page.evaluate(`(${TITLE_BOXES})(${JSON.stringify(chatName)})`).catch(() => [])) ?? []) as TitleBox[];
  const entry = pickChatEntry(await boxes(), viewport);
  if (!entry) return false;
  await page.mouse.click(entry.x + entry.width / 2, entry.y + entry.height / 2);
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(1_000);
    if (chatOpenInMain(await boxes(), viewport)) return true;
  }
  return false;
}

export async function openChat(
  page: Page,
  agent: PlaywrightAgent,
  botName: string,
): Promise<void> {
  // Concurrent lanes share this bot's DM; a case that switches its DM mode
  // holds the lease exclusively (see chat-lease.ts).
  await holdLeaseForPage(page, dmLeaseKey(botName.replace(/^\[Botmux\]/, '')), 'shared');
  // Match the bot conversation by its exact name, never a similarly named
  // native AI agent (智能体 badge) or another app (see botDisplayNames).
  const names = botDisplayNames(botName);
  for (const chatName of names) {
    if (await openChatFromList(page, chatName)) return;
  }
  const described = botNameForVision(botName);
  let opened = false;
  // The entry is not listed (or did not open): ask the vision agent.
  try {
    await agent.aiAct(
      `在左侧"消息"列表或其置顶会话中，点击私聊会话 ${described}` +
        '（名称大小写完全一致；徽标可能是"机器人"也可能是"智能体"，两者都可以）。' +
        '不要点名称相近的其它会话（例如大小写不同、多了前后缀），也不要点话题里的消息或群聊。',
    );
    await agent.aiWaitFor(
      `右侧聊天区域顶部标题栏的会话名是 ${described}，大小写完全一致`,
      { timeoutMs: 8_000, checkIntervalMs: 2_000 },
    );
    opened = true;
  } catch {
    opened = false;
  }

  if (!opened) {
    // Chat not visible or direct click failed — use search to find it
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(1000);
    await page.keyboard.type(names[0]);
    await page.waitForTimeout(2000);
    await agent.aiAct(
      `在搜索结果中点击会话 ${described}（名称大小写完全一致，徽标是"机器人"或"智能体"都可以），` +
        '不要点名称相近（大小写不同、多了前后缀）的其它会话。',
    );
    // Close search overlay if still open
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    // Wait for chat to load
    await agent.aiWaitFor(
      `右侧聊天区域顶部标题栏的会话名是 ${described}，大小写完全一致`,
      { timeoutMs: 15_000, checkIntervalMs: 3_000 },
    );
  }
}

/**
 * Open a group chat by its exact name. Holds the group exclusively for the
 * case: group modes are per group and no-reply assertions need a quiet group.
 * Pass `lease: false` for a group only this case knows (a fresh session group).
 */
export async function openGroupChat(
  page: Page,
  agent: PlaywrightAgent,
  groupName: string,
  opts?: { lease?: boolean; timeoutMs?: number },
): Promise<void> {
  if (opts?.lease !== false) await holdLeaseForPage(page, chatLeaseKey(groupName), 'exclusive');
  if (groupName === getGroupChatName()) {
    // Name search does not find groups reliably (CI: 暂无相关结果), and the
    // group's direct link never loaded the chat list in CI — three reloads,
    // over two minutes per case before any fallback. The test account pins
    // the group (shortcut 「普通群聊」) above the chat list; click its label.
    if (!(await page.getByText(groupName, { exact: true }).count()) && !(await page.getByText('普通群聊', { exact: true }).count())) {
      await navigateToMessenger(page);
    }
    const opened = '右侧聊天区域打开了一个普通群聊（标题栏显示群名和成员数，不是与机器人的私聊，不是话题群，也不是空白的欢迎页）';
    for (const label of [...new Set([groupName, '普通群聊'])]) {
      const entry = page.getByText(label, { exact: true }).first();
      try {
        if ((await entry.count()) === 0) continue;
        await entry.click({ timeout: 5_000 });
        await agent.aiWaitFor(opened, { timeoutMs: 15_000, checkIntervalMs: 3_000 });
        return;
      } catch {
        // Try the next label, then the vision fallback.
      }
    }
    await agent.aiAct(
      `在左侧"消息"列表（包括顶部置顶的头像快捷入口）中点击名为"${groupName}"的群聊；` +
        '如果没有，点击顶部置顶快捷入口里名为"普通群聊"的群聊（不是"话题群聊"，也不是机器人私聊）。',
    );
    await agent.aiWaitFor(opened, { timeoutMs: opts?.timeoutMs ?? 30_000, checkIntervalMs: 3_000 });
    return;
  }
  const opened = `右侧聊天区域顶部标题栏显示群聊名称"${groupName}"`;
  try {
    await agent.aiAct(
      `在左侧"消息"列表中点击名称为"${groupName}"的群聊（不是机器人私聊，也不是话题）。`,
    );
    await agent.aiWaitFor(opened, { timeoutMs: 8_000, checkIntervalMs: 2_000 });
    return;
  } catch {
    // Not in the visible list (e.g. a group created moments ago): search.
  }
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(1_000);
  await page.keyboard.type(groupName);
  await page.waitForTimeout(2_500);
  await agent.aiAct(`在搜索结果的"群组"部分点击名称为"${groupName}"的群聊`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await agent.aiWaitFor(opened, {
    timeoutMs: opts?.timeoutMs ?? 20_000,
    checkIntervalMs: 3_000,
  });
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/**
 * Send a plain text message in the currently open chat. Typed with real key
 * presses: the vision agent's typing dropped the leading character in CI
 * (`e2e-…` arrived as `2e-…`), which hides the tag the topic is found by.
 */
export async function sendMessage(
  agent: PlaywrightAgent,
  message: string,
  page: Page,
): Promise<void> {
  await typeChatMessage(agent, page, message);
}

/**
 * Send a message with @mention in a group chat.
 * Types "@", selects the bot from the dropdown, then types the rest.
 */
export async function sendMentionMessage(
  page: Page,
  agent: PlaywrightAgent,
  botName: string,
  message: string,
): Promise<void> {
  const focus = () => focusOrAsk(page, agent, 'chat', '点击底部的消息输入框');
  await focus();
  await page.waitForTimeout(500);
  await warmUpInput(page);
  await typeMention(page, botName, message, focus);
}

/** Text of the rich-text input that currently has focus. */
/**
 * In-page expression for the message editor: the focused rich-text input,
 * else the one holding the caret. A string on purpose — CI loads this file
 * through tsx (esbuild keepNames), which wraps functions declared inside an
 * evaluate callback in `__name(...)`, a helper the page does not have
 * ("ReferenceError: __name is not defined" failed every case once).
 */
const FIND_EDITOR = `(() => {
  for (const node of [document.activeElement, document.getSelection()?.anchorNode]) {
    const element = node instanceof HTMLElement ? node : node?.parentElement;
    const editor = element?.closest('[contenteditable="true"]');
    if (editor) return editor;
  }
  return null;
})()`;

/**
 * Text of the message editor being typed into: the focused rich-text input,
 * else the one holding the caret. Never the page body — CI once compared the
 * whole page's text against a mention because focus had left the editor.
 */
async function focusedInputText(page: Page): Promise<string> {
  return page.evaluate(`(${FIND_EDITOR}?.innerText ?? '')`);
}

export interface ScreenBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the page shows of Feishu's @ member list (see MENTION_LIST). */
export interface MentionListSnapshot {
  editor: ScreenBox;
  /** Visible, uncovered elements led by the bot's display name. */
  options: Array<ScreenBox & { fresh: boolean }>;
  /** 「会话内成员」 section headers. */
  inChat: ScreenBox[];
  /** 「会话外的人（他们不会收到这条消息）」 section headers. */
  outside: ScreenBox[];
}

/**
 * In-page: every element led by `name` that is on top at its own position,
 * and the list's section headers. With `before`, only marks the
 * matches already on the page, so a list that has no headers can still be told
 * apart from the chat's sender labels: its rows are the fresh ones. A string
 * for the same reason as FIND_EDITOR.
 */
const MENTION_LIST = `(({ names, mark, before }) => {
  const editor = ${FIND_EDITOR};
  if (!editor) return null;
  const clean = (text) => (text || '').replace(/[\\u200b-\\u200d\\u2060\\ufeff]/g, '').replace(/\\s+/g, ' ').trim();
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };
  const onTop = (el, r) => {
    if (r.width <= 0 || r.height <= 0) return false;
    const hit = document.elementFromPoint(r.x + Math.min(r.width / 2, 24), r.y + r.height / 2);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  const find = (accept, probes) => {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const data = walker.currentNode.data;
      if (!probes.some((probe) => data.includes(probe))) continue;
      let el = walker.currentNode.parentElement;
      for (let depth = 0; el && depth < 4; depth += 1, el = el.parentElement) {
        const text = clean(el.textContent);
        if (accept(text)) {
          if (!found.includes(el) && !editor.contains(el)) found.push(el);
          break;
        }
        if (text.length > 80) break;
      }
    }
    return found;
  };
  // A row may hold the badge too (「Claude 机器人 | Claude」), or split the
  // name around the highlighted query; the name must still lead it.
  const leads = (text, name) => text === name || (text.startsWith(name) && !/^[\w-]/.test(text.slice(name.length)));
  const isName = (text) => names.some((name) => leads(text, name));
  const options = find(isName, names);
  if (before) {
    // Per attempt: a node the list reuses across attempts must count as new.
    for (const el of document.querySelectorAll('[' + mark + ']')) el.removeAttribute(mark);
    for (const el of options) el.setAttribute(mark, '');
    return null;
  }
  const shown = (els) => els.map((el) => [el, rect(el)]).filter(([el, r]) => onTop(el, r));
  return {
    editor: rect(editor),
    options: shown(options).map(([el, r]) => ({ ...r, fresh: !el.hasAttribute(mark) })),
    inChat: shown(find((text) => text === '会话内成员', ['会话内成员'])).map(([, r]) => r),
    outside: shown(find((text) => text.startsWith('会话外的人'), ['会话外的人'])).map(([, r]) => r),
  };
})`;

const MENTION_MARK = 'data-e2e-before-mention';

async function mentionList(page: Page, name: string, before = false): Promise<MentionListSnapshot | null> {
  const args = { names: botDisplayNames(name), mark: MENTION_MARK, before };
  return page.evaluate(`(${MENTION_LIST})(${JSON.stringify(args)})`);
}

/** Feishu opens the member list right above the editor, about as wide. */
function aboveEditor(box: ScreenBox, editor: ScreenBox): boolean {
  return (
    box.y + box.height <= editor.y + 8 &&
    box.y >= editor.y - 520 &&
    box.x + box.width > editor.x &&
    box.x < editor.x + editor.width
  );
}

/**
 * The member-list row to click for the bot: the first one under 「会话内成员」.
 * 「会话外的人」 lists a same-named bot from another app ("they will not receive
 * this message"), and the chat behind the list shows the same name on every
 * reply, so a bare name match is not enough. Without section headers the list's
 * rows are the matches that appeared after typing `@`.
 */
export function pickMentionOption(list: MentionListSnapshot): ScreenBox | null {
  const options = list.options.filter((box) => aboveEditor(box, list.editor));
  const inChat = list.inChat.filter((box) => aboveEditor(box, list.editor)).sort((a, b) => a.y - b.y)[0];
  let rows: ScreenBox[];
  if (inChat) {
    const outside = list.outside
      .filter((box) => aboveEditor(box, list.editor) && box.y > inChat.y)
      .sort((a, b) => a.y - b.y)[0];
    rows = options.filter(
      (box) => box.y >= inChat.y + inChat.height - 2 && (!outside || box.y + box.height <= outside.y + 2),
    );
  } else {
    rows = options.filter((box) => box.fresh);
  }
  return rows.sort((a, b) => a.y - b.y)[0] ?? null;
}

const MENTION_LIST_WAIT_MS = 20_000;
/** How long the bot's row must stay put before it is clicked. */
const MENTION_ROW_STILL_MS = 1_200;

/**
 * Wait for the member list to offer the bot, then return its row once it has
 * stopped moving. CI recordings: the list sits on a single skeleton row for
 * up to ~10s while four lanes load the runner, and its sections render one
 * after another — a click while 「会话外的人」 was still loading closed the
 * list without inserting the mention, so the row must hold still a while.
 */
async function waitForMentionOption(page: Page, name: string): Promise<ScreenBox | null> {
  const deadline = Date.now() + MENTION_LIST_WAIT_MS;
  let last: ScreenBox | null = null;
  let stillSince = 0;
  while (Date.now() < deadline) {
    const list = await mentionList(page, name).catch(() => null);
    const option = list ? pickMentionOption(list) : null;
    const same = !!option && !!last && Math.abs(option.x - last.x) < 1 && Math.abs(option.y - last.y) < 1;
    if (!same) stillSince = Date.now();
    else if (Date.now() - stillSince >= MENTION_ROW_STILL_MS) return option;
    last = option;
    await page.waitForTimeout(400);
  }
  return null;
}

/**
 * The topic icon of a hovered message's toolbar: 👍, 💬, ↪, the topic icon,
 * 「⋯」 — the one left of 「⋯」. The toolbar opens at the bubble's top right
 * (CI: icons ~24px apart, level with the message text). `bubble` is the box
 * of the message text; `icons` are
 * small uncovered elements next to the bubble; nested ones (a button and its
 * svg) collapse into one slot. Null unless a run of at least four slots
 * starts right after the bubble. The vision agent tapped empty space 500px
 * off this toolbar until Midscene's replanning limit, in two CI runs.
 */
export function pickTopicIcon(bubble: ScreenBox, icons: readonly ScreenBox[]): ScreenBox | null {
  const right = bubble.x + bubble.width;
  const slots: ScreenBox[] = [];
  const near = icons
    .filter((box) => {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      return (
        box.width >= 10 && box.width <= 40 && box.height >= 10 && box.height <= 40 &&
        cx > right && cy >= bubble.y - 14 && cy <= bubble.y + 26
      );
    })
    .sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2));
  for (const box of near) {
    const last = slots.at(-1);
    if (last && Math.abs(last.x + last.width / 2 - (box.x + box.width / 2)) < 6) {
      if (box.width * box.height > last.width * last.height) slots[slots.length - 1] = box;
    } else {
      slots.push(box);
    }
  }
  // One contiguous toolbar starting next to the bubble.
  const run: ScreenBox[] = [];
  for (const slot of slots) {
    const prev = run.at(-1);
    const gap = prev ? slot.x - (prev.x + prev.width) : slot.x - right;
    if (gap > 40) break;
    run.push(slot);
  }
  return run.length >= 4 ? run[run.length - 2] : null;
}

/**
 * In-page: small elements hit at points just right of `bubble`, plus up to
 * three of their ancestors — the hover toolbar's icons and buttons. A string
 * for the same reason as FIND_EDITOR.
 */
const TOOLBAR_ICONS = `(({ x, y, width, height }) => {
  const out = [];
  const seen = new Set();
  for (let py = y - 14; py <= y + 26; py += 4) {
    for (let px = x + width + 2; px <= x + width + 220; px += 3) {
      let el = document.elementFromPoint(px, py);
      for (let depth = 0; el && depth < 4; depth += 1, el = el.parentElement) {
        if (seen.has(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width <= 40 && r.height <= 40) out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
      }
    }
  }
  return out;
})`;

/** The hovered bubble's topic icon, read from the page; null if not found. */
export async function findTopicIcon(page: Page, bubble: ScreenBox): Promise<ScreenBox | null> {
  const icons = (await page.evaluate(`(${TOOLBAR_ICONS})(${JSON.stringify(bubble)})`).catch(() => [])) as ScreenBox[];
  return pickTopicIcon(bubble, icons);
}

/** What openNativeTopicWith needs from the page; injected so it can be tested. */
export interface NativeTopicDeps {
  /** Hover the message bubble; false when it could not be hovered. */
  hover: () => Promise<boolean>;
  /** The hovered bubble's topic icon (findTopicIcon); null until the full toolbar shows. */
  findIcon: () => Promise<ScreenBox | null>;
  click: (box: ScreenBox) => Promise<void>;
  /** The vision fallback: click the topic icon the prompt describes. */
  askVision: () => Promise<void>;
  /** The click hit 转发 and opened its dialog. */
  forwardDialogOpen: () => Promise<boolean>;
  /** Close whatever the click opened (Escape). */
  dismiss: () => Promise<void>;
  /** The message's topic panel opened. */
  topicPanelOpen: () => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

/** How long a hovered message may take to offer its full toolbar. */
const TOOLBAR_WAIT_MS = 15_000;

/**
 * The hovered message's topic icon, once its full toolbar shows. A message
 * that is still sending offers only 「⋯」 (CI, run 40207592909: every Claude
 * seed was checked 800ms after the hover, still sending, so the vision agent
 * was asked — and tapped empty space until Midscene's replanning limit). The
 * toolbar is drawn for the state under the pointer, so hover again each poll.
 */
export async function waitForTopicIcon(deps: NativeTopicDeps, budgetMs = TOOLBAR_WAIT_MS): Promise<ScreenBox | null> {
  const deadline = deps.now() + budgetMs;
  for (;;) {
    const icon = await deps.findIcon();
    if (icon) return icon;
    if (deps.now() >= deadline) return null;
    await deps.sleep(1_000);
    await deps.hover();
  }
}

/**
 * Open a message's native topic: hover it, wait for its toolbar and click the
 * topic icon. The vision agent is only the last attempt's fallback, and its
 * failure ends that attempt rather than the case.
 */
export async function openNativeTopicWith(deps: NativeTopicDeps, tag: string, attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!(await deps.hover())) continue;
    const icon = await waitForTopicIcon(deps);
    if (icon) {
      await deps.click(icon);
    } else if (attempt < attempts) {
      deps.log(`No full toolbar next to ${tag} (attempt ${attempt}); hovering again`);
      continue;
    } else {
      deps.log(`No full toolbar next to ${tag} (attempt ${attempt}); asking the vision agent`);
      try {
        await deps.askVision();
      } catch (error) {
        deps.log(`The vision agent could not click the topic icon of ${tag}: ${(error as Error).message.split('\n')[0]}`);
        continue;
      }
    }
    await deps.sleep(1_000);
    if (await deps.forwardDialogOpen()) {
      deps.log(`Opening the topic of ${tag} hit Forward (attempt ${attempt}); retrying`);
      await deps.dismiss();
      continue;
    }
    if (await deps.topicPanelOpen()) return;
    deps.log(`No topic panel for ${tag} (attempt ${attempt}); retrying`);
    await deps.dismiss();
  }
  throw new Error(`Could not open the native topic of ${tag} after ${attempts} attempts`);
}

/** One line on what the page held when the list never offered the bot. */
async function describeMentionList(page: Page, name: string): Promise<string> {
  const list = await mentionList(page, name).catch(() => null);
  if (!list) return 'no editor has focus';
  const near = list.options.filter((box) => aboveEditor(box, list.editor));
  return (
    `${list.options.length} name match(es) on top, ${near.length} above the input ` +
    `(${near.filter((box) => box.fresh).length} new); 会话内成员 headers ${list.inChat.length}, ` +
    `会话外的人 headers ${list.outside.length}; input ${JSON.stringify(await focusedInputText(page))}`
  );
}
/**
 * The input holds exactly one mention and it is `botName`. `chips` are the
 * texts of the editor's mention chips (MENTION_CHIPS): a selected member
 * becomes a non-editable chip reading `@<display name>`, while the filter
 * query typed after `@` stays plain text, so an unselected query never passes
 * even though it reads the same. `@@` in the input means a stray literal `@`
 * stayed in front of the chip, which breaks command parsing.
 */
export function holdsOnlyMention(chips: readonly string[], text: string, botName: string): boolean {
  const names = botDisplayNames(botName).map((name) => `@${name}`);
  return chips.length === 1 && names.includes(chips[0].trim()) && !text.includes('@@');
}

/**
 * In-page: texts of the mention chips in the message editor. Feishu renders a
 * picked member as `<span contenteditable="false">…<bdi>@Name</bdi>…</span>`;
 * the placeholder is non-editable too but does not start with `@`. A string
 * for the same reason as FIND_EDITOR.
 */
const MENTION_CHIPS = `(() => {
  const editor = ${FIND_EDITOR};
  if (!editor) return [];
  return [...editor.querySelectorAll('[contenteditable="false"]')]
    .filter((el) => !el.parentElement?.closest('[contenteditable="false"]'))
    .map((el) => (el.textContent || '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim())
    .filter((text) => text.startsWith('@'));
})()`;

async function inputHoldsOnlyMention(page: Page, botName: string): Promise<boolean> {
  const chips = ((await page.evaluate(MENTION_CHIPS).catch(() => [])) ?? []) as string[];
  return holdsOnlyMention(chips, await focusedInputText(page), botName);
}

/**
 * Compare editor text by content only. Feishu's editor pads paragraphs with
 * zero-width spaces (`"/reply-mode \u200b\n\u200b\n\u200b"`), which `\s`
 * does not match — the first version of this check rejected every input.
 */
export function normalizeInput(text: string): string {
  return text.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Type `text` into the focused input and confirm the input ends with it.
 * CI lost the first keystrokes right after focusing the input: the daemon
 * received "eply-mode new-topic" and "2e-sg2-claude-…". For a command that
 * means a silently skipped step (a mode never restored), so a garbled input
 * is cleared and retyped instead of sent.
 */
async function typeVerified(
  page: Page,
  text: string,
  delay: number,
  lead = '',
): Promise<boolean> {
  await page.keyboard.type(text, { delay });
  await page.waitForTimeout(300);
  return inputHolds(await focusedInputText(page), text, lead);
}

/**
 * The editor holds exactly `lead` (a mention chip, or nothing) followed by what
 * was typed. Lost keystrokes hit the start, so the head must be there in full
 * and nothing else may precede it — leftover text would ride along and stop a
 * slash command from parsing. The tail anchors the end; the middle is not
 * compared character by character, so editor rendering cannot fail a send.
 */
export function inputHolds(editorText: string, typed: string, lead = ''): boolean {
  const have = normalizeInput(editorText);
  const prefix = normalizeInput(lead);
  if (!have.startsWith(prefix)) return false;
  const rest = have.slice(prefix.length).trim();
  const want = normalizeInput(typed);
  return (
    rest.startsWith(want.slice(0, 24)) &&
    rest.endsWith(want.slice(-24)) &&
    Math.abs(rest.length - want.length) <= 2
  );
}

/**
 * Click the message editor without vision: the bottom-most visible editor in
 * the conversation area. `topic` picks the right-most one, which is the reply
 * box of an open topic panel or topic detail; `chat` the left-most, the chat's
 * own input. Returns false when no editor is visible.
 */
export async function focusEditor(page: Page, where: 'chat' | 'topic'): Promise<boolean> {
  const editors = page.locator('[contenteditable="true"]');
  const viewport = page.viewportSize() ?? BROWSER_CONFIG.viewport;
  const boxes: Array<ScreenBox & { index: number }> = [];
  const count = await editors.count();
  for (let index = 0; index < count; index++) {
    const box = await editors.nth(index).boundingBox().catch(() => null);
    if (box) boxes.push({ index, ...box });
  }
  const panelLeft = where === 'topic' ? await sideTopicPanelLeft(page) : null;
  const pick = pickEditorBox(boxes, where, viewport, panelLeft);
  if (!pick) return false;
  await editors.nth(pick.index).click({ timeout: 5_000 });
  return true;
}

/**
 * The editor to type into: right of the chat list and low on the page; for
 * `topic` the right-most (an open topic panel's reply box), for `chat` the
 * left-most (the chat's own input). With a topic panel open beside the chat
 * (`panelLeft`), only an editor inside it counts: CI sent a topic probe to
 * the group because the panel's box had not mounted yet and the chat's input
 * was the right-most editor on the page.
 */
export function pickEditorBox<T extends ScreenBox>(
  boxes: readonly T[],
  where: 'chat' | 'topic',
  viewport: { width: number; height: number },
  panelLeft: number | null = null,
): T | null {
  const usable = boxes.filter(
    (box) =>
      box.width >= 80 &&
      box.height >= 8 &&
      // The conversation sits right of the chat list; inputs sit low.
      box.x >= viewport.width * 0.3 &&
      box.y >= viewport.height * 0.45 &&
      (panelLeft === null || box.x >= panelLeft - 40),
  );
  usable.sort(
    (a, b) => (where === 'topic' ? b.x - a.x : a.x - b.x) || b.y + b.height - (a.y + a.height),
  );
  return usable[0] ?? null;
}

/** Left edge of a topic panel open beside the chat (its 「话题」 title, top right); null without one. */
async function sideTopicPanelLeft(page: Page): Promise<number | null> {
  const viewport = page.viewportSize() ?? BROWSER_CONFIG.viewport;
  const titles = page.getByText(/^\s*(话题|Topic)\s*$/);
  const count = await titles.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const box = await titles.nth(i).boundingBox().catch(() => null);
    if (box && box.width > 0 && box.x > viewport.width * 0.6 && box.y < viewport.height * 0.15) return box.x;
  }
  return null;
}

const TOPIC_REPLY_BOX_PROMPT =
  '点击正在显示的测试话题（右侧话题面板，或占满主内容区的话题）最底部提示为「回复话题」的输入框；' +
  '不要点群聊自己的输入框（提示为「发送给 …」）';

/** The pieces of a focus attempt; injected so the loop can be tested. */
export interface FocusLoop {
  /** Click the candidate input; true when an editor holds the caret. */
  focus: () => Promise<boolean>;
  /** The focused editor is the one wanted (a topic reply box, for `topic`). */
  accepted: () => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** True once a focused editor passes `accepted`; false when `waitMs` runs out. */
export async function focusUntilAccepted(loop: FocusLoop, waitMs: number): Promise<boolean> {
  const deadline = loop.now() + waitMs;
  for (;;) {
    if ((await loop.focus()) && (await loop.accepted())) return true;
    if (loop.now() >= deadline) return false;
    await loop.sleep(500);
  }
}

/**
 * Whether the focused editor is a topic's reply box, from what surrounds it:
 * its own label, or its composer's text. A topic composer reads 「回复话题」 and
 * carries a 「同时发送到群 / 同时发送到会话」 checkbox, which stays while the box
 * holds text; the chat's own input reads 「发送给 …」 and has none.
 */
export function isTopicReplyComposer(evidence: { labels: readonly string[]; texts: readonly string[] }): boolean {
  return (
    evidence.labels.some((label) => /回复话题|Reply to topic/i.test(label)) ||
    evidence.texts.some((text) => /回复话题|同时发送到|Also send to/i.test(text))
  );
}

/**
 * In-page: the focused editor's labels, and the text of each ancestor up to
 * the composer's height. A string for the same reason as FIND_EDITOR.
 */
const FOCUSED_COMPOSER = `(() => {
  const editor = ${FIND_EDITOR};
  if (!editor) return { labels: [], texts: [] };
  const labels = ['placeholder', 'data-placeholder', 'aria-placeholder', 'aria-label']
    .map((name) => editor.getAttribute(name) || '');
  const texts = [];
  let el = editor;
  for (let depth = 0; el && depth < 8; depth += 1, el = el.parentElement) {
    if (el.getBoundingClientRect().height > 260) break;
    texts.push(el.innerText || '');
  }
  return { labels, texts };
})()`;

async function focusedIsTopicReply(page: Page): Promise<boolean> {
  const evidence = (await page.evaluate(FOCUSED_COMPOSER).catch(() => null)) as { labels: string[]; texts: string[] } | null;
  return !!evidence && isTopicReplyComposer(evidence);
}

/** What focusTarget needs from the page; injected so the whole chain can be tested. */
export interface FocusDeps {
  /** Click the candidate input (focusEditor); false when there is none. */
  clickEditor: () => Promise<boolean>;
  /** An editor holds the caret: CI once typed into nothing after a positional click. */
  hasCaret: () => Promise<boolean>;
  /** The focused editor is a topic's reply box (isTopicReplyComposer). */
  isTopicReply: () => Promise<boolean>;
  /** The vision fallback: click the input the prompt describes. */
  askVision: () => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** The focus loop for `where`: `topic` accepts only a topic reply box. */
export function buildFocusLoop(deps: FocusDeps, where: 'chat' | 'topic'): FocusLoop {
  return {
    focus: async () => (await deps.clickEditor()) && (await deps.hasCaret()),
    accepted: () => (where === 'topic' ? deps.isTopicReply() : Promise.resolve(true)),
    now: deps.now,
    sleep: deps.sleep,
  };
}

/**
 * Put the caret in the chat's input or the open topic's reply box. `topic`
 * only accepts a box that is itself a topic reply box: while a topic panel is
 * still mounting, the only editor on the page can be the chat's own — CI sent
 * a topic probe to the group that way. It waits up to `waitMs` for the box,
 * then asks the vision agent, and refuses to go on in another input.
 */
export async function focusTarget(deps: FocusDeps, where: 'chat' | 'topic', waitMs: number): Promise<void> {
  if (await focusUntilAccepted(buildFocusLoop(deps, where), waitMs)) return;
  await deps.askVision();
  if (where === 'topic' && !(await deps.isTopicReply())) {
    throw new Error('Could not put the caret in the topic reply box; not typing into another input');
  }
}

async function focusOrAsk(
  page: Page,
  agent: PlaywrightAgent,
  where: 'chat' | 'topic',
  prompt: string,
  waitMs = 0,
): Promise<void> {
  await focusTarget(
    {
      clickEditor: () => focusEditor(page, where).catch(() => false),
      hasCaret: () => page.evaluate(`!!${FIND_EDITOR}`),
      isTopicReply: () => focusedIsTopicReply(page),
      askVision: async () => {
        await agent.aiAct(prompt);
      },
      now: () => Date.now(),
      sleep: (ms) => page.waitForTimeout(ms),
    },
    where,
    waitMs,
  );
}

/** How long the first focus of one topic send waits for the reply box to mount. */
const TOPIC_REPLY_WAIT_MS = 10_000;
/** Later focuses of the same send: the box was already given its time. */
const TOPIC_REPLY_RETRY_WAIT_MS = 2_000;

/**
 * Wait budgets for the focuses of one send: the first gets the full wait, the
 * retries (sendTyped and typeMention focus again after a failed attempt) only
 * a short one, so a box that never mounts costs 10s, not 10s per retry.
 */
export function focusBudgets(first = TOPIC_REPLY_WAIT_MS, retry = TOPIC_REPLY_RETRY_WAIT_MS): () => number {
  let next = first;
  return () => {
    const budget = next;
    next = retry;
    return budget;
  };
}

/** A focus for one topic send (see focusBudgets). */
function topicReplyFocus(page: Page, agent: PlaywrightAgent): () => Promise<void> {
  const budget = focusBudgets();
  return () => focusOrAsk(page, agent, 'topic', TOPIC_REPLY_BOX_PROMPT, budget());
}

/**
 * Focus an input via `focus`, type `text` and send it. Slash commands get a
 * trailing space so Feishu's suggestion popup cannot take the Enter; the
 * daemon trims it before parsing.
 */
export async function sendTyped(
  page: Page,
  focus: () => Promise<unknown>,
  text: string,
  delay: number,
): Promise<void> {
  const typed = text.startsWith('/') ? `${text} ` : text;
  let seen = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    await focus();
    await page.waitForTimeout(500);
    await warmUpInput(page);
    if (await typeVerified(page, typed, delay)) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1_000);
      return;
    }
    seen = await focusedInputText(page);
    console.warn(`[e2e] Typed input garbled (attempt ${attempt}): ${JSON.stringify(seen.slice(0, 80))}; retyping`);
  }
  await clearFocusedInput(page);
  throw new Error(`Could not type ${JSON.stringify(text.slice(0, 60))}: the input read ${JSON.stringify(seen.slice(0, 80))}`);
}

/**
 * Empty the message editor. Feishu's editor ignores Ctrl+A and a DOM
 * selection set from script (CI: retries piled up "eply-mode eply-mode …" and
 * a restore command was appended to an old probe three times), so delete from
 * the end one character at a time and check it reads empty.
 */
async function clearFocusedInput(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = normalizeInput(await focusedInputText(page));
    if (text === '') return;
    await page.keyboard.press('Control+End');
    await page.keyboard.press('End');
    for (let i = 0; i < text.length + 4; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
  }
}

/**
 * The first keys after focusing the editor are sometimes swallowed ("/r" of
 * "/reply-mode", "e" of "e2e-…"). Spend them on throwaway characters, then
 * clear, so the real text starts on a warmed-up editor.
 */
async function warmUpInput(page: Page): Promise<void> {
  await page.keyboard.type('xxx', { delay: 30 });
  await page.waitForTimeout(200);
  await clearFocusedInput(page);
}

/**
 * Mention `botName` in the focused input, type `message` after it and send.
 * The member list is filtered by typing the name, its row is clicked once it
 * has loaded (waitForMentionOption), and the input is checked before sending:
 * a message @ing the wrong bot is never sent. CI pressed Enter on the list
 * while it still showed a skeleton row — that only added a line break — and
 * the vision fallback then looped until Midscene's replanning limit. Slash
 * commands get a trailing space so Feishu's suggestion popup cannot take the
 * Enter; the daemon trims it. `focus` puts the caret back in the input
 * between attempts: a click that misses the list blurs it, and a clear or a
 * retype into a blurred input does nothing (CI: "@Claude" + "aude").
 */
async function typeMention(
  page: Page,
  botName: string,
  message: string,
  focus: () => Promise<unknown>,
): Promise<void> {
  const name = botName.replace(/^\[Botmux\]/, '');
  let text = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      await focus();
      await page.waitForTimeout(500);
      await clearFocusedInput(page);
      await warmUpInput(page);
    }
    await mentionList(page, name, true).catch(() => null);
    await page.keyboard.type(`@${name}`, { delay: 60 });
    const option = await waitForMentionOption(page, name);
    if (option) {
      await page.mouse.click(option.x + Math.min(option.width / 2, 40), option.y + option.height / 2);
      await page.waitForTimeout(600);
      text = await focusedInputText(page);
      if (
        (await inputHoldsOnlyMention(page, name)) &&
        (await typeVerified(page, ` ${message}${message.startsWith('/') ? ' ' : ''}`, 20, text)) &&
        (await inputHoldsOnlyMention(page, name))
      ) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1_000);
        return;
      }
    } else {
      console.warn(
        `[e2e] @${name}: the member list never offered ${botDisplayNames(name).join(' / ')} (attempt ${attempt}): ` +
          (await describeMentionList(page, name)),
      );
    }
    text = await focusedInputText(page);
    console.warn(`[e2e] @${name} selection attempt ${attempt} left the input as ${JSON.stringify(text)}; retrying`);
  }
  throw new Error(`Could not mention ${name}: the input still read ${JSON.stringify(text)}`);
}

/** @mention `botName` from the reply input of the topic open in the main area. */
export async function sendMentionInOpenTopic(
  page: Page,
  agent: PlaywrightAgent,
  botName: string,
  message: string,
): Promise<void> {
  await scrollThreadToBottom(agent);
  const focus = topicReplyFocus(page, agent);
  await focus();
  await page.waitForTimeout(500);
  await warmUpInput(page);
  await typeMention(page, botName, message, focus);
}

/**
 * Type `text` into the chat's bottom message input with real key presses and
 * send it as a top-level message (not inside a topic).
 */
export async function typeChatMessage(
  agent: PlaywrightAgent,
  page: Page,
  text: string,
): Promise<void> {
  await sendTyped(
    page,
    () => focusOrAsk(page, agent, 'chat', '点击聊天区域最底部的消息输入框（不是话题回复框）'),
    text,
    20,
  );
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a bot reply to appear. Checks for any new message that isn't
 * the test message itself.
 */
export async function waitForBotReply(
  agent: PlaywrightAgent,
  opts?: { timeoutMs?: number },
): Promise<void> {
  await agent.aiWaitFor(
    '聊天中出现了来自机器人的新回复消息（不是我自己发送的消息）',
    { timeoutMs: opts?.timeoutMs ?? 60_000, checkIntervalMs: 5_000 },
  );
}

/**
 * Wait for the current thread's streaming card to show a specific status.
 * Status values mirror src/im/lark/card-builder.ts.
 */
export async function waitForCardStatus(
  agent: PlaywrightAgent,
  status: '启动中…' | '工作中' | '等待输入' | '正在分析…',
  opts?: { timeoutMs?: number },
): Promise<void> {
  await agent.aiWaitFor(
    `主内容区正在显示的测试话题最底部，当前会话的最新流式卡片标题包含"${status}"字样；` +
      '不要把左侧话题列表预览或历史旧话题当作当前会话结果',
    { timeoutMs: opts?.timeoutMs ?? 60_000, checkIntervalMs: 3_000 },
  );
}

/** What waitForCardButtons needs from the page; injected so it can be tested. */
export interface CardWaitDeps {
  /** The session card's buttons are in the DOM. */
  cardShown: () => Promise<boolean>;
  /** Reveal 「N 条新消息」 and click a late 直接开启会话. */
  nudge: () => Promise<void>;
  /** Load Messenger afresh and open the topic again. */
  reopen: () => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** How long the topic may go without the session card before it is reopened. */
const CARD_STALE_MS = 45_000;

/**
 * Poll for the session card's buttons; once, after 45s without them, reopen
 * the topic. CI (run 40257129089): the topic stayed at the recalled repo card
 * (「此消息已撤回」) while the session had already answered, until the step
 * timed out. Reopening (a Messenger load plus openThreadForMessage) can take
 * longer than what is left of `timeoutMs`, so the card is looked for once
 * more after it; `timeoutMs` still bounds the polling. True when the card
 * showed.
 */
export async function waitForCardButtons(deps: CardWaitDeps, timeoutMs: number): Promise<boolean> {
  const started = deps.now();
  const deadline = started + timeoutMs;
  let reopened = false;
  while (deps.now() < deadline) {
    if (await deps.cardShown()) return true;
    if (!reopened && deps.now() - started >= CARD_STALE_MS) {
      reopened = true;
      await deps.reopen();
      continue;
    }
    await deps.nudge();
    await deps.sleep(2_000);
  }
  return reopened && (await deps.cardShown());
}

/**
 * Full flow after sending a message:
 *  1. Switch to Feishu's 「话题」filter tab so the test topic opens in the
 *     wide main content area (much more reliable than operating in the
 *     narrow right-side thread panel).
 *  2. Find our topic by the test-message tag and open it.
 *  3. Handle repo selection card if present ("直接开启会话").
 *  4. Wait for streaming card to appear.
 *
 * @param msgHint - The test message; we extract its `e2e-*-<ts>` tag and
 *   use that to locate the right topic. REQUIRED — locating "the latest"
 *   topic without a tag is too flaky when historical topics exist.
 */
export async function waitForStreamingCard(
  agent: PlaywrightAgent,
  opts?: { timeoutMs?: number; msgHint?: string; page?: Page },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  await openThreadForMessage(agent, { timeoutMs, msgHint: opts?.msgHint, page: opts?.page });
  await clickDirectStartIfPresent(agent, opts?.page);

  // Load what the topic holds before looking: a reply that arrived while the
  // topic was open sits behind 「N 条新消息」 (CI: repo card never rendered,
  // the streaming-card wait timed out). Click it, and a late repo card, until
  // the card's buttons are in the DOM.
  const page = opts?.page;
  if (page) {
    const msgHint = opts?.msgHint;
    const tag = msgHint ? messageTag(msgHint) : '';
    await waitForCardButtons(
      {
        cardShown: async () => (await pageTextCount(page, '打开 Web 终端')) > 0,
        nudge: async () => {
          await revealNewMessages(page);
          if (tag) await clickDirectStartAfter(page, tag);
        },
        reopen: async () => {
          if (!msgHint) return;
          console.warn(`[e2e] No session card for "${tag}" after ${CARD_STALE_MS / 1000}s; re-opening the topic`);
          await reopenTopic(agent, page, msgHint)();
        },
        now: () => Date.now(),
        sleep: (ms) => page.waitForTimeout(ms),
      },
      timeoutMs,
    );
  }

  // Step 5: Wait for streaming card.
  await agent.aiWaitFor(
    '主内容区正在显示的测试话题里出现当前会话的流式卡片；' +
      '卡片必须带有"显示输出"、"打开 Web 终端"、"获取操作链接"或"关闭会话"这类会话操作按钮；' +
      '卡片标题包含"启动中"、"工作中"、"等待输入"或"正在分析"之一，或正文已经出现 Codex 的 usage/rate limit/model switch 提示；' +
      '"项目仓库管理"和"直接开启会话"的仓库选择卡不能算作流式卡片',
    { timeoutMs, checkIntervalMs: 5_000 },
  );
}

/** Click an entry of the filter column (「消息」, 「话题」, …); false when it is not on screen (see pickFilterLabel). */
export async function clickChatFilter(page: Page, labels: readonly string[]): Promise<boolean> {
  const viewport = page.viewportSize() ?? BROWSER_CONFIG.viewport;
  const boxes = ((await page.evaluate(`(${TEXT_NODE_BOXES})(${JSON.stringify(labels)})`).catch(() => [])) ??
    []) as ScreenBox[];
  const box = pickFilterLabel(boxes, viewport);
  if (!box) {
    const xs = boxes.map((b) => Math.round(b.x)).join(', ') || 'none';
    console.warn(`[e2e] No 「${labels[0]}」 entry in the filter column (text nodes at x: ${xs})`);
    return false;
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1_000);
  return true;
}

/**
 * In-page: boxes of the elements holding a text node that reads exactly one
 * of `labels`. Matching text nodes, not elements: the filter entry wraps the
 * word with an icon and a count, so no element reads just 「话题」 — CI never
 * once clicked it through `getByText` and fell back to the vision agent, which
 * sometimes looped until the replanning limit. A string for the same reason
 * as FIND_EDITOR.
 */
const TEXT_NODE_BOXES = `((labels) => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.data.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim();
    if (!labels.includes(text)) continue;
    const el = walker.currentNode.parentElement;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  return out;
})`;

/**
 * In-page: boxes of the elements holding a text node that reads exactly
 * `name`, each with `onTop`. Text clipped by a scroll container or off screen
 * keeps its box but is not on top. A string for the same reason as
 * FIND_EDITOR.
 */
const TITLE_BOXES = `((name) => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.data.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim() !== name) continue;
    const el = walker.currentNode.parentElement;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const onTop = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    out.push({ x: r.left, y: r.top, width: r.width, height: r.height, onTop });
  }
  return out;
})`;

/**
 * The entry of the filter column between the app bar and the chat list. The
 * same words title the app bar's 「消息」 (x ≈ 2%), the chat list (≈ 17%) and an
 * open topic's panel (right half), so only a label inside the column's band
 * (6%–16% of the width) counts.
 */
export function pickFilterLabel(boxes: readonly ScreenBox[], viewport: { width: number; height: number }): ScreenBox | null {
  const inBand = boxes.filter((box) => box.x >= viewport.width * 0.06 && box.x <= viewport.width * 0.16);
  return inBand[0] ?? null;
}

const TOPICS_FILTER = ['话题', 'Topics'] as const;
export const MESSAGES_FILTER = ['消息', 'Messages'] as const;

/** A text node holding a test tag (TAG_TEXTS): its element's box and the row around it. */
export interface TagText {
  box: ScreenBox;
  /** Nearest ancestor at least twice the element's height: the chat-list entry in the list. */
  row: ScreenBox | null;
}

/**
 * In-page: every text node containing `tag`. A string for the same reason as
 * FIND_EDITOR.
 */
const TAG_TEXTS = `((tag) => {
  const box = (r) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.data.includes(tag)) continue;
    const el = walker.currentNode.parentElement;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    let row = null;
    for (let a = el.parentElement, i = 0; a && i < 8; a = a.parentElement, i++) {
      const ar = a.getBoundingClientRect();
      if (ar.height >= r.height * 2) { row = box(ar); break; }
    }
    out.push({ box: box(r), row });
  }
  return out;
})`;

/**
 * The chat-list entry of the topic whose root message carries the tag. The
 * list (left of 30% of the width) shows every topic, in a group or a DM, as
 * an entry titled with its root message; the chat the topic lives in shows
 * the same tag in the preview line under the chat's name, and opening that
 * shows the chat, not the topic. So only a tag in the upper half of its entry
 * counts.
 */
export function pickTopicEntry(texts: readonly TagText[], viewport: { width: number; height: number }): ScreenBox | null {
  const titles = texts.filter(({ box, row }) => {
    const middle = box.y + box.height / 2;
    return (
      row !== null &&
      box.x >= viewport.width * 0.03 &&
      box.x < viewport.width * 0.3 &&
      middle > 0 &&
      middle < viewport.height &&
      middle < row.y + row.height / 2
    );
  });
  return [...titles].sort((a, b) => a.box.y - b.box.y)[0]?.box ?? null;
}

/**
 * The wide main area shows a topic carrying the tag: the topic's 「话题」 header
 * sits at its top left (30%–50% of the width; the narrow side panel's title is
 * further right) and the tag is on the right of the list.
 */
export function topicOpenInMain(
  headers: readonly ScreenBox[],
  texts: readonly TagText[],
  viewport: { width: number; height: number },
): boolean {
  const header = headers.some(
    (box) => box.x >= viewport.width * 0.3 && box.x < viewport.width * 0.5 && box.y < viewport.height * 0.1,
  );
  return header && texts.some(({ box }) => box.x >= viewport.width * 0.3);
}

/**
 * The main area already shows the tag's own topic: the tag sits in the root
 * message right under the topic's 「话题」 header (within 15% of the height).
 * A reply quoting the tag in another topic sits lower, below the root and its
 * 「N 条话题回复」 divider.
 */
export function topicRootInMain(
  headers: readonly ScreenBox[],
  texts: readonly TagText[],
  viewport: { width: number; height: number },
): boolean {
  return headers.some(
    (header) =>
      header.x >= viewport.width * 0.3 &&
      header.x < viewport.width * 0.5 &&
      header.y < viewport.height * 0.1 &&
      texts.some(
        ({ box }) =>
          box.x >= viewport.width * 0.3 && box.y > header.y && box.y - header.y < viewport.height * 0.15,
      ),
  );
}

/** What openTopicFromList needs from the page; injected so it can be tested. */
export interface TopicListDeps {
  tagTexts: () => Promise<TagText[]>;
  /** Text nodes reading 「话题」/"Topic" (TEXT_NODE_BOXES). */
  headers: () => Promise<ScreenBox[]>;
  click: (box: ScreenBox) => Promise<void>;
  /** Load Messenger afresh (navigateToMessenger). */
  reload: () => Promise<void>;
  viewport: { width: number; height: number };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** How long the list may go without opening the topic before Messenger is reloaded. */
const TOPIC_LIST_STALE_MS = 45_000;

/**
 * Click the topic's chat-list entry until the main area shows the topic;
 * false when that never happened within budgetMs. Waits while the entry is
 * not listed yet: a topic exists only once someone replies in it. After 45s
 * without the topic open, Messenger is reloaded once: CI (run 40130808312)
 * showed a chat list that stayed minutes behind while the open chat already
 * had the topic and its reply. Only once: a reload redraws the list blank
 * again, and while Messenger loads slowly every reload costs most of the
 * budget (runs 40257129089 and 40271295593 reloaded every 30s and never got
 * past the blank list before the step timed out).
 */
export async function openTopicFromList(deps: TopicListDeps, budgetMs: number): Promise<boolean> {
  const started = deps.now();
  const deadline = started + budgetMs;
  let reloaded = false;
  while (deps.now() < deadline) {
    if (!reloaded && deps.now() - started >= TOPIC_LIST_STALE_MS) {
      reloaded = true;
      await deps.reload();
    }
    const texts = await deps.tagTexts();
    const entry = pickTopicEntry(texts, deps.viewport);
    if (!entry) {
      // CI (run 40257129089): the list drew blank rows for over a minute while
      // the main area already showed this topic. Without a listed entry to
      // click, accept the topic only by its root message.
      if (topicRootInMain(await deps.headers(), texts, deps.viewport)) return true;
      await deps.sleep(2_000);
      continue;
    }
    await deps.click(entry);
    await deps.sleep(1_500);
    if (topicOpenInMain(await deps.headers(), await deps.tagTexts(), deps.viewport)) return true;
  }
  return false;
}

function topicListDeps(page: Page, tag: string): TopicListDeps {
  return {
    tagTexts: async () =>
      ((await page.evaluate(`(${TAG_TEXTS})(${JSON.stringify(tag)})`).catch(() => [])) ?? []) as TagText[],
    headers: async () =>
      ((await page.evaluate(`(${TEXT_NODE_BOXES})(${JSON.stringify(['话题', 'Topic'])})`).catch(() => [])) ??
        []) as ScreenBox[],
    click: async (box) => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    },
    // One page load, not navigateToMessenger's four 60s attempts: the list is
    // polled right after, and the budget is the list path's, not a full load's.
    reload: async () => {
      await page.goto(getMessengerUrl(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    },
    viewport: page.viewportSize() ?? BROWSER_CONFIG.viewport,
    now: () => Date.now(),
    sleep: (ms) => page.waitForTimeout(ms),
  };
}

/**
 * Steps 1–3 of openThreadForMessage the way they ran before the chat-list
 * path: switch to the 「话题」 filter, then click the entry holding the tag.
 */
async function openTopicViaFilter(
  agent: PlaywrightAgent,
  page: Page | undefined,
  tag: string,
  timeoutMs: number,
): Promise<void> {
  // Step 1: Switch to the 「话题 / Topics」filter tab on the left-middle
  // column. The saved Feishu account can render either the Chinese UI (tab
  // labelled 「话题」) or the English UI (tab labelled "Topics" / "Topic
  // chats"), so the instruction accepts either label instead of demanding the
  // literal Chinese characters (which made the agent refuse to click when the
  // UI was English). After this, the middle column shows the topic list.
  // The label is clicked through the DOM first: CI once saw the vision click
  // "succeed" while 「消息」 stayed selected.
  for (let round = 1; ; round++) {
    if (!(round === 1 && page && (await clickChatFilter(page, TOPICS_FILTER)))) {
      await agent.aiAct(
        'Click the "Topics" filter tab at the top of the left-middle column ' +
          '(Chinese UI: the tab labelled 「话题」; English UI: the tab labelled ' +
          '"Topics" or "Topic chats"). Its icon looks like an index-card/contact ' +
          'card (📇/▯). It is NOT "Messages/消息", NOT "@mentions/@我", NOT ' +
          '"Unread/未读", NOT "Labels/标签". After clicking, the middle column ' +
          'switches to the topics list.',
      );
    }
    try {
      await agent.aiWaitFor(
        'The middle column is now a list of topic/thread entries (a topic list, ' +
          'not the ordinary message/chats list). The active filter tab is Topics ' +
          '(「话题」in Chinese).',
        { timeoutMs: 15_000, checkIntervalMs: 2_000 },
      );
      break;
    } catch (error) {
      if (round >= 2) throw error;
      console.warn(`[e2e] The 「话题」 filter did not take (round ${round}); clicking it again`);
    }
  }

  // Step 2 + 3: Find and click the topic. Feishu's topic list visually
  // truncates previews to ~6-10 chars, so the AI can't reliably match the
  // full tag. Playwright's DOM locator sees the full text even when it's
  // clipped by CSS, so we use it when page is available.
  if (page) {
    const deadline = Date.now() + timeoutMs;
    let clicked = false;
    while (Date.now() < deadline) {
      const loc = page.getByText(tag, { exact: false }).first();
      try {
        await loc.waitFor({ state: 'visible', timeout: 3_000 });
        await loc.scrollIntoViewIfNeeded({ timeout: 2_000 });
        await loc.click({ timeout: 3_000 });
        clicked = true;
        break;
      } catch {
        await page.waitForTimeout(2_000);
      }
    }
    if (!clicked) {
      throw new Error(
        `openThreadForMessage: couldn't find topic entry containing "${tag}" within ${timeoutMs}ms`,
      );
    }
    await page.waitForTimeout(1_500);
  } else {
    // Fallback: AI match on label prefix (label-only, without timestamp —
    // e.g. "e2e-mention-one"). Less reliable because truncation may cut
    // into the label itself.
    const labelMatch = tag.match(/^(e2e-[a-z0-9-]+?)-\d{10,}$/i);
    const labelPrefix = labelMatch ? labelMatch[1] : tag;
    await agent.aiWaitFor(
      `中间"话题"列表里出现了一条条目，其标题或最新消息预览包含"${labelPrefix}"字样`,
      { timeoutMs, checkIntervalMs: 3_000 },
    );
    await agent.aiAct(
      `在中间"话题"列表里点击那条预览包含"${labelPrefix}"的条目，把对应话题打开到右侧主内容区`,
    );
  }
}

/**
 * Open a test topic by clicking its chat-list entry (the one titled with the
 * test-message tag; see pickTopicEntry). After this call, the topic is shown
 * in the wide main content area (not the narrow right-side thread panel),
 * which is far more reliable for subsequent assertions and button clicks.
 */
export async function openThreadForMessage(
  agent: PlaywrightAgent,
  opts?: { timeoutMs?: number; msgHint?: string; page?: Page },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const rawMsg = opts?.msgHint ?? '';
  const tag = rawMsg ? messageTag(rawMsg) : '';

  if (!tag) {
    throw new Error(
      'openThreadForMessage requires msgHint — without a test-message tag we cannot reliably pick the right topic among historical ones',
    );
  }

  // The chat list (「消息」) already shows every topic as an entry titled with
  // its root message: click that entry through the DOM. CI never had a
  // 「话题」 filter to switch to (run 40114756911: the vision agent tapped the
  // 「普通群聊」/「话题群聊」 shortcuts above the list and the topic-list check
  // failed both attempts). The filter steps stay as the fallback.
  const page = opts?.page;
  const listBudget = Math.max(timeoutMs - 30_000, timeoutMs / 2);
  if (!(page && (await openTopicFromList(topicListDeps(page, tag), listBudget)))) {
    if (page) console.warn(`[e2e] No chat-list entry opened the topic of "${tag}" in ${listBudget}ms; trying the 「话题」 filter`);
    await openTopicViaFilter(agent, page, tag, page ? timeoutMs - listBudget : timeoutMs);
  }

  // Step 4: Confirm the topic is loaded in the wide main area. This is the
  // anchor point for every subsequent assertion — subsequent prompts refer
  // to "主内容区正在显示的测试话题".
  await agent.aiWaitFor(
    `页面右侧主内容区（宽版，占据页面大部分空间，不是那一条窄的侧栏）已经打开包含"${tag}"的测试话题；` +
      '区域内可见该测试消息，以及下方的机器人相关内容（普通文本气泡、"项目仓库管理"卡、"直接开启会话"按钮或流式卡片之一）',
    { timeoutMs: 35_000, checkIntervalMs: 3_000 },
  );

  await scrollThreadToBottom(agent);
}

export async function clickDirectStartIfPresent(
  agent: PlaywrightAgent,
  page?: Page,
  opts?: { expectMs?: number },
): Promise<void> {
  if (page) await revealNewMessages(page);
  if (page && opts?.expectMs) {
    // The bot always posts a repo card first (Codex): wait for it rather than
    // giving up when the topic's replies are still rendering — and load
    // replies held behind 「N 条新消息」, or the card never renders.
    const deadline = Date.now() + opts.expectMs;
    while (Date.now() < deadline && !(await anyVisible(page.getByText(DIRECT_START_LABEL)))) {
      await revealNewMessages(page);
      await page.waitForTimeout(2_000);
    }
  }
  if (page) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // The visible one: hidden cached copies share the label.
        const matches = page.getByText(DIRECT_START_LABEL);
        let directStart = matches.last();
        for (let i = (await matches.count()) - 1; i >= 0; i--) {
          if (await matches.nth(i).isVisible().catch(() => false)) {
            directStart = matches.nth(i);
            break;
          }
        }
        await directStart.scrollIntoViewIfNeeded({ timeout: 3_000 });
        await directStart.click({ timeout: 3_000 });
        await page.waitForTimeout(1000);
        return;
      } catch {
        await scrollConversation(page, 1_200);
        await page.waitForTimeout(500);
      }
    }
  }

  // The "项目仓库管理" card may take a moment to load. Try twice with scrolling.
  for (let attempt = 0; attempt < 2; attempt++) {
    const hasSkipButton = await agent.aiBoolean(
      '主内容区正在显示的测试话题中可以看到"直接开启会话"或"▶️ 直接开启会话"按钮',
    );
    if (hasSkipButton) {
      try {
        await agent.aiAct(
          '点击主内容区正在显示的测试话题中的"直接开启会话"按钮（可能带有▶️图标）',
        );
      } catch {
        // This button is optional and can disappear if the session has already
        // started. Let the later streaming-card wait decide the real outcome.
      }
      break;
    }
    if (attempt === 0) {
      await scrollThreadToBottom(agent);
    }
  }
}

/**
 * Show the streaming card body in its current screenshot mode.
 * Current cards use "显示输出/隐藏输出".
 */
export async function showStreamingOutput(
  agent: PlaywrightAgent,
  page: Page,
): Promise<void> {
  // The ACK text bubble is the last item after a successful reply, so "the
  // bottom of the thread" is that bubble (thumbs-up / copy / forward), not
  // the streaming card. Bring the card's own button into view first.
  const cardButton = page.getByRole('button', { name: /显示输出|隐藏输出/ }).last();
  try {
    await cardButton.scrollIntoViewIfNeeded({ timeout: 15_000 });
  } catch {
    // The vision checks below report a real miss.
  }
  const cardClause =
    '主内容区正在显示的测试话题里，当前会话的流式卡片（带"打开 Web 终端"或"显示输出/隐藏输出"的那张，可能在 ACK 文本气泡上方）。' +
    '不要把文本气泡右侧的点赞、复制、转发或更多选项当成卡片按钮。';
  const needShow = await agent.aiBoolean(
    `${cardClause}这张卡片的操作按钮中有"📖 显示输出"按钮`,
  );
  if (needShow) {
    try {
      await page
        .getByRole('button', { name: /显示输出/ })
        .last()
        .click({ timeout: 5_000 });
    } catch {
      await agent.aiAct(
        `点击${cardClause}里的"📖 显示输出"按钮；不要点击"打开 Web 终端"，也不要点文本气泡上的按钮`,
      );
    }
    await page.waitForTimeout(1000);
  }
  await agent.aiWaitFor(
    `${cardClause}这张卡片的操作按钮中有"📕 隐藏输出"，` +
      '并且卡片正文显示终端截图、终端区域，或"等待第一张截图"占位',
    { timeoutMs: 30_000, checkIntervalMs: 2_000 },
  );
}

/**
 * Wait for a model-generated natural-language text reply in the current
 * thread. This is the ONLY assertion that proves "the model really answered"
 * — a streaming card showing "等待输入" only proves the CLI went idle, and
 * card body screenshots can't be trusted for model-content assertions.
 *
 * Pass `opts.botName` to constrain which bot's reply we're waiting for,
 * and `opts.marker` to require a specific substring from the model.
 */
export async function waitForModelTextReply(
  agent: PlaywrightAgent,
  opts?: { botName?: string; marker?: string; timeoutMs?: number },
): Promise<void> {
  const senderClause = opts?.botName ? `来自 ${opts.botName} 的` : '来自机器人的';
  if (opts?.marker) {
    // Marker match is an unambiguous gold standard — if this exact,
    // timestamped string appears inside a bubble sent by the bot, we know
    // the model really invoked `botmux send` as instructed. Skip the
    // "not a system message" heuristics entirely.
    await agent.aiWaitFor(
      `主内容区正在显示的测试话题里出现一条${senderClause}独立文本气泡（不是流式卡片、不是仓库选择卡），` +
        `气泡正文中包含这一串字符"${opts.marker}"（该字符串是为本次测试生成的、带时间戳的唯一 ACK 标识，` +
        '在 Feishu 客户端里一定会完整渲染出来，不要跟"已收到"这类系统提示混淆）',
      { timeoutMs: opts?.timeoutMs ?? 180_000, checkIntervalMs: 5_000 },
    );
    return;
  }
  await agent.aiWaitFor(
    `主内容区正在显示的测试话题底部出现一条${senderClause}由模型自然生成的普通文本回复消息；` +
      '这条消息必须是独立的文本气泡（不是"启动中…"/"工作中"/"等待输入"/"正在分析…"的流式卡片），' +
      '并且正文至少包含一段完整的自然语言句子（中文或英文都可），' +
      '明显是模型对用户问题的回答或交互，而不是"项目仓库管理"、"继续使用当前仓库"、' +
      '"已直接开启会话"、"会话已关闭"、"🕐 定时任务"、"✅ 定时任务已创建"、"已收到"、' +
      '"没能确认提交"、"可能卡在输入框里"这类 botmux 系统提示或控制消息',
    { timeoutMs: opts?.timeoutMs ?? 180_000, checkIntervalMs: 5_000 },
  );
}

/**
 * @deprecated 使用 waitForModelTextReply 代替，命名更准确
 */
export async function assertActualBotTextReply(
  agent: PlaywrightAgent,
  botName: BotName,
): Promise<void> {
  await waitForModelTextReply(agent, { botName, timeoutMs: 180_000 });
}

export async function waitForCodexSideResponse(
  agent: PlaywrightAgent,
  opts?: { marker?: string; timeoutMs?: number },
): Promise<void> {
  if (opts?.marker) {
    await agent.aiWaitFor(
      `主内容区正在显示的测试话题里出现一条来自 Codex 或机器人的独立文本气泡（不是流式卡片、不是仓库选择卡、绝对不是用户自己发出的提问消息），` +
        `气泡正文中必须同时包含"【MOCK-REPLY】"和"${opts.marker}"（"【MOCK-REPLY】"是模型回复专用的固定前缀，用户提问中绝无此标记），` +
        '不要把流式卡片标题或用户提问误认为回复',
      { timeoutMs: opts?.timeoutMs ?? 180_000, checkIntervalMs: 5_000 },
    );
    return;
  }
  await agent.aiWaitFor(
    '主内容区正在显示的测试话题中，当前测试话题已经收到 Codex 侧响应：' +
      '要么来自 Codex 的独立文本气泡回复，' +
      '要么来自 Codex 的回复或流式卡片正文明确包含 usage limit、rate limit、Approaching rate limits、Switch to gpt-5.4-mini 或 lower credit usage 这类额度/限流/模型切换提示；' +
      '同时当前测试话题中没有出现"没能确认提交"或"可能卡在输入框里"的 botmux 提交失败警告',
    { timeoutMs: opts?.timeoutMs ?? 180_000, checkIntervalMs: 5_000 },
  );
}

/**
 * Wait until `text` occurs at least `min` times in the rendered page text,
 * including parts scrolled out of view. Use it for replies above the fold that a
 * screenshot cannot see. An ACK marker also appears inside the prompt that asked
 * for it, so a reply needs `min: 2`. That holds only while the topic-list
 * preview cannot show this marker, so check the newest marker visually instead.
 */
export async function waitForPageTextCount(
  page: Page,
  text: string,
  min: number,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = await pageTextCount(page, text);
    if (count >= min) return;
    await page.waitForTimeout(2_000);
  }
  throw new Error(`"${text}" appeared ${count} time(s), expected at least ${min}`);
}

/**
 * Scroll the conversation on the right (chat, topic detail or session group),
 * not whatever sits under the mouse. After a click in the 「话题」 list the
 * mouse rests on that list, and a bare wheel scrolled it instead of the topic:
 * replies below the fold — the repo card included — never rendered, so
 * 「直接开启会话」 was never clicked and the session never started.
 */
export async function scrollConversation(page: Page, deltaY = 2_000): Promise<void> {
  const viewport = page.viewportSize() ?? BROWSER_CONFIG.viewport;
  await page.mouse.move(Math.round(viewport.width * 0.68), Math.round(viewport.height * 0.5));
  await page.mouse.wheel(0, deltaY);
  await revealNewMessages(page);
}

// 「⌄ 1 条新消息」: the chevron may render as text or as an icon.
const NEW_MESSAGES_PILL = /^[^\d]{0,3}\d+\s*条新消息\s*$/;

/**
 * Click Feishu's 「⌄ N 条新消息」 pill. A topic view does not render replies
 * that arrive while it is open until this is clicked: CI showed a topic
 * reading 「1 条话题回复」 with an empty body, the repo card never in the DOM,
 * so 「直接开启会话」 could not be clicked by any means.
 */
export async function revealNewMessages(page: Page): Promise<boolean> {
  const pills = page.getByText(NEW_MESSAGES_PILL);
  const count = await pills.count().catch(() => 0);
  let seen = false;
  for (let i = 0; i < count; i++) {
    const pill = pills.nth(i);
    if (!(await pill.isVisible().catch(() => false))) continue;
    seen = true;
    // Click by coordinates: locator.click() waits for the pill to be "stable",
    // and CI never got past that — the pill stayed up with the card unloaded.
    const box = await pill.boundingBox().catch(() => null);
    try {
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      else await pill.click({ force: true, timeout: 2_000 });
    } catch (error) {
      console.warn(`[e2e] Clicking 「新消息」 failed: ${(error as Error).message.split('\n')[0]}`);
    }
    await page.waitForTimeout(800);
  }
  return seen;
}

/** Occurrences of `text` in the rendered page text, including off-screen parts. */
/**
 * Text nodes on the page that hold `marker` outside the prompt asking for it.
 * The prompt quotes the same ACK inside its instruction (「请立刻调用 botmux
 * send …」), and the chat list previews it; the reply bubble only carries the
 * marker, possibly after an @mention in its own element.
 */
export async function replyMarkerCount(page: Page, marker: string): Promise<number> {
  return page.evaluate((wanted) => {
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = (walker.currentNode as Text).data;
      if (text.includes(wanted) && !text.includes('请立刻调用') && !text.includes('请在最终回复中')) count += 1;
    }
    return count;
  }, marker);
}

/** Wait until the bot's reply carrying `marker` is on the page (replyMarkerCount). */
export async function waitForReplyMarker(page: Page, marker: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await replyMarkerCount(page, marker).catch(() => 0)) > 0) return;
    await scrollConversation(page);
    await page.waitForTimeout(3_000);
  }
  throw new Error(`No reply carrying "${marker}" outside the prompt appeared within ${timeoutMs}ms`);
}

export async function pageTextCount(page: Page, text: string): Promise<number> {
  return (await page.locator('body').innerText()).split(text).length - 1;
}

/**
 * Click the 「直接开启会话」 button of the repo card that follows `anchor` (the
 * probe's tag). Only the button label counts — the bot's status message
 * 「▶️ 已直接开启会话（工作目录：.）」 also contains the words, and CI "clicked"
 * that while the topic's real card kept waiting for repo selection. Among
 * visible buttons, the nearest one below the visible anchor wins, so an
 * earlier conversation's card is never restarted.
 */
export const DIRECT_START_LABEL = /^\s*(▶️\s*)?直接开启会话\s*$/;

export async function clickDirectStartAfter(page: Page, anchor: string): Promise<boolean> {
  try {
    const anchors = page.getByText(anchor, { exact: false });
    const anchorBoxes = [];
    for (let i = 0; i < (await anchors.count()); i++) {
      const box = await anchors.nth(i).boundingBox().catch(() => null);
      if (box && box.width > 0) anchorBoxes.push(box);
    }
    if (anchorBoxes.length === 0) return false;
    const buttons = page.getByText(DIRECT_START_LABEL);
    const candidates: { index: number; distance: number }[] = [];
    for (let i = 0; i < (await buttons.count()); i++) {
      const box = await buttons.nth(i).boundingBox().catch(() => null);
      if (!box || box.width === 0) continue;
      let nearest = Infinity;
      for (const anchorBox of anchorBoxes) {
        const distance = box.y - anchorBox.y;
        // Below this anchor, in the same column (topic panel vs chat).
        const sameColumn = box.x + box.width > anchorBox.x && box.x < anchorBox.x + anchorBox.width + 400;
        if (distance > 0 && sameColumn) nearest = Math.min(nearest, distance);
      }
      if (nearest < Infinity) candidates.push({ index: i, distance: nearest });
    }
    // Nearest first, but a hidden copy (group topic views keep cached ones)
    // must not block the visible card: CI never clicked the real button.
    candidates.sort((a, b) => a.distance - b.distance);
    for (const { index } of candidates) {
      const button = buttons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      try {
        await button.scrollIntoViewIfNeeded({ timeout: 3_000 });
        await button.click({ timeout: 3_000 });
        return true;
      } catch {
        // Try the next candidate.
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Wait until `line` occurs at least `min` times in the page (a recall line
 * exists only in the reply: `min` 1; an ACK marker also sits in its prompt:
 * `min` 2). On the way, clicks the repo card the bot may post first — both
 * Claude and Codex do when the session has no pinned working directory.
 */
/**
 * Why the watched view looks stale, or '' when it does not: a 「新消息」 pill
 * that stays up, the probe itself missing from the page, or — once, before any
 * re-open — nothing at all after 100s: no reply and no repo card to click.
 * CI saw a group view keep the probe on screen while the bot's repo card and
 * reply, both sent within seconds, never rendered.
 */
export function staleViewReason(state: {
  now: number;
  started: number;
  pillSince: number | null;
  anchorGoneSince: number | null;
  cardVisible: boolean;
  reopened: number;
  anchor: string;
}): string {
  if (state.pillSince !== null && state.now - state.pillSince > 25_000) return '「新消息」 pill stayed up';
  if (state.anchorGoneSince !== null && state.now - state.anchorGoneSince > 45_000) {
    return `"${state.anchor}" is not on the page`;
  }
  if (state.reopened === 0 && !state.cardVisible && state.now - state.started > 100_000) {
    return 'no reply or repo card after 100s';
  }
  return '';
}

export async function waitForReplyLine(
  page: Page,
  line: string,
  opts?: {
    min?: number;
    timeoutMs?: number;
    anchor?: string;
    agent?: PlaywrightAgent;
    /**
     * Re-open the view being watched, when it stopped updating: a 「新消息」
     * pill stays up after being clicked, or the probe itself is not on the
     * page. CI saw a group view stuck on 「正在加载…」 below an older message
     * for four minutes while the bot's reply sat in the chat-list preview; a
     * view opened after the reply arrived renders it.
     */
    reopen?: () => Promise<void>;
  },
): Promise<void> {
  const min = opts?.min ?? 1;
  const timeoutMs = opts?.timeoutMs ?? 240_000;
  // `ACK-<tag> …` → the probe's tag, which its prompt contains. Other reply
  // shapes pass the prompt text the repo card follows.
  const anchor = opts?.anchor ?? line.split(/\s+/)[0].replace(/^ACK-/, '');
  const started = Date.now();
  const deadline = started + timeoutMs;
  let clicks = 0;
  let lastClick = 0;
  let visionClicked = false;
  let pillSince: number | null = null;
  let anchorGoneSince: number | null = null;
  let reopened = 0;
  let count = 0;
  while (Date.now() < deadline) {
    count = await pageTextCount(page, line);
    if (count >= min) return;
    const pillUp = await anyVisible(page.getByText(NEW_MESSAGES_PILL));
    pillSince = pillUp ? pillSince ?? Date.now() : null;
    const anchorShown = (await pageTextCount(page, anchor)) > 0;
    anchorGoneSince = anchorShown ? null : anchorGoneSince ?? Date.now();
    const stale = staleViewReason({
      now: Date.now(),
      started,
      pillSince,
      anchorGoneSince,
      cardVisible: await anyVisible(page.getByText(DIRECT_START_LABEL)),
      reopened,
      anchor,
    });
    if (stale && opts?.reopen && reopened < 2) {
      reopened += 1;
      pillSince = null;
      anchorGoneSince = null;
      console.warn(`[e2e] ${stale}; re-opening the view (${reopened}/2)`);
      try {
        await opts.reopen();
      } catch (error) {
        console.warn(`[e2e] Re-opening the view failed: ${(error as Error).message.split('\n')[0]}`);
      }
      continue;
    }
    // Last resort when a visible repo card still waits after the DOM tries.
    if (
      opts?.agent &&
      !visionClicked &&
      Date.now() - started > 45_000 &&
      (await anyVisible(page.getByText(DIRECT_START_LABEL)))
    ) {
      visionClicked = true;
      try {
        await opts.agent.aiAct(
          '点击当前打开的话题（或会话）里「项目仓库管理」卡片上的"▶️ 直接开启会话"按钮；只点这一张卡片上的按钮',
        );
        clicks += 1;
        lastClick = Date.now();
      } catch (error) {
        // The DOM loop keeps trying.
        console.warn(`[e2e] Vision click on 直接开启会话 failed: ${(error as Error).message.split('\n')[0]}`);
      }
    }
    // A click that did not register leaves the button in place; a started
    // session replaces it, so the exact-label match finds nothing more.
    if (clicks < 3 && Date.now() - lastClick > 20_000 && (await clickDirectStartAfter(page, anchor))) {
      clicks += 1;
      lastClick = Date.now();
    }
    await scrollConversation(page);
    await page.waitForTimeout(3_000);
  }
  const diagnosis = await repoCardDiagnosis(page, anchor);
  const message =
    `Reply "${line}" appeared ${count} time(s) within ${timeoutMs}ms, expected ${min}` +
    ` (clicked 直接开启会话 ${clicks}×; re-opened ${reopened}×; ${diagnosis})`;
  if (opts?.agent) await recordFailureState(opts.agent, page, anchor, message);
  throw new Error(message);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Send a command and wait for the bot's answer to it: text matching `pattern`
 * that appears after the last echo of `command` (the user's bubble, or the
 * quote in the bot's reply). Returns the match. DOM order instead of counts,
 * because older messages drop out of Feishu's partial rendering. With
 * `reopen`, a view that shows nothing by half time is opened again once: CI
 * saw a mode restore fail three times while the bot had answered each within
 * a second, because the group view had stopped rendering new messages.
 */
export async function sendAndAwaitReply(
  page: Page,
  send: () => Promise<void>,
  command: string,
  pattern: RegExp,
  timeoutMs = 60_000,
  reopen?: () => Promise<void>,
): Promise<RegExpMatchArray> {
  const echo = new RegExp(`${escapeRegExp(command.trim())}[ \\t]*\\n`, 'g');
  await send();
  const started = Date.now();
  const deadline = started + timeoutMs;
  let reopened = false;
  while (Date.now() < deadline) {
    const body = await page.locator('body').innerText();
    const echoes = [...body.matchAll(echo)];
    const after = echoes.length > 0 ? body.slice(echoes.at(-1)!.index! + echoes.at(-1)![0].length) : '';
    const match = after.match(pattern);
    if (match) return match;
    if (reopen && !reopened && Date.now() - started > timeoutMs / 2) {
      reopened = true;
      console.warn(`[e2e] No reply to "${command}" yet; re-opening the view`);
      try {
        await reopen();
      } catch (error) {
        console.warn(`[e2e] Re-opening the view failed: ${(error as Error).message.split('\n')[0]}`);
      }
      continue;
    }
    await scrollConversation(page);
    await page.waitForTimeout(2_000);
  }
  throw new Error(`No reply matching ${pattern} after "${command}" within ${timeoutMs}ms`);
}

/**
 * Scroll the newest occurrence of `text` into view and record a screenshot in
 * the Midscene report. For checks already decided by an exact DOM match: the
 * report should show the reply, but a vision assertion on top only adds
 * failures for replies that sit outside the viewport.
 */
export async function recordTextEvidence(
  agent: PlaywrightAgent,
  page: Page,
  text: string,
  title: string,
): Promise<void> {
  try {
    await page.getByText(text, { exact: false }).last().scrollIntoViewIfNeeded({ timeout: 5_000 });
    await page.waitForTimeout(800);
  } catch {
    // Evidence only; the DOM check already passed.
  }
  await agent.recordToReport(title, { content: text });
}

async function anyVisible(locator: ReturnType<Page['getByText']>): Promise<boolean> {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    if (await locator.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

/** What the page held when a reply never came: tells "no card" from "not clicked". */
async function repoCardDiagnosis(page: Page, anchor: string): Promise<string> {
  const buttons = page.getByText(DIRECT_START_LABEL);
  const total = await buttons.count().catch(() => 0);
  let visible = 0;
  for (let i = 0; i < total; i++) if (await buttons.nth(i).isVisible().catch(() => false)) visible += 1;
  const anchors = await page.getByText(anchor, { exact: false }).count().catch(() => 0);
  const pills = await page.getByText(NEW_MESSAGES_PILL).count().catch(() => 0);
  return `repo card buttons ${visible} visible / ${total} total, anchor matches ${anchors}, new-message pills ${pills}`;
}

/**
 * Screenshot the page at the moment a check fails, named so the report picks
 * it as the case preview — later clean-up steps would otherwise supply it.
 */
export async function recordFailureState(
  agent: PlaywrightAgent,
  page: Page,
  anchor: string,
  detail: string,
): Promise<void> {
  try {
    await page.getByText(anchor, { exact: false }).last().scrollIntoViewIfNeeded({ timeout: 3_000 });
  } catch {
    // Keep whatever is on screen.
  }
  await agent.recordToReport('失败现场', { content: detail }).catch(() => {});
}

/** A `reopen` for waitForReplyLine: reload Messenger and open the topic of `msg` again. */
export function reopenTopic(agent: PlaywrightAgent, page: Page, msg: string): () => Promise<void> {
  return async () => {
    await navigateToMessenger(page);
    await openThreadForMessage(agent, { msgHint: msg, page, timeoutMs: 90_000 });
  };
}

/** Assert no reply carrying `line` appears for `waitMs`. */
export async function expectNoReplyLine(page: Page, line: string, waitMs = 45_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if ((await pageTextCount(page, line)) > 0) {
      throw new Error(`Unexpected reply "${line}" appeared`);
    }
    await page.waitForTimeout(3_000);
  }
}

/**
 * Scroll the thread panel to the bottom to reveal the latest replies.
 * Call this before asserting on bot replies in the thread, because
 * the panel doesn't always auto-scroll to show new messages.
 */
export async function scrollThreadToBottom(
  agent: PlaywrightAgent,
): Promise<void> {
  await agent.aiAct(
    '滚动主内容区（页面右侧大块、宽版非窄侧栏）当前正在显示的测试话题到底部，显示最新回复和回复输入框',
  );
}

/**
 * Close the current session by clicking the "❌ 关闭会话" button
 * in the thread panel. Call this in afterAll/afterEach to clean up.
 * Silently ignores failures (session might already be closed).
 */
export async function closeSession(
  agent: PlaywrightAgent,
  page: Page,
): Promise<void> {
  try {
    // Use Playwright for teardown so a slow Midscene locate call cannot hold
    // the whole suite open after the test body has already finished.
    await scrollConversation(page);
    await page.waitForTimeout(500);
    const closeButton = page.getByText('关闭会话').last();
    await closeButton.click({ timeout: 5_000 });
    await page.getByText('会话已关闭').last().waitFor({ timeout: 15_000 });
  } catch {
    // Session already closed or button not visible — ignore
  }
}

/**
 * Send a reply within the currently open thread panel.
 * Used for commands like /close, /schedule, /repo within a thread.
 */
export async function sendThreadReply(
  agent: PlaywrightAgent,
  page: Page,
  message: string,
): Promise<void> {
  // Scroll to bottom first to ensure the reply input is visible
  await scrollThreadToBottom(agent);
  await agent.aiAct(
    `在主内容区正在显示的测试话题最底部的回复输入框中输入 "${message}" 然后按 Enter 发送`,
  );
}

/**
 * Type a reply into the open topic with real key presses. Slash commands go
 * through this instead of `sendThreadReply`: the daemon parses the literal
 * text, so a visual agent that retypes, quotes or translates it would test the
 * wrong input.
 */
export async function typeThreadReply(
  agent: PlaywrightAgent,
  page: Page,
  text: string,
): Promise<void> {
  await scrollThreadToBottom(agent);
  await sendTyped(
    page,
    topicReplyFocus(page, agent),
    text,
    30,
  );
}

/**
 * Generate a unique test message. We tell the bot to emit a unique,
 * timestamped ACK marker via `botmux send`, which guarantees that (a)
 * there IS a standalone text bubble from the model and (b) we can match
 * on an unambiguous string instead of heuristically distinguishing "real
 * reply" from "已收到 system toast".
 *
 * Callers that supply their own natural-language instructions (collab,
 * codex-marker) or expect NO reply (no-mention) should pass
 * `{ plain: true }` to get just the tag.
 */
export function testMessage(label?: string, opts?: { plain?: boolean }): string {
  const ts = Date.now();
  const tag = label ? `e2e-${label}-${ts}` : `e2e-test-${ts}`;
  if (opts?.plain) return tag;
  const marker = `ACK-${tag}`;
  return (
    `${tag} ` +
    `请立刻调用 botmux send 在本话题里回复一行内容："${marker}"（原样复制这一串 ASCII 字符，不要翻译、不要改动、不要加引号或额外文字）。` +
    '做完这一步就结束本轮工作，不要再做别的操作。'
  );
}

/**
 * A follow-up for the same topic that asks the model to repeat the ACK marker
 * of the topic's first message. Only a session that still holds the earlier
 * turn can answer, so the reply proves context continuity. The token lets the
 * mock LLM recognise the request; a real model follows the instruction text.
 */
export function followUpMessage(label: string): string {
  const tag = `e2e-${label}-${Date.now()}`;
  const marker = `ACK-${tag}`;
  return (
    `${tag} ${RECALL_FIRST_MARKER_TOKEN} ` +
    `请立刻调用 botmux send 在本话题里回复一行内容："${marker} RECALL <本话题第一条消息要求你回复的那串 ACK- 开头的标记>"` +
    '（尖括号部分替换成那串标记原文，其余原样保留，不要加引号或额外文字）。做完这一步就结束本轮工作。'
  );
}

/** The reply line `followUpMessage()` expects after `firstMsg` opened the topic. */
export function expectedRecallMarker(followUp: string, firstMsg: string): string {
  return `${expectedReplyMarker(followUp)} RECALL ${expectedReplyMarker(firstMsg)}`;
}

/** The bare `e2e-<label>-<ts>` tag portion of a `testMessage()` value — useful for UI/locator matching. */
export function messageTag(msg: string): string {
  const m = msg.match(/^(e2e-[^\s]+)/);
  return m ? m[1] : msg;
}

/**
 * The unique ACK string the bot is instructed to emit in reply to
 * `testMessage(label)`. Pass this as `marker` to `waitForModelTextReply`
 * so the gate matches an unambiguous, timestamped string instead of
 * heuristically classifying natural-language text.
 */
export function expectedReplyMarker(msg: string): string {
  return `ACK-${messageTag(msg)}`;
}
