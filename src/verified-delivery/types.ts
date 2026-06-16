/**
 * verified-delivery/types.ts — the seam contract between the two halves of the
 * "trusted delivery spine" P0 (claude: worker-side report; codex: orchestrator
 * verify/handoff). This is a PURPOSE-BUILT minimal ledger, NOT the collab
 * control-plane: 4 events, idempotency, materialize. We borrow collab's
 * *pattern* (append-only + idempotent + materialized read-model), not its files
 * or its Run/referee/proposal semantics.
 *
 * The whole spine in one sentence: a worker cannot self-declare done in chat —
 * it must `botmux report --task <id>` with evidence the orchestrator can verify;
 * the orchestrator (the LLM judge) accepts or rejects; the Feishu task board is
 * only a human-facing projection, the ledger is the truth.
 */

/** Where a delivered result actually is, so the orchestrator can verify it. */
export type Evidence =
  /** A filesystem path the orchestrator must be able to READ (P0: same host /
   *  shared dir). If the orchestrator can't read it → reject `evidence_unreachable`. */
  | { kind: 'path'; path: string; note?: string }
  /** Self-contained content the worker pasted (test output / file body / diff).
   *  Stored as an immutable blob; the event carries a ref + small preview so the
   *  ledger line stays small (atomic append). The orchestrator reads the blob. */
  | { kind: 'inline'; ref: string; name?: string; bytes: number; preview?: string };

/** The current materialized state of one task (read-model, derived from events). */
export type TaskStatus = 'dispatched' | 'reported' | 'accepted' | 'rejected';

export interface TaskReportView {
  reportId: string;
  workerOpenId?: string;
  evidence: Evidence[];
  summary: string;
  /** Set once the orchestrator has ruled on THIS report/attempt. */
  verdict?: 'accepted' | 'rejected';
  reason?: string;            // reject reason
  checkedBy?: string;         // orchestrator openId / id
  evidenceChecked?: string[]; // which evidence the orchestrator actually inspected
  ranCommands?: string[];     // commands the orchestrator ran to verify (anti-Goodhart trail)
}

export interface TaskView {
  taskId: string;
  chatId?: string;
  title?: string;
  workerTopicRoot?: string;   // where to dispatch --into for reject/redo
  workerOpenIds?: string[];
  acceptanceHint?: string;    // how the orchestrator intends to verify (drives "make it verifiable")
  status: TaskStatus;
  latestReportId?: string;
  reports: TaskReportView[];  // every attempt, in order
}

// ─── events (exactly four) ───────────────────────────────────────────────────

export interface TaskDispatchedPayload {
  taskId: string;
  title?: string;
  workerTopicRoot?: string;
  workerOpenIds?: string[];
  brief?: string;
  acceptanceHint?: string;
}

export interface TaskReportedPayload {
  taskId: string;
  reportId: string;
  workerOpenId?: string;
  evidence: Evidence[];
  summary: string;
}

export interface TaskAcceptedPayload {
  taskId: string;
  reportId: string;
  checkedBy?: string;
  note?: string;
  evidenceChecked?: string[];
  ranCommands?: string[];
}

export interface TaskRejectedPayload {
  taskId: string;
  reportId: string;
  checkedBy?: string;
  reason: string;
  retryBrief?: string;
  expectedEvidence?: string;
}

export type LedgerEventType =
  | 'TaskDispatched'
  | 'TaskReported'
  | 'TaskAccepted'
  | 'TaskRejected';

export type LedgerActor = 'orchestrator' | 'worker';

/** What a caller hands to append() — the ledger stamps seq/eventId. */
export interface LedgerEventDraft {
  type: LedgerEventType;
  actor: LedgerActor;
  taskId: string;
  chatId?: string;
  /** Stable dedup key. Re-appending the same key is a no-op (crash-retry safe). */
  idempotencyKey: string;
  /** Unix ms; the CLI stamps it (the ledger module never reads the clock). */
  ts: number;
  payload:
    | TaskDispatchedPayload
    | TaskReportedPayload
    | TaskAcceptedPayload
    | TaskRejectedPayload;
}

/** A persisted ledger line. */
export interface LedgerEvent extends LedgerEventDraft {
  eventId: string; // `${seq}` is enough for a single-file ledger; kept explicit for refs
  seq: number;     // monotonic append order within the file
}
