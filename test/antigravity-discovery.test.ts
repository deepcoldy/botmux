import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import {
  findAntigravityConversationId,
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
});
