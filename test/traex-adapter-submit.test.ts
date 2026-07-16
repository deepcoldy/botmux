import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const SID_1 = '00000000-0000-7000-8000-000000000001';
const SID_2 = '00000000-0000-7000-8000-000000000002';
let traeHome: string;
let dbPath: string;
let previousTraeHome: string | undefined;
let previousScale: string | undefined;

function rolloutPath(sid: string): string {
  return join(traeHome, 'cli', 'sessions', '2000', '01', '01', `rollout-2000-01-01T00-00-00-${sid}.jsonl`);
}

function userLine(text: string): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  })}\n`;
}

function openDb(): DatabaseSync {
  return new DatabaseSync(dbPath);
}

function createStateDb(): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb();
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at_ms INTEGER,
        first_user_message TEXT NOT NULL DEFAULT ''
      )
    `);
  } finally {
    db.close();
  }
}

function insertThread(sid: string, text: string, updatedAtMs: number): void {
  const path = rolloutPath(sid);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, userLine(text));
  const db = openDb();
  try {
    db.prepare(
      'INSERT INTO threads (id, rollout_path, created_at, updated_at_ms, first_user_message) VALUES (?, ?, ?, ?, ?)',
    ).run(sid, path, updatedAtMs, updatedAtMs, text);
  } finally {
    db.close();
  }
}

function appendThreadUser(sid: string, text: string, updatedAtMs: number): void {
  appendFileSync(rolloutPath(sid), userLine(text));
  const db = openDb();
  try {
    db.prepare('UPDATE threads SET updated_at_ms = ? WHERE id = ?').run(updatedAtMs, sid);
  } finally {
    db.close();
  }
}

function ptyThatCommits(onEnter: (text: string) => void): PtyHandle & {
  pasteText: ReturnType<typeof vi.fn>;
  sendSpecialKeys: ReturnType<typeof vi.fn>;
} {
  let pasted = '';
  let committed = false;
  return {
    write: vi.fn(),
    pasteText: vi.fn((text: string) => { pasted = text; }),
    sendSpecialKeys: vi.fn((key: string) => {
      if (key === 'Enter' && !committed) {
        committed = true;
        onEnter(pasted);
      }
    }),
  };
}

describe.sequential('TRAE adapter submit verification', () => {
  beforeEach(() => {
    previousTraeHome = process.env.TRAE_HOME;
    previousScale = process.env.BOTMUX_TIME_SCALE;
    traeHome = mkdtempSync(join(tmpdir(), 'traex-adapter-'));
    dbPath = join(traeHome, 'cli', 'state_5.sqlite');
    process.env.TRAE_HOME = traeHome;
    process.env.BOTMUX_TIME_SCALE = '0.01';
  });

  afterEach(() => {
    if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
    else process.env.TRAE_HOME = previousTraeHome;
    if (previousScale === undefined) delete process.env.BOTMUX_TIME_SCALE;
    else process.env.BOTMUX_TIME_SCALE = previousScale;
    rmSync(traeHome, { recursive: true, force: true });
  });

  it('fails closed before PTY write when the SQLite session index is unavailable', async () => {
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatCommits(() => { throw new Error('must not submit'); });

    const result = await adapter.writeInput(pty, 'do not write without proof');

    expect(result).toEqual(expect.objectContaining({
      submitted: false,
      failureReason: expect.stringContaining('SQLite'),
    }));
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('confirms a later turn from the same rollout delta, not first_user_message', async () => {
    createStateDb();
    insertThread(SID_1, 'the immutable first prompt', 1_000);
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatCommits(text => appendThreadUser(SID_1, text, 2_000));

    const result = await adapter.writeInput(pty, 'a different second prompt');

    expect(result).toEqual({ submitted: true, cliSessionId: SID_1 });
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
  });

  it('returns the new native session id when a submit rotates to a fresh rollout', async () => {
    createStateDb();
    insertThread(SID_1, 'old session prompt', 1_000);
    const adapter = createTraexAdapter('/bin/traex');
    const pty = ptyThatCommits(text => insertThread(SID_2, text, 2_000));

    const result = await adapter.writeInput(pty, 'first prompt after session rotation');

    expect(result).toEqual({ submitted: true, cliSessionId: SID_2 });
  });
});
