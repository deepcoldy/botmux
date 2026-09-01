import { describe, expect, it } from 'bun:test';

import {
  armTriggerFinalSuppression,
  disarmTriggerFinalSuppression,
  inheritTriggerReplyAnchor,
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
