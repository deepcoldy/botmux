import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setLarkAppId,
  setIpcAuthSecret,
  setExactChatGrantHandler,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';

// Avoid Feishu contact resolution / disk writes: these routes are thin adapters
// over the service results; service-level coverage lives elsewhere.
vi.mock('@larksuiteoapi/node-sdk', () => {
  // registerBot builds a Lark SDK client for any non-apiOnly bot; the test
  // configs carry an empty placeholder secret, which makes the SDK constructor
  // throw 7104 on a clean install. These routes never call Feishu, so stub the
  // Client entirely (same isolation as blocked-users-talk.test.ts).
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/services/bot-config-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/bot-config-store.js')>(),
  setBotBlockedUsers: vi.fn(),
  removeBlockedUsers: vi.fn(),
}));

vi.mock('../src/services/grant-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/grant-store.js')>(),
  addAllowedChatGroup: vi.fn(),
  removeAllowedChatGroup: vi.fn(),
}));

import { setBotBlockedUsers, removeBlockedUsers } from '../src/services/bot-config-store.js';
import { addAllowedChatGroup, removeAllowedChatGroup } from '../src/services/grant-store.js';

const APP_ID = 'cli_blocked_route';
let handle: IpcServerHandle | null = null;

async function start(): Promise<number> {
  setLarkAppId(APP_ID);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return handle.port;
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setLarkAppId('');
  setIpcAuthSecret(null);
  setExactChatGrantHandler(null);
  __testOnly_resetBotRegistry();
  vi.clearAllMocks();
});

describe('GET /api/blocked-users', () => {
  it('returns raw config entries plus resolved open_ids', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '', blockedUsers: ['ou_seed', 'owner@example.com'] } as any);
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/blocked-users`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(body.raw).toEqual(['ou_seed', 'owner@example.com']);
    expect(Array.isArray(body.resolved)).toBe(true);
  });

  it('503 larkAppId_not_set before daemon identity is ready', async () => {
    setLarkAppId('');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/blocked-users`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: 'larkAppId_not_set' });
  });

  it('404 bot_not_registered when the registry has no such bot', async () => {
    setLarkAppId('cli_missing');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/blocked-users`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'bot_not_registered' });
  });
});

describe('PUT /api/blocked-users', () => {
  it('passes the string entries through and returns the service payload', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    vi.mocked(setBotBlockedUsers).mockResolvedValue({
      ok: true,
      raw: ['ou_a'],
      resolved: ['ou_a'],
    });
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: ['ou_a'] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, raw: ['ou_a'], resolved: ['ou_a'] });
    expect(setBotBlockedUsers).toHaveBeenCalledWith(APP_ID, ['ou_a']);
  });

  it('accepts an empty array (clear semantics)', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    vi.mocked(setBotBlockedUsers).mockResolvedValue({ ok: true, raw: [], resolved: [] });
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [] }),
    });
    expect(res.status).toBe(200);
    expect(setBotBlockedUsers).toHaveBeenCalledWith(APP_ID, []);
  });

  it('400 invalid_entries for non-array or non-string elements', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    const port = await start();

    const nonArray = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: 'ou_a' }),
    });
    expect(nonArray.status).toBe(400);
    expect(await nonArray.json()).toMatchObject({ ok: false, error: 'invalid_entries' });

    const badElement = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: ['ou_a', 42] }),
    });
    expect(badElement.status).toBe(400);
    expect(await badElement.json()).toMatchObject({ ok: false, error: 'invalid_entries' });

    const badJson = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ ok: false, error: 'bad_json' });
    expect(setBotBlockedUsers).not.toHaveBeenCalled();
  });

  it('409 cannot_block_admin and surfaces the conflicting list', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    vi.mocked(setBotBlockedUsers).mockResolvedValue({
      ok: false,
      reason: 'cannot_block_admin',
      conflicting: ['ou_owner'],
    });
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: ['ou_owner'] }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'cannot_block_admin',
      conflicting: ['ou_owner'],
    });
  });

  it('422 empty_resolved', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    vi.mocked(setBotBlockedUsers).mockResolvedValue({ ok: false, reason: 'empty_resolved' });
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: ['nobody@example.com'] }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, error: 'empty_resolved' });
  });

  it('404 bot_not_registered and 400 for any other service reason', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    vi.mocked(setBotBlockedUsers)
      .mockResolvedValueOnce({ ok: false, reason: 'bot_not_registered' })
      .mockResolvedValueOnce({ ok: false, reason: 'disk_write_failed' });
    const port = await start();

    const notRegistered = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: ['ou_a'] }),
    });
    expect(notRegistered.status).toBe(404);
    expect(await notRegistered.json()).toMatchObject({ error: 'bot_not_registered' });

    const other = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: ['ou_a'] }),
    });
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: 'disk_write_failed' });
  });

  it('routes {removeOpenIds} to removeBlockedUsers, which also lifts alias entries', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    vi.mocked(removeBlockedUsers).mockResolvedValue({
      ok: true,
      raw: ['on_keep'],
      resolved: ['ou_keep'],
    });
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removeOpenIds: ['ou_a'] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, raw: ['on_keep'], resolved: ['ou_keep'] });
    expect(removeBlockedUsers).toHaveBeenCalledWith(APP_ID, ['ou_a']);
    expect(setBotBlockedUsers).not.toHaveBeenCalled();
  });

  it('400 when entries and removeOpenIds are both present, or removeOpenIds is invalid', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    const port = await start();

    const both = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [], removeOpenIds: [] }),
    });
    expect(both.status).toBe(400);
    expect(await both.json()).toMatchObject({ error: 'entries_and_removeOpenIds_conflict' });

    const invalid = await fetch(`http://127.0.0.1:${port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removeOpenIds: 'ou_a' }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_remove_open_ids' });
    expect(removeBlockedUsers).not.toHaveBeenCalled();
  });

  it('503 larkAppId_not_set', async () => {
    setLarkAppId('');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/blocked-users`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [] }),
    });
    expect(res.status).toBe(503);
    expect(setBotBlockedUsers).not.toHaveBeenCalled();
  });
});

describe('PUT /api/chat-group-grant', () => {
  it('grants via addAllowedChatGroup and reports created', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    vi.mocked(addAllowedChatGroup).mockResolvedValue({ ok: true, created: true });
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/chat-group-grant`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_group', granted: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: true });
    expect(addAllowedChatGroup).toHaveBeenCalledWith(APP_ID, 'oc_group');
    expect(removeAllowedChatGroup).not.toHaveBeenCalled();
  });

  it('accepts om_ chat ids and revokes via removeAllowedChatGroup', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    vi.mocked(removeAllowedChatGroup).mockResolvedValue({ ok: true, removed: true });
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/chat-group-grant`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'om_group', granted: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(removeAllowedChatGroup).toHaveBeenCalledWith(APP_ID, 'om_group');
  });

  it('400 invalid_chat_id for malformed chat ids', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/chat-group-grant`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'not-a-chat', granted: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_chat_id' });
    expect(addAllowedChatGroup).not.toHaveBeenCalled();
  });

  it('400 invalid_granted when granted is not boolean', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/chat-group-grant`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_group', granted: 'yes' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_granted' });
  });

  it('maps a service failure to 400 with its reason', async () => {
    registerBot({ larkAppId: APP_ID, larkAppSecret: '' } as any);
    vi.mocked(addAllowedChatGroup).mockResolvedValue({ ok: false, reason: 'bot_not_registered' });
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/api/chat-group-grant`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_group', granted: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'bot_not_registered' });
  });

  it('503 larkAppId_not_set', async () => {
    setLarkAppId('');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/chat-group-grant`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_group', granted: true }),
    });
    expect(res.status).toBe(503);
    expect(addAllowedChatGroup).not.toHaveBeenCalled();
  });
});
