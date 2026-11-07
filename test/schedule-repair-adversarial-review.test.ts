/** Independent behavioral probes: real scheduler, daemon settlement, SQLite,
 * send receipts, and execution logs. No daemon is started and Lark is blocked. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isolated = vi.hoisted(() => {
  const root = `/tmp/botmux-schedule-adversarial-${process.pid}`;
  process.env.SESSION_DATA_DIR = `${root}/data`;
  process.env.BOTS_CONFIG = `${root}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return { root, dataDir: `${root}/data` };
});
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class FakeClient {} }));
vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  const refuse = () => { throw new Error('probe must never send a real message'); };
  return { ...actual, sendMessage: refuse, replyMessage: refuse };
});

import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { config } from '../src/config.js';
import { registerBot } from '../src/bot-registry.js';
import type { Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import * as scheduler from '../src/core/scheduler.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import * as runLogs from '../src/services/schedule-run-log-store.js';
import { ScheduleSendAttempt, recordScheduledSessionRun, settleScheduledSend } from '../src/core/scheduled-send.js';
import { assertScheduledAuthorityCurrent, isManualScheduledTurn, parseScheduledTurnId } from '../src/core/scheduled-turn-provenance.js';
import { authorizeDelegatedScheduleRun } from '../src/core/schedule-delegated-runtime.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';
import { __testOnly_scheduleDeferredScheduleSettlement as settleLater } from '../src/daemon.js';
import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';

const APP = 'adversarial_schedule_app';
const CHAT = 'oc_adversarial';
let store: ScheduleAuthorityStore;
let serial = 0;
const pending: (() => void)[] = [];
const turn = (id: string, n = 1) => `schedule:${id}:${String(n).padStart(8, '0')}-1234-1234-1234-123456789abc`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T01:00:00.000Z'));
  mkdirSync(isolated.dataDir, { recursive: true });
  config.session.dataDir = isolated.dataDir;
  scheduleStore.setScheduleScope(APP);
  store = ScheduleAuthorityStore.open(isolated.dataDir);
  store.initializeApp(APP, []);
  scheduler.setScheduleAuthorityStore(store);
  scheduler.setOwnerFilter(APP, true);
  registerBot({ larkAppId: APP, larkAppSecret: 'probe-secret', cliId: 'codex', allowedUsers: [] });
});
afterEach(async () => {
  scheduler.stopScheduler();
  for (const release of pending.splice(0)) release();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  scheduler.setScheduleAuthorityStore(null);
  store.close();
});
afterAll(() => rmSync(isolated.root, { recursive: true, force: true }));

function add(extra: Record<string, unknown> = {}) {
  return scheduler.addTask({ id: `probe${String(++serial).padStart(3, '0')}`, name: 'probe',
    schedule: 'every 1m', prompt: 'probe', workingDir: '/tmp', chatId: CHAT, larkAppId: APP, ...extra });
}
function session(): Session {
  return { sessionId: `probe-session-${++serial}`, larkAppId: APP, chatId: CHAT,
    rootMessageId: 'om_probe', scope: 'thread', status: 'active', cliId: 'codex' } as Session;
}
function daemonSession(s: Session): DaemonSession {
  return { session: s, larkAppId: APP, chatId: s.chatId, scope: 'thread', worker: null,
    workerPort: null, workerToken: null, lastScreenStatus: 'idle' } as DaemonSession;
}
async function dispatched(s: Session) {
  const task = add();
  let runId = '';
  scheduler.setExecuteCallback(async (_task, context) => { runId = context.runId; });
  expect(scheduler.runNow(task.id)).toEqual({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  const run = { taskId: task.id, runId, turnId: turn(task.id) };
  recordScheduledSessionRun(s, run);
  runLogs.appendScheduleRunLog({ id: runId, taskId: task.id, trigger: 'dashboard',
    outcome: 'model_dispatched', precondition: 'passed', startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), durationMs: 0, additionalPrompt: false }, APP);
  return run;
}
const logFor = (run: { taskId: string; runId: string }) =>
  runLogs.queryScheduleRunLogs(run.taskId, { limit: 100 }, APP).logs.find(row => row.id === run.runId);

function scheduledScreenWorker(s: Session) {
  const ds = daemonSession(s);
  const worker = new EventEmitter() as any;
  Object.assign(worker, { killed: false, pid: 99999, send: vi.fn(), kill: vi.fn(),
    stdout: new EventEmitter(), stderr: new EventEmitter() });
  Object.assign(ds, { worker, workerReady: true, lastMessageAt: Date.now(),
    workerGeneration: 1,
    suppressRecoveryCard: true,
    silentScheduledTurns: new Map(Object.keys(s.scheduledRuns ?? {}).map(id => [id, Date.now()])) });
  s.workerGeneration = 1;
  const settled = vi.fn((value, context) => settleLater(value, context));
  initWorkerPool({ sessionReply: async () => { throw new Error('probe must never reply'); },
    getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1,
    closeSession: vi.fn(), onDeferredScheduleTurnSettled: settled } as any);
  __testOnly_setupWorkerHandlers(ds, worker, { ready: true, failureNotified: false }, 1);
  return { ds, settled, frame: (turnId?: string, status = 'idle') =>
    worker.listeners('message')[0]({ type: 'screen_update', sessionId: s.sessionId,
      content: 'ready', status, ...(turnId ? { turnId } : {}) }) };
}

/** Executes the real otherwise-private daemon admission function; assertions
 * concern its side effects and authority result, never the source text. */
function daemonFunction(name: string, scope: Record<string, unknown>) {
  const source = ts.createSourceFile('daemon.ts', readFileSync(join(process.cwd(), 'src/daemon.ts'), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === name);
  if (!declaration) throw new Error(`Missing daemon function ${name}`);
  const code = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('scope', `with (scope) { ${code}; return ${name}; }`)(scope);
}

describe('schedule repair adversarial overlap probes', () => {
  it('preserves manual pause and invalidates its turn after a midway definition edit', async () => {
    const task = add({ repeat: { times: 1 } });
    scheduler.setEnabled(task.id, false);
    let runId = '';
    scheduler.setExecuteCallback(async (_task, context) => {
      runId = context.runId;
      await new Promise<void>(resolve => pending.push(resolve));
    });
    scheduler.runNow(task.id);
    await vi.advanceTimersByTimeAsync(0);
    const turnId = turn(task.id);
    expect(scheduler.admitManualRunTurn(task.id, runId, turnId, APP)).toBe(true);
    expect(isManualScheduledTurn(store.getRecord(APP, task.id)!.task, turnId)).toBe(true);
    scheduler.updateRuntimeTaskState(task.id, { prompt: 'human edited work' }, APP);
    expect(isManualScheduledTurn(store.getRecord(APP, task.id)!.task, turnId)).toBe(false);
    pending.pop()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getRecord(APP, task.id)).toMatchObject({ state: 'paused', task: { enabled: false } });
  });

  it('does not publish delegated identity when another pause revokes the manual permit during lookup', async () => {
    const id = `probe${String(++serial).padStart(3, '0')}`;
    const committed = scheduler.commitDelegatedTask({
      params: { id, name: 'delegated probe', schedule: 'every 1m', prompt: 'probe',
        workingDir: '/tmp', chatId: CHAT, larkAppId: APP },
      grantId: `grant-${id}`, requestHash: `hash-${id}`,
      control: { openId: 'ou_user', unionId: 'on_user', credentialOpenId: 'ou_source',
        runScopes: ['bytedcli'], selfManage: false },
      sourceMessageId: 'om_source', sourceSessionId: 'source-session', targetTurnId: 'om_source',
      targetGeneration: 1, maxTasksPerTurn: 64,
    });
    expect(committed.ok).toBe(true);
    scheduler.setEnabled(id, false);
    let runId = '';
    scheduler.setExecuteCallback(async (_task, context) => {
      runId = context.runId;
      await new Promise<void>(resolve => pending.push(resolve));
    });
    scheduler.runNow(id);
    await vi.advanceTimersByTimeAsync(0);
    const turnId = turn(id);
    expect(scheduler.admitManualRunTurn(id, runId, turnId, APP)).toBe(true);
    const publication = vi.fn(async () => undefined);
    const scope = { scheduleAuthorityStore: store, parseScheduledTurnId, authorizeDelegatedScheduleRun,
      assertScheduledAuthorityCurrent,
      identityPublicationConflicted: () => false, delegatedScheduleRuntimeDeps: () => ({
        runEnabled: true, hostRunScopes: ['bytedcli'], triggerUserAuthTools: ['bytedcli', 'lark-cli'],
        adminOpenIds: ['ou_user'],
        resolveTargetOpenId: () => new Promise<string>(resolve => setTimeout(() => resolve('ou_user'), 1_000)),
        listChatMemberOpenIds: async () => ['ou_user'],
      }), publishTurnCliIdentity: publication, getBot: () => ({ config: {} }), config,
      delegatedScheduleCliIdentity: () => ({ unionId: 'on_user' }), localeForBot: () => 'zh-CN',
      identityModelForPublication: () => 'single' };
    const prepare = daemonFunction('prepareDelegatedScheduledTurnIdentity', scope);
    const outcome = prepare(daemonSession(session()), turnId).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    scheduler.setEnabled(id, false);
    expect(store.getRecord(APP, id)?.task.manualRunAuthorization).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await outcome;
    expect(result).not.toBeInstanceOf(ReferenceError);
    expect(result).not.toBe(true);
    expect(publication).not.toHaveBeenCalled();
  });

  it('does not let a delivery rejection release a still-running callback to the next tick', async () => {
    const task = add();
    const contexts: scheduler.ScheduleExecutionContext[] = [];
    scheduler.setExecuteCallback(async (_task, context) => {
      contexts.push(context);
      await new Promise<void>(resolve => pending.push(resolve));
    });
    scheduler.startScheduler();
    scheduler.runNow(task.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts).toHaveLength(1);
    expect(store.getRecord(APP, task.id)?.task.lastStatus).toBe('running');
    scheduler.recordDeliveryFailure(task.id, contexts[0]!.runId, 'send rejected while dispatch awaited', APP);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(contexts).toHaveLength(1);
  });

  it('consumes the dispatched repeat exactly once when send rejection precedes callback return', async () => {
    const task = add({ repeat: { times: 1 } });
    scheduler.setExecuteCallback(async (_task, context) => {
      scheduler.recordDeliveryFailure(task.id, context.runId, 'very short turn rejected', APP);
    });
    scheduler.runNow(task.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getRecord(APP, task.id)?.task).toMatchObject({ enabled: false,
      lastStatus: 'error', repeat: { completed: 1 }, runStats: { dispatched: 1, failed: 1 } });
  });

  it('settles both turns when two tasks finish inside the same reused-session grace period', async () => {
    const s = session();
    const first = await dispatched(s);
    const second = await dispatched(s);
    new ScheduleSendAttempt(isolated.dataDir, s, first.turnId).fail(new Error('first turn rejected'));
    const ds = daemonSession(s);
    settleLater(ds, { turnId: first.turnId, source: 'terminal' });
    await vi.advanceTimersByTimeAsync(100);
    settleLater(ds, { turnId: second.turnId, source: 'terminal' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getRecord(APP, first.taskId)?.task.lastStatus).toBe('error');
    expect(logFor(first)?.outcome).toBe('error');
    expect(store.getRecord(APP, second.taskId)?.task.lastStatus).toBe('ok');
  });

  it('repairs a half-written settlement after transient execution-log failure without another terminal', async () => {
    const s = session();
    const run = await dispatched(s);
    new ScheduleSendAttempt(isolated.dataDir, s, run.turnId).fail(new Error('send rejected'));
    const mark = vi.spyOn(runLogs, 'markScheduleRunLogFailed')
      .mockImplementationOnce(() => { throw new Error('transient log disk failure'); });
    settleLater(daemonSession(s), { turnId: run.turnId, source: 'terminal' });
    await vi.advanceTimersByTimeAsync(300).catch(() => undefined);
    expect(store.getRecord(APP, run.taskId)?.task).toMatchObject({ lastStatus: 'error',
      runStats: { failed: 1 } });
    expect(logFor(run)?.outcome).toBe('model_dispatched');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mark.mock.calls.length).toBeGreaterThan(1);
    expect(logFor(run)?.outcome).toBe('error');
    expect(store.getRecord(APP, run.taskId)?.task.runStats?.failed).toBe(1);
  });

  it('lets a final receipt arriving inside the grace period suppress a prior failure', async () => {
    const s = session();
    const run = await dispatched(s);
    new ScheduleSendAttempt(isolated.dataDir, s, run.turnId).fail(new Error('first preflight rejected'));
    settleLater(daemonSession(s), { turnId: run.turnId, source: 'terminal' });
    await vi.advanceTimersByTimeAsync(100);
    await new TurnSendLedger(isolated.dataDir).execute({ larkAppId: APP,
      sessionId: s.sessionId, turnId: run.turnId }, 'final', 'later delivered', async () => 'om_receipt');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settleScheduledSend(isolated.dataDir, s, run.turnId)).toEqual({ state: 'delivered', messageId: 'om_receipt' });
    expect(store.getRecord(APP, run.taskId)?.task.lastStatus).toBe('ok');
    expect(logFor(run)?.outcome).toBe('model_dispatched');
  });

  it('prefers a late real receipt after an earlier settlement observed rejection', async () => {
    const s = session();
    const run = await dispatched(s);
    new ScheduleSendAttempt(isolated.dataDir, s, run.turnId).fail(new Error('initial attempt rejected'));
    let finishSend!: (messageId: string) => void;
    const receipt = new TurnSendLedger(isolated.dataDir).execute({ larkAppId: APP,
      sessionId: s.sessionId, turnId: run.turnId }, 'final', 'retry in progress',
    () => new Promise<string>(resolve => { finishSend = resolve; }), { fenced: true });
    await vi.advanceTimersByTimeAsync(0);
    const ds = daemonSession(s);
    settleLater(ds, { turnId: run.turnId, source: 'terminal' });
    await vi.advanceTimersByTimeAsync(1_000);
    finishSend('om_late_receipt');
    await receipt;
    expect(settleScheduledSend(isolated.dataDir, s, run.turnId)).toEqual({
      state: 'delivered', messageId: 'om_late_receipt' });
    settleLater(ds, { turnId: run.turnId, source: 'terminal' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getRecord(APP, run.taskId)?.task.lastStatus).toBe('ok');
    expect(logFor(run)?.outcome).toBe('model_dispatched');
  });

  it('keeps another target failure and a human pause while late receipts reconcile a multi-chat run', async () => {
    const otherChat = 'oc_adversarial_other';
    const task = add({ chatIds: [CHAT, otherChat], repeat: { times: 5 } });
    let runId = '';
    scheduler.setExecuteCallback(async (_task, context) => { runId = context.runId; });
    scheduler.runNow(task.id);
    await vi.advanceTimersByTimeAsync(0);
    const firstSession = session();
    const secondSession = { ...session(), chatId: otherChat };
    const first = { taskId: task.id, runId, turnId: turn(task.id, 1) };
    const second = { taskId: task.id, runId, turnId: turn(task.id, 2) };
    recordScheduledSessionRun(firstSession, first);
    recordScheduledSessionRun(secondSession, second);
    runLogs.appendScheduleRunLog({ id: runId, taskId: task.id, trigger: 'dashboard',
      outcome: 'model_dispatched', precondition: 'passed', startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), durationMs: 0, additionalPrompt: false,
      targetResults: [{ chatId: CHAT, outcome: 'model_dispatched' },
        { chatId: otherChat, outcome: 'model_dispatched' }] }, APP);
    for (const [s, run] of [[firstSession, first], [secondSession, second]] as const) {
      new ScheduleSendAttempt(isolated.dataDir, s, run.turnId).fail(new Error(`send rejected ${s.chatId}`));
      settleLater(daemonSession(s), { turnId: run.turnId, source: 'terminal' });
    }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getRecord(APP, task.id)?.task.runStats?.failed).toBe(1);
    scheduler.setEnabled(task.id, false);
    const deliver = async (s: Session, run: typeof first) => {
      await new TurnSendLedger(isolated.dataDir).execute({ larkAppId: APP, sessionId: s.sessionId,
        turnId: run.turnId }, 'final', 'late receipt', async () => `om_${s.chatId}`);
      settleLater(daemonSession(s), { turnId: run.turnId, source: 'terminal' });
      await vi.advanceTimersByTimeAsync(2_000);
    };
    await deliver(firstSession, first);
    expect(store.getRecord(APP, task.id)?.task).toMatchObject({ enabled: false, lastStatus: 'error',
      runStats: { failed: 1 }, repeat: { completed: 1 } });
    expect(logFor(first)).toMatchObject({ outcome: 'error', targetResults: [
      { chatId: CHAT, outcome: 'model_dispatched' }, { chatId: otherChat, outcome: 'error' }] });
    await deliver(secondSession, second);
    expect(store.getRecord(APP, task.id)?.task).toMatchObject({ enabled: false, lastStatus: 'ok',
      runStats: { failed: 0, dispatched: 1 }, repeat: { completed: 1 } });
    expect(logFor(first)?.outcome).toBe('model_dispatched');
  });

  it('retries the success half-write when a late receipt finds its execution-log row temporarily unavailable', async () => {
    const s = session();
    const run = await dispatched(s);
    const ds = daemonSession(s);
    new ScheduleSendAttempt(isolated.dataDir, s, run.turnId).fail(new Error('first rejected'));
    settleLater(ds, { turnId: run.turnId, source: 'terminal' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(logFor(run)?.outcome).toBe('error');
    await new TurnSendLedger(isolated.dataDir).execute({ larkAppId: APP, sessionId: s.sessionId,
      turnId: run.turnId }, 'final', 'late receipt', async () => 'om_reconciled');
    const path = runLogs.scheduleRunLogPath(run.taskId, APP);
    renameSync(path, `${path}.temporarily-unavailable`);
    settleLater(ds, { turnId: run.turnId, source: 'terminal' });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getRecord(APP, run.taskId)?.task.lastStatus).toBe('ok');
    renameSync(`${path}.temporarily-unavailable`, path);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logFor(run)?.outcome).toBe('model_dispatched');
    expect(store.getRecord(APP, run.taskId)?.task.runStats?.failed).toBe(0);
  });

  it('reconciles the exact screen-only send failure when another turn starts during idle grace', async () => {
    const s = session();
    const run = await dispatched(s);
    new ScheduleSendAttempt(isolated.dataDir, s, run.turnId).fail(new Error('screen-only send rejected'));
    const ds = daemonSession(s);
    settleLater(ds, { turnId: run.turnId, source: 'idle' });
    await vi.advanceTimersByTimeAsync(500);
    ds.lastScreenStatus = 'working';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getRecord(APP, run.taskId)?.task.lastStatus).toBe('error');
    expect(logFor(run)?.outcome).toBe('error');
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('reconciles retained delivery from a first already-idle IPC frame despite repeated snapshots', async () => {
    const s = session();
    const run = await dispatched(s);
    new ScheduleSendAttempt(isolated.dataDir, s, run.turnId).fail(new Error('retained failure'));
    const { frame, settled } = scheduledScreenWorker(s);
    for (let n = 0; n < 10; n++) {
      await frame(run.turnId);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(settled).toHaveBeenCalledTimes(1);
    expect(store.getRecord(APP, run.taskId)?.task.lastStatus).toBe('error');
    expect(logFor(run)?.outcome).toBe('error');
    await new TurnSendLedger(isolated.dataDir).execute({ larkAppId: APP, sessionId: s.sessionId,
      turnId: run.turnId }, 'final', 'renewed work delivered', async () => 'om_renewed_work');
    await frame(run.turnId, 'working');
    await frame(run.turnId);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toHaveBeenCalledTimes(2);
    expect(store.getRecord(APP, run.taskId)?.task.lastStatus).toBe('ok');
    expect(logFor(run)?.outcome).toBe('model_dispatched');
  });

  it('keeps hidden capture retirement fallback while reconciling delivery before busy cleanup', async () => {
    const s = session();
    const run = await dispatched(s);
    s.deferredScheduleRun = { ...run, routingAnchor: s.rootMessageId,
      createdAt: new Date().toISOString() };
    new ScheduleSendAttempt(isolated.dataDir, s, run.turnId).fail(new Error('hidden failure'));
    const { frame, ds, settled } = scheduledScreenWorker(s);
    await frame();
    await vi.advanceTimersByTimeAsync(500);
    await frame();
    await frame(undefined, 'working');
    await vi.advanceTimersByTimeAsync(1_200);
    expect(settled).toHaveBeenCalledExactlyOnceWith(ds, { turnId: run.turnId, source: 'idle' });
    expect(store.getRecord(APP, run.taskId)?.task.lastStatus).toBe('error');
    expect(logFor(run)?.outcome).toBe('error');
    expect(ds.lastScreenStatus).toBe('working');
    expect(s.status).toBe('active');
  });

  it('does not borrow a retained scheduled mapping for an unattributed ordinary IPC frame', async () => {
    const s = session();
    const run = await dispatched(s);
    new ScheduleSendAttempt(isolated.dataDir, s, run.turnId).fail(new Error('prior failure'));
    const { frame, ds, settled } = scheduledScreenWorker(s);
    ds.currentTurnId = run.turnId;
    await frame();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).not.toHaveBeenCalled();
    expect(store.getRecord(APP, run.taskId)?.task.lastStatus).toBe('ok');
  });

  it('does not postpone two exact retained deliveries when their idle snapshots interleave', async () => {
    const s = session();
    const first = await dispatched(s);
    const second = await dispatched(s);
    new ScheduleSendAttempt(isolated.dataDir, s, first.turnId).fail(new Error('first failure'));
    new ScheduleSendAttempt(isolated.dataDir, s, second.turnId).fail(new Error('second failure'));
    const { frame, settled } = scheduledScreenWorker(s);
    for (let n = 0; n < 12; n++) {
      await frame(n % 2 === 0 ? first.turnId : second.turnId);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect.soft(store.getRecord(APP, first.taskId)?.task.lastStatus).toBe('error');
    expect.soft(store.getRecord(APP, second.taskId)?.task.lastStatus).toBe('error');
    expect.soft(logFor(first)?.outcome).toBe('error');
    expect.soft(logFor(second)?.outcome).toBe('error');
    expect(settled).toHaveBeenCalledTimes(2);
  });
});
