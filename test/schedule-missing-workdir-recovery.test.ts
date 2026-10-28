/**
 * A scheduled task whose working directory is gone (its own `workingDir`, or
 * the bot default it falls back to). The fresh session it opens is refused by
 * forkWorker (MissingWorkingDirError) and the chat gets the working-directory
 * recovery card. Nobody waits to start that run later — the scheduler records
 * it as failed — so the session must not keep its start gate (#2172): kept, the
 * card's 「使用此目录」 and `/cd` answered 「仍有待提交消息 / Codex App 仍有未结算
 * 消息」 and every later fire bailed out on `initial_start_pending` until the
 * session was closed by hand.
 *
 * These cases drive the real scheduler entry (executeScheduledTask), the real
 * forkWorker refusal, the real recovery card publication and the real card /
 * command handlers. Only the Lark client, the session store and a forkWorker
 * that would actually spawn a CLI are stand-ins.
 *
 * Run: bun x vitest run --project unit test/schedule-missing-workdir-recovery.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardVisibleText } from './helpers/card-visible-text.js';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-sched-missing-${process.pid}`;
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
        sessionId: `sess-sched-missing-${++seq}`,
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
    /** A start that got past the working-directory check (a CLI would spawn). */
    started: vi.fn(),
    scanMultipleProjects: vi.fn(() => [] as any[]),
    getSessionWorkingDir: undefined as undefined | ((ds: any) => string),
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

// The real forkWorker decides whether the directory is there and refuses
// (publishing the recovery card through onMissingWorkingDir) when it is not;
// only a start it lets through is replaced, since that would spawn a CLI.
vi.mock('../src/core/worker-pool.js', async () => {
  const { existsSync } = await import('node:fs');
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    forkWorker: (ds: any, ...rest: unknown[]) => {
      if (!existsSync(mocks.getSessionWorkingDir!(ds))) return actual.forkWorker(ds, ...rest);
      mocks.started(ds, ...rest);
      ds.worker = { killed: false, send: vi.fn() };
      return true;
    },
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

// session-manager first: worker-pool and session-manager import each other, and
// whichever loads first decides which forkWorker the other binds. Loaded first,
// session-manager (the scheduler) binds the stand-in above.
import {
  deliverOwnerBatchTurn,
  executeScheduledTask,
  getSessionWorkingDir,
} from '../src/core/session-manager.js';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { ScheduledTask } from '../src/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleThreadReply as handleThreadReply,
  __testOnly_sessionReply as daemonSessionReply,
} from '../src/daemon.js';
import { handleCardAction } from '../src/im/lark/card-handler.js';
import { initWorkerPool } from '../src/core/worker-pool.js';
import { MissingWorkingDirError, publishWorkingDirRecovery } from '../src/core/working-dir-recovery.js';

mocks.getSessionWorkingDir = getSessionWorkingDir;

const APP = 'sched_missing_dir_app';
const CHAT = 'oc_sched_missing_dir_chat';
const OWNER = 'ou_sched_owner';
const CARD_ID = 'om_sched_missing_dir_card';
const ROOT = 'om_sched_task_root';
const TASK_PROMPT = '汇总昨天的告警';

mkdirSync(mocks.dataDir, { recursive: true });
const tmpRoot = mkdtempSync(join(mocks.dataDir, 'dirs-'));
// No `-` in the name: git is never asked where a deleted worktree came from.
const GONE = join(tmpRoot, 'gone_dir', 'botmux');

afterAll(() => {
  rmSync(mocks.dataDir, { recursive: true, force: true });
});

// The daemon's own worker-pool wiring for a refused start (startDaemon):
// publish the recovery card for the session.
const lastRepoScan = new Map<string, any[]>();
initWorkerPool({
  sessionReply: daemonSessionReply,
  getSessionWorkingDir,
  onMissingWorkingDir(ds, path, ctx) {
    void publishWorkingDirRecovery(ds, path, { sessionReply: daemonSessionReply, lastRepoScan }, ctx);
  },
  getActiveCount: () => activeSessions.size,
  closeSession: vi.fn(),
} as any);

function registerTestBot(defaultWorkingDir: string): void {
  const bot = registerBot({
    larkAppId: APP,
    larkAppSecret: 's',
    cliId: 'claude-code',
    allowedUsers: [OWNER],
    defaultWorkingDir,
  });
  bot.resolvedAllowedUsers = [OWNER];
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-sched-missing',
    name: '每日告警汇总',
    schedule: 'every 30m',
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
    prompt: TASK_PROMPT,
    workingDir: GONE,
    chatId: CHAT,
    chatType: 'group',
    larkAppId: APP,
    executionPosition: 'topic',
    rootMessageId: ROOT,
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as ScheduledTask;
}

function fire(task: ScheduledTask): Promise<void> {
  return executeScheduledTask(task, activeSessions, () => {});
}

/** Every interactive card the daemon published, as JSON text. */
function publishedCards(): string[] {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .filter(call => (call as unknown[])[3] === 'interactive')
    .map(call => String((call as unknown[])[2]));
}

/** Every plain text the daemon sent to the chat. */
function sentTexts(): string {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .filter(call => (call as unknown[])[3] !== 'interactive')
    .map(call => String((call as unknown[])[2]))
    .join('\n');
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

/** Fire once into the missing directory: refused, recovery card up. */
async function fireIntoMissingDir(task: ScheduledTask, anchor: string): Promise<DaemonSession> {
  await expect(fire(task)).rejects.toBeInstanceOf(MissingWorkingDirError);
  await vi.waitFor(() => expect(publishedCards()).toHaveLength(1));
  expect(mocks.started).not.toHaveBeenCalled();
  const ds = activeSessions.get(sessionKey(anchor, APP)) as DaemonSession;
  expect(ds.workingDirRecovery).toMatchObject({ path: GONE, cardMessageId: CARD_ID });
  return ds;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.clear();
  activeSessions.clear();
  lastRepoScan.clear();
  mocks.replyMessage.mockImplementation(async (...args: any[]) => (args[3] === 'interactive' ? CARD_ID : 'om_reply'));
  mocks.sendMessage.mockImplementation(async (...args: any[]) => (args[3] === 'interactive' ? CARD_ID : 'om_top'));
  mocks.scanMultipleProjects.mockReturnValue([]);
  registerTestBot(GONE);
});

describe('scheduled fire refused for a missing working directory (#2172)', () => {
  it('the recovery card moves the session, and the next fire runs the task there in the same session', async () => {
    const task = makeTask();
    const ds = await fireIntoMissingDir(task, ROOT);
    const sessionId = ds.session.sessionId;
    const chosen = mkdtempSync(join(tmpRoot, 'chosen-'));
    const cardReply = vi.fn(async () => 'om_card_reply');

    await handleCardAction(
      makeManualEvent(ROOT, chosen),
      { activeSessions, sessionReply: cardReply, lastRepoScan },
      APP,
    );

    const replies = cardReply.mock.calls.map(call => String((call as unknown[])[1])).join('\n');
    expect(replies).not.toContain('待提交');
    expect(replies).toContain(chosen);
    expect(ds.workingDir).toBe(chosen);
    expect(ds.workingDirRecovery).toBeUndefined();

    await fire(task);

    expect(mocks.started).toHaveBeenCalledTimes(1);
    const [startedDs, input] = mocks.started.mock.calls[0]! as unknown as [DaemonSession, unknown];
    expect(startedDs).toBe(activeSessions.get(sessionKey(ROOT, APP)));
    expect(startedDs.session.sessionId).toBe(sessionId);
    expect(getSessionWorkingDir(startedDs)).toBe(chosen);
    expect(JSON.stringify(input)).toContain(TASK_PROMPT);
  });

  it('after the move, a message in the topic starts with that message — the refused run does not come back with it', async () => {
    const task = makeTask();
    await fireIntoMissingDir(task, ROOT);
    const chosen = mkdtempSync(join(tmpRoot, 'reply-'));
    await handleCardAction(
      makeManualEvent(ROOT, chosen),
      { activeSessions, sessionReply: vi.fn(async () => 'om_card_reply'), lastRepoScan },
      APP,
    );

    await handleThreadReply(
      makeEventData('om_sched_human', '看看 README', ROOT),
      { chatId: CHAT, messageId: 'om_sched_human', chatType: 'group', scope: 'thread', anchor: ROOT, larkAppId: APP } as any,
    );

    expect(mocks.started).toHaveBeenCalledTimes(1);
    const input = JSON.stringify(mocks.started.mock.calls[0]![1]);
    expect(input).toContain('看看 README');
    expect(input).not.toContain(TASK_PROMPT);
  });

  it('`/cd` in the task topic moves the session instead of blaming an unsettled Codex App turn', async () => {
    const task = makeTask();
    const ds = await fireIntoMissingDir(task, ROOT);
    const chosen = mkdtempSync(join(tmpRoot, 'cd-'));

    await handleThreadReply(
      makeEventData('om_sched_cd', `/cd ${chosen}`, ROOT),
      { chatId: CHAT, messageId: 'om_sched_cd', chatType: 'group', scope: 'thread', anchor: ROOT, larkAppId: APP } as any,
    );

    expect(sentTexts()).not.toContain('未结算');
    expect(ds.workingDir).toBe(chosen);

    await fire(task);

    expect(mocks.started).toHaveBeenCalledTimes(1);
    expect(getSessionWorkingDir(mocks.started.mock.calls[0]![0] as DaemonSession)).toBe(chosen);
  });

  it('a silent task-position run (virtual anchor) is recoverable the same way', async () => {
    const task = makeTask({ executionPosition: 'task', rootMessageId: undefined, silent: true });
    const anchor = `schedule-task:${task.id}`;
    const ds = await fireIntoMissingDir(task, anchor);
    const sessionId = ds.session.sessionId;
    const chosen = mkdtempSync(join(tmpRoot, 'silent-'));

    await handleCardAction(
      makeManualEvent(anchor, chosen),
      { activeSessions, sessionReply: vi.fn(async () => 'om_card_reply'), lastRepoScan },
      APP,
    );
    expect(ds.workingDir).toBe(chosen);

    await fire(task);

    expect(mocks.started).toHaveBeenCalledTimes(1);
    const startedDs = mocks.started.mock.calls[0]![0] as DaemonSession;
    expect(startedDs.session.sessionId).toBe(sessionId);
    expect(getSessionWorkingDir(startedDs)).toBe(chosen);
  });

  it('left alone, the next fire fails on the missing directory again — not on a stuck opening — and does not repeat the card', async () => {
    const task = makeTask({ workingDir: '' });   // falls back to the (missing) bot default
    await fireIntoMissingDir(task, ROOT);

    await expect(fire(task)).rejects.toBeInstanceOf(MissingWorkingDirError);

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(publishedCards()).toHaveLength(1);
    expect(mocks.started).not.toHaveBeenCalled();
  });

  it('a recreated directory needs no card at all: the next fire just runs', async () => {
    const task = makeTask();
    await fireIntoMissingDir(task, ROOT);
    mkdirSync(GONE, { recursive: true });
    try {
      await fire(task);
    } finally {
      rmSync(join(tmpRoot, 'gone_dir'), { recursive: true, force: true });
    }

    expect(mocks.started).toHaveBeenCalledTimes(1);
    expect(existsSync(GONE)).toBe(false);
  });
});

// A restart of such a session would only be refused again by forkWorker (and
// used to answer 「正在重启 / 重启失败」). Both restart entries — the `/restart`
// command and the session card's button — guide to a directory instead.
describe('restart of a session whose working directory is missing', () => {
  const threadCtx = (messageId: string) => (
    { chatId: CHAT, messageId, chatType: 'group', scope: 'thread', anchor: ROOT, larkAppId: APP } as any
  );
  const restartClick = () => ({
    operator: { open_id: OWNER },
    action: { value: { action: 'restart', root_id: ROOT } },
    context: { open_message_id: 'om_sched_session_card' },
  });

  it('`/restart` after a refused fire points at the recovery card instead of restarting', async () => {
    const ds = await fireIntoMissingDir(makeTask(), ROOT);

    await handleThreadReply(makeEventData('om_sched_restart', '/restart', ROOT), threadCtx('om_sched_restart'));

    const said = sentTexts();
    expect(said).toContain(GONE);
    expect(said).toContain('/cd');
    expect(said).not.toContain('正在重启');
    expect(publishedCards()).toHaveLength(1);
    expect(mocks.started).not.toHaveBeenCalled();
    expect(ds.workingDirRecovery?.cardMessageId).toBe(CARD_ID);
  });

  it('the session card\'s restart button answers the same way', async () => {
    await fireIntoMissingDir(makeTask(), ROOT);
    const cardReply = vi.fn(async () => 'om_card_reply');

    await handleCardAction(restartClick(), { activeSessions, sessionReply: cardReply, lastRepoScan }, APP);

    const said = cardReply.mock.calls.map(call => String((call as unknown[])[1])).join('\n');
    expect(said).toContain(GONE);
    expect(said).not.toContain('正在重启');
    expect(mocks.started).not.toHaveBeenCalled();
  });

  it('a directory lost with no recovery card up yet brings the card up', async () => {
    await fireIntoMissingDir(makeTask(), ROOT);
    const chosen = mkdtempSync(join(tmpRoot, 'lost-again-'));
    await handleCardAction(
      makeManualEvent(ROOT, chosen),
      { activeSessions, sessionReply: vi.fn(async () => 'om_card_reply'), lastRepoScan },
      APP,
    );
    rmSync(chosen, { recursive: true, force: true });

    await handleThreadReply(makeEventData('om_sched_restart_lost', '/restart', ROOT), threadCtx('om_sched_restart_lost'));

    await vi.waitFor(() => expect(publishedCards()).toHaveLength(2));
    expect(cardVisibleText(publishedCards()[1]!)).toContain(chosen);
    // The card comes from the guard, not from a restart attempt refused on the way.
    expect(sentTexts()).not.toContain('正在重启');
    expect(mocks.started).not.toHaveBeenCalled();
  });
});

describe('decision board batch refused for a missing working directory', () => {
  it('the recovery card moves the steward session and the redelivered batch runs there', async () => {
    const batch = {
      larkAppId: APP,
      chatId: CHAT,
      turnId: `board:${APP}:batch-1`,
      prompt: '处理这批决定',
      announcement: { texts: ['提交了 1 条决定'], images: [] },
      attachments: [],
      ownerOpenId: OWNER,
      sessionTitle: '决策看板',
    };
    await expect(deliverOwnerBatchTurn(batch, activeSessions, () => {})).rejects.toBeInstanceOf(MissingWorkingDirError);
    await vi.waitFor(() => expect(publishedCards()).toHaveLength(1));
    const ds = activeSessions.get(sessionKey(CHAT, APP)) as DaemonSession;
    const chosen = mkdtempSync(join(tmpRoot, 'board-'));

    await handleCardAction(
      makeManualEvent(CHAT, chosen),
      { activeSessions, sessionReply: vi.fn(async () => 'om_card_reply'), lastRepoScan },
      APP,
    );
    expect(ds.workingDir).toBe(chosen);

    await deliverOwnerBatchTurn(batch, activeSessions, () => {});

    expect(mocks.started).toHaveBeenCalledTimes(1);
    const startedDs = mocks.started.mock.calls[0]![0] as DaemonSession;
    expect(startedDs.session.sessionId).toBe(ds.session.sessionId);
    expect(getSessionWorkingDir(startedDs)).toBe(chosen);
  });
});

// Fire-time swap check (#2367 P1-1). A task created through a conversation turn
// stores a canonical workingDir and carries a non-null authority targetTurnId.
// If that directory is later swapped for a symlink (the agent owns the parent),
// the fire must be refused before any session is chosen or spawned — otherwise
// the worker would realpath the link and grant its target readWrite.
describe('scheduled fire refused when a turn-created task\'s workingDir was swapped', () => {
  let store: import('../src/services/schedule-authority-store.js').ScheduleAuthorityStore;
  let scheduler: typeof import('../src/core/scheduler.js');
  const turn = { directTurn: { turnId: 'om_creating_turn', maxTasksPerTurn: 64 } };

  beforeEach(async () => {
    const { ScheduleAuthorityStore } = await import('../src/services/schedule-authority-store.js');
    scheduler = await import('../src/core/scheduler.js');
    const { setScheduleScope } = await import('../src/services/schedule-store.js');
    setScheduleScope(APP);
    store = ScheduleAuthorityStore.open(mkdtempSync(join(tmpRoot, 'authority-')));
    store.initializeApp(APP, []);
    scheduler.setScheduleAuthorityStore(store);
  });

  afterEach(() => {
    scheduler.setScheduleAuthorityStore(null);
    store.close();
  });

  function realDir(prefix: string): string {
    return realpathSync(mkdtempSync(join(tmpRoot, prefix)));
  }

  function create(workingDir: string, audit?: typeof turn, id = randomTaskId()): ScheduledTask {
    return scheduler.addTask({
      id, name: '每日告警汇总', schedule: 'every 30m', prompt: TASK_PROMPT, workingDir,
      chatId: CHAT, chatType: 'group', larkAppId: APP, executionPosition: 'topic', rootMessageId: ROOT,
    }, audit);
  }

  function randomTaskId(): string {
    return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  }

  function swapToLink(dir: string, target: string): void {
    renameSync(dir, `${dir}.moved`);
    symlinkSync(target, dir);
  }

  it('refuses the fire after a swap and starts nothing', async () => {
    const cwdChild = join(realDir('cwd-'), 'sub');
    mkdirSync(cwdChild);
    const task = create(cwdChild, turn);
    swapToLink(cwdChild, realDir('home-'));

    await expect(fire(task)).rejects.toThrow(/schedule_working_dir_swapped/);
    expect(mocks.started).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('refuses a swapped delegated task the same way', async () => {
    const dir = join(realDir('deleg-'), 'sub');
    mkdirSync(dir);
    const result = scheduler.commitDelegatedTask({
      params: { id: 'de1e9a7e', name: '每日告警汇总', schedule: 'every 30m', prompt: TASK_PROMPT, workingDir: dir,
        chatId: CHAT, chatType: 'group', larkAppId: APP, executionPosition: 'topic', rootMessageId: ROOT },
      grantId: 'grant-1', requestHash: 'hash-1',
      control: { openId: OWNER, unionId: 'on_owner', credentialOpenId: OWNER, runScopes: [], selfManage: false },
      sourceMessageId: 'om_src', sourceSessionId: 'src-session', targetTurnId: 'om_creating_turn',
      targetGeneration: 1, maxTasksPerTurn: 64,
    });
    expect(result.ok).toBe(true);
    swapToLink(dir, realDir('home-'));
    await expect(fire((result as { task: ScheduledTask }).task)).rejects.toThrow(/schedule_working_dir_swapped/);
    expect(mocks.started).not.toHaveBeenCalled();
  });

  it('fires an untouched turn-created task, including one in a role-library-style subtree', async () => {
    const subtree = realDir('roles-');
    const dir = join(subtree, 'shared', 'default');
    mkdirSync(dir, { recursive: true });
    const { roleLibraryWorkingDirEscapes } = await import('../src/core/role-library.js');
    expect(roleLibraryWorkingDirEscapes(dir, subtree, subtree)).toBe(false);
    await fire(create(dir, turn));
    expect(mocks.started).toHaveBeenCalledTimes(1);
  });

  it('does not re-check host-created tasks, even at a symlinked path', async () => {
    const link = join(realDir('host-'), 'link');
    symlinkSync(realDir('target-'), link);
    await fire(create(link));
    expect(mocks.started).toHaveBeenCalledTimes(1);
  });

  it('refuses when the fire input disagrees with the authority record', async () => {
    const dir = realDir('auth-');
    const task = create(dir, turn);
    await expect(fire({ ...task, workingDir: realDir('projection-') })).rejects.toThrow(/schedule_working_dir_swapped/);
    expect(mocks.started).not.toHaveBeenCalled();
  });
});
