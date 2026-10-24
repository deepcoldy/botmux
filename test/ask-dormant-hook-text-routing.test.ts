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
  // Chat-scope session (the incident's shape): the ask anchors the whole chat,
  // so every plain message in it is a text-answer candidate.
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
});
