/**
 * The restart status card against the real worker-pool lifecycle:
 *  - a worker retired by suspendWorker mid-restart cancels the card at once;
 *  - a reasoning-effort reload and a joining /restart share one card through
 *    the real topicEffort wrapper (it must forward the attemptId);
 *  - a dashboard revive whose working directory is gone keeps the live pane.
 * Only the Lark SDK object, the tmux kill/probe primitives and the
 * device-isolation gate are replaced; timers are fake where time matters.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lark = vi.hoisted(() => ({ create: vi.fn(), reply: vi.fn(), patch: vi.fn(), request: vi.fn() }));
const pane = vi.hoisted(() => ({ kill: vi.fn(), probe: vi.fn(), alive: true }));

vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBotClient: () => ({
    im: { v1: { message: { create: lark.create, reply: lark.reply, patch: lark.patch } } },
    request: lark.request,
  }),
}));
vi.mock('../src/core/persistent-backend.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/persistent-backend.js')>(),
  persistentBackendTargetForSession: () => ({ backendType: 'tmux', sessionName: 'bmx-restart-card-test' }),
  killPersistentBackendTarget: pane.kill,
  probePersistentBackendTarget: pane.probe,
}));
vi.mock('../src/core/device-isolation-activation.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/device-isolation-activation.js')>(),
  currentDeviceIsolationFreezeLease: () => null,
  deferWorkerSpawnDuringDeviceIsolation: () => false,
}));

import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import {
  __testOnly_resetRestartStatusCards,
  buildRestartStatusCard,
  restartStatusCardNotifier,
  type RestartCardSource,
} from '../src/core/restart-status-card.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const APP_ID = 'app_restart_card_lifecycle';
const MISSING_DIR = '/nonexistent/restart-card-merged-worktree';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const template = (json: string) => JSON.parse(json).header.template as string;

let workingDir = '/tmp';
let handle: IpcServerHandle | null = null;
const onMissingWorkingDir = vi.fn();

beforeEach(() => {
  workingDir = '/tmp';
  pane.alive = true;
  pane.kill.mockReset().mockImplementation(() => { pane.alive = false; });
  pane.probe.mockReset().mockImplementation(() => (pane.alive ? 'exists' : 'missing'));
  lark.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_chat' } });
  lark.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_replied', chat_id: 'oc_chat' } });
  lark.patch.mockReset().mockResolvedValue({ code: 0, data: {} });
  lark.request.mockReset().mockResolvedValue({ code: 0, data: { chat_mode: 'group', group_message_type: 'chat' } });
  onMissingWorkingDir.mockReset();
  __testOnly_resetRestartStatusCards();
  workerPool.__testOnly_resetRestartCoordinator();
  registerBot({ larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'codex' });
  workerPool.initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => workingDir,
    getActiveCount: () => 1,
    closeSession: vi.fn(),
    onMissingWorkingDir,
  } as any);
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
  vi.spyOn(sessionStore, 'updateSessionPid').mockImplementation(() => {});
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  workerPool.__testOnly_setSuspendBackingVerifier();
  vi.useRealTimers();
  vi.restoreAllMocks();
  workerPool.setActiveSessionsRegistry(new Map());
  workerPool.__testOnly_resetRestartCoordinator();
  __testOnly_resetBotRegistry();
});

let seq = 0;
function arm(o: { backendType?: 'tmux' | 'pty'; worker?: boolean } = {}): { ds: DaemonSession; worker: any } {
  const sessionId = `sid-restart-card-lc-${++seq}`;
  const worker = o.worker === false ? null : Object.assign(new EventEmitter() as any, {
    killed: false, connected: true, send: vi.fn(), kill: vi.fn(), pid: 4242,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  const ds = {
    session: {
      sessionId, rootMessageId: `om_root_${seq}`, chatId: 'oc_chat', title: 't', status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group', cliId: 'codex', scope: 'thread',
      cliSessionId: `native-${seq}`,
    },
    initConfig: { backendType: o.backendType ?? 'tmux' },
    scope: 'thread', worker, workerPort: worker ? 9999 : null, workerToken: worker ? 'tok' : null,
    workerReady: !!worker, cliReady: !!worker,
    larkAppId: APP_ID, chatId: 'oc_chat', chatType: 'group', spawnedAt: Date.now(), cliVersion: '1.0',
    lastMessageAt: Date.now(), hasHistory: true, displayMode: 'hidden', lastScreenContent: '', lastScreenStatus: 'idle',
  } as unknown as DaemonSession;
  workerPool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  if (worker) workerPool.__testOnly_setupWorkerHandlers(ds, worker);
  return { ds, worker };
}

/** A notifier over an in-memory chat: message id → current card JSON. */
function chat(ds: DaemonSession) {
  const cards = new Map<string, string>();
  const order: string[] = [];
  const notifier = (source: RestartCardSource) => restartStatusCardNotifier({
    larkAppId: APP_ID,
    sessionId: ds.session.sessionId,
    render: status => buildRestartStatusCard({ status, cliName: 'Codex', source, locale: 'zh' }),
    post: async card => { const id = `om_card_${order.length + 1}`; cards.set(id, card); order.push(id); return id; },
    update: async (id, card) => { cards.set(id, card); },
  });
  return { notifier, states: () => order.map(id => template(cards.get(id)!)), cards, order };
}

describe('restart status card × worker lifecycle', () => {
  it('a worker suspended mid-restart (e.g. /cd on tmux) cancels the card at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    workerPool.__testOnly_setSuspendBackingVerifier(() => true);
    const { ds, worker } = arm({ backendType: 'tmux' });
    const c = chat(ds);
    workerPool.requestSessionRestart(ds, { source: 'slash', notify: c.notifier('slash') });
    await flush();
    expect(c.states()).toEqual(['blue']);

    expect(workerPool.suspendWorker(ds, 'working_dir_changed')).toBe(true);
    worker.killed = true;
    worker.emit('exit', 0, null);
    await flush();

    // Not 40 s later as "重启超时", and the dead attempt no longer blocks
    // dashboard restart / relay.
    expect(c.states()).toEqual(['grey']);
    expect(workerPool.isSessionRestartInFlight(ds)).toBe(false);
  });

  it('a reasoning-effort reload and a joining /restart share one card', async () => {
    const { ds, worker } = arm({ backendType: 'tmux' });
    const c = chat(ds);
    const first = workerPool.requestSessionRestart(ds, { source: 'card', notify: c.notifier('effort') },
      { topicEffort: { model: 'm', effort: 'low', nativeSessionId: ds.session.cliSessionId! } as any });
    expect(first?.joined).toBe(false);
    expect(workerPool.requestSessionRestart(ds, { source: 'slash', notify: c.notifier('slash') })?.joined).toBe(true);
    await flush();

    const sent = worker.send.mock.calls.map((call: any[]) => call[0]).find((m: any) => m?.type === 'restart');
    worker.emit('message', { type: 'restart_result', attemptId: sent.attemptId, status: 'failed' });
    await flush();

    expect(c.states()).toEqual(['red']);
  });

  it('a dashboard revive whose working directory is gone keeps the live pane and reports the failure', async () => {
    workingDir = MISSING_DIR;
    const { ds } = arm({ worker: false });

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${ds.session.sessionId}/restart`, { method: 'POST' });

    expect(res.status).toBe(502);
    // The fork is refused for the directory; the CLI still running in the pane
    // must not have been killed for it.
    expect(pane.kill).not.toHaveBeenCalled();
    expect(pane.alive).toBe(true);
    expect(onMissingWorkingDir).toHaveBeenCalledWith(ds, MISSING_DIR, expect.anything());
    await vi.waitFor(() => expect(lark.patch).toHaveBeenCalledTimes(1));
    expect(template(lark.patch.mock.calls[0][0].data.content)).toBe('red');
  });
});
