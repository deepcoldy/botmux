/**
 * `/g --start` 的真实 daemon 接线：从 handleNewTopic 进入 commandDeps 与
 * enforceMessageQuotaForCliInput，只替身飞书外部 API、建群和最终 spawn。
 * 纯函数测试覆盖不到这里的 prompt.submit 实参、发送者身份与会话 owner。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-group-task-admission-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let sessionSeq = 0;
  return {
    dataDir,
    evaluatePromptGate: vi.fn(async () => ({ allowed: true })),
    createSession: vi.fn(function (chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') {
      return {
        sessionId: `sess-group-task-${++sessionSeq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
    }),
    createGroup: vi.fn(async (opts: any) => {
      if (opts.deferUserInvites) await opts.onChatCreated?.('oc_group_task_new');
      return {
        ok: true as const, chatId: 'oc_group_task_new', creator: opts.creatorLarkAppId,
        invalidBotIds: [], invalidUserIds: [], invalidOwnerUnionIds: [],
        ownerTransferredTo: opts.transferOwnerTo ?? null, transferError: null,
        managersAdded: [], managerError: null, notifyMessageId: null, notifyError: null,
        shareLink: null, shareLinkError: null, oncallBindings: [],
        roleProfileBootstrapMessageId: null, roleProfileBootstrapError: null,
        kickoffMessageId: null, kickoffError: null,
      };
    }),
    spawn: vi.fn(async (activeSessions: Map<string, any>, _refresh: unknown, args: any) => {
      const sessionId = 'sess_group_task';
      activeSessions.set(`${args.chatId}::${args.larkAppId}`, {
        session: { sessionId, queued: true, status: 'active' },
        worker: null,
        pendingRepo: false,
        initialStartPending: false,
      });
      return { ok: true as const, sessionId };
    }),
    activate: vi.fn(async (ds: any) => {
      ds.session.queued = false;
      ds.worker = { killed: false };
      return { ok: true };
    }),
    getMessageDetail: vi.fn(),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class FakeClient {} }));
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() })),
}));
vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_sent'),
    getMessageDetail: mocks.getMessageDetail,
    getChatMode: vi.fn(async () => 'group'),
    getChatName: vi.fn(async () => 'Source'),
    getChatNameAndMode: vi.fn(async () => ({ name: 'Source', mode: 'group' as const })),
    getChatInfo: vi.fn(async () => ({ userCount: 1, botCount: 1 })),
    listChatBotMembers: vi.fn(async () => []),
    updateMessage: vi.fn(async () => undefined),
    forwardMessage: vi.fn(async () => 'om_forwarded'),
  };
});
vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: vi.fn() };
});
vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return { ...actual, createSession: mocks.createSession, updateSession: vi.fn() };
});
vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
    spawnDashboardSession: mocks.spawn,
    activateQueuedSession: mocks.activate,
  };
});
vi.mock('../src/services/hook-runner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/hook-runner.js');
  return { ...actual, evaluatePromptGate: (...args: any[]) => mocks.evaluatePromptGate(...args) };
});
vi.mock('../src/services/group-auto-title.js', async () => {
  const actual = await vi.importActual<any>('../src/services/group-auto-title.js');
  return { ...actual, scheduleGroupAutoTitle: vi.fn(), registerGroupAutoTitle: vi.fn() };
});
vi.mock('../src/services/group-creator.js', async () => {
  const actual = await vi.importActual<any>('../src/services/group-creator.js');
  return { ...actual, createGroupWithBots: mocks.createGroup };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { __testOnly_activeSessions as activeSessions, __testOnly_handleNewTopic as handleNewTopic } from '../src/daemon.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';
import { applyPlatformTeamSync } from '../src/services/platform-team-store.js';

const APP = 'group_task_admission_app';
const GROUP = 'oc_group_task_source';
const OWNER = 'ou_group_task_owner';
const BOT = 'ou_group_task_sender_bot';
let seq = 0;

function event(content: string, opts: {
  type?: string;
  senderType?: string;
  senderOpenId?: string;
  senderUnionId?: string;
  senderAppId?: string;
  parentId?: string;
  mentions?: any[];
} = {}): any {
  return {
    sender: {
      sender_id: {
        open_id: opts.senderOpenId ?? OWNER,
        union_id: opts.senderUnionId ?? 'on_group_task_sender',
        ...(opts.senderAppId ? { app_id: opts.senderAppId } : {}),
      },
      sender_type: opts.senderType ?? 'user',
    },
    message: {
      message_id: `om_group_task_${++seq}`,
      chat_id: GROUP,
      chat_type: 'group',
      message_type: opts.type ?? 'text',
      content: opts.type === 'post' ? content : JSON.stringify({ text: content }),
      create_time: String(Date.now()),
      ...(opts.mentions ? { mentions: opts.mentions } : {}),
      ...(opts.parentId ? { parent_id: opts.parentId } : {}),
    },
  };
}

function ctx(data: any): RoutingContext {
  return {
    chatId: GROUP,
    messageId: data.message.message_id,
    chatType: 'group',
    scope: 'chat',
    anchor: GROUP,
    larkAppId: APP,
  };
}

async function gatePayloadFor(data: any): Promise<any> {
  await handleNewTopic(data, ctx(data));
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  return mocks.evaluatePromptGate.mock.calls[0]?.[1];
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
    allowedUsers: [OWNER, BOT],
  } as any);
  getBot(APP).resolvedAllowedUsers = [OWNER, BOT];
  rmSync(join(mocks.dataDir, `bot-openids-${APP}.json`), { force: true });
});

afterEach(() => {
  rmSync(mocks.dataDir, { recursive: true, force: true });
});

describe('/g task admission through the real new-topic entry', () => {
  it('passes command attachment metadata and human sender identity to prompt.submit', async () => {
    const post = JSON.stringify({ title: '', content: [[
      { tag: 'text', text: '/g --start inspect attachment' },
      { tag: 'file', file_key: 'file_env', file_name: 'prod.env' },
    ]] });

    const payload = await gatePayloadFor(event(post, { type: 'post' }));

    expect(payload).toMatchObject({
      botSender: false,
      memberUnionId: 'on_group_task_sender',
      attachments: [{ type: 'file', name: 'prod.env' }],
    });
    expect(payload.content).toContain('inspect attachment');
    expect(payload.senderUnionId).toBeUndefined();
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({
      ownerOpenId: OWNER,
      creatorOpenId: OWNER,
      ownerUnionId: 'on_group_task_sender',
      column: 'backlog',
    });
  });

  it('resolves quoted task text and attachments before prompt.submit', async () => {
    const quotedPost = JSON.stringify({ title: '', content: [[
      { tag: 'text', text: '机密任务' },
      { tag: 'file', file_key: 'file_quote', file_name: 'quoted.env' },
    ]] });
    mocks.getMessageDetail.mockResolvedValue({ items: [{
      message_id: 'om_secret_quote',
      msg_type: 'post',
      body: { content: quotedPost },
      sender: { id: OWNER, sender_type: 'user' },
      create_time: '1',
    }] });

    const payload = await gatePayloadFor(event('/g --start', { parentId: 'om_secret_quote' }));

    expect(payload.content).toContain('机密任务');
    expect(payload.attachments).toEqual([{ type: 'file', name: 'quoted.env' }]);
    expect(mocks.getMessageDetail).toHaveBeenCalledTimes(1);
  });

  it('preserves a bot sender in prompt.submit', async () => {
    const payload = await gatePayloadFor(event('/g --start delegated task', {
      senderType: 'app',
      senderOpenId: BOT,
    }));

    expect(payload).toMatchObject({
      botSender: true,
      senderUnionId: 'on_group_task_sender',
    });
    expect(payload.memberUnionId).toBeUndefined();
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({
      ownerOpenId: null,
      creatorOpenId: BOT,
      column: 'backlog',
    });
    expect(mocks.spawn.mock.calls[0][2].ownerUnionId).toBeUndefined();
  });

  it('routes multiline text by the first creator instead of the receiver autoStart setting', async () => {
    const workDir = join(mocks.dataDir, 'workdir');
    registerBot({
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      defaultWorkingDir: workDir,
      allowedUsers: [OWNER, BOT],
      groupCreation: { autoStart: true },
    } as any);
    getBot(APP).resolvedAllowedUsers = [OWNER, BOT];
    writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([
      { larkAppId: 'creator_app', larkAppSecret: 'a', cliId: 'claude-code', groupCreation: { autoStart: false } },
      { larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code', defaultWorkingDir: workDir, groupCreation: { autoStart: true } },
    ]));
    writeFileSync(join(mocks.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'creator_app', botName: 'A' },
      { larkAppId: APP, botName: 'Receiver' },
    ]));
    const mentions = [
      { key: '@_user_1', id: { open_id: 'ou_creator' }, name: 'A' },
      { key: '@_user_2', id: { open_id: 'ou_receiver' }, name: 'Receiver' },
    ];
    const data = event('@_user_1 @_user_2 /g 排查价格\n第二行细节', { mentions });

    await handleNewTopic(data, ctx(data));

    await vi.waitFor(() => expect(mocks.evaluatePromptGate).toHaveBeenCalled());
    expect(mocks.createGroup).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('passes the Lark-stamped appId through external-roster authorization', async () => {
    const workDir = join(mocks.dataDir, 'workdir');
    registerBot({
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      defaultWorkingDir: workDir,
      allowedUsers: [OWNER],
    } as any);
    getBot(APP).resolvedAllowedUsers = [OWNER];
    applyPlatformTeamSync(mocks.dataDir, {
      rev: 'r-group-task-external',
      teams: [{
        teamId: 't1',
        teamName: 'T1',
        groupChatIds: [],
        bots: [
          { appId: APP, unionId: 'on_receiver' },
          { appId: 'cli_external_sender', unionId: 'on_external_sender', external: true },
        ],
        memberUnionIds: [],
      }],
    });

    const payload = await gatePayloadFor(event('/g --start external task', {
      senderType: 'app',
      senderOpenId: BOT,
      senderUnionId: 'on_external_sender',
      senderAppId: 'cli_external_sender',
    }));

    expect(payload).toMatchObject({ botSender: true, senderUnionId: 'on_external_sender' });
    expect(mocks.createGroup).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ ownerOpenId: null, creatorOpenId: BOT });
  });
});
