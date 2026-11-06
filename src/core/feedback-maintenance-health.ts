import type { DaemonSession } from './types.js';
import { hasBotTurnActivity } from './bot-turn-mutation-gate.js';
import { isRemoteBackendId, isRemoteCliId } from './remote-cli-ids.js';

/** Runtime work that must drain before the feedback store can be frozen. */
export function hasFeedbackMaintenanceSessionWork(session: DaemonSession): boolean {
  return (session.finalOutputDeliveriesInFlight?.size ?? 0) > 0
    || (session.backgroundTaskCount ?? 0) > 0
    || session.initialStartPending === true
    || session.worktreeCreating === true
    || session.pendingRepoCommitInFlight === true
    || (session.session.status === 'active'
      && !['idle', 'limited', 'interrupted'].includes(session.lastScreenStatus ?? '')
      && (!!session.worker && !session.worker.killed
        // A missing local worker is not proof that remote execution stopped.
        // Keep the existing remote policy until a terminal boundary is known.
        || isRemoteBackendId(session.session.backendType ?? session.initConfig?.backendType ?? '')
        || isRemoteCliId(session.session.cliId)));
}

export function isFeedbackMaintenanceBusy(larkAppId: string, sessions: Iterable<DaemonSession>): boolean {
  return hasBotTurnActivity(larkAppId) || [...sessions].some(hasFeedbackMaintenanceSessionWork);
}
