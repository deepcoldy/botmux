import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { PlaywrightAgent } from '@midscene/web/playwright';
import {
  STORAGE_STATE_PATH,
  checkPrerequisites,
  clickDirectStartIfPresent,
  closeSession,
  createAgent,
  createBrowser,
  createPage,
  expectedReplyMarker,
  navigateToMessenger,
  openChat,
  openThreadForMessage,
  scrollThreadToBottom,
  sendMessage,
  showStreamingOutput,
  testMessage,
  waitForCodexSideResponse,
  waitForModelTextReply,
  waitForStreamingCard,
} from './helpers.js';
import { publishPageVideo } from './e2e-video.js';

export const FEISHU_PHASE_SCENARIOS = [
  'bot-claude-basic',
  'bot-codex-basic',
  'bot-codex-prompt',
] as const;

export type FeishuPhaseScenario = (typeof FEISHU_PHASE_SCENARIOS)[number];

interface ReportTrace {
  type: 'midscene-execution';
  executionId: string;
}

interface ReportHooks {
  addDumpUpdateListener?(
    listener: (dump: string, execution?: { id?: string }) => void,
  ): () => void;
  flushReport?(): Promise<string | undefined>;
  _prepareForTestRunner?(): void;
  _createReportSource?(scopeId: string): Promise<unknown>;
}

function reportHooks(agent: PlaywrightAgent): ReportHooks {
  return agent as PlaywrightAgent & ReportHooks;
}

export interface FeishuPhaseContext {
  input: { scenario: FeishuPhaseScenario };
  signal: AbortSignal;
  report: { addTrace(trace: ReportTrace): void };
  onTeardown(
    teardown: () => Promise<{ reportPaths?: string[] } | void> | { reportPaths?: string[] } | void,
  ): void;
  scope: 'case' | 'document';
  case?: { runId: string; name: string };
}

const PHASE_META: Record<
  FeishuPhaseScenario,
  { kind: 'reply' | 'codex'; botName: 'Claude' | 'Codex'; fileStem: string }
> = {
  'bot-claude-basic': { kind: 'reply', botName: 'Claude', fileStem: 'bot-claude-basic' },
  'bot-codex-basic': { kind: 'codex', botName: 'Codex', fileStem: 'bot-codex-basic' },
  'bot-codex-prompt': { kind: 'codex', botName: 'Codex', fileStem: 'bot-codex-prompt' },
};

interface LiveSession {
  scenario: FeishuPhaseScenario;
  caseName: string;
  fileStem: string;
  kind: 'reply' | 'codex';
  botName: 'Claude' | 'Codex';
  browser: Browser;
  context: BrowserContext;
  page: Page;
  agent: PlaywrightAgent;
  msg: string;
  marker: string;
  released: boolean;
}

let current: LiveSession | null = null;

function requireCase(ctx: FeishuPhaseContext): { runId: string; name: string } {
  if (ctx.scope !== 'case' || !ctx.case) {
    throw new Error('Feishu phase nodes must run as case steps');
  }
  return ctx.case;
}

function sessionFor(scenario: FeishuPhaseScenario): LiveSession {
  if (!current || current.scenario !== scenario) {
    throw new Error(`Feishu session ${scenario} is not open`);
  }
  return current;
}

async function withReportTraces(
  ctx: FeishuPhaseContext,
  agent: PlaywrightAgent,
  run: () => Promise<void>,
): Promise<void> {
  const remove = reportHooks(agent).addDumpUpdateListener?.((_dump, execution) => {
    const executionId = execution?.id;
    if (!executionId) return;
    ctx.report.addTrace({ type: 'midscene-execution', executionId });
  });
  try {
    ctx.signal.throwIfAborted();
    await run();
  } finally {
    remove?.();
  }
}

function registerCleanup(ctx: FeishuPhaseContext, session: LiveSession): void {
  const runId = requireCase(ctx).runId;
  ctx.onTeardown(() => releaseSession(session, runId));
}

async function releaseSession(
  session: LiveSession,
  runId: string,
): Promise<{ reportPaths?: string[]; reportSources?: unknown[] } | void> {
  if (session.released) return;
  session.released = true;
  if (current === session) current = null;

  const reportPaths: string[] = [];
  const reportSources: unknown[] = [];
  try {
    const flushed = await reportHooks(session.agent).flushReport?.();
    if (flushed) reportPaths.push(path.resolve(flushed));
  } catch (error) {
    console.error('Feishu agent report flush failed:', error);
  }
  try {
    const source = await reportHooks(session.agent)._createReportSource?.(runId);
    if (source) reportSources.push(source);
  } catch (error) {
    console.error('Feishu agent report source failed:', error);
  }
  try {
    await closeSession(session.agent, session.page);
  } catch {
    // The button is a best-effort teardown.
  }
  try {
    await session.agent.destroy();
  } catch {
    // The page may already be gone.
  }
  try {
    await session.context.close();
  } catch {
    // Closing a failed context still needs to reach the video save below.
  }
  try {
    await publishPageVideo(session.page, session.caseName, session.fileStem);
  } catch (error) {
    console.error('Feishu video publish failed:', error);
  }
  try {
    await session.browser.close();
  } catch {
    // Browser already closed.
  }
  return {
    ...(reportPaths.length ? { reportPaths } : {}),
    ...(reportSources.length ? { reportSources } : {}),
  };
}

export async function openAndSend(ctx: FeishuPhaseContext): Promise<{ summary: string }> {
  const scenario = ctx.input.scenario;
  const meta = PHASE_META[scenario];
  const caseInfo = requireCase(ctx);
  checkPrerequisites();
  if (!existsSync(STORAGE_STATE_PATH)) {
    throw new Error('storageState.json not found. Run: pnpm test:e2e-browser:setup');
  }
  if (current && !current.released) {
    await releaseSession(current, caseInfo.runId);
  }

  const browser = await createBrowser();
  const { context, page } = await createPage(browser);
  const agent = createAgent(page);
  reportHooks(agent)._prepareForTestRunner?.();
  const marker = meta.kind === 'codex'
    ? `CODEX_E2E_MARKER_${Date.now()}`
    : '';
  const msg = meta.kind === 'codex'
    ? `${testMessage('codex-marker', { plain: true })} 请在最终回复中原样包含 ${marker}`
    : testMessage(meta.botName.toLowerCase());
  const replyMarker = meta.kind === 'codex' ? marker : expectedReplyMarker(msg);
  const session: LiveSession = {
    scenario,
    caseName: caseInfo.name,
    fileStem: meta.fileStem,
    kind: meta.kind,
    botName: meta.botName,
    browser,
    context,
    page,
    agent,
    msg,
    marker: replyMarker,
    released: false,
  };
  current = session;
  registerCleanup(ctx, session);

  await withReportTraces(ctx, agent, async () => {
    await navigateToMessenger(page);
    await openChat(page, agent, meta.botName);
    await sendMessage(agent, msg);
    if (meta.kind === 'codex') {
      await openThreadForMessage(agent, { timeoutMs: 120_000, msgHint: msg, page });
      await clickDirectStartIfPresent(agent, page);
    }
  });
  return { summary: `Sent ${msg}` };
}

export async function waitForStreamingCardPhase(
  ctx: FeishuPhaseContext,
): Promise<{ summary: string }> {
  const session = sessionFor(ctx.input.scenario);
  registerCleanup(ctx, session);
  if (session.kind !== 'reply') {
    return { summary: 'Streaming-card wait does not apply to Codex' };
  }
  await withReportTraces(ctx, session.agent, async () => {
    await waitForStreamingCard(session.agent, {
      timeoutMs: 90_000,
      msgHint: session.msg,
      page: session.page,
    });
  });
  return { summary: 'Streaming card is visible' };
}

export async function waitForBotResponse(ctx: FeishuPhaseContext): Promise<{ summary: string }> {
  const session = sessionFor(ctx.input.scenario);
  registerCleanup(ctx, session);
  await withReportTraces(ctx, session.agent, async () => {
    await scrollThreadToBottom(session.agent);
    if (session.kind === 'codex') {
      await waitForCodexSideResponse(session.agent, {
        marker: session.marker,
        timeoutMs: 180_000,
      });
      return;
    }
    // The ACK bubble is the success gate. Do not hard-wait for 「等待输入」.
    await waitForModelTextReply(session.agent, {
      botName: session.botName,
      marker: session.marker,
      timeoutMs: 180_000,
    });
  });
  return {
    summary: session.kind === 'codex'
      ? `Codex-side response accepted for ${session.marker}`
      : `Reply bubble accepted for ${session.marker}`,
  };
}

export async function showStreamingOutputPhase(
  ctx: FeishuPhaseContext,
): Promise<{ summary: string }> {
  const session = sessionFor(ctx.input.scenario);
  registerCleanup(ctx, session);
  if (session.kind !== 'reply') {
    return { summary: 'Streaming-card output toggle does not apply to Codex' };
  }
  await withReportTraces(ctx, session.agent, async () => {
    await showStreamingOutput(session.agent, session.page);
  });
  return { summary: 'Streaming card output is visible' };
}

export async function closeFeishuPhase(ctx: FeishuPhaseContext): Promise<{ summary: string }> {
  const session = sessionFor(ctx.input.scenario);
  // Teardown runs after this step and is what returns reportPaths / reportSources.
  // Releasing here would drop those values, so the browser stays open until then.
  registerCleanup(ctx, session);
  await closeSession(session.agent, session.page);
  return { summary: 'Session closed' };
}
