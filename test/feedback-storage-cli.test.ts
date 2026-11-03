import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFeedbackStorageCommand } from '../src/cli/feedback-storage.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { once } from 'node:events';

describe('feedback storage CLI', () => {
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
      expect(errors).not.toContain('hidden-password');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
