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

export function getGroupChatName(): string {
  return process.env.FEISHU_TEST_GROUP_CHAT_NAME ?? 'Agent群聊';
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
 * Works for both bot private chats ("Claude") and group chats ("Agent群聊").
 */
export async function openChat(
  agent: PlaywrightAgent,
  chatName: string,
): Promise<void> {
  await agent.aiAct(`在左侧聊天列表中，点击名称包含"${chatName}"的对话`);
  // Wait for chat to load
  await agent.aiWaitFor(`右侧聊天区域显示了与"${chatName}"的对话内容`, {
    timeoutMs: 10_000,
    checkIntervalMs: 2_000,
  });
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
 * After sending a message, the bot may show a repo selection card
 * ("项目仓库管理") before starting the CLI. This helper detects
 * and skips it by clicking "直接开启会话".
 * If no repo card appears (bot auto-selects), this is a no-op.
 */
export async function handleRepoSelection(agent: PlaywrightAgent): Promise<void> {
  try {
    await agent.aiWaitFor(
      '页面上出现了"项目仓库管理"卡片或包含"直接开启会话"按钮的卡片',
      { timeoutMs: 15_000, checkIntervalMs: 3_000 },
    );
    await agent.aiAct('点击"▶️ 直接开启会话"按钮');
  } catch {
    // No repo selection card appeared — bot auto-selected. Continue.
  }
}

/**
 * Full flow after sending a message: handle repo selection if needed,
 * then wait for the streaming card to appear.
 */
export async function waitForStreamingCard(
  agent: PlaywrightAgent,
  opts?: { timeoutMs?: number },
): Promise<void> {
  await handleRepoSelection(agent);
  await agent.aiWaitFor(
    '页面上出现了一个卡片，其标题中包含"启动中"或"工作中"或"就绪"字样',
    { timeoutMs: opts?.timeoutMs ?? 60_000, checkIntervalMs: 3_000 },
  );
}

/** Generate a unique test message with timestamp and optional label. */
export function testMessage(label?: string): string {
  const ts = Date.now();
  return label ? `e2e-${label}-${ts}` : `e2e-test-${ts}`;
}
