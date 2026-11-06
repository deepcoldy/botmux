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

/** Read a session's FROZEN sandbox decision (`Session.sandbox`: true / "oncall" /
 *  "scratch" / false / "off" / undefined) for display. Never throws — a corrupt
 *  persisted value displays as "off" instead of breaking the card / list. */
export function frozenSessionSandboxMode(raw: unknown): SandboxMode {
  try { return normalizeSandboxMode(raw); } catch { return 'off'; }
}

/** The mode a NEW session of this bot would freeze right now — the same rule
 *  as `freezeSessionSandboxDecision` (legacy readIsolation implies oncall). */
export function botConfigSandboxMode(botCfg: { sandbox?: unknown; readIsolation?: boolean }): SandboxMode {
  return botCfg.readIsolation === true ? 'oncall' : normalizeSandboxMode(botCfg.sandbox);
}

/** Session vs. current bot sandbox mismatch for the dashboard badge. Undefined
 *  when the session has not frozen a decision yet (pre-spawn / legacy row), the
 *  two agree, or the bot config is unreadable. */
export function sessionSandboxDrift(
  frozen: unknown,
  botCfg: { sandbox?: unknown; readIsolation?: boolean } | undefined,
): { session: SandboxMode; current: SandboxMode } | undefined {
  if (frozen === undefined || !botCfg) return undefined;
  let current: SandboxMode;
  try { current = botConfigSandboxMode(botCfg); } catch { return undefined; }
  const session = frozenSessionSandboxMode(frozen);
  return session === current ? undefined : { session, current };
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
 * readIsolation flag and the BOTMUX_SANDBOX env override. Precedence:
 *   1. BOTMUX_SANDBOX set to an active mode (1/oncall/scratch) — the operator's
 *      global force switch, applied to every bot;
 *   2. legacy readIsolation → oncall (like its auto-migration);
 *   3. the bot's own `sandbox` config.
 * An inactive env value (unset/''/'0'/'false') means "no force" and falls
 * through: it never turns off a sandbox the bot itself enables. An invalid
 * value still throws.
 */
export function resolveSandboxMode(input: {
  configSandbox?: unknown;
  readIsolation?: boolean;
  envValue?: string | undefined;
}): SandboxMode {
  const forced = envSandboxMode(input.envValue);
  if (forced !== 'off') return forced;
  if (input.readIsolation === true) return 'oncall';
  return normalizeSandboxMode(input.configSandbox);
}

/**
 * Resolve the BOTMUX_SANDBOX env override.
 *   unset/'0'/'false'/'' → off (= no force; resolveSandboxMode then follows
 *                          the bot config)
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

/** Network/loopback facts of the spawn a resolved sandbox mode produces.
 *  Computed ONLY in the worker, from the same resolved mode that drives the
 *  actual bwrap/Seatbelt launch, and reported to the daemon as the single
 *  source of truth for the identity storage model. */
export interface SpawnNetworkShape {
  /** A local sandbox actually wraps the spawned CLI (resolved mode !== 'off'
   *  on a backend with a local process). */
  sandboxEngaged: boolean;
  /** The `net` flag handed to the sandbox constructor; false compiles to
   *  bwrap `--unshare-net`. */
  netEnabled: boolean;
  /** Whether the daemon's loopback endpoint is reachable from INSIDE the
   *  spawned sandbox. False under `--unshare-net` and under the slirp network
   *  policy, whose proxy namespace does not share host loopback. */
  loopbackShared: boolean;
}

/** Derive the spawn network shape from the RESOLVED mode and the frozen
 *  session network inputs. The two booleans are split on purpose: the slirp
 *  policy launches with networking ON (`netEnabled: true`) while the host
 *  loopback is still not reachable (`loopbackShared: false`). */
export function resolveSpawnNetworkShape(input: {
  mode: SandboxMode;
  sandboxNetwork?: boolean;
  sandboxNetworkPolicy?: unknown;
}): SpawnNetworkShape {
  if (input.mode === 'off') {
    return { sandboxEngaged: false, netEnabled: false, loopbackShared: true };
  }
  // networkPolicySupportError rejects a policy everywhere except oncall/pty;
  // the oncall slirp arm proxies networking but does not share host loopback.
  if (input.mode === 'oncall' && input.sandboxNetworkPolicy !== undefined) {
    return { sandboxEngaged: true, netEnabled: true, loopbackShared: false };
  }
  const netEnabled = input.sandboxNetwork !== false;
  return { sandboxEngaged: true, netEnabled, loopbackShared: netEnabled };
}

/** Validate/normalise the scratch storage sub-option. */
export function normalizeScratchStorage(raw: unknown): ScratchStorageValue {
  if (raw === undefined || raw === null) return 'tmpfs';
  if (raw === 'tmpfs' || raw === 'disk') return raw;
  throw new Error(`invalid scratchStorage: ${JSON.stringify(raw)} (expected "tmpfs" or "disk")`);
}
