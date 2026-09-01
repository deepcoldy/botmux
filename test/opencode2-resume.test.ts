/**
 * OpenCode 2.0（opencode2）resume 单测：用假 opencode.db（XDG_DATA_HOME 指向
 * 临时目录）驱动适配器的 SQLite 路径 —— buildArgs 的 --session 解析与文本反查
 * 兜底、checkResumeTargetExists 预检、listResumableSessions、writeInput 的 DB
 * 提交验证 + cliSessionId 捕获。
 *
 * opencode2（next-17135 起）的存储层是 V2 表（session_v2/session_message），
 * 所以 seed 按 V2 结构建表。与 opencode 的差异点断言：
 *   - buildArgs **不注入 --model**（V2 TUI 顶层不接受该标志，传了会打帮助退出）；
 *   - buildArgs **不注入 --prompt**（next-17135 实测只填 composer 不自动提交）→
 *     首条消息走输入队列（passesInitialPromptViaArgs = false），fresh/resume 一致；
 *   - buildResumeCommand 用 `opencode2 -s`；
 *   - 沙盒声明：authPaths 整数据根 + plugins 目录只读暴露。
 *
 * Run:  pnpm vitest run test/opencode2-resume.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { createOpenCode2Adapter } from '../src/adapters/cli/opencode2.js';
import { detectOpenCodeSubmit, snapPartBaseline } from '../src/adapters/cli/opencode.js';
import { opencodeDbPath } from '../src/services/opencode-paths.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const BOTMUX_SESSION_ID = '0a1b2c3d-1111-4222-8333-444455556666';

let tmpRoot: string;
let savedXdg: string | undefined;

function openDb(): DatabaseSync {
  const dbPath = opencodeDbPath();
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // opencode2（next-17135 起）的存储层是 V2 表（session_v2/session_message），
  // V1 的 session/message/part 已冻结 —— 单测必须按 V2 结构 seed。
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'global',
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT,
      directory TEXT NOT NULL,
      path TEXT,
      title TEXT,
      version TEXT NOT NULL DEFAULT '0.0.0-test',
      cost REAL DEFAULT 0,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0,
      tokens_cache_read INTEGER DEFAULT 0,
      tokens_cache_write INTEGER DEFAULT 0,
      agent TEXT,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      time_suspended INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
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
  db.prepare('INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(opts.id, 'global', opts.parentId ?? null, 't', opts.directory ?? tmpRoot, opts.title ?? 'seeded', '0.0.0-test', opts.timeUpdated ?? 1000, opts.timeUpdated ?? 1000, opts.timeArchived ?? null);
}

function seedUserPart(db: DatabaseSync, sessionId: string, text: string, timeCreated: number): void {
  const mid = `msg_${++idSeq}`;
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run(mid, sessionId, 'user', idSeq, timeCreated, timeCreated, JSON.stringify({ time: { created: timeCreated }, text, files: [], agents: [] }));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oc2-resume-unit-'));
  savedXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tmpRoot;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('opencode2 buildArgs resume', () => {
  it('falls back to the <session_id> text lookup when no cliSessionId persisted', () => {
    const db = openDb();
    seedSession(db, { id: 'ses_old', timeUpdated: 1000 });
    seedSession(db, { id: 'ses_new', timeUpdated: 2000 });
    seedUserPart(db, 'ses_old', `<session_id>${BOTMUX_SESSION_ID}</session_id>\n\nhi`, 1000);
    seedUserPart(db, 'ses_new', `<session_id>${BOTMUX_SESSION_ID}</session_id>\n\nlater turn`, 2000);
    db.close();

    const adapter = createOpenCode2Adapter();
    const args = adapter.buildArgs({ sessionId: BOTMUX_SESSION_ID, resume: true });
    expect(args).toEqual(['--session', 'ses_new']);
  });

  it('prefers the persisted cliSessionId over the text lookup', () => {
    const db = openDb();
    seedSession(db, { id: 'ses_bytext' });
    seedUserPart(db, 'ses_bytext', `<session_id>${BOTMUX_SESSION_ID}</session_id>`, 1000);
    db.close();

    const adapter = createOpenCode2Adapter();
    const args = adapter.buildArgs({ sessionId: BOTMUX_SESSION_ID, resume: true, resumeSessionId: 'ses_persisted' });
    expect(args).toEqual(['--session', 'ses_persisted']);
  });

  it('never injects --model (V2 TUI top-level rejects it with help-and-exit)', () => {
    const adapter = createOpenCode2Adapter();
    const args = adapter.buildArgs({
      sessionId: BOTMUX_SESSION_ID,
      resume: false,
      model: 'anthropic/claude-sonnet-4',
    });
    expect(args).toEqual([]);
  });

  it('does not inject --prompt (next-17135 only fills the composer, never submits)', () => {
    const db = openDb();
    seedSession(db, { id: 'ses_x' });
    db.close();

    const adapter = createOpenCode2Adapter();
    const args = adapter.buildArgs({
      sessionId: BOTMUX_SESSION_ID,
      resume: true,
      resumeSessionId: 'ses_x',
      initialPrompt: 'first lark message',
    });
    // 首条消息改走输入队列（paste+Enter，DB 验证），不依赖 args 自动提交
    expect(args).toEqual(['--session', 'ses_x']);
    expect(adapter.passesInitialPromptViaArgs).toBe(false);
  });
});

describe('opencode2 checkResumeTargetExists', () => {
  it('true when the session row exists', () => {
    const db = openDb();
    seedSession(db, { id: 'ses_here' });
    db.close();
    const adapter = createOpenCode2Adapter();
    expect(adapter.checkResumeTargetExists!({ sessionId: BOTMUX_SESSION_ID, cliSessionId: 'ses_here' })).toBe(true);
  });

  it('false when the session row is gone (prevents "Session not found" crash-loop)', () => {
    const db = openDb();
    seedSession(db, { id: 'ses_other' });
    db.close();
    const adapter = createOpenCode2Adapter();
    expect(adapter.checkResumeTargetExists!({ sessionId: BOTMUX_SESSION_ID, cliSessionId: 'ses_gone' })).toBe(false);
  });

  it('false when nothing resolvable (fresh fallback with user notice)', () => {
    openDb().close();
    const adapter = createOpenCode2Adapter();
    expect(adapter.checkResumeTargetExists!({ sessionId: BOTMUX_SESSION_ID })).toBe(false);
  });

  it('undefined when the DB does not exist (secondary guard handles it)', () => {
    const adapter = createOpenCode2Adapter();
    expect(adapter.checkResumeTargetExists!({ sessionId: BOTMUX_SESSION_ID, cliSessionId: 'ses_x' })).toBeUndefined();
  });
});

describe('opencode2 buildResumeCommand', () => {
  it('emits opencode2 -s with the known id', () => {
    const adapter = createOpenCode2Adapter();
    expect(adapter.buildResumeCommand!({ sessionId: BOTMUX_SESSION_ID, cliSessionId: 'ses_abc123' })).toBe('opencode2 -s ses_abc123');
  });

  it('returns null when nothing resolvable', () => {
    openDb().close();
    const adapter = createOpenCode2Adapter();
    expect(adapter.buildResumeCommand!({ sessionId: BOTMUX_SESSION_ID })).toBeNull();
  });
});

describe('opencode2 listResumableSessions', () => {
  it('lists top-level, unarchived sessions with existing directories, newest first', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_a', timeUpdated: 3000, title: 'newest' });
    seedSession(db, { id: 'ses_b', timeUpdated: 2000, title: 'older' });
    seedSession(db, { id: 'ses_child', timeUpdated: 5000, parentId: 'ses_a' });
    seedSession(db, { id: 'ses_archived', timeUpdated: 4000, timeArchived: 4100 });
    seedSession(db, { id: 'ses_gone_dir', timeUpdated: 4500, directory: join(tmpRoot, 'no-such-dir') });
    db.close();

    const adapter = createOpenCode2Adapter();
    const rows = await adapter.listResumableSessions!({ limit: 10 });
    expect(rows.map(r => r.cliSessionId)).toEqual(['ses_a', 'ses_b']);
    expect(rows[0]).toMatchObject({ title: 'newest', cwd: tmpRoot, lastActivityAt: 3000 });
  });

  it('applies exclude before limit', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_live', timeUpdated: 3000 });
    seedSession(db, { id: 'ses_free', timeUpdated: 2000 });
    db.close();

    const adapter = createOpenCode2Adapter();
    const rows = await adapter.listResumableSessions!({ limit: 1, exclude: new Set(['ses_live']) });
    expect(rows.map(r => r.cliSessionId)).toEqual(['ses_free']);
  });
});

describe('opencode2 writeInput DB verification', () => {
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
    const pty = stubPty(() => {
      if (pty.enters === 1) seedUserPart(db, 'ses_target', content, Date.now());
    });

    const adapter = createOpenCode2Adapter();
    const result = await adapter.writeInput(pty, content);
    db.close();
    expect(result).toMatchObject({ submitted: true, cliSessionId: 'ses_target' });
  });

  it('does not re-match an identical pre-existing message (strict > baseline)', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_target' });
    const content = 'same text resent';
    seedUserPart(db, 'ses_target', content, Date.now());
    db.close();
    const pty = stubPty();

    const adapter = createOpenCode2Adapter();
    const result = await adapter.writeInput(pty, content);
    expect(result).toMatchObject({ submitted: false });
    expect((result as any).recheck).toBeTypeOf('function');
  }, 15_000);

  it('still matches when >20 non-text user rows land after the baseline (LIMIT window not consumed by them)', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_target' });
    const content = `non-text flood then text`;
    for (let i = 0; i < 25; i++) {
      const mid = `msg_noise_${i}`;
      db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
        .run(mid, 'ses_target', 'user', 1000 + i, Date.now() - 1000 + i, Date.now() - 1000 + i, JSON.stringify({ time: { created: Date.now() - 1000 + i }, files: [{ path: `/tmp/f${i}` }] }));
    }
    const pty = stubPty(() => {
      if (pty.enters === 1) seedUserPart(db, 'ses_target', content, Date.now());
    });

    const adapter = createOpenCode2Adapter();
    const result = await adapter.writeInput(pty, content);
    db.close();
    expect(result).toMatchObject({ submitted: true, cliSessionId: 'ses_target' });
  }, 15_000);

  it('skips verification for slash commands (TUI command palette, no user row)', async () => {
    openDb().close();
    const events: string[] = [];
    const pty: PtyHandle & { enters: number } = {
      enters: 0,
      write(_data: string) {},
      sendText(text: string) { events.push(`text:${text}`); },
      pasteText(text: string) { events.push(`paste:${text}`); },
      sendSpecialKeys(...keys: string[]) {
        events.push(`key:${keys.join('+')}`);
        pty.enters++;
      },
    };
    const adapter = createOpenCode2Adapter();
    const result = await adapter.writeInput(pty, '/help');
    expect(result).toBeUndefined();
    expect(pty.enters).toBe(1);
    expect(events).toEqual(['text:/help', 'key:Enter']);
  });

  it('stays blind (undefined) when the DB is missing', async () => {
    const pty = stubPty();
    const adapter = createOpenCode2Adapter();
    const result = await adapter.writeInput(pty, 'no db yet');
    expect(result).toBeUndefined();
  });

  it('recognizes the submission when OpenCode2 prepends a Directory Context block to the stored user part', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_target' });
    const content = `<session_id>${BOTMUX_SESSION_ID}</session_id>\n\n<user_message>\nhello from lark\n</user_message>`;
    const storedText = `[Directory Context: ${tmpRoot}/AGENTS.md]\n\n${content}`;
    const pty = stubPty(() => {
      if (pty.enters === 1) seedUserPart(db, 'ses_target', storedText, Date.now());
    });

    const adapter = createOpenCode2Adapter();
    const result = await adapter.writeInput(pty, content);
    db.close();
    expect(result).toMatchObject({ submitted: true, cliSessionId: 'ses_target' });
  }, 15_000);

  it('does not confirm an unrelated same-session row when the expected text lacks a user-message section', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_target' });
    const content = `<session_id>${BOTMUX_SESSION_ID}</session_id>\n\nexpected payload`;
    const baseline = snapPartBaseline('v2');
    seedUserPart(
      db,
      'ses_target',
      `[Directory Context: ${tmpRoot}/AGENTS.md]\n\n<session_id>${BOTMUX_SESSION_ID}</session_id>\n\nunrelated payload`,
      Date.now(),
    );
    const pty = stubPty();

    const result = await detectOpenCodeSubmit(pty, baseline, content, async () => {}, 'v2');
    db.close();
    expect(result.submitted).toBe(false);
    expect(pty.enters).toBe(3);
  });
});

describe('opencode2 detectOpenCodeSubmit retry behaviour', () => {
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

  it('does not send a retry Enter when the record lands during the 800ms wait', async () => {
    const db = openDb();
    seedSession(db, { id: 'ses_target' });
    const content = `<session_id>${BOTMUX_SESSION_ID}</session_id>\n\n<user_message>\nhello from lark\n</user_message>`;
    let waits = 0;
    const pty = stubPty();
    const delayFn = async () => {
      waits++;
      if (waits === 1) seedUserPart(db, 'ses_target', content, Date.now());
    };
    const baseline = snapPartBaseline('v2');
    const result = await detectOpenCodeSubmit(pty, baseline, content, delayFn, 'v2');
    db.close();
    expect(result).toMatchObject({ submitted: true, cliSessionId: 'ses_target' });
    expect(pty.enters).toBe(0);  // 等待期间已确认，不再补发重试 Enter
  });
});

describe('opencode2 sandbox surface', () => {
  it('keeps the whole opencode data dir real (shared SQLite DB needs fcntl locks)', () => {
    const adapter = createOpenCode2Adapter();
    expect(adapter.authPaths).toEqual(['~/.local/share/opencode']);
  });

  it('exposes the global plugins dir read-only so the V2 ask plugin can load', () => {
    const adapter = createOpenCode2Adapter();
    expect(adapter.sandboxReadonlyPaths!()).toEqual(['~/.config/opencode/plugins']);
  });
});
