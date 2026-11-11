// A worker that ends its generation because the daemon retired its runtime
// (core/retired-runtime-exit.ts) hands what it queued to the next worker, and
// the daemon starts that successor at once instead of leaving the input until
// another message arrives. A message still on its way over IPC never reached
// the worker, so it ran nowhere and nothing redelivers it: the group must be
// asked to resend it if it did not run, as after a suspend — not told the
// outcome is unknown and not to resend, which is what an unexplained worker
// crash gets. Drives the daemon's real worker IPC handlers and ordinary IM
// delivery tracking.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as bots from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import { RETIRED_RUNTIME_SUCCESSOR_COOLDOWN_MS, WORKER_EXIT_RUNTIME_RETIRED } from '../src/core/retired-runtime-exit.js';
import { saveUnsentInputs, unsentInputJournalFile } from '../src/services/unsent-input-journal.js';
import { t } from '../src/i18n/index.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'cli_retired_runtime_exit';
const TURN = 'om_in_flight';
const caller = { requestUserOpenId: 'ou_sender', requestLarkAppId: APP, senderType: 'user' as const };

let dir: string;
let previousDataDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retired-runtime-exit-'));
  previousDataDir = config.session.dataDir; config.session.dataDir = dir;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({
    config: { larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'RetiredBot',
  } as any);
});

afterEach(() => {
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  workerPool.__testOnly_setRetiredRuntimeSuccessorStarter();
  config.session.dataDir = previousDataDir;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const SESSION = 'retired-runtime-session';

/** A ready worker of the session, through the daemon's real IPC handlers. */
async function readyWorker(sessionReply = vi.fn(async (..._args: unknown[]) => 'om_reply'), ds?: DaemonSession) {
  workerPool.initWorkerPool({ sessionReply, getSessionWorkingDir: () => dir, getActiveCount: () => 1, closeSession: vi.fn() } as any);
  const worker = new EventEmitter() as any;
  worker.killed = false; worker.connected = true; worker.pid = process.pid;
  worker.kill = vi.fn(); worker.stdout = new EventEmitter(); worker.stderr = new EventEmitter();
  worker.send = vi.fn(() => true);
  const generation = (ds?.workerGeneration ?? 0) + 1;
  ds ??= {
    session: { sessionId: SESSION, chatId: 'oc_group', chatType: 'group', status: 'active', cliId: 'claude-code',
      createdAt: new Date().toISOString(), workerGeneration: generation,
      replyTargets: { [TURN]: { rootMessageId: TURN, senderOpenId: caller.requestUserOpenId, updatedAt: new Date().toISOString() } } },
    larkAppId: APP, chatId: 'oc_group', chatType: 'group', scope: 'chat',
    workerPort: 0, workerToken: 'token', initConfig: { type: 'init', cliId: 'claude-code', backendType: 'tmux' },
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: true,
  } as unknown as DaemonSession;
  (ds as any).worker = worker; (ds as any).workerGeneration = generation; ds.session.workerGeneration = generation;
  workerPool.__testOnly_setupWorkerHandlers(ds, worker, undefined, generation);
  await Promise.all(worker.listeners('message').map((listener: (m: unknown) => unknown) => listener({ type: 'ready', port: 0, token: 'token' })));
  return { ds, worker, sessionReply };
}

/** A message the daemon has handed to IPC that the worker has not received
 *  yet when it exits with `code`. */
async function exitWithMessageInFlight(code: number) {
  const { ds, worker, sessionReply } = await readyWorker();
  expect(workerPool.sendWorkerInput(ds, 'a question', TURN, { trustedCaller: caller })).toBe(true);
  expect(workerPool.hasPendingOrdinaryImDelivery(ds)).toBe(true);
  worker.emit('exit', code, null);
  await vi.waitFor(() => expect(sessionReply).toHaveBeenCalled());
  return { ds, notices: sessionReply.mock.calls.map(args => String(args[1])) };
}

/** The worker left a queued input in the session's journal for its successor. */
const handOver = () => saveUnsentInputs(unsentInputJournalFile(dir, SESSION), [{ turnId: TURN, content: 'a queued question' } as any]);

/** Let the exit handler's after-reconcile step run. */
const settle = () => new Promise(done => setTimeout(done, 20));

const rendered = (key: string) => (['zh', 'en'] as const).map(locale => t(key, { turnId: TURN }, locale));

describe('a worker that ended its generation after its runtime was retired', () => {
  it('asks the group to resend a message that was still on its way to it', async () => {
    const { ds, notices } = await exitWithMessageInFlight(WORKER_EXIT_RUNTIME_RETIRED);
    expect(notices.filter(text => rendered('worker.input_retired_unconfirmed').includes(text))).toHaveLength(1);
    expect(notices.some(text => rendered('worker.input_delivery_failed').includes(text))).toBe(false);
    expect(ds.worker).toBeNull();
    expect(workerPool.hasPendingOrdinaryImDelivery(ds)).toBe(false);
  });

  it('still reports an unexplained worker exit as an unknown outcome', async () => {
    const { notices } = await exitWithMessageInFlight(1);
    expect(notices.filter(text => rendered('worker.input_delivery_failed').includes(text))).toHaveLength(1);
    expect(notices.some(text => rendered('worker.input_retired_unconfirmed').includes(text))).toBe(false);
  });

  it('starts a successor at once for the input it handed over, but not in a loop', async () => {
    const started: DaemonSession[] = [];
    workerPool.__testOnly_setRetiredRuntimeSuccessorStarter(ds => { started.push(ds); return true; });
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    handOver();
    const first = await readyWorker();
    first.worker.emit('exit', WORKER_EXIT_RUNTIME_RETIRED, null);
    await settle();
    expect(started).toEqual([first.ds]);

    // That successor is retired too and hands the input over again: it waits
    // for the next message rather than starting yet another worker.
    const second = await readyWorker(undefined, first.ds);
    second.worker.emit('exit', WORKER_EXIT_RUNTIME_RETIRED, null);
    await settle();
    expect(started).toHaveLength(1);

    // Later on, a retirement starts a successor again.
    now.mockReturnValue(1_000_000 + RETIRED_RUNTIME_SUCCESSOR_COOLDOWN_MS);
    const third = await readyWorker(undefined, first.ds);
    third.worker.emit('exit', WORKER_EXIT_RUNTIME_RETIRED, null);
    await settle();
    expect(started).toHaveLength(2);
  });

  it('leaves a session alone when the retired worker handed nothing over or did not end that way', async () => {
    const started: DaemonSession[] = [];
    workerPool.__testOnly_setRetiredRuntimeSuccessorStarter(ds => { started.push(ds); return true; });
    const empty = await readyWorker();
    empty.worker.emit('exit', WORKER_EXIT_RUNTIME_RETIRED, null);
    await settle();
    expect(started).toEqual([]);
    expect(empty.ds.worker).toBeNull();

    handOver();
    const crashed = await readyWorker(undefined, empty.ds);
    crashed.worker.emit('exit', 1, null);
    await settle();
    expect(started).toEqual([]);

    const closed = await readyWorker(undefined, empty.ds);
    closed.ds.session.status = 'closed';
    closed.worker.emit('exit', WORKER_EXIT_RUNTIME_RETIRED, null);
    await settle();
    expect(started).toEqual([]);
  });
});
