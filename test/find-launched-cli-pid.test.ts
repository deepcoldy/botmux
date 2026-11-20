import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { cliAdapterBindsOwnershipPid } from '../src/adapters/cli/ownership-pid.js';
import { CODEX_LEAF_SEARCH_DEPTH, cliIdForComm, createElapsedDeadline, findLaunchedCliPid, isClaudeMetadataProbeArgv, wrapperGenericLauncherComm, isNonInteractiveCodexArgv, launcherRetryStillValid, processExecutableArgvSlots, scheduleWrapperRealCliPid } from '../src/core/session-discovery.js';
import { sameExecutableObject } from '../src/services/cli-install-identity.js';
import { isProgramStatusRelayArgv } from '../src/core/program-status-relay-launch.js';
import { unwrapBotmuxLaunchLayers } from '../src/core/launch-layers.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS } from '../src/utils/codex-app-control.js';
import { resolveTraexOwnershipPid, scheduleTraexLeafPidResolve } from '../src/core/traex-leaf-pid.js';
import { zmxStablePanePidFromProbe } from '../src/adapters/backend/zmx-backend.js';

// Manual scheduler so the retry loop runs deterministically without real timers.
function makeScheduler() {
  let now = 0;
  const queue: Array<{ fn: () => void; at: number }> = [];
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    schedule: (fn: () => void, ms = 0) => { queue.push({ fn, at: now + ms }); },
    runAll: (max = 1_000) => {
      let n = 0;
      while (queue.length && n++ < max) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue.shift()!;
        now = Math.max(now, next.at);
        next.fn();
      }
    },
    pending: () => queue.length,
  };
}

// Execute the actual spawn wiring, including BOTH kick sites, without importing
// worker.ts (which starts process IPC). Only OS probes and timers are replaced;
// the gate, late-PID branch, resolver and attestation wiring remain real code.
const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const wiringStart = workerSource.indexOf('const applyResolvedCliPid =');
const wiringEnd = workerSource.indexOf('// Bridge fallback: claude-code only.', wiringStart);
if (wiringStart < 0 || wiringEnd < wiringStart) throw new Error('Worker launcher wiring not found');
const workerWiring = transpileModule(workerSource.slice(wiringStart, wiringEnd), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
}).outputText;
const directIdentityCaptureStart = workerSource.indexOf('if (credentialOnlyBwrap && !sandboxRequested && !!cfg.wrapperCli?.trim() && !!claudeDataDir) {');
const directIdentityCaptureEnd = workerSource.indexOf('backend.spawn(spawnBin, spawnArgs, {', directIdentityCaptureStart);
if (directIdentityCaptureStart < 0 || directIdentityCaptureEnd < directIdentityCaptureStart) {
  throw new Error('Worker pre-spawn direct identity capture not found');
}
// Execute the real capture too: supplying only a hand-built identity here would
// let a regression delete the production capture while every resolver test stayed green.
const directIdentityCapture = transpileModule(workerSource.slice(directIdentityCaptureStart, directIdentityCaptureEnd), {
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
function loadRealLeafFns(deps: {
  readComm: (pid: number) => string | undefined;
  findReal: typeof findLaunchedCliPid;
  snapshotChildPids: () => (pid: number) => number[];
}) {
  const sandbox: Record<string, unknown> = { __exports: {} };
  runInNewContext(leafFnsSource, {
    ...sandbox,
    readComm: deps.readComm,
    readCmdline: () => [],
    isNonInteractiveCodexArgv,
    isZombieProcess: () => false,
    cliIdForComm,
    findLaunchedCliPid: deps.findReal,
    CODEX_LEAF_SEARCH_DEPTH,
    snapshotChildPids: deps.snapshotChildPids,
  });
  return sandbox.__exports as {
    codexProcessIsNativeLeaf: (pid: number, filter?: string) => boolean;
    resolveCodexOwnershipPid: (pid: number, active: boolean, filter?: string) => number;
  };
}

function runWorkerWiring(late: boolean, options: {
  cliId?: string; wrapperCli?: string; claudeDataDir?: string; sandboxRequested?: boolean; credentialOnlyBwrap?: boolean;
  launchedCliPid?: number | null;
  launchedCliAfterMs?: number;
  beforeTimers?: (scope: Record<string, any>) => void;
  // comm of the pane/getChildPid process: 'node' models the npm launcher (a
  // codex descendant must be discovered), 'codex' a direct native install (no
  // descendant scan may run).
  comm?: string;
  /** argv of any synthetic process; pane-specific fields below take precedence for pid 100. */
  cmdlines?: Record<number, string[]>;
  /** Kernel executable image paths used to distinguish a wrapper from an exec'd CLI. */
  runningExes?: Record<number, string | undefined>;
  /** Resolved wrapper command captured before credential sandbox wrapping. */
  wrapperLaunch?: { bin: string; args: string[] };
  /** Base CLI command captured before wrapper and sandbox rewriting. */
  directCliBin?: string;
  /** Mutable birth identities and zombie states used by the startup liveness monitor. */
  processStarts?: Record<number, string | undefined>;
  /** Optional executable identity overrides for wrapper replacement scenarios. */
  installInos?: Record<string, string>;
  /** Direct CLI identity captured immediately before this spawn. */
  spawnInstallInos?: Record<string, string>;
  runningInos?: Record<number, string>;
  /** Paths that must fail executable identity resolution. */
  missingPaths?: string[];
  zombies?: Record<number, boolean>;
  /** argv of the pane pid (100); defaults to a plain launcher. */
  paneCmdline?: string[];
  /** The pane's argv once it has exec'd (after `execAfterReads` cmdline reads). */
  paneCmdlineAfterExec?: string[];
  execAfterReads?: number;
  /** Direct children of the relay (pid 100). Defaults to the single child 150. */
  relayChildren?: number[];
  /** comm of relay children (defaults to "claude"). */
  childComms?: Record<number, string>;
  backendType?: string;
  /** This spawn wrapped the CLI in the OSC 7501 relay / backend reused an existing pane. */
  relayLaunched?: boolean;
  reattached?: boolean;
  cliRuntime?: { source: string; executable: string };
  /** The pane pid is the owned-scope supervisor; resolve to this payload pid. */
  scopePayloadPid?: number;
  /** Which pid is the scope supervisor (default: the pane, 100). */
  scopeSupervisorPid?: number;
  /** This spawn wrapped the CLI in the scope (default: a payload is modelled). */
  scopeLaunched?: boolean;
  /** Payload becomes observable only after this many sessionScopePayloadPid reads. */
  scopePayloadAfterProbe?: number;
  /** Children of pids other than the pane (100); a synthetic launch chain. */
  children?: Record<number, number[]>;
  /** A TRAE child first becomes visible after this much launcher time. */
  traexChildAfterMs?: number;
  /** Herdr/ZMX shape: getChildPid() reports the MUTABLE cliPid, which gets
   *  rewired to the discovered leaf, rather than the stable pane/launcher pid. */
  aliasedChildPid?: boolean;
  /** Optional synchronous cost and override result for getChildPid(). */
  childPidProbeMs?: number;
  childPidResult?: number | null;
  /** Stable backing-pane identity, independent of cliPid rewrites. */
  stablePanePid?: number | null;
  /** Synchronous time consumed by each stable-pane probe. */
  stablePaneProbeMs?: number;
  /** Model a backend without the optional stable-pane accessor (worker falls back to getChildPid). */
  stablePaneAccessor?: boolean;
  /** ZMX launch=100 vs PTY-root=10 shape, with a controllable list-probe answer. */
  zmxStablePane?: { probeOk: boolean; rootPid: number | null; backingPid: number };
  /** Run the real BFS over the synthetic table (`children` / `childComms`)
   *  with the depth the worker passes, instead of the canned result. */
  realCodexSearch?: boolean;
  /** Pids whose process has exited: their birth token no longer reads back. */
  exited?: number[];
} = {}) {
  const scheduler = makeScheduler();
  let scopeProbes = 0;
  const backend: {
    cliPid: number;
    getChildPid: () => number | null;
    getStablePanePid?: () => number | null;
  } = {
    cliPid: 100,
    getChildPid: () => {
      scheduler.advance(options.childPidProbeMs ?? 0);
      if (options.childPidResult !== undefined) return options.childPidResult;
      return options.aliasedChildPid ? backend.cliPid : 100;
    },
    ...(options.stablePaneAccessor === false ? {} : {
      getStablePanePid: () => {
        scheduler.advance(options.stablePaneProbeMs ?? 0);
        const zmx = options.zmxStablePane;
        if (zmx) {
          const probeOk = zmx.probeOk;
          // Consume a synthetic one-shot failure at the actual accessor call,
          // so both synchronous and late-PID binding exercise initial recovery.
          zmx.probeOk = true;
          return zmxStablePanePidFromProbe(probeOk ? {
            ok: true as const,
            sessions: zmx.rootPid === null ? [] : ['zmx'],
            unhealthySessions: [],
            raw: zmx.rootPid === null ? '' : `  name=zmx\tpid=${zmx.rootPid}\tclients=1\tcmd=/bin/sh\n`,
          } : { ok: false }, 'zmx', zmx.backingPid);
        }
        return options.stablePanePid === undefined ? 100 : options.stablePanePid;
      },
    }),
  };
  const findLaunchedCliPidMock = vi.fn(function (this: unknown, ...args: unknown[]) {
    if (scheduler.now() < (options.launchedCliAfterMs ?? 0)) return null;
    if (options.realCodexSearch) {
      const [pid, cliId, depth, probes, filter] = args as Parameters<typeof findLaunchedCliPid>;
      return findLaunchedCliPid(pid, cliId, depth, {
        childrenOf: context.getChildPids,
        commOf: context.readComm,
        cmdlineOf: (p) => options.cmdlines?.[p] ?? [],
        isZombie: (p) => options.zombies?.[p] ?? false,
        ...probes,
      }, filter);
    }
    return options.launchedCliPid === undefined ? 200 : options.launchedCliPid;
  });
  const childSnapshot = () => {
    const cache = new Map<number, number[]>();
    return (pid: number) => {
      if (!cache.has(pid)) cache.set(pid, [...context.getChildPids(pid)]);
      return [...cache.get(pid)!];
    };
  };
  const snapshotChildPidsMock = vi.fn(childSnapshot);
  // The pane process's comm: 'node' models the npm launcher (descendant must be
  // discovered); 'codex' a direct native install (no scan may run). Any other
  // pid has no comm. The REAL cliIdForComm + the REAL worker resolve functions
  // run against this probe, so the leaf/filter logic is covered behaviourally.
  const realFns = loadRealLeafFns({
    readComm: (pid) => (pid === 100 ? (options.comm ?? 'node') : undefined),
    findReal: findLaunchedCliPidMock as unknown as typeof findLaunchedCliPid,
    snapshotChildPids: childSnapshot,
  });
  const currentProcessStart = (pid: number): string | undefined =>
    options.exited?.includes(pid) ? undefined
      : options.processStarts ? options.processStarts[pid] : `birth-${pid}`;
  const context = {
    cfg: {
      cliId: options.cliId ?? 'codex', wrapperCli: options.wrapperCli ?? 'launcher', workingDir: '/work',
      ...(options.cliRuntime ? { cliRuntime: options.cliRuntime } : {}),
    },
    claudeDataDir: options.claudeDataDir, sandboxRequested: options.sandboxRequested ?? false,
    credentialOnlyBwrap: options.credentialOnlyBwrap ?? false, backend, cliPid: late ? null : 100, bridgeCliPid: undefined,
    configuredWrapperLaunch: options.wrapperLaunch ?? { bin: '/opt/wrapper/launcher', args: ['claude'] },
    sandboxDirectCliIdentityAtSpawn: undefined as unknown,
    sandboxWrapperExecutableIdentityAtSpawn: undefined as unknown,
    reproduceBaseBin: options.directCliBin ?? '/opt/claude/claude',
    spawnCwd: '/work',
    // Module-level spawn counter read by the TRAE leaf-resolve guard; the sliced
    // wiring runs in this VM without worker.ts's declaration, so supply its
    // initial value. It is only read inside the slice, never assigned.
    cliSpawnGeneration: 0,
    scopePayloadLauncherActive: options.scopeLaunched ?? options.scopePayloadPid !== undefined,
    lastSpawnOuterBwrapActive: false, lastSpawnTraexLauncherActive: false, lastSpawnCodexLauncherActive: false,
    lastSpawnCodexExecutable: undefined,
    lastSpawnCodexLauncherPid: undefined,
    codexOwnershipAttestationPending: false,
    refreshSandboxedCliLeafAttestation: undefined as (() => void) | undefined,
    FIRST_PROMPT_HARD_TIMEOUT_MS: CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS,
    CODEX_LEAF_SEARCH_DEPTH,
    snapshotChildPids: snapshotChildPidsMock,
    resolveCodexOwnershipPid: vi.fn(realFns.resolveCodexOwnershipPid),
    codexProcessIsNativeLeaf: vi.fn(realFns.codexProcessIsNativeLeaf),
    process: { env: {} }, cliPidMarker: undefined,
    cliAdapterBindsOwnershipPid,
    findLaunchedCliPid: findLaunchedCliPidMock, cliIdForComm, isClaudeMetadataProbeArgv,
    scheduleWrapperRealCliPid: (pid: number, deps: Parameters<typeof scheduleWrapperRealCliPid>[1]) =>
      scheduleWrapperRealCliPid(pid, { ...deps, now: scheduler.now }),
    createElapsedDeadline: (maxElapsedMs: number | undefined) => createElapsedDeadline(maxElapsedMs, scheduler.now),
    basename, resolve, processExecutableArgvSlots, wrapperGenericLauncherComm, sameExecutableObject,
    resolveInstallIdentity: (path: string) => options.missingPaths?.includes(path) ? undefined
      : { path, dev: 'dev', ino: options.installInos?.[path] ?? path, size: '1', mtimeNs: '1', source: 'install-stat' },
    sessionScopePayloadPid: vi.fn((pid: number) => {
      scopeProbes++;
      return options.scopePayloadPid !== undefined
        && pid === (options.scopeSupervisorPid ?? 100)
        && scopeProbes >= (options.scopePayloadAfterProbe ?? 1)
        ? options.scopePayloadPid
        : pid;
    }),
    readCmdline: (() => {
      let reads = 0;
      return (pid: number) => {
        if (pid !== 100) return options.cmdlines?.[pid] ?? [];
        reads++;
        if (options.paneCmdlineAfterExec && reads > (options.execAfterReads ?? 0)) return options.paneCmdlineAfterExec;
        return options.paneCmdline ?? ['launcher'];
      };
    })(),
    getChildPids: vi.fn((pid: number) => {
      if (options.traexChildAfterMs !== undefined && scheduler.now() < options.traexChildAfterMs) return [];
      return pid === 100 ? (options.relayChildren ?? [150]) : (options.children?.[pid] ?? []);
    }),
    readComm: (pid: number) => (pid === 100 ? (options.comm ?? 'node') : (options.childComms?.[pid] ?? 'claude')),
    readCwd: () => '/work',
    readProcessStartIdentity: currentProcessStart,
    readRunningExeIdentity: (pid: number, expectedProcStart?: string) => {
      const path = options.runningExes?.[pid];
      const procStart = currentProcessStart(pid);
      return path && (expectedProcStart === undefined || procStart === expectedProcStart)
        ? { path, dev: 'dev', ino: options.runningInos?.[pid] ?? path, size: '1', mtimeNs: '1', source: 'linux-proc-exe' }
        : undefined;
    },
    isZombieProcess: (pid: number) => options.zombies?.[pid] ?? false,
    isProgramStatusRelayArgv,
    programStatusRelayLaunched: options.relayLaunched ?? false,
    effectiveBackendType: options.backendType ?? 'tmux',
    actuallyReattachedPersistent: options.reattached ?? false,
    publishLocalProcessAttestation: vi.fn((pid?: number, _enginePid?: number, expectedProcStart?: string) => {
      if (pid && expectedProcStart !== undefined && currentProcessStart(pid) !== expectedProcStart) return false;
      return true;
    }), observeCursorCliSessionId: vi.fn(), observeAntigravityCliSessionId: vi.fn(), observeZcodeCliSessionId: vi.fn(),
    setTimeout: scheduler.schedule, advanceTime: scheduler.advance, log: vi.fn(),
  };
  // The REAL layer walk and TRAE leaf resolver, probing the same synthetic
  // process table.
  const traexProbes = { childrenOf: context.getChildPids, commOf: context.readComm };
  Object.assign(context, {
    resolveTraexOwnershipPid: (pid: number, active: boolean) => resolveTraexOwnershipPid(pid, active, traexProbes),
    scheduleTraexLeafPidResolve: (pid: number, deps: Parameters<typeof scheduleTraexLeafPidResolve>[1]) =>
      scheduleTraexLeafPidResolve(pid, { ...deps, probes: traexProbes }),
    unwrapBotmuxLaunchLayers: (pid: number, opts: { relay: boolean }) => unwrapBotmuxLaunchLayers(pid, {
      ...opts,
      probes: {
        readCmdline: context.readCmdline, childrenOf: context.getChildPids,
        commOf: context.readComm,
        // Synthetic table: no modelled pid is a zombie. An injected probe keeps
        // the walk off the host's real /proc (a low synthetic pid such as 150
        // may exist on the host and would be read by the default probe).
        isZombie: () => false,
        scopePayloadOf: context.sessionScopePayloadPid,
      },
    }),
  });
  const captureScope = {
    credentialOnlyBwrap: context.credentialOnlyBwrap,
    sandboxRequested: context.sandboxRequested,
    cfg: context.cfg,
    claudeDataDir: context.claudeDataDir,
    sandboxDirectCliIdentityAtSpawn: undefined as unknown,
    sandboxWrapperExecutableIdentityAtSpawn: undefined as unknown,
    cliSpawnGeneration: 0,
    resolveInstallIdentity: (path: string) => options.missingPaths?.includes(path) ? undefined
      : { path, dev: 'dev', ino: options.spawnInstallInos?.[path] ?? options.installInos?.[path] ?? path, size: '1', mtimeNs: '1', source: 'install-stat' },
    resolve,
    spawnCwd: context.spawnCwd,
    reproduceBaseBin: context.reproduceBaseBin,
    configuredWrapperLaunch: context.configuredWrapperLaunch,
  };
  runInNewContext(directIdentityCapture, captureScope);
  context.sandboxDirectCliIdentityAtSpawn = captureScope.sandboxDirectCliIdentityAtSpawn;
  context.sandboxWrapperExecutableIdentityAtSpawn = captureScope.sandboxWrapperExecutableIdentityAtSpawn;
  runInNewContext(workerWiring, context);
  options.beforeTimers?.(context);
  scheduler.runAll();
  expect(scheduler.pending()).toBe(0);
  return { ...context, elapsedMs: scheduler.now() };
}

type PublicationScope = { publishLocalProcessAttestation: { mock: { calls: any[][] } } };
const publicationPids = (scope: PublicationScope): unknown[] =>
  scope.publishLocalProcessAttestation.mock.calls.map(call => call[0]);
const lastPublishedPid = (scope: PublicationScope): unknown => publicationPids(scope).at(-1);

describe('worker wrapper PID wiring', () => {
  it.each([false, true])('binds the native TRAE child of an ordinary Node launcher (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'traex', wrapperCli: '', scopeLaunched: false,
      relayChildren: [200], childComms: { 200: 'traex' },
    });
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
  });

  it.each([false, true])('discovers a delayed TRAE child without a sandbox or wrapperCli setting (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'traex', wrapperCli: '', scopeLaunched: false,
      relayChildren: [200], childComms: { 200: 'traex' }, traexChildAfterMs: 12_000,
    });
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(12_000);
  });

  it.each([false, true])('publishes the TRAE child when the backend aliases its child accessor to the bound PID (late PID=%s)', late => {
    // Observe right after the PID binding (synchronous, or the 120ms late-PID
    // callback) and before the retry's first 500ms tick: the binding itself
    // must publish, not leave the bridge/attestation on the launcher meanwhile.
    let atBinding: { cliPid: number; bridgeCliPid: unknown; attested: unknown[] } | undefined;
    const result = runWorkerWiring(late, {
      cliId: 'traex', wrapperCli: '', scopeLaunched: false, aliasedChildPid: true,
      relayChildren: [200], childComms: { 200: 'traex' },
      beforeTimers: scope => {
        scope.setTimeout(() => {
          atBinding = {
            cliPid: scope.backend.cliPid,
            bridgeCliPid: scope.bridgeCliPid,
            attested: scope.publishLocalProcessAttestation.mock.calls.map((call: unknown[]) => call[0]),
          };
        }, late ? 121 : 0);
      },
    });
    expect(atBinding).toEqual({ cliPid: 200, bridgeCliPid: 200, attested: late ? [100, 200] : [200] });
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
  });

  it.each([false, true])('binds a later-forked TRAE leaf when an aliased child accessor already names the scope payload (late PID=%s)', late => {
    // Herdr/ZMX shape behind the owned session scope: the payload binding moves
    // the aliased cliPid from the pane supervisor (100) to the Node launcher
    // (150) before the retry's first tick, and the native TRAE (200) forks only
    // after that tick. Discovery must keep running for the captured root.
    const result = runWorkerWiring(late, {
      cliId: 'traex', wrapperCli: '', aliasedChildPid: true,
      scopeLaunched: true, scopePayloadPid: 150,
      relayChildren: [150], children: { 150: [200] }, childComms: { 150: 'node', 200: 'traex' },
      traexChildAfterMs: 2_000,
    });
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(2_000);
  });

  it.each([false, true])('keeps a directly launched TRAE root rather than its TRAE subagent (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'traex', wrapperCli: '', scopeLaunched: false, comm: 'traex',
      relayChildren: [200], childComms: { 200: 'traex' },
    });
    expect(result.backend.cliPid).toBe(100);
    // Initial marker/attestation publication is outside this sliced wiring.
    // The behaviour under test is not descending into this root's subagent.
    expect(result.getChildPids).not.toHaveBeenCalled();
  });

  it('does not let delayed TRAE discovery overwrite a newer spawn generation', () => {
    const result = runWorkerWiring(false, {
      cliId: 'traex', wrapperCli: '', scopeLaunched: false,
      relayChildren: [200], childComms: { 200: 'traex' }, traexChildAfterMs: 12_000,
      beforeTimers: scope => { scope.cliSpawnGeneration++; },
    });
    expect(result.backend.cliPid).toBe(100);
    expect(publicationPids(result)).not.toContain(200);
    // The superseded spawn's discovery ends at its next tick instead of
    // rescanning the process table until the old launcher's leaf appears.
    expect(result.elapsedMs).toBeLessThan(12_000);
  });

  it.each([false, true])('binds and attests an owned-scope payload rather than its pane supervisor (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude',
      scopePayloadPid: 150,
    });
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(lastPublishedPid(result)).toBe(150);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([false, true])('binds the sandboxed TRAE leaf under the network-policy chain, not the scope payload (late PID=%s)', late => {
    // Measured network-policy sandbox chain below the scope supervisor (100):
    // runner 150 → unshare 151 → runner 152 → sh 153 → sh 154 → bwrap 155
    // → bwrap init 156 → traex 157. The scope payload (150) is bound first;
    // the leaf sits seven levels down.
    const result = runWorkerWiring(late, {
      cliId: 'traex', wrapperCli: '', sandboxRequested: true,
      scopePayloadPid: 150,
      children: { 150: [151], 151: [152], 152: [153], 153: [154], 154: [155], 155: [156], 156: [157] },
      childComms: { 150: 'node', 151: 'unshare', 152: 'node', 153: 'sh', 154: 'sh', 155: 'bwrap', 156: 'bwrap', 157: 'traex' },
    });
    expect(result.backend.cliPid).toBe(157);
    expect(result.bridgeCliPid).toBe(157);
    expect(lastPublishedPid(result)).toBe(157);
  });

  it.each([false, true])('binds the npm Codex leaf under the network-policy sandbox chain (late PID=%s)', late => {
    // The same measured chain below the scope supervisor (100), with the npm
    // Node launcher (157) between bwrap's init and the native codex (158): the
    // leaf sits eight levels below the scope payload and nine below the pane.
    const result = runWorkerWiring(late, {
      wrapperCli: '', sandboxRequested: true, realCodexSearch: true,
      scopePayloadPid: 150,
      children: { 150: [151], 151: [152], 152: [153], 153: [154], 154: [155], 155: [156], 156: [157], 157: [158] },
      childComms: { 150: 'node', 151: 'unshare', 152: 'node', 153: 'sh', 154: 'sh', 155: 'bwrap', 156: 'bwrap', 157: 'node', 158: 'codex' },
      // The synchronous ownership bind must already reach the leaf: the first
      // turn can read the observed pid before any retry tick rewrites it.
      beforeTimers: late ? undefined : scope => expect(scope.backend.cliPid).toBe(158),
    });
    expect(result.backend.cliPid).toBe(158);
    expect(result.bridgeCliPid).toBe(158);
    expect(lastPublishedPid(result)).toBe(158);
  });

  it.each([false, true])('follows a scope payload that appears after the initial PID wiring (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude',
      scopePayloadPid: 150, scopePayloadAfterProbe: 2,
    });
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(lastPublishedPid(result)).toBe(150);
  });

  it.each([false, true])('keeps resolving the wrapperCli native leaf underneath a scope payload (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', claudeDataDir: '/claude',
      scopePayloadPid: 150,
    });
    // Scope unwraps to 150 first; the wrapper BFS then descends to native 200.
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(150, 'claude-code');
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
  });

  it('keeps scope PID discovery alive while a slow launch shell is still starting', () => {
    const result = runWorkerWiring(false, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude',
      scopePayloadPid: 150, scopePayloadAfterProbe: 40,
    });
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(lastPublishedPid(result)).toBe(150);
  });

  it.each([false, true])('roots Codex launcher ownership discovery at the scope payload, not the sh (late PID=%s)', late => {
    const result = runWorkerWiring(late, { scopePayloadPid: 150 });
    // The pane sh (100) is never searched for the codex native leaf; BFS starts
    // at the payload (150) and descends to 200.
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(150, 'codex');
    expect(result.findLaunchedCliPid).not.toHaveBeenCalledWith(100, 'codex');
    expect(result.backend.cliPid).toBe(200);
  });

  it('roots Codex ownership at the scope payload in the synchronous ownership block', () => {
    // An adopt/reuse codex launch (no Claude data dir, no wrapper CLI) skips
    // every async resolver, so only the immediate synchronous ownership block
    // can unscope the root; with no resolve helpers it must bind the payload.
    const result = runWorkerWiring(false, {
      cliId: 'codex', wrapperCli: '', claudeDataDir: undefined, scopePayloadPid: 150,
      launchedCliPid: null,
    });
    expect(result.backend.cliPid).toBe(150);
    expect(lastPublishedPid(result)).toBe(150);
  });

  it.each([false, true])('attests the Codex child without a Claude data dir (late PID=%s)', late => {
    const result = runWorkerWiring(late);
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(100, 'codex');
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
  });

  it.each([false, true])('preserves Claude wrapper discovery (late PID=%s)', late => {
    const result = runWorkerWiring(late, { cliId: 'claude-code', claudeDataDir: '/claude' });
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(100, 'claude-code');
    expect(result.backend.cliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
  });

  const RELAY_ARGV = ['/usr/bin/node', '/opt/botmux/dist/program-status-relay.js', 'a'.repeat(64), '/tmp/botmux-psr-x/plan.json'];
  it.each([false, true])('binds the relay\'s direct child — whatever its comm — as the CLI pid (late PID=%s)', late => {
    // The child is exactly what the pane pid was before the relay existed, so a
    // node-named Claude (comm-only discovery cannot see it) is still bound.
    const result = runWorkerWiring(late, { cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', paneCmdline: RELAY_ARGV });
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(lastPublishedPid(result)).toBe(150);
  });

  it.each([false, true])('keeps resolving a wrapperCli launcher underneath the relay (late PID=%s)', late => {
    const result = runWorkerWiring(late, { cliId: 'claude-code', claudeDataDir: '/claude', paneCmdline: RELAY_ARGV });
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(150, 'claude-code');
    expect(result.backend.cliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
  });

  // Every tmux Claude pane since the scope supervisor landed: relay (100) →
  // scope sh (150) → Claude (175). Binding the sh leaves the bridge without
  // Claude's pid-state record, so a /clear made before a daemon restart is
  // never followed and the restored bridge reads the pre-clear transcript.
  it.each([false, true])('re-attached relay → scope pane binds Claude, not the scope sh (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', paneCmdline: RELAY_ARGV,
      reattached: true, scopeLaunched: false, scopeSupervisorPid: 150, scopePayloadPid: 175,
    });
    expect(result.backend.cliPid).toBe(175);
    expect(result.bridgeCliPid).toBe(175);
    expect(lastPublishedPid(result)).toBe(175);
  });

  it.each([false, true])('fresh relay → scope launch waits for both layers, then binds Claude (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', relayLaunched: true,
      paneCmdline: ['/bin/sh', '-c', 'exec "$@"'], paneCmdlineAfterExec: RELAY_ARGV, execAfterReads: 2,
      scopeSupervisorPid: 150, scopePayloadPid: 175, scopePayloadAfterProbe: 6,
    });
    expect(result.backend.cliPid).toBe(175);
    expect(result.bridgeCliPid).toBe(175);
    expect(lastPublishedPid(result)).toBe(175);
  });

  it.each([false, true])('waits for a fresh relay while the pane is still the launch shell (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', relayLaunched: true,
      paneCmdline: ['/bin/sh', '-c', 'exec "$@"'], paneCmdlineAfterExec: RELAY_ARGV, execAfterReads: 3,
    });
    expect(result.backend.cliPid).toBe(150);
  });

  it.each([false, true])('never treats a non-tmux CLI as relayed, even if its argv looks like one (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', backendType: 'pty', paneCmdline: RELAY_ARGV,
    });
    expect(result.backend.cliPid).toBe(100);
    expect(publicationPids(result)).not.toContain(150);
  });

  it.each([false, true])('does not treat a Claude arg naming the relay file as a relay (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude',
      paneCmdline: ['/root/.local/bin/claude', '--system-prompt-file', '/tmp/program-status-relay.ts'],
    });
    expect(result.backend.cliPid).toBe(100);
  });

  it.each([false, true])('never binds the relay\'s transient stty helper (late PID=%s)', late => {
    const only = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', paneCmdline: RELAY_ARGV,
      relayChildren: [149], childComms: { 149: 'stty' },
    });
    expect(only.backend.cliPid).toBe(100);
    const both = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', paneCmdline: RELAY_ARGV,
      relayChildren: [149, 150], childComms: { 149: 'stty' },
    });
    expect(both.backend.cliPid).toBe(150);
  });

  it.each([false, true])('does not bind an ambiguous child set (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', paneCmdline: RELAY_ARGV, relayChildren: [150, 151],
    });
    expect(result.backend.cliPid).toBe(100);
  });

  it.each([false, true])('does not assume a relay when the backend reused a pre-existing non-relay pane (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', relayLaunched: true, reattached: true,
      paneCmdline: ['/root/.local/bin/claude'],
    });
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
    expect(result.backend.cliPid).toBe(100);
  });

  it.each([false, true])('binds the sandbox wrapper under the relay, as the pane pid was before (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', claudeDataDir: '/claude', sandboxRequested: true,
      paneCmdline: ['/opt/botmux', '__program-status-relay', 'a'.repeat(64), '/tmp/botmux-psr-x/plan.json'],
    });
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
    expect(result.backend.cliPid).toBe(150);
  });

  it.each([false, true])('attests the Claude Code leaf inside bwrap but keeps the sandbox payload bound (late PID=%s)', late => {
    // Live chain below the scope supervisor (100): launcher sh 150 → bwrap 151
    // → bwrap init 152 → claude.exe 153. Tools descend from 153, which predates
    // every turn, so the lineage proof must root at it.
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', sandboxRequested: true, realCodexSearch: true,
      scopePayloadPid: 150,
      children: { 150: [151], 151: [152], 152: [153] },
      childComms: { 150: 'sh', 151: 'bwrap', 152: 'bwrap', 153: 'claude.exe' },
    });
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(150, 'claude-code', CODEX_LEAF_SEARCH_DEPTH, expect.objectContaining({ childrenOf: expect.any(Function) }));
    expect(result.snapshotChildPids).toHaveBeenCalledTimes(1);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(lastPublishedPid(result)).toBe(153);
  });

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])('never descends from a direct CLI payload on ready/input refresh (credentialOnly=%s, late PID=%s)', (credentialOnly, late) => {
    const children: Record<number, number[]> = {};
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: credentialOnly ? 'launcher' : '', claudeDataDir: '/claude',
      sandboxRequested: !credentialOnly, credentialOnlyBwrap: credentialOnly, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin: '/opt/claude/claude.exe', runningExes: { 150: '/opt/claude/claude.exe' },
      cmdlines: { 150: ['/opt/claude/claude.exe'] },
      children,
      childComms: { 150: 'claude.exe', 154: 'claude.exe' },
    });
    // The wrapper has already exec'd the CLI. A subagent that appears only after
    // the startup polling window must not replace that direct root on an edge.
    children[150] = [154];
    result.refreshSandboxedCliLeafAttestation!();
    result.refreshSandboxedCliLeafAttestation!();
    expect(publicationPids(result)).not.toContain(154);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([
    { shape: 'versioned-native', late: false, exe: '/home/u/.local/share/claude/versions/2.1.224', argv: ['/home/u/.local/bin/claude'] },
    { shape: 'versioned-native', late: true, exe: '/home/u/.local/share/claude/versions/2.1.224', argv: ['/home/u/.local/bin/claude'] },
    { shape: 'interpreter-hosted', late: false, exe: '/usr/bin/node', argv: ['/usr/bin/node', '/opt/claude/claude.js'] },
    { shape: 'interpreter-hosted', late: true, exe: '/usr/bin/node', argv: ['/usr/bin/node', '/opt/claude/claude.js'] },
  ])('keeps a $shape direct root after a late subagent appears (late PID=$late)', ({ shape, late, exe, argv }) => {
    const children: Record<number, number[]> = {};
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin: shape === 'versioned-native' ? exe : argv[1]!,
      runningExes: { 150: exe }, cmdlines: { 150: argv }, children,
      wrapperLaunch: { bin: '/usr/bin/node', args: ['/opt/wrapper/launcher.js', 'claude'] },
      childComms: { 150: 'claude', 154: 'claude' },
    });
    children[150] = [154];
    result.refreshSandboxedCliLeafAttestation!();
    expect(result.elapsedMs).toBeLessThan(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS);
    expect(publicationPids(result)).not.toContain(154);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([
    { shape: 'birth unreadable at setup', reuseBeforeRun: true, late: false },
    { shape: 'birth unreadable at setup', reuseBeforeRun: true, late: true },
    { shape: 'payload slot reused before edge', reuseBeforeRun: false, late: false },
    { shape: 'payload slot reused before edge', reuseBeforeRun: false, late: true },
  ])('keeps the direct root when payload birth evidence is missing or changes ($shape, late PID=$late)', ({ shape, reuseBeforeRun, late }) => {
    const wrapperLaunch = { bin: '/opt/wrapper/launcher', args: ['claude'] };
    // The wrapper rewrites its comm to the CLI name while argv0 keeps its own
    // path, so its argv alone would still match the configured wrapper identity.
    const processStarts: Record<number, string | undefined> = {
      150: reuseBeforeRun ? undefined : 'birth-150',
      154: 'birth-154',
    };
    const children: Record<number, number[]> = {};
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, wrapperLaunch, processStarts,
      runningExes: { 150: wrapperLaunch.bin },
      cmdlines: { 150: ['/opt/wrapper/launcher', 'claude'] },
      children,
      childComms: { 150: 'claude', 154: 'claude' },
      // A pid-reused slot holds a different process by the time edges fire;
      // descending it would publish a leaf capability outside the payload lineage.
      // The late-pid backend binds (and captures payload birth) at its 120ms poll.
      beforeTimers: reuseBeforeRun ? undefined
        : (scope) => { scope.setTimeout(() => { processStarts[150] = 'reused-birth'; }, late ? 121 : 0); },
    });
    children[150] = [154];
    result.refreshSandboxedCliLeafAttestation!();
    expect(publicationPids(result)).not.toContain(154);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
  });

  it.each([false, true])('keeps a native direct root when exec retains the configured wrapper argv0 (late PID=%s)', late => {
    const children: Record<number, number[]> = {};
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin: '/opt/claude/claude.exe', runningExes: { 150: '/opt/claude/claude.exe' },
      cmdlines: { 150: ['/opt/wrapper/launcher', 'claude'] }, children,
      childComms: { 150: 'claude', 154: 'claude' },
    });
    children[150] = [154];
    result.refreshSandboxedCliLeafAttestation!();
    expect(publicationPids(result)).not.toContain(154);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps an execed direct root across a concurrent CLI replacement (late PID=%s)', late => {
    const children: Record<number, number[]> = {};
    const directCliBin = '/opt/claude/claude.exe';
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin,
      spawnInstallInos: { [directCliBin]: 'cli-inode-a' },
      installInos: { [directCliBin]: 'cli-inode-b' },
      runningExes: { 150: directCliBin, 154: directCliBin },
      runningInos: { 150: 'cli-inode-a', 154: 'cli-inode-b' },
      cmdlines: { 150: ['/opt/wrapper/launcher', 'claude'], 154: [directCliBin] }, children,
      childComms: { 150: 'claude', 154: 'claude' },
    });
    // The old direct image remains the trusted root after the install path
    // changes. A later subagent running the replacement must not inherit it.
    children[150] = [154];
    result.refreshSandboxedCliLeafAttestation!();
    expect(result.elapsedMs).toBeLessThan(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS);
    expect(publicationPids(result)).not.toContain(154);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps an old direct CLI root on persistent reattach after an upgrade (late PID=%s)', late => {
    const children: Record<number, number[]> = {};
    const directCliBin = '/opt/claude/claude.exe';
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin, reattached: true,
      installInos: { [directCliBin]: 'cli-inode-b' },
      runningExes: { 150: directCliBin, 154: directCliBin },
      runningInos: { 150: 'cli-inode-a', 154: 'cli-inode-b' },
      cmdlines: { 150: ['/opt/wrapper/launcher', 'claude'], 154: [directCliBin] }, children,
      childComms: { 150: 'claude', 154: 'claude' },
    });
    children[150] = [154];
    result.refreshSandboxedCliLeafAttestation!();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS);
    expect(publicationPids(result)).not.toContain(154);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps the direct root when wrapper and CLI resolve to the same executable (late PID=%s)', late => {
    const children: Record<number, number[]> = {};
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'claude', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin: '/opt/claude/claude',
      wrapperLaunch: { bin: '/opt/claude/claude', args: [] }, runningExes: { 150: '/opt/claude/claude' },
      cmdlines: { 150: ['/opt/claude/claude'] }, children,
      childComms: { 150: 'claude', 154: 'claude' },
    });
    children[150] = [154];
    result.refreshSandboxedCliLeafAttestation!();
    expect(publicationPids(result)).not.toContain(154);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not descend when a nested wrapper and CLI share one executable identity (late PID=%s)', late => {
    const directCliBin = '/opt/claude/claude';
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'claude', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin,
      wrapperLaunch: { bin: directCliBin, args: ['claude'] },
      runningExes: { 151: directCliBin, 152: directCliBin },
      cmdlines: { 151: [directCliBin, 'claude'], 152: [directCliBin] },
      children: { 150: [151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
    });
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(publicationPids(result)).not.toContain(151);
    expect(publicationPids(result)).not.toContain(152);
  });

  it.each([false, true])('retries an ambiguous payload instead of assuming direct when wrapper identity is unreadable (late PID=%s)', late => {
    const wrapperLaunch = { bin: '/opt/wrapper/launcher', args: ['claude'] };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, wrapperLaunch, missingPaths: [wrapperLaunch.bin],
      runningExes: { 150: wrapperLaunch.bin, 154: '/opt/claude/claude' },
      cmdlines: { 150: [wrapperLaunch.bin, ...wrapperLaunch.args], 154: ['/opt/claude/claude'] },
      children: { 150: [154] }, childComms: { 150: 'claude', 154: 'claude' },
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS);
    expect(result.backend.cliPid).toBe(150);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
    expect(publicationPids(result)).not.toContain(154);
  });

  it.each([false, true])('does not use a versioned shared interpreter as wrapper evidence (late PID=%s)', late => {
    const children: Record<number, number[]> = {};
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'node-v22', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin: '/opt/claude/claude.js',
      wrapperLaunch: { bin: '/opt/node-v22', args: ['/opt/wrapper/launcher.js'] },
      runningExes: { 150: '/opt/node-v22' }, cmdlines: { 150: ['/opt/node-v22', '/opt/claude/claude.js'] }, children,
      childComms: { 150: 'claude', 154: 'claude' },
    });
    children[150] = [154];
    result.refreshSandboxedCliLeafAttestation!();
    expect(publicationPids(result)).not.toContain(154);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([false, true])('passes through a same-comm native wrapper below the bwrap payload (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150,
      runningExes: { 151: '/opt/wrapper/launcher' },
      cmdlines: { 151: ['/opt/wrapper/launcher', 'claude'], 152: ['/opt/claude/claude'] },
      children: { 150: [151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
    });
    expect(result.backend.cliPid).toBe(152);
    expect(result.bridgeCliPid).toBe(152);
    expect(publicationPids(result)).not.toContain(151);
    const leafPublications = () => result.publishLocalProcessAttestation.mock.calls
      .filter((call: unknown[]) => call[0] === 152);
    expect(leafPublications()).toHaveLength(1);
    result.refreshSandboxedCliLeafAttestation!();
    result.refreshSandboxedCliLeafAttestation!();
    expect(leafPublications()).toHaveLength(1);
  });

  it.each([false, true])('passes through a versioned-interpreter wrapper below bwrap by its script (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'node-v22', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin: '/opt/claude/claude.js',
      wrapperLaunch: { bin: '/opt/node-v22', args: ['/opt/wrapper/launcher.js'] },
      runningExes: { 151: '/opt/node-v22', 152: '/opt/node-v22' },
      cmdlines: { 151: ['/opt/node-v22', '/opt/wrapper/launcher.js'], 152: ['/opt/node-v22', '/opt/claude/claude.js'] },
      children: { 150: [151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
    });
    expect(result.backend.cliPid).toBe(152);
    expect(result.bridgeCliPid).toBe(152);
    expect(publicationPids(result)).not.toContain(151);
    expect(publicationPids(result)).toContain(152);
  });

  it.each([false, true])('passes through a versioned Python wrapper to a direct CLI on the same interpreter (late PID=%s)', late => {
    const wrapperLaunch = { bin: '/usr/bin/python3.12', args: ['/opt/wrapper/launcher.py', 'claude'] };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'python3.12', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, wrapperLaunch, directCliBin: '/opt/claude/claude.py',
      runningExes: { 151: wrapperLaunch.bin, 152: wrapperLaunch.bin },
      cmdlines: {
        151: [wrapperLaunch.bin, ...wrapperLaunch.args],
        152: [wrapperLaunch.bin, '/opt/claude/claude.py'],
      },
      children: { 150: [151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
    });
    expect(result.backend.cliPid).toBe(152);
    expect(result.bridgeCliPid).toBe(152);
    expect(publicationPids(result)).not.toContain(151);
    expect(publicationPids(result)).toContain(152);
  });

  it.each([false, true])('does not trust direct CLI argv0 when a nested candidate runs a different native image (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150,
      runningExes: { 151: '/opt/other/native', 152: '/opt/claude/claude' },
      cmdlines: { 151: ['/opt/claude/claude'], 152: ['/opt/claude/claude'] },
      children: { 150: [151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
    });
    expect(result.backend.cliPid).toBe(150);
    expect(publicationPids(result)).not.toContain(151);
    expect(publicationPids(result)).not.toContain(152);
  });

  it.each([false, true])('does not trust configured wrapper argv0 when a nested candidate runs a different native image (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150,
      runningExes: { 151: '/opt/other/native', 152: '/opt/claude/claude' },
      cmdlines: { 151: ['/opt/wrapper/launcher', 'claude'], 152: ['/opt/claude/claude'] },
      children: { 150: [151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
    });
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(publicationPids(result)).not.toContain(151);
    expect(publicationPids(result)).not.toContain(152);
  });

  it.each([
    { late: false, wrapperFirst: true }, { late: true, wrapperFirst: true },
    { late: false, wrapperFirst: false }, { late: true, wrapperFirst: false },
  ])('resolves a proven wrapper subtree before a helper sibling (wrapper first=$wrapperFirst, late PID=$late)', ({ late, wrapperFirst }) => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150,
      runningExes: { 151: '/opt/wrapper/launcher', 152: '/opt/claude/claude', 155: '/opt/claude/claude' },
      cmdlines: {
        151: ['/opt/wrapper/launcher', 'claude'], 152: ['/opt/claude/claude'], 155: ['/opt/claude/claude', 'doctor'],
      },
      children: { 150: wrapperFirst ? [151, 155] : [155, 151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude', 155: 'claude' },
    });
    expect(result.backend.cliPid).toBe(152);
    expect(result.bridgeCliPid).toBe(152);
    expect(publicationPids(result)).not.toContain(155);
  });

  it.each([
    { late: false, wrapperFirst: true }, { late: true, wrapperFirst: true },
    { late: false, wrapperFirst: false }, { late: true, wrapperFirst: false },
  ])('withholds a helper sibling while wrapper evidence is unknown (wrapper first=$wrapperFirst, late PID=$late)', ({ late, wrapperFirst }) => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150,
      runningExes: { 152: '/opt/claude/claude', 155: '/opt/claude/claude' },
      cmdlines: {
        151: [], 152: ['/opt/claude/claude'], 155: ['/opt/claude/claude', 'doctor'],
      },
      children: { 150: wrapperFirst ? [151, 155] : [155, 151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude', 155: 'claude' },
    });
    // The unknown wrapper may hide the interactive CLI. A same-level direct
    // helper must not win merely because wrapper evidence is unavailable.
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(publicationPids(result)).not.toContain(152);
    expect(publicationPids(result)).not.toContain(155);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS);
  });

  it.each([
    { late: false, unknownFirst: true }, { late: true, unknownFirst: true },
    { late: false, unknownFirst: false }, { late: true, unknownFirst: false },
  ])('withholds a proven wrapper result while any sibling is unknown (unknown first=$unknownFirst, late PID=$late)', ({ late, unknownFirst }) => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150,
      runningExes: { 152: '/opt/claude/claude', 156: '/opt/wrapper/launcher', 157: '/opt/claude/claude' },
      cmdlines: {
        151: [], 152: ['/opt/claude/claude'],
        156: ['/opt/wrapper/launcher', 'claude'], 157: ['/opt/claude/claude'],
      },
      children: { 150: unknownFirst ? [151, 156] : [156, 151], 151: [152], 156: [157] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude', 156: 'claude', 157: 'claude' },
    });
    // Unknown anywhere in the search invalidates every direct/nested result,
    // including a proven wrapper returned before or after that sibling.
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    expect(publicationPids(result)).not.toContain(152);
    expect(publicationPids(result)).not.toContain(157);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS);
  });

  it.each([
    { shape: 'birth unreadable at setup', missing: true, late: false },
    { shape: 'birth unreadable at setup', missing: true, late: true },
    { shape: 'payload slot reused before poll', missing: false, late: false },
    { shape: 'payload slot reused before poll', missing: false, late: true },
  ])('stops discovery for a non-CLI payload when birth is missing or changes ($shape, late PID=$late)', ({ missing, late }) => {
    const processStarts: Record<number, string | undefined> = {
      150: missing ? undefined : 'birth-150', 151: 'birth-151', 152: 'birth-152',
    };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, processStarts,
      runningExes: { 151: '/opt/wrapper/launcher' },
      cmdlines: { 151: ['/opt/wrapper/launcher', 'claude'], 152: ['/opt/claude/claude'] },
      children: { 150: [151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
      beforeTimers: missing ? undefined
        : scope => { scope.setTimeout(() => { processStarts[150] = 'reused-birth'; }, late ? 121 : 0); },
    });
    expect(publicationPids(result)).not.toContain(152);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([false, true])('stops retrying a failed leaf publication after the payload birth changes (late PID=%s)', late => {
    const processStarts: Record<number, string | undefined> = {
      150: 'birth-150', 151: 'birth-151', 152: 'birth-152',
    };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, processStarts,
      runningExes: { 151: '/opt/wrapper/launcher' },
      cmdlines: { 151: ['/opt/wrapper/launcher', 'claude'], 152: ['/opt/claude/claude'] },
      children: { 150: [151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
      beforeTimers: scope => {
        let failed = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid: number) => {
          if (pid === 152 && !failed) {
            failed = true;
            processStarts[150] = 'reused-birth';
            return false;
          }
          return true;
        });
      },
    });
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 152)).toHaveLength(1);
    expect(result.findLaunchedCliPid).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('stops discovery when the stable pane changes before the exit generation advances (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150,
      runningExes: { 151: '/opt/wrapper/launcher' },
      cmdlines: { 151: ['/opt/wrapper/launcher', 'claude'], 152: ['/opt/claude/claude'] },
      children: { 150: [151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
      beforeTimers: scope => {
        scope.setTimeout(() => {
          scope.backend.getStablePanePid = () => 300;
          scope.backend.getChildPid = () => 300;
        }, late ? 121 : 199);
      },
    });
    expect(publicationPids(result)).not.toContain(152);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([false, true])('resolves a real CLI child when a credential-only wrapper shares its comm (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, aliasedChildPid: true, directCliBin: '/opt/claude/claude.exe', runningExes: { 150: '/opt/wrapper/launcher', 154: '/opt/claude/claude.exe' },
      cmdlines: { 150: ['claude'], 154: ['/opt/claude/claude.exe'] },
      children: { 150: [154] },
      childComms: { 150: 'claude.exe', 154: 'claude.exe' },
    });
    // A persistent wrapper may set the same process title as the real CLI. The
    // legacy wrapper resolver descended from the launcher; preserve that behavior.
    expect(result.backend.cliPid).toBe(154);
    expect(result.bridgeCliPid).toBe(154);
    const leafPublications = () => result.publishLocalProcessAttestation.mock.calls
      .filter((call: unknown[]) => call[0] === 154);
    expect(leafPublications()).toHaveLength(1);
    expect(result.findLaunchedCliPid).toHaveBeenCalledTimes(1);
    result.refreshSandboxedCliLeafAttestation!();
    result.refreshSandboxedCliLeafAttestation!();
    expect(leafPublications()).toHaveLength(1);
    expect(result.findLaunchedCliPid).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('matches an interpreter-hosted persistent wrapper by its script, not the shared interpreter (late PID=%s)', late => {
    const wrapperLaunch = { bin: '/usr/bin/node', args: ['/opt/wrapper/launcher.js', 'claude'] };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, wrapperLaunch, runningExes: { 150: wrapperLaunch.bin, 154: '/opt/claude/claude' },
      cmdlines: { 150: [wrapperLaunch.bin, ...wrapperLaunch.args], 154: ['/opt/claude/claude'] },
      children: { 150: [154] },
      childComms: { 150: 'claude', 154: 'claude' },
    });
    expect(result.backend.cliPid).toBe(154);
    expect(result.bridgeCliPid).toBe(154);
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 154)).toHaveLength(1);
  });

  it.each([false, true])('keeps resolving a native wrapper after its on-disk identity is replaced (late PID=%s)', late => {
    const wrapperLaunch = { bin: '/opt/wrapper/launcher', args: ['claude'] };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, wrapperLaunch,
      spawnInstallInos: { [wrapperLaunch.bin]: 'wrapper-inode-a' },
      installInos: { [wrapperLaunch.bin]: 'wrapper-inode-b' }, runningInos: { 151: 'wrapper-inode-a' },
      runningExes: { 151: wrapperLaunch.bin, 152: '/opt/claude/claude' },
      cmdlines: { 151: [wrapperLaunch.bin, ...wrapperLaunch.args], 152: ['/opt/claude/claude'] },
      children: { 150: [151], 151: [152] }, childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
    });
    expect(result.backend.cliPid).toBe(152);
    expect(lastPublishedPid(result)).toBe(152);
  });

  it.each([false, true])('recovers a versioned Node wrapper after its title-obscured script becomes readable (late PID=%s)', late => {
    const wrapperLaunch = { bin: '/usr/bin/node-v22', args: ['/opt/wrapper/launcher.js', 'claude'] };
    const cmdlines: Record<number, string[]> = { 151: ['claude'], 152: ['/opt/claude/claude'] };
    let leafPublicationsAt400: unknown[] = [];
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'node-v22', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, wrapperLaunch, directCliBin: '/opt/claude/claude.js',
      runningExes: { 151: wrapperLaunch.bin, 152: '/opt/claude/claude.js' }, cmdlines,
      children: { 150: [151], 151: [152] }, childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
      beforeTimers: scope => {
        scope.setTimeout(() => {
          leafPublicationsAt400 = scope.publishLocalProcessAttestation.mock.calls.filter(call => call[0] === 152);
        }, 400);
        scope.setTimeout(() => { cmdlines[151] = [wrapperLaunch.bin, ...wrapperLaunch.args]; }, 500);
      },
    });
    expect(leafPublicationsAt400).toEqual([]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
    expect(result.backend.cliPid).toBe(152);
    expect(lastPublishedPid(result)).toBe(152);
  });

  it.each([false, true])('recovers a nested native wrapper after its identity becomes readable (late PID=%s)', late => {
    const wrapperLaunch = { bin: '/opt/wrapper/launcher', args: ['claude'] };
    const cmdlines: Record<number, string[]> = { 151: [], 152: ['/opt/claude/claude'] };
    const runningExes: Record<number, string | undefined> = { 152: '/opt/claude/claude' };
    let leafPublicationsAt400: unknown[] = [];
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, wrapperLaunch, runningExes, cmdlines,
      children: { 150: [151], 151: [152] }, childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
      beforeTimers: scope => {
        scope.setTimeout(() => {
          leafPublicationsAt400 = scope.publishLocalProcessAttestation.mock.calls.filter(call => call[0] === 152);
          runningExes[151] = wrapperLaunch.bin;
          cmdlines[151] = [wrapperLaunch.bin, ...wrapperLaunch.args];
        }, 400);
      },
    });
    expect(leafPublicationsAt400).toEqual([]);
    expect(result.backend.cliPid).toBe(152);
    expect(lastPublishedPid(result)).toBe(152);
  });

  it.each([false, true])('recovers a payload Node wrapper after its title-obscured script becomes readable (late PID=%s)', late => {
    const wrapperLaunch = { bin: '/usr/bin/node-v22', args: ['/opt/wrapper/launcher.js', 'claude'] };
    const cmdlines: Record<number, string[]> = { 150: ['claude'], 154: ['/opt/claude/claude.js'] };
    const runningExes: Record<number, string | undefined> = { 154: '/opt/claude/claude.js' };
    let leafPublicationsAt400: unknown[] = [];
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'node-v22', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, wrapperLaunch, directCliBin: '/opt/claude/claude.js',
      runningExes, cmdlines,
      children: { 150: [154] }, childComms: { 150: 'claude', 154: 'claude' },
      beforeTimers: scope => {
        scope.setTimeout(() => {
          leafPublicationsAt400 = scope.publishLocalProcessAttestation.mock.calls.filter(call => call[0] === 154);
          cmdlines[150] = [wrapperLaunch.bin, ...wrapperLaunch.args];
          runningExes[150] = wrapperLaunch.bin;
        }, 400);
      },
    });
    expect(leafPublicationsAt400).toEqual([]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(400);
    expect(result.backend.cliPid).toBe(154);
    expect(lastPublishedPid(result)).toBe(154);
  });

  it.each([false, true])('recovers a payload Node wrapper after its executable becomes readable (late PID=%s)', late => {
    const wrapperLaunch = { bin: '/usr/bin/node', args: ['/opt/wrapper/launcher.js', 'claude'] };
    const runningExes: Record<number, string | undefined> = { 154: '/opt/claude/claude' };
    const cmdlines: Record<number, string[]> = { 150: [wrapperLaunch.bin, ...wrapperLaunch.args], 154: ['/opt/claude/claude'] };
    let leafPublicationsAt400: unknown[] = [];
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, wrapperLaunch, runningExes, cmdlines,
      children: { 150: [154] }, childComms: { 150: 'claude', 154: 'claude' },
      beforeTimers: scope => {
        scope.setTimeout(() => {
          leafPublicationsAt400 = scope.publishLocalProcessAttestation.mock.calls.filter(call => call[0] === 154);
          runningExes[150] = wrapperLaunch.bin;
        }, 400);
      },
    });
    expect(leafPublicationsAt400).toEqual([]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(400);
    expect(result.backend.cliPid).toBe(154);
    expect(lastPublishedPid(result)).toBe(154);
  });

  it.each([false, true])('keeps native wrapper identity when a versioned name has no resolvable script (late PID=%s)', late => {
    const wrapperLaunch = { bin: '/opt/wrapper/node-v22', args: ['claude'] };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'node-v22', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, wrapperLaunch, missingPaths: ['/work/claude'],
      runningExes: { 151: wrapperLaunch.bin, 152: '/opt/claude/claude' },
      cmdlines: { 151: [wrapperLaunch.bin, ...wrapperLaunch.args], 152: ['/opt/claude/claude'] },
      children: { 150: [151], 151: [152] }, childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
    });
    expect(result.backend.cliPid).toBe(152);
    expect(lastPublishedPid(result)).toBe(152);
  });

  it.each([false, true])('distinguishes a direct script CLI from a versioned interpreter whose wrapper script is unreadable (late PID=%s)', late => {
    const node = '/opt/node-v22';
    const wrapperScript = '/opt/wrapper/launcher.js';
    const directScript = '/opt/claude/claude.js';
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'node-v22', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin: directScript,
      wrapperLaunch: { bin: node, args: [wrapperScript] }, missingPaths: [wrapperScript],
      runningExes: { 151: node, 152: node },
      cmdlines: { 151: [node, wrapperScript], 152: [node, directScript] },
      children: { 150: [151], 151: [152] },
      childComms: { 150: 'bwrap', 151: 'claude', 152: 'claude' },
    });
    // The shared interpreter image must not hide the independently proven
    // direct script behind a persistent-wrapper recursion.
    expect(result.backend.cliPid).toBe(152);
    expect(result.bridgeCliPid).toBe(152);
    expect(lastPublishedPid(result)).toBe(152);
  });

  it.each([
    { late: false, severLineage: false }, { late: true, severLineage: false },
    { late: false, severLineage: true }, { late: true, severLineage: true },
  ])('refuses a leaf replaced during the apply snapshot (severLineage=$severLineage, late PID=$late)', ({ late, severLineage }) => {
    const processStarts: Record<number, string | undefined> = { 150: 'birth-150', 151: 'birth-151' };
    const children: Record<number, number[]> = { 150: [151] };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, processStarts, children,
      runningExes: { 151: '/opt/claude/claude' }, cmdlines: { 151: ['/opt/claude/claude'] },
      childComms: { 150: 'bwrap', 151: 'claude' },
      beforeTimers: scope => {
        const originalSnapshot = scope.snapshotChildPids;
        let snapshots = 0;
        let replacements = 0;
        scope.snapshotChildPids = () => {
          snapshots++;
          if (snapshots % 2 === 0) {
            processStarts[151] = `reused-birth-151-${++replacements}`;
            if (severLineage) children[150] = [];
          }
          return originalSnapshot();
        };
      },
    });
    expect(publicationPids(result)).not.toContain(151);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
  });

  it.each([false, true])('anchors a candidate to the birth observed before its comm and role probes (late PID=%s)', late => {
    const processStarts: Record<number, string | undefined> = { 150: 'birth-150', 151: 'birth-151' };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, processStarts, children: { 150: [151] },
      runningExes: { 151: '/opt/claude/claude' }, cmdlines: { 151: ['/opt/claude/claude'] },
      childComms: { 150: 'bwrap', 151: 'claude' },
      beforeTimers: scope => {
        const originalReadComm = scope.readComm;
        let replacements = 0;
        scope.readComm = (pid: number) => {
          const comm = originalReadComm(pid);
          if (pid === 151) processStarts[151] = `reused-birth-151-${++replacements}`;
          return comm;
        };
      },
    });
    expect(publicationPids(result)).not.toContain(151);
    expect(result.backend.cliPid).toBe(150);
  });

  it.each([false, true])('revalidates the leaf executable after the lineage snapshot (late PID=%s)', late => {
    const runningExes: Record<number, string | undefined> = { 151: '/opt/claude/claude' };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, runningExes, children: { 150: [151] },
      cmdlines: { 151: ['/opt/claude/claude'] }, childComms: { 150: 'bwrap', 151: 'claude' },
      beforeTimers: scope => {
        const originalSnapshot = scope.snapshotChildPids;
        let snapshots = 0;
        scope.snapshotChildPids = () => {
          snapshots++;
          if (snapshots === 2) runningExes[151] = '/opt/other/native';
          return originalSnapshot();
        };
      },
    });
    expect(publicationPids(result)).not.toContain(151);
    expect(result.backend.cliPid).toBe(150);
  });

  it.each([false, true])('withholds a descendant after the payload execs direct during discovery (late PID=%s)', late => {
    const directCliBin = '/opt/claude/claude.exe';
    const runningExes: Record<number, string | undefined> = { 150: '/opt/wrapper/launcher', 151: directCliBin };
    const cmdlines: Record<number, string[]> = { 150: ['/opt/wrapper/launcher', 'claude'], 151: [directCliBin] };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin, runningExes, cmdlines,
      children: { 150: [151] }, childComms: { 150: 'claude', 151: 'claude' },
      beforeTimers: scope => {
        const originalSnapshot = scope.snapshotChildPids;
        let snapshots = 0;
        scope.snapshotChildPids = () => {
          const snapshot = originalSnapshot();
          snapshots++;
          if (snapshots === 1) {
            // exec preserves the payload birth. The final apply fence must
            // reclassify the root instead of accepting its former descendant.
            runningExes[150] = directCliBin;
            cmdlines[150] = [directCliBin];
          }
          return snapshot;
        };
      },
    });
    expect(publicationPids(result)).not.toContain(151);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
  });

  it.each([
    { late: false, failRestore: false }, { late: true, failRestore: false },
    { late: false, failRestore: true }, { late: true, failRestore: true },
  ])('restores the payload after it execs direct inside leaf publication (fail first restore=$failRestore, late PID=$late)', ({ late, failRestore }) => {
    const directCliBin = '/opt/claude/claude.exe';
    const runningExes: Record<number, string | undefined> = { 150: '/opt/wrapper/launcher', 151: directCliBin };
    const cmdlines: Record<number, string[]> = { 150: ['/opt/wrapper/launcher', 'claude'], 151: [directCliBin] };
    let immediateOwnership: { cliPid: number; bridgeCliPid: unknown } | undefined;
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin, runningExes, cmdlines,
      children: { 150: [151] }, childComms: { 150: 'claude', 151: 'claude' },
      beforeTimers: scope => {
        const originalPublish = scope.publishLocalProcessAttestation.getMockImplementation()!;
        let restoreFailed = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid?: number, enginePid?: number, expectedProcStart?: string) => {
          if (pid === 151 && expectedProcStart) {
            runningExes[150] = directCliBin;
            cmdlines[150] = [directCliBin];
          }
          if (failRestore && pid === 150 && !restoreFailed && publicationPids(scope).includes(151)) {
            restoreFailed = true;
            return false;
          }
          const published = originalPublish(pid, enginePid, expectedProcStart);
          if (pid === 151 && expectedProcStart) {
            scope.setTimeout(() => {
              immediateOwnership = { cliPid: scope.backend.cliPid, bridgeCliPid: scope.bridgeCliPid };
            }, 0);
          }
          return published;
        });
      },
    });
    expect(immediateOwnership).toEqual({ cliPid: 150, bridgeCliPid: 150 });
    const publications = publicationPids(result);
    const firstLeaf = publications.indexOf(151);
    expect(firstLeaf).toBeGreaterThanOrEqual(0);
    expect(publications.slice(firstLeaf + 1).filter(pid => pid === 150)).toHaveLength(failRestore ? 2 : 1);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
  });

  it.each([
    { late: false, failRestore: false }, { late: true, failRestore: false },
    { late: false, failRestore: true }, { late: true, failRestore: true },
  ])('restores the direct payload after a later exec and old leaf exit (fail first restore=$failRestore, late PID=$late)', ({ late, failRestore }) => {
    const directCliBin = '/opt/claude/claude.exe';
    const runningExes: Record<number, string | undefined> = { 150: '/opt/wrapper/launcher', 151: directCliBin };
    const cmdlines: Record<number, string[]> = { 150: ['/opt/wrapper/launcher', 'claude'], 151: [directCliBin] };
    const exited: number[] = [];
    let publicationsBeforeExec: unknown[] = [];
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin, runningExes, cmdlines, exited,
      children: { 150: [151] }, childComms: { 150: 'claude', 151: 'claude' },
      beforeTimers: scope => {
        const originalPublish = scope.publishLocalProcessAttestation.getMockImplementation()!;
        let restoreFailed = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid?: number, enginePid?: number, expectedProcStart?: string) => {
          if (failRestore && pid === 150 && !restoreFailed && publicationsBeforeExec.length > 0) {
            restoreFailed = true;
            return false;
          }
          return originalPublish(pid, enginePid, expectedProcStart);
        });
        scope.setTimeout(() => {
          publicationsBeforeExec = [...publicationPids(scope)];
          runningExes[150] = directCliBin;
          cmdlines[150] = [directCliBin];
          exited.push(151);
        }, 400);
      },
    });
    expect(publicationsBeforeExec).toContain(151);
    const publications = publicationPids(result);
    const firstLeaf = publications.indexOf(151);
    expect(publications.slice(firstLeaf + 1).filter(pid => pid === 150)).toHaveLength(failRestore ? 2 : 1);
    expect(lastPublishedPid(result)).toBe(150);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
    const settled = publicationPids(result);
    result.refreshSandboxedCliLeafAttestation!();
    expect(publicationPids(result)).toEqual(settled);
  });

  it.each([false, true])('does not substitute a replacement birth inside leaf publication (late PID=%s)', late => {
    const processStarts: Record<number, string | undefined> = { 150: 'birth-150', 151: 'birth-151' };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, processStarts, children: { 150: [151] },
      runningExes: { 151: '/opt/claude/claude' }, cmdlines: { 151: ['/opt/claude/claude'] },
      childComms: { 150: 'bwrap', 151: 'claude' },
      beforeTimers: scope => {
        const originalPublish = scope.publishLocalProcessAttestation.getMockImplementation()!;
        let replacements = 0;
        scope.publishLocalProcessAttestation.mockImplementation((pid?: number, enginePid?: number, expectedProcStart?: string) => {
          if (pid === 151 && expectedProcStart) processStarts[151] = `reused-birth-151-${++replacements}`;
          return originalPublish(pid, enginePid, expectedProcStart);
        });
      },
    });
    const leafResults = result.publishLocalProcessAttestation.mock.calls
      .map((call: unknown[], index: number) => ({ pid: call[0], result: result.publishLocalProcessAttestation.mock.results[index] }))
      .filter((entry: { pid: unknown }) => entry.pid === 151);
    expect(leafResults.length).toBeGreaterThan(0);
    expect(leafResults.every((entry: { result: { value: unknown } }) => entry.result.value === false)).toBe(true);
    expect(result.backend.cliPid).toBe(150);
    expect(result.bridgeCliPid).toBe(150);
  });

  it('re-attests the sandboxed Claude Code leaf on ready/input after a failed publication or a startup helper exits', () => {
    // 153 is a startup helper (`claude --version`) the launch poll attests; it
    // exits and the interactive TUI 154 replaces it before an input edge.
    const children: Record<number, number[]> = { 150: [151], 151: [152], 152: [153] };
    const exited: number[] = [];
    const result = runWorkerWiring(false, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', sandboxRequested: true, realCodexSearch: true,
      scopePayloadPid: 150, children, exited,
      childComms: { 150: 'sh', 151: 'bwrap', 152: 'bwrap', 153: 'claude.exe', 154: 'claude.exe' },
      beforeTimers: scope => {
        let failedLeaf = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid: number) => {
          if (pid === 153 && !failedLeaf) { failedLeaf = true; return false; }
          return true;
        });
      },
    });
    const leafAttestations = () => result.publishLocalProcessAttestation.mock.calls
      .map((call: unknown[]) => call[0]).filter((pid: unknown) => pid !== 150);
    expect(leafAttestations()).toEqual([153, 153]);
    result.refreshSandboxedCliLeafAttestation!();
    expect(leafAttestations()).toEqual([153, 153]);
    exited.push(153);
    children[152] = [154];
    result.refreshSandboxedCliLeafAttestation!();
    result.refreshSandboxedCliLeafAttestation!();
    expect(leafAttestations()).toEqual([153, 153, 154]);
  });

  it.each([false, true])('re-attests the interactive Claude leaf after a short-lived matching helper disappears (late PID=%s)', late => {
    const children: Record<number, number[]> = { 150: [151], 151: [152], 152: [153] };
    const processStarts: Record<number, string | undefined> = { 153: 'helper-birth', 154: 'tui-birth' };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', sandboxRequested: true, realCodexSearch: true,
      scopePayloadPid: 150, children, processStarts,
      childComms: { 150: 'sh', 151: 'bwrap', 152: 'bwrap', 153: 'claude.exe', 154: 'claude.exe' },
      beforeTimers: scope => {
        let helperRetired = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid: number) => {
          if (pid === 153 && !helperRetired) {
            helperRetired = true;
            delete processStarts[153];
            children[152] = [154];
          }
          return true;
        });
      },
    });
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 153)).toHaveLength(1);
    expect(lastPublishedPid(result)).toBe(154);
    expect(result.snapshotChildPids).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('re-attests the interactive Claude leaf after a matching helper becomes a zombie (late PID=%s)', late => {
    const children: Record<number, number[]> = { 150: [151], 151: [152], 152: [153] };
    const zombies: Record<number, boolean> = {};
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', sandboxRequested: true, realCodexSearch: true,
      scopePayloadPid: 150, children, zombies,
      childComms: { 150: 'sh', 151: 'bwrap', 152: 'bwrap', 153: 'claude.exe', 154: 'claude.exe' },
      beforeTimers: scope => {
        let helperRetired = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid: number) => {
          if (pid === 153 && !helperRetired) {
            helperRetired = true;
            zombies[153] = true;
            // A zombie stays in the process table until reaped. The live TUI
            // appears beside it and must not be hidden by the first comm match.
            children[152] = [153, 154];
          }
          return true;
        });
      },
    });
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 153)).toHaveLength(1);
    expect(lastPublishedPid(result)).toBe(154);
  });

  it.each([false, true])('skips a Claude metadata probe and finds its live interactive sibling (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', sandboxRequested: true, realCodexSearch: true,
      scopePayloadPid: 150,
      children: { 150: [151], 151: [152], 152: [153, 154] },
      childComms: { 150: 'sh', 151: 'bwrap', 152: 'bwrap', 153: 'claude.exe', 154: 'claude.exe' },
      cmdlines: { 153: ['claude.exe', '--version'] },
    });
    expect(publicationPids(result)).not.toContain(153);
    expect(lastPublishedPid(result)).toBe(154);
  });

  it.each([false, true])('retries sandbox leaf publication after capability publication fails (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: '', claudeDataDir: '/claude', sandboxRequested: true, realCodexSearch: true,
      scopePayloadPid: 150,
      children: { 150: [151], 151: [152], 152: [153] },
      childComms: { 150: 'sh', 151: 'bwrap', 152: 'bwrap', 153: 'claude.exe' },
      beforeTimers: scope => {
        let failedLeaf = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid: number) => {
          if (pid === 153 && !failedLeaf) { failedLeaf = true; return false; }
          return true;
        });
      },
    });
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 153)).toHaveLength(2);
  });

  it.each([false, true])('uses one monitored resolver for credential-only bwrap plus wrapperCli (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', credentialOnlyBwrap: true, realCodexSearch: true,
      scopePayloadPid: 150, directCliBin: '/opt/claude/claude.exe',
      children: { 150: [151], 151: [152], 152: [153] },
      childComms: { 150: 'sh', 151: 'bwrap', 152: 'bwrap', 153: 'claude.exe' },
      runningExes: { 153: '/opt/claude/claude.exe' }, cmdlines: { 153: ['/opt/claude/claude.exe'] },
    });
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 153)).toHaveLength(1);
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(150, 'claude-code', CODEX_LEAF_SEARCH_DEPTH, expect.objectContaining({ childrenOf: expect.any(Function) }));
    // Credential-only bwrap historically let wrapper resolution rewire these;
    // consolidating resolvers must not strand them on the sandbox payload.
    expect(result.backend.cliPid).toBe(153);
    expect(result.bridgeCliPid).toBe(153);
  });

  it.each([false, true])('retries generic wrapper publication after an aliased backend rewires its child PID (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', aliasedChildPid: true,
      beforeTimers: scope => {
        let failedLeaf = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid: number) => {
          if (pid === 200 && !failedLeaf) { failedLeaf = true; return false; }
          return true;
        });
      },
    });
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 200)).toHaveLength(2);
  });

  it.each([false, true])('bounds Herdr wrapper retries by wall clock including synchronous pane probes (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude',
      backendType: 'herdr', aliasedChildPid: true,
      stablePaneProbeMs: 5_000, launchedCliPid: null,
    });
    // Without the Herdr opt-in, attempt-only retries would perform 30 probes and
    // advance this fake clock by roughly 156s. Allow either side of the first
    // discovery boundary so the production budget can be tuned without pinning
    // an exact attempt count, while still rejecting the attempt-only 156s loop.
    expect(result.findLaunchedCliPid.mock.calls.length).toBeGreaterThan(0);
    expect(result.findLaunchedCliPid.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.elapsedMs).toBeLessThan(20_000);
    expect(result.publishLocalProcessAttestation).not.toHaveBeenCalledWith(200);
  });

  it('bounds Herdr late-PID probing by wall clock while a non-Herdr backend stays attempt-only', () => {
    const run = (backendType: string) => runWorkerWiring(true, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', backendType,
      childPidProbeMs: 5_000, childPidResult: null, launchedCliPid: null,
    });
    const herdr = run('herdr');
    expect(herdr.elapsedMs).toBeLessThan(20_000);
    expect(herdr.findLaunchedCliPid).not.toHaveBeenCalled();
    expect(herdr.publishLocalProcessAttestation).not.toHaveBeenCalledWith(200);

    const tmux = run('tmux');
    expect(tmux.elapsedMs).toBeGreaterThan(100_000);
    expect(tmux.elapsedMs).toBeGreaterThan(herdr.elapsedMs);
    expect(tmux.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it('does not call getChildPid when the first Herdr late-PID tick starts after its budget', () => {
    let probes = 0;
    const result = runWorkerWiring(true, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', backendType: 'herdr',
      launchedCliPid: null,
      beforeTimers: scope => {
        scope.advanceTime(7_000);
        scope.backend.getChildPid = () => { probes++; return null; };
      },
    });
    expect(probes).toBe(0);
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
    expect(result.publishLocalProcessAttestation).not.toHaveBeenCalled();
  });

  it('does not publish a Herdr late PID whose synchronous probe returns after the budget', () => {
    const delayedStartMs = 5_500;
    const probeMs = 5_000;
    const result = runWorkerWiring(true, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', backendType: 'herdr',
      childPidProbeMs: probeMs, childPidResult: 100,
      beforeTimers: scope => { scope.advanceTime(delayedStartMs); },
    });
    expect(result.elapsedMs).toBe(delayedStartMs + probeMs);
    expect(result.publishLocalProcessAttestation).not.toHaveBeenCalled();
    expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
  });

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])('stops wrapper retries when the stable pane changes after a failed publication (accessor=%s, late PID=%s)', (useStableAccessor, late) => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude',
      stablePaneAccessor: useStableAccessor,
      beforeTimers: scope => {
        let failedLeaf = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid: number) => {
          if (pid === 200 && !failedLeaf) {
            failedLeaf = true;
            if (useStableAccessor) scope.backend.getStablePanePid = () => 300;
            else scope.backend.getChildPid = () => 300;
            return false;
          }
          return true;
        });
      },
    });
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 200)).toHaveLength(1);
  });

  it.each([false, true])('recovers wrapper retries when the initial stable-pane probe is temporarily unavailable (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude', stablePanePid: null,
      beforeTimers: scope => {
        scope.backend.getStablePanePid = () => 100;
        let failedLeaf = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid: number) => {
          if (pid === 200 && !failedLeaf) { failedLeaf = true; return false; }
          return true;
        });
      },
    });
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 200)).toHaveLength(2);
  });

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])('keeps ZMX wrapper discovery alive across an initial list-probe failure (fail first=%s, late PID=%s)', (failFirst, late) => {
    const zmxStablePane = { probeOk: false, rootPid: 10 as number | null, backingPid: 10 };
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude',
      aliasedChildPid: true, zmxStablePane,
      beforeTimers: scope => {
        let failedLeaf = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid: number) => {
          if (failFirst && pid === 200 && !failedLeaf) { failedLeaf = true; return false; }
          return true;
        });
      },
    });
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 200))
      .toHaveLength(failFirst ? 2 : 1);
  });

  it.each([false, true])('keeps aliased wrapper retries alive when the stable pane differs from the launcher (late PID=%s)', late => {
    const result = runWorkerWiring(late, {
      cliId: 'claude-code', wrapperCli: 'launcher', claudeDataDir: '/claude',
      aliasedChildPid: true, stablePanePid: 10,
      beforeTimers: scope => {
        let failedLeaf = false;
        scope.publishLocalProcessAttestation.mockImplementation((pid: number) => {
          if (pid === 200 && !failedLeaf) { failedLeaf = true; return false; }
          return true;
        });
      },
    });
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(result.publishLocalProcessAttestation.mock.calls.filter((call: unknown[]) => call[0] === 200)).toHaveLength(2);
  });

  it.each([false, true])('attests the native Codex child behind the standard npm launcher (late PID=%s)', late => {
    const result = runWorkerWiring(late, { wrapperCli: '' });
    // The gate must be ACTIVE for managed Codex even without a sandbox
    // (regression guard: passing outerBwrapActive here silently reverts the fix).
    expect(result.resolveCodexOwnershipPid).toHaveBeenCalledWith(100, true, undefined);
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(100, 'codex', CODEX_LEAF_SEARCH_DEPTH, expect.any(Object), undefined);
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
  });

  it('publishes a synchronously bound native root even when ready beats the first retry tick', () => {
    runWorkerWiring(false, {
      wrapperCli: '',
      beforeTimers: scope => {
        expect(scope.backend.cliPid).toBe(200);
        expect(scope.publishLocalProcessAttestation).not.toHaveBeenCalled();
        // Model the already-bound native leaf; execute the real fast path.
        scope.codexProcessIsNativeLeaf = (pid: number) => pid === 200;
        const current = loadWorkerFunction<() => number>('currentCodexObservedPid', scope);
        expect(current()).toBe(200);
        expect(scope.publishLocalProcessAttestation).toHaveBeenCalledWith(200);
        expect(scope.codexOwnershipAttestationPending).toBe(false);
      },
    });
  });

  it('retries publication after the timer finds a native root but capability publication fails', () => {
    const result = runWorkerWiring(false, {
      wrapperCli: '', launchedCliAfterMs: 12_000,
      beforeTimers: scope => {
        scope.isZombieProcess = () => false;
        const current = loadWorkerFunction<() => number>('currentCodexObservedPid', scope);
        expect(current()).toBe(100);
        expect(scope.codexOwnershipAttestationPending).toBe(false);
        // The wrapper was already published successfully. Only the later
        // timer's native-root publication fails; initial pending cannot mask it.
        scope.publishLocalProcessAttestation.mockReturnValueOnce(false);
      },
    });
    expect(result.backend.cliPid).toBe(200);
    expect(result.codexOwnershipAttestationPending).toBe(true);
    const scope = { ...result, codexProcessIsNativeLeaf: (pid: number) => pid === 200 };
    expect(loadWorkerFunction<() => number>('currentCodexObservedPid', scope)()).toBe(200);
    expect(scope.codexOwnershipAttestationPending).toBe(false);
    expect(result.publishLocalProcessAttestation.mock.calls).toEqual([[100], [200], [200]]);
  });

  it.each([false, true])('attests a slow wrapper child before any rollout exists (late PID=%s)', late => {
    const result = runWorkerWiring(late, { launchedCliAfterMs: 12_000 });
    expect(result.backend.cliPid).toBe(200);
    expect(result.bridgeCliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
    expect(result.codexOwnershipAttestationPending).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(12_000);
    expect(result.elapsedMs).toBeLessThan(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS);
  });

  it.each([false, true])('keeps the Codex retry loop alive when getChildPid aliases the mutable cliPid (Herdr/ZMX) (late PID=%s)', late => {
    // Herdr/ZMX report the rewired ownership pid from getChildPid(). The
    // synchronous resolve already moves cliPid from the launcher (100) to the
    // discovered leaf (200), so asking backend.getChildPid() on the first retry
    // tick returns 200 — launcherRetryStillValid's same-pid gate would abort the
    // whole loop before the scheduled apply ever runs. The codex resolver must
    // hand the gate the STABLE launcher pid captured at spawn instead.
    const result = runWorkerWiring(late, { wrapperCli: '', aliasedChildPid: true });
    expect(result.log).toHaveBeenCalledWith(
      expect.stringContaining('Codex launcher: resolved real codex leaf pid 200 under launcher 100'),
    );
    // Rooted at the stable launcher twice: the synchronous resolve and the one
    // successful retry tick (never from the aliased 200).
    const rootedCalls = result.findLaunchedCliPid.mock.calls.filter((call: unknown[]) =>
      call.length === 5 && call[0] === 100 && call[1] === 'codex');
    expect(rootedCalls.length).toBe(2);
  });

  it.each([false, true])('forwards the configured custom codex executable to BOTH resolve sites (late PID=%s)', late => {
    // Renamed Codex-compatible runtime: the child never forks, so every
    // descendant probe — the synchronous resolve and the full startup window —
    // must carry the exact configured executable name. No call may fall back
    // to the static 'codex' map.
    const result = runWorkerWiring(late, {
      wrapperCli: '', launchedCliPid: null,
      cliRuntime: { source: 'configured', executable: '/opt/foo/my-codex' },
    });
    expect(result.resolveCodexOwnershipPid).toHaveBeenCalledWith(100, true, '/opt/foo/my-codex');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS);
    expect(result.elapsedMs).toBeLessThan(CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS + 200);
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
    expect(publicationPids(result)).not.toContain(200);
    expect(result.publishLocalProcessAttestation.mock.calls.every(call => call[0] === 100)).toBe(true);
    expect(result.publishLocalProcessAttestation).toHaveBeenCalledTimes(late ? 1 : 0);
  });

  it.each([false, true])('keeps the launcher pid while the native child has not forked yet (late PID=%s)', late => {
    const result = runWorkerWiring(late, { wrapperCli: '', launchedCliPid: null });
    expect(result.findLaunchedCliPid).toHaveBeenCalledWith(100, 'codex', CODEX_LEAF_SEARCH_DEPTH, expect.any(Object), undefined);
    expect(result.backend.cliPid).toBe(100);
    expect(result.bridgeCliPid).toBeUndefined();
    expect(publicationPids(result)).not.toContain(200);
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
    expect(result.bridgeCliPid).toBe(200);
  });

  it.each([
    { cliId: 'claude-code', wrapperCli: '' },
  ])('does not resolve an ineligible wrapper: %j', options => {
    for (const late of [false, true]) {
      const result = runWorkerWiring(late, options);
      expect(result.findLaunchedCliPid).not.toHaveBeenCalled();
      expect(publicationPids(result)).not.toContain(200);
    }
  });

  // Sandbox ignores wrapperCli, so the #1745 wrapper bridge resolver must stay
  // off (bridgeCliPid never rewired). Sandboxed Codex instead has its OWN bwrap
  // resolver also keeps backend.cliPid and bridgeCliPid in step.
  it.each([false, true])('keeps the wrapper bridge resolver off under sandbox while the codex bwrap resolver runs (late=%s)', late => {
    const result = runWorkerWiring(late, { sandboxRequested: true });
    expect(result.bridgeCliPid).toBe(200);
    // The production resolver supplies optional BFS probe/filter arguments;
    // this boundary cares that every probe starts at the launcher and targets
    // Codex, not about the internal optional-argument representation.
    expect(result.findLaunchedCliPid.mock.calls).not.toHaveLength(0);
    expect(result.findLaunchedCliPid.mock.calls.every((args: unknown[]) =>
      args[0] === 100 && args[1] === 'codex',
    )).toBe(true);
    expect(result.backend.cliPid).toBe(200);
    expect(lastPublishedPid(result)).toBe(200);
  });
});

// findLaunchedCliPid sees through a wrapperCli launcher (`aiden x claude`) to the
// real CLI process it forks. The OS-probing is injected so the BFS is tested
// deterministically. Models the real tree: launcher(aiden,node) → claude child.
describe('findLaunchedCliPid()', () => {
  it.each(['--help', '-h', '--version', '-v'])('recognises a bare Claude metadata probe: %s', flag => {
    expect(isClaudeMetadataProbeArgv(['claude.exe', flag])).toBe(true);
    expect(isClaudeMetadataProbeArgv(['claude.exe'])).toBe(false);
    expect(isClaudeMetadataProbeArgv(['claude.exe', '--', flag])).toBe(false);
    expect(isClaudeMetadataProbeArgv(['claude.exe', '--print', flag])).toBe(false);
  });

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

  it('classifies a wrapper once per tick without repeating the legacy direct-leaf probe', () => {
    const sch = makeScheduler();
    const classifyLauncher = vi.fn(() => 'wrapper' as const);
    const isDirectLeaf = vi.fn(() => false);
    const applied: number[] = [];
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => 200, classifyLauncher, isDirectLeaf,
      getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (p) => applied.push(p), schedule: sch.schedule,
    });
    sch.runAll();
    expect(applied).toEqual([200]);
    expect(classifyLauncher).toHaveBeenCalledTimes(1);
    expect(isDirectLeaf).not.toHaveBeenCalled();
  });

  it('retries an unknown launcher without scanning, then resolves after its evidence becomes readable', () => {
    const sch = makeScheduler();
    const roles: Array<'unknown' | 'wrapper'> = ['unknown', 'wrapper'];
    const classifyLauncher = vi.fn(() => roles.shift());
    const findRealPid = vi.fn(() => 200);
    const isDirectLeaf = vi.fn(() => false);
    const applied: number[] = [];
    scheduleWrapperRealCliPid(100, {
      findRealPid, classifyLauncher, isDirectLeaf,
      getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (p) => applied.push(p), schedule: sch.schedule, maxAttempts: 2,
    });
    sch.runAll();
    expect(classifyLauncher).toHaveBeenCalledTimes(2);
    expect(findRealPid).toHaveBeenCalledTimes(1);
    expect(isDirectLeaf).not.toHaveBeenCalled();
    expect(applied).toEqual([200]);
  });

  it('keeps the legacy direct-leaf fallback when classification is unavailable', () => {
    const sch = makeScheduler();
    const findRealPid = vi.fn(() => 200);
    const isDirectLeaf = vi.fn(() => true);
    scheduleWrapperRealCliPid(100, {
      findRealPid, classifyLauncher: () => undefined, isDirectLeaf,
      getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: () => { throw new Error('must not apply'); }, schedule: sch.schedule,
    });
    sch.runAll();
    expect(isDirectLeaf).toHaveBeenCalledTimes(1);
    expect(findRealPid).not.toHaveBeenCalled();
  });

  it('retries a failed apply without requiring liveness monitoring', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    let calls = 0;
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => 200, getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (p) => { applied.push(p); return ++calls > 1; },
      schedule: sch.schedule, maxAttempts: 3,
    });
    sch.runAll();
    expect(applied).toEqual([200, 200]);
  });

  it('reopens discovery when a previously applied pid fails its liveness check', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    let valid = true;
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => (applied.length === 0 ? 200 : 201),
      getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (p) => { applied.push(p); valid = p === 201; return true; },
      isAppliedPidValid: () => valid,
      schedule: sch.schedule, maxAttempts: 3,
    });
    sch.runAll();
    expect(applied).toEqual([200, 201]);
  });

  it('does not probe when a delayed tick starts after the opt-in wall-clock budget', () => {
    const sch = makeScheduler();
    const getChildPid = vi.fn(() => 100);
    const findRealPid = vi.fn(() => 200);
    scheduleWrapperRealCliPid(100, {
      findRealPid, getBackend: () => backendA, getChildPid,
      applyRealPid: () => { throw new Error('must not publish'); },
      schedule: sch.schedule, now: sch.now, maxElapsedMs: 100,
    });
    sch.runAll();
    expect(getChildPid).not.toHaveBeenCalled();
    expect(findRealPid).not.toHaveBeenCalled();
    expect(sch.pending()).toBe(0);
  });

  it('does not publish a discovery that returns after the opt-in wall-clock budget', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => { sch.advance(101); return 200; },
      getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (pid) => { applied.push(pid); },
      schedule: sch.schedule, now: sch.now, intervalMs: 0, maxElapsedMs: 100,
    });
    sch.runAll();
    expect(applied).toEqual([]);
    expect(sch.pending()).toBe(0);
  });

  it('does not queue another timer when an in-flight publication crosses the budget', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => 200,
      getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (pid) => { applied.push(pid); sch.advance(101); return false; },
      schedule: sch.schedule, now: sch.now, intervalMs: 0, maxAttempts: 3, maxElapsedMs: 100,
    });
    sch.runAll(1);
    expect(applied).toEqual([200]);
    expect(sch.pending()).toBe(0);
  });

  it('allows a fast tick exactly at the opt-in deadline', () => {
    const sch = makeScheduler();
    const applied: number[] = [];
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => 200,
      getBackend: () => backendA, getChildPid: () => 100,
      applyRealPid: (pid) => { applied.push(pid); },
      schedule: sch.schedule, now: sch.now, maxElapsedMs: 200,
    });
    sch.runAll();
    expect(applied).toEqual([200]);
    expect(sch.pending()).toBe(0);
  });

  it('keeps attempt-only retries when no wall-clock budget is provided', () => {
    const sch = makeScheduler();
    let discoveries = 0;
    scheduleWrapperRealCliPid(100, {
      findRealPid: () => { discoveries++; return null; },
      getBackend: () => backendA,
      getChildPid: () => { sch.advance(5_000); return 100; },
      applyRealPid: () => { throw new Error('must not publish'); },
      schedule: sch.schedule, now: sch.now, intervalMs: 0, maxAttempts: 2,
    });
    sch.runAll();
    expect(discoveries).toBe(2);
    expect(sch.pending()).toBe(0);
  });
});
