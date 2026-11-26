/**
 * Deferred scheduler runs: a claimed run that cannot dispatch because a managed
 * TRAE runtime handoff is in progress is parked as a WAITING state, not a run
 * outcome. These tests drive the real authority store and the scheduler's
 * public helpers with a callback that mirrors the daemon's runTargets contract.
 *
 * Invariants under test:
 *  - parking never records success, repeat/once completion, or a finished run;
 *  - a retry reuses the same runId and never replays a dispatched target;
 *  - a `dispatching` target becomes `ambiguous` on restart and is not replayed;
 *  - the parked state survives a store close/reopen (real disk);
 *  - a terminal settlement clears the parked run so the retry clock cannot
 *    account the same logical run twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import type { ScheduleExecutionContext } from '../src/core/scheduler.js';
import type { ScheduledTask } from '../src/types.js';
import * as scheduler from '../src/core/scheduler.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import { queryScheduleRunLogs } from '../src/services/schedule-run-log-store.js';
import { settleHeldScheduleRunsOnWorkerExit, cancelPreReadyScheduledWorkers, retryCancelledActivationPersistence, releaseCancelledActivationWork } from '../src/core/deferred-schedule-settlement.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { untilDoneDeadlineDue } from '../src/services/schedule-until-done.js';

const APP = 'cli_deferred_test';

let dataDir: string;
let store: ScheduleAuthorityStore;

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'scheduler-deferred-')), 'data');
  config.session.dataDir = dataDir;
  scheduleStore.setScheduleScope(APP);
  store = ScheduleAuthorityStore.open(dataDir);
  store.initializeApp(APP, []);
  scheduler.setScheduleAuthorityStore(store);
  scheduler.setOwnerFilter(APP, true);
});

afterEach(() => {
  scheduler.stopScheduler();
  scheduler.setScheduleFailureAlert(null);
  scheduler.setParkedRunCancellationHandler(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  scheduler.setScheduleAuthorityStore(null);
  store.close();
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

type DispatchAction = 'dispatch' | 'defer';

interface TargetCall {
  runId: string;
  chatId: string;
  turnId: string;
}

/**
 * A faithful-enough copy of the daemon's `runTargets` contract:
 *  - `dispatched` targets are never re-sent;
 *  - `ambiguous` targets refuse automatic replay (throw);
 *  - otherwise persist `dispatching`, then either dispatch or defer.
 */
function makeDaemonCallback(options: {
  action: (chatId: string, attempt: number) => DispatchAction;
}) {
  const calls: TargetCall[] = [];
  let attempt = 0;
  const callback = async (task: ScheduledTask, context: ScheduleExecutionContext): Promise<'executed' | 'deferred'> => {
    const current = scheduler.getRuntimeTask(task.id, APP);
    const parked = current?.deferredRun && current.deferredRun.runId === context.runId
      ? current.deferredRun
      : undefined;
    const chatIds = scheduleStore.effectiveScheduleChatIds(task);
    const usedTurnIds = new Map<string, string>();
    const outcomes: Array<{ chatId: string; outcome: 'dispatched' | 'deferred' }> = [];
    attempt += 1;
    for (const chatId of chatIds) {
      const state = parked?.targets[chatId];
      if (state === 'ambiguous') {
        throw new Error(`ambiguous target ${chatId} must not be replayed`);
      }
      const turnId = parked?.targetTurnIds?.[chatId] ?? `schedule:${task.id}:${randomUUID()}`;
      usedTurnIds.set(chatId, turnId);
      if (state === 'dispatched') {
        // Production's non-TRAE daemon marks fork acceptance immediately.
        scheduler.markDeferredTargetAccepted(task.id, context.runId, chatId, turnId, APP);
        outcomes.push({ chatId, outcome: 'dispatched' });
        continue;
      }
      // No parked run yet on a fresh claim: this is a no-op by design.
      scheduler.markDeferredTargetDispatching(task.id, context.runId, chatId, turnId, APP);
      if (options.action(chatId, attempt) === 'defer') {
        outcomes.push({ chatId, outcome: 'deferred' });
        continue;
      }
      calls.push({ runId: context.runId, chatId, turnId });
      scheduler.markDeferredTargetAccepted(task.id, context.runId, chatId, turnId, APP);
      outcomes.push({ chatId, outcome: 'dispatched' });
    }
    if (!outcomes.some(entry => entry.outcome === 'deferred')) return 'executed';
    const targets: Record<string, 'waiting' | 'dispatched'> = {};
    const targetTurnIds: Record<string, string> = {};
    for (const chatId of chatIds) {
      const outcome = outcomes.find(entry => entry.chatId === chatId)!;
      targets[chatId] = outcome.outcome === 'deferred' ? 'waiting' : 'dispatched';
      targetTurnIds[chatId] = usedTurnIds.get(chatId)!;
    }
    scheduler.parkDeferredRun(task.id, context, {
      runId: context.runId,
      detail: `test handoff: ${Object.values(targets).filter(s => s === 'waiting').length} waiting`,
      additionalPrompt: 'extra-context',
      precondition: 'passed',
      targets,
      targetTurnIds,
    });
    return 'deferred';
  };
  return { callback, calls };
}

function addTwoTargetTask() {
  return scheduler.addTask({
    id: 'defer001',
    name: 'two targets',
    schedule: 'every 30m',
    prompt: 'check',
    workingDir: '/repo',
    chatId: 'oc_a',
    chatIds: ['oc_a', 'oc_b'],
    larkAppId: APP,
    owner: { kind: 'human', openId: 'ou_deferred_test' },
    repeat: { times: 3, completed: 0 },
  });
}

describe('deferred scheduled run lifecycle', () => {
  it('parks the claimed run without recording success, repeat completion or a run', async () => {
    const task = addTwoTargetTask();
    const { callback, calls } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);

    expect(scheduler.runNow(task.id)).toEqual({ ok: true });
    await flush();

    const parked = scheduler.getRuntimeTask(task.id, APP)!;
    expect(calls).toHaveLength(0);
    expect(parked.lastStatus).toBe('deferred');
    expect(parked.deferredRun).toMatchObject({
      reason: 'traex_runtime',
      additionalPrompt: 'extra-context',
      precondition: 'passed',
      targets: { oc_a: 'waiting', oc_b: 'waiting' },
    });
    expect(parked.deferredRun!.runId).toBe(parked.lastRunId);
    expect(Object.keys(parked.deferredRun!.targetTurnIds ?? {}).sort()).toEqual(['oc_a', 'oc_b']);
    // A waiting run must not look completed.
    expect(parked.repeat?.completed).toBe(0);
    expect(parked.lastError).toBeUndefined();
    expect(parked.runStats?.dispatched ?? 0).toBe(0);
    expect(parked.nextRunAt).toBeDefined();
  });

  it('retries with the same runId, never replays a dispatched target, then settles once', async () => {
    const task = addTwoTargetTask();
    let first = true;
    const { callback, calls } = makeDaemonCallback({
      action: chatId => {
        if (first) return chatId === 'oc_b' ? 'defer' : 'dispatch';
        return 'dispatch';
      },
    });
    scheduler.setExecuteCallback(callback);

    scheduler.runNow(task.id);
    await flush();
    first = false;

    const afterFirst = scheduler.getRuntimeTask(task.id, APP)!;
    const runId = afterFirst.lastRunId!;
    expect(afterFirst.deferredRun!.targets).toEqual({ oc_a: 'dispatched', oc_b: 'waiting' });
    expect(calls.map(call => call.chatId)).toEqual(['oc_a']);
    const persistedTurnId = afterFirst.deferredRun!.targetTurnIds!.oc_b;

    // Retry the same parked run through the dashboard path.
    expect(scheduler.runNow(task.id)).toEqual({ ok: true });
    await flush();

    // oc_a was dispatched once, oc_b once, both under the same runId.
    expect(calls.map(call => call.chatId)).toEqual(['oc_a', 'oc_b']);
    expect(new Set(calls.map(call => call.runId))).toEqual(new Set([runId]));
    expect(calls.find(call => call.chatId === 'oc_b')!.turnId).toBe(persistedTurnId);

    const settled = scheduler.getRuntimeTask(task.id, APP)!;
    expect(settled.lastStatus).toBe('ok');
    expect(settled.deferredRun).toBeUndefined();
    expect(settled.repeat?.completed).toBe(1);

    // A settled run leaves no parked state. A later runNow is a NEW occurrence
    // with a new runId, never a replay of the settled one.
    expect(scheduler.runNow(task.id)).toEqual({ ok: true });
    await flush();
    expect(calls).toHaveLength(4);
    expect(calls.slice(2).every(call => call.runId !== runId)).toBe(true);
  });

  it('marks an in-flight target ambiguous on restart and refuses automatic replay', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();

    const runId = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!.runId;
    // Simulate a crash after `dispatching` was persisted but before the outcome.
    expect(scheduler.markDeferredTargetDispatching(task.id, runId, 'oc_a',
      `schedule:${task.id}:${randomUUID()}`, APP)).toBe(true);
    expect(scheduler.recoverDeferredRunOnStartup(task.id, APP)).toBe(true);

    const recovered = scheduler.getRuntimeTask(task.id, APP)!;
    expect(recovered.deferredRun!.targets.oc_a).toBe('ambiguous');
    expect(recovered.deferredRun!.targets.oc_b).toBe('waiting');

    // A retry refuses to replay the ambiguous target and surfaces an error.
    // It must NOT settle the run: oc_b is still owed, so the parked identity,
    // its turn ids and the waiting target survive. Only a human can resolve the
    // ambiguous target.
    expect(scheduler.runNow(task.id)).toEqual({ ok: true });
    await flush();
    const failed = scheduler.getRuntimeTask(task.id, APP)!;
    expect(failed.lastStatus).toBe('deferred');
    expect(failed.lastError).toContain('ambiguous');
    expect(failed.deferredRun).toMatchObject({
      runId,
      targets: { oc_a: 'ambiguous', oc_b: 'waiting' },
    });
    // Refusing the replay is not a run outcome: no repeat/once consumption and
    // no dispatched ledger entry for the still-waiting target.
    expect(failed.repeat?.completed).toBe(0);
    expect(failed.runStats?.dispatched ?? 0).toBe(0);
  });

  it('survives a real authority-store close/reopen and keeps waiting targets retryable', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();

    const runId = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!.runId;
    expect(scheduler.markDeferredTargetDispatching(task.id, runId, 'oc_b',
      `schedule:${task.id}:${randomUUID()}`, APP)).toBe(true);

    // Restart: drop the in-memory scheduler + store, reopen from disk.
    scheduler.stopScheduler();
    scheduler.setScheduleAuthorityStore(null);
    store.close();
    store = ScheduleAuthorityStore.open(dataDir);
    store.initializeApp(APP, []);
    scheduler.setScheduleAuthorityStore(store);
    scheduler.setOwnerFilter(APP, true);

    const reloaded = scheduler.getRuntimeTask(task.id, APP)!;
    expect(reloaded.lastStatus).toBe('deferred');
    expect(reloaded.deferredRun).toMatchObject({
      runId,
      targets: { oc_a: 'waiting', oc_b: 'dispatching' },
    });

    scheduler.startScheduler();
    scheduler.stopScheduler();

    const recovered = scheduler.getRuntimeTask(task.id, APP)!;
    expect(recovered.lastStatus).toBe('deferred');
    expect(recovered.deferredRun!.runId).toBe(runId);
    expect(recovered.deferredRun!.targets).toEqual({ oc_a: 'waiting', oc_b: 'ambiguous' });
  });

  it('S6: after a restart, delivers only the waiting target once and never replays the dispatched one', async () => {
    const task = addTwoTargetTask();
    let first = true;
    const { callback, calls } = makeDaemonCallback({
      action: chatId => {
        if (first) return chatId === 'oc_b' ? 'defer' : 'dispatch';
        return 'dispatch';
      },
    });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    first = false;

    const runId = scheduler.getRuntimeTask(task.id, APP)!.lastRunId!;
    const waitingTurnId = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!.targetTurnIds!.oc_b;
    expect(calls.map(call => call.chatId)).toEqual(['oc_a']);

    // Daemon restart: the parked run and its per-target facts come from disk.
    scheduler.stopScheduler();
    scheduler.setScheduleAuthorityStore(null);
    store.close();
    store = ScheduleAuthorityStore.open(dataDir);
    store.initializeApp(APP, []);
    scheduler.setScheduleAuthorityStore(store);
    scheduler.setOwnerFilter(APP, true);
    scheduler.startScheduler();
    scheduler.stopScheduler();

    expect(scheduler.getRuntimeTask(task.id, APP)!.deferredRun!.targets)
      .toEqual({ oc_a: 'dispatched', oc_b: 'waiting' });

    // Release: only the waiting target is delivered, under the same run/turn id.
    expect(scheduler.runNow(task.id)).toEqual({ ok: true });
    await flush();

    expect(calls.map(call => call.chatId)).toEqual(['oc_a', 'oc_b']);
    expect(new Set(calls.map(call => call.runId))).toEqual(new Set([runId]));
    expect(calls.find(call => call.chatId === 'oc_b')!.turnId).toBe(waitingTurnId);
    const settled = scheduler.getRuntimeTask(task.id, APP)!;
    expect(settled.lastStatus).toBe('ok');
    expect(settled.deferredRun).toBeUndefined();
    expect(settled.repeat?.completed).toBe(1);
  });

  it('settles a stuck parked run exactly once across repeated replays', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const runId = scheduler.getRuntimeTask(task.id, APP)!.lastRunId!;

    // A restart after `dispatching` turns the target ambiguous; production used
    // to throw on every retry, so it never settled and never alerted.
    scheduler.parkDeferredRun(task.id, {
      runId, trigger: 'scheduler', startedAt: new Date().toISOString(),
    }, { runId, detail: 'ambiguous after restart', targets: { oc_a: 'dispatching', oc_b: 'waiting' } });
    scheduler.recoverDeferredRunOnStartup(task.id, APP);
    expect(scheduler.getRuntimeTask(task.id, APP)!.deferredRun?.targets.oc_a).toBe('ambiguous');

    const alert = vi.fn();
    scheduler.setScheduleFailureAlert(alert);
    for (let round = 0; round < 60; round += 1) {
      scheduler.settleParkedRunOnce(task.id, runId, 'ambiguous target cannot be replayed');
    }
    await flush();

    expect(alert).toHaveBeenCalledTimes(1);
    const errors = queryScheduleRunLogs(task.id, { limit: 10 }, APP).logs
      .filter(entry => entry.outcome === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].errorCode).toBe('deferred_unsettled');
    const settled = scheduler.getRuntimeTask(task.id, APP)!;
    expect(settled.deferredRun).toBeUndefined();
    expect(settled.lastStatus).toBe('error');
    expect(settled.repeat?.completed).toBe(1);
    expect(settled.nextRunAt).toBeDefined();
    expect(Date.parse(settled.nextRunAt!)).toBeGreaterThan(Date.now());
  });

  it('settles a parked run when the scheduler tick reaches the 30-minute timeout', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    const execute = vi.fn(callback);
    scheduler.setExecuteCallback(execute);
    scheduler.runNow(task.id);
    await flush();
    const parked = scheduler.getRuntimeTask(task.id, APP)!;
    const since = Date.parse(parked.deferredRun!.since);
    const runId = parked.deferredRun!.runId;
    const alert = vi.fn();
    scheduler.setScheduleFailureAlert(alert);
    expect(execute).toHaveBeenCalledTimes(1);

    // Start five seconds before the deadline; the real startup tick therefore
    // lands exactly on it. A missing timeout branch retries and stays parked.
    vi.useFakeTimers({ now: new Date(since + scheduler.TRAEX_DEFERRED_RUN_TIMEOUT_MS - 5_000) });
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);

    const settled = scheduler.getRuntimeTask(task.id, APP)!;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(settled.deferredRun).toBeUndefined();
    expect(settled.lastRunId).toBe(runId);
    expect(settled.lastStatus).toBe('error');
    expect(settled.lastError).toContain('30 minutes');
    expect(alert).toHaveBeenCalledTimes(1);
    const errors = queryScheduleRunLogs(task.id, { limit: 10 }, APP).logs
      .filter(entry => entry.outcome === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].errorCode).toBe('deferred_unsettled');
    scheduler.stopScheduler();
  });

  it('settles a worker-held scheduled run onWorkerExit, but not an accepted turn', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const parked = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!;
    const runId = parked.runId;
    const turnA = parked.targetTurnIds!.oc_a;
    const turnB = parked.targetTurnIds!.oc_b;
    const runs: Record<string, { taskId: string; runId: string; turnId: string }> = {
      oc_a: { taskId: task.id, runId, turnId: turnA },
    };
    const deps = {
      getDeferredRun: (taskId: string, appId: string) => scheduler.getRuntimeTask(taskId, appId)?.deferredRun,
      settle: scheduler.settleParkedRunOnce,
    };

    expect(scheduler.markDeferredTargetAccepted(task.id, runId, 'oc_a', turnA, APP)).toBe(true);
    expect(settleHeldScheduleRunsOnWorkerExit({ scheduledRuns: runs }, APP, deps, { currentWorker: true })).toBe(0);
    expect(scheduler.getRuntimeTask(task.id, APP)!.deferredRun?.runId).toBe(runId);

    expect(scheduler.markDeferredTargetDispatching(task.id, runId, 'oc_b', turnB, APP)).toBe(true);
    expect(scheduler.markDeferredTargetHeld(task.id, runId, 'oc_b', turnB, APP)).toBe(true);
    runs.oc_b = { taskId: task.id, runId, turnId: turnB };
    const alert = vi.fn();
    scheduler.setScheduleFailureAlert(alert);
    expect(settleHeldScheduleRunsOnWorkerExit({ scheduledRuns: runs }, APP, deps, { currentWorker: true })).toBe(1);

    const settled = scheduler.getRuntimeTask(task.id, APP)!;
    expect(settled.deferredRun).toBeUndefined();
    expect(settled.lastStatus).toBe('error');
    expect(settled.lastError).toContain('worker exited');
    expect(alert).toHaveBeenCalledTimes(1);
    const errors = queryScheduleRunLogs(task.id, { limit: 10 }, APP).logs
      .filter(entry => entry.outcome === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].errorCode).toBe('deferred_unsettled');

    // Even a stale record carrying both markers must privilege the exact
    // acceptance fact. The terminal exit is only for a still-held turn.
    const acceptedAndHeld = {
      ...parked,
      targets: { ...parked.targets, oc_a: 'dispatched' as const },
      acceptedTargets: { oc_a: turnA },
      heldTargets: { oc_a: turnA },
    };
    const settleAccepted = vi.fn(() => true);
    expect(settleHeldScheduleRunsOnWorkerExit(
      { scheduledRuns: { oc_a: runs.oc_a } },
      APP,
      { getDeferredRun: () => acceptedAndHeld, settle: settleAccepted },
      { currentWorker: true },
    )).toBe(0);
    expect(settleAccepted).not.toHaveBeenCalled();
  });

  it('ignores stale worker exits and turns transferred to the replacement runtime', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const parked = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!;
    const turnId = parked.targetTurnIds!.oc_a;
    expect(scheduler.markDeferredTargetDispatching(task.id, parked.runId, 'oc_a', turnId, APP)).toBe(true);
    expect(scheduler.markDeferredTargetHeld(task.id, parked.runId, 'oc_a', turnId, APP)).toBe(true);
    const runs = { oc_a: { taskId: task.id, runId: parked.runId, turnId } };
    const deps = {
      getDeferredRun: (taskId: string, appId: string) => scheduler.getRuntimeTask(taskId, appId)?.deferredRun,
      settle: scheduler.settleParkedRunOnce,
    };

    const transferred = {
      scheduledRuns: runs,
      queuedActivationTail: [{ turnId, ownerRuntime: 'new' as const } as any],
    };
    expect(settleHeldScheduleRunsOnWorkerExit(
      transferred, APP, deps, { currentWorker: true },
    )).toBe(0);
    expect(settleHeldScheduleRunsOnWorkerExit(
      { scheduledRuns: runs }, APP, deps, { currentWorker: false },
    )).toBe(0);
    expect(scheduler.getRuntimeTask(task.id, APP)!.deferredRun?.runId).toBe(parked.runId);

    // Detach may already have promoted the tail into a journal before the
    // scheduler sees the exit. The captured exact turn identity must still
    // prevent the old worker from failing the transferred run.
    expect(settleHeldScheduleRunsOnWorkerExit(
      { scheduledRuns: runs, queuedActivationPending: true }, APP, deps,
      { currentWorker: true, transferredTurnIds: new Set([turnId]) },
    )).toBe(0);
    expect(scheduler.getRuntimeTask(task.id, APP)!.deferredRun?.runId).toBe(parked.runId);

    // The current, non-transferred worker is the only exit allowed to settle.
    expect(settleHeldScheduleRunsOnWorkerExit(
      { scheduledRuns: runs }, APP, deps, { currentWorker: true },
    )).toBe(1);
  });

  it('clears and settles a parked run in one authority write', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const runId = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!.runId;
    scheduler.setScheduleFailureAlert(null);
    const writes = vi.spyOn(store, 'updateTask');

    expect(scheduler.settleParkedRunOnce(task.id, runId, 'atomic settlement test', APP)).toBe(true);
    expect(writes).toHaveBeenCalledTimes(1);

    // Reopen the real authority DB: both halves of the outcome must already be
    // durable together, with no deferred/deferred-half-state left for startup.
    scheduler.setScheduleAuthorityStore(null);
    store.close();
    store = ScheduleAuthorityStore.open(dataDir);
    store.initializeApp(APP, []);
    scheduler.setScheduleAuthorityStore(store);
    scheduler.setOwnerFilter(APP, true);
    const reloaded = scheduler.getRuntimeTask(task.id, APP)!;
    expect(reloaded.deferredRun).toBeUndefined();
    expect(reloaded.lastStatus).toBe('error');
    expect(reloaded.lastError).toBe('atomic settlement test');
    expect(reloaded.repeat?.completed).toBe(1);
  });

  it('does not let a late park revive a terminally settled run', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const parked = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!;
    expect(scheduler.settleParkedRunOnce(task.id, parked.runId, 'terminal before late park', APP)).toBe(true);

    expect(scheduler.parkDeferredRun(task.id, {
      runId: parked.runId, trigger: 'scheduler', startedAt: new Date().toISOString(),
    }, {
      runId: parked.runId, detail: 'late in-flight park',
      targets: { oc_a: 'waiting', oc_b: 'waiting' },
      targetTurnIds: parked.targetTurnIds,
    })).toBe(false);
    const after = scheduler.getRuntimeTask(task.id, APP)!;
    expect(after.lastStatus).toBe('error');
    expect(after.deferredRun).toBeUndefined();
    expect(after.repeat?.completed).toBe(1);
  });

  it.each(['executed', 'throw'] as const)('ignores an in-flight %s outcome after terminal settlement', async outcome => {
    const task = addTwoTargetTask();
    let context!: ScheduleExecutionContext;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const publish = vi.spyOn(dashboardEventBus, 'publish');
    scheduler.setExecuteCallback(async (current, run) => {
      context = run;
      expect(scheduler.parkDeferredRun(current.id, run, {
        runId: run.runId, detail: 'in-flight callback',
        targets: { oc_a: 'waiting', oc_b: 'waiting' },
        targetTurnIds: { oc_a: 'schedule:test:a', oc_b: 'schedule:test:b' },
      })).toBe(true);
      await waiting;
      if (outcome === 'throw') throw new Error('late callback failure');
      return 'executed';
    });
    scheduler.runNow(task.id);
    await flush();
    expect(scheduler.settleParkedRunOnce(task.id, context.runId, 'terminal before callback', APP)).toBe(true);
    const settled = scheduler.getRuntimeTask(task.id, APP)!;
    const firedAtSettlement = publish.mock.calls.filter(([event]) => event.type === 'schedule.fired').length;
    expect(settled.repeat?.completed).toBe(1);

    release();
    await flush();
    const after = scheduler.getRuntimeTask(task.id, APP)!;
    expect(after.lastStatus).toBe('error');
    expect(after.lastError).toBe('terminal before callback');
    expect(after.deferredRun).toBeUndefined();
    expect(after.repeat?.completed).toBe(1);
    expect(after.runStats?.consecutiveFailures).toBe(1);
    expect(publish.mock.calls.filter(([event]) => event.type === 'schedule.fired'))
      .toHaveLength(firedAtSettlement);
  });

  it('settles the explicit app even when the owner filter changed', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const runId = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!.runId;
    scheduler.setOwnerFilter('cli_some_other_owner', true);
    expect(scheduler.settleParkedRunOnce(task.id, runId, 'explicit app settlement', APP)).toBe(true);
    expect(scheduler.getRuntimeTask(task.id, APP)!.lastStatus).toBe('error');
  });

  it('keeps authority edits and materialized roots out of the retry claim write', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const runId = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!.runId;
    store.updateTask(APP, task.id, current => ({
      ...current,
      prompt: 'edited while parked',
      rootMessageId: 'om_materialized_root',
      ownerOpenId: 'ou_new_owner',
      ownerUnionId: 'on_new_owner',
    }));

    const claim = scheduler.claimDeferredRunForDispatch(task.id, runId, APP);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.task.prompt).toBe('check');
    const persisted = store.getRecord(APP, task.id)!.task;
    expect(persisted).toMatchObject({
      prompt: 'edited while parked',
      rootMessageId: 'om_materialized_root',
      ownerOpenId: 'ou_new_owner',
      ownerUnionId: 'on_new_owner',
      lastStatus: 'running',
    });
  });

  it('rejects dispatching and claiming after terminal settlement', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const parked = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!;
    expect(scheduler.settleParkedRunOnce(task.id, parked.runId, 'terminal before dispatching', APP)).toBe(true);

    expect(scheduler.markDeferredTargetDispatching(task.id, parked.runId, 'oc_b', 'late-turn', APP)).toBe(false);
    expect(scheduler.claimDeferredRunForDispatch(task.id, parked.runId, APP))
      .toEqual({ ok: false, error: 'not_deferred' });
    const after = scheduler.getRuntimeTask(task.id, APP)!;
    expect(after.deferredRun).toBeUndefined();
    expect(after.repeat?.completed).toBe(1);
    expect(after.lastStatus).toBe('error');
  });

  it.each(['pause', 'untilDone'] as const)('settles an accepted run as success before timeout after %s', async mode => {
    const task = addTwoTargetTask();
    if (mode === 'untilDone') {
      store.updateTask(APP, task.id, current => ({ ...current, untilDone: { status: 'open', attempts: 0 } }));
    }
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const parked = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!;
    const since = Date.parse(parked.since);
    for (const [chatId, turnId] of Object.entries(parked.targetTurnIds!)) {
      expect(scheduler.markDeferredTargetAccepted(task.id, parked.runId, chatId, turnId, APP)).toBe(true);
    }
    if (mode === 'pause') scheduler.disableTask(task.id);
    else expect(scheduler.completeTask(task.id).ok).toBe(true);
    const alert = vi.fn();
    scheduler.setScheduleFailureAlert(alert);

    vi.useFakeTimers({ now: new Date(since + scheduler.TRAEX_DEFERRED_RUN_TIMEOUT_MS) });
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);

    const settled = scheduler.getRuntimeTask(task.id, APP)!;
    expect(settled.lastStatus).toBe('ok');
    expect(settled.deferredRun).toBeUndefined();
    expect(settled.repeat?.completed).toBe(1);
    expect(settled.enabled).toBe(false);
    expect(settled.disabledReason).toBe(mode === 'pause' ? 'manual' : 'once_completed');
    if (mode === 'untilDone') expect(settled.untilDone?.status).toBe('done');
    expect(alert).not.toHaveBeenCalled();
    scheduler.stopScheduler();
  });

  it.each(['disableTask', 'setEnabled', 'completeTask'] as const)('cancels an unaccepted run without failure accounting or a late acceptance after %s', async action => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const parked = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!;
    if (action === 'completeTask' || action === 'disableTask' || action === 'setEnabled') {
      store.updateTask(APP, task.id, current => ({ ...current, untilDone: {
        status: 'open', attempts: 0, deadline: '2020-01-01T00:00:00.000Z', finalRunId: parked.runId,
      } }));
    }
    const turnId = Object.values(parked.targetTurnIds!)[0]!;
    const ds = {
      worker: { killed: false }, workerReady: false,
      larkAppId: APP,
      session: { scheduledRuns: { [turnId]: { taskId: task.id, runId: parked.runId, turnId } } },
    } as any;
    const close = vi.fn(() => {
      ds.worker.killed = true;
      settleHeldScheduleRunsOnWorkerExit(ds.session, APP, {
        getDeferredRun: (id, appId) => scheduler.getRuntimeTask(id, appId)?.deferredRun,
        settle: scheduler.settleParkedRunOnce,
      }, { currentWorker: true });
    });
    scheduler.setParkedRunCancellationHandler((_task, runId) => {
      cancelPreReadyScheduledWorkers([ds], runId, close, { updateSession: vi.fn() });
    });
    const alert = vi.fn();
    scheduler.setScheduleFailureAlert(alert);

    if (action === 'disableTask') expect(scheduler.disableTask(task.id)).toBe(true);
    else if (action === 'setEnabled') expect(scheduler.setEnabled(task.id, false)).toEqual({ ok: true });
    else expect(scheduler.completeTask(task.id).ok).toBe(true);

    const settled = scheduler.getRuntimeTask(task.id, APP)!;
    expect(close).toHaveBeenCalledTimes(1);
    expect(ds.worker.killed).toBe(true);
    expect(settled.lastStatus).toBe('skipped');
    expect(settled.deferredRun).toBeUndefined();
    expect(settled.repeat?.completed).toBe(0);
    expect(settled.runStats?.consecutiveFailures ?? 0).toBe(0);
    expect(alert).not.toHaveBeenCalled();
    expect(scheduler.noteWorkerRuntimeAccepted(task.id, parked.runId, 'oc_a', turnId, APP)).toBe(false);
    expect(queryScheduleRunLogs(task.id, {}, APP).logs.filter(entry => entry.outcome === 'error')).toHaveLength(0);
    if (action === 'completeTask') expect(settled.untilDone?.status).toBe('done');
    else {
      expect(settled.untilDone?.status).toBe('open');
      expect(settled.untilDone?.finalRunId).toBeUndefined();
      expect(untilDoneDeadlineDue(settled, Date.now())).toBe(true);
    }
  });

  it('writes exactly one successful run log when the tick settles an accepted parked run', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    let executions = 0;
    scheduler.setExecuteCallback(async (current, context) => {
      executions += 1;
      return callback(current, context);
    });
    scheduler.runNow(task.id);
    await flush();
    const parked = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!;
    for (const [chatId, turnId] of Object.entries(parked.targetTurnIds!)) {
      scheduler.noteWorkerRuntimeAccepted(task.id, parked.runId, chatId, turnId, APP);
    }
    vi.useFakeTimers({ now: new Date(Date.parse(parked.since) + 30_000) });
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(scheduler.getRuntimeTask(task.id, APP)?.lastStatus).toBe('ok');
    expect(executions).toBe(1);
    const logs = queryScheduleRunLogs(task.id, {}, APP).logs.filter(entry => entry.id === parked.runId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      outcome: 'model_dispatched', precondition: 'passed', additionalPrompt: true,
      targetResults: [{ chatId: 'oc_a', outcome: 'model_dispatched' }, { chatId: 'oc_b', outcome: 'model_dispatched' }],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queryScheduleRunLogs(task.id, {}, APP).logs.filter(entry => entry.id === parked.runId)).toHaveLength(1);
  });

  it('converges an operator pause that lands before the first deferred write', async () => {
    const task = addTwoTargetTask();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    scheduler.setExecuteCallback(async (current, context) => {
      started();
      await gate;
      expect(scheduler.parkDeferredRun(task.id, context, {
        runId: context.runId, detail: 'late handoff after pause',
        targets: { oc_a: 'waiting', oc_b: 'waiting' },
        targetTurnIds: { oc_a: 'schedule:a', oc_b: 'schedule:b' },
      })).toBe(false);
      return 'deferred';
    });
    scheduler.runNow(task.id);
    await began;
    expect(scheduler.disableTask(task.id)).toBe(true);
    release();
    await flush();
    const settled = scheduler.getRuntimeTask(task.id, APP)!;
    expect(settled.lastStatus).toBe('skipped');
    expect(settled.deferredRun).toBeUndefined();
    expect(settled.repeat?.completed).toBe(0);
  });

  it('keeps delivery failure and recovery inside the deferred settlement path', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const runId = scheduler.getRuntimeTask(task.id, APP)!.lastRunId!;
    expect(scheduler.recordDeliveryFailure(task.id, runId, 'send rejected', APP)).toBe(true);
    expect(scheduler.getRuntimeTask(task.id, APP)).toMatchObject({ lastStatus: 'deferred' });
    expect(scheduler.getRuntimeTask(task.id, APP)?.deferredRun?.runId).toBe(runId);
    expect(scheduler.recordDeliverySuccess(task.id, runId, APP)).toBe(true);
    expect(scheduler.getRuntimeTask(task.id, APP)).toMatchObject({ lastStatus: 'deferred' });
    expect(scheduler.getRuntimeTask(task.id, APP)?.deferredRun?.runId).toBe(runId);
  });

  it('preserves delivery error facts when the same deferred run is reclaimed', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const runId = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!.runId;
    scheduler.recordDeliveryFailure(task.id, runId, 'parked send rejected', APP, 'schedule_send_rejected', 'oc_a');
    const claimed = scheduler.claimDeferredRunForDispatch(task.id, runId, APP);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.task.lastDeliveryError).toBe('parked send rejected');
    expect(claimed.task.lastError).toBe('parked send rejected');
    expect(scheduler.getRuntimeTask(task.id, APP)?.lastDeliveryError).toBe('parked send rejected');
  });

  it('writes one terminal deferred delivery-failure log with per-target facts', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const parked = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!;
    scheduler.recordDeliveryFailure(task.id, parked.runId, 'oc_a rejected', APP, 'schedule_send_rejected', 'oc_a');
    for (const [chatId, turnId] of Object.entries(parked.targetTurnIds!)) {
      expect(scheduler.noteWorkerRuntimeAccepted(task.id, parked.runId, chatId, turnId, APP)).toBe(true);
    }
    vi.useFakeTimers({ now: new Date(Date.parse(parked.since) + 30_000) });
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    const logs = queryScheduleRunLogs(task.id, {}, APP).logs.filter(entry => entry.id === parked.runId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      outcome: 'error', errorCode: 'schedule_send_rejected',
      targetResults: [{ chatId: 'oc_a', outcome: 'error' }, { chatId: 'oc_b', outcome: 'model_dispatched' }],
      deliveryFailureBaseline: { outcome: 'model_dispatched' },
    });
  });

  it('rejects schedule-expression edits while a run is parked', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    expect(scheduler.updateTask(task.id, { schedule: '2027-01-01T00:00:00Z' }))
      .toEqual({ ok: false, error: 'schedule_run_in_flight' });
    expect(scheduler.getRuntimeTask(task.id, APP)!.parsed.kind).toBe('interval');
  });

  it.each(['settle', 'disable', 'remove'] as const)('notifies the daemon to cancel a pre-ready worker on %s', async action => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const runId = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!.runId;
    const cancel = vi.fn();
    scheduler.setParkedRunCancellationHandler(cancel);
    if (action === 'settle') scheduler.settleParkedRunOnce(task.id, runId, 'timeout', APP);
    else if (action === 'disable') scheduler.disableTask(task.id);
    else scheduler.removeTask(task.id);
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), runId);
  });

  it('cancels the worker even when projection deletion fails after authority revoke', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();
    const runId = scheduler.getRuntimeTask(task.id, APP)!.deferredRun!.runId;
    const close = vi.fn();
    const cancel = vi.fn((_task: ScheduledTask, cancelledRunId: string) => {
      cancelPreReadyScheduledWorkers([{
        worker: { killed: false }, workerReady: false,
        session: { scheduledRuns: { turn: { taskId: task.id, runId: cancelledRunId, turnId: 'turn' } } },
      } as any], cancelledRunId, close, { updateSession: vi.fn() });
    });
    scheduler.setParkedRunCancellationHandler(cancel);
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    scheduleStore.__setScheduleStoreBeforeRenameTestHook(() => {
      throw new Error('controlled projection failure');
    });
    try {
      expect(() => scheduler.removeTask(task.id)).toThrow('controlled projection failure');
      expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), runId);
      expect(close).toHaveBeenCalledTimes(1);
      expect(store.getRecord(APP, task.id)?.state).toBe('revoked');
      expect(scheduleStore.getTask(task.id, APP)).toBeDefined();
    } finally {
      scheduleStore.__setScheduleStoreBeforeRenameTestHook(undefined);
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('closes only pre-ready workers belonging to the cancelled run', () => {
    const runId = 'run-cancel';
    const base = {
      worker: { killed: false }, workerReady: false, workerPort: null, workerToken: null,
      larkAppId: APP, chatId: 'oc_a', chatType: 'group', scope: 'thread',
      spawnedAt: 0, lastMessageAt: 0, hasHistory: false, workingDir: '/tmp',
    };
    const pre = {
      ...base,
      session: {
        sessionId: 'pre', rootMessageId: 'om_pre', chatId: 'oc_a', title: 'pre',
        status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
        scheduledRuns: { turn: { taskId: 'defer001', runId, turnId: 'turn' } },
      },
    } as any;
    const staged = {
      ...base,
      worker: null,
      initialStartPending: true,
      session: { ...pre.session, sessionId: 'staged', rootMessageId: 'om_staged' },
    };
    const ready = {
      ...base, workerReady: true,
      session: { ...pre.session, sessionId: 'ready', rootMessageId: 'om_ready' },
    };
    const other = {
      ...base,
      session: { ...pre.session, sessionId: 'other', rootMessageId: 'om_other',
        scheduledRuns: { turn: { taskId: 'defer001', runId: 'run-other', turnId: 'turn' } } },
    };
    const close = vi.fn();
    expect(cancelPreReadyScheduledWorkers([pre, staged, ready, other], runId, close, { updateSession: vi.fn() })).toBe(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith(pre);
    expect(close).toHaveBeenCalledWith(staged);
  });

  it('removes only cancelled tail turns and interrupts exact turns on a shared pre-ready worker', () => {
    const runId = 'run-cancel-shared';
    const targetTurn = 'schedule:target';
    const otherTurn = 'schedule:other';
    const humanTurn = 'om_human';
    const shared = {
      worker: { killed: false }, workerReady: false,
      larkAppId: APP, chatId: 'oc_a', chatType: 'group', scope: 'thread',
      spawnedAt: 0, lastMessageAt: 0, hasHistory: true, workingDir: '/tmp',
      pendingFollowUps: ['human follow-up'],
      session: {
        sessionId: 'shared', rootMessageId: 'om_shared', chatId: 'oc_a', title: 'shared',
        status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
        scheduledRuns: {
          [targetTurn]: { taskId: 'defer001', runId, turnId: targetTurn },
          [otherTurn]: { taskId: 'defer002', runId: 'run-other', turnId: otherTurn },
        },
        queuedActivationTail: [
          { turnId: targetTurn, ownerRuntime: 'new' },
          { turnId: otherTurn, ownerRuntime: 'new' },
          { turnId: humanTurn, ownerRuntime: 'new' },
        ] as any,
        queuedActivationPending: true,
        queuedActivationTurnId: targetTurn,
        queuedActivationToken: 'token-target',
        queuedActivationInput: { content: 'cancelled head' } as any,
        queuedActivationResume: true,
      },
    } as any;
    const close = vi.fn();
    const cancelTurn = vi.fn();
    expect(cancelPreReadyScheduledWorkers([shared], runId, close, { cancelTurn, updateSession: vi.fn() })).toBe(1);
    expect(close).not.toHaveBeenCalled();
    expect(cancelTurn).toHaveBeenCalledWith(shared, targetTurn);
    expect(shared.session.queuedActivationTail.map((entry: any) => entry.turnId)).toEqual([otherTurn, humanTurn]);
    expect(shared.session.queuedActivationPending).toBeUndefined();
    expect(shared.session.queuedActivationToken).toBeUndefined();
    expect(shared.session.queuedActivationInput).toBeUndefined();
    expect(shared.session.queuedActivationTurnId).toBeUndefined();
    expect(shared.initialStartPending).toBe(false);
    expect(shared.session.cancelledActivationTurnIds).toContain(targetTurn);
    expect(shared.pendingFollowUps).toEqual(['human follow-up']);

    const ready = {
      ...shared,
      workerReady: true,
      pendingFollowUps: [],
      session: { ...shared.session, sessionId: 'ready',
        queuedActivationTail: [{ turnId: targetTurn, ownerRuntime: 'new' }] as any },
    };
    expect(cancelPreReadyScheduledWorkers([ready], runId, close, { updateSession: vi.fn() })).toBe(0);
    expect(ready.session.queuedActivationTail).toBeUndefined();
    expect(close).not.toHaveBeenCalled();

    const failedWrite = {
      ...ready,
      session: { ...ready.session,
        queuedActivationTail: [{ turnId: targetTurn, ownerRuntime: 'new' }] as any },
    };
    cancelTurn.mockClear();
    const durableStates: any[] = [];
    const updateSession = vi.fn()
      .mockImplementationOnce(session => { durableStates.push(structuredClone(session)); })
      .mockImplementationOnce(() => { throw new Error('controlled cleanup write failure'); });
    expect(cancelPreReadyScheduledWorkers([failedWrite], runId, close, { updateSession })).toBe(0);
    expect(updateSession).toHaveBeenCalledTimes(2);
    // The first write is a write-ahead tombstone with the old tail intact. A
    // restart after the second-write failure can still filter the cancelled turn.
    expect(durableStates[0].queuedActivationTail.map((entry: any) => entry.turnId)).toContain(targetTurn);
    expect(durableStates[0].cancelledActivationTurnIds).toContain(targetTurn);
    expect(failedWrite.session.cancelledActivationTurnIds).toContain(targetTurn);
    expect(failedWrite.activationCancellationPending).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(cancelTurn).not.toHaveBeenCalled();
    // Cleanup failure keeps the pruned state and tombstone in memory, then the
    // same state is retried before promotion rather than restoring the turn.
    expect(failedWrite.session.queuedActivationTail).toBeUndefined();
    expect(retryCancelledActivationPersistence(failedWrite, vi.fn())).toBe(true);
    expect(failedWrite.activationCancellationPending).toBeUndefined();

    const tombstoneFailure = {
      ...ready,
      activationCancellationPending: undefined,
      session: { ...ready.session, cancelledActivationTurnIds: undefined },
    };
    expect(cancelPreReadyScheduledWorkers([tombstoneFailure], runId, close, {
      updateSession: () => { throw new Error('controlled tombstone failure'); },
    })).toBe(0);
    expect(tombstoneFailure.activationCancellationPending).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it('cancels a shared pre-ready opening and releases the retained human successor', async () => {
    const runId = 'run-shared-opening';
    const ds = {
      worker: { killed: false }, workerReady: false, hasHistory: true,
      session: {
        status: 'active', creationSource: 'schedule', cliSessionId: 'traex-human',
      },
    } as any;
    ds.session.scheduledRuns = { 'schedule:target': { taskId: 'defer001', runId, turnId: 'schedule:target' } };
    Object.assign(ds.session, {
      queuedActivationPending: true, queuedActivationTurnId: 'schedule:target',
      queuedActivationToken: 'token-target',
      queuedActivationTail: [{ turnId: 'om_human', ownerRuntime: 'new' }],
    });
    const close = vi.fn();
    const cancelTurn = vi.fn(async () => 'queued_removed');
    const release = vi.fn(async () => {});
    expect(cancelPreReadyScheduledWorkers([ds], runId, close, {
      cancelTurn, release, updateSession: vi.fn(),
    })).toBe(1);
    await flush();
    expect(cancelTurn).toHaveBeenCalledWith(ds, 'schedule:target');
    expect(release).toHaveBeenCalledWith(ds);
    expect(close).not.toHaveBeenCalled();
    expect(ds.session.status).toBe('active');
    expect(ds.session.queuedActivationTail.map((entry: any) => entry.turnId)).toEqual(['om_human']);
  });

  it('retires only the worker when exact queue cancellation is unproven', async () => {
    const ds = {
      worker: { killed: false }, workerReady: false, hasHistory: true,
      session: {
        status: 'active', cliSessionId: 'traex-human',
        scheduledRuns: { 'schedule:argv': { taskId: 'defer001', runId: 'run-argv', turnId: 'schedule:argv' } },
        queuedActivationTail: [{ turnId: 'om_human', ownerRuntime: 'new' }],
      },
    } as any;
    const close = vi.fn();
    const retireWorker = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    expect(cancelPreReadyScheduledWorkers([ds], 'run-argv', close, {
      cancelTurn: async () => 'restart_required', retireWorker, release, updateSession: vi.fn(),
    })).toBe(1);
    await flush();
    expect(retireWorker).toHaveBeenCalledWith(ds);
    expect(release).toHaveBeenCalledWith(ds);
    expect(close).not.toHaveBeenCalled();
    expect(ds.session.status).toBe('active');
  });

  it('does not release a successor when worker retirement is refused', async () => {
    const ds = {
      worker: { killed: false }, workerReady: false, hasHistory: true,
      session: {
        status: 'active', cliSessionId: 'remote-human',
        scheduledRuns: { 'schedule:remote': { taskId: 'defer001', runId: 'run-remote', turnId: 'schedule:remote' } },
        queuedActivationTail: [{ turnId: 'om_remote_human', ownerRuntime: 'new' }],
      },
    } as any;
    const release = vi.fn(async () => {});
    expect(cancelPreReadyScheduledWorkers([ds], 'run-remote', vi.fn(), {
      cancelTurn: async () => 'restart_required', retireWorker: async () => false,
      release, updateSession: vi.fn(),
    })).toBe(1);
    await flush();
    expect(release).not.toHaveBeenCalled();
    expect(ds.session.queuedActivationTail.map((entry: any) => entry.turnId)).toEqual(['om_remote_human']);
    expect(ds.worker.killed).toBe(false);
  });

  it('cold-starts a retained human journal after a proven worker retirement', async () => {
    const ds = {
      worker: null,
      session: { queuedActivationPending: true, queuedActivationInput: { content: 'human' } },
    } as any;
    const startJournal = vi.fn();
    const scheduleRetry = vi.fn();
    await releaseCancelledActivationWork(ds, {
      release: async () => false, startJournal, scheduleRetry,
    });
    expect(startJournal).toHaveBeenCalledOnce();
    expect(scheduleRetry).not.toHaveBeenCalled();
    await releaseCancelledActivationWork(ds, {
      release: async () => true, startJournal, scheduleRetry,
    });
    expect(startJournal).toHaveBeenCalledOnce();
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it('closes a staged scheduled placeholder whose own pendingPrompt is cancelled', async () => {
    const ds = {
      worker: null, workerReady: false, initialStartPending: true,
      hasHistory: false, pendingPrompt: 'scheduled opening', scheduledStagedInput: {},
      session: {
        status: 'active', creationSource: 'schedule',
        scheduledRuns: { 'schedule:staged': { taskId: 'defer001', runId: 'run-staged', turnId: 'schedule:staged' } },
      },
    } as any;
    const close = vi.fn(async () => {});
    expect(cancelPreReadyScheduledWorkers([ds], 'run-staged', close, { updateSession: vi.fn() })).toBe(1);
    await flush();
    expect(close).toHaveBeenCalledWith(ds);
    expect(ds.pendingPrompt).toBeUndefined();
    expect(ds.scheduledStagedInput).toBeUndefined();
  });

  it('still cancels a retained pre-ready worker when the atomic tombstone write fails', async () => {
    const ds = {
      worker: { killed: false }, workerReady: false, hasHistory: true,
      session: {
        status: 'active', cliSessionId: 'traex-human',
        scheduledRuns: { 'schedule:busy': { taskId: 'defer001', runId: 'run-busy', turnId: 'schedule:busy' } },
      },
    } as any;
    const close = vi.fn();
    const cancelTurn = vi.fn(async () => 'queued_removed');
    expect(cancelPreReadyScheduledWorkers([ds], 'run-busy', close, {
      cancelTurn, updateSession: () => { throw new Error('SQLITE_BUSY'); },
    })).toBe(1);
    await flush();
    expect(cancelTurn).toHaveBeenCalledWith(ds, 'schedule:busy');
    expect(ds.activationCancellationPending).toBe(true);
    expect(ds.session.cancelledActivationTurnIds).toContain('schedule:busy');
    expect(close).not.toHaveBeenCalled();
    expect(ds.session.status).toBe('active');
  });

  it('ignores a superseded in-flight callback after a newer run has settled', async () => {
    const task = addTwoTargetTask();
    let oldContext!: ScheduleExecutionContext;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const publish = vi.spyOn(dashboardEventBus, 'publish');
    scheduler.setExecuteCallback(async (current, run) => {
      oldContext = run;
      scheduler.parkDeferredRun(current.id, run, {
        runId: run.runId, detail: 'old in-flight run',
        targets: { oc_a: 'waiting', oc_b: 'waiting' },
        targetTurnIds: { oc_a: 'schedule:old:a', oc_b: 'schedule:old:b' },
      });
      await waiting;
      return 'executed';
    });
    scheduler.runNow(task.id);
    await flush();
    expect(scheduler.settleParkedRunOnce(task.id, oldContext.runId, 'old run timed out', APP)).toBe(true);

    scheduler.setExecuteCallback(async () => 'executed');
    scheduler.runNow(task.id);
    await flush();
    const newer = scheduler.getRuntimeTask(task.id, APP)!;
    expect(newer.lastRunId).not.toBe(oldContext.runId);
    expect(newer.lastStatus).toBe('ok');
    expect(newer.repeat?.completed).toBe(2);
    const firedBeforeOld = publish.mock.calls.filter(([event]) => event.type === 'schedule.fired').length;

    release();
    await flush();
    const after = scheduler.getRuntimeTask(task.id, APP)!;
    expect(after.lastRunId).toBe(newer.lastRunId);
    expect(after.repeat?.completed).toBe(2);
    expect(publish.mock.calls.filter(([event]) => event.type === 'schedule.fired'))
      .toHaveLength(firedBeforeOld);
  });

  it('does not let a stale run outcome clear a newer parked run', async () => {
    const task = addTwoTargetTask();
    const { callback } = makeDaemonCallback({ action: () => 'defer' });
    scheduler.setExecuteCallback(callback);
    scheduler.runNow(task.id);
    await flush();

    const parked = scheduler.getRuntimeTask(task.id, APP)!;
    // A late outcome from an older runId must be ignored by the settlement guard.
    const before = JSON.stringify(parked.deferredRun);
    scheduler.setExecuteCallback(async () => 'executed');
    // Simulate the daemon delivering a stale deferred result: recordDispatchOutcome
    // is private, so assert through the public invariant that parking is keyed by
    // lastRunId — a different runId cannot mutate the parked record.
    expect(scheduler.markDeferredTargetHeld(task.id, 'stale-run-id', 'oc_a', 'turn', APP)).toBe(false);
    expect(scheduler.parkDeferredRun(task.id, {
      runId: 'stale-run-id', trigger: 'scheduler', startedAt: new Date().toISOString(),
    }, { runId: 'stale-run-id', detail: 'stale', targets: { oc_a: 'waiting' } })).toBe(false);
    expect(JSON.stringify(scheduler.getRuntimeTask(task.id, APP)!.deferredRun)).toBe(before);
  });
});
