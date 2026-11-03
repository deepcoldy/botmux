import { createBotTest } from './bot-test-factory.js';
import { describe, it, beforeAll, afterAll } from './midscene-suite.js';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import {
  testMessage,
  sendMessage,
  openChat,
  openThreadForMessage,
  clickDirectStartIfPresent,
  scrollThreadToBottom,
  waitForCodexSideResponse,
} from './helpers.js';
import { openFeishuSession, releaseFeishuSession } from './feishu-session.js';

export function registerMidsceneSuites(): void {
  createBotTest('Codex', { allowCodexUsageLimitResponse: true });

  describe('Codex prompt submission', () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let agent: PlaywrightAgent;

    beforeAll(async () => {
      ({ browser, context, page, agent } = await openFeishuSession((p, a) => openChat(p, a, 'Codex')));
    });

    afterAll(async () => {
      await releaseFeishuSession({ browser, context, page, agent }, { closeBotSession: true, publishVideo: true });
    });

    it('submits the wrapped Codex prompt and receives a Codex-side response', async () => {
      const marker = `CODEX_E2E_MARKER_${Date.now()}`;
      // Plain tag — this test supplies its own marker instruction.
      const msg = `${testMessage('codex-marker', { plain: true })} 请在最终回复中原样包含 ${marker}`;

      await sendMessage(agent, msg, page);
      await openThreadForMessage(agent, { timeoutMs: 120_000, msgHint: msg, page });
      await clickDirectStartIfPresent(agent, page, { expectMs: 90_000 });

      await scrollThreadToBottom(agent);
      await waitForCodexSideResponse(agent, { marker, timeoutMs: 180_000 });
    }, 420_000);
  });
}
