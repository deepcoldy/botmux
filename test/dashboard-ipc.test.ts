// test/dashboard-ipc.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, setLarkAppId, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import * as groupsStore from '../src/services/groups-store.js';
import * as oncallStore from '../src/services/oncall-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { writeTeamRoleFile } from '../src/core/role-resolver.js';

// Loopback-HMAC the write-link routes require. Inject a known secret per test
// (setIpcAuthSecret) and sign with it, so the suite doesn't depend on a real
// ~/.botmux/.dashboard-secret existing on the box.
const TEST_IPC_SECRET = 'test-ipc-secret-deadbeef';
function tokenAuthHeaders(secret = TEST_IPC_SECRET): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const sig = createHmac('sha256', secret).update(`${ts}:${nonce}`).digest('base64url');
  return { 'X-Botmux-Cli-Ts': ts, 'X-Botmux-Cli-Nonce': nonce, 'X-Botmux-Cli-Auth': sig };
}

let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  // Reset module-level larkAppId between tests so groups endpoints don't
  // leak state across describes.
  setLarkAppId('');
  setIpcAuthSecret(null);
});

describe('dashboard IPC server', () => {
  it('binds to 127.0.0.1 and serves /__health', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/__health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 404 for unknown route', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/nope`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/sessions', () => {
  it('returns array shape (sessions: Row[])', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});

describe('GET /api/sessions/:sessionId', () => {
  it('returns 404 for unknown sessionId', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/nonexistent-id`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/sessions/:sessionId/close', () => {
  it('returns 200 with ok=true even when session does not exist (idempotent)', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/nonexistent/close`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe('GET /api/sessions/:sessionId/write-link', () => {
  it('returns 401 without a valid loopback-HMAC signature', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s2/write-link`);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('returns 404 session_not_active for an unknown/closed session', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/ghost/write-link`, { headers: tokenAuthHeaders() });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('session_not_active');
  });

  it('returns 409 terminal_unavailable when the live session has no web terminal yet', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    const spy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's1', webPort: null },
      workerPort: null,
      workerToken: null,
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s1/write-link`, { headers: tokenAuthHeaders() });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('terminal_unavailable');
    spy.mockRestore();
  });

  it('returns 200 with a token-bearing url for a live session', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    const spy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's2', webPort: 4321 },
      workerPort: 4321,
      workerToken: 'secret-tok',
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s2/write-link`, { headers: tokenAuthHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.url).toBe('string');
    expect(body.url).toContain('token=secret-tok');
    spy.mockRestore();
  });
});

describe('POST /api/sessions/:sessionId/write-link-card', () => {
  it('returns 401 without a valid loopback-HMAC signature', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s2/write-link-card`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('returns 404 session_not_active for an unknown/closed session', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/ghost/write-link-card`, {
      method: 'POST', headers: tokenAuthHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('session_not_active');
  });

  it('on success returns delivery counts only — never the token or URL', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's9' }, workerPort: 4321, workerToken: 'secret-tok',
    } as any);
    const deliverSpy = vi.spyOn(workerPool, 'deliverWriteLinkCardToOwners').mockResolvedValue({
      ok: true, delivered: 2, total: 2, channels: ['ephemeral', 'dm'],
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s9/write-link-card`, {
      method: 'POST', headers: tokenAuthHeaders(),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    // The token rides only the private Lark channels — the HTTP response that
    // crosses back to the CLI must carry counts, not the credential.
    expect(raw).not.toContain('secret-tok');
    expect(raw).not.toContain('token=');
    const body = JSON.parse(raw);
    expect(body).toMatchObject({ ok: true, delivered: 2, total: 2, channels: ['ephemeral', 'dm'] });
    expect(body.url).toBeUndefined();
    findSpy.mockRestore();
    deliverSpy.mockRestore();
  });

  it('maps no_owner → 422 and terminal_unavailable → 409', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({ session: { sessionId: 's9' } } as any);
    const deliverSpy = vi.spyOn(workerPool, 'deliverWriteLinkCardToOwners');

    deliverSpy.mockResolvedValueOnce({ ok: false, error: 'no_owner', delivered: 0, total: 0, channels: [] });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const noOwner = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s9/write-link-card`, {
      method: 'POST', headers: tokenAuthHeaders(),
    });
    expect(noOwner.status).toBe(422);
    expect((await noOwner.json()).error).toBe('no_owner');

    deliverSpy.mockResolvedValueOnce({ ok: false, error: 'terminal_unavailable', delivered: 0, total: 0, channels: [] });
    const notReady = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s9/write-link-card`, {
      method: 'POST', headers: tokenAuthHeaders(),
    });
    expect(notReady.status).toBe(409);
    expect((await notReady.json()).error).toBe('terminal_unavailable');

    findSpy.mockRestore();
    deliverSpy.mockRestore();
  });
});

describe('POST /api/sessions/:sessionId/locate rate limit', () => {
  it('returns 429 on second call within window', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    // First call expected 404 because no session exists — but it consumes the limiter slot.
    await fetch(`http://127.0.0.1:${handle.port}/api/sessions/sX-test/locate`, { method: 'POST' });
    const second = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/sX-test/locate`, { method: 'POST' });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
  });
});

describe('GET /api/schedules', () => {
  it('returns schedules array shape', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.schedules)).toBe(true);
  });
});

describe('POST /api/schedules/:id/(run|pause|resume)', () => {
  it('returns ok=false for unknown id (run)', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules/nonexistent/run`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_found');
  });

  it('returns ok=false for unknown id (pause)', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules/nonexistent/pause`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_found');
  });

  it('returns ok=false for unknown id (resume)', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules/nonexistent/resume`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_found');
  });

  // The delivery-toggle route must be registered on the IPC server (the outer
  // dashboard proxy in dashboard.ts forwards /(run|pause|resume|delivery)$ here).
  it('returns ok=false for unknown id (delivery)', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules/nonexistent/delivery`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_found');
  });
});

describe('SSE /api/events', () => {
  it('delivers a published event to a connected client', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    setTimeout(() => dashboardEventBus.publish({ type: 'heartbeat', body: { ts: 42 } }), 50);

    const decoder = new TextDecoder();
    let buf = '';
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      if (buf.includes('"ts":42')) break;
    }
    expect(buf).toContain('event: heartbeat');
    expect(buf).toContain('"ts":42');

    reader.releaseLock();
    await res.body!.cancel();
  }, 5_000);
});

describe('POST /api/locale/reload', () => {
  it('hot-reloads the process default locale from disk and reports it', async () => {
    setLarkAppId('');  // no registered bot → per-bot override path stays null
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/locale/reload`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(['zh', 'en']).toContain(body.defaultLocale);
    expect(body.botLang).toBeNull();
    // The route applied it in-process: getDefaultLocale reflects the same value
    // (same i18n module singleton the daemon's card rendering reads).
    const { getDefaultLocale } = await import('../src/i18n/index.js');
    expect(getDefaultLocale()).toBe(body.defaultLocale);
  });
});

describe('PUT /api/bot-skills', () => {
  it('rejects invalid non-null policy instead of clearing skills', async () => {
    const appId = 'test-skill-policy-app';
    setLarkAppId(appId);
    registerBot({
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'codex',
      workingDir: process.cwd(),
      workingDirs: [process.cwd()],
      skills: { include: ['skill:deploy'] },
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-skills`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set', policy: { include: [123] } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_policy' });
  });
});

describe('GET /api/groups (Phase B)', () => {
  it('returns 503 when larkAppId not set', async () => {
    setLarkAppId('');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('larkAppId_not_set');
  });

  it('lists chats from groups-store when larkAppId set', async () => {
    setLarkAppId('test-app');
    const spy = vi.spyOn(groupsStore, 'listChats').mockResolvedValue([
      { chatId: 'oc_1', name: 'team' },
    ]);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Each chat now carries an `oncallChat` enrichment (null when unbound)
    // so the dashboard matrix can render toggle state without a second
    // round-trip. With no bot registered for 'test-app' the lookup falls
    // back to undefined → null in the response.
    // `firstSeenAt` is the per-bot creation-order proxy added so the
    // dashboard can sort newly-added chats to the top. In this test the
    // store hasn't been init()'d (no daemon), so the value degrades to
    // null instead of failing the request — see chat-first-seen-store.
    expect(body.chats).toEqual([{ chatId: 'oc_1', name: 'team', oncallChat: null, firstSeenAt: null, hasRole: false, observedBotNames: [] }]);
    spy.mockRestore();
  });
});

describe('PUT/DELETE /api/oncall/:chatId', () => {
  it('rejects PUT without workingDir', async () => {
    setLarkAppId('test-app');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('workingDir_required');
  });

  it('rejects PUT with non-existent path', async () => {
    setLarkAppId('test-app');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workingDir: '/nonexistent/path/xyz' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/目录不存在/);
  });

  it('returns 503 when larkAppId not set (DELETE)', async () => {
    setLarkAppId('');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, { method: 'DELETE' });
    expect(res.status).toBe(503);
  });

  it('PUT happy path forwards to bindOncall and echoes resolvedPath', async () => {
    setLarkAppId('test-app');
    const spy = vi.spyOn(oncallStore, 'bindOncall').mockResolvedValue({
      ok: true,
      entry: { chatId: 'oc_1', workingDir: '/tmp' },
      created: true,
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    expect(body.entry).toEqual({ chatId: 'oc_1', workingDir: '/tmp' });
    expect(body.resolvedPath).toBe('/tmp');
    expect(spy).toHaveBeenCalledWith('test-app', 'oc_1', '/tmp');
    spy.mockRestore();
  });

  it('DELETE happy path forwards to unbindOncall', async () => {
    setLarkAppId('test-app');
    const spy = vi.spyOn(oncallStore, 'unbindOncall').mockResolvedValue({ ok: true, wasBound: true });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.wasBound).toBe(true);
    expect(spy).toHaveBeenCalledWith('test-app', 'oc_1');
    spy.mockRestore();
  });

  it('DELETE is idempotent — succeeds even when chat was not bound, and surfaces wasBound=false', async () => {
    // Updated semantics: unbind on a not-bound chat is no longer an error,
    // because unbindOncall always writes a tombstone into
    // defaultOncallAutoboundChats so the auto-bind judge won't reinstate
    // the chat. The route reflects that with 200 + wasBound:false.
    setLarkAppId('test-app');
    const spy = vi.spyOn(oncallStore, 'unbindOncall').mockResolvedValue({
      ok: true,
      wasBound: false,
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.wasBound).toBe(false);
    spy.mockRestore();
  });
});

describe('POST /api/groups/:chatId/add-bots (Phase B)', () => {
  it('rejects bad body', async () => {
    setLarkAppId('test-app');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_1/add-bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('forwards to groups-store and returns per-id result', async () => {
    setLarkAppId('test-app');
    const spy = vi.spyOn(groupsStore, 'addBotToChat').mockResolvedValue([
      { id: 'cli_X', ok: true },
      { id: 'cli_Y', ok: false, error: 'invalid_id' },
    ]);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_1/add-bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ larkAppIds: ['cli_X', 'cli_Y'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toEqual([
      { id: 'cli_X', ok: true },
      { id: 'cli_Y', ok: false, error: 'invalid_id' },
    ]);
    spy.mockRestore();
  });
});

describe('POST /api/groups/create', () => {
  it('forwards bindWorkingDir after validating it is an existing directory', async () => {
    setLarkAppId('test-app');
    const spy = vi.spyOn(oncallStore, 'bindOncall').mockResolvedValue({
      ok: true,
      entry: { chatId: 'oc_new', workingDir: process.cwd() },
      created: true,
    });
    const createSpy = vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
      chatId: 'oc_new',
      invalidBotIds: [],
      invalidUserIds: [],
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ larkAppIds: ['test-app', 'cli_X'], bindWorkingDir: process.cwd() }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.bindResolvedPath).toBe(process.cwd());
    expect(body.oncallBindings).toEqual([
      { larkAppId: 'test-app', ok: true, created: true },
      { larkAppId: 'cli_X', ok: true, created: true },
    ]);
    expect(spy).toHaveBeenCalledWith('test-app', 'oc_new', process.cwd());
    expect(spy).toHaveBeenCalledWith('cli_X', 'oc_new', process.cwd());
    spy.mockRestore();
    createSpy.mockRestore();
  });

  it('rejects missing bindWorkingDir before creating the group', async () => {
    setLarkAppId('test-app');
    const createSpy = vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
      chatId: 'oc_should_not_create',
      invalidBotIds: [],
      invalidUserIds: [],
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ larkAppIds: ['test-app'], bindWorkingDir: '/definitely/not/a/real/botmux/path' }),
    });
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });
});

describe('role profile IPC routes', () => {
  it('returns effective team role metadata for dashboard save-as-profile flows', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-role-effective-'));
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    try {
      process.env.SESSION_DATA_DIR = dataDir;
      config.session.dataDir = dataDir;
      setLarkAppId('cli_profile');
      writeTeamRoleFile('cli_profile', '# Default reviewer\nUse concise bullets.');
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const role = await fetch(`${base}/api/roles/oc_effective`);
      expect(role.status).toBe(200);
      expect(await role.json()).toMatchObject({
        chatId: 'oc_effective',
        content: null,
        hasRole: false,
        effectiveContent: '# Default reviewer\nUse concise bullets.',
        effectiveSource: 'team',
        hasEffectiveRole: true,
      });
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects wrong-daemon role profile mutations', async () => {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const saveWrong = await fetch(`${base}/api/role-profiles/collab-main/cli_other`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Other daemon' }),
      });
      expect(saveWrong.status).toBe(403);
      expect((await saveWrong.json()).error).toBe('wrong_daemon');

      const deleteWrong = await fetch(`${base}/api/role-profiles/collab-main/cli_other`, { method: 'DELETE' });
      expect(deleteWrong.status).toBe(403);
      expect((await deleteWrong.json()).error).toBe('wrong_daemon');

      const applyWrong = await fetch(`${base}/api/role-profiles/collab-main/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_role', larkAppId: 'cli_other' }),
      });
      expect(applyWrong.status).toBe(403);
      expect((await applyWrong.json()).error).toBe('wrong_daemon');
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid chat ids before role/profile writes', async () => {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const roleWrite = await fetch(`${base}/api/roles/not-a-chat`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Bad chat' }),
      });
      expect(roleWrite.status).toBe(400);
      expect((await roleWrite.json()).error).toBe('invalid_chat_id');

      const apply = await fetch(`${base}/api/role-profiles/collab-main/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: '../escape', larkAppId: 'cli_profile' }),
      });
      expect(apply.status).toBe(400);
      expect((await apply.json()).error).toBe('invalid_chat_id');
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects encoded traversal profile ids before touching storage', async () => {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/role-profiles/%2E%2E/cli_profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'bad' }),
      });
      expect([400, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('stores a profile entry and materializes it into a chat role', async () => {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const save = await fetch(`${base}/api/role-profiles/collab-main/cli_profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Reviewer\nBe strict.' }),
      });
      expect(save.status).toBe(200);
      expect((await save.json()).ok).toBe(true);

      const list = await fetch(`${base}/api/role-profiles`);
      expect(list.status).toBe(200);
      expect((await list.json()).profiles).toMatchObject([
        { profileId: 'collab-main', entryCount: 1, hasCurrentBotEntry: true },
      ]);

      const preview = await fetch(`${base}/api/role-profiles/collab-main/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_role', larkAppId: 'cli_profile', preview: true }),
      });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({
        ok: true,
        preview: true,
        changed: false,
        wouldOverwrite: false,
        wouldRefuse: false,
        content: '# Reviewer\nBe strict.',
      });

      const apply = await fetch(`${base}/api/role-profiles/collab-main/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_role', larkAppId: 'cli_profile' }),
      });
      expect(apply.status).toBe(200);
      expect((await apply.json()).changed).toBe(true);

      const role = await fetch(`${base}/api/roles/oc_role`);
      expect(role.status).toBe(200);
      expect(await role.json()).toMatchObject({
        chatId: 'oc_role',
        content: '# Reviewer\nBe strict.',
        hasRole: true,
      });
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('stores explicit empty profile entries and applies them as no chat role', async () => {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const save = await fetch(`${base}/api/role-profiles/collab-empty/cli_profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '', allowEmpty: true }),
      });
      expect(save.status).toBe(200);
      expect(await save.json()).toMatchObject({ ok: true, byteLength: 0 });

      const entry = await fetch(`${base}/api/role-profiles/collab-empty/cli_profile`);
      expect(await entry.json()).toMatchObject({
        profileId: 'collab-empty',
        larkAppId: 'cli_profile',
        content: '',
        byteLength: 0,
        hasEntry: true,
      });

      const list = await fetch(`${base}/api/role-profiles`);
      expect((await list.json()).profiles).toMatchObject([
        { profileId: 'collab-empty', entryCount: 1, hasCurrentBotEntry: true },
      ]);

      const applyNoExisting = await fetch(`${base}/api/role-profiles/collab-empty/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_empty', larkAppId: 'cli_profile' }),
      });
      expect(applyNoExisting.status).toBe(200);
      expect(await applyNoExisting.json()).toMatchObject({ ok: true, changed: false, deleted: false });

      const roleWrite = await fetch(`${base}/api/roles/oc_empty`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Existing role' }),
      });
      expect(roleWrite.status).toBe(200);

      const applyRefused = await fetch(`${base}/api/role-profiles/collab-empty/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_empty', larkAppId: 'cli_profile' }),
      });
      expect(applyRefused.status).toBe(409);
      expect((await applyRefused.json()).error).toBe('chat_role_exists');

      const applyForce = await fetch(`${base}/api/role-profiles/collab-empty/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_empty', larkAppId: 'cli_profile', force: true }),
      });
      expect(applyForce.status).toBe(200);
      expect(await applyForce.json()).toMatchObject({ ok: true, changed: true, deleted: true });

      const role = await fetch(`${base}/api/roles/oc_empty`);
      expect(await role.json()).toMatchObject({ chatId: 'oc_empty', content: null, hasRole: false });
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
