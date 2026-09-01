import { describe, expect, it, vi } from 'bun:test';

import { decideRestartFollowup, settleDurableTurnForRestart } from '../src/core/restart-followup-policy.js';

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
