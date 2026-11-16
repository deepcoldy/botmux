import { describe, expect, it, vi } from 'vitest';
import { shouldFenceTraexStartupInput, traexStartupInputReady } from '../src/core/traex-startup-input.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { traexRestoredComposerReady } from '../src/adapters/cli/traex-footer.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS } from '../src/utils/codex-app-control.js';

const SHORTCUT = [
  '  █ ◆ ◆ █  TRAE CLI (v0.214.1)',
  '  /tmp/native-control', '  permissions: YOLO mode',
  '──────────────────────────────────────────────────────────',
  '❯ Ask TRAE CLI to do anything',
  '──────────────────────────────────────────────────────────',
  '  ? for shortcuts',
].join('\n');
const RESOLVED = SHORTCUT.replace('  ? for shortcuts',
  '  GPT-6-Astra · /tmp/native-control · Context —\n  ☢ Full Access · ? for shortcuts · ← for agents');
const readyPattern = createTraexAdapter('/bin/true').readyPattern;
const ready = (screen: string, options: Partial<Parameters<typeof traexStartupInputReady>[0]> = {}) =>
  traexStartupInputReady({ screen, readyPattern, webInputUnchanged: true, blockingOwner: false, ...options });

describe('native thread readiness is distinct from a provisional input box', () => {
  it('preserves legacy recognition but refuses a fresh hint-only surface without native evidence', () => {
    expect(traexRestoredComposerReady(SHORTCUT)).toBe(true);
    expect(ready(SHORTCUT)).toBe(false);
    expect(ready(SHORTCUT.replace('? for shortcuts', '⚠ 1 warning · f2 to view'))).toBe(false);
  });

  it('accepts native idle behind a composer, including a still-provisional model footer', () => {
    expect(ready(SHORTCUT, { nativeState: 'idle' })).toBe(true);
    expect(ready(SHORTCUT, { nativeState: 'done' })).toBe(true);
    expect(ready(SHORTCUT, { nativeState: 'idle', webInputUnchanged: false })).toBe(false);
  });

  it('recovers a resolved footer when the startup report was missed', () => {
    expect(ready(RESOLVED)).toBe(true);
    // MCP boot can be busy after thread initialization; input remains accepted.
    expect(ready(RESOLVED, { nativeState: 'working' })).toBe(true);
    expect(ready(RESOLVED.replace('GPT-6-Astra', 'loading'))).toBe(false);
  });

  it('accepts an unknown status footer only after native idle and below an empty composer rule', () => {
    const unknown = SHORTCUT.replace('? for shortcuts', 'ⓘ Plan mode · new footer layout');
    expect(traexRestoredComposerReady(unknown)).toBe(false);
    expect(ready(unknown)).toBe(false);
    expect(ready(unknown, { nativeState: 'working' })).toBe(false);
    for (const nativeState of ['idle', 'done'] as const) {
      expect(ready(unknown, { nativeState })).toBe(true);
      expect(ready(unknown, { nativeState, webInputUnchanged: false })).toBe(false);
      expect(ready(unknown, { nativeState, blockingOwner: true })).toBe(false);
      expect(ready(unknown.replace('Ask TRAE CLI to do anything', 'unsent draft'), { nativeState })).toBe(false);
      expect(ready(unknown.replace('❯ Ask TRAE CLI to do anything\n', '❯ Ask TRAE CLI to do anything\n  draft continuation\n'), { nativeState })).toBe(false);
      expect(ready(unknown.replace('❯ Ask TRAE CLI to do anything\n──────────────────────────────────────────────────────────\n',
        '❯ Ask TRAE CLI to do anything\n'), { nativeState })).toBe(false);
      expect(ready(`Sign in to TraeCode CLI\n${unknown}`, { nativeState })).toBe(false);
    }
  });

  it('does not treat other native states or a blocking owner as idle evidence', () => {
    for (const nativeState of ['working', 'blocked', 'error', 'clear'] as const) {
      expect(ready(SHORTCUT, { nativeState })).toBe(false);
    }
    for (const nativeState of ['blocked', 'error', 'clear'] as const) {
      expect(ready(RESOLVED, { nativeState })).toBe(false);
    }
    expect(ready(SHORTCUT, { nativeState: 'idle', blockingOwner: true })).toBe(false);
    expect(ready(RESOLVED, { blockingOwner: true })).toBe(false);
  });

  it('refuses missing screens, drafts, selectors and sign-in despite an idle report', () => {
    for (const screen of [
      '', 'No input surface',
      SHORTCUT.replace('Ask TRAE CLI to do anything', 'my unsent draft'),
      SHORTCUT.replace('Ask TRAE CLI to do anything', '1. Choose a model'),
      RESOLVED.replace('❯ Ask TRAE CLI to do anything\n', '❯ Ask TRAE CLI to do anything\n  wrapped draft continuation\n'),
      SHORTCUT.replace('❯ Ask TRAE CLI to do anything\n', '❯ Ask TRAE CLI to do anything\n  wrapped draft continuation\n'),
      'Sign in to TraeCode CLI\n❯ 1. Sign in with browser',
    ]) {
      expect(ready(screen, { nativeState: 'idle' })).toBe(false);
    }
  });
});

describe('only a fresh verified native terminal gets the fence', () => {
  it('arms the verified fresh TraeX path', () => {
    expect(shouldFenceTraexStartupInput({ cliId: 'traex', programStatusEnabled: true })).toBe(true);
  });
  it('keeps legacy CLI versions, other CLIs, resumes, adopts, viewers and persistent panes unchanged', () => {
    for (const scope of [
      { cliId: 'traex', programStatusEnabled: false },
      { cliId: 'codex', programStatusEnabled: true },
      { cliId: 'traex', programStatusEnabled: true, resume: true },
      { cliId: 'traex', programStatusEnabled: true, adoptMode: true },
      { cliId: 'traex', programStatusEnabled: true, remoteViewer: true },
      { cliId: 'traex', programStatusEnabled: true, persistentReattach: true },
    ]) expect(shouldFenceTraexStartupInput(scope)).toBe(false);
  });
});

function workerFence() {
  const h = workerSubmitHarness();
  Object.assign(h.scope, {
    traexNativeStartupInputPending: true,
    traexFirstInputAdmissionPending: true,
    traexStartupRendererWebInputGeneration: -1,
    backendScreenRevision: 0, webTerminalInputBackendScreenRevision: 0,
    READY_FLUSH_SETTLE_MS: 1_000,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    screen: SHORTCUT,
    nativeState: undefined,
    renderer: { rawSnapshot: () => h.scope.screen, markNewTurn: vi.fn(), writeAndFlush: vi.fn(async () => {}) },
    cliAdapter: { ...h.scope.cliAdapter, readyPattern },
    idleDetector: {
      isStartupPending: () => false,
      programStatusHeldWorking: () => false,
      lastProgramStatusReport: () => h.scope.nativeState,
    },
    webTerminalInputGeneration: 0, webTerminalInputGenerationAtSpawn: 0,
    lastWebTerminalInputAtMs: 0, webTerminalSubmitGeneration: 0,
    terminalInputSubmits: () => false,
    hookReviewInputHold: false, heldStuckPage: () => undefined,
    // No native question card or session-title operation in this fixture.
    traexQuestionBridgeActive: () => false,
  });
  h.scope.requeueUnsubmittedQueuedActivation = loadWorkerFunction('requeueUnsubmittedQueuedActivation', h.scope);
  h.scope.maybeQueuePostSubmitNativeSessionTitle = loadWorkerFunction('maybeQueuePostSubmitNativeSessionTitle', h.scope);
  h.scope.deferTurnInputCommitUntilSubmission = loadWorkerFunction('deferTurnInputCommitUntilSubmission', h.scope);
  return h;
}

describe('the actual pending-input writer honors native startup evidence', () => {
  it('does not dequeue or paste from a screen-only type-ahead arrival', async () => {
    const h = workerFence();
    await h.flush();
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.beginCliWriteCycle).not.toHaveBeenCalled();
    expect(h.scope.traexNativeStartupInputPending).toBe(true);
  });

  it('retires the fence on a real idle and delivers the queued input once', async () => {
    const h = workerFence();
    h.scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));
    await h.flush();
    h.scope.nativeState = 'idle';
    await h.flush();
    await h.flush();
    expect(h.scope.log.mock.calls.filter(([line]: [string]) => line.startsWith('writeInput threw:'))).toEqual([]);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.traexNativeStartupInputPending).toBe(false);
  });

  it('does not open on an idle while a changed web draft owns the composer', async () => {
    const h = workerFence();
    h.scope.nativeState = 'idle';
    h.scope.webTerminalInputGeneration = 1;
    h.scope.screen = RESOLVED.replace('Ask TRAE CLI to do anything', 'a human draft');
    // Long after that input, the fence drains the renderer and judges the
    // current frame. The drained frame still shows the human draft.
    h.scope.markPromptReady = vi.fn();
    h.scope.flushPending = vi.fn(() => h.flush());
    await h.flush();
    await new Promise(resolve => setTimeout(resolve, 0));
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.traexNativeStartupInputPending).toBe(true);
  });

  it('cannot retire startup on a snapshot from a restarting generation', () => {
    const h = workerFence();
    h.scope.cliRestartInProgress = true;
    h.scope.nativeState = 'idle';
    const pending = loadWorkerFunction<(screen?: string) => boolean>('traexNativeStartupInputIsPending', h.scope);
    expect(pending(RESOLVED)).toBe(true);
    expect(h.scope.traexNativeStartupInputPending).toBe(true);
  });

  it('accepts the current fresh replacement without accepting a teardown generation', () => {
    const h = workerFence();
    h.scope.cliRestartInProgress = true;
    h.scope.replacementSpawnInProgress = true;
    h.scope.nativeState = 'idle';
    const pending = loadWorkerFunction<(screen?: string) => boolean>('traexNativeStartupInputIsPending', h.scope);
    expect(pending(RESOLVED)).toBe(false);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
  });

  it('recovers an empty post-dialog frame only after its current Web epoch is drained', async () => {
    vi.useFakeTimers();
    try {
      const h = workerFence();
      h.scope.nativeState = 'idle';
      h.scope.screen = RESOLVED;
      h.scope.markPromptReady = vi.fn();
      h.scope.flushPending = vi.fn();
      h.scope.renderer.writeAndFlush = vi.fn(async () => {});
      const note = loadWorkerFunction<(data: string) => void>('noteWebTerminalInput', h.scope);
      const pending = loadWorkerFunction<() => boolean>('traexNativeStartupInputIsPending', h.scope);
      note('\x1b');
      expect(pending()).toBe(true);
      h.scope.backendScreenRevision++;
      await vi.advanceTimersByTimeAsync(h.scope.READY_FLUSH_SETTLE_MS);
      expect(pending()).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.scope.renderer.writeAndFlush).toHaveBeenCalledOnce();
      expect(pending()).toBe(false);
      expect(h.scope.pendingMessages).toHaveLength(1);
      h.scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));
      await h.flush();
      expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
      expect(h.scope.traexFirstInputAdmissionPending).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('ignores a renderer-drain completion whose Web epoch was replaced', async () => {
    vi.useFakeTimers();
    try {
      const h = workerFence();
      let release!: () => void;
      h.scope.renderer.writeAndFlush = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
      h.scope.markPromptReady = vi.fn();
      h.scope.flushPending = vi.fn();
      const note = loadWorkerFunction<(data: string) => void>('noteWebTerminalInput', h.scope);
      const pending = loadWorkerFunction<() => boolean>('traexNativeStartupInputIsPending', h.scope);
      note('first intervention');
      h.scope.backendScreenRevision++;
      await vi.advanceTimersByTimeAsync(h.scope.READY_FLUSH_SETTLE_MS);
      expect(pending()).toBe(true);
      note('newer intervention');
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.scope.markPromptReady).not.toHaveBeenCalled();
      expect(h.scope.flushPending).not.toHaveBeenCalled();
      expect(h.scope.traexNativeStartupInputPending).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps an uninitialized first input queued through the real soft and hard timeout callback', async () => {
    vi.useFakeTimers();
    try {
      const h = workerFence();
      const hardCap = CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS;
      Object.assign(h.scope, {
        awaitingFirstPrompt: true, firstPromptBackend: h.scope.backend,
        firstPromptGeneration: h.scope.cliSpawnGeneration,
        cfg: { cliId: 'traex' }, holdFirstPromptForStartupBlocker: () => false,
        FIRST_PROMPT_HARD_TIMEOUT_MS: hardCap, FIRST_PROMPT_STARTUP_RECHECK_MS: 1_000,
        // Observable effects should the callback accidentally release startup.
        adapterInputBoxReady: () => true,
        shouldReleaseFirstPromptTimeout: () => true,
        awaitingPostSessionStartPromptEvidence: false,
        clearPostHookEvidenceFallback: vi.fn(),
        cancelFirstFlushSettle: vi.fn(),
        decideHardTimeoutAction: () => 'flush',
        shouldArmFirstPromptTimeoutPromptSeed: () => false,
        flushPending: vi.fn(),
      });
      const timeout = loadWorkerFunction<(elapsed: number, forced: boolean) => void>('releaseFirstPromptTimeout', h.scope);
      timeout(0, false);
      expect(h.scope.flushPending).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(hardCap);
      expect(h.scope.awaitingFirstPrompt).toBe(true);
      expect(h.scope.pendingMessages).toHaveLength(1);
      expect(h.scope.traexNativeStartupInputPending).toBe(true);
      expect(h.scope.flushPending).not.toHaveBeenCalled();
      expect(h.scope.send.mock.calls.filter(([event]: [{ type: string }]) => event.type === 'user_notify')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a non-TraeX hard-cap release and rejects the same timer after generation replacement', () => {
    const h = workerFence();
    Object.assign(h.scope, {
      traexNativeStartupInputPending: false, traexFirstInputAdmissionPending: false,
      awaitingFirstPrompt: true, firstPromptBackend: h.scope.backend,
      firstPromptGeneration: h.scope.cliSpawnGeneration, cfg: { cliId: 'dsh-tui' },
      holdFirstPromptForStartupBlocker: () => false,
      FIRST_PROMPT_HARD_TIMEOUT_MS: CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS,
      adapterInputBoxReady: () => true, shouldReleaseFirstPromptTimeout: () => true,
      awaitingPostSessionStartPromptEvidence: false,
      clearPostHookEvidenceFallback: vi.fn(), cancelFirstFlushSettle: vi.fn(),
      decideHardTimeoutAction: () => 'mark-ready', markPromptReady: vi.fn(),
    });
    const timeout = loadWorkerFunction<(elapsed: number, forced: boolean) => void>('releaseFirstPromptTimeout', h.scope);
    timeout(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS, true);
    expect(h.scope.markPromptReady).toHaveBeenCalledOnce();
    h.scope.markPromptReady.mockClear();
    h.scope.awaitingFirstPrompt = true;
    h.scope.cliSpawnGeneration++;
    timeout(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS, true);
    expect(h.scope.markPromptReady).not.toHaveBeenCalled();
  });
});
