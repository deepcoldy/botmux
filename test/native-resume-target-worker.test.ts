import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';
import { nativeResumeTargetFailure } from '../src/services/native-resume-target.js';
import { nativeResumeTargetAllowed } from '../src/utils/native-resume-target-plan.js';
import { RestartCoordinator } from '../src/core/restart-coordinator.js';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { sameRuntime } from '../src/services/session-contract.js';
import { hasProtectedSessionMutationOwnership } from '../src/core/session-mutation-guard.js';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import ts from 'typescript';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatSafeFatalErrorMessage } from '../src/core/startup-failure-reason.js';
import { shouldRunStartupCommandsOnSpawn } from '../src/core/startup-commands.js';
import { decideRestartFollowup } from '../src/core/restart-followup-policy.js';
import { awaitRuntimeReservation } from '../src/services/runtime-reservation.js';

const sourceId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const requested = { sourceId, targetId, sourceSha256: 'a'.repeat(64), targetSha256: 'b'.repeat(64) };
const cfg = () => ({ cliId: 'traex', cliSessionId: sourceId, backendType: 'tmux', model: 'native-model' });

function workerScope() {
  const sends: any[] = [], retirements: any[] = [];
  const scope: any = {
    lastInitConfig: cfg(), backend: { getChildPid: () => 123 }, bridgeCliPid: 123,
    isPromptReady: true, cliRestartInProgress: false, tmuxRestartTimer: null,
    isFlushing: false, injectionFlushing: false, commandLineWritesPending: false,
    pendingMessages: [], pendingRawInputs: [], durableTurnInFlight: false,
    inflightInputs: { hasUnresolved: () => false },
    nativeResumeTargetAllowed, nativeResumeTargetFailure, sandboxEnabled: () => false,
    traexRestoredComposerReady: () => true, captureBackendScreen: () => 'owned idle composer',
    findTraexRolloutSetByPid: () => new Set([sourceId]),
    findTraexRolloutByPid: () => ({ cliSessionId: sourceId }),
    verifyNativeResumeTarget: vi.fn(), traeSessionsRoot: () => '/owned/sessions',
    findTraexRolloutBySessionId: (id: string) => `/owned/sessions/${id}.jsonl`,
    send: (msg: any) => sends.push(msg), codexAutoUpgrade: undefined,
    effectiveBackendType: 'tmux', applyWorkerLaunchModel: vi.fn(),
    applyRespawnConfigPatch: () => ({}), pendingLaunchConvergence: undefined,
    currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined,
    settleDurableTurnForRestart: vi.fn(),
    waitForProcessQuiescence: vi.fn(async () => {}), pidNotProvablyGone: () => false,
    delay: async () => {}, log: vi.fn(),
    restartCliProcess: vi.fn(async (_why: string, opts: any) => {
      retirements.push(opts);
      await opts.beforeRespawn({ pid: 123, processScope: [123,124] });
    }),
  };
  return { scope, sends, retirements, run: loadWorkerMessageHandler('restart', scope) };
}

function restartProcessScope() {
  const outgoing: any[] = [], logs: string[] = [], timers: Array<() => Promise<void>> = [], spawns: any[] = [];
  const backend = { getChildPid: () => 1, destroySession: () => undefined };
  const scope: any = {
    codexAutoUpgrade: undefined, nativeResumeTargetFailure,
    lastInitConfig: { cliId: 'traex', backendType: 'tmux', sessionId: 'restart-process-probe', adoptMode: false },
    CliSpawnSupersededError: class extends Error {},
    effectiveBackendType: 'tmux', backend, cliSpawnGeneration: 1,
    submitFailureChains: new Set(), inputDeliveryEvidence: new Map(), queuedActivationReceipts: new Set(),
    cliRestartInProgress: false, replacementSpawnInProgress: false, restartWindowLaunch: undefined,
    rawInputRestartGate: false, revokeManagedTurnOriginForRestart: () => {},
    lastCliExitServerReplaced: false, restartSpendsFreshBudget: () => false, consecutiveInWorkerRestarts: 0,
    tmuxRestartTimer: null, remoteThreadId: undefined,
    snapshotChildPids: () => () => [], intentionalRestartBackend: undefined,
    intentionallyRetiredBackends: new WeakSet(), classifyRestartTeardown: () => ({ mayRespawn: true }),
    stopOwnedSessionScope: () => {}, killCli: () => {}, traexAutoModelController: undefined,
    awaitingFirstPrompt: false,
    setTimeout: (fn: () => Promise<void>) => { timers.push(fn); return 1; },
    startScreenUpdates: () => {}, startStuckDetector: () => {},
    restartLaunchSettings: () => ({ launch: 'snapshot' }), adoptPendingLaunchConvergence: () => {},
    codexRpcEligible: () => false, sandboxEnabled: () => false,
    spawnCli: async (cfg: unknown, opts: unknown) => { spawns.push({ cfg, opts }); },
    traexAutoModelRuntimeEligible: () => false, prepareCodexNativeTitleGeneration: async () => {},
    codexRpcEngine: undefined, decideRestartFollowup: () => ({ kind: 'none' }),
    isPromptReady: false, isRemoteBackendType: () => false, flushPending: () => {},
    fatalWorkerErrorPending: false, pendingLaunchConvergence: undefined,
    activeRestartAttemptId: 'attempt', currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined,
    sendAndFlush: async (msg: any) => { outgoing.push(msg); }, chatSafeFatalErrorMessage,
    sandboxNamespaceDiagnosis: () => undefined,
    process: { exit: () => {} },
    log: (line: string) => { logs.push(line); },
  };
  scope.sendFatalWorkerErrorAndExit = loadWorkerFunction('sendFatalWorkerErrorAndExit', scope);
  return { scope, outgoing, logs, timers, spawns, run: loadWorkerFunction('restartCliProcess', scope) };
}

// 非文本断言：执行真实 runtime_binding_started 分支并断言 mayStart，不比较源码文本。
async function runRuntimeBindingStarted(scope: Record<string, any>, msg: Record<string, unknown>): Promise<void> {
  const source = ts.createSourceFile('worker-pool.ts', readFileSync('src/core/worker-pool.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  let branch: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(source).includes("msg.type === 'runtime_binding_started' || msg.type === 'runtime_binding'")) branch = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!branch) throw new Error('runtime binding branch missing');
  const code = ts.transpileModule(`async function handle(msg) { ${branch.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  await new Function(...Object.keys(scope), `${code}; return handle;`)(...Object.values(scope))(msg);
}
function runtimeController(contractWorker: unknown) {
  return {
    admitsRegistration: () => true, reserveBinding: () => {}, flushPrimary: async () => {},
    bindingMayStart: () => true,
    store: {
      read: () => ({ worker: contractWorker, lifecycle: 'active', activeOperationId: 'attempt' }),
      binding: () => ({ ref: { runtimeId: 'runtime-1' } }),
    },
  };
}

describe('strict native restart process boundaries', () => {
  it.each(['realpath', 'malformed'])('redacts a %s verification failure before fatal IPC but keeps the local diagnostic', async kind => {
    const f = restartProcessScope();
    const dir = mkdtempSync(join(tmpdir(), 'PRIVATE_NATIVE_REALPATH_'));
    try {
      await f.run('explicit native history replacement', {
        immediate: true, beforeRespawnMustSucceed: true,
        beforeRespawn: async () => {
          if (kind === 'realpath') realpathSync(join(dir, 'missing-target.jsonl'));
          else JSON.parse('PRIVATE_HISTORY_SECRET{"type":"event_msg"}');
        },
      });
      const fatal = f.outgoing.find(msg => msg.type === 'error');
      expect(fatal?.message).toBe('native_resume_target_unavailable');
      expect(JSON.stringify(f.outgoing)).not.toContain('PRIVATE');
      expect(f.logs.join('\n')).toContain('PRIVATE');
      expect(f.timers).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails closed instead of truncating a strict process scope at 256 PIDs', async () => {
    const f = restartProcessScope();
    f.scope.snapshotChildPids = () => (current: number) => current === 1
      ? Array.from({ length: 256 }, (_, index) => index + 2) : [];
    let beforeRespawn = false;
    await f.run('explicit native history replacement', {
      immediate: true, beforeRespawnMustSucceed: true,
      beforeRespawn: async () => { beforeRespawn = true; },
    });
    expect(beforeRespawn).toBe(false);
    expect(f.outgoing.find(msg => msg.type === 'error')?.message).toBe('native_resume_process_scope_overflow');
    expect(f.timers).toHaveLength(0);
  });

  it('redacts strict teardown and replacement-spawn failures outside beforeRespawn', async () => {
    for (const boundary of ['killCli', 'spawnCli'] as const) {
      const f = restartProcessScope();
      f.scope[boundary] = boundary === 'killCli'
        ? () => { throw new Error(`PRIVATE_${boundary}_PATH`); }
        : async () => { throw new Error(`PRIVATE_${boundary}_PATH`); };
      await f.run('explicit native history replacement', {
        immediate: true, beforeRespawnMustSucceed: true, suppressStartupCommands: true,
        beforeRespawn: async () => {},
      });
      if (boundary === 'spawnCli') {
        expect(f.timers).toHaveLength(1);
        await f.timers[0]!();
      }
      const fatal = f.outgoing.find(msg => msg.type === 'error');
      expect(fatal?.message).toBe('native_resume_target_unavailable');
      expect(JSON.stringify(f.outgoing)).not.toContain('PRIVATE');
      expect(f.logs.join('\n')).toContain('PRIVATE');
    }
  });

  it('keeps ordinary reservation refusals distinct from a proven target conflict', async () => {
    for (const [targetInUse, expected] of [[false, 'refused'], [true, 'refused_native_target_in_use']] as const) {
      const pending = new Map<string, (mayStart: boolean, targetInUse?: boolean) => void>();
      const outcome = awaitRuntimeReservation(pending, 'binding', () => {});
      pending.get('binding')!(false, targetInUse);
      expect(await outcome).toBe(expected);
    }
  });

  it('refuses generic replacement recovery instead of falling back to the source with startup commands', async () => {
    const f = restartProcessScope();
    f.scope.decideRestartFollowup = decideRestartFollowup;
    f.scope.spawnCli = async (cfg: any, opts: any) => { f.spawns.push({ cfg, opts }); f.scope.backend = null; };
    await f.run('explicit native history replacement', {
      immediate: true, beforeRespawnMustSucceed: true, suppressStartupCommands: true,
      exactResumeSessionId: targetId, beforeRespawn: async () => {},
    });
    expect(f.timers).toHaveLength(1);
    await f.timers[0]!();
    expect(f.spawns).toHaveLength(1);
    expect(f.spawns[0].cfg.cliSessionId).toBe(targetId);
    expect(f.spawns[0].opts).toMatchObject({ exactResumeSessionId: targetId, suppressStartupCommands: true });
    expect(f.outgoing.find(msg => msg.type === 'error')?.message).toBe('native_resume_target_superseded');
    expect(f.timers).toHaveLength(1);
  });

  it('passes native startup suppression to the actual spawn and applies the real no-replay policy', async () => {
    const f = restartProcessScope();
    await f.run('explicit native history replacement', {
      immediate: true, beforeRespawnMustSucceed: true, suppressStartupCommands: true,
      beforeRespawn: async () => {},
    });
    expect(f.timers).toHaveLength(1);
    await f.timers[0]!();
    expect(f.spawns, JSON.stringify({ logs: f.logs, outgoing: f.outgoing })).toHaveLength(1);
    const spawnOpts = f.spawns[0].opts;
    expect(spawnOpts.suppressStartupCommands).toBe(true);
    expect(shouldRunStartupCommandsOnSpawn({
      willReattachPersistent: false, suppressStartupCommands: spawnOpts.suppressStartupCommands,
    })).toBe(false);
  });
});

describe('real worker native resume-target branch', () => {
  it('accepts a proven current native ID acquired after fresh worker initialization', async () => {
    const f = workerScope();
    f.scope.lastInitConfig.cliSessionId = undefined;
    await f.run({ type: 'restart', attemptId: 'attempt', nativeResumeTarget: requested });
    expect(f.retirements).toHaveLength(1);
    expect(f.retirements[0].exactResumeSessionId).toBe(targetId);
  });
  it('validates twice, proves quiescence, then selects the exact target with fresh fallback forbidden', async () => {
    const f = workerScope();
    await f.run({ type: 'restart', attemptId: 'attempt', nativeResumeTarget: requested });
    expect(f.scope.verifyNativeResumeTarget).toHaveBeenCalledTimes(2);
    expect(f.scope.waitForProcessQuiescence).toHaveBeenCalledTimes(1);
    expect(f.retirements[0].exactResumeSessionId).toBe(targetId);
    expect(f.retirements[0].beforeRespawnMustSucceed).toBe(true);
    expect(f.retirements[0].suppressStartupCommands).toBe(true);
    expect(f.retirements[0].skipRestartBudget).toBe(true);
    expect(f.scope.pendingNativeResumeTarget.applied).toBe(true);
    expect(f.sends).toEqual([]);
  });
  it.each(['pendingMessages','pendingRawInputs'])('does not retire while %s contains user input', async key => {
    const f = workerScope(); f.scope[key] = ['user intervention'];
    await f.run({ type: 'restart', attemptId: 'attempt', nativeResumeTarget: requested });
    expect(f.retirements).toEqual([]);
    expect(f.sends[0]).toMatchObject({ type: 'restart_result', attemptId:'attempt',status:'failed',category:'spawn_failed',untouched:true, nativeResumeTarget:{errorCode:'native_resume_target_not_idle'} });
  });
  it('does not retire while a written native input is still unresolved', async () => {
    const f = workerScope();
    f.scope.inflightInputs.hasUnresolved = () => true;
    await f.run({ type: 'restart', attemptId: 'attempt', nativeResumeTarget: requested });
    expect(f.retirements).toEqual([]);
    expect(f.sends[0]).toMatchObject({ type: 'restart_result', status: 'failed', untouched: true,
      nativeResumeTarget: { errorCode: 'native_resume_target_not_idle' } });
  });
  it('does not retire a manually edited composer or another native conversation', async () => {
    for (const change of [
      (scope: any) => { scope.traexRestoredComposerReady = () => false; },
      (scope: any) => { scope.findTraexRolloutByPid = () => ({ cliSessionId: targetId }); },
      (scope: any) => { scope.findTraexRolloutSetByPid = () => new Set([sourceId,targetId]); },
    ]) {
      const f=workerScope(); change(f.scope);
      await f.run({ type:'restart',attemptId:'attempt',nativeResumeTarget:requested });
      expect(f.retirements).toEqual([]); expect(f.sends[0].untouched).toBe(true);
    }
  });
  it('a late changed source never switches to the prepared target', async () => {
    const f=workerScope();
    f.scope.verifyNativeResumeTarget.mockImplementationOnce(()=>{}).mockImplementationOnce(()=>{throw new Error('changed');});
    await expect(f.run({type:'restart',attemptId:'attempt',nativeResumeTarget:requested})).rejects.toThrow('changed');
    expect(f.retirements[0].exactResumeSessionId).toBe(sourceId);
    expect(f.retirements[0].beforeRespawnMustSucceed).toBe(true);
    expect(f.scope.pendingNativeResumeTarget.applied).toBe(false);
  });
  it('an uncertain process retirement never reads or selects the target again', async () => {
    const f=workerScope();f.scope.waitForProcessQuiescence.mockRejectedValue(new Error('alive'));
    await expect(f.run({type:'restart',attemptId:'attempt',nativeResumeTarget:requested})).rejects.toThrow('alive');
    expect(f.scope.verifyNativeResumeTarget).toHaveBeenCalledTimes(1);
    expect(f.retirements[0].exactResumeSessionId).toBe(sourceId);
  });
});

describe('real worker success receipt', () => {
  it('requires actual target ownership; publishes identity before confirming restart', () => {
    const f=workerScope();
    Object.assign(f.scope, { activeRestartAttemptId:'attempt',
      pendingNativeResumeTarget:{attemptId:'attempt',requested,applied:true},
      decideRestartReceipt:()=> 'emit', pendingTopicEffortRestart:undefined,
      persistCliSessionId:(id:string)=>f.sends.push({identity:id}) });
    const settle=loadWorkerFunction('settleRestartAttemptOnReady',f.scope);
    settle('test');
    expect(f.sends).toEqual([]);
    f.scope.findTraexRolloutSetByPid=()=>new Set([targetId]);
    f.scope.findTraexRolloutByPid=()=>({cliSessionId:targetId});
    settle('test');
    expect(f.sends[0]).toEqual({identity:targetId});
    expect(f.sends[1]).toMatchObject({type:'restart_result',status:'succeeded',nativeResumeTarget:{sourceId,targetId}});
  });
});

describe('real daemon correlated restart sender', () => {
  function fixture(primary=false) {
    const worker={killed:false,send:vi.fn()}, ds:any={worker,workerGeneration:1,workerReady:true,cliReady:true,
      lastScreenStatus:'idle',initConfig:{...cfg(),cliSessionId:undefined},
      session:{sessionId:'owned-session',cliSessionId:sourceId,status:'active'}};
    let release!:()=>void;
    const flushed=new Promise<void>(resolve=>{release=resolve});
    const coordinator=new RestartCoordinator({createAttemptId:()=> 'attempt'});
    const scope:any={nativeResumeTargetAllowed,nativeResumeTargetFailure,sandboxEnabled:()=>false,isSessionTransferring:()=>false,
      isSessionRestartInFlight:()=>false,sessionAcceptsDirectCommand:()=>true,
      hasPendingOrdinaryImInput:()=>false,hasPendingOrdinaryImDelivery:()=>false,
      topicEffortRestartReadiness:new Map(),nativeResumeRestartReadiness:new Map(),nativeResumeOutcomes:new WeakMap(),
      restartCoordinator:coordinator,restartIpcReason:()=>({reason:'operator'}),
      controllerForSession:()=> primary ? {currentRuntime:()=>undefined,operation:()=>({operationId:'attempt'}),flushPrimary:()=>flushed} : undefined,
      sessionContractPrimary:()=>primary,logger:{warn:vi.fn()},tag:()=> 'test', activeSessionsRegistry:new Map(),
      nativeResumeTargetClaims:new Map(), isSessionLaunchModelBlockedError:()=>false};
    scope.hasUnsettledAcceptedInput = loadWorkerPoolFunction('hasUnsettledAcceptedInput', scope);
    scope.nativeResumeTargetConflict = loadWorkerPoolFunction('nativeResumeTargetConflict', scope);
    scope.releaseNativeResumeTargetClaim = loadWorkerPoolFunction('releaseNativeResumeTargetClaim', scope);
    return {ds,worker,scope,release,coordinator,
      run:loadWorkerPoolFunction('requestSessionRestart',scope)};
  }
  it('uses current native identity, not the stale fresh-launch snapshot, and fences the old worker', () => {
    const f=fixture();
    try {
      const r:any=f.run(f.ds,{source:'dashboard',notify:()=>{}},{nativeResumeTarget:requested});
      expect(r.joined).toBe(false);
      expect(f.worker.send).toHaveBeenCalledTimes(1);
      const msg=f.worker.send.mock.calls[0][0];
      expect(msg.nativeResumeTarget).toEqual(requested);expect(msg.model).toBe('native-model');
      expect(msg.env).toBeUndefined();expect(f.ds.workerReady).toBe(false);
    } finally {f.coordinator.reset();}
  });
  it('refuses after a worker generation changed during the primary flush', async () => {
    const f=fixture(true);
    try {
      f.run(f.ds,{source:'dashboard',notify:()=>{}},{nativeResumeTarget:requested});
      f.ds.workerGeneration=2;f.release();
      for(let i=0;i<8;i++)await Promise.resolve();
      expect(f.worker.send).not.toHaveBeenCalled();
    } finally {f.coordinator.reset();}
  });
  it.each([false, true])('rejects accepted-but-unsettled input (change during primary flush=%s)', async duringFlush => {
    const f = fixture(duringFlush);
    const intervene = () => {
      f.ds.acceptedInputTurns = new Map([['open-turn', {
        workerGeneration: f.ds.workerGeneration, turnId: 'open-turn', phase: 'native-submit', at: Date.now(),
      }]]);
    };
    try {
      if (!duringFlush) intervene();
      const result = f.run(f.ds, { source: 'dashboard', notify: () => {} }, { nativeResumeTarget: requested });
      if (!duringFlush) expect(result).toBeUndefined();
      else {
        intervene(); f.release();
        for (let i = 0; i < 12; i++) await Promise.resolve();
      }
      expect(f.worker.send).not.toHaveBeenCalled();
    } finally { f.coordinator.reset(); }
  });
  it.each([false, true])('rejects a target already owned by another active session (arrives during primary flush=%s)', async duringFlush => {
    const f = fixture(duringFlush);
    const intervene = () => {
      f.scope.activeSessionsRegistry.set('target-owner', { session: { status: 'active', cliSessionId: targetId } });
    };
    try {
      if (!duringFlush) intervene();
      const result = f.run(f.ds, { source: 'dashboard', notify: () => {} }, { nativeResumeTarget: requested });
      if (!duringFlush) expect(result).toBeUndefined();
      else {
        intervene(); f.release();
        for (let i = 0; i < 12; i++) await Promise.resolve();
      }
      expect(f.worker.send).not.toHaveBeenCalled();
    } finally { f.coordinator.reset(); }
  });
  it('reserves the target after IPC dispatch and fences a later occupant at the spawn/readback boundaries', async () => {
    const first = fixture();
    const second = fixture();
    second.ds.session.sessionId = 'another-source-session';
    second.scope.nativeResumeTargetClaims = first.scope.nativeResumeTargetClaims;
    try {
      first.run(first.ds, { source: 'dashboard', notify: () => {} }, { nativeResumeTarget: requested });
      expect(first.worker.send).toHaveBeenCalledTimes(1);
      expect(second.run(second.ds, { source: 'dashboard', notify: () => {} }, { nativeResumeTarget: requested })).toBeUndefined();
      expect(second.worker.send).not.toHaveBeenCalled();

      second.ds.session.cliSessionId = targetId;
      second.scope.nativeResumeTargetMayStart = loadWorkerPoolFunction('nativeResumeTargetMayStart', second.scope);
      const ordinaryWorker = { workerId: 'worker-2', generation: 1 };
      await runRuntimeBindingStarted({ ...second.scope, ds: second.ds, worker: second.worker, contractWorker: ordinaryWorker,
        metadata: {}, sessionController: runtimeController(ordinaryWorker),
        sameWorker: (left: unknown, right: unknown) => left === right, logger: { warn: vi.fn() }, t: 'ordinary' },
      { type: 'runtime_binding_started', bindingId: 'binding-ordinary', operationId: 'attempt' });
      expect(second.worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'runtime_contract_reserved', mayStart: false, nativeResumeTargetInUse: true }));

      first.scope.activeSessionsRegistry.set('late-target-owner', { session: { status: 'active', cliSessionId: targetId } });
      first.scope.nativeResumeTargetMayStart = loadWorkerPoolFunction('nativeResumeTargetMayStart', first.scope);
      const contractWorker = { workerId: 'worker-1', generation: 1 };
      const sessionController = runtimeController(contractWorker);
      first.worker.send.mockClear();
      await runRuntimeBindingStarted({ ...first.scope, ds: first.ds, worker: first.worker, contractWorker, metadata: {},
        sessionController, sameWorker: (left: unknown, right: unknown) => left === right, logger: { warn: vi.fn() }, t: 'owned' },
      { type: 'runtime_binding_started', bindingId: 'binding-1', operationId: 'attempt' });
      expect(first.worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'runtime_contract_reserved', mayStart: false, nativeResumeTargetInUse: true }));
      first.ds.session.cliSessionId = targetId;
      const handler = loadWorkerPoolMessageHandlers(['restart_result'], { ...first.scope, ds: first.ds, worker: first.worker,
        nativeResumeTargetFailure, t: 'owned' });
      handler({ type: 'restart_result', attemptId: 'attempt', status: 'succeeded', nativeResumeTarget: { sourceId, targetId } });
      expect(first.scope.nativeResumeOutcomes.get(first.ds).state).toBe('failed');
      expect(first.ds.workerReady).toBe(false);
      expect(first.scope.nativeResumeTargetClaims.has(targetId)).toBe(true);
    } finally { first.coordinator.reset(); second.coordinator.reset(); }
  });
  it('releases claims on a synchronous pre-dispatch send failure', () => {
    const f = fixture();
    f.worker.send.mockImplementation(() => { throw new Error('ipc channel closed before send'); });
    const release = vi.spyOn(f.scope, 'releaseNativeResumeTargetClaim');
    try {
      const result: any = f.run(f.ds, { source: 'dashboard', notify: () => {} }, { nativeResumeTarget: requested });
      expect(result.startFailure).toBeDefined();
      expect(release).toHaveBeenCalled();
      expect(f.scope.nativeResumeTargetClaims.size, JSON.stringify([...f.scope.nativeResumeTargetClaims])).toBe(0);
      expect(f.ds.workerReady).toBe(true);
      expect(f.ds.cliReady).toBe(true);
    } finally { f.coordinator.reset(); }
  });
  it('releases a claim when the controller operation changes before execute', async () => {
    const f = fixture(true);
    try {
      f.run(f.ds, { source: 'dashboard', notify: () => {} }, { nativeResumeTarget: requested });
      f.scope.controllerForSession = () => ({
        currentRuntime: () => undefined, operation: () => ({ operationId: 'different-operation' }), flushPrimary: () => Promise.resolve(),
      });
      f.release();
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(f.worker.send).not.toHaveBeenCalled();
      expect(f.scope.nativeResumeTargetClaims.size).toBe(0);
    } finally { f.coordinator.reset(); }
  });
  it('an untouched worker refusal restores readiness and exposes only a bounded error code', async () => {
    const f=fixture();
    try {
      f.run(f.ds,{source:'dashboard',notify:()=>{}},{nativeResumeTarget:requested});
      const handler=loadWorkerPoolMessageHandlers(['restart_result'],{...f.scope,ds:f.ds,worker:f.worker,
        nativeResumeTargetFailure,t:'owned'});
      handler({type:'restart_result',attemptId:'attempt',status:'failed',untouched:true,
        nativeResumeTarget:{sourceId,targetId,errorCode:'private /outside/path'}});
      for(let i=0;i<4;i++)await Promise.resolve();
      expect(f.ds.workerReady).toBe(true);expect(f.ds.cliReady).toBe(true);
      expect(f.ds.session.cliSessionId).toBe(sourceId);
      expect(f.scope.nativeResumeOutcomes.get(f.ds)).toMatchObject({state:'failed',errorCode:'native_resume_target_unavailable'});
      expect(f.scope.nativeResumeTargetClaims.size).toBe(0);
    }finally{f.coordinator.reset();}
  });
  it('a success-shaped reply without the actual target identity never lifts the fence', () => {
    const f=fixture();
    try {
      f.run(f.ds,{source:'dashboard',notify:()=>{}},{nativeResumeTarget:requested});
      const handler=loadWorkerPoolMessageHandlers(['restart_result'],{...f.scope,ds:f.ds,worker:f.worker,
        nativeResumeTargetFailure,t:'owned'});
      handler({type:'restart_result',attemptId:'attempt',status:'succeeded',nativeResumeTarget:{sourceId,targetId}});
      expect(f.ds.workerReady).toBe(false);
      expect(f.scope.nativeResumeOutcomes.get(f.ds).state).toBe('failed');
    }finally{f.coordinator.reset();}
  });
});

describe('native replacement with real canonical readiness getters', () => {
  it.each([false, true])('does not confuse its own operation fence with activity (new input=%s)', async intervene => {
    const dir = mkdtempSync(join(tmpdir(), 'native-canonical-ready-'));
    const store = new SessionContractStore(dir, 'cli_native_ready');
    let coordinator: RestartCoordinator | undefined;
    try {
      const worker = { killed: false, send: vi.fn() };
      const ds: any = { larkAppId: 'cli_native_ready', worker, workerGeneration: 1, lastScreenStatus: 'idle',
        initConfig: cfg(), session: { sessionId: 'canonical-ready', status: 'active', cliSessionId: sourceId } };
      const controller = new SessionController(ds, store);
      const producer = controller.bindWorker(1).worker;
      const runtime = controller.reserveBinding('owned-binding', producer);
      controller.bindRuntime('owned-binding', producer, { backend: 'tmux', physicalId: '123:owned-start',
        nativeSessionId: sourceId, proof: 'process_start' });
      const context = (sequence: number, scope: any) => ({ version: 2 as const, session: controller.ref,
        producer, sequence, eventId: `${producer.workerId}:${sequence}`, scope });
      controller.ingest({ type: 'ready', sessionContract: context(1, {}) }, producer);
      controller.ingest({ type: 'prompt_ready', sessionContract: context(2, { runtime }) }, producer);
      expect(ds.workerReady).toBe(true);
      expect(ds.cliReady).toBe(true);
      let flush!: () => void;
      const flushing = new Promise<void>(resolve => { flush = resolve; });
      vi.spyOn(controller, 'flushPrimary').mockReturnValue(flushing);
      coordinator = new RestartCoordinator({ createAttemptId: () => 'owned-operation', persistence: {
        restore: () => undefined,
        record: (_sid, id, phase) => {
          if (phase === 'requested') controller.beginControl('restart', id);
          else if (phase === 'started') { controller.controlStarted(id); return 'started'; }
          else { controller.controlResult(id, phase === 'succeeded' ? 'confirmed' : 'rejected', controller.currentRuntime()); return 'terminal'; }
        },
      } });
      const scope: any = { nativeResumeTargetAllowed, nativeResumeTargetFailure, sameRuntime,
        sandboxEnabled: () => false, isSessionTransferring: () => false, hasProtectedSessionMutationOwnership,
        hasPendingOrdinaryImInput: () => false, hasPendingOrdinaryImDelivery: () => false,
        controllerForSession: () => controller, sessionContractPrimary: () => true,
        isSessionRestartInFlight: () => !!coordinator!.activeAttemptId(ds.session.sessionId),
        restartCoordinator: coordinator, nativeResumeRestartReadiness: new Map(), nativeResumeOutcomes: new WeakMap(),
        topicEffortRestartReadiness: new Map(), restartIpcReason: () => ({ reason: 'operator' }), activeSessionsRegistry: new Map(),
        nativeResumeTargetClaims: new Map(),
        logger: { warn: vi.fn() }, tag: () => 'owned', isSessionLaunchModelBlockedError: () => false };
      scope.hasUnsettledAcceptedInput = loadWorkerPoolFunction('hasUnsettledAcceptedInput', scope);
      scope.nativeResumeTargetConflict = loadWorkerPoolFunction('nativeResumeTargetConflict', scope);
      scope.releaseNativeResumeTargetClaim = loadWorkerPoolFunction('releaseNativeResumeTargetClaim', scope);
      scope.sessionAcceptsDirectCommand = loadWorkerPoolFunction('sessionAcceptsDirectCommand', scope);
      if (process.env.NATIVE_CANONICAL_MUTATION === 'drop-own-operation') {
        const accepts = scope.sessionAcceptsDirectCommand;
        scope.sessionAcceptsDirectCommand = (session: any) => accepts(session);
      }
      const requestRestart = loadWorkerPoolFunction('requestSessionRestart', scope);
      requestRestart(ds, { source: 'dashboard', notify: () => {} }, { nativeResumeTarget: requested });
      expect(ds.workerReady).toBe(false, 'real beginControl masks readiness even though the physical CLI is idle');
      if (intervene) ds.pendingRawInput = { text: 'new human input' };
      flush();
      for (let n = 0; n < 12; n++) await Promise.resolve();
      expect(worker.send).toHaveBeenCalledTimes(intervene ? 0 : 1);
      if (!intervene) {
        expect(worker.send.mock.calls[0][0].nativeResumeTarget).toEqual(requested);
        expect(scope.nativeResumeRestartReadiness.get(ds.session.sessionId)).toMatchObject({ workerReady: true, cliReady: true });
      }
    } finally { coordinator?.reset(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
