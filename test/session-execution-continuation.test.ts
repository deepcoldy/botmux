import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { registerSessionContractPrimary } from '../src/core/session-contract-primary.js';
import type { DaemonSession } from '../src/core/types.js';
import type { ExecutionPhase, RuntimeIdentity, RuntimeExecutionContinuation } from '../src/services/session-contract.js';
import { TRAEX_CONTINUATION_BACKENDS } from '../src/services/session-contract.js';
import { TraexAutoModelController, TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT } from '../src/services/traex-auto-model.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import { isRemoteBackendType } from '../src/core/persistent-backend.js';

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];
const identity = (physicalId: string, nativeSessionId = 'native-task'): RuntimeIdentity =>
  ({ backend: 'tmux', physicalId, nativeSessionId, proof: 'process_start' });

function fixture(phase: ExecutionPhase = 'submitting', dispatchAttempt?: number, appId = 'cli_continuation_test') {
  const data = mkdtempSync(join(tmpdir(), 'execution-continuation-')); directories.push(data);
  const ref = { appId, sessionId: 'session-test' };
  const store = new SessionContractStore(data, ref.appId); handles.push(store);
  const ds = { larkAppId: ref.appId, chatId: 'oc_test', cliReadyGeneration: 0,
    session: { sessionId: ref.sessionId, status: 'active', cliId: 'traex' },
    initConfig: { cliId: 'traex', backendType: 'tmux', traexAutoModel: { enabled: true, models: ['one', 'two'] } },
  } as unknown as DaemonSession;
  const controller = new SessionController(ds, store);
  const bootstrap = controller.bindWorker(1);
  const worker = bootstrap.worker;
  const source = controller.reserveBinding('source', worker);
  controller.bindRuntime('source', worker, identity('source:1'));
  const execution = controller.admitInput('ordinary-task', dispatchAttempt);
  store.bindQueuedExecution(ref, execution, source);
  if (phase === 'succeeded' || phase === 'failed' || phase === 'cancelled') {
    store.apply(ref, { type: 'execution_terminal', execution, runtime: source, status: phase, evidence: 'native_terminal' });
  } else if (phase !== 'queued') store.apply(ref, { type: 'execution_phase', execution, runtime: source, phase });
  const request: RuntimeExecutionContinuation = { reason: 'traex-auto-model', execution, from: source, nativeSessionId: 'native-task' };
  const reserve = () => controller.reserveBinding('replacement', worker, request);
  const bind = (value = identity('replacement:2')) => controller.bindRuntime('replacement', worker, value);
  const currentExecution = () => store.execution(ref, execution.executionId)!;
  return { data, ref, store, ds, controller, bootstrap, worker, source, execution, request, reserve, bind, currentExecution };
}
afterEach(() => {
  vi.useRealTimers();
  for (const handle of handles.splice(0)) handle.close();
  for (const data of directories.splice(0)) rmSync(data, { recursive: true, force: true });
});

describe('ordinary execution continuation', () => {
  it.each(['submitting', 'accepted', 'running'] as const)('moves only the admitted execution after native proof (%s)', phase => {
    const s = fixture(phase);
    s.store.apply(s.ref, { type: 'execution_output', execution: s.execution,
      output: { availability: 'available', content: 'completed steps', completeness: 'partial' },
      delivery: { outputId: 'prior-output', status: 'delivered' } });
    const before = s.currentExecution();
    const target = s.reserve();
    expect(s.currentExecution().runtime).toEqual(s.source);
    s.bind();
    expect(s.currentExecution()).toMatchObject({ ref: s.execution, runtime: target, phase: 'accepted',
      output: before.output, deliveries: before.deliveries });
    expect(s.store.executionContinuation(s.ref, 'replacement')).toEqual({ execution: s.execution, status: 'approved' });
    s.store.apply(s.ref, { type: 'execution_phase', execution: s.execution, runtime: target, phase: 'submitting' });
    s.bind();
    expect(s.currentExecution().phase).toBe('submitting');
    const stale = s.store.apply(s.ref, { type: 'execution_terminal', execution: s.execution,
      runtime: s.source, status: 'succeeded', evidence: 'late_native_terminal' });
    expect(stale.decision).toBe('stale');
    expect(s.currentExecution().terminal).toBeUndefined();
  });

  it.each(['queued', 'waiting_input', 'blocked', 'reconciling', 'succeeded', 'failed', 'cancelled'] as const)(
    'does not turn %s state into permission to replay', phase => {
      const s = fixture(phase);
      expect(s.reserve).toThrow('execution_continuation_unproven');
      expect(s.store.binding(s.ref, 'replacement')).toBeUndefined();
      expect(s.currentExecution().runtime).toEqual(s.source);
    });

  it.each(['worker', 'native', 'execution', 'durable', 'overlap', 'unsupported', 'unsupported-backend'] as const)(
    'rejects an unproven continuation source (%s)', condition => {
      const s = fixture('submitting', condition === 'durable' ? 1 : undefined);
      if (condition === 'native') s.request.nativeSessionId = 'another-native';
      if (condition === 'execution') s.request.execution = { executionId: 'unknown', turnId: 'unknown' };
      if (condition === 'overlap') {
        const other = s.controller.admitInput('other-task');
        s.store.bindQueuedExecution(s.ref, other, s.source);
        s.store.apply(s.ref, { type: 'execution_phase', execution: other, runtime: s.source, phase: 'submitting' });
      }
      if (condition === 'unsupported') s.ds.initConfig!.cliId = 'codex';
      // zmx is a selectable local backend but cannot prove a botmux-owned
      // process; the Worker gate shares this same backend set.
      if (condition === 'unsupported-backend') s.ds.initConfig!.backendType = 'zmx';
      expect(() => condition === 'worker'
        ? s.controller.reserveBinding('replacement', { workerId: 'foreign', generation: 2 }, s.request)
        : s.reserve()).toThrow();
      expect(s.currentExecution().runtime).toEqual(s.source);
    });

  it('does not complete the grant until a native identity is available', () => {
    const s = fixture(); const target = s.reserve();
    s.bind({ backend: 'tmux', physicalId: 'replacement:2', proof: 'process_start' });
    expect(s.store.executionContinuation(s.ref, 'replacement')).toBeUndefined();
    expect(s.currentExecution().runtime).toEqual(s.source);
    s.bind();
    expect(s.currentExecution().runtime).toEqual(target);
  });

  it('refuses a different native conversation after the process is bound', () => {
    const s = fixture(); s.reserve(); s.bind(identity('replacement:2', 'different-native'));
    expect(s.store.executionContinuation(s.ref, 'replacement')?.status).toBe('rejected');
    expect(s.currentExecution().runtime).toEqual(s.source);
  });

  it.each(['cancel', 'terminal', 'policy'] as const)('does not grant after an intervening %s', condition => {
    const s = fixture(); s.reserve();
    if (condition === 'cancel') {
      const operation = s.controller.beginControl('cancel', 'user-cancel', s.execution).operation;
      s.controller.controlStarted(operation.operationId);
      s.controller.controlResult(operation.operationId, 'confirmed', s.source);
    } else if (condition === 'terminal') {
      s.store.apply(s.ref, { type: 'execution_terminal', execution: s.execution,
        runtime: s.source, status: 'succeeded', evidence: 'native_terminal' });
    } else s.ds.initConfig!.traexAutoModel!.enabled = false;
    s.bind();
    expect(s.store.executionContinuation(s.ref, 'replacement')?.status).toBe('rejected');
    expect(s.currentExecution().runtime).toEqual(s.source);
  });

  it('keeps the proven process and retries a failed permission transaction', () => {
    const s = fixture(); const target = s.reserve();
    const db = openDatabaseSyncOrThrow(s.store.filename); handles.push(db);
    db.exec("CREATE TRIGGER fail_continuation BEFORE INSERT ON events WHEN NEW.type='execution_continued' BEGIN SELECT RAISE(ABORT,'continuation_write_failed'); END");
    expect(s.bind).toThrow('continuation_write_failed');
    expect(s.store.binding(s.ref, 'replacement')?.identity).toEqual(identity('replacement:2'));
    expect(s.controller.currentRuntime()).toEqual(target);
    expect(s.currentExecution().runtime).toEqual(s.source);
    expect(s.store.executionContinuation(s.ref, 'replacement')).toBeUndefined();
    db.exec('DROP TRIGGER fail_continuation');
    s.bind();
    expect(s.currentExecution().runtime).toEqual(target);
    expect(s.store.executionContinuation(s.ref, 'replacement')?.status).toBe('approved');
  });

  it('does not make the original input runnable after an approved-window worker restart', () => {
    const s = fixture(); s.reserve(); s.bind();
    const restartedDs = { ...s.ds, session: structuredClone(s.ds.session) };
    handles.splice(handles.indexOf(s.store), 1); s.store.close();
    const reopened = new SessionContractStore(s.data, s.ref.appId); handles.push(reopened);
    const controller = new SessionController(restartedDs, reopened);
    const bootstrap = controller.bindWorker(2);
    const scope = new WorkerSessionEventScope(s.ref, bootstrap.worker);
    for (const state of bootstrap.executions ?? []) scope.noteAdmission(state);
    const binding = scope.beginRuntime();
    controller.reserveBinding(binding.bindingId, bootstrap.worker);
    const runtime = controller.bindRuntime(binding.bindingId, bootstrap.worker, identity('replacement:2'));
    binding.identity = identity('replacement:2'); scope.assign(binding.bindingId, runtime.ref);
    scope.rememberExecution(s.execution, binding);
    expect(scope.canSubmit(s.execution.turnId, undefined, s.execution)).toBe(false);
    expect(scope.canSubmitContinuation(s.execution.turnId, s.execution)).toBe(false);
  });

  it.each([true, false])('distinguishes a late planned teardown from a genuine exit (planned=%s)', async planned => {
    vi.useFakeTimers();
    const s = fixture('accepted');
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const source = scope.beginRuntime(); source.identity = identity('source:1'); scope.assign(source.bindingId, s.source);
    scope.rememberExecution(s.execution, source);
    const oldBackend = {};
    const sent: any[] = [];
    const env: any = { backend: oldBackend, intentionalRestartBackend: planned ? oldBackend : undefined,
      intentionallyRetiredBackends: new WeakSet(), workerSessionEventScope: scope, bindSessionRuntimeCallback: (callback: any) => scope.bind(callback),
      send: (message: any) => sent.push(metadata(message)) };
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    const bindExit = loadWorkerFunction<(callback: any) => (...args: any[]) => void>('bindSessionBackendExit', env);
    const exit = scope.run(source, () => bindExit(() => { throw new Error('stale current callback'); }));
    s.reserve(); env.backend = {};
    setTimeout(() => exit(0), 200);
    if (planned) setTimeout(() => exit(0), 250);
    setTimeout(() => s.bind(), 500);
    await vi.advanceTimersByTimeAsync(200);
    if (planned) expect(sent).toEqual([]);
    else { expect(sent).toHaveLength(1); s.controller.ingest(sent[0], s.worker); }
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(planned ? 0 : 1);
    expect(s.store.executionContinuation(s.ref, 'replacement')?.status).toBe(planned ? 'approved' : 'rejected');
    expect(s.currentExecution().phase).toBe(planned ? 'accepted' : 'reconciling');
  });

  it.each([false, true])('checkpoints revocation atomically and keeps retries idempotent (failVersionWrite=%s)', async failVersionWrite => {
    vi.useFakeTimers();
    const s = fixture('submitting', undefined, `cli_continuation_primary_${failVersionWrite}`);
    s.reserve(); s.bind(); s.ds.session.rootMessageId = 'om_primary_test';
    let primary: any = { value: { type: 'botmux.session.primary', session: structuredClone(s.ds.session) } };
    let writes = 0;
    registerSessionContractPrimary(s.ref.appId, { writeExactFromCurrent: async (_key: string, update: any) => {
      primary = { value: structuredClone(update(primary)) }; writes++; return { kind: 'written' };
    } } as any, () => { throw new Error('unexpected primary fence'); });
    await s.controller.flushPrimary();
    const approvedRevision = s.store.read(s.ref)!.revision;
    await vi.advanceTimersByTimeAsync(100);
    s.ds.initConfig!.traexAutoModel!.enabled = false;
    if (failVersionWrite) {
      const db = openDatabaseSyncOrThrow(s.store.filename); handles.push(db);
      db.exec("CREATE TRIGGER fail_version BEFORE UPDATE ON contracts BEGIN SELECT RAISE(ABORT,'version_write_failed'); END");
      expect(s.bind).toThrow('version_write_failed');
      expect(s.store.executionContinuation(s.ref, 'replacement')?.status).toBe('approved');
      expect(s.store.read(s.ref)!.revision).toBe(approvedRevision);
      db.exec('DROP TRIGGER fail_version');
    }
    s.bind();
    expect(s.store.executionContinuation(s.ref, 'replacement')?.status).toBe('rejected');
    const rejectedRevision = s.store.read(s.ref)!.revision;
    expect(rejectedRevision).toBeGreaterThan(approvedRevision);
    await s.controller.flushPrimary(); expect(writes).toBe(2);
    s.bind(); await s.controller.flushPrimary();
    expect(s.store.read(s.ref)!.revision).toBe(rejectedRevision); expect(writes).toBe(2);
    const restartedDs = { ...s.ds, session: structuredClone(primary.value.session) };
    handles.splice(handles.indexOf(s.store), 1); s.store.close();
    const reopened = new SessionContractStore(s.data, s.ref.appId); handles.push(reopened);
    const restarted = new SessionController(restartedDs, reopened);
    expect(restarted.store.executionContinuation(s.ref, 'replacement')?.status).toBe('rejected');
    expect(restarted.store.read(s.ref)!.revision).toBe(rejectedRevision);
  });

  it('preserves an unused permit across physical CLI enrichment and then rotates again', () => {
    const s = fixture(); const target = s.reserve(); s.bind();
    const enriched = s.controller.reserveBinding('enriched', s.worker);
    s.controller.bindRuntime('enriched', s.worker, identity('leaf:2'), undefined, 'replacement');
    expect(s.store.executionContinuation(s.ref, 'enriched')?.status).toBe('approved');
    expect(s.currentExecution().runtime).toEqual(target);
    expect(s.store.continuedExecution(s.ref, target, s.worker, s.execution)).toBe(true);
    s.store.apply(s.ref, { type: 'execution_phase', execution: s.execution, runtime: target, phase: 'accepted' });
    const next = { ...s.request, from: enriched };
    const final = s.controller.reserveBinding('final', s.worker, next);
    s.controller.bindRuntime('final', s.worker, identity('final:3'));
    expect(s.currentExecution().runtime).toEqual(final);
  });
});

function scopedFixture() {
  const s = fixture();
  const scope = new WorkerSessionEventScope(s.ref, s.worker);
  const source = scope.beginRuntime(); source.identity = identity('source:1'); scope.assign(source.bindingId, s.source);
  scope.rememberExecution(s.execution, source);
  scope.noteAdmission({ ref: s.execution, runtime: s.source, phase: 'submitting' });
  scope.run(source, () => scope.recordSubmission(s.execution.turnId));
  const target = s.reserve(); s.bind();
  const replacement = scope.beginRuntime(); replacement.identity = identity('replacement:2'); scope.assign(replacement.bindingId, target);
  const admission = { ref: s.execution, runtime: target, phase: 'accepted' as const };
  return { ...s, scope, sourceBinding: source, replacement, admission };
}
describe('worker continuation permits', () => {
  it('grants one internal submission without opening ordinary duplicate admission', () => {
    const s = scopedFixture();
    expect(s.scope.acceptContinuation(s.replacement.bindingId, s.admission)).toBe(true);
    expect(s.scope.canSubmit(s.execution.turnId)).toBe(false);
    expect(s.scope.canSubmitContinuation(s.execution.turnId, s.execution)).toBe(true);
    s.scope.enterContinuation(s.execution.turnId, s.execution);
    s.scope.recordSubmission(s.execution.turnId);
    expect(s.scope.canSubmitContinuation(s.execution.turnId, s.execution)).toBe(false);
    expect(s.scope.canSubmit(s.execution.turnId)).toBe(false);
    expect(s.scope.acceptContinuation(s.replacement.bindingId, s.admission)).toBe(false);
  });

  it.each(['old-process', 'old-runtime', 'cancelled', 'wrong-execution', 'durable'] as const)(
    'does not accept a stale or unrelated permit (%s)', condition => {
      const s = scopedFixture();
      let admission = s.admission;
      if (condition === 'old-process') { const current = s.scope.beginRuntime(); s.scope.assign(current.bindingId, { runtimeId: 'newest', epoch: 3 }); }
      if (condition === 'old-runtime') admission = { ...admission, runtime: s.source };
      if (condition === 'cancelled') s.scope.noteAdmission({ ...admission, phase: 'cancelled' });
      if (condition === 'wrong-execution') admission = { ...admission, ref: { executionId: 'other', turnId: 'other' } };
      if (condition === 'durable') admission = { ...admission, ref: { ...admission.ref, dispatchAttempt: 1 } };
      expect(s.scope.acceptContinuation(s.replacement.bindingId, admission)).toBe(false);
      expect(s.scope.canSubmit(s.execution.turnId)).toBe(false);
    });

  it.each([false, true])('handles a same-process rebind without trusting a changed native session (changed=%s)', changed => {
    const s = scopedFixture();
    expect(s.scope.acceptContinuation(s.replacement.bindingId, s.admission)).toBe(true);
    const enriched = s.scope.beginRuntime(undefined, s.replacement.physicalId);
    enriched.identity = identity('leaf:2', changed ? 'other-native' : 'native-task');
    s.scope.assign(enriched.bindingId, { runtimeId: 'enriched', epoch: 3 });
    expect(s.scope.canSubmitContinuation(s.execution.turnId, s.execution)).toBe(!changed);
    if (!changed) {
      s.scope.enterContinuation(s.execution.turnId, s.execution);
      expect(s.scope.contextBinding()).toBe(s.replacement);
      expect(s.scope.isCurrentContext()).toBe(true);
    }
    expect(s.scope.run(s.sourceBinding, () => s.scope.isCurrentContext())).toBe(false);
  });
});

// The host grants continuations only on TRAEX_CONTINUATION_BACKENDS and only
// after bootstrap negotiation. That gate belongs to resuming the current turn:
// preflight / new-turn selection never carry a continuation and must keep
// working on other local backends (zmx) and against an older host.
describe('worker continuation gate', () => {
  function gate(backendType: string, hostGrants: boolean) {
    const s = fixture();
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const source = scope.beginRuntime(); source.identity = identity('source:1'); scope.assign(source.bindingId, s.source);
    scope.rememberExecution(s.execution, source);
    const controller = new TraexAutoModelController({ enabled: true, models: ['one', 'two'], queueTimeoutMs: 5000 });
    controller.beginTurn(s.execution.turnId);
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: s.execution.turnId }); authority.markStarted({ turnId: s.execution.turnId });
    const env: Record<string, any> = {
      traexAutoModelController: controller, codexRpcEngine: null, effectiveBackendType: backendType,
      isRemoteBackendType, TRAEX_CONTINUATION_BACKENDS, TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT,
      lastInitConfig: { cliId: 'traex', cliSessionId: 'native-task', model: 'one',
        ...(hostGrants ? { sessionContract: { ...s.bootstrap } } : { sessionContract: { ...s.bootstrap, executionContinuations: undefined } }) },
      workerSessionEventScope: scope, activeTurnAuthority: authority, inflightInputs: new InflightInputTracker(),
      pendingMessages: [] as any[], currentBotmuxCallerOpenId: 'caller', traexAutoModelTurnReplayForbidden: false,
      currentInputDeliveryQuarantine: () => null, traexAutoModelSwitching: false, cliRestartInProgress: false, isFlushing: false,
      applyTraexAutoModelSettings: (cfg: any, _pool: unknown, model: string) => { cfg.model = model; },
      restartCliProcess: vi.fn(async () => {}), send: vi.fn(), log: vi.fn(), t: (key: string) => key,
    };
    env.traexAutoModelRuntimeEligible = loadWorkerFunction<() => boolean>('traexAutoModelRuntimeEligible', env);
    env.enqueueTraexAutoModelRecovery = loadWorkerFunction('enqueueTraexAutoModelRecovery', env);
    const execute = loadWorkerFunction<(action: any, opts: { resumeCurrentTurn: boolean }) => boolean>('executeTraexAutoModelSwitch', env);
    const action = (reason: string) => ({ kind: 'switch', turnId: s.execution.turnId, fromModel: 'one', toModel: 'two', toIndex: 1, reason });
    return { s, env, controller, execute, action };
  }

  it.each([['zmx', true], ['tmux', false]] as const)(
    'keeps Auto eligible but never resumes the current turn without a grant (%s, host grants=%s)', (backendType, hostGrants) => {
      const g = gate(backendType, hostGrants);
      expect(g.env.traexAutoModelRuntimeEligible()).toBe(true);
      expect(g.execute(g.action('capacity_timeout'), { resumeCurrentTurn: true })).toBe(false);
      expect(g.controller.currentModel()).toBe('one');
      expect(g.env.pendingMessages).toEqual([]);
      expect(g.env.restartCliProcess).not.toHaveBeenCalled();
      // An independent-turn selection carries no continuation and still runs.
      expect(g.execute(g.action('preflight_available'), { resumeCurrentTurn: false })).toBe(true);
      expect(g.env.restartCliProcess).toHaveBeenCalledOnce();
      expect(g.env.restartCliProcess.mock.calls[0][1]).not.toHaveProperty('restartCause');
    });

  it('resumes the current turn with a continuation on a granting host and backend', () => {
    const g = gate('tmux', true);
    expect(g.execute(g.action('capacity_timeout'), { resumeCurrentTurn: true })).toBe(true);
    expect(g.env.restartCliProcess.mock.calls[0][1]).toMatchObject({ restartCause: 'traex-auto-model', exactResumeSessionId: 'native-task' });
    expect(g.env.pendingMessages).toHaveLength(1);
    expect(g.env.pendingMessages[0]).toMatchObject({ traexAutoModelRecovery: true,
      traexAutoModelContinuation: { reason: 'traex-auto-model', execution: g.s.execution, from: g.s.source, nativeSessionId: 'native-task' } });
  });
});
