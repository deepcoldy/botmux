import { baselineJsonlCursor, scanJsonlBackward } from './jsonl-cursor.js';
import { dirname, join, basename } from 'node:path';
import { openDatabaseSyncNow } from './sqlite-compat.js';

export interface NativeGoalState {
  goalId?: string;
  objective: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  timeUsedSeconds: number;
}

/** Only native goal events are authoritative; a completed model turn is not a completed goal. */
export function nativeGoalFromEvent(record: any, sessionId?: string): NativeGoalState | null | undefined {
  if (record?.type !== 'event_msg' || record.payload?.type !== 'thread_goal_updated') return undefined;
  const goal = record.payload.goal;
  if (sessionId && (goal?.threadId ?? record.payload.threadId) !== sessionId) return undefined;
  if (goal === null) return null;
  if (!goal || typeof goal.objective !== 'string' || !goal.objective.trim()
    || typeof goal.status !== 'string' || !goal.status
    || !Number.isFinite(goal.createdAt) || goal.createdAt <= 0
    || !Number.isFinite(goal.updatedAt) || goal.updatedAt < goal.createdAt
    || !Number.isFinite(goal.timeUsedSeconds) || goal.timeUsedSeconds < 0) return undefined;
  return { ...(typeof goal.goalId === 'string' ? { goalId: goal.goalId } : {}), objective: goal.objective, status: goal.status, createdAt: goal.createdAt,
    updatedAt: goal.updatedAt, timeUsedSeconds: goal.timeUsedSeconds };
}

export function readLatestNativeGoal(path: string, sessionId?: string): NativeGoalState | null | undefined {
  let goal: NativeGoalState | null | undefined;
  try {
    scanJsonlBackward(path, { endOffset: baselineJsonlCursor(path).newOffset, onLine: line => {
      let record: unknown;
      try { record = JSON.parse(line.toString('utf8')); } catch { return; }
      const parsed = nativeGoalFromEvent(record, sessionId);
      if (parsed !== undefined) { goal = parsed; return true; }
    } });
  } catch { /* missing or temporarily unavailable rollout: retain the known goal */ }
  return goal;
}

/** Read the CLI's own goal accounting, including completions that do not append a rollout event. */
export function readNativeGoalForRollout(path: string, sessionId: string): NativeGoalState | null | undefined {
  const sessionsRoot = dirname(dirname(dirname(dirname(path))));
  if (basename(sessionsRoot) !== 'sessions') return undefined;
  // shortcut: Codex/TRAE goal-store schema v1; retain event snapshots if a future schema is unavailable.
  const db = openDatabaseSyncNow(join(dirname(sessionsRoot), 'goals_1.sqlite'), { readOnly: true });
  if (!db) return undefined;
  try {
    const row = db.prepare('SELECT goal_id, objective, status, time_used_seconds, created_at_ms, updated_at_ms FROM thread_goals WHERE thread_id = ?').get(sessionId) as any;
    if (!row) return null;
    return nativeGoalFromEvent({ type: 'event_msg', payload: { type: 'thread_goal_updated', goal: {
      threadId: sessionId, goalId: row.goal_id, objective: row.objective, status: row.status,
      timeUsedSeconds: row.time_used_seconds, createdAt: Math.floor(row.created_at_ms / 1000), updatedAt: row.updated_at_ms / 1000,
    } } }, sessionId);
  } catch { return undefined; }
  finally { db.close(); }
}
