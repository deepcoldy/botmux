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
import { protectedMcpRedactedEnvKeys } from '../src/core/protected-mcp-capabilities.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { InputDeliveryEvidenceTracker } from '../src/services/input-delivery-evidence.js';
import { restartSpendsFreshBudget, exitMarksServerReplaced } from '../src/core/restart-fresh-budget.js';
import { join } from 'node:path';

type RespawnResult = 'spawned' | 'failed' | 'superseded';
type Restart = (reason: string, opts?: {
  immediate?: boolean;
  preservePending?: boolean;
  restartCause?: 'traex-auto-model';
  onRespawnSettled?: (result: RespawnResult) => void;
}) => Promise<void>;

function restartHarness(opts: { replacementPromptReadyDuringSpawn: boolean }) {
  const timers: Array<() => unknown> = [];
  const observed: Record<string, unknown> = {};
  const scope: Record<string, any> = {
    codexAutoUpgrade: undefined,
    lastInitConfig: { cliId: 'claude-code', sessionId: 'sid', workingDir: '/project', resume: false },
    cliSpawnGeneration: 1,
    submitFailureChains: { clear: vi.fn() },
    inputDeliveryEvidence: new InputDeliveryEvidenceTracker(),
    queuedActivationReceipts: { clear: vi.fn() },
    cliRestartInProgress: false,
    replacementSpawnInProgress: false,
    restartWindowLaunch: undefined,
    rawInputRestartGate: false,
    consecutiveInWorkerRestarts: 0,
    lastCliExitServerReplaced: false,
    restartSpendsFreshBudget,
    tmuxRestartTimer: null,
    remoteThreadId: undefined,
    intentionalRestartBackend: undefined,
    intentionallyRetiredBackends: new WeakSet(),
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
    traexAutoModelController: { noteProcessExited: vi.fn() },
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
  return { scope, observed, restart, runSpawnTimer, timers };
}

describe('worker restart input fence', () => {
  it('forgets old input and terminal evidence before restarting the CLI', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    const old = { turnId: 'old-turn', dispatchAttempt: 2, cliGeneration: 1 };
    h.scope.inputDeliveryEvidence.start(old, 100);
    h.scope.inputDeliveryEvidence.observeStructuredTerminal(old);
    expect(h.scope.inputDeliveryEvidence.hasStructuredTerminal(old)).toBe(true);

    await h.restart('daemon request', { preservePending: true });

    expect(h.scope.inputDeliveryEvidence.hasStructuredTerminal(old)).toBe(false);
    expect(h.scope.inputDeliveryEvidence.writeStartedAtMs(old)).toBeUndefined();
    await h.runSpawnTimer();
  });

  it('forgets old evidence when a new spawn fails before creating a replacement', async () => {
    const inputDeliveryEvidence = new InputDeliveryEvidenceTracker();
    const old = { turnId: 'old-turn', dispatchAttempt: 2, cliGeneration: 7 };
    inputDeliveryEvidence.start(old, 100);
    inputDeliveryEvidence.observeStructuredTerminal(old);
    const scope = {
      cliSpawnGeneration: 7,
      inputDeliveryEvidence,
      networkPolicySupportError: () => undefined,
      networkProxyLaunchError: async () => undefined,
      protectedHttpEgressCliSupportError: () => undefined,
      protectedMcpRedactedEnvKeys,
      resetCodexModelMigrationState: vi.fn(),
      backgroundTaskTracker: { reset: vi.fn() },
      join,
      homedir: () => '/fixture',
      tmpdir: () => '/fixture/tmp',
      ensureSessionTempDir: () => '/fixture/session',
      pinSessionMcpGatewaySocketRoot: vi.fn(),
      applySessionTempEnv: vi.fn(),
      process: { platform: process.platform, env: {} },
      submitFailureChains: { clear: vi.fn() },
      queuedActivationReceipts: { clear: vi.fn() },
      // spawnCli's entry points the worker's TRAE readers at the bot's
      // TRAE_HOME before any of the gates below run. It is a no-op for this
      // non-traex assertion, but the real worker global must be present or the
      // harness throws a TypeError before reaching the expected rejection.
      followBotTraeHome: vi.fn(),
    };
    const spawn = loadWorkerFunction<(cfg: unknown) => Promise<void>>('spawnCli', scope);

    await expect(spawn({ sessionId: 'sid', cliId: 'traex', existingAppServerEndpoint: 'ws://localhost' }))
      .rejects.toThrow('existing App Server attachment requires cliId');

    expect(scope.cliSpawnGeneration).toBe(8);
    expect(inputDeliveryEvidence.hasStructuredTerminal(old)).toBe(false);
    expect(inputDeliveryEvidence.writeStartedAtMs(old)).toBeUndefined();
  });

  it('preserves the activity latch only for a capacity-model rotation', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    await h.restart('capacity rotation', { preservePending: true, restartCause: 'traex-auto-model' });
    await h.runSpawnTimer();
    expect(h.scope.traexAutoModelController.noteProcessExited).toHaveBeenCalledWith(true);
  });

  it('keeps the input fence armed through teardown and spawn, then leaves the first flush to markPromptReady', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });

    await h.restart('daemon request', { preservePending: true });
    // Old backend torn down, replacement not spawned yet: fence still armed.
    expect(h.scope.killCli).toHaveBeenCalledWith({ preservePending: true, preservePolicyCapability: true });
    expect(h.scope.cliRestartInProgress).toBe(true);
    expect(h.scope.rawInputRestartGate).toBe(true);

    await h.runSpawnTimer();
    expect(h.scope.spawnCli).toHaveBeenCalledTimes(1);
    expect(h.scope.traexAutoModelController.noteProcessExited).toHaveBeenCalledWith(false);
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

  // 2026-11-06: a tmux server loss took respawned panes down a second time and
  // tier-2 forced 71 sessions to a FRESH conversation.
  it('does not spend the fresh-session budget when the previous exit was a tmux server loss', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    h.scope.consecutiveInWorkerRestarts = 1;
    h.scope.lastCliExitServerReplaced = true;
    await h.restart('daemon request');
    expect(h.scope.consecutiveInWorkerRestarts).toBe(1);
    // consumed: the next restart is judged on its own exit
    expect(h.scope.lastCliExitServerReplaced).toBe(false);
  });

  it('still spends the budget for an ordinary CLI exit', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    h.scope.consecutiveInWorkerRestarts = 1;
    await h.restart('daemon request');
    expect(h.scope.consecutiveInWorkerRestarts).toBe(2);
  });

  it('clears a stale server-loss marker when the restart is abandoned for a codex auto-upgrade', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    const reject = vi.fn();
    h.scope.codexAutoUpgrade = { reject };
    h.scope.lastCliExitServerReplaced = true;
    await h.restart('daemon request');
    expect(reject).toHaveBeenCalledOnce();
    expect(h.scope.lastCliExitServerReplaced).toBe(false);
  });

  it('clears a stale server-loss marker when restart is ignored in adopt mode', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    h.scope.lastInitConfig = { adoptMode: true };
    h.scope.lastCliExitServerReplaced = true;
    await h.restart('daemon request');
    expect(h.scope.lastCliExitServerReplaced).toBe(false);
  });
});

describe('restart respawn settlement', () => {
  it('reports a running replacement once, while input is still queued for it', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    const seen: Array<[RespawnResult, boolean]> = [];
    await h.restart('purge', { preservePending: true, onRespawnSettled: r => seen.push([r, h.scope.cliRestartInProgress]) });
    expect(seen).toEqual([]);
    await h.runSpawnTimer();
    expect(seen).toEqual([['spawned', true]]);
  });

  it('reports a failed spawn before the worker exits', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    const order: string[] = [];
    h.scope.spawnCli = vi.fn(async () => { throw new Error('spawn ENOENT'); });
    h.scope.sendFatalWorkerErrorAndExit = vi.fn(async () => { order.push('fatal exit'); });
    await h.restart('purge', { preservePending: true, onRespawnSettled: r => order.push(r) });
    await h.timers.shift()!();
    expect(order).toEqual(['failed', 'fatal exit']);
  });

  it('reports a spawn superseded by a newer restart', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    const seen: RespawnResult[] = [];
    h.scope.spawnCli = vi.fn(async () => { throw new h.scope.CliSpawnSupersededError(); });
    await h.restart('purge', { preservePending: true, onRespawnSettled: r => seen.push(r) });
    await h.timers.shift()!();
    expect(seen).toEqual(['superseded']);
    expect(h.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
  });

  it('reports failure when the restart stops before any spawn', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    const order: string[] = [];
    h.scope.backend = { destroySession: vi.fn(() => Promise.reject(new Error('tmux kill failed'))) };
    h.scope.sendFatalWorkerErrorAndExit = vi.fn(async () => { order.push('fatal exit'); });
    await h.restart('purge', { preservePending: true, onRespawnSettled: r => order.push(r) });
    expect(order).toEqual(['failed', 'fatal exit']);
    expect(h.scope.spawnCli).not.toHaveBeenCalled();

    const unconfigured = restartHarness({ replacementPromptReadyDuringSpawn: false });
    unconfigured.scope.lastInitConfig = null;
    const unconfiguredSeen: RespawnResult[] = [];
    await unconfigured.restart('purge', { onRespawnSettled: r => unconfiguredSeen.push(r) });
    await unconfigured.runSpawnTimer();
    expect(unconfiguredSeen).toEqual(['failed']);

    const abandoned = restartHarness({ replacementPromptReadyDuringSpawn: false });
    abandoned.scope.codexAutoUpgrade = { reject: vi.fn() };
    const seen: RespawnResult[] = [];
    await abandoned.restart('purge', { onRespawnSettled: r => seen.push(r) });
    expect(seen).toEqual(['failed']);
  });

  it('keeps restarting when the settle callback throws', async () => {
    const h = restartHarness({ replacementPromptReadyDuringSpawn: false });
    await h.restart('purge', { preservePending: true, onRespawnSettled: () => { throw new Error('boom'); } });
    await h.runSpawnTimer();
    expect(h.scope.cliRestartInProgress).toBe(false);
  });
});

describe('restart fresh-budget policy', () => {
  it('marks only an unintentional exit that the backend attributes to a server replacement', () => {
    expect(exitMarksServerReplaced({ intentionalRestart: false, backendReportsServerReplaced: true })).toBe(true);
    expect(exitMarksServerReplaced({ intentionalRestart: true, backendReportsServerReplaced: true })).toBe(false);
    expect(exitMarksServerReplaced({ intentionalRestart: false, backendReportsServerReplaced: false })).toBe(false);
    expect(exitMarksServerReplaced({ intentionalRestart: true, backendReportsServerReplaced: false })).toBe(false);
  });

  it('spends the budget for a normal exit but not for a server loss or a user-initiated respawn', () => {
    expect(restartSpendsFreshBudget({ previousExitServerReplaced: false })).toBe(true);
    expect(restartSpendsFreshBudget({ previousExitServerReplaced: true })).toBe(false);
    expect(restartSpendsFreshBudget({ skipRestartBudget: true, previousExitServerReplaced: false })).toBe(false);
    expect(restartSpendsFreshBudget({ skipRestartBudget: true, previousExitServerReplaced: true })).toBe(false);
  });
});
