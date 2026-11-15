/**
 * Legacy JSON projection: a parked (deferred) run must survive `updateTask`
 * writes, daemon restarts and external reloads, and must be cleared by every
 * terminal settlement. These use the real file-backed store with a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const TEST_APP = 'cli_deferred_store';
function storeFp(appId: string = TEST_APP): string {
  return join(tempDir, 'bots', appId, 'schedules.json');
}

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TASK_PARAMS = {
  name: 'handoff',
  schedule: '0 9 * * *',
  parsed: { kind: 'cron' as const, expr: '0 9 * * *', display: '0 9 * * *' },
  prompt: 'check',
  workingDir: '/workspace/project',
  chatId: 'oc_a',
  chatIds: ['oc_a', 'oc_b'],
};

async function freshImport() {
  vi.resetModules();
  const mod = await import('../src/services/schedule-store.js');
  mod.setScheduleScope(TEST_APP);
  return mod;
}

function deferred(runId: string) {
  return {
    runId,
    since: '2026-11-09T00:00:00.000Z',
    reason: 'traex_runtime' as const,
    detail: 'waiting',
    additionalPrompt: 'extra',
    precondition: 'passed' as const,
    retryAt: '2026-11-09T00:00:30.000Z',
    targets: { oc_a: 'dispatched' as const, oc_b: 'waiting' as const },
    targetTurnIds: {
      oc_a: 'schedule:t1:11111111-1111-1111-1111-111111111111',
      oc_b: 'schedule:t1:22222222-2222-2222-2222-222222222222',
      oc_untracked: 'schedule:t1:33333333-3333-3333-3333-333333333333',
    },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schedule-deferred-store-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('legacy schedule-store deferred run', () => {
  it('persists a deferred run through updateTask and reloads it field-for-field', async () => {
    let mod = await freshImport();
    const task = mod.createTask(TASK_PARAMS);
    expect(mod.updateTask(task.id, { deferredRun: deferred('run-1') })).toBe(true);

    // Real disk write.
    const onDisk = JSON.parse(readFileSync(storeFp(), 'utf-8'));
    expect(onDisk[task.id].deferredRun).toMatchObject({
      runId: 'run-1', targets: { oc_a: 'dispatched', oc_b: 'waiting' },
    });

    // Restart: fresh module, same temp dir.
    mod = await freshImport();
    const reloaded = mod.getTask(task.id)!;
    expect(reloaded.deferredRun).toMatchObject({
      runId: 'run-1',
      reason: 'traex_runtime',
      detail: 'waiting',
      additionalPrompt: 'extra',
      precondition: 'passed',
      retryAt: '2026-11-09T00:00:30.000Z',
      targets: { oc_a: 'dispatched', oc_b: 'waiting' },
    });
    // Turn ids are kept only for tracked targets.
    expect(reloaded.deferredRun!.targetTurnIds).toEqual({
      oc_a: 'schedule:t1:11111111-1111-1111-1111-111111111111',
      oc_b: 'schedule:t1:22222222-2222-2222-2222-222222222222',
    });
  });

  it('drops a malformed deferred run on reload instead of minting a phantom wait', async () => {
    let mod = await freshImport();
    const task = mod.createTask(TASK_PARAMS);
    mod.updateTask(task.id, { deferredRun: { ...deferred('run-bad'), reason: 'other' } as never });

    mod = await freshImport();
    expect(mod.getTask(task.id)!.deferredRun).toBeUndefined();
  });

  it('claims only the exact parked runId and never advances nextRunAt', async () => {
    const mod = await freshImport();
    const task = mod.createTask(TASK_PARAMS);
    const nextRunAt = mod.getTask(task.id)!.nextRunAt;
    mod.updateTask(task.id, { deferredRun: deferred('run-1'), lastRunId: 'run-1', lastStatus: 'deferred' });

    expect(mod.claimDeferredRun(task.id, 'wrong')).toEqual({ ok: false, error: 'run_mismatch' });
    const claimed = mod.claimDeferredRun(task.id, 'run-1');
    expect(claimed.ok).toBe(true);
    if (claimed.ok) {
      expect(claimed.task.lastStatus).toBe('running');
      expect(claimed.task.nextRunAt).toBe(nextRunAt);
      expect(claimed.task.deferredRun?.runId).toBe('run-1');
    }
    // Already running: a second concurrent retry is refused.
    expect(mod.claimDeferredRun(task.id, 'run-1')).toEqual({ ok: false, error: 'already_running' });
  });

  it('clears the parked run on markRun and markSkipped', async () => {
    const mod = await freshImport();
    const task = mod.createTask(TASK_PARAMS);
    mod.updateTask(task.id, { deferredRun: deferred('run-1'), lastRunId: 'run-1', lastStatus: 'deferred' });
    mod.markRun(task.id, true, undefined, undefined, 'run-1');
    expect(mod.getTask(task.id)!.deferredRun).toBeUndefined();

    mod.updateTask(task.id, { deferredRun: deferred('run-2'), lastRunId: 'run-2', lastStatus: 'deferred' });
    mod.markSkipped(task.id, undefined, 'run-2');
    expect(mod.getTask(task.id)!.deferredRun).toBeUndefined();
  });
});
