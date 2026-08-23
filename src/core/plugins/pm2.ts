import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { buildPm2SpawnCommand } from '../../cli/pm2-command.js';
import { scrubPm2CallerEnv } from '../../cli/pm2-env.js';
import { stripPm2GracefulExitMarker } from '../../pm2-graceful-exit.js';

const require = createRequire(import.meta.url);
const BOTMUX_HOME = join(homedir(), '.botmux');
export const PLUGIN_PM2_HOME = join(BOTMUX_HOME, 'pm2');
export const PLUGIN_PM2_PREFIX = 'botmux-plugin-';

export function pluginPm2AppName(pluginId: string): string {
  return `${PLUGIN_PM2_PREFIX}${pluginId}`;
}

function pm2Bin(): string {
  if (process.platform === 'win32') {
    const cmd = join(process.cwd(), 'node_modules', '.bin', 'pm2.cmd');
    if (existsSync(cmd)) return cmd;
  }
  try {
    return require.resolve('pm2/bin/pm2');
  } catch {
    return 'pm2';
  }
}

function pm2Env(extra?: Record<string, string>): NodeJS.ProcessEnv {
  mkdirSync(PLUGIN_PM2_HOME, { recursive: true });
  // Strip the daemon/dashboard graceful-exit sentinel before it rides
  // process.env into a plugin PM2 app (esp. with `pm2 start --update-env`):
  // the plugin service is an arbitrary long-lived process that could launch a
  // foreground botmux, which would then exit 90 on a clean stop. See
  // stripPm2GracefulExitMarker.
  const merged = stripPm2GracefulExitMarker({ ...process.env, ...(extra ?? {}) });
  delete merged.kill_timeout;
  // Plugin PM2 shares the God's PM2_HOME, so this boundary both persists the
  // caller's env into plugin apps AND can create the shared God itself. It
  // therefore applies the SAME caller hygiene as the core pm2 entry
  // (scrubPm2CallerEnv: CLI home pointers, Claude session markers, workflow
  // identity, dashboard H5 credentials — a raw copy would hand that secret to
  // an arbitrary third-party plugin service — plus invoker terminal
  // fingerprints and turn-scoped session identity, with the TERM re-pin), and
  // applies it AFTER the manifest env merge, so a plugin manifest cannot
  // revive a scrubbed key (a service needing its own data root must resolve
  // it internally, not via CLAUDE_CONFIG_DIR/CODEX_HOME).
  scrubPm2CallerEnv(merged);
  merged.PM2_HOME = PLUGIN_PM2_HOME;
  return merged;
}

export function runPluginPm2(args: string[], opts: { inherit?: boolean; timeoutMs?: number; env?: Record<string, string> } = {}): void {
  const pm2 = buildPm2SpawnCommand(pm2Bin(), args);
  const result = spawnSync(pm2.command, pm2.args, {
    stdio: opts.inherit === false ? 'pipe' : 'inherit',
    env: pm2Env(opts.env),
    shell: pm2.shell ?? false,
    timeout: opts.timeoutMs,
  });
  if (result.status !== 0) {
    const detail = result.error?.message
      ?? ((result.stderr ? String(result.stderr).trim() : '') || `status ${result.status}`);
    throw new Error(`pm2 ${args.join(' ')} failed: ${detail}`);
  }
}

export function capturePluginPm2(args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): string {
  const pm2 = buildPm2SpawnCommand(pm2Bin(), args);
  const result = spawnSync(pm2.command, pm2.args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: pm2Env(opts.env),
    shell: pm2.shell ?? false,
    timeout: opts.timeoutMs ?? 10_000,
    // `pm2 jlist` output scales with the process count (full env per process);
    // Node's 1 MiB default spawnSync buffer overflows to ENOBUFS on large
    // fleets. Match cli.ts pm2Capture — lift the cap far above any real size.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = result.error?.message
      ?? ((result.stderr ? String(result.stderr).trim() : '') || `status ${result.status}`);
    throw new Error(`pm2 ${args.join(' ')} failed: ${detail}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}
