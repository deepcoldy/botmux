import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as registry from '../src/bot-registry.js';
import * as pool from '../src/core/worker-pool.js';
import * as client from '../src/im/lark/client.js';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { isChatManager } from '../src/services/chat-manager.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';

const APP = 'cli_manager', CHAT = 'oc_manager', CAP = 'ab12cd34'.repeat(8);
const root = config.session.dataDir;
let handle: IpcServerHandle;
let ds: any, message: any, remote: any, writes: number;
async function post(action: string, overrides: Record<string, unknown> = {}, hostOnly = false) {
  const path = '/api/sessions/s-manager/chat-manager';
  const body = JSON.stringify({ action, ...(hostOnly ? {} : {
    originCapability: CAP, originTurnId: 'om_human', originDispatchAttempt: 1,
  }), ...overrides });
  const headers = new Headers({ 'content-type': 'application/json' });
  return fetch(`http://127.0.0.1:${handle.port}${path}`, { method: 'POST', body,
    headers: hostOnly ? daemonIpcAuthHeaders({ secret: 'test-secret', port: handle.port, method: 'POST', path, headers }) : headers });
}
beforeEach(async () => {
  config.session.dataDir = mkdtempSync(join(root, 'manager-ipc-'));
  remote = { name: 'Group', description: '', chat_mode: 'group' }; writes = 0;
  const bot = registry.registerBot({ larkAppId: APP, larkAppSecret: 'test', cliId: 'codex',
    displayName: 'Manager', allowedUsers: ['ou_owner'] });
  bot.resolvedAllowedUsers = ['ou_owner']; bot.botOpenId = 'ou_bot';
  ds = { session: { sessionId: 's-manager', ownerOpenId: 'ou_owner' },
    larkAppId: APP, chatId: CHAT, chatType: 'group',
    managedTurnOrigin: { capability: CAP, turnId: 'om_human', dispatchAttempt: 1 } };
  message = { message_id: 'om_human', chat_id: CHAT, msg_type: 'text',
    sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_owner' },
    body: { content: JSON.stringify({ text: '执行 botmux manager set' }) }, mentions: [] };
  vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(() => ds);
  vi.spyOn(client, 'getMessageDetail').mockImplementation(async () => ({ items: [message] }) as any);
  vi.spyOn(client, 'larkGet').mockImplementation(async () => ({ code: 0, data: remote }));
  vi.spyOn(registry, 'getBotClient').mockReturnValue({ im: { v1: { chat: {
    update: async ({ data }: any) => { writes++; Object.assign(remote, data); return { code: 0 }; },
  } } } } as any);
  setIpcAuthSecret('test-secret');
  handle = await startIpcServer({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await handle?.close(); setIpcAuthSecret(null); vi.restoreAllMocks(); config.session.dataDir = root;
});
describe('manager session IPC', () => {
  it('sets, reads status and clears with current human proof', async () => {
    expect((await post('set')).status).toBe(200);
    expect(await isChatManager(APP, CHAT)).toBe(true);
    expect((await (await post('status')).json()).locallyEnabled).toBe(true);
    message.body.content = JSON.stringify({ text: '执行 botmux manager clear' });
    expect((await post('clear')).status).toBe(200);
    expect(remote.name).toBe('Group'); expect(writes).toBe(2);
  });
  it('rejects host signature alone and stale current-turn proof', async () => {
    expect((await post('set', {}, true)).status).toBe(403);
    ds.managedTurnOrigin.capability = 'cd'.repeat(32);
    expect((await post('set')).status).toBe(403); expect(writes).toBe(0);
  });
  it('does not borrow session owner authority for bots or guests', async () => {
    message.sender.sender_type = 'app'; expect((await post('set')).status).toBe(403);
    message.sender.sender_type = 'user'; message.sender.id = 'ou_guest';
    expect((await post('set')).status).toBe(403); expect(writes).toBe(0);
  });
  it('requires explicit administrator membership on an open bot', async () => {
    registry.getBot(APP).resolvedAllowedUsers = [];
    expect((await post('set')).status).toBe(403); expect(writes).toBe(0);
  });
  it('binds mutations to the daemon session rather than caller-selected chat/app fields', async () => {
    expect((await post('set', { chatId: 'oc_other', larkAppId: 'cli_other' })).status).toBe(200);
    expect(await isChatManager(APP, CHAT)).toBe(true);
    expect(await isChatManager(APP, 'oc_other')).toBe(false);
  });
  it('rejects rotation during chat read before local or remote writes', async () => {
    vi.mocked(client.larkGet).mockImplementationOnce(async () => {
      ds.managedTurnOrigin.turnId = 'om_next'; return { code: 0, data: remote };
    });
    expect((await post('set')).status).toBe(409); expect(writes).toBe(0);
  });
  it('rejects DMs, topic groups and invalid actions', async () => {
    ds.chatType = 'p2p'; expect((await post('set')).status).toBe(400);
    ds.chatType = 'group'; remote.chat_mode = 'topic';
    expect((await post('set')).status).toBe(409);
    expect((await post('invalid')).status).toBe(400); expect(writes).toBe(0);
  });
  it('rejects cross-chat human proof and unavailable messages', async () => {
    message.chat_id = 'oc_other'; expect((await post('set')).status).toBe(403);
    vi.mocked(client.getMessageDetail).mockRejectedValue(new Error('network'));
    expect((await post('set')).status).toBe(403); expect(writes).toBe(0);
  });
  it('requires an explicit action addressed to this bot', async () => {
    message.body.content = JSON.stringify({ text: '不要你作为本群负责人' });
    expect((await post('set')).status).toBe(403);
    message.body.content = JSON.stringify({ text: '@_user_1 manager set' });
    message.mentions = [{ id: 'ou_other', key: '@_user_1' }];
    expect((await post('set')).status).toBe(403);
    message.mentions[0].id = 'ou_bot';
    expect((await post('clear')).status).toBe(403);
    expect((await post('set')).status).toBe(200);
  });
});
