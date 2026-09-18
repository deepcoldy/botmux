import { describe, expect, it } from 'vitest';
import { ActiveTurnAuthority, sameTrustedPrincipal } from '../src/core/active-turn-authority.js';

const humanA = {
  requestUserOpenId: 'ou_a',
  requestUserUnionId: 'on_a',
  requestLarkAppId: 'cli_app',
  senderType: 'user' as const,
};

describe('ActiveTurnAuthority', () => {
  it('normalizes an omitted interactive source', () => {
    expect(sameTrustedPrincipal(
      humanA,
      { ...humanA, source: 'interactive' },
    )).toBe(true);
  });

  it('keeps the complete caller + turn tuple immutable across later reservations', () => {
    const authority = new ActiveTurnAuthority();
    expect(authority.reserve({ turnId: 'turn-a', caller: humanA }, 100)).toBe(true);

    expect(authority.reserve({
      turnId: 'turn-b',
      caller: { ...humanA, requestUserOpenId: 'ou_b', requestUserUnionId: 'on_b' },
    }, 200)).toBe(false);

    expect(authority.identity()).toEqual({ turnId: 'turn-a', caller: humanA });
    expect(authority.snapshot()).toMatchObject({ turnId: 'turn-a', started: false, reservedAtMs: 100 });
  });

  it('accepts a same-principal steer and rotates only when it starts', () => {
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'turn-a', caller: humanA });

    expect(authority.blocks({ turnId: 'turn-b', caller: humanA })).toBe(false);
    expect(authority.reserve({ turnId: 'turn-b', caller: humanA })).toBe(true);
    expect(authority.identity().turnId).toBe('turn-a');
    expect(authority.markStarted({ turnId: 'turn-b', caller: humanA })).toBe(true);
    expect(authority.identity().turnId).toBe('turn-b');
    expect(authority.blocks({ turnId: 'turn-a', caller: humanA })).toBe(false);
  });

  it('blocks a different principal until the active turn releases', () => {
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'turn-a', caller: humanA });
    const humanB = {
      ...humanA,
      requestUserOpenId: 'ou_b',
      requestUserUnionId: 'on_b',
    };

    expect(authority.blocks({ turnId: 'turn-b', caller: humanB })).toBe(true);
    expect(authority.reserve({ turnId: 'turn-b', caller: humanB })).toBe(false);
    expect(authority.markStarted({ turnId: 'turn-b', caller: humanB })).toBe(false);
    expect(authority.identity()).toEqual({ turnId: 'turn-a', caller: humanA });
  });

  it('lets the stable task controller regain control from a bot-started turn', () => {
    const authority = new ActiveTurnAuthority();
    const reviewerBot = {
      requestUserOpenId: 'ou_reviewer_bot',
      requestUserUnionId: 'on_reviewer_bot',
      requestLarkAppId: 'cli_app',
      senderType: 'bot' as const,
    };
    authority.reserve({ turnId: 'review-turn', caller: reviewerBot, controller: humanA });
    authority.markStarted({ turnId: 'review-turn', caller: reviewerBot, controller: humanA });

    expect(authority.blocks({ turnId: 'owner-follow-up', caller: humanA, controller: humanA })).toBe(false);
    expect(authority.markStarted({ turnId: 'owner-follow-up', caller: humanA, controller: humanA })).toBe(true);
    expect(authority.identity()).toEqual({
      turnId: 'owner-follow-up',
      caller: humanA,
      controller: humanA,
    });
  });

  it('does not let an unrelated principal borrow controller authority', () => {
    const authority = new ActiveTurnAuthority();
    const reviewerBot = {
      requestUserOpenId: 'ou_reviewer_bot',
      requestUserUnionId: 'on_reviewer_bot',
      requestLarkAppId: 'cli_app',
      senderType: 'bot' as const,
    };
    const humanB = {
      ...humanA,
      requestUserOpenId: 'ou_b',
      requestUserUnionId: 'on_b',
    };
    authority.reserve({ turnId: 'review-turn', caller: reviewerBot, controller: humanA });

    expect(authority.blocks({ turnId: 'other-follow-up', caller: humanB, controller: humanA })).toBe(true);
    expect(authority.reserve({ turnId: 'other-follow-up', caller: humanB, controller: humanA })).toBe(false);
  });

  it('does not let another task owner use their own controller identity to steer the active turn', () => {
    const authority = new ActiveTurnAuthority();
    const humanB = {
      ...humanA,
      requestUserOpenId: 'ou_b',
      requestUserUnionId: 'on_b',
    };
    authority.reserve({ turnId: 'owner-a-turn', caller: humanA, controller: humanA });
    authority.markStarted({ turnId: 'owner-a-turn', caller: humanA, controller: humanA });

    expect(authority.blocks({
      turnId: 'owner-b-message',
      caller: humanB,
      controller: humanB,
    })).toBe(true);
  });

  it('keeps legacy caller-less transports serial without treating them as cross-principal', () => {
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'legacy-a' });
    expect(authority.blocks({ turnId: 'legacy-b' })).toBe(false);
    expect(authority.markStarted({ turnId: 'legacy-b' })).toBe(true);
    expect(authority.identity()).toEqual({ turnId: 'legacy-b' });
  });

  it('rejects a one-sided caller downgrade', () => {
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'human-a', caller: humanA });
    expect(authority.blocks({ turnId: 'unknown-b' })).toBe(true);
  });

  it('lets raw control inherit an active authenticated authority', () => {
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'human-a', caller: humanA });
    authority.markStarted({ turnId: 'human-a', caller: humanA });

    expect(authority.inheritOrStartControl('raw-command')).toBe(true);
    expect(authority.identity()).toEqual({ turnId: 'human-a', caller: humanA });
  });

  it('lets raw control start a caller-less authority when idle', () => {
    const authority = new ActiveTurnAuthority();

    expect(authority.inheritOrStartControl('raw-command', 123)).toBe(true);
    expect(authority.snapshot()).toMatchObject({
      turnId: 'raw-command',
      started: true,
      reservedAtMs: 123,
    });
  });

  it('lets the stable owner resume after an idle raw turn without opening the lane to others', () => {
    const authority = new ActiveTurnAuthority();
    const humanB = {
      ...humanA,
      requestUserOpenId: 'ou_b',
      requestUserUnionId: 'on_b',
    };

    expect(authority.inheritOrStartControl('raw-compact', 123, humanA)).toBe(true);
    expect(authority.blocks({ turnId: 'owner-next', caller: humanA, controller: humanA })).toBe(false);
    expect(authority.blocks({ turnId: 'other-next', caller: humanB, controller: humanA })).toBe(true);
  });

  it('requires the exact dispatch attempt to release durable authority', () => {
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'delivery', dispatchAttempt: 2, caller: humanA });
    authority.markStarted({ turnId: 'delivery', dispatchAttempt: 2, caller: humanA });

    expect(authority.releaseExact({ turnId: 'delivery', dispatchAttempt: 1 })).toBeUndefined();
    expect(authority.identity()).toMatchObject({ turnId: 'delivery', dispatchAttempt: 2 });
    expect(authority.releaseExact({ turnId: 'delivery', dispatchAttempt: 2 })).toMatchObject({ started: true });
    expect(authority.identity()).toEqual({});
  });

  it('copies caller data so downstream mutation cannot tear the frozen tuple', () => {
    const authority = new ActiveTurnAuthority();
    const caller = { ...humanA };
    authority.reserve({ turnId: 'turn-a', caller });
    caller.requestUserUnionId = 'on_mutated';

    expect(authority.identity().caller?.requestUserUnionId).toBe('on_a');
  });

  it('returns to empty after every terminal across consecutive authenticated turns', () => {
    const authority = new ActiveTurnAuthority();
    for (let index = 0; index < 25; index++) {
      const identity = { turnId: `turn-${index}`, caller: humanA };
      expect(authority.reserve(identity)).toBe(true);
      expect(authority.markStarted(identity)).toBe(true);
      expect(authority.releaseExact(identity)).toMatchObject({
        turnId: identity.turnId,
        started: true,
      });
      expect(authority.snapshot()).toBeUndefined();
      expect(authority.identity()).toEqual({});
    }
  });
});
