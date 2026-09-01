import { describe, it, expect } from 'bun:test';
import {
  FLEET_GRACEFUL_EXIT_CODE,
  isGracefulExit,
  decideOnExit,
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
      .toEqual({ action: 'restart', nextRestarts: 1 });
  });
  it('crash under the cap → restart with incremented count', () => {
    expect(decideOnExit(proc({ restarts: 0 }), { code: 1, signal: null }))
      .toEqual({ action: 'restart', nextRestarts: 1 });
    expect(decideOnExit(proc({ restarts: 9 }), { code: 1, signal: null }))
      .toEqual({ action: 'restart', nextRestarts: 10 });
  });
  it('crash AT the cap boundary (restarts would exceed max) → park errored', () => {
    // maxRestarts=10: restarts=10 → next would be 11 > 10 → park.
    expect(decideOnExit(proc({ restarts: 10 }), { code: 1, signal: null }))
      .toEqual({ action: 'park', reason: 'max_restarts', atRestarts: 10 });
  });
  it('signal death counts as a crash and restarts', () => {
    expect(decideOnExit(proc({ restarts: 0 }), { code: null, signal: 'SIGKILL' }))
      .toEqual({ action: 'restart', nextRestarts: 1 });
  });
  it('exactly maxRestarts restarts are allowed, the next is parked', () => {
    const p = DEFAULT_RESTART_POLICY;
    let restarts = 0;
    let parked = false;
    for (let i = 0; i < p.maxRestarts + 5; i++) {
      const d = decideOnExit({ restarts }, { code: 1, signal: null });
      if (d.action === 'restart') restarts = d.nextRestarts;
      else if (d.action === 'park') { parked = true; break; }
    }
    expect(restarts).toBe(p.maxRestarts); // 10 successful restarts
    expect(parked).toBe(true);            // then parked
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
