import { describe, expect, it } from 'vitest';
import {
  boundsForClaudeOpenTurn,
  classifyClaudeOpenTurnTier,
  CLAUDE_OPEN_TURN_DEFAULT_BOUNDS,
  ClaudeOpenTurnWatchdog,
  parsePositiveMsEnv,
  type ClaudeOpenTurnObservation,
} from '../src/services/claude-open-turn-watchdog.js';

function obs(overrides: Partial<ClaudeOpenTurnObservation> = {}): ClaudeOpenTurnObservation {
  return {
    turnKey: '1:om_turn_1:',
    durable: false,
    activitySeq: 0,
    unmatchedToolUseCount: 0,
    apiRequestInFlight: false,
    awaitingPostToolAssistant: false,
    hasVisibleAssistantText: false,
    apiRequestObservedInGeneration: false,
    userPromptSubmitObserved: false,
    userStopRequested: false,
    ptyOutputGeneration: 10,
    screenRevision: 5,
    readyPatternVisible: true,
    busyPatternVisible: false,
    programStatusHeldBusy: false,
    pendingBackgroundAgents: false,
    idleSettleInFlight: false,
    cliAlive: true,
    nowMs: 1_000,
    ...overrides,
  };
}

describe('ClaudeOpenTurnWatchdog tier classification and relative bounds', () => {
  it('orders tier priority: user_stop > active_tool > in_flight_model > unmarked_partial > bare_open', () => {
    expect(classifyClaudeOpenTurnTier(obs({ userStopRequested: true, unmatchedToolUseCount: 2, apiRequestInFlight: true }))).toBe('user_stop');
    expect(classifyClaudeOpenTurnTier(obs({ unmatchedToolUseCount: 1, apiRequestInFlight: true, hasVisibleAssistantText: true }))).toBe('active_tool');
    expect(classifyClaudeOpenTurnTier(obs({ apiRequestInFlight: true, hasVisibleAssistantText: true }))).toBe('in_flight_model');
    expect(classifyClaudeOpenTurnTier(obs({ awaitingPostToolAssistant: true, hasVisibleAssistantText: true }))).toBe('in_flight_model');
    expect(classifyClaudeOpenTurnTier(obs({ hasVisibleAssistantText: true }))).toBe('unmarked_partial');
    expect(classifyClaudeOpenTurnTier(obs())).toBe('bare_open');
  });

  it('maintains monotonic bound ordering and Clock 2 >= Clock 1 for every tier', () => {
    const b = CLAUDE_OPEN_TURN_DEFAULT_BOUNDS;
    expect(b.active_tool.quietMs).toBeGreaterThan(b.in_flight_model.quietMs);
    expect(b.in_flight_model.quietMs).toBeGreaterThan(b.bare_open_with_submit_hook.quietMs);
    expect(b.bare_open_with_submit_hook.quietMs).toBeGreaterThan(b.bare_open.quietMs);
    expect(b.bare_open.quietMs).toBeGreaterThan(b.unmarked_partial.quietMs);
    expect(b.unmarked_partial.quietMs).toBeGreaterThan(b.user_stop.quietMs);
    for (const entry of Object.values(b)) {
      expect(entry.maxNoProgressMs).toBeGreaterThanOrEqual(entry.quietMs);
    }
  });

  it('extends bare_open grace only for pre-2.1.304 builds (submit hook seen, no api-request seen in generation)', () => {
    const plain = boundsForClaudeOpenTurn(obs());
    const withHook = boundsForClaudeOpenTurn(obs({ userPromptSubmitObserved: true, apiRequestObservedInGeneration: false }));
    const withApiRequestBuild = boundsForClaudeOpenTurn(obs({ userPromptSubmitObserved: true, apiRequestObservedInGeneration: true }));
    expect(withHook.bounds.quietMs).toBeGreaterThan(plain.bounds.quietMs);
    expect(withApiRequestBuild.bounds.quietMs).toBe(plain.bounds.quietMs);
  });

  it('parses positive finite ms env overrides and rejects zero/negative/garbage values', () => {
    expect(parsePositiveMsEnv(undefined)).toBeUndefined();
    expect(parsePositiveMsEnv('')).toBeUndefined();
    expect(parsePositiveMsEnv('0')).toBeUndefined();
    expect(parsePositiveMsEnv('-500')).toBeUndefined();
    expect(parsePositiveMsEnv('abc')).toBeUndefined();
    expect(parsePositiveMsEnv('1500.9')).toBe(1500);
  });
});

describe('ClaudeOpenTurnWatchdog two-clock state machine', () => {
  it('expires Clock 1 after continuous quiet when neither transcript nor PTY moves', () => {
    const wd = new ClaudeOpenTurnWatchdog({ bareQuietMs: 5_000 });
    const start = obs({ nowMs: 10_000 });
    wd.hold(start, 'screen');
    expect(wd.isHoldingFor(start.turnKey)).toBe(true);
    expect(wd.evaluate(obs({ nowMs: 14_999 }))).toBe('wait');
    expect(wd.evaluate(obs({ nowMs: 15_000 }))).toBe('release-timeout');
  });

  it('defeats the 60s statusLine repaint trap: PTY repaints reset Clock 1 but NEVER reset Clock 2', () => {
    // bareQuietMs=5_000 => Clock 1 = 5_000ms, Clock 2 (maxNoProgressMs) = 10_000ms.
    const wd = new ClaudeOpenTurnWatchdog({ bareQuietMs: 5_000 });
    wd.hold(obs({ nowMs: 0, ptyOutputGeneration: 1, screenRevision: 1, activitySeq: 0 }), 'screen');

    // Periodic statusLine repaints every 3s keep Clock 1 < 5s, yet transcript
    // activitySeq never advances.
    expect(wd.evaluate(obs({ nowMs: 3_000, ptyOutputGeneration: 2, screenRevision: 2, activitySeq: 0 }))).toBe('wait');
    expect(wd.evaluate(obs({ nowMs: 6_000, ptyOutputGeneration: 3, screenRevision: 3, activitySeq: 0 }))).toBe('wait');
    expect(wd.evaluate(obs({ nowMs: 9_000, ptyOutputGeneration: 4, screenRevision: 4, activitySeq: 0 }))).toBe('wait');
    // At t=10_000ms Clock 1 elapsed is only 1_000ms, but Clock 2 hits maxNoProgressMs!
    expect(wd.evaluate(obs({ nowMs: 10_000, ptyOutputGeneration: 5, screenRevision: 5, activitySeq: 0 }))).toBe('release-timeout');
  });

  it('resets BOTH Clock 1 and Clock 2 whenever transcript activitySeq advances', () => {
    const wd = new ClaudeOpenTurnWatchdog({ inflightQuietMs: 5_000 });
    wd.hold(obs({ nowMs: 0, apiRequestInFlight: true, activitySeq: 1 }), 'herdr-done');

    // Progress at t=4s resets both clocks; neither expires until t=9s / t=14s.
    expect(wd.evaluate(obs({ nowMs: 4_000, apiRequestInFlight: false, unmatchedToolUseCount: 1, activitySeq: 2 }))).toBe('wait');
    expect(wd.evaluate(obs({ nowMs: 8_999, unmatchedToolUseCount: 1, activitySeq: 2 }))).toBe('wait');
    // Another tool_result / attachment at t=8.5s via noteIngestProgress extends again.
    wd.noteIngestProgress(obs({ nowMs: 8_500, awaitingPostToolAssistant: true, activitySeq: 3 }));
    expect(wd.evaluate(obs({ nowMs: 13_499, awaitingPostToolAssistant: true, activitySeq: 3 }))).toBe('wait');
    expect(wd.evaluate(obs({ nowMs: 13_500, awaitingPostToolAssistant: true, activitySeq: 3 }))).toBe('release-timeout');
  });

  it('does not let repeated Herdr working->done flapping extend either clock when nothing changed', () => {
    const wd = new ClaudeOpenTurnWatchdog({ inflightQuietMs: 5_000 });
    wd.hold(obs({ nowMs: 0, apiRequestInFlight: true, activitySeq: 1 }), 'herdr-done');
    // Repeated hold() calls for the same turnKey with unchanged seq/PTY/screen:
    wd.hold(obs({ nowMs: 2_000, apiRequestInFlight: true, activitySeq: 1 }), 'herdr-done');
    wd.hold(obs({ nowMs: 4_000, apiRequestInFlight: true, activitySeq: 1 }), 'herdr-done');
    expect(wd.evaluate(obs({ nowMs: 4_999, apiRequestInFlight: true, activitySeq: 1 }))).toBe('wait');
    expect(wd.evaluate(obs({ nowMs: 5_000, apiRequestInFlight: true, activitySeq: 1 }))).toBe('release-timeout');
  });

  it('pauses both clocks during authoritative busy signals (OSC 7501, busy footer, background agents, permission dialog)', () => {
    const wd = new ClaudeOpenTurnWatchdog({ bareQuietMs: 2_000 });
    wd.hold(obs({ nowMs: 0 }), 'screen');
    for (const [label, patch] of [
      ['programStatusHeldBusy', { programStatusHeldBusy: true }],
      ['busyPatternVisible', { busyPatternVisible: true }],
      ['pendingBackgroundAgents', { pendingBackgroundAgents: true }],
      ['non-composer screen', { readyPatternVisible: false }],
    ] as const) {
      expect(wd.evaluate(obs({ nowMs: 100_000, ...patch })), label).toBe('wait');
    }
    // Once authoritative hold clears, a fresh quiet window starts from 100_000ms.
    expect(wd.evaluate(obs({ nowMs: 101_999 }))).toBe('wait');
    expect(wd.evaluate(obs({ nowMs: 102_000 }))).toBe('release-timeout');
  });

  it('re-anchors both clocks on user_stop so an already-held turn gets the full stop grace window, and is not starved by pendingBackgroundAgents/programStatusHeldBusy', () => {
    const wd = new ClaudeOpenTurnWatchdog({ inflightQuietMs: 60_000, userStopQuietMs: 1_500 });
    wd.hold(obs({ nowMs: 0, unmatchedToolUseCount: 1 }), 'screen');
    expect(wd.evaluate(obs({ nowMs: 12_000, unmatchedToolUseCount: 1 }))).toBe('wait');
    // Stop requested at t=12_000ms after 12s held: must NOT expire immediately at +50ms!
    wd.noteUserStop('1:om_turn_1:', 12_000);
    expect(wd.isUserStopRequestedFor('1:om_turn_1:')).toBe(true);
    expect(wd.evaluate(obs({ nowMs: 12_050, unmatchedToolUseCount: 1, pendingBackgroundAgents: true, programStatusHeldBusy: true }))).toBe('wait');
    expect(wd.evaluate(obs({ nowMs: 13_499, unmatchedToolUseCount: 1, pendingBackgroundAgents: true, programStatusHeldBusy: true }))).toBe('wait');
    // At +1_500ms after the stop instant, releases cleanly even with lingering background agents / stale OSC working.
    expect(wd.evaluate(obs({ nowMs: 13_500, unmatchedToolUseCount: 1, pendingBackgroundAgents: true, programStatusHeldBusy: true }))).toBe('release-timeout');
  });

  it('releases immediately when cliAlive === false (preserving state for caller drain/source read), disarms on turnKey change, and never pops durable turns', () => {
    const wd = new ClaudeOpenTurnWatchdog({ bareQuietMs: 5_000 });
    wd.hold(obs({ nowMs: 0, durable: true }), 'screen');
    expect(wd.evaluate(obs({ nowMs: 999_999, durable: true }))).toBe('wait');

    wd.reset();
    wd.hold(obs({ nowMs: 0 }), 'herdr-done');
    expect(wd.evaluate(obs({ nowMs: 100, cliAlive: false }))).toBe('release-dead');
    // State & savedEvidenceSource remain intact until caller finishes pre-settlement drain and calls reset().
    expect(wd.isActive()).toBe(true);
    expect(wd.savedEvidenceSource()).toBe('herdr-done');
    wd.reset();

    wd.hold(obs({ nowMs: 0, turnKey: '1:om_a:' }), 'screen');
    expect(wd.evaluate(obs({ nowMs: 100, turnKey: '1:om_b:' }))).toBe('disarm');
    expect(wd.isActive()).toBe(false);
  });

  it('tracks awaiting-marker-redrive phase separately from holding phase', () => {
    const wd = new ClaudeOpenTurnWatchdog();
    wd.hold(obs({ nowMs: 0, turnKey: '2:om_x:' }), 'herdr-done');
    wd.enterAwaitingMarkerRedrive('2:om_x:');
    expect(wd.getPhase()).toBe('awaiting-marker-redrive');
    expect(wd.isActive()).toBe(true);
    expect(wd.isHoldingFor('2:om_x:')).toBe(false);
    expect(wd.isAwaitingMarkerRedriveFor('2:om_x:')).toBe(true);
    expect(wd.savedEvidenceSource()).toBe('herdr-done');
    expect(wd.evaluate(obs({ nowMs: 10_000, turnKey: '2:om_x:' }))).toBe('disarm');
  });
});
