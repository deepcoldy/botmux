/**
 * Issue #3790 regression & adversarial boundary suite:
 * TraeX cold-resume first delivery must recover after the 90s warning timeout
 * instead of stalling permanently in starting / awaitingFirstPrompt, and native
 * viewport readiness evidence must propagate safely to parameterless admission
 * checks while preserving every existing safety gate.
 *
 * Uses REAL scheduleTraexFirstPromptReadiness, traexNativeStartupInputIsPending,
 * markPromptReady, flushPending, traexFirstPromptViewportRejects, firstWriteScreen,
 * TerminalRenderer, IdleDetector, createTraexAdapter, and 0.216.0 cold-resume
 * fixtures under deterministic fake clocks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { traexRestoredComposerReady } from '../src/adapters/cli/traex-footer.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { HcBackend } from '../src/adapters/backend/hc-backend.js';
import {
  TRAEX_FIRST_PROMPT_FAST_POLL_MS,
  TRAEX_FIRST_PROMPT_SLOW_POLL_MS,
  TraexFirstPromptReadinessPoller,
  TraexNativeViewportEvidenceStore,
  TraexNativeViewportRefreshController,
  isTraexWebInputSettled,
  nextTraexFirstPromptPollDelayMs,
  normalizePlainViewportLines,
  stageNativeViewportInTempRendererSync,
  type PaneDimensions,
  type TraexNativeViewportReadContext,
} from '../src/core/traex-first-prompt-readiness.js';
import { traexStartupInputReady } from '../src/core/traex-startup-input.js';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { WebTerminalInputController } from '../src/core/web-terminal-input-controller.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const FIXTURE_DIR = join(process.cwd(), 'test/fixtures/traex-cold-resume');
const RESUME_PROVISIONAL = readFileSync(join(FIXTURE_DIR, '0.216.0-resume-provisional.txt'), 'utf8');
const RESUME_RESOLVED = readFileSync(join(FIXTURE_DIR, '0.216.0-resume-resolved.txt'), 'utf8');
const RESUME_RESOLVED_PASTED = readFileSync(join(FIXTURE_DIR, '0.216.0-resume-resolved-pasted.txt'), 'utf8');
const TRAEX_READY_PATTERN = createTraexAdapter('/bin/true').readyPattern;

/** Build a realistic resolved TraeX capture at an arbitrary column width (>160 or >320). */
function buildWideResolvedViewport(cols: number, opts: {
  topBanner?: string;
  historyLine?: string;
  extraBlankRows?: number;
} = {}): string {
  const rule = '─'.repeat(cols);
  const leftFooter = '  ☢ Full Access (shift+tab to cycle) · ? for shortcuts · ← for agents';
  const rightFooter = '⚠ 1 warning · f2 to view';
  const padLen = Math.max(2, cols - leftFooter.length - rightFooter.length - 1);
  const footerLine2 = `${leftFooter}${' '.repeat(padLen)}${rightFooter}`;
  const lines = [
    ...(opts.topBanner ? [opts.topBanner] : []),
    '  █ ◆ ◆ █  TRAE CLI (v0.216.0)',
    '  /tmp/repo',
    '  permissions: YOLO mode',
    '  Good afternoon, user',
    opts.historyLine ?? '▍ Reply with exactly the single word: ok',
    '◆ ok',
    '  Worked for 2s • Nov 20 at 12:44',
    ...Array.from({ length: opts.extraBlankRows ?? 0 }, () => ''),
    rule,
    '❯ Use /skills to list available skills',
    rule,
    '  Seed-Evolving · /tmp/repo · Context 99% left',
    footerLine2,
  ];
  return `${lines.join('\n')}\n`;
}

/** Flush microtasks cleanly across both Vitest and bun test. */
async function settleMicrotasks(turns = 14): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Drain a real TerminalRenderer under fake timers (xterm write uses setTimeout). */
async function feedRealRenderer(renderer: TerminalRenderer, data: string): Promise<void> {
  const done = renderer.writeAndFlush(data);
  await vi.advanceTimersByTimeAsync(50);
  await done;
}

describe('TraeX first-prompt readiness pure core', () => {
  it('slows polling cadence past the alert deadline instead of stopping observation', () => {
    const deadline = 90_000;
    expect(TRAEX_FIRST_PROMPT_SLOW_POLL_MS).toBeGreaterThan(TRAEX_FIRST_PROMPT_FAST_POLL_MS);
    expect(nextTraexFirstPromptPollDelayMs(0, deadline)).toBe(TRAEX_FIRST_PROMPT_FAST_POLL_MS);
    expect(nextTraexFirstPromptPollDelayMs(deadline - 1, deadline)).toBe(TRAEX_FIRST_PROMPT_FAST_POLL_MS);
    expect(nextTraexFirstPromptPollDelayMs(deadline, deadline)).toBe(TRAEX_FIRST_PROMPT_SLOW_POLL_MS);
    expect(nextTraexFirstPromptPollDelayMs(deadline + 60_000, deadline)).toBe(TRAEX_FIRST_PROMPT_SLOW_POLL_MS);
  });

  it('stages real 0.216.0 captures at exact native geometry without stair-stepping, 320-col truncation, ZWJ/skin-tone false scroll, or C1 escape execution', () => {
    const at160 = stageNativeViewportInTempRendererSync(RESUME_RESOLVED, { cols: 160, rows: 50 });
    expect(at160.ok).toBe(true);
    if (!at160.ok) return;
    expect(traexStartupInputReady({
      screen: at160.formattedScreen,
      readyPattern: TRAEX_READY_PATTERN,
      webInputUnchanged: true,
      blockingOwner: false,
    })).toBe(true);
    expect(at160.formattedScreen).toContain('\n❯ Use /skills to list available skills\n');

    // Ultrawide 380-col pane exceeds SNAPSHOT_COLS (320) yet keeps right-aligned warning intact.
    const wide380 = buildWideResolvedViewport(380);
    const staged380 = stageNativeViewportInTempRendererSync(wide380, { cols: 380, rows: 50 });
    expect(staged380.ok).toBe(true);
    if (!staged380.ok) return;
    expect(staged380.formattedScreen).toContain('⚠ 1 warning · f2 to view');
    expect(traexStartupInputReady({
      screen: staged380.formattedScreen,
      readyPattern: TRAEX_READY_PATTERN,
      webInputUnchanged: true,
      blockingOwner: false,
    })).toBe(true);

    // Tall 120-row pane keeps row-0 Sign in banner visible so readiness still rejects it.
    const tallLogin = buildWideResolvedViewport(160, { topBanner: 'Sign in to TRAE CLI', extraBlankRows: 100 });
    const stagedTall = stageNativeViewportInTempRendererSync(tallLogin, { cols: 160, rows: 120 });
    expect(stagedTall.ok).toBe(true);
    if (!stagedTall.ok) return;
    expect(stagedTall.formattedScreen).toContain('Sign in to TRAE CLI');
    expect(traexStartupInputReady({
      screen: stagedTall.formattedScreen,
      readyPattern: TRAEX_READY_PATTERN,
      webInputUnchanged: true,
      blockingOwner: false,
    })).toBe(false);

    // Real tmux 3.5a wrapped rows with ZWJ / skin-tone / flag emojis at full 160-col width
    // must NOT trigger false wrap/scroll rejections inside xterm Unicode11 staging.
    for (const emoji of ['👨‍💻', '👨‍👩‍👧‍👦', '🏳️‍🌈', '👍🏽', '🇺🇸']) {
      const fullWidthEmojiRow = `${'a'.repeat(158)}${emoji}`;
      const full50Rows = buildWideResolvedViewport(160, {
        historyLine: fullWidthEmojiRow,
        extraBlankRows: 38,
      });
      const stagedEmoji = stageNativeViewportInTempRendererSync(full50Rows, { cols: 160, rows: 50 });
      expect(stagedEmoji.ok, `ZWJ/skin-tone/flag ${emoji} must stage cleanly`).toBe(true);
      if (!stagedEmoji.ok) continue;
      expect(traexStartupInputReady({
        screen: stagedEmoji.formattedScreen,
        readyPattern: TRAEX_READY_PATTERN,
        webInputUnchanged: true,
        blockingOwner: false,
      })).toBe(true);
    }

    // C1 CSI (U+009B) / OSC (U+009D) / bare CR inside plain capture cell text MUST be
    // sanitized so cell text can NEVER erase row-0 Sign in banner or swallow composer rows.
    const c1Attack = buildWideResolvedViewport(160, {
      topBanner: 'Sign in to TRAE CLI',
      historyLine: 'foo\u009b1;1H\u009b2Kbar\u009d0;swallow\rOVERWRITE',
    });
    const stagedC1 = stageNativeViewportInTempRendererSync(c1Attack, { cols: 160, rows: 50 });
    expect(stagedC1.ok).toBe(true);
    if (!stagedC1.ok) return;
    expect(stagedC1.formattedScreen).toContain('Sign in to TRAE CLI');
    expect(traexStartupInputReady({
      screen: stagedC1.formattedScreen,
      readyPattern: TRAEX_READY_PATTERN,
      webInputUnchanged: true,
      blockingOwner: false,
    })).toBe(false);
  });

  it('fails closed on wrapped lines (ABA width shrink), vertical scroll overflow, and empty/invalid dimensions', () => {
    // 180-col capture staged into a 160-col renderer fails closed on horizontal overflow!
    const wide180 = buildWideResolvedViewport(180);
    expect(stageNativeViewportInTempRendererSync(wide180, { cols: 160, rows: 50 })).toEqual({
      ok: false,
      reason: 'wrapped',
    });

    // More rows than pane height -> rejected!
    expect(stageNativeViewportInTempRendererSync(RESUME_RESOLVED, { cols: 160, rows: 10 })).toEqual({
      ok: false,
      reason: 'scrolled',
    });

    // Invalid dimensions or empty screen -> rejected!
    expect(stageNativeViewportInTempRendererSync('   \n\n', { cols: 160, rows: 50 })).toEqual({ ok: false, reason: 'empty' });
    expect(stageNativeViewportInTempRendererSync(RESUME_RESOLVED, { cols: 0, rows: 50 })).toEqual({ ok: false, reason: 'invalid-dimensions' });
    expect(stageNativeViewportInTempRendererSync(RESUME_RESOLVED, { cols: 2_000, rows: 50 })).toEqual({ ok: false, reason: 'invalid-dimensions' });

    // normalizePlainViewportLines preserves inner blank lines, strips at most one trailing EOL and unsafe controls.
    expect(normalizePlainViewportLines('a\n\nb\u009b2K\r\n')).toEqual(['a', '', 'b2K']);
    expect(normalizePlainViewportLines('x\r\ny\r\n')).toEqual(['x', 'y']);
  });

  it('invalidates and permanently evicts evidence on ANY single scope-field mismatch (no ABA resurrection) and enforces clearIfOwnedBy ownership', () => {
    const backend = { id: 'be-1' };
    const renderer = { id: 'ren-1' };
    const baseCtx = (): TraexNativeViewportReadContext => ({
      closeRequested: false,
      restartingWithoutReplacement: false,
      pendingWebInput: false,
      backend,
      spawnGeneration: 3,
      lifetimeNonce: 11,
      renderer,
      screenRevision: 42,
      outputGenerationCurrent: (s) => s === 7,
      webInputGeneration: 2,
      controlWriteRevision: 4,
      interruptGeneration: 1,
      gridRevision: 5,
      webResizedGrid: { cols: 180, rows: 50 },
      syncPaneSize: { cols: 180, rows: 50 },
    });
    const publishFresh = (store: TraexNativeViewportEvidenceStore) => {
      store.publish({
        scope: {
          backend,
          spawnGeneration: 3,
          lifetimeNonce: 11,
          renderer,
          screenRevision: 42,
          outputGeneration: 7,
          webInputGeneration: 2,
          controlWriteRevision: 4,
          interruptGeneration: 1,
          gridRevision: 5,
          webResizedGrid: { cols: 180, rows: 50 },
          paneSize: { cols: 180, rows: 50 },
          syncPaneSize: { cols: 180, rows: 50 },
        },
        formattedScreen: RESUME_RESOLVED,
        plainScreen: RESUME_RESOLVED,
        webInputSettled: true,
        capturedAtMs: 1_000,
      });
    };

    const mutations: Array<[string, (ctx: TraexNativeViewportReadContext) => TraexNativeViewportReadContext]> = [
      ['closeRequested', c => ({ ...c, closeRequested: true })],
      ['restartingWithoutReplacement', c => ({ ...c, restartingWithoutReplacement: true })],
      ['pendingWebInput', c => ({ ...c, pendingWebInput: true })],
      ['backend', c => ({ ...c, backend: { id: 'be-2' } })],
      ['spawnGeneration', c => ({ ...c, spawnGeneration: 4 })],
      ['lifetimeNonce', c => ({ ...c, lifetimeNonce: 12 })],
      ['renderer', c => ({ ...c, renderer: { id: 'ren-2' } })],
      ['screenRevision', c => ({ ...c, screenRevision: 43 })],
      ['outputGenerationCurrent', c => ({ ...c, outputGenerationCurrent: () => false })],
      ['webInputGeneration', c => ({ ...c, webInputGeneration: 3 })],
      ['controlWriteRevision', c => ({ ...c, controlWriteRevision: 5 })],
      ['interruptGeneration', c => ({ ...c, interruptGeneration: 2 })],
      ['gridRevision', c => ({ ...c, gridRevision: 6 })],
      ['webResizedGrid', c => ({ ...c, webResizedGrid: { cols: 160, rows: 50 } })],
      ['syncPaneSize', c => ({ ...c, syncPaneSize: { cols: 160, rows: 50 } })],
    ];

    for (const [label, mutate] of mutations) {
      const store = new TraexNativeViewportEvidenceStore();
      publishFresh(store);
      expect(store.read(baseCtx()), `${label}: valid before mismatch`).toBeDefined();
      expect(store.read(mutate(baseCtx())), `${label}: must reject mismatch`).toBeUndefined();
      // Permanent eviction: restoring original context (ABA) must NOT resurrect stale evidence.
      expect(store.hasEntry(), `${label}: must evict on mismatch`).toBe(false);
      expect(store.read(baseCtx()), `${label}: must not resurrect on ABA`).toBeUndefined();
    }

    // clearIfOwnedBy must ignore stale/other-generation callers while clearing its own entry.
    const ownedStore = new TraexNativeViewportEvidenceStore();
    publishFresh(ownedStore);
    ownedStore.clearIfOwnedBy({ backend, spawnGeneration: 2, lifetimeNonce: 11, renderer });
    expect(ownedStore.hasEntry()).toBe(true);
    ownedStore.clearIfOwnedBy({ backend, spawnGeneration: 3, lifetimeNonce: 11, renderer });
    expect(ownedStore.hasEntry()).toBe(false);
  });

  it('tracks Web input settlement, single-flight poller stop, and faster Phase-2 reschedule', async () => {
    vi.useFakeTimers();
    try {
      expect(isTraexWebInputSettled({
        webInputGeneration: 1,
        webInputGenerationAtSpawn: 0,
        pendingWebInput: false,
        nowMs: 1_500,
        lastWebInputAtMs: 1_000,
        screenRevision: 10,
        webInputScreenRevision: 10,
        settleMs: 1_000,
      })).toEqual({ settled: false, remainingMs: 2_500 });

      const poller = new TraexFirstPromptReadinessPoller();
      let ticks = 0;
      poller.start({
        stillWaiting: () => true,
        nextDelayMs: () => 1_000,
        check: async () => { ticks += 1; },
      });
      poller.start({
        stillWaiting: () => true,
        nextDelayMs: () => 1_000,
        check: async () => { ticks += 1; },
      });
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ticks).toBe(2);
      poller.stop();
      expect(vi.getTimerCount()).toBe(0);

      // Phase-2 controller reschedules immediately when initialDelayMs=0 arrives during a 5s retry backoff.
      const refresh = new TraexNativeViewportRefreshController();
      let admittedCb = 0;
      let runs = 0;
      expect(refresh.trigger({
        stillNeeded: () => true,
        initialDelayMs: 0,
        retryDelayMs: 5_000,
        run: async () => { runs += 1; return runs >= 2; },
        onAdmitted: () => { admittedCb += 1; },
      })).toBe(true);
      await settleMicrotasks();
      expect(runs).toBe(1);
      expect(admittedCb).toBe(0);
      expect(vi.getTimerCount()).toBe(1);

      // Fresh arrival with initialDelayMs=0 preempts the remaining 5s retry backoff.
      expect(refresh.trigger({
        stillNeeded: () => true,
        initialDelayMs: 0,
        retryDelayMs: 5_000,
        run: async () => { runs += 1; return runs >= 2; },
        onAdmitted: () => { admittedCb += 1; },
      })).toBe(true);
      await settleMicrotasks();
      expect(runs).toBe(2);
      expect(admittedCb).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

interface FullWorkerHarness {
  scope: Record<string, any>;
  renderer: TerminalRenderer;
  idleDetector: IdleDetector;
  backend: any;
  submittedWrites: string[];
  rawWrites: string[];
  notifications: string[];
  promptReadySent: number;
  captureCalls: number;
  setNativeViewport: (screen: string, size?: PaneDimensions | null) => void;
  startReadiness: () => void;
  fireFirstPromptTimeout: (elapsedMs?: number, forced?: boolean) => void;
  markPromptReady: () => void;
  flushPending: () => Promise<void>;
  traexPending: (override?: string) => boolean;
  noteWebInput: (data: string) => void;
  handlePtyChunk: (data: string) => void;
  resyncRenderer: (nextCols?: number, nextRows?: number) => TerminalRenderer;
  invalidatePromptEvidence: () => void;
  simulateKillCli: () => void;
  dispose: () => void;
}

/**
 * Assemble REAL production worker functions (scheduleTraexFirstPromptReadiness,
 * traexNativeStartupInputIsPending, markPromptReady, flushPending, firstWriteScreen,
 * traexFirstPromptViewportRejects, noteWebTerminalInput, invalidatePromptReadinessEvidence)
 * + REAL TerminalRenderer + REAL IdleDetector + REAL TraeX adapter + fake I/O & clock.
 */
function createFullTraexColdResumeHarness(opts: {
  backendKind?: 'tmux' | 'hc';
  rendererCols?: number;
  rendererRows?: number;
  nativeSize?: PaneDimensions | null;
  nativeScreen?: string;
  queuedPrompt?: string | null;
  nativeState?: 'idle' | 'working' | 'blocked' | undefined;
  submitResult?: (content: string, index: number) => Promise<{ submitted: boolean; failureReason?: string }>;
} = {}): FullWorkerHarness {
  const backendKind = opts.backendKind ?? 'tmux';
  const rendererCols = opts.rendererCols ?? 160;
  const rendererRows = opts.rendererRows ?? 50;
  let nativeScreen = opts.nativeScreen ?? RESUME_PROVISIONAL;
  let nativeSize: PaneDimensions | null = opts.nativeSize === undefined ? { cols: 160, rows: 50 } : opts.nativeSize;
  const submittedWrites: string[] = [];
  const rawWrites: string[] = [];
  const notifications: string[] = [];
  let promptReadySent = 0;
  let captureCalls = 0;

  const realAdapter = createTraexAdapter('/bin/true');
  const resumedAdapter = {
    ...realAdapter,
    startupReadyFromHistory: (screen: string) => traexRestoredComposerReady(screen, { resumedSession: true }),
    settleInputBox: undefined,
    writeInput: vi.fn(async (_be: unknown, content: string) => {
      const idx = submittedWrites.length;
      submittedWrites.push(content);
      if (opts.submitResult) return opts.submitResult(content, idx);
      return { submitted: true };
    }),
  };

  const renderer = new TerminalRenderer(rendererCols, rendererRows);
  const idleDetector = new IdleDetector(resumedAdapter);
  if (opts.nativeState) {
    idleDetector.observeProgramStatus({ state: opts.nativeState });
  }

  const backendProto = backendKind === 'tmux' ? TmuxPipeBackend.prototype : HcBackend.prototype;
  const backend = Object.create(backendProto);
  Object.assign(backend, {
    write: vi.fn(() => true),
    kill: vi.fn(),
    resize: vi.fn(),
    captureViewport: vi.fn(() => ''),
    captureViewportAsync: vi.fn(async () => {
      captureCalls += 1;
      return nativeScreen;
    }),
    getPaneSize: vi.fn(() => nativeSize),
    getPaneSizeAsync: vi.fn(async () => nativeSize),
  });

  const base = workerSubmitHarness();
  const webInputController = new WebTerminalInputController({
    onUserInput: () => {},
    onProtocolReply: () => {},
    isActive: () => true,
  });

  const ptyGenState = { current: 1 };
  const ptyOutputGeneration = {
    snapshot: () => ptyGenState.current,
    observe: () => { ptyGenState.current += 1; },
    isCurrent: (snap: number) => snap === ptyGenState.current,
    reset: () => { ptyGenState.current = 0; },
  };

  const scope = base.scope;
  scope.pendingMessages.splice(
    0,
    scope.pendingMessages.length,
    ...(opts.queuedPrompt === null
      ? []
      : [{ turnId: 'om_cold_1', dispatchAttempt: 1, content: opts.queuedPrompt ?? 'cold resume task' }]),
  );
  Object.assign(scope, {
    backend,
    renderer,
    renderCols: rendererCols,
    renderRows: rendererRows,
    idleDetector,
    programStatusStream: { reset: vi.fn() },
    cliAdapter: resumedAdapter,
    lastInitConfig: { cliId: 'traex', resume: true, cliVersion: '0.216.0' },
    isPromptReady: false,
    promptReadyEdges: 0,
    cliSpawnGeneration: 1,
    cliLifetimeNonce: 100,
    cliInterruptGeneration: 0,
    traexControlWriteRevision: 0,
    promptReadinessRevision: 0,
    effectiveBackendType: backendKind === 'tmux' ? 'tmux' : 'hc',
    TmuxPipeBackend,
    HcBackend,
    ZmxBackend: class {},
    awaitingFirstPrompt: true,
    awaitingPostSessionStartPromptEvidence: false,
    closeRequested: false,
    cliRestartInProgress: false,
    replacementSpawnInProgress: false,
    traexNativeStartupInputPending: true,
    traexFirstInputAdmissionPending: true,
    traexFirstSubmitConfirmed: false,
    traexNativeStartupHoldLogged: false,
    traexFirstPromptDeadlineAt: Date.now() + 90_000,
    traexStartupRendererWebInputGeneration: -1,
    traexStartupRendererScreenRevision: -1,
    traexStartupRendererDrain: undefined,
    traexStartupWebRecheck: undefined,
    traexFirstPromptReadinessPoller: new TraexFirstPromptReadinessPoller(),
    traexNativeViewportEvidence: new TraexNativeViewportEvidenceStore(),
    traexNativeViewportRefresh: new TraexNativeViewportRefreshController(),
    FIRST_PROMPT_HARD_TIMEOUT_MS: 90_000,
    FIRST_PROMPT_STARTUP_RECHECK_MS: 5_000,
    READY_FLUSH_SETTLE_MS: 1_000,
    lastPtyOutputAtMs: Date.now() - 5_000,
    lastPtyActivityAtMs: Date.now() - 5_000,
    ptyOutputSeenThisSpawn: true,
    backendScreenRevision: 10,
    observedPaneGridRevision: 0,
    webResizedBackendGrid: undefined,
    ptyOutputGeneration,
    webTerminalInputGeneration: 0,
    webTerminalInputGenerationAtSpawn: 0,
    webTerminalInputGenerationAtBoundary: 0,
    webTerminalInputBackendScreenRevision: 0,
    lastWebTerminalInputAtMs: 0,
    lastWebTerminalSubmitAtMs: 0,
    webTerminalSubmitGeneration: 0,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    pendingWebTerminalInput: () => webInputController.pending,
    webTerminalInputWireDirty: () => false,
    hookReviewInputHold: false,
    heldStuckPage: () => undefined,
    traexQuestionBridgeActive: () => false,
    terminalInputSubmits: () => false,
    cliName: () => 'TRAE',
    inflightInputs: {
      ...scope.inflightInputs,
      hasUnacked: () => false,
      onTurnComplete: vi.fn(),
      takeStartedCarryOver: () => [],
      recordSent: vi.fn(),
      markSubmitted: vi.fn(),
    },
    stuckDetector: { disarm: vi.fn(), arm: vi.fn() },
    readyGate: { shouldHold: () => false, isArmed: false },
    workerSessionEventScope: undefined,
    remoteRunnerRecoveredTurnInFlight: false,
    bareShellLaunchBlocked: false,
    currentInputDeliveryQuarantine: () => null,
    currentPostTerminalInputFence: () => null,
    postTerminalInputIsBlocked: async () => false,
    stopStructuredStartGraceRecheck: vi.fn(),
    isCodexAppCliId: () => false,
    codexAppControlProven: false,
    codexAppUnprovenPromptDeferred: false,
    cliSubmissionInFlight: undefined,
    probeStartupBlocker: () => false,
    isWorkflowWorker: () => false,
    maybeEmitWorkflowTranscriptOutput: vi.fn(),
    clearPostHookEvidenceFallback: vi.fn(),
    deliverRestartInterruptionNote: vi.fn(),
    requeuedInflightAtSpawn: 0,
    sandboxWrapperAwaitingFirstPrompt: undefined,
    kimiActivityObserver: undefined,
    pendingRawInputs: [],
    pendingAdoptMessages: [],
    pendingSessionRename: null,
    codexAutoUpgrade: undefined,
    codexUpgradeTimer: undefined,
    persistCodexRunnerBuildOnReady: false,
    refreshBackgroundWait: vi.fn(),
    spawnArgvInitialPromptBusy: false,
    antigravityPendingTasks: false,
    settleRestartAttemptOnReady: vi.fn(),
    publishScreenStatus: vi.fn(),
    markTurnRetired: vi.fn(),
    classifyUsageLimitWithNativeEvidence: () => ({}),
    backgroundWaitPayload: () => ({}),
    modelRequestPayload: () => ({}),
    cancelFirstFlushSettle: vi.fn(),
    isSettlingFirstFlush: false,
    promptReadyDetectedDuringSettle: false,
    durableTurnInFlight: false,
    cliArgsSpawnedWithInitialPrompt: false,
    spawnArgvNeedsWorkingSeed: false,
    spawnArgvTurnStartEvidenceSeen: false,
    shouldSettleFirstFlush: () => false,
    scheduleFirstFlushSettle: vi.fn(),
    flushPendingInjections: vi.fn(),
    codexModelMigrationCheckNeeded: () => false,
    promotePendingHumanInterruption: () => false,
    holdForNativeSessionFork: () => false,
    stopBusyPatternIdleProbe: vi.fn(),
    spawnArgvTurnStartGateHolds: () => false,
    releaseInterruptedStructuredBridgeOnFirstPrompt: vi.fn(),
    hasStructuredLifecycleBlock: () => false,
    decideQueuedReadyTransition,
    releaseActiveTurnAuthority: vi.fn(),
    judgeClaudeBridgeTurn: () => ({}),
    bridgeQueue: { cliQueueDrained: vi.fn() },
    settleSessionRenameOnPrompt: vi.fn(),
    releaseRawInputRestartGate: vi.fn(),
    shouldFlushInjectionsFirst: () => false,
    backgroundTaskTracker: { backgroundWait: () => 0, pendingTurnAgents: () => 0, noteMainTurn: vi.fn() },
    currentBotmuxTurnId: opts.queuedPrompt === null ? undefined : 'om_cold_1',
    currentBotmuxDispatchAttempt: opts.queuedPrompt === null ? undefined : 1,
    hasPendingInputForFlush: () =>
      scope.pendingMessages.length > 0
      || scope.pendingRawInputs.length > 0
      || scope.pendingSessionRename !== null,
    freshnessInputQueue: {
      takeNormal: () => scope.pendingMessages.shift(),
      takeRaw: () => scope.pendingRawInputs.shift(),
      onPromptReady: vi.fn(),
    },
    deliverRawInput: vi.fn(async (raw: { content?: string } | string) => {
      rawWrites.push(typeof raw === 'string' ? raw : String(raw?.content ?? ''));
    }),
    firstWriteLivenessConfirmed: false,
    firstWriteSpawnedAtMs: Date.now(),
    firstWriteCaptureAtMs: 0,
    firstWriteCapturedViewport: undefined,
    FIRST_WRITE_CAPTURE_INTERVAL_MS: 1_000,
    adapterInputBoxReady: () => undefined,
    inputBoxJudgeable: () => false,
    stripAnsiScreenText: (s: string) => s,
    send: vi.fn((msg: any) => {
      if (msg?.type === 'user_notify') notifications.push(msg.message);
      if (msg?.type === 'prompt_ready') promptReadySent += 1;
    }),
    scheduleSubmitFailureNotify: vi.fn(),
    log: vi.fn(),
    requeueUnsubmittedQueuedActivation: loadWorkerFunction('requeueUnsubmittedQueuedActivation', scope),
    maybeQueuePostSubmitNativeSessionTitle: loadWorkerFunction('maybeQueuePostSubmitNativeSessionTitle', scope),
    deferTurnInputCommitUntilSubmission: loadWorkerFunction('deferTurnInputCommitUntilSubmission', scope),
  });

  const traexPending = loadWorkerFunction<(override?: string) => boolean>('traexNativeStartupInputIsPending', scope);
  const firstWriteScreen = loadWorkerFunction<() => { viewport: string | undefined; promptVisible: boolean }>('firstWriteScreen', scope);
  const traexViewportRejects = loadWorkerFunction<() => boolean>('traexFirstPromptViewportRejects', scope);
  const traexIdleComposer = loadWorkerFunction<() => boolean>('traexIdleReportScreenShowsComposer', scope);
  const noteWebInput = loadWorkerFunction<(data: string) => void>('noteWebTerminalInput', scope);
  const invalidatePromptEvidence = loadWorkerFunction<() => void>('invalidatePromptReadinessEvidence', scope);
  const scheduleReadiness = loadWorkerFunction<(be: unknown) => void>('scheduleTraexFirstPromptReadiness', scope);
  const markPromptReady = loadWorkerFunction<() => void>('markPromptReady', scope);

  scope.traexNativeStartupInputIsPending = traexPending;
  scope.firstWriteScreen = firstWriteScreen;
  scope.traexFirstPromptViewportRejects = traexViewportRejects;
  scope.traexIdleReportScreenShowsComposer = traexIdleComposer;
  scope.invalidatePromptReadinessEvidence = invalidatePromptEvidence;
  scope.firstWriteMayProceed = () => {
    if (scope.firstWriteLivenessConfirmed) return true;
    const res = firstWriteScreen();
    if (res.promptVisible) {
      scope.firstWriteLivenessConfirmed = true;
      return true;
    }
    return false;
  };

  const flushPending = base.flush;
  scope.flushPending = flushPending;
  scope.markPromptReady = markPromptReady;

  // Wire REAL IdleDetector onIdle -> REAL markPromptReady.
  idleDetector.onIdle(() => {
    if (scope.backend !== backend) return;
    markPromptReady();
  });

  // Simulate worker.ts releaseFirstPromptTimeout's TraeX 90s warning branch.
  const fireFirstPromptTimeout = (elapsedMs = 15_000, forced = false): void => {
    if (!scope.awaitingFirstPrompt || scope.backend !== backend
      || (scope.cliRestartInProgress && !scope.replacementSpawnInProgress)) return;
    if (traexPending()) {
      const remainingMs = Math.max(0, scope.FIRST_PROMPT_HARD_TIMEOUT_MS - elapsedMs);
      if (remainingMs > 0) {
        const waitMs = Math.min(scope.FIRST_PROMPT_STARTUP_RECHECK_MS, remainingMs);
        const timer = setTimeout(
          () => fireFirstPromptTimeout(elapsedMs + waitMs, elapsedMs + waitMs >= scope.FIRST_PROMPT_HARD_TIMEOUT_MS),
          waitMs,
        );
        timer.unref?.();
      } else {
        scope.send({
          type: 'user_notify',
          turnId: scope.currentBotmuxTurnId,
          message: 'TRAE 首次输入超过 90 秒仍未确认可安全投递；未在超时处强制提交或重发消息。请检查终端状态，不要重发原任务。',
        });
      }
      return;
    }
    if (forced || elapsedMs >= scope.FIRST_PROMPT_HARD_TIMEOUT_MS) {
      scope.awaitingFirstPrompt = false;
      scope.traexFirstPromptReadinessPoller.stop();
      void flushPending();
    }
  };

  const handlePtyChunk = (data: string): void => {
    scope.backendScreenRevision += 1;
    scope.traexNativeViewportEvidence.clear();
    scope.lastPtyOutputAtMs = Date.now();
    ptyOutputGeneration.observe();
    scope.renderer?.write(data);
    idleDetector.feed(data);
  };

  const resyncRenderer = (nextCols = rendererCols, nextRows = rendererRows): TerminalRenderer => {
    scope.backendScreenRevision += 1;
    scope.traexNativeViewportEvidence.clear();
    scope.lastPtyOutputAtMs = Date.now();
    const prev: TerminalRenderer | null = scope.renderer;
    const next = new TerminalRenderer(nextCols, nextRows);
    scope.renderer = next;
    prev?.dispose();
    return next;
  };

  const simulateKillCli = (): void => {
    scope.cliSpawnGeneration += 1;
    idleDetector.dispose();
    scope.idleDetector = null;
    scope.traexNativeStartupInputPending = false;
    scope.traexFirstInputAdmissionPending = false;
    scope.traexFirstSubmitConfirmed = false;
    if (scope.traexStartupWebRecheck) {
      clearTimeout(scope.traexStartupWebRecheck);
      scope.traexStartupWebRecheck = undefined;
    }
    scope.traexFirstPromptReadinessPoller.stop();
    scope.traexNativeViewportRefresh.stop();
    scope.traexNativeViewportEvidence.clear();
    scope.renderer?.dispose();
    scope.renderer = null;
    scope.backend = null;
  };

  return {
    scope,
    renderer,
    idleDetector,
    backend,
    submittedWrites,
    rawWrites,
    notifications,
    get promptReadySent() { return promptReadySent; },
    get captureCalls() { return captureCalls; },
    setNativeViewport(screen: string, size?: PaneDimensions | null) {
      nativeScreen = screen;
      if (size !== undefined) nativeSize = size;
    },
    startReadiness() {
      scheduleReadiness(backend);
    },
    fireFirstPromptTimeout,
    markPromptReady,
    flushPending,
    traexPending,
    noteWebInput,
    handlePtyChunk,
    resyncRenderer,
    invalidatePromptEvidence,
    simulateKillCli,
    dispose() {
      if (scope.traexStartupWebRecheck) {
        clearTimeout(scope.traexStartupWebRecheck);
        scope.traexStartupWebRecheck = undefined;
      }
      scope.traexFirstPromptReadinessPoller.stop();
      scope.traexNativeViewportRefresh.stop();
      scope.traexNativeViewportEvidence.clear();
      try { scope.renderer?.dispose(); } catch { /* already disposed */ }
      try { idleDetector.dispose(); } catch { /* already disposed */ }
    },
  };
}

describe('TraeX cold-resume 90s recovery and native viewport evidence propagation (#3790)', () => {
  const activeHarnesses: FullWorkerHarness[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T08:00:00.000Z'));
  });

  afterEach(() => {
    for (const h of activeHarnesses.splice(0)) h.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function track(h: FullWorkerHarness): FullWorkerHarness {
    activeHarnesses.push(h);
    return h;
  }

  it.each(['tmux', 'hc'] as const)(
    'Scenario 1 (%s): preserves 90s warning and recovers single delivery once native viewport becomes ready past 90s',
    async (backendKind) => {
      const h = track(createFullTraexColdResumeHarness({
        backendKind,
        rendererCols: 160,
        rendererRows: 50,
        nativeSize: { cols: 180, rows: 50 },
        nativeScreen: RESUME_PROVISIONAL,
        nativeState: 'idle',
        queuedPrompt: 'fix-3790-once',
      }));

      // Old renderer stays incomplete (missed footer paint), never fed ready composer bytes.
      await feedRealRenderer(h.renderer, '  TRAE CLI (v0.216.0)\r\n  initializing...\r\n');
      h.scope.lastPtyOutputAtMs = Date.now() - 5_000;

      // Start both the 15s->90s first-prompt timeout chain and the readiness poller.
      setTimeout(() => h.fireFirstPromptTimeout(15_000, false), 15_000);
      h.startReadiness();

      // Advance past the 90s warning deadline while native viewport is still provisional.
      await vi.advanceTimersByTimeAsync(95_000);
      await settleMicrotasks();

      expect(h.notifications).toHaveLength(1);
      expect(h.notifications[0]).toContain('90 秒');
      expect(h.submittedWrites).toEqual([]);
      expect(h.scope.awaitingFirstPrompt).toBe(true);
      expect(h.scope.traexNativeStartupInputPending).toBe(true);
      expect(h.scope.traexFirstInputAdmissionPending).toBe(true);
      // Exactly one low-frequency poller remains active past 90s.
      expect(vi.getTimerCount()).toBe(1);

      // Verify cadence slowed down past 90s (5s interval instead of 1s).
      const beforeSlow = h.captureCalls;
      await vi.advanceTimersByTimeAsync(10_000);
      await settleMicrotasks();
      expect(h.captureCalls - beforeSlow).toBe(2);
      expect(h.submittedWrites).toEqual([]);

      // At t = 105s+, native viewport becomes ready at 180 cols without feeding old 160-col renderer.
      h.setNativeViewport(buildWideResolvedViewport(180), { cols: 180, rows: 50 });
      await vi.advanceTimersByTimeAsync(5_500);
      await settleMicrotasks();

      // Recovered cleanly: parameterless markPromptReady & flushPending both admitted,
      // queued message submitted EXACTLY ONCE, poller stopped, global renderer untouched.
      expect(h.submittedWrites).toEqual(['fix-3790-once']);
      expect(h.promptReadySent).toBe(1);
      expect(h.scope.awaitingFirstPrompt).toBe(false);
      expect(h.scope.traexNativeStartupInputPending).toBe(false);
      expect(h.scope.traexFirstSubmitConfirmed).toBe(true);
      expect(h.scope.traexFirstInputAdmissionPending).toBe(false);
      expect(h.scope.renderer).toBe(h.renderer);
      expect(h.renderer.rawSnapshot({ preserveFormatting: true })).toContain('initializing...');
      expect(vi.getTimerCount()).toBe(0);

      // Advancing further never duplicates the submission or restarts timers.
      await vi.advanceTimersByTimeAsync(60_000);
      await settleMicrotasks();
      expect(h.submittedWrites).toEqual(['fix-3790-once']);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('Scenario 2: same-generation renderer replacement (onBackendScreenResync) discards only the in-flight sample without killing the observation chain', async () => {
    const h = track(createFullTraexColdResumeHarness({
      backendKind: 'hc',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: 'resync-survives',
    }));

    let releaseFirstCapture!: (s: string) => void;
    let first = true;
    h.backend.captureViewportAsync = vi.fn(() => {
      if (first) {
        first = false;
        return new Promise<string>(resolve => { releaseFirstCapture = resolve; });
      }
      return Promise.resolve(RESUME_RESOLVED);
    });

    h.startReadiness();
    await vi.advanceTimersByTimeAsync(1_100);
    await settleMicrotasks();

    // Legitimate same-generation renderer replacement (e.g., hc attach resync) mid-capture!
    const replacementRenderer = h.resyncRenderer(160, 50);
    expect(h.scope.renderer).toBe(replacementRenderer);
    expect(h.scope.cliSpawnGeneration).toBe(1);

    // Resolve stale in-flight capture: discarded without premature admission or stale evidence.
    releaseFirstCapture(RESUME_RESOLVED);
    await settleMicrotasks();
    expect(h.submittedWrites).toEqual([]);
    expect(h.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);
    expect(h.scope.traexNativeStartupInputPending).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    // Once quiet window passes on the new renderer, the surviving poller recovers cleanly.
    await vi.advanceTimersByTimeAsync(3_500);
    await settleMicrotasks();
    expect(h.submittedWrites).toEqual(['resync-survives']);
    expect(h.scope.awaitingFirstPrompt).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Scenario 3: handles native column/row mismatches safely (380-col wide, 120-row login veto, mid-capture resize fail-closed, webResizedGrid != tmux attach without livelock)', async () => {
    // 3a. Ultrawide 380x60 native viewport on a 160x50 old renderer recovers cleanly.
    const wide = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      rendererCols: 160,
      rendererRows: 50,
      nativeSize: { cols: 380, rows: 60 },
      nativeScreen: buildWideResolvedViewport(380),
      queuedPrompt: 'wide-380-task',
    }));
    wide.scope.webResizedBackendGrid = { backend: wide.backend, cols: 200, rows: 55 };
    wide.startReadiness();
    await vi.advanceTimersByTimeAsync(1_200);
    await settleMicrotasks();
    expect(wide.submittedWrites).toEqual(['wide-380-task']);

    // 3b. Tall 160x120 pane with row-0 Sign in banner MUST stay held.
    const tallLogin = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      rendererCols: 160,
      rendererRows: 50,
      nativeSize: { cols: 160, rows: 120 },
      nativeScreen: buildWideResolvedViewport(160, { topBanner: 'Sign in to TRAE CLI', extraBlankRows: 100 }),
      queuedPrompt: 'must-not-deliver-on-login',
    }));
    tallLogin.startReadiness();
    await vi.advanceTimersByTimeAsync(10_000);
    await settleMicrotasks();
    expect(tallLogin.submittedWrites).toEqual([]);
    expect(tallLogin.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);

    // 3c. Mid-capture resize (sizeBefore 180x50 != sizeAfter 160x50) MUST fail closed.
    const resized = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      rendererCols: 160,
      rendererRows: 50,
      nativeSize: { cols: 180, rows: 50 },
      nativeScreen: buildWideResolvedViewport(180),
      queuedPrompt: 'must-not-deliver-on-resize-skew',
    }));
    let sizeCalls = 0;
    resized.backend.getPaneSizeAsync = vi.fn(async () => {
      sizeCalls += 1;
      return sizeCalls % 2 === 1 ? { cols: 180, rows: 50 } : { cols: 160, rows: 50 };
    });
    resized.startReadiness();
    await vi.advanceTimersByTimeAsync(3_000);
    await settleMicrotasks();
    expect(resized.submittedWrites).toEqual([]);
    expect(resized.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);
    expect(resized.scope.traexNativeStartupInputPending).toBe(true);
  });

  it('Scenario 4: generation change, Web input, PTY output, /stop control writes, downstream readyGate veto, and failed write immediately invalidate without mis-submission', async () => {
    // 4a. Mid-capture Web terminal human input discards sample and never admits a pasted draft.
    const webRace = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: 'must-not-clobber-human-draft',
    }));
    let releaseCapture!: (s: string) => void;
    let firstCapture = true;
    webRace.backend.captureViewportAsync = vi.fn(() => {
      if (firstCapture) {
        firstCapture = false;
        return new Promise<string>(resolve => { releaseCapture = resolve; });
      }
      return Promise.resolve(RESUME_RESOLVED_PASTED);
    });
    webRace.startReadiness();
    await vi.advanceTimersByTimeAsync(1_100);
    await settleMicrotasks();

    webRace.noteWebInput('draft');
    releaseCapture(RESUME_RESOLVED);
    await settleMicrotasks();
    expect(webRace.submittedWrites).toEqual([]);
    expect(webRace.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);
    expect(webRace.scope.traexNativeStartupInputPending).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    await settleMicrotasks();
    expect(webRace.submittedWrites).toEqual([]);
    webRace.dispose();

    // 4b. New PTY output AND /stop (invalidatePromptReadinessEvidence) invalidate published evidence immediately.
    const ptyRace = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: null,
    }));
    ptyRace.startReadiness();
    await vi.advanceTimersByTimeAsync(1_200);
    await settleMicrotasks();
    expect(ptyRace.scope.awaitingFirstPrompt).toBe(false);
    expect(ptyRace.scope.traexNativeViewportEvidence.hasEntry()).toBe(true);
    expect(ptyRace.traexPending()).toBe(false);

    ptyRace.invalidatePromptEvidence();
    expect(ptyRace.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);
    expect(ptyRace.traexPending()).toBe(true);
    ptyRace.dispose();

    const ptyChunkRace = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: null,
    }));
    ptyChunkRace.startReadiness();
    await vi.advanceTimersByTimeAsync(1_200);
    await settleMicrotasks();
    expect(ptyChunkRace.scope.traexNativeViewportEvidence.hasEntry()).toBe(true);
    ptyChunkRace.handlePtyChunk('  model: loading...\r\n');
    expect(ptyChunkRace.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);
    expect(ptyChunkRace.traexPending()).toBe(true);
    ptyChunkRace.dispose();

    // 4c. Downstream readyGate.shouldHold() AND hookReviewInputHold must NOT mutate traexNativeStartupInputPending = false.
    const gateHeld = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: 'held-by-ready-gate',
    }));
    gateHeld.scope.readyGate = { shouldHold: () => true, isArmed: true };
    gateHeld.startReadiness();
    await vi.advanceTimersByTimeAsync(2_200);
    await settleMicrotasks();
    expect(gateHeld.submittedWrites).toEqual([]);
    expect(gateHeld.scope.traexNativeStartupInputPending).toBe(true);
    expect(gateHeld.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);

    // Generation change immediately stops poller (0 timers).
    gateHeld.scope.cliSpawnGeneration += 1;
    await vi.advanceTimersByTimeAsync(2_000);
    await settleMicrotasks();
    expect(vi.getTimerCount()).toBe(0);
    gateHeld.dispose();

    // 4d. Pre-write failure clears evidence AND breaks batch so M2 cannot bypass first-input admission
    // even if the renderer still shows a resolved frame before overlay bytes arrive.
    const writeFail = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: 'fail-write-1',
      submitResult: async () => {
        writeFail.setNativeViewport(RESUME_RESOLVED_PASTED, { cols: 160, rows: 50 });
        return { submitted: false, failureReason: 'composer blocked' };
      },
    }));
    // Pre-populate renderer with RESOLVED so M2's safety relies specifically on the
    // unconfirmed-first-submit batch break (not only on missing stream evidence).
    await feedRealRenderer(writeFail.renderer, RESUME_RESOLVED.replace(/\r?\n/g, '\r\n'));
    writeFail.scope.lastPtyOutputAtMs = Date.now() - 5_000;
    writeFail.scope.shouldStopPendingBatch = () => false;
    writeFail.scope.pendingMessages.push({ turnId: 'om_cold_2', dispatchAttempt: 1, content: 'must-not-bypass-2' });
    writeFail.startReadiness();
    await vi.advanceTimersByTimeAsync(1_200);
    await settleMicrotasks();
    expect(writeFail.submittedWrites).toEqual(['fail-write-1']);
    expect(writeFail.scope.pendingMessages.map((m: any) => m.content)).toEqual(['must-not-bypass-2']);
    expect(writeFail.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);
    expect(writeFail.scope.traexFirstSubmitConfirmed).toBe(false);
    expect(writeFail.scope.traexFirstInputAdmissionPending).toBe(true);
  });

  it('Scenario 5: empty-queue post-90s recovery -> redraw -> post-90s Web focus -> late first message delivers via Phase-2 refresh', async () => {
    const h = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      rendererCols: 160,
      rendererRows: 50,
      nativeSize: { cols: 180, rows: 50 },
      nativeScreen: RESUME_PROVISIONAL,
      queuedPrompt: null,
    }));

    h.startReadiness();
    await vi.advanceTimersByTimeAsync(95_000);
    await settleMicrotasks();
    expect(h.scope.awaitingFirstPrompt).toBe(true);

    // Native viewport recovers at t=100s with an empty queue -> Phase-1 poller stops cleanly (0 timers).
    h.setNativeViewport(buildWideResolvedViewport(180), { cols: 180, rows: 50 });
    await vi.advanceTimersByTimeAsync(5_500);
    await settleMicrotasks();
    expect(h.scope.awaitingFirstPrompt).toBe(false);
    expect(h.scope.traexFirstInputAdmissionPending).toBe(true);
    expect(h.scope.traexFirstSubmitConfirmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // Harmless PTY chunk + Web focus event arrive at t=105s.
    await vi.advanceTimersByTimeAsync(5_000);
    h.handlePtyChunk('\x1b[1;1H◆');
    expect(h.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);
    h.noteWebInput('\x1b[I');
    await vi.advanceTimersByTimeAsync(500);

    // User sends first IM message inside the 3s Web-input settle window.
    h.scope.pendingMessages.push({ turnId: 'om_late_1', dispatchAttempt: 1, content: 'late-first-message' });
    await h.flushPending();
    expect(h.submittedWrites).toEqual([]);

    // Once Web-input settle elapses, Phase-2 refresh probes native viewport and delivers ONCE.
    await vi.advanceTimersByTimeAsync(3_000);
    await settleMicrotasks();
    expect(h.submittedWrites).toEqual(['late-first-message']);
    expect(h.scope.traexFirstSubmitConfirmed).toBe(true);
    expect(h.scope.traexFirstInputAdmissionPending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Scenario 6: follow-up M2 does not deadlock when M1 confirmed with concurrent Web input (traexFirstSubmitConfirmed=true while traexFirstInputAdmissionPending=true)', async () => {
    let releaseM1!: () => void;
    const h = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: 'M1-first',
      submitResult: async (content) => {
        if (content === 'M1-first') {
          await new Promise<void>(resolve => { releaseM1 = resolve; });
        }
        return { submitted: true };
      },
    }));

    h.startReadiness();
    await vi.advanceTimersByTimeAsync(1_200);
    await settleMicrotasks();
    expect(h.submittedWrites).toEqual(['M1-first']);

    // Human presses a Web key while M1's writeInput is in flight!
    h.noteWebInput('\x1b[I');
    releaseM1();
    await settleMicrotasks();
    expect(h.scope.traexFirstSubmitConfirmed).toBe(true);
    expect(h.scope.traexFirstInputAdmissionPending).toBe(true);
    expect(h.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);

    // Advance past Web settle and send M2: Phase-2 refresh MUST run, retire the lease, and deliver M2!
    await vi.advanceTimersByTimeAsync(3_500);
    h.scope.pendingMessages.push({ turnId: 'om_cold_2', dispatchAttempt: 1, content: 'M2-followup' });
    await h.flushPending();
    await vi.advanceTimersByTimeAsync(50);
    await settleMicrotasks();

    expect(h.submittedWrites).toEqual(['M1-first', 'M2-followup']);
    expect(h.scope.traexFirstInputAdmissionPending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Scenario 7: Phase-2 refresh re-drives prompt readiness for raw commands (/clear) when isPromptReady=false and handles arrivals during isFlushing', async () => {
    const h = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: null,
    }));

    // Phase-1 recovers with empty queue.
    h.startReadiness();
    await vi.advanceTimersByTimeAsync(1_200);
    await settleMicrotasks();
    expect(h.scope.awaitingFirstPrompt).toBe(false);
    expect(h.scope.isPromptReady).toBe(true);

    // Human runs a Web turn -> busy revokes prompt readiness and clears evidence.
    h.scope.isPromptReady = false;
    h.invalidatePromptEvidence();
    expect(h.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);

    // User sends /clear into pendingRawInputs -> Phase-2 refreshes, re-drives seedReadyEvidence -> markPromptReady -> delivers /clear!
    h.scope.pendingRawInputs.push({ content: '/clear' });
    await h.flushPending();
    await vi.advanceTimersByTimeAsync(3_500);
    await settleMicrotasks();

    expect(h.scope.isPromptReady).toBe(true);
    expect(h.rawWrites).toEqual(['/clear']);
    expect(h.scope.pendingRawInputs).toEqual([]);
  });

  it('Scenario 8: pre-dequeue revalidation blocks paste if PTY Sign-in arrives during awaited flush checks, and stale Gen-1 probe never wipes Gen-2 live evidence', async () => {
    // 8a. PTY chunk arriving AFTER firstWriteMayProceed() during await settleInputBox()
    // revokes first-write admission right before takeNormal() (never pastes into Sign in).
    const h = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: 'must-not-paste-into-signin',
    }));
    let releaseSettleBox!: (refused: string | undefined) => void;
    let firstSettleBox = true;
    h.scope.inputBoxJudgeable = () => true;
    h.scope.cliAdapter.settleInputBox = vi.fn(() => {
      if (firstSettleBox) {
        firstSettleBox = false;
        return new Promise<string | undefined>(resolve => { releaseSettleBox = resolve; });
      }
      return Promise.resolve(undefined);
    });

    h.startReadiness();
    await vi.advanceTimersByTimeAsync(1_200);
    await settleMicrotasks();
    expect(h.scope.firstWriteLivenessConfirmed).toBe(true);

    // While flushPending is awaiting settleInputBox (after firstWriteMayProceed passed),
    // native pane switches to Sign in and emits a PTY chunk clearing native evidence!
    h.setNativeViewport(buildWideResolvedViewport(160, { topBanner: 'Sign in to TRAE CLI' }), { cols: 160, rows: 50 });
    h.handlePtyChunk('Sign in to TRAE CLI\r\n');
    releaseSettleBox(undefined);
    await settleMicrotasks();

    // Must NOT have pasted into Sign in! Message stays safely queued.
    expect(h.submittedWrites).toEqual([]);
    expect(h.scope.pendingMessages.map((m: any) => m.content)).toEqual(['must-not-paste-into-signin']);
    h.dispose();

    // 8b. Stale Gen-1 in-flight probe resolving after Gen-2 publishes MUST NOT wipe Gen-2 live evidence.
    const gen1 = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: null,
    }));
    let releaseGen1Capture!: (s: string) => void;
    gen1.backend.captureViewportAsync = vi.fn(() => new Promise<string>(resolve => { releaseGen1Capture = resolve; }));
    gen1.startReadiness();
    await vi.advanceTimersByTimeAsync(1_100);
    await settleMicrotasks();

    // Simulate /restart advancing to Gen 2 and publishing Gen-2 evidence in the shared store.
    const gen2Backend = Object.create(TmuxPipeBackend.prototype);
    Object.assign(gen2Backend, {
      captureViewportAsync: vi.fn(async () => RESUME_RESOLVED),
      getPaneSizeAsync: vi.fn(async () => ({ cols: 160, rows: 50 })),
    });
    const gen2Renderer = new TerminalRenderer(160, 50);
    gen1.scope.cliSpawnGeneration = 2;
    gen1.scope.cliLifetimeNonce = 200;
    gen1.scope.backend = gen2Backend;
    gen1.scope.renderer = gen2Renderer;
    gen1.scope.traexNativeViewportEvidence.publish({
      scope: {
        backend: gen2Backend,
        spawnGeneration: 2,
        lifetimeNonce: 200,
        renderer: gen2Renderer,
        screenRevision: gen1.scope.backendScreenRevision,
        outputGeneration: 1,
        webInputGeneration: 0,
        controlWriteRevision: 0,
        interruptGeneration: 0,
        gridRevision: 0,
        webResizedGrid: null,
        paneSize: { cols: 160, rows: 50 },
        syncPaneSize: undefined,
      },
      formattedScreen: RESUME_RESOLVED,
      plainScreen: RESUME_RESOLVED,
      webInputSettled: true,
      capturedAtMs: Date.now(),
    });

    // Now stale Gen-1 capture resolves -> must NOT wipe Gen-2's live evidence!
    releaseGen1Capture(RESUME_RESOLVED);
    await settleMicrotasks();
    expect(gen1.scope.traexNativeViewportEvidence.hasEntry()).toBe(true);
    expect(gen1.traexPending()).toBe(false);
    gen2Renderer.dispose();
  });

  it('Scenario 9: SPINNER_GUARD_MS reuses valid native evidence without self-invalidation, OSC working with empty queue skips captures, and killCli leaves zero leaked timers', async () => {
    // 9a. Transient empty capture on Tick 2 during SPINNER_GUARD_MS must not wipe Tick 1's valid evidence.
    const spinner = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_RESOLVED,
      queuedPrompt: 'spinner-safe',
    }));
    // Arm IdleDetector's 3s SPINNER_GUARD_MS right before Tick 1.
    spinner.idleDetector.reset();
    let capAttempt = 0;
    spinner.backend.captureViewportAsync = vi.fn(async () => {
      capAttempt += 1;
      return capAttempt === 1 ? RESUME_RESOLVED : '';
    });
    spinner.startReadiness();
    await vi.advanceTimersByTimeAsync(1_200);
    await settleMicrotasks();
    expect(capAttempt).toBe(1);
    expect(spinner.scope.traexNativeViewportEvidence.hasEntry()).toBe(true);
    expect(spinner.submittedWrites).toEqual([]); // Still inside 3s spinner guard!

    // Advance 1s: Tick 2 reuses valid evidence without re-capturing or self-invalidating.
    await vi.advanceTimersByTimeAsync(1_000);
    await settleMicrotasks();
    expect(capAttempt).toBe(1);
    expect(spinner.scope.traexNativeViewportEvidence.hasEntry()).toBe(true);

    // Advance past 3.2s spinner guard -> quiescence fires and delivers cleanly ONCE!
    await vi.advanceTimersByTimeAsync(2_000);
    await settleMicrotasks();
    expect(spinner.submittedWrites).toEqual(['spinner-safe']);
    expect(capAttempt).toBe(1);
    spinner.dispose();

    // 9b. killCli leaves zero leaked timers.
    const teardown = track(createFullTraexColdResumeHarness({
      backendKind: 'tmux',
      nativeSize: { cols: 160, rows: 50 },
      nativeScreen: RESUME_PROVISIONAL,
    }));
    teardown.startReadiness();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(vi.getTimerCount()).toBe(1);

    teardown.simulateKillCli();
    expect(vi.getTimerCount()).toBe(0);
    expect(teardown.scope.traexNativeViewportEvidence.hasEntry()).toBe(false);
  });
});
