import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { cliAdapterBindsOwnershipPid } from '../src/adapters/cli/ownership-pid.js';
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

// Execute the actual spawn wiring, including BOTH kick sites, without importing
// worker.ts (which starts process IPC). Only OS probes and timers are replaced;
// the gate, late-PID branch, resolver and attestation wiring remain real code.
const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const wiringStart = workerSource.indexOf('const startWrapperRealPidResolve =');
const wiringEnd = workerSource.indexOf('// Bridge fallback: claude-code only.', wiringStart);
if (wiringStart < 0 || wiringEnd < wiringStart) throw new Error('Worker launcher wiring not found');
const workerWiring = transpileModule(workerSource.slice(wiringStart, wiringEnd), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
}).outputText;

function runWorkerWiring(late: boolean, options: {
  cliId?: string; wrapperCli?: string; claudeDataDir?: string; sandboxRequested?: boolean;
} = {}) {
  const scheduler = makeScheduler();
  const backend = { cliPid: 100, getChildPid: () => 100 };
  const context = {
    cfg: { cliId: options.cliId ?? 'codex', wrapperCli: options.wrapperCli ?? 'launcher', workingDir: '/work' },
    claudeDataDir: options.claudeDataDir, sandboxRequested: options.sandboxRequested ?? false,
    credentialOnlyBwrap: false, backend, cliPid: late ? null : 100, bridgeCliPid: undefined,
    lastSpawnOuterBwrapActive: false, lastSpawnTraexLauncherActive: false, lastSpawnCodexLauncherActive: false,
    resolveCodexOwnershipPid: vi.fn((candidatePid: number) => candidatePid),
    process: { env: {} }, cliPidMarker: undefined,
    cliAdapterBindsOwnershipPid,
    findLaunchedCliPid: vi.fn(() => 200), scheduleWrapperRealCliPid,
    publishLocalProcessAttestation: vi.fn(), observeCursorCliSessionId: vi.fn(), observeAntigravityCliSessionId: vi.fn(),
    setTimeout: scheduler.schedule, log: vi.fn(),
  };
  runInNewContext(workerWiring, context);
  scheduler.runAll();
  expect(scheduler.pending()).toBe(0);
  return context;
}

describe('worker wrapper PID wiring', () => {
  it.each([false, true])('attests the Codex child without a Claude data dir (late PID=%s)', late => {
    const result = runWorkerWiring(late);
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(100, 'codex');
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(result.publishLocalProcessAttestation).toHaveBeenLastCalledWith(200);
  });

  it.each([false, true])('preserves Claude wrapper discovery (late PID=%s)', late => {
    const result = runWorkerWiring(late, { cliId: 'claude-code', claudeDataDir: '/claude' });
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(100, 'claude-code');
    expect(result.backend.cliPid).toBe(200);
    expect(result.publishLocalProcessAttestation).toHaveBeenLastCalledWith(200);
  });

  it.each([
    { wrapperCli: '' }, { wrapperCli: '  ' }, { cliId: 'claude-code' },
  ])('does not resolve an ineligible wrapper: %j', options => {
    for (const late of [false, true]) {
      const result = runWorkerWiring(late, options);
      expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
      expect(result.publishLocalProcessAttestation).not.toHaveBeenCalledWith(200);
    }
  });

  // Sandbox ignores wrapperCli, so the #1745 wrapper bridge resolver must stay
  // off (bridgeCliPid never rewired). Sandboxed Codex instead has its OWN bwrap
  // resolver (#1755): it rewires backend.cliPid but never the bridge pid.
  it.each([false, true])('keeps the wrapper bridge resolver off under sandbox while the codex bwrap resolver runs (late=%s)', late => {
    const result = runWorkerWiring(late, { sandboxRequested: true });
    expect(result.bridgeCliPid).toBeUndefined();
    expect(result.backend.cliPid).toBe(200);
  });
});

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

  it('descends bwrap --unshare-pid supervisor → intermediate → traex leaf (sandbox)', () => {
    // Empirically observed shape: node-pty/tmux launches `bwrap`, which forks an
    // intermediate then execs traex in a new pid ns. getChildPid() returns the
    // bwrap supervisor (500); the real traex leaf (502) holds the rollout fd and
    // is host-visible via ps -A ppid links. The BFS must reach it.
    const t: Record<number, number[]> = { 500: [501], 501: [502], 502: [] };
    const c: Record<number, string> = { 500: 'bwrap', 501: 'bwrap', 502: 'traex' };
    expect(findLaunchedCliPid(500, 'traex', 6, { childrenOf: (pid) => t[pid] ?? [], commOf: (pid) => c[pid] })).toBe(502);
  });

  it('descends forge launcher → traex agent leaf', () => {
    const t: Record<number, number[]> = { 700: [701], 701: [702], 702: [] };
    const c: Record<number, string> = { 700: 'forge', 701: 'node', 702: 'traex' };
    expect(findLaunchedCliPid(700, 'traex', 6, { childrenOf: (pid) => t[pid] ?? [], commOf: (pid) => c[pid] })).toBe(702);
  });

  it('returns null when bwrap has not yet exec\'d traex (bounded retry re-runs)', () => {
    // At spawn, bwrap may not have forked the leaf yet — findLaunchedCliPid
    // returns null and the caller's bounded retry re-runs on a later tick.
    const t: Record<number, number[]> = { 500: [501], 501: [] };
    const c: Record<number, string> = { 500: 'bwrap', 501: 'bwrap' };
    expect(findLaunchedCliPid(500, 'traex', 6, { childrenOf: (pid) => t[pid] ?? [], commOf: (pid) => c[pid] })).toBeNull();
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
