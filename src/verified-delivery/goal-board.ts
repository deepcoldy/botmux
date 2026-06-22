/**
 * verified-delivery/goal-board.ts — the read-model behind the dashboard goal board
 * (P1 #6). A pure projection over two truth sources and nothing else:
 *   1. the delivery ledger (task status / reports / acceptance), and
 *   2. each goal group's charter (title + current-state snapshot).
 *
 * Constraints agreed with codex (the IPC route just calls this):
 *   - reads ONLY the ledger + the goal charter whiteboard; never enables the
 *     whiteboard feature flag, never attaches a board to a session, never depends
 *     on a live daemon session. `readWhiteboard(..., { allowDisabled: true })`
 *     keeps it readable even when the global whiteboard flag is off.
 *   - the structured `acceptanceCriteria` is authoritative; the legacy free-text
 *     `acceptanceHint` is carried only as a fallback for display.
 */
import { createHash } from 'node:crypto';
import { openLedger } from './ledger.js';
import { getWhiteboard, readWhiteboard } from '../services/whiteboard-store.js';
import type { AcceptanceCriteria, TaskStatus, TaskView } from './types.js';

export interface GoalBoardTask {
  taskId: string;
  title?: string;
  status: TaskStatus;
  workerOpenIds?: string[];
  latestReportId?: string;
  reportCount: number;
  /** Structured verify plan (preferred); undefined for legacy tasks. */
  acceptanceCriteria?: AcceptanceCriteria;
  /** Legacy free-text hint, kept only when no structured criteria exists. */
  acceptanceHint?: string;
  /** Verdict on the latest attempt, for quick board rendering. */
  latestVerdict?: 'accepted' | 'rejected';
  rejectReason?: string;
}

export interface GoalBoardGoal {
  /** The goal group chatId (also the ledger task.chatId). */
  goalChatId: string;
  /** Charter title when a charter exists, else undefined. */
  title?: string;
  hasCharter: boolean;
  /** ISO timestamp of the charter's last update (lexicographically sortable). */
  charterUpdatedAt?: string;
  /** Current-state snapshot from the charter (may be empty). */
  charterContent?: string;
  counts: { dispatched: number; reported: number; accepted: number; rejected: number; total: number };
  tasks: GoalBoardTask[];
}

export interface GoalBoard {
  goals: GoalBoardGoal[];
}

/** Deterministic charter whiteboard id. MUST match cli.ts `goalCharterId`. */
export function goalCharterId(goal: string): string {
  const hash = createHash('sha256').update(goal).digest('hex').slice(0, 16);
  return `goal_${hash}`;
}

/** Order tasks within a goal: active (dispatched/reported) before terminal, then
 *  by ledger order (which is dispatch order, since taskIds aren't time-sortable). */
const STATUS_RANK: Record<TaskStatus, number> = { dispatched: 0, reported: 1, rejected: 2, accepted: 3 };

function toBoardTask(t: TaskView): GoalBoardTask {
  const latest = t.latestReportId ? t.reports.find((r) => r.reportId === t.latestReportId) : undefined;
  const task: GoalBoardTask = {
    taskId: t.taskId,
    title: t.title,
    status: t.status,
    workerOpenIds: t.workerOpenIds,
    latestReportId: t.latestReportId,
    reportCount: t.reports.length,
  };
  if (t.acceptanceCriteria) task.acceptanceCriteria = t.acceptanceCriteria;
  else if (t.acceptanceHint) task.acceptanceHint = t.acceptanceHint;
  if (latest?.verdict) task.latestVerdict = latest.verdict;
  if (latest?.reason) task.rejectReason = latest.reason;
  return task;
}

/**
 * Project the ledger (grouped by goal chatId) + each goal's charter into a board.
 * Goals are sorted by charter updatedAt desc (most recently touched first), then
 * goals without a charter, then by chatId for stability.
 */
export function buildGoalBoard(opts: { baseDir?: string; chatId?: string } = {}): GoalBoard {
  const ledger = openLedger({ baseDir: opts.baseDir });
  const allTasks = ledger.tasks(opts.chatId);

  const byGoal = new Map<string, TaskView[]>();
  for (const t of allTasks) {
    const goal = t.chatId ?? '(no-chat)';
    const arr = byGoal.get(goal);
    if (arr) arr.push(t); else byGoal.set(goal, [t]);
  }

  const goals: GoalBoardGoal[] = [];
  for (const [goalChatId, tasks] of byGoal) {
    const meta = goalChatId === '(no-chat)' ? undefined : getWhiteboard(goalCharterId(goalChatId));
    let charterContent: string | undefined;
    if (meta) {
      try { charterContent = readWhiteboard(meta.id, { allowDisabled: true, missingAsEmpty: true }); } catch { /* tolerate */ }
    }

    const counts = { dispatched: 0, reported: 0, accepted: 0, rejected: 0, total: tasks.length };
    for (const t of tasks) counts[t.status] += 1;

    const boardTasks = tasks
      .map(toBoardTask)
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);

    goals.push({
      goalChatId,
      title: meta?.title,
      hasCharter: Boolean(meta),
      charterUpdatedAt: meta?.updatedAt,
      charterContent,
      counts,
      tasks: boardTasks,
    });
  }

  goals.sort((a, b) => {
    // Most recently touched charter first; goals without a charter sort last.
    const au = a.charterUpdatedAt ?? '';
    const bu = b.charterUpdatedAt ?? '';
    if (au !== bu) return au < bu ? 1 : -1;
    return a.goalChatId < b.goalChatId ? -1 : a.goalChatId > b.goalChatId ? 1 : 0;
  });

  return { goals };
}
