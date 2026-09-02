import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SCHEDULE_RUN_LOG_ENTRIES,
  MAX_SCHEDULE_RUN_LOG_ERROR_BYTES,
  appendScheduleRunLog,
  queryScheduleRunLogs,
  removeScheduleRunLogs,
  scheduleRunLogDirectory,
  scheduleRunLogPath,
  type ScheduleRunLogEntry,
} from '../src/services/schedule-run-log-store.js';

const APP_ID = 'cli_schedule_run_log_test';
const OTHER_APP_ID = 'cli_schedule_run_log_other';
const TASK_ID = '../task/with/path-segments';
const OTHER_TASK_ID = 'other-task';

let tempDir: string;
let dataDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-schedule-run-log-'));
  dataDir = join(tempDir, 'data');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function entry(
  id: string,
  overrides: Partial<ScheduleRunLogEntry> = {},
): ScheduleRunLogEntry {
  return {
    id,
    taskId: TASK_ID,
    trigger: 'scheduler',
    outcome: 'model_dispatched',
    precondition: 'passed',
    startedAt: '2026-08-31T00:00:00.000Z',
    finishedAt: '2026-08-31T00:00:00.125Z',
    durationMs: 125,
    additionalPrompt: false,
    ...overrides,
  };
}

describe('schedule-run-log-store', () => {
  it('uses a hashed task filename and private directory/file modes', () => {
    const stored = appendScheduleRunLog(entry('run-1'), APP_ID, dataDir);
    const path = scheduleRunLogPath(TASK_ID, APP_ID, dataDir);
    const expectedHash = createHash('sha256').update(TASK_ID, 'utf8').digest('hex');

    expect(stored.id).toBe('run-1');
    expect(basename(path)).toBe(`${expectedHash}.jsonl`);
    expect(path).not.toContain(TASK_ID);
    expect(dirname(path)).toBe(scheduleRunLogDirectory(APP_ID, dataDir));
    if (process.platform !== 'win32') {
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('returns newest-first pagination with total and hasMore', () => {
    for (let index = 0; index < 5; index += 1) {
      appendScheduleRunLog(entry(`run-${index}`), APP_ID, dataDir);
    }

    expect(queryScheduleRunLogs(TASK_ID, { limit: 2, offset: 1 }, APP_ID, dataDir)).toEqual({
      logs: [entry('run-3'), entry('run-2')],
      total: 5,
      limit: 2,
      offset: 1,
      hasMore: true,
    });
    expect(queryScheduleRunLogs(TASK_ID, { limit: 500, offset: -3 }, APP_ID, dataDir)).toMatchObject({
      total: 5,
      limit: MAX_SCHEDULE_RUN_LOG_ENTRIES,
      offset: 0,
      hasMore: false,
    });
  });

  it('retains only the latest 100 entries', () => {
    for (let index = 0; index < MAX_SCHEDULE_RUN_LOG_ENTRIES + 7; index += 1) {
      appendScheduleRunLog(entry(`run-${index}`), APP_ID, dataDir);
    }

    const page = queryScheduleRunLogs(
      TASK_ID,
      { limit: MAX_SCHEDULE_RUN_LOG_ENTRIES },
      APP_ID,
      dataDir,
    );
    expect(page.total).toBe(MAX_SCHEDULE_RUN_LOG_ENTRIES);
    expect(page.logs[0].id).toBe('run-106');
    expect(page.logs.at(-1)?.id).toBe('run-7');

    // A manually oversized file still exposes only the retained window.
    const path = scheduleRunLogPath(TASK_ID, APP_ID, dataDir);
    const raw = readFileSync(path, 'utf8');
    writeFileSync(path, `${JSON.stringify(entry('manual-old'))}\n${raw}`, { mode: 0o600 });
    expect(queryScheduleRunLogs(
      TASK_ID,
      { limit: MAX_SCHEDULE_RUN_LOG_ENTRIES },
      APP_ID,
      dataDir,
    ).total).toBe(MAX_SCHEDULE_RUN_LOG_ENTRIES);
  });

  it('ignores malformed, invalid, and wrong-task lines without hiding valid entries', () => {
    appendScheduleRunLog(entry('run-1'), APP_ID, dataDir);
    appendScheduleRunLog(entry('run-2'), APP_ID, dataDir);
    const path = scheduleRunLogPath(TASK_ID, APP_ID, dataDir);
    const valid = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      [
        '{broken',
        JSON.stringify({ ...entry('invalid'), durationMs: -1 }),
        JSON.stringify(entry('wrong-task', { taskId: OTHER_TASK_ID })),
        valid.trimEnd(),
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);

    expect(queryScheduleRunLogs(TASK_ID, { limit: 20 }, APP_ID, dataDir).logs.map(log => log.id))
      .toEqual(['run-2', 'run-1']);
  });

  it('projects the persisted schema and caps error text at 2 KiB of UTF-8', () => {
    const stored = appendScheduleRunLog({
      ...entry('run-error', {
        outcome: 'error',
        precondition: 'error',
        errorCode: 'precondition_failed',
        error: '错'.repeat(1_000),
      }),
      prompt: 'must not be persisted',
      bashScript: 'echo secret',
      stdout: '1\nextra prompt',
      modelOutput: 'secret answer',
    } as ScheduleRunLogEntry, APP_ID, dataDir);
    const raw = JSON.parse(
      readFileSync(scheduleRunLogPath(TASK_ID, APP_ID, dataDir), 'utf8').trim(),
    ) as Record<string, unknown>;

    expect(Buffer.byteLength(stored.error ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_SCHEDULE_RUN_LOG_ERROR_BYTES,
    );
    expect(Buffer.byteLength(String(raw.error), 'utf8')).toBeLessThanOrEqual(
      MAX_SCHEDULE_RUN_LOG_ERROR_BYTES,
    );
    expect(raw).not.toHaveProperty('prompt');
    expect(raw).not.toHaveProperty('bashScript');
    expect(raw).not.toHaveProperty('stdout');
    expect(raw).not.toHaveProperty('modelOutput');
    expect(raw.additionalPrompt).toBe(false);
  });

  it('deletes only the selected task log and remains idempotent', () => {
    appendScheduleRunLog(entry('task-a'), APP_ID, dataDir);
    appendScheduleRunLog(entry('task-b', { taskId: OTHER_TASK_ID }), APP_ID, dataDir);
    appendScheduleRunLog(entry('other-app'), OTHER_APP_ID, dataDir);

    expect(removeScheduleRunLogs(TASK_ID, APP_ID, dataDir)).toBe(true);
    expect(removeScheduleRunLogs(TASK_ID, APP_ID, dataDir)).toBe(false);
    expect(queryScheduleRunLogs(TASK_ID, { limit: 20 }, APP_ID, dataDir).total).toBe(0);
    expect(queryScheduleRunLogs(OTHER_TASK_ID, { limit: 20 }, APP_ID, dataDir).logs[0]?.id)
      .toBe('task-b');
    expect(queryScheduleRunLogs(TASK_ID, { limit: 20 }, OTHER_APP_ID, dataDir).logs[0]?.id)
      .toBe('other-app');
  });

  it('rejects invalid append entries without creating a log file', () => {
    expect(() => appendScheduleRunLog(
      entry('invalid', { startedAt: 'not-a-date' }),
      APP_ID,
      dataDir,
    )).toThrow('entry failed schema validation');
    expect(queryScheduleRunLogs(TASK_ID, { limit: 20 }, APP_ID, dataDir).total).toBe(0);
  });
});
