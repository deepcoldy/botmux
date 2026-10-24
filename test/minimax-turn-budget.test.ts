import { describe, expect, it, vi } from 'vitest';
import { MinimaxTurnBudget, parseMinimaxTurnTimeout } from '../src/services/minimax-turn-budget.js';

// Explicit clock: exercise elapsed time and stale callbacks without real sleeps
// or dependence on Node/Bun's fake-timer implementation.
function fixture(raw?: string) {
  let now = 0;
  let id = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const exhaust = vi.fn();
  const budget = new MinimaxTurnBudget(parseMinimaxTurnTimeout(raw), exhaust, {
    now: () => now,
    setTimeout(callback, ms) {
      tasks.set(++id, { at: now + ms, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer) { tasks.delete(timer as unknown as number); },
  });
  return { budget, exhaust, tasks, advance(ms: number) {
    const until = now + ms;
    for (;;) {
      const next = [...tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      tasks.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = until;
  } };
}

describe('MiniMax opt-in turn budget', () => {
  it('runs past the old ten-minute boundary by default, including human waits', () => {
    const f = fixture();
    f.advance(601_000);
    expect(f.exhaust).not.toHaveBeenCalled();
    f.budget.waitingForHuman(true);
    f.advance(3_600_000);
    f.budget.waitingForHuman(false);
    f.advance(3_600_000);
    expect(f.exhaust).not.toHaveBeenCalled();
    expect(f.tasks.size).toBe(0);
    f.budget.dispose();
  });

  it('keeps an explicitly configured total budget and exhausts it exactly once', () => {
    const f = fixture('600000');
    f.advance(599_999); expect(f.exhaust).not.toHaveBeenCalled();
    f.advance(1); expect(f.exhaust).toHaveBeenCalledTimes(1);
    f.budget.waitingForHuman(true); f.budget.waitingForHuman(false);
    f.advance(600_000); expect(f.exhaust).toHaveBeenCalledTimes(1);
  });

  it('charges only execution across multiple human waits and tolerates repeated state', () => {
    const f = fixture('1000');
    f.advance(400); f.budget.waitingForHuman(true);
    f.advance(4000); f.budget.waitingForHuman(true);
    f.advance(4000); f.budget.waitingForHuman(false);
    f.advance(300); f.budget.waitingForHuman(false);
    f.budget.waitingForHuman(true); f.advance(4000);
    f.budget.waitingForHuman(false);
    f.advance(299); expect(f.exhaust).not.toHaveBeenCalled();
    f.advance(1); expect(f.exhaust).toHaveBeenCalledTimes(1);
  });

  it('ignores a queued old timer after pause and after disposal', () => {
    const f = fixture('1000');
    const stale = [...f.tasks.values()][0].callback;
    f.advance(200); f.budget.waitingForHuman(true);
    f.advance(2000); f.budget.waitingForHuman(false);
    stale(); expect(f.exhaust).not.toHaveBeenCalled();
    const current = [...f.tasks.values()][0].callback;
    f.budget.dispose(); f.budget.waitingForHuman(false);
    current(); f.advance(2000);
    expect(f.exhaust).not.toHaveBeenCalled();
    expect(f.tasks.size).toBe(0);
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '2147483648'])('rejects invalid explicit budgets: %s', raw => {
    expect(() => fixture(raw)).toThrow();
  });
});
