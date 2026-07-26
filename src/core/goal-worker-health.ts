import type { SessionProbe } from '../adapters/backend/types.js';

export type GoalWorkerSessionState = 'live' | 'suspended' | 'closed' | 'missing' | 'unknown';
export type GoalWorkerProcessState = 'live' | 'none' | 'killed' | 'unknown';

export interface GoalWorkerHealthEntry {
  larkAppId: string;
  sessionId?: string;
  session: GoalWorkerSessionState;
  workerProcess: GoalWorkerProcessState;
  lastActivityAt?: string;
  title?: string;
}

export type GoalWorkerHealthProbe = {
  probeOk: boolean;
  entries: GoalWorkerHealthEntry[];
};

const SESSION_STATES = new Set<GoalWorkerSessionState>(['live', 'suspended', 'closed', 'missing', 'unknown']);
const PROCESS_STATES = new Set<GoalWorkerProcessState>(['live', 'none', 'killed', 'unknown']);

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** A 2xx IPC response is conclusive only when its full payload has the shape
 * promised by the worker-health endpoint. Treat truncated JSON, missing
 * `entries`, or malformed entries as an unknown probe instead of evidence that
 * a session is absent. */
export function parseGoalWorkerHealthProbe(value: unknown, expectedLarkAppId?: string): GoalWorkerHealthProbe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { probeOk: false, entries: [] };
  }
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return { probeOk: false, entries: [] };
  if (!entries.every((entry): entry is GoalWorkerHealthEntry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return typeof record.larkAppId === 'string' && record.larkAppId.trim().length > 0
      && (!expectedLarkAppId || record.larkAppId === expectedLarkAppId)
      && typeof record.session === 'string' && SESSION_STATES.has(record.session as GoalWorkerSessionState)
      && typeof record.workerProcess === 'string' && PROCESS_STATES.has(record.workerProcess as GoalWorkerProcessState)
      && isOptionalString(record.sessionId)
      && isOptionalString(record.lastActivityAt)
      && isOptionalString(record.title);
  })) {
    return { probeOk: false, entries: [] };
  }
  return { probeOk: true, entries };
}

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
