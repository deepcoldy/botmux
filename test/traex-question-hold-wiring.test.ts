/**
 * Worker wiring of TRAE's native question page, executed as the REAL worker
 * functions (test/helpers/worker-function-harness) against the real adapters
 * and the real screens captured from traecli 0.214.1
 * (test/fixtures/traex-question):
 *
 *  - only a TraeX session on the terminal path takes part: not the RPC engine
 *    or its `--remote` viewer, not an adopted pane, not a remote backend, not
 *    a non-authoritative screen, not any other CLI;
 *  - queued input is held off the page — also while OSC 7501 already reports
 *    the question but the page is not on the cached screen yet, and when the
 *    page is on the pane before the worker has read it from the stream;
 *  - the held message gets the question notice, not the hook-review one;
 *  - flushPending's drain (the real one, test/helpers/worker-submit-harness)
 *    looks right before a message is written, and what changes while it looks
 *    is honoured;
 *  - the quiet page is never taken for a finished turn.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import type { CliId } from '../src/adapters/cli/types.js';
import { classifyStuckPage, shouldHoldInputForHookReview, shouldHoldInputForStuckPage } from '../src/utils/stuck-detector.js';
import { t } from '../src/i18n/index.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/traex-question/${name}`, import.meta.url), 'utf8');
const QUESTION = fixture('traex-0.214.1-single-160x50.txt');
const NOTES_TYPED = fixture('traex-0.214.1-single-notes-typed-160x50.txt');
const CONFIRM = fixture('traex-0.214.1-submit-confirm-160x50.txt');
const COMPOSER = fixture('traex-0.214.1-answered-composer-160x50.txt');

const WORKER_FUNCTIONS = [
  'traexQuestionBridgeActive',
  'traexQuestionBlockReported',
  'traexQuestionHoldBlocks',
  'traexQuestionHoldsHeldInput',
  'notifyTraexQuestionInputHeld',
  'traexQuestionHoldsIdle',
  'hookReviewHoldBlocks',
  'refreshHookReviewInputHold',
  'heldInputTurnIdentity',
  'heldStuckPage',
  'notifyHookReviewInputHold',
  'adapterRendersCodexFamilyStuckPages',
  'cancelHookReviewReleaseProbe',
  'scheduleHookReviewReleaseProbe',
  'traexQuestionSubmitGuard',
  'traexQuestionHoldsQueuedWrite',
  'hookReviewHoldsQueuedWrite',
  'hookReviewAdmissionScreen',
  'hookReviewAdmissionCapture',
  'hookReviewAdmissionShowsPage',
] as const;

function harness(cliId: CliId, opts: {
  screen?: string;
  block?: { kind?: string } | null;
  init?: Record<string, unknown>;
  remoteWsUrl?: string;
  codexRpcEngine?: unknown;
  authoritative?: boolean;
} = {}) {
  const sent: any[] = [];
  const logs: string[] = [];
  let kicks = 0;
  let idleResets = 0;
  const scope: Record<string, any> = {
    cliAdapter: createCliAdapterSync(cliId),
    lastInitConfig: { cliId, backendType: 'tmux', ...opts.init },
    screen: opts.screen ?? '',
    backend: { captureViewport: () => scope.screen },
    remoteWsUrl: opts.remoteWsUrl,
    codexRpcEngine: opts.codexRpcEngine,
    backendScreenEvidenceIsAuthoritativeForMutation: () => opts.authoritative ?? true,
    captureBackendScreen: (be: any) => be.captureViewport(),
    idleDetector: { programStatusBlock: () => opts.block ?? null, reset: () => { idleResets += 1; } },
    traexQuestionBridge: { kick: () => { kicks += 1; }, reset() {}, hasOpenCard: () => false },
    lastAnalyzerSnapshot: '',
    renderer: { rawSnapshot: () => scope.screen },
    hookReviewInputHold: false,
    hookReviewInputHoldRevision: 0,
    hookReviewInputHoldNotified: false,
    hookReviewInputHoldSnapshot: '',
    hookReviewReleaseProbeTimer: null,
    hookReviewReleaseProbeSinceMs: null,
    HOOK_REVIEW_RELEASE_SETTLE_MS: 150,
    HOOK_REVIEW_RELEASE_SETTLE_CAP_MS: 2_000,
    HOOK_REVIEW_RELEASE_STALLED_PROBE_MS: 5_000,
    lastPtyActivityAtMs: 0,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    queueMicrotask: () => {},
    pendingMessages: [{ turnId: 'om_held', dispatchAttempt: 1 }],
    pendingAdoptMessages: [],
    pendingRawInputs: [],
    hasPendingInputForFlush: () => scope.pendingMessages.length > 0,
    flushPending: async () => {},
    currentBotmuxTurnId: 'om_current',
    currentBotmuxDispatchAttempt: 1,
    cliName: () => 'TRAE CLI',
    send: (msg: any) => { sent.push(msg); },
    log: (line: string) => { logs.push(line); },
    t,
    classifyStuckPage,
    shouldHoldInputForHookReview,
    shouldHoldInputForStuckPage,
    stuckScreenTail: () => '',
    redactStuckPageTail: (s: string) => s,
    screenShowsCredentialPage: () => false,
    shareableStuckScreenTail: () => '',
    cliSpawnGeneration: 1,
    cliRestartInProgress: false,
    traexQuestionDraftWaiting: false,
    TRAEX_QUESTION_DRAFT_WAIT_MS: 60 * 60_000,
    TRAEX_QUESTION_DRAFT_POLL_MS: 500,
    traexQuestionCapture: async () => scope.screen || undefined,
  };
  for (const name of WORKER_FUNCTIONS) scope[name] = loadWorkerFunction(name, scope);
  return { scope, sent, logs, kicks: () => kicks, idleResets: () => idleResets, fn: (name: (typeof WORKER_FUNCTIONS)[number]) => scope[name] };
}

describe('which sessions bridge the question page', () => {
  it('a TraeX session on the terminal path does', () => {
    expect(harness('traex').fn('traexQuestionBridgeActive')()).toBe(true);
    expect(harness('traex', { init: { backendType: 'pty' } }).fn('traexQuestionBridgeActive')()).toBe(true);
  });

  it('the RPC path, adopted panes, remote backends, non-authoritative screens and other CLIs do not', () => {
    expect(harness('traex', { remoteWsUrl: 'ws://127.0.0.1:1' }).fn('traexQuestionBridgeActive')()).toBe(false);
    expect(harness('traex', { codexRpcEngine: {} }).fn('traexQuestionBridgeActive')()).toBe(false);
    expect(harness('traex', { init: { adoptMode: true } }).fn('traexQuestionBridgeActive')()).toBe(false);
    expect(harness('traex', { init: { backendType: 'riff' } }).fn('traexQuestionBridgeActive')()).toBe(false);
    expect(harness('traex', { authoritative: false }).fn('traexQuestionBridgeActive')()).toBe(false);
    for (const cliId of ['codex', 'coco', 'claude-code', 'kimi'] as const) {
      const h = harness(cliId, { screen: QUESTION, block: { kind: 'question' } });
      expect(h.fn('traexQuestionBridgeActive')(), cliId).toBe(false);
      h.fn('refreshHookReviewInputHold')(QUESTION);
      expect(h.scope.hookReviewInputHold, cliId).toBe(false);
    }
  });
});

describe('holding input off the question page', () => {
  it('holds on every page of the question flow, and kicks the card', () => {
    for (const screen of [QUESTION, NOTES_TYPED, CONFIRM]) {
      const h = harness('traex', { screen });
      h.fn('refreshHookReviewInputHold')(screen);
      expect(h.scope.hookReviewInputHold).toBe(true);
      expect(h.kicks()).toBeGreaterThan(0);
    }
    // The composer does not hold.
    const composer = harness('traex', { screen: COMPOSER });
    composer.fn('refreshHookReviewInputHold')(COMPOSER);
    expect(composer.scope.hookReviewInputHold).toBe(false);
  });

  it('looks again when the page has gone (so a re-asked question can be carded again)', () => {
    const h = harness('traex', { screen: QUESTION });
    h.fn('refreshHookReviewInputHold')(QUESTION);
    const kicksWhileHeld = h.kicks();
    h.scope.screen = COMPOSER;
    h.fn('refreshHookReviewInputHold')(COMPOSER, { settled: true });
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(h.kicks()).toBe(kicksWhileHeld + 1);
  });

  it('holds as soon as OSC 7501 reports the question, before the page is on the cached screen', () => {
    expect(harness('traex', { block: { kind: 'question' } }).fn('hookReviewHoldBlocks')(COMPOSER)).toBe(true);
    // Another kind of block keeps its own (program-status) handling.
    expect(harness('traex', { block: { kind: 'permission' } }).fn('hookReviewHoldBlocks')(COMPOSER)).toBe(false);
    // The RPC path keeps its behaviour even with the same report.
    expect(harness('traex', { block: { kind: 'question' }, remoteWsUrl: 'ws://x' }).fn('hookReviewHoldBlocks')(COMPOSER)).toBe(false);
  });

  it('tells the held message to answer on the card, once, for the held turn', () => {
    const h = harness('traex', { screen: QUESTION });
    h.fn('refreshHookReviewInputHold')(QUESTION);
    h.fn('notifyHookReviewInputHold')(QUESTION);
    h.fn('notifyHookReviewInputHold')(QUESTION);
    expect(h.sent).toEqual([{
      type: 'user_notify',
      turnId: 'om_held',
      dispatchAttempt: 1,
      message: t('worker.traex_question.input_held', { cliName: 'TRAE CLI' }),
    }]);
  });
});

describe('the last look before a message is pasted', () => {
  /** The worker's screens follow the CLI's output stream; `pane` is what a
   *  fresh capture shows right now. */
  function staleStream(cliId: CliId, pane: string | undefined, opts: Parameters<typeof harness>[1] = {}) {
    const h = harness(cliId, opts);
    let captures = 0;
    h.scope.cliLifetimeNonce = 'cli-1';
    h.scope.traexQuestionCapture = async () => { captures += 1; return pane; };
    h.scope.renderer = { rawSnapshot: () => COMPOSER };
    h.scope.lastAnalyzerSnapshot = COMPOSER;
    return { ...h, captures: () => captures };
  }

  it('reads a fresh screen, so a page the stream has not delivered yet holds the message', async () => {
    // On tmux the stream reaches the worker through the pipe-pane relay; the
    // page (and its OSC 7501 report) can be on the pane before it arrives.
    const h = staleStream('traex', QUESTION);
    expect(await h.fn('traexQuestionHoldsQueuedWrite')()).toBe(true);
    expect(h.captures()).toBe(1);
    expect(h.scope.hookReviewInputHold).toBe(true);
    expect(h.kicks()).toBeGreaterThan(0);
    expect(h.sent).toEqual([{
      type: 'user_notify',
      turnId: 'om_held',
      dispatchAttempt: 1,
      message: t('worker.traex_question.input_held', { cliName: 'TRAE CLI' }),
    }]);
  });

  it('lets the message go when the fresh screen shows no page', async () => {
    const h = staleStream('traex', COMPOSER);
    expect(await h.fn('traexQuestionHoldsQueuedWrite')()).toBe(false);
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('without a usable capture decides on the cached screens', async () => {
    const quiet = staleStream('traex', undefined);
    expect(await quiet.fn('traexQuestionHoldsQueuedWrite')()).toBe(false);
    const cached = staleStream('traex', undefined);
    cached.scope.lastAnalyzerSnapshot = QUESTION;
    expect(await cached.fn('traexQuestionHoldsQueuedWrite')()).toBe(true);
    const reported = staleStream('traex', undefined, { block: { kind: 'question' } });
    expect(await reported.fn('traexQuestionHoldsQueuedWrite')()).toBe(true);
  });

  it('is void, leaving the hold alone, when the CLI was replaced during the capture', async () => {
    const h = staleStream('traex', QUESTION);
    const capture = h.scope.traexQuestionCapture;
    h.scope.traexQuestionCapture = async () => {
      const screen = await capture();
      h.scope.cliLifetimeNonce = 'cli-2';
      return screen;
    };
    expect(await h.fn('traexQuestionHoldsQueuedWrite')()).toBeUndefined();
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('is void when the page was released while the screen was read: the capture predates the release', async () => {
    const h = staleStream('traex', QUESTION);
    h.fn('refreshHookReviewInputHold')(QUESTION);
    h.fn('notifyHookReviewInputHold')(QUESTION);
    expect(h.sent).toHaveLength(1);
    const capture = h.scope.traexQuestionCapture;
    h.scope.traexQuestionCapture = async () => {
      const screen = await capture();
      // Answered on the card meanwhile: a settled capture let the hold go.
      h.fn('refreshHookReviewInputHold')(COMPOSER, { settled: true });
      return screen;
    };
    expect(await h.fn('traexQuestionHoldsQueuedWrite')()).toBeUndefined();
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(h.sent).toHaveLength(1);
  });

  it('costs nothing outside a TraeX terminal session', async () => {
    for (const h of [
      staleStream('traex', QUESTION, { remoteWsUrl: 'ws://x' }),
      staleStream('traex', QUESTION, { init: { adoptMode: true } }),
      staleStream('codex', QUESTION),
    ]) {
      expect(await h.fn('traexQuestionHoldsQueuedWrite')()).toBe(false);
      expect(h.captures()).toBe(0);
      expect(h.sent).toEqual([]);
    }
  });
});

describe('the drain around the last look', () => {
  /** Queued messages in a TraeX terminal session; `look` stands in for the
   *  fresh screen and can change the worker's state while it is read. */
  function drain(look: (scope: Record<string, any>) => boolean | undefined, queued = ['first']) {
    const h = workerSubmitHarness();
    const { scope } = h;
    scope.pendingMessages.splice(0, scope.pendingMessages.length,
      ...queued.map(content => ({ turnId: `om_${content}`, dispatchAttempt: 1, content })));
    scope.traexQuestionBridgeActive = () => true;
    scope.traexQuestionSubmitGuard = () => ({});
    scope.traexQuestionDraftWaiting = false;
    const looks: string[] = [];
    scope.traexQuestionHoldsQueuedWrite = async () => {
      looks.push(scope.pendingMessages[0]?.turnId);
      await Promise.resolve();
      return look(scope);
    };
    const written = () => scope.cliAdapter.writeInput.mock.calls.map((call: any[]) => call[1]);
    return { ...h, looks, written };
  }

  it('writes the head once the look finds no page', async () => {
    const h = drain(() => false);
    await h.flush();
    expect(h.written()).toEqual(['first']);
    expect(h.looks[0]).toBe('om_first');
  });

  it('writes nothing while the page holds it, and keeps the prompt ready', async () => {
    const h = drain(() => true);
    await h.flush();
    expect(h.written()).toEqual([]);
    expect(h.scope.pendingMessages.map((m: any) => m.turnId)).toEqual(['om_first']);
    expect(h.scope.isPromptReady).toBe(true);
  });

  it('writes nothing when a restart began while it looked', async () => {
    const h = drain(scope => { scope.cliRestartInProgress = true; return false; });
    await h.flush();
    expect(h.written()).toEqual([]);
    expect(h.scope.pendingMessages).toHaveLength(1);
  });

  it('puts the head that took over during the look through its gates before writing it', async () => {
    // The second message must wait (say, behind another sender's turn).
    let firstLook = true;
    const h = drain(scope => {
      // An IPC handler (an interrupt, an expired durable turn) dropped the head.
      if (firstLook) scope.pendingMessages.shift();
      firstLook = false;
      return false;
    }, ['first', 'second']);
    const asked: string[] = [];
    h.scope.activeTurnBlocks = (item: any) => { asked.push(item?.turnId); return item?.turnId === 'om_second'; };
    await h.flush();
    expect(h.written()).toEqual([]);
    expect(asked).toContain('om_second');
  });

  it('looks again when its look was void', async () => {
    let calls = 0;
    const h = drain(() => (calls++ === 0 ? undefined : false));
    await h.flush();
    expect(h.looks).toEqual(['om_first', 'om_first']);
    expect(h.written()).toEqual(['first']);
  });
});

describe('the submit guard handed to a TraeX write', () => {
  it('stays bound to the CLI the write started on', () => {
    for (const replace of [
      (scope: Record<string, any>) => { scope.backend = { captureViewport: () => scope.screen }; },
      (scope: Record<string, any>) => { scope.cliSpawnGeneration += 1; },
      (scope: Record<string, any>) => { scope.cliRestartInProgress = true; },
    ]) {
      const h = harness('traex', { screen: QUESTION });
      const guard = h.fn('traexQuestionSubmitGuard')({ turnId: 'om_draft', dispatchAttempt: 2 });
      expect(guard.current()).toBe(true);
      replace(h.scope);
      expect(guard.current()).toBe(false);
    }
  });

  it('marks the pasted draft as waiting while the page is up, tells its sender once, and lets go on another CLI', async () => {
    const h = harness('traex', { screen: QUESTION });
    const guard = h.fn('traexQuestionSubmitGuard')({ turnId: 'om_draft', dispatchAttempt: 2 });
    const reason = t('worker.traex_question.submit_blocked', { cliName: 'TRAE CLI' });
    expect(await guard.blocked('draft')).toBe(reason);
    expect(await guard.blocked('draft')).toBe(reason);
    expect(h.scope.traexQuestionDraftWaiting).toBe(true);
    expect(h.sent).toEqual([{
      type: 'user_notify',
      turnId: 'om_draft',
      dispatchAttempt: 2,
      message: t('worker.traex_question.draft_waiting', { cliName: 'TRAE CLI' }),
    }]);
    // A retry Enter is held off the page too, but it is no draft.
    h.scope.traexQuestionDraftWaiting = false;
    expect(await guard.blocked('retry')).toBe(reason);
    expect(h.scope.traexQuestionDraftWaiting).toBe(false);
    // The page leaves: the draft's Enter may go.
    h.scope.traexQuestionDraftWaiting = true;
    h.scope.screen = COMPOSER;
    expect(await guard.blocked('draft')).toBeUndefined();
    expect(h.scope.traexQuestionDraftWaiting).toBe(false);
    // The CLI is replaced while the page is still drawn on the new one: this
    // write's draft is gone with its CLI, nothing is held for it any more.
    h.scope.screen = QUESTION;
    h.scope.traexQuestionDraftWaiting = true;
    h.scope.cliSpawnGeneration += 1;
    expect(await guard.blocked('draft')).toBeUndefined();
    expect(h.scope.traexQuestionDraftWaiting).toBe(false);
    expect(h.sent).toHaveLength(1);
  });
});

describe('the quiet question page is not a finished turn', () => {
  it('vetoes a prompt-ready edge while the page is on screen', () => {
    for (const screen of [QUESTION, NOTES_TYPED, CONFIRM]) {
      const h = harness('traex', { screen });
      expect(h.fn('traexQuestionHoldsIdle')('TRAE CLI screen-idle', h.scope.backend)).toBe(true);
      expect(h.idleResets()).toBe(1);
      expect(h.scope.hookReviewInputHold).toBe(true);
    }
  });

  it('keeps vetoing on a failed capture while the hold still stands on the page', () => {
    const h = harness('traex', { screen: QUESTION });
    h.fn('refreshHookReviewInputHold')(QUESTION);
    expect(h.scope.hookReviewInputHold).toBe(true);
    h.scope.screen = '';
    expect(h.fn('traexQuestionHoldsIdle')('TRAE CLI screen-idle', h.scope.backend)).toBe(true);
    // Nothing held, nothing captured: no evidence of a page, no veto.
    const fresh = harness('traex', { screen: '' });
    expect(fresh.fn('traexQuestionHoldsIdle')('TRAE CLI screen-idle', fresh.scope.backend)).toBe(false);
  });

  it('leaves other screens, sessions and backends alone', () => {
    const composer = harness('traex', { screen: COMPOSER });
    expect(composer.fn('traexQuestionHoldsIdle')('idle', composer.scope.backend)).toBe(false);
    const rpc = harness('traex', { screen: QUESTION, remoteWsUrl: 'ws://x' });
    expect(rpc.fn('traexQuestionHoldsIdle')('idle', rpc.scope.backend)).toBe(false);
    const replaced = harness('traex', { screen: QUESTION });
    expect(replaced.fn('traexQuestionHoldsIdle')('idle', { captureViewport: () => QUESTION })).toBe(false);
    expect(replaced.idleResets()).toBe(0);
  });
});
