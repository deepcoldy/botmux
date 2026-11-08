import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFeedbackStorageCommand } from '../src/cli/feedback-storage.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { once } from 'node:events';
import { readFeedbackStorageConfig, saveFeedbackStorageCandidate } from '../src/services/feedback-storage-config.js';
import { prepareFeedbackMigration, getFeedbackMigration } from '../src/services/feedback-migration.js';
import { beginFeedbackMaintenance, assertFeedbackAdmission } from '../src/services/feedback-maintenance.js';

describe('feedback storage CLI', () => {
  it('requires evidence for cancellation and exposes pre-freeze recovery without a database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-cli-cancel-'));
    const output: string[] = [];
    const io = { input: Readable.from([]), output: new Writable({ write(chunk, _encoding, done) { output.push(String(chunk)); done(); } }), error: new Writable({ write(_chunk, _encoding, done) { done(); } }) };
    try {
      const config = await readFeedbackStorageConfig(directory);
      const saved = await saveFeedbackStorageCandidate(directory, config.generation, { backend: 'postgresql', postgres: {
        host: 'invalid', port: 1, database: 'invalid', user: 'invalid', schema: 'feedback', passwordRef: 'env:UNSET', tls: { mode: 'disable' }, connectTimeoutMs: 100,
      } });
      const job = await prepareFeedbackMigration(directory, { requestId: 'cli-cancel', expectedGeneration: saved.generation, maintenanceConfirmed: true });
      await beginFeedbackMaintenance(directory, job.migrationId);
      expect(await runFeedbackStorageCommand(['cancel', job.migrationId, '--yes'], io, directory)).toBe(1);
      expect(() => assertFeedbackAdmission(directory)).toThrow();
      expect(await runFeedbackStorageCommand(['cancel', job.migrationId, '--yes', '--reason', 'bad target', '--evidence', 'ticket:123'], io, directory)).toBe(0);
      expect(JSON.parse(output.at(-1)!).phase).toBe('cancelled');
      expect((await getFeedbackMigration(directory, job.migrationId)).cancellation?.actor).toMatch(/^local:/);
      expect(() => assertFeedbackAdmission(directory)).not.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('does not create an effect lease for an invalid dry-run send', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-cli-dry-'));
    const child = spawnTsScript('src/cli.ts', ['send', '--dry-run', '--no-mention'], {
      env: { ...process.env, HOME: directory, SESSION_DATA_DIR: directory },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin!.end();
    try {
      const [code] = await once(child, 'exit');
      expect(code).toBe(2);
      expect(await readdir(join(directory, 'feedback-send-leases')).catch(() => [])).toEqual([]);
    } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
  });
  it('reports SQLite by default and rejects unconfirmed migration without revealing supplied secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-cli-'));
    let output = '', errors = '';
    const io = {
      input: Readable.from([]),
      output: new Writable({ write: (chunk, _encoding, done) => { output += String(chunk); done(); } }),
      error: new Writable({ write: (chunk, _encoding, done) => { errors += String(chunk); done(); } }),
    };
    try {
      expect(await runFeedbackStorageCommand(['status'], io, directory)).toBe(0);
      expect(JSON.parse(output).active.backend).toBe('sqlite');
      expect(await runFeedbackStorageCommand(['migrate', '--to', 'postgresql'], io, directory)).toBe(1);
      expect(errors).toContain('confirmation');
      expect(await runFeedbackStorageCommand(['configure', '--password', 'hidden-password'], io, directory)).toBe(1);
      expect(errors).toContain('feedback_storage_use_secret_reference');
      expect(errors).not.toContain('hidden-password');
      for (const tokenArgs of [['--token', 'hidden-token'], ['--token=hidden-token-2']]) {
        expect(await runFeedbackStorageCommand(['configure', ...tokenArgs], io, directory)).toBe(1);
        expect(errors).toContain('feedback_storage_use_secret_reference');
        expect(errors).not.toContain('hidden-token');
      }
      // With a usable config file the guard must still reject before applying it:
      // a missing guard would make the command succeed (exit 0), not fail later.
      const configFile = join(directory, 'sqlite.json');
      await writeFile(configFile, JSON.stringify({ backend: 'sqlite' }), 'utf8');
      expect(await runFeedbackStorageCommand(['configure', '--config-file', configFile, '--token=hidden-token-3'], io, directory)).toBe(1);
      expect(errors).toContain('feedback_storage_use_secret_reference');
      expect(errors).not.toContain('hidden-token-3');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
