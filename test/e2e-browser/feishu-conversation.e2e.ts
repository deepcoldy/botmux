/**
 * Conversation flows inside one Claude private-chat topic — what a real user
 * does after the first reply:
 *
 *  1. Follow-up: a second message in the same topic reaches the same CLI
 *     session. The follow-up asks the model to repeat the first turn's ACK
 *     marker, which only a session that still holds that turn can do.
 *  2. Topic commands: `/status` reports the live session, `/close` ends it, and
 *     a second `/status` shows a different, not-yet-started session — proof the
 *     old CLI session is really gone rather than just relabelled.
 *
 * Slash commands are typed with real key presses (`typeThreadReply`) because
 * the daemon parses the literal text.
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
  STORAGE_STATE_PATH,
  followUpMessage,
  expectedRecallMarker,
  sendMessage,
  typeThreadReply,
  navigateToMessenger,
  openChat,
  openThreadForMessage,
  waitForReplyLine,
  reopenTopic,
  recordTextEvidence,
  scrollThreadToBottom,
  closeSession,
  scrollConversation,
} from './helpers.js';
import { publishLabeledPageVideo } from './e2e-video.js';

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  agent: PlaywrightAgent;
}

async function openClaudeChat(): Promise<BrowserSession> {
  checkPrerequisites();
  if (!existsSync(STORAGE_STATE_PATH)) {
    throw new Error('storageState.json not found. Run: bun run test:e2e-browser:setup');
  }
  const browser = await createBrowser();
  const { context, page } = await createPage(browser);
  const agent = createAgent(page);
  await navigateToMessenger(page);
  await openChat(page, agent, 'Claude');
  return { browser, context, page, agent };
}

async function releaseBrowser(session: Partial<BrowserSession>): Promise<void> {
  if (session.agent && session.page) await closeSession(session.agent, session.page);
  await session.agent?.destroy();
  await session.context?.close();
  try {
    await publishLabeledPageVideo(session.page);
  } catch (error) {
    console.error('Feishu video publish failed:', error);
  }
  await session.browser?.close();
}

/**
 * Open a new topic with a recall probe and wait for its reply. The reply line
 * (`ACK-<tag> RECALL ACK-<tag>`) exists only in the bot's answer — counting a
 * bare ACK marker is not enough, because the topic list previews the prompt.
 * The bot may post a repo card first; waitForReplyLine starts the session.
 */
async function startTopic({ agent, page }: BrowserSession, msg: string): Promise<void> {
  await sendMessage(agent, msg, page);
  await openThreadForMessage(agent, { timeoutMs: 120_000, msgHint: msg, page });
  await waitForReplyLine(page, expectedRecallMarker(msg, msg), { agent, reopen: reopenTopic(agent, page, msg) });
}

// `/status` prints `Session: <uuid>`; session ids are randomUUID().
const STATUS_SESSION_PATTERN =
  /Session:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

async function visibleStatusSessions(page: Page): Promise<Set<string>> {
  const text = await page.locator('body').innerText();
  return new Set([...text.matchAll(STATUS_SESSION_PATTERN)].map((match) => match[1].toLowerCase()));
}

/**
 * Wait for a `/status` reply naming a session id not in `seen`, and return it.
 * Reads the DOM: the id is an opaque string that must be compared exactly,
 * which a vision model may misread. Comparing against ids already on the page
 * keeps older `/status` replies and topic-list previews from matching.
 */
async function waitForNewStatusSession(
  page: Page,
  seen: Set<string>,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const id of await visibleStatusSessions(page)) {
      if (!seen.has(id)) {
        seen.add(id);
        return id;
      }
    }
    await scrollConversation(page);
    await page.waitForTimeout(2_000);
  }
  throw new Error(`No /status reply with a new session id appeared within ${timeoutMs}ms`);
}

/** The `/status` reply naming `sessionId` reports `Status: <expected>`. */
async function expectStatusLine(page: Page, sessionId: string, expected: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  let status: string | undefined;
  while (Date.now() < deadline) {
    const body = (await page.locator('body').innerText()).toLowerCase();
    const at = body.lastIndexOf(`session: ${sessionId}`);
    status = at >= 0 ? body.slice(at, at + 600).match(/status:\s*(\S+)/)?.[1] : undefined;
    if (status && expected.includes(status)) return;
    await scrollConversation(page);
    await page.waitForTimeout(2_000);
  }
  throw new Error(`/status for ${sessionId} reported "${status ?? 'nothing'}", expected ${expected.join(' or ')}`);
}

export function registerMidsceneSuites(): void {
  describe('feishu topic conversation', () => {
    let session: BrowserSession | undefined;

    beforeAll(async () => {
      session = await openClaudeChat();
    }, 120_000);

    afterAll(async () => {
      await releaseBrowser(session ?? {});
    });

    it('a follow-up reply in the same topic reaches the same session and its history', async () => {
      const live = session!;
      const first = followUpMessage('turn1');
      await startTopic(live, first);

      // The follow-up goes into the open topic, not a new top-level message.
      const followUp = followUpMessage('turn2');
      await typeThreadReply(live.agent, live.page, followUp);
      // Exact DOM match: the recall line only exists in the reply (the prompt
      // holds a placeholder), and a vision model blurs long digit runs.
      const recall = expectedRecallMarker(followUp, first);
      await waitForReplyLine(live.page, recall, {
        agent: live.agent,
        reopen: reopenTopic(live.agent, live.page, first),
      });
      await recordTextEvidence(live.agent, live.page, recall, 'Follow-up reply recalls the first turn');
    }, 600_000);
  });

  describe('feishu topic commands', () => {
    let session: BrowserSession | undefined;

    beforeAll(async () => {
      session = await openClaudeChat();
    }, 120_000);

    afterAll(async () => {
      await releaseBrowser(session ?? {});
    });

    it('/status reports the live session and /close ends it', async () => {
      const live = session!;
      const { agent, page } = live;
      await startTopic(live, followUpMessage('cmd'));

      const seen = await visibleStatusSessions(page);
      await typeThreadReply(agent, page, '/status');
      const liveSession = await waitForNewStatusSession(page, seen);
      // An idle CLI may be suspended between turns, so a live session reports
      // either state; what /close must change is the session id.
      await expectStatusLine(page, liveSession, ['运行中', '等待中']);

      await typeThreadReply(agent, page, '/close');
      await page.getByText('会话已关闭').last().waitFor({ timeout: 60_000 });
      await scrollThreadToBottom(agent);
      await agent.aiWaitFor(
        '主内容区正在显示的测试话题里，当前会话的卡片已变为"🛑 会话已关闭"状态，' +
          '卡片上有"恢复会话"按钮',
        { timeoutMs: 30_000, checkIntervalMs: 3_000 },
      );

      // /status after /close pre-creates a placeholder session that has not
      // started a CLI: a different id, and 「等待中」 instead of 「运行中」.
      await typeThreadReply(agent, page, '/status');
      // A new id alone proves the closed session no longer owns the topic.
      const placeholder = await waitForNewStatusSession(page, seen);
      await expectStatusLine(page, placeholder, ['等待中']);

      // Close the placeholder too so the topic leaves no session behind.
      await typeThreadReply(agent, page, '/close');
    }, 600_000);
  });
}
