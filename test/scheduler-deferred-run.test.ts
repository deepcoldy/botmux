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
import { settleHeldScheduleRunsOnWorkerExit } from '../src/core/deferred-schedule-settlement.js';

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
    expect(settleHeldScheduleRunsOnWorkerExit({ scheduledRuns: runs }, APP, deps)).toBe(0);
    expect(scheduler.getRuntimeTask(task.id, APP)!.deferredRun?.runId).toBe(runId);

    expect(scheduler.markDeferredTargetDispatching(task.id, runId, 'oc_b', turnB, APP)).toBe(true);
    expect(scheduler.markDeferredTargetHeld(task.id, runId, 'oc_b', turnB, APP)).toBe(true);
    runs.oc_b = { taskId: task.id, runId, turnId: turnB };
    const alert = vi.fn();
    scheduler.setScheduleFailureAlert(alert);
    expect(settleHeldScheduleRunsOnWorkerExit({ scheduledRuns: runs }, APP, deps)).toBe(1);

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
    )).toBe(0);
    expect(settleAccepted).not.toHaveBeenCalled();
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
