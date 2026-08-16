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
import {
  beginReplyTargetTurn,
  buildTurnParticipantsFrom,
  collectTurnWindowParticipants,
  fallbackTurnId,
  frozenReplyContextForTurn,
  isSubstituteTurn,
  pickTurnReplyTarget,
  resolveInboundReplyTarget,
  resolveSessionReplyTarget,
} from '../src/core/reply-target.js';
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

describe('resolveInboundReplyTarget', () => {
  it('anchors a chat-scope thread reply to the inbound reply root', () => {
    expect(resolveInboundReplyTarget({
      scope: 'chat',
      chatId: 'oc_chat',
      threadRootId: 'om_session_root',
      replyRootId: 'om_reply_root',
    })).toEqual({ mode: 'thread', rootMessageId: 'om_reply_root' });
  });

  it('keeps a chat-scope message without a reply root at chat top level', () => {
    expect(resolveInboundReplyTarget({
      scope: 'chat',
      chatId: 'oc_chat',
      threadRootId: 'om_session_root',
    })).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });

  it('anchors a thread-scope message to the session thread root', () => {
    expect(resolveInboundReplyTarget({
      scope: 'thread',
      chatId: 'oc_chat',
      threadRootId: 'om_session_root',
      replyRootId: 'om_child_reply_root',
    })).toEqual({ mode: 'thread', rootMessageId: 'om_session_root' });
  });

  it('uses ordinary quote semantics for a quote-only chat-scope reply', () => {
    expect(resolveInboundReplyTarget({
      scope: 'chat',
      chatId: 'oc_chat',
      threadRootId: 'om_session_root',
      replyRootId: 'om_quote_root',
      quoteOnly: true,
    })).toEqual({ mode: 'quote', rootMessageId: 'om_quote_root' });
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

  it('pickTurnReplyTarget prefers the exact per-turn entry and never borrows a mismatched slot', () => {
    const ds = makeDs() as DaemonSession;
    beginBoth(ds, 'a');
    expect(pickTurnReplyTarget(ds.session, 'turn-a')).toMatchObject({ rootMessageId: 'om_trigger_a', turnId: 'turn-a', quoteOnly: false, substitute: true });
    expect(pickTurnReplyTarget({ currentReplyTarget: ds.session.currentReplyTarget }, 'turn-x')).toBeUndefined();
  });

  it('binds thread-scope senders per turn even though routing needs no per-turn root', () => {
    const ds = makeDs({ scope: 'thread' }) as DaemonSession;
    ds.session.rootMessageId = 'om_thread_root';
    beginReplyTargetTurn(ds, undefined, 'turn-a', NOW, { senderOpenId: 'ou_bot_a' });
    beginReplyTargetTurn(ds, undefined, 'turn-b', NOW, { senderOpenId: 'ou_human_b' });

    expect(pickTurnReplyTarget(ds.session, 'turn-a')).toMatchObject({ turnId: 'turn-a', senderOpenId: 'ou_bot_a' });
    expect(pickTurnReplyTarget(ds.session, 'turn-b')).toMatchObject({ turnId: 'turn-b', senderOpenId: 'ou_human_b' });
    expect(resolveSessionReplyTarget(ds, 'turn-a')).toEqual({ mode: 'thread', rootMessageId: 'om_thread_root' });
  });

  it('a thread-scope substitute turn keeps its card (substitute flag NOT persisted, sender still bound)', () => {
    // Topic-group substitute sessions (#475) are thread-scope and MUST keep
    // their normal streaming card + owner-addressed footer. The per-turn record
    // still needs the sender for --mention-back, but must NOT carry the
    // chat-scope-only substitute/quoteOnly flags — otherwise isSubstituteTurn
    // (card suppression) and the cli.ts footer isSubstitute both flip to true
    // and the topic-group substitute turn loses its card / gets re-addressed.
    const ds = makeDs({ scope: 'thread' }) as DaemonSession;
    ds.session.rootMessageId = 'om_thread_root';
    beginReplyTargetTurn(ds, 'om_thread_root', 'turn-sub', NOW, { substitute: true, quoteOnly: true, senderOpenId: 'ou_bot_a' });

    const entry = ds.session.replyTargets?.['turn-sub'];
    expect(entry?.senderOpenId).toBe('ou_bot_a');       // sender bound for --mention-back
    expect(entry?.substitute).toBeUndefined();          // chat-scope-only flag not persisted
    expect(entry?.quoteOnly).toBeUndefined();
    expect(entry?.rootMessageId).toBeUndefined();        // thread routes off session.rootMessageId, no per-turn root
    // Card-suppression read-point: never card-off in thread scope.
    expect(isSubstituteTurn(ds, 'turn-sub')).toBe(false);
    // Footer read-point (cli.ts:7897 reads pickTurnReplyTarget().substitute):
    // stays falsy so footer addressing is unchanged.
    expect(pickTurnReplyTarget(ds.session, 'turn-sub')?.substitute).toBeUndefined();
    // Thread routing still resolves off the session root, unaffected.
    expect(resolveSessionReplyTarget(ds, 'turn-sub')).toEqual({ mode: 'thread', rootMessageId: 'om_thread_root' });
  });

  it('isSubstituteTurn is scope-gated: a non-chat scope is never a substitute turn (defense-in-depth)', () => {
    // Even if a stray entry somehow carried substitute:true in a thread-scope
    // session (e.g. a future writer bug), isSubstituteTurn fails safe to false
    // so a thread-scope session is never wrongly card-off.
    const ds = makeDs({ scope: 'thread' }) as DaemonSession;
    ds.session.replyTargets = { 'turn-x': { updatedAt: NOW, substitute: true } };
    expect(isSubstituteTurn(ds, 'turn-x')).toBe(false);
  });

  it('binds per-turn participants (chat + thread) and dedupes/keeps richest label', () => {
    const ds = makeDs() as DaemonSession;
    beginReplyTargetTurn(ds, 'om_a', 'turn-1', NOW, {
      senderOpenId: 'ou_bot',
      participants: [{ openId: 'ou_bot', isBot: true }, { openId: 'ou_bot', name: 'Codex' }],
    });
    expect(pickTurnReplyTarget(ds.session, 'turn-1')?.participants)
      .toEqual([{ openId: 'ou_bot', name: 'Codex', isBot: true }]); // merged: name + isBot

    // thread scope also carries participants (bot→bot handoff happens in threads)
    const td = makeDs({ scope: 'thread' }) as DaemonSession;
    td.session.rootMessageId = 'om_root';
    beginReplyTargetTurn(td, undefined, 'turn-t', NOW, { senderOpenId: 'ou_bot', participants: [{ openId: 'ou_bot', isBot: true }] });
    expect(pickTurnReplyTarget(td.session, 'turn-t')?.participants).toEqual([{ openId: 'ou_bot', isBot: true }]);
  });

  it('collectTurnWindowParticipants unions sibling turns within the window (type-ahead), deduped', () => {
    const ds = makeDs() as DaemonSession;
    // Two messages folded into one model turn (type-ahead) land as sibling
    // records with close timestamps; the model resolves BOTMUX_TURN_ID to the
    // later one, but the window must surface BOTH counterparts.
    beginReplyTargetTurn(ds, 'om_1', 'turn-1', NOW, { senderOpenId: 'ou_zhang', participants: [{ openId: 'ou_zhang', name: '张三' }] });
    const soon = new Date(Date.parse(NOW) + 3000).toISOString();
    beginReplyTargetTurn(ds, 'om_2', 'turn-2', soon, { senderOpenId: 'ou_li', participants: [{ openId: 'ou_li', name: '李四' }] });

    const w = collectTurnWindowParticipants(ds.session, 'turn-2');
    expect(w.participants.map(p => p.openId).sort()).toEqual(['ou_li', 'ou_zhang']);
    expect(w.incomplete).toBe(false);
  });

  it('collectTurnWindowParticipants excludes records outside the time window', () => {
    const ds = makeDs() as DaemonSession;
    beginReplyTargetTurn(ds, 'om_old', 'turn-old', NOW, { senderOpenId: 'ou_old', participants: [{ openId: 'ou_old' }] });
    const wayLater = new Date(Date.parse(NOW) + 10 * 60_000).toISOString(); // 10 min later
    beginReplyTargetTurn(ds, 'om_new', 'turn-new', wayLater, { senderOpenId: 'ou_new', participants: [{ openId: 'ou_new' }] });

    const w = collectTurnWindowParticipants(ds.session, 'turn-new');
    expect(w.participants.map(p => p.openId)).toEqual(['ou_new']); // old turn is out of window
  });

  it('collectTurnWindowParticipants → incomplete when no anchor record (old session / evicted turn)', () => {
    const ds = makeDs() as DaemonSession;
    beginReplyTargetTurn(ds, 'om_1', 'turn-1', NOW, { senderOpenId: 'ou_a', participants: [{ openId: 'ou_a' }] });
    const w = collectTurnWindowParticipants(ds.session, 'turn-unknown');
    expect(w).toEqual({ participants: [], incomplete: true });
  });

  it('collectTurnWindowParticipants → incomplete when a window entry self-marks incomplete (unresolved @)', () => {
    const ds = makeDs() as DaemonSession;
    // human sender + an unresolved app_id-form @: participants has only the human,
    // but the entry is flagged incomplete.
    beginReplyTargetTurn(ds, 'om_1', 'turn-1', NOW, { senderOpenId: 'ou_human', participants: [{ openId: 'ou_human' }], participantsIncomplete: true });
    const w = collectTurnWindowParticipants(ds.session, 'turn-1');
    expect(w.participants.map(p => p.openId)).toEqual(['ou_human']);
    expect(w.incomplete).toBe(true);
  });

  it('collectTurnWindowParticipants → incomplete when the prune watermark reaches into the window', () => {
    const ds = makeDs() as DaemonSession;
    beginReplyTargetTurn(ds, 'om_anchor', 'turn-anchor', NOW, { senderOpenId: 'ou_b', participants: [{ openId: 'ou_b' }] });
    // Simulate a sibling within the window having been pruned (watermark inside window).
    ds.session.replyTargetsPrunedThrough = new Date(Date.parse(NOW) - 1000).toISOString();
    const w = collectTurnWindowParticipants(ds.session, 'turn-anchor');
    expect(w.incomplete).toBe(true);
  });

  it('prune watermark OUTSIDE the window does not mark complete window incomplete', () => {
    const ds = makeDs() as DaemonSession;
    beginReplyTargetTurn(ds, 'om_anchor', 'turn-anchor', NOW, { senderOpenId: 'ou_b', participants: [{ openId: 'ou_b' }] });
    ds.session.replyTargetsPrunedThrough = new Date(Date.parse(NOW) - 10 * 60_000).toISOString(); // long before window
    const w = collectTurnWindowParticipants(ds.session, 'turn-anchor');
    expect(w.incomplete).toBe(false);
  });

  it('pruneReplyTargets bounds the map and raises the watermark to the newest evicted entry', () => {
    const ds = makeDs() as DaemonSession;
    for (let i = 0; i < 40; i++) {
      beginReplyTargetTurn(ds, `om_${i}`, `turn-${i}`, new Date(Date.parse(NOW) + i * 1000).toISOString(), { senderOpenId: `ou_${i}`, participants: [{ openId: `ou_${i}` }] });
    }
    const keys = Object.keys(ds.session.replyTargets ?? {});
    expect(keys.length).toBe(32);
    expect(keys).not.toContain('turn-0');       // oldest evicted
    // Watermark = newest evicted entry (turn-7 = index 7, since 40-32=8 evicted: 0..7).
    expect(ds.session.replyTargetsPrunedThrough).toBe(new Date(Date.parse(NOW) + 7 * 1000).toISOString());
  });

  it('keeps rootless chat sender A separate from topic sender/root B', () => {
    const ds = makeDs() as DaemonSession;
    beginReplyTargetTurn(ds, undefined, 'turn-a', NOW, { senderOpenId: 'ou_a' });
    beginReplyTargetTurn(ds, 'om_b', 'turn-b', NOW, { senderOpenId: 'ou_b', substitute: true });

    expect(pickTurnReplyTarget(ds.session, 'turn-a')).toMatchObject({ turnId: 'turn-a', senderOpenId: 'ou_a' });
    expect(pickTurnReplyTarget(ds.session, 'turn-a')?.rootMessageId).toBeUndefined();
    expect(pickTurnReplyTarget(ds.session, 'turn-b')).toMatchObject({ turnId: 'turn-b', rootMessageId: 'om_b', senderOpenId: 'ou_b' });
    expect(resolveSessionReplyTarget(ds, 'turn-a')).toEqual({ mode: 'plain', chatId: 'oc_chat' });
  });

  it('legacy slots are accepted only when their turnId matches exactly', () => {
    const exact = {
      currentReplyTarget: { rootMessageId: 'om_a', turnId: 'turn-a', updatedAt: NOW },
      quoteTargetId: 'turn-a',
      quoteTargetSenderOpenId: 'ou_a',
    };
    expect(pickTurnReplyTarget(exact, 'turn-a')).toMatchObject({
      turnId: 'turn-a', rootMessageId: 'om_a', senderOpenId: 'ou_a',
    });

    const mismatched = {
      currentReplyTarget: { rootMessageId: 'om_a', turnId: 'turn-a', updatedAt: NOW },
      quoteTargetId: 'turn-b',
      quoteTargetSenderOpenId: 'ou_b',
    };
    expect(pickTurnReplyTarget(mismatched, 'turn-a')).toMatchObject({ turnId: 'turn-a', rootMessageId: 'om_a' });
    expect(pickTurnReplyTarget(mismatched, 'turn-a')?.senderOpenId).toBeUndefined();
    expect(pickTurnReplyTarget(mismatched, 'turn-b')).toMatchObject({ turnId: 'turn-b', senderOpenId: 'ou_b' });
    expect(pickTurnReplyTarget(mismatched, 'turn-b')?.rootMessageId).toBeUndefined();
  });

  it('a rootless normal turn is NOT judged substitute after a substitute turn overwrites the slot (codex delta repro)', () => {
    // Real sequence for 普通群 replyMode=chat: a top-level normal @bot turn has
    // no replyRootId (begin clears the routing slot but retains per-turn
    // sender/flags); then a substitute trigger B begins. Turn A must not
    // inherit B's flag via the slot fallback.
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

  it('bounds the map and an evicted in-flight turn cannot borrow the latest sender', () => {
    const ds = makeDs() as DaemonSession;
    for (let i = 0; i < 40; i++) {
      beginReplyTargetTurn(ds, `om_${i}`, `turn-${i}`, new Date(Date.parse(NOW) + i * 1000).toISOString(), { senderOpenId: `ou_${i}` });
    }
    const keys = Object.keys(ds.session.replyTargets ?? {});
    expect(keys.length).toBe(32);
    expect(keys).not.toContain('turn-0'); // oldest pruned
    expect(keys).toContain('turn-39');
    // Evicted turn: map miss + slot mismatch → plain (pre-map behavior).
    expect(resolveSessionReplyTarget(ds, 'turn-0')).toEqual({ mode: 'plain', chatId: 'oc_chat' });
    expect(pickTurnReplyTarget(ds.session, 'turn-0')).toBeUndefined();
    expect(pickTurnReplyTarget(ds.session, 'turn-39')?.senderOpenId).toBe('ou_39');
  });
});

describe('buildTurnParticipantsFrom (pure per-message contribution)', () => {
  const noPeer = () => false;

  it('sender only (no mentions) → single candidate, complete', () => {
    const r = buildTurnParticipantsFrom({ openId: 'ou_a', isBot: false, name: '张三' }, undefined, 'ou_self', noPeer);
    expect(r).toEqual({ participants: [{ openId: 'ou_a', name: '张三', isBot: false }], incomplete: false });
  });

  it('excludes the answering bot itself as sender AND as a mention', () => {
    const r = buildTurnParticipantsFrom(
      { openId: 'ou_self', isBot: true },
      [{ key: '@_1', name: 'me', openId: 'ou_self' }, { key: '@_2', name: '张三', openId: 'ou_a' }],
      'ou_self',
      noPeer,
    );
    expect(r.participants.map(p => p.openId)).toEqual(['ou_a']); // self dropped both times
    expect(r.incomplete).toBe(false);
  });

  it('app_id/user_id/union_id-form @ (openId undefined) → NOT a candidate but marks incomplete', () => {
    // The reported blocking: human sender + @OtherBot in app_id form. Parser
    // leaves openId undefined; we must not under-count it as a lone human.
    const r = buildTurnParticipantsFrom(
      { openId: 'ou_human', isBot: false, name: '张三' },
      [{ key: '@_1', name: 'OtherBot', idType: 'app_id' }], // no openId
      'ou_self',
      noPeer,
    );
    expect(r.participants.map(p => p.openId)).toEqual(['ou_human']); // only the resolvable one
    expect(r.incomplete).toBe(true);                                // window under-counted
  });

  it('three-state is-bot: known peer → bot; unknown mention → undefined (NOT human)', () => {
    const r = buildTurnParticipantsFrom(
      { openId: 'ou_human', isBot: false },
      [
        { key: '@_1', name: 'Peer', openId: 'ou_peer' },     // known peer → bot
        { key: '@_2', name: 'Third', openId: 'ou_third' },   // not a known peer → unknown
      ],
      'ou_self',
      (id) => id === 'ou_peer',
    );
    const byId = Object.fromEntries(r.participants.map(p => [p.openId, p.isBot]));
    expect(byId.ou_human).toBe(false);      // human sender: explicitly false
    expect(byId.ou_peer).toBe(true);        // known peer bot
    expect(byId.ou_third).toBeUndefined();  // unknown — NOT labelled human
  });

  it('excludes a self @ that arrives in app_id form (plain 1v1 stays complete, NOT incomplete)', () => {
    // isBotMentioned recognises the answering bot via app_id; a normal
    // "@currentBot help me" whose self-mention is app_id-form must not be
    // mis-counted as an unresolved counterpart and wrongly block --mention-back.
    const r = buildTurnParticipantsFrom(
      { openId: 'ou_human', isBot: false, name: '张三' },
      [{ key: '@_1', name: 'Me', appId: 'cli_self', idType: 'app_id' }], // self @ in app_id form
      'ou_self',
      noPeer,
      'cli_self', // selfAppId
    );
    expect(r.participants.map(p => p.openId)).toEqual(['ou_human']);
    expect(r.incomplete).toBe(false); // self app_id @ excluded, not treated as unresolved
  });

  it('an app_id @ of ANOTHER bot (not self) still marks incomplete', () => {
    const r = buildTurnParticipantsFrom(
      { openId: 'ou_human', isBot: false },
      [{ key: '@_1', name: 'OtherBot', appId: 'cli_other', idType: 'app_id' }],
      'ou_self',
      noPeer,
      'cli_self',
    );
    expect(r.participants.map(p => p.openId)).toEqual(['ou_human']);
    expect(r.incomplete).toBe(true); // other-bot app_id @ is a real unaccountable counterpart
  });

  it('a real inbound message with NO resolvable sender open_id → incomplete', () => {
    // e.g. an app_id-only bot sender routed via realtime/message-listener: the
    // sender is a genuine counterpart we cannot list, so fail toward explicit.
    const r = buildTurnParticipantsFrom({ openId: undefined }, undefined, 'ou_self', noPeer);
    expect(r.participants).toEqual([]);
    expect(r.incomplete).toBe(true);
  });

  it('structured @all ({open_id:"all"}) is NOT an executable candidate → incomplete', () => {
    // `all` reaches the parser as a structured mention with open_id "all"; it must
    // never be listed (would suggest an illegal `--mention all`) and must fail safe.
    const r = buildTurnParticipantsFrom(
      { openId: 'ou_human', isBot: false },
      [{ key: '@_1', name: '所有人', openId: 'all' }],
      'ou_self',
      noPeer,
    );
    expect(r.participants.map(p => p.openId)).toEqual(['ou_human']); // 'all' not a candidate
    expect(r.incomplete).toBe(true);
  });

  it('a non-ou_ pseudo sender open_id is treated as unaccountable → incomplete, not a candidate', () => {
    const r = buildTurnParticipantsFrom({ openId: 'all' }, undefined, 'ou_self', noPeer);
    expect(r.participants).toEqual([]);
    expect(r.incomplete).toBe(true);
  });
});

describe('collectTurnWindowParticipants — legacy pre-participants anchor', () => {
  it('anchor has senderOpenId but no participants field (upgrade in-flight) → synthesize sender candidate + incomplete', () => {
    // Old-schema record: knows its sender, never recorded mentions. Must surface
    // the sender as a candidate AND mark incomplete (a hidden @ may exist), NOT
    // return a "complete empty" window that would allow --mention-back.
    const now = '2026-08-06T00:00:00.000Z';
    const s = {
      replyTargets: { 'turn-legacy': { updatedAt: now, senderOpenId: 'ou_legacy' } } as any,
    };
    const w = collectTurnWindowParticipants(s, 'turn-legacy');
    expect(w.participants.map(p => p.openId)).toEqual(['ou_legacy']); // sender surfaced
    expect(w.incomplete).toBe(true);                                   // but window not proven complete
  });
});

describe('frozen reply context', () => {
  it('keeps turn A root, quote, and sender after mutable state advances to B', () => {
    const ds = makeDs() as DaemonSession;
    ds.session.quoteTargetId = 'om_a';
    ds.session.quoteTargetSenderOpenId = 'ou_a';
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, 'om_root_a', 'om_a', NOW);

    ds.session.quoteTargetId = 'om_b';
    ds.session.quoteTargetSenderOpenId = 'ou_b';
    ds.session.quoteTargetSenderIsBot = true;
    beginReplyTargetTurn(ds, 'om_root_b', 'om_b', NOW);

    expect(frozenReplyContextForTurn(ds, 'om_a')).toEqual({
      target: { mode: 'thread', rootMessageId: 'om_root_a' },
      quoteTargetId: 'om_a',
      replyTargetSenderOpenId: 'ou_a',
      replyTargetSenderIsBot: false,
    });
    expect(frozenReplyContextForTurn(ds, 'om_b')).toEqual({
      target: { mode: 'thread', rootMessageId: 'om_root_b' },
      quoteTargetId: 'om_b',
      replyTargetSenderOpenId: 'ou_b',
      replyTargetSenderIsBot: true,
    });
  });
});
