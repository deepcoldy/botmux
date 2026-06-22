/**
 * verified-delivery/reconcile.ts — mechanical chat→ledger reconciliation (P1).
 *
 * The gap this closes: a worker often *claims* done in the goal chat but never
 * runs `botmux report`, so the ledger stays at TaskDispatched and the board never
 * advances — even though the artifacts are sitting right there on disk. The fix
 * agreed with 老滕: the supervisor treats a worker's chat ping as a *trigger to go
 * check the ledger*, NOT as proof. If the ledger is stale, the supervisor VERIFIES
 * the work itself by mechanically running the structured acceptance criteria (#7),
 * then writes report+accept (it really passes) or reject (it doesn't). The chat
 * claim is never trusted; the criteria checks are the proof.
 *
 * This keeps the verified-delivery thesis intact — chat ≠ truth, evidence is — and
 * only removes the dependence on worker discipline (and on an L2 LLM eyeballing).
 * The deterministic path REQUIRES structured `acceptanceCriteria`; legacy free-text
 * tasks return `no-criteria` so the caller (goal-watchdog) falls back to the LLM
 * injection it already does. The watchdog owns the *trigger* (on worker message /
 * on tick) and any chat notification; this module owns the verify + ledger writes.
 *
 * Trust boundary: `command` checks run arbitrary shell the *dispatcher* authored
 * (same author who could already make the L2 avatar run them). P0/P1 is same-host /
 * shared-dir, so this is in-scope; we cap timeout + output and never run anything
 * a worker supplied.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildReport } from './report.js';
import type { LedgerHandle } from './ledger.js';
import { REJECT_REASON } from './types.js';
import type { AcceptanceCriteria } from './types.js';

// ─── verifier ────────────────────────────────────────────────────────────────

export interface AcceptanceCheckResult {
  kind: 'exists' | 'contains' | 'command';
  /** The path / cmd the check ran against (human-readable). */
  target: string;
  ok: boolean;
  /** Why it failed (or a note); omitted when ok. */
  detail?: string;
}

export interface AcceptanceVerifyResult {
  /** True only when there is ≥1 check and every check passed. */
  passed: boolean;
  checks: AcceptanceCheckResult[];
  /** Paths/cmds actually inspected — feeds the accept trail (evidenceChecked). */
  evidenceChecked: string[];
  /** Commands actually executed — feeds the accept trail (ranCommands). */
  ranCommands: string[];
}

export interface VerifyOpts {
  /** Base cwd for command checks that omit their own cwd. */
  defaultCwd?: string;
  /** Per-command default timeout when the criteria omits timeoutMs. */
  defaultTimeoutMs?: number;
  /** Cap on bytes read for a `contains` check (avoid loading a huge file). */
  maxReadBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_READ = 5 * 1024 * 1024;
const CMD_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Run a structured criteria against the local filesystem / shell and report which
 * checks passed. Pure w.r.t. the ledger; the caller decides what to do with the
 * verdict. Never throws — a check that errors becomes a failed check with detail.
 */
export function verifyAcceptanceCriteria(criteria: AcceptanceCriteria, opts: VerifyOpts = {}): AcceptanceVerifyResult {
  const checks: AcceptanceCheckResult[] = [];
  const evidenceChecked: string[] = [];
  const ranCommands: string[] = [];
  const maxRead = opts.maxReadBytes ?? DEFAULT_MAX_READ;

  for (const art of criteria.artifacts ?? []) {
    evidenceChecked.push(art.path);
    const exists = existsSync(art.path);
    // Only read the file when a contains-check needs it (and it's a readable file).
    let content: string | undefined;
    let readErr: string | undefined;
    if (exists && art.checks.some((c) => c.type === 'contains')) {
      try {
        const st = statSync(art.path);
        if (st.isDirectory()) readErr = '是目录，无法做 contains 检查';
        else if (st.size > maxRead) readErr = `文件过大(${st.size}B)，超出读取上限`;
        else content = readFileSync(art.path, 'utf-8');
      } catch (e) { readErr = (e as Error).message; }
    }
    for (const c of art.checks) {
      if (c.type === 'exists') {
        checks.push({ kind: 'exists', target: art.path, ok: exists, detail: exists ? undefined : '路径不存在' });
      } else if (!exists) {
        checks.push({ kind: 'contains', target: art.path, ok: false, detail: '路径不存在' });
      } else if (readErr) {
        checks.push({ kind: 'contains', target: art.path, ok: false, detail: readErr });
      } else {
        const ok = (content ?? '').includes(c.text);
        checks.push({ kind: 'contains', target: `${art.path} ⊇ "${c.text}"`, ok, detail: ok ? undefined : '未包含期望文本' });
      }
    }
  }

  for (const cmd of criteria.commands ?? []) {
    ranCommands.push(cmd.cmd);
    const expect = cmd.expectExitCode ?? 0;
    const timeout = cmd.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const res = spawnSync(cmd.cmd, {
      shell: true,
      cwd: cmd.cwd ?? opts.defaultCwd,
      timeout,
      encoding: 'utf-8',
      maxBuffer: CMD_MAX_BUFFER,
    });
    if (res.error) {
      const timedOut = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || res.signal === 'SIGTERM';
      checks.push({ kind: 'command', target: cmd.cmd, ok: false, detail: timedOut ? `超时(${timeout}ms)` : res.error.message });
    } else {
      const code = res.status ?? -1;
      const ok = code === expect;
      checks.push({ kind: 'command', target: cmd.cmd, ok, detail: ok ? undefined : `退出码 ${code}，期望 ${expect}` });
    }
  }

  const passed = checks.length > 0 && checks.every((c) => c.ok);
  return { passed, checks, evidenceChecked, ranCommands };
}

// ─── reconcile (verify → write the right ledger events) ───────────────────────

export type ReconcileAction =
  /** Verify passed → ledger is now accepted (existing or synthesized report). */
  | 'accepted'
  /** Verify failed on a worker's pending report → ledger is now rejected. */
  | 'rejected'
  /** Verify failed and nothing is on the ledger yet → caller should nudge worker;
   *  we deliberately do NOT fabricate a failed report. */
  | 'nudge'
  /** No structured criteria → caller falls back to the LLM watchdog injection. */
  | 'no-criteria'
  /** Already terminal-accepted; nothing to do. */
  | 'already-accepted'
  /** taskId not present in the ledger. */
  | 'unknown-task';

export interface ReconcileResult {
  taskId: string;
  action: ReconcileAction;
  /** The verify result (absent for unknown-task / no-criteria / already-accepted). */
  verify?: AcceptanceVerifyResult;
  /** The report the verdict was written against (accepted/rejected only). */
  reportId?: string;
  /** Whether the verdict append deduped (idempotent re-run). */
  deduped?: boolean;
}

export interface ReconcileOpts {
  /** Supervisor id recorded on the verdict trail (checkedBy). */
  checkedBy: string;
  /** Unix ms; the caller stamps it (this module never reads the clock). */
  now: number;
  /** Base cwd for command checks. */
  defaultCwd?: string;
  defaultTimeoutMs?: number;
  /** Inject a verifier (tests stub this to avoid real fs/exec). */
  verify?: (criteria: AcceptanceCriteria) => AcceptanceVerifyResult;
}

function verifySummary(v: AcceptanceVerifyResult): string {
  if (v.passed) return `${v.checks.length} 项检查全过`;
  const fail = v.checks.filter((c) => !c.ok);
  return `${fail.length}/${v.checks.length} 项未过（${fail.map((c) => c.target).join('；')}）`;
}

function verifyTrailText(v: AcceptanceVerifyResult): string {
  return v.checks
    .map((c) => `[${c.ok ? 'OK' : 'FAIL'}] ${c.kind} ${c.target}${c.detail ? ` — ${c.detail}` : ''}`)
    .join('\n');
}

/**
 * Reconcile one task by mechanically verifying its structured acceptance criteria,
 * then writing the matching ledger events. Idempotent: a passing task that's
 * already accepted returns `already-accepted` on re-run; a failing task with no
 * report writes nothing (`nudge`) so it's safe to call every tick.
 *
 * Decision table:
 *   no task ............................. unknown-task   (no write)
 *   status=accepted ..................... already-accepted (no write)
 *   no acceptanceCriteria ............... no-criteria    (no write; caller → LLM)
 *   pass + pending report .............. accept that report
 *   pass + no pending report ........... synthesize report-on-behalf + accept
 *   fail + pending report .............. reject that report
 *   fail + no pending report ........... nudge           (no write)
 */
export function reconcileTaskByCriteria(ledger: LedgerHandle, taskId: string, opts: ReconcileOpts): ReconcileResult {
  const task = ledger.task(taskId);
  if (!task) return { taskId, action: 'unknown-task' };
  if (task.status === 'accepted') return { taskId, action: 'already-accepted' };
  const criteria = task.acceptanceCriteria;
  if (!criteria) return { taskId, action: 'no-criteria' };

  const verify = opts.verify
    ? opts.verify(criteria)
    : verifyAcceptanceCriteria(criteria, { defaultCwd: opts.defaultCwd, defaultTimeoutMs: opts.defaultTimeoutMs });

  // A "pending" report is the latest report with no verdict yet — the only report
  // a fresh verdict may attach to (materialize moves status only for the latest).
  const latest = task.latestReportId ? task.reports.find((r) => r.reportId === task.latestReportId) : undefined;
  const pendingReport = latest && !latest.verdict ? latest : undefined;

  if (verify.passed) {
    let reportId = pendingReport?.reportId;
    if (!reportId) {
      // Worker never (re)reported — synthesize a report-on-behalf carrying the
      // criteria artifacts as path-evidence + the verify trail as inline evidence,
      // so the ledger has a real, inspectable delivery record (not a chat claim).
      const built = buildReport({
        taskId,
        summary: `监管者对账自动补登（worker 未自报）：${verifySummary(verify)}`,
        artifacts: (criteria.artifacts ?? []).map((a) => a.path),
        inline: [{ name: 'reconcile-verify.txt', content: verifyTrailText(verify) }],
        workerOpenId: task.workerOpenIds?.[0],
        chatId: task.chatId,
        ts: opts.now,
      }, ledger);
      ledger.append(built.draft);
      reportId = built.reportId;
    }
    const res = ledger.append({
      type: 'TaskAccepted', actor: 'orchestrator', taskId, chatId: task.chatId,
      idempotencyKey: `accepted:${taskId}:${reportId}`, ts: opts.now,
      payload: {
        taskId, reportId, checkedBy: opts.checkedBy,
        note: '对账自动验收：结构化 acceptanceCriteria 全部通过',
        evidenceChecked: verify.evidenceChecked.length ? verify.evidenceChecked : undefined,
        ranCommands: verify.ranCommands.length ? verify.ranCommands : undefined,
      },
    });
    return { taskId, action: 'accepted', verify, reportId, deduped: res.deduped };
  }

  if (pendingReport) {
    const reportId = pendingReport.reportId;
    const res = ledger.append({
      type: 'TaskRejected', actor: 'orchestrator', taskId, chatId: task.chatId,
      idempotencyKey: `rejected:${taskId}:${reportId}`, ts: opts.now,
      payload: {
        taskId, reportId, checkedBy: opts.checkedBy,
        reason: REJECT_REASON.CHECK_FAILED,
        retryBrief: `对账核验未通过：${verifySummary(verify)}`,
      },
    });
    return { taskId, action: 'rejected', verify, reportId, deduped: res.deduped };
  }

  // Nothing delivered to the ledger yet → don't fabricate a failed report; the
  // caller nudges the worker with the failed checks instead.
  return { taskId, action: 'nudge', verify };
}
