import { parse } from 'dotenv';

// Keys baked into the PM2 env block (see ecosystemConfig in cli.ts). This list
// MUST stay mirrored by detachedRestartEnv() in src/core/maintenance.ts: any key
// added here also has to be stripped there, or a detached restart (dashboard
// update/restart, maintenance auto-update) reuses the stale baked value instead
// of reloading it from ~/.botmux/.env. test/maintenance.test.ts pins that
// mirror by iterating this exported list.
//
// Being on this list is what makes a ~/.botmux/.env setting reach the DASHBOARD
// at all: `botmux-dashboard` is a separate PM2 app and, unlike the bot daemons
// (index-daemon.ts dotenv-loads the file), it only ever sees the env block baked
// here. A dashboard-only setting left off this list silently falls back to its
// built-in default no matter what the operator wrote in .env.
export const DAEMON_ENV_KEYS = [
  'WEB_EXTERNAL_HOST',
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
  // Dashboard Feishu H5 passwordless login — the complete set read by
  // resolveDashboardH5AuthConfig() in src/dashboard/h5-auth.ts. Missing here,
  // a fully configured .env still produced `enabled:false` in the dashboard
  // process (H5 entry 404), and the TTL / Secure-cookie / allowlist knobs all
  // silently fell back to their defaults. The APP_SECRET is a real credential:
  // it reaches only the managed PM2 apps, and utils/child-env.ts redacts the
  // whole BOTMUX_DASHBOARD_FEISHU_H5_ prefix at every CLI-child boundary.
  'BOTMUX_DASHBOARD_FEISHU_H5_ENABLED',
  'BOTMUX_DASHBOARD_FEISHU_H5_BRAND',
  'BOTMUX_DASHBOARD_FEISHU_H5_APP_ID',
  'BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET',
  'BOTMUX_DASHBOARD_FEISHU_H5_ALLOWED_OPEN_IDS',
  'BOTMUX_DASHBOARD_FEISHU_H5_ENTRY_PATH',
  'BOTMUX_DASHBOARD_FEISHU_H5_SESSION_TTL_MS',
  'BOTMUX_DASHBOARD_FEISHU_H5_SECURE_COOKIE',
  // Same dashboard-only class as the H5 family: the control-audit destination
  // (dashboard/control-audit.ts defaultControlAuditPath) and the terminal
  // takeover lease TTL (dashboard/terminal-control.ts terminalControlTtlFromEnv).
  // Documented in .env.example, but without a baked value an operator pointing
  // the audit log at /var/lib/botmux kept writing to ~/.botmux/audit instead.
  'BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH',
  'BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS',
] as const;

export type DaemonEnvKey = (typeof DAEMON_ENV_KEYS)[number];

/**
 * Pin both PM2 apps to one deterministic ~/.botmux/.env snapshot. A restart
 * launched inside a botmux session inherited its values from the old daemon,
 * so only the persisted file is authoritative in that context.
 *
 * Every key resolves to a string, empty when neither source sets it. Each
 * consumer treats the empty string as "unset" and applies its own default
 * (h5-auth's ENABLED/BRAND/TTL/SECURE_COOKIE parsing, control-audit's path
 * fallback, terminal-control's TTL validation), so a blank baked value is
 * indistinguishable from an absent one — except for the dashboard bind host,
 * whose historical default is applied here.
 */
export function resolveDaemonEnv(
  inheritedEnv: NodeJS.ProcessEnv,
  envFileText?: string,
): Record<DaemonEnvKey, string> {
  const fileEnv = envFileText === undefined ? {} : parse(envFileText);
  const sessionOrigin = Boolean(inheritedEnv.BOTMUX_SESSION_ID?.trim());
  const resolve = (key: DaemonEnvKey): string => {
    const value = sessionOrigin ? fileEnv[key] : inheritedEnv[key] ?? fileEnv[key];
    return value?.trim() ?? '';
  };

  // Derived from DAEMON_ENV_KEYS rather than hand-listed: the previous literal
  // return object was a second place to forget a key.
  const resolved = Object.fromEntries(
    DAEMON_ENV_KEYS.map(key => [key, resolve(key)]),
  ) as Record<DaemonEnvKey, string>;
  resolved.BOTMUX_DASHBOARD_HOST ||= '0.0.0.0';
  return resolved;
}
