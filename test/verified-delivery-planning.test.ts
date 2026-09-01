import { describe, expect, it } from 'vitest';
import { normalizeTaskDependencies, resolveTaskPlanTransition } from '../src/verified-delivery/planning.js';
import type { TaskView } from '../src/verified-delivery/types.js';

describe('dependency task planning', () => {
  it('preserves dependency order and creates generation one', () => {
    expect(resolveTaskPlanTransition({
      taskId: 'downstream',
      dependsOnTaskIds: [' upstream-a ', 'upstream-b'],
    })).toEqual({
      dependsOnTaskIds: ['upstream-a', 'upstream-b'],
      planGeneration: 1,
      idempotencyKey: 'planned:downstream',
    });
  });

  it('rejects empty, duplicate, and self dependencies', () => {
    expect(() => normalizeTaskDependencies([], 'downstream')).toThrow(/至少一个/);
    expect(() => normalizeTaskDependencies(['up', 'up'], 'downstream')).toThrow(/重复/);
    expect(() => normalizeTaskDependencies(['downstream'], 'downstream')).toThrow(/依赖自己/);
  });

  it('reopens a cancelled planned task without changing its dependency edges', () => {
    const current = {
      taskId: 'downstream',
      status: 'cancelled',
      reports: [],
      cancellationEventId: 'cancel-7',
      plan: {
        planEventId: 'plan-1',
        planGeneration: 1,
        dependsOnTaskIds: ['upstream'],
        plannedBy: 'supervisor',
        dispatchSpec: {
          title: 'Downstream', briefBase: 'Do it', senderLarkAppId: 'cli_sup',
          workers: [{ openId: 'ou_worker' }],
        },
      },
    } satisfies TaskView;
    expect(resolveTaskPlanTransition({
      taskId: 'downstream', dependsOnTaskIds: ['upstream'], current,
    })).toEqual({
      dependsOnTaskIds: ['upstream'],
      planGeneration: 2,
      reopenOfCancelEventId: 'cancel-7',
      idempotencyKey: 'planned:downstream:cancel-7',
    });
    expect(() => resolveTaskPlanTransition({
      taskId: 'downstream', dependsOnTaskIds: ['different'], current,
    })).toThrow(/不可修改/);
  });

  it('does not plan over an active or ordinary existing task', () => {
    const current = { taskId: 'downstream', status: 'dispatched', reports: [] } satisfies TaskView;
    expect(() => resolveTaskPlanTransition({
      taskId: 'downstream', dependsOnTaskIds: ['upstream'], current,
    })).toThrow(/已存在/);
  });
});
