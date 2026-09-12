import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as botRegistry from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { disposeReadonlyTaskContinuation } from '../src/services/readonly-task-continuation.js';

const CAP = 'ab12cd34'.repeat(8);
const SESSION_ID = 's-readonly-continuation';
let handle: IpcServerHandle | null = null;

function session(overrides: Record<string, unknown> = {}) {
  const worker = { killed: false, connected: true };
  return {
    session: {
      sessionId: SESSION_ID,
      status: 'active',
      cliId: 'traex',
      workerGeneration: 3,
      ...((overrides.session as Record<string, unknown> | undefined) ?? {}),
    },
    managedTurnOrigin: { capability: CAP, turnId: 'om_original' },
    worker,
    workerReady: true,
    workerGeneration: 3,
    readonlyContinuationRpcProof: { workerGeneration: 3, rpcGeneration: 'rpc-proof', checkedAt: 1 },
    larkAppId: 'app-1',
    chatId: 'oc-chat',
    chatType: 'group',
    scope: 'thread',
    ...overrides,
  } as any;
}

async function post(body: Record<string, unknown>): Promise<Response> {
  if (!handle) {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  }
  return fetch(`http://127.0.0.1:${handle.port}/api/sessions/${SESSION_ID}/continuation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      originCapability: CAP,
      originTurnId: 'om_original',
      ...body,
    }),
  });
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  delete process.env.BOTMUX_READONLY_CONTINUATION_ENABLED;
  disposeReadonlyTaskContinuation({ sessionId: SESSION_ID });
  vi.restoreAllMocks();
});

describe('POST /api/sessions/:sessionId/continuation', () => {
  it('starts, hands off to the user, and cancels only the current ordinary TraeX turn', async () => {
    process.env.BOTMUX_READONLY_CONTINUATION_ENABLED = 'true';
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { cliId: 'traex' } } as any);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const started = await post({
      action: 'start',
      readonly: true,
      ttlMs: 120_000,
      maxContinuations: 2,
    });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      ok: true,
      state: {
        logicalTurnId: 'om_original',
        currentTurnId: 'om_original',
        status: 'active',
        maxContinuations: 2,
      },
    });

    const awaiting = await post({ action: 'await-user' });
    expect(awaiting.status).toBe(200);
    expect(await awaiting.json()).toMatchObject({ ok: true, state: { status: 'awaiting_user' } });

    const restarted = await post({ action: 'start', readonly: true });
    expect(restarted.status).toBe(200);
    const cancelled = await post({ action: 'cancel' });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ ok: true, state: { status: 'cancelled' } });
  });

  it('rejects missing capability, stale turn, synthetic turn, and dispatch attempts', async () => {
    process.env.BOTMUX_READONLY_CONTINUATION_ENABLED = 'true';
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { cliId: 'traex' } } as any);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const missingCapability = await post({ originCapability: undefined, action: 'start', readonly: true });
    expect(missingCapability.status).toBe(403);

    const staleTurn = await post({ originTurnId: 'om_stale', action: 'start', readonly: true });
    expect(staleTurn.status).toBe(409);
    expect(await staleTurn.json()).toMatchObject({ ok: false, error: 'active_turn_required' });

    ds.managedTurnOrigin = { capability: CAP, turnId: 'bmx-synthetic' };
    const synthetic = await post({
      originTurnId: 'bmx-synthetic',
      action: 'start',
      readonly: true,
    });
    expect(synthetic.status).toBe(409);
    expect(await synthetic.json()).toMatchObject({ ok: false, error: 'ordinary_user_turn_required' });

    ds.managedTurnOrigin = { capability: CAP, turnId: 'om_attempt', dispatchAttempt: 2 };
    const retryAttempt = await post({
      originTurnId: 'om_attempt',
      originDispatchAttempt: 2,
      action: 'start',
      readonly: true,
    });
    expect(retryAttempt.status).toBe(409);
    expect(await retryAttempt.json()).toMatchObject({ ok: false, error: 'ordinary_user_turn_required' });
  });

  it('is unavailable by default and for non-TraeX sessions', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const botSpy = vi.spyOn(botRegistry, 'getBot')
      .mockReturnValue({ config: { cliId: 'traex' } } as any);

    const disabled = await post({ action: 'start', readonly: true });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({
      ok: false, error: 'readonly_continuation_unavailable',
    });

    process.env.BOTMUX_READONLY_CONTINUATION_ENABLED = 'true';
    botSpy.mockReturnValue({ config: { cliId: 'codex' } } as any);
    ds.session.cliId = 'codex';
    const nonTraex = await post({ action: 'start', readonly: true });
    expect(nonTraex.status).toBe(409);
    expect(await nonTraex.json()).toMatchObject({
      ok: false, error: 'readonly_continuation_unavailable',
    });
  });

  it('returns non-200 and retains a failed fence when cancel persistence fails', async () => {
    process.env.BOTMUX_READONLY_CONTINUATION_ENABLED = 'true';
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { cliId: 'traex' } } as any);
    const persist = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    expect((await post({ action: 'start', readonly: true })).status).toBe(200);
    persist.mockImplementation(() => { throw new Error('session store unavailable'); });
    const cancelled = await post({ action: 'cancel' });

    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toEqual({ ok: false, error: 'session store unavailable' });
    expect(ds.session.readonlyTaskContinuation).toMatchObject({
      status: 'failed',
      lastErrorCode: 'readonly_continuation_explicit_cancel_persist_failed',
    });
  });
});
