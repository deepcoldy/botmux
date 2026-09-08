/**
 * schedule-store-follow-active.test.ts
 *
 * Persistence of ScheduledTask.followActive: createTask keeps it (true only),
 * updateTask can set/clear it, it survives a reload/migrate, and it is part of
 * the canonical input hash (a follow-active task is a different task).
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

const TEST_APP = 'cli_testapp0000000001';

const TASK_PARAMS = {
  name: 'sentinel',
  schedule: '*/30 * * * *',
  parsed: { kind: 'cron' as const, expr: '*/30 * * * *', display: '*/30 * * * *' },
  prompt: 'check',
  workingDir: '/workspace/project',
  chatId: 'oc_test_chat',
  rootMessageId: 'om_origin',
  scope: 'thread' as const,
  executionPosition: 'topic' as const,
};

async function freshImport() {
  vi.resetModules();
  const mod = await import('../src/services/schedule-store.js');
  mod.setScheduleScope(TEST_APP);
  return mod;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schedule-store-follow-active-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('schedule-store followActive', () => {
  it('createTask persists followActive only as literal true', async () => {
    const { createTask } = await freshImport();
    expect(createTask({ ...TASK_PARAMS, followActive: true }).followActive).toBe(true);
    expect(createTask({ ...TASK_PARAMS, followActive: false }).followActive).toBeUndefined();
    expect(createTask({ ...TASK_PARAMS }).followActive).toBeUndefined();
  });

  it('survives a process restart (reload + migrate)', async () => {
    const first = await freshImport();
    const id = first.createTask({ ...TASK_PARAMS, followActive: true }).id;
    const second = await freshImport();
    expect(second.getTask(id)?.followActive).toBe(true);
  });

  it('updateTask can set and clear the flag', async () => {
    const { createTask, updateTask, getTask } = await freshImport();
    const id = createTask({ ...TASK_PARAMS }).id;
    updateTask(id, { followActive: true });
    expect(getTask(id)?.followActive).toBe(true);
    updateTask(id, { followActive: undefined });
    expect(getTask(id)?.followActive).toBeUndefined();
  });

  it('is part of the canonical input hash', async () => {
    const { canonicalScheduleInput } = await freshImport();
    const plain = JSON.stringify(canonicalScheduleInput({ ...TASK_PARAMS }));
    const follow = JSON.stringify(canonicalScheduleInput({ ...TASK_PARAMS, followActive: true }));
    expect(follow).not.toBe(plain);
    expect(JSON.stringify(canonicalScheduleInput({ ...TASK_PARAMS, followActive: false }))).toBe(plain);
  });
});
