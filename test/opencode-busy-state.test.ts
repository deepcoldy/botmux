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
  // —— 真实 OpenCode 2.0.x（实测 2.0.32）行形状 ——
  // assistant 消息把 part 嵌在 data.content[] 里；回合 drain 后写 type='idle' 行。
  const insertV2 = (
    db: DatabaseSync,
    sid: string,
    id: string,
    type: 'user' | 'assistant' | 'idle',
    created: number,
    data: Record<string, unknown>,
  ) => {
    db.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
      .run(id, sid, type, created, created, JSON.stringify(data));
  };
  const assistant = (created: number, completed?: number, content: unknown[] = []) => ({
    time: completed === undefined ? { created } : { created, completed },
    content,
  });
  const toolPart = (status: 'running' | 'completed') => ({ type: 'tool', tool: 'bash', state: { status } });

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

  // —— 真实 v2.0.x 行形状回归（问题：旧查询只看顶层 $.state.status，对 2.0.32 100% 漏检；
  //    且把「步骤间空档」误判为整轮空闲，导致卡片提前翻「等待输入」并提前放行回合权威）——
  it('returns true for a nested running tool part inside a completed assistant message (real v2 shape)', () => {
    const db = openV2Db();
    const sid = 'ses_v2_nested_running';
    const now = Date.now();
    insertV2(db, sid, `msg_${++idSeq}`, 'user', now - 2_000, { time: { created: now - 2_000 }, text: 'go' });
    insertV2(db, sid, `msg_${++idSeq}`, 'assistant', now - 1_000,
      assistant(now - 1_000, now, [toolPart('running')]));
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(true);
  });

  it('returns true in the inter-step gap: last assistant completed but no idle marker yet', () => {
    const db = openV2Db();
    const sid = 'ses_v2_step_gap';
    const now = Date.now();
    insertV2(db, sid, `msg_${++idSeq}`, 'user', now - 8_000, { time: { created: now - 8_000 }, text: 'multi step' });
    insertV2(db, sid, `msg_${++idSeq}`, 'assistant', now - 7_000,
      assistant(now - 7_000, now - 5_000, [toolPart('completed')]));
    // 下一条 assistant 消息尚未落库（relay 思考 / DB 提交延迟）——旧逻辑在这里返回 false
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(true);
  });

  it('returns true after submit but before the first assistant message is persisted', () => {
    const db = openV2Db();
    const sid = 'ses_v2_pre_first_assistant';
    const now = Date.now();
    insertV2(db, sid, `msg_${++idSeq}`, 'user', now - 800, { time: { created: now - 800 }, text: 'hi' });
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(true);
  });

  it('returns false once the authoritative idle marker is written after the last assistant', () => {
    const db = openV2Db();
    const sid = 'ses_v2_idle_marker';
    const now = Date.now();
    insertV2(db, sid, `msg_${++idSeq}`, 'user', now - 6_000, { time: { created: now - 6_000 }, text: 'hi' });
    insertV2(db, sid, `msg_${++idSeq}`, 'assistant', now - 5_000,
      assistant(now - 5_000, now - 100, [{ type: 'text' }]));
    insertV2(db, sid, `msg_${++idSeq}`, 'idle', now, { time: { created: now }, outcome: 'succeeded' });
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(false);
  });

  it('returns false on idle even when outcome is failed or interrupted', () => {
    const db = openV2Db();
    const sid = 'ses_v2_idle_failed';
    const now = Date.now();
    insertV2(db, sid, `msg_${++idSeq}`, 'user', now - 3_000, { time: { created: now - 3_000 }, text: 'x' });
    insertV2(db, sid, `msg_${++idSeq}`, 'idle', now, { time: { created: now }, outcome: 'failed' });
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(false);
  });

  it('does not let running parts older than the idle marker keep the session busy', () => {
    const db = openV2Db();
    const sid = 'ses_v2_idle_scopes_cutoff';
    const now = Date.now();
    insertV2(db, sid, `msg_${++idSeq}`, 'user', now - 6_000, { time: { created: now - 6_000 }, text: 'x' });
    insertV2(db, sid, `msg_${++idSeq}`, 'assistant', now - 5_000,
      assistant(now - 5_000, now - 4_000, [toolPart('running') /* 防御性构造：真实流水线不会在此留下 running */]));
    insertV2(db, sid, `msg_${++idSeq}`, 'idle', now - 3_000, { time: { created: now - 3_000 }, outcome: 'succeeded' });
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(false);
  });

  it('returns true when a new turn is submitted after an idle marker', () => {
    const db = openV2Db();
    const sid = 'ses_v2_next_turn_open';
    const now = Date.now();
    insertV2(db, sid, `msg_${++idSeq}`, 'user', now - 30_000, { time: { created: now - 30_000 }, text: 'one' });
    insertV2(db, sid, `msg_${++idSeq}`, 'idle', now - 25_000, { time: { created: now - 25_000 }, outcome: 'succeeded' });
    insertV2(db, sid, `msg_${++idSeq}`, 'user', now - 1_000, { time: { created: now - 1_000 }, text: 'two' });
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(true);
  });

  it('fails open (not busy) for a stale open user message older than the freshness window', () => {
    const db = openV2Db();
    const sid = 'ses_v2_stale_user_orphan';
    const stale = Date.now() - 600_000;
    insertV2(db, sid, `msg_${++idSeq}`, 'user', stale, { time: { created: stale }, text: 'crashed turn' });
    db.close();

    expect(isOpenCodeSessionBusy(sid, 'v2')).toBe(false);
  });

  it('tracks a realistic three-tool turn: busy in every gap, idle only after the marker', () => {
    const db = openV2Db();
    const sid = 'ses_v2_three_tool_timeline';
    const now = Date.now();
    const busyAt = () => isOpenCodeSessionBusy(sid, 'v2');
    insertV2(db, sid, `msg_${++idSeq}`, 'user', now - 20_000, { time: { created: now - 20_000 }, text: 'three tools' });
    expect(busyAt()).toBe(true); // 提交后、首个 assistant 前
    insertV2(db, sid, `msg_${++idSeq}`, 'assistant', now - 19_000,
      assistant(now - 19_000, now - 17_000, [toolPart('completed')]));
    expect(busyAt()).toBe(true); // 步骤 1→2 空档
    insertV2(db, sid, `msg_${++idSeq}`, 'assistant', now - 16_000,
      assistant(now - 16_000, now - 14_000, [toolPart('completed')]));
    expect(busyAt()).toBe(true); // 步骤 2→3 空档
    insertV2(db, sid, `msg_${++idSeq}`, 'assistant', now - 10_000,
      assistant(now - 10_000, undefined, [toolPart('running')]));
    expect(busyAt()).toBe(true); // 工具执行中（未完成 assistant + 嵌套 running）
    insertV2(db, sid, `msg_${++idSeq}`, 'assistant', now - 9_000,
      assistant(now - 9_000, now - 200, [toolPart('completed'), { type: 'text' }]));
    expect(busyAt()).toBe(true); // 最终回复已完成，idle 标记写入前的最后窗口
    insertV2(db, sid, `msg_${++idSeq}`, 'idle', now, { time: { created: now }, outcome: 'succeeded' });
    expect(busyAt()).toBe(false); // 整轮结束
    db.close();
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
