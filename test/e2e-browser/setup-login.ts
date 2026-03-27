import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  checkPrerequisites,
  STORAGE_STATE_PATH,
  getRequiredEnv,
  BROWSER_CONFIG,
} from './helpers.js';

/**
 * Resolve the CDP endpoint for an already-running browser.
 *
 * Priority:
 *   1. BROWSER_CDP_URL env var (explicit)
 *   2. Agent Browser's DevToolsActivePort file (auto-detect)
 */
function resolveCdpEndpoint(): string | undefined {
  if (process.env.BROWSER_CDP_URL) return process.env.BROWSER_CDP_URL;

  // Auto-detect Agent Browser
  const dtFile = path.join(
    process.env.HOME ?? '/root',
    '.agent-browser/default-profile/DevToolsActivePort',
  );
  if (existsSync(dtFile)) {
    const lines = readFileSync(dtFile, 'utf-8').trim().split('\n');
    if (lines[0]) {
      const port = lines[0].trim();
      return `http://127.0.0.1:${port}`;
    }
  }
  return undefined;
}

async function saveFromCdp(cdpUrl: string) {
  console.log(`Connecting to existing browser via CDP: ${cdpUrl}`);
  const browser = await chromium.connectOverCDP(cdpUrl);

  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('No browser contexts found. Is the browser open?');
  }

  // Use the first context (default profile)
  const context = contexts[0];
  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log(`Session saved to: ${STORAGE_STATE_PATH}`);
  console.log('You can now run: pnpm test:e2e-browser');

  // Don't close — it's an external browser
}

async function saveFromHeadedBrowser() {
  const groupUrl = getRequiredEnv('FEISHU_TEST_GROUP_URL');
  const url = new URL(groupUrl);
  const loginUrl = `${url.origin}/next/messenger`;

  console.log(`Opening browser at: ${loginUrl}`);
  console.log(
    'Please log in manually. The script will detect login and save session.\n',
  );

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: BROWSER_CONFIG.viewport,
    deviceScaleFactor: BROWSER_CONFIG.deviceScaleFactor,
    locale: BROWSER_CONFIG.locale,
  });
  const page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  console.log('Waiting for login to complete...');

  try {
    await page.waitForURL('**/next/messenger/**', { timeout: 300_000 });
    await page.waitForTimeout(3000);

    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`\nSession saved to: ${STORAGE_STATE_PATH}`);
    console.log('You can now run: pnpm test:e2e-browser');
  } catch {
    console.error('\nLogin timed out (5 minutes). Please try again.');
    process.exit(1);
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('=== Feishu Login Setup ===\n');

  checkPrerequisites();

  const cdpUrl = resolveCdpEndpoint();
  if (cdpUrl) {
    await saveFromCdp(cdpUrl);
  } else {
    console.log(
      'No running browser detected. Launching headed browser for manual login.\n' +
        'Tip: set BROWSER_CDP_URL in .env to connect to an existing browser.\n',
    );
    await saveFromHeadedBrowser();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
