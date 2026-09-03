import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { drainEbsdTranscript } from '../src/services/ebsd-transcript.js';

const TS = '2026-08-25T12:00:00.000Z';
let root = '';
let path = '';

function record(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function message(
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  stopReason?: string,
): string {
  return record({
    type: 'message',
    id,
    parentId,
    timestamp: TS,
    ...(stopReason ? { stopReason } : {}),
    message: { role, content },
  });
}

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-ebsd-transcript-'));
  path = join(root, 'session.jsonl');
  writeFileSync(path, '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('drainEbsdTranscript', () => {
  it('waits for the committed ebsd marker across hidden finalization turns', () => {
    appendFileSync(path,
      message('u1', null, 'user', text('diagnose volume'))
      + message('a1', 'u1', 'assistant', text('visible diagnosis'), 'stop')
      + message('d1', 'a1', 'developer', text('hidden diagnosis_complete'))
      + message('a2', 'd1', 'assistant', [{
        type: 'toolCall', id: 'tool-1', name: 'diagnosis_complete', arguments: {},
      }], 'toolUse')
      + message('t1', 'a2', 'toolResult', text('completed'))
      + message('a3', 't1', 'assistant', [], 'stop'));

    const beforeCommit = drainEbsdTranscript(path, 0);
    expect(beforeCommit.events.map(event => [event.kind, event.text])).toEqual([
      ['user', 'diagnose volume'],
    ]);

    appendFileSync(path, record({
      type: 'custom',
      id: 'terminal-1',
      parentId: 'a3',
      timestamp: TS,
      customType: 'ebsd.botmux.turn_completed.v1',
      data: {
        schema_version: 1,
        outcome: 'completed',
        answer: 'visible diagnosis',
        finalization: 'forced',
        diagnosis_status: 'completed',
      },
    }));

    const committed = drainEbsdTranscript(path, beforeCommit.newOffset, beforeCommit.state);
    expect(committed.events).toMatchObject([{
      kind: 'assistant_final',
      text: 'visible diagnosis',
    }]);
  });

  it('fails closed on malformed or empty-completed terminal markers', () => {
    appendFileSync(path,
      record({
        type: 'custom',
        id: 'bad-version',
        parentId: null,
        timestamp: TS,
        customType: 'ebsd.botmux.turn_completed.v1',
        data: { schema_version: 99 },
      })
      + record({
        type: 'custom',
        id: 'empty-completed',
        parentId: null,
        timestamp: TS,
        customType: 'ebsd.botmux.turn_completed.v1',
        data: {
          schema_version: 1,
          outcome: 'completed',
          answer: '',
          finalization: 'not_needed',
          diagnosis_status: 'not_started',
        },
      }));

    const result = drainEbsdTranscript(path, 0);
    expect(result.events).toHaveLength(2);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        terminalStatus: 'failed',
        terminalErrorCode: 'ebsd_bridge_protocol_error',
      }),
    ]));
  });

  it('does not advance past a partial JSONL tail', () => {
    const full = message('u1', null, 'user', text('first'));
    const partial = JSON.stringify({
      type: 'custom',
      customType: 'ebsd.botmux.turn_completed.v1',
    });
    writeFileSync(path, full + partial);

    const first = drainEbsdTranscript(path, 0);
    expect(first.events.map(event => event.text)).toEqual(['first']);
    expect(first.pendingTail).toBe(partial);

    appendFileSync(path, '\n');
    const second = drainEbsdTranscript(path, first.newOffset, first.state);
    expect(second.events).toMatchObject([{
      terminalStatus: 'failed',
      terminalErrorCode: 'ebsd_bridge_protocol_error',
    }]);
  });

  it('uses a new event generation after in-place transcript truncation', () => {
    writeFileSync(path, message('u1', null, 'user', text(`first-${'x'.repeat(256)}`)));
    const first = drainEbsdTranscript(path, 0);

    writeFileSync(path, message('u2', null, 'user', text('second')));
    const second = drainEbsdTranscript(path, first.newOffset, first.state);

    expect(second.events.map(event => event.text)).toEqual(['second']);
    expect(second.events[0]?.uuid).not.toBe(first.events[0]?.uuid);
    expect(second.state.generation).toBe(1);
  });
});
