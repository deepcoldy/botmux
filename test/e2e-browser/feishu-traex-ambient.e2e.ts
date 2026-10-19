/**
 * TraeX「免 @，让位」(ambient) continuity:
 *
 * Field wedge: in busy ambient groups TraeX could redraw its composer and go
 * quiet before task_complete reached the rollout. The worker's post-terminal
 * composer fence then revoked prompt-ready with nothing left to re-check it,
 * so the turn never finished and every later message queued until someone
 * typed into the web terminal.
 *
 * Real-device flow: un-@ messages back-to-back in one topic, each sent as soon
 * as the previous ACK is visible (the turn boundary where the race lives).
 * Every round must get its own ACK and the card must settle to 「等待输入」.
 * The race is timing-dependent, so this is a regression smoke; the
 * deterministic repro lives in
 * test/traex-post-terminal-fence-wedge.repro.integration.test.ts.
 *
 * Requires a group where a TraeX bot runs with regularGroupMentionMode=ambient:
 *   FEISHU_TRAEX_AMBIENT_CHAT_NAME  group chat name
 *   FEISHU_TRAEX_BOT_NAME           bot display name in that group
 *   FEISHU_TRAEX_AMBIENT_ROUNDS     optional, default 4
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
  getRequiredEnv,
  STORAGE_STATE_PATH,
  testMessage,
  expectedReplyMarker,
  sendMessage,
  sendThreadReply,
  navigateToMessenger,
  openGroupChat,
  openThreadForMessage,
  scrollThreadToBottom,
  waitForModelTextReply,
  waitForCardStatus,
  closeSession,
} from './helpers.js';

export function registerMidsceneSuites(): void {
  describe('TraeX ambient mode continuity', () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let agent: PlaywrightAgent;
    let botName: string;

    beforeAll(async () => {
      checkPrerequisites();
      if (!existsSync(STORAGE_STATE_PATH)) {
        throw new Error('storageState.json not found. Run: bun run test:e2e-browser:setup');
      }
      const chatName = getRequiredEnv('FEISHU_TRAEX_AMBIENT_CHAT_NAME');
      botName = getRequiredEnv('FEISHU_TRAEX_BOT_NAME');
      browser = await createBrowser();
      ({ context, page } = await createPage(browser));
      agent = createAgent(page);

      await navigateToMessenger(page);
      await openGroupChat(page, agent, chatName);
    });

    afterAll(async () => {
      await closeSession(agent, page);
      await agent?.destroy();
      await context?.close();
      await browser?.close();
    });

    it('answers every un-@ message across consecutive turns without wedging', async () => {
      const rounds = Math.max(2, Number(process.env.FEISHU_TRAEX_AMBIENT_ROUNDS) || 4);

      // Un-@ top-level message: ambient mode must pick it up on its own.
      const first = testMessage('traex-ambient-1');
      await sendMessage(agent, first, page);
      await openThreadForMessage(agent, { msgHint: first, timeoutMs: 180_000, page });
      try {
        await page.locator('text=直接开启会话').first().click({ timeout: 5_000 });
        await page.waitForTimeout(3_000);
      } catch { /* no repo picker in this group */ }
      await scrollThreadToBottom(agent);
      await waitForModelTextReply(agent, {
        botName,
        marker: expectedReplyMarker(first),
        timeoutMs: 240_000,
      });

      for (let i = 2; i <= rounds; i++) {
        // Send right at the previous turn boundary, still without @.
        const msg = testMessage(`traex-ambient-${i}`);
        await sendThreadReply(agent, page, msg);
        await scrollThreadToBottom(agent);
        await waitForModelTextReply(agent, {
          botName,
          marker: expectedReplyMarker(msg),
          timeoutMs: 240_000,
        });
      }

      await waitForCardStatus(agent, '等待输入', { timeoutMs: 120_000 });
      await scrollThreadToBottom(agent);
      await agent.aiAssert(
        `主内容区正在显示的测试话题里，${botName} 没有发出"没能确认提交"、"可能卡在输入框里"` +
          '或"提交未确认"这类提交失败提示',
      );
    }, 20 * 60_000);
  });
}
