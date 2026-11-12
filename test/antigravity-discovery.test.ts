import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import {
  findAntigravityConversationId,
  findAntigravityConversationIdByPid,
  findAntigravityConversationIdByWorkspace,
} from '../src/services/antigravity-discovery.js';

describe('antigravity-discovery', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-agy-discovery-'));
    dbPath = join(tmpDir, 'conversation_summaries.db');
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('finds conversation ID matching cwd from summaries DB', () => {
    const db = openDatabaseSyncOrThrow(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        workspace_uris TEXT NOT NULL,
        last_modified_time DATETIME NOT NULL
      );
    `);
    const validUuid1 = '11111111-2222-3333-4444-555555555555';
    const validUuid2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, workspace_uris, last_modified_time)
      VALUES (?, ?, ?);
    `).run(validUuid1, JSON.stringify(['file:///repo/other']), '2026-09-24 06:00:00');
    db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, workspace_uris, last_modified_time)
      VALUES (?, ?, ?);
    `).run(validUuid2, JSON.stringify(['file:///repo/my-project']), '2026-09-24 07:00:00');
    db.close();

    const cid = findAntigravityConversationIdByWorkspace('/repo/my-project', dbPath);
    expect(cid).toBe(validUuid2);

    const fromAll = findAntigravityConversationId({ cwd: '/repo/my-project', summariesDbPath: dbPath });
    expect(fromAll).toBe(validUuid2);
  });

  it('returns null when no matching workspace exists', () => {
    const db = openDatabaseSyncOrThrow(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        workspace_uris TEXT NOT NULL,
        last_modified_time DATETIME NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, workspace_uris, last_modified_time)
      VALUES (?, ?, ?);
    `).run('11111111-2222-3333-4444-555555555555', JSON.stringify(['file:///repo/other']), '2026-09-24 06:00:00');
    db.close();

    const cid = findAntigravityConversationIdByWorkspace('/repo/non-existent', dbPath);
    expect(cid).toBeNull();
  });

  it('handles missing DB file gracefully', () => {
    const cid = findAntigravityConversationIdByWorkspace('/repo/my-project', join(tmpDir, 'not_exists.db'));
    expect(cid).toBeNull();
  });

  it('prevents substring/prefix false positives (e.g. /repo/project vs /repo/project-backup)', () => {
    const db = openDatabaseSyncOrThrow(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        workspace_uris TEXT NOT NULL,
        last_modified_time DATETIME NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, workspace_uris, last_modified_time)
      VALUES (?, ?, ?);
    `).run('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', JSON.stringify(['file:///repo/project-backup']), '2026-09-24 07:00:00');
    db.close();

    // Querying /repo/project must NOT match /repo/project-backup
    const cid = findAntigravityConversationIdByWorkspace('/repo/project', dbPath);
    expect(cid).toBeNull();

    // Exact match works
    const exactCid = findAntigravityConversationIdByWorkspace('/repo/project-backup', dbPath);
    expect(exactCid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('does not fall back to historical workspace summaries when pid is specified', () => {
    const db = openDatabaseSyncOrThrow(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        workspace_uris TEXT NOT NULL,
        last_modified_time DATETIME NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, workspace_uris, last_modified_time)
      VALUES (?, ?, ?);
    `).run('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', JSON.stringify(['file:///repo/my-project']), '2026-09-24 07:00:00');
    db.close();

    // PID 9999999 has no open DB fd. Must NOT hijack old workspace session!
    const fromPidAndCwd = findAntigravityConversationId({
      pid: 9999999,
      cwd: '/repo/my-project',
      summariesDbPath: dbPath,
    });
    expect(fromPidAndCwd).toBeNull();

    // If allowWorkspaceFallbackWithPid is explicitly true, fallback is permitted
    const withFallback = findAntigravityConversationId({
      pid: 9999999,
      cwd: '/repo/my-project',
      summariesDbPath: dbPath,
      allowWorkspaceFallbackWithPid: true,
    });
    expect(withFallback).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('deduplicates SQLite WAL/SHM sidecars for one conversation and fails closed when multiple conversations are open', () => {
    const procRoot = join(tmpDir, 'proc');
    const convDir = join(tmpDir, '.gemini', 'antigravity-cli', 'conversations');
    mkdirSync(convDir, { recursive: true });

    const parentPid = 4100;
    const childPid = 4101;
    mkdirSync(join(procRoot, String(parentPid), 'fd'), { recursive: true });
    mkdirSync(join(procRoot, String(parentPid), 'task', String(parentPid)), { recursive: true });
    writeFileSync(join(procRoot, String(parentPid), 'task', String(parentPid), 'children'), `${childPid}\n`);
    mkdirSync(join(procRoot, String(childPid), 'fd'), { recursive: true });

    const ownedId = 'a4331552-f261-4f1f-a460-e15e7f2fe0ea';
    const siblingId = '61fc8ef7-1886-40af-9bac-c6ee8f8d172e';
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      writeFileSync(join(convDir, `${ownedId}${suffix}`), '');
    }
    writeFileSync(join(convDir, `${siblingId}.db`), '');

    symlinkSync(join(convDir, `${ownedId}.db`), join(procRoot, String(childPid), 'fd', '3'));
    symlinkSync(join(convDir, `${ownedId}.db-wal`), join(procRoot, String(childPid), 'fd', '4'));
    symlinkSync(join(convDir, `${ownedId}.db-shm`), join(procRoot, String(childPid), 'fd', '5'));

    expect(findAntigravityConversationIdByPid(parentPid, convDir, procRoot)).toBe(ownedId);

    // Startup ListConversations or post-/fork retention keeps a second distinct
    // conversation DB open: fail closed rather than picking fd-order first.
    symlinkSync(join(convDir, `${siblingId}.db`), join(procRoot, String(parentPid), 'fd', '6'));
    expect(findAntigravityConversationIdByPid(parentPid, convDir, procRoot)).toBeNull();
  });
});
