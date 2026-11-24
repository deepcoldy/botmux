import { randomUUID } from 'node:crypto';
import type { Session } from '../types.js';
import type { GroupSessionSupervisorConfig } from './group-session-supervisor-config.js';
import { supervisionCriteria, type SupervisionAssessment, type SupervisionDecision, type SupervisionReviewStage } from './group-session-supervision-assessment.js';
import type { SessionLastTurn } from './session-task-status.js';

export const MAX_SUPERVISION_REWORK = 2;
export const MAX_SUPERVISION_CRITERIA_CHARS = 1_600;
export const SUPERVISION_POLL_MS = 30_000;
const EXTERNAL_WAIT_MS = 5 * 60_000;
const REVIEW_RETRY_MS = 2 * 60_000;
const MISSING_REPLY_GRACE_MS = 2 * 60_000;
const UNCONFIRMED_TURN_MS = 10 * 60_000;

export type SupervisionReason = 'no_output' | 'review_unavailable' | 'needs_user' | 'round_limit'
  | 'session_changed' | 'dispatch_failed' | 'stalled' | 'stopped' | 'interrupted';

export interface GroupSessionSupervision {
  id: string;
  requester: string;
  requesterUnionId?: string;
  reviewer: GroupSessionSupervisorConfig;
  chatId: string;
  anchor: string;
  task: string;
  criteria: string;
  turnId: string;
  /** Original human turn for notices, even after an unattended continuation. */
  originTurnId?: string;
  round: number;
  state: 'watching' | 'pending_review' | 'waiting' | 'accepted' | 'needs_user';
  reason?: SupervisionReason;
  observedAt?: number;
  checkAt?: number;
  reviewAttempt?: number;
  reviewEvidence?: string;
  reviewEpoch?: number;
  waitChecks?: number;
  notifiedKey?: string;
  dispatches?: number;
  probes?: number;
  park?: { reason: string; evidence: string };
  decision?: SupervisionDecision;
  ownerDecision?: { question: string; choice: string; at: number };
  lastDecision?: { question: string; choice: string; at: number };
  assessments?: { turnId: string; at: number; stage: SupervisionReviewStage; result: SupervisionAssessment }[];
}

export interface SupervisionObservation {
  now: number;
  lastActivityAt?: number;
  outcome?: SessionLastTurn;
  /** Known live progress, human-input gates, and a separate host-side stall signal. */
  running?: boolean;
  stalled?: boolean;
  blocked?: boolean;
}

export interface GroupSessionSupervisionIo {
  allowed(task: GroupSessionSupervision): boolean;
  current(turnId: string): boolean;
  finalText(turnId: string): string | undefined;
  review(task: GroupSessionSupervision, answer: string, signal: AbortSignal, stage: SupervisionReviewStage): Promise<SupervisionAssessment | undefined>;
  serializeAdmission(action: () => void): Promise<void>;
  persist(): void;
  canDispatch(): boolean;
  stillMissingOutput(turnId: string, observed: SessionLastTurn | undefined): boolean;
  wake(): void;
  dispatch(turnId: string, sourceTurnId: string, prompt: string): boolean;
}

const reviews = new WeakMap<Session, AbortController>();

export function groupSupervisionTracking(task?: GroupSessionSupervision): task is GroupSessionSupervision {
  return task?.state === 'watching' || task?.state === 'waiting' || task?.state === 'pending_review';
}

export function replaceGroupSessionSupervision(
  session: Session, task: GroupSessionSupervision | undefined, persist: () => void,
): void {
  const previous = session.groupSessionSupervision;
  if (task) session.groupSessionSupervision = task;
  else delete session.groupSessionSupervision;
  try { persist(); } catch (error) {
    if (previous) session.groupSessionSupervision = previous;
    else delete session.groupSessionSupervision;
    throw error;
  }
  reviews.get(session)?.abort();
  reviews.delete(session);
}

export function newGroupSessionSupervision(
  input: Pick<GroupSessionSupervision, 'requester' | 'requesterUnionId' | 'reviewer' | 'chatId' | 'anchor' | 'task' | 'criteria' | 'turnId'>,
  now = Date.now(),
): GroupSessionSupervision {
  return { ...input, id: randomUUID(), originTurnId: input.turnId, round: 0, state: 'watching', observedAt: now };
}

export function stopGroupSessionSupervision(session: Session, persist: () => void): void {
  const task = session.groupSessionSupervision;
  if (!groupSupervisionTracking(task)) return;
  // Stop takes effect for the running daemon even when persistence is unavailable.
  reviews.get(session)?.abort();
  const stopped = { ...task, state: 'needs_user', reason: 'stopped' } as const;
  try { replaceGroupSessionSupervision(session, stopped, persist); } catch (error) {
    session.groupSessionSupervision = stopped;
    throw error;
  }
}

export function resumeGroupSessionSupervision(task: GroupSessionSupervision, turnId: string, now: number): GroupSessionSupervision {
  return {
    ...task, turnId, state: 'watching', reason: undefined, observedAt: now, checkAt: undefined,
    reviewEpoch: (task.reviewEpoch ?? 0) + 1, reviewAttempt: 0, round: 0, waitChecks: 0, notifiedKey: undefined,
    reviewEvidence: undefined, park: undefined, decision: undefined, ownerDecision: undefined, probes: 0,
  };
}

export function supervisionDecisionRef(task: GroupSessionSupervision): string {
  return `${task.id.slice(0, 8)}-${task.reviewEpoch ?? 0}-${task.dispatches ?? 0}`;
}

export function chooseGroupSupervisionDecision(
  task: GroupSessionSupervision, ref: string, option: number, now: number,
): GroupSessionSupervision | undefined {
  if (task.state !== 'needs_user' || task.reason !== 'needs_user' || ref !== supervisionDecisionRef(task)) return undefined;
  const decision = task.decision;
  const choice = Number.isInteger(option) && option > 0 ? decision?.options[option - 1] : undefined;
  if (!decision || !choice) return undefined;
  const selected = { question: decision.question, choice, at: now };
  return {
    ...task, state: 'waiting', checkAt: now, reason: undefined, decision: undefined,
    ownerDecision: selected, lastDecision: selected, notifiedKey: undefined, reviewAttempt: 0,
  };
}

export function groupSupervisionNotice(task: GroupSessionSupervision): 'accepted' | SupervisionReason | undefined {
  if (task.state === 'accepted') return 'accepted';
  if (task.state === 'needs_user' && task.reason !== 'stopped') return task.reason;
  if ((task.state === 'watching' || task.state === 'pending_review') && (task.reason === 'stalled'
    || (task.reason === 'review_unavailable' && (task.reviewAttempt ?? 0) >= 3))) return task.reason;
  return undefined;
}

/** Replay the same observation after daemon restart. Only committed rework
 * identity can advance the watched turn. Only the requester can send a decision. */
export async function observeGroupSessionSupervision(
  session: Session, observation: SupervisionObservation, io: GroupSessionSupervisionIo,
): Promise<void> {
  const initial = session.groupSessionSupervision;
  if (!groupSupervisionTracking(initial) || reviews.has(session) || !io.allowed(initial)) return;
  const { now, outcome } = observation;
  if (outcome && initial.turnId !== outcome.turnId) return;

  let task: GroupSessionSupervision = initial;
  const save = (patch: Partial<GroupSessionSupervision>) => replaceGroupSessionSupervision(session, { ...task, ...patch }, io.persist);
  const end = (reason: SupervisionReason) => save({ state: 'needs_user', reason });
  const continueTask = (
    action: 'rework' | 'check' | 'probe' | 'decision',
    assessments = task.assessments,
    missing?: number[],
  ) => {
    const round = task.round + (action === 'rework' ? 1 : 0);
    const waitChecks = (task.waitChecks ?? 0) + (action === 'check' ? 1 : 0);
    const dispatches = (task.dispatches ?? 0) + 1;
    const turnId = `supervision:${task.id}:${task.reviewEpoch ?? 0}:${action}:${dispatches}`;
    const instructions = {
      check: 'Recheck the external dependency you reported. If it is still pending, report what you checked and continue waiting.',
      probe: 'The execution turn stopped without evidence. Check the current work. Continue if there is a safe, authorized next step. Otherwise report the specific blocker and what can resolve it.',
      rework: 'Address the listed unmet acceptance criteria. Report evidence for the entire task when ready.',
      decision: 'The requester selected an option in the original group. Apply the selected decision to the original task.',
    };
    const criteria = supervisionCriteria(task.criteria);
    const prompt = [
      `[Botmux task supervision] ${instructions[action]}`,
      'Continue only within the original authorized scope. Check the acceptance criteria, finish what is missing where possible, and report concrete verification here. If you need human input or approval, stop and say what you need.',
      JSON.stringify({
        original_task: task.task, acceptance_criteria: criteria,
        unmet_criteria: missing?.map(index => criteria[index - 1]),
        external_dependency_evidence: action === 'check' ? task.park?.evidence : undefined,
        requester_decision: action === 'decision' ? task.ownerDecision : undefined,
      }),
    ].join('\n\n');
    // Persist before delivery. A crash between persistence and dispatch must never replay the input.
    const next: GroupSessionSupervision = {
      ...task, turnId, round, waitChecks, dispatches, state: 'watching', observedAt: now, reason: undefined,
      probes: (task.probes ?? 0) + (action === 'probe' ? 1 : 0), assessments,
      checkAt: undefined, reviewAttempt: 0, reviewEvidence: undefined, notifiedKey: undefined,
      ownerDecision: undefined, decision: undefined, park: undefined,
    };
    replaceGroupSessionSupervision(session, next, io.persist);
    if (!io.dispatch(turnId, task.turnId, prompt)) {
      replaceGroupSessionSupervision(session, { ...next, state: 'needs_user', reason: 'dispatch_failed' }, io.persist);
    }
  };

  const review = new AbortController();
  reviews.set(session, review);
  // SQLite can reload the same task as a new object. Intentional replacements
  // also abort this observation, even when they retain the turn identity.
  const currentTask = () => {
    const current = session.groupSessionSupervision;
    if (!review.signal.aborted && current?.id === initial.id && current.turnId === initial.turnId
      && current.reviewEpoch === initial.reviewEpoch && current.state === initial.state && io.allowed(current)) {
      return current;
    }
    return undefined;
  };
  try {
    const commit = (action: () => void) => io.serializeAdmission(() => {
      const current = currentTask();
      if (!current) return;
      task = current;
      if (!io.current(task.turnId)) {
        end('session_changed');
        return;
      }
      action();
    });
    if (!io.current(task.turnId)) { await commit(() => {}); return; }
    if (observation.blocked || outcome?.outcome === 'interrupted') {
      await commit(() => end(outcome?.outcome === 'interrupted' ? 'interrupted' : 'needs_user'));
      return;
    }
    if (task.state === 'waiting') {
      if (!outcome && !observation.running && now >= (task.checkAt ?? now)) {
        await commit(() => {
          if (io.canDispatch()) continueTask(task.ownerDecision ? 'decision' : 'check');
          else if (now - (task.checkAt ?? now) >= UNCONFIRMED_TURN_MS) end('dispatch_failed');
          else io.wake();
        });
      }
      return;
    }
    if (task.checkAt !== undefined && now < task.checkAt) return;
    const nudgeOrPause = (dueAt: number) => {
      if (observation.running || !io.stillMissingOutput(task.turnId, outcome)) return;
      if (task.probes) end('no_output');
      else if (io.canDispatch()) continueTask('probe');
      else if (now - dueAt >= UNCONFIRMED_TURN_MS) end('dispatch_failed');
      else io.wake();
    };
    if (!outcome) {
      const lastActivityAt = Math.max(task.observedAt ?? observation.lastActivityAt ?? now, observation.lastActivityAt ?? 0);
      const dueAt = lastActivityAt + UNCONFIRMED_TURN_MS;
      if (observation.stalled && task.reason !== 'stalled') await commit(() => save({ reason: 'stalled' }));
      else if (observation.running && !observation.stalled && task.reason === 'stalled') {
        await commit(() => save({ reason: undefined }));
      }
      else if (!observation.running && now >= dueAt) {
        await commit(() => nudgeOrPause(dueAt));
      }
      return;
    }

    const answer = outcome.outcome === 'delivered' ? task.reviewEvidence ?? io.finalText(task.turnId) : undefined;
    if (!answer) {
      if (now - outcome.at >= MISSING_REPLY_GRACE_MS) await commit(() => nudgeOrPause(outcome.at + MISSING_REPLY_GRACE_MS));
      return;
    }
    if (!task.reviewEvidence) {
      await commit(() => {
        task.reviewEvidence = answer;
        try { io.persist(); } catch (error) { delete task.reviewEvidence; throw error; }
      });
    }
    const reviewedTask = currentTask();
    if (!reviewedTask) return;
    const stage = reviewedTask.state === 'pending_review' ? 'acceptance' : 'completion';
    const result = await io.review(reviewedTask, answer, review.signal, stage).catch(() => undefined);
    if (review.signal.aborted) return;
    await commit(() => {
      if (!result) {
        save({ reason: 'review_unavailable', checkAt: now + REVIEW_RETRY_MS, reviewAttempt: (task.reviewAttempt ?? 0) + 1 });
        return;
      }
      const assessments: NonNullable<GroupSessionSupervision['assessments']> =
        [...(task.assessments ?? []).slice(-7), { turnId: task.turnId, at: now, stage, result }];
      if (result.verdict === 'ready' && stage === 'completion') {
        save({ state: 'pending_review', assessments, reason: undefined, checkAt: undefined, reviewAttempt: 0 });
        return;
      }
      if (result.verdict === 'accepted' && stage === 'acceptance') {
        save({ state: 'accepted', assessments, reason: undefined, notifiedKey: undefined });
        return;
      }
      if (result.verdict === 'wait') {
        const backoff = EXTERNAL_WAIT_MS * 2 ** Math.min(task.waitChecks ?? 0, 4);
        const wait = Math.min(Math.max(backoff, result.minutes * 60_000), 60 * 60_000);
        save({
          state: 'waiting', assessments, park: { reason: result.reason, evidence: result.evidence },
          reason: undefined, checkAt: now + wait,
        });
        return;
      }
      if (result.verdict !== 'rework') {
        save({ state: 'needs_user', reason: 'needs_user', assessments, decision: result.verdict === 'needs_user' ? result.decision : undefined });
        return;
      }
      if (task.round >= MAX_SUPERVISION_REWORK) {
        save({ state: 'needs_user', reason: 'round_limit', assessments });
        return;
      }
      if (io.canDispatch()) continueTask('rework', assessments, result.missing);
      else if (now - outcome.at >= UNCONFIRMED_TURN_MS) save({ state: 'needs_user', reason: 'dispatch_failed', assessments });
      else {
        io.wake();
        save({ checkAt: now + SUPERVISION_POLL_MS });
      }
    });
  } finally {
    if (reviews.get(session) === review) reviews.delete(session);
  }
}
