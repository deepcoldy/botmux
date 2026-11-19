// POST /api/claude-stop-failure route-level authorization under the production gate.
//
// Claude runs its StopFailure hook (`botmux __claude-stop-failure-v1`) inside
// the CLI process, which in a bwrap / read-isolated session cannot read the
// host HMAC secret and presents this session's rotating per-turn capability in
// the body instead. Like /api/turn-idle, the route therefore has to sit in the
// outer narrow aperture `routeHasNarrowUntrustedAuth`, or the server answers
// 401 before the handler runs and the fallback is silently dead for exactly the
// isolated sessions; and since a forwarded report can make the worker emit a
// turn terminal, the handler must refuse receiver sessions and bind the
// claimed turn to the capability's live origin.
//
// These tests run the REAL daemon route (src/daemon.ts registers it on import)
// behind `startIpcServer({ authRequired: true })`:
//   - live capability + matching (turn, dispatch generation) → 200, forwarded
//   - missing / stale capability                          → 403, not forwarded
//   - live capability naming another turn / generation    → 403, not forwarded
//   - unknown session                                     → 403
//   - VC-meeting receiver session                         → 403, not forwarded
//   - exact path only: a longer path is not admitted by the aperture
//   - trusted-host HMAC without a capability              → 200, forwarded
//   - malformed bodies                                    → 400, not forwarded
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { __testOnly_activeSessions } from '../src/daemon.js';

const CAP = 'a1b2c3d4'.repeat(8);
const HOST_SECRET = 'test-ipc-claude-stop-failure-host-secret';
const SESSION_ID = 'sess-claude-stop-failure-ipc';
const TURN_ID = 'om_stop_failure_live';
const ATTEMPT = 3;
const PATH = '/api/claude-stop-failure';

let handle: IpcServerHandle | null = null;
let workerSend: ReturnType<typeof vi.fn>;

/** The daemon resolves the session from its own active map, so register a
 *  minimal one whose worker records what the route forwards. */
function mountSession(overrides: { receiver?: boolean } = {}): void {
  __testOnly_activeSessions.set(SESSION_ID, {
    session: {
      sessionId: SESSION_ID,
      ...(overrides.receiver ? { vcMeetingReceiver: { meetingId: 'vc-meeting' } } : {}),
    },
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

const REPORT = {
  error: 'server_error',
  lastAssistantMessage: 'API Error: Connection lost mid-response. The response above may be incomplete.',
  cliSessionId: '7bb7a763-27bb-449b-9b1f-72159ee31588',
  transcriptPath: '/home/u/.claude/projects/-work/7bb7a763-27bb-449b-9b1f-72159ee31588.jsonl',
  claudePid: 4242,
};
const LIVE_CLAIM = {
  sessionId: SESSION_ID,
  originTurnId: TURN_ID,
  originDispatchAttempt: ATTEMPT,
  ...REPORT,
};

beforeEach(async () => {
  workerSend = vi.fn();
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

describe('POST /api/claude-stop-failure under authRequired', () => {
  it('forwards a report that carries the live capability and names the live turn', async () => {
    mountSession();
    const res = await post(LIVE_CLAIM);
    // 200 (not 401): the outer gate let it through and the handler's own
    // capability + origin binding accepted it.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(workerSend).toHaveBeenCalledTimes(1);
    expect(workerSend).toHaveBeenCalledWith({
      type: 'claude_stop_failure',
      report: REPORT,
      turnId: TURN_ID,
      dispatchAttempt: ATTEMPT,
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

  it('refuses a live capability that names another turn or dispatch generation', async () => {
    mountSession();
    for (const res of [
      await post({ ...LIVE_CLAIM, originTurnId: 'om_someone_else' }),
      await post({ ...LIVE_CLAIM, originDispatchAttempt: ATTEMPT + 1 }),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'origin_identity_mismatch' });
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

  it('refuses a VC-meeting receiver session even with its live capability', async () => {
    mountSession({ receiver: true });
    const res = await post(LIVE_CLAIM);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'managed_action_required' });
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

  it('rejects malformed bodies with 400 and forwards nothing', async () => {
    mountSession();
    const cases: Array<[Record<string, unknown> | string, string]> = [
      ['not json', 'bad_json'],
      [{ ...LIVE_CLAIM, sessionId: undefined }, 'missing_sessionId'],
      [{ ...LIVE_CLAIM, error: undefined }, 'missing_error'],
      [{ ...LIVE_CLAIM, error: '' }, 'missing_error'],
    ];
    for (const [body, error] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error });
    }
    expect(workerSend).not.toHaveBeenCalled();
  });
});
