/**
 * Maintenance timer: scheduled auto-update / auto-restart. Runs only on the
 * primary daemon (bot-0) — restart is a host-wide operation (it takes down all
 * per-bot daemons), so exactly one process must own it.
 *
 * At the scheduled local time (Asia/Shanghai, once/day) it:
 *  - checks the cross-daemon busy gate (anyDaemonBusy) — a session mid-CLI-turn
 *    anywhere defers the run to the next day (no retry);
 *  - auto-update (npm-global only): `npm install -g botmux@latest`, then restart
 *    to apply iff the version actually changed;
 *  - auto-restart: just restart.
 * Before triggering a restart it drops a restart-intent breadcrumb so the fresh
 * daemon knows to DM the owner (vs. staying silent on a crash-restart).
 *
 * runMaintenanceTick is pure over its injected deps (unit tested); the rest is
 * production wiring.
 */
import { execSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { readGlobalConfig, type MaintenanceConfig } from '../global-config.js';
import { evaluateDue } from './maintenance-schedule.js';
import { anyDaemonBusy } from './daemon-heartbeat.js';
import { writeRestartIntent, type RestartIntent } from '../services/restart-intent-store.js';
import { isLocalDevInstall, botmuxVersion, botmuxCliEntry } from '../utils/install-info.js';

export interface MaintenanceState {
  /** Local date the auto-update run was last handled (fired or skipped). */
  autoUpdate?: { lastDate: string };
}

export interface MaintenanceDeps {
  now: () => number;
  readConfig: () => MaintenanceConfig | undefined;
  readState: () => MaintenanceState;
  writeState: (s: MaintenanceState) => void;
  anyBusy: () => boolean;
  isLocalDev: () => boolean;
  /** Current on-disk botmux version (read fresh — changes after runUpdate). */
  currentVersion: () => string;
  /** Runs `npm install -g botmux@latest` (download/install only). Throws on failure. */
  runUpdate: () => void;
  writeIntent: (intent: RestartIntent) => void;
  /** Spawn a detached `botmux restart` (this process is then killed by pm2). */
  triggerRestart: () => void;
  log?: (msg: string) => void;
}

/**
 * One maintenance tick. The schedule is driven solely by auto-update's time
 * (once/day). At that time: install the latest version (download only), and
 * — only if a newer version was actually installed AND the auto-restart toggle
 * is on — restart to apply it. A busy session anywhere skips the whole run to
 * the next day; auto-restart off ⇒ install only (applied on the next restart).
 * Pure orchestration over injected deps.
 */
export function runMaintenanceTick(deps: MaintenanceDeps): void {
  const cfg = deps.readConfig();
  if (!cfg?.autoUpdate?.enabled) return; // auto-restart has no schedule of its own

  const now = deps.now();
  const state = deps.readState();
  const log = deps.log ?? (() => {});

  const upd = evaluateDue(cfg.autoUpdate, state.autoUpdate?.lastDate, now);
  if ((upd.decision === 'due' || upd.decision === 'missed') && upd.markDate) {
    state.autoUpdate = { lastDate: upd.markDate };
    deps.writeState(state);
  }
  if (upd.decision !== 'due') return;

  if (deps.isLocalDev()) {
    log('auto-update skipped: local-dev install (npm-global only)');
    return;
  }
  if (deps.anyBusy()) {
    log('auto-update skipped: a session is busy — slipping to next day');
    return;
  }

  const before = deps.currentVersion();
  try {
    deps.runUpdate();
  } catch (e) {
    log(`auto-update failed: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const after = deps.currentVersion();
  if (after === before) {
    log('auto-update: already on the latest version');
    return;
  }

  // A newer version was installed. Restart to apply it only if opted in.
  if (cfg.autoRestart?.enabled) {
    deps.writeIntent({ kind: 'update', oldVersion: before, newVersion: after, at: new Date(now).toISOString() });
    deps.triggerRestart();
    log(`auto-update: ${before} → ${after}, restarting to apply`);
  } else {
    log(`auto-update: installed ${after} (was ${before}); auto-restart off — applies on next restart`);
  }
}

// ---- maintenance-state store (dir-injected for tests) ----

const STATE_FILE = 'maintenance-state.json';

export function maintenanceStatePathIn(dir: string): string {
  return join(dir, STATE_FILE);
}

export function readMaintenanceStateTo(dir: string): MaintenanceState {
  const path = maintenanceStatePathIn(dir);
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8'));
    return v && typeof v === 'object' ? v as MaintenanceState : {};
  } catch {
    return {};
  }
}

export function writeMaintenanceStateTo(dir: string, s: MaintenanceState): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = maintenanceStatePathIn(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  renameSync(tmp, path);
}

// ---- production wiring ----

/** How often to evaluate the schedule. Sub-minute so an HH:MM target fires
 *  within the same minute it's reached. */
export const MAINTENANCE_TICK_MS = 60_000;

/** Where the auto-restart driver's stdout/stderr is captured, so a failed
 *  restart-to-apply is diagnosable (previously stdio was 'ignore'). */
export function maintenanceRestartLogPath(): string {
  return join(homedir(), '.botmux', 'logs', 'maintenance-restart.log');
}

/**
 * Build the command to launch `botmux restart` for applying an auto-update.
 *
 * The restart driver must NOT remain a descendant of the daemon it's about to
 * tear down: `botmux restart` deletes botmux-0 (the very daemon that spawned
 * this), and when PM2 kills botmux-0 a child in its process tree gets
 * interrupted — so the restart aborts after deleting botmux-0 and never
 * restarts the rest (the 2026-06-11 incident). `setsid` starts it in a brand
 * new session, reparented to init, immune to botmux-0's teardown. Without
 * setsid we fall back to a plain spawn (still detached by the caller).
 */
export function buildRestartLauncher(
  node: string,
  cliEntry: string,
  hasSetsid: boolean,
): { cmd: string; args: string[] } {
  if (hasSetsid) return { cmd: 'setsid', args: [node, cliEntry, 'restart'] };
  return { cmd: node, args: [cliEntry, 'restart'] };
}

function setsidAvailable(): boolean {
  try {
    execSync('command -v setsid', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function productionDeps(): MaintenanceDeps {
  return {
    now: () => Date.now(),
    readConfig: () => readGlobalConfig().maintenance,
    readState: () => readMaintenanceStateTo(config.session.dataDir),
    writeState: (s) => writeMaintenanceStateTo(config.session.dataDir, s),
    anyBusy: () => anyDaemonBusy(),
    isLocalDev: () => isLocalDevInstall(),
    currentVersion: () => botmuxVersion(),
    runUpdate: () => {
      execSync('npm install -g botmux@latest', { stdio: 'inherit' });
    },
    writeIntent: (intent) => writeRestartIntent(intent),
    triggerRestart: () => {
      // Capture the restart's output to a log so a failure is visible.
      const logFile = maintenanceRestartLogPath();
      let fd: number | undefined;
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        fd = openSync(logFile, 'a');
        writeSync(fd, `\n[${new Date().toISOString()}] auto-update: launching restart to apply\n`);
      } catch {
        fd = undefined; // fall back to discarding output rather than failing the restart
      }
      const { cmd, args } = buildRestartLauncher(process.execPath, botmuxCliEntry(), setsidAvailable());
      const child = spawn(cmd, args, {
        detached: true,
        stdio: fd !== undefined ? ['ignore', fd, fd] : 'ignore',
        env: process.env,
      });
      // A detached child's 'error' (e.g. spawn ENOENT) would otherwise throw
      // unhandled and crash the daemon — log it instead.
      child.on('error', (e) => logger.error(`[maintenance] restart launch failed: ${e instanceof Error ? e.message : e}`));
      child.unref();
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* the detached child holds its own dup */ }
      }
    },
    log: (msg) => logger.info(`[maintenance] ${msg}`),
  };
}

let timer: NodeJS.Timeout | undefined;

/** Start the maintenance loop. Call only on the primary daemon (bot-0). */
export function startMaintenance(): void {
  if (timer) return;
  const deps = productionDeps();
  const tick = () => {
    try { runMaintenanceTick(deps); } catch (e) {
      logger.warn(`[maintenance] tick failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  // First evaluation shortly after startup, then on a steady cadence.
  setTimeout(tick, 10_000).unref?.();
  timer = setInterval(tick, MAINTENANCE_TICK_MS);
  timer.unref?.();
  logger.info('[maintenance] timer started (primary daemon)');
}

export function stopMaintenance(): void {
  if (timer) { clearInterval(timer); timer = undefined; }
}
