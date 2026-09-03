import {
  appendFileSync,
  mkdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  drainOmpTranscript,
  type OmpTranscriptState,
} from '../src/services/omp-transcript.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';

const ROOT = join(tmpdir(), `botmux-omp-transcript-${process.pid}`);
const PATH = join(ROOT, 'session.jsonl');
const TS = '2026-08-20T12:00:00.000Z';

function entry(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function message(
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): string {
  return entry({
    type: 'message',
    id,
    parentId,
    timestamp: TS,
    message: { role, content, ...extra },
  });
}

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }];
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(PATH, '');
});

afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('drainOmpTranscript', () => {
  it('holds a trailing stop until an explicit quiet flush and emits it once', () => {
    appendFileSync(PATH,
      message('u1', null, 'user', text('hello'))
      + message('a1', 'u1', 'assistant', text('answer'), { stopReason: 'stop' }));

    const first = drainOmpTranscript(PATH, 0);
    expect(first.events.map(event => event.kind)).toEqual(['user']);
    expect(first.state.provisionalFinal?.event.text).toBe('answer');

    const quiet = drainOmpTranscript(PATH, first.newOffset, first.state, {
      flushTrailingFinal: true,
    });
    expect(quiet.events).toMatchObject([{
      kind: 'assistant_final',
      text: 'answer',
      uuid: `${PATH}:${Buffer.byteLength(message('u1', null, 'user', text('hello')))}`,
    }]);
    expect(quiet.state.provisionalFinal).toBeUndefined();

    const repeated = drainOmpTranscript(PATH, quiet.newOffset, quiet.state, {
      flushTrailingFinal: true,
    });
    expect(repeated.events).toEqual([]);
  });

  it('preserves a candidate across metadata but retracts it for a parent-linked continuation', () => {
    const initial = message('u1', null, 'user', text('hello'))
      + message('a1', 'u1', 'assistant', text('intermediate'), { stopReason: 'stop' });
    appendFileSync(PATH, initial);
    const first = drainOmpTranscript(PATH, 0);

    appendFileSync(PATH,
      entry({ type: 'title_change', id: 'm1', parentId: 'a1', timestamp: TS, title: 'metadata' })
      + entry({
        type: 'custom_message',
        id: 'c1',
        parentId: 'm1',
        timestamp: TS,
        customType: 'prewalk-continue',
        content: 'continue',
        display: false,
      })
      + message('a2', 'c1', 'assistant', text('real final'), { stopReason: 'stop' }));

    const continued = drainOmpTranscript(PATH, first.newOffset, first.state);
    expect(continued.events).toEqual([]);
    expect(continued.state.provisionalFinal?.event.text).toBe('real final');
    expect(continued.state.provisionalFinal?.event.uuid).toContain(':');
  });

  it('retracts an intermediate candidate on steering and attributes the merged final after FIFO users', () => {
    appendFileSync(PATH,
      message('u1', null, 'user', text('first'))
      + message('a1', 'u1', 'assistant', text('intermediate'), { stopReason: 'stop' })
      + message('u2', 'a1', 'user', text('steer two'), { steering: true })
      + message('u3', 'u2', 'user', text('steer three'), { steering: true })
      + message('a2', 'u3', 'assistant', text('merged'), { stopReason: 'stop' }));

    const result = drainOmpTranscript(PATH, 0);
    expect(result.events.map(event => [event.kind, event.text])).toEqual([
      ['user', 'first'],
      ['user', 'steer two'],
      ['user', 'steer three'],
    ]);
    expect(result.state.provisionalFinal?.event.text).toBe('merged');
  });

  it('feeds repeated steers to the existing queue so only the newest turn owns the merged final', () => {
    appendFileSync(PATH,
      message('u1', null, 'user', text('first'))
      + message('u2', 'u1', 'user', text('steer two'), { steering: true })
      + message('u3', 'u2', 'user', text('steer three'), { steering: true })
      + message('a1', 'u3', 'assistant', text('merged'), { stopReason: 'stop' }));

    const drained = drainOmpTranscript(PATH, 0);
    const flushed = drainOmpTranscript(PATH, drained.newOffset, drained.state, {
      flushTrailingFinal: true,
    });
    const queue = new CodexBridgeQueue();
    queue.mark('t1', 'first', 1);
    queue.mark('t2', 'steer two', 1);
    queue.mark('t3', 'steer three', 1);
    queue.ingest([...drained.events, ...flushed.events]);

    const ready = queue.drainEmittable();
    expect(ready.map(turn => turn.turnId)).toEqual(['t3']);
    expect(ready[0]?.finalText).toBe('merged');
    expect(queue.size()).toBe(0);
  });

  it('releases a prior candidate before the next ordinary user', () => {
    appendFileSync(PATH,
      message('u1', null, 'user', text('first'))
      + message('a1', 'u1', 'assistant', text('first final'), { stopReason: 'stop' })
      + message('u2', 'a1', 'user', text('second')));

    const result = drainOmpTranscript(PATH, 0);
    expect(result.events.map(event => [event.kind, event.text])).toEqual([
      ['user', 'first'],
      ['assistant_final', 'first final'],
      ['user', 'second'],
    ]);
    expect(result.state.provisionalFinal).toBeUndefined();
  });

  it.each([
    ['error', 'failed', 'omp_turn_error'],
    ['aborted', 'ambiguous', 'omp_turn_aborted'],
  ] as const)('keeps empty %s terminals as provisional %s outcomes', (stopReason, status, code) => {
    appendFileSync(PATH,
      message('u1', null, 'user', text('hello'))
      + message('a1', 'u1', 'assistant', [], { stopReason }));
    const result = drainOmpTranscript(PATH, 0);
    expect(result.state.provisionalFinal?.event).toMatchObject({
      kind: 'assistant_final',
      text: '',
      terminalStatus: status,
      terminalErrorCode: code,
    });
  });

  it('keeps a tool-free length terminal provisional', () => {
    appendFileSync(PATH,
      message('u1', null, 'user', text('hello'))
      + message('a1', 'u1', 'assistant', text('truncated answer'), { stopReason: 'length' }));
    const result = drainOmpTranscript(PATH, 0);
    expect(result.state.provisionalFinal?.event).toMatchObject({
      kind: 'assistant_final',
      text: 'truncated answer',
    });
  });

  it('treats toolUse and stop/length carrying tool calls as non-terminal', () => {
    const toolCall = [{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: {} }];
    appendFileSync(PATH,
      message('u1', null, 'user', text('hello'))
      + message('a1', 'u1', 'assistant', toolCall, { stopReason: 'toolUse' })
      + message('a2', 'a1', 'assistant', toolCall, { stopReason: 'stop' })
      + message('a3', 'a2', 'assistant', toolCall, { stopReason: 'length' }));
    const result = drainOmpTranscript(PATH, 0);
    expect(result.events.map(event => event.kind)).toEqual(['user']);
    expect(result.state.provisionalFinal).toBeUndefined();
  });

  it('does not advance past a partial JSONL tail and parses it exactly once after completion', () => {
    const user = message('u1', null, 'user', text('hello'));
    const assistant = message('a1', 'u1', 'assistant', text('done'), { stopReason: 'stop' });
    appendFileSync(PATH, user + assistant.slice(0, -1));

    const partial = drainOmpTranscript(PATH, 0);
    expect(partial.events.map(event => event.kind)).toEqual(['user']);
    expect(partial.newOffset).toBe(Buffer.byteLength(user));
    expect(partial.pendingTail).not.toBe('');
    expect(partial.state.provisionalFinal).toBeUndefined();

    appendFileSync(PATH, '\n');
    const completed = drainOmpTranscript(PATH, partial.newOffset, partial.state);
    expect(completed.events).toEqual([]);
    expect(completed.state.provisionalFinal?.event.text).toBe('done');
  });

  it('preserves metadata across drains and retracts on later same-lineage activity', () => {
    appendFileSync(PATH,
      message('u1', null, 'user', text('hello'))
      + message('a1', 'u1', 'assistant', text('intermediate'), { stopReason: 'stop' }));
    const candidate = drainOmpTranscript(PATH, 0);

    appendFileSync(PATH,
      entry({ type: 'title_change', id: 'm1', parentId: 'a1', timestamp: TS, title: 'metadata' }));
    const metadata = drainOmpTranscript(PATH, candidate.newOffset, candidate.state);
    expect(metadata.events).toEqual([]);
    expect(metadata.state.provisionalFinal?.event.text).toBe('intermediate');

    appendFileSync(PATH,
      message('tool1', 'm1', 'toolResult', text('continued work')));
    const continued = drainOmpTranscript(PATH, metadata.newOffset, metadata.state);
    expect(continued.events).toEqual([]);
    expect(continued.state.provisionalFinal).toBeUndefined();
  });

  it('resets stale provisional state when the file truncates', () => {
    appendFileSync(PATH,
      message('u1', null, 'user', text('old'))
      + message('a1', 'u1', 'assistant', text('old final'), { stopReason: 'stop' }));
    const old = drainOmpTranscript(PATH, 0);
    expect(old.state.provisionalFinal).toBeDefined();

    truncateSync(PATH, 0);
    appendFileSync(PATH, message('u2', null, 'user', text('new')));
    const reset = drainOmpTranscript(PATH, old.newOffset, old.state as OmpTranscriptState);
    expect(reset.events.map(event => event.text)).toEqual(['new']);
    expect(reset.state.provisionalFinal).toBeUndefined();
  });
});
