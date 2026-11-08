/**
 * 新话题首轮的被 @ 静默回执。
 *
 * 首轮被显式 @、模型以裸 BOTMUX_NOTHING_TO_SEND 收尾时，turn_terminal 要像话题回复轮
 * 一样补发一条纯文本回执；没被 @ 的首轮只有卡片标签、不发回执。回执查的是「本轮被 @」
 * 记录，它必须挂在首轮真正交给 forkWorker 的 turnId 上——turn_terminal 带回的就是它，
 * 而会话群出生等路径里这个 turnId 并不等于入站 messageId。两条路径记录时看的都是解析后的
 * mentions（camelCase openId），所以也钉住话题回复轮按 open_id 被 @ 时同样有回执。没有默认目录的 bot
 * 首轮在选仓之后才 fork（选仓卡 commitRepoSelection、文本 /repo），这两条路上的首轮同样要有回执。
 *
 * 驱动真实的 handleNewTopic（forkWorker 换成 fake worker），再把 fake worker 接到
 * 真实的 worker-pool IPC 处理器上发 turn_terminal。机器人配置为关流式卡片：这类会话
 * 不走终态条，被 @ 的静默轮靠这条文本回执闭环。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-first-turn-receipt-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  const sessions = new Map<string, any>();
  return {
    dataDir,
    sessions,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    addReaction: vi.fn(async () => 'reaction_received'),
    getChatMode: vi.fn(async () => 'group' as const),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined) => (
      openId ? { openId, type: 'user' as const } : undefined
    )),
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => {
      const session = {
        sessionId: `sess-first-turn-${++seq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
      sessions.set(session.sessionId, session);
      return session;
    }),
    updateSession: vi.fn((session: any) => { sessions.set(session.sessionId, session); }),
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    listSessionsStrict: vi.fn(() => [...sessions.values()]),
    closeSession: vi.fn((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) session.status = 'closed';
    }),
    forkWorker: vi.fn(),
    scanMultipleProjects: vi.fn(() => [] as any[]),
    getAvailableBots: vi.fn(async () => [] as any[]),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    addReaction: mocks.addReaction,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    createSession: mocks.createSession,
    updateSession: mocks.updateSession,
    getSession: mocks.getSession,
    getOwnedSession: mocks.getSession,
    listSessionsStrict: mocks.listSessionsStrict,
    closeSession: mocks.closeSession,
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: mocks.forkWorker };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    getAvailableBots: mocks.getAvailableBots,
    downloadResources: mocks.downloadResources,
  };
});

vi.mock('../src/services/project-scanner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/project-scanner.js');
  return { ...actual, scanMultipleProjects: mocks.scanMultipleProjects };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

import { mkdirSync } from 'node:fs';
import { registerBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';
import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import { commitRepoSelection } from '../src/im/lark/card-handler.js';
import { t as tr, localeForBot } from '../src/i18n/index.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';

const APP = 'cli_first_turn_receipt';
const BOT_OPEN_ID = 'ou_first_turn_bot';
const CHAT = 'oc_first_turn_chat';
const OWNER = 'ou_first_turn_owner';

const sessionReplyMock = vi.fn(async (..._args: any[]) => 'om_receipt');
const forks: Array<{ ds: DaemonSession; turnId?: string }> = [];

function newTopicEvent(messageId: string, opts: { mentionBot: boolean }): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: CHAT,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: opts.mentionBot ? '@_user_1 看一下这条告警' : '看一下这条告警' }),
      ...(opts.mentionBot
        ? {
            mentions: [{
              key: '@_user_1',
              name: 'ReceiptBot',
              id: { open_id: BOT_OPEN_ID, union_id: 'on_first_turn_bot', user_id: '' },
              tenant_key: 'tenant',
            }],
          }
        : {}),
      create_time: String(Date.now()),
    },
  };
}

function newTopicCtx(messageId: string, extra: Record<string, unknown> = {}): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor: messageId,
    larkAppId: APP,
    ...extra,
  };
}

function silentTerminal(ds: DaemonSession, turnId: string): void {
  (ds.worker as any).emit('message', {
    type: 'turn_terminal',
    sessionId: ds.session.sessionId,
    turnId,
    status: 'completed',
    outputDisposition: 'nothing_to_send',
  });
}

function receiptTurnIds(): string[] {
  const receipt = tr('worker.silent_turn_receipt', undefined, localeForBot(APP));
  return sessionReplyMock.mock.calls
    .filter(call => call[1] === receipt)
    .map(call => String(call[4]));
}

/** Wire the single forked fake worker to the real worker-pool IPC handlers. */
function wireFirstFork(): { ds: DaemonSession; turnId: string } {
  expect(forks).toHaveLength(1);
  const { ds, turnId } = forks[0]!;
  expect(turnId).toBeTruthy();
  initWorkerPool({
    sessionReply: sessionReplyMock,
    getSessionWorkingDir: () => '/tmp',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
  __testOnly_setupWorkerHandlers(ds, ds.worker as any);
  return { ds, turnId: turnId! };
}

async function startFirstTurn(data: any, ctx: any): Promise<{ ds: DaemonSession; turnId: string }> {
  await handleNewTopic(data, ctx);
  return wireFirstFork();
}

/** Open a new topic on a bot without a default directory: the opening is
 *  staged behind the repo picker card and nothing is forked yet. */
async function stageBehindRepoPicker(messageId: string): Promise<DaemonSession> {
  mocks.scanMultipleProjects.mockReturnValue([
    { name: 'demo', path: '/tmp', type: 'repo', branch: 'main' },
  ] as any);
  await handleNewTopic(newTopicEvent(messageId, { mentionBot: true }), newTopicCtx(messageId));
  const ds = activeSessions.get(sessionKey(messageId, APP))!;
  expect(ds.pendingRepo).toBe(true);
  expect(ds.repoCardMessageId).toBeTruthy();
  expect(forks).toHaveLength(0);
  return ds;
}

describe('new-topic first turn: explicit-@ silent receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(mocks.dataDir, { recursive: true });
    mocks.sessions.clear();
    activeSessions.clear();
    forks.length = 0;
    sessionReplyMock.mockResolvedValue('om_receipt');
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.scanMultipleProjects.mockReturnValue([]);
    mocks.getAvailableBots.mockResolvedValue([]);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    mocks.forkWorker.mockImplementation((ds: any, _input: unknown, turn: any) => {
      const worker = new EventEmitter() as any;
      worker.killed = false;
      worker.send = vi.fn();
      worker.kill = vi.fn();
      worker.pid = 4242;
      worker.stdout = new EventEmitter();
      worker.stderr = new EventEmitter();
      ds.worker = worker;
      forks.push({ ds, turnId: turn ? turn.turnId : undefined });
      return true;
    });
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    bot.botOpenId = BOT_OPEN_ID;
  });

  it('posts exactly one receipt when the opening message explicitly @-mentions the bot', async () => {
    const { ds, turnId } = await startFirstTurn(
      newTopicEvent('om_first_turn_at', { mentionBot: true }),
      newTopicCtx('om_first_turn_at'),
    );

    silentTerminal(ds, turnId);

    await vi.waitFor(() => expect(receiptTurnIds()).toEqual([turnId]));
    const receiptCall = sessionReplyMock.mock.calls.find(call => call[4] === turnId)!;
    expect(receiptCall[2]).toBe('text');
    expect(String(receiptCall[1])).not.toContain('<at');

    // A dispatchAttempt replay of the same terminal must not post a second receipt.
    silentTerminal(ds, turnId);
    await new Promise(r => setTimeout(r, 20));
    expect(receiptTurnIds()).toEqual([turnId]);
  });

  it('keys the receipt on the forked turn id when it differs from the inbound message id', async () => {
    // Session-group birth re-enters with the in-group intro as the reply anchor:
    // the first turn runs as that id while messageId stays the original message.
    const { ds, turnId } = await startFirstTurn(
      newTopicEvent('om_first_turn_source', { mentionBot: true }),
      newTopicCtx('om_first_turn_source', { replyAnchorMessageId: 'om_first_turn_intro' }),
    );
    expect(turnId).toBe('om_first_turn_intro');

    silentTerminal(ds, 'om_first_turn_source');
    silentTerminal(ds, turnId);

    await vi.waitFor(() => expect(receiptTurnIds()).toContain(turnId));
    await new Promise(r => setTimeout(r, 20));
    expect(receiptTurnIds()).toEqual([turnId]);
  });

  it('posts no receipt for a silent first turn that did not @-mention the bot', async () => {
    const { ds, turnId } = await startFirstTurn(
      newTopicEvent('om_first_turn_plain', { mentionBot: false }),
      newTopicCtx('om_first_turn_plain'),
    );

    silentTerminal(ds, turnId);

    await vi.waitFor(() => expect(ds.silentIdleTurnId).toBe(turnId));
    await new Promise(r => setTimeout(r, 20));
    expect(receiptTurnIds()).toEqual([]);
  });

  it('a later thread reply that @-mentions the bot by open_id gets the same receipt', async () => {
    const { ds } = await startFirstTurn(
      newTopicEvent('om_thread_root', { mentionBot: false }),
      newTopicCtx('om_thread_root'),
    );
    ds.cliReady = true;
    ds.hasHistory = true;
    const reply = newTopicEvent('om_thread_reply_at', { mentionBot: true });
    reply.message.root_id = 'om_thread_root';
    await handleThreadReply(reply, newTopicCtx('om_thread_reply_at', { anchor: 'om_thread_root' }));
    expect((ds.worker as any).send).toHaveBeenCalled();

    silentTerminal(ds, 'om_thread_reply_at');

    await vi.waitFor(() => expect(receiptTurnIds()).toEqual(['om_thread_reply_at']));
  });

  it('repo picker card: the first turn forked after the selection posts the receipt', async () => {
    const ds = await stageBehindRepoPicker('om_picker_at');

    const started = await commitRepoSelection({
      ds,
      rootId: 'om_picker_at',
      cardMessageId: ds.repoCardMessageId,
      larkAppId: APP,
      activeSessions,
      sessionReply: vi.fn(async () => 'om_confirm'),
    }, '/tmp', 'demo');
    expect(started).toBe(true);
    const { turnId } = wireFirstFork();
    expect(turnId).toBe('om_picker_at');

    silentTerminal(ds, turnId);

    await vi.waitFor(() => expect(receiptTurnIds()).toEqual([turnId]));
  });

  it('text /repo <n>: the first turn forked by the command posts the receipt for the opening', async () => {
    const ds = await stageBehindRepoPicker('om_repo_cmd_at');
    // The /repo message itself does not @ the bot: the receipt is owed by the
    // opening message it unblocks.
    const repoCmd = newTopicEvent('om_repo_cmd_msg', { mentionBot: false });
    repoCmd.message.content = JSON.stringify({ text: '/repo 1' });
    repoCmd.message.root_id = 'om_repo_cmd_at';
    await handleThreadReply(repoCmd, newTopicCtx('om_repo_cmd_msg', { anchor: 'om_repo_cmd_at' }));
    const { turnId } = wireFirstFork();
    expect(turnId).toBe('om_repo_cmd_at');

    silentTerminal(ds, turnId);

    await vi.waitFor(() => expect(receiptTurnIds()).toEqual([turnId]));
  });
});
