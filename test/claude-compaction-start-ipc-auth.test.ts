// POST /api/claude-compaction-start-v1 route-level authorization under the
// production gate.
//
// Claude's PreCompact hook (`botmux __claude-compaction-v1`) runs inside
// the CLI process, which in a bwrap / read-isolated session cannot read the
// host HMAC secret and presents this session's rotating per-turn capability in
// the body instead. The route therefore has to sit in the outer narrow
// aperture `routeHasNarrowUntrustedAuth`, or the server answers 401 before the
// handler runs and idle compaction is misjudged as an unread reply in exactly
// the isolated sessions.
//
// These tests run the REAL daemon route (src/daemon.ts registers it on import)
// behind `startIpcServer({ authRequired: true })`:
//   - live capability                       → 200, forwarded
//   - missing / stale capability            → 403, not forwarded
//   - unknown session                       → 403
//   - exact path only: a longer path is not admitted by the aperture
//   - trusted-host HMAC without a capability → 200, forwarded
//   - malformed bodies / startedAtMs        → 400, not forwarded
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { acknowledgeSessionReady } from '../src/core/session-ready-handshake.js';
import { __testOnly_activeSessions } from '../src/daemon.js';

const CAP = 'c0ffee00'.repeat(8);
const HOST_SECRET = 'test-ipc-claude-compaction-start-host-secret';
const SESSION_ID = 'sess-claude-compaction-start-ipc';
const TURN_ID = 'om_compaction_live';
const ATTEMPT = 2;
const PATH = '/api/claude-compaction-start-v1';

let handle: IpcServerHandle | null = null;
let workerSend: ReturnType<typeof vi.fn>;

/** The daemon resolves the session from its own active map, so register a
 *  minimal one whose worker records what the route forwards and acknowledges
 *  it the way the real worker does. */
function mountSession(): void {
  __testOnly_activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    managedTurnOrigin: { capability: CAP, turnId: TURN_ID, dispatchAttempt: ATTEMPT },
    worker: { send: workerSend },
  } as never);
}

async function post(body: Record<string, unknown> | string, auth: 'capability' | 'signed' | 'none' = 'capability'): Promise<Response> {
  const payload = typeof body === 'string'
    ? body
    : JSON.stringify(auth === 'capability' ? { originCapability: CAP, ...body } : { ...body });
  const headers: HeadersInit = auth === 'signed'
    ? daemonIpcAuthHeaders({
      secret: HOST_SECRET,
      port: handle!.port,
      method: 'POST',
      path: PATH,
      headers: { 'content-type': 'application/json' },
    })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${handle!.port}${PATH}`, { method: 'POST', headers, body: payload });
}

const STARTED_AT_MS = Date.now() - 1_000;
const LIVE_CLAIM = {
  sessionId: SESSION_ID,
  startedAtMs: STARTED_AT_MS,
  originTurnId: TURN_ID,
  originDispatchAttempt: ATTEMPT,
};

beforeEach(async () => {
  workerSend = vi.fn((msg: { requestId?: string }) => {
    if (msg.requestId) acknowledgeSessionReady(msg.requestId);
  });
  setIpcAuthSecret(HOST_SECRET);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  __testOnly_activeSessions.clear();
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

describe('POST /api/claude-compaction-start-v1 under authRequired', () => {
  it('forwards a signal that carries the live capability', async () => {
    mountSession();
    const res = await post(LIVE_CLAIM);
    // 200 (not 401): the outer gate let it through and the handler's own
    // capability check accepted it.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(workerSend).toHaveBeenCalledTimes(1);
    expect(workerSend).toHaveBeenCalledWith({
      type: 'claude_compaction_start',
      startedAtMs: STARTED_AT_MS,
      requestId: expect.any(String),
    });
  });

  it('refuses a missing or rotated capability with 403 (handler ran) and forwards nothing', async () => {
    mountSession();
    for (const res of [
      await post(LIVE_CLAIM, 'none'),
      await post({ ...LIVE_CLAIM, originCapability: 'deadbeef'.repeat(8) }, 'none'),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'origin_unproven' });
    }
    expect(workerSend).not.toHaveBeenCalled();
  });

  it('refuses a session the daemon does not know', async () => {
    mountSession();
    const res = await post({ ...LIVE_CLAIM, sessionId: 'sess-not-known' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'origin_unproven' });
    expect(workerSend).not.toHaveBeenCalled();
  });

  it('adds only the exact path to the aperture (no prefix admission)', async () => {
    mountSession();
    const res = await fetch(`http://127.0.0.1:${handle!.port}${PATH}/extra`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ originCapability: CAP, ...LIVE_CLAIM }),
    });
    expect(res.status).toBe(401);
    expect(workerSend).not.toHaveBeenCalled();
  });

  it('still accepts the trusted-host HMAC path without a capability', async () => {
    mountSession();
    const res = await post(LIVE_CLAIM, 'signed');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(workerSend).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed bodies and impossible start times with 400 and forwards nothing', async () => {
    mountSession();
    const cases: Array<[Record<string, unknown> | string, string]> = [
      ['not json', 'bad_json'],
      [{ ...LIVE_CLAIM, sessionId: undefined }, 'missing_sessionId'],
      [{ ...LIVE_CLAIM, startedAtMs: undefined }, 'invalid_startedAtMs'],
      [{ ...LIVE_CLAIM, startedAtMs: String(STARTED_AT_MS) }, 'invalid_startedAtMs'],
      [{ ...LIVE_CLAIM, startedAtMs: -1 }, 'invalid_startedAtMs'],
      [{ ...LIVE_CLAIM, startedAtMs: STARTED_AT_MS + 0.5 }, 'invalid_startedAtMs'],
      [{ ...LIVE_CLAIM, startedAtMs: Date.now() + 60_000 }, 'invalid_startedAtMs'],
    ];
    for (const [body, error] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error });
    }
    expect(workerSend).not.toHaveBeenCalled();
  });
});
