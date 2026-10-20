import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as configStore from '../src/services/config-store.js';
import * as botRegistry from '../src/bot-registry.js';
import * as groupsStore from '../src/services/groups-store.js';
import * as larkClient from '../src/im/lark/client.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';

let handle: IpcServerHandle | undefined;
let entry: any;
let botConfig: any;
let chatMode: 'group' | 'topic' | 'p2p' | 'unknown';
beforeEach(() => {
  entry = { larkAppId: 'app-a', regularGroupReplyMode: 'chat' };
  botConfig = { larkAppId: 'app-a', cliId: 'codex', regularGroupReplyMode: 'chat' };
  chatMode = 'group';
  setLarkAppId('app-a');
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: botConfig } as any);
  vi.spyOn(groupsStore, 'listChats').mockResolvedValue([{ chatId: 'oc_a', name: '测试群' }] as any);
  vi.spyOn(larkClient, 'getChatModeStrict').mockImplementation(async () => chatMode);
  vi.spyOn(configStore, 'rmwBotEntry').mockImplementation(async (_appId, mutate: any) => {
    const out = mutate(entry, [entry]);
    return { ok: true, result: out.result };
  });
});
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});
async function request(path: string, body?: unknown) {
  handle ??= await startIpcServer({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, body === undefined ? undefined : {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

it('GET /api/groups projects the per-bot reply policy with its source', async () => {
  expect((await request('/api/groups')).body.chats[0].replyMode)
    .toEqual({ override: null, default: 'chat', effective: 'chat', inherited: true });
  botConfig.chatReplyModes = { oc_a: 'new-topic' };
  expect((await request('/api/groups')).body.chats[0].replyMode)
    .toEqual({ override: 'new-topic', default: 'chat', effective: 'new-topic', inherited: false });
});

it('sets an explicit override (even equal to the default), then clears it back to inherit', async () => {
  const events: unknown[] = [];
  const off = dashboardEventBus.subscribe(ev => events.push(ev));
  try {
    const set = await request('/api/group-reply-mode/oc_a', { mode: 'chat' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ ok: true, chatId: 'oc_a', override: 'chat', inherited: false });
    expect(entry.chatReplyModes).toEqual({ oc_a: 'chat' });

    // `topic` is the user-facing alias for shared
    expect((await request('/api/group-reply-mode/oc_a', { mode: 'topic' })).body).toMatchObject({ override: 'shared' });

    const cleared = await request('/api/group-reply-mode/oc_a', { mode: 'inherit' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ ok: true, cleared: true, override: null, effective: 'chat', inherited: true });
    expect(entry.chatReplyModes).toBeUndefined();
    expect(events.filter((e: any) => e.type === 'groups.reply-policy.changed')).toHaveLength(3);
  } finally { off(); }
});

it('setting fails closed on topic / unknown topology, but clearing a dormant override still works', async () => {
  entry.chatReplyModes = { oc_a: 'new-topic' };
  botConfig.chatReplyModes = { oc_a: 'new-topic' };
  chatMode = 'topic';
  expect(await request('/api/group-reply-mode/oc_a', { mode: 'chat' }))
    .toEqual({ status: 409, body: { ok: false, error: 'regular_group_required' } });
  chatMode = 'unknown';
  expect(await request('/api/group-reply-mode/oc_a', { mode: 'chat' }))
    .toEqual({ status: 503, body: { ok: false, error: 'chat_mode_unconfirmed' } });
  expect(entry.chatReplyModes).toEqual({ oc_a: 'new-topic' });

  const cleared = await request('/api/group-reply-mode/oc_a', { mode: 'inherit' });
  expect(cleared.body).toMatchObject({ ok: true, cleared: true, inherited: true });
  expect(entry.chatReplyModes).toBeUndefined();
});

it('rejects malformed input without writes', async () => {
  expect((await request('/api/group-reply-mode/oc_a', { mode: 'bogus' })).status).toBe(400);
  expect((await request('/api/group-reply-mode/oc_a', {})).status).toBe(400);
  expect((await request('/api/group-reply-mode/not-a-chat', { mode: 'chat' })).status).toBe(400);
  expect(configStore.rmwBotEntry).not.toHaveBeenCalled();
});

it('GET /api/group-chat-mode reports the single-chat topology (incl. unknown) and validates chatId', async () => {
  chatMode = 'topic';
  expect(await request('/api/group-chat-mode/oc_a')).toEqual({ status: 200, body: { ok: true, chatId: 'oc_a', chatMode: 'topic' } });
  chatMode = 'unknown';
  expect((await request('/api/group-chat-mode/oc_a')).body.chatMode).toBe('unknown');
  expect((await request('/api/group-chat-mode/bad')).status).toBe(400);
  expect(larkClient.getChatModeStrict).toHaveBeenCalledTimes(2);
});
