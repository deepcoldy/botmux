/**
 * What a native gateway may learn about one HTTP turn from its dedicated core:
 * only facts produced by that exact turn on the current worker generation
 * (progress), and only owner-actionable states of an active session
 * (reminders). Pure projections over a live-session shape.
 */
import { describe, expect, it } from 'vitest';

import { projectCoreOnlyProgress, rememberCoreOnlyGoal, rememberCoreOnlyLimit } from '../src/core/core-only-progress.js';
import { projectCoreOnlyReminderState } from '../src/core/core-only-reminder-state.js';
import { usageLimitStateKey, type CliUsageLimitState } from '../src/utils/cli-usage-limit.js';
import type { DaemonSession } from '../src/core/types.js';
import type { NativeGoalState } from '../src/services/native-goal-state.js';

const TURN = 'turn';
const GENERATION = 2;

function liveTurn(overrides: Record<string, unknown> = {}) {
  return {
    workerGeneration: GENERATION,
    asyncTriggerResults: new Map([[TURN, { status: 'pending' }]]),
    activeInteractiveTurn: { turnId: TURN },
    initConfig: { apiOnly: true },
    ...overrides,
  } as any;
}

const goal: NativeGoalState = { objective: 'ship it', status: 'active', createdAt: 1, updatedAt: 1, timeUsedSeconds: 0 };
const limit: CliUsageLimitState = { limited: true, kind: 'usage', retryAtMs: 1_000_000, retryLabel: '5pm', retryReady: false };

describe('turn progress for a native gateway', () => {
  it('exists only while the turn is pending', () => {
    expect(projectCoreOnlyProgress(liveTurn(), TURN)).toMatchObject({ turnId: TURN, workerGeneration: GENERATION });
    const finished = liveTurn({ asyncTriggerResults: new Map([[TURN, { status: 'completed' }]]) });
    expect(projectCoreOnlyProgress(finished, TURN)).toBeUndefined();
  });

  it('never shows reasoning cached by an earlier worker generation', () => {
    const entries = [{ type: 'thinking', text: 'reasoning' }];
    const current = liveTurn({ lastThinkingUpdate: { turnId: TURN, workerGeneration: GENERATION, entries } });
    expect(projectCoreOnlyProgress(current, TURN)?.entries).toEqual(entries);
    const stale = liveTurn({ lastThinkingUpdate: { turnId: TURN, workerGeneration: GENERATION - 1, entries } });
    expect(projectCoreOnlyProgress(stale, TURN)?.entries).toEqual([]);
  });

  it('never shows a goal recorded by an earlier worker generation', () => {
    const current = liveTurn({ lastNativeGatewayGoal: { goal, turnId: TURN, workerGeneration: GENERATION } });
    expect(projectCoreOnlyProgress(current, TURN)?.goal).toEqual(goal);
    const stale = liveTurn({ lastNativeGatewayGoal: { goal, turnId: TURN, workerGeneration: GENERATION - 1 } });
    expect(projectCoreOnlyProgress(stale, TURN)).not.toHaveProperty('goal');
  });

  it('reports a usage limit only for the limit episode it was recorded against', () => {
    const recorded = { turnId: TURN, workerGeneration: GENERATION, kind: 'usage', retryAtMs: limit.retryAtMs, key: usageLimitStateKey(limit) };
    expect(projectCoreOnlyProgress(liveTurn({ usageLimit: limit, nativeGatewayLimit: recorded }), TURN)?.limit)
      .toEqual({ kind: 'usage', retryAtMs: limit.retryAtMs, key: usageLimitStateKey(limit) });
    const laterEpisode: CliUsageLimitState = { ...limit, retryAtMs: limit.retryAtMs + 3_600_000, retryLabel: '6pm' };
    expect(projectCoreOnlyProgress(liveTurn({ usageLimit: laterEpisode, nativeGatewayLimit: recorded }), TURN))
      .not.toHaveProperty('limit');
  });
});

describe('remembering a goal for a native gateway', () => {
  it('only happens for an API-only session', () => {
    const apiOnly = liveTurn();
    expect(rememberCoreOnlyGoal(apiOnly, { goal, turnId: TURN }, GENERATION)).toBe(true);
    expect(apiOnly.lastNativeGatewayGoal).toMatchObject({ goal, turnId: TURN, workerGeneration: GENERATION });
    const lark = liveTurn({ initConfig: { apiOnly: false } });
    const larkBefore = structuredClone(lark);
    expect(rememberCoreOnlyGoal(lark, { goal, turnId: TURN }, GENERATION)).toBe(false);
    expect(lark).toEqual(larkBefore);
  });
});

describe('remembering a usage limit for a native gateway', () => {
  it('only happens for an API-only session, and is what its progress then reports', () => {
    const message = { structuredNativeGatewayLimit: true, usageLimit: limit, dispatchAttempt: undefined };
    const apiOnly = liveTurn({ usageLimit: limit });
    expect(rememberCoreOnlyLimit(apiOnly, message, TURN, GENERATION)).toBe(true);
    expect(projectCoreOnlyProgress(apiOnly, TURN)?.limit)
      .toEqual({ kind: 'usage', retryAtMs: limit.retryAtMs, key: usageLimitStateKey(limit) });
    const lark = liveTurn({ usageLimit: limit, initConfig: { apiOnly: false } });
    const larkBefore = structuredClone(lark);
    expect(rememberCoreOnlyLimit(lark, message, TURN, GENERATION)).toBe(false);
    expect(lark).toEqual(larkBefore);
  });

  it('ignores a limit scraped from the terminal screen, which could falsely trigger quota fallback', () => {
    const screenScraped = { type: 'screen_update', status: 'limited', usageLimit: limit, dispatchAttempt: undefined };
    const scraped = liveTurn({ usageLimit: limit });
    expect(rememberCoreOnlyLimit(scraped, screenScraped, TURN, GENERATION)).toBe(false);
    expect(projectCoreOnlyProgress(scraped, TURN)).not.toHaveProperty('limit');

    const fromTranscript = { ...screenScraped, structuredNativeGatewayLimit: true };
    const structured = liveTurn({ usageLimit: limit });
    expect(rememberCoreOnlyLimit(structured, fromTranscript, TURN, GENERATION)).toBe(true);
    expect(projectCoreOnlyProgress(structured, TURN)?.limit)
      .toEqual({ kind: 'usage', retryAtMs: limit.retryAtMs, key: usageLimitStateKey(limit) });
  });
});

describe('owner reminder states for a native gateway', () => {
  function session(overrides: Record<string, unknown> = {}, status = 'active'): DaemonSession {
    return {
      workerGeneration: GENERATION, latestAsyncTriggerId: TURN, worker: { killed: false }, lastScreenStatus: 'idle',
      lastMessageAt: 0, session: { sessionId: 'session', status },
      ...overrides,
    } as unknown as DaemonSession;
  }

  it('are reported only for an active session', () => {
    expect(projectCoreOnlyReminderState(session(), TURN)?.states).toEqual(['idle']);
    expect(projectCoreOnlyReminderState(session({}, 'closed'), TURN)).toMatchObject({ active: false, states: [] });
  });

  it('leave out a terminal choice prompt, which only the terminal can answer', () => {
    expect(projectCoreOnlyReminderState(session({ tuiPromptCardId: 'om_card' }), TURN)?.states).toEqual(['idle']);
  });
});
