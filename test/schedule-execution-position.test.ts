/**
 * Regression coverage for scheduled-task execution position semantics.
 *
 * Background: a schedule created inside an adopted topic persisted
 * executionPosition='topic' + the adopt topic root, and the delivery toggle
 * cycle (topic → top-level → new-topic) reused that retained root to silently
 * re-enter the adopt topic. These tests pin the corrected invariants:
 *
 *  - explicit topic execution (non-adopt, user opted in) still resolves to the
 *    retained thread root — normal topic delivery is unaffected;
 *  - the toggle/card cycle never reuses a retained root to cycle back into a
 *    topic; leaving a fresh topic parks at top-level.
 */
import { describe, it, expect } from 'bun:test';
import {
  resolveScheduledTaskScope,
  resolveScheduledTaskExecutionPosition,
} from '../src/core/session-manager.js';
import {
  nextScheduleExecutionPosition,
  resolveScheduleExecutionPlacement,
  type ScheduleCardTaskInput,
} from '../src/dashboard/schedule-card-model.js';
import type { ScheduledTask } from '../src/types.js';

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 't1',
    name: 'demo',
    schedule: '0 9 * * *',
    parsed: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
    prompt: 'do it',
    workingDir: '/tmp',
    chatId: 'oc_x',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    deliver: 'origin',
    ...overrides,
  } as ScheduledTask;
}

function cardTask(overrides: Partial<ScheduleCardTaskInput> = {}): ScheduleCardTaskInput {
  return {
    id: 't1',
    name: 'demo',
    parsed: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
    enabled: true,
    ...overrides,
  };
}

describe('resolveScheduledTaskScope / resolveScheduledTaskExecutionPosition (fire path)', () => {
  it('keeps explicit topic execution on its retained thread root (non-adopt regression)', () => {
    const t = task({ executionPosition: 'topic', scope: 'thread', rootMessageId: 'om_user_topic' });
    expect(resolveScheduledTaskExecutionPosition(t)).toBe('topic');
    expect(resolveScheduledTaskScope(t)).toBe('thread');
  });

  it('resolves explicit top-level and fresh-topic positions to chat scope', () => {
    expect(resolveScheduledTaskExecutionPosition(task({ executionPosition: 'top-level', rootMessageId: 'om_bookmark' }))).toBe('top-level');
    expect(resolveScheduledTaskScope(task({ executionPosition: 'top-level', rootMessageId: 'om_bookmark' }))).toBe('chat');
    expect(resolveScheduledTaskExecutionPosition(task({ executionPosition: 'new-topic', rootMessageId: 'om_bookmark' }))).toBe('new-topic');
    expect(resolveScheduledTaskScope(task({ executionPosition: 'new-topic', rootMessageId: 'om_bookmark' }))).toBe('chat');
  });

  it('degrades a rootless topic position to top-level instead of crashing', () => {
    const t = task({ executionPosition: 'topic', scope: 'thread' });
    expect(resolveScheduledTaskExecutionPosition(t)).toBe('top-level');
    expect(resolveScheduledTaskScope(t)).toBe('chat');
  });

  it('still honours legacy thread-scope rows with a retained root', () => {
    const t = task({ scope: 'thread', rootMessageId: 'om_legacy' });
    expect(resolveScheduledTaskExecutionPosition(t)).toBe('topic');
    expect(resolveScheduledTaskScope(t)).toBe('thread');
  });
});

describe('nextScheduleExecutionPosition (delivery toggle cycle)', () => {
  it('cycles topic → top-level → new-topic → top-level, never back to a retained topic', () => {
    // A task born in an adopt topic, then toggled away: the root must have been
    // cleared by the toggle. Even if a stale root lingers, the cycle must not
    // offer re-entering it.
    let t = cardTask({ executionPosition: 'topic', scope: 'thread', rootMessageId: 'om_adopt_root' });
    expect(resolveScheduleExecutionPlacement(t)).toBe('thread');
    expect(nextScheduleExecutionPosition(t)).toBe('top-level');

    t = cardTask({ executionPosition: 'top-level', scope: 'chat', rootMessageId: 'om_adopt_root' });
    expect(nextScheduleExecutionPosition(t)).toBe('new-topic');

    // The stale retained root must NOT pull the next toggle back to 'topic'.
    t = cardTask({ executionPosition: 'new-topic', scope: 'chat', rootMessageId: 'om_adopt_root' });
    expect(nextScheduleExecutionPosition(t)).toBe('top-level');
  });

  it('parks a rootless fresh-topic task at top-level', () => {
    const t = cardTask({ executionPosition: 'new-topic', scope: 'chat' });
    expect(nextScheduleExecutionPosition(t)).toBe('top-level');
  });
});
