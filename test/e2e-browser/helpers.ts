import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

export const STORAGE_STATE_PATH = path.join(PROJECT_ROOT, 'storageState.json');

export const BROWSER_CONFIG = {
  viewport: { width: 1920, height: 1080 } as const,
  deviceScaleFactor: 1,
  locale: 'zh-CN',
};

/** All bot display names available for testing (except Gemini). */
export const BOT_NAMES = ['Claude', 'CoCo', 'Codex', 'OpenCode', 'Aiden'] as const;
export type BotName = (typeof BOT_NAMES)[number];

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

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
  const contextOpts: Record<string, unknown> = {
    viewport: BROWSER_CONFIG.viewport,
    deviceScaleFactor: BROWSER_CONFIG.deviceScaleFactor,
    locale: BROWSER_CONFIG.locale,
  };
  if (existsSync(STORAGE_STATE_PATH)) {
    contextOpts.storageState = STORAGE_STATE_PATH;
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  return { context, page };
}

export function createAgent(page: Page): PlaywrightAgent {
  return new PlaywrightAgent(page);
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** Navigate to the messenger page and wait for it to load. */
export async function navigateToMessenger(page: Page): Promise<void> {
  await page.goto(getMessengerUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
}

/**
 * Open a specific chat by clicking its entry in the left sidebar.
 * Works for both bot private chats ("Claude") and group chats.
 * Falls back to Feishu search (Ctrl+K) if not visible in sidebar.
 */
export async function openChat(
  page: Page,
  agent: PlaywrightAgent,
  chatName: string,
): Promise<void> {
  // Try clicking directly first
  try {
    await agent.aiAct(
      `在左侧"消息"列表中或者"消息"列表的置顶会话中，点击名称完全匹配"${chatName}"的对话（群聊或私聊入口，不是话题里的消息）`,
    );
  } catch {
    // Chat not visible in sidebar — use search to find it
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(1000);
    await page.keyboard.type(chatName);
    await page.waitForTimeout(2000);
    await agent.aiAct(
      `在搜索结果中，点击名称为"${chatName}"的群聊或对话`,
    );
    // Close search overlay if still open
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  // Wait for chat to load — verify by checking the chat header
  await agent.aiWaitFor(
    `右侧聊天区域顶部标题栏显示"${chatName}"`,
    { timeoutMs: 15_000, checkIntervalMs: 3_000 },
  );
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/** Send a plain text message in the currently open chat. */
export async function sendMessage(
  agent: PlaywrightAgent,
  message: string,
): Promise<void> {
  await agent.aiAct(
    `在底部消息输入框中输入 "${message}" 然后按 Enter 发送`,
  );
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
  // Click into the input box
  await agent.aiAct('点击底部的消息输入框');
  // Type @ to trigger mention dropdown
  await page.keyboard.type('@');
  await page.waitForTimeout(1000);
  // Type bot name to filter the dropdown, then select
  await agent.aiAct(
    `在弹出的@提及搜索列表中，找到并点击"${botName}"`,
  );
  await page.waitForTimeout(500);
  // Type the rest of the message and send
  await page.keyboard.type(` ${message}`);
  await page.keyboard.press('Enter');
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

export async function waitForIdleOrCodexUsageLimit(
  agent: PlaywrightAgent,
  opts?: { timeoutMs?: number },
): Promise<'idle' | 'codex-usage-limit'> {
  await agent.aiWaitFor(
    '主内容区正在显示的测试话题最底部，当前 Codex 会话已经进入可验证的结束态：' +
      '要么最新流式卡片标题包含"等待输入"，要么最新 Codex 回复或卡片正文明确包含 usage limit、rate limit、Approaching rate limits、Switch to gpt-5.4-mini 或 lower credit usage 这类额度/限流/模型切换提示；' +
      '不要把左侧话题列表预览或历史旧话题当作当前会话结果',
    { timeoutMs: opts?.timeoutMs ?? 120_000, checkIntervalMs: 5_000 },
  );

  const isUsageLimited = await agent.aiBoolean(
    '主内容区正在显示的测试话题最底部，当前 Codex 会话的最新回复或最新流式卡片正文明确包含 usage limit、rate limit、Approaching rate limits、Switch to gpt-5.4-mini 或 lower credit usage 这类额度/限流/模型切换提示',
  );
  return isUsageLimited ? 'codex-usage-limit' : 'idle';
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

  // Step 5: Wait for streaming card.
  await agent.aiWaitFor(
    '主内容区正在显示的测试话题里出现当前会话的流式卡片；' +
      '卡片必须带有"显示输出"、"打开终端"、"获取操作链接"或"关闭会话"这类会话操作按钮；' +
      '卡片标题包含"启动中"、"工作中"、"等待输入"或"正在分析"之一，或正文已经出现 Codex 的 usage/rate limit/model switch 提示；' +
      '"项目仓库管理"和"直接开启会话"的仓库选择卡不能算作流式卡片',
    { timeoutMs, checkIntervalMs: 5_000 },
  );
}

/**
 * Open a test topic by switching to the 「话题」filter tab and clicking the
 * entry whose preview contains the test-message tag. After this call, the
 * topic is shown in the wide main content area (not the narrow right-side
 * thread panel), which is far more reliable for subsequent assertions and
 * button clicks.
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

  // Step 1: Switch to the 「话题」filter tab on the left-middle column.
  // After this, the middle column shows the topic list (not the message list).
  await agent.aiAct(
    '点击飞书左侧中间那一列顶部的"话题"筛选入口（图标是📇/方框，文字就是"话题"两个字）。' +
      '不要点"话题群"、不要点"消息"、不要点"@我"、不要点"未读"、也不要点"标签"。' +
      '点击后，中间那一列应切换成"话题"列表',
  );
  await agent.aiWaitFor(
    '左侧中间那一列顶部显示当前筛选是"话题"（比如标题栏显示"话题"二字），' +
      '并且中间列是一个话题条目列表（而不是普通的"消息"列表）',
    { timeoutMs: 15_000, checkIntervalMs: 2_000 },
  );

  // Step 2 + 3: Find and click the topic. Feishu's topic list visually
  // truncates previews to ~6-10 chars, so the AI can't reliably match the
  // full tag. Playwright's DOM locator sees the full text even when it's
  // clipped by CSS, so we use it when page is available.
  const page = opts?.page;
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

  // Step 4: Confirm the topic is loaded in the wide main area. This is the
  // anchor point for every subsequent assertion — subsequent prompts refer
  // to "主内容区正在显示的测试话题".
  await agent.aiWaitFor(
    `页面右侧主内容区（宽版，占据页面大部分空间，不是那一条窄的侧栏）已经打开包含"${tag}"的测试话题；` +
      '区域内可见该测试消息，以及下方的机器人相关内容（普通文本气泡、"项目仓库管理"卡、"直接开启会话"按钮或流式卡片之一）',
    { timeoutMs: 20_000, checkIntervalMs: 3_000 },
  );

  await scrollThreadToBottom(agent);
}

export async function clickDirectStartIfPresent(
  agent: PlaywrightAgent,
  page?: Page,
): Promise<void> {
  if (page) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const directStart = page.getByText('直接开启会话').last();
        await directStart.scrollIntoViewIfNeeded({ timeout: 3_000 });
        await directStart.click({ timeout: 3_000 });
        await page.waitForTimeout(1000);
        return;
      } catch {
        await page.mouse.wheel(0, 1200);
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
  const needShow = await agent.aiBoolean(
    '主内容区正在显示的测试话题最底部，当前会话的流式卡片操作按钮中有"📖 显示输出"按钮',
  );
  if (needShow) {
    try {
      await page
        .getByRole('button', { name: /显示输出/ })
        .last()
        .click({ timeout: 5_000 });
    } catch {
      await agent.aiAct(
        '点击主内容区正在显示的测试话题最底部，当前会话流式卡片里的"📖 显示输出"按钮；不要点击"打开终端"按钮',
      );
    }
    await page.waitForTimeout(2000);
  }
  await agent.aiAssert(
    '主内容区正在显示的测试话题最底部，当前会话的流式卡片操作按钮中有"📕 隐藏输出"，' +
      '并且卡片正文显示终端截图、终端区域，或"等待第一张截图"占位',
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
  const markerClause = opts?.marker
    ? `要么来自 Codex 的回复包含"${opts.marker}"，`
    : '';
  await agent.aiWaitFor(
    `主内容区正在显示的测试话题中，当前测试话题已经收到 Codex 侧响应：${markerClause}` +
      '要么来自 Codex 的回复或流式卡片正文明确包含 usage limit、rate limit、Approaching rate limits、Switch to gpt-5.4-mini 或 lower credit usage 这类额度/限流/模型切换提示；' +
      '同时当前测试话题中没有出现"没能确认提交"或"可能卡在输入框里"的 botmux 提交失败警告',
    { timeoutMs: opts?.timeoutMs ?? 180_000, checkIntervalMs: 5_000 },
  );
}

/**
 * Scroll the thread panel to the bottom to reveal the latest replies.
 * Call this before asserting on bot replies in the thread, because
 * the panel doesn't always auto-scroll to show new messages.
 */
export async function scrollThreadToBottom(
  agent: PlaywrightAgent,
): Promise<void> {
  await agent.aiScroll(
    '主内容区（页面右侧大块、宽版非窄侧栏）当前正在显示的测试话题',
    { direction: 'down', scrollType: 'untilBottom' },
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
    await page.mouse.wheel(0, 2000);
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
