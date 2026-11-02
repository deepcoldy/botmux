import { describe, expect, it } from 'vitest';
import {
  normalizeTraexAutoModelConfig,
  resolveTraexAutoModelRuntimeSettings,
  strongestTraexPreflightReasoningEffort,
  TraexAutoModelController,
} from '../src/services/traex-auto-model.js';

const config = {
  enabled: true as const,
  models: ['core', 'backup-1', 'backup-2'],
  queueTimeoutMs: 10_000,
  switchCooldownMs: 5_000,
  preflightLoadCheck: true as const,
  overloadThresholdPercent: 100,
  preflightTimeoutMs: 8_000,
  unknownLoadPolicy: 'skip' as const,
  allOverloadedPolicy: 'lowest_load' as const,
};

describe('TraeX independent-turn load preflight', () => {
  it('is compatibility-off by default and fills the enabled policy defaults', () => {
    expect(normalizeTraexAutoModelConfig({ enabled: true, models: ['core'] }).config)
      .not.toHaveProperty('preflightLoadCheck');
    expect(normalizeTraexAutoModelConfig({
      enabled: true, models: ['core'], preflightLoadCheck: true,
    }).config).toMatchObject({
      preflightLoadCheck: true,
      overloadThresholdPercent: 100,
      preflightTimeoutMs: 8_000,
      unknownLoadPolicy: 'skip',
      allOverloadedPolicy: 'lowest_load',
    });
  });

  it('keeps config normalization capability-agnostic and resolves the advertised highest effort at runtime', () => {
    expect(normalizeTraexAutoModelConfig({
      enabled: true, models: ['core'], preflightLoadCheck: true,
      modelSettings: { core: { reasoningEffort: 'high' } },
    }).error).toBeUndefined();
    expect(resolveTraexAutoModelRuntimeSettings({ ...config,
      modelSettings: { core: { reasoningEffort: 'xhigh' } } }, 'core', {}, ['low', 'medium', 'high']))
      .toMatchObject({ reasoningEffort: 'high' });
  });

  it('keeps 100%, switches at 101%, and chooses the first available pool entry', () => {
    expect(new TraexAutoModelController(config).preflightDecision('turn', new Map([
      ['core', 100], ['backup-1', 10], ['backup-2', 1],
    ]))).toMatchObject({ kind: 'keep', reason: 'within_threshold', loadPercent: 100 });
    expect(new TraexAutoModelController(config).preflightDecision('turn', new Map([
      ['core', 101], ['backup-1', 100], ['backup-2', 20],
    ]))).toMatchObject({ kind: 'switch', reason: 'preflight_available',
      toModel: 'backup-1', loadPercent: 100 });
  });

  it('skips unknown candidates and fails open when the checked model is unknown', () => {
    expect(new TraexAutoModelController(config).preflightDecision('turn', new Map([
      ['core', 101], ['backup-2', 20],
    ]))).toMatchObject({ kind: 'switch', toModel: 'backup-2' });
    expect(new TraexAutoModelController(config).preflightDecision('turn', new Map([
      ['backup-1', 20],
    ]))).toMatchObject({ kind: 'keep', reason: 'load_unavailable', model: 'core' });
  });

  it('uses lowest known load and stable pool order when every known load is high', () => {
    expect(new TraexAutoModelController(config).preflightDecision('turn', new Map([
      ['core', 180], ['backup-1', 120], ['backup-2', 120],
    ]))).toMatchObject({ kind: 'switch', reason: 'preflight_lowest_load',
      toModel: 'backup-1', loadPercent: 120 });

    const demoted = new TraexAutoModelController(config);
    demoted.observeRunningModel('backup-2');
    expect(demoted.preflightDecision('turn', new Map([
      ['core', 130], ['backup-1', 120], ['backup-2', 120],
    ]))).toMatchObject({ kind: 'switch', reason: 'preflight_lowest_load',
      toModel: 'backup-1', loadPercent: 120 });
  });

  it('does not consume the runtime queue fallback cooldown after admission', () => {
    const controller = new TraexAutoModelController({ ...config, switchCooldownMs: 60_000 });
    const decision = controller.preflightDecision('turn', new Map([
      ['core', 101], ['backup-1', 100], ['backup-2', 20],
    ]));
    if (decision.kind !== 'switch') throw new Error('fixture must switch');
    expect(controller.commitSwitch(decision, 1_000)).toBe(true);
    expect(controller.observeCapacityQueue({ turnId: 'turn', queued: true, nowMs: 2_000 })).toEqual({ kind: 'none' });
    expect(controller.observeCapacityQueue({ turnId: 'turn', queued: true, nowMs: 12_000 }))
      .toEqual({ kind: 'load_check', turnId: 'turn' });
  });

  it('uses max/xhigh when supported, otherwise the actual highest effort', () => {
    expect(strongestTraexPreflightReasoningEffort('max-model', ['xhigh', 'max'])).toBe('max');
    expect(strongestTraexPreflightReasoningEffort('extra-high-model', ['xhigh', 'ultra'])).toBe('xhigh');
    expect(strongestTraexPreflightReasoningEffort('high-model', ['low', 'medium', 'high'])).toBe('high');
    expect(resolveTraexAutoModelRuntimeSettings({ ...config,
      modelSettings: { core: { reasoningEffort: 'max' } } }, 'core')).toMatchObject({ reasoningEffort: 'max' });
  });
});
