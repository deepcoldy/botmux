import type { ScheduledTask, Session } from '../types.js';
import { isManualScheduledTurn, parseScheduledTurnId } from './scheduled-turn-provenance.js';
import { scheduledSessionRun } from './scheduled-send.js';

export type ScheduledInputAdmission = 'allow' | 'reject' | 'retain';

/** The host ledger binds a queued turn; the authority store decides whether it may still start. */
export function admitScheduledInput(
  session: Session,
  larkAppId: string,
  turnId: string,
  loadTask: ((appId: string, taskId: string) => ScheduledTask | undefined) | undefined,
): ScheduledInputAdmission {
  const taskId = parseScheduledTurnId(turnId);
  const run = scheduledSessionRun(session, turnId);
  if (!taskId || !run || run.taskId !== taskId || run.turnId !== turnId) return 'reject';
  if (!loadTask) return 'retain';
  const task = loadTask(larkAppId, taskId);
  if (!task || task.id !== taskId
    || (run.trigger !== 'dashboard' && !(session.ordinaryTurnRecovery?.currentTurnId === turnId && session.ordinaryTurnRecovery.logicalTurnId !== turnId) && task.lastRunId !== run.runId)
    || (task.larkAppId && task.larkAppId !== larkAppId)
    || task.untilDone?.status === 'done') return 'reject';
  if (task.enabled || isManualScheduledTurn(task, turnId)) return 'allow';
  if (task.lastRunId === run.runId && task.disabledReason === 'once_completed'
    && (!task.untilDone || (task.untilDone.status === 'expired' && task.untilDone.finalRunId === run.runId))) return 'allow';
  return 'reject';
}
