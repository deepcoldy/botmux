import type { ScheduledTask, Session } from '../types.js';
import { isManualScheduledTurn, parseScheduledTurnId } from './scheduled-turn-provenance.js';
import { scheduledSessionRun, type ScheduledRunTriggerEvidence } from './scheduled-send.js';

export type ScheduledInputAdmission = 'allow' | 'reject' | 'retain';

/** The host ledger binds a queued turn; the authority store decides whether it may still start. */
export function admitScheduledInput(
  session: Session,
  larkAppId: string,
  turnId: string,
  loadTask: ((appId: string, taskId: string) => ScheduledTask | undefined) | undefined,
  loadTrigger?: ScheduledRunTriggerEvidence,
): ScheduledInputAdmission {
  const taskId = parseScheduledTurnId(turnId);
  const run = scheduledSessionRun(session, turnId);
  if (!taskId || !run || run.taskId !== taskId || run.turnId !== turnId) return 'reject';
  if (!loadTask) return 'retain';
  const task = loadTask(larkAppId, taskId);
  if (!task) return 'reject';
  const recoveryOfTurnId = run.recoveryOfTurnId;
  if (recoveryOfTurnId) {
    const recovery = session.ordinaryTurnRecovery;
    // A run marked as recovery can never fall back to the ordinary dashboard or
    // scheduler exemptions after its owner settles, moves, or is cancelled.
    if (parseScheduledTurnId(recoveryOfTurnId) !== taskId
      || recovery?.logicalTurnId !== recoveryOfTurnId
      || recovery.currentTurnId !== turnId
      || !['dispatching', 'running'].includes(recovery.status)) return 'reject';
  }
  const trigger = run.trigger ?? loadTrigger?.(taskId, run.runId)
    ?? (isManualScheduledTurn(task, turnId) ? 'dashboard' : undefined);
  // Old rows without host trigger evidence fail closed. Queue policy likewise
  // treats them as non-automatic, so they cannot bypass STOP/quota protection.
  if (!trigger || task.id !== taskId
    || (trigger !== 'dashboard' && !recoveryOfTurnId && task.lastRunId !== run.runId)
    || (task.larkAppId && task.larkAppId !== larkAppId)
    || task.untilDone?.status === 'done') return 'reject';
  if (task.enabled || isManualScheduledTurn(task, turnId)) return 'allow';
  if (task.lastRunId === run.runId && task.disabledReason === 'once_completed'
    && (!task.untilDone || (task.untilDone.status === 'expired' && task.untilDone.finalRunId === run.runId))) return 'allow';
  return 'reject';
}
