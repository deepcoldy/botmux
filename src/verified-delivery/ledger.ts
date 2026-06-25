/**
 * verified-delivery/ledger.ts — the minimal append-only ledger that backs the
 * trusted delivery spine. Written by the `botmux dispatch` / `botmux report`
 * CLI commands themselves; there is NO resident process. One JSONL file +
 * idempotent appends + a materialized read-model. Inline evidence is spilled to
 * content-addressed blobs so ledger lines stay small (atomic append).
 *
 * This is deliberately tiny — see types.ts for why it is not the collab board.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import type { Evidence, LedgerEvent, LedgerEventDraft, TaskView, TaskReportView } from './types.js';

export interface LedgerHandle {
  /** Append an event; same idempotencyKey twice ⇒ second is a no-op. */
  append(draft: LedgerEventDraft): { event: LedgerEvent; deduped: boolean };
  /** All events in append order. */
  read(): LedgerEvent[];
  /** Current state of one task, or undefined if never dispatched/reported. */
  task(taskId: string): TaskView | undefined;
  /** Board for a chat (or all tasks if chatId omitted). */
  tasks(chatId?: string): TaskView[];
  /** Spill inline evidence content to a blob; returns the Evidence ref form. */
  writeInlineEvidence(content: string, name?: string): Extract<Evidence, { kind: 'inline' }>;
  /** Read inline evidence content back by ref (for the orchestrator's verify step). */
  readInlineEvidence(ref: string): string;
}

function rootDir(baseDir?: string): string {
  return baseDir ?? join(config.session.dataDir, 'verified-delivery');
}

export function openLedger(opts: { baseDir?: string } = {}): LedgerHandle {
  const dir = rootDir(opts.baseDir);
  const ledgerPath = join(dir, 'ledger.ndjson');
  const blobsDir = join(dir, 'blobs');
  const lockPath = join(dir, 'ledger.lock');

  function ensureDirs(): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(blobsDir)) mkdirSync(blobsDir, { recursive: true });
  }

  function read(): LedgerEvent[] {
    if (!existsSync(ledgerPath)) return [];
    const raw = readFileSync(ledgerPath, 'utf-8');
    const out: LedgerEvent[] = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s) as LedgerEvent); } catch { /* skip a torn line */ }
    }
    return out;
  }

  /** Exclusive-create spinlock — read-check-append must be serialized for
   *  idempotency to hold under concurrent CLI processes across daemons. */
  function withLock<T>(fn: () => T): T {
    ensureDirs();
    let fd: number | undefined;
    for (let i = 0; i < 200; i++) {
      try { fd = openSync(lockPath, 'wx'); break; } catch { /* held */ }
      // busy-wait a touch; appends are sub-ms so contention windows are tiny
      const until = Date.now() + 15;
      while (Date.now() < until) { /* spin */ }
    }
    // NEVER fall through to an unlocked write — that would defeat the
    // read-check-append serialization (dup seq / broken idempotency). Make the
    // caller retry instead.
    if (fd === undefined) throw new Error('verified-delivery ledger lock timeout');
    try {
      return fn();
    } finally {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch { /* */ }
    }
  }

  function append(draft: LedgerEventDraft): { event: LedgerEvent; deduped: boolean } {
    // Contract invariant enforced at the seam: a report with no evidence is not
    // verifiable, so the ledger refuses it — don't rely on the report CLI alone.
    if (draft.type === 'TaskReported') {
      const ev = (draft.payload as import('./types.js').TaskReportedPayload).evidence;
      if (!Array.isArray(ev) || ev.length === 0) {
        throw new Error('TaskReported requires at least one evidence item (path or inline)');
      }
    }
    return withLock(() => {
      const existing = read();
      const dup = existing.find((e) => e.idempotencyKey === draft.idempotencyKey);
      if (dup) return { event: dup, deduped: true };
      const seq = existing.length + 1;
      const event: LedgerEvent = { ...draft, eventId: String(seq), seq };
      appendFileSync(ledgerPath, JSON.stringify(event) + '\n');
      return { event, deduped: false };
    });
  }

  function materialize(events: LedgerEvent[]): Map<string, TaskView> {
    const byTask = new Map<string, TaskView>();
    const ensure = (taskId: string, chatId?: string): TaskView => {
      let t = byTask.get(taskId);
      if (!t) { t = { taskId, chatId, status: 'dispatched', reports: [] }; byTask.set(taskId, t); }
      return t;
    };
    const findReport = (t: TaskView, reportId: string): TaskReportView | undefined =>
      t.reports.find((r) => r.reportId === reportId);

    for (const e of events) {
      if (e.type === 'TaskDispatched') {
        const p = e.payload as import('./types.js').TaskDispatchedPayload;
        const t = ensure(e.taskId, e.chatId);
        t.chatId = e.chatId ?? t.chatId;
        t.title = p.title ?? t.title;
        t.workerTopicRoot = p.workerTopicRoot ?? t.workerTopicRoot;
        t.workerOpenIds = p.workerOpenIds ?? t.workerOpenIds;
        t.workerNames = p.workerNames ?? t.workerNames;
        t.workerLarkAppIds = p.workerLarkAppIds ?? t.workerLarkAppIds;
        t.workerCliIds = p.workerCliIds ?? t.workerCliIds;
        t.workerBotUnionIds = p.workerBotUnionIds ?? t.workerBotUnionIds;
        t.acceptanceHint = p.acceptanceHint ?? t.acceptanceHint;
        t.acceptanceCriteria = p.acceptanceCriteria ?? t.acceptanceCriteria;
        // A (re)dispatch re-activates a fresh OR a help-blocked/escalated task —
        // it's the supervisor's "go again" after addressing the blocker. It must
        // NOT clobber a reported/accepted/rejected task (late metadata dispatch).
        if (t.reports.length === 0 || t.status === 'blocked' || t.status === 'escalated') t.status = 'dispatched';
      } else if (e.type === 'TaskReported') {
        const p = e.payload as import('./types.js').TaskReportedPayload;
        const t = ensure(e.taskId, e.chatId);
        if (!findReport(t, p.reportId)) {
          t.reports.push({ reportId: p.reportId, workerOpenId: p.workerOpenId, evidence: p.evidence, summary: p.summary });
        }
        t.latestReportId = p.reportId;
        t.status = 'reported';
      } else if (e.type === 'TaskAccepted') {
        const p = e.payload as import('./types.js').TaskAcceptedPayload;
        const t = ensure(e.taskId, e.chatId);
        const r = findReport(t, p.reportId);
        if (r) { r.verdict = 'accepted'; r.checkedBy = p.checkedBy; r.evidenceChecked = p.evidenceChecked; r.ranCommands = p.ranCommands; r.verdictVia = p.via ?? r.verdictVia; }
        // Only the verdict on the CURRENT attempt moves the task. A late verdict
        // for a superseded report still records on that report, but must not drag
        // a fresh attempt back to a terminal state.
        if (p.reportId === t.latestReportId) t.status = 'accepted';
      } else if (e.type === 'TaskRejected') {
        const p = e.payload as import('./types.js').TaskRejectedPayload;
        const t = ensure(e.taskId, e.chatId);
        const r = findReport(t, p.reportId);
        if (r) { r.verdict = 'rejected'; r.reason = p.reason; r.checkedBy = p.checkedBy; r.verdictVia = p.via ?? r.verdictVia; }
        if (p.reportId === t.latestReportId) t.status = 'rejected';
      } else if (e.type === 'TaskHelpRequested') {
        const p = e.payload as import('./types.js').TaskHelpRequestedPayload;
        const t = ensure(e.taskId, e.chatId);
        t.help = { blocker: p.blocker, kind: p.kind, workerOpenId: p.workerOpenId };
        // A help request parks the task as 'blocked' awaiting the supervisor — but
        // never overrides a terminal verdict (a late help after accept is noise).
        if (t.status !== 'accepted' && t.status !== 'rejected') t.status = 'blocked';
      } else if (e.type === 'TaskEscalated') {
        const p = e.payload as import('./types.js').TaskEscalatedPayload;
        const t = ensure(e.taskId, e.chatId);
        t.escalation = { reason: p.reason, by: p.by, retryBrief: p.retryBrief };
        if (t.status !== 'accepted' && t.status !== 'rejected') t.status = 'escalated';
      }
    }
    return byTask;
  }

  function writeInlineEvidence(content: string, name?: string): Extract<Evidence, { kind: 'inline' }> {
    ensureDirs();
    const bytes = Buffer.byteLength(content, 'utf-8');
    const ref = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const blobPath = join(blobsDir, ref);
    if (!existsSync(blobPath)) writeFileSync(blobPath, content);
    const preview = content.length > 200 ? content.slice(0, 200) + '…' : content;
    return { kind: 'inline', ref, name, bytes, preview };
  }

  function readInlineEvidence(ref: string): string {
    const blobPath = join(blobsDir, ref);
    if (!existsSync(blobPath)) throw new Error(`inline evidence blob not found: ${ref}`);
    return readFileSync(blobPath, 'utf-8');
  }

  return {
    append,
    read,
    task: (taskId) => materialize(read()).get(taskId),
    tasks: (chatId) => {
      const all = [...materialize(read()).values()];
      return chatId ? all.filter((t) => t.chatId === chatId) : all;
    },
    writeInlineEvidence,
    readInlineEvidence,
  };
}
