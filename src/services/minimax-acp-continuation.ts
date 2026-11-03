import { openDatabaseSyncNow, type DatabaseSyncLike } from './sqlite-compat.js';

const json = (value: unknown): Record<string, any> | undefined => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4 * 1024 * 1024) return;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined; } catch { return; }
};

/** Capture the native insertion boundary immediately before session/prompt.
 * SQLite rowids also distinguish requests created in the same millisecond;
 * cancelled turns may leave older pending rows, which this turn must not own.
 * Ordinary turns do not depend on this metadata. Unknown is distinct from an
 * empty table's cursor 0; native questions must fail closed if it is unknown. */
export function minimaxQuestionnaireCursor(databasePath: string, sessionId: string): number | undefined {
  const db = openDatabaseSyncNow(databasePath, { readOnly: true });
  if (!db) return;
  try {
    const row = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS cursor FROM questionnaire_requests WHERE session_id = ?')
      .get(sessionId) as { cursor: number };
    if (!Number.isSafeInteger(row.cursor) || row.cursor < 0) return;
    return row.cursor;
  } catch { return; }
  finally { try { db.close(); } catch { /* best-effort metadata */ } }
}

/** mcode 0.6.5 can send end_turn for the requesting turn when its answered
 * questionnaire emits dismiss, before the continuation finishes. Its native
 * durable ingress is the completion proof; do not kill that continuation or
 * deliver the pre-question text as the final answer. All reads are session-
 * scoped and read-only, and tied to the actual questionnaire request ids. */
export function pendingMinimaxQuestionnaires(databasePath: string, sessionId: string, afterRowId = 0, required = false): string[] {
  const db = openDatabaseSyncNow(databasePath, { readOnly: true });
  if (!db) { if (required) throw new Error('mcode ACP 无法验证原生问卷：数据库不可读'); return []; }
  try {
    return (db.prepare("SELECT request_id FROM questionnaire_requests WHERE session_id = ? AND rowid > ? AND status = 'pending' ORDER BY rowid DESC LIMIT 16")
      .all(sessionId, afterRowId) as Array<{ request_id: string }>).map(r => r.request_id);
  } finally { db.close(); }
}

/** Native questionnaire answers start another native turn within the same
 * user reply. Follow only the explicit requestId → requester.runId relation. */
export function minimaxUserTurnIds(db: DatabaseSyncLike, sessionId: string, latestTurnId: string): string[] | undefined {
  const ids = [latestTurnId];
  for (let i = 0; i < 32; i++) {
    let row: { source?: string; source_context_json?: string } | undefined;
    try {
      row = db.prepare("SELECT source, source_context_json FROM local_runtime_message_rows WHERE session_id = ? AND turn_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
        .get(sessionId, ids.at(-1)!) as typeof row;
    } catch { return [latestTurnId]; } // older native schemas have no continuation relation
    if (row?.source !== 'questionnaire') return ids;
    const origin = json(row.source_context_json)?.origin;
    if (origin?.kind !== 'questionnaire-response' || typeof origin.requestId !== 'string') return;
    let record: { request_json: string } | undefined;
    try { record = db.prepare('SELECT request_json FROM questionnaire_requests WHERE session_id = ? AND request_id = ?')
      .get(sessionId, origin.requestId) as typeof record; } catch { return; }
    const requester = json(record?.request_json)?.requester;
    if (requester?.sessionId !== sessionId || typeof requester.runId !== 'string' || !requester.runId || ids.includes(requester.runId)) return;
    ids.push(requester.runId);
  }
}

export function readMinimaxContinuation(databasePath: string, sessionId: string, requestIds: ReadonlySet<string>, afterRowId = 0):
  { state: 'waiting' } | { state: 'completed'; content: string } {
  const db = openDatabaseSyncNow(databasePath, { readOnly: true });
  if (!db) throw new Error('mcode ACP 无法验证问卷续跑：原生数据库不可读');
  try {
    db.exec('BEGIN');
    let lastTurn: { turnId: string; completedAt: number } | undefined;
    for (const requestId of requestIds) {
      const q = db.prepare('SELECT status, injected_at FROM questionnaire_requests WHERE session_id = ? AND request_id = ?')
        .get(sessionId, requestId) as { status: string; injected_at?: number } | undefined;
      if (!q) throw new Error('mcode ACP 原生问卷记录缺失');
      if (q.status !== 'answered') {
        if (q.status === 'pending') return { state: 'waiting' };
        throw new Error(`mcode ACP 原生问卷没有成功作答：${q.status}`);
      }
      if (!q.injected_at) return { state: 'waiting' };
      const rows = db.prepare("SELECT turn_id, source_context_json FROM local_runtime_message_rows WHERE session_id = ? AND role = 'user' AND source = 'questionnaire' ORDER BY id DESC LIMIT 64")
        .all(sessionId) as Array<{ turn_id: string; source_context_json: string }>;
      const row = rows.find(r => json(r.source_context_json)?.origin?.requestId === requestId);
      if (!row?.turn_id) return { state: 'waiting' };
      const turn = db.prepare('SELECT status, completed_at_ms FROM local_runtime_turn_ingress WHERE session_id = ? AND turn_id = ?')
        .get(sessionId, row.turn_id) as { status: string; completed_at_ms?: number } | undefined;
      if (!turn || ['accepted', 'running'].includes(turn.status)) return { state: 'waiting' };
      if (turn.status !== 'completed') throw new Error(`mcode ACP 问卷续跑未完成：${turn.status}`);
      if (!turn.completed_at_ms) return { state: 'waiting' };
      if (!lastTurn || turn.completed_at_ms > lastTurn.completedAt) lastTurn = { turnId: row.turn_id, completedAt: turn.completed_at_ms };
    }
    // A continuation can ask another question. Keep its ACP transport alive
    // until that request has also been answered and its continuation completed.
    if (db.prepare("SELECT request_id FROM questionnaire_requests WHERE session_id = ? AND rowid > ? AND status = 'pending' LIMIT 1").get(sessionId, afterRowId)) return { state: 'waiting' };
    if (!lastTurn) throw new Error('mcode ACP 问卷续跑缺少原生轮次');
    const row = db.prepare("SELECT data_json FROM local_runtime_message_rows WHERE session_id = ? AND turn_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get(sessionId, lastTurn.turnId) as { data_json: string } | undefined;
    const message = json(row?.data_json);
    const content = message?.msg_content ?? message?.content;
    if (!message || typeof content !== 'string') throw new Error('mcode ACP 问卷续跑缺少最终回复');
    // Durable assistant messages may end with a tool call rather than a final
    // answer. Treat that as incomplete, not as permission to guess a response.
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) throw new Error('mcode ACP 问卷续跑仍停在工具调用');
    return { state: 'completed', content };
  } finally { try { db.exec('ROLLBACK'); } catch {} db.close(); }
}
