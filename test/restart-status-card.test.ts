/**
 * A user-visible restart is ONE status card, posted once and patched in place:
 * 重启中 → 已重启 / 重启失败 / 重启超时 / 重启已中止.
 *
 * Part 1 drives the real RestartCoordinator into the real notifier with fake
 * post / update edges. Part 2 runs the real dashboard IPC route and the real
 * Lark client (only the SDK object is replaced) and reads what Feishu would get.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lark = vi.hoisted(() => ({
  create: vi.fn(),
  reply: vi.fn(),
  patch: vi.fn(),
  request: vi.fn(),
  /** group_message_type the fake chat-info endpoint reports ('chat' | 'thread'). */
  groupMessageType: 'chat',
}));

vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBotClient: () => ({
    im: { v1: { message: { create: lark.create, reply: lark.reply, patch: lark.patch } } },
    request: lark.request,
  }),
}));

import { RestartCoordinator, type RestartObserverStatus } from '../src/core/restart-coordinator.js';
import {
  __testOnly_resetRestartStatusCards,
  buildRestartStatusCard,
  restartStatusCardNotifier,
  type RestartStatusCardOptions,
} from '../src/core/restart-status-card.js';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { MessageUpdateExpiredError } from '../src/im/lark/client.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function parseCard(json: string): { template: string; title: string; text: string; updateMulti: unknown } {
  const card = JSON.parse(json);
  return {
    template: card.header.template,
    title: card.header.title.content,
    text: JSON.stringify(card.elements),
    updateMulti: card.config?.update_multi,
  };
}

beforeEach(() => {
  __testOnly_resetRestartStatusCards();
});

// ─── Part 1: notifier lifecycle on the real coordinator ────────────────────

describe('restart status card lifecycle', () => {
  const harness = (over: Partial<RestartStatusCardOptions> = {}) => {
    let ids = 0;
    const post = vi.fn(async (_card: string) => `om_card_${++ids}`);
    const update = vi.fn(async (_id: string, _card: string) => {});
    const notify = restartStatusCardNotifier({
      larkAppId: 'app',
      sessionId: 's1',
      render: status => buildRestartStatusCard({ status, cliName: 'Codex', source: 'slash', locale: 'zh' }),
      post,
      update,
      ...over,
    });
    return { post, update, notify };
  };

  it('posts one in-progress card and patches that same card with the result', async () => {
    const coordinator = new RestartCoordinator({ createAttemptId: () => 'a1' });
    const { post, update, notify } = harness();

    coordinator.request('s1', { source: 'slash', notify }, vi.fn());
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    const posted = parseCard(post.mock.calls[0][0]);
    expect(posted.template).toBe('blue');
    expect(posted.title).toContain('正在重启 Codex');
    // Shared card: every chat member sees the patched result, not just the viewer.
    expect(posted.updateMulti).toBe(true);

    coordinator.resolve('s1', 'a1', 'succeeded');
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe('om_card_1');
    const result = parseCard(update.mock.calls[0][1]);
    expect(result.template).toBe('green');
    expect(result.title).toContain('Codex 已重启');
  });

  it('observers that join the same attempt share one card', async () => {
    const coordinator = new RestartCoordinator({ createAttemptId: () => 'a2' });
    const first = harness();
    const second = harness({ post: first.post, update: first.update });

    coordinator.request('s1', { source: 'slash', notify: first.notify }, vi.fn());
    coordinator.request('s1', { source: 'card', notify: second.notify }, vi.fn());
    coordinator.resolve('s1', 'a2', 'failed');
    await flush();

    expect(first.post).toHaveBeenCalledTimes(1);
    expect(first.update).toHaveBeenCalledTimes(1);
    expect(parseCard(first.update.mock.calls[0][1]).template).toBe('red');
  });

  it('a later restart of the same session gets its own card', async () => {
    let n = 0;
    const coordinator = new RestartCoordinator({ createAttemptId: () => `a3-${++n}` });
    const { post, update, notify } = harness();

    coordinator.request('s1', { source: 'slash', notify }, vi.fn());
    coordinator.resolve('s1', 'a3-1', 'succeeded');
    await flush();
    coordinator.request('s1', { source: 'slash', notify }, vi.fn());
    coordinator.resolve('s1', 'a3-2', 'succeeded');
    await flush();

    expect(post).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.map(c => c[0])).toEqual(['om_card_1', 'om_card_2']);
  });

  it('when the card still cannot be patched after a retry, the result is posted as its own card', async () => {
    const coordinator = new RestartCoordinator({ createAttemptId: () => 'a4' });
    const { post, update, notify } = harness({ retryDelayMs: 0 });
    update.mockRejectedValue(new Error('network'));

    coordinator.request('s1', { source: 'slash', notify }, vi.fn());
    coordinator.resolve('s1', 'a4', 'succeeded');
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));

    expect(update).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(2);
    expect(parseCard(post.mock.calls[1][0]).template).toBe('green');
  });

  it('when the in-progress card never landed, the result is posted instead of patched', async () => {
    const coordinator = new RestartCoordinator({ createAttemptId: () => 'a5' });
    const { post, update, notify } = harness();
    post.mockRejectedValueOnce(new Error('network'));

    coordinator.request('s1', { source: 'slash', notify }, vi.fn());
    coordinator.resolve('s1', 'a5', 'succeeded');
    await flush();

    expect(update).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
    expect(parseCard(post.mock.calls[1][0]).template).toBe('green');
  });

  it('a cancelled attempt does not leave the card saying "restarting"', async () => {
    const coordinator = new RestartCoordinator({ createAttemptId: () => 'a6' });
    const { update, notify } = harness();

    coordinator.request('s1', { source: 'slash', notify }, vi.fn());
    coordinator.cancelSession('s1');
    await flush();

    expect(update).toHaveBeenCalledTimes(1);
    const card = parseCard(update.mock.calls[0][1]);
    expect(card.template).toBe('grey');
    expect(card.title).toContain('重启已中止');
  });

  it('a timed-out attempt patches the card to the timeout state', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new RestartCoordinator({ createAttemptId: () => 'a7', timeoutMs: 10 });
      const { update, notify } = harness();
      coordinator.request('s1', { source: 'slash', notify }, vi.fn());
      await vi.advanceTimersByTimeAsync(10);
      await flush();
      expect(update).toHaveBeenCalledTimes(1);
      expect(parseCard(update.mock.calls[0][1]).template).toBe('orange');
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the shared card once every observer has its result', async () => {
    const { post, notify } = harness();
    await notify('in_progress', 'k1');
    await notify('succeeded', 'k1');
    // Same attempt key again: nothing may still be holding the old card.
    await notify('in_progress', 'k1');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('a cancel posts nothing when the in-progress card never landed', async () => {
    const coordinator = new RestartCoordinator({ createAttemptId: () => 'a8' });
    const { post, update, notify } = harness();
    post.mockRejectedValueOnce(new Error('network'));

    coordinator.request('s1', { source: 'slash', notify }, vi.fn());
    coordinator.cancelSession('s1');
    await flush();

    expect(post).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('the card keeps the posting observer\'s wording when a joined observer settles it', async () => {
    let landPost!: (id: string) => void;
    const posterPost = vi.fn(() => new Promise<string>(resolve => { landPost = resolve; }));
    const update = vi.fn(async (_id: string, _card: string) => {});
    const poster = restartStatusCardNotifier({
      larkAppId: 'app', sessionId: 's1', post: posterPost, update,
      render: status => buildRestartStatusCard({ status, cliName: 'Codex', source: 'effort', locale: 'zh', body: `EFFORT-${status}` }),
    });
    const joiner = restartStatusCardNotifier({
      larkAppId: 'app', sessionId: 's1', post: vi.fn(async () => 'om_other'), update,
      render: status => buildRestartStatusCard({ status, cliName: 'Codex', source: 'slash', locale: 'zh' }),
    });

    const posting = poster('in_progress', 'k2');
    await joiner('in_progress', 'k2');
    // The joiner hears the result while the poster's card is still in flight.
    const settling = joiner('failed', 'k2');
    landPost('om_effort');
    await Promise.all([posting, settling]);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe('om_effort');
    expect(update.mock.calls[0][1]).toContain('EFFORT-failed');
    expect(update.mock.calls[0][1]).not.toContain('/restart');
  });

  it('a transient PATCH failure is retried instead of posting a second card', async () => {
    const { post, update, notify } = harness({ retryDelayMs: 0 });
    update.mockRejectedValueOnce(new Error('230020 rate limited'));
    await notify('in_progress', 'k3');
    await notify('succeeded', 'k3');
    expect(update).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('an expired card is not retried; the result goes out as its own card', async () => {
    const { post, update, notify } = harness({ retryDelayMs: 0 });
    update.mockRejectedValueOnce(new MessageUpdateExpiredError('om_card_1'));
    await notify('in_progress', 'k4');
    await notify('succeeded', 'k4');
    expect(update).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(parseCard(post.mock.calls[1][0]).template).toBe('green');
  });

  it.each(['in_progress', 'succeeded', 'failed', 'timed_out', 'cancelled'] as RestartObserverStatus[])(
    'renders a titled card for %s in both locales',
    status => {
      for (const locale of ['zh', 'en'] as const) {
        const card = parseCard(buildRestartStatusCard({ status, cliName: 'Codex', source: 'dashboard', locale }));
        expect(card.title).toContain('Codex');
        // No raw i18n key leaks into the card.
        expect(card.title).not.toContain('card.restart.');
        expect(card.text).not.toContain('card.restart.');
      }
    },
  );
});

// ─── Part 2: dashboard restart route on the wire ───────────────────────────

const APP_ID = 'app_restart_card_wire';
let handle: IpcServerHandle | null = null;

describe('dashboard restart posts one status card and patches it on the result', () => {
  beforeEach(() => {
    lark.groupMessageType = 'chat';
    lark.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_chat' } });
    lark.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_replied', chat_id: 'oc_chat' } });
    lark.patch.mockReset().mockResolvedValue({ code: 0, data: {} });
    lark.request.mockReset().mockImplementation(async (req: { method?: string; url?: string }) => {
      if (req.method === 'GET' && /\/open-apis\/im\/v1\/chats\//.test(req.url ?? '')) {
        return { code: 0, data: { chat_mode: 'group', group_message_type: lark.groupMessageType } };
      }
      return { code: 0, data: {} };
    });
    workerPool.__testOnly_resetRestartCoordinator();
    workerPool.restartCounts.clear();
    registerBot({ larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'codex' });
    workerPool.initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    vi.restoreAllMocks();
    workerPool.setActiveSessionsRegistry(new Map());
    workerPool.__testOnly_resetRestartCoordinator();
    workerPool.restartCounts.clear();
    __testOnly_resetBotRegistry();
  });

  async function ipc(path: string): Promise<Response> {
    if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    return fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
  }

  let seq = 0;
  function armSession(scope: 'chat' | 'thread'): { worker: any; sessionId: string; rootMessageId: string } {
    const sessionId = `sid-restart-card-${++seq}`;
    const rootMessageId = `om_root_${seq}`;
    const worker = new EventEmitter() as any;
    Object.assign(worker, { killed: false, connected: true, send: vi.fn(), kill: vi.fn(), pid: 12345 });
    worker.stdout = new EventEmitter();
    worker.stderr = new EventEmitter();
    const ds = {
      session: {
        sessionId, rootMessageId, chatId: 'oc_chat', title: 'Restart card', status: 'active',
        createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group', cliId: 'codex', scope,
      },
      scope, worker, workerPort: 9999, workerToken: 'tok', workerReady: true, cliReady: true,
      larkAppId: APP_ID, chatId: 'oc_chat', chatType: 'group', spawnedAt: Date.now(), cliVersion: '1.0',
      lastMessageAt: Date.now(), hasHistory: true, displayMode: 'hidden', lastScreenContent: '', lastScreenStatus: 'idle',
    } as unknown as DaemonSession;
    workerPool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    workerPool.__testOnly_setupWorkerHandlers(ds, worker);
    return { worker, sessionId, rootMessageId };
  }

  function cardWrites(): Array<{ api: 'create' | 'reply'; data: any; path?: any }> {
    return [
      ...lark.create.mock.calls.map(([arg]) => ({ api: 'create' as const, data: arg.data, path: arg.params })),
      ...lark.reply.mock.calls.map(([arg]) => ({ api: 'reply' as const, data: arg.data, path: arg.path })),
    ];
  }

  async function restartAndSucceed(sessionId: string, worker: any): Promise<void> {
    const res = await ipc(`/api/sessions/${sessionId}/restart`);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(cardWrites()).toHaveLength(1));
    const msg = worker.send.mock.calls.map((c: any[]) => c[0]).find((m: any) => m?.type === 'restart');
    worker.emit('message', { type: 'restart_result', attemptId: msg.attemptId, status: 'succeeded' });
    await vi.waitFor(() => expect(lark.patch).toHaveBeenCalledTimes(1));
  }

  function expectInProgressThenPatched(write: { data: any }, patchedId: string): void {
    expect(write.data.msg_type).toBe('interactive');
    expect(parseCard(write.data.content).title).toContain('正在重启 Codex');
    expect(lark.patch.mock.calls[0][0].path).toEqual({ message_id: patchedId });
    expect(parseCard(lark.patch.mock.calls[0][0].data.content).title).toContain('Codex 已重启');
    // One message in the chat, not a second "done" message.
    expect(cardWrites()).toHaveLength(1);
  }

  it('chat-scope session in a flat group: one chat card, patched on success', async () => {
    const { worker, sessionId } = armSession('chat');
    await restartAndSucceed(sessionId, worker);
    const [w] = cardWrites();
    expect(w.api).toBe('create');
    expect(w.data.receive_id).toBe('oc_chat');
    expectInProgressThenPatched(w, 'om_sent');
  });

  it('chat-scope session in a topic group: one threaded card on the root, patched on success', async () => {
    const { worker, sessionId, rootMessageId } = armSession('chat');
    lark.groupMessageType = 'thread';
    await restartAndSucceed(sessionId, worker);
    const [w] = cardWrites();
    expect(w.api).toBe('reply');
    expect(w.path).toMatchObject({ message_id: rootMessageId });
    expect(w.data.reply_in_thread).toBe(true);
    expectInProgressThenPatched(w, 'om_replied');
  });

  it('thread-scope session: one card in the thread, patched on success', async () => {
    const { worker, sessionId, rootMessageId } = armSession('thread');
    await restartAndSucceed(sessionId, worker);
    const [w] = cardWrites();
    expect(w.api).toBe('reply');
    expect(w.path).toMatchObject({ message_id: rootMessageId });
    expect(w.data.reply_in_thread).toBe(true);
    expectInProgressThenPatched(w, 'om_replied');
  });

  it('revive branch (worker gone) is a correlated attempt whose result patches the card', async () => {
    const { sessionId } = armSession('thread');
    const ds = workerPool.findActiveBySessionId(sessionId)!;
    ds.worker = null;
    let observer: any;
    const restartSpy = vi.spyOn(workerPool, 'requestSessionRestart').mockImplementation((_ds, obs) => {
      observer = obs;
      return { attemptId: 'attempt-revive', joined: false };
    });

    const res = await ipc(`/api/sessions/${sessionId}/restart`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revived: true });
    expect(restartSpy).toHaveBeenCalledWith(ds, expect.objectContaining({ source: 'dashboard' }));

    await observer.notify('in_progress', 'attempt-revive');
    await observer.notify('succeeded', 'attempt-revive');
    expect(cardWrites()).toHaveLength(1);
    expectInProgressThenPatched(cardWrites()[0], 'om_replied');
  });
});
