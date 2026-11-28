import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { cliAdapterBindsOwnershipPid } from '../src/adapters/cli/ownership-pid.js';
import { unwrapBotmuxLaunchLayers } from '../src/core/launch-layers.js';
import { isProgramStatusRelayArgv } from '../src/core/program-status-relay-launch.js';
import {
  CODEX_LEAF_SEARCH_DEPTH,
  cliIdForComm,
  createElapsedDeadline,
  findLaunchedCliPid,
  isNonInteractiveCodexArgv,
  scheduleWrapperRealCliPid,
} from '../src/core/session-discovery.js';
import {
  isTraexProcess,
  resolveTraexOwnershipPid,
  scheduleTraexLeafPidResolve,
  type TraexLeafProbes,
} from '../src/core/traex-leaf-pid.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { isObserveBackend } from '../src/adapters/backend/types.js';

const ROOT = 100;
const LEAF = 200;
const WORK_DIR = '/synthetic-traex-adversarial';

// The existing tests' schedule(fn, ms) interface, with one-tick stepping so
// lifecycle changes can be placed BETWEEN callbacks, without real timers.
function makeManualTimers() {
  let now = 0;
  let sequence = 0;
  const queue: Array<{ fn: () => void; at: number; sequence: number }> = [];
  return {
    now: () => now,
    pending: () => queue.length,
    schedule: (fn: () => void, ms = 0) => {
      queue.push({ fn, at: now + ms, sequence: sequence++ });
    },
    runNext: () => {
      queue.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
      const task = queue.shift();
      if (!task) throw new Error('No synthetic callback is queued');
      now = task.at;
      task.fn();
    },
  };
}

type ManualTimers = ReturnType<typeof makeManualTimers>;

function drain(timers: ManualTimers) {
  for (let n = 0; timers.pending() && n < 1_000; n++) {
    // No invented assignment failures and no swallowed production exceptions.
    timers.runNext();
  }
  expect(timers.pending()).toBe(0);
}

function makeBackend(aliasChildPid = false) {
  const backend = {
    cliPid: ROOT,
    cliCwd: WORK_DIR,
    getChildPid: () => aliasChildPid ? backend.cliPid : ROOT,
  };
  return backend;
}

function makeProcessTable(descendantComm = 'traex') {
  const table = {
    visible: false,
    rootComm: 'node',
    childrenOf: vi.fn((pid: number) =>
      table.visible && pid === ROOT ? [LEAF] : []),
    commOf: vi.fn((pid: number): string | undefined =>
      pid === ROOT ? table.rootComm : pid === LEAF ? descendantComm : undefined),
  };
  return table;
}

// As in find-launched-cli-pid.test.ts, evaluate the ACTUAL worker wiring,
// including its synchronous and late-PID kick sites. Importing worker.ts
// itself would start IPC. These delimiters locate code, not assert its content.
const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const wiringStart = workerSource.indexOf('const applyResolvedCliPid =');
const wiringEnd = workerSource.indexOf('// Bridge fallback: claude-code only.', wiringStart);
if (wiringStart < 0 || wiringEnd < wiringStart) {
  throw new Error('Cannot locate the worker launcher-wiring harness boundary');
}
const workerWiring = transpileModule(
  '{\n' + workerSource.slice(wiringStart, wiringEnd)
  + '\nthis.__launcherFunctions = { startTraexLauncherPidResolve };\n}',
  { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } },
).outputText;

function makeWorkerFixture(options: {
  late?: boolean;
  aliasChildPid?: boolean;
  descendantComm?: string;
} = {}) {
  const timers = makeManualTimers();
  const table = makeProcessTable(options.descendantComm);
  const originalBackend = makeBackend(options.aliasChildPid);
  const probes: TraexLeafProbes = {
    childrenOf: table.childrenOf,
    commOf: table.commOf,
  };
  // All configuration and initial publications here are synthetic. The
  // spawn's initial marker/attestation code is outside the sliced wiring.
  const scope: Record<string, any> = {
    cfg: { cliId: 'traex', wrapperCli: '', workingDir: WORK_DIR },
    backend: originalBackend,
    cliPid: options.late ? null : ROOT,
    bridgeCliPid: ROOT,
    cliSpawnGeneration: 1,
    claudeDataDir: undefined,
    sandboxRequested: false,
    credentialOnlyBwrap: false,
    scopePayloadLauncherActive: false,
    programStatusRelayLaunched: false,
    effectiveBackendType: 'tmux',
    actuallyReattachedPersistent: false,
    lastSpawnOuterBwrapActive: false,
    lastSpawnTraexLauncherActive: false,
    lastSpawnCodexLauncherActive: false,
    lastSpawnCodexLauncherPid: undefined,
    lastSpawnCodexExecutable: undefined,
    codexOwnershipAttestationPending: false,
    FIRST_PROMPT_HARD_TIMEOUT_MS: 60_000,
    CODEX_LEAF_SEARCH_DEPTH,
    cliIdForComm,
    isNonInteractiveCodexArgv,
    cliAdapterBindsOwnershipPid,
    scheduleWrapperRealCliPid,
    createElapsedDeadline: (maxElapsedMs: number | undefined) =>
      createElapsedDeadline(maxElapsedMs, timers.now),
    // Inject every process-table boundary; none may inspect the host's PIDs.
    readComm: table.commOf,
    getChildPids: table.childrenOf,
    readCmdline: () => [],
    isZombieProcess: () => false,
    snapshotChildPids: () => table.childrenOf,
    findLaunchedCliPid: (
      pid: number,
      cliId: Parameters<typeof findLaunchedCliPid>[1],
      depth: number,
    ) => findLaunchedCliPid(pid, cliId, depth, {
      ...probes, cmdlineOf: () => [], isZombie: () => false,
    }),
    sessionScopePayloadPid: (pid: number) => pid,
    isProgramStatusRelayArgv,
    resolveTraexOwnershipPid: (pid: number, active: boolean) =>
      resolveTraexOwnershipPid(pid, active, probes),
    scheduleTraexLeafPidResolve: (
      pid: number,
      deps: Parameters<typeof scheduleTraexLeafPidResolve>[1],
    ) => scheduleTraexLeafPidResolve(pid, { ...deps, probes }),
    unwrapBotmuxLaunchLayers: (pid: number, opts: { relay: boolean }) =>
      unwrapBotmuxLaunchLayers(pid, {
        ...opts,
        probes: {
          readCmdline: () => [],
          childrenOf: table.childrenOf,
          commOf: table.commOf,
          isZombie: () => false,
          scopePayloadOf: (candidate: number) => candidate,
        },
      }),
    publishLocalProcessAttestation: vi.fn((_pid: number) => true),
    // The PR's shared-cache lease is attached from the same ownership rewiring
    // this harness slices; the real closure lives outside the sliced boundary.
    attachTraexLeaseCli: vi.fn((_pid: number) => {}),
    observeCursorCliSessionId: vi.fn(),
    observeAntigravityCliSessionId: vi.fn(),
    observeZcodeCliSessionId: vi.fn(),
    process: { env: {} },
    cliPidMarker: undefined,
    setTimeout: timers.schedule,
    log: vi.fn(),
  };
  // Use the existing worker-function harness for the worker's real named leaf
  // functions rather than substitute implementations, even though this fixture
  // selects TRAE and should not enter the Codex branch.
  scope.codexProcessIsNativeLeaf = loadWorkerFunction<(pid: number, filter?: string) => boolean>(
    'codexProcessIsNativeLeaf', scope,
  );
  scope.resolveCodexOwnershipPid = loadWorkerFunction<
    (pid: number, active: boolean, filter?: string) => number
  >('resolveCodexOwnershipPid', scope);
  runInNewContext(workerWiring, scope);
  return {
    timers,
    table,
    scope,
    originalBackend,
    startAnotherTraexResolver: () => {
      scope.__launcherFunctions.startTraexLauncherPidResolve(ROOT);
    },
  };
}

describe('TRAE launcher adversarial lifecycle probes', () => {
  it('public retry ignores a queued callback after the runtime object is replaced, even with the same root PID', () => {
    const timers = makeManualTimers();
    const table = makeProcessTable();
    table.visible = true;
    let current = makeBackend();
    const retired = current;
    const apply = vi.fn();
    scheduleTraexLeafPidResolve(ROOT, {
      getBackend: () => current,
      getChildPid: () => current.getChildPid(),
      applyRealPid: apply,
      schedule: timers.schedule,
      probes: { childrenOf: table.childrenOf, commOf: table.commOf },
    });
    current = makeBackend();
    drain(timers);
    expect(current).not.toBe(retired);
    expect(current.cliPid).toBe(ROOT);
    expect(retired.cliPid).toBe(ROOT);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'worker late-PID callback cannot mutate a replacement runtime (aliased child=%s)',
    aliasChildPid => {
      const fixture = makeWorkerFixture({ late: true, aliasChildPid });
      expect(fixture.timers.pending()).toBeGreaterThan(0);
      const replacement = makeBackend(aliasChildPid);
      fixture.scope.backend = replacement;
      fixture.scope.cliSpawnGeneration++;
      fixture.table.visible = true;

      // Minimal sequence: A queues initial PID discovery -> replace A with B
      // (same reported root, new generation) -> expose A's descendant -> tick.
      // Invariant: a retired spawn must not bind or publish ANY PID for B.
      drain(fixture.timers);
      expect(fixture.scope.backend).toBe(replacement);
      expect(replacement.cliPid).toBe(ROOT);
      expect(replacement.cliCwd).toBe(WORK_DIR);
      expect(fixture.scope.bridgeCliPid).toBe(ROOT);
      expect(fixture.originalBackend.cliPid).toBe(ROOT);
      expect(fixture.scope.publishLocalProcessAttestation).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'worker preserves attestation-before-capability ordering on a real false publication result (aliased child=%s)',
    aliasChildPid => {
      const fixture = makeWorkerFixture({ aliasChildPid });
      const scope = fixture.scope;
      const fault = new Error('synthetic capability-file publication failure');
      const trace: string[] = [];
      const priorCapability = { token: 'synthetic-prior-token', turnId: 'synthetic-turn' };
      Object.assign(scope, {
        codexRpcEngine: undefined,
        codexAppEngineIdentity: undefined,
        codexAppRunnerProcessIdentity: undefined,
        lastInitConfig: { cliId: 'traex' },
        cliAdapter: undefined,
        traexInstallAtSpawn: undefined,
        currentCliCredentialIsolated: false,
        readProcessStartIdentity: vi.fn((pid: number) => `synthetic-birth-${pid}`),
        readRunningExeIdentity: vi.fn(() => undefined),
        isTraexProcess: (pid: number) => isTraexProcess(pid, fixture.table.commOf),
        send: vi.fn((_message: unknown) => { trace.push('attestation'); }),
        currentBotmuxTurnId: 'synthetic-turn',
        currentBotmuxDispatchAttempt: 1,
        currentBotmuxLinkRefMode: undefined,
        activeTurnAuthority: {
          identity: () => ({ turnId: 'synthetic-turn', dispatchAttempt: 1 }),
          speakers: () => [],
        },
        parseDaemonIpcPort: () => undefined,
        randomBytes: () => ({ toString: () => 'synthetic-new-token' }),
        sandboxPolicyCapability: 'synthetic-policy-token',
        sandboxRelayCapability: priorCapability,
        sandboxRelayOutbox: '/synthetic-origin-outbox',
        readIsolationOriginChannelId: undefined,
        RELAY_ORIGIN_CAPABILITY_BASENAME: 'synthetic-capability.json',
        sessionId: 'synthetic-session',
        join,
        // This is the external IO boundary. Both production publication
        // functions below remain real code; no file is created or accessed.
        replaceManagedOriginCapabilityFile: vi.fn(() => {
          trace.push('capability-write-failed');
          throw fault;
        }),
        completeManagedTurnOriginRevocation: vi.fn(() => {
          trace.push('revocation');
        }),
        writeCliPidMarker: vi.fn(),
      });
      scope.publishSandboxRelayCapability = vi.fn(loadWorkerFunction<
        (opts?: { failClosed?: boolean }) => boolean
      >('publishSandboxRelayCapability', scope));
      scope.publishLocalProcessAttestation = vi.fn(loadWorkerFunction<
        (pid?: number, enginePid?: number) => boolean
      >('publishLocalProcessAttestation', scope));
      fixture.table.visible = true;

      // Real contract: PID attestation is sent before capability publication;
      // an IO failure invokes revocation and returns false (not a cwd throw).
      // That boolean is NOT an IPC-attestation failure. Neither this function
      // nor the TRAE callback documents a retry guarantee, so none is invented
      // here. The assertions allow retries but do not require or forbid them.
      drain(fixture.timers);
      const attempts = scope.publishLocalProcessAttestation.mock.calls.length;
      expect(attempts).toBeGreaterThan(0);
      expect(fixture.originalBackend.cliPid).toBe(LEAF);
      expect(fixture.originalBackend.cliCwd).toBe(WORK_DIR);
      expect(scope.bridgeCliPid).toBe(LEAF);
      expect(scope.publishLocalProcessAttestation.mock.calls).toEqual(
        Array.from({ length: attempts }, () => [LEAF]),
      );
      expect(scope.publishLocalProcessAttestation.mock.results).toEqual(
        Array.from({ length: attempts }, () => ({ type: 'return', value: false })),
      );
      expect(scope.send.mock.calls).toHaveLength(attempts);
      for (const [message] of scope.send.mock.calls) {
        expect(message).toMatchObject({
          type: 'local_process_attestation',
          cliPid: LEAF,
          cliSpawnGeneration: 1,
          cliProcStart: `synthetic-birth-${LEAF}`,
        });
      }
      expect(scope.publishSandboxRelayCapability.mock.results).toEqual(
        Array.from({ length: attempts }, () => ({ type: 'return', value: false })),
      );
      expect(scope.completeManagedTurnOriginRevocation).toHaveBeenCalledWith(
        priorCapability, 'synthetic-turn', 1,
      );
      expect(scope.writeCliPidMarker).not.toHaveBeenCalled();
      expect(trace).toEqual(Array.from({ length: attempts }, () => [
        'attestation', 'capability-write-failed', 'revocation',
      ]).flat());
    },
  );

  it('two worker timer callbacks crossing completion do not resurrect or republish the completed runtime', () => {
    const fixture = makeWorkerFixture();
    fixture.startAnotherTraexResolver();
    expect(fixture.timers.pending()).toBe(2);
    fixture.table.visible = true;
    let completedBackend: unknown;
    let probesAtCompletion = -1;
    fixture.scope.publishLocalProcessAttestation.mockImplementationOnce((_pid: number) => {
      completedBackend = fixture.scope.backend;
      probesAtCompletion = fixture.table.childrenOf.mock.calls.length;
      // Completion occurs at the end of the first real worker callback. The
      // second callback, already queued for the same timestamp, runs afterward.
      fixture.scope.backend = null;
      fixture.scope.cliSpawnGeneration++;
      return true;
    });

    fixture.timers.runNext();
    expect(completedBackend).toBe(fixture.originalBackend);
    expect(fixture.originalBackend.cliPid).toBe(LEAF);
    expect(fixture.scope.backend).toBeNull();
    const completedBridge = fixture.scope.bridgeCliPid;
    fixture.timers.runNext();
    expect(fixture.timers.pending()).toBe(0);
    expect(fixture.scope.backend).toBeNull();
    expect(fixture.scope.bridgeCliPid).toBe(completedBridge);
    expect(fixture.table.childrenOf.mock.calls.length).toBe(probesAtCompletion);
    expect(fixture.scope.publishLocalProcessAttestation.mock.calls).toEqual([[LEAF]]);
  });

  it.each(['traex', 'traex-helper'])(
    'public retry keeps an exec-changing root rather than its %s descendant',
    descendantComm => {
      const timers = makeManualTimers();
      const table = makeProcessTable(descendantComm);
      const backend = makeBackend();
      const apply = vi.fn();
      scheduleTraexLeafPidResolve(ROOT, {
        getBackend: () => backend,
        getChildPid: () => backend.getChildPid(),
        applyRealPid: apply,
        schedule: timers.schedule,
        probes: { childrenOf: table.childrenOf, commOf: table.commOf },
      });
      timers.runNext(); // node root, no native descendant yet; retry is queued
      expect(timers.pending()).toBeGreaterThan(0);
      table.rootComm = 'traex';
      table.visible = true;
      table.childrenOf.mockClear();
      const probes = { childrenOf: table.childrenOf, commOf: table.commOf };

      // Minimal sequence: node root queues retry -> same PID execs TRAE ->
      // an identically/near-named descendant appears -> queued callback fires.
      // Invariant: the owned native root wins; no descendant traversal/binding.
      expect(resolveTraexOwnershipPid(ROOT, true, probes)).toBe(ROOT);
      drain(timers);
      expect(table.childrenOf).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(backend.cliPid).toBe(ROOT);
    },
  );

  it.each([false, true])(
    'worker preserves the root when it execs TRAE before discovery resumes (late PID=%s)',
    late => {
      const fixture = makeWorkerFixture({ late });
      fixture.table.rootComm = 'traex';
      fixture.table.visible = true;
      fixture.table.childrenOf.mockClear();
      drain(fixture.timers);
      expect(fixture.originalBackend.cliPid).toBe(ROOT);
      expect(fixture.scope.bridgeCliPid).toBe(ROOT);
      expect(fixture.table.childrenOf).not.toHaveBeenCalled();
      expect(fixture.scope.publishLocalProcessAttestation.mock.calls.every(
        ([pid]: [number]) => pid === ROOT,
      )).toBe(true);
    },
  );

  it('public ownership resolution rechecks an owned root that execs during the child-table walk', () => {
    const table = makeProcessTable();
    table.visible = true;
    table.childrenOf.mockImplementation((pid: number) => {
      if (pid !== ROOT) return [];
      // The OS process can exec independently while a synchronous JS probe is
      // running. This transition is INSIDE discovery, not between timer ticks.
      table.rootComm = 'traex';
      return [LEAF]; // an exact-name TRAE descendant/subagent is now observable
    });
    const resolved = resolveTraexOwnershipPid(ROOT, true, {
      childrenOf: table.childrenOf, commOf: table.commOf,
    });
    expect(table.rootComm).toBe('traex');
    // Minimal sequence: read root=node -> probe children -> root execs TRAE ->
    // find descendant=TRAE. Invariant: root identity must be revalidated before
    // selecting a descendant; the session's native root remains the owner.
    expect(resolved).toBe(ROOT);
  });

  it('public retry cannot bind a descendant after the root execs inside its probe walk', () => {
    const timers = makeManualTimers();
    const table = makeProcessTable();
    const backend = makeBackend();
    table.visible = true;
    table.childrenOf.mockImplementation((pid: number) => {
      if (pid !== ROOT) return [];
      table.rootComm = 'traex';
      return [LEAF];
    });
    const apply = vi.fn((pid: number) => { backend.cliPid = pid; });
    scheduleTraexLeafPidResolve(ROOT, {
      getBackend: () => backend,
      getChildPid: () => backend.getChildPid(),
      applyRealPid: apply,
      schedule: timers.schedule,
      probes: { childrenOf: table.childrenOf, commOf: table.commOf },
    });
    drain(timers);
    expect(table.rootComm).toBe('traex');
    expect(backend.cliPid).toBe(ROOT);
    // Keeping the existing binding or explicitly reaffirming ROOT are both
    // valid; publishing LEAF after the root became TRAE is not.
    expect(apply.mock.calls.every(([pid]) => pid === ROOT)).toBe(true);
  });

  it('worker retry does not publish a TRAE descendant when its root execs during discovery', () => {
    const fixture = makeWorkerFixture();
    fixture.table.visible = true;
    fixture.table.childrenOf.mockImplementation((pid: number) => {
      if (pid !== ROOT) return [];
      fixture.table.rootComm = 'traex';
      return [LEAF];
    });
    drain(fixture.timers);
    expect(fixture.table.rootComm).toBe('traex');
    expect(fixture.originalBackend.cliPid).toBe(ROOT);
    expect(fixture.scope.bridgeCliPid).toBe(ROOT);
    expect(fixture.scope.publishLocalProcessAttestation.mock.calls.every(
      ([pid]: [number]) => pid === ROOT,
    )).toBe(true);
  });
});

describe('TraeX lease lifecycle', () => {
  function leaseHarness(lease: any) {
    const scope: Record<string, any> = {
      traexRuntimeLeaseContext: undefined,
      traexSpawnLeaseContext: undefined,
      traexLeaseSettlements: new Set(),
      pendingTraexSpawnAbandon: undefined,
      log: vi.fn(),
    };
    scope.stopTraexLeaseHeartbeat = loadWorkerFunction('stopTraexLeaseHeartbeat', scope);
    scope.startTraexSpawnLeaseHeartbeat = loadWorkerFunction('startTraexSpawnLeaseHeartbeat', scope);
    scope.settleTraexSpawnLease = loadWorkerFunction('settleTraexSpawnLease', scope);
    const create = loadWorkerFunction<(lease: any) => any>('createTraexSpawnLeaseContext', scope);
    const context = create(lease);
    scope.traexRuntimeLeaseContext = context;
    scope.traexSpawnLeaseContext = context;
    scope.pendingTraexSpawnAbandon = context.abandon;
    return { scope, context };
  }

  it('does not destroy a persistent backend when retirement only detaches it', async () => {
    const destroySession = vi.fn();
    const kill = vi.fn();
    const scope: Record<string, any> = {
      backend: { destroySession, kill, getChildPid: () => null },
      effectiveBackendType: 'tmux',
      stopCodexRpcEngine: vi.fn(async () => true),
    };
    const stop = loadWorkerFunction<(opts?: { destroyBackend?: boolean }) => Promise<boolean>>('stopOwnedProcessesForTraexSettlement', scope);
    await expect(stop({ destroyBackend: false })).resolves.toBe(true);
    expect(destroySession).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not let a superseded spawn catch abandon the newer generation lease', async () => {
    const oldAbandon = vi.fn(async () => {});
    const newAbandon = vi.fn(async () => {});
    const scope: Record<string, any> = {
      closeRequested: false,
      workerSessionEventScope: undefined,
      pendingTraexSpawnAbandon: undefined,
      log: vi.fn(),
    };
    scope.spawnCliBody = vi.fn(async (_cfg: any, opts: any) => {
      // The old body owns oldAbandon. Before its rejection reaches the outer
      // catch, a replacement installs newAbandon in the module-global slot.
      if (opts.traexSpawnAbandonRef) opts.traexSpawnAbandonRef.current = oldAbandon;
      scope.pendingTraexSpawnAbandon = newAbandon;
      throw new Error('old generation failed');
    });
    const spawn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', scope);
    await expect(spawn({})).rejects.toThrow('old generation failed');
    expect(oldAbandon).toHaveBeenCalledTimes(1);
    expect(newAbandon).not.toHaveBeenCalled();
  });

  it('abandons a pre-exec lease exactly once', async () => {
    const abandon = vi.fn(async () => {});
    const { scope, context } = leaseHarness({ abandon, release: vi.fn(async () => {}) });
    await Promise.all([context.abandon(), context.abandon()]);
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(scope.traexRuntimeLeaseContext).toBeUndefined();
    expect(scope.pendingTraexSpawnAbandon).toBeUndefined();
  });

  it('keeps a failed release retryable instead of marking the context settled', async () => {
    const release = vi.fn()
      .mockRejectedValueOnce(new Error('writer still alive'))
      .mockResolvedValueOnce(undefined);
    const { scope, context } = leaseHarness({ release, abandon: vi.fn(async () => {}) });
    context.running = true;
    await expect(scope.settleTraexSpawnLease(context)).rejects.toThrow('writer still alive');
    expect(context.settled).toBe(false);
    expect(scope.traexRuntimeLeaseContext).toBe(context);
    await scope.settleTraexSpawnLease(context);
    expect(context.settled).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('acquires an independent RPC viewer peer from the same frozen snapshot', async () => {
    const appLease = {
      snapshot: { snapshot: true, traexPath: '/snapshots/combo-a/traex', dir: '/snapshots/combo-a', comboKey: 'combo-a', helperPath: '/snapshots/combo-a/helper' },
      release: vi.fn(async () => {}), abandon: vi.fn(async () => {}),
    };
    const viewerLease = {
      snapshot: appLease.snapshot,
      release: vi.fn(async () => {}), abandon: vi.fn(async () => {}),
    };
    const scope: Record<string, any> = {
      traexRuntimeLeaseContext: undefined,
      traexLeaseSettlements: new Set(),
      pendingTraexSpawnAbandon: undefined,
      resolveInstallIdentity: () => ({}),
      readProcessStartIdentity: () => 'worker-birth',
      daemonBirthIdentity: () => ({ daemonPid: process.pid }),
      acquireTraexRuntimePeerLease: vi.fn(async () => ({ kind: 'granted', lease: viewerLease })),
      log: vi.fn(),
    };
    scope.stopTraexLeaseHeartbeat = loadWorkerFunction('stopTraexLeaseHeartbeat', scope);
    scope.settleTraexSpawnLease = loadWorkerFunction('settleTraexSpawnLease', scope);
    const create = loadWorkerFunction<(lease: any) => any>('createTraexSpawnLeaseContext', scope);
    scope.createTraexSpawnLeaseContext = create;
    const prepare = loadWorkerFunction<(context: any) => Promise<any>>('prepareTraexRpcViewerLease', scope);
    const app = create(appLease);
    app.running = true;
    app.configuredEntry = '/releases/a/traex';
    const viewer = await prepare(app);
    expect(viewer.context).not.toBe(app);
    expect(viewer.context.lease).toBe(viewerLease);
    expect(viewer.cliPathOverride).toBe('/snapshots/combo-a/traex');
    expect(viewer.configuredEntry.entry).toBe('/releases/a/traex');
    expect(viewer.launchTarget.snapshotDir).toBe('/snapshots/combo-a');

    viewer.context.running = true;
    await scope.settleTraexSpawnLease(viewer.context);
    expect(viewerLease.release).toHaveBeenCalledTimes(1);
    expect(appLease.release).not.toHaveBeenCalled();
    await scope.settleTraexSpawnLease(app);
    expect(appLease.release).toHaveBeenCalledTimes(1);
  });

  it('selects the app-server parent lease for an owned RPC viewer', async () => {
    const lease = {
      snapshot: { snapshot: true, traexPath: '/snapshots/combo-a/traex', dir: '/snapshots/combo-a', comboKey: 'combo-a' },
      release: vi.fn(async () => {}), abandon: vi.fn(async () => {}),
    };
    const scope: Record<string, any> = { traexRuntimeLeaseContext: undefined, pendingTraexSpawnAbandon: undefined, traexLeaseSettlements: new Set(), log: vi.fn() };
    const create = loadWorkerFunction<(lease: any) => any>('createTraexSpawnLeaseContext', scope);
    const resolve = loadWorkerFunction<(cfg: any, engine: any, context: any) => any>('resolveTraexRpcViewerLease', scope);
    const context = create(lease);
    context.running = true;
    expect(resolve({ existingAppServerEndpoint: undefined }, {}, context)).toBe(context);
    expect(resolve({ existingAppServerEndpoint: undefined }, undefined, context)).toBeUndefined();
  });

  it('registers an adopted TraeX runtime as existing occupancy without pre-exec abandonment', async () => {
    const lease = {
      snapshot: { snapshot: false, comboKey: '', traexPath: '/adopted/traex' },
      release: vi.fn(async () => {}), abandon: vi.fn(async () => {}), markRunning: vi.fn(async () => {}),
    };
    const scope: Record<string, any> = {
      traexLaunchUsesSharedRuntimeGate: (cfg: any) => !cfg.wrapperCli && cfg.cliLaunchMode !== 'forge-traex',
      resolveCommandEntry: (path: string) => path, resolveCommandReal: (path: string) => path,
      releaseDirForExecutable: (path: string) => `${path}/..`,
      resolveTraexChildHome: () => '/home/trae', botInjectedEnv: () => ({}),
      isTraexProcess: () => true, readProcessStartIdentity: (pid: number) => `birth-${pid}`,
      readRunningExeIdentity: () => undefined,
      daemonBirthIdentity: () => ({ daemonPid: 123 }),
      acquireTraexRuntimeOccupancy: vi.fn(async () => ({ kind: 'granted', lease })),
      startTraexSpawnLeaseHeartbeat: vi.fn(), traexRuntimeLeaseContext: undefined,
      pendingTraexSpawnAbandon: undefined, log: vi.fn(),
    };
    const create = loadWorkerFunction<(lease: any) => any>('createTraexSpawnLeaseContext', scope);
    scope.createTraexSpawnLeaseContext = create;
    const register = loadWorkerFunction<(cfg: any) => Promise<any>>('registerAdoptedTraexRuntime', scope);
    const cfg = {
      adoptMode: true, cliId: 'traex', cliPathOverride: '/adopted/traex', adoptCliPid: 456,
      envPolicy: undefined, envUnset: undefined, env: undefined, protectedMcpPolicy: undefined,
    };
    const context = await register(cfg, 999);
    expect(context.running).toBe(true);
    expect(scope.traexRuntimeLeaseContext).toBe(context);
    expect(scope.pendingTraexSpawnAbandon).toBeUndefined();
    expect(scope.startTraexSpawnLeaseHeartbeat).toHaveBeenCalledWith(context);
    expect(scope.acquireTraexRuntimeOccupancy).toHaveBeenCalledWith(expect.objectContaining({
      existingRuntime: true, cliPid: 456, cliStart: 'birth-456', fixedPath: true,
    }));
    await expect(register({ ...cfg, wrapperCli: '/wrapper' })).resolves.toBeUndefined();
    expect(scope.acquireTraexRuntimeOccupancy).toHaveBeenCalledTimes(1);
  });

  it('releases PID-less adopted occupancy only when the adopted pane is proven gone', async () => {
    const { scope, context } = leaseHarness({
      release: vi.fn(async () => {}), abandon: vi.fn(async () => {}),
    });
    context.running = true;
    scope.effectiveBackendType = 'tmux';
    scope.isObserveBackend = isObserveBackend;
    const settle = loadWorkerFunction<(context: any, backend: any) => void>('settleAdoptedTraexRuntime', scope);
    const observer = {
      captureCurrentScreen: () => '', captureViewport: () => '', getPaneSize: () => null,
      isPaneAlive: () => false,
    };
    settle(context, observer);
    await Promise.resolve();
    expect(context.lease.abandon).toHaveBeenCalledTimes(1);
    expect(context.settled).toBe(true);

    const tracked = leaseHarness({
      release: vi.fn(async () => {}), abandon: vi.fn(async () => {}),
    });
    tracked.context.cliPid = 999;
    tracked.context.running = true;
    tracked.scope.effectiveBackendType = 'tmux';
    tracked.scope.isObserveBackend = isObserveBackend;
    const settleTracked = loadWorkerFunction<(context: any, backend: any) => void>('settleAdoptedTraexRuntime', tracked.scope);
    settleTracked(tracked.context, observer);
    await Promise.resolve();
    expect(tracked.context.lease.release).toHaveBeenCalledTimes(1);
    expect(tracked.context.lease.abandon).not.toHaveBeenCalled();

    const alive = leaseHarness({
      release: vi.fn(async () => {}), abandon: vi.fn(async () => {}),
    });
    alive.scope.effectiveBackendType = 'tmux';
    alive.scope.isObserveBackend = isObserveBackend;
    const keepAlive = loadWorkerFunction<(context: any, backend: any) => void>('settleAdoptedTraexRuntime', alive.scope);
    keepAlive(alive.context, { ...observer, isPaneAlive: () => true });
    expect(alive.context.lease.abandon).not.toHaveBeenCalled();
    expect(alive.context.settled).toBe(false);

    const orca = leaseHarness({
      release: vi.fn(async () => {}), abandon: vi.fn(async () => {}),
    });
    orca.scope.effectiveBackendType = 'orca';
    orca.scope.isObserveBackend = isObserveBackend;
    const keepOrca = loadWorkerFunction<(context: any, backend: any) => void>('settleAdoptedTraexRuntime', orca.scope);
    keepOrca(orca.context, observer);
    expect(orca.context.lease.abandon).not.toHaveBeenCalled();
    expect(orca.context.settled).toBe(false);
  });

  it('waits for an already-started RPC release during shutdown', async () => {
    let finish!: () => void;
    const lease = { release: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), abandon: vi.fn(async () => {}) };
    const scope: Record<string, any> = {
      traexRuntimeLeaseContext: undefined, traexRpcLeaseContext: undefined,
      traexLeaseSettlements: new Set(),
      pendingTraexSpawnAbandon: undefined, log: vi.fn(),
    };
    scope.stopTraexLeaseHeartbeat = loadWorkerFunction('stopTraexLeaseHeartbeat', scope);
    scope.settleTraexSpawnLease = loadWorkerFunction('settleTraexSpawnLease', scope);
    scope.settleTraexRpcLease = loadWorkerFunction('settleTraexRpcLease', scope);
    const create = loadWorkerFunction<(lease: any) => any>('createTraexSpawnLeaseContext', scope);
    const context = create(lease);
    context.running = true;
    scope.traexRuntimeLeaseContext = context;
    scope.traexRpcLeaseContext = context;
    void scope.settleTraexSpawnLease(context);
    const shutdown = loadWorkerFunction<() => Promise<void>>('settleTraexLeasesForShutdown', scope);
    let finished = false;
    const pending = shutdown().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    finish();
    await pending;
    expect(finished).toBe(true);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('settles both spawn and RPC leases on shutdown', async () => {
    const spawnLease = { release: vi.fn(async () => {}), abandon: vi.fn(async () => {}) };
    const rpcLease = { release: vi.fn(async () => {}), abandon: vi.fn(async () => {}) };
    const scope: Record<string, any> = {
      traexRuntimeLeaseContext: undefined,
      traexRpcLeaseContext: undefined,
      traexLeaseSettlements: new Set(),
      pendingTraexSpawnAbandon: undefined,
      log: vi.fn(),
    };
    scope.stopTraexLeaseHeartbeat = loadWorkerFunction('stopTraexLeaseHeartbeat', scope);
    scope.settleTraexSpawnLease = loadWorkerFunction('settleTraexSpawnLease', scope);
    scope.settleTraexRpcLease = loadWorkerFunction('settleTraexRpcLease', scope);
    const create = loadWorkerFunction<(lease: any) => any>('createTraexSpawnLeaseContext', scope);
    const spawn = create(spawnLease);
    const rpc = create(rpcLease);
    spawn.running = true;
    rpc.running = true;
    scope.traexRuntimeLeaseContext = spawn;
    scope.traexRpcLeaseContext = rpc;
    const shutdown = loadWorkerFunction<() => Promise<void>>('settleTraexLeasesForShutdown', scope);
    await shutdown();
    expect(spawnLease.release).toHaveBeenCalledTimes(1);
    expect(rpcLease.release).toHaveBeenCalledTimes(1);
    expect(spawnLease.abandon).not.toHaveBeenCalled();
    expect(rpcLease.abandon).not.toHaveBeenCalled();
  });

  it('preserves snapshot identity on non-Linux and fails closed on Linux mismatch', async () => {
    const lease = {
      occupancyOnly: false,
      snapshot: { snapshot: true, traexPath: '/snap/traex', comboKey: '', dir: '/snap' },
      markRunning: vi.fn(async () => {}),
      markUnknown: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
      abandon: vi.fn(async () => {}),
    };
    const { scope, context } = leaseHarness(lease);
    Object.assign(scope, {
      traexContentKeyInFlight: new Set<number>(),
      readRunningExeIdentity: () => undefined,
      isTraexProcess: () => true,
      readProcessStartIdentity: () => undefined,
      resolveInstallIdentity: () => ({}),
      sameExecutableObject: () => false,
      captureTraexRunningContentIdentity: async () => ({ comboKey: 'combo', installSignature: 'sig' }),
      captureRunningContentKey: async () => ({ comboKey: 'combo', installSignature: 'sig' }),
      log: vi.fn(),
      process: { platform: 'darwin' },
    });
    const attach = loadWorkerFunction<(pid: number) => void>('attachTraexLeaseCli', scope);
    attach(123);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(lease.markRunning).toHaveBeenCalledWith(123, undefined, { comboKey: 'combo', installSignature: 'sig' });
    expect(lease.markUnknown).not.toHaveBeenCalled();
    scope.stopTraexLeaseHeartbeat();

    scope.process = { platform: 'linux' };
    context.running = false;
    attach(124);
    expect(lease.markUnknown).toHaveBeenCalledWith(124, undefined);
    scope.stopTraexLeaseHeartbeat();
  });
});
