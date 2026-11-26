/**
 * 失效的 hook 问题卡不能吞群消息（真实 handleThreadReply 路由）。
 *
 * 现场：hook ask 登记后 CLI 被杀（hook 随之消失），daemon 重启把它恢复成 dormant，
 * 几小时后群里一条普通消息被当成这张卡的「自由回答」暂存，等一个永远不会来的 hook
 * 认领——消息没进 PTY、群里没提示。这里钉住：
 *   - 恢复后的 dormant ask（没有 hook 连着）收到文字 → 照常作为普通消息送进会话，
 *     不暂存、不动卡片；hook 到期未重连 → ask 作废，卡片改成「已失效」；
 *   - hook 正连着、正常在等回答的 ask → 文字照旧被当成答案，不进会话（老行为不变）。
 *
 * Run:  bunx vitest run test/ask-dormant-hook-text-routing.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-ask-dormant-route-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return {
    dataDir,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    getChatMode: vi.fn(async () => 'group' as const),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined) => (
      openId ? { openId, type: 'user' as const } : undefined
    )),
    updateSession: vi.fn(),
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
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return { ...actual, updateSession: mocks.updateSession };
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

import { registerBot } from '../src/bot-registry.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';
import {
  _resetForTest,
  _setHookReclaimGraceForTest,
  findPendingAskByAnchor,
  registerAsk,
  restorePersistedAsks,
  setAskPersistStore,
  setCanTalkChecker,
  setCardDispatcher,
  startHookAskReclaim,
} from '../src/core/ask-broker.js';
import { createAskPersistStore, type PersistedAsk } from '../src/core/ask-persist-store.js';
import type { AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';

const APP = 'ask_dormant_route_app';
const CHAT = 'oc_ask_dormant_route_chat';
const USER = 'ou_group_member';
const SESSION_ID = 'sess-ask-dormant-route';

let storeRoot: string;
let cards: PendingAsk[];
let settled: Array<{ ask: PendingAsk; result: AskResult }>;

function wireBroker(): void {
  setAskPersistStore(createAskPersistStore(join(storeRoot, 'asks')));
  setCanTalkChecker(() => true);
  setCardDispatcher({
    async send(ask) { cards.push(ask); return { messageId: `om_card_${cards.length}` }; },
    onSettle(ask, result) { settled.push({ ask, result }); },
  });
}

function hookAsk(): CreateAskInput {
  // Chat-scope ask: only plain messages outside other topics are candidates.
  return {
    larkAppId: APP,
    chatId: CHAT,
    rootMessageId: null,
    sessionId: SESSION_ID,
    requestId: 'hook-request-1',
    originKind: 'hook',
    backendSurvivesRestart: true,
    questions: [{ prompt: 'PPE 部署卡住了，怎么处理？', multiSelect: false,
      options: [{ key: 'retry', label: '取消后重新部署' }, { key: 'wait', label: '继续等' }] }],
    timeoutMs: 86_400_000,
  };
}

function seedChatSession(): { ds: DaemonSession; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const ds = {
    scope: 'chat',
    chatId: CHAT,
    chatType: 'group',
    larkAppId: APP,
    worker: { killed: false, send },
    workerPort: null,
    workerToken: null,
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    ownerOpenId: USER,
    session: {
      sessionId: SESSION_ID,
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'seeded',
      status: 'active',
      createdAt: new Date().toISOString(),
      larkAppId: APP,
    },
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(CHAT, APP), ds);
  return { ds, send };
}

function makeEventData(messageId: string, text: string): any {
  return {
    sender: { sender_id: { open_id: USER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(messageId: string): any {
  return { chatId: CHAT, messageId, chatType: 'group' as const, scope: 'chat' as const, anchor: CHAT, larkAppId: APP };
}

/** Every string the worker received, so multi-line content isn't JSON-escaped. */
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

function persisted(): PersistedAsk[] {
  const dir = join(storeRoot, 'asks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith('.json'))
    .map(n => JSON.parse(readFileSync(join(dir, n), 'utf-8')) as PersistedAsk);
}

/** Register a hook ask, then simulate a daemon restart that restores it from
 *  disk. The hook died with its CLI before the restart, so nobody re-attaches. */
async function restoreOrphanedHookAsk(): Promise<PendingAsk> {
  const controller = new AbortController();
  const original = registerAsk(hookAsk(), controller.signal);
  await vi.waitFor(() => expect(persisted()[0]?.cardMessageId).toBeDefined());
  controller.abort(); // the hook process is gone (its CLI was killed)
  await original;
  const card = cards[0]!;

  _resetForTest();      // daemon restart: memory gone, disk survives
  wireBroker();
  expect(restorePersistedAsks(Date.now(), APP)).toBe(1);
  return card;
}

beforeEach(() => {
  vi.clearAllMocks();
  storeRoot = mkdtempSync(join(tmpdir(), 'botmux-ask-dormant-route-'));
  cards = [];
  settled = [];
  _resetForTest();
  wireBroker();
  activeSessions.clear();
  registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [USER] })
    .resolvedAllowedUsers = [USER];
});

afterEach(() => {
  _resetForTest();
  activeSessions.clear();
  rmSync(storeRoot, { recursive: true, force: true });
});

describe('restored hook ask whose CLI already ended', () => {
  it('lets the next plain message reach the CLI instead of capturing it as the answer', async () => {
    const card = await restoreOrphanedHookAsk();
    const { send } = seedChatSession();
    const text = 'Riff 的 review 结果出来了，逐条判断要不要修。\n—— 以下是原文 ——';

    await handleThreadReply(makeEventData('om_after_restart', text), makeCtx('om_after_restart'));

    expect(workerStrings(send)).toContain('Riff 的 review 结果出来了');
    // Not stashed as an answer, card untouched until the reclaim verdict.
    expect(persisted()).toHaveLength(1);
    expect(persisted()[0]!.answeredResult).toBeUndefined();
    expect(settled).toHaveLength(0);
    expect(findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor: CHAT })).toBeUndefined();

    // The daemon starts serving; the dead hook never re-attaches → the ask is
    // invalidated and its card flips to expired.
    _setHookReclaimGraceForTest(20);
    expect(startHookAskReclaim()).toBe(1);
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    expect(settled[0]!.ask.askId).toBe(card.askId);
    expect(settled[0]!.result).toMatchObject({ kind: 'invalidated', failureCode: 'claimant_gone' });
    expect(persisted()).toHaveLength(0);
  });
});

describe('hook ask that is still waiting (unchanged behaviour)', () => {
  it('takes the plain message as its answer and does not send it to the CLI', async () => {
    const { send } = seedChatSession();
    const waiting = registerAsk(hookAsk());
    await vi.waitFor(() => expect(cards).toHaveLength(1));

    await handleThreadReply(makeEventData('om_answer', '取消后重新部署吧'), makeCtx('om_answer'));

    expect(await waiting).toMatchObject({ kind: 'answered', comment: '取消后重新部署吧' });
    expect(workerStrings(send)).not.toContain('取消后重新部署吧');
  });

  it('私聊连续会话中，回复旧消息仍可回答当前 ask；显式 /t 私聊话题与外层私聊 ask 隔离', async () => {
    const { ds, send } = seedChatSession();
    ds.chatType = 'p2p';
    const waiting = registerAsk({ ...hookAsk(), chatType: 'p2p' });
    await vi.waitFor(() => expect(cards).toHaveLength(1));

    // Explicit /t DM topic has anchor=om_dm_topic !== CHAT, so it must not steal the outer DM ask.
    const topicSeed = seedChatSession();
    topicSeed.ds.scope = 'thread';
    topicSeed.ds.chatType = 'p2p';
    topicSeed.ds.session.rootMessageId = 'om_dm_topic';
    topicSeed.ds.session.sessionId = 'sess-dm-topic';
    activeSessions.set(sessionKey('om_dm_topic', APP), topicSeed.ds);
    activeSessions.set(sessionKey(CHAT, APP), ds);
    const dmTopicEvent = makeEventData('om_dm_topic_msg', '私聊子话题消息');
    dmTopicEvent.message.chat_type = 'p2p';
    dmTopicEvent.message.root_id = 'om_dm_topic';
    dmTopicEvent.message.thread_id = 'omt_dm_topic';
    await handleThreadReply(dmTopicEvent, { ...makeCtx('om_dm_topic_msg'), chatType: 'p2p', scope: 'thread', anchor: 'om_dm_topic' });
    expect(settled).toHaveLength(0);
    expect(workerStrings(topicSeed.send)).toContain('私聊子话题消息');

    // Continuous DM reply referencing an older DM message keeps anchor=CHAT and answers the ask.
    const event = makeEventData('om_dm_answer', '继续等');
    event.message.chat_type = 'p2p';
    event.message.root_id = 'om_old_dm';
    event.message.thread_id = 'omt_old_dm';
    await handleThreadReply(event, { ...makeCtx('om_dm_answer'), chatType: 'p2p' });
    expect(settled).toHaveLength(1);
    expect(await waiting).toMatchObject({ kind: 'answered', comment: '继续等' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('群级 ask 与同群话题隔离（真实消息路由）', () => {
  function seedTopic(root: string): ReturnType<typeof seedChatSession> {
    const seeded = seedChatSession();
    activeSessions.delete(sessionKey(CHAT, APP));
    seeded.ds.scope = 'thread';
    seeded.ds.session.rootMessageId = root;
    seeded.ds.session.sessionId = 'sess-topic';
    activeSessions.set(sessionKey(root, APP), seeded.ds);
    return seeded;
  }

  function topicEvent(messageId: string, text: string, root: string): any {
    const event = makeEventData(messageId, text);
    event.message.root_id = root;
    event.message.thread_id = 'omt_topic';
    return event;
  }

  it('折叠到群会话的话题消息不结算群外层 ask', async () => {
    const { send } = seedChatSession();
    registerAsk({ ...hookAsk(), originKind: 'explicit' });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    const text = '另一个话题的工作指令';
    await handleThreadReply(topicEvent('om_folded', text, 'om_other_topic'), {
      ...makeCtx('om_folded'), replyRootId: 'om_other_topic', regularGroupTopLevel: false,
    });
    expect(settled).toHaveLength(0);
    expect(workerStrings(send)).toContain(text);
  });

  it('群外层引用回复外层 ask 卡片（带 root_id/parent_id 但无 thread_id）仍可结算外层 ask', async () => {
    const { send } = seedChatSession();
    const waiting = registerAsk({ ...hookAsk(), originKind: 'explicit' });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    const quoteEvent = makeEventData('om_quote_outer', '外层引用答复');
    quoteEvent.message.root_id = cards[0]!.cardMessageId ?? 'om_card_1';
    quoteEvent.message.parent_id = cards[0]!.cardMessageId ?? 'om_card_1';
    await handleThreadReply(quoteEvent, makeCtx('om_quote_outer'));
    expect(await waiting).toMatchObject({ kind: 'answered', comment: '外层引用答复' });
    expect(workerStrings(send)).not.toContain('外层引用答复');
  });

  it('在群外层 ask 卡片上点击「在话题中回复」（root_id=parent_id=cardMessageId 且带 thread_id）可结算该外层 ask', async () => {
    const { send } = seedChatSession();
    const waiting = registerAsk({ ...hookAsk(), originKind: 'explicit' });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    const cardMsgId = cards[0]!.cardMessageId ?? 'om_card_1';

    // Unrelated thread must still NOT steal the outer Ask.
    await handleThreadReply(topicEvent('om_other_th', '无关话题内容', 'om_other_root'), {
      ...makeCtx('om_other_th'), replyRootId: 'om_other_root',
    });
    expect(settled).toHaveLength(0);
    expect(workerStrings(send)).toContain('无关话题内容');

    // Direct in-thread reply rooted on the outer Ask card settles it.
    const inThread = topicEvent('om_reply_on_card', '直接开话题答复外层卡', cardMsgId);
    inThread.message.parent_id = cardMsgId;
    await handleThreadReply(inThread, { ...makeCtx('om_reply_on_card'), replyRootId: cardMsgId });
    expect(await waiting).toMatchObject({ kind: 'answered', comment: '直接开话题答复外层卡' });
    expect(workerStrings(send)).not.toContain('直接开话题答复外层卡');
  });

  it('chat-scope 收到带 thread_id 且 root_id 为空的原生话题首条消息时，不结算群外层 ask', async () => {
    const { send } = seedChatSession();
    registerAsk({ ...hookAsk(), originKind: 'explicit' });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    const seedEvent = makeEventData('om_native_seed', '新话题首条消息');
    seedEvent.message.thread_id = 'omt_native_seed';
    seedEvent.message.root_id = '';
    await handleThreadReply(seedEvent, { ...makeCtx('om_native_seed'), regularGroupTopLevel: true });
    expect(settled).toHaveLength(0);
    expect(workerStrings(send)).toContain('新话题首条消息');
  });

  it('无 thread_id 的 thread-scope 新线程消息与 completionProposalContinuation 不劫持群外层 ask', async () => {
    const { send: topicSend } = seedTopic('om_peer_seed');
    registerAsk({ ...hookAsk(), originKind: 'explicit' });
    await vi.waitFor(() => expect(cards).toHaveLength(1));

    // Peer-bot @mention entering handleThreadReply with scope='thread' and no thread_id.
    await handleThreadReply(makeEventData('om_peer_seed', '新线程任务'), {
      ...makeCtx('om_peer_seed'), scope: 'thread', anchor: 'om_peer_seed',
    });
    expect(settled).toHaveLength(0);
    expect(workerStrings(topicSend)).toContain('新线程任务');

    // Synthetic completionProposalContinuation without thread_id must not settle pending asks.
    const { send: chatSend } = seedChatSession();
    await handleThreadReply(makeEventData('om_proposal_turn', '继续执行下一步'), {
      ...makeCtx('om_proposal_turn'), completionProposalContinuation: true,
    });
    expect(settled).toHaveLength(0);
    expect(workerStrings(chatSend)).toContain('继续执行下一步');
  });

  it('群会话的 ask 发在话题内时，只接收同一话题的文字', async () => {
    const { send } = seedChatSession();
    const waiting = registerAsk({ ...hookAsk(), originKind: 'explicit', cardRootMessageId: 'om_ask_topic' });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    await handleThreadReply(topicEvent('om_other', '其它话题指令', 'om_other_topic'), {
      ...makeCtx('om_other'), replyRootId: 'om_other_topic',
    });
    expect(settled).toHaveLength(0);
    expect(workerStrings(send)).toContain('其它话题指令');

    await handleThreadReply(topicEvent('om_same', '同话题答案', 'om_ask_topic'), {
      ...makeCtx('om_same'), replyRootId: 'om_ask_topic',
    });
    expect(await waiting).toMatchObject({ kind: 'answered', comment: '同话题答案' });
    expect(workerStrings(send)).not.toContain('同话题答案');
  });

  it.each(['explicit', 'hook'])('%s 群级 ask 等待时，话题指令仍送到该话题的 CLI', async originKind => {
    const root = 'om_topic';
    const { send } = seedTopic(root);
    const waiting = registerAsk({ ...hookAsk(), originKind });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    const text = '请参考项目列表里的项目周期组件';
    await handleThreadReply(topicEvent('om_topic_message', text, root), {
      ...makeCtx('om_topic_message'), scope: 'thread', anchor: root, replyRootId: root,
    });

    expect(workerStrings(send)).toContain(text);
    expect(settled).toHaveLength(0);
    expect(findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor: root })).toBeUndefined();
    expect(findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor: CHAT })).toBeDefined();

    const group = seedChatSession();
    await handleThreadReply(makeEventData('om_group_answer', '继续等'), makeCtx('om_group_answer'));
    expect(await waiting).toMatchObject({ kind: 'answered', comment: '继续等' });
    expect(workerStrings(group.send)).not.toContain('继续等');
  });

  it('群级 ask 先登记时，话题回复只结算该话题的 ask', async () => {
    const root = 'om_topic';
    const { send } = seedTopic(root);
    registerAsk({ ...hookAsk(), originKind: 'explicit' });
    const topicWaiting = registerAsk({ ...hookAsk(), rootMessageId: root, sessionId: 'sess-topic',
      requestId: 'topic-request', originKind: 'explicit' });
    await vi.waitFor(() => expect(cards).toHaveLength(2));

    await handleThreadReply(topicEvent('om_topic_answer', '话题内的答案', root), {
      ...makeCtx('om_topic_answer'), scope: 'thread', anchor: root, replyRootId: root,
    });

    expect(await topicWaiting).toMatchObject({ kind: 'answered', comment: '话题内的答案' });
    expect(settled).toHaveLength(1);
    expect(settled[0]!.ask.askId).toBe(cards[1]!.askId);
    expect(findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor: CHAT })?.askId).toBe(cards[0]!.askId);
    expect(workerStrings(send)).not.toContain('话题内的答案');
  });
});
