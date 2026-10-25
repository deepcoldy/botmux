import { describe, expect, it } from 'vitest';
import { traexCapacityQueueVisible, traexCapacityQueuePosition, traexModelProgressVisible } from '../src/adapters/cli/traex.js';
import {
  normalizeTraexAutoModelConfig,
  TraexAutoModelController,
  TRAEX_AUTO_MODEL_DEFAULT_QUEUE_TIMEOUT_MS,
  resolveTraexAutoModelSettings,
  validTraexAutoModelRuntime,
  traexAutoModelPolicyKey,
} from '../src/services/traex-auto-model.js';

describe('normalizeTraexAutoModelConfig', () => {
  it('keeps an ordered five-model allowlist and supplies the default timeout', () => {
    expect(normalizeTraexAutoModelConfig({
      enabled: true,
      models: ['m-core', 'm-fast', 'm-3', 'm-4', 'm-last'],
    })).toEqual({
      config: {
        enabled: true,
        models: ['m-core', 'm-fast', 'm-3', 'm-4', 'm-last'],
        queueTimeoutMs: TRAEX_AUTO_MODEL_DEFAULT_QUEUE_TIMEOUT_MS,
      },
    });
  });

  it('treats missing or disabled config as feature-off', () => {
    expect(normalizeTraexAutoModelConfig(undefined)).toEqual({});
    expect(normalizeTraexAutoModelConfig({ enabled: false, models: ['m1'] })).toEqual({});
  });

  it('rejects duplicate, virtual-auto, empty and out-of-range pools', () => {
    expect(normalizeTraexAutoModelConfig({
      enabled: true,
      models: ['M1', 'm1'],
    }).error).toContain('duplicate');
    expect(normalizeTraexAutoModelConfig({
      enabled: true,
      models: ['auto'],
    }).error).toContain('virtual auto');
    expect(normalizeTraexAutoModelConfig({
      enabled: true,
      models: [],
    }).error).toContain('at least one');
    expect(normalizeTraexAutoModelConfig({
      enabled: true,
      models: ['m1'],
      queueTimeoutMs: 4_999,
    }).error).toContain('between');
    expect(normalizeTraexAutoModelConfig({ enabled: true, models: ['m1'], reselectPerTurn: 'false' }).error).toContain('boolean');
  });
  it('accepts the full catalog and preserves per-model settings independently', () => {
    const models = Array.from({ length: 50 }, (_, index) => `model-${index}`);
    const settings = { 'model-0': { reasoningEffort: 'xhigh', modelBackendVariant: 'max' }, 'model-49': {} };
    const parsed = normalizeTraexAutoModelConfig({ enabled: true, models, modelSettings: settings });
    expect(parsed.error).toBeUndefined();
    expect(parsed.config?.models).toHaveLength(50);
    expect(resolveTraexAutoModelSettings(parsed.config!, 'MODEL-0')).toEqual(settings['model-0']);
    expect(resolveTraexAutoModelSettings(parsed.config!, 'model-49', { reasoningEffort: 'high', modelBackendVariant: 'max' })).toEqual({});
    expect(normalizeTraexAutoModelConfig({ enabled: true, models, modelSettings: { outside: {} } }).error).toContain('invalid model entry');
  });
});

describe('TraexAutoModelController', () => {
  const config = {
    enabled: true as const,
    models: ['core', 'backup-1', 'backup-2'],
    queueTimeoutMs: 10_000,
    switchCooldownMs: 5_000,
    reselectPerTurn: true,
  };
  function withoutLoads(controller: TraexAutoModelController) {
    controller.beginTurn('turn-1');
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: -20_000 });
    const check = controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: -10_000 });
    expect(check.kind).toBe('load_check');
    controller.resolveModelLoads('turn-1', null);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: false, nowMs: -1 });
  }
  function observeWithoutLoads(controller: TraexAutoModelController, input: {
    turnId: string; queued: boolean; nowMs: number; queuePosition?: number;
  }) {
    const action = controller.observeCapacityQueue(input);
    if (action.kind !== 'load_check') return action;
    controller.resolveModelLoads(input.turnId, null);
    return controller.observeCapacityQueue(input);
  }
  function checkLoads(controller: TraexAutoModelController, nowMs: number, loads: ReadonlyMap<string, number> | null) {
    const turnId = controller.currentTurnId()!;
    controller.observeCapacityQueue({ turnId, queued: true, nowMs });
    expect(controller.observeCapacityQueue({ turnId, queued: true, nowMs: nowMs + 10_000 }).kind).toBe('load_check');
    return controller.resolveModelLoads(turnId, loads);
  }

  it('switches downward only after the configured queue duration', () => {
    const controller = new TraexAutoModelController(config);
    withoutLoads(controller);
    expect(controller.observeCapacityQueue({
      turnId: 'turn-1', queued: true, nowMs: 1_000,
    })).toEqual({ kind: 'none' });
    expect(controller.observeCapacityQueue({
      turnId: 'turn-1', queued: true, nowMs: 10_999,
    })).toEqual({ kind: 'none' });
    expect(observeWithoutLoads(controller, {
      turnId: 'turn-1', queued: true, nowMs: 11_000,
    })).toEqual({
      kind: 'switch',
      reason: 'capacity_timeout',
      turnId: 'turn-1',
      fromModel: 'core',
      toModel: 'backup-1',
      toIndex: 1,
    });
  });

  it('stops on the final allowlisted model and reports exhaustion only once', () => {
    const controller = new TraexAutoModelController({
      ...config,
      models: ['core', 'last'],
      queueTimeoutMs: 5_000,
    });
    withoutLoads(controller);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 0 });
    const firstSwitch = controller.observeCapacityQueue({
      turnId: 'turn-1', queued: true, nowMs: 5_000,
    });
    expect(firstSwitch.kind).toBe('switch');
    if (firstSwitch.kind === 'switch') controller.commitSwitch(firstSwitch, 5_000);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 6_000 });
    expect(observeWithoutLoads(controller, {
      turnId: 'turn-1', queued: true, nowMs: 11_000,
    })).toEqual({
      kind: 'exhausted',
      turnId: 'turn-1',
      model: 'last',
      modelCount: 2,
    });
    expect(controller.observeCapacityQueue({
      turnId: 'turn-1', queued: true, nowMs: 30_000,
    })).toEqual({ kind: 'none' });
    expect(controller.currentModel()).toBe('last');
  });

  it('returns to the core model when a new turn starts after fallback', () => {
    const controller = new TraexAutoModelController({
      ...config,
      queueTimeoutMs: 5_000,
    });
    withoutLoads(controller);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 0 });
    const action = controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 5_000 });
    if (action.kind === 'switch') controller.commitSwitch(action);
    expect(controller.currentModel()).toBe('backup-1');
    const reset = controller.beginTurn('turn-2');
    expect(reset).toEqual({
      kind: 'switch',
      reason: 'new_turn',
      turnId: 'turn-2',
      fromModel: 'backup-1',
      toModel: 'core',
      toIndex: 0,
    });
    expect(controller.currentModel()).toBe('backup-1');
    if (reset.kind === 'switch') controller.commitSwitch(reset);
    expect(controller.currentModel()).toBe('core');
  });

  it('does not change the model for a refused proposal or stale turn', () => {
    const controller = new TraexAutoModelController(config);
    withoutLoads(controller);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 0 });
    const action = controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 10_000 });
    expect(action.kind).toBe('switch');
    expect(controller.currentModel()).toBe('core');
    controller.endTurn('turn-1');
    if (action.kind === 'switch') expect(controller.commitSwitch(action)).toBe(false);
    expect(controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 90_000 })).toEqual({ kind: 'none' });
  });

  it('requires a sustained queue and ignores evidence belonging to a different turn', () => {
    const controller = new TraexAutoModelController(config);
    withoutLoads(controller);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 0 });
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: false, nowMs: 9_000 });
    expect(controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 10_000 })).toEqual({ kind: 'none' });
    expect(controller.observeCapacityQueue({ turnId: 'other', queued: true, nowMs: 50_000 })).toEqual({ kind: 'none' });
  });

  it('uses minimum load only when all backups are busy, then holds without cycles', () => {
    const controller = new TraexAutoModelController(config);
    controller.beginTurn('turn-1');
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 0 });
    expect(controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 10_000 }).kind).toBe('load_check');
    const action = controller.resolveModelLoads('turn-1', new Map([
      ['core', 180], ['backup-1', 140], ['backup-2', 120], ['outside', 0],
    ]));
    expect(action).toMatchObject({ kind: 'switch', reason: 'lowest_load', toModel: 'backup-2', loadPercent: 120 });
    if (action.kind === 'switch') controller.commitSwitch(action, 10_000);
    expect(controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 100_000 })).toEqual({ kind: 'none' });
    expect(controller.beginTurn('turn-2')).toMatchObject({ kind: 'switch', toModel: 'core' });
  });

  it.each([100, 50])('prefers the second model at 100%% over the third at %s%%', thirdLoad => {
    const controller = new TraexAutoModelController(config);
    controller.beginTurn('turn-1');
    const action = checkLoads(controller, 0, new Map([
      ['core', 300], ['backup-1', 100], ['backup-2', thirdLoad], ['outside', 0],
    ]));
    expect(action).toMatchObject({ kind: 'switch', reason: 'available_model',
      toModel: 'backup-1', loadPercent: 100 });
  });

  it('skips a busy second model and selects the third available model', () => {
    const controller = new TraexAutoModelController(config);
    controller.beginTurn('turn-1');
    expect(checkLoads(controller, 0, new Map([
      ['core', 300], ['backup-1', 101], ['backup-2', 100],
    ]))).toMatchObject({ kind: 'switch', reason: 'available_model', toModel: 'backup-2' });
  });

  it('continues to a later backup if the earlier available backup actually queues', () => {
    const controller = new TraexAutoModelController(config);
    controller.beginTurn('turn-1');
    const loads = new Map([['core', 300], ['backup-1', 100], ['backup-2', 100]]);
    const second = checkLoads(controller, 0, loads);
    if (second.kind === 'switch') expect(controller.commitSwitch(second, 10_000)).toBe(true);
    expect(controller.currentModel()).toBe('backup-1');
    // Actual sustained queueing outranks the earlier availability snapshot.
    const third = checkLoads(controller, 11_000, loads);
    expect(third).toMatchObject({ kind: 'switch', reason: 'available_model', toModel: 'backup-2' });
    if (third.kind === 'switch') controller.commitSwitch(third, 21_000);
    // End-of-pool: stable preference breaks the final load tie, then no cycles.
    const hold = checkLoads(controller, 22_000, loads);
    expect(hold).toMatchObject({ kind: 'switch', reason: 'lowest_load', toModel: 'backup-1' });
    if (hold.kind === 'switch') controller.commitSwitch(hold, 32_000);
    expect(controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 100_000 })).toEqual({ kind: 'none' });
    controller.endTurn('turn-1');
    const reset = controller.beginTurn('turn-2');
    expect(reset).toMatchObject({ kind: 'switch', reason: 'new_turn', toModel: 'core' });
    if (reset.kind === 'switch') controller.commitSwitch(reset, 110_000);
    expect(checkLoads(controller, 120_000, loads)).toMatchObject({ kind: 'switch', toModel: 'backup-1' });
  });

  it('preserves preference for ties when all loads exceed 100%', () => {
    const controller = new TraexAutoModelController(config);
    controller.beginTurn('turn-1');
    expect(checkLoads(controller, 0, new Map([
      ['core', 300], ['backup-1', 180], ['backup-2', 180],
    ]))).toMatchObject({ kind: 'switch', reason: 'lowest_load', toModel: 'backup-1' });
  });

  it('tries an earlier unknown load before a later available model without inventing zero load', () => {
    const controller = new TraexAutoModelController(config);
    controller.beginTurn('turn-1');
    expect(checkLoads(controller, 0, new Map([
      ['core', 300], ['backup-2', 20],
    ]))).toEqual({ kind: 'switch', reason: 'capacity_timeout', turnId: 'turn-1',
      fromModel: 'core', toModel: 'backup-1', toIndex: 1 });
  });

  it('ignores a load response after queueing ends or a different turn starts', () => {
    const controller = new TraexAutoModelController(config);
    controller.beginTurn('turn-1');
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 0 });
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 10_000 });
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: false, nowMs: 11_000 });
    const loads = new Map([['core', 300], ['backup-1', 100], ['backup-2', 10]]);
    expect(controller.resolveModelLoads('turn-1', loads)).toEqual({ kind: 'none' });
    controller.beginTurn('turn-2');
    expect(controller.resolveModelLoads('turn-1', loads)).toEqual({ kind: 'none' });
    expect(checkLoads(controller, 12_000, loads)).toMatchObject({ kind: 'switch', toModel: 'backup-1' });
  });

  it('skips the cooldown within a fallback search and picks the best observed queue rank', () => {
    const controller = new TraexAutoModelController({ ...config, models: ['core', 'backup-1'], switchCooldownMs: 60_000 });
    withoutLoads(controller);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 0, queuePosition: 1590 });
    const action = controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 10_000, queuePosition: 1590 });
    if (action.kind === 'switch') controller.commitSwitch(action, 10_000);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 11_000, queuePosition: 2000 });
    expect(observeWithoutLoads(controller, { turnId: 'turn-1', queued: true, nowMs: 12_000, queuePosition: 2000 }))
      .toMatchObject({ kind: 'switch', reason: 'shortest_queue', toModel: 'core', queuePosition: 1590 });
  });

  it('keeps the selected model and final wait across turns by default, and restores only matching sessions/policies', () => {
    const policy = { ...config, reselectPerTurn: false };
    const controller = new TraexAutoModelController(policy);
    controller.beginTurn('turn-1');
    const action = checkLoads(controller, 0, new Map([['core', 200], ['backup-1', 120], ['backup-2', 140]]));
    if (action.kind === 'switch') controller.commitSwitch(action, 10_000);
    expect(controller.currentModel()).toBe('backup-1');
    controller.endTurn('turn-1');
    expect(controller.beginTurn('turn-2')).toEqual({ kind: 'none' });
    expect(controller.observeCapacityQueue({ turnId: 'turn-2', queued: true, nowMs: 100_000 })).toEqual({ kind: 'none' });
    expect(controller.observeCapacityQueue({ turnId: 'turn-2', queued: true, nowMs: 200_000 })).toEqual({ kind: 'none' });
    const state = controller.runtimeState('native');
    expect(validTraexAutoModelRuntime(policy, state, 'native')).toBe(true);
    expect(validTraexAutoModelRuntime(policy, state, 'other')).toBe(false);
    expect(validTraexAutoModelRuntime({ ...policy, models: [...policy.models].reverse() }, state, 'native')).toBe(false);
    const restored = new TraexAutoModelController(policy, state);
    expect(restored.currentModel()).toBe('backup-1');
    restored.beginTurn('after-restart');
    expect(restored.observeCapacityQueue({ turnId: 'after-restart', queued: true, nowMs: 999_000 })).toEqual({ kind: 'none' });
    expect(new TraexAutoModelController(policy).currentModel()).toBe('core');
  });

  it('keeps a working backup across inputs, but a new sustained queue starts another search', () => {
    const controller = new TraexAutoModelController({ ...config, reselectPerTurn: false, switchCooldownMs: 60_000 });
    controller.beginTurn('turn-1');
    const loads = new Map([['core', 200], ['backup-1', 100], ['backup-2', 50]]);
    const action = checkLoads(controller, 0, loads);
    if (action.kind === 'switch') controller.commitSwitch(action, 10_000);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: false, progressing: true, nowMs: 11_000 });
    controller.endTurn('turn-1');
    expect(controller.beginTurn('turn-2')).toEqual({ kind: 'none' });
    controller.observeCapacityQueue({ turnId: 'turn-2', queued: true, nowMs: 60_000 });
    expect(controller.observeCapacityQueue({ turnId: 'turn-2', queued: true, nowMs: 60_999 })).toEqual({ kind: 'none' });
    expect(controller.observeCapacityQueue({ turnId: 'turn-2', queued: true, nowMs: 70_000 }).kind).toBe('load_check');
    expect(controller.resolveModelLoads('turn-2', loads)).toMatchObject({ kind: 'switch', toModel: 'backup-2' });
  });

  it('uses a one-second backup queue confirmation even with a 30s timeout and 60s cooldown', () => {
    const controller = new TraexAutoModelController({ ...config, queueTimeoutMs: 30_000, switchCooldownMs: 60_000 });
    controller.beginTurn('turn-1');
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 0 });
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 30_000 });
    const loads = new Map([['core', 200], ['backup-1', 100], ['backup-2', 50]]);
    const action = controller.resolveModelLoads('turn-1', loads);
    if (action.kind === 'switch') controller.commitSwitch(action, 30_000);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 31_000 });
    expect(controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 31_999 })).toEqual({ kind: 'none' });
    expect(controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 32_000 }).kind).toBe('load_check');
    expect(controller.resolveModelLoads('turn-1', loads)).toMatchObject({ kind: 'switch', toModel: 'backup-2' });
  });

  it('returns to the normal timeout when a backup actually worked before queueing again in the same turn', () => {
    const controller = new TraexAutoModelController({ ...config, queueTimeoutMs: 30_000, switchCooldownMs: 60_000 });
    controller.beginTurn('turn-1');
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 0 });
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 30_000 });
    const loads = new Map([['core', 200], ['backup-1', 100], ['backup-2', 50]]);
    const action = controller.resolveModelLoads('turn-1', loads);
    if (action.kind === 'switch') controller.commitSwitch(action, 30_000);
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: false, progressing: true, nowMs: 40_000 });
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: false, progressing: true, nowMs: 42_000 });
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 90_000 });
    expect(controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 91_000 })).toEqual({ kind: 'none' });
    expect(controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: 120_000 }).kind).toBe('load_check');
  });
});

describe('traexCapacityQueueVisible', () => {
  it('detects actual working footer frames without treating queue or quoted text as progress', () => {
    expect(traexModelProgressVisible('◆ Working… (12s • esc to interrupt)')).toBe(true);
    expect(traexModelProgressVisible('⠋ Deep in thought…')).toBe(true);
    expect(traexModelProgressVisible('A user wrote ◆ Working… (12s • esc to interrupt)')).toBe(false);
    expect(traexModelProgressVisible('◆ Queued for capacity (12s • esc to interrupt)')).toBe(false);
  });
  it('matches the observed capacity queue forms', () => {
    expect(traexCapacityQueueVisible(
      "◆ Queued for capacity (51s • esc to interrupt)\n"
      + "  └ Too many requests right now. You're in the queue at position 1590.",
    )).toBe(true);
    expect(traexCapacityQueuePosition("◆ Queued for capacity (51s • esc to interrupt)\n  └ Too many requests right now. You're in the queue at position 1590.")).toBe(1590);
    expect(traexCapacityQueuePosition("◆ Queued for capacity (51s • esc to interrupt)")).toBeUndefined();
    expect(traexCapacityQueueVisible(
      "\nToo many requests right now. You're in the queue.\n",
    )).toBe(true);
  });

  it('does not treat ordinary work or next-turn parking as capacity pressure', () => {
    expect(traexCapacityQueueVisible('\nQueued for next turn\n')).toBe(false);
    expect(traexCapacityQueueVisible('\n◆ Working… (12s • esc to interrupt)\n')).toBe(false);
    expect(traexCapacityQueueVisible('The UI may say Queued for capacity sometimes.')).toBe(false);
    expect(traexCapacityQueueVisible('A user wrote: You\'re in the queue at position 12.')).toBe(false);
    expect(traexCapacityQueueVisible('Queued for capacity')).toBe(false);
    expect(traexCapacityQueueVisible('◆ Queued for capacity (51s • esc to interrupt)\n' + '\n'.repeat(13) + '❯ Ready')).toBe(false);
  });
});


describe('controller switch source consistency', () => {
  it.each(['queue', 'progress', 'terminal'] as const)('ends capacity-transition admission only on model %s evidence', evidence => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'], queueTimeoutMs: 5_000 });
    controller.beginTurn('turn');
    expect(controller.awaitingModelActivity()).toBe(false);
    controller.commitSwitch({ kind: 'switch', reason: 'capacity_timeout', turnId: 'turn',
      fromModel: 'core', toModel: 'backup', toIndex: 1 });
    expect(controller.awaitingModelActivity()).toBe(true);
    controller.observeCapacityQueue({ turnId: 'turn', queued: false, nowMs: 1 });
    controller.observeCapacityQueue({ turnId: 'stale', queued: true, nowMs: 2 });
    expect(controller.awaitingModelActivity()).toBe(true);
    if (evidence === 'terminal') controller.endTurn('turn');
    else controller.observeCapacityQueue({ turnId: 'turn', queued: evidence === 'queue', progressing: evidence === 'progress', nowMs: 3 });
    expect(controller.awaitingModelActivity()).toBe(false);
  });

  it('can admit an already-dequeued turn on the running model without repeating a preferred-model reset', () => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'],
      queueTimeoutMs: 5_000, reselectPerTurn: true });
    controller.observeRunningModel('backup');
    expect(controller.beginTurn('next').kind).toBe('switch');
    expect(controller.beginTurn('next', { retainCurrentModel: true })).toEqual({ kind: 'none' });
    expect(controller.currentModel()).toBe('backup');
    expect(controller.currentTurnId()).toBe('next');
    expect(controller.beginTurn('next')).toEqual({ kind: 'none' });
    // Only the write-edge fallback skips reselection; a later independent turn
    // must still obey the configured preferred-model policy.
    expect(controller.beginTurn('later')).toMatchObject({ kind: 'switch', toModel: 'core' });
  });

  it('rejects a proposal after the observed model changes without advancing the controller', () => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup', 'last'], queueTimeoutMs: 5_000 });
    controller.beginTurn('turn');
    controller.observeRunningModel('backup');
    expect(controller.commitSwitch({ kind: 'switch', reason: 'capacity_timeout', turnId: 'turn',
      fromModel: 'core', toModel: 'last', toIndex: 2 }, 10_000)).toBe(false);
    expect(controller.currentModel()).toBe('backup');
    expect(controller.commitSwitch({ kind: 'switch', reason: 'capacity_timeout', turnId: 'turn',
      fromModel: 'backup', toModel: 'last', toIndex: 2 }, 10_000)).toBe(true);
    expect(controller.currentModel()).toBe('last');
  });
});


describe('hand-written Auto settings and recovery defaults', () => {
  it.each(['seed-code', 'gpt-6-astra', 'future-live-model'])('leaves capability decisions to the live catalog for %s', model => {
    const pool = { enabled: true, models: [model, 'gpt-5.6-sol'],
      modelSettings: { [model]: { reasoningEffort: 'ultra', modelBackendVariant: 'max' },
        'gpt-5.6-sol': { reasoningEffort: 'xhigh' } } };
    expect(normalizeTraexAutoModelConfig(pool).config).toMatchObject(pool);
    expect(normalizeTraexAutoModelConfig({ enabled: true, models: [model], modelSettings: { [model]: {} } }).error)
      .toBeUndefined();
  });
  it('persists an independent copy of shared settings through native recovery', () => {
    const config = { enabled: true as const, models: ['core', 'backup'], queueTimeoutMs: 5_000 };
    const shared = { reasoningEffort: 'low' as const, modelBackendVariant: 'standard' as const };
    const controller = new TraexAutoModelController(config, undefined, shared);
    controller.observeRunningModel('backup');
    const state = controller.runtimeState('native');
    shared.reasoningEffort = 'high' as any;
    const restored = new TraexAutoModelController(config, state, { reasoningEffort: 'high', modelBackendVariant: 'max' });
    expect(resolveTraexAutoModelSettings(restored.config, 'backup', restored.sharedSettings)).toEqual({ reasoningEffort: 'low', modelBackendVariant: 'standard' });
    expect(restored.currentModel()).toBe('backup');
  });
});


describe('current footer capacity evidence', () => {
  it.each([16, 80])('finds live capacity above a native pending panel with %i lines', count => {
    const queue = "◇ Queued for capacity (3h 34m 43s • esc to interrupt)\n  └ Too many requests right now. You're in the queue at position 41.";
    const panel = ['Send after tool call · esc to interrupt and send · ↑ to edit',
      ...Array.from({ length: count }, (_, index) => `› pending ${index}`), '────────',
      '❯ Summarize recent commits', 'GPT-6-Astra (MAX) xhigh · ~ · Context —',
      'Full Access · ? for shortcuts'].join('\n');
    expect(traexCapacityQueueVisible(`${queue}\n${panel}`)).toBe(true);
    expect(traexCapacityQueuePosition(`${queue}\n${panel}`)).toBe(41);
    expect(traexModelProgressVisible(`${queue}\n${panel}`)).toBe(false);
    expect(traexCapacityQueueVisible(`${queue}\n◆ Working… (2s • esc to interrupt)\n${panel}`)).toBe(false);
    expect(traexCapacityQueueVisible(`${queue}\n${panel.replace('Send after', '  Send after')}`)).toBe(false);
    expect(traexCapacityQueueVisible(`${queue}\n${panel.replace('GPT-6-Astra (MAX) xhigh · ~ · Context —', 'unrecognized footer')}`)).toBe(false);
  });

  it('holds after a fresh submission until matching activity or terminal evidence', () => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'], queueTimeoutMs: 5_000 });
    controller.beginTurn('first');
    expect(controller.awaitingModelActivity()).toBe(false);
    controller.markInputSubmitted('first');
    controller.observeCapacityQueue({ turnId: 'first', queued: false, nowMs: 0 });
    expect(controller.awaitingModelActivity()).toBe(true);
    controller.observeCapacityQueue({ turnId: 'stale', queued: false, progressing: true, nowMs: 1 });
    expect(controller.awaitingModelActivity()).toBe(true);
    controller.observeCapacityQueue({ turnId: 'first', queued: false, progressing: true, nowMs: 2 });
    expect(controller.awaitingModelActivity()).toBe(false);
    controller.markInputSubmitted('stale');
    expect(controller.awaitingModelActivity()).toBe(false);
    controller.markInputSubmitted('first');
    controller.endTurn('first');
    expect(controller.awaitingModelActivity()).toBe(false);
  });

  it('disarms the activity latch on a crash exit but keeps it for a planned switch', () => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'], queueTimeoutMs: 5_000 });
    controller.beginTurn('turn');
    controller.markInputSubmitted('turn');
    controller.observeCapacityQueue({ turnId: 'turn', queued: false, nowMs: 0 });
    expect(controller.awaitingModelActivity()).toBe(true);
    // A planned model switch's replacement owns the same waiting window.
    controller.noteProcessExited(true);
    expect(controller.awaitingModelActivity()).toBe(true);
    // A genuine crash can never paint the frame the dead process owed.
    controller.noteProcessExited(false);
    expect(controller.awaitingModelActivity()).toBe(false);
  });
  it('does not switch during a long ordinary reasoning interval', () => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'], queueTimeoutMs: 5_000 });
    controller.beginTurn('turn');
    for (const nowMs of [0, 5_000, 30_000, 90_000, 600_000]) {
      const screen = '⠋ Thinking longer… (10m • esc to interrupt)';
      expect(controller.observeCapacityQueue({ turnId: 'turn', nowMs,
        queued: traexCapacityQueueVisible(screen), progressing: traexModelProgressVisible(screen) })).toEqual({ kind: 'none' });
    }
    expect(controller.currentModel()).toBe('core');
  });
  it('uses the newest activity row when an old queue notice remains visible', () => {
    const queued = "◆ Queued for capacity (51s • esc to interrupt)\n  └ Too many requests right now. You're in the queue at position 1590.";
    expect(traexCapacityQueueVisible(queued + '\n⠋ Deep in thought… (2m • esc to interrupt)\nContext 89% left')).toBe(false);
    expect(traexModelProgressVisible(queued + '\n⠋ Deep in thought… (2m • esc to interrupt)')).toBe(true);
    expect(traexCapacityQueueVisible('⠋ Deep in thought…\n' + queued)).toBe(true);
  });
});


describe('Auto policy setting presence', () => {
  it('distinguishes inherited settings from an explicit native-default entry', () => {
    const base = { enabled: true as const, models: ['core', 'backup'], queueTimeoutMs: 30_000 };
    expect(traexAutoModelPolicyKey(base)).not.toBe(traexAutoModelPolicyKey({ ...base, modelSettings: { backup: {} } }));
  });
});

describe('capacityCurrentlyBlocking contract (pane ownership across a terminal)', () => {
  // The worker tags an incoming message with queueAfterActiveTurn from this
  // predicate. A structured terminal does NOT repaint the pane, so the queued
  // pane fact must survive endTurn — otherwise a follow-up landing between
  // turn_terminal and the next prompt_ready is written into the degraded pane.
  const base = { enabled: true as const, models: ['core', 'backup-1', 'backup-2'],
    queueTimeoutMs: 10_000, switchCooldownMs: 1_000 };
  let now = 0;
  const tick = (controller: TraexAutoModelController, ms: number) => {
    now += ms;
    return controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: now });
  };
  /** Walk the pool to its last model, then exhaust there — the state where a
   *  follow-up must wait for both the terminal and the preferred-model reset. */
  function exhaustOnLastModel(controller: TraexAutoModelController): void {
    now = 1_000;
    controller.beginTurn('turn-1');
    for (const expected of ['backup-1', 'backup-2']) {
      tick(controller, 0);                          // opens the queue window
      // The observation that elapses the window is the one that asks for loads.
      expect(tick(controller, 10_000).kind).toBe('load_check');
      controller.resolveModelLoads('turn-1', null);
      now += 100;
      const switched = controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: now });
      expect(switched).toMatchObject({ kind: 'switch', toModel: expected });
      if (switched.kind === 'switch') expect(controller.commitSwitch(switched, now)).toBe(true);
      now += 5_000;
    }
    tick(controller, 0);                          // opens the queue window
    expect(tick(controller, 1_000).kind).toBe('load_check');
    controller.resolveModelLoads('turn-1', null);
    now += 100;
    expect(controller.observeCapacityQueue({ turnId: 'turn-1', queued: true, nowMs: now }).kind).toBe('exhausted');
    expect(controller.currentModel()).toBe('backup-2');
  }

  it('keeps blocking across the terminal while the exhausted pane is still queued', () => {
    const controller = new TraexAutoModelController(base);
    exhaustOnLastModel(controller);
    // Both walk-off branches cleared queueSinceMs at the moment of exhaustion;
    // only the exhausted latch plus the live pane observation can block here.
    expect(controller.capacityCurrentlyBlocking()).toBe(true);
    controller.endTurn('turn-1');
    // A terminal does not repaint the queued pane, so the fact must survive.
    expect(controller.capacityCurrentlyBlocking()).toBe(true);
  });

  it('releases as soon as the live pane stops showing the queue', () => {
    const controller = new TraexAutoModelController(base);
    exhaustOnLastModel(controller);
    controller.endTurn('turn-1');
    controller.observeCapacityQueue({ turnId: 'turn-1', queued: false, nowMs: now + 500 });
    expect(controller.capacityCurrentlyBlocking()).toBe(false);
  });

  it('never leaks a stale queue fact into a later unrelated turn', () => {
    const controller = new TraexAutoModelController(base);
    exhaustOnLastModel(controller);
    controller.endTurn('turn-1');
    // reselectPerTurn is off by default, so the exhausted latch itself persists;
    // only the pane observation may keep blocking, and beginTurn clears it.
    controller.beginTurn('turn-2');
    expect(controller.capacityCurrentlyBlocking()).toBe(false);
  });

  it('holds blocking across the proposed preferred-model reset', () => {
    const controller = new TraexAutoModelController({ ...base, reselectPerTurn: true });
    exhaustOnLastModel(controller);
    controller.endTurn('turn-1');
    expect(controller.capacityCurrentlyBlocking()).toBe(true);
    // beginTurn only PROPOSES the reset; the pane still shows the fallback.
    const reset = controller.beginTurn('turn-2');
    expect(reset).toMatchObject({ kind: 'switch', reason: 'new_turn', toModel: 'core' });
    expect(controller.capacityCurrentlyBlocking()).toBe(true);
    if (reset.kind === 'switch') expect(controller.commitSwitch(reset, now + 1_000)).toBe(true);
    expect(controller.capacityCurrentlyBlocking()).toBe(false);
  });

  it('releases on the successor turn when per-turn reselection is off', () => {
    const controller = new TraexAutoModelController(base);
    exhaustOnLastModel(controller);
    controller.endTurn('turn-1');
    controller.beginTurn('turn-2');
    expect(controller.capacityCurrentlyBlocking()).toBe(false);
  });
});
