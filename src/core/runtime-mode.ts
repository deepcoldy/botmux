/**
 * Runtime mode of a botmux process: an ordinary fleet daemon, a dedicated
 * core-only service, or — a special core-only service — the dedicated core of a
 * native IM gateway (today the managed core `botmux wecom` launches).
 *
 * This module is the only place that turns the mode variables into a decision.
 * The entries that start such a process set them (index-core-only.ts,
 * `botmux serve --api-only`, the gateway's managed-core launcher), and the
 * environment-passing policy in utils/child-env.ts decides which children
 * inherit them; everything else asks here.
 *
 * Read when asked, never cached: index-core-only.ts sets BOTMUX_CORE_ONLY only
 * after its static imports have loaded, and workers and CLI children decide from
 * the environment they inherited (utils/child-env.ts rebuilds it per child), so
 * a value captured at module load could disagree with the process's own env.
 *
 * Dependency-free on purpose: the CLI, workers and the core-only entry all load
 * it early.
 */

/** `'1'` in a dedicated core-only service and the workers it forks. */
export const CORE_ONLY_ENV = 'BOTMUX_CORE_ONLY';

/**
 * `'1'` only in the dedicated core of a native IM gateway (set by the gateway's
 * managed-core launcher) and in that core's workers. Never reaches a CLI child:
 * it is redacted at the CLI boundary (REDACTED_CHILD_ENV_KEYS), so a
 * `botmux serve --api-only` started from inside such a session is a bare core.
 */
export const NATIVE_GATEWAY_CORE_ENV = 'BOTMUX_NATIVE_GATEWAY_CORE';

/**
 * Optional transport-neutral bot profile (JSON) for the single synthetic
 * apiOnly bot of a core-only service (core/core-only-bot-profile.ts). It is
 * configuration, not a mode signal: any core-only service may receive one.
 */
export const CORE_ONLY_BOT_PROFILE_ENV = 'BOTMUX_CORE_BOT_CONFIG';

/** Whether `env` belongs to a dedicated core-only service. */
export function isCoreOnlyEnv(env: NodeJS.ProcessEnv): boolean {
  return env[CORE_ONLY_ENV] === '1';
}

/**
 * Whether `env` belongs to the dedicated core of a native IM gateway, rather
 * than a bare core-only service (`serve --api-only`, riff, or an external core a
 * WeCom configuration points at). That gateway drives every HTTP turn over host
 * HMAC — it polls the core's asks and owns per-session worktrees — so behaviour
 * that needs such a host is gated on this, not on core-only alone.
 */
export function isNativeGatewayCoreEnv(env: NodeJS.ProcessEnv): boolean {
  return isCoreOnlyEnv(env) && env[NATIVE_GATEWAY_CORE_ENV] === '1';
}

/**
 * Absolute path of the customization store a native gateway hands its dedicated
 * core (services/customization-scope.ts: the channel's own store, shared by all
 * of its connections, under the fleet's data dir). Honoured only together with
 * the native gateway mark: in a bare core-only service, or once the mark is
 * redacted at the CLI boundary, the value means nothing and the process keeps
 * its own default store. Carried with the rest of the core-only family
 * (utils/child-env.ts CORE_ONLY_SERVICE_ENV_KEYS) so the core's workers get it.
 */
export const NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV = 'BOTMUX_CORE_CUSTOMIZATION_DIR';

/**
 * The customization store `env` says to resolve prompt overrides from: the
 * handed store in a native gateway core, `undefined` everywhere else (and for a
 * blank or relative value), which keeps the process on its default store.
 */
export function nativeGatewayCustomizationDir(env: NodeJS.ProcessEnv): string | undefined {
  if (!isNativeGatewayCoreEnv(env)) return undefined;
  const dir = env[NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV]?.trim();
  return dir && dir.startsWith('/') ? dir : undefined;
}

/** The raw bot profile handed to a core-only service, if any. */
export function coreOnlyBotProfileJson(env: NodeJS.ProcessEnv): string | undefined {
  return env[CORE_ONLY_BOT_PROFILE_ENV];
}

/** Whether this process is a dedicated core-only service (or one of its workers). */
export function isCoreOnlyProcess(): boolean {
  return isCoreOnlyEnv(process.env);
}

/** Whether this process is a native gateway's dedicated core (or one of its workers). */
export function isNativeGatewayCoreProcess(): boolean {
  return isNativeGatewayCoreEnv(process.env);
}
