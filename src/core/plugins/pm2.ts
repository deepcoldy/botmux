import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPm2SpawnCommand } from '../../cli/pm2-command.js';
import { captureReadonlyPm2Jlist } from '../../cli/pm2-readonly.js';
import { runExistingPm2Command } from '../../cli/pm2-existing.js';
import { scrubPm2CallerEnv } from '../../cli/pm2-env.js';
import { stripPm2GracefulExitMarker } from '../../pm2-graceful-exit.js';
import {
  ExternalPm2GodOwnershipError,
  inspectLinuxPm2Command,
  inspectLinuxPm2ReadonlyTarget,
  type LinuxPm2GodProcess,
} from '../pm2-lifecycle-owner.js';

const require = createRequire(import.meta.url);
const PKG_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
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

function assertPluginPm2MutationOwned() {
  if (process.platform !== 'linux') return undefined;
  const { ownership, plan } = inspectLinuxPm2Command({
    command: 'plugin', home: PLUGIN_PM2_HOME,
  });
  if (plan.kind === 'direct') return { ownership, plan };
  if (plan.kind === 'reject') {
    if (ownership.kind !== 'external') {
      throw new Error('plugin PM2 ownership plan rejected a non-external God');
    }
    throw new ExternalPm2GodOwnershipError(ownership);
  }
  throw new Error('plugin PM2 尚无 botmux.service owner；请先运行 `botmux start`。');
}

function pluginPm2Query(): { available: boolean; expectedGod?: LinuxPm2GodProcess } {
  if (process.platform !== 'linux') return { available: true };
  const target = inspectLinuxPm2ReadonlyTarget(PLUGIN_PM2_HOME);
  if (!target) return { available: false };
  return typeof target === 'object'
    ? { available: true, expectedGod: target }
    : { available: true };
}

export function runPluginPm2(args: string[], opts: { inherit?: boolean; timeoutMs?: number; env?: Record<string, string> } = {}): void {
  const inspection = assertPluginPm2MutationOwned();
  const env = pm2Env(opts.env);
  if (inspection?.ownership.kind === 'owned') {
    if (inspection.ownership.processes.length !== 1) {
      throw new Error(
        `plugin PM2 mutation requires exactly one botmux.service-owned God; found `
        + `${inspection.ownership.processes.map(process => process.pid).join(', ') || 'none'}`,
      );
    }
    runExistingPm2Command({
      pkgRoot: PKG_ROOT,
      home: PLUGIN_PM2_HOME,
      args,
      inherit: opts.inherit,
      timeoutMs: opts.timeoutMs,
      env,
      expectedGod: inspection.ownership.processes[0]!,
    });
    return;
  }
  const pm2 = buildPm2SpawnCommand(pm2Bin(), args);
  const result = spawnSync(pm2.command, pm2.args, {
    stdio: opts.inherit === false ? 'pipe' : 'inherit',
    env,
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
  if (args.length !== 1 || args[0] !== 'jlist') {
    throw new Error(`unsupported read-only plugin PM2 command: ${args.join(' ')}`);
  }
  const query = pluginPm2Query();
  if (!query.available) return '[]';
  return captureReadonlyPm2Jlist({
    pkgRoot: PKG_ROOT,
    home: PLUGIN_PM2_HOME,
    timeoutMs: opts.timeoutMs,
    env: pm2Env(opts.env),
    expectedGod: query.expectedGod,
  });
}
