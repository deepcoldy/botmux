// test/ipc-slash-route.test.ts
//
// POST /api/sessions/:sessionId/slash 路由级分支矩阵。
//
// 手法沿用 test/ipc-cd-route.test.ts：起真实 IPC server（port 0）+ fetch，
// 依赖经 vi.spyOn(模块命名空间) 打桩（vitest 的 vite 转换让被测模块的具名
// import 走命名空间访问，spy 即时生效）。allowlist 依赖 getBotTuiSlashAllow
// （bot-registry 内存态注册表的只读 accessor）——同样用 vi.spyOn(bot-registry
// 命名空间) 打桩，避免真的注册 bot / 构造 Lark client。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as botRegistry from '../src/bot-registry.js';

/** 会话当前轮换 capability（daemon 侧 ds.managedTurnOrigin 与请求 body 双方持有）。 */
const CAP = 'cafebabe'.repeat(8);
const HOST_SECRET = 'test-ipc-slash-host-secret';

let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

/** auth 三态：capability（默认，沙箱/读隔离 CLI 姿势）/ signed（trusted-host
 *  HMAC，需 authRequired 服务器）/ none（未证明身份的裸调用）。 */
async function postSlash(sessionId: string, command?: string, opts: {
  auth?: 'capability' | 'signed' | 'none';
  authRequired?: boolean;
} = {}): Promise<Response> {
  if (!handle) {
    if (opts.authRequired) setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', ...(opts.authRequired ? { authRequired: true } : {}) });
  }
  const auth = opts.auth ?? 'capability';
  const path = `/api/sessions/${sessionId}/slash`;
  const bodyObj: Record<string, unknown> = command === undefined ? {} : { command };
  if (auth === 'capability') bodyObj.originCapability = CAP;
  const headers: HeadersInit = auth === 'signed'
    ? daemonIpcAuthHeaders({ secret: HOST_SECRET, port: handle.port, method: 'POST', path, headers: { 'content-type': 'application/json' } })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${handle.port}${path}`, { method: 'POST', headers, body: JSON.stringify(bodyObj) });
}

describe('POST /api/sessions/:sessionId/slash', () => {
  it('404s for sessions that are not active — trusted-host caller (signed, authRequired on)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);

    const res = await postSlash('missing', '/status', { auth: 'signed', authRequired: true });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'session_not_active' });
  });

  it('409s adopt sessions (adoptedFrom set) — machine injection would collide with the user typing in their own pane', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-adopt', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: { source: 'tmux', tmuxTarget: '0:1.0', cwd: '/x' },
    } as any);

    const res = await postSlash('s-adopt', '/status');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'adopt_inject_unsupported' });
    expect(send).not.toHaveBeenCalled();
  });

  it('409s when there is no live worker', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-noworker', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
      worker: null,
      adoptedFrom: undefined,
    } as any);

    const res = await postSlash('s-noworker', '/status');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'no_live_worker' });
  });

  it('403s: empty/unconfigured allowlist denies by default, and /cd stays forbidden even when allowlisted', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-403', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    const allowSpy = vi.spyOn(botRegistry, 'getBotTuiSlashAllow');

    // 未配置 allowlist（undefined）→ 默认全拒。
    allowSpy.mockReturnValue(undefined);
    const resEmpty = await postSlash('s-403', '/status');
    expect(resEmpty.status).toBe(403);
    expect(await resEmpty.json()).toMatchObject({ ok: false, error: 'allowlist_empty' });

    // /cd 即使出现在 allowlist 里也被固定黑名单拒绝——它必须走专用 cd 路由。
    allowSpy.mockReturnValue(['/cd', '/status']);
    const resForbidden = await postSlash('s-403', '/cd /tmp');
    expect(resForbidden.status).toBe(403);
    expect(await resForbidden.json()).toMatchObject({ ok: false, error: 'command_forbidden' });

    expect(send).not.toHaveBeenCalled();
  });

  it('200 queues an allowlisted command — worker.send gets a bare inject_command (no updateWorkingDir)', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-ok', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    vi.spyOn(botRegistry, 'getBotTuiSlashAllow').mockReturnValue(['/status']);

    const res = await postSlash('s-ok', '/status');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionId: 's-ok', queued: '/status' });
    // 与 cd 路由的区别：通用 slash 注入不带 workingDir 更新（只有 cd 路由才带）。
    expect(send).toHaveBeenCalledWith({ type: 'inject_command', command: '/status' });
    expect(send.mock.calls[0][0]).not.toHaveProperty('updateWorkingDir');
  });

  it('403s origin_unproven: no capability presented (active session, untrusted caller)', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-noauth', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    vi.spyOn(botRegistry, 'getBotTuiSlashAllow').mockReturnValue(['/status']);

    const res = await postSlash('s-noauth', '/status', { auth: 'none' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
    expect(send).not.toHaveBeenCalled();
  });

  it('403s origin_unproven: wrong capability (stale/forged token never matches live origin)', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-wrongcap', cliId: 'claude-code' },
      managedTurnOrigin: { capability: 'f00d'.repeat(16) },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    vi.spyOn(botRegistry, 'getBotTuiSlashAllow').mockReturnValue(['/status']);

    const res = await postSlash('s-wrongcap', '/status');  // CAP != live capability

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
    expect(send).not.toHaveBeenCalled();
  });

  it('403s origin_unproven (NOT 404) for a missing session when the caller is unproven — no active-session probe oracle', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);

    const res = await postSlash('missing', '/status');  // capability 无从匹配（无活跃记录）

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
  });

  it('authRequired=true：capability 请求免 HMAC 过窄孔（沙箱/读隔离 CLI 主链路）；未证明身份仍 403', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-gated', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    vi.spyOn(botRegistry, 'getBotTuiSlashAllow').mockReturnValue(['/status']);

    // 生产形态（authRequired: true）下，路由在 routeHasNarrowUntrustedAuth 白名单内：
    // 未签名请求不会在外层 gate 被 401，而是进 handler 验 capability。
    const ok = await postSlash('s-gated', '/status', { authRequired: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, queued: '/status' });

    const bad = await postSlash('s-gated', '/status', { auth: 'none' });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
  });

  it('authRequired=true：非白名单路由未签名一律 401（对照组，证明窄孔没把大门敞开）', async () => {
    if (!handle) {
      setIpcAuthSecret(HOST_SECRET);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    }
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/whatever/suspend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('502s when worker.send() throws — slash is stateless, no repin to reconcile, so no kill needed', async () => {
    const send = vi.fn(() => { throw new Error('EPIPE: worker channel closed'); });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-send-throws', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    vi.spyOn(botRegistry, 'getBotTuiSlashAllow').mockReturnValue(['/status']);
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postSlash('s-send-throws', '/status');

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: 'worker_send_failed' });
    expect(killSpy).not.toHaveBeenCalled();
  });
});
