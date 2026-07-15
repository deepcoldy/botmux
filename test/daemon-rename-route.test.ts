/**
 * Route-level regression guard for `/rename` (PR review P1).
 *
 * `/rename` is a DAEMON_COMMAND, and the daemon's production routes
 * (handleNewTopic / handleThreadReply) pre-create a sessionStore record +
 * activeSessions entry (worker:null) for session-needing daemon commands
 * BEFORE calling handleCommand. That made command-handler's `if (!ds)`
 * no-active-session branch dead code in production: `/rename Foo` in a fresh
 * topic (or a thread with no session) silently created a phantom session and
 * renamed it — polluting the dashboard's session list.
 *
 * The unit tests in command-handler.test.ts call handleCommand directly and
 * can never catch this, so this file drives the REAL routing handlers and
 * asserts:
 *   - `/rename` with no session: NO sessionStore.createSession, NO
 *     activeSessions entry, and a plain no-active-session reply — on BOTH
 *     production entry paths;
 *   - `/rename` with an existing session still renames it;
 *   - the generic pre-create block stays intact for other session-needing
 *     daemon commands (`/status` as control).
 *
 * Run:  pnpm vitest run test/daemon-rename-route.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  // Isolate every sessionStore/config read-write under a per-process temp dir
  // (no fs imports here — hoisted code runs before module imports initialize),
  // and make sure hook events run the local (no-op, nothing configured) path
  // instead of forwarding to a live daemon when the test itself runs inside a
  // botmux session shell.
  process.env.SESSION_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/botmux-rename-route-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => ({
      sessionId: `sess-fake-${++seq}`,
      chatId,
      rootMessageId,
      title,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      chatType,
    })),
    updateSession: vi.fn(),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return { ...actual, replyMessage: mocks.replyMessage, sendMessage: mocks.sendMessage, getChatMode: mocks.getChatMode };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return { ...actual, createSession: mocks.createSession, updateSession: mocks.updateSession };
});

import { registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'rename_route_app';
const CHAT = 'oc_rename_route_chat';
const OWNER = 'ou_owner';
const NOW = new Date().toISOString();

function makeEventData(messageId: string, text: string, rootId?: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(anchor: string, messageId: string): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    larkAppId: APP,
  };
}

function seedThreadSession(anchor: string, title: string): DaemonSession {
  const ds = {
    scope: 'thread',
    chatId: CHAT,
    chatType: 'group',
    larkAppId: APP,
    worker: null,
    workerPort: null,
    workerToken: null,
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    ownerOpenId: OWNER,
    session: {
      sessionId: 'sess-seeded-' + Math.random().toString(36).slice(2),
      chatId: CHAT,
      rootMessageId: anchor,
      title,
      status: 'active',
      createdAt: NOW,
      larkAppId: APP,
    },
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(anchor, APP), ds);
  return ds;
}

/** All text replied through the mocked Lark client in this test, joined. */
function repliedText(): string {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .map(call => String(call[2] ?? ''))
    .join('\n');
}

describe('/rename production routing — must not pre-create a session (review P1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    activeSessions.clear();
    const bot = registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER] });
    bot.resolvedAllowedUsers = [OWNER];
  });

  it('new topic: `/rename Foo` replies no-active-session and creates NOTHING', async () => {
    await handleNewTopic(makeEventData('om_new_1', '/rename Foo'), makeCtx('om_new_1', 'om_new_1'));

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
    expect(repliedText()).toContain('没有活跃的会话');
  });

  it('thread reply with no existing session: `/rename Foo` replies no-active-session and creates NOTHING', async () => {
    await handleThreadReply(
      makeEventData('om_reply_1', '/rename Foo', 'om_root_1'),
      makeCtx('om_root_1', 'om_reply_1'),
    );

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
    expect(repliedText()).toContain('没有活跃的会话');
  });

  it('thread reply with an existing session: `/rename` renames it in place', async () => {
    const ds = seedThreadSession('om_root_2', '旧标题');

    await handleThreadReply(
      makeEventData('om_reply_2', '/rename ZMX 后端集成推进', 'om_root_2'),
      makeCtx('om_root_2', 'om_reply_2'),
    );

    expect(ds.session.title).toBe('ZMX 后端集成推进');
    expect(mocks.updateSession).toHaveBeenCalledWith(ds.session);
    expect(mocks.createSession).not.toHaveBeenCalled();
    // Still exactly the seeded session — nothing new registered.
    expect(activeSessions.size).toBe(1);
    expect(activeSessions.get(sessionKey('om_root_2', APP))).toBe(ds);
    expect(repliedText()).toContain('会话标题已更新');
  });

  it('non-allowedUsers sender: `/rename` is denied by canOperate on BOTH routes, nothing created/renamed', async () => {
    // The /rename handler itself has no permission gate — it relies entirely on
    // the routes' canOperate gate running BEFORE the existing-session-only
    // special case. This pins that ordering: moving the special case above the
    // gate (e.g. to literally mirror /card//term placement) must fail here.
    const stranger = { sender_id: { open_id: 'ou_stranger' }, sender_type: 'user' };

    // Leg 1 — new topic. Assert the denial text per leg: a no_active_session
    // reply here would mean handleCommand ran BEFORE the gate.
    const newTopicData = makeEventData('om_new_3', '/rename Hacked');
    newTopicData.sender = stranger;
    await handleNewTopic(newTopicData, makeCtx('om_new_3', 'om_new_3'));
    expect(repliedText()).toContain('仅 allowedUsers 可执行');
    expect(repliedText()).not.toContain('没有活跃的会话');

    // Leg 2 — thread reply against a seeded session: the rename must not land.
    mocks.replyMessage.mockClear();
    mocks.sendMessage.mockClear();
    const ds = seedThreadSession('om_root_3', '原标题');
    const replyData = makeEventData('om_reply_3', '/rename Hacked', 'om_root_3');
    replyData.sender = stranger;
    await handleThreadReply(replyData, makeCtx('om_root_3', 'om_reply_3'));
    expect(repliedText()).toContain('仅 allowedUsers 可执行');

    expect(ds.session.title).toBe('原标题');
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(1); // only the seeded session
  });

  it('control: `/status` in a new topic still pre-creates the session (generic block intact)', async () => {
    await handleNewTopic(makeEventData('om_new_2', '/status'), makeCtx('om_new_2', 'om_new_2'));

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(activeSessions.has(sessionKey('om_new_2', APP))).toBe(true);
  });
});
