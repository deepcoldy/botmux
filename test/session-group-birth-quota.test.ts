/**
 * 会话群出生轮的硬不变量：**扣了费就不能丢任务，丢任务就不能扣费**（评审 P1-15）。
 *
 * p2pMode='group' 下，私聊里的顶层消息会先被改道：daemon 在**建群之前**先扣一次
 * 额度（扣费被拒必须零外部副作用），再真的建飞书群，然后把本轮 context 重写到新群
 * 递归回 handleNewTopic。这条链路上曾有两个净额度损失：
 *
 *  1. chatGrant（按 chat 授权）用户：DM 上扣费通过 → 建群 → 递归到新群后，第二道
 *     talk 复查拿**新群**的 chatId 重新判定，chatGrant 不跨 chat → 静默丢弃。
 *     用户额度少一格、任务凭空消失、连拒绝提示都没有。
 *  2. `@Bot /help`：建群前的斜杠命令判定读的是**未剥 mention** 的原文，
 *     "@Bot /help" 不以 "/" 开头 → 当成普通消息预扣一次费并建群；而路由随后读的是
 *     剥掉 @ 前缀的文本，仍按 /help 命令处理，根本不进 CLI。
 *
 * 两条用例都跑**真实的建群递归**（只把 createGroupWithBots 这一个飞书外部副作用
 * 换成替身），额度用**真实 grant-store**（真扣真持久化），断言「扣费次数」与
 * 「任务是否落地（forkWorker）」始终一致。
 *
 * Run:  pnpm vitest run test/session-group-birth-quota.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-sg-quota-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    dataDir,
    // 唯一被替身掉的建群外部副作用：真身会调飞书 chat.create。返回形状与
    // CreateGroupResult 一致，birth 的其余步骤（登记会话群、群内 intro、私聊回执、
    // 重写 RoutingContext、递归）全部跑真身。
    createGroupWithBots: vi.fn(),
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_intro'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId?: string) => (
      openId ? { openId, type: 'user' as const } : undefined
    )),
    forkWorker: vi.fn(),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
    scheduleSessionGroupTitle: vi.fn(),
    createdSessions: [] as any[],
    createSession: vi.fn(function (chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') {
      const session = {
        sessionId: `sess-quota-${++seq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
      mocks.createdSessions.push(session);
      return session;
    }),
    updateSession: vi.fn(),
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

vi.mock('../src/services/group-creator.js', async () => {
  const actual = await vi.importActual<any>('../src/services/group-creator.js');
  return { ...actual, createGroupWithBots: (...args: any[]) => mocks.createGroupWithBots(...args) };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
    getChatInfo: vi.fn(async () => ({ userCount: 1, botCount: 1 })),
    listChatBotMembers: vi.fn(async () => []),
    resolveAllowedUsersWithMap: vi.fn(async (_appId: string, users: string[]) => ({ resolved: users, map: new Map() })),
    sendUserMessage: vi.fn(async () => 'om_dm'),
    updateMessage: vi.fn(async () => undefined),
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return { ...actual, createSession: mocks.createSession, updateSession: mocks.updateSession };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: (...args: any[]) => mocks.forkWorker(...args) };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return { ...actual, downloadResources: (...args: any[]) => mocks.downloadResources(...args) };
});

vi.mock('../src/services/session-group-title.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-group-title.js');
  return { ...actual, scheduleSessionGroupTitle: (...args: any[]) => mocks.scheduleSessionGroupTitle(...args) };
});

import { loadBotConfigs, registerBot, getBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
} from '../src/daemon.js';
import { addChatGrant, chatQuotaKey } from '../src/services/grant-store.js';
import { initSessionGroups, isSessionGroup } from '../src/services/session-groups-store.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

const APP = 'sg_quota_app';
const DM_CHAT = 'oc_dm_with_grantee';
const BORN_GROUP = 'oc_born_session_group';
const OWNER = 'ou_owner';
const GRANTEE = 'ou_chat_grantee';
const BOT_NAME = '会话机器人';
const QUOTA_LIMIT = 3;

function botConfig(workDir: string): any {
  return {
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    p2pMode: 'group',
    workingDir: workDir,
    defaultWorkingDir: workDir,
    // 授权用户免额度，测不到扣费；受测用户只有 DM 上的 chatGrant。
    allowedUsers: [OWNER],
    // 把 /help 降到 canTalk，否则 grant-only 用户会先被 canRunDaemonCommand 拦掉，
    // 「命令不预扣费」这一半就测不出来。
    canTalkDaemonCommands: ['/help'],
    // 群标签 / 群头像是 birth 的 fire-and-forget 装饰步骤，与本用例无关且要联网。
    sessionGroup: { tag: { mode: 'off' }, avatar: 'off' },
  };
}

/** 顶层私聊消息（建群种子形状：thread scope + anchor === messageId + 无 thread_id）。 */
function dmEvent(text: string, messageId: string, withBotMention = false): any {
  const content = withBotMention
    ? JSON.stringify({ text: `@_user_1 ${text}` })
    : JSON.stringify({ text });
  return {
    sender: { sender_id: { open_id: GRANTEE, union_id: 'on_grantee' }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: DM_CHAT,
      chat_type: 'p2p',
      message_type: 'text',
      content,
      create_time: String(Date.now()),
      ...(withBotMention
        ? { mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_self' }, name: BOT_NAME, tenant_key: 'tk' }] }
        : {}),
    },
  };
}

function dmCtx(messageId: string): RoutingContext {
  return {
    chatId: DM_CHAT,
    messageId,
    chatType: 'p2p',
    scope: 'thread',
    anchor: messageId,
    larkAppId: APP,
  };
}

/** 真实 grant-store 里这个 chatGrant 已经被扣掉几次（不是 mock 计数）。 */
function chargedUnits(): number {
  return getBot(APP).config.quotaState?.[chatQuotaKey(DM_CHAT, GRANTEE)]?.used ?? 0;
}

/** 任务真的落地了吗——落地 = 新群里拉起了 CLI worker。 */
function landedTurns(): any[] {
  return mocks.forkWorker.mock.calls;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mkdirSync(mocks.dataDir, { recursive: true });
  const workDir = join(mocks.dataDir, 'workdir');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([botConfig(workDir)]));
  // 走真实加载路径：grant-store 的持久化要求 registry 记下「我加载的是哪个
  // bots.json」，直接 registerBot 是拿不到这个来源的。
  loadBotConfigs().forEach(cfg => registerBot(cfg));
  const bot = getBot(APP);
  bot.resolvedAllowedUsers = [OWNER];
  delete bot.config.chatGrants;
  delete bot.config.quotaState;
  delete bot.config.grantExpiryState;
  // 真实授权写入（磁盘 + 内存），带额度 → 有 quotaKey，扣费可观测。
  await addChatGrant(APP, DM_CHAT, GRANTEE, QUOTA_LIMIT);
  initSessionGroups(APP);
  activeSessions.clear();
  mocks.createdSessions.length = 0;
  mocks.replyMessage.mockResolvedValue('om_reply');
  mocks.sendMessage.mockResolvedValue('om_intro');
  mocks.getChatMode.mockResolvedValue('group');
  mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
  mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
  mocks.resolveSender.mockImplementation(async (_appId: string, openId?: string) => (
    openId ? { openId, type: 'user' as const } : undefined
  ));
  mocks.createGroupWithBots.mockResolvedValue({
    ok: true,
    chatId: BORN_GROUP,
    creator: APP,
    invalidBotIds: [],
    invalidUserIds: [],
    invalidOwnerUnionIds: [],
    ownerTransferredTo: null,
    transferError: null,
    notifyMessageId: null,
    notifyError: null,
    shareLink: null,
    shareLinkError: null,
    oncallBindings: [],
    roleProfileBootstrapMessageId: null,
    roleProfileBootstrapError: null,
    kickoffMessageId: null,
    kickoffError: null,
  });
});

describe('会话群出生：扣费与任务落地必须一致', () => {
  it('chatGrant 用户：扣了 1 次费，任务就必须落在新建的会话群里（不能被第二次 talk 复查静默丢）', async () => {
    await handleNewTopic(dmEvent('帮我看下登录接口报 500', 'om_grant_task'), dmCtx('om_grant_task'));

    // 真的建了群、真的递归进新群（不是 mock 掉整条 birth）。
    expect(mocks.createGroupWithBots).toHaveBeenCalledTimes(1);
    expect(isSessionGroup(BORN_GROUP)).toBe(true);

    // 不变量：扣费次数 === 落地任务数。
    expect(chargedUnits()).toBe(1);
    expect(landedTurns()).toHaveLength(1);
    const [ds] = landedTurns()[0];
    expect(ds.chatId).toBe(BORN_GROUP);
    expect(mocks.createdSessions).toHaveLength(1);
    expect(mocks.createdSessions[0].chatId).toBe(BORN_GROUP);
  });

  it('额度耗尽：不扣费也不建群，任务被拒但零外部副作用（不变量的另一半）', async () => {
    // 真实把额度用光：把授权改成 limit=1，第一条正常扣费+落地。
    await addChatGrant(APP, DM_CHAT, GRANTEE, 1);
    await handleNewTopic(dmEvent('第一条任务', 'om_quota_first'), dmCtx('om_quota_first'));
    expect(chargedUnits()).toBe(1);
    expect(mocks.createGroupWithBots).toHaveBeenCalledTimes(1);
    expect(landedTurns()).toHaveLength(1);

    // 只统计第二条（mockClear 只清调用记录，保留返回值实现）。
    vi.clearAllMocks();
    await handleNewTopic(dmEvent('再帮我看一个', 'om_quota_denied'), dmCtx('om_quota_denied'));

    // 被额度拒 → 不建群（零外部副作用）、不落地任务；用户收到「额度已用完」卡。
    expect(mocks.createGroupWithBots).not.toHaveBeenCalled();
    expect(landedTurns()).toHaveLength(0);
    expect(mocks.replyMessage.mock.calls.some((c: any[]) => c[3] === 'interactive')).toBe(true);
  });
});

describe('会话群出生：斜杠命令判定必须先剥 @mention 前缀', () => {
  it('`@Bot /help` 不预扣额度、不建群，命令照常执行', async () => {
    await handleNewTopic(dmEvent('/help', 'om_mention_help', true), dmCtx('om_mention_help'));

    expect(chargedUnits()).toBe(0);
    expect(mocks.createGroupWithBots).not.toHaveBeenCalled();
    // 命令确实被执行了（回了内容），不是被静默吞掉。
    expect(mocks.replyMessage).toHaveBeenCalled();
    expect(landedTurns()).toHaveLength(0);
  });

  it('额度耗尽时 `@Bot /help` 依然能执行（命令根本不该受这道闸约束）', async () => {
    getBot(APP).config.quotaState![chatQuotaKey(DM_CHAT, GRANTEE)] = { limit: QUOTA_LIMIT, used: QUOTA_LIMIT };

    await handleNewTopic(dmEvent('/help', 'om_mention_help_exhausted', true), dmCtx('om_mention_help_exhausted'));

    expect(chargedUnits()).toBe(QUOTA_LIMIT);
    expect(mocks.createGroupWithBots).not.toHaveBeenCalled();
    expect(mocks.replyMessage).toHaveBeenCalled();
  });

  it('反向锁：`@Bot <普通消息>` 仍照常扣一次费并建群（剥 mention 不能宽到吞掉普通消息）', async () => {
    await handleNewTopic(dmEvent('帮我把这个报错定位一下', 'om_mention_plain', true), dmCtx('om_mention_plain'));

    expect(mocks.createGroupWithBots).toHaveBeenCalledTimes(1);
    expect(chargedUnits()).toBe(1);
    expect(landedTurns()).toHaveLength(1);
    expect(landedTurns()[0][0].chatId).toBe(BORN_GROUP);
  });
});
