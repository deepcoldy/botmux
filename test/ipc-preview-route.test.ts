import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

const CAPABILITY = 'ac'.repeat(32);
const HOST_SECRET = 'preview-route-host-secret';
const itWithRealProcfs = it.skipIf(process.platform !== 'linux');
let ipc: IpcServerHandle | null = null;
let targetServer: Server | null = null;

afterEach(async () => {
  if (ipc) await ipc.close();
  ipc = null;
  if (targetServer) await new Promise<void>(resolve => targetServer!.close(() => resolve()));
  targetServer = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

/**
 * P1-12：注册路由现在要求「监听这个端口的进程属于本会话的血缘」。测试里的
 * `reachablePort()` 服务器就是本测试进程开的，所以把本进程 pid 当作 worker pid —— 归属
 * 校验会真的去读 /proc/net/tcp + /proc/<pid>/fd 得出证明，不是任何形式的桩。
 */
function activeSession(sessionId = 's-preview', capability = CAPABILITY): any {
  return {
    session: {
      sessionId,
      status: 'active',
      chatId: 'oc_preview',
      rootMessageId: 'om_preview',
      title: 'Preview session',
      createdAt: '2026-08-11T12:00:00.000Z',
      workerGeneration: 5,
    },
    larkAppId: 'app-preview',
    workerGeneration: 5,
    worker: { pid: process.pid, killed: false },
    managedTurnOrigin: { capability },
  };
}

async function ensureIpc(): Promise<IpcServerHandle> {
  if (!ipc) {
    setIpcAuthSecret(HOST_SECRET);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  }
  return ipc;
}

async function reachablePort(): Promise<number> {
  targetServer = createServer((_req, res) => res.end('preview'));
  await new Promise<void>(resolve => targetServer!.listen(0, '127.0.0.1', resolve));
  return (targetServer.address() as { port: number }).port;
}

async function postPreview(
  sessionId: string,
  body: Record<string, unknown>,
  auth: 'capability' | 'signed' | 'none' = 'capability',
): Promise<Response> {
  const handle = await ensureIpc();
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/preview`;
  const payload = { ...body };
  if (auth === 'capability') payload.originCapability = CAPABILITY;
  const headers: HeadersInit = auth === 'signed'
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
    body: JSON.stringify(payload),
  });
}

describe('POST /api/sessions/:sessionId/preview', () => {
  itWithRealProcfs('validates, persists, publishes, and returns only a safe same-origin descriptor', async () => {
    const port = await reachablePort();
    const ds = activeSession();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const publish = vi.spyOn(dashboardEventBus, 'publish');

    const res = await postPreview(ds.session.sessionId, { port });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      preview: { path: '/preview/s-preview/' },
    });
    expect(body.preview.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const publicJson = JSON.stringify(body);
    expect(publicJson).not.toContain(String(port));
    for (const secret of [CAPABILITY, HOST_SECRET, 'originCapability', 'previewTarget', '127.0.0.1']) {
      expect(publicJson).not.toContain(secret);
    }

    expect(ds.session.previewTarget).toMatchObject({
      host: '127.0.0.1',
      port,
      workerGeneration: 5,
      owner: { pid: process.pid },
    });
    expect(update).toHaveBeenCalledWith(ds.session);
    expect(publish).toHaveBeenCalledWith({
      type: 'session.update',
      body: {
        sessionId: 's-preview',
        patch: { previewTarget: ds.session.previewTarget },
      },
    });
  });

  it('rejects a different session capability without revealing or mutating it', async () => {
    const port = await reachablePort();
    const foreign = activeSession('s-foreign', 'bd'.repeat(32));
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(foreign);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

    const res = await postPreview('s-foreign', { port });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'origin_unproven' });
    expect(foreign.session).not.toHaveProperty('previewTarget');
    expect(update).not.toHaveBeenCalled();
  });

  it('does not expose session existence to an unproven caller', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    const res = await postPreview('missing', { port: 3000 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'origin_unproven' });

    const trusted = await postPreview('missing', { port: 3000 }, 'signed');
    expect(trusted.status).toBe(404);
    expect(await trusted.json()).toEqual({ ok: false, error: 'session_not_active' });
  });

  it('rejects invalid ports before persistence', async () => {
    const ds = activeSession();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

    for (const port of [0, -1, 65_536, 3.14, '3000']) {
      const res = await postPreview(ds.session.sessionId, { port });
      expect(res.status, String(port)).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_port' });
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects remote, wildcard, and DNS hosts without connecting to them', async () => {
    const ds = activeSession();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

    for (const host of ['169.254.169.254', '10.0.0.5', '0.0.0.0', 'localhost', 'example.com']) {
      const res = await postPreview(ds.session.sessionId, { port: 80, host });
      expect(res.status, host).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'remote_host_forbidden' });
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('reports an unreachable loopback target explicitly and does not persist it', async () => {
    targetServer = createServer();
    await new Promise<void>(resolve => targetServer!.listen(0, '127.0.0.1', resolve));
    const port = (targetServer.address() as { port: number }).port;
    await new Promise<void>(resolve => targetServer!.close(() => resolve()));
    targetServer = null;
    const ds = activeSession();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

    const res = await postPreview(ds.session.sessionId, { port, host: '127.0.0.1' });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'preview_unreachable' });
    expect(ds.session).not.toHaveProperty('previewTarget');
    expect(update).not.toHaveBeenCalled();
  });

  itWithRealProcfs('P1-13: discards a registration whose worker generation advanced during the probe', async () => {
    const port = await reachablePort();
    const ds = activeSession();
    let lookups = 0;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(() => {
      lookups++;
      // 第一次查询 = handler 捕获 ds/代次，紧接着就进入 probe 的 await。在那个窗口里
      // 会话被 refork（或切了 CLI / 被 adopt），新一代 worker 上线、代次推进。
      if (lookups === 1) {
        queueMicrotask(() => {
          ds.workerGeneration = 6;
          ds.session.workerGeneration = 6;
        });
      }
      return ds;
    });
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const publish = vi.spyOn(dashboardEventBus, 'publish');

    const res = await postPreview(ds.session.sessionId, { port });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'preview_generation_changed' });
    // 上一代 CLI 的注册绝不能回填到新一代身上。
    expect(ds.session).not.toHaveProperty('previewTarget');
    expect(update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  itWithRealProcfs('P1-13: discards a registration whose session was closed during the probe', async () => {
    const port = await reachablePort();
    const ds = activeSession();
    let lookups = 0;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(() => {
      lookups++;
      if (lookups === 1) queueMicrotask(() => { ds.session.status = 'closed'; });
      return ds;
    });
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

    const res = await postPreview(ds.session.sessionId, { port });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'preview_generation_changed' });
    expect(ds.session).not.toHaveProperty('previewTarget');
    expect(update).not.toHaveBeenCalled();
  });

  it('Riff 矩阵: a remote sandbox session is explicitly unsupported, not "unreachable"', async () => {
    const port = await reachablePort();
    const ds = activeSession();
    ds.session.backendType = 'riff';
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

    const res = await postPreview(ds.session.sessionId, { port });

    // 远端 sandbox 的 Web 服务不在这台机器上：这不是偶发故障，重试多少次都一样。
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ ok: false, error: 'preview_unsupported' });
    expect(update).not.toHaveBeenCalled();
  });

  itWithRealProcfs('本机后端矩阵: pty/tmux/zellij still register normally', async () => {
    for (const backendType of ['pty', 'tmux', 'zellij']) {
      const port = await reachablePort();
      const ds = activeSession(`s-${backendType}`);
      ds.session.backendType = backendType;
      vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
      vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

      const res = await postPreview(ds.session.sessionId, { port });

      expect(res.status, backendType).toBe(200);
      expect(ds.session.previewTarget, backendType).toMatchObject({ port });
      vi.restoreAllMocks();
      await new Promise<void>(resolve => targetServer!.close(() => resolve()));
      targetServer = null;
    }
  });

  // ─── P1-3：同代次内的并发注册不得互相覆盖 ─────────────────────────────────
  //
  // 这条路由没有 per-session 串行化，`readJsonBody` 与 `probeSessionPreviewTarget`
  // 两处 await 都是真实让出点。原来的 CAS 只锚了会话对象 / 状态 / 代次 / worker /
  // 鉴权，**没有 previewTarget 自己**，于是谁先 settle 谁先写、后 settle 的无条件覆盖
  // ——胜负由 probe 耗时决定，不是由请求先后决定（单 host 超时 750ms，不带 host 时
  // 127.0.0.1 与 ::1 串行试，「A 慢一秒、B 快一毫秒」是常规而非极端）。
  itWithRealProcfs('P1-3: 慢请求不再覆盖 await 期间落地的新注册', async () => {
    const port = await reachablePort();
    const ds = activeSession();
    const winner = {
      host: '127.0.0.1', port: 4000, registeredAt: '2026-08-11T12:00:09.000Z',
      owner: { pid: 4242, procStart: '918273', inode: '556677' }, workerGeneration: 5,
    };
    let lookups = 0;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(() => {
      lookups++;
      // 第一次查询 = handler 捕获锚点，紧接着进入 probe 的 await。那个窗口里另一条
      // 并发注册（同代次、同样合法）先落地了。
      if (lookups === 1) queueMicrotask(() => { ds.session.previewTarget = winner; });
      return ds;
    });
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const publish = vi.spyOn(dashboardEventBus, 'publish');

    const res = await postPreview(ds.session.sessionId, { port });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'preview_target_changed' });
    // 先落地的那个原封不动，也没有第二条 preview 广播出去。
    expect(ds.session.previewTarget).toBe(winner);
    expect(update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  itWithRealProcfs('P1-3: 没有并发写入时，覆盖旧目标照常成功', async () => {
    const port = await reachablePort();
    const ds = activeSession();
    ds.session.previewTarget = {
      host: '127.0.0.1', port: 1111, registeredAt: '2026-08-10T00:00:00.000Z',
      owner: { pid: 4242, procStart: '918273', inode: '556677' }, workerGeneration: 5,
    };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

    const res = await postPreview(ds.session.sessionId, { port });

    expect(res.status).toBe(200);
    expect(ds.session.previewTarget).toMatchObject({ port });
  });

  itWithRealProcfs('restores in-memory state when durable persistence fails', async () => {
    const port = await reachablePort();
    const previous = {
      host: '127.0.0.1', port: 1111, registeredAt: '2026-08-10T00:00:00.000Z',
      owner: { pid: 4242, procStart: '918273', inode: '556677' }, workerGeneration: 4,
    };
    const ds = activeSession();
    ds.session.previewTarget = previous;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => { throw new Error('disk full'); });

    const res = await postPreview(ds.session.sessionId, { port });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'preview_persist_failed' });
    expect(ds.session.previewTarget).toBe(previous);
  });
});

describe('DELETE /api/sessions/:sessionId/preview', () => {
  it('P1-12: lets the central proxy retire a target whose port changed hands', async () => {
    const handle = await ensureIpc();
    const ds = activeSession();
    ds.session.previewTarget = {
      host: '127.0.0.1', port: 4173, registeredAt: '2026-08-11T12:00:00.000Z',
      owner: { pid: 4242, procStart: '918273', inode: '556677' }, workerGeneration: 5,
    };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const publish = vi.spyOn(dashboardEventBus, 'publish');
    const path = `/api/sessions/${ds.session.sessionId}/preview`;

    // 未签名调用改不了任何东西。
    const denied = await fetch(`http://127.0.0.1:${handle.port}${path}`, { method: 'DELETE' });
    expect(denied.status).toBe(401);
    expect(ds.session.previewTarget).toBeDefined();

    const allowed = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'DELETE',
      headers: daemonIpcAuthHeaders({
        secret: HOST_SECRET, port: handle.port, method: 'DELETE', path,
      }),
    });

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true, cleared: true });
    expect(ds.session.previewTarget).toBeUndefined();
    expect(update).toHaveBeenCalledWith(ds.session);
    expect(publish).toHaveBeenCalledWith({
      type: 'session.update',
      body: { sessionId: 's-preview', patch: { previewTarget: null } },
    });
  });
});

// ─── P1-3：在途 DELETE 不得误删这段窗口里刚注册的新目标 ──────────────────────
//
// 判定失效发生在代理进程，DELETE 落地在 daemon 进程，中间隔着一次跨进程往返。那段
// 窗口里会话完全可以合法地重注册一个新目标；无条件清空会把它一起抹掉，agent 刚拿到
// 的「✓ Web 预览已注册」立刻失效。
describe('DELETE /api/sessions/:sessionId/preview 带 expected revision', () => {
  const stale = {
    host: '127.0.0.1', port: 4173, registeredAt: '2026-08-11T12:00:00.000Z',
    owner: { pid: 4242, procStart: '918273', inode: '556677' }, workerGeneration: 5,
  };
  const fresh = {
    host: '127.0.0.1', port: 5173, registeredAt: '2026-08-11T12:00:07.000Z',
    owner: { pid: 4243, procStart: '918274', inode: '556678' }, workerGeneration: 5,
  };

  async function deletePreview(sessionId: string, expectedRegisteredAt?: string): Promise<Response> {
    const handle = await ensureIpc();
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/preview`;
    const path = expectedRegisteredAt === undefined
      ? base
      : `${base}?expectedRegisteredAt=${encodeURIComponent(expectedRegisteredAt)}`;
    return fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'DELETE',
      headers: daemonIpcAuthHeaders({
        secret: HOST_SECRET, port: handle.port, method: 'DELETE', path,
      }),
    });
  }

  it('revision 不匹配时是彻底的 no-op：不清、不写盘、不广播，且幂等回 200', async () => {
    const ds = activeSession();
    ds.session.previewTarget = fresh;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const publish = vi.spyOn(dashboardEventBus, 'publish');

    // 代理判定失效的是 stale，可 DELETE 飞到时会话已经重注册成 fresh。
    const res = await deletePreview(ds.session.sessionId, stale.registeredAt);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: false });
    expect(ds.session.previewTarget).toBe(fresh);
    expect(update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('revision 匹配时照常清掉并广播 preview: null', async () => {
    const ds = activeSession();
    ds.session.previewTarget = { ...stale };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const publish = vi.spyOn(dashboardEventBus, 'publish');

    const res = await deletePreview(ds.session.sessionId, stale.registeredAt);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: true });
    expect(ds.session.previewTarget).toBeUndefined();
    expect(update).toHaveBeenCalledWith(ds.session);
    expect(publish).toHaveBeenCalledWith({
      type: 'session.update',
      body: { sessionId: ds.session.sessionId, patch: { previewTarget: null } },
    });
  });

  it('不带 expected 时保持原来的无条件语义（换代/关闭等权威边界仍可一键清空）', async () => {
    const ds = activeSession();
    ds.session.previewTarget = { ...fresh };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

    const res = await deletePreview(ds.session.sessionId);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: true });
    expect(ds.session.previewTarget).toBeUndefined();
  });

  it('本来就没有目标时依旧幂等回 cleared:false', async () => {
    const ds = activeSession();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});

    const res = await deletePreview(ds.session.sessionId, stale.registeredAt);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: false });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:sessionId/preview', () => {
  it('requires trusted-host HMAC and returns no literal target', async () => {
    const handle = await ensureIpc();
    const ds = activeSession();
    ds.session.previewTarget = {
      host: '127.0.0.1', port: 4173, registeredAt: '2026-08-11T12:00:00.000Z',
      owner: { pid: 4242, procStart: '918273', inode: '556677' }, workerGeneration: 5,
    };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const path = `/api/sessions/${ds.session.sessionId}/preview`;

    const denied = await fetch(`http://127.0.0.1:${handle.port}${path}`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      headers: daemonIpcAuthHeaders({
        secret: HOST_SECRET, port: handle.port, method: 'GET', path,
      }),
    });
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as any;
    expect(body).toEqual({
      ok: true,
      preview: { path: '/preview/s-preview/', registeredAt: '2026-08-11T12:00:00.000Z' },
    });
    expect(JSON.stringify(body)).not.toContain('4173');
    expect(JSON.stringify(body)).not.toContain('127.0.0.1');
  });
});
