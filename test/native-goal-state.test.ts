import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativeGoalFromEvent, readLatestNativeGoal, readNativeGoalForRollout } from '../src/services/native-goal-state.js';
import { drainCodexRollout } from '../src/services/codex-transcript.js';
import { drainTraexRollout } from '../src/services/traex-transcript.js';
import { openDatabaseSyncNow } from '../src/services/sqlite-compat.js';
const id = '00000000-0000-7000-8000-000000000001';
const active = { threadId: id, objective: 'status', status: 'active', createdAt: 100, updatedAt: 105, timeUsedSeconds: 5 };
const event = (goal: unknown) => ({ timestamp: '2026-11-13T00:00:00Z', type: 'event_msg', payload: { type: 'thread_goal_updated', threadId: id, goal } });
let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'native-goal-state-'));
  const day = join(dir, 'sessions/2026/11/13'); mkdirSync(day, { recursive: true });
  path = join(day, `rollout-2026-11-13T00-00-00-${id}.jsonl`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('native CLI goal state', () => {
  it('accepts genuine native goals and clear events, ignoring other threads and malformed data', () => {
    expect(nativeGoalFromEvent(event(active), id)).toMatchObject({ status: 'active', timeUsedSeconds: 5 });
    expect(nativeGoalFromEvent(event(null), id)).toBeNull();
    expect(nativeGoalFromEvent(event({ ...active, threadId: 'other' }), id)).toBeUndefined();
    expect(nativeGoalFromEvent(event({ ...active, timeUsedSeconds: -1 }), id)).toBeUndefined();
    expect(nativeGoalFromEvent({ type: 'event_msg', payload: { type: 'task_complete' } }, id)).toBeUndefined();
  });
  it.each([drainCodexRollout, drainTraexRollout])('exposes native goal state separately from ordinary turn completion', drain => {
    writeFileSync(path, JSON.stringify(event(active)) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn1', last_agent_message: 'done' } }) + '\n');
    const first = drain(path, 0);
    expect(first.latestGoal).toMatchObject({ status: 'active', timeUsedSeconds: 5 });
    appendFileSync(path, JSON.stringify(event({ ...active, status: 'complete', updatedAt: 110, timeUsedSeconds: 10 })) + '\n');
    expect(drain(path, first.newOffset).latestGoal).toMatchObject({ status: 'complete', timeUsedSeconds: 10 });
  });
  it('bootstraps from the latest complete event and ignores a partial trailing record', () => {
    writeFileSync(path, JSON.stringify(event(active)) + '\n' + JSON.stringify(event({ ...active, status: 'complete' })));
    expect(readLatestNativeGoal(path, id)?.status).toBe('active');
    appendFileSync(path, '\n');
    expect(readLatestNativeGoal(path, id)?.status).toBe('complete');
  });
  it('reads live elapsed time and completion from the native SQLite store without a new rollout event', () => {
    const db = openDatabaseSyncNow(join(dir, 'goals_1.sqlite'))!;
    db.exec('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)');
    db.prepare('INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'goal1', 'status', 'active', 7, 100000, 107111);
    writeFileSync(path, JSON.stringify(event(active)) + '\n');
    expect(readNativeGoalForRollout(path, id)).toMatchObject({ status: 'active', timeUsedSeconds: 7, updatedAt: 107.111 });
    db.prepare('UPDATE thread_goals SET status=?, time_used_seconds=?, updated_at_ms=? WHERE thread_id=?').run('complete', 12, 112222, id);
    expect(readLatestNativeGoal(path, id)?.status).toBe('active');
    expect(readNativeGoalForRollout(path, id)).toMatchObject({ status: 'complete', timeUsedSeconds: 12, updatedAt: 112.222 });
    expect(readNativeGoalForRollout(path, 'other')).toBeNull();
    db.close();
  });
  it('retains existing state when the native store or schema is unavailable', () => {
    expect(readNativeGoalForRollout(path, id)).toBeUndefined();
    const db = openDatabaseSyncNow(join(dir, 'goals_1.sqlite'))!; db.exec('CREATE TABLE unrelated (x INTEGER)'); db.close();
    expect(readNativeGoalForRollout(path, id)).toBeUndefined();
  });
});
