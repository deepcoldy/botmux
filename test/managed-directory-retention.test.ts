import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, statSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginDirectoryCollection, guardSessionDirectoryWrites, managedReferences,
  reserveManagedDirectories, retireManagedDirectories, resumeDirectoryRetirement,
  type DirectoryCandidate, type ManagedDirectoryConfig,
} from '../src/services/managed-directory-retention.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import { createTask, setScheduleScope, scheduleFilePathFor } from '../src/services/schedule-store.js';
import { saveHeadlessSession, createHeadlessRecord } from '../src/services/headless-session-store.js';
import { putDocSubscription, type DocSubscription } from '../src/services/doc-subs-store.js';
import { ensureDefaultWhiteboard } from '../src/services/whiteboard-store.js';
import type { ScheduledTask } from '../src/types.js';
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
  process.env.SESSION_DATA_DIR = join(root, 'data');
  writeFileSync(join(root, '.managed-directories.json'), JSON.stringify(config), { mode: 0o600 });
});
afterEach(() => {
  if (previousConfig === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = previousConfig;
  delete process.env.SESSION_DATA_DIR;
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

  it('retains the full dependency closure including cycles regardless of candidate order', () => {
    const c = join(assets, 'c'.repeat(40)); mkdirSync(c);
    const unused = join(assets, 'd'.repeat(40)); mkdirSync(unused);
    const id = beginDirectoryCollection();
    const done = reserveManagedDirectories({ workingDir: a }); done();
    const retired = retireManagedDirectories(id, [
      candidate(unused), candidate(c, [a]), candidate(b, [c]), candidate(a, [b]),
    ], []);
    expect(retired).toHaveLength(1);
    expect(existsSync(unused)).toBe(false);
    expect([a, b, c].every(path => existsSync(path))).toBe(true);
  });

  it('registers authoritative schedule DB commits and edit-time reference deltas', () => {
    const APP = 'cli_app_retention';
    const store = ScheduleAuthorityStore.open(join(root, 'data'));
    store.initializeApp(APP, []);
    const task = createTask({
      id: 't1', name: 'task', schedule: 'every 1h', prompt: 'run',
      workingDir: a, chatId: 'oc_x', larkAppId: APP,
    });
    // The cycle starts after the JSON projection was published, so the
    // authority INSERT is the only reference publication inside the window.
    const first = beginDirectoryCollection();
    store.createDirect(task);
    expect(retireManagedDirectories(first, [candidate(a)], [])).toEqual([]);
    expect(existsSync(a)).toBe(true);
    // An edit that newly names another managed version registers the delta.
    const second = beginDirectoryCollection();
    store.updateTask(APP, 't1', current => ({ ...current, prompt: `inspect ${b}` }));
    expect(retireManagedDirectories(second, [candidate(b)], [])).toEqual([]);
    expect(existsSync(b)).toBe(true);
  });

  it('keeps a pending write across successive scans until publication completes', () => {
    const done = reserveManagedDirectories({ workingDir: a });
    for (let n = 0; n < 2; n++) {
      expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], [])).toEqual([]);
    }
    done();
    expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], [])).toHaveLength(1);
    // Quarantined (absent) versions carry nothing to protect: reserve is a
    // no-op rather than a bare ENOENT that would brick whole-snapshot writes.
    expect(existsSync(a)).toBe(false);
    expect(() => reserveManagedDirectories({ workingDir: a })).not.toThrow();
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

  it('does not accept a symlink as a retire candidate', () => {
    rmSync(a, { recursive: true }); symlinkSync(b, a);
    // Retirement renames the inode itself; a link must never pass identity checks.
    expect(() => retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], [])).toThrow();
  });

  it('resolves a symlinked reference to its managed target and ignores out-of-root links', () => {
    rmSync(a, { recursive: true }); symlinkSync(b, a);
    // Referencing the link is referencing b's inode: a scan while the write is
    // in flight must keep the real directory b.
    const done = reserveManagedDirectories({ workingDir: a });
    expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(b)], [])).toEqual([]);
    expect(existsSync(b)).toBe(true);
    done();
    // A link escaping every managed root names nothing this protocol protects.
    const outside = join(root, 'outside'); mkdirSync(outside);
    rmSync(a, { force: true }); symlinkSync(outside, a);
    expect([...managedReferences(config, { workingDir: a })]).toHaveLength(0);
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
      // Exact CAS must perform NO maintenance-state write at all. Comparing the
      // final bytes cannot distinguish "never registered" from "registered and
      // released" (the JSON round-trips byte-identically) — mtime does.
      const stamp = () => statSync(statePath, { bigint: true }).mtimeNs;
      const beforeWrite = stamp();
      db.prepare('UPDATE sessions SET status = ?, row = ? WHERE session_id = ? AND row = ?')
        .run('active', JSON.stringify({ sessionId: 's1', workingDir: a, pid: 4 }), 's1', old);
      expect(stamp()).toBe(beforeWrite);
      db.exec('BEGIN');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s2', 'active', JSON.stringify({ sessionId: 's2', workingDir: b }));
      db.exec('ROLLBACK');
      expect(Object.keys(state().pending)).toHaveLength(0);
      expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(b)], [])).toHaveLength(1);
    } finally { db.close(); }
  });

  it('does not let one dangling reference block unrelated whole-snapshot schedule writes', () => {
    // Backup-restore shape: a task naming a version that does not exist is
    // already on disk. Every later schedule write of the same bot serializes
    // the whole map, and must not fail on that one dangling entry.
    setScheduleScope('appSnap');
    const fp = scheduleFilePathFor('appSnap');
    mkdirSync(join(fp, '..'), { recursive: true });
    writeFileSync(fp, JSON.stringify({
      bad: { id: 'bad', name: 'bad', schedule: 'every 1h', prompt: 'p', workingDir: join(assets, 'd'.repeat(40)), chatId: 'oc1' },
    }));
    expect(() => createTask({
      id: 'good', name: 'good', schedule: 'every 1h', prompt: 'p', workingDir: a, chatId: 'oc2',
    })).not.toThrow();
  });

  it('releases the reservation when BEGIN fails inside createDirect and initializeApp', () => {
    const app = 'cli_app_begin';
    const store = ScheduleAuthorityStore.open(join(root, 'data'));
    store.initializeApp(app, []);
    const task = createTask({
      id: 'tbegin01', name: 'task', schedule: 'every 1h', prompt: 'run',
      workingDir: a, chatId: 'oc_x', larkAppId: app,
    });
    const rawDb = store as unknown as { db: { exec(sql: string): void } };
    const expectBeginFailureReleases = (call: () => unknown): void => {
      // Hold the connection's single transaction so the call's BEGIN fails
      // instantly (same release contract as a 5 s SQLITE_BUSY, deterministic).
      rawDb.db.exec('BEGIN IMMEDIATE;');
      try {
        expect(call).toThrow();
        expect(Object.keys(state().pending)).toHaveLength(0);
      } finally {
        // The call's error-path ROLLBACK ends the transaction on at least one
        // engine; on the other it stays open until this ROLLBACK.
        try { rawDb.db.exec('ROLLBACK;'); } catch { /* already ended */ }
      }
    };
    expectBeginFailureReleases(() => store.createDirect(task));
    expectBeginFailureReleases(() => store.initializeApp('cli_app_begin_other', [
      { id: 't2', chatId: 'oc', workingDir: a } as Partial<ScheduledTask> as ScheduledTask,
    ]));
    // The version is collectable afterwards in the same process.
    expect(retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], [])).toHaveLength(1);
  });

  it.each(['COMMIT', 'END'])('keeps uncommitted references protected when %s is busy and then retried', (end) => {
    const path = join(root, 'busy-commit.db');
    const db = guardSessionDirectoryWrites(openDatabaseSyncOrThrow(path));
    const reader = openDatabaseSyncOrThrow(path);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
      db.exec('PRAGMA busy_timeout = 0');
      db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY, status TEXT, row TEXT)');
      reader.exec('BEGIN');
      reader.prepare('SELECT * FROM sessions').all();
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s1', 'active', JSON.stringify({ workingDir: a }));
      expect(() => db.exec(end)).toThrow();
      expect(Object.keys(state().pending)).toHaveLength(1);
      // Start AFTER the failed commit so cycle.marked cannot hide early release.
      const id = beginDirectoryCollection();
      reader.exec('ROLLBACK');
      db.exec(end);
      expect(Object.keys(state().pending)).toHaveLength(0);
      expect(retireManagedDirectories(id, [candidate(a)], [])).toEqual([]);
      expect(reader.prepare('SELECT * FROM sessions').all()).toHaveLength(1);
      expect(existsSync(a)).toBe(true);
    } finally { reader.close(); db.close(); }
  });

  it('does not leak reservations after a statement rolls the transaction back implicitly', () => {
    const db = guardSessionDirectoryWrites(openDatabaseSyncOrThrow(join(root, 'implicit.db')));
    try {
      db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY, status TEXT, row TEXT)');
      const row = JSON.stringify({ sessionId: 's1', workingDir: a });
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s1', 'active', row);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR ROLLBACK INTO sessions VALUES (?, ?, ?)').run('s1', 'x', row);
        throw new Error('conflict expected');
      } catch (error) {
        if (!String(error).includes('UNIQUE')) throw error;
        try { db.exec('ROLLBACK'); } catch { /* transaction already ended — the shape under test */ }
      }
      for (let i = 0; i < 3; i++) {
        db.prepare('UPDATE sessions SET status = ?, row = ? WHERE session_id = ?').run('active', row, 's1');
        expect(Object.keys(state().pending)).toHaveLength(0);
      }
    } finally { db.close(); }
  });

  it('registers headless session, doc subscription and whiteboard writes during a cycle', () => {
    // headless
    let id = beginDirectoryCollection();
    saveHeadlessSession(createHeadlessRecord({
      sessionId: 'hl-session', larkAppId: 'app1', title: 't', workingDir: a,
    }));
    expect(retireManagedDirectories(id, [candidate(a)], [])).toEqual([]);
    expect(existsSync(a)).toBe(true);

    // doc subscriptions
    id = beginDirectoryCollection();
    const sub: DocSubscription = {
      fileToken: 'doc1', fileType: 'docx', sessionAnchor: 'doc:doc1:watch',
      scope: 'thread', chatId: 'oc_d', commentTriggerMode: 'all',
      createdAt: Date.now(), workingDir: a,
    };
    putDocSubscription(join(root, 'data'), 'app1', sub);
    expect(retireManagedDirectories(id, [candidate(a)], [])).toEqual([]);
    expect(existsSync(a)).toBe(true);

    // whiteboard meta + index
    const previousGlobalConfig = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    const globalConfig = join(root, 'global-config.json');
    writeFileSync(globalConfig, JSON.stringify({ whiteboard: { enabled: true } }));
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = globalConfig;
    try {
      id = beginDirectoryCollection();
      ensureDefaultWhiteboard({
        larkAppId: 'app1', chatId: 'oc_w', sessionId: 's-wb', title: 'wb', workingDir: a,
      });
      expect(retireManagedDirectories(id, [candidate(a)], [])).toEqual([]);
      expect(existsSync(a)).toBe(true);
    } finally {
      if (previousGlobalConfig === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
      else process.env.BOTMUX_GLOBAL_CONFIG_FILE = previousGlobalConfig;
    }
  });

  it('fences the JSON to SQLite import publication against a retired version', async () => {
    // The import's rename is the first SQLite publication of the restored rows.
    // A retired identity named by an imported workingDir must abort the import
    // rather than publish a store that points at a quarantined inode.
    const probeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'retention-import-')));
    const probeAssets = join(probeRoot, 'versions'); mkdirSync(probeAssets);
    const probeA = join(probeAssets, 'a'.repeat(40)); mkdirSync(probeA);
    const probeData = join(probeRoot, 'data'); mkdirSync(probeData);
    const info = lstatSync(probeA, { bigint: true });
    writeFileSync(join(probeRoot, '.managed-directories.json'), JSON.stringify({
      schemaVersion: 1,
      statePath: join(probeRoot, 'state.json'),
      roots: [{ path: probeAssets, hashLength: 40 }],
    }), { mode: 0o600 });
    writeFileSync(join(probeRoot, 'state.json'), JSON.stringify({
      schemaVersion: 1, pending: {},
      retired: { [probeA]: { dev: String(info.dev), ino: String(info.ino), ctimeNs: String(info.ctimeNs) } },
    }));
    writeFileSync(join(probeData, 'sessions-appA.json'), JSON.stringify({
      s1: { sessionId: 's1', chatId: 'oc', status: 'active', workingDir: probeA },
    }));
    const child = spawnTsEvalWithRepoImports(`
      const store = await import('./src/services/session-store.js');
      store.init('appA');
      console.log('IMPORT_VISIBLE=' + store.listSessions().length);
    `, { cwd: process.cwd(), env: {
      ...process.env,
      HOME: probeRoot,
      BOTS_CONFIG: join(probeRoot, 'bots.json'),
      SESSION_DATA_DIR: probeData,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
    expect(output).toContain('IMPORT_VISIBLE=0'); // load failed closed
    expect(existsSync(join(probeData, 'session-stores', 'appA', 'sessions.db'))).toBe(false);
    rmSync(probeRoot, { recursive: true, force: true });
  });

  it('releases import reservations when opening the staging database fails', async () => {
    const data = join(root, 'data');
    const staging = join(data, 'session-stores', 'appA', 'sessions.db.tmp');
    mkdirSync(staging, { recursive: true }); // real SQLite open fails on a directory
    writeFileSync(join(data, 'sessions-appA.json'), JSON.stringify({
      s1: { sessionId: 's1', chatId: 'oc', status: 'active', workingDir: a },
    }));
    const child = spawnTsEvalWithRepoImports(`
      import { readFileSync } from 'node:fs';
      const store = await import('./src/services/session-store.js');
      store.init('appA');
      const visible = store.listSessions().length;
      const state = JSON.parse(readFileSync(process.env.RETENTION_TEST_STATE, 'utf8'));
      console.log(JSON.stringify({ visible, pending: Object.keys(state.pending).length }));
    `, { cwd: process.cwd(), env: {
      ...process.env, HOME: root, SESSION_DATA_DIR: data, RETENTION_TEST_STATE: statePath,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { errors += String(chunk); });
    const [code] = await once(child, 'exit');
    expect({ code, errors: code === 0 ? '' : errors + output }).toEqual({ code: 0, errors: '' });
    // Inspect while the failed writer is alive, before dead-PID cleanup can mask a leak.
    expect(output).toContain(JSON.stringify({ visible: 0, pending: 0 }));
    expect(existsSync(join(data, 'session-stores', 'appA', 'sessions.db'))).toBe(false);
  });

  it('protects initializeApp backfill and commitDelegated publications', () => {
    const backfillTask = (id: string, dir: string): ScheduledTask => ({
      id, name: 'poll', schedule: 'every 30m',
      parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
      prompt: 'check status', workingDir: dir, chatId: 'oc_chat', scope: 'chat',
      executionPosition: 'top-level', larkAppId: 'cli_app_backfill', enabled: true,
      createdAt: '2026-11-03T00:00:00.000Z', nextRunAt: '2026-11-03T00:30:00.000Z',
    });
    const delegatedTask = (id: string, dir: string): ScheduledTask => ({
      id, name: 'poll', schedule: 'every 30m',
      parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
      prompt: 'check status', workingDir: dir, chatId: 'oc_chat', scope: 'chat',
      executionPosition: 'top-level', larkAppId: 'cli_app_delegated', enabled: true,
      createdAt: '2026-11-03T00:00:00.000Z', nextRunAt: '2026-11-03T00:30:00.000Z',
    });
    // Legacy projection rows are bulk-inserted at initializeApp; the whole
    // backfill commit must be inside the barrier window.
    const id = beginDirectoryCollection();
    const store = ScheduleAuthorityStore.open(join(root, 'data'));
    store.initializeApp('cli_app_backfill', [backfillTask('t1', a)]);
    expect(retireManagedDirectories(id, [candidate(a)], [])).toEqual([]);
    expect(existsSync(a)).toBe(true);

    // Delegated tasks publish straight into the authority DB.
    const id2 = beginDirectoryCollection();
    const result = store.commitDelegated({
      appId: 'cli_app_delegated', grantId: 'grant-1', requestHash: 'hash-1',
      task: delegatedTask('a1b2c3d4', b),
      control: { openId: 'ou_user', unionId: 'on_user', runScopes: [] as const },
      sourceMessageId: 'om_1', sourceSessionId: 's1', targetTurnId: 'om_1',
      targetGeneration: 1, maxTasksPerTurn: 64,
    });
    expect(result.ok).toBe(true);
    expect(retireManagedDirectories(id2, [candidate(b)], [])).toEqual([]);
    expect(existsSync(b)).toBe(true);
  });

  it('accepts both literal and real root spellings across reserve, retire, resume and reinstall', () => {
    const linkRoot = join(root, 'srv-link');
    symlinkSync(assets, linkRoot);
    const linkA = join(linkRoot, 'a'.repeat(40));
    const cfgDir = join(root, 'cfg2'); mkdirSync(cfgDir);
    writeFileSync(join(cfgDir, '.managed-directories.json'), JSON.stringify({
      schemaVersion: 1,
      statePath: join(root, 'state-link.json'),
      roots: [{ path: linkRoot, hashLength: 40 }],
    } satisfies ManagedDirectoryConfig), { mode: 0o600 });
    const previousBotsConfig = process.env.BOTS_CONFIG;
    process.env.BOTS_CONFIG = join(cfgDir, 'bots.json');
    try {
      // A reference published under the literal spelling keeps the real candidate.
      const id = beginDirectoryCollection();
      reserveManagedDirectories({ workingDir: linkA })();
      expect(retireManagedDirectories(id, [candidate(a)], [])).toEqual([]);
      expect(existsSync(a)).toBe(true);

      // Without references it quarantines at the real path; resume accepts the
      // literal spelling and hits the real-spelling retirement key.
      retireManagedDirectories(beginDirectoryCollection(), [candidate(a)], []);
      expect(existsSync(a)).toBe(false);
      const [target] = resumeDirectoryRetirement(linkA);
      expect(existsSync(target)).toBe(true);

      // A reinstalled generation at the same hash is left alone by resume.
      mkdirSync(a);
      expect(() => reserveManagedDirectories({ workingDir: linkA })).not.toThrow();
      resumeDirectoryRetirement(linkA);
      expect(existsSync(a)).toBe(true);

      // retained spelled literally still protects the real-spelling candidate
      // after the symlink itself has disappeared.
      rmSync(linkRoot, { force: true });
      const id2 = beginDirectoryCollection();
      expect(retireManagedDirectories(id2, [candidate(a)], [linkA])).toEqual([]);
      expect(existsSync(a)).toBe(true);
    } finally {
      process.env.BOTS_CONFIG = previousBotsConfig;
    }
  });
});
