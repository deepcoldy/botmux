/**
 * 免@ 斜杠命令的**行为定义**落地测试。
 *
 * 前两个测试文件覆盖的是「判定」（哪条命令、在哪个群、放不放行）；这里覆盖的是
 * 判定之后真正决定 Agent 干什么的那一步：配置的 prompt 模板必须替换掉用户原文，
 * 再进会话。没有这一层，`/solve` 只是 `<user_message>` 里的一段纯文本，CLI 的
 * slash 解析器根本不会触发，行为完全由模型自由发挥。
 *
 * 跑真实 handleNewTopic 路由，断言落库会话的标题 —— 它取自注入 CLI 的正文，
 * 是这条链路上最靠近 CLI 的可观测点。
 *
 * Run:  npx vitest run test/command-trigger-prompt-route.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/botmux-command-trigger-route-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  const created: any[] = [];
  return {
    created,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    forkWorker: vi.fn(),
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => {
      const s = {
        sessionId: `sess-fake-${++seq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
      created.push(s);
      return s;
    }),
    updateSession: vi.fn(),
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

import { registerBot } from '../src/bot-registry.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';

const APP = 'command_trigger_route_app';
const CHAT = 'oc_command_trigger_route_chat';
const USER = 'ou_group_member';

function makeEventData(messageId: string, text: string): any {
  return {
    sender: { sender_id: { open_id: USER, union_id: `on_${USER}` }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(messageId: string, commandTrigger?: any): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'chat' as const,
    anchor: messageId,
    larkAppId: APP,
    ...(commandTrigger ? { commandTrigger } : {}),
  };
}

describe('handleNewTopic — 免@ 斜杠命令的 prompt 模板', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.created.length = 0;
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [USER],
      workingDir: '/tmp',
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [USER];
  });

  it('模板替换掉用户原文，{args} 收到命令后面那段', async () => {
    await handleNewTopic(
      makeEventData('om_cmd_1', '/solve 登录接口 500'),
      makeCtx('om_cmd_1', { cmd: '/solve', prompt: '先复现再改：{args}', args: '登录接口 500' }),
    );

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.created[0].title).toBe('先复现再改：登录接口 500');
  });

  it('模板里没有 {args} 时把参数追加在末尾，不静默丢掉用户输入', async () => {
    await handleNewTopic(
      makeEventData('om_cmd_2', '/solve 登录接口 500'),
      makeCtx('om_cmd_2', { cmd: '/solve', prompt: '按排查规范处理', args: '登录接口 500' }),
    );

    expect(mocks.created[0].title).toBe('按排查规范处理\n\n登录接口 500');
  });

  it('没配模板时保留用户原文（行为回退到「原文进会话」）', async () => {
    await handleNewTopic(
      makeEventData('om_cmd_3', '/solve 登录接口 500'),
      makeCtx('om_cmd_3', { cmd: '/solve', args: '登录接口 500' }),
    );

    expect(mocks.created[0].title).toBe('/solve 登录接口 500');
  });

  it('对照组：非命令触发的普通消息完全不受影响', async () => {
    await handleNewTopic(
      makeEventData('om_plain_1', '帮我看下登录接口'),
      makeCtx('om_plain_1'),
    );

    expect(mocks.created[0].title).toBe('帮我看下登录接口');
  });
});

/**
 * 续聊路径 —— 这才是本特性的主场景：群里已经有会话时，裸命令要把**模板渲染后的
 * 正文**喂进那个会话，而不是新开一个。断言直接落在投给 worker 的消息上。
 */
describe('handleThreadReply — 免@ 命令投进已有会话', () => {
  function seedLiveChatSession(send = vi.fn()): DaemonSession {
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
        sessionId: 'sess-live-' + Math.random().toString(36).slice(2),
        chatId: CHAT,
        rootMessageId: 'om_original_root',
        title: '既有会话',
        status: 'active',
        createdAt: new Date().toISOString(),
        larkAppId: APP,
        scope: 'chat',
      },
    } as unknown as DaemonSession;
    activeSessions.set(sessionKey(CHAT, APP), ds);
    return ds;
  }

  function threadCtx(messageId: string, commandTrigger?: any): any {
    return {
      chatId: CHAT,
      messageId,
      chatType: 'group' as const,
      scope: 'chat' as const,
      anchor: CHAT,
      larkAppId: APP,
      ...(commandTrigger ? { commandTrigger } : {}),
    };
  }

  function sentText(send: ReturnType<typeof vi.fn>): string {
    return JSON.stringify(send.mock.calls.filter(c => c[0]?.type === 'message'));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.created.length = 0;
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [USER],
      workingDir: '/tmp',
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [USER];
  });

  it('把模板渲染结果喂进已有会话，且不新建会话', async () => {
    const send = vi.fn();
    seedLiveChatSession(send);

    await handleThreadReply(
      makeEventData('om_thread_1', '/solve 登录接口 500'),
      threadCtx('om_thread_1', { cmd: '/solve', prompt: '先复现再改：{args}', args: '登录接口 500' }),
    );

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(sentText(send)).toContain('先复现再改：登录接口 500');
    expect(sentText(send)).not.toContain('/solve 登录接口 500');
  });

  it('没配模板时把用户原文喂进已有会话', async () => {
    const send = vi.fn();
    seedLiveChatSession(send);

    await handleThreadReply(
      makeEventData('om_thread_2', '/solve 登录接口 500'),
      threadCtx('om_thread_2', { cmd: '/solve', args: '登录接口 500' }),
    );

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(sentText(send)).toContain('/solve 登录接口 500');
  });
});
