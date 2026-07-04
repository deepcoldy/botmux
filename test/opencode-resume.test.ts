/**
 * OpenCode resume 单测：用假 opencode.db（XDG_DATA_HOME 指向临时目录）驱动
 * 适配器的 SQLite 路径 —— buildArgs 的 --session 解析与文本反查兜底、
 * checkResumeTargetExists 预检、listResumableSessions、writeInput 的
 * DB 提交验证 + cliSessionId 捕获。
 *
 * Run:  pnpm vitest run test/opencode-resume.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { opencodeDbPath } from '../src/services/opencode-paths.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const BOTMUX_SESSION_ID = '0a1b2c3d-1111-4222-8333-444455556666';

let tmpRoot: string;
let savedXdg: string | undefined;

function openDb(): DatabaseSync {
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
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  return db;
}

let idSeq = 0;

function seedSession(db: DatabaseSync, opts: {
  id: string; directory?: string; title?: string; parentId?: string | null;
  timeUpdated?: number; timeArchived?: number | null;
}): void {
  db.prepare('INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?)')
    .run(opts.id, opts.parentId ?? null, opts.directory ?? tmpRoot, opts.title ?? 'seeded', opts.timeUpdated ?? 1000, opts.timeUpdated ?? 1000, opts.timeArchived ?? null);
}

function seedUserPart(db: DatabaseSync, sessionId: string, text: string, timeCreated: number): void {
  const mid = `msg_${++idSeq}`;
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
    .run(mid, sessionId, timeCreated, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)')
    .run(`prt_${++idSeq}`, mid, sessionId, timeCreated, JSON.stringify({ type: 'text', text }));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oc-resume-unit-'));
  savedXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tmpRoot;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('opencode buildArgs resume', () => {
  it('falls back to the <session_id> text lookup when no cliSessionId persisted', () => {
    const db = openDb();
    seedSession(db, { id: 'ses_old', timeUpdated: 1000 });
    seedSession(db, { id: 'ses_new', timeUpdated: 2000 });
    seedUserPart(db, 'ses_old', `<session_id>${BOTMUX_SESSION_ID}</session_id>\n\nhi`, 1000);
    seedUserPart(db, 'ses_new', `<session_id>${BOTMUX_SESSION_ID}</session_id>\n\nlater turn`, 2000);
    db.close();

    const adapter = createOpenCodeAdapter();
    const args = adapter.buildArgs({ sessionId: BOTMUX_SESSION_ID, resume: true });
    // 命中最近的那个 OpenCode 会话（同一 botmux 会话曾 fresh 降级重开时取最新）
    expect(args).toEqual(['--session', 'ses_new']);
  });

  it('prefers the persisted cliSessionId over the text lookup', () => {
    const db = openDb();
    seedSession(db, { id: 'ses_bytext' });
    seedUserPart(db, 'ses_bytext', `<session_id>${BOTMUX_SESSION_ID}</session_id>`, 1000);
    db.close();

    const adapter = createOpenCodeAdapter();
    const args = adapter.buildArgs({ sessionId: BOTMUX_SESSION_ID, resume: true, resumeSessionId: 'ses_persisted' });
    expect(args).toEqual(['--session', 'ses_persisted']);
  });

  it('keeps model flag ordering with --session', () => {
    const adapter = createOpenCodeAdapter();
    const args = adapter.buildArgs({ sessionId: BOTMUX_SESSION_ID, resume: true, resumeSessionId: 'ses_x', model: 'anthropic/claude-sonnet-4' });
    expect(args).toEqual(['--model', 'anthropic/claude-sonnet-4', '--session', 'ses_x']);
  });
});

describe('opencode checkResumeTargetExists', () => {
  it('true when the session row exists', () => {
    const db = openDb();
    seedSession(db, { id: 'ses_here' });
    db.close();
    const adapter = createOpenCodeAdapter();
    expect(adapter.checkResumeTargetExists!({ sessionId: BOTMUX_SESSION_ID, cliSessionId: 'ses_here' })).toBe(true);
  });

  it('false when the session row is gone (prevents "Session not found" crash-loop)', () => {
    const db = openDb();
    seedSession(db, { id: 'ses_other' });
    db.close();
    const adapter = createOpenCodeAdapter();
    expect(adapter.checkResumeTargetExists!({ sessionId: BOTMUX_SESSION_ID, cliSessionId: 'ses_gone' })).toBe(false);
  });

  it('false when nothing resolvable (fresh fallback with user notice)', () => {
    openDb().close();
    const adapter = createOpenCodeAdapter();
    expect(adapter.checkResumeTargetExists!({ sessionId: BOTMUX_SESSION_ID })).toBe(false);
  });

  it('undefined when the DB does not exist (secondary guard handles it)', () => {
    const adapter = createOpenCodeAdapter();
    expect(adapter.checkResumeTargetExists!({ sessionId: BOTMUX_SESSION_ID, cliSessionId: 'ses_x' })).toBeUndefined();
  });
});

describe('opencode buildResumeCommand', () => {
  it('emits opencode -s with the known id', () => {
    const adapter = createOpenCodeAdapter();
    expect(adapter.buildResumeCommand!({ sessionId: BOTMUX_SESSION_ID, cliSessionId: 'ses_abc123' })).toBe('opencode -s ses_abc123');
  });

  it('returns null when nothing resolvable', () => {
    openDb().close();
    const adapter = createOpenCodeAdapter();
    expect(adapter.buildResumeCommand!({ sessionId: BOTMUX_SESSION_ID })).toBeNull();
  });
});

describe('opencode listResumableSessions', () => {
  it('lists top-level, unarchived sessions with existing directories, newest first', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_a', timeUpdated: 3000, title: 'newest' });
    seedSession(db, { id: 'ses_b', timeUpdated: 2000, title: 'older' });
    seedSession(db, { id: 'ses_child', timeUpdated: 5000, parentId: 'ses_a' });        // 子代理会话
    seedSession(db, { id: 'ses_archived', timeUpdated: 4000, timeArchived: 4100 });     // 已归档
    seedSession(db, { id: 'ses_gone_dir', timeUpdated: 4500, directory: join(tmpRoot, 'no-such-dir') });
    db.close();

    const adapter = createOpenCodeAdapter();
    const rows = await adapter.listResumableSessions!({ limit: 10 });
    expect(rows.map(r => r.cliSessionId)).toEqual(['ses_a', 'ses_b']);
    expect(rows[0]).toMatchObject({ title: 'newest', cwd: tmpRoot, lastActivityAt: 3000 });
  });

  it('applies exclude before limit', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_live', timeUpdated: 3000 });
    seedSession(db, { id: 'ses_free', timeUpdated: 2000 });
    db.close();

    const adapter = createOpenCodeAdapter();
    const rows = await adapter.listResumableSessions!({ limit: 1, exclude: new Set(['ses_live']) });
    expect(rows.map(r => r.cliSessionId)).toEqual(['ses_free']);
  });
});

describe('opencode writeInput DB verification', () => {
  function stubPty(onEnter?: () => void): PtyHandle & { enters: number } {
    const handle = {
      enters: 0,
      write(_data: string) { /* raw pty path unused in this stub */ },
      sendText(_text: string) { /* typed */ },
      sendSpecialKeys(..._keys: string[]) {
        handle.enters++;
        onEnter?.();
      },
    };
    return handle;
  }

  it('captures cliSessionId when the user part lands after the baseline', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_target' });
    seedUserPart(db, 'ses_target', 'earlier turn', 1000);
    const content = `<session_id>${BOTMUX_SESSION_ID}</session_id>\n\nhello from lark`;
    // 模拟 OpenCode：Enter 落下时把 user part 写库
    const pty = stubPty(() => {
      if (pty.enters === 1) seedUserPart(db, 'ses_target', content, Date.now());
    });

    const adapter = createOpenCodeAdapter();
    const result = await adapter.writeInput(pty, content);
    db.close();
    expect(result).toMatchObject({ submitted: true, cliSessionId: 'ses_target' });
  });

  it('does not re-match an identical pre-existing message (strict > baseline)', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_target' });
    const content = 'same text resent';
    seedUserPart(db, 'ses_target', content, Date.now());  // 上一轮同文本，就在基线上
    db.close();
    const pty = stubPty();

    const adapter = createOpenCodeAdapter();
    const result = await adapter.writeInput(pty, content);
    expect(result).toMatchObject({ submitted: false });
    expect((result as any).recheck).toBeTypeOf('function');
  }, 15_000);

  it('skips verification for slash commands (TUI command palette, no user row)', async () => {
    openDb().close();
    const pty = stubPty();
    const adapter = createOpenCodeAdapter();
    const result = await adapter.writeInput(pty, '/help');
    expect(result).toBeUndefined();
    expect(pty.enters).toBe(1);  // 无重试 Enter，避免误触面板
  });

  it('stays blind (undefined) when the DB is missing', async () => {
    const pty = stubPty();
    const adapter = createOpenCodeAdapter();
    const result = await adapter.writeInput(pty, 'no db yet');
    expect(result).toBeUndefined();
  });
});
