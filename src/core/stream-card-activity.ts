import type { ActivityCardLabel } from '../im/lark/card-builder.js';
import type { ExecutionActivity } from './execution-activity.js';

/**
 * Card presentation of the shared execution projection. Only Trae CLI carries
 * the in-card activity line: its native transcript reports phases and its card
 * already showed them; every other CLI keeps the plain working header. A phase
 * without evidence renders as plain working, and no verified turn start means
 * no activity label at all (elapsed time is never invented).
 */
export function streamCardExecutionLabel(
  cliId: string | undefined,
  observed: ExecutionActivity | undefined,
): ActivityCardLabel | undefined {
  if (cliId !== 'traex' || observed?.elapsedSeconds === undefined) return undefined;
  return {
    activity: observed.phase === 'unknown' ? 'working' : observed.phase,
    elapsedSeconds: observed.elapsedSeconds,
    ...(observed.progressAgeSeconds !== undefined ? { progressAgeSeconds: observed.progressAgeSeconds } : {}),
  };
}
