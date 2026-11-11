import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE_SPIN_SUSPEND_CONFIG,
  normalizeIdleSpinSuspendConfig,
  resolveIdleSpinSuspendConfig,
} from '../src/core/idle-spin-config.js';

describe('idleSpinSuspend config', () => {
  it('uses conservative defaults: traex only, 20% of one core, 3 samples, 5 min idle', () => {
    expect(DEFAULT_IDLE_SPIN_SUSPEND_CONFIG).toMatchObject({
      enabled: true,
      cliIds: ['traex'],
      cpuPercent: 20,
      consecutiveSamples: 3,
      sampleIntervalSeconds: 30,
      minIdleMinutes: 5,
      maxSuspendsPerSample: 8,
      hostPressure: {
        enabled: true,
        afterSamples: 3,
        cooldownMinutes: 10,
        maxSuspendsPerPass: 16,
        enterCpuPercent: 85,
        exitCpuPercent: 70,
      },
    });
  });

  it('merges partial config over defaults and keeps the nested hostPressure block', () => {
    const resolved = resolveIdleSpinSuspendConfig({
      enabled: false,
      cliIds: ['traex', 'claude-code'],
      hostPressure: { maxSuspendsPerPass: 4 },
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.cliIds).toEqual(['traex', 'claude-code']);
    expect(resolved.cpuPercent).toBe(20);
    expect(resolved.hostPressure.maxSuspendsPerPass).toBe(4);
    expect(resolved.hostPressure.afterSamples).toBe(3);
  });

  it('accepts a minimal opt-out', () => {
    expect(normalizeIdleSpinSuspendConfig({ enabled: false })).toEqual({ enabled: false });
  });

  it('defensively clamps a reverse hysteresis pair at resolve time', () => {
    const resolved = resolveIdleSpinSuspendConfig({ hostPressure: { enterCpuPercent: 60 } });
    expect(resolved.hostPressure.enterCpuPercent).toBe(60);
    expect(resolved.hostPressure.exitCpuPercent).toBe(59);
  });

  it('allows an empty cliIds list (layer 1 disabled, layer 2 stays available)', () => {
    expect(normalizeIdleSpinSuspendConfig({ cliIds: [] })).toEqual({ cliIds: [] });
  });

  it('keeps unknown cli ids (they simply never match a live session)', () => {
    expect(normalizeIdleSpinSuspendConfig({ cliIds: ['future-cli'] })).toEqual({ cliIds: ['future-cli'] });
  });

  it.each([
    ['non-string cli id', { cliIds: ['traex', 42] }],
    ['blank cli id', { cliIds: ['  '] }],
    ['cpuPercent 0', { cpuPercent: 0 }],
    ['cpuPercent too high', { cpuPercent: 401 }],
    ['fractional samples', { consecutiveSamples: 2.5 }],
    ['samples too high', { consecutiveSamples: 61 }],
    ['interval too low', { sampleIntervalSeconds: 9 }],
    ['negative idle', { minIdleMinutes: -1 }],
    ['zero idle', { minIdleMinutes: 0 }],
    ['fractional max suspends', { maxSuspendsPerSample: 1.5 }],
    ['bad hostPressure type', { hostPressure: 'on' }],
    ['exit cpu >= enter', { hostPressure: { enterCpuPercent: 70, exitCpuPercent: 70 } }],
    ['partial enter below default exit', { hostPressure: { enterCpuPercent: 60 } }],
    ['partial exit above default enter', { hostPressure: { exitCpuPercent: 90 } }],
    ['bad cooldown', { hostPressure: { cooldownMinutes: -1 } }],
  ] as const)('rejects %s', (_label, raw) => {
    expect(normalizeIdleSpinSuspendConfig(raw)).toBeUndefined();
  });

  it('ignores unknown keys for forward compatibility', () => {
    expect(normalizeIdleSpinSuspendConfig({ cpuPercent: 30, futureKnob: true }))
      .toEqual({ cpuPercent: 30 });
  });
});
