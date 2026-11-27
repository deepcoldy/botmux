/**
 * Core profile of a native gateway's dedicated core, replaced while it runs.
 *
 * A core-only service synthesizes its one apiOnly bot from five environment
 * keys (bot-registry maybeSynthesizeCoreOnlyConfig). A native gateway sends a
 * new value for all of them (NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS) when its
 * configuration changes, and this module applies it the way a core started on
 * that environment would have it, in two steps:
 *
 *  1. validate the whole candidate: the same synthesis the core ran at boot, on
 *     a copy of the process environment carrying the candidate values. Any
 *     failure rejects the request and changes nothing;
 *  2. commit synchronously, with nothing left that can throw: the registered
 *     bot's config is replaced in place, then the five keys are written into
 *     `process.env`, so every later `loadBotConfigs()` and every worker forked
 *     from now on (its environment is built from `process.env` at fork time)
 *     synthesizes the same values.
 *
 * New sessions use the new settings. Sessions already running keep what they
 * froze at launch, except when the CLI changed: the IPC route that applies a
 * profile (core/dashboard-ipc-server.ts, the only caller; it exists only in a
 * native gateway core) then closes the sessions still on the previous CLI
 * before it answers — running turns included — with the sweep a Feishu bot's
 * Agent save runs (closeCliMismatchedSessionsForBot). A change of the model,
 * directory or any other setting closes nothing. This module only validates
 * and commits.
 */
import { isAbsolute } from 'node:path';
import { ALL_CLI_IDS } from '../adapters/cli/registry.js';
import { replaceCoreOnlyBotConfig, synthesizeCoreOnlyBotConfig } from '../bot-registry.js';
import {
  NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS,
  type NativeGatewayCoreProfile,
  type NativeGatewayCoreProfileEnvKey,
} from './native-gateway-contract.js';

/** Keys every request carries; only BOTMUX_CORE_MODEL may be absent. */
const REQUIRED_KEYS: readonly NativeGatewayCoreProfileEnvKey[] = [
  'BOTMUX_CORE_CLI',
  'BOTMUX_CORE_BACKEND',
  'BOTMUX_CORE_WORKING_DIR',
  'BOTMUX_CORE_BOT_CONFIG',
];

/** Bound of one value; a bot profile is the only large one. */
const MAX_VALUE_BYTES = 256 * 1024;

export type NativeGatewayCoreProfileResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: 'invalid_core_profile' };

function candidateProfile(body: unknown): NativeGatewayCoreProfile | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const outer = body as Record<string, unknown>;
  if (Object.keys(outer).length !== 1 || !outer.env || typeof outer.env !== 'object' || Array.isArray(outer.env)) {
    return undefined;
  }
  const env = outer.env as Record<string, unknown>;
  const allowed = new Set<string>(NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS);
  for (const [key, value] of Object.entries(env)) {
    if (!allowed.has(key) || typeof value !== 'string' || !value || value.includes('\0')
      || Buffer.byteLength(value) > MAX_VALUE_BYTES) {
      return undefined;
    }
  }
  if (REQUIRED_KEYS.some(key => env[key] === undefined)) return undefined;
  const profile = env as NativeGatewayCoreProfile;
  if (!(ALL_CLI_IDS as readonly string[]).includes(profile.BOTMUX_CORE_CLI!)
    || !isAbsolute(profile.BOTMUX_CORE_WORKING_DIR!)
    || (profile.BOTMUX_CORE_MODEL !== undefined && /[\x00-\x1f]/.test(profile.BOTMUX_CORE_MODEL))) {
    return undefined;
  }
  return profile;
}

/**
 * Validate `body` (a NativeGatewayCoreProfileRequest) as a whole, then commit it
 * for bot `larkAppId`. `env` is the process environment in production; tests
 * pass their own.
 */
export function applyNativeGatewayCoreProfile(
  larkAppId: string,
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): NativeGatewayCoreProfileResult {
  const profile = candidateProfile(body);
  if (!profile) return { ok: false, error: 'invalid_core_profile' };
  const candidate: NodeJS.ProcessEnv = { ...env };
  for (const key of NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS) {
    delete candidate[key];
    if (profile[key] !== undefined) candidate[key] = profile[key];
  }
  let next;
  try {
    next = synthesizeCoreOnlyBotConfig(candidate);
  } catch {
    return { ok: false, error: 'invalid_core_profile' };
  }
  if (next.larkAppId !== larkAppId) return { ok: false, error: 'invalid_core_profile' };
  if (NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS.every(key => env[key] === candidate[key])) {
    return { ok: true, changed: false };
  }
  try {
    replaceCoreOnlyBotConfig(larkAppId, next);
  } catch {
    // Refused before its first write (see replaceCoreOnlyBotConfig).
    return { ok: false, error: 'invalid_core_profile' };
  }
  for (const key of NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS) {
    if (candidate[key] === undefined) delete env[key];
    else env[key] = candidate[key];
  }
  return { ok: true, changed: true };
}
