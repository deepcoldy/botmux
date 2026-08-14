// POST /api/sessions/:sessionId/prompt-ctx/claim route-level authorization matrix.
//
// review HIGH-1：claim 路由必须在外层白名单 routeHasNarrowUntrustedAuth 里，
// 否则沙箱 hook（读不到 host secret、走 body capability）会被外层 401 挡死，
// handler 根本不执行。本测试在 authRequired: true 下验证：
//   - 本会话正确 capability → 到 handler，返回 envelope
//   - 错误/过期 capability → 403
//   - 跨会话 capability → 403
//   - 无 capability → 403
//   - trusted-host HMAC → 200（不依赖 capability）
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';

const CAP = 'c0ffee12'.repeat(8);
const HOST_SECRET = 'test-ipc-claim-host-secret';
let handle: IpcServerHandle | null = null;

// claim 路由依赖的 store 函数：mock 掉，只验证路由鉴权与参数传递。
const claimMock = vi.fn();
vi.mock('../src/services/prompt-context-store.js', () => ({
  claimPromptContext: (...args: unknown[]) => claimMock(...args),
}));

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
  claimMock.mockReset();
});

async function postClaim(sessionId: string, body: Record<string, unknown>, opts: {
  auth?: 'capability' | 'signed' | 'none';
  capability?: string;
} = {}): Promise<Response> {
  if (!handle) {
    setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({
      port: 0,
      host: '127.0.0.1',
      authRequired: true,
    });
  }
  const auth = opts.auth ?? 'capability';
  const path = `/api/sessions/${sessionId}/prompt-ctx/claim`;
  const reqBody: Record<string, unknown> = { ...body };
  if (auth === 'capability') reqBody.originCapability = opts.capability ?? CAP;
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
    body: JSON.stringify(reqBody),
  });
}

function mockSession(sessionId: string, opts: { capability?: string; turnId?: string } = {}) {
  vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
    session: { sessionId },
    managedTurnOrigin: { capability: opts.capability ?? CAP, turnId: opts.turnId ?? 'turn-1' },
    larkAppId: 'app-1',
  } as any);
}

const VALID_BODY = {
  fingerprint: 'a'.repeat(64),
  prefix: 'some-prefix',
};

describe('POST /api/sessions/:sessionId/prompt-ctx/claim', () => {
  it('accepts the exact live session capability and returns the envelope (authRequired: true)', async () => {
    mockSession('s-claim');
    claimMock.mockReturnValue('<botmux_reminder>提醒</botmux_reminder>');

    const res = await postClaim('s-claim', VALID_BODY, { authRequired: true } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, envelope: '<botmux_reminder>提醒</botmux_reminder>' });
    // 按权威 turnId claim（不是 FIFO）
    expect(claimMock).toHaveBeenCalledWith('s-claim', 'turn-1', 'a'.repeat(64), 'some-prefix');
  });

  it('rejects a wrong capability with 403 (authRequired: true)', async () => {
    mockSession('s-claim');
    claimMock.mockReturnValue('should-not-return');

    const res = await postClaim('s-claim', VALID_BODY, { capability: 'deadbeef'.repeat(8) });

    expect(res.status).toBe(403);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('rejects a cross-session capability with 403', async () => {
    // 会话 A 的 capability 不能领会话 B 的 envelope：findActiveBySessionId 对 B
    // 返回 undefined（会话不存在），sessionExists: false → origin_unproven → 403。
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation((sid: string) => {
      if (sid !== 's-claim') return undefined as any;
      return {
        session: { sessionId: 's-claim' },
        managedTurnOrigin: { capability: CAP, turnId: 'turn-1' },
        larkAppId: 'app-1',
      } as any;
    });
    claimMock.mockReturnValue('should-not-return');

    const res = await postClaim('s-other', VALID_BODY, { capability: CAP });

    expect(res.status).toBe(403);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('rejects a missing capability with 403', async () => {
    mockSession('s-claim');
    claimMock.mockReturnValue('should-not-return');

    const res = await postClaim('s-claim', VALID_BODY, { auth: 'none' });

    expect(res.status).toBe(403);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('accepts trusted-host HMAC without a capability', async () => {
    mockSession('s-claim');
    claimMock.mockReturnValue('<botmux_reminder>提醒</botmux_reminder>');

    const res = await postClaim('s-claim', VALID_BODY, { auth: 'signed' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, envelope: '<botmux_reminder>提醒</botmux_reminder>' });
  });

  it('returns 404 when no active turn (managedTurnOrigin.turnId missing)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-claim' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
    } as any);
    claimMock.mockReturnValue('should-not-return');

    const res = await postClaim('s-claim', VALID_BODY);

    expect(res.status).toBe(404);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid fingerprint', async () => {
    mockSession('s-claim');
    claimMock.mockReturnValue('should-not-return');

    const res = await postClaim('s-claim', { fingerprint: 'not-a-hash' });

    expect(res.status).toBe(400);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the store has no envelope', async () => {
    mockSession('s-claim');
    claimMock.mockReturnValue(undefined);

    const res = await postClaim('s-claim', VALID_BODY);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not_found' });
  });

  it('accepts a VC receiver session with the correct capability (allowReceiver: true)', async () => {
    // review 三审：sessionCliIpcAuth 默认 allowReceiver:false 会 403 receiver 会话；
    // claim 只读自己本轮的 reminder/whiteboard（非 managed action），单独 allowReceiver:true。
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-receiver', vcMeetingReceiver: {} },
      managedTurnOrigin: { capability: CAP, turnId: 'turn-1' },
      larkAppId: 'app-1',
    } as any);
    claimMock.mockReturnValue('<botmux_reminder>提醒</botmux_reminder>');

    const res = await postClaim('s-receiver', VALID_BODY);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, envelope: '<botmux_reminder>提醒</botmux_reminder>' });
    expect(claimMock).toHaveBeenCalledWith('s-receiver', 'turn-1', 'a'.repeat(64), 'some-prefix');
  });
});
