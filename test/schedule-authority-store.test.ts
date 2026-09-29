import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { __setScheduleAuthorityBeforeCommitTestHook, ScheduleAuthorityStore,
  scheduleAuthorityDbPath } from '../src/services/schedule-authority-store.js';
import { computeInputHash } from '../src/utils/canonical-input-hash.js';
import { canonicalScheduleInput } from '../src/services/schedule-store.js';
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
    expect(() => store.initializeApp(APP, [{ id: 'bad' } as ScheduledTask])).not.toThrow();
  });

  it('requires an explicit app for direct authoritative creates', () => {
    store.initializeApp(APP, []);
    expect(() => store.createDirect(task('noapp001', { larkAppId: undefined })))
      .toThrow('schedule_authority_app_required');
  });

  it('atomically commits one grant and returns the same receipt after response loss', () => {
    store.initializeApp(APP, []);
    const input = {
      appId: APP,
      grantId: 'dispatch:delivery-1:cli_target',
      requestHash: 'sha256:req1',
      task: task(),
      control: { openId: 'ou_user_target', unionId: 'on_user', credentialOpenId: 'ou_user_source',
        runScopes: ['bytedcli'] as const, selfManage: true },
      sourceMessageId: 'om_kickoff',
      sourceSessionId: 'source-session',
      targetTurnId: 'om_kickoff',
      targetGeneration: 3,
      maxTasksPerTurn: 64,
    };
    expect(store.commitDelegated(input)).toMatchObject({ ok: true, replay: false, task: { id: 'a1b2c3d4' } });
    expect(store.commitDelegated(input)).toMatchObject({ ok: true, replay: true, task: { id: 'a1b2c3d4' } });
    expect(store.getRecord(APP, 'a1b2c3d4')).toMatchObject({
      kind: 'delegated', state: 'active', controlOpenId: 'ou_user_target',
      controlUnionId: 'on_user', credentialOpenId: 'ou_user_source',
      runScopes: ['bytedcli'], selfManage: true, targetGeneration: 3,
    });
  });

  it('lets one turn create multiple canonical tasks but rejects a reused task id', () => {
    store.initializeApp(APP, []);
    const base = {
      appId: APP, grantId: 'grant-1', requestHash: 'hash-1', task: task(),
      control: { openId: 'ou_user', unionId: 'on_user', runScopes: [] as const },
      sourceMessageId: 'om_1', sourceSessionId: 's1', targetTurnId: 'om_1', targetGeneration: 1,
      maxTasksPerTurn: 64,
    };
    expect(store.commitDelegated(base).ok).toBe(true);
    expect(store.commitDelegated({ ...base, requestHash: 'hash-2', task: task('deadbeef') }))
      .toMatchObject({ ok: true, replay: false, task: { id: 'deadbeef' } });
    expect(store.commitDelegated({ ...base, grantId: 'grant-2', requestHash: 'hash-2' }))
      .toEqual({ ok: false, error: 'task_id_conflict' });
  });

  it('accepts ownerless legacy rows but refuses an explicit app mismatch before the marker', () => {
    const ownerless = task('owner000', { larkAppId: undefined });
    const mismatched = task('wrongapp', { larkAppId: 'cli_other' });
    expect(() => store.initializeApp(APP, [ownerless, mismatched]))
      .toThrow('schedule_authority_app_mismatch');
    expect(store.isInitialized(APP)).toBe(false);
    expect(store.listTasks(APP)).toEqual([]);

    store.initializeApp(APP, [ownerless]);
    expect(store.isInitialized(APP)).toBe(true);
    expect(store.listTasks(APP)).toEqual([ownerless]);
  });

  it('bounds distinct tasks per grant without breaking idempotent receipts', () => {
    store.initializeApp(APP, []);
    const base = {
      appId: APP, grantId: 'grant-bounded', requestHash: 'hash-1', task: task(),
      control: { openId: 'ou_user', unionId: 'on_user', runScopes: [] as const },
      sourceMessageId: 'om_1', sourceSessionId: 's1', targetTurnId: 'om_1', targetGeneration: 1,
      maxTasksPerTurn: 2,
    };
    expect(store.commitDelegated(base)).toMatchObject({ ok: true, replay: false });
    expect(store.commitDelegated({ ...base, requestHash: 'hash-2', task: task('deadbeef') }))
      .toMatchObject({ ok: true, replay: false });
    expect(store.commitDelegated(base)).toMatchObject({ ok: true, replay: true });
    expect(store.commitDelegated({ ...base, requestHash: 'hash-3', task: task('facefeed') }))
      .toEqual({ ok: false, error: 'grant_task_limit' });
  });

  it('rebuilds the legacy UNIQUE(grant_id) table before admitting multiple requests', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'schedule-authority-legacy-'));
    const path = scheduleAuthorityDbPath(legacyDir);
    const legacyDb = new DatabaseSync(path);
    legacyDb.exec(`
      CREATE TABLE schedule_authority_tasks (
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        app_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('legacy','direct','delegated')),
        state TEXT NOT NULL CHECK(state IN ('active','paused','completed','revoked')),
        task_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        control_open_id TEXT,
        control_union_id TEXT,
        run_scopes_json TEXT NOT NULL DEFAULT '[]',
        grant_id TEXT,
        request_hash TEXT,
        source_message_id TEXT,
        source_session_id TEXT,
        target_turn_id TEXT,
        target_generation INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, task_id),
        UNIQUE (grant_id)
      );
    `);
    const preserved = task('legacy01');
    legacyDb.prepare(`
      INSERT INTO schedule_authority_tasks
        (schema_version, app_id, task_id, kind, state, task_json, canonical_hash,
         run_scopes_json, created_at, updated_at)
      VALUES (1, ?, ?, 'legacy', 'active', ?, ?, '[]', ?, ?)
    `).run(
      APP, preserved.id, JSON.stringify(preserved),
      computeInputHash(canonicalScheduleInput(preserved)), preserved.createdAt, preserved.createdAt,
    );
    legacyDb.close();

    let migrated: ScheduleAuthorityStore | undefined;
    try {
      migrated = ScheduleAuthorityStore.open(legacyDir);
      migrated.initializeApp(APP, []);
      expect(migrated.getRecord(APP, preserved.id)).toMatchObject({
        kind: 'legacy', task: { id: preserved.id }, runScopes: [], selfManage: false,
      });
      const base = {
        appId: APP, grantId: 'legacy-grant', requestHash: 'hash-1', task: task(),
        control: { openId: 'ou_user', unionId: 'on_user', credentialOpenId: 'ou_source',
          runScopes: ['bytedcli'] as const, selfManage: true },
        sourceMessageId: 'om_1', sourceSessionId: 's1', targetTurnId: 'om_1', targetGeneration: 1,
        maxTasksPerTurn: 64,
      };
      expect(migrated.commitDelegated(base)).toMatchObject({ ok: true, replay: false });
      expect(migrated.commitDelegated({ ...base, requestHash: 'hash-2', task: task('deadbeef') }))
        .toMatchObject({ ok: true, replay: false });
      expect(migrated.commitDelegated(base)).toMatchObject({ ok: true, replay: true });
      migrated.close(); migrated = undefined;

      const verified = new DatabaseSync(path);
      const schema = verified.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedule_authority_tasks'
      `).get() as { sql: string };
      verified.close();
      expect(schema.sql).toMatch(/PRIMARY KEY\s*\(app_id, task_id\)/i);
      expect(schema.sql).toMatch(/UNIQUE\s*\(grant_id, request_hash\)/i);
      expect(schema.sql).not.toMatch(/UNIQUE\s*\(grant_id\s*\)/i);
    } finally {
      migrated?.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
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
      maxTasksPerTurn: 64,
    };
    __setScheduleAuthorityBeforeCommitTestHook(() => { throw new Error('simulated crash'); });
    expect(() => store.commitDelegated(input)).toThrow('simulated crash');
    expect(store.getRecord(APP, 'a1b2c3d4')).toBeUndefined();
    __setScheduleAuthorityBeforeCommitTestHook(undefined);
    expect(store.commitDelegated(input)).toMatchObject({ ok: true, replay: false });
  });
});
