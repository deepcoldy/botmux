// Real-SQLite coverage for hermesSessionExists() — the three-state resume probe.
//
// The sibling hermes-transcript.test.ts mocks node:child_process wholesale, so
// it only asserts the stdout->return mapping and never exercises the Python
// control flow inside the probe. This file drives the *un-mocked* probe against
// real state.db files so the actual schema-detection branches are covered:
//   - `sessions` table present, id hit          -> true
//   - `sessions` table present, id missing       -> false (NO messages fallback,
//                                                    even if an orphan message row
//                                                    with that session_id exists)
//   - only legacy `messages` table, id hit/miss   -> true / false
//   - neither known table (unknown schema)        -> undefined
//   - db file absent                              -> undefined
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { hermesSessionExists } from '../src/services/hermes-transcript.js';

// The probe shells out to python3 + sqlite3; skip gracefully if unavailable so
// the suite stays green on hosts without a Python interpreter.
const pythonProbe = spawnSync('python3', ['-c', 'import sqlite3'], { encoding: 'utf8' });
const hasPython = pythonProbe.status === 0;
const maybe = hasPython ? it : it.skip;

function buildDb(dir: string, name: string, sql: string): string {
  const dbPath = join(dir, name);
  const script = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.executescript(${JSON.stringify(sql)})
conn.commit()
conn.close()
`;
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (proc.status !== 0) throw new Error(`failed to build fixture db: ${proc.stderr}`);
  return dbPath;
}

describe('hermesSessionExists (real sqlite)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-session-exists-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  maybe('returns true when the id is present in the sessions table', () => {
    const db = buildDb(dir, 'sessions-hit.db', `
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO sessions (id, title) VALUES ('20260716_163643_7782fd', 'x');
    `);
    expect(hermesSessionExists('20260716_163643_7782fd', db)).toBe(true);
  });

  maybe('returns false when sessions table exists but the id is absent — even with an orphan message', () => {
    // The critical regression: a message row references a session_id that has
    // no row in `sessions`. Hermes resume keys on sessions.id, so this target is
    // NOT resumable and the probe must say false (previously it leaked to a
    // messages fallback and returned a false-positive true).
    const db = buildDb(dir, 'orphan-message.db', `
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO sessions (id, title) VALUES ('some-other-session', 'x');
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT);
      INSERT INTO messages (session_id, role, content) VALUES ('20260716_163643_7782fd', 'user', 'orphan');
    `);
    expect(hermesSessionExists('20260716_163643_7782fd', db)).toBe(false);
  });

  maybe('falls back to the messages table only when there is no sessions table (legacy schema)', () => {
    const hit = buildDb(dir, 'legacy-hit.db', `
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT);
      INSERT INTO messages (session_id, role, content) VALUES ('legacy-1', 'user', 'hi');
    `);
    expect(hermesSessionExists('legacy-1', hit)).toBe(true);

    const miss = buildDb(dir, 'legacy-miss.db', `
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT);
      INSERT INTO messages (session_id, role, content) VALUES ('legacy-1', 'user', 'hi');
    `);
    expect(hermesSessionExists('nope', miss)).toBe(false);
  });

  maybe('returns undefined for an unrecognized schema (neither sessions nor messages)', () => {
    const db = buildDb(dir, 'unknown-schema.db', `
      CREATE TABLE conversations (uuid TEXT PRIMARY KEY, blob BLOB);
      INSERT INTO conversations (uuid, blob) VALUES ('whatever', x'00');
    `);
    expect(hermesSessionExists('20260716_163643_7782fd', db)).toBeUndefined();
  });

  maybe('returns undefined when the db file is absent', () => {
    expect(hermesSessionExists('20260716_163643_7782fd', join(dir, 'does-not-exist.db'))).toBeUndefined();
  });

  maybe('returns undefined for a blank/whitespace session id', () => {
    const db = buildDb(dir, 'blank-id.db', `
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
    `);
    expect(hermesSessionExists('   ', db)).toBeUndefined();
  });
});
