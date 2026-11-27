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
  /** Per-bot CLI profile dir. Probes must read this account, not `~/.claude`. */
  configDir: string | undefined;
  /** False when this Bot's persisted launch shape can't be probed safely. */
  canProbe: boolean;
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
  const configDir = runtimeApplies ? botConfig.cliConfigDir : undefined;
  return {
    cliId,
    runtimeExecutable,
    // configDir 参与身份：同一 CLI 的不同 profile 是不同账户，缓存不能混。
    runtimeContext: runtimeApplies
      ? `${botConfig.larkAppId}:${cliId}:${runtimeExecutable ?? 'default'}${configDir ? `:${configDir}` : ''}`
      : undefined,
    probeEnv: probe?.env,
    fingerprint: probe?.fingerprint,
    configDir,
    // Without a Bot we probe the host default CLI (the pre-bot behaviour).
    // With a Bot, only an exactly matching launch shape may be probed: an
    // unknown wrapper must not borrow the host's native catalogue.
    canProbe: botConfig === undefined || runtimeApplies,
  };
}
