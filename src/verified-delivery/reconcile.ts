/**
 * verified-delivery/reconcile.ts — mechanical chat→ledger reconciliation (P1).
 *
 * The gap this closes: a worker often *claims* done in the goal chat but never
 * runs `botmux report`, so the ledger stays at TaskDispatched and the board never
 * advances — even though the artifacts are sitting right there on disk. The fix
 * agreed with 老滕: a worker's chat ping is a *trigger to go check the ledger*,
 * NOT proof. The mechanical layer VERIFIES the work itself by running the
 * structured acceptance criteria (#7); the chat claim is never trusted, the
 * criteria checks are the proof.
 *
 * BUT the mechanical layer is a *verifier*, not an autonomous decision-maker —
 * the supervisor (L2) is the one who 统揽 (owns the goal). So the only accept this
 * module makes on its own is confirming a delivery the worker ACTUALLY FILED
 * (`pass + pending report → accept`). When the artifacts merely satisfy the
 * criteria on disk but the worker never reported, it must NOT fabricate a
 * completion (the bug 老滕 caught: a stray/leftover file getting auto-stamped);
 * it returns `unreported-pass` with an inspection fact and lets the supervisor
 * decide (代办 report+accept with explicit trace / 催交 / 重派).
 *
 * This keeps the verified-delivery thesis intact — chat ≠ truth, evidence is —
 * while keeping ownerless completion calls out of a dumb rule. The deterministic
 * path REQUIRES structured `acceptanceCriteria`; legacy free-text tasks return
 * `no-criteria` so the caller (goal-watchdog) falls back to the LLM injection it
 * already does. The watchdog owns the *trigger* (on worker message / on tick) and
 * routing the inspection facts to L2; this module owns verify + the safe writes.
 *
 * Trust boundary: `command` checks run arbitrary shell the *dispatcher* authored
 * (same author who could already make the L2 avatar run them). P0/P1 is same-host /
 * shared-dir, so this is in-scope; we cap timeout + output and never run anything
 * a worker supplied.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  /** Verify passed on a worker's *pending report* → ledger is now accepted.
   *  This is the ONLY autonomous accept the mechanical layer is allowed to make:
   *  it merely confirms a delivery the worker actually filed. */
  | 'accepted'
  /** Verify passed but the worker NEVER filed a report — the artifacts merely
   *  happen to satisfy the criteria on disk. The mechanical layer must NOT
   *  fabricate a report+accept here (that's an ownerless completion call). It
   *  surfaces an inspection fact (see ReconcileResult.inspectionFact) and defers
   *  to the supervisor (L2): 代办 report+accept after independent verification /
   *  催交 / 重派. The supervisor — not a dumb rule — owns the decision. */
  | 'unreported-pass'
  /** Verify failed on a worker's pending report → ledger is now rejected. */
  | 'rejected'
  /** Verify failed and nothing is on the ledger yet → caller should nudge worker;
   *  we deliberately do NOT fabricate a failed report. */
  | 'nudge'
  /** No structured criteria → caller falls back to the LLM watchdog injection. */
  | 'no-criteria'
  /** Already terminal-accepted; nothing to do. */
  | 'already-accepted'
  /** Worker raised a help request (status=blocked) — NOT a failed delivery; the
   *  caller routes it to the supervisor to self-resolve/escalate, never reject. */
  | 'blocked'
  /** Supervisor escalated to a human (status=escalated) — parked, awaiting the
   *  human; the caller must NOT re-verify or nag. */
  | 'escalated'
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
  /** For 'unreported-pass' only: a human-readable fact the caller injects to the
   *  supervisor (L2) so it can decide 代办/催交/重派. Never a ledger write. */
  inspectionFact?: string;
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
 *   no task ............................. unknown-task    (no write)
 *   status=accepted ..................... already-accepted (no write)
 *   status=blocked/escalated ........... blocked/escalated (no write; → supervisor)
 *   no acceptanceCriteria ............... no-criteria     (no write; caller → LLM)
 *   pass + pending report .............. accept that report (auto-verify a real delivery)
 *   pass + no report ................... unreported-pass (no write; → supervisor decides)
 *   fail + pending report .............. reject that report
 *   fail + no pending report ........... nudge            (no write)
 */
export function reconcileTaskByCriteria(ledger: LedgerHandle, taskId: string, opts: ReconcileOpts): ReconcileResult {
  const task = ledger.task(taskId);
  if (!task) return { taskId, action: 'unknown-task' };
  if (task.status === 'accepted') return { taskId, action: 'already-accepted' };
  // A help/escalation is not a delivery to verify — never run checks (and never
  // reject) on it. The watchdog routes blocked → supervisor, escalated → parked.
  if (task.status === 'blocked') return { taskId, action: 'blocked' };
  if (task.status === 'escalated') return { taskId, action: 'escalated' };
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
    // Only autonomously accept when the worker actually FILED a report — this is a
    // deterministic confirmation of a real delivery, not an ownerless completion call.
    if (pendingReport) {
      const reportId = pendingReport.reportId;
      const res = ledger.append({
        type: 'TaskAccepted', actor: 'orchestrator', taskId, chatId: task.chatId,
        idempotencyKey: `accepted:${taskId}:${reportId}`, ts: opts.now,
        payload: {
          taskId, reportId, checkedBy: opts.checkedBy, via: 'reconcile',
          note: '对账自动验收：worker 已交付，结构化 acceptanceCriteria 全部通过',
          evidenceChecked: verify.evidenceChecked.length ? verify.evidenceChecked : undefined,
          ranCommands: verify.ranCommands.length ? verify.ranCommands : undefined,
        },
      });
      return { taskId, action: 'accepted', verify, reportId, deduped: res.deduped };
    }
    // Artifacts satisfy the criteria but the worker NEVER filed a report. The
    // mechanical layer must not fabricate a completion (the bug 老滕 caught: a
    // stray/leftover file getting auto-stamped). Surface it as a fact for the
    // supervisor to own the call: 代办 report+accept (with explicit trace) / 催交 / 重派.
    const inspectionFact = [
      `任务 ${taskId} 的产物已满足全部验收标准（${verifySummary(verify)}），但 worker 未走 botmux report 正式交付。`,
      '核验明细：',
      verifyTrailText(verify),
      '请你（监管者）判断下一步，不要直接当作已完成：',
      '① 独立核验属实 → 代 worker 落 report+accept，note 写明「supervisor 代办：worker 未自报，已独立核验」；',
      '② 让 worker 正式用 botmux report 交付；③ 产物可疑/不对 → 重派或驳回。',
    ].join('\n');
    return { taskId, action: 'unreported-pass', verify, inspectionFact };
  }

  if (pendingReport) {
    const reportId = pendingReport.reportId;
    const res = ledger.append({
      type: 'TaskRejected', actor: 'orchestrator', taskId, chatId: task.chatId,
      idempotencyKey: `rejected:${taskId}:${reportId}`, ts: opts.now,
      payload: {
        taskId, reportId, checkedBy: opts.checkedBy, via: 'reconcile',
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
