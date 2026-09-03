/**
 * Tests for the durable bridge-turn journal (restart recovery of interrupted
 * Lark turns) and the restore recipe worker.ts applies on top of it:
 *
 *   journal fs ops       — append / read / remove / clear, malformed input,
 *                          bounded growth
 *   restore filter       — same-jsonl scoping, age cap, mark-order sort
 *   restore semantics    — the exact sequence tryRestoreInterruptedBridgeTurns
 *                          performs (re-mark restored → split by cutoff →
 *                          absorb history / ingest live → drain at idle),
 *                          driven against the real BridgeTurnQueue + the real
 *                          send-marker gate for the four outcomes:
 *                            1. model already `botmux send`-ed before the kill
 *                               → suppressed (turn-sends markers persist)
 *                            2. model never sent → recovered text emitted,
 *                               turn flagged restoredFromJournal
 *                            3. partial output only → same as 2 (that IS the
 *                               recovery case)
 *                            4. no output / user line never landed → turn
 *                               never starts; pruneExpired retires it
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendBridgeTurnJournalEntry,
  BridgeRestoreGate,
  clearBridgeTurnJournal,
  readBridgeTurnJournal,
  removeBridgeTurnJournalEntry,
  selectRestorableBridgeTurns,
  writeBridgeTurnJournal,
  BRIDGE_TURN_RESTORE_MAX_AGE_MS,
  type BridgeTurnJournalEntry,
} from '../src/services/bridge-turn-journal.js';
import { BridgeTurnQueue, makeFingerprint, normaliseForFingerprint } from '../src/services/bridge-turn-queue.js';
import { shouldSuppressBridgeEmit, type BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';
import { splitTranscriptEventsByCutoff, type TranscriptEvent } from '../src/services/claude-transcript.js';

function user(uuid: string, content: string, timestampMs: number): TranscriptEvent {
  return { type: 'user', uuid, timestamp: new Date(timestampMs).toISOString(), message: { role: 'user', content } };
}
function assistant(uuid: string, text: string, timestampMs: number): TranscriptEvent {
  return {
    type: 'assistant',
    uuid,
    timestamp: new Date(timestampMs).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function entry(overrides: Partial<BridgeTurnJournalEntry> = {}): BridgeTurnJournalEntry {
  return {
    turnId: 'turn-1',
    markTimeMs: 1_000_000,
    jsonlPath: '/tmp/session.jsonl',
    offsetAtMark: 0,
    ...overrides,
  };
}

describe('bridge turn journal file ops', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-turn-journal-'));
    path = join(dir, 'turn-marks', 'session.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends, reads back, removes per turn, and clears', () => {
    appendBridgeTurnJournalEntry(path, entry({ turnId: 't1', markTimeMs: 1 }));
    appendBridgeTurnJournalEntry(path, entry({ turnId: 't2', markTimeMs: 2, dispatchAttempt: 3 }));
    expect(readBridgeTurnJournal(path).map(e => e.turnId)).toEqual(['t1', 't2']);

    removeBridgeTurnJournalEntry(path, 't1');
    expect(readBridgeTurnJournal(path).map(e => e.turnId)).toEqual(['t2']);

    // Removing the last entry deletes the file entirely.
    removeBridgeTurnJournalEntry(path, 't2', 3);
    expect(readBridgeTurnJournal(path)).toEqual([]);
    expect(existsSync(path)).toBe(false);

    appendBridgeTurnJournalEntry(path, entry({ turnId: 't3' }));
    clearBridgeTurnJournal(path);
    expect(readBridgeTurnJournal(path)).toEqual([]);
  });

  it('re-marking the same turnId+attempt replaces the old entry', () => {
    appendBridgeTurnJournalEntry(path, entry({ turnId: 't1', offsetAtMark: 10 }));
    appendBridgeTurnJournalEntry(path, entry({ turnId: 't1', offsetAtMark: 99 }));
    const entries = readBridgeTurnJournal(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].offsetAtMark).toBe(99);
  });

  it('treats malformed or wrong-shape files as empty', () => {
    writeBridgeTurnJournal(path, [entry()]);
    writeFileSync(path, 'not json');
    expect(readBridgeTurnJournal(path)).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 99, pending: [entry()] }));
    expect(readBridgeTurnJournal(path)).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 1, pending: [{ turnId: 42 }] }));
    expect(readBridgeTurnJournal(path)).toEqual([]);
  });

  it('bounds journal growth by shedding oldest entries', () => {
    const many = Array.from({ length: 50 }, (_, i) => entry({ turnId: `t${i}`, markTimeMs: i }));
    writeBridgeTurnJournal(path, many);
    const kept = readBridgeTurnJournal(path);
    expect(kept.length).toBe(32);
    expect(kept[0].turnId).toBe('t18');
    expect(kept.at(-1)!.turnId).toBe('t49');
    // Sanity: the payload really is a single JSON object, not an append log.
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
  });
});

describe('selectRestorableBridgeTurns', () => {
  const now = 10_000_000;

  it('keeps only same-file, fresh entries, sorted by mark time', () => {
    const entries = [
      entry({ turnId: 'newer', jsonlPath: '/a.jsonl', markTimeMs: now - 1_000 }),
      entry({ turnId: 'rotated', jsonlPath: '/b.jsonl', markTimeMs: now - 1_000 }),
      entry({ turnId: 'older', jsonlPath: '/a.jsonl', markTimeMs: now - 5_000 }),
      entry({ turnId: 'stale', jsonlPath: '/a.jsonl', markTimeMs: now - BRIDGE_TURN_RESTORE_MAX_AGE_MS - 1 }),
    ];
    const restorable = selectRestorableBridgeTurns(entries, { currentJsonlPath: '/a.jsonl', nowMs: now });
    expect(restorable.map(e => e.turnId)).toEqual(['older', 'newer']);
  });

  it('excludes durable turns (dispatchAttempt set) — they self-recover, restoring would double-deliver', () => {
    // A durable turn has its own cross-restart recovery owner (daemon
    // queuedActivation* write-ahead + receipt auto-redispatch). Restoring it
    // from the journal too would post the recovered partial AND the
    // re-dispatched attempt (same turnId, different lastUuid → daemon dedupe
    // can't collapse them). The write side no longer journals durable turns;
    // this guards a journal left behind by a pre-fix build across an upgrade.
    const entries = [
      entry({ turnId: 'plain', jsonlPath: '/a.jsonl', markTimeMs: now - 1_000 }),
      entry({ turnId: 'durable', jsonlPath: '/a.jsonl', markTimeMs: now - 2_000, dispatchAttempt: 1 }),
    ];
    const restorable = selectRestorableBridgeTurns(entries, { currentJsonlPath: '/a.jsonl', nowMs: now });
    expect(restorable.map(e => e.turnId)).toEqual(['plain']);
  });
});

describe('BridgeRestoreGate (restore at most once, only on the first baseline)', () => {
  it('allows restore on the first baseline, refuses every later baseline', () => {
    const gate = new BridgeRestoreGate();
    // First baseline of a fresh worker process (daemon restart / crash) — the
    // one baseline with no competing recovery owner.
    expect(gate.mayRestoreOnThisBaseline()).toBe(true);
    // Peeking again without a generation retiring must NOT flip it: an empty
    // first baseline that never restored still needs to restore if the file
    // shows up on a lazy re-baseline within the same generation.
    expect(gate.mayRestoreOnThisBaseline()).toBe(true);
  });

  it('disarms after a CLI generation is retired (in-worker restart)', () => {
    const gate = new BridgeRestoreGate();
    // A watcher teardown ends the first CLI generation. Every baseline after
    // this is an in-worker restart whose carryover already re-delivers the
    // interrupted turn — restoring again would double-deliver.
    gate.markGenerationRetired();
    expect(gate.mayRestoreOnThisBaseline()).toBe(false);
    // Idempotent + terminal: further retirements keep it disarmed.
    gate.markGenerationRetired();
    expect(gate.mayRestoreOnThisBaseline()).toBe(false);
  });
});

describe('restore semantics against the real queue + gate', () => {
  // Timeline: an old completed turn, then the interrupted turn's user line and
  // partial assistant output, then the worker died. The new generation
  // re-marks from the journal and re-drains from the recorded offset.
  const markTimeMs = 1_700_000_000_000;
  const cutoffMs = markTimeMs - 5_000; // same guard the fingerprint switch uses
  const larkMessage = '@Bot 检查部署结果并汇报';

  function restoredQueueWithEvents(events: TranscriptEvent[]): BridgeTurnQueue {
    const q = new BridgeTurnQueue();
    q.mark(
      'turn-interrupted',
      makeFingerprint(larkMessage),
      markTimeMs,
      normaliseForFingerprint(larkMessage),
      undefined,
      { restoredFromJournal: true },
    );
    const { history, live } = splitTranscriptEventsByCutoff(events, cutoffMs);
    q.absorb(history);
    if (live.length > 0) q.ingest(live, '/tmp/session.jsonl');
    return q;
  }

  const oldTurnEvents = [
    user('old-u', '<user_message>早先的问题</user_message>', markTimeMs - 60_000),
    assistant('old-a', '早先的回答', markTimeMs - 55_000),
  ];
  const interruptedTurnEvents = [
    user('cur-u', `<user_message>${larkMessage}</user_message>`, markTimeMs + 1_000),
    assistant('cur-a', '部署已验证，fleet 全部在线。正准备汇报时被杀。', markTimeMs + 20_000),
  ];

  it('recovers the interrupted turn: history absorbed, live attributed, restored flag set', () => {
    const q = restoredQueueWithEvents([...oldTurnEvents, ...interruptedTurnEvents]);
    const ready = q.drainEmittable();
    expect(ready).toHaveLength(1);
    expect(ready[0].turnId).toBe('turn-interrupted');
    expect(ready[0].restoredFromJournal).toBe(true);
    // Only the interrupted turn's assistant text — the old turn was absorbed.
    expect(ready[0].assistantUuids).toEqual(['cur-a']);
  });

  it('suppresses the recovered turn when a persisted send marker already covers it (已 send)', () => {
    const q = restoredQueueWithEvents([...oldTurnEvents, ...interruptedTurnEvents]);
    const [turn] = q.drainEmittable();
    // turn-sends markers persist across restarts; the model sent this text
    // mid-turn before the kill.
    const markers: BridgeSendMarker[] = [{
      sentAtMs: markTimeMs + 15_000,
      contentLength: normaliseForFingerprint('部署已验证，fleet 全部在线。正准备汇报时被杀。').length,
    }];
    expect(shouldSuppressBridgeEmit(
      { markTimeMs: turn.markTimeMs, isLocal: turn.isLocal, finalText: '部署已验证，fleet 全部在线。正准备汇报时被杀。' },
      undefined,
      markers,
      false,
    )).toBe(true);
  });

  it('emits the recovered turn when nothing was sent (未 send / 部分输出)', () => {
    const q = restoredQueueWithEvents([...oldTurnEvents, ...interruptedTurnEvents]);
    const [turn] = q.drainEmittable();
    expect(shouldSuppressBridgeEmit(
      { markTimeMs: turn.markTimeMs, isLocal: turn.isLocal, finalText: '部署已验证，fleet 全部在线。正准备汇报时被杀。' },
      undefined,
      [],
      false,
    )).toBe(false);
  });

  it('holds a restored turn whose user line landed but produced no output yet, and prunes one whose user line never landed (无输出)', () => {
    // Case A: user line landed, no assistant text — started turn is held (not
    // popped, not pruned) so a post-restart continuation can still attach.
    const started = restoredQueueWithEvents([...oldTurnEvents, interruptedTurnEvents[0]]);
    expect(started.drainEmittable()).toHaveLength(0);
    expect(started.pruneExpired(1, markTimeMs + 10 * 60_000)).toHaveLength(0);
    expect(started.peek()[0]?.started).toBe(true);

    // Case B: the kill happened before Claude wrote the user line — the mark
    // never starts and the TTL sweep retires it.
    const neverStarted = restoredQueueWithEvents(oldTurnEvents);
    expect(neverStarted.drainEmittable()).toHaveLength(0);
    const expired = neverStarted.pruneExpired(1, markTimeMs + 10 * 60_000);
    expect(expired.map(t => t.turnId)).toEqual(['turn-interrupted']);
  });

  it('a stray prior-turn assistant tail after the cutoff only synthesizes a local turn, which the non-adopt gate suppresses', () => {
    // The previous turn's late assistant flush can land after cutoff without a
    // matching user line. It must not be attributed to the restored Lark turn,
    // and its synthesized local turn is always suppressed in non-adopt mode.
    const q = restoredQueueWithEvents([
      assistant('stray-a', '上一轮迟到的输出', markTimeMs - 2_000),
      ...interruptedTurnEvents,
    ]);
    const ready = q.drainEmittable();
    const larkTurn = ready.find(t => t.turnId === 'turn-interrupted');
    expect(larkTurn?.assistantUuids).toEqual(['cur-a']);
    for (const t of ready.filter(t => t.turnId !== 'turn-interrupted')) {
      expect(t.isLocal).toBe(true);
      expect(shouldSuppressBridgeEmit(
        { markTimeMs: t.markTimeMs, isLocal: t.isLocal },
        undefined,
        [],
        false,
      )).toBe(true);
    }
  });
});
