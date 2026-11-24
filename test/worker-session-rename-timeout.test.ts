import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideSessionRenameSettlement } from '../src/core/session-rename-settlement.js';
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
    sessionRenameSurfaceNow: () => surface,
    decideSessionRenameSettlement,
    isPromptReady: false,
    reattachOpenTurnGate: true,
    flushPending: vi.fn(),
    notifySessionRenameInputHeld: vi.fn(),
    pendingMessages: [{ content: 'queued', turnId: 'turn' }],
    pendingAdoptMessages: [],
    pendingRawInputs: [],
    currentBotmuxDispatchAttempt: 1,
    send: vi.fn(),
    t: (key: string) => key,
    resubmitSessionRename: vi.fn(() => true),
    cliName: () => 'Codex',
    log: vi.fn(),
  };
  scope.forceClearSessionRenameInFlight = loadWorkerFunction('forceClearSessionRenameInFlight', scope);
  scope.notifySessionRenameInputTimeout = loadWorkerFunction('notifySessionRenameInputTimeout', scope);
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
    expect(h.scope.isPromptReady).toBe(surface === 'settled');
    expect(h.scope.reattachOpenTurnGate).toBe(surface !== 'settled');
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_notify', turnId: 'turn', message: 'worker.session_rename_release_timeout',
    }));
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
