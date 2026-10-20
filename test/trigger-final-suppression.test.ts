import { describe, expect, it } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';

import {
  armTriggerFinalSuppression,
  disarmTriggerFinalSuppression,
  inheritTriggerReplyAnchor,
  inheritActiveTurnFinalSuppression,
  isTriggerFinalSuppressed,
} from '../src/core/trigger-final-suppression.js';
import { resolveSessionReplyTarget } from '../src/core/reply-target.js';
import type { DaemonSession } from '../src/core/types.js';

function session(): DaemonSession {
  return {} as DaemonSession;
}

describe('trigger final-output suppression', () => {
  it('arms and reads back suppression by exact turn id', () => {
    const ds = session();
    armTriggerFinalSuppression(ds, 'trg_1');
    expect(isTriggerFinalSuppressed(ds, 'trg_1')).toBe(true);
    // A different turn on the same session is untouched.
    expect(isTriggerFinalSuppressed(ds, 'trg_other')).toBe(false);
    // No turn id (a plain human turn) is never suppressed.
    expect(isTriggerFinalSuppressed(ds, undefined)).toBe(false);
  });

  it('disarm clears the entry and empties the map', () => {
    const ds = session();
    armTriggerFinalSuppression(ds, 'trg_1');
    disarmTriggerFinalSuppression(ds, 'trg_1');
    expect(isTriggerFinalSuppressed(ds, 'trg_1')).toBe(false);
    expect(ds.suppressedTriggerFinalTurns).toBeUndefined();
  });

  it('expires entries past the 24h TTL and self-prunes the map', () => {
    const ds = session();
    const armedAt = 1_000_000;
    armTriggerFinalSuppression(ds, 'trg_1', armedAt);
    const afterTtl = armedAt + 24 * 60 * 60 * 1000 + 1;
    expect(isTriggerFinalSuppressed(ds, 'trg_1', afterTtl)).toBe(false);
    expect(ds.suppressedTriggerFinalTurns).toBeUndefined();
  });

  it('bounds the map at 256 entries — best-effort, evicting the oldest under a storm', () => {
    const ds = session();
    const now = 2_000_000;
    // Arm 300 distinct turns well within TTL. Each arm prunes down to the cap, so
    // the oldest turns are evicted even though they are not yet TTL-expired.
    for (let i = 0; i < 300; i++) armTriggerFinalSuppression(ds, `trg_${i}`, now + i);
    expect(ds.suppressedTriggerFinalTurns!.size).toBeLessThanOrEqual(256);
    // The earliest turns lost their suppression (final would fire) — the tradeoff
    // is documented as best-effort, not a strong guarantee.
    expect(isTriggerFinalSuppressed(ds, 'trg_0', now + 300)).toBe(false);
    // The most recent turns are still suppressed.
    expect(isTriggerFinalSuppressed(ds, 'trg_299', now + 300)).toBe(true);
  });
});

describe('inheritTriggerReplyAnchor (P2: synthetic turn keeps the fold-back anchor)', () => {
  // A chat-scope session that a human turn already anchored into a shared topic.
  function sharedFoldbackDs(anchor?: { rootMessageId: string; turnId: string; quoteOnly?: boolean; substitute?: boolean }): DaemonSession {
    const a = anchor ?? { rootMessageId: 'om_shared_topic', turnId: 'om_human', updatedAt: 'x' } as any;
    return {
      scope: 'chat',
      chatId: 'oc_chat',
      currentReplyTarget: a,
      session: {
        rootMessageId: 'oc_chat',
        currentReplyTarget: a,
        replyTargets: { om_human: { rootMessageId: 'om_shared_topic', updatedAt: 'x' } },
      },
    } as unknown as DaemonSession;
  }

  it('without inherit, a synthetic trg_ id resolves to plain top-level (the bug it guards)', () => {
    const ds = sharedFoldbackDs();
    expect(resolveSessionReplyTarget(ds, 'trg_x')).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });

  it('after inherit, the synthetic trg_ id threads into the shared fold-back topic', () => {
    const ds = sharedFoldbackDs();
    inheritTriggerReplyAnchor(ds, 'trg_x', 'now');
    expect(resolveSessionReplyTarget(ds, 'trg_x')).toEqual({ mode: 'thread', rootMessageId: 'om_shared_topic' });
    // A normal user turn on the same session is NOT granted an entry.
    expect(ds.session.replyTargets!['trg_other']).toBeUndefined();
  });

  it('preserves a quote-only anchor as quote mode', () => {
    const ds = sharedFoldbackDs({ rootMessageId: 'om_q', turnId: 'om_h', quoteOnly: true } as any);
    inheritTriggerReplyAnchor(ds, 'trg_x', 'now');
    expect(resolveSessionReplyTarget(ds, 'trg_x')).toEqual({ mode: 'quote', rootMessageId: 'om_q' });
  });

  it('routes eviction through the shared prune helper → raises the participant watermark', () => {
    // The second replyTargets writer must update replyTargetsPrunedThrough on
    // eviction, or a synthetic trigger folding in could silently prune a
    // participant-bearing sibling without the --mention-back gate noticing.
    const base = { rootMessageId: 'om_shared', turnId: 'om_h', updatedAt: '2026-01-01T00:00:00.000Z' } as any;
    const replyTargets: Record<string, any> = {};
    for (let i = 0; i < 40; i++) {
      replyTargets[`t${i}`] = { rootMessageId: 'om_shared', updatedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString() };
    }
    const ds = {
      scope: 'chat', chatId: 'oc_chat', currentReplyTarget: base,
      session: { rootMessageId: 'oc_chat', currentReplyTarget: base, replyTargets },
    } as unknown as DaemonSession;
    inheritTriggerReplyAnchor(ds, 'trg_new', new Date(Date.parse('2026-01-01T00:00:00.000Z') + 100_000).toISOString());
    expect(Object.keys(ds.session.replyTargets!).length).toBe(32);
    // Something got evicted → watermark is now set (not undefined).
    expect(ds.session.replyTargetsPrunedThrough).toBeTruthy();
  });

  it('no-op for a flat chat session with no fold-back anchor (behavior unchanged)', () => {
    const ds = { scope: 'chat', chatId: 'oc_chat', session: {} } as unknown as DaemonSession;
    inheritTriggerReplyAnchor(ds, 'trg_x', 'now');
    expect(ds.session.replyTargets).toBeUndefined();
    expect(resolveSessionReplyTarget(ds, 'trg_x')).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });

  it('no-op for a thread-scope session (never consults this map)', () => {
    const ds = { scope: 'thread', chatId: 'oc_chat', session: { rootMessageId: 'om_root' } } as unknown as DaemonSession;
    inheritTriggerReplyAnchor(ds, 'trg_x', 'now');
    expect(ds.session.replyTargets).toBeUndefined();
  });

  it('does not clobber an existing per-turn entry for the same id', () => {
    const ds = sharedFoldbackDs();
    ds.session.replyTargets = { ...ds.session.replyTargets, trg_x: { rootMessageId: 'om_pinned', updatedAt: 'earlier' } };
    inheritTriggerReplyAnchor(ds, 'trg_x', 'now');
    expect(ds.session.replyTargets!['trg_x'].rootMessageId).toBe('om_pinned');
  });
});


describe('internal task interrupted by ordinary IM input', () => {
  it.each(['same-caller', 'cross-caller'] as const)('keeps receipts internal through %s interruptions and restores later chat', mode => {
    const ds = session();
    const authority = new ActiveTurnAuthority((previous, next) => {
      inheritActiveTurnFinalSuppression(ds, previous, next);
    });
    const caller = { requestUserOpenId: 'ou_owner', requestLarkAppId: 'cli_test', senderType: 'user' as const };
    const internal = { turnId: 'trg_background', caller };
    armTriggerFinalSuppression(ds, internal.turnId);
    authority.reserve(internal);
    authority.markStarted(internal);

    for (const turnId of ['om_updated_input', 'om_followup']) {
      const steer = { turnId, caller: mode === 'same-caller' ? caller : { ...caller, requestUserOpenId: 'ou_other' } };
      if (mode === 'cross-caller') authority.adoptEnvelopePreservingPrincipal(steer);
      else authority.reserve(steer);
      authority.markStarted(steer);
      expect(authority.identity().turnId).toBe(turnId);
      expect(isTriggerFinalSuppressed(ds, turnId)).toBe(true);
    }
    authority.releaseExact({ turnId: 'om_followup' });
    // A terminal may precede its trailing bridge final.
    expect(isTriggerFinalSuppressed(ds, 'om_followup')).toBe(true);
    expect(isTriggerFinalSuppressed(ds, internal.turnId)).toBe(true);
    authority.reserve({ turnId: 'om_new_question' });
    authority.markStarted({ turnId: 'om_new_question' });
    expect(isTriggerFinalSuppressed(ds, 'om_new_question')).toBe(false);
  });

  it('retains isolation across consecutive adoptions before submission', () => {
    const ds = session();
    const authority = new ActiveTurnAuthority((previous, next) => inheritActiveTurnFinalSuppression(ds, previous, next));
    armTriggerFinalSuppression(ds, 'trg_task');
    authority.reserve({ turnId: 'trg_task' });
    authority.markStarted({ turnId: 'trg_task' });
    authority.adoptEnvelopePreservingPrincipal({ turnId: 'om_one' });
    authority.adoptEnvelopePreservingPrincipal({ turnId: 'om_two' });
    authority.markStarted({ turnId: 'om_two' });
    expect(isTriggerFinalSuppressed(ds, 'om_two')).toBe(true);
  });

  it('does not pass isolation from unstarted reservations or completed tasks', () => {
    const ds = session();
    const authority = new ActiveTurnAuthority((previous, next) => inheritActiveTurnFinalSuppression(ds, previous, next));
    armTriggerFinalSuppression(ds, 'trg_reserved');
    authority.reserve({ turnId: 'trg_reserved' });
    authority.markStarted({ turnId: 'om_first' });
    expect(isTriggerFinalSuppressed(ds, 'om_first')).toBe(false);
    authority.clear();
    authority.reserve({ turnId: 'om_next' });
    authority.markStarted({ turnId: 'om_next' });
    expect(isTriggerFinalSuppressed(ds, 'om_next')).toBe(false);
  });

  it('does not inherit into an input queued until the active task finishes', () => {
    const ds = session();
    const authority = new ActiveTurnAuthority((previous, next) => inheritActiveTurnFinalSuppression(ds, previous, next));
    armTriggerFinalSuppression(ds, 'trg_task');
    authority.reserve({ turnId: 'trg_task' });
    authority.markStarted({ turnId: 'trg_task' });
    const queued = { turnId: 'om_queued', queueAfterActiveTurn: true as const };
    expect(authority.reserve(queued)).toBe(false);
    expect(authority.markStarted(queued)).toBe(false);
    authority.releaseExact({ turnId: 'trg_task' });
    expect(authority.reserve(queued)).toBe(true);
    expect(authority.markStarted(queued)).toBe(true);
    expect(isTriggerFinalSuppressed(ds, 'om_queued')).toBe(false);
  });

  it('keeps ordinary interrupted chat visible', () => {
    const ds = session();
    const authority = new ActiveTurnAuthority((previous, next) => inheritActiveTurnFinalSuppression(ds, previous, next));
    authority.reserve({ turnId: 'om_chat' });
    authority.markStarted({ turnId: 'om_chat' });
    authority.adoptEnvelopePreservingPrincipal({ turnId: 'om_correction' });
    expect(isTriggerFinalSuppressed(ds, 'om_correction')).toBe(false);
  });
});
