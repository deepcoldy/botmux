import { describe, expect, it } from 'vitest';
import { detectCliUsageLimit, reconcileUsageLimitState, usageLimitStateKey, type CliUsageLimitState } from '../src/utils/cli-usage-limit.js';

const banner = (duration: string, id = 'quota-episode-one'): string =>
  `Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${duration}.\nError ID: ${id}`;

function detected(text: string, now: number): CliUsageLimitState {
  const result = detectCliUsageLimit(text, new Date(now));
  expect(result.limited).toBe(true);
  if (!result.limited) throw new Error('Expected a quota state');
  return result;
}

describe('relative quota reset durations', () => {
  it('recognizes the agy hours/minutes/seconds countdown', () => {
    const now = Date.UTC(2026, 9, 1);
    const state = detected(banner('124h24m15s'), now);
    expect(state.kind).toBe('usage');
    expect(state.retryAtMs - now).toBe(((124 * 60 + 24) * 60 + 15) * 1000);
    expect(state.retryReady).toBe(false);
  });

  it.each(['0s', '5m', '1h 2m 3s', '2d3h', '0.5s'])('parses a complete duration %s', duration => {
    const state = detected(banner(duration), Date.UTC(2026, 9, 1));
    expect(Number.isFinite(state.retryAtMs)).toBe(true);
  });

  it.each(['-1h', '1h-5m', '1h1h', '1s2h', 'Infinitys', '1hours', '999999999999999999999h'])('rejects malformed duration %s', duration => {
    expect(detectCliUsageLimit(banner(duration)).limited).toBe(false);
  });

  it('does not classify a countdown without a quota refusal', () => {
    expect(detectCliUsageLimit('The batch resets in 5m.').limited).toBe(false);
  });

  it('selects the newest refusal and pairs its own duration and error ID', () => {
    const now = Date.UTC(2026, 9, 1);
    const old = detected(banner('1m', 'old-episode'), now);
    const latest = detected(banner('1m', 'old-episode') + '\n' + banner('2m', 'new-episode'), now);
    expect(latest.retryAtMs).toBe(now + 120_000);
    expect(reconcileUsageLimitState(old, latest, now).retryAtMs).toBe(now + 120_000);
    expect(latest.relativeResetKey).toContain('new-episode');
  });

  it('does not borrow an old reset time for a newer refusal with no reset', () => {
    const screen = banner('1m', 'old-episode') + '\nIndividual quota reached. Please try again later.\nError ID: new-episode';
    expect(detectCliUsageLimit(screen).limited).toBe(false);
  });

  it('normalizes whitespace and wrapped duration units into the same episode', () => {
    const now = Date.UTC(2026, 9, 1);
    expect(usageLimitStateKey(detected(banner('1h2m3s'), now)))
      .toBe(usageLimitStateKey(detected(banner('1h\n 2m 3s'), now)));
  });

  it('pins the same error episode across polls and a persisted-state restore', () => {
    const now = Date.UTC(2026, 9, 1);
    const first = detected(banner('1m'), now);
    const restored = JSON.parse(JSON.stringify(first)) as CliUsageLimitState;
    const repeated = reconcileUsageLimitState(restored, detected(banner('1m'), now + 20_000), now + 20_000);
    expect(repeated.retryAtMs).toBe(first.retryAtMs);
    const due = reconcileUsageLimitState(repeated, detected(banner('1m'), now + 61_000), now + 61_000);
    expect(due.retryAtMs).toBe(first.retryAtMs);
    expect(due.retryReady).toBe(true);
  });

  it('starts a fresh deadline after a new refusal or an explicitly cleared state', () => {
    const now = Date.UTC(2026, 9, 1);
    const previous = detected(banner('1m'), now);
    const incoming = detected(banner('1m', 'quota-episode-two'), now + 20_000);
    expect(reconcileUsageLimitState(previous, incoming, now + 20_000).retryAtMs).toBe(now + 80_000);
    expect(reconcileUsageLimitState(undefined, incoming, now + 20_000).retryAtMs).toBe(now + 80_000);
  });

  it('keeps absolute-clock and other CLI rate-limit behavior unchanged', () => {
    const now = Date.UTC(2026, 9, 1);
    const previous = detected(banner('1m'), now);
    const other = detected('429 Too Many Requests', now + 20_000);
    expect(reconcileUsageLimitState(previous, other, now + 20_000)).toBe(other);
  });
});
