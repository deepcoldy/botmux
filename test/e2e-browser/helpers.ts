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

export function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required env var: ${key}. Copy .env.example to .env and fill in values.`,
    );
  }
  return value;
}

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
