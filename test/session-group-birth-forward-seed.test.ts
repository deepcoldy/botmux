/**
 * 私聊 group 模式下「非文本种子」（转发消息集合 / 图片 / 文件）开群的两件事：
 *
 *  1. **群要自解释**：出生时把私聊原消息**转发**进新群当第一条消息。原来只发一条
 *     引言 + 正文摘录，而摘录只能摘 text —— 合并转发消息在那里被渲染成
 *     「（非文本消息）」，群里从此看不出自己是怎么来的。
 *  2. **AI 命名必须真的跑到**：birth 里唯一的文本来源是
 *     extractMessageTextForRouting，它只认 text/post，合并转发消息拿到的是 null。
 *     于是 scheduleSessionGroupTitle 收到空串 —— 而空串不是「白调一次」：title
 *     服务在**异步体内部**才 return，调用已经记了一次 attempt 并布下退避，三轮额度
 *     白烧一轮。表现就是转发消息开的群永远停在占位名，只能等后续文本消息自愈。
 *     修复后：出生侧对空串**不调度**，改由递归回来的 handleNewTopic 在消息**完整
 *     解析（合并转发已展开成 XML）之后**用真实内容调度一次。
 *
 * 用例跑**真实的建群递归**，只替身 createGroupWithBots（唯一的建群外部副作用）、
 * forwardMessage/sendMessage（飞书写接口）与 expandMergeForward（要联网拉子消息）。
 *
 * Run:  pnpm vitest run test/session-group-birth-forward-seed.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORWARDED_XML = [
  '<forwarded_messages>',
  '  <participants>',
  '    <p id="A" open_id="ou_peer" type="user" name="同事" />',
  '  </participants>',
  '  <msg from="A">同学帮忙添加下设备</msg>',
  '  <msg from="A">文档的步骤三</msg>',
  '</forwarded_messages>',
].join('\n');

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-sg-fwd-${process.pid}`;
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
    forwardMessage: vi.fn(async () => 'om_forwarded'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId?: string) => (
      openId ? { openId, type: 'user' as const } : undefined
    )),
    forkWorker: vi.fn(),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
    // 真身要按父 message_id 逐条拉子消息；替身只复刻它的**契约**：把
    // parsed.content 换成渲染好的 <forwarded_messages> XML 并改 msgType。
    expandMergeForward: vi.fn(async (_appId: string, _msgId: string, parsed: any) => {
      parsed.content = FORWARDED_XML;
      parsed.msgType = 'merge_forward_expanded';
      return { extraResources: [] };
    }),
    scheduleSessionGroupTitle: vi.fn(),
    createdSessions: [] as any[],
    createSession: vi.fn(function (chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') {
      const session = {
        sessionId: `sess-fwd-${++seq}`,
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
    forwardMessage: (...args: any[]) => mocks.forwardMessage(...args),
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
    getChatInfo: vi.fn(async () => ({ userCount: 1, botCount: 1 })),
    listChatBotMembers: vi.fn(async () => []),
    resolveAllowedUsersWithMap: vi.fn(async (_appId: string, users: string[]) => ({ resolved: users, map: new Map() })),
    sendUserMessage: vi.fn(async () => 'om_dm'),
    updateMessage: vi.fn(async () => undefined),
  };
});

vi.mock('../src/im/lark/merge-forward.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/merge-forward.js');
  return { ...actual, expandMergeForward: (...args: any[]) => mocks.expandMergeForward(...args) };
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

// 替身掉是为了能**数调用次数**：真身内部对 titled / in-flight 幂等，会把
// 「出生侧 + 解析后」重复调度这种回归掩盖掉。
vi.mock('../src/services/session-group-title.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-group-title.js');
  return { ...actual, scheduleSessionGroupTitle: (...args: any[]) => mocks.scheduleSessionGroupTitle(...args) };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
} from '../src/daemon.js';
import { initSessionGroups, getSessionGroup } from '../src/services/session-groups-store.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

const APP = 'sg_fwd_app';
const DM_CHAT = 'oc_dm_fwd_source';
const BORN_GROUP = 'oc_born_fwd_group';
const OWNER = 'ou_fwd_owner';
const DM_MSG = 'om_dm_forward_seed';

function mergeForwardDmEvent(messageId = DM_MSG): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: DM_CHAT,
      chat_type: 'p2p',
      message_type: 'merge_forward',
      content: JSON.stringify({ content: '[合并转发]' }),
      create_time: String(Date.now()),
    },
  };
}

function textDmEvent(text: string, messageId: string): any {
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
  };
}

/** 群里发出去的引言正文（sendMessage 的第三个参数）。 */
function introTexts(): string[] {
  return mocks.sendMessage.mock.calls
    .filter(c => c[1] === BORN_GROUP && (c[3] ?? 'text') === 'text')
    .map(c => String(c[2]));
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
  mocks.forwardMessage.mockResolvedValue('om_forwarded');
  mocks.getChatMode.mockResolvedValue('group');
  mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
  mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
  mocks.resolveSender.mockImplementation(async (_appId: string, openId?: string) => (
    openId ? { openId, type: 'user' as const } : undefined
  ));
  mocks.expandMergeForward.mockImplementation(async (_appId: string, _msgId: string, parsed: any) => {
    parsed.content = FORWARDED_XML;
    parsed.msgType = 'merge_forward_expanded';
    return { extraResources: [] };
  });
  mocks.createGroupWithBots.mockResolvedValue(createGroupResult());

  const workDir = join(mocks.dataDir, 'workdir');
  mkdirSync(workDir, { recursive: true });
  registerBot({
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    p2pMode: 'group',
    defaultWorkingDir: workDir,
    allowedUsers: [OWNER],
    // 群标签 / 群头像是 fire-and-forget 装饰步骤，与本用例无关且要联网。
    sessionGroup: { tag: { mode: 'off' }, avatar: 'off' },
  } as any);
  getBot(APP).resolvedAllowedUsers = [OWNER];
});

describe('会话群出生：转发消息集合种子', () => {
  it('把私聊原消息转发进新群，引言指向它而不是「（非文本消息）」', async () => {
    await handleNewTopic(mergeForwardDmEvent(), dmCtx(DM_MSG));

    // 转发用的是**原私聊消息 id**（资源/子消息都挂在它上面）+ 新群 chat_id。
    expect(mocks.forwardMessage).toHaveBeenCalledTimes(1);
    expect(mocks.forwardMessage.mock.calls[0].slice(0, 3)).toEqual([APP, DM_MSG, BORN_GROUP]);

    const intro = introTexts()[0];
    expect(intro).toContain('原消息已转发到本群');
    expect(intro).not.toContain('（非文本消息）');
    // 引言仍然 @ 发起人，群成员一眼看出是谁开的。
    expect(intro).toContain(`<at user_id="${OWNER}"></at>`);
  });

  it('AI 命名用展开后的转发正文调度一次（旧行为是空串 → 永远停在占位名）', async () => {
    await handleNewTopic(mergeForwardDmEvent(), dmCtx(DM_MSG));

    // 合并转发按**原私聊消息 id** 展开（子消息只认父 id）。
    expect(mocks.expandMergeForward).toHaveBeenCalledTimes(1);
    expect(mocks.expandMergeForward.mock.calls[0][1]).toBe(DM_MSG);

    expect(mocks.scheduleSessionGroupTitle).toHaveBeenCalledTimes(1);
    const arg = mocks.scheduleSessionGroupTitle.mock.calls[0][0];
    expect(arg).toMatchObject({ larkAppId: APP, chatId: BORN_GROUP });
    // 关键回归点：不是空串，且确实是展开后的转发内容。
    expect(arg.userText.trim()).not.toBe('');
    expect(arg.userText).toContain('同学帮忙添加下设备');
  });

  it('出生时的占位群名仍可接受（真名由 AI 命名异步替换）', async () => {
    await handleNewTopic(mergeForwardDmEvent(), dmCtx(DM_MSG));

    expect(mocks.createGroupWithBots).toHaveBeenCalledTimes(1);
    expect(mocks.createGroupWithBots.mock.calls[0][0].name).toBe('新会话');
    // 群已登记且仍未命名 —— 命名任务刚被调度出去。
    expect(getSessionGroup(BORN_GROUP)?.titled).toBeUndefined();
  });

  it('转发失败时降级成内联摘录引言，会话照常落在新群', async () => {
    mocks.forwardMessage.mockRejectedValue(new Error('forward not permitted'));

    await handleNewTopic(mergeForwardDmEvent(), dmCtx(DM_MSG));

    const intro = introTexts()[0];
    expect(intro).toContain('（非文本消息）');
    expect(mocks.createdSessions).toHaveLength(1);
    expect(mocks.createdSessions[0].chatId).toBe(BORN_GROUP);
    // 引言仍在群里 → 首轮回复锚点还在群内，不会漏回私聊。
    expect(mocks.createdSessions[0].rootMessageId).toBe('om_intro');
    // 命名照常用展开后的正文，跟转发成败无关。
    expect(mocks.scheduleSessionGroupTitle).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleSessionGroupTitle.mock.calls[0][0].userText).toContain('同学帮忙添加下设备');
  });

  it('转发成功但引言发失败时，锚点回落到转发进来的那条群内消息', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('send blocked'));

    await handleNewTopic(mergeForwardDmEvent(), dmCtx(DM_MSG));

    expect(mocks.createdSessions).toHaveLength(1);
    // 两条群内消息里只剩转发那条 —— 锚点必须落在它身上，而不是回落到私聊消息。
    expect(mocks.createdSessions[0].rootMessageId).toBe('om_forwarded');
    expect(mocks.createdSessions[0].rootMessageId).not.toBe(DM_MSG);
  });
});

describe('会话群出生：文本种子（对照）', () => {
  it('照旧在出生侧用原文调度一次，解析后不再重复调度', async () => {
    await handleNewTopic(textDmEvent('帮我修个登录超时的 bug', 'om_text_seed'), dmCtx('om_text_seed'));

    expect(mocks.scheduleSessionGroupTitle).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleSessionGroupTitle.mock.calls[0][0]).toEqual({
      larkAppId: APP,
      chatId: BORN_GROUP,
      userText: '帮我修个登录超时的 bug',
    });
    // 文本种子的占位名仍取原文前缀，不落到「新会话」。
    expect(mocks.createGroupWithBots.mock.calls[0][0].name).toBe('帮我修个登录超时的 bug');
  });

  it('文本种子也转发原消息（群里留下用户自己发的那一条）', async () => {
    await handleNewTopic(textDmEvent('帮我看看这个报错', 'om_text_fwd'), dmCtx('om_text_fwd'));

    expect(mocks.forwardMessage).toHaveBeenCalledTimes(1);
    expect(mocks.forwardMessage.mock.calls[0].slice(0, 3)).toEqual([APP, 'om_text_fwd', BORN_GROUP]);
    expect(introTexts()[0]).toContain('原消息已转发到本群');
  });
});

describe('会话群出生：sessionGroup.forwardOrigin=false', () => {
  it('关掉转发后只发引言，非文本种子回到「（非文本消息）」摘录', async () => {
    registerBot({
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      p2pMode: 'group',
      defaultWorkingDir: join(mocks.dataDir, 'workdir'),
      allowedUsers: [OWNER],
      sessionGroup: { tag: { mode: 'off' }, avatar: 'off', forwardOrigin: false },
    } as any);
    getBot(APP).resolvedAllowedUsers = [OWNER];

    await handleNewTopic(mergeForwardDmEvent('om_no_forward'), dmCtx('om_no_forward'));

    expect(mocks.forwardMessage).not.toHaveBeenCalled();
    expect(introTexts()[0]).toContain('（非文本消息）');
    // 命名不受开关影响：解析后的转发正文照样喂给 AI。
    expect(mocks.scheduleSessionGroupTitle).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleSessionGroupTitle.mock.calls[0][0].userText).toContain('同学帮忙添加下设备');
  });
});
