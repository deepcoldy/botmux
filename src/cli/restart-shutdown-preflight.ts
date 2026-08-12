/**
 * Non-throwing shutdown-capability preflight shared by read-only surfaces
 * (chiefly the dashboard's `/api/update/restart` endpoint) and the maintenance
 * auto-update path.
 *
 * Why this exists: `botmux restart` fails closed at the shutdown-capability
 * boundary when live daemons still run an old PM2 policy that cannot prove
 * signal-death autorestart (see assertDaemonPm2GracefulExitPolicy). That
 * refusal is correct, but the dashboard fires the real restart in a *detached*
 * `botmux restart` child: its throw only lands in the maintenance-restart log,
 * so the UI would report "restart is slow, refresh manually" for a restart
 * that can never succeed. This probe lets the endpoint detect the boundary
 * synchronously — before returning 202 — so it can surface a precise,
 * actionable "one-time bootstrap upgrade required" instead.
 *
 * It is deliberately read-only: it never signals, starts, or mutates PM2.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildPm2SpawnCommand } from './pm2-command.js';
import { parsePm2JlistOutputStrict, parseCanonicalPm2Id, parsePm2Integer } from './pm2-jlist.js';
import {
  daemonRowsMissingSignalDeathAutorestart,
  normalizeRawPm2StopExitCodes,
} from './pm2-start-transaction.js';
import type { FleetProcessEntry } from './fleet-shutdown.js';

const PM2_NAME = 'botmux';
const PM2_HOME = join(homedir(), '.botmux', 'pm2');

const require = createRequire(import.meta.url);

function isBotmuxCoreProcessName(name: string): boolean {
  return name === PM2_NAME || (name.startsWith(`${PM2_NAME}-`) && !name.startsWith(`${PM2_NAME}-plugin-`));
}

/** The dashboard row is not a signal target: only worker daemons are subject
 * to the shutdown-capability preflight. Mirrors isBotmuxDaemonProcessName in
 * cli.ts. */
function isBotmuxDaemonProcessName(name: string): boolean {
  return isBotmuxCoreProcessName(name) && name !== 'botmux-dashboard';
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

function toFleetProcessEntry(app: any): FleetProcessEntry {
  const pmId = parseCanonicalPm2Id(app);
  const exitCode = parsePm2Integer(app?.pm2_env?.exit_code);
  return {
    name: String(app?.name),
    ...(pmId !== undefined ? { pmId } : {}),
    pid: Number(app?.pid) || 0,
    online: app?.pm2_env?.status === 'online',
    status: String(app?.pm2_env?.status ?? 'unknown'),
    autorestart: app?.pm2_env?.autorestart,
    stopExitCodes: normalizeRawPm2StopExitCodes(app?.pm2_env?.stop_exit_codes),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

/** Injectable reader for tests. Production reads the live PM2 jlist. */
export type Pm2FleetProjectionReader = () => FleetProcessEntry[];

function readLivePm2Projection(): FleetProcessEntry[] {
  const pm2 = buildPm2SpawnCommand(pm2Bin(), ['jlist']);
  const result = spawnSync(pm2.command, pm2.args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PM2_HOME },
    shell: pm2.shell ?? false,
    timeout: 10_000,
    // Match cli.ts pm2Capture: jlist output scales with fleet size.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = result.error?.message
      ?? ((result.stderr ? String(result.stderr).trim() : '') || `status ${result.status}`);
    throw new Error(`pm2 jlist failed: ${detail}`);
  }
  const output = typeof result.stdout === 'string' ? result.stdout : '';
  return parsePm2JlistOutputStrict(output)
    .filter(app => app && isBotmuxCoreProcessName(String(app?.name)))
    .map(toFleetProcessEntry);
}

export interface RestartShutdownPreflight {
  /** True when a normal restart will fail closed and the operator must run the
   * one-time `--bootstrap-shutdown-protocol` upgrade first. */
  bootstrapRequired: boolean;
  /** Canonical PM2 names of the live daemon rows still on the old policy.
   * Empty when bootstrapRequired is false. */
  unsafeDaemonNames: string[];
}

/**
 * Inspect the currently live botmux daemons and decide whether a normal
 * restart would be refused by the shutdown-capability boundary.
 *
 * Only ONLINE, OS-plausible daemon rows are considered: a fleet that is
 * already fully retired (or a box where jlist is empty) reports
 * bootstrapRequired=false. If the projection cannot be read, callers should
 * treat that as "unknown, do not claim bootstrap is required" and fall back to
 * the existing fire-and-forget behavior — this probe never fabricates a
 * bootstrap requirement out of a read failure.
 */
export function evaluateRestartShutdownPreflight(
  read: Pm2FleetProjectionReader = readLivePm2Projection,
): RestartShutdownPreflight {
  const projection = read();
  const liveDaemons = projection.filter(entry =>
    isBotmuxDaemonProcessName(entry.name) && entry.online && entry.pid > 1);
  const unsafe = daemonRowsMissingSignalDeathAutorestart(liveDaemons);
  return {
    bootstrapRequired: unsafe.length > 0,
    unsafeDaemonNames: unsafe.map(entry => entry.name),
  };
}
