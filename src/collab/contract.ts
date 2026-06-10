/**
 * collab/contract.ts — THE SEAM between the state-core (src/collab/*, owned by
 * claude) and the botmux integration面 (daemon/registry/IM/control-plane, owned
 * by codex).  This file is the only thing both sides compile against.
 *
 * Architecture (P0.0 walking skeleton):
 *   - CQRS / event-sourcing.  The *event log* is the single write-model; the
 *     *board snapshot* is a materialized read-model derived by replaying events.
 *   - The ONLY way to mutate state is `CollabBoard.append(draft)` with a typed
 *     event.  Nobody — least of all the integration面 — writes the read-model
 *     directly.  (codex constraint #2.)
 *   - Every state change is therefore replayable: kill a worker / restart the
 *     daemon → re-derive the exact same board from the log.  That replayability
 *     is the whole point of P0.0 (see the three acceptance tests at the bottom).
 *
 * Conventions deliberately mirror src/workflows/events/* so this can later be
 * split into payloads.ts / schema.ts / types.ts without churn.  For review it
 * lives in one annotated file.
 *
 * schemaVersion: 1
 */
import { z } from 'zod';

export const COLLAB_SCHEMA_VERSION = 1 as const;

// ════════════════════════════════════════════════════════════════════════════
// 1. Primitives & shared id fragments  (the fields codex asked to nail down)
// ════════════════════════════════════════════════════════════════════════════

/** `<runId>-<seq>`, seq a positive integer. Mirrors workflows' eventId rule. */
export const EventIdSchema = z
  .string()
  .regex(/^.+-[1-9]\d*$/, 'eventId must be <runId>-<seq> with positive integer seq');

export const RunIdSchema = z.string().min(1);
export const TaskIdSchema = z.string().min(1);
export const WorkerIdSchema = z.string().min(1);
export const TopicIdSchema = z.string().min(1); // Lark thread/topic root_id
export const ArtifactIdSchema = z.string().min(1);
/** Idempotency key — append() dedupes on (runId, idempotencyKey). Caller-supplied. */
export const IdempotencyKeySchema = z.string().min(1);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Who emitted the event. Deterministic system actors only — no free bots. */
export const CollabActorEnum = z.enum([
  'control-plane', // the daemon wearing the control identity (deterministic code)
  'worker',        // a forked CLI session doing a task
  'referee',       // deterministic code that runs acceptance tests
  'human',         // a person, via a Lark card / message
  'system',        // budget breaker, lease watchdog, replay
]);
export type CollabActor = z.infer<typeof CollabActorEnum>;

/**
 * Board paths — the addressable sections of the read-model.  `affectedPaths`
 * on an event declares which sections it mutates; the materializer uses this
 * to know what to recompute and (future) to detect conflicts.  Lifecycle-only
 * events carry `[]`.
 */
export const BoardPathEnum = z.enum([
  'goal',
  'acceptanceCriteria',
  'task',
  'worker',
  'artifacts',
  'progressLog',
  'stall',
  'budget',
  'interventions',
  'status',
]);
export type BoardPath = z.infer<typeof BoardPathEnum>;

/** Delivery state of a human intervention. delivered→read→applied, or superseded. */
export const ReceiptStateEnum = z.enum([
  'delivered',  // control-plane pushed it to the worker (or queued at turn boundary)
  'read',       // worker saw it during a turn
  'applied',    // worker actually incorporated it into its work
  'superseded', // a newer intervention replaced it before it was applied
]);
export type ReceiptState = z.infer<typeof ReceiptStateEnum>;

// ════════════════════════════════════════════════════════════════════════════
// 2. Event envelope  (shared by every event; payload is discriminated on `type`)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Envelope fields common to all events. The fields codex pinned live here so
 * they have ONE canonical name/shape across the whole log:
 *   eventId, runId, (seq via eventId), actor, idempotencyKey, baseRevision,
 *   affectedPaths, topicId?, taskId?, workerId?, budgetDelta?
 *
 * - `baseRevision` = the board revision the actor had observed when it produced
 *   this event. P0.0 conflict policy is last-write-wins: append never rejects on
 *   a stale baseRevision, it applies the write and logs a ConflictRaised event.
 *   The field is recorded now so real CAS can be turned on later with no schema
 *   change. (codex constraint #4: defer concurrency, keep the seam.)
 * - `budgetDelta` = signed token/credit delta this event contributes. The budget
 *   materializer sums it across ALL events, so any event can spend/return budget
 *   without a bespoke handler.
 */
const EnvelopeBase = {
  eventId: EventIdSchema,
  runId: RunIdSchema,
  seq: z.number().int().positive(),
  schemaVersion: z.literal(COLLAB_SCHEMA_VERSION),
  timestamp: z.number().int().nonnegative(),
  actor: CollabActorEnum,
  idempotencyKey: IdempotencyKeySchema,
  baseRevision: z.number().int().nonnegative(),
  affectedPaths: z.array(BoardPathEnum),
  // optional correlators — present when relevant, same name everywhere
  topicId: TopicIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  workerId: WorkerIdSchema.optional(),
  budgetDelta: z.number().optional(),
};

// Helper to declare an event = envelope + {type, payload}.
function event<T extends string, P extends z.ZodRawShape>(type: T, payload: z.ZodObject<P>) {
  return z.object({
    ...EnvelopeBase,
    type: z.literal(type),
    payload,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Event payloads & schemas  (the P0.0 event vocabulary)
// ════════════════════════════════════════════════════════════════════════════

// ── acceptance criteria (P0.0: a command the referee runs itself) ────────────
export const AcceptanceCriteriaSchema = z.object({
  /** Shell command the REFEREE executes to judge done/progress. Never trusted
   *  to the worker — the referee runs it, that is the provenance. */
  command: z.string().min(1),
  /** Human-readable statement of done. */
  description: z.string().optional(),
  /** done ⇔ exit code 0. (Only mode in P0.0; left explicit for forward-compat.) */
  doneWhen: z.literal('exitZero').default('exitZero'),
  /** Optional progress measure. `pattern` is a regex whose first capture group
   *  is a number the referee extracts from the command's combined output (e.g.
   *  failing-test count); LOWER value = progress. When absent, the referee's
   *  verdict is binary (done / stuck) with no progress gradient. */
  progressMetric: z.object({ name: z.string().min(1), pattern: z.string().min(1) }).optional(),
});
export type AcceptanceCriteria = z.infer<typeof AcceptanceCriteriaSchema>;

// ── run / goal lifecycle (control-plane) ─────────────────────────────────────
export const RunCreatedEventSchema = event('RunCreated', z.object({
  goal: z.string().min(1),
  acceptanceCriteria: AcceptanceCriteriaSchema,
  budgetLimit: z.number().positive(),
  budgetUnit: z.enum(['tokens', 'usd', 'turns']).default('tokens'),
  controlTopicId: TopicIdSchema,
}));

export const GoalChangedEventSchema = event('GoalChanged', z.object({
  goal: z.string().min(1),
  /** eventId of the GoalChangeRequested this fulfils, if human-initiated. */
  fromRequest: EventIdSchema.optional(),
}));

export const AcceptanceCriteriaChangedEventSchema = event('AcceptanceCriteriaChanged', z.object({
  acceptanceCriteria: AcceptanceCriteriaSchema,
  fromRequest: EventIdSchema.optional(),
}));

export const RunFinishedEventSchema = event('RunFinished', z.object({
  outcome: z.enum(['succeeded', 'failed', 'stopped', 'budget-exhausted']),
  summary: z.string().optional(),
}));

// ── task (P0.0: exactly one task) ────────────────────────────────────────────
export const TaskCreatedEventSchema = event('TaskCreated', z.object({
  taskId: TaskIdSchema,
  title: z.string().min(1),
  spec: z.string().min(1),
}));

export const TaskAssignedEventSchema = event('TaskAssigned', z.object({
  taskId: TaskIdSchema,
  workerId: WorkerIdSchema,
}));

export const TaskStatusEnum = z.enum(['open', 'in_progress', 'blocked', 'done', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatusEnum>;
export const TaskStatusChangedEventSchema = event('TaskStatusChanged', z.object({
  taskId: TaskIdSchema,
  status: TaskStatusEnum,
  note: z.string().optional(),
}));

// ── worker lease lifecycle (the kill/resume命题) ─────────────────────────────
export const WorkerAllocatedEventSchema = event('WorkerAllocated', z.object({
  workerId: WorkerIdSchema,
  taskId: TaskIdSchema,
  /** epoch ms; watchdog reclaims the lease past this. */
  leaseExpiresAt: z.number().int().positive().optional(),
  /** Where this worker physically runs. `larkAppId` is set iff the worker is
   *  a pooled identity (its own bot, not the control app). `topicId` is set
   *  whenever the worker's route is independent of the control topic — pooled
   *  worker AND/OR a per-run worker topic (T2: control-plane creates a fresh
   *  topic per run and anchors the worker session there; reallocation keeps
   *  the same topic — the topic belongs to the run, not the process). Both
   *  omitted ⇒ legacy colocated-under-control behaviour. */
  larkAppId: z.string().optional(),
  topicId: z.string().optional(),
}));
export const WorkerTurnStartedEventSchema = event('WorkerTurnStarted', z.object({
  workerId: WorkerIdSchema,
}));
export const WorkerTurnFinishedEventSchema = event('WorkerTurnFinished', z.object({
  workerId: WorkerIdSchema,
  reason: z.enum(['yielded', 'completed', 'suspended']),
}));
export const WorkerLostEventSchema = event('WorkerLost', z.object({
  workerId: WorkerIdSchema,
  detectedBy: z.enum(['watchdog', 'crash', 'control-plane']),
  reason: z.string().optional(),
}));

// ── artifacts & progress (worker writes artifacts; referee writes verdicts) ──
export const ArtifactRecordedEventSchema = event('ArtifactRecorded', z.object({
  artifactId: ArtifactIdSchema,
  kind: z.enum(['file', 'diff', 'log', 'note']),
  path: z.string().min(1),
  sha256: Sha256Schema.optional(),
  note: z.string().optional(),
}));

export const RefereeVerdictEnum = z.enum(['done', 'progressing', 'stuck', 'regressed']);
export type RefereeVerdict = z.infer<typeof RefereeVerdictEnum>;

/** P2 dual output: which way this evaluation moved relative to the last one.
 *  'improved' resets the stall streak; everything else extends it. First
 *  measurement WITH a metric = 'improved' (a baseline is information gained);
 *  a failing binary evaluation with no metric = 'unknown' (no progress signal
 *  at all — exactly the case that should escalate fastest). */
export const ProgressDirectionEnum = z.enum(['improved', 'regressed', 'flat', 'unknown']);
export type ProgressDirection = z.infer<typeof ProgressDirectionEnum>;

export const RefereeEvaluatedEventSchema = event('RefereeEvaluated', z.object({
  taskId: TaskIdSchema,
  /** Human-readable rollup of (completion, progress); kept for continuity. */
  verdict: RefereeVerdictEnum,
  /** Proof the verdict is real, not claimed — the referee ran the command. */
  provenance: z.object({
    /** Which oracle adapter produced this evaluation. P2 v1: exec only. */
    adapter: z.enum(['exec']).optional(),
    command: z.string(),
    exitCode: z.number().int(),
    durationMs: z.number().int().nonnegative().optional(),
    summary: z.string().optional(),
  }),
  /** Optional numeric progress signal (e.g. failing-test count) + its prior. */
  signal: z.object({
    metric: z.string(),
    value: z.number(),
    prevValue: z.number().optional(),
  }).optional(),
  /** P2 dual output ① — completion decides termination, nothing else does. */
  completion: z.object({
    done: z.boolean(),
    rule: z.literal('exitZero'),
  }).optional(),
  /** P2 dual output ② — progress informs budget attention, never termination.
   *  streak = consecutive evaluations without improvement, INCLUDING this one;
   *  0 when improved/done. */
  progress: z.object({
    direction: ProgressDirectionEnum,
    streak: z.number().int().nonnegative(),
  }).optional(),
}));

/** Edge-trigger raised by the referee when the no-improvement streak hits the
 *  stall threshold (and again at each further multiple). The board only
 *  records it; notifying the control topic is the integration面's reaction.
 *  Budget remains the only breaker — a stall NEVER terminates the run, it
 *  schedules human attention before the wallet burns dry. */
export const ProgressStallRaisedEventSchema = event('ProgressStallRaised', z.object({
  taskId: TaskIdSchema,
  streak: z.number().int().positive(),
  threshold: z.number().int().positive(),
  lastVerdict: RefereeVerdictEnum,
}));

// ── budget (the incorruptible circuit-breaker) ───────────────────────────────
//    ACCOUNTING RULE (ratified): budget = Σ envelope.budgetDelta over ALL events,
//    with a single main-account per cost so the ledger never double-counts:
//      • a worker turn's cost rides on WorkerTurnFinished.budgetDelta (the causal
//        event for "what this turn actually spent"); do NOT also emit BudgetSpent.
//      • BudgetSpent is ONLY for control-plane/system spend with no natural host
//        event — referee runs, checkpoints, intake NLU. Its cost rides on the
//        BudgetSpent envelope's budgetDelta.
//    BudgetExhausted is the breaker trip; emitted by actor 'system' only.
export const BudgetSpentEventSchema = event('BudgetSpent', z.object({
  reason: z.string(),
}));
export const BudgetExhaustedEventSchema = event('BudgetExhausted', z.object({
  limit: z.number(),
  spent: z.number(),
}));

// ── human intervention (codex constraint #5: land as an event FIRST, then the
//    control-plane reacts; IM callbacks never touch worker memory directly) ───
export const GoalChangeRequestedEventSchema = event('GoalChangeRequested', z.object({
  proposedGoal: z.string().min(1),
}));
export const StopRequestedEventSchema = event('StopRequested', z.object({
  reason: z.string().optional(),
}));
export const InterventionReceiptUpdatedEventSchema = event('InterventionReceiptUpdated', z.object({
  /** eventId of the *Requested event being acknowledged. */
  interventionId: EventIdSchema,
  state: ReceiptStateEnum,
}));

// ── conflict (recorded under P0.0 last-write-wins; real CAS later) ───────────
export const ConflictRaisedEventSchema = event('ConflictRaised', z.object({
  staleBaseRevision: z.number().int().nonnegative(),
  currentRevision: z.number().int().nonnegative(),
  resolution: z.literal('last-write-wins'),
}));

// ── the discriminated union over every event ─────────────────────────────────
export const CollabEventSchema = z.discriminatedUnion('type', [
  RunCreatedEventSchema,
  GoalChangedEventSchema,
  AcceptanceCriteriaChangedEventSchema,
  RunFinishedEventSchema,
  TaskCreatedEventSchema,
  TaskAssignedEventSchema,
  TaskStatusChangedEventSchema,
  WorkerAllocatedEventSchema,
  WorkerTurnStartedEventSchema,
  WorkerTurnFinishedEventSchema,
  WorkerLostEventSchema,
  ArtifactRecordedEventSchema,
  RefereeEvaluatedEventSchema,
  ProgressStallRaisedEventSchema,
  BudgetSpentEventSchema,
  BudgetExhaustedEventSchema,
  GoalChangeRequestedEventSchema,
  StopRequestedEventSchema,
  InterventionReceiptUpdatedEventSchema,
  ConflictRaisedEventSchema,
]);
export type CollabEvent = z.infer<typeof CollabEventSchema>;
export type CollabEventType = CollabEvent['type'];

/**
 * What a caller passes to append(). The append path fills eventId, seq,
 * schemaVersion, timestamp, and baseRevision (snapshotted at append time —
 * callers MAY pass it to assert the revision they reasoned about; if omitted
 * the board uses its current revision).
 */
export type CollabEventDraft =
  Omit<CollabEvent, 'eventId' | 'seq' | 'schemaVersion' | 'timestamp' | 'baseRevision'> & {
    baseRevision?: number;
    timestamp?: number;
  };

// ════════════════════════════════════════════════════════════════════════════
// 4. Board read-model  (materialized by replaying the log; READ-ONLY to all)
// ════════════════════════════════════════════════════════════════════════════

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'stopped';

export interface TaskState {
  taskId: string;
  title: string;
  spec: string;
  status: TaskStatus;
  assignedWorkerId: string | null;
  note?: string;
}

export interface WorkerState {
  workerId: string;
  taskId: string;
  phase: 'allocated' | 'running' | 'suspended' | 'lost';
  leaseExpiresAt?: number;
  /** Worker's own bot identity (pooled only) + route anchor (set whenever the
   *  route is independent of the control topic: pooled identity and/or per-run
   *  worker topic). The control-plane routes interventions here; undefined ⇒
   *  legacy colocated-under-control worker. */
  larkAppId?: string;
  topicId?: string;
}

export interface ArtifactRef {
  artifactId: string;
  kind: 'file' | 'diff' | 'log' | 'note';
  path: string;
  sha256?: string;
  note?: string;
  recordedAtSeq: number;
}

export interface ProgressEntry {
  seq: number;
  timestamp: number;
  verdict: RefereeVerdict;
  /** P2 dual output; absent on entries from pre-P2 events. */
  direction?: ProgressDirection;
  streak?: number;
  metric?: string;
  value?: number;
  prevValue?: number;
  summary?: string;
}

/** Active stall (no-improvement streak hit the threshold). Cleared by the next
 *  improved/done evaluation. */
export interface StallState {
  streak: number;
  threshold: number;
  raisedAtSeq: number;
}

export interface BudgetState {
  limit: number;
  unit: 'tokens' | 'usd' | 'turns';
  spent: number;        // sum of -budgetDelta
  remaining: number;    // limit - spent
  exhausted: boolean;
}

export interface InterventionState {
  interventionId: string;     // the *Requested eventId
  kind: 'goal-change' | 'stop';
  receipt: ReceiptState | null; // null = requested, not yet delivered
  payload: unknown;             // proposedGoal / reason
}

/** The whole materialized read-model. Rendered by the control card & dashboard. */
export interface BoardSnapshot {
  runId: string;
  revision: number;          // = seq of the last applied event
  status: RunStatus;
  goal: string;
  acceptanceCriteria: AcceptanceCriteria | null;
  task: TaskState | null;    // P0.0: exactly one
  worker: WorkerState | null;
  artifacts: ArtifactRef[];
  progressLog: ProgressEntry[];
  /** Set by ProgressStallRaised; cleared by the next improved/done evaluation. */
  stall: StallState | null;
  budget: BudgetState | null;
  interventions: InterventionState[];
  /** Topic where the human steers this run (from RunCreated) — the delivery
   *  anchor for stall notices and other control-plane→human signals. */
  controlTopicId: string | null;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. The typed write API  (what the integration面 imports)
// ════════════════════════════════════════════════════════════════════════════

export type AppendResult = {
  ok: true;
  event: CollabEvent;
  revision: number;
  /** true ⇒ idempotencyKey already seen; `event` is the prior one, no new write. */
  deduped: boolean;
  /** true ⇒ baseRevision was stale; write applied last-write-wins + ConflictRaised logged. */
  conflictLogged: boolean;
};

/**
 * The board. Construction (which runId, where the log lives) is the core's
 * concern; the integration面 only ever holds this interface.
 *
 * RULE: mutate ONLY via append(). read via snapshot()/history(). Never write
 * the read-model. (codex constraint #2.)
 */
export interface CollabBoard {
  readonly runId: string;
  /** Append a typed event. Idempotent on (runId, idempotencyKey). */
  append(draft: CollabEventDraft): Promise<AppendResult>;
  /** Current materialized read-model. */
  snapshot(): Promise<BoardSnapshot>;
  /** Current revision (= seq of last event). Use as the next baseRevision. */
  revision(): Promise<number>;
  /** Full ordered event log — for replay, debug, and the dashboard timeline. */
  history(): Promise<CollabEvent[]>;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. P0.0 acceptance tests this contract must make possible (the reason it exists)
// ════════════════════════════════════════════════════════════════════════════
//
//  ① WORKER KILL/RESUME — kill the worker mid-task at any point → a fresh worker
//     reads snapshot() + history(), resumes, and the run reaches the SAME result.
//     (No state lives in worker memory; everything is on the board.)
//
//  ② DAEMON RESTART/REPLAY — stop the daemon → restart → replay the log →
//     snapshot() is byte-identical to before the restart.
//
//  ③ GOAL CHANGE MID-RUN — human edits goal on the card → GoalChangeRequested
//     event → control-plane applies GoalChanged + pushes worker → worker writes
//     InterventionReceiptUpdated delivered→read→applied, visible on the card.
//
// If a change to this file would break one of these, it's wrong.
