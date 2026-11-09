/**
 * Topic session continuity through the REAL daemon route (`handleThreadReply`
 * → handleThreadReplyAdmitted). A message reaching a topic whose session for
 * this bot was closed used to always get a brand-new CLI session; a lead's
 * `dispatch --into` follow-up then hit an executor with no memory of the work.
 *
 * Pins:
 *   - default: the topic's last closed session is resumed, no new session row;
 *   - a session a human closed (/close, card) is not resumed: fresh, with reason;
 *   - `@session fresh` from a peer bot starts fresh and is stripped from the body;
 *   - the same text from a human is ordinary content (the session is resumed);
 *   - a failed resume falls back to a fresh session that records why.
 *
 * Run: bun x vitest run --project unit test/topic-session-continuity-route.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const ownRoot = `${process.env.TMPDIR ?? '/tmp'}/botmux-topic-cont-${process.pid}`;
  const dataDir = `${ownRoot}/data`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    ownRoot,
    dataDir,
    replyMessage: vi.fn(async (..._args: any[]) => 'om_reply'),
    sendMessage: vi.fn(async (..._args: any[]) => 'om_sent'),
    getChatMode: vi.fn(async () => 'topic' as 'group' | 'topic' | 'p2p'),
    resolveSender: vi.fn(async (_appId: string, openId?: string, senderType?: string) => (
      openId ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const } : undefined
    )),
    forkWorker: vi.fn((..._args: any[]) => undefined),
    sendWorkerInput: vi.fn((..._args: any[]) => true),
    downloadResources: vi.fn(async (..._args: any[]) => ({ attachments: [] as unknown[], needLogin: false })),
    closedRows: [] as any[],
    createdSessions: [] as any[],
    createSession: vi.fn(function (chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') {
      const session = {
        sessionId: `sess-new-${++seq}`, chatId, rootMessageId, title, status: 'active' as const,
        createdAt: new Date().toISOString(), chatType,
      };
      mocks.createdSessions.push(session);
      return session;
    }),
    updateSession: vi.fn(),
    resumeSession: vi.fn(async (..._args: any[]): Promise<any> => ({ ok: false, error: 'not_found' })),
    closeSession: vi.fn(async (..._args: any[]): Promise<any> => ({ ok: true, outcome: 'closed', alreadyClosed: false, known: true })),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    getChatMode: mocks.getChatMode,
    getChatModeStrict: mocks.getChatMode,
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'topic' as const })),
    getChatInfo: vi.fn(async () => ({ userCount: 1, botCount: 2 })),
    listChatBotMembers: vi.fn(async () => []),
    resolveAllowedUsersWithMap: vi.fn(async (_appId: string, users: string[]) => ({ resolved: users, map: new Map() })),
    sendUserMessage: vi.fn(async () => 'om_dm'),
    updateMessage: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => 'reaction'),
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    createSession: mocks.createSession,
    updateSession: mocks.updateSession,
    listSessions: () => [...actual.listSessions(), ...mocks.closedRows],
    listSessionsStrict: () => [...actual.listSessionsStrict(), ...mocks.closedRows],
  };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    forkWorker: (...args: any[]) => mocks.forkWorker(...args),
    sendWorkerInput: (...args: any[]) => mocks.sendWorkerInput(...args),
    closeSession: (...args: any[]) => mocks.closeSession(...args),
  };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    downloadResources: (...args: any[]) => mocks.downloadResources(...args),
    resumeSession: (...args: any[]) => mocks.resumeSession(...args),
    closeSession: (...args: any[]) => mocks.closeSession(...args),
  };
});

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { registerBot, getBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

const APP = 'topic_cont_worker_app';
const APP_OPEN_ID = 'ou_topic_cont_worker';
const LEAD_OPEN_ID = 'ou_topic_cont_lead';
const OWNER = 'ou_topic_cont_owner';
const CHAT = 'oc_topic_cont_chat';
const ROOT = 'om_topic_cont_root';
let seq = 0;

function closedRow(extra: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess-old-1', chatId: CHAT, rootMessageId: ROOT, title: 'old work', status: 'closed',
    createdAt: '2026-11-04T07:08:02.000Z', closedAt: '2026-11-04T18:20:27.000Z', chatType: 'group',
    larkAppId: APP, ownerOpenId: OWNER, scope: 'thread', cliId: 'claude-code', cliSessionId: 'cli-old-1', ...extra,
  };
}

function event(
  text: string,
  from: 'bot' | 'human' | 'stranger-bot' | 'stranger-human',
  opts: { mentionWorker?: boolean } = {},
): { data: any; ctx: RoutingContext } {
  const messageId = `om_topic_cont_msg_${++seq}`;
  const mentionWorker = opts.mentionWorker ?? true;
  const sender = {
    bot: { sender_id: { open_id: LEAD_OPEN_ID }, sender_type: 'app' },
    human: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    'stranger-bot': { sender_id: { open_id: 'ou_topic_cont_stranger_bot' }, sender_type: 'app' },
    'stranger-human': { sender_id: { open_id: 'ou_topic_cont_stranger' }, sender_type: 'user' },
  }[from];
  const data = {
    sender,
    message: {
      message_id: messageId, chat_id: CHAT, chat_type: 'group', message_type: 'text',
      root_id: ROOT, thread_id: 'omt_topic_cont', // Same layout as `botmux dispatch`: the @ line, a blank line, then the brief.
      content: JSON.stringify({ text: mentionWorker ? `@_user_1\n\n${text}` : text }),
      create_time: String(Date.now()),
      mentions: mentionWorker ? [{ key: '@_user_1', name: 'Worker', id: { open_id: APP_OPEN_ID }, id_type: 'open_id' }] : [],
    },
  };
  return { data, ctx: { chatId: CHAT, messageId, chatType: 'group', scope: 'thread', anchor: ROOT, larkAppId: APP } as RoutingContext };
}

/** What a successful resume leaves behind: the old row active again at its anchor, worker not yet forked. */
function resumeRegisters(): void {
  mocks.resumeSession.mockImplementation(async (sessionId: string) => {
    const session = { ...closedRow(), sessionId, status: 'active', closedAt: undefined };
    const ds = {
      session, worker: null, workerPort: null, workerToken: null, larkAppId: APP, chatId: CHAT,
      chatType: 'group', scope: 'thread', spawnedAt: Date.now(), cliVersion: '1.0.0', lastMessageAt: Date.now(),
      hasHistory: true, workingDir: mocks.dataDir,
    } as unknown as DaemonSession;
    activeSessions.set(sessionKey(ROOT, APP), ds);
    return { ok: true, ds };
  });
}

const replies = (): string[] => mocks.replyMessage.mock.calls.map(call => String(call[2] ?? ''));

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(mocks.dataDir, { recursive: true });
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([]));
  registerBot({
    larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code',
    allowedUsers: [OWNER, LEAD_OPEN_ID], defaultWorkingDir: mocks.dataDir,
  } as any);
  const bot = getBot(APP);
  bot.resolvedAllowedUsers = [OWNER, LEAD_OPEN_ID];
  bot.botOpenId = APP_OPEN_ID;
  bot.botName = 'Worker';
  activeSessions.clear();
  mocks.closedRows.length = 0;
  mocks.createdSessions.length = 0;
  mocks.getChatMode.mockResolvedValue('topic');
  mocks.resumeSession.mockResolvedValue({ ok: false, error: 'not_found' });
});

afterAll(() => {
  rmSync(mocks.ownRoot, { recursive: true, force: true });
});

describe('a message in a topic whose session was closed (real route)', () => {
  it('resumes the last closed session instead of creating a new one, and says so', async () => {
    mocks.closedRows.push(closedRow());
    resumeRegisters();
    const { data, ctx } = event('请补跑 ROW-015', 'bot');
    await handleThreadReply(data, ctx);
    expect(mocks.resumeSession).toHaveBeenCalledWith('sess-old-1', expect.anything());
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(activeSessions.get(sessionKey(ROOT, APP))?.session.continuity).toMatchObject({ mode: 'resumed', previousSessionId: 'sess-old-1' });
    expect(replies().some(text => text.includes('sess-old'))).toBe(true);
  });

  it('picks the most recently closed session of this bot in this topic', async () => {
    mocks.closedRows.push(
      closedRow({ sessionId: 'sess-older', closedAt: '2026-11-04T10:00:00.000Z' }),
      closedRow({ sessionId: 'sess-latest', closedAt: '2026-11-05T00:47:55.000Z' }),
      closedRow({ sessionId: 'sess-other-bot', larkAppId: 'someone_else', closedAt: '2026-11-06T00:00:00.000Z' }),
      closedRow({ sessionId: 'sess-other-topic', rootMessageId: 'om_other', closedAt: '2026-11-06T00:00:00.000Z' }),
    );
    resumeRegisters();
    const { data, ctx } = event('继续', 'bot');
    await handleThreadReply(data, ctx);
    expect(mocks.resumeSession).toHaveBeenCalledTimes(1);
    expect(mocks.resumeSession.mock.calls[0]![0]).toBe('sess-latest');
  });

  it('does not bring back a session a human closed: fresh session, reason recorded', async () => {
    mocks.closedRows.push(closedRow({ userClosedAt: '2026-11-04T18:20:27.000Z' }));
    const { data, ctx } = event('新问题', 'human');
    await handleThreadReply(data, ctx);
    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createdSessions[0].continuity).toMatchObject({ mode: 'fresh-after-close', previousSessionId: 'sess-old-1', reason: 'user_closed' });
    // A plain new session, as any @ in the topic gets: no extra message.
    expect(replies().some(text => text.includes('sess-old'))).toBe(false);
  });

  it('a closed command shell newer than the real conversation is skipped', async () => {
    mocks.closedRows.push(
      closedRow({ sessionId: 'sess-real', closedAt: '2026-11-04T10:00:00.000Z' }),
      closedRow({ sessionId: 'sess-help-shell', cliSessionId: undefined, closedAt: '2026-11-05T09:00:00.000Z' }),
    );
    resumeRegisters();
    const { data, ctx } = event('继续上次的活', 'human');
    await handleThreadReply(data, ctx);
    expect(mocks.resumeSession).toHaveBeenCalledTimes(1);
    expect(mocks.resumeSession.mock.calls[0]![0]).toBe('sess-real');
  });

  it('a failed continuity notice does not drop the message: the resumed session still gets it', async () => {
    mocks.closedRows.push(closedRow());
    resumeRegisters();
    mocks.replyMessage.mockRejectedValueOnce(new Error('lark 502'));
    const { data, ctx } = event('请补跑 ROW-015', 'bot');
    await expect(handleThreadReply(data, ctx)).resolves.toBeUndefined();
    expect(mocks.resumeSession).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(replies().some(text => text.includes('没有送达'))).toBe(false);
  });

  it('@session fresh from a peer bot starts fresh and never reaches the model', async () => {
    mocks.closedRows.push(closedRow());
    const { data, ctx } = event('@session fresh\n独立评审 9c3eec0', 'bot');
    await handleThreadReply(data, ctx);
    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createdSessions[0].continuity).toMatchObject({ mode: 'fresh-requested', previousSessionId: 'sess-old-1' });
    expect(String(mocks.createSession.mock.calls[0]![2])).not.toContain('@session');
  });

  it('the same text from a human is ordinary content: the session is resumed', async () => {
    mocks.closedRows.push(closedRow());
    resumeRegisters();
    const { data, ctx } = event('@session fresh\n这是正文', 'human');
    await handleThreadReply(data, ctx);
    expect(mocks.resumeSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('a failed resume falls back to a fresh session that records why', async () => {
    mocks.closedRows.push(closedRow());
    mocks.resumeSession.mockResolvedValue({ ok: false, error: 'codex_unarchive_failed' });
    const { data, ctx } = event('继续', 'bot');
    await handleThreadReply(data, ctx);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createdSessions[0].continuity).toMatchObject({ mode: 'fresh-after-close', reason: 'codex_unarchive_failed' });
    expect(replies().some(text => text.includes('sess-old') && !text.includes('codex_unarchive_failed'))).toBe(true);
  });

  it('@session fresh on a LIVE topic session closes it first, then starts fresh', async () => {
    resumeRegisters();
    await mocks.resumeSession('sess-live');
    mocks.resumeSession.mockClear();
    mocks.closeSession.mockImplementation(async () => {
      activeSessions.delete(sessionKey(ROOT, APP));
      return { ok: true, outcome: 'closed', alreadyClosed: false, known: true };
    });
    const { data, ctx } = event('@session fresh\n换一件事', 'bot');
    await handleThreadReply(data, ctx);
    expect(mocks.closeSession).toHaveBeenCalledWith('sess-live', { userClosed: true });
    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createdSessions[0].continuity).toMatchObject({ mode: 'fresh-requested', previousSessionId: 'sess-live' });
  });

  it('a refused close keeps the live session handling the message', async () => {
    resumeRegisters();
    await mocks.resumeSession('sess-live');
    mocks.resumeSession.mockClear();
    mocks.closeSession.mockResolvedValue({ ok: false, alreadyClosed: false, error: 'remote_cancel_unproven', taskId: 'task-9' });
    const { data, ctx } = event('@session fresh\n换一件事', 'bot');
    await handleThreadReply(data, ctx);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(replies().some(text => text.includes('remote_cancel_unproven') && text.includes('task-9'))).toBe(true);
  });

  it('durable primary mode keeps the plain behaviour: no local resume, no local close', async () => {
    mocks.closedRows.push(closedRow());
    resumeRegisters();
    process.env.BOTMUX_COORDINATION_MODE = 'primary';
    try {
      const closedTopic = event('请补跑', 'bot');
      await handleThreadReply(closedTopic.data, closedTopic.ctx);
      expect(mocks.resumeSession).not.toHaveBeenCalled();
      expect(mocks.createSession).toHaveBeenCalledTimes(1);
      expect(mocks.createdSessions[0].continuity).toBeUndefined();
      expect(replies().some(text => text.includes('sess-old'))).toBe(false);

      vi.clearAllMocks();
      activeSessions.clear();
      resumeRegisters();
      await mocks.resumeSession('sess-live');
      mocks.resumeSession.mockClear();
      const liveTopic = event('@session fresh\n换一件事', 'bot');
      await handleThreadReply(liveTopic.data, liveTopic.ctx);
      expect(mocks.closeSession).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
      expect(activeSessions.get(sessionKey(ROOT, APP))?.session.sessionId).toBe('sess-live');
    } finally {
      delete process.env.BOTMUX_COORDINATION_MODE;
    }
  });

  it('a topic with no earlier session is untouched: plain new session, no continuity', async () => {
    const { data, ctx } = event('第一条', 'bot');
    await handleThreadReply(data, ctx);
    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createdSessions[0].continuity).toBeUndefined();
  });
});

describe('gate order: continuity side effects only happen for messages this bot would handle (real route)', () => {
  /** Another bot's live session on the same topic anchor. */
  function otherBotOwnsAnchor(): void {
    activeSessions.set(sessionKey(ROOT, 'topic_cont_other_app'), {
      session: { sessionId: 'sess-other-bot-live', chatId: CHAT, rootMessageId: ROOT, title: 't', status: 'active', createdAt: new Date().toISOString() },
      worker: null, larkAppId: 'topic_cont_other_app', chatId: CHAT, chatType: 'group', scope: 'thread',
    } as unknown as DaemonSession);
  }
  const noSideEffects = (): void => {
    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(replies()).toEqual([]);
  };

  it('another bot owns the anchor and the human message does not @ this bot: no resume, no close, no reply', async () => {
    mocks.closedRows.push(closedRow());
    resumeRegisters();
    otherBotOwnsAnchor();
    const { data, ctx } = event('随便聊聊', 'human', { mentionWorker: false });
    await handleThreadReply(data, ctx);
    noSideEffects();
    expect(activeSessions.get(sessionKey(ROOT, APP))).toBeUndefined();
  });

  it('same anchor ownership, `@session fresh` from a bot that does not @ this bot: nothing happens', async () => {
    mocks.closedRows.push(closedRow());
    resumeRegisters();
    otherBotOwnsAnchor();
    const { data, ctx } = event('@session fresh\n独立评审', 'bot', { mentionWorker: false });
    await handleThreadReply(data, ctx);
    noSideEffects();
  });

  it('a non-allowed bot sending `@session fresh` cannot close the live session', async () => {
    resumeRegisters();
    await mocks.resumeSession('sess-live');
    mocks.resumeSession.mockClear();
    const { data, ctx } = event('@session fresh\n换一件事', 'stranger-bot');
    await handleThreadReply(data, ctx);
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(activeSessions.get(sessionKey(ROOT, APP))?.session.sessionId).toBe('sess-live');
  });

  it('with acceptSlashFromBots off, even an allowed peer bot cannot close the live session with `@session fresh`', async () => {
    resumeRegisters();
    await mocks.resumeSession('sess-live');
    mocks.resumeSession.mockClear();
    (getBot(APP).config as any).acceptSlashFromBots = false;
    try {
      const { data, ctx } = event('@session fresh\n换一件事', 'bot');
      await handleThreadReply(data, ctx);
    } finally {
      delete (getBot(APP).config as any).acceptSlashFromBots;
    }
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(activeSessions.get(sessionKey(ROOT, APP))?.session.sessionId).toBe('sess-live');
  });

  it('with acceptSlashFromBots off the directive is not consumed: a closed session is still resumed', async () => {
    mocks.closedRows.push(closedRow());
    resumeRegisters();
    (getBot(APP).config as any).acceptSlashFromBots = false;
    try {
      const { data, ctx } = event('@session fresh\n正文', 'bot');
      await handleThreadReply(data, ctx);
    } finally {
      delete (getBot(APP).config as any).acceptSlashFromBots;
    }
    expect(mocks.resumeSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('quota/talk gate denies (sender not allowed): no resume, no replies, no new session', async () => {
    mocks.closedRows.push(closedRow());
    resumeRegisters();
    const { data, ctx } = event('请补跑', 'stranger-human');
    await handleThreadReply(data, ctx);
    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(replies().some(text => text.includes('sess-old'))).toBe(false);
  });

  it('quota/talk gate denies `@session fresh` on a live session: nothing closed', async () => {
    resumeRegisters();
    await mocks.resumeSession('sess-live');
    mocks.resumeSession.mockClear();
    const { data, ctx } = event('@session fresh\n换一件事', 'stranger-human');
    await handleThreadReply(data, ctx);
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(activeSessions.get(sessionKey(ROOT, APP))?.session.sessionId).toBe('sess-live');
  });
});
