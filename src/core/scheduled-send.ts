import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../types.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
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
  const ledger = new TurnSendLedger(dataDir);
  return join(ledger.sessionDirectory(session.sessionId), `.schedule-failure-${ledger.id({
    larkAppId: session.larkAppId!, sessionId: session.sessionId, turnId,
  })}.json`);
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
  | { state: 'ignored' | 'silent' }
  | { state: 'delivered'; messageId: string }
  | { state: 'failed'; taskId: string; runId: string; errorCode: 'schedule_send_rejected' | 'schedule_send_unknown'; error: string };

export function settleScheduledSend(dataDir: string, session: ScheduleSession, turnId: string): ScheduledSendSettlement {
  const run = scheduledSessionRun(session, turnId);
  if (!run || !session.larkAppId || run.turnId !== turnId || parseScheduledTurnId(turnId) !== run.taskId) {
    return { state: 'ignored' };
  }
  const receipt = new TurnSendLedger(dataDir).read({ sessionId: session.sessionId,
    larkAppId: session.larkAppId, turnId });
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
    return { state: 'failed', taskId: run.taskId, runId: run.runId, errorCode: 'schedule_send_unknown',
      error: 'scheduled final delivery ended with an unconfirmed provider publication' };
  }
  return { state: 'silent' };
}

/** Both writes are idempotent. Call again after a partial persistence failure. */
export function applyScheduledSendFailure(
  failure: Extract<ScheduledSendSettlement, { state: 'failed' }>,
  deps: {
    recordFailure: (taskId: string, runId: string, error: string, errorCode: string) => void;
    markRunLogFailed: (taskId: string, runId: string, failure: { error: string; errorCode: string }) => boolean;
  },
): boolean {
  deps.recordFailure(failure.taskId, failure.runId, failure.error, failure.errorCode);
  return deps.markRunLogFailed(failure.taskId, failure.runId, failure);
}
