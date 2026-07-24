import { parse } from 'dotenv';

const DAEMON_ENV_KEYS = [
  'WEB_EXTERNAL_HOST',
  'BOTMUX_DASHBOARD_EXTERNAL_HOST',
  'BOTMUX_DASHBOARD_HOST',
  'BOTMUX_DASHBOARD_PORT',
  'BOTMUX_DAEMON_IPC_BASE_PORT',
  'BOTMUX_DASHBOARD_PUBLIC_READONLY',
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
  };
}
