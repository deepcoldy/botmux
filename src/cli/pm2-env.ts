import {
  scrubClaudeSessionMarkerEnv,
  scrubSessionCliHomeEnv,
  scrubWorkflowWorkerEnv,
  stripDashboardH5Env,
} from '../utils/child-env.js';

/**
 * Scrub the env handed to a pm2 invocation, in place.
 *
 * pm2 persists the CALLER's environment into every managed app it starts or
 * restarts — and into dump.pm2, which `pm2 resurrect` replays after a reboot,
 * bypassing this function entirely. So anything left here is not just handed to
 * the fleet, it is written to disk under ~/.botmux/pm2 and readable from
 * `pm2 describe` / `pm2 jlist` output for as long as that dump survives.
 *
 * Extracted from cli.ts's pm2Env() so the resulting env is assertable in a test
 * (cli.ts is a multi-thousand-line command module with top-level side effects).
 */
export function scrubPm2CallerEnv(env: NodeJS.ProcessEnv): void {
  // A `botmux start/restart` invoked from ANY process that carries a
  // session-level CLI home pointer — most commonly a bot's own session during
  // self-upgrade, whose env holds its injected CLAUDE_CONFIG_DIR — would poison
  // ALL workers, making every non-isolated bot read/write a sibling bot's home.
  // Strip at this boundary so the daemon stays session-agnostic; daemon/worker
  // boot scrub the same keys against stale dumps (see SESSION_CLI_HOME_ENV_KEYS
  // for the full story, including why GROK_HOME is exempt and why deleting
  // beats pinning a default).
  scrubSessionCliHomeEnv(env);
  // Claude session markers ride the same pm2 env-persistence vector; baked in
  // they eventually flip transcript saving off fleet-wide once the tmux server
  // respawns from a poisoned daemon (see CLAUDE_SESSION_MARKER_ENV_KEYS).
  scrubClaudeSessionMarkerEnv(env);
  // Workflow/goal markers identify one short-lived node worker. Persisting
  // them in PM2 would make every daemon — and then every ordinary chat worker
  // it forks — run in workflow mode after a restart initiated from that node.
  scrubWorkflowWorkerEnv(env);
  // Dashboard-only Feishu H5 login family (BOTMUX_DASHBOARD_FEISHU_H5_*,
  // APP_SECRET included). It is deliberately kept OUT of the baked PM2 env
  // block (DAEMON_ENV_KEYS) so it never lands in ecosystem.config.json — but
  // that is defeated if it rides in through the caller instead: `botmux
  // restart` issued from the dashboard process (update/restart button) or from
  // a shell that exported the family would bake the app secret into every
  // managed app's pm2 metadata and into dump.pm2. The dashboard has the one
  // legitimate consumer and loads the family itself (index-dashboard.ts), so
  // nothing needs it here.
  stripDashboardH5Env(env);
}

/** Build the env for a pm2 invocation with an isolated PM2_HOME. */
export function pm2CallerEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PM2_HOME: home };
  scrubPm2CallerEnv(env);
  return env;
}
