import type { CliRuntimeConfig, CliRuntimeSnapshot } from '../adapters/cli/runtime.js';

type RuntimeDisplaySession = {
  agentFrozen?: boolean;
  cliRuntime?: CliRuntimeSnapshot;
  cliPathOverride?: string;
};

/** Return a distribution label only for an explicitly configured runtime. */
export function configuredRuntimeDisplayName(
  runtime: CliRuntimeConfig | CliRuntimeSnapshot | null | undefined,
): string | undefined {
  if (!runtime) return undefined;
  if ('source' in runtime && runtime.source !== 'configured') return undefined;
  return runtime.displayName?.trim() || runtime.id;
}

/**
 * Resolve the custom distribution label for a session without relabelling
 * historical state after a bot-level hot switch.
 *
 * A partially stamped legacy session can still have `agentFrozen !== true`.
 * Its own runtime/path is authoritative, so only a completely unstamped
 * session may borrow the live bot runtime before the first worker fork.
 */
export function sessionConfiguredRuntimeDisplayName(
  session: RuntimeDisplaySession,
  liveRuntime?: CliRuntimeConfig,
): string | undefined {
  const frozen = configuredRuntimeDisplayName(session.cliRuntime);
  if (frozen) return frozen;
  if (
    session.agentFrozen
    || session.cliRuntime !== undefined
    || session.cliPathOverride !== undefined
  ) {
    return undefined;
  }
  return configuredRuntimeDisplayName(liveRuntime);
}
