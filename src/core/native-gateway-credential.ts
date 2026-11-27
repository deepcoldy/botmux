/**
 * The credential a native gateway shares with the one dedicated core it
 * launches (im/wecom/gateway/managed-core.ts).
 *
 * The gateway generates a fresh random value for every core it starts and hands
 * it over in NATIVE_GATEWAY_CORE_CREDENTIAL_ENV. It never touches disk, a log
 * or a state file on either side: the core entry (index-core-only.ts) takes it
 * into this module's memory and removes it from `process.env` before anything
 * else reads the environment, so no worker or CLI session inherits it (the CLI
 * boundary drops the name as well, utils/child-env.ts).
 *
 * The core's IPC server then accepts a request signed with this value as well
 * as one signed with the machine's Dashboard secret, and the routes only the
 * gateway calls (NATIVE_GATEWAY_EXCLUSIVE_ROUTE_PATTERNS) with this value
 * alone. It also requires a signature on the core-only control routes (trigger,
 * its result, exact-turn interrupt, insight, host facts) that a core-only
 * service without this value serves unsigned. Every other process — a Feishu
 * daemon, a bare core-only service — holds none and authenticates exactly as
 * before.
 *
 * Dependency-free apart from the mode decision: the core entry loads it before
 * any config module.
 */
import { isNativeGatewayCoreEnv, isNativeGatewayCoreProcess } from './runtime-mode.js';

/** Environment variable that carries the credential from the gateway to its core. */
export const NATIVE_GATEWAY_CORE_CREDENTIAL_ENV = 'BOTMUX_NATIVE_GATEWAY_CORE_CREDENTIAL';

let held: string | undefined;

/** Same shape as the Dashboard secret: 43 to 256 characters of base64url. */
function wellFormed(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43,256}$/.test(value);
}

/**
 * Take the credential out of `env` (always removed, whatever its value). Kept
 * only for a native gateway core, and only when well formed.
 */
export function takeNativeGatewayCoreCredential(env: NodeJS.ProcessEnv): void {
  const value = env[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV];
  delete env[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV];
  held = isNativeGatewayCoreEnv(env) && wellFormed(value) ? value : undefined;
}

/** The credential this process's gateway signs with; undefined everywhere else. */
export function nativeGatewayCoreCredential(): string | undefined {
  return held && isNativeGatewayCoreProcess() ? held : undefined;
}

/** @internal tests only. */
export function __testOnly_setNativeGatewayCoreCredential(value: string | undefined): void {
  held = value;
}
