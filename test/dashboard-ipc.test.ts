// test/dashboard-ipc.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';

let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
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
