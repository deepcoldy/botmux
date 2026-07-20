import { parse } from 'dotenv';

const EXTERNAL_HOST_KEYS = [
  'WEB_EXTERNAL_HOST',
  'BOTMUX_DASHBOARD_EXTERNAL_HOST',
] as const;

/**
 * Pin both PM2 apps to one deterministic external-host snapshot. A lifecycle
 * command launched inside a botmux session inherited its values from the old
 * daemon, so only the persisted .env is authoritative in that context. Empty
 * strings deliberately override PM2's inherited env and mean "auto-detect" in
 * config.ts.
 */
export function resolveDaemonExternalHostEnv(
  inheritedEnv: NodeJS.ProcessEnv,
  envFileText?: string,
): Record<(typeof EXTERNAL_HOST_KEYS)[number], string> {
  const fileEnv = envFileText === undefined ? {} : parse(envFileText);
  const sessionOrigin = Boolean(inheritedEnv.BOTMUX_SESSION_ID?.trim());
  const resolve = (key: (typeof EXTERNAL_HOST_KEYS)[number]): string => {
    const value = sessionOrigin ? fileEnv[key] : inheritedEnv[key] ?? fileEnv[key];
    return value?.trim() ?? '';
  };

  return {
    WEB_EXTERNAL_HOST: resolve('WEB_EXTERNAL_HOST'),
    BOTMUX_DASHBOARD_EXTERNAL_HOST: resolve('BOTMUX_DASHBOARD_EXTERNAL_HOST'),
  };
}
