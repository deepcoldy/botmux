import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncNow, type DatabaseSyncLike } from '../src/services/sqlite-compat.js';
import { minimaxQuestionnaireCursor, pendingMinimaxQuestionnaires, readMinimaxContinuation, minimaxUserTurnIds } from '../src/services/minimax-acp-continuation.js';
let root: string; let path: string; let db: DatabaseSyncLike;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-acp-continuation-')); path = join(root, 'native.sqlite');
  db = openDatabaseSyncNow(path)!;
  db.exec(`CREATE TABLE questionnaire_requests (request_id TEXT,session_id TEXT,status TEXT,injected_at INTEGER,created_at INTEGER);
    CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,source TEXT,turn_id TEXT,source_context_json TEXT,data_json TEXT);
    CREATE TABLE local_runtime_turn_ingress (session_id TEXT,turn_id TEXT,status TEXT,completed_at_ms INTEGER);`);
  db.prepare('INSERT INTO questionnaire_requests VALUES (?,?,?,?,?)').run('question', 'native', 'pending', null, 1);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
const read = () => readMinimaxContinuation(path, 'native', new Set(['question']));
const JSON_LIMIT = 4 * 1024 * 1024;
function paddedJson(value: object, bytes: number): string {
  const base = JSON.stringify({ ...value, padding: '' });
  const padding = '界'.repeat(Math.floor((bytes - Buffer.byteLength(base)) / 3));
  const encoded = JSON.stringify({ ...value, padding });
  const result = encoded + ' '.repeat(bytes - Buffer.byteLength(encoded));
  expect(Buffer.byteLength(result)).toBe(bytes);
  expect(result.length).toBeLessThan(JSON_LIMIT);
  return result;
}
function answered(status = 'accepted') {
  db.exec("UPDATE questionnaire_requests SET status='answered', injected_at=2");
  db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,source_context_json) VALUES (?,?,?,?,?)')
    .run('native', 'user', 'questionnaire', 'continuation-turn', JSON.stringify({ origin: { requestId: 'question' } }));
  db.prepare('INSERT INTO local_runtime_turn_ingress VALUES (?,?,?,?)').run('native', 'continuation-turn', status, status === 'completed' ? 3 : null);
}
describe('native questionnaire continuation completion proof', () => {
  it.each(['origin', 'request'] as const)('enforces the 4MiB byte limit on valid %s relation JSON', field => {
    db.exec('ALTER TABLE questionnaire_requests ADD COLUMN request_json TEXT');
    const origin = { origin: { kind: 'questionnaire-response', requestId: 'question' } };
    const request = { requester: { sessionId: 'native', runId: 'user-turn' } };
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,source_context_json) VALUES (?,?,?,?,?)')
      .run('native', 'user', 'questionnaire', 'continuation', JSON.stringify(origin));
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id) VALUES (?,?,?,?)')
      .run('native', 'user', 'api', 'user-turn');
    db.prepare('UPDATE questionnaire_requests SET request_json=?').run(JSON.stringify(request));
    for (const bytes of [JSON_LIMIT, JSON_LIMIT + 1]) {
      const encoded = paddedJson(field === 'origin' ? origin : request, bytes);
      if (field === 'origin') db.prepare("UPDATE local_runtime_message_rows SET source_context_json=? WHERE turn_id='continuation'").run(encoded);
      else db.prepare('UPDATE questionnaire_requests SET request_json=?').run(encoded);
      expect(minimaxUserTurnIds(db, 'native', 'continuation'))
        .toEqual(bytes === JSON_LIMIT ? ['continuation', 'user-turn'] : undefined);
    }
  });

  it('accepts final assistant JSON at 4MiB and rejects one byte above without delivering it', () => {
    answered('completed');
    const insert = db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,turn_id,data_json) VALUES (?,?,?,?)');
    insert.run('native', 'assistant', 'continuation-turn', paddedJson({ msg_content: 'bounded answer' }, JSON_LIMIT));
    expect(read()).toEqual({ state: 'completed', content: 'bounded answer' });
    insert.run('native', 'assistant', 'continuation-turn', paddedJson({ msg_content: 'oversized answer' }, JSON_LIMIT + 1));
    expect(read).toThrow('缺少最终回复');
  });

  it.each([31, 32])('bounds questionnaire usage ancestry traversal for %s links', links => {
    db.exec('ALTER TABLE questionnaire_requests ADD COLUMN request_json TEXT');
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id) VALUES (?,?,?,?)')
      .run('native', 'user', 'api', 'turn-0');
    for (let i = 1; i <= links; i++) {
      db.prepare('INSERT INTO questionnaire_requests (request_id,session_id,request_json) VALUES (?,?,?)')
        .run(`q-${i}`, 'native', JSON.stringify({ requester: { sessionId: 'native', runId: `turn-${i - 1}` } }));
      db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,source_context_json) VALUES (?,?,?,?,?)')
        .run('native', 'user', 'questionnaire', `turn-${i}`, JSON.stringify({ origin: { kind: 'questionnaire-response', requestId: `q-${i}` } }));
    }
    expect(minimaxUserTurnIds(db, 'native', `turn-${links}`))
      .toEqual(links === 31 ? Array.from({ length: 32 }, (_, i) => `turn-${31 - i}`) : undefined);
  });
  it('ignores stale pending requests while still waiting for new questionnaires in this prompt cycle', () => {
    for (let i = 0; i < 20; i++) db.prepare('INSERT INTO questionnaire_requests VALUES (?,?,?,?,?)')
      .run(`stale-${i}`, 'native', 'pending', null, 1);
    const cursor = minimaxQuestionnaireCursor(path, 'native');
    expect(pendingMinimaxQuestionnaires(path, 'native', cursor, true)).toEqual([]);
    // Equal timestamps deliberately rule out a clock-based ownership boundary.
    db.prepare('INSERT INTO questionnaire_requests VALUES (?,?,?,?,?)').run('fresh', 'native', 'pending', null, 1);
    expect(pendingMinimaxQuestionnaires(path, 'native', cursor, true)).toEqual(['fresh']);
    const requests = new Set(['fresh']);
    expect(readMinimaxContinuation(path, 'native', requests, cursor)).toEqual({ state: 'waiting' });
    db.exec("UPDATE questionnaire_requests SET status='answered', injected_at=2 WHERE request_id='fresh'");
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,source_context_json) VALUES (?,?,?,?,?)')
      .run('native', 'user', 'questionnaire', 'fresh-turn', JSON.stringify({ origin: { requestId: 'fresh' } }));
    db.exec("INSERT INTO local_runtime_turn_ingress VALUES ('native','fresh-turn','completed',3)");
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,turn_id,data_json) VALUES (?,?,?,?)')
      .run('native', 'assistant', 'fresh-turn', JSON.stringify({ msg_content: 'New answer completed' }));
    expect(readMinimaxContinuation(path, 'native', requests, cursor)).toEqual({ state: 'completed', content: 'New answer completed' });
    db.prepare('INSERT INTO questionnaire_requests VALUES (?,?,?,?,?)').run('fresh-two', 'native', 'pending', null, 1);
    expect(readMinimaxContinuation(path, 'native', requests, cursor)).toEqual({ state: 'waiting' });
    expect(db.prepare("SELECT status FROM questionnaire_requests WHERE request_id='question'").get()).toEqual({ status: 'pending' });
  });

  it('keeps waiting after original end_turn until the answer is injected and its exact continuation finishes', () => {
    expect(pendingMinimaxQuestionnaires(path, 'native')).toEqual(['question']);
    expect(read()).toEqual({ state: 'waiting' });
    answered(); expect(read()).toEqual({ state: 'waiting' });
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,data_json) VALUES (?,?,?,?,?)')
      .run('native', 'assistant', 'questionnaire', 'continuation-turn', JSON.stringify({ msg_content: 'Selected Unit', thinking_content: 'PRIVATE' }));
    db.exec("UPDATE local_runtime_turn_ingress SET status='completed', completed_at_ms=3");
    expect(read()).toEqual({ state: 'completed', content: 'Selected Unit' });
    expect(db.prepare("SELECT injected_at FROM questionnaire_requests WHERE request_id='question'").get()).toEqual({ injected_at: 2 });
  });
  it('does not use another session, another request, or a previous assistant reply as completion', () => {
    db.prepare('INSERT INTO questionnaire_requests VALUES (?,?,?,?,?)').run('other', 'sibling', 'answered', 10, 10);
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,source_context_json,data_json) VALUES (?,?,?,?,?,?)')
      .run('sibling', 'user', 'questionnaire', 'other-turn', JSON.stringify({ origin: { requestId: 'question' } }), null);
    db.prepare('INSERT INTO local_runtime_turn_ingress VALUES (?,?,?,?)').run('sibling', 'other-turn', 'completed', 10);
    db.exec("UPDATE questionnaire_requests SET status='answered', injected_at=2 WHERE session_id='native'");
    expect(read()).toEqual({ state: 'waiting' });
    expect(pendingMinimaxQuestionnaires(path, 'sibling')).toEqual([]);
  });
  it.each(['aborted', 'failed', 'cancelled'])('never reports a %s continuation as success', status => {
    answered(status); expect(read).toThrow('未完成');
  });
  it('waits for a second questionnaire and returns the final continuation rather than the first question text', () => {
    answered('completed');
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,turn_id,data_json) VALUES (?,?,?,?)')
      .run('native', 'assistant', 'continuation-turn', JSON.stringify({ msg_content: 'Next question' }));
    db.prepare('INSERT INTO questionnaire_requests VALUES (?,?,?,?,?)').run('question-two', 'native', 'pending', null, 4);
    expect(read()).toEqual({ state: 'waiting' });
    db.exec("UPDATE questionnaire_requests SET status='answered', injected_at=5 WHERE request_id='question-two'");
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,source_context_json) VALUES (?,?,?,?,?)')
      .run('native', 'user', 'questionnaire', 'continuation-two', JSON.stringify({ origin: { requestId: 'question-two' } }));
    db.prepare('INSERT INTO local_runtime_turn_ingress VALUES (?,?,?,?)').run('native', 'continuation-two', 'completed', 6);
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,turn_id,data_json) VALUES (?,?,?,?)')
      .run('native', 'assistant', 'continuation-two', JSON.stringify({ msg_content: 'Both answered' }));
    expect(readMinimaxContinuation(path, 'native', new Set(['question', 'question-two']))).toEqual({ state: 'completed', content: 'Both answered' });
  });
  it('rejects missing/dismissed records and a tool call masquerading as a final answer', () => {
    expect(() => readMinimaxContinuation(path, 'native', new Set(['missing']))).toThrow('缺失');
    db.exec("UPDATE questionnaire_requests SET status='dismissed'"); expect(read).toThrow('没有成功');
    answered('completed');
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,turn_id,data_json) VALUES (?,?,?,?)')
      .run('native', 'assistant', 'continuation-turn', JSON.stringify({ msg_content: 'Tool draft', tool_calls: [{}] }));
    expect(read).toThrow('工具调用');
  });
  it('groups questionnaire continuation usage with its original user turn using the native request relation', () => {
    db.exec('ALTER TABLE questionnaire_requests ADD COLUMN request_json TEXT');
    db.prepare('UPDATE questionnaire_requests SET request_json = ? WHERE request_id = ?')
      .run(JSON.stringify({ requester: { sessionId: 'native', runId: 'user-turn' } }), 'question');
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id,source_context_json) VALUES (?,?,?,?,?)')
      .run('native', 'user', 'questionnaire', 'continuation', JSON.stringify({ origin: { kind: 'questionnaire-response', requestId: 'question' } }));
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,source,turn_id) VALUES (?,?,?,?)')
      .run('native', 'user', 'api', 'user-turn');
    expect(minimaxUserTurnIds(db, 'native', 'continuation')).toEqual(['continuation', 'user-turn']);
    expect(minimaxUserTurnIds(db, 'native', 'next-user-turn')).toEqual(['next-user-turn']);
    db.prepare('UPDATE questionnaire_requests SET request_json = ?').run(JSON.stringify({ requester: { sessionId: 'sibling', runId: 'user-turn' } }));
    expect(minimaxUserTurnIds(db, 'native', 'continuation')).toBeUndefined();
    db.prepare('UPDATE questionnaire_requests SET request_json = ?').run(JSON.stringify({ requester: { sessionId: 'native', runId: 'continuation' } }));
    expect(minimaxUserTurnIds(db, 'native', 'continuation')).toBeUndefined();
  });
});
