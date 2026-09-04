import { DAEMON_ENV_KEYS, type DaemonEnvKey } from '../cli/daemon-lifecycle-env.js';

export const DETACHED_RESTART_ENV_REFRESH = 'BOTMUX_INTERNAL_REFRESH_DAEMON_ENV';
export const DETACHED_RESTART_ENV_FALLBACK = 'BOTMUX_INTERNAL_RESTART_ENV_FALLBACK';

export type RestartEnvFallback = Partial<Record<DaemonEnvKey, string>>;

function lifecycleSnapshot(env: NodeJS.ProcessEnv): RestartEnvFallback {
  return Object.fromEntries(
    DAEMON_ENV_KEYS
      .filter((key) => typeof env[key] === 'string')
      .map((key) => [key, env[key] as string]),
  ) as RestartEnvFallback;
}

/** Copy only non-secret fleet lifecycle settings into the detached handoff. */
export function captureDetachedRestartEnvFallback(env: NodeJS.ProcessEnv): RestartEnvFallback {
  return lifecycleSnapshot(env);
}

/** Backward-compatible marker helper for callers that only need the old boolean. */
export function consumeDetachedRestartEnvRefresh(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const refresh = Boolean(env[DETACHED_RESTART_ENV_REFRESH]?.trim());
  delete env[DETACHED_RESTART_ENV_REFRESH];
  return refresh;
}

/** No long-lived fleet member needs either one-shot handoff field. */
export function scrubDetachedRestartEnvRefresh(env: NodeJS.ProcessEnv): void {
  delete env[DETACHED_RESTART_ENV_REFRESH];
  delete env[DETACHED_RESTART_ENV_FALLBACK];
}
