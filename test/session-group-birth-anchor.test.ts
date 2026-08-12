/**
 * Route-level regression guard for session-group birth message anchoring
 * (PR review P1).
 *
 * After maybeBirthSessionGroup re-homes a DM turn into the freshly-created
 * group, handleNewTopic must keep TWO ids apart:
 *   - `ctx.messageId` — the ORIGINAL inbound DM message. Resource downloads
 *     and merge-forward expansion must use it: image/file keys and sub-message
 *     ids belong to the source message, and calling the resource API with any
 *     other message id fails.
 *   - `ctx.replyAnchorMessageId` — the in-group intro message. Quote target
 *     and the session's stored rootMessageId use it so the first turn's
 *     replies land in the group instead of leaking back to the DM.
 *
 * These tests drive the REAL handleNewTopic with a post-birth context shape
 * (sessionGroupBirth=true, group chatId, DM-shaped event data) and assert the
 * split — plus a non-birth control so the default path stays keyed on the
 * inbound message id.
 *
 * Run:  pnpm vitest run test/session-group-birth-anchor.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-sg-anchor-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    dataDir,
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
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
    expandMergeForward: vi.fn(async () => ({ extraResources: [] })),
    createdSessions: [] as any[],
    createSession: vi.fn(function (chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') {
      const session = {
        sessionId: `sess-fake-${++seq}`,
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

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return { ...actual, downloadResources: (...args: any[]) => mocks.downloadResources(...args) };
});

vi.mock('../src/im/lark/merge-forward.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/merge-forward.js');
  return { ...actual, expandMergeForward: (...args: any[]) => mocks.expandMergeForward(...args) };
});

import { registerBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
} from '../src/daemon.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

const APP = 'sg_anchor_app';
const GROUP_CHAT = 'oc_session_group_chat';
const DM_CHAT = 'oc_dm_source_chat';
const OWNER = 'ou_owner';
const SOURCE_MSG = 'om_source_dm_message';
const INTRO_MSG = 'om_group_intro_message';

function birthCtx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    chatId: GROUP_CHAT,
    messageId: SOURCE_MSG,
    chatType: 'group',
    scope: 'chat',
    anchor: GROUP_CHAT,
    larkAppId: APP,
    replyRootId: undefined,
    sessionGroupBirth: true,
    sessionGroupQuotaConsumed: true,
    replyAnchorMessageId: INTRO_MSG,
    ...overrides,
  };
}

/** Post-birth event data keeps its ORIGINAL DM shape (chat_id = the DM). */
function makeImageEventData(): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: SOURCE_MSG,
      chat_id: DM_CHAT,
      chat_type: 'p2p',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_v3_test_key' }),
      create_time: String(Date.now()),
    },
  };
}

function makeMergeForwardEventData(): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: SOURCE_MSG,
      chat_id: DM_CHAT,
      chat_type: 'p2p',
      message_type: 'merge_forward',
      content: JSON.stringify({ content: '[合并转发]' }),
      create_time: String(Date.now()),
    },
  };
}

beforeEach(() => {
  mkdirSync(mocks.dataDir, { recursive: true });
  // Bind the group to a working dir so the flow skips the repo-select card and
  // reaches the session-creation block deterministically.
  const workDir = join(mocks.dataDir, 'workdir');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([{
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    workingDir: workDir,
    defaultWorkingDir: workDir,
    allowedUsers: [OWNER],
    oncallChats: [{ chatId: GROUP_CHAT, workingDir: workDir }],
  }]));
  registerBot({
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    workingDir: workDir,
    defaultWorkingDir: workDir,
    allowedUsers: [OWNER],
    oncallChats: [{ chatId: GROUP_CHAT, workingDir: workDir }],
  } as any);
  activeSessions.clear();
  mocks.createdSessions.length = 0;
  mocks.downloadResources.mockClear();
  mocks.expandMergeForward.mockClear();
  mocks.createSession.mockClear();
});

describe('session-group birth first-turn anchoring (image/file/merge_forward)', () => {
  it('downloads first-turn image resources with the ORIGINAL DM message id, not the intro anchor', async () => {
    await handleNewTopic(makeImageEventData(), birthCtx());

    expect(mocks.downloadResources).toHaveBeenCalledTimes(1);
    const [, downloadMessageId, resources] = mocks.downloadResources.mock.calls[0];
    expect(downloadMessageId).toBe(SOURCE_MSG);
    expect(downloadMessageId).not.toBe(INTRO_MSG);
    // The image resource itself parsed out of the source message.
    expect(Array.isArray(resources)).toBe(true);
  });

  it('expands merge-forward sub-messages against the ORIGINAL DM message id', async () => {
    await handleNewTopic(makeMergeForwardEventData(), birthCtx());

    expect(mocks.expandMergeForward).toHaveBeenCalledTimes(1);
    const [, expandMessageId] = mocks.expandMergeForward.mock.calls[0];
    expect(expandMessageId).toBe(SOURCE_MSG);
    expect(expandMessageId).not.toBe(INTRO_MSG);
  });

  it('anchors the stored session (rootMessageId + quoteTargetId) on the in-group intro message', async () => {
    await handleNewTopic(makeImageEventData(), birthCtx());

    expect(mocks.createdSessions).toHaveLength(1);
    const session = mocks.createdSessions[0];
    expect(session.rootMessageId).toBe(INTRO_MSG);
    expect(session.quoteTargetId).toBe(INTRO_MSG);
    expect(session.chatId).toBe(GROUP_CHAT);
  });

  it('a thread-tagged DM message ("同时发送到会话" shape) must NOT trigger a birth', async () => {
    // p2pMode=group bot: a topic-composed message that Feishu ALSO delivers at
    // the top level arrives with thread_id set but no root_id. It belongs to
    // the existing topic's context — birth must skip it (legacy thread
    // behavior applies instead).
    registerBot({
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      p2pMode: 'group',
      workingDir: join(mocks.dataDir, 'workdir'),
      defaultWorkingDir: join(mocks.dataDir, 'workdir'),
      allowedUsers: [OWNER],
    } as any);
    const birth = await import('../src/core/session-group-birth.js');
    const birthSpy = vi.spyOn(birth, 'maybeBirthSessionGroup');

    const data = makeImageEventData();
    data.message.chat_id = DM_CHAT;
    data.message.thread_id = 'omt_existing_topic';
    await handleNewTopic(data, birthCtx({
      chatId: DM_CHAT,
      chatType: 'p2p',
      scope: 'thread',
      anchor: SOURCE_MSG,
      sessionGroupBirth: undefined,
      replyAnchorMessageId: undefined,
    }));

    expect(birthSpy).not.toHaveBeenCalled();
    birthSpy.mockRestore();
  });

  it('non-birth chat-scope sessions keep both anchors on the inbound message (control)', async () => {
    await handleNewTopic(makeImageEventData(), birthCtx({
      sessionGroupBirth: undefined,
      replyAnchorMessageId: undefined,
    }));

    expect(mocks.downloadResources.mock.calls[0][1]).toBe(SOURCE_MSG);
    expect(mocks.createdSessions).toHaveLength(1);
    expect(mocks.createdSessions[0].rootMessageId).toBe(SOURCE_MSG);
    expect(mocks.createdSessions[0].quoteTargetId).toBe(SOURCE_MSG);
  });
});
