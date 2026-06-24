import type { SessionProbe } from '../adapters/backend/types.js';

export type GoalWorkerSessionState = 'live' | 'suspended' | 'closed' | 'missing' | 'unknown';
export type GoalWorkerProcessState = 'live' | 'none' | 'killed' | 'unknown';

type WorkerLike = {
  killed?: boolean;
} | null | undefined;

export function classifyGoalWorkerHealth(input: {
  sessionStatus?: string;
  suspendedColdResume?: boolean;
  worker?: WorkerLike;
  persistentProbe?: SessionProbe;
}): { session: GoalWorkerSessionState; workerProcess: GoalWorkerProcessState } {
  const backingMissing = input.persistentProbe === 'missing';
  const session: GoalWorkerSessionState = input.sessionStatus === 'active'
    ? (input.suspendedColdResume && !backingMissing ? 'suspended' : 'live')
    : 'closed';
  const workerProcess: GoalWorkerProcessState = backingMissing
    ? 'none'
    : (input.worker ? (input.worker.killed ? 'killed' : 'live') : 'none');
  return { session, workerProcess };
}
