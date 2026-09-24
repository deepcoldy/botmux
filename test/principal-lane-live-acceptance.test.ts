import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-principal-live-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  process.env.BOTMUX_XPI_ENABLED = 'true';
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return {
    dataDir,
    messageSequence: 0,
    sendMessage: vi.fn(async () => `om_out_${++mocks.messageSequence}`),
    replyMessage: vi.fn(async () => `om_reply_${++mocks.messageSequence}`),
    updateMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => true),
    addReaction: vi.fn(async () => 'reaction'),
    getChatMode: vi.fn(async () => 'group' as const),
    forkWorker: vi.fn(),
    forkAdoptWorker: vi.fn(),
    sendWorkerInput: vi.fn(),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
    getAvailableBots: vi.fn(async () => []),
    ensureSessionWhiteboard: vi.fn(),
    resolveSender: vi.fn(async (_appId: string, openId?: string) => (
      openId ? { openId, type: 'user' as const, name: openId } : undefined
    )),
    emitHookEvent: vi.fn(),
    workerInputs: [] as Array<{
      kind: 'fork' | 'live';
      laneId: string;
      turnId: string;
      workingDir?: string;
      content: string;
    }>,
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor(_opts: unknown) {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() { return this; } },
  LoggerLevel: { info: 2 },
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
  })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    sendMessage: mocks.sendMessage,
    replyMessage: mocks.replyMessage,
    updateMessage: mocks.updateMessage,
    deleteMessage: mocks.deleteMessage,
    addReaction: mocks.addReaction,
    getChatMode: mocks.getChatMode,
    getChatModeStrict: mocks.getChatMode,
  };
});

vi.mock('../src/daemon-internal-client-wrapper.js', () => ({
  createDaemonClientFor: vi.fn(() => ({
    request: vi.fn(async () => ({ status: 200, raw: '', body: { sessions: [] } })),
  })),
}));

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    forkWorker: mocks.forkWorker,
    forkAdoptWorker: mocks.forkAdoptWorker,
    sendWorkerInput: mocks.sendWorkerInput,
  };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    downloadResources: mocks.downloadResources,
    getAvailableBots: mocks.getAvailableBots,
    ensureSessionWhiteboard: mocks.ensureSessionWhiteboard,
  };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: mocks.resolveSender };
});

vi.mock('../src/services/hook-runner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/hook-runner.js');
  return { ...actual, emitHookEvent: mocks.emitHookEvent };
});

import {
  __testOnly_resetBotRegistry,
  registerBot,
} from '../src/bot-registry.js';
import {
  freezePrincipalLaneTurnBinding,
  readPrincipalLaneTurnBinding,
} from '../src/core/principal-lane-turn.js';
import {
  __testOnly_setupWorkerHandlers,
  initWorkerPool,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { __resetPrincipalLaneAdmissions } from '../src/core/principal-lane-admission.js';
import {
  activeSessionKey,
  sessionKey,
  type DaemonSession,
} from '../src/core/types.js';
import { restoreActiveSessions } from '../src/core/session-manager.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_decideLivePrincipalLaneReference as decideLivePrincipalLaneReference,
  __testOnly_driveNextPrincipalLaneTurn as driveNextPrincipalLaneTurn,
  __testOnly_handlePrincipalLaneLiveMessage as handlePrincipalLaneLiveMessage,
  __testOnly_onPrincipalLaneWorkerExit as onPrincipalLaneWorkerExit,
  __testOnly_onPrincipalLaneTurnTerminal as onPrincipalLaneTurnTerminal,
  __testOnly_sessionReply as sessionReply,
} from '../src/daemon.js';
import {
  __testOnly_dispatchHumanMessageViaHandlers,
  type EventHandlers,
  type RoutingContext,
} from '../src/im/lark/event-dispatcher.js';
import {
  handleCardAction,
  type CardHandlerDeps,
} from '../src/im/lark/card-handler.js';
import * as sessionStore from '../src/services/session-store.js';
import { __resetPeerCrossRefCacheForTest } from '../src/services/peer-cross-ref-store.js';

const appId = 'app-principal-live';
const chatId = 'oc_principal_live';
const sourceRootId = 'om_source_root';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'live-test', GIT_AUTHOR_EMAIL: 'live-test@example.test',
      GIT_COMMITTER_NAME: 'live-test', GIT_COMMITTER_EMAIL: 'live-test@example.test',
    },
  }).trim();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function message(sender: 'a' | 'b' | 'c', messageId: string, text = messageId) {
  return {
    sender: {
      sender_type: 'user',
      sender_id: { open_id: `ou_${sender}`, union_id: `on_${sender}` },
    },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function context(messageId: string): RoutingContext {
  return {
    chatId,
    messageId,
    chatType: 'group',
    scope: 'chat',
    anchor: chatId,
    larkAppId: appId,
  };
}

function sourceDaemonSession(session: ReturnType<typeof sessionStore.createSession>): DaemonSession {
  return {
    session,
    worker: { killed: false, send: vi.fn() } as any,
    workerPort: null,
    workerToken: null,
    workerGeneration: 1,
    larkAppId: appId,
    chatId,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: Date.now(),
    cliVersion: 'test',
    lastMessageAt: Date.now(),
    hasHistory: true,
    workingDir: session.workingDir,
  };
}

function laneByPrincipal(principalKey: string): DaemonSession | undefined {
  return [...activeSessions.values()].find(
    ds => ds.session.principalLane?.principalKey === principalKey,
  );
}

describe('principal lane production live acceptance', () => {
  let repo: string;
  let sourceDs: DaemonSession;
  let handlers: EventHandlers;
  let legacyReply: ReturnType<typeof vi.fn>;
  let legacyNewTopic: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rmSync(mocks.dataDir, { recursive: true, force: true });
    mkdirSync(mocks.dataDir, { recursive: true });
    process.env.BOTMUX_XPI_ENABLED = 'true';
    __resetPeerCrossRefCacheForTest();
    __testOnly_resetBotRegistry();
    registerBot({
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      allowedUsers: ['ou_a', 'ou_b', 'ou_c'],
    });

    repo = join(mocks.dataDir, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-b', 'master');
    writeFileSync(join(repo, 'README.md'), 'live acceptance\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'fixture');

    sessionStore.init(appId);
    const source = sessionStore.createSession(
      chatId, sourceRootId, 'source', 'group', 'chat', { source: 'ordinary-feishu' },
    );
    source.larkAppId = appId;
    source.ownerOpenId = 'ou_a';
    source.ownerUnionId = 'on_a';
    source.creatorOpenId = 'ou_a';
    source.lastCallerOpenId = 'ou_a';
    source.workingDir = repo;
    source.workerGeneration = 1;
    source.lastCliInput = { content: 'existing source turn' };
    sessionStore.updateSession(source);
    sourceDs = sourceDaemonSession(source);
    activeSessions.clear();
    setActiveSessionsRegistry(activeSessions);
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: ds => ds?.workingDir ?? repo,
      getActiveCount: () => activeSessions.size,
      closeSession: vi.fn(async () => true),
    });
    __resetPrincipalLaneAdmissions();
    activeSessions.set(sessionKey(chatId, appId), sourceDs);

    mocks.messageSequence = 0;
    mocks.workerInputs.length = 0;
    vi.clearAllMocks();
    mocks.sendMessage.mockImplementation(async () => `om_out_${++mocks.messageSequence}`);
    mocks.replyMessage.mockImplementation(async () => `om_reply_${++mocks.messageSequence}`);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    mocks.forkWorker.mockImplementation((ds: DaemonSession, input: any, opts?: any) => {
      const turnId = String(opts?.turnId ?? input?.turnId ?? '');
      const laneId = ds.session.principalLane?.laneId ?? 'legacy';
      if (turnId === 'om_c1') {
        throw new Error('synthetic worker fork failure');
      }
      const generation = Math.max(ds.workerGeneration ?? 0, ds.session.workerGeneration ?? 0) + 1;
      ds.workerGeneration = generation;
      ds.session.workerGeneration = generation;
      opts?.onWorkerGenerationReserved?.(generation);
      ds.worker = { killed: false, send: vi.fn() } as any;
      freezePrincipalLaneTurnBinding(ds, turnId, generation);
      opts?.onIpcDispatchAttempted?.();
      mocks.workerInputs.push({
        kind: 'fork', laneId, turnId, workingDir: ds.workingDir,
        content: String(input?.content ?? input ?? ''),
      });
      return true;
    });
    mocks.forkAdoptWorker.mockImplementation((ds: DaemonSession, opts?: any) => {
      const turnId = String(opts?.turnId ?? '');
      const generation = Math.max(ds.workerGeneration ?? 0, ds.session.workerGeneration ?? 0) + 1;
      ds.workerGeneration = generation;
      ds.session.workerGeneration = generation;
      opts?.onWorkerGenerationReserved?.(generation);
      ds.worker = { killed: false, send: vi.fn() } as any;
      opts?.onIpcDispatchAttempted?.();
      mocks.workerInputs.push({
        kind: 'fork', laneId: ds.session.principalLane?.laneId ?? 'legacy', turnId,
        workingDir: ds.workingDir, content: String(opts?.prompt ?? ''),
      });
      return 'accepted';
    });
    mocks.sendWorkerInput.mockImplementation((ds: DaemonSession, input: any, turnId: string) => {
      if (ds.session.principalLane && turnId === 'om_c1') {
        throw new Error('synthetic worker input failure');
      }
      const generation = ds.workerGeneration ?? ds.session.workerGeneration ?? 1;
      ds.workerGeneration = generation;
      ds.session.workerGeneration = generation;
      freezePrincipalLaneTurnBinding(ds, turnId, generation);
      mocks.workerInputs.push({
        kind: 'live',
        laneId: ds.session.principalLane?.laneId ?? 'legacy',
        turnId,
        workingDir: ds.workingDir,
        content: String(input?.content ?? input ?? ''),
      });
      return true;
    });

    legacyReply = vi.fn(async () => undefined);
    legacyNewTopic = vi.fn(async () => undefined);
    handlers = {
      handleCardAction: vi.fn(async () => undefined),
      handlePrincipalLaneMessage: handlePrincipalLaneLiveMessage,
      handleThreadReply: legacyReply,
      handleNewTopic: legacyNewTopic,
    };
  });

  afterEach(() => {
    process.env.BOTMUX_XPI_ENABLED = 'true';
    activeSessions.clear();
    sessionStore.init();
    __resetPeerCrossRefCacheForTest();
    __testOnly_resetBotRegistry();
    rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  const dispatch = (sender: 'a' | 'b' | 'c', messageId: string, text = messageId) => {
    const data = message(sender, messageId, text);
    const ctx = context(messageId);
    return __testOnly_dispatchHumanMessageViaHandlers(
      appId, handlers, { data, ctx, ownsSession: true }, 0,
    );
  };

  it('drives the real live handler through durable B/C lanes and isolated worker turns', async () => {
    await dispatch('a', 'om_a1', 'A long task');
    expect(sourceDs.activeInteractiveTurn?.turnId).toBe('om_a1');

    const bDownloadEntered = deferred();
    const releaseBDownload = deferred();
    mocks.downloadResources.mockImplementation(async (_app: string, messageId: string) => {
      if (messageId === 'om_b1') {
        bDownloadEntered.resolve();
        await releaseBDownload.promise;
      }
      return { attachments: [], needLogin: false };
    });

    const b1 = dispatch('b', 'om_b1', 'B first');
    await bDownloadEntered.promise;
    const b2 = dispatch('b', 'om_b2', 'B second');
    const c1 = dispatch('c', 'om_c1', 'C fails once');
    await c1;
    const c2 = dispatch('c', 'om_c2', 'C retries');
    await c2;

    expect(mocks.workerInputs.some(row => row.turnId === 'om_c1')).toBe(false);
    expect(mocks.workerInputs.some(row => row.turnId === 'om_c2')).toBe(true);
    expect(mocks.workerInputs.some(row => row.turnId === 'om_b1')).toBe(false);
    expect(mocks.workerInputs.some(row => row.turnId === 'om_b2')).toBe(false);
    expect(sourceDs.activeInteractiveTurn?.turnId).toBe('om_a1');

    releaseBDownload.resolve();
    await Promise.all([b1, b2]);
    expect(legacyReply).not.toHaveBeenCalled();
    expect(legacyNewTopic).not.toHaveBeenCalled();
    expect(mocks.replyMessage.mock.calls.some(call =>
      call[1] === 'om_c1' && String(call[2]).includes('其他对话不受影响'))).toBe(true);

    const resolvedB = sessionStore.resolvePrincipalLaneForIngress({
      sourceSessionId: sourceDs.session.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
    });
    const resolvedC = sessionStore.resolvePrincipalLaneForIngress({
      sourceSessionId: sourceDs.session.sessionId,
      identity: { larkAppId: appId, unionId: 'on_c', openId: 'ou_c' },
    });
    expect(resolvedB.status).toBe('ready');
    expect(resolvedC.status).toBe('ready');
    if (resolvedB.status !== 'ready' || resolvedC.status !== 'ready') {
      throw new Error('expected durable B/C lanes');
    }
    const hydratedB = await sessionStore.hydratePrincipalLaneForIngress(
      sourceDs.session.sessionId, resolvedB.laneId,
    );
    const hydratedC = await sessionStore.hydratePrincipalLaneForIngress(
      sourceDs.session.sessionId, resolvedC.laneId,
    );
    expect(hydratedB.status).toBe('ready');
    expect(hydratedC.status).toBe('ready');
    if (hydratedB.status !== 'ready' || hydratedC.status !== 'ready') {
      throw new Error('expected hydrated B/C lanes');
    }

    const b = laneByPrincipal('user:union:on_b')!;
    const c = laneByPrincipal('user:union:on_c')!;
    // The worker revokes live-send authority before its terminal IPC. That
    // earlier revoke may clear activeInteractiveTurn, but must not open a gap
    // where a third same-lane message can overtake B1's terminal boundary.
    b.activeInteractiveTurn = undefined;
    await dispatch('b', 'om_b3', 'B third after revoke');
    expect(mocks.workerInputs.some(row => row.turnId === 'om_b1')).toBe(true);
    expect(mocks.workerInputs.some(row => row.turnId === 'om_b2')).toBe(false);
    expect(mocks.workerInputs.some(row => row.turnId === 'om_b3')).toBe(false);
    const b1Generation = b.principalLaneRunningTurn!.workerGeneration;
    expect(b.principalLaneRunningTurn).toEqual({
      turnId: 'om_b1',
      workerGeneration: b1Generation,
    });
    expect(b.session.principalLaneQueuedTurns).toMatchObject([
      { turnId: 'om_b2', dispatchState: 'queued' },
      { turnId: 'om_b3', dispatchState: 'queued' },
    ]);
    expect(onPrincipalLaneTurnTerminal(b, 'om_stale', b1Generation)).toBe(false);
    expect(onPrincipalLaneTurnTerminal(b, 'om_b1', b1Generation - 1)).toBe(false);
    expect(onPrincipalLaneWorkerExit(b, b1Generation - 1)).toBe(false);
    expect(b.principalLaneRunningTurn).toEqual({
      turnId: 'om_b1',
      workerGeneration: b1Generation,
    });
    expect(mocks.workerInputs.some(row => row.turnId === 'om_b2')).toBe(false);

    // Full-turn FIFO: B2 is not merely ordered after B1's input; it remains
    // outside the worker until B1's exact terminal edge releases the lane.
    expect(onPrincipalLaneTurnTerminal(b, 'om_b1', b1Generation)).toBe(true);
    const turnOrder = mocks.workerInputs.map(row => row.turnId);
    expect(turnOrder.indexOf('om_b1')).toBeGreaterThanOrEqual(0);
    expect(turnOrder.indexOf('om_b1')).toBeLessThan(turnOrder.indexOf('om_b2'));
    expect(b.activeInteractiveTurn?.turnId).toBe('om_b2');
    expect(b.session.principalLaneQueuedTurns).toMatchObject([
      { turnId: 'om_b2', dispatchState: 'attempting' },
      { turnId: 'om_b3', dispatchState: 'queued' },
    ]);
    const b2Generation = b.principalLaneRunningTurn!.workerGeneration;
    expect(onPrincipalLaneWorkerExit(b, b2Generation - 1)).toBe(false);
    expect(b.principalLaneRunningTurn?.turnId).toBe('om_b2');
    // The exact generation exit atomically terminalizes the commit-unknown
    // head, persists a separate owner notice, and advances without replaying B2.
    expect(onPrincipalLaneWorkerExit(b, b2Generation)).toBe(true);
    expect(b.principalLaneRunningTurn).toBeUndefined();
    expect(b.session.principalLaneDispatchUnknownNotices).toMatchObject([
      { turnId: 'om_b2', noticePending: true },
    ]);
    await vi.waitFor(() => {
      expect(mocks.workerInputs.some(row => row.turnId === 'om_b3')).toBe(true);
    });
    expect(mocks.workerInputs.filter(row => row.turnId === 'om_b2')).toHaveLength(1);
    expect(activeSessions.get(activeSessionKey(b))).toBe(b);
    expect(activeSessions.get(activeSessionKey(c))).toBe(c);
    expect(b.worker).not.toBe(sourceDs.worker);
    expect(c.worker).not.toBe(sourceDs.worker);
    expect(b.worker).not.toBe(c.worker);
    expect(b.workingDir).toBe(hydratedB.session.workingDir);
    expect(c.workingDir).toBe(hydratedC.session.workingDir);
    expect(b.workingDir).not.toBe(repo);
    expect(c.workingDir).not.toBe(repo);
    expect(b.workingDir).not.toBe(c.workingDir);
    expect(hydratedB.worktree.worktreeGitCommonDir).toBe(hydratedC.worktree.worktreeGitCommonDir);

    const db = new DatabaseSync(join(mocks.dataDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_worktrees')
        .get() as { n: number }).n).toBe(2);
    } finally { db.close(); }

    const replyB1 = await sessionReply(
      chatId, 'B1 reply', 'text', appId, 'om_b1', { sourceSessionId: b.session.sessionId },
    );
    const replyB = await sessionReply(
      chatId, 'B reply', 'text', appId, 'om_b2', { sourceSessionId: b.session.sessionId },
    );
    const replyB3 = await sessionReply(
      chatId, 'B3 reply', 'text', appId, 'om_b3', { sourceSessionId: b.session.sessionId },
    );
    const replyC = await sessionReply(
      chatId, 'C reply', 'text', appId, 'om_c2', { sourceSessionId: c.session.sessionId },
    );
    expect(sessionStore.readTrustedMessageProvenance(
      replyB1, sourceDs.session.sessionId,
    )).toMatchObject({
      laneId: b.session.principalLane!.laneId,
      sessionId: b.session.sessionId,
      turnId: 'om_b1',
      workerGeneration: b.workerGeneration,
    });
    expect(sessionStore.readTrustedMessageProvenance(
      replyB, sourceDs.session.sessionId,
    )).toMatchObject({
      laneId: b.session.principalLane!.laneId,
      sessionId: b.session.sessionId,
      turnId: 'om_b2',
      workerGeneration: b.workerGeneration,
    });
    expect(sessionStore.readTrustedMessageProvenance(
      replyC, sourceDs.session.sessionId,
    )).toMatchObject({
      laneId: c.session.principalLane!.laneId,
      sessionId: c.session.sessionId,
      turnId: 'om_c2',
      workerGeneration: c.workerGeneration,
    });

    const cardDeps: CardHandlerDeps = {
      activeSessions,
      sessionReply,
      lastRepoScan: new Map(),
    };
    const cardAction = (ds: DaemonSession, cardMessageId: string) => handleCardAction({
      operator: { open_id: 'ou_b', union_id: 'on_b' },
      context: { open_message_id: cardMessageId },
      action: {
        value: {
          action: 'acceptance_probe',
          root_id: chatId,
          session_id: ds.session.sessionId,
        },
      },
    }, cardDeps, appId);

    await expect(cardAction(b, replyB3)).resolves.toBeUndefined();
    await expect(cardAction(b, replyC)).resolves.toMatchObject({
      toast: { type: 'warning' },
    });
    b.currentTurnId = 'om_b_future';
    await expect(cardAction(b, replyB3)).resolves.toMatchObject({
      toast: { type: 'warning' },
    });
    b.currentTurnId = 'om_b3';
    b.workerGeneration = (b.workerGeneration ?? 0) + 1;
    b.session.workerGeneration = b.workerGeneration;
    await expect(cardAction(b, replyB3)).resolves.toMatchObject({
      toast: { type: 'warning' },
    });
  }, 30_000);

  it('keeps a queued FIFO head retryable when fork fails before worker IPC', async () => {
    await dispatch('a', 'om_retry_source', 'source active');
    await dispatch('c', 'om_retry_seed', 'materialize C');
    const c = laneByPrincipal('user:union:on_c')!;
    const caller = {
      requestLarkAppId: appId,
      requestUserOpenId: 'ou_c',
      requestUserUnionId: 'on_c',
      senderType: 'user' as const,
    };
    c.worker = null;
    c.activeInteractiveTurn = undefined;
    c.principalLaneRunningTurn = undefined;
    c.session.principalLaneQueuedTurns = [
      {
        version: 1,
        turnId: 'om_retry_head',
        caller,
        userPrompt: 'retry head',
        title: 'retry head',
        cliInput: { content: 'retry head', resources: [] },
        createdAt: new Date().toISOString(),
        resume: true,
        dispatchState: 'queued',
      },
      {
        version: 1,
        turnId: 'om_retry_follower',
        caller,
        userPrompt: 'retry follower',
        title: 'retry follower',
        cliInput: { content: 'retry follower', resources: [] },
        createdAt: new Date().toISOString(),
        resume: true,
        dispatchState: 'queued',
      },
    ];
    sessionStore.updateSession(c.session);
    mocks.forkWorker.mockImplementationOnce(() => {
      throw new Error('synthetic pre-IPC fork failure');
    });

    expect(driveNextPrincipalLaneTurn(c)).toBe(false);
    expect(c.session.principalLaneQueuedTurns).toMatchObject([
      { turnId: 'om_retry_head', dispatchState: 'queued' },
      { turnId: 'om_retry_follower', dispatchState: 'queued' },
    ]);
    expect(mocks.workerInputs.some(row => row.turnId === 'om_retry_follower')).toBe(false);

    expect(driveNextPrincipalLaneTurn(c)).toBe(true);
    expect(c.session.principalLaneQueuedTurns).toMatchObject([
      { turnId: 'om_retry_head', dispatchState: 'attempting' },
      { turnId: 'om_retry_follower', dispatchState: 'queued' },
    ]);
    expect(mocks.workerInputs.filter(row => row.turnId === 'om_retry_head')).toHaveLength(1);
    expect(mocks.workerInputs.some(row => row.turnId === 'om_retry_follower')).toBe(false);
  }, 30_000);

  it('persists real explicit-send IPC provenance and routes own/foreign references', async () => {
    await dispatch('a', 'om_ipc_a', 'A active');
    await dispatch('b', 'om_ipc_b', 'B active');
    await dispatch('c', 'om_ipc_c', 'C active');

    const b = laneByPrincipal('user:union:on_b')!;
    const c = laneByPrincipal('user:union:on_c')!;
    const generation = b.workerGeneration!;
    const worker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      send: vi.fn(),
      kill: vi.fn(),
    });
    b.worker = worker as any;
    __testOnly_setupWorkerHandlers(
      b,
      worker as any,
      { ready: true, failureNotified: false },
      generation,
    );

    worker.emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_ipc_b',
      messageId: 'om_ipc_b_progress',
      responseKind: 'progress',
    });
    worker.emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_ipc_b',
      messageId: 'om_ipc_b_final',
      responseKind: 'final',
    });

    for (const messageId of ['om_ipc_b_progress', 'om_ipc_b_final']) {
      expect(sessionStore.readTrustedMessageProvenance(
        messageId, sourceDs.session.sessionId,
      )).toMatchObject({
        messageId,
        direction: 'outbound',
        laneId: b.session.principalLane!.laneId,
        sessionId: b.session.sessionId,
        turnId: 'om_ipc_b',
        principalKey: 'user:union:on_b',
        workerGeneration: generation,
      });
    }

    expect(decideLivePrincipalLaneReference({
      sourceSessionId: sourceDs.session.sessionId,
      larkAppId: appId,
      callerPrincipalKey: 'user:union:on_b',
      callerLaneId: b.session.principalLane!.laneId,
      parentId: 'om_ipc_b_progress',
    }).decision).toMatchObject({
      kind: 'route_lane',
      laneId: b.session.principalLane!.laneId,
      reason: 'trusted_own_reference',
    });

    expect(decideLivePrincipalLaneReference({
      sourceSessionId: sourceDs.session.sessionId,
      larkAppId: appId,
      callerPrincipalKey: 'user:union:on_c',
      callerLaneId: c.session.principalLane!.laneId,
      parentId: 'om_ipc_b_final',
    }).decision).toEqual({
      kind: 'suggestion',
      targetLaneId: b.session.principalLane!.laneId,
      targetSessionId: b.session.sessionId,
    });

    b.activeInteractiveTurn = undefined;
    expect(decideLivePrincipalLaneReference({
      sourceSessionId: sourceDs.session.sessionId,
      larkAppId: appId,
      callerPrincipalKey: 'user:union:on_c',
      callerLaneId: c.session.principalLane!.laneId,
      parentId: 'om_ipc_b_final',
    }).decision).toMatchObject({
      kind: 'route_lane',
      laneId: c.session.principalLane!.laneId,
      reason: 'existing_caller_lane',
    });

    const nextGeneration = generation + 1;
    b.workerGeneration = nextGeneration;
    b.session.workerGeneration = nextGeneration;
    const nextWorker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      send: vi.fn(),
      kill: vi.fn(),
    });
    b.worker = nextWorker as any;
    __testOnly_setupWorkerHandlers(
      b,
      nextWorker as any,
      { ready: true, failureNotified: false },
      nextGeneration,
    );

    worker.emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_ipc_b',
      messageId: 'om_stale_worker_reply',
      responseKind: 'final',
    });
    nextWorker.emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_missing_binding',
      messageId: 'om_missing_binding_reply',
      responseKind: 'final',
    });
    b.workerGeneration = nextGeneration + 1;
    b.session.workerGeneration = nextGeneration + 1;
    nextWorker.emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_ipc_b',
      messageId: 'om_stale_generation_reply',
      responseKind: 'final',
    });
    expect(sessionStore.readTrustedMessageProvenance(
      'om_stale_worker_reply', sourceDs.session.sessionId,
    )).toBeUndefined();
    expect(sessionStore.readTrustedMessageProvenance(
      'om_missing_binding_reply', sourceDs.session.sessionId,
    )).toBeUndefined();
    expect(sessionStore.readTrustedMessageProvenance(
      'om_stale_generation_reply', sourceDs.session.sessionId,
    )).toBeUndefined();
  }, 30_000);

  it('restores source/B/C lanes into distinct runtime slots after daemon restart', async () => {
    await dispatch('a', 'om_restore_a', 'source bootstrap');
    await dispatch('b', 'om_restore_b', 'B before restart');
    await dispatch('c', 'om_restore_c', 'C before restart');

    const before = [...activeSessions.values()].filter(ds => ds.session.principalLane);
    expect(before).toHaveLength(3);
    expect(new Set(before.map(ds => activeSessionKey(ds))).size).toBe(3);
    expect(new Set(before.map(ds => ds.session.sessionId)).size).toBe(3);
    expect(new Set(before.map(ds => ds.workingDir)).size).toBe(3);

    const expected = new Map(before.map(ds => [
      ds.session.principalLane!.principalKey,
      {
        sessionId: ds.session.sessionId,
        laneId: ds.session.principalLane!.laneId,
        runtimeKey: activeSessionKey(ds),
        workingDir: ds.workingDir,
      },
    ]));
    activeSessions.clear();

    await restoreActiveSessions(activeSessions);

    const restored = [...activeSessions.values()].filter(ds => ds.session.principalLane);
    expect(restored).toHaveLength(3);
    expect(new Set(restored.map(ds => activeSessionKey(ds))).size).toBe(3);
    expect(new Set(restored.map(ds => ds.session.sessionId)).size).toBe(3);
    expect(new Set(restored.map(ds => ds.workingDir)).size).toBe(3);
    for (const ds of restored) {
      const authority = expected.get(ds.session.principalLane!.principalKey);
      expect(authority).toBeDefined();
      expect(ds.session.sessionId).toBe(authority!.sessionId);
      expect(ds.session.principalLane!.laneId).toBe(authority!.laneId);
      expect(activeSessionKey(ds)).toBe(authority!.runtimeKey);
      expect(ds.workingDir).toBe(authority!.workingDir);
      expect(activeSessions.get(authority!.runtimeKey)).toBe(ds);
      expect(sessionStore.getSession(authority!.sessionId)?.status).toBe('active');
    }
    expect(activeSessions.get(sessionKey(chatId, appId))?.session.principalLane?.laneId)
      .toBe('source');
  }, 30_000);

  it('isolates one invalid shadow proof without colliding with healthy restored lanes', async () => {
    await dispatch('a', 'om_restore_isolation_a', 'source bootstrap');
    await dispatch('b', 'om_restore_isolation_b', 'healthy B before restart');
    await dispatch('c', 'om_restore_isolation_c', 'broken C before restart');

    const before = [...activeSessions.values()].filter(ds => ds.session.principalLane);
    expect(before).toHaveLength(3);
    const sourceBefore = before.find(ds => ds.session.principalLane?.laneId === 'source');
    const healthyBefore = before.find(
      ds => ds.session.principalLane?.principalKey === 'user:union:on_b',
    );
    const brokenBefore = before.find(
      ds => ds.session.principalLane?.principalKey === 'user:union:on_c',
    );
    expect(sourceBefore).toBeDefined();
    expect(healthyBefore).toBeDefined();
    expect(brokenBefore).toBeDefined();

    const sourceRuntimeKey = activeSessionKey(sourceBefore!);
    const healthyRuntimeKey = activeSessionKey(healthyBefore!);
    const brokenRuntimeKey = activeSessionKey(brokenBefore!);
    expect(new Set([sourceRuntimeKey, healthyRuntimeKey, brokenRuntimeKey]).size).toBe(3);

    const db = new DatabaseSync(join(mocks.dataDir, 'session-stores', appId, 'sessions.db'));
    try {
      const changed = db.prepare(
        'UPDATE principal_lane_worktrees SET branch = branch || ? '
        + 'WHERE source_session_id = ? AND lane_id = ?',
      ).run(
        '-tampered',
        sourceBefore!.session.sessionId,
        brokenBefore!.session.principalLane!.laneId,
      );
      expect(changed.changes).toBe(1);
    } finally {
      db.close();
    }

    activeSessions.clear();
    await restoreActiveSessions(activeSessions);

    expect(activeSessions.size).toBe(2);
    const sourceRestored = activeSessions.get(sourceRuntimeKey);
    const healthyRestored = activeSessions.get(healthyRuntimeKey);
    expect(sourceRestored?.session.sessionId).toBe(sourceBefore!.session.sessionId);
    expect(healthyRestored?.session.sessionId).toBe(healthyBefore!.session.sessionId);
    expect(activeSessions.get(brokenRuntimeKey)).toBeUndefined();
    expect(activeSessions.get(sessionKey(chatId, appId))).toBe(sourceRestored);
    expect(sourceRestored?.session.principalLane?.laneId).toBe('source');
    expect(healthyRestored?.session.principalLane?.principalKey).toBe('user:union:on_b');
    expect(activeSessionKey(sourceRestored!)).toBe(sourceRuntimeKey);
    expect(activeSessionKey(healthyRestored!)).toBe(healthyRuntimeKey);

    const sourcePersisted = sessionStore.getSession(sourceBefore!.session.sessionId);
    const healthyPersisted = sessionStore.getSession(healthyBefore!.session.sessionId);
    const brokenPersisted = sessionStore.getSession(brokenBefore!.session.sessionId);
    expect(sourcePersisted).toMatchObject({ status: 'active' });
    expect(healthyPersisted).toMatchObject({ status: 'active' });
    expect(sourcePersisted?.restoreQuarantinedAt).toBeUndefined();
    expect(healthyPersisted?.restoreQuarantinedAt).toBeUndefined();
    expect(brokenPersisted).toMatchObject({ status: 'active' });
    expect(brokenPersisted?.restoreQuarantinedAt).toBeTruthy();
    expect(brokenPersisted?.closedAt).toBeUndefined();
  }, 30_000);

  it('keeps a cross-ref identified peer bot on the explicit legacy routing path', async () => {
    const botOpenIdsFile = join(mocks.dataDir, `bot-openids-${appId}.json`);
    writeFileSync(botOpenIdsFile, JSON.stringify({ peer: 'ou_b' }));
    try {
      const data = message('b', 'om_peer_legacy', 'peer bot message');
      const ctx = context('om_peer_legacy');

      await __testOnly_dispatchHumanMessageViaHandlers(
        appId, handlers, { data, ctx, ownsSession: true }, 0,
      );

      expect(legacyReply).toHaveBeenCalledOnce();
      expect(legacyReply).toHaveBeenCalledWith(data, ctx);
      expect(laneByPrincipal('user:union:on_b')).toBeUndefined();
      expect(mocks.forkWorker).not.toHaveBeenCalled();
      expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    } finally {
      rmSync(botOpenIdsFile, { force: true });
    }
  });

  it('rejects a full lane FIFO with a specific not-accepted notice', async () => {
    await dispatch('a', 'om_full_a1', 'source active');
    await dispatch('c', 'om_full_c1', 'materialize C');
    const c = laneByPrincipal('user:union:on_c')!;
    c.session.principalLaneQueuedTurns = Array.from({ length: 128 }, (_, index) => ({
      version: 1 as const,
      turnId: `om_full_queued_${index}`,
      caller: {
        requestLarkAppId: appId,
        requestUserOpenId: 'ou_c',
        requestUserUnionId: 'on_c',
        senderType: 'user' as const,
      },
      userPrompt: `queued ${index}`,
      title: `queued ${index}`,
      cliInput: { content: `queued ${index}`, resources: [] },
      createdAt: new Date(index).toISOString(),
      resume: true,
      dispatchState: 'queued' as const,
    }));
    sessionStore.updateSession(c.session);
    mocks.replyMessage.mockClear();

    await dispatch('c', 'om_full_rejected', 'must not be admitted');

    expect(c.session.principalLaneQueuedTurns).toHaveLength(128);
    expect(c.session.principalLaneQueuedTurns?.some(
      turn => turn.turnId === 'om_full_rejected',
    )).toBe(false);
    expect(mocks.workerInputs.some(row => row.turnId === 'om_full_rejected')).toBe(false);
    expect(mocks.replyMessage).toHaveBeenCalledWith(
      appId,
      'om_full_rejected',
      expect.stringContaining('排队已满'),
      'text',
      false,
    );
    expect(String(mocks.replyMessage.mock.calls.at(-1)?.[2])).toContain('尚未接纳');
  });

  it('freezes the exact turn binding before an adopted lane worker can emit output', async () => {
    await dispatch('a', 'om_adopt_a1', 'source active');
    await dispatch('c', 'om_adopt_c1', 'materialize C');
    const c = laneByPrincipal('user:union:on_c')!;
    const firstGeneration = c.principalLaneRunningTurn!.workerGeneration;
    expect(onPrincipalLaneTurnTerminal(c, 'om_adopt_c1', firstGeneration)).toBe(false);
    c.activeInteractiveTurn = undefined;
    c.worker = null;
    c.adoptedFrom = { cwd: c.workingDir } as any;
    c.session.adoptedFrom = c.adoptedFrom;

    await dispatch('c', 'om_adopt_c2', 'adopted C turn');

    const binding = readPrincipalLaneTurnBinding(c, 'om_adopt_c2');
    expect(binding).toMatchObject({
      turnId: 'om_adopt_c2',
      workerGeneration: c.workerGeneration,
      sessionId: c.session.sessionId,
    });
    expect(sessionStore.readTrustedMessageProvenance('om_adopt_c2', sourceDs.session.sessionId))
      .toMatchObject({
        direction: 'inbound',
        turnId: 'om_adopt_c2',
        workerGeneration: c.workerGeneration,
      });
  });

  it('lets the production live handler decline and preserves the legacy call while disabled', async () => {
    process.env.BOTMUX_XPI_ENABLED = 'false';
    const data = message('b', 'om_legacy', 'legacy');
    const ctx = context('om_legacy');

    await __testOnly_dispatchHumanMessageViaHandlers(
      appId, handlers, { data, ctx, ownsSession: true }, 0,
    );

    expect(legacyReply).toHaveBeenCalledOnce();
    expect(legacyReply).toHaveBeenCalledWith(data, ctx);
    expect(legacyNewTopic).not.toHaveBeenCalled();
    expect(sessionStore.readPrincipalLaneSource(sourceDs.session.sessionId)).toBeUndefined();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });
});
