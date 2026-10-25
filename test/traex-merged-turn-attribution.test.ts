import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainTraexRollout } from '../src/services/traex-transcript.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { measureReplyTiming } from '../src/services/reply-card-render.js';

const sid = '00000000-0000-7000-8000-000000000001';
const native = 'native-first';
const at = (seconds: number) => new Date(946684800000 + seconds * 1000).toISOString();
function input(id: string, text: string, seconds: number, turnId = native) {
  return { timestamp: at(seconds), type: 'history_mutation', payload: {
    operation: 'append', turn_id: turnId, items: [], display_completions: [{
      thread_id: sid, turn_id: turnId,
      item: { type: 'UserMessage', id, content: [{ type: 'text', text }] },
    }],
  } };
}
function terminal(seconds: number, turnId = native, failed = false) {
  return { timestamp: at(seconds), type: 'event_msg', payload: {
    type: 'task_complete', turn_id: turnId, last_agent_message: failed ? null : 'answer',
    ...(failed ? { error: { message: 'provider failed' } } : {}),
  } };
}
const lines = (...records: unknown[]) => records.map(r => JSON.stringify(r) + '\n').join('');

describe('TraeX inputs merged into one native turn', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'traex-absorbed-'));
    path = join(dir, `rollout-2000-01-01T00-00-00-${sid}.jsonl`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    { label: 'legacy inputs without native turn ids', firstNative: undefined, secondNative: undefined,
      firstSession: 'session-a', secondSession: 'session-a' },
    { label: 'inputs from different native sessions', firstNative: native, secondNative: native,
      firstSession: 'session-a', secondSession: 'session-b' },
  ])('does not link superseded attribution for $label', row => {
    const q = new CodexBridgeQueue();
    q.mark('first', 'first request', Date.parse(at(0)));
    q.ingest([{ uuid: 'user-1', kind: 'user', text: 'first request', timestampMs: Date.parse(at(1)),
      sourceTurnId: row.firstNative, sourceSessionId: row.firstSession, sourceMessageId: 'input-1' }]);
    q.mark('second', 'second request', Date.parse(at(2)));
    q.ingest([{ uuid: 'user-2', kind: 'user', text: 'second request', timestampMs: Date.parse(at(3)),
      sourceTurnId: row.secondNative, sourceSessionId: row.secondSession, sourceMessageId: 'input-2' }]);
    const second = q.peek().find(turn => turn.turnId === 'second');
    expect(second?.started).toBe(true);
    expect(second?.supersededTurns).toBeUndefined();
  });

  it('does not link a synthetic local turn to a pending Lark input', () => {
    const q = new CodexBridgeQueue();
    q.setLocalTurns(true, Date.parse(at(0)));
    q.mark('first', 'first request', Date.parse(at(0)));
    q.ingest([{ uuid: 'user-1', kind: 'user', text: 'first request', timestampMs: Date.parse(at(1)),
      sourceTurnId: native, sourceSessionId: sid, sourceMessageId: 'input-1' }]);
    q.ingest([{ uuid: 'local-user', kind: 'user', text: 'typed locally', timestampMs: Date.parse(at(2)),
      sourceTurnId: native, sourceSessionId: sid, sourceMessageId: 'input-2' }]);
    expect(q.peek()).toHaveLength(1);
    expect(q.peek()[0]).toMatchObject({ isLocal: true, userText: 'typed locally' });
    expect(q.peek()[0].supersededTurns).toBeUndefined();
  });

  it('settles distinct added inputs with one native terminal and leaves the next round independent', () => {
    const q = new CodexBridgeQueue();
    q.mark('first', 'research storage', Date.parse(at(0)));
    q.mark('extra-1', 'only investigate', Date.parse(at(2)));
    q.mark('extra-2', 'read only please', Date.parse(at(3)));
    writeFileSync(path, lines(input('i1', 'research storage', 1), input('i2', 'only investigate', 2),
      input('i3', 'read only please', 3), terminal(10)));
    const drained = drainTraexRollout(path, 0);
    q.ingest(drained.events);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['extra-2']);
    expect(ready[0].supersededTurns?.map(t => t.turnId)).toEqual(['first', 'extra-1']);
    expect(ready.filter(t => t.finalText)).toHaveLength(1);
    expect(q.size()).toBe(0);
    q.mark('next', 'how to verify', Date.parse(at(3600)));
    appendFileSync(path, lines(input('i4', 'how to verify', 3601, 'native-next'), terminal(3660, 'native-next')));
    q.ingest(drainTraexRollout(path, drained.newOffset).events);
    const next = q.drainEmittable();
    expect(next.map(t => t.turnId)).toEqual(['next']);
    expect(next[0].transcriptStartTimeMs).toBe(Date.parse(at(3601)));
    expect(measureReplyTiming({ startedAtMs: next[0].transcriptStartTimeMs,
      nowMs: Date.parse(at(3659)), completed: false })?.executionDurationMs).toBe(58000);
  });

  it('deduplicates item mirrors across drains while accepting repeated text with a new item id', () => {
    const q = new CodexBridgeQueue();
    q.mark('first', 'repeat', Date.parse(at(0)));
    writeFileSync(path, lines(input('i1', 'repeat', 1)));
    const first = drainTraexRollout(path, 0);
    q.ingest(first.events);
    q.mark('extra', 'repeat', Date.parse(at(2)));
    appendFileSync(path, lines(input('i1', 'repeat', 2), input('i2', 'repeat', 3), terminal(4)));
    q.ingest(drainTraexRollout(path, first.newOffset).events);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['extra']);
    expect(ready[0].supersededTurns?.map(t => t.turnId)).toEqual(['first']);
    expect(ready[0].transcriptStartTimeMs).toBe(Date.parse(at(3)));
    expect(q.size()).toBe(0);
  });

  it('does not consume a queued input from raw model injections or a different native session', () => {
    const q = new CodexBridgeQueue();
    q.mark('first', 'research', Date.parse(at(0)));
    q.mark('extra', 'read only please', Date.parse(at(2)));
    const foreign = input('foreign', 'read only please', 3);
    foreign.payload.display_completions[0].thread_id = 'another-session';
    writeFileSync(path, lines(input('i1', 'research', 1), foreign, {
      timestamp: at(3), type: 'history_mutation', payload: { operation: 'append', turn_id: native,
        items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read only please' }] }] },
    }, terminal(4)));
    q.ingest(drainTraexRollout(path, 0).events);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['first']);
    expect(q.peek()).toEqual([expect.objectContaining({ turnId: 'extra', started: false })]);
  });

  it('keeps superseded input attribution available when the native task fails', () => {
    const q = new CodexBridgeQueue();
    q.mark('first', 'research', Date.parse(at(0)));
    q.mark('extra', 'read only please', Date.parse(at(2)));
    writeFileSync(path, lines(input('i1', 'research', 1), input('i2', 'read only please', 2), terminal(4, native, true)));
    q.ingest(drainTraexRollout(path, 0).events);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['extra']);
    expect(ready[0].supersededTurns?.map(t => t.turnId)).toEqual(['first']);
    expect(ready[0]).toMatchObject({ terminalStatus: 'failed' });
  });
});
