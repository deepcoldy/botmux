import { TASK_RELEASE_AUTO_RETRY_WINDOW_MS } from './ledger.js';
import type { LedgerEvent, TaskView } from './types.js';

export const DEFAULT_REJECTED_DEPENDENCY_STALL_MS = 30 * 60_000;

export function resolveRejectedDependencyStallMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_REJECTED_DEPENDENCY_STALL_MS;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_REJECTED_DEPENDENCY_STALL_MS;
}

export type TaskReleaseRiskKind =
  | 'release_definite'
  | 'release_ambiguous_expired'
  | 'dependency_cancelled'
  | 'dependency_rejected_stalled';

export interface TaskReleaseRisk {
  taskId: string;
  goalChatId?: string;
  kind: TaskReleaseRiskKind;
  reason: string;
  next: string;
  /** Stable ledger-derived notification identity; survives daemon restarts. */
  stableKey: string;
  /** When this fact first became actionable (not merely when the plan was created). */
  occurredAt: number;
  releaseId?: string;
  upstreamTaskId?: string;
  detail?: string;
}

export function taskReleaseRiskNotificationId(risk: TaskReleaseRisk): string | undefined {
  return risk.goalChatId
    ? `release-risk:${risk.goalChatId}:${risk.taskId}:${risk.stableKey}`
    : undefined;
}

export function deriveTaskReleaseRisks(input: {
  tasks: TaskView[];
  events: LedgerEvent[];
  now: number;
  rejectedStallMs?: number;
}): TaskReleaseRisk[] {
  const risks: TaskReleaseRisk[] = [];
  const byTask = new Map(input.tasks.map((task) => [task.taskId, task]));
  const byEventId = new Map(input.events.map((event) => [event.eventId, event]));
  const latestRejected = new Map<string, LedgerEvent>();
  for (const event of input.events) {
    if (event.type === 'TaskRejected') latestRejected.set(event.taskId, event);
  }
  const rejectedStallMs = input.rejectedStallMs ?? DEFAULT_REJECTED_DEPENDENCY_STALL_MS;

  for (const task of input.tasks) {
    if (task.status !== 'planned' || !task.plan) continue;
    const pending = task.pendingRelease;
    if (pending?.failure?.failureClass === 'definite') {
      risks.push({
        taskId: task.taskId,
        goalChatId: task.chatId,
        kind: 'release_definite',
        reason: 'release:definite',
        next: `自动派发失败（${pending.failure.code}），修复后重试`,
        stableKey: `release:${pending.releaseId}:${pending.failure.eventId}`,
        occurredAt: pending.failure.ts,
        releaseId: pending.releaseId,
        detail: pending.failure.detail,
      });
      continue;
    }
    if (pending && input.now - pending.intentAt >= TASK_RELEASE_AUTO_RETRY_WINDOW_MS) {
      risks.push({
        taskId: task.taskId,
        goalChatId: task.chatId,
        kind: 'release_ambiguous_expired',
        reason: 'release:ambiguous_expired',
        next: '自动派发结果不确定，需确认已派或重试',
        stableKey: `release:${pending.releaseId}:${pending.failure?.eventId ?? pending.intentEventId}`,
        occurredAt: pending.intentAt + TASK_RELEASE_AUTO_RETRY_WINDOW_MS,
        releaseId: pending.releaseId,
        detail: pending.failure?.detail,
      });
      continue;
    }
    for (const dependencyId of task.plan.dependsOnTaskIds) {
      const dependency = byTask.get(dependencyId);
      if (dependency?.status === 'cancelled') {
        const cancelled = dependency.cancellationEventId
          ? byEventId.get(dependency.cancellationEventId)
          : undefined;
        risks.push({
          taskId: task.taskId,
          goalChatId: task.chatId,
          kind: 'dependency_cancelled',
          reason: 'dependency:cancelled',
          next: `上游任务 ${dependencyId} 已取消，需调整后续安排`,
          stableKey: `dependency:${dependencyId}:cancelled:${dependency.cancellationEventId ?? 'unknown'}`,
          occurredAt: cancelled?.ts ?? input.now,
          upstreamTaskId: dependencyId,
          detail: dependency.cancellation?.reason,
        });
        break;
      }
      const rejected = latestRejected.get(dependencyId);
      if (dependency?.status === 'rejected' && rejected && input.now - rejected.ts >= rejectedStallMs) {
        risks.push({
          taskId: task.taskId,
          goalChatId: task.chatId,
          kind: 'dependency_rejected_stalled',
          reason: 'dependency:rejected_stalled',
          next: `上游任务 ${dependencyId} 驳回后长期未补交`,
          stableKey: `dependency:${dependencyId}:rejected:${rejected.eventId}`,
          occurredAt: rejected.ts + rejectedStallMs,
          upstreamTaskId: dependencyId,
        });
        break;
      }
    }
  }
  return risks;
}
