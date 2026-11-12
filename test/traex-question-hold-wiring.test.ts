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
 *    the question but the page is not on the cached screen yet;
 *  - the held message gets the question notice, not the hook-review one;
 *  - the quiet page is never taken for a finished turn.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
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
