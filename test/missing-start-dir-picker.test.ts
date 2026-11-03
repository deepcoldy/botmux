/**
 * A bot whose default working dir does not exist (deleted, mistyped, set up on
 * another host). resolveBotDefaultWorkingDir declines to pin it and logs
 * "falling back to repo-select card" — so a new session must actually get that
 * card, not be started in the missing directory. Starting there is refused
 * (forkWorker → MissingWorkingDirError), which used to leave the first message
 * staged on a session that was no longer waiting for a repo: the recovery
 * card's 「使用此目录」 then answered 「当前会话仍有待提交消息」 forever.
 *
 * These cases drive the real new-session entry points (forkWorker and the Lark
 * client are the only stand-ins) and then the real card handler, end to end.
 *
 * Run: bun x vitest run --project unit test/missing-start-dir-picker.test.ts
 */
import { cardVisibleText } from './helpers/card-visible-text.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-missing-start-${process.pid}`;
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
    addReaction: vi.fn(async () => 'reaction_received'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined) => (
      openId ? { openId, type: 'user' as const } : undefined
    )),
    sessions,
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => {
      const session = {
        sessionId: `sess-missing-${++seq}`,
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
    listSessionsStrict: vi.fn(() => [...sessions.values()]),
    deleteMessage: vi.fn(async () => true),
    closeSession: vi.fn((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) session.status = 'closed';
    }),
    forkWorker: vi.fn((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
      return true;
    }),
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
    deleteMessage: mocks.deleteMessage,
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
    getOwnedSession: mocks.getSession,
    listSessions: mocks.listSessionsStrict,
    listSessionsStrict: mocks.listSessionsStrict,
    closeSession: mocks.closeSession,
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: mocks.forkWorker };
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

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';
import { handleCardAction } from '../src/im/lark/card-handler.js';
import { restoreActiveSessions } from '../src/core/session-manager.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'missing_start_dir_app';
const CHAT = 'oc_missing_start_dir_chat';
const OWNER = 'ou_owner';
const CARD_ID = 'om_missing_dir_card';
const OPENING = '用一句话回答 1+1 等于几';

mkdirSync(mocks.dataDir, { recursive: true });
const tmpRoot = mkdtempSync(join(mocks.dataDir, 'dirs-'));
// No `-` in the name: git is never asked where a deleted worktree came from.
// Keep `_`: markdown escaping must differ from the visible path we assert.
const GONE = join(tmpRoot, 'gone_dir', 'botmux');

afterAll(() => {
  rmSync(mocks.dataDir, { recursive: true, force: true });
});

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
  return { chatId: CHAT, messageId, chatType: 'group', scope: 'thread', anchor, larkAppId: APP };
}

/** Every interactive card the daemon published, as JSON text. */
function publishedCards(): string[] {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .filter(call => (call as unknown[])[3] === 'interactive')
    .map(call => String((call as unknown[])[2]));
}

function makeManualEvent(rootId: string, path: string) {
  return {
    operator: { open_id: OWNER },
    action: {
      value: { action: 'repo_manual_submit', root_id: rootId },
      form_value: { repo_manual_path: path },
    },
    context: { open_message_id: CARD_ID },
  };
}

function registerTestBot(defaultWorkingDir: string, workingDir?: string): void {
  const bot = registerBot({
    larkAppId: APP,
    larkAppSecret: 's',
    cliId: 'claude-code',
    allowedUsers: [OWNER],
    defaultWorkingDir,
    ...(workingDir ? { workingDir } : {}),
  });
  bot.resolvedAllowedUsers = [OWNER];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.clear();
  activeSessions.clear();
  mocks.replyMessage.mockImplementation(async (...args: any[]) => (args[3] === 'interactive' ? CARD_ID : 'om_reply'));
  mocks.sendMessage.mockImplementation(async (...args: any[]) => (args[3] === 'interactive' ? CARD_ID : 'om_top'));
  mocks.forkWorker.mockImplementation((ds: any) => {
    ds.worker = { killed: false, send: vi.fn() };
    return true;
  });
  mocks.scanMultipleProjects.mockReturnValue([]);
  registerTestBot(GONE);
});

describe('default working dir missing → the repo picker, not a start in that dir', () => {
  it('new topic with nothing to scan: no start; the picker asks for a directory and holds the message', async () => {
    const anchor = 'om_missing_new_topic';

    await handleNewTopic(makeEventData(anchor, OPENING), makeCtx(anchor, anchor));

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    const ds = activeSessions.get(sessionKey(anchor, APP)) as DaemonSession;
    expect(ds.pendingRepo).toBe(true);
    expect(ds.initialStartPending).toBe(false);
    const cards = publishedCards();
    expect(cards).toHaveLength(1);
    // Manual entry even with an empty scan; no 「直接开启会话」 into the missing dir.
    expect(cards[0]).toContain('repo_manual_submit');
    expect(cards[0]).not.toContain('skip_repo');
    expect(cardVisibleText(cards[0])).toContain(GONE);
    expect(cards[0]).toContain('不用重发');
    expect(ds.repoCardMessageId).toBe(CARD_ID);
    expect(ds.workingDirRecovery?.cardMessageId).toBe(CARD_ID);
    // The picker is the staged opening's picker: a restart replaces exactly it.
    expect(ds.session.pendingRepoSetup).toMatchObject({ mode: 'picker', prompt: OPENING, repoCardMessageId: CARD_ID });
  });

  it('new topic with projects: the picker lists them, still without 「直接开启会话」', async () => {
    const anchor = 'om_missing_with_projects';
    // The scan root is the bot's workingDir; the missing default is not scanned.
    registerTestBot(GONE, tmpRoot);
    mocks.scanMultipleProjects.mockReturnValue([
      { name: 'demo', path: join(tmpRoot, 'demo'), type: 'repo', branch: 'main' },
    ]);

    await handleNewTopic(makeEventData(anchor, OPENING), makeCtx(anchor, anchor));

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    const [card] = publishedCards();
    expect(card).toContain('"key":"repo_switch"');
    expect(card).toContain('demo (main)');
    expect(card).not.toContain('skip_repo');
  });

  it('「使用此目录」 on that picker starts the held message in the chosen directory — same session, no resend', async () => {
    const anchor = 'om_missing_then_manual';
    const chosen = mkdtempSync(join(tmpRoot, 'chosen-'));
    await handleNewTopic(makeEventData(anchor, OPENING), makeCtx(anchor, anchor));
    const ds = activeSessions.get(sessionKey(anchor, APP)) as DaemonSession;
    const sessionId = ds.session.sessionId;
    const cardReply = vi.fn(async () => 'om_card_reply');

    await handleCardAction(
      makeManualEvent(anchor, chosen),
      { activeSessions, sessionReply: cardReply, lastRepoScan: new Map() },
      APP,
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const [forkedDs, input] = mocks.forkWorker.mock.calls[0]! as unknown as [DaemonSession, unknown];
    expect(forkedDs).toBe(ds);
    expect(JSON.stringify(input)).toContain(OPENING);
    expect(ds.session.sessionId).toBe(sessionId);
    expect(ds.workingDir).toBe(chosen);
    expect(ds.pendingRepo).toBe(false);
    expect(ds.workingDirRecovery).toBeUndefined();
    const replies = cardReply.mock.calls.map(call => String((call as unknown[])[1])).join('\n');
    expect(replies).not.toContain('待提交');
  });

  it('a reply under a root with no session (auto-create) takes the same picker', async () => {
    const anchor = 'om_missing_autocreate_root';

    await handleThreadReply(
      makeEventData('om_missing_autocreate_msg', OPENING, anchor),
      makeCtx(anchor, 'om_missing_autocreate_msg'),
    );

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    const ds = activeSessions.get(sessionKey(anchor, APP)) as DaemonSession;
    expect(ds.pendingRepo).toBe(true);
    const [card] = publishedCards();
    expect(card).toContain('repo_manual_submit');
    expect(card).not.toContain('skip_repo');
  });

  it('an initial raw passthrough waits on the same picker instead of running in the missing dir', async () => {
    const anchor = 'om_missing_raw_passthrough';

    // /goal is claude-code's adapter default passthrough → initial raw passthrough route.
    await handleNewTopic(makeEventData(anchor, '/goal ship the fix'), makeCtx(anchor, anchor));

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    const ds = activeSessions.get(sessionKey(anchor, APP)) as DaemonSession;
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRawInput).toBe('/goal ship the fix');
    const [card] = publishedCards();
    expect(card).toContain('repo_manual_submit');
    expect(card).not.toContain('skip_repo');
  });

  it('without a card it says to use /repo and keeps the message for that selection', async () => {
    const anchor = 'om_missing_no_card';
    mocks.replyMessage.mockImplementation(async (...args: any[]) => {
      if (args[3] === 'interactive') throw new Error('lark card send failure');
      return 'om_reply';
    });

    await handleNewTopic(makeEventData(anchor, OPENING), makeCtx(anchor, anchor));

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    const ds = activeSessions.get(sessionKey(anchor, APP)) as DaemonSession;
    expect(ds.pendingRepo).toBe(true);
    const texts = mocks.replyMessage.mock.calls
      .filter(call => (call as unknown[])[3] !== 'interactive')
      .map(call => String((call as unknown[])[2]))
      .join('\n');
    expect(texts).toContain(GONE);
    expect(texts).toContain('/repo');
  });

  it('after a restart the re-posted picker is the same form, replacing the old card', async () => {
    const root = 'om_missing_restored_root';
    mocks.sessions.set('sess-missing-restored', {
      sessionId: 'sess-missing-restored',
      chatId: CHAT,
      rootMessageId: root,
      title: OPENING,
      status: 'active',
      createdAt: new Date().toISOString(),
      larkAppId: APP,
      scope: 'thread',
      chatType: 'group',
      queued: true,
      queuedPrompt: OPENING,
      pendingRepoSetup: { mode: 'picker', linkRefMode: 'disabled', prompt: OPENING, turnId: root, repoCardMessageId: 'om_old_card' },
    });

    await restoreActiveSessions(activeSessions);

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    const ds = activeSessions.get(sessionKey(root, APP)) as DaemonSession;
    expect(ds.pendingRepo).toBe(true);
    const [card] = publishedCards();
    expect(card).toContain('repo_manual_submit');
    expect(card).not.toContain('skip_repo');
    expect(ds.session.pendingRepoSetup?.repoCardMessageId).toBe(CARD_ID);
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, 'om_old_card');
  });

  it('a default working dir that exists still starts directly (unchanged)', async () => {
    const anchor = 'om_existing_default';
    const existing = mkdtempSync(join(tmpRoot, 'existing-'));
    registerTestBot(existing);

    await handleNewTopic(makeEventData(anchor, OPENING), makeCtx(anchor, anchor));

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(publishedCards()).toHaveLength(0);
  });
});
