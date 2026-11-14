import type { DaemonSession } from './types.js';
import { traexCapacityQueueVisible } from '../adapters/cli/traex.js';
import { projectExecutionActivity } from './execution-activity.js';

/** Shared source selection for the card, Dashboard row, and observe projection. */
export function sessionExecutionActivity(ds: DaemonSession, nowMs = Date.now()) {
  if (ds.session.queued || !ds.worker || ds.worker.killed) return undefined;
  const status = ds.lastScreenStatus ?? (ds.workerReady ? 'working' : 'starting');
  const capture = ds.captureIdentity?.workerGeneration === ds.workerGeneration ? ds.captureIdentity : undefined;
  const source = capture ?? ds.managedTurnOrigin;
  const highWater = ds.turnDispatchAttemptHighWater;
  const validSource = source?.turnId === ds.currentTurnId && source?.turnId
    && (highWater?.turnId !== source.turnId || (source.dispatchAttempt !== undefined && source.dispatchAttempt >= highWater.dispatchAttempt));
  const execution = validSource ? ds.replyExecutionStarts?.get(JSON.stringify([source.turnId, source.dispatchAttempt ?? null])) : undefined;
  return projectExecutionActivity({ status, workerGeneration: ds.workerGeneration, nowMs, execution,
    capacityQueued: validSource && (ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId) === 'traex'
      ? traexCapacityQueueVisible(ds.lastScreenContent ?? '') : false });
}
