import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainTraexRollout } from '../src/services/traex-transcript.js';
import { CodexBridgeQueue, STRUCTURED_SUBMIT_START_GRACE_MS } from '../src/services/codex-bridge-queue.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';
import { uncollectedTurnsNeedingNotice } from '../src/services/structured-uncollected-notice.js';

const SID = '00000000-0000-7000-8000-000000000001';
const NATIVE = '00000000-0000-7000-8000-000000000002';
const START = Date.parse('2026-01-01T00:00:00.000Z');
let dir: string;
let path: string;

function input(text: string, id: string, at = START, turnId = NATIVE) {
  return {
    timestamp: new Date(at).toISOString(), type: 'history_mutation',
    payload: {
      version: 1, commit_id: id, operation: 'append', turn_id: turnId,
      items: [{ type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] }],
      display_completions: [{ thread_id: SID, turn_id: turnId,
        item: { type: 'UserMessage', id, content: [{ type: 'text', text }] },
        started_at_ms: at, completed_at_ms: at }],
    },
  };
}

function terminal(at = START + 2_000, turnId = NATIVE, aborted = false) {
  return { timestamp: new Date(at).toISOString(), type: 'event_msg',
    payload: aborted ? { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }
      : { type: 'task_complete', turn_id: turnId, last_agent_message: 'Combined answer' } };
}

function append(...records: unknown[]) {
  appendFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

function event(text: string, id: string, at = START): CodexBridgeEvent {
  return { kind: 'user', text, uuid: `event-${id}`, timestampMs: at,
    sourceSessionId: SID, sourceTurnId: NATIVE, sourceMessageId: id };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traex-same-turn-'));
  path = join(dir, `rollout-2026-01-01T00-00-00-${SID}.jsonl`);
  writeFileSync(path, '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('TRAE messages merged into one native turn', () => {
  for (const identicalText of [false, true]) {
    for (const incremental of [false, true]) {
      it(`recognizes distinct messages (${identicalText ? 'same' : 'different'} text, ${incremental ? 'incremental' : 'one'} drain)`, () => {
        const second = identicalText ? 'Continue the task' : 'Use the correction';
        append(input('Continue the task', 'first'));
        let events: CodexBridgeEvent[] = [];
        let offset = 0;
        if (incremental) {
          const first = drainTraexRollout(path, offset);
          events.push(...first.events); offset = first.newOffset;
        }
        append(input(second, 'second', START + 1_000), terminal());
        events.push(...drainTraexRollout(path, offset).events);
        expect(events.filter(ev => ev.kind === 'user').map(ev => ev.sourceMessageId)).toEqual(['first', 'second']);

        let now = START + 2_000;
        const queue = new CodexBridgeQueue(() => now);
        const receipts: string[] = [];
        const superseded: string[] = [];
        queue.setTurnStartObserver(turn => receipts.push(turn.turnId));
        queue.setCotSupersededObserver(turn => superseded.push(turn.turnId));
        queue.mark('lark-first', 'Continue the task', START);
        queue.mark('lark-second', second, START + 1_000);
        queue.ingest(events);
        expect(receipts).toEqual(['lark-first', 'lark-second']);
        expect(superseded).toEqual(['lark-first']);
        expect(queue.drainEmittable()).toEqual([expect.objectContaining({
          turnId: 'lark-second', finalText: 'Combined answer', sourceTurnId: NATIVE,
        })]);
        now += STRUCTURED_SUBMIT_START_GRACE_MS + 1;
        expect(queue.pruneExpiredPreStartHeads()).toEqual([]);
        expect(queue.size()).toBe(0);
      });
    }
  }

  it('deduplicates display and event mirrors by message id across incremental drains', () => {
    const first = input('Continue', 'first');
    append(first);
    const initial = drainTraexRollout(path, 0);
    append({ timestamp: new Date(START + 500).toISOString(), type: 'event_msg',
      payload: { type: 'item_completed', thread_id: SID, turn_id: NATIVE,
        item: first.payload.display_completions[0].item } },
    input('Continue', 'first', START + 700), input('Continue', 'second', START + 1_000));
    const later = drainTraexRollout(path, initial.newOffset);
    expect([...initial.events, ...later.events].filter(ev => ev.kind === 'user')
      .map(ev => ev.sourceMessageId)).toEqual(['first', 'second']);
  });

  it('a submit probe does not consume the production reader receipts', () => {
    append(input('Task', 'first'), input('Correction', 'second', START + 1_000));
    expect(drainTraexRollout(path, 0, { probe: true }).events.filter(ev => ev.kind === 'user')).toHaveLength(2);
    expect(drainTraexRollout(path, 0).events.filter(ev => ev.kind === 'user')).toHaveLength(2);
  });

  it('retired mirror state does not swallow an identical legacy input in the next turn', () => {
    append(input('Continue', 'first'), input('Continue', 'second', START + 1_000), terminal());
    const initial = drainTraexRollout(path, 0);
    append({ timestamp: new Date(START + 2_100).toISOString(), type: 'event_msg',
      payload: { type: 'user_message', message: 'Continue' } });
    expect(drainTraexRollout(path, initial.newOffset).events.filter(ev => ev.kind === 'user')
      .map(ev => ev.text)).toEqual(['Continue']);
  });

  it('the legacy first-message mirror binds without becoming an extra steering input', () => {
    append({ timestamp: new Date(START).toISOString(), type: 'event_msg',
      payload: { type: 'user_message', message: 'Task' } });
    const first = drainTraexRollout(path, 0);
    append(input('Task', 'first', START + 100), input('Correction', 'second', START + 1_000), terminal());
    const later = drainTraexRollout(path, first.newOffset);
    const queue = new CodexBridgeQueue();
    queue.mark('lark-first', 'Task', START);
    queue.mark('lark-second', 'Correction', START + 1_000);
    queue.ingest([...first.events, ...later.events]);
    expect(later.events.filter(ev => ev.kind === 'user').map(ev => ev.text)).toEqual(['Correction']);
    expect(queue.drainEmittable().map(turn => turn.turnId)).toEqual(['lark-second']);
    expect(queue.size()).toBe(0);
  });

  it('a turn-bound id-less adopt turn ignores the same message replayed from another rollout path', () => {
    // Late attach replays an id-less legacy user record first; its UserMessage
    // mirror arrives in a later drain as a turn_bind that establishes the
    // native (turn, message) identity. A resumed/rotated rollout segment then
    // replays the SAME native message under a fresh uuid — the queue's
    // logical-message dedup (shared across rollout paths, unlike the per-path
    // drainer receipts) must suppress it instead of synthesizing a duplicate
    // local turn that supersedes the bound one.
    const queue = new CodexBridgeQueue();
    queue.setLocalTurns(true, START);
    const superseded: string[] = [];
    queue.setCotSupersededObserver(turn => superseded.push(turn.turnId));
    queue.ingest([{ kind: 'user', text: 'Task', uuid: 'legacy-user', timestampMs: START,
      sourceSessionId: SID }]);
    queue.ingest([{ kind: 'turn_bind', text: '', uuid: 'delayed-bind', timestampMs: START + 100,
      sourceSessionId: SID, sourceTurnId: NATIVE, sourceMessageId: 'first' }]);
    queue.ingest([{ kind: 'user', text: 'Task', uuid: 'replayed-from-next-segment',
      timestampMs: START + 200, sourceSessionId: SID, sourceTurnId: NATIVE,
      sourceMessageId: 'first' }]);
    expect(queue.peek().map(turn => turn.turnId)).toEqual(['codex-local-legacy-user']);
    expect(queue.peek()[0]).toEqual(expect.objectContaining({
      sourceTurnId: NATIVE, sourceMessageId: 'first',
    }));
    expect(superseded).toEqual([]);
  });

  it('a resumed segment replaying the same message does not synthesize a second local turn', () => {
    // TraeX writes a resumed session as a new rollout segment that replays the
    // copied user record under a fresh path (hence a fresh event uuid). The
    // (turn, message) identity is unchanged, so adopt-mode synthesis must not
    // open a second local turn that supersedes the still-open first one.
    const resumed = join(dir, `rollout-2026-01-01T00-00-00-${SID}_${NATIVE}.jsonl`);
    writeFileSync(resumed, '');
    append(input('Task', 'first'));
    appendFileSync(resumed, JSON.stringify(input('Task', 'first')) + '\n');
    const queue = new CodexBridgeQueue();
    queue.setLocalTurns(true, START);
    const superseded: string[] = [];
    queue.setCotSupersededObserver(turn => superseded.push(turn.turnId));
    queue.ingest(drainTraexRollout(path, 0, { adoptMode: true }).events);
    queue.ingest(drainTraexRollout(resumed, 0, { adoptMode: true }).events);
    expect(queue.peek()).toHaveLength(1);
    expect(superseded).toEqual([]);
  });

  it('an interrupted merged turn settles the latest input as ambiguous', () => {
    append(input('Task', 'first'), input('Correction', 'second', START + 1_000), terminal(START + 2_000, NATIVE, true));
    const queue = new CodexBridgeQueue();
    queue.mark('lark-first', 'Task', START);
    queue.mark('lark-second', 'Correction', START + 1_000);
    queue.ingest(drainTraexRollout(path, 0).events);
    expect(queue.drainEmittable()).toEqual([expect.objectContaining({
      turnId: 'lark-second', terminalStatus: 'ambiguous', finalText: '',
    })]);
    expect(queue.size()).toBe(0);
  });

  it('a mirrored superseded message cannot consume a third identical queued input', () => {
    const queue = new CodexBridgeQueue();
    queue.mark('lark-first', 'Continue', START);
    queue.mark('lark-second', 'Continue', START);
    queue.mark('lark-third', 'Continue', START);
    queue.ingest([event('Continue', 'first'), event('Continue', 'second', START + 1_000),
      { ...event('Continue', 'first', START + 1_500), uuid: 'late-first-mirror' }]);
    expect(queue.peek().map(turn => [turn.turnId, turn.started])).toEqual([
      ['lark-second', true], ['lark-third', false],
    ]);
  });

  it('an unmatched or stale message cannot supersede a running task', () => {
    const queue = new CodexBridgeQueue();
    queue.mark('lark-first', 'Task', START);
    queue.mark('lark-second', 'Correction', START + 1_000);
    queue.ingest([event('Task', 'first'), event('Unrelated', 'stray', START + 1_000),
      event('Correction', 'stale', START - 10_000)]);
    expect(queue.peek().map(turn => [turn.turnId, turn.started])).toEqual([
      ['lark-first', true], ['lark-second', false],
    ]);
  });

  it('an early transcript receipt remains available until its pending message is marked', () => {
    const queue = new CodexBridgeQueue();
    queue.mark('lark-first', 'Task', START);
    queue.ingest([event('Task', 'first'), event('Correction', 'second', START + 1_000)]);
    queue.mark('lark-second', 'Correction', START + 1_000);
    queue.ingest([{ kind: 'assistant_final', text: 'Combined answer', uuid: 'terminal',
      timestampMs: START + 2_000, sourceSessionId: SID, sourceTurnId: NATIVE }]);
    expect(queue.drainEmittable().map(turn => turn.turnId)).toEqual(['lark-second']);
    expect(queue.size()).toBe(0);
  });

  it('adopted local corrections receive the single combined final', () => {
    append(input('Task', 'first'), input('Correction', 'second', START + 1_000), terminal());
    const queue = new CodexBridgeQueue();
    queue.setLocalTurns(true, START);
    queue.ingest(drainTraexRollout(path, 0, { adoptMode: true }).events);
    expect(queue.drainEmittable()).toEqual([expect.objectContaining({
      isLocal: true, userText: 'Correction', finalText: 'Combined answer',
    })]);
    expect(queue.size()).toBe(0);
  });

  it('thinking after a correction belongs to the latest accepted message', () => {
    const queue = new CodexBridgeQueue();
    const thinking: string[] = [];
    queue.setCotObserver((_entries, turn) => thinking.push(turn.turnId));
    queue.mark('lark-first', 'Task', START);
    queue.mark('lark-second', 'Correction', START + 1_000);
    queue.ingest([event('Task', 'first'), event('Correction', 'second', START + 1_000),
      { kind: 'cot', text: '', uuid: 'thinking', timestampMs: START + 1_500,
        sourceSessionId: SID, sourceTurnId: NATIVE, cotEntries: [{ kind: 'thinking', text: 'Working' }] }]);
    expect(thinking).toEqual(['lark-second']);
  });

  it('an input without any native receipt still produces the missing-transcript notice', () => {
    let now = START + 2_000;
    const queue = new CodexBridgeQueue(() => now);
    queue.mark('lark-first', 'Task', START);
    queue.mark('lark-missing', 'Missing correction', START + 1_000);
    append(input('Task', 'first'), terminal());
    queue.ingest(drainTraexRollout(path, 0).events);
    queue.drainEmittable();
    now += STRUCTURED_SUBMIT_START_GRACE_MS + 1;
    const expired = queue.pruneExpiredPreStartHeads();
    expect(uncollectedTurnsNeedingNotice(expired, { settledByTerminal: new Set(), hasOwnNotice: () => false })
      .map(turn => turn.turnId)).toEqual(['lark-missing']);
  });
});
