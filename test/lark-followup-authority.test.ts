import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure, loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { randomBytes } from 'node:crypto';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('publishes identity for a follow-up on a completed ordinary IM runtime', async () => {
  const data = mkdtempSync(join(tmpdir(), 'followup-authority-'));
  const store = new SessionContractStore(data, 'cli_followup');
  try {
    const ds: any = { larkAppId: 'cli_followup', chatId: 'oc_test', session: { sessionId: 'followup', status: 'active', workerGeneration: 1 }, workerGeneration: 1, cliReadyGeneration: 0 };
    const controller = new SessionController(ds, store);
    const producer = controller.bindWorker(1).worker;
    const scope = new WorkerSessionEventScope(controller.ref, producer);
    const binding = scope.beginRuntime();
    const runtime = controller.reserveBinding(binding.bindingId, producer);
    controller.bindRuntime(binding.bindingId, producer, { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' });
    scope.assign(binding.bindingId, runtime);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const worker = { send: vi.fn() }; ds.worker = worker;
    const host: any = { sessionController: controller, contractWorker: producer, ds, worker,
      logger: { debug: vi.fn(), warn: vi.fn() }, t: 'test', botCfg: {}, sessionCliId: () => 'codex',
      currentGatewayCallerOpenId: () => 'ou_requester', currentTurnProcessIdentities: () => ['111:start1'],
      noteTurnDispatchAttempt: vi.fn(), ensureAutomaticTaskContinuationLease: vi.fn(), randomBytes };
    const legacy = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleLegacyWorkerMessage', host);
    host.handleLegacyWorkerMessage = (message: any) => message.type.startsWith('managed_turn_origin') ? legacy(message) : undefined;
    const handle = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', host);
    const send = (message: any) => handle(metadata(message));
    const h = workerSubmitHarness();
    const pending: Promise<void>[] = [];
    Object.assign(h.scope, {
      workerSessionEventScope: scope, sessionId: 'followup', captureRevision: 0,
      captureIdentityAnnounced: false, parseDaemonIpcPort: () => 7950, randomBytes,
      sandboxRelayOutbox: undefined, readIsolationOriginChannelId: undefined,
      activeTurnAuthority: { identity: () => ({ turnId: h.scope.currentBotmuxTurnId, caller: { requestUserOpenId: 'ou_requester' } }) },
      markTurnRetired: vi.fn(),
      send: (message: any) => { pending.push(send(message)); },
      markTurnExecutionStart: (turnId: string) => { pending.push(send({ type: 'turn_execution_started', turnId })); },
      acknowledgeTurnInputCommitted: vi.fn(),
      deferTurnInputCommitUntilSubmission: () => false,
      maybeQueuePostSubmitNativeSessionTitle: vi.fn(),
      cliAdapter: { reliableTurnTerminal: true, writeInput: vi.fn(async () => ({ submitted: true })) },
    });
    h.scope.setCaptureIdentity = loadWorkerFunction('setCaptureIdentity', h.scope);
    h.scope.publishSandboxRelayCapability = loadWorkerFunction('publishSandboxRelayCapability', h.scope);
    const deliveries = new Map();
    const transport: any = { controllerForSession: () => controller,
      ensurePrincipalLaneInboundTurnBinding: vi.fn(), pendingOrdinaryImDeliveries: deliveries,
      ordinaryImDeliveryKey: (_ds: unknown, turnId: string) => turnId,
      sendOrdinaryImDeliveryAttempt: (record: any) => { worker.send(record.message); return true; } };
    const tracked = loadWorkerPoolFunction<(ds: any, message: any) => boolean>('sendOrdinaryImDeliveryTracked', transport);
    let received: any;
    worker.send.mockImplementation((message: any) => {
      received = { ...message, sessionCommand: controller.command(message) };
      if (received.sessionCommand.execution) scope.rememberExecution(received.sessionCommand.execution, binding);
    });
    for (const turnId of ['first', 'followup']) {
      const message: any = turnId === 'first'
        ? { type: 'init', turnId, sessionCommand: { version: 2, execution: controller.admitInput(turnId) } }
        : { type: 'message', turnId, content: 'continue' };
      expect(tracked(ds, message)).toBe(true);
      const frozen = deliveries.get(turnId).message;
      const sendCount = worker.send.mock.calls.length;
      expect(tracked(ds, message)).toBe(true);
      expect(worker.send).toHaveBeenCalledTimes(sendCount);
      expect(deliveries.get(turnId).message).toBe(frozen);
      worker.send(frozen);
      expect(store.executions(controller.ref, turnId)).toHaveLength(1);
      await scope.run(binding, async () => {
        h.scope.pendingMessages.splice(0, h.scope.pendingMessages.length, { turnId, content: 'message' });
        await h.flush();
        await Promise.all(pending.splice(0));
        expect(ds.managedTurnOrigin).toMatchObject({ turnId, callerOpenId: 'ou_requester' });
        await send({ type: 'turn_execution_started', turnId });
        await send({ type: 'native_input_consumed', turnId });
        const execution = store.executions(controller.ref, turnId)[0].ref;
        expect(store.execution(controller.ref, execution.executionId)?.phase).toBe('accepted');
        await send({ type: 'turn_terminal', turnId, status: 'completed' });
        await send({ type: 'managed_turn_origin_revoked', sessionId: 'followup', turnId, capability: ds.managedTurnOrigin.capability });
        expect(ds.managedTurnOrigin?.turnId).toBeUndefined();
      }, received.sessionCommand.execution);
    }
    expect(host.logger.debug.mock.calls.filter(([text]: string[]) => text.includes('managed_turn_origin'))).toEqual([]);
  } finally { store.close(); rmSync(data, { recursive: true, force: true }); }
});

it('keeps a queued follow-up protected from deferred suspend after its commit ACK', async () => {
  vi.useFakeTimers();
  const data = mkdtempSync(join(tmpdir(), 'followup-backlog-'));
  const store = new SessionContractStore(data, 'cli_followup');
  try {
    const ds: any = {
      larkAppId: 'cli_followup', chatId: 'oc_test',
      session: { sessionId: 'backlog', status: 'active', workerGeneration: 1 },
      workerGeneration: 1, cliReadyGeneration: 0, lastScreenStatus: 'idle',
      pendingSuspendReason: 'cli_install_changed', pendingSuspendGeneration: 1,
    };
    const controller = new SessionController(ds, store);
    const producer = controller.bindWorker(1).worker;
    const events = new WorkerSessionEventScope(controller.ref, producer);
    const binding = events.beginRuntime();
    const runtime = controller.reserveBinding(binding.bindingId, producer);
    controller.bindRuntime(binding.bindingId, producer, { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' });
    events.assign(binding.bindingId, runtime);
    const worker = { send: vi.fn() };
    ds.worker = worker;
    const deliveries = new Map();
    const pool: any = {
      controllerForSession: () => controller,
      ensurePrincipalLaneInboundTurnBinding: vi.fn(),
      pendingOrdinaryImDeliveries: deliveries, workerCliInputBacklogs: new WeakMap(),
      ordinaryImDeliveryKey: (_ds: unknown, turnId: string) => turnId,
      sendOrdinaryImDeliveryAttempt: (record: any) => { worker.send(record.message); return true; },
      suspendWorker: vi.fn(() => true), logger: { info: vi.fn() }, tag: () => 'test',
    };
    for (const name of ['sendOrdinaryImDeliveryTracked', 'clearOrdinaryImDelivery', 'completeOrdinaryImDelivery',
      'hasPendingOrdinaryImDelivery', 'hasUnacceptedCliInput', 'recordWorkerCliInputBacklog', 'runPendingSuspendIfSettled']) {
      pool[name] = loadWorkerPoolFunction(name, pool);
    }
    pool.sendOrdinaryImDeliveryTracked(ds, { type: 'message', turnId: 'om_queued', content: 'waiting' });
    const execution = worker.send.mock.calls[0][0].sessionCommand.execution;
    events.rememberExecution(execution, binding);
    const observations: any[] = [];
    const ws: any = {
      workerSessionEventScope: events,
      pendingMessages: [{ turnId: execution.turnId, content: 'waiting' }],
      pendingRawInputs: [], pendingAdoptMessages: [], cliSubmissionInFlight: null,
      submitFailureChains: { size: () => 0 }, publishedCliInputBacklog: 'false:',
      universalOutputHandoff: null, closeRequested: false,
      isWorkflowWorker: () => false, ordinaryImTurnDedupe: { commit: vi.fn() },
      process: { send: (payload: any) => {
        const admission = controller.ingest(payload, producer);
        observations.push({ payload, admission });
        if (admission.kind !== 'current' && admission.kind !== 'worker') return;
        if (payload.type === 'cli_input_backlog') pool.recordWorkerCliInputBacklog(worker, payload);
        if (payload.type === 'turn_input_committed') pool.completeOrdinaryImDelivery(ds, payload.turnId, 1);
      } },
    };
    for (const name of ['sessionEventMetadata', 'workerIpcPayload', 'cliInputBacklogKey', 'cliInputBacklog',
      'publishCliInputBacklog', 'send', 'acknowledgeTurnInputCommitted']) {
      ws[name] = loadWorkerFunction(name, ws);
    }

    // The real send path publishes backlog before the ACK removes delivery protection.
    events.run(binding, () => ws.acknowledgeTurnInputCommitted(execution.turnId), execution);
    expect(deliveries.size).toBe(0);
    const periodicReport = setInterval(() => ws.publishCliInputBacklog(), 1_000);
    setTimeout(() => pool.runPendingSuspendIfSettled(ds, () => true), 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    clearInterval(periodicReport);
    expect(ws.pendingMessages).toHaveLength(1);
    expect(pool.suspendWorker).not.toHaveBeenCalled();
    expect(pool.hasUnacceptedCliInput(ds)).toBe(true);
    expect(observations.map(({ payload, admission }) => [payload.type, admission.kind])).toEqual([
      ['cli_input_backlog', 'current'], ['turn_input_committed', 'current'],
    ]);
    expect(store.execution(controller.ref, execution.executionId)?.phase).toBe('queued');

    // Queue drain releases the protection; the pending suspend can then proceed.
    ws.pendingMessages.length = 0;
    events.run(binding, () => ws.publishCliInputBacklog(), execution);
    pool.runPendingSuspendIfSettled(ds, () => true);
    expect(pool.hasUnacceptedCliInput(ds)).toBe(false);
    expect(pool.suspendWorker).toHaveBeenCalledTimes(1);

    // Removing execution scope must not let a retired worker change the backlog.
    controller.bindWorker(2);
    ws.pendingMessages.push({ turnId: execution.turnId, content: 'late report' });
    events.run(binding, () => ws.publishCliInputBacklog(), execution);
    expect(observations.at(-1).admission.kind).toBe('reject');
    expect(pool.hasUnacceptedCliInput(ds)).toBe(false);
  } finally { store.close(); rmSync(data, { recursive: true, force: true }); }
});
