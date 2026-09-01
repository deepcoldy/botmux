/** Pure event-loop liveness decisions shared by worker and fleet watchdogs. */

export interface WorkerHeartbeatDecisionInput {
  nowMs: number;
  lastHeartbeatAtMs: number;
  staleMs: number;
}

/** The exact lease boundary remains healthy; only strictly older beats stall. */
export function workerHeartbeatStalled(input: WorkerHeartbeatDecisionInput): boolean {
  if (!Number.isFinite(input.nowMs)
    || !Number.isFinite(input.lastHeartbeatAtMs)
    || !Number.isFinite(input.staleMs)
    || input.staleMs < 0) return true;
  return input.nowMs - input.lastHeartbeatAtMs > input.staleMs;
}

export type DaemonHeartbeatStatus = 'starting' | 'healthy' | 'stalled';

export interface DaemonHeartbeatDecisionInput {
  nowMs: number;
  startedAtMs: number;
  expectedPid: number;
  heartbeat: { pid?: number; atMs: number } | null;
  startupGraceMs: number;
  staleMs: number;
}

/**
 * A daemon must publish a heartbeat bound to its current OS pid. A fresh file
 * left by the previous generation is not evidence that the replacement event
 * loop is alive. Missing/mismatched evidence is tolerated only during startup.
 */
export function daemonHeartbeatStatus(input: DaemonHeartbeatDecisionInput): DaemonHeartbeatStatus {
  const ageMs = input.nowMs - input.startedAtMs;
  const inStartupGrace = Number.isFinite(ageMs)
    && Number.isFinite(input.startupGraceMs)
    && ageMs <= input.startupGraceMs;
  const heartbeat = input.heartbeat;
  const matchesCurrentProcess = !!heartbeat
    && Number.isSafeInteger(input.expectedPid)
    && input.expectedPid > 1
    && heartbeat.pid === input.expectedPid;

  if (!matchesCurrentProcess) return inStartupGrace ? 'starting' : 'stalled';
  return workerHeartbeatStalled({
    nowMs: input.nowMs,
    lastHeartbeatAtMs: heartbeat.atMs,
    staleMs: input.staleMs,
  }) ? 'stalled' : 'healthy';
}
