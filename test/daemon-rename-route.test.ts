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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  // Isolate every sessionStore/config read-write under a per-process temp dir
  // (no fs imports here — hoisted code runs before module imports initialize),
  // and make sure hook events run the local (no-op, nothing configured) path
  // instead of forwarding to a live daemon when the test itself runs inside a
  // botmux session shell.
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-rename-route-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  const sessions = new Map<string, any>();
  return {
    dataDir,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    sendEphemeralCard: vi.fn(async () => 'om_ephemeral'),
    addReaction: vi.fn(async () => 'reaction_received'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    sessions,
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => {
      const session = {
        sessionId: `sess-fake-${++seq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
      sessions.set(session.sessionId, session);
      return session;
    }),
    updateSession: vi.fn((session: any) => { sessions.set(session.sessionId, session); }),
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    closeSession: vi.fn((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) session.status = 'closed';
    }),
    forkWorker: vi.fn((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    }),
    // Must mirror the real contract: closeSession() always resolves a
    // CloseSessionResult. Returning undefined made the remote-close guard
    // (riff/mojo `closeResult.ok` / `outcome`) read a property of undefined.
    closeWorkerPoolSession: vi.fn(async () => ({
      ok: true as const, outcome: 'closed' as const, alreadyClosed: false, known: true,
    })),
    discoverAdoptableSessions: vi.fn(() => [] as any[]),
    discoverAdoptableZellijSessions: vi.fn(() => [] as any[]),
    discoverClaudeFamilySessions: vi.fn(() => [] as any[]),
    discoverRolloutSessions: vi.fn(() => [] as any[]),
    discoverAntigravitySessions: vi.fn(() => [] as any[]),
    scanMultipleProjects: vi.fn(() => [] as any[]),
    getAvailableBots: vi.fn(async () => [] as any[]),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
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
    sendEphemeralCard: mocks.sendEphemeralCard,
    addReaction: mocks.addReaction,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    createSession: mocks.createSession,
    updateSession: mocks.updateSession,
    getSession: mocks.getSession,
    closeSession: mocks.closeSession,
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    forkWorker: mocks.forkWorker,
    closeSession: mocks.closeWorkerPoolSession,
  };
});

vi.mock('../src/core/session-discovery.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-discovery.js');
  return { ...actual, discoverAdoptableSessions: mocks.discoverAdoptableSessions };
});

vi.mock('../src/core/zellij-adopt-discovery.js', async () => {
  const actual = await vi.importActual<any>('../src/core/zellij-adopt-discovery.js');
  return { ...actual, discoverAdoptableZellijSessions: mocks.discoverAdoptableZellijSessions };
});

vi.mock('../src/services/resumable-session-discovery.js', async () => {
  const actual = await vi.importActual<any>('../src/services/resumable-session-discovery.js');
  return {
    ...actual,
    discoverClaudeFamilySessions: mocks.discoverClaudeFamilySessions,
    discoverRolloutSessions: mocks.discoverRolloutSessions,
    discoverAntigravitySessions: mocks.discoverAntigravitySessions,
  };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    getAvailableBots: mocks.getAvailableBots,
    downloadResources: mocks.downloadResources,
  };
});

vi.mock('../src/services/project-scanner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/project-scanner.js');
  return { ...actual, scanMultipleProjects: mocks.scanMultipleProjects };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

import { registerBot } from '../src/bot-registry.js';
import { sessionAnchorId, sessionKey } from '../src/core/types.js';
import { recordBotUnionId } from '../src/services/bot-union-ids-store.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_claimNewDaemonSession as claimNewDaemonSession,
  __testOnly_handleChatModeConverted as handleChatModeConverted,
  __testOnly_handleDocComment as handleDocComment,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
  __testOnly_onQueuedActivationSubmitted as onQueuedActivationSubmitted,
  __testOnly_prewarmDocCommentSession as prewarmDocCommentSession,
  __testOnly_releaseQueuedActivationReservation as releaseQueuedActivationReservation,
  __testOnly_reserveAsyncQueuedActivationTailAdmission as reserveAsyncQueuedActivationTailAdmission,
  __testOnly_resetDocCommentClaims as resetDocCommentClaims,
  __testOnly_settleAsyncQueuedActivationTailAdmission as settleAsyncQueuedActivationTailAdmission,
} from '../src/daemon.js';
import { admitQueuedActivationTail } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { getDocSubscription, putDocSubscription, removeDocSubscription } from '../src/services/doc-subs-store.js';
import { config } from '../src/config.js';

const APP = 'rename_route_app';
const CHAT = 'oc_rename_route_chat';
const OWNER = 'ou_owner';
const PEER = 'ou_peer_bot';
const PEER_UNION = 'on_peer_bot';
const NOW = new Date().toISOString();
const repoFixtureDirs: string[] = [];

function makeRepoFixtureDir(): string {
  const root = join(mocks.dataDir, 'repo-fixtures');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'repo-'));
  repoFixtureDirs.push(dir);
  return dir;
}

function cleanupRepoFixtureDirs(): void {
  for (const dir of repoFixtureDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

function makeMentionOnlyEventData(messageId: string, rootId?: string): any {
  const data = makeEventData(messageId, '@@_user_1', rootId);
  data.message.mentions = [{
    key: '@_user_1',
    name: 'TestBot',
    id: { open_id: 'ou_bot' },
  }];
  return data;
}

function makePeerRepoEventData(
  messageId: string,
  senderType: 'app' | 'bot' | 'user',
  rootId?: string,
  senderUnionId: string | null = PEER_UNION,
): any {
  const data = makeEventData(messageId, '/repo', rootId);
  data.sender = {
    sender_id: {
      open_id: PEER,
      ...(typeof senderUnionId === 'string' ? { union_id: senderUnionId } : {}),
    },
    sender_type: senderType,
  };
  return data;
}

function makePeerRepoEventDataWithSplitFooter(
  messageId: string,
  rootId?: string,
): any {
  const repoPath = makeRepoFixtureDir();
  return {
    sender: { sender_id: { open_id: PEER, union_id: PEER_UNION }, sender_type: 'app' },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'interactive',
      content: JSON.stringify({
        elements: [[
          { tag: 'text', text: `/repo ${repoPath}\n` },
          { tag: 'a', text: 'botmux', href: 'https://github.com/deepcoldy/botmux' },
          { tag: 'text', text: "<font color='grey'> </font>" },
          { tag: 'a', text: '·', href: 'https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1' },
          { tag: 'text', text: "<font color='grey'> 发送给：</font>" },
          { tag: 'at', user_name: 'jihong traex' },
        ]],
      }),
      create_time: String(Date.now()),
    },
  };
}

function makePeerRepoEventDataWithV2FooterElement(
  messageId: string,
  rootId?: string,
): any {
  const repoPath = makeRepoFixtureDir();
  return {
    sender: { sender_id: { open_id: PEER, union_id: PEER_UNION }, sender_type: 'app' },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        body: {
          elements: [
            { tag: 'markdown', content: `/repo ${repoPath}` },
            { tag: 'hr' },
            {
              element_id: 'botmux_reply_footer',
              tag: 'markdown',
              content: '[botmux](https://github.com/deepcoldy/botmux)'
                + "<font color='grey'> </font>"
                + '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)'
                + "<font color='grey'> 发送给：</font><at id=ou_owner></at>",
            },
          ],
        },
      }),
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
    hasHistory: false,
    ownerOpenId: OWNER,
    currentReplyTarget: {
      rootMessageId: 'om_stale_root',
      turnId: 'om_stale_turn',
      updatedAt: NOW,
    },
    session: {
      sessionId: 'sess-live-chat-' + Math.random().toString(36).slice(2),
      chatId: CHAT,
      rootMessageId: 'om_original_root',
      title: 'live chat',
      status: 'active',
      createdAt: NOW,
      larkAppId: APP,
      scope: 'chat',
      quoteTargetId: 'om_stale_quote',
      quoteTargetSenderOpenId: 'ou_stale_caller',
      lastCallerOpenId: 'ou_stale_caller',
      currentReplyTarget: {
        rootMessageId: 'om_stale_root',
        turnId: 'om_stale_turn',
        updatedAt: NOW,
      },
    },
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(CHAT, APP), ds);
  return ds;
}

function seedPendingRawSession(anchor: string): DaemonSession {
  const ds = seedThreadSession(anchor, 'pending raw');
  ds.pendingRepo = true;
  ds.pendingPrompt = '';
  ds.pendingRawInput = '/goal start';
  ds.pendingRawTurnId = 'om_initial_raw';
  ds.pendingSender = { openId: OWNER, type: 'user' };
  return ds;
}

function makeChatSession(sessionId: string, chatId: string, options?: {
  pendingLedger?: boolean;
  pendingRepo?: boolean;
  queued?: boolean;
}): DaemonSession {
  const session = {
    sessionId,
    chatId,
    rootMessageId: `om_${sessionId}`,
    title: sessionId,
    status: 'active' as const,
    createdAt: NOW,
    larkAppId: APP,
    scope: 'chat' as const,
    chatType: 'group' as const,
    queued: options?.queued,
    codexAppDispatchLedger: options?.pendingLedger ? [{
      dispatchId: `dispatch-${sessionId}`,
      turnId: `turn-${sessionId}`,
      dispatchAttempt: 1,
      state: 'prepared' as const,
      content: 'durable work',
      deliverySink: 'lark' as const,
    }] : undefined,
  };
  mocks.sessions.set(sessionId, session);
  return {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    pendingRepo: options?.pendingRepo,
  } as DaemonSession;
}

/** All text replied through the mocked Lark client in this test, joined. */
function repliedText(): string {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .map(call => String(call[2] ?? ''))
    .join('\n');
}

function crossRefPath(): string {
  return join(mocks.dataDir, `bot-openids-${APP}.json`);
}

function botsInfoPath(): string {
  return join(mocks.dataDir, 'bots-info.json');
}

function botsConfigPath(): string {
  return join(mocks.dataDir, 'bots.json');
}

function botUnionIdsPath(): string {
  return join(mocks.dataDir, 'bot-union-ids.json');
}

function seedSiblingCrossRef(): void {
  mkdirSync(mocks.dataDir, { recursive: true });
  writeFileSync(crossRefPath(), JSON.stringify({ Codex: PEER }));
}

function seedConfiguredSiblingIdentity(): void {
  writeFileSync(botsConfigPath(), JSON.stringify([
    { larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER] },
    { larkAppId: 'repo_sibling_route', larkAppSecret: 's', cliId: 'codex' },
  ]));
  writeFileSync(botsInfoPath(), JSON.stringify([
    { larkAppId: APP, botOpenId: 'ou_receiver_self', botName: 'Receiver', cliId: 'claude-code' },
    { larkAppId: 'repo_sibling_route', botOpenId: 'ou_peer_self', botName: 'Codex', cliId: 'codex' },
  ]));
  recordBotUnionId(mocks.dataDir, 'repo_sibling_route', PEER_UNION);
}

function resetRouteTestState(): void {
  vi.clearAllMocks();
  mocks.replyMessage.mockResolvedValue('om_reply');
  mocks.sendMessage.mockResolvedValue('om_top');
  mocks.getChatMode.mockResolvedValue('group');
  mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
  activeSessions.clear();
  rmSync(crossRefPath(), { force: true });
  rmSync(botsConfigPath(), { force: true });
  rmSync(botsInfoPath(), { force: true });
  rmSync(botUnionIdsPath(), { force: true });
  const bot = registerBot({
    larkAppId: APP,
    larkAppSecret: 's',
    cliId: 'claude-code',
    allowedUsers: [OWNER],
    oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
  });
  bot.resolvedAllowedUsers = [OWNER];
}

describe('/rename production routing — must not pre-create a session (review P1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.sendEphemeralCard.mockResolvedValue('om_ephemeral');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    mocks.sessions.clear();
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    mocks.closeWorkerPoolSession.mockImplementation(async (sessionId: string) => {
      for (const [key, candidate] of activeSessions) {
        if (candidate.session.sessionId !== sessionId) continue;
        candidate.session.status = 'closed';
        activeSessions.delete(key);
        mocks.closeSession(sessionId);
        return { ok: true as const, outcome: 'closed' as const, alreadyClosed: false, known: true };
      }
      return { ok: true as const, outcome: 'closed' as const, alreadyClosed: true, known: false };
    });
    mocks.scanMultipleProjects.mockReturnValue([]);
    mocks.discoverAdoptableSessions.mockReturnValue([]);
    mocks.discoverAdoptableZellijSessions.mockReturnValue([]);
    mocks.discoverClaudeFamilySessions.mockReturnValue([]);
    mocks.discoverRolloutSessions.mockReturnValue([]);
    mocks.discoverAntigravitySessions.mockReturnValue([]);
    mocks.getAvailableBots.mockResolvedValue([]);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    activeSessions.clear();
    resetDocCommentClaims();
    // master: clear per-bot store files so a seeded cross-ref / bots config from
    // one test can't leak into the next (see the known-peer + /fast tests).
    rmSync(crossRefPath(), { force: true });
    rmSync(botsConfigPath(), { force: true });
    rmSync(botsInfoPath(), { force: true });
    rmSync(botUnionIdsPath(), { force: true });
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
    });
    bot.resolvedAllowedUsers = [OWNER];
  });

  afterEach(() => {
    rmSync(crossRefPath(), { force: true });
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

  it('pinned cwd + bare `/t` seeds the thread without creating an empty Session', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];

    await handleNewTopic(
      makeEventData('om_bare_force_topic', '/t'),
      makeCtx('om_bare_force_topic', 'om_bare_force_topic'),
    );

    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      'om_bare_force_topic',
      '💬 新话题已创建。请在话题内发送任务，也可以先用 /repo 选择项目。',
      'text',
      true,
    ]);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
  });

  it('thread-root parent_id remains bare `/t` routing metadata, not a quoted task', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    const rootId = 'om_force_topic_parent_root';
    const data = makeEventData('om_force_topic_parent_child', '/t', rootId);
    data.message.parent_id = rootId;

    await handleNewTopic(data, makeCtx(rootId, 'om_force_topic_parent_child'));

    expect(mocks.replyMessage.mock.calls[0]?.[2]).toContain('新话题已创建');
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('card-off quoted `/t` seeds the thread before starting the quoted task', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    const messageId = 'om_force_topic_quoted_task';
    const data = makeEventData(messageId, '/t');
    data.message.parent_id = 'om_distinct_quoted_message';

    await handleNewTopic(data, makeCtx(messageId, messageId));

    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      messageId,
      '↪️ 已转入新话题，正在处理…',
      'text',
      true,
    ]);
    expect(mocks.replyMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.forkWorker.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(mocks.forkWorker.mock.calls[0]?.[1])).toContain('om_distinct_quoted_message');
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
  });

  it('`/t <content>` preserves a paired forward seed in the first worker input', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    const messageId = 'om_force_topic_forward_followup';

    await handleNewTopic(
      makeEventData(messageId, '/t 处理这份背景'),
      {
        ...makeCtx(messageId, messageId),
        forwardSeedData: makeEventData('om_force_topic_forward_seed', '转发的原始背景'),
      },
    );

    const openingInput = JSON.stringify(mocks.forkWorker.mock.calls[0]?.[1]);
    expect(openingInput).toContain('转发的原始背景');
    expect(openingInput).toContain('处理这份背景');
    expect(mocks.replyMessage.mock.calls[0]?.[2]).toBe('↪️ 已转入新话题，正在处理…');
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
  });

  it('no pinned cwd + bare `/t` keeps the repo picker setup flow', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      workingDirs: ['/tmp'],
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    mocks.scanMultipleProjects.mockReturnValue([{
      name: 'botmux',
      path: '/tmp',
      type: 'repo',
      branch: 'master',
    }]);

    await handleNewTopic(
      makeEventData('om_bare_force_topic_picker', '/t'),
      makeCtx('om_bare_force_topic_picker', 'om_bare_force_topic_picker'),
    );

    const ds = activeSessions.get(sessionKey('om_bare_force_topic_picker', APP));
    expect(ds?.pendingRepo).toBe(true);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      'om_bare_force_topic_picker',
      expect.any(String),
      'interactive',
      true,
    ]);
    const picker = JSON.parse(String(mocks.replyMessage.mock.calls[0]?.[2]));
    expect(JSON.stringify(picker)).toContain('"key":"repo_switch"');
    expect(JSON.stringify(picker)).toContain('"root_id":"om_bare_force_topic_picker"');
    expect(JSON.stringify(picker)).toContain('"value":"/tmp"');
  });

  it('no pinned cwd + no projects + bare `/t` waits without creating an empty Session', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      workingDirs: ['/tmp'],
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    mocks.scanMultipleProjects.mockReturnValue([]);

    await handleNewTopic(
      makeEventData('om_bare_force_topic_no_projects', '/t'),
      makeCtx('om_bare_force_topic_no_projects', 'om_bare_force_topic_no_projects'),
    );

    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      'om_bare_force_topic_no_projects',
      '💬 新话题已创建。请在话题内发送任务，也可以先用 /repo 选择项目。',
      'text',
      true,
    ]);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
  });

  it('bare `/t` reports invalid scan directories before claiming topic setup', async () => {
    const missing = '/tmp/botmux-force-topic-directory-does-not-exist';
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      workingDirs: [missing],
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];

    await handleNewTopic(
      makeEventData('om_bare_force_topic_invalid_dir', '/t'),
      makeCtx('om_bare_force_topic_invalid_dir', 'om_bare_force_topic_invalid_dir'),
    );

    expect(repliedText()).toContain('配置的工作目录不存在');
    expect(repliedText()).toContain(missing);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('pinned cwd + bare `/t` followed by `/repo` starts the first Session without a close card', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    const rootId = 'om_bare_force_topic_then_repo';

    await handleNewTopic(makeEventData(rootId, '/t'), makeCtx(rootId, rootId));
    // The dispatcher rechecks ownership at execution time. Because bare `/t`
    // deliberately kept no active owner, this human thread reply takes the
    // fresh-topic handler even though Lark supplies a root_id/thread_id.
    await handleNewTopic(
      makeEventData('om_first_repo_in_force_topic', '/repo /tmp', rootId),
      makeCtx(rootId, 'om_first_repo_in_force_topic'),
    );

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(repliedText()).not.toContain('会话已关闭');
    expect(activeSessions.get(sessionKey(rootId, APP))?.workingDir).toBe('/tmp');
  });

  it('pinned cwd + bare `/t` followed by `/adopt` keeps the picker card inside that thread', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    mocks.discoverAdoptableSessions.mockReturnValue([{
      tmuxTarget: '0:1.0',
      panePid: 1000,
      cliPid: 1001,
      cliId: 'claude-code',
      cwd: '/tmp',
      paneCols: 120,
      paneRows: 40,
    }]);
    const rootId = 'om_bare_force_topic_then_adopt';

    await handleNewTopic(makeEventData(rootId, '/t'), makeCtx(rootId, rootId));
    mocks.replyMessage.mockClear();
    mocks.sendMessage.mockClear();

    const adoptReply = makeEventData('om_first_adopt_in_force_topic', '/adopt', rootId);
    adoptReply.message.thread_id = 'omt_bare_force_topic_then_adopt';
    await handleNewTopic(
      adoptReply,
      makeCtx(rootId, 'om_first_adopt_in_force_topic'),
    );

    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      rootId,
      expect.any(String),
      'interactive',
      true,
    ]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.discoverAdoptableSessions).toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(JSON.stringify(JSON.parse(String(mocks.replyMessage.mock.calls[0]?.[2])))).toContain('adopt_pick');
  });

  it('chat-scope `/adopt` picker stays in the invoking group thread', async () => {
    const ds = seedLiveChatSession();
    mocks.discoverAdoptableSessions.mockReturnValue([{
      tmuxTarget: '0:1.0',
      panePid: 1000,
      cliPid: 1001,
      cliId: 'claude-code',
      cwd: '/tmp',
      paneCols: 120,
      paneRows: 40,
    }]);
    const topicRoot = 'om_chat_scope_adopt_topic';
    const messageId = 'om_chat_scope_adopt_command';
    const event = makeEventData(messageId, '/adopt', topicRoot);
    event.message.thread_id = 'omt_chat_scope_adopt';

    await handleThreadReply(event, {
      chatId: CHAT,
      messageId,
      chatType: 'group',
      scope: 'chat',
      anchor: CHAT,
      replyRootId: topicRoot,
      larkAppId: APP,
    });

    expect(activeSessions.get(sessionKey(CHAT, APP))).toBe(ds);
    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      topicRoot,
      expect.any(String),
      'interactive',
      true,
    ]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendEphemeralCard).not.toHaveBeenCalled();
    expect(mocks.discoverAdoptableSessions).toHaveBeenCalled();
    expect(JSON.stringify(JSON.parse(String(mocks.replyMessage.mock.calls[0]?.[2])))).toContain('adopt_pick');
  });

  it('chat-scope command denial stays in the invoking group thread', async () => {
    const ds = seedLiveChatSession();
    const topicRoot = 'om_chat_scope_denied_topic';
    const messageId = 'om_chat_scope_denied_command';
    const event = makeEventData(messageId, '/rename Hacked', topicRoot);
    event.message.thread_id = 'omt_chat_scope_denied';
    event.sender.sender_id.open_id = 'ou_stranger';

    await handleThreadReply(event, {
      chatId: CHAT,
      messageId,
      chatType: 'group',
      scope: 'chat',
      anchor: CHAT,
      replyRootId: topicRoot,
      larkAppId: APP,
    });

    expect(ds.session.title).toBe('live chat');
    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      topicRoot,
      expect.stringContaining('仅 allowedUsers 可执行'),
      'text',
      true,
    ]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendEphemeralCard).not.toHaveBeenCalled();
  });

  it('`/t /adopt` opens the picker inside the new thread without starting a CLI', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    mocks.discoverAdoptableSessions.mockReturnValue([{
      tmuxTarget: '0:1.0',
      panePid: 1000,
      cliPid: 1001,
      cliId: 'claude-code',
      cwd: '/tmp',
      paneCols: 120,
      paneRows: 40,
    }]);
    const rootId = 'om_force_topic_adopt_composed';

    await handleNewTopic(
      makeEventData(rootId, '/t /adopt'),
      makeCtx(rootId, rootId),
    );

    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      rootId,
      expect.any(String),
      'interactive',
      true,
    ]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.discoverAdoptableSessions).toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(JSON.stringify(JSON.parse(String(mocks.replyMessage.mock.calls[0]?.[2])))).toContain('adopt_pick');
  });

  it('chat-scope `/close` confirmation stays in the invoking group thread', async () => {
    const ds = seedLiveChatSession();
    const topicRoot = 'om_chat_scope_close_topic';
    const messageId = 'om_chat_scope_close_command';
    const event = makeEventData(messageId, '/close', topicRoot);
    event.message.thread_id = 'omt_chat_scope_close';

    await handleThreadReply(event, {
      chatId: CHAT,
      messageId,
      chatType: 'group',
      scope: 'chat',
      anchor: CHAT,
      replyRootId: topicRoot,
      larkAppId: APP,
    });

    expect(mocks.closeWorkerPoolSession).toHaveBeenCalledWith(ds.session.sessionId);
    expect(activeSessions.has(sessionKey(CHAT, APP))).toBe(false);
    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      topicRoot,
      expect.any(String),
      'interactive',
      true,
    ]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendEphemeralCard).not.toHaveBeenCalled();
  });

  it('chat-scope adopted `/detach` confirmation stays in the invoking group thread', async () => {
    const ds = seedLiveChatSession();
    const adoptedFrom = {
      source: 'tmux' as const,
      tmuxTarget: '0:1.0',
      originalCliPid: 1001,
      cwd: '/tmp',
    };
    ds.adoptedFrom = adoptedFrom;
    ds.session.adoptedFrom = adoptedFrom;
    const topicRoot = 'om_chat_scope_detach_topic';
    const messageId = 'om_chat_scope_detach_command';
    const event = makeEventData(messageId, '/detach', topicRoot);
    event.message.thread_id = 'omt_chat_scope_detach';

    await handleThreadReply(event, {
      chatId: CHAT,
      messageId,
      chatType: 'group',
      scope: 'chat',
      anchor: CHAT,
      replyRootId: topicRoot,
      larkAppId: APP,
    });

    expect(mocks.closeWorkerPoolSession).toHaveBeenCalledWith(ds.session.sessionId);
    expect(activeSessions.has(sessionKey(CHAT, APP))).toBe(false);
    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      topicRoot,
      expect.any(String),
      'text',
      true,
    ]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendEphemeralCard).not.toHaveBeenCalled();
  });

  it('chat-scope `/close` confirmation stays in the invoking DM thread', async () => {
    const ds = seedLiveChatSession();
    ds.chatType = 'p2p';
    ds.session.chatType = 'p2p';
    const topicRoot = 'om_dm_close_topic';
    const messageId = 'om_dm_close_command';
    const event = makeEventData(messageId, '/close', topicRoot);
    event.message.thread_id = 'omt_dm_close';

    await handleThreadReply(event, {
      chatId: CHAT,
      messageId,
      chatType: 'p2p',
      scope: 'chat',
      anchor: CHAT,
      replyRootId: topicRoot,
      larkAppId: APP,
    });

    expect(mocks.closeWorkerPoolSession).toHaveBeenCalledWith(ds.session.sessionId);
    expect(activeSessions.has(sessionKey(CHAT, APP))).toBe(false);
    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      topicRoot,
      expect.any(String),
      'interactive',
      true,
    ]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendEphemeralCard).not.toHaveBeenCalled();
  });

  it('thread-scope `/close` keeps its existing in-thread confirmation route', async () => {
    const topicRoot = 'om_thread_scope_close_topic';
    const messageId = 'om_thread_scope_close_command';
    const ds = seedThreadSession(topicRoot, 'live thread close');
    const event = makeEventData(messageId, '/close', topicRoot);
    event.message.thread_id = 'omt_thread_scope_close';

    await handleThreadReply(event, {
      ...makeCtx(topicRoot, messageId),
      replyRootId: topicRoot,
    });

    expect(mocks.closeWorkerPoolSession).toHaveBeenCalledWith(ds.session.sessionId);
    expect(activeSessions.has(sessionKey(topicRoot, APP))).toBe(false);
    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      topicRoot,
      expect.any(String),
      'interactive',
      true,
    ]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendEphemeralCard).not.toHaveBeenCalled();
  });

  it('chat-scope mid-session `/repo <path>` keeps both lifecycle replies in the invoking group thread', async () => {
    const ds = seedLiveChatSession();
    const oldSessionId = ds.session.sessionId;
    const topicRoot = 'om_chat_scope_repo_topic';
    const messageId = 'om_chat_scope_repo_command';
    const event = makeEventData(messageId, '/repo /tmp', topicRoot);
    event.message.thread_id = 'omt_chat_scope_repo';

    await handleThreadReply(event, {
      chatId: CHAT,
      messageId,
      chatType: 'group',
      scope: 'chat',
      anchor: CHAT,
      replyRootId: topicRoot,
      larkAppId: APP,
    });

    expect(mocks.closeWorkerPoolSession).toHaveBeenCalledWith(oldSessionId);
    expect(activeSessions.get(sessionKey(CHAT, APP))).toBe(ds);
    expect(activeSessions.has(sessionKey(topicRoot, APP))).toBe(false);
    expect(ds.session.sessionId).not.toBe(oldSessionId);
    expect(ds.workingDir).toBe('/tmp');
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.replyMessage.mock.calls.map(call => call.slice(0, 5))).toEqual([
      [APP, topicRoot, expect.stringContaining('会话已关闭'), 'interactive', true],
      [APP, topicRoot, expect.stringContaining('已切换到'), 'text', true],
    ]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendEphemeralCard).not.toHaveBeenCalled();
  });

  it('`/t /repo <path>` selects the first Session repository in one message', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    const rootId = 'om_force_topic_repo_composed';

    await handleNewTopic(
      makeEventData(rootId, '/t /repo /tmp'),
      makeCtx(rootId, rootId),
    );

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(repliedText()).not.toContain('会话已关闭');
    expect(activeSessions.get(sessionKey(rootId, APP))?.workingDir).toBe('/tmp');
  });

  it('card-off pinned cwd + `/t /goal ...` seeds the thread before the initial raw fork', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    const rootId = 'om_force_topic_goal_pinned';
    const rawOpening = '/goal 检查实现';

    await handleNewTopic(
      makeEventData(rootId, `/t ${rawOpening}`),
      makeCtx(rootId, rootId),
    );

    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      rootId,
      '↪️ 已转入新话题，正在处理…',
      'text',
      true,
    ]);
    expect(mocks.replyMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.forkWorker.mock.invocationCallOrder[0]!,
    );
    expect(mocks.forkWorker.mock.calls[0]?.[0]?.pendingRawInput).toBe(rawOpening);
    expect(mocks.forkWorker.mock.calls[0]?.[1]).toBe('');
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
  });

  it('card-off no-project fallback + `/t /goal ...` seeds the thread before the initial raw fork', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      workingDirs: ['/tmp'],
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];
    mocks.scanMultipleProjects.mockReturnValue([]);
    const rootId = 'om_force_topic_goal_no_projects';
    const rawOpening = '/goal 检查实现';

    await handleNewTopic(
      makeEventData(rootId, `/t ${rawOpening}`),
      makeCtx(rootId, rootId),
    );

    expect(mocks.scanMultipleProjects).toHaveBeenCalled();
    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      rootId,
      '↪️ 已转入新话题，正在处理…',
      'text',
      true,
    ]);
    expect(mocks.replyMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.forkWorker.mock.invocationCallOrder[0]!,
    );
    expect(mocks.forkWorker.mock.calls[0]?.[0]?.pendingRawInput).toBe(rawOpening);
    expect(mocks.forkWorker.mock.calls[0]?.[1]).toBe('');
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
  });

  it('card-off pinned cwd + `/t <content>` immediately seeds the thread and starts work', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
      disableStreamingCard: true,
    });
    bot.resolvedAllowedUsers = [OWNER];

    await handleNewTopic(
      makeEventData('om_force_topic_with_content', '/t 检查实现'),
      makeCtx('om_force_topic_with_content', 'om_force_topic_with_content'),
    );

    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 5)).toEqual([
      APP,
      'om_force_topic_with_content',
      '↪️ 已转入新话题，正在处理…',
      'text',
      true,
    ]);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.replyMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.forkWorker.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(mocks.forkWorker.mock.calls[0]?.[1])).toContain('检查实现');
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.addReaction).toHaveBeenCalledWith(
      APP,
      'om_force_topic_with_content',
      expect.any(String),
    );
  });

  it('routes a colliding daemon command to the canonical pending owner and closes only the loser', async () => {
    const anchor = 'om_pending_owner';
    const incumbent = seedThreadSession(anchor, 'durable owner');
    incumbent.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-incumbent',
      turnId: 'turn-incumbent',
      dispatchAttempt: 1,
      state: 'prepared',
      content: 'accepted input',
      deliverySink: 'lark',
    }];

    await handleNewTopic(makeEventData(anchor, '/status'), makeCtx(anchor, anchor));

    expect(activeSessions.get(sessionKey(anchor, APP))).toBe(incumbent);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    const incomingId = mocks.createSession.mock.results[0]!.value.sessionId;
    expect(mocks.closeSession).toHaveBeenCalledWith(incomingId);
    expect(mocks.closeSession).not.toHaveBeenCalledWith(incumbent.session.sessionId);
    expect(repliedText()).toContain(`Session: ${incumbent.session.sessionId}`);
  });

  it('registration-race loser reroute preserves the forward-seed STRUCTURED @mentions in the canonical owner window (#750 seed under-count guard)', async () => {
    // codex merge blocking: a new-topic that loses the CAS reroutes to the
    // canonical owner via handleThreadReplyAdmitted with a fully PREPARED reply.
    // The prepared `parsed` must carry the MERGED seed+follow-up structured
    // mentions — a bare re-parse of `data` would only see the follow-up's
    // message.mentions[] and DROP the forward seed's structured @OtherBot
    // (collectPostAtMentions recovers post rich-text @s, NOT message.mentions[]),
    // under-counting the turn window and mis-releasing --mention-back.
    const anchor = 'om_seed_mention_owner';
    const OTHER_BOT = 'ou_other_bot_seed';
    const incumbent = seedThreadSession(anchor, 'canonical owner');

    // Incoming new-topic: follow-up message @self (ou_bot) + a forward seed whose
    // structured message.mentions[] contains @OtherBot. The incoming loses the CAS
    // to the incumbent and reroutes to it.
    const followUp = makeEventData('om_seed_followup', '@@_user_1 补充', anchor);
    followUp.message.mentions = [{ key: '@_user_1', name: 'TestBot', id: { open_id: 'ou_bot' } }];
    const seed = makeEventData('om_seed_root', '@@_user_1 原始转发', anchor);
    seed.message.mentions = [{ key: '@_user_1', name: 'OtherBot', id: { open_id: OTHER_BOT } }];
    const ctx = { ...makeCtx(anchor, 'om_seed_followup'), forwardSeedData: seed };

    await handleNewTopic(followUp, ctx);

    // Rerouted to the incumbent (CAS loser).
    expect(activeSessions.get(sessionKey(anchor, APP))).toBe(incumbent);
    // The canonical owner's per-turn participant window must still include the
    // seed's structured @OtherBot — proving the prepared reroute carried the
    // merged mentions rather than re-parsing only the follow-up.
    const entry = incumbent.session.replyTargets?.['om_seed_followup'];
    expect(entry).toBeTruthy();
    const participantIds = (entry?.participants ?? []).map(p => p.openId);
    expect(participantIds).toContain(OTHER_BOT);
  });

  it('new topic: passes the accepted Lark message id into the first worker', async () => {
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    try {
      registerBot({
        larkAppId: APP,
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: [OWNER],
        defaultWorkingDir: '/tmp',
      }).resolvedAllowedUsers = [OWNER];
      await handleNewTopic(
        makeEventData('om_workflow_new', '/workflow new 修复首轮授权'),
        makeCtx('om_workflow_new', 'om_workflow_new'),
      );

      expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
      expect(mocks.forkWorker.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ turnId: 'om_workflow_new' }));
      const ds = activeSessions.get(sessionKey('om_workflow_new', APP));
      expect(ds?.session.nativeSessionTitle).toBe('[BotMux·Lark] /workflow new 修复首轮授权');
    } finally {
      delete process.env.BOTMUX_WORKFLOW_ENABLED;
    }
  });

  it('R6-B1: a plain-human Codex App NEW TOPIC freezes steer authorization onto the opening fork payload', async () => {
    // Production wiring: the MAIN new-topic entry (handleNewTopicAdmitted), NOT
    // the handleThreadReply safety-net. A pinned-workingDir codex-app bot forks
    // immediately via forkReservedInitialSession → buildReservedInitialInput,
    // which must COPY the frozen pendingCodexAppSteerable onto the opening payload.
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex-app',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
    });
    bot.resolvedAllowedUsers = [OWNER];

    await handleNewTopic(
      makeEventData('om_ct_new', '第一条真人交互消息'),
      makeCtx('om_ct_new', 'om_ct_new'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    // forkWorker's 2nd arg is the opening CliTurnPayload; it must carry the flag.
    const openingPayload = mocks.forkWorker.mock.calls[0]?.[1] as any;
    expect(openingPayload?.codexAppSteerable).toBe(true);
  });

  it('R7-B1: a plain-human Codex App `/workflow new` (v3-grill) NEW TOPIC stays forced-serial (control-rewrite is not steerable)', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex-app',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
    });
    bot.resolvedAllowedUsers = [OWNER];

    // A real human sends `/workflow new …`, but the generated/rewritten control
    // prompt must NOT be steerable (locked "v3-grill serial"). This is the
    // fail-open codex caught: the new-topic ds hardcoded threadGrill:false.
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    try {
      await handleNewTopic(
        makeEventData('om_grill_new', '/workflow new 修复首轮授权'),
        makeCtx('om_grill_new', 'om_grill_new'),
      );

      expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
      const openingPayload = mocks.forkWorker.mock.calls[0]?.[1] as any;
      expect(openingPayload?.codexAppSteerable).toBeUndefined();
    } finally {
      delete process.env.BOTMUX_WORKFLOW_ENABLED;
    }
  });

  it('R6/R7-B1: a Feishu bot-sender NEW TOPIC that forks stays forced-serial (no steer authorization)', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex-app',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
    });
    bot.resolvedAllowedUsers = [OWNER];
    // Authorize the bot sender as an operator so routing reaches the fork (we are
    // testing steer authorization, not the operate gate).
    mocks.getBot?.();

    // A bot sender (sender_type app) must NOT be authorized to steer. Force the
    // fork to actually happen so the assertion is not vacuous (codex nit).
    const botEvent = makeEventData('om_ct_bot', 'bot-originated new topic');
    botEvent.sender = { sender_id: { open_id: OWNER }, sender_type: 'app' };
    await handleNewTopic(botEvent, makeCtx('om_ct_bot', 'om_ct_bot'));

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const openingPayload = mocks.forkWorker.mock.calls[0]?.[1] as any;
    expect(openingPayload?.codexAppSteerable).toBeUndefined();
  });

  it('R7-B1 (production wiring): a known-peer bot open_id masquerading as sender_type:user is forced-serial via the new-topic isKnownPeerBot cross-ref (not just the helper truth table)', async () => {
    // codex R7 delta: initial-user-turn-opening only hand-feeds
    // {humanSender:false,isForeignBot:true} to the helper; it never exercises the
    // NEW-TOPIC production wiring at daemon.ts:16811/16814 that calls
    // isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId). This test
    // seeds a REAL bot-openid cross-ref, drives handleNewTopic with a sender whose
    // sender_type is (anomalously) 'user' but whose open_id IS a known peer bot,
    // forces the fork, and asserts the opening stays serial. Deleting either
    // isKnownPeerBot call turns this red (senderType==='user' alone would then set
    // humanSender true and authorize steer).
    const PEER_OPEN_ID = 'ou_known_peer_bot';
    // Seed the real cross-ref file the production helper reads.
    mkdirSync(config.session.dataDir, { recursive: true });
    const crossRefPath = join(config.session.dataDir, `bot-openids-${APP}.json`);
    writeFileSync(crossRefPath, JSON.stringify({ PeerBot: PEER_OPEN_ID }), 'utf-8');
    try {
      const bot = registerBot({
        larkAppId: APP,
        larkAppSecret: 's',
        cliId: 'codex-app',
        allowedUsers: [OWNER, PEER_OPEN_ID],
        defaultWorkingDir: '/tmp',
      });
      bot.resolvedAllowedUsers = [OWNER, PEER_OPEN_ID];

      // Anomalous: sender_type says 'user' (so isBotSenderType is FALSE — the
      // bot-sender fact alone would NOT catch this), but the open_id is a
      // registered peer bot. Only the isKnownPeerBot cross-ref wiring keeps it
      // serial.
      const peerEvent = makeEventData('om_kp_new', 'known-peer masquerading as user');
      peerEvent.sender = { sender_id: { open_id: PEER_OPEN_ID }, sender_type: 'user' };
      await handleNewTopic(peerEvent, makeCtx('om_kp_new', 'om_kp_new'));

      expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
      const openingPayload = mocks.forkWorker.mock.calls[0]?.[1] as any;
      expect(openingPayload?.codexAppSteerable).toBeUndefined();
    } finally {
      rmSync(crossRefPath, { force: true });
    }
  });

  it('R7-B1 (production wiring, positive control): a genuine human sender_type:user NOT in the cross-ref DOES authorize steer via handleNewTopic — proving the cross-ref is the discriminator', async () => {
    // Positive counterpart to the known-peer test: same seeded cross-ref, but a
    // real human whose open_id is NOT a peer bot. This must fork WITH steer
    // authorization — proving the serial result above is specifically the
    // isKnownPeerBot match, not some unrelated gate suppressing everything.
    const PEER_OPEN_ID = 'ou_known_peer_bot';
    const HUMAN_OPEN_ID = 'ou_real_human_new';
    mkdirSync(config.session.dataDir, { recursive: true });
    const crossRefPath = join(config.session.dataDir, `bot-openids-${APP}.json`);
    writeFileSync(crossRefPath, JSON.stringify({ PeerBot: PEER_OPEN_ID }), 'utf-8');
    try {
      const bot = registerBot({
        larkAppId: APP,
        larkAppSecret: 's',
        cliId: 'codex-app',
        allowedUsers: [OWNER, HUMAN_OPEN_ID],
        defaultWorkingDir: '/tmp',
      });
      bot.resolvedAllowedUsers = [OWNER, HUMAN_OPEN_ID];

      const humanEvent = makeEventData('om_human_new', '第一条真人交互消息');
      humanEvent.sender = { sender_id: { open_id: HUMAN_OPEN_ID }, sender_type: 'user' };
      await handleNewTopic(humanEvent, makeCtx('om_human_new', 'om_human_new'));

      expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
      const openingPayload = mocks.forkWorker.mock.calls[0]?.[1] as any;
      expect(openingPayload?.codexAppSteerable).toBe(true);
    } finally {
      rmSync(crossRefPath, { force: true });
    }
  });

  it('uses the group name for mention-only sessions on both creation paths', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [OWNER];
    mocks.getChatNameAndMode.mockResolvedValue({
      name: 'BotMux 标题优化群',
      mode: 'topic',
    });

    await handleNewTopic(
      makeMentionOnlyEventData('om_group_title_new'),
      makeCtx('om_group_title_new', 'om_group_title_new'),
    );
    const newTopic = activeSessions.get(sessionKey('om_group_title_new', APP));
    expect(newTopic?.session.chatDisplayName).toBe('BotMux 标题优化群');
    expect(newTopic?.session.nativeSessionTitle).toBe('[BotMux·Lark] BotMux 标题优化群');

    activeSessions.clear();
    await handleThreadReply(
      makeMentionOnlyEventData('om_group_title_reply', 'om_group_title_root'),
      makeCtx('om_group_title_root', 'om_group_title_reply'),
    );
    const safetyNet = activeSessions.get(sessionKey('om_group_title_root', APP));
    expect(safetyNet?.session.chatDisplayName).toBe('BotMux 标题优化群');
    expect(safetyNet?.session.nativeSessionTitle).toBe('[BotMux·Lark] BotMux 标题优化群');
    expect(mocks.getChatNameAndMode).toHaveBeenCalledTimes(2);
  });

  it('delivers an ordinary loser turn to the canonical owner exactly once', async () => {
    const anchor = 'om_collision_delivery';
    const incumbent = seedThreadSession(anchor, 'canonical owner');
    const send = vi.fn();
    incumbent.worker = { killed: false, send } as any;

    await handleNewTopic(
      makeEventData(anchor, 'deliver this once'),
      makeCtx(anchor, anchor),
    );

    expect(activeSessions.get(sessionKey(anchor, APP))).toBe(incumbent);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.closeSession).toHaveBeenCalledWith(
      mocks.createSession.mock.results[0]!.value.sessionId,
    );
    const inputCalls = send.mock.calls.filter(call => call[0]?.type === 'message');
    expect(inputCalls).toHaveLength(1);
    expect(JSON.stringify(inputCalls[0]![0])).toContain('deliver this once');
  });

  it('buffers a later turn while the winning initial start is paused, then forks once in input order', async () => {
    registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
    }).resolvedAllowedUsers = [OWNER];

    let announcePreparation!: () => void;
    const preparationStarted = new Promise<void>(resolve => { announcePreparation = resolve; });
    let releasePreparation!: (bots: any[]) => void;
    const preparationGate = new Promise<any[]>(resolve => { releasePreparation = resolve; });
    mocks.getAvailableBots.mockImplementationOnce(async () => {
      announcePreparation();
      return preparationGate;
    });

    const anchor = 'om_initial_order_root';
    const first = handleNewTopic(
      makeEventData(anchor, 'first task'),
      makeCtx(anchor, anchor),
    );
    await preparationStarted;

    const owner = activeSessions.get(sessionKey(anchor, APP))!;
    expect(owner.initialStartPending).toBe(true);
    expect(owner.worker).toBeNull();

    await handleThreadReply(
      makeEventData('om_initial_order_second', 'second task', anchor),
      makeCtx(anchor, 'om_initial_order_second'),
    );

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(owner.pendingFollowUps).toBeUndefined();
    expect(owner.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'om_initial_order_second',
        cliInput: expect.objectContaining({
          content: expect.stringContaining('second task'),
        }),
      }),
    ]);

    releasePreparation([]);
    await first;

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const openingInput = mocks.forkWorker.mock.calls[0]![1];
    expect(openingInput.content.indexOf('first task')).toBeGreaterThanOrEqual(0);
    expect(openingInput.content).not.toContain('second task');
    expect(owner.worker!.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_initial_order_second',
      content: expect.stringContaining('second task'),
      queuedActivationToken: expect.any(String),
    }));
    expect(owner.initialStartPending).toBe(true);
    expect(owner.pendingFollowUps).toBeUndefined();
  });

  it('keeps the no-project text fallback gated until its queued activation ACK', async () => {
    const anchor = 'om_no_project_text_cutpoint';
    const openingToken = 'token-no-project-text';
    const send = vi.fn();
    mocks.forkWorker.mockImplementationOnce((owner: any, input: any) => {
      expect(owner.session.queued).toBe(true);
      expect(input.content).toContain('OPENING_TEXT_N');
      Object.assign(owner.session, {
        queued: false,
        queuedActivationPending: true,
        queuedActivationToken: openingToken,
        queuedActivationInput: input,
        queuedActivationTurnId: anchor,
        queuedActivationResume: false,
      });
      owner.worker = { killed: false, send };
    });

    await handleNewTopic(
      makeEventData(anchor, 'OPENING_TEXT_N'),
      makeCtx(anchor, anchor),
    );

    const owner = activeSessions.get(sessionKey(anchor, APP))!;
    expect(mocks.scanMultipleProjects).toHaveBeenCalled();
    expect(owner.pendingRepo).toBe(false);
    expect(owner.initialStartPending).toBe(true);
    expect(owner.session.queuedActivationToken).toBe(openingToken);

    await handleThreadReply(
      makeEventData('om_no_project_text_n1', 'FOLLOWER_TEXT_N_PLUS_1', anchor),
      makeCtx(anchor, 'om_no_project_text_n1'),
    );

    expect(send).not.toHaveBeenCalled();
    expect(owner.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'om_no_project_text_n1',
        cliInput: expect.objectContaining({
          content: expect.stringContaining('FOLLOWER_TEXT_N_PLUS_1'),
        }),
      }),
    ]);

    Object.assign(owner.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationResume: undefined,
      pendingRepoSetup: undefined,
    });
    expect(onQueuedActivationSubmitted(owner, openingToken)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_no_project_text_n1',
      content: expect.stringContaining('FOLLOWER_TEXT_N_PLUS_1'),
      queuedActivationToken: expect.any(String),
    }));
  });

  it('keeps the no-project raw fallback gated through raw text-to-Enter ACK', async () => {
    const anchor = 'om_no_project_raw_cutpoint';
    const openingToken = 'token-no-project-raw';
    const rawOpening = '/goal OPENING_RAW_N';
    const send = vi.fn();
    mocks.forkWorker.mockImplementationOnce((owner: any, input: any) => {
      expect(owner.session.queued).toBe(true);
      expect(input).toBe('');
      expect(owner.pendingRawInput).toBe(rawOpening);
      Object.assign(owner.session, {
        queued: false,
        queuedActivationPending: true,
        queuedActivationToken: openingToken,
        queuedActivationInput: { content: '' },
        queuedActivationTurnId: anchor,
        queuedActivationResume: false,
      });
      owner.worker = { killed: false, send };
    });

    await handleNewTopic(
      makeEventData(anchor, rawOpening),
      makeCtx(anchor, anchor),
    );

    const owner = activeSessions.get(sessionKey(anchor, APP))!;
    expect(mocks.scanMultipleProjects).toHaveBeenCalled();
    expect(owner.pendingRepo).toBe(false);
    expect(owner.initialStartPending).toBe(true);
    expect(owner.session.queuedActivationToken).toBe(openingToken);

    await handleThreadReply(
      makeEventData('om_no_project_raw_n1', 'FOLLOWER_AFTER_RAW_N_PLUS_1', anchor),
      makeCtx(anchor, 'om_no_project_raw_n1'),
    );

    // The follower must stay durable until the adapter confirms that both the
    // raw command text and its Enter beat were submitted.
    expect(send).not.toHaveBeenCalled();
    expect(owner.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'om_no_project_raw_n1',
        cliInput: expect.objectContaining({
          content: expect.stringContaining('FOLLOWER_AFTER_RAW_N_PLUS_1'),
        }),
      }),
    ]);

    Object.assign(owner.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationResume: undefined,
      pendingRepoSetup: undefined,
    });
    expect(onQueuedActivationSubmitted(owner, openingToken)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_no_project_raw_n1',
      content: expect.stringContaining('FOLLOWER_AFTER_RAW_N_PLUS_1'),
      queuedActivationToken: expect.any(String),
    }));
  });

  it('refuses an existing raw CLI passthrough while activation admission owns the route', async () => {
    const anchor = 'om_passthrough_activation';
    const owner = seedThreadSession(anchor, 'activation owner');
    const send = vi.fn();
    owner.worker = { killed: false, send } as any;
    Object.assign(owner.session, {
      queuedActivationPending: true,
      queuedActivationToken: 'passthrough-token',
      queuedActivationInput: { content: 'OPENING_N' },
      queuedActivationTurnId: 'turn-opening',
    });

    await handleThreadReply(
      makeEventData('om_passthrough_n1', '/model opus', anchor),
      makeCtx(anchor, 'om_passthrough_n1'),
    );

    expect(send).not.toHaveBeenCalled();
    expect(owner.currentTurnTitle).toBeUndefined();
    expect(owner.session.queuedActivationToken).toBe('passthrough-token');
    expect(repliedText()).toContain('仍在提交中');
  });

  it('replays a retained queued activation exactly, then releases the later inbound with its own turn id', async () => {
    const anchor = 'om_reparked_activation_root';
    const ds = seedThreadSession(anchor, 're-parked activation');
    const exactOpening = {
      content: '<user_message>BACKLOG_N\n\nPRIOR_TRIGGER_REPLY</user_message>',
    };
    Object.assign(ds.session, {
      cliId: 'claude-code',
      workingDir: '/tmp',
      queued: true,
      queuedPrompt: 'STALE_REBUILD_SOURCE_MUST_NOT_BE_USED',
      queuedActivationInput: exactOpening,
      queuedActivationTurnId: 'om_prior_trigger',
      queuedActivationDispatchAttempt: 4,
    });
    ds.workingDir = '/tmp';

    await handleThreadReply(
      makeEventData('om_later_n_plus_1', 'LATER_REPLY_N_PLUS_1', anchor),
      makeCtx(anchor, 'om_later_n_plus_1'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledWith(ds, exactOpening, {
      resume: false,
      turnId: 'om_prior_trigger',
      dispatchAttempt: 4,
    });
    expect(mocks.forkWorker.mock.calls[0]![1]).toBe(exactOpening);
    expect(JSON.stringify(mocks.forkWorker.mock.calls[0]![1]))
      .not.toContain('STALE_REBUILD_SOURCE_MUST_NOT_BE_USED');
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'om_later_n_plus_1',
        userPrompt: expect.stringContaining('LATER_REPLY_N_PLUS_1'),
        cliInput: expect.objectContaining({
          content: expect.stringContaining('LATER_REPLY_N_PLUS_1'),
        }),
      }),
    ]);

    const send = vi.mocked(ds.worker!.send);
    expect(releaseQueuedActivationReservation(ds)).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_later_n_plus_1',
      content: expect.stringContaining('LATER_REPLY_N_PLUS_1'),
      queuedActivationToken: expect.any(String),
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.invocationCallOrder[0])
      .toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedActivationInput?.content).toContain('LATER_REPLY_N_PLUS_1');
    const successorToken = ds.session.queuedActivationToken!;
    // The worker-pool clears the tokened journal durably before invoking the
    // daemon callback. Model that adapter ACK boundary explicitly here.
    Object.assign(ds.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationDispatchAttempt: undefined,
      queuedActivationResume: undefined,
    });
    expect(onQueuedActivationSubmitted(ds, successorToken)).toBe(true);
    expect(ds.initialStartPending).toBe(false);
  });

  it.each([
    { label: 'one buffered', bufs: ['BUFFERED_ONE'], turnIds: ['om_buf_1'], gates: [true] },
    { label: 'two buffered', bufs: ['BUFFERED_ONE', 'BUFFERED_TWO'], turnIds: ['om_buf_1', 'om_buf_2'], gates: [true, true] },
  ])('R7 coalesced-serial ($label): folds into one serial turn — NO steerable at ALL THREE layers even when every clean-input gate decision is true', async ({ bufs, turnIds, gates }) => {
    // codex ruling: coalescing N buffered opening-window messages into one prompt
    // / one ledger reservation / one final loses per-message identity, so the
    // batch is FORCED-SERIAL by construction. The clean-input feature gate
    // (pendingCodexAppFollowUpGateAccepted) is NOT a steer authorization and must
    // never derive codexAppSteerable — even when ALL true, whether one message or
    // many. Assert all THREE layers stay clean so a future single-message
    // fast-path special-case, or a ledger-side mis-derivation (replacement restore
    // then authorize), would translate into a red test.
    const anchor = 'om_coalesced_root';
    const ds = seedThreadSession(anchor, 'coalesced serial');
    Object.assign(ds.session, { cliId: 'codex-app', workingDir: '/tmp' });
    ds.workingDir = '/tmp';
    ds.worker = { killed: false, send: vi.fn() } as any;
    ds.pendingFollowUps = [...bufs];
    ds.pendingFollowUpTurnIds = [...turnIds];
    ds.pendingCodexAppFollowUps = [...bufs];
    ds.pendingCodexAppFollowUpContexts = bufs.map(() => '');
    // Every buffered message was clean-input-accepted (all true) — must NOT leak
    // into a steer authorization at any layer.
    ds.pendingCodexAppFollowUpGateAccepted = [...gates];

    expect(releaseQueuedActivationReservation(ds)).toBe(true);

    // release admits the coalesced tail then promotes+sends it. After that, the
    // three durable/live surfaces all persist on ds — assert steerable is absent
    // on each:
    //   (1) the promoted queuedActivationInput payload (frozen opening input),
    //   (2) the accepted codexAppDispatchLedger entry for this coalesced turn,
    //   (3) the actual worker IPC message (authoritative delivered form).
    // Layer 1: promoted opening input.
    expect(ds.session.queuedActivationInput).toBeTruthy();
    expect((ds.session.queuedActivationInput as any).codexAppSteerable).toBeUndefined();
    // Layer 2: accepted dispatch ledger entry (the coalesced turn's token entry).
    const ledger = ds.session.codexAppDispatchLedger ?? [];
    const coalescedEntry = ledger.find(e => e.queuedActivationToken !== undefined);
    expect(coalescedEntry).toBeTruthy();
    expect((coalescedEntry as any).codexAppSteerable).toBeUndefined();
    // Layer 3: the worker IPC that delivered it.
    const send = vi.mocked(ds.worker!.send);
    const msg = send.mock.calls.map(c => c[0] as any).find(m => m?.type === 'message');
    expect(msg).toBeTruthy();
    expect(msg.content).toContain('BUFFERED_ONE');
    if (bufs.length > 1) expect(msg.content).toContain('BUFFERED_TWO');
    expect(msg.codexAppSteerable).toBeUndefined();
  });

  it('routes Codex /fast verbatim to a live session but never cold-starts one', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [OWNER];

    // Live session: /fast is forwarded verbatim as a passthrough keystroke.
    const send = vi.fn();
    const live = seedLiveChatSession(send);
    live.session.cliId = 'codex';
    await handleThreadReply(
      makeEventData('om_fast_live', '/fast', 'om_fast_reply_root'),
      {
        chatId: CHAT,
        messageId: 'om_fast_live',
        chatType: 'group',
        scope: 'chat',
        anchor: CHAT,
        replyRootId: 'om_fast_reply_root',
        larkAppId: APP,
      },
    );
    expect(send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/fast',
      turnId: 'om_fast_live',
    });

    // Cold (no existing session): /fast is a tier toggle, not "start work", so
    // owner policy is it must NOT cold-start a session — reply requires-session,
    // create nothing, fork nothing. (Regression guard: an earlier revision had
    // /fast in the codex adapter default and would spawn a worker here.)
    activeSessions.clear();
    mocks.forkWorker.mockClear();
    mocks.replyMessage.mockClear();
    await handleThreadReply(
      makeEventData('om_fast_cold', '/fast', 'om_fast_cold_root'),
      makeCtx('om_fast_cold_root', 'om_fast_cold'),
    );
    expect(activeSessions.get(sessionKey('om_fast_cold_root', APP))).toBeUndefined();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    // Rejected without spawning — the exact copy ("needs an active CLI" vs
    // "requires an existing session") is not what this guards; the point is
    // no cold-start.
    expect(repliedText()).toMatch(/需要活跃的 CLI 进程|需要在已有会话内使用/);
  });

  it('routes slash text by the frozen session CLI: Codex App structured, interactive Codex raw', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [OWNER];

    // The bot currently defaults to interactive Codex, but this existing
    // session was created as Codex App. `/model` must enter the ordinary App
    // Server turn lane so worker dispatch attribution is reserved.
    const appSend = vi.fn();
    const appSession = seedLiveChatSession(appSend);
    appSession.session.cliId = 'codex-app';
    await handleThreadReply(
      makeEventData('om_model_app', '/model', 'om_model_app_root'),
      {
        chatId: CHAT,
        messageId: 'om_model_app',
        chatType: 'group',
        scope: 'chat',
        anchor: CHAT,
        replyRootId: 'om_model_app_root',
        larkAppId: APP,
      },
    );
    expect(appSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'raw_input' }));
    expect(appSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_model_app',
      content: expect.stringContaining('/model'),
    }));

    // Inverse control: changing the bot default to Codex App must not remove
    // native slash support from an already-running interactive Codex session.
    activeSessions.clear();
    const appDefault = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex-app',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    appDefault.resolvedAllowedUsers = [OWNER];
    const tuiSend = vi.fn();
    const tuiSession = seedLiveChatSession(tuiSend);
    tuiSession.session.cliId = 'codex';
    await handleThreadReply(
      makeEventData('om_model_tui', '/model', 'om_model_tui_root'),
      {
        chatId: CHAT,
        messageId: 'om_model_tui',
        chatType: 'group',
        scope: 'chat',
        anchor: CHAT,
        replyRootId: 'om_model_tui_root',
        larkAppId: APP,
      },
    );
    expect(tuiSend).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/model',
      turnId: 'om_model_tui',
    });
  });

  it('routes the ADAPTER-SCOPED /goal by frozen CLI too (not just builtin /model)', async () => {
    // Builtin `/model` lives in PASSTHROUGH_COMMANDS and never touches the
    // adapter layer, so it can mask a bug where the frozen CLI fails to reach
    // resolveAdapterDefaultPassthroughCommands. `/goal` IS adapter-scoped
    // (codex only), so it is the command that actually proves the override is
    // threaded all the way through. Before the fix, the first leg below sent a
    // structured `message` instead of `raw_input`.
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex-app',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [OWNER];

    // Bot default flipped to Codex App, but this session is frozen as
    // interactive Codex → its native adapter `/goal` must stay raw_input.
    const tuiSend = vi.fn();
    const tuiSession = seedLiveChatSession(tuiSend);
    tuiSession.session.cliId = 'codex';
    await handleThreadReply(
      makeEventData('om_goal_tui', '/goal', 'om_goal_tui_root'),
      {
        chatId: CHAT,
        messageId: 'om_goal_tui',
        chatType: 'group',
        scope: 'chat',
        anchor: CHAT,
        replyRootId: 'om_goal_tui_root',
        larkAppId: APP,
      },
    );
    expect(tuiSend).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal',
      turnId: 'om_goal_tui',
    });

    // Inverse: bot default is interactive Codex, but a frozen Codex App session
    // has NO passthrough surface → `/goal` must go structured, never raw_input.
    activeSessions.clear();
    const codexDefault = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    codexDefault.resolvedAllowedUsers = [OWNER];
    const appSend = vi.fn();
    const appSession = seedLiveChatSession(appSend);
    appSession.session.cliId = 'codex-app';
    await handleThreadReply(
      makeEventData('om_goal_app', '/goal', 'om_goal_app_root'),
      {
        chatId: CHAT,
        messageId: 'om_goal_app',
        chatType: 'group',
        scope: 'chat',
        anchor: CHAT,
        replyRootId: 'om_goal_app_root',
        larkAppId: APP,
      },
    );
    expect(appSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'raw_input' }));
    expect(appSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_goal_app',
      content: expect.stringContaining('/goal'),
    }));
  });

  it('fails closed on /fast for RPC-input / Riff backends (no raw_input, clear reply)', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [OWNER];

    // A codex session whose backend can't receive the /fast keystroke: Riff runs
    // turns off the terminal (text+CR would become two remote tasks); RPC input
    // mode's pane is a pure viewer. Either way the toggle can't reach the
    // executor, so /fast must be rejected — never delivered as a no-op/junk.
    for (const setup of [
      (ds: any) => { ds.session.backendType = 'riff'; },
      (ds: any) => { ds.initConfig = { type: 'init', codexRpcInput: true }; },
    ]) {
      activeSessions.clear();
      mocks.replyMessage.mockClear();
      const send = vi.fn();
      const ds = seedLiveChatSession(send);
      ds.session.cliId = 'codex';
      setup(ds);
      await handleThreadReply(
        makeEventData('om_fast_fc', '/fast', 'om_fast_fc_root'),
        {
          chatId: CHAT,
          messageId: 'om_fast_fc',
          chatType: 'group',
          scope: 'chat',
          anchor: CHAT,
          replyRootId: 'om_fast_fc_root',
          larkAppId: APP,
        },
      );
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'raw_input' }));
      expect(repliedText()).toMatch(/切不了 Codex 档位|can't toggle/);
    }
  });

  it('thread safety-net: passes the accepted reply id into the first worker', async () => {
    process.env.BOTMUX_WORKFLOW_ENABLED = 'true';
    try {
      registerBot({
        larkAppId: APP,
        larkAppSecret: 's',
        cliId: 'claude-code',
        allowedUsers: [OWNER],
        defaultWorkingDir: '/tmp',
      }).resolvedAllowedUsers = [OWNER];
      await handleThreadReply(
        makeEventData('om_workflow_reply', '/workflow new 修复首轮授权', 'om_fresh_root'),
        makeCtx('om_fresh_root', 'om_workflow_reply'),
      );

      expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
      expect(mocks.forkWorker.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
        turnId: 'om_workflow_reply',
      }));
    } finally {
      delete process.env.BOTMUX_WORKFLOW_ENABLED;
    }
  });

  it('live passthrough binds raw input and reply metadata to the accepted message', async () => {
    const send = vi.fn();
    const ds = seedLiveChatSession(send);
    const messageId = 'om_model_turn';
    const replyRootId = 'om_model_reply_root';

    await handleThreadReply(
      makeEventData(messageId, '/model opus', replyRootId),
      {
        chatId: CHAT,
        messageId,
        chatType: 'group' as const,
        scope: 'chat' as const,
        anchor: CHAT,
        replyRootId,
        larkAppId: APP,
      },
    );

    expect(send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/model opus',
      turnId: messageId,
    });
    expect(ds.session.quoteTargetId).toBe(messageId);
    expect(ds.session.quoteTargetSenderOpenId).toBe(OWNER);
    expect(ds.session.lastCallerOpenId).toBe(OWNER);
    expect(ds.currentReplyTarget).toMatchObject({ rootMessageId: replyRootId, turnId: messageId });
    expect(ds.session.currentReplyTarget).toMatchObject({ rootMessageId: replyRootId, turnId: messageId });
    expect(mocks.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('pending raw same-caller follow-up keeps the raw root and stages an exact successor', async () => {
    const anchor = 'om_pending_raw_root';
    const ds = seedPendingRawSession(anchor);
    const messageId = 'om_pending_raw_followup';

    await handleThreadReply(
      makeEventData(messageId, '补充同一个人的要求', anchor),
      makeCtx(anchor, messageId),
    );

    // Raw root identity is preserved — never rotated onto the follow-up.
    expect(ds.pendingRawTurnId).toBe('om_initial_raw');
    // The follow-up does NOT fall back into the legacy source buffer.
    expect(ds.pendingFollowUpTurnId).toBeUndefined();
    expect(ds.pendingFollowUps).toBeUndefined();
    // It is durably staged as exactly one exact-turn-id successor carrying the
    // follow-up content.
    const tail = ds.session.queuedActivationTail ?? [];
    expect(tail).toHaveLength(1);
    expect(tail[0]?.turnId).toBe(messageId);
    expect(
      (tail[0]?.userPrompt ?? '') + (tail[0]?.cliInput?.content ?? ''),
    ).toContain('补充同一个人的要求');
    // The latest global quote pointer still advances (per-turn frozen context /
    // ledger carries the actual delivery identity).
    expect(ds.session.quoteTargetId).toBe(messageId);
  });


  it('atomically claims a fresh queued refork so a concurrent reply buffers behind its owner', async () => {
    const anchor = 'om_fresh_queued_claim_root';
    const ds = seedThreadSession(anchor, 'fresh queued claim');
    Object.assign(ds.session, {
      cliId: 'claude-code',
      workingDir: '/tmp',
      queued: true,
      queuedPrompt: 'BACKLOG_N',
    });
    ds.workingDir = '/tmp';

    let announceFirstDownload!: () => void;
    const firstDownloadStarted = new Promise<void>(resolve => { announceFirstDownload = resolve; });
    let releaseFirstDownload!: () => void;
    const firstDownloadGate = new Promise<void>(resolve => { releaseFirstDownload = resolve; });
    mocks.downloadResources.mockImplementationOnce(async () => {
      announceFirstDownload();
      await firstDownloadGate;
      return { attachments: [], needLogin: false };
    });

    const first = handleThreadReply(
      makeEventData('om_fresh_owner_n', 'OWNER_REPLY_N', anchor),
      makeCtx(anchor, 'om_fresh_owner_n'),
    );
    await firstDownloadStarted;

    expect(ds.initialStartPending).toBe(true);
    expect(ds.initialStartClaimToken).toEqual(expect.any(String));
    const ownerToken = ds.initialStartClaimToken;

    const follower = handleThreadReply(
      makeEventData('om_fresh_follower_n1', 'FOLLOWER_REPLY_N_PLUS_1', anchor),
      makeCtx(anchor, 'om_fresh_follower_n1'),
    );

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds.initialStartClaimToken).toBe(ownerToken);

    releaseFirstDownload();
    await first;
    await follower;

    expect(ds.pendingFollowUps).toBeUndefined();
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'om_fresh_follower_n1',
        cliInput: expect.objectContaining({
          content: expect.stringContaining('FOLLOWER_REPLY_N_PLUS_1'),
        }),
      }),
    ]);

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const opening = mocks.forkWorker.mock.calls[0]![1];
    expect(opening.content.indexOf('BACKLOG_N')).toBeGreaterThanOrEqual(0);
    expect(opening.content.indexOf('OWNER_REPLY_N')).toBeGreaterThan(opening.content.indexOf('BACKLOG_N'));
    expect(opening.content).not.toContain('FOLLOWER_REPLY_N_PLUS_1');
    expect(ds.initialStartPending).toBe(true);
    expect(ds.initialStartClaimToken).toBe(ownerToken);

    const send = vi.mocked(ds.worker!.send);
    expect(onQueuedActivationSubmitted(ds)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_fresh_follower_n1',
      content: expect.stringContaining('FOLLOWER_REPLY_N_PLUS_1'),
      queuedActivationToken: expect.any(String),
    }));
    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedActivationInput?.content).toContain('FOLLOWER_REPLY_N_PLUS_1');
    const successorToken = ds.session.queuedActivationToken!;
    Object.assign(ds.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationDispatchAttempt: undefined,
      queuedActivationResume: undefined,
    });
    expect(onQueuedActivationSubmitted(ds, successorToken)).toBe(true);
    expect(ds.initialStartPending).toBe(false);
    expect(ds.initialStartClaimToken).toBeUndefined();
  });

  it.each([
    { arrivalGate: true, laterGate: false, expectsSidecar: true, label: 'ON→OFF' },
    { arrivalGate: false, laterGate: true, expectsSidecar: false, label: 'OFF→ON' },
  ])(
    'freezes a queued follower clean-input decision at reservation time ($label)',
    ({ arrivalGate, laterGate, expectsSidecar }) => {
      const bot = registerBot({
        larkAppId: APP,
        larkAppSecret: 's',
        cliId: 'codex-app',
        codexAppCleanInput: arrivalGate,
        allowedUsers: [OWNER],
      });
      bot.resolvedAllowedUsers = [OWNER];
      const ds = seedThreadSession(`om_gate_${arrivalGate}`, 'clean-input reservation');
      const send = vi.fn();
      ds.worker = { killed: false, send } as any;
      ds.initialStartPending = true;
      ds.hasHistory = true;
      ds.session.cliId = 'codex-app';

      const reservation = reserveAsyncQueuedActivationTailAdmission(ds);
      expect(ds.queuedActivationTailAdmissionsOutstanding).toBe(1);
      bot.config.codexAppCleanInput = laterGate;

      // Model N's ACK landing while N+1 is still awaiting prompt materialization.
      expect(releaseQueuedActivationReservation(ds, 'opening-token')).toBe(false);
      const sidecar = {
        text: 'FOLLOWER_CLEAN_N1',
        additionalContext: {
          hidden: { kind: 'application' as const, value: '<hidden>arrival</hidden>' },
        },
      };
      admitQueuedActivationTail(ds, {
        userPrompt: 'FOLLOWER_CLEAN_N1',
        cliInput: {
          content: '<user_message>FOLLOWER_LEGACY_N1</user_message>',
          codexAppInput: sidecar,
        },
        turnId: 'turn-clean-follower',
        dispatchAttempt: 2,
      }, reservation);
      settleAsyncQueuedActivationTailAdmission(ds);

      const expectedSidecar = expectsSidecar
        ? { ...sidecar, clientUserMessageId: 'turn-clean-follower' }
        : undefined;
      expect(ds.queuedActivationTailAdmissionsOutstanding).toBeUndefined();
      expect(ds.queuedActivationTailReleasePending).toBeUndefined();
      expect(ds.session.queuedActivationTail).toBeUndefined();
      expect(ds.session.queuedActivationInput?.codexAppInput).toEqual(expectedSidecar);
      expect(ds.session.codexAppDispatchLedger?.at(-1)?.codexAppInput)
        .toEqual(expectedSidecar);
      expect(ds.session.lastCodexAppInput).toEqual(expectedSidecar);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'message',
        turnId: 'turn-clean-follower',
        ...(expectedSidecar ? { codexAppInput: expectedSidecar } : {}),
      }));
      if (!expectedSidecar) {
        expect(send.mock.calls[0]![0]).not.toHaveProperty('codexAppInput');
      }
    },
  );

  it('parks a late follower after ACK→worker-exit and reforks it before the next inbound', async () => {
    const anchor = 'om_ack_exit_late_admission';
    const ds = seedThreadSession(anchor, 'ACK exit late admission');
    ds.session.cliId = 'claude-code';
    ds.workingDir = '/tmp';
    ds.session.workingDir = '/tmp';
    ds.hasHistory = true;
    ds.initialStartPending = true;
    ds.worker = { killed: false, send: vi.fn() } as any;

    const reservation = reserveAsyncQueuedActivationTailAdmission(ds);
    expect(releaseQueuedActivationReservation(ds, 'opening-token')).toBe(false);
    // N's worker exits after its ACK but before the reserved N+1 finishes.
    ds.worker = null;
    admitQueuedActivationTail(ds, {
      userPrompt: 'LATE_N_PLUS_1',
      cliInput: { content: 'LATE_N_PLUS_1' },
      turnId: 'turn-late-n1',
    }, reservation);
    settleAsyncQueuedActivationTailAdmission(ds);

    expect(ds.session).toMatchObject({
      queuedActivationPending: true,
      queuedActivationInput: { content: 'LATE_N_PLUS_1' },
      queuedActivationTurnId: 'turn-late-n1',
    });
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.initialStartPending).toBe(false);
    expect(ds.initialStartClaimToken).toBeUndefined();
    expect(ds.queuedActivationTailReleaseRetryTimer).toBeUndefined();

    mocks.forkWorker.mockClear();
    await handleThreadReply(
      makeEventData('turn-after-late-n2', 'AFTER_LATE_N_PLUS_2', anchor),
      makeCtx(anchor, 'turn-after-late-n2'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.calls[0]![1]).toBe(ds.session.queuedActivationInput);
    expect(mocks.forkWorker.mock.calls[0]![1].content).toBe('LATE_N_PLUS_1');
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'turn-after-late-n2',
        cliInput: expect.objectContaining({
          content: expect.stringContaining('AFTER_LATE_N_PLUS_2'),
        }),
      }),
    ]);
  });

  it('releases the route when a post-ACK async follower admission fails', () => {
    const ds = seedThreadSession('om_failed_late_admission', 'failed late admission');
    ds.session.cliId = 'claude-code';
    ds.initialStartPending = true;
    ds.worker = { killed: false, send: vi.fn() } as any;
    const reservation = reserveAsyncQueuedActivationTailAdmission(ds);
    expect(releaseQueuedActivationReservation(ds, 'opening-token')).toBe(false);
    mocks.updateSession.mockImplementationOnce(() => {
      throw new Error('tail persistence unavailable');
    });

    expect(() => {
      try {
        admitQueuedActivationTail(ds, {
          userPrompt: 'FAILED_N_PLUS_1',
          cliInput: { content: 'FAILED_N_PLUS_1' },
          turnId: 'turn-failed-n1',
        }, reservation);
      } finally {
        settleAsyncQueuedActivationTailAdmission(ds);
      }
    }).toThrow('tail persistence unavailable');

    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.queuedActivationTailAdmissionsOutstanding).toBeUndefined();
    expect(ds.queuedActivationTailReleasePending).toBeUndefined();
    expect(ds.initialStartPending).toBe(false);
    expect(ds.initialStartClaimToken).toBeUndefined();
    expect(ds.queuedActivationTailReleaseRetryTimer).toBeUndefined();
  });

  it('releases a failed queued-refork claim so a later inbound can become the owner', async () => {
    const anchor = 'om_failed_queued_claim_root';
    const ds = seedThreadSession(anchor, 'failed queued claim');
    Object.assign(ds.session, {
      cliId: 'claude-code',
      workingDir: '/tmp',
      queued: true,
      queuedPrompt: 'BACKLOG_RETRY',
    });
    ds.workingDir = '/tmp';
    mocks.forkWorker.mockImplementationOnce(() => {
      throw new Error('pre-fork acceptance failed');
    });

    await expect(handleThreadReply(
      makeEventData('om_failed_owner', 'FAILED_OWNER_REPLY', anchor),
      makeCtx(anchor, 'om_failed_owner'),
    )).rejects.toThrow('pre-fork acceptance failed');

    expect(ds.worker).toBeNull();
    expect(ds.initialStartPending).toBe(false);
    expect(ds.initialStartClaimToken).toBeUndefined();

    mocks.forkWorker.mockImplementation((owner: any) => {
      owner.worker = { killed: false, send: vi.fn() };
    });
    await handleThreadReply(
      makeEventData('om_retry_owner', 'RETRY_OWNER_REPLY', anchor),
      makeCtx(anchor, 'om_retry_owner'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(2);
    expect(mocks.forkWorker.mock.calls[1]![1].content).toContain('RETRY_OWNER_REPLY');
    expect(ds.initialStartPending).toBe(true);
    expect(ds.initialStartClaimToken).toEqual(expect.any(String));
  });

  it('retains a tokened generic ACK successor after IPC failure and recovers it before the next inbound', async () => {
    const anchor = 'om_ack_tail_handoff_root';
    const ds = seedThreadSession(anchor, 'ACK tail handoff');
    Object.assign(ds.session, {
      cliId: 'claude-code',
      workingDir: '/tmp',
      queued: false,
    });
    ds.workingDir = '/tmp';
    ds.hasHistory = true;
    ds.initialStartPending = true;
    ds.pendingFollowUps = ['GENERIC_TAIL_N_PLUS_1'];
    ds.pendingFollowUpTurnIds = ['om_generic_tail_n_plus_1'];
    const failedSend = vi.fn(() => { throw new Error('worker exited before accepting tail'); });
    const kill = vi.fn();
    ds.worker = { killed: false, send: failedSend, kill } as any;

    // Promotion is already a durable acceptance boundary: an IPC throw fences
    // this child but keeps one tokened journal owner for exact recovery.
    expect(onQueuedActivationSubmitted(ds)).toBe(true);
    expect(failedSend).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(ds.pendingFollowUps).toBeUndefined();
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.session).toMatchObject({
      queued: false,
      queuedActivationPending: true,
      queuedActivationToken: expect.any(String),
      queuedActivationTurnId: 'om_generic_tail_n_plus_1',
      queuedActivationInput: expect.objectContaining({
        content: expect.stringContaining('GENERIC_TAIL_N_PLUS_1'),
      }),
    });
    const retainedToken = ds.session.queuedActivationToken;
    // Model the worker error/exit fence (the route test uses a lightweight
    // child stub without worker-pool event handlers).
    ds.worker = null;
    ds.initialStartPending = false;
    ds.initialStartClaimToken = undefined;
    expect(ds.initialStartPending).toBe(false);

    mocks.forkWorker.mockClear();
    await handleThreadReply(
      makeEventData('om_after_tail_n_plus_2', 'AFTER_TAIL_N_PLUS_2', anchor),
      makeCtx(anchor, 'om_after_tail_n_plus_2'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const reforkedHead = mocks.forkWorker.mock.calls[0]![1];
    expect(reforkedHead).toBe(ds.session.queuedActivationInput);
    expect(reforkedHead.content).toContain('GENERIC_TAIL_N_PLUS_1');
    expect(reforkedHead.content).not.toContain('AFTER_TAIL_N_PLUS_2');
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({ turnId: 'om_after_tail_n_plus_2' }),
    ]);

    const resumedSend = vi.mocked(ds.worker!.send);
    Object.assign(ds.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationDispatchAttempt: undefined,
      queuedActivationResume: undefined,
    });
    expect(onQueuedActivationSubmitted(ds, retainedToken)).toBe(true);
    expect(resumedSend).toHaveBeenCalledTimes(1);
    expect(resumedSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_after_tail_n_plus_2',
      content: expect.stringContaining('AFTER_TAIL_N_PLUS_2'),
      queuedActivationToken: expect.any(String),
    }));
  });
});

describe('daemon live-session registration claims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.clear();
    mocks.getAvailableBots.mockResolvedValue([]);
  });

  it('is first-owner-wins under concurrent creation and closes the empty loser', async () => {
    const registry = new Map<string, DaemonSession>();
    const first = makeChatSession('claim-first', 'oc_claim');
    const second = makeChatSession('claim-second', 'oc_claim');

    const [firstResult, secondResult] = await Promise.all([
      claimNewDaemonSession(registry, first),
      claimNewDaemonSession(registry, second),
    ]);

    expect(firstResult.accepted).toBe(true);
    expect(secondResult).toMatchObject({
      accepted: false,
      reason: 'existing_owner',
      owner: first,
      closedIncomingSessionId: second.session.sessionId,
    });
    expect(registry.get(sessionKey('oc_claim', APP))).toBe(first);
    expect(mocks.closeSession).toHaveBeenCalledTimes(1);
    expect(mocks.closeSession).toHaveBeenCalledWith(second.session.sessionId);
  });

  it('fails closed and preserves both persistence rows when both owners are pending', async () => {
    const registry = new Map<string, DaemonSession>();
    const incumbent = makeChatSession('claim-pending-a', 'oc_pending', { pendingLedger: true });
    const incoming = makeChatSession('claim-pending-b', 'oc_pending', { pendingLedger: true });
    registry.set(sessionKey('oc_pending', APP), incumbent);

    const result = await claimNewDaemonSession(registry, incoming);

    expect(result).toMatchObject({
      accepted: false,
      reason: 'both_pending',
      owner: incumbent,
      preservedIncomingSessionId: incoming.session.sessionId,
    });
    expect(registry.get(sessionKey('oc_pending', APP))).toBe(incumbent);
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(mocks.sessions.get(incoming.session.sessionId)?.status).toBe('active');
  });

  it('retires a losing group-join-style pending runtime before any durable setup is staged', async () => {
    const registry = new Map<string, DaemonSession>();
    const incumbent = makeChatSession('join-canonical', 'oc_join_claim');
    const duplicate = makeChatSession('join-duplicate', 'oc_join_claim');
    duplicate.pendingRepo = true;
    duplicate.pendingPrompt = 'SYNTHETIC_JOIN_OPENING';
    duplicate.initialStartPending = true;
    registry.set(sessionKey('oc_join_claim', APP), incumbent);

    const result = await claimNewDaemonSession(registry, duplicate);

    expect(result).toMatchObject({
      accepted: false,
      reason: 'existing_owner',
      owner: incumbent,
      closedIncomingSessionId: duplicate.session.sessionId,
    });
    expect(duplicate.session.pendingRepoSetup).toBeUndefined();
    expect(mocks.closeSession).toHaveBeenCalledWith(duplicate.session.sessionId);
    expect(registry.get(sessionKey('oc_join_claim', APP))).toBe(incumbent);
  });
});

describe('chat-mode conversion ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.clear();
    mocks.getAvailableBots.mockResolvedValue([]);
    activeSessions.clear();
  });

  it.each([
    ['durable ledger', { pendingLedger: true }],
    ['repo selection', { pendingRepo: true }],
    ['queued dashboard task', { queued: true }],
  ])('preserves a pending chat owner (%s)', (_label, options) => {
    const owner = makeChatSession(`converted-${_label}`, CHAT, options);
    activeSessions.set(sessionKey(CHAT, APP), owner);

    expect(handleChatModeConverted(CHAT, APP)).toBe(false);
    expect(activeSessions.get(sessionKey(CHAT, APP))).toBe(owner);
  });

  it('still evicts a ledger-empty idle owner', () => {
    const owner = makeChatSession('converted-idle', CHAT);
    activeSessions.set(sessionKey(CHAT, APP), owner);

    expect(handleChatModeConverted(CHAT, APP)).toBe(true);
    expect(activeSessions.has(sessionKey(CHAT, APP))).toBe(false);
  });

});

describe('document comment canonical ownership and single-flight delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.clear();
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    mocks.getAvailableBots.mockResolvedValue([]);
    activeSessions.clear();
    resetDocCommentClaims();
    const bot = registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER] });
    bot.resolvedAllowedUsers = [OWNER];
  });

  function docSub(fileToken: string): any {
    const sub = {
      fileToken,
      fileType: 'docx',
      sessionAnchor: `om_legacy_${fileToken}`,
      scope: 'thread' as const,
      chatId: CHAT,
      commentTriggerMode: 'all' as const,
      managedBy: 'watch-comment' as const,
      createdAt: Date.now(),
    };
    putDocSubscription(config.session.dataDir, APP, sub);
    return sub;
  }

  function docCtx(sub: any, suffix: string): any {
    return {
      larkAppId: APP,
      sub,
      commentId: `comment-${suffix}`,
      replyId: `reply-${suffix}`,
      text: `question ${suffix}`,
    };
  }

  function bindSubToSession(sub: any, ds: DaemonSession): void {
    Object.assign(sub, {
      sessionAnchor: sessionAnchorId(ds),
      sessionId: ds.session.sessionId,
      scope: ds.scope,
      chatId: ds.chatId,
    });
    putDocSubscription(config.session.dataDir, APP, sub);
  }

  it('leaves the provider cursor retryable when a worker-null setup owner exists', async () => {
    const sub = docSub(`doc-protected-${Date.now()}`);
    const ds = seedThreadSession(sub.sessionAnchor, 'protected doc owner');
    ds.pendingRepo = true;
    ds.session.queued = true;
    ds.session.queuedPrompt = 'OPENING_N';
    ds.session.pendingRepoSetup = { mode: 'picker', prompt: 'OPENING_N' };
    bindSubToSession(sub, ds);
    mocks.forkWorker.mockClear();

    await expect(handleDocComment(docCtx(sub, 'protected'))).resolves.toBe(false);

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds.worker).toBeNull();
    expect(ds.session.docCommentTargets).toBeUndefined();
    expect(ds.session.pendingRepoSetup).toMatchObject({ mode: 'picker', prompt: 'OPENING_N' });
    removeDocSubscription(config.session.dataDir, APP, sub.fileToken);
  });

  it('durably queues a live document comment behind the activation head without worker IPC', async () => {
    const sub = docSub(`doc-live-gate-${Date.now()}`);
    const ds = seedThreadSession(sub.sessionAnchor, 'live gated doc owner');
    const send = vi.fn();
    ds.worker = { killed: false, send } as any;
    Object.assign(ds.session, {
      queuedActivationPending: true,
      queuedActivationToken: 'doc-opening-token',
      queuedActivationInput: { content: 'OPENING_N' },
      queuedActivationTurnId: 'opening-turn',
    });
    bindSubToSession(sub, ds);

    await expect(handleDocComment(docCtx(sub, 'live'))).resolves.toBe(true);

    expect(send).not.toHaveBeenCalled();
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'reply-live',
        cliInput: expect.objectContaining({ content: expect.stringContaining('question live') }),
      }),
    ]);
    removeDocSubscription(config.session.dataDir, APP, sub.fileToken);
  });

  it('refuses doc-watch prewarm before turn mutation when a worker-null setup owner exists', async () => {
    const sub = docSub(`doc-prewarm-protected-${Date.now()}`);
    const ds = seedThreadSession(sub.sessionAnchor, 'prewarm protected');
    ds.session.pendingRepoSetup = { mode: 'picker', prompt: 'OPENING_N' };
    ds.pendingRepo = true;
    const priorLastMessageAt = ds.lastMessageAt;
    mocks.forkWorker.mockClear();

    await expect(prewarmDocCommentSession(ds, sub)).rejects.toThrow('durable opening ownership');

    expect(ds.lastMessageAt).toBe(priorLastMessageAt);
    expect(ds.currentTurnTitle).toBeUndefined();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    removeDocSubscription(config.session.dataDir, APP, sub.fileToken);
  });

  it('durably queues live doc-watch prewarm behind activation without worker IPC', async () => {
    const sub = docSub(`doc-prewarm-live-${Date.now()}`);
    const ds = seedThreadSession(sub.sessionAnchor, 'prewarm live');
    const send = vi.fn();
    ds.worker = { killed: false, send } as any;
    Object.assign(ds.session, {
      queuedActivationPending: true,
      queuedActivationToken: 'prewarm-opening-token',
      queuedActivationInput: { content: 'OPENING_N' },
      queuedActivationTurnId: 'opening-turn',
    });

    await expect(prewarmDocCommentSession(ds, sub)).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: expect.stringMatching(/^doc-watch-/),
        cliInput: expect.objectContaining({ content: expect.stringContaining(sub.fileToken) }),
      }),
    ]);
    removeDocSubscription(config.session.dataDir, APP, sub.fileToken);
  });

  it('serializes concurrent get-or-create, merges targets, and reuses canonical state after restart', async () => {
    const fileToken = `doc-concurrent-${Date.now()}`;
    const sub = docSub(fileToken);

    await expect(Promise.all([
      handleDocComment(docCtx(sub, 'one')),
      handleDocComment(docCtx(sub, 'two')),
    ])).resolves.toEqual([true, true]);

    const key = sessionKey(`doc:${fileToken}`, APP);
    const owner = activeSessions.get(key)!;
    expect(owner).toBeDefined();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(Object.keys(owner.session.docCommentTargets ?? {}).sort()).toEqual(['reply-one', 'reply-two']);

    const persisted = getDocSubscription(config.session.dataDir, APP, fileToken)!;
    expect(persisted).toMatchObject({
      sessionAnchor: `doc:${fileToken}`,
      sessionId: owner.session.sessionId,
      scope: 'chat',
      chatId: `doc:${fileToken}`,
    });
    // This is the exact anchor closeSession uses to find subscriptions.
    expect(sessionAnchorId(owner)).toBe(persisted.sessionAnchor);

    // Simulate a daemon memory restart restoring the same persisted session at
    // activeSessionKey(ds), then deliver another comment from a stale snapshot.
    activeSessions.clear();
    owner.worker = null;
    activeSessions.set(key, owner);
    const staleSnapshot = { ...sub };
    await expect(handleDocComment(docCtx(staleSnapshot, 'three'))).resolves.toBe(true);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(activeSessions.get(key)).toBe(owner);
    expect(Object.keys(owner.session.docCommentTargets ?? {}).sort()).toEqual([
      'reply-one',
      'reply-three',
      'reply-two',
    ]);

    removeDocSubscription(config.session.dataDir, APP, fileToken);
  });

  it('makes duplicate WS/poll deliveries share failure so neither advances its cursor', async () => {
    const fileToken = `doc-failure-${Date.now()}`;
    const sub = docSub(fileToken);
    const ctx = docCtx(sub, 'same');
    mocks.forkWorker.mockImplementationOnce(() => { throw new Error('simulated fork failure'); });

    const results = await Promise.all([
      handleDocComment(ctx),
      handleDocComment({ ...ctx, sub: { ...sub } }),
    ]);

    expect(results).toEqual([false, false]);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);

    // Failure was not recorded as completed: a later poll retry can deliver.
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    await expect(handleDocComment(ctx)).resolves.toBe(true);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(2);

    removeDocSubscription(config.session.dataDir, APP, fileToken);
  });
});

describe('/repo trusted sibling production routing', () => {
  beforeEach(() => {
    resetRouteTestState();
    seedSiblingCrossRef();
    seedConfiguredSiblingIdentity();
  });

  afterEach(() => {
    cleanupRepoFixtureDirs();
    rmSync(crossRefPath(), { force: true });
    rmSync(botsConfigPath(), { force: true });
    rmSync(botsInfoPath(), { force: true });
    rmSync(botUnionIdsPath(), { force: true });
  });

  it.each(['app', 'bot'] as const)('new topic: sender_type=%s sibling /repo reaches repo launch path', async (senderType) => {
    const messageId = `om_repo_new_${senderType}`;

    await handleNewTopic(
      makePeerRepoEventData(messageId, senderType),
      makeCtx(messageId, messageId),
    );

    const ds = activeSessions.get(sessionKey(messageId, APP));
    expect(repliedText()).not.toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(ds).toBeTruthy();
    expect(ds?.ownerOpenId).toBe(PEER);
    expect(ds?.pendingRepo).toBe(false);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.calls[0]?.[0]).toBe(ds);
  });

  it('new topic: rejects stamped sibling /repo when sender union is missing or wrong', async () => {
    await handleNewTopic(
      makePeerRepoEventData('om_repo_new_missing_union', 'app', undefined, null),
      makeCtx('om_repo_new_missing_union', 'om_repo_new_missing_union'),
    );
    expect(repliedText()).toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();

    resetRouteTestState();
    seedSiblingCrossRef();
    seedConfiguredSiblingIdentity();
    await handleNewTopic(
      makePeerRepoEventData('om_repo_new_wrong_union', 'bot', undefined, 'on_wrong_peer_bot'),
      makeCtx('om_repo_new_wrong_union', 'om_repo_new_wrong_union'),
    );
    expect(repliedText()).toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it.each(['app', 'bot'] as const)('thread reply: sender_type=%s sibling /repo reaches repo launch path', async (senderType) => {
    const rootId = `om_repo_root_${senderType}`;
    const messageId = `om_repo_reply_${senderType}`;

    await handleThreadReply(
      makePeerRepoEventData(messageId, senderType, rootId),
      makeCtx(rootId, messageId),
    );

    const ds = activeSessions.get(sessionKey(rootId, APP));
    expect(repliedText()).not.toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(ds).toBeTruthy();
    expect(ds?.ownerOpenId).toBe(PEER);
    expect(ds?.session.creatorOpenId).toBe(PEER);
    expect(ds?.pendingRepo).toBe(false);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.calls[0]?.[0]).toBe(ds);
  });

  it('thread reply: strips live split-font footer before /repo command routing', async () => {
    const rootId = 'om_repo_root_split_footer';
    const messageId = 'om_repo_reply_split_footer';

    await handleThreadReply(
      makePeerRepoEventDataWithSplitFooter(messageId, rootId),
      makeCtx(rootId, messageId),
    );

    const ds = activeSessions.get(sessionKey(rootId, APP));
    expect(repliedText()).not.toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(ds).toBeTruthy();
    expect(ds?.ownerOpenId).toBe(PEER);
    expect(ds?.pendingRepo).toBe(false);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.calls[0]?.[0]).toBe(ds);
    expect(mocks.forkWorker.mock.calls[0]?.[1]).toBe('');
  });

  it('thread reply: strips v2 footer element without text_size before /repo command routing', async () => {
    const rootId = 'om_repo_root_v2_footer';
    const messageId = 'om_repo_reply_v2_footer';

    await handleThreadReply(
      makePeerRepoEventDataWithV2FooterElement(messageId, rootId),
      makeCtx(rootId, messageId),
    );

    const ds = activeSessions.get(sessionKey(rootId, APP));
    expect(repliedText()).not.toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(ds).toBeTruthy();
    expect(ds?.ownerOpenId).toBe(PEER);
    expect(ds?.pendingRepo).toBe(false);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.calls[0]?.[0]).toBe(ds);
    expect(mocks.forkWorker.mock.calls[0]?.[1]).toBe('');
  });

  it('thread reply: rejects stamped sibling /repo when sender union is missing or wrong', async () => {
    await handleThreadReply(
      makePeerRepoEventData('om_repo_reply_missing_union', 'app', 'om_repo_root_missing_union', null),
      makeCtx('om_repo_root_missing_union', 'om_repo_reply_missing_union'),
    );
    expect(repliedText()).toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();

    resetRouteTestState();
    seedSiblingCrossRef();
    seedConfiguredSiblingIdentity();
    await handleThreadReply(
      makePeerRepoEventData('om_repo_reply_wrong_union', 'bot', 'om_repo_root_wrong_union', 'on_wrong_peer_bot'),
      makeCtx('om_repo_root_wrong_union', 'om_repo_reply_wrong_union'),
    );
    expect(repliedText()).toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('thread reply: rejects cross-ref-only /repo when sender is not Lark-stamped as a bot', async () => {
    await handleThreadReply(
      makePeerRepoEventData('om_repo_reply_user_stamp', 'user', 'om_repo_root_user_stamp'),
      makeCtx('om_repo_root_user_stamp', 'om_repo_reply_user_stamp'),
    );

    expect(repliedText()).toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('thread reply: rejects stale sibling identity for an app no longer in the current config', async () => {
    resetRouteTestState();
    seedSiblingCrossRef();
    writeFileSync(botsConfigPath(), JSON.stringify([
      { larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER] },
    ]));
    writeFileSync(botsInfoPath(), JSON.stringify([
      { larkAppId: APP, botOpenId: 'ou_receiver_self', botName: 'Receiver', cliId: 'claude-code' },
      { larkAppId: 'removed_sibling_app', botOpenId: 'ou_peer_self', botName: 'Codex', cliId: 'codex' },
    ]));
    recordBotUnionId(mocks.dataDir, 'removed_sibling_app', PEER_UNION);

    await handleThreadReply(
      makePeerRepoEventData('om_repo_reply_removed_app', 'bot', 'om_repo_root_removed_app'),
      makeCtx('om_repo_root_removed_app', 'om_repo_reply_removed_app'),
    );

    expect(repliedText()).toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('thread reply: rejects registry-only sibling identity that is absent from current config', async () => {
    resetRouteTestState();
    seedSiblingCrossRef();
    registerBot({ larkAppId: 'registry_only_route', larkAppSecret: 's', cliId: 'codex' });
    writeFileSync(botsConfigPath(), JSON.stringify([
      { larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER] },
    ]));
    writeFileSync(botsInfoPath(), JSON.stringify([
      { larkAppId: APP, botOpenId: 'ou_receiver_self', botName: 'Receiver', cliId: 'claude-code' },
      { larkAppId: 'registry_only_route', botOpenId: 'ou_peer_self', botName: 'Codex', cliId: 'codex' },
    ]));
    recordBotUnionId(mocks.dataDir, 'registry_only_route', PEER_UNION);

    await handleThreadReply(
      makePeerRepoEventData('om_repo_reply_registry_only', 'bot', 'om_repo_root_registry_only'),
      makeCtx('om_repo_root_registry_only', 'om_repo_reply_registry_only'),
    );

    expect(repliedText()).toContain('仅 allowedUsers 可执行');
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });
});
