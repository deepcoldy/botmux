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
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { drainPiTranscript, resetPiPendingTurnState, PI_TURN_BOUNDARY_TIMEOUT_MS, type PiBridgeEvent } from '../src/services/pi-transcript.js';
import { PI_TURN_BOUNDARY_CUSTOM_TYPE } from '../src/adapters/cli/pi-turn-boundary-extension.js';

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

/** Turn-boundary marker written by pi-turn-boundary-extension on agent_settled.
 *  `lastStopReason` is the final assistant stopReason of the settled turn. */
function turnSettled(lastStopReason: string | null, ts = '2026-08-03T05:14:06.000Z') {
  return { type: 'custom', timestamp: ts, customType: PI_TURN_BOUNDARY_CUSTOM_TYPE, data: { lastStopReason } };
}

function drainAll(path: string): PiBridgeEvent[] {
  return drainPiTranscript(path, 0).events;
}

describe('drainPiTranscript: turn terminal contract', () => {
  // Held-error state is keyed by transcript path and every case here reuses the
  // same path, so it must be cleared or one case's held error leaks into the
  // next and silently changes what is being asserted.
  beforeEach(() => { rmSync(ROOT, { recursive: true, force: true }); resetPiPendingTurnState(); });
  afterEach(() => { rmSync(ROOT, { recursive: true, force: true }); resetPiPendingTurnState(); });

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

  it('classifies a settled-as-error turn via its errorMessage → failed/codex_upstream_error + redacted summary (model-gateway outage)', () => {
    // Real captured shape (pi 0.84.2, live incident): the model gateway
    // cancelled the stream mid-turn; errorMessage sits on `message`. The
    // boundary marker says the turn really ended that way, so it is reported.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('trigger a backend error'),
      assistantFinal('error', '', '2026-08-03T05:14:05.000Z',
        'upstream stream error: rpc error: code = 1 desc = Cancelled by backend [biz error]'),
      turnSettled('error'),
    ]);
    const finals = drainAll(path).filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].terminalStatus).toBe('failed');
    // Shared Codex-family classifier: gateway/upstream failure, NOT the
    // opaque pi_turn_error → the failure card names the real cause.
    expect(finals[0].terminalErrorCode).toBe('codex_upstream_error');
    expect(finals[0].terminalErrorSummary).toContain('Cancelled by backend');
  });

  it('keeps failed/pi_turn_error (no summary) when the settled-as-error record has NO errorMessage', () => {
    const path = writeTranscript([
      sessionHeader(),
      userMsg('trigger a backend error'),
      assistantFinal('error', '', '2026-08-03T05:14:05.000Z'),
      turnSettled('error'),
    ]);
    const finals = drainAll(path).filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].terminalStatus).toBe('failed');
    expect(finals[0].terminalErrorCode).toBe('pi_turn_error');
    expect(finals[0].terminalErrorSummary).toBeUndefined();
  });

  // ── The regression this whole mechanism exists for ────────────────────────
  //
  // Pi retries a transient provider failure INSIDE the same turn. Reading the
  // error record as a terminal posted a gateway-failure card (and @mentioned a
  // human) for a turn that then succeeded. Measured on 231 real sessions:
  // 229/339 error records were followed by that same turn continuing.

  it('does NOT emit a failure when a mid-turn error is followed by a successful answer', () => {
    const path = writeTranscript([
      sessionHeader(),
      userMsg('say PROBE_OK'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
      assistantFinal('error', '', '2026-08-03T05:14:02.000Z', 'upstream stream error: service unavailable'),
      assistantFinal('stop', 'PROBE_OK', '2026-08-03T05:14:03.000Z'),
      turnSettled('stop'),
    ]);
    const finals = drainAll(path).filter((e) => e.kind === 'assistant_final');
    // Exactly one final, and it is the ANSWER — not a failure card, and not
    // one card per failed request attempt.
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('PROBE_OK');
    expect(finals[0].terminalStatus).toBeUndefined();
    expect(finals[0].terminalErrorCode).toBeUndefined();
  });

  it('reports only ONE failure for a turn whose every attempt errored', () => {
    // Retry exhausted: 3 error records, one settled-as-error boundary. The user
    // must be told once, not three times.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('say PROBE_OK'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
      assistantFinal('error', '', '2026-08-03T05:14:02.000Z', 'upstream stream error: service unavailable'),
      assistantFinal('error', '', '2026-08-03T05:14:03.000Z', 'upstream stream error: service unavailable'),
      turnSettled('error'),
    ]);
    const finals = drainAll(path).filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].terminalStatus).toBe('failed');
    // The newest attempt's detail is the one reported.
    expect(finals[0].timestampMs).toBe(Date.parse('2026-08-03T05:14:03.000Z'));
  });

  it('holds an error across drains and resolves it on the LATER boundary (records straddle two reads)', () => {
    // The poller reads whatever is on disk; a turn's records routinely span
    // several drains. A held error must survive the gap.
    const dir = join(ROOT, '--tmp-pi-probe--');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `2026-08-03T05-13-01-270Z_${SESSION_ID}.jsonl`);
    const head = [sessionHeader(), userMsg('say PROBE_OK'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable')];
    writeFileSync(path, head.map((o) => JSON.stringify(o)).join('\n') + '\n');

    const first = drainPiTranscript(path, 0);
    expect(first.events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);

    appendFileSync(path, [assistantFinal('stop', 'PROBE_OK', '2026-08-03T05:14:03.000Z'), turnSettled('stop')]
      .map((o) => JSON.stringify(o)).join('\n') + '\n');
    const second = drainPiTranscript(path, first.newOffset);
    const finals = second.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('PROBE_OK');
    expect(finals[0].terminalStatus).toBeUndefined();
  });

  it('reports a held error once the boundary is overdue, so a Pi killed mid-retry is not silent', () => {
    // No boundary will ever arrive (Pi was SIGKILLed). Waiting forever would
    // turn a real outage into silence — worse than the false alarm this change
    // removes. The timeout is anchored on the drain clock.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('say PROBE_OK'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
    ]);
    const t0 = 1_000_000;
    const first = drainPiTranscript(path, 0, t0);
    expect(first.events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);

    // Still within the window: nothing yet (and no new bytes on disk).
    const early = drainPiTranscript(path, first.newOffset, t0 + PI_TURN_BOUNDARY_TIMEOUT_MS - 1);
    expect(early.events).toHaveLength(0);

    // Overdue → the failure surfaces even though the file never grew again.
    const late = drainPiTranscript(path, first.newOffset, t0 + PI_TURN_BOUNDARY_TIMEOUT_MS);
    const finals = late.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].terminalStatus).toBe('failed');
    expect(finals[0].terminalErrorCode).toBe('codex_upstream_error');

    // …and only once: the held state is cleared, not re-reported every drain.
    const after = drainPiTranscript(path, late.newOffset, t0 + PI_TURN_BOUNDARY_TIMEOUT_MS * 3);
    expect(after.events).toHaveLength(0);
  });

  it('drops a held error when the turn settles as anything other than error', () => {
    // Defensive: a boundary whose lastStopReason is absent/unknown must not be
    // read as failure. Only the explicit 'error' value reports.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('say PROBE_OK'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
      turnSettled(null),
    ]);
    expect(drainAll(path).filter((e) => e.kind === 'assistant_final')).toHaveLength(0);
  });

  it('a successful answer clears the held error even if the boundary never arrives', () => {
    // Success first, boundary lost (Pi killed right after answering, or the
    // extension failed to load). The backstop must NOT resurrect the earlier
    // mid-turn error — that would reintroduce the exact false failure this
    // change removes, just delayed by the timeout.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('say PROBE_OK'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
      assistantFinal('stop', 'PROBE_OK', '2026-08-03T05:14:03.000Z'),
    ]);
    const t0 = 2_000_000;
    const first = drainPiTranscript(path, 0, t0);
    const finals = first.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('PROBE_OK');

    // Long past the timeout: still nothing — no phantom failure card.
    const late = drainPiTranscript(path, first.newOffset, t0 + PI_TURN_BOUNDARY_TIMEOUT_MS * 3);
    expect(late.events).toHaveLength(0);
  });

  // ── /adopt: a user-started Pi never receives --extension ──────────────────
  //
  // Those sessions produce NO boundary marker at all, so this is the shape the
  // change degrades to when it gets no help from Pi. It must degrade to "late
  // but correct", never to "wrong" or "silent".

  it('without any boundary marker (adopt), a recovered turn still suppresses its mid-turn error', () => {
    // Suppression here rides on the real terminal, not the marker — so adopt
    // sessions get the false-alarm fix for free.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('say PROBE_OK'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
      assistantFinal('stop', 'PROBE_OK', '2026-08-03T05:14:03.000Z'),
    ]);
    const t0 = 3_000_000;
    const first = drainPiTranscript(path, 0, t0);
    const late = drainPiTranscript(path, first.newOffset, t0 + PI_TURN_BOUNDARY_TIMEOUT_MS * 3);
    const all = [...first.events, ...late.events];
    expect(all.filter((e) => e.terminalStatus === 'failed')).toHaveLength(0);
    expect(all.some((e) => e.text === 'PROBE_OK')).toBe(true);
  });

  it('without any boundary marker (adopt), a genuinely failed turn is still reported via the timeout', () => {
    const path = writeTranscript([
      sessionHeader(),
      userMsg('say PROBE_OK'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
    ]);
    const t0 = 4_000_000;
    const first = drainPiTranscript(path, 0, t0);
    const late = drainPiTranscript(path, first.newOffset, t0 + PI_TURN_BOUNDARY_TIMEOUT_MS);
    const fails = [...first.events, ...late.events].filter((e) => e.terminalStatus === 'failed');
    expect(fails).toHaveLength(1);
    expect(fails[0].terminalErrorCode).toBe('codex_upstream_error');
  });

  // ── Steer during retry backoff (found in review) ──────────────────────────
  //
  // Pi's retry entry re-reads the steering queue at the TOP of the loop
  // ("Check for steering messages at start", agent-loop.ts), so input that
  // lands during the 2s/4s/8s backoff writes its user record BETWEEN the error
  // and its retry. Releasing a held error there posts a failure card for a turn
  // that then succeeds — the exact false alarm this mechanism exists to remove.
  // Botmux runs Pi with supportsTypeAhead, so this is a live path.

  it('does not report a failure when a steer lands between an error and its retry', () => {
    const path = writeTranscript([
      sessionHeader(),
      turnSettled(null, '2026-08-03T05:13:30.000Z'),   // session_start announce
      userMsg('原始问题'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
      userMsg('补一句（steer，落在 backoff 期间）', '2026-08-03T05:14:03.000Z'),
      assistantFinal('stop', 'ANSWER', '2026-08-03T05:14:06.000Z'),
      turnSettled('stop'),
    ]);
    const events = drainAll(path);
    const finals = events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe('ANSWER');
    expect(events.filter((e) => e.terminalStatus === 'failed')).toHaveLength(0);
  });

  it('still reports a first-turn failure even though the announce marker carries no verdict', () => {
    // The session_start announcement uses lastStopReason:null purely to say
    // "the extension is live". It must never be mistaken for "this turn ended
    // cleanly", or a held error would be silently dropped.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('原始问题'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
      turnSettled(null, '2026-08-03T05:14:02.000Z'),   // announce arrives late
      turnSettled('error', '2026-08-03T05:14:03.000Z'),
    ]);
    const fails = drainAll(path).filter((e) => e.terminalStatus === 'failed');
    expect(fails).toHaveLength(1);
    expect(fails[0].terminalErrorCode).toBe('codex_upstream_error');
  });

  it('without any marker, a failed turn the user simply retyped after is still reported', () => {
    // Marker-less transcripts (adopt, compiled binary, sessions predating the
    // extension) have no boundary to resolve the hold, and the NEXT turn's
    // terminal would clear it — so the user record must still release. Measured
    // on real transcripts: 104 error records are immediately followed by a new
    // user record. Gating this on a marker silently swallowed 109 of 120 real
    // failures when first attempted.
    const path = writeTranscript([
      sessionHeader(),
      userMsg('第一个问题'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
      userMsg('（放弃，重新问）', '2026-08-03T05:20:00.000Z'),
      assistantFinal('stop', 'ANSWER', '2026-08-03T05:20:10.000Z'),
    ]);
    const events = drainAll(path);
    const fails = events.filter((e) => e.terminalStatus === 'failed');
    expect(fails).toHaveLength(1);
    expect(events.some((e) => e.text === 'ANSWER')).toBe(true);
  });

  it('a SECOND declaration marker (resume re-fires session_start) does not swallow a held failure', () => {
    // `session_start` fires on every Pi start, resume included, so declaration
    // markers are not unique. Guarding only the FIRST one let a later
    // declaration fall through to the "turn settled cleanly" branch and drop
    // the hold — turning "pi died mid-turn, then botmux resumed it" into a
    // silently lost failure. Reported in review after the first-declaration-only
    // guard shipped; verified against this exact shape.
    const path = writeTranscript([
      sessionHeader(),
      turnSettled(null, '2026-08-03T05:13:30.000Z'),   // announce (first start)
      userMsg('原始问题'),
      assistantFinal('error', '', '2026-08-03T05:14:01.000Z', 'upstream stream error: service unavailable'),
      turnSettled(null, '2026-08-03T05:14:30.000Z'),   // announce again (resume)
    ]);
    const t0 = 6_000_000;
    const first = drainPiTranscript(path, 0, t0);
    expect(first.events.filter((e) => e.terminalStatus === 'failed')).toHaveLength(0);
    // The hold must survive the second declaration and still reach the backstop.
    const late = drainPiTranscript(path, first.newOffset, t0 + PI_TURN_BOUNDARY_TIMEOUT_MS);
    const fails = late.events.filter((e) => e.terminalStatus === 'failed');
    expect(fails).toHaveLength(1);
    expect(fails[0].terminalErrorCode).toBe('codex_upstream_error');
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
