import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_CAPACITY_POLL_INTERVAL_MS,
  CodexCapacityMonitor,
  parseCodexCapacityRetryRow,
  resolveCodexLogsDbPath,
} from '../src/services/codex-capacity-monitor.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';

const THREAD_A = '01a21656-47a5-7c23-94b6-464238559697';
const THREAD_B = '01a20e98-375a-79d3-a1ed-c5bdb13481c5';

// Verbatim shape of a Codex 0.156+ `logs_2.sqlite` `codex_core::responses_retry` row.
const REAL_CAPACITY_BODY =
  `session_loop{thread_id=${THREAD_A}}:submission_dispatch{otel.name="op.dispatch.turn_input" submission.id="01a2166d-62aa-79c2-b98e-badca52f0118" codex.op="turn_input"}:` +
  `codex.turn_input{conversation.id=${THREAD_A} turn.id="01a2166d-62aa-79c2-b98e-badca52f0118"}:` +
  `turn{otel.name="session_task.turn" thread.id=${THREAD_A} turn.id=01a2166d-62aa-79c2-b98e-badca52f0118 model=gpt-6.1-sol codex.turn.reasoning_effort=xhigh}:` +
  `session_task.run:run_turn{conversation.id=${THREAD_A} turn.id=01a2166d-62aa-79c2-b98e-badca52f0118}:` +
  `run_sampling_request{turn_id=01a2166d-62aa-79c2-b98e-badca52f0118 model=gpt-6.1-sol cwd=/tmp/work}:` +
  `handle_response_stream_error{request=Sampling}: stream disconnected - retrying sampling request (1/5 in 369.995393367s)... ` +
  `turn_id=01a2166d-62aa-79c2-b98e-badca52f0118 retries=1 max_retries=5 sampling_error=Selected model is at capacity. Please try a different model.`;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'codex-capacity-monitor-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createLogsDb(dbPath: string) {
  const db = openDatabaseSyncOrThrow(dbPath);
  db.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL DEFAULT 0,
      level TEXT NOT NULL DEFAULT 'WARN',
      target TEXT NOT NULL,
      feedback_log_body TEXT,
      thread_id TEXT
    );
    CREATE INDEX idx_logs_thread_id ON logs(thread_id);
  `);
  return db;
}

describe('resolveCodexLogsDbPath', () => {
  it('picks the highest versioned logs_<N>.sqlite file in the directory', () => {
    writeFileSync(join(tempDir, 'logs_1.sqlite'), '');
    writeFileSync(join(tempDir, 'logs_2.sqlite'), '');
    writeFileSync(join(tempDir, 'logs_10.sqlite'), '');
    writeFileSync(join(tempDir, 'logs_abc.sqlite'), '');
    writeFileSync(join(tempDir, 'state_5.sqlite'), '');

    expect(resolveCodexLogsDbPath(tempDir)).toBe(join(tempDir, 'logs_10.sqlite'));
  });

  it('returns undefined when directory does not exist or has no matching logs DB', () => {
    expect(resolveCodexLogsDbPath(tempDir)).toBeUndefined();
    expect(resolveCodexLogsDbPath(join(tempDir, 'missing'))).toBeUndefined();
  });
});

describe('parseCodexCapacityRetryRow', () => {
  it('parses a verbatim Codex responses_retry capacity row', () => {
    const parsed = parseCodexCapacityRetryRow({
      id: 5460903,
      ts: 1795673295,
      target: 'codex_core::responses_retry',
      thread_id: THREAD_A,
      feedback_log_body: REAL_CAPACITY_BODY,
    });

    expect(parsed).toEqual({
      rowId: 5460903,
      tsMs: 1795673295_000,
      threadId: THREAD_A,
      model: 'gpt-6.1-sol',
      codexTurnId: '01a2166d-62aa-79c2-b98e-badca52f0118',
      retryAttempt: 1,
      maxRetries: 5,
      retryDelaySec: 370,
      errorMessage: 'Selected model is at capacity. Please try a different model.',
    });
  });

  it('supports server_overloaded, turn{} model fallback, kv retry counts, and millisecond timestamps', () => {
    const parsed = parseCodexCapacityRetryRow({
      id: 42,
      ts: 1795673295123,
      target: 'codex_core::responses_retry',
      thread_id: THREAD_B,
      feedback_log_body: 'turn{model=gpt-5.4}: retrying retries=2 max_retries=5 error=server_overloaded',
    });

    expect(parsed).toEqual({
      rowId: 42,
      tsMs: 1795673295123,
      threadId: THREAD_B,
      model: 'gpt-5.4',
      retryAttempt: 2,
      maxRetries: 5,
      errorMessage: 'Selected model is at capacity. Please try a different model.',
    });
  });

  it('rejects non-capacity errors, wrong targets, and rows missing thread_id', () => {
    expect(parseCodexCapacityRetryRow({
      id: 1,
      ts: 1795673295,
      target: 'codex_core::other',
      thread_id: THREAD_A,
      feedback_log_body: REAL_CAPACITY_BODY,
    })).toBeUndefined();

    expect(parseCodexCapacityRetryRow({
      id: 2,
      ts: 1795673295,
      target: 'codex_core::responses_retry',
      thread_id: THREAD_A,
      feedback_log_body: 'retrying sampling request (1/5 in 60s)... sampling_error=usage_limit_exceeded Selected model is at capacity',
    })).toBeUndefined();

    expect(parseCodexCapacityRetryRow({
      id: 3,
      ts: 1795673295,
      target: 'codex_core::responses_retry',
      thread_id: THREAD_A,
      feedback_log_body: 'retrying sampling request (1/5 in 10s)... sampling_error=rate_limit_exceeded',
    })).toBeUndefined();

    expect(parseCodexCapacityRetryRow({
      id: 4,
      ts: 1795673295,
      target: 'codex_core::responses_retry',
      thread_id: null,
      feedback_log_body: REAL_CAPACITY_BODY,
    })).toBeUndefined();
  });
});

describe('CodexCapacityMonitor', () => {
  it('baselines prior rows and incrementally reports new capacity retries for the bound thread only', () => {
    const dbPath = join(tempDir, 'logs_2.sqlite');
    const db = createLogsDb(dbPath);
    const insert = db.prepare(
      'INSERT INTO logs (ts, target, thread_id, feedback_log_body) VALUES (?, ?, ?, ?)',
    );
    // Historical row before bind — must not replay.
    insert.run(1795673000, 'codex_core::responses_retry', THREAD_A, REAL_CAPACITY_BODY);

    const monitor = new CodexCapacityMonitor({ pollIntervalMs: CODEX_CAPACITY_POLL_INTERVAL_MS });
    monitor.bind(tempDir, THREAD_A);
    expect(monitor.poll(10_000)).toEqual([]);

    // Insert one row for another thread and one new row for THREAD_A.
    insert.run(1795673295, 'codex_core::responses_retry', THREAD_B, REAL_CAPACITY_BODY);
    insert.run(1795673295, 'codex_core::responses_retry', THREAD_A, REAL_CAPACITY_BODY);

    // Throttled inside pollIntervalMs.
    expect(monitor.poll(11_000)).toEqual([]);

    const first = monitor.poll(10_000 + CODEX_CAPACITY_POLL_INTERVAL_MS);
    expect(first).toHaveLength(1);
    expect(first[0]?.threadId).toBe(THREAD_A);
    expect(first[0]?.model).toBe('gpt-6.1-sol');

    // Already consumed — subsequent poll returns empty until another row arrives.
    expect(monitor.poll(10_000 + CODEX_CAPACITY_POLL_INTERVAL_MS * 2)).toEqual([]);

    monitor.clear();
    expect(monitor.poll(50_000)).toEqual([]);
    db.close();
  });

  it('catches capacity retries logged right at or after sinceMs while ignoring older rows (seconds and ms)', () => {
    const dbPath = join(tempDir, 'logs_2.sqlite');
    const db = createLogsDb(dbPath);
    const insert = db.prepare(
      'INSERT INTO logs (ts, target, thread_id, feedback_log_body) VALUES (?, ?, ?, ?)',
    );
    // Older row (before turn start)
    insert.run(1795673200, 'codex_core::responses_retry', THREAD_A, REAL_CAPACITY_BODY);
    // Row logged in the exact second the turn started, before rollout bound
    insert.run(1795673295, 'codex_core::responses_retry', THREAD_A, REAL_CAPACITY_BODY);

    const monitor = new CodexCapacityMonitor({ pollIntervalMs: 0 });
    monitor.bind(tempDir, THREAD_A, { sinceMs: 1795673295_800 });

    const events = monitor.poll(10_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.tsMs).toBe(1795673295_000);

    // Also verify millisecond-precision ts rows respect sinceMs.
    const dbMsPath = join(tempDir, 'logs_3.sqlite');
    const dbMs = createLogsDb(dbMsPath);
    const insertMs = dbMs.prepare(
      'INSERT INTO logs (ts, target, thread_id, feedback_log_body) VALUES (?, ?, ?, ?)',
    );
    insertMs.run(1795673290_000, 'codex_core::responses_retry', THREAD_B, REAL_CAPACITY_BODY);
    insertMs.run(1795673296_500, 'codex_core::responses_retry', THREAD_B, REAL_CAPACITY_BODY);

    const monitorMs = new CodexCapacityMonitor({ pollIntervalMs: 0 });
    monitorMs.bind(tempDir, THREAD_B, { sinceMs: 1795673295_800 });
    const eventsMs = monitorMs.poll(10_000);
    expect(eventsMs).toHaveLength(1);
    expect(eventsMs[0]?.tsMs).toBe(1795673296_500);

    db.close();
    dbMs.close();
  });
});
