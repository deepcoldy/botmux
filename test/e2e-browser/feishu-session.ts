/**
 * The one way suites open and close their Feishu browser session.
 *
 * Two paths, kept apart on purpose:
 * - setup fails half-way (openFeishuSession): release what was built and
 *   rethrow — never pressing 关闭会话, because that screen is not this case's
 *   chat (CI: a restored topic of another lane's session);
 * - a session beforeAll finished (releaseFeishuSession with closeBotSession):
 *   close the case's bot session first, then the browser.
 * Every teardown step runs even when an earlier one throws (session-setup.ts).
 */
import { existsSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { PlaywrightAgent } from '@midscene/web/playwright';
import { publishLabeledPageVideo } from './e2e-video.js';
import {
  checkPrerequisites,
  closeSession,
  createAgent,
  createBrowser,
  createPage,
  navigateToMessenger,
  STORAGE_STATE_PATH,
} from './helpers.js';
import { buildSession, releaseAll } from './session-setup.js';

export interface FeishuSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  agent: PlaywrightAgent;
}

/** Chromium, Messenger, then `enter` (the case's chat: openChat / openGroupChat). */
export async function openFeishuSession(
  enter?: (page: Page, agent: PlaywrightAgent) => Promise<void>,
): Promise<FeishuSession> {
  checkPrerequisites();
  if (!existsSync(STORAGE_STATE_PATH)) {
    throw new Error('storageState.json not found. Run: bun run test:e2e-browser:setup');
  }
  return buildSession<FeishuSession>(
    {},
    async (s) => {
      s.browser = await createBrowser();
      const { context, page } = await createPage(s.browser);
      s.context = context;
      s.page = page;
      s.agent = createAgent(page);
      await navigateToMessenger(page);
      if (enter) await enter(page, s.agent);
    },
    (s) => releaseFeishuSession(s, { closeBotSession: false, publishVideo: true }),
  );
}

/**
 * Close a session. `closeBotSession` presses the case's 关闭会话 first: only
 * for a session whose chat beforeAll actually opened.
 */
export async function releaseFeishuSession(
  session: Partial<FeishuSession>,
  opts: { closeBotSession: boolean; publishVideo: boolean },
): Promise<void> {
  const { agent, page } = session;
  await releaseAll([
    () => (opts.closeBotSession && agent && page ? closeSession(agent, page) : undefined),
    () => agent?.destroy(),
    // Closing the context closes the page, which releases its chat leases and
    // saves the page video published below.
    () => session.context?.close(),
    () => (opts.publishVideo ? publishLabeledPageVideo(page) : undefined),
    () => session.browser?.close(),
  ]);
}
