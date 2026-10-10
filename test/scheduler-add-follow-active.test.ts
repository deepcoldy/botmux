/**
 * scheduler-add-follow-active.test.ts
 *
 * The add→store seam for `--follow-active`: scheduler.addTask must forward
 * followActive into schedule-store.createTask so the flag is on the task the
 * next fire reads back. (The CLI-side and store-side tests each passed while
 * this seam dropped the flag.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() {
        return join(tempDir, 'data');
      },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: vi.fn() }));
vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: vi.fn() } }));

const TEST_APP = 'cli_testapp0000000001';

const PARAMS = {
  name: 'sentinel',
  schedule: '*/30 * * * *',
  parsed: { kind: 'cron' as const, expr: '*/30 * * * *', display: '*/30 * * * *' },
  prompt: 'check',
  workingDir: '/workspace/project',
  chatId: 'oc_test_chat',
  rootMessageId: 'om_origin',
  executionPosition: 'topic' as const,
  larkAppId: TEST_APP,
};

async function freshImport() {
  vi.resetModules();
  const store = await import('../src/services/schedule-store.js');
  store.setScheduleScope(TEST_APP);
  const scheduler = await import('../src/core/scheduler.js');
  return { store, scheduler };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'scheduler-add-follow-active-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('scheduler.addTask → schedule-store', () => {
  it('persists followActive: true so the stored task carries it', async () => {
    const { store, scheduler } = await freshImport();
    const task = scheduler.addTask({ ...PARAMS, followActive: true });
    expect(task.followActive).toBe(true);
    expect(store.getTask(task.id, TEST_APP)?.followActive).toBe(true);
  });

  it('control: without the flag the stored task has no followActive', async () => {
    const { store, scheduler } = await freshImport();
    const task = scheduler.addTask({ ...PARAMS });
    expect(task.followActive).toBeUndefined();
    expect(store.getTask(task.id, TEST_APP)?.followActive).toBeUndefined();
  });

  it('a non-true value is not persisted as true', async () => {
    const { store, scheduler } = await freshImport();
    const task = scheduler.addTask({ ...PARAMS, followActive: false });
    expect(store.getTask(task.id, TEST_APP)?.followActive).toBeUndefined();
  });

  it('still refuses followActive off a topic', async () => {
    const { scheduler } = await freshImport();
    expect(() => scheduler.addTask({ ...PARAMS, rootMessageId: undefined, executionPosition: 'top-level', followActive: true }))
      .toThrow('follow_active_requires_topic');
  });
});

describe('scheduler.addTask — task position (dedicated per-task topic)', () => {
  const TASK_PARAMS = {
    name: 'sentinel',
    schedule: '*/30 * * * *',
    parsed: { kind: 'cron' as const, expr: '*/30 * * * *', display: '*/30 * * * *' },
    prompt: 'check',
    workingDir: '/workspace/project',
    chatId: 'oc_test_chat',
    executionPosition: 'task' as const,
    larkAppId: TEST_APP,
  };

  it('creates a rootless task-position task bound to thread scope without requiring a root', async () => {
    const { store, scheduler } = await freshImport();
    const task = scheduler.addTask({ ...TASK_PARAMS });
    expect(task.executionPosition).toBe('task');
    expect(task.scope).toBe('thread');
    expect(task.rootMessageId).toBeUndefined();
    expect(store.getTask(task.id, TEST_APP)).toMatchObject({
      executionPosition: 'task',
      scope: 'thread',
      rootMessageId: undefined,
    });
  });

  it('refuses a task-position task spanning multiple chats', async () => {
    const { scheduler } = await freshImport();
    expect(() => scheduler.addTask({ ...TASK_PARAMS, chatIds: ['oc_a', 'oc_b'] }))
      .toThrow('multiple_chats_task_unsupported');
  });

  it('control: multiple chats remain rejected for ordinary topic execution too', async () => {
    const { scheduler } = await freshImport();
    expect(() => scheduler.addTask({ ...PARAMS, chatIds: ['oc_a', 'oc_b'] }))
      .toThrow('multiple_chats_topic_unsupported');
  });

  it('never persists a caller-supplied root for a task-position task (the root is first-fire managed)', async () => {
    const { store, scheduler } = await freshImport();
    const task = scheduler.addTask({ ...TASK_PARAMS, rootMessageId: 'om_foreign' });
    expect(task.rootMessageId).toBeUndefined();
    expect(store.getTask(task.id, TEST_APP)?.rootMessageId).toBeUndefined();
  });

  it('refuses followActive for a task-position task exactly like other non-topic positions', async () => {
    const { scheduler } = await freshImport();
    expect(() => scheduler.addTask({ ...TASK_PARAMS, followActive: true }))
      .toThrow('follow_active_requires_topic');
  });
});

describe('scheduler.resolveTaskExecutionPosition — task position', () => {
  async function resolve(overrides: Record<string, unknown>) {
    vi.resetModules();
    const { resolveTaskExecutionPosition } = await import('../src/core/scheduler.js');
    return resolveTaskExecutionPosition(overrides as Parameters<typeof resolveTaskExecutionPosition>[0]);
  }

  it('stays task while the dedicated topic has not materialized', async () => {
    expect(await resolve({ executionPosition: 'task', scope: 'thread' })).toBe('task');
  });

  it('resolves a materialized task (root written back) to the topic/thread branch', async () => {
    expect(await resolve({ executionPosition: 'task', scope: 'thread', rootMessageId: 'om_task_root' })).toBe('topic');
  });
});

