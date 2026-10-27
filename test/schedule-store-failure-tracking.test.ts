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

const TEST_APP = 'cli_testapp0000000002';
const BASE_PARAMS = {
  name: 'Daily report',
  schedule: '0 9 * * *',
  parsed: { kind: 'cron' as const, expr: '0 9 * * *', display: '0 9 * * *' },
  prompt: 'send the report',
  workingDir: '/workspace/project',
  chatId: 'oc_test_chat',
};

async function freshImport() {
  vi.resetModules();
  const mod = await import('../src/services/schedule-store.js');
  mod.setScheduleScope(TEST_APP);
  return mod;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schedule-fail-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('markRun consecutive-failure tracking', () => {
  it('counts consecutive failures and signals threshold crossing exactly once', async () => {
    const { createTask, markRun, getTask, SCHEDULE_FAILURE_ALERT_THRESHOLD } = await freshImport();
    const id = 'wf_failcount';
    createTask({ ...BASE_PARAMS, id });
    const N = SCHEDULE_FAILURE_ALERT_THRESHOLD;

    for (let i = 1; i < N; i += 1) {
      const r = markRun(id, false, 'boom');
      expect(r.crossedFailureThreshold).toBe(false);
      expect(getTask(id).runStats?.consecutiveFailures).toBe(i);
      expect(getTask(id).failureAlertSent).toBeFalsy();
    }
    const crossed = markRun(id, false, 'boom');
    expect(crossed.crossedFailureThreshold).toBe(true);
    expect(getTask(id).failureAlertSent).toBe(true);

    // 阈值之后继续失败不再重复发信号（只告警一次）。
    expect(markRun(id, false, 'boom').crossedFailureThreshold).toBe(false);
  });

  it('resets the streak and alert watermark on success', async () => {
    const { createTask, markRun, getTask } = await freshImport();
    const id = 'wf_failreset';
    createTask({ ...BASE_PARAMS, id });
    markRun(id, false, 'x');
    markRun(id, false, 'x');
    markRun(id, true);
    const t = getTask(id);
    expect(t.runStats?.consecutiveFailures).toBe(0);
    expect(t.failureAlertSent).toBeFalsy();
    expect(t.lastError).toBeUndefined();

    // 恢复后再次失败，水印已清，达到阈值可再发一次。
    const { SCHEDULE_FAILURE_ALERT_THRESHOLD } = await freshImport();
    for (let i = 0; i < SCHEDULE_FAILURE_ALERT_THRESHOLD - 1; i += 1) markRun(id, false, 'y');
    expect(markRun(id, false, 'y').crossedFailureThreshold).toBe(true);
  });

  it('persists the failure streak across reload', async () => {
    const a = await freshImport();
    const id = 'wf_failpersist';
    a.createTask({ ...BASE_PARAMS, id });
    a.markRun(id, false, 'perm');
    a.markRun(id, false, 'perm');

    const b = await freshImport();
    expect(b.getTask(id).runStats?.consecutiveFailures).toBe(2);
    const r = b.markRun(id, false, 'perm');
    expect(r.crossedFailureThreshold).toBe(true);
  });

  it('advances the shared counter for until-done settlements too (single ledger)', async () => {
    const { createTask, markRun, getTask, SCHEDULE_FAILURE_ALERT_THRESHOLD } = await freshImport();
    const id = 'wf_failuntil';
    createTask({
      ...BASE_PARAMS,
      id,
      untilDone: { status: 'open', attempts: 0, deadline: new Date(Date.now() + 3_600_000).toISOString() },
    });
    for (let i = 0; i < SCHEDULE_FAILURE_ALERT_THRESHOLD; i += 1) markRun(id, false, 'late');
    expect(getTask(id).runStats?.consecutiveFailures).toBe(SCHEDULE_FAILURE_ALERT_THRESHOLD);
    // closing 串同样只越线一次。
    expect(markRun(id, false, 'late').crossedFailureThreshold).toBe(false);
  });
});

describe('nextFailureTracking (shared rule for JSON store and authority runtime)', () => {
  it('advances the ledger streak and crosses the alert threshold exactly once', async () => {
    const { nextFailureTracking, SCHEDULE_FAILURE_ALERT_THRESHOLD } = await freshImport();
    let current: Parameters<typeof nextFailureTracking>[0] = undefined;
    for (let i = 1; i < SCHEDULE_FAILURE_ALERT_THRESHOLD; i += 1) {
      const r = nextFailureTracking(current, false);
      current = r.runStats;
      expect(r.crossedFailureThreshold).toBe(false);
      expect(r.consecutiveFailures).toBe(i);
    }
    const crossed = nextFailureTracking(current, false);
    expect(crossed.crossedFailureThreshold).toBe(true);
    expect(crossed.consecutiveFailures).toBe(SCHEDULE_FAILURE_ALERT_THRESHOLD);
    current = crossed.runStats;
    // 阈值之后继续失败不重复 crossed。
    expect(nextFailureTracking(current, false).crossedFailureThreshold).toBe(false);
  });

  it('a success clears the ledger streak (and the owner marker) so the next streak can alert again', async () => {
    const { nextFailureTracking } = await freshImport();
    let current = nextFailureTracking(nextFailureTracking(nextFailureTracking(undefined, false).runStats, false).runStats, false);
    expect(current.crossedFailureThreshold).toBe(true);
    const cleared = nextFailureTracking(current.runStats, true);
    expect(cleared.crossedFailureThreshold).toBe(false);
    expect(cleared.consecutiveFailures).toBe(0);
    expect(cleared.runStats.failingNotifiedAt).toBeUndefined();
    expect(nextFailureTracking(nextFailureTracking(nextFailureTracking(cleared.runStats, false).runStats, false).runStats, false).crossedFailureThreshold)
      .toBe(true);
  });

  it('treats undefined input (legacy task) as zero streak', async () => {
    const { nextFailureTracking } = await freshImport();
    expect(nextFailureTracking(undefined, false).consecutiveFailures).toBe(1);
  });
});

describe('#2334 → ledger migration absorb', () => {
  it('folds a persisted top-level consecutiveFailures into runStats on reload', async () => {
    const a = await freshImport();
    const id = 'wf_failabsorb';
    a.createTask({ ...BASE_PARAMS, id });
    // Simulate a task persisted by #2334's model: top-level counter, no ledger.
    const { readFileSync, writeFileSync } = await import('node:fs');
    const fp = a.scheduleFilePathFor(TEST_APP);
    const disk = JSON.parse(readFileSync(fp, 'utf-8'));
    disk[id] = { ...disk[id], consecutiveFailures: 2 };
    writeFileSync(fp, JSON.stringify(disk));

    const b = await freshImport();
    const t = b.getTask(id);
    expect(t?.runStats?.consecutiveFailures).toBe(2);
    expect(t?.consecutiveFailures).toBeUndefined();
    // Absorbed streak keeps counting: one more failure crosses the threshold.
    const r = b.markRun(id, false, 'boom');
    expect(r.crossedFailureThreshold).toBe(true);
  });

  it('max wins: an existing ledger streak is never regressed by the legacy field', async () => {
    const a = await freshImport();
    const id = 'wf_failmax';
    a.createTask({ ...BASE_PARAMS, id });
    a.markRun(id, false, 'x');
    a.markRun(id, false, 'x'); // ledger streak = 2
    const { readFileSync, writeFileSync } = await import('node:fs');
    const fp = a.scheduleFilePathFor(TEST_APP);
    const disk = JSON.parse(readFileSync(fp, 'utf-8'));
    disk[id].consecutiveFailures = 1; // stale smaller top-level value
    writeFileSync(fp, JSON.stringify(disk));

    const b = await freshImport();
    expect(b.getTask(id).runStats?.consecutiveFailures).toBe(2);
  });
});
