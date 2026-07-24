// test/ipc-spawn-command-route.test.ts
//
// GET /api/sessions/:sessionId/spawn-command 的鉴权 + active-only + 内存来源
// （codex review 补测）。复现命令含 provider token/凭证，路由必须：
//   - 过 loopback-HMAC（ipcHmacAuthorized）；未签名请求 401。
//   - 只读 active session 的**内存**字段 DaemonSession.spawnCommand；非 active → 404，
//     不从持久化 session 取（避免误暴露、也确认没落盘）。
//   - active 但无命令（riff / warm reattach / daemon 刚重启还没 ready）→ 404 unavailable。
//
// 手法沿用 test/ipc-cd-route.test.ts：真实 IPC server(port 0) + fetch + spyOn。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';

const HOST_SECRET = 'test-spawn-cmd-secret';
let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

async function getSpawnCommand(sessionId: string, opts: { auth?: 'signed' | 'none' } = {}): Promise<Response> {
  if (!handle) {
    setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  }
  const path = `/api/sessions/${sessionId}/spawn-command`;
  const headers: HeadersInit = (opts.auth ?? 'signed') === 'signed'
    ? daemonIpcAuthHeaders({ secret: HOST_SECRET, port: handle.port, method: 'GET', path, headers: {} })
    : {};
  return fetch(`http://127.0.0.1:${handle.port}${path}`, { method: 'GET', headers });
}

describe('GET /api/sessions/:sessionId/spawn-command', () => {
  it('401s an unsigned request (loopback-HMAC gate, same as write-link)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's1' }, spawnCommand: "cd '/repo' && '/opt/claude'",
    } as any);
    const res = await getSpawnCommand('s1', { auth: 'none' });
    expect(res.status).toBe(401);
  });

  it('returns the in-memory spawnCommand for an active session (signed)', async () => {
    const CMD = "cd '/repo' && SESSION_DATA_DIR='/d' '/opt/claude' '--session-id' 's1'";
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's1' }, spawnCommand: CMD,
    } as any);
    const res = await getSpawnCommand('s1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, command: CMD });
  });

  it('404 session_not_active when the session is not active (never reads persisted store)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    const res = await getSpawnCommand('missing');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'session_not_active' });
  });

  it('404 spawn_command_unavailable when active but no command (riff / warm reattach / pre-ready)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-riff' }, spawnCommand: undefined,
    } as any);
    const res = await getSpawnCommand('s-riff');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'spawn_command_unavailable' });
  });
});
