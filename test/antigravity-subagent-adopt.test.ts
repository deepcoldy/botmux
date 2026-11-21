import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainAntigravityTranscript, hasAntigravityPendingTasks, type AntigravityTranscriptState } from '../src/services/antigravity-transcript.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';

let root: string;
let path: string;
let offset: number;
let state: AntigravityTranscriptState;
let pendingTail: string;
const time = Date.parse('2026-11-21T00:00:00Z');
const user = (content: string) => ({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content });
const final = (content: string) => ({ type: 'PLANNER_RESPONSE', content });
const created = (id: string) => ({ type: 'GENERIC', status: 'DONE', content: `Created the following subagent:\n{\n  "conversationId": "${id}"\n}` });
const reply = (id: string) => ({ type: 'SYSTEM_MESSAGE', content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-21T00:00:10Z sender=${id} priority=MESSAGE_PRIORITY_HIGH content=结果😀\n</SYSTEM_MESSAGE>` });
const tools = (name: string, args: unknown = {}) => ({ type: 'PLANNER_RESPONSE', tool_calls: [{ name, args }] });
function encoded(record: object) { return JSON.stringify({ created_at: new Date(time).toISOString(), ...record }) + '\n'; }
function append(...records: object[]) { appendFileSync(path, records.map(encoded).join('')); }
function drain(adoptMode = true, flushTrailingFinal = false) {
  const result = drainAntigravityTranscript(path, offset, state, { adoptMode, flushTrailingFinal });
  offset = result.newOffset;
  state = result.state;
  pendingTail = result.pendingTail;
  return result.events;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(time);
  root = mkdtempSync(join(tmpdir(), 'agy-review-'));
  path = join(root, 'transcript.jsonl');
  writeFileSync(path, '');
  offset = 0;
  state = {};
  pendingTail = '';
});
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

describe('Antigravity subagent waits in adopt mode', () => {
  it('aborts an interrupted adopt Lark turn, attributes local replacement separately and ignores orphan finals', () => {
    const queue = new CodexBridgeQueue();
    queue.setLocalTurns(true, time);
    queue.mark('lark-1', 'Lark review', time, undefined, undefined, undefined, true);
    append(user('Lark review'), created('a'), created('b'), final('Waiting'));
    queue.ingest(drain());
    const oldSource = state.sourceTurnId;
    expect(drain(true, true)).toEqual([]);
    append(user('Terminal follow-up'), final('Local reply'));
    const events = drain(true, true);
    expect(events[0]).toMatchObject({ kind: 'turn_aborted', sourceTurnId: oldSource });
    expect(events[2]).toMatchObject({ kind: 'assistant_final', text: 'Local reply', sourceTurnId: events[1].sourceTurnId });
    queue.ingest(events);
    const delivered = queue.drainEmittable();
    expect(delivered[0]).toMatchObject({ turnId: 'lark-1', finalText: '', terminalStatus: 'ambiguous' });
    expect(delivered[1]).toMatchObject({ finalText: 'Local reply', isLocal: true });
    append(reply('a'), reply('b'), final('Old callback narration'));
    queue.ingest(drain(true, true));
    expect(queue.drainEmittable()).toEqual([]);
  });

  it('cancels one agent while preserving the other and a command wait after state serialization', () => {
    append(user('review'), created('a'), created('b'), { type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task' }, final('Waiting'));
    drain();
    state = JSON.parse(JSON.stringify(state));
    append(tools('manage_subagents', { Action: '"kill"', ConversationIds: '["a"]' }), final('Still waiting'));
    expect(drain(true, true)).toEqual([]);
    expect(state).toMatchObject({ hasPendingTask: true, pendingSubagentIds: ['b'] });
    append(reply('b'), final('Command remains'));
    expect(drain(true, true)).toEqual([]);
    append(reply('parent/task-1'), final('Completed'));
    expect(drain(true, true)).toEqual([expect.objectContaining({ text: 'Completed' })]);
  });

  it('retains the exact adopt input source across foreground tools, notices, errors, replies and kill_all', () => {
    append(user('review'), created('a'), created('b'), final('Waiting'));
    const input = drain()[0];
    for (const record of [
      tools('read_file'),
      { type: 'GENERIC', status: 'DONE', content: 'file contents' },
      { type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>\nReminder: be concise.\n</SYSTEM_MESSAGE>' },
      { type: 'ERROR_MESSAGE', content: 'retry the model' },
      reply('a'),
      tools('manage_subagents', { Action: '"kill_all"' }),
    ]) {
      append(record);
      expect(drain(true, true)).toEqual([]);
      expect(state.sourceTurnId).toBe(input.sourceTurnId);
    }
    expect(state.provisionalFinal).toBeUndefined();
    expect(hasAntigravityPendingTasks(state)).toBe(false);
    append(final('Stopped review'));
    const result = drain(true, true);
    expect(result).toEqual([expect.objectContaining({ text: 'Stopped review', sourceTurnId: input.sourceTurnId })]);
    expect(state.sourceTurnId).toBeUndefined();
    append(final('Unattributed follow-up'));
    expect(drain(true, true)).toEqual([]);
  });

  it.each([false, true])('clears adopt source after an EOF final flush (idle flush=%s)', idleFlush => {
    append(user('review'), created('a'), final('Waiting'), reply('a'), final('Completed'));
    const input = drain()[0];
    let result;
    if (idleFlush) result = drain(true, true);
    else { append({ type: 'CHECKPOINT' }); result = drain(true, true); }
    expect(result).toEqual([expect.objectContaining({ text: 'Completed', sourceTurnId: input.sourceTurnId })]);
    expect(state).toEqual({});
    append(reply('a'), final('Duplicate result narration'));
    expect(drain(true, true)).toEqual([]);
  });

  it('keeps state and attribution across a half-written explicit new input', () => {
    append(user('first'), created('a'), final('Waiting'));
    drain();
    const oldSource = state.sourceTurnId;
    const bytes = Buffer.from(encoded(user('第二问😀')));
    const split = bytes.indexOf(Buffer.from('😀')) + 2;
    appendFileSync(path, bytes.subarray(0, split));
    expect(drain(true, true)).toEqual([]);
    expect(state.sourceTurnId).toBe(oldSource);
    expect(state.pendingSubagentIds).toEqual(['a']);
    expect(pendingTail).not.toBe('');
    state = JSON.parse(JSON.stringify(state));
    appendFileSync(path, bytes.subarray(split));
    const events = drain(true, true);
    expect(events.map(e => e.kind)).toEqual(['turn_aborted', 'user']);
    expect(events[1].text).toBe('第二问😀');
    expect(state.sourceTurnId).toBe(events[1].sourceTurnId);
    expect(hasAntigravityPendingTasks(state)).toBe(false);
    expect(drain(true, true)).toEqual([]);
  });

  it('folds creation and replies at every byte split exactly once with serialized state recovery', () => {
    for (const record of [created('a'), reply('a')]) {
      const bytes = Buffer.from(encoded(record));
      for (let split = 1; split < bytes.length; split++) {
        writeFileSync(path, encoded(user('review')) + encoded(created('initial')) + encoded(final('Waiting')));
        offset = 0; state = {};
        drain();
        if (record.type === 'SYSTEM_MESSAGE') { append(created('a')); drain(); }
        appendFileSync(path, bytes.subarray(0, split));
        const first = drain(true, true);
        state = JSON.parse(JSON.stringify(state));
        appendFileSync(path, bytes.subarray(split));
        const second = drain(true, true);
        expect([...first, ...second]).toEqual([]);
        expect(state.pendingSubagentIds).toEqual(record.type === 'SYSTEM_MESSAGE' ? ['initial'] : ['initial', 'a']);
        expect(drain(true, true)).toEqual([]);
      }
    }
  });
});
