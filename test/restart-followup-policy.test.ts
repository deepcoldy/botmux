import { describe, expect, it, vi } from 'vitest';

import {
  classifyMergedRestart,
  decideRestartFollowup,
  decideRestartReceipt,
  decideUpgradeLaunchConvergence,
  restartLaunchSettings,
  sameRestartLaunchSettings,
  settleDurableTurnForRestart,
} from '../src/core/restart-followup-policy.js';

/**
 * Pure decision for whether an in-flight restart must chain another. This is
 * the executable core of PR #507's two restart-race fixes:
 *  - cwd-move convergence (2nd commit): a role-switch restart landing after the
 *    restartCfg snapshot.
 *  - replacement-exit recovery (Codex P2): the freshly-spawned CLI dying inside
 *    the window cliRestartInProgress still covers (spawnCli +
 *    prepareCodexNativeTitleGeneration) → session strands at backend=null.
 *
 * Recovery keys ONLY on `!backendAlive` (onExit nulls backend synchronously) —
 * NOT on any "a restart was requested during the window" signal, because a
 * restart message carries no trustworthy source: a healthy duplicate /restart
 * would otherwise be misread as a crash and force a budget-burning re-restart
 * that drops --resume (the exact regression Codex's 2nd review caught).
 */
describe('decideRestartFollowup', () => {
  const healthy = {
    spawnedWorkingDir: '/roles/pm',
    currentWorkingDir: '/roles/pm',
    backendAlive: true,
  };

  it('no follow-up on a clean restart (backend alive, cwd unchanged)', () => {
    expect(decideRestartFollowup(healthy)).toEqual({ kind: 'none' });
  });

  it('a healthy duplicate restart during the window is merged to none (no budget burn)', () => {
    // The merge guard already swallowed the duplicate; the continuation must
    // NOT manufacture a second restart on a healthy generation. This is the
    // Codex-2 regression guard: backend alive + cwd unchanged → none.
    expect(decideRestartFollowup({ ...healthy })).toEqual({ kind: 'none' });
  });

  it('cwd-move with a LIVE backend → converge, skip FRESH budget (pure user move)', () => {
    const d = decideRestartFollowup({ ...healthy, currentWorkingDir: '/roles/after-sales' });
    expect(d).toEqual({ kind: 'cwd-move', skipRestartBudget: true });
  });

  it('cwd-move with a DEAD backend → converge but COUNT budget (crash evidence kept)', () => {
    // Codex-2 point #2: a replacement that crashed must not hide behind a
    // concurrent directory change — converge the cwd yet still burn budget.
    const d = decideRestartFollowup({
      spawnedWorkingDir: '/roles/pm',
      currentWorkingDir: '/roles/after-sales',
      backendAlive: false,
    });
    expect(d).toEqual({ kind: 'cwd-move', skipRestartBudget: false });
  });

  it('replacement-recovery: backend died in the window → recover, COUNT FRESH budget', () => {
    const d = decideRestartFollowup({ ...healthy, backendAlive: false });
    expect(d).toEqual({ kind: 'replacement-recovery', skipRestartBudget: false });
  });

  it('no cwd-move when lastInitConfig was absent (workingDir undefined on either side)', () => {
    // A missing lastInitConfig must never be read as a divergence (undefined !==
    // "/x" would misfire); only two concrete, differing dirs count as a move.
    expect(decideRestartFollowup({
      spawnedWorkingDir: undefined,
      currentWorkingDir: '/roles/pm',
      backendAlive: true,
    })).toEqual({ kind: 'none' });
    expect(decideRestartFollowup({
      spawnedWorkingDir: '/roles/pm',
      currentWorkingDir: undefined,
      backendAlive: true,
    })).toEqual({ kind: 'none' });
  });

  it('backend death still recovers even when workingDir is undefined on both sides', () => {
    expect(decideRestartFollowup({
      spawnedWorkingDir: undefined,
      currentWorkingDir: undefined,
      backendAlive: false,
    })).toEqual({ kind: 'replacement-recovery', skipRestartBudget: false });
  });
});

/**
 * P1 executable coverage (Codex's suggested DI approach — no real JSONL/IPC):
 * the drain-before-ambiguous ordering that stops a just-completed durable turn
 * from being re-dispatched. Stubs stand in for drain / isStillInFlight / emit /
 * release so we can assert the exact call pattern per scenario.
 */
describe('settleDurableTurnForRestart', () => {
  function harness(opts: {
    hasInFlightTurn: boolean;
    hasCurrentTurnId: boolean;
    // inFlight readings returned by successive isStillInFlight() calls
    inFlightReadings: boolean[];
  }) {
    const drain = vi.fn();
    const emitAmbiguous = vi.fn();
    const release = vi.fn();
    let i = 0;
    const isStillInFlight = vi.fn(() => opts.inFlightReadings[Math.min(i++, opts.inFlightReadings.length - 1)]);
    const result = settleDurableTurnForRestart({
      hasInFlightTurn: opts.hasInFlightTurn,
      hasCurrentTurnId: opts.hasCurrentTurnId,
      drain,
      isStillInFlight,
      emitAmbiguous,
      release,
    });
    return { result, drain, emitAmbiguous, release };
  }

  it('no in-flight durable turn → does nothing (no drain / emit / release)', () => {
    const h = harness({ hasInFlightTurn: false, hasCurrentTurnId: true, inFlightReadings: [true] });
    expect(h.drain).not.toHaveBeenCalled();
    expect(h.emitAmbiguous).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.result).toEqual({ drained: false, ambiguousEmitted: false, released: false });
  });

  it('drain SETTLES the turn (completed won the deduper) → drains, 0 ambiguous, no release', () => {
    // isStillInFlight: after drain → false (settled). emit skipped; release skipped.
    const h = harness({ hasInFlightTurn: true, hasCurrentTurnId: true, inFlightReadings: [false, false] });
    expect(h.drain).toHaveBeenCalledTimes(1);
    expect(h.emitAmbiguous).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.result).toEqual({ drained: true, ambiguousEmitted: false, released: false });
  });

  it('turn STILL in flight after drain → drains then emits ambiguous exactly once', () => {
    // isStillInFlight: after drain → true (emit). emitTurnTerminal itself resets
    // the latch, so the post-emit reading → false (no redundant release).
    const h = harness({ hasInFlightTurn: true, hasCurrentTurnId: true, inFlightReadings: [true, false] });
    expect(h.drain).toHaveBeenCalledTimes(1);
    expect(h.emitAmbiguous).toHaveBeenCalledTimes(1);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.result).toEqual({ drained: true, ambiguousEmitted: true, released: false });
  });

  it('emit did not clear the latch (mismatched attempt) → fallback release fires', () => {
    // still in flight after drain (emit), and STILL in flight after emit → release.
    const h = harness({ hasInFlightTurn: true, hasCurrentTurnId: true, inFlightReadings: [true, true] });
    expect(h.emitAmbiguous).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.result).toEqual({ drained: true, ambiguousEmitted: true, released: true });
  });

  it('in-flight but no currentTurnId (nothing to emit) → skip drain+emit, release the latch', () => {
    // Can't emit without a turn id; still must release so respawn isn't stranded.
    const h = harness({ hasInFlightTurn: true, hasCurrentTurnId: false, inFlightReadings: [true] });
    expect(h.drain).not.toHaveBeenCalled();
    expect(h.emitAmbiguous).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.result).toEqual({ drained: false, ambiguousEmitted: false, released: true });
  });
});

/**
 * May the current replacement settle the active correlated restart attempt
 * (#1863)? Shared by the prompt-ready edge, the restart continuation end and
 * the verified Codex auto-upgrade.
 */
describe('decideRestartReceipt', () => {
  it('emits for an installed replacement outside an auto-upgrade', () => {
    expect(decideRestartReceipt({ backendInstalled: true, upgradeInFlight: false })).toBe('emit');
  });

  it('never emits without an installed backend', () => {
    expect(decideRestartReceipt({ backendInstalled: false, upgradeInFlight: false })).toBe('defer_no_backend');
    expect(decideRestartReceipt({ backendInstalled: false, upgradeInFlight: true })).toBe('defer_no_backend');
  });

  it('defers while a Codex auto-upgrade owns the restart window (it verifies only after ready)', () => {
    expect(decideRestartReceipt({ backendInstalled: true, upgradeInFlight: true })).toBe('defer_upgrade');
  });
});

/**
 * #1863: a correlated restart folded into an in-flight restart window may only
 * be settled by a replacement that runs what it asked for. Judged by value on
 * the four settings a restart can change.
 */
describe('restart launch settings (value-based)', () => {
  const base = { workingDir: '/w', env: { A: '1', B: '2' }, model: 'm', larkToolBinding: true };

  it('picks exactly the four restart-updatable fields', () => {
    expect(restartLaunchSettings({ ...base, cliId: 'codex', prompt: 'x' } as any)).toEqual(base);
    expect(restartLaunchSettings(undefined)).toEqual({
      workingDir: undefined, env: undefined, model: undefined, larkToolBinding: undefined,
    });
  });

  it('ignores env key order and object identity', () => {
    expect(sameRestartLaunchSettings(base, { ...base, env: { B: '2', A: '1' } })).toBe(true);
  });

  it('differs on each field', () => {
    expect(sameRestartLaunchSettings(base, { ...base, workingDir: '/x' })).toBe(false);
    expect(sameRestartLaunchSettings(base, { ...base, env: { A: '1', B: '3' } })).toBe(false);
    expect(sameRestartLaunchSettings(base, { ...base, env: { A: '1' } })).toBe(false);
    expect(sameRestartLaunchSettings(base, { ...base, env: undefined })).toBe(false);
    expect(sameRestartLaunchSettings(base, { ...base, model: undefined })).toBe(false);
    expect(sameRestartLaunchSettings(base, { ...base, larkToolBinding: false })).toBe(false);
  });
});

describe('classifyMergedRestart', () => {
  const snapshot = { workingDir: '/w', env: { A: '1' }, model: 'm', larkToolBinding: true };

  it('adopts before the window captured its snapshot (the replacement will be built from the request)', () => {
    expect(classifyMergedRestart({ windowLaunch: undefined, requested: { ...snapshot, model: 'n' }, convergencePending: false })).toBe('adopt');
  });

  it('adopts a request the snapshot already satisfies by value', () => {
    expect(classifyMergedRestart({ windowLaunch: snapshot, requested: { ...snapshot, env: { A: '1' } }, convergencePending: false })).toBe('adopt');
  });

  it('converges a request that differs from the snapshot on any field', () => {
    for (const requested of [
      { ...snapshot, workingDir: '/role-b' },
      { ...snapshot, env: { A: '2' } },
      { ...snapshot, model: 'n' },
      { ...snapshot, larkToolBinding: false },
    ]) {
      expect(classifyMergedRestart({ windowLaunch: snapshot, requested, convergencePending: false })).toBe('converge');
    }
  });

  it('rides an already pending convergence even if the latest request matches the snapshot', () => {
    expect(classifyMergedRestart({ windowLaunch: snapshot, requested: snapshot, convergencePending: true })).toBe('converge');
  });
});

describe('decideRestartFollowup — folded launch-config requests', () => {
  const spawnedLaunch = { workingDir: '/roles/pm', env: { A: '1' }, model: 'm', larkToolBinding: true };
  const healthy = { spawnedWorkingDir: '/roles/pm', currentWorkingDir: '/roles/pm', backendAlive: true, spawnedLaunch };

  it('env / model / tool binding requested after the snapshot → launch-config convergence (budget skipped while alive)', () => {
    expect(decideRestartFollowup({ ...healthy, requestedLaunch: { ...spawnedLaunch, model: 'n' } }))
      .toEqual({ kind: 'launch-config', skipRestartBudget: true });
    expect(decideRestartFollowup({ ...healthy, backendAlive: false, requestedLaunch: { ...spawnedLaunch, env: { A: '2' } } }))
      .toEqual({ kind: 'launch-config', skipRestartBudget: false });
  });

  it('a folded cwd request converges as a cwd-move', () => {
    expect(decideRestartFollowup({ ...healthy, requestedLaunch: { ...spawnedLaunch, workingDir: '/roles/qa' } }))
      .toEqual({ kind: 'cwd-move', skipRestartBudget: true });
  });

  it('a folded request the replacement already satisfies needs no respawn', () => {
    expect(decideRestartFollowup({ ...healthy, requestedLaunch: { ...spawnedLaunch, env: { A: '1' } } }))
      .toEqual({ kind: 'none' });
  });
});

describe('decideUpgradeLaunchConvergence', () => {
  // The upgrade replacement never passes a model.
  const upgradeLaunch = { workingDir: '/w', env: { A: '1' }, model: undefined, larkToolBinding: true };

  it('converges when a folded restart asked for different settings (model / tool binding included)', () => {
    expect(decideUpgradeLaunchConvergence({ upgradeLaunch, current: upgradeLaunch, restartRequested: { ...upgradeLaunch, larkToolBinding: false } })).toBe(true);
    expect(decideUpgradeLaunchConvergence({ upgradeLaunch, current: upgradeLaunch, restartRequested: { ...upgradeLaunch, model: 'n' } })).toBe(true);
  });

  it('settles a folded restart the upgrade replacement satisfies', () => {
    expect(decideUpgradeLaunchConvergence({ upgradeLaunch, current: upgradeLaunch, restartRequested: { ...upgradeLaunch, env: { A: '1' } } })).toBe(false);
  });

  it('converges any cwd / env change (by value) even without a folded restart', () => {
    expect(decideUpgradeLaunchConvergence({ upgradeLaunch, current: { ...upgradeLaunch, workingDir: '/x' }, restartRequested: undefined })).toBe(true);
    expect(decideUpgradeLaunchConvergence({ upgradeLaunch, current: { ...upgradeLaunch, env: { A: '2' } }, restartRequested: undefined })).toBe(true);
    expect(decideUpgradeLaunchConvergence({ upgradeLaunch, current: { ...upgradeLaunch, env: { A: '1' } }, restartRequested: undefined })).toBe(false);
  });

  it('keeps next-spawn semantics for model / tool-binding drift without a folded restart', () => {
    expect(decideUpgradeLaunchConvergence({ upgradeLaunch, current: { ...upgradeLaunch, model: 'per-message-refresh' }, restartRequested: undefined })).toBe(false);
  });
});


describe('Auto restart launch convergence', () => {
  const pool = { enabled: true as const, models: ['core', 'backup'], queueTimeoutMs: 30_000,
    modelSettings: { core: { reasoningEffort: 'high' as const } } };
  it('preserves Auto policy and resolved model settings in the launch snapshot', () => {
    const config = { model: 'core', traexAutoModel: pool, reasoningEffort: 'high', modelBackendVariant: 'max',
      envUnset: ['HTTP_PROXY'], envFingerprint: 'stamp' } as any;
    expect(restartLaunchSettings(config)).toMatchObject(config);
  });
  it.each([
    { traexAutoModel: { ...pool, models: ['core', 'other'] } },
    { traexAutoModel: { ...pool, modelSettings: { core: { reasoningEffort: 'xhigh' as const } } } },
    { reasoningEffort: 'xhigh' }, { modelBackendVariant: 'standard' },
    { envUnset: ['API_TOKEN'] }, { envFingerprint: 'new-stamp' },
  ])('converges a folded request whose launch settings changed (%j)', change => {
    const before = restartLaunchSettings({ model: 'core', traexAutoModel: pool, reasoningEffort: 'high',
      modelBackendVariant: 'max', envUnset: ['HTTP_PROXY'], envFingerprint: 'stamp' } as any);
    const requested = restartLaunchSettings({ ...before, ...change } as any);
    expect(classifyMergedRestart({ windowLaunch: before, requested, convergencePending: false })).toBe('converge');
    expect(decideRestartFollowup({ spawnedWorkingDir: '/w', currentWorkingDir: '/w', backendAlive: true,
      spawnedLaunch: before, requestedLaunch: requested })).toEqual({ kind: 'launch-config', skipRestartBudget: true });
  });
  it('distinguishes explicit RPC false from inheritance, and ignores unset order', () => {
    expect(sameRestartLaunchSettings({}, { codexRpcInput: false })).toBe(false);
    expect(sameRestartLaunchSettings({ envUnset: ['A', 'B'] } as any, { envUnset: ['B', 'A'] } as any)).toBe(true);
  });
});
