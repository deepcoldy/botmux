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

  /** Feed a crash sequence and collect what the policy decided at each step. */
  const sequence = (codes: Array<number | null>, stepMs = 1000) => {
    let prev: ReturnType<typeof decideAutoRestart>['next'] | undefined;
    return codes.map((code, i) => {
      const decision = decideAutoRestart({ prev, now: now + i * stepMs, code });
      prev = decision.next;
      return decision;
    });
  };

  it('allows the first transient crashes within the window budget, then stops', () => {
    const decisions = sequence([1, 1, 1, 1, 1]);
    expect(decisions.slice(0, 3).map(d => d.shouldRestart)).toEqual([true, true, true]);
    expect(decisions[3]!.shouldRestart).toBe(false);
    expect(decisions[3]!.reason).toBe('window_budget');
  });

  it('resets the transient budget once the window elapses', () => {
    const prev = { count: 3, lastAt: now - RESTART_WINDOW_MS - 1, lastCode: 1 };
    const d = decideAutoRestart({ prev, now, code: 1 });
    expect(d.next.count).toBe(1);
    expect(d.shouldRestart).toBe(true);
  });

  it('stops almost immediately on a permanent identity exit (77) and labels the reason', () => {
    const [first, second] = sequence([77, 77], 500);
    expect(first!.shouldRestart).toBe(true); // one restart attempt
    expect(first!.next.count).toBe(1);
    expect(second!.shouldRestart).toBe(false);
    expect(second!.reason).toBe('permanent_exit');
  });

  // 本 PR 的头号场景：启动慢的 CLI 每次启动到崩溃都超过 60 秒，旧实现每次都被
  // 当成「新窗口第一次」→ 永不熔断。永久通道必须跨窗累计。
  it('does NOT reset a permanent failure even when crashes are a full window apart', () => {
    const [first, second] = sequence([77, 77], RESTART_WINDOW_MS + 5000);
    expect(second!.next.count).toBe(2);
    expect(second!.shouldRestart).toBe(false);
  });

  it('keeps accumulating across different permanent codes (77 then 127)', () => {
    const [, second] = sequence([77, 127], 90_000);
    expect(second!.shouldRestart).toBe(false);
    expect(second!.reason).toBe('permanent_exit');
  });

  it('signal death (null code) is treated as retryable transient', () => {
    const decisions = sequence([null, null, null, null]);
    expect(decisions.slice(0, 3).every(d => d.shouldRestart)).toBe(true);
    expect(decisions[3]!.reason).toBe('window_budget');
  });

  // N1（评审实测）：永久 / 普通来回横跳时，两套计数各自从 1 起算会把限流整个
  // 绕过去——实测 20 次崩溃停止 0 次。性质切换不得清零。
  it('does not let alternating permanent and transient crashes reset the budget forever', () => {
    const alternating = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 77 : 1));
    const decisions = sequence(alternating, 2000);
    // It must stop within the first handful, not survive all 20.
    const firstStop = decisions.findIndex(d => !d.shouldRestart);
    expect(firstStop).toBeGreaterThan(-1);
    expect(firstStop).toBeLessThan(5);
    // And once stopped it must STAY stopped — that is what "no reset" means.
    expect(decisions.slice(firstStop).every(d => !d.shouldRestart)).toBe(true);
  });

  it('still gives a first permanent exit its one chance when earlier crashes were transient', () => {
    // A stale transient streak must not swallow the single restart a permanent
    // code is allowed — the permanent branch gates on its own counter.
    const decisions = sequence([1, 1, 1, 77]);
    expect(decisions[3]!.shouldRestart).toBe(true);
  });

  // N2（评审实测）：永久计数不随恢复健康重置时，一次历史 127 会让这条会话此后
  // 任何一次 127 都立即不重启（实测隔 90 天仍如此）。调用方在 prompt_ready 时
  // 删除计数，所以“重置后”就是 prev=undefined —— 这里钉的是该语义正确。
  it('a cleared streak (CLI recovered) starts a fresh permanent budget', () => {
    const first = decideAutoRestart({ prev: undefined, now, code: 127 });
    expect(first.shouldRestart).toBe(true);
    // The CLI recovered and the daemon dropped the counter (prompt_ready path).
    const afterRecovery = decideAutoRestart({ prev: undefined, now: now + 90 * 24 * 3600 * 1000, code: 127 });
    expect(afterRecovery.shouldRestart).toBe(true);
    expect(afterRecovery.next.count).toBe(1);
  });

  it('a streak that was NEVER cleared still stops on the second permanent exit much later', () => {
    const first = decideAutoRestart({ prev: undefined, now, code: 127 });
    const muchLater = decideAutoRestart({ prev: first.next, now: now + 90 * 24 * 3600 * 1000, code: 127 });
    expect(muchLater.shouldRestart).toBe(false);
  });

  it('tolerates a legacy counter written before permanentCount existed', () => {
    // Older records only carried {count, lastAt, lastCode}; a permanent lastCode
    // must still count toward the permanent budget instead of silently resetting.
    const legacy = { count: 1, lastAt: now, lastCode: 127 } as const;
    const d = decideAutoRestart({ prev: legacy, now: now + 500, code: 127 });
    expect(d.shouldRestart).toBe(false);
    expect(d.reason).toBe('permanent_exit');
  });
});
