/**
 * Route-level guards that the merge-forward LISTENER WIRING actually feeds the
 * expanded forward body into the CLI input on BOTH ingress routes:
 *
 *   - new topic: handleNewTopic (refresh in handleNewTopicAdmitted)
 *   - thread reply into an existing session: handleThreadReplyAdmitted
 *
 * The listener match arrives with an empty body (merge_forward events carry
 * only '{}' at match time); the daemon expands the message via the Lark API
 * (mocked here) and must copy the expanded XML into the match before the
 * listener prompt is rendered. Deleting either daemon call site reverts the
 * observed body to the lossy '[合并转发消息]' placeholder — these tests fail.
 *
 * The reroute idempotency (a CAS-loser re-enters carrying the rendered
 * prompt) is pinned at the pure-function level in
 * message-listener.test.ts; here we assert the two production call sites.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FORWARD_XML = '<forwarded_messages>\n<msg from="A">转发正文：登录失败</msg>\n</forwarded_messages>';

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/botmux-listener-fwd-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  const created: any[] = [];
  return {
    created,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    listChatBotMembers: vi.fn(async () => [] as any[]),
    downloadResources: vi.fn(async () => ({ attachments: [] as any[], needLogin: false })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined) => (
      openId ? { openId, type: 'user' as const } : undefined
    )),
    forkWorker: vi.fn(),
    sendWorkerInput: vi.fn(),
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: string) => {
      const s = {
        sessionId: `sess-fwd-${Math.random().toString(36).slice(2)}`,
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
    expandMergeForward: vi.fn(async (_appId: string, _messageId: string, parsed: any) => {
      parsed.content = FORWARD_XML;
      parsed.msgType = 'merge_forward_expanded';
      return { extraResources: [] as any[] };
    }),
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
    listChatBotMembers: mocks.listChatBotMembers,
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

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return { ...actual, downloadResources: (...args: any[]) => mocks.downloadResources(...args) };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    forkWorker: (...args: any[]) => mocks.forkWorker(...args),
    sendWorkerInput: (...args: any[]) => mocks.sendWorkerInput(...args),
  };
});

vi.mock('../src/im/lark/merge-forward.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/merge-forward.js');
  return { ...actual, expandMergeForward: (...args: any[]) => mocks.expandMergeForward(...args) };
});

import { registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';

const APP = 'listener_fwd_app';
const CHAT = 'oc_listener_fwd_chat';
const OWNER = 'ou_fwd_human';
const NOW = new Date().toISOString();

let home: string;

function listenerMatch(extra?: Record<string, unknown>): any {
  return {
    name: '转发看守',
    prompt: '阅读转发内容并响应',
    messageText: '',
    msgType: 'merge_forward',
    senderType: 'user',
    senderOpenId: OWNER,
    replyMode: 'thread',
    ...extra,
  };
}

function forwardEvent(messageId: string, rootId?: string): any {
  return {
    sender: { sender_id: { open_id: OWNER, union_id: `on_${OWNER}` }, sender_type: 'user' },
    message: {
      message_id: messageId,
      ...(rootId ? { root_id: rootId } : {}),
      chat_id: CHAT,
      message_type: 'merge_forward',
      content: '{}',
      create_time: String(Date.now()),
    },
  };
}

function assertForwardBodyOnce(input: string): void {
  // The expanded body reaches the model inside exactly ONE listener envelope;
  // the forward XML is escaped once (observer content), never twice (nested).
  expect(input).toContain('转发正文：登录失败');
  expect(input.match(/<observed_message/g)).toHaveLength(1);
  expect(input.match(/&lt;forwarded_messages&gt;/g)).toEqual(['&lt;forwarded_messages&gt;']);
  expect(input).not.toContain('&amp;lt;');
  expect(input).not.toContain('[合并转发消息]');
}

describe('listener merge-forward expansion wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.created.length = 0;
    home = mkdtempSync(join(tmpdir(), 'botmux-listener-fwd-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEX_HOME', '');
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    mocks.listChatBotMembers.mockResolvedValue([]);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    mocks.forkWorker.mockReturnValue(true);
    mocks.sendWorkerInput.mockReturnValue(true);
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
      workingDir: '/tmp',
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [OWNER];
    bot.botName = 'FwdBot';
    bot.botOpenId = 'ou_fwd_selfbot';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('new-topic route: expanded forward XML reaches the cold-fork CLI input once', async () => {
    const messageId = 'om_fwd_topic_root';
    await handleNewTopic(
      forwardEvent(messageId),
      {
        chatId: CHAT,
        messageId,
        chatType: 'group' as const,
        scope: 'thread' as const,
        anchor: messageId,
        replyRootId: messageId,
        larkAppId: APP,
        messageListener: listenerMatch(),
      },
    );

    expect(mocks.expandMergeForward).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const input = (mocks.forkWorker.mock.calls[0]?.[1] as any)?.content as string;
    assertForwardBodyOnce(input);
  });

  it('thread route: expanded forward XML reaches the live-worker CLI input once', async () => {
    const anchor = 'om_fwd_existing_root';
    const send = vi.fn();
    const ds = {
      scope: 'thread',
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
      ownerOpenId: OWNER,
      workingDir: '/tmp',
      session: {
        sessionId: 'sess-fwd-live',
        chatId: CHAT,
        rootMessageId: anchor,
        title: 'existing topic',
        status: 'active',
        createdAt: NOW,
        larkAppId: APP,
        scope: 'thread',
        workingDir: '/tmp',
      },
    } as unknown as DaemonSession;
    activeSessions.set(sessionKey(anchor, APP), ds);

    await handleThreadReply(
      forwardEvent('om_fwd_reply', anchor),
      {
        chatId: CHAT,
        messageId: 'om_fwd_reply',
        chatType: 'group' as const,
        scope: 'thread' as const,
        anchor,
        replyRootId: anchor,
        larkAppId: APP,
        messageListener: listenerMatch(),
      },
    );

    expect(mocks.expandMergeForward).toHaveBeenCalledTimes(1);
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
    const input = (mocks.sendWorkerInput.mock.calls[0]?.[1] as any)?.content as string;
    assertForwardBodyOnce(input);
  });
});
