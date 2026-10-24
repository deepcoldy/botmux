import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as scheduler from '../src/core/scheduler.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import * as preconditionStore from '../src/services/schedule-precondition-store.js';
import { createTaskWithOptionalPrecondition } from '../src/core/schedule-precondition-config.js';

const APP = 'cli_authority';
let dataDir: string;
let store: ScheduleAuthorityStore;

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'scheduler-authority-')), 'data');
  config.session.dataDir = dataDir;
  scheduleStore.setScheduleScope(APP);
  store = ScheduleAuthorityStore.open(dataDir);
  store.initializeApp(APP, []);
  scheduler.setScheduleAuthorityStore(store);
  scheduler.setOwnerFilter(APP, true);
});

afterEach(() => {
  vi.restoreAllMocks();
  scheduler.stopScheduler();
  scheduler.setScheduleAuthorityStore(null);
  store.close();
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

function commit(id = 'a1b2c3d4') {
  return scheduler.commitDelegatedTask({
    params: {
      id, name: 'poll', schedule: 'every 30m', prompt: 'check', workingDir: '/repo',
      chatId: 'oc_chat', executionPosition: 'top-level', larkAppId: APP,
    },
    grantId: `grant-${id}`, requestHash: `hash-${id}`,
    control: { openId: 'ou_user', unionId: 'on_user', credentialOpenId: 'ou_user_source',
      runScopes: [], selfManage: false },
    sourceMessageId: 'om_kickoff', sourceSessionId: 'source-session',
    targetTurnId: 'om_kickoff', targetGeneration: 1,
    maxTasksPerTurn: 64,
  });
}

describe('scheduler host authority integration', () => {
  const params = {
    id: 'direct01', name: 'poll', schedule: 'every 30m', prompt: 'check',
    workingDir: '/repo', chatId: 'oc_chat', larkAppId: APP,
  };

  it('rejects reuse of a deleted direct id without leaving an enabled projection', () => {
    scheduler.addTask(params);
    expect(scheduler.removeTask(params.id)).toBe(true);
    expect(() => scheduler.addTask(params)).toThrow('schedule_task_id_conflict');
    expect(scheduleStore.getTask(params.id, APP)).toBeUndefined();
    expect(store.getRecord(APP, params.id)?.state).toBe('revoked');
    expect(store.listTasks(APP)).toEqual([]);
  });

  it('returns authoritative runtime state on retry and leaves it intact on input conflict', () => {
    const active = scheduler.addTask(params);
    expect(scheduler.addTask(params)).toEqual(active);
    const current = store.updateTask(APP, params.id, task => ({
      ...task, enabled: false, lastStatus: 'ok', lastRunId: 'prior-run',
      nextRunAt: undefined,
    }))!;
    scheduleStore.removeAuthoritativeTaskProjection(params.id, APP);
    expect(scheduler.addTask(params)).toEqual(current);
    expect(scheduleStore.getTask(params.id, APP)).toEqual(current);
    expect(() => scheduler.addTask({ ...params, prompt: 'different' }))
      .toThrow('schedule_task_id_conflict');
    expect(scheduleStore.getTask(params.id, APP)).toEqual(current);
  });

  it('retains the committed authority receipt when projection fails and repairs it on retry', () => {
    const input = { ...params, id: 'direct02' };
    const projection = vi.spyOn(scheduleStore, 'projectAuthoritativeTask')
      .mockImplementationOnce(() => { throw new Error('disk full'); });
    const created = scheduler.addTask(input);
    expect(store.getRecord(APP, input.id)?.task).toEqual(created);
    expect(scheduleStore.getTask(input.id, APP)).toBeUndefined();
    projection.mockRestore();
    expect(scheduler.addTask(input)).toEqual(created);
    expect(scheduleStore.getTask(input.id, APP)).toEqual(created);
  });

  it('rolls back authority if projection and precondition activation both fail', () => {
    vi.spyOn(scheduleStore, 'projectAuthoritativeTask')
      .mockImplementation(() => { throw new Error('projection write failed'); });
    const activate = vi.spyOn(preconditionStore, 'activateSchedulePrecondition')
      .mockImplementation(() => { throw new Error('activation write failed'); });
    expect(() => createTaskWithOptionalPrecondition(params, APP, 'echo 1'))
      .toThrow('activation write failed');
    const task = activate.mock.calls[0][0];
    expect(store.getRecord(APP, task.id)).toBeUndefined();
    expect(store.listTasks(APP)).toEqual([]);
    expect(scheduleStore.getTask(task.id, APP)).toBeUndefined();
  });

  it('does not roll back a task belonging to a different staged precondition', () => {
    const task = scheduler.addTask({ ...params, preconditionRef: 'spc_original' });
    expect(scheduler.rollbackUnpublishedRuntimeTask(task.id, APP, 'spc_other')).toBe(false);
    expect(store.getRecord(APP, task.id)?.task).toEqual(task);
  });

  it('ignores projection edits to enabled and nextRunAt', () => {
    const result = commit();
    expect(result.ok).toBe(true);
    const protectedNext = scheduler.getNextRun('a1b2c3d4')?.toISOString();
    scheduleStore.updateTask('a1b2c3d4', {
      enabled: false, disabledReason: 'manual', nextRunAt: '2000-01-01T00:00:00.000Z',
    });
    expect(scheduler.getNextRun('a1b2c3d4')?.toISOString()).toBe(protectedNext);
    expect(store.getRecord(APP, 'a1b2c3d4')).toMatchObject({ state: 'active', task: { enabled: true } });
  });

  it('does not admit a copied id and a revoked id cannot be restored from JSON', () => {
    expect(commit().ok).toBe(true);
    const projected = scheduleStore.getTask('a1b2c3d4')!;
    scheduleStore.projectAuthoritativeTask({ ...projected, id: 'deadbeef' }, APP);
    expect(scheduler.getNextRun('deadbeef')).toBeNull();

    expect(scheduler.removeTask('a1b2c3d4')).toBe(true);
    scheduleStore.projectAuthoritativeTask(projected, APP);
    expect(scheduler.getNextRun('a1b2c3d4')).toBeNull();
    expect(store.getRecord(APP, 'a1b2c3d4')?.state).toBe('revoked');
  });

  it('fails closed without reading or mutating the JSON projection when authority bootstrap fails', () => {
    scheduleStore.projectAuthoritativeTask({
      id: 'projection-only', name: 'forged', schedule: 'every 30m',
      parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
      prompt: 'forged', workingDir: '/repo', chatId: 'oc_chat', larkAppId: APP,
      enabled: true, createdAt: '2026-09-28T00:00:00.000Z',
      nextRunAt: '2026-09-28T00:30:00.000Z',
    }, APP);
    scheduler.setScheduleAuthorityUnavailable(new Error('corrupt authority row'));
    expect(scheduler.getNextRun('projection-only')).toBeNull();
    expect(scheduler.removeTask('projection-only')).toBe(false);
    expect(() => scheduler.updateRuntimeTaskState('projection-only', { enabled: false }, APP))
      .toThrow('schedule_authority_store_unavailable');
    expect(() => scheduler.addTask({
      name: 'new', schedule: 'every 30m', prompt: 'new', workingDir: '/repo',
      chatId: 'oc_chat', larkAppId: APP,
    })).toThrow('schedule_authority_store_unavailable');
  });
});
