/**
 * OpenCode busy state detection 单测：
 * 验证基于 SQLite 状态（part 表 running 状态、message 表 completed 状态）
 * 以及时效窗口（freshness window）对 OpenCode (V1) 和 OpenCode2 (V2) 会话忙碌态的精准识别与死锁防范。
 *
 * Run:  npx vitest run test/opencode-busy-state.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { createOpenCodeAdapter, isOpenCodeSessionBusy } from '../src/adapters/cli/opencode.js';
import { createOpenCode2Adapter } from '../src/adapters/cli/opencode2.js';
import { opencodeDbPath } from '../src/services/opencode-paths.js';

const BOTMUX_SESSION_ID = '0a1b2c3d-1111-4222-8333-444455556666';

let tmpRoot: string;
let savedXdg: string | undefined;

function openV1Db(): DatabaseSync {
  const dbPath = opencodeDbPath();
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL DEFAULT 0,
      time_archived INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );
  `);
  return db;
}

function openV2Db(): DatabaseSync {
  const dbPath = opencodeDbPath();
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_v2 (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  return db;
}

let idSeq = 0;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oc-busy-unit-'));
  savedXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tmpRoot;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('isOpenCodeSessionBusy V1', () => {
  it('returns true when a fresh tool part is running', () => {
    const db = openV1Db();
    const sid = 'ses_v1_running_tool';
    const mid = `msg_${++idSeq}`;
    const now = Date.now();
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
      .run(mid, sid, now, JSON.stringify({ role: 'assistant', time: { created: now } }));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)')
      .run(`prt_${++idSeq}`, mid, sid, now, JSON.stringify({
        type: 'tool',
        tool: 'bash',
        state: { status: 'running' },
      }));
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v1')).toBe(true);
  });

  it('returns true when a fresh assistant message is not completed yet', () => {
    const db = openV1Db();
    const sid = 'ses_v1_generating';
    const mid = `msg_${++idSeq}`;
    const now = Date.now();
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
      .run(mid, sid, now, JSON.stringify({ role: 'assistant', time: { created: now } }));
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v1')).toBe(true);
  });

  it('returns false for stale incomplete message (older than freshness window, e.g. crashed process)', () => {
    const db = openV1Db();
    const sid = 'ses_v1_stale_crash';
    const mid = `msg_${++idSeq}`;
    // 10 分钟前的未完成消息
    const staleTime = Date.now() - 600_000;
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
      .run(mid, sid, staleTime, JSON.stringify({ role: 'assistant', time: { created: staleTime } }));
    db.close();

    // 默认 2 分钟时效窗口，10 分钟前的不应判定为忙碌（防止死锁）
    expect(isOpenCodeSessionBusy(sid, 'v1')).toBe(false);
  });

  it('returns false for stale running tool (older than freshness window)', () => {
    const db = openV1Db();
    const sid = 'ses_v1_stale_tool';
    const mid = `msg_${++idSeq}`;
    const staleTime = Date.now() - 600_000;
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
      .run(mid, sid, staleTime, JSON.stringify({ role: 'assistant', time: { created: staleTime } }));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)')
      .run(`prt_${++idSeq}`, mid, sid, staleTime, JSON.stringify({
        type: 'tool',
        tool: 'bash',
        state: { status: 'running' },
      }));
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v1')).toBe(false);
  });

  it('returns false when assistant message is completed with finish stop and no running parts', () => {
    const db = openV1Db();
    const sid = 'ses_v1_done';
    const mid = `msg_${++idSeq}`;
    const now = Date.now();
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
      .run(mid, sid, now, JSON.stringify({
        role: 'assistant',
        finish: 'stop',
        time: { created: now, completed: now + 500 },
      }));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)')
      .run(`prt_${++idSeq}`, mid, sid, now, JSON.stringify({
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed' },
      }));
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v1')).toBe(false);
  });

  it('returns false when assistant message is completed even if finish is tool-calls (no running parts left)', () => {
    const db = openV1Db();
    const sid = 'ses_v1_completed_tool_calls';
    const mid = `msg_${++idSeq}`;
    const now = Date.now();
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
      .run(mid, sid, now, JSON.stringify({
        role: 'assistant',
        finish: 'tool-calls',
        time: { created: now, completed: now + 500 },
      }));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)')
      .run(`prt_${++idSeq}`, mid, sid, now, JSON.stringify({
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed' },
      }));
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v1')).toBe(false);
  });
});

describe('isOpenCodeSessionBusy V2', () => {
  it('returns true when a fresh tool part is running in session_message', () => {
    const db = openV2Db();
    const sid = 'ses_v2_running';
    const now = Date.now();
    db.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
      .run(`msg_${++idSeq}`, sid, 'tool', now, now, JSON.stringify({
        type: 'tool',
        state: { status: 'running' },
      }));
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(true);
  });

  it('returns true when fresh assistant message is incomplete in session_message', () => {
    const db = openV2Db();
    const sid = 'ses_v2_incomp';
    const now = Date.now();
    db.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
      .run(`msg_${++idSeq}`, sid, 'assistant', now, now, JSON.stringify({
        time: { created: now },
      }));
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(true);
  });

  it('returns false for stale incomplete message in V2', () => {
    const db = openV2Db();
    const sid = 'ses_v2_stale';
    const staleTime = Date.now() - 600_000;
    db.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
      .run(`msg_${++idSeq}`, sid, 'assistant', staleTime, staleTime, JSON.stringify({
        time: { created: staleTime },
      }));
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(false);
  });

  it('returns false when assistant message is completed in session_message', () => {
    const db = openV2Db();
    const sid = 'ses_v2_done';
    const now = Date.now();
    db.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
      .run(`msg_${++idSeq}`, sid, 'assistant', now, now, JSON.stringify({
        finish: 'stop',
        time: { created: now, completed: now + 500 },
      }));
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(false);
  });
});

describe('createOpenCodeAdapter isSessionBusy', () => {
  it('identifies busy state using cliSessionId and fallback session id text lookup', () => {
    const db = openV1Db();
    const sid = 'ses_adapterTest';
    const userMid = `msg_${++idSeq}`;
    const asstMid = `msg_${++idSeq}`;
    const now = Date.now();

    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
      .run(userMid, sid, now - 1000, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)')
      .run(`prt_${++idSeq}`, userMid, sid, now - 1000, JSON.stringify({
        type: 'text',
        text: `<session_id>${BOTMUX_SESSION_ID}</session_id>\n\nhello`,
      }));

    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
      .run(asstMid, sid, now, JSON.stringify({ role: 'assistant', time: { created: now } }));
    db.close();

    const adapter = createOpenCodeAdapter();
    expect(adapter.isSessionBusy).toBeDefined();

    // 1. Direct cliSessionId lookup
    expect(adapter.isSessionBusy?.({ sessionId: 'dummy', cliSessionId: sid })).toBe(true);

    // 2. Fallback via embedded botmux session id
    expect(adapter.isSessionBusy?.({ sessionId: BOTMUX_SESSION_ID })).toBe(true);
  });
});

describe('createOpenCode2Adapter isSessionBusy', () => {
  it('identifies busy state in V2 tables', () => {
    const db = openV2Db();
    const sid = 'ses_v2AdapterTest';
    const now = Date.now();
    db.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
      .run(`msg_${++idSeq}`, sid, 'user', now - 1000, now - 1000, JSON.stringify({
        text: `<session_id>${BOTMUX_SESSION_ID}</session_id>`,
      }));
    db.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
      .run(`msg_${++idSeq}`, sid, 'assistant', now, now, JSON.stringify({
        time: { created: now },
      }));
    db.close();

    const adapter = createOpenCode2Adapter();
    expect(adapter.isSessionBusy).toBeDefined();
    expect(adapter.isSessionBusy?.({ sessionId: BOTMUX_SESSION_ID })).toBe(true);
  });
});
