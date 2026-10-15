import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as configStore from '../src/services/config-store.js';
import * as botRegistry from '../src/bot-registry.js';
import * as groupsStore from '../src/services/groups-store.js';
import * as eventDispatcher from '../src/im/lark/event-dispatcher.js';
import { setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { handleCardCommand } from '../src/core/command-handler.js';

let handle: IpcServerHandle | undefined;
let entries: Record<string, any>;
let configs: Record<string, any>;
let sessions: Map<string, any>;
beforeEach(() => {
  entries = { 'app-a': { larkAppId: 'app-a' }, 'app-b': { larkAppId: 'app-b' } };
  configs = { 'app-a': { larkAppId: 'app-a', cliId: 'codex' }, 'app-b': { larkAppId: 'app-b', cliId: 'codex' } };
  sessions = new Map([
    ['a1', { larkAppId: 'app-a', chatId: 'oc_a', streamingCardForced: true }],
    ['a2', { larkAppId: 'app-a', chatId: 'oc_a', streamingCardForced: true }],
    ['a-other-chat', { larkAppId: 'app-a', chatId: 'oc_b', streamingCardForced: true }],
    ['b-same-chat', { larkAppId: 'app-b', chatId: 'oc_a', streamingCardForced: true }],
  ]);
  setActiveSessionsRegistry(sessions as any);
  setLarkAppId('app-a');
  vi.spyOn(botRegistry, 'getBot').mockImplementation(((appId: string) => {
    if (!configs[appId]) throw new Error('not registered');
    return { config: configs[appId] };
  }) as any);
  vi.spyOn(groupsStore, 'listChats').mockResolvedValue([{ chatId: 'oc_a', name: '测试群' }] as any);
  vi.spyOn(configStore, 'rmwBotEntry').mockImplementation(async (appId, mutate: any) => {
    const out = mutate(entries[appId], Object.values(entries));
    return { ok: true, result: out.result };
  });
});
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  setIpcAuthSecret(null);
  setActiveSessionsRegistry(new Map() as any);
  vi.restoreAllMocks();
});
async function request(path: string, body?: unknown) {
  handle ??= await startIpcServer({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, body === undefined ? undefined : {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}
const chatState = async () => {
  const chat = (await request('/api/groups')).body.chats[0];
  return {
    master: chat.streamingCardMasterEnabled,
    chat: chat.streamingCardChatEnabled,
    effective: chat.streamingCardEffectiveEnabled,
  };
};

it('persists the silent switch into noCardChats, hot-reloads memory and clears forced cards only for this bot/chat', async () => {
  expect(await chatState()).toEqual({ master: true, chat: true, effective: true });
  expect(await request('/api/group-card-mode/oc_a', { enabled: false })).toEqual({ status: 200, body: { ok: true, enabled: false, changed: true } });
  expect(entries['app-a'].noCardChats).toEqual(['oc_a']);
  expect(configs['app-a'].noCardChats).toEqual(['oc_a']);
  expect(entries['app-b'].noCardChats).toBeUndefined();
  expect(await chatState()).toEqual({ master: true, chat: false, effective: false });
  expect(sessions.get('a1').streamingCardForced).toBeUndefined();
  expect(sessions.get('a2').streamingCardForced).toBeUndefined();
  expect(sessions.get('a-other-chat').streamingCardForced).toBe(true);
  expect(sessions.get('b-same-chat').streamingCardForced).toBe(true);

  // Idempotent re-save still succeeds (changed:false).
  expect((await request('/api/group-card-mode/oc_a', { enabled: false })).body).toEqual({ ok: true, enabled: false, changed: false });
  expect(entries['app-a'].noCardChats).toEqual(['oc_a']);

  // On == inherit: clears the chat override; a bot-level off still wins.
  configs['app-a'].disableStreamingCard = true;
  expect((await request('/api/group-card-mode/oc_a', { enabled: true })).body).toEqual({ ok: true, enabled: true, changed: true });
  expect(entries['app-a'].noCardChats).toEqual([]);
  expect(await chatState()).toEqual({ master: false, chat: true, effective: false });
});

it('rejects malformed input without writes and surfaces storage failure without touching memory', async () => {
  for (const body of [null, {}, [], { enabled: 'false' }, { enabled: 0 }, { enabled: false, chatId: 'oc_a' }, { streamingCard: false }]) {
    expect((await request('/api/group-card-mode/oc_a', body)).status).toBe(400);
  }
  expect((await request('/api/group-card-mode/not_a_chat', { enabled: false })).status).toBe(400);
  expect(configStore.rmwBotEntry).not.toHaveBeenCalled();
  vi.mocked(configStore.rmwBotEntry).mockResolvedValue({ ok: false, reason: 'write_failed' } as any);
  const result = await request('/api/group-card-mode/oc_a', { enabled: false });
  expect(result).toEqual({ status: 500, body: { ok: false, error: 'write_failed' } });
  expect(configs['app-a'].noCardChats).toBeUndefined();
  expect(sessions.get('a1').streamingCardForced).toBe(true);
});

it('shares state with the in-chat /card off|on command in both directions', async () => {
  vi.spyOn(eventDispatcher, 'canOperate').mockReturnValue(true);
  const sessionReply = vi.fn(async () => undefined);
  const deps = { sessionReply, activeSessions: new Map() } as any;

  await handleCardCommand('om_root', 'app-a', 'oc_a', 'ou_owner', '/card off', deps);
  expect(sessionReply).toHaveBeenCalledOnce(); // the chat command confirms in-chat …
  expect(await chatState()).toEqual({ master: true, chat: false, effective: false });
  const afterCommandOff = structuredClone(entries['app-a']);

  // … the Dashboard sees it, and turning it back on equals `/card on`.
  await request('/api/group-card-mode/oc_a', { enabled: true });
  expect(entries['app-a'].noCardChats).toEqual([]);
  await handleCardCommand('om_root', 'app-a', 'oc_a', 'ou_owner', '/card on', deps);
  const afterCommandOn = structuredClone(entries['app-a']);
  expect(afterCommandOn.noCardChats).toEqual([]);

  // Dashboard "off" yields exactly the persisted shape `/card off` produces.
  await request('/api/group-card-mode/oc_a', { enabled: false });
  expect(entries['app-a']).toEqual(afterCommandOff);
  expect(sessionReply).toHaveBeenCalledTimes(2); // only the two chat commands replied; Dashboard writes are silent
});
