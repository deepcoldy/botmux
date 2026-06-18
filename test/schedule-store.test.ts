/**
 * Unit tests for schedule-store: file-backed CRUD for ScheduledTask.
 *
 * Uses real temp directories for file I/O — no fs mocks.
 * Mocks config.session.dataDir to point at a per-test temp dir
 * and logger to suppress output.
 *
 * Run:  pnpm vitest run test/schedule-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Shared state ────────────────────────────────────────────────────────────

let tempDir: string;

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock config so dataDir points to our temp directory.
// We update tempDir in beforeEach; the getter ensures the latest value is used.
vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() {
        return tempDir;
      },
    },
  },
}));

// Suppress log output during tests.
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TASK_PARAMS = {
  name: 'Daily build',
  schedule: '0 9 * * *',
  parsed: { kind: 'cron' as const, expr: '0 9 * * *', display: '0 9 * * *' },
  prompt: 'Run the build pipeline',
  workingDir: '/workspace/project',
  chatId: 'oc_test_chat',
};

/**
 * Dynamically import a fresh copy of schedule-store.
 * Each call resets the module registry so the module-level `loaded` flag
 * and `tasks` Map start from scratch — simulating a process restart.
 */
async function freshImport() {
  vi.resetModules();
  return import('../src/services/schedule-store.js');
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schedule-store-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('schedule-store', () => {
  // ── CRUD ────────────────────────────────────────────────────────────────

  describe('createTask', () => {
    it('should return a task with all expected fields', async () => {
      const { createTask } = await freshImport();
      const task = createTask(TASK_PARAMS);

      expect(task.id).toBeTypeOf('string');
      expect(task.id.length).toBe(8);
      expect(task.name).toBe(TASK_PARAMS.name);
      expect(task.parsed.kind).toBe('cron');
      expect(task.parsed.expr).toBe('0 9 * * *');
      expect(task.schedule).toBe(TASK_PARAMS.schedule);
      expect(task.prompt).toBe(TASK_PARAMS.prompt);
      expect(task.workingDir).toBe(TASK_PARAMS.workingDir);
      expect(task.chatId).toBe(TASK_PARAMS.chatId);
      expect(task.enabled).toBe(true);
      expect(task.createdAt).toBeTypeOf('string');
      // createdAt should be a valid ISO string
      expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
    });

    it('should persist the task to disk as JSON', async () => {
      const { createTask } = await freshImport();
      createTask(TASK_PARAMS);

      const fp = join(tempDir, 'schedules.json');
      expect(existsSync(fp)).toBe(true);

      const data = JSON.parse(readFileSync(fp, 'utf-8'));
      const ids = Object.keys(data);
      expect(ids).toHaveLength(1);
      expect(data[ids[0]].name).toBe(TASK_PARAMS.name);
    });

    it('should assign unique IDs to different tasks', async () => {
      const { createTask } = await freshImport();
      const t1 = createTask({ ...TASK_PARAMS, name: 'Task A' });
      const t2 = createTask({ ...TASK_PARAMS, name: 'Task B' });

      expect(t1.id).not.toBe(t2.id);
    });
  });

  describe('getTask', () => {
    it('should retrieve a task by ID', async () => {
      const { createTask, getTask } = await freshImport();
      const created = createTask(TASK_PARAMS);

      const fetched = getTask(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe(TASK_PARAMS.name);
    });

    it('should return undefined for a non-existent ID', async () => {
      const { getTask } = await freshImport();
      expect(getTask('nonexistent')).toBeUndefined();
    });
  });

  describe('removeTask', () => {
    it('should remove an existing task and return true', async () => {
      const { createTask, removeTask, getTask } = await freshImport();
      const task = createTask(TASK_PARAMS);

      const result = removeTask(task.id);
      expect(result).toBe(true);
      expect(getTask(task.id)).toBeUndefined();
    });

    it('should return false when removing a non-existent task', async () => {
      const { removeTask } = await freshImport();
      expect(removeTask('nonexistent')).toBe(false);
    });

    it('should persist the removal to disk', async () => {
      const { createTask, removeTask } = await freshImport();
      const task = createTask(TASK_PARAMS);
      removeTask(task.id);

      const fp = join(tempDir, 'schedules.json');
      const data = JSON.parse(readFileSync(fp, 'utf-8'));
      expect(Object.keys(data)).toHaveLength(0);
    });
  });

  describe('updateTask', () => {
    it('should update the enabled flag', async () => {
      const { createTask, updateTask, getTask } = await freshImport();
      const task = createTask(TASK_PARAMS);
      expect(task.enabled).toBe(true);

      updateTask(task.id, { enabled: false });
      const updated = getTask(task.id);
      expect(updated!.enabled).toBe(false);
    });

    it('should update lastRunAt', async () => {
      const { createTask, updateTask, getTask } = await freshImport();
      const task = createTask(TASK_PARAMS);
      expect(task.lastRunAt).toBeUndefined();

      const now = new Date().toISOString();
      updateTask(task.id, { lastRunAt: now });
      const updated = getTask(task.id);
      expect(updated!.lastRunAt).toBe(now);
    });

    it('should be a no-op for a non-existent task', async () => {
      const { updateTask, listTasks } = await freshImport();
      // Should not throw
      updateTask('nonexistent', { enabled: false });
      expect(listTasks()).toHaveLength(0);
    });

    it('should update the deliver mode (origin ↔ new-topic)', async () => {
      const { createTask, updateTask, getTask } = await freshImport();
      const task = createTask({ ...TASK_PARAMS, deliver: 'origin' });
      expect(task.deliver).toBe('origin');

      updateTask(task.id, { deliver: 'new-topic' });
      expect(getTask(task.id)!.deliver).toBe('new-topic');

      updateTask(task.id, { deliver: 'origin' });
      expect(getTask(task.id)!.deliver).toBe('origin');
    });

    it('should persist a new-topic task created with deliver', async () => {
      const { createTask, getTask } = await freshImport();
      const task = createTask({ ...TASK_PARAMS, deliver: 'new-topic' });
      // Re-read from a fresh module instance to confirm it survives disk round-trip.
      const { getTask: getTask2 } = await freshImport();
      expect(getTask2(task.id)!.deliver).toBe('new-topic');
      // (within same instance too)
      expect(getTask(task.id)!.deliver).toBe('new-topic');
    });

    it('should persist updates to disk', async () => {
      const { createTask, updateTask } = await freshImport();
      const task = createTask(TASK_PARAMS);
      updateTask(task.id, { enabled: false });

      const fp = join(tempDir, 'schedules.json');
      const data = JSON.parse(readFileSync(fp, 'utf-8'));
      expect(data[task.id].enabled).toBe(false);
    });
  });

  describe('listTasks', () => {
    it('should return an empty array when no tasks exist', async () => {
      const { listTasks } = await freshImport();
      expect(listTasks()).toEqual([]);
    });

    it('should return all created tasks', async () => {
      const { createTask, listTasks } = await freshImport();
      createTask({ ...TASK_PARAMS, name: 'A' });
      createTask({ ...TASK_PARAMS, name: 'B' });
      createTask({ ...TASK_PARAMS, name: 'C' });

      const all = listTasks();
      expect(all).toHaveLength(3);
      const names = all.map((t) => t.name).sort();
      expect(names).toEqual(['A', 'B', 'C']);
    });

    it('should return a copy, not the internal collection', async () => {
      const { createTask, listTasks } = await freshImport();
      createTask(TASK_PARAMS);

      const list1 = listTasks();
      const list2 = listTasks();
      expect(list1).not.toBe(list2);
    });
  });

  // ── Persistence across reloads ──────────────────────────────────────────

  describe('persistence', () => {
    it('should survive a module reload (simulating process restart)', async () => {
      // First "process": create tasks
      const store1 = await freshImport();
      const t1 = store1.createTask({ ...TASK_PARAMS, name: 'Persistent A' });
      const t2 = store1.createTask({ ...TASK_PARAMS, name: 'Persistent B' });

      // Second "process": fresh import, should load from disk
      const store2 = await freshImport();
      const all = store2.listTasks();
      expect(all).toHaveLength(2);

      const fetched = store2.getTask(t1.id);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe('Persistent A');

      const fetched2 = store2.getTask(t2.id);
      expect(fetched2).toBeDefined();
      expect(fetched2!.name).toBe('Persistent B');
    });

    it('should persist updates across reloads', async () => {
      const store1 = await freshImport();
      const task = store1.createTask(TASK_PARAMS);
      store1.updateTask(task.id, { enabled: false, lastRunAt: '2026-01-01T00:00:00.000Z' });

      const store2 = await freshImport();
      const reloaded = store2.getTask(task.id);
      expect(reloaded).toBeDefined();
      expect(reloaded!.enabled).toBe(false);
      expect(reloaded!.lastRunAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('should persist removals across reloads', async () => {
      const store1 = await freshImport();
      const task = store1.createTask(TASK_PARAMS);
      store1.removeTask(task.id);

      const store2 = await freshImport();
      expect(store2.getTask(task.id)).toBeUndefined();
      expect(store2.listTasks()).toHaveLength(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle all three task types', async () => {
      const { createTask } = await freshImport();

      const cron = createTask({
        ...TASK_PARAMS,
        schedule: '*/5 * * * *',
        parsed: { kind: 'cron', expr: '*/5 * * * *', display: '*/5 * * * *' },
      });
      const interval = createTask({
        ...TASK_PARAMS,
        schedule: 'every 1m',
        parsed: { kind: 'interval', minutes: 1, display: 'every 1m' },
      });
      const once = createTask({
        ...TASK_PARAMS,
        schedule: '2099-12-31T23:59:59.000Z',
        parsed: { kind: 'once', runAt: '2099-12-31T23:59:59.000Z', display: 'once at 2099-12-31' },
      });

      expect(cron.parsed.kind).toBe('cron');
      expect(interval.parsed.kind).toBe('interval');
      expect(once.parsed.kind).toBe('once');
    });

    it('should create the data directory if it does not exist', async () => {
      // Point to a nested non-existent directory
      const nestedDir = join(tempDir, 'deep', 'nested', 'dir');
      tempDir = nestedDir;

      const { createTask } = await freshImport();
      createTask(TASK_PARAMS);

      expect(existsSync(join(nestedDir, 'schedules.json'))).toBe(true);
    });

    it('should handle an empty JSON file gracefully on reload', async () => {
      // Write an empty (but valid) JSON object
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(join(tempDir, 'schedules.json'), '{}', 'utf-8');

      const { listTasks } = await freshImport();
      expect(listTasks()).toEqual([]);
    });

    it('should handle a corrupted JSON file gracefully', async () => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(join(tempDir, 'schedules.json'), '<<<not json>>>', 'utf-8');

      const { listTasks } = await freshImport();
      // Should recover with an empty store instead of throwing
      expect(listTasks()).toEqual([]);
    });

    it('should not leave a .tmp file after a successful save', async () => {
      const { createTask } = await freshImport();
      createTask(TASK_PARAMS);

      expect(existsSync(join(tempDir, 'schedules.json.tmp'))).toBe(false);
      expect(existsSync(join(tempDir, 'schedules.json'))).toBe(true);
    });
  });
});
