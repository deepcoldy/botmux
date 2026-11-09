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

afterEach(() => vi.restoreAllMocks());

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
