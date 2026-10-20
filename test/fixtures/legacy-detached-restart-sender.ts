// Frozen from src/core/maintenance.ts at upstream 7db4b936. Keep this fixture
// independent of the current implementation so old -> new compatibility tests
// fail if either side's handoff contract drifts.
const LEGACY_DETACHED_RESTART_KEYS = [
  'WEB_EXTERNAL_HOST',
  'BOTMUX_DASHBOARD_EXTERNAL_HOST',
  'BOTMUX_DASHBOARD_HOST',
  'BOTMUX_DASHBOARD_PORT',
  'BOTMUX_DAEMON_IPC_BASE_PORT',
  'BOTMUX_DASHBOARD_PUBLIC_READONLY',
  'BOTMUX_PUBLIC_URL',
  'BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH',
  'BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS',
  'BOTMUX_DEVBOX_AUTO_EXPORT',
] as const;

export function legacyDetachedRestartEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of LEGACY_DETACHED_RESTART_KEYS) delete env[key];
  return env;
}
