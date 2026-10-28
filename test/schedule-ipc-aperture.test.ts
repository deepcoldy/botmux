// `botmux schedule add|update|remove|pause|resume|run` route-level aperture.
//
// The CLI runs inside the agent process. In a sandboxed / read-isolated session
// it cannot read the host HMAC secret, so it posts to
// SCHEDULE_DELEGATED_ADD_ROUTE / SCHEDULE_MANAGED_MUTATE_ROUTE with this
// session's rotating per-turn capability instead. Both handlers authenticate
// that capability themselves (authorizeSessionScopedIpc); if the routes are
// missing from `routeHasNarrowUntrustedAuth` the outer gate answers a bare 401
// `unauthorized` first and scheduling is dead for every sandboxed bot.
//
// These tests run the REAL daemon routes (src/daemon.ts registers them on
// import) behind `startIpcServer({ authRequired: true })` and assert that an
// unsigned request reaches the handler (a handler-specific 403, never the
// outer 401), and that the aperture admits only the exact POST paths.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  routeHasNarrowUntrustedAuth,
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { SCHEDULE_DELEGATED_ADD_ROUTE, SCHEDULE_MANAGED_MUTATE_ROUTE } from '../src/core/dispatch-user-delegation.js';
import { __testOnly_activeSessions } from '../src/daemon.js';

const CAP = 'a1b2c3d4'.repeat(8);
const SESSION_ID = 'sess-schedule-aperture';
const TURN_ID = 'om_schedule_live';

let handle: IpcServerHandle | null = null;

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle!.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  setIpcAuthSecret('test-ipc-schedule-aperture-host-secret');
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  __testOnly_activeSessions.clear();
  setIpcAuthSecret(null);
});

describe('schedule IPC routes under authRequired without the host secret', () => {
  it('admits exactly the two schedule POST routes through the narrow aperture', () => {
    expect(routeHasNarrowUntrustedAuth('POST', SCHEDULE_DELEGATED_ADD_ROUTE)).toBe(true);
    expect(routeHasNarrowUntrustedAuth('POST', SCHEDULE_MANAGED_MUTATE_ROUTE)).toBe(true);
    expect(routeHasNarrowUntrustedAuth('GET', SCHEDULE_DELEGATED_ADD_ROUTE)).toBe(false);
    expect(routeHasNarrowUntrustedAuth('GET', SCHEDULE_MANAGED_MUTATE_ROUTE)).toBe(false);
    expect(routeHasNarrowUntrustedAuth('POST', `${SCHEDULE_DELEGATED_ADD_ROUTE}/x`)).toBe(false);
    expect(routeHasNarrowUntrustedAuth('POST', `${SCHEDULE_MANAGED_MUTATE_ROUTE}/x`)).toBe(false);
    // The host-admin schedule API stays behind the host HMAC.
    expect(routeHasNarrowUntrustedAuth('POST', '/api/schedules')).toBe(false);
    expect(routeHasNarrowUntrustedAuth('PATCH', '/api/schedules/a1b2c3d4')).toBe(false);
  });

  it('delegated add: an unsigned request reaches the handler, which refuses an unproven origin', async () => {
    __testOnly_activeSessions.set(SESSION_ID, {
      session: { sessionId: SESSION_ID },
      larkAppId: 'cli_other',
      managedTurnOrigin: { capability: CAP, turnId: TURN_ID },
    } as never);
    for (const body of [
      { sessionId: SESSION_ID, task: {} },
      { sessionId: SESSION_ID, originCapability: 'deadbeef'.repeat(8), originTurnId: TURN_ID, task: {} },
      { sessionId: '', task: {} },
    ]) {
      const res = await post(SCHEDULE_DELEGATED_ADD_ROUTE, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'schedule_delegation_origin_unproven' });
    }
  });

  it('managed mutate: an unsigned request reaches the handler, which refuses an unproven origin', async () => {
    const res = await post(SCHEDULE_MANAGED_MUTATE_ROUTE, {
      sessionId: SESSION_ID, action: 'pause', id: 'a1b2c3d4',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'schedule_mutation_origin_unproven' });
  });

  it('the host-admin schedule API still answers 401 to an unsigned request', async () => {
    const res = await post('/api/schedules', {});
    expect(res.status).toBe(401);
  });
});
