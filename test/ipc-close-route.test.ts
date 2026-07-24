// POST /api/sessions/:sessionId/close route-level authorization matrix.
// Trusted host callers retain dashboard/admin behavior; an untrusted in-session
// caller may only close the exact live session whose rotating capability it owns.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';

const CAP = 'c0ffee12'.repeat(8);
const HOST_SECRET = 'test-ipc-close-host-secret';
let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

async function postClose(sessionId: string, opts: {
  auth?: 'capability' | 'signed' | 'none';
  authRequired?: boolean;
  capability?: string;
} = {}): Promise<Response> {
  if (!handle) {
    if (opts.authRequired) setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({
      port: 0,
      host: '127.0.0.1',
      ...(opts.authRequired ? { authRequired: true } : {}),
    });
  }
  const auth = opts.auth ?? 'capability';
  const path = `/api/sessions/${sessionId}/close`;
  const body: Record<string, unknown> = {};
  if (auth === 'capability') body.originCapability = opts.capability ?? CAP;
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
    body: JSON.stringify(body),
  });
}

describe('POST /api/sessions/:sessionId/close', () => {
  it('accepts the exact live session capability and delegates to canonical closeSession', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-close' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
    } as any);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockResolvedValue({ ok: true, alreadyClosed: false });

    const res = await postClose('s-close', { authRequired: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyClosed: false });
    expect(closeSpy).toHaveBeenCalledWith('s-close');
  });

  it('rejects a missing or stale capability without closing anything', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-close-denied' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
    } as any);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockResolvedValue({ ok: true, alreadyClosed: false });

    const missing = await postClose('s-close-denied', {
      auth: 'none',
      authRequired: true,
    });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ ok: false, error: 'origin_unproven' });

    const stale = await postClose('s-close-denied', {
      capability: 'bad0'.repeat(16),
    });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('does not reveal whether an unproven target session exists', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockResolvedValue({ ok: true, alreadyClosed: true });

    const res = await postClose('missing', { authRequired: true });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('keeps trusted-host close idempotent for an already missing session', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockResolvedValue({ ok: true, alreadyClosed: true });

    const res = await postClose('missing', {
      auth: 'signed',
      authRequired: true,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyClosed: true });
    expect(closeSpy).toHaveBeenCalledWith('missing');
  });

  it('denies receiver-session self-close through the ordinary capability aperture', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-receiver', vcMeetingReceiver: { meetingId: 'm' } },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
    } as any);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockResolvedValue({ ok: true, alreadyClosed: false });

    const res = await postClose('s-receiver', { authRequired: true });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'managed_action_required' });
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
