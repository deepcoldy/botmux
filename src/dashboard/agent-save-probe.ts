import type { BotConfig } from '../bot-registry.js';
import { normalizeCliRuntimeConfig, type CliRuntimeConfig } from '../adapters/cli/runtime.js';
import { resolveCliSelection, selectionKeyForBot } from '../setup/cli-selection.js';
import { botOneShotProbeEnv } from '../core/session-env-resolve.js';
import { checkCliAvailabilityAsync, type CliAvailabilityProbe } from '../setup/cli-availability.js';

export class AgentSaveProbeError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface AgentSaveProbePlan {
  selection: ReturnType<typeof resolveCliSelection>;
  runtime?: CliRuntimeConfig;
  legacyPath?: string;
  env: NodeJS.ProcessEnv;
  fingerprint: string;
  dshTui: boolean;
}

/** Derive exactly the launch shape preserved by same-Agent legacy saves.
 * Re-evaluate against the locked disk entry before accepting a preflight. */
export function agentSaveProbePlan(
  entry: BotConfig, key: string, body: { cliRuntime?: unknown; replaceCliSelection?: unknown; dshRuntime?: unknown; reasoningEffort?: unknown; modelBackendVariant?: unknown; traexAutoModel?: unknown; serviceTier?: unknown },
  baseEnv: NodeJS.ProcessEnv,
): AgentSaveProbePlan {
  const runtimePresent = Object.prototype.hasOwnProperty.call(body, 'cliRuntime');
  const changed = body.replaceCliSelection === true
    || key !== selectionKeyForBot(entry.cliId, entry.wrapperCli, entry.cliLaunchMode);
  const requested = resolveCliSelection(key);
  const selection = !changed && !runtimePresent
    ? { cliId: requested.cliId, wrapperCli: entry.wrapperCli, cliLaunchMode: entry.cliLaunchMode }
    : requested;
  if (runtimePresent && body.cliRuntime !== null) {
    if (selection.cliId !== 'codex') throw new AgentSaveProbeError('runtime_requires_codex');
    if (selection.wrapperCli) throw new AgentSaveProbeError('runtime_wrapper_conflict');
    if (selection.cliLaunchMode) throw new AgentSaveProbeError('runtime_launch_mode_conflict');
  }
  const runtime = runtimePresent
    ? body.cliRuntime === null ? undefined : normalizeCliRuntimeConfig(body.cliRuntime, 'cliRuntime')
    : changed ? undefined : entry.cliRuntime;
  const legacyPath = runtimePresent || changed || runtime ? undefined : entry.cliPathOverride;
  const probe = botOneShotProbeEnv(baseEnv, entry);
  const dshRuntime = Object.prototype.hasOwnProperty.call(body, 'dshRuntime') ? body.dshRuntime : entry.dshRuntime;
  const dshTui = selection.cliId === 'dsh' && dshRuntime === 'tui';
  return {
    selection, runtime, legacyPath, env: probe.env, dshTui,
    fingerprint: JSON.stringify([selection.cliId, selection.wrapperCli ?? '', selection.cliLaunchMode ?? '',
      runtime?.executable ?? legacyPath ?? '', probe.fingerprint, dshTui,
      ...['reasoningEffort', 'modelBackendVariant', 'traexAutoModel', 'serviceTier'].map(field =>
        Object.prototype.hasOwnProperty.call(body, field) ? (body as Record<string, unknown>)[field] : (entry as unknown as Record<string, unknown>)[field])]),
  };
}

export async function probeAgentSaveAvailability(plan: AgentSaveProbePlan): Promise<{
  availability: CliAvailabilityProbe; dshTuiAvailability?: CliAvailabilityProbe;
}> {
  const opts = { env: plan.env, timeoutMs: 1_000, shellFallback: true };
  const [availability, dshTuiAvailability] = await Promise.all([
    checkCliAvailabilityAsync({ ...plan.selection, cliPathOverride: plan.runtime?.executable ?? plan.legacyPath }, opts),
    plan.dshTui ? checkCliAvailabilityAsync({ cliId: 'dsh-tui' }, opts) : undefined,
  ]);
  return { availability, dshTuiAvailability };
}
