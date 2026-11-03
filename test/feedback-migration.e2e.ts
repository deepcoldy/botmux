import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { readFeedbackStorageConfig, saveFeedbackStorageCandidate } from '../src/services/feedback-storage-config.js';
import { startFeedbackMigration, resumeFeedbackMigration, prepareFeedbackMigration } from '../src/services/feedback-migration.js';
import { closeFeedbackStorage, getFeedbackStorage } from '../src/services/feedback-storage.js';
import { restoreFeedbackSource } from '../src/services/feedback-maintenance.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { once } from 'node:events';

describe('SQLite to PostgreSQL migration', () => {
  it.each(['normal', 'restored-source', 'crash-import', 'crash-retire'])('preserves source continuity and resumes safely: %s', async scenario => {
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
      const before = source.listFeedbackRevisions(delivery.deliveryId, 'user');
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
      if (scenario.startsWith('crash-')) {
        const child = spawnTsScript('test/helpers/feedback-migration-crash-child.ts', [directory, prepared.migrationId, scenario === 'crash-import' ? 'import' : 'retire'], { stdio: ['ignore', 'ignore', 'pipe'] });
        const [, signal] = await once(child, 'exit');
        expect(signal).toBe('SIGKILL');
      }
      const result = await startFeedbackMigration(directory, { requestId: 'migration-test', expectedGeneration: candidate.generation, maintenanceConfirmed: true });
      expect(result.phase).toBe('complete');
      expect((await readFeedbackStorageConfig(directory)).active.backend).toBe('postgresql');
      const target = await getFeedbackStorage(directory);
      expect(await target.store.listFeedbackRevisions(delivery.deliveryId, 'user')).toEqual(before);
      expect(await target.store.getResponse(response.responseId)).toMatchObject({ responseId: response.responseId });
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
