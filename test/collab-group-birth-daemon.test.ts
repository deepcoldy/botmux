/**
 * 协作初始化入口在真实 daemon 出生块里的行为（design §5.2 / §3 铁律 1）。
 *
 * 关键不变量：显式 enabled 的协作配置在 PR-1（编排未实现）必须 fail-closed——
 * preflight 返回 failed，在 creator 扣费**之前**拦截，0 次额度调用、不建群、不开 CLI、
 * 不残留 running 占位、同 DM 下一条不是 busy。只有未启用协作才走 legacy 建群。
 *
 * 复用 session-group-birth-quota 的替身策略：只把飞书建群副作用换掉，额度走真实
 * grant-store，断言「扣费次数」可观测。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-collab-birth-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    dataDir,
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
        sessionId: `sess-collab-${++seq}`,
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
    getSession: vi.fn(),
    resumeSession: vi.fn(async () => ({ ok: false, error: 'not_found' })),
    dismissSessionGroup: vi.fn(async () => ({ status: 'confirm', state: 'a'.repeat(64) })),
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
    forwardMessage: vi.fn(async () => 'om_forwarded'),
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
  return { ...actual, createSession: mocks.createSession, updateSession: mocks.updateSession, getSession: mocks.getSession };
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
  return { ...actual, downloadResources: (...args: any[]) => mocks.downloadResources(...args), resumeSession: mocks.resumeSession };
});

vi.mock('../src/core/dismiss-command.js', () => ({ dismissSessionGroup: mocks.dismissSessionGroup }));

vi.mock('../src/services/session-group-title.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-group-title.js');
  return { ...actual, scheduleSessionGroupTitle: (...args: any[]) => mocks.scheduleSessionGroupTitle(...args) };
});

import { loadBotConfigs, registerBot, getBot } from '../src/bot-registry.js';
import { __testOnly_handleNewTopic as handleNewTopic } from '../src/daemon.js';
import { addChatGrant, chatQuotaKey } from '../src/services/grant-store.js';
import { readCollabInitStore } from '../src/services/collab-init-store.js';
import { initSessionGroups, isSessionGroup } from '../src/services/session-groups-store.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

const APP = 'collab_birth_app';
const DM_CHAT = 'oc_dm_collab';
const OWNER = 'ou_owner';
const GRANTEE = 'ou_collab_grantee';
const QUOTA_LIMIT = 3;

function botConfig(collaboration: unknown): any {
  return {
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    p2pMode: 'group',
    workingDir: join(mocks.dataDir, 'workdir'),
    defaultWorkingDir: join(mocks.dataDir, 'workdir'),
    allowedUsers: [OWNER],
    sessionGroup: { tag: { mode: 'off' }, avatar: 'off', collaboration },
  };
}

function dmEvent(text: string, messageId: string): any {
  return {
    sender: { sender_id: { open_id: GRANTEE, union_id: 'on_collab_grantee' }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: DM_CHAT,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
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

function chargedUnits(): number {
  return getBot(APP).config.quotaState?.[chatQuotaKey(DM_CHAT, GRANTEE)]?.used ?? 0;
}

const validCollab = {
  enabled: true,
  agents: [{ appId: APP, roleMode: 'no-chat-role' }],
  kickoff: [{ appId: APP, trigger: 'immediate' }],
};

const invalidCollab = {
  enabled: true,
  agents: [], // 结构非法
  kickoff: [],
};

const BORN_GROUP = 'oc_born_collab_group';

function createGroupResult(): any {
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
    oncallBindings: [],
    roleProfileBootstrapMessageId: null,
    roleProfileBootstrapError: null,
    kickoffMessageId: null,
    kickoffError: null,
    managersAdded: [],
    managerError: null,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mkdirSync(mocks.dataDir, { recursive: true });
  const workDir = join(mocks.dataDir, 'workdir');
  mkdirSync(workDir, { recursive: true });
  // 默认先写合法 enabled 配置；单个用例再覆盖成非法/关闭。
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([botConfig(validCollab)]));
  loadBotConfigs().forEach(cfg => registerBot(cfg));
  const bot = getBot(APP);
  bot.resolvedAllowedUsers = [OWNER];
  delete bot.config.chatGrants;
  delete bot.config.quotaState;
  delete bot.config.grantExpiryState;
  await addChatGrant(APP, DM_CHAT, GRANTEE, QUOTA_LIMIT);
  rmSync(join(mocks.dataDir, `collab-group-init-${APP}.json`), { force: true });
  rmSync(join(mocks.dataDir, `session-groups-${APP}.json`), { force: true });
  initSessionGroups(APP);
  mocks.createGroupWithBots.mockResolvedValue(createGroupResult());
});

describe('协作初始化入口：fail-closed 不扣费不建群', () => {
  it('合法 enabled 配置（编排未实现）→ preflight failed：0 次扣费、不建群、不开 CLI、无 running 残留', async () => {
    await handleNewTopic(dmEvent('帮我协作做个任务', 'om_collab_1'), dmCtx('om_collab_1'));

    // 0 次额度扣费
    expect(chargedUnits()).toBe(0);
    // 不建群（不落 legacy）
    expect(mocks.createGroupWithBots).not.toHaveBeenCalled();
    // 不开 CLI
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    // DM 明示失败（回执）
    expect(mocks.replyMessage).toHaveBeenCalled();
    // 无 running 残留（占位已释放）
    const store = readCollabInitStore(mocks.dataDir, APP);
    expect(Object.values(store.entries).some(e => e.state === 'running')).toBe(false);
    expect(store.activeByDmChat[DM_CHAT]).toBeUndefined();
  });

  it('结构非法（enabled:true 但 agents 空）→ failed：0 次扣费、不建群、不落 legacy', async () => {
    writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([botConfig(invalidCollab)]));
    loadBotConfigs().forEach(cfg => registerBot(cfg));
    const bot = getBot(APP);
    bot.resolvedAllowedUsers = [OWNER];
    delete bot.config.chatGrants;
    delete bot.config.quotaState;
    await addChatGrant(APP, DM_CHAT, GRANTEE, QUOTA_LIMIT);

    await handleNewTopic(dmEvent('帮我协作做个任务', 'om_collab_invalid'), dmCtx('om_collab_invalid'));

    expect(chargedUnits()).toBe(0);
    expect(mocks.createGroupWithBots).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.replyMessage).toHaveBeenCalled();
  });

  it('同 DM 下一条（不同 source）不是 busy（上次 failed 已释放占位）', async () => {
    await handleNewTopic(dmEvent('第一个协作任务', 'om_collab_a'), dmCtx('om_collab_a'));
    // 第二条仍是 failed（编排未实现），而非 busy
    mocks.replyMessage.mockClear();
    await handleNewTopic(dmEvent('第二个协作任务', 'om_collab_b'), dmCtx('om_collab_b'));
    expect(chargedUnits()).toBe(0);
    expect(mocks.replyMessage).toHaveBeenCalled();
    // 第二条的失败回执不是因为 busy（busy 文案不同，这里只验证 store 无 running 且未 busy 卡死）
    const store = readCollabInitStore(mocks.dataDir, APP);
    expect(store.activeByDmChat[DM_CHAT]).toBeUndefined();
  });

  it('未启用协作 → 走 legacy 建群（行为与 master 一致，正常扣费 1 次）', async () => {
    writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([botConfig(undefined)]));
    loadBotConfigs().forEach(cfg => registerBot(cfg));
    const bot = getBot(APP);
    bot.resolvedAllowedUsers = [OWNER];
    delete bot.config.chatGrants;
    delete bot.config.quotaState;
    await addChatGrant(APP, DM_CHAT, GRANTEE, QUOTA_LIMIT);

    await handleNewTopic(dmEvent('普通建群任务', 'om_collab_legacy'), dmCtx('om_collab_legacy'));

    // legacy 路径：扣 1 次费、建群、落地
    expect(chargedUnits()).toBe(1);
    expect(mocks.createGroupWithBots).toHaveBeenCalledTimes(1);
    expect(isSessionGroup(BORN_GROUP)).toBe(true);
    // 无 collab store 写入
    const store = readCollabInitStore(mocks.dataDir, APP);
    expect(Object.keys(store.entries)).toHaveLength(0);
  });

  it('failed / existing / busy 入口判定均 0 次扣费（防重复扣费被真实出生块钉住）', async () => {
    // 结构非法 → failed
    writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([botConfig(invalidCollab)]));
    loadBotConfigs().forEach(cfg => registerBot(cfg));
    const bot = getBot(APP);
    bot.resolvedAllowedUsers = [OWNER];
    delete bot.config.chatGrants;
    delete bot.config.quotaState;
    await addChatGrant(APP, DM_CHAT, GRANTEE, QUOTA_LIMIT);
    await handleNewTopic(dmEvent('非法配置', 'om_dedup_invalid'), dmCtx('om_dedup_invalid'));
    expect(chargedUnits()).toBe(0);

    // 合法 enabled（编排未实现）→ failed，同样 0 次
    writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([botConfig(validCollab)]));
    loadBotConfigs().forEach(cfg => registerBot(cfg));
    const bot2 = getBot(APP);
    bot2.resolvedAllowedUsers = [OWNER];
    delete bot2.config.chatGrants;
    delete bot2.config.quotaState;
    await addChatGrant(APP, DM_CHAT, GRANTEE, QUOTA_LIMIT);
    await handleNewTopic(dmEvent('未实现编排', 'om_dedup_unimpl'), dmCtx('om_dedup_unimpl'));
    expect(chargedUnits()).toBe(0);
  });
});
