import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import {
  drainTraexRollout,
  traexRolloutHasUserInputSince,
} from '../src/services/traex-transcript.js';

const SID = '00000000-0000-7000-8000-000000000001';
let dir: string;
let path: string;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function user(text: string, timestamp = '2000-01-01T00:00:01.000Z') {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  };
}

function assistantProgress(text: string) {
  return {
    timestamp: '2000-01-01T00:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      // TRAE rollout shape: no phase. These records are emitted during
      // tool use and therefore must never close a turn.
      content: [{ type: 'output_text', text }],
    },
  };
}

function taskComplete(lastAgentMessage?: string) {
  return {
    timestamp: '2000-01-01T00:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '00000000-0000-7000-8000-000000000010',
      ...(lastAgentMessage === undefined ? {} : { last_agent_message: lastAgentMessage }),
      completed_at: 946_684_803,
      duration_ms: 1_000,
    },
  };
}

function turnAborted(reason: unknown = 'interrupted') {
  return {
    timestamp: '2000-01-01T00:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'turn_aborted',
      turn_id: '00000000-0000-7000-8000-000000000010',
      reason,
      completed_at: 946_684_803,
      duration_ms: 1_000,
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traex-transcript-'));
  path = join(dir, `rollout-2000-01-01T00-00-00-${SID}.jsonl`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('drainTraexRollout', () => {
  it('uses task_complete as the terminal and ignores phase-less assistant progress', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(assistantProgress('intermediate tool commentary')),
      line(assistantProgress('final-looking but still not a boundary')),
      line(taskComplete('durable final answer')),
    ].join(''));

    const result = drainTraexRollout(path, 0);
    expect(result.events).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: 'do the work',
        sourceSessionId: SID,
      }),
      expect.objectContaining({
        kind: 'assistant_final',
        text: 'durable final answer',
        sourceSessionId: SID,
      }),
    ]);
  });

  it('emits an empty task_complete so a silent durable turn can settle', () => {
    writeFileSync(path, line(user('finish silently')) + line(taskComplete()));
    const result = drainTraexRollout(path, 0);
    expect(result.events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
    }));
  });

  it('maps a turn_aborted shape to ambiguous with a bounded safe error code', () => {
    writeFileSync(path, line(user('cancel me')) + line(turnAborted('Interrupted by user / unsafe')));
    const result = drainTraexRollout(path, 0);
    expect(result.events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'ambiguous',
      terminalErrorCode: 'traex_turn_aborted:interrupted_by_user_unsafe',
    }));

    const queue = new CodexBridgeQueue();
    queue.mark('cancelled-delivery', 'cancel me', Date.parse('2000-01-01T00:00:00.000Z'), 6);
    queue.ingest(result.events);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'cancelled-delivery',
        dispatchAttempt: 6,
        terminalStatus: 'ambiguous',
        terminalErrorCode: 'traex_turn_aborted:interrupted_by_user_unsafe',
      }),
    ]);
  });

  it('does not advance over or emit a crash-partial terminal tail', () => {
    const first = line(user('partial-tail test'));
    const terminal = JSON.stringify(taskComplete('done'));
    writeFileSync(path, first + terminal.slice(0, -8));

    const beforeComplete = drainTraexRollout(path, 0);
    expect(beforeComplete.events.map(event => event.kind)).toEqual(['user']);
    expect(beforeComplete.newOffset).toBe(Buffer.byteLength(first));
    expect(beforeComplete.pendingTail.length).toBeGreaterThan(0);

    appendFileSync(path, terminal.slice(-8) + '\n');
    const afterComplete = drainTraexRollout(path, beforeComplete.newOffset);
    expect(afterComplete.events).toEqual([
      expect.objectContaining({ kind: 'assistant_final', text: 'done' }),
    ]);
  });

  it('preserves TRAE steer attribution: the last typed-ahead turn gets the single completion', () => {
    writeFileSync(path, [
      line(user('first durable prompt', '2000-01-01T00:00:01.000Z')),
      line(user('second steered prompt', '2000-01-01T00:00:02.000Z')),
      line(taskComplete('one merged answer')),
    ].join(''));
    const queue = new CodexBridgeQueue();
    queue.mark('delivery-1', 'first durable prompt', Date.parse('2000-01-01T00:00:00.000Z'), 3);
    queue.mark('delivery-2', 'second steered prompt', Date.parse('2000-01-01T00:00:00.001Z'), 4);
    queue.ingest(drainTraexRollout(path, 0).events);

    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'delivery-2',
        dispatchAttempt: 4,
        finalText: 'one merged answer',
      }),
    ]);
  });
});

describe('traexRolloutHasUserInputSince', () => {
  it('matches only a complete exact user record appended after the baseline', () => {
    const old = line(user('same thread, old prompt'));
    writeFileSync(path, old);
    const baseline = Buffer.byteLength(old);
    appendFileSync(path, line(user('same thread, later prompt')));

    expect(traexRolloutHasUserInputSince(path, baseline, 'same thread, later prompt')).toBe(true);
    expect(traexRolloutHasUserInputSince(path, baseline, 'same thread, old prompt')).toBe(false);
    expect(traexRolloutHasUserInputSince(path, baseline, 'same thread')).toBe(false);
  });
});
