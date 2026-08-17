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
  it('validates, persists, publishes, and returns only a safe same-origin descriptor', async () => {
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

  it('P1-13: discards a registration whose worker generation advanced during the probe', async () => {
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

  it('P1-13: discards a registration whose session was closed during the probe', async () => {
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

  it('本机后端矩阵: pty/tmux/zellij still register normally', async () => {
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

  it('restores in-memory state when durable persistence fails', async () => {
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
