import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldRecoverUnconfirmedSessionRename } from '../src/core/session-rename-settlement.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { classifyRestartTeardown } from '../src/adapters/backend/destroy-result.js';
import { isRemoteBackendType } from '../src/core/persistent-backend.js';
import { decideRestartFollowup, restartLaunchSettings } from '../src/core/restart-followup-policy.js';
import { restartSpendsFreshBudget } from '../src/core/restart-fresh-budget.js';

afterEach(() => vi.useRealTimers());

describe('unconfirmed rename recovery admission', () => {
  const state = {
    surface: 'settled' as const, elapsedMs: 100, timeoutMs: 100,
    hasQueuedInput: true, alreadyRecovered: false, mayRestart: true,
  };

  it('replaces an idle private CLI only after the wait expires and input is waiting', () => {
    expect(shouldRecoverUnconfirmedSessionRename({ ...state, elapsedMs: 99 })).toBe(false);
    expect(shouldRecoverUnconfirmedSessionRename(state)).toBe(true);
    expect(shouldRecoverUnconfirmedSessionRename({ ...state, hasQueuedInput: false })).toBe(false);
    expect(shouldRecoverUnconfirmedSessionRename({ ...state, alreadyRecovered: true })).toBe(false);
    expect(shouldRecoverUnconfirmedSessionRename({ ...state, mayRestart: false })).toBe(false);
  });

  it.each([undefined, 'unknown', 'occupied', 'unsubmitted'] as const)('does not restart a %s surface', surface => {
    expect(shouldRecoverUnconfirmedSessionRename({ ...state, surface, elapsedMs: 10_000 })).toBe(false);
  });
});

function recoveryHarness(extra: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const followUp = { content: 'follow-up', turnId: 'next', trustedCaller: { requestUserOpenId: 'caller' } };
  const scope: Record<string, any> = {
    backend: {}, lastInitConfig: { cliId: 'traex' }, effectiveBackendType: 'tmux',
    cliRestartInProgress: false, rawInputRestartGate: false, codexAutoUpgrade: undefined,
    closeRequested: false, pendingWebTerminalInput: () => false, commandLineWritesPending: 0,
    isFlushing: false, injectionFlushing: false, pendingMessages: [followUp], pendingRawInputs: [],
    sessionRenameSentAtMs: 0, SESSION_RENAME_RECOVERY_AFTER_MS: 1_000,
    sessionRenameRecoveryUsed: false, abandonedAutomaticRenameCommand: undefined,
    sessionRenameCommand: '/rename expected-title', sessionRenameNativeSessionIdNow: () => 'live-native-thread',
    currentTraexObservedPid: () => 123, findTraexRolloutSetByPid: () => new Set(['live-native-thread']),
    currentBotmuxDispatchAttempt: undefined,
    shouldRecoverUnconfirmedSessionRename, send: vi.fn(), t: (key: string) => key, cliName: () => 'TRAE', log: vi.fn(),
    restartCliProcess: vi.fn(), ...extra,
  };
  scope.sessionRenameRecoveryRuntimeAllowed = loadWorkerFunction('sessionRenameRecoveryRuntimeAllowed', scope);
  scope.sessionRenameOwnedRecoverySessionId = loadWorkerFunction('sessionRenameOwnedRecoverySessionId', scope);
  const recover = loadWorkerFunction<(surface: string) => boolean>('recoverUnconfirmedSessionRename', scope);
  return { scope, followUp, recover };
}

describe('worker rename receipt timeout', () => {
  it.each(['pty', 'tmux', 'hc'])('preserves queued input and the exact native thread on %s, once', effectiveBackendType => {
    const h = recoveryHarness({ effectiveBackendType });
    expect(h.recover('settled')).toBe(true);
    expect(h.scope.pendingMessages).toEqual([h.followUp]);
    expect(h.scope.restartCliProcess).toHaveBeenCalledWith(expect.any(String), {
      immediate: true, preservePending: true, skipRestartBudget: true, exactResumeSessionId: 'live-native-thread',
    });
    expect(h.scope.abandonedAutomaticRenameCommand).toBe('/rename expected-title');
    expect(h.recover('settled')).toBe(false);
    expect(h.scope.restartCliProcess).toHaveBeenCalledOnce();
  });

  it.each([
    { lastInitConfig: { cliId: 'codex' } }, { lastInitConfig: { cliId: 'claude-code' } },
    { lastInitConfig: { cliId: 'traex', adoptMode: true } }, { lastInitConfig: { cliId: 'traex', existingAppServerEndpoint: 'http://shared' } },
    { effectiveBackendType: 'riff' }, { effectiveBackendType: 'zmx' }, { backend: null },
    { closeRequested: true }, { cliRestartInProgress: true }, { rawInputRestartGate: true }, { codexAutoUpgrade: {} },
    { pendingWebTerminalInput: () => true }, { commandLineWritesPending: 1 },
    { isFlushing: true }, { injectionFlushing: true }, { sessionRenameNativeSessionIdNow: () => undefined },
    { currentTraexObservedPid: () => undefined }, { findTraexRolloutSetByPid: () => undefined },
    { findTraexRolloutSetByPid: () => new Set(['different-native-thread']) },
    { findTraexRolloutSetByPid: () => new Set(['live-native-thread', 'different-native-thread']) },
  ])('leaves protected or unproved runtimes untouched: %o', extra => {
    const h = recoveryHarness(extra);
    expect(h.recover('settled')).toBe(false);
    expect(h.scope.restartCliProcess).not.toHaveBeenCalled();
    expect(h.scope.send).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toEqual([h.followUp]);
  });

  it('also recovers a raw command held behind rename without dequeuing it', () => {
    const raw = { content: '/status', turnId: 'raw' };
    const h = recoveryHarness({ pendingMessages: [], pendingRawInputs: [raw] });
    expect(h.recover('settled')).toBe(true);
    expect(h.scope.pendingRawInputs).toEqual([raw]);
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'raw' }));
  });

  it('does not re-arm the failed automatic title after recovery, but allows a new title', () => {
    const h = recoveryHarness({
      lastInitConfig: { cliId: 'traex' },
      supportsPostSubmitRenameSessionTitle: () => true, codexRpcEngine: undefined, remoteWsUrl: undefined,
      isRemoteBackendType: () => false, cliAdapter: { buildSessionRenameCommand: (title: string) => '/rename ' + title },
      nativeSessionTitleRevision: 0, nativeSessionTitleAppliedThreadId: undefined,
      stopNativeSessionTitleSync: vi.fn(), pendingSessionRename: null, flushPending: vi.fn(),
    });
    expect(h.recover('settled')).toBe(true);
    const queue = loadWorkerFunction<(title: string) => boolean>('queuePostSubmitNativeSessionTitle', h.scope);
    expect(queue('expected-title')).toBe(false);
    expect(h.scope.pendingSessionRename).toBe(null);
    expect(queue('new-title')).toBe(true);
    expect(h.scope.pendingSessionRename).toBe('new-title');
  });
});

describe('closing a session during rename recovery', () => {
  function restartHarness(destroySession?: () => Promise<void>, cliId = 'traex') {
    vi.useFakeTimers();
    const scope: Record<string, any> = {
      closeRequested: false, lastInitConfig: { cliId, workingDir: '/fixture' },
      backend: { destroySession }, effectiveBackendType: 'pty',
      cliSpawnGeneration: 1, cliRestartEpoch: 0, consecutiveInWorkerRestarts: 0,
      intentionallyRetiredBackends: new WeakSet(), submitFailureChains: new Map(),
      inputDeliveryEvidence: new Map(), queuedActivationReceipts: new Map(),
      classifyRestartTeardown, isRemoteBackendType, decideRestartFollowup,
      restartLaunchSettings, restartSpendsFreshBudget,
      revokeManagedTurnOriginForRestart: vi.fn(), stopOwnedSessionScope: vi.fn(),
      startScreenUpdates: vi.fn(), startStuckDetector: vi.fn(), adoptPendingLaunchConvergence: vi.fn(),
      codexRpcEligible: () => false, sandboxEnabled: () => false, traexAutoModelRuntimeEligible: () => false,
      prepareCodexNativeTitleGeneration: async () => {}, log: vi.fn(),
      sendFatalWorkerErrorAndExit: vi.fn(), CliSpawnSupersededError: class extends Error {},
    };
    scope.killCli = vi.fn(() => { scope.backend = null; });
    scope.spawnCli = vi.fn(async () => { scope.backend = {}; });
    const restart = loadWorkerFunction<(reason: string, opts: object) => Promise<void>>('restartCliProcess', scope);
    return { scope, restart };
  }

  it.each(['traex', 'codex', 'claude-code'])('does not spawn %s when close begins during the replacement delay', async cliId => {
    const h = restartHarness(undefined, cliId);
    const settled = vi.fn();
    await h.restart('rename recovery', { immediate: true, preservePending: true, skipRestartBudget: true, onRespawnSettled: settled });
    expect(h.scope.killCli).toHaveBeenCalledOnce();
    h.scope.closeRequested = true;
    await vi.advanceTimersToNextTimerAsync();
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith('superseded');
  });

  it('lets close take over while the old CLI teardown is still pending', async () => {
    let finish!: () => void;
    const h = restartHarness(() => new Promise<void>(resolve => { finish = resolve; }));
    const settled = vi.fn();
    const restarting = h.restart('rename recovery', { immediate: true, preservePending: true, skipRestartBudget: true, onRespawnSettled: settled });
    h.scope.closeRequested = true;
    finish();
    await restarting;
    await vi.advanceTimersToNextTimerAsync();
    expect(h.scope.killCli).not.toHaveBeenCalled();
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith('superseded');
  });

  it.each(['traex', 'codex', 'claude-code'])('refuses a legacy %s spawn after close without a runtime reservation scope', async cliId => {
    class Superseded extends Error {}
    const body = vi.fn();
    const spawn = loadWorkerFunction<(cfg: object) => Promise<void>>('spawnCli', {
      closeRequested: true, CliSpawnSupersededError: Superseded,
      workerSessionEventScope: undefined, spawnCliBody: body,
    });
    await expect(spawn({ cliId })).rejects.toBeInstanceOf(Superseded);
    expect(body).not.toHaveBeenCalled();
  });
});
