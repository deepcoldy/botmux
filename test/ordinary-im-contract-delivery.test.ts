import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { sameWorker, contractTerminalStatus } from '../src/services/session-contract.js';
import { loadWorkerPoolFunction, loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { DaemonSession } from '../src/core/types.js';

const fixtureConfig = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return fixtureConfig.dataDir; } } } }));
const stores: SessionContractStore[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  vi.useFakeTimers();
  const data = mkdtempSync(join(tmpdir(), 'ordinary-im-contract-'));
  directories.push(data); fixtureConfig.dataDir = data;
  const ref = { appId: 'cli_receipt_test', sessionId: 'receipt-session' };
  const ds = { larkAppId: ref.appId, chatId: 'oc_test', scope: 'chat', workerGeneration: 1,
    session: { sessionId: ref.sessionId, larkAppId: ref.appId, status: 'active', workerGeneration: 1 },
  } as DaemonSession;
  const store = new SessionContractStore(data, ref.appId); stores.push(store);
  const controller = new SessionController(ds, store);
  const producer = controller.bindWorker(1).worker;
  const runtime = controller.reserveBinding('receipt-binding', producer);
  controller.bindRuntime('receipt-binding', producer, { backend: 'tmux', physicalId: '111:start', nativeSessionId: 'old-native', proof: 'process_start' });
  const eventScope = new WorkerSessionEventScope(ref, producer);
  const binding = eventScope.beginRuntime(); eventScope.assign(binding.bindingId, runtime);
  const wire: any[] = [];
  const worker: any = { killed: false, send: vi.fn((message, callback) => {
    const command = { ...message, sessionCommand: controller.command(message) };
    wire.push(command); callback?.(null); return true;
  }) };
  ds.worker = worker;
  const pending = new Map();
  const failures = vi.fn();
  const env: Record<string, any> = {
    pendingOrdinaryImDeliveries: pending, controllerForSession: () => controller,
    ensurePrincipalLaneInboundTurnBinding: vi.fn(), workerIpcBootstrapStates: new WeakMap(),
    ORDINARY_IM_TRANSPORT_TIMEOUT_MS: 100, ORDINARY_IM_MAX_ATTEMPTS: 3,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }, tag: () => 'receipt',
    failOrdinaryImDelivery: failures, recordWorkerCommittedTurn: vi.fn(),
  };
  for (const name of ['ordinaryImDeliveryKey', 'clearOrdinaryImDelivery', 'clearOrdinaryImDeliveryTimer',
    'retryOrFailOrdinaryImDelivery', 'sendOrdinaryImDeliveryAttempt', 'sendOrdinaryImDeliveryTracked',
    'acknowledgeOrdinaryImDeliveryReceipt', 'completeOrdinaryImDelivery', 'completeWorkerOrdinaryImDelivery',
    'settleOrdinaryImDeliveriesForWorker']) {
    env[name] = loadWorkerPoolFunction(name, env);
  }
  const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: eventScope });
  const gatewayEnv = { ...env, sessionController: controller, contractWorker: producer, workerGeneration: 1, ds, worker, sameWorker, contractTerminalStatus,
    cb: { onTurnTerminal: vi.fn() },
    ownsWorkerSession: () => ds.worker === worker,
    isSessionTransferring: () => false, managedAuxUiSuppressed: () => true, finalizeCotMessage: vi.fn(),
    handleLegacyWorkerMessage: async (message: any) => {
      if (message.type === 'turn_input_received') env.acknowledgeOrdinaryImDeliveryReceipt(ds, message.turnId, 1);
      if (message.type === 'turn_input_committed') env.completeOrdinaryImDelivery(ds, message.turnId, 1);
    },
  };
  const handle = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', gatewayEnv);
  const receipt = (type: string, command = wire.at(-1)) => {
    const execution = command.sessionCommand?.execution;
    if (execution) eventScope.rememberExecution(execution);
    return eventScope.run(binding, () => metadata({ type, turnId: command.turnId }), execution);
  };
  return { ds, store, controller, producer, eventScope, binding, worker, wire, pending, failures, env, handle, receipt };
}

describe('ordinary IM delivery through the strict session contract', () => {
  it.each(['om_followup', 'bmx-recovery-retry', 'board:cli_receipt_test:1'])('settles the queued receipt before retirement: %s', async turnId => {
    const s = fixture();
    expect(s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'message', content: 'question', turnId })).toBe(true);
    await s.handle(s.receipt('turn_input_received'));
    expect([...s.pending.values()][0].received).toBe(true);
    await s.handle(s.receipt('turn_input_committed'));
    expect(s.pending.size).toBe(0);
    s.env.settleOrdinaryImDeliveriesForWorker(s.worker, { suppressAllFailures: true, retiredBeforeCommit: true });
    expect(s.failures).not.toHaveBeenCalled();
    expect(s.store.executions(s.controller.ref, turnId)).toHaveLength(1);
    expect(s.store.executions(s.controller.ref, turnId)[0].phase).toBe('queued');
  });

  it('keeps one frozen admission across duplicate delivery and IPC retries', () => {
    const s = fixture(); const input = { type: 'message', content: 'question', turnId: 'om_retry' };
    s.worker.send.mockImplementationOnce(() => true);
    s.env.sendOrdinaryImDeliveryTracked(s.ds, input);
    const execution = [...s.pending.values()][0].message.sessionCommand?.execution;
    expect(execution).toBeDefined();
    s.env.sendOrdinaryImDeliveryTracked(s.ds, input);
    expect(s.worker.send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(s.wire.at(-1).sessionCommand.execution).toEqual(execution);
    expect(s.store.executions(s.controller.ref, 'om_retry')).toHaveLength(1);
  });

  it('accepts the initial scoped receipt before any backend runtime has started', async () => {
    const s = fixture(); const turnId = 'om_init';
    s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'init', prompt: 'question', turnId });
    const boot: Record<string, any> = { WorkerSessionEventScope, sessionId: '', workerSessionEventScope: undefined,
      universalOutputHandoff: undefined, lastInitConfig: undefined,
    };
    const initialize = loadWorkerFunction<(message: any) => void>('initializeWorkerSessionContract', boot);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', boot);
    const messages: any[] = [];
    boot.send = (message: any) => messages.push(metadata(message));
    const received = loadWorkerFunction<(turnId: string) => void>('acknowledgeTurnInputReceived', boot);
    initialize({ sessionId: s.controller.ref.sessionId,
      sessionContract: { session: s.controller.ref, worker: s.producer, executions: [] },
      sessionCommand: s.wire.at(-1).sessionCommand });
    received(turnId);
    expect(messages[0].sessionContract.scope.runtime).toBeUndefined();
    await s.handle(messages[0]);
    expect([...s.pending.values()][0].received).toBe(true);
  });

  it('refuses a new tracked turn while the session is closing', () => {
    const s = fixture(); const { operation } = s.controller.beginControl('close'); s.controller.controlStarted(operation.operationId);
    expect(s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'message', content: 'question', turnId: 'om_blocked' })).toBe(false);
    expect(s.pending.size).toBe(0); expect(s.worker.send).not.toHaveBeenCalled();
    expect(s.store.executions(s.controller.ref, 'om_blocked')).toHaveLength(0);
  });

  it('allows the already-admitted cold-start input during resume', () => {
    const s = fixture(); const execution = s.controller.admitInput('om_resume');
    s.controller.beginControl('resume');
    expect(s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'init', prompt: 'question', turnId: 'om_resume',
      sessionCommand: { version: 2, execution } })).toBe(true);
    expect(s.wire.at(-1).sessionCommand.execution).toEqual(execution);
  });

  it('does not dispatch or leave a pending record if admission persistence fails', () => {
    const s = fixture(); vi.spyOn(s.controller, 'admitInput').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'message', content: 'question', turnId: 'om_disk' })).toThrow('disk full');
    expect(s.pending.size).toBe(0); expect(s.worker.send).not.toHaveBeenCalled();
  });

  it('settles a retiring worker commit without touching the replacement delivery', async () => {
    const s = fixture(); const input = { type: 'message', content: 'question', turnId: 'om_late' };
    s.env.sendOrdinaryImDeliveryTracked(s.ds, input);
    const commit = s.receipt('turn_input_committed');
    const replacement = { killed: false, send: vi.fn() };
    s.ds.worker = replacement as any; s.ds.workerGeneration = s.ds.session.workerGeneration = 2;
    s.controller.bindWorker(2); s.env.sendOrdinaryImDeliveryTracked(s.ds, input);
    expect(s.pending.size).toBe(2);
    await s.handle(commit);
    expect(s.pending.size).toBe(1); expect([...s.pending.values()][0].worker).toBe(replacement);
    expect(s.env.recordWorkerCommittedTurn).toHaveBeenCalledWith(s.worker, input.turnId);
    expect(s.store.executions(s.controller.ref, input.turnId)[0].phase).toBe('queued');
    s.env.settleOrdinaryImDeliveriesForWorker(s.worker, { suppressAllFailures: true, retiredBeforeCommit: true });
    expect(s.failures).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'worker', 'session', 'generation', 'execution', 'attempt', 'payload_attempt', 'sequence', 'missing'])('does not settle a retiring input from invalid proof: %s', async invalid => {
    const s = fixture(); s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'message', content: 'question', turnId: 'om_invalid' });
    const message = s.receipt('turn_input_committed'); s.ds.worker = null;
    if (invalid === 'receipt') message.type = 'turn_input_received';
    if (invalid === 'worker') message.sessionContract.producer.workerId = 'foreign';
    if (invalid === 'session') message.sessionContract.session.sessionId = 'foreign';
    if (invalid === 'generation') message.sessionContract.producer.generation = 2;
    if (invalid === 'execution') message.sessionContract.scope.execution.executionId = 'foreign';
    if (invalid === 'attempt') message.sessionContract.scope.execution.dispatchAttempt = 1;
    if (invalid === 'payload_attempt') message.dispatchAttempt = 1;
    if (invalid === 'sequence') message.sessionContract.eventId = 'foreign';
    if (invalid === 'missing') delete message.sessionContract;
    await s.handle(message); expect(s.pending.size).toBe(1);
    expect(s.env.recordWorkerCommittedTurn).not.toHaveBeenCalled();
  });

  it.each(['valid', 'session', 'sequence', 'execution'])('records a retiring commit for an untracked turn only with envelope proof: %s', async variant => {
    // A Codex turn outside the delivery tracker (doc-watch, approval, ...) ACKs
    // its commit after submission. Suspend keeps the contract worker, so the
    // ACK can drain after ds.worker detached; the retire notice must see it.
    const s = fixture(); const execution = s.controller.admitInput('doc-watch-1763290000000-abcdefgh');
    const message = s.receipt('turn_input_committed', { turnId: execution.turnId, sessionCommand: { execution } });
    s.ds.worker = null;
    if (variant === 'session') message.sessionContract.session.sessionId = 'foreign';
    if (variant === 'sequence') message.sessionContract.eventId = 'foreign';
    if (variant === 'execution') message.sessionContract.scope.execution.executionId = 'foreign';
    await s.handle(message);
    if (variant === 'valid') expect(s.env.recordWorkerCommittedTurn).toHaveBeenCalledExactlyOnceWith(s.worker, execution.turnId);
    else expect(s.env.recordWorkerCommittedTurn).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'ambiguous', 'cancelled'])('uses only verified successful terminal evidence if the commit was lost: %s', async status => {
    const s = fixture(); s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'message', content: 'question', turnId: 'om_terminal' });
    const message = s.receipt('turn_terminal'); message.status = status;
    await s.handle(message);
    expect(s.pending.size).toBe(status === 'completed' ? 0 : 1);
  });

  it('settles success from an older runtime of the same worker without mutating the newer runtime', async () => {
    const s = fixture(); const turnId = 'om_historical';
    s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'message', content: 'question', turnId });
    await s.handle(s.receipt('turn_input_received'));
    await s.handle(s.receipt('turn_execution_started'));
    const terminal = s.receipt('turn_terminal'); terminal.status = 'completed';
    const next = s.controller.reserveBinding('next-binding', s.producer);
    s.controller.bindRuntime('next-binding', s.producer, { backend: 'tmux', physicalId: '111:start', nativeSessionId: 'next-native', proof: 'process_start' });
    await s.handle(terminal);
    expect(s.pending.size).toBe(0);
    expect(s.store.executions(s.controller.ref, turnId)[0].phase).toBe('succeeded');
    expect(s.controller.currentRuntime()).toEqual(next);
    expect(s.store.runtime(s.controller.ref, next.runtimeId)?.phase).toBe('starting');
  });

  it('does not settle an older tracked admission from another valid execution with the same turn id', async () => {
    const s = fixture(); const turnId = 'om_same_turn';
    s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'message', content: 'question', turnId });
    const execution = s.controller.admitInput(turnId, undefined, 'different-admission');
    const terminal = s.eventScope.run(s.binding, () => ({ type: 'turn_terminal', turnId, status: 'completed',
      sessionContract: s.eventScope.envelope({ bindingId: s.binding.bindingId, runtime: s.controller.currentRuntime(), execution }) }));
    await s.handle(terminal);
    expect(s.store.execution(s.controller.ref, execution.executionId)?.phase).toBe('succeeded');
    expect(s.pending.size).toBe(1);
  });

  it('settles an old worker successful terminal while preserving the replacement input', async () => {
    const s = fixture(); const turnId = 'om_old_worker';
    s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'message', content: 'question', turnId });
    await s.handle(s.receipt('turn_execution_started'));
    const terminal = s.receipt('turn_terminal'); terminal.status = 'completed';
    const replacement = { killed: false, send: vi.fn() };
    s.ds.worker = replacement as any; s.ds.workerGeneration = s.ds.session.workerGeneration = 2;
    s.controller.bindWorker(2);
    s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'message', content: 'new question', turnId: 'om_new_worker' });
    await s.handle(terminal);
    expect(s.pending.size).toBe(1); expect([...s.pending.values()][0].turnId).toBe('om_new_worker');
    expect(s.store.executions(s.controller.ref, turnId)[0].phase).toBe('succeeded');
  });

  it('keeps a received but uncommitted input visible on retirement', async () => {
    const s = fixture();
    s.env.sendOrdinaryImDeliveryTracked(s.ds, { type: 'message', content: 'question', turnId: 'om_uncommitted' });
    await s.handle(s.receipt('turn_input_received'));
    s.env.settleOrdinaryImDeliveriesForWorker(s.worker, { suppressAllFailures: true, retiredBeforeCommit: true });
    expect(s.failures).toHaveBeenCalledTimes(1);
  });
});
