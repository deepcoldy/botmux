import { isNativeReasoningEffort, type NativeReasoningObservation } from '../services/native-reasoning-observation.js';
import type { DaemonSession } from './types.js';

export function applyNativeReasoningObservation(
  ds: DaemonSession, observation: NativeReasoningObservation,
  source: { worker: DaemonSession['worker']; workerGeneration: number | undefined; cliId: string },
): boolean {
  if (!source.worker || !source.workerGeneration || ds.worker !== source.worker
    || ds.workerGeneration !== source.workerGeneration || ds.session.workerGeneration !== source.workerGeneration
    || source.cliId !== observation.cliId || !['codex', 'traex', 'grok', 'antigravity'].includes(source.cliId)
    || !['native-settings', 'native-footer', 'native-summary', 'acp-config'].includes(observation.source)
    || (observation.model !== undefined && typeof observation.model !== 'string')
    || (observation.cliId === 'grok' && observation.source !== 'native-summary')
    || (observation.cliId === 'antigravity' && observation.source !== 'acp-config')
    || (['codex', 'traex'].includes(observation.cliId) && !['native-settings', 'native-footer'].includes(observation.source))
    || !ds.session.cliSessionId || ds.session.cliSessionId !== observation.nativeSessionId
    || (observation.cliSpawnGeneration !== undefined && (!Number.isSafeInteger(observation.cliSpawnGeneration)
      || observation.cliSpawnGeneration < 1
      || (ds.localProcessAttestation?.cliSpawnGeneration !== undefined
        && observation.cliSpawnGeneration < ds.localProcessAttestation.cliSpawnGeneration)))
    || (observation.reasoningEffort !== null && !isNativeReasoningEffort(observation.reasoningEffort))) return false;
  const previous = ds.nativeReasoningObservation;
  const noReading = observation.reasoningEffort === null && !observation.model && observation.observedAtMs === undefined;
  const observedAtMs = observation.observedAtMs ?? (noReading ? previous?.observedAtMs ?? 0 : Date.now());
  if (!Number.isFinite(observedAtMs) || observedAtMs < 0 || observedAtMs > Date.now()) return false;
  if (previous?.cliId === observation.cliId && previous.nativeSessionId === observation.nativeSessionId && previous.workerGeneration === source.workerGeneration
    && (previous.observedAtMs ?? 0) > observedAtMs) return false;
  const next = { ...observation, observedAtMs, workerGeneration: source.workerGeneration };
  const display = (value: typeof previous) => value && [value.cliId, value.nativeSessionId,
    value.reasoningEffort, value.source, value.model, value.workerGeneration, value.cliSpawnGeneration];
  let changed = JSON.stringify(display(previous)) !== JSON.stringify(display(next));
  ds.nativeReasoningObservation = next;
  // Codex/Trae/AGY settings describe the selected next request. Keep their
  // executor model and last-turn effort on the established observation channel.
  if (observation.cliId === 'grok') {
    if (observation.model?.trim() && ds.activeModel !== observation.model.trim()) {
      ds.activeModel = observation.model.trim();
      changed = true;
    }
    const effort = observation.reasoningEffort ?? undefined;
    if (ds.activeReasoningEffort !== effort) changed = true;
    ds.activeReasoningEffort = effort;
  }
  return changed;
}
