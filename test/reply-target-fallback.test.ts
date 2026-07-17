/**
 * Unit tests for the shared fold-back turn anchoring helpers:
 * fallbackTurnId + its composition with resolveSessionReplyTarget.
 *
 * Reproduces the dispatch-into-shared-bot leak: a shared (chat-scope) session
 * triggered from inside a Lark thread anchors its USER-FACING replies into the
 * thread (turnId gate matches), but daemon-side messages that carried no
 * turnId — the worker's first streaming card, the /repo "已选择" confirmation —
 * fell through to a plain top-level sendMessage. fallbackTurnId closes that
 * gap for callers that have no turn context of their own, without weakening
 * the stale-turn gate for callers that DO pass an explicit turnId.
 *
 * Run:  pnpm vitest run test/reply-target-fallback.test.ts
 */
import { describe, it, expect } from 'vitest';
import { beginReplyTargetTurn, fallbackTurnId, isSubstituteTurn, pickTurnReplyTarget, resolveSessionReplyTarget } from '../src/core/reply-target.js';
import type { DaemonSession } from '../src/core/types.js';

const NOW = new Date().toISOString();

function makeDs(overrides: Partial<DaemonSession> = {}): Pick<
  DaemonSession,
  'scope' | 'chatId' | 'session' | 'currentReplyTarget'
> & Partial<DaemonSession> {
  return {
    scope: 'chat',
    chatId: 'oc_chat',
    session: {
      sessionId: 'sess-1',
      chatId: 'oc_chat',
      rootMessageId: 'oc_chat',
      title: 't',
      status: 'active',
      createdAt: NOW,
    } as DaemonSession['session'],
    currentReplyTarget: undefined,
    ...overrides,
  };
}

describe('fallbackTurnId', () => {
  it('an explicit turnId always wins over the session anchor', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: NOW },
    });
    expect(fallbackTurnId(ds as DaemonSession, 'turn-2')).toBe('turn-2');
  });

  it('no turn context → falls back to ds.currentReplyTarget.turnId', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: NOW },
    });
    expect(fallbackTurnId(ds as DaemonSession, undefined)).toBe('turn-1');
  });

  it('falls back to the persisted session.currentReplyTarget when the in-memory one is absent (post-restart restore)', () => {
    const ds = makeDs();
    ds.session.currentReplyTarget = { rootMessageId: 'om_topic', turnId: 'turn-9', updatedAt: NOW };
    expect(fallbackTurnId(ds as DaemonSession, undefined)).toBe('turn-9');
  });

  it('no anchor anywhere → undefined (plain chat reply, unchanged behavior)', () => {
    expect(fallbackTurnId(makeDs() as DaemonSession, undefined)).toBeUndefined();
  });
});

describe('fallbackTurnId × resolveSessionReplyTarget (the leak fix)', () => {
  it('daemon-side message with NO turn context anchors into the shared fold-back topic instead of leaking top-level', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: NOW },
    });
    // Pre-fix: resolveSessionReplyTarget(ds, undefined) → plain → top-level leak.
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, undefined));
    expect(target).toEqual({ mode: 'thread', rootMessageId: 'om_topic' });
  });

  it('an explicit STALE turnId is still gated to plain — fallback must not weaken the cross-turn hijack guard', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: NOW },
    });
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, 'turn-2'));
    expect(target).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });

  it('thread-scope sessions are unaffected: always reply into their own thread', () => {
    const ds = makeDs({ scope: 'thread' });
    ds.session.rootMessageId = 'om_root';
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, undefined));
    expect(target).toEqual({ mode: 'thread', rootMessageId: 'om_root' });
  });

  it('plain chat session without any fold-back anchor keeps replying flat to the chat', () => {
    const ds = makeDs();
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, undefined));
    expect(target).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });

  it('quoteOnly currentReplyTarget resolves to quote mode, not thread mode', () => {
    const ds = makeDs({
      currentReplyTarget: { rootMessageId: 'om_trigger', turnId: 'turn-1', updatedAt: NOW, quoteOnly: true },
    });
    const target = resolveSessionReplyTarget(ds, fallbackTurnId(ds as DaemonSession, undefined));
    expect(target).toEqual({ mode: 'quote', rootMessageId: 'om_trigger' });
  });
});

describe('per-turn replyTargets — queued/concurrent turns keep their own anchor', () => {
  // codex 2nd-review P2: currentReplyTarget is a single slot. Trigger A, then
  // trigger B while A is still executing → B overwrites the slot → A's send
  // (turnId mismatch) used to degrade to a top-level plain send. The per-turn
  // map keeps both anchors alive; both arrival orders are covered.
  function beginBoth(ds: DaemonSession, first: 'a' | 'b' = 'a') {
    const order = first === 'a'
      ? [['om_trigger_a', 'turn-a', true], ['om_trigger_b', 'turn-b', false]] as const
      : [['om_trigger_b', 'turn-b', false], ['om_trigger_a', 'turn-a', true]] as const;
    for (const [root, turn, substitute] of order) {
      beginReplyTargetTurn(ds, root, turn, NOW, { quoteOnly: false, substitute });
    }
  }

  it('turn A keeps its thread anchor after turn B overwrites currentReplyTarget', () => {
    const ds = makeDs() as DaemonSession;
    beginBoth(ds, 'a');
    expect(ds.currentReplyTarget?.turnId).toBe('turn-b'); // slot = latest
    expect(resolveSessionReplyTarget(ds, 'turn-a')).toEqual({ mode: 'thread', rootMessageId: 'om_trigger_a' });
    expect(resolveSessionReplyTarget(ds, 'turn-b')).toEqual({ mode: 'thread', rootMessageId: 'om_trigger_b' });
  });

  it('same in the reverse arrival order', () => {
    const ds = makeDs() as DaemonSession;
    beginBoth(ds, 'b');
    expect(ds.currentReplyTarget?.turnId).toBe('turn-a');
    expect(resolveSessionReplyTarget(ds, 'turn-a')).toEqual({ mode: 'thread', rootMessageId: 'om_trigger_a' });
    expect(resolveSessionReplyTarget(ds, 'turn-b')).toEqual({ mode: 'thread', rootMessageId: 'om_trigger_b' });
  });

  it('per-turn quoteOnly survives the overwrite', () => {
    const ds = makeDs() as DaemonSession;
    beginReplyTargetTurn(ds, 'om_quote_turn', 'turn-q', NOW, { quoteOnly: true, substitute: true });
    beginReplyTargetTurn(ds, 'om_thread_turn', 'turn-t', NOW, { quoteOnly: false, substitute: false });
    expect(resolveSessionReplyTarget(ds, 'turn-q')).toEqual({ mode: 'quote', rootMessageId: 'om_quote_turn' });
    expect(resolveSessionReplyTarget(ds, 'turn-t')).toEqual({ mode: 'thread', rootMessageId: 'om_thread_turn' });
  });

  it('pickTurnReplyTarget prefers the exact per-turn entry and falls back to the slot', () => {
    const ds = makeDs() as DaemonSession;
    beginBoth(ds, 'a');
    expect(pickTurnReplyTarget(ds.session, 'turn-a')).toEqual({ rootMessageId: 'om_trigger_a', turnId: 'turn-a', quoteOnly: false, substitute: true });
    // Unknown turn → the (latest) single slot, preserving legacy behavior for
    // sessions persisted before the map existed.
    expect(pickTurnReplyTarget({ currentReplyTarget: ds.session.currentReplyTarget }, 'turn-x')?.turnId).toBe('turn-b');
  });

  it('a rootless normal turn is NOT judged substitute after a substitute turn overwrites the slot (codex delta repro)', () => {
    // Real sequence for 普通群 replyMode=chat: a top-level normal @bot turn has
    // no replyRootId (begin clears the slot, writes NO map entry); then a
    // substitute trigger B begins. Turn A must not inherit B's flag via the
    // slot fallback.
    const ds = makeDs() as DaemonSession;
    beginReplyTargetTurn(ds, undefined, 'turn-normal-a', NOW);
    beginReplyTargetTurn(ds, 'om_trigger_b', 'turn-sub-b', NOW, { quoteOnly: false, substitute: true });

    expect(isSubstituteTurn(ds, 'turn-normal-a')).toBe(false);
    expect(isSubstituteTurn(ds, 'turn-sub-b')).toBe(true);
    // And the rootless turn still routes plain, not under B's anchor.
    expect(resolveSessionReplyTarget(ds, 'turn-normal-a')).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });

  it('reverse order: substitute turn stays card-off after a rootless normal turn clears the slot', () => {
    const ds = makeDs() as DaemonSession;
    beginReplyTargetTurn(ds, 'om_trigger_b', 'turn-sub-b', NOW, { quoteOnly: false, substitute: true });
    beginReplyTargetTurn(ds, undefined, 'turn-normal-a', NOW);

    expect(isSubstituteTurn(ds, 'turn-sub-b')).toBe(true); // map survives the slot clear
    expect(isSubstituteTurn(ds, 'turn-normal-a')).toBe(false);
  });

  it('isSubstituteTurn without turn context keeps the latest-slot fallback', () => {
    const ds = makeDs() as DaemonSession;
    beginReplyTargetTurn(ds, 'om_trigger_b', 'turn-sub-b', NOW, { substitute: true });
    expect(isSubstituteTurn(ds)).toBe(true);
    beginReplyTargetTurn(ds, undefined, 'turn-normal-a', NOW);
    expect(isSubstituteTurn(ds)).toBe(false); // slot cleared by the rootless turn
  });

  it('bounds the map and evicted turns degrade to the legacy single-slot behavior', () => {
    const ds = makeDs() as DaemonSession;
    for (let i = 0; i < 40; i++) {
      beginReplyTargetTurn(ds, `om_${i}`, `turn-${i}`, new Date(Date.parse(NOW) + i * 1000).toISOString());
    }
    const keys = Object.keys(ds.session.replyTargets ?? {});
    expect(keys.length).toBe(32);
    expect(keys).not.toContain('turn-0'); // oldest pruned
    expect(keys).toContain('turn-39');
    // Evicted turn: map miss + slot mismatch → plain (pre-map behavior).
    expect(resolveSessionReplyTarget(ds, 'turn-0')).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });
});
