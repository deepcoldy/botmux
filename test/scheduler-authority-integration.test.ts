import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as scheduler from '../src/core/scheduler.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import * as scheduleStore from '../src/services/schedule-store.js';

const APP = 'cli_authority';
let dataDir: string;
let store: ScheduleAuthorityStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'scheduler-authority-'));
  config.session.dataDir = dataDir;
  scheduleStore.setScheduleScope(APP);
  store = ScheduleAuthorityStore.open(dataDir);
  store.initializeApp(APP, []);
  scheduler.setScheduleAuthorityStore(store);
  scheduler.setOwnerFilter(APP, true);
});

afterEach(() => {
  scheduler.stopScheduler();
  scheduler.setScheduleAuthorityStore(null);
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function commit(id = 'a1b2c3d4') {
  return scheduler.commitDelegatedTask({
    params: {
      id, name: 'poll', schedule: 'every 30m', prompt: 'check', workingDir: '/repo',
      chatId: 'oc_chat', executionPosition: 'top-level', larkAppId: APP,
    },
    grantId: `grant-${id}`, requestHash: `hash-${id}`,
    control: { openId: 'ou_user', unionId: 'on_user', runScopes: [] },
    sourceMessageId: 'om_kickoff', sourceSessionId: 'source-session',
    targetTurnId: 'om_kickoff', targetGeneration: 1,
  });
}

describe('scheduler host authority integration', () => {
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
});
