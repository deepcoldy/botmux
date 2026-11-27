import type { BotConfig } from '../bot-registry.js';
import type { CliAdapter } from '../adapters/cli/types.js';
import { modelCatalogProbeContext } from '../dashboard/model-catalog-request.js';
import { selectionKeyForBot } from '../setup/cli-selection.js';

/** These values belong to the CALLER's CLI session, not the dispatch target. */
const CLAUDE_CALLER_IDENTITY_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
] as const;

const noProbe = async (): Promise<readonly string[] | null> => null;

/**
 * Build the dispatch launch validator without borrowing the source session's
 * Claude account. Unlike daemon/Dashboard probes, this CLI's process.env is not
 * the target worker's environment baseline. Session markers cannot decide
 * whether to trust it either: a caller can unset those while keeping secrets.
 *
 * A native Claude target is probed only when its trusted config supplies either
 * an explicit cliConfigDir, or a complete endpoint+token overlay. Without an
 * explicit root, implicit ~/.claude settings/cache are forbidden as well. All
 * other cases retain dispatch's pre-live-catalogue fail-closed behaviour.
 */
export function createDispatchModelDetector(input: {
  target: BotConfig;
  callerEnv: NodeJS.ProcessEnv;
  adapter: CliAdapter;
}): () => Promise<readonly string[] | null> {
  const { target, callerEnv, adapter } = input;
  const isClaude = target.cliId === 'claude-code';
  // Claude gateways own their model set; the native detector must never run.
  if (isClaude && target.wrapperCli) return noProbe;

  let baseEnv = callerEnv;
  if (isClaude) {
    baseEnv = { ...callerEnv };
    for (const key of CLAUDE_CALLER_IDENTITY_ENV) delete baseEnv[key];
  }
  const key = selectionKeyForBot(target.cliId, target.wrapperCli, target.cliLaunchMode);
  const probe = modelCatalogProbeContext(key, target, baseEnv);
  if (!probe.canProbe) return noProbe;

  if (isClaude) {
    const hasExplicitRoot = Boolean(probe.configDir?.trim());
    const overlay = probe.probeSettingsEnv ?? {};
    const token = (overlay.ANTHROPIC_AUTH_TOKEN ?? overlay.ANTHROPIC_API_KEY)?.trim();
    const hasTrustedEndpoint = Boolean(overlay.ANTHROPIC_BASE_URL?.trim() && token);
    if (!hasExplicitRoot && !hasTrustedEndpoint) return noProbe;
    return () => adapter.detectModels?.({
      env: probe.probeEnv,
      settingsEnv: overlay,
      allowImplicitConfigRoot: hasExplicitRoot,
    }) ?? Promise.resolve(null);
  }

  // Preserve the other CLI adapters' existing dispatch behaviour. The source
  // identity exclusion above is specific to Claude's raw HTTP/file catalogue.
  return () => adapter.detectModels?.({
    env: probe.probeEnv,
    ...(probe.probeSettingsEnv && Object.keys(probe.probeSettingsEnv).length > 0
      ? { settingsEnv: probe.probeSettingsEnv }
      : {}),
  }) ?? Promise.resolve(null);
}
