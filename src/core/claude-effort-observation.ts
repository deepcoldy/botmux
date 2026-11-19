import { isClaudeStatuslineEffort } from '../services/statusline-snapshot.js';
import type { ClaudeEffortObservation } from '../services/claude-effort-observer.js';
import type { DaemonSession } from './types.js';

/** Apply an effort-only runtime fact from the current worker/native session.
 * Launch preferences and model observations belong to other channels. */
export function applyClaudeEffortObservation(
  ds: DaemonSession,
  observation: ClaudeEffortObservation,
  source: { worker: DaemonSession['worker']; workerGeneration: number | undefined; cliId: string },
): boolean {
  if (source.cliId !== 'claude-code' || !source.worker || !source.workerGeneration
    || ds.worker !== source.worker
    || ds.workerGeneration !== source.workerGeneration
    || ds.session.workerGeneration !== source.workerGeneration
    || !ds.session.cliSessionId || ds.session.cliSessionId !== observation.claudeSessionId
    || (observation.reasoningEffort !== null && !isClaudeStatuslineEffort(observation.reasoningEffort))) return false;
  const effort = observation.reasoningEffort ?? undefined;
  if (ds.activeReasoningEffort === effort) return false;
  ds.activeReasoningEffort = effort;
  return true;
}
