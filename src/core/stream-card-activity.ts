import { traexCapacityQueueVisible } from '../adapters/cli/traex.js';
import type { ActivityCardLabel } from '../im/lark/card-builder.js';

export interface TurnExecutionActivity {
  startedAtMs: number;
  workerGeneration: number;
  stage?: 'model_output' | 'tool_started' | 'tool_returned';
  lastProgressAtMs?: number;
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
  const execution = input.execution;
  if (!execution || execution.workerGeneration !== input.workerGeneration
    || !Number.isFinite(execution.startedAtMs) || execution.startedAtMs < 0
    || execution.startedAtMs > input.nowMs) return undefined;
  const activity = traexCapacityQueueVisible(input.content ?? '') ? 'model_queue'
    : execution.stage === 'tool_started' ? 'tool' : 'working';
  return {
    activity,
    elapsedSeconds: Math.max(0, Math.floor((input.nowMs - execution.startedAtMs) / 1000)),
    ...(execution.lastProgressAtMs !== undefined && Number.isFinite(execution.lastProgressAtMs)
      && execution.lastProgressAtMs <= input.nowMs
      ? { progressAgeSeconds: Math.max(0, Math.floor((input.nowMs - execution.lastProgressAtMs) / 1000)) } : {}),
  };
}
