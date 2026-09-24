import { config as dotenvConfig } from 'dotenv';

// Frozen receiver boundary from upstream 7db4b936: the old supervisor inherited
// the driver's ordinary env and dotenv loaded without override. It intentionally
// ignores all internal fields introduced by the new handoff protocol.
const envFile = process.argv[2];
if (!envFile) throw new Error('env file path is required');
// Upstream cmdRestart consumed these before spawning the old supervisor.
delete process.env.BOTMUX_RESTART_LEASE_ID;
delete process.env.BOTMUX_RESTART_LEASE_DIR;
dotenvConfig({ path: envFile, quiet: true });
const output: Record<string, unknown> = {
  WEB_HOST: process.env.WEB_HOST,
  WEB_EXTERNAL_PORT: process.env.WEB_EXTERNAL_PORT,
  BOTMUX_WEB_PROXY_BASE_PORT: process.env.BOTMUX_WEB_PROXY_BASE_PORT,
};
if (process.argv.includes('--inspect-internal')) {
  output.internalRestartKeys = Object.keys(process.env)
    .filter(key => [
      'BOTMUX_INTERNAL_REFRESH_DAEMON_ENV',
      'BOTMUX_INTERNAL_RESTART_ENV_FALLBACK',
      'BOTMUX_RESTART_LEASE_ID',
      'BOTMUX_RESTART_LEASE_DIR',
    ].includes(key))
    .sort();
}
process.stdout.write(JSON.stringify(output));
