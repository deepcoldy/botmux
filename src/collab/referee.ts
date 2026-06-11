/**
 * collab/referee.ts — the deterministic loop-closer (P2: dual-output oracle).
 *
 * The referee is NOT an agent and holds NO context. It reads the board, runs the
 * acceptance command ITSELF (so the verdict has executable provenance — a worker
 * can't fake "done"), and writes back a typed verdict. On 'done' it closes the
 * run; if the budget breaker has tripped it stops the run instead. That's the
 * whole point of acceptance test ④: progress can't be claimed, only proven.
 *
 * P2 dual output: every evaluation now states (a) COMPLETION — does the
 * acceptance rule pass; this and only this terminates the run — and (b)
 * PROGRESS — which way the run is moving. Progress never terminates anything;
 * its one job is scheduling budget attention: a no-improvement streak hitting
 * STALL_THRESHOLD raises ProgressStallRaised so a human gets called BEFORE the
 * wallet burns dry. Budget remains the only breaker.
 *
 * The measurement itself lives behind OracleAdapter; v1 ships exec only
 * (debug/research adapters plug in here later without touching the shell).
 *
 * It is code, not an LLM, so it spends ~no budget; LLM control-plane spend
 * (intake NLU) is what uses BudgetSpent.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AcceptanceCriteria,
  BoardSnapshot,
  CollabBoard,
  CollabEventDraft,
  ProgressDirection,
  RefereeVerdict,
} from './contract.js';

// Promisified lazily inside the adapter: importing this module must not touch
// child_process — test environments mock node:child_process with partial
// surfaces, and this module reaches their import graphs via session-manager.
type PExec = (file: string, args: readonly string[], options: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }>;
let pexecLazy: PExec | undefined;
function pexec(file: string, args: readonly string[], options: { cwd?: string; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
  pexecLazy ??= promisify(execFile) as PExec;
  return pexecLazy(file, args, options);
}

/** Consecutive no-improvement evaluations before the referee calls a human. */
export const STALL_THRESHOLD = 3;

export interface OracleEvaluation {
  /** Completion judgment — decides termination, nothing else does. */
  completion: { done: boolean; rule: 'exitZero' };
  /** Extracted progress metric value, when the criteria defines one and the
   *  output matched. */
  metricValue?: number;
  /** Proof the evaluation is real — the adapter measured unforgeable state. */
  provenance: { adapter: 'exec'; command: string; exitCode: number; durationMs: number; summary: string };
}

/**
 * An oracle adapter performs ONE measurement against unforgeable state. The
 * referee shell (self-gate, budget breaker, verdict, stall escalation,
 * termination) is adapter-agnostic.
 */
export interface OracleAdapter {
  evaluate(criteria: AcceptanceCriteria, opts: { cwd?: string }): Promise<OracleEvaluation>;
}

/** v1 adapter: run the acceptance command, completion = exit 0, progress
 *  metric extracted from combined output by the criteria's regex. */
export const execOracleAdapter: OracleAdapter = {
  async evaluate(criteria, opts) {
    const { command } = criteria;
    let exitCode = 0;
    let output = '';
    const start = Date.now();
    try {
      const { stdout, stderr } = await pexec('bash', ['-lc', command], {
        cwd: opts.cwd,
        maxBuffer: 16 * 1024 * 1024,
      });
      output = String(stdout) + String(stderr);
    } catch (err) {
      const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
      exitCode = typeof e.code === 'number' ? e.code : 1;
      output = String(e.stdout ?? '') + String(e.stderr ?? '');
    }
    const durationMs = Date.now() - start;

    let metricValue: number | undefined;
    if (criteria.progressMetric) {
      const m = output.match(new RegExp(criteria.progressMetric.pattern));
      if (m && m[1] != null && !Number.isNaN(Number(m[1]))) metricValue = Number(m[1]);
    }

    return {
      completion: { done: exitCode === 0, rule: 'exitZero' },
      metricValue,
      provenance: { adapter: 'exec', command, exitCode, durationMs, summary: output.trim().slice(-300) },
    };
  },
};

export interface RefereeResult {
  verdict: RefereeVerdict | 'budget-exhausted' | 'no-op';
  exitCode?: number;
  metricValue?: number;
  /** true ⇔ this evaluation crossed a stall edge (streak hit a multiple of
   *  STALL_THRESHOLD) and ProgressStallRaised was appended. The integration面
   *  reacts by notifying the control topic. */
  stalled?: boolean;
}

export interface RefereeOptions {
  /** Working directory the acceptance command runs in. */
  cwd?: string;
  /** Idempotency discriminator; defaults to the board revision so one verdict
   *  is recorded per board state. */
  idemSuffix?: string;
  /** Measurement backend; defaults to the exec adapter. */
  adapter?: OracleAdapter;
}

export async function runReferee(board: CollabBoard, opts: RefereeOptions = {}): Promise<RefereeResult> {
  const snap = await board.snapshot();
  const idem = opts.idemSuffix ?? `rev${snap.revision}`;

  // Budget breaker first — it is the incorruptible circuit-breaker and outranks
  // any verdict the referee might otherwise reach.
  if (snap.budget?.exhausted && snap.status === 'running') {
    await board.append(finish(snap.runId, idem, 'budget-exhausted', 'budget exhausted before evaluation'));
    return { verdict: 'budget-exhausted' };
  }
  if (!snap.acceptanceCriteria || !snap.task || snap.status !== 'running') {
    return { verdict: 'no-op' };
  }

  // Self-gate so runReferee is safe to call on a heartbeat: only (re)run the
  // acceptance command when something evaluable happened since the last verdict.
  // The causal trigger is a finished worker turn / new artifact / changed goal;
  // a worker merely flipping status to in_progress is not new work.
  const history = await board.history();
  let lastVerdictSeq = -1;
  for (const e of history) if (e.type === 'RefereeEvaluated') lastVerdictSeq = e.seq;
  if (lastVerdictSeq >= 0) {
    const TRIGGERS = new Set(['WorkerTurnFinished', 'ArtifactRecorded', 'GoalChanged', 'AcceptanceCriteriaChanged']);
    const changedSince = history.some((e) => e.seq > lastVerdictSeq && TRIGGERS.has(e.type));
    if (!changedSince) return { verdict: 'no-op' };
  }

  const evaluation = await (opts.adapter ?? execOracleAdapter).evaluate(snap.acceptanceCriteria, { cwd: opts.cwd });
  const { exitCode } = evaluation.provenance;
  const done = evaluation.completion.done;

  // Progress signal: metric value + its prior measurement.
  let signal: { metric: string; value: number; prevValue?: number } | undefined;
  const pm = snap.acceptanceCriteria.progressMetric;
  if (pm && evaluation.metricValue !== undefined) {
    const prevValue = [...snap.progressLog].reverse().find((p) => p.metric === pm.name)?.value;
    signal = { metric: pm.name, value: evaluation.metricValue, prevValue };
  }

  // Dual output ②: direction + streak. First measurement WITH a metric is
  // 'improved' (a baseline is information gained); a failing binary evaluation
  // with no metric is 'unknown' — no progress signal at all is exactly the
  // case that should escalate fastest.
  let direction: ProgressDirection;
  if (done) {
    direction = 'improved';
  } else if (signal && signal.prevValue !== undefined) {
    direction =
      signal.value < signal.prevValue ? 'improved'
      : signal.value > signal.prevValue ? 'regressed'
      : 'flat';
  } else if (signal) {
    direction = 'improved';
  } else {
    direction = 'unknown';
  }
  const lastEntry = snap.progressLog[snap.progressLog.length - 1];
  const streak = direction === 'improved' ? 0 : (lastEntry?.streak ?? 0) + 1;

  // Verdict stays the human-readable rollup of (completion, progress).
  let verdict: RefereeVerdict;
  if (done) verdict = 'done';
  else if (direction === 'improved') verdict = 'progressing';
  else if (direction === 'regressed') verdict = 'regressed';
  else verdict = 'stuck'; // flat | unknown

  await board.append({
    type: 'RefereeEvaluated',
    runId: snap.runId,
    actor: 'referee',
    idempotencyKey: `referee:${idem}`,
    affectedPaths: ['progressLog'],
    taskId: snap.task.taskId,
    payload: {
      taskId: snap.task.taskId,
      verdict,
      provenance: evaluation.provenance,
      signal,
      completion: evaluation.completion,
      progress: { direction, streak },
    },
  } as CollabEventDraft);

  // Stall escalation: raise at each streak edge (3, 6, 9 …). The eval idem in
  // the key keeps a re-stall after recovery distinct from the first one.
  let stalled = false;
  if (!done && streak > 0 && streak % STALL_THRESHOLD === 0) {
    await board.append({
      type: 'ProgressStallRaised',
      runId: snap.runId,
      actor: 'referee',
      idempotencyKey: `stall:${snap.task.taskId}:${streak}:${idem}`,
      affectedPaths: ['stall'],
      taskId: snap.task.taskId,
      payload: { taskId: snap.task.taskId, streak, threshold: STALL_THRESHOLD, lastVerdict: verdict },
    } as CollabEventDraft);
    stalled = true;
  }

  if (verdict === 'done') {
    await board.append({
      type: 'TaskStatusChanged',
      runId: snap.runId,
      actor: 'referee',
      idempotencyKey: `done-task:${idem}`,
      affectedPaths: ['task'],
      taskId: snap.task.taskId,
      payload: { taskId: snap.task.taskId, status: 'done' },
    } as CollabEventDraft);
    await closeDerivedTasksOnRunAcceptance(board, snap, idem);
    await rejectPendingProposalsOnRunClose(board, snap, idem);
    await board.append(finish(snap.runId, idem, 'succeeded', 'acceptance criteria met'));
  }

  return { verdict, exitCode, metricValue: signal?.value, stalled };
}

async function closeDerivedTasksOnRunAcceptance(board: CollabBoard, snap: BoardSnapshot, idem: string): Promise<void> {
  const note = 'closed by run acceptance PASS (not individually verified)';
  for (const task of snap.tasks) {
    if (!task.taskId.startsWith('task-proposal-')) continue;
    if (task.status !== 'open' && task.status !== 'in_progress') continue;
    await board.append({
      type: 'TaskStatusChanged',
      runId: snap.runId,
      actor: 'referee',
      idempotencyKey: `done-task:${task.taskId}:${idem}`,
      affectedPaths: ['task'],
      taskId: task.taskId,
      payload: { taskId: task.taskId, status: 'done', note },
    } as CollabEventDraft);
  }
}

async function rejectPendingProposalsOnRunClose(board: CollabBoard, snap: BoardSnapshot, idem: string): Promise<void> {
  for (const proposal of snap.proposals) {
    if (proposal.status !== 'pending') continue;
    await board.append({
      type: 'TaskProposalResolved',
      runId: snap.runId,
      actor: 'referee',
      idempotencyKey: `reject-proposal:${proposal.proposalId}:run-closed:${idem}`,
      affectedPaths: ['proposals'],
      payload: { proposalId: proposal.proposalId, resolution: 'rejected', reason: 'run-closed' },
    } as CollabEventDraft);
  }
}

function finish(
  runId: string,
  idem: string,
  outcome: 'succeeded' | 'failed' | 'stopped' | 'budget-exhausted',
  summary: string,
): CollabEventDraft {
  return {
    type: 'RunFinished',
    runId,
    actor: outcome === 'budget-exhausted' ? 'system' : 'referee',
    idempotencyKey: `finish:${outcome}:${idem}`,
    affectedPaths: ['status'],
    payload: { outcome, summary },
  } as CollabEventDraft;
}
