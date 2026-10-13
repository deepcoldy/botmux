import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { cliAdapterBindsOwnershipPid } from '../src/adapters/cli/ownership-pid.js';
import { cliIdForComm, findLaunchedCliPid, launcherRetryStillValid, scheduleWrapperRealCliPid } from '../src/core/session-discovery.js';

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

// Execute the REAL worker functions resolveCodexOwnershipPid /
// codexProcessIsNativeLeaf (extracted verbatim from worker.ts) in the wiring
// VM, so mutating their leaf/filter logic is caught behaviourally instead of
// being hidden behind a stub.
const leafFnsStart = workerSource.indexOf('function codexProcessIsNativeLeaf');
if (leafFnsStart < 0) throw new Error('codexProcessIsNativeLeaf not found');
const leafFnsEnd = workerSource.indexOf('\n}\n', workerSource.indexOf('function resolveCodexOwnershipPid', leafFnsStart)) + 3;
const leafFnsSource = transpileModule(workerSource.slice(leafFnsStart, leafFnsEnd)
  + '\nthis.__exports.codexProcessIsNativeLeaf = codexProcessIsNativeLeaf;'
  + 'this.__exports.resolveCodexOwnershipPid = resolveCodexOwnershipPid;', {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
}).outputText;
function loadRealLeafFns(deps: { readComm: (pid: number) => string | undefined; findReal: typeof findLaunchedCliPid }) {
  const sandbox: Record<string, unknown> = { __exports: {} };
  runInNewContext(leafFnsSource, {
    ...sandbox,
    readComm: deps.readComm,
    cliIdForComm,
    findLaunchedCliPid: deps.findReal,
  });
  return sandbox.__exports as {
    codexProcessIsNativeLeaf: (pid: number, filter?: string) => boolean;
    resolveCodexOwnershipPid: (pid: number, active: boolean, filter?: string) => number;
  };
}

function runWorkerWiring(late: boolean, options: {
  cliId?: string; wrapperCli?: string; claudeDataDir?: string; sandboxRequested?: boolean;
  launchedCliPid?: number | null;
  // comm of the pane/getChildPid process: 'node' models the npm launcher (a
  // codex descendant must be discovered), 'codex' a direct native install (no
  // descendant scan may run).
  comm?: string;
  cliRuntime?: { source: string; executable: string };
} = {}) {
  const scheduler = makeScheduler();
  const backend = { cliPid: 100, getChildPid: () => 100 };
  const findLaunchedCliPidMock = vi.fn(function (this: unknown, ..._args: unknown[]) {
    return options.launchedCliPid === undefined ? 200 : options.launchedCliPid;
  });
  // The pane process's comm: 'node' models the npm launcher (descendant must be
  // discovered); 'codex' a direct native install (no scan may run). Any other
  // pid has no comm. The REAL cliIdForComm + the REAL worker resolve functions
  // run against this probe, so the leaf/filter logic is covered behaviourally.
  const realFns = loadRealLeafFns({
    readComm: (pid) => (pid === 100 ? (options.comm ?? 'node') : undefined),
    findReal: findLaunchedCliPidMock as unknown as typeof findLaunchedCliPid,
  });
  const context = {
    cfg: {
      cliId: options.cliId ?? 'codex', wrapperCli: options.wrapperCli ?? 'launcher', workingDir: '/work',
      ...(options.cliRuntime ? { cliRuntime: options.cliRuntime } : {}),
    },
    claudeDataDir: options.claudeDataDir, sandboxRequested: options.sandboxRequested ?? false,
    credentialOnlyBwrap: false, backend, cliPid: late ? null : 100, bridgeCliPid: undefined,
    lastSpawnOuterBwrapActive: false, lastSpawnTraexLauncherActive: false, lastSpawnCodexLauncherActive: false,
    lastSpawnCodexExecutable: undefined,
    resolveCodexOwnershipPid: vi.fn(realFns.resolveCodexOwnershipPid),
    codexProcessIsNativeLeaf: vi.fn(realFns.codexProcessIsNativeLeaf),
    process: { env: {} }, cliPidMarker: undefined,
    cliAdapterBindsOwnershipPid,
    findLaunchedCliPid: findLaunchedCliPidMock, scheduleWrapperRealCliPid,
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

  it.each([false, true])('attests the native Codex child behind the standard npm launcher (late PID=%s)', late => {
    const result = runWorkerWiring(late, { wrapperCli: '' });
    // The gate must be ACTIVE for managed Codex even without a sandbox
    // (regression guard: passing outerBwrapActive here silently reverts the fix).
    expect(result.resolveCodexOwnershipPid).toHaveBeenCalledWith(100, true, undefined);
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(100, 'codex', 6, expect.any(Object), undefined);
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBeUndefined();
    expect(result.publishLocalProcessAttestation).toHaveBeenLastCalledWith(200);
  });

  it.each([false, true])('forwards the configured custom codex executable to BOTH resolve sites (late PID=%s)', late => {
    // Renamed Codex-compatible runtime: the child never forks, so every
    // descendant probe — the synchronous resolve (1) plus 30 retry ticks —
    // must carry the exact configured executable name. No call may fall back
    // to the static 'codex' map.
    const result = runWorkerWiring(late, {
      wrapperCli: '', launchedCliPid: null,
      cliRuntime: { source: 'configured', executable: '/opt/foo/my-codex' },
    });
    expect(result.resolveCodexOwnershipPid).toHaveBeenCalledWith(100, true, '/opt/foo/my-codex');
    expect(result.findLaunchedCliPid).toHaveBeenCalledTimes(31);
    expect(result.findLaunchedCliPid.mock.calls.every(call => call[4] === '/opt/foo/my-codex')).toBe(true);
    expect(result.backend.cliPid).toBe(100);
  });

  it.each([false, true])('recognises a renamed native leaf by the configured executable and skips scans (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      wrapperCli: '', comm: 'my-codex',
      cliRuntime: { source: 'configured', executable: '/opt/foo/my-codex' },
    });
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
    expect(result.backend.cliPid).toBe(100);
  });

  it.each([false, true])('does NOT treat the official-name comm as a leaf for a configured renamed runtime (fail closed) (late PID=%s)', late => {
    // customCodexExecutableName deliberately maps the official 'codex' name to
    // an unmatchable identity when a custom runtime is configured; a process
    // literally named codex must therefore be descended through, not trusted.
    const result = runWorkerWiring(late, {
      wrapperCli: '', comm: 'codex', launchedCliPid: null,
      cliRuntime: { source: 'configured', executable: '/opt/foo/my-codex' },
    });
    expect(result.findLaunchedCliPid).toHaveBeenCalled();
  });

  it.each([false, true])('never scans descendants when the pane pid already is a native codex leaf (late PID=%s)', late => {
    // Direct standalone install: getChildPid() itself IS the native binary.
    // The synchronous resolve returns it unchanged and the retry loop stops on
    // the first tick WITHOUT a single descendant scan (the P2 waste: 31 full
    // process-table scans per spawn otherwise).
    const result = runWorkerWiring(late, { wrapperCli: '', comm: 'codex' });
    expect(result.resolveCodexOwnershipPid).toHaveBeenCalledWith(100, true, undefined);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
    expect(result.backend.cliPid).toBe(100);
    expect(result.bridgeCliPid).toBeUndefined();
    // The resolved native child (200) must never be attested; only the raw pid
    // is, and solely on the late-pid path (which always attests once).
    expect(result.publishLocalProcessAttestation).not.toHaveBeenCalledWith(200);
    expect(result.publishLocalProcessAttestation.mock.calls.every(call => call[0] === 100)).toBe(true);
    expect(result.publishLocalProcessAttestation).toHaveBeenCalledTimes(late ? 1 : 0);
  });

  it.each([false, true])('keeps the launcher pid while the native child has not forked yet (late PID=%s)', late => {
    const result = runWorkerWiring(late, { wrapperCli: '', launchedCliPid: null });
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(100, 'codex', 6, expect.any(Object), undefined);
    expect(result.backend.cliPid).toBe(100);
    expect(result.bridgeCliPid).toBeUndefined();
    expect(result.publishLocalProcessAttestation).not.toHaveBeenCalledWith(200);
    expect(result.publishLocalProcessAttestation.mock.calls.every(call => call[0] === 100)).toBe(true);
    expect(result.publishLocalProcessAttestation).toHaveBeenCalledTimes(late ? 1 : 0);
  });

  it.each([false, true])('a whitespace wrapperCli skips only the generic wrapper resolver, not the codex one (late PID=%s)', late => {
    // The trim() short-circuit in startWrapperRealPidResolve is the sole
    // protection for a blank/whitespace wrapperCli: the generic wrapper bridge
    // resolver must stay off (bridgeCliPid untouched), but the codex-native
    // launcher resolver is unconditional and must still rewire cliPid.
    const result = runWorkerWiring(late, { wrapperCli: '  ' });
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBeUndefined();
  });

  it.each([
    { cliId: 'claude-code', wrapperCli: '' },
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
    // The production resolver supplies optional BFS probe/filter arguments;
    // this boundary cares that every probe starts at the launcher and targets
    // Codex, not about the internal optional-argument representation.
    expect(result.findLaunchedCliPid.mock.calls).not.toHaveLength(0);
    expect(result.findLaunchedCliPid.mock.calls.every((args: unknown[]) =>
      args[0] === 100 && args[1] === 'codex',
    )).toBe(true);
    expect(result.backend.cliPid).toBe(200);
    expect(result.publishLocalProcessAttestation).toHaveBeenLastCalledWith(200);
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

  it('stops on the first tick, without any descendant scan, when isDirectLeaf reports the leaf', () => {
    // Direct native install: scanning the launcher's descendants 30 times is
    // pure waste. isDirectLeaf must abort BEFORE findRealPid runs.
    const sch = makeScheduler();
    const findRealPid = vi.fn(() => 200);
    const applied: number[] = [];
    const schedules: Array<() => void> = [];
    scheduleWrapperRealCliPid(100, {
      findRealPid, isDirectLeaf: () => true,
      getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (p) => applied.push(p),
      schedule: (fn) => { schedules.push(fn); sch.schedule(fn); },
    });
    sch.runAll();
    expect(findRealPid).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
    expect(schedules.length).toBe(1); // only the initial tick, no re-arm
  });

  it('still descends normally when isDirectLeaf reports false', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => 200, isDirectLeaf: () => false,
      getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (p) => applied.push(p), schedule: sch.schedule,
    });
    sch.runAll();
    expect(applied).toEqual([200]);
  });
});
