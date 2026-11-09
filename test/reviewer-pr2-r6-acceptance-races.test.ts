import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import * as scheduler from '../src/core/scheduler.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import type { ScheduleExecutionContext } from '../src/core/scheduler.js';
import ts from 'typescript';
import { executeScheduledTaskForTargets, ScheduleTargetExecutionError } from '../src/services/schedule-target-executor.js';

const APP = 'cli_r6_acceptance';
let root: string;
let authority: ScheduleAuthorityStore;
let context: ScheduleExecutionContext;
let taskId: string;
const turnA = 'schedule:r6accept:a';
const turnB = 'schedule:r6accept:b';
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T15:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'botmux-r6-acceptance-'));
  config.session.dataDir = join(root, 'data');
  scheduleStore.setScheduleScope(APP);
  authority = ScheduleAuthorityStore.open(config.session.dataDir);
  authority.initializeApp(APP, []);
  scheduler.setScheduleAuthorityStore(authority);
  scheduler.setOwnerFilter(APP, true);
  const task = scheduler.addTask({ id: 'r6accept', name: 'acceptance race', schedule: 'every 30m',
    prompt: 'check', workingDir: root, chatId: 'oc_A', chatIds: ['oc_A', 'oc_B'],
    larkAppId: APP, repeat: { times: 2, completed: 0 } });
  taskId = task.id;
  scheduler.setExecuteCallback(async (t, c) => {
    context = c;
    scheduler.parkDeferredRun(t.id, c, { runId: c.runId, detail: 'waiting',
      targets: { oc_A: 'waiting', oc_B: 'waiting' }, targetTurnIds: { oc_A: turnA, oc_B: turnB } });
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
function acceptA() {
  expect(scheduler.markDeferredTargetDispatching(taskId, context.runId, 'oc_A', turnA, APP)).toBe(true);
  expect(scheduler.noteWorkerRuntimeAccepted(taskId, context.runId, 'oc_A', turnA, APP)).toBe(true);
}

describe('independent PR2 r6 acceptance ordering', () => {
  it('keeps an exact acceptance when a slower execute callback later marks fork ownership held', () => {
    acceptA();
    // A live worker can ACK a queue send before executeScheduledTask's promise
    // completes its surrounding async work. This is the daemon .then handler.
    scheduler.markDeferredTargetHeld(taskId, context.runId, 'oc_A', turnA, APP);
    expect(current().deferredRun).toMatchObject({ targets: { oc_A: 'dispatched' }, acceptedTargets: { oc_A: turnA } });
    expect(current().deferredRun!.heldTargets?.oc_A).toBeUndefined();
  });

  it('settles once after acceptance arrives while another target is awaiting, without stale re-park restoring held ownership', async () => {
    expect(scheduler.markDeferredTargetDispatching(taskId, context.runId, 'oc_A', turnA, APP)).toBe(true);
    scheduler.markDeferredTargetHeld(taskId, context.runId, 'oc_A', turnA, APP);
    const callbackSnapshot = current().deferredRun!;
    // Daemon captures parked before await; A's true ACK arrives while B waits.
    scheduler.noteWorkerRuntimeAccepted(taskId, context.runId, 'oc_A', turnA, APP);
    scheduler.parkDeferredRun(taskId, context, { runId: context.runId, detail: 'B waiting',
      targets: { oc_A: 'held', oc_B: 'waiting' }, heldTargets: callbackSnapshot.heldTargets,
      targetTurnIds: callbackSnapshot.targetTurnIds });
    scheduler.markDeferredTargetDispatching(taskId, context.runId, 'oc_B', turnB, APP);
    scheduler.noteWorkerRuntimeAccepted(taskId, context.runId, 'oc_B', turnB, APP);
    // A retry must now settle the accepted occurrence, without either send.
    scheduler.setExecuteCallback(async () => 'executed');
    expect(scheduler.runNow(taskId)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(current().lastStatus).toBe('ok');
    expect(current().repeat?.completed).toBe(1);
    expect(current().deferredRun).toBeUndefined();
  });

  it('does not erase an accepted turn when an earlier defer notification is processed late', () => {
    acceptA();
    scheduler.noteWorkerRuntimeDeferred(taskId, context.runId, 'oc_A', turnA, APP);
    expect(current().deferredRun).toMatchObject({ targets: { oc_A: 'dispatched' }, acceptedTargets: { oc_A: turnA } });
    scheduler.recoverDeferredRunOnStartup(taskId, APP);
    expect(current().deferredRun!.targets.oc_A).toBe('dispatched');
  });

  it('does not send accepted A again when its ACK arrives while the real daemon callback awaits B', async () => {
    const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const begin = daemon.indexOf('      const runTargets = async (additionalPrompt?: string)');
    const end = daemon.indexOf('      let outcome: ScheduledTaskPreconditionOutcome;', begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const js = ts.transpileModule(daemon.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const factory = new Function('scope', `with (scope) { ${js}; return runTargets; }`);
    let finishB!: (state: 'deferred') => void;
    const blockerB = new Promise<'deferred'>(resolve => { finishB = resolve; });
    const sent: string[] = [];
    let retry = false;
    function productionCallback() {
      return factory({ task: current(), executionContext: context, parked: current().deferredRun,
        scheduler, scheduleStore, effectiveAppId: APP, cfg: { cliId: 'traex' },
        randomUUID: () => 'unused', buildUntilDoneRunPrompt: () => undefined,
        scheduleTimeZone: () => 'Asia/Shanghai', executeScheduledTaskForTargets,
        ScheduleTargetExecutionError, activeSessions: new Map(), refreshCliVersion: async () => {},
        precondition: { precondition: 'passed' }, targetResults: undefined,
        withBotTurnAdmission: (_app: string, action: () => unknown) => action(),
        executeScheduledTask: async (target: any, _sessions: any, _refresh: any, _prompt: any, runtime: any) => {
          if (!runtime.onBeforeDispatch(runtime.turnId)) return 'deferred';
          if (target.chatId === 'oc_B' && !retry) return blockerB;
          sent.push(target.chatId);
          return 'dispatched';
        },
      }) as () => Promise<'dispatched' | 'deferred'>;
    }
    const first = productionCallback()();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['oc_A']);
    expect(current().deferredRun!.targets.oc_A).toBe('held');
    scheduler.noteWorkerRuntimeAccepted(taskId, context.runId, 'oc_A', turnA, APP);
    finishB('deferred');
    await first;
    retry = true;
    await productionCallback()();
    // Real runTargets must skip A's already accepted exact turn on this retry.
    expect(sent.filter(chat => chat === 'oc_A')).toHaveLength(1);
  });

  it('waits for actual TRAE session acceptance when the bot default is another CLI', async () => {
    const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const begin = daemon.indexOf('      const runTargets = async (additionalPrompt?: string)');
    const end = daemon.indexOf('      let outcome: ScheduledTaskPreconditionOutcome;', begin);
    const js = ts.transpileModule(daemon.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const factory = new Function('scope', `with (scope) { ${js}; return runTargets; }`);
    // A retained session can freeze /cli traex while its bot defaults to
    // claude-code. executeScheduledTask's continuation path honors that
    // session runtime (cliLaunchSnapshot -> session.cliId -> bot config).
    const sessions = new Map(['oc_A', 'oc_B'].map(chatId => [chatId, {
      chatId, session: { cliId: 'traex', cliLaunchSnapshot: { cliId: 'traex' } },
    }]));
    const sent: string[] = [];
    const run = factory({ task: current(), executionContext: context, parked: current().deferredRun,
      scheduler, scheduleStore, effectiveAppId: APP, cfg: { cliId: 'claude-code' },
      randomUUID: () => 'unused', buildUntilDoneRunPrompt: () => undefined,
      scheduleTimeZone: () => 'Asia/Shanghai', executeScheduledTaskForTargets,
      ScheduleTargetExecutionError, activeSessions: sessions, refreshCliVersion: async () => {},
      precondition: { precondition: 'passed' }, targetResults: undefined,
      withBotTurnAdmission: (_app: string, action: () => unknown) => action(),
      executeScheduledTask: async (target: any, active: typeof sessions, _refresh: any, _prompt: any, runtime: any) => {
        expect(active.get(target.chatId)!.session.cliId).toBe('traex');
        if (!runtime.onBeforeDispatch(runtime.turnId)) return 'deferred';
        sent.push(target.chatId);
        // IPC/fork ownership only; actual session worker still waits in its
        // TRAE start gate. No queue/native acceptance has been reported.
        return 'dispatched';
      },
    }) as () => Promise<'dispatched' | 'deferred'>;
    const outcome = await run();
    expect(sent).toHaveLength(2);
    expect(outcome).toBe('deferred');
    expect(current().deferredRun!.acceptedTargets).toBeUndefined();
    expect(current().deferredRun!.targets).toEqual({ oc_A: 'held', oc_B: 'held' });
  });

  it.each([false, true])('classifies the newly selected topic session rather than an unrelated retained chat session (silent=%s)', async silent => {
    const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const begin = daemon.indexOf('      const runTargets = async (additionalPrompt?: string)');
    const end = daemon.indexOf('      let outcome: ScheduledTaskPreconditionOutcome;', begin);
    const js = ts.transpileModule(daemon.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const factory = new Function('scope', `with (scope) { ${js}; return runTargets; }`);
    const sessions = new Map<string, any>(['oc_A', 'oc_B'].map(chatId => [ `${chatId}::${APP}`, {
      larkAppId: APP, chatId, session: { cliId: 'claude-code', status: 'active', scope: 'chat' },
    }]));
    const opened: string[] = [];
    const run = factory({ task: { ...current(), executionPosition: 'new-topic', silent },
      executionContext: context, parked: current().deferredRun, scheduler, scheduleStore,
      effectiveAppId: APP, cfg: { cliId: 'traex' }, randomUUID: () => 'unused',
      buildUntilDoneRunPrompt: () => undefined, scheduleTimeZone: () => 'Asia/Shanghai',
      executeScheduledTaskForTargets, ScheduleTargetExecutionError, activeSessions: sessions,
      refreshCliVersion: async () => {}, precondition: { precondition: 'passed' }, targetResults: undefined,
      withBotTurnAdmission: (_app: string, action: () => unknown) => action(),
      executeScheduledTask: async (target: any, active: typeof sessions, _refresh: any, _prompt: any, runtime: any) => {
        if (!runtime.onBeforeDispatch(runtime.turnId)) return 'deferred';
        // New-topic routing creates its own fresh session; the old chat-scope
        // session is NOT the owner of this scheduled turn.
        const anchor = silent ? `schedule-run:${taskId}:${runtime.turnId.split(':').at(-1)}` : `om_new_${target.chatId}`;
        active.set(`${anchor}::${APP}`, { larkAppId: APP, chatId: target.chatId,
          session: { cliId: 'traex', rootMessageId: anchor,
            scheduledRun: { runId: context.runId, turnId: runtime.turnId } } });
        opened.push(anchor);
        // The newly spawned TRAE worker owns the input but awaits the gate.
        // No acceptance receipt has been received.
        return 'dispatched';
      },
    }) as () => Promise<'dispatched' | 'deferred'>;
    const outcome = await run();
    expect(opened).toHaveLength(2);
    expect(outcome).toBe('deferred');
    expect(current().deferredRun!.acceptedTargets).toBeUndefined();
  });
});
