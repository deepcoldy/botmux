import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as groupsStore from '../src/services/groups-store.js';
import * as sessionStore from '../src/services/session-store.js';
import * as botRegistry from '../src/bot-registry.js';
import { logger } from '../src/utils/logger.js';

const CAP = 'ab12cd34'.repeat(8);
let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  setLarkAppId('');
  vi.restoreAllMocks();
});

async function postRename(name: string): Promise<Response> {
  if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-chat-rename/chat-rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, proactive: true, originCapability: CAP }),
  });
}

describe('POST /api/sessions/:sessionId/chat-rename', () => {
  it('returns an idempotent success for a proactive same-name retry before applying cooldown', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-chat-rename', chatDisplayName: 'old' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-chat-rename-route-test',
      chatId: 'oc-chat-rename-route-test',
      chatType: 'group',
    } as any);
    vi.spyOn(workerPool, 'getActiveSessionsRegistry').mockReturnValue(new Map());
    vi.spyOn(botRegistry, 'getBotOpenId').mockReturnValue('ou_test_bot');

    let currentName = 'old';
    const beforeUpdateCalls: string[] = [];
    vi.spyOn(groupsStore, 'renameChat').mockImplementation(async (_appId, _chatId, newName, opts) => {
      if (currentName === newName) {
        return { ok: true, oldName: currentName, newName, changed: false };
      }
      beforeUpdateCalls.push(newName);
      const gate = opts?.beforeUpdate?.();
      if (gate && !gate.ok) return { ...gate, oldName: currentName, newName };
      const oldName = currentName;
      currentName = newName;
      return { ok: true, oldName, newName, changed: true };
    });

    const first = await postRename('new');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, changed: true, oldName: 'old', newName: 'new' });

    const sameNameRetry = await postRename('new');
    expect(sameNameRetry.status).toBe(200);
    expect(await sameNameRetry.json()).toMatchObject({ ok: true, changed: false, oldName: 'new', newName: 'new' });

    const differentNameRetry = await postRename('different');
    expect(differentNameRetry.status).toBe(429);
    expect(await differentNameRetry.json()).toMatchObject({
      ok: false,
      error: 'rate_limited',
      oldName: 'new',
      newName: 'different',
    });
    expect(beforeUpdateCalls).toEqual(['new', 'different']);
  });

  it('keeps the rename a success (200) when local cache refresh throws (FR-7)', async () => {
    const activeSession = { sessionId: 's-chat-rename', chatDisplayName: 'old' };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: activeSession,
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-fr7',
      chatId: 'oc-fr7',
      chatType: 'group',
    } as any);
    // One active session in the same chat, so the cache-sync loop runs and hits
    // the throwing store write below.
    vi.spyOn(workerPool, 'getActiveSessionsRegistry').mockReturnValue(
      new Map([['s-chat-rename', { chatId: 'oc-fr7', session: activeSession } as any]]),
    );
    vi.spyOn(botRegistry, 'getBotOpenId').mockReturnValue('ou_test_bot');
    // Lark write succeeds…
    vi.spyOn(groupsStore, 'renameChat').mockResolvedValue({
      ok: true, oldName: 'old', newName: 'new', changed: true,
    });
    // …but persisting the refreshed cache blows up (ENOSPC/EACCES surrogate).
    const updateSpy = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const res = await postRename('new');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true, oldName: 'old', newName: 'new' });
    // The failing write was actually attempted (proving the catch, not a skip).
    expect(updateSpy).toHaveBeenCalledOnce();
    // FR-7 requires a cache-refresh warning be recorded on failure.
    expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('cache_refresh_failed'))).toBe(true);
  });
});

describe('PUT /api/groups/:chatId/name', () => {
  async function put(body: string): Promise<Response> {
    if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    return fetch(`http://127.0.0.1:${handle.port}/api/groups/oc-target/name`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
    });
  }

  it('renames through the daemon bot identity and validates the exact body', async () => {
    setLarkAppId('cli_exact_bot');
    const renameSpy = vi.spyOn(groupsStore, 'renameChat').mockResolvedValue({
      ok: true,
      oldName: 'Old',
      newName: 'New',
      changed: true,
    });

    const response = await put(JSON.stringify({ name: 'New' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      oldName: 'Old',
      newName: 'New',
      changed: true,
      chatId: 'oc-target',
    });
    expect(renameSpy).toHaveBeenCalledWith('cli_exact_bot', 'oc-target', 'New', {
      beforeUpdate: undefined,
    });

    const invalid = await put(JSON.stringify({ name: 'New', unexpected: true }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ ok: false, error: 'invalid_request' });
    expect(renameSpy).toHaveBeenCalledOnce();
  });

  it('maps membership denial and never falls back to another bot', async () => {
    setLarkAppId('cli_exact_bot');
    const renameSpy = vi.spyOn(groupsStore, 'renameChat').mockResolvedValue({
      ok: false,
      error: 'bot_not_in_chat',
    });

    const response = await put(JSON.stringify({ name: 'New' }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'bot_not_in_chat',
    });
    expect(renameSpy).toHaveBeenCalledOnce();
  });

  it('requires trusted-host authentication in the production IPC mode', async () => {
    const secret = 'test-chat-rename-host-secret';
    setIpcAuthSecret(secret);
    setLarkAppId('cli_exact_bot');
    const renameSpy = vi.spyOn(groupsStore, 'renameChat').mockResolvedValue({
      ok: true,
      oldName: 'Old',
      newName: 'New',
      changed: true,
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const path = '/api/groups/oc-target/name';
    const body = JSON.stringify({ name: 'New' });

    const denied = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(denied.status).toBe(401);
    expect(renameSpy).not.toHaveBeenCalled();

    const allowed = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'PUT',
      headers: daemonIpcAuthHeaders({
        secret,
        port: handle.port,
        method: 'PUT',
        path,
        headers: { 'content-type': 'application/json' },
      }),
      body,
    });
    expect(allowed.status).toBe(200);
    expect(renameSpy).toHaveBeenCalledOnce();
  });
});
