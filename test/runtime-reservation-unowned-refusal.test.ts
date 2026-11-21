/**
 * A /repo switch closes the session and forks its replacement worker on the
 * same topic. 2026-11-18, daemon v3.59.10: every such replacement logged
 * "Daemon refused runtime reservation …; the lifecycle operation that owns the
 * session takes over", started no CLI, and stayed listed as online and idle
 * until someone ran /close. The refused reservation sat in the closed
 * predecessor's contract: the reused DaemonSession kept a controller pinned to
 * the old session, so the new worker was bound to a retired contract. Nothing
 * owned that refusal, so nothing ever started the CLI.
 *
 * Real worker start path (spawnCli and its contract IPC handler) against the
 * real daemon handler, controllers and contract store; the CLI launch itself is
 * stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { controllerForSession, type SessionController } from '../src/core/session-controller.js';
import { sameWorker } from '../src/services/session-contract.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { isTransientStartupFailure } from '../src/core/worker-startup-retry.js';
import { chatSafeFatalErrorMessage } from '../src/core/startup-failure-reason.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { appendUnsentInputs, saveUnsentInputs, settleTakenUnsentInputs, takeUnsentInputs } from '../src/services/unsent-input-journal.js';
import { RuntimeReservationRefusedError, runtimeStartRefusal } from '../src/services/runtime-reservation.js';
import type { DaemonSession } from '../src/core/types.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';

const CHAT_ID = 'oc_unowned_refusal';
const ROOT_ID = 'om_unowned_refusal_root';

let appSeq = 0;
let app: string;
let dataDir: string;
let previousDataDir: string;
let opened: SessionController[];

function makeSession(sessionId: string) {
  return { sessionId, larkAppId: app, status: 'active' as const, scope: 'thread' as const, chatId: CHAT_ID, rootMessageId: ROOT_ID };
}

/** The topic's live DaemonSession with its first session's controller, closed
 *  the way /repo closes it, then a replacement session swapped into the same
 *  object (command-handler's mid-session switch). */
function switchedOwner() {
  const ds = { larkAppId: app, scope: 'thread', chatId: CHAT_ID, session: makeSession('session-a'), initConfig: {} } as unknown as DaemonSession;
  const predecessor = controllerForSession(ds, true)!;
  opened.push(predecessor);
  predecessor.bindWorker(1);
  const { operation } = predecessor.beginControl('close');
  predecessor.controlResult(operation.operationId, 'confirmed');
  expect(predecessor.store.read(predecessor.ref)!.lifecycle).toBe('closed');
  ds.session = makeSession('session-b') as DaemonSession['session'];
  return { ds, predecessor };
}

/** The replacement worker `controller` hands its contract to, wired to the
 *  daemon's real handler. */
function replacementWorker(ds: DaemonSession, controller: SessionController) {
  const bootstrap = controller.bindWorker(2);
  const sent: any[] = []; const received: any[] = [];
  const env: any = { workerSessionEventScope: new WorkerSessionEventScope(bootstrap.session, bootstrap.worker), pendingRuntimeReservations: new Map(),
    activeRestartAttemptId: undefined, closeRequested: false, initialInputOwnershipPending: false,
    spawnCliBody: vi.fn(async () => {}), publishRuntimeContract: vi.fn(async () => {}),
    CliSpawnSupersededError: class extends Error {}, log: vi.fn() };
  const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
  const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', env);
  const child = { send: vi.fn((message: any) => { received.push(message); void receive(message); }) };
  ds.worker = child as unknown as DaemonSession['worker'];
  const warn = vi.fn();
  const hostScope: any = { sessionController: controller, contractWorker: bootstrap.worker, ds, worker: child, sameWorker,
    logger: { warn, debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
  const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope); hostScope.handleWorkerMessage = host;
  env.send = (message: any) => { const scoped = metadata(message); sent.push(scoped); void host(scoped); };
  const spawn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', env);
  return { env, sent, received, warn, start: () => spawn({ prompt: '', resume: false }) };
}

beforeEach(() => {
  app = `cli_unowned_refusal_${++appSeq}`;
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-unowned-refusal-'));
  config.session.dataDir = dataDir;
  opened = [];
});

afterEach(() => {
  for (const controller of opened.splice(0)) {
    try { controller.store.close(); } catch { /* contract store is shared per app */ }
  }
  config.session.dataDir = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the replacement worker of a /repo switch on the same topic', () => {
  it('is bound to the replacement session contract and starts its CLI', async () => {
    const { ds, predecessor } = switchedOwner();
    // forkWorker for the replacement resolves the controller again.
    const controller = controllerForSession(ds, true)!;
    opened.push(controller);
    expect(controller.ref.sessionId).toBe('session-b');

    const worker = replacementWorker(ds, controller);
    await expect(worker.start()).resolves.toBeUndefined();

    expect(worker.env.spawnCliBody).toHaveBeenCalledOnce();
    expect(worker.received.find(message => message.type === 'runtime_contract_reserved')).toMatchObject({ mayStart: true });
    // Nothing was reserved on the closed predecessor.
    expect(predecessor.store.read(predecessor.ref)!.lifecycle).toBe('closed');
    expect(predecessor.store.read(predecessor.ref)!.worker?.generation).toBe(1);
  });

  it('whose reservation lands in the closed predecessor contract fails its start instead of idling with no CLI', async () => {
    const { ds, predecessor } = switchedOwner();
    // The worker is bound through the controller still pinned to the closed
    // predecessor: the daemon holds it as the live owner of an active session
    // while its contract is closed and no operation is in flight.
    const worker = replacementWorker(ds, predecessor);
    const failure = await worker.start().then(() => undefined, (error: unknown) => error);

    expect(worker.received.find(message => message.type === 'runtime_contract_reserved'))
      .toMatchObject({ mayStart: false, startRefusal: 'unowned' });
    expect(failure).toBeInstanceOf(RuntimeReservationRefusedError);
    expect(failure).not.toBeInstanceOf(worker.env.CliSpawnSupersededError);
    // A startup failure: the worker exits and the daemon retries, so the next
    // start (or message) brings the CLI up instead of finding a live-looking shell.
    expect(isTransientStartupFailure(chatSafeFatalErrorMessage(failure))).toBe(true);
    expect(worker.env.spawnCliBody).not.toHaveBeenCalled();
    expect(worker.sent.map(message => message.type)).toContain('runtime_binding_aborted');
    expect(worker.warn).toHaveBeenCalledWith(expect.stringContaining('no lifecycle operation'));
  });

  it('keeps the takeover contract when a close operation owns the refusal', async () => {
    const ds = { larkAppId: app, scope: 'thread', chatId: CHAT_ID, session: makeSession('session-c'), initConfig: {} } as unknown as DaemonSession;
    const controller = controllerForSession(ds, true)!;
    opened.push(controller);
    const worker = replacementWorker(ds, controller);
    // A /close begins while the start is waiting for the daemon.
    controller.beginControl('close');
    const failure = await worker.start().then(() => undefined, (error: unknown) => error);

    const reply = worker.received.find(message => message.type === 'runtime_contract_reserved');
    expect(reply.mayStart).toBe(false);
    expect(reply.startRefusal).toBeUndefined();
    expect(failure).toBeInstanceOf(worker.env.CliSpawnSupersededError);
    expect(worker.env.spawnCliBody).not.toHaveBeenCalled();
  });
});

describe('which refusals have an operation that takes the start over', () => {
  const live = { workerIsLiveOwner: true };
  it.each([
    ['a retired contract with nothing in flight', { mayStart: false, lifecycle: 'closed' }, 'unowned'],
    ['a suspended contract with nothing in flight', { mayStart: false, lifecycle: 'suspended' }, 'unowned'],
    ['a close in flight', { mayStart: false, lifecycle: 'closing', activeOperationId: 'op' }, undefined],
    ['a restart owning an active contract', { mayStart: false, lifecycle: 'active', activeOperationId: 'op' }, undefined],
    ['a start that is granted', { mayStart: true, lifecycle: 'active' }, undefined],
    ['a binding the worker already abandoned', { mayStart: false, lifecycle: 'active' }, undefined],
  ] as const)('%s', (_name, input, expected) => {
    expect(runtimeStartRefusal({ ...live, ...input })).toBe(expected);
  });

  it('is never unowned for a worker the daemon no longer holds as the live owner', () => {
    expect(runtimeStartRefusal({ mayStart: false, lifecycle: 'closed', workerIsLiveOwner: false })).toBeUndefined();
  });
});

describe('a worker whose start was refused with no owner exits like any startup failure', () => {
  it('hands the inputs queued behind the failed start to the next worker', async () => {
    const data = mkdtempSync(join(tmpdir(), 'botmux-unowned-journal-'));
    try {
      const pendingMessages = [{ content: 'asked while the start waited', turnId: 'om_waiting' }];
      const env: any = { process: { env: { SESSION_DATA_DIR: data }, exit: vi.fn(), pid: process.pid, kill: vi.fn() },
        sessionId: 'session-1', join, lastInitConfig: { cliId: 'claude-code' }, isCodexAppCliId,
        appendUnsentInputs, saveUnsentInputs, settleTakenUnsentInputs, takeUnsentInputs, pendingMessages, restoredUnsentInputs: new Set(),
        predecessorUnsentInputsTaken: false, appendedUnsentInputs: new WeakSet(),
        log: vi.fn(), send: vi.fn(), t: (key: string) => key, fatalWorkerErrorPending: false,
        pendingLaunchConvergence: undefined, activeRestartAttemptId: undefined,
        currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined,
        sendAndFlush: vi.fn(async () => {}), chatSafeFatalErrorMessage, sandboxNamespaceDiagnosis: () => undefined };
      env.unsentInputJournalPath = loadWorkerFunction('unsentInputJournalPath', env);
      env.saveUnsentInputsForSuccessor = loadWorkerFunction('saveUnsentInputsForSuccessor', env);
      env.takeUnsentInputsFromPredecessor = loadWorkerFunction('takeUnsentInputsFromPredecessor', env);
      const fatal = loadWorkerFunction<(error: unknown) => Promise<void>>('sendFatalWorkerErrorAndExit', env);

      await fatal(new RuntimeReservationRefusedError());

      expect(env.process.exit).toHaveBeenCalledWith(1);
      expect(env.sendAndFlush).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
      const successor = { ...env, pendingMessages: [], restoredUnsentInputs: new Set(), send: vi.fn() };
      expect(successor.takeUnsentInputsFromPredecessor({ cliId: 'claude-code' }).map((input: any) => input.content))
        .toEqual(['asked while the start waited']);
    } finally { rmSync(data, { recursive: true, force: true }); }
  });
});
