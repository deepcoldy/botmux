import type { TaskView } from './types.js';

export interface TaskPlanTransition {
  dependsOnTaskIds: string[];
  planGeneration: number;
  reopenOfCancelEventId?: string;
  idempotencyKey: string;
}

/** Normalize the dependency declaration while preserving its canonical order. */
export function normalizeTaskDependencies(raw: readonly string[], taskId: string): string[] {
  const dependencies = raw.map((value) => value.trim());
  if (dependencies.length === 0 || dependencies.some((value) => !value)) {
    throw new Error('--after 需要至少一个非空任务号');
  }
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error('--after 不能重复声明同一个依赖任务');
  }
  if (dependencies.includes(taskId)) {
    throw new Error(`任务 ${taskId} 不能依赖自己`);
  }
  return dependencies;
}

/** Decide whether this is the first plan generation or an explicit reopen. */
export function resolveTaskPlanTransition(input: {
  taskId: string;
  dependsOnTaskIds: readonly string[];
  current?: TaskView;
}): TaskPlanTransition {
  const dependsOnTaskIds = normalizeTaskDependencies(input.dependsOnTaskIds, input.taskId);
  const current = input.current;
  if (!current) {
    return {
      dependsOnTaskIds,
      planGeneration: 1,
      idempotencyKey: `planned:${input.taskId}`,
    };
  }
  if (!current.plan || current.status !== 'cancelled' || !current.cancellationEventId) {
    throw new Error(`任务 ${input.taskId} 已存在；只有已取消的依赖任务才能用原任务号重新规划`);
  }
  if (
    current.plan.dependsOnTaskIds.length !== dependsOnTaskIds.length ||
    current.plan.dependsOnTaskIds.some((value, index) => value !== dependsOnTaskIds[index])
  ) {
    throw new Error(
      `任务 ${input.taskId} 的依赖边不可修改；请继续使用：${current.plan.dependsOnTaskIds.join(', ')}`,
    );
  }
  return {
    dependsOnTaskIds,
    planGeneration: current.plan.planGeneration + 1,
    reopenOfCancelEventId: current.cancellationEventId,
    idempotencyKey: `planned:${input.taskId}:${current.cancellationEventId}`,
  };
}
