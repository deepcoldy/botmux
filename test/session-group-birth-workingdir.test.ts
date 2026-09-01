/**
 * 会话群出生的工作目录解析必须**遵循机器人的默认工作目录配置**，而不是出生时
 * 直接把某个目录绑成 oncall 自动开工。
 *
 * 旧实现在 maybeBirthSessionGroup 里按
 *   sessionGroup.workingDir → defaultWorkingDir → workingDir(=workingDirs[0])
 * 的链取值并写 oncall 绑定，导致两类 bot 的目录逻辑在私聊 group 模式下失效：
 *   1. 「选仓库」bot（只配 workingDirs 扫描根）：workingDirs[0]（扫描根本身！）被
 *      直接绑定 → 会话在扫描根里自动开工，选仓库卡从不弹出；
 *   2. 「仅默认目录 + 自动 worktree」bot：defaultWorkingDir 被洗成 oncall 来源
 *      （pinnedFromBotDefault=false）→ auto-worktree 被抑制，会话直接跑在主
 *      checkout 上，各会话互相踩。
 *
 * 修复后 birth 只在**显式**配置 sessionGroup.workingDir 时才写绑定；否则不写，
 * 让递归回 handleNewTopic 的常规分层解析（resolvePinnedWorkingDir）接管——与普通
 * solo 群完全一致：默认目录（含 auto-worktree）或选仓库卡。
 *
 * 三条用例都跑**真实的建群递归**（只替身 createGroupWithBots 这一个飞书外部副作
 * 用 + runAutoWorktreeCommit 这一个 detached git 流程），断言绑定请求参数与递归后
 * 会话的落点。
 *
 * Run:  pnpm vitest run test/session-group-birth-workingdir.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-sg-wd-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    dataDir,
    createGroupWithBots: vi.fn(),
    runAutoWorktreeCommit: vi.fn(async () => undefined),
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
        sessionId: `sess-wd-${++seq}`,
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

// detached auto-worktree 建库流程要跑真 git fetch；替身成记录器，断言只看
// 「进入了 auto_worktree 挂起态 + baseDir 对不对」。
vi.mock('../src/im/lark/card-handler.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/card-handler.js');
  return { ...actual, runAutoWorktreeCommit: (...args: any[]) => mocks.runAutoWorktreeCommit(...args) };
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

import { registerBot, getBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
} from '../src/daemon.js';
import { initSessionGroups } from '../src/services/session-groups-store.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

const APP = 'sg_wd_app';
const DM_CHAT = 'oc_dm_wd_source';
const BORN_GROUP = 'oc_born_wd_group';
const OWNER = 'ou_wd_owner';

function dmEvent(text: string, messageId: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
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
    oncallBindings: [],
    roleProfileBootstrapMessageId: null,
    roleProfileBootstrapError: null,
    kickoffMessageId: null,
    kickoffError: null,
    ...overrides,
  };
}

function registerAppBot(configOverrides: Record<string, unknown>): void {
  registerBot({
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    p2pMode: 'group',
    allowedUsers: [OWNER],
    // 群标签 / 群头像是 fire-and-forget 装饰步骤，与本用例无关且要联网。
    sessionGroup: { tag: { mode: 'off' }, avatar: 'off' },
    ...configOverrides,
  } as any);
  getBot(APP).resolvedAllowedUsers = [OWNER];
}

/** birth 传给 createGroupWithBots 的绑定请求参数。 */
function requestedBindWorkingDir(): string | undefined {
  expect(mocks.createGroupWithBots).toHaveBeenCalledTimes(1);
  return mocks.createGroupWithBots.mock.calls[0][0]?.bindWorkingDir;
}

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(mocks.dataDir, { recursive: true });
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([]));
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

describe('会话群出生：选仓库 bot（仅 workingDirs 扫描根）', () => {
  it('不把扫描根绑成 oncall；递归后弹选仓库卡而不是自动开工', async () => {
    // 扫描根下放两个真实 git 仓库，让 repo 扫描器有东西可列。
    const scanRoot = join(mocks.dataDir, 'scan-root');
    for (const name of ['proj-a', 'proj-b']) {
      const p = join(scanRoot, name);
      mkdirSync(p, { recursive: true });
      execSync('git init -q', { cwd: p });
    }
    registerAppBot({ workingDir: scanRoot, workingDirs: [scanRoot] });

    await handleNewTopic(dmEvent('帮我修个 bug', 'om_wd_picker'), dmCtx('om_wd_picker'));

    // 旧实现在这里传 workingDirs[0]（扫描根），把选仓库 bot 直接钉死在扫描根。
    expect(requestedBindWorkingDir()).toBeUndefined();
    expect(getBot(APP).config.oncallChats ?? []).toHaveLength(0);

    // 会话落在新群、处于选仓库挂起态：没有 fork，卡片已发出。
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.createdSessions).toHaveLength(1);
    const session = mocks.createdSessions[0];
    expect(session.chatId).toBe(BORN_GROUP);
    expect(session.pendingRepoSetup?.mode).toBe('picker');
    const interactiveSends = [
      ...mocks.sendMessage.mock.calls,
      ...mocks.replyMessage.mock.calls,
    ].filter(c => c[3] === 'interactive');
    expect(interactiveSends.length).toBeGreaterThan(0);
  });
});

describe('会话群出生：仅默认目录 + 自动 worktree bot', () => {
  it('defaultWorkingDir 不再被洗成 oncall 来源；递归后走 auto-worktree 挂起而不是直接跑在主 checkout', async () => {
    const repoDir = join(mocks.dataDir, 'main-checkout');
    mkdirSync(repoDir, { recursive: true });
    registerAppBot({ defaultWorkingDir: repoDir, defaultWorkingDirAutoWorktree: true });

    await handleNewTopic(dmEvent('帮我改个功能', 'om_wd_autowt'), dmCtx('om_wd_autowt'));

    expect(requestedBindWorkingDir()).toBeUndefined();

    // 不同步 fork：会话登记成 auto_worktree 挂起态，建库流程拿到的 baseDir 是
    // bot 自己的 defaultWorkingDir（pinnedFromBotDefault=true 的证据）。
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.createdSessions).toHaveLength(1);
    const session = mocks.createdSessions[0];
    expect(session.chatId).toBe(BORN_GROUP);
    expect(session.pendingRepoSetup?.mode).toBe('auto_worktree');
    expect(session.pendingRepoSetup?.baseDir).toBe(repoDir);
    expect(mocks.runAutoWorktreeCommit).toHaveBeenCalledTimes(1);
    expect(mocks.runAutoWorktreeCommit.mock.calls[0][0]).toMatchObject({ baseDir: repoDir });
  });
});

describe('会话群出生：显式 sessionGroup.workingDir 模板目录', () => {
  it('仍请求绑定并直接在模板目录开工（显式配置优先于默认目录逻辑）', async () => {
    const tplDir = join(mocks.dataDir, 'sg-template');
    const defaultDir = join(mocks.dataDir, 'default-dir');
    mkdirSync(tplDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    registerAppBot({
      defaultWorkingDir: defaultDir,
      defaultWorkingDirAutoWorktree: true,
      sessionGroup: { tag: { mode: 'off' }, avatar: 'off', workingDir: tplDir },
    });
    // 模拟真身 createGroupWithBots 的绑定副作用（真身会 bindOncall 落盘）。
    mocks.createGroupWithBots.mockImplementation(async (opts: any) => {
      if (opts.bindWorkingDir) {
        getBot(APP).config.oncallChats = [{ chatId: BORN_GROUP, workingDir: opts.bindWorkingDir }];
        return createGroupResult({ oncallBindings: [{ larkAppId: APP, ok: true, created: true }] });
      }
      return createGroupResult();
    });

    await handleNewTopic(dmEvent('帮我看看模板目录', 'om_wd_tpl'), dmCtx('om_wd_tpl'));

    expect(requestedBindWorkingDir()).toBe(tplDir);

    // oncall 绑定生效 → 直接 fork 在模板目录；auto-worktree（针对默认目录）不掺和。
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const [ds] = mocks.forkWorker.mock.calls[0];
    expect(ds.chatId).toBe(BORN_GROUP);
    expect(ds.workingDir).toBe(tplDir);
    expect(mocks.runAutoWorktreeCommit).not.toHaveBeenCalled();
  });
});
