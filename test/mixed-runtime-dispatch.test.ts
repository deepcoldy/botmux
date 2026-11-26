import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { config } from '../src/config.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import * as scheduler from '../src/core/scheduler.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import type { ScheduleExecutionContext } from '../src/core/scheduler.js';
import { executeScheduledTaskForTargets, ScheduleTargetExecutionError } from '../src/services/schedule-target-executor.js';
import { queryScheduleRunLogs } from '../src/services/schedule-run-log-store.js';

const APP = 'cli_mixed_dispatch';
let root: string;
let authority: ScheduleAuthorityStore;
let context: ScheduleExecutionContext;
let taskId: string;
const turnA = 'schedule:mixed:a';
const turnB = 'schedule:mixed:b';

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T15:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'botmux-mixed-dispatch-'));
  config.session.dataDir = join(root, 'data');
  scheduleStore.setScheduleScope(APP);
  authority = ScheduleAuthorityStore.open(config.session.dataDir);
  authority.initializeApp(APP, []);
  scheduler.setScheduleAuthorityStore(authority);
  scheduler.setOwnerFilter(APP, true);
  const task = scheduler.addTask({
    id: 'mixed', name: 'mixed dispatch', schedule: 'every 30m', prompt: 'check', workingDir: root,
    chatId: 'oc_A', chatIds: ['oc_A', 'oc_B'], larkAppId: APP,
    owner: { kind: 'human', openId: 'ou_mixed' }, repeat: { times: 2, completed: 0 },
  });
  taskId = task.id;
  scheduler.setExecuteCallback(async (task, run) => {
    context = run;
    scheduler.parkDeferredRun(task.id, run, {
      runId: run.runId, detail: 'waiting', targets: { oc_A: 'waiting', oc_B: 'waiting' },
      targetTurnIds: { oc_A: turnA, oc_B: turnB },
    });
    return 'deferred';
  });
  expect(scheduler.runNow(taskId)).toEqual({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
});
afterEach(() => {
  scheduler.stopScheduler();
  scheduler.setScheduleAuthorityStore(null);
  authority.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
function current() { return scheduler.getRuntimeTask(taskId, APP)!; }
function productionRunTargets() {
  const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
  const begin = daemon.indexOf('      const runTargets = async (additionalPrompt?: string)');
  const end = daemon.indexOf('      let outcome: ScheduledTaskPreconditionOutcome;', begin);
  const js = ts.transpileModule(daemon.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('scope', `with (scope) { ${js}; return runTargets; }`);
}
function sessions() {
  return new Map<string, any>([
    ['oc_A', { larkAppId: APP, chatId: 'oc_A', session: { cliId: 'claude-code', cliLaunchSnapshot: { cliId: 'claude-code' } } }],
    ['oc_B', { larkAppId: APP, chatId: 'oc_B', session: { cliId: 'traex', cliLaunchSnapshot: { cliId: 'traex' } } }],
  ]);
}

describe('mixed non-TRAE + TRAE dispatch', () => {
  it('settles after the TRAE target accepts without losing the non-TRAE acceptance', async () => {
    const active = sessions();
    const run = productionRunTargets()({ task: current(), executionContext: context, parked: current().deferredRun,
      scheduler, scheduleStore, effectiveAppId: APP, cfg: { cliId: 'traex' },
      randomUUID: () => 'unused', buildUntilDoneRunPrompt: () => undefined,
      scheduleTimeZone: () => 'Asia/Shanghai', executeScheduledTaskForTargets,
      ScheduleTargetExecutionError, activeSessions: active, refreshCliVersion: async () => {},
      precondition: { precondition: 'passed' }, targetResults: undefined,
      resolveScheduleRunLogErrorDetails: (_precondition: unknown, error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }),
      withBotTurnAdmission: (_app: string, action: () => unknown) => action(),
      getAllBots: () => [{ config: { larkAppId: APP, cliId: 'traex' } }],
      executeScheduledTask: async (target: any, sessions: typeof active, _refresh: any, _prompt: any, runtime: any) => {
        if (!runtime.onBeforeDispatch(runtime.turnId, sessions.get(target.chatId))) return 'deferred';
        return 'dispatched';
      },
    }) as () => Promise<'dispatched' | 'deferred'>;
    expect(await run()).toBe('deferred');
    expect(current().deferredRun).toMatchObject({
      acceptedTargets: { oc_A: turnA }, targets: { oc_A: 'dispatched', oc_B: 'held' },
      targetTurnIds: { oc_A: turnA, oc_B: turnB },
    });
    expect(scheduler.noteWorkerRuntimeAccepted(taskId, context.runId, 'oc_B', turnB, APP)).toBe(true);
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(current().lastStatus).toBe('ok');
    expect(current().repeat?.completed).toBe(1);
    expect(current().deferredRun).toBeUndefined();
  });

  it('does not resend an accepted non-TRAE target when a later TRAE dispatch fails', async () => {
    const active = sessions();
    const attempts: Array<{ chatId: string; turnId: string }> = [];
    const production = () => productionRunTargets()({ task: current(), executionContext: context, parked: current().deferredRun,
      scheduler, scheduleStore, effectiveAppId: APP, cfg: { cliId: 'traex' },
      randomUUID: () => 'unused', buildUntilDoneRunPrompt: () => undefined,
      scheduleTimeZone: () => 'Asia/Shanghai', executeScheduledTaskForTargets,
      ScheduleTargetExecutionError, activeSessions: active, refreshCliVersion: async () => {},
      precondition: { precondition: 'passed' }, targetResults: undefined,
      resolveScheduleRunLogErrorDetails: (_precondition: unknown, error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }),
      withBotTurnAdmission: (_app: string, action: () => unknown) => action(),
      getAllBots: () => [{ config: { larkAppId: APP, cliId: 'traex' } }],
      executeScheduledTask: async (target: any, sessions: typeof active, _refresh: any, _prompt: any, runtime: any) => {
        attempts.push({ chatId: target.chatId, turnId: runtime.turnId });
        if (target.chatId === 'oc_B' && attempts.filter(attempt => attempt.chatId === 'oc_B').length === 1) {
          throw new Error('traex fork failed');
        }
        if (!runtime.onBeforeDispatch(runtime.turnId, sessions.get(target.chatId))) return 'deferred';
        return 'dispatched';
      },
    }) as () => Promise<'dispatched' | 'deferred'>;
    expect(await production()()).toBe('deferred');
    expect(current().lastStatus).toBe('error');
    expect(current().deferredRun).toBeUndefined();
    expect(attempts.filter(attempt => attempt.chatId === 'oc_A')).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.chatId === 'oc_B')).toHaveLength(1);
    const logs = queryScheduleRunLogs(taskId, {}, APP).logs.filter(entry => entry.id === context.runId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ outcome: 'error', targetResults: [
      { chatId: 'oc_A', outcome: 'model_dispatched' }, { chatId: 'oc_B', outcome: 'error' },
    ] });
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts.filter(attempt => attempt.chatId === 'oc_A')).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.chatId === 'oc_B')).toHaveLength(1);
  });

  it('terminally settles a non-TRAE target error without a parked retry storm', async () => {
    const active = sessions();
    expect(scheduler.parkDeferredRun(taskId, context, {
      runId: context.runId, detail: 'TRAE held', targets: { oc_A: 'waiting', oc_B: 'held' },
      heldTargets: { oc_B: turnB }, targetTurnIds: { oc_A: turnA, oc_B: turnB },
    })).toBe(true);
    const attempts: string[] = [];
    const run = productionRunTargets()({ task: current(), executionContext: context, parked: current().deferredRun,
      scheduler, scheduleStore, effectiveAppId: APP, cfg: { cliId: 'traex' },
      randomUUID: () => 'unused', buildUntilDoneRunPrompt: () => undefined,
      scheduleTimeZone: () => 'Asia/Shanghai', executeScheduledTaskForTargets,
      ScheduleTargetExecutionError, activeSessions: active, refreshCliVersion: async () => {},
      precondition: { precondition: 'passed' }, targetResults: undefined,
      resolveScheduleRunLogErrorDetails: (_precondition: unknown, error: unknown) => ({
        error: error instanceof Error ? error.message : String(error), errorCode: 'schedule_target_failed',
      }),
      withBotTurnAdmission: (_app: string, action: () => unknown) => action(),
      getAllBots: () => [{ config: { larkAppId: APP, cliId: 'claude-code' } }],
      executeScheduledTask: async (target: any) => {
        attempts.push(target.chatId);
        throw new Error('permanent target refusal');
      },
    }) as () => Promise<'dispatched' | 'deferred'>;

    expect(await run()).toBe('deferred');
    expect(current().lastStatus).toBe('error');
    expect(current().deferredRun).toBeUndefined();
    expect(current().runStats?.failed).toBe(1);
    const logs = queryScheduleRunLogs(taskId, {}, APP).logs.filter(entry => entry.id === context.runId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ outcome: 'error', errorCode: 'schedule_target_failed', targetResults: [
      { chatId: 'oc_A', outcome: 'error' }, { chatId: 'oc_B', outcome: 'deferred' },
    ] });
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toEqual(['oc_A']);
    expect(queryScheduleRunLogs(taskId, {}, APP).logs.filter(entry => entry.id === context.runId)).toHaveLength(1);
  });
});
