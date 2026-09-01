/**
 * 直接读/改/播种会话行持久层的测试夹具。会话库只有 SQLite 一种引擎：
 * per-bot 落在 `session-stores/<appId>/sessions.db`，legacy 无 appId 落在扁平
 * `sessions.db`。迁移前的 `sessions*.json` 只是**一次性导入源**，播种它请直接
 * 写文件（见各测试里的 seedJson），不要走本模块。
 */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  row TEXT NOT NULL,
  chat_id TEXT GENERATED ALWAYS AS (json_extract(row, '$.chatId')) VIRTUAL,
  root_message_id TEXT GENERATED ALWAYS AS (json_extract(row, '$.rootMessageId')) VIRTUAL,
  scope TEXT GENERATED ALWAYS AS (json_extract(row, '$.scope')) VIRTUAL
);
`;

export function sessionStorePath(dataDir: string, appId?: string): string {
  return appId
    ? join(dataDir, 'session-stores', appId, 'sessions.db')
    : join(dataDir, 'sessions.db');
}

function open(path: string, create: boolean): DatabaseSync {
  if (create) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 3000');
  if (create) db.exec(SCHEMA_SQL);
  return db;
}

/**
 * 播种一个 store 的若干行（键 → 行对象），模拟「另一个 bot 的 daemon 已经写过盘」。
 * 键与 `row.sessionId` 可以故意不一致，用来覆盖脏行场景。
 */
export function seedPersistedSessionRows(
  dataDir: string,
  appId: string | undefined,
  rows: Record<string, any>,
): string {
  const path = sessionStorePath(dataDir, appId);
  const db = open(path, true);
  try {
    const insert = db.prepare(
      'INSERT OR REPLACE INTO sessions (session_id, status, row) VALUES (?, ?, ?)',
    );
    for (const [key, value] of Object.entries(rows)) {
      insert.run(key, typeof value?.status === 'string' ? value.status : '', JSON.stringify(value));
    }
  } finally {
    db.close();
  }
  return path;
}

/** 读某个 store 的全部行（键 → 行对象）。 */
export function readPersistedSessionRows(dataDir: string, appId?: string): Record<string, any> {
  const path = sessionStorePath(dataDir, appId);
  if (!existsSync(path)) throw new Error(`no session store at ${path}`);
  const db = open(path, false);
  try {
    const rows = db.prepare('SELECT session_id, row FROM sessions').all() as { session_id: string; row: string }[];
    return Object.fromEntries(rows.map(r => [r.session_id, JSON.parse(r.row)]));
  } finally {
    db.close();
  }
}

/** 模拟「另一个进程」直改持久层里的一行。 */
export function mutatePersistedSessionRow(
  dataDir: string,
  appId: string | undefined,
  sessionId: string,
  mutate: (row: any) => void,
): void {
  const path = sessionStorePath(dataDir, appId);
  const db = open(path, false);
  try {
    const hit = db.prepare('SELECT row FROM sessions WHERE session_id = ?').get(sessionId) as { row: string } | undefined;
    if (!hit) throw new Error(`no session row ${sessionId} in ${path}`);
    const row = JSON.parse(hit.row);
    mutate(row);
    db.prepare('UPDATE sessions SET status = ?, row = ? WHERE session_id = ?')
      .run(typeof row?.status === 'string' ? row.status : '', JSON.stringify(row), sessionId);
  } finally {
    db.close();
  }
}
