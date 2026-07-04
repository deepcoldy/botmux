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
import { shouldSuppressBridgeEmit, type BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';
import type { TranscriptEvent } from '../src/services/claude-transcript.js';

function user(uuid: string, content: string = `<input ${uuid}>`, timestamp?: string): TranscriptEvent {
  return { type: 'user', uuid, timestamp, message: { role: 'user', content } };
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

  it('synthesises a headless local turn when assistant text arrives without any preceding user event (daemon restart mid-stream)', () => {
    // Reproduces: daemon restart cut off an in-flight model stream. Baseline
    // absorbs the original user event and any assistant text written before
    // the restart cutoff; subsequent assistant events arrive with no
    // `collecting`. Without headless synthesis they're dropped silently and
    // the user never sees the rest of the reply in Lark.
    const q = new BridgeTurnQueue();
    // Baseline absorbs pre-restart events as history. Note: bridgeAbsorbBaseline
    // calls absorb(), which only adds uuids to the seen set — collecting stays null.
    q.absorb([user('absorbed-u', 'pre-restart input'), assistant('absorbed-a', 'partial reply')]);
    // Post-restart: model continues streaming new assistant text.
    q.ingest([assistant('continued', 'rest of the reply')]);
    const ready = q.drainEmittable();
    expect(ready).toHaveLength(1);
    expect(ready[0].isLocal).toBe(true);
    expect(ready[0].userUuid).toBeUndefined();
    expect(ready[0].assistantUuids).toEqual(['continued']);
  });

  it('subsequent assistant events keep collecting on the headless turn until the next user event', () => {
    const q = new BridgeTurnQueue();
    q.ingest([
      assistant('a1', 'chunk one'),
      assistant('a2', 'chunk two'),
      assistant('a3', 'chunk three'),
    ]);
    const ready = q.drainEmittable();
    expect(ready).toHaveLength(1);
    expect(ready[0].isLocal).toBe(true);
    expect(ready[0].userUuid).toBeUndefined();
    expect(ready[0].assistantUuids).toEqual(['a1', 'a2', 'a3']);
  });

  it('headless local turn does not block a Lark turn that arrives next', () => {
    const q = new BridgeTurnQueue();
    // In-flight assistant text after a daemon restart — synthesises a headless turn.
    q.ingest([assistant('headless-a', 'continuation')]);
    // User then sends a new Lark message normally.
    q.mark('t1');
    q.ingest([user('u1', 'new question'), assistant('a1', 'fresh answer')]);
    const ready = q.drainEmittable();
    // Both emit, headless first (chronologically older).
    expect(ready).toHaveLength(2);
    expect(ready[0].isLocal).toBe(true);
    expect(ready[0].userUuid).toBeUndefined();
    expect(ready[0].assistantUuids).toEqual(['headless-a']);
    expect(ready[1].turnId).toBe('t1');
    expect(ready[1].assistantUuids).toEqual(['a1']);
  });

  it('drops a started Lark turn that produced no assistant text when a new Lark turn arrives', () => {
    // Reproduces the post-/clear silence pattern: user sends "good", model
    // emits ZERO assistant events (no tool_use, no thinking, no text), then
    // the user sends "what ???". Without dropping the silent turn, its empty
    // assistantUuids head-of-line blocks every later turn's emit.
    //
    // Safe because Claude can only read a NEW user input from the PTY after
    // it finishes the previous turn — so a meaningful user event arriving in
    // the transcript means the model has moved on, regardless of whether
    // the previous turn was Lark or local.
    const q = new BridgeTurnQueue();
    q.mark('t1', makeFingerprint('good'));
    q.ingest([user('u1', 'good')]);  // matched, started, but model went silent
    expect(q.peek()[0].turnId).toBe('t1');
    expect(q.peek()[0].started).toBe(true);
    expect(q.peek()[0].assistantUuids).toEqual([]);

    // Second Lark message arrives; model responds normally.
    q.mark('t2', makeFingerprint('what ???'));
    q.ingest([user('u2', 'what ???'), assistant('a2', 'clarify?')]);

    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t2']);
    expect(ready[0].assistantUuids).toEqual(['a2']);
    expect(q.size()).toBe(0);
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
    // collecting that was just dropped. The orphan is preserved as a
    // headless local turn (the post-/clear / post-restart recovery path).
    q.ingest([assistant('a1', 'orphan')]);
    q.mark('t3');
    q.ingest([user('u3'), assistant('a3', 'ok')]);
    const ready = q.drainEmittable();
    expect(ready).toHaveLength(2);
    expect(ready[0].isLocal).toBe(true);
    expect(ready[0].userUuid).toBeUndefined();
    expect(ready[0].assistantUuids).toEqual(['a1']);
    expect(ready[1].turnId).toBe('t3');
    expect(ready[1].assistantUuids).toEqual(['a3']);
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

    it('an empty Lark turn ahead of a local turn is dropped (no head-of-line block)', () => {
      // Originally written as "documents head-of-line block — in practice
      // impossible". The "impossible" assumption was wrong: Claude can choose
      // to emit ZERO assistant events for a turn (post-/clear "good"
      // silence on 2026-04-30 was the wild observation), and the next user
      // event then lands in the transcript without any preceding assistant
      // text. The empty-collecting drop now applies to Lark turns too, so
      // the abandoned turn is removed and the next turn emits cleanly.
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1')]);  // t1 started, model went silent
      q.ingest([user('local-u'), assistant('local-a', 'local reply')]);
      const ready = q.drainEmittable();
      // t1 dropped, local turn emits.
      expect(ready).toHaveLength(1);
      expect(ready[0].isLocal).toBe(true);
      expect(ready[0].userUuid).toBe('local-u');
      expect(ready[0].assistantUuids).toEqual(['local-a']);
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

  // ── Type-ahead via attachment(queued_command) attribution ────────────────
  //
  // When Claude is busy and the worker submits via type-ahead, jsonl records
  // the dequeue moment as `attachment(queued_command)` (with uuid + timestamp)
  // immediately before the assistant text for that turn streams. The queue
  // must treat this identically to `role:user` for turn-start, AND override
  // markTimeMs to the event timestamp so the bridge-fallback gate's window
  // anchors on "Claude actually started processing this turn" — not on the
  // earlier moment the worker wrote to PTY.
  describe('attachment(queued_command) attribution', () => {
    function queuedCommand(uuid: string, prompt: string, timestamp?: string, commandMode?: string): TranscriptEvent {
      return {
        type: 'attachment',
        uuid,
        timestamp,
        attachment: { type: 'queued_command', prompt, commandMode },
      };
    }

    it('queued_command starts the matching pending Lark turn and overrides markTimeMs', () => {
      const q = new BridgeTurnQueue();
      const fpA = makeFingerprint('please review the new patch');
      const fpB = makeFingerprint('also fix the typo on line 42');
      // Both Lark turns marked while Claude was still on a previous turn —
      // markTimeMs anchors at the early enqueue moment.
      q.mark('tA', fpA, 100);
      q.mark('tB', fpB, 120);
      // Claude finally dequeues turn A: writes attachment(queued_command)
      // followed by the assistant reply. Then dequeues B.
      q.ingest([
        queuedCommand('qa', 'please review the new patch — appended hint', '2026-05-10T18:36:00.000Z'),
        assistant('aa', 'reviewed'),
        queuedCommand('qb', 'also fix the typo on line 42 — appended', '2026-05-10T18:36:30.000Z'),
        assistant('ab', 'fixed'),
      ]);
      const ready = q.drainEmittable();
      expect(ready.map(t => t.turnId)).toEqual(['tA', 'tB']);
      expect(ready[0].assistantUuids).toEqual(['aa']);
      expect(ready[1].assistantUuids).toEqual(['ab']);
      // markTimeMs MUST be the event timestamp, not the original mark time.
      expect(ready[0].markTimeMs).toBe(Date.parse('2026-05-10T18:36:00.000Z'));
      expect(ready[1].markTimeMs).toBe(Date.parse('2026-05-10T18:36:30.000Z'));
    });

    it('send-marker gate: marker between turn1 dequeue and turn2 dequeue suppresses turn1, not turn2', () => {
      // Regression test for the bridge-fallback-gate window semantics under
      // type-ahead. Without the markTimeMs override, turn2's window would
      // start at its early enqueue time and a marker landing AFTER turn1's
      // assistant text but BEFORE turn2's dequeue would (a) miss turn1's
      // [enqueue, turn2.enqueue) window — failing to suppress turn1's
      // fallback, and (b) fall inside turn2's [enqueue, ∞) window — wrongly
      // suppressing turn2's real reply. Overriding markTimeMs fixes both.
      const q = new BridgeTurnQueue();
      const fpA = makeFingerprint('first prompt');
      const fpB = makeFingerprint('second prompt');
      q.mark('tA', fpA, 100);  // enqueue (early)
      q.mark('tB', fpB, 120);  // enqueue (close to A, well before B's dequeue)
      q.ingest([
        queuedCommand('qa', 'first prompt — body', new Date(1000).toISOString()),
        assistant('aa', 'reply A'),
        queuedCommand('qb', 'second prompt — body', new Date(3000).toISOString()),
        assistant('ab', 'reply B'),
      ]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(2);
      expect(ready[0].markTimeMs).toBe(1000);
      expect(ready[1].markTimeMs).toBe(3000);
      // End-to-end gate behaviour: a `botmux send` marker landing between
      // turn1's dequeue (1000) and turn2's dequeue (3000) means the model
      // pushed turn1's reply itself and DOESN'T also serve as turn2's
      // delivery. The gate must suppress turn1 and let turn2 through.
      const markers = [{ sentAtMs: 2000 }];
      const turn1NextBoundary = ready[1].markTimeMs;  // 3000
      const turn2NextBoundary = undefined;  // last in batch
      expect(
        shouldSuppressBridgeEmit({ markTimeMs: ready[0].markTimeMs, isLocal: ready[0].isLocal }, turn1NextBoundary, markers, false),
      ).toBe(true);
      expect(
        shouldSuppressBridgeEmit({ markTimeMs: ready[1].markTimeMs, isLocal: ready[1].isLocal }, turn2NextBoundary, markers, false),
      ).toBe(false);
    });

    it('queued_command prompt mismatch falls through to local turn synthesised from attachment.prompt', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1', makeFingerprint('lark-specific question'));
      // User typed something else directly in the pane while Claude was busy
      // — it landed in the type-ahead queue and now dequeues as a
      // queued_command attachment whose prompt doesn't match t1's fingerprint.
      q.ingest([
        queuedCommand('local-q', 'something completely different', new Date(5000).toISOString()),
      ]);
      const t1 = q.peek().find(t => t.turnId === 't1');
      expect(t1?.started).toBe(false);
      const local = q.peek().find(t => t.isLocal);
      expect(local).toBeTruthy();
      expect(local?.userUuid).toBe('local-q');
      expect(local?.markTimeMs).toBe(5000);
      // Lark turn stays unstarted, ready to consume the next matching submit.
    });

    it('extractTurnStartText recovers prompt for local emit (queued_command-derived local turn)', async () => {
      // Verify that the worker emit path's text extraction works on the
      // synthesised local turn — without this, formatLocalTurnContent would
      // see an empty user side and the Lark thread would show an orphan reply.
      const { extractTurnStartText } = await import('../src/services/claude-transcript.js');
      const ev: TranscriptEvent = {
        type: 'attachment',
        uuid: 'q1',
        attachment: { type: 'queued_command', prompt: 'pwd' },
      };
      expect(extractTurnStartText(ev)).toBe('pwd');
      // Falls back to message.content for legacy role:user events.
      const userEv: TranscriptEvent = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'ls -la' } };
      expect(extractTurnStartText(userEv)).toBe('ls -la');
      // Tolerates non-string prompt via stringifyUserContent.
      const arrayPrompt: TranscriptEvent = {
        type: 'attachment',
        uuid: 'q2',
        attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'hello' }] as unknown },
      };
      expect(extractTurnStartText(arrayPrompt)).toBe('hello');
    });

    it('queued_command with empty prompt is skipped: does not drop collecting or synthesise a local turn', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1'), assistant('a1', 'partial')]);
      // Empty prompt — must NOT trigger HOL-block drop on the active
      // collecting turn, must NOT create a new local turn.
      q.ingest([queuedCommand('q-empty', '', new Date(2000).toISOString())]);
      const peek = q.peek();
      expect(peek).toHaveLength(1);
      expect(peek[0].turnId).toBe('t1');
      expect(peek[0].assistantUuids).toEqual(['a1']);
    });

    it('idempotent ingest: replaying the same queued_command uuid does not double-attribute', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1', makeFingerprint('hello world'));
      const ev = queuedCommand('q1', 'hello world', new Date(1000).toISOString());
      q.ingest([ev, assistant('a1', 'reply')]);
      // Replay the same events — must be a no-op (uuid already in seen set).
      q.ingest([ev, assistant('a1', 'reply')]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].turnId).toBe('t1');
      expect(ready[0].assistantUuids).toEqual(['a1']);
      expect(q.size()).toBe(0);
    });

    it('synthetic-prefixed queued_command is filtered (defense-in-depth against slash-command type-ahead)', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1'), assistant('a1', 'partial')]);
      // Hypothetical: a slash-command-wrapped prompt landed in the queue.
      // Treating it as a turn-start would drop the active collecting turn.
      q.ingest([
        queuedCommand('q-slash', '<command-name>/clear</command-name>', new Date(2000).toISOString()),
      ]);
      const peek = q.peek();
      expect(peek).toHaveLength(1);
      expect(peek[0].turnId).toBe('t1');
      expect(peek[0].assistantUuids).toEqual(['a1']);
    });

    it('task-notification queued_command is filtered: does not split the active Lark turn', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1', makeFingerprint('run the research task'), Date.parse('2026-06-10T13:05:58.982Z'));
      q.ingest([
        user('u1', 'run the research task', '2026-06-10T13:06:06.637Z'),
        assistant('a-start', 'I will inspect the repo first.'),
        queuedCommand(
          'q-task',
          '<task-notification>\n<task-id>agent-1</task-id>\n<status>completed</status>\n</task-notification>',
          '2026-06-10T13:09:30.130Z',
          'task-notification',
        ),
        queuedCommand(
          'q-task-no-mode',
          '<task-notification>\n<task-id>agent-2</task-id>\n<status>completed</status>\n</task-notification>',
          '2026-06-10T13:10:00.000Z',
        ),
        assistant('a-final', 'Final answer after the task notification.'),
      ]);

      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].turnId).toBe('t1');
      expect(ready[0].isLocal).toBeFalsy();
      expect(ready[0].assistantUuids).toEqual(['a-start', 'a-final']);
    });

    it('task notifications do not cap the send-marker window before the final botmux send', () => {
      const q = new BridgeTurnQueue();
      const firstPrompt = '<user_message>research startup hooks</user_message>';
      q.mark('turn-1', makeFingerprint(firstPrompt), Date.parse('2026-06-10T13:05:58.982Z'));
      q.ingest([
        {
          type: 'user',
          uuid: 'u-lark',
          timestamp: '2026-06-10T13:06:06.637Z',
          message: { role: 'user', content: firstPrompt },
        },
        assistant('a-start', '我来先看图片和现有的启动检测逻辑，然后调研 Claude/Codex 的 hooks 能力。'),
        queuedCommand(
          'q-agent-a',
          '<task-notification>\n<task-id>a777</task-id>\n<status>completed</status>\n</task-notification>',
          '2026-06-10T13:09:30.130Z',
          'task-notification',
        ),
        assistant('a-progress', 'Claude 侧完整闭环验证通过。清理现场，等 Codex 调研结果：'),
        queuedCommand(
          'q-agent-b',
          '<task-notification>\n<task-id>a586</task-id>\n<status>completed</status>\n</task-notification>',
          '2026-06-10T13:15:07.250Z',
          'task-notification',
        ),
        assistant('a-final', '调研完成，结论已发飞书。简要总结：最终收尾文本。'),
      ]);

      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].turnId).toBe('turn-1');
      expect(ready[0].isLocal).toBeFalsy();
      expect(ready[0].assistantUuids).toEqual(['a-start', 'a-progress', 'a-final']);

      const assistantText = [
        '我来先看图片和现有的启动检测逻辑，然后调研 Claude/Codex 的 hooks 能力。',
        'Claude 侧完整闭环验证通过。清理现场，等 Codex 调研结果：',
        '调研完成，结论已发飞书。简要总结：最终收尾文本。',
      ].join('\n\n');
      const markers: BridgeSendMarker[] = [{
        sentAtMs: Date.parse('2026-06-10T13:15:50.924Z'),
        messageId: 'om_final',
        contentLength: 1646,
      }];
      expect(
        shouldSuppressBridgeEmit(
          { markTimeMs: ready[0].markTimeMs, isLocal: ready[0].isLocal, finalText: assistantText },
          undefined,
          markers,
          false,
        ),
      ).toBe(true);
    });
  });
});
