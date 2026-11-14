import { describe, expect, it } from 'vitest';
import {
  PROVIDER_RECOVERY_MAX_WAIT_MINUTES_CACHE_1H,
  PROVIDER_RECOVERY_MAX_WAIT_MINUTES_DEFAULT,
  PROVIDER_RECOVERY_MAX_WAIT_MINUTES_MAX,
  normalizeProviderRecoveryConfig,
  readProviderRecoveryConfig,
  resolveProviderRecoveryPolicy,
} from '../src/services/provider-recovery-policy.js';
import { providerRecoveryPacing } from '../src/core/provider-recovery-config.js';
import { DEFAULT_ORDINARY_TURN_RECOVERY_PACING, planOrdinaryTurnRecoveryContinuation } from '../src/services/ordinary-turn-recovery.js';

describe('providerRecovery configuration', () => {
  it('is off when neither layer says anything, whatever the prompt cache', () => {
    for (const ttl of [undefined, '5m', '1h'] as const) {
      expect(resolveProviderRecoveryPolicy(undefined, undefined, ttl).enabled).toBe(false);
    }
  });

  it('lets a bot switch it on under a global "off" and off under a global "on"', () => {
    expect(resolveProviderRecoveryPolicy({ enabled: true }, undefined, undefined).enabled).toBe(true);
    expect(resolveProviderRecoveryPolicy({ enabled: true }, { enabled: false }, undefined).enabled).toBe(false);
    expect(resolveProviderRecoveryPolicy({ enabled: false }, { enabled: true }, undefined).enabled).toBe(true);
    // A bot that only sets the wait still inherits the global switch.
    expect(resolveProviderRecoveryPolicy({ enabled: true }, { maxWaitMinutes: 5 }, undefined))
      .toEqual({ enabled: true, maxWaitMinutes: 5, maxWaitSource: 'configured' });
  });

  it('follows the prompt cache for the wait unless a layer sets it', () => {
    expect(resolveProviderRecoveryPolicy({ enabled: true }, undefined, '1h'))
      .toEqual({ enabled: true, maxWaitMinutes: PROVIDER_RECOVERY_MAX_WAIT_MINUTES_CACHE_1H, maxWaitSource: 'cache_1h' });
    for (const ttl of [undefined, '5m'] as const) {
      expect(resolveProviderRecoveryPolicy({ enabled: true }, undefined, ttl))
        .toEqual({ enabled: true, maxWaitMinutes: PROVIDER_RECOVERY_MAX_WAIT_MINUTES_DEFAULT, maxWaitSource: 'default' });
    }
    // The cache-following default is longer than the plain one (55 > 15).
    expect(PROVIDER_RECOVERY_MAX_WAIT_MINUTES_CACHE_1H).toBeGreaterThan(PROVIDER_RECOVERY_MAX_WAIT_MINUTES_DEFAULT);
    expect(resolveProviderRecoveryPolicy({ enabled: true, maxWaitMinutes: 30 }, { maxWaitMinutes: 90 }, '1h'))
      .toEqual({ enabled: true, maxWaitMinutes: 90, maxWaitSource: 'configured' });
    expect(resolveProviderRecoveryPolicy({ maxWaitMinutes: 30 }, undefined, '1h').maxWaitMinutes).toBe(30);
  });

  it('rejects typos and out-of-range values on write, and ignores a broken global block on read', () => {
    expect(normalizeProviderRecoveryConfig({ enabled: true, maxWaitMinutes: 20 })).toEqual({ enabled: true, maxWaitMinutes: 20 });
    expect(normalizeProviderRecoveryConfig({})).toBeUndefined();
    expect(normalizeProviderRecoveryConfig(null)).toBeUndefined();
    expect(normalizeProviderRecoveryConfig({ enabled: null, maxWaitMinutes: null })).toBeUndefined();
    for (const bad of [
      { enable: true },
      { enabled: 'yes' },
      { maxWaitMinutes: 0 },
      { maxWaitMinutes: PROVIDER_RECOVERY_MAX_WAIT_MINUTES_MAX + 1 },
      { maxWaitMinutes: 1.5 },
      [],
      'on',
    ]) {
      expect(() => normalizeProviderRecoveryConfig(bad)).toThrow();
      expect(readProviderRecoveryConfig(bad)).toBeUndefined();
    }
  });

  it('turns a policy into pacing whose runaway guard never cuts a long wait short', () => {
    for (const minutes of [5, 15, 55, 120, PROVIDER_RECOVERY_MAX_WAIT_MINUTES_MAX]) {
      const pacing = providerRecoveryPacing({ enabled: true, maxWaitMinutes: minutes, maxWaitSource: 'configured' });
      expect(pacing.windowMs).toBe(minutes * 60_000);
      expect(pacing.minWindowMs).toBeLessThanOrEqual(pacing.windowMs);
      // Drive the plan with every attempt failing instantly and no provider
      // hint: it must stop on the window, not on the continuation count.
      let now = 0;
      let continuations = 0;
      for (;;) {
        const plan = planOrdinaryTurnRecoveryContinuation({
          now, pacing, random: () => 0, continuationsStarted: continuations, ladderBase: 0, firstFailureAt: 0,
        });
        if (plan.kind === 'stop') { expect(plan.stopReason).toBe('window_closed'); break; }
        now = plan.nextAttemptAt;
        continuations += 1;
      }
    }
    expect(providerRecoveryPacing({ enabled: true, maxWaitMinutes: 55, maxWaitSource: 'cache_1h' }).followsPromptCache).toBe(true);
    expect(providerRecoveryPacing({ enabled: true, maxWaitMinutes: 15, maxWaitSource: 'default' }).followsPromptCache).toBe(false);
    expect(providerRecoveryPacing({ enabled: true, maxWaitMinutes: 15, maxWaitSource: 'default' }).maxContinuations)
      .toBeGreaterThanOrEqual(DEFAULT_ORDINARY_TURN_RECOVERY_PACING.maxContinuations);
  });
});
