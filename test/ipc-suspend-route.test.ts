// POST /api/sessions/:sessionId/suspend 的排队半边：会话正在产出回复时不杀
// worker（那会把这一轮丢掉），改为记 pendingSuspendReason 并回 reason:'deferred'，
// 由 worker-pool 的 runPendingSuspendIfSettled 在 idle/limited 边沿兑现。
// 兑现半边见 deferred-suspend.test.ts。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as idleSweeper from '../src/core/idle-worker-sweeper.js';

let handle: IpcServerHandle | null = null;
const HOST_SECRET = 'idle-suspend-test-secret';

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  setLarkAppId('');
  workerPool.setActiveSessionsRegistry(undefined);
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

describe('POST /api/maintenance/suspend-idle', () => {
  async function postIdle(
    body: Record<string, unknown>,
    signed = true,
  ): Promise<Response> {
    setIpcAuthSecret(HOST_SECRET);
    setLarkAppId('cli_a');
    handle ??= await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const path = '/api/maintenance/suspend-idle';
    const headers = signed
      ? daemonIpcAuthHeaders({
          secret: HOST_SECRET,
          port: handle.port,
          method: 'POST',
          path,
          headers: { 'content-type': 'application/json' },
        })
      : { 'content-type': 'application/json' };
    return fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('requires trusted-host HMAC even on loopback', async () => {
    workerPool.setActiveSessionsRegistry(new Map());
    const res = await postIdle({ execute: false, olderThanMs: 7 * 24 * 60 * 60_000 }, false);
    expect(res.status).toBe(401);
  });

  it('returns a daemon-authoritative dry-run without mutating workers', async () => {
    const now = Date.now();
    const old = activeSession({
      larkAppId: 'cli_a',
      workerReady: true,
      lastScreenStatus: 'idle',
      lastMessageAt: now - 8 * 24 * 60 * 60_000,
      spawnedAt: now - 9 * 24 * 60 * 60_000,
      worker: { killed: false, pid: 4242 },
      session: {
        sessionId: 's-old',
        status: 'active',
        title: 'old session',
        cliId: 'traex',
        lastMessageAt: new Date(now - 8 * 24 * 60 * 60_000).toISOString(),
      },
    });
    const recent = activeSession({
      larkAppId: 'cli_a',
      workerReady: true,
      lastScreenStatus: 'idle',
      lastMessageAt: now - 24 * 60 * 60_000,
      spawnedAt: now - 2 * 24 * 60 * 60_000,
      session: {
        sessionId: 's-recent',
        status: 'active',
        title: 'recent session',
        cliId: 'traex',
        lastMessageAt: new Date(now - 24 * 60 * 60_000).toISOString(),
      },
    });
    workerPool.setActiveSessionsRegistry(new Map([['old', old], ['recent', recent]]));

    const res = await postIdle({ execute: false, olderThanMs: 7 * 24 * 60 * 60_000 });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, execute: false, larkAppId: 'cli_a', affected: 0 });
    expect(body.candidates.map((candidate: any) => candidate.sessionId)).toEqual(['s-old']);
    expect(old.worker).not.toBe(null);
    expect(recent.worker).not.toBe(null);
  });

  it('rejects malformed bodies and thresholds', async () => {
    workerPool.setActiveSessionsRegistry(new Map());
    expect((await postIdle({ olderThanMs: 1_000 })).status).toBe(400);
    expect((await postIdle({ execute: false, olderThanMs: 0 })).status).toBe(400);
    expect((await postIdle({ execute: false, olderThanMs: 1.5 })).status).toBe(400);
  });

  it('caps the trusted maintenance request body', async () => {
    workerPool.setActiveSessionsRegistry(new Map());
    const res = await postIdle({
      execute: false,
      olderThanMs: 1_000,
      padding: 'x'.repeat(5_000),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: 'body_too_large' });
  });

  it('reports per-candidate execution failures without hiding successes', async () => {
    const active = activeSession({ larkAppId: 'cli_a' });
    workerPool.setActiveSessionsRegistry(new Map([['active', active]]));
    const candidate = {
      sessionId: 's-susp',
      larkAppId: 'cli_a',
      title: 'old session',
      lastActivityAt: Date.now() - 8 * 24 * 60 * 60_000,
      idleForMs: 8 * 24 * 60 * 60_000,
      workerPid: 4242,
      backendType: 'tmux',
      backendTarget: 'bmx-s-susp',
      processTypes: ['botmux __worker', 'tmux session', 'traex'],
      backingReleased: true,
      workerRetirementRequested: true,
    };
    const failed = { ...candidate, sessionId: 's-failed' };
    vi.spyOn(idleSweeper, 'sweepIdleWorkersByAgeAfterTurnDrain').mockResolvedValue({
      candidates: [candidate, failed],
      suspended: [candidate],
      failures: [{ candidate: failed, error: 'suspend_refused' }],
    });

    const res = await postIdle({ execute: true, olderThanMs: 7 * 24 * 60 * 60_000 });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, execute: true, affected: 1 });
    expect(body.suspended).toEqual([candidate]);
    expect(body.failures).toEqual([{ candidate: failed, error: 'suspend_refused' }]);
  });

  it('returns a retryable conflict when the mutation gate is busy', async () => {
    workerPool.setActiveSessionsRegistry(new Map([[
      'active', activeSession({ larkAppId: 'cli_a' }),
    ]]));
    vi.spyOn(idleSweeper, 'sweepIdleWorkersByAgeAfterTurnDrain').mockResolvedValue(null);

    const res = await postIdle({ execute: true, olderThanMs: 1_000 });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'mutation_gate_busy' });
  });

  // The handler-level gate must remain even when the server runs without the
  // global HMAC middleware (tests / dev servers): loopback alone is not
  // identity for a batch process-kill route.
  it('still refuses when the server was started without authRequired', async () => {
    const unauth = await startIpcServer({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${unauth.port}/api/maintenance/suspend-idle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ execute: false, olderThanMs: 7 * 24 * 60 * 60_000 }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'trusted_host_required' });
    } finally {
      await unauth.close();
    }
  });

  it('rejects in durable primary coordination mode before reading any state', async () => {
    const previous = process.env.BOTMUX_COORDINATION_MODE;
    process.env.BOTMUX_COORDINATION_MODE = 'primary';
    try {
      workerPool.setActiveSessionsRegistry(new Map());
      const res = await postIdle({ execute: false, olderThanMs: 7 * 24 * 60 * 60_000 });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: 'durable_primary_unsupported' });
    } finally {
      if (previous === undefined) delete process.env.BOTMUX_COORDINATION_MODE;
      else process.env.BOTMUX_COORDINATION_MODE = previous;
    }
  });

  it.each([
    ['two app ids in one daemon', ['cli_a', 'cli_b'], 'cli_a'],
    ['registry app id mismatches the bound app id', ['cli_b'], 'cli_a'],
  ])('refuses ambiguous daemon scope (%s)', async (_label, appIds, boundAppId) => {
    setLarkAppId(boundAppId);
    workerPool.setActiveSessionsRegistry(new Map(appIds.map((appId, index) => [
      `s-${index}`,
      activeSession({ larkAppId: appId }),
    ])));

    const res = await postIdle({ execute: false, olderThanMs: 7 * 24 * 60 * 60_000 });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'ambiguous_daemon_scope' });
  });
});
