import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { FeedbackAnalyticsService } from '../src/services/feedback-analytics.js';
import { feedbackPostgresPool } from '../src/services/feedback-postgres-schema.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { once } from 'node:events';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { openPostgresFeedbackStore } from '../src/services/feedback-postgres-store.js';
import { openPostgresFeedbackAnalytics } from '../src/services/feedback-postgres-analytics.js';
import type { PostgresTarget, FeedbackStore } from '../src/services/feedback-storage-types.js';

const connectionString = process.env.BOTMUX_TEST_POSTGRES_URL;
const admin = connectionString ? new Pool({ connectionString }) : undefined;
const schemas: string[] = [];
const stores: FeedbackStore[] = [];
afterAll(async () => { await admin?.end(); });
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const schema of schemas.splice(0)) await admin!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
});
async function fixture() {
  if (!connectionString) throw new Error('BOTMUX_TEST_POSTGRES_URL_required');
  const url = new URL(connectionString);
  const schema = `feedback_${randomUUID().replaceAll('-', '')}`;
  schemas.push(schema);
  const target: PostgresTarget = {
    host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1),
    user: decodeURIComponent(url.username), schema, passwordRef: 'env:UNUSED',
    tls: { mode: 'disable' }, connectTimeoutMs: 3000,
  };
  const password = decodeURIComponent(url.password);
  const instanceId = randomUUID();
  const store = await openPostgresFeedbackStore(target, password, instanceId, undefined, true);
  stores.push(store);
  return { target, password, instanceId, store };
}

describe('PostgreSQL feedback integration', () => {
  it('connects to the PostgreSQL major version selected by the test environment', async () => {
    if (!admin) throw new Error('BOTMUX_TEST_POSTGRES_URL_required');
    const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
    const major = Math.floor(version / 10000);
    const expected = process.env.BOTMUX_TEST_POSTGRES_MAJOR;
    if (expected) expect(major).toBe(Number(expected));
    else expect(major).toBeGreaterThanOrEqual(15);
  });
  it('survives an idle disconnect in a child without leaking the password to stderr', async () => {
    const child = spawnTsScript('test/helpers/feedback-pg-idle-child.ts', [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = '';
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    try {
      const [ready] = await once(child, 'message');
      await admin!.query('SELECT pg_terminate_backend($1)', [ready.backend]);
      const result = once(child, 'message');
      child.send('reconnect');
      expect((await result)[0]).toEqual({ recovered: true });
      expect(errors).not.toContain('synthetic-idle-secret');
    } finally { child.kill(); }
  });
  it('does not provision an empty replacement when an active schema disappears', async () => {
    const { store, target, password, instanceId } = await fixture();
    await store.createResponse({ interactionId: 'retain', content: 'retain' });
    await admin!.query(`DROP SCHEMA "${target.schema}" CASCADE`);
    await expect(openPostgresFeedbackStore(target, password, instanceId)).rejects.toThrow('feedback_storage_schema_missing');
  });
  it('handles idle PostgreSQL errors without exposing credentials and reconnects', async () => {
    const { target, password } = await fixture();
    const pool = feedbackPostgresPool(target, password);
    try {
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
      const client = await pool.connect();
      const backend = (await client.query('SELECT pg_backend_pid() id')).rows[0].id;
      client.release();
      await admin!.query('SELECT pg_terminate_backend($1)', [backend]);
      await new Promise(resolve => setTimeout(resolve, 80));
      expect((await pool.query('SELECT 42 value')).rows[0].value).toBe(42);
    } finally { await pool.end(); }
  });
  it('matches SQLite analytics for the same delivery and multi-user revision cohort', async () => {
    const { store, target, password } = await fixture();
    const directory = await mkdtemp(join(tmpdir(), 'pg-parity-'));
    const sqlite = await SkillFeedbackStore.open(directory);
    const pgAnalytics = await openPostgresFeedbackAnalytics(target, password);
    const sqliteAnalytics = new FeedbackAnalyticsService(directory);
    try {
      for (const backend of [sqlite, store]) {
        await backend.recordTurnDelivery({
          botAppId: 'app', sessionId: 'session', turnId: 'turn', platform: 'lark', platformAppId: 'app',
          platformMessageId: 'message', content: 'answer', cardMode: 'card', status: 'delivered',
          createdAt: '2026-11-01T12:00:00.000Z', chatId: 'chat', model: 'model', context: { teamId: 'team' },
        });
        const input = { platform: 'lark', platformAppId: 'app', platformMessageId: 'message', operatorSubjectId: 'first', callbackKey: 'first', result: 'helpful', semantic: 'positive' as const };
        await backend.recordFeedback(input);
        await backend.recordFeedback({ ...input, callbackKey: 'revised', result: 'incorrect', semantic: 'negative', reasonKey: 'wrong' });
        await backend.recordFeedback({ ...input, callbackKey: 'second', operatorSubjectId: 'second' });
      }
      for (const filters of [
        { from: '2026-11-01', to: '2026-11-03' },
        { from: '2026-11-01', to: '2026-11-03', teamId: 'team', chatId: 'chat', model: 'model' },
        { from: '2026-11-01', to: '2026-11-03', semantic: 'negative', reasonKey: 'wrong' },
        { from: '2026-11-01', to: '2026-11-03', botAppId: 'missing' },
      ]) {
        expect(await pgAnalytics.summary(filters)).toEqual(sqliteAnalytics.summary(filters));
        expect(await pgAnalytics.trend(filters)).toEqual(sqliteAnalytics.trend(filters));
        expect(await pgAnalytics.reasons(filters)).toEqual(sqliteAnalytics.reasons(filters));
        const postgresPage = await pgAnalytics.deliveries(filters);
        const sqlitePage = sqliteAnalytics.deliveries(filters);
        const order = (left: { semantic?: string }, right: { semantic?: string }) => (left.semantic ?? '').localeCompare(right.semantic ?? '');
        expect({ ...postgresPage, items: postgresPage.items.sort(order) }).toEqual({ ...sqlitePage, items: sqlitePage.items.sort(order) });
      }
    } finally {
      await pgAnalytics.close(); sqliteAnalytics.close(); sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('verifies TLS and accepts only the configured certificate authority', async () => {
    const { target, password, instanceId } = await fixture();
    const secured = { ...target, tls: { mode: 'verify-full' as const } };
    await expect(openPostgresFeedbackStore(secured, password, instanceId)).rejects.toThrow();
    const caPath = process.env.BOTMUX_TEST_POSTGRES_CA;
    if (!caPath) throw new Error('BOTMUX_TEST_POSTGRES_CA_required');
    const trusted = await openPostgresFeedbackStore(secured, password, instanceId, await readFile(caPath, 'utf8'));
    stores.push(trusted);
    const response = await trusted.createResponse({ interactionId: 'tls', content: 'secured' });
    expect(await trusted.getResponse(response.responseId)).toMatchObject({ interactionId: 'tls' });
  });
  it('rejects a different instance and stale cards without adding a revision', async () => {
    const { store, target, password } = await fixture();
    await expect(openPostgresFeedbackStore(target, password, randomUUID())).rejects.toThrow('feedback_storage_target_identity_conflict');
    const response = await store.createResponse({ interactionId: 'one', content: 'answer' });
    const delivery = await store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app', platformMessageId: 'message' });
    const input = { platform: 'lark', platformAppId: 'app', platformMessageId: 'message', operatorSubjectId: 'first', result: 'helpful', callbackKey: 'first' };
    const first = await store.recordFeedback({ ...input, expectedFeedbackId: null });
    const second = await store.recordFeedback({ ...input, operatorSubjectId: 'second', callbackKey: 'second', expectedFeedbackId: first.feedback.feedbackId });
    const stale = await store.recordFeedback({ ...input, callbackKey: 'stale', expectedFeedbackId: first.feedback.feedbackId, result: 'incorrect' });
    expect(stale).toMatchObject({ status: 'stale', feedback: { feedbackId: second.feedback.feedbackId } });
    expect(await store.listFeedbackRevisions(delivery.deliveryId, 'first')).toHaveLength(1);
    await expect(store.recordFeedback({ ...input, operatorSubjectId: 'other' })).rejects.toThrow('feedback_callback_key_conflict');
  });
  it('rolls back feedback and event together when the outbox destination is invalid', async () => {
    const { store } = await fixture();
    const response = await store.createResponse({ interactionId: 'one', content: 'answer' });
    const delivery = await store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app', platformMessageId: 'message' });
    await expect(store.recordFeedback({
      platform: 'lark', platformAppId: 'app', platformMessageId: 'message', operatorSubjectId: 'user', result: 'helpful', callbackKey: 'invalid',
      webhookDestinations: [{ id: 'bad', enabled: true, eventTypes: ['feedback.revised'], url: 'https://example.com', secretRef: 'secret', timeoutMs: 1000 }, { id: null, enabled: true, eventTypes: ['feedback.revised'] }] as any,
    })).rejects.toThrow();
    expect(await store.listFeedbackRevisions(delivery.deliveryId, 'user')).toEqual([]);
    expect(await store.listFeedbackEvents()).toEqual([]);
  });
  it('deduplicates concurrent responses and feedback, preserves revisions and statistics', async () => {
    const { target, password, instanceId, store } = await fixture();
    const other = await openPostgresFeedbackStore(target, password, instanceId);
    stores.push(other);
    const responses = await Promise.all([store, other].map(connection => connection.createResponse({ interactionId: 'interaction', content: 'answer' })));
    expect(responses[0].responseId).toBe(responses[1].responseId);
    const delivery = await store.createDelivery({
      responseId: responses[0].responseId, platform: 'lark', platformAppId: 'app', platformMessageId: 'message',
    });
    const feedback = { platform: 'lark', platformAppId: 'app', platformMessageId: 'message', operatorSubjectId: 'user', result: 'helpful', semantic: 'positive' as const, callbackKey: 'callback' };
    const attempts = await Promise.all([store.recordFeedback(feedback), other.recordFeedback(feedback)]);
    expect(attempts.map(attempt => attempt.status).sort()).toEqual(['accepted', 'duplicate']);
    expect(await store.listFeedbackRevisions(delivery.deliveryId, 'user')).toHaveLength(1);
    await other.recordFeedback({ ...feedback, callbackKey: 'revision', result: 'incorrect', semantic: 'negative' });
    expect(await store.getLatestFeedback(delivery.deliveryId, 'user')).toMatchObject({ revision: 2, result: 'incorrect' });
    const analytics = await openPostgresFeedbackAnalytics(target, password);
    try {
      const now = Date.now();
      expect(await analytics.summary({ from: new Date(now - 86400000).toISOString(), to: new Date(now + 86400000).toISOString() }))
        .toMatchObject({ delivered: 1, ratings: 1, negative: 1, positive: 0 });
    } finally { await analytics.close(); }
  });
  it('correlates terminal before delivery and fences stale outbox claims', async () => {
    const { store } = await fixture();
    await store.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed' });
    const delivery = await store.recordTurnDelivery({
      botAppId: 'app', sessionId: 'session', turnId: 'turn', platform: 'lark',
      platformAppId: 'app', platformMessageId: 'message', content: 'answer', cardMode: 'card', status: 'delivered',
      webhookDestinations: [{ id: 'test', url: 'https://example.com/webhook', secretRef: 'secret', enabled: true, eventTypes: ['turn.completed'], timeoutMs: 1000 }],
    });
    expect(delivery.status).toBe('completed');
    expect(await store.listTurnCompletionEvents()).toHaveLength(1);
    const rows = await store.claimFeedbackOutbox({ now: Date.now() + 1000, limit: 10, claimToken: 'first' });
    expect(rows).toHaveLength(1);
    expect(await store.settleFeedbackOutboxDelivered(rows[0].outboxId, 'wrong', 200, new Date().toISOString())).toBe(false);
    expect(await store.settleFeedbackOutboxDelivered(rows[0].outboxId, 'first', 200, new Date().toISOString())).toBe(true);
  });
});
