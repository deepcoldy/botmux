// test/dashboard-ipc.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { startIpcServer, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import * as groupsStore from '../src/services/groups-store.js';
import * as oncallStore from '../src/services/oncall-store.js';

let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  // Reset module-level larkAppId between tests so groups endpoints don't
  // leak state across describes.
  setLarkAppId('');
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
    expect(body.chats).toEqual([{ chatId: 'oc_1', name: 'team', oncallChat: null, firstSeenAt: null }]);
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
