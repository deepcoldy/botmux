/**
 * 隔离全栈端到端实测：真实 SQLite SessionStore + 真实 JSON AskPersistStore +
 * 真实 ExplicitAskContinuation + 真实 TurnReplyCardStore + 真实 Lark Ask 发卡器 +
 * 真实 daemon.handleThreadReply，覆盖话题文字隔离、内嵌回复卡无 messageId 首发对齐、
 * 新旧持久化重启恢复兼容及私聊连续会话零回归。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-ask-e2e-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return {
    dataDir,
    replyMessage: vi.fn(async (_app: string, _root: string) => `om_reply_card_${Date.now()}`),
    sendMessage: vi.fn(async (_app: string, _chat: string) => `om_outer_card_${Date.now()}`),
    updateMessage: vi.fn(async () => undefined),
    uploadFile: vi.fn(async () => 'file_key_e2e'),
    getChatMode: vi.fn(async () => 'group' as const),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined) => (
      openId ? { openId, type: 'user' as const } : undefined
    )),
    forkWorker: vi.fn(),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    updateMessage: mocks.updateMessage,
    uploadFile: mocks.uploadFile,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
  };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: (...args: any[]) => mocks.forkWorker(...args) };
});

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from '../src/config.js';
import { registerBot } from '../src/bot-registry.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';
import {
  _allAskIds,
  _resetForTest,
  findPendingAskByAnchor,
  getAskSnapshot,
  hasExplicitAskHandoff,
  listPendingAsksByAnchor,
  registerAsk,
  registerHostAsk,
  releaseExplicitAskHandoff,
  restorePersistedAsks,
  setAskPersistStore,
  setCanTalkChecker,
  setCardDispatcher,
  toggleAsk,
} from '../src/core/ask-broker.js';
import { askKeyFor, createAskPersistStore, type PersistedAsk } from '../src/core/ask-persist-store.js';
import { createExplicitAskContinuation } from '../src/core/explicit-ask-continuation.js';
import { replyCardAskTarget } from '../src/core/turn-reply-ask.js';
import { frozenReplyContextForTurn } from '../src/core/reply-target.js';
import { createLarkAskCardDispatcher } from '../src/im/lark/ask-card.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import * as sessionStore from '../src/services/session-store.js';
import type { CreateAskInput } from '../src/core/ask-types.js';
import type { Session } from '../src/types.js';

const APP = 'cli_e2e_ask_iso';
const CHAT = 'oc_e2e_group';
const DM_CHAT = 'oc_e2e_dm';
const USER = 'ou_e2e_owner';

const OPTIONS = [
  { key: 'yes', label: '继续' },
  { key: 'no', label: '取消' },
];

let dir: string;
let prevDataDir: string;
let cardSeq = 0;

function workerStrings(send: ReturnType<typeof vi.fn>): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(send.mock.calls);
  return out.join('\n');
}

function wireRuntime(): {
  askStore: ReturnType<typeof createAskPersistStore>;
  continuation: ReturnType<typeof createExplicitAskContinuation>;
} {
  const askStore = createAskPersistStore(join(dir, 'asks'));
  setAskPersistStore(askStore);
  setCanTalkChecker(() => true);
  setCardDispatcher(createLarkAskCardDispatcher());
  const continuation = createExplicitAskContinuation({
    dir: join(dir, 'explicit-ask-receipts'),
    appId: APP,
    register: registerHostAsk,
    hasHandoff: hasExplicitAskHandoff,
    releaseHandoff: releaseExplicitAskHandoff,
    canResume: () => true,
    dispatch: async () => false,
    onError: err => { throw err; },
  });
  return { askStore, continuation };
}

function hydrateSessionIntoDaemon(
  persisted: Session,
  chatType: 'group' | 'p2p' = 'group',
): { ds: DaemonSession; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const scope = persisted.scope === 'chat' ? 'chat' : 'thread';
  const anchor = scope === 'chat' ? persisted.chatId : persisted.rootMessageId;
  const ds = {
    scope,
    chatId: persisted.chatId,
    chatType,
    larkAppId: APP,
    worker: { killed: false, send },
    workerPort: null,
    workerToken: null,
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    ownerOpenId: USER,
    session: persisted,
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(anchor, APP), ds);
  return { ds, send };
}

function makeGroupMessage(messageId: string, text: string, opts: { rootId?: string; threadId?: string; parentId?: string; chatId?: string; chatType?: 'group' | 'p2p' } = {}): any {
  return {
    sender: { sender_id: { open_id: USER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: opts.chatId ?? CHAT,
      chat_type: opts.chatType ?? 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
      ...(opts.rootId !== undefined ? { root_id: opts.rootId } : {}),
      ...(opts.threadId !== undefined ? { thread_id: opts.threadId } : {}),
      ...(opts.parentId !== undefined ? { parent_id: opts.parentId } : {}),
    },
  };
}

function readAllPersistedAsks(): PersistedAsk[] {
  const asksDir = join(dir, 'asks');
  if (!existsSync(asksDir)) return [];
  return readdirSync(asksDir)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(asksDir, name), 'utf8')) as PersistedAsk);
}

describe('Ask 原始话题文字隔离 + SQLite/JSON 重启恢复全栈 E2E', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cardSeq = 0;
    dir = mkdtempSync(join(tmpdir(), 'botmux-ask-full-e2e-'));
    prevDataDir = config.session.dataDir;
    config.session.dataDir = dir;
    mocks.replyMessage.mockImplementation(async () => `om_reply_card_${++cardSeq}`);
    mocks.sendMessage.mockImplementation(async () => `om_outer_card_${++cardSeq}`);
    _resetForTest();
    activeSessions.clear();
    registerBot({ larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: [USER] })
      .resolvedAllowedUsers = [USER];
    sessionStore.init(APP);
  });

  afterEach(() => {
    _resetForTest();
    activeSessions.clear();
    config.session.dataDir = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('1+2. 群外层 Ask 不抢话题 A 文字；话题 A 内 Ask 仅收话题 A 文字', async () => {
    wireRuntime();
    const outerSession = sessionStore.createSession(CHAT, CHAT, '外层会话', 'group', 'chat');
    const topicASession = sessionStore.createSession(CHAT, 'om_topic_a', '话题A会话', 'group', 'thread');
    const outer = hydrateSessionIntoDaemon(outerSession);
    const topicA = hydrateSessionIntoDaemon(topicASession);

    // Register outer-chat Ask
    const outerAsk = registerAsk({
      larkAppId: APP, chatId: CHAT, rootMessageId: null, sessionId: outerSession.sessionId,
      requestId: 'e2e-outer-1', originKind: 'hook', backendSurvivesRestart: true,
      questions: [{ prompt: '群外层确认？', options: OPTIONS, multiSelect: false }], timeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));

    // Topic A sends text while outer Ask is pending -> MUST reach Topic A CLI, NOT settle outer Ask
    await handleThreadReply(
      makeGroupMessage('om_msg_a1', '话题A的工作消息', { rootId: 'om_topic_a', threadId: 'omt_a' }),
      { larkAppId: APP, chatId: CHAT, chatType: 'group', messageId: 'om_msg_a1', scope: 'thread', anchor: 'om_topic_a', replyRootId: 'om_topic_a' },
    );
    expect(workerStrings(topicA.send)).toContain('话题A的工作消息');
    expect(findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor: CHAT, messageRootId: null })).toBeDefined();

    // Register Topic A Ask while outer Ask is STILL pending
    const topicAAsk = registerAsk({
      larkAppId: APP, chatId: CHAT, rootMessageId: 'om_topic_a', sessionId: topicASession.sessionId,
      requestId: 'e2e-topic-a-1', originKind: 'hook', backendSurvivesRestart: true,
      questions: [{ prompt: '话题A确认？', options: OPTIONS, multiSelect: false }], timeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(mocks.replyMessage).toHaveBeenCalledTimes(1));

    // Topic B folded into outer chat session -> MUST reach outer CLI, neither Ask settles
    await handleThreadReply(
      makeGroupMessage('om_msg_b1', '话题B折叠消息', { rootId: 'om_topic_b', threadId: 'omt_b' }),
      { larkAppId: APP, chatId: CHAT, chatType: 'group', messageId: 'om_msg_b1', scope: 'chat', anchor: CHAT, replyRootId: 'om_topic_b' },
    );
    expect(workerStrings(outer.send)).toContain('话题B折叠消息');

    // Topic A reply settles ONLY Topic A Ask
    await handleThreadReply(
      makeGroupMessage('om_msg_a2', '话题A的答案', { rootId: 'om_topic_a', threadId: 'omt_a' }),
      { larkAppId: APP, chatId: CHAT, chatType: 'group', messageId: 'om_msg_a2', scope: 'thread', anchor: 'om_topic_a', replyRootId: 'om_topic_a' },
    );
    expect(await topicAAsk).toMatchObject({ kind: 'answered', comment: '话题A的答案' });
    expect(workerStrings(topicA.send)).not.toContain('话题A的答案');

    // Outer-chat reply settles outer Ask
    await handleThreadReply(
      makeGroupMessage('om_msg_outer', '群外层的答案'),
      { larkAppId: APP, chatId: CHAT, chatType: 'group', messageId: 'om_msg_outer', scope: 'chat', anchor: CHAT },
    );
    expect(await outerAsk).toMatchObject({ kind: 'answered', comment: '群外层的答案' });
    expect(workerStrings(outer.send)).not.toContain('群外层的答案');
  });

  it('3. 内嵌回复卡尚无 messageId（native CoT 抑制）时首发落点与文字捕获区同在冻结话题', async () => {
    wireRuntime();
    const turnId = 'om_turn_inline_e2e';
    const topicRoot = 'om_inline_topic_a';
    const session = sessionStore.createSession(CHAT, CHAT, '共享群会话', 'group', 'chat');
    session.turnReplyContexts = { [turnId]: { target: { mode: 'thread', rootMessageId: topicRoot } } };
    sessionStore.updateSession(session);
    const { ds, send } = hydrateSessionIntoDaemon(session);
    ds.replyCardRunningTurnId = turnId;

    const replyStore = new TurnReplyCardStore(dir);
    const cardKey = { larkAppId: APP, sessionId: session.sessionId, turnId };
    await replyStore.prepare(cardKey, { mode: 'unified', chatId: CHAT, rootId: CHAT, nativeCot: true });
    const startRes = await replyStore.update(cardKey, { kind: 'start' }, {
      beforeEffect: () => {}, isWithdrawn: () => false,
      beforeCreate: () => true, nativeThinkingLive: () => true,
      render: rec => buildTurnReplyCard(rec, { showProcess: true, showToolResults: true, canStop: false }),
      send: async () => 'om_never', patch: async () => {},
    });
    expect(startRes.delivered).toBe(false);
    expect(replyStore.read(cardKey)?.messageId).toBeUndefined();

    const frozenTarget = frozenReplyContextForTurn(ds, turnId).target;
    expect(frozenTarget).toEqual({ mode: 'thread', rootMessageId: topicRoot });

    const baseInput: CreateAskInput = {
      larkAppId: APP, chatId: CHAT, rootMessageId: null, cardRootMessageId: topicRoot,
      sessionId: session.sessionId, requestId: 'e2e-inline-1', originKind: 'hook', backendSurvivesRestart: true,
      questions: [{ prompt: '内嵌确认？', allowCustom: false, multiSelect: false, options: OPTIONS }],
      timeoutMs: 60_000,
    };
    const replyCardTarget = replyCardAskTarget(ds, baseInput, { originTurnId: turnId });
    expect(replyCardTarget).toEqual({ turnId });

    const waiting = registerAsk({ ...baseInput, replyCardTarget });
    const askId = _allAskIds().at(-1)!;
    await vi.waitFor(() => expect(getAskSnapshot(askId)?.cardMessageId).toBeDefined());

    // Card MUST be sent into topicRoot via replyMessage, NOT outer chat via sendMessage.
    expect(mocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(mocks.replyMessage.mock.calls[0]?.[1]).toBe(topicRoot);
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    // Outer chat text goes to CLI (not captured)
    await handleThreadReply(
      makeGroupMessage('om_outer_noise', '群外层普通讨论'),
      { larkAppId: APP, chatId: CHAT, chatType: 'group', messageId: 'om_outer_noise', scope: 'chat', anchor: CHAT },
    );
    expect(workerStrings(send)).toContain('群外层普通讨论');

    // Topic A text settles the inline Ask
    await handleThreadReply(
      makeGroupMessage('om_inline_ans', '话题内文字确认', { rootId: topicRoot, threadId: 'omt_inline' }),
      { larkAppId: APP, chatId: CHAT, chatType: 'group', messageId: 'om_inline_ans', scope: 'chat', anchor: CHAT, replyRootId: topicRoot },
    );
    expect(await waiting).toMatchObject({ kind: 'answered', comment: '话题内文字确认' });
    expect(workerStrings(send)).not.toContain('话题内文字确认');
  });

  it('4+5. 真实 SQLite 会话 + JSON Ask/回执重启：旧版记录升级兼容，新版群外层 Ask 重启后仍严格隔离', async () => {
    const first = wireRuntime();
    const outerSession = sessionStore.createSession(CHAT, CHAT, '共享群外层会话', 'group', 'chat');
    const topicASession = sessionStore.createSession(CHAT, 'om_topic_a', '话题A独立会话', 'group', 'thread');
    expect(existsSync(join(sessionStore.sessionStoreSqliteDir(APP, dir), 'sessions.db'))).toBe(true);

    // A) Create NEW outer-chat host_explicit Ask (persisted with topicIsolated: true)
    const newOuterInput: CreateAskInput & { requestId: string } = {
      larkAppId: APP, chatId: CHAT, rootMessageId: null, sessionId: outerSession.sessionId,
      requestId: 'e2e-new-outer-exp', originKind: 'host_explicit',
      questions: [{ prompt: '新版外层显式确认？', options: OPTIONS, multiSelect: true }],
      timeoutMs: 60_000,
    };
    void first.continuation.wait(newOuterInput);
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    expect(readAllPersistedAsks()).toEqual([expect.objectContaining({
      requestId: 'e2e-new-outer-exp',
      topicIsolated: true,
    })]);
    expect(readAllPersistedAsks()[0]!.cardRootMessageId).toBeUndefined();

    // B) Seed a LEGACY pre-upgrade v2 host_explicit record (no topicIsolated, no cardRootMessageId) on another chat
    const LEGACY_CHAT = 'oc_e2e_legacy_group';
    const legacySession = sessionStore.createSession(LEGACY_CHAT, LEGACY_CHAT, '旧版升级前会话', 'group', 'chat');
    const now = Date.now();
    const legacyReqId = 'e2e-legacy-exp';
    first.askStore.put({
      v: 2,
      askKey: askKeyFor(APP, legacySession.sessionId, 'host_explicit', legacyReqId),
      requestId: legacyReqId,
      originKind: 'host_explicit',
      askId: 'ask-e2e-legacy-exp',
      nonce: 'n_legacy_e2e',
      larkAppId: APP,
      chatId: LEGACY_CHAT,
      rootMessageId: null,
      sessionId: legacySession.sessionId,
      chatType: 'group',
      questions: [{ prompt: '升级前在途确认？', options: OPTIONS, multiSelect: true }],
      createdAt: now - 1000,
      deadlineAt: now + 60_000,
      timeoutMs: 60_000,
      timeoutStartsAfterDelivery: true,
      timeoutStartedAt: now - 900,
      cardMessageId: 'om_legacy_card',
      selections: [[]],
    });

    // === SIMULATE DAEMON RESTART: wipe broker & activeSessions, reopen SQLite & JSON stores ===
    _resetForTest();
    activeSessions.clear();
    sessionStore.init(APP);
    const second = wireRuntime();
    expect(restorePersistedAsks(now, APP)).toBe(2);

    const reloadedOuter = sessionStore.getSession(outerSession.sessionId)!;
    const reloadedTopicA = sessionStore.getSession(topicASession.sessionId)!;
    const reloadedLegacy = sessionStore.getSession(legacySession.sessionId)!;
    expect(reloadedOuter.scope).toBe('chat');
    expect(reloadedTopicA.rootMessageId).toBe('om_topic_a');
    expect(reloadedLegacy.scope).toBe('chat');

    const outerRuntime = hydrateSessionIntoDaemon(reloadedOuter);
    const topicARuntime = hydrateSessionIntoDaemon(reloadedTopicA);
    const legacyRuntime = hydrateSessionIntoDaemon(reloadedLegacy);

    // 5. NEW outer-chat Ask after restart (even BEFORE sweep/reattach): Topic A text MUST NOT be stolen!
    await handleThreadReply(
      makeGroupMessage('om_post_restart_a', '重启后话题A正常消息', { rootId: 'om_topic_a', threadId: 'omt_a' }),
      { larkAppId: APP, chatId: CHAT, chatType: 'group', messageId: 'om_post_restart_a', scope: 'thread', anchor: 'om_topic_a', replyRootId: 'om_topic_a' },
    );
    expect(workerStrings(topicARuntime.send)).toContain('重启后话题A正常消息');

    // Run sweep (reattaches host_explicit without presentation) -> still strictly isolated
    await second.continuation.sweep();
    expect(listPendingAsksByAnchor({ larkAppId: APP, chatId: CHAT, anchor: CHAT, messageRootId: 'om_topic_a' })).toEqual([]);
    expect(findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor: CHAT, messageRootId: null })).toBeDefined();

    // Outer-chat text settles the restored NEW outer-chat Ask and releases its broker handoff
    await handleThreadReply(
      makeGroupMessage('om_post_restart_outer', '重启后群外层答复'),
      { larkAppId: APP, chatId: CHAT, chatType: 'group', messageId: 'om_post_restart_outer', scope: 'chat', anchor: CHAT },
    );
    expect(workerStrings(outerRuntime.send)).not.toContain('重启后群外层答复');
    expect(findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor: CHAT, messageRootId: null })).toBeUndefined();
    await vi.waitFor(() => expect(readAllPersistedAsks().some(p => p.requestId === 'e2e-new-outer-exp')).toBe(false));

    // 4. LEGACY pre-upgrade v2 host_explicit (NO reattach performed): toggle re-persist + 2nd restart + topic answer still works!
    expect(toggleAsk({ askId: 'ask-e2e-legacy-exp', nonce: 'n_legacy_e2e', questionIndex: 0, key: 'yes', by: USER })).toBe('toggled');
    expect(readAllPersistedAsks().find(p => p.askId === 'ask-e2e-legacy-exp')?.topicIsolated).toBeUndefined();

    // 2nd restart
    _resetForTest();
    activeSessions.clear();
    sessionStore.init(APP);
    wireRuntime();
    expect(restorePersistedAsks(now, APP)).toBe(1);
    const legacyRuntimeAfterRestart2 = hydrateSessionIntoDaemon(sessionStore.getSession(legacySession.sessionId)!);

    // Legacy topic text reply settles the legacy Ask without reattach!
    await handleThreadReply(
      makeGroupMessage('om_legacy_topic_ans', '旧记录原话题答复', { chatId: LEGACY_CHAT, rootId: 'om_legacy_topic', threadId: 'omt_legacy' }),
      { larkAppId: APP, chatId: LEGACY_CHAT, chatType: 'group', messageId: 'om_legacy_topic_ans', scope: 'chat', anchor: LEGACY_CHAT, replyRootId: 'om_legacy_topic' },
    );
    expect(workerStrings(legacyRuntimeAfterRestart2.send)).not.toContain('旧记录原话题答复');
    const stashedLegacy = readAllPersistedAsks().find(p => p.askId === 'ask-e2e-legacy-exp');
    expect(stashedLegacy?.topicIsolated).toBeUndefined();
    expect(stashedLegacy?.answeredResult).toMatchObject({ kind: 'answered', comment: '旧记录原话题答复' });
  });

  it('6. 私聊连续会话语义零回归（引用/回复旧私聊消息仍结算当前 Ask，显式 /t 子话题保持隔离）', async () => {
    wireRuntime();
    const dmSession = sessionStore.createSession(DM_CHAT, DM_CHAT, '私聊主会话', 'p2p', 'chat');
    const dmTopicSession = sessionStore.createSession(DM_CHAT, 'om_dm_sub', '私聊子话题', 'p2p', 'thread');
    const dmMain = hydrateSessionIntoDaemon(dmSession, 'p2p');
    const dmSub = hydrateSessionIntoDaemon(dmTopicSession, 'p2p');

    const dmWaiting = registerAsk({
      larkAppId: APP, chatId: DM_CHAT, rootMessageId: null, sessionId: dmSession.sessionId,
      chatType: 'p2p', requestId: 'e2e-dm-1', originKind: 'hook', backendSurvivesRestart: true,
      questions: [{ prompt: '私聊确认？', options: OPTIONS, multiSelect: false }], timeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));

    // Explicit /t subtopic inside DM must NOT settle outer DM Ask
    await handleThreadReply(
      makeGroupMessage('om_dm_sub_msg', '子话题独立消息', { chatId: DM_CHAT, chatType: 'p2p', rootId: 'om_dm_sub', threadId: 'omt_dm_sub' }),
      { larkAppId: APP, chatId: DM_CHAT, chatType: 'p2p', messageId: 'om_dm_sub_msg', scope: 'thread', anchor: 'om_dm_sub' },
    );
    expect(workerStrings(dmSub.send)).toContain('子话题独立消息');

    // Continuous DM reply referencing an older DM message MUST settle DM Ask
    await handleThreadReply(
      makeGroupMessage('om_dm_reply', '私聊继续', { chatId: DM_CHAT, chatType: 'p2p', rootId: 'om_dm_old', threadId: 'omt_dm_old' }),
      { larkAppId: APP, chatId: DM_CHAT, chatType: 'p2p', messageId: 'om_dm_reply', scope: 'chat', anchor: DM_CHAT },
    );
    expect(await dmWaiting).toMatchObject({ kind: 'answered', comment: '私聊继续' });
    expect(workerStrings(dmMain.send)).not.toContain('私聊继续');
  });
});
