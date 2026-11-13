import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { readFeedbackStorageConfig, saveFeedbackStorageCandidate } from '../src/services/feedback-storage-config.js';
import { openDatabaseSync } from '../src/services/sqlite-compat.js';
import { openPostgresFeedbackStore } from '../src/services/feedback-postgres-store.js';
import { feedbackSupabaseSchemaSql } from '../src/services/feedback-supabase-schema.js';
import type { PostgresTarget } from '../src/services/feedback-storage-types.js';
import { webhookRecoveryFingerprint } from '../src/services/feedback-recovery.js';

type Row = Record<string, unknown>;

function rpcBoundary(mode: 'normal' | 'import-committed' | 'import-uncommitted' | 'corrupt' | 'activate-committed', instanceId: string) {
  const allowed = ['interactions', 'skill_runs', 'responses', 'deliveries', 'feedback_revisions', 'turn_terminals',
    'turn_completion_events', 'feedback_events', 'feedback_outbox', 'feedback_event_stream', 'feedback_event_stream_counter'];
  const tables = new Map<string, Row[]>([['feedback_event_stream_counter', [{ singleton: 1, value: 0 }]]]);
  let meta: Row = { singleton: 1, version: 1, state: 'empty', instance_id: instanceId, migration_id: null, source_fingerprint: null, verified: 0 };
  let interrupted = false;
  let imports = 0;
  const transport: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (Object.keys(body).sort().join(',') !== 'p_args,p_instance_id,p_operation') throw new Error('invalid RPC wire contract');
    if (body.p_instance_id !== instanceId) throw new Error('invalid target identity');
    const args = body.p_args;
    let result: unknown;
    switch (body.p_operation) {
      case 'migration_status':
        result = meta;
        break;
      case 'migration_prepare':
        if (args.length !== 2) throw new Error('invalid prepare contract');
        if (meta.state !== 'empty' && (meta.state !== 'migrating' || args[0] !== meta.migration_id || args[1] !== meta.source_fingerprint)) {
          throw new Error('invalid prepare identity');
        }
        tables.delete('feedback_event_stream_counter');
        meta = { ...meta, instance_id: body.p_instance_id, migration_id: args[0], source_fingerprint: args[1], state: 'migrating' };
        result = meta;
        break;
      case 'migration_import': {
        if (args.length !== 3 || args[0] !== meta.migration_id) throw new Error('invalid import contract');
        imports++;
        const [migrationId, table, rows] = args;
        if (!migrationId || !Array.isArray(rows) || !allowed.includes(table) || meta.state !== 'migrating') throw new Error('invalid import rows');
        if (table === 'feedback_event_stream_counter') {
          tables.set(table, rows);
        } else {
          if (mode === 'import-uncommitted' && !interrupted) {
            interrupted = true;
            throw new Error('external transport interrupted');
          }
          tables.set(table, [...(tables.get(table) ?? []), ...rows]);
          if (mode === 'import-committed' && !interrupted) {
            interrupted = true;
            throw new Error('external reply lost');
          }
        }
        result = meta;
        break;
      }
      case 'migration_snapshot': {
        if (args.length !== 4 || args[0] !== meta.migration_id) throw new Error('invalid snapshot contract');
        const [, table, offset, limit] = args;
        let rows = (tables.get(table) ?? []).slice(offset, offset + limit);
        if (mode === 'corrupt' && table === 'responses') rows = rows.map(row => ({ ...row, content_hash: 'changed-content' }));
        result = { rows, meta };
        break;
      }
      case 'migration_activate':
        if (args.length !== 2 || args[0] !== meta.migration_id || args[1] !== meta.source_fingerprint) throw new Error('invalid activate contract');
        meta = { ...meta, state: 'active', verified: 1 };
        if (mode === 'activate-committed' && !interrupted) {
          interrupted = true;
          throw new Error('external activation reply lost');
        }
        result = meta;
        break;
      default:
        throw new Error('unexpected external operation');
    }
    return new Response(JSON.stringify({ version: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { transport, tables, get imports() { return imports; }, get meta() { return meta; } };
}

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const postgresAddress = process.env.BOTMUX_TEST_POSTGRES_URL;
async function postgresFixture(mode: 'normal' | 'import-committed' | 'import-uncommitted' | 'activate-committed' | 'corrupt' = 'normal') {
  const url = new URL(postgresAddress!);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.port === '5432') {
    throw new Error('disposable loopback PostgreSQL required');
  }
  const directory = await mkdtemp(join(tmpdir(), 'supabase-pg-migration-'));
  directories.push(directory);
  const home = join(directory, 'home');
  await mkdir(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const config = await readFeedbackStorageConfig(directory);
  const sourceSchema = `supabase_source_${randomUUID().replaceAll('-', '')}`;
  const targetSchema = `supabase_target_${randomUUID().replaceAll('-', '')}`;
  const sourceTarget: PostgresTarget = {
    host: url.hostname, port: Number(url.port), database: url.pathname.slice(1), user: decodeURIComponent(url.username),
    passwordRef: 'env:BOTMUX_TEST_PG_PASSWORD', schema: sourceSchema, tls: { mode: 'disable' }, connectTimeoutMs: 3000,
  };
  vi.stubEnv('BOTMUX_TEST_PG_PASSWORD', decodeURIComponent(url.password) || 'unused');
  vi.stubEnv('BOTMUX_TEST_SUPABASE_KEY', 'sb_secret_disposable-test-only');
  const source = await openPostgresFeedbackStore(sourceTarget, process.env.BOTMUX_TEST_PG_PASSWORD!, config.instanceId, undefined, true);
  const response = await source.createResponse({ interactionId: 'pg-original', content: 'PostgreSQL原答案' });
  await source.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app', platformMessageId: 'pg-message' });
  await source.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'pg-message', operatorSubjectId: 'user', result: 'helpful', callbackKey: 'pg-first' });
  await source.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'pg-message', operatorSubjectId: 'user', result: 'incorrect', callbackKey: 'pg-second' });
  const events = await source.readFeedbackEventsAfter({ after: 0, limit: 100 });
  await source.close();
  const admin = new Pool({ connectionString: postgresAddress });
  const stale = new Client({ connectionString: postgresAddress });
  await stale.connect();
  await stale.query(`SET search_path TO "${sourceSchema}",pg_catalog`);
  cleanups.push(async () => {
    await stale.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`);
    await admin.end();
  });
  await admin.query(`UPDATE "${sourceSchema}".feedback_storage_meta SET migration_id='previous-sqlite-pg',source_fingerprint='sha256:original',verified=1`);
  await admin.query(`UPDATE "${sourceSchema}".feedback_event_stream_counter SET value=57`);
  await admin.query(feedbackSupabaseSchemaSql(targetSchema, config.instanceId));
  await writeFile(join(directory, 'feedback-storage.json'), JSON.stringify({
    ...config, generation: 9, active: { backend: 'postgresql', postgres: sourceTarget },
    candidate: { backend: 'supabase', supabase: { url: 'https://migration.example.com', schema: targetSchema,
      keyRef: 'env:BOTMUX_TEST_SUPABASE_KEY', requestTimeoutMs: 3000 } },
  }), { mode: 0o600 });
  let interrupted = false;
  let importCount = 0;
  const transport: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (Object.keys(body).sort().join(',') !== 'p_args,p_instance_id,p_operation') throw new Error('RPC wire mismatch');
    if (body.p_operation === 'migration_import') {
      importCount++;
      if (mode === 'import-uncommitted' && !interrupted) { interrupted = true; throw new Error('network lost before commit'); }
    }
    let envelope;
    try {
      envelope = (await admin.query(`SELECT "${targetSchema}".botmux_feedback($1,$2,$3::jsonb) envelope`,
        [body.p_instance_id, body.p_operation, JSON.stringify(body.p_args)])).rows[0].envelope;
    } catch (error) {
      return new Response(JSON.stringify({ code: (error as { code: string }).code, message: (error as Error).message }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    if (((mode === 'import-committed' && body.p_operation === 'migration_import')
      || (mode === 'activate-committed' && body.p_operation === 'migration_activate')) && !interrupted) {
      interrupted = true; throw new Error('committed reply lost');
    }
    if (mode === 'corrupt' && body.p_operation === 'migration_snapshot' && body.p_args[1] === 'responses') {
      envelope.result.rows = envelope.result.rows.map((row: Row) => ({ ...row, content_hash: 'changed-content' }));
    }
    return new Response(JSON.stringify(envelope), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  vi.stubGlobal('fetch', transport);
  const migration = await import('../src/services/feedback-supabase-migration.js');
  const prepared = await migration.prepareSupabaseFeedbackMigration(directory, { requestId: 'pg-to-supabase', expectedGeneration: 9, maintenanceConfirmed: true });
  return { directory, admin, stale, sourceSchema, targetSchema, config, sourceTarget, events, response, migration, prepared,
    get importCount() { return importCount; } };
}

describe.skipIf(!postgresAddress)('PostgreSQL source with actual SQL RPC target', () => {
  it.each(['normal', 'import-committed', 'activate-committed'] as const)('preserves prior identity and resumes exact SQL markers: %s', async mode => {
    const context = await postgresFixture(mode);
    const { directory, admin, stale, sourceSchema, targetSchema, events, response, migration, prepared } = context;
    let result = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    if (mode !== 'normal') {
      expect(result.phase, JSON.stringify(result.blockers)).toBe('blocked');
      await expect(stale.query("INSERT INTO interactions VALUES('stale',NULL,'now')")).rejects.toThrow('feedback_source_frozen');
      result = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    }
    expect(result.phase, JSON.stringify(result.blockers)).toBe('complete');
    const sourceMeta = (await admin.query(`SELECT * FROM "${sourceSchema}".feedback_storage_meta`)).rows[0];
    expect(sourceMeta).toMatchObject({ state: 'retired', migration_id: 'previous-sqlite-pg', source_fingerprint: 'sha256:original' });
    const snapshot = JSON.parse(await readFile(result.snapshotPath!, 'utf8'));
    expect(snapshot.sourceMeta).toMatchObject({ state: 'active', migration_id: 'previous-sqlite-pg', source_fingerprint: 'sha256:original' });
    expect((await admin.query(`SELECT response_id FROM "${targetSchema}".responses`)).rows).toEqual([{ response_id: response.responseId }]);
    expect((await admin.query(`SELECT sequence,event_id FROM "${targetSchema}".feedback_event_stream ORDER BY sequence`)).rows
      .map(row => [Number(row.sequence), row.event_id])).toEqual(events.map(item => [item.sequence, item.event.eventId]));
    expect(Number((await admin.query(`SELECT value FROM "${targetSchema}".feedback_event_stream_counter`)).rows[0].value)).toBe(57);
    await expect(stale.query("INSERT INTO interactions VALUES('after-retire',NULL,'now')")).rejects.toThrow('feedback_source_frozen');
    await expect(stale.query('TRUNCATE feedback_event_stream')).rejects.toThrow('feedback_source_frozen');
    await expect(migration.cancelSupabaseFeedbackMigration(directory, prepared.migrationId, {
      confirmed: true, actor: 'operator', reason: 'too late', evidence: 'test:retired',
    })).rejects.toThrow('feedback_source_retired');
  });

  it('retains unknown chunks and cancels by restoring the original PostgreSQL metadata and write access', async () => {
    const context = await postgresFixture('import-uncommitted');
    const { directory, stale, admin, sourceSchema, migration, prepared } = context;
    const first = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(first.phase, JSON.stringify(first.blockers)).toBe('blocked');
    await expect(stale.query("DELETE FROM feedback_events")).rejects.toThrow('feedback_source_frozen');
    const before = context.importCount;
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).blockers).toEqual(['feedback_supabase_import_outcome_unknown']);
    expect(context.importCount).toBe(before);
    expect((await migration.cancelSupabaseFeedbackMigration(directory, prepared.migrationId, {
      confirmed: true, actor: 'operator', reason: 'retain empty target', evidence: 'test:unknown-chunk',
    })).phase).toBe('cancelled');
    await stale.query("INSERT INTO interactions VALUES('after-cancel',NULL,'now')");
    expect((await admin.query(`SELECT state,migration_id FROM "${sourceSchema}".feedback_storage_meta`)).rows[0])
      .toEqual({ state: 'active', migration_id: 'previous-sqlite-pg' });
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).phase).toBe('cancelled');
    const jobPath = join(directory, 'feedback-supabase-migrations', `${prepared.migrationId}.json`);
    const journal = JSON.parse(await readFile(jobPath, 'utf8'));
    await writeFile(jobPath, JSON.stringify({ ...journal, phase: 'cancelling', snapshotInvalidated: undefined }));
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).phase).toBe('cancelled');
  });

  it('requires the existing exact recovery fingerprint for unknown outbox', async () => {
    const { directory, admin, sourceSchema, config, migration, prepared } = await postgresFixture();
    await admin.query(`INSERT INTO "${sourceSchema}".feedback_outbox
      (outbox_id,event_id,destination_id,destination_json,status,attempts,next_attempt_at,last_error,created_at)
      SELECT 'unknown-outbox',event_id,'test','{}','failed',1,0,'webhook_outcome_unknown:claim','now' FROM "${sourceSchema}".feedback_events LIMIT 1`);
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).blockers).toEqual(['feedback_outbox_unsettled']);
    const row = (await admin.query(`SELECT * FROM "${sourceSchema}".feedback_outbox`)).rows[0];
    const fingerprint = webhookRecoveryFingerprint(config.instanceId, prepared.source, row);
    await mkdir(join(directory, 'feedback-recovery-audit'));
    await writeFile(join(directory, 'feedback-recovery-audit', `${fingerprint}.json`), JSON.stringify({
      action: 'acknowledge', fingerprint, decision: { confirmed: true, actor: 'operator', reason: 'checked delivery', evidence: 'test:delivery-readback' },
    }));
    const result = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(result.phase, JSON.stringify(result.blockers)).toBe('complete');
  });

  it('freezes stale repeatable-read clients that established snapshots before maintenance', async () => {
    const { directory, stale, admin, sourceSchema, migration, prepared } = await postgresFixture('import-uncommitted');
    await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await stale.query('SELECT * FROM feedback_storage_meta');
    const result = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(result.phase, JSON.stringify(result.blockers)).toBe('blocked');
    await expect(stale.query("INSERT INTO interactions VALUES('old-snapshot',NULL,'now')")).rejects.toThrow();
    await stale.query('ROLLBACK');
    expect((await admin.query(`SELECT * FROM "${sourceSchema}".interactions WHERE interaction_id='old-snapshot'`)).rows).toEqual([]);
  });

  it('refuses inflight outbox even when an acknowledgment receipt is present', async () => {
    const { directory, admin, sourceSchema, migration, prepared } = await postgresFixture();
    await admin.query(`INSERT INTO "${sourceSchema}".feedback_outbox
      (outbox_id,event_id,destination_id,destination_json,status,attempts,next_attempt_at,claimed_at,claim_token,last_error,created_at)
      SELECT 'inflight-outbox',event_id,'test','{}','inflight',1,0,0,'live-claim','webhook_request_started','now'
      FROM "${sourceSchema}".feedback_events LIMIT 1`);
    const row = (await admin.query(`SELECT * FROM "${sourceSchema}".feedback_outbox`)).rows[0];
    const fingerprint = webhookRecoveryFingerprint(prepared.sourceInstanceId, prepared.source, row);
    await mkdir(join(directory, 'feedback-recovery-audit'));
    await writeFile(join(directory, 'feedback-recovery-audit', `${fingerprint}.json`), JSON.stringify({
      action: 'acknowledge', fingerprint, decision: { confirmed: true, actor: 'operator', reason: 'not proof of drain', evidence: 'test:receipt' },
    }));
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).blockers).toEqual(['feedback_outbox_unsettled']);
    expect((await admin.query(`SELECT state FROM "${sourceSchema}".feedback_storage_meta`)).rows[0]).toEqual({ state: 'active' });
  });

  it('does not replace the original recovery phase when cancellation discovers committed retirement', async () => {
    const { directory, migration, prepared } = await postgresFixture();
    const completed = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(completed.phase).toBe('complete');
    await writeFile(join(directory, 'feedback-storage.json'), JSON.stringify(completed.sourceConfig), { mode: 0o600 });
    const path = join(directory, 'feedback-supabase-migrations', `${prepared.migrationId}.json`);
    await writeFile(path, JSON.stringify({ ...completed, phase: 'blocked', sourceRetired: undefined, pending: { operation: 'retire' } }));
    await expect(migration.cancelSupabaseFeedbackMigration(directory, prepared.migrationId, {
      confirmed: true, actor: 'operator', reason: 'inspect retirement', evidence: 'test:original-marker',
    })).rejects.toThrow();
    expect((await migration.getSupabaseFeedbackMigration(directory, prepared.migrationId)).phase).toBe('blocked');
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).phase).toBe('complete');
  });
});

async function fixture(mode: Parameters<typeof rpcBoundary>[0]) {
  const directory = await mkdtemp(join(tmpdir(), 'supabase-migration-e2e-'));
  directories.push(directory);
  const home = join(directory, 'home');
  await mkdir(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const source = await SkillFeedbackStore.open(directory);
  const response = source.createResponse({ interactionId: 'original', content: '保留原始答案' });
  const delivery = source.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app', platformMessageId: 'message' });
  source.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'message', operatorSubjectId: 'user', result: 'helpful', callbackKey: 'first' });
  source.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'message', operatorSubjectId: 'user', result: 'incorrect', callbackKey: 'second' });
  const revisions = source.listFeedbackRevisions(delivery.deliveryId, 'user');
  const events = source.readFeedbackEventsAfter({ after: 0, limit: 100 });
  source.close();
  const seed = await openDatabaseSync(join(directory, 'botmux-feedback.sqlite'));
  seed.prepare("UPDATE sqlite_sequence SET seq=37 WHERE name='feedback_event_stream'").run();
  seed.close();
  const config = await readFeedbackStorageConfig(directory);
  const candidate = await saveFeedbackStorageCandidate(directory, config.generation, {
    backend: 'supabase', supabase: { url: 'https://migration.example.com', keyRef: 'env:BOTMUX_TEST_SUPABASE_KEY', schema: 'feedback', requestTimeoutMs: 3000 },
  });
  vi.stubEnv('BOTMUX_TEST_SUPABASE_KEY', 'sb_secret_disposable-test-only');
  const boundary = rpcBoundary(mode, candidate.instanceId);
  vi.stubGlobal('fetch', boundary.transport);
  const migration = await import('../src/services/feedback-supabase-migration.js').catch(() => undefined);
  expect(migration?.prepareSupabaseFeedbackMigration).toBeTypeOf('function');
  const prepared = await migration!.prepareSupabaseFeedbackMigration(directory, {
    requestId: 'migration', expectedGeneration: candidate.generation, maintenanceConfirmed: true,
  });
  return { directory, boundary, migration: migration!, prepared, revisions, events, response };
}

describe('SQLite to Supabase with real SDK and disposable source', () => {
  it('preserves revisions, event sequences and the allocation counter before activation', async () => {
    const { directory, boundary, migration, prepared, events, response } = await fixture('normal');
    const result = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(result.phase, JSON.stringify(result.blockers)).toBe('complete');
    expect((await readFeedbackStorageConfig(directory)).active.backend).toBe('supabase');
    expect(boundary.tables.get('responses')).toMatchObject([{ response_id: response.responseId }]);
    expect(boundary.tables.get('feedback_revisions')?.map(row => [row.revision, row.feedback_order])).toEqual([[1, 1], [2, 2]]);
    expect(boundary.tables.get('feedback_event_stream')?.map(row => [row.sequence, row.event_id])).toEqual(events.map(item => [item.sequence, item.event.eventId]));
    expect(boundary.tables.get('feedback_event_stream_counter')).toEqual([{ singleton: 1, value: 37 }]);
    const stale = await openDatabaseSync(join(directory, 'botmux-feedback.sqlite'));
    try {
      expect(() => stale.prepare("INSERT INTO interactions VALUES('late',NULL,'now')").run()).toThrow('feedback_source_frozen');
      expect(() => stale.prepare("DELETE FROM feedback_event_stream").run()).toThrow('feedback_source_frozen');
    } finally { stale.close(); }
    expect((await migration.resumeSupabaseFeedbackMigration(directory, result.migrationId)).phase).toBe('complete');
    await expect(migration.cancelSupabaseFeedbackMigration(directory, result.migrationId, {
      confirmed: true, actor: 'operator', reason: 'too late', evidence: 'test:active',
    })).rejects.toThrow();
  });

  it('reconciles a committed import from target rows rather than resending the unknown chunk', async () => {
    const { directory, boundary, migration, prepared } = await fixture('import-committed');
    const first = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(first.phase).toBe('blocked');
    expect((await readFeedbackStorageConfig(directory)).active.backend).toBe('sqlite');
    const resumed = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(resumed.phase, JSON.stringify(resumed.blockers)).toBe('complete');
    expect(boundary.tables.get('interactions')).toHaveLength(1);
  });

  it('keeps an unproved import unknown and supports evidence-based cancellation without deleting artifacts', async () => {
    const { directory, boundary, migration, prepared } = await fixture('import-uncommitted');
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).phase).toBe('blocked');
    const importedBefore = boundary.imports;
    const second = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(second).toMatchObject({ phase: 'blocked', blockers: ['feedback_supabase_import_outcome_unknown'] });
    expect(boundary.imports).toBe(importedBefore);
    const snapshotBefore = await readFile(second.snapshotPath!);
    const cancelled = await migration.cancelSupabaseFeedbackMigration(directory, prepared.migrationId, {
      confirmed: true, actor: 'operator', reason: 'retain target for inspection', evidence: 'test:uncommitted-readback',
    });
    expect(cancelled).toMatchObject({ phase: 'cancelled', snapshotInvalidated: true });
    expect(await readFile(second.snapshotPath!)).toEqual(snapshotBefore);
    const source = await SkillFeedbackStore.open(directory);
    try { expect(source.createResponse({ interactionId: 'after-cancel', content: 'new answer' })).toHaveProperty('responseId'); }
    finally { source.close(); }
    const jobPath = join(directory, 'feedback-supabase-migrations', `${prepared.migrationId}.json`);
    const journal = JSON.parse(await readFile(jobPath, 'utf8'));
    await writeFile(jobPath, JSON.stringify({ ...journal, phase: 'cancelling', snapshotInvalidated: undefined }));
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).phase).toBe('cancelled');
  });

  it('does not retire the source or activate config when target content verification fails', async () => {
    const { directory, migration, prepared } = await fixture('corrupt');
    const result = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(result.phase).toBe('blocked');
    expect(result.blockers[0]).toContain('feedback_migration_content_mismatch');
    expect((await readFeedbackStorageConfig(directory)).active.backend).toBe('sqlite');
    const source = await openDatabaseSync(join(directory, 'botmux-feedback.sqlite'), { readOnly: true });
    try { expect(source.prepare('SELECT state FROM feedback_source_guard').get()).toEqual({ state: 'frozen' }); }
    finally { source.close(); }
  });

  it('resolves activation reply loss using the original marker and completes the configuration switch', async () => {
    const { directory, boundary, migration, prepared } = await fixture('activate-committed');
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).phase).toBe('blocked');
    expect(boundary.meta.state).toBe('active');
    const resumed = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(resumed.phase, JSON.stringify(resumed.blockers)).toBe('complete');
    const journal = JSON.parse(await readFile(join(directory, 'feedback-supabase-migrations', `${prepared.migrationId}.json`), 'utf8'));
    await writeFile(join(directory, 'feedback-supabase-migrations', `${prepared.migrationId}.json`), JSON.stringify({ ...journal, phase: 'activating' }));
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).phase).toBe('complete');
  });

  it('rejects snapshot content drift without continuing an unknown import', async () => {
    const { directory, boundary, migration, prepared } = await fixture('import-uncommitted');
    const first = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    const snapshot = JSON.parse(await readFile(first.snapshotPath!, 'utf8'));
    snapshot.tables.interactions[0].context_json = '{"changed":true}';
    await writeFile(first.snapshotPath!, JSON.stringify(snapshot));
    const countBefore = boundary.imports;
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).blockers).toEqual(['feedback_snapshot_changed']);
    expect(boundary.imports).toBe(countBefore);
  });

  it('refuses a replacement SQLite source instead of migrating the prior frozen snapshot over it', async () => {
    const { directory, migration, prepared } = await fixture('import-uncommitted');
    expect((await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).phase).toBe('blocked');
    await rename(join(directory, 'botmux-feedback.sqlite'), join(directory, 'original-source.sqlite'));
    const replacement = await SkillFeedbackStore.open(directory);
    try { replacement.createResponse({ interactionId: 'replacement-source', content: 'must not lose' }); }
    finally { replacement.close(); }
    const resumed = await migration.resumeSupabaseFeedbackMigration(directory, prepared.migrationId);
    expect(resumed.blockers).toEqual(['feedback_migration_source_identity_conflict']);
  });
});
