import { parse } from 'dotenv';

// Settings pinned into the environment used to launch the fleet supervisor.
// A detached sender resolves the persisted file before launch and carries the
// allowlisted snapshot in ordinary lifecycle keys, which both old and new
// receivers understand. A new receiver authenticates that fallback by binding
// the restart lease, then re-reads the file so loaded/missing remains current.
//
// This resolved block is SHARED: the same values land in the env of the
// supervisor, dashboard, and every bot daemon. Only non-secret settings belong
// here.
//
// The Dashboard Feishu H5 login family (BOTMUX_DASHBOARD_FEISHU_H5_*, incl. the
// APP_SECRET credential) is DELIBERATELY absent: the dashboard receives it via
// its own entry point — index-dashboard.ts dotenv-loads ~/.botmux/.env, exactly
// like the bot daemons' index-daemon.ts — so the secret never enters the shared
// fleet env. Do not re-add those keys;
// test/daemon-lifecycle-env.test.ts pins the exclusion, and utils/child-env.ts
// (stripDashboardH5Env / redactChildEnv) keeps the family out of the daemon
// process and every CLI child.
export const DAEMON_ENV_KEYS = [
  'WEB_HOST',
  'WEB_EXTERNAL_HOST',
  'WEB_EXTERNAL_PORT',
  'BOTMUX_WEB_PROXY_BASE_PORT',
  // Per-session terminal listener. Keep both names in the lifecycle snapshot:
  // the canonical key takes precedence, while BOTMUX_WORKER_HOST remains a
  // supported legacy alias. Both must be cleared on restart so a stale
  // canonical value cannot shadow a freshly persisted alias.
  'BOTMUX_WORKER_HTTP_HOST',
  'BOTMUX_WORKER_HOST',
  'BOTMUX_DASHBOARD_EXTERNAL_HOST',
  'BOTMUX_DASHBOARD_HOST',
  'BOTMUX_DASHBOARD_PORT',
  'BOTMUX_DAEMON_IPC_BASE_PORT',
  'BOTMUX_DASHBOARD_PUBLIC_READONLY',
  // Self-hosted reverse-proxy base for terminal/dashboard links
  // (publicReverseProxyBaseUrl). Left out of this list it only survived as
  // long as every restart came from a shell that exported it — one restart
  // from a bot session (whose pane wrapper unsets BOTMUX_*) silently demoted
  // all web-terminal links back to raw ip:port.
  'BOTMUX_PUBLIC_URL',
  // Dashboard-only, non-secret settings: the control-audit destination
  // (dashboard/control-audit.ts defaultControlAuditPath) and the terminal
  // takeover lease TTL (dashboard/terminal-control.ts terminalControlTtlFromEnv).
  // Documented in .env.example, but without a resolved value an operator pointing
  // the audit log at /var/lib/botmux kept writing to ~/.botmux/audit instead
  // ("configured but never took effect"). Resolved values also outrank the
  // dashboard's own dotenv load (dotenv never overrides existing vars), which
  // keeps them on the deterministic resolveDaemonEnv snapshot semantics.
  'BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH',
  'BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS',
  // Merlin Devbox auto-export switch (platform/devbox-dashboard-export.ts).
  // The dashboard resolves it (dashboard-url / control-csrf run there), so it
  // has to survive the allowlist copy — same reason BOTMUX_PUBLIC_URL is here.
  // The CLI, which is the side that spawns merlin-cli, has no dotenv step at
  // all and reads the key straight from ~/.botmux/.env instead.
  'BOTMUX_DEVBOX_AUTO_EXPORT',
] as const;

export type DaemonEnvKey = (typeof DAEMON_ENV_KEYS)[number];

/**
 * Pin the supervised fleet to one deterministic ~/.botmux/.env snapshot. A restart
 * launched inside a botmux session inherited its values from the old daemon,
 * so only the persisted file is authoritative in that context.
 *
 * Every key resolves to a string, empty when neither source sets it. Each
 * consumer treats the empty string as "unset" and applies its own default
 * (h5-auth's ENABLED/BRAND/TTL/SECURE_COOKIE parsing, control-audit's path
 * fallback, terminal-control's TTL validation), so a blank resolved value is
 * indistinguishable from an absent one — except for the terminal and dashboard
 * bind hosts, whose historical defaults are applied here.
 */
export function resolveDaemonEnv(
  inheritedEnv: NodeJS.ProcessEnv,
  envFileText?: string,
  refreshPersistedEnv = Boolean(inheritedEnv.BOTMUX_SESSION_ID?.trim()),
): Record<DaemonEnvKey, string> {
  const fileEnv = envFileText === undefined ? {} : parse(envFileText);
  const resolve = (key: DaemonEnvKey): string => {
    const value = refreshPersistedEnv ? fileEnv[key] : inheritedEnv[key] ?? fileEnv[key];
    return value?.trim() ?? '';
  };

  // Derived from DAEMON_ENV_KEYS rather than hand-listed: the previous literal
  // return object was a second place to forget a key.
  const resolved = Object.fromEntries(
    DAEMON_ENV_KEYS.map(key => [key, resolve(key)]),
  ) as Record<DaemonEnvKey, string>;
  resolved.WEB_HOST ||= '0.0.0.0';

  // Normalize the legacy worker-host alias into the canonical key before this
  // snapshot is inherited by the supervisor and every daemon. Returning an
  // empty canonical key alongside a populated alias would suppress the alias:
  // getConfiguredWorkerHttpHost deliberately gives the canonical name priority.
  // For ordinary shell starts this ordering reproduces dotenv's no-override
  // behavior per key, followed by the worker resolver's canonical-key priority.
  const workerHost = refreshPersistedEnv
    ? fileEnv.BOTMUX_WORKER_HTTP_HOST ?? fileEnv.BOTMUX_WORKER_HOST
    : inheritedEnv.BOTMUX_WORKER_HTTP_HOST
      ?? fileEnv.BOTMUX_WORKER_HTTP_HOST
      ?? inheritedEnv.BOTMUX_WORKER_HOST
      ?? fileEnv.BOTMUX_WORKER_HOST;
  resolved.BOTMUX_WORKER_HTTP_HOST = workerHost?.trim() || '0.0.0.0';
  resolved.BOTMUX_WORKER_HOST = '';
  resolved.BOTMUX_DASHBOARD_HOST ||= '0.0.0.0';
  return resolved;
}
