import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { drainCodexRollout } from '../src/services/codex-transcript.js';
import { checkpointCodexAdoptTurns, restoreCodexAdoptTurns } from '../src/services/codex-adopt-recovery.js';

const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

function replay() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-lifecycle-overlap-'));
  const path = join(dir, 'rollout.jsonl');
  const journal = join(dir, 'pending.json');
  writeFileSync(path, '');
  let now = 90;
  let queue = new CodexBridgeQueue(() => now);
  let cursor = drainCodexRollout(path, 0);
  const line = (type: string, payload: unknown, time: number) => {
    now = time;
    appendFileSync(path, JSON.stringify({ type, payload, timestamp: new Date(time).toISOString() }) + '\n');
    cursor = drainCodexRollout(path, cursor.newOffset, cursor.state);
    queue.ingest(cursor.events);
  };
  const checkpoint = () => checkpointCodexAdoptTurns(journal, path, queue);
  const restore = () => {
    now = Math.max(now, ...queue.peek().map(turn => turn.markTimeMs ?? 0));
    checkpoint();
    queue = new CodexBridgeQueue(() => now);
    const recovery = restoreCodexAdoptTurns(journal, path, queue, drainCodexRollout(path, 0).events, now, now);
    queue.absorb(recovery.history);
    queue.ingest(recovery.live);
  };
  const setup = (withSession = true) => {
    queue.mark('a', 'First report', 90);
    checkpoint();
    if (withSession) line('session_meta', { id: 'provider' }, 95);
    line('event_msg', { type: 'task_started', turn_id: 'X' }, 100);
    line('response_item', user('First report'), 200);
    queue.mark('b', 'Second report', 290);
    checkpoint();
    line('response_item', user('Second report'), 300);
  };
  return { get queue() { return queue; }, line, setup, restore,
    close: () => rmSync(dir, { recursive: true, force: true }) };
}

function startMergedTurnWithActivePredecessor(h: ReturnType<typeof replay>) {
  h.queue.mark('z', 'Zero report', 90);
  h.line('session_meta', { id: 'provider' }, 95);
  h.line('event_msg', { type: 'task_started', turn_id: 'X0' }, 100);
  h.line('response_item', user('Zero report'), 200);
  h.queue.mark('a', 'Alpha report', 290);
  h.line('event_msg', { type: 'task_started', turn_id: 'X' }, 300);
  h.line('response_item', user('Alpha report'), 400);
  h.queue.mark('b', 'Bravo report', 490);
  h.line('response_item', user('Bravo report'), 500);
}

describe('Codex merged lifecycle overlaps with pending input', () => {
  const cases = (['task_complete', 'turn_aborted'] as const).flatMap(terminal =>
    (['none', 'before-start', 'after-start'] as const).flatMap(recovery =>
      (['no-mark', 'waiting-user', 'actual-user'] as const).map(shape => ({ terminal, recovery, shape }))));

  it.each(cases)('routes $terminal with $shape and recovery=$recovery', ({ terminal, recovery, shape }) => {
    const h = replay();
    try {
      h.setup();
      if (shape !== 'no-mark') h.queue.mark('c', 'Third report', 390);
      if (recovery === 'before-start') h.restore();
      h.line('event_msg', { type: 'task_started', turn_id: 'Y' }, 400);
      if (recovery === 'after-start') h.restore();
      // A new lifecycle alone is not evidence that the pending c was read.
      expect(h.queue.peek().find(turn => turn.turnId === 'c')?.started ?? false).toBe(false);
      if (shape === 'actual-user') h.line('response_item', user('Third report'), 500);
      h.line('event_msg', { type: terminal, turn_id: 'Y', last_agent_message: 'Y answer' }, 900);
      const ready = h.queue.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0]).toMatchObject({ turnId: shape === 'actual-user' ? 'c' : 'b',
        sourceTurnId: 'Y', finalText: terminal === 'task_complete' ? 'Y answer' : '',
        ...(terminal === 'turn_aborted' ? { terminalStatus: 'ambiguous' } : {}) });
      // X's receipts must never acquire credit for c's new execution.
      expect(ready[0].supersededTurns).toBeUndefined();
      expect(h.queue.peek().map(turn => [turn.turnId, turn.started])).toEqual(
        shape === 'waiting-user' ? [['c', false]] : []);
      // Closed X/Y replay cannot settle another pending input.
      h.line('event_msg', { type: 'task_complete', turn_id: 'X', last_agent_message: 'old X' }, 910);
      h.line('event_msg', { type: 'task_complete', turn_id: 'Y', last_agent_message: 'old Y' }, 920);
      expect(h.queue.drainEmittable()).toEqual([]);
      if (shape !== 'actual-user') {
        if (shape === 'no-mark') h.queue.mark('c', 'Third report', 940);
        h.line('response_item', user('Third report'), 950);
        h.line('event_msg', { type: 'task_complete', turn_id: 'Z', last_agent_message: 'C answer' }, 980);
        expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.finalText])).toEqual([['c', 'C answer']]);
      }
      expect(h.queue.size()).toBe(0);
    } finally { h.close(); }
  });

  it('does not deliver a late X abort after replacement user handoff and Y completion', () => {
    const h = replay();
    try {
      h.setup();
      h.queue.mark('c', 'Third report', 390);
      h.line('event_msg', { type: 'task_started', turn_id: 'Y' }, 400);
      h.line('response_item', user('Third report'), 500);
      h.line('event_msg', { type: 'task_complete', turn_id: 'Y', last_agent_message: 'C answer' }, 900);
      const ready = h.queue.drainEmittable();
      expect(ready.map(turn => [turn.turnId, turn.sourceTurnId, turn.finalText])).toEqual([
        ['c', 'Y', 'C answer'],
      ]);
      expect(ready[0].supersededTurns).toBeUndefined();
      h.queue.mark('d', 'Fourth report', 905);
      h.line('event_msg', { type: 'turn_aborted', turn_id: 'X' }, 910);
      expect(h.queue.drainEmittable()).toEqual([]);
      expect(h.queue.peek().map(turn => [turn.turnId, turn.started])).toEqual([['d', false]]);
      h.line('event_msg', { type: 'task_started', turn_id: 'Z' }, 940);
      h.line('response_item', user('Fourth report'), 950);
      h.line('event_msg', { type: 'task_complete', turn_id: 'Z', last_agent_message: 'D answer' }, 980);
      expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.sourceTurnId, turn.finalText])).toEqual([
        ['d', 'Z', 'D answer'],
      ]);
      expect(h.queue.size()).toBe(0);
    } finally { h.close(); }
  });

  it.each(['task_complete', 'turn_aborted'] as const)('settles exact X on %s while Y is only a replacement candidate', terminal => {
    const h = replay();
    try {
      h.setup();
      h.queue.mark('c', 'Third report', 390);
      h.line('event_msg', { type: 'task_started', turn_id: 'Y' }, 400);
      // No user handoff has happened: the HOL successor still owns X.
      h.line('event_msg', { type: terminal, turn_id: 'X', last_agent_message: 'B answer' }, 450);
      const ready = h.queue.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0]).toMatchObject({ turnId: 'b', sourceTurnId: 'X',
        finalText: terminal === 'task_complete' ? 'B answer' : '',
        ...(terminal === 'turn_aborted' ? { terminalStatus: 'ambiguous' } : {}) });
      expect(h.queue.peek().map(turn => [turn.turnId, turn.started])).toEqual([['c', false]]);
      h.line('event_msg', { type: 'task_started', turn_id: 'Z' }, 600);
      h.line('response_item', user('Third report'), 700);
      h.line('event_msg', { type: 'task_complete', turn_id: 'Z', last_agent_message: 'C answer' }, 900);
      expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.sourceTurnId, turn.finalText])).toEqual([
        ['c', 'Z', 'C answer'],
      ]);
      expect(h.queue.size()).toBe(0);
    } finally { h.close(); }
  });

  it('preserves independent replies when a replacement start meets multiple active turns', () => {
    const h = replay();
    try {
      startMergedTurnWithActivePredecessor(h);
      h.queue.mark('c', 'Charlie report', 590);
      h.line('event_msg', { type: 'task_started', turn_id: 'Y' }, 600);
      h.line('response_item', user('Charlie report'), 700);
      h.line('event_msg', { type: 'task_complete', turn_id: 'X0', last_agent_message: 'Z answer' }, 750);
      h.line('event_msg', { type: 'task_complete', turn_id: 'X', last_agent_message: 'AB answer' }, 800);
      h.line('event_msg', { type: 'task_complete', turn_id: 'Y', last_agent_message: 'C answer' }, 900);
      expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.sourceTurnId, turn.finalText])).toEqual([
        ['z', 'X0', 'Z answer'], ['b', 'X', 'AB answer'], ['c', 'Y', 'C answer'],
      ]);
      expect(h.queue.size()).toBe(0);
    } finally { h.close(); }
  });

  it('waits for exact terminal evidence when multiple active turns make replacement ambiguous', () => {
    const h = replay();
    try {
      startMergedTurnWithActivePredecessor(h);
      h.line('event_msg', { type: 'task_complete', turn_id: 'Y', last_agent_message: 'Unattributed answer' }, 600);
      expect(h.queue.drainEmittable()).toEqual([]);
      h.line('event_msg', { type: 'task_complete', turn_id: 'X0', last_agent_message: 'Z answer' }, 700);
      expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.sourceTurnId, turn.finalText])).toEqual([
        ['z', 'X0', 'Z answer'],
      ]);
      expect(h.queue.peek().map(turn => [turn.turnId, turn.sourceTurnId, turn.finalText])).toEqual([
        ['b', 'X', undefined],
      ]);
      h.line('event_msg', { type: 'task_complete', turn_id: 'X', last_agent_message: 'AB answer' }, 800);
      expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.sourceTurnId, turn.finalText])).toEqual([
        ['b', 'X', 'AB answer'],
      ]);
      expect(h.queue.size()).toBe(0);
    } finally { h.close(); }
  });

  it.each(['stale', 'foreign-session', 'new-session-evidence', 'no-HOL'])('retains exact ownership for a %s lifecycle', boundary => {
    const h = replay();
    try {
      if (boundary === 'no-HOL') {
        h.queue.mark('b', 'Second report', 90);
        h.line('session_meta', { id: 'provider' }, 95);
        h.line('event_msg', { type: 'task_started', turn_id: 'X' }, 100);
        h.line('response_item', user('Second report'), 300);
      } else h.setup(boundary !== 'new-session-evidence');
      h.queue.mark('c', 'Third report', 390);
      if (boundary === 'new-session-evidence') h.line('session_meta', { id: 'provider' }, 395);
      if (boundary === 'foreign-session') h.line('session_meta', { id: 'foreign' }, 395);
      h.line('event_msg', { type: 'task_started', turn_id: 'Y' }, boundary === 'stale' ? 250 : 400);
      // Without replacement proof the existing provisional-start policy applies.
      expect(h.queue.peek().find(turn => turn.turnId === 'c')?.started).toBe(true);
      h.line('response_item', user('Third report'), 500);
      h.line('event_msg', { type: 'task_complete', turn_id: 'Y', last_agent_message: 'C answer' }, 900);
      // c's exact Y may complete, but it must never consume b's X identity.
      expect(h.queue.drainEmittable()).toEqual([]);
      expect(h.queue.peek().map(turn => [turn.turnId, turn.sourceTurnId, turn.finalText])).toEqual([
        ['b', 'X', undefined], ['c', 'Y', 'C answer'],
      ]);
      h.line('session_meta', { id: 'provider' }, 910);
      h.line('event_msg', { type: 'task_complete', turn_id: 'X', last_agent_message: 'B answer' }, 920);
      expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.finalText])).toEqual([
        ['b', 'B answer'], ['c', 'C answer'],
      ]);
      expect(h.queue.size()).toBe(0);
    } finally { h.close(); }
  });

  it.each(['b', 'c'])('respects explicit cancellation of %s during the replacement lifecycle', cancelled => {
    const h = replay();
    try {
      h.setup();
      h.queue.mark('c', 'Third report', 390);
      h.line('event_msg', { type: 'task_started', turn_id: 'Y' }, 400);
      expect(h.queue.dropPendingTurn(cancelled, undefined, true)?.turnId).toBe(cancelled);
      h.restore();
      h.line('event_msg', { type: 'task_complete', turn_id: 'Y', last_agent_message: 'Y answer' }, 900);
      const ready = h.queue.drainEmittable();
      expect(ready.map(turn => turn.turnId)).toEqual(cancelled === 'c' ? ['b'] : []);
      expect(h.queue.peek().map(turn => turn.turnId)).toEqual(cancelled === 'b' ? ['c'] : []);
      if (cancelled === 'b') {
        h.line('response_item', user('Third report'), 950);
        h.line('event_msg', { type: 'task_complete', turn_id: 'Z', last_agent_message: 'C answer' }, 980);
        expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.finalText])).toEqual([['c', 'C answer']]);
      }
      expect(h.queue.size()).toBe(0);
    } finally { h.close(); }
  });
});
