// POST /api/turn-idle route-level authorization under the production gate.
//
// The dsh-tui wrapper plugin runs INSIDE the CLI process and (in a bwrap /
// read-isolated session) cannot read the host HMAC secret, so `botmux
// turn-idle-v2` presents this session's rotating per-turn capability in the
// body instead. That only works if the route is in the outer narrow aperture
// `routeHasNarrowUntrustedAuth`: otherwise the server answers 401 before the
// handler ever runs and the channel is silently dead for exactly the sessions
// it was built for (the CLI swallows the failure by design).
//
// These tests run the REAL daemon route (src/daemon.ts registers it on import)
// behind `startIpcServer({ authRequired: true })`:
//   - live capability + matching (turn, dispatch generation) → 200, forwarded
//   - missing / stale capability                          → 403 (handler ran)
//   - live capability naming another turn                 → 403 (bound to origin)
//   - unrelated unsigned route                            → 401 (gate intact)
//   - exact path only: a longer path is not admitted by the aperture
//   - trusted-host HMAC without a capability              → 200 (unchanged)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { __testOnly_activeSessions } from '../src/daemon.js';

const CAP = 'a1b2c3d4'.repeat(8);
const HOST_SECRET = 'test-ipc-turn-idle-host-secret';
const SESSION_ID = 'sess-turn-idle-ipc';
const TURN_ID = 'turn-idle-live';
const ATTEMPT = 3;

let handle: IpcServerHandle | null = null;

/** The daemon resolves the session from its own active map, so register a
 *  minimal one: no worker means the route answers 200 without forwarding. */
function mountSession(overrides: {
  capability?: string | undefined;
  turnId?: string | undefined;
  dispatchAttempt?: number | undefined;
} = {}): void {
  __testOnly_activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    managedTurnOrigin: {
      capability: 'capability' in overrides ? overrides.capability : CAP,
      turnId: 'turnId' in overrides ? overrides.turnId : TURN_ID,
      dispatchAttempt: 'dispatchAttempt' in overrides ? overrides.dispatchAttempt : ATTEMPT,
    },
  } as never);
}

async function postTurnIdle(body: Record<string, unknown>, auth: 'capability' | 'signed' | 'none' = 'capability'): Promise<Response> {
  const path = '/api/turn-idle';
  const payload = auth === 'capability' ? { originCapability: CAP, ...body } : { ...body };
  const headers: HeadersInit = auth === 'signed'
    ? daemonIpcAuthHeaders({
      secret: HOST_SECRET,
      port: handle!.port,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
    })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${handle!.port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

const LIVE_CLAIM = {
  sessionId: SESSION_ID,
  originTurnId: TURN_ID,
  originDispatchAttempt: ATTEMPT,
  seq: 1,
  pid: 4242,
};

beforeEach(async () => {
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

describe('POST /api/turn-idle under authRequired', () => {
  it('admits an unsigned request that carries the live capability into the handler', async () => {
    mountSession();
    const res = await postTurnIdle(LIVE_CLAIM);
    // 200 (not 401): the outer gate let it through and the handler's own
    // capability + origin binding accepted it.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('reaches the handler for a missing capability and refuses with 403 (not 401)', async () => {
    mountSession();
    const res = await postTurnIdle(LIVE_CLAIM, 'none');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'origin_unproven' });
  });

  it('reaches the handler for a rotated/stale capability and refuses with 403', async () => {
    mountSession();
    const res = await postTurnIdle({ ...LIVE_CLAIM, originCapability: 'deadbeef'.repeat(8) }, 'none');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'origin_unproven' });
  });

  it('refuses a live capability that names a different turn (origin binding)', async () => {
    mountSession();
    const res = await postTurnIdle({ ...LIVE_CLAIM, originTurnId: 'turn-idle-someone-else' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'origin_identity_mismatch' });
  });

  it('refuses a live capability replayed under another dispatch generation', async () => {
    mountSession();
    const res = await postTurnIdle({ ...LIVE_CLAIM, originDispatchAttempt: ATTEMPT + 1 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'origin_identity_mismatch' });
  });

  it('refuses a session the daemon does not know', async () => {
    const res = await postTurnIdle({ ...LIVE_CLAIM, sessionId: 'sess-not-known' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'origin_unproven' });
  });

  it('keeps every unrelated unsigned route at 401', async () => {
    mountSession();
    // A real registered route that is deliberately NOT in the narrow aperture.
    const res = await fetch(`http://127.0.0.1:${handle!.port}/api/sessions/${SESSION_ID}/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('adds only the exact path to the aperture (no prefix admission)', async () => {
    mountSession();
    const res = await fetch(`http://127.0.0.1:${handle!.port}/api/turn-idle/extra`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(LIVE_CLAIM),
    });
    expect(res.status).toBe(401);
  });

  it('still accepts the trusted-host HMAC path without a capability', async () => {
    mountSession();
    const res = await postTurnIdle(LIVE_CLAIM, 'signed');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
