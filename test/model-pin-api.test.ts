import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import * as store from '../src/services/session-store.js';
import * as registry from '../src/bot-registry.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { setLarkAppId, setIpcAuthSecret, startIpcServer, routeHasNarrowUntrustedAuth, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
const secret = 'topic-model-pin-api-test';
const app = 'pin-api-app';
let dir: string, previous: string, server: IpcServerHandle;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pin-api-')); previous = config.session.dataDir; config.session.dataDir = dir;
  store.init(app); setLarkAppId(app); setIpcAuthSecret(secret);
  vi.spyOn(registry, 'getBot').mockReturnValue({ config: { cliId: 'codex', model: 'default' } } as any);
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});
afterEach(async () => {
  (await import('../src/core/worker-pool.js')).__testOnly_resetRestartCoordinator();
  await server.close(); setIpcAuthSecret(null); setLarkAppId(''); vi.restoreAllMocks();
  config.session.dataDir = previous; store.init(app); rmSync(dir, { recursive: true, force: true });
});
function row(appId = app) {
  const s = store.createSession('chat', crypto.randomUUID(), 'test'); s.larkAppId = appId; s.cliId = 'codex';
  s.modelPin = { model: 'pinned', source: 'command', setBy: 'owner', setAt: new Date().toISOString() };
  store.updateSession(s, { modelPinWrite: true }); return s;
}
function req(path: string, method = 'DELETE', authed = true) {
  const headers = authed ? daemonIpcAuthHeaders({ secret, port: server.port, method, path }) : {};
  return fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers });
}
it('requires host-management HMAC; session capability routes cannot clear model intent', async () => {
  const s = row(); const path = `/api/sessions/${s.sessionId}/model-pin`;
  expect(routeHasNarrowUntrustedAuth('DELETE', path)).toBe(false);
  expect((await req(path, 'DELETE', false)).status).toBe(401);
  expect(store.getOwnedSession(s.sessionId)?.modelPin).toBeTruthy();
});
it('serves protected counts, clears one session and batches the correct bot through real HTTP + SQLite', async () => {
  const a = row(), b = row(), other = row('other-app');
  const stats = await req(`/api/bots/${app}/model-pins`, 'GET'); expect(stats.status).toBe(200);
  expect(await stats.json()).toMatchObject({ total: 2, protected: 2 });
  const one = await req(`/api/sessions/${a.sessionId}/model-pin`); expect(one.status).toBe(200);
  expect((await one.json()).cleared).toEqual([a.sessionId]);
  const batch = await req(`/api/bots/${app}/model-pins`); expect(batch.status).toBe(200);
  expect((await batch.json()).cleared).toEqual([b.sessionId]);
  expect(store.getOwnedSession(other.sessionId)?.modelPin).toBeTruthy();
  expect((await req(`/api/bots/other-app/model-pins`)).status).toBe(404);
  expect((await req(`/api/sessions/${other.sessionId}/model-pin`)).status).toBe(404);
});

it('single and batch clear APIs are no-ops for unpinned rows, including during a restart', async () => {
  const pool = await import('../src/core/worker-pool.js'); const { dashboardEventBus } = await import('../src/core/dashboard-events.js');
  const a = row(); delete a.modelPin; store.updateSession(a, { modelPinWrite: true });
  const ds: any = { session: a, larkAppId: app, worker: { killed: false, send: vi.fn() }, hasHistory: true };
  vi.spyOn(pool, 'findActiveBySessionId').mockReturnValue(ds);
  pool.requestSessionRestart(ds, { source: 'slash', notify: async () => {} });
  const sendsBefore = ds.worker.send.mock.calls.length;
  const mutator = vi.spyOn(store, 'mutateOwnedSessionsAtomically'); const writer = vi.spyOn(store, 'updateSession');
  const publish = vi.spyOn(dashboardEventBus, 'publish');
  for (const path of [`/api/sessions/${a.sessionId}/model-pin`, `/api/bots/${app}/model-pins`]) {
    const res = await req(path); expect(res.status).toBe(200); expect((await res.json()).cleared).toEqual([]);
  }
  expect(mutator).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  expect(ds.worker.send).toHaveBeenCalledTimes(sendsBefore); expect(ds.modelPinCleared).toBeUndefined();
  expect(pool.latestPinEffortForRespawn(ds)).toEqual({}); pool.__testOnly_resetRestartCoordinator();
});
it('busy responses locate every blocking session and leave the entire batch unchanged', async () => {
  const pool = await import('../src/core/worker-pool.js'); const a = row(), b = row(), c = row();
  const active = new Map([a,b,c].map(s => [s.sessionId, { session: s, larkAppId: app, hasHistory: true, worker: { killed: false, send: vi.fn() } } as any]));
  vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(id => active.get(id));
  pool.requestSessionRestart(active.get(a.sessionId), { source: 'dashboard', notify: async () => {} });
  pool.requestSessionRestart(active.get(b.sessionId), { source: 'slash', notify: async () => {} });
  try {
    const res = await req(`/api/bots/${app}/model-pins`); expect(res.status).toBe(409);
    const body = await res.json(); expect(body.error).toBe('session_busy');
    expect(body.busySessionIds.sort()).toEqual([a.sessionId,b.sessionId].sort());
    expect(body.busySessions).toEqual(expect.arrayContaining([{ sessionId: a.sessionId, reason: 'restarting' }, { sessionId: b.sessionId, reason: 'restarting' }]));
    for (const s of [a,b,c]) expect(store.getOwnedSession(s.sessionId)?.modelPin).toBeTruthy();
    const single = await req(`/api/sessions/${a.sessionId}/model-pin`); expect((await single.json()).busySessionIds).toEqual([a.sessionId]);
  } finally { pool.__testOnly_resetRestartCoordinator(); }
  const retry = await req(`/api/bots/${app}/model-pins`); expect(retry.status).toBe(200); expect((await retry.json()).cleared).toHaveLength(3);
});

it('returns a readable missing-session error with HTTP 404', async () => {
  const response = await req('/api/sessions/no-such-session/model-pin');
  expect(response.status).toBe(404); const body = await response.json();
  expect(body).toMatchObject({ ok: false, error: 'session_not_found' });
  const { modelPinClearErrorText } = await import('../src/core/model-pin.js');
  const text = modelPinClearErrorText(body); expect(text).not.toContain('session_not_found'); expect(text.length).toBeGreaterThan(10);
});
