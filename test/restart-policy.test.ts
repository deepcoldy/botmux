import { describe, expect, it } from 'vitest';
import {
  decideAutoRestart,
  isPermanentCliExitCode,
  RESTART_WINDOW_MS,
} from '../src/core/restart-policy.js';

describe('isPermanentCliExitCode', () => {
  it('flags 77 (identity) and 127 (missing command) as permanent', () => {
    expect(isPermanentCliExitCode(77)).toBe(true);
    expect(isPermanentCliExitCode(127)).toBe(true);
  });
  it('treats 1/2 generic and signal death (null) as retryable', () => {
    expect(isPermanentCliExitCode(1)).toBe(false);
    expect(isPermanentCliExitCode(2)).toBe(false);
    expect(isPermanentCliExitCode(null)).toBe(false);
    expect(isPermanentCliExitCode(undefined)).toBe(false);
  });
});

describe('decideAutoRestart', () => {
  const now = 1_000_000;

  it('allows the first transient crashes within the window budget', () => {
    let prev: ReturnType<typeof decideAutoRestart>['next'] | undefined;
    for (let i = 1; i <= 3; i += 1) {
      const d = decideAutoRestart({ prev, now: now + i * 1000, code: 1 });
      expect(d.shouldRestart).toBe(true);
      expect(d.next.count).toBe(i);
      prev = d.next;
    }
    const stop = decideAutoRestart({ prev, now: now + 4000, code: 1 });
    expect(stop.shouldRestart).toBe(false);
    expect(stop.reason).toBe('window_budget');
  });

  it('resets the counter for a transient crash after the window elapses', () => {
    const prev = { count: 3, lastAt: now - RESTART_WINDOW_MS - 1, lastCode: 1 };
    const d = decideAutoRestart({ prev, now, code: 1 });
    expect(d.next.count).toBe(1);
    expect(d.shouldRestart).toBe(true);
  });

  it('stops almost immediately on a permanent identity exit (77) and labels the reason', () => {
    const first = decideAutoRestart({ prev: undefined, now, code: 77 });
    expect(first.shouldRestart).toBe(true); // 给一次重启机会
    expect(first.next.count).toBe(1);
    const second = decideAutoRestart({ prev: first.next, now: now + 500, code: 77 });
    expect(second.shouldRestart).toBe(false);
    expect(second.reason).toBe('permanent_exit');
  });

  it('does NOT reset a permanent failure even when crashes are more than a window apart', () => {
    // 启动慢的 CLI 每次启动到崩溃 >60s：旧实现无限重启，新实现保持累计。
    const first = decideAutoRestart({ prev: undefined, now, code: 77 });
    const second = decideAutoRestart({ prev: first.next, now: now + RESTART_WINDOW_MS + 5000, code: 77 });
    expect(second.next.count).toBe(2);
    expect(second.shouldRestart).toBe(false);
  });

  it('keeps accumulating across different permanent codes (77 then 127)', () => {
    const a = decideAutoRestart({ prev: undefined, now, code: 77 });
    const b = decideAutoRestart({ prev: a.next, now: now + 90_000, code: 127 });
    expect(b.next.count).toBe(2);
    expect(b.shouldRestart).toBe(false);
  });

  it('a transient crash after a permanent one starts a fresh transient streak', () => {
    const perm = decideAutoRestart({ prev: undefined, now, code: 77 });
    expect(perm.next.lastCode).toBe(77);
    const later = decideAutoRestart({ prev: perm.next, now: now + 500, code: 1 });
    expect(later.next.count).toBe(1);
    expect(later.next.lastCode).toBe(1);
    expect(later.shouldRestart).toBe(true);
  });

  it('signal death (null code) is treated as retryable transient', () => {
    let prev: ReturnType<typeof decideAutoRestart>['next'] | undefined;
    for (let i = 1; i <= 3; i += 1) {
      const d = decideAutoRestart({ prev, now: now + i * 1000, code: null });
      expect(d.shouldRestart).toBe(true);
      prev = d.next;
    }
    expect(decideAutoRestart({ prev, now: now + 4000, code: null }).reason).toBe('window_budget');
  });
});
