import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const directories: string[] = [];
const instanceId = '3b5530dc-c5a8-421e-a236-9963f9934534';
const target = {
  backend: 'supabase',
  supabase: { url: 'https://migration.example.com', keyRef: 'env:BOTMUX_TEST_SUPABASE_KEY', schema: 'feedback', requestTimeoutMs: 3000 },
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'supabase-migration-'));
  directories.push(directory);
  await writeFile(join(directory, 'feedback-storage.json'), JSON.stringify({
    version: 1, generation: 4, instanceId, active: { backend: 'sqlite' }, candidate: target,
  }), { mode: 0o600 });
  return directory;
}

async function service() {
  return import('../src/services/feedback-supabase-migration.js').catch(() => undefined);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('Supabase migration preparation safety', () => {
  it('prevents the legacy PostgreSQL preparer from occupying a Supabase migration slot after configuration drift', async () => {
    const migration = await service();
    const directory = await fixture();
    await migration!.prepareSupabaseFeedbackMigration(directory, {
      requestId: 'supabase-slot', expectedGeneration: 4, maintenanceConfirmed: true,
    });
    const config = JSON.parse(await readFile(join(directory, 'feedback-storage.json'), 'utf8'));
    config.candidate = { backend: 'postgresql', postgres: {
      host: 'localhost', port: 1, user: 'test', database: 'test', schema: 'feedback',
      passwordRef: 'env:UNSET', tls: { mode: 'disable' }, connectTimeoutMs: 100,
    } };
    await writeFile(join(directory, 'feedback-storage.json'), JSON.stringify(config), { mode: 0o600 });
    const { prepareFeedbackMigration } = await import('../src/services/feedback-migration.js');
    await expect(prepareFeedbackMigration(directory, {
      requestId: 'legacy-slot', expectedGeneration: 4, maintenanceConfirmed: true,
    })).rejects.toThrow('feedback_migration_conflict');
  });
  it('persists an idempotent generation-bound request without opening either database', async () => {
    const migration = await service();
    expect(migration?.prepareSupabaseFeedbackMigration).toBeTypeOf('function');
    const directory = await fixture();
    const request = { requestId: 'request-one', expectedGeneration: 4, maintenanceConfirmed: true as const };
    const prepared = await migration!.prepareSupabaseFeedbackMigration(directory, request);
    expect(prepared).toMatchObject({ phase: 'preflight', sourceInstanceId: instanceId, expectedGeneration: 4, target });
    expect(await migration!.prepareSupabaseFeedbackMigration(directory, request)).toEqual(prepared);
    expect(await migration!.listSupabaseFeedbackMigrations(directory)).toEqual([prepared]);
    expect(await migration!.getSupabaseFeedbackMigration(directory, prepared.migrationId)).toEqual(prepared);
    const info = await stat(join(directory, 'feedback-supabase-migrations', `${prepared.migrationId}.json`));
    expect(info.mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'feedback-supabase-migrations'))).mode & 0o777).toBe(0o700);
  });

  it('rejects reusing a request against a changed full configuration', async () => {
    const migration = await service();
    expect(migration?.prepareSupabaseFeedbackMigration).toBeTypeOf('function');
    const directory = await fixture();
    const request = { requestId: 'same', expectedGeneration: 4, maintenanceConfirmed: true as const };
    await migration!.prepareSupabaseFeedbackMigration(directory, request);
    const config = JSON.parse(await readFile(join(directory, 'feedback-storage.json'), 'utf8'));
    config.candidate.supabase.keyRef = 'env:OTHER_KEY';
    await writeFile(join(directory, 'feedback-storage.json'), JSON.stringify(config));
    await expect(migration!.prepareSupabaseFeedbackMigration(directory, request)).rejects.toThrow('feedback_storage_generation_conflict');
  });

  it('blocks distinct SQLite to PostgreSQL work even before maintenance starts', async () => {
    const migration = await service();
    expect(migration?.prepareSupabaseFeedbackMigration).toBeTypeOf('function');
    const directory = await fixture();
    await mkdir(join(directory, 'feedback-migrations'));
    await writeFile(join(directory, 'feedback-migrations', 'legacy.json'), JSON.stringify({
      migrationId: 'legacy', requestId: 'pg-request', phase: 'preflight',
      target: { host: 'localhost' }, blockers: [],
    }));
    await expect(migration!.prepareSupabaseFeedbackMigration(directory, {
      requestId: 'supabase', expectedGeneration: 4, maintenanceConfirmed: true,
    })).rejects.toThrow('feedback_migration_conflict');
  });

  it('refuses a migration journal directory redirected outside the data directory', async () => {
    const migration = await service();
    expect(migration?.prepareSupabaseFeedbackMigration).toBeTypeOf('function');
    const directory = await fixture();
    const other = await fixture();
    await symlink(other, join(directory, 'feedback-supabase-migrations'), 'dir');
    await expect(migration!.prepareSupabaseFeedbackMigration(directory, {
      requestId: randomUUID(), expectedGeneration: 4, maintenanceConfirmed: true,
    })).rejects.toThrow('feedback_migration_directory_invalid');
  });

  it('cancels unstarted work with durable evidence and leaves the original configuration intact', async () => {
    const migration = await service();
    expect(migration?.prepareSupabaseFeedbackMigration).toBeTypeOf('function');
    const directory = await fixture();
    const configBefore = await readFile(join(directory, 'feedback-storage.json'), 'utf8');
    const prepared = await migration!.prepareSupabaseFeedbackMigration(directory, {
      requestId: 'cancel', expectedGeneration: 4, maintenanceConfirmed: true,
    });
    const cancelled = await migration!.cancelSupabaseFeedbackMigration(directory, prepared.migrationId, {
      confirmed: true, actor: 'test operator', reason: 'maintenance withdrawn', evidence: 'test:unstarted',
    });
    expect(cancelled).toMatchObject({ phase: 'cancelled', snapshotInvalidated: true });
    expect(await readFile(join(directory, 'feedback-storage.json'), 'utf8')).toBe(configBefore);
    expect((await migration!.resumeSupabaseFeedbackMigration(directory, prepared.migrationId)).phase).toBe('cancelled');
  });

  it('serializes concurrent requests across the shared legacy migration locks', async () => {
    const migration = await service();
    const directory = await fixture();
    const results = await Promise.allSettled(['first', 'second'].map(requestId => migration!.prepareSupabaseFeedbackMigration(directory, {
      requestId, expectedGeneration: 4, maintenanceConfirmed: true,
    })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: new Error('feedback_migration_conflict') }]);
    expect(await migration!.listSupabaseFeedbackMigrations(directory)).toHaveLength(1);
  });

  it('keeps missing-journal status reads free of filesystem mutations', async () => {
    const migration = await service();
    const directory = await fixture();
    expect(await migration!.listSupabaseFeedbackMigrations(directory)).toEqual([]);
    await expect(stat(join(directory, 'feedback-supabase-migrations'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets only one independent process claim the active migration slot', async () => {
    const directory = await fixture();
    const run = async (requestId: string) => {
      const child = spawnTsEvalWithRepoImports(`
        import { prepareSupabaseFeedbackMigration } from './src/services/feedback-supabase-migration.js';
        try {
          const result = await prepareSupabaseFeedbackMigration(${JSON.stringify(directory)}, {
            requestId: ${JSON.stringify(requestId)}, expectedGeneration: 4, maintenanceConfirmed: true,
          });
          process.stdout.write(JSON.stringify({ migrationId: result.migrationId }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ error: error.message }));
        }
      `, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout!.on('data', chunk => { output += chunk; });
      const [code] = await once(child, 'exit');
      expect(code).toBe(0);
      return JSON.parse(output);
    };
    const results = await Promise.all([run('process-one'), run('process-two')]);
    expect(results.filter(result => result.migrationId)).toHaveLength(1);
    expect(results.filter(result => result.error)).toEqual([{ error: 'feedback_migration_conflict' }]);
  });
});
