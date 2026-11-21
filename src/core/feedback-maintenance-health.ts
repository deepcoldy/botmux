import type { DaemonSession } from './types.js';
import { hasBotTurnActivity } from './bot-turn-mutation-gate.js';
import { isRemoteBackendId, isRemoteCliId } from './remote-cli-ids.js';

/** Runtime work that must drain before the feedback store can be frozen. */
export function hasFeedbackMaintenanceSessionWork(session: DaemonSession): boolean {
  // In-flight delivery promises are owned by the daemon itself and settle
  // regardless of worker liveness; keep them independent of every other leg.
  if ((session.finalOutputDeliveriesInFlight?.size ?? 0) > 0) return true;
  // These preparation flags gate worker creation itself, so no worker/liveness
  // condition applies while they are set.
  if (session.initialStartPending === true
    || session.worktreeCreating === true
    || session.pendingRepoCommitInFlight === true) return true;
  if (session.session.status !== 'active') return false;
  // Both the screen status and the background-task count are snapshots from
  // the worker's last screen_update. After a local worker crash the count goes
  // stale just like the screen does (nothing clears it until the next
  // screen_update), so either signal counts only while a local worker is still
  // alive or while execution provably runs off-box — a missing local worker is
  // not proof that remote execution stopped.
  const screenOrBackgroundBusy = (session.backgroundTaskCount ?? 0) > 0
    || !['idle', 'limited', 'interrupted'].includes(session.lastScreenStatus ?? '');
  if (!screenOrBackgroundBusy) return false;
  return (!!session.worker && !session.worker.killed)
    || isRemoteBackendId(session.session.backendType ?? session.initConfig?.backendType ?? '')
    || isRemoteCliId(session.session.cliId);
}

export function isFeedbackMaintenanceBusy(larkAppId: string, sessions: Iterable<DaemonSession>): boolean {
  return hasBotTurnActivity(larkAppId) || [...sessions].some(hasFeedbackMaintenanceSessionWork);
}
