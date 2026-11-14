import { beforeEach, afterEach, describe, it, vi, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../src/utils/logger.js';
import { config } from '../src/config.js';
import * as pool from '../src/core/worker-pool.js';
import * as bots from '../src/bot-registry.js';
import * as selfSpawn from '../src/core/self-spawn.js';
import * as workerBudget from '../src/core/worker-budget.js';
import * as store from '../src/services/session-store.js';
import { captureTitleBootstrap, updateSessionTitle, buildBotmuxLarkNativeSessionTitle } from '../src/core/session-title.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

// Exercise the real pool and SQLite store. Only the child process transport,
// host pressure measurement and semantic generator are controlled dependencies.
const APP = 'cli_session_title_delivery_test';
const seed = '你是本群的 oncall 协同助手。入群后先阅读群内可见的最近消息、卡片和转发内容，只做只读总结。';
let bot: ReturnType<typeof bots.getBot>;
let originalDir: string;
let dataDir: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
  originalDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'session-title-delivery-'));
  config.session.dataDir = dataDir;
  for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(() => undefined);
  bot = {
    config: { larkAppId: APP, larkAppSecret: 'fixture-only', cliId: 'codex', autoStartOnGroupJoinPrompt: seed },
    botName: 'TitleBot', resolvedAllowedUsers: [],
  } as ReturnType<typeof bots.getBot>;
  vi.spyOn(bots, 'getBot').mockImplementation(() => bot);
  // Host pressure is an unrelated fork admission dependency. Keep its actual
  // policy evaluator and give it a controlled, healthy host measurement.
  vi.spyOn(workerBudget, 'checkWorkerAdmission').mockImplementation(cfg => workerBudget.evaluateWorkerAdmission({
    totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 12 * 1024 ** 3, memoryFullAvg10: 0,
    totalMemorySource: 'host', availableMemorySource: 'host', memoryFullAvg10Source: 'host', warnings: [],
  }, cfg));
  store.init(APP);
  pool.__testOnly_resetOrdinaryImDeliveries();
  pool.initWorkerPool({
    sessionReply: vi.fn(async () => 'om_title_reply'),
    getSessionWorkingDir: () => config.session.dataDir,
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

afterEach(() => {
  store.__testOnly_setBeforeRowPersist(undefined);
  pool.__testOnly_resetOrdinaryImDeliveries();
  store.init(APP); // Close the test's SQLite handle before removing its directory.
  config.session.dataDir = originalDir;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function resident(cli: 'codex' | 'claude-code' = 'codex') {
  bot.config.cliId = cli;
  const session = store.createSession('oc_probe_group', 'om_probe_root', '支持群', 'group', 'thread', { source: 'external' });
  Object.assign(session, { cliId: cli, workerGeneration: 1, nativeSessionTitle: '[BotMux·Lark] 支持群', nativeSessionTitleAwaitingContent: true, automaticTitleBootstrap: captureTitleBootstrap(seed), titleSource: 'initial', chatDisplayName: '支持群' });
  store.updateSession(session);
  const worker: any = new EventEmitter();
  Object.assign(worker, { killed: false, connected: true, pid: process.pid, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(), send: vi.fn(() => true) });
  const ds: any = { session, larkAppId: APP, chatId: session.chatId, chatType: 'group', scope: 'thread', worker, workerGeneration: 1, initConfig: { type: 'init', cliId: cli, backendType: 'tmux', nativeSessionTitle: session.nativeSessionTitle }, spawnedAt: Date.now(), lastMessageAt: Date.now(), hasHistory: true };
  return { ds, worker };
}
function disk(ds: any) { return store.readSessionRowFromDisk(ds.session.sessionId, APP)!; }
function reboot(ds: any) {
  store.init(APP);
  ds.session = store.getSession(ds.session.sessionId)!;
  ds.initConfig = { type: 'init', cliId: ds.session.cliId, backendType: 'tmux', nativeSessionTitle: ds.session.nativeSessionTitle };
}
function nativeHandler(ds: any, worker: any) {
  pool.__testOnly_setupWorkerHandlers(ds, worker, undefined, ds.workerGeneration);
  return async (message: any) => { await Promise.all(worker.listeners('message').map(listener => listener(message))); };
}

function beginBootstrapActivation(ds: any, token: string, turnId: string): void {
  Object.assign(ds.session, {
    queuedActivationPending: true, queuedActivationToken: token,
    queuedActivationInput: { content: seed }, queuedActivationTurnId: turnId,
  });
  ds.initialStartPending = true;
  store.updateSession(ds.session);
}

/** Execute the production ACK case and journal functions without spawning a daemon. */
function activationAck(ds: any, worker: any) {
  const scope: Record<string, any> = {
    ds, worker, t: 'title-delivery', logger, sessionStore: store,
    cb: {
      onQueuedActivationSubmitted: () => {
        if (!ds.session.queuedActivationTail?.length && !ds.session.queuedActivationPending) {
          ds.initialStartPending = false;
          return true;
        }
        return pool.promoteQueuedActivationTail(ds);
      },
    },
  };
  for (const name of ['snapshotQueuedActivationJournal', 'clearQueuedActivationJournal', 'restoreQueuedActivationJournal']) {
    scope[name] = loadWorkerPoolFunction(name, scope);
  }
  return loadWorkerPoolMessageHandlers(['queued_activation_submitted'], scope, true);
}

describe('automatic session titles at input delivery boundaries', () => {
  it('recovers a failed promoted title and activation commit without losing the first question or duplicating IPC', async () => {
    const { ds, worker } = resident();
    beginBootstrapActivation(ds, 'bootstrap-retry-token', 'om_bootstrap_retry');
    expect(pool.sendWorkerInput(ds, '持久化重试后的首条问题 rule 123', 'om_promote_retry')).toBe(true);
    const ack = activationAck(ds, worker);
    let commits = 0;
    store.__testOnly_setBeforeRowPersist(() => { commits++; if (commits >= 2) throw new Error('injected EIO on promoted title+journal'); });
    await ack({ type: 'queued_activation_submitted', sessionId: ds.session.sessionId, activationToken: 'bootstrap-retry-token' });
    const failed = disk(ds);
    expect(failed.title).toBe('支持群');
    expect(failed.nativeSessionTitleAwaitingContent).toBe(true);
    expect(failed.queuedActivationTail).toHaveLength(1);
    expect(worker.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(pool.promoteQueuedActivationTail(ds)).toBe(false);
    expect(worker.send).not.toHaveBeenCalled();
    store.__testOnly_setBeforeRowPersist(undefined);
    await vi.advanceTimersByTimeAsync(50);
    const sent = worker.send.mock.calls.at(-1)?.[0];
    expect(sent?.content).toBe('持久化重试后的首条问题 rule 123');
    expect(worker.send).toHaveBeenCalledTimes(1);
    const promoted = disk(ds);
    expect(promoted.title).toBe('持久化重试后的首条问题 rule 123');
    expect(promoted.nativeSessionTitleAwaitingContent).toBeUndefined();
    await ack({ type: 'queued_activation_submitted', sessionId: ds.session.sessionId, activationToken: ds.session.queuedActivationToken });
    reboot(ds);
    expect(disk(ds).title).toBe('持久化重试后的首条问题 rule 123');
    expect(worker.send).toHaveBeenCalledTimes(1);
  });
  it.each(['codex', 'claude-code'] as const)('observes first meaningful %s input on a cold resume fork with title generation unavailable', async cli => {
    const { ds, worker } = resident(cli);
    // The worker is fake; use an existing portable executable only to satisfy
    // the real adapter's launch-path validation.
    bot.config.cliPathOverride = process.execPath;
    bot.config.apiOnly = true;
    ds.session.cliPathOverride = process.execPath;
    ds.session.cliSessionId = 'native_probe_thread';
    ds.session.workingDir = config.session.dataDir;
    store.updateSession(ds.session);
    reboot(ds);
    ds.worker = null;
    Object.assign(worker, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(), send: vi.fn(() => true) });
    const capturedSend = worker.send;
    vi.spyOn(selfSpawn, 'spawnWorker').mockReturnValue(worker);
    let admission: string | undefined;
    expect(pool.forkWorker(ds, '冷恢复后的首条问题 rule 123',
      { resume: true, turnId: 'title-cold-first' },
      { onAdmission: value => { admission = value; } })).toBe(true);
    const sentInit = capturedSend.mock.calls.map(call => call[0]).find(message => message.type === 'init');
    const afterFork = disk(ds);
    const workerTitleEvents: any[] = [];
    if (cli === 'codex') {
      let generationStarted!: () => void;
      const generationReady = new Promise<void>(resolve => { generationStarted = resolve; });
      // Execute the actual worker title-sync component. Only native transport
      // and semantic generation are controlled dependencies; generation fails
      // after its real 30s timeout window, so no canonical-fixing event arrives.
      const titleScope: any = { lastInitConfig: sentInit, nativeSessionTitleAppliedThreadId: undefined,
        nativeSessionTitleSyncInFlight: undefined, nativeSessionTitleRevision: 1,
        nativeSessionTitleCurrentGenerationResume: true, nativeSessionTitleSyncAbortControllers: new Set(),
        applyCodexNativeSessionTitle: vi.fn(async () => true), createCliAdapterSync: () => ({ resolvedBin: process.execPath }),
        codexNativeTitleEnv: () => ({}), registerNativeTitleForceClose() {},
        generateCodexAppThreadTitle: async () => { generationStarted(); await new Promise(resolve => setTimeout(resolve, 30000)); return undefined; },
        buildBotmuxLarkNativeSessionTitle, send: message => workerTitleEvents.push(message), log() {} };
      const syncTitle = loadWorkerFunction('syncFreshCodexNativeSessionTitle', titleScope);
      const done = syncTitle('native_probe_thread');
      await generationReady;
      await vi.advanceTimersByTimeAsync(31000);
      await done;
      expect(titleScope.applyCodexNativeSessionTitle).toHaveBeenCalled();
      expect(workerTitleEvents).toEqual([]);
    } else vi.advanceTimersByTime(31000);
    reboot(ds);
    expect(admission).toBe('accepted');
    expect(sentInit?.prompt).toBe('冷恢复后的首条问题 rule 123');
    expect(afterFork.title).toBe('冷恢复后的首条问题 rule 123');
    expect(afterFork.nativeSessionTitleAwaitingContent).toBeUndefined();
    expect(disk(ds).title).toBe('冷恢复后的首条问题 rule 123');
  });
  it.each(['codex', 'claude-code'] as const)('keeps the first meaningful %s title when queued input is promoted and acknowledged', async cli => {
    const { ds, worker } = resident(cli);
    beginBootstrapActivation(ds, 'bootstrap-token', 'om_bootstrap');
    expect(pool.sendWorkerInput(ds, '第一条实际问题 rule 123', 'om_first_question')).toBe(true);
    expect(worker.send).not.toHaveBeenCalled();
    expect(disk(ds).title).toBe('支持群');
    const ack = activationAck(ds, worker);
    vi.advanceTimersByTime(1000);
    await ack({ type: 'queued_activation_submitted', sessionId: ds.session.sessionId, activationToken: 'bootstrap-token' });
    const sent = worker.send.mock.calls.at(-1)?.[0];
    const afterPromotion = disk(ds);
    const promotedToken = ds.session.queuedActivationToken;
    vi.advanceTimersByTime(1000);
    await ack({ type: 'queued_activation_submitted', sessionId: ds.session.sessionId, activationToken: promotedToken });
    reboot(ds);
    expect(sent.content).toBe('第一条实际问题 rule 123');
    if (cli === 'codex') {
      expect(sent.nativeSessionTitle).toBe('[BotMux·Lark] 第一条实际问题 rule 123');
      expect(sent.nativeSessionTitlePrompt).toBe('第一条实际问题 rule 123');
    }
    expect(afterPromotion.title).toBe('第一条实际问题 rule 123');
    expect(afterPromotion.nativeSessionTitleAwaitingContent).toBeUndefined();
    expect(disk(ds).title).toBe('第一条实际问题 rule 123');
    vi.advanceTimersByTime(1000);
    expect(pool.sendWorkerInput(ds, '第二条实际问题 rule 456', 'om_second_question')).toBe(true);
    expect(disk(ds).title).toBe('第一条实际问题 rule 123');
  });
  it('does not consume the first meaningful title when IPC rejects the input', () => {
    const { ds, worker } = resident();
    worker.send.mockImplementation(() => { throw new Error('injected IPC disconnected'); });
    // A dispatchAttempt-bearing delivery uses the real refusal path; an
    // ordinary tracked turn intentionally accepts a retry owner on IPC throw.
    const accepted = pool.sendWorkerInput(ds, '被拒绝的问题 rule 123', 'om_rejected', { dispatchAttempt: 1 });
    const afterRejected = disk(ds);
    reboot(ds);
    worker.send.mockImplementation(() => true);
    vi.advanceTimersByTime(1000);
    const laterAccepted = pool.sendWorkerInput(ds, '真正接受的问题 rule 456', 'om_accepted');
    expect(accepted).toBe(false);
    expect(afterRejected.title).toBe('支持群');
    expect(afterRejected.nativeSessionTitleAwaitingContent).toBe(true);
    expect(laterAccepted).toBe(true);
    expect(disk(ds).title).toBe('真正接受的问题 rule 456');
  });
  it('keeps accepted IPC owned when title persistence fails, then commits after restart', () => {
    const { ds, worker } = resident();
    store.__testOnly_setBeforeRowPersist(() => { throw new Error('injected EIO before title row commit'); });
    expect(pool.sendWorkerInput(ds, '未提交的问题 rule 123', 'om_eio')).toBe(true);
    const afterEio = { row: disk(ds), memory: structuredClone(ds.session), launch: structuredClone(ds.initConfig), sends: worker.send.mock.calls.length };
    store.__testOnly_setBeforeRowPersist(undefined);
    reboot(ds);
    vi.advanceTimersByTime(1000);
    expect(pool.sendWorkerInput(ds, '重试成功的问题 rule 456', 'om_after_eio')).toBe(true);
    expect(afterEio.row.title).toBe('支持群');
    expect(afterEio.memory.title).toBe('支持群');
    expect(afterEio.row.nativeSessionTitleAwaitingContent).toBe(true);
    expect(afterEio.launch.nativeSessionTitle).toBe('[BotMux·Lark] 支持群');
    expect(afterEio.launch.nativeSessionTitlePrompt).toBeUndefined();
    expect(afterEio.sends).toBe(1);
    expect(disk(ds).title).toBe('重试成功的问题 rule 456');
  });
  it.each(['user', 'dashboard', 'agent'] as const)('preserves %s rename while a late native result overlaps the next turn and restart', async source => {
    const { ds, worker } = resident();
    expect(pool.sendWorkerInput(ds, '自动问题 rule 123', 'om_auto')).toBe(true);
    const handler = nativeHandler(ds, worker);
    setTimeout(() => handler({ type: 'native_session_title_generated', title: '[BotMux·Lark] 迟到自动结果' }), 30000);
    vi.advanceTimersByTime(1000);
    updateSessionTitle(ds.session, '人工指定的标题', source);
    vi.advanceTimersByTime(1000);
    expect(pool.sendWorkerInput(ds, '下一轮 rule 456', 'om_next')).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    reboot(ds);
    expect(disk(ds).title).toBe('人工指定的标题');
    expect(disk(ds).nativeSessionTitle).toBe('人工指定的标题');
  });
  it('preserves current worker result against a replaced worker result overlapping the next turn', async () => {
    const { ds, worker } = resident();
    expect(pool.sendWorkerInput(ds, '首条实际问题 rule 123', 'om_initial')).toBe(true);
    const oldHandler = nativeHandler(ds, worker);
    setTimeout(() => oldHandler({ type: 'native_session_title_generated', title: '[BotMux·Lark] 旧worker迟到结果' }), 30000);
    vi.advanceTimersByTime(1000);
    const currentWorker: any = new EventEmitter();
    Object.assign(currentWorker, { killed: false, connected: true, pid: process.pid, send: vi.fn(() => true) });
    ds.worker = currentWorker;
    ds.workerGeneration = 2;
    ds.session.workerGeneration = 2;
    store.updateSession(ds.session);
    const currentHandler = nativeHandler(ds, currentWorker);
    expect(pool.sendWorkerInput(ds, '下一轮问题 rule 456', 'om_after_replacement')).toBe(true);
    setTimeout(() => currentHandler({ type: 'native_session_title_generated', title: '[BotMux·Lark] 当前worker摘要' }), 1000);
    await vi.advanceTimersByTimeAsync(30000);
    reboot(ds);
    expect(disk(ds).title).toBe('当前worker摘要');
    expect(disk(ds).nativeSessionTitle).toBe('[BotMux·Lark] 当前worker摘要');
  });
  it('keeps bootstrap replay pending after configuration changes, restart and next turn', () => {
    const { ds } = resident('claude-code');
    bot.config.cliId = 'claude-code';
    bot.config.autoStartOnGroupJoinPrompt = 'new group instructions';
    reboot(ds);
    vi.advanceTimersByTime(1000);
    expect(pool.sendWorkerInput(ds, seed, 'om_replay')).toBe(true);
    expect(disk(ds).nativeSessionTitleAwaitingContent).toBe(true);
    expect(disk(ds).title).toBe('支持群');
    vi.advanceTimersByTime(1000);
    expect(pool.sendWorkerInput(ds, seed + '\n排查 rule 456 的失败', 'om_question')).toBe(true);
    expect(disk(ds).title).toBe('排查 rule 456 的失败');
  });
});
