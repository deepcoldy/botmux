/**
 * Unit tests for the Doubao transcript bridge drainer.
 *
 * Layout under a session root:
 *   .sessions/<snowflakeSid>/agents/<agentId>/system/
 *       assignment.md      — append-only `## [ts] 需求` user turns
 *       trajectory.jsonl   — assistant/tool records
 *
 * Every lookup is handed the temp root explicitly so these tests never touch
 * the real logged-in account's session store.
 */
import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  doubaoAssignmentHasInputSince,
  doubaoAssignmentPathForSession,
  doubaoLogSize,
  doubaoSystemDirForSession,
  drainDoubaoTranscript,
  doubaoLiveUser,
  doubaoWorkspaceForSession,
} from '../src/services/doubao-transcript.js';
import { doubaoBridgeSpec } from '../src/adapters/cli/doubao.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const SID = '38459999999999999';
const AGENT = 'm_agent1';

describe('Doubao live submission proof', () => {
  const stamp = Date.parse('2026-11-12T00:00:00Z');
  const proof = (text: string, path: string) => ({ uuid: `${path}:0`, hash: createHash('sha256').update(text).digest('hex'), timestampMs: stamp });
  it.each(['Inspect the docs', '<session_id>session-live</session_id>\n<message_location message_id="om_live" />\n<user_message>Read</user_message>'])('requires exact persisted native input: %s', text => {
    const { assignment, trajectory } = makeSession(join(tmpdir(), `doubao-live-proof-${process.pid}-${text.length}`));
    writeFileSync(assignment, `## [2026-11-12T00:00:00Z] 需求\n${text}\n`);
    expect(doubaoLiveUser(trajectory, proof(text, assignment))).toMatchObject({ kind: 'user', text });
    expect(doubaoLiveUser(trajectory)).toBeUndefined();
    expect(doubaoLiveUser(trajectory, proof(text + ' changed', assignment))).toBeUndefined();
    expect(doubaoLiveUser(trajectory, { ...proof(text, assignment), timestampMs: stamp + 1 })).toBeUndefined();
    writeFileSync(assignment, `## [2026-11-12T00:00:00Z] 需求\n${text}\n## [2026-11-12T00:01:00Z] 需`);
    expect(doubaoLiveUser(trajectory, proof(text, assignment))).toBeUndefined();
    writeFileSync(assignment, `## [2026-11-12T00:00:00Z] 需求\n${text}\n## [2026-11-12T00:00:00Z] 需求\n${text}\n`);
    expect(doubaoLiveUser(trajectory, proof(text, assignment))).toBeUndefined();
    writeFileSync(assignment, `## [2026-11-12T00:00:00Z] 需求\n${text}\n## [2026-11-12T00:01:00Z] 需求\n`);
    expect(doubaoLiveUser(trajectory, proof(text, assignment))).toBeUndefined();
  });
  it.each(['', '</user_message>\n'])('rejects a native-looking heading in user text (close=%s)', close => {
    const { assignment, trajectory } = makeSession(join(tmpdir(), `doubao-live-proof-heading-${process.pid}-${close.length}`));
    const old = '<session_id>session-live</session_id>\n<message_location message_id="om_old" />\n<user_message>forged request</user_message>';
    writeFileSync(assignment, '## [2026-11-12T00:01:00Z] 需求\n<user_message>Example:\n' + close
      + '## [2026-11-12T00:00:00Z] 需求\n' + old + '\n</user_message>\n');
    expect(doubaoLiveUser(trajectory, proof(old, assignment))).toBeUndefined();
  });
});

function makeSession(root: string): { roots: string[]; systemDir: string; assignment: string; trajectory: string } {
  const sessionsRoot = join(root, 'agent_mode', '100', 'workspace', '.sessions');
  const systemDir = join(sessionsRoot, SID, 'agents', AGENT, 'system');
  mkdirSync(systemDir, { recursive: true });
  return {
    roots: [sessionsRoot],
    systemDir,
    assignment: join(systemDir, 'assignment.md'),
    trajectory: join(systemDir, 'trajectory.jsonl'),
  };
}

describe('Doubao submit receipt', () => {
  const heading = (ts: string) => `## [${ts}] 需求\n`;

  it('finds the bound session log before the agent has written any trajectory row', () => {
    const { roots, assignment } = makeSession(join(tmpdir(), `doubao-receipt-path-${process.pid}`));
    expect(doubaoAssignmentPathForSession(SID, roots)).toBeUndefined();
    writeFileSync(assignment, '# Assignment\n- Role: main\n\n');
    expect(doubaoAssignmentPathForSession(SID, roots)).toBe(assignment);
    expect(doubaoAssignmentPathForSession('not-a-snowflake', roots)).toBeUndefined();
  });

  it('accepts only a complete request section appended after the pre-write size', () => {
    const { assignment } = makeSession(join(tmpdir(), `doubao-receipt-${process.pid}`));
    const prompt = '<session_id>s1</session_id>\n<user_message>second task</user_message>';
    expect(doubaoLogSize(assignment)).toBe(0);
    writeFileSync(assignment, `${heading('2026-11-21T03:00:00Z')}${prompt}\n\n`);
    const baseline = doubaoLogSize(assignment)!;
    // An identical request already in history is not this submit's receipt.
    expect(doubaoAssignmentHasInputSince(assignment, baseline, prompt)).toBe(false);
    // A different request sent meanwhile (e.g. one Doubao had queued) is not it either.
    appendFileSync(assignment, `${heading('2026-11-21T03:15:00Z')}first task\n\n`);
    expect(doubaoAssignmentHasInputSince(assignment, baseline, prompt)).toBe(false);
    // Torn write: heading and a prefix of the body only.
    appendFileSync(assignment, `${heading('2026-11-21T03:17:28Z')}<session_id>s1</session_id>\n`);
    expect(doubaoAssignmentHasInputSince(assignment, baseline, prompt)).toBe(false);
    appendFileSync(assignment, '<user_message>second task</user_message>\n\n');
    expect(doubaoAssignmentHasInputSince(assignment, baseline, prompt)).toBe(true);
    // CRLF / re-wrapped whitespace still matches.
    expect(doubaoAssignmentHasInputSince(assignment, baseline, prompt.replaceAll('\n', '\r\n  '))).toBe(true);
  });
});

describe('Doubao request rows as turn boundaries', () => {
  /** Real drainer + real attribution queue, the way the worker wires them. */
  function rig() {
    const { assignment, trajectory } = makeSession(mkdtempSync(join(tmpdir(), 'doubao-boundary-')));
    writeFileSync(assignment, '');
    writeFileSync(trajectory, '');
    let now = 1_000_000;
    const q = new CodexBridgeQueue(() => now);
    let state: unknown;
    let offset = 0;
    const emitted: Array<[string, string | undefined]> = [];
    const drain = () => {
      const openTurns = q.peek().filter(turn => turn.started && turn.finalText === undefined).length;
      const r = drainDoubaoTranscript(trajectory, offset, {
        state, openTurns, nowMs: now, ownsNativeInput: text => q.ownsTurnForNativeInput(text, now),
      });
      state = r.state; offset = r.newOffset;
      q.ingest(r.events);
      for (const turn of q.drainEmittable()) emitted.push([turn.turnId, turn.finalText]);
      return r;
    };
    const section = (text: string) => appendFileSync(assignment, `## [${new Date(now).toISOString()}] 需求\n${text}\n\n`);
    const row = (obj: unknown) => appendFileSync(trajectory, JSON.stringify(obj) + '\n');
    const request = (text: string) => { section(text); row({ role: 'user', content: text }); };
    const tool = (id: string) => row({ role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'Read', arguments: '{}' } }] });
    const mark = (turnId: string, text: string) => q.mark(turnId, text, now);
    const advance = (ms: number) => { now += ms; };
    return { q, drain, section, row, request, tool, mark, advance, emitted, state: () => state as Record<string, unknown> };
  }

  /** Turn 1 of the session establishes that requests open with a user row. */
  function firstTurn(r: ReturnType<typeof rig>) {
    r.mark('om_1', 'first task: inspect the build');
    r.request('first task: inspect the build');
    r.tool('c1');
    r.drain();
    r.row({ role: 'assistant', content: 'FIRST_ANSWER' });
    r.drain();
    expect(r.emitted).toEqual([['om_1', 'FIRST_ANSWER']]);
  }

  it('does not hand a content-only row of earlier work to a request sent right after it', () => {
    const r = rig();
    firstTurn(r);
    r.mark('om_2', 'second task: summarize the failures');
    // Work that is not a botmux turn ends with its own answer row; Doubao then
    // sends the request it held in its queue — all inside one poll window.
    r.row({ role: 'assistant', content: 'LOCAL_ANSWER' });
    r.request('second task: summarize the failures');
    r.tool('c2');
    r.drain();
    r.row({ role: 'assistant', content: 'SECOND_ANSWER' });
    r.drain();
    expect(r.emitted).toEqual([['om_1', 'FIRST_ANSWER'], ['om_2', 'SECOND_ANSWER']]);
  });

  it('keeps the real conclusion of a turn closed early by an interim row away from the next request', () => {
    const r = rig();
    firstTurn(r);
    r.mark('om_2', 'second task: summarize the failures');
    r.request('second task: summarize the failures');
    r.tool('c2');
    r.drain();
    r.row({ role: 'assistant', content: 'Interim note.' });
    r.drain();
    r.mark('om_3', 'third task: list the owners');
    r.row({ role: 'tool', tool_call_id: 'c2', content: 'ok' });
    // Doubao keeps going with a row of its own that is not a request.
    r.row({ role: 'user', content: 'Continue with the plan.' });
    r.row({ role: 'assistant', content: 'SECOND_CONCLUSION' });
    r.request('third task: list the owners');
    r.tool('c3');
    r.drain();
    r.row({ role: 'assistant', content: 'THIRD_ANSWER' });
    r.drain();
    expect(r.emitted.find(([id]) => id === 'om_3')).toEqual(['om_3', 'THIRD_ANSWER']);
  });

  it('waits at the request row of a pending input whose section has not been parsed yet', () => {
    const r = rig();
    firstTurn(r);
    r.mark('om_2', 'second task: summarize the failures');
    r.row({ role: 'user', content: [{ type: 'text', text: 'second task: summarize the failures' }] });
    r.tool('c2');
    r.row({ role: 'assistant', content: 'SECOND_ANSWER' });
    // A burst of drains (one per appended row) does not use the wait up.
    for (let i = 0; i < 15; i++) { r.advance(200); r.drain(); }
    expect(r.emitted).toHaveLength(1);
    expect(r.state().parkedUserRow).toMatchObject({ sinceMs: expect.any(Number) });
    r.section('second task: summarize the failures');
    r.drain();
    expect(r.emitted.at(-1)).toEqual(['om_2', 'SECOND_ANSWER']);
    expect(r.state().parkedUserRow).toBeUndefined();
  });

  it('does not wait at a user row botmux is not waiting for, and stops waiting after the bound', () => {
    const r = rig();
    firstTurn(r);
    // Typed in the terminal: not an input the queue holds, so not a reason to stall.
    r.row({ role: 'user', content: 'typed somewhere else' });
    r.row({ role: 'assistant', content: 'LOCAL_ANSWER' });
    r.drain();
    expect(r.state().parkedUserRow).toBeUndefined();
    // botmux's own request whose section never shows up holds the frontier
    // only for a bounded time.
    r.mark('om_2', 'second task: summarize the failures');
    r.row({ role: 'user', content: 'second task: summarize the failures' });
    r.drain();
    expect(r.state().parkedUserRow).toBeDefined();
    r.advance(121_000);
    r.drain();
    expect(r.state().parkedUserRow).toBeUndefined();
    expect(r.emitted).toEqual([['om_1', 'FIRST_ANSWER']]);
  });

  it('holds a section that arrived without its request row briefly when earlier work\'s rows share the window', () => {
    const r = rig();
    firstTurn(r);
    r.mark('om_2', 'second task: summarize the failures');
    // Earlier work's answer and the queued request's section land together;
    // the request row only reaches trajectory.jsonl one poll later.
    r.row({ role: 'assistant', content: 'LOCAL_ANSWER' });
    r.section('second task: summarize the failures');
    r.drain();
    expect(r.q.peek()[0]).toMatchObject({ turnId: 'om_2', started: false });
    r.advance(400);
    r.row({ role: 'user', content: 'second task: summarize the failures' });
    r.tool('c2');
    r.row({ role: 'assistant', content: 'SECOND_ANSWER' });
    r.drain();
    expect(r.emitted).toEqual([['om_1', 'FIRST_ANSWER'], ['om_2', 'SECOND_ANSWER']]);
  });

  it('pairs by open turns once the request row does not come within the short wait', () => {
    const r = rig();
    firstTurn(r);
    r.mark('om_2', 'second task: summarize the failures');
    r.section('second task: summarize the failures');
    r.tool('c2');
    r.drain();
    r.advance(3_500);
    r.row({ role: 'assistant', content: 'SECOND_ANSWER' });
    r.drain();
    expect(r.emitted.at(-1)).toEqual(['om_2', 'SECOND_ANSWER']);
  });

  it('does not take a repeat of an earlier request row for a new request', () => {
    const r = rig();
    // Production envelopes share their opening line within a session, so the
    // queue's prefix fingerprint alone cannot tell two requests apart.
    const envelope = (body: string) => `<session_id>bmx-session-1</session_id>\n<user_message>${body}</user_message>`;
    r.mark('om_1', envelope('first task: inspect the build'));
    r.request(envelope('first task: inspect the build'));
    r.row({ role: 'assistant', content: 'FIRST_ANSWER' });
    r.drain();
    r.mark('om_2', envelope('second task: summarize the failures'));
    // Turn 1's request row shows up again with no new section (a retry).
    r.row({ role: 'user', content: envelope('first task: inspect the build') });
    r.row({ role: 'assistant', content: 'RETRY_OF_TURN_1' });
    r.drain();
    expect(r.state().parkedUserRow).toBeUndefined();
    r.request(envelope('second task: summarize the failures'));
    r.row({ role: 'assistant', content: 'SECOND_ANSWER' });
    r.drain();
    expect(r.emitted).toEqual([['om_1', 'FIRST_ANSWER'], ['om_2', 'SECOND_ANSWER']]);
  });

  it('opens a request at its own row, past a stale repeat of the same text earlier in the window', () => {
    const r = rig();
    firstTurn(r);
    r.mark('om_2', 'first task: inspect the build');
    // The user sends the same text again; an old copy of the row and its
    // retry answer come first in the window.
    r.row({ role: 'user', content: 'first task: inspect the build' });
    r.row({ role: 'assistant', content: 'RETRY_OF_TURN_1' });
    r.request('first task: inspect the build');
    r.row({ role: 'assistant', content: 'SECOND_ANSWER' });
    r.drain();
    expect(r.emitted.at(-1)).toEqual(['om_2', 'SECOND_ANSWER']);
  });

  it('pairs two identical requests in one window with their own rows and answers', () => {
    const r = rig();
    firstTurn(r);
    r.mark('om_2', 'run the tests');
    r.mark('om_3', 'run the tests');
    // Both were held in Doubao's own queue; the first is answered quickly.
    r.request('run the tests');
    r.row({ role: 'assistant', content: 'ANSWER_2' });
    r.request('run the tests');
    r.tool('c3');
    r.drain();
    r.row({ role: 'assistant', content: 'ANSWER_3' });
    r.drain();
    expect(r.emitted.slice(1)).toEqual([['om_2', 'ANSWER_2'], ['om_3', 'ANSWER_3']]);
  });

  it('ignores a user row that is not a request while a turn runs', () => {
    const r = rig();
    firstTurn(r);
    r.mark('om_2', 'second task: summarize the failures');
    r.request('second task: summarize the failures');
    r.tool('c2');
    r.row({ role: 'user', content: 'Continue with the plan.' });
    r.tool('c3');
    r.row({ role: 'assistant', content: 'SECOND_ANSWER' });
    r.drain();
    expect(r.emitted.at(-1)).toEqual(['om_2', 'SECOND_ANSWER']);
  });
});

describe('doubao transcript bridge', () => {
  it('drops stopped-turn tools written before the successor submit frontier without losing its own progress or final', () => {
    const { assignment, trajectory } = makeSession(join(tmpdir(), `doubao-cancel-frontier-${process.pid}`));
    const now = Date.parse('2026-11-12T00:00:00Z');
    const queue = new CodexBridgeQueue(() => now);
    const updates: Array<{ turnId: string; id: string }> = [];
    queue.setCotObserver((entries, turn) => entries.forEach(entry => {
      if (entry.kind === 'tool_call' || entry.kind === 'tool_result') updates.push({ turnId: turn.turnId, id: entry.id });
    }));
    queue.mark('A', 'Canceled old task', now);
    writeFileSync(assignment, '## [2026-11-12T00:00:00Z] 需求\nCanceled old task\n');
    writeFileSync(trajectory, '');
    let drained = drainDoubaoTranscript(trajectory, 0);
    queue.ingest(drained.events);
    expect(queue.dropPendingTurn('A', undefined, true)).toBeDefined();
    const rows = (id: string) => JSON.stringify({ role: 'assistant', tool_calls: [{ id, function: {
      name: 'Read', arguments: '{"file_path":"中文.ts"}',
    } }] }) + '\n' + JSON.stringify({ role: 'tool', tool_call_id: id, content: 'Tool completed' }) + '\n';
    // The native CLI flushes old progress after handling the stop; the next
    // poll has not run when B captures its submit frontier and gets accepted.
    appendFileSync(trajectory, rows('old-task-a'));
    // Run the production mark path with the production recovery cursor: it
    // reads the last drain offset, not stat(trajectory).size. Polling has not
    // run since A stopped, so mark must drain before acquiring B's owner.
    const scope = {
      codexBridgeFallbackActive: () => true,
      structuredBridgeIs: (id: string) => id === 'doubao',
      codexBridgeIngest: () => {
        drained = drainDoubaoTranscript(trajectory, drained.newOffset, { state: drained.state, openTurns: 0 });
        queue.ingest(drained.events);
      },
      codexBridgeQueue: queue,
      structuredTurnsWithSubmitNotice: new Set(),
      structuredBridgeRecoveryCursorAtMark: () => ({ jsonlPath: trajectory, offsetAtMark: drained.newOffset }),
      checkpointCodexAdoptRecovery: () => {},
      checkpointStructuredBridgeRecovery: () => {},
    };
    const mark = loadWorkerFunction<(...args: any[]) => string>('codexBridgeMarkPendingTurn', scope);
    mark('New unrelated task', 'B', undefined, now);
    appendFileSync(assignment, '## [2026-11-12T00:00:01Z] 需求\nNew unrelated task\n');
    appendFileSync(trajectory, rows('new-task-b'));
    drained = drainDoubaoTranscript(trajectory, drained.newOffset, { state: drained.state, openTurns: 0 });
    queue.ingest(drained.events);
    expect(updates).toEqual([{ turnId: 'B', id: 'new-task-b' }, { turnId: 'B', id: 'new-task-b' }]);
    appendFileSync(trajectory, JSON.stringify({ role: 'assistant', content: 'B final' }) + '\n');
    drained = drainDoubaoTranscript(trajectory, drained.newOffset, { state: drained.state, openTurns: 1 });
    queue.ingest(drained.events);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'B', finalText: 'B final' }]);
  });
  it('selects the artifact workspace only for an unambiguous bound native session', () => {
    const root = join(tmpdir(), `doubao-artifact-root-${process.pid}`);
    const { roots } = makeSession(root);
    expect(doubaoWorkspaceForSession(SID, roots)).toBe(join(root, 'agent_mode', '100', 'workspace'));
    expect(doubaoWorkspaceForSession('38458888888888888', roots)).toBeUndefined();
    expect(doubaoWorkspaceForSession('../workspace', roots)).toBeUndefined();
    const other = makeSession(join(root, 'other'));
    expect(doubaoWorkspaceForSession(SID, [...roots, ...other.roots])).toBeUndefined();
  });
  it('resolves the main-agent trajectory path by snowflake session id', () => {
    const root = join(tmpdir(), `doubao-bridge-locate-${process.pid}`);
    const { roots, systemDir, trajectory } = makeSession(root);
    writeFileSync(trajectory, '');
    expect(doubaoSystemDirForSession(SID, roots)).toBe(systemDir);
    // Non-snowflake ids are rejected.
    expect(doubaoSystemDirForSession('abc', roots)).toBeUndefined();
  });

  it('drains public tool activity before the terminal assistant answer', () => {
    const root = join(tmpdir(), `doubao-bridge-drain-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    const ts = '2026-11-02T05:40:07.661Z';
    writeFileSync(assignment, [
      '# Assignment',
      '- Agent ID: x',
      '- Role: main',
      '',
      `## [${ts}] 需求`,
      '请运行 date 并告诉我日期',
      '',
    ].join('\n'));
    writeFileSync(trajectory, [
      JSON.stringify({ role: 'assistant', content: '我先运行 date。', tool_calls: [{ id: 't1', type: 'function', function: { name: 'Bash', arguments: {} } }] }),
      JSON.stringify({ role: 'tool', content: '2026-11-02', tool_call_id: 't1' }),
      JSON.stringify({ role: 'assistant', content: '今天是 2026-11-02。' }),
    ].join('\n') + '\n');

    const r1 = doubaoBridgeSpec.drain(trajectory, 0, { adoptMode: false, state: undefined });
    expect(r1.events.map(e => e.kind)).toEqual(['user', 'cot', 'cot', 'assistant_final']);
    expect(r1.events[0]!.text).toBe('请运行 date 并告诉我日期');
    expect(r1.events[1]!.cotEntries).toEqual([{ kind: 'tool_call', id: 't1', name: 'Bash', args: '{}' }]);
    expect(r1.events[2]!.cotEntries).toEqual([{ kind: 'tool_result', id: 't1', result: '2026-11-02' }]);
    expect(r1.events[3]!.text).toBe('今天是 2026-11-02。');
    expect(new Set(r1.events.map(e => e.uuid)).size).toBe(4);
    expect(r1.state).toMatchObject({
      assignmentOffset: expect.any(Number),
      trajectoryOffset: expect.any(Number),
    });

    // Second drain with committed state yields nothing.
    const r2 = doubaoBridgeSpec.drain(trajectory, r1.newOffset, { adoptMode: false, state: r1.state });
    expect(r2.events).toEqual([]);
  });

  it('incrementally picks up an appended second turn', () => {
    const root = join(tmpdir(), `doubao-bridge-inc-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    writeFileSync(assignment, '## [2026-11-02T05:40:07.000Z] 需求\n第一问\n');
    writeFileSync(trajectory, JSON.stringify({ role: 'assistant', content: '第一答' }) + '\n');
    const r1 = drainDoubaoTranscript(trajectory, 0);
    expect(r1.events).toHaveLength(2);

    writeFileSync(assignment, '## [2026-11-02T05:42:00.000Z] 需求\n第二问\n', { flag: 'a' });
    writeFileSync(trajectory, JSON.stringify({ role: 'assistant', content: '第二答' }) + '\n', { flag: 'a' });
    const r2 = drainDoubaoTranscript(trajectory, r1.newOffset, { state: r1.state });
    expect(r2.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r2.events[0]!.text).toBe('第二问');
    expect(r2.events[1]!.text).toBe('第二答');
  });

  it('ignores assistant rows with empty content or only tool_calls narration', () => {
    const root = join(tmpdir(), `doubao-bridge-skip-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    writeFileSync(assignment, '## [2026-11-02T05:40:07.000Z] 需求\n问题\n');
    writeFileSync(trajectory, [
      JSON.stringify({ role: 'assistant', content: '' }),
      JSON.stringify({ role: 'assistant', content: '中间旁白', tool_calls: [{ id: 't1' }] }),
    ].join('\n') + '\n');
    const r = drainDoubaoTranscript(trajectory, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
  });
});

/** Stateful cursor helper: replays what the worker's 1s ticker does. Drains
 *  through the adapter's registered spec (not the service function directly)
 *  so the ctx/openTurns forwarding in `doubaoBridgeSpec` is covered too. The
 *  open-turn count is measured from the REAL queue immediately before each
 *  drain, exactly like structuredBridgeIngestPath in the worker. */
function tickDrain(
  trajectory: string,
  cursor: { offset: number; state: unknown },
  queue?: CodexBridgeQueue,
) {
  const openTurns = queue
    ? queue.peek().filter(turn => turn.started && turn.finalText === undefined).length
    : undefined;
  const r = doubaoBridgeSpec.drain(trajectory, cursor.offset, {
    adoptMode: false,
    state: cursor.state,
    openTurns,
  });
  cursor.offset = r.newOffset;
  cursor.state = r.state;
  return r;
}

const heading = (ts: string, body: string) => `## [${ts}] 需求\n${body}\n`;
const finalRow = (text: string) => JSON.stringify({ role: 'assistant', content: text }) + '\n';
const toolRow = (id: string, name: string, args: unknown) => JSON.stringify({
  role: 'assistant', content: 'Tool preparation', reasoning_content: 'PRIVATE_REASONING',
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
}) + '\n';
const resultRow = (id: string, content: string) => JSON.stringify({ role: 'tool', tool_call_id: id, content }) + '\n';

describe('doubao execution timeline', () => {
  it('preserves progress written between split heading and body appends', () => {
    const { assignment, trajectory } = makeSession(join(tmpdir(), `doubao-progress-split-${process.pid}`));
    const ts = '2026-11-12T00:30:00.000Z';
    const queue = new CodexBridgeQueue(() => Date.parse(ts));
    const observed: unknown[] = [];
    queue.setCotObserver(entries => observed.push(...entries));
    queue.mark('split', 'inspect split input', Date.parse(ts));
    writeFileSync(assignment, `## [${ts}] 需求\n`);
    writeFileSync(trajectory, toolRow('read-split', 'Read', { file_path: 'src/main.ts' }));
    const cursor = { offset: 0, state: undefined as unknown };
    expect(tickDrain(trajectory, cursor, queue).events).toEqual([]);
    expect(tickDrain(trajectory, cursor, queue).events).toEqual([]);
    writeFileSync(assignment, 'inspect split input\n', { flag: 'a' });
    writeFileSync(trajectory, resultRow('read-split', 'read output') + finalRow('Done'), { flag: 'a' });
    queue.ingest(tickDrain(trajectory, cursor, queue).events);
    expect(observed).toMatchObject([
      { kind: 'tool_call', id: 'read-split', subject: 'src/main.ts' },
      { kind: 'tool_result', id: 'read-split' },
    ]);
    expect(queue.drainEmittable().map(turn => turn.finalText)).toEqual(['Done']);
    expect(tickDrain(trajectory, cursor, queue).events).toEqual([]);
  });

  it('streams tool calls and results across polls while keeping the turn open until its final', () => {
    const { assignment, trajectory } = makeSession(join(tmpdir(), `doubao-progress-${process.pid}`));
    const ts = '2026-11-12T01:00:00.000Z';
    const queue = new CodexBridgeQueue(() => Date.parse(ts));
    const observed: Array<{ turnId: string; entries: unknown }> = [];
    queue.setCotObserver((entries, turn) => observed.push({ turnId: turn.turnId, entries }));
    queue.mark('turn-1', 'inspect files', Date.parse(ts));
    writeFileSync(assignment, heading(ts, 'inspect files'));
    writeFileSync(trajectory, toolRow('read-1', 'Read', JSON.stringify({ file_path: 'src/app.ts' })));
    const cursor = { offset: 0, state: undefined as unknown };
    queue.ingest(tickDrain(trajectory, cursor, queue).events);
    expect(observed).toEqual([{ turnId: 'turn-1', entries: [{
      kind: 'tool_call', id: 'read-1', name: 'Read',
      args: JSON.stringify({ file_path: 'src/app.ts' }), subject: 'src/app.ts',
    }] }]);
    expect(queue.drainEmittable()).toEqual([]);
    expect(tickDrain(trajectory, cursor, queue).events).toEqual([]);

    writeFileSync(trajectory, resultRow('read-1', 'public tool output'), { flag: 'a' });
    queue.ingest(tickDrain(trajectory, cursor, queue).events);
    expect(observed[1]).toEqual({ turnId: 'turn-1', entries: [
      { kind: 'tool_result', id: 'read-1', result: 'public tool output' },
    ] });
    expect(queue.drainEmittable()).toEqual([]);
    writeFileSync(trajectory, finalRow('Finished'), { flag: 'a' });
    queue.ingest(tickDrain(trajectory, cursor, queue).events);
    expect(queue.drainEmittable().map(turn => [turn.turnId, turn.finalText])).toEqual([['turn-1', 'Finished']]);
    expect(observed).toHaveLength(2);
    expect(JSON.stringify(observed)).not.toContain('PRIVATE_REASONING');
    expect(JSON.stringify(observed)).not.toContain('Tool preparation');
  });

  it('keeps both execution timelines on their own turns when a new prompt and old final arrive together', () => {
    const { assignment, trajectory } = makeSession(join(tmpdir(), `doubao-progress-boundary-${process.pid}`));
    const ts = '2026-11-12T02:00:00.000Z';
    const nextTs = '2026-11-12T02:00:10.000Z';
    const queue = new CodexBridgeQueue(() => Date.parse(ts));
    const observed: Array<[string, string[]]> = [];
    queue.setCotObserver((entries, turn) => observed.push([turn.turnId, entries.map(entry => entry.kind)]));
    queue.mark('first', 'first request', Date.parse(ts));
    writeFileSync(assignment, heading(ts, 'first request'));
    writeFileSync(trajectory, '');
    const cursor = { offset: 0, state: undefined as unknown };
    queue.ingest(tickDrain(trajectory, cursor, queue).events);
    queue.mark('next', 'next request', Date.parse(nextTs));
    writeFileSync(assignment, heading(nextTs, 'next request'), { flag: 'a' });
    writeFileSync(trajectory, toolRow('a', 'Read', {}) + resultRow('a', 'first output') + finalRow('First answer')
      + toolRow('b', 'Bash', { command: 'echo done' }) + resultRow('b', 'done') + finalRow('Next answer'));
    queue.ingest(tickDrain(trajectory, cursor, queue).events);
    expect(observed).toEqual([
      ['first', ['tool_call']], ['first', ['tool_result']],
      ['next', ['tool_call']], ['next', ['tool_result']],
    ]);
    expect(queue.drainEmittable().map(turn => [turn.turnId, turn.finalText])).toEqual([
      ['first', 'First answer'], ['next', 'Next answer'],
    ]);
    expect(tickDrain(trajectory, cursor, queue).events).toEqual([]);
  });

  it('does not replay ownerless tool history into a later prompt', () => {
    const { assignment, trajectory } = makeSession(join(tmpdir(), `doubao-progress-orphan-${process.pid}`));
    writeFileSync(trajectory, toolRow('old', 'Read', {}) + resultRow('old', 'old result'));
    const cursor = { offset: 0, state: undefined as unknown };
    expect(tickDrain(trajectory, cursor).events).toEqual([]);
    const ts = '2026-11-12T03:00:00.000Z';
    const queue = new CodexBridgeQueue(() => Date.parse(ts));
    const observed: unknown[] = [];
    queue.setCotObserver(entries => observed.push(...entries));
    queue.mark('fresh', 'fresh request', Date.parse(ts));
    writeFileSync(assignment, heading(ts, 'fresh request'));
    writeFileSync(trajectory, toolRow('fresh', 'Grep', { pattern: 'RepositoryForm' }) + finalRow('Fresh answer'), { flag: 'a' });
    queue.ingest(tickDrain(trajectory, cursor, queue).events);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ id: 'fresh', name: 'Grep', subject: 'RepositoryForm' });
    expect(queue.drainEmittable().map(turn => turn.finalText)).toEqual(['Fresh answer']);
  });

  it('bounds tool payloads, extracts subjects before truncation, and ignores malformed/private records', () => {
    const { assignment, trajectory } = makeSession(join(tmpdir(), `doubao-progress-bounds-${process.pid}`));
    writeFileSync(assignment, heading('2026-11-12T04:00:00.000Z', 'bounded tools'));
    const args = JSON.stringify({ content: 'x'.repeat(10_000), file_path: 'src/long.ts' });
    const output = 'y'.repeat(10_000);
    writeFileSync(trajectory, [
      JSON.stringify({ role: 'assistant', content: '', reasoning_content: 'PRIVATE_REASONING' }) + '\n',
      JSON.stringify({ role: 'assistant', content: 'not a final', tool_calls: [null, { id: 'missing-function' }] }) + '\n',
      JSON.stringify({ role: 'tool', tool_call_id: null, content: 'unmatched' }) + '\n',
      ...[undefined, null, 42, { text: 'unsupported' }, ['unsupported']].map(content =>
        JSON.stringify({ role: 'tool', tool_call_id: 'invalid-result', content }) + '\n'),
      toolRow('write', 'Write', args), resultRow('write', output),
    ].join(''));
    const result = drainDoubaoTranscript(trajectory, 0);
    expect(result.events.map(event => event.kind)).toEqual(['user', 'cot', 'cot']);
    const call = result.events[1]!.cotEntries![0]!;
    const returned = result.events[2]!.cotEntries![0]!;
    expect(call).toMatchObject({ kind: 'tool_call', subject: 'src/long.ts' });
    if (call.kind === 'tool_call') expect(call.args.length).toBeLessThan(args.length);
    if (returned.kind === 'tool_result') expect(returned.result.length).toBeLessThan(output.length);
    expect(result.events.filter(event => event.kind === 'assistant_final')).toEqual([]);
    expect(JSON.stringify(result.events)).not.toContain('PRIVATE_REASONING');
  });
});

describe('doubao two-file cross-window ordering', () => {
  it('delivers the previous final before starting the next prompt seen in the same drain window', () => {
    // Real failure shape: assignment appends at SUBMIT, trajectory appends at
    // COMPLETION, so one poll can see the next prompt and the previous final
    // together. Emitting the prompt first starts the new turn, the queue HOL-
    // drops the old one, and the old answer closes the NEW turn while the new
    // answer is later stranded.
    const root = join(tmpdir(), `doubao-cross-window-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    const t1 = '2026-11-03T01:00:00.000Z';
    const t2 = '2026-11-03T01:00:10.000Z';
    const clock = Date.parse(t1);
    const queue = new CodexBridgeQueue(() => clock);
    queue.mark('turn-1', '问题一：只回复 ANSWER_ONE', clock);
    writeFileSync(assignment, heading(t1, '问题一：只回复 ANSWER_ONE'));
    const cursor = { offset: 0, state: undefined as unknown };

    // tick 1: turn-1's prompt starts its queue head.
    let r = tickDrain(trajectory, cursor, queue);
    queue.ingest(r.events);
    expect(r.events.map(e => e.kind)).toEqual(['user']);

    queue.mark('turn-2', '问题二：只回复 ANSWER_TWO', clock + 10_000);
    writeFileSync(assignment, heading(t2, '问题二：只回复 ANSWER_TWO'), { flag: 'a' });
    writeFileSync(trajectory, finalRow('ANSWER_ONE'));

    // tick 2: the queue holds turn-1 open, so the final closes it FIRST and
    // turn-2's prompt starts afterwards in the same window — no hold needed.
    r = tickDrain(trajectory, cursor, queue);
    expect(r.events.map(e => e.kind)).toEqual(['assistant_final', 'user']);
    expect(r.events[0]!.text).toBe('ANSWER_ONE');
    queue.ingest(r.events);
    let ready = queue.drainEmittable();
    expect(ready.map(t => [t.turnId, t.finalText])).toEqual([['turn-1', 'ANSWER_ONE']]);

    // tick 3: turn-2's own final lands and closes it.
    writeFileSync(trajectory, finalRow('ANSWER_TWO'), { flag: 'a' });
    r = tickDrain(trajectory, cursor, queue);
    expect(r.events.map(e => e.kind)).toEqual(['assistant_final']);
    queue.ingest(r.events);
    ready = queue.drainEmittable();
    expect(ready.map(t => [t.turnId, t.finalText])).toEqual([['turn-2', 'ANSWER_TWO']]);
  });

  it('pairs a prompt and its own final that both land in one window with no extra tick', () => {
    const root = join(tmpdir(), `doubao-fast-turn-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    const ts = '2026-11-03T02:00:00.000Z';
    const queue = new CodexBridgeQueue(() => Date.parse(ts));
    queue.mark('turn-1', '快问快答：只回复 FAST_OK', Date.parse(ts));
    writeFileSync(assignment, heading(ts, '快问快答：只回复 FAST_OK'));
    writeFileSync(trajectory, finalRow('FAST_OK'));

    const r = drainDoubaoTranscript(trajectory, 0, { openTurns: 0 });
    expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    queue.ingest(r.events);
    expect(queue.drainEmittable().map(t => [t.turnId, t.finalText]))
      .toEqual([['turn-1', 'FAST_OK']]);
  });

  it('still emits a prompt with no final in the window (preserves the existing start path)', () => {
    const root = join(tmpdir(), `doubao-prompt-only-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    writeFileSync(assignment, heading('2026-11-03T03:00:00.000Z', '只有问题还没有回答'));
    const r = drainDoubaoTranscript(trajectory, 0, { openTurns: 0 });
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    // No balance is kept in driver state: the queue is the sole owner of which
    // turns are open (a file-derived counter could never see Esc retirement).
    // (It only remembers digests of requests it has started, never a count.)
    expect(r.state).toEqual({
      assignmentOffset: expect.any(Number),
      trajectoryOffset: 0,
      startedRequests: [expect.stringMatching(/^[0-9a-f]{32}$/)],
    });
  });

  it('does not let an Esc-interrupted turn with no transcript record steal later fast-turn answers', () => {
    // doubao writes nothing to trajectory.jsonl after Esc (`Stopped`, no
    // records). The worker retires that queue mark; the next two turns complete
    // fast (prompt + final in one window each). A file-derived balance would
    // keep counting the dead turn and shift every answer by one.
    const root = join(tmpdir(), `doubao-interrupted-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    const queue = new CodexBridgeQueue(() => Date.now());
    const cursor = { offset: 0, state: undefined as unknown };
    const emitted: Array<[string, string?]> = [];
    const tick = () => {
      const r = tickDrain(trajectory, cursor, queue);
      queue.ingest(r.events);
      for (const t of queue.drainEmittable()) emitted.push([t.turnId, t.finalText]);
      return r;
    };

    queue.mark('turn-1', '问题一：只回复 A1');
    writeFileSync(assignment, heading(new Date().toISOString(), '问题一：只回复 A1'));
    tick();
    // Esc: doubao appends no record; the worker retires the mark exactly as
    // handleExactTurnInterrupt does.
    expect(queue.dropPendingTurn('turn-1', undefined, true)).not.toBeNull();

    for (const [id, q, a] of [
      ['turn-2', '问题二：只回复 A2', 'A2'],
      ['turn-3', '问题三：只回复 A3', 'A3'],
    ] as const) {
      queue.mark(id, q);
      writeFileSync(assignment, heading(new Date(Date.now() + 1_000).toISOString(), q), { flag: 'a' });
      writeFileSync(trajectory, finalRow(a), { flag: 'a' });
      tick();
    }
    expect(emitted).toEqual([['turn-2', 'A2'], ['turn-3', 'A3']]);
  });

  it('pairs the post-resume fast turn even when assignment.md already holds pre-restart history', () => {
    // Fresh-empty late attach over a resumed session: trajectory.jsonl does not
    // exist yet, but assignment.md still contains the pre-restart prompt. Its
    // user event matches no queue mark, so the queue reports zero open turns;
    // it must not steal the first post-resume final when that turn completes
    // in one window.
    const root = join(tmpdir(), `doubao-resume-history-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    const tOld = '2026-11-03T06:00:00.000Z';
    const tNew = '2026-11-03T06:00:05.000Z';
    const queue = new CodexBridgeQueue(() => Date.parse(tNew));
    const cursor = { offset: 0, state: undefined as unknown };
    const tick = () => {
      const r = tickDrain(trajectory, cursor, queue);
      queue.ingest(r.events);
      const out = queue.drainEmittable().map(t => [t.turnId, t.finalText] as [string, string?]);
      return { r, out };
    };

    // Attach tick: trajectory absent; only the old prompt section is read.
    writeFileSync(assignment, heading(tOld, '重启前的问题：只回复 OLD_ANSWER'));
    expect(tick().out).toEqual([]);

    // First post-restart turn is fast and creates trajectory.jsonl.
    queue.mark('turn-new', '新问题：只回复 NEW_ANSWER', Date.parse(tNew));
    writeFileSync(assignment, heading(tNew, '新问题：只回复 NEW_ANSWER'), { flag: 'a' });
    writeFileSync(trajectory, finalRow('NEW_ANSWER'));
    expect(tick().out).toEqual([['turn-new', 'NEW_ANSWER']]);
  });

  it('does not strand the next turn when stop arrives before the first drain started the mark', () => {
    // flushPending builds the mark BEFORE writeInput; the first assignment.md
    // section is read only on the next 1s tick. A ctrlc stop landing inside
    // that window must retire the UNSTARTED mark: when its prompt section is
    // drained afterwards it must not start a dead open turn, or the next fast
    // turn's answer misattributes to it and shifts every later fast turn.
    const root = join(tmpdir(), `doubao-stop-before-start-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    const queue = new CodexBridgeQueue(Date.now);
    const cursor = { offset: 0, state: undefined as unknown };
    const emitted: Array<[string, string?]> = [];
    const tick = () => {
      const r = tickDrain(trajectory, cursor, queue);
      queue.ingest(r.events);
      for (const t of queue.drainEmittable()) emitted.push([t.turnId, t.finalText]);
    };

    // Mark built (message submitted) but no drain has happened yet; the user
    // presses the explicit Stop control within the sub-second window.
    queue.mark('om_1', '问题一：只回复 A1');
    expect(queue.dropPendingTurn('om_1', undefined, true)).not.toBeNull();
    // Its prompt section is only observed NOW (next poll) — must match no mark.
    writeFileSync(assignment, heading(new Date().toISOString(), '问题一：只回复 A1'));
    tick();
    // The following fast turn must pair with its own answer normally.
    queue.mark('om_2', '问题二：只回复 A2');
    writeFileSync(assignment, heading(new Date(Date.now() + 1_000).toISOString(), '问题二：只回复 A2'), { flag: 'a' });
    writeFileSync(trajectory, finalRow('A2'));
    tick();
    expect(emitted).toEqual([['om_2', 'A2']]);
  });

  it('does not deliver a late terminal answer that lands after the turn was interrupted', () => {
    // Documented stop semantics (docs/doubao §3/§6): Esc settles the turn as
    // stopped and the mark is retired; a terminal answer the model writes at
    // almost the same moment has no owner (openTurns=0, no prompt in the
    // window) and must NOT be emitted as a Lark reply. The text stays visible
    // in the native terminal/logs; other structured bridges behave the same.
    const root = join(tmpdir(), `doubao-late-final-${process.pid}`);
    const { trajectory } = makeSession(root);
    // No assignment delta in this window (its prompt was drained earlier);
    // queue reports zero open turns because Esc retired the mark.
    writeFileSync(trajectory, finalRow('迟到的回答'));
    const r = drainDoubaoTranscript(trajectory, 0, { openTurns: 0 });
    expect(r.events).toEqual([]);
  });
});

describe('doubao assignment heading/body split write', () => {
  it('holds at the heading when the body lands in a later append, then parses the whole turn', () => {
    // doubao's buffered writer can flush heading and body separately. The old
    // parser committed the offset past the body-less heading, so the body was
    // skipped forever: that Lark turn never started and its final could never
    // be attributed.
    const root = join(tmpdir(), `doubao-torn-heading-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    const ts = '2026-11-03T04:00:00.000Z';
    const queue = new CodexBridgeQueue(() => Date.parse(ts));
    queue.mark('turn-1', '撕裂写入的正文：只回复 SPLIT_OK', Date.parse(ts));
    const cursor = { offset: 0, state: undefined as unknown };
    const tick = () => {
      const r = tickDrain(trajectory, cursor, queue);
      queue.ingest(r.events);
      return { r, ready: queue.drainEmittable() };
    };

    writeFileSync(assignment, heading(ts, '').trimEnd() + '\n');
    let t = tick();
    expect(t.r.events).toEqual([]);
    expect((t.r.state as { assignmentOffset: number }).assignmentOffset).toBe(0);

    writeFileSync(assignment, '撕裂写入的正文：只回复 SPLIT_OK\n', { flag: 'a' });
    t = tick();
    expect(t.r.events.map(e => e.kind)).toEqual(['user']);
    expect(t.r.events[0]!.text).toBe('撕裂写入的正文：只回复 SPLIT_OK');

    writeFileSync(trajectory, finalRow('SPLIT_OK'));
    t = tick();
    expect(t.r.events.map(e => e.kind)).toEqual(['assistant_final']);
    expect(t.ready.map(x => [x.turnId, x.finalText])).toEqual([['turn-1', 'SPLIT_OK']]);
  });
});
