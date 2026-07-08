/**
 * verified-delivery/attention.ts — the shared task-disposition classifier + the
 * Operator View ("项目经理视图") read-model (claude×codex 2026-06-29 seam).
 *
 * Two exports, with a hard split of responsibility:
 *   1. classifyTaskDisposition(task, ctx?) — a PURE single-task RULE. Given a
 *      task's ledger-derived state (+ a small, explicitly-supplied context of
 *      ledger/store-derived risk) it returns which attention bucket the task is
 *      in, a stable reason code, and a human "下一步" line. This is the SINGLE
 *      rule both the dashboard board and the goal-watchdog use, so the page and
 *      the background loop can never disagree about a task's state.
 *   2. buildGoalAttentionBoard(opts) — a pure projection that runs the classifier
 *      over buildGoalBoard()'s tasks and rolls them up CROSS-GOAL (needs-human
 *      and blocked first, flat across goals) into a first-screen "what needs me".
 *
 * Purity boundary (hard, agreed with codex): this module reads NOTHING live — no
 * activeSessions, no process liveness, no command execution, no filesystem
 * verification, and no clock. Two kinds of risk are therefore NOT computed here
 * and must be SUPPLIED via DispositionContext by the IPC/daemon layer:
 *   - reassign-budget exhaustion — needs a clock (windowed count) and the
 *     core/goal-reassign-budget predicate; that layering + the clock belong to
 *     the live side, so the Set is passed in (single wiring point, no drift).
 *   - dead-letter — read from the goal-notification retry store; carried in the
 *     same context for symmetry / one assembly point.
 * Live PROCESS health (supervisor/worker liveness, zombie, revive) is a separate
 * concern layered on at the IPC seam and tagged `live` — it is never mixed into
 * the bucket verdict this module produces. The classifier owns the RULE; the
 * caller owns the live DATA.
 */
import { buildGoalBoard, type GoalBoardGoal, type GoalBoardTask } from './goal-board.js';
import type { TaskStatus, TaskHelpView } from './types.js';

/** The attention buckets, needs-attention-first. `completed` is ONLY `accepted`
 *  (escalated/blocked/dead-letter never land here); `quiet` is a goal-level idea
 *  (nothing actionable) — tasks themselves do not normally classify as quiet. */
export type AttentionBucket =
  | 'needsHuman'    // escalated → a person must decide
  | 'blocked'       // help requested → awaiting the supervisor
  | 'inProgress'    // dispatched, or rejected-and-retrying — a worker is on it
  | 'readyToVerify' // status=reported, no verdict yet — awaiting verification
  | 'completed'     // accepted (terminal success)
  | 'systemRisk'    // ledger/store-derived risk on an otherwise-active task
  | 'quiet';        // nothing actionable (goal-level; defensive fallback at task level)

export interface TaskDisposition {
  bucket: AttentionBucket;
  /** Stable, machine-stable reason code (e.g. 'awaiting_verdict', 'help:ambiguous'). */
  reason: string;
  /** Descriptive (NOT predictive) one-liner: what it's currently waiting on. */
  next: string;
}

/** The minimal task shape the classifier needs — satisfied structurally by BOTH
 *  the ledger's TaskView and the board's GoalBoardTask, so the watchdog (TaskView)
 *  and the dashboard board (GoalBoardTask) share one rule with no adapter. */
export interface ClassifiableTask {
  taskId: string;
  status: TaskStatus;
  help?: TaskHelpView;
}

/** Ledger/store-derived risk, ASSEMBLED BY THE CALLER (IPC/watchdog) and passed
 *  in — never read inside this pure module (see the header for why). Both sets
 *  key on taskId. Omitting the context simply means "no store-derived risk known"
 *  (active tasks stay inProgress), which is the correct default for a bare
 *  ledger-only projection. */
export interface DispositionContext {
  /** Tasks whose worker-reassign budget is exhausted (needs a person, not patience). */
  reassignBudgetExhausted?: ReadonlySet<string>;
  /** Tasks whose critical human-attention notification has dead-lettered. */
  deadLetterTaskIds?: ReadonlySet<string>;
}

/** PURE. The single source of truth for "what state is this task in + what's it
 *  waiting on". No I/O, no clock, no live state. */
export function classifyTaskDisposition(task: ClassifiableTask, ctx: DispositionContext = {}): TaskDisposition {
  const id = task.taskId;
  // For an ACTIVE task (dispatched / rejected-retrying), store-derived risk
  // overrides the raw status: a task still "in flight" but out of retry budget or
  // with a dead-lettered escalation needs a human, not more waiting.
  const activeRisk = (): TaskDisposition | undefined => {
    if (ctx.reassignBudgetExhausted?.has(id)) return { bucket: 'systemRisk', reason: 'reassign_budget_exhausted', next: '重派预算耗尽，需人介入' };
    if (ctx.deadLetterTaskIds?.has(id)) return { bucket: 'systemRisk', reason: 'deadletter_pending', next: '关键通知进死信，需人介入' };
    return undefined;
  };

  switch (task.status) {
    case 'escalated':
      return { bucket: 'needsHuman', reason: 'escalated', next: '等人拍板' };
    case 'blocked':
      return { bucket: 'blocked', reason: task.help?.kind ? `help:${task.help.kind}` : 'help', next: '等监管澄清/重派' };
    case 'reported':
      return { bucket: 'readyToVerify', reason: 'awaiting_verdict', next: '已有提交，等验收' };
    case 'accepted':
      return { bucket: 'completed', reason: 'accepted', next: '已验收' };
    case 'dispatched':
      return activeRisk() ?? { bucket: 'inProgress', reason: 'dispatched', next: '等执行者提交结果' };
    case 'rejected':
      // NOT terminal: the worker is expected to fix and re-report.
      return activeRisk() ?? { bucket: 'inProgress', reason: 'rejected_retrying', next: '已驳回，等执行者重新提交' };
    default: {
      // Compile-time exhaustiveness: adding a TaskStatus without a case fails here.
      const _exhaustive: never = task.status;
      return { bucket: 'quiet', reason: `unknown:${String(_exhaustive)}`, next: '—' };
    }
  }
}

/** A compact "did it actually produce something" summary for one attention row. */
export interface AttentionEvidence {
  /** Who verified the latest report (orchestrator/human id), when verified. */
  checkedBy?: string;
  /** Which evidence the verifier actually inspected (anti-Goodhart trail). */
  evidenceChecked?: string[];
  /** Commands the verifier ran to check the delivery. */
  ranCommands?: string[];
  /** The latest report's own summary, or the reject reason — a one-line "what happened". */
  latestSummary?: string;
}

/** One task, projected for the cross-goal attention rollup. */
export interface AttentionTask {
  goalChatId: string;
  goalTitle?: string;
  taskId: string;
  title?: string;
  workerNames?: string[];
  disposition: TaskDisposition;
  /** Risk provenance. Omitted in the pure board; IPC enrichment stamps it. */
  source?: 'ledger' | 'live';
  /** Live-health detail fields are only present when source='live'. */
  liveKind?: string;
  liveDetail?: string;
  sessionId?: string;
  larkAppId?: string;
  /** Most recent delivery activity for this task (unix ms; for ordering/age). */
  lastActivityAt?: number;
  recentEvidence?: AttentionEvidence;
}

/** The Operator View read-model: cross-goal flat rollups (the "what needs me"
 *  first screen) + the per-goal board for drill-down. */
export interface GoalAttentionBoard {
  needsHuman: AttentionTask[];      // escalated — oldest-waiting first
  blocked: AttentionTask[];         // help requested — oldest-waiting first
  systemRisk: AttentionTask[];      // ledger/store risk — oldest-waiting first; live-health appended at IPC
  inProgress: AttentionTask[];      // newest activity first
  readyToVerify: AttentionTask[];   // oldest-waiting-for-verdict first
  recentlyCompleted: AttentionTask[]; // newest first, capped
  counts: { needsHuman: number; blocked: number; systemRisk: number; inProgress: number; readyToVerify: number; completed: number };
  /** Full per-goal board (existing GoalBoard) for drill-down. */
  perGoal: GoalBoardGoal[];
}

const RECENTLY_COMPLETED_LIMIT = 12;

function taskLastActivity(t: GoalBoardTask): number | undefined {
  let last: number | undefined;
  for (const ts of [t.dispatchedAt, t.latestReportedAt, t.latestVerdictAt, t.acceptedAt, t.rejectedAt]) {
    if (ts !== undefined && (last === undefined || ts > last)) last = ts;
  }
  return last;
}

function recentEvidenceOf(t: GoalBoardTask): AttentionEvidence | undefined {
  const latest = t.latestReportId
    ? t.attempts.find((a) => a.reportId === t.latestReportId)
    : t.attempts[t.attempts.length - 1];
  const latestSummary = latest?.summary ?? (t.rejectReason ? `驳回：${t.rejectReason}` : undefined);
  const ev: AttentionEvidence = {};
  if (t.checkedBy) ev.checkedBy = t.checkedBy;
  if (t.evidenceChecked?.length) ev.evidenceChecked = t.evidenceChecked;
  if (t.ranCommands?.length) ev.ranCommands = t.ranCommands;
  if (latestSummary) ev.latestSummary = latestSummary;
  return Object.keys(ev).length ? ev : undefined;
}

function toAttentionTask(goal: GoalBoardGoal, t: GoalBoardTask, disposition: TaskDisposition): AttentionTask {
  const at: AttentionTask = { goalChatId: goal.goalChatId, taskId: t.taskId, disposition };
  if (goal.title) at.goalTitle = goal.title;
  if (t.title) at.title = t.title;
  if (t.workerNames?.length) at.workerNames = t.workerNames;
  const last = taskLastActivity(t);
  if (last !== undefined) at.lastActivityAt = last;
  const ev = recentEvidenceOf(t);
  if (ev) at.recentEvidence = ev;
  return at;
}

// Oldest-waiting first (undefined activity sorts last); used for needs-attention queues.
const byOldestFirst = (a: AttentionTask, b: AttentionTask): number =>
  (a.lastActivityAt ?? Number.POSITIVE_INFINITY) - (b.lastActivityAt ?? Number.POSITIVE_INFINITY);
// Newest activity first (undefined sorts last); used for in-progress / recently-completed.
const byNewestFirst = (a: AttentionTask, b: AttentionTask): number =>
  (b.lastActivityAt ?? Number.NEGATIVE_INFINITY) - (a.lastActivityAt ?? Number.NEGATIVE_INFINITY);

/**
 * PURE. Project the ledger (via buildGoalBoard) into the Operator View: classify
 * every task with the shared rule and roll them up cross-goal. The optional
 * `context` supplies ledger/store-derived risk (assembled by the caller); omit it
 * for a bare ledger-only projection (no store-derived systemRisk).
 */
export function buildGoalAttentionBoard(
  opts: { baseDir?: string; chatId?: string; context?: DispositionContext } = {},
): GoalAttentionBoard {
  const board = buildGoalBoard({ baseDir: opts.baseDir, chatId: opts.chatId });
  const ctx = opts.context ?? {};

  const needsHuman: AttentionTask[] = [];
  const blocked: AttentionTask[] = [];
  const systemRisk: AttentionTask[] = [];
  const inProgress: AttentionTask[] = [];
  const readyToVerify: AttentionTask[] = [];
  const completed: AttentionTask[] = [];

  for (const goal of board.goals) {
    for (const t of goal.tasks) {
      const disposition = classifyTaskDisposition(t, ctx);
      const at = toAttentionTask(goal, t, disposition);
      switch (disposition.bucket) {
        case 'needsHuman': needsHuman.push(at); break;
        case 'blocked': blocked.push(at); break;
        case 'systemRisk': systemRisk.push(at); break;
        case 'inProgress': inProgress.push(at); break;
        case 'readyToVerify': readyToVerify.push(at); break;
        case 'completed': completed.push(at); break;
        case 'quiet': break; // not surfaced on the attention board (non-actionable)
      }
    }
  }

  needsHuman.sort(byOldestFirst);
  blocked.sort(byOldestFirst);
  systemRisk.sort(byOldestFirst);
  readyToVerify.sort(byOldestFirst);
  inProgress.sort(byNewestFirst);
  completed.sort(byNewestFirst);

  return {
    needsHuman,
    blocked,
    systemRisk,
    inProgress,
    readyToVerify,
    recentlyCompleted: completed.slice(0, RECENTLY_COMPLETED_LIMIT),
    counts: {
      needsHuman: needsHuman.length,
      blocked: blocked.length,
      systemRisk: systemRisk.length,
      inProgress: inProgress.length,
      readyToVerify: readyToVerify.length,
      completed: completed.length,
    },
    perGoal: board.goals,
  };
}
