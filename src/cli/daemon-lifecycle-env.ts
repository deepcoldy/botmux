import { parse } from 'dotenv';

// Keys baked into the PM2 env block (see ecosystemConfig in cli.ts). This list
// MUST stay mirrored by detachedRestartEnv() in src/core/maintenance.ts: any key
// added here also has to be stripped there, or a detached restart (dashboard
// update/restart, maintenance auto-update) reuses the stale baked value instead
// of reloading it from ~/.botmux/.env.
const DAEMON_ENV_KEYS = [
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
  // Credential-root redirect (multi-tenant hosts where ~/.botmux's ancestor
  // chain fails secure-host-file). Baked so the daemon's breadcrumb write and
  // every managed process agree with the shell that started them.
  'BOTMUX_CREDENTIALS_DIR',
] as const;

/**
 * Pin both PM2 apps to one deterministic ~/.botmux/.env snapshot. A restart
 * launched inside a botmux session inherited its values from the old daemon,
 * so only the persisted file is authoritative in that context.
 */
export function resolveDaemonEnv(
  inheritedEnv: NodeJS.ProcessEnv,
  envFileText?: string,
): Record<(typeof DAEMON_ENV_KEYS)[number], string> {
  const fileEnv = envFileText === undefined ? {} : parse(envFileText);
  const sessionOrigin = Boolean(inheritedEnv.BOTMUX_SESSION_ID?.trim());
  const resolve = (key: (typeof DAEMON_ENV_KEYS)[number]): string => {
    const value = sessionOrigin ? fileEnv[key] : inheritedEnv[key] ?? fileEnv[key];
    return value?.trim() ?? '';
  };

  return {
    WEB_EXTERNAL_HOST: resolve('WEB_EXTERNAL_HOST'),
    BOTMUX_DASHBOARD_EXTERNAL_HOST: resolve('BOTMUX_DASHBOARD_EXTERNAL_HOST'),
    BOTMUX_DASHBOARD_HOST: resolve('BOTMUX_DASHBOARD_HOST') || '0.0.0.0',
    BOTMUX_DASHBOARD_PORT: resolve('BOTMUX_DASHBOARD_PORT'),
    BOTMUX_DAEMON_IPC_BASE_PORT: resolve('BOTMUX_DAEMON_IPC_BASE_PORT'),
    BOTMUX_DASHBOARD_PUBLIC_READONLY: resolve('BOTMUX_DASHBOARD_PUBLIC_READONLY'),
    BOTMUX_PUBLIC_URL: resolve('BOTMUX_PUBLIC_URL'),
    BOTMUX_CREDENTIALS_DIR: resolve('BOTMUX_CREDENTIALS_DIR'),
  };
}
