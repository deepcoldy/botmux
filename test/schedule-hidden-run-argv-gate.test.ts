/**
 * #1607: the worker holds a hidden schedule run's first idle until the CLI's
 * own store shows it took the argv-baked prompt, and when the store never does
 * within the grace it reports the turn undelivered before letting the idle
 * through — otherwise the daemon would close the run as a quiet success.
 *
 * The real-worker path is in schedule-hidden-run-first-idle.integration.test.ts;
 * these cases run the worker's real gate functions (worker-function harness)
 * for what that path cannot reach in test time: the 90s grace expiring.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE } from '../src/core/deferred-schedule-settlement.js';

const TURN = 'schedule:task-1607:run';

function gateScope(opts: {
  recorded: () => boolean;
  deadlineMs: number;
  evidence?: boolean;
  pi?: boolean;
  /** The store read fails (the adapter says so) instead of answering. */
  unreadable?: boolean;
}) {
  const scope: Record<string, any> = {
    spawnArgvNeedsWorkingSeed: true,
    spawnArgvInitialPromptBusy: false,
    spawnArgvTurnStartEvidenceSeen: false,
    spawnArgvTurnStartEvidenceDeadlineMs: opts.deadlineMs,
    structuredBridgeIs: (id: string) => opts.pi === true && id === 'pi',
    spawnArgvSubmissionEvidence: opts.evidence === false ? undefined : {
      adapter: {
        findInitialPromptArgSubmission: () => (opts.unreadable
          ? { submitted: false, unreadable: true }
          : { submitted: opts.recorded() }),
      },
      baseline: 100,
      content: 'scheduled prompt',
      turnId: TURN,
    },
  };
  scope.argvSubmissionState = loadWorkerFunction('argvSubmissionState', scope);
  scope.argvSubmissionRecorded = loadWorkerFunction('argvSubmissionRecorded', scope);
  return scope;
}

describe('hidden schedule run: first idle waits for the CLI store', () => {
  it('holds while the store has not recorded the prompt, and latches once it has', () => {
    let recorded = false;
    const scope = gateScope({ recorded: () => recorded, deadlineMs: Date.now() + 60_000 });
    const holds = loadWorkerFunction<() => boolean>('spawnArgvTurnStartGateHolds', scope);

    expect(holds()).toBe(true);
    recorded = true;
    expect(holds()).toBe(false);
    expect(scope.spawnArgvTurnStartEvidenceSeen).toBe(true);
    recorded = false;
    expect(holds()).toBe(false);
  });

  it('stops holding at the grace deadline', () => {
    const scope = gateScope({ recorded: () => false, deadlineMs: Date.now() - 1 });
    expect(loadWorkerFunction<() => boolean>('spawnArgvTurnStartGateHolds', scope)()).toBe(false);
  });

  it('leaves a session without store evidence on its old first idle', () => {
    const scope = gateScope({ recorded: () => false, deadlineMs: Date.now() + 60_000, evidence: false });
    expect(loadWorkerFunction<() => boolean>('spawnArgvTurnStartGateHolds', scope)()).toBe(false);
  });

  it('treats an unreadable store as no record yet', () => {
    const scope = gateScope({ recorded: () => { throw new Error('database is locked'); }, deadlineMs: Date.now() + 60_000 });
    expect(loadWorkerFunction<() => boolean>('spawnArgvTurnStartGateHolds', scope)()).toBe(true);
  });
});

describe('hidden schedule run: grace expiry', () => {
  function failOpenScope(recorded: boolean, store: { unreadable?: boolean; throws?: boolean } = {}) {
    const order: string[] = [];
    let fire: (() => void) | undefined;
    const backend = {};
    const scope = gateScope({
      recorded: () => {
        if (store.throws) throw new Error('database is locked');
        return recorded;
      },
      deadlineMs: Date.now(),
      unreadable: store.unreadable,
    });
    Object.assign(scope, {
      spawnArgvTurnStartFailOpenTimer: null,
      backend,
      cliSpawnGeneration: 3,
      isPromptReady: false,
      lastPtyOutputAtMs: 0,
      SPAWN_ARGV_FAIL_OPEN_QUIET_MS: 2_000,
      SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE,
      log: () => {},
      emitTurnTerminal: vi.fn((turnId: string, status: string, code: string) => order.push(`terminal:${turnId}:${status}:${code}`)),
      idleDetector: { fireIdle: () => order.push('idle') },
      setTimeout: (callback: () => void) => { fire = callback; return { unref() {} }; },
    });
    scope.scheduleSpawnArgvTurnStartFailOpen = loadWorkerFunction('scheduleSpawnArgvTurnStartFailOpen', scope);
    scope.scheduleSpawnArgvTurnStartFailOpen(1);
    return { order, scope, expire: () => fire!() };
  }

  it('reports the turn undelivered before releasing the idle when the store never recorded the prompt', () => {
    const { order, expire } = failOpenScope(false);
    expire();
    expect(order).toEqual([`terminal:${TURN}:failed:${SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE}`, 'idle']);
  });

  it('only releases the idle when the store has the prompt after all', () => {
    const { order, expire } = failOpenScope(true);
    expire();
    expect(order).toEqual(['idle']);
  });

  // A failed read is no evidence the prompt never arrived: the run may well be
  // executing. No verdict, so neither the run log nor the chat says it did not run.
  it('reports no verdict when the store cannot be read at expiry', () => {
    const { order, expire } = failOpenScope(false, { unreadable: true });
    expire();
    expect(order).toEqual(['idle']);
  });

  it('reports no verdict when reading the store throws at expiry', () => {
    const { order, expire } = failOpenScope(false, { throws: true });
    expire();
    expect(order).toEqual(['idle']);
  });
});

describe('hidden schedule run: which spawns wait on the CLI store', () => {
  const adapter = { findInitialPromptArgSubmission: () => ({ submitted: false }) };
  const hiddenRunSubmissionEvidence = loadWorkerFunction<(input: Record<string, unknown>) => unknown>(
    'hiddenRunSubmissionEvidence',
    {},
  );
  const spawn = (overrides: Record<string, unknown> = {}) => hiddenRunSubmissionEvidence({
    hiddenRun: true,
    promptViaArgv: true,
    prompt: 'scheduled prompt',
    baseline: 100,
    adapter,
    turnId: TURN,
    ...overrides,
  });

  it('a hidden run with an argv prompt and a readable store waits for that prompt', () => {
    expect(spawn()).toEqual({ adapter, baseline: 100, content: 'scheduled prompt', turnId: TURN });
  });

  it('an ordinary session keeps its first idle, so it can never be reported undelivered', () => {
    expect(spawn({ hiddenRun: false })).toBeUndefined();
  });

  it('nothing to wait for without an argv prompt, a readable store, or a CLI that records submits', () => {
    expect(spawn({ promptViaArgv: false })).toBeUndefined();
    expect(spawn({ prompt: undefined })).toBeUndefined();
    expect(spawn({ baseline: null })).toBeUndefined();
    expect(spawn({ adapter: {} })).toBeUndefined();
  });
});
