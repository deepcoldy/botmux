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
