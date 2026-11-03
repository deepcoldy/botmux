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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  doubaoSystemDirForSession,
  drainDoubaoTranscript,
} from '../src/services/doubao-transcript.js';
import { doubaoBridgeSpec } from '../src/adapters/cli/doubao.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';

const SID = '38459999999999999';
const AGENT = 'm_agent1';

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

describe('doubao transcript bridge', () => {
  it('resolves the main-agent trajectory path by snowflake session id', () => {
    const root = join(tmpdir(), `doubao-bridge-locate-${process.pid}`);
    const { roots, systemDir, trajectory } = makeSession(root);
    writeFileSync(trajectory, '');
    expect(doubaoSystemDirForSession(SID, roots)).toBe(systemDir);
    // Non-snowflake ids are rejected.
    expect(doubaoSystemDirForSession('abc', roots)).toBeUndefined();
  });

  it('drains user prompt + terminal assistant answer and skips mid-turn rows', () => {
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
    expect(r1.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r1.events[0]!.text).toBe('请运行 date 并告诉我日期');
    expect(r1.events[1]!.text).toBe('今天是 2026-11-02。');
    expect(new Set(r1.events.map(e => e.uuid)).size).toBe(2);
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

/** Stateful cursor helper: replays what the worker's 1s ticker does. */
function tickDrain(trajectory: string, cursor: { offset: number; state: unknown }) {
  const r = drainDoubaoTranscript(trajectory, cursor.offset, { state: cursor.state });
  cursor.offset = r.newOffset;
  cursor.state = r.state;
  return r;
}

const heading = (ts: string, body: string) => `## [${ts}] 需求\n${body}\n`;
const finalRow = (text: string) => JSON.stringify({ role: 'assistant', content: text }) + '\n';

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
    let r = tickDrain(trajectory, cursor);
    queue.ingest(r.events);
    expect(r.events.map(e => e.kind)).toEqual(['user']);

    queue.mark('turn-2', '问题二：只回复 ANSWER_TWO', clock + 10_000);
    writeFileSync(assignment, heading(t2, '问题二：只回复 ANSWER_TWO'), { flag: 'a' });
    writeFileSync(trajectory, finalRow('ANSWER_ONE'));

    // tick 2: collision window — only ANSWER_ONE may be emitted; turn-2's
    // prompt is held (its section offset parked for re-parse).
    r = tickDrain(trajectory, cursor);
    expect(r.events.map(e => e.kind)).toEqual(['assistant_final']);
    expect(r.events[0]!.text).toBe('ANSWER_ONE');
    queue.ingest(r.events);
    let ready = queue.drainEmittable();
    expect(ready.map(t => [t.turnId, t.finalText])).toEqual([['turn-1', 'ANSWER_ONE']]);

    // tick 3: the held prompt re-parses and pairs with its own final (which
    // may land in the same window — still zero extra delay once paired).
    writeFileSync(trajectory, finalRow('ANSWER_TWO'), { flag: 'a' });
    r = tickDrain(trajectory, cursor);
    expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
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

    const r = drainDoubaoTranscript(trajectory, 0, {});
    expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    queue.ingest(r.events);
    expect(queue.drainEmittable().map(t => [t.turnId, t.finalText]))
      .toEqual([['turn-1', 'FAST_OK']]);
  });

  it('still emits a prompt with no final in the window (preserves the existing start path)', () => {
    const root = join(tmpdir(), `doubao-prompt-only-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    writeFileSync(assignment, heading('2026-11-03T03:00:00.000Z', '只有问题还没有回答'));
    const r = drainDoubaoTranscript(trajectory, 0, {});
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    expect((r.state as { openUserCount: number }).openUserCount).toBe(1);
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
    const cursor = { offset: 0, state: undefined as unknown };

    writeFileSync(assignment, heading(ts, '').trimEnd() + '\n');
    let r = tickDrain(trajectory, cursor);
    expect(r.events).toEqual([]);
    expect((r.state as { assignmentOffset: number }).assignmentOffset).toBe(0);

    writeFileSync(assignment, '撕裂写入的正文：只回复 SPLIT_OK\n', { flag: 'a' });
    r = tickDrain(trajectory, cursor);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    expect(r.events[0]!.text).toBe('撕裂写入的正文：只回复 SPLIT_OK');

    writeFileSync(trajectory, finalRow('SPLIT_OK'));
    r = tickDrain(trajectory, cursor);
    expect(r.events.map(e => e.kind)).toEqual(['assistant_final']);
  });
});
