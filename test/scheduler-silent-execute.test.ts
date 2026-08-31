/**
 * scheduler-silent-execute.test.ts
 *
 * Behavioral tests for executeScheduledTask's silent mode (ScheduledTask.silent):
 *  - silent thread fire: no "🕐 task started" banner / creator notice, anchor
 *    reuses task.rootMessageId, spawned session carries a turn-exact silent id and
 *    the CLI prompt is wrapped with the silent-schedule hint
 *  - loud fire keeps posting the banner (control)
 *  - explicit fresh-topic fires post their configured title and own a new anchor
 *  - silent fresh-topic fires start at a durable virtual anchor and defer the
 *    visible Lark root until the first botmux send
 *  - chat-scope fires honor the bot/chat regular-group mode for flat, shared,
 *    and independent-topic routing
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
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
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
const getMessageThreadIdMock = vi.fn(async () => 'omt_target_thread');
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...a: any[]) => sendMessageMock(...a),
  replyMessage: (...a: any[]) => replyMessageMock(...a),
  getChatMode: (...a: any[]) => getChatModeMock(...a),
  getMessageThreadId: (...a: any[]) => getMessageThreadIdMock(...a),
  downloadMessageResource: vi.fn(),
  listChatBotMembers: vi.fn(async () => []),
  UserTokenMissingError: class extends Error {},
}));

const forkWorkerMock = vi.fn();
const sendWorkerInputMock = vi.fn(() => true);
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...a: any[]) => {
    // Faithfully model the production queued-session transition. A loose
    // no-op mock would hide the exact regression this suite guards: forking a
    // parked session permanently consumes its dashboard task.
    const ds = a[0] as DaemonSession;
    if (ds.session.queued) {
      ds.session.queued = false;
      ds.session.queuedPrompt = undefined;
      ds.session.queuedCodexAppText = undefined;
      ds.session.queuedCodexAppMessageContext = undefined;
      store.set(ds.session.sessionId, ds.session);
    }
    return forkWorkerMock(...a);
  },
  sendWorkerInput: (...a: any[]) => sendWorkerInputMock(...a),
  forkAdoptWorker: vi.fn(),
  adoptSandboxBlocked: vi.fn((botCfg, session) => botCfg?.sandbox === true || botCfg?.readIsolation === true || session?.sandbox === true || process.env.BOTMUX_SANDBOX === '1'),
  killStalePids: vi.fn(),
  sweepDeadPidMarkers: vi.fn(),
  getCurrentCliVersion: vi.fn(() => 'test-cli-v1'),
  restoreUsageLimitRuntimeState: vi.fn(),
  setActiveSessionIfActive: vi.fn((map: Map<string, any>, k: string, ds: any) => {
    if (map.has(k) && map.get(k) !== ds) return false;
    map.set(k, ds);
    return true;
  }),
  setActiveSessionSafe: vi.fn(async (map: Map<string, any>, k: string, ds: any) => { map.set(k, ds); }),
  getActiveSessionsRegistry: vi.fn(() => null),
  withActiveSessionKeyLock: vi.fn(async (
    _map: Map<string, any>,
    _key: string,
    action: () => any,
  ) => action()),
  isRelayableRealSession: vi.fn((ds: DaemonSession) =>
    (!!ds.worker && !ds.worker.killed) || !!ds.session.cliId || !!ds.session.lastCliInput),
  isDisposableCommandScratch: vi.fn((ds: DaemonSession) =>
    !ds.worker
    && !ds.pendingRepo
    && ds.pendingPrompt === undefined
    && ds.pendingRawInput === undefined
    && !ds.adoptedFrom
    && !ds.session.adoptedFrom
    && !ds.session.queued
    && !ds.session.cliId
    && !ds.session.lastCliInput),
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

// 让 hook 模式的 preflight 通过：否则 riff 守卫的接线测试会因为 preflight false 而
// 恒为 inline，锁不住 executeScheduledTask → buildFollowUpCliInput 的 sessionBackendType 传参。
vi.mock('../src/adapters/hook-installer.js', () => ({
  hasInstalledPromptHookCached: vi.fn(() => true),
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

function forkedPayload(): any {
  return forkWorkerMock.mock.calls[0][1];
}

beforeEach(() => {
  store.clear();
  sessionSeq = 0;
  forkWorkerMock.mockClear();
  sendWorkerInputMock.mockClear();
  sendWorkerInputMock.mockReturnValue(true);
  sendMessageMock.mockClear();
  replyMessageMock.mockClear();
  getChatModeMock.mockClear();
  getChatModeMock.mockResolvedValue('group');
  getMessageThreadIdMock.mockClear();
  getMessageThreadIdMock.mockResolvedValue('omt_target_thread');
  delete (BOT.config as typeof BOT.config & { regularGroupReplyMode?: string }).regularGroupReplyMode;
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

  it('runs the turn as the task creator: identity + schedule_creator provenance on the payload', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({
      rootMessageId: ROOT,
      scope: 'thread',
      ownerOpenId: 'ou_creator',
      ownerUnionId: 'on_creator',
    }), active, refreshCliVersion);

    expect(forkedPayload().trustedCaller).toEqual({
      requestUserOpenId: 'ou_creator',
      requestUserUnionId: 'on_creator',
      requestLarkAppId: APP,
      source: 'schedule_creator',
      taskId: 'task0001',
    });
  });

  it('carries no identity when the task has no creator union_id (fail closed, not "runs as the bot")', async () => {
    const active = new Map<string, DaemonSession>();
    // ownerOpenId alone is what legacy tasks and bot-created tasks have. It is
    // app-scoped and deliberately not enough to act as that user.
    await executeScheduledTask(baseTask({
      rootMessageId: ROOT,
      scope: 'thread',
      ownerOpenId: 'ou_creator',
    }), active, refreshCliVersion);

    expect(forkedPayload().trustedCaller).toBeUndefined();
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

describe('executeScheduledTask — fresh-topic execution', () => {
  it('posts the custom title and always starts an independent thread session', async () => {
    const active = new Map<string, DaemonSession>();
    (BOT.config as typeof BOT.config & { regularGroupReplyMode?: string }).regularGroupReplyMode = 'shared';
    await executeScheduledTask(baseTask({
      executionPosition: 'new-topic',
      topicTitle: '每日发布巡检',
      chatType: 'group',
    }), active, refreshCliVersion);

    expect(sendMessageMock).toHaveBeenCalledWith(APP, CHAT, '每日发布巡检');
    expect(replyMessageMock).not.toHaveBeenCalled();
    expect(getChatModeMock).not.toHaveBeenCalled();
    const ds = active.get(sessionKey('om_banner_123', APP))!;
    expect(ds).toBeTruthy();
    expect(ds.scope).toBe('thread');
    expect(ds.session.rootMessageId).toBe('om_banner_123');
    expect(ds.hasHistory).toBe(false);
  });

  it('uses the standard task-start notice when no custom title is configured', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ executionPosition: 'new-topic', chatType: 'group' }), active, refreshCliVersion);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][2]).toContain('服务巡检');
    expect(active.get(sessionKey('om_banner_123', APP))?.scope).toBe('thread');
  });

  it('starts fresh-topic + silent at an isolated virtual anchor without a visible seed', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({
      executionPosition: 'new-topic',
      silent: true,
      topicTitle: '按需巡检告警',
    }), active, refreshCliVersion);

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(replyMessageMock).not.toHaveBeenCalled();
    expect(active.size).toBe(1);
    expect(forkWorkerMock).toHaveBeenCalledTimes(1);
    const [[key, ds]] = [...active.entries()];
    expect(key).toMatch(/^schedule-run:task0001:[^:]+::cli_app_test$/);
    expect(ds.scope).toBe('chat');
    expect(ds.session.rootMessageId).toBe(ds.session.deferredScheduleRun?.routingAnchor);
    expect(ds.session.deferredScheduleRun).toMatchObject({
      taskId: 'task0001',
      turnId: forkedTurnId(),
      topicTitle: '按需巡检告警',
    });
    expect(ds.silentScheduledTurns?.has(forkedTurnId())).toBe(true);
  });

  it('gives every silent fresh-topic fire a distinct session and virtual anchor', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ executionPosition: 'new-topic', silent: true }), active, refreshCliVersion);
    await executeScheduledTask(baseTask({ executionPosition: 'new-topic', silent: true }), active, refreshCliVersion);

    expect(active.size).toBe(2);
    expect(new Set([...active.values()].map(ds => ds.session.sessionId)).size).toBe(2);
    expect(new Set([...active.values()].map(ds => ds.session.deferredScheduleRun?.routingAnchor)).size).toBe(2);
  });

  it('thread task without a real root safely degrades to silent chat scope', async () => {
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ scope: 'thread', silent: true }), active, refreshCliVersion);

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(replyMessageMock).not.toHaveBeenCalled();
    const ds = active.get(sessionKey(CHAT, APP))!;
    expect(ds.scope).toBe('chat');
    expect(ds.silentScheduledTurns?.has(forkedTurnId())).toBe(true);
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

describe('executeScheduledTask — chat-scope regular-group mode', () => {
  it('cross-chat loud execution notifies the creator and still uses a target-chat trigger', async () => {
    (BOT.config as typeof BOT.config & { regularGroupReplyMode?: string }).regularGroupReplyMode = 'new-topic';
    const active = new Map<string, DaemonSession>();

    await executeScheduledTask(baseTask({
      scope: 'chat',
      chatType: 'group',
      creatorChatId: 'oc_creator_chat',
      creatorRootMessageId: 'om_creator_root',
    }), active, refreshCliVersion);

    await vi.waitFor(() => {
      expect(replyMessageMock).toHaveBeenCalledWith(
        APP,
        'om_creator_root',
        expect.any(String),
        'text',
        true,
      );
    });
    expect(sendMessageMock).toHaveBeenCalledWith(APP, CHAT, expect.any(String));
    expect(active.get(sessionKey(CHAT, APP))).toBeUndefined();
    expect(active.get(sessionKey('om_banner_123', APP))?.scope).toBe('thread');
  });

  it('new-topic mode uses the top-level banner as a fresh thread/session anchor', async () => {
    (BOT.config as typeof BOT.config & { regularGroupReplyMode?: string }).regularGroupReplyMode = 'new-topic';
    const active = new Map<string, DaemonSession>();

    await executeScheduledTask(baseTask({ scope: 'chat', chatType: 'group' }), active, refreshCliVersion);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(active.get(sessionKey(CHAT, APP))).toBeUndefined();
    const ds = active.get(sessionKey('om_banner_123', APP))!;
    expect(ds).toBeTruthy();
    expect(ds.scope).toBe('thread');
    expect(ds.session.rootMessageId).toBe('om_banner_123');
  });

  it('shared mode reuses chat scope but pins this exact turn under the banner topic', async () => {
    (BOT.config as typeof BOT.config & { regularGroupReplyMode?: string }).regularGroupReplyMode = 'shared';
    const active = new Map<string, DaemonSession>();

    await executeScheduledTask(baseTask({ scope: 'chat', chatType: 'group' }), active, refreshCliVersion);

    const ds = active.get(sessionKey(CHAT, APP))!;
    const turnId = forkedTurnId();
    expect(ds.scope).toBe('chat');
    expect(ds.session.replyTargets?.[turnId]?.rootMessageId).toBe('om_banner_123');
    expect(ds.currentReplyTarget).toMatchObject({ rootMessageId: 'om_banner_123', turnId });
  });

  it('a topic group uses the top-level banner as its thread anchor', async () => {
    getChatModeMock.mockResolvedValue('topic');
    const active = new Map<string, DaemonSession>();

    await executeScheduledTask(baseTask({ scope: 'chat', chatType: 'topic_group' }), active, refreshCliVersion);

    const ds = active.get(sessionKey('om_banner_123', APP))!;
    expect(ds).toBeTruthy();
    expect(ds.scope).toBe('thread');
  });

  it('silent new-topic mode stays silent and chat-scoped because there is no visible trigger anchor', async () => {
    (BOT.config as typeof BOT.config & { regularGroupReplyMode?: string }).regularGroupReplyMode = 'new-topic';
    const active = new Map<string, DaemonSession>();

    await executeScheduledTask(baseTask({ scope: 'chat', chatType: 'group', silent: true }), active, refreshCliVersion);

    expect(sendMessageMock).not.toHaveBeenCalled();
    const ds = active.get(sessionKey(CHAT, APP))!;
    expect(ds.scope).toBe('chat');
    expect(ds.silentScheduledTurns?.has(forkedTurnId())).toBe(true);
  });
});

describe('executeScheduledTask — cross-target notice', () => {
  it('links a cross-thread creator notice to the exact target topic', async () => {
    const active = new Map<string, DaemonSession>();

    await executeScheduledTask(baseTask({
      rootMessageId: ROOT,
      scope: 'thread',
      creatorChatId: CHAT,
      creatorRootMessageId: 'om_creator_root',
    }), active, refreshCliVersion);

    await vi.waitFor(() => {
      expect(getMessageThreadIdMock).toHaveBeenCalledWith(APP, ROOT);
      expect(replyMessageMock).toHaveBeenCalledWith(
        APP,
        'om_creator_root',
        expect.stringContaining(
          'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_chat&open_thread_id=omt_target_thread',
        ),
        'text',
        true,
      );
    });
    expect(active.get(sessionKey(ROOT, APP))).toBeTruthy();
  });

  it('links a cross-chat creator notice to the target chat', async () => {
    (BOT.config as typeof BOT.config & { regularGroupReplyMode?: string }).regularGroupReplyMode = 'new-topic';
    const active = new Map<string, DaemonSession>();

    await executeScheduledTask(baseTask({
      scope: 'chat',
      chatType: 'group',
      creatorChatId: 'oc_creator_chat',
      creatorRootMessageId: 'om_creator_root',
    }), active, refreshCliVersion);

    await vi.waitFor(() => {
      expect(replyMessageMock).toHaveBeenCalledWith(
        APP,
        'om_creator_root',
        expect.stringContaining('https://applink.feishu.cn/client/chat/open?openChatId=oc_chat'),
        'text',
        true,
      );
    });
  });

  it('falls back to the target chat link when topic resolution fails', async () => {
    getMessageThreadIdMock.mockRejectedValueOnce(new Error('lookup failed'));
    const active = new Map<string, DaemonSession>();

    await executeScheduledTask(baseTask({
      rootMessageId: ROOT,
      scope: 'thread',
      creatorChatId: CHAT,
      creatorRootMessageId: 'om_creator_root',
    }), active, refreshCliVersion);

    await vi.waitFor(() => {
      expect(replyMessageMock).toHaveBeenCalledWith(
        APP,
        'om_creator_root',
        expect.stringContaining('https://applink.feishu.cn/client/chat/open?openChatId=oc_chat'),
        'text',
        true,
      );
    });
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

  it('live injection carries the creator identity in OPTS (sendWorkerInput never reads the payload)', async () => {
    // sendWorkerInput reads trustedCaller from its 4th argument only; forkWorker
    // reads payload ?? opts. Putting the identity on the payload type-checks and
    // is then silently dropped — and this is the path every recurring fire after
    // the first one takes, so the bug would read as "worked once, then quietly
    // ran without identity".
    const active = new Map<string, DaemonSession>();
    const existing = liveSession('idle');
    active.set(sessionKey(ROOT, APP), existing);

    await executeScheduledTask(baseTask({
      rootMessageId: ROOT,
      scope: 'thread',
      ownerOpenId: 'ou_creator',
      ownerUnionId: 'on_creator',
    }), active, refreshCliVersion);

    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
    expect(sendWorkerInputMock.mock.calls[0][3]).toEqual({
      trustedCaller: {
        requestUserOpenId: 'ou_creator',
        requestUserUnionId: 'on_creator',
        requestLarkAppId: APP,
        source: 'schedule_creator',
        taskId: 'task0001',
      },
    });
  });

  it('live injection passes no identity when the task has no creator union_id', async () => {
    const active = new Map<string, DaemonSession>();
    const existing = liveSession('idle');
    active.set(sessionKey(ROOT, APP), existing);

    await executeScheduledTask(baseTask({
      rootMessageId: ROOT,
      scope: 'thread',
      ownerOpenId: 'ou_creator',
    }), active, refreshCliVersion);

    // Byte-for-byte the pre-change behaviour for legacy/bot-created tasks.
    expect(sendWorkerInputMock.mock.calls[0][3]).toEqual({});
  });

  it('riff-backed claude-code session: scheduled fire stays inline（锁 sessionBackendType 传参）', async () => {
    // review 要求：executeScheduledTask → buildFollowUpCliInput 必须传 sessionBackendType。
    // 删掉该实参，旧代码（&& 短路）会让 riff 会话误进 hook 模式（reminder 不在 PTY 文本里，
    // 远端又读不到 sidecar → reminder 丢失）。preflight 已 mock 为 true，唯一拦它的就是 riff 白名单。
    const prev = (BOT.config as Record<string, unknown>).envelopeInjection;
    (BOT.config as Record<string, unknown>).envelopeInjection = 'auto';
    try {
      const active = new Map<string, DaemonSession>();
      const existing = liveSession('idle');
      existing.session.cliId = 'claude-code';
      existing.session.backendType = 'riff' as never;
      active.set(sessionKey(ROOT, APP), existing);

      await executeScheduledTask(baseTask({ rootMessageId: ROOT, scope: 'thread', silent: true }), active, refreshCliVersion);

      expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
      const injected = sendWorkerInputMock.mock.calls[0][1];
      const content = typeof injected === 'string' ? injected : injected.content;
      // riff 后端没有本地 hook 进程 → 必须 inline（reminder 在 PTY 文本里）
      expect(content).toContain('<botmux_reminder>');
    } finally {
      (BOT.config as Record<string, unknown>).envelopeInjection = prev;
    }
  });

  it('local-backend claude-code session + auto: scheduled fire 走 hook 模式（锁 sessionBackendType 传参）', async () => {
    // 与上一条互补：本地后端（pty）+ auto 应走 hook 模式（reminder 不在 PTY 文本里）。
    // 若有人删掉 executeScheduledTask 里的 sessionBackendType 实参，B3 fail-closed 会把
    // undefined 判为非本地 → 强制 inline → reminder 出现在 PTY 文本里 → 本测试失败。
    const prev = (BOT.config as Record<string, unknown>).envelopeInjection;
    (BOT.config as Record<string, unknown>).envelopeInjection = 'auto';
    try {
      const active = new Map<string, DaemonSession>();
      const existing = liveSession('idle');
      existing.session.cliId = 'claude-code';
      existing.session.backendType = 'pty' as never;
      active.set(sessionKey(ROOT, APP), existing);

      await executeScheduledTask(baseTask({ rootMessageId: ROOT, scope: 'thread', silent: true }), active, refreshCliVersion);

      expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
      const injected = sendWorkerInputMock.mock.calls[0][1];
      const content = typeof injected === 'string' ? injected : injected.content;
      // 本地后端 + auto → hook 模式：reminder 进 sidecar，PTY 文本里没有
      expect(content).not.toContain('<botmux_reminder>');
      expect(content).toContain('<user_message>');
    } finally {
      (BOT.config as Record<string, unknown>).envelopeInjection = prev;
    }
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

  it('cold-resumes the registered worker-less session instead of losing the scheduled turn to CAS', async () => {
    const active = new Map<string, DaemonSession>();
    const existing = liveSession('idle');
    existing.worker = null;
    existing.workerPort = null;
    existing.workerToken = null;
    existing.session.suspendedColdResume = true;
    active.set(sessionKey(ROOT, APP), existing);

    await executeScheduledTask(
      baseTask({ rootMessageId: ROOT, scope: 'thread', silent: true }),
      active,
      refreshCliVersion,
    );

    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    expect(active.get(sessionKey(ROOT, APP))).toBe(existing);
    expect(store.size).toBe(1);
    expect(forkWorkerMock).toHaveBeenCalledTimes(1);
    const [, input, options] = forkWorkerMock.mock.calls[0];
    expect(typeof input === 'string' ? input : input.content).toContain('检查服务状态，挂了才报警');
    expect(options).toMatchObject({
      resume: true,
      turnId: expect.stringMatching(/^schedule:task0001:/),
    });
    expect(existing.silentScheduledTurns?.has(options.turnId)).toBe(true);
  });

  it('falls back from a rejected live injection by re-forking the same registered session', async () => {
    const active = new Map<string, DaemonSession>();
    const existing = liveSession('idle');
    active.set(sessionKey(ROOT, APP), existing);
    sendWorkerInputMock.mockReturnValueOnce(false);

    await executeScheduledTask(
      baseTask({ rootMessageId: ROOT, scope: 'thread', silent: true }),
      active,
      refreshCliVersion,
    );

    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
    expect(active.get(sessionKey(ROOT, APP))).toBe(existing);
    expect(store.size).toBe(1);
    expect(forkWorkerMock).toHaveBeenCalledTimes(1);
    const [, , options] = forkWorkerMock.mock.calls[0];
    expect(options).toMatchObject({
      resume: true,
      turnId: expect.stringMatching(/^schedule:task0001:/),
    });
    expect(existing.silentScheduledTurns?.has(options.turnId)).toBe(true);
  });

  it('fails visibly instead of consuming a parked dashboard task', async () => {
    const active = new Map<string, DaemonSession>();
    const existing = liveSession('idle');
    existing.worker = null;
    existing.workerPort = null;
    existing.workerToken = null;
    existing.hasHistory = false;
    existing.session.queued = true;
    existing.session.queuedPrompt = '用户排进待办池的任务';
    active.set(sessionKey(ROOT, APP), existing);

    await expect(executeScheduledTask(
      baseTask({ rootMessageId: ROOT, scope: 'thread', silent: true }),
      active,
      refreshCliVersion,
    )).rejects.toThrow(/queued|parked|待办池/i);

    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(active.get(sessionKey(ROOT, APP))).toBe(existing);
    expect(existing.session.queued).toBe(true);
    expect(existing.session.queuedPrompt).toBe('用户排进待办池的任务');
    expect(store.size).toBe(1);
  });

  it('fails visibly instead of forking a pending repo/worktree setup', async () => {
    const active = new Map<string, DaemonSession>();
    const existing = liveSession('idle');
    existing.worker = null;
    existing.workerPort = null;
    existing.workerToken = null;
    existing.hasHistory = false;
    existing.pendingRepo = true;
    existing.worktreeCreating = true;
    existing.pendingPrompt = '等待 worktree 后执行的首轮';
    active.set(sessionKey(ROOT, APP), existing);

    await expect(executeScheduledTask(
      baseTask({ rootMessageId: ROOT, scope: 'thread', silent: true }),
      active,
      refreshCliVersion,
    )).rejects.toThrow(/pending|setup|repo|worktree/i);

    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(active.get(sessionKey(ROOT, APP))).toBe(existing);
    expect(existing.pendingRepo).toBe(true);
    expect(existing.worktreeCreating).toBe(true);
    expect(existing.pendingPrompt).toBe('等待 worktree 后执行的首轮');
  });
});

describe('executeScheduledTask — registration rejection', () => {
  it('throws after closing the rejected candidate instead of reporting a false success', async () => {
    const active = new Map<string, DaemonSession>();
    const winner: DaemonSession = {
      session: {
        sessionId: 'sess-registration-winner',
        chatId: CHAT,
        rootMessageId: 'om_banner_123',
        title: 'winner',
        status: 'active',
        createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      },
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId: APP,
      chatId: CHAT,
      chatType: 'group',
      scope: 'thread',
      spawnedAt: 0,
      cliVersion: 'test-cli-v1',
      lastMessageAt: 0,
      hasHistory: false,
      workingDir: '/tmp',
    };
    active.set(sessionKey('om_banner_123', APP), winner);

    await expect(executeScheduledTask(
      baseTask({ executionPosition: 'new-topic', silent: false }),
      active,
      refreshCliVersion,
    )).rejects.toThrow(/registration|active session|注册/i);

    expect(active.get(sessionKey('om_banner_123', APP))).toBe(winner);
    expect(forkWorkerMock).not.toHaveBeenCalled();
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

describe('executeScheduledTask — explicit position wins over a retained root', () => {
  it('loud chat-scope task posts at top level even when it retains an old topic root', async () => {
    getChatModeMock.mockResolvedValue('topic');
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ scope: 'chat', rootMessageId: ROOT }), active, refreshCliVersion);

    expect(replyMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const ds = active.get(sessionKey('om_banner_123', APP))!;
    expect(ds).toBeTruthy();
    expect(ds.scope).toBe('thread'); // topic-group top-level message is its own topic root
    expect(ds.session.rootMessageId).toBe('om_banner_123');
    expect(active.get(sessionKey(ROOT, APP))).toBeUndefined();
  });

  it('silent chat-scope task ignores the retained root and remains truly top-level/chat-scoped', async () => {
    getChatModeMock.mockResolvedValue('topic');
    const active = new Map<string, DaemonSession>();
    await executeScheduledTask(baseTask({ scope: 'chat', rootMessageId: ROOT, silent: true }), active, refreshCliVersion);

    expect(replyMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    const ds = active.get(sessionKey(CHAT, APP))!;
    expect(ds.scope).toBe('chat');
    expect(ds.silentScheduledTurns?.has(forkedTurnId())).toBe(true);
    expect(active.get(sessionKey(ROOT, APP))).toBeUndefined();
  });
});
