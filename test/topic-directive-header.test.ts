/**
 * 话题指令头在普通群新话题路径上的端到端行为。
 *
 * 跑的是真实的 `handleNewTopic`（只替身飞书外部副作用、下载、fork 这三处），断言一条
 * 消息之后**会话上真的落了什么**：workingDir、title（来源 user）、启动参数里的模型、
 * 持久化的 reasoningEffort；以及拒绝路径真的零副作用。
 *
 * 模型那一项刻意断言 `sessionAgentConfig` 的解析结果而不是 `ds.spawnModelOverride`：
 * 前者才是 worker 真正拿去拼启动参数的值，后者只是它的一个输入。
 *
 * 共用层改动按仓库惯例至少在一个非 Claude 的 CLI 上验证，所以同一组断言在 codex bot 上
 * 再跑一遍。
 *
 * Run:  bun run vitest run test/topic-directive-header.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-topic-header-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    dataDir,
    runAutoWorktreeCommit: vi.fn(async (..._args: any[]) => undefined),
    replyMessage: vi.fn(async (..._args: any[]) => 'om_reply'),
    sendMessage: vi.fn(async (..._args: any[]) => 'om_sent'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId?: string) => (
      openId ? { openId, type: 'user' as const } : undefined
    )),
    forkWorker: vi.fn((..._args: any[]) => undefined),
    sendWorkerInput: vi.fn((..._args: any[]) => true),
    downloadResources: vi.fn(async (..._args: any[]) => ({ attachments: [] as unknown[], needLogin: false })),
    createdSessions: [] as any[],
    createSession: vi.fn(function (chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') {
      const session = {
        sessionId: `sess-th-${++seq}`,
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
    onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
  })),
}));

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
  return {
    ...actual,
    forkWorker: (...args: any[]) => mocks.forkWorker(...args),
    sendWorkerInput: (...args: any[]) => mocks.sendWorkerInput(...args),
  };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return { ...actual, downloadResources: (...args: any[]) => mocks.downloadResources(...args) };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_sessionAgentConfig as sessionAgentConfig } from '../src/core/worker-pool.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

const APP = 'topic_header_app';
const GROUP = 'oc_topic_header_group';
const OWNER = 'ou_topic_header_owner';
const BOT_OPEN_ID = 'ou_topic_header_bot';

let scanRoot: string;
let botmuxRepo: string;
let homelabRepo: string;

/** 普通群里 @bot 的一条文本消息。 */
function groupEvent(text: string, messageId: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: GROUP,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
      mentions: [{ key: '@_user_1', name: 'Claude', id: { open_id: BOT_OPEN_ID }, id_type: 'open_id' }],
    },
  };
}

/** 普通群的入站路由：chat-scope 起步，指令头自己把 scope 翻成 thread。 */
function groupCtx(messageId: string): RoutingContext {
  return {
    chatId: GROUP,
    messageId,
    chatType: 'group',
    scope: 'chat',
    anchor: GROUP,
    larkAppId: APP,
  } as RoutingContext;
}

function registerAppBot(overrides: Record<string, unknown> = {}): void {
  registerBot({
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    allowedUsers: [OWNER],
    workingDirs: [scanRoot],
    ...overrides,
  } as any);
  const bot = getBot(APP);
  bot.resolvedAllowedUsers = [OWNER];
  bot.botOpenId = BOT_OPEN_ID;
  bot.botName = 'Claude';
}

/** 本轮 fork 出来的那个会话（forkWorker 的第一个参数）。 */
function forkedSession(): any {
  expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
  return mocks.forkWorker.mock.calls[0][0];
}

/** 本轮发出去的每条消息的正文（sessionReply 走 replyMessage / sendMessage 两条腿，
 *  两者的第 3 个位置参数都是 content）。 */
function sentContents(): string[] {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .map(call => String(call[2] ?? ''));
}

/** 本轮发出去的 interactive（卡片）消息条数 —— 第 4 个位置参数是 msgType。 */
function sentCardCount(): number {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .filter(call => call[3] === 'interactive').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  scanRoot = join(mocks.dataDir, 'scan-root');
  botmuxRepo = join(scanRoot, 'botmux');
  homelabRepo = join(scanRoot, 'homelab');
  mkdirSync(mocks.dataDir, { recursive: true });
  for (const p of [botmuxRepo, homelabRepo]) {
    mkdirSync(p, { recursive: true });
    execSync('git init -q', { cwd: p });
  }
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([]));
  activeSessions.clear();
  mocks.createdSessions.length = 0;
  mocks.replyMessage.mockResolvedValue('om_reply');
  mocks.sendMessage.mockResolvedValue('om_sent');
  mocks.getChatMode.mockResolvedValue('group');
  mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
  mocks.sendWorkerInput.mockReturnValue(true);
  registerAppBot();
});

afterAll(() => {
  rmSync(mocks.dataDir, { recursive: true, force: true });
});

describe('指令头：一条消息完成开话题、选仓、选模型与首轮任务', () => {
  it('标题 / 仓库 / 模型 / 推理强度 / 首轮任务逐项落到会话上', async () => {
    await handleNewTopic(
      groupEvent('日常运维 /t /repo botmux /model sonnet /effort high 看看 daemon 日志 @Claude', 'om_full'),
      groupCtx('om_full'),
    );

    const ds = forkedSession();
    // 仓库：钉在会话上，跳过选仓卡片。
    expect(ds.workingDir).toBe(botmuxRepo);
    expect(ds.session.workingDir).toBe(botmuxRepo);
    // 标题：来源 user，并置上「用户定义」标记，首次 spawn 就带原生会话名。
    expect(ds.session.title).toBe('日常运维');
    expect(ds.session.titleSource).toBe('user');
    expect(ds.session.nativeSessionTitleUserDefined).toBe(true);
    expect(ds.session.nativeSessionTitle).toBe('日常运维');
    // 模型：worker 真正拿去拼启动参数的那个值。
    expect(sessionAgentConfig(ds, getBot(APP).config).model).toBe('sonnet');
    // 推理强度：持久化在会话上。
    expect(ds.session.reasoningEffort).toBe('high');
    // 首轮任务进了开场，句尾对本 bot 的 @ 已被剥掉。
    const opening = mocks.forkWorker.mock.calls[0][1];
    const openingText = typeof opening === 'string' ? opening : opening.content;
    expect(openingText).toContain('看看 daemon 日志');
    expect(openingText).not.toContain('@Claude');
    // 普通群里 chat-scope 被翻成 thread-scope，锚在用户这条消息上。
    expect(ds.scope).toBe('thread');
    expect(ds.session.rootMessageId).toBe('om_full');
  });

  it('多行写法与单行写法结果相同', async () => {
    await handleNewTopic(
      groupEvent('日常运维\n/t\n/repo botmux\n/model sonnet\n\n看看 daemon 日志', 'om_multiline'),
      groupCtx('om_multiline'),
    );
    const ds = forkedSession();
    expect(ds.workingDir).toBe(botmuxRepo);
    expect(ds.session.title).toBe('日常运维');
    expect(sessionAgentConfig(ds, getBot(APP).config).model).toBe('sonnet');
    const opening = mocks.forkWorker.mock.calls[0][1];
    expect(typeof opening === 'string' ? opening : opening.content).toContain('看看 daemon 日志');
  });

  it('显式选仓不触发 auto-worktree —— 与点选仓卡片同语义', async () => {
    // bot 开了「仅默认目录 + 自动 worktree」，但用户在头部点名了仓库。
    registerAppBot({ defaultWorkingDir: botmuxRepo, defaultWorkingDirAutoWorktree: true });

    await handleNewTopic(
      groupEvent(`/t /repo ${botmuxRepo} 干活`, 'om_explicit_repo'),
      groupCtx('om_explicit_repo'),
    );

    expect(mocks.runAutoWorktreeCommit).not.toHaveBeenCalled();
    expect(forkedSession().workingDir).toBe(botmuxRepo);
  });

  it('没写 /repo 时仍按 bot 配置走 auto-worktree（不受指令头影响）', async () => {
    registerAppBot({ defaultWorkingDir: botmuxRepo, defaultWorkingDirAutoWorktree: true });

    await handleNewTopic(
      groupEvent('日常运维 /t /model sonnet 干活', 'om_autowt'),
      groupCtx('om_autowt'),
    );

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.runAutoWorktreeCommit).toHaveBeenCalledTimes(1);
    expect(mocks.runAutoWorktreeCommit.mock.calls[0][0]).toMatchObject({ baseDir: botmuxRepo });
    // 模型/标题挂在会话上，等 worktree 建好后由 commitRepoSelection 带进 fork。
    const ds = mocks.runAutoWorktreeCommit.mock.calls[0][0].ds;
    expect(ds.spawnModelOverride).toBe('sonnet');
    expect(ds.session.title).toBe('日常运维');
  });
});

describe('指令头：拒绝路径零副作用', () => {
  const rejected: Array<{ name: string; text: string }> = [
    { name: '仓库不存在', text: '日常运维 /t /repo 并不存在的仓库 干活' },
    { name: '仓库用了编号形式', text: '日常运维 /t /repo 2 干活' },
    { name: '模型名不合法（正文被当成模型名）', text: '/t /repo botmux /model 命令为啥坏了' },
    { name: '推理档位不合法', text: '/t /effort 特别高 干活' },
    { name: '未知头部指令', text: '日常运维 /t /repo botmux /clear' },
    { name: '指令缺参数', text: '日常运维 /t /repo' },
    { name: '同一指令重复', text: '/t /repo botmux /repo homelab 干活' },
  ];

  for (const { name, text } of rejected) {
    it(`${name} → 不建会话、不 fork、不发卡片，只回一句用法错误`, async () => {
      await handleNewTopic(groupEvent(text, 'om_reject'), groupCtx('om_reject'));

      expect(mocks.forkWorker).not.toHaveBeenCalled();
      expect(mocks.runAutoWorktreeCommit).not.toHaveBeenCalled();
      expect(mocks.createdSessions).toHaveLength(0);
      expect(activeSessions.size).toBe(0);
      // 没有 interactive 消息 = 没弹选仓卡。
      expect(sentCardCount()).toBe(0);
      // 回了且只回了一条，内容是拒绝提示。
      const texts = sentContents();
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('话题指令头有问题');
    });
  }

  it('CLI 带不动模型时拒绝 /model，而不是静默忽略', async () => {
    registerAppBot({ cliId: 'dsh-tui' });

    await handleNewTopic(
      groupEvent('/t /model deepseek-v4-pro 干活', 'om_model_unsupported'),
      groupCtx('om_model_unsupported'),
    );

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.createdSessions).toHaveLength(0);
    expect(sentContents()[0]).toContain('带不了模型');
  });
});

describe('指令头：向后兼容（D9）', () => {
  it('/t 文案 —— 行为不变：未钉目录时弹选仓卡，正文暂存等选完再开工', async () => {
    await handleNewTopic(groupEvent('/t 帮我看看 X', 'om_legacy_text'), groupCtx('om_legacy_text'));

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(sentCardCount()).toBe(1);
    const ds = [...activeSessions.values()][0]!;
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingPrompt).toContain('帮我看看 X');
    expect(ds.session.titleSource).toBeUndefined();
  });

  it('/t 文案 + 已钉目录 —— 正文原样进开场', async () => {
    registerAppBot({ defaultWorkingDir: botmuxRepo });
    await handleNewTopic(groupEvent('/t 帮我看看 X', 'om_legacy_text2'), groupCtx('om_legacy_text2'));

    const ds = forkedSession();
    expect(ds.session.titleSource).toBeUndefined();
    const opening = mocks.forkWorker.mock.calls[0][1];
    expect(typeof opening === 'string' ? opening : opening.content).toContain('帮我看看 X');
  });

  it('裸 /t —— 仍是话题设置：不建会话，回一句「请在话题内发送任务」', async () => {
    registerAppBot({ defaultWorkingDir: botmuxRepo });
    await handleNewTopic(groupEvent('/t', 'om_legacy_bare'), groupCtx('om_legacy_bare'));

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.createdSessions).toHaveLength(0);
    expect(sentContents()[0]).toContain('新话题已创建');
  });

  it('/t /repo X —— 钉仓库、CLI 空转等下一条（不烧掉一个空开场）', async () => {
    await handleNewTopic(groupEvent('/t /repo botmux', 'om_legacy_repo'), groupCtx('om_legacy_repo'));

    const ds = forkedSession();
    expect(ds.workingDir).toBe(botmuxRepo);
    // 空 prompt fork + 「下一条真消息才是开场」标记。
    expect(mocks.forkWorker.mock.calls[0][1]).toBe('');
    expect(ds.session.initialUserTurnPending).toBe(true);
    expect(sentContents().join('\n')).toContain('话题已就绪');
  });

  it('/t /goal … 这类既有冷启动用法不被解析器提前拒掉', async () => {
    await handleNewTopic(groupEvent('/t /goal 修一下登录', 'om_legacy_goal'), groupCtx('om_legacy_goal'));
    // 未被指令头拒绝：要么走 passthrough 冷启动、要么当普通文案 spawn，总之有会话产生。
    expect(sentContents().join('\n')).not.toContain('话题指令头有问题');
    expect(mocks.createdSessions.length).toBeGreaterThan(0);
  });

  it('没有 /t 的普通消息完全不受影响', async () => {
    await handleNewTopic(groupEvent('帮我看一下 daemon 日志', 'om_plain'), groupCtx('om_plain'));

    const ds = [...activeSessions.values()][0]!;
    expect(ds.session.titleSource).toBeUndefined();
    // 普通群里没有 /t 就不强制开话题，scope 保持 chat。
    expect(ds.scope).toBe('chat');
    expect(ds.pendingPrompt).toContain('帮我看一下 daemon 日志');
  });
});

describe('指令头：共用层在非 Claude 的 CLI 上同样生效', () => {
  it('codex bot 上仓库 / 模型 / 推理强度逐项落地', async () => {
    registerAppBot({ cliId: 'codex', model: 'gpt-5.5' });

    await handleNewTopic(
      groupEvent('线上排查 /t /repo homelab /model gpt-5.6-sol /effort ultra 看看告警', 'om_codex'),
      groupCtx('om_codex'),
    );

    const ds = forkedSession();
    expect(ds.workingDir).toBe(homelabRepo);
    expect(ds.session.title).toBe('线上排查');
    expect(ds.session.reasoningEffort).toBe('ultra');
    // codex 的 ultra 只有部分模型支持——启动参数里要拿到头部钉的模型，而不是 bot 配的。
    expect(sessionAgentConfig(ds, getBot(APP).config).model).toBe('gpt-5.6-sol');
  });

  it('codex bot 上同样拒绝该 CLI/模型不支持的推理档位', async () => {
    registerAppBot({ cliId: 'codex', model: 'gpt-5.5' });

    await handleNewTopic(
      groupEvent('/t /effort ultra 看看告警', 'om_codex_effort'),
      groupCtx('om_codex_effort'),
    );

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(sentContents()[0]).toContain('不支持推理档位');
  });
});


// ─── thread 路径（话题内已有会话）───────────────────────────────────────────

const THREAD_ROOT = 'om_thread_root';

/** 在 THREAD_ROOT 上放一个跑着的会话，模拟「话题已在进行中」。 */
function seedThreadSession(overrides: Record<string, unknown> = {}): DaemonSession {
  const session: any = {
    sessionId: 'sess-thread-existing',
    chatId: GROUP,
    rootMessageId: THREAD_ROOT,
    title: '原标题',
    status: 'active',
    createdAt: new Date().toISOString(),
    chatType: 'group',
    larkAppId: APP,
    ownerOpenId: OWNER,
    workingDir: botmuxRepo,
    scope: 'thread',
  };
  const ds = {
    session,
    worker: { killed: false },
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: GROUP,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    workingDir: botmuxRepo,
    ...overrides,
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(THREAD_ROOT, APP), ds);
  return ds;
}

/** 话题内的一条回复消息。 */
function threadEvent(text: string, messageId: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: GROUP,
      chat_type: 'group',
      message_type: 'text',
      root_id: THREAD_ROOT,
      thread_id: 'omt_thread_1',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
      mentions: [{ key: '@_user_1', name: 'Claude', id: { open_id: BOT_OPEN_ID }, id_type: 'open_id' }],
    },
  };
}

function threadCtx(messageId: string): RoutingContext {
  return {
    chatId: GROUP,
    messageId,
    chatType: 'group',
    scope: 'thread',
    anchor: THREAD_ROOT,
    larkAppId: APP,
  } as RoutingContext;
}

describe('指令头：已有会话的话题里一律拒绝（D6）', () => {
  const refused: Array<{ name: string; text: string }> = [
    { name: '带仓库指令', text: '/t /repo homelab 换个仓库' },
    { name: '带模型指令', text: '/t /model sonnet 换个模型' },
    { name: '带标题', text: '新标题 /t 继续干活' },
    { name: '写错的头部', text: '新标题 /t /repo' },
  ];

  for (const { name, text } of refused) {
    it(`${name} → 回一句「只在新话题第一条生效」，会话状态一点不动`, async () => {
      const ds = seedThreadSession();

      await handleThreadReply(threadEvent(text, 'om_thread_header'), threadCtx('om_thread_header'));

      expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
      expect(mocks.forkWorker).not.toHaveBeenCalled();
      expect(ds.workingDir).toBe(botmuxRepo);
      expect(ds.session.title).toBe('原标题');
      expect(ds.spawnModelOverride).toBeUndefined();
      expect(ds.session.reasoningEffort).toBeUndefined();
      expect(sentContents()[0]).toContain('只在开新话题的第一条消息里生效');
    });
  }

  it('裸 /t 与 /t 文案不受影响：照旧当普通文字交给 CLI', async () => {
    seedThreadSession();

    await handleThreadReply(threadEvent('/t 继续干活', 'om_thread_plain'), threadCtx('om_thread_plain'));

    expect(sentContents().join('\n')).not.toContain('只在开新话题的第一条消息里生效');
    expect(mocks.sendWorkerInput).toHaveBeenCalled();
  });

  it('非 Claude 的 CLI（codex）上同样拒绝', async () => {
    registerAppBot({ cliId: 'codex' });
    const ds = seedThreadSession();

    await handleThreadReply(
      threadEvent('/t /model gpt-5.6-sol 换个模型', 'om_thread_codex'),
      threadCtx('om_thread_codex'),
    );

    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(ds.spawnModelOverride).toBeUndefined();
    expect(sentContents()[0]).toContain('只在开新话题的第一条消息里生效');
  });
});

describe('指令头：还没有会话的话题（手动转话题后的第一条）', () => {
  it('照常生效 —— 仓库 / 模型 / 标题逐项落地，且不重复开新话题', async () => {
    // 用户先手动把一条消息转成话题，再在话题里 @bot 发第一条：入站带 root_id + thread_id，
    // 但这个 anchor 上还没有会话，路由因此走 handleNewTopic（scope 已经是 thread）。
    expect(activeSessions.size).toBe(0);

    await handleNewTopic(
      threadEvent('线上排查 /t /repo homelab /model sonnet 看看告警', 'om_thread_first'),
      threadCtx('om_thread_first'),
    );

    const ds = forkedSession();
    expect(ds.workingDir).toBe(homelabRepo);
    expect(ds.session.title).toBe('线上排查');
    expect(sessionAgentConfig(ds, getBot(APP).config).model).toBe('sonnet');
    // scope 本来就是 thread，锚点保持在用户手动创建的那个话题根上。
    expect(ds.scope).toBe('thread');
    expect(ds.session.rootMessageId).toBe(THREAD_ROOT);
  });
});

describe('指令头：远端后端的 /model 能力门', () => {
  it('riff 后端拒绝 /model，而不是退化成往 pane 敲字', async () => {
    registerAppBot({
      cliId: 'codex',
      backendType: 'riff',
      riff: { baseUrl: 'https://riff.example.invalid' },
    });

    await handleNewTopic(
      groupEvent('/t /repo botmux /model gpt-5.6-sol 干活', 'om_riff_model'),
      groupCtx('om_riff_model'),
    );

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.createdSessions).toHaveLength(0);
    expect(sentContents()[0]).toContain('带不了模型');
  });

  it('mojo 远端后端能带模型 → 放行', async () => {
    registerAppBot({ cliId: 'mojo', defaultWorkingDir: botmuxRepo });

    await handleNewTopic(
      groupEvent('/t /model glm-5-turbo 干活', 'om_mojo_model'),
      groupCtx('om_mojo_model'),
    );

    const ds = forkedSession();
    expect(sessionAgentConfig(ds, getBot(APP).config).model).toBe('glm-5-turbo');
  });
});
