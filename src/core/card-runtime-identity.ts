import type { CliId } from '../adapters/cli/types.js';
import {
  normalizeRemoteRunnerBackendState,
  normalizeRemoteRunnerUsageReport,
} from '../adapters/backend/remote-runner-protocol.js';
import type { CardUsageSnapshot } from '../im/lark/md-card.js';
import type { DaemonSession } from './types.js';

/** Attach known runtime identity even when usage metrics are hidden/missing.
 * Never expose tokens.model: some CLIs put internal routing IDs there. This
 * does not read transcripts or infer effort from arbitrary model-name suffixes. */
export function withCardRuntimeIdentity(
  ds: DaemonSession,
  snapshot: CardUsageSnapshot,
  effectiveCliId: CliId | undefined = ds.session.cliId,
): CardUsageSnapshot {
  const runtimeModel = ds.activeModel?.trim() || ds.session.model?.trim();
  const reasoningEffort = ds.activeReasoningEffort?.trim() || ds.session.reasoningEffort?.trim();
  const remoteRunner = (ds.initConfig?.backendType ?? ds.session.backendType) === 'remote-runner';
  const remoteUsage = remoteRunner ? normalizeRemoteRunnerUsageReport(ds.session.remoteRunnerUsage) : undefined;
  const remoteState = remoteRunner ? normalizeRemoteRunnerBackendState(ds.session.remoteBackendState) : undefined;
  const remote = remoteUsage && remoteState && remoteUsage.generation === remoteState.generation
    ? remoteUsage.snapshot : undefined;
  const nativeRuntime = effectiveCliId === 'grok' || effectiveCliId === 'minimax';
  const nativeModel = nativeRuntime ? snapshot.model?.trim() : undefined;
  const nativeEffort = nativeRuntime ? snapshot.reasoningEffort?.trim() : undefined;
  const model = remote?.model?.trim()
    || (effectiveCliId === 'minimax' ? nativeModel : undefined)
    || runtimeModel || nativeModel;
  const effort = remote?.reasoningEffort?.trim()
    || (effectiveCliId === 'minimax' ? nativeEffort : undefined)
    || reasoningEffort || nativeEffort;
  const variant = remote?.modelBackendVariant?.trim() || ds.session.modelBackendVariant;
  return {
    ...snapshot,
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(variant ? { modelBackendVariant: variant } : {}),
  };
}
