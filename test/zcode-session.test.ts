import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import {
  findZcodeSessionByBotmuxIdentity, readZcodeActualModel, readZcodeSessionMarker,
  readZcodeSessionModelSelection, readZcodeSubmissionReceipt, zcodeInputSha256,
  zcodeNativeSessionExists, zcodeSessionDbPath, zcodeSessionMarkerPath,
} from '../src/services/zcode-session.js';

const SID = 'a5d0cf1b-efc8-4c55-9302-c9568c5fa7c0';
const NATIVE = 'sess_303c5971-88e9-4204-b396-d6309beb0aac';
const OTHER = 'sess_11522b53-2e0b-453a-8547-bbd59971caed';
const HOOK = fileURLToPath(new URL('../src/services/zcode-session-hook.mjs', import.meta.url));

describe('ZCode precise session evidence', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'botmux-zcode-session-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function hook(input: unknown, sid: string | null = SID) {
    const env: NodeJS.ProcessEnv = { ...process.env, BOTMUX_ZCODE_RUNTIME_DIR: join(root, 'zcode-runtime') };
    delete env.BOTMUX_SESSION_ID;
    if (sid) env.BOTMUX_SESSION_ID = sid;
    return execFileSync(process.execPath, [HOOK], { input: JSON.stringify(input), env, encoding: 'utf8' });
  }

  function database() {
    const path = join(root, 'native.sqlite');
    const db = openDatabaseSyncOrThrow(path);
    db.exec('CREATE TABLE session (id TEXT, parent_id TEXT); CREATE TABLE message (id TEXT, data TEXT); CREATE TABLE part (session_id TEXT, message_id TEXT, data TEXT); CREATE TABLE session_entry (session_id TEXT, type TEXT, data TEXT, time_updated INTEGER); CREATE TABLE model_usage (session_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, query_source TEXT, started_at INTEGER)');
    return { db, path };
  }

  it('records the native identity and protects standalone sessions and user content', () => {
    expect(hook({ sessionId: NATIVE, hookEventName: 'SessionStart', model: 'p/m', source: 'startup' }, null)).toBe('{}\n');
    expect(readZcodeSessionMarker(SID, { dataDir: root })).toBeNull();
    hook({ sessionId: NATIVE, hookEventName: 'SessionStart', model: 'p/m', source: 'startup' });
    expect(readZcodeSessionMarker(SID, { dataDir: root })).toMatchObject({ cliSessionId: NATIVE, model: 'p/m', source: 'startup' });
    const prompt = 'private task text sk-example-not-a-real-key';
    hook({ sessionId: NATIVE, hookEventName: 'UserPromptSubmit', prompt, turnId: 'turn-1' });
    const serialized = readFileSync(zcodeSessionMarkerPath(SID, { dataDir: root }), 'utf8');
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain('sk-example');
  });

  it('rejects traversal, wrong botmux identity and malformed native IDs', () => {
    expect(() => zcodeSessionMarkerPath('../../outside', { dataDir: root })).toThrow();
    const file = zcodeSessionMarkerPath(SID, { dataDir: root });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, botmuxSessionId: 'wrong', cliSessionId: NATIVE, updatedAt: 1 }));
    expect(readZcodeSessionMarker(SID, { dataDir: root })).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, botmuxSessionId: SID, cliSessionId: '../../outside', updatedAt: 1 }));
    expect(readZcodeSessionMarker(SID, { dataDir: root })).toBeNull();
  });

  it('does not let an inherited subagent hook replace the root binding', () => {
    hook({ sessionId: NATIVE, hookEventName: 'SessionStart', source: 'startup' });
    hook({ sessionId: OTHER, hookEventName: 'SessionStart', source: 'startup' });
    expect(readZcodeSessionMarker(SID, { dataDir: root })?.cliSessionId).toBe(NATIVE);
  });

  it('requires a fresh receipt for the exact input and preserves per-turn evidence', () => {
    const prompt = 'same input';
    hook({ sessionId: NATIVE, hookEventName: 'UserPromptSubmit', prompt, turnId: 'turn-1' });
    const sha256 = zcodeInputSha256(prompt);
    const first = readZcodeSubmissionReceipt(SID, sha256, { dataDir: root });
    expect(first?.turnId).toBe('turn-1');
    expect(readZcodeSubmissionReceipt(SID, sha256, { dataDir: root, afterMs: first!.submittedAt + 1 })).toBeNull();
    expect(readZcodeSubmissionReceipt(SID, zcodeInputSha256('other'), { dataDir: root })).toBeNull();
    expect(readZcodeSubmissionReceipt(SID, sha256, { dataDir: root, cliSessionId: OTHER })).toBeNull();
    const receiptPath = join(root, 'zcode-runtime', SID, 'submissions', `${sha256}-turn-1.json`);
    const before = readFileSync(receiptPath, 'utf8');
    hook({ sessionId: NATIVE, hookEventName: 'UserPromptSubmit', prompt, turnId: 'turn-1' });
    expect(readFileSync(receiptPath, 'utf8')).toBe(before);
  });

  it('binds only a unique root user identity and ignores tool/assistant references', () => {
    const { db, path } = database();
    try {
      db.prepare('INSERT INTO session VALUES (?, NULL)').run(NATIVE);
      db.prepare('INSERT INTO session VALUES (?, NULL)').run(OTHER);
      db.prepare('INSERT INTO message VALUES (?, ?)').run('user', JSON.stringify({ role: 'user' }));
      db.prepare('INSERT INTO message VALUES (?, ?)').run('assistant', JSON.stringify({ role: 'assistant' }));
      db.prepare('INSERT INTO part VALUES (?, ?, ?)').run(NATIVE, 'user', JSON.stringify({ type: 'text', text: `BOTMUX_SESSION_ID=${SID}` }));
      db.prepare('INSERT INTO part VALUES (?, ?, ?)').run(OTHER, 'assistant', JSON.stringify({ type: 'text', text: `BOTMUX_SESSION_ID=${SID}` }));
      expect(findZcodeSessionByBotmuxIdentity(SID, path)).toBe(NATIVE);
      db.prepare('INSERT INTO part VALUES (?, ?, ?)').run(OTHER, 'user', JSON.stringify({ type: 'text', text: `BOTMUX_SESSION_ID=${SID}` }));
      expect(findZcodeSessionByBotmuxIdentity(SID, path)).toBeNull();
    } finally { db.close(); }
  });

  it('does not infer identities from unlabeled user text or child sessions', () => {
    const { db, path } = database();
    try {
      db.prepare('INSERT INTO session VALUES (?, ?)').run(NATIVE, OTHER);
      db.prepare('INSERT INTO message VALUES (?, ?)').run('user', JSON.stringify({ role: 'user' }));
      db.prepare('INSERT INTO part VALUES (?, ?, ?)').run(NATIVE, 'user', JSON.stringify({ type: 'text', text: `BOTMUX_SESSION_ID=${SID}` }));
      expect(findZcodeSessionByBotmuxIdentity(SID, path)).toBeNull();
      expect(zcodeNativeSessionExists(NATIVE, path)).toBe(false);
    } finally { db.close(); }
  });

  it('separates preserved model selection from actual main-turn execution', () => {
    const { db, path } = database();
    try {
      db.prepare('INSERT INTO session VALUES (?, NULL)').run(NATIVE);
      const selection = { providerId: 'provider-a', modelId: 'model-a', options: { reasoningLevel: 'enabled' } };
      db.prepare('INSERT INTO session_entry VALUES (?, ?, ?, ?)').run(NATIVE, 'runtime/model_selection', JSON.stringify({ modelSelection: selection }), 1);
      db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?)').run(NATIVE, 'provider-a', 'model-a', 'completed', 'main_turn', 1);
      db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?)').run(NATIVE, 'title-provider', 'title-model', 'completed', 'session_title', 2);
      expect(zcodeNativeSessionExists(NATIVE, path)).toBe(true);
      expect(readZcodeSessionModelSelection(NATIVE, path)).toEqual(selection);
      expect(readZcodeActualModel(NATIVE, path)).toMatchObject({ providerId: 'provider-a', modelId: 'model-a' });
    } finally { db.close(); }
  });

  it('honors explicit database paths without inferring them from storage directories', () => {
    expect(zcodeSessionDbPath({ ZCODE_SESSION_DB_PATH: '/exact/session.sqlite', ZCODE_STORAGE_DIR: '/different' })).toBe('/exact/session.sqlite');
    expect(zcodeSessionDbPath({ ZCODE_SESSION_DB: '/legacy/session.sqlite' })).toBe('/legacy/session.sqlite');
  });
});
