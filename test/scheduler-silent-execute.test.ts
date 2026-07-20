/**
 * scheduler-silent-execute.test.ts
 *
 * Behavioral tests for executeScheduledTask's silent mode (ScheduledTask.silent):
 *  - silent thread fire: no "🕐 task started" banner / creator notice, anchor
 *    reuses task.rootMessageId, spawned session carries a turn-exact silent id and
 *    the CLI prompt is wrapped with the silent-schedule hint
 *  - loud fire keeps posting the banner (control)
 *  - runtime fallback: silent+new-topic (store-level bypass) fires loud
 *  - live-session injection: silent id follows the queued turn even when busy
 *  - converted-topic regression: chat-scope task in a topic-converted group
 *    anchors at rootMessageId (previously clobbered by the trailing
 *    `anchor = task.chatId`) and the runtime session is promoted to thread scope
 *
 * forkWorker / lark client are stubbed (same pattern as
 * dashboard-create-session.test.ts) so the routing logic runs in isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session, ScheduledTask } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';

// ── in-memory session store ──────────────────────────────────────────────
const store = new Map<string, Session>();
let sessionSeq = 0;
vi.mock('../src/services/session-store.js', () => ({
  createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p'): Session => {
    const s: Session = {
      sessionId: `sess-${++sessionSeq}`,
      chatId, rootMessageId, title, chatType,
      status: 'active', createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    };
    store.set(s.sessionId, s);
    return s;
  }),
  updateSession: vi.fn((s: Session) => { store.set(s.sessionId, s); }),
  getSession: vi.fn((id: string) => store.get(id)),
  listSessions: vi.fn(() => [...store.values()]),
  closeSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));

const sendMessageMock = vi.fn(async () => 'om_banner_123');
const replyMessageMock = vi.fn(async () => 'om_reply_456');
const getChatModeMock = vi.fn(async () => 'group');
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...a: any[]) => sendMessageMock(...a),
  replyMessage: (...a: any[]) => replyMessageMock(...a),
  getChatMode: (...a: any[]) => getChatModeMock(...a),
  downloadMessageResource: vi.fn(),
  listChatBotMembers: vi.fn(async () => []),
  UserTokenMissingError: class extends Error {},
}));

const forkWorkerMock = vi.fn();
const sendWorkerInputMock = vi.fn(() => true);
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...a: any[]) => forkWorkerMock(...a),
  sendWorkerInput: (...a: any[]) => sendWorkerInputMock(...a),
  forkAdoptWorker: vi.fn(),
  killStalePids: vi.fn(),
  getCurrentCliVersion: vi.fn(() => 'test-cli-v1'),
  restoreUsageLimitRuntimeState: vi.fn(),
  setActiveSessionSafe: vi.fn(async (map: Map<string, any>, k: string, ds: any) => { map.set(k, ds); }),
  getActiveSessionsRegistry: vi.fn(() => null),
  isRelayableRealSession: vi.fn(() => false),
  closeSession: vi.fn(),
  suspendWorker: vi.fn(),
}));

const BOT = {
  config: { larkAppId: 'cli_app_test', cliId: 'claude-code', cliPathOverride: undefined, defaultWorkingDir: '/tmp' },
  botName: 'TestBot',
  botOpenId: 'ou_bot',
};
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => BOT),
  getAllBots: vi.fn(() => [BOT]),
  getOwnerOpenId: vi.fn(() => 'ou_owner'),
  findOncallChat: vi.fn(() => undefined),
  findOncallChatForAnyBot: vi.fn(() => undefined),
  effectiveDefaultWorkingDir: vi.fn((cfg: any) => cfg?.defaultWorkingDir),
}));

vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: vi.fn() } }));
vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn((ds: DaemonSession) => ({ sessionId: ds.session.sessionId })),
}));
vi.mock('../src/core/role-resolver.js', () => ({
  resolveRole: vi.fn(() => ({ content: null, source: undefined })),
  resolveRoleInjection: vi.fn(() => ({ content: null, source: undefined, injectMode: 'none' })),
}));
vi.mock('../src/services/whiteboard-store.js', () => ({
  whiteboardEnabled: vi.fn(() => false),
  getWhiteboard: vi.fn(),
  ensureDefaultWhiteboard: vi.fn(),
}));

import { executeScheduledTask, rememberLastCliInput } from '../src/core/session-manager.js';
import { sessionKey } from '../src/core/types.js';

const APP = 'cli_app_test';
const CHAT = 'oc_chat';
const ROOT = 'om_root_thread';
const refreshCliVersion = vi.fn(() => true);

function baseTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task0001',
    name: '服务巡检',
    schedule: 'every 30m',
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
    prompt: '检查服务状态，挂了才报警',
    workingDir: '/tmp',
    chatId: CHAT,
    larkAppId: APP,
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

function forkedCliInput(): string {
  const arg = forkWorkerMock.mock.calls[0][1];
  return typeof arg === 'string' ? arg : arg.content;
}

function forkedTurnId(): string {
  return forkWorkerMock.mock.calls[0][2];
}

beforeEach(() => {
  store.clear();
  sessionSeq = 0;
  forkWorkerMock.mockClear();
  sendWorkerInputMock.mockClear();
  sendMessageMock.mockClear();
  replyMessageMock.mockClear();
  getChatModeMock.mockClear();
  getChatModeMock.mockResolvedValue('group');
});

describe('executeScheduledTask — silent thread fire', () => {
  it('posts nothing, anchors at rootMessageId, arms the exact forked turn, wraps the prompt', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ rootMessageId: ROOT, scope: 'thread', silent: true }), active, refreshCliVersion);

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(replyMessageMock).not.toHaveBeenCalled();

    const ds = active.get(sessionKey(ROOT, APP))!;
    expect(ds).toBeTruthy();
    expect(forkedTurnId()).toMatch(/^schedule:task0001:/);
    expect(ds.silentScheduledTurns?.has(forkedTurnId())).toBe(true);
    expect(ds.session.rootMessageId).toBe(ROOT);

    expect(forkWorkerMock).toHaveBeenCalledTimes(1);
    const input = forkedCliInput();
    expect(input).toContain('<botmux_silent_schedule trusted="true">');
    expect(input).toContain('检查服务状态，挂了才报警');
    // dashboard-facing lastUserPrompt keeps the raw task prompt (no hint blob)
    expect(ds.lastUserPrompt).toBe('检查服务状态，挂了才报警');
  });

  it('loud fire (control): banner reply posted in-thread, no silent flag, no hint', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ rootMessageId: ROOT, scope: 'thread' }), active, refreshCliVersion);

    expect(replyMessageMock).toHaveBeenCalledTimes(1);
    const ds = active.get(sessionKey(ROOT, APP))!;
    expect(ds.silentScheduledTurns).toBeUndefined();
    expect(forkedTurnId()).toMatch(/^schedule:task0001:/);
    expect(forkedCliInput()).not.toContain('<botmux_silent_schedule');
  });
});

describe('executeScheduledTask — silent runtime fallbacks (creation-time guards bypassed)', () => {
  it('silent + new-topic falls back to a loud fire (banner creates the anchor)', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ deliver: 'new-topic', silent: true }), active, refreshCliVersion);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const ds = active.get(sessionKey('om_banner_123', APP))!;
    expect(ds).toBeTruthy();
    expect(ds.silentScheduledTurns).toBeUndefined();
    expect(forkedCliInput()).not.toContain('<botmux_silent_schedule');
  });

  it('silent thread task without rootMessageId falls back to a loud fire', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ scope: 'thread', silent: true }), active, refreshCliVersion);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const ds = active.get(sessionKey('om_banner_123', APP))!;
    expect(ds.silentScheduledTurns).toBeUndefined();
  });
});

describe('executeScheduledTask — silent chat-scope fire', () => {
  it('posts no banner and anchors at chatId', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ scope: 'chat', silent: true }), active, refreshCliVersion);

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(replyMessageMock).not.toHaveBeenCalled();
    const ds = active.get(sessionKey(CHAT, APP))!;
    expect(ds).toBeTruthy();
    expect(ds.scope).toBe('chat');
    expect(ds.silentScheduledTurns?.has(forkedTurnId())).toBe(true);
  });

  it('suppresses the cross-chat creator notice too', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({
      scope: 'chat', silent: true,
      creatorChatId: 'oc_other_chat', creatorRootMessageId: 'om_creator_root',
    }), active, refreshCliVersion);

    expect(replyMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(active.get(sessionKey(CHAT, APP))).toBeTruthy();
  });
});

describe('executeScheduledTask — live-session injection', () => {
  function liveSession(lastScreenStatus?: string): DaemonSession {
    const session: Session = {
      sessionId: 'sess-live', chatId: CHAT, rootMessageId: ROOT, title: 'live',
      status: 'active', createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    };
    store.set(session.sessionId, session);
    return {
      session,
      worker: { killed: false, send: vi.fn() } as any,
      workerPort: 1234, workerToken: 'tok',
      larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'thread',
      spawnedAt: 0, cliVersion: 'test-cli-v1', lastMessageAt: 0,
      hasHistory: true, workingDir: '/tmp',
      lastScreenStatus: lastScreenStatus as any,
    };
  }

  it('idle session: injects with the exact scheduled turn armed, no banner', async () => {
    const active = new Map<string, DaemonSession>();
    const existing = liveSession('idle');
    active.set(sessionKey(ROOT, APP), existing);

    await executeScheduledTask(baseTask({ rootMessageId: ROOT, scope: 'thread', silent: true }), active, refreshCliVersion);

    expect(replyMessageMock).not.toHaveBeenCalled();
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
    expect(forkWorkerMock).not.toHaveBeenCalled();
    const turnId = sendWorkerInputMock.mock.calls[0][2];
    expect(turnId).toMatch(/^schedule:task0001:/);
    expect(existing.silentScheduledTurns?.has(turnId)).toBe(true);
    const injected = sendWorkerInputMock.mock.calls[0][1];
    const content = typeof injected === 'string' ? injected : injected.content;
    expect(content).toContain('<botmux_silent_schedule');
  });

  it('busy session: arms only the queued scheduled turn without hushing the user turn', async () => {
    const active = new Map<string, DaemonSession>();
    const existing = liveSession('working');
    active.set(sessionKey(ROOT, APP), existing);

    await executeScheduledTask(baseTask({ rootMessageId: ROOT, scope: 'thread', silent: true }), active, refreshCliVersion);

    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
    const turnId = sendWorkerInputMock.mock.calls[0][2];
    expect(existing.silentScheduledTurns?.has(turnId)).toBe(true);
    expect(existing.silentScheduledTurns?.has('normal-user-turn')).toBe(false);
  });
});

describe('silent scheduled turn lifecycle', () => {
  it('a queued real CLI input does not clear the exact silent turn marker', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ rootMessageId: ROOT, scope: 'thread', silent: true }), active, refreshCliVersion);
    const ds = active.get(sessionKey(ROOT, APP))!;
    const turnId = forkedTurnId();
    expect(ds.silentScheduledTurns?.has(turnId)).toBe(true);

    rememberLastCliInput(ds, '真实用户消息', '真实用户消息');
    expect(ds.silentScheduledTurns?.has(turnId)).toBe(true);
  });
});

describe('executeScheduledTask — converted-topic anchor regression', () => {
  it('chat-scope task in a topic-converted group anchors at rootMessageId and promotes to thread scope', async () => {
    getChatModeMock.mockResolvedValue('topic');
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ scope: 'chat', rootMessageId: ROOT }), active, refreshCliVersion);

    // banner reply lands in the original thread, session anchors there too
    expect(replyMessageMock).toHaveBeenCalledTimes(1);
    const ds = active.get(sessionKey(ROOT, APP))!;
    expect(ds).toBeTruthy();
    expect(ds.scope).toBe('thread');            // runtimeScope promotion now reachable
    expect(active.get(sessionKey(CHAT, APP))).toBeUndefined(); // no chat-anchored duplicate
  });

  it('silent chat-scope task in a topic-converted group: same anchor, zero messages', async () => {
    getChatModeMock.mockResolvedValue('topic');
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ scope: 'chat', rootMessageId: ROOT, silent: true }), active, refreshCliVersion);

    expect(replyMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    const ds = active.get(sessionKey(ROOT, APP))!;
    expect(ds.scope).toBe('thread');
    expect(ds.silentScheduledTurns?.has(forkedTurnId())).toBe(true);
  });
});
