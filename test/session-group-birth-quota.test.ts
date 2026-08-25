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
 * 后半部分守的是出生**之后**那条缺口（复审 P1-4）：会话群不能靠出生时那条纯粹用来
 * 承载 workingDir 的 oncall 绑定重新获得放行，必须沿用来源授权的额度键 / reason /
 * 到期与撤销；以及绑定没落地时要回退，不留半残会话群。
 *
 * Run:  pnpm vitest run test/session-group-birth-quota.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  enforceMessageQuotaForCliInput,
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
} from '../src/daemon.js';
import { addChatGrant, chatQuotaKey, removeChatGrant } from '../src/services/grant-store.js';
import { initSessionGroups, isSessionGroup, getSessionGroup } from '../src/services/session-groups-store.js';
import { canTalk, evaluateTalk, grantCommandRestriction, type RoutingContext } from '../src/im/lark/event-dispatcher.js';

const APP = 'sg_quota_app';
const DM_CHAT = 'oc_dm_with_grantee';
const BORN_GROUP = 'oc_born_session_group';
const PLAIN_ONCALL = 'oc_plain_oncall_group';
const OWNER = 'ou_owner';
const GRANTEE = 'ou_chat_grantee';
const OUTSIDER = 'ou_dragged_in_colleague';
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

/** 会话群**自己**那把额度键被扣了几次。修复后恒为 0：新群不该另起一份额度。 */
function bornGroupUnits(): number {
  return getBot(APP).config.quotaState?.[chatQuotaKey(BORN_GROUP, GRANTEE)]?.used ?? 0;
}

/**
 * 补上「出生时为承载 workingDir 写下的 oncall 绑定」——本测试把 createGroupWithBots
 * 换成了替身，真实的 bindOncall 不会跑，得手工补齐。旧实现正是靠这条纯粹为解目录
 * 而写的绑定，把会话群变成了免授权、免额度的 oncall 群。
 */
function bindWorkingDirOncall(...chatIds: string[]): void {
  const workingDir = join(mocks.dataDir, 'workdir');
  getBot(APP).config.oncallChats = chatIds.map(chatId => ({ chatId, workingDir }));
}

/** 会话群里的第二条及以后消息走的就是这道闸（router 的 CLI 输入额度入口）。 */
function inGroupMessage(messageId: string, openId: string = GRANTEE): Promise<boolean> {
  return enforceMessageQuotaForCliInput(
    APP, BORN_GROUP, openId, messageId, BORN_GROUP, undefined, undefined, 'group',
  );
}

function createGroupResult(overrides: Record<string, unknown> = {}): any {
  return {
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
    // 仅显式 sessionGroup.workingDir 会请求绑定（defaultWorkingDir/workingDirs 不再
    // fallback 成绑定——那会抑制 auto-worktree、跳过选仓库卡）。默认配置下 birth 不看
    // 这个字段；「绑定没落地必须回退」那组用例会先补上 sessionGroup.workingDir。
    oncallBindings: [{ larkAppId: APP, ok: true, created: true }],
    roleProfileBootstrapMessageId: null,
    roleProfileBootstrapError: null,
    kickoffMessageId: null,
    kickoffError: null,
    ...overrides,
  };
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
  // 会话群登记表是**落盘**的：不清掉，上一个用例出生的群会漏进下一个用例，
  // 「没建成群」这类断言就会假绿。
  rmSync(join(mocks.dataDir, `session-groups-${APP}.json`), { force: true });
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
  mocks.createGroupWithBots.mockResolvedValue(createGroupResult());
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

/**
 * 会话群必须**继承来源授权**，而不是靠出生时那条 oncall 绑定重新获得放行。
 *
 * 出生时为了承载 workingDir 会给新群写一条 oncall 绑定。oncall 腿排在 chatGrant /
 * globalGrant 之前，且只看 chatId、不看发送者——于是一条私聊建群之后：
 *   • 未配 messageQuota.defaultLimit → 新群里完全不限额；配了也是 chat:<新群>:<user>
 *     这把**全新**的计数器，与私聊那把不共享 → 额度上限被放大成「N 个群 × 每群一份」；
 *   • 群里任何被拉进来的人都直接过 canTalk；
 *   • reason 从 chatGrant 变成 oncall → restrictGrantCommands 静默失效。
 * 修法：会话群走专用腿（排在 oncall 之前），只放行群主，并沿用出生时持久化的原
 * quotaKey / reason / 来源 chat；oncall 在会话群里退回只解析 workingDir。
 */
describe('会话群继承来源授权（堵 oncall 腿的额度与权限绕过）', () => {
  it('出生后的第二条消息仍扣**来源私聊授权**那把额度，不在新群另起一份', async () => {
    await handleNewTopic(dmEvent('帮我看下登录接口报 500', 'om_inherit_1'), dmCtx('om_inherit_1'));
    expect(isSessionGroup(BORN_GROUP)).toBe(true);
    expect(chargedUnits()).toBe(1);
    bindWorkingDirOncall(BORN_GROUP);

    await expect(inGroupMessage('om_inherit_2')).resolves.toBe(true);

    // 计数器仍是私聊那把（+1）；新群没有独立额度记录。
    expect(chargedUnits()).toBe(2);
    expect(bornGroupUnits()).toBe(0);
    expect(evaluateTalk(APP, BORN_GROUP, GRANTEE, undefined, undefined, 'group')).toMatchObject({
      allowed: true,
      reason: 'chatGrant',
      quotaKey: chatQuotaKey(DM_CHAT, GRANTEE),
      grantChatId: DM_CHAT,
    });
  });

  it('额度真的会在会话群里用完，且撤销落在**来源私聊**的那条授权上', async () => {
    await addChatGrant(APP, DM_CHAT, GRANTEE, 2);
    await handleNewTopic(dmEvent('第一条', 'om_cap_1'), dmCtx('om_cap_1'));
    bindWorkingDirOncall(BORN_GROUP);

    // 第二条刚好用完，仍放行——扣的仍是私聊那把计数器。
    await expect(inGroupMessage('om_cap_2')).resolves.toBe(true);
    expect(chargedUnits()).toBe(2);
    expect(bornGroupUnits()).toBe(0);

    // 第三条被硬上限拦下（旧实现在这里是「不限」或「新群一份全新额度」）。
    await expect(inGroupMessage('om_cap_3')).resolves.toBe(false);
    // 自愈撤销必须落到来源私聊，而不是去删会话群上一条根本不存在的授权。
    expect(getBot(APP).config.chatGrants?.[DM_CHAT] ?? []).not.toContain(GRANTEE);
    expect(bornGroupUnits()).toBe(0);
  });

  it('非 owner 在会话群里不再被 oncall 腿放行（普通 oncall 群语义不变）', async () => {
    await handleNewTopic(dmEvent('帮我看下这个报错', 'om_outsider'), dmCtx('om_outsider'));
    bindWorkingDirOncall(BORN_GROUP, PLAIN_ONCALL);

    expect(canTalk(APP, BORN_GROUP, GRANTEE, undefined, undefined, 'group')).toBe(true);
    expect(canTalk(APP, BORN_GROUP, OUTSIDER, undefined, undefined, 'group')).toBe(false);
    await expect(inGroupMessage('om_outsider_msg', OUTSIDER)).resolves.toBe(false);
    // 反向锁：普通 oncall 群（不是会话群）一字未改，同一个陌生人照常放行。
    expect(canTalk(APP, PLAIN_ONCALL, OUTSIDER, undefined, undefined, 'group')).toBe(true);
  });

  it('restrictGrantCommands 在会话群里照旧生效（reason 不再被洗成 oncall）', async () => {
    getBot(APP).config.restrictGrantCommands = true;
    await handleNewTopic(dmEvent('帮我跑一下测试', 'om_restrict'), dmCtx('om_restrict'));
    bindWorkingDirOncall(BORN_GROUP);

    expect(grantCommandRestriction(APP, DM_CHAT, GRANTEE)).toMatchObject({ blocked: true, reason: 'chatGrant' });
    expect(grantCommandRestriction(APP, BORN_GROUP, GRANTEE)).toMatchObject({ blocked: true, reason: 'chatGrant' });
    // 反向锁：授权用户（allowedUsers）不受这道闸约束。
    expect(grantCommandRestriction(APP, BORN_GROUP, OWNER).blocked).toBe(false);
  });

  it('来源授权被撤销后，会话群里连群主也发不了言（撤销/到期跟着原授权走）', async () => {
    await handleNewTopic(dmEvent('帮我看看', 'om_revoke'), dmCtx('om_revoke'));
    bindWorkingDirOncall(BORN_GROUP);
    expect(canTalk(APP, BORN_GROUP, GRANTEE, undefined, undefined, 'group')).toBe(true);

    await removeChatGrant(APP, DM_CHAT, GRANTEE);

    expect(canTalk(APP, BORN_GROUP, GRANTEE, undefined, undefined, 'group')).toBe(false);
  });

  it('provenance 落盘：daemon 重启后仍认得原授权', async () => {
    await handleNewTopic(dmEvent('帮我看看', 'om_persist'), dmCtx('om_persist'));

    initSessionGroups(APP); // 模拟重启：从磁盘重新加载

    expect(getSessionGroup(BORN_GROUP)).toMatchObject({
      ownerOpenId: GRANTEE,
      originReason: 'chatGrant',
      originQuotaKey: chatQuotaKey(DM_CHAT, GRANTEE),
      originChatId: DM_CHAT,
    });
  });
});

/**
 * 显式 sessionGroup.workingDir 会以 oncall 绑定承载。绑定没落地 = 会话群解不出
 * 这个模板目录，每一轮都会跑错地方；而 birth 过去**一眼都没看** result.oncallBindings。
 * 回退语义与「用户没能被邀请进群」一致：解散半残的群、回落原私聊线程。
 * （绑定只在显式配置 sessionGroup.workingDir 时才会被请求，这里先补上。）
 */
describe('会话群出生：workingDir 绑定没落地必须回退', () => {
  beforeEach(() => {
    getBot(APP).config.sessionGroup = {
      ...(getBot(APP).config.sessionGroup ?? {}),
      workingDir: join(mocks.dataDir, 'workdir'),
    };
  });

  it('绑定失败 → 不登记会话群，任务回落原私聊（已扣的费不白扣）', async () => {
    mocks.createGroupWithBots.mockResolvedValue(createGroupResult({
      oncallBindings: [{ larkAppId: APP, ok: false, error: 'bots.json write failed' }],
    }));

    await handleNewTopic(dmEvent('帮我看下这个报错', 'om_bind_fail'), dmCtx('om_bind_fail'));

    expect(mocks.createGroupWithBots).toHaveBeenCalledTimes(1);
    expect(isSessionGroup(BORN_GROUP)).toBe(false);
    // 「扣了费就不能丢任务」：回落到原私聊线程照常落地。
    expect(chargedUnits()).toBe(1);
    expect(landedTurns()).toHaveLength(1);
    expect(landedTurns()[0][0].chatId).toBe(DM_CHAT);
  });

  it('绑定条目整个缺失（binding 根本没跑）同样回退', async () => {
    mocks.createGroupWithBots.mockResolvedValue(createGroupResult({ oncallBindings: [] }));

    await handleNewTopic(dmEvent('帮我看下这个报错', 'om_bind_missing'), dmCtx('om_bind_missing'));

    expect(isSessionGroup(BORN_GROUP)).toBe(false);
    expect(landedTurns()).toHaveLength(1);
    expect(landedTurns()[0][0].chatId).toBe(DM_CHAT);
  });
});
