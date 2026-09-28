import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setScheduleAuthorityBeforeCommitTestHook, ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import type { ScheduledTask } from '../src/types.js';

const APP = 'cli_target';
function task(id = 'a1b2c3d4', patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    name: 'poll',
    schedule: 'every 30m',
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
    prompt: 'check status',
    workingDir: '/repo',
    chatId: 'oc_chat',
    scope: 'chat',
    executionPosition: 'top-level',
    larkAppId: APP,
    enabled: true,
    createdAt: '2026-09-28T00:00:00.000Z',
    nextRunAt: '2026-09-28T00:30:00.000Z',
    ...patch,
  };
}

let dataDir: string;
let store: ScheduleAuthorityStore;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'schedule-authority-'));
  store = ScheduleAuthorityStore.open(dataDir);
});
afterEach(() => {
  __setScheduleAuthorityBeforeCommitTestHook(undefined);
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('host-only schedule authority store', () => {
  it('freezes the one-time legacy inventory and never admits later unknown rows', () => {
    store.initializeApp(APP, [task('legacy01', { ownerOpenId: 'ou_old', ownerUnionId: 'on_old' })]);
    store.initializeApp(APP, [task('forged01')]);
    expect(store.getRecord(APP, 'legacy01')).toMatchObject({ kind: 'legacy', state: 'active' });
    expect(store.getRecord(APP, 'forged01')).toBeUndefined();
  });

  it('atomically commits one grant and returns the same receipt after response loss', () => {
    store.initializeApp(APP, []);
    const input = {
      appId: APP,
      grantId: 'dispatch:delivery-1:cli_target',
      requestHash: 'sha256:req1',
      task: task(),
      control: { openId: 'ou_user_target', unionId: 'on_user', runScopes: [] as const },
      sourceMessageId: 'om_kickoff',
      sourceSessionId: 'source-session',
      targetTurnId: 'om_kickoff',
      targetGeneration: 3,
    };
    expect(store.commitDelegated(input)).toMatchObject({ ok: true, replay: false, task: { id: 'a1b2c3d4' } });
    expect(store.commitDelegated(input)).toMatchObject({ ok: true, replay: true, task: { id: 'a1b2c3d4' } });
    expect(store.getRecord(APP, 'a1b2c3d4')).toMatchObject({
      kind: 'delegated', state: 'active', controlOpenId: 'ou_user_target',
      controlUnionId: 'on_user', runScopes: [], targetGeneration: 3,
    });
  });

  it('lets one turn create multiple canonical tasks but rejects a reused task id', () => {
    store.initializeApp(APP, []);
    const base = {
      appId: APP, grantId: 'grant-1', requestHash: 'hash-1', task: task(),
      control: { openId: 'ou_user', unionId: 'on_user', runScopes: [] as const },
      sourceMessageId: 'om_1', sourceSessionId: 's1', targetTurnId: 'om_1', targetGeneration: 1,
    };
    expect(store.commitDelegated(base).ok).toBe(true);
    expect(store.commitDelegated({ ...base, requestHash: 'hash-2', task: task('deadbeef') }))
      .toMatchObject({ ok: true, replay: false, task: { id: 'deadbeef' } });
    expect(store.commitDelegated({ ...base, grantId: 'grant-2', requestHash: 'hash-2' }))
      .toEqual({ ok: false, error: 'task_id_conflict' });
  });

  it('keeps pause, completion and revocation in protected state', () => {
    store.initializeApp(APP, []);
    store.createDirect(task());
    store.updateTask(APP, 'a1b2c3d4', current => ({
      ...current, enabled: false, disabledReason: 'manual', nextRunAt: undefined,
    }));
    expect(store.getRecord(APP, 'a1b2c3d4')).toMatchObject({ state: 'paused', task: { enabled: false } });
    expect(store.revoke(APP, 'a1b2c3d4')).toBe(true);
    expect(store.listTasks(APP)).toEqual([]);
    // Re-running migration after a rollback/copy does not resurrect the id.
    store.initializeApp(APP, [task()]);
    expect(store.getRecord(APP, 'a1b2c3d4')?.state).toBe('revoked');
  });

  it('rolls back every authority row when a crash lands before commit', () => {
    store.initializeApp(APP, []);
    const input = {
      appId: APP, grantId: 'grant-crash', requestHash: 'hash-crash', task: task(),
      control: { openId: 'ou_user', unionId: 'on_user', runScopes: [] as const },
      sourceMessageId: 'om_1', sourceSessionId: 's1', targetTurnId: 'om_1', targetGeneration: 1,
    };
    __setScheduleAuthorityBeforeCommitTestHook(() => { throw new Error('simulated crash'); });
    expect(() => store.commitDelegated(input)).toThrow('simulated crash');
    expect(store.getRecord(APP, 'a1b2c3d4')).toBeUndefined();
    __setScheduleAuthorityBeforeCommitTestHook(undefined);
    expect(store.commitDelegated(input)).toMatchObject({ ok: true, replay: false });
  });
});
