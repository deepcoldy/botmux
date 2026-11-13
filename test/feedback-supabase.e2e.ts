import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { feedbackSupabaseSchemaSql } from '../src/services/feedback-supabase-schema.js';
import { ensurePostgresFeedbackSchema } from '../src/services/feedback-postgres-schema.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { FEEDBACK_TABLES } from '../src/services/feedback-tables.js';

const binaries = process.env.BOTMUX_TEST_POSTGRES_BIN ?? '/usr/lib/postgresql/15/bin';
const connectionString = process.env.BOTMUX_TEST_POSTGRES_URL;
const available = !!connectionString || (existsSync(join(binaries, 'initdb')) && existsSync(join(binaries, 'pg_ctl')));
let directory: string;
let pool: Pool;
let started = false;
const schemas: string[] = [];

beforeAll(async () => {
  if (!available) return;
  if (connectionString) {
    const url = new URL(connectionString);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.port === '5432') {
      throw new Error('feedback_supabase_tests_require_disposable_loopback_postgres');
    }
    pool = new Pool({ connectionString });
    return;
  }
  directory = await mkdtemp(join(tmpdir(), 'botmux-supabase-pg-'));
  execFileSync(join(binaries, 'initdb'), ['-D', join(directory, 'data'), '-U', 'botmux_test', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { stdio: 'pipe' });
  execFileSync(join(binaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'), '-o', `-k ${directory} -c listen_addresses='' -c fsync=off`, '-w', 'start'], { stdio: 'pipe' });
  started = true;
  pool = new Pool({ host: directory, user: 'botmux_test', database: 'postgres' });
});
afterAll(async () => {
  for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool?.end();
  if (started) execFileSync(join(binaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(active = true) {
  const schema = `feedback_${randomUUID().replaceAll('-', '')}`;
  schemas.push(schema);
  const instanceId = randomUUID();
  await pool.query(feedbackSupabaseSchemaSql(schema, instanceId));
  const call = async (operation: string, args: unknown[] = [], instance = instanceId): Promise<any> => {
    const result = (await pool.query(`SELECT "${schema}".botmux_feedback($1,$2,$3::jsonb) envelope`, [instance, operation, JSON.stringify(args)])).rows[0].envelope;
    expect(result.version).toBe(1);
    return result.result;
  };
  if (active) {
    await call('migration_prepare', ['initial', 'sha256:empty']);
    await call('migration_activate', ['initial', 'sha256:empty']);
  }
  return { schema, instanceId, call };
}

const destination = { id: 'test', enabled: true, url: 'https://example.test/webhook', secretRef: 'env:TEST', eventTypes: ['turn.completed', 'feedback.revised'] };
const turn = {
  botAppId: 'app', sessionId: 'session', turnId: 'turn', platform: 'lark', platformAppId: 'app',
  platformMessageId: 'message', content: 'answer', cardMode: 'card', status: 'delivered',
  createdAt: '2026-11-01T12:00:00.000Z', chatId: 'chat', topicRootId: 'topic', model: 'model',
  webhookDestinations: [destination], context: { teamId: 'team', feedbackSubjectBinding: null },
};
const vote = { platform: 'lark', platformAppId: 'app', platformMessageId: 'message', operatorSubjectId: 'first', callbackKey: 'first', result: 'helpful', semantic: 'positive' };

describe.skipIf(!available)('Supabase SQL RPC on disposable PostgreSQL', () => {
  it('installs exact existing table columns and constraints, with a restricted invoker RPC', async () => {
    const { schema, call } = await fixture();
    const client = await pool.connect();
    const reference = `reference_${randomUUID().replaceAll('-', '')}`;
    schemas.push(reference);
    try {
      await client.query(`SET search_path TO "${reference}",pg_catalog`);
      await ensurePostgresFeedbackSchema(client, reference, randomUUID(), undefined, true);
      for (const table of FEEDBACK_TABLES) {
        const columns = await pool.query(`SELECT table_schema,column_name,data_type,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema=ANY($1) AND table_name=$2 ORDER BY ordinal_position`, [[schema, reference], table]);
        const project = (name: string) => columns.rows.filter(row => row.table_schema === name).map(({ table_schema, ...row }) => row);
        expect(project(schema)).toEqual(project(reference));
        const constraints = await pool.query(`SELECT n.nspname,pg_get_constraintdef(c.oid) definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=ANY($1) AND r.relname=$2 ORDER BY definition`, [[schema, reference], table]);
        const definitions = (name: string) => constraints.rows.filter(row => row.nspname === name).map(row => row.definition.replaceAll(`${name}.`, ''));
        expect(definitions(schema)).toEqual(definitions(reference));
      }
      const metadata = (await pool.query(`SELECT p.prosecdef,p.proconfig,a.grantee FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE n.nspname=$1 AND p.proname='botmux_feedback'`, [schema])).rows;
      expect(metadata[0].prosecdef).toBe(false);
      expect(metadata[0].proconfig).toEqual([`search_path=${schema}, pg_catalog`]);
      expect(metadata.some(row => row.grantee === 0)).toBe(false);
      await expect(call('close')).rejects.toThrow('feedback_supabase_operation_invalid');
      await expect(call('getResponse', ['x'], randomUUID())).rejects.toThrow('feedback_storage_target_identity_conflict');
    } finally { client.release(); }
  });

  it('preserves stable identities, deduplication, card tails and multi-user revision ordering', async () => {
    const { call } = await fixture();
    const responses = await Promise.all([1, 2].map(() => call('createResponse', [{ interactionId: 'one,"\n☃', content: 'answer' }])));
    const contentHash = `sha256:${createHash('sha256').update('answer').digest('hex')}`;
    const responseId = `resp_${createHash('sha256').update(JSON.stringify(['one,"\n☃', contentHash])).digest('hex')}`;
    expect(responses[0]).toMatchObject({ responseId, contentHash, interactionId: 'one,"\n☃' });
    expect(responses[1]).toEqual(responses[0]);
    expect(await call('getResponse', [responseId])).toEqual(responses[0]);
    expect(await call('getResponse', ['missing'])).toBeNull();
    const policy = normalizeFeedbackPolicy({ enabled: true });
    const delivery = await call('createDelivery', [{ responseId, ...vote, policy, baseCard: { body: { elements: [{ element_id: 'answer' }, { element_id: 'botmux_feedback' }, { element_id: 'footer' }] } } }]);
    expect(delivery.baseCard.body.elements).toEqual([{ element_id: 'botmux_feedback' }, { element_id: 'footer' }]);
    expect(delivery.policy).toEqual(policy);
    expect(await call('findDeliveryByPlatformMessage', ['lark', 'app', 'message'])).toEqual(delivery);
    expect(await call('findDeliveryById', [delivery.deliveryId])).toEqual(delivery);
    const first = await call('recordFeedback', [{ ...vote, expectedFeedbackId: null }]);
    const second = await call('recordFeedback', [{ ...vote, operatorSubjectId: 'second', callbackKey: 'second', expectedFeedbackId: first.feedback.feedbackId }]);
    expect(await call('recordFeedback', [vote])).toMatchObject({ status: 'duplicate', feedback: { feedbackId: second.feedback.feedbackId }, feedbackId: second.feedback.feedbackId });
    expect(await call('recordFeedback', [{ ...vote, result: 'wrong', callbackKey: 'stale', expectedFeedbackId: first.feedback.feedbackId }])).toMatchObject({ status: 'stale', feedbackId: second.feedback.feedbackId });
    await expect(call('recordFeedback', [{ ...vote, operatorSubjectId: 'other' }])).rejects.toThrow('feedback_callback_key_conflict');
    const revised = await call('recordFeedback', [{ ...vote, callbackKey: 'revised', result: 'wrong', semantic: 'negative', reasonKey: 'incorrect', comment: 'detail' }]);
    expect(revised).toMatchObject({ status: 'revised', feedback: { revision: 2, supersedesFeedbackId: first.feedback.feedbackId, comment: 'detail' } });
    expect(await call('getLatestFeedback', [delivery.deliveryId, 'first'])).toEqual(revised.feedback);
    expect(await call('listFeedbackRevisions', [delivery.deliveryId, 'first'])).toEqual([first.feedback, revised.feedback]);
  });

  it('reconciles either arrival order and atomically records events and claim-token outbox transitions', async () => {
    const { call } = await fixture();
    expect(await call('recordTurnTerminal', [{ ...turn, status: 'completed', completedAt: '2026-11-01T12:01:00.000Z', durationMs: 0, usage: { tokens: 0 } }])).toBeNull();
    const delivery = await call('recordTurnDelivery', [turn]);
    expect(delivery).toMatchObject({ status: 'completed', durationMs: 0, usage: { tokens: 0 }, context: turn.context });
    const payload = await call('recordTurnTerminal', [{ ...turn, status: 'completed' }]);
    expect(payload).toMatchObject({ deliveryId: delivery.deliveryId, status: 'completed', durationMs: 0 });
    expect(await call('listSubjectDeliveries', ['app', 'chat', 'topic'])).toEqual([delivery]);
    await expect(call('recordTurnTerminal', [{ ...turn, status: 'failed' }])).rejects.toThrow('turn_terminal_status_conflict');
    await expect(call('recordTurnDelivery', [{ ...turn, platformMessageId: 'other' }])).rejects.toThrow('turn_delivery_correlation_rebind');
    await expect(call('recordTurnDelivery', [{ ...turn, turnId: 'other' }])).rejects.toThrow('turn_delivery_platform_message_rebind');
    await call('recordTurnDelivery', [{ ...turn, turnId: 'next', platformMessageId: 'next' }]);
    await call('recordTurnTerminal', [{ ...turn, turnId: 'next', status: 'failed', completedAt: '2026-11-01T12:00:00.000Z' }]);
    expect(await call('listTurnCompletionEvents')).toHaveLength(2);
    const stream = await call('readFeedbackEventsAfter', [{ after: 0, limit: 10 }]);
    expect(stream.map((row: any) => row.sequence)).toEqual([1, 2]);
    expect(stream.map((row: any) => row.event.data.status)).toEqual(['completed', 'failed']);
    await expect(call('readFeedbackEventsAfter', [{ after: 9007199254740992, limit: 1 }])).rejects.toThrow('feedback_event_cursor_invalid');
    const claims = await Promise.all(['first', 'second'].map(claimToken => call('claimFeedbackOutbox', [{ now: Date.now(), limit: 1, claimToken }])));
    expect(new Set(claims.flat().map((row: any) => row.outboxId)).size).toBe(2);
    const row = claims[0][0];
    expect(await call('startFeedbackOutboxRequest', [row.outboxId, 'wrong'])).toBe(false);
    expect(await call('startFeedbackOutboxRequest', [row.outboxId, 'first'])).toBe(true);
    expect(await call('resetExpiredFeedbackOutboxClaims', [Date.now() + 1000, 0])).toBe(2);
    expect(await call('listFeedbackOutbox')).toEqual(expect.arrayContaining([expect.objectContaining({ outboxId: row.outboxId, lastError: 'webhook_outcome_unknown:first' })]));
    const reclaimed = await call('claimFeedbackOutbox', [{ now: Date.now() + 2000, limit: 10, claimToken: 'new' }]);
    expect(await call('settleFeedbackOutboxDelivered', [row.outboxId, 'first', 200, 'now'])).toBe(false);
    expect(await call('rescheduleFeedbackOutbox', [row.outboxId, 'new', { nextAttemptAt: Date.now() + 3000, error: 'retry', permanent: false }])).toBe(true);
    expect((await call('listFeedbackOutbox')).find((item: any) => item.outboxId === row.outboxId).lastError).toBe('webhook_outcome_unknown:first');
    const other = reclaimed.find((item: any) => item.outboxId !== row.outboxId);
    expect(await call('settleFeedbackOutboxDelivered', [other.outboxId, 'new', 204, '2026-11-01'])).toBe(true);
  });

  it('rolls back revisions, stream and outbox together on an invalid destination', async () => {
    const { call } = await fixture();
    const delivery = await call('recordTurnDelivery', [turn]);
    await expect(call('recordFeedback', [{ ...vote, webhookDestinations: [{ ...destination, id: null }] }])).rejects.toThrow();
    expect(await call('listFeedbackRevisions', [delivery.deliveryId, 'first'])).toEqual([]);
    expect(await call('listFeedbackEvents')).toEqual([]);
    expect(await call('readFeedbackEventsAfter', [{ after: 0, limit: 10 }])).toEqual([]);
    expect(await call('listFeedbackOutbox')).toEqual([]);
  });

  it('uses the latest per-user cohort for summary, trend, reasons and cursor pages', async () => {
    const { call } = await fixture();
    await call('recordTurnDelivery', [turn]);
    await call('recordFeedback', [vote]);
    await call('recordFeedback', [{ ...vote, callbackKey: 'revision', result: 'wrong', semantic: 'negative', reasonKey: 'incorrect' }]);
    await call('recordFeedback', [{ ...vote, callbackKey: 'second', operatorSubjectId: 'second' }]);
    const filters = { from: '2026-11-01', to: '2026-11-03', teamId: 'team', botAppId: 'app', chatId: 'chat', topicRootId: 'topic', model: 'model' };
    expect(await call('analytics_summary', [filters])).toEqual({ delivered: 1, ratings: 2, ratedDeliveries: 1, positive: 1, negative: 1, progress: 0, ratingCoverage: 1, positiveRate: 0.5, deliveryFailures: 0, outboxFailures: 0 });
    expect(await call('analytics_trend', [filters])).toEqual([{ bucket: '2026-11-01', positive: 1, negative: 1, progress: 0, ratings: 2 }]);
    expect(await call('analytics_reasons', [filters])).toEqual([{ reasonKey: 'incorrect', count: 1 }]);
    expect((await call('analytics_deliveries', [{ ...filters, semantic: 'negative' }])).items).toMatchObject([{ semantic: 'negative', verdictKey: 'wrong', reasonKey: 'incorrect' }]);
    await call('recordTurnDelivery', [{ ...turn, turnId: 'second', platformMessageId: 'second', createdAt: '2026-11-02T00:00:00.000Z' }]);
    const page = await call('analytics_deliveries', [filters, { limit: 1 }]);
    expect(page.items[0].platformMessageId).toBe('second');
    const cursor = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString());
    expect(cursor).toMatchObject({ createdAt: '2026-11-02T00:00:00.000Z', deliveryId: page.items[0].deliveryId });
    const next = await call('analytics_deliveries', [filters, { limit: 10, cursor: page.nextCursor }]);
    expect(next.items).toHaveLength(2);
    await expect(call('analytics_summary', [{ from: 'invalid', to: '2026-11-03' }])).rejects.toThrow('feedback_analytics_invalid_range');
    await expect(call('analytics_deliveries', [filters, { cursor: 'invalid' }])).rejects.toThrow('feedback_analytics_invalid_cursor');
  });

  it('fences migration identities, imports chunks idempotently and snapshots deterministic rows', async () => {
    const { call } = await fixture(false);
    expect(await call('migration_status')).toMatchObject({ version: 1, state: 'empty', verified: 0 });
    await expect(call('getResponse', ['x'])).rejects.toThrow('feedback_storage_target_not_active');
    await call('migration_prepare', ['migration', 'sha256:test']);
    const rows = [{ interaction_id: 'b', context_json: '{"b":2,"a":1}', created_at: '2026-11-01' }, { interaction_id: 'a', context_json: null, created_at: '2026-11-01' }];
    await call('migration_import', ['migration', 'interactions', rows]);
    await call('migration_import', ['migration', 'interactions', rows]);
    await expect(call('migration_import', ['migration', 'interactions', [{ ...rows[0], created_at: 'different' }]])).rejects.toThrow('feedback_migration_row_conflict');
    await expect(call('migration_import', ['other', 'interactions', []])).rejects.toThrow('feedback_migration_identity_conflict');
    await expect(call('migration_import', ['migration', 'pg_authid', []])).rejects.toThrow('feedback_migration_table_invalid');
    const snapshot = await call('migration_snapshot', ['migration', 'interactions', 0, 1]);
    expect(snapshot).toMatchObject({ rows: [rows[1]], meta: { state: 'migrating', migration_id: 'migration', source_fingerprint: 'sha256:test' } });
    await expect(call('migration_activate', ['migration', 'different'])).rejects.toThrow('feedback_migration_identity_conflict');
    await call('migration_activate', ['migration', 'sha256:test']);
    await call('migration_activate', ['migration', 'sha256:test']);
    expect(await call('migration_status')).toMatchObject({ state: 'active', verified: 1 });
    await expect(call('migration_import', ['migration', 'interactions', []])).rejects.toThrow('feedback_storage_target_not_migrating');
    await expect(call('migration_prepare', ['other', 'sha256:test'])).rejects.toThrow();
  });

  it('preserves imported stream positions and revision order across idempotent installation and activation', async () => {
    const source = await fixture();
    const delivery = await source.call('recordTurnDelivery', [turn]);
    await source.call('recordFeedback', [vote]);
    await source.call('recordFeedback', [{ ...vote, callbackKey: 'second', operatorSubjectId: 'second' }]);
    const target = await fixture(false);
    await target.call('migration_prepare', ['import', 'sha256:source']);
    for (const table of FEEDBACK_TABLES) {
      const rows = (await pool.query(`SELECT * FROM "${source.schema}"."${table}"`)).rows;
      await target.call('migration_import', ['import', table, rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, ['feedback_order', 'duration_ms', 'claimed_at', 'next_attempt_at'].includes(key) && value !== null ? Number(value) : value])))]);
    }
    const originalStream = await source.call('readFeedbackEventsAfter', [{ after: 0, limit: 10 }]);
    const streamRows = originalStream.map((row: any, index: number) => ({ sequence: 7 + index, event_id: row.event.eventId }));
    await target.call('migration_import', ['import', 'feedback_event_stream', streamRows]);
    await target.call('migration_import', ['import', 'feedback_event_stream', streamRows]);
    await target.call('migration_import', ['import', 'feedback_event_stream_counter', [{ singleton: 1, value: 10 }]]);
    await target.call('migration_import', ['import', 'feedback_event_stream_counter', [{ singleton: 1, value: 10 }]]);
    await pool.query(feedbackSupabaseSchemaSql(target.schema, target.instanceId));
    expect(await target.call('migration_status')).toMatchObject({ state: 'migrating' });
    await target.call('migration_activate', ['import', 'sha256:source']);
    await target.call('migration_activate', ['import', 'sha256:source']);
    expect((await target.call('readFeedbackEventsAfter', [{ after: 0, limit: 10 }])).map((row: any) => row.sequence)).toEqual([7, 8]);
    const accepted = await target.call('recordFeedback', [{ ...vote, callbackKey: 'third', operatorSubjectId: 'third', expectedFeedbackId: originalStream[1].event.data.feedbackId }]);
    expect(accepted.status).toBe('accepted');
    expect((await target.call('readFeedbackEventsAfter', [{ after: 8, limit: 10 }]))[0]).toMatchObject({ sequence: 11, event: { data: { deliveryId: delivery.deliveryId } } });
    const snapshot = await target.call('migration_snapshot', ['import', 'feedback_event_stream', 0, 10]);
    expect(snapshot.rows.map((row: any) => row.sequence)).toEqual([7, 8, 11]);
  });

  it('skips uncommitted outbox claims and publishes stream positions in commit order', async () => {
    const { schema, call } = await fixture();
    await call('recordTurnDelivery', [turn]);
    await call('recordTurnTerminal', [{ ...turn, status: 'completed' }]);
    await call('recordFeedback', [vote]);
    const first = await pool.connect();
    const second = await pool.connect();
    const insert = (client: typeof first, eventId: string) => client.query(`INSERT INTO "${schema}".feedback_events VALUES($1,'feedback.revised',1,'external',$2,'2026-11-01')`, [eventId, JSON.stringify({ eventId, type: 'feedback.revised', version: 1, time: '2026-11-01', data: {} })]);
    try {
      await first.query('BEGIN');
      const claimed = (await first.query(`SELECT "${schema}".botmux_feedback($1,'claimFeedbackOutbox',$2::jsonb) envelope`, [(await call('migration_status')).instance_id, JSON.stringify([{ now: Date.now(), limit: 1, claimToken: 'uncommitted' }])])).rows[0].envelope.result;
      const concurrent = await call('claimFeedbackOutbox', [{ now: Date.now(), limit: 10, claimToken: 'other' }]);
      expect(concurrent).toHaveLength(1);
      expect(concurrent[0].outboxId).not.toBe(claimed[0].outboxId);
      await first.query('ROLLBACK');
      await first.query('BEGIN');
      await insert(first, 'earlier');
      await second.query('BEGIN');
      const later = insert(second, 'later');
      expect((await call('readFeedbackEventsAfter', [{ after: 2, limit: 10 }]))).toEqual([]);
      await first.query('COMMIT');
      expect((await call('readFeedbackEventsAfter', [{ after: 2, limit: 10 }])).map((row: any) => row.event.eventId)).toEqual(['earlier']);
      await later;
      await second.query('COMMIT');
      expect((await call('readFeedbackEventsAfter', [{ after: 2, limit: 10 }])).map((row: any) => row.event.eventId)).toEqual(['earlier', 'later']);
      await first.query('BEGIN');
      await insert(first, 'rolled-back');
      await first.query('ROLLBACK');
      expect((await call('readFeedbackEventsAfter', [{ after: 4, limit: 10 }]))).toEqual([]);
    } finally {
      await first.query('ROLLBACK'); await second.query('ROLLBACK');
      first.release(); second.release();
    }
  });

  it('normalizes legacy policy snapshots without preserving unknown input fields', async () => {
    const { call } = await fixture();
    const response = await call('createResponse', [{ interactionId: 'policy', content: 'answer' }]);
    const policy = { enabled: true, audience: 'everyone', buttonAlign: 'left', allowReselect: false, extra: 'ignored', buttons: [
      { key: 'good', label: 'Good', sentiment: 'positive' },
      { key: 'working', label: 'Working', sentiment: 'progress' },
      { key: 'bad', label: 'Bad', sentiment: 'negative' },
    ], negativeFollowup: { comment: { required: true } } };
    const delivery = await call('createDelivery', [{ responseId: response.responseId, ...vote, policy }]);
    expect(delivery.policy).toEqual(normalizeFeedbackPolicy(policy));
  });
});
