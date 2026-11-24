import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { createUsageLimitTracker } from '../src/utils/usage-limit-tracker.js';
import { reconcileUsageLimitState, detectCliUsageLimit, cliUsageLimitEpisodeKey, type CliUsageLimitState } from '../src/utils/cli-usage-limit.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';
import { ANTIGRAVITY_QUOTA_HISTORY_LIMIT, annotateAntigravityUsageLimit, isAntigravityWorkingScreen, isAntigravityReadyComposerScreen, rememberAntigravityQuota } from '../src/adapters/cli/antigravity.js';
import { AntigravityNativeQuotaLog, currentAntigravityNativeQuota } from '../src/services/antigravity-native-quota.js';

function classifier(raw: () => string, cliId = 'antigravity', authoritative = true, outputActive = false, nativeText?: string,
  readNative?: () => { key: string; text: string } | undefined) {
  const capture = vi.fn(raw);
  const usageLimitTracker = createUsageLimitTracker({ isRateKindSuppressed: () => false, isOutputActive: () => outputActive });
  const classify = loadWorkerFunction<(content: string, status: string) => any>('classifyUsageLimitWithNativeEvidence', {
    cliAdapter: { id: cliId }, backend: {}, captureBackendScreen: capture,
    backendScreenEvidenceIsAuthoritativeForMutation: () => authoritative,
    stripAnsiScreenText, isAntigravityWorkingScreen, isAntigravityReadyComposerScreen, annotateAntigravityUsageLimit,
    readAntigravityNativeQuota: readNative ?? (() => nativeText ? { key: 'native-test', text: nativeText } : undefined),
    withAntigravityDirectFailureProof: (limit: CliUsageLimitState) => limit, detectCliUsageLimit, cliUsageLimitEpisodeKey,
    usageLimitTracker, reconcileUsageLimitState, rememberAntigravityQuota, antigravityQuotaHistory: undefined,
    unconfirmedAntigravityQuotas: new Map(), ANTIGRAVITY_QUOTA_HISTORY_LIMIT,
  });
  return { classify, capture, usageLimitTracker };
}
const composer = '\r\n────\r\n>\r\n────\r\n';
const quota = '⚠ Individual quota reached. Resets in 124h24m15s.';
const currentQuotaScreen = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.\n'
  + 'Error ID: af1698f6-aaaa-bbbb-cccc-dddddddddddd-1\n────\n>\n────\n? for shortcuts  accept-edits · Gemini 4 Neon · xhigh';
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

  it('recognizes the current quota wording above an empty composer with the normal shortcuts footer', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-23T13:38:00Z'));
    const { classify } = classifier(() => currentQuotaScreen, 'antigravity', true, false, currentQuotaScreen);
    const result = classify('display-only snapshot', 'idle');
    expect(result.status).toBe('limited');
    expect(result.usageLimit).toMatchObject({
      kind: 'usage', retryLabel: '2h39m35s', source: 'antigravity-native-log', nativeEpisodeKey: 'log:native-test',
    });
    expect(result.usageLimit.retryAtMs).toBe(Date.now() + ((2 * 60 + 39) * 60 + 35) * 1000);
  });

  it('reports a large-turn quota on the first idle sample instead of emitting a false recovery edge', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-agy-large-quota-'));
    try {
      const path = join(root, 'session.log');
      const log = new AntigravityNativeQuotaLog(path);
      const noise = (bytes: number) => Array.from({ length: Math.ceil(bytes / 1024) }, () =>
        `I1123 13:39:08.000000 300 runner.go:1] ${'x'.repeat(1000)}`).join('\n') + '\n';
      writeFileSync(path, noise(9 * 1024));
      expect(log.read().quota).toBeUndefined();
      appendFileSync(path,
        'I1123 13:39:07.000000 100 input_loop.go:104] HandleUserInput called with text: "large task"\n'
        + noise(350 * 1024)
        + 'E1123 13:39:10.000000 200 errorreport.go:282] agent executor error: generating and executing: transport error (ResourceExhausted, HTTP 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.\n');
      const { classify } = classifier(() => currentQuotaScreen, 'antigravity', true, false, undefined,
        () => currentAntigravityNativeQuota(log.read(), 'large task'));
      expect(classify('', 'idle')).toMatchObject({
        status: 'limited',
        usageLimit: { source: 'antigravity-native-log', retryLabel: '2h39m35s' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat the same footer as recovery while fresh output still suppresses the working-frame verdict', () => {
    const { classify } = classifier(() => currentQuotaScreen, 'antigravity', true, true, currentQuotaScreen);
    expect(classify('display-only snapshot', 'working')).toEqual({ status: 'working' });
  });

  it('does not promote tool-quoted quota output above an ordinary ready composer', () => {
    const quoted = '● Bash(cat incident.log)\n  ⎿  done\n' + currentQuotaScreen;
    const { classify } = classifier(() => quoted);
    expect(classify('', 'idle')).toEqual({
      status: 'idle', usageLimitRecovery: 'antigravity-ready-composer',
    });
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
    expect(classify('', 'idle')).toMatchObject({ status: 'idle', expiredAntigravityQuota: { source: 'antigravity-error-composer' } });
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

  it('suppresses an answered turn\'s old annotated banner without merging a fresh Error ID', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const refusal = (errorId: string) => `⚠ Individual quota reached. Resets in 1m.\nError ID: ${errorId}` + composer;
    let screen = refusal('answered-old');
    const { classify, usageLimitTracker } = classifier(() => screen);
    const turn = usageLimitTracker.beginTurn(screen);
    usageLimitTracker.noteTurnCompleted('answered');

    expect(classify('', 'idle')).toEqual({ status: 'idle' });
    expect(usageLimitTracker.detectedThisTurn(turn)).toBe(false);

    screen = refusal('answered-fresh');
    expect(classify('', 'idle').usageLimit?.nativeEpisodeKey).toBe('composer:answered-fresh');
    expect(usageLimitTracker.detectedThisTurn(turn)).toBe(true);
  });

  it('re-arms an answered turn for a different native-log episode on identical pixels', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    let nativeKey = 'native-answered-old';
    const { classify, usageLimitTracker } = classifier(() => currentQuotaScreen, 'antigravity', true, false, undefined,
      () => ({ key: nativeKey, text: currentQuotaScreen }));
    expect(classify('', 'idle').usageLimit?.nativeEpisodeKey).toBe('log:native-answered-old');

    const turn = usageLimitTracker.beginTurn(currentQuotaScreen);
    usageLimitTracker.noteTurnCompleted('answered');
    expect(classify('', 'idle')).toEqual({ status: 'idle' });
    expect(usageLimitTracker.detectedThisTurn(turn)).toBe(false);

    nativeKey = 'native-answered-new';
    expect(classify('', 'idle').usageLimit?.nativeEpisodeKey).toBe('log:native-answered-new');
    expect(usageLimitTracker.detectedThisTurn(turn)).toBe(true);
  });

  it('uses the first published deadline when a partial refusal gains its native composer', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const partialScreen = '⚠ Individual quota reached. Resets in 1m.\nError ID: partial-first';
    let screen = partialScreen;
    const { classify } = classifier(() => screen);
    const partial = classify('', 'idle').usageLimit;
    expect(partial?.source).toBeUndefined();

    vi.advanceTimersByTime(10_000);
    screen += composer;
    const confirmed = classify('', 'idle').usageLimit;
    expect(confirmed?.source).toBe('antigravity-error-composer');
    expect(confirmed?.retryAtMs).toBe(partial.retryAtMs);

    vi.advanceTimersByTime(50_000);
    expect(classify('', 'idle')).toMatchObject({ status: 'idle', expiredAntigravityQuota: { source: 'antigravity-error-composer' } });

    screen = partialScreen;
    expect(classify('', 'idle').status).toBe('limited');
  });

  it('keeps reporting a partial refusal until its native composer is confirmed', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const screen = '⚠ Individual quota reached. Resets in 1m.\nError ID: unconfirmed';
    const { classify } = classifier(() => screen);
    const partial = classify('', 'idle').usageLimit;
    vi.advanceTimersByTime(60_000);
    expect(classify('', 'idle')).toMatchObject({ status: 'limited', usageLimit: { retryAtMs: partial.retryAtMs } });
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
    expect(classify('', 'idle')).toMatchObject({ status: 'idle', expiredAntigravityQuota: { source: 'antigravity-error-composer' } });
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

  it.each(['idle', 'working'])('does not re-read a historical refusal at a recovered %s composer', status => {
    const recovered = quota + `\nError ID: ${id}` + composer
      + '\n> continue\n\nBOTMUX_NOTHING_TO_SEND\n────\n'
      + '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)\n────\n? for shortcuts';
    const { classify, usageLimitTracker } = classifier(() => recovered);
    const turn = usageLimitTracker.beginTurn(recovered);
    expect(classify('display snapshot retains old quota', status)).toEqual({
      status, usageLimitRecovery: 'antigravity-ready-composer',
    });
    expect(usageLimitTracker.detectedThisTurn(turn)).toBe(false);
  });

  it('detects a new native refusal after a recovered composer', () => {
    let screen = quota + `\nError ID: ${id}` + composer;
    const { classify } = classifier(() => screen);
    expect(classify('', 'idle').status).toBe('limited');
    screen += '\nBOTMUX_NOTHING_TO_SEND\n────\n>\n────\n? for shortcuts';
    expect(classify('', 'idle').usageLimit).toBeUndefined();
    screen += '\n> next task\n' + quota + '\nError ID: new-episode' + composer;
    expect(classify('', 'idle').usageLimit).toMatchObject({
      source: 'antigravity-error-composer', relativeResetKey: expect.stringContaining('new-episode'),
    });
  });

  it.each(['empty', 'failed'])('does not clear a limit from display-only evidence when native capture is %s', mode => {
    const display = quota + `\nError ID: ${id}` + composer
      + '\n>\n────\n? for shortcuts';
    const { classify } = classifier(() => {
      if (mode === 'failed') throw new Error('native capture unavailable');
      return '';
    });
    const result = classify(display, 'idle');
    expect(result.usageLimitRecovery).toBeUndefined();
    expect(result.status).toBe('limited');
  });

  it('does not accept recovery evidence from a backend that cannot prove screen authority', () => {
    const ready = '\n────\n>\n────\n? for shortcuts';
    const { classify, capture } = classifier(() => ready, 'antigravity', false);
    expect(classify(ready, 'idle')).toEqual({ status: 'idle' });
    expect(capture).not.toHaveBeenCalled();
  });

  it('rejects a non-empty draft that ends with the exact placeholder suffix', () => {
    const screen = quota + `\nError ID: ${id}` + composer
      + '> explain this shortcut (shift+tab to cycle)\n────\n? for shortcuts';
    expect(isAntigravityReadyComposerScreen(screen)).toBe(false);
  });

  it.each([
    '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
    '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
    '> Plan mode: research & plan only (shift+tab to cycle)',
    '> Best-of-N mode: fork into parallel arms and pick a winner (shift+tab to cycle)',
  ])('accepts an exact empty placeholder split across terminal rows: %s', placeholder => {
    const splitAt = 23;
    const folded = `${placeholder.slice(0, splitAt)}\n${placeholder.slice(splitAt)}`;
    const screen = quota + `\nError ID: ${id}` + composer + `${folded}\n────\n? for shortcuts`;
    expect(isAntigravityReadyComposerScreen(screen)).toBe(true);
  });

  it.each([
    '> drafted next request\n────\n? for shortcuts',
    '>\n────\n? for shortcuts\nnew output after the footer',
  ])('does not clear a limit using a historical ready footer or a drafted composer (%#)', tail => {
    const screen = quota + `\nError ID: ${id}` + composer + '\n' + tail;
    const { classify } = classifier(() => screen);
    const result = classify('', 'idle');
    expect(result.usageLimitRecovery).toBeUndefined();
    expect(result.status).toBe('limited');
  });
});
