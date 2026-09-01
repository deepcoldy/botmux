/**
 * Maintenance timer: scheduled auto-update / auto-restart plus bounded log
 * rotation. Runs only on the primary daemon (bot-0) because every daemon on the
 * host shares the same PM2 process list and log directory.
 *
 * At the scheduled local time (Asia/Shanghai, once/day) it:
 *  - checks the cross-daemon busy gate (anyDaemonBusy) — a session mid-CLI-turn
 *    anywhere defers the run to the next day (no retry);
 *  - auto-update (npm/pnpm/Bun global): update the package with its owning package
 *    manager, then restart
 *    to apply iff the version actually changed;
 *  - auto-restart: just restart.
 * Before triggering a restart it drops a restart-intent breadcrumb so the fresh
 * daemon knows to DM the owner (vs. staying silent on a crash-restart).
 *
 * Log rotation is independent of the update schedule and busy gate: it is safe
 * during active sessions and must not starve on a busy host. runMaintenanceTick
 * remains pure over its injected deps (unit tested); the rest is production wiring.
 */
import { execSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { readGlobalConfig, type MaintenanceConfig } from '../global-config.js';
import { evaluateDue } from './maintenance-schedule.js';
import { anyDaemonBusy } from './daemon-heartbeat.js';
import {
  claimRestartLease,
  clearRestartLease,
  hasActiveRestartLease,
  writeRestartIntent,
  type RestartIntent,
} from '../services/restart-intent-store.js';
import {
  isLocalDevInstall,
  botmuxVersion,
  botmuxInstallRoot,
  botmuxVersionAt,
  diskVersionAt,
  botmuxCliEntry,
  botmuxCliEntryAt,
} from '../utils/install-info.js';
import {
  resolveGlobalInstallPlan,
  formatGlobalInstallCommand,
  UnsupportedGlobalInstallError,
  type GlobalInstallPlan,
} from '../utils/global-install.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { scrubWorkflowWorkerEnv, stripDashboardH5Env } from '../utils/child-env.js';
import { isStandaloneBinary } from './self-spawn.js';
import {
  currentUpdateStrategy,
  currentBinaryInstallShape,
  replaceStandaloneBinary,
  type BinaryInstallShape,
  type UpdateStrategy,
} from './binary-self-update.js';
import { globalWrapperPath } from '../utils/local-dev-update.js';
import { rotateBotmuxLogs } from './log-rotation.js';

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
  /** Serialize the complete install → optional restart handoff. */
  withUpdateLock: (fn: () => void) => void;
  /** Current on-disk botmux version (read fresh — changes after runUpdate). */
  currentVersion: () => string;
  /** Updates the owning npm/pnpm/Bun global install (download/install only). */
  runUpdate: () => void;
  /**
   * What `runUpdate` actually installed, or '' when it could not be determined.
   *
   * ⚠️ WHY THIS EXISTS — THE BAKED VERSION SHADOWS A COMPLETED UPDATE, ON BOTH
   * STRATEGIES. A compiled binary's version is baked in at compile time, and
   * `botmuxVersionAt` returns that value for ANY directory you ask about. So
   * `currentVersion()` after an update still reports this process's OLD version:
   *
   *   · self-replace     — the file on disk was swapped; nothing on disk is read.
   *   · package-manager  — npm rewrote the install's package.json, but the baked
   *                        value takes priority over reading it (measured:
   *                        package.json says 3.19.0, the call returns 3.18.4).
   *
   * Either way `after === before`, so the tick logs "already on the latest
   * version" and NEVER restarts onto what it just installed. Both branches
   * therefore report the installed version explicitly — the self-replace path from
   * what it downloaded, the package-manager path via `diskVersionAt` (which
   * deliberately ignores the baked value).
   *
   * Returns '' when undeterminable, and the tick falls back to the re-read
   * comparison. Under Node the baked value is absent, so all of this is a no-op
   * and behaviour is byte-identical to before.
   */
  installedVersion?: () => string;
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
    log('auto-update skipped: local-dev install (global package install only)');
    return;
  }
  if (deps.anyBusy()) {
    log('auto-update skipped: a session is busy — slipping to next day');
    return;
  }

  let before = '';
  let after = '';
  let restartFailed = false;
  try {
    deps.withUpdateLock(() => {
      before = deps.currentVersion();
      deps.runUpdate();
      // Both strategies report what they installed: a compiled binary's baked
      // version shadows the disk on BOTH paths (see MaintenanceDeps.installedVersion).
      const reported = deps.installedVersion?.() ?? '';
      after = reported || deps.currentVersion();
      if (after !== before && cfg.autoRestart?.enabled) {
        deps.writeIntent({ kind: 'update', oldVersion: before, newVersion: after, at: new Date(now).toISOString() });
        try {
          deps.triggerRestart();
        } catch (e) {
          // Update succeeded but the restart handoff failed (e.g. lease taken
          // by a concurrent manual restart, or the detached driver did not
          // start). The new version is already on disk — log it clearly so it
          // isn't mistaken for a full update failure, and don't rethrow: the
          // next tick sees after===before and would otherwise never retry.
          restartFailed = true;
          log(`auto-update: installed ${after} but restart failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    });
  } catch (e) {
    log(`auto-update failed: ${e instanceof Error ? e.message : e}`);
    return;
  }
  if (after === before) {
    log('auto-update: already on the latest version');
    return;
  }

  // A newer version was installed.
  if (!cfg.autoRestart?.enabled) {
    log(`auto-update: installed ${after} (was ${before}); auto-restart off — applies on next restart`);
  } else if (!restartFailed) {
    log(`auto-update: ${before} → ${after}, restarting to apply`);
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
 * Stable cwd (HOME) for spawns that must not inherit a possibly-deleted cwd.
 * A global package update replaces the botmux package dir, so any process whose cwd
 * points there (notably the dashboard, started by pm2 with `cwd: PKG_ROOT`) is
 * left holding a deleted directory. Both the package-manager child and the
 * detached restart driver spawned afterwards would then die at startup reading
 * cwd (`uv_cwd`/ENOENT). Pinning them to HOME sidesteps that entirely.
 */
export function globalInstallUpdateCwd(): string {
  return homedir();
}

/** Run the ownership-aware update synchronously. */
export function installLatestBotmuxSync(plan: GlobalInstallPlan = resolveGlobalInstallPlan()): void {
  const result = spawnSync(plan.command, plan.args, {
    cwd: globalInstallUpdateCwd(),
    env: { ...process.env, ...plan.env },
    stdio: 'inherit',
    shell: process.platform === 'win32', // resolve npm.cmd / pnpm.cmd / bun.exe
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${plan.manager} install exited with ${result.status ?? result.signal ?? 'unknown status'}`);
  }
}

/**
 * Apply an update for whatever install shape this process is, resolving the
 * strategy first so a compiled binary is handled instead of being rejected as an
 * "unsupported install".
 *
 * Shared by the CLI (`botmux update`), the dashboard's `/api/update/run` and the
 * scheduled auto-update so the three cannot drift — they previously all funnelled
 * into `resolveGlobalInstallPlan`, which is exactly the call that fails in
 * compiled mode.
 *
 * @param spec  the version spec for the package-manager path, and the version to
 *              download for the self-replace path ('latest' resolves upstream).
 */
export async function applyBotmuxUpdate(
  installRoot: string,
  version: string,
): Promise<{ strategy: UpdateStrategy['kind']; detail: string }> {
  const strategy = currentUpdateStrategy(installRoot);
  if (strategy.kind === 'unsupported') {
    throw new UnsupportedGlobalInstallError('unknown', process.execPath);
  }
  if (strategy.kind === 'self-replace') {
    const r = await replaceStandaloneBinary(version, strategy.target);
    return { strategy: 'self-replace', detail: `${r.asset} → ${r.target}` };
  }
  const plan = resolveGlobalInstallPlan(strategy.packageRoot, process.platform, `botmux@${version}`);
  installLatestBotmuxSync(plan);
  return { strategy: 'package-manager', detail: formatGlobalInstallCommand(plan) };
}

/**
 * Cross-process lock target that serializes global botmux updates
 * between the scheduled auto-update (this daemon process) and a
 * dashboard-triggered manual update (the separate `botmux-dashboard` process),
 * so the two never write the active global install concurrently. Both sides acquire
 * `withFileLock(Sync)` on this path.
 */
export function globalInstallUpdateLockTargetIn(dataDir: string): string {
  // Keep the historical filename so old/new daemon-dashboard processes still
  // serialize correctly during a rolling upgrade.
  return join(dataDir, 'npm-global-update');
}

export function globalInstallUpdateLockTarget(): string {
  return globalInstallUpdateLockTargetIn(config.session.dataDir);
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
 *
 * ⚠️ COMPILED BINARY: there is no `cli.js` to pass. Under Node the shape is
 * `node <dist/cli.js> restart`, where argv[2] is `restart`. A single-file
 * executable IS the CLI, so the same shape becomes `<binary> <cli.js path>
 * restart` — and argv[2] is then the PATH, not `restart`. MEASURED on the real
 * v3.18.4 binary: it printed the help banner and **exited 0**, i.e. a restart
 * that silently never happened while reporting success. So in standalone mode the
 * entry argument is dropped entirely and the binary is invoked as
 * `<binary> restart`.
 *
 * ⚠️ THE LAUNCHER SHIM IS THE SAME CASE. `selfDispatching` is not a synonym for
 * "compiled": `~/.botmux/bin/botmux` forwards `"$@"` to whatever form is installed,
 * so it too takes the subcommand as its FIRST argument. Handing it a cli.js path
 * reproduces the identical argv shift — help banner, exit 0, no restart — which is
 * why the Node branch of {@link resolveStandaloneRestartExecutable} must pair its
 * launcher target with `selfDispatching: true`.
 */
export function buildRestartLauncher(
  node: string,
  cliEntry: string,
  hasSetsid: boolean,
  selfDispatching = false,
): { cmd: string; args: string[] } {
  // Anything that dispatches its own subcommands (a compiled binary, or the
  // launcher shim that forwards "$@") must NOT be handed a cli.js path: it would
  // shift `restart` to argv[3] where nothing reads it.
  const entryArgs = selfDispatching ? ['restart'] : [cliEntry, 'restart'];
  if (hasSetsid) return { cmd: 'setsid', args: [node, ...entryArgs] };
  return { cmd: node, args: entryArgs };
}

export function detachedRestartEnv(inheritedEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...inheritedEnv };
  // Defense in depth for dashboard/daemon processes resurrected from a stale
  // PM2 snapshot. `botmux restart` checks workflow mode before pm2Env(), so it
  // must not inherit node-worker identity even if a host boot scrub regresses.
  scrubWorkflowWorkerEnv(env);
  // The dashboard process legitimately holds the Feishu H5 credential family
  // (index-dashboard.ts dotenv-loads it from ~/.botmux/.env — deliberately NOT
  // baked into the PM2 env block, see DAEMON_ENV_KEYS), so a detached restart
  // it spawns would inherit the APP_SECRET. The restart driver has no consumer
  // for any of it and must not carry it toward pm2; the fresh dashboard reloads
  // the family from .env itself. Not part of the DAEMON_ENV_KEYS mirror below —
  // this is credential hygiene, not baked-snapshot invalidation.
  stripDashboardH5Env(env);
  // The dashboard/daemon snapshot may outlive a ~/.botmux/.env edit. Let the
  // fresh CLI reload these settings from the file.
  //
  // This list MUST mirror DAEMON_ENV_KEYS in src/cli/daemon-lifecycle-env.ts:
  // every key baked into the PM2 env block there has to be stripped here, or a
  // detached restart (dashboard update/restart, maintenance auto-update) keeps
  // the stale baked value instead of reloading from the file. Kept as a local
  // literal so this stays importable from the daemon/dashboard without pulling
  // in the CLI layer; test/maintenance.test.ts iterates the exported
  // DAEMON_ENV_KEYS and fails the moment the two drift apart.
  for (const key of [
    'WEB_EXTERNAL_HOST',
    'BOTMUX_DASHBOARD_EXTERNAL_HOST',
    'BOTMUX_DASHBOARD_HOST',
    'BOTMUX_DASHBOARD_PORT',
    'BOTMUX_DAEMON_IPC_BASE_PORT',
    'BOTMUX_DASHBOARD_PUBLIC_READONLY',
    'BOTMUX_PUBLIC_URL',
    // Dashboard control-audit destination + terminal takeover lease TTL.
    'BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH',
    'BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS',
    // Merlin Devbox auto-export switch.
    'BOTMUX_DEVBOX_AUTO_EXPORT',
  ]) delete env[key];
  return env;
}

function setsidAvailable(): boolean {
  try {
    execSync('command -v setsid', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the executable a detached restart should launch.
 *
 * ⚠️ WHY `process.execPath` IS NOT ALWAYS RIGHT FOR A COMPILED BINARY. For the
 * self-replacing (install.sh) shape it is exactly right: the path is stable and we
 * just swapped the bytes underneath it. But for a PACKAGE-MANAGER-owned binary the
 * running path can be VERSIONED — pnpm's virtual store yields
 * `…/.pnpm/botmux-linux-x64@<old version>/node_modules/botmux-linux-x64/botmux`.
 * After the update, npm/pnpm's postinstall has re-pointed the stable launcher at
 * the NEW subpackage, while this process's `execPath` still names the OLD one. So
 * restarting from `execPath` either fails with ENOENT (the old store entry was
 * pruned) or silently starts the OLD binary — an update that reports success and
 * does not take effect.
 *
 * The stable launcher (`~/.botmux/bin/botmux`) is what both installers maintain and
 * re-point, so it is the correct target after a package-manager update. Fall back
 * to `execPath` when it is missing (nothing else to go on) — that is the
 * pre-existing behaviour.
 *
 * ⚠️⚠️ AND `execPath` IS NOT RIGHT FOR A **NODE** PROCESS EITHER, WHEN THE UPDATE
 * IT JUST INSTALLED CHANGED THE RUNTIME FORM. This branch used to be an
 * unconditional `if (!standalone) return execPath`, i.e. `node <root>/dist/cli.js
 * restart`. Since 3.18.0 the npm package ships the CLI as a platform-subpackage
 * BINARY: `bin` is gone, `node-pty` left `dependencies`, and postinstall points the
 * launcher at the binary — but `dist/` is still published and still statically
 * imports `node-pty` (MEASURED on the published 3.18.8 tarball: 4 import chains
 * from `dist/cli.js`, 5 from `dist/worker.js`). So after a Node-form daemon
 * auto-updates itself across that boundary, the very next thing it does is spawn
 * `node <root>/dist/cli.js restart` — and npm has just PRUNED node-pty from that
 * tree (MEASURED, 3.17.0 → 3.18.6: "removed 2 packages"). The driver dies on
 * `ERR_MODULE_NOT_FOUND` and the fleet never comes back, having reported
 * "restarting to apply".
 *
 * The launcher is the right target in exactly the same way and for the same
 * reason as the npm-binary case: it is the one path the installer re-points to
 * whatever form is now correct. Prefer it whenever it exists, and keep `execPath`
 * as the fallback so a host without a launcher behaves as before.
 *
 * Pure over its inputs so every branch is testable without a compiled binary.
 */
export function resolveStandaloneRestartExecutable(
  standalone: boolean,
  execPath: string,
  shape: BinaryInstallShape,
  launcherPath: string,
  launcherExists: boolean,
  /** A local-dev checkout runs its own tree and must keep using `execPath`: the
   *  launcher may point at an entirely different checkout, and `cmdUpgradeLocalDev`
   *  deliberately restarts the tree it just built. */
  localDev = false,
): string {
  if (!standalone) {
    // Node form: the launcher tracks the installed form across an update that
    // replaced Node-with-dist by a compiled binary. Not for a dev checkout.
    if (!localDev && launcherExists) return launcherPath;
    return execPath;
  }
  // We own this exact path and just replaced its contents — re-exec it.
  if (shape === 'curl-binary') return execPath;
  if (shape === 'npm-binary' && launcherExists) return launcherPath;
  return execPath;
}

/**
 * The complete restart target: WHICH executable, and whether that executable
 * dispatches its own subcommands (so it must NOT be handed a `cli.js` path).
 *
 * These two decisions are returned together on purpose. They are one invariant —
 * "the launcher shim and the compiled binary both take the subcommand as their
 * first argument" — and computing them at separate call sites is precisely how
 * they drift: picking the launcher as the target while still passing the Node
 * shape re-creates the argv shift that makes a restart print the help banner and
 * exit 0. Pure over its inputs, so the PAIRING is unit-testable rather than only
 * each half.
 */
export function resolveRestartInvocation(
  standalone: boolean,
  execPath: string,
  shape: BinaryInstallShape,
  launcherPath: string,
  launcherExists: boolean,
  localDev = false,
): { executable: string; selfDispatching: boolean } {
  const executable = resolveStandaloneRestartExecutable(
    standalone, execPath, shape, launcherPath, launcherExists, localDev,
  );
  // The compiled binary IS the CLI; the launcher shim `exec`s it with "$@".
  return { executable, selfDispatching: standalone || executable === launcherPath };
}

/**
 * Spawn a detached `botmux restart`, immune to this process's own teardown
 * (setsid → a new session reparented to init, so PM2 killing the current
 * process doesn't interrupt the restart driver). Output is appended to the
 * maintenance-restart log so a failed restart stays diagnosable. Shared by the
 * maintenance timer (auto-update) and the dashboard's manual update/restart.
 *
 * @param reason short tag written to the log (e.g. 'auto-update', 'dashboard').
 */
export function spawnDetachedRestart(
  reason: string,
  activePackageRoot?: string,
  restartLeaseId?: string,
): ReturnType<typeof spawn> {
  const logFile = maintenanceRestartLogPath();
  let fd: number | undefined;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    fd = openSync(logFile, 'a');
    writeSync(fd, `\n[${new Date().toISOString()}] ${reason}: launching restart\n`);
  } catch {
    fd = undefined; // fall back to discarding output rather than failing the restart
  }
  // A compiled binary has no cli.js on disk: `botmuxCliEntryAt` would hand back a
  // path that does not exist (measured: "/dist/cli.js"), and passing it shifts the
  // subcommand out of argv[2]. buildRestartLauncher drops it in that mode; we
  // still compute it for the Node path, which is unchanged.
  const standalone = isStandaloneBinary();
  const cliEntry = activePackageRoot ? botmuxCliEntryAt(activePackageRoot) : botmuxCliEntry();
  // A package-manager-owned binary's own path can be versioned (pnpm store); after
  // the update the stable launcher points at the new one while execPath does not.
  // The Node form needs it too, for the 3.18 Node→binary transition (see below).
  const launcher = globalWrapperPath();
  // Target and calling convention resolved TOGETHER — see resolveRestartInvocation.
  const { executable, selfDispatching } = resolveRestartInvocation(
    standalone,
    process.execPath,
    standalone ? currentBinaryInstallShape() : 'unknown',
    launcher,
    existsSync(launcher),
    isLocalDevInstall(),
  );
  const { cmd, args } = buildRestartLauncher(executable, cliEntry, setsidAvailable(), selfDispatching);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: fd !== undefined ? ['ignore', fd, fd] : 'ignore',
    env: {
      ...detachedRestartEnv(),
      ...(restartLeaseId ? {
        BOTMUX_RESTART_LEASE_ID: restartLeaseId,
        BOTMUX_RESTART_LEASE_DIR: config.session.dataDir,
      } : {}),
    },
    // Run from HOME, not the caller's cwd: the dashboard (cwd: PKG_ROOT) triggers
    // this right after a global update replaced that dir, so inheriting it
    // would start the restart driver in a deleted directory. See globalInstallUpdateCwd.
    cwd: globalInstallUpdateCwd(),
  });
  // A detached child's 'error' (e.g. spawn ENOENT) would otherwise throw
  // unhandled and crash this process — log it instead.
  child.on('error', (e) => logger.error(`[maintenance] restart launch failed: ${e instanceof Error ? e.message : e}`));
  child.unref();
  if (fd !== undefined) {
    try { closeSync(fd); } catch { /* the detached child holds its own dup */ }
  }
  return child;
}

/**
 * Perform a binary self-replace in a CHILD process and block until it finishes.
 *
 * WHY A CHILD AND NOT AN `await` HERE: `runMaintenanceTick` is synchronous and
 * runs inside `withFileLockSync`, so it cannot await the download. Re-execing this
 * same binary with a hidden `__self-update` subcommand keeps the lock semantics
 * byte-identical to the package-manager branch (spawn one child, wait, throw on a
 * non-zero exit) without turning the whole tick async — which would change the
 * locking shape for the npm path too, the one that is currently working.
 *
 * Returns the version that was installed (printed by the child on its last line),
 * or '' when the child reported success without a parseable version.
 */
export function runSelfReplaceBlocking(version = 'latest'): string {
  const result = spawnSync(process.execPath, ['__self-update', version], {
    cwd: globalInstallUpdateCwd(),
    env: process.env,
    encoding: 'utf-8',
    // The download is ~100MB+ over a possibly proxied link; the package-manager
    // branch has no timeout either (npm's own) so match that and let the outer
    // schedule slip a day rather than killing a partial swap.
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join('; ');
    throw new Error(`self-update exited with ${result.status ?? result.signal ?? 'unknown status'}${detail ? `: ${detail}` : ''}`);
  }
  const m = /BOTMUX_SELF_UPDATE_VERSION=(\S+)/.exec(result.stdout || '');
  return m?.[1] ?? '';
}

function productionDeps(): MaintenanceDeps {
  // Kept after a successful resolve so post-pnpm-update version/restart lookups
  // use the stable global node_modules/botmux symlink, not the removed
  // .pnpm/botmux@old runtime realpath.
  let installPlan: GlobalInstallPlan | undefined;
  // What runUpdate installed, for both strategies (see MaintenanceDeps.installedVersion).
  let installedTo = '';
  return {
    now: () => Date.now(),
    readConfig: () => readGlobalConfig().maintenance,
    readState: () => readMaintenanceStateTo(config.session.dataDir),
    writeState: (s) => writeMaintenanceStateTo(config.session.dataDir, s),
    anyBusy: () => anyDaemonBusy(),
    isLocalDev: () => isLocalDevInstall(),
    withUpdateLock: (fn) => withFileLockSync(globalInstallUpdateLockTarget(), () => {
      if (hasActiveRestartLease()) throw new Error('restart already pending');
      fn();
    }, { maxWaitMs: 500 }),
    currentVersion: () => installPlan
      ? botmuxVersionAt(installPlan.activePackageRoot)
      : botmuxVersion(),
    runUpdate: () => {
      installedTo = '';
      const strategy = currentUpdateStrategy(botmuxInstallRoot());
      if (strategy.kind === 'unsupported') {
        throw new UnsupportedGlobalInstallError('unknown', process.execPath);
      }
      if (strategy.kind === 'self-replace') {
        // The compiled binary owns its own file (install.sh location). The tick
        // is synchronous and holds a cross-process lock, so run the async
        // download to completion here rather than restructuring the whole tick:
        // `runSelfReplaceBlocking` re-execs this binary with a hidden subcommand
        // that performs the swap, which keeps the lock semantics identical to the
        // package-manager branch (one child, awaited, non-zero exit ⇒ throw).
        installedTo = runSelfReplaceBlocking();
        return;
      }
      installPlan ??= resolveGlobalInstallPlan(strategy.packageRoot);
      installLatestBotmuxSync(installPlan);
      // Report what landed on DISK. For a compiled binary installed by a package
      // manager, `currentVersion()` (→ botmuxVersionAt) returns this process's
      // BAKED version and so cannot see the update npm just performed — measured,
      // and it would make the tick log "already on the latest version" and skip the
      // restart. diskVersionAt deliberately ignores the baked value. Under Node the
      // two agree, so this is a no-op there.
      installedTo = diskVersionAt(installPlan.activePackageRoot);
    },
    installedVersion: () => installedTo,
    writeIntent: (intent) => writeRestartIntent(intent),
    triggerRestart: () => {
      const leaseId = claimRestartLease();
      if (!leaseId) throw new Error('restart already pending');
      try {
        const child = spawnDetachedRestart('auto-update', installPlan?.activePackageRoot, leaseId);
        if (!child.pid) throw new Error('restart driver did not start');
      } catch (error) {
        clearRestartLease(leaseId);
        throw error;
      }
    },
    log: (msg) => logger.info(`[maintenance] ${msg}`),
  };
}

let timer: NodeJS.Timeout | undefined;
let logRotationInFlight: Promise<void> | undefined;

function triggerLogRotation(): void {
  if (logRotationInFlight) return;
  logRotationInFlight = rotateBotmuxLogs()
    .then((result) => {
      if (result.rotated.length > 0 || result.reloaded) {
        logger.info(`[maintenance] log rotation: rotated=${result.rotated.length} copytruncate=${result.copyTruncated.length} reloaded=${result.reloaded}`);
      }
      for (const failure of result.errors) {
        logger.warn(`[maintenance] log rotation failed path=${failure.path}: ${failure.message}`);
      }
    })
    .catch((error) => {
      logger.warn(`[maintenance] log rotation tick failed: ${error instanceof Error ? error.message : error}`);
    })
    .finally(() => {
      logRotationInFlight = undefined;
    });
}

/** Start the maintenance loop. Call only on the primary daemon (bot-0). */
export function startMaintenance(): void {
  if (timer) return;
  const deps = productionDeps();
  const tick = () => {
    // Log rotation is host-local, safe while workers are busy, and independent
    // from the opt-in package update schedule. The in-flight guard prevents a
    // slow PM2 reconnect from overlapping the next minute's run.
    triggerLogRotation();
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
