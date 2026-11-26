import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideSessionRenameSettlement, shouldRecoverUnconfirmedSessionRename } from '../src/core/session-rename-settlement.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function renameTimerHarness(surface: 'settled' | 'unsubmitted' | 'occupied' | 'blocked' | 'unknown') {
  const scope: Record<string, any> = {
    sessionRenamePhase: 'sent',
    sessionRenameIdleTimer: null,
    sessionRenameReattachRetryTimer: null,
    sessionRenameSentAtMs: Date.now(),
    sessionRenameCommand: '/rename title',
    sessionRenameRecorded: () => false,
    sessionRenameResubmitted: true,
    sessionRenameHoldLogged: false,
    sessionRenameHoldNoticeSent: false,
    sessionRenameHoldTimeoutLogged: false,
    sessionRenameHoldTimeoutNoticeSent: false,
    SESSION_RENAME_IDLE_TIMEOUT_MS: 5_000,
    SESSION_RENAME_RECHECK_MS: 2_000,
    SESSION_RENAME_SLOW_RECHECK_MS: 10_000,
    SESSION_RENAME_FAST_RECHECK_WINDOW_MS: 30_000,
    SESSION_RENAME_HOLD_TIMEOUT_MS: 45_000,
    SESSION_RENAME_RECOVERY_AFTER_MS: 60_000,
    sessionRenameSurfaceNow: () => surface,
    decideSessionRenameSettlement,
    idleDetector: { programStatusHeldBusy: () => false, adoptPromptReady: vi.fn() },
    programStatusBlockedHoldsTypeAhead: () => false,
    isPromptReady: false,
    reattachOpenTurnGate: true,
    flushPending: vi.fn(),
    notifySessionRenameInputHeld: vi.fn(),
    pendingMessages: [{ content: 'queued', turnId: 'turn' }],
    pendingAdoptMessages: [],
    pendingRawInputs: [],
    backend: {},
    effectiveBackendType: 'tmux',
    sessionRenameRecoveryUsed: false,
    closeRequested: false,
    cliRestartInProgress: false,
    currentBotmuxDispatchAttempt: 1,
    send: vi.fn(),
    t: (key: string) => key,
    resubmitSessionRename: vi.fn(() => true),
    cliName: () => 'Codex',
    log: vi.fn(),
  };
  scope.forceClearSessionRenameInFlight = loadWorkerFunction('forceClearSessionRenameInFlight', scope);
  scope.notifySessionRenameInputTimeout = loadWorkerFunction('notifySessionRenameInputTimeout', scope);
  scope.restoreSessionRenameReadiness = loadWorkerFunction('restoreSessionRenameReadiness', scope);
  scope.sessionRenameRecoveryRuntimeAllowed = loadWorkerFunction('sessionRenameRecoveryRuntimeAllowed', scope);
  scope.sessionRenameOwnedRecoverySessionId = loadWorkerFunction('sessionRenameOwnedRecoverySessionId', scope);
  scope.sessionRenameRecoveryPermanentlyUnavailable = loadWorkerFunction('sessionRenameRecoveryPermanentlyUnavailable', scope);
  scope.settleSessionRename = loadWorkerFunction('settleSessionRename', scope);
  scope.armSessionRenameIdleTimeout = loadWorkerFunction('armSessionRenameIdleTimeout', scope);
  return { scope, arm: scope.armSessionRenameIdleTimeout as () => void };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('native rename confirmation hold cap', () => {
  it.each(['settled', 'occupied', 'unknown'] as const)('releases queued %s input after the cap when no receipt settles the rename', async (surface) => {
    vi.useFakeTimers();
    const h = renameTimerHarness(surface);
    h.arm();

    await vi.advanceTimersByTimeAsync(44_000);
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(h.scope.sessionRenamePhase).toBe('sent');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
    expect(h.scope.sessionRenamePhase).toBe('idle');
    expect(h.scope.isPromptReady).toBe(surface !== 'occupied');
    expect(h.scope.reattachOpenTurnGate).toBe(surface === 'occupied');
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_notify', turnId: 'turn', message: 'worker.session_rename_release_timeout',
    }));
  });

  it('uses a historical receipt for an already-renamed busy reattach, but never for unknown evidence', async () => {
    vi.useFakeTimers();
    const settled = renameTimerHarness('settled');
    settled.scope.sessionRenameRecorded = () => false;
    settled.scope.sessionRenameHistoricalRecorded = () => true;
    settled.arm();
    await vi.advanceTimersToNextTimerAsync();
    expect(settled.scope.flushPending).toHaveBeenCalledOnce();
    expect(settled.scope.send.mock.calls.map(([event]: [any]) => event.message))
      .not.toContain('worker.session_rename_release_timeout');

    const unknown = renameTimerHarness('unknown');
    unknown.scope.sessionRenameRecorded = () => false;
    unknown.scope.sessionRenameHistoricalRecorded = () => true;
    unknown.arm();
    await vi.advanceTimersToNextTimerAsync();
    expect(unknown.scope.flushPending).not.toHaveBeenCalled();
  });

  it('gives the TRAE settled recovery path priority over the generic cap', async () => {
    vi.useFakeTimers();
    const h = renameTimerHarness('settled');
    h.scope.lastInitConfig = { cliId: 'traex' };
    let recovered = false;
    h.scope.recoverUnconfirmedSessionRename = vi.fn(() => {
      if (Date.now() - h.scope.sessionRenameSentAtMs < 60_000) return false;
      recovered = true;
      return true;
    });
    h.arm();
    await vi.advanceTimersByTimeAsync(44_000);
    expect(recovered).toBe(false);
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(17_000);
    expect(recovered).toBe(true);
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(h.scope.send.mock.calls.map(([event]: [any]) => event.message))
      .not.toContain('worker.session_rename_release_timeout');
  });

  it('never restarts TRAE after a valid receipt, and waits safely if recovery is unavailable', async () => {
    vi.useFakeTimers();
    const confirmed = renameTimerHarness('settled');
    confirmed.scope.lastInitConfig = { cliId: 'traex' };
    confirmed.scope.sessionRenameRecorded = () => true;
    confirmed.scope.recoverUnconfirmedSessionRename = vi.fn();
    confirmed.arm();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(confirmed.scope.recoverUnconfirmedSessionRename).not.toHaveBeenCalled();
    expect(confirmed.scope.flushPending).toHaveBeenCalledOnce();

    const unavailable = renameTimerHarness('settled');
    unavailable.scope.lastInitConfig = { cliId: 'traex' };
    // Exact ownership exists; only the mocked recovery attempt is temporarily
    // unable to proceed. This must remain distinct from a multi-rollout cap.
    unavailable.scope.sessionRenameNativeSessionIdNow = () => 'native-id';
    unavailable.scope.currentTraexObservedPid = () => 123;
    unavailable.scope.findTraexRolloutSetByPid = () => new Set(['native-id']);
    unavailable.scope.recoverUnconfirmedSessionRename = vi.fn(() => false);
    unavailable.scope.notifySessionRenameInputTimeout = vi.fn();
    unavailable.arm();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(unavailable.scope.flushPending).not.toHaveBeenCalled();
    expect(unavailable.scope.notifySessionRenameInputTimeout).toHaveBeenCalledWith('recovery-held', 60);
    expect(unavailable.scope.sessionRenamePhase).toBe('sent');
  });

  it('uses the dedicated transient recovery notice instead of the draft/dialog warning', async () => {
    vi.useFakeTimers();
    const h = renameTimerHarness('settled');
    h.scope.lastInitConfig = { cliId: 'traex' };
    h.scope.sessionRenameNativeSessionIdNow = () => 'native-id';
    h.scope.currentTraexObservedPid = () => 123;
    h.scope.findTraexRolloutSetByPid = () => new Set(['native-id']);
    h.scope.recoverUnconfirmedSessionRename = vi.fn(() => false);
    h.scope.t = vi.fn((key: string) => key);

    h.arm();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(h.scope.send.mock.calls.map(([event]: [any]) => event.message))
      .toContain('worker.session_rename_recovery_held');
    expect(h.scope.send.mock.calls.map(([event]: [any]) => event.message))
      .not.toContain('worker.session_rename_hold_timeout');
    expect(h.scope.t).toHaveBeenCalledWith('worker.session_rename_recovery_held',
      expect.objectContaining({ seconds: 60 }));
  });

  it('does not hold forever when TRAE recovery is permanently ineligible', async () => {
    vi.useFakeTimers();
    for (const mode of ['adopt', 'already-used', 'zmx', 'sandbox-without-fd', 'multi-rollout'] as const) {
      const h = renameTimerHarness('settled');
      h.scope.lastInitConfig = {
        cliId: 'traex',
        ...(mode === 'adopt' ? { adoptMode: true } : {}),
        ...(mode === 'sandbox-without-fd' ? { sandbox: 'scratch' } : {}),
      };
      if (mode === 'already-used') h.scope.sessionRenameRecoveryUsed = true;
      if (mode === 'zmx') h.scope.effectiveBackendType = 'zmx';
      if (mode === 'sandbox-without-fd') h.scope.sessionRenameNativeSessionIdNow = () => undefined;
      if (mode === 'multi-rollout') {
        Object.assign(h.scope, {
          sessionRenameNativeSessionIdNow: () => 'sid-a',
          currentTraexObservedPid: () => 123,
          findTraexRolloutSetByPid: () => new Set(['sid-a', 'sid-b']),
          rawInputRestartGate: false,
          codexAutoUpgrade: undefined,
          pendingWebTerminalInput: () => false,
          commandLineWritesPending: 0,
          isFlushing: false,
          injectionFlushing: false,
          shouldRecoverUnconfirmedSessionRename,
          restartCliProcess: vi.fn(),
        });
        h.scope.recoverUnconfirmedSessionRename = loadWorkerFunction('recoverUnconfirmedSessionRename', h.scope);
      }
      if (mode !== 'multi-rollout') h.scope.recoverUnconfirmedSessionRename = vi.fn(() => false);
      h.scope.notifySessionRenameInputTimeout = vi.fn();
      h.arm();

      await vi.advanceTimersByTimeAsync(61_000);

      expect(h.scope.flushPending, mode).toHaveBeenCalledOnce();
      expect(h.scope.sessionRenamePhase, mode).toBe('idle');
      expect(h.scope.notifySessionRenameInputTimeout, mode).toHaveBeenCalledWith('released', 60);
      expect(h.scope.notifySessionRenameInputTimeout, mode).not.toHaveBeenCalledWith('recovery-held', 60);
      if (mode === 'multi-rollout') expect(h.scope.restartCliProcess).not.toHaveBeenCalled();
    }
  });

  it('keeps prompt edges out of restart recovery and leaves recovery to the timer', () => {
    const h = renameTimerHarness('settled');
    h.scope.lastInitConfig = { cliId: 'traex' };
    h.scope.sessionRenameSentAtMs = Date.now() - 60_000;
    h.scope.recoverUnconfirmedSessionRename = vi.fn(() => true);
    h.scope.notifySessionRenameInputTimeout = vi.fn();

    h.scope.settleSessionRename('prompt');

    expect(h.scope.recoverUnconfirmedSessionRename).not.toHaveBeenCalled();
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(h.scope.notifySessionRenameInputTimeout).not.toHaveBeenCalled();
    expect(h.scope.sessionRenamePhase).toBe('sent');
    expect(h.scope.sessionRenameCommand).toBe('/rename title');

    h.scope.settleSessionRename('timer');
    expect(h.scope.recoverUnconfirmedSessionRename).toHaveBeenCalledOnce();
  });

  it('does not clear an unproven reattach open-turn gate on unknown recovery', () => {
    const h = renameTimerHarness('unknown');
    h.scope.restoreSessionRenameReadiness('unknown', { preserveReattachGate: true });
    expect(h.scope.isPromptReady).toBe(false);
    expect(h.scope.reattachOpenTurnGate).toBe(true);
  });

  it.each([
    { heldBusy: true, blocked: false },
    { heldBusy: false, blocked: true },
  ])('never restores readiness over an authoritative native veto: %o', async ({ heldBusy, blocked }) => {
    vi.useFakeTimers();
    for (const surface of ['settled', 'unknown'] as const) {
      const h = renameTimerHarness(surface);
      h.scope.idleDetector.programStatusHeldBusy = () => heldBusy;
      h.scope.programStatusBlockedHoldsTypeAhead = () => blocked;
      h.arm();
      await vi.advanceTimersByTimeAsync(46_000);
      expect(h.scope.isPromptReady).toBe(false);
      expect(h.scope.reattachOpenTurnGate).toBe(true);
      expect(h.scope.idleDetector.adoptPromptReady).not.toHaveBeenCalled();
    }
  });

  it('adopts readiness through the idle detector after a confirmed safe release', () => {
    const h = renameTimerHarness('settled');
    h.scope.isPromptReady = false;
    h.scope.reattachOpenTurnGate = false;
    h.scope.restoreSessionRenameReadiness('settled');
    expect(h.scope.isPromptReady).toBe(true);
    expect(h.scope.idleDetector.adoptPromptReady).toHaveBeenCalledOnce();
  });

  it('keeps holding a visible rename command after the cap and tells the user why', async () => {
    vi.useFakeTimers();
    const h = renameTimerHarness('unsubmitted');
    h.arm();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(h.scope.resubmitSessionRename).not.toHaveBeenCalled();
    expect(h.scope.sessionRenamePhase).toBe('sent');
    const timeoutNotices = h.scope.send.mock.calls.filter(([event]: [any]) =>
      event.message === 'worker.session_rename_hold_timeout');
    expect(timeoutNotices).toHaveLength(1);
    expect(timeoutNotices[0]![0]).toEqual(expect.objectContaining({
      type: 'user_notify', turnId: 'turn',
    }));
  });

  it('keeps an explicit dialog or draft blocked after the cap without manufacturing readiness', async () => {
    vi.useFakeTimers();
    const h = renameTimerHarness('blocked');
    h.arm();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(h.scope.resubmitSessionRename).not.toHaveBeenCalled();
    expect(h.scope.sessionRenamePhase).toBe('sent');
    expect(h.scope.isPromptReady).toBe(false);
    expect(h.scope.reattachOpenTurnGate).toBe(true);
    const timeoutNotices = h.scope.send.mock.calls.filter(([event]: [any]) =>
      event.message === 'worker.session_rename_hold_timeout');
    expect(timeoutNotices).toHaveLength(1);
  });
});
