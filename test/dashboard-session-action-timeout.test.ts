import { describe, expect, it } from 'bun:test';
import { dashboardSessionActionTimeoutMs } from '../src/dashboard/session-action-timeout.js';

describe('dashboard session action proxy timeout', () => {
  it('covers the full Riff close prepare plus worker-kill fallback budget', () => {
    expect(dashboardSessionActionTimeoutMs('close')).toBe(60_000);
  });

  it.each(['locate', 'resume', 'restart', 'start'] as const)(
    'keeps %s failures bounded without inheriting the slow-close budget',
    (action) => {
      expect(dashboardSessionActionTimeoutMs(action)).toBe(15_000);
    },
  );
});
