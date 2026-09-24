import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

const HOST_SECRET = 'test-ipc-whiteboard-host-secret';
let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

async function postWhiteboard(sessionId: string, body: unknown): Promise<Response> {
  if (!handle) {
    setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  }
  const path = `/api/sessions/${sessionId}/whiteboard`;
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers: daemonIpcAuthHeaders({
      secret: HOST_SECRET,
      port: handle.port,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
    }),
    body: JSON.stringify(body),
  });
}

function mockOwnedSession(session: Record<string, unknown>): void {
  vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
    session,
    larkAppId: session.larkAppId,
  } as any);
}

describe('POST /api/sessions/:sessionId/whiteboard', () => {
  it('binds a non-empty whiteboard id onto the owned session', async () => {
    const session = { sessionId: 's-wb', larkAppId: 'app-1', whiteboardId: undefined as string | undefined };
    mockOwnedSession(session);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const res = await postWhiteboard('s-wb', { whiteboardId: 'wb_live' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, whiteboardId: 'wb_live' });
    expect(session.whiteboardId).toBe('wb_live');
    expect(update).toHaveBeenCalledOnce();
  });

  it('clears the binding when whiteboardId is null', async () => {
    const session = { sessionId: 's-wb-clear', larkAppId: 'app-1', whiteboardId: 'wb_gone' as string | undefined };
    mockOwnedSession(session);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const res = await postWhiteboard('s-wb-clear', { whiteboardId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, whiteboardId: null });
    expect(session.whiteboardId).toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
  });

  it('clears only when expectWhiteboardId still matches', async () => {
    const session = { sessionId: 's-wb-cas', larkAppId: 'app-1', whiteboardId: 'wb_old' as string | undefined };
    mockOwnedSession(session);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const res = await postWhiteboard('s-wb-cas', { whiteboardId: null, expectWhiteboardId: 'wb_old' });
    expect(res.status).toBe(200);
    expect(session.whiteboardId).toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
  });

  it('refuses with 409 when the session was rebound after the caller looked', async () => {
    // Deleting a board removes it from the index, so the daemon's
    // ensureSessionWhiteboard mints a replacement on the next turn. A late
    // unconditional clear would drop that fresh binding and orphan the board.
    const session = { sessionId: 's-wb-rebound', larkAppId: 'app-1', whiteboardId: 'wb_new' as string | undefined };
    mockOwnedSession(session);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const res = await postWhiteboard('s-wb-rebound', { whiteboardId: null, expectWhiteboardId: 'wb_deleted' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'whiteboard_changed', whiteboardId: 'wb_new' });
    expect(session.whiteboardId).toBe('wb_new');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a non-string expectWhiteboardId', async () => {
    const session = { sessionId: 's-wb-bad-expect', larkAppId: 'app-1', whiteboardId: 'wb_keep' };
    mockOwnedSession(session);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const res = await postWhiteboard('s-wb-bad-expect', { whiteboardId: null, expectWhiteboardId: 7 });
    expect(res.status).toBe(400);
    expect(session.whiteboardId).toBe('wb_keep');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an empty string (unbind is null, not "")', async () => {
    const session = { sessionId: 's-wb-empty', larkAppId: 'app-1', whiteboardId: 'wb_keep' };
    mockOwnedSession(session);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const res = await postWhiteboard('s-wb-empty', { whiteboardId: '' });
    expect(res.status).toBe(400);
    expect(session.whiteboardId).toBe('wb_keep');
    expect(update).not.toHaveBeenCalled();
  });
});
