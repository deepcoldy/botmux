import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { createUsageLimitTracker } from '../src/utils/usage-limit-tracker.js';
import { reconcileUsageLimitState } from '../src/utils/cli-usage-limit.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';
import { annotateAntigravityUsageLimit, isAntigravityWorkingScreen } from '../src/adapters/cli/antigravity.js';

function classifier(raw: () => string, cliId = 'antigravity') {
  const capture = vi.fn(raw);
  const classify = loadWorkerFunction<(content: string, status: string) => any>('classifyUsageLimitWithNativeEvidence', {
    cliAdapter: { id: cliId }, backend: {}, captureBackendScreen: capture,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    stripAnsiScreenText, isAntigravityWorkingScreen, annotateAntigravityUsageLimit,
    usageLimitTracker: createUsageLimitTracker({ isRateKindSuppressed: () => false, isOutputActive: () => false }),
  });
  return { classify, capture };
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
