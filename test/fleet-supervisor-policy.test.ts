import { describe, it, expect } from 'vitest';
import {
  FLEET_GRACEFUL_EXIT_CODE,
  isGracefulExit,
  decideOnExit,
  decideCrashExit,
  assertProjectionIdentity,
  planStart,
  freshProc,
  DEFAULT_RESTART_POLICY,
  type FleetProcState,
} from '../src/core/fleet-supervisor-policy.js';

const proc = (over: Partial<FleetProcState> = {}): FleetProcState => ({
  name: 'botmux-0', appId: 'cli_a', pid: 100, generation: 1, status: 'online',
  restarts: 0, lastExitCode: null, startedAt: '2026-01-01T00:00:00Z', ...over,
});

describe('fleet-supervisor-policy — graceful exit (invariant 1)', () => {
  it('code 90 with no signal is graceful (do not restart)', () => {
    expect(isGracefulExit({ code: FLEET_GRACEFUL_EXIT_CODE, signal: null })).toBe(true);
  });
  it('any other code is a crash', () => {
    expect(isGracefulExit({ code: 0, signal: null })).toBe(false);
    expect(isGracefulExit({ code: 1, signal: null })).toBe(false);
    expect(isGracefulExit({ code: 137, signal: null })).toBe(false);
  });
  it('signal death is NEVER graceful, even if code is null', () => {
    expect(isGracefulExit({ code: null, signal: 'SIGKILL' })).toBe(false);
    expect(isGracefulExit({ code: null, signal: 'SIGTERM' })).toBe(false);
    // Defensive: a signal alongside a 90 code still counts as a crash.
    expect(isGracefulExit({ code: FLEET_GRACEFUL_EXIT_CODE, signal: 'SIGKILL' })).toBe(false);
  });

  // 90 is a PRIVATE handshake between our own two managed cores and this policy.
  // A plugin service is third-party code that may use 90 as an ordinary failure
  // code; taking it at its word retires the service instead of restarting it.
  // Under pm2 this could not happen — plugin apps never got stop_exit_codes.
  it('a member that does NOT honour the sentinel treats 90 as a crash', () => {
    expect(isGracefulExit({ code: FLEET_GRACEFUL_EXIT_CODE, signal: null }, false)).toBe(false);
    // …and the default is still to honour it, so our own members are unchanged.
    expect(isGracefulExit({ code: FLEET_GRACEFUL_EXIT_CODE, signal: null })).toBe(true);
  });
});

describe('fleet-supervisor-policy — decideOnExit (invariants 1 + 2)', () => {
  it('graceful → stop, never restart', () => {
    expect(decideOnExit(proc({ restarts: 3 }), { code: 90, signal: null }))
      .toEqual({ action: 'stop', reason: 'graceful' });
  });
  it('an external member exiting 90 is a CRASH and restarts', () => {
    // The whole point of supervising a plugin service is crash-restart. If 90 were
    // honoured here the service would silently vanish, showing a bland 'stopped'.
    expect(decideOnExit(proc({ restarts: 0 }), { code: 90, signal: null }, undefined, false))
      .toEqual({ action: 'restart', nextRestarts: 1, delayMs: DEFAULT_RESTART_POLICY.restartDelayMs });
  });
  it('crash under the cap → restart with incremented count', () => {
    expect(decideOnExit(proc({ restarts: 0 }), { code: 1, signal: null }))
      .toEqual({ action: 'restart', nextRestarts: 1, delayMs: DEFAULT_RESTART_POLICY.restartDelayMs });
    expect(decideOnExit(proc({ restarts: DEFAULT_RESTART_POLICY.maxRestarts - 1 }), { code: 1, signal: null }))
      .toEqual({ action: 'restart', nextRestarts: DEFAULT_RESTART_POLICY.maxRestarts, delayMs: DEFAULT_RESTART_POLICY.restartDelayMs });
  });
  it('crash AT the cap boundary → keep retrying at the cooldown interval', () => {
    expect(decideOnExit(proc({ restarts: DEFAULT_RESTART_POLICY.maxRestarts }), { code: 1, signal: null }))
      .toEqual({ action: 'restart', nextRestarts: DEFAULT_RESTART_POLICY.maxRestarts, delayMs: DEFAULT_RESTART_POLICY.restartCooldownMs });
  });
  it('signal death counts as a crash and restarts', () => {
    expect(decideOnExit(proc({ restarts: 0 }), { code: null, signal: 'SIGKILL' }))
      .toEqual({ action: 'restart', nextRestarts: 1, delayMs: DEFAULT_RESTART_POLICY.restartDelayMs });
  });
  it('bounds rapid retries without ever permanently parking a crashed service', () => {
    const p = DEFAULT_RESTART_POLICY;
    let restarts = 0;
    for (let i = 0; i < p.maxRestarts + 20; i++) {
      const d = decideOnExit({ restarts }, { code: 1, signal: null });
      expect(d.action).toBe('restart');
      if (d.action !== 'restart') throw new Error('crashed service lost its retry');
      expect(d.delayMs).toBe(i < p.maxRestarts ? p.restartDelayMs : p.restartCooldownMs);
      restarts = d.nextRestarts;
    }
    expect(restarts).toBe(p.maxRestarts);
  });
});

describe('fleet-supervisor-policy — decideCrashExit (post-intent-guards path)', () => {
  it('restarts even on code 90 — the sentinel must NOT self-heal-skip here', () => {
    // This is the decision the live supervisor uses AFTER its own stopping /
    // explicitStop guards failed to match. A 90 at that point is unsolicited
    // (an external pkill/kill -TERM), so it restarts instead of retiring.
    expect(decideCrashExit(proc({ restarts: 0 })))
      .toEqual({ action: 'restart', nextRestarts: 1, delayMs: DEFAULT_RESTART_POLICY.restartDelayMs });
  });
  it('can never return stop (no graceful outcome exists on this path)', () => {
    for (let restarts = 0; restarts <= DEFAULT_RESTART_POLICY.maxRestarts + 2; restarts++) {
      expect(decideCrashExit(proc({ restarts })).action).not.toBe('stop');
    }
  });
  it('keeps the cooldown when an older state has already exceeded the cap', () => {
    expect(decideCrashExit(proc({ restarts: DEFAULT_RESTART_POLICY.maxRestarts + 5 })))
      .toEqual({ action: 'restart', nextRestarts: DEFAULT_RESTART_POLICY.maxRestarts, delayMs: DEFAULT_RESTART_POLICY.restartCooldownMs });
  });
  it('only resets the fast-restart budget after a stable run', () => {
    const policy = { maxRestarts: 3, restartDelayMs: 7, restartCooldownMs: 500, resetAfterMs: 1000 };
    const exhausted = proc({ restarts: policy.maxRestarts });
    expect(decideCrashExit(exhausted, policy, policy.resetAfterMs - 1))
      .toEqual({ action: 'restart', nextRestarts: policy.maxRestarts, delayMs: policy.restartCooldownMs });
    expect(decideCrashExit(exhausted, policy, policy.resetAfterMs))
      .toEqual({ action: 'restart', nextRestarts: 1, delayMs: policy.restartDelayMs });
  });
  it('supports a cooldown from the first failure when no fast retries are allowed', () => {
    const policy = { maxRestarts: 0, restartDelayMs: 20, restartCooldownMs: 500 };
    expect(decideCrashExit(proc(), policy))
      .toEqual({ action: 'restart', nextRestarts: 0, delayMs: 500 });
  });
  it('keeps retrying at the cap, identical to decideOnExit for a crash', () => {
    expect(decideCrashExit(proc({ restarts: DEFAULT_RESTART_POLICY.maxRestarts })))
      .toEqual({ action: 'restart', nextRestarts: DEFAULT_RESTART_POLICY.maxRestarts, delayMs: DEFAULT_RESTART_POLICY.restartCooldownMs });
  });
});

describe('fleet-supervisor-policy — assertProjectionIdentity (invariant 3)', () => {
  it('accepts unique names + distinct live pids', () => {
    expect(() => assertProjectionIdentity([
      proc({ name: 'botmux-0', pid: 100 }),
      proc({ name: 'botmux-1', pid: 200 }),
    ])).not.toThrow();
  });
  it('rejects duplicate names', () => {
    expect(() => assertProjectionIdentity([
      proc({ name: 'botmux-0', pid: 100 }),
      proc({ name: 'botmux-0', pid: 200 }),
    ])).toThrow(/duplicate proc name/);
  });
  it('rejects two live procs sharing a pid', () => {
    expect(() => assertProjectionIdentity([
      proc({ name: 'botmux-0', pid: 100 }),
      proc({ name: 'botmux-1', pid: 100 }),
    ])).toThrow(/duplicate live pid/);
  });
  it('allows multiple non-running procs with pid 0 (stopped/errored)', () => {
    expect(() => assertProjectionIdentity([
      proc({ name: 'botmux-0', pid: 0, status: 'stopped' }),
      proc({ name: 'botmux-1', pid: 0, status: 'errored' }),
    ])).not.toThrow();
  });
  it('rejects empty name', () => {
    expect(() => assertProjectionIdentity([proc({ name: '  ' })])).toThrow(/empty proc name/);
  });
});

describe('fleet-supervisor-policy — planStart (invariant 4: idempotent)', () => {
  it('starts nothing when all configured procs are already online', () => {
    const cur = [proc({ name: 'botmux-0', pid: 100 }), proc({ name: 'botmux-1', pid: 200 })];
    expect(planStart(['botmux-0', 'botmux-1'], cur)).toEqual([]);
  });
  it('starts only the missing / not-yet-known names', () => {
    const cur = [proc({ name: 'botmux-0', pid: 100 })];
    expect(planStart(['botmux-0', 'botmux-1'], cur)).toEqual(['botmux-1']);
  });
  it('restarts a stopped or errored proc', () => {
    const cur = [
      proc({ name: 'botmux-0', pid: 0, status: 'stopped' }),
      proc({ name: 'botmux-1', pid: 0, status: 'errored' }),
    ];
    expect(planStart(['botmux-0', 'botmux-1'], cur)).toEqual(['botmux-0', 'botmux-1']);
  });
  it('restarts an online proc whose pid the liveness probe says is dead', () => {
    const cur = [proc({ name: 'botmux-0', pid: 100, status: 'online' })];
    // injected probe: pid 100 is actually dead
    expect(planStart(['botmux-0'], cur, () => false)).toEqual(['botmux-0']);
  });
});

describe('fleet-supervisor-policy — freshProc', () => {
  it('produces an online generation-1 entry', () => {
    const p = freshProc('botmux-0', 'cli_a', 555, '2026-01-01T00:00:00Z');
    expect(p).toMatchObject({ name: 'botmux-0', appId: 'cli_a', pid: 555, generation: 1, status: 'online', restarts: 0, lastExitCode: null });
  });
});
