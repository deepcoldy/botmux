import { createBotTest } from './bot-test-factory.js';
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
  sendMessage,
  navigateToMessenger,
  openChat,
  openThreadForMessage,
  clickDirectStartIfPresent,
  scrollThreadToBottom,
  waitForCodexSideResponse,
  closeSession,
} from './helpers.js';

createBotTest('Codex', { allowCodexUsageLimitResponse: true });

describe('Codex prompt submission', () => {
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
    await openChat(page, agent, 'Codex');
  });

  afterAll(async () => {
    await closeSession(agent, page);
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('submits the wrapped Codex prompt and receives a Codex-side response', async () => {
    const marker = `CODEX_E2E_MARKER_${Date.now()}`;
    // Plain tag — this test supplies its own marker instruction.
    const msg = `${testMessage('codex-marker', { plain: true })} 请在最终回复中原样包含 ${marker}`;

    await sendMessage(agent, msg);
    await openThreadForMessage(agent, { timeoutMs: 120_000, msgHint: msg, page });
    await clickDirectStartIfPresent(agent, page);

    await scrollThreadToBottom(agent);
    await waitForCodexSideResponse(agent, { marker, timeoutMs: 180_000 });
  }, 420_000);
});
