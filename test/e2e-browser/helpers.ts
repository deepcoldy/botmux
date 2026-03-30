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
      `在左侧聊天列表中，点击名称完全匹配"${chatName}"的对话（群聊或私聊入口，不是话题里的消息）`,
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
 * Wait for a streaming card to appear with a specific status.
 * Status values: "启动中…", "工作中", "就绪"
 */
export async function waitForCardStatus(
  agent: PlaywrightAgent,
  status: '启动中…' | '工作中' | '就绪',
  opts?: { timeoutMs?: number },
): Promise<void> {
  await agent.aiWaitFor(
    `页面上出现了一个卡片，其标题栏中包含"${status}"字样`,
    { timeoutMs: opts?.timeoutMs ?? 60_000, checkIntervalMs: 3_000 },
  );
}

/**
 * Full flow after sending a message:
 *  1. Wait for bot to respond (any reply in the thread)
 *  2. Click into the thread to see full card content
 *  3. Handle repo selection card if present ("直接开启会话")
 *  4. Wait for streaming card to appear
 *
 * IMPORTANT: In Feishu's main chat view, thread previews are collapsed.
 * Card buttons (like "直接开启会话") are only visible when you open
 * the thread panel. This function handles that navigation.
 *
 * @param msgHint - The test message text, used to click into the correct thread
 */
export async function waitForStreamingCard(
  agent: PlaywrightAgent,
  opts?: { timeoutMs?: number; msgHint?: string },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const msgText = opts?.msgHint ?? '';

  // Step 1: Wait for bot to respond to our message
  await agent.aiWaitFor(
    msgText
      ? `聊天中"${msgText}"消息下方出现了机器人的回复`
      : '聊天中出现了机器人的新回复',
    { timeoutMs, checkIntervalMs: 3_000 },
  );

  // Step 2: Click into the thread to see full card content.
  // IMPORTANT: In Feishu, newest messages are at the BOTTOM of the chat.
  // "最底部" = newest, "最顶部" = oldest. Always target the bottom-most element.
  if (msgText) {
    await agent.aiAct(
      `点击聊天中"${msgText}"消息区域或其"回复话题"链接，打开话题详情`,
    );
  } else {
    await agent.aiAct(
      '点击聊天区域最底部（最新的）那条消息的"回复话题"链接，打开话题详情',
    );
  }
  await agent.aiWaitFor('右侧出现了话题详情面板', {
    timeoutMs: 15_000,
    checkIntervalMs: 3_000,
  });

  // Step 3: Scroll thread panel to bottom to reveal latest content
  await scrollThreadToBottom(agent);

  // Step 4: Handle repo selection card if present.
  // The "项目仓库管理" card may take a moment to load. Try twice with scrolling.
  for (let attempt = 0; attempt < 2; attempt++) {
    const hasSkipButton = await agent.aiBoolean(
      '话题面板中可以看到"直接开启会话"或"▶️ 直接开启会话"按钮',
    );
    if (hasSkipButton) {
      await agent.aiAct(
        '点击话题面板中的"直接开启会话"按钮（可能带有▶️图标）',
      );
      break;
    }
    if (attempt === 0) {
      // Scroll down more — the card might not be visible yet
      await scrollThreadToBottom(agent);
    }
  }

  // Step 5: Wait for streaming card
  await agent.aiWaitFor(
    '话题面板中出现了标题包含"启动中"或"工作中"或"就绪"的流式卡片',
    { timeoutMs, checkIntervalMs: 5_000 },
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
    '右侧话题详情面板',
    { direction: 'down', scrollCount: 10 },
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
    // Scroll thread panel to bottom to reveal the close button
    await scrollThreadToBottom(agent);
    await page.waitForTimeout(500);
    await agent.aiAct('点击话题面板中的"❌ 关闭会话"按钮');
    // Scroll to bottom again and verify closure
    await scrollThreadToBottom(agent);
    await page.waitForTimeout(2000);
    await agent.aiWaitFor(
      '话题面板底部出现了"会话已关闭"或"✅ 会话已关闭"的消息',
      { timeoutMs: 15_000, checkIntervalMs: 3_000 },
    );
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
    `在右侧话题面板最底部的回复输入框中输入 "${message}" 然后按 Enter 发送`,
  );
}

/** Generate a unique test message with timestamp and optional label. */
export function testMessage(label?: string): string {
  const ts = Date.now();
  return label ? `e2e-${label}-${ts}` : `e2e-test-${ts}`;
}
