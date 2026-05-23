/**
 * Idempotency contract for `schedule-store.createTask` — added by v0.1.2
 * §2.2 (Option A: create-or-return-identical) to support workflow runtime
 * deterministic task ids without leaking attempt mutability into existing
 * tasks.
 *
 * Mirrors the test scaffolding in schedule-store.test.ts (real fs in temp
 * dirs, mocked config/logger).
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
        return tempDir;
      },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const BASE_PARAMS = {
  name: 'Daily build',
  schedule: '0 9 * * *',
  parsed: { kind: 'cron' as const, expr: '0 9 * * *', display: '0 9 * * *' },
  prompt: 'Run the build pipeline',
  workingDir: '/workspace/project',
  chatId: 'oc_test_chat',
};

async function freshImport() {
  vi.resetModules();
  return import('../src/services/schedule-store.js');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schedule-store-idem-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('createTask — no id (legacy path)', () => {
  it('assigns randomUUID 8-char id when id omitted', async () => {
    const { createTask } = await freshImport();
    const t = createTask(BASE_PARAMS);
    expect(t.id.length).toBe(8);
    expect(t.id).toMatch(/^[0-9a-f-]{8}$/);
  });
});

describe('createTask — id provided, task absent', () => {
  it('creates with the supplied id', async () => {
    const { createTask, getTask } = await freshImport();
    const t = createTask({ ...BASE_PARAMS, id: 'wf_abc12345' });
    expect(t.id).toBe('wf_abc12345');
    expect(getTask('wf_abc12345')?.name).toBe(BASE_PARAMS.name);
  });

  it('persists supplied id to disk', async () => {
    const { createTask } = await freshImport();
    createTask({ ...BASE_PARAMS, id: 'wf_persisted' });
    const reload = await freshImport();
    expect(reload.getTask('wf_persisted')?.name).toBe(BASE_PARAMS.name);
  });
});

describe('createTask — id provided, task exists with identical canonical input', () => {
  it('returns existing task without mutating runtime state', async () => {
    const { createTask, updateTask, getTask } = await freshImport();
    const id = 'wf_returns_existing';
    const first = createTask({ ...BASE_PARAMS, id });

    // Simulate runtime mutation: enable->disable, set lastRunAt
    updateTask(id, { enabled: false, lastRunAt: '2026-05-19T10:00:00Z', lastStatus: 'ok' });

    const second = createTask({ ...BASE_PARAMS, id });
    expect(second.id).toBe(id);
    // Same canonical input → returns the **existing** task,
    // mutated runtime state must be preserved (not reset).
    expect(second.enabled).toBe(false);
    expect(second.lastRunAt).toBe('2026-05-19T10:00:00Z');
    expect(second.lastStatus).toBe('ok');

    // Same object identity (reference equality) — getTask returns same task
    expect(getTask(id)).toBe(second);
  });

  it('treats identical input but different key order as identical', async () => {
    const { createTask } = await freshImport();
    const id = 'wf_keyorder';
    const a = createTask({
      id,
      // Order A: name → schedule → parsed → ...
      name: BASE_PARAMS.name,
      schedule: BASE_PARAMS.schedule,
      parsed: BASE_PARAMS.parsed,
      prompt: BASE_PARAMS.prompt,
      workingDir: BASE_PARAMS.workingDir,
      chatId: BASE_PARAMS.chatId,
    });
    const b = createTask({
      id,
      // Order B: chatId first
      chatId: BASE_PARAMS.chatId,
      workingDir: BASE_PARAMS.workingDir,
      prompt: BASE_PARAMS.prompt,
      parsed: BASE_PARAMS.parsed,
      schedule: BASE_PARAMS.schedule,
      name: BASE_PARAMS.name,
    });
    expect(b.id).toBe(a.id);
  });

  it('ignores repeat.completed mutation (not part of canonical input)', async () => {
    const { createTask, markRun } = await freshImport();
    const id = 'wf_repeat_counter';
    const first = createTask({
      ...BASE_PARAMS,
      id,
      repeat: { times: 5, completed: 0 },
    });
    // Simulate one run completing (advances `completed`)
    markRun(id, true);

    // Re-create with same canonical input: should NOT conflict despite
    // completed having changed.
    const second = createTask({
      ...BASE_PARAMS,
      id,
      repeat: { times: 5, completed: 0 },
    });
    expect(second.id).toBe(first.id);
    expect(second.repeat?.completed).toBe(1);
  });

  it('ignores chatType (advisory field) — caller-omitted still matches', async () => {
    const { createTask } = await freshImport();
    const id = 'wf_chattype';
    const a = createTask({ ...BASE_PARAMS, id, chatType: 'group' });
    const b = createTask({ ...BASE_PARAMS, id }); // chatType missing
    expect(b.id).toBe(a.id);
    expect(b.chatType).toBe('group'); // existing preserved
  });
});

describe('createTask — id provided, task exists with DIFFERENT canonical input', () => {
  it('throws IdempotencyConflictError when prompt changes', async () => {
    const { createTask, IdempotencyConflictError } = await freshImport();
    const id = 'wf_conflict_prompt';
    createTask({ ...BASE_PARAMS, id });
    expect(() => createTask({ ...BASE_PARAMS, id, prompt: 'CHANGED' })).toThrow(
      IdempotencyConflictError,
    );
  });

  it.each([
    ['name', { name: 'Other' }],
    ['schedule', { schedule: '0 10 * * *' }],
    ['workingDir', { workingDir: '/other' }],
    ['chatId', { chatId: 'oc_other' }],
    ['rootMessageId', { rootMessageId: 'om_x' }],
    ['scope', { scope: 'chat' as const }],
    ['larkAppId', { larkAppId: 'cli_other' }],
    ['deliver', { deliver: 'local' as const }],
  ])('throws when %s differs', async (_field, diff) => {
    const { createTask, IdempotencyConflictError } = await freshImport();
    const id = 'wf_conflict_field';
    createTask({ ...BASE_PARAMS, id });
    expect(() => createTask({ ...BASE_PARAMS, id, ...diff })).toThrow(
      IdempotencyConflictError,
    );
  });

  it('throws when repeat.times differs', async () => {
    const { createTask, IdempotencyConflictError } = await freshImport();
    const id = 'wf_conflict_repeat';
    createTask({ ...BASE_PARAMS, id, repeat: { times: 3, completed: 0 } });
    expect(() =>
      createTask({ ...BASE_PARAMS, id, repeat: { times: 5, completed: 0 } }),
    ).toThrow(IdempotencyConflictError);
  });

  it('IdempotencyConflictError carries useful detail', async () => {
    const { createTask, IdempotencyConflictError } = await freshImport();
    const id = 'wf_detail_check';
    createTask({ ...BASE_PARAMS, id });
    try {
      createTask({ ...BASE_PARAMS, id, prompt: 'X' });
      expect.fail('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(IdempotencyConflictError);
      expect(e.taskId).toBe(id);
      expect(e.existingInputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(e.incomingInputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(e.existingInputHash).not.toBe(e.incomingInputHash);
    }
  });
});

describe('createTask — canonical input includes parsed.runAt (codex round 4)', () => {
  it('returns existing when same raw schedule + same parsed.runAt', async () => {
    const { createTask } = await freshImport();
    const id = 'wf_parsed_match';
    const runAt = '2026-05-19T12:00:00Z';
    const a = createTask({
      ...BASE_PARAMS,
      id,
      schedule: '30m',
      parsed: { kind: 'once', runAt, display: '30 分钟后' },
    });
    const b = createTask({
      ...BASE_PARAMS,
      id,
      schedule: '30m',
      parsed: { kind: 'once', runAt, display: '30 分钟后' },
    });
    expect(b.id).toBe(a.id);
  });

  it('THROWS when same raw schedule but parsed.runAt differs (re-parsed at different time)', async () => {
    // Reproduces the codex round 4 scenario: workflow retry re-parses
    // `30m` and gets a different concrete runAt.  Canonical input must
    // freeze the resolved schedule, otherwise the retry mutates state
    // silently.
    const { createTask, IdempotencyConflictError } = await freshImport();
    const id = 'wf_parsed_drift';
    createTask({
      ...BASE_PARAMS,
      id,
      schedule: '30m',
      parsed: { kind: 'once', runAt: '2026-05-19T12:00:00Z', display: '30 分钟后' },
    });
    expect(() =>
      createTask({
        ...BASE_PARAMS,
        id,
        schedule: '30m',
        parsed: { kind: 'once', runAt: '2026-05-19T13:00:00Z', display: '30 分钟后' },
      }),
    ).toThrow(IdempotencyConflictError);
  });

  it('ignores parsed.display changes (UI string only)', async () => {
    const { createTask } = await freshImport();
    const id = 'wf_display_drift';
    const a = createTask({
      ...BASE_PARAMS,
      id,
      schedule: '30m',
      parsed: { kind: 'once', runAt: '2026-05-19T12:00:00Z', display: '30 分钟后' },
    });
    const b = createTask({
      ...BASE_PARAMS,
      id,
      schedule: '30m',
      // Different display string (e.g. i18n change) shouldn't trigger conflict.
      parsed: { kind: 'once', runAt: '2026-05-19T12:00:00Z', display: 'in 30 min' },
    });
    expect(b.id).toBe(a.id);
  });
});

describe('createTask — id namespace isolation', () => {
  it('wf_ prefixed id and 8-char random id coexist', async () => {
    const { createTask, listTasks } = await freshImport();
    const a = createTask(BASE_PARAMS); // random 8 char
    const b = createTask({ ...BASE_PARAMS, name: 'B', id: 'wf_explicit' });
    expect(a.id).not.toBe(b.id);
    expect(listTasks()).toHaveLength(2);
  });
});
