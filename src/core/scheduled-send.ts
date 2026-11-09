import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import type { Session } from '../types.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { FileLockTimeoutError, withFileLockSync } from '../utils/file-lock.js';
import { TurnSendLedger } from '../services/turn-send-ledger.js';
import { isManualScheduledTurn, parseScheduledTurnId } from './scheduled-turn-provenance.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';

type ScheduleSession = Pick<Session, 'sessionId' | 'larkAppId' | 'chatId' | 'scheduledRun' | 'scheduledRuns'>;

export function scheduledSessionRun(session: ScheduleSession | undefined, turnId: string | undefined): Session['scheduledRun'] {
  if (!session || !turnId) return;
  return session.scheduledRuns?.[turnId]
    ?? (session.scheduledRun?.turnId === turnId ? session.scheduledRun : undefined);
}

export function recordScheduledSessionRun(session: Session, run: NonNullable<Session['scheduledRun']>): void {
  session.scheduledRun = run;
  session.scheduledRuns = Object.fromEntries(Object.entries({ ...session.scheduledRuns, [run.turnId]: run }).slice(-100));
}

/** Only the daemon's recovery coordinator may link its freshly minted turn to
 * the original run. A task prefix alone cannot extend a paused-run permit. */
export function prepareScheduledRecoveryRun(session: Session, turnId: string, deps: {
  getAuthority: (taskId: string) => ScheduleAuthorityRecord | undefined;
  admitManualTurn: (taskId: string, runId: string, turnId: string) => boolean;
  persist: () => void;
}): void {
  const recovery = session.ordinaryTurnRecovery;
  if (!recovery || recovery.currentTurnId !== turnId || recovery.logicalTurnId === turnId
    || !['dispatching', 'running'].includes(recovery.status)) return;
  const taskId = parseScheduledTurnId(turnId);
  if (!taskId || parseScheduledTurnId(recovery.logicalTurnId) !== taskId) return;
  const original = scheduledSessionRun(session, recovery.logicalTurnId);
  const authority = deps.getAuthority(taskId);
  if (!original || !authority || original.taskId !== taskId || authority.task.lastRunId !== original.runId
    || (authority.state !== 'active' && !(authority.state === 'completed'
      && authority.task.disabledReason === 'once_completed')
      && !(authority.state === 'paused' && isManualScheduledTurn(authority.task, recovery.logicalTurnId)
        && deps.admitManualTurn(taskId, original.runId, turnId)))) {
    throw new Error('scheduled recovery no longer owns its original execution');
  }
  recordScheduledSessionRun(session, { ...original, turnId });
  deps.persist();
}

/** Caller must supply a marker/host-attested origin, never a model env hint. */
export function feedbackPolicyForScheduledSend<T extends { audience: string }>(input: {
  policy: T | undefined;
  requesterSubjectId?: string;
  authenticatedTurnId?: string;
  session: ScheduleSession | undefined;
}): T | undefined {
  const run = scheduledSessionRun(input.session, input.authenticatedTurnId);
  return input.policy?.audience === 'requester' && !input.requesterSubjectId
    && run && input.authenticatedTurnId === run.turnId
    && parseScheduledTurnId(run.turnId) === run.taskId
    ? undefined : input.policy;
}

interface SendFailure {
  taskId: string;
  runId: string;
  turnId: string;
  unknown: boolean;
  error: string;
}

function failurePath(dataDir: string, session: ScheduleSession, turnId: string): string {
  return new TurnSendLedger(dataDir).scheduleFailurePath({
    larkAppId: session.larkAppId!, sessionId: session.sessionId, turnId,
  });
}

function readFailure(dataDir: string, session: ScheduleSession, turnId: string): SendFailure | undefined {
  const path = failurePath(dataDir, session, turnId);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe scheduled send observation');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as SendFailure;
  const run = scheduledSessionRun(session, turnId);
  if (raw.taskId !== run?.taskId || raw.runId !== run.runId || raw.turnId !== turnId
    || typeof raw.unknown !== 'boolean' || typeof raw.error !== 'string') return;
  return raw;
}

/** Observability only. This sidecar never grants identity or authorizes retry. */
export class ScheduleSendAttempt {
  private providerStarted = false;
  constructor(private dataDir: string, private session: ScheduleSession, private turnId: string) {}
  providerRequestStarted(): void { this.providerStarted = true; }
  fail(error: unknown): void {
    const run = scheduledSessionRun(this.session, this.turnId);
    if (!run || !this.session.larkAppId || run.turnId !== this.turnId
      || parseScheduledTurnId(this.turnId) !== run.taskId) return;
    const path = failurePath(this.dataDir, this.session, this.turnId);
    const ledger = new TurnSendLedger(this.dataDir);
    const directory = ledger.sessionDirectory(this.session.sessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const dir of [ledger.directory, directory]) {
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
        throw new Error('Unsafe scheduled send directory');
      }
    }
    withFileLockSync(path, () => {
      const prior = readFailure(this.dataDir, this.session, this.turnId);
      const receipt = ledger.read({ larkAppId: this.session.larkAppId!, sessionId: this.session.sessionId, turnId: this.turnId });
      const unknown = this.providerStarted || prior?.unknown === true || !!receipt?.publication
        || receipt?.nonIdempotentSequence?.inFlightStep !== undefined;
      const failure: SendFailure = { ...run, unknown,
        error: (prior && (prior.unknown || !unknown) ? prior.error
          : error instanceof Error ? error.message : String(error)).slice(0, 2048) };
      atomicWriteFileSync(path, JSON.stringify(failure), { mode: 0o600, durable: true, followTargetSymlink: false });
    });
  }
}

export type ScheduledSendSettlement =
  | { state: 'ignored' | 'silent' | 'in_flight' }
  | { state: 'delivered'; messageId: string }
  | { state: 'failed'; taskId: string; runId: string; errorCode: 'schedule_send_rejected' | 'schedule_send_unknown'; error: string };

/** How long a send that is still being delivered may hold back its settlement
 * before it is accounted unknown. */
export const SCHEDULED_SEND_IN_FLIGHT_LIMIT_MS = 10 * 60_000;

export function scheduledSendInFlightRecheckMs(checks: number): number {
  return Math.min(15_000, 500 * 2 ** Math.min(checks, 5));
}

export interface ScheduledSendInFlight {
  /** The daemon is still running its own final delivery for this turn. */
  daemonDelivering?: boolean;
  /** Settlement has waited SCHEDULED_SEND_IN_FLIGHT_LIMIT_MS for the sender. */
  expired?: boolean;
}

export function settleScheduledSend(
  dataDir: string,
  session: ScheduleSession,
  turnId: string,
  inFlight: ScheduledSendInFlight = {},
): ScheduledSendSettlement {
  const run = scheduledSessionRun(session, turnId);
  if (!run || !session.larkAppId || run.turnId !== turnId || parseScheduledTurnId(turnId) !== run.taskId) {
    return { state: 'ignored' };
  }
  const ledger = new TurnSendLedger(dataDir);
  const key = { sessionId: session.sessionId, larkAppId: session.larkAppId, turnId };
  const unknown = (error: string): ScheduledSendSettlement => ({ state: 'failed', taskId: run.taskId,
    runId: run.runId, errorCode: 'schedule_send_unknown', error });
  // A sender that is still delivering writes the receipt itself; its publication
  // is pending, not unknown, until it finishes or the wait expires.
  const whileDelivering = (): ScheduledSendSettlement => {
    const receipt = ledger.read(key);
    if (receipt?.final) return { state: 'delivered', messageId: receipt.final.messageId };
    return inFlight.expired
      ? unknown('scheduled final delivery was still in flight when settlement stopped waiting')
      : { state: 'in_flight' };
  };
  const settle = (): ScheduledSendSettlement => {
    const receipt = ledger.read(key);
    if (receipt?.final) return { state: 'delivered', messageId: receipt.final.messageId };
    const failure = readFailure(dataDir, session, turnId);
    if (failure) {
      return { state: 'failed', taskId: run.taskId, runId: run.runId,
        errorCode: failure.unknown ? 'schedule_send_unknown' : 'schedule_send_rejected', error: failure.error };
    }
    // A hard kill (OOM/SIGKILL/lost response) after the provider request started
    // leaves a fenced publication or in-flight chunk marker without a final receipt
    // or failure sidecar: the message MAY have been delivered, so it must be
    // accounted as unknown — never silently dropped. A later receipt reconciles it.
    if (receipt?.publication || receipt?.nonIdempotentSequence?.inFlightStep !== undefined) {
      return unknown('scheduled final delivery ended with an unconfirmed provider publication');
    }
    return { state: 'silent' };
  };
  if (inFlight.daemonDelivering) return whileDelivering();
  const directory = ledger.sessionDirectory(session.sessionId);
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return settle();
  // TurnSendLedger.execute holds the record lock for the whole provider call.
  try {
    return withFileLockSync(ledger.recordPath(key), settle, { maxWaitMs: 0 });
  } catch (error) {
    if (error instanceof FileLockTimeoutError) return whileDelivering();
    throw error;
  }
}

export interface ScheduledDeliveryAccounting {
  /** Both return false once a newer run owns the task. */
  recordFailure(taskId: string, runId: string, error: string, errorCode: string): boolean;
  recordDelivered(taskId: string, runId: string): boolean;
  /** Both return false while the run's execution-log row is not available. */
  markRunLogFailed(taskId: string, runId: string, failure: { error: string; errorCode: string }): boolean;
  markRunLogDelivered(taskId: string, runId: string): boolean;
}

export type ScheduledDeliveryStep =
  | { next: 'in_flight' }
  | { next: 'retry_log'; delivery: ScheduledSendSettlement }
  | { next: 'settled'; delivery: ScheduledSendSettlement; superseded?: true };

/** The task row decides whether the run still owns its accounting and the
 * execution log follows that decision, so a superseded run's late observation
 * changes neither. Every write is idempotent; call again after `retry_log`. */
export function reconcileScheduledDelivery(
  dataDir: string,
  session: ScheduleSession,
  turnId: string,
  inFlight: ScheduledSendInFlight,
  accounting: ScheduledDeliveryAccounting,
): ScheduledDeliveryStep {
  const delivery = settleScheduledSend(dataDir, session, turnId, inFlight);
  if (delivery.state === 'in_flight') return { next: 'in_flight' };
  const run = scheduledSessionRun(session, turnId);
  if (!run || (delivery.state !== 'failed' && delivery.state !== 'delivered')) return { next: 'settled', delivery };
  const current = delivery.state === 'failed'
    ? accounting.recordFailure(run.taskId, run.runId, delivery.error, delivery.errorCode)
    : accounting.recordDelivered(run.taskId, run.runId);
  if (!current) return { next: 'settled', delivery, superseded: true };
  const logged = delivery.state === 'failed'
    ? accounting.markRunLogFailed(run.taskId, run.runId, { error: delivery.error, errorCode: delivery.errorCode })
    : accounting.markRunLogDelivered(run.taskId, run.runId);
  return logged ? { next: 'settled', delivery } : { next: 'retry_log', delivery };
}

/** The latest turn of each run that is still its task's latest run. A daemon
 * restart drops pending settlements, so these are settled again (idempotently)
 * on startup. A recovery turn continues its original run, so the turn it
 * replaced is not settled again. */
export function scheduledTurnsOfCurrentRuns<S extends ScheduleSession>(
  sessions: readonly S[],
  currentRunId: (taskId: string) => string | undefined,
): Array<{ session: S; turnId: string }> {
  const turns: Array<{ session: S; turnId: string }> = [];
  for (const session of sessions) {
    const runs = Object.entries(session.scheduledRuns ?? {});
    if (session.scheduledRun) runs.push([session.scheduledRun.turnId, session.scheduledRun]);
    const latest = new Map<string, string>();
    for (const [turnId, run] of runs) {
      if (run.turnId === turnId && currentRunId(run.taskId) === run.runId) {
        latest.set(JSON.stringify([run.taskId, run.runId]), turnId);
      }
    }
    for (const turnId of latest.values()) turns.push({ session, turnId });
  }
  return turns;
}
