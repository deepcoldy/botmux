import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { readFeedbackStorageConfig, saveFeedbackStorageCandidate } from '../src/services/feedback-storage-config.js';
import { startFeedbackMigration, resumeFeedbackMigration, prepareFeedbackMigration, cancelFeedbackMigration } from '../src/services/feedback-migration.js';
import { closeFeedbackStorage, getFeedbackStorage } from '../src/services/feedback-storage.js';
import { restoreFeedbackSource, assertFeedbackAdmission, writeFeedbackParticipant } from '../src/services/feedback-maintenance.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { once } from 'node:events';
import { openDatabaseSync } from '../src/services/sqlite-compat.js';

describe('SQLite to PostgreSQL migration', () => {
  it.each(['normal', 'restored-source', 'crash-import', 'crash-retire', 'cancel-import', 'cancel-retire', 'cancel-draining'])('preserves source continuity and resumes safely: %s', async scenario => {
    const address = process.env.BOTMUX_TEST_POSTGRES_URL;
    if (!address) throw new Error('BOTMUX_TEST_POSTGRES_URL_required');
    const url = new URL(address);
    const schema = `migration_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(join(tmpdir(), 'feedback-migration-'));
    const source = await SkillFeedbackStore.open(directory);
    const admin = new Pool({ connectionString: address });
    try {
      const response = source.createResponse({ interactionId: 'original', content: '原始答案' });
      const delivery = source.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app', platformMessageId: 'message' });
      source.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'message', operatorSubjectId: 'user', result: 'helpful', callbackKey: 'first' });
      source.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'message', operatorSubjectId: 'user', result: 'incorrect', callbackKey: 'second' });
      const seed = await openDatabaseSync(join(directory, 'botmux-feedback.sqlite'));
      seed.prepare('INSERT INTO skill_runs(skill_run_id,interaction_id,skill_ref,context_json,created_at) VALUES(?,?,?,?,?)')
        .run('skill-run', 'original', 'review', '{"unicode":"你好"}', '2026-11-01T00:00:00.000Z');
      seed.close();
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'completed-turn', status: 'completed' });
      source.recordTurnDelivery({
        botAppId: 'app', sessionId: 'session', turnId: 'completed-turn', platform: 'lark',
        platformAppId: 'app', platformMessageId: 'completed-message', content: 'completed answer',
        cardMode: 'card', status: 'delivered', usage: { inputTokens: 2 },
        webhookDestinations: [{ id: 'pending', enabled: true, url: 'https://example.com/hook', secretRef: 'secret-reference', eventTypes: ['turn.completed'] }],
      });
      const before = source.listFeedbackRevisions(delivery.deliveryId, 'user');
      const sourceEvents = source.readFeedbackEventsAfter({ after: 0, limit: 100 });
      process.env.BOTMUX_MIGRATION_TEST_PASSWORD = decodeURIComponent(url.password) || 'unused';
      const config = await readFeedbackStorageConfig(directory);
      const candidate = await saveFeedbackStorageCandidate(directory, config.generation, {
        backend: 'postgresql',
        postgres: {
          host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username),
          database: url.pathname.slice(1), schema, passwordRef: 'env:BOTMUX_MIGRATION_TEST_PASSWORD',
          tls: { mode: 'disable' }, connectTimeoutMs: 3000,
        },
      });
      const prepared = await prepareFeedbackMigration(directory, { requestId: 'migration-test', expectedGeneration: candidate.generation, maintenanceConfirmed: true });
      expect(await prepareFeedbackMigration(directory, { requestId: 'migration-test', expectedGeneration: candidate.generation, maintenanceConfirmed: true })).toEqual(prepared);
      if (scenario === 'restored-source') {
        const original = Client.prototype.query;
        let injected = false;
        Client.prototype.query = function (...args: any[]) {
          if (!injected && typeof args[0] === 'string' && args[0].startsWith('INSERT INTO interactions(')) {
            injected = true;
            return Promise.reject(new Error('test_import_interrupted'));
          }
          return (original as any).apply(this, args);
        } as any;
        try {
          expect((await resumeFeedbackMigration(directory, prepared.migrationId)).phase).toBe('blocked');
        } finally { Client.prototype.query = original; }
        await restoreFeedbackSource(directory, prepared.migrationId);
        const later = source.createResponse({ interactionId: 'after-restore', content: 'must retain' });
        const resumed = await resumeFeedbackMigration(directory, prepared.migrationId);
        expect(resumed).toMatchObject({ phase: 'blocked', blockers: ['feedback_migration_source_restored'] });
        expect((await readFeedbackStorageConfig(directory)).active.backend).toBe('sqlite');
        expect(source.getResponse(later.responseId)).toHaveProperty('responseId', later.responseId);
        return;
      }
      if (scenario.startsWith('crash-') || scenario.startsWith('cancel-')) {
        if (scenario === 'cancel-draining') writeFeedbackParticipant(directory, { generation: candidate.generation, ready: false, blockers: ['active-test-turn'] });
        const boundary = scenario.endsWith('import') ? 'import' : scenario.endsWith('draining') ? 'draining' : 'retire';
        const child = spawnTsScript('test/helpers/feedback-migration-crash-child.ts', [directory, prepared.migrationId, boundary], { stdio: ['ignore', 'ignore', 'pipe'] });
        const [, signal] = await once(child, 'exit');
        expect(signal).toBe('SIGKILL');
        if (scenario.startsWith('cancel-')) {
          const decision = { confirmed: true as const, actor: 'test-admin', reason: 'Recover interrupted migration', evidence: 'test:verified-target' };
          if (scenario === 'cancel-retire') {
            await expect(cancelFeedbackMigration(directory, prepared.migrationId, decision)).rejects.toThrow('feedback_source_retired');
          } else {
            const cancelled = await cancelFeedbackMigration(directory, prepared.migrationId, decision);
            expect(cancelled.phase).toBe('cancelled');
            expect(() => assertFeedbackAdmission(directory)).not.toThrow();
            expect(source.createResponse({ interactionId: 'after-cancel', content: 'retained' })).toHaveProperty('responseId');
            expect((await resumeFeedbackMigration(directory, prepared.migrationId)).phase).toBe('cancelled');
            const rows = (await admin.query(`SELECT COUNT(*) count FROM "${schema}".responses`)).rows[0];
            expect(Number(rows.count)).toBe(scenario === 'cancel-import' ? 2 : 0);
            return;
          }
        }
      }
      const result = await startFeedbackMigration(directory, { requestId: 'migration-test', expectedGeneration: candidate.generation, maintenanceConfirmed: true });
      expect(result.phase, JSON.stringify(result.blockers)).toBe('complete');
      expect((await readFeedbackStorageConfig(directory)).active.backend).toBe('postgresql');
      const target = await getFeedbackStorage(directory);
      expect(await target.store.listFeedbackRevisions(delivery.deliveryId, 'user')).toEqual(before);
      expect(await target.store.getResponse(response.responseId)).toMatchObject({ responseId: response.responseId });
      expect(await target.store.listTurnCompletionEvents()).toHaveLength(1);
      expect(await target.store.listFeedbackOutbox()).toMatchObject([{ status: 'pending' }]);
      const migratedEvents = await target.store.readFeedbackEventsAfter({ after: 0, limit: 100 });
      expect(migratedEvents.map(item => item.event.eventId).sort()).toEqual(sourceEvents.map(item => item.event.eventId).sort());
      expect((await resumeFeedbackMigration(directory, result.migrationId)).phase).toBe('complete');
      const jobPath = join(directory, 'feedback-migrations', `${result.migrationId}.json`);
      const saved = JSON.parse(await readFile(jobPath, 'utf8'));
      await writeFile(jobPath, JSON.stringify({ ...saved, phase: 'activating' }));
      expect((await resumeFeedbackMigration(directory, result.migrationId)).phase).toBe('complete');
      expect(await target.store.listFeedbackRevisions(delivery.deliveryId, 'user')).toEqual(before);
      expect(() => source.createResponse({ interactionId: 'late', content: 'late' })).toThrow('feedback_source_frozen');
    } finally {
      source.close();
      await closeFeedbackStorage(directory);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
      delete process.env.BOTMUX_MIGRATION_TEST_PASSWORD;
    }
  });
});
