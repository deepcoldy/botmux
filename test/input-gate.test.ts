/**
 * Worker input-gate: decide whether an incoming Lark message is written to the
 * CLI's PTY immediately or queued until the CLI is ready.
 *
 * The bug this pins: type-ahead adapters (Codex/CoCo) may write while the CLI is
 * BUSY (an active turn parks the input in the TUI queue). But during STARTUP the
 * TUI input box doesn't exist yet, so a type-ahead write is silently lost — the
 * concrete failure was dispatch's brief reaching Codex ~6s before it first went
 * idle and never landing in the input box. The gate must therefore queue even
 * type-ahead messages until the CLI has been ready at least once; the worker's
 * markPromptReady() flush then delivers them.
 *
 * Run: pnpm vitest run test/input-gate.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  decideHardTimeoutAction,
  decidePostHookPromptEvidence,
  decideSettleMarkReady,
  shouldReleaseFirstPromptTimeout,
  shouldWaitForPostSessionStartPromptEvidence,
  shouldWriteNow,
  POST_HOOK_EVIDENCE_FALLBACK_MS,
  POST_HOOK_EVIDENCE_MAX_WAIT_MS,
  POST_HOOK_EVIDENCE_QUIET_MS,
  POST_HOOK_EVIDENCE_RETRY_MS,
} from '../src/utils/input-gate.js';

const base = {
  isPromptReady: false,
  isFlushing: false,
  supportsTypeAhead: false,
  awaitingFirstPrompt: false,
};

describe('shouldWriteNow', () => {
  it('holds stale busy Codex App input even when type-ahead is supported', () => {
    expect(shouldWriteNow({
      isPromptReady: false,
      isFlushing: false,
      supportsTypeAhead: true,
      awaitingFirstPrompt: false,
      holdForRunnerReload: true,
    })).toBe(false);
  });
  it('writes immediately when the prompt is ready (idle)', () => {
    expect(shouldWriteNow({ ...base, isPromptReady: true })).toBe(true);
  });

  it('writes immediately while a flush is already draining', () => {
    expect(shouldWriteNow({ ...base, isFlushing: true })).toBe(true);
  });

  it('type-ahead writes while busy ONCE the CLI has booted (awaitingFirstPrompt=false)', () => {
    expect(shouldWriteNow({ ...base, supportsTypeAhead: true, awaitingFirstPrompt: false })).toBe(true);
  });

  it('THE BUG: queues a type-ahead message that arrives during startup (awaitingFirstPrompt=true)', () => {
    // Codex supports type-ahead, but its TUI input box is not up yet during boot
    // — writing now loses the message. Must queue (false) so markPromptReady flushes it.
    expect(shouldWriteNow({ ...base, supportsTypeAhead: true, awaitingFirstPrompt: true })).toBe(false);
  });

  it('queues when the CLI is busy and does not support type-ahead', () => {
    expect(shouldWriteNow({ ...base, supportsTypeAhead: false, awaitingFirstPrompt: false })).toBe(false);
  });
});

describe('shouldReleaseFirstPromptTimeout', () => {
  it('keeps legacy CLIs on the 15s first-prompt timeout fallback', () => {
    expect(shouldReleaseFirstPromptTimeout({
      deferFirstPromptTimeoutUntilReady: false,
      hasReadyPattern: true,
      elapsedMs: 15_000,
      hardTimeoutMs: 90_000,
    })).toBe(true);
  });

  it('defers first-prompt release before the hard timeout for ready-gated CLIs', () => {
    expect(shouldReleaseFirstPromptTimeout({
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: true,
      elapsedMs: 15_000,
      hardTimeoutMs: 90_000,
    })).toBe(false);
  });

  it('forces first-prompt release at the hard timeout for ready-gated CLIs', () => {
    expect(shouldReleaseFirstPromptTimeout({
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: true,
      elapsedMs: 90_000,
      hardTimeoutMs: 90_000,
    })).toBe(true);
  });

  it('does not defer when there is no readyPattern to wait for', () => {
    expect(shouldReleaseFirstPromptTimeout({
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: false,
      elapsedMs: 15_000,
      hardTimeoutMs: 90_000,
    })).toBe(true);
  });
});

describe('shouldWaitForPostSessionStartPromptEvidence', () => {
  const sessionStartBase = {
    isClaudeFamily: true,
    hasReadyPattern: true,
    awaitingFirstPrompt: true,
    isPromptReady: false,
    alreadyWaiting: false,
  };

  it('requires fresh prompt evidence for a Claude-family first prompt', () => {
    expect(shouldWaitForPostSessionStartPromptEvidence(sessionStartBase)).toBe(true);
  });

  it('keeps Hermes and other non-Claude ready signals authoritative', () => {
    expect(shouldWaitForPostSessionStartPromptEvidence({
      ...sessionStartBase,
      isClaudeFamily: false,
    })).toBe(false);
  });

  it('does not create an unprovable fence without a readyPattern', () => {
    expect(shouldWaitForPostSessionStartPromptEvidence({
      ...sessionStartBase,
      hasReadyPattern: false,
    })).toBe(false);
  });

  it('ignores duplicate and mid-session SessionStart signals', () => {
    expect(shouldWaitForPostSessionStartPromptEvidence({
      ...sessionStartBase,
      alreadyWaiting: true,
    })).toBe(false);
    expect(shouldWaitForPostSessionStartPromptEvidence({
      ...sessionStartBase,
      awaitingFirstPrompt: false,
    })).toBe(false);
    expect(shouldWaitForPostSessionStartPromptEvidence({
      ...sessionStartBase,
      isPromptReady: true,
    })).toBe(false);
  });
});

describe('decideSettleMarkReady', () => {
  it('marks ready when an authoritative direct ready signal fired', () => {
    expect(decideSettleMarkReady({
      promptReadyAfterSettle: true,
      promptReadyDetectedDuringSettle: false,
      readyPatternSeenDuringHold: false,
    })).toBe(true);
  });

  it('marks ready when the idle detector fired during settle', () => {
    expect(decideSettleMarkReady({
      promptReadyAfterSettle: false,
      promptReadyDetectedDuringSettle: true,
      readyPatternSeenDuringHold: false,
    })).toBe(true);
  });

  it('THE HERMES FIX: marks ready when a readyPattern fired while the gate held', () => {
    // Hermes rendered ❯ (readyPattern) during the hold, but never fired the
    // SessionStart signal. The gate's timeout fallback releases + settles;
    // readyPatternSeenDuringHold alone must mark the prompt ready so the
    // held first message flushes (not dropped by !isPromptReady).
    expect(decideSettleMarkReady({
      promptReadyAfterSettle: false,
      promptReadyDetectedDuringSettle: false,
      readyPatternSeenDuringHold: true,
    })).toBe(true);
  });

  it('does NOT mark ready when nothing proved readiness (timeout fallback, no pattern seen)', () => {
    // A CLI with no readyPattern that never fired the signal settles without
    // marking ready — flushPending() delivers for type-ahead adapters only.
    expect(decideSettleMarkReady({
      promptReadyAfterSettle: false,
      promptReadyDetectedDuringSettle: false,
      readyPatternSeenDuringHold: false,
    })).toBe(false);
  });

  it('any single signal is sufficient (OR of all three)', () => {
    expect(decideSettleMarkReady({
      promptReadyAfterSettle: false,
      promptReadyDetectedDuringSettle: true,
      readyPatternSeenDuringHold: true,
    })).toBe(true);
  });
});

describe('decidePostHookPromptEvidence', () => {
  // A prompt that was already on screen before the SessionStart boundary is
  // legitimate evidence, but ONLY when the caller can prove it is still there.
  const waiting = {
    stillWaiting: true,
    elapsedMs: 3_000,
    quietMs: POST_HOOK_EVIDENCE_QUIET_MS,
    screenHasReadyPattern: true,
  };

  it('accepts once the PTY is quiet and the prompt is on the current screen', () => {
    expect(decidePostHookPromptEvidence(waiting)).toEqual({ action: 'accept' });
  });

  it('steps aside the moment real evidence wins the race', () => {
    // markPromptReadyFromPty() clears the waiting flag. A timer that already
    // fired must not seed evidence on top of a session that moved on.
    expect(decidePostHookPromptEvidence({ ...waiting, stillWaiting: false }))
      .toEqual({ action: 'stop' });
  });

  it('gives up at the max wait instead of polling forever', () => {
    // Handing back to the existing first-prompt timeout is the safe default:
    // the fallback must never become a second, unbounded readiness path.
    expect(decidePostHookPromptEvidence({ ...waiting, elapsedMs: POST_HOOK_EVIDENCE_MAX_WAIT_MS }))
      .toEqual({ action: 'stop' });
    expect(decidePostHookPromptEvidence({ ...waiting, elapsedMs: POST_HOOK_EVIDENCE_MAX_WAIT_MS + 1 }))
      .toEqual({ action: 'stop' });
  });

  it('waits out the remainder of the quiet window rather than accepting early', () => {
    // The quiet window proves the CLI stopped emitting, not that a selector is
    // gone — a selector waiting for a keypress is perfectly quiet. What keeps
    // the selector out is the arming point (only after the SessionStart signal,
    // which does not fire while the selector is up); this gate is about not
    // trusting a screen that is still being painted.
    const decision = decidePostHookPromptEvidence({ ...waiting, quietMs: 500 });
    expect(decision.action).toBe('retry');
    expect(decision.retryInMs).toBe(POST_HOOK_EVIDENCE_QUIET_MS - 500 + 100);
  });

  it('first poll is not scheduled before the quiet window can possibly close', () => {
    // The boundary resets the quiescence baseline, so quietMs cannot exceed the
    // time since arming. Polling before the quiet threshold can only ever
    // return retry — and polling later than it adds dead time to every new
    // session. Keep the two aligned.
    expect(POST_HOOK_EVIDENCE_FALLBACK_MS).toBe(POST_HOOK_EVIDENCE_QUIET_MS);
    // At exactly the first poll, a session quiet since the boundary accepts.
    expect(decidePostHookPromptEvidence({
      ...waiting,
      elapsedMs: POST_HOOK_EVIDENCE_FALLBACK_MS,
      quietMs: POST_HOOK_EVIDENCE_FALLBACK_MS,
    }).action).toBe('accept');
  });

  it('boundary: exactly the quiet threshold is enough, one ms short is not', () => {
    expect(decidePostHookPromptEvidence({ ...waiting, quietMs: POST_HOOK_EVIDENCE_QUIET_MS }).action)
      .toBe('accept');
    expect(decidePostHookPromptEvidence({ ...waiting, quietMs: POST_HOOK_EVIDENCE_QUIET_MS - 1 }).action)
      .toBe('retry');
  });

  it('THE SCROLLBACK TRAP: a quiet PTY without the prompt on screen must NOT accept', () => {
    // The first cut of this fix read recentTerminalLogTail() — the appended PTY
    // log with ANSI stripped. A ❯ the TUI had already erased still matched
    // there, so a quiet-but-not-ready screen would have been accepted and the
    // first message forced into a UI that wasn't listening. The caller now
    // passes renderer.rawSnapshot(); this case pins the decision it feeds.
    const decision = decidePostHookPromptEvidence({ ...waiting, screenHasReadyPattern: false });
    expect(decision).toEqual({ action: 'retry', retryInMs: POST_HOOK_EVIDENCE_RETRY_MS });
  });

  it('keeps retrying while the prompt is absent, until the window expires', () => {
    // Absent prompt at 9s → still retry; at 10s the max-wait stop wins.
    expect(decidePostHookPromptEvidence({ ...waiting, elapsedMs: 9_000, screenHasReadyPattern: false }).action)
      .toBe('retry');
    expect(decidePostHookPromptEvidence({ ...waiting, elapsedMs: 10_000, screenHasReadyPattern: false }).action)
      .toBe('stop');
  });

  it('stop beats every other condition — an expired window never accepts', () => {
    expect(decidePostHookPromptEvidence({
      stillWaiting: false,
      elapsedMs: 0,
      quietMs: 60_000,
      screenHasReadyPattern: true,
    })).toEqual({ action: 'stop' });
  });

  it('honours caller-supplied thresholds', () => {
    expect(decidePostHookPromptEvidence({
      ...waiting, quietMs: 400, quietThresholdMs: 300,
    }).action).toBe('accept');
    expect(decidePostHookPromptEvidence({
      ...waiting, elapsedMs: 4_000, maxWaitMs: 4_000,
    }).action).toBe('stop');
  });
});

describe('decideHardTimeoutAction', () => {
  it('type-ahead adapters flush directly at the hard timeout', () => {
    expect(decideHardTimeoutAction(true)).toBe('flush');
  });

  it('THE HERMES FIX: non-type-ahead adapters mark ready (then flush) at the hard timeout', () => {
    // Before this fix, non-type-ahead adapters only logged "forcing flush"
    // without actually delivering — decideHardTimeoutAction(false) must route
    // to mark-ready so markPromptReady() sets isPromptReady and flushes the
    // held first message.
    expect(decideHardTimeoutAction(false)).toBe('mark-ready');
  });
});
