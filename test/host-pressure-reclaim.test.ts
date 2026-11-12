import { describe, expect, it, vi } from 'vitest';
import {
  INITIAL_HOST_PRESSURE_STATE,
  evaluateHostPressure,
  runHostPressureTick,
  type HostPressureReading,
  type HostPressureState,
} from '../src/core/host-pressure-reclaim.js';
import { resolveIdleSpinSuspendConfig } from '../src/core/idle-spin-config.js';
import { computeOverloadThresholds } from '../src/core/host-overload-alert.js';

const now = Date.UTC(2026, 10, 10, 9, 0, 0);

function pressure(overrides: Partial<HostPressureReading> = {}): HostPressureReading {
  return {
    load15: 10,
    memTotalBytes: 100,
    memFreeBytes: 50,
    cpuPct: 10,
    ...overrides,
  };
}

function cfg(overrides: Record<string, unknown> = {}) {
  return resolveIdleSpinSuspendConfig({
    hostPressure: {
      enabled: true,
      afterSamples: 3,
      cooldownMinutes: 10,
      maxSuspendsPerPass: 16,
      enterCpuPercent: 85,
      exitCpuPercent: 70,
      ...overrides,
    },
  }).hostPressure;
}

const thresholds = computeOverloadThresholds({ cpuCount: 32 });
const overloaded = pressure({ load15: 60, cpuPct: 95 });
const healthy = pressure({ load15: 10, cpuPct: 10 });

describe('host-pressure reclaim state machine', () => {
  it('requires consecutive overloaded samples before the first reclaim', () => {
    let state: HostPressureState = INITIAL_HOST_PRESSURE_STATE;
    const results = [];
    for (let i = 0; i < 3; i++) {
      const result = evaluateHostPressure(state, overloaded, cfg(), now + i * 30_000, thresholds);
      state = result.state;
      results.push(result.shouldReclaim);
    }
    expect(results).toEqual([false, false, true]);
  });

  it('does not arm the cooldown on healthy ticks before the first overload', () => {
    let state = INITIAL_HOST_PRESSURE_STATE;
    for (let i = 0; i < 3; i++) {
      state = evaluateHostPressure(state, healthy, cfg(), now + i * 30_000, thresholds).state;
    }
    expect(state.cooldownUntil).toBe(0);
    const results = [];
    for (let i = 0; i < 3; i++) {
      const result = evaluateHostPressure(state, overloaded, cfg(), now + (i + 3) * 30_000, thresholds);
      state = result.state;
      results.push(result.shouldReclaim);
    }
    expect(results).toEqual([false, false, true]);
  });

  it('keeps the episode hot after a positive pass (no intra-episode cooldown)', async () => {
    let state = INITIAL_HOST_PRESSURE_STATE;
    for (let i = 0; i < 3; i++) {
      const result = await runHostPressureTick({
        state,
        reading: overloaded,
        config: cfg(),
        now: now + i * 30_000,
        baseThresholds: thresholds,
        reclaim: async () => 8,
      });
      state = result.state;
    }
    const next = await runHostPressureTick({
      state,
      reading: overloaded,
      config: cfg(),
      now: now + 90_000,
      baseThresholds: thresholds,
      reclaim: async () => 8,
    });
    expect(next.reclaimed).toBe(8);
  });

  it('starts the cooldown after an empty pass and suppresses reclaims inside it', async () => {
    let state: HostPressureState = {
      ...INITIAL_HOST_PRESSURE_STATE,
      overloadState: { overloaded: true, lastEnteredAlertAt: 0 },
      strikes: 3,
    };
    const empty = await runHostPressureTick({
      state,
      reading: overloaded,
      config: cfg(),
      now,
      baseThresholds: thresholds,
      reclaim: async () => 0,
    });
    state = empty.state;
    expect(state.cooldownUntil).toBe(now + 10 * 60_000);

    const during = await runHostPressureTick({
      state,
      reading: overloaded,
      config: cfg(),
      now: now + 60_000,
      baseThresholds: thresholds,
      reclaim: vi.fn(async () => 8),
    });
    expect(during.reclaimed).toBe(0);
    expect(during.shouldReclaim).toBe(false);

    const after = await runHostPressureTick({
      state,
      reading: overloaded,
      config: cfg(),
      now: now + 10 * 60_000 + 1,
      baseThresholds: thresholds,
      reclaim: async () => 8,
    });
    expect(after.reclaimed).toBe(8);
  });

  it('resets strikes and starts the cooldown when the episode recovers', () => {
    let state: HostPressureState = {
      ...INITIAL_HOST_PRESSURE_STATE,
      overloadState: { overloaded: true, lastEnteredAlertAt: 0 },
      strikes: 5,
    };
    const result = evaluateHostPressure(state, healthy, cfg(), now, thresholds);
    state = result.state;
    expect(result.overloaded).toBe(false);
    expect(state.strikes).toBe(0);
    expect(state.cooldownUntil).toBe(now + 10 * 60_000);
  });

  it('applies hysteresis between the enter and exit lines', () => {
    const state: HostPressureState = {
      ...INITIAL_HOST_PRESSURE_STATE,
      overloadState: { overloaded: true, lastEnteredAlertAt: 0 },
    };
    // load15 40 is below enter (48) but above exit (32): stays overloaded.
    const between = evaluateHostPressure(state, pressure({ load15: 40, cpuPct: 50 }), cfg(), now, thresholds);
    expect(between.overloaded).toBe(true);
    // load15 30 is below exit (32): recovers.
    const below = evaluateHostPressure(state, pressure({ load15: 30, cpuPct: 50 }), cfg(), now, thresholds);
    expect(below.overloaded).toBe(false);
  });

  it('includes the CPU dimension without changing the alert thresholds', () => {
    const cpuOnly = evaluateHostPressure(
      INITIAL_HOST_PRESSURE_STATE,
      pressure({ load15: 1, cpuPct: 90 }),
      cfg(),
      now,
      thresholds,
    );
    expect(cpuOnly.overloaded).toBe(true);
    // 75 is above exit (70) but below enter (85): stays overloaded.
    const between = evaluateHostPressure(cpuOnly.state, pressure({ load15: 1, cpuPct: 75 }), cfg(), now + 30_000, thresholds);
    expect(between.overloaded).toBe(true);
    const recovered = evaluateHostPressure(cpuOnly.state, pressure({ load15: 1, cpuPct: 60 }), cfg(), now + 30_000, thresholds);
    expect(recovered.overloaded).toBe(false);
  });

  it('works with the default hostOverloadAlert thresholds when the alert is not configured', async () => {
    // `computeOverloadThresholds({cpuCount: 32})` is exactly the resolver's
    // fallback when global config/env are absent.
    const result = await runHostPressureTick({
      state: { ...INITIAL_HOST_PRESSURE_STATE, strikes: 3 },
      reading: pressure({ load15: 60, cpuPct: 95 }),
      config: cfg(),
      now,
      baseThresholds: thresholds,
      reclaim: async () => 3,
    });
    expect(result.reclaimed).toBe(3);
  });

  it('drains 53 idle sessions in four passes at 16 per pass', async () => {
    let remaining = 53;
    let state = INITIAL_HOST_PRESSURE_STATE;
    let passes = 0;
    for (let i = 0; i < 10 && remaining > 0; i++) {
      const result = await runHostPressureTick({
        state,
        reading: overloaded,
        config: cfg(),
        now: now + i * 30_000,
        baseThresholds: thresholds,
        reclaim: async () => {
          const n = Math.min(16, remaining);
          remaining -= n;
          return n;
        },
      });
      state = result.state;
      if (result.reclaimed && result.reclaimed > 0) passes += 1;
    }
    expect(remaining).toBe(0);
    expect(passes).toBe(4);
  });
});
