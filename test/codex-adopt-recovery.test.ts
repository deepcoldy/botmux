import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { splitCodexEventsByCutoff, type CodexBridgeEvent } from '../src/services/codex-transcript.js';
import { checkpointCodexAdoptTurns, restoreCodexAdoptTurns } from '../src/services/codex-adopt-recovery.js';
import { readBridgeTurnJournal } from '../src/services/bridge-turn-journal.js';

let dir: string;
let path: string;
const rollout = '/project/rollout.jsonl';
const event = (kind: CodexBridgeEvent['kind'], timestampMs: number, text = ''): CodexBridgeEvent =>
  ({ kind, timestampMs, text, uuid: `${kind}-${timestampMs}` });
const start = event('user', 10_000, 'Continue the task');
const final = event('assistant_final', 30_000, 'Finished');
const events = [start, event('cot', 11_000), event('cot', 21_000), final];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-adopt-recovery-')); path = join(dir, 'journal.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function checkpoint(dispatchAttempt?: number) {
  const queue = new CodexBridgeQueue(() => 10_000);
  queue.setLocalTurns(true, 10_000);
  queue.mark('om_original', start.text, 10_000, dispatchAttempt);
  queue.ingest([start]);
  checkpointCodexAdoptTurns(path, rollout, queue);
  return queue;
}

function restore(input: readonly CodexBridgeEvent[], now = 20_000, file = rollout) {
  const queue = new CodexBridgeQueue(() => now);
  queue.setLocalTurns(true, now);
  const result = restoreCodexAdoptTurns(path, file, queue, input, now - 5_000, now);
  queue.absorb(result.history);
  queue.ingest(result.live);
  return { queue, ...result };
}

describe('adopted Codex turn recovery', () => {
  it('keeps progress and the eventual final attached to the original message across restart', () => {
    checkpoint();
    const { queue, live, restored } = restore(events.slice(0, 3));
    expect(restored).toBe(1);
    expect(live.filter(e => e.kind === 'cot').map(e => e.timestampMs)).toEqual([21_000]);
    expect(queue.hasBlockingTurn()).toBe(true);
    expect(queue.drainEmittable()).toEqual([]);
    queue.ingest([final]);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_original', finalText: 'Finished' }]);
    checkpointCodexAdoptTurns(path, rollout, queue);
    expect(readBridgeTurnJournal(path)).toEqual([]);
    expect(restore(events, 40_000).queue.drainEmittable()).toEqual([]);
  });

  it('recovers a final produced while the daemon was offline', () => {
    checkpoint();
    expect(restore(events, 40_000).queue.drainEmittable())
      .toMatchObject([{ turnId: 'om_original', finalText: 'Finished' }]);
  });

  it('does not replay earlier completed turns', () => {
    checkpoint();
    const old = [event('user', 1_000, 'Old task'), event('assistant_final', 2_000, 'Old answer')];
    expect(restore([...old, ...events]).queue.drainEmittable())
      .toMatchObject([{ turnId: 'om_original', finalText: 'Finished' }]);
  });

  it('restores an older turn before a new input marked ahead of the first attach', () => {
    checkpoint();
    const queue = new CodexBridgeQueue(() => 20_000);
    queue.mark('om_new', 'New input', 20_000);
    const current = queue.peek()[0];
    const result = restoreCodexAdoptTurns(path, rollout, queue, events, 20_000, 20_000);
    expect(result.restored).toBe(1);
    expect(queue.peek().map(t => t.turnId)).toEqual(['om_original', 'om_new']);
    expect(queue.peek()[1]).toBe(current);
    queue.absorb(result.history);
    queue.ingest(result.live);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_original', finalText: 'Finished' }]);
    queue.ingest([event('user', 31_000, 'New input'), event('assistant_final', 32_000, 'New answer')]);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_new', finalText: 'New answer' }]);
  });

  it('lets genuine steering retire the restored turn without losing the new attribution', () => {
    checkpoint();
    const queue = new CodexBridgeQueue(() => 20_000);
    queue.mark('om_new', 'New input', 20_000);
    const result = restoreCodexAdoptTurns(path, rollout, queue,
      [start, event('user', 21_000, 'New input'), final], 20_000, 20_000);
    queue.absorb(result.history);
    queue.ingest(result.live);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_new', finalText: 'Finished' }]);
  });

  it('keeps this generation as the owner of an already marked message', () => {
    checkpoint();
    const queue = new CodexBridgeQueue(() => 20_000);
    queue.mark('om_original', start.text, 20_000, 2);
    const current = queue.peek()[0];
    expect(restoreCodexAdoptTurns(path, rollout, queue, events, 20_000, 20_000).restored).toBe(0);
    expect(queue.peek()).toEqual([current]);
    expect(queue.peek()[0]).toBe(current);
  });

  it('does not steal durable deliveries from their recovery owner', () => {
    checkpoint(1);
    expect(readBridgeTurnJournal(path)).toEqual([]);
  });

  it.each(['other rollout', 'expired', 'future'])('rejects a %s checkpoint', reason => {
    checkpoint();
    const now = reason === 'expired' ? 100_000_000 : reason === 'future' ? 1_000 : 20_000;
    const { restored } = restore([], now, reason === 'other rollout' ? '/other/rollout.jsonl' : rollout);
    expect(restored).toBe(0);
  });

  it('clears a retired turn when a real terminal input supersedes it', () => {
    const queue = checkpoint();
    queue.ingest([event('user', 12_000, 'Typed in terminal')]);
    checkpointCodexAdoptTurns(path, rollout, queue);
    expect(readBridgeTurnJournal(path)).toEqual([]);
  });

  it('keeps cancellation terminal and releases the restored turn', () => {
    checkpoint();
    const { queue } = restore([start, event('turn_aborted', 21_000)]);
    expect(queue.hasBlockingTurn()).toBe(false);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_original', finalText: '', terminalStatus: 'ambiguous' }]);
  });

  it('recovers managed non-adopt turn across daemon restart when model finishes later', () => {
    const q1 = new CodexBridgeQueue(() => 10_000);
    q1.mark('om_pi_task', start.text, 10_000);
    q1.ingest([start]);
    checkpointCodexAdoptTurns(path, rollout, q1);
    expect(readBridgeTurnJournal(path)).toHaveLength(1);

    // Daemon restarts: new worker attaches with clean queue and non-adopt mode
    const q2 = new CodexBridgeQueue(() => 20_000);
    const result = restoreCodexAdoptTurns(path, rollout, q2, [start], 20_000 - 5_000, 20_000);
    expect(result.restored).toBe(1);
    q2.absorb(result.history);
    q2.ingest(result.live);
    expect(q2.hasBlockingTurn()).toBe(true);
    expect(q2.drainEmittable()).toEqual([]);

    // Pi CLI finishes later (e.g. 60 minutes later) and emits assistant_final
    const laterFinal = event('assistant_final', 60_000, 'Pi output result');
    q2.ingest([laterFinal]);
    expect(q2.drainEmittable()).toMatchObject([{ turnId: 'om_pi_task', finalText: 'Pi output result' }]);
    checkpointCodexAdoptTurns(path, rollout, q2);
    expect(readBridgeTurnJournal(path)).toEqual([]);
  });

  it('recovers managed non-adopt turn across daemon restart when model finished while offline', () => {
    const q1 = new CodexBridgeQueue(() => 10_000);
    q1.mark('om_pi_task', start.text, 10_000);
    q1.ingest([start]);
    checkpointCodexAdoptTurns(path, rollout, q1);

    // Daemon restarts: model already finished while daemon was offline
    const q2 = new CodexBridgeQueue(() => 40_000);
    const offlineFinal = event('assistant_final', 35_000, 'Pi offline output');
    const result = restoreCodexAdoptTurns(path, rollout, q2, [start, offlineFinal], 40_000 - 5_000, 40_000);
    expect(result.restored).toBe(1);
    q2.absorb(result.history);
    q2.ingest(result.live);
    expect(q2.drainEmittable()).toMatchObject([{ turnId: 'om_pi_task', finalText: 'Pi offline output' }]);
    checkpointCodexAdoptTurns(path, rollout, q2);
    expect(readBridgeTurnJournal(path)).toEqual([]);
  });

  it('documents why wall-clock Date.now() drainers (like Cursor) cannot use timestamp cutoff replay', () => {
    // When a drainer lacks real event timestamps and stamps Date.now(),
    // all replayed events exceed minMarkTime - 5s, putting everything into live.
    // This verifies why worker explicitly guards cutoff recovery with !codexBridgeIsCursor().
    const now = 50_000;
    const wallClockEvents = [
      event('user', now, 'historical prompt'),
      event('assistant_final', now, 'historical answer'),
    ];
    const cutoff = 20_000 - 5_000;
    const { history, live } = splitCodexEventsByCutoff(wallClockEvents, cutoff);
    expect(history).toHaveLength(0);
    expect(live).toHaveLength(2);
  });
});
