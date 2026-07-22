import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import {
  __testOnly_resetSessionSelfCloseReceipts,
  deriveSessionSelfCloseCapability,
} from '../src/core/session-self-close.js';
import * as workerPool from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

const HOST_SECRET = 'self-close-route-host-secret';
const ORIGIN_CAPABILITY = '12'.repeat(32);
const ACTION_CAPABILITY = deriveSessionSelfCloseCapability(ORIGIN_CAPABILITY);

let handle: IpcServerHandle | null = null;

function session(adopted = false): DaemonSession {
  return {
    session: { sessionId: adopted ? 'session-adopted' : 'session-a' },
    larkAppId: 'app-a',
    chatId: 'chat-a',
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 1,
    lastMessageAt: 1,
    hasHistory: true,
    managedTurnOrigin: {
      capability: ORIGIN_CAPABILITY,
      turnId: 'turn-a',
      dispatchAttempt: 3,
    },
    ...(adopted
      ? { adoptedFrom: { cliId: 'claude-code', sessionId: 'external-session' } }
      : {}),
  } as DaemonSession;
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability: ACTION_CAPABILITY,
    turnId: 'turn-a',
    dispatchAttempt: 3,
    ...overrides,
  };
}

async function post(payload: Record<string, unknown>): Promise<Response> {
  if (!handle) {
    setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({
      port: 0,
      host: '127.0.0.1',
      authRequired: true,
    });
  }
  return fetch(`http://127.0.0.1:${handle.port}/api/sessions/self/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  __testOnly_resetSessionSelfCloseReceipts();
  vi.restoreAllMocks();
});

describe('POST /api/sessions/self/close', () => {
  it('accepts an unsigned action capability and cleans up only after commit', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'listActiveSessions').mockReturnValue([ds]);
    const committed = { sessionId: ds.session.sessionId, session: ds };
    const commit = vi.spyOn(workerPool, 'commitSessionSelfClose')
      .mockReturnValue(committed);
    const cleanup = vi.spyOn(workerPool, 'cleanupCommittedSessionSelfClose')
      .mockResolvedValue();

    const res = await post(body());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      accepted: true,
      sessionId: 'session-a',
      alreadyClosed: false,
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(ds);
    await new Promise(resolve => setImmediate(resolve));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(committed);
  });

  it('rejects missing, generic, stale, and caller-targeted proofs', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'listActiveSessions').mockReturnValue([ds]);
    const commit = vi.spyOn(workerPool, 'commitSessionSelfClose');

    for (const payload of [
      {},
      body({ capability: ORIGIN_CAPABILITY }),
      body({ capability: '34'.repeat(32) }),
      body({ sessionId: 'session-b' }),
      body({ turnId: 'turn-old' }),
      body({ dispatchAttempt: 2 }),
    ]) {
      const res = await post(payload);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        ok: false,
        accepted: false,
        error: 'self_close_denied',
      });
    }
    expect(commit).not.toHaveBeenCalled();
  });

  it('makes an exact duplicate idempotent without lifecycle side effects', async () => {
    const ds = session();
    const list = vi.spyOn(workerPool, 'listActiveSessions').mockReturnValue([ds]);
    const committed = { sessionId: ds.session.sessionId, session: ds };
    const commit = vi.spyOn(workerPool, 'commitSessionSelfClose')
      .mockReturnValue(committed);
    const cleanup = vi.spyOn(workerPool, 'cleanupCommittedSessionSelfClose')
      .mockResolvedValue();

    const first = await post(body());
    expect(first.status).toBe(200);
    await first.json();
    list.mockReturnValue([]);
    const second = await post(body());
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      accepted: true,
      sessionId: 'session-a',
      alreadyClosed: true,
    });
    expect(commit).toHaveBeenCalledOnce();
    await new Promise(resolve => setImmediate(resolve));
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not report success or start cleanup when the logical barrier fails', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'listActiveSessions').mockReturnValue([ds]);
    vi.spyOn(workerPool, 'commitSessionSelfClose')
      .mockImplementation(() => { throw new Error('persistence unavailable'); });
    const cleanup = vi.spyOn(workerPool, 'cleanupCommittedSessionSelfClose');

    const res = await post(body());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      accepted: false,
      error: 'close_barrier_failed',
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('closes an adopted botmux bridge instead of rejecting the session type', async () => {
    const ds = session(true);
    vi.spyOn(workerPool, 'listActiveSessions').mockReturnValue([ds]);
    const committed = { sessionId: ds.session.sessionId, session: ds };
    vi.spyOn(workerPool, 'commitSessionSelfClose').mockReturnValue(committed);
    const cleanup = vi.spyOn(workerPool, 'cleanupCommittedSessionSelfClose')
      .mockResolvedValue();

    const res = await post(body());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      sessionId: 'session-adopted',
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(cleanup).toHaveBeenCalledWith(committed);
  });
});
