import { describe, expect, it } from 'vitest';
import { tmuxRestartJitterMs } from '../src/core/tmux-recovery.js';
import { tmuxLifecycleInitialDelayMs } from '../src/adapters/backend/tmux-pipe-backend.js';

describe('tmux restart jitter', () => {
  it('is deterministic and bounded', () => {
    const delay = tmuxRestartJitterMs('session-a', 1);
    expect(tmuxRestartJitterMs('session-a', 1)).toBe(delay);
    expect(delay).toBeGreaterThanOrEqual(250);
    expect(delay).toBeLessThan(2000);
  });

  it('spreads independent sessions across the restart window', () => {
    const delays = new Set(
      Array.from({ length: 32 }, (_, i) => tmuxRestartJitterMs(`session-${i}`, 1)),
    );
    expect(delays.size).toBeGreaterThan(24);
  });
});

describe('tmux lifecycle probe staggering', () => {
  it('keeps the first probe bounded and distributes restored sessions', () => {
    const delays = Array.from(
      { length: 32 },
      (_, i) => tmuxLifecycleInitialDelayMs(`bmx-${i.toString(16).padStart(8, '0')}`),
    );
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...delays)).toBeLessThan(1750);
    expect(new Set(delays).size).toBeGreaterThan(24);
  });
});
