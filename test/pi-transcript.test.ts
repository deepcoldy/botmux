/**
 * Unit tests for Pi's per-session JSONL transcript drain (drainPiTranscript).
 *
 * Focus: the turn-terminal contract that re-enables type-ahead. Record shapes
 * mirror real pi 0.80.6 transcripts captured live:
 *   - stopReason lives on `message.stopReason` (not the top-level record).
 *   - a turn is assistant(toolUse) → toolResult pairs closed by ONE assistant
 *     record whose stopReason ∈ {stop, length, error, aborted}.
 *   - error/aborted finals carry EMPTY content but MUST still emit so the
 *     type-ahead queue head (CodexBridgeQueue) is released, never wedged.
 *   - queued/steered input writes its user record at dequeue time (user1 →
 *     tools → user2 → single assistant_final).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { drainPiTranscript, type PiBridgeEvent } from '../src/services/pi-transcript.js';

const ROOT = join(tmpdir(), `botmux-pi-transcript-test-${process.pid}`);
const SESSION_ID = 'eef935b5-4201-4e59-8bc7-06f03aa3388c';

/** Write JSONL records to a path that matches Pi's on-disk naming so
 *  piSessionIdFromPath can extract sourceSessionId (…_<uuid>.jsonl). */
function writeTranscript(records: object[]): string {
  const dir = join(ROOT, '--tmp-pi-probe--');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-08-03T05-13-01-270Z_${SESSION_ID}.jsonl`);
  writeFileSync(path, records.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return path;
}

const sessionHeader = () => ({ type: 'session', version: 1, id: SESSION_ID, timestamp: '2026-08-03T05:13:00.000Z', cwd: '/tmp/x' });

function userMsg(text: string, ts = '2026-08-03T05:13:39.839Z') {
  return { type: 'message', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}
/** Mid-turn assistant: a tool call. Never a boundary. */
function assistantToolUse(ts = '2026-08-03T05:13:42.051Z') {
  return {
    type: 'message', timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'thinking', text: '…' }, { type: 'toolCall', name: 'bash' }], stopReason: 'toolUse' },
  };
}
function toolResult(text: string, ts = '2026-08-03T05:14:04.060Z') {
  return { type: 'message', timestamp: ts, message: { role: 'toolResult', content: [{ type: 'text', text }] } };
}
/** Terminal assistant record. stopReason on message (real shape). */
function assistantFinal(stopReason: string, text: string, ts = '2026-08-03T05:14:05.024Z', errorMessage?: string) {
  const content = text ? [{ type: 'text', text }] : [];
  return {
    type: 'message', timestamp: ts,
    message: { role: 'assistant', content, stopReason, ...(errorMessage ? { errorMessage } : {}) },
  };
}
/** Assistant message that carries BOTH a terminal-looking stopReason AND a tool
 *  call — Pi's loop keeps running here (a truncated `length` fails its calls and
 *  loops; a `stop` with calls is a normal tool step), so it is NOT a boundary. */
function assistantTerminalWithTool(stopReason: string, ts = '2026-08-03T05:13:50.000Z') {
  return {
    type: 'message', timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }, { type: 'toolCall', name: 'bash' }], stopReason },
  };
}

function drainAll(path: string): PiBridgeEvent[] {
  return drainPiTranscript(path, 0).events;
}

describe('drainPiTranscript: turn terminal contract', () => {
  beforeEach(() => { rmSync(ROOT, { recursive: true, force: true }); });
  afterEach(() => { rmSync(ROOT, { recursive: true, force: true }); });

  it('emits user + a single assistant_final on stopReason:stop (normal turn)', () => {
    const path = writeTranscript([
      sessionHeader(),
      userMsg('Reply with ALPHA'),
      assistantToolUse(),
      toolResult('done'),
      assistantFinal('stop', 'ALPHA'),
    ]);
    const events = drainAll(path);
    expect(events.map((e) => e.kind)).toEqual(['user', 'assistant_final']);
    const [user, final] = events;
    expect(user.text).toBe('Reply with ALPHA');
    expect(final.text).toBe('ALPHA');
    expect(final.sourceSessionId).toBe(SESSION_ID);
    // stop → completed default: no explicit terminalStatus (empty-final
    // fallback + historical behavior preserved).
    expect(final.terminalStatus).toBeUndefined();
    expect(final.terminalErrorCode).toBeUndefined();
  });

  it('does NOT emit for a mid-turn toolUse assistant record (only the terminal record closes)', () => {
    const path = writeTranscript([
      sessionHeader(),
      userMsg('do work'),
      assistantToolUse('2026-08-03T05:13:42.000Z'),
      toolResult('r1'),
      assistantToolUse('2026-08-03T05:13:44.000Z'),
      toolResult('r2'),
    ]);
    // No terminal record yet: exactly one user event, no assistant_final.
    const events = drainAll(path);
    expect(events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'user')).toHaveLength(1);
  });

  it('emits assistant_final on stopReason:aborted with EMPTY text → ambiguous/pi_turn_aborted (releases the queue head)', () => {
    // Real captured shape: user → toolUse → toolResult("Command aborted") →
    // assistant(stopReason:aborted, content:[], errorMessage:"Operation aborted").
    const path = writeTranscript([
      sessionHeader(),
      userMsg('sleep 40 && echo NEVER'),
      assistantToolUse(),
      toolResult('Command aborted'),
      assistantFinal('aborted', '', '2026-08-03T05:14:05.000Z', 'Operation aborted'),
    ]);
    const finals = drainAll(path).filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('');
    // ambiguous (not failed): Esc may land after a tool side effect ran.
    expect(finals[0].terminalStatus).toBe('ambiguous');
    expect(finals[0].terminalErrorCode).toBe('pi_turn_aborted');
  });

  it('classifies a stopReason:error record via its errorMessage → failed/codex_upstream_error + redacted summary (model-gateway outage)', () => {
    // Real captured shape (pi 0.84.2, live incident): the model gateway
    // cancelled the stream mid-turn; errorMessage sits on `message`.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('trigger a backend error'),
      assistantFinal('error', '', '2026-08-03T05:14:05.000Z',
        'upstream stream error: rpc error: code = 1 desc = Cancelled by backend [biz error]'),
    ]);
    const finals = drainAll(path).filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].terminalStatus).toBe('failed');
    // Shared Codex-family classifier: gateway/upstream failure, NOT the
    // opaque pi_turn_error → the failure card names the real cause.
    expect(finals[0].terminalErrorCode).toBe('codex_upstream_error');
    expect(finals[0].terminalErrorSummary).toContain('Cancelled by backend');
  });

  it('keeps failed/pi_turn_error (no summary) when the error record has NO errorMessage', () => {
    const path = writeTranscript([
      sessionHeader(),
      userMsg('trigger a backend error'),
      assistantFinal('error', '', '2026-08-03T05:14:05.000Z'),
    ]);
    const finals = drainAll(path).filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].terminalStatus).toBe('failed');
    expect(finals[0].terminalErrorCode).toBe('pi_turn_error');
    expect(finals[0].terminalErrorSummary).toBeUndefined();
  });

  it('emits assistant_final on stopReason:length as a completed (truncated) answer', () => {
    const path = writeTranscript([
      sessionHeader(),
      userMsg('write a very long essay'),
      assistantFinal('length', 'Partial answer that hit the token cap'),
    ]);
    const finals = drainAll(path).filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('Partial answer that hit the token cap');
    // length is a real answer → completed default (no failed status).
    expect(finals[0].terminalStatus).toBeUndefined();
  });

  it('does NOT close the turn on a LENGTH message that still carries tool calls (Pi fails truncated calls and loops)', () => {
    // A `length` whose message has tool calls: Pi runs
    // failToolCallsFromTruncatedMessage → terminate:false and KEEPS looping.
    // Not a boundary; only the later terminal record closes the turn.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('do a big multi-step task'),
      assistantTerminalWithTool('length', '2026-08-03T05:13:50.000Z'),
      toolResult('tool failed: truncated args'),
      assistantToolUse('2026-08-03T05:13:55.000Z'),
      toolResult('ok'),
      assistantFinal('stop', 'All done'),
    ]);
    const finals = drainAll(path).filter((e) => e.kind === 'assistant_final');
    // Exactly ONE final — the tool-call-free `stop` at the end. The mid-turn
    // `length`+toolCall record is skipped.
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('All done');
    expect(finals[0].terminalStatus).toBeUndefined();
  });

  it('does NOT close the turn on a STOP message that carries a tool call (agent-loop keeps looping)', () => {
    // A `stop`+toolCall enters executeToolCalls; unless the batch returns
    // terminate:true the agent loops and the REAL final comes later. Emitting on
    // the stop+toolCall would publish a premature final and orphan the true one,
    // breaking type-ahead attribution — so it must be skipped (only a
    // tool-call-free terminal closes the turn).
    const path = writeTranscript([
      sessionHeader(),
      userMsg('run a tool then answer'),
      assistantTerminalWithTool('stop', '2026-08-03T05:13:50.000Z'),
      toolResult('tool output'),
      assistantFinal('stop', 'Final answer'),
    ]);
    const finals = drainAll(path).filter((e) => e.kind === 'assistant_final');
    // Exactly ONE final — the tool-call-free `stop`. The stop+toolCall is skipped.
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('Final answer');
    expect(finals[0].terminalStatus).toBeUndefined();
  });

  it('steer-merge shape: user1 → tools → user2 (dequeue time) → one assistant_final', () => {
    // Verified live on pi 0.80.6: a message submitted while busy is steered into
    // the active turn; its user record is written at dequeue time and the turn
    // emits ONE final. The drain surfaces both user events + the single final;
    // CodexBridgeQueue's HOL-drop attributes the final to the newest turn.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('slow first turn', '2026-08-03T05:13:39.000Z'),
      assistantToolUse('2026-08-03T05:13:42.000Z'),
      toolResult('FIRST_TURN_DONE', '2026-08-03T05:14:04.000Z'),
      // user2 written at dequeue time (same ts as the unblocking toolResult).
      userMsg('queued while busy', '2026-08-03T05:14:04.060Z'),
      assistantFinal('stop', 'SECOND_QUEUED_REPLY', '2026-08-03T05:14:05.000Z'),
    ]);
    const events = drainAll(path);
    expect(events.map((e) => e.kind)).toEqual(['user', 'user', 'assistant_final']);
    expect(events[1].text).toBe('queued while busy');
    expect(events[2].text).toBe('SECOND_QUEUED_REPLY');
  });

  it('ignores non-message rows and bashExecution/toolResult roles', () => {
    const path = writeTranscript([
      sessionHeader(),
      { type: 'model_change', provider: 'p', modelId: 'm' },
      { type: 'thinking_level_change', thinkingLevel: 'medium' },
      { type: 'message', timestamp: '2026-08-03T05:13:00.100Z', message: { role: 'bashExecution', content: null } },
      userMsg('hi'),
      assistantFinal('stop', 'hello'),
    ]);
    const events = drainAll(path);
    expect(events.map((e) => e.kind)).toEqual(['user', 'assistant_final']);
  });

  it('is incremental + uuid-stable: re-draining from the new offset yields no duplicates', () => {
    const records = [
      sessionHeader(),
      userMsg('m1'),
      assistantFinal('stop', 'r1'),
    ];
    const path = writeTranscript(records);
    const first = drainPiTranscript(path, 0);
    expect(first.events).toHaveLength(2);
    // Re-drain from the advanced offset: nothing new.
    const second = drainPiTranscript(path, first.newOffset);
    expect(second.events).toHaveLength(0);
    expect(second.newOffset).toBe(first.newOffset);
    // uuids are <path>:<byteOffset> — stable and unique per record.
    expect(new Set(first.events.map((e) => e.uuid)).size).toBe(2);
  });

  it('reads only complete lines; a partial trailing line is left as pendingTail', () => {
    const path = writeTranscript([sessionHeader(), userMsg('m1'), assistantFinal('stop', 'r1')]);
    // Append a partial (newline-less) record; the drain must not parse it.
    writeFileSync(path, JSON.stringify(sessionHeader()) + '\n'
      + JSON.stringify(userMsg('m1')) + '\n'
      + JSON.stringify(assistantFinal('stop', 'r1')) + '\n'
      + '{"type":"message","message":{"role":"assis');
    const result = drainPiTranscript(path, 0);
    expect(result.events.map((e) => e.kind)).toEqual(['user', 'assistant_final']);
    expect(result.pendingTail.startsWith('{"type":"message"')).toBe(true);
  });
});
