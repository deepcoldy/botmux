/**
 * verified-delivery/ledger.ts — the minimal append-only ledger that backs the
 * trusted delivery spine. Written by the `botmux dispatch` / `botmux report`
 * CLI commands themselves; there is NO resident process. One JSONL file +
 * idempotent appends + a materialized read-model. Inline evidence is spilled to
 * content-addressed blobs so ledger lines stay small (atomic append).
 *
 * This is deliberately tiny — see types.ts for why it is not the collab board.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLockSync } from '../utils/file-lock.js';
import type {
  Evidence,
  LedgerEvent,
  LedgerEventDraft,
  TaskDispatchFailedPayload,
  TaskDispatchIntentPayload,
  TaskDispatchedPayload,
  TaskPlannedPayload,
  TaskAcceptedPayload,
  TaskRejectedPayload,
  TaskReleaseDependency,
  TaskView,
  TaskReportView,
  TaskReportedPayload,
} from './types.js';
import { validateLedgerEventDraft } from './invariants.js';

export interface ClaimReadyPlanInput {
  taskId: string;
  expectedPlanEventId: string;
  expectedAcceptedEventIds: string[];
  ts: number;
  intent: TaskDispatchIntentPayload;
}

export type ClaimReadyPlanResult =
  | { result: 'created'; intent: LedgerEvent }
  | { result: 'open-intent'; intent: LedgerEvent }
  | { result: 'already-dispatched' }
  | { result: 'not-ready' }
  | { result: 'stale' };

export interface ClaimRetryReleaseInput {
  taskId: string;
  expectedReleaseId: string;
  approvedBy: string;
  ts: number;
  intent: TaskDispatchIntentPayload;
}

export type ClaimRetryReleaseResult =
  | { result: 'created'; intent: LedgerEvent }
  | { result: 'open-intent'; intent: LedgerEvent }
  | { result: 'already-dispatched' }
  | { result: 'not-retryable' }
  | { result: 'stale' };

export type AppendCurrentReportVerdictResult =
  | { result: 'appended'; event: LedgerEvent }
  | { result: 'deduped'; event: LedgerEvent }
  | { result: 'stale' };

export interface LedgerHandle {
  /** Append an event; same idempotencyKey twice ⇒ second is a no-op. */
  append(draft: LedgerEventDraft): { event: LedgerEvent; deduped: boolean };
  /** Append a reconcile verdict only while its report is still the current,
   *  pending delivery. This closes verify→append races with re-report/cancel. */
  appendCurrentReportVerdict(draft: LedgerEventDraft): AppendCurrentReportVerdictResult;
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
  /** Atomically claim one ready dependency-gated task. Network I/O happens later. */
  claimReadyPlan(input: ClaimReadyPlanInput): ClaimReadyPlanResult;
  /** Atomically supersede a failed/expired release with attempt+1. */
  claimRetryRelease(input: ClaimRetryReleaseInput): ClaimRetryReleaseResult;
}

export const TASK_RELEASE_AUTO_RETRY_WINDOW_MS = 55 * 60_000;

export function deriveTaskReleaseId(
  planEventId: string,
  acceptedEventIds: string[],
  attempt = 0,
): string {
  const retry = attempt > 0 ? `:retry${attempt}` : '';
  const canonical = `arel1:${planEventId}:${acceptedEventIds.join(':')}${retry}`;
  return `rel1-${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameSatisfiedBy(a: readonly TaskReleaseDependency[], b: readonly TaskReleaseDependency[]): boolean {
  return a.length === b.length && a.every((value, index) =>
    value.taskId === b[index]?.taskId && value.acceptedEventId === b[index]?.acceptedEventId);
}

function sameJson(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

function sameOptionalStrings(actual: string[] | undefined, expected: string[]): boolean {
  return expected.some(Boolean)
    ? !!actual && sameStrings(actual, expected)
    : actual === undefined || actual.every((value) => !value);
}

function intentMatchesCurrentPlan(
  task: TaskView,
  intent: TaskDispatchIntentPayload,
  satisfiedBy: TaskReleaseDependency[],
): boolean {
  const plan = task.plan;
  if (!plan) return false;
  const spec = plan.dispatchSpec;
  const frozen = intent.frozenDispatchedPayload;
  const acceptedEventIds = satisfiedBy.map((dependency) => dependency.acceptedEventId);
  return (
    intent.taskId === task.taskId &&
    intent.planEventId === plan.planEventId &&
    intent.planGeneration === plan.planGeneration &&
    intent.goalChatId === task.chatId &&
    intent.senderLarkAppId === spec.senderLarkAppId &&
    intent.releaseId === deriveTaskReleaseId(plan.planEventId, acceptedEventIds, intent.attempt) &&
    sameSatisfiedBy(intent.satisfiedBy, satisfiedBy) &&
    sameJson(intent.frozenWorkerSpecs, spec.workers) &&
    frozen.taskId === task.taskId &&
    frozen.title === spec.title &&
    frozen.requiredRepo === spec.requiredRepo &&
    frozen.acceptanceHint === spec.acceptanceHint &&
    sameJson(frozen.acceptanceCriteria, spec.acceptanceCriteria) &&
    sameStrings(frozen.workerOpenIds ?? [], spec.workers.map((worker) => worker.openId)) &&
    sameStrings(frozen.workerNames ?? [], spec.workers.map((worker) => worker.name ?? worker.openId)) &&
    sameOptionalStrings(frozen.workerLarkAppIds, spec.workers.map((worker) => worker.larkAppId ?? '')) &&
    sameOptionalStrings(frozen.workerCliIds, spec.workers.map((worker) => worker.cliId ?? '')) &&
    sameOptionalStrings(frozen.workerBotUnionIds, spec.workers.map((worker) => worker.unionId ?? ''))
  );
}

function dispatchedPayloadMatchesIntent(actual: TaskDispatchedPayload, frozen: TaskDispatchedPayload): boolean {
  const { dispatchMessageId: _messageId, confirmedBy: _confirmedBy, ...actualFrozen } = actual;
  return sameJson(actualFrozen, frozen);
}

const replayWarnings = new Set<string>();

function rootDir(baseDir?: string): string {
  return baseDir ?? join(config.session.dataDir, 'verified-delivery');
}

export function openLedger(opts: { baseDir?: string } = {}): LedgerHandle {
  const dir = rootDir(opts.baseDir);
  const ledgerPath = join(dir, 'ledger.ndjson');
  const blobsDir = join(dir, 'blobs');

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

  /** Cross-process serialization for the read-check-append. Uses the shared
   *  PID-aware file lock so a holder that is SIGKILL'd / power-lost (the very
   *  "survive a restart" scenario this ledger targets) does not leave an orphan
   *  lock that wedges every future append forever — a dead holder's lock is
   *  detected and broken. The helper also sleeps (Atomics.wait) between attempts
   *  instead of burning a CPU busy-wait while a peer holds the lock. */
  function withLock<T>(fn: () => T): T {
    ensureDirs();
    // Keep the historical lock pathname (`ledger.lock`) during rolling
    // upgrades. Passing ledgerPath here would create `ledger.ndjson.lock`, so
    // an old CLI and a new CLI could both believe they owned the append lock.
    return withFileLockSync(join(dir, 'ledger'), fn);
  }

  function appendUnlocked(existing: LedgerEvent[], draft: LedgerEventDraft): LedgerEvent {
    const seq = existing.length + 1;
    const event: LedgerEvent = { ...draft, eventId: String(seq), seq };
    // Self-heal a torn prior append: if the file exists but does not end in a
    // newline, a previous writer died mid-line. Appending directly would glue
    // this event onto that fragment, so BOTH lines become one unparseable token
    // that read() silently drops — losing a committed event. Terminate the
    // fragment first so only the already-torn line is skipped, not this one.
    let prefix = '';
    if (existsSync(ledgerPath)) {
      const fd = openSync(ledgerPath, 'r');
      try {
        const size = fstatSync(fd).size;
        if (size > 0) {
          const tail = Buffer.allocUnsafe(1);
          if (readSync(fd, tail, 0, 1, size - 1) !== 1) {
            throw new Error('verified-delivery ledger tail read was incomplete');
          }
          if (tail[0] !== 0x0a) prefix = '\n';
        }
      } finally {
        closeSync(fd);
      }
    }
    // Write the healing newline and the committed event in one append call.
    // If tail inspection fails, fail closed instead of risking another glued
    // line. Reading one byte also keeps append cost O(1) as the ledger grows.
    appendFileSync(ledgerPath, prefix + JSON.stringify(event) + '\n');
    return event;
  }

  function transitionError(existing: LedgerEvent[], draft: LedgerEventDraft): string | undefined {
    const state = materialize(existing);
    const current = state.get(draft.taskId);

    if (draft.type === 'TaskPlanned') {
      const payload = draft.payload as TaskPlannedPayload;
      for (const dependencyId of payload.dependsOnTaskIds) {
        const dependency = state.get(dependencyId);
        if (!dependency) return `TaskPlanned dependency does not exist: ${dependencyId}`;
        if (dependency.chatId !== payload.chatId) {
          return `TaskPlanned dependency belongs to another goal: ${dependencyId}`;
        }
      }
      if (payload.planGeneration === 1) {
        if (current) return 'TaskPlanned generation 1 requires a new taskId';
        return undefined;
      }
      if (!current?.plan || current.status !== 'cancelled') {
        return 'TaskPlanned generation 2+ requires a cancelled planned task';
      }
      if (payload.planGeneration !== current.plan.planGeneration + 1) {
        return `TaskPlanned generation must be ${current.plan.planGeneration + 1}`;
      }
      if (!sameStrings(payload.dependsOnTaskIds, current.plan.dependsOnTaskIds)) {
        return 'TaskPlanned dependencies are immutable across generations';
      }
      if (payload.reopenOfCancelEventId !== current.cancellationEventId) {
        return 'TaskPlanned reopenOfCancelEventId must match the latest cancellation';
      }
      return undefined;
    }

    if (draft.type === 'TaskDispatchIntent') {
      return 'TaskDispatchIntent must be appended through claimReadyPlan';
    }

    if (draft.type === 'TaskDispatchFailed') {
      const payload = draft.payload as TaskDispatchFailedPayload;
      const pending = current?.pendingRelease;
      if (!current || current.status !== 'planned' || !pending) {
        return 'TaskDispatchFailed requires an open planned release';
      }
      if (draft.chatId !== current.chatId) return 'TaskDispatchFailed must use the planned task goal';
      if (
        pending.releaseId !== payload.releaseId ||
        pending.planEventId !== payload.planEventId ||
        pending.planGeneration !== payload.planGeneration ||
        pending.attempt !== payload.attempt
      ) {
        return 'TaskDispatchFailed must match the current open release';
      }
      if (pending.failure?.failureClass === 'definite' && payload.failureClass !== 'definite') {
        return 'a definite release failure cannot be downgraded to ambiguous';
      }
      return undefined;
    }

    if (draft.type === 'TaskDispatched' && current?.plan) {
      const payload = draft.payload as TaskDispatchedPayload;
      if (current.status !== 'planned' || !current.pendingRelease) {
        return 'a planned task can only dispatch from its current open release';
      }
      if (draft.chatId !== current.chatId) return 'TaskDispatched must use the planned task goal';
      if (!payload.releaseId || payload.releaseId !== current.pendingRelease.releaseId) {
        return 'TaskDispatched.releaseId must match the current open release';
      }
      if (!dispatchedPayloadMatchesIntent(payload, current.pendingRelease.frozenDispatchedPayload)) {
        return 'TaskDispatched payload must match the frozen release intent';
      }
      return undefined;
    }

    if (
      current?.status === 'planned' &&
      (draft.type === 'TaskReported' ||
        draft.type === 'TaskAccepted' ||
        draft.type === 'TaskRejected' ||
        draft.type === 'TaskHelpRequested' ||
        draft.type === 'TaskEscalated')
    ) {
      return `${draft.type} cannot advance a task that has not been dispatched`;
    }

    if (draft.type === 'TaskCancelled') {
      if (!current) return 'TaskCancelled requires an existing task';
      if (current.status === 'accepted') return 'accepted task cannot be cancelled';
    }
    return undefined;
  }

  function canonicalizeDraft(draft: LedgerEventDraft): LedgerEventDraft {
    if (draft.type !== 'TaskReported') return draft;
    const reportId = (draft.payload as TaskReportedPayload).reportId;
    // Old clients used a ledger-global `reported:<reportId>` key. Normalize
    // that exact legacy form at the storage boundary so a rolling-upgrade peer
    // cannot let one task's chosen reportId suppress another task's delivery.
    if (draft.idempotencyKey !== `reported:${reportId}`) return draft;
    return { ...draft, idempotencyKey: `reported:${draft.taskId}:${reportId}` };
  }

  function findDuplicate(existing: LedgerEvent[], draft: LedgerEventDraft): LedgerEvent | undefined {
    if (draft.type === 'TaskReported') {
      const reportId = (draft.payload as TaskReportedPayload).reportId;
      const sameReport = existing.find((event) =>
        event.type === 'TaskReported'
        && event.taskId === draft.taskId
        && (event.payload as TaskReportedPayload).reportId === reportId);
      if (sameReport) return sameReport;
    }
    const duplicate = existing.find((event) => event.idempotencyKey === draft.idempotencyKey);
    if (duplicate && (duplicate.type !== draft.type || duplicate.taskId !== draft.taskId)) {
      throw new Error(
        `verified-delivery ledger idempotency collision: ${draft.idempotencyKey} already belongs to ${duplicate.type}/${duplicate.taskId}`,
      );
    }
    return duplicate;
  }

  function append(draft: LedgerEventDraft): { event: LedgerEvent; deduped: boolean } {
    const canonicalDraft = canonicalizeDraft(draft);
    const invariant = validateLedgerEventDraft(canonicalDraft);
    if (invariant.errors.length > 0) {
      throw new Error(`verified-delivery ledger invariant violation: ${invariant.errors.join('; ')}`);
    }
    return withLock(() => {
      const existing = read();
      const dup = findDuplicate(existing, canonicalDraft);
      if (dup) return { event: dup, deduped: true };
      const stateError = transitionError(existing, canonicalDraft);
      if (stateError) {
        throw new Error(`verified-delivery ledger invariant violation: ${stateError}`);
      }
      const event = appendUnlocked(existing, canonicalDraft);
      return { event, deduped: false };
    });
  }

  function appendCurrentReportVerdict(draft: LedgerEventDraft): AppendCurrentReportVerdictResult {
    if (draft.type !== 'TaskAccepted' && draft.type !== 'TaskRejected') {
      throw new Error('appendCurrentReportVerdict only accepts TaskAccepted/TaskRejected');
    }
    const invariant = validateLedgerEventDraft(draft);
    if (invariant.errors.length > 0) {
      throw new Error(`verified-delivery ledger invariant violation: ${invariant.errors.join('; ')}`);
    }
    return withLock(() => {
      const existing = read();
      const current = materialize(existing).get(draft.taskId);
      const reportId = (draft.payload as TaskAcceptedPayload | TaskRejectedPayload).reportId;
      const report = current?.reports.find((candidate) => candidate.reportId === reportId);
      const dup = findDuplicate(existing, draft);
      if (dup) {
        const expectedVerdict = draft.type === 'TaskAccepted' ? 'accepted' : 'rejected';
        // A concurrent identical verdict is idempotent only while it still
        // describes the latest delivery. If a new report/help/cancel arrived
        // after that verdict, returning the old event as a successful dedupe
        // would resurrect stale narration/release side effects.
        if (
          current?.status !== expectedVerdict
          || current.latestReportId !== reportId
          || report?.verdict !== expectedVerdict
        ) {
          return { result: 'stale' };
        }
        return { result: 'deduped', event: dup };
      }
      if (current?.status !== 'reported' || current.latestReportId !== reportId || !report || report.verdict) {
        return { result: 'stale' };
      }
      const stateError = transitionError(existing, draft);
      if (stateError) {
        throw new Error(`verified-delivery ledger invariant violation: ${stateError}`);
      }
      return { result: 'appended', event: appendUnlocked(existing, draft) };
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
    const warnReplay = (event: LedgerEvent, reason: string): void => {
      const key = `${ledgerPath}:${event.eventId}:${event.type}:${reason}`;
      if (replayWarnings.has(key)) return;
      if (replayWarnings.size >= 2_000) replayWarnings.clear();
      replayWarnings.add(key);
      logger.warn(`[verified-delivery] ignored invalid historical ${event.type} task=${event.taskId}: ${reason}`);
    };

    for (const e of events) {
      if (
        e.type === 'TaskPlanned' ||
        e.type === 'TaskDispatchIntent' ||
        e.type === 'TaskDispatchFailed' ||
        (e.type === 'TaskDispatched' && (e.payload as TaskDispatchedPayload).releaseId !== undefined)
      ) {
        const invariant = validateLedgerEventDraft(e);
        if (invariant.errors.length > 0) {
          warnReplay(e, invariant.errors.join('; '));
          continue;
        }
      }
      if (e.type === 'TaskPlanned') {
        const p = e.payload as TaskPlannedPayload;
        const existingTask = byTask.get(e.taskId);
        const dependenciesValid = p.dependsOnTaskIds.every((dependencyId) => {
          const dependency = byTask.get(dependencyId);
          return !!dependency && dependency.chatId === p.chatId;
        });
        if (!dependenciesValid) {
          warnReplay(e, 'dependency missing or belongs to another goal');
          continue;
        }
        if (p.planGeneration === 1) {
          if (existingTask) {
            warnReplay(e, 'generation 1 requires a new taskId');
            continue;
          }
        } else if (
          !existingTask?.plan ||
          existingTask.status !== 'cancelled' ||
          p.planGeneration !== existingTask.plan.planGeneration + 1 ||
          !sameStrings(p.dependsOnTaskIds, existingTask.plan.dependsOnTaskIds) ||
          p.reopenOfCancelEventId !== existingTask.cancellationEventId
        ) {
          warnReplay(e, 'invalid plan generation or changed dependency edges');
          continue;
        }
        const t: TaskView = existingTask ?? { taskId: e.taskId, chatId: p.chatId, status: 'planned', reports: [] };
        if (!existingTask) byTask.set(e.taskId, t);
        t.chatId = p.chatId;
        t.title = p.title;
        t.workerOpenIds = p.dispatchSpec.workers.map((worker) => worker.openId);
        t.workerNames = p.dispatchSpec.workers.map((worker) => worker.name ?? worker.openId);
        if (p.dispatchSpec.workers.some((worker) => worker.larkAppId)) {
          t.workerLarkAppIds = p.dispatchSpec.workers.map((worker) => worker.larkAppId ?? '');
        }
        if (p.dispatchSpec.workers.some((worker) => worker.cliId)) {
          t.workerCliIds = p.dispatchSpec.workers.map((worker) => worker.cliId ?? '');
        }
        if (p.dispatchSpec.workers.some((worker) => worker.unionId)) {
          t.workerBotUnionIds = p.dispatchSpec.workers.map((worker) => worker.unionId ?? '');
        }
        t.requiredRepo = p.dispatchSpec.requiredRepo;
        t.acceptanceHint = p.dispatchSpec.acceptanceHint;
        t.acceptanceCriteria = p.dispatchSpec.acceptanceCriteria;
        t.plan = {
          planEventId: e.eventId,
          planGeneration: p.planGeneration,
          dependsOnTaskIds: [...p.dependsOnTaskIds],
          dispatchSpec: p.dispatchSpec,
          plannedBy: p.plannedBy,
        };
        t.activationEventId = e.eventId;
        t.status = 'planned';
        t.pendingRelease = undefined;
        t.latestReleaseId = undefined;
        t.dispatchMessageId = undefined;
        t.dispatchConfirmedBy = undefined;
        t.latestReportId = undefined;
        t.cancellation = undefined;
        t.cancellationEventId = undefined;
      } else if (e.type === 'TaskDispatchIntent') {
        const p = e.payload as TaskDispatchIntentPayload;
        const t = byTask.get(e.taskId);
        if (!t?.plan || t.status !== 'planned' || p.planEventId !== t.plan.planEventId || p.planGeneration !== t.plan.planGeneration) {
          warnReplay(e, 'intent does not match the current planned generation');
          continue;
        }
        const currentSatisfiedBy: TaskReleaseDependency[] = [];
        let ready = true;
        for (const dependencyId of t.plan.dependsOnTaskIds) {
          const dependency = byTask.get(dependencyId);
          if (dependency?.status !== 'accepted' || !dependency.acceptedEventId) {
            ready = false;
            break;
          }
          currentSatisfiedBy.push({ taskId: dependencyId, acceptedEventId: dependency.acceptedEventId });
        }
        if (!ready || !intentMatchesCurrentPlan(t, p, currentSatisfiedBy)) {
          warnReplay(e, 'intent frozen payload, dependency snapshot, or releaseId is stale');
          continue;
        }
        if (t.pendingRelease && p.attempt <= t.pendingRelease.attempt) {
          warnReplay(e, 'intent does not advance the current release attempt');
          continue;
        }
        t.pendingRelease = {
          intentEventId: e.eventId,
          intentAt: e.ts,
          releaseId: p.releaseId,
          attempt: p.attempt,
          planEventId: p.planEventId,
          planGeneration: p.planGeneration,
          satisfiedBy: p.satisfiedBy,
          senderLarkAppId: p.senderLarkAppId,
          goalChatId: p.goalChatId,
          frozenKickoffText: p.frozenKickoffText,
          frozenWorkerSpecs: p.frozenWorkerSpecs,
          frozenDispatchedPayload: p.frozenDispatchedPayload,
          releasedBy: p.releasedBy,
        };
      } else if (e.type === 'TaskDispatchFailed') {
        const p = e.payload as TaskDispatchFailedPayload;
        const t = byTask.get(e.taskId);
        const pending = t?.pendingRelease;
        if (
          t?.status !== 'planned' ||
          !pending ||
          pending.releaseId !== p.releaseId ||
          pending.planEventId !== p.planEventId ||
          pending.planGeneration !== p.planGeneration ||
          pending.attempt !== p.attempt ||
          (pending.failure?.failureClass === 'definite' && p.failureClass !== 'definite')
        ) {
          warnReplay(e, 'failure does not match the current open release');
          continue;
        }
        pending.failure = {
          eventId: e.eventId,
          ts: e.ts,
          failureClass: p.failureClass,
          code: p.code,
          detail: p.detail,
          failedBy: p.failedBy,
        };
      } else if (e.type === 'TaskDispatched') {
        const p = e.payload as TaskDispatchedPayload;
        const existingTask = byTask.get(e.taskId);
        if (existingTask?.plan && (
          existingTask.status !== 'planned' ||
          !existingTask.pendingRelease ||
          !p.releaseId ||
          p.releaseId !== existingTask.pendingRelease.releaseId ||
          !dispatchedPayloadMatchesIntent(p, existingTask.pendingRelease.frozenDispatchedPayload)
        )) {
          warnReplay(e, 'planned dispatch does not match the current open release');
          continue;
        }
        const t = existingTask ?? ensure(e.taskId, e.chatId);
        t.chatId = e.chatId ?? t.chatId;
        t.title = p.title ?? t.title;
        t.workerTopicRoot = p.workerTopicRoot ?? t.workerTopicRoot;
        t.workerOpenIds = p.workerOpenIds ?? t.workerOpenIds;
        t.workerNames = p.workerNames ?? t.workerNames;
        t.workerLarkAppIds = p.workerLarkAppIds ?? t.workerLarkAppIds;
        t.workerCliIds = p.workerCliIds ?? t.workerCliIds;
        t.workerBotUnionIds = p.workerBotUnionIds ?? t.workerBotUnionIds;
        t.requiredRepo = p.requiredRepo ?? t.requiredRepo;
        t.acceptanceHint = p.acceptanceHint ?? t.acceptanceHint;
        t.acceptanceCriteria = p.acceptanceCriteria ?? t.acceptanceCriteria;
        t.latestReleaseId = p.releaseId ?? t.latestReleaseId;
        t.dispatchMessageId = p.dispatchMessageId ?? t.dispatchMessageId;
        t.dispatchConfirmedBy = p.confirmedBy ?? t.dispatchConfirmedBy;
        if (t.plan) {
          t.pendingRelease = undefined;
          t.status = 'dispatched';
        } else {
          t.activationEventId = e.eventId;
        }
        // A (re)dispatch re-activates a fresh OR a help-blocked/escalated/
        // cancelled task —
        // it's the supervisor's "go again" after addressing the blocker. It must
        // NOT clobber a reported/accepted/rejected task (late metadata dispatch).
        if (!t.plan && (t.reports.length === 0 || t.status === 'blocked' || t.status === 'escalated' || t.status === 'cancelled')) {
          if (t.status === 'cancelled') {
            t.cancellation = undefined;
            t.cancellationEventId = undefined;
            t.latestReportId = undefined;
          }
          t.status = 'dispatched';
        }
      } else if (e.type === 'TaskReported') {
        const p = e.payload as import('./types.js').TaskReportedPayload;
        if (byTask.get(e.taskId)?.status === 'planned') {
          warnReplay(e, 'task has not been dispatched');
          continue;
        }
        const t = ensure(e.taskId, e.chatId);
        const terminal = t.status === 'accepted' || t.status === 'cancelled';
        if (!findReport(t, p.reportId)) {
          t.reports.push({ reportId: p.reportId, workerOpenId: p.workerOpenId, evidence: p.evidence, summary: p.summary });
        }
        // Accepted/cancelled are terminal. A delayed retry may carry a different reportId
        // (for example after a network timeout), but it must not reopen a task
        // that the supervisor has already verified. Keep the event for audit;
        // rejected/blocked/escalated tasks can still recover via a new report.
        if (!terminal) {
          t.latestReportId = p.reportId;
          t.status = 'reported';
        }
      } else if (e.type === 'TaskAccepted') {
        const p = e.payload as import('./types.js').TaskAcceptedPayload;
        if (byTask.get(e.taskId)?.status === 'planned') {
          warnReplay(e, 'task has not been dispatched');
          continue;
        }
        const t = ensure(e.taskId, e.chatId);
        const r = findReport(t, p.reportId);
        if (r) { r.verdict = 'accepted'; r.checkedBy = p.checkedBy; r.evidenceChecked = p.evidenceChecked; r.ranCommands = p.ranCommands; r.verdictVia = p.via ?? r.verdictVia; }
        // Only the verdict on the CURRENT attempt moves the task. A late verdict
        // for a superseded report still records on that report, but must not drag
        // a fresh attempt back to a terminal state.
        if (t.status !== 'accepted' && t.status !== 'cancelled' && p.reportId === t.latestReportId) {
          t.status = 'accepted';
          t.acceptedEventId = e.eventId;
        }
      } else if (e.type === 'TaskRejected') {
        const p = e.payload as import('./types.js').TaskRejectedPayload;
        if (byTask.get(e.taskId)?.status === 'planned') {
          warnReplay(e, 'task has not been dispatched');
          continue;
        }
        const t = ensure(e.taskId, e.chatId);
        const r = findReport(t, p.reportId);
        // A late reject cannot rewrite the report that already made the task
        // accepted. It may still annotate an older, superseded report.
        if (r && r.verdict !== 'accepted') {
          r.verdict = 'rejected';
          r.reason = p.reason;
          r.checkedBy = p.checkedBy;
          r.verdictVia = p.via ?? r.verdictVia;
        }
        if (t.status !== 'accepted' && t.status !== 'cancelled' && p.reportId === t.latestReportId) t.status = 'rejected';
      } else if (e.type === 'TaskHelpRequested') {
        const p = e.payload as import('./types.js').TaskHelpRequestedPayload;
        if (byTask.get(e.taskId)?.status === 'planned') {
          warnReplay(e, 'task has not been dispatched');
          continue;
        }
        const t = ensure(e.taskId, e.chatId);
        t.help = { blocker: p.blocker, kind: p.kind, workerOpenId: p.workerOpenId };
        // A help request parks the task as 'blocked' awaiting the supervisor — but
        // never overrides a terminal verdict (a late help after accept is noise).
        if (t.status !== 'accepted' && t.status !== 'rejected' && t.status !== 'cancelled') t.status = 'blocked';
      } else if (e.type === 'TaskEscalated') {
        const p = e.payload as import('./types.js').TaskEscalatedPayload;
        if (byTask.get(e.taskId)?.status === 'planned') {
          warnReplay(e, 'task has not been dispatched');
          continue;
        }
        const t = ensure(e.taskId, e.chatId);
        t.escalation = { reason: p.reason, by: p.by, retryBrief: p.retryBrief };
        if (t.status !== 'accepted' && t.status !== 'rejected' && t.status !== 'cancelled') t.status = 'escalated';
      } else if (e.type === 'TaskCancelled') {
        const p = e.payload as import('./types.js').TaskCancelledPayload;
        // Defensive replay posture: an illegal historical cancel after accept is
        // visible in the raw ledger but cannot create a phantom task or rewrite
        // the accepted read-model.
        const t = byTask.get(e.taskId);
        if (!t || t.status === 'accepted') {
          warnReplay(e, !t ? 'task does not exist' : 'accepted task cannot be cancelled');
          continue;
        }
        t.cancellation = { reason: p.reason, by: p.by };
        t.cancellationEventId = e.eventId;
        t.pendingRelease = undefined;
        t.status = 'cancelled';
      }
    }
    return byTask;
  }

  function claimReadyPlan(input: ClaimReadyPlanInput): ClaimReadyPlanResult {
    const draft: LedgerEventDraft = {
      type: 'TaskDispatchIntent',
      actor: 'orchestrator',
      taskId: input.taskId,
      chatId: input.intent.goalChatId,
      idempotencyKey: `intent:${input.intent.releaseId}`,
      ts: input.ts,
      payload: input.intent,
    };
    const invariant = validateLedgerEventDraft(draft);
    if (invariant.errors.length > 0) {
      throw new Error(`verified-delivery ledger invariant violation: ${invariant.errors.join('; ')}`);
    }

    return withLock(() => {
      const existing = read();
      const state = materialize(existing);
      const current = state.get(input.taskId);
      if (!current) return { result: 'not-ready' };
      if (current.status !== 'planned') {
        return current.plan && current.status !== 'cancelled'
          ? { result: 'already-dispatched' }
          : { result: 'not-ready' };
      }
      if (!current.plan) return { result: 'not-ready' };
      if (current.pendingRelease) {
        const event = existing.find((candidate) => candidate.eventId === current.pendingRelease?.intentEventId);
        if (!event) throw new Error('verified-delivery ledger invariant violation: open intent event is missing');
        return { result: 'open-intent', intent: event };
      }

      const currentSatisfiedBy: TaskReleaseDependency[] = [];
      for (const dependencyId of current.plan.dependsOnTaskIds) {
        const dependency = state.get(dependencyId);
        if (dependency?.status !== 'accepted' || !dependency.acceptedEventId) {
          return { result: 'not-ready' };
        }
        currentSatisfiedBy.push({ taskId: dependencyId, acceptedEventId: dependency.acceptedEventId });
      }
      const currentAcceptedEventIds = currentSatisfiedBy.map((dependency) => dependency.acceptedEventId);
      if (
        input.expectedPlanEventId !== current.plan.planEventId ||
        !sameStrings(input.expectedAcceptedEventIds, currentAcceptedEventIds)
      ) {
        return { result: 'stale' };
      }

      const intent = input.intent;
      if (
        intent.attempt !== 0 ||
        !intentMatchesCurrentPlan(current, intent, currentSatisfiedBy)
      ) {
        return { result: 'stale' };
      }

      const duplicate = existing.find((event) => event.idempotencyKey === draft.idempotencyKey);
      if (duplicate) return { result: 'open-intent', intent: duplicate };
      const event = appendUnlocked(existing, draft);
      return { result: 'created', intent: event };
    });
  }

  function claimRetryRelease(input: ClaimRetryReleaseInput): ClaimRetryReleaseResult {
    const draft: LedgerEventDraft = {
      type: 'TaskDispatchIntent',
      actor: 'orchestrator',
      taskId: input.taskId,
      chatId: input.intent.goalChatId,
      idempotencyKey: `intent:${input.intent.releaseId}`,
      ts: input.ts,
      payload: input.intent,
    };
    const invariant = validateLedgerEventDraft(draft);
    if (invariant.errors.length > 0) {
      throw new Error(`verified-delivery ledger invariant violation: ${invariant.errors.join('; ')}`);
    }

    return withLock(() => {
      const existing = read();
      const state = materialize(existing);
      const current = state.get(input.taskId);
      if (!current) return { result: 'not-retryable' };
      if (current.status !== 'planned') {
        return current.plan && current.status !== 'cancelled'
          ? { result: 'already-dispatched' }
          : { result: 'not-retryable' };
      }
      const pending = current.pendingRelease;
      if (!current.plan || !pending) return { result: 'not-retryable' };
      if (pending.releaseId !== input.expectedReleaseId) return { result: 'stale' };
      const approvedBy = input.approvedBy.trim();
      if (!approvedBy || input.intent.releasedBy !== approvedBy) return { result: 'not-retryable' };
      if (
        pending.failure?.failureClass !== 'definite' &&
        input.ts - pending.intentAt < TASK_RELEASE_AUTO_RETRY_WINDOW_MS
      ) {
        return { result: 'not-retryable' };
      }

      const satisfiedBy: TaskReleaseDependency[] = [];
      for (const dependencyId of current.plan.dependsOnTaskIds) {
        const dependency = state.get(dependencyId);
        if (dependency?.status !== 'accepted' || !dependency.acceptedEventId) {
          return { result: 'not-retryable' };
        }
        satisfiedBy.push({ taskId: dependencyId, acceptedEventId: dependency.acceptedEventId });
      }
      const intent = input.intent;
      const acceptedEventIds = satisfiedBy.map((dependency) => dependency.acceptedEventId);
      if (
        intent.attempt !== pending.attempt + 1 ||
        intent.releaseId !== deriveTaskReleaseId(current.plan.planEventId, acceptedEventIds, intent.attempt) ||
        intent.planEventId !== current.plan.planEventId ||
        !intentMatchesCurrentPlan(current, intent, satisfiedBy)
      ) {
        return { result: 'stale' };
      }

      const duplicate = existing.find((event) => event.idempotencyKey === draft.idempotencyKey);
      if (duplicate) return { result: 'open-intent', intent: duplicate };
      const event = appendUnlocked(existing, draft);
      return { result: 'created', intent: event };
    });
  }

  function inlineBlobRef(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  function installInlineBlob(blobPath: string, content: string): void {
    const tmpPath = `${blobPath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, content);
    try {
      renameSync(tmpPath, blobPath);
    } catch (err) {
      // On platforms where rename cannot replace a destination that won the
      // race, identical content means the operation already succeeded.
      try { unlinkSync(tmpPath); } catch { /* already moved / cleanup best effort */ }
      if (existsSync(blobPath) && readFileSync(blobPath, 'utf-8') === content) return;
      throw err;
    }
  }

  function writeInlineEvidence(content: string, name?: string): Extract<Evidence, { kind: 'inline' }> {
    ensureDirs();
    const bytes = Buffer.byteLength(content, 'utf-8');
    const ref = inlineBlobRef(content);
    const blobPath = join(blobsDir, ref);
    // Write atomically (temp + rename) so a crash mid-write cannot leave a
    // truncated blob that existsSync() later treats as complete — the content
    // is addressed by hash, so a short blob would be silently trusted forever.
    if (!existsSync(blobPath)) {
      installInlineBlob(blobPath, content);
    } else {
      const existing = readFileSync(blobPath, 'utf-8');
      if (existing !== content) {
        if (inlineBlobRef(existing) === ref) {
          throw new Error(`inline evidence blob hash collision: ${ref}`);
        }
        // Repair a truncated blob left by the pre-atomic writer. A mismatching
        // hash proves the existing bytes cannot be the content addressed by ref.
        installInlineBlob(blobPath, content);
      }
    }
    const preview = content.length > 200 ? content.slice(0, 200) + '…' : content;
    return { kind: 'inline', ref, name, bytes, preview };
  }

  function readInlineEvidence(ref: string): string {
    const blobPath = join(blobsDir, ref);
    if (!existsSync(blobPath)) throw new Error(`inline evidence blob not found: ${ref}`);
    const content = readFileSync(blobPath, 'utf-8');
    if (inlineBlobRef(content) !== ref) {
      throw new Error(`inline evidence blob is corrupt: ${ref}`);
    }
    return content;
  }

  return {
    append,
    appendCurrentReportVerdict,
    read,
    task: (taskId) => materialize(read()).get(taskId),
    tasks: (chatId) => {
      const all = [...materialize(read()).values()];
      return chatId ? all.filter((t) => t.chatId === chatId) : all;
    },
    writeInlineEvidence,
    readInlineEvidence,
    claimReadyPlan,
    claimRetryRelease,
  };
}
