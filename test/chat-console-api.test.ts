// test/chat-console-api.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, setLarkAppId, __testOnly_resetCoreOnlyReadiness, armCoreOnlyReadinessGate, setCoreOnlyReady, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import * as sessionStore from '../src/services/session-store.js';
import { appendSessionMessage } from '../src/services/session-message-store.js';
import { config } from '../src/config.js';
import * as workerPool from '../src/core/worker-pool.js';

let handle: IpcServerHandle | null = null;
let dataDir: string;
let prevDataDir: string | undefined;
let prevConfigDataDir: string;
let registry: Map<string, any>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-chat-console-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  prevConfigDataDir = config.session.dataDir;
  process.env.SESSION_DATA_DIR = dataDir;
  config.session.dataDir = dataDir;
  registry = new Map<string, any>();
  workerPool.setActiveSessionsRegistry(registry);
  sessionStore.init();
  armCoreOnlyReadinessGate();
  setCoreOnlyReady();
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setLarkAppId('');
  __testOnly_resetCoreOnlyReadiness();
  workerPool.setActiveSessionsRegistry(new Map());
  sessionStore.init();
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  config.session.dataDir = prevConfigDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('chat console API (session messages)', () => {
  it('GET /api/sessions/:id/messages returns the local archive newest-first', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    appendSessionMessage('chat-sess-1', { role: 'user', content: 'hello', turnId: 't1' });
    appendSessionMessage('chat-sess-1', { role: 'bot', content: 'hi back', turnId: 't2' });
    appendSessionMessage('chat-sess-1', { role: 'user', content: 'again', turnId: 't3' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/chat-sess-1/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.messages.map((m: any) => m.seq)).toEqual([2, 1, 0]);
    expect(body.total).toBe(3);
  });

  it('GET messages supports beforeSeq paging', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    for (let i = 0; i < 5; i++) {
      appendSessionMessage('chat-sess-2', { role: 'user', content: `m${i}`, turnId: `t${i}` });
    }
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/chat-sess-2/messages?limit=2&beforeSeq=4`);
    const body = await res.json();
    expect(body.messages.map((m: any) => m.seq)).toEqual([3, 2]);
  });

  it('GET messages returns empty list for unknown session', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/nope/messages`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.messages).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('POST /api/sessions/:id/messages rejects unknown session', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    setLarkAppId('cli_chat_test');
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/ghost/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('session_not_found');
  });

  it('POST messages rejects empty content', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    setLarkAppId('cli_chat_test');
    const session = sessionStore.createSession('oc_chat_test', 'oc_chat_test', 'chat test', 'group');
    session.larkAppId = 'cli_chat_test';
    session.scope = 'chat';
    session.cliId = 'codex' as any;
    session.workingDir = process.cwd();
    sessionStore.updateSession(session);

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '   ' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('content_required');
  });

  it('SSE bus accepts chat.message events (published by daemon/worker callers)', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const seen: Array<{ type: string; body: any }> = [];
    const off = dashboardEventBus.subscribe(ev => seen.push(ev));
    try {
      // The store itself never publishes — the daemon/worker archive call
      // sites publish after a successful append. Simulate that contract.
      dashboardEventBus.publish({
        type: 'chat.message',
        body: { sessionId: 'chat-sse-1', message: { seq: 0, role: 'bot', content: 'reply', turnId: 'turn-x', createTime: 1 } },
      });
      expect(seen.some(e => e.type === 'chat.message' && e.body.sessionId === 'chat-sse-1' && e.body.message.content === 'reply')).toBe(true);
    } finally {
      off();
    }
  });
});
