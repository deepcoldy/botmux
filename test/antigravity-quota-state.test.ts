import { describe, expect, it } from 'vitest';
import {
  createAntigravityQuotaStateMachine,
  deriveLegacyAntigravityQuotaCursor,
} from '../src/services/antigravity-quota-state.js';
import type { AntigravityNativeQuotaRefusal } from '../src/services/antigravity-native-quota.js';
import { createUsageLimitTracker } from '../src/utils/usage-limit-tracker.js';
import { decideSubmitConfirmationAction } from '../src/services/submit-confirmation.js';
import { cliUsageLimitEpisodeKey } from '../src/utils/cli-usage-limit.js';

const FOOTER_READY = '\n────\n>\n────\n? for shortcuts  accept-edits · Gemini 4 Neon · xhigh';
const FOOTER_LESS = '\n────\n>\n────\n';
const QUOTA_LINE = (duration = '2h39m35s') =>
  `⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${duration}.`;

const logRefusal = (ts: string, duration = '2h39m35s', seq = 1): AntigravityNativeQuotaRefusal => ({
  nativeEpisodeKey: `log:${ts}`,
  text: `Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${duration}.`,
  inputSequence: seq,
});

describe('AntigravityQuotaStateMachine (SSOT)', () => {
  const T0 = Date.parse('2026-11-25T00:00:00.000Z');

  it('promotes 1.5.15+ shortcuts-footer screen only when native log countdown matches screen countdown', () => {
    const screen = `${QUOTA_LINE('2h39m35s')}\nError ID: err-1${FOOTER_READY}`;

    // verified 1.5.15+ with matching countdown -> antigravity-native-log.
    const sm1 = createAntigravityQuotaStateMachine();
    const promoted = sm1.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:01.000000', '2h39m35s'),
      nowMs: T0,
    });
    expect(promoted.status).toBe('limited');
    expect(promoted.usageLimit).toMatchObject({
      source: 'antigravity-native-log',
      nativeEpisodeKey: 'log:E1125 00:00:01.000000',
      retryLabel: '2h39m35s',
    });
    expect(promoted.detectedThisTurn).toBe(true);

    // countdown mismatch MUST reject native-log promotion -> ready-composer recovery.
    const sm2 = createAntigravityQuotaStateMachine();
    const mismatch = sm2.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:01.000000', '1h02m03s'),
      nowMs: T0,
    });
    expect(mismatch).toEqual({
      status: 'idle',
      usageLimitRecovery: 'antigravity-ready-composer',
      detectedThisTurn: false,
    });

    // spoofed quota text without native log -> ready-composer recovery, zero native provenance.
    const sm3 = createAntigravityQuotaStateMachine();
    const spoofed = sm3.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nowMs: T0,
    });
    expect(spoofed).toEqual({
      status: 'idle',
      usageLimitRecovery: 'antigravity-ready-composer',
      detectedThisTurn: false,
    });

    // legacy / unknown agy (`supportsReadyFooterQuota: false`) recovers on shortcuts footer even with a log line.
    const smLegacy = createAntigravityQuotaStateMachine();
    const legacyRecovered = smLegacy.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: false,
      nativeLogQuota: logRefusal('E1125 00:00:01.000000', '2h39m35s'),
      nowMs: T0,
    });
    expect(legacyRecovered).toEqual({
      status: 'idle',
      usageLimitRecovery: 'antigravity-ready-composer',
      detectedThisTurn: false,
    });
  });

  it('keeps distinct native-log episodes with identical countdown and no Error ID independent', () => {
    const sm = createAntigravityQuotaStateMachine();
    const screen = `${QUOTA_LINE('1m')}${FOOTER_READY}`;
    const first = sm.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:01.000000', '1m', 1),
      nowMs: T0,
    });
    const second = sm.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:25.000000', '1m', 2),
      nowMs: T0 + 25_000,
    });
    expect(first.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:01.000000');
    expect(second.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:25.000000');
    expect(second.usageLimit?.retryAtMs).toBe(T0 + 25_000 + 60_000);
    expect(second.usageLimit?.retryAtMs).not.toBe(first.usageLimit?.retryAtMs);
  });

  it('suppresses answered-turn stale annotated composer banner while re-arming for fresh Error ID or native log', () => {
    const sm = createAntigravityQuotaStateMachine();
    const oldScreen = `${QUOTA_LINE('1m')}\nError ID: old-error${FOOTER_LESS}`;
    sm.beginTurn(oldScreen, T0);
    sm.noteTurnAnswered();

    // Exact same banner stays idle after answered turn (no raw vs annotated mismatch resurrection).
    expect(sm.classify({
      screen: oldScreen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nowMs: T0 + 1_000,
    })).toEqual({ status: 'idle', detectedThisTurn: false });

    // Distinct Error ID on same countdown re-arms limited.
    const freshComposer = sm.classify({
      screen: `${QUOTA_LINE('1m')}\nError ID: new-error${FOOTER_LESS}`,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nowMs: T0 + 2_000,
    });
    expect(freshComposer.status).toBe('limited');
    expect(freshComposer.usageLimit?.nativeEpisodeKey).toBe('composer:new-error');
  });

  it('does not pollute detectedThisTurn on ready-composer recovery', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false, isOutputActive: () => false });
    const sm = createAntigravityQuotaStateMachine();
    tracker.addTurnListener(ev => {
      if (ev.kind === 'beginTurn') sm.beginTurn(ev.snapshot, T0);
      else sm.noteTurnAnswered();
    });

    const seq = tracker.beginTurn('');
    // First hit limit on this turn, then recover cleanly via ready composer.
    const limited = sm.classify({
      screen: `${QUOTA_LINE('1m')}\nError ID: e1${FOOTER_LESS}`,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nowMs: T0,
    });
    expect(limited.detectedThisTurn).toBe(true);
    tracker.noteTurnDetected();
    expect(tracker.detectedThisTurn(seq)).toBe(true);

    const recovered = sm.classify({
      screen: `${QUOTA_LINE('1m')}\nError ID: e1${FOOTER_READY}`,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: false,
      nowMs: T0 + 1_000,
    });
    expect(recovered.usageLimitRecovery).toBe('antigravity-ready-composer');
    expect(recovered.detectedThisTurn).toBe(false);
    tracker.noteScreenRecovery();
    expect(tracker.detectedThisTurn(seq)).toBe(false);

    const action = decideSubmitConfirmationAction({
      recheckSubmitted: false,
      limitDetectedThisTurn: tracker.detectedThisTurn(seq),
    });
    expect(action).toEqual({ kind: 'notify-stuck' });
  });

  it('binds a late native-log key once on an answered pre-existing banner and re-arms on replacement', () => {
    // Timing A: native key arrives AFTER noteTurnAnswered().
    const smA = createAntigravityQuotaStateMachine();
    const banner = `${QUOTA_LINE('2h')}${FOOTER_LESS}`;
    smA.beginTurn(banner, T0);
    smA.noteTurnAnswered();

    const first = smA.classify({
      screen: banner,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:01.000000', '2h'),
      nowMs: T0 + 1_000,
    });
    const repeat = smA.classify({
      screen: banner,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:01.000000', '2h'),
      nowMs: T0 + 2_000,
    });
    const replacement = smA.classify({
      screen: banner,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:09.000000', '2h', 2),
      nowMs: T0 + 3_000,
    });
    expect(first.status).toBe('idle');
    expect(repeat.status).toBe('idle');
    expect(replacement.status).toBe('limited');
    expect(replacement.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:09.000000');

    // Timing B: native key already present in log when noteTurnAnswered(key) runs.
    const smB = createAntigravityQuotaStateMachine();
    smB.beginTurn(banner, T0);
    smB.noteTurnAnswered('log:E1125 00:00:01.000000');
    expect(smB.classify({
      screen: banner,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:01.000000', '2h'),
      nowMs: T0 + 1_000,
    }).status).toBe('idle');
    expect(smB.classify({
      screen: banner,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:09.000000', '2h', 2),
      nowMs: T0 + 2_000,
    }).usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:09.000000');
  });

  it('never lets an unlinked historical composer veto a fresh native-log episode B, and promotes differently-linked composer to unlinked B', () => {
    // unlinked composer:E followed by fresh log:B on same pixels.
    const sm1 = createAntigravityQuotaStateMachine();
    const screen = `${QUOTA_LINE('1m')}\nError ID: E${FOOTER_LESS}`;
    const a = sm1.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nowMs: T0,
    });
    expect(a.usageLimit?.nativeEpisodeKey).toBe('composer:E');

    const b = sm1.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:10.000000', '1m'),
      nowMs: T0 + 10_000,
    });
    expect(b.status).toBe('limited');
    expect(b.usageLimit?.source).toBe('antigravity-native-log');
    expect(b.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:10.000000');
    expect(b.usageLimit?.linkedNativeEpisodeKey).toBeUndefined();

    // simultaneously linked composer:E + log:A switches to unlinked log:B.
    const sm2 = createAntigravityQuotaStateMachine();
    const linked = sm2.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:01.000000', '1m', 1),
      nowMs: T0,
    });
    expect(linked.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:01.000000');
    expect(linked.usageLimit?.linkedNativeEpisodeKey).toBe('composer:E');

    const replaced = sm2.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:15.000000', '1m', 2),
      nowMs: T0 + 15_000,
    });
    expect(replaced.usageLimit?.source).toBe('antigravity-native-log');
    expect(replaced.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:15.000000');
    expect(replaced.usageLimit?.linkedNativeEpisodeKey).toBeUndefined();
  });

  it('isolates per-raw-banner associations so unrelated banner B never overwrites banner A', () => {
    const sm = createAntigravityQuotaStateMachine();
    const screenA = `${QUOTA_LINE('1h')}${FOOTER_READY}`;
    const screenB = `${QUOTA_LINE('2h')}${FOOTER_READY}`;

    sm.classify({
      screen: screenA,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:01.000000', '1h', 1),
      nowMs: T0,
    });
    sm.classify({
      screen: screenB,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:02.000000', '2h', 2),
      nowMs: T0 + 1_000,
    });

    // Return to banner A -> beginTurn -> answered -> fresh log:C on banner A MUST fire limited!
    sm.beginTurn(screenA, T0 + 2_000);
    sm.noteTurnAnswered();
    const freshC = sm.classify({
      screen: screenA,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:09.000000', '1h', 3),
      nowMs: T0 + 3_000,
    });
    expect(freshC.status).toBe('limited');
    expect(freshC.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:09.000000');
  });

  it('retains lastConfirmed across reader gaps and preserves recovered tombstone across gaps, generic frames, and A->B->A restore', () => {
    const sm = createAntigravityQuotaStateMachine();
    const screenE = `${QUOTA_LINE('1m')}\nError ID: E${FOOTER_LESS}`;

    // Link composer:E + log:A, then replace with log:B.
    sm.classify({
      screen: screenE,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:01.000000', '1m', 1),
      nowMs: T0,
    });
    const b = sm.classify({
      screen: screenE,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: logRefusal('E1125 00:00:05.000000', '1m', 2),
      nowMs: T0 + 5_000,
    });
    expect(b.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:05.000000');

    // temporary reader gap (no nativeLogQuota) keeps log:B instead of reviving composer:E / log:A.
    const gap = sm.classify({
      screen: screenE,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nowMs: T0 + 6_000,
    });
    expect(gap.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:05.000000');
    expect(gap.usageLimit?.linkedNativeEpisodeKey).toBeUndefined();

    // ready-composer recovery sets tombstone for log:B; footerless reader gap stays suppressed.
    const rec = sm.classify({
      screen: `${QUOTA_LINE('1m')}\nError ID: E${FOOTER_READY}`,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nowMs: T0 + 7_000,
    });
    expect(rec.usageLimitRecovery).toBe('antigravity-ready-composer');
    expect(sm.exportCursor().recoveredEpisodeKey).toBe('log:E1125 00:00:05.000000');

    const postGap = sm.classify({
      screen: screenE,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nowMs: T0 + 8_000,
    });
    expect(postGap.status).toBe('idle');

    // generic active frame never wipes recovered tombstone.
    const generic = sm.classify({
      screen: `${QUOTA_LINE('1m')}\nError ID: E`,
      nativeViewportCaptured: false,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nowMs: T0 + 9_000,
    });
    expect(generic.status).toBe('limited');
    expect(sm.exportCursor().recoveredEpisodeKey).toBe('log:E1125 00:00:05.000000');

    // A -> B -> A -> recovery -> restore preserves exact A tombstone regardless of [A, B] history order.
    const smOrder = createAntigravityQuotaStateMachine();
    const screenA = `${QUOTA_LINE('1m')}\nError ID: A${FOOTER_LESS}`;
    const screenB = `${QUOTA_LINE('1m')}\nError ID: B${FOOTER_LESS}`;
    smOrder.classify({ screen: screenA, nativeViewportCaptured: true, runtimeStatus: 'idle', supportsReadyFooterQuota: true, nowMs: T0 });
    smOrder.classify({ screen: screenB, nativeViewportCaptured: true, runtimeStatus: 'idle', supportsReadyFooterQuota: true, nowMs: T0 + 1_000 });
    smOrder.classify({ screen: screenA, nativeViewportCaptured: true, runtimeStatus: 'idle', supportsReadyFooterQuota: true, nowMs: T0 + 2_000 });
    smOrder.classify({ screen: `${QUOTA_LINE('1m')}\nError ID: A${FOOTER_READY}`, nativeViewportCaptured: true, runtimeStatus: 'idle', supportsReadyFooterQuota: false, nowMs: T0 + 3_000 });

    const cursor = smOrder.exportCursor();
    expect(cursor.recoveredEpisodeKey).toBe('composer:A');
    expect(cliUsageLimitEpisodeKey(cursor.lastConfirmed ?? undefined)).toBe('composer:A');

    const restored = createAntigravityQuotaStateMachine();
    restored.restore({ history: smOrder.exportHistory(), activeQuota: undefined, cursor });
    expect(restored.classify({ screen: screenA, nativeViewportCaptured: true, runtimeStatus: 'idle', supportsReadyFooterQuota: true, nowMs: T0 + 4_000 }).status).toBe('idle');
    expect(restored.classify({ screen: screenB, nativeViewportCaptured: true, runtimeStatus: 'idle', supportsReadyFooterQuota: true, nowMs: T0 + 5_000 }).status).toBe('limited');

    // Legacy cursor derivation when persisted row lacks antigravityQuotaCursor.
    const legacyCursor = deriveLegacyAntigravityQuotaCursor(undefined, smOrder.exportHistory());
    expect(legacyCursor.recoveredEpisodeKey).toBe('composer:B');
  });

  it('retires the current native-log refusal when the same input internally retries and answers', () => {
    const sm = createAntigravityQuotaStateMachine();
    const readyScreen = `${QUOTA_LINE('2h39m35s')}\nError ID: retry-ok\nHere is your final answer.${FOOTER_READY}`;
    const oldLog = logRefusal('E1125 00:00:01.000000', '2h39m35s', 1);

    sm.beginTurn('', T0);
    // Same input hits 429, internally retries, outputs answer, and settles as answered.
    sm.noteTurnAnswered(oldLog.nativeEpisodeKey);

    // Ready screen still shows the old banner and the log still has the same refusal -> MUST be idle/recovered!
    const afterAnswer = sm.classify({
      screen: readyScreen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: oldLog,
      nowMs: T0 + 5_000,
    });
    expect(afterAnswer).toEqual({
      status: 'idle',
      usageLimitRecovery: 'antigravity-ready-composer',
      detectedThisTurn: false,
    });

    // A genuinely new refusal (distinct native timestamp) on a later turn still triggers limited.
    sm.beginTurn(readyScreen, T0 + 10_000);
    const freshLog = logRefusal('E1125 00:00:12.000000', '2h39m35s', 2);
    const nextTurn = sm.classify({
      screen: readyScreen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: freshLog,
      nowMs: T0 + 12_000,
    });
    expect(nextTurn.status).toBe('limited');
    expect(nextTurn.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:12.000000');
  });

  it('honors legacy pre-refactor SQLite composer rows for tombstone suppression and history deduplication', () => {
    const legacyRow = {
      limited: true as const,
      kind: 'usage' as const,
      retryAtMs: T0 + 60_000,
      retryLabel: '1m',
      retryReady: false,
      source: 'antigravity-error-composer' as const,
      relativeResetKey: 'usage:60000:err-legacy',
    };
    const sm = createAntigravityQuotaStateMachine();
    sm.restore({ history: [legacyRow], activeQuota: undefined, cursor: undefined });
    expect(sm.exportCursor().recoveredEpisodeKey).toBe('composer:err-legacy');

    const screen = `${QUOTA_LINE('1m')}\nError ID: err-legacy${FOOTER_LESS}`;
    const res = sm.classify({
      screen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nowMs: T0 + 1_000,
    });
    expect(res.status).toBe('idle');
    expect(res.detectedThisTurn).toBe(false);
    expect(sm.exportHistory()).toHaveLength(1);
  });

  it('persists answered-turn native-log retirements in recovery cursor across worker restart and suppresses capture-failure fallback', () => {
    const sm1 = createAntigravityQuotaStateMachine();
    const refusal = logRefusal('E1125 00:00:02.000000', '2h39m35s', 1);
    sm1.beginTurn('', T0);
    // Answered before any classify() tick ever ran.
    sm1.noteTurnAnswered(refusal);

    // Capture failure (nativeViewportCaptured=false) on leftover text stays suppressed.
    const fallback = sm1.classify({
      screen: `${QUOTA_LINE('2h39m35s')}\nError ID: err-capfail`,
      nativeViewportCaptured: false,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: refusal,
      nowMs: T0 + 2_000,
    });
    expect(fallback.status).toBe('idle');

    // Restarted worker restores cursor and keeps retired log refusal suppressed.
    const cursor = sm1.exportCursor();
    expect(cursor.retiredNativeLogKeys).toEqual(['log:E1125 00:00:02.000000']);
    const sm2 = createAntigravityQuotaStateMachine();
    sm2.restore({ history: sm1.exportHistory(), activeQuota: undefined, cursor });
    const afterRestart = sm2.classify({
      screen: `${QUOTA_LINE('2h39m35s')}\nError ID: err-capfail${FOOTER_READY}`,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: refusal,
      nowMs: T0 + 3_000,
    });
    expect(afterRestart).toEqual({
      status: 'idle',
      usageLimitRecovery: 'antigravity-ready-composer',
      detectedThisTurn: false,
    });
  });

  it('rebuilds rawBannerAssociations on restore and isolates fixed-time footerless Error IDs across turns', () => {
    const sm1 = createAntigravityQuotaStateMachine();
    const screenA = `${QUOTA_LINE('1h')}${FOOTER_READY}`;
    const screenB = `${QUOTA_LINE('2h')}${FOOTER_READY}`;
    sm1.classify({
      screen: screenA, nativeViewportCaptured: true, runtimeStatus: 'idle',
      supportsReadyFooterQuota: true, nativeLogQuota: logRefusal('E1125 00:00:01.000000', '1h', 1), nowMs: T0,
    });
    sm1.classify({
      screen: screenB, nativeViewportCaptured: true, runtimeStatus: 'idle',
      supportsReadyFooterQuota: true, nativeLogQuota: logRefusal('E1125 00:00:02.000000', '2h', 2), nowMs: T0 + 1_000,
    });

    // After restart, rawBannerAssociations must still remember screenA -> log:00:00:01 so fresh log:00:00:09 fires limited!
    const sm2 = createAntigravityQuotaStateMachine();
    sm2.restore({ history: sm1.exportHistory(), activeQuota: undefined, cursor: sm1.exportCursor() });
    sm2.beginTurn(screenA, T0 + 2_000);
    sm2.noteTurnAnswered();
    const freshC = sm2.classify({
      screen: screenA, nativeViewportCaptured: true, runtimeStatus: 'idle',
      supportsReadyFooterQuota: true, nativeLogQuota: logRefusal('E1125 00:00:09.000000', '1h', 3), nowMs: T0 + 3_000,
    });
    expect(freshC.status).toBe('limited');
    expect(freshC.usageLimit?.nativeEpisodeKey).toBe('log:E1125 00:00:09.000000');

    // Fixed-time footerless composer E1 must not shadow a later fixed-time E2 on beginTurn + answered.
    const fixedE1 = `⚠ Individual quota reached. Resets at 3:00pm.\nError ID: E1${FOOTER_LESS}`;
    const fixedE2 = `⚠ Individual quota reached. Resets at 3:00pm.\nError ID: E2${FOOTER_LESS}`;
    sm2.classify({ screen: fixedE1, nativeViewportCaptured: true, runtimeStatus: 'idle', supportsReadyFooterQuota: true, nowMs: T0 + 4_000 });
    sm2.beginTurn(fixedE2, T0 + 5_000);
    sm2.noteTurnAnswered();
    expect(sm2.classify({ screen: fixedE2, nativeViewportCaptured: true, runtimeStatus: 'idle', supportsReadyFooterQuota: true, nowMs: T0 + 6_000 }).status).toBe('idle');
  });
});
