/**
 * verified-delivery/types.ts — the seam contract between the two halves of the
 * "trusted delivery spine" P0 (claude: worker-side report; codex: orchestrator
 * verify/handoff). This is a PURPOSE-BUILT minimal ledger, NOT the collab
 * control-plane: a deliberately small event set, idempotency, materialize. We
 * borrow collab's *pattern* (append-only + idempotent + materialized read-model),
 * not its files or its Run/referee/proposal semantics.
 *
 * The whole spine in one sentence: a worker cannot self-declare done in chat —
 * it must `botmux report --task <id>` with evidence the orchestrator can verify;
 * the orchestrator (the LLM judge) accepts or rejects; the Feishu task board is
 * only a human-facing projection, the ledger is the truth.
 *
 * Beyond the success path there is a HELP/ESCALATION rung (so a stuck worker has
 * a dignified exit instead of faking "done" or going silent): the worker raises
 * `TaskHelpRequested` (status→blocked); the supervisor self-resolves (re-dispatch
 * / clarify) or, when only a human can decide, raises `TaskEscalated`
 * (status→escalated) which lights the dashboard "需要你" via the parent session.
 * Help is a ledger event — NOT a chat message — for the same reason completion is:
 * chat can be missed, the ledger is discovered by querying it.
 */

/** Where a delivered result actually is, so the orchestrator can verify it. */
export type Evidence =
  /** A filesystem path the orchestrator must be able to READ (P0: same host /
   *  shared dir). If the orchestrator can't read it → reject `evidence_unreachable`. */
  | { kind: 'path'; path: string; note?: string }
  /** Self-contained content the worker pasted (test output / file body / diff).
   *  Stored as an immutable blob; the event carries a ref + small preview so the
   *  ledger line stays small (atomic append). The orchestrator reads the blob. */
  | { kind: 'inline'; ref: string; name?: string; bytes: number; preview?: string }
  /** A URL the orchestrator can FETCH to verify (CI log, gist, object store).
   *  For cross-device/external workers whose filesystem the L2 can't read — the
   *  verifier fetches it instead of reading a local path. Ingested from delivery
   *  envelopes (see envelope.ts); fetch-based verification lands with the
   *  ingestion seam. */
  | { kind: 'url'; url: string; note?: string };

// ─── acceptance criteria (P1 #7: field-ize the JSON-in-acceptanceHint) ─────────
// Until P1 #7 the orchestrator's verification intent lived as an opaque JSON
// string stuffed into `acceptanceHint`; the L2 avatar parsed it by convention and
// the daemon never understood it. Here it becomes a first-class, validated shape:
// dispatch can reject a malformed criteria up-front, the watchdog can render the
// checklist, and (later) the daemon can run the checks itself without an L2.
// The free-text `acceptanceHint` survives for back-compat (plain-language hints).

/** One machine-checkable assertion about an artifact. v1 keeps the set tiny —
 *  exactly what the e2e templates already use — so it stays trivially verifiable. */
export type AcceptanceCheck =
  /** The artifact path exists on the verifier's filesystem. */
  | { type: 'exists' }
  /** The artifact's text content contains `text` (substring, not regex). */
  | { type: 'contains'; text: string };

/** A produced artifact the orchestrator intends to verify. */
export interface AcceptanceArtifact {
  /** Absolute path (P0/P1: same host / shared dir as the verifier). */
  path: string;
  kind?: 'file' | 'dir';
  checks: AcceptanceCheck[];
}

/** A command the orchestrator intends to run to verify the delivery. */
export interface AcceptanceCommand {
  cmd: string;
  cwd?: string;
  /** Expected process exit code (default 0 when omitted). */
  expectExitCode?: number;
  timeoutMs?: number;
}

/** Structured, validated form of the orchestrator's verification plan. */
export interface AcceptanceCriteria {
  version: 1;
  artifacts?: AcceptanceArtifact[];
  commands?: AcceptanceCommand[];
}

/** The current materialized state of one task (read-model, derived from events).
 *  planned = the task is durably registered but has not been sent to a worker;
 *  its dependency gate is owned by the release engine.
 *  blocked = worker raised a help request, awaiting the supervisor.
 *  escalated = supervisor couldn't resolve, awaiting a human decision.
 *  cancelled = supervisor intentionally stopped the task; only an explicit
 *  re-dispatch may reactivate it. */
export type TaskStatus = 'planned' | 'dispatched' | 'reported' | 'accepted' | 'rejected' | 'blocked' | 'escalated' | 'cancelled';

/** Why a worker is stuck (kept tiny + enum-like so the board/stats can group). */
export type HelpKind = 'access' | 'ambiguous' | 'impossible' | 'repeated_failure' | 'other';

/** How a verdict was produced. Omitted ⇒ a human ruled via the `delivery` CLI;
 *  'reconcile' ⇒ the mechanical reconciler ran the structured acceptance criteria
 *  itself (see reconcile.ts) — so the board can distinguish 🤖 auto from 👤 human. */
export type VerdictVia = 'reconcile';

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
  verdictVia?: VerdictVia;    // 'reconcile' when the mechanical reconciler ruled; else human/CLI
}

/** The latest help request raised on a task (worker → supervisor). */
export interface TaskHelpView {
  blocker: string;            // what's blocking — the whole point, required
  kind?: HelpKind;
  workerOpenId?: string;      // who raised it
}

/** The latest escalation raised on a task (supervisor → human). */
export interface TaskEscalationView {
  reason: string;             // why a human is needed
  by?: string;                // supervisor/orchestrator id who escalated
  retryBrief?: string;        // context / what the human should decide
}

/** The latest intentional cancellation (supervisor/main controller decision). */
export interface TaskCancellationView {
  reason: string;
  by?: string;
}

/** One worker as frozen by TaskPlanned. This is deliberately wider than the
 *  local dispatch-worker-meta lookup result: a release must be able to rebuild
 *  the exact wire mention and final TaskDispatched payload after a restart. */
export interface TaskDispatchWorkerSpec {
  openId: string;
  name?: string;
  role?: string;
  larkAppId?: string;
  cliId?: string;
  unionId?: string;
}

/** Complete v1 dispatch surface frozen when a dependency-gated task is planned.
 *  Adding a new dispatch option requires adding it here explicitly. */
export interface TaskPlanDispatchSpec {
  title: string;
  briefBase: string;
  workers: TaskDispatchWorkerSpec[];
  senderLarkAppId: string;
  requiredRepo?: string;
  acceptanceHint?: string;
  acceptanceCriteria?: AcceptanceCriteria;
}

export interface TaskPlanView {
  planEventId: string;
  planGeneration: number;
  dependsOnTaskIds: string[];
  dispatchSpec: TaskPlanDispatchSpec;
  plannedBy: string;
}

export interface TaskReleaseDependency {
  taskId: string;
  acceptedEventId: string;
}

export type TaskDispatchFailureClass = 'definite' | 'ambiguous';

export interface TaskDispatchFailureView {
  eventId: string;
  ts: number;
  failureClass: TaskDispatchFailureClass;
  code: string;
  detail: string;
  failedBy: string;
}

/** An outbox-style release claim. While this view is present the task remains
 *  planned; only a matching TaskDispatched may advance it. */
export interface TaskPendingReleaseView {
  intentEventId: string;
  intentAt: number;
  releaseId: string;
  attempt: number;
  planEventId: string;
  planGeneration: number;
  satisfiedBy: TaskReleaseDependency[];
  senderLarkAppId: string;
  goalChatId: string;
  frozenKickoffText: string;
  frozenWorkerSpecs: TaskDispatchWorkerSpec[];
  frozenDispatchedPayload: TaskDispatchedPayload;
  releasedBy: string;
  failure?: TaskDispatchFailureView;
}

export interface TaskView {
  taskId: string;
  chatId?: string;
  title?: string;
  workerTopicRoot?: string;   // where to dispatch --into for reject/redo
  workerOpenIds?: string[];
  /** Display names for the workers, index-aligned with workerOpenIds. Captured at
   *  dispatch from the `--bot <id:name:role>` label — open_id is per-app scoped so
   *  it can't be resolved to a name cross-app; the name is stored at the source. */
  workerNames?: string[];
  /** Index-aligned larkAppId / cliId for each worker (B2 deterministic re-dispatch:
   *  hard-scope the worker's session + re-spawn the same CLI). */
  workerLarkAppIds?: string[];
  workerCliIds?: string[];
  /** Index-aligned tenant-stable bot union_id for each worker — the authorization
   *  anchor for cross-device delivery-envelope ingestion. Unlike open_id (per-app
   *  scoped, has mis-bound twice) it is on every inbound event (sender_id.union_id),
   *  so a remote worker's report/help envelope can be authorized by
   *  `senderUnionId ∈ workerBotUnionIds` with no prior observation. Distinct from
   *  workerLarkAppIds/workerCliIds, which serve local re-dispatch/health. */
  workerBotUnionIds?: string[];
  /** Canonical git remote URL (preferred) or local alias required by this task.
   *  The receiving daemon resolves it on its own machine before starting the
   *  worker; paths are intentionally never shared across devices. */
  requiredRepo?: string;
  acceptanceHint?: string;    // legacy free-text intent (kept for back-compat / display)
  acceptanceCriteria?: AcceptanceCriteria; // P1 #7: structured, validated verify plan (preferred)
  status: TaskStatus;
  /** Event that most recently activated this task (TaskPlanned for dependency-
   *  gated tasks, TaskDispatched otherwise). Cancellation idempotency binds here. */
  activationEventId?: string;
  /** The event that actually transitioned the current report to accepted. */
  acceptedEventId?: string;
  /** Present for every task that has ever used the dependency gate. */
  plan?: TaskPlanView;
  /** Present while a planned release has been claimed but not dispatched. */
  pendingRelease?: TaskPendingReleaseView;
  latestReleaseId?: string;
  dispatchMessageId?: string;
  dispatchConfirmedBy?: string;
  /** Event id of the cancellation currently represented by `cancellation`. */
  cancellationEventId?: string;
  latestReportId?: string;
  reports: TaskReportView[];  // every attempt, in order
  /** Latest help request (present once a worker has ever raised one). */
  help?: TaskHelpView;
  /** Latest escalation (present once the supervisor has ever escalated). */
  escalation?: TaskEscalationView;
  /** Present while the task is cancelled; cleared by an explicit re-dispatch. */
  cancellation?: TaskCancellationView;
}

// ─── events ──────────────────────────────────────────────────────────────────

export interface TaskDispatchedPayload {
  taskId: string;
  title?: string;
  workerTopicRoot?: string;
  workerOpenIds?: string[];
  /** Index-aligned display names for workerOpenIds (from `--bot <id:name:role>`). */
  workerNames?: string[];
  /** Index-aligned larkAppId for each worker (resolved at dispatch). Lets the
   *  watchdog hard-scope a worker's session for deterministic re-dispatch (B2) —
   *  open_id alone is per-app and ambiguous cross-daemon. */
  workerLarkAppIds?: string[];
  /** Index-aligned cliId for each worker (so re-dispatch can re-spawn the same
   *  CLI). sessionId is intentionally NOT recorded — the worker session isn't
   *  spawned until after dispatch; the watchdog resolves it live by goalChatId +
   *  larkAppId/openId. */
  workerCliIds?: string[];
  /** Index-aligned tenant-stable bot union_id for each worker. union_id is the
   *  only worker identifier that is BOTH stable cross-app AND present on every
   *  inbound message event (sender_id.union_id) — so it is the authorization anchor
   *  for cross-device / external delivery envelopes: a remote worker's report/help
   *  can be authorized by `senderUnionId ∈ workerBotUnionIds` without any prior
   *  observation (open_id is per-app and only learnable after the bot is seen).
   *  Resolved at dispatch from the federation roster's botUnionId when available;
   *  left empty when it can't be resolved (those workers fall back to open_id auth).
   *  Does NOT replace workerLarkAppIds/workerCliIds, which serve local
   *  re-dispatch/health — different responsibility, kept independently. */
  workerBotUnionIds?: string[];
  /** Canonical git remote URL (preferred) or receiver-local alias. */
  requiredRepo?: string;
  brief?: string;
  acceptanceHint?: string;
  acceptanceCriteria?: AcceptanceCriteria;
  /** Present when this dispatch materialized a TaskDispatchIntent. */
  releaseId?: string;
  /** Lark send receipt. May be absent only for an explicit human confirmation. */
  dispatchMessageId?: string;
  confirmedBy?: string;
}

/** Register a task and its immutable dependency edges without contacting the
 *  worker. A later generation may update the dispatch spec but not the edges. */
export interface TaskPlannedPayload {
  taskId: string;
  chatId: string;
  title: string;
  dependsOnTaskIds: string[];
  planGeneration: number;
  reopenOfCancelEventId?: string;
  dispatchSpec: TaskPlanDispatchSpec;
  plannedBy: string;
}

/** Durable outbox claim for one automatic release attempt. */
export interface TaskDispatchIntentPayload {
  taskId: string;
  releaseId: string;
  attempt: number;
  planEventId: string;
  planGeneration: number;
  satisfiedBy: TaskReleaseDependency[];
  senderLarkAppId: string;
  goalChatId: string;
  frozenKickoffText: string;
  frozenWorkerSpecs: TaskDispatchWorkerSpec[];
  frozenDispatchedPayload: TaskDispatchedPayload;
  releasedBy: string;
}

/** Persistent classification of a release attempt that did not complete. */
export interface TaskDispatchFailedPayload {
  taskId: string;
  releaseId: string;
  planEventId: string;
  planGeneration: number;
  attempt: number;
  failureClass: TaskDispatchFailureClass;
  code: string;
  detail: string;
  failedBy: string;
}

/** Provenance for an event that entered the ledger from a goal-group delivery
 *  envelope (cross-device / external worker P0) rather than a local CLI write.
 *  Lets the board/audit distinguish "ingested from a group message" and records
 *  who (verified Lark sender) + which message, for traceability. */
export interface DeliverySource {
  via: 'envelope';
  /** Lark messageId of the envelope message (audit + ingestion idempotency). */
  messageId?: string;
  /** Verified Lark sender open_id; authorization was checked at ingestion. */
  senderOpenId?: string;
}

export interface TaskReportedPayload {
  taskId: string;
  reportId: string;
  workerOpenId?: string;
  evidence: Evidence[];
  summary: string;
  /** Set when ingested from a goal-group envelope (remote/external worker). */
  source?: DeliverySource;
}

export interface TaskAcceptedPayload {
  taskId: string;
  reportId: string;
  checkedBy?: string;
  note?: string;
  evidenceChecked?: string[];
  ranCommands?: string[];
  via?: VerdictVia;  // 'reconcile' for the mechanical reconciler; omitted for human/CLI accepts
}

export interface TaskRejectedPayload {
  taskId: string;
  reportId: string;
  checkedBy?: string;
  /** Stable enum-like code (see REJECT_REASON); human detail goes in retryBrief. */
  reason: string;
  retryBrief?: string;
  expectedEvidence?: string;
  via?: VerdictVia;  // 'reconcile' for the mechanical reconciler; omitted for human/CLI rejects
}

/** Worker → supervisor: "I'm stuck and can't finish." A deliberate hand-raise,
 *  distinct from a silent stall (watchdog/reconcile handles that) and from a
 *  failed report (reject). The supervisor self-resolves or escalates. */
export interface TaskHelpRequestedPayload {
  taskId: string;
  workerOpenId?: string;
  blocker: string;
  kind?: HelpKind;
  /** Set when ingested from a goal-group envelope (remote/external worker). */
  source?: DeliverySource;
}

/** Supervisor → human: "I can't resolve this; a person must decide." Lights the
 *  dashboard "需要你" on the parent (L1) session via daemon-native notify. */
export interface TaskEscalatedPayload {
  taskId: string;
  reason: string;
  by?: string;
  retryBrief?: string;
}

/** Supervisor/main controller intentionally stops a task without pretending it
 *  was delivered or rejected. Raw history remains in the append-only ledger. */
export interface TaskCancelledPayload {
  taskId: string;
  reason: string;
  by?: string;
}

/** Stable reject codes both halves share, so UI / stats can recognise them.
 *  Detail/instructions ride in retryBrief / expectedEvidence, not in the code. */
export const REJECT_REASON = {
  /** Orchestrator could not read the path evidence (P0: not same-host/reachable). */
  EVIDENCE_UNREACHABLE: 'evidence_unreachable',
  /** Acceptance check ran and failed (test non-zero / output mismatch). */
  CHECK_FAILED: 'check_failed',
  /** Delivered result doesn't meet the brief on inspection. */
  INSUFFICIENT: 'insufficient',
} as const;
export type RejectReason = (typeof REJECT_REASON)[keyof typeof REJECT_REASON];

export type LedgerEventType =
  | 'TaskPlanned'
  | 'TaskDispatchIntent'
  | 'TaskDispatchFailed'
  | 'TaskDispatched'
  | 'TaskReported'
  | 'TaskAccepted'
  | 'TaskRejected'
  | 'TaskHelpRequested'
  | 'TaskEscalated'
  | 'TaskCancelled';

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
    | TaskPlannedPayload
    | TaskDispatchIntentPayload
    | TaskDispatchFailedPayload
    | TaskDispatchedPayload
    | TaskReportedPayload
    | TaskAcceptedPayload
    | TaskRejectedPayload
    | TaskHelpRequestedPayload
    | TaskEscalatedPayload
    | TaskCancelledPayload;
}

/** A persisted ledger line. */
export interface LedgerEvent extends LedgerEventDraft {
  eventId: string; // `${seq}` is enough for a single-file ledger; kept explicit for refs
  seq: number;     // monotonic append order within the file
}
