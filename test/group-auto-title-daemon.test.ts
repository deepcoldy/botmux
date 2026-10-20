/**
 * `/g --auto` 群的 AI 命名种子：daemon 两个入口（新话题 / 话题内回复）对已登记的
 * 群调度 scheduleGroupAutoTitle，口径与会话群相同，并额外守住多机器人群的两条边界：
 *
 *  - 只认真人消息：机器人发言（bootstrap / 协作指令）不代表群的主题；
 *  - 先剥开头的 @ 再过种子闸：多机器人群要 @ 才触发，`@Bot /status` 是命令不是内容；
 *  - 调度排在 prompt.submit 闸 / 配额之后：被闸拒掉的正文不能借命名发给模型。
 *
 * 跑真实的 handleNewTopic，只替身飞书写接口与 worker fork；scheduleGroupAutoTitle
 * 替身掉以便数调用次数，登记表用真身。
 *
 * Run:  bun run test -- test/group-auto-title-daemon.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-g-auto-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    dataDir,
    scheduleGroupAutoTitle: vi.fn(),
    evaluatePromptGate: vi.fn(async () => ({ allowed: true })),
    createSession: vi.fn(function (chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') {
      return {
        sessionId: `sess-g-auto-${++seq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
    }),
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

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_sent'),
    getMessageDetail: vi.fn(async (_app: string, id: string) => ({ items: [{ message_id: id, deleted: false }] })),
    getChatMode: vi.fn(async () => 'group'),
    getChatNameAndMode: vi.fn(async () => ({ name: '新会话 10/17 14:30', mode: 'group' as const })),
    getChatInfo: vi.fn(async () => ({ userCount: 1, botCount: 1 })),
    listChatBotMembers: vi.fn(async () => []),
    updateMessage: vi.fn(async () => undefined),
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return { ...actual, createSession: mocks.createSession, updateSession: vi.fn() };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return {
    ...actual,
    resolveSender: vi.fn(async (_appId: string, openId?: string) => (openId ? { openId, type: 'user' as const } : undefined)),
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: vi.fn() };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return { ...actual, downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })) };
});

vi.mock('../src/services/hook-runner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/hook-runner.js');
  return { ...actual, evaluatePromptGate: (...args: any[]) => mocks.evaluatePromptGate(...args) };
});

vi.mock('../src/services/group-auto-title.js', async () => {
  const actual = await vi.importActual<any>('../src/services/group-auto-title.js');
  return { ...actual, scheduleGroupAutoTitle: (...args: any[]) => mocks.scheduleGroupAutoTitle(...args) };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
} from '../src/daemon.js';
import { registerGroupAutoTitle } from '../src/services/group-auto-title.js';
import { __resetPeerCrossRefCacheForTest, writePeerCrossRef } from '../src/services/peer-cross-ref-store.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

const APP = 'g_auto_app';
const GROUP = 'oc_g_auto_group';
const PLAIN_GROUP = 'oc_g_plain_group';
const OWNER = 'ou_g_auto_owner';
const PEER_BOT = 'ou_g_auto_peer_bot';
let msgSeq = 0;

function groupEvent(chatId: string, text: string, opts: { senderType?: string; senderOpenId?: string; mentions?: any[] } = {}): any {
  return {
    sender: { sender_id: { open_id: opts.senderOpenId ?? OWNER }, sender_type: opts.senderType ?? 'user' },
    message: {
      message_id: `om_g_auto_${++msgSeq}`,
      chat_id: chatId,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
      ...(opts.mentions ? { mentions: opts.mentions } : {}),
    },
  };
}

function groupCtx(data: any): RoutingContext {
  return {
    chatId: data.message.chat_id,
    messageId: data.message.message_id,
    chatType: 'group',
    scope: 'chat',
    anchor: data.message.chat_id,
    larkAppId: APP,
  };
}

async function deliver(data: any): Promise<void> {
  // Later spawn steps are irrelevant here; the seed hook runs before them.
  await handleNewTopic(data, groupCtx(data)).catch(() => undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.evaluatePromptGate.mockImplementation(async () => ({ allowed: true }));
  mkdirSync(mocks.dataDir, { recursive: true });
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([]));
  activeSessions.clear();
  const workDir = join(mocks.dataDir, 'workdir');
  mkdirSync(workDir, { recursive: true });
  registerBot({
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    defaultWorkingDir: workDir,
    // The peer is allowed so its message really reaches the seed/gate path.
    allowedUsers: [OWNER, PEER_BOT],
  } as any);
  getBot(APP).resolvedAllowedUsers = [OWNER, PEER_BOT];
  rmSync(join(mocks.dataDir, `bot-openids-${APP}.json`), { force: true });
  __resetPeerCrossRefCacheForTest();
  rmSync(join(mocks.dataDir, `group-auto-title-${APP}.json`), { force: true });
  registerGroupAutoTitle(APP, GROUP, { placeholderName: '新会话 10/17 14:30' });
});

describe('/g --auto: daemon seed hook', () => {
  it('schedules from the first human message in a registered group', async () => {
    await deliver(groupEvent(GROUP, '帮我排查支付链路超时'));
    expect(mocks.scheduleGroupAutoTitle).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleGroupAutoTitle).toHaveBeenCalledWith({ larkAppId: APP, chatId: GROUP, userText: '帮我排查支付链路超时' });
  });

  it('strips leading @mentions so the seed is the content and `@Bot /cmd` stays a command', async () => {
    const mentions = [{ key: '@_user_1', id: { open_id: 'ou_bot_self' }, name: 'Claude' }];
    await deliver(groupEvent(GROUP, '@_user_1 /status', { mentions }));
    expect(mocks.scheduleGroupAutoTitle).not.toHaveBeenCalled();

    await deliver(groupEvent(GROUP, '@_user_1 看下这个报错', { mentions }));
    expect(mocks.scheduleGroupAutoTitle).toHaveBeenCalledWith({ larkAppId: APP, chatId: GROUP, userText: '看下这个报错' });
  });

  it('ignores bot senders and unregistered groups', async () => {
    await deliver(groupEvent(GROUP, '/role profile apply suite --quiet', { senderType: 'app' }));
    await deliver(groupEvent(GROUP, '这是机器人发的正文', { senderType: 'app' }));
    await deliver(groupEvent(PLAIN_GROUP, '普通群里的消息'));
    expect(mocks.scheduleGroupAutoTitle).not.toHaveBeenCalled();
  });

  it('does not title from a message the prompt.submit gate rejected', async () => {
    mocks.evaluatePromptGate.mockImplementation(async (_event: string, body: any) => (
      String(body?.content ?? '').includes('机密') ? { allowed: false, reason: 'blocked' } : { allowed: true }
    ));
    await deliver(groupEvent(GROUP, '这里有机密配置帮我看看'));
    expect(mocks.evaluatePromptGate).toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ chatId: GROUP }));
    expect(mocks.scheduleGroupAutoTitle).not.toHaveBeenCalled();

    await deliver(groupEvent(GROUP, '帮我看看登录报错'));
    expect(mocks.scheduleGroupAutoTitle).toHaveBeenCalledWith({ larkAppId: APP, chatId: GROUP, userText: '帮我看看登录报错' });
  });

  it('ignores a known peer bot even when Lark stamps it sender_type=user', async () => {
    writePeerCrossRef(mocks.dataDir, APP, { codex: PEER_BOT });
    await deliver(groupEvent(GROUP, '我来接手这个任务，先看下仓库结构', { senderOpenId: PEER_BOT }));
    expect(mocks.evaluatePromptGate).toHaveBeenCalled();
    expect(mocks.scheduleGroupAutoTitle).not.toHaveBeenCalled();
  });

  it('seeds only from the text the gate validated: the /t prompt, never its title segment', async () => {
    await deliver(groupEvent(GROUP, '敏感标题 /t 帮我看看登录报错'));
    expect(mocks.evaluatePromptGate).toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ content: '帮我看看登录报错' }));
    expect(mocks.scheduleGroupAutoTitle).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleGroupAutoTitle).toHaveBeenCalledWith({ larkAppId: APP, chatId: GROUP, userText: '帮我看看登录报错' });
  });

  it('does not title from a setup-only /t, which skips the prompt gate', async () => {
    await deliver(groupEvent(GROUP, '敏感标题 /t'));
    expect(mocks.scheduleGroupAutoTitle).not.toHaveBeenCalled();
  });
});
