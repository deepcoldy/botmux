/**
 * daemon GET /api/groups 给会话群附带的摘要（群组页「会话群」视图排序、状态、跳转会话用），
 * 以及 dashboard 汇总多个 daemon 回包时保留会话群字段。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as botRegistry from '../src/bot-registry.js';
import * as groupsStore from '../src/services/groups-store.js';
import * as sessionGroupsStore from '../src/services/session-groups-store.js';
import * as sessionStore from '../src/services/session-store.js';
import { setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { sessionGroupBoardMeta, type SessionGroupEntry } from '../src/services/session-groups-store.js';
import { adoptSessionGroupFields } from '../src/dashboard/groups-matrix-snapshot.js';

const T0 = Date.UTC(2026, 9, 30, 8, 0, 0);

function entry(overrides: Partial<SessionGroupEntry> = {}): SessionGroupEntry {
  return { ownerOpenId: 'ou_owner', lastSessionId: 'sess-1', createdAt: T0, lastActiveAt: T0 + 60_000, ...overrides };
}

describe('sessionGroupBoardMeta', () => {
  it('uses the newer of the registry time and the resident session\'s last message', () => {
    const later = new Date(T0 + 3_600_000).toISOString();
    expect(sessionGroupBoardMeta(entry(), { status: 'active', lastMessageAt: later })).toEqual({
      createdAt: T0, lastActiveAt: T0 + 3_600_000, sessionId: 'sess-1', sessionStatus: 'active',
    });
    // 会话最后一条消息比注册表还旧（比如刚 resume）→ 用注册表时间
    const earlier = new Date(T0).toISOString();
    expect(sessionGroupBoardMeta(entry(), { status: 'closed', lastMessageAt: earlier }).lastActiveAt).toBe(T0 + 60_000);
  });

  it('falls back to the registry when the session is unknown or its timestamp is unusable', () => {
    expect(sessionGroupBoardMeta(entry(), undefined)).toEqual({ createdAt: T0, lastActiveAt: T0 + 60_000, sessionId: 'sess-1' });
    const meta = sessionGroupBoardMeta(entry(), { status: 'weird', lastMessageAt: 'not-a-date' });
    expect(meta.lastActiveAt).toBe(T0 + 60_000);
    expect(meta).not.toHaveProperty('sessionStatus');
  });
});

describe('adoptSessionGroupFields', () => {
  it('keeps the session-group flag and summary when a non-owner daemon answered first', () => {
    const merged: Record<string, unknown> = { chatId: 'oc_s', name: 'S' };
    adoptSessionGroupFields(merged, { chatId: 'oc_s', sessionGroup: true, sessionGroupMeta: { createdAt: 1, lastActiveAt: 2 } });
    expect(merged).toMatchObject({ sessionGroup: true, sessionGroupMeta: { createdAt: 1, lastActiveAt: 2 } });
  });

  it('never overwrites an already-adopted summary or flags a plain group', () => {
    const merged: Record<string, unknown> = { chatId: 'oc_s', sessionGroup: true, sessionGroupMeta: { createdAt: 1, lastActiveAt: 9 } };
    adoptSessionGroupFields(merged, { chatId: 'oc_s', sessionGroup: true, sessionGroupMeta: { createdAt: 1, lastActiveAt: 2 } });
    expect((merged.sessionGroupMeta as { lastActiveAt: number }).lastActiveAt).toBe(9);
    const plain: Record<string, unknown> = { chatId: 'oc_p' };
    adoptSessionGroupFields(plain, { chatId: 'oc_p' });
    expect(plain).not.toHaveProperty('sessionGroup');
  });
});

describe('GET /api/groups session-group summary', () => {
  let handle: IpcServerHandle | undefined;

  beforeEach(() => {
    setActiveSessionsRegistry(new Map() as any);
    setLarkAppId('app-a');
    vi.spyOn(botRegistry, 'getBot').mockImplementation((() => ({ config: { larkAppId: 'app-a', cliId: 'codex' } })) as any);
    vi.spyOn(groupsStore, 'listChats').mockResolvedValue([
      { chatId: 'oc_session', name: '修复登录跳转' },
      { chatId: 'oc_plain', name: '评审群' },
    ] as any);
    vi.spyOn(sessionGroupsStore, 'isSessionGroup').mockImplementation(chatId => chatId === 'oc_session');
    vi.spyOn(sessionGroupsStore, 'getSessionGroup').mockImplementation(chatId => (chatId === 'oc_session' ? entry() : undefined));
    vi.spyOn(sessionStore, 'getOwnedSession').mockImplementation(id => (id === 'sess-1'
      ? { sessionId: 'sess-1', status: 'active', lastMessageAt: new Date(T0 + 7_200_000).toISOString() } as any
      : undefined));
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    setIpcAuthSecret(null);
    vi.restoreAllMocks();
  });

  it('attaches createdAt / lastActiveAt / resident session to session groups only', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/groups`);
    const body = await response.json() as { chats: Array<Record<string, any>> };
    const session = body.chats.find(chat => chat.chatId === 'oc_session')!;
    const plain = body.chats.find(chat => chat.chatId === 'oc_plain')!;
    expect(session.sessionGroup).toBe(true);
    expect(session.sessionGroupMeta).toEqual({
      createdAt: T0, lastActiveAt: T0 + 7_200_000, sessionId: 'sess-1', sessionStatus: 'active',
    });
    expect(plain).not.toHaveProperty('sessionGroup');
    expect(plain).not.toHaveProperty('sessionGroupMeta');
  });
});
