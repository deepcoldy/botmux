export const BOTMUX_CAPABILITIES_SCHEMA_VERSION = 1 as const;

export interface BotmuxCapabilitiesDocument {
  schemaVersion: typeof BOTMUX_CAPABILITIES_SCHEMA_VERSION;
  capabilities: {
    exact_chat_grant_v1: true;
    stable_app_dispatch_v1: true;
    stable_dispatch_acceptance_v1: true;
    managed_activation_v2: true;
  };
}

const USAGE = '用法: botmux capabilities --json';

export function parseCapabilitiesArgs(
  args: string[],
): { ok: true } | { ok: false; error: string } {
  return args.length === 1 && args[0] === '--json'
    ? { ok: true }
    : { ok: false, error: USAGE };
}

/**
 * Static protocol declaration for control-plane preflight.
 *
 * This deliberately reads no config or runtime state: it declares capabilities
 * of this exact botmux build and is safe to call before daemon activation.
 */
export function botmuxCapabilities(): BotmuxCapabilitiesDocument {
  return {
    schemaVersion: BOTMUX_CAPABILITIES_SCHEMA_VERSION,
    capabilities: {
      exact_chat_grant_v1: true,
      stable_app_dispatch_v1: true,
      stable_dispatch_acceptance_v1: true,
      managed_activation_v2: true,
    },
  };
}
