export interface ExecutionActivity {
  phase: 'unknown' | 'tool' | 'model_queue';
  source: 'unavailable' | 'turn-start' | 'cli-event' | 'capacity-banner';
  measuredAtMs: number;
  startedAtMs?: number;
  lastProgressAtMs?: number;
  elapsedSeconds?: number;
  progressAgeSeconds?: number;
}

export interface ExecutionActivityInput {
  status?: string;
  workerGeneration?: number;
  capacityQueued?: boolean;
  nowMs: number;
  execution?: { startedAtMs: number; workerGeneration: number; completed?: boolean;
    stage?: 'model_output' | 'tool_started' | 'tool_returned'; lastProgressAtMs?: number };
}

/** Exact observed facts only. Waiting or missing output never implies failure. */
export function projectExecutionActivity(input: ExecutionActivityInput): ExecutionActivity | undefined {
  if (input.status !== 'working' || !Number.isFinite(input.nowMs) || input.nowMs < 0) return undefined;
  const unknown: ExecutionActivity = { phase: 'unknown', source: 'unavailable', measuredAtMs: input.nowMs };
  const execution = input.execution;
  if (!execution || execution.completed || !Number.isSafeInteger(input.workerGeneration) || (input.workerGeneration ?? 0) <= 0
    || execution.workerGeneration !== input.workerGeneration
    || !Number.isFinite(execution.startedAtMs) || execution.startedAtMs < 0 || execution.startedAtMs > input.nowMs) return unknown;
  const tool = execution.stage === 'tool_started';
  const queued = !tool && input.capacityQueued === true;
  const progress = execution.lastProgressAtMs;
  const validProgress = progress !== undefined && Number.isFinite(progress) && progress >= execution.startedAtMs && progress <= input.nowMs;
  return {
    phase: tool ? 'tool' : queued ? 'model_queue' : 'unknown',
    source: tool ? 'cli-event' : queued ? 'capacity-banner' : execution.stage ? 'cli-event' : 'turn-start',
    measuredAtMs: input.nowMs, startedAtMs: execution.startedAtMs,
    elapsedSeconds: Math.floor((input.nowMs - execution.startedAtMs) / 1000),
    ...(validProgress ? { lastProgressAtMs: progress, progressAgeSeconds: Math.floor((input.nowMs - progress) / 1000) } : {}),
  };
}

/**
 * Validate an untrusted observation and recompute its derived durations. With
 * `nowMs` (a live view re-rendering a pushed snapshot) the durations are
 * advanced to that moment; the original measurement time is the floor, so a
 * viewer clock behind the daemon's never rejects or rewinds the observation.
 */
export function normalizeExecutionActivity(raw: unknown, nowMs?: number): ExecutionActivity | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as ExecutionActivity;
  if (!['unknown', 'tool', 'model_queue'].includes(value.phase)
    || !['unavailable', 'turn-start', 'cli-event', 'capacity-banner'].includes(value.source)
    || !Number.isFinite(value.measuredAtMs) || value.measuredAtMs < 0) return undefined;
  const measuredAtMs = nowMs !== undefined && Number.isFinite(nowMs) ? Math.max(value.measuredAtMs, nowMs) : value.measuredAtMs;
  if (value.source === 'unavailable') return value.phase === 'unknown'
    ? { phase: 'unknown', source: 'unavailable', measuredAtMs } : undefined;
  if ((value.phase === 'tool' && value.source !== 'cli-event')
    || (value.phase === 'model_queue' && value.source !== 'capacity-banner')) return undefined;
  if (value.startedAtMs === undefined || !Number.isFinite(value.startedAtMs) || value.startedAtMs < 0 || value.startedAtMs > value.measuredAtMs) return undefined;
  const projected = projectExecutionActivity({ status: 'working', workerGeneration: 1, nowMs: measuredAtMs,
    capacityQueued: value.phase === 'model_queue', execution: { workerGeneration: 1, startedAtMs: value.startedAtMs,
      ...(value.phase === 'tool' ? { stage: 'tool_started' as const } : {}),
      // Progress is only as fresh as the original measurement, never later.
      lastProgressAtMs: value.lastProgressAtMs !== undefined && value.lastProgressAtMs <= value.measuredAtMs ? value.lastProgressAtMs : undefined } })!;
  return { ...projected, source: value.source };
}
