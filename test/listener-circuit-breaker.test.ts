import { describe, expect, it } from 'vitest';
import { ListenerCircuitBreaker } from '../src/services/listener-circuit-breaker.js';

describe('ListenerCircuitBreaker', () => {
  it('stays healthy below threshold and opens exactly at threshold, alerting once', () => {
    const cb = new ListenerCircuitBreaker({ permanentThreshold: 3, probeIntervalMs: 1_000_000 });
    expect(cb.recordPermanent('a')).toBe(false);
    expect(cb.recordPermanent('a')).toBe(false);
    expect(cb.stateFor('a')!.suspended).toBe(false);
    expect(cb.recordPermanent('a')).toBe(true); // opened this time
    expect(cb.stateFor('a')!.suspended).toBe(true);
    // 已熔断后再来永久错误不再重复触发「刚熔断」信号（只告警一次）。
    expect(cb.recordPermanent('a')).toBe(false);
  });

  it('blocks polling while suspended and only allows a probe on the probe cadence', () => {
    let now = 0;
    const cb = new ListenerCircuitBreaker({ permanentThreshold: 1, probeIntervalMs: 600_000, now: () => now });
    cb.recordPermanent('a');
    expect(cb.shouldPoll('a')).toBe(false); // 熔断当拍不再发请求，等一个探测周期
    now = 599_000;
    expect(cb.shouldPoll('a')).toBe(false);
    now = 600_000;
    expect(cb.shouldPoll('a')).toBe(true); // 慢探测点放行
    expect(cb.shouldPoll('a')).toBe(false); // 探测后回到冷却
  });

  it('recovers immediately on success and signals a resume', () => {
    const cb = new ListenerCircuitBreaker({ permanentThreshold: 1 });
    cb.recordPermanent('a');
    expect(cb.recordSuccess('a')).toBe(true);
    expect(cb.stateFor('a')).toBeUndefined();
    expect(cb.shouldPoll('a')).toBe(true);
    // 健康 key 的 success 不算恢复事件。
    expect(cb.recordSuccess('b')).toBe(false);
  });

  it('tracks keys independently and prunes only disappeared ones', () => {
    const cb = new ListenerCircuitBreaker({ permanentThreshold: 1, probeIntervalMs: 1_000_000 });
    cb.recordPermanent('a');
    cb.recordPermanent('b');
    expect(cb.shouldPoll('a')).toBe(false);
    cb.prune(new Set(['b']));
    expect(cb.stateFor('a')).toBeUndefined();
    expect(cb.stateFor('b')!.suspended).toBe(true);
  });

  it('resume() clears state without needing a probe (bot re-added WS event)', () => {
    const cb = new ListenerCircuitBreaker({ permanentThreshold: 1 });
    cb.recordPermanent('a');
    expect(cb.resume('a')).toBe(true);
    expect(cb.stateFor('a')).toBeUndefined();
  });
});
