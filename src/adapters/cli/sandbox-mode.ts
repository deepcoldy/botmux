/**
 * Sandbox mode tri-state: the per-bot/per-session selection shared by config
 * parsing (bot-registry), the session freeze (worker-pool), the worker spawn
 * decision and the dashboard writer.
 *
 *   off     — no local file isolation
 *   oncall  — deny-by-default FsPolicy whitelist (confidentiality; the 2026-07
 *             model, see docs/file-sandbox.md)
 *   scratch — full-root COW overlay, throwaway (integrity/recoverability;
 *             Linux only, see docs/design/2026-09-21-sandbox-scratch-mode.md)
 *
 * The bots.json field historically was a boolean; it is read as
 * `boolean | SandboxModeString` and normalised here. Nothing downstream should
 * re-interpret the raw value.
 */

export type SandboxMode = 'off' | 'oncall' | 'scratch';
export type SandboxConfigValue = boolean | SandboxMode;

export const SCRATCH_STORAGE_VALUES = ['tmpfs', 'disk'] as const;
export type ScratchStorageValue = (typeof SCRATCH_STORAGE_VALUES)[number];

/** Normalise the per-bot `sandbox` config value. `true` keeps its historical
 *  meaning (oncall). Anything unrecognised throws: a typo'd mode must never
 *  silently run the bot without isolation. */
export function normalizeSandboxMode(raw: unknown): SandboxMode {
  if (raw === undefined || raw === null || raw === false) return 'off';
  if (raw === true) return 'oncall';
  if (raw === 'off' || raw === 'oncall' || raw === 'scratch') return raw;
  throw new Error(`invalid sandbox mode: ${JSON.stringify(raw)} (expected true/false or "off"|"oncall"|"scratch")`);
}

/** Whether the mode wraps the CLI in ANY local file sandbox. */
export function sandboxIsActive(mode: SandboxMode): boolean {
  return mode !== 'off';
}

/** Whether a raw boolean-style `sandbox === true` check (legacy call sites that
 *  mean "ANY sandbox engaged") holds for the mode. */
export function sandboxBoolValue(raw: unknown): boolean {
  return sandboxIsActive(normalizeSandboxMode(raw));
}

/**
 * Resolve the effective mode for a spawn from the bot config, the legacy
 * readIsolation flag and the BOTMUX_SANDBOX env override. Env wins when set to
 * an active mode (it is the operator's global test/force switch); the legacy
 * flag implies oncall like its auto-migration does.
 */
export function resolveSandboxMode(input: {
  configSandbox?: unknown;
  readIsolation?: boolean;
  envValue?: string | undefined;
}): SandboxMode {
  if (input.envValue !== undefined && input.envValue !== '') {
    return envSandboxMode(input.envValue);
  }
  if (input.readIsolation === true) return 'oncall';
  return normalizeSandboxMode(input.configSandbox);
}

/**
 * Resolve the BOTMUX_SANDBOX env override.
 *   unset/'0'/'false'/'' → off
 *   '1'/'oncall'         → oncall (BOTMUX_SANDBOX=1 stays backwards compatible)
 *   'scratch'            → scratch
 * Any other value fails CLOSED with a throw (never silently off).
 */
export function envSandboxMode(raw: string | undefined): SandboxMode {
  if (raw === undefined || raw === '' || raw === '0' || raw === 'false') return 'off';
  if (raw === '1' || raw === 'oncall') return 'oncall';
  if (raw === 'scratch') return 'scratch';
  throw new Error(`invalid BOTMUX_SANDBOX value: ${JSON.stringify(raw)} (expected 1, "oncall" or "scratch")`);
}

/** Validate/normalise the scratch storage sub-option. */
export function normalizeScratchStorage(raw: unknown): ScratchStorageValue {
  if (raw === undefined || raw === null) return 'tmpfs';
  if (raw === 'tmpfs' || raw === 'disk') return raw;
  throw new Error(`invalid scratchStorage: ${JSON.stringify(raw)} (expected "tmpfs" or "disk")`);
}
