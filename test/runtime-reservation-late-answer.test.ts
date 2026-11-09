/**
 * A worker's CLI start waits for the daemon to confirm its runtime reservation.
 * A daemon restart re-attaches a full live-worker cap of sessions while the
 * daemon is busy restoring every other one, and the daemon answers the starts
 * one after another: the re-attach at the cap is answered last, 16 s after it
 * asked. That answer must still start the CLI; only a start the daemon never
 * answers fails, as a startup failure the daemon heals by forking again, and
 * the inputs queued behind it go to that next worker.
 *
 * Real worker start path (spawnCli and its contract IPC handler) against the
 * real daemon handler, controllers and contract store; the CLI launch itself is
 * stubbed. Fake clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { sameWorker } from '../src/services/session-contract.js';
import { isTransientStartupFailure } from '../src/core/worker-startup-retry.js';
import { chatSafeFatalErrorMessage } from '../src/core/startup-failure-reason.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { appendUnsentInputs, saveUnsentInputs, settleTakenUnsentInputs, takeUnsentInputs } from '../src/services/unsent-input-journal.js';
import {
  RUNTIME_RESERVATION_DEADLINE_MS,
  RUNTIME_RESERVATION_UNCONFIRMED,
  RuntimeReservationExpiredError,
} from '../src/services/runtime-reservation.js';
import type { DaemonSession } from '../src/core/types.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';

const fixtureConfig = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return fixtureConfig.dataDir; } } } }));

/** The default live-worker cap: a restart re-attaching that many sessions. */
const LIVE_WORKER_CAP = 30;
/** What one worker message costs a daemon that is restoring every session. */
const DAEMON_MS_PER_MESSAGE = 550;

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const handle of handles.splice(0)) try { handle.close(); } catch { /* already closed */ }
  for (const data of directories.splice(0)) rmSync(data, { recursive: true, force: true });
});

function scratch(): string {
  const data = mkdtempSync(join(tmpdir(), 'reservation-late-')); directories.push(data);
  return data;
}

/** A daemon that handles worker messages one at a time, in arrival order. */
function busyDaemon(msPerMessage: number): (work: () => Promise<void>) => Promise<void> {
  let busyUntil = 0;
  return work => {
    busyUntil = Math.max(Date.now(), busyUntil) + msPerMessage;
    return new Promise<void>(resolve => setTimeout(resolve, busyUntil - Date.now())).then(work);
  };
}

/** One session's freshly forked re-attach worker, wired to the daemon's real
 *  handler through `daemon`, which decides when (and whether) it handles a message. */
function reattachingWorker(store: SessionContractStore, index: number, daemon: (work: () => Promise<void>) => Promise<void> | void) {
  const appId = 'cli_reservation_test'; const ref = { appId, sessionId: `session-${index}` };
  const ds = { larkAppId: appId, chatId: 'oc_test', session: { sessionId: ref.sessionId, larkAppId: appId, status: 'active' }, cliReadyGeneration: 0 } as DaemonSession;
  const controller = new SessionController(ds, store); const worker = controller.bindWorker(1).worker;
  const sent: any[] = [];
  let askedAt: number | undefined; let answeredAt: number | undefined;
  const env: any = { workerSessionEventScope: new WorkerSessionEventScope(ref, worker), pendingRuntimeReservations: new Map(),
    activeRestartAttemptId: undefined, closeRequested: false, initialInputOwnershipPending: false,
    spawnCliBody: vi.fn(async () => {}), publishRuntimeContract: vi.fn(async () => {}),
    CliSpawnSupersededError: class extends Error {}, log: vi.fn() };
  const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
  const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', env);
  const child = { send: vi.fn((message: any) => {
    if (message.type === 'runtime_contract_reserved') answeredAt ??= Date.now();
    void receive(message);
  }) };
  ds.worker = child as any;
  const hostScope: any = { sessionController: controller, contractWorker: worker, ds, worker: child, sameWorker,
    logger: { warn: vi.fn(), debug: vi.fn() }, t: ref.sessionId, handleLegacyWorkerMessage: vi.fn() };
  const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope); hostScope.handleWorkerMessage = host;
  env.send = (message: any) => {
    if (message.type === 'runtime_binding_started') askedAt ??= Date.now();
    const scoped = metadata(message); sent.push(scoped);
    void daemon(() => host(scoped));
  };
  const spawn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', env);
  return {
    ref, env, sent, start: () => spawn({ prompt: '', resume: true }),
    answerLagMs: () => (askedAt !== undefined && answeredAt !== undefined ? answeredAt - askedAt : undefined),
  };
}

/** One worker of session-1 with `pendingMessages` queued: its real fatal exit
 *  and unsent-input journal hand-off. `tookPredecessorInputs` is a worker whose
 *  init got as far as taking its predecessor's inputs back. */
function exitingWorker(data: string, pendingMessages: unknown[], tookPredecessorInputs = false) {
  const env: any = { process: { env: { SESSION_DATA_DIR: data }, exit: vi.fn(), pid: process.pid, kill: vi.fn() },
    sessionId: 'session-1', join, lastInitConfig: { cliId: 'claude-code' }, isCodexAppCliId,
    appendUnsentInputs, saveUnsentInputs, settleTakenUnsentInputs, takeUnsentInputs, pendingMessages, restoredUnsentInputs: new Set(),
    predecessorUnsentInputsTaken: tookPredecessorInputs, appendedUnsentInputs: new WeakSet(),
    log: vi.fn(), send: vi.fn(), t: (key: string) => key, fatalWorkerErrorPending: false,
    pendingLaunchConvergence: undefined, activeRestartAttemptId: undefined,
    currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined,
    sendAndFlush: vi.fn(async () => {}), chatSafeFatalErrorMessage, sandboxNamespaceDiagnosis: () => undefined };
  env.unsentInputJournalPath = loadWorkerFunction('unsentInputJournalPath', env);
  env.saveUnsentInputsForSuccessor = loadWorkerFunction('saveUnsentInputsForSuccessor', env);
  env.takeUnsentInputsFromPredecessor = loadWorkerFunction('takeUnsentInputsFromPredecessor', env);
  return { env, fatal: loadWorkerFunction<(error: unknown) => Promise<void>>('sendFatalWorkerErrorAndExit', env) };
}

describe('a CLI start waiting on the daemon to confirm its runtime reservation', () => {
  it('the re-attach that lands at the live-worker cap, answered last by a busy daemon, still starts its CLI', async () => {
    vi.useFakeTimers();
    const data = scratch(); fixtureConfig.dataDir = data;
    const store = new SessionContractStore(data, 'cli_reservation_test'); handles.push(store);
    const daemon = busyDaemon(DAEMON_MS_PER_MESSAGE);
    const workers = Array.from({ length: LIVE_WORKER_CAP }, (_, i) => reattachingWorker(store, i + 1, daemon));
    const starts = Promise.allSettled(workers.map(worker => worker.start()));
    await vi.advanceTimersByTimeAsync(LIVE_WORKER_CAP * DAEMON_MS_PER_MESSAGE + 1_000);
    const outcomes = await starts;

    const atCap = workers.at(-1)!;
    expect(atCap.answerLagMs()).toBeGreaterThan(16_000);
    expect(outcomes.map(outcome => outcome.status)).toEqual(workers.map(() => 'fulfilled'));
    for (const worker of workers) {
      expect(worker.env.spawnCliBody, worker.ref.sessionId).toHaveBeenCalledOnce();
      expect(worker.sent.map(message => message.type), worker.ref.sessionId).not.toContain('runtime_binding_aborted');
    }
    expect(store.binding(atCap.ref, atCap.sent[0].bindingId)?.phase).toBe('starting');
  });

  it('a start the daemon never answers fails at the deadline as a transient startup failure, not as superseded', async () => {
    vi.useFakeTimers();
    const data = scratch(); fixtureConfig.dataDir = data;
    const store = new SessionContractStore(data, 'cli_reservation_test'); handles.push(store);
    const worker = reattachingWorker(store, 1, () => undefined);
    const failure = worker.start().then(() => undefined, (error: unknown) => error);

    await vi.advanceTimersByTimeAsync(RUNTIME_RESERVATION_DEADLINE_MS - 1);
    expect(worker.sent.map(message => message.type)).toEqual(['runtime_binding_started']);
    await vi.advanceTimersByTimeAsync(2);
    const error = await failure;
    expect(error).toBeInstanceOf(RuntimeReservationExpiredError);
    expect(error).not.toBeInstanceOf(worker.env.CliSpawnSupersededError);
    expect(isTransientStartupFailure(chatSafeFatalErrorMessage(error))).toBe(true);
    expect(worker.env.spawnCliBody).not.toHaveBeenCalled();
    expect(worker.sent.map(message => message.type)).toContain('runtime_binding_aborted');
  });

  it('the inputs queued behind a start that expired unanswered are typed by the next worker', async () => {
    const data = scratch();
    const otherFailure = exitingWorker(data, [{ content: 'queued behind a broken launch', turnId: 'om_broken' }]);
    await otherFailure.fatal(new Error('claude: command not found'));
    expect(exitingWorker(data, []).env.takeUnsentInputsFromPredecessor({ cliId: 'claude-code' })).toEqual([]);

    const expired = exitingWorker(data, [{ content: 'asked while the start waited', turnId: 'om_waiting' }]);
    await expired.fatal(new RuntimeReservationExpiredError());
    expect(expired.env.process.exit).toHaveBeenCalledWith(1);
    expect(expired.env.sendAndFlush).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringContaining(RUNTIME_RESERVATION_UNCONFIRMED),
    }));
    const successor = exitingWorker(data, []);
    expect(successor.env.takeUnsentInputsFromPredecessor({ cliId: 'claude-code' }).map((input: any) => input.content))
      .toEqual(['asked while the start waited']);
  });

  it('what the restart saved survives starts that expire before taking it back, one after another, ahead of what they queued', async () => {
    const data = scratch();
    exitingWorker(data, [{ content: 'queued when the daemon restarted', turnId: 'om_restart' }], true)
      .env.saveUnsentInputsForSuccessor('parent exit');
    await exitingWorker(data, [{ content: 'asked while the first retry waited', turnId: 'om_first' }])
      .fatal(new RuntimeReservationExpiredError());
    await exitingWorker(data, []).fatal(new RuntimeReservationExpiredError());

    const started = exitingWorker(data, []);
    expect(started.env.takeUnsentInputsFromPredecessor({ cliId: 'claude-code' }).map((input: any) => input.content))
      .toEqual(['queued when the daemon restarted', 'asked while the first retry waited']);
    expect(started.env.send).not.toHaveBeenCalled();
  });

  it('a worker that took the inputs back hands the ones it never typed in on once, not as unconfirmed', async () => {
    const data = scratch();
    exitingWorker(data, [{ content: 'queued when the daemon restarted', turnId: 'om_restart' }], true)
      .env.saveUnsentInputsForSuccessor('parent exit');
    const restored = exitingWorker(data, []);
    restored.env.pendingMessages.push(...restored.env.takeUnsentInputsFromPredecessor({ cliId: 'claude-code' }));
    await restored.fatal(new RuntimeReservationExpiredError());

    const next = exitingWorker(data, []);
    expect(next.env.takeUnsentInputsFromPredecessor({ cliId: 'claude-code' }).map((input: any) => input.content))
      .toEqual(['queued when the daemon restarted']);
    expect(next.env.send).not.toHaveBeenCalled();
  });

  it('a fatal exit cut short by the parent exit hands each queued input on once, including one that arrived in between', async () => {
    const data = scratch();
    exitingWorker(data, [{ content: 'queued when the daemon restarted', turnId: 'om_restart' }], true)
      .env.saveUnsentInputsForSuccessor('parent exit');
    const expiring = exitingWorker(data, [{ content: 'asked while the start waited', turnId: 'om_waiting' }]);
    let delivered!: () => void;
    expiring.env.sendAndFlush = vi.fn(() => new Promise<void>(resolve => { delivered = resolve; }));
    const fatal = expiring.fatal(new RuntimeReservationExpiredError());
    expiring.env.pendingMessages.push({ content: 'asked while the error was on its way', turnId: 'om_between' });
    expiring.env.saveUnsentInputsForSuccessor('IPC disconnect');
    delivered(); await fatal;

    expect(exitingWorker(data, []).env.takeUnsentInputsFromPredecessor({ cliId: 'claude-code' }).map((input: any) => input.content))
      .toEqual(['queued when the daemon restarted', 'asked while the start waited', 'asked while the error was on its way']);
  });

  it('an input queued behind a start that expired a day after the last save is delivered; only the day-old one is reported', async () => {
    vi.useFakeTimers();
    const data = scratch();
    vi.setSystemTime(0);
    exitingWorker(data, [{ content: 'queued at suspend', turnId: 'om_old' }], true).env.saveUnsentInputsForSuccessor('suspend');
    vi.setSystemTime(30 * 60 * 60 * 1000);
    await exitingWorker(data, [{ content: 'asked while the resume waited', turnId: 'om_fresh' }]).fatal(new RuntimeReservationExpiredError());
    vi.setSystemTime(30 * 60 * 60 * 1000 + 5 * 60 * 1000);

    const next = exitingWorker(data, []);
    next.env.t = (key: string, params: unknown) => `${key} ${JSON.stringify(params)}`;
    expect(next.env.takeUnsentInputsFromPredecessor({ cliId: 'claude-code' }).map((input: any) => input.content))
      .toEqual(['asked while the resume waited']);
    expect(next.env.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'user_notify', message: 'worker.unsent_inputs_expired {"count":1}', turnId: 'om_old',
    }));
  });
});
