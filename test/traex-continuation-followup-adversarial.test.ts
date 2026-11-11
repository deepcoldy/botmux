import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import type { DaemonSession } from '../src/core/types.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { persistTurnTerminal } from '../src/services/turn-completion-events.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { sameExecution, sameRuntime, sameWorker, TRAEX_CONTINUATION_BACKENDS, type RuntimeExecutionContinuation } from '../src/services/session-contract.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { TraexAutoModelController, TRAEX_AUTO_MODEL_CONTINUATION_GRANT_TIMEOUT_MS } from '../src/services/traex-auto-model.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import { isRemoteBackendType } from '../src/core/persistent-backend.js';
import { createHash } from 'node:crypto';
import { addTurnNotice } from '../src/services/ordinary-recovery-notice.js';
import { registerSessionContractPrimary } from '../src/core/session-contract-primary.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure, loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(mode: 'planned' | 'approved' | 'unreserved' = 'approved', appId = 'cli_adversarial_continuation') {
  const directory = mkdtempSync(join(tmpdir(), 'traex-followup-adversarial-'));
  directories.push(directory);
  const ref = { appId, sessionId: 'independent-review' };
  const store = new SessionContractStore(directory, ref.appId);
  handles.push(store);
  const ds = {
    larkAppId: ref.appId, chatId: 'oc_test', cliReadyGeneration: 0,
    session: { sessionId: ref.sessionId, status: 'active', cliId: 'traex' },
    initConfig: { cliId: 'traex', backendType: 'tmux', traexAutoModel: { enabled: true, models: ['first', 'second'] } },
  } as unknown as DaemonSession;
  const controller = new SessionController(ds, store);
  const worker = controller.bindWorker(1).worker;
  const scope = new WorkerSessionEventScope(ref, worker);
  const source = scope.beginRuntime();
  source.identity = { backend: 'tmux', physicalId: 'source:1', nativeSessionId: 'native', proof: 'process_start' };
  const sourceRuntime = controller.reserveBinding(source.bindingId, worker);
  controller.bindRuntime(source.bindingId, worker, source.identity);
  scope.assign(source.bindingId, sourceRuntime);
  const execution = controller.admitInput('om_original');
  store.bindQueuedExecution(ref, execution, sourceRuntime);
  store.apply(ref, { type: 'execution_phase', execution, runtime: sourceRuntime, phase: 'submitting' });
  scope.noteAdmission({ ref: execution, runtime: sourceRuntime, phase: 'submitting' });
  scope.rememberExecution(execution, source);
  scope.run(source, () => scope.recordSubmission(execution.turnId));
  const continuation: RuntimeExecutionContinuation = {
    reason: 'traex-auto-model', execution, from: sourceRuntime, nativeSessionId: 'native',
  };
  const replacement = scope.beginRuntime();
  replacement.continuation = continuation;
  replacement.identity = { backend: 'tmux', physicalId: 'replacement:2', nativeSessionId: 'native', proof: 'process_start' };
  if (mode !== 'unreserved') {
    const target = controller.reserveBinding(replacement.bindingId, worker, continuation);
    scope.assign(replacement.bindingId, target);
    if (mode === 'approved') controller.bindRuntime(replacement.bindingId, worker, replacement.identity);
  } else {
    scope.restoreAfterAbortedStart(replacement, source);
  }
  const successor = controller.admitInput('om_successor');
  scope.noteAdmission({ ref: successor, phase: 'queued' });
  const harness = workerSubmitHarness();
  const env = harness.scope;
  env.pendingMessages.splice(0, env.pendingMessages.length,
    { content: 'internal recovery', turnId: execution.turnId, traexAutoModelRecovery: true, traexAutoModelContinuation: continuation },
    { content: 'ordinary successor', turnId: successor.turnId });
  const sent: any[] = [];
  const delivered: any[] = [];
  const errors: unknown[] = [];
  const inflight: Promise<void>[] = [];
  Object.assign(env, {
    sessionId: ref.sessionId, workerSessionEventScope: scope, sameExecution, sameRuntime,
    TRAEX_AUTO_MODEL_CONTINUATION_GRANT_TIMEOUT_MS,
    traexAutoModelTurnReplayForbidden: false,
    traexAutoModelController: { endTurn: vi.fn(), currentTurnId: () => execution.turnId, currentModel: () => 'second',
      awaitingModelActivity: () => false, awaitingPreferredModelReset: () => false },
    emittedTurnTerminals: new TurnTerminalDeduper(),
    cancelSubmitFailureChainForTerminal: vi.fn(),
    turnExecutionClock: { settle: () => undefined, forget: vi.fn() },
    releaseActiveTurnAuthority: () => true,
    retireTerminatedQueuedTurn: vi.fn(), terminalReleasesDurableTurn: () => false,
    currentBotmuxTurnId: execution.turnId, currentBotmuxDispatchAttempt: undefined,
    runtimeIdentityForContract: (binding: any) => binding.identity,
    traexContinuationGrantRecheckAt: 0,
    traexAutoModelRuntimeEligible: () => true, admitTraexAutoModelPendingInput: async () => true,
    stopBridgeWatcher: vi.fn(), stopScreenshotLoop: vi.fn(), killCli: vi.fn(),
    armRetiredRuntimeExit: vi.fn(),
  });
  const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
  const receive = loadWorkerMessageHandler('runtime_contract_assigned', env);
  const receiveFailureAck = loadWorkerMessageHandler('continuation_failure_ack', env);
  const receiveAbortAck = loadWorkerMessageHandler('runtime_binding_aborted_ack', env);
  const child = { send: vi.fn((message: any) => {
    if (message.type === 'runtime_contract_assigned') inflight.push(receive(message).catch(error => { errors.push(error); }));
    if (message.type === 'continuation_failure_ack') inflight.push(receiveFailureAck(message).catch(error => { errors.push(error); }));
    if (message.type === 'runtime_binding_aborted_ack') inflight.push(receiveAbortAck(message).catch(error => { errors.push(error); }));
  }) };
  ds.worker = child as any;
  const hostEnv: Record<string, any> = {
    sessionController: controller, contractWorker: worker, ds, worker: child, sameWorker,
    logger: { warn: vi.fn(), debug: vi.fn() }, t: ref.sessionId,
    handleLegacyWorkerMessage: async (message: any) => { delivered.push(message); },
    cb: { onTurnTerminal: async (_session: unknown, message: any) => { delivered.push(message); } },
    enqueueContinuationFailureNotice: (_session: unknown, failure: any) => {
      if (failure.notice) delivered.push({ type: 'user_notify', message: failure.notice });
    },
  };
  const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostEnv);
  hostEnv.handleWorkerMessage = host;
  env.send = (message: any) => {
    const payload = metadata(message);
    sent.push(payload);
    inflight.push(host(payload).catch(error => { errors.push(error); }));
  };
  env.emitTurnTerminal = loadWorkerFunction('emitTurnTerminal', env);
  env.clearTraexContinuationGrantWait = loadWorkerFunction('clearTraexContinuationGrantWait', env);
  env.armTraexContinuationGrantWait = loadWorkerFunction('armTraexContinuationGrantWait', env);
  env.abandonTraexAutoModelContinuation = loadWorkerFunction('abandonTraexAutoModelContinuation', env);
  env.publishRuntimeContract = loadWorkerFunction('publishRuntimeContract', env);
  env.flushPending = vi.fn(async () => {});
  env.retryTraexAutoModelAdmission = loadWorkerFunction('retryTraexAutoModelAdmission', env);
  const settle = async () => {
    for (let index = 0; index < inflight.length; index++) await inflight[index];
  };
  const abandon = (reason: 'timeout' | 'rejected' = 'timeout') =>
    env.abandonTraexAutoModelContinuation(continuation, replacement.bindingId, reason) as boolean;
  const failure = (bindingId = replacement.bindingId) => scope.run(source, () => metadata({
    type: 'turn_terminal', sessionId: ref.sessionId, turnId: execution.turnId, status: 'failed',
    errorCode: 'traex_auto_model_continuation_timeout', continuationFailure: { bindingId, continuation },
  }), execution);
  const approval = () => ({
    type: 'runtime_contract_assigned', bindingId: replacement.bindingId, runtime: replacement.runtime, mayExecute: true,
    continuation: { status: 'approved', execution },
    admissionStates: [{ ref: execution, runtime: replacement.runtime, phase: 'accepted' }],
  });
  return { directory, ref, store, controller, worker, scope, source, replacement, execution, successor,
    continuation, env, harness, sent, delivered, errors, settle, abandon, failure, approval, receive, host, hostEnv, child };
}

describe('independent continuation follow-up adversarial probes', () => {
  it('retransmits a lost ACK without repeating terminal effects and stops after the matching ACK', async () => {
    vi.useFakeTimers();
    const state = fixture();
    const originalSend = state.child.send.getMockImplementation()!;
    state.child.send.mockImplementation(message => {
      if (message.type !== 'continuation_failure_ack') originalSend(message);
    });
    state.abandon();
    await state.settle();
    const acknowledge = loadWorkerMessageHandler('continuation_failure_ack', state.env);
    await acknowledge({ type: 'continuation_failure_ack', bindingId: state.replacement.bindingId, execution: state.successor });
    await vi.advanceTimersByTimeAsync(3_100);
    await state.settle();
    expect(state.sent.filter(message => message.type === 'turn_terminal').length).toBeGreaterThan(1);
    expect(state.delivered.filter(message => message.type === 'turn_terminal')).toHaveLength(1);
    expect(state.delivered.filter(message => message.type === 'user_notify')).toHaveLength(1);
    await acknowledge({ type: 'continuation_failure_ack', bindingId: state.replacement.bindingId, execution: state.execution });
    const sentCount = state.sent.length;
    await vi.advanceTimersByTimeAsync(3_100);
    expect(state.sent).toHaveLength(sentCount);
  });

  it('keeps business completion idempotent after receipt-write failure followed by host restart', async () => {
    vi.useFakeTimers();
    const state = fixture();
    let consumer = await SkillFeedbackStore.open(state.directory);
    handles.push(consumer);
    consumer.recordTurnDelivery({
      botAppId: state.ref.appId, sessionId: state.ref.sessionId, turnId: state.execution.turnId,
      platform: 'lark', platformAppId: state.ref.appId, platformMessageId: 'om_failure_notice',
      chatId: 'oc_test', content: 'continuation failed', cliId: 'traex', cardMode: 'feedback', status: 'delivered',
    });
    const consume = async (message: any) => {
      state.delivered.push(message);
      await persistTurnTerminal({
        dataDir: state.directory, botAppId: state.ref.appId, session: state.controller.ds.session,
        terminal: message, store: consumer,
      });
    };
    state.hostEnv.handleLegacyWorkerMessage = async (message: any) => {
      if (message.type === 'turn_terminal') await consume(message);
      else state.delivered.push(message);
    };
    state.hostEnv.cb.onTurnTerminal = async (_session: unknown, message: any) => consume(message);
    const database = openDatabaseSyncOrThrow(state.store.filename);
    handles.push(database);
    database.exec("CREATE TRIGGER adversarial_receipt BEFORE INSERT ON entities WHEN NEW.kind='continuation_failure_delivery' BEGIN SELECT RAISE(ABORT,'adversarial_receipt_failure'); END");
    state.abandon();
    await state.settle();
    expect(state.errors.map(String)).toEqual([expect.stringContaining('adversarial_receipt_failure')]);
    expect(state.delivered.filter(message => message.type === 'turn_terminal')).toHaveLength(1);
    expect(consumer.listTurnCompletionEvents()).toHaveLength(1);
    database.exec('DROP TRIGGER adversarial_receipt');
    const reopened = new SessionContractStore(state.directory, state.ref.appId);
    handles.push(reopened);
    state.hostEnv.sessionController = new SessionController(state.controller.ds, reopened);
    handles.splice(handles.indexOf(consumer), 1);
    consumer.close();
    consumer = await SkillFeedbackStore.open(state.directory);
    handles.push(consumer);
    await vi.advanceTimersByTimeAsync(1_100);
    await state.settle();
    expect(reopened.continuationFailureDelivered(state.ref, state.execution, 'traex_auto_model_continuation_timeout')).toBe(true);
    expect(state.delivered.filter(message => message.type === 'turn_terminal')).toHaveLength(2);
    expect(consumer.listTurnCompletionEvents()).toHaveLength(1);
    expect(consumer.listTurnCompletionEvents()[0].payload.status).toBe('failed');
    expect(state.scope.canSubmit(state.execution.turnId)).toBe(false);
    expect(state.scope.canSubmitContinuation(state.execution.turnId, state.execution)).toBe(false);
  });

  it('retries a failed primary receipt checkpoint without redelivering its terminal effects', async () => {
    const state = fixture('approved', 'cli_adversarial_primary_retry');
    state.controller.ds.session.rootMessageId = 'om_primary';
    let primary: any = { value: { type: 'botmux.session.primary', session: structuredClone(state.controller.ds.session) } };
    let unavailable = true;
    registerSessionContractPrimary(state.ref.appId, {
      writeExactFromCurrent: async (_key: string, update: any) => {
        if (unavailable) throw new Error('adversarial_primary_failure');
        primary = { value: structuredClone(update(primary)) };
        return { kind: 'written' };
      },
    } as any, () => {});
    state.controller.ingest(state.failure(), state.worker);
    const deliver = vi.fn(async () => {});
    await expect(state.controller.deliverContinuationFailure(state.execution, 'traex_auto_model_continuation_timeout', deliver))
      .rejects.toThrow('adversarial_primary_failure');
    unavailable = false;
    await state.controller.deliverContinuationFailure(state.execution, 'traex_auto_model_continuation_timeout', deliver);
    expect(deliver).toHaveBeenCalledOnce();
    expect(primary.value.session.sessionRuntimeContract.session.revision).toBe(state.store.read(state.ref)!.revision);
  });

  it('retries durable notice enqueue failure before issuing a completion ACK', async () => {
    vi.useFakeTimers();
    const state = fixture();
    const database = openDatabaseSyncOrThrow(join(state.directory, 'notice-probe.sqlite'));
    handles.push(database);
    database.exec('CREATE TABLE notices (id INTEGER PRIMARY KEY, payload TEXT)');
    database.exec("CREATE TRIGGER notice_unavailable BEFORE INSERT ON notices BEGIN SELECT RAISE(ABORT,'adversarial_notice_failure'); END");
    const resume = vi.fn(() => {
      expect(database.prepare('SELECT payload FROM notices WHERE id=1').get()).toBeDefined();
    });
    state.hostEnv.enqueueContinuationFailureNotice = loadWorkerPoolFunction('enqueueContinuationFailureNotice', {
      createHash, addTurnNotice, resumeTurnNotices: resume,
      sessionStore: { updateSession: (session: unknown) =>
        database.prepare('INSERT OR REPLACE INTO notices VALUES (1,?)').run(JSON.stringify(session)) },
    });
    state.abandon();
    await state.settle();
    expect(state.errors.map(String)).toEqual([expect.stringContaining('adversarial_notice_failure')]);
    expect(state.controller.ds.session.turnNotices).toBeUndefined();
    expect(state.child.send.mock.calls.some(([message]) => message.type === 'continuation_failure_ack')).toBe(false);
    database.exec('DROP TRIGGER notice_unavailable');
    await vi.advanceTimersByTimeAsync(1_100);
    await state.settle();
    expect(state.controller.ds.session.turnNotices).toHaveLength(1);
    expect(resume).toHaveBeenCalledOnce();
    expect(state.delivered.filter(message => message.type === 'turn_terminal')).toHaveLength(1);
    expect(state.child.send.mock.calls.some(([message]) => message.type === 'continuation_failure_ack')).toBe(true);
  });

  it.each(['quarantine', 'grant', 'runtime', 'scope', 'removed-input'] as const)(
    'fences an armed grant deadline across %s changes', async change => {
      vi.useFakeTimers();
      const state = fixture();
      state.env.armTraexContinuationGrantWait();
      if (change === 'quarantine') {
        state.env.currentInputDeliveryQuarantine = () => ({ blocked: true });
        state.env.isPromptReady = false;
      }
      if (change === 'grant') await state.receive(state.approval());
      if (change === 'runtime') state.scope.beginRuntime('human-restart');
      if (change === 'scope') state.env.workerSessionEventScope = new WorkerSessionEventScope(state.ref, state.worker);
      if (change === 'removed-input') state.env.pendingMessages.shift();
      await vi.advanceTimersByTimeAsync(2 * TRAEX_AUTO_MODEL_CONTINUATION_GRANT_TIMEOUT_MS);
      await state.settle();
      expect(state.errors).toEqual([]);
      expect(state.sent.filter(message => message.type === 'turn_terminal')).toHaveLength(change === 'quarantine' ? 1 : 0);
      expect(state.scope.canSubmit(state.successor.turnId)).toBe(true);
    });

  it.each(['planned', 'approved', 'unreserved'] as const)('settles once and preserves successors after %s abandonment', async mode => {
    vi.useFakeTimers();
    const state = fixture(mode);
    expect(state.abandon()).toBe(true);
    expect(state.abandon()).toBe(false);
    await state.settle();
    expect(state.errors).toEqual([]);
    expect(state.sent.filter(message => message.type === 'turn_terminal')).toHaveLength(1);
    expect(state.delivered.filter(message => message.type === 'turn_terminal')).toHaveLength(1);
    expect(state.delivered.filter(message => message.type === 'user_notify')).toHaveLength(1);
    expect(state.store.execution(state.ref, state.execution.executionId)?.phase).toBe('failed');
    expect(state.env.pendingMessages.map((message: any) => message.turnId)).toEqual([state.successor.turnId]);
    expect(state.scope.canSubmit(state.execution.turnId)).toBe(false);
    expect(state.scope.canSubmit(state.successor.turnId)).toBe(true);
    state.env.flushPending = vi.fn(async () => {});
    if (mode === 'approved') {
      await state.receive(state.approval());
      await state.receive(state.approval());
      expect(state.scope.canSubmitContinuation(state.execution.turnId, state.execution)).toBe(false);
    }
  });

  it('retries the terminal after a transient second persistence write fails', async () => {
    vi.useFakeTimers();
    const state = fixture();
    const database = openDatabaseSyncOrThrow(state.store.filename);
    handles.push(database);
    database.exec("CREATE TRIGGER adversarial_failure BEFORE INSERT ON entities WHEN NEW.kind='execution_continuation' AND NEW.phase='rejected' BEGIN SELECT RAISE(ABORT,'adversarial_write_failure'); END");
    state.abandon();
    await state.settle();
    expect(state.errors.map(String)).toEqual([expect.stringContaining('adversarial_write_failure')]);
    expect(state.store.execution(state.ref, state.execution.executionId)?.phase).toBe('accepted');
    database.exec('DROP TRIGGER adversarial_failure');
    await vi.advanceTimersByTimeAsync(2 * TRAEX_AUTO_MODEL_CONTINUATION_GRANT_TIMEOUT_MS);
    state.abandon();
    await state.settle();
    expect(state.sent.filter(message => message.type === 'turn_terminal').length).toBeGreaterThan(1);
    expect(state.delivered.filter(message => message.type === 'turn_terminal')).toHaveLength(1);
    expect(state.scope.canSubmit(state.execution.turnId)).toBe(false);
    expect(state.scope.canSubmitContinuation(state.execution.turnId, state.execution)).toBe(false);
    expect(state.env.pendingMessages.map((message: any) => message.turnId)).toEqual([state.successor.turnId]);
    const reopened = new SessionContractStore(state.directory, state.ref.appId);
    handles.push(reopened);
    expect({
      phaseAfterReopen: reopened.execution(state.ref, state.execution.executionId)?.phase,
      grantAfterReopen: reopened.executionContinuation(state.ref, state.replacement.bindingId)?.status,
      terminalDeliveries: state.delivered.filter(message => message.type === 'turn_terminal').length,
    }).toEqual({ phaseAfterReopen: 'failed', grantAfterReopen: 'rejected', terminalDeliveries: 1 });
  });

  it('delivers the refusal notice when ordinary fallback binds during host persistence', async () => {
    const state = fixture('unreserved');
    let releaseNotice!: () => void;
    vi.spyOn(state.controller, 'flushPrimary').mockImplementationOnce(() => new Promise<void>(resolve => {
      releaseNotice = resolve;
    }));
    state.abandon('rejected');
    const fallback = state.scope.beginRuntime();
    state.controller.reserveBinding(fallback.bindingId, state.worker);
    state.controller.bindRuntime(fallback.bindingId, state.worker,
      { backend: 'tmux', physicalId: 'ordinary-fallback:3', nativeSessionId: 'native', proof: 'process_start' });
    releaseNotice();
    await state.settle();
    expect(state.errors).toEqual([]);
    expect(state.delivered.filter(message => message.type === 'turn_terminal')).toHaveLength(1);
    expect(state.delivered.filter(message => message.type === 'user_notify')).toHaveLength(1);
  });

  it.each(['cancel', 'restart', 'suspend', 'close'] as const)('retains human %s ownership during abandonment', async kind => {
    const state = fixture('planned');
    const operation = state.controller.beginControl(kind, undefined, kind === 'cancel' ? state.execution : undefined).operation;
    state.controller.controlStarted(operation.operationId);
    state.abandon('rejected');
    await state.settle();
    expect(state.errors).toEqual([]);
    expect(state.store.execution(state.ref, state.execution.executionId)?.phase).toBe('failed');
    if (kind !== 'cancel') {
      expect(state.store.read(state.ref)?.activeOperationId).toBe(operation.operationId);
      expect(state.controller.allowsInput()).toBe(false);
    }
    expect(state.env.pendingMessages.map((message: any) => message.turnId)).toEqual([state.successor.turnId]);
  });

  it.each(['wrong-worker', 'old-worker', 'other-runtime', 'other-execution', 'other-cli', 'durable'] as const)(
    'rejects a failure marker with %s authority', variant => {
      const state = fixture();
      const message = state.failure();
      if (variant === 'wrong-worker') message.sessionContract.producer = { workerId: 'foreign', generation: 1 };
      if (variant === 'old-worker') state.controller.bindWorker(2);
      if (variant === 'other-runtime') message.sessionContract.scope.runtime = state.replacement.runtime;
      if (variant === 'other-execution') message.continuationFailure = {
        ...message.continuationFailure, continuation: { ...state.continuation, execution: state.successor },
      };
      if (variant === 'other-cli') state.controller.ds.initConfig!.cliId = 'claude-code';
      if (variant === 'durable') message.continuationFailure = {
        ...message.continuationFailure, continuation: { ...state.continuation, execution: { ...state.execution, dispatchAttempt: 1 } },
      };
      expect(state.controller.ingest(message, state.worker).kind).toBe('reject');
      expect(state.store.execution(state.ref, state.execution.executionId)?.terminal).toBeUndefined();
    });

  it.each([false, true])('keeps consumption durable through same-process enrichment (consumed=%s)', consumed => {
    const state = fixture();
    if (consumed) {
      const message = state.scope.run(state.replacement, () => state.scope.envelope(state.scope.capture()));
      state.controller.ingest({
        type: 'native_input_consumed', turnId: state.execution.turnId,
        sessionContract: { ...message, scope: { runtime: state.replacement.runtime, execution: state.execution } },
      }, state.worker);
    }
    const enriched = state.scope.beginRuntime(undefined, state.replacement.physicalId);
    state.controller.reserveBinding(enriched.bindingId, state.worker);
    state.controller.bindRuntime(enriched.bindingId, state.worker,
      { ...state.replacement.identity!, physicalId: 'replacement-leaf:2' }, undefined, state.replacement.bindingId);
    const admitted = state.controller.ingest(state.failure(enriched.bindingId), state.worker);
    expect(admitted.kind === 'reject').toBe(consumed);
    expect(state.store.execution(state.ref, state.execution.executionId)?.phase).toBe(consumed ? 'accepted' : 'failed');
  });

  it('confirms the abort of a refused continuation reservation so the surviving worker stops reporting it', async () => {
    vi.useFakeTimers();
    // The host refused the reservation before creating a binding; the worker
    // survives and reports the abandoned start like any other aborted start.
    const state = fixture('unreserved');
    expect(state.store.binding(state.ref, state.replacement.bindingId)).toBeUndefined();
    const aborts = () => state.sent.filter(message => message.type === 'runtime_binding_aborted'
      && message.bindingId === state.replacement.bindingId);
    state.scope.reportAbortedStart(state.replacement, () => state.env.send({
      type: 'runtime_binding_aborted', bindingId: state.replacement.bindingId,
    }));
    await state.settle();
    await vi.advanceTimersByTimeAsync(5_100);
    await state.settle();
    expect(state.errors).toEqual([]);
    expect(state.child.send).toHaveBeenCalledWith({ type: 'runtime_binding_aborted_ack', bindingId: state.replacement.bindingId });
    expect(aborts()).toHaveLength(1);
    expect(state.store.binding(state.ref, state.replacement.bindingId)).toBeUndefined();
  });

  it('still refuses to confirm an abort report for a runtime bound to a real process', async () => {
    vi.useFakeTimers();
    const state = fixture('approved');
    const bound = state.store.binding(state.ref, state.replacement.bindingId);
    expect(bound?.identity).toBeDefined();
    state.scope.run(state.replacement, () => state.env.send({
      type: 'runtime_binding_aborted', bindingId: state.replacement.bindingId,
    }));
    await state.settle();
    expect(state.errors).toEqual([]);
    expect(state.child.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'runtime_binding_aborted_ack' }));
    expect(state.store.binding(state.ref, state.replacement.bindingId)).toEqual(bound);
  });

  it('keeps consumption durable on the original approved binding', () => {
    const state = fixture();
    state.scope.acceptContinuation(state.replacement.bindingId,
      { ref: state.execution, runtime: state.replacement.runtime, phase: 'accepted' });
    state.scope.run(state.replacement, () => state.scope.recordSubmission(state.execution.turnId));
    const envelope = state.scope.run(state.replacement, () => state.scope.envelope(state.scope.capture()));
    expect(state.controller.ingest({
      type: 'native_input_consumed', turnId: state.execution.turnId,
      sessionContract: { ...envelope, scope: { runtime: state.replacement.runtime, execution: state.execution } },
    }, state.worker).kind).toBe('current');
    expect(state.controller.ingest(state.failure(), state.worker).kind).toBe('reject');
    expect(state.store.execution(state.ref, state.execution.executionId)?.phase).toBe('accepted');
    expect(state.scope.canSubmitContinuation(state.execution.turnId, state.execution)).toBe(false);
  });

  it('does not overwrite a human-confirmed cancellation or revive it with a delayed grant', async () => {
    const state = fixture();
    state.store.apply(state.ref, { type: 'execution_terminal', execution: state.execution,
      runtime: state.replacement.runtime!, status: 'cancelled', evidence: 'human_cancel' });
    state.scope.noteAdmission({ ref: state.execution, runtime: state.replacement.runtime, phase: 'cancelled' });
    state.abandon();
    await state.settle();
    state.env.flushPending = vi.fn(async () => {});
    await state.receive(state.approval());
    expect(state.sent.filter(message => message.type === 'turn_terminal')).toEqual([]);
    expect(state.store.execution(state.ref, state.execution.executionId)?.phase).toBe('cancelled');
    expect(state.scope.canSubmitContinuation(state.execution.turnId, state.execution)).toBe(false);
    expect(state.scope.canSubmit(state.execution.turnId)).toBe(false);
  });

  it('refuses a delayed grant after a different physical runtime takes over', async () => {
    const state = fixture();
    state.abandon();
    await state.settle();
    const current = state.scope.beginRuntime();
    current.identity = { backend: 'tmux', physicalId: 'human-restart:9', nativeSessionId: 'native', proof: 'process_start' };
    const runtime = state.controller.reserveBinding(current.bindingId, state.worker);
    state.controller.bindRuntime(current.bindingId, state.worker, current.identity);
    state.scope.assign(current.bindingId, runtime);
    await state.receive(state.approval());
    expect(state.scope.currentBinding()).toBe(current);
    expect(state.scope.canSubmitContinuation(state.execution.turnId, state.execution)).toBe(false);
    expect(state.scope.canSubmit(state.execution.turnId)).toBe(false);
    expect(state.scope.canSubmit(state.successor.turnId)).toBe(true);
  });

  it.each(['claude-code', 'codex'] as const)('preserves ordinary terminal handling for %s', async cliId => {
    const state = fixture('unreserved');
    state.controller.ds.initConfig!.cliId = cliId;
    state.scope.run(state.source, () => state.env.emitTurnTerminal(state.execution.turnId, 'completed'));
    await state.settle();
    expect(state.errors).toEqual([]);
    expect(state.store.execution(state.ref, state.execution.executionId)?.phase).toBe('succeeded');
    expect(state.delivered.filter(message => message.type === 'turn_terminal')).toHaveLength(1);
  });

  it.each(['failure-capability', 'grant-capability', 'backend'] as const)(
    'keeps independent Auto selection but refuses current-turn recovery without %s', missing => {
      const state = fixture('unreserved');
      const authority = new ActiveTurnAuthority();
      authority.reserve({ turnId: state.execution.turnId });
      authority.markStarted({ turnId: state.execution.turnId });
      const pool = new TraexAutoModelController({ enabled: true, models: ['first', 'second'] });
      pool.beginTurn(state.execution.turnId);
      Object.assign(state.env, {
        activeTurnAuthority: authority, traexAutoModelController: pool,
        lastInitConfig: { cliId: 'traex', cliSessionId: 'native', model: 'first',
          sessionContract: { executionContinuations: missing !== 'grant-capability',
            executionContinuationFailures: missing !== 'failure-capability' } },
        TRAEX_CONTINUATION_BACKENDS, effectiveBackendType: missing === 'backend' ? 'zmx' : 'tmux',
        isRemoteBackendType, inflightInputs: new InflightInputTracker(),
        traexAutoModelSwitching: false, isFlushing: false, cliRestartInProgress: false,
        applyTraexAutoModelSettings: vi.fn(), restartCliProcess: vi.fn(async () => {}),
        send: vi.fn(),
      });
      state.env.traexAutoModelRuntimeEligible = loadWorkerFunction('traexAutoModelRuntimeEligible', state.env);
      const execute = loadWorkerFunction<(action: any, options: any) => boolean>('executeTraexAutoModelSwitch', state.env);
      const action = { kind: 'switch', turnId: state.execution.turnId, fromModel: 'first', toModel: 'second',
        toIndex: 1, reason: 'capacity_timeout' };
      expect(execute(action, { resumeCurrentTurn: true })).toBe(false);
      expect(state.env.restartCliProcess).not.toHaveBeenCalled();
      expect(execute({ ...action, reason: 'preflight_available' }, { resumeCurrentTurn: false })).toBe(true);
      expect(state.env.restartCliProcess).toHaveBeenCalledOnce();
      expect(state.env.restartCliProcess.mock.calls[0][1]).not.toHaveProperty('restartCause');
    });

  it.each(['ready', 'empty-screen'] as const)('bounds missing grants despite %s viewport evidence', async viewport => {
    vi.useFakeTimers();
    const state = fixture();
    state.env.publishRuntimeContract = vi.fn(async () => {});
    state.env.flushPending = state.harness.flush;
    state.env.freshnessInputQueue.takeNormal = () => undefined;
    await state.harness.flush();
    expect(state.env.pendingMessages[0].traexAutoModelContinuationDeadlineAt).toBeGreaterThan(Date.now());
    if (viewport === 'empty-screen') {
      Object.assign(state.env, {
        backend: { captureViewportAsync: vi.fn(async () => '') },
        backendScreenEvidenceIsAuthoritativeForMutation: () => true,
        currentPostTerminalInputFence: () => null,
      });
      state.env.admitTraexAutoModelPendingInput = loadWorkerFunction('admitTraexAutoModelPendingInput', state.env);
    }
    await vi.advanceTimersByTimeAsync(2 * TRAEX_AUTO_MODEL_CONTINUATION_GRANT_TIMEOUT_MS);
    await state.settle();
    expect(state.errors).toEqual([]);
    expect({
      phase: state.store.execution(state.ref, state.execution.executionId)?.phase,
      queuedTurns: state.env.pendingMessages.map((message: any) => message.turnId),
      terminalEmissions: state.sent.filter(message => message.type === 'turn_terminal').length,
    }).toEqual({ phase: 'failed', queuedTurns: [state.successor.turnId], terminalEmissions: 1 });
  });

  it('releases the queued successor when the deadline abandons the recovery during its viewport admission', async () => {
    vi.useFakeTimers();
    const state = fixture('planned');
    const env = state.env;
    env.publishRuntimeContract = vi.fn(async () => {});
    env.flushPending = state.harness.flush;
    // A write cycle revokes readiness until a hold or a write settles it.
    env.beginCliWriteCycle = () => { env.isPromptReady = false; };
    // The real pre-turn gate: an independent successor with no turn owning the
    // CLI waits for a composer edge whenever readiness is gone.
    Object.assign(env, {
      activeTurnAuthority: { snapshot: () => undefined },
      traexAutoModelSwitching: false, traexQuotaPending: undefined, traexAutoModelPreflightPending: false,
      traexAutoModelPreflightEnabled: () => false,
    });
    env.traexAutoModelController.config = { trigger: 'capacity', reselectPerTurn: false };
    env.resetTraexAutoModelBeforePendingTurn = loadWorkerFunction('resetTraexAutoModelBeforePendingTurn', env);
    // The recovery's viewport read is in flight when the deadline fires. Like
    // the real admission, a read refuses an item that is no longer the head.
    let readStarted = false;
    let finishRead!: () => void;
    const read = new Promise<void>(resolveRead => { finishRead = resolveRead; });
    env.admitTraexAutoModelPendingInput = async (item: any) => {
      if (item.traexAutoModelRecovery) { readStarted = true; await read; }
      return env.pendingMessages[0] === item;
    };
    const taken: string[] = [];
    env.freshnessInputQueue.takeNormal = () => { taken.push(env.pendingMessages[0]?.turnId); return undefined; };
    env.isPromptReady = true;
    const interrupted = state.harness.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(readStarted).toBe(true);
    expect(state.abandon('timeout')).toBe(true);
    finishRead();
    await interrupted;
    await state.settle();
    // The bounded admission retry (or the host's refusal answer) re-drives the
    // flush; the replacement's screen is static, so no composer edge follows.
    await state.harness.flush();
    expect(state.errors).toEqual([]);
    expect({
      phase: state.store.execution(state.ref, state.execution.executionId)?.phase,
      written: taken,
    }).toEqual({ phase: 'failed', written: [state.successor.turnId] });
  });

  it.each(['ordinary-refusal', 'close', 'new-runtime'] as const)('handles reservation refusal with %s ownership', async owner => {
    vi.useFakeTimers();
    const state = fixture('unreserved');
    Object.assign(state.env, {
      pendingRuntimeReservations: new Map(), activeRestartAttemptId: undefined, closeRequested: false,
      initialInputOwnershipPending: false, spawnCliBody: vi.fn(async () => {}),
      CliSpawnSupersededError: class extends Error {},
    });
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', state.env);
    const receive = loadWorkerMessageHandler('runtime_contract_reserved', state.env);
    let reservations = 0;
    state.env.send = (message: any) => {
      state.sent.push(metadata(message));
      if (message.type !== 'runtime_binding_started') return;
      reservations++;
      if (reservations === 1 && owner === 'close') state.env.closeRequested = true;
      if (reservations === 1 && owner === 'new-runtime') state.scope.beginRuntime('human-restart');
      void receive({ type: 'runtime_contract_reserved', bindingId: message.bindingId, mayStart: reservations > 1 });
    };
    const spawn = loadWorkerFunction<(config: any, options: any) => Promise<void>>('spawnCli', state.env);
    const result = await spawn({ cliId: 'traex', prompt: '', resume: true, cliSessionId: 'native' },
      { restartCause: 'traex-auto-model' }).then(() => 'started', error => error);
    if (owner === 'ordinary-refusal') {
      expect(result).toBe('started');
      expect(reservations).toBe(2);
      expect(state.env.spawnCliBody).toHaveBeenCalledOnce();
      expect(state.sent.filter(message => message.type === 'runtime_binding_started')[1].continuation).toBeUndefined();
      expect(state.env.pendingMessages.map((message: any) => message.turnId)).toEqual([state.successor.turnId]);
    } else {
      expect(result).toBeInstanceOf(state.env.CliSpawnSupersededError);
      expect(reservations).toBe(1);
      expect(state.env.spawnCliBody).not.toHaveBeenCalled();
      expect(state.sent.filter(message => message.type === 'turn_terminal')).toHaveLength(0);
    }
  });
});
