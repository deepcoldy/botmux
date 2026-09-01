// POST /api/sessions/:sessionId/suspend 的排队半边：会话正在产出回复时不杀
// worker（那会把这一轮丢掉），改为记 pendingSuspendReason 并回 reason:'deferred'，
// 由 worker-pool 的 runPendingSuspendIfSettled 在 idle/limited 边沿兑现。
// 兑现半边见 deferred-suspend.test.ts。
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';

let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  vi.restoreAllMocks();
});

async function postSuspend(sessionId: string): Promise<Response> {
  handle ??= await startIpcServer({ port: 0, host: '127.0.0.1' });
  return fetch(`http://127.0.0.1:${handle.port}/api/sessions/${sessionId}/suspend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

function activeSession(over: Record<string, unknown> = {}) {
  return {
    session: { sessionId: 's-susp', status: 'active' },
    initConfig: { backendType: 'tmux' },
    worker: { killed: false },
    ...over,
  } as any;
}

describe('POST /api/sessions/:sessionId/suspend — 延迟挂起', () => {
  it.each(['working', 'analyzing'])('queues instead of killing while %s', async (status) => {
    const ds = activeSession({ lastScreenStatus: status });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const suspendSpy = vi.spyOn(workerPool, 'suspendWorker');

    const res = await postSuspend('s-susp');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, sessionId: 's-susp', suspended: false, reason: 'deferred',
    });
    // 关键回归：正在产出的那一轮回复不能被切断。
    expect(suspendSpy).not.toHaveBeenCalled();
    expect(ds.pendingSuspendReason).toBe('manual_suspend');
  });

  it.each(['idle', 'limited'])('suspends immediately when already settled (%s)', async (status) => {
    const ds = activeSession({ lastScreenStatus: status });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const suspendSpy = vi.spyOn(workerPool, 'suspendWorker').mockReturnValue(true);

    const res = await postSuspend('s-susp');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionId: 's-susp', suspended: true });
    expect(suspendSpy).toHaveBeenCalledWith(ds, 'manual_suspend');
    expect(ds.pendingSuspendReason).toBeUndefined();
  });

  // 状态未知（worker 还没报过 screen_update）不属于 working/analyzing，走原有立即挂起路径。
  it('does not queue when the screen status is unknown', async () => {
    const ds = activeSession({ lastScreenStatus: undefined });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const suspendSpy = vi.spyOn(workerPool, 'suspendWorker').mockReturnValue(true);

    const res = await postSuspend('s-susp');

    expect((await res.json()).suspended).toBe(true);
    expect(suspendSpy).toHaveBeenCalled();
    expect(ds.pendingSuspendReason).toBeUndefined();
  });

  // 幂等分支必须排在排队检查之前：worker 早就没了要如实回 no_live_worker，
  // 不能被误报成 deferred（否则 CLI 的排队计数——决策 2 的安全阀——会虚高）。
  it('reports no_live_worker instead of deferred when the worker is already gone', async () => {
    const ds = activeSession({ lastScreenStatus: 'working', worker: null });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);

    const res = await postSuspend('s-susp');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, sessionId: 's-susp', suspended: false, reason: 'no_live_worker',
    });
    expect(ds.pendingSuspendReason).toBeUndefined();
  });

  // 不可挂起的 backend 现在（busy 时）就是 409：suspendWorker 会拒。排队不能把它
  // 变成一个「200 deferred，然后到点静默失败」的谎——守卫必须排在排队检查之前。
  it('keeps the backend_not_suspendable guard ahead of queueing', async () => {
    const ds = activeSession({ lastScreenStatus: 'working', initConfig: { backendType: 'pty' } });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);

    const res = await postSuspend('s-susp');

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('backend_not_suspendable');
    expect(ds.pendingSuspendReason).toBeUndefined();
  });

  // adopt 会话 botmux 从未拥有那个 CLI，挂起会杀掉用户自己的 pane —— 保持现有守卫，
  // 在排队检查之前 return。
  it('keeps the adopt guard ahead of queueing', async () => {
    const ds = activeSession({ lastScreenStatus: 'working', adoptedFrom: 'tmux:user-pane' });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);

    const res = await postSuspend('s-susp');

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('adopt_suspend_unsupported');
    expect(ds.pendingSuspendReason).toBeUndefined();
  });
});
