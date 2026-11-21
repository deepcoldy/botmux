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
  const candidate = ds.nativeReasoningObservation;
  const observed = candidate && candidate.cliId === effectiveCliId && candidate.nativeSessionId === ds.session.cliSessionId
    && candidate.workerGeneration === ds.workerGeneration
    && candidate.workerGeneration === ds.session.workerGeneration
    && (ds.localProcessAttestation?.cliSpawnGeneration === undefined
      || candidate.cliSpawnGeneration === ds.localProcessAttestation.cliSpawnGeneration) ? candidate : undefined;
  const staleObservation = candidate && candidate.cliId === effectiveCliId && !observed;
  // Antigravity reports effort only over ACP. Its default terminal transport
  // has no observation channel, so without an ACP reading it keeps showing the
  // configured launch effort exactly as before.
  const strictEffort = ['claude-code', 'codex', 'traex', 'grok'].includes(effectiveCliId ?? '')
    || (effectiveCliId === 'antigravity' && candidate?.cliId === 'antigravity');
  // CLI-local settings can change independently of the frozen launch preference.
  // The explicitly observed CLIs never show an unlabelled launch effort.
  const reasoningEffort = (effectiveCliId !== 'grok' ? ds.activeReasoningEffort?.trim() : undefined)
    || (!strictEffort ? ds.session.reasoningEffort?.trim() : undefined);
  const remoteRunner = (ds.initConfig?.backendType ?? ds.session.backendType) === 'remote-runner';
  const remoteUsage = remoteRunner ? normalizeRemoteRunnerUsageReport(ds.session.remoteRunnerUsage) : undefined;
  const remoteState = remoteRunner ? normalizeRemoteRunnerBackendState(ds.session.remoteBackendState) : undefined;
  const remote = remoteUsage && remoteState && remoteUsage.generation === remoteState.generation
    ? remoteUsage.snapshot : undefined;
  // ZCode's own ledger reports the model and level that actually answered, on
  // the same footing as Grok's signals.json, and is fresher than the launch
  // config — so it outranks every other source here.
  const zcodeNative = effectiveCliId === 'zcode';
  // Kimi: alias + thinking effort from its wire log's `llm.request`.
  const nativeRuntime = effectiveCliId === 'grok' || effectiveCliId === 'minimax' || effectiveCliId === 'kimi' || zcodeNative;
  const nativeModel = nativeRuntime ? snapshot.model?.trim() : undefined;
  const nativeEffort = nativeRuntime ? snapshot.reasoningEffort?.trim() : undefined;
  const model = (zcodeNative ? nativeModel : undefined)
    || remote?.model?.trim()
    || (effectiveCliId === 'minimax' ? nativeModel : undefined)
    || (effectiveCliId === 'grok' ? observed?.model?.trim() || nativeModel : undefined)
    || runtimeModel || nativeModel;
  const effort = staleObservation ? undefined : observed ? observed.reasoningEffort ?? undefined : (zcodeNative ? nativeEffort : undefined)
    || remote?.reasoningEffort?.trim()
    || (effectiveCliId === 'minimax' ? nativeEffort : undefined)
    || (effectiveCliId === 'grok' ? nativeEffort : undefined)
    || reasoningEffort || nativeEffort;
  const effortSource = observed && observed.source !== 'native-summary' ? 'selected'
    : !observed && effort && (effectiveCliId === 'codex' || effectiveCliId === 'traex') ? 'last-execution' : undefined;
  const variant = remote?.modelBackendVariant?.trim() || (ds.activeModelBackendVariant !== undefined
    ? ds.activeModelBackendVariant : ds.session.modelBackendVariant);
  return {
    ...snapshot,
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort }
      : strictEffort ? { reasoningEffort: undefined } : {}),
    ...(strictEffort ? { reasoningEffortSource: effortSource } : {}),
    ...(ds.activeModelBackendVariant !== undefined
      ? { modelBackendVariant: variant || undefined }
      : variant ? { modelBackendVariant: variant } : {}),
  };
}
