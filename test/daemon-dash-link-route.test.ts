/**
 * `/dash`（=/dashboard link）daemon 端到端路由测试。
 *
 * 跑真实 handleNewTopic（话题群种子 / p2p），断言：
 *  - 命中 sessionless daemon 路径：不调 createSession、不 forkWorker（因此
 *    auto-worktree 流程根本没有触发机会）；
 *  - 链接通过私密通道（普通群 requester-only ephemeral 临时卡；话题群/话题回复/p2p 私信）投递；
 *  - 每次现读 token 文件：轮换后再次执行返回新链接。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const home = `${process.env.TMPDIR ?? '/tmp'}/botmux-dash-route-${process.pid}`;
  process.env.HOME = home;
  process.env.SESSION_DATA_DIR = `${home}/sdata`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return {
    home,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    sendUserMessage: vi.fn(async () => 'om_dm'),
    sendEphemeralCard: vi.fn(async () => 'om_eph'),
    getChatMode: vi.fn(async () => 'topic' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'topic' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    forkWorker: vi.fn(),
    resolveInboundAudio: vi.fn(async () => ({ kind: 'not_audio' as const })),
    createSession: vi.fn(),
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
    sendUserMessage: mocks.sendUserMessage,
    sendEphemeralCard: mocks.sendEphemeralCard,
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

vi.mock('../src/im/lark/audio-transcribe.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/audio-transcribe.js');
  return { ...actual, resolveInboundAudio: (...args: any[]) => mocks.resolveInboundAudio(...args) };
});

import { registerBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
} from '../src/daemon.js';

const APP = 'dash_route_app';
const CHAT = 'oc_dash_route_chat';
const P2P = 'oc_dash_route_p2p';
const USER = 'ou_dash_route_user';

function writeCredentialFiles(token: string, port = '7900') {
  writeFileSync(join(mocks.home, '.botmux', '.dashboard-token'), token, { mode: 0o600 });
  writeFileSync(join(mocks.home, '.botmux', '.dashboard-port'), port);
}

function makeEventData(messageId: string, text: string, chatId = CHAT, chatType: 'group' | 'p2p' = 'group', rootId?: string): any {
  return {
    sender: { sender_id: { open_id: USER, union_id: `on_${USER}` }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: rootId,
      thread_id: rootId,
      chat_id: chatId,
      chat_type: chatType,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(messageId: string, over: any = {}): any {
  return {
    chatId: over.chatId ?? CHAT,
    messageId,
    chatType: over.chatType ?? ('group' as const),
    scope: over.scope ?? ('thread' as const),
    anchor: over.anchor ?? messageId,
    larkAppId: APP,
  };
}

describe('handleNewTopic — /dash 不建会话的端到端路由', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChatMode.mockResolvedValue('topic');
    mkdirSync(join(mocks.home, '.botmux'), { recursive: true, mode: 0o700 });
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [USER],
      workingDir: '/tmp',
      defaultWorkingDir: '/tmp',
      defaultWorkingDirAutoWorktree: true,
    });
    bot.resolvedAllowedUsers = [USER];
    writeCredentialFiles('dash-token-one');
  });

  it('话题群顶层裸 /dash：私信带链接（话题群不支持 ephemeral），0 会话 0 CLI fork', async () => {
    await handleNewTopic(
      makeEventData('om_dash_topic_1', '/dash'),
      makeCtx('om_dash_topic_1'),
    );

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.sendEphemeralCard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.sendUserMessage).toHaveBeenCalledOnce());
    const [, openId, dmText] = mocks.sendUserMessage.mock.calls[0];
    expect(openId).toBe(USER);
    expect(dmText).toContain('http://');
    expect(dmText).toContain('?t=dash-token-one#/');
    expect(dmText).toContain(':7900/');
  });

  it('@Bot /dash（dispatcher 剥 @ 后）结果相同', async () => {
    await handleNewTopic(
      makeEventData('om_dash_topic_2', '/dash'),
      makeCtx('om_dash_topic_2'),
    );

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.sendUserMessage).toHaveBeenCalledOnce());
  });

  it('p2p /dash：直接在私聊回复完整链接，不尝试 ephemeral/DM', async () => {
    mocks.getChatMode.mockResolvedValue('p2p');
    await handleNewTopic(
      makeEventData('om_dash_p2p_1', '/dash', P2P, 'p2p'),
      makeCtx('om_dash_p2p_1', { chatId: P2P, chatType: 'p2p', scope: 'chat', anchor: P2P }),
    );

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.sendEphemeralCard).not.toHaveBeenCalled();
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
    // chat-scope p2p replies go through sendMessage; wait for the detached
    // sessionless command to deliver, then accept either reply sink.
    await vi.waitFor(() => expect(
      mocks.replyMessage.mock.calls.length + mocks.sendMessage.mock.calls.length,
    ).toBeGreaterThan(0));
    const replied = JSON.stringify([
      ...mocks.replyMessage.mock.calls,
      ...mocks.sendMessage.mock.calls,
    ]);
    expect(replied).toContain('?t=dash-token-one#/');
  });

  it('/dashboard link 与 /dash 等价（话题群）', async () => {
    await handleNewTopic(
      makeEventData('om_dash_topic_3', '/dashboard link'),
      makeCtx('om_dash_topic_3'),
    );

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.sendUserMessage).toHaveBeenCalledOnce());
    expect(mocks.sendUserMessage.mock.calls[0][2]).toContain('?t=dash-token-one#/');
  });

  it('普通群 /dash 走 ephemeral；token 轮换后再次执行返回新 token，端口换了也换', async () => {
    mocks.getChatMode.mockResolvedValue('group');
    await handleNewTopic(makeEventData('om_dash_rot_1', '/dash'), makeCtx('om_dash_rot_1'));
    await vi.waitFor(() => expect(mocks.sendEphemeralCard).toHaveBeenCalledOnce());
    expect(mocks.sendEphemeralCard.mock.calls[0][3]).toContain('?t=dash-token-one#/');

    writeCredentialFiles('dash-token-two', '8123');
    await handleNewTopic(makeEventData('om_dash_rot_2', '/dash'), makeCtx('om_dash_rot_2'));
    await vi.waitFor(() => expect(mocks.sendEphemeralCard).toHaveBeenCalledTimes(2));
    const card2 = mocks.sendEphemeralCard.mock.calls.at(-1)![3] as string;
    expect(card2).toContain('?t=dash-token-two#/');
    expect(card2).not.toContain('dash-token-one');
    expect(card2).toContain(':8123/');
  });

  it('非 allowedUsers 的命令在会话层之前即被 dispatcher 挡掉（daemon 层仍有 canOperate 闸）', async () => {
    const event = makeEventData('om_dash_deny_1', '/dash');
    event.sender.sender_id.open_id = 'ou_stranger';
    await handleNewTopic(event, makeCtx('om_dash_deny_1'));

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.sendEphemeralCard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(
      mocks.replyMessage.mock.calls.length + mocks.sendMessage.mock.calls.length,
    ).toBeGreaterThan(0));
    const replied = JSON.stringify([
      ...mocks.replyMessage.mock.calls,
      ...mocks.sendMessage.mock.calls,
    ]);
    expect(replied).not.toContain('dash-token');
  });
});
