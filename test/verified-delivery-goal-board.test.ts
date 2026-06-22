import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLedger } from '../src/verified-delivery/ledger.js';
import { buildGoalBoard } from '../src/verified-delivery/goal-board.js';
import type { LedgerEventDraft } from '../src/verified-delivery/types.js';

const TS = 1_700_000_000_000;
function draft(p: Partial<LedgerEventDraft> & Pick<LedgerEventDraft, 'type' | 'taskId' | 'idempotencyKey' | 'payload'>): LedgerEventDraft {
  return { actor: 'orchestrator', ts: TS, ...p } as LedgerEventDraft;
}

describe('buildGoalBoard — ledger projection', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'vd-board-')); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  it('groups tasks by goal chatId with status counts', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 't-a', chatId: 'oc_g1', idempotencyKey: 'd:t-a', payload: { taskId: 't-a', title: 'A' } }));
    led.append(draft({ type: 'TaskDispatched', taskId: 't-b', chatId: 'oc_g1', idempotencyKey: 'd:t-b', payload: { taskId: 't-b', title: 'B' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-b', chatId: 'oc_g1', idempotencyKey: 'r:t-b', payload: { taskId: 't-b', reportId: 'rb1', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/b' }] } }));
    led.append(draft({ type: 'TaskAccepted', taskId: 't-b', chatId: 'oc_g1', idempotencyKey: 'a:t-b', payload: { taskId: 't-b', reportId: 'rb1', checkedBy: 'ou_x' } }));
    led.append(draft({ type: 'TaskDispatched', taskId: 't-c', chatId: 'oc_g2', idempotencyKey: 'd:t-c', payload: { taskId: 't-c', title: 'C' } }));

    const board = buildGoalBoard({ baseDir });
    expect(board.goals.map((g) => g.goalChatId).sort()).toEqual(['oc_g1', 'oc_g2']);
    const g1 = board.goals.find((g) => g.goalChatId === 'oc_g1')!;
    expect(g1.counts).toEqual({ dispatched: 1, reported: 0, accepted: 1, rejected: 0, total: 2 });
    expect(g1.hasCharter).toBe(false); // no whiteboard created in this test
    // active task (dispatched) sorts before terminal (accepted)
    expect(g1.tasks.map((t) => t.taskId)).toEqual(['t-a', 't-b']);
  });

  it('prefers structured acceptanceCriteria, falls back to legacy hint', () => {
    const led = openLedger({ baseDir });
    led.append(draft({
      type: 'TaskDispatched', taskId: 't-struct', chatId: 'oc_g', idempotencyKey: 'd:struct',
      payload: { taskId: 't-struct', acceptanceHint: 'legacy text', acceptanceCriteria: { version: 1, artifacts: [{ path: '/x', checks: [{ type: 'exists' }] }] } },
    }));
    led.append(draft({
      type: 'TaskDispatched', taskId: 't-legacy', chatId: 'oc_g', idempotencyKey: 'd:legacy',
      payload: { taskId: 't-legacy', acceptanceHint: 'just text' },
    }));

    const board = buildGoalBoard({ baseDir, chatId: 'oc_g' });
    const tasks = Object.fromEntries(board.goals[0].tasks.map((t) => [t.taskId, t]));
    expect(tasks['t-struct'].acceptanceCriteria).toEqual({ version: 1, artifacts: [{ path: '/x', checks: [{ type: 'exists' }] }] });
    expect(tasks['t-struct'].acceptanceHint).toBeUndefined(); // structured wins, hint dropped
    expect(tasks['t-legacy'].acceptanceCriteria).toBeUndefined();
    expect(tasks['t-legacy'].acceptanceHint).toBe('just text');
  });

  it('surfaces lifecycle timestamps, attempts, evidence and verification trail', () => {
    const led = openLedger({ baseDir });
    const T1 = 1_700_000_000_000, T2 = 1_700_000_030_000, T3 = 1_700_000_090_000;
    led.append(draft({ type: 'TaskDispatched', taskId: 't-full', chatId: 'oc_g', idempotencyKey: 'd', ts: T1, payload: { taskId: 't-full', title: 'full' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-full', chatId: 'oc_g', idempotencyKey: 'r1', ts: T2, payload: { taskId: 't-full', reportId: 'rep1', workerOpenId: 'ou_w', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/out.txt' }, { kind: 'inline', ref: 'abc', name: 'log', bytes: 12, preview: 'PASS' }] } }));
    led.append(draft({ type: 'TaskAccepted', taskId: 't-full', chatId: 'oc_g', idempotencyKey: 'a1', ts: T3, payload: { taskId: 't-full', reportId: 'rep1', checkedBy: 'ou_orch', evidenceChecked: ['/tmp/out.txt exists'], ranCommands: ['test -f /tmp/out.txt'] } }));

    const t = buildGoalBoard({ baseDir, chatId: 'oc_g' }).goals[0].tasks[0];
    expect(t.dispatchedAt).toBe(T1);
    expect(t.latestReportedAt).toBe(T2);
    expect(t.latestVerdictAt).toBe(T3);
    expect(t.acceptedAt).toBe(T3);
    expect(t.rejectedAt).toBeUndefined();
    expect(t.checkedBy).toBe('ou_orch');
    expect(t.evidenceChecked).toEqual(['/tmp/out.txt exists']);
    expect(t.ranCommands).toEqual(['test -f /tmp/out.txt']);
    expect(t.evidence).toEqual([
      { kind: 'path', label: '/tmp/out.txt' },
      { kind: 'inline', label: 'log', preview: 'PASS', bytes: 12 },
    ]);
    expect(t.attempts).toHaveLength(1);
    expect(t.attempts[0]).toMatchObject({ reportId: 'rep1', ts: T2, verdict: 'accepted', workerOpenId: 'ou_w' });
  });

  it('records every attempt with its reject reason in the timeline', () => {
    const led = openLedger({ baseDir });
    const T = (n: number) => 1_700_000_000_000 + n * 1000;
    led.append(draft({ type: 'TaskDispatched', taskId: 't-multi', chatId: 'oc_g', idempotencyKey: 'd', ts: T(0), payload: { taskId: 't-multi' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-multi', chatId: 'oc_g', idempotencyKey: 'r1', ts: T(1), payload: { taskId: 't-multi', reportId: 'a1', summary: 'try1', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskRejected', taskId: 't-multi', chatId: 'oc_g', idempotencyKey: 'x1', ts: T(2), payload: { taskId: 't-multi', reportId: 'a1', reason: 'check_failed' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-multi', chatId: 'oc_g', idempotencyKey: 'r2', ts: T(3), payload: { taskId: 't-multi', reportId: 'a2', summary: 'try2', evidence: [{ kind: 'path', path: '/tmp/b' }] } }));

    const t = buildGoalBoard({ baseDir, chatId: 'oc_g' }).goals[0].tasks[0];
    expect(t.status).toBe('reported');
    expect(t.attempts).toHaveLength(2);
    expect(t.attempts[0]).toMatchObject({ reportId: 'a1', ts: T(1), verdict: 'rejected', reason: 'check_failed' });
    expect(t.attempts[1]).toMatchObject({ reportId: 'a2', ts: T(3) });
    expect(t.attempts[1].verdict).toBeUndefined();
  });

  it('carries reject reason onto the latest attempt', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 't-r', chatId: 'oc_g', idempotencyKey: 'd:r', payload: { taskId: 't-r' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-r', chatId: 'oc_g', idempotencyKey: 'rep:r', payload: { taskId: 't-r', reportId: 'r1', summary: 's', evidence: [{ kind: 'path', path: '/tmp/x' }] } }));
    led.append(draft({ type: 'TaskRejected', taskId: 't-r', chatId: 'oc_g', idempotencyKey: 'rej:r', payload: { taskId: 't-r', reportId: 'r1', reason: 'check_failed' } }));

    const board = buildGoalBoard({ baseDir, chatId: 'oc_g' });
    const t = board.goals[0].tasks[0];
    expect(t.status).toBe('rejected');
    expect(t.latestVerdict).toBe('rejected');
    expect(t.rejectReason).toBe('check_failed');
  });
});
