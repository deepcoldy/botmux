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
import { __testOnly_activeSessions as active, __testOnly_handleNewTopic as handleNewTopic, __testOnly_handleThreadReply as handleThreadReply } from '../src/daemon.js';
import { type DaemonSession, activeSessionKey } from '../src/core/types.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';

const APP = 'app-recycle-group';
const CHAT = 'oc_recycle_group';
let controller: WorkspaceRecycleRuntime | undefined;
afterEach(() => {
  controller?.stop(); active.clear(); pool.setActiveSessionsRegistry(new Map());
  store.init('app-recycle-group'); initSessionGroups(APP);
  rmSync(mocks.dataDir, { recursive: true, force: true });
});

it('finish(succeeded) keeps the retired row closed: a new group message starts fresh, /resume is refused', async () => {
  const workspace = join(mocks.dataDir, 'workspace'); mkdirSync(workspace, { recursive: true });
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'claude-code', allowedUsers: ['ou_fixture'] });
  bot.resolvedAllowedUsers = ['ou_fixture'];
  store.init(APP); initSessionGroups(APP); pool.setActiveSessionsRegistry(active);
  const session = store.createSession(CHAT, 'om_original', 'recycle group fixture', 'group', 'chat');
  Object.assign(session, { larkAppId: APP, workingDir: workspace, backendType: 'pty', cliId: 'claude-code', cliSessionId: 'cli-native-original' }); store.updateSession(session);
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
  const ingress = (messageId: string, text: string) => handleNewTopic({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: messageId, chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId, chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  const retired = () => store.loadAllSessionsStrict(mocks.dataDir).find(s => s.sessionId === session.sessionId);

  // Durable primary: typed /resume must not mutate lifecycle state outside the
  // durable commit path; it only points at the close card's resume button.
  mocks.reply.mockClear(); mocks.send.mockClear();
  process.env.BOTMUX_COORDINATION_MODE = 'primary';
  try {
    await ingress('om_resume_primary', '/resume');
    await vi.waitFor(() => expect([...mocks.reply.mock.calls, ...mocks.send.mock.calls].flat().join(' '))
      .toMatch(/持久协调|durable coordination/));
  } finally {
    delete process.env.BOTMUX_COORDINATION_MODE;
  }
  expect(active.size).toBe(0);
  expect(mocks.fork).not.toHaveBeenCalled();

  // /resume (no session in the chat → claimed by botmux) targets the retired row and is refused.
  mocks.reply.mockClear(); mocks.send.mockClear();
  await ingress('om_resume', '/resume');
  await vi.waitFor(() => expect([...mocks.reply.mock.calls, ...mocks.send.mock.calls].flat().join(' '))
    .toMatch(/工作区已回收|workspace has been reclaimed/));
  expect(retired()).toMatchObject({ status: 'closed', workspaceRetirement: { operationId: 'retire-group', workspacePath: workspace } });
  expect(active.size).toBe(0);
  expect(mocks.fork).not.toHaveBeenCalled();

  // An ordinary message no longer auto-resumes the closed row: it opens a fresh session.
  await ingress('om_continue', 'continue');
  expect(retired()).toMatchObject({ status: 'closed', workspaceRetirement: { operationId: 'retire-group', workspacePath: workspace } });
  const fresh = getSessionGroup(CHAT)?.lastSessionId;
  expect(fresh).toBeTruthy();
  expect(fresh).not.toBe(session.sessionId);
  expect(store.getOwnedSession(fresh!)?.status).toBe('active');
});

it('/resume without an id skips a closed command placeholder stamped with a CLI id (codex pool) and resumes the real conversation', async () => {
  const workspace = join(mocks.dataDir, 'workspace-real'); mkdirSync(workspace, { recursive: true });
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'codex', allowedUsers: ['ou_fixture'] });
  bot.resolvedAllowedUsers = ['ou_fixture'];
  store.init(APP); initSessionGroups(APP); pool.setActiveSessionsRegistry(active);
  const real = store.createSession(CHAT, 'om_real', 'real conversation', 'group', 'chat');
  Object.assign(real, { larkAppId: APP, workingDir: workspace, backendType: 'tmux', cliId: 'codex', cliSessionId: 'codex-thread-real' });
  store.updateSession(real); store.closeSession(real.sessionId);
  // A later /help scratch: a codex instance pool stamps cliId at row creation, but no CLI ever ran.
  const placeholder = store.createSession(CHAT, 'om_help', '/help', 'group', 'chat');
  Object.assign(placeholder, { larkAppId: APP, workingDir: workspace, backendType: 'tmux', cliId: 'codex' });
  store.updateSession(placeholder);
  await new Promise(r => setTimeout(r, 5));
  store.closeSession(placeholder.sessionId);

  mocks.reply.mockClear(); mocks.send.mockClear(); mocks.fork.mockClear();
  await handleNewTopic({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: 'om_resume_real', chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text: '/resume' }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId: 'om_resume_real', chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  await vi.waitFor(() => expect(store.getOwnedSession(real.sessionId)?.status).toBe('active'));
  expect(store.getOwnedSession(placeholder.sessionId)?.status).toBe('closed');
});

it('/resume evicts a live codex-pool command placeholder at the anchor, restores the real session and repoints the group resident', async () => {
  const workspace = join(mocks.dataDir, 'workspace-placeholder'); mkdirSync(workspace, { recursive: true });
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'codex', allowedUsers: ['ou_fixture'] });
  bot.resolvedAllowedUsers = ['ou_fixture'];
  store.init(APP); initSessionGroups(APP); pool.setActiveSessionsRegistry(active);
  const real = store.createSession(CHAT, 'om_real2', 'real conversation', 'group', 'chat');
  Object.assign(real, { larkAppId: APP, workingDir: workspace, backendType: 'tmux', cliId: 'codex', cliSessionId: 'codex-thread-real2' });
  store.updateSession(real); store.closeSession(real.sessionId);
  // Live /help scaffold: worker-less, cliId pre-stamped by the instance pool, no conversation.
  const placeholder = store.createSession(CHAT, 'om_help2', '/help', 'group', 'chat');
  Object.assign(placeholder, { larkAppId: APP, workingDir: workspace, backendType: 'tmux', cliId: 'codex' });
  store.updateSession(placeholder);
  const placeholderDs = { session: placeholder, larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'chat', workingDir: workspace,
    worker: null, workerPort: null, workerToken: null, lastMessageAt: 1, lastScreenStatus: 'idle' } as DaemonSession;
  active.set(activeSessionKey(placeholderDs), placeholderDs);
  registerSessionGroup(CHAT, { ownerOpenId: 'ou_fixture', lastSessionId: placeholder.sessionId, createdAt: 1, lastActiveAt: 1 });

  mocks.reply.mockClear(); mocks.send.mockClear(); mocks.fork.mockClear();
  const publish = vi.spyOn(dashboardEventBus, 'publish');
  await handleThreadReply({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: 'om_resume_ph', chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text: '/resume' }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId: 'om_resume_ph', chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  await vi.waitFor(() => expect(store.getOwnedSession(real.sessionId)?.status).toBe('active'));
  expect(store.getOwnedSession(placeholder.sessionId)?.status).toBe('closed');
  expect(getSessionGroup(CHAT)?.lastSessionId).toBe(real.sessionId);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({
    type: 'session.update', body: { sessionId: real.sessionId, patch: { status: 'active', closedAt: null } },
  }));
  publish.mockRestore();
});

it('/resume placeholder detection uses persisted evidence only and never evicts in-flight repo setup', async () => {
  const workspace = join(mocks.dataDir, 'workspace-ph-flags'); mkdirSync(workspace, { recursive: true });
  registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'codex', allowedUsers: ['ou_fixture'] });
  store.init(APP); initSessionGroups(APP);
  const row = store.createSession(CHAT, 'om_ph_flags', '/help', 'group', 'chat');
  Object.assign(row, { larkAppId: APP, workingDir: workspace, cliId: 'codex' });
  const ds = { session: row, larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'chat', workingDir: workspace,
    worker: null, workerPort: null, workerToken: null, lastMessageAt: 1, lastScreenStatus: 'idle' } as DaemonSession;
  // restoreActiveSessions sets hasHistory=true on every restored row; still a placeholder.
  expect(pool.isResumeRecoveryPlaceholder({ ...ds, hasHistory: true } as DaemonSession)).toBe(true);
  expect(pool.isResumeRecoveryPlaceholder({ ...ds, worktreeCreating: true } as DaemonSession)).toBe(false);
  expect(pool.isResumeRecoveryPlaceholder({ ...ds, pendingRepoCommitInFlight: true } as DaemonSession)).toBe(false);
  expect(pool.isResumeRecoveryPlaceholder({ ...ds, session: { ...row, lastUserPrompt: 'hi' } } as DaemonSession)).toBe(false);
  // Accepted-but-unstarted work kept by restore must never be evicted.
  expect(pool.isResumeRecoveryPlaceholder({ ...ds, initialStartPending: true } as DaemonSession)).toBe(false);
  expect(pool.isResumeRecoveryPlaceholder({ ...ds, session: { ...row, queuedActivationTail: [{} as any] } } as DaemonSession)).toBe(false);
  expect(pool.isResumeRecoveryPlaceholder({ ...ds, session: { ...row, queuedActivationPending: true } } as DaemonSession)).toBe(false);
});

it('a command that pre-creates the chat-scope session (/help after /close) becomes the session-group resident', async () => {
  const workspace = join(mocks.dataDir, 'workspace-precreate'); mkdirSync(workspace, { recursive: true });
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'claude-code', allowedUsers: ['ou_fixture'], workingDir: workspace } as any);
  bot.resolvedAllowedUsers = ['ou_fixture'];
  store.init(APP); initSessionGroups(APP); pool.setActiveSessionsRegistry(active);
  const old = store.createSession(CHAT, 'om_old', 'old', 'group', 'chat');
  Object.assign(old, { larkAppId: APP, workingDir: workspace, cliId: 'claude-code', cliSessionId: 'cli-old' });
  store.updateSession(old); store.closeSession(old.sessionId);
  registerSessionGroup(CHAT, { ownerOpenId: 'ou_fixture', lastSessionId: old.sessionId, createdAt: 1, lastActiveAt: 1 });
  await handleNewTopic({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: 'om_help_pre', chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text: '/help' }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId: 'om_help_pre', chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  const resident = getSessionGroup(CHAT)?.lastSessionId;
  expect(resident).not.toBe(old.sessionId);
  expect(store.getOwnedSession(resident!)?.status).toBe('active');
});

it('a pre-created command session that loses registration to a concurrently resumed resident is not recorded as the group resident', async () => {
  const workspace = join(mocks.dataDir, 'workspace-loser'); mkdirSync(workspace, { recursive: true });
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'claude-code', allowedUsers: ['ou_fixture'], workingDir: workspace } as any);
  bot.resolvedAllowedUsers = ['ou_fixture'];
  store.init(APP); initSessionGroups(APP); pool.setActiveSessionsRegistry(active);
  // The old resident was just resumed (e.g. via its close card) and owns the chat slot.
  const resident = store.createSession(CHAT, 'om_resident', 'resident', 'group', 'chat');
  Object.assign(resident, { larkAppId: APP, workingDir: workspace, cliId: 'claude-code', cliSessionId: 'cli-resident' });
  store.updateSession(resident);
  const residentDs = { session: resident, larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'chat', workingDir: workspace,
    worker: null, workerPort: null, workerToken: null, lastMessageAt: 1, lastScreenStatus: 'idle' } as DaemonSession;
  active.set(activeSessionKey(residentDs), residentDs);
  registerSessionGroup(CHAT, { ownerOpenId: 'ou_fixture', lastSessionId: resident.sessionId, createdAt: 1, lastActiveAt: 1 });
  // A /help that was classified on the new-topic path pre-creates a scaffold, then loses the slot.
  await handleNewTopic({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: 'om_help_loser', chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text: '/help' }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId: 'om_help_loser', chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  expect(getSessionGroup(CHAT)?.lastSessionId).toBe(resident.sessionId);
  expect(active.get(activeSessionKey(residentDs))).toBe(residentDs);
});

it('an ordinary message whose fresh session loses registration to a concurrently resumed resident leaves the resident registered', async () => {
  const workspace = join(mocks.dataDir, 'workspace-ordinary-loser'); mkdirSync(workspace, { recursive: true });
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'claude-code', allowedUsers: ['ou_fixture'], workingDir: workspace } as any);
  bot.resolvedAllowedUsers = ['ou_fixture'];
  store.init(APP); initSessionGroups(APP); pool.setActiveSessionsRegistry(active);
  const resident = store.createSession(CHAT, 'om_resident2', 'resident', 'group', 'chat');
  Object.assign(resident, { larkAppId: APP, workingDir: workspace, cliId: 'claude-code', cliSessionId: 'cli-resident2' });
  store.updateSession(resident);
  const residentDs = { session: resident, larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'chat', workingDir: workspace,
    worker: null, workerPort: null, workerToken: null, lastMessageAt: 1, lastScreenStatus: 'idle' } as DaemonSession;
  active.set(activeSessionKey(residentDs), residentDs);
  registerSessionGroup(CHAT, { ownerOpenId: 'ou_fixture', lastSessionId: resident.sessionId, createdAt: 1, lastActiveAt: 1 });
  // Classified on the new-topic path before the resume landed: creates a row, then loses the slot.
  await handleNewTopic({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: 'om_hello_loser', chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text: 'hello' }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId: 'om_hello_loser', chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  expect(getSessionGroup(CHAT)?.lastSessionId).toBe(resident.sessionId);
  expect(active.get(activeSessionKey(residentDs))).toBe(residentDs);
});

it('a /t subtopic born in a session group does not displace the chat-scope resident', async () => {
  const workspace = join(mocks.dataDir, 'workspace-t'); mkdirSync(workspace, { recursive: true });
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'claude-code', allowedUsers: ['ou_fixture'], workingDir: workspace } as any);
  bot.resolvedAllowedUsers = ['ou_fixture'];
  store.init(APP); initSessionGroups(APP); pool.setActiveSessionsRegistry(active);
  registerSessionGroup(CHAT, { ownerOpenId: 'ou_fixture', lastSessionId: 'sess-chat-resident', createdAt: 1, lastActiveAt: 1 });
  await handleNewTopic({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: 'om_t_sub', chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text: '/t 开个子话题干活' }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId: 'om_t_sub', chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  expect(getSessionGroup(CHAT)?.lastSessionId).toBe('sess-chat-resident');
});

it('a cold-start passthrough (/goal) session born in a session group becomes the resident', async () => {
  const workspace = join(mocks.dataDir, 'workspace-goal'); mkdirSync(workspace, { recursive: true });
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'claude-code', allowedUsers: ['ou_fixture'], workingDir: workspace } as any);
  bot.resolvedAllowedUsers = ['ou_fixture'];
  store.init(APP); initSessionGroups(APP); pool.setActiveSessionsRegistry(active);
  const old = store.createSession(CHAT, 'om_old_goal', 'old', 'group', 'chat');
  Object.assign(old, { larkAppId: APP, workingDir: workspace, cliId: 'claude-code', cliSessionId: 'cli-old-goal' });
  store.updateSession(old); store.closeSession(old.sessionId);
  registerSessionGroup(CHAT, { ownerOpenId: 'ou_fixture', lastSessionId: old.sessionId, createdAt: 1, lastActiveAt: 1 });
  await handleNewTopic({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: 'om_goal', chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text: '/goal 修好登录页' }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId: 'om_goal', chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  const resident = getSessionGroup(CHAT)?.lastSessionId;
  expect(resident).not.toBe(old.sessionId);
  expect(store.getOwnedSession(resident!)?.status).toBe('active');
});

it('/resume skips a closed principal-lane shadow at the same visible anchor and refuses one named explicitly', async () => {
  const workspace = join(mocks.dataDir, 'workspace-lane'); mkdirSync(workspace, { recursive: true });
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 'fixture', cliId: 'claude-code', allowedUsers: ['ou_fixture'], workingDir: workspace } as any);
  bot.resolvedAllowedUsers = ['ou_fixture'];
  store.init(APP); initSessionGroups(APP); pool.setActiveSessionsRegistry(active);
  const source = store.createSession(CHAT, 'om_lane_src', 'source', 'group', 'chat');
  Object.assign(source, { larkAppId: APP, workingDir: workspace, cliId: 'claude-code', cliSessionId: 'cli-lane-src' });
  store.updateSession(source); store.closeSession(source.sessionId);
  await new Promise(r => setTimeout(r, 5));
  const shadow = store.createSession(CHAT, 'om_lane_shadow', 'shadow', 'group', 'chat');
  Object.assign(shadow, { larkAppId: APP, workingDir: workspace, cliId: 'claude-code', cliSessionId: 'cli-lane-shadow',
    principalLane: { routingAnchor: 'lane:virtual-anchor' } as any });
  store.updateSession(shadow); store.closeSession(shadow.sessionId);

  mocks.reply.mockClear(); mocks.send.mockClear();
  await handleNewTopic({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: 'om_lane_shadow_resume', chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text: `/resume ${shadow.sessionId}` }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId: 'om_lane_shadow_resume', chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  await vi.waitFor(() => expect([...mocks.reply.mock.calls, ...mocks.send.mock.calls].flat().join(' ')).toMatch(/并行车道|parallel-lane/));
  expect(store.getOwnedSession(shadow.sessionId)?.status).toBe('closed');

  await handleNewTopic({
    sender: { sender_id: { open_id: 'ou_fixture' }, sender_type: 'user' },
    message: { message_id: 'om_lane_resume', chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text: '/resume' }), create_time: String(Date.now()) },
  }, { chatId: CHAT, messageId: 'om_lane_resume', chatType: 'group', scope: 'chat', anchor: CHAT, larkAppId: APP });
  await vi.waitFor(() => expect(store.getOwnedSession(source.sessionId)?.status).toBe('active'));
  expect(store.getOwnedSession(shadow.sessionId)?.status).toBe('closed');
});
