import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import type { ScheduledTask } from '../src/types.js';
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
    // A failed create is a physical DELETE, not a revoke tombstone: the same id
    // can be created again.
    vi.restoreAllMocks();
    const again = scheduler.addTask({ ...params, id: task.id });
    expect(again.id).toBe(task.id);
    expect(store.getRecord(APP, task.id)?.state).toBe('active');
  });

  describe('fire-time workingDir swap check (authority record, turn-created tasks only)', () => {
    const turn = { directTurn: { turnId: 'om_turn', maxTasksPerTurn: 64 } };
    const realDir = (name: string) => {
      const dir = join(dataDir, '..', name);
      mkdirSync(dir, { recursive: true });
      return realpathSync(dir);
    };
    const swap = (dir: string, target: string) => {
      renameSync(dir, `${dir}.moved`);
      symlinkSync(target, dir);
    };

    it('passes an untouched canonical directory and refuses it once swapped for a symlink', () => {
      const dir = realDir('cwd/sub');
      const task = scheduler.addTask({ ...params, id: 'swap0001', workingDir: dir }, turn);
      expect(scheduler.scheduledWorkingDirSwapReason(task)).toBeUndefined();
      swap(dir, realDir('home'));
      expect(scheduler.scheduledWorkingDirSwapReason(task)).toMatch(/^schedule_working_dir_swapped: task swap0001/);
    });

    it('refuses a swapped delegated task too', () => {
      const dir = realDir('deleg/sub');
      const result = scheduler.commitDelegatedTask({
        params: { ...params, id: 'deleg001', workingDir: dir },
        grantId: 'grant-deleg', requestHash: 'hash-deleg',
        control: { openId: 'ou_user', unionId: 'on_user', credentialOpenId: 'ou_user', runScopes: [], selfManage: false },
        sourceMessageId: 'om_kickoff', sourceSessionId: 'source-session',
        targetTurnId: 'om_kickoff', targetGeneration: 1, maxTasksPerTurn: 64,
      });
      expect(result.ok).toBe(true);
      const task = (result as { task: ScheduledTask }).task;
      expect(scheduler.scheduledWorkingDirSwapReason(task)).toBeUndefined();
      swap(dir, realDir('elsewhere'));
      expect(scheduler.scheduledWorkingDirSwapReason(task)).toMatch(/schedule_working_dir_swapped/);
    });

    it('refuses a missing directory and a fire input that disagrees with the authority record', () => {
      const dir = realDir('gone');
      const task = scheduler.addTask({ ...params, id: 'swap0002', workingDir: dir }, turn);
      expect(scheduler.scheduledWorkingDirSwapReason({ ...task, workingDir: realDir('projection') }))
        .toMatch(/fire input/);
      rmSync(dir, { recursive: true });
      expect(scheduler.scheduledWorkingDirSwapReason(task)).toMatch(/\(missing\)/);
    });

    it('never re-checks host-created or legacy tasks, even at a symlinked path', () => {
      const link = join(realDir('host'), 'link');
      symlinkSync(realDir('target'), link);
      const host = scheduler.addTask({ ...params, id: 'host0009', workingDir: link });
      expect(scheduler.scheduledWorkingDirSwapReason(host)).toBeUndefined();
    });
  });

  describe('per-turn direct create limit', () => {
    const turn = (turnId = 'om_turn', maxTasksPerTurn = 2) => ({ directTurn: { turnId, maxTasksPerTurn } });

    it('allows distinct tasks within one turn and records the turn outside the task JSON', () => {
      const a = scheduler.addTask({ ...params, id: 'turn0001' }, turn());
      const b = scheduler.addTask({ ...params, id: 'turn0002' }, turn());
      expect(a.id).not.toBe(b.id);
      expect(store.listTasks(APP).map(t => t.id).sort()).toEqual(['turn0001', 'turn0002']);
      expect(store.getRecord(APP, 'turn0001')?.targetTurnId).toBe('om_turn');
      expect(JSON.stringify(scheduleStore.getTask('turn0001', APP))).not.toContain('om_turn');
    });

    it('refuses the task past the limit, but a different turn and the host stay unaffected', () => {
      scheduler.addTask({ ...params, id: 'turn0001' }, turn());
      scheduler.addTask({ ...params, id: 'turn0002' }, turn());
      expect(() => scheduler.addTask({ ...params, id: 'turn0003' }, turn()))
        .toThrow('schedule_direct_task_limit');
      expect(store.getRecord(APP, 'turn0003')).toBeUndefined();
      expect(scheduleStore.getTask('turn0003', APP)).toBeUndefined();
      expect(scheduler.addTask({ ...params, id: 'turn0004' }, turn('om_other')).id).toBe('turn0004');
      expect(scheduler.addTask({ ...params, id: 'host0001' }).id).toBe('host0001');
      expect(store.getRecord(APP, 'host0001')?.targetTurnId).toBeUndefined();
    });

    it('keeps a removed task on the turn quota', () => {
      scheduler.addTask({ ...params, id: 'turn0001' }, turn());
      scheduler.addTask({ ...params, id: 'turn0002' }, turn());
      expect(scheduler.removeTask('turn0001')).toBe(true);
      expect(store.getRecord(APP, 'turn0001')?.targetTurnId).toBe('om_turn');
      expect(() => scheduler.addTask({ ...params, id: 'turn0003' }, turn()))
        .toThrow('schedule_direct_task_limit');
    });

    it('replays an identical create without consuming quota', () => {
      const first = scheduler.addTask({ ...params, id: 'turn0001' }, turn('om_turn', 1));
      expect(scheduler.addTask({ ...params, id: 'turn0001' }, turn('om_turn', 1))).toEqual(first);
    });
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
