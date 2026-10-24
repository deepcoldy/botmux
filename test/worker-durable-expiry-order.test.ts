/**
 * Executes the worker's real restartCliProcess (extracted from src/worker.ts,
 * see helpers/worker-function-harness.ts) with the teardown/spawn boundaries
 * stubbed. #570: a restart must keep the input fence armed until the
 * replacement exists, and must not type ahead into a replacement whose TUI
 * input box is not ready yet ("Enter 丢进未就绪 TUI" → the session goes silent).
 * flushPending's own `cliRestartInProgress` early return is executed in
 * worker-codex-session-upgrade.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { classifyRestartTeardown } from '../src/adapters/backend/destroy-result.js';
import { isRemoteBackendType } from '../src/core/persistent-backend.js';
import { decideRestartFollowup, restartLaunchSettings } from '../src/core/restart-followup-policy.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

type Restart = (reason: string, opts?: { immediate?: boolean; preservePending?: boolean }) => Promise<void>;

function restartHarness(opts: { replacementPromptReadyDuringSpawn: boolean }) {
  const timers: Array<() => unknown> = [];
  const observed: Record<string, unknown> = {};
  const scope: Record<string, any> = {
    codexAutoUpgrade: undefined,
    lastInitConfig: { cliId: 'claude-code', sessionId: 'sid', workingDir: '/project', resume: false },
    cliSpawnGeneration: 1,
    submitFailureChains: { clear: vi.fn() },
    queuedActivationReceipts: { clear: vi.fn() },
    cliRestartInProgress: false,
    replacementSpawnInProgress: false,
    restartWindowLaunch: undefined,
    rawInputRestartGate: false,
    consecutiveInWorkerRestarts: 0,
    tmuxRestartTimer: null,
    remoteThreadId: undefined,
    intentionalRestartBackend: undefined,
    effectiveBackendType: 'pty',
    awaitingFirstPrompt: false,
    isPromptReady: true,
    pendingLaunchConvergence: undefined,
    codexRpcEngine: undefined,
    classifyRestartTeardown,
    isRemoteBackendType,
    decideRestartFollowup,
    restartLaunchSettings,
    CliSpawnSupersededError: class extends Error {},
    log: vi.fn(),
    revokeManagedTurnOriginForRestart: vi.fn(),
    stopOwnedSessionScope: vi.fn(),
    startScreenUpdates: vi.fn(),
    startStuckDetector: vi.fn(),
    adoptPendingLaunchConvergence: vi.fn(),
    codexRpcEligible: () => false,
    traexAutoModelRuntimeEligible: () => false,
    traexAutoModelSwitching: false,
    sandboxEnabled: () => false,
    prepareCodexNativeTitleGeneration: vi.fn(async () => {}),
    settleRestartAttemptOnReady: vi.fn(),
    releaseRawInputRestartGate: vi.fn(),
    flushPending: vi.fn(async () => {}),
    sendFatalWorkerErrorAndExit: vi.fn(async () => {}),
    setTimeout: (fn: () => unknown) => { timers.push(fn); return { unref() {} }; },
  };
  scope.backend = { destroySession: vi.fn() };
  scope.killCli = vi.fn(() => {
    scope.backend = null;
    scope.isPromptReady = false;
  });
  scope.spawnCli = vi.fn(async () => {
    observed.fenceArmedDuringSpawn = scope.cliRestartInProgress && scope.rawInputRestartGate;
    scope.backend = { generation: 'replacement' };
    scope.isPromptReady = opts.replacementPromptReadyDuringSpawn;
  });
  const restart = loadWorkerFunction<Restart>('restartCliProcess', scope);
  const runSpawnTimer = async () => {
    const timer = timers.shift();
    expect(timer, 'restart did not schedule the replacement spawn').toBeTypeOf('function');
    await timer!();
    expect(scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
  };
  return { scope, observed, restart, runSpawnTimer };
}

describe('worker restart input fence', () => {
  it('keeps the input fence armed through teardown and spawn, then leaves the first flush to markPromptReady', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });

    await h.restart('daemon request', { preservePending: true });
    // Old backend torn down, replacement not spawned yet: fence still armed.
    expect(h.scope.killCli).toHaveBeenCalledWith({ preservePending: true, preservePolicyCapability: true });
    expect(h.scope.cliRestartInProgress).toBe(true);
    expect(h.scope.rawInputRestartGate).toBe(true);

    await h.runSpawnTimer();
    expect(h.scope.spawnCli).toHaveBeenCalledTimes(1);
    expect(h.observed.fenceArmedDuringSpawn).toBe(true);
    expect(h.scope.cliRestartInProgress).toBe(false);
    // The replacement process exists but its prompt is not ready: no
    // type-ahead wake from the restart continuation.
    expect(h.scope.flushPending).not.toHaveBeenCalled();
  });

  it('wakes queued input once when the replacement prompt became ready during the fence', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: true });

    await h.restart('daemon request', { preservePending: true });
    await h.runSpawnTimer();

    expect(h.scope.cliRestartInProgress).toBe(false);
    expect(h.scope.settleRestartAttemptOnReady).toHaveBeenCalledTimes(1);
    expect(h.scope.flushPending).toHaveBeenCalledTimes(1);
  });
});
