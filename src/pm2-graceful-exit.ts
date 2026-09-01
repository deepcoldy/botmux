/**
 * PM2 only receives an exit code plus a signal. For signal exits Node reports
 * a null code, which PM2 normalizes to 0 before applying `stop_exit_codes`.
 * Therefore 0 cannot safely mean "intentional shutdown" for a PM2-managed
 * process: SIGKILL would be mistaken for a clean stop and never restarted.
 */
// Keep the sentinel outside POSIX sysexits (64-78) and signal-derived 128+N.
export const PM2_GRACEFUL_EXIT_CODE = 90;
export const PM2_GRACEFUL_EXIT_CODE_ENV = 'BOTMUX_PM2_GRACEFUL_EXIT_CODE';

export function pm2ManagedExitConfig(): {
  stopExitCodes: number[];
  env: Record<string, string>;
} {
  return {
    stopExitCodes: [PM2_GRACEFUL_EXIT_CODE],
    env: { [PM2_GRACEFUL_EXIT_CODE_ENV]: String(PM2_GRACEFUL_EXIT_CODE) },
  };
}

/** Only an explicit Botmux fleet stop may suppress PM2 autorestart. */
export function gracefulProcessExitCode(
  suppressPm2Restart: boolean,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return suppressPm2Restart
    && env[PM2_GRACEFUL_EXIT_CODE_ENV] === String(PM2_GRACEFUL_EXIT_CODE)
    ? PM2_GRACEFUL_EXIT_CODE
    : 0;
}

/**
 * Strip the graceful-exit sentinel from an env destined for a child/spawned
 * process, returning a fresh shallow copy (never mutates the input). Only the
 * two PM2-managed cores (daemon.ts, dashboard.ts) may see this marker;
 * anything they fork/spawn that inherits it — a worker, a CLI child, a plugin
 * PM2 app, a local terminal — could re-launch a foreground `botmux` and then
 * exit 90 on a clean stop, which a supervisor misreads as a crash. Boundaries
 * that copy raw `process.env` (pm2Env, spawnDetached) call this; boundaries
 * with a key deny-list (redactChildEnv, workerForkEnv) list the key there
 * instead. Always returns a new object so callers can safely mutate the result
 * (e.g. delete other keys) without touching process.env.
 */
export function stripPm2GracefulExitMarker(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next[PM2_GRACEFUL_EXIT_CODE_ENV];
  return next;
}
