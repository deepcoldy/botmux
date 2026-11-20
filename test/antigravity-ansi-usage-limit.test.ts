import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { createUsageLimitTracker } from '../src/utils/usage-limit-tracker.js';
import { reconcileUsageLimitState, type CliUsageLimitState } from '../src/utils/cli-usage-limit.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';
import { ANTIGRAVITY_QUOTA_HISTORY_LIMIT, annotateAntigravityUsageLimit, isAntigravityWorkingScreen, rememberAntigravityQuota } from '../src/adapters/cli/antigravity.js';

function classifier(raw: () => string, cliId = 'antigravity') {
  const capture = vi.fn(raw);
  const usageLimitTracker = createUsageLimitTracker({ isRateKindSuppressed: () => false, isOutputActive: () => false });
  const classify = loadWorkerFunction<(content: string, status: string) => any>('classifyUsageLimitWithNativeEvidence', {
    cliAdapter: { id: cliId }, backend: {}, captureBackendScreen: capture,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    stripAnsiScreenText, isAntigravityWorkingScreen, annotateAntigravityUsageLimit,
    usageLimitTracker, reconcileUsageLimitState, rememberAntigravityQuota, antigravityQuotaHistory: undefined,
    unconfirmedAntigravityQuotas: new Map(), ANTIGRAVITY_QUOTA_HISTORY_LIMIT,
  });
  return { classify, capture, usageLimitTracker };
}
const composer = '\r\n────\r\n>\r\n────\r\n';
const quota = '⚠ Individual quota reached. Resets in 124h24m15s.';
const id = 'ansi-error-one';
const color = (s: string) => `\x1b[1;33m${s}\x1b[0m`;
afterEach(() => vi.useRealTimers());

describe('raw ANSI tmux quota classification', () => {
  it.each([
    quota.replace('124h24m15s', color('124h24m15s')) + `\r\nError ID: ${id}`,
    quota.replace('Resets in', color('Resets in')) + `\r\nError ID: ${id}`,
    quota.replace('Individual quota', 'Individual\x1b[0m \x1b[33mquota') + `\r\nError ID: ${id}`,
    quota + `\r\nError ID: ${color(id)}`,
  ])('preserves composer rows, countdown and episode identity in a colored viewport', raw => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const { classify } = classifier(() => raw + composer);
    // The display snapshot lacks the composer; the real native viewport owns classification.
    const result = classify('display-only snapshot', 'working');
    expect(result.status).toBe('limited');
    expect(result.usageLimit).toMatchObject({ limited: true, kind: 'usage', source: 'antigravity-error-composer' });
    expect(result.usageLimit.relativeResetKey).toContain(id);
    expect(result.usageLimit.retryAtMs).toBe(Date.now() + ((124 * 60 + 24) * 60 + 15) * 1000);
  });

  it('keeps distinct colored Error IDs from sharing the first refusal deadline', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    let errorId = 'first';
    const { classify } = classifier(() => `⚠ Individual quota reached. Resets in ${color('1m')}.\nError ID: ${color(errorId)}` + composer);
    const first = classify('', 'working').usageLimit;
    vi.advanceTimersByTime(20_000); errorId = 'second';
    const second = classify('', 'working').usageLimit;
    expect(second.relativeResetKey).not.toBe(first.relativeResetKey);
    expect(reconcileUsageLimitState(first, second).retryAtMs).toBe(Date.now() + 60_000);
  });

  it('ignores a past-reset refusal in the viewport across turns and accepts a new Error ID', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const refusal = (errorId: string) => `⚠ Individual quota reached. Resets in 1m.\nError ID: ${errorId}`;
    let screen = refusal('old') + composer;
    const { classify, usageLimitTracker } = classifier(() => screen);
    const first = classify('', 'idle').usageLimit;
    expect(first?.source).toBe('antigravity-error-composer');

    vi.advanceTimersByTime(59_000);
    expect(classify('', 'idle').usageLimit?.retryAtMs).toBe(first.retryAtMs);

    vi.advanceTimersByTime(1_000);
    const turn = usageLimitTracker.beginTurn(screen);
    expect(classify('', 'idle')).toEqual({ status: 'idle' });
    expect(usageLimitTracker.detectedThisTurn(turn)).toBe(false);

    screen = refusal('old') + '\n429 Too Many Requests';
    expect(classify('', 'idle').usageLimit?.kind).toBe('rate');
    expect(usageLimitTracker.detectedThisTurn(turn)).toBe(true);

    const retryTurn = usageLimitTracker.beginTurn(screen);
    screen = refusal('old') + '\n' + refusal('new') + composer;
    const fresh = classify('', 'idle').usageLimit;
    expect(fresh?.relativeResetKey).toContain('new');
    expect(fresh?.retryAtMs).toBe(Date.now() + 60_000);
    expect(usageLimitTracker.detectedThisTurn(retryTurn)).toBe(true);
  });

  it('uses the first published deadline when a partial refusal gains its native composer', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    let screen = '⚠ Individual quota reached. Resets in 1m.\nError ID: partial-first';
    const { classify } = classifier(() => screen);
    const partial = classify('', 'idle').usageLimit;
    expect(partial?.source).toBeUndefined();

    vi.advanceTimersByTime(10_000);
    screen += composer;
    const confirmed = classify('', 'idle').usageLimit;
    expect(confirmed?.source).toBe('antigravity-error-composer');
    expect(confirmed?.retryAtMs).toBe(partial.retryAtMs);

    vi.advanceTimersByTime(50_000);
    expect(classify('', 'idle')).toEqual({ status: 'idle' });
  });

  it('suppresses an expired refusal revealed by a redraw after a newer refusal', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const oldScreen = '⚠ Individual quota reached. Resets in 1m.\nError ID: old' + composer;
    const newScreen = oldScreen.replace('Error ID: old', 'Error ID: new');
    let screen = oldScreen;
    const { classify, usageLimitTracker } = classifier(() => screen);
    expect(classify('', 'idle').usageLimit?.relativeResetKey).toContain('old');

    vi.advanceTimersByTime(60_000);
    screen = newScreen;
    const fresh = classify('', 'idle').usageLimit;
    expect(fresh?.relativeResetKey).toContain('new');

    screen = oldScreen;
    const turn = usageLimitTracker.beginTurn(screen);
    expect(classify('', 'idle')).toEqual({ status: 'idle' });
    expect(usageLimitTracker.detectedThisTurn(turn)).toBe(false);

    screen = newScreen;
    vi.advanceTimersByTime(1_000);
    expect(classify('', 'idle').usageLimit?.retryAtMs).toBe(fresh.retryAtMs);
  });

  it('evicts the oldest refusal without promoting a repeated key', () => {
    const first: CliUsageLimitState = {
      limited: true, kind: 'usage', retryAtMs: 60_000, retryLabel: '1m', retryReady: false,
      relativeResetKey: 'usage:60000:first', source: 'antigravity-error-composer',
    };
    let history = rememberAntigravityQuota(undefined, first);
    const newerKeys = Array.from({ length: ANTIGRAVITY_QUOTA_HISTORY_LIMIT }, (_, index) => `usage:60000:${index}`);
    for (const key of newerKeys) {
      expect(rememberAntigravityQuota(history, { ...first, retryAtMs: 120_000 })).toBe(history);
      history = rememberAntigravityQuota(history, { ...first, relativeResetKey: key });
    }
    expect(history?.map(entry => entry.relativeResetKey)).toEqual(newerKeys);
  });

  it('retains actual working footer authority above a colored historical refusal', () => {
    const { classify } = classifier(() => quota + composer + color('esc to cancel · 1 task(s)'));
    expect(classify('', 'idle')).toEqual({ status: 'working' });
  });

  it('keeps other CLIs on their existing display-frame path', () => {
    const { classify, capture } = classifier(() => quota + composer, 'traex');
    expect(classify('ordinary output', 'working')).toEqual({ status: 'working' });
    expect(capture).not.toHaveBeenCalled();
  });
});
