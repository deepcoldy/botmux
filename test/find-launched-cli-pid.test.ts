import { describe, it, expect } from 'vitest';
import { findLaunchedCliPid, launcherRetryStillValid, scheduleWrapperRealCliPid } from '../src/core/session-discovery.js';

// Manual scheduler so the retry loop runs deterministically without real timers.
function makeScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => { queue.push(fn); },
    runAll: (max = 100) => { let n = 0; while (queue.length && n++ < max) queue.shift()!(); },
    pending: () => queue.length,
  };
}

// findLaunchedCliPid sees through a wrapperCli launcher (`aiden x claude`) to the
// real CLI process it forks. The OS-probing is injected so the BFS is tested
// deterministically. Models the real tree: launcher(aiden,node) → claude child.
describe('findLaunchedCliPid()', () => {
  // tree: 100 launcher → [200 claude child, 201 auth-rpc child], 200 → 300 (bash)
  const tree: Record<number, number[]> = { 100: [200, 201], 200: [300], 201: [], 300: [] };
  const comm: Record<number, string> = { 100: 'node', 200: 'claude', 201: 'bytecloud-auth', 300: 'bash' };
  const probes = {
    childrenOf: (pid: number) => tree[pid] ?? [],
    commOf: (pid: number) => comm[pid],
  };

  it('finds the real CLI descendant by comm, not the launcher', () => {
    expect(findLaunchedCliPid(100, 'claude-code', 6, probes)).toBe(200);
  });

  it('does NOT match the launcher even though its argv would contain "claude" — comm-only', () => {
    // The launcher (pid 100) comm is "node"; "claude" only lives in its argv.
    // comm-only matching means the launcher is never mistaken for the CLI.
    // (Regression guard: argv-scanning would have returned 100 here.)
    const launcherCommIsBin = { ...comm, 100: 'aiden' }; // even if comm mapped, BFS starts at children
    expect(findLaunchedCliPid(100, 'claude-code', 6, { childrenOf: probes.childrenOf, commOf: (p) => launcherCommIsBin[p] }))
      .toBe(200);
  });

  it('returns null when the launcher has not forked the CLI yet', () => {
    expect(findLaunchedCliPid(100, 'claude-code', 6, { childrenOf: () => [], commOf: probes.commOf })).toBeNull();
  });

  it('returns null when no descendant matches the target cliId', () => {
    expect(findLaunchedCliPid(100, 'codex', 6, probes)).toBeNull();
  });

  it('respects maxDepth — a CLI deeper than the limit is not found', () => {
    // claude at depth 2 (100 → 200 → 250), maxDepth 1 stops before it.
    const deep: Record<number, number[]> = { 100: [200], 200: [250], 250: [] };
    const deepComm: Record<number, string> = { 100: 'node', 200: 'sh', 250: 'claude' };
    const p = { childrenOf: (pid: number) => deep[pid] ?? [], commOf: (pid: number) => deepComm[pid] };
    expect(findLaunchedCliPid(100, 'claude-code', 1, p)).toBeNull();
    expect(findLaunchedCliPid(100, 'claude-code', 6, p)).toBe(250);
  });

  it('resolves the wrapperCli=aiden x codex case to the codex child', () => {
    const t: Record<number, number[]> = { 1: [2], 2: [] };
    const c: Record<number, string> = { 1: 'node', 2: 'codex' };
    expect(findLaunchedCliPid(1, 'codex', 6, { childrenOf: (pid) => t[pid] ?? [], commOf: (pid) => c[pid] })).toBe(2);
  });

  it('terminates on cycles in the reported tree (seen guard)', () => {
    const cyc: Record<number, number[]> = { 1: [2], 2: [1] }; // 2 points back to 1
    const c: Record<number, string> = { 1: 'node', 2: 'sh' };
    expect(findLaunchedCliPid(1, 'claude-code', 6, { childrenOf: (pid) => cyc[pid] ?? [], commOf: (pid) => c[pid] })).toBeNull();
  });
});

// Regression guard for Codex's blocker: a retry tick that started for one spawn
// must not apply its result after a worker restart replaced the backend.
describe('launcherRetryStillValid()', () => {
  const backendA = { id: 'A' };
  const backendB = { id: 'B' };

  it('valid when same backend instance still reports the captured launcher pid', () => {
    expect(launcherRetryStillValid(backendA, backendA, 100, 100)).toBe(true);
  });

  it('invalid after a respawn replaced the backend instance (the blocker)', () => {
    // Old timer fires; global `backend` is now backendB (new spawn). Must NOT
    // write the new session's cliPid/bridgeCliPid from the old launcher tree.
    expect(launcherRetryStillValid(backendB, backendA, 100, 100)).toBe(false);
  });

  it('invalid when the backend was torn down (null) and not yet respawned', () => {
    expect(launcherRetryStillValid(null, backendA, undefined, 100)).toBe(false);
  });

  it('invalid when the same backend now reports a different child pid (pane-child change / pid reuse)', () => {
    expect(launcherRetryStillValid(backendA, backendA, 999, 100)).toBe(false);
  });

  it('invalid when getChildPid is unavailable', () => {
    expect(launcherRetryStillValid(backendA, backendA, null, 100)).toBe(false);
  });
});

// scheduleWrapperRealCliPid is the resolver loop shared by BOTH worker spawn
// paths — the synchronous one and the zellij late-pid fallback. The late-path
// blocker Codex flagged is that the resolver must run there too; this covers the
// resolver's retry/apply/guard behaviour deterministically.
describe('scheduleWrapperRealCliPid()', () => {
  const backendA = { id: 'A' };

  it('applies the real pid on the first tick when the CLI is already forked', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => 200, getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (p) => applied.push(p), schedule: sch.schedule,
    });
    sch.runAll();
    expect(applied).toEqual([200]);
  });

  it('retries until the launcher forks the CLI, then rewires (late/async fork — the zellij case)', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    let calls = 0;
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => (++calls >= 3 ? 200 : null), // not forked for first 2 ticks
      getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (p) => applied.push(p), schedule: sch.schedule,
    });
    sch.runAll();
    expect(calls).toBe(3);
    expect(applied).toEqual([200]);
  });

  it('aborts (never applies) when a respawn swapped the backend mid-retry', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    let current: unknown = backendA;
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => 200, getBackend: () => current, getChildPid: () => 100,
      applyRealPid: (p) => applied.push(p), schedule: sch.schedule,
    });
    current = { id: 'B' }; // worker restart replaced the backend before the tick ran
    sch.runAll();
    expect(applied).toEqual([]);
  });

  it('stops after maxAttempts without applying when the CLI never appears', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    let calls = 0;
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => { calls++; return null; }, getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (p) => applied.push(p), schedule: sch.schedule, maxAttempts: 3,
    });
    sch.runAll();
    expect(applied).toEqual([]);
    expect(calls).toBe(3);
  });

  it('does not apply when the only descendant found IS the launcher pid', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => 100, getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (p) => applied.push(p), schedule: sch.schedule, maxAttempts: 2,
    });
    sch.runAll();
    expect(applied).toEqual([]);
  });
});
