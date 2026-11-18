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
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
      sessionContractPrimary:()=>primary,logger:{warn:vi.fn()},tag:()=> 'test'};
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
        topicEffortRestartReadiness: new Map(), restartIpcReason: () => ({ reason: 'operator' }),
        logger: { warn: vi.fn() }, tag: () => 'owned', isSessionLaunchModelBlockedError: () => false };
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
