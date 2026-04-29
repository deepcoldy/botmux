/**
 * Tests for the adopt-bridge attribution state machine.
 *
 * These cover the cases Codex flagged in v3 review:
 *   - back-to-back Lark messages (no idle between) must not lose msg1's
 *     output by being overwritten when msg2 arrives
 *   - assistant uuids produced by a local in-flight turn must NOT bleed
 *     into a freshly-queued Lark turn
 *   - assistant text appearing before any pending turn (history) must NOT
 *     be replayed
 *   - re-ingestion (fs.watch + poll race) must be idempotent
 *   - drainEmittable holds back started turns that have no assistant text
 *     yet (e.g. Claude is still in tool-use mid-turn)
 */
import { describe, it, expect } from 'vitest';
import { BridgeTurnQueue, makeFingerprint } from '../src/services/bridge-turn-queue.js';
import type { TranscriptEvent } from '../src/services/claude-transcript.js';

function user(uuid: string, content: string = `<input ${uuid}>`): TranscriptEvent {
  return { type: 'user', uuid, message: { role: 'user', content } };
}
function assistant(uuid: string, text: string, sidechain = false): TranscriptEvent {
  const ev: TranscriptEvent = {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
  if (sidechain) (ev as any).isSidechain = true;
  return ev;
}
function assistantToolUse(uuid: string): TranscriptEvent {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] as any },
  };
}
function toolResult(uuid: string): TranscriptEvent {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] as any },
  };
}

describe('BridgeTurnQueue', () => {
  it('drops historical assistant events absorbed at attach', () => {
    const q = new BridgeTurnQueue();
    q.absorb([assistant('hist-a', 'old reply')]);
    q.mark('t1');
    // ingest must not re-attribute historical uuids
    q.ingest([assistant('hist-a', 'old reply')]);
    expect(q.peek()[0].started).toBe(false);
    expect(q.peek()[0].assistantUuids).toEqual([]);
  });

  it('attaches one user + assistant to the pending Lark turn', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    q.ingest([user('u1'), assistant('a1', 'reply')]);
    const ready = q.drainEmittable();
    expect(ready.length).toBe(1);
    expect(ready[0].turnId).toBe('t1');
    expect(ready[0].assistantUuids).toEqual(['a1']);
    expect(q.size()).toBe(0);
  });

  it('back-to-back Lark messages without idle: each turn keeps its own uuids', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    // Claude wrote user1 + assistant1 already, but no idle yet
    q.ingest([user('u1'), assistant('a1', 'first reply')]);
    // Second Lark message arrives BEFORE drain
    q.mark('t2');
    // Claude continues: writes user2 then assistant2
    q.ingest([user('u2'), assistant('a2', 'second reply')]);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t1', 't2']);
    expect(ready[0].assistantUuids).toEqual(['a1']);
    expect(ready[1].assistantUuids).toEqual(['a2']);
  });

  it('local-terminal turn before any Lark message: emitted as isLocal turn (not dropped)', () => {
    const q = new BridgeTurnQueue();
    // Local user types in the original pane — no pending turn yet
    q.ingest([user('local-u1'), assistant('local-a1', 'local reply')]);
    // Then a Lark message arrives
    q.mark('t1');
    q.ingest([user('u1'), assistant('a1', 'lark reply')]);
    const ready = q.drainEmittable();
    // Both turns emit, in chronological order — local first, Lark second.
    expect(ready.length).toBe(2);
    expect(ready[0].isLocal).toBe(true);
    expect(ready[0].userUuid).toBe('local-u1');
    expect(ready[0].assistantUuids).toEqual(['local-a1']);
    expect(ready[1].turnId).toBe('t1');
    expect(ready[1].isLocal).toBeFalsy();
    expect(ready[1].assistantUuids).toEqual(['a1']);
  });

  it('local turn between two Lark turns: local emits separately, neither Lark turn is polluted', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    q.ingest([user('u1'), assistant('a1', 'lark1')]);
    // After t1 is started+collected but not yet emitted, local user types
    q.ingest([user('local-u'), assistant('local-a', 'local reply')]);
    // Now Lark sends another
    q.mark('t2');
    q.ingest([user('u2'), assistant('a2', 'lark2')]);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t1', `local-local-u`, 't2']);
    // Lark turn 1 keeps only its own uuid
    expect(ready[0].assistantUuids).toEqual(['a1']);
    expect(ready[0].isLocal).toBeFalsy();
    // Local turn carries its own user/assistant uuids
    expect(ready[1].isLocal).toBe(true);
    expect(ready[1].userUuid).toBe('local-u');
    expect(ready[1].assistantUuids).toEqual(['local-a']);
    // Lark turn 2 keeps only its own uuid — local-a does NOT bleed in
    expect(ready[2].assistantUuids).toEqual(['a2']);
    expect(ready[2].isLocal).toBeFalsy();
  });

  it('idempotent ingest: replaying same events does not double-attribute', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    const events = [user('u1'), assistant('a1', 'reply')];
    q.ingest(events);
    q.ingest(events);  // fs.watch + poll race
    q.ingest(events);
    const ready = q.drainEmittable();
    expect(ready[0].assistantUuids).toEqual(['a1']);
  });

  it('drainEmittable holds back a started turn with no assistant text yet', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    // Claude saw the user message but is still in tool-use phase, no
    // assistant text uuid yet.
    q.ingest([user('u1')]);
    expect(q.drainEmittable()).toEqual([]);
    // text arrives later
    q.ingest([assistant('a1', 'finally')]);
    const ready = q.drainEmittable();
    expect(ready.length).toBe(1);
    expect(ready[0].assistantUuids).toEqual(['a1']);
  });

  it('tool-result user events do not break collection for the current turn', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    q.ingest([
      user('u1', 'please inspect the repo'),
      assistantToolUse('a-tool'),
      toolResult('u-tool-result'),
    ]);
    expect(q.drainEmittable()).toEqual([]);

    q.ingest([assistant('a-final', 'done')]);
    const ready = q.drainEmittable();
    expect(ready).toHaveLength(1);
    expect(ready[0].assistantUuids).toEqual(['a-final']);
  });

  it('drainEmittable holds back an unstarted turn (Claude has not consumed it)', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    expect(q.drainEmittable()).toEqual([]);
    expect(q.size()).toBe(1);
  });

  it('multiple text blocks in one turn: collects all assistant uuids in order', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    q.ingest([
      user('u1'),
      assistant('a1-text', 'thinking...'),
      assistant('a1-tool-result', '(tool result)'),
      assistant('a1-final', 'final answer'),
    ]);
    const ready = q.drainEmittable();
    expect(ready[0].assistantUuids).toEqual(['a1-text', 'a1-tool-result', 'a1-final']);
  });

  it('drops sidechain (sub-agent) assistant events', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    q.ingest([
      user('u1'),
      assistant('sub-1', 'sub-agent chatter', /* sidechain */ true),
      assistant('a1', 'main answer'),
    ]);
    const ready = q.drainEmittable();
    expect(ready[0].assistantUuids).toEqual(['a1']);
  });

  // ── Fingerprint gating (Codex P4) ────────────────────────────────────────

  it('fingerprint match: only the matching user event starts the Lark turn; non-match becomes a local turn', () => {
    const q = new BridgeTurnQueue();
    const fp = makeFingerprint('please review the new patch');
    q.mark('t1', fp);
    // Local user types something else first — synthesised as a local turn
    // ahead of the unstarted Lark turn (chronological order).
    q.ingest([user('local-u', 'ls -la'), assistant('local-a', 'output')]);
    const t1 = q.peek().find(t => t.turnId === 't1');
    expect(t1?.started).toBe(false);  // not consumed by local input
    expect(q.peek().some(t => t.isLocal)).toBe(true);
    // Then the Lark message lands in the transcript
    q.ingest([user('u1', 'please review the new patch — appended hint'), assistant('a1', 'reviewed')]);
    const ready = q.drainEmittable();
    expect(ready.length).toBe(2);
    expect(ready[0].isLocal).toBe(true);
    expect(ready[0].assistantUuids).toEqual(['local-a']);
    expect(ready[1].turnId).toBe('t1');
    expect(ready[1].assistantUuids).toEqual(['a1']);
  });

  it('fingerprint mismatch: local user with different content creates a local turn but does NOT start the Lark turn', () => {
    const q = new BridgeTurnQueue();
    const fp = makeFingerprint('lark-specific question');
    q.mark('t1', fp);
    // Local user types — content does not match fingerprint
    q.ingest([user('local-u', 'something completely different')]);
    const t1 = q.peek().find(t => t.turnId === 't1');
    expect(t1?.started).toBe(false);
    expect(t1?.assistantUuids).toEqual([]);
    // A new local turn was synthesised ahead of t1
    const local = q.peek().find(t => t.isLocal);
    expect(local).toBeTruthy();
    expect(local?.started).toBe(true);
    expect(local?.userUuid).toBe('local-u');
  });

  it('fingerprint absent (legacy mark): any user event still starts the turn', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');  // no fingerprint
    q.ingest([user('u1'), assistant('a1', 'hi')]);
    const ready = q.drainEmittable();
    expect(ready[0].assistantUuids).toEqual(['a1']);
  });

  it('makeFingerprint trims and collapses whitespace', () => {
    expect(makeFingerprint('  hello   world  ')).toBe('hello world');
    expect(makeFingerprint('multi\nline\ninput', 5)).toBe('multi');
    expect(makeFingerprint('   ')).toBeUndefined();
    expect(makeFingerprint('')).toBeUndefined();
  });

  it('fingerprint match is whitespace-tolerant: newlines on user side still match', () => {
    // Lark message contained newlines; fingerprint collapsed them.
    const fp = makeFingerprint('please\nreview\nthe new patch');
    expect(fp).toBe('please review the new patch');  // collapsed
    const q = new BridgeTurnQueue();
    q.mark('t1', fp);
    // Transcript preserved newlines verbatim — must still match.
    q.ingest([user('u1', 'please\nreview\nthe new patch'), assistant('a1', 'reviewed')]);
    const ready = q.drainEmittable();
    expect(ready.length).toBe(1);
    expect(ready[0].assistantUuids).toEqual(['a1']);
  });

  it('fingerprint match tolerates extra whitespace differences on either side', () => {
    const fp = makeFingerprint('hello world');
    const q = new BridgeTurnQueue();
    q.mark('t1', fp);
    // Transcript has tabs and double spaces.
    q.ingest([user('u1', 'hello\t\tworld\nappended-hint')]);
    expect(q.peek()[0].started).toBe(true);
  });

  // ── clearPending (lazy baseline race) ────────────────────────────────────

  it('clearPending drops all queued turns and resets collecting', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    q.ingest([user('u1')]);  // t1 started, collecting=t1
    q.mark('t2');
    const dropped = q.clearPending();
    expect(dropped.map(t => t.turnId)).toEqual(['t1', 't2']);
    expect(q.size()).toBe(0);
    // Subsequent ingest with assistant must NOT crash trying to push to a
    // collecting that was just dropped
    q.ingest([assistant('a1', 'orphan')]);
    q.mark('t3');
    q.ingest([user('u3'), assistant('a3', 'ok')]);
    const ready = q.drainEmittable();
    expect(ready[0].turnId).toBe('t3');
    expect(ready[0].assistantUuids).toEqual(['a3']);
  });

  describe('sourceJsonlPath stamping', () => {
    it('stamps the path provided at start-time onto the started turn', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1'), assistant('a1', 'hi')], '/tmp/sessionA.jsonl');
      const turn = q.peek()[0];
      expect(turn.started).toBe(true);
      expect(turn.sourceJsonlPath).toBe('/tmp/sessionA.jsonl');
    });

    it('keeps the original sourceJsonlPath after a later ingest from a different file', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      // Turn starts in fileA — assistant text from later file ingests must
      // NOT overwrite the source stamp, otherwise emit-time text resolution
      // would chase the wrong jsonl after a sessionId rotation.
      q.ingest([user('u1')], '/tmp/sessionA.jsonl');
      q.ingest([assistant('a1', 'partial')], '/tmp/sessionB.jsonl');
      expect(q.peek()[0].sourceJsonlPath).toBe('/tmp/sessionA.jsonl');
    });

    it('drainEmittable surfaces sourceJsonlPath so emit can pick the right file', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.mark('t2');
      // Two turns started in two different jsonls (rotation between turns)
      q.ingest([user('u1'), assistant('a1', 'reply 1')], '/tmp/sessionA.jsonl');
      q.ingest([user('u2'), assistant('a2', 'reply 2')], '/tmp/sessionB.jsonl');
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(2);
      expect(ready[0].sourceJsonlPath).toBe('/tmp/sessionA.jsonl');
      expect(ready[1].sourceJsonlPath).toBe('/tmp/sessionB.jsonl');
    });

    it('back-compat: sourceJsonlPath is undefined when ingest is called without a path', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1'), assistant('a1', 'reply')]);
      expect(q.peek()[0].sourceJsonlPath).toBeUndefined();
    });
  });

  describe('synthetic / non-meaningful user events', () => {
    function syntheticUser(content: string, extra: Record<string, unknown> = {}): TranscriptEvent {
      return { type: 'user', uuid: `sx-${content.slice(0, 10)}`, message: { role: 'user', content }, ...extra } as TranscriptEvent;
    }

    it('isMeta user event does NOT reset collecting (regression for /clear in-process rotation)', () => {
      // After Claude rotates jsonl on /clear, the new file starts with
      // <local-command-caveat>...</local-command-caveat> (isMeta:true) +
      // <command-name>/clear</command-name>, then the real Lark user
      // prompt, then assistant text. If the queue treats those synthetic
      // events as fresh user turns, `collecting` gets cleared and the
      // assistant text after them disappears.
      const q = new BridgeTurnQueue();
      q.mark('t1', 'test');
      q.ingest([
        syntheticUser('<local-command-caveat>noise</local-command-caveat>', { isMeta: true }),
        syntheticUser('<command-name>/clear</command-name>'),
        user('u-real', 'test'),
        assistant('a-real', 'reply after clear'),
      ]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].assistantUuids).toEqual(['a-real']);
    });

    it('synthetic user events arriving mid-turn do NOT drop collecting', () => {
      // Even hypothetically — Claude could write a meta event between
      // assistant text events. The current ingest must preserve the
      // active collecting through any non-meaningful user event.
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([
        user('u1'),
        assistant('a1', 'first chunk'),
        syntheticUser('<command-name>/foo</command-name>'),
        assistant('a2', 'second chunk'),
      ]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].assistantUuids).toEqual(['a1', 'a2']);
    });

    it('mark() captures a default markTimeMs', () => {
      const q = new BridgeTurnQueue();
      const before = Date.now();
      q.mark('t1', 'fp');
      const after = Date.now();
      const ts = q.peek()[0].markTimeMs!;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('mark() honours an explicit markTimeMs', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1', 'fp', 1234567890);
      expect(q.peek()[0].markTimeMs).toBe(1234567890);
    });
  });

  // ── Local-terminal turn forwarding (adopt mode: pane input synced to Lark) ──

  describe('local-terminal turn forwarding', () => {
    it('marks the synthesised turn as isLocal and captures userUuid', () => {
      const q = new BridgeTurnQueue();
      q.ingest([user('local-u1', 'pwd'), assistant('local-a1', '/tmp')]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].isLocal).toBe(true);
      expect(ready[0].userUuid).toBe('local-u1');
      expect(ready[0].assistantUuids).toEqual(['local-a1']);
    });

    it('stamps sourceJsonlPath on local turns so emit can resolve text after rotation', () => {
      const q = new BridgeTurnQueue();
      q.ingest([user('local-u', 'pwd'), assistant('local-a', '/tmp')], '/tmp/sessionA.jsonl');
      const ready = q.drainEmittable();
      expect(ready[0].sourceJsonlPath).toBe('/tmp/sessionA.jsonl');
    });

    it('empty local turn (no assistant text yet) is dropped on the next user event', () => {
      const q = new BridgeTurnQueue();
      // First local prompt — Claude crashed / cancelled before responding.
      q.ingest([user('local-u1', 'first')]);
      // Queue now has a started local turn with no assistant uuids.
      expect(q.peek()).toHaveLength(1);
      expect(q.peek()[0].isLocal).toBe(true);
      expect(q.peek()[0].assistantUuids).toEqual([]);
      // Next prompt arrives — empty turn must be dropped, otherwise it
      // head-of-line blocks the new turn forever.
      q.ingest([user('local-u2', 'second'), assistant('local-a2', 'reply')]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].userUuid).toBe('local-u2');
      expect(ready[0].assistantUuids).toEqual(['local-a2']);
    });

    it('an empty Lark turn (no fingerprint match yet) is NOT dropped by a local turn arriving', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1', makeFingerprint('lark question'));
      // Local input arrives first — must not consume / drop the unstarted Lark turn.
      q.ingest([user('local-u', 'something else'), assistant('local-a', 'local reply')]);
      // Local turn emits, but t1 stays in the queue waiting for its match.
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].isLocal).toBe(true);
      const t1 = q.peek().find(t => t.turnId === 't1');
      expect(t1?.started).toBe(false);
      // When the Lark user event finally lands, t1 starts normally.
      q.ingest([user('u1', 'lark question — full prompt'), assistant('a1', 'lark reply')]);
      const next = q.drainEmittable();
      expect(next).toHaveLength(1);
      expect(next[0].turnId).toBe('t1');
      expect(next[0].assistantUuids).toEqual(['a1']);
    });

    it('back-to-back local turns each emit independently with their own uuids', () => {
      const q = new BridgeTurnQueue();
      q.ingest([
        user('local-u1', 'first'),
        assistant('local-a1', 'first reply'),
        user('local-u2', 'second'),
        assistant('local-a2', 'second reply'),
      ]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(2);
      expect(ready[0].userUuid).toBe('local-u1');
      expect(ready[0].assistantUuids).toEqual(['local-a1']);
      expect(ready[1].userUuid).toBe('local-u2');
      expect(ready[1].assistantUuids).toEqual(['local-a2']);
    });

    it('documents head-of-line: an empty Lark turn ahead of a ready local turn blocks emission (in practice impossible — Claude is single-threaded and writes Lark assistant text BEFORE any next user event lands in the transcript)', () => {
      // This case can be constructed in tests but should never happen in
      // practice: Claude won't accept a local user prompt while still in
      // the middle of producing assistant output for an earlier Lark turn,
      // so a-text for t1 always lands in the JSONL before u-local does.
      // Asserted here as the documented behaviour; a future regression
      // that breaks this invariant should surface with a clear failure.
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1')]);  // t1 started, no assistant text yet
      // Hypothetical local input arrives BEFORE t1's assistant text. With
      // collecting now bound to the local turn, any later assistant text
      // is attributed to local-t, NOT t1. t1 stays empty and head-of-line
      // blocks emission — local-t can't drain past it.
      q.ingest([user('local-u'), assistant('local-a', 'local reply')]);
      const ready = q.drainEmittable();
      expect(ready).toEqual([]);
      // Even after another assistant event lands, t1 stays empty (it's
      // already lost the "collecting" role) — the queue remains blocked
      // until the test/runtime explicitly clears the empty Lark turn.
      q.ingest([assistant('late', 'late')]);
      expect(q.drainEmittable()).toEqual([]);
      // clearPending() unblocks. (Real-world: this scenario doesn't occur,
      // but if it ever did the daemon's session lifecycle would be the
      // safety net.)
      q.clearPending();
      expect(q.size()).toBe(0);
    });

    it('local turns absorbed at baseline are NOT replayed (history protection)', () => {
      const q = new BridgeTurnQueue();
      q.absorb([
        user('hist-u', 'old local prompt'),
        assistant('hist-a', 'old local reply'),
      ]);
      // Re-ingesting the same uuids must not synthesise a new local turn
      q.ingest([
        user('hist-u', 'old local prompt'),
        assistant('hist-a', 'old local reply'),
      ]);
      expect(q.size()).toBe(0);
      expect(q.drainEmittable()).toEqual([]);
    });
  });
});
