import { traexCapacityQueueVisible } from '../adapters/cli/traex.js';
import type { ActivityCardLabel } from '../im/lark/card-builder.js';
import { projectExecutionActivity } from './execution-activity.js';

export interface TurnExecutionActivity {
  startedAtMs: number;
  workerGeneration: number;
  stage?: 'model_output' | 'tool_started' | 'tool_returned';
  lastProgressAtMs?: number;
  completed?: boolean;
}

/** Presentation only: never treats elapsed time or missing output as failure. */
export function traexStreamCardActivity(input: {
  cliId?: string;
  status?: string;
  content?: string;
  execution?: TurnExecutionActivity;
  workerGeneration?: number;
  nowMs: number;
}): ActivityCardLabel | undefined {
  if (input.cliId !== 'traex' || input.status !== 'working') return undefined;
  const observed = projectExecutionActivity({ ...input, capacityQueued: traexCapacityQueueVisible(input.content ?? '') });
  if (!observed) return undefined;
  return {
    activity: observed.phase,
    ...(observed.elapsedSeconds !== undefined ? { elapsedSeconds: observed.elapsedSeconds } : {}),
    ...(observed.progressAgeSeconds !== undefined ? { progressAgeSeconds: observed.progressAgeSeconds } : {}),
  };
}
