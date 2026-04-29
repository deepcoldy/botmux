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

  it('local-terminal turn before any Lark message: assistant uuids dropped', () => {
    const q = new BridgeTurnQueue();
    // Local user types in the original pane — no pending turn yet
    q.ingest([user('local-u1'), assistant('local-a1', 'local reply')]);
    // Then a Lark message arrives
    q.mark('t1');
    q.ingest([user('u1'), assistant('a1', 'lark reply')]);
    const ready = q.drainEmittable();
    expect(ready.length).toBe(1);
    expect(ready[0].turnId).toBe('t1');
    expect(ready[0].assistantUuids).toEqual(['a1']);
  });

  it('local turn between two Lark turns: local assistant does not bleed in', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    q.ingest([user('u1'), assistant('a1', 'lark1')]);
    // After t1 is started+collected but not yet emitted, local user types
    q.ingest([user('local-u'), assistant('local-a', 'local reply')]);
    // Now Lark sends another
    q.mark('t2');
    q.ingest([user('u2'), assistant('a2', 'lark2')]);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t1', 't2']);
    expect(ready[0].assistantUuids).toEqual(['a1']);
    // Critically: the local assistant uuid is NOT in t2 (or anywhere)
    expect(ready[1].assistantUuids).toEqual(['a2']);
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

  it('fingerprint match: only the matching user event starts the turn', () => {
    const q = new BridgeTurnQueue();
    const fp = makeFingerprint('please review the new patch');
    q.mark('t1', fp);
    // Local user types something else first
    q.ingest([user('local-u', 'ls -la'), assistant('local-a', 'output')]);
    expect(q.peek()[0].started).toBe(false);  // not started by local input
    // Then the Lark message lands in the transcript
    q.ingest([user('u1', 'please review the new patch — appended hint'), assistant('a1', 'reviewed')]);
    const ready = q.drainEmittable();
    expect(ready.length).toBe(1);
    expect(ready[0].assistantUuids).toEqual(['a1']);
  });

  it('fingerprint mismatch: local user with different content does NOT start the turn', () => {
    const q = new BridgeTurnQueue();
    const fp = makeFingerprint('lark-specific question');
    q.mark('t1', fp);
    // Local user types — content does not match fingerprint
    q.ingest([user('local-u', 'something completely different')]);
    expect(q.peek()[0].started).toBe(false);
    expect(q.peek()[0].assistantUuids).toEqual([]);
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
});
