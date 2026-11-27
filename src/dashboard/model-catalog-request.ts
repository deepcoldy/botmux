import type { BotConfig } from '../bot-registry.js';
import { botOneShotProbeEnv } from '../core/session-env-resolve.js';
import { resolveSandboxMode } from '../adapters/cli/sandbox-mode.js';
import { credentialSourceForcesBotHome } from '../services/cli-credential-source.js';
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
  /** Botmux-owned overlay, separate from the inherited part of probeEnv. */
  probeSettingsEnv: NodeJS.ProcessEnv | undefined;
  fingerprint: string | undefined;
  /** Per-bot CLI profile dir. Probes must read this account, not `~/.claude`. */
  configDir: string | undefined;
  /** False when this Bot's persisted launch shape can't be probed safely. */
  canProbe: boolean;
}

/**
 * Native Claude redirects oncall/read-isolation and credential-source launches
 * into BOT_HOME only at worker spawn time. A Dashboard/one-shot probe cannot
 * reconstruct the per-session (especially assistant-owner) root, so it must
 * fail closed instead of reading the source profile or host ~/.claude.
 */
function redirectsClaudeDataAwayFromProbe(bot: BotConfig, baseEnv: NodeJS.ProcessEnv): boolean {
  if (bot.cliId !== 'claude-code' || bot.wrapperCli) return false;
  try {
    const mode = resolveSandboxMode({
      configSandbox: bot.sandbox,
      readIsolation: bot.readIsolation,
      envValue: baseEnv.BOTMUX_SANDBOX,
    });
    const sandboxRequested = mode !== 'off';
    return mode === 'oncall' || (mode !== 'scratch' && credentialSourceForcesBotHome({
      sourceDir: bot.credentialsSourceDir,
      cliId: bot.cliId,
      sandboxRequested,
      home: baseEnv.HOME,
    }));
  } catch {
    return true;
  }
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
    probeSettingsEnv: probe?.settingsEnv,
    fingerprint: probe?.fingerprint,
    configDir,
    // Without a Bot we probe the host default CLI (the pre-bot behaviour).
    // With a Bot, only an exactly matching launch shape may be probed: an
    // unknown wrapper must not borrow the host's native catalogue. A native
    // Claude data root redirected by the worker is not visible to this probe.
    canProbe: (botConfig === undefined || runtimeApplies)
      && !(botConfig && runtimeApplies && redirectsClaudeDataAwayFromProbe(botConfig, baseEnv)),
  };
}
