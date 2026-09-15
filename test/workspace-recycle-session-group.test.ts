import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-recycle-group-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return { dataDir, reply: vi.fn(async () => 'om_reply'), send: vi.fn(async () => 'om_sent'), fork: vi.fn() };
});
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));
vi.mock('../src/im/lark/client.js', async () => ({
  ...await vi.importActual<any>('../src/im/lark/client.js'),
  replyMessage: mocks.reply, sendMessage: mocks.send,
  getChatMode: vi.fn(async () => 'group'), getChatModeStrict: vi.fn(async () => 'group'),
  getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' })),
}));
vi.mock('../src/core/worker-pool.js', async () => ({
  ...await vi.importActual<any>('../src/core/worker-pool.js'), forkWorker: mocks.fork,
}));

import { registerBot } from '../src/bot-registry.js';
import * as store from '../src/services/session-store.js';
import * as pool from '../src/core/worker-pool.js';
import { initSessionGroups, registerSessionGroup, getSessionGroup } from '../src/services/session-groups-store.js';
import { WorkspaceRecycleRuntime } from '../src/core/workspace-recycle-runtime.js';
import { WorkspaceRecycler } from '../src/services/workspace-recycle.js';
import { __testOnly_activeSessions as active, __testOnly_handleNewTopic as handleNewTopic } from '../src/daemon.js';
import { type DaemonSession, activeSessionKey } from '../src/core/types.js';

const APP = 'app-recycle-group';
const CHAT = 'oc-recycle-group';
let controller: WorkspaceRecycleRuntime | undefined;
afterEach(() => {
  controller?.stop(); active.clear(); pool.setActiveSessionsRegistry(new Map());
  store.init(); initSessionGroups(APP);
  rmSync(mocks.dataDir, { recursive: true, force: true });
});

it('finish(succeeded) keeps the real durable row retired through session-group automatic resume, without fresh fallback', async () => {
  const workspace = join(mocks.dataDir, 'workspace'); mkdirSync(workspace, { recursive: true });
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'claude-code', allowedUsers: ['ou_fixture'] });
  bot.resolvedAllowedUsers = ['ou_fixture'];
  store.init(APP); initSessionGroups(APP); pool.setActiveSessionsRegistry(active);
  const session = store.createSession(CHAT, 'om_original', 'recycle group fixture', 'group', 'chat');
  Object.assign(session, { larkAppId: APP, workingDir: workspace, backendType: 'pty' }); store.updateSession(session);
  const ds = { session, larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'chat', workingDir: workspace,
    worker: null, workerPort: null, workerToken: null, lastMessageAt: 1, lastScreenStatus: 'idle' } as DaemonSession;
  active.set(activeSessionKey(ds), ds);
  registerSessionGroup(CHAT, { ownerOpenId: 'ou_fixture', lastSessionId: session.sessionId, createdAt: 1, lastActiveAt: 1 });
  controller = new WorkspaceRecycleRuntime({
    appId: () => APP, dataDir: () => mocks.dataDir, getSession: store.getOwnedSession,
    getRuntime: pool.findActiveBySessionId, allSessions: () => store.loadAllSessionsStrict(mocks.dataDir),
    close: pool.closeSession, retireClosed: (id, workspaceRetirement) => store.closeSession(id, { workspaceRetirement }),
    lifecycleBusy: () => false, closeResidual: () => undefined,
  });
  const recycler = new WorkspaceRecycler({ dataDir: mocks.dataDir, daemons: () => [{ larkAppId: APP, ipcPort: 12345 }],
    call: (_daemon, action, request) => controller!.perform(action, request) });
  expect((await recycler.prepare('retire-group', workspace)).ok).toBe(true);
  rmSync(workspace, { recursive: true });
  expect((await recycler.finish('retire-group', { eventId: 'end-group', outcome: 'succeeded' })).status).toBe('closed');
  // Reload both stores to prove that rejection does not depend on runtime memory.
  store.init(APP); initSessionGroups(APP);
  mocks.reply.mockClear(); mocks.send.mockClear();
  await handleNewTopic({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: 'om_continue', chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text: 'continue' }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId: 'om_continue', chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  expect(store.loadAllSessionsStrict(mocks.dataDir)).toMatchObject([{ sessionId: session.sessionId, status: 'closed',
    workspaceRetirement: { operationId: 'retire-group', workspacePath: workspace } }]);
  expect(active.size).toBe(0);
  expect(mocks.fork).not.toHaveBeenCalled();
  expect(getSessionGroup(CHAT)?.lastSessionId).toBe(session.sessionId);
  expect([...mocks.reply.mock.calls, ...mocks.send.mock.calls].flat().join(' ')).toMatch(/工作区已回收|workspace has been reclaimed/);
});
