import { afterEach, describe, expect, it } from 'vitest';
import {
  __testOnly_resetSessionSelfCloseReceipts,
  authorizeSessionSelfClose,
  deriveSessionSelfCloseCapability,
  recordCommittedSessionSelfClose,
} from '../src/core/session-self-close.js';
import type { DaemonSession } from '../src/core/types.js';

const ORIGIN_CAPABILITY = 'ab'.repeat(32);
const SELF_CLOSE_CAPABILITY = deriveSessionSelfCloseCapability(ORIGIN_CAPABILITY);
const TURN_ID = 'turn-current';

function session(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: { sessionId: 'session-a' },
    larkAppId: 'app-a',
    chatId: 'chat-a',
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 1,
    lastMessageAt: 1,
    hasHistory: true,
    managedTurnOrigin: {
      capability: ORIGIN_CAPABILITY,
      turnId: TURN_ID,
      dispatchAttempt: 2,
    },
    ...overrides,
  } as DaemonSession;
}

function claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability: SELF_CLOSE_CAPABILITY,
    turnId: TURN_ID,
    dispatchAttempt: 2,
    ...overrides,
  };
}

afterEach(() => {
  __testOnly_resetSessionSelfCloseReceipts();
});

describe('session self-close capability authorization', () => {
  it('domain-separates self-close from the generic rotating origin capability', () => {
    expect(SELF_CLOSE_CAPABILITY).toMatch(/^[a-f0-9]{64}$/);
    expect(SELF_CLOSE_CAPABILITY).not.toBe(ORIGIN_CAPABILITY);
    expect(deriveSessionSelfCloseCapability(ORIGIN_CAPABILITY))
      .toBe(SELF_CLOSE_CAPABILITY);

    expect(authorizeSessionSelfClose(claim(), [session()])).toMatchObject({
      ok: true,
      alreadyClosed: false,
      session: { session: { sessionId: 'session-a' } },
    });
    expect(authorizeSessionSelfClose(
      claim({ capability: ORIGIN_CAPABILITY }),
      [session()],
    )).toEqual({ ok: false, reason: 'origin_unproven' });
  });

  it('rejects missing, malformed, stale, and caller-selected target claims', () => {
    expect(authorizeSessionSelfClose({}, [session()]))
      .toEqual({ ok: false, reason: 'capability_missing' });
    expect(authorizeSessionSelfClose(claim({ capability: 'not-a-token' }), [session()]))
      .toEqual({ ok: false, reason: 'capability_malformed' });
    expect(authorizeSessionSelfClose(claim({ capability: 'cd'.repeat(32) }), [session()]))
      .toEqual({ ok: false, reason: 'origin_unproven' });
    expect(authorizeSessionSelfClose(
      claim({ sessionId: 'session-b' }),
      [session()],
    )).toEqual({ ok: false, reason: 'target_not_allowed' });
  });

  it('binds the proof to the live turn and dispatch attempt', () => {
    expect(authorizeSessionSelfClose(claim({ turnId: 'turn-old' }), [session()]))
      .toEqual({ ok: false, reason: 'turn_mismatch' });
    expect(authorizeSessionSelfClose(claim({ dispatchAttempt: 1 }), [session()]))
      .toEqual({ ok: false, reason: 'dispatch_attempt_mismatch' });
    const withoutAttempt = claim();
    delete withoutAttempt.dispatchAttempt;
    expect(authorizeSessionSelfClose(withoutAttempt, [session()]))
      .toEqual({ ok: false, reason: 'dispatch_attempt_mismatch' });
  });

  it('returns one idempotent receipt for an exact committed duplicate', () => {
    const accepted = authorizeSessionSelfClose(claim(), [session()]);
    expect(accepted.ok && !accepted.alreadyClosed).toBe(true);
    if (!accepted.ok || accepted.alreadyClosed) throw new Error('expected active authorization');
    recordCommittedSessionSelfClose(accepted.claim, 'session-a', 1_000);

    expect(authorizeSessionSelfClose(claim(), [], 1_001)).toMatchObject({
      ok: true,
      alreadyClosed: true,
      sessionId: 'session-a',
    });
    expect(authorizeSessionSelfClose(claim({ turnId: 'turn-replay' }), [], 1_001))
      .toEqual({ ok: false, reason: 'origin_unproven' });
    expect(authorizeSessionSelfClose(claim(), [], 301_001))
      .toEqual({ ok: false, reason: 'origin_unproven' });
  });

  it('fails closed if one action capability ambiguously matches two live sessions', () => {
    const sibling = session({
      session: { sessionId: 'session-b' },
      larkAppId: 'app-b',
    } as Partial<DaemonSession>);
    expect(authorizeSessionSelfClose(claim(), [session(), sibling]))
      .toEqual({ ok: false, reason: 'origin_ambiguous' });
  });
});
