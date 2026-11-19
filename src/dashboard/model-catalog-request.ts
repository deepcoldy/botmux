import type { BotConfig } from '../bot-registry.js';
import { botOneShotProbeEnv } from '../core/session-env-resolve.js';
import { runtimeExecutableForBotSelection } from '../services/model-catalog.js';
import {
  lookupCliSelection,
  lookupCliSelectionForBotShape,
  resolveCliSelection,
} from '../setup/cli-selection.js';

export interface ModelCatalogProbeContext {
  cliId: ReturnType<typeof resolveCliSelection>['cliId'];
  runtimeExecutable: string | undefined;
  runtimeContext: string | undefined;
  probeEnv: NodeJS.ProcessEnv | undefined;
  fingerprint: string | undefined;
}

/**
 * Derive Bot-specific probe inputs only when the persisted launch shape
 * exactly matches the requested selection. Unknown wrappers and launch modes
 * must probe with the default CLI environment, never Bot credentials.
 */
export function modelCatalogProbeContext(
  key: string,
  botConfig: BotConfig | undefined,
  baseEnv: NodeJS.ProcessEnv,
): ModelCatalogProbeContext {
  const cliId = resolveCliSelection(key).cliId;
  const requestedSelection = lookupCliSelection(key);
  const persistedSelection = botConfig
    ? lookupCliSelectionForBotShape(botConfig.cliId, botConfig.wrapperCli, botConfig.cliLaunchMode)
    : undefined;
  const runtimeApplies = botConfig !== undefined
    && requestedSelection !== undefined
    && persistedSelection?.key === requestedSelection.key;
  const runtimeExecutable = runtimeApplies
    ? runtimeExecutableForBotSelection(key, botConfig)
    : undefined;
  const probe = runtimeApplies ? botOneShotProbeEnv(baseEnv, botConfig) : undefined;
  return {
    cliId,
    runtimeExecutable,
    runtimeContext: runtimeApplies
      ? `${botConfig.larkAppId}:${cliId}:${runtimeExecutable ?? 'default'}`
      : undefined,
    probeEnv: probe?.env,
    fingerprint: probe?.fingerprint,
  };
}
