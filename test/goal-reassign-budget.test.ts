import { describe, expect, it } from 'vitest';
import { countGoalWorkerReassignAttempts, latestTaskDispatchEvent } from '../src/core/goal-reassign-budget.js';
import type { LedgerEvent } from '../src/verified-delivery/types.js';

function event(input: Partial<LedgerEvent> & { idempotencyKey: string; ts: number; taskId?: string; type?: LedgerEvent['type'] }): LedgerEvent {
  return {
    eventId: input.eventId ?? String(input.seq ?? 1),
    seq: input.seq ?? 1,
    type: input.type ?? 'TaskDispatched',
    actor: input.actor ?? 'orchestrator',
    taskId: input.taskId ?? 'task-a',
    chatId: input.chatId ?? 'oc_goal',
    ts: input.ts,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload ?? { taskId: input.taskId ?? 'task-a' },
  } as LedgerEvent;
}

describe('goal reassign budget', () => {
  it('counts only reassign dispatch events for the task within the window', () => {
    const events = [
      event({ seq: 1, ts: 1_000, idempotencyKey: 'dispatched:task-a' }),
      event({ seq: 2, ts: 10_000, idempotencyKey: 'reassign:task-a:cli_a:1' }),
      event({ seq: 3, ts: 20_000, idempotencyKey: 'reassign:task-b:cli_a:1', taskId: 'task-b' }),
      event({ seq: 4, ts: 30_000, idempotencyKey: 'reassign:task-a:cli_a:2' }),
      event({ seq: 5, ts: 40_000, idempotencyKey: 'manual:task-a' }),
      event({ seq: 6, ts: 50_000, idempotencyKey: 'reassign:task-a:cli_a:3' }),
    ];

    expect(countGoalWorkerReassignAttempts(events, 'task-a', 60_000, 45_000)).toBe(2);
  });

  it('finds the latest dispatch event for escalation idempotency', () => {
    const events = [
      event({ seq: 1, eventId: '1', ts: 1_000, idempotencyKey: 'dispatched:task-a' }),
      event({ seq: 2, eventId: '2', ts: 2_000, idempotencyKey: 'reported:r1', type: 'TaskReported', payload: { taskId: 'task-a', reportId: 'r1', evidence: [{ kind: 'path', path: '/tmp/a' }], summary: 's' } }),
      event({ seq: 3, eventId: '3', ts: 3_000, idempotencyKey: 'reassign:task-a:cli_a:1' }),
    ];

    expect(latestTaskDispatchEvent(events, 'task-a')?.eventId).toBe('3');
  });
});
