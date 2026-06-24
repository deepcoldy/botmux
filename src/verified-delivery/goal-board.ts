/**
 * verified-delivery/goal-board.ts — the read-model behind the dashboard goal board
 * (P1 #6). A pure projection over two truth sources and nothing else:
 *   1. the delivery ledger (task status / reports / acceptance / event timestamps), and
 *   2. each goal group's charter (title + current-state snapshot).
 *
 * Constraints agreed with codex (the IPC route just calls this):
 *   - reads ONLY the ledger + the goal charter whiteboard; never enables the
 *     whiteboard feature flag, never attaches a board to a session, never depends
 *     on a live daemon session. `readWhiteboard(..., { allowDisabled: true })`
 *     keeps it readable even when the global whiteboard flag is off.
 *   - the structured `acceptanceCriteria` is authoritative; the legacy free-text
 *     `acceptanceHint` is carried only as a fallback for display.
 *
 * The board UI is a grid-first observation console (claude×codex design): rows =
 * tasks, columns = delivery lifecycle (dispatch→report→verify), plus a detail
 * panel per task. So this read-model surfaces per-task timestamps, the attempt
 * history, and the latest verification trail (checkedBy / evidence / ranCommands)
 * — everything the panel needs WITHOUT a second round-trip. Inline-evidence blobs
 * are NOT inlined here (only a small descriptor + preview); full content stays
 * behind readInlineEvidence for a future on-demand endpoint.
 */
import { createHash } from 'node:crypto';
import { openLedger } from './ledger.js';
import { getWhiteboard, readWhiteboard } from '../services/whiteboard-store.js';
import { readGoalNarrations, type GoalNarrationRecord } from '../services/goal-narration-store.js';
import type {
  AcceptanceCriteria, Evidence, LedgerEvent, TaskStatus, TaskView,
  TaskReportedPayload, TaskAcceptedPayload, TaskRejectedPayload,
  TaskHelpView, TaskEscalationView,
} from './types.js';

/** A compact, display-safe descriptor of one piece of evidence (no blob inlined). */
export interface BoardEvidence {
  kind: 'path' | 'inline';
  /** Path for path-evidence; name/ref for inline-evidence. */
  label: string;
  /** Short preview for inline-evidence only. */
  preview?: string;
  bytes?: number;
}

/** One attempt (report) in a task's history, for the detail panel timeline. */
export interface BoardReportAttempt {
  reportId: string;
  ts?: number;
  /** Verdict on this attempt, or undefined if still awaiting verification. */
  verdict?: 'accepted' | 'rejected';
  reason?: string;
  summary: string;
  workerOpenId?: string;
  /** 'reconcile' when the mechanical reconciler ruled this attempt (else human/CLI). */
  verdictVia?: 'reconcile';
}

export interface GoalBoardTask {
  taskId: string;
  title?: string;
  status: TaskStatus;
  workerOpenIds?: string[];
  /** Display names index-aligned with workerOpenIds (captured at dispatch). */
  workerNames?: string[];
  latestReportId?: string;
  reportCount: number;
  /** Structured verify plan (preferred); undefined for legacy tasks. */
  acceptanceCriteria?: AcceptanceCriteria;
  /** Legacy free-text hint, kept only when no structured criteria exists. */
  acceptanceHint?: string;
  /** Verdict on the latest attempt, for quick board rendering. */
  latestVerdict?: 'accepted' | 'rejected';
  rejectReason?: string;
  /** True when the latest verdict came from the mechanical reconciler (🤖 auto). */
  autoReconciled?: boolean;

  // ── lifecycle timestamps (unix ms; from ledger events) ────────────────────
  dispatchedAt?: number;
  latestReportedAt?: number;
  latestVerdictAt?: number;
  acceptedAt?: number;
  rejectedAt?: number;

  // ── verification trail of the latest report (the "is it really done" proof)─
  checkedBy?: string;
  evidenceChecked?: string[];
  ranCommands?: string[];
  evidence?: BoardEvidence[];

  /** Every attempt, oldest→newest, for the detail-panel timeline. */
  attempts: BoardReportAttempt[];

  // ── help / escalation rung (the "stuck worker" path) ──────────────────────
  /** Latest help request (worker → supervisor); present when blocked/handled. */
  help?: TaskHelpView;
  /** Latest escalation (supervisor → human); present once escalated. */
  escalation?: TaskEscalationView;
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
  /** Most recent delivery activity across this goal's tasks (unix ms). */
  lastActivityAt?: number;
  counts: { dispatched: number; reported: number; accepted: number; rejected: number; blocked: number; escalated: number; total: number };
  tasks: GoalBoardTask[];
  /** Recent human-readable narration events (newest first) — the same clean
   *  stream the goal chat shows, incl. 「人类决策到达」(not a ledger fact). */
  narrations?: GoalNarrationRecord[];
}

export interface GoalBoard {
  goals: GoalBoardGoal[];
}

/** Deterministic charter whiteboard id. MUST match cli.ts `goalCharterId`. */
export function goalCharterId(goal: string): string {
  const hash = createHash('sha256').update(goal).digest('hex').slice(0, 16);
  return `goal_${hash}`;
}

/** Order tasks within a goal: needs-attention (escalated→human, blocked→supervisor)
 *  first, then active (dispatched/reported), then terminal — by ledger order
 *  (which is dispatch order, since taskIds aren't time-sortable). */
const STATUS_RANK: Record<TaskStatus, number> = { escalated: -2, blocked: -1, dispatched: 0, reported: 1, rejected: 2, accepted: 3 };

/** Per-task timing + per-report timing, derived from the raw event stream. */
interface TaskTiming {
  dispatchedAt?: number;
  latestReportedAt?: number;
  latestVerdictAt?: number;
  acceptedByReport: Map<string, number>;
  rejectedByReport: Map<string, number>;
  reportTs: Map<string, number>;
}

function collectTimings(events: LedgerEvent[]): Map<string, TaskTiming> {
  const byTask = new Map<string, TaskTiming>();
  const ensure = (taskId: string): TaskTiming => {
    let t = byTask.get(taskId);
    if (!t) {
      t = { acceptedByReport: new Map(), rejectedByReport: new Map(), reportTs: new Map() };
      byTask.set(taskId, t);
    }
    return t;
  };
  for (const e of events) {
    const t = ensure(e.taskId);
    if (e.type === 'TaskDispatched') {
      if (t.dispatchedAt === undefined) t.dispatchedAt = e.ts; // first dispatch
    } else if (e.type === 'TaskReported') {
      const p = e.payload as TaskReportedPayload;
      t.latestReportedAt = e.ts; // events are ordered → last wins
      t.reportTs.set(p.reportId, e.ts);
    } else if (e.type === 'TaskAccepted') {
      const p = e.payload as TaskAcceptedPayload;
      t.latestVerdictAt = e.ts;
      t.acceptedByReport.set(p.reportId, e.ts);
    } else if (e.type === 'TaskRejected') {
      const p = e.payload as TaskRejectedPayload;
      t.latestVerdictAt = e.ts;
      t.rejectedByReport.set(p.reportId, e.ts);
    }
  }
  return byTask;
}

function toBoardEvidence(ev: Evidence[]): BoardEvidence[] {
  return ev.map((e) => e.kind === 'path'
    ? { kind: 'path', label: e.path }
    : { kind: 'inline', label: e.name ?? e.ref, preview: e.preview, bytes: e.bytes });
}

function toBoardTask(t: TaskView, timing: TaskTiming | undefined): GoalBoardTask {
  const latest = t.latestReportId ? t.reports.find((r) => r.reportId === t.latestReportId) : undefined;
  const task: GoalBoardTask = {
    taskId: t.taskId,
    title: t.title,
    status: t.status,
    workerOpenIds: t.workerOpenIds,
    workerNames: t.workerNames,
    latestReportId: t.latestReportId,
    reportCount: t.reports.length,
    attempts: t.reports.map((r) => {
      const a: BoardReportAttempt = { reportId: r.reportId, summary: r.summary };
      const ts = timing?.reportTs.get(r.reportId);
      if (ts !== undefined) a.ts = ts;
      if (r.verdict) a.verdict = r.verdict;
      if (r.reason) a.reason = r.reason;
      if (r.workerOpenId) a.workerOpenId = r.workerOpenId;
      if (r.verdictVia) a.verdictVia = r.verdictVia;
      return a;
    }),
  };
  if (t.acceptanceCriteria) task.acceptanceCriteria = t.acceptanceCriteria;
  else if (t.acceptanceHint) task.acceptanceHint = t.acceptanceHint;
  if (latest?.verdict) task.latestVerdict = latest.verdict;
  if (latest?.reason) task.rejectReason = latest.reason;
  if (latest?.verdictVia === 'reconcile') task.autoReconciled = true;
  if (t.help) task.help = t.help;
  if (t.escalation) task.escalation = t.escalation;
  if (latest?.checkedBy) task.checkedBy = latest.checkedBy;
  if (latest?.evidenceChecked?.length) task.evidenceChecked = latest.evidenceChecked;
  if (latest?.ranCommands?.length) task.ranCommands = latest.ranCommands;
  if (latest?.evidence?.length) task.evidence = toBoardEvidence(latest.evidence);

  if (timing) {
    if (timing.dispatchedAt !== undefined) task.dispatchedAt = timing.dispatchedAt;
    if (timing.latestReportedAt !== undefined) task.latestReportedAt = timing.latestReportedAt;
    if (timing.latestVerdictAt !== undefined) task.latestVerdictAt = timing.latestVerdictAt;
    if (t.latestReportId) {
      const a = timing.acceptedByReport.get(t.latestReportId);
      const r = timing.rejectedByReport.get(t.latestReportId);
      if (t.status === 'accepted' && a !== undefined) task.acceptedAt = a;
      if (t.status === 'rejected' && r !== undefined) task.rejectedAt = r;
    }
  }
  return task;
}

/**
 * Project the ledger (grouped by goal chatId) + each goal's charter into a board.
 * Goals are sorted by most recent delivery activity (then charter updatedAt) desc.
 */
export function buildGoalBoard(opts: { baseDir?: string; chatId?: string } = {}): GoalBoard {
  const ledger = openLedger({ baseDir: opts.baseDir });
  const allTasks = ledger.tasks(opts.chatId);
  const timings = collectTimings(ledger.read());

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

    const counts = { dispatched: 0, reported: 0, accepted: 0, rejected: 0, blocked: 0, escalated: 0, total: tasks.length };
    for (const t of tasks) counts[t.status] += 1;

    const boardTasks = tasks
      .map((t) => toBoardTask(t, timings.get(t.taskId)))
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);

    let lastActivityAt: number | undefined;
    for (const t of boardTasks) {
      for (const ts of [t.dispatchedAt, t.latestReportedAt, t.latestVerdictAt]) {
        if (ts !== undefined && (lastActivityAt === undefined || ts > lastActivityAt)) lastActivityAt = ts;
      }
    }

    const narrations = goalChatId === '(no-chat)' ? [] : readGoalNarrations(goalChatId, 20);

    goals.push({
      goalChatId,
      title: meta?.title,
      hasCharter: Boolean(meta),
      charterUpdatedAt: meta?.updatedAt,
      charterContent,
      lastActivityAt,
      counts,
      tasks: boardTasks,
      ...(narrations.length ? { narrations } : {}),
    });
  }

  goals.sort((a, b) => {
    // Most recent delivery activity first; fall back to charter freshness, then id.
    const aa = a.lastActivityAt ?? -1;
    const bb = b.lastActivityAt ?? -1;
    if (aa !== bb) return bb - aa;
    const au = a.charterUpdatedAt ?? '';
    const bu = b.charterUpdatedAt ?? '';
    if (au !== bu) return au < bu ? 1 : -1;
    return a.goalChatId < b.goalChatId ? -1 : a.goalChatId > b.goalChatId ? 1 : 0;
  });

  return { goals };
}
