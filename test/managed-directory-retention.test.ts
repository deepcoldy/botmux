import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginDirectoryCollection, guardSessionDirectoryWrites, managedReferences,
  reserveManagedDirectories, retireManagedDirectories, resumeDirectoryRetirement,
  type DirectoryCandidate, type ManagedDirectoryConfig,
} from '../src/services/managed-directory-retention.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { once } from 'node:events';

let root: string, assets: string, a: string, b: string, statePath: string;
let config: ManagedDirectoryConfig;
let previousConfig: string | undefined;
function candidate(path: string, references: string[] = []): DirectoryCandidate {
  const info = lstatSync(path, { bigint: true });
  return { path, dev: String(info.dev), ino: String(info.ino), ctimeNs: String(info.ctimeNs), references };
}
function state() { return JSON.parse(readFileSync(statePath, 'utf8')); }
beforeEach(() => {
  // fs.realpath is used below to handle macOS /var -> /private/var.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'managed-retention-')));
  assets = join(root, 'versions'); mkdirSync(assets);
  a = join(assets, 'a'.repeat(40)); b = join(assets, 'b'.repeat(40));
  mkdirSync(a); mkdirSync(b);
  statePath = join(root, 'retention-state.json');
  config = { schemaVersion: 1, statePath, roots: [{ path: assets, hashLength: 40 }] };
  previousConfig = process.env.BOTS_CONFIG;
  process.env.BOTS_CONFIG = join(root, 'bots.json');
  writeFileSync(join(root, '.managed-directories.json'), JSON.stringify(config), { mode: 0o600 });
});
afterEach(() => {
  if (previousConfig === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = previousConfig;
  rmSync(root, { recursive: true, force: true });
});

describe('managed directory write barrier', () => {
  it('coordinates an actual writer process with scans and reaps a crashed writer reservation', async () => {
    const child = spawnTsEvalWithRepoImports(`
      import { reserveManagedDirectories } from './src/services/managed-directory-retention.js';
      reserveManagedDirectories({ workingDir: process.env.RETENTION_TEST_ASSET });
      process.stdout.write('reserved\\n');
      setInterval(() => {}, 1000);
    `, { cwd: process.cwd(), env: { ...process.env, RETENTION_TEST_ASSET: a }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await Promise.race([
        once(child.stdout!, 'data'),
        once(child, 'exit').then(([code]) => { throw new Error(`writer exited: ${code}`); }),
      ]);
      expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], [])).toEqual([]);
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], [])).toHaveLength(1);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  });

  it('retains a reference published after the scan, including its immutable dependencies', () => {
    const id = beginDirectoryCollection();
    const done = reserveManagedDirectories({ workingDir: a });
    writeFileSync(join(root, 'session.json'), JSON.stringify({ workingDir: a })); done();
    expect(retireManagedDirectories(id, [candidate(a, [b]), candidate(b)], [])).toEqual([]);
    expect(existsSync(a) && existsSync(b)).toBe(true);
  });

  it('keeps a pending write across successive scans until publication completes', () => {
    const done = reserveManagedDirectories({ workingDir: a });
    for (let n = 0; n < 2; n++) {
      expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], [])).toEqual([]);
    }
    done();
    expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], [])).toHaveLength(1);
    expect(() => reserveManagedDirectories({ workingDir: a })).toThrow();
  });

  it('does not let a stale collector retire a newer scan generation', () => {
    const old = beginDirectoryCollection(); beginDirectoryCollection();
    expect(() => retireManagedDirectories(old, [candidate(a)], [])).toThrow('stale_directory_collection');
    expect(existsSync(a)).toBe(true);
  });

  it('rejects changed inodes before any candidate is retired', () => {
    const first = candidate(a); first.ino = String(BigInt(first.ino) + 1n);
    expect(() => retireManagedDirectories(beginDirectoryCollection(), [candidate(b), first], [])).toThrow('candidate_changed');
    expect(existsSync(b)).toBe(true);
  });

  it('fences a durable retirement decision and resumes its interrupted rename', () => {
    beginDirectoryCollection();
    const value = state(); value.retired[a] = { dev: String(lstatSync(a, { bigint: true }).dev), ino: String(lstatSync(a, { bigint: true }).ino), ctimeNs: String(lstatSync(a, { bigint: true }).ctimeNs) };
    writeFileSync(statePath, JSON.stringify(value));
    expect(() => reserveManagedDirectories({ cwd: a })).toThrow('managed_directory_retired_or_unsafe');
    const [quarantine] = resumeDirectoryRetirement(a);
    expect(existsSync(a)).toBe(false); expect(existsSync(quarantine)).toBe(true);
    mkdirSync(a); // a reinstalled generation is not the retired inode
    const release = reserveManagedDirectories({ cwd: a }); release();
    resumeDirectoryRetirement(a);
    expect(existsSync(a)).toBe(true);
  });

  it('does not accept a symlink as a managed candidate', () => {
    rmSync(a, { recursive: true }); symlinkSync(b, a);
    expect(() => reserveManagedDirectories({ workingDir: a })).toThrow();
    expect(() => retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], [])).toThrow();
  });

  it('decodes JSON and normalized directory components without prefix collisions', () => {
    expect(managedReferences(config, JSON.stringify({ cwd: a + '/../' + 'b'.repeat(40) }))).toContain(b);
    expect(managedReferences(config, a + '0')).toHaveLength(0);
  });

  it('keeps uncommitted SQLite rows protected until COMMIT', () => {
    const db = guardSessionDirectoryWrites(openDatabaseSyncOrThrow(join(root, 'sessions.db')));
    try {
      db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY, status TEXT, row TEXT)');
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO sessions (session_id, status, row) VALUES (?, ?, ?)')
        .run('s1', 'active', JSON.stringify({ sessionId: 's1', workingDir: a }));
      expect(Object.keys(state().pending)).toHaveLength(1);
      expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], [])).toEqual([]);
      db.exec('COMMIT');
      expect(Object.keys(state().pending)).toHaveLength(0);
    } finally { db.close(); }
  });

  it('releases rolled-back references and skips reservation writes for exact CAS with unchanged paths', () => {
    const db = guardSessionDirectoryWrites(openDatabaseSyncOrThrow(join(root, 'sessions.db')));
    try {
      db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY, status TEXT, row TEXT)');
      const old = JSON.stringify({ sessionId: 's1', workingDir: a });
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s1', 'active', old);
      const before = readFileSync(statePath, 'utf8');
      db.prepare('UPDATE sessions SET status = ?, row = ? WHERE session_id = ? AND row = ?')
        .run('active', JSON.stringify({ sessionId: 's1', workingDir: a, pid: 4 }), 's1', old);
      expect(readFileSync(statePath, 'utf8')).toBe(before);
      db.exec('BEGIN');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s2', 'active', JSON.stringify({ sessionId: 's2', workingDir: b }));
      db.exec('ROLLBACK');
      expect(Object.keys(state().pending)).toHaveLength(0);
      expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(b)], [])).toHaveLength(1);
    } finally { db.close(); }
  });
});
