import type { LedgerEvent } from '../verified-delivery/types.js';

export const DEFAULT_GOAL_WORKER_REASSIGN_MAX_ATTEMPTS = 3;
export const DEFAULT_GOAL_WORKER_REASSIGN_BUDGET_WINDOW_MS = 60 * 60_000;

export function isGoalWorkerReassignEvent(event: LedgerEvent, taskId: string): boolean {
  return event.type === 'TaskDispatched'
    && event.taskId === taskId
    && event.idempotencyKey.startsWith(`reassign:${taskId}:`);
}

export function countGoalWorkerReassignAttempts(
  events: LedgerEvent[],
  taskId: string,
  now: number,
  windowMs = DEFAULT_GOAL_WORKER_REASSIGN_BUDGET_WINDOW_MS,
): number {
  const floor = now - windowMs;
  return events.filter((event) => isGoalWorkerReassignEvent(event, taskId) && event.ts >= floor && event.ts <= now).length;
}

export function latestTaskDispatchEvent(events: LedgerEvent[], taskId: string): LedgerEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'TaskDispatched' && event.taskId === taskId) return event;
  }
  return undefined;
}
