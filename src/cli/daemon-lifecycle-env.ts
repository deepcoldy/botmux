import { parse } from 'dotenv';

// Keys baked into the PM2 env block (see ecosystemConfig in cli.ts). This list
// MUST stay mirrored by detachedRestartEnv() in src/core/maintenance.ts: any key
// added here also has to be stripped there, or a detached restart (dashboard
// update/restart, maintenance auto-update) reuses the stale baked value instead
// of reloading it from ~/.botmux/.env. test/maintenance.test.ts pins that
// mirror by iterating this exported list.
//
// This baked block is SHARED: the same resolved values land in the env of the
// dashboard AND of every bot daemon, and they persist on disk in
// ~/.botmux/ecosystem.config.json. Only non-secret settings belong here.
//
// The Dashboard Feishu H5 login family (BOTMUX_DASHBOARD_FEISHU_H5_*, incl. the
// APP_SECRET credential) is DELIBERATELY absent: the dashboard receives it via
// its own entry point — index-dashboard.ts dotenv-loads ~/.botmux/.env, exactly
// like the bot daemons' index-daemon.ts — so the secret never enters the shared
// env block and never lands in ecosystem.config.json. Do not re-add those keys;
// test/daemon-lifecycle-env.test.ts pins the exclusion, and utils/child-env.ts
// (stripDashboardH5Env / redactChildEnv) keeps the family out of the daemon
// process and every CLI child.
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
  // Dashboard-only, non-secret settings: the control-audit destination
  // (dashboard/control-audit.ts defaultControlAuditPath) and the terminal
  // takeover lease TTL (dashboard/terminal-control.ts terminalControlTtlFromEnv).
  // Documented in .env.example, but without a baked value an operator pointing
  // the audit log at /var/lib/botmux kept writing to ~/.botmux/audit instead
  // ("configured but never took effect"). Baked values also outrank the
  // dashboard's own dotenv load (dotenv never overrides existing vars), which
  // keeps them on the deterministic resolveDaemonEnv snapshot semantics.
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
