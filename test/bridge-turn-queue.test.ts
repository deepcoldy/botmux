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
import { BridgeTurnQueue, CLI_QUEUE_HOLD_MAX_MS, isHeldInCliQueue, isHeldPendingMark, makeFingerprint, isTruncatedMatch, normaliseForFingerprint, takeAbsorbedReplyCandidates, type BridgePendingTurn } from '../src/services/bridge-turn-queue.js';
import { shouldSuppressBridgeEmit, type BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';
import type { AbsorbedReplyCollector, TranscriptEvent } from '../src/services/claude-transcript.js';

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
/** Model the extra soft-newline backslash Ink leaves before every line break
 * when its paste-burst heuristic fires. Existing backslashes are preserved. */
function withSoftNewlineResidue(content: string): string {
  return content.replace(/\r?\n/g, lineBreak => `\\${lineBreak}`);
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

  it('stamps a failure with the last request the provider answered before it, even from an earlier turn', () => {
    const q = new BridgeTurnQueue();
    const reply = (uuid: string, timestamp: string, extra: Partial<TranscriptEvent> = {}): TranscriptEvent => ({
      type: 'assistant', uuid, timestamp,
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: `reply ${uuid}` }], stop_reason: 'end_turn' },
      ...extra,
    });
    const apiError = (uuid: string, timestamp: string, text: string): TranscriptEvent => ({
      type: 'assistant', uuid, timestamp, isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 503,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }], stop_reason: 'stop_sequence' },
    });
    q.mark('t1');
    q.ingest([user('u1', 'first'), reply('a1', '2026-11-13T11:07:58.000Z'),
      { type: 'system', subtype: 'turn_duration', uuid: 'd1' }]);
    expect(q.drainEmittable({ explicitTerminalOnly: true })).toHaveLength(1);
    q.mark('t2');
    q.ingest([
      user('u2', 'second'),
      // Neither a sub-agent's reply nor a no-model placeholder is an answer
      // from the main conversation's provider.
      reply('side', '2026-11-13T11:08:05.000Z', { isSidechain: true } as Partial<TranscriptEvent>),
      apiError('e2', '2026-11-13T11:08:18.238Z',
        'API Error: 503 no eligible upstream account; the earliest account is expected to be available at 2026-11-13T11:10:16Z.'),
    ]);
    const [failed] = q.drainEmittable({ explicitTerminalOnly: true });
    expect(failed.turnId).toBe('t2');
    expect(failed.terminalOutcome).toEqual({
      status: 'failed', errorCode: 'provider_server_error', retryable: true,
      retryAtMs: Date.parse('2026-11-13T11:10:16Z'),
    });
    expect(failed.terminalProviderLastSuccessAtMs).toBe(Date.parse('2026-11-13T11:07:58.000Z'));
  });

  it('keeps the newest answer when older history is read again, and does not count a no-model placeholder', () => {
    const q = new BridgeTurnQueue();
    const record = (uuid: string, timestamp: string, model: string, text: string): TranscriptEvent => ({
      type: 'assistant', uuid, timestamp,
      message: { role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'stop_sequence' },
    });
    q.mark('t1');
    q.ingest([user('u1', 'first'),
      record('a-new', '2026-11-13T11:07:58.000Z', 'claude-x', 'answer'),
      { type: 'system', subtype: 'turn_duration', uuid: 'd1' }]);
    q.drainEmittable({ explicitTerminalOnly: true });
    q.mark('t2');
    q.ingest([
      user('u2', 'second'),
      // A replayed record from before (journal restore / rotation) is older.
      record('a-old', '2026-11-13T10:00:00.000Z', 'claude-x', 'old answer'),
      // Claude Code's placeholder written without calling the model.
      record('a-syn', '2026-11-13T11:08:10.000Z', '<synthetic>', 'No response requested.'),
      {
        type: 'assistant', uuid: 'e2', timestamp: '2026-11-13T11:08:18.238Z', isApiErrorMessage: true, error: 'server_error',
        message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 503' }], stop_reason: 'stop_sequence' },
      },
      { type: 'system', subtype: 'turn_duration', uuid: 'd2' },
    ]);
    const [failed] = q.drainEmittable({ explicitTerminalOnly: true });
    expect(failed.terminalOutcome?.status).toBe('failed');
    expect(failed.terminalProviderLastSuccessAtMs).toBe(Date.parse('2026-11-13T11:07:58.000Z'));
  });

  it('leaves the last success unknown when no reply was read since the queue started', () => {
    const q = new BridgeTurnQueue();
    q.mark('t1');
    q.ingest([user('u1'), {
      type: 'assistant', uuid: 'e1', timestamp: '2026-11-13T11:08:18.238Z', isApiErrorMessage: true, error: 'server_error',
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 500' }], stop_reason: 'stop_sequence' },
    }]);
    const [failed] = q.drainEmittable({ explicitTerminalOnly: true });
    expect(failed.terminalOutcome?.status).toBe('failed');
    expect(failed.terminalProviderLastSuccessAtMs).toBeUndefined();
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

  it('a turn read in the same batch after another turn\'s duration marker stays its own turn', () => {
    // A rotation switch replays every turn the bridge did not read at once:
    // two background-task wake-ups, then one after a Lark turn.
    const notification = (uuid: string) => user(uuid, `<task-notification>\n<task-id>${uuid}</task-id>\n</task-notification>`);
    const done = (uuid: string): TranscriptEvent => ({ type: 'system', subtype: 'turn_duration', uuid } as TranscriptEvent);
    const q = new BridgeTurnQueue();
    q.mark('t1', makeFingerprint('lark question'));
    q.ingest([
      notification('n1'), assistant('a1', 'first wake-up reply'), done('d1'),
      notification('n2'), assistant('a2', 'second wake-up reply'), done('d2'),
      user('u1', 'lark question'), assistant('a3', 'lark answer'), done('d3'),
      notification('n3'), assistant('a4', 'third wake-up reply'), done('d4'),
    ]);
    const ready = q.drainEmittable({ explicitTerminalOnly: true });
    expect(ready.map(turn => [turn.isLocal === true, turn.assistantUuids])).toEqual([
      [true, ['a1']], [true, ['a2']], [false, ['a3']], [true, ['a4']],
    ]);
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
    /** Claude Code's last record of a turn: a reply's `end_turn` alone is held for it. */
    function turnDurationMarker(uuid: string): TranscriptEvent {
      return { type: 'system', subtype: 'turn_duration', uuid } as TranscriptEvent;
    }
    function syntheticNoReply(uuid: string, model = '<synthetic>', timestamp?: string): TranscriptEvent {
      return {
        type: 'assistant', uuid, timestamp, isApiErrorMessage: false,
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

    it('a failure only the placeholder reports still carries the last answered request', () => {
      const q = new BridgeTurnQueue();
      q.mark('t0');
      q.ingest([user('u0'), {
        type: 'assistant', uuid: 'a0', timestamp: '2026-11-13T11:07:58.000Z',
        message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
      } as TranscriptEvent, turnDurationMarker('d0')]);
      q.drainEmittable({ explicitTerminalOnly: true });
      q.mark('t1');
      q.ingest([user('u1'), metaContinue('m1'), syntheticNoReply('s1', '<synthetic>', '2026-11-13T11:08:01.000Z')]);
      const [failed] = q.drainEmittable();
      expect(failed.terminalOutcome).toEqual({ status: 'failed', errorCode: 'provider_no_model_reply', retryable: true });
      expect(failed.terminalProviderLastSuccessAtMs).toBe(Date.parse('2026-11-13T11:07:58.000Z'));
    });

    it('does not credit a synthetic local tool call as the last answered request', () => {
      const q = new BridgeTurnQueue();
      const lastRealReplyAt = Date.parse('2026-11-24T08:00:10.000Z');
      q.mark('t0');
      q.ingest([user('u0'), {
        type: 'assistant', uuid: 'real-reply', timestamp: '2026-11-24T08:00:10.000Z',
        message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
      } as TranscriptEvent, turnDurationMarker('d0')]);
      q.drainEmittable({ explicitTerminalOnly: true });

      q.mark('t1');
      const attributed: string[] = [];
      q.ingest([user('u1'), {
        type: 'assistant', uuid: 'synthetic-tool', timestamp: '2026-11-24T09:00:00.000Z', isApiErrorMessage: false,
        message: {
          role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
          content: [{ type: 'tool_use', id: 'local-read', name: 'Read', input: { file_path: '/a' } }],
        },
      } as TranscriptEvent, {
        ...apiErrorLine('api-error'), timestamp: '2026-11-24T09:00:10.000Z',
      }, turnDurationMarker('d1')], undefined, ev => attributed.push(ev.uuid!));
      const [failed] = q.drainEmittable({ explicitTerminalOnly: true });
      // Skipping provider-success accounting must not skip ordinary attribution.
      expect(attributed).toContain('synthetic-tool');
      expect(failed.terminalOutcome).toEqual({
        status: 'failed', errorCode: 'provider_server_error', retryable: true,
      });
      expect(failed.terminalProviderLastSuccessAtMs).toBe(lastRealReplyAt);
    });

    it('control: the same record served by a real model is the completed reply', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1'), metaContinue('m1'), syntheticNoReply('s1', 'claude-opus-4-8'), turnDurationMarker('d1')]);
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
      q.ingest([user('u1'), realReply('a1', 'the real answer'), syntheticNoReply('s1'), turnDurationMarker('d1')]);
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
      q.ingest([user('u1'), realReply('a1', 'the real answer'), apiErrorLine('e1'), turnDurationMarker('d1')]);
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

    it('mid-turn absorbed reminder queued_command is filtered and does not split or drop turn', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1');
      q.ingest([user('u1', 'first question'), assistant('a1', 'answering')]);
      const absorbedEvent: any = {
        type: 'attachment',
        uuid: 'q-absorbed',
        timestamp: new Date().toISOString(),
        attachment: {
          type: 'queued_command',
          prompt: '<system-reminder>User sent another message while you were working</system-reminder>',
        },
        renderedRole: 'system',
        rendered: [{ content: '<system-reminder>User sent another message</system-reminder>' }],
      };
      q.ingest([absorbedEvent]);
      const peek = q.peek();
      expect(peek).toHaveLength(1);
      expect(peek[0].turnId).toBe('t1');
      expect(peek[0].assistantUuids).toEqual(['a1']);
    });

    // Real Claude Code 2.1+ shape of a message typed while a turn runs: the
    // attachment carries the full botmux envelope, rendered to the model as a
    // system reminder. No `role:user` line follows it.
    function absorbedQueued(uuid: string, prompt: string, timestamp: string): TranscriptEvent {
      return {
        type: 'attachment',
        uuid,
        timestamp,
        attachment: { type: 'queued_command', prompt, commandMode: 'prompt' },
        renderedRole: 'system',
        rendered: [{ content: `<system-reminder>\nThe user sent a new message while you were working:\n${prompt}\n</system-reminder>` }],
      } as any;
    }

    it('binds a type-ahead mark to its mid-turn absorbed input and ends it with the host turn', () => {
      const started: string[] = [];
      const q = new BridgeTurnQueue(undefined, undefined, (turn, evidence) => {
        started.push(`${turn.turnId}:${evidence.fullContentMatch}`);
      });
      const promptB = '<user_message>用pil 再看一遍</user_message>';
      q.mark('tA', makeFingerprint('进度如何'), 100, normaliseForFingerprint('进度如何'), 1);
      q.mark('tB', makeFingerprint(promptB), 200, normaliseForFingerprint(promptB), 1);
      q.ingest([
        user('uA', '进度如何'),
        assistantToolUse('a-tool'),
        absorbedQueued('q-absorbed', promptB, new Date(5000).toISOString()),
        assistant('a-final', 'both answered'),
        { type: 'system', subtype: 'turn_duration', uuid: 'duration' } as TranscriptEvent,
      ]);

      // Not split: the running turn keeps collecting the reply.
      expect(q.peek().map(t => t.turnId)).toEqual(['tA', 'tB']);
      expect(q.peek()[0].assistantUuids).toEqual(['a-final']);
      expect(q.peek()[1]).toMatchObject({ started: true, absorbedIntoTurnId: 'tA', absorbedAtUuid: 'q-absorbed', assistantUuids: [] });
      expect(started).toEqual(['tA:true', 'tB:true']);

      // A pruning pass cannot expire it any more: it is started.
      expect(q.pruneExpired(0, 10_000_000)).toEqual([]);

      const ready = q.drainEmittable({ explicitTerminalOnly: true });
      expect(ready.map(t => t.turnId)).toEqual(['tA', 'tB']);
      expect(ready[1].terminalObserved).toBe(true);
      expect(ready[1].terminalOutcome).toEqual({ status: 'completed' });
      expect(ready[1].markTimeMs).toBe(5000);
      expect(q.size()).toBe(0);
    });

    it('binds an absorbed residue candidate without granting full-content evidence', () => {
      const started: string[] = [];
      const q = new BridgeTurnQueue(undefined, undefined, (turn, evidence) => {
        started.push(`${turn.turnId}:${evidence.fullContentMatch}`);
      });
      const promptB = '<user_message>echo foo\\\nbar</user_message>';
      q.mark('tA', makeFingerprint('进度如何'), 100, normaliseForFingerprint('进度如何'), 1);
      q.mark('tB', makeFingerprint(promptB), 200, normaliseForFingerprint(promptB), 1);
      q.ingest([
        user('uA', '进度如何'),
        assistantToolUse('a-tool'),
        absorbedQueued('q-absorbed-residue', withSoftNewlineResidue(promptB), new Date(5000).toISOString()),
        assistant('a-final', 'both answered'),
        { type: 'system', subtype: 'turn_duration', uuid: 'duration' } as TranscriptEvent,
      ]);

      expect(q.peek()[1]).toMatchObject({ started: true, absorbedIntoTurnId: 'tA', absorbedAtUuid: 'q-absorbed-residue' });
      expect(started).toEqual(['tA:true', 'tB:false']);
      expect(q.drainEmittable({ explicitTerminalOnly: true }).map(turn => turn.turnId)).toEqual(['tA', 'tB']);
    });

    it('does not chain absorbed residue and legacy matches across different marks', () => {
      const evidence: Array<{ turnId: string; fullContentMatch: boolean }> = [];
      const q = new BridgeTurnQueue(undefined, undefined, (turn, e) => {
        evidence.push({ turnId: turn.turnId, fullContentMatch: e.fullContentMatch });
      });
      const host = 'host turn with distinct content';
      const a = 'echo foo\nbar with enough content to identify the turn';
      const b = 'echo foo\\\nbar with enough content to identify the turn';
      q.mark('host', makeFingerprint(host), 0, normaliseForFingerprint(host));
      q.mark('lark-A', makeFingerprint(a), 1, normaliseForFingerprint(a));
      q.mark('lark-B', makeFingerprint(b), 2, normaliseForFingerprint(b));
      q.ingest([user('host-u', host), assistantToolUse('host-tool')]);
      q.ingest([
        absorbedQueued('local-B', b, new Date(1_000).toISOString()),
        absorbedQueued('real-A', withSoftNewlineResidue(a), new Date(2_000).toISOString()),
        absorbedQueued('real-B', withSoftNewlineResidue(b), new Date(3_000).toISOString()),
      ]);

      expect(q.peek().filter(turn => turn.turnId.startsWith('lark-')).map(turn => [turn.turnId, turn.started]))
        .toEqual([['lark-A', false], ['lark-B', false]]);
      expect(evidence).toEqual([{ turnId: 'host', fullContentMatch: true }]);
    });

    it('flags a folded message for its live reply once, when the model moves on from it', () => {
      const promptB = '<user_message>现在用的是什么模型？</user_message>';
      const collectors = new WeakMap<BridgePendingTurn, AbsorbedReplyCollector>();
      const due: string[] = [];
      const observe = (ev: TranscriptEvent, host: BridgePendingTurn) => {
        for (const turn of takeAbsorbedReplyCandidates(host, ev, collectors)) due.push(turn.turnId);
      };
      const thinking = (uuid: string, text: string): TranscriptEvent => ({
        type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'thinking', thinking: text } as any] },
      });
      const q = new BridgeTurnQueue();
      q.mark('tA', makeFingerprint('跑用例'), 100, normaliseForFingerprint('跑用例'), 1);
      q.mark('tB', makeFingerprint(promptB), 200, normaliseForFingerprint(promptB), 1);
      q.ingest([user('uA', '跑用例'), assistant('a0', 'starting'), assistantToolUse('a-t0'), toolResult('r0')], undefined, observe);
      q.ingest([
        absorbedQueued('q-absorbed', promptB, new Date(5000).toISOString()),
        thinking('a1', ''), assistantToolUse('a-t1'), toolResult('r1'),
        thinking('a2', '用的是 gpt-6-astra。'),
      ], undefined, observe);
      // The answer is written, but the model may still add to it.
      expect(due).toEqual([]);

      q.ingest([assistantToolUse('a-t2'), toolResult('r2'), assistant('a3', 'more work'), assistantToolUse('a-t3')], undefined, observe);
      expect(due).toEqual(['tB']);
      // Flagged once, whatever the worker then finds in the transcript.
      q.ingest([assistant('a-final', 'done'), { type: 'system', subtype: 'turn_duration', uuid: 'duration' } as TranscriptEvent], undefined, observe);
      expect(due).toEqual(['tB']);
    });

    it('does not flag a folded message whose reply is still open when the host turn ends', () => {
      const promptB = '<user_message>顺便问一句</user_message>';
      const collectors = new WeakMap<BridgePendingTurn, AbsorbedReplyCollector>();
      const due: string[] = [];
      const observe = (ev: TranscriptEvent, host: BridgePendingTurn) => {
        for (const turn of takeAbsorbedReplyCandidates(host, ev, collectors)) due.push(turn.turnId);
      };
      const q = new BridgeTurnQueue();
      q.mark('tA', makeFingerprint('跑用例'), 100, normaliseForFingerprint('跑用例'), 1);
      q.mark('tB', makeFingerprint(promptB), 200, normaliseForFingerprint(promptB), 1);
      q.ingest([
        user('uA', '跑用例'), assistantToolUse('a-t0'),
        absorbedQueued('q-absorbed', promptB, new Date(5000).toISOString()),
        assistant('a-final', 'answer and summary in one closing message'),
        { type: 'system', subtype: 'turn_duration', uuid: 'duration' } as TranscriptEvent,
      ], undefined, observe);
      expect(due).toEqual([]);
      const ready = q.drainEmittable({ explicitTerminalOnly: true });
      expect(ready.map(t => t.turnId)).toEqual(['tA', 'tB']);
    });

    it('a folded turn already answered settles as completed even when its host then fails', () => {
      const q = new BridgeTurnQueue();
      const promptB = 'quick question while busy';
      const promptC = 'another one while busy';
      q.mark('tA', makeFingerprint('first request'), 100, normaliseForFingerprint('first request'), 1);
      q.mark('tB', makeFingerprint(promptB), 200, normaliseForFingerprint(promptB), 1);
      q.mark('tC', makeFingerprint(promptC), 300, normaliseForFingerprint(promptC), 1);
      q.ingest([
        user('uA', 'first request'), assistantToolUse('a-t0'),
        absorbedQueued('q-b', promptB, new Date(5000).toISOString()),
        absorbedQueued('q-c', promptC, new Date(6000).toISOString()),
      ]);
      q.peek().find(t => t.turnId === 'tB')!.absorbedReplySent = true;
      q.ingest([
        { ...assistant('err', 'API Error: 500 {"error":{"type":"api_error"}}'), isApiErrorMessage: true } as TranscriptEvent,
        { type: 'system', subtype: 'turn_duration', uuid: 'duration' } as TranscriptEvent,
      ]);
      const ready = q.drainEmittable({ explicitTerminalOnly: true });
      const outcome = (id: string) => ready.find(t => t.turnId === id)!.terminalOutcome?.status;
      expect(outcome('tA')).not.toBe('completed');
      expect(outcome('tB')).toBe('completed');
      expect(outcome('tC')).toBe(outcome('tA'));
    });

    it('an API error that ends the host turn keeps its text, and the absorbed turn ends with the same error', () => {
      const q = new BridgeTurnQueue();
      const promptB = 'second request while busy';
      const text = 'API Error: 403 {"error":{"type":"permission_error","message":"Access denied for model x"}}';
      q.mark('tA', makeFingerprint('first request'), 100, normaliseForFingerprint('first request'), 1);
      q.mark('tB', makeFingerprint(promptB), 200, normaliseForFingerprint(promptB), 1);
      q.ingest([
        user('uA', 'first request'),
        assistantToolUse('a-tool'),
        absorbedQueued('q-absorbed', promptB, new Date(5000).toISOString()),
        {
          type: 'assistant', uuid: 'a-403', isApiErrorMessage: true, error: 'authentication_failed', apiErrorStatus: 403,
          message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
        } as TranscriptEvent,
        { type: 'system', subtype: 'turn_duration', uuid: 'duration' } as TranscriptEvent,
      ]);
      const ready = q.drainEmittable({ explicitTerminalOnly: true });
      expect(ready.map(t => [t.turnId, t.terminalOutcome?.status, t.terminalErrorDetail])).toEqual([
        ['tA', 'failed', text],
        ['tB', 'failed', text],
      ]);
    });

    it('the absorbed turn that fails with its host also carries the last answered request', () => {
      const q = new BridgeTurnQueue();
      const promptB = 'second request while busy';
      q.mark('tA', makeFingerprint('first request'), 100, normaliseForFingerprint('first request'), 1);
      q.mark('tB', makeFingerprint(promptB), 200, normaliseForFingerprint(promptB), 1);
      q.ingest([
        user('uA', 'first request'),
        { ...assistantToolUse('a-tool'), timestamp: '2026-11-13T11:07:58.000Z' } as TranscriptEvent,
        absorbedQueued('q-absorbed', promptB, new Date(5000).toISOString()),
        {
          type: 'assistant', uuid: 'a-503', timestamp: '2026-11-13T11:08:18.000Z', isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 503,
          message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 503' }] },
        } as TranscriptEvent,
        { type: 'system', subtype: 'turn_duration', uuid: 'duration' } as TranscriptEvent,
      ]);
      const ready = q.drainEmittable({ explicitTerminalOnly: true });
      expect(ready.map(t => [t.turnId, t.terminalOutcome?.status, t.terminalProviderLastSuccessAtMs])).toEqual([
        ['tA', 'failed', Date.parse('2026-11-13T11:07:58.000Z')],
        ['tB', 'failed', Date.parse('2026-11-13T11:07:58.000Z')],
      ]);
    });

    it('a completed turn carries no error text', () => {
      const q = new BridgeTurnQueue();
      q.mark('tA', makeFingerprint('hi'), 100, normaliseForFingerprint('hi'), 1);
      q.ingest([user('uA', 'hi'), assistant('a-final', 'hello'),
        { type: 'system', subtype: 'turn_duration', uuid: 'duration' } as TranscriptEvent]);
      const [turn] = q.drainEmittable({ explicitTerminalOnly: true });
      expect(turn).toMatchObject({ turnId: 'tA', terminalOutcome: { status: 'completed' } });
      expect(turn!.terminalErrorDetail).toBeUndefined();
    });

    it('absorbed input stays queued until its host turn closes', () => {
      const q = new BridgeTurnQueue();
      const promptB = 'second request while busy';
      q.mark('tA', makeFingerprint('first request'), 100, normaliseForFingerprint('first request'), 1);
      q.mark('tB', makeFingerprint(promptB), 200, normaliseForFingerprint(promptB), 1);
      q.ingest([
        user('uA', 'first request'),
        assistantToolUse('a-tool'),
        absorbedQueued('q-absorbed', promptB, new Date(5000).toISOString()),
      ]);
      expect(q.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
      expect(q.drainEmittable({ terminalBoundary: true, requireExplicitTerminalForDurable: true })).toEqual([]);
    });

    it('an absorbed reminder that matches no pending mark changes nothing', () => {
      const q = new BridgeTurnQueue();
      q.mark('tA', makeFingerprint('first request'));
      q.mark('tB', makeFingerprint('unrelated pending prompt'));
      q.ingest([
        user('uA', 'first request'),
        assistant('a1', 'working'),
        absorbedQueued('q-absorbed', 'typed directly in the terminal', new Date(5000).toISOString()),
      ]);
      expect(q.peek().map(t => [t.turnId, t.started])).toEqual([['tA', true], ['tB', false]]);
      expect(q.peek()[0].absorbedTurns).toBeUndefined();
    });

    it('with nothing collecting, the absorbed input collects the rest of the turn', () => {
      const q = new BridgeTurnQueue();
      const promptB = 'follow-up after a worker restart';
      q.mark('tB', makeFingerprint(promptB), 200, normaliseForFingerprint(promptB), 1);
      q.ingest([
        absorbedQueued('q-absorbed', promptB, new Date(5000).toISOString()),
        assistant('a-final', 'answer'),
        { type: 'system', subtype: 'turn_duration', uuid: 'duration' } as TranscriptEvent,
      ]);
      const ready = q.drainEmittable({ explicitTerminalOnly: true });
      expect(ready.map(t => t.turnId)).toEqual(['tB']);
      expect(ready[0].assistantUuids).toEqual(['a-final']);
      expect(ready[0].absorbedIntoTurnId).toBeUndefined();
    });

    it('protects turn with assistant activity from HOL drop even without visible text', () => {
      const q = new BridgeTurnQueue();
      q.mark('t1', makeFingerprint('task 1'));
      const toolUseEv: any = {
        type: 'assistant',
        uuid: 'a-tool',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'botmux_send', input: {} }],
        },
      };
      q.ingest([user('u1', 'task 1'), toolUseEv]);
      expect(q.peek()[0].hasAssistantActivity).toBe(true);
      expect(q.peek()[0].assistantUuids).toHaveLength(0);

      q.mark('t2', makeFingerprint('task 2'));
      q.ingest([user('u2', 'task 2')]);

      const emittable = q.drainEmittable();
      expect(emittable).toHaveLength(1);
      expect(emittable[0].turnId).toBe('t1');
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

  describe('soft-newline backslash left in the recorded user line', () => {
    const sentWith = (genuineBackslashes: number, firstBreak = '\n'): string =>
      '<summary_memory>' + '\\'.repeat(genuineBackslashes) + firstBreak
      + '配置的记忆文件路径是 summary.md。\n</summary_memory>\n<user_message>\n可以提交 PR 吗\n</user_message>';
    function marked(sent: string, evidence: boolean[]): BridgeTurnQueue {
      const q = new BridgeTurnQueue(undefined, undefined, (_turn, e) => evidence.push(e.fullContentMatch));
      q.mark('lark-1', makeFingerprint(sent), 100, makeFingerprintFull(sent));
      return q;
    }

    // Claude Code input is typed as `\` + Enter per newline. When Ink takes
    // the burst for a paste, one extra backslash is recorded per line break.
    it('binds the Lark mark without upgrading a residue-only match to full-content evidence', () => {
      const evidence: boolean[] = [];
      const q = marked(sentWith(0), evidence);
      q.ingest([user('u1', withSoftNewlineResidue(sentWith(0))), assistant('a1', 'reply')]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].turnId).toBe('lark-1');
      expect(ready[0].isLocal).toBeFalsy();
      expect(ready[0].assistantUuids).toEqual(['a1']);
      expect(evidence).toEqual([false]);
    });

    it.each([1, 2])('binds when the mark has %i genuine backslash(es) and the recording has one more', genuine => {
      const evidence: boolean[] = [];
      const sent = sentWith(genuine);
      const q = marked(sent, evidence);
      q.ingest([user('u1', withSoftNewlineResidue(sent)), assistant('a1', 'reply')]);
      expect(q.drainEmittable().map(turn => turn.turnId)).toEqual(['lark-1']);
      expect(evidence).toEqual([false]);
    });

    it('binds a genuine backslash plus residue before CRLF', () => {
      const evidence: boolean[] = [];
      const sent = sentWith(1, '\r\n');
      const q = marked(sent, evidence);
      q.ingest([user('u1', withSoftNewlineResidue(sent)), assistant('a1', 'reply')]);
      expect(q.drainEmittable().map(turn => turn.turnId)).toEqual(['lark-1']);
      expect(evidence).toEqual([false]);
    });

    it('keeps legacy full-content evidence for a genuine backslash with no residue', () => {
      const evidence: boolean[] = [];
      const sent = sentWith(1);
      const q = marked(sent, evidence);
      q.ingest([user('u1', sent), assistant('a1', 'reply')]);
      expect(q.drainEmittable().map(turn => turn.turnId)).toEqual(['lark-1']);
      expect(evidence).toEqual([true]);
    });

    it('does not let a different input missing the genuine backslash steal the mark', () => {
      const evidence: boolean[] = [];
      const sent = sentWith(1);
      const q = marked(sent, evidence);
      q.ingest([user('local-u', sentWith(0)), assistant('local-a', 'local reply')]);
      expect(q.drainEmittable().map(turn => turn.turnId)).toEqual(['local-local-u']);
      expect(q.peek().find(turn => turn.turnId === 'lark-1')?.started).toBe(false);
      expect(evidence).toEqual([]);

      q.ingest([user('real-u', withSoftNewlineResidue(sent)), assistant('real-a', 'Lark reply')]);
      expect(q.drainEmittable().map(turn => turn.turnId)).toEqual(['lark-1']);
      expect(evidence).toEqual([false]);
    });

    it('keeps literal backslashes significant in legacy mark identity', () => {
      expect(normaliseForFingerprint('a\\b\nc')).toBe('a\\b c');
      expect(normaliseForFingerprint('a\\\nb')).not.toBe(normaliseForFingerprint('a\nb'));
    });
  });

  describe('soft-newline cross-mark ambiguity', () => {
    const sent = (backslashes: number) => `echo foo${'\\'.repeat(backslashes)}\nbar with enough content to identify the turn`;

    it('fails closed instead of chaining residue and legacy matches across different marks', () => {
      const evidence: Array<{ turnId: string; fullContentMatch: boolean }> = [];
      const q = new BridgeTurnQueue(undefined, undefined, (turn, e) => {
        evidence.push({ turnId: turn.turnId, fullContentMatch: e.fullContentMatch });
      });
      const a = sent(0);
      const b = sent(1);
      q.mark('lark-A', makeFingerprint(a), 1_000, normaliseForFingerprint(a));
      q.mark('lark-B', makeFingerprint(b), 2_000, normaliseForFingerprint(b));

      q.ingest([
        user('local-human', b), assistant('assistant-local', 'local answer'),
        user('real-A', withSoftNewlineResidue(a)), assistant('assistant-A', 'answer A'),
        user('real-B', withSoftNewlineResidue(b)), assistant('assistant-B', 'answer B'),
      ]);

      expect(q.drainEmittable().map(turn => turn.turnId)).toEqual([
        'local-local-human', 'local-real-A', 'local-real-B',
      ]);
      expect(evidence).toEqual([]);
      expect(q.peek().filter(turn => !turn.isLocal).map(turn => [turn.turnId, turn.started]))
        .toEqual([['lark-A', false], ['lark-B', false]]);
    });

    it('keeps identical marks in FIFO order when their records carry residue', () => {
      const evidence: boolean[] = [];
      const q = new BridgeTurnQueue(undefined, undefined, (_turn, e) => evidence.push(e.fullContentMatch));
      const content = sent(0);
      q.mark('lark-A', makeFingerprint(content), 1_000, normaliseForFingerprint(content));
      q.mark('lark-B', makeFingerprint(content), 2_000, normaliseForFingerprint(content));
      q.ingest([
        user('real-A', withSoftNewlineResidue(content)), assistant('assistant-A', 'answer A'),
        user('real-B', withSoftNewlineResidue(content)), assistant('assistant-B', 'answer B'),
      ]);
      const ready = q.drainEmittable();
      expect(ready.map(turn => turn.turnId)).toEqual(['lark-A', 'lark-B']);
      expect(ready.map(turn => turn.assistantUuids)).toEqual([['assistant-A'], ['assistant-B']]);
      expect(evidence).toEqual([false, false]);
    });
  });

  describe('truncation-proof bind in the queue (durable mark, mismatched head)', () => {
    it('accepts a residue-bearing truncation candidate without granting full-content evidence', () => {
      const evidence: boolean[] = [];
      const q = new BridgeTurnQueue(undefined, undefined, (_turn, e) => evidence.push(e.fullContentMatch));
      const marked = '<user_message>\n<botmux_task trusted="true">\necho foo\\\nbar with enough content</botmux_task>\n</user_message>';
      const truncated = 'echo foo\\\nbar with enough content</botmux_task>\n</user_message>';
      q.mark('t1', makeFingerprint(marked), 100, makeFingerprintFull(marked), 7);
      q.ingest([user('u1', withSoftNewlineResidue(truncated)), assistant('a1', 'reply')]);
      expect(q.drainEmittable().map(turn => turn.turnId)).toEqual(['t1']);
      expect(evidence).toEqual([false]);
    });

    it('rejects a truncation candidate missing the mark\'s genuine backslash', () => {
      const q = new BridgeTurnQueue();
      const marked = '<user_message>\n<botmux_task trusted="true">\necho foo\\\nbar with enough content</botmux_task>\n</user_message>';
      const different = 'echo foo\nbar with enough content</botmux_task>\n</user_message>';
      q.mark('t1', makeFingerprint(marked), 100, makeFingerprintFull(marked), 7);
      q.ingest([user('u1', different), assistant('a1', 'reply')]);
      expect(q.drainEmittable().map(turn => turn.turnId)).toEqual(['local-u1']);
      expect(q.peek().find(turn => turn.turnId === 't1')?.started).toBe(false);
    });

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

    // 源码结构护栏(K3)：emitReadyTurns 在 worker.ts 闭包里、没有行为 seam；一次 head-of-line drop
    // 通常落在什么都不 emit 的 tick 上，若排空放到「ready 为空就 return」之后，journal 条目永不退役，
    // 每次重启都重放旧 provider 错误成新的「本轮执行失败」卡（#1170，线上实测六次重启两次重放）。
    // 只钉不变量：排空 + journalBridgeTurnClear 先于空 ready 的提前返回。
    it('worker retires dropped turns\' journal entries before the empty-ready early return', () => {
      const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
      const fn = source.slice(source.indexOf('function emitReadyTurns('));
      const drainAt = fn.indexOf('takeDroppedNeedingJournalClear()');
      const earlyReturnAt = fn.search(/if\s*\(\s*ready\.length\s*===\s*0\s*\)\s*return\b/);
      expect(drainAt).toBeGreaterThan(-1);
      expect(earlyReturnAt).toBeGreaterThan(-1);
      expect(drainAt).toBeLessThan(earlyReturnAt);
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
  return normaliseForFingerprint(message);
}

// ── Native consumption evidence for shared group background ───────────────────
// Only a transcript record whose normalised text contains the WHOLE marked
// content proves that the dispatched input (envelope included) entered the
// conversation. Fingerprint-prefix and truncation binds still attribute the
// reply but must not be reported as consumption evidence.
describe('onLarkTurnStarted evidence', () => {
  const marked = '<shared_group_context>history</shared_group_context>\n<user_message>看一下图库</user_message>';
  function queueWith(record: (turn: { turnId: string }, evidence: { fullContentMatch: boolean; sourceJsonlPath?: string }) => void) {
    return new BridgeTurnQueue(undefined, undefined, record);
  }

  it('reports a full-content match with the source transcript path', () => {
    const seen: unknown[] = [];
    const q = queueWith((turn, evidence) => seen.push([turn.turnId, evidence]));
    q.mark('om_turn', makeFingerprint(marked), Date.now(), normaliseForFingerprint(marked));
    q.ingest([user('u1', marked)], '/claude/projects/x/abcd-session.jsonl');
    expect(seen).toEqual([['om_turn', {
      fullContentMatch: true,
      exactContentMatch: true,
      sourceJsonlPath: '/claude/projects/x/abcd-session.jsonl',
    }]]);
  });

  it('reports fingerprint-only and truncated binds as non-proof', () => {
    const seen: boolean[] = [];
    const q = queueWith((_turn, evidence) => seen.push(evidence.fullContentMatch));
    q.mark('om_prefix', makeFingerprint(marked), Date.now(), normaliseForFingerprint(marked));
    // Same 30-char head, different tail: attribution heuristic, not proof.
    q.ingest([user('u1', '<shared_group_context>history</shared_group_context>\n<user_message>看一下别的</user_message>')]);
    q.mark('om_truncated', makeFingerprint(marked), Date.now(), normaliseForFingerprint(marked));
    // Claude persisted only the surviving tail of the envelope.
    q.ingest([assistant('a1', 'reply'), user('u2', '<user_message>看一下图库</user_message>')]);
    expect(seen).toEqual([false, false]);
  });

  it('does not report local or legacy unfingerprinted turns as full matches', () => {
    const seen: boolean[] = [];
    const q = queueWith((_turn, evidence) => seen.push(evidence.fullContentMatch));
    q.ingest([user('local', 'pwd')]);
    q.mark('om_legacy');
    q.ingest([user('u1', marked)]);
    expect(seen).toEqual([false]);
  });
});

describe('input held in Claude\'s own queue', () => {
  const TTL = 120_000;
  const markAt = Date.parse('2026-10-31T12:20:38.866Z');
  const iso = (offsetMs: number) => new Date(markAt + offsetMs).toISOString();
  const text = '<botmux_reminder>r</botmux_reminder> <user_message>do it in parallel</user_message>';
  const queueOp = (operation: string, offsetMs: number, content?: string, reason?: string, extra?: Record<string, unknown>) => ({
    type: 'queue-operation', operation, timestamp: iso(offsetMs),
    ...(content === undefined ? {} : { content }), ...(reason ? { reason } : {}), ...extra,
  }) as unknown as TranscriptEvent;
  const absorbed = (uuid: string, prompt: string, offsetMs: number) => ({
    type: 'attachment', uuid, timestamp: iso(offsetMs),
    attachment: { type: 'queued_command', prompt, commandMode: 'prompt' },
    renderedRole: 'system',
    rendered: [{ content: `<system-reminder>${prompt}</system-reminder>` }],
  }) as unknown as TranscriptEvent;
  function marked(content = text, turnId = 't1', atMs = markAt): BridgeTurnQueue {
    const q = new BridgeTurnQueue();
    q.mark(turnId, makeFingerprint(content), atMs, normaliseForFingerprint(content));
    return q;
  }

  it('keeps the mark past the TTL and binds it when Claude absorbs the input mid-turn', () => {
    const started: string[] = [];
    const q = new BridgeTurnQueue(undefined, undefined, turn => { started.push(turn.turnId); });
    q.mark('t1', makeFingerprint(text), markAt, normaliseForFingerprint(text));
    q.ingest([queueOp('enqueue', 3_500, text)]);
    expect(q.pruneExpired(TTL, markAt + TTL + 1)).toEqual([]);
    q.ingest([
      queueOp('remove', 137_400, text, 'absorbed_mid_turn'),
      absorbed('q1', text, 3_000),
    ]);
    expect(started).toEqual(['t1']);
  });

  it('holds and releases a mark whose queue records carry soft-newline residue', () => {
    const sent = '<user_message>echo foo\\\nbar with enough content</user_message>';
    const recorded = withSoftNewlineResidue(sent);
    const q = marked(sent);
    q.ingest([queueOp('enqueue', 1_000, recorded)]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(true);
    // Enqueue carried the residue; remove did not. Their candidate sets still
    // describe the same input, so the mirror must not strand the held mark.
    q.ingest([queueOp('remove', 2_000, sent, 'cancelled')]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
  });

  it('keeps both marks held when a remove has exact and residue-only interpretations', () => {
    const first = '<user_message>echo foo\nbar with enough content</user_message>';
    const second = '<user_message>echo foo\\\nbar with enough content</user_message>';
    const q = marked(first, 'tA');
    q.mark('tB', makeFingerprint(second), markAt, normaliseForFingerprint(second));
    q.ingest([
      queueOp('enqueue', 1_000, first),
      queueOp('enqueue', 1_500, second),
    ]);
    expect(q.peek().map(isHeldInCliQueue)).toEqual([true, true]);

    q.ingest([queueOp('remove', 2_000, second, 'cancelled')]);
    // The remove is exact for the second item but residue-compatible with the
    // first. With no unique identity proof, releasing either mark is unsafe.
    expect(q.peek().map(isHeldInCliQueue)).toEqual([true, true]);
  });

  it('does not hold competing marks for ambiguous enqueues', () => {
    const a = 'echo foo\nbar with enough content to identify the turn';
    const b = 'echo foo\\\nbar with enough content to identify the turn';
    const q = marked(a, 'lark-A');
    q.mark('lark-B', makeFingerprint(b), markAt + 1, normaliseForFingerprint(b));
    q.ingest([queueOp('enqueue', 1_000, b)]);
    expect(q.peek().map(isHeldInCliQueue)).toEqual([false, false]);
    q.ingest([queueOp('enqueue', 2_000, withSoftNewlineResidue(a))]);
    expect(q.peek().map(isHeldInCliQueue)).toEqual([false, false]);
    q.ingest([queueOp('enqueue', 3_000, withSoftNewlineResidue(b))]);
    expect(q.peek().map(isHeldInCliQueue)).toEqual([false, true]);
  });

  it('keeps ambiguous enqueue competitors together through TTL and expires them as a group', () => {
    const a = 'echo foo\nbar with enough content to identify the turn';
    const b = 'echo foo\\\nbar with enough content to identify the turn';
    const evidence: Array<{ turnId: string; fullContentMatch: boolean }> = [];
    const q = new BridgeTurnQueue(undefined, undefined, (turn, e) => {
      if (turn.turnId !== 'host') evidence.push({ turnId: turn.turnId, fullContentMatch: e.fullContentMatch });
    });
    const host = 'host turn with distinct content';
    q.mark('host', makeFingerprint(host), markAt - 1_000, normaliseForFingerprint(host));
    q.mark('lark-A', makeFingerprint(a), markAt, normaliseForFingerprint(a), 1);
    q.mark('lark-B', makeFingerprint(b), markAt + 1, normaliseForFingerprint(b), 1);
    q.ingest([user('host-u', host, iso(-1_000)), assistantToolUse('host-tool')]);
    q.ingest([
      queueOp('enqueue', 1_000, withSoftNewlineResidue(a)),
      queueOp('enqueue', 2_000, withSoftNewlineResidue(b)),
      { type: 'system', subtype: 'turn_duration', uuid: 'host-duration', timestamp: iso(3_000) } as TranscriptEvent,
    ]);

    // The host has closed, so the generic busy exemption cannot protect A.
    // The conflict group must keep both competitors; B's own queue hold is
    // not a resolution and must not let A expire alone.
    expect(q.pruneExpired(TTL, markAt + TTL + 1)).toEqual([]);
    q.ingest([
      user('real-A', withSoftNewlineResidue(a), iso(121_000)),
      assistant('assistant-A', 'answer A'),
      user('real-B', withSoftNewlineResidue(b), iso(122_000)),
      assistant('assistant-B', 'answer B'),
    ]);
    expect(q.drainEmittable().filter(turn => turn.turnId.startsWith('lark-'))).toEqual([]);
    expect(evidence).toEqual([]);

    // Once the shared hold bound is reached, no competitor remains behind to
    // accept a late line as legacy full-content proof.
    expect(q.pruneExpired(TTL, markAt + CLI_QUEUE_HOLD_MAX_MS + 2_000).map(turn => turn.turnId))
      .toEqual(['lark-A', 'lark-B']);
  });

  it('expires a conflict group atomically when a member is write-held', () => {
    const a = 'echo foo\nbar with enough content to identify the turn';
    const b = 'echo foo\\\nbar with enough content to identify the turn';
    const evidence: Array<{ turnId: string; fullContentMatch: boolean }> = [];
    const q = new BridgeTurnQueue(undefined, undefined, (turn, e) => {
      evidence.push({ turnId: turn.turnId, fullContentMatch: e.fullContentMatch });
    });
    q.mark('lark-A', makeFingerprint(a), markAt, normaliseForFingerprint(a), 1);
    q.mark('lark-B', makeFingerprint(b), markAt + 1, normaliseForFingerprint(b), 1);
    q.ingest([
      queueOp('enqueue', 1_000, withSoftNewlineResidue(a)),
      queueOp('enqueue', 2_000, withSoftNewlineResidue(b)),
    ]);
    q.holdForWrite('lark-B', 1);

    const at = markAt + 1_000 + CLI_QUEUE_HOLD_MAX_MS + 1;
    expect(q.pruneExpired(TTL, at).map(turn => turn.turnId)).toEqual(['lark-A', 'lark-B']);
    q.releaseWriteHold('lark-B', 1, at + 1);
    q.ingest([
      user('late-real-A', withSoftNewlineResidue(a), iso(CLI_QUEUE_HOLD_MAX_MS + 2_000)),
      assistant('assistant-A', 'answer A'),
      user('real-B', withSoftNewlineResidue(b), iso(CLI_QUEUE_HOLD_MAX_MS + 3_000)),
      assistant('assistant-B', 'answer B'),
    ]);
    expect(q.drainEmittable().filter(turn => turn.turnId.startsWith('lark-'))).toEqual([]);
    expect(evidence).toEqual([]);
  });

  it('keeps a dropped member as conflict evidence for late lines', () => {
    const a = 'echo foo\nbar with enough content to identify the turn';
    const b = 'echo foo\\\nbar with enough content to identify the turn';
    const evidence: Array<{ turnId: string; fullContentMatch: boolean }> = [];
    const q = new BridgeTurnQueue(undefined, undefined, (turn, e) => {
      evidence.push({ turnId: turn.turnId, fullContentMatch: e.fullContentMatch });
    });
    q.mark('lark-A', makeFingerprint(a), markAt, normaliseForFingerprint(a), 1);
    q.mark('lark-B', makeFingerprint(b), markAt + 1, normaliseForFingerprint(b), 1);
    q.ingest([
      queueOp('enqueue', 1_000, withSoftNewlineResidue(a)),
      queueOp('enqueue', 2_000, withSoftNewlineResidue(b)),
    ]);
    expect(q.dropPendingTurn('lark-A', 1)?.turnId).toBe('lark-A');

    // Cancelling A does not prove that A's record will never arrive. Its
    // tombstone must still prevent B from accepting that late line as its own.
    q.ingest([
      user('late-real-A', withSoftNewlineResidue(a), iso(121_000)),
      assistant('assistant-A', 'answer A'),
      user('real-B', withSoftNewlineResidue(b), iso(122_000)),
      assistant('assistant-B', 'answer B'),
    ]);
    const ready = q.drainEmittable();
    expect(ready.map(turn => turn.turnId)).toEqual(['local-late-real-A', 'lark-B']);
    expect(evidence).toEqual([{ turnId: 'lark-B', fullContentMatch: false }]);
    expect(q.pruneExpired(TTL, markAt + CLI_QUEUE_HOLD_MAX_MS + 2_000)).toEqual([]);
  });

  it('does not reuse tombstones after every active member is cancelled', () => {
    const a = 'echo foo\nbar with enough content to identify the turn';
    const b = 'echo foo\\\nbar with enough content to identify the turn';
    const q = new BridgeTurnQueue();
    q.mark('old-A', makeFingerprint(a), markAt, normaliseForFingerprint(a), 1);
    q.mark('old-B', makeFingerprint(b), markAt + 1, normaliseForFingerprint(b), 1);
    q.ingest([queueOp('enqueue', 1_000, withSoftNewlineResidue(a))]);
    q.dropPendingTurn('old-A', 1);
    q.dropPendingTurn('old-B', 1);

    q.mark('new-B', makeFingerprint(b), markAt + 10_000, normaliseForFingerprint(b), 1);
    q.mark('new-A', makeFingerprint(a), markAt + 10_001, normaliseForFingerprint(a), 1);
    q.ingest([queueOp('enqueue', 20_000, withSoftNewlineResidue(a))]);
    // The new conflict starts a new bounded window. Retaining the cancelled
    // group's tombstones would instead merge and expire these marks at the old cap.
    expect(q.pruneExpired(TTL, markAt + CLI_QUEUE_HOLD_MAX_MS + 10_000)).toEqual([]);
  });

  it('cleans remaining tombstones when the last active member starts', () => {
    const a = 'echo foo\nbar with enough content to identify the turn';
    const b = 'echo foo\\\nbar with enough content to identify the turn';
    const c = 'echo foo\\\\\nbar with enough content to identify the turn';
    const q = new BridgeTurnQueue();
    q.mark('A', makeFingerprint(a), markAt, normaliseForFingerprint(a), 1);
    q.mark('B', makeFingerprint(b), markAt + 1, normaliseForFingerprint(b), 1);
    q.mark('C', makeFingerprint(c), markAt + 2, normaliseForFingerprint(c), 1);
    q.ingest([
      queueOp('enqueue', 1_000, withSoftNewlineResidue(a)),
      queueOp('enqueue', 2_000, withSoftNewlineResidue(b)),
      queueOp('enqueue', 3_000, withSoftNewlineResidue(c)),
    ]);
    q.dropPendingTurn('A', 1);
    q.dropPendingTurn('B', 1);
    q.ingest([user('real-C', withSoftNewlineResidue(c), iso(4_000)), assistant('answer-C', 'answer C')]);
    expect(q.drainEmittable().map(turn => turn.turnId)).toEqual(['C']);

    // C's real start leaves only cancelled tombstones. They must not merge a
    // later mark into the old window or reject its valid residue record.
    q.mark('new-A', makeFingerprint(a), markAt + CLI_QUEUE_HOLD_MAX_MS + 5_000, normaliseForFingerprint(a), 1);
    q.ingest([
      user('new-A-user', withSoftNewlineResidue(a), iso(CLI_QUEUE_HOLD_MAX_MS + 6_000)),
      assistant('new-A-answer', 'new answer'),
    ]);
    expect(q.drainEmittable().map(turn => turn.turnId)).toEqual(['new-A']);
  });

  it('does not release a real mark for another input\'s ambiguous clean remove', () => {
    const a = 'echo foo\nbar with enough content to identify the turn';
    const local = 'echo foo\\\nbar with enough content to identify the turn';
    const q = marked(a, 'lark-A');
    q.ingest([
      queueOp('enqueue', 1_000, withSoftNewlineResidue(a)),
      queueOp('enqueue', 1_100, withSoftNewlineResidue(local)),
    ]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(true);

    q.ingest([queueOp('remove', 2_000, local, 'remove-local')]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(true);
    expect(q.pruneExpired(120_000, markAt + 122_001)).toEqual([]);
    q.ingest([
      user('late-real-A', withSoftNewlineResidue(a), iso(123_000)),
      assistant('late-assistant-A', 'late answer'),
    ]);
    expect(q.drainEmittable().map(turn => turn.turnId)).toEqual(['lark-A']);
  });

  it('does not hold a mark for an enqueue missing its genuine line-ending backslash', () => {
    const sent = '<user_message>echo foo\\\nbar with enough content</user_message>';
    const different = '<user_message>echo foo\nbar with enough content</user_message>';
    const q = marked(sent);
    q.ingest([queueOp('enqueue', 1_000, different)]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
  });

  it('expires a mark with no enqueue record at the TTL, as before', () => {
    const q = marked();
    expect(q.pruneExpired(TTL, markAt + TTL + 1).map(t => t.turnId)).toEqual(['t1']);
  });

  it('does not treat another input or an older identical input as this mark being queued', () => {
    const other = marked();
    other.ingest([queueOp('enqueue', 1_000, '<task-notification>done</task-notification>')]);
    expect(isHeldInCliQueue(other.peek()[0])).toBe(false);
    const older = marked();
    older.ingest([queueOp('enqueue', -60_000, text)]);
    expect(isHeldInCliQueue(older.peek()[0])).toBe(false);
  });

  it('runs the normal TTL from the moment the input leaves the queue unbound', () => {
    const q = marked();
    q.ingest([queueOp('enqueue', 1_000, text)]);
    q.ingest([queueOp('remove', 600_000, text, 'cancelled')]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
    expect(q.pruneExpired(TTL, markAt + 600_000 + TTL)).toEqual([]);
    expect(q.pruneExpired(TTL, markAt + 600_000 + TTL + 1).map(t => t.turnId)).toEqual(['t1']);
  });

  it('follows queue order for content-less dequeues, past items that are not marks', () => {
    const q = marked();
    q.ingest([
      queueOp('enqueue', 500, '<task-notification>done</task-notification>'),
      queueOp('enqueue', 1_000, text),
      queueOp('dequeue', 5_000),
    ]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(true);
    q.ingest([queueOp('dequeue', 6_000)]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
  });

  it('pairs identical inputs with their marks in order', () => {
    const q = marked();
    q.mark('t2', makeFingerprint(text), markAt + 100, normaliseForFingerprint(text));
    q.ingest([queueOp('enqueue', 1_000, text)]);
    expect(q.peek().map(isHeldInCliQueue)).toEqual([true, false]);
    q.ingest([queueOp('enqueue', 1_000, text)]); // same record replayed by a transcript switch
    expect(q.peek().map(isHeldInCliQueue)).toEqual([true, false]);
    q.ingest([queueOp('enqueue', 2_000, text)]);
    expect(q.peek().map(isHeldInCliQueue)).toEqual([true, true]);
  });

  // Real sequence (transcript e13e85d1, 2026-11-05): a long step wrote nothing
  // from 12:43:08 to 12:50:38; the enqueue of input typed at 12:46:53 first
  // appeared at 12:50:38 next to its dequeue, after the 120 s TTL had passed.
  function busyWith(onStart?: (id: string) => void): BridgeTurnQueue {
    const q = new BridgeTurnQueue(undefined, undefined, turn => { onStart?.(turn.turnId); });
    q.mark('t0', makeFingerprint('<input running>'), markAt - 60_000, normaliseForFingerprint('<input running>'));
    q.ingest([user('u-running', '<input running>', iso(-60_000))]);
    return q;
  }

  it('holds a mark written while an earlier turn runs, then binds the late-flushed queue records', () => {
    const started: string[] = [];
    const q = busyWith(id => started.push(id));
    q.mark('t1', makeFingerprint(text), markAt, normaliseForFingerprint(text));
    expect(q.pruneExpired(TTL, markAt + 220_000)).toEqual([]);
    q.ingest([
      queueOp('enqueue', 3_700, text),
      queueOp('remove', 225_200, text, 'absorbed_mid_turn'),
      absorbed('q1', text, 3_300),
    ]);
    expect(started).toEqual(['t0', 't1']);
  });

  it('runs the normal TTL again from the moment the earlier turn ended', () => {
    const q = busyWith();
    q.mark('t1', makeFingerprint(text), markAt, normaliseForFingerprint(text));
    expect(q.pruneExpired(TTL, markAt + 300_000)).toEqual([]);
    q.ingest([{ type: 'system', subtype: 'turn_duration', uuid: 'd-running' } as TranscriptEvent]);
    expect(q.pruneExpired(TTL, markAt + 300_000 + TTL)).toEqual([]);
    expect(q.pruneExpired(TTL, markAt + 300_000 + TTL + 1).map(t => t.turnId)).toEqual(['t1']);
  });

  it('a busy-held mark uses the rare fallback-scan cadence', () => {
    const q = busyWith();
    q.mark('t1', makeFingerprint(text), markAt, normaliseForFingerprint(text));
    expect(isHeldPendingMark(q.peek().find(t => t.turnId === 't1')!)).toBe(false);
    q.pruneExpired(TTL, markAt + 1_000);
    expect(isHeldPendingMark(q.peek().find(t => t.turnId === 't1')!)).toBe(true);
  });

  it('bounds the busy hold, so a lost input cannot stay pending for good', () => {
    const q = busyWith();
    q.mark('t1', makeFingerprint(text), markAt, normaliseForFingerprint(text));
    expect(q.pruneExpired(TTL, markAt + CLI_QUEUE_HOLD_MAX_MS)).toEqual([]);
    expect(q.pruneExpired(TTL, markAt + CLI_QUEUE_HOLD_MAX_MS + TTL + 1).map(t => t.turnId)).toEqual(['t1']);
  });

  it('stops holding at the upper bound, so a dropped input cannot block the queue for good', () => {
    const q = marked();
    q.ingest([queueOp('enqueue', 1_000, text)]);
    expect(q.pruneExpired(TTL, markAt + 1_000 + CLI_QUEUE_HOLD_MAX_MS)).toEqual([]);
    expect(q.pruneExpired(TTL, markAt + 1_000 + CLI_QUEUE_HOLD_MAX_MS + 1).map(t => t.turnId)).toEqual(['t1']);
  });

  it('stops holding when Claude returns to its prompt, then runs the normal TTL from there', () => {
    const q = marked();
    q.ingest([queueOp('enqueue', 1_000, text)]);
    q.cliQueueDrained(markAt + 600_000);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
    expect(q.pruneExpired(TTL, markAt + 600_000 + TTL)).toEqual([]);
    expect(q.pruneExpired(TTL, markAt + 600_000 + TTL + 1).map(t => t.turnId)).toEqual(['t1']);
  });

  it('stops holding when a remove carries no content to match', () => {
    const q = marked();
    q.ingest([queueOp('enqueue', 1_000, text), queueOp('remove', 50_000, undefined, 'dropped_by_hook')]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
  });

  it('does not hold a mark too short to identify its own enqueue', () => {
    const q = marked('test');
    q.ingest([queueOp('enqueue', 1_000, 'please run tests for the bridge module')]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
  });

  it('counts dequeues that share a millisecond', () => {
    const q = marked();
    q.ingest([
      queueOp('enqueue', 500, '<task-notification>done</task-notification>'),
      queueOp('enqueue', 1_000, text),
      queueOp('dequeue', 5_000),
      queueOp('dequeue', 5_000),
    ]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
  });

  it('matches a remove to its input by content, not by queue position', () => {
    const q = marked();
    q.ingest([
      queueOp('enqueue', 1_000, text),
      queueOp('enqueue', 1_500, '<task-notification>second in line</task-notification>'),
      queueOp('remove', 5_000, '<task-notification>second in line</task-notification>', 'absorbed_mid_turn'),
    ]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(true);
  });

  it('a new mark is not held by an enqueue that a cleared queue left behind', () => {
    const q = marked();
    q.ingest([queueOp('enqueue', 1_000, text)]);
    q.clearPending();
    q.mark('t2', makeFingerprint(text), markAt + 2_000, normaliseForFingerprint(text));
    q.ingest([queueOp('enqueue', 4_000, text)]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(true);
    q.ingest([queueOp('dequeue', 5_000)]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
  });

  it('holds the next unstarted mark, not one that already started with the same text', () => {
    const q = marked();
    q.ingest([{ type: 'user', uuid: 'u1', timestamp: iso(500), message: { role: 'user', content: text } } as unknown as TranscriptEvent]);
    q.mark('t2', makeFingerprint(text), markAt + 1_000, normaliseForFingerprint(text));
    q.ingest([queueOp('enqueue', 2_000, text)]);
    expect(q.peek().filter(t => !t.isLocal).map(t => [t.turnId, t.started, isHeldInCliQueue(t)]))
      .toEqual([['t1', true, false], ['t2', false, true]]);
  });

  it('stops holding once the queue is no longer observable', () => {
    const q = marked();
    q.ingest([queueOp('enqueue', 1_000, text)]);
    q.forgetCliQueue(markAt + 10_000);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
    expect(q.pruneExpired(TTL, markAt + 10_000 + TTL + 1).map(t => t.turnId)).toEqual(['t1']);
  });

  it('does not fold same-millisecond equal-length records with different content or command ids', () => {
    // Fleet transcripts contain 14 groups of same-ms records whose texts are
    // equal length but different (each remove carries its own commandUuid).
    // A length-based dedup key discarded the second record and drifted the
    // queue mirror: the second mark never held, or its release never applied.
    const A = 'please alpha the bridge module now';
    const B = 'please bravo the bridge module now';
    expect(A).not.toBe(B);
    expect(A.length).toBe(B.length);
    const q = new BridgeTurnQueue();
    q.mark('t1', makeFingerprint(A), markAt, normaliseForFingerprint(A));
    q.mark('t2', makeFingerprint(B), markAt, normaliseForFingerprint(B));
    q.ingest([
      queueOp('enqueue', 1_000, A, undefined, { commandUuid: 'u-A' }),
      queueOp('enqueue', 1_000, B, undefined, { commandUuid: 'u-B' }),
    ]);
    expect(q.peek().map(isHeldInCliQueue)).toEqual([true, true]);
    q.ingest([
      queueOp('remove', 2_000, A, 'cancelled', { commandUuid: 'u-A', deliveryId: 'd-A' }),
      queueOp('remove', 2_000, B, 'cancelled', { commandUuid: 'u-B', deliveryId: 'd-B' }),
    ]);
    expect(q.peek().map(isHeldInCliQueue)).toEqual([false, false]);
  });

  it('distinguishes same-ms same-content removes of distinct commands by commandUuid', () => {
    // Fleet transcripts also contain 5 groups of same-ms removes with IDENTICAL
    // text but different commandUuid (separate commands), vs 1 group sharing a
    // commandUuid (a genuine replay). A text-only key would fold the former.
    const q = marked();
    q.mark('t2', makeFingerprint(text), markAt + 100, normaliseForFingerprint(text));
    q.ingest([queueOp('enqueue', 1_000, text), queueOp('enqueue', 2_000, text)]);
    expect(q.peek().map(isHeldInCliQueue)).toEqual([true, true]);
    q.ingest([
      queueOp('remove', 3_000, text, 'absorbed_mid_turn', { commandUuid: 'u-1', deliveryId: 'd-1' }),
      queueOp('remove', 3_000, text, 'absorbed_mid_turn', { commandUuid: 'u-2', deliveryId: 'd-2' }),
    ]);
    expect(q.peek().map(isHeldInCliQueue)).toEqual([false, false]);
  });

  it('treats a same-ms same-content enqueue with no command id as a replay, leaving no ghost slot', () => {
    // enqueues carry no commandUuid: the same ms+text record replayed across a
    // transcript switch must fold to ONE mirror slot, or a later dequeue order
    // shifts and the next mark's release lands on the wrong item.
    const q = marked();
    q.ingest([queueOp('enqueue', 1_000, text), queueOp('enqueue', 1_000, text)]);
    q.ingest([queueOp('dequeue', 2_000)]);
    expect(isHeldInCliQueue(q.peek()[0])).toBe(false);
    q.mark('t2', makeFingerprint(text), markAt + 2_500, normaliseForFingerprint(text));
    q.ingest([queueOp('enqueue', 3_000, text), queueOp('dequeue', 3_500)]);
    expect(q.peek().map(turn => [turn.turnId, isHeldInCliQueue(turn)]))
      .toEqual([['t1', false], ['t2', false]]);
  });
});

describe('input the worker is still writing', () => {
  // Under tmux overload each chunk of a long first message waits on its own
  // send-keys, so typing it can outlast the TTL that runs from the mark.
  const TTL = 120_000;
  const markAt = Date.parse('2026-11-07T12:30:52.000Z');
  const text = '<user_message>a long first message typed into the composer chunk by chunk</user_message>';
  function marked(turnId = 't1', dispatchAttempt?: number): BridgeTurnQueue {
    const q = new BridgeTurnQueue();
    q.mark(turnId, makeFingerprint(text), markAt, normaliseForFingerprint(text), dispatchAttempt);
    return q;
  }

  it('keeps the mark while its write outlasts the TTL, so the submitted input still binds', () => {
    const started: string[] = [];
    const q = new BridgeTurnQueue(undefined, undefined, turn => { started.push(turn.turnId); });
    q.mark('t1', makeFingerprint(text), markAt, normaliseForFingerprint(text));
    q.holdForWrite('t1');
    expect(q.pruneExpired(TTL, markAt + 150_000)).toEqual([]);
    q.releaseWriteHold('t1', undefined, markAt + 155_000);
    expect(q.pruneExpired(TTL, markAt + 156_000)).toEqual([]);
    q.ingest([user('u1', text, new Date(markAt + 157_000).toISOString())]);
    expect(started).toEqual(['t1']);
  });

  it('runs the TTL from the moment the write settled', () => {
    const q = marked();
    q.holdForWrite('t1');
    q.releaseWriteHold('t1', undefined, markAt + 150_000);
    expect(q.pruneExpired(TTL, markAt + 150_000 + TTL)).toEqual([]);
    expect(q.pruneExpired(TTL, markAt + 150_000 + TTL + 1).map(t => t.turnId)).toEqual(['t1']);
  });

  it('holds only the exact turn and attempt being written', () => {
    const q = marked('t1', 2);
    q.mark('t2', makeFingerprint(text), markAt, normaliseForFingerprint(text));
    q.holdForWrite('t1', 1);
    q.holdForWrite('t3');
    expect(q.pruneExpired(TTL, markAt + TTL + 1).map(t => t.turnId)).toEqual(['t1', 't2']);
  });
});

// Real-shaped transcript (trimmed + sanitised from Claude Code 2.1.318): a Lark
// turn launches `run_in_background` Bash and ends; the task's
// `<task-notification>` then wakes the main thread, which answers on its own.
describe('Claude background-task wake turns', () => {
  const FIXTURE = new URL('./fixtures/claude-background-wake/wake-after-lark-turn.jsonl', import.meta.url);
  const LARK_PROMPT = '<user_message>盯一下 PR 的 CI，跑完告诉我结果</user_message>';

  /** Fixture events. `live` re-stamps them after `liveAfterMs` (records
   *  written while this queue watches); otherwise they keep their original,
   *  older timestamps (history a restarted worker replays). */
  function fixtureEvents(opts: { liveAfterMs?: number } = {}): TranscriptEvent[] {
    const events = readFileSync(FIXTURE, 'utf8').trim().split('\n').map(line => JSON.parse(line) as TranscriptEvent);
    if (opts.liveAfterMs === undefined) return events;
    const shift = opts.liveAfterMs + 1_000 - Date.parse(events[0].timestamp!);
    return events.map(ev => ({ ...ev, timestamp: new Date(Date.parse(ev.timestamp!) + shift).toISOString() }));
  }
  function withFinal(events: TranscriptEvent[], text: string): TranscriptEvent[] {
    return events.map(ev => ev.uuid === 'wake-a-final'
      ? { ...ev, message: { ...ev.message!, content: [{ type: 'text', text }] } }
      : ev);
  }
  function markLark(q: BridgeTurnQueue, turnId = 'lark-t1', prompt = LARK_PROMPT): void {
    q.mark(turnId, makeFingerprint(prompt), Date.now() - 60_000, normaliseForFingerprint(prompt));
  }
  function readyWake(q: BridgeTurnQueue) {
    const ready = q.drainEmittable({ explicitTerminalOnly: true, releaseHeldTerminals: true });
    return { ready, wake: ready.find(turn => turn.isLocal) };
  }
  /** The worker's transcript-mode decision for a local turn. */
  async function suppressed(turn: ReturnType<typeof readyWake>['wake'], events: TranscriptEvent[], replyDelivery: 'send' | 'transcript') {
    const { trailingAssistantText } = await import('../src/services/claude-transcript.js');
    return shouldSuppressBridgeEmit({
      markTimeMs: turn!.markTimeMs,
      isLocal: turn!.isLocal,
      isScheduled: turn!.isScheduled,
      ...(turn!.isBackgroundWake ? { isBackgroundWake: true } : {}),
      finalText: trailingAssistantText(events, turn!.assistantUuids, {}),
      forwardLocalFinal: false,
    }, undefined, [], false, replyDelivery);
  }

  it('a live wake turn anchors to the launching Lark turn and is forwarded in transcript delivery', async () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    q.ingest(events);
    const { ready, wake } = readyWake(q);
    expect(ready.map(turn => turn.turnId)).toEqual(['lark-t1', 'local-headless-wake-a-final']);
    expect(wake).toMatchObject({ isBackgroundWake: true, replyAnchorTurnId: 'lark-t1', assistantUuids: ['wake-a-final'] });
    expect(await suppressed(wake, events, 'transcript')).toBe(false);
  });

  it('send delivery still suppresses the same wake turn', async () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    q.ingest(events);
    expect(await suppressed(readyWake(q).wake, events, 'send')).toBe(true);
  });

  it('a NOTHING_TO_SEND wake final stays silent in transcript delivery', async () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = withFinal(fixtureEvents({ liveAfterMs: Date.now() }), 'BOTMUX_NOTHING_TO_SEND');
    q.ingest(events);
    const { wake } = readyWake(q);
    expect(wake?.isBackgroundWake).toBe(true);
    expect(await suppressed(wake, events, 'transcript')).toBe(true);
  });

  it('anchors to the launching Lark turn, not a later one that ran in between', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const wakeAt = events.findIndex(ev => ev.uuid === 'wake-user');
    q.ingest(events.slice(0, wakeAt));
    q.mark('lark-t2', makeFingerprint('另一个问题'));
    q.ingest([user('lark-user-2', '另一个问题'), assistant('lark-a2', '答复'),
      { type: 'system', subtype: 'turn_duration', uuid: 'lark-duration-2' } as TranscriptEvent]);
    q.ingest(events.slice(wakeAt));
    expect(readyWake(q).wake).toMatchObject({ isBackgroundWake: true, replyAnchorTurnId: 'lark-t1' });
  });

  it('a wake replayed from before this queue existed stays an ordinary local turn', async () => {
    // Journal restore / rotation replays: the records predate the worker.
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents();
    q.ingest(events);
    const { wake } = readyWake(q);
    expect(wake?.isBackgroundWake).toBeFalsy();
    expect(await suppressed(wake, events, 'transcript')).toBe(true);
  });

  it('a wake whose notification the baseline absorbed stays an ordinary headless turn', () => {
    const q = new BridgeTurnQueue();
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const continuationAt = events.findIndex(ev => ev.uuid === 'wake-a-thinking');
    q.absorb(events.slice(0, continuationAt));
    q.ingest(events.slice(continuationAt));
    const { wake } = readyWake(q);
    expect(wake?.turnId).toBe('local-headless-wake-a-final');
    expect(wake?.isBackgroundWake).toBeFalsy();
  });

  it('a task launched from a terminal-typed turn has no anchor: its wake stays local', () => {
    const q = new BridgeTurnQueue();
    // An earlier Lark turn exists, but it is not the one that launched the task.
    q.mark('lark-t0', makeFingerprint('先看一下状态'));
    q.ingest([user('lark-user-0', '先看一下状态'), assistant('lark-a0', '状态正常'),
      { type: 'system', subtype: 'turn_duration', uuid: 'lark-duration-0' } as TranscriptEvent]);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    q.ingest(events);  // no Lark mark for this prompt: the launching turn is local
    const ready = q.drainEmittable({ explicitTerminalOnly: true, releaseHeldTerminals: true });
    const wake = ready.find(turn => turn.assistantUuids.includes('wake-a-final'));
    expect(wake?.isBackgroundWake).toBeFalsy();
  });

  it('a sidechain notification does not open a wake turn', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() })
      .map(ev => ev.uuid === 'wake-user' ? { ...ev, isSidechain: true } : ev);
    q.ingest(events);
    expect(readyWake(q).wake?.isBackgroundWake).toBeFalsy();
  });

  it('a notification read while the Lark turn is still open neither splits it nor arms a wake', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    // Drop the Lark turn's duration marker: the notification lands inside it.
    const events = fixtureEvents({ liveAfterMs: Date.now() })
      .filter(ev => ev.uuid !== 'lark-duration' && ev.uuid !== 'lark-a-final');
    q.ingest(events);
    const ready = q.drainEmittable({ explicitTerminalOnly: true, releaseHeldTerminals: true });
    expect(ready.map(turn => turn.turnId)).toEqual(['lark-t1']);
    expect(ready[0].assistantUuids).toEqual(['wake-a-final']);
    expect(ready.some(turn => turn.isBackgroundWake)).toBe(false);
  });

  /** A second Lark turn (`turnId`) that launches background task `taskId`, then
   *  ends — placed just before the fixture's wake notification. */
  function secondLarkLaunch(q: BridgeTurnQueue, events: TranscriptEvent[], turnId: string, taskId: string): TranscriptEvent[] {
    const prompt = '<user_message>另一个话题：跑下压测</user_message>';
    const wakeAt = Date.parse(events.find(ev => ev.uuid === 'wake-user')!.timestamp!);
    const iso = (offsetMs: number) => new Date(wakeAt - 30_000 + offsetMs).toISOString();
    q.mark(turnId, makeFingerprint(prompt), wakeAt - 31_000, normaliseForFingerprint(prompt));
    return [
      { type: 'user', uuid: `${turnId}-u`, timestamp: iso(0), message: { role: 'user', content: prompt } },
      { type: 'assistant', uuid: `${turnId}-launch`, timestamp: iso(10), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `call_${taskId}`, name: 'Bash', input: { command: 'run-load', run_in_background: true } }] } },
      { type: 'user', uuid: `${turnId}-ack`, timestamp: iso(20), toolUseResult: { backgroundTaskId: taskId }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${taskId}`, content: `Command running in background with ID: ${taskId}.` }] } },
      { type: 'assistant', uuid: `${turnId}-final`, timestamp: iso(30), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '压测已后台启动' }] } },
      { type: 'system', subtype: 'turn_duration', uuid: `${turnId}-duration`, timestamp: iso(40) },
    ] as TranscriptEvent[];
  }
  function notification(uuid: string, taskId: string, atMs: number): TranscriptEvent {
    return { type: 'user', uuid, timestamp: new Date(atMs).toISOString(), isSidechain: false, promptSource: 'system',
      message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` } } as TranscriptEvent;
  }
  /** Ingest the fixture with `extra` notifications delivered right after (or,
   *  with `before`, right before) its own wake notification. */
  function wakeWithSiblings(q: BridgeTurnQueue, events: TranscriptEvent[], prelude: TranscriptEvent[], extra: (wakeAtMs: number) => TranscriptEvent[], before = false) {
    const wakeAt = events.findIndex(ev => ev.uuid === 'wake-user');
    q.ingest(events.slice(0, wakeAt));
    q.ingest(prelude);
    const siblings = extra(Date.parse(events[wakeAt].timestamp!));
    q.ingest(before ? [...siblings, ...events.slice(wakeAt)] : [events[wakeAt], ...siblings, ...events.slice(wakeAt + 1)]);
    return readyWake(q).ready.find(turn => turn.assistantUuids.includes('wake-a-final'));
  }

  it('notifications from tasks of two different Lark turns answered together fail closed', async () => {
    const q = new BridgeTurnQueue();
    markLark(q, 'om_topicA');
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const wake = wakeWithSiblings(q, events, secondLarkLaunch(q, events, 'om_topicB', 'taskB'),
      at => [notification('wake-b', 'taskB', at + 20)]);
    expect(wake?.turnId).toBe('local-headless-wake-a-final');
    expect(wake?.isBackgroundWake).toBeFalsy();
    expect(await suppressed(wake, events, 'transcript')).toBe(true);
  });

  it('notifications of two tasks launched by the same Lark turn still forward to it', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const wakeAt = Date.parse(events.find(ev => ev.uuid === 'wake-user')!.timestamp!);
    // Re-launch under the same anchor: the fixture's Lark turn also acks taskB.
    const launchB = { ...events.find(ev => ev.uuid === 'lark-ack')!, uuid: 'lark-ack-b',
      toolUseResult: { backgroundTaskId: 'taskB' } } as TranscriptEvent;
    const withB = events.flatMap(ev => ev.uuid === 'lark-ack' ? [ev, launchB] : [ev]);
    const wake = wakeWithSiblings(q, withB, [], () => [notification('wake-b', 'taskB', wakeAt + 20)]);
    expect(wake).toMatchObject({ isBackgroundWake: true, replyAnchorTurnId: 'lark-t1' });
  });

  for (const before of [false, true]) {
    it(`an anchored notification answered together with an unanchored one fails closed (unanchored ${before ? 'first' : 'second'})`, () => {
      const q = new BridgeTurnQueue();
      markLark(q);
      const events = fixtureEvents({ liveAfterMs: Date.now() });
      // taskZ was launched from the terminal (or before this worker): no anchor.
      const wake = wakeWithSiblings(q, events, [],
        at => [notification('wake-z', 'taskZ', before ? at - 20 : at + 20)], before);
      expect(wake?.turnId).toBe('local-headless-wake-a-final');
      expect(wake?.isBackgroundWake).toBeFalsy();
    });
  }

  it('a notification folded into a running Lark turn arms nothing even if that turn settles before the duration marker', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const byId = (id: string) => events.find(ev => ev.uuid === id)!;
    // The notice lands while the Lark turn is still collecting; the Lark
    // turn's final then settles it (released before its duration marker), so
    // the wake's answer arrives with nothing collecting and is synthesised.
    q.ingest(['lark-user-1', 'lark-a-launch', 'lark-ack', 'wake-user', 'lark-a-final'].map(byId));
    const first = q.drainEmittable({ explicitTerminalOnly: true, releaseHeldTerminals: true });
    expect(first.map(turn => turn.turnId)).toEqual(['lark-t1']);
    q.ingest(['wake-a-thinking', 'wake-a-final', 'wake-duration'].map(byId));
    const wake = readyWake(q).ready.find(turn => turn.assistantUuids.includes('wake-a-final'));
    expect(wake?.turnId).toBe('local-headless-wake-a-final');
    expect(wake?.isBackgroundWake).toBeFalsy();
  });

  /** Claude Code's API-error record (`isApiErrorMessage`, `<synthetic>` model). */
  function apiError(uuid: string, atMs: number, text = 'API Error: 500 {"type":"error","error":{"type":"api_error"}}'): TranscriptEvent {
    return { type: 'assistant', uuid, timestamp: new Date(atMs).toISOString(), isSidechain: false, isApiErrorMessage: true,
      message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] } } as TranscriptEvent;
  }
  /** Visible assistant text with no user record before it (a headless turn). */
  function laterText(uuid: string, atMs: number): TranscriptEvent {
    return { type: 'assistant', uuid, timestamp: new Date(atMs).toISOString(), isSidechain: false,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '无关的后续输出' }] } } as TranscriptEvent;
  }

  it('a typed message that merely starts with the notification tag arms nothing', () => {
    // Bare (solo transcript) delivery puts a human's text into the CLI as-is;
    // only Claude Code's own notice record carries promptSource "system".
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() })
      .map(ev => ev.uuid === 'wake-user' ? { ...ev, promptSource: 'user' } : ev);
    q.ingest(events);
    const { wake } = readyWake(q);
    expect(wake?.turnId).toBe('local-headless-wake-a-final');
    expect(wake?.isBackgroundWake).toBeFalsy();
  });

  it('without turn_duration markers, an API error ends the wake: a later headless turn stays local', () => {
    // A transcript that never writes `turn_duration` (older Claude JSONL).
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() })
      .filter(ev => ev.subtype !== 'turn_duration');
    const byId = (id: string) => events.find(ev => ev.uuid === id)!;
    q.ingest(['lark-user-1', 'lark-a-launch', 'lark-ack', 'lark-a-final'].map(byId));
    q.noteDurationMarkerWaitExpired();
    expect(q.drainEmittable({ explicitTerminalOnly: true, releaseHeldTerminals: true }).map(turn => turn.turnId))
      .toEqual(['lark-t1']);
    const wakeAt = Date.parse(byId('wake-user').timestamp!);
    q.ingest([byId('wake-user'), apiError('wake-api-error', wakeAt + 2_000), laterText('later-a', wakeAt + 60_000)]);
    const later = readyWake(q).ready.find(turn => turn.assistantUuids.includes('later-a'));
    expect(later?.turnId).toBe('local-headless-later-a');
    expect(later?.isBackgroundWake).toBeFalsy();
    expect(later?.replyAnchorTurnId).toBeUndefined();
  });

  it('a wake cut by a provider error before any text lends nothing to a later headless turn (marker-writing transcript)', () => {
    // The Lark turn closed with its duration marker; the wake turn is cut by a
    // server error and writes no marker of its own; later assistant text
    // arrives with no user record before it.
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const wakeAt = events.findIndex(ev => ev.uuid === 'wake-user');
    const wakeAtMs = Date.parse(events[wakeAt].timestamp!);
    q.ingest([...events.slice(0, wakeAt + 1),
      apiError('wake-api-error', wakeAtMs + 2_000),
      laterText('later-a', wakeAtMs + 60_000)]);
    const later = readyWake(q).ready.find(turn => turn.assistantUuids.includes('later-a'));
    expect(later?.turnId).toBe('local-headless-later-a');
    expect(later?.isBackgroundWake).toBeFalsy();
    expect(later?.replyAnchorTurnId).toBeUndefined();
  });

  it('a wake cut by an API error before any text is not forwarded even if Claude carries on in the same turn', () => {
    // "Connection lost mid-response" is written as an API-error record, after
    // which Claude Code may keep going. The error fails the wake the same way
    // it fails a turn that is already collecting: no forwarded answer.
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const wakeAt = events.findIndex(ev => ev.uuid === 'wake-user');
    const cut = apiError('wake-api-error', Date.parse(events[wakeAt].timestamp!) + 1_000,
      'API Error: Connection lost mid-response. The response above may be incomplete.');
    q.ingest([...events.slice(0, wakeAt + 1), cut, ...events.slice(wakeAt + 1)]);
    const { wake } = readyWake(q);
    expect(wake?.turnId).toBe('local-headless-wake-a-final');
    expect(wake?.isBackgroundWake).toBeFalsy();
  });

  it('a wake that ends without visible text is closed by its own duration marker', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const byId = (id: string) => events.find(ev => ev.uuid === id)!;
    const wakeAtMs = Date.parse(byId('wake-user').timestamp!);
    q.ingest([...events.slice(0, events.findIndex(ev => ev.uuid === 'wake-user') + 1),
      byId('wake-a-thinking'), byId('wake-duration'),
      laterText('later-a', wakeAtMs + 60_000)]);
    const later = readyWake(q).ready.find(turn => turn.assistantUuids.includes('later-a'));
    expect(later?.turnId).toBe('local-headless-later-a');
    expect(later?.isBackgroundWake).toBeFalsy();
  });

  it('reports the launching turn of each running background task, once', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    q.ingest(events.slice(0, events.findIndex(ev => ev.uuid === 'wake-user')));
    expect(q.backgroundTaskAnchorTurnIds(['bxfr0j2hg', 'bxfr0j2hg', 'unknown-task'])).toEqual(['lark-t1']);
    expect(q.backgroundTaskAnchorTurnIds([])).toEqual([]);
  });

  /** A main-thread `run_in_background` launch (tool_use + its ack) at `atMs`. */
  function launchRecords(prefix: string, taskId: string, atMs: number): TranscriptEvent[] {
    return [
      { type: 'assistant', uuid: `${prefix}-launch`, timestamp: new Date(atMs).toISOString(), isSidechain: false,
        message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `call_${taskId}`, name: 'Bash', input: { command: 'watch-ci', run_in_background: true } }] } },
      { type: 'user', uuid: `${prefix}-ack`, timestamp: new Date(atMs + 50).toISOString(), isSidechain: false,
        toolUseResult: { backgroundTaskId: taskId },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${taskId}`, content: `Command running in background with ID: ${taskId}.` }] } },
    ] as TranscriptEvent[];
  }
  /** The notice Claude Code folds into a turn already under way. */
  function absorbedNotice(uuid: string, taskId: string, atMs: number): TranscriptEvent {
    return { type: 'attachment', uuid, timestamp: new Date(atMs).toISOString(), isSidechain: false,
      attachment: { type: 'queued_command', commandMode: 'task-notification',
        prompt: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` } } as TranscriptEvent;
  }
  function duration(uuid: string, atMs: number): TranscriptEvent {
    return { type: 'system', subtype: 'turn_duration', uuid, timestamp: new Date(atMs).toISOString(), isSidechain: false } as TranscriptEvent;
  }

  it('a task the wake turn launches before it says anything inherits the wake\'s anchor', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const wakeAt = events.findIndex(ev => ev.uuid === 'wake-user');
    const t = Date.parse(events[wakeAt].timestamp!);
    q.ingest([...events.slice(0, wakeAt + 1), ...launchRecords('relaunch', 'task2', t + 1_000), ...events.slice(wakeAt + 1)]);
    expect(q.backgroundTaskAnchorTurnIds(['task2'])).toEqual(['lark-t1']);
    q.ingest([notification('wake2-user', 'task2', t + 120_000), laterText('wake2-final', t + 125_000), duration('wake2-duration', t + 126_000)]);
    const wake2 = readyWake(q).ready.find(turn => turn.assistantUuids.includes('wake2-final'));
    expect(wake2).toMatchObject({ isBackgroundWake: true, replyAnchorTurnId: 'lark-t1' });
  });

  for (const [form, position] of [['attachment', 'before'], ['attachment', 'after'], ['user record', 'after']] as const) {
    it(`a folded notice of another topic's task fails the wake closed (${form}, absorbed ${position} its first text)`, () => {
      const q = new BridgeTurnQueue();
      markLark(q, 'om_topicA');
      const events = fixtureEvents({ liveAfterMs: Date.now() });
      const wakeAt = events.findIndex(ev => ev.uuid === 'wake-user');
      const t = Date.parse(events[wakeAt].timestamp!);
      q.ingest(events.slice(0, wakeAt));
      q.ingest(secondLarkLaunch(q, events, 'om_topicB', 'taskB'));
      const foldAt = events.findIndex(ev => ev.uuid === (position === 'before' ? 'wake-a-thinking' : 'wake-duration'));
      const fold = form === 'attachment' ? absorbedNotice('fold-b', 'taskB', t + 3_000) : notification('fold-b', 'taskB', t + 3_000);
      q.ingest([...events.slice(wakeAt, foldAt), fold, ...events.slice(foldAt)]);
      const wake = readyWake(q).ready.find(turn => turn.assistantUuids.includes('wake-a-final'));
      expect(wake?.turnId).toBe('local-headless-wake-a-final');
      expect(wake?.isBackgroundWake).toBeFalsy();
      expect(wake?.replyAnchorTurnId).toBeUndefined();
    });
  }

  it('a folded notice of a task without an anchor fails the wake closed', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const foldAt = events.findIndex(ev => ev.uuid === 'wake-duration');
    const t = Date.parse(events[foldAt].timestamp!);
    q.ingest([...events.slice(0, foldAt), absorbedNotice('fold-z', 'taskZ', t - 100), ...events.slice(foldAt)]);
    expect(readyWake(q).wake?.isBackgroundWake).toBeFalsy();
  });

  it('a folded notice of a task from the same Lark turn keeps the wake forwarded', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() });
    const launchB = { ...events.find(ev => ev.uuid === 'lark-ack')!, uuid: 'lark-ack-b',
      toolUseResult: { backgroundTaskId: 'taskB' } } as TranscriptEvent;
    const withB = events.flatMap(ev => ev.uuid === 'lark-ack' ? [ev, launchB] : [ev]);
    const foldAt = withB.findIndex(ev => ev.uuid === 'wake-duration');
    const t = Date.parse(withB[foldAt].timestamp!);
    q.ingest([...withB.slice(0, foldAt), absorbedNotice('fold-b', 'taskB', t - 100), ...withB.slice(foldAt)]);
    expect(readyWake(q).wake).toMatchObject({ isBackgroundWake: true, replyAnchorTurnId: 'lark-t1' });
  });

  it('without turn_duration markers, a rate-limit record also ends the wake', () => {
    const q = new BridgeTurnQueue();
    markLark(q);
    const events = fixtureEvents({ liveAfterMs: Date.now() })
      .filter(ev => ev.subtype !== 'turn_duration');
    const byId = (id: string) => events.find(ev => ev.uuid === id)!;
    q.ingest(['lark-user-1', 'lark-a-launch', 'lark-ack', 'lark-a-final'].map(byId));
    q.noteDurationMarkerWaitExpired();
    q.drainEmittable({ explicitTerminalOnly: true, releaseHeldTerminals: true });
    const wakeAt = Date.parse(byId('wake-user').timestamp!);
    const limited = { ...apiError('wake-limited', wakeAt + 2_000, 'API Error: Rate limit reached'), error: 'rate_limit' } as TranscriptEvent;
    q.ingest([byId('wake-user'), limited, laterText('later-a', wakeAt + 60_000)]);
    const later = readyWake(q).ready.find(turn => turn.assistantUuids.includes('later-a'));
    expect(later?.isBackgroundWake).toBeFalsy();
  });
});

describe('BridgeTurnQueue non-terminal Monitor mid-stream wake tagging & leading CoT observer', () => {
  function ts(baseMs: number, offsetMs: number): string {
    return new Date(baseMs + offsetMs).toISOString();
  }

  function monitorAck(
    uuid: string,
    atMs: number,
    taskId: string,
    opts: { persistent: boolean; timeoutMs?: number } = { persistent: false, timeoutMs: 1_800_000 },
  ): TranscriptEvent {
    return {
      type: 'user',
      uuid,
      timestamp: new Date(atMs).toISOString(),
      isSidechain: false,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${taskId}`, content: 'Monitor started' }] },
      toolUseResult: { taskId, timeoutMs: opts.timeoutMs ?? 1_800_000, persistent: opts.persistent },
    } as TranscriptEvent;
  }

  function bgAck(
    uuid: string,
    atMs: number,
    result: Record<string, unknown>,
  ): TranscriptEvent {
    return {
      type: 'user',
      uuid,
      timestamp: new Date(atMs).toISOString(),
      isSidechain: false,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${uuid}`, content: 'started' }] },
      toolUseResult: result,
    } as TranscriptEvent;
  }

  function noticeEv(
    uuid: string,
    atMs: number,
    content: string,
    extra: Record<string, unknown> = {},
  ): TranscriptEvent {
    return {
      type: 'user',
      uuid,
      timestamp: new Date(atMs).toISOString(),
      isSidechain: false,
      promptSource: 'system',
      turnOrigin: 'task_notification',
      message: { role: 'user', content },
      ...extra,
    } as TranscriptEvent;
  }

  function attachedNoticeEv(uuid: string, atMs: number, content: string): TranscriptEvent {
    return {
      type: 'attachment',
      uuid,
      timestamp: new Date(atMs).toISOString(),
      isSidechain: false,
      attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: content },
    } as unknown as TranscriptEvent;
  }

  function textEv(uuid: string, atMs: number, text: string, stopReason = 'end_turn'): TranscriptEvent {
    return {
      type: 'assistant',
      uuid,
      timestamp: new Date(atMs).toISOString(),
      isSidechain: false,
      message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text }] },
    } as TranscriptEvent;
  }

  function durationEv(uuid: string, atMs: number): TranscriptEvent {
    return {
      type: 'system',
      subtype: 'turn_duration',
      uuid,
      timestamp: new Date(atMs).toISOString(),
    } as TranscriptEvent;
  }

  function larkUserEv(uuid: string, atMs: number, text: string): TranscriptEvent {
    return {
      type: 'user',
      uuid,
      timestamp: new Date(atMs).toISOString(),
      isSidechain: false,
      promptSource: 'user',
      message: { role: 'user', content: text },
    } as TranscriptEvent;
  }

  it('marks Lark-launched bounded Monitor mid-stream wake with wakeNonTerminalMonitor and preserves dispatchAttempt', () => {
    const base = Date.now() + 1_000;
    const q = new BridgeTurnQueue();
    q.mark('om_main', '盯一下构建', base, '盯一下构建', 3);
    q.ingest([
      larkUserEv('u1', base + 100, '盯一下构建'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false, timeoutMs: 1_800_000 }),
      textEv('a1', base + 300, '已开始后台盯构建'),
      durationEv('d1', base + 400),
      noticeEv('n1', base + 10_000, '<task-notification>\n<task-id>m1</task-id>\n<result>step 2 running</result>\n</task-notification>'),
      textEv('a2', base + 10_500, '继续等待…'),
      durationEv('d2', base + 10_600),
    ]);
    const ready = q.drainEmittable({ explicitTerminalOnly: true });
    expect(ready.map(t => t.turnId)).toEqual(['om_main', 'local-headless-a2']);
    expect(ready[0].wakeNonTerminalMonitor).toBeUndefined();
    expect(ready[1]).toMatchObject({
      turnId: 'local-headless-a2',
      isLocal: true,
      isBackgroundWake: true,
      replyAnchorTurnId: 'om_main',
      replyAnchorDispatchAttempt: 3,
      wakeNonTerminalMonitor: true,
    });
  });

  it('fails open (never sets wakeNonTerminalMonitor) on terminal statuses, Monitor expiry, expiresAtMs boundary, persistent:true, non-Monitor, unknown taskId, spoofed promptSource, and id-less notifications', () => {
    const base = Date.now() + 1_000;
    const cases: Array<{ name: string; build: () => TranscriptEvent[] }> = [
      ...(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error'] as const).map(status => ({
        name: `terminal status=${status}`,
        build: () => [
          monitorAck('ack', base + 200, 'm1', { persistent: false, timeoutMs: 1_800_000 }),
          textEv('a1', base + 300, 'watching'),
          durationEv('d1', base + 400),
          noticeEv('n1', base + 5_000, `<task-notification>\n<task-id>m1</task-id>\n<status>${status}</status>\n</task-notification>`),
        ],
      })),
      {
        name: 'Monitor 30m [Monitor expired...] notification without <status>',
        build: () => [
          monitorAck('ack', base + 200, 'm1', { persistent: false, timeoutMs: 1_800_000 }),
          textEv('a1', base + 300, 'watching'),
          durationEv('d1', base + 400),
          noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>[Monitor expired after 30m]</result>\n</task-notification>'),
        ],
      },
      {
        name: 'atMs === expiresAtMs exact boundary',
        build: () => [
          monitorAck('ack', base + 200, 'm1', { persistent: false, timeoutMs: 60_000 }),
          textEv('a1', base + 300, 'watching'),
          durationEv('d1', base + 400),
          noticeEv('n1', base + 200 + 60_000, '<task-notification>\n<task-id>m1</task-id>\n<result>late line</result>\n</task-notification>'),
        ],
      },
      {
        name: 'atMs > expiresAtMs past deadline',
        build: () => [
          monitorAck('ack', base + 200, 'm1', { persistent: false, timeoutMs: 60_000 }),
          textEv('a1', base + 300, 'watching'),
          durationEv('d1', base + 400),
          noticeEv('n1', base + 200 + 60_001, '<task-notification>\n<task-id>m1</task-id>\n<result>late line</result>\n</task-notification>'),
        ],
      },
      {
        name: 'persistent: true alert Monitor',
        build: () => [
          monitorAck('ack', base + 200, 'm-alert', { persistent: true, timeoutMs: 0 }),
          textEv('a1', base + 300, 'watching alerts'),
          durationEv('d1', base + 400),
          noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m-alert</task-id>\n<result>ALERT: error spike</result>\n</task-notification>'),
        ],
      },
      {
        name: 'status-less subagent notification',
        build: () => [
          bgAck('ack', base + 200, { isAsync: true, status: 'async_launched', agentId: 'ag-1' }),
          textEv('a1', base + 300, 'dispatched'),
          durationEv('d1', base + 400),
          noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>ag-1</task-id>\n<summary>subagent update</summary>\n</task-notification>'),
        ],
      },
      {
        name: 'status-less background shell notification',
        build: () => [
          bgAck('ack', base + 200, { backgroundTaskId: 'sh-1' }),
          textEv('a1', base + 300, 'dispatched'),
          durationEv('d1', base + 400),
          noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>sh-1</task-id>\n<summary>shell update</summary>\n</task-notification>'),
        ],
      },
      {
        name: 'unknown taskId',
        build: () => [
          textEv('a1', base + 300, 'ok'),
          durationEv('d1', base + 400),
          noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>unknown-m</task-id>\n<result>line</result>\n</task-notification>'),
        ],
      },
      {
        name: 'human-typed <task-notification> (promptSource !== system)',
        build: () => [
          monitorAck('ack', base + 200, 'm1', { persistent: false, timeoutMs: 1_800_000 }),
          textEv('a1', base + 300, 'watching'),
          durationEv('d1', base + 400),
          noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>line</result>\n</task-notification>', { promptSource: 'user' }),
        ],
      },
      {
        name: 'id-less <task-notification> after Monitor notice',
        build: () => [
          monitorAck('ack', base + 200, 'm1', { persistent: false, timeoutMs: 1_800_000 }),
          textEv('a1', base + 300, 'watching'),
          durationEv('d1', base + 400),
          noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>line</result>\n</task-notification>'),
          noticeEv('n2', base + 5_100, '<task-notification>\n<summary>no id</summary>\n</task-notification>'),
        ],
      },
    ];

    for (const tc of cases) {
      const q = new BridgeTurnQueue();
      q.mark('om_main', 'start task', base, 'start task', 1);
      q.ingest([
        larkUserEv('u1', base + 100, 'start task'),
        ...tc.build(),
        textEv('a-wake', base + 90_000, 'wake output'),
        durationEv('d-wake', base + 90_100),
      ]);
      const ready = q.drainEmittable({ explicitTerminalOnly: true });
      const wake = ready.find(t => t.turnId === 'local-headless-a-wake');
      expect(wake, tc.name).toBeDefined();
      expect(wake?.wakeNonTerminalMonitor, tc.name).toBeUndefined();
    }
  });

  it('handles mixed-notice batches (both orderings), mid-turn folds, cross-attempt anchors, and mid-turn human prompts', () => {
    const base = Date.now() + 1_000;
    const runMixed = (order: 'mon-first' | 'agent-first') => {
      const q = new BridgeTurnQueue();
      q.mark('om_main', 'run both', base, 'run both', 1);
      const monNotice = noticeEv('n-mon', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>');
      const agentNotice = noticeEv('n-ag', base + 5_100, '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n</task-notification>');
      q.ingest([
        larkUserEv('u1', base + 100, 'run both'),
        monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
        bgAck('ack-ag1', base + 250, { isAsync: true, status: 'async_launched', agentId: 'ag1' }),
        textEv('a1', base + 300, 'running'),
        durationEv('d1', base + 400),
        ...(order === 'mon-first' ? [monNotice, agentNotice] : [agentNotice, monNotice]),
        textEv('a-wake', base + 5_500, 'subagent finished'),
        durationEv('d-wake', base + 5_600),
      ]);
      const wake = q.drainEmittable({ explicitTerminalOnly: true }).find(t => t.turnId === 'local-headless-a-wake');
      // Still routes back to om_main (same anchor), but MUST NOT be suppressed.
      expect(wake).toMatchObject({ isBackgroundWake: true, replyAnchorTurnId: 'om_main', replyAnchorDispatchAttempt: 1 });
      expect(wake?.wakeNonTerminalMonitor).toBeUndefined();
    };
    runMixed('mon-first');
    runMixed('agent-first');

    // Mid-turn attachment fold of terminal subagent AFTER first visible text disarms wakeNonTerminalMonitor.
    const qFold = new BridgeTurnQueue();
    qFold.mark('om_main', 'watch', base, 'watch', 1);
    qFold.ingest([
      larkUserEv('u1', base + 100, 'watch'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      bgAck('ack-ag1', base + 250, { isAsync: true, status: 'async_launched', agentId: 'ag1' }),
      textEv('a1', base + 300, 'ok'),
      durationEv('d1', base + 400),
      noticeEv('n-mon', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a-wake-1', base + 5_200, 'still waiting', 'tool_use'),
      attachedNoticeEv('att-ag1', base + 5_300, '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n</task-notification>'),
      textEv('a-wake-2', base + 5_400, 'agent done!'),
      durationEv('d-wake', base + 5_500),
    ]);
    const foldWake = qFold.drainEmittable({ explicitTerminalOnly: true }).find(t => t.turnId === 'local-headless-a-wake-1');
    expect(foldWake?.wakeNonTerminalMonitor).toBeUndefined();

    // Two non-terminal Monitors from different dispatchAttempts of the same turnId fail closed on anchor,
    // while keeping wakeNonTerminalMonitor: true because BOTH notices are non-terminal Monitors.
    const qCrossAttempt = new BridgeTurnQueue();
    qCrossAttempt.mark('om_same', 'first try', base, 'first try', 1);
    qCrossAttempt.ingest([
      larkUserEv('u1', base + 100, 'first try'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      textEv('a1', base + 300, 'try 1'),
      durationEv('d1', base + 400),
    ]);
    qCrossAttempt.mark('om_same', 'second try', base + 500, 'second try', 2);
    qCrossAttempt.ingest([
      larkUserEv('u2', base + 600, 'second try'),
      monitorAck('ack-m2', base + 700, 'm2', { persistent: false }),
      textEv('a2', base + 800, 'try 2'),
      durationEv('d2', base + 900),
      noticeEv('n-m1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick1</result>\n</task-notification>'),
      noticeEv('n-m2', base + 5_100, '<task-notification>\n<task-id>m2</task-id>\n<result>tick2</result>\n</task-notification>'),
      textEv('a-both', base + 5_200, 'waiting on both'),
      durationEv('d-both', base + 5_300),
    ]);
    const crossWake = qCrossAttempt.drainEmittable({ explicitTerminalOnly: true }).find(t => t.turnId === 'local-headless-a-both');
    expect(crossWake?.isBackgroundWake).toBeUndefined();
    expect(crossWake?.backgroundWakeUnrouted).toBe(true);
    expect(crossWake?.wakeNonTerminalMonitor).toBe(true);

    // Mid-turn human prompt folded into a Monitor wake disarms wakeNonTerminalMonitor.
    const qHumanFold = new BridgeTurnQueue();
    qHumanFold.mark('om_main', 'watch', base, 'watch', 1);
    qHumanFold.ingest([
      larkUserEv('u1', base + 100, 'watch'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      textEv('a1', base + 300, 'ok'),
      durationEv('d1', base + 400),
      noticeEv('n-mon', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a-wake-1', base + 5_200, 'checking', 'tool_use'),
      {
        type: 'attachment',
        uuid: 'att-human',
        timestamp: new Date(base + 5_300).toISOString(),
        renderedRole: 'system',
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '顺便看下日志' },
      } as unknown as TranscriptEvent,
      textEv('a-wake-2', base + 5_400, '好的，日志如下'),
      durationEv('d-wake', base + 5_500),
    ]);
    const humanFoldWake = qHumanFold.drainEmittable({ explicitTerminalOnly: true }).find(t => t.turnId === 'local-headless-a-wake-1');
    expect(humanFoldWake?.wakeNonTerminalMonitor).toBeUndefined();
  });

  it('tracks Monitor metadata without Lark anchor (local launch, absorb with liveSinceMs, seedBackgroundTasks, resetBackgroundTasks)', () => {
    const base = Date.now() + 1_000;
    // 1. Local terminal turn launches Monitor (no Lark anchor) -> still marks wakeNonTerminalMonitor.
    const qLocal = new BridgeTurnQueue();
    qLocal.ingest([
      larkUserEv('u-local', base + 100, 'terminal prompt'),
      monitorAck('ack-m1', base + 200, 'm-local', { persistent: false }),
      textEv('a1', base + 300, 'local watching'),
      durationEv('d1', base + 400),
      noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m-local</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a2', base + 5_100, 'still waiting'),
      durationEv('d2', base + 5_200),
    ]);
    const localReady = qLocal.drainEmittable({ explicitTerminalOnly: true });
    expect(localReady[0].turnId).toBe('local-u-local');
    expect(localReady[0].wakeNonTerminalMonitor).toBeUndefined();
    expect(localReady[1]).toMatchObject({
      turnId: 'local-headless-a2',
      wakeNonTerminalMonitor: true,
    });
    expect(localReady[1].isBackgroundWake).toBeUndefined();

    // 2. seedBackgroundTasks() after re-attach & resetBackgroundTasks() on CLI respawn.
    const qSeed = new BridgeTurnQueue();
    qSeed.seedBackgroundTasks([{ taskId: 'm-reattach', kind: 'monitor', persistent: false, expiresAtMs: base + 1_800_000 }]);
    qSeed.ingest([
      noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m-reattach</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a1', base + 5_100, 'waiting'),
      durationEv('d1', base + 5_200),
    ]);
    expect(qSeed.drainEmittable({ explicitTerminalOnly: true })[0]?.wakeNonTerminalMonitor).toBe(true);
    qSeed.resetBackgroundTasks();
    qSeed.ingest([
      noticeEv('n2', base + 6_000, '<task-notification>\n<task-id>m-reattach</task-id>\n<result>tick2</result>\n</task-notification>'),
      textEv('a2', base + 6_100, 'after respawn'),
      durationEv('d2', base + 6_200),
    ]);
    expect(qSeed.drainEmittable({ explicitTerminalOnly: true })[0]?.wakeNonTerminalMonitor).toBeUndefined();

    // 3. absorb() respects liveSinceMs floor so dead-CLI Monitors are not seeded on /resume.
    const qAbsorb = new BridgeTurnQueue();
    qAbsorb.absorb(
      [
        monitorAck('ack-dead', base - 60_000, 'm-dead', { persistent: false }),
        monitorAck('ack-live', base + 100, 'm-live', { persistent: false }),
      ],
      { liveSinceMs: base },
    );
    qAbsorb.ingest([
      noticeEv('n-dead', base + 5_000, '<task-notification>\n<task-id>m-dead</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a-dead', base + 5_100, 'dead'),
      durationEv('d-dead', base + 5_200),
      noticeEv('n-live', base + 6_000, '<task-notification>\n<task-id>m-live</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a-live', base + 6_100, 'live'),
      durationEv('d-live', base + 6_200),
    ]);
    const absorbedReady = qAbsorb.drainEmittable({ explicitTerminalOnly: true });
    expect(absorbedReady[0]?.wakeNonTerminalMonitor).toBeUndefined();
    expect(absorbedReady[1]?.wakeNonTerminalMonitor).toBe(true);
  });

  it('streams leading thinking/tool_use/tool_result and text-less Monitor wakes to pendingWakeObserver with exact (turnId, dispatchAttempt) without early synthesis or duplicates', () => {
    const base = Date.now() + 1_000;
    const q = new BridgeTurnQueue();
    q.mark('om_main', '盯一下 CI', base, '盯一下 CI', 2);
    const activityEvents: Array<{ uuid?: string; anchor: { turnId: string; dispatchAttempt?: number } }> = [];
    const attributedEvents: Array<{ uuid?: string; turnId: string }> = [];
    const textlessFlushes: Array<{ turnId: string; dispatchAttempt?: number }> = [];

    q.ingest(
      [
        larkUserEv('u1', base + 100, '盯一下 CI'),
        monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
        textEv('a1', base + 300, '开始盯 CI'),
        durationEv('d1', base + 400),
      ],
      undefined,
      (ev, turn) => attributedEvents.push({ uuid: ev.uuid, turnId: turn.turnId }),
    );
    expect(q.drainEmittable({ explicitTerminalOnly: true }).map(t => t.turnId)).toEqual(['om_main']);

    // Wake 1: leading thinking -> tool_use -> tool_result -> text -> duration.
    // Also includes a stray pre-assistant tool_result (must be ignored) and a combined thinking+text record (must go ONLY to onAssistantAttributed, not duplicate).
    q.ingest(
      [
        noticeEv('n1', base + 10_000, '<task-notification>\n<task-id>m1</task-id>\n<result>job 1/3 done</result>\n</task-notification>'),
        {
          type: 'user',
          uuid: 'stray-tr',
          timestamp: ts(base, 10_050),
          isSidechain: false,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'stray' }] },
        } as TranscriptEvent,
        {
          type: 'assistant',
          uuid: 'w1-think',
          timestamp: ts(base, 10_100),
          isSidechain: false,
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: '检查构建状态' }] },
        } as TranscriptEvent,
        {
          type: 'assistant',
          uuid: 'w1-tool',
          timestamp: ts(base, 10_200),
          isSidechain: false,
          message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-check', name: 'Bash', input: { command: 'echo ok' } }] },
        } as TranscriptEvent,
        {
          type: 'user',
          uuid: 'w1-tr',
          timestamp: ts(base, 10_300),
          isSidechain: false,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-check', content: 'ok' }] },
        } as TranscriptEvent,
        {
          type: 'assistant',
          uuid: 'w1-text',
          timestamp: ts(base, 10_400),
          isSidechain: false,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '继续等' }, { type: 'text', text: '继续等待…' }] },
        } as TranscriptEvent,
        durationEv('w1-dur', base + 10_500),
      ],
      undefined,
      (ev, turn) => attributedEvents.push({ uuid: ev.uuid, turnId: turn.turnId }),
      undefined,
      {
        onActivity: (ev, anchor) => activityEvents.push({ uuid: ev.uuid, anchor }),
        onTextlessComplete: anchor => textlessFlushes.push(anchor),
      },
    );

    expect(activityEvents).toEqual([
      { uuid: 'w1-think', anchor: { turnId: 'om_main', dispatchAttempt: 2 } },
      { uuid: 'w1-tool', anchor: { turnId: 'om_main', dispatchAttempt: 2 } },
      { uuid: 'w1-tr', anchor: { turnId: 'om_main', dispatchAttempt: 2 } },
    ]);
    expect(attributedEvents.filter(e => e.turnId === 'local-headless-w1-text')).toEqual([
      { uuid: 'w1-text', turnId: 'local-headless-w1-text' },
    ]);
    expect(textlessFlushes).toEqual([]);
    const w1Ready = q.drainEmittable({ explicitTerminalOnly: true });
    expect(w1Ready.map(t => t.turnId)).toEqual(['local-headless-w1-text']);

    // Wake 2: text-less Monitor micro-turn (thinking only, closed by turn_duration) -> NO headless turn, DOES flush onTextlessComplete!
    activityEvents.length = 0;
    q.ingest(
      [
        noticeEv('n2', base + 20_000, '<task-notification>\n<task-id>m1</task-id>\n<result>job 2/3 done</result>\n</task-notification>'),
        {
          type: 'assistant',
          uuid: 'w2-think',
          timestamp: ts(base, 20_100),
          isSidechain: false,
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: '还在跑，无需说话' }] },
        } as TranscriptEvent,
        durationEv('w2-dur', base + 20_200),
      ],
      undefined,
      undefined,
      undefined,
      {
        onActivity: (ev, anchor) => activityEvents.push({ uuid: ev.uuid, anchor }),
        onTextlessComplete: anchor => textlessFlushes.push(anchor),
      },
    );
    expect(q.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
    expect(activityEvents).toEqual([{ uuid: 'w2-think', anchor: { turnId: 'om_main', dispatchAttempt: 2 } }]);
    expect(textlessFlushes).toEqual([{ turnId: 'om_main', dispatchAttempt: 2 }]);
  });

  it('ignores api-request-blob records even if they carry a uuid', () => {
    const base = Date.now() + 1_000;
    const q = new BridgeTurnQueue();
    q.mark('om_1', 'hello', base, 'hello', 1);
    q.ingest([
      {
        type: 'api-request-blob',
        uuid: 'blob-u',
        timestamp: ts(base, 50),
        message: { role: 'user', content: 'hello' },
      } as unknown as TranscriptEvent,
      larkUserEv('u1', base + 100, 'hello'),
      {
        type: 'api-request-blob',
        uuid: 'blob-a',
        timestamp: ts(base, 150),
        message: { role: 'assistant', content: [{ type: 'text', text: 'copied reply' }] },
      } as unknown as TranscriptEvent,
      textEv('a1', base + 200, 'real reply'),
      durationEv('d1', base + 300),
    ]);
    const ready = q.drainEmittable({ explicitTerminalOnly: true });
    expect(ready).toHaveLength(1);
    expect(ready[0].turnId).toBe('om_1');
    expect(ready[0].assistantUuids).toEqual(['a1']);
  });

  it('disarms wakeNonTerminalMonitor on mid-wake TaskStop and TUI kill, and retires settled Monitors from metadata', () => {
    const base = Date.now() + 1_000;
    const q = new BridgeTurnQueue();
    q.mark('om_main', 'watch CI', base, 'watch CI', 1);
    q.ingest([
      larkUserEv('u1', base + 100, 'watch CI'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false, timeoutMs: 1_800_000 }),
      textEv('a1', base + 300, 'watching'),
      durationEv('d1', base + 400),
      // Non-terminal tick arrives -> model calls TaskStop(m1) -> writes final failure report!
      noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>BUILD FAILED</result>\n</task-notification>'),
      {
        type: 'assistant', uuid: 'a-stop', timestamp: ts(base, 5_100), isSidechain: false,
        message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-stop', name: 'TaskStop', input: { task_id: 'm1' } }] },
      } as TranscriptEvent,
      {
        type: 'user', uuid: 'u-stop', timestamp: ts(base, 5_200), isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-stop', content: 'stopped' }] },
        toolUseResult: { task_id: 'm1', task_type: 'monitor' },
      } as TranscriptEvent,
      textEv('a-report', base + 5_300, 'CI 构建失败，已停止监控'),
      durationEv('d-report', base + 5_400),
      // Late buffered status-less notice after TaskStop must also fail open (metadata retired).
      noticeEv('n-late', base + 6_000, '<task-notification>\n<task-id>m1</task-id>\n<result>trailing line</result>\n</task-notification>'),
      textEv('a-late', base + 6_100, '补充一条日志'),
      durationEv('d-late', base + 6_200),
    ]);
    const ready = q.drainEmittable({ explicitTerminalOnly: true });
    expect(ready.find(t => t.turnId === 'local-headless-a-report')?.wakeNonTerminalMonitor).toBeUndefined();
    expect(ready.find(t => t.turnId === 'local-headless-a-late')?.wakeNonTerminalMonitor).toBeUndefined();

    // TUI kill (queue-operation enqueue with killed) mid-wake disarms the active wake.
    const qKill = new BridgeTurnQueue();
    qKill.mark('om_main', 'watch CI', base, 'watch CI', 1);
    qKill.ingest([
      larkUserEv('u1', base + 100, 'watch CI'),
      monitorAck('ack-m2', base + 200, 'm2', { persistent: false, timeoutMs: 1_800_000 }),
      textEv('a1', base + 300, 'watching'),
      durationEv('d1', base + 400),
      noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m2</task-id>\n<result>step 2</result>\n</task-notification>'),
      textEv('a-mid', base + 5_100, '正在检查', 'tool_use'),
      {
        type: 'queue-operation', operation: 'enqueue', timestamp: ts(base, 5_150),
        content: '<task-notification>\n<task-id>m2</task-id>\n<status>killed</status>\n</task-notification>',
      } as TranscriptEvent,
      textEv('a-end', base + 5_200, '监控已被手动停止'),
      durationEv('d-end', base + 5_300),
    ]);
    expect(qKill.drainEmittable({ explicitTerminalOnly: true }).find(t => t.turnId === 'local-headless-a-mid')?.wakeNonTerminalMonitor).toBeUndefined();
  });

  it('promotes a mid-turn absorbed human Lark turn folded into a running Monitor wake instead of burying it', () => {
    const base = Date.now() + 1_000;
    const q = new BridgeTurnQueue();
    q.mark('om_t1', '盯 CI', base, '盯 CI', 1);
    q.ingest([
      larkUserEv('u1', base + 100, '盯 CI'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      textEv('a1', base + 300, '开始盯'),
      durationEv('d1', base + 400),
    ]);
    q.drainEmittable({ explicitTerminalOnly: true });

    // Monitor wake starts, then human sends om_t2 mid-wake (folded as system-rendered queued_command).
    q.mark('om_t2', '帮我看下 package.json', base + 5_050, '帮我看下 package.json', 1);
    q.ingest([
      noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a-w1', base + 5_100, '检查中', 'tool_use'),
      {
        type: 'attachment',
        uuid: 'att-t2',
        timestamp: ts(base, 5_200),
        renderedRole: 'system',
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '帮我看下 package.json' },
      } as unknown as TranscriptEvent,
      textEv('a-t2', base + 5_300, 'package.json 名称是 botmux'),
      durationEv('d-end', base + 5_400),
    ]);
    const ready = q.drainEmittable({ explicitTerminalOnly: true });
    const wakeTurn = ready.find(t => t.turnId === 'local-headless-a-w1');
    const humanTurn = ready.find(t => t.turnId === 'om_t2');
    expect(wakeTurn?.wakeNonTerminalMonitor).toBe(true);
    expect(humanTurn).toMatchObject({
      turnId: 'om_t2',
      started: true,
      assistantUuids: ['a-t2'],
    });
    expect(humanTurn?.absorbedIntoTurnId).toBeUndefined();
    expect(humanTurn?.wakeNonTerminalMonitor).toBeUndefined();
  });

  it('keeps fail-open order-independent, respects closedByDurationMarker, handles omitted attachment commandMode, fails open on missing timestamps, and supports markerless turns + pre-text CoT flush', () => {
    const base = Date.now() + 1_000;

    // 1. [id-less, Monitor] order poisons pendingBackgroundWake even when initially undefined.
    const qOrder1 = new BridgeTurnQueue();
    qOrder1.mark('om_1', 'watch', base, 'watch', 1);
    qOrder1.ingest([
      larkUserEv('u1', base + 100, 'watch'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      textEv('a1', base + 300, 'watching'),
      durationEv('d1', base + 400),
      noticeEv('n-idless', base + 5_000, '<task-notification>\n<status>completed</status>\n</task-notification>'),
      noticeEv('n-mon', base + 5_050, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a-wake', base + 5_100, 'combined answer'),
      durationEv('d-wake', base + 5_200),
    ]);
    expect(qOrder1.drainEmittable({ explicitTerminalOnly: true }).find(t => t.turnId === 'local-headless-a-wake')?.wakeNonTerminalMonitor).toBeUndefined();

    // 2. [attachment(task-notification), Monitor] while idle also poisons pendingBackgroundWake.
    const qOrder2 = new BridgeTurnQueue();
    qOrder2.mark('om_1', 'watch', base, 'watch', 1);
    qOrder2.ingest([
      larkUserEv('u1', base + 100, 'watch'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      bgAck('ack-ag1', base + 210, { isAsync: true, status: 'async_launched', agentId: 'ag1' }),
      textEv('a1', base + 300, 'watching'),
      durationEv('d1', base + 400),
      attachedNoticeEv('att-ag', base + 5_000, '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n</task-notification>'),
      noticeEv('n-mon', base + 5_050, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a-wake', base + 5_100, 'combined answer'),
      durationEv('d-wake', base + 5_200),
    ]);
    expect(qOrder2.drainEmittable({ explicitTerminalOnly: true }).find(t => t.turnId === 'local-headless-a-wake')?.wakeNonTerminalMonitor).toBeUndefined();

    // 3. Same-batch trailing event after turn_duration does NOT retroactively disarm closed Wake 1.
    const qClosed = new BridgeTurnQueue();
    qClosed.mark('om_1', 'watch', base, 'watch', 1);
    qClosed.ingest([
      larkUserEv('u1', base + 100, 'watch'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      textEv('a1', base + 300, 'watching'),
      durationEv('d1', base + 400),
      noticeEv('n-m1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick 1</result>\n</task-notification>'),
      textEv('a-w1', base + 5_100, 'routine waiting'),
      durationEv('d-w1', base + 5_200),
      // Trailing attachment with omitted commandMode after d-w1 must NOT mutate closed Wake 1.
      {
        type: 'attachment', uuid: 'att-after', timestamp: ts(base, 5_300), isSidechain: false,
        attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>ag-other</task-id>\n<status>completed</status>\n</task-notification>' },
      } as unknown as TranscriptEvent,
      noticeEv('n-m2', base + 5_350, '<task-notification>\n<task-id>m1</task-id>\n<result>tick 2</result>\n</task-notification>'),
      textEv('a-w2', base + 5_400, 'wake 2 with ag-other'),
      durationEv('d-w2', base + 5_500),
    ]);
    const closedReady = qClosed.drainEmittable({ explicitTerminalOnly: true });
    expect(closedReady.find(t => t.turnId === 'local-headless-a-w1')).toMatchObject({ wakeNonTerminalMonitor: true, isBackgroundWake: true });
    expect(closedReady.find(t => t.turnId === 'local-headless-a-w2')?.wakeNonTerminalMonitor).toBeUndefined();

    // 3b. Same-batch trailing absorbed human prompt after turn_duration must NOT retroactively disarm closed Wake 1.
    const qClosedHuman = new BridgeTurnQueue();
    qClosedHuman.mark('om_1', 'watch', base, 'watch', 1);
    qClosedHuman.ingest([
      larkUserEv('u1', base + 100, 'watch'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      textEv('a1', base + 300, 'watching'),
      durationEv('d1', base + 400),
      noticeEv('n-m1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick 1</result>\n</task-notification>'),
      textEv('a-w1', base + 5_100, 'routine waiting'),
      durationEv('d-w1', base + 5_200),
      {
        type: 'attachment', uuid: 'att-human-after-dur', timestamp: ts(base, 5_300),
        renderedRole: 'system',
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '顺便看下状态' },
      } as unknown as TranscriptEvent,
    ]);
    expect(qClosedHuman.drainEmittable({ explicitTerminalOnly: true }).find(t => t.turnId === 'local-headless-a-w1')?.wakeNonTerminalMonitor).toBe(true);

    // 4. Attachment with omitted commandMode folded mid-turn disarms collecting Monitor wake.
    const qOmittedMode = new BridgeTurnQueue();
    qOmittedMode.mark('om_1', 'watch', base, 'watch', 1);
    qOmittedMode.ingest([
      larkUserEv('u1', base + 100, 'watch'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      textEv('a1', base + 300, 'watching'),
      durationEv('d1', base + 400),
      noticeEv('n-m1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a-w1', base + 5_100, 'checking', 'tool_use'),
      {
        type: 'attachment', uuid: 'att-no-mode', timestamp: ts(base, 5_150), isSidechain: false,
        attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n</task-notification>' },
      } as unknown as TranscriptEvent,
      textEv('a-w2', base + 5_200, 'subagent finished'),
      durationEv('d-w', base + 5_300),
    ]);
    expect(qOmittedMode.drainEmittable({ explicitTerminalOnly: true }).find(t => t.turnId === 'local-headless-a-w1')?.wakeNonTerminalMonitor).toBeUndefined();

    // 5. Missing timestamp on Monitor notice fails open when Monitor has expiresAtMs;
    // absorb({ liveSinceMs }) ignores untimestamped launches and retires settled tasks.
    const qTs = new BridgeTurnQueue();
    qTs.absorb([
      { ...monitorAck('ack-notime', base + 100, 'm-notime', { persistent: false }), timestamp: undefined } as TranscriptEvent,
      monitorAck('ack-settled', base + 100, 'm-settled', { persistent: false }),
      {
        type: 'user', uuid: 'stop-settled', timestamp: ts(base, 150), isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-s', content: 'stopped' }] },
        toolUseResult: { task_id: 'm-settled', task_type: 'monitor' },
      } as TranscriptEvent,
      monitorAck('ack-bounded', base + 200, 'm-bounded', { persistent: false, timeoutMs: 60_000 }),
    ], { liveSinceMs: base });
    qTs.ingest([
      noticeEv('n-nt', base + 5_000, '<task-notification>\n<task-id>m-notime</task-id>\n<result>t</result>\n</task-notification>'),
      textEv('a-nt', base + 5_100, 'nt'), durationEv('d-nt', base + 5_200),
      noticeEv('n-st', base + 6_000, '<task-notification>\n<task-id>m-settled</task-id>\n<result>t</result>\n</task-notification>'),
      textEv('a-st', base + 6_100, 'st'), durationEv('d-st', base + 6_200),
      { ...noticeEv('n-bm', base + 7_000, '<task-notification>\n<task-id>m-bounded</task-id>\n<result>t</result>\n</task-notification>'), timestamp: undefined } as TranscriptEvent,
      textEv('a-bm', base + 7_100, 'bm'), durationEv('d-bm', base + 7_200),
    ]);
    const tsReady = qTs.drainEmittable({ explicitTerminalOnly: true });
    expect(tsReady.every(t => t.wakeNonTerminalMonitor === undefined)).toBe(true);

    // 6. Markerless transcript (durationMarkerWaitExpired) opens Monitor wake after end_turn before idle pop.
    const qMarkerless = new BridgeTurnQueue();
    qMarkerless.mark('om_1', 'watch', base, 'watch', 1);
    qMarkerless.noteDurationMarkerWaitExpired();
    qMarkerless.ingest([
      larkUserEv('u1', base + 100, 'watch'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      textEv('a1', base + 300, 'watching', 'end_turn'),
      noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      textEv('a-w1', base + 5_100, 'still waiting', 'end_turn'),
    ]);
    const mlReady = qMarkerless.drainEmittable({ explicitTerminalOnly: true });
    expect(mlReady.find(t => t.turnId === 'local-headless-a-w1')?.wakeNonTerminalMonitor).toBe(true);

    // 7. Pre-text Monitor wake that emitted leading CoT preserves sticky cotAnchor when unrouted,
    // and flushes via onTextlessComplete on disarmed text-less turn_duration and pre-text API error.
    const qCot = new BridgeTurnQueue();
    qCot.mark('om_1', 'watch', base, 'watch', 4);
    const flushes: Array<{ turnId: string; dispatchAttempt?: number }> = [];
    const obs = {
      onActivity: () => {},
      onTextlessComplete: (anchor: { turnId: string; dispatchAttempt?: number }) => flushes.push(anchor),
    };
    qCot.ingest([
      larkUserEv('u1', base + 100, 'watch'),
      monitorAck('ack-m1', base + 200, 'm1', { persistent: false }),
      textEv('a1', base + 300, 'watching'),
      durationEv('d1', base + 400),
    ], undefined, undefined, undefined, obs);
    qCot.drainEmittable({ explicitTerminalOnly: true });
    // Case 7a: leading thinking -> unknown terminal notice (unroutes anchor) -> text -> cotAnchor preserved!
    qCot.ingest([
      noticeEv('n1', base + 5_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      { type: 'assistant', uuid: 'th1', timestamp: ts(base, 5_100), isSidechain: false, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'leading' }] } } as TranscriptEvent,
      attachedNoticeEv('att-unk', base + 5_150, '<task-notification>\n<task-id>unknown-x</task-id>\n<status>completed</status>\n</task-notification>'),
      textEv('a-u1', base + 5_200, 'merged'),
      durationEv('d-u1', base + 5_300),
    ], undefined, undefined, undefined, obs);
    const unroutedWake = qCot.drainEmittable({ explicitTerminalOnly: true })[0];
    expect(unroutedWake?.replyAnchorTurnId).toBeUndefined();
    expect(unroutedWake?.cotAnchor).toEqual({ turnId: 'om_1', dispatchAttempt: 4 });
    // Case 7b: text-less disarmed wake -> flushes onTextlessComplete at turn_duration!
    qCot.ingest([
      noticeEv('n2', base + 6_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      { type: 'assistant', uuid: 'th2', timestamp: ts(base, 6_100), isSidechain: false, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'disarmed textless' }] } } as TranscriptEvent,
      attachedNoticeEv('att-unk2', base + 6_150, '<task-notification>\n<task-id>unknown-y</task-id>\n<status>completed</status>\n</task-notification>'),
      durationEv('d-u2', base + 6_200),
    ], undefined, undefined, undefined, obs);
    // Case 7c: pre-text API error -> flushes onTextlessComplete!
    qCot.ingest([
      noticeEv('n3', base + 7_000, '<task-notification>\n<task-id>m1</task-id>\n<result>tick</result>\n</task-notification>'),
      { type: 'assistant', uuid: 'th3', timestamp: ts(base, 7_100), isSidechain: false, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'before error' }] } } as TranscriptEvent,
      { type: 'assistant', uuid: 'err3', timestamp: ts(base, 7_150), isSidechain: false, isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 500' }] } } as TranscriptEvent,
    ], undefined, undefined, undefined, obs);
    expect(flushes).toEqual([
      { turnId: 'om_1', dispatchAttempt: 4 },
      { turnId: 'om_1', dispatchAttempt: 4 },
    ]);
  });
});
