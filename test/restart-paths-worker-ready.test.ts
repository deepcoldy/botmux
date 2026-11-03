/**
 * Behavioural regression for #1863: every in-worker restart path must release
 * the lifecycle fence on its correlated receipt.
 *
 * An in-worker respawn never re-emits the process-level `ready`, so once a
 * path lowers `ds.workerReady` the attemptId-matched `restart_result:
 * succeeded` is the only edge that may lift it again (#1032 wired that edge for
 * IM /restart and the card button). Three more paths used to lower the fence
 * and then send a restart WITHOUT an attemptId — the worker never answers such
 * a restart, so fork / relay stayed `worker_busy` forever while the terminal
 * already looked idle:
 *
 *   1. CLI crash auto-restart  (worker-pool `claude_exit`, reason `cli_crash`)
 *   2. dashboard restart button (`POST /api/sessions/:id/restart`, `operator`)
 *   3. role-switch cwd move     (`POST /api/sessions/:id/cd`, `updateWorkingDir`)
 *
 * Everything below drives the REAL code: the worker-pool IPC handler
 * (`__testOnly_setupWorkerHandlers` + fake worker EventEmitter, mirroring
 * restart-worker-ready-lifecycle.test.ts) and the REAL IPC routes (port 0 +
 * fetch, mirroring ipc-cd-route.test.ts). Only disk/network edges are stubbed.
 *
 * Run:  bun run vitest run test/restart-paths-worker-ready.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import * as larkClient from '../src/im/lark/client.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const APP_ID = 'app_restart_paths';
/** Rotating per-turn capability the CLI presents to the session-scoped cd route. */
const CAP = 'cafebabe'.repeat(8);

let handle: IpcServerHandle | null = null;
let prevHome: string | undefined;
let fakeHome: string;
let roleDir: string;
let roleDirReal: string;

beforeAll(() => {
  // validateRoleLibraryPath resolves the role-library root from os.homedir()
  // on every call (see ipc-cd-route.test.ts); the per-bot subtree is named by
  // the bot's appId.
  fakeHome = mkdtempSync(join(tmpdir(), 'restart-paths-home-'));
  roleDir = join(fakeHome, 'botmux-roles', APP_ID, 'role-a');
  mkdirSync(roleDir, { recursive: true });
  roleDirReal = realpathSync(roleDir);
  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

beforeEach(() => {
  workerPool.__testOnly_resetRestartCoordinator();
  workerPool.restartCounts.clear();
  registerBot({ larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' });
  // Disk / network edges only.
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
  vi.spyOn(larkClient, 'replyMessage').mockResolvedValue('om_notice');
  vi.spyOn(larkClient, 'sendMessage').mockResolvedValue('om_notice');
  workerPool.initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/tmp',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
});

afterEach(async () => {
  vi.useRealTimers();
  if (handle) await handle.close();
  handle = null;
  vi.restoreAllMocks();
  workerPool.setActiveSessionsRegistry(new Map());
  workerPool.__testOnly_resetRestartCoordinator();
  workerPool.restartCounts.clear();
  __testOnly_resetBotRegistry();
});

// ─── Harness ───────────────────────────────────────────────────────────────

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.connected = true;
  w.send = vi.fn();
  w.kill = vi.fn();
  w.pid = 12345;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

let seq = 0;

/** A live, ready, idle session wired to the real worker-pool IPC handler. */
function armSession(): { ds: DaemonSession; worker: any; sessionId: string } {
  const sessionId = `sid-restart-paths-${++seq}`;
  const worker = makeFakeWorker();
  const ds = {
    session: {
      sessionId,
      rootMessageId: `om_root_${seq}`,
      chatId: 'oc_chat',
      title: 'Restart paths',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'claude-code',
    },
    worker,
    workerPort: 9999,
    workerToken: 'tok',
    workerReady: true,
    cliReady: true,
    larkAppId: APP_ID,
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'idle',
  } as unknown as DaemonSession;
  workerPool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  workerPool.__testOnly_setupWorkerHandlers(ds, worker);
  expect(workerPool.isSessionLifecycleInFlight(ds)).toBe(false);
  return { ds, worker, sessionId };
}

function restartSends(worker: any): any[] {
  return worker.send.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.type === 'restart');
}

/**
 * The restart must carry a coordinator attemptId — a bare restart is exactly
 * the #1863 bug. Checked with plain assertions rather than an asymmetric
 * `expect.any(String)` inside toMatchObject: under `bun test` that matcher is
 * written back into the received object, which would clobber the very id the
 * receipt has to echo.
 */
function expectCorrelated(msg: any): void {
  expect(typeof msg.attemptId).toBe('string');
  expect(msg.attemptId.length).toBeGreaterThan(0);
}

function receipt(worker: any, attemptId: string, status: 'succeeded' | 'failed'): void {
  worker.emit('message', { type: 'restart_result', attemptId, status });
}

/** The real fork entry point: refuses with `worker_busy` while the fence is down. */
async function forkError(sessionId: string): Promise<string | undefined> {
  const r = await workerPool.forkSession(sessionId, 'oc_fork_target', 'om_fork_target', 'group', 'chat');
  return r.ok ? undefined : r.error;
}

/**
 * The real relay entry point. Its lifecycle guard runs before any destructive
 * step; past it, the test detach double reports failure so the move aborts
 * with `worker_detach_timeout` instead of rewriting routing.
 */
async function relayError(sessionId: string): Promise<string | undefined> {
  const r = await workerPool.transferSession(sessionId, 'oc_relay_target', 'om_relay_target', 'group', 'chat', {
    forkWorkerImpl: vi.fn() as any,
    killWorkerImpl: vi.fn() as any,
    detachWorkerImpl: vi.fn(() => false),
  });
  return r.ok ? undefined : r.error;
}

/** Fenced: fork and relay both refuse as `worker_busy`. */
async function expectFenced(ds: DaemonSession): Promise<void> {
  expect(ds.workerReady).toBe(false);
  expect(workerPool.isSessionLifecycleInFlight(ds)).toBe(true);
  expect(await forkError(ds.session.sessionId)).toBe('worker_busy');
  expect(await relayError(ds.session.sessionId)).toBe('worker_busy');
}

/** Released: fork / relay get past the lifecycle gate. Relay is checked last
 *  because it consumes the session (its aborted move is not undone here). */
async function expectReleased(ds: DaemonSession): Promise<void> {
  expect(ds.workerReady).toBe(true);
  expect(workerPool.isSessionLifecycleInFlight(ds)).toBe(false);
  expect(await forkError(ds.session.sessionId)).not.toBe('worker_busy');
  expect(await relayError(ds.session.sessionId)).not.toBe('worker_busy');
}

/** Fake the coordinator's 40s attempt timeout while real I/O keeps flowing. */
function useCoordinatorClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
}

async function crash(worker: any): Promise<void> {
  const before = restartSends(worker).length;
  worker.emit('message', { type: 'claude_exit', code: 1, signal: null });
  // The claude_exit handler awaits before deciding to restart.
  await vi.waitFor(() => expect(restartSends(worker).length).toBe(before + 1));
}

async function ipc(path: string, body?: Record<string, unknown>): Promise<Response> {
  if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function postCd(ds: DaemonSession, sessionId: string): Promise<Response> {
  // setupWorkerHandlers clears per-generation authority; the CLI's current
  // turn capability is what authorizes the session-scoped cd route.
  ds.managedTurnOrigin = { capability: CAP } as any;
  return ipc(`/api/sessions/${sessionId}/cd`, { dir: roleDir, originCapability: CAP });
}

// ─── 1. CLI crash auto-restart ─────────────────────────────────────────────

describe('#1863 CLI crash auto-restart (reason cli_crash)', () => {
  it('is correlated; the succeeded receipt lifts the fence and fork / relay stop being worker_busy', async () => {
    const { ds, worker } = armSession();

    await crash(worker);

    const [msg] = restartSends(worker);
    expectCorrelated(msg);
    expect(msg).toMatchObject({ type: 'restart', reason: 'cli_crash' });
    await expectFenced(ds);

    receipt(worker, msg.attemptId, 'succeeded');

    await expectReleased(ds);
  });

  it('a failed respawn keeps the fence; the next crash mints a fresh attempt that releases it (budget still counts)', async () => {
    const { ds, worker, sessionId } = armSession();

    await crash(worker);
    const first = restartSends(worker)[0];
    // Worker order on a failed respawn: restart_result(failed) THEN claude_exit.
    receipt(worker, first.attemptId, 'failed');
    await expectFenced(ds);

    await crash(worker);
    const second = restartSends(worker)[1];
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(workerPool.restartCounts.get(sessionId)?.count).toBe(2);
    // A late success for the already-settled attempt proves nothing.
    receipt(worker, first.attemptId, 'succeeded');
    expect(ds.workerReady).toBe(false);

    receipt(worker, second.attemptId, 'succeeded');
    await expectReleased(ds);
  });

  it('a timed-out attempt does not release on a late receipt', async () => {
    const { ds, worker } = armSession();
    useCoordinatorClock();
    await crash(worker);
    const [msg] = restartSends(worker);

    vi.advanceTimersByTime(40_001);
    receipt(worker, msg.attemptId, 'succeeded');

    expect(ds.workerReady).toBe(false);
  });

  it('a crash while a /restart attempt is in flight joins it instead of stacking a second respawn', async () => {
    const { ds, worker, sessionId } = armSession();
    const manual = workerPool.requestSessionRestart(ds, { source: 'slash', notify: vi.fn() })!;
    expect(restartSends(worker)).toHaveLength(1);

    worker.emit('message', { type: 'claude_exit', code: 1, signal: null });
    await vi.waitFor(() => expect(workerPool.restartCounts.get(sessionId)?.count).toBe(1));
    await new Promise(r => setTimeout(r, 0));

    expect(restartSends(worker)).toHaveLength(1);
    receipt(worker, manual.attemptId, 'succeeded');
    await expectReleased(ds);
  });
});

// ─── 2. Dashboard restart button ──────────────────────────────────────────

describe('#1863 dashboard restart button (reason operator)', () => {
  it('is correlated; the succeeded receipt lifts the fence and fork / relay stop being worker_busy', async () => {
    const { ds, worker, sessionId } = armSession();

    const res = await ipc(`/api/sessions/${sessionId}/restart`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionId, revived: false });

    const [msg] = restartSends(worker);
    expectCorrelated(msg);
    expect(msg).toMatchObject({ type: 'restart', reason: 'operator' });
    await expectFenced(ds);

    receipt(worker, msg.attemptId, 'succeeded');

    await expectReleased(ds);
  });

  it('a failed receipt keeps the fence down', async () => {
    const { ds, worker, sessionId } = armSession();
    await ipc(`/api/sessions/${sessionId}/restart`);
    const [msg] = restartSends(worker);

    receipt(worker, msg.attemptId, 'failed');

    await expectFenced(ds);
  });

  it('a timed-out attempt does not release on a late receipt', async () => {
    const { ds, worker, sessionId } = armSession();
    useCoordinatorClock();
    await ipc(`/api/sessions/${sessionId}/restart`);
    const [msg] = restartSends(worker);

    vi.advanceTimersByTime(40_001);
    receipt(worker, msg.attemptId, 'succeeded');

    expect(ds.workerReady).toBe(false);
  });

  it('refuses with 409 restart_in_progress while another restart is in flight — no second IPC, the in-flight one still releases', async () => {
    const { ds, worker, sessionId } = armSession();
    const manual = workerPool.requestSessionRestart(ds, { source: 'slash', notify: vi.fn() })!;
    const replySpy = vi.mocked(larkClient.replyMessage);
    replySpy.mockClear();

    const res = await ipc(`/api/sessions/${sessionId}/restart`);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: 'restart_in_progress' });
    // The dashboard toasts `message ?? error`: a readable sentence, not a code.
    expect(String(body.message)).toMatch(/正在重启|restarting/i);
    expect(restartSends(worker)).toHaveLength(1);
    // No "restarting…" notice into the thread for a refused click.
    expect(replySpy).not.toHaveBeenCalled();

    receipt(worker, manual.attemptId, 'succeeded');
    await expectReleased(ds);
  });

  it('a closed IPC channel is still a 502', async () => {
    const { worker, sessionId } = armSession();
    worker.send.mockImplementation(() => { throw new Error('ERR_IPC_CHANNEL_CLOSED'); });

    const res = await ipc(`/api/sessions/${sessionId}/restart`);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining('ERR_IPC_CHANNEL_CLOSED') });
  });
});

// ─── 3. Role-switch cwd move ──────────────────────────────────────────────

describe('#1863 role-switch cwd move (updateWorkingDir)', () => {
  it('is correlated; the succeeded receipt lifts the fence and fork / relay stop being worker_busy', async () => {
    const { ds, worker, sessionId } = armSession();

    const res = await postCd(ds, sessionId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'respawn-resume', dir: roleDirReal });

    const [msg] = restartSends(worker);
    expectCorrelated(msg);
    expect(msg).toMatchObject({ type: 'restart', updateWorkingDir: roleDirReal });
    expect(msg.reason).toBeUndefined();
    // The record is repinned before the respawn is requested.
    expect(ds.session.workingDir).toBe(roleDirReal);
    await expectFenced(ds);

    receipt(worker, msg.attemptId, 'succeeded');

    await expectReleased(ds);
  });

  it('a failed receipt keeps the fence down', async () => {
    const { ds, worker, sessionId } = armSession();
    await postCd(ds, sessionId);
    const [msg] = restartSends(worker);

    receipt(worker, msg.attemptId, 'failed');

    await expectFenced(ds);
  });

  it('a timed-out attempt does not release on a late receipt', async () => {
    const { ds, worker, sessionId } = armSession();
    useCoordinatorClock();
    await postCd(ds, sessionId);
    const [msg] = restartSends(worker);

    vi.advanceTimersByTime(40_001);
    receipt(worker, msg.attemptId, 'succeeded');

    expect(ds.workerReady).toBe(false);
  });

  it('refuses with 409 restart_in_progress while another restart is in flight — BEFORE repinning the working directory', async () => {
    const { ds, worker, sessionId } = armSession();
    const originalDir = '/original/role/dir';
    ds.workingDir = originalDir;
    ds.session.workingDir = originalDir;
    ds.initConfig = { workingDir: originalDir } as any;
    const manual = workerPool.requestSessionRestart(ds, { source: 'slash', notify: vi.fn() })!;
    vi.mocked(sessionStore.updateSession).mockClear();

    const res = await postCd(ds, sessionId);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: 'restart_in_progress' });
    expect(String(body.message)).toMatch(/正在重启|restarting/i);
    // Nothing was written: record, runtime cwd and launch config keep the old dir.
    expect(ds.session.workingDir).toBe(originalDir);
    expect(ds.workingDir).toBe(originalDir);
    expect((ds.initConfig as any).workingDir).toBe(originalDir);
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
    expect(restartSends(worker)).toHaveLength(1);

    receipt(worker, manual.attemptId, 'succeeded');
    await expectReleased(ds);
    // Once the restart settled, the same move goes through.
    const retry = await postCd(ds, sessionId);
    expect(retry.status).toBe(200);
    expect(ds.session.workingDir).toBe(roleDirReal);
  });

  it('a slash /restart joining an in-flight attempt still sends nothing (#1032 semantics)', async () => {
    const { ds, worker } = armSession();
    const first = workerPool.requestSessionRestart(ds, { source: 'slash', notify: vi.fn() })!;
    const second = workerPool.requestSessionRestart(ds, { source: 'card', notify: vi.fn() })!;
    expect(second).toMatchObject({ joined: true });
    expect(second.attemptId).toBe(first.attemptId);
    expect(restartSends(worker)).toHaveLength(1);
  });

  it('a closed IPC channel still falls back to killWorker (cold restart into the new dir)', async () => {
    const { ds, worker, sessionId } = armSession();
    worker.send.mockImplementation(() => { throw new Error('EPIPE'); });
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd(ds, sessionId);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'cold-restart', dir: roleDirReal });
    expect(killSpy).toHaveBeenCalledWith(ds);
    expect(ds.session.workingDir).toBe(roleDirReal);
  });
});
