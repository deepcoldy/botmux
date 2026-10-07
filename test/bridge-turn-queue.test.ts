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
import { readFileSync } from 'node:fs';
import { BridgeTurnQueue, makeFingerprint, isTruncatedMatch } from '../src/services/bridge-turn-queue.js';
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
/** Claude Code built-in CronCreate fire record: isMeta user event with
 *  turnOrigin:"scheduled", exactly as written to the transcript. */
function scheduledFire(uuid: string, opts: { fireId?: string; content?: string; taskId?: string } = {}): TranscriptEvent {
  const ev: TranscriptEvent = {
    type: 'user',
    uuid,
    isMeta: true,
    turnOrigin: 'scheduled',
    scheduledTaskId: opts.taskId ?? 'task-1',
    scheduledFireId: opts.fireId ?? `fire-${uuid}`,
    message: { role: 'user', content: opts.content ?? `<scheduled fire ${uuid}>` },
  };
  return ev;
}
/** Assistant tool_use block calling the built-in CronCreate. */
function cronCreateCall(blockId: string): TranscriptEvent {
  return {
    type: 'assistant',
    uuid: `caller-${blockId}`,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: blockId, name: 'CronCreate', input: { cron: '7,37 * * * *' } }] as any,
    },
  };
}
/** User tool_result ack carrying the scheduled task id, as Claude writes it.
 *  Note the REAL noun differs by kind: recurring prints "… recurring job",
 *  one-shot prints "… one-shot TASK" (verified on Claude Code 2.1.276/2.1.284). */
function cronCreateAck(blockId: string, taskId: string, kind: 'recurring' | 'oneshot' = 'recurring'): TranscriptEvent {
  const phrase = kind === 'recurring' ? 'recurring job' : 'one-shot task';
  return {
    type: 'user',
    uuid: `ack-${taskId}`,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: blockId,
        content: `Scheduled ${phrase} ${taskId} (7,37 * * * *). Use CronDelete to cancel sooner.`,
      }] as any,
    },
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

  it('does not attribute a rate_limit API-error record as the turn reply', () => {
    // The rate_limit record is type:"assistant" with a human text block, but
    // the worker surfaces it as a `limited` state; it must NOT become the
    // turn's assistantUuids (that would forward the raw error line to Lark).
    const q = new BridgeTurnQueue();
    q.mark('t1');
    const rateErr: TranscriptEvent = {
      type: 'assistant',
      uuid: 'rl1',
      isApiErrorMessage: true,
      error: 'rate_limit',
      apiErrorStatus: 429,
      message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 10:40pm" }], stop_reason: 'stop_sequence' },
    };
    q.ingest([user('u1'), rateErr]);
    // Turn started (user matched) but collected no real reply → held back,
    // not emitted with the error text.
    expect(q.peek()[0]?.assistantUuids ?? []).toEqual([]);
    expect(q.drainEmittable()).toEqual([]);
  });

  it('keeps 429 on the limited path when turn_duration follows it', () => {
    const q = new BridgeTurnQueue();
    q.mark('om_limited');
    q.ingest([
      user('u-limit'),
      {
        type: 'assistant',
        uuid: 'rl-duration',
        isApiErrorMessage: true,
        error: 'rate_limit',
        apiErrorStatus: 429,
        message: { role: 'assistant', content: [], stop_reason: 'stop_sequence' },
      },
      { type: 'system', subtype: 'turn_duration', uuid: 'duration-limit' },
    ]);

    expect(q.drainEmittable({ explicitTerminalOnly: true })).toEqual([
      expect.objectContaining({
        turnId: 'om_limited',
        rateLimited: true,
      }),
    ]);
    expect(q.peek()).toEqual([]);
  });

  it('records a structured retryable failure without treating its error text as an answer', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    const srvErr: TranscriptEvent = {
      type: 'assistant',
      uuid: 'se1',
      isApiErrorMessage: true,
      error: 'server_error',
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 500 internal server error' }], stop_reason: 'stop_sequence' },
    };
    q.ingest([user('u1'), srvErr]);
    const ready = q.drainEmittable({ explicitTerminalOnly: true });
    expect(ready.length).toBe(1);
    expect(ready[0].assistantUuids).toEqual([]);
    expect(ready[0].terminalOutcome).toEqual({
      status: 'failed',
      errorCode: 'provider_server_error',
      retryable: true,
    });
  });

  it('preserves an unexpected EOF failure when turn_duration closes the boundary', () => {
    const q = new BridgeTurnQueue();
    q.mark('om_original');
    const eof: TranscriptEvent = {
      type: 'assistant',
      uuid: 'fixture-error',
      isApiErrorMessage: true,
      error: 'unknown',
      message: {
        role: 'assistant',
        stop_reason: 'stop_sequence',
        content: [{ type: 'text', text: 'API Error: provider disconnected: unexpected EOF' }],
      },
    };
    const duration: TranscriptEvent = {
      type: 'system',
      subtype: 'turn_duration',
      uuid: 'fixture-duration',
    };

    q.ingest([user('u1'), eof, duration]);

    expect(q.drainEmittable({ explicitTerminalOnly: true })).toEqual([
      expect.objectContaining({
        turnId: 'om_original',
        assistantUuids: [],
        terminalOutcome: {
          status: 'failed',
          errorCode: 'provider_unexpected_eof',
          retryable: true,
        },
      }),
    ]);
  });

  it('treats a bare turn_duration boundary as completed like next-turn-start', () => {
    const q = new BridgeTurnQueue();
    q.mark('om_boundary_only');
    q.ingest([
      user('u-boundary'),
      { type: 'system', subtype: 'turn_duration', uuid: 'duration-only' },
    ]);

    expect(q.drainEmittable({ explicitTerminalOnly: true })).toEqual([
      expect.objectContaining({
        turnId: 'om_boundary_only',
        terminalOutcome: { status: 'completed' },
      }),
    ]);
  });

  it('keeps visible text when stop_reason is null and turn_duration closes the turn', () => {
    const q = new BridgeTurnQueue();
    q.mark('om_null_reason');
    q.ingest([
      user('u-null-reason'),
      {
        type: 'assistant',
        uuid: 'a-null-reason',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Visible successful answer' }],
          stop_reason: null,
        },
      },
      {
        type: 'system',
        subtype: 'stop_hook_summary',
        uuid: 'stop-hook-null-reason',
        preventedContinuation: false,
      } as TranscriptEvent,
      { type: 'system', subtype: 'turn_duration', uuid: 'duration-null-reason' },
    ]);

    expect(q.drainEmittable({ explicitTerminalOnly: true })).toEqual([
      expect.objectContaining({
        turnId: 'om_null_reason',
        assistantUuids: ['a-null-reason'],
        terminalOutcome: { status: 'completed' },
      }),
    ]);
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

  it('releases an empty turn only when the caller supplies a reliable terminal boundary', () => {
    const q = new BridgeTurnQueue();
    q.mark('delivery-key', undefined, 100, undefined, 3);
    q.ingest([user('u-empty')]);

    expect(q.drainEmittable()).toEqual([]);
    expect(q.drainEmittable({ terminalBoundary: true })).toMatchObject([
      { turnId: 'delivery-key', dispatchAttempt: 3, assistantUuids: [] },
    ]);
  });

  it('does not let a stale submit-failure attempt delete a retry with the same turnId', () => {
    const q = new BridgeTurnQueue();
    q.mark('delivery-key', makeFingerprint('durable prompt'), 100, 'durable prompt', 1);
    q.mark('delivery-key', makeFingerprint('durable prompt'), 200, 'durable prompt', 2);

    expect(q.dropPendingTurn('delivery-key', 1)).toEqual(
      expect.objectContaining({ turnId: 'delivery-key', dispatchAttempt: 1 }),
    );
    expect(q.peek()).toEqual([
      expect.objectContaining({ turnId: 'delivery-key', dispatchAttempt: 2 }),
    ]);

    // A second callback from attempt 1 is stale. It must not fall back to
    // turnId-only matching and retire the live retry mark.
    expect(q.dropPendingTurn('delivery-key', 1)).toBeNull();
    expect(q.peek()).toEqual([
      expect.objectContaining({ turnId: 'delivery-key', dispatchAttempt: 2 }),
    ]);

    q.ingest([
      user('u-retry', 'durable prompt'),
      assistant('a-retry', 'retry answer'),
    ]);
    expect(q.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'delivery-key',
        dispatchAttempt: 2,
        assistantUuids: ['a-retry'],
      }),
    ]);
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

  describe('synthetic no-model-reply assistant records', () => {
    // Claude Code bridge-resume placeholder (see isSyntheticNoModelReplyEvent):
    // visible text, terminal stop_reason, isApiErrorMessage:false — every
    // attribute the queue used to read as "the model's final answer", but no
    // model call happened and the Lark message was never answered.
    function metaContinue(uuid: string): TranscriptEvent {
      return {
        type: 'user', uuid, isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] },
      } as TranscriptEvent;
    }
    function syntheticNoReply(uuid: string, model = '<synthetic>'): TranscriptEvent {
      return {
        type: 'assistant', uuid, isApiErrorMessage: false,
        message: { role: 'assistant', model, stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'No response requested.' }] },
      } as TranscriptEvent;
    }

    it('closes the pending Lark turn as a retryable failure instead of attributing the placeholder text', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1'), metaContinue('m1'), syntheticNoReply('s1')]);
      const ready = q.drainEmittable();
      expect(ready.length).toBe(1);
      expect(ready[0].turnId).toBe('t1');
      expect(ready[0].assistantUuids).toEqual([]);
      expect(ready[0].terminalObserved).toBe(true);
      expect(ready[0].terminalOutcome).toEqual({
        status: 'failed', errorCode: 'provider_no_model_reply', retryable: true,
      });
    });

    it('control: the same record served by a real model is the completed reply', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1'), metaContinue('m1'), syntheticNoReply('s1', 'claude-opus-4-8')]);
      const ready = q.drainEmittable();
      expect(ready.length).toBe(1);
      expect(ready[0].assistantUuids).toEqual(['s1']);
      expect(ready[0].terminalOutcome).toEqual({ status: 'completed' });
    });

    it('does not synthesise a headless local turn out of the placeholder', () => {
      const q = new BridgeTurnQueue();
      q.ingest([metaContinue('m1'), syntheticNoReply('s1')]);
      expect(q.size()).toBe(0);
      // control: a real headless reply still gets its local turn
      const q2 = new BridgeTurnQueue();
      q2.ingest([metaContinue('m1'), syntheticNoReply('s1', 'claude-opus-4-8')]);
      expect(q2.size()).toBe(1);
      expect(q2.peek()[0].isLocal).toBe(true);
    });

    // The placeholder is the WEAKEST terminal signal there is: it says "no model
    // call happened". It must never overwrite a stronger outcome the same turn
    // already carries, because worker.ts (`terminalOutcome.status !== 'completed'
    // → continue`) would then withhold the real answer text AND let the daemon
    // post a failure card for a turn that was in fact answered.
    function realReply(uuid: string, text: string): TranscriptEvent {
      return {
        type: 'assistant', uuid, isApiErrorMessage: false,
        message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
      } as TranscriptEvent;
    }
    function apiErrorLine(uuid: string): TranscriptEvent {
      return {
        type: 'assistant', uuid, isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 500,
        message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 500' }] },
      } as TranscriptEvent;
    }

    it('does not downgrade a turn that already completed with a real reply', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1'), realReply('a1', 'the real answer'), syntheticNoReply('s1')]);
      const ready = q.drainEmittable();
      expect(ready.length).toBe(1);
      expect(ready[0].assistantUuids).toEqual(['a1']);
      expect(ready[0].terminalOutcome).toEqual({ status: 'completed' });
    });

    // The API-error arm does NOT share that rule: an error line is authoritative
    // execution metadata, and the `end_turn` before it is, in the connection-lost
    // case, a force-closed half sentence. The error must win so the turn stays
    // `failed` + retryable - the only shape ordinary-turn-recovery acts on
    // (ordinary-turn-recovery.ts: `status !== 'failed' || retryable !== true`
    // → no continuation). Maintainer ruling on PR #1330.
    it('lets an API-error line override an earlier completed outcome (recovery must still fire)', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1'), realReply('a1', 'the real answer'), apiErrorLine('e1')]);
      const ready = q.drainEmittable();
      expect(ready.length).toBe(1);
      expect(ready[0].assistantUuids).toEqual(['a1']);
      expect(ready[0].terminalOutcome).toEqual({
        status: 'failed', errorCode: 'provider_server_error', retryable: true,
      });
    });

    it('still records the failure when the turn has no earlier terminal', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1'), syntheticNoReply('s1')]);
      const ready = q.drainEmittable();
      expect(ready[0].terminalOutcome).toEqual({
        status: 'failed', errorCode: 'provider_no_model_reply', retryable: true,
      });
      expect(ready[0].terminalObserved).toBe(true);
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

  // Truncation-proof bind (codex PR #724): claude-code TRUNCATES the leading
  // envelope lines (`<user_message>` + `<botmux_task …>`) when persisting the
  // user turn, so the head-substring fingerprint never matches. We bind the
  // pending durable mark ONLY when the recorded line is a PROVABLE truncation
  // (its normalised text is a contiguous substring of the mark's full
  // contentNormalized) — capability-agnostic, so an unrelated local terminal
  // turn cannot steal the mark regardless of write-token access.
  describe('isTruncatedMatch (content proof)', () => {
    const full = makeFingerprintFull('<user_message> <botmux_task trusted="true"> Please run the migration and report results </botmux_task> </user_message>');
    it('accepts the surviving tail of the marked content', () => {
      expect(isTruncatedMatch('Please run the migration and report results </botmux_task> </user_message>', full)).toBe(true);
    });
    it('rejects unrelated short local input (pwd / ls)', () => {
      expect(isTruncatedMatch('pwd', full)).toBe(false);
      expect(isTruncatedMatch('ls -la', full)).toBe(false);
    });
    it('rejects when there is no mark content', () => {
      expect(isTruncatedMatch('anything at all here', undefined)).toBe(false);
      expect(isTruncatedMatch('anything at all here', '')).toBe(false);
    });
    it('rejects a too-short recorded line even if it is a substring', () => {
      expect(isTruncatedMatch('run', full)).toBe(false); // below TRUNCATION_MATCH_MIN_CHARS
    });
    it('rejects text that is NOT a substring of the mark', () => {
      expect(isTruncatedMatch('a completely different instruction entirely', full)).toBe(false);
    });
    // codex PR #724 review 4851322948 (P1): an INTERIOR ≥16-char substring must
    // be false. A Web Terminal operator typing a command/phrase that appears in
    // the MIDDLE of the marked task body is not the surviving truncation tail,
    // so it must not prove belonging (the old `includes` accepted these and let
    // the local turn steal the pending durable mark).
    it('rejects an interior command substring (codex repro: run pnpm test --project unit)', () => {
      const marked = makeFingerprintFull('<user_message> <botmux_task trusted="true"> Please investigate the failure; run pnpm test --project unit and report results </botmux_task> </user_message>');
      // Both are ≥16-char substrings that appear INTERIOR to the mark, not as a
      // suffix. The old `includes` accepted them (letting a local turn steal the
      // durable mark); the `endsWith` anchor must reject both.
      expect(isTruncatedMatch('run pnpm test --project unit', marked)).toBe(false);
      expect(isTruncatedMatch('investigate the failure', marked)).toBe(false);
      // Sanity: the genuine surviving tail (a real suffix, ≥16) still proves true.
      expect(isTruncatedMatch('run pnpm test --project unit and report results </botmux_task> </user_message>', marked)).toBe(true);
    });
  });

  describe('truncation-proof bind in the queue (durable mark, mismatched head)', () => {
    it('binds the durable mark when the recorded line is a provable truncation of the marked content', () => {
      const q = new BridgeTurnQueue();
      const marked = '<user_message>\n<botmux_task trusted="true">\nDo the migration and report</botmux_task>\n</user_message>';
      const fp = makeFingerprint(marked);
      const norm = makeFingerprintFull(marked);
      q.mark('t1', fp, 100, norm, 7); // durable trigger with contentNormalized
      // claude persisted only the truncated tail (head envelope dropped):
      q.ingest([user('u1', 'Do the migration and report</botmux_task>\n</user_message>'), assistant('a1', 'CC_DONE')]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].turnId).toBe('t1');
      expect(ready[0].isLocal).toBeFalsy();
      expect(ready[0].dispatchAttempt).toBe(7);
      expect(ready[0].assistantUuids).toEqual(['a1']);
    });

    // codex PR #724 P1: a Web Terminal local turn (capability exists on ANY
    // session, incl. apiOnly/core-only via write-link) must NOT steal the
    // durable mark. The content proof makes this hold WITHOUT keying on session
    // type — `pwd` is not a substring of the marked prompt.
    it('does NOT let an unrelated Web Terminal local turn steal the durable mark', () => {
      const q = new BridgeTurnQueue();
      const marked = 'trusted API prompt: analyse the failing test and propose a fix';
      const fp = makeFingerprint(marked);
      const norm = makeFingerprintFull(marked);
      q.mark('api-trigger', fp, 100, norm, 9);
      // Human typed `pwd` in the Web Terminal while api-trigger was pending:
      q.ingest([user('web-u', 'pwd'), assistant('web-a', '/tmp')]);
      const apiMark = q.peek().find(t => t.turnId === 'api-trigger');
      expect(apiMark?.started).toBe(false); // NOT stolen
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].isLocal).toBe(true);
      expect(ready[0].turnId).not.toBe('api-trigger');
      // The real API user line binds it afterwards.
      q.ingest([user('api-u', 'trusted API prompt: analyse the failing test and propose a fix'), assistant('api-a', 'API reply')]);
      const next = q.drainEmittable();
      expect(next).toHaveLength(1);
      expect(next[0].turnId).toBe('api-trigger');
      expect(next[0].dispatchAttempt).toBe(9);
      expect(next[0].assistantUuids).toEqual(['api-a']);
    });

    // codex PR #724 review 4851322948 (P1): the SHARP repro — an operator types
    // a command that appears verbatim in the MIDDLE of the marked task body.
    // Under the old `includes` this ≥16-char interior substring proved true and
    // stole the pending durable mark. The `endsWith` anchor rejects it (not a
    // suffix), so it synthesises a local turn and the durable mark survives to
    // be bound by its real (truncated-tail) user line.
    it('does NOT let an interior-command local turn steal the durable mark (endsWith anchor)', () => {
      const q = new BridgeTurnQueue();
      const marked = '<user_message>\n<botmux_task trusted="true">\nInvestigate the failure; run pnpm test --project unit and report results</botmux_task>\n</user_message>';
      const fp = makeFingerprint(marked);
      const norm = makeFingerprintFull(marked);
      q.mark('api-trigger', fp, 100, norm, 11);
      // Operator types the exact command that lives INTERIOR to the marked body:
      q.ingest([user('web-u', 'run pnpm test --project unit'), assistant('web-a', 'FAIL: 2 tests')]);
      const apiMark = q.peek().find(t => t.turnId === 'api-trigger');
      expect(apiMark?.started).toBe(false); // interior substring must NOT steal
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].isLocal).toBe(true);
      expect(ready[0].turnId).not.toBe('api-trigger');
      // The real durable turn's truncated tail (a genuine suffix) binds it after.
      q.ingest([user('api-u', 'run pnpm test --project unit and report results</botmux_task>\n</user_message>'), assistant('api-a', 'API reply')]);
      const next = q.drainEmittable();
      expect(next).toHaveLength(1);
      expect(next[0].turnId).toBe('api-trigger');
      expect(next[0].dispatchAttempt).toBe(11);
      expect(next[0].assistantUuids).toEqual(['api-a']);
    });

    it('no truncation proof + no fingerprint match → synth local (not silently dropped)', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1', makeFingerprint('some API prompt'), 100, makeFingerprintFull('some API prompt'));
      q.ingest([user('web-u', 'unrelated local command output here'), assistant('web-a', 'result')]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].isLocal).toBe(true); // emitted, not dropped
      const t1 = q.peek().find(t => t.turnId === 't1');
      expect(t1?.started).toBe(false); // mark untouched
    });
  });

  /**
   * Head-of-line drop must report the turn so the worker can retire its
   * durable journal entry.
   *
   * The bug: `handleTurnStart` spliced a text-less collecting turn out of the
   * queue, so it never reached `drainEmittable` — the ONLY place the worker
   * clears the journal. The entry survived, and every later restart re-marked
   * it and re-drained the transcript from its recorded offset. MEASURED on a
   * live session: one entry restored across six consecutive restarts, twice
   * resurfacing an hours-old provider error as a fresh 「本轮执行失败」card.
   *
   * These assert the REPORTING contract only (the queue is pure — it cannot
   * touch the filesystem). Worker-side wiring is asserted separately.
   */
  describe('head-of-line drop → journal cleanup reporting', () => {
    it('reports a Lark turn dropped head-of-line so its journal entry can be retired', () => {
      const q = new BridgeTurnQueue();
      q.mark('lark-1', makeFingerprint('first message'), 100, makeFingerprintFull('first message'));
      // The turn starts but Claude never writes assistant text for it...
      q.ingest([user('u1', 'first message')]);
      expect(q.peek()[0].started).toBe(true);
      expect(q.takeDroppedNeedingJournalClear()).toEqual([]); // nothing dropped yet
      // ...then a newer turn-start arrives → head-of-line drop.
      q.ingest([user('u2', 'second message')]);
      const dropped = q.takeDroppedNeedingJournalClear();
      expect(dropped.map(t => t.turnId)).toEqual(['lark-1']);
      // The turn really is gone from the queue (this is what made it unreachable).
      expect(q.peek().some(t => t.turnId === 'lark-1')).toBe(false);
    });

    it('is drain-once: a second take returns nothing', () => {
      const q = new BridgeTurnQueue();
      q.mark('lark-1', makeFingerprint('first message'), 100, makeFingerprintFull('first message'));
      q.ingest([user('u1', 'first message')]);
      q.ingest([user('u2', 'second message')]);
      expect(q.takeDroppedNeedingJournalClear()).toHaveLength(1);
      // Without this, the worker would re-clear (harmless) or re-log forever.
      expect(q.takeDroppedNeedingJournalClear()).toEqual([]);
    });

    it('does NOT report synthesised local turns — they never had a journal entry', () => {
      const q = new BridgeTurnQueue();
      // A local turn is synthesised by the queue itself (no Lark mark behind
      // it), so reporting one would make the worker clear an entry it never
      // wrote — and `local-<uuid>` can collide with nothing, so the clear
      // would be a silent no-op that still burns a journal read+write.
      q.ingest([user('local-u1', 'typed in the terminal')]);
      expect(q.peek()[0].isLocal).toBe(true);
      q.ingest([user('local-u2', 'typed again')]);
      expect(q.takeDroppedNeedingJournalClear()).toEqual([]);
    });

    it('does NOT report a turn that produced assistant text (it drains normally)', () => {
      const q = new BridgeTurnQueue();
      q.mark('lark-1', makeFingerprint('first message'), 100, makeFingerprintFull('first message'));
      q.ingest([user('u1', 'first message'), assistant('a1', 'a real answer')]);
      q.ingest([user('u2', 'second message')]);
      // It has text, so it stays queued and the worker retires its journal
      // entry the normal way, at drainEmittable.
      expect(q.takeDroppedNeedingJournalClear()).toEqual([]);
      expect(q.drainEmittable({ terminalBoundary: true }).map(t => t.turnId)).toContain('lark-1');
    });

    it('worker.ts drains the report BEFORE the empty-ready early return', () => {
      // Wiring, not policy: a queue that reports perfectly is inert if nobody
      // drains it. Ordering matters — a head-of-line drop usually lands on a
      // tick that emits nothing, so draining after `if (ready.length === 0)
      // return;` would skip exactly the case this fix exists for.
      const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
      const fn = source.slice(source.indexOf('function emitReadyTurns('));
      const drainAt = fn.indexOf('takeDroppedNeedingJournalClear()');
      const earlyReturnAt = fn.indexOf('if (ready.length === 0) return;');
      expect(drainAt).toBeGreaterThan(-1);
      expect(earlyReturnAt).toBeGreaterThan(-1);
      expect(drainAt).toBeLessThan(earlyReturnAt);
      // ...and it must actually retire the journal entry, not just log.
      expect(fn.slice(drainAt, earlyReturnAt)).toContain('journalBridgeTurnClear(');
    });
  });

  // ── Built-in CronCreate scheduled turns (turnOrigin:"scheduled") ─────────
  describe('built-in scheduled turn fires', () => {
    it('mints a scheduled turn from the isMeta fire record and collects its answer', () => {
      const q = new BridgeTurnQueue();
      q.ingest([scheduledFire('sf1'), assistant('sa1', 'scheduled briefing')]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].turnId).toBe('scheduled-fire-sf1');
      expect(ready[0].isLocal).toBe(true);
      expect(ready[0].isScheduled).toBe(true);
      expect(ready[0].userUuid).toBe('sf1');
      expect(ready[0].assistantUuids).toEqual(['sa1']);
    });

    it('does NOT bind a pending Lark mark to the scheduler prompt', () => {
      const q = new BridgeTurnQueue();
      q.mark('om_1', makeFingerprint('real user question'));
      q.ingest([scheduledFire('sf1'), assistant('sa1', 'scheduled briefing')]);
      const ready = q.drainEmittable();
      // The scheduled turn emits; the Lark mark remains unstarted, still
      // waiting for its real user line.
      expect(ready).toHaveLength(1);
      expect(ready[0].isScheduled).toBe(true);
      const pending = q.peek().find(t => t.turnId === 'om_1');
      expect(pending?.started).toBe(false);
    });

    it('gives an UNKNOWN task no anchor even when a Lark turn (started or unstarted) is latest', () => {
      // Round-3 Must fix: after a worker re-attach the task map is whatever
      // was restored from disk. A fire whose task is NOT in the map — created
      // before this worker ever observed it and absent from the durable store
      // — must NEVER borrow the most recent Lark turn's topic. Borrowing would
      // route the fire into whatever topic happened to be active after the
      // restart (the cross-topic leak). It omits replyTurnId instead and lets
      // the daemon pick its default routing.
      const q = new BridgeTurnQueue();
      q.mark('om_1', makeFingerprint('first question'));
      q.ingest([
        user('u1', 'first question full text'),
        assistant('a1', 'first answer'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      // A newer, still-unstarted mark must not move the anchor either.
      q.mark('om_2', makeFingerprint('second question'));
      // Fire of a task this queue has never seen a CronCreate/ack for.
      q.ingest([scheduledFire('sf1', { taskId: 'ghost-task' }), assistant('sa1', 'scheduled briefing')]);
      const [turn] = q.drainEmittable();
      expect(turn.isScheduled).toBe(true);
      expect(turn.replyAnchorTurnId).toBeUndefined();
    });

    it('anchors a task created inside a Lark turn to THAT turn for every later fire', () => {
      const q = new BridgeTurnQueue();
      // Topic A: user asks something, the turn calls CronCreate, gets the ack.
      q.mark('om_A', makeFingerprint('create a cron please'));
      q.ingest([
        user('uA', 'create a cron please full text'),
        cronCreateCall('block-1'),
        cronCreateAck('block-1', 'jobA'),
        assistant('aA', 'scheduled it'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      // A fire of jobA — even with no recent other activity — anchors to A.
      q.ingest([scheduledFire('sf1', { taskId: 'jobA' }), assistant('sa1', 'jobA result')]);
      let ready = q.drainEmittable({ terminalBoundary: true });
      expect(ready[0].replyAnchorTurnId).toBe('om_A');
    });

    it('keeps the create-time topic when OTHER topics receive messages before a fire', () => {
      const q = new BridgeTurnQueue();
      // Task created inside topic A.
      q.mark('om_A', makeFingerprint('set up cron in A'));
      q.ingest([
        user('uA', 'set up cron in A full text'),
        cronCreateCall('block-1'),
        cronCreateAck('block-1', 'jobA'),
        assistant('aA', 'ok'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      // Later, topic B gets a fully-bound Lark turn.
      q.mark('om_B', makeFingerprint('unrelated question in B'));
      q.ingest([
        user('uB', 'unrelated question in B full text'),
        assistant('aB', 'answer in B'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      // jobA fires: result MUST go to A (the create-time topic), not B.
      q.ingest([scheduledFire('sf1', { taskId: 'jobA' }), assistant('sa1', 'jobA result')]);
      const ready = q.drainEmittable({ terminalBoundary: true });
      expect(ready[0].isScheduled).toBe(true);
      expect(ready[0].replyAnchorTurnId).toBe('om_A');
    });

    it('tracks two tasks independently by scheduledTaskId across interleaved topics', () => {
      const q = new BridgeTurnQueue();
      q.mark('om_A', makeFingerprint('cron alpha'));
      q.ingest([
        user('uA', 'cron alpha full text'),
        cronCreateCall('block-a'),
        cronCreateAck('block-a', 'jobA'),
        assistant('aA', 'a scheduled'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      q.mark('om_B', makeFingerprint('cron beta'));
      q.ingest([
        user('uB', 'cron beta full text'),
        cronCreateCall('block-b'),
        cronCreateAck('block-b', 'jobB'),
        assistant('aB', 'b scheduled'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      // Fire B first, then A; each anchors to its own create-time topic.
      q.ingest([scheduledFire('sfB', { taskId: 'jobB' }), assistant('sB', 'B result')]);
      q.ingest([scheduledFire('sfA', { taskId: 'jobA' }), assistant('sA', 'A result')]);
      const ready = q.drainEmittable({ terminalBoundary: true });
      expect(ready.map(t => t.replyAnchorTurnId)).toEqual(['om_B', 'om_A']);
    });

    it('has no anchor when the task was created before the queue saw any Lark turn', () => {
      const q = new BridgeTurnQueue();
      // CronCreate runs in a local-terminal turn (no Lark turn involved).
      q.ingest([
        user('uL', 'typed locally'),
        cronCreateCall('block-1'),
        cronCreateAck('block-1', 'jobA'),
        assistant('aL', 'scheduled locally'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      q.ingest([scheduledFire('sf1', { taskId: 'jobA' }), assistant('sa1', 'result')]);
      const [turn] = q.drainEmittable({ terminalBoundary: true });
      expect(turn.replyAnchorTurnId).toBeUndefined();
    });

    it('is ignored without scheduledFireId and falls back to normal local handling', () => {
      const q = new BridgeTurnQueue();
      const fake: TranscriptEvent = {
        type: 'user',
        uuid: 'x1',
        isMeta: true,
        turnOrigin: 'scheduled',
        message: { role: 'user', content: 'no fire id' },
      };
      q.ingest([fake, assistant('a1', 'reply')]);
      // Not a scheduled turn; treated as any non-meaningful isMeta record →
      // the assistant becomes a headless local turn.
      const ready = q.drainEmittable();
      expect(ready[0].isScheduled).toBeUndefined();
      expect(ready[0].turnId).toBe('local-headless-a1');
    });

    it('real chronology: system fire marker + user fire + answer + turn_duration, then a bound Lark turn', () => {
      const q = new BridgeTurnQueue();
      q.mark('om_1', makeFingerprint('do the thing'));
      // The system record precedes the isMeta user record in the transcript.
      const sysFire: TranscriptEvent = {
        type: 'system', subtype: 'scheduled_task_fire', uuid: 'sys1',
        cron: '*/30 * * * *',
      } as unknown as TranscriptEvent;
      q.ingest([
        sysFire,
        scheduledFire('sf1', { fireId: 'fire-A' }),
        assistant('sa1', '09:30 进度：无新分'),
        { type: 'system', subtype: 'turn_duration', uuid: 'td1' },
      ]);
      // Worker drains at an idle boundary.
      const ready = q.drainEmittable({ terminalBoundary: true });
      expect(ready).toHaveLength(1);
      expect(ready[0].turnId).toBe('scheduled-fire-A');
      expect(ready[0].assistantUuids).toEqual(['sa1']);
      expect(ready[0].terminalObserved).toBe(true);
      // Pending Lark mark is intact and binds when its real prompt lands.
      q.ingest([user('u1', 'do the thing now'), assistant('a1', 'done')]);
      const next = q.drainEmittable({ terminalBoundary: true });
      expect(next).toHaveLength(1);
      expect(next[0].turnId).toBe('om_1');
      expect(next[0].assistantUuids).toEqual(['a1']);
    });

    it('worker.ts bounds the send window by a STARTED pending turn and skips the pre-text gate for scheduled', () => {
      // Must-fix regression for two of the review findings:
      //  (1) A scheduled turn is inserted AHEAD of an unstarted Lark mark.
      //      Using that mark's early flush-time markTimeMs as the window
      //      upper bound inverts [later, earlier) into an empty range, so the
      //      turn's real final `botmux send` escapes suppression and posts a
      //      duplicate. nextPendingMarkTimeMs must require remaining[0].started
      //      (mirroring the codex bridge).
      //  (2) The pre-text suppression gate must skip scheduled turns, else a
      //      short progress send swallows the later long final before the
      //      transcript text is read.
      const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
      const fn = source.slice(
        source.indexOf('function emitReadyTurns('),
        source.indexOf('function emitReadyCodexTurns('),
      );
      expect(fn).toMatch(
        /remainingPending\.length > 0 && remainingPending\[0\]\.started\s*\n\s*\?\s*remainingPending\[0\]\.markTimeMs/,
      );
      expect(fn).toMatch(/if\s*\(!turn\.isScheduled && turn\.isLocal/);
      // (3) The local-card visibility branch must exclude scheduled turns —
      //     a fire is isLocal but must be rendered/forwarded, not hidden.
      expect(fn).toMatch(/if\s*\(turn\.isLocal && !turn\.isScheduled/);
      // (4) final_output injects the create-time anchor as replyTurnId only
      //     for a scheduled turn outside zero-injection mode, so the daemon
      //     posts it into the task's originating topic.
      expect(fn).toMatch(
        /\.\.\.\(turn\.isScheduled && !zeroPromptTerminalSync\(\) && turn\.replyAnchorTurnId\s*\n\s*\?\s*\{ replyTurnId: turn\.replyAnchorTurnId \}/,
      );
    });

    // ── Round-3 review: ack spoofing + durable-anchor recovery ──────────────

    it('an unrelated tool_result merely CONTAINING a job ack text does not overwrite the anchor', () => {
      // Must fix A: handleCronCreateAcks must pair the ack's tool_use_id with
      // a PENDING CronCreate call. Here task jobA is created and anchored in
      // topic A. Later, in topic B, an unrelated Read tool_result whose text
      // happens to contain "Scheduled recurring job jobA …" must NOT be
      // accepted as jobA's ack (it is not the CronCreate result) and must not
      // clobber jobA's anchor to undefined / reroute it to B.
      const anchored: Array<[string, string | undefined]> = [];
      const q = new BridgeTurnQueue(undefined, (taskId, anchor) => anchored.push([taskId, anchor]));
      q.mark('om_A', makeFingerprint('create cron in A'));
      q.ingest([
        user('uA', 'create cron in A full text'),
        cronCreateCall('cc-A'),
        cronCreateAck('cc-A', 'jobA'),
        assistant('aA', 'scheduled'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      expect(q.scheduledTaskAnchor('jobA')).toBe('om_A');
      const persistsAfterCreate = anchored.length;

      // Topic B: a normal Lark turn runs an unrelated Read whose RESULT text
      // quotes the jobA ack line (e.g. the agent greps its own transcript).
      const spoofRead: TranscriptEvent = {
        type: 'assistant',
        uuid: 'readCall',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: {} }] as any },
      };
      const spoofResult: TranscriptEvent = {
        type: 'user',
        uuid: 'readResult',
        message: { role: 'user', content: [{
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: 'some log excerpt:\nScheduled recurring job jobA (7,37 * * * *). Use CronDelete to cancel sooner.',
        }] as any },
      };
      q.mark('om_B', makeFingerprint('grep logs in B'));
      q.ingest([
        user('uB', 'grep logs in B full text'),
        spoofRead,
        spoofResult,
        assistant('aB', 'found it'),
      ]);
      q.drainEmittable({ terminalBoundary: true });

      // No new anchor event fired for jobA, and its stored anchor is intact.
      expect(anchored.length).toBe(persistsAfterCreate);
      expect(q.scheduledTaskAnchor('jobA')).toBe('om_A');
      // jobA's next fire still routes to A, not B.
      q.ingest([scheduledFire('fire2', { taskId: 'jobA' }), assistant('sa2', 'A update')]);
      const [turn] = q.drainEmittable({ terminalBoundary: true });
      expect(turn.replyAnchorTurnId).toBe('om_A');
    });

    it('a spoofed ack CANNOT register a brand-new task anchor', () => {
      // Defence in depth on Must fix A: without any pending CronCreate call,
      // a tool_result that looks exactly like an ack registers nothing.
      const anchored: Array<[string, string | undefined]> = [];
      const q = new BridgeTurnQueue(undefined, (taskId, anchor) => anchored.push([taskId, anchor]));
      q.ingest([cronCreateAck('never-called-id', 'jobX')]);
      expect(q.scheduledTaskAnchor('jobX')).toBeUndefined();
      expect(anchored).toHaveLength(0);
    });

    it('restored anchors survive a fresh worker queue and are NOT rerouted by later other-topic traffic', () => {
      // Must fix B: simulate worker recovery. The "old worker" observed jobA's
      // CronCreate/ack in topic A; the persisted map is handed to a NEW queue
      // instance (the new worker has no in-memory state). Topic B then sees
      // activity, and jobA's first post-restart fire must still anchor to A.
      const old = new BridgeTurnQueue();
      old.mark('om_A', makeFingerprint('cron in A'));
      old.ingest([
        user('uA', 'cron in A full text'),
        cronCreateCall('cc-A'),
        cronCreateAck('cc-A', 'jobA'),
        assistant('aA', 'ok'),
      ]);
      old.drainEmittable({ terminalBoundary: true });
      expect(old.scheduledTaskAnchor('jobA')).toBe('om_A');

      // The worker would persist jobA→om_A; a brand-new queue restores it.
      const restored = new Map<string, string | undefined>([['jobA', 'om_A']]);
      const fresh = new BridgeTurnQueue();
      fresh.restoreScheduledTaskAnchors(restored);

      // After re-attach, topic B gets a fully-bound turn BEFORE jobA fires.
      fresh.mark('om_B', makeFingerprint('later question in B'));
      fresh.ingest([
        user('uB', 'later question in B full text'),
        assistant('aB', 'answer B'),
      ]);
      fresh.drainEmittable({ terminalBoundary: true });

      fresh.ingest([scheduledFire('f1', { taskId: 'jobA' }), assistant('s1', 'A report')]);
      const [turn] = fresh.drainEmittable({ terminalBoundary: true });
      expect(turn.isScheduled).toBe(true);
      expect(turn.replyAnchorTurnId).toBe('om_A');
    });

    it('a restored null anchor (local-created task) stays unanchored after other-topic traffic', () => {
      // Must fix B corner: a task created from a local-terminal turn is
      // persisted with anchor=null to prove it WAS observed. Recovery must
      // keep it anchorless (daemon default routing), not borrow topic B.
      const fresh = new BridgeTurnQueue();
      fresh.restoreScheduledTaskAnchors(new Map<string, string | undefined>([['jobLocal', undefined]]));
      fresh.mark('om_B', makeFingerprint('some B question'));
      fresh.ingest([
        user('uB', 'some B question full text'),
        assistant('aB', 'answer'),
      ]);
      fresh.drainEmittable({ terminalBoundary: true });
      fresh.ingest([scheduledFire('f1', { taskId: 'jobLocal' }), assistant('s1', 'report')]);
      const [turn] = fresh.drainEmittable({ terminalBoundary: true });
      expect(turn.isScheduled).toBe(true);
      expect(turn.replyAnchorTurnId).toBeUndefined();
    });

    it('a CronCreate issued DURING a scheduled turn inherits that turn’s topic anchor', () => {
      // Anchor propagation across scheduled turns: a re-created task inside a
      // fire of jobA keeps reporting into jobA's create-time topic A.
      const q = new BridgeTurnQueue();
      q.restoreScheduledTaskAnchors(new Map<string, string | undefined>([['jobA', 'om_A']]));
      q.ingest([
        scheduledFire('f1', { taskId: 'jobA' }),
        cronCreateCall('cc-B'),
        cronCreateAck('cc-B', 'jobB'),
        assistant('s1', 'rescheduled as jobB'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      expect(q.scheduledTaskAnchor('jobB')).toBe('om_A');
      q.ingest([scheduledFire('f2', { taskId: 'jobB' }), assistant('s2', 'B→A report')]);
      const [turn] = q.drainEmittable({ terminalBoundary: true });
      expect(turn.replyAnchorTurnId).toBe('om_A');
    });

    it('accepts the one-shot ack phrasing and anchors identically', () => {
      const q = new BridgeTurnQueue();
      q.mark('om_A', makeFingerprint('remind me once'));
      q.ingest([
        user('uA', 'remind me once full text'),
        cronCreateCall('cc-1'),
        cronCreateAck('cc-1', 'jobOne', 'oneshot'),
        assistant('aA', 'will do'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      expect(q.scheduledTaskAnchor('jobOne')).toBe('om_A');
    });

    it('scheduledTaskAnchorsSnapshot exposes the full map with local-created tasks as turnId null', () => {
      // Round-4 daemon pin: the IPC snapshot is the worker's authoritative
      // full state; an undefined anchor (task created in a local turn) must
      // serialize as explicit null so the daemon pins nothing but still knows
      // the task exists (and can drop it on a later absent-task snapshot).
      const q = new BridgeTurnQueue();
      q.ingest([cronCreateCall('cc-loc'), cronCreateAck('cc-loc', 'jobLocal')]);
      q.mark('om_A', makeFingerprint('cron in A'));
      q.ingest([
        user('uA', 'cron in A full text'),
        cronCreateCall('cc-A'),
        cronCreateAck('cc-A', 'jobA'),
        assistant('aA', 'ok'),
      ]);
      q.drainEmittable({ terminalBoundary: true });
      const snap = q.scheduledTaskAnchorsSnapshot()
        .sort((a, b) => a.taskId.localeCompare(b.taskId));
      expect(snap).toEqual([
        { taskId: 'jobA', turnId: 'om_A' },
        { taskId: 'jobLocal', turnId: null },
      ]);
    });

    it('restored anchors appear in the snapshot handed to the daemon after re-attach', () => {
      const q = new BridgeTurnQueue();
      q.restoreScheduledTaskAnchors(new Map<string, string | undefined>([
        ['jobA', 'om_A'],
        ['jobLocal', undefined],
      ]));
      const snap = q.scheduledTaskAnchorsSnapshot()
        .sort((a, b) => a.taskId.localeCompare(b.taskId));
      expect(snap).toEqual([
        { taskId: 'jobA', turnId: 'om_A' },
        { taskId: 'jobLocal', turnId: null },
      ]);
    });
  });
});

// ─── replyDelivery=transcript + solo：裸文本（无 <user_message> 壳）也能按指纹命中 ──
// solo 会话的 PTY 输入是 buildBridgeInputContent 的裸文本 + `[附件]` 行；worker 的
// bridgeMarkPendingTurn 用同一段原文取前 30 字符指纹 + 全文归一化，转写里的 user
// 事件正文就是这段裸文本本身——这里钉住"信封去壳不影响 turn 归属"。
describe('BridgeTurnQueue — bare (solo transcript) input fingerprint', () => {
  function markLike(q: BridgeTurnQueue, turnId: string, text: string): void {
    q.mark(turnId, makeFingerprint(text), Date.now(), makeFingerprintFull(text));
  }

  it('bare text mark matches the identical user event (attachment lines included)', () => {
    const q = new BridgeTurnQueue();
    const bare = '帮我看下这张图\n\n[附件]\n- x.jpg (/tmp/x.jpg)';
    markLike(q, 't1', bare);
    // 与裸文本无关的本地输入不得吃掉这个 pending turn。
    q.ingest([user('local-u', 'ls -la'), assistant('local-a', 'listing')]);
    expect(q.peek().find(t => t.turnId === 't1')?.started).toBe(false);
    q.ingest([user('u1', bare), assistant('a1', '看到了')]);
    const ready = q.drainEmittable();
    const t1 = ready.find(t => t.turnId === 't1');
    expect(t1?.assistantUuids).toEqual(['a1']);
    expect(q.size()).toBe(0);
  });

  it('two different bare texts bind FIFO to their own user events', () => {
    const q = new BridgeTurnQueue();
    const first = '第一条：把 README 翻译成英文';
    const second = '第二条：顺便修一下拼写\n\n[@提及]\n- @Alice';
    markLike(q, 't1', first);
    markLike(q, 't2', second);
    q.ingest([user('u1', first), assistant('a1', 'done 1'), user('u2', second), assistant('a2', 'done 2')]);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t1', 't2']);
    expect(ready[0].assistantUuids).toEqual(['a1']);
    expect(ready[1].assistantUuids).toEqual(['a2']);
  });
});

/** Local helper: full normalised content (what the worker stores as
 *  contentNormalized), distinct from the 30-char makeFingerprint. */
function makeFingerprintFull(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}
