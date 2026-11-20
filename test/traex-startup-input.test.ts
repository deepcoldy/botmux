import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('does not let native idle override the provisional shortcut-only composer', () => {
    // Recorded 0.214.1 / 0.216.0: with a stale model catalog and a slow
    // network the TUI reports idle on this frame for ~30s and drops Enter.
    for (const nativeState of ['idle', 'done'] as const) {
      expect(ready(SHORTCUT, { nativeState })).toBe(false);
      expect(ready(SHORTCUT.replace('? for shortcuts', '⚠ 1 warning · f2 to view'), { nativeState })).toBe(false);
      expect(ready(RESOLVED, { nativeState })).toBe(true);
    }
    expect(ready(RESOLVED, { nativeState: 'idle', webInputUnchanged: false })).toBe(true);
  });

  it('still lets native idle vouch for the repository notice that hides both footer rows', () => {
    const notice = SHORTCUT.replace('? for shortcuts', '无法访问 Git 仓库 `git@example.invalid`，请确认该仓库权限或地址。');
    expect(ready(notice)).toBe(false);
    expect(ready(notice, { nativeState: 'idle' })).toBe(true);
  });

  it('judges the recorded 0.216.0 cold-resume frames by their footer, not by the idle report', () => {
    const frame = (name: string) => readFileSync(`test/fixtures/traex-cold-resume/0.216.0-resume-${name}.txt`, 'utf8');
    // The restored-screen recognizer still sees a composer on the provisional
    // frame; only the first-input fence demands the resolved footer.
    expect(traexRestoredComposerReady(frame('provisional'), { resumedSession: true })).toBe(true);
    expect(ready(frame('provisional'), { nativeState: 'idle' })).toBe(false);
    expect(ready(frame('provisional'))).toBe(false);
    expect(ready(frame('resolved'), { nativeState: 'idle' })).toBe(true);
    expect(ready(frame('resolved'))).toBe(true);
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

describe('only a verified native terminal this worker launches gets the fence', () => {
  it('arms the verified fresh and cold-resumed TraeX paths', () => {
    expect(shouldFenceTraexStartupInput({ cliId: 'traex', programStatusEnabled: true })).toBe(true);
  });
  it('keeps legacy CLI versions, other CLIs, adopts, viewers and persistent panes unchanged', () => {
    for (const scope of [
      { cliId: 'traex', programStatusEnabled: false },
      { cliId: 'codex', programStatusEnabled: true },
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
    traexFirstPromptDeadlineAt: Date.now() + 90_000,
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
    lastWebTerminalInputAtMs: 0, lastWebTerminalSubmitAtMs: 0, webTerminalSubmitGeneration: 0,
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

  it('holds through an idle on the provisional composer and delivers once the footer resolves', async () => {
    const h = workerFence();
    h.scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));
    await h.flush();
    h.scope.nativeState = 'idle';
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.traexNativeStartupInputPending).toBe(true);
    h.scope.screen = RESOLVED;
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

  it('reports only direct-submit attribution to the daemon, never input bytes', () => {
    const h = workerFence();
    h.scope.terminalInputSubmits = (data: string) => data.includes('\r');
    const note = loadWorkerFunction<(data: string) => void>('noteWebTerminalInput', h.scope);
    note('private text\r');
    const events = h.scope.send.mock.calls.map(([event]: [{ type: string }]) => event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'terminal_input', submitted: true });
    expect(JSON.stringify(events[0])).not.toContain('private text');
  });
});

describe('a footer that resolves after the 90s window still admits after Web input', () => {
  afterEach(() => { vi.useRealTimers(); });

  function lateFence(nativeState: 'idle' | undefined) {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const h = workerFence();
    h.scope.nativeState = nativeState;
    h.scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));
    // The fence's own timers re-enter through these, like the live worker.
    h.scope.markPromptReady = vi.fn();
    h.scope.flushPending = vi.fn(() => h.flush());
    return h;
  }
  /** A real keystroke from the Web terminal: the TUI echoes it and the human
   *  deletes it again, so the screen changes but stays an empty composer. */
  function webKeystroke(h: ReturnType<typeof workerFence>): void {
    h.scope.lastWebTerminalInputAtMs = Date.now();
    h.scope.webTerminalInputGeneration++;
    h.scope.webTerminalInputBackendScreenRevision = h.scope.backendScreenRevision;
    h.scope.backendScreenRevision += 2;
  }
  /** On a live worker an idle edge, the viewport poller or a new message
   *  re-drives admission every couple of seconds. */
  async function driveUntil(h: ReturnType<typeof workerFence>, startedAt: number, untilMs: number): Promise<void> {
    while (Date.now() - startedAt < untilMs) {
      await h.flush();
      await vi.advanceTimersByTimeAsync(2_000);
    }
  }

  it.each([['an idle report', 'idle'], ['no idle report', undefined]] as const)(
    'Web keystroke after the timeout notice, footer at 100s, with %s', async (_label, nativeState) => {
      const h = lateFence(nativeState);
      const startedAt = Date.now();
      await driveUntil(h, startedAt, 95_000);
      expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
      webKeystroke(h);
      await driveUntil(h, startedAt, 100_000);
      expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
      h.scope.screen = RESOLVED;
      h.scope.backendScreenRevision++;
      await driveUntil(h, startedAt, 130_000);
      expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
      expect(h.scope.pendingMessages).toHaveLength(0);
    });

  it('a receipt-proven quarantine release keeps re-driving the lease after a keystroke that draws nothing', async () => {
    const h = lateFence('idle');
    // The first input was written (thread readiness verified) but its submit
    // stayed unconfirmed and was quarantined. Past the 90s window a key that
    // draws nothing reaches the pane, then the owned late receipt releases
    // the quarantine with the follow-up already queued. Nothing else redraws.
    Object.assign(h.scope, {
      traexNativeStartupInputPending: false, traexFirstInputAdmissionPending: true,
      traexFirstSubmitConfirmed: false, screen: RESOLVED,
    });
    const followUp = h.scope.pendingMessages.splice(0);
    const quarantine = { backend: h.scope.backend, generation: h.scope.cliSpawnGeneration,
      draftContent: 'first', turnId: 'first', dispatchAttempt: 1 };
    h.scope.inputDeliveryQuarantine = quarantine;
    const release = loadWorkerFunction<(q: unknown, reason: string) => boolean>('releaseInputDeliveryQuarantine', h.scope);
    await vi.advanceTimersByTimeAsync(95_000);
    h.scope.lastWebTerminalInputAtMs = Date.now();
    h.scope.webTerminalInputGeneration++;
    h.scope.webTerminalInputBackendScreenRevision = h.scope.backendScreenRevision;
    expect(release(quarantine, 'owned late submit receipt')).toBe(true);
    h.scope.pendingMessages.push(...followUp);
    await h.flush(); // the release's own redrive
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    // Only the fence's own recheck timers may move it from here.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.traexFirstInputAdmissionPending).toBe(false);
  });
});
