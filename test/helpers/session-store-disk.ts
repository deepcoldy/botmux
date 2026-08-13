/**
 * 直接读/改会话行持久层的测试夹具，按运行时的混合窗口规则解析引擎：
 * 「有 .db 用 .db，否则用 .json」。引擎替换后 daemon store 落在 sessions*.db
 * （既有 JSON 冻结），但夹具保持两种引擎都可用，方便混合窗口场景直接播种 JSON。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function storePaths(dataDir: string, appId?: string): { db: string; json: string } {
  return {
    db: appId ? join(dataDir, 'session-stores', appId, 'sessions.db') : join(dataDir, 'sessions.db'),
    json: join(dataDir, appId ? `sessions-${appId}.json` : 'sessions.json'),
  };
}

/** db-else-json 读某个 store 的全部行（键 → 行对象）。 */
export function readPersistedSessionRows(dataDir: string, appId?: string): Record<string, any> {
  const { db, json } = storePaths(dataDir, appId);
  if (existsSync(db)) {
    const conn = new DatabaseSync(db);
    try {
      conn.exec('PRAGMA busy_timeout = 3000');
      const rows = conn.prepare('SELECT session_id, row FROM sessions').all() as { session_id: string; row: string }[];
      return Object.fromEntries(rows.map(r => [r.session_id, JSON.parse(r.row)]));
    } finally {
      conn.close();
    }
  }
  return JSON.parse(readFileSync(json, 'utf8'));
}

/** 模拟「另一个进程」直改持久层里的一行（旧夹具直接改 JSON 文件的等价物）。 */
export function mutatePersistedSessionRow(
  dataDir: string,
  appId: string | undefined,
  sessionId: string,
  mutate: (row: any) => void,
): void {
  const { db, json } = storePaths(dataDir, appId);
  if (existsSync(db)) {
    const conn = new DatabaseSync(db);
    try {
      conn.exec('PRAGMA busy_timeout = 3000');
      const hit = conn.prepare('SELECT row FROM sessions WHERE session_id = ?').get(sessionId) as { row: string } | undefined;
      if (!hit) throw new Error(`no session row ${sessionId} in ${db}`);
      const row = JSON.parse(hit.row);
      mutate(row);
      conn.prepare('UPDATE sessions SET status = ?, row = ? WHERE session_id = ?')
        .run(typeof row?.status === 'string' ? row.status : '', JSON.stringify(row), sessionId);
    } finally {
      conn.close();
    }
    return;
  }
  const projection = JSON.parse(readFileSync(json, 'utf8')) as Record<string, any>;
  mutate(projection[sessionId]);
  writeFileSync(json, JSON.stringify(projection, null, 2));
}
