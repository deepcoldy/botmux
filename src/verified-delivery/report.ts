/**
 * verified-delivery/report.ts — pure core for the WORKER side of the trusted
 * delivery spine. Turns `botmux report --task ... --artifact ...` flags into a
 * TaskReported draft + evidence, mirroring how dispatch.ts is the I/O-free core
 * that cli.ts shells. The CLI (cmdReport) builds inputs from flags, calls
 * buildReport(), appends to the ledger, then does the existing orchestrator wake.
 */
import { createHash } from 'node:crypto';
import type { LedgerHandle } from './ledger.js';
import type { Evidence, LedgerEventDraft, TaskReportedPayload } from './types.js';

export interface InlineSpec { name?: string; content: string; }

export interface BuildReportInput {
  taskId: string;
  summary: string;
  /** path evidence — files the orchestrator must be able to read */
  artifacts?: string[];
  /** inline evidence — self-contained content pasted by the worker */
  inline?: InlineSpec[];
  /** explicit reportId (strict retry idempotency); else derived from content */
  reportId?: string;
  workerOpenId?: string;
  chatId?: string;
  ts: number;
}

export interface BuiltReport {
  draft: LedgerEventDraft;
  reportId: string;
  evidence: Evidence[];
}

/** Parse `--artifact-text name=content` specs (name optional: bare = no name). */
export function parseArtifactText(specs: string[]): InlineSpec[] {
  return specs.map((s) => {
    const eq = s.indexOf('=');
    if (eq === -1) return { content: s };
    return { name: s.slice(0, eq) || undefined, content: s.slice(eq + 1) };
  });
}

/**
 * Build the TaskReported draft + evidence. Inline evidence is spilled to the
 * ledger's content-addressed blob store here (so the event stays small). The
 * caller appends the returned draft.
 *
 * reportId: a stable derivation from (taskId + summary + evidence signature) so
 * re-running the identical report dedups, but changed evidence is a NEW attempt.
 * `--id` overrides for explicit crash-retry idempotency.
 */
export function buildReport(input: BuildReportInput, led: LedgerHandle): BuiltReport {
  const evidence: Evidence[] = [];
  for (const p of input.artifacts ?? []) evidence.push({ kind: 'path', path: p });
  for (const it of input.inline ?? []) evidence.push(led.writeInlineEvidence(it.content, it.name));
  if (evidence.length === 0) {
    throw new Error('verified report needs at least one evidence: --artifact <path> or --artifact-text <name=content>');
  }
  const sig = createHash('sha256')
    .update([
      input.taskId,
      input.summary,
      evidence.map((e) => (e.kind === 'path' ? 'p:' + e.path : 'i:' + e.ref)).join(','),
    ].join('\n'))
    .digest('hex').slice(0, 8);
  const reportId = input.reportId ?? `${input.taskId}-r${sig}`;

  const payload: TaskReportedPayload = {
    taskId: input.taskId,
    reportId,
    workerOpenId: input.workerOpenId,
    evidence,
    summary: input.summary,
  };
  const draft: LedgerEventDraft = {
    type: 'TaskReported',
    actor: 'worker',
    taskId: input.taskId,
    chatId: input.chatId,
    idempotencyKey: `reported:${reportId}`,
    ts: input.ts,
    payload,
  };
  return { draft, reportId, evidence };
}
