import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { t } from '../src/i18n/index.js';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { sameWorker } from '../src/services/session-contract.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { fixture, rows, children, contractHandles, contractEvents, useTraexAutoModelIntegrationCleanup } from './helpers/traex-auto-model-integration.js';

useTraexAutoModelIntegrationCleanup();

describe('TraeX auto-model current-turn continuation real Worker and PTY', () => {
  it.skipIf(!probeTmuxFunctional().ok)('does not replay original input after an approved-window host restart', async () => {
    const f = await fixture(true, 'ordered', false, undefined, true, undefined, true,
      undefined, 0, 0, false, false, undefined, undefined, undefined, false, false, true);
    const originalSend = f.child.send.bind(f.child);
    let dropped = 0;
    f.child.send = ((message: any, ...args: any[]) => {
      if (message.type === 'runtime_contract_assigned' && message.continuation?.status === 'approved') {
        dropped++; return true;
      }
      return (originalSend as any)(message, ...args);
    }) as typeof f.child.send;
    f.sendInput('original restart task', 'om_restart');
    await f.wait(() => rows(f.submissions).length === 1, 'original request submitted');
    await f.wait(() => dropped > 0, 'approved receipt deliberately lost');
    expect(rows(f.submissions)).toHaveLength(1);
    const restartedDs = { ...f.ds, session: structuredClone(f.ds.session) };
    const exited = new Promise<void>(resolveExit => f.child.once('exit', () => resolveExit()));
    f.child.kill('SIGKILL'); await exited;
    contractHandles.splice(contractHandles.indexOf(f.controller!.store), 1); f.controller!.store.close();
    const store = new SessionContractStore(f.options.env.SESSION_DATA_DIR, 'app_test'); contractHandles.push(store);
    const controller = new SessionController(restartedDs, store); const bootstrap = controller.bindWorker(2);
    const second = spawnNodeTsScript(f.entry, [], f.options); children.push(second);
    restartedDs.worker = second; restartedDs.workerGeneration = 2;
    const secondMessages: WorkerToDaemon[] = [];
    const secondLogs: string[] = [];
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', {
      sessionController: controller, contractWorker: bootstrap.worker, ds: restartedDs, worker: second, sameWorker,
      logger: { warn: (line: string) => secondLogs.push(line), debug: () => {}, error: () => {} }, t,
      handleLegacyWorkerMessage: async () => {},
    });
    second.on('message', (raw: any) => { secondMessages.push(raw); contractEvents.push(host(raw)); });
    second.stdout?.on('data', chunk => secondLogs.push(chunk.toString()));
    second.stderr?.on('data', chunk => secondLogs.push(chunk.toString()));
    const init = { ...f.init, model: 'backup', resume: true, cliSessionId: f.nativeId, sessionContract: bootstrap };
    restartedDs.initConfig = init; second.send(init);
    async function waitSecond(predicate: () => boolean, description: string) {
      const until = Date.now() + 35_000;
      while (Date.now() < until) {
        if (predicate()) return;
        if (second.exitCode !== null || second.signalCode !== null) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
      throw new Error(`${description}\n${secondLogs.join('')}`);
    }
    await waitSecond(() => secondMessages.some(message => message.type === 'prompt_ready'), 'reattached worker ready');
    const execution = controller.admitInput('om_restart');
    second.send({ type: 'message', content: 'original restart task', turnId: execution.turnId,
      trustedCaller: { requestLarkAppId: 'app_test', requestUserOpenId: 'ou_test', senderType: 'user' },
      sessionCommand: controller.command({ type: 'message', turnId: execution.turnId, sessionCommand: { version: 2, execution } }) });
    await waitSecond(() => rows(f.submissions).length >= 2 || secondMessages.some(message => message.type === 'turn_input_rejected'), 'duplicate rejection');
    expect(rows(f.submissions).filter(row => row.text === 'original restart task')).toHaveLength(1);
  }, 80_000);

  it.skipIf(!probeTmuxFunctional().ok)('continues an admitted execution after an exact model switch under the session contract', async () => {
    const f = await fixture(true, 'ordered', false, undefined, true, undefined, true,
      undefined, 0, 0, false, false, undefined, undefined, undefined, false, false, true);
    f.sendInput('original contract task', 'om_contract');
    await f.wait(() => rows(f.submissions).length === 1, 'original contract input');
    await f.wait(() => rows(f.launches).length === 2, 'exact model replacement');
    await f.wait(() => rows(f.submissions).length === 2, 'authorized contract continuation', 30_000);
    expect(f.hostErrors).toEqual([]);
    expect(f.messages.filter(message => message.type === 'turn_input_rejected')).toEqual([]);
    expect(rows(f.submissions)[1].text).toBe(t('worker.traex_auto_model.continue_prompt'));
    expect(rows(f.launches).slice(1).every(row => row.args[0] === 'resume' && row.args.at(-1) === f.nativeId)).toBe(true);
    await new Promise(resolveWait => setTimeout(resolveWait, 3_000));
    writeFileSync(f.release, 'finish');
    await f.wait(() => f.messages.some(message => message.type === 'turn_terminal'
      && message.turnId === 'om_contract' && message.status === 'completed'), 'continued execution terminal');
    const executions = f.controller!.store.executions(f.controller!.ref, 'om_contract');
    expect(executions).toHaveLength(1);
    expect(executions[0]!.phase).toBe('succeeded');
    expect(executions[0]!.runtime).toEqual(f.controller!.currentRuntime());
    f.sendInput('next contract task', 'om_contract_next');
    await f.wait(() => rows(f.submissions).length === 3, 'successor contract input');
    expect(rows(f.submissions).filter(row => row.text === 'original contract task')).toHaveLength(1);
    expect(rows(f.submissions).filter(row => row.text === t('worker.traex_auto_model.continue_prompt'))).toHaveLength(1);
    expect(rows(f.submissions).filter(row => row.text === 'next contract task')).toHaveLength(1);
    const priorMessages = f.messages.length;
    f.sendInput('original contract task', 'om_contract');
    await f.wait(() => f.messages.slice(priorMessages).some(message =>
      (message.type === 'turn_input_committed' || message.type === 'turn_input_rejected')
      && message.turnId === 'om_contract'), 'duplicate input receipt');
    expect(rows(f.submissions)).toHaveLength(3);
    expect(f.hostErrors).toEqual([]);
  }, 70_000);

  it.skipIf(!probeTmuxFunctional().ok)('holds the continuation until a late native identity earns the grant', async () => {
    // The replacement prompt is ready before its resumed rollout is open: the
    // first registration has no native proof, so the queued continuation must
    // wait and re-register instead of being refused as a duplicate.
    const f = await fixture(true, 'ordered', false, undefined, true, undefined, true,
      undefined, 0, 0, false, false, undefined, undefined, undefined, false, false, true, 2_500);
    f.sendInput('original late-proof task', 'om_late_proof');
    await f.wait(() => rows(f.submissions).length === 1, 'original late-proof input');
    await f.wait(() => rows(f.launches).length === 2, 'exact model replacement');
    await f.wait(() => rows(f.submissions).length === 2, 'continuation after late native proof', 30_000);
    expect(rows(f.submissions)[1].text).toBe(t('worker.traex_auto_model.continue_prompt'));
    expect(f.messages.filter(message => message.type === 'turn_input_rejected')).toEqual([]);
    expect(f.hostErrors).toEqual([]);
    expect(f.controller!.store.executions(f.controller!.ref, 'om_late_proof')[0]!.runtime).toEqual(f.controller!.currentRuntime());
  }, 70_000);

  it.skipIf(!probeTmuxFunctional().ok).each(['normal', 'lost-ack', 'persistence-retry'] as const)('abandons a refused continuation reservation without losing queued input (%s)', async mode => {
    const fixtureState = await fixture(true, 'ordered', false, undefined, true, undefined, true,
      undefined, 0, 0, false, false, undefined, undefined, undefined, false, false, true);
    let acknowledgements = 0;
    if (mode === 'lost-ack') {
      const originalSend = fixtureState.child.send.bind(fixtureState.child);
      fixtureState.child.send = ((message: DaemonToWorker, ...args: any[]) => {
        if (message.type === 'continuation_failure_ack' && ++acknowledgements === 1) return true;
        return (originalSend as any)(message, ...args);
      }) as typeof fixtureState.child.send;
    }
    if (mode === 'persistence-retry') {
      vi.spyOn(fixtureState.controller!.store, 'rejectExecutionContinuation')
        .mockImplementationOnce(() => { throw new Error('transient_failure_store'); });
    }
    let cancelled = false;
    fixtureState.child.prependListener('message', (message: WorkerToDaemon) => {
      if (cancelled || message.type !== 'runtime_binding_started' || !message.continuation) return;
      cancelled = true;
      const controller = fixtureState.controller!;
      const execution = controller.store.executions(controller.ref, 'om_reservation_refused')[0]!;
      const operation = controller.beginControl('cancel', undefined, execution.ref).operation;
      controller.controlStarted(operation.operationId);
      controller.controlResult(operation.operationId, 'rejected');
    });
    fixtureState.sendInput('original reservation-refused task', 'om_reservation_refused');
    await fixtureState.wait(() => rows(fixtureState.submissions).length === 1, 'original reservation-refused input');
    fixtureState.sendInput('queued reservation follow-up', 'om_reservation_next');
    await fixtureState.wait(() => rows(fixtureState.submissions).some(row => row.text === 'queued reservation follow-up'),
      'queued input survives refused continuation reservation', 40_000);
    expect(cancelled).toBe(true);
    expect(fixtureState.child.exitCode).toBeNull();
    expect(fixtureState.hostErrors.map(String)).toEqual(mode === 'persistence-retry'
      ? [expect.stringContaining('transient_failure_store')] : []);
    expect(rows(fixtureState.submissions).map(row => row.text)).toEqual([
      'original reservation-refused task', 'queued reservation follow-up',
    ]);
    await fixtureState.wait(() => fixtureState.terminalDeliveries.some(message => message.type === 'turn_terminal'
      && message.turnId === 'om_reservation_refused'), 'host confirms refused execution terminal');
    expect(fixtureState.controller!.store.executions(fixtureState.controller!.ref, 'om_reservation_refused')[0]!.phase).toBe('failed');
    expect(fixtureState.terminalDeliveries.filter(message => message.type === 'turn_terminal'
      && message.turnId === 'om_reservation_refused')).toHaveLength(1);
    expect(fixtureState.noticeDeliveries.filter(message => message.type === 'user_notify'
      && message.message === t('worker.traex_auto_model.continuation_rejected'))).toHaveLength(1);
    if (mode === 'lost-ack') {
      await fixtureState.wait(() => acknowledgements >= 2, 'lost failure acknowledgement retried');
      const terminals = fixtureState.messages.filter(message => message.type === 'turn_terminal'
        && message.turnId === 'om_reservation_refused').length;
      expect(terminals).toBeGreaterThan(1);
      await new Promise(resolveWait => setTimeout(resolveWait, 1_200));
      expect(fixtureState.messages.filter(message => message.type === 'turn_terminal'
        && message.turnId === 'om_reservation_refused')).toHaveLength(terminals);
      expect(fixtureState.terminalDeliveries.filter(message => message.type === 'turn_terminal'
        && message.turnId === 'om_reservation_refused')).toHaveLength(1);
      expect(fixtureState.noticeDeliveries.filter(message => message.type === 'user_notify'
        && message.message === t('worker.traex_auto_model.continuation_rejected'))).toHaveLength(1);
    }
  }, 70_000);

  it.skipIf(!probeTmuxFunctional().ok)('stops and settles a refused contract continuation without replaying it or blocking queued input', async () => {
    const f = await fixture(true, 'ordered', false, undefined, true, undefined, true,
      undefined, 0, 0, false, false, undefined, undefined, undefined, false, false, true);
    let cancelled = false;
    f.child.on('message', (raw: any) => {
      // A stop the Worker could not deliver during the planned teardown leaves
      // cancelRequested on the reserved continuation, so native proof rejects it.
      if (cancelled || raw.type !== 'runtime_binding_started' || !raw.continuation) return;
      cancelled = true;
      const execution = f.controller!.store.executions(f.controller!.ref, 'om_refused')[0]!;
      const operation = f.controller!.beginControl('cancel', undefined, execution.ref).operation;
      f.controller!.controlStarted(operation.operationId);
      f.controller!.controlResult(operation.operationId, 'rejected');
    });
    f.sendInput('original refused task', 'om_refused');
    await f.wait(() => rows(f.submissions).length === 1, 'original refused input');
    f.sendInput('queued follow-up task', 'om_refused_next');
    await f.wait(() => f.noticeDeliveries.some(message => message.type === 'user_notify'
      && message.message === t('worker.traex_auto_model.continuation_rejected')), 'continuation refusal notice', 40_000);
    await f.wait(() => rows(f.submissions).some(row => row.text === 'queued follow-up task'), 'queued follow-up after refusal', 30_000);
    expect(cancelled).toBe(true);
    expect(f.child.exitCode).toBeNull();
    expect(f.hostErrors).toEqual([]);
    expect(rows(f.launches)).toHaveLength(2);
    expect(rows(f.submissions).filter(row => row.text === 'original refused task')).toHaveLength(1);
    expect(rows(f.submissions).filter(row => row.text === t('worker.traex_auto_model.continue_prompt'))).toHaveLength(0);
    expect(f.controller!.store.executions(f.controller!.ref, 'om_refused')[0]!.runtime).not.toEqual(f.controller!.currentRuntime());
    expect(f.messages.filter(message => message.type === 'turn_terminal' && message.turnId === 'om_refused')).toHaveLength(1);
    expect(f.controller!.store.executions(f.controller!.ref, 'om_refused')[0]!.phase).toBe('failed');
    expect(f.terminalDeliveries.filter(message => message.type === 'turn_terminal' && message.turnId === 'om_refused')).toHaveLength(1);
    expect(f.noticeDeliveries.filter(message => message.type === 'user_notify'
      && message.message === t('worker.traex_auto_model.continuation_rejected'))).toHaveLength(1);
  }, 90_000);

  it.skipIf(!probeTmuxFunctional().ok).each(['pending', 'lost-approval', 'missing-native-identity'] as const)('bounds an unanswered continuation grant and releases queued input (%s)', async mode => {
    const fixtureState = await fixture(true, 'ordered', false, undefined, true, undefined, true,
      undefined, 0, 0, false, false, undefined, undefined, undefined, false, false, true,
      mode === 'missing-native-identity' ? 60_000 : 0);
    const controller = fixtureState.controller!;
    const pausedGrant = mode === 'pending' ? vi.spyOn(controller.store, 'commitExecutionContinuation').mockImplementation(() => {}) : undefined;
    const originalSend = fixtureState.child.send.bind(fixtureState.child);
    let withheldApproval: DaemonToWorker | undefined;
    if (mode === 'lost-approval') {
      fixtureState.child.send = ((message: DaemonToWorker, ...args: any[]) => {
        if (message.type === 'runtime_contract_assigned' && message.continuation?.status === 'approved') {
          withheldApproval = message;
          return true;
        }
        return (originalSend as any)(message, ...args);
      }) as typeof fixtureState.child.send;
    }
    fixtureState.sendInput('original ungranted task', 'om_ungranted');
    await fixtureState.wait(() => rows(fixtureState.submissions).length === 1, 'original ungranted input');
    fixtureState.sendInput('queued ungranted follow-up', 'om_ungranted_next');
    await fixtureState.wait(() => rows(fixtureState.launches).length === 2, 'replacement awaiting continuation grant');
    await fixtureState.wait(() => rows(fixtureState.submissions).some(row => row.text === 'queued ungranted follow-up'),
      'bounded grant wait releases queued input', 45_000);
    expect(fixtureState.child.exitCode).toBeNull();
    expect(fixtureState.hostErrors).toEqual([]);
    expect(rows(fixtureState.submissions).map(row => row.text)).toEqual([
      'original ungranted task', 'queued ungranted follow-up',
    ]);
    expect(fixtureState.messages.filter(message => message.type === 'turn_terminal'
      && message.turnId === 'om_ungranted')).toHaveLength(1);
    expect(controller.store.executions(controller.ref, 'om_ungranted')[0]!.phase).toBe('failed');
    expect(fixtureState.noticeDeliveries.filter(message => message.type === 'user_notify'
      && message.message === t('worker.traex_auto_model.continuation_timeout'))).toHaveLength(1);
    pausedGrant?.mockRestore();
    const registration = [...fixtureState.messages].reverse().find(message => message.type === 'runtime_binding');
    expect(registration?.type).toBe('runtime_binding');
    if (registration?.type === 'runtime_binding') {
      controller.bindRuntime(registration.bindingId, registration.sessionContract!.producer, registration.identity);
      expect(controller.store.executionContinuation(controller.ref, registration.bindingId)?.status).toBe('rejected');
    }
    expect(controller.store.executions(controller.ref, 'om_ungranted')[0]!.phase).toBe('failed');
    if (mode === 'lost-approval') {
      expect(withheldApproval).toBeDefined();
      originalSend(withheldApproval!);
      originalSend(withheldApproval!);
      const received = fixtureState.messages.length;
      fixtureState.sendInput('original ungranted task', 'om_ungranted');
      await fixtureState.wait(() => fixtureState.messages.slice(received).some(message =>
        (message.type === 'turn_input_committed' || message.type === 'turn_input_rejected')
        && message.turnId === 'om_ungranted'), 'duplicate remains refused after late approval');
      expect(rows(fixtureState.submissions)).toHaveLength(2);
      expect(fixtureState.messages.filter(message => message.type === 'turn_terminal'
        && message.turnId === 'om_ungranted')).toHaveLength(1);
    }
  }, 90_000);

  it('model access restrictions continue through the ordered pool without replaying the original input', async () => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, false,
      undefined, 0, 0, false, false, { code: 'other', message: 'Model access temporarily restricted.', trigger: 'capacity' });
    f.child.send({ type: 'message', content: 'original restricted task', turnId: 'om_access' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(message => message.type === 'turn_terminal' && message.turnId === 'om_access' && message.status === 'completed'), 'restriction recovery complete');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.launches).slice(1).every(row => row.args.includes(f.nativeId))).toBe(true);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original restricted task'))).toHaveLength(1);
    expect(f.messages.filter(message => message.type === 'turn_terminal' && message.turnId === 'om_access')).toHaveLength(1);
    expect(rows(f.rpcRequests).filter(row => row.method === 'model/list')).toHaveLength(2);
    expect(f.messages.filter(message => message.type === 'active_runtime' && message.traexAutoModelRuntime?.modelAccessRecovery?.blockedModels.length === 2).length).toBeGreaterThan(0);
  }, 45_000);

  it.each([0, 400])('model access restrictions also skip confirmed quota failures during the same capacity search (receipt delay %sms)', async receiptDelayMs => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, false,
      undefined, 0, 0, false, false, { code: 'other', message: 'Model access temporarily restricted.', trigger: 'capacity',
        modelErrors: { backup: { codex_error_info: 'usage_limit_exceeded', message: 'Usage quota exhausted' } },
      }, receiptDelayMs ? { submission: 1, ms: receiptDelayMs } : undefined);
    f.child.send({ type: 'message', content: 'mixed access and quota task', turnId: 'om_access_quota' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(message => message.type === 'turn_terminal' && message.turnId === 'om_access_quota' && message.status === 'completed'), 'mixed failure recovery complete');
    if (receiptDelayMs) expect(f.logs.join('')).toContain('after unconfirmed submit turn=om_access_quota');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('mixed access and quota task'))).toHaveLength(1);
    expect(f.messages.filter(message => message.type === 'turn_terminal' && message.turnId === 'om_access_quota')).toHaveLength(1);
  }, 45_000);

  it('model access restrictions retain a queued candidate while checking for a later non-queued model', async () => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, false,
      undefined, 0, 0, false, false, { code: 'other', message: 'Model access temporarily restricted.', trigger: 'capacity', queueModels: ['backup'] });
    f.child.send({ type: 'message', content: 'restricted then queued task', turnId: 'om_access_queue' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(message => message.type === 'turn_terminal' && message.turnId === 'om_access_queue' && message.status === 'completed'), 'later non-queued model complete');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('restricted then queued task'))).toHaveLength(1);
  }, 45_000);

  it('model access restrictions hold a genuinely queued candidate when the remaining models all queue', async () => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, false,
      undefined, 0, 0, false, false, { code: 'other', message: 'Model access temporarily restricted.', trigger: 'capacity', queueModels: ['backup', 'last'] });
    f.child.send({ type: 'message', content: 'restricted all remaining queued', turnId: 'om_access_wait' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(message => message.type === 'active_runtime' && message.traexAutoModelRuntime?.waitingOnFinalModel && message.model === 'last'), 'queued candidate held');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(f.messages.filter(message => message.type === 'turn_terminal' && message.turnId === 'om_access_wait')).toHaveLength(0);
    writeFileSync(f.release, '1');
    await f.wait(() => f.messages.some(message => message.type === 'turn_terminal' && message.turnId === 'om_access_wait' && message.status === 'completed'), 'held queue released');
    expect(rows(f.submissions).filter(row => row.text.startsWith('restricted all remaining queued'))).toHaveLength(1);
  }, 45_000);

  it('model access restrictions stop once when every configured model refuses access', async () => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, false,
      undefined, 0, 0, false, false, { code: 'other', message: 'Model access temporarily restricted.', trigger: 'capacity', exhaustLast: true });
    f.child.send({ type: 'message', content: 'all access restricted', turnId: 'om_access_exhausted' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(message => message.type === 'turn_terminal' && message.turnId === 'om_access_exhausted' && message.status === 'failed'), 'all access refusals settled');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('all access restricted'))).toHaveLength(1);
    expect(f.messages.filter(message => message.type === 'turn_terminal' && message.turnId === 'om_access_exhausted')).toHaveLength(1);
  }, 45_000);
});
