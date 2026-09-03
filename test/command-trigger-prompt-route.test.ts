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

/**
 * 真正喂进 CLI 的开场正文 —— 被当成命令时压根走不到 forkWorker，所以这是
 * 「当命令还是当正文」的判据；只看会话标题不行，daemon 命令分支同样用
 * cmdContent 建会话，标题会一模一样。
 *
 * 深度收集入参里的字符串而非 JSON.stringify：后者把换行转义成字面量 \\n，
 * 多行正文的断言会永远为假（真机行为正确却测红）。
 */
function cliInput(): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(mocks.forkWorker.mock.calls);
  return out.join('\n---\n');
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

  // 三道闸校验的是**触发词**（/solve），但渲染后的正文里第一段是用户自己敲的。
  // `{args}` 打头的模板会把用户输入顶到命令位置——命令解析必须只看触发词原文，
  // 否则「保留命令必须 @」这条闸在参数里被绕过。
  it('{args} 打头的模板不让用户参数占据命令位（新话题路径）', async () => {
    await handleNewTopic(
      makeEventData('om_inject_1', '/solve /clear'),
      makeCtx('om_inject_1', { cmd: '/solve', prompt: '{args}', args: '/clear' }),
    );

    // /clear 是透传命令：一旦被当命令解析就会走 raw_input 直接清 CLI 上下文，
    // 而不是新建一个会话。会话被正常创建 == 它只是普通正文。
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.created[0].title).toBe('/clear');
  });

  it('{args} 打头的模板不让用户参数触发 /t 另起话题', async () => {
    await handleNewTopic(
      makeEventData('om_inject_2', '/solve /t 新话题'),
      makeCtx('om_inject_2', { cmd: '/solve', prompt: '{args}', args: '/t 新话题' }),
    );

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.created[0].title).toBe('/t 新话题');
  });

  // 评审矩阵里的其余形态：修法是结构性的（命令车道永远看不到渲染结果），
  // 所以它们塌缩到同一条代码路径；仍逐个钉住，防止将来有人把车道又并回去。
  it.each([
    ['{args}', '/close', '/close'],
    ['{args} 顺便跑下测试', '/clear', '/clear 顺便跑下测试'],
    ['{args}', '/cd /etc', '/cd /etc'],
  ])('模板 %s + 参数 %s 只当正文', async (prompt, args, expected) => {
    const id = `om_matrix_${Buffer.from(prompt + args).toString('hex').slice(0, 10)}`;
    await handleNewTopic(
      makeEventData(id, `/solve ${args}`),
      makeCtx(id, { cmd: '/solve', prompt, args }),
    );

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.created[0].title).toBe(expected);
    // 标题单独不足以判定：daemon 命令分支同样用 cmdContent 建会话，标题会一样。
    // 真判据是正文有没有作为 prompt 喂进 CLI —— 被当命令时根本不会 fork worker。
    expect(cliInput()).toContain(expected);
  });

  // 复审补充的两类：MULTILINE_COMMANDS（/schedule /role /fork，parser 对它们接受
  // 多行）与 /t /topic（parseForceTopicInvocation 的正则吃 [\s\S]*，多行挡不住）。
  // 车道分离对它们同样成立——所有解析器读的都是 cmdContent。
  it.each([
    ['/schedule'], ['/role'], ['/fork'],
  ])('`{args}\\n\\n后缀` 形态下 %s 也不占据命令位', async (cmd) => {
    const id = `om_multiline_${cmd.slice(1)}`;
    await handleNewTopic(
      makeEventData(id, `/solve ${cmd}`),
      makeCtx(id, { cmd: '/solve', prompt: '{args}\n\n后缀', args: cmd }),
    );

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.created[0].title).toBe(`${cmd}\n\n后缀`);
    expect(cliInput()).toContain(`${cmd}\n\n后缀`);
  });

  // force-topic 的拦截点在 slash parse 之前、且吃多行，所以单独钉住「路由没被改」
  // 这个更强的判据，而不只是标题。
  it('{args} + /t 不把群会话改道成话题会话', async () => {
    await handleNewTopic(
      makeEventData('om_ft_1', '/solve /t 新话题'),
      makeCtx('om_ft_1', { cmd: '/solve', prompt: '{args}', args: '/t 新话题' }),
    );

    expect(mocks.created[0].scope).toBe('chat');
  });

  it('{args}\n\n后缀 + /t 同样不改道（多行挡不住 force-topic 正则）', async () => {
    await handleNewTopic(
      makeEventData('om_ft_2', '/solve /t 新话题'),
      makeCtx('om_ft_2', { cmd: '/solve', prompt: '{args}\n\n后缀', args: '/t 新话题' }),
    );

    expect(mocks.created[0].scope).toBe('chat');
    expect(mocks.created[0].title).toBe('/t 新话题\n\n后缀');
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

  it('{args} 打头的模板不让用户参数占据命令位（续聊路径）', async () => {
    const send = vi.fn();
    seedLiveChatSession(send);

    await handleThreadReply(
      makeEventData('om_inject_3', '/solve /clear'),
      threadCtx('om_inject_3', { cmd: '/solve', prompt: '{args}', args: '/clear' }),
    );

    // 被当成命令时投出去的是 {type:'raw_input'}；当成正文时是 {type:'message'}。
    const kinds = send.mock.calls.map(c => c[0]?.type);
    expect(kinds).not.toContain('raw_input');
    expect(kinds).toContain('message');
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
