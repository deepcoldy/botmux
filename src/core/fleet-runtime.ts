/**
 * Fleet runtime resolution — the single source of truth for what the supervisor
 * (and cmdStart) need to launch the fleet: the bot specs, the shared daemon env,
 * the node args, the dist dir, and the state-file path. Mirrors what the old
 * pm2 `ecosystemConfig` computed, minus pm2 itself.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync, openSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { FleetBotSpec } from './fleet-supervisor.js';
import { pidAlive } from './fleet-supervisor.js';
import { resolveEntrySpawn } from './self-spawn.js';
import { readFleetState } from './fleet-state-store.js';
import { resolveBotmuxDataDir } from './data-dir.js';
import { enqueueFleetCommand } from './fleet-command-queue.js';
import type { FleetProcState, FleetState } from './fleet-supervisor-policy.js';
import { FLEET_GRACEFUL_EXIT_CODE } from './fleet-supervisor-policy.js';
import { botProcessName } from '../setup/bot-config-editor.js';

const CONFIG_DIR = join(homedir(), '.botmux');
const HEAPSHOT_DIR = join(CONFIG_DIR, 'heapshots');
const ENV_FILE = join(CONFIG_DIR, '.env');

/** Path to the fleet state file (replaces pm2 jlist/dump). */
export function fleetStatePath(): string {
  return join(CONFIG_DIR, 'fleet-state.json');
}

/** Directory for per-bot daemon logs (daemon-<index>-out/err.log), the same
 *  LOG_DIR the old pm2 ecosystem wrote out_file/error_file into. */
export function fleetLogDir(): string {
  return LOG_DIR;
}

/** Path to the CLI→supervisor single-bot command queue (start-bot / stop-bot). */
export function fleetCommandPath(): string {
  return join(CONFIG_DIR, 'fleet-commands.json');
}

/** dist/ directory of THIS build (Node path). Under the standalone binary the
 *  spawner ignores it and re-execs the binary, so any value is fine there. */
export function fleetDistDir(): string {
  // dist/core/fleet-runtime.js → dist/
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Node interpreter args every daemon gets (heap ceiling + heap-snapshot dir).
 *  Matches the old ecosystem node_args; ignored for the standalone binary. */
export function fleetDaemonNodeArgs(): string[] {
  return ['--max-old-space-size=8192', `--diagnostic-dir=${HEAPSHOT_DIR}`];
}

/** The shared env every supervised member (bot daemons + the dashboard) inherits.
 *  Loads the legacy global .env for backward compat (WEB_HOST etc.), same as
 *  index-daemon did via dotenv. */
export function resolveFleetDaemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Legacy: the daemon reads ~/.botmux/.env for global settings. We surface the
  // file's presence to the caller by NOT parsing here — index-daemon's own
  // dotenvConfig loads it. Keeping env pass-through avoids double-parsing.
  //
  // MIGRATION-CRITICAL: pin SESSION_DATA_DIR for every supervised child. The old
  // pm2 ecosystem injected `SESSION_DATA_DIR: DATA_DIR` into both the bot daemons
  // AND the dashboard; the pm2→supervisor migration deleted that ecosystem and
  // did NOT re-inject it. Without it, `config.session.dataDir` (a lazy getter)
  // had NO env to read and the daemon/dashboard entrypoints don't run the CLI's
  // `??= resolveDataDir()` — so it resolved to the PACKAGE dir (<pkg>/data)
  // instead of ~/.botmux/data. On an upgrade that silently moves the whole
  // fleet's data root: every existing session / pairing / federation / VC
  // binding under ~/.botmux/data becomes invisible (a fresh install has no old
  // data, so this never shows in author self-test — but a live upgrade always
  // hits it). resolveBotmuxDataDir() reproduces the CLI's resolution
  // (SESSION_DATA_DIR env > ~/.botmux/.data-dir breadcrumb > ~/.botmux/data).
  //
  // Two further reasons the ENV must be present, beyond config.session.dataDir
  // (whose own fallback is now the same canonical resolver — see config.ts):
  //   • Some readers deliberately consult `process.env.SESSION_DATA_DIR` INSTEAD
  //     of config.session.dataDir and DEGRADE when absent — e.g. session-manager's
  //     effectivePromptHookConfigPath, whose comment asserts "daemon 进程必有此
  //     env" and which silently falls back to the GLOBAL hook config (losing
  //     per-bot isolation). A config.ts-level fix cannot reach those.
  //   • It guarantees the dashboard reads the SAME store as the bot daemons.
  //
  // Blank-guarded rather than plain `??=`: `??=` keeps an empty/whitespace value,
  // and every downstream `resolve('')` would then silently mean CWD. A blank is
  // treated as unset; a real explicit value (test/dev override) is preserved.
  if (!env.SESSION_DATA_DIR?.trim()) env.SESSION_DATA_DIR = resolveBotmuxDataDir({ env });
  // Parity with the old ecosystem's stop_exit_codes:[90] sentinel — restores the
  // graceful-exit code for self-exit paths (e.g. dashboard self-update) that read
  // it. The supervisor's own restart suppression already covers operator stops via
  // explicitStop/stopping, so this is belt-and-suspenders, not load-bearing.
  env.BOTMUX_PM2_GRACEFUL_EXIT_CODE ??= String(FLEET_GRACEFUL_EXIT_CODE);
  return env;
}

/** Build the fleet's bot specs from bots.json: name, appId, and the 0-based
 *  index the daemon reads via BOTMUX_BOT_INDEX. The name MUST equal
 *  botProcessName(bot, index) so it correlates 1:1 with what the CLI (status,
 *  logs --bot, start-bot/stop-bot) and the dashboard address a bot by. */
export function resolveFleetBots(): FleetBotSpec[] {
  const botsJson = join(CONFIG_DIR, 'bots.json');
  if (!existsSync(botsJson)) return [];
  let bots: unknown;
  try { bots = JSON.parse(readFileSync(botsJson, 'utf-8')); } catch { return []; }
  const list = Array.isArray(bots) ? bots : (bots as { bots?: unknown[] })?.bots;
  if (!Array.isArray(list)) return [];
  return list.map((b, index) => {
    const bot = (b ?? {}) as { name?: unknown; larkAppId?: unknown };
    return {
      // Canonical process name — reuse botProcessName so the supervisor's proc
      // name is byte-identical to every other addressing surface (no second,
      // divergent normalization that would desync status/logs/start-bot).
      name: botProcessName(bot as { name?: unknown }, index),
      appId: typeof bot.larkAppId === 'string' ? bot.larkAppId : '',
      botIndex: index,
    };
  });
}

const LOG_DIR = join(CONFIG_DIR, 'logs');

/** Canonical process name of the dashboard fleet member — byte-identical to the
 *  name the old pm2 ecosystem used, so status/logs correlate across the
 *  migration. */
export const DASHBOARD_PROCESS_NAME = 'botmux-dashboard';

/**
 * The dashboard's fleet spec. The dashboard is supervised exactly like a bot
 * daemon (crash-restart, graceful-exit code 90 → no restart, max_restarts park),
 * but runs the `dashboard` entry (index-dashboard.ts) instead of a bot daemon,
 * carries no bot index/appId, and logs to dashboard-{out,err}.log. This is what
 * replaces the old unconditional `apps.push({ name: 'botmux-dashboard', … })` in
 * pm2's ecosystemConfig — the dashboard was always a fleet app under pm2, so it
 * is always a supervised member now too.
 */
export function resolveDashboardSpec(): FleetBotSpec {
  return {
    name: DASHBOARD_PROCESS_NAME,
    appId: '',
    botIndex: -1, // not a bot; never used because entry !== 'daemon'
    entry: 'dashboard',
    logBaseName: 'dashboard',
  };
}

/**
 * Every process the supervisor manages: the bot daemons from bots.json PLUS the
 * dashboard. This is the list the supervisor `start()` reconciles and the set
 * `botmux restart` health-gates on. Kept separate from `resolveFleetBots()`,
 * which stays bot-only so bot addressing (start-bot/stop-bot by appId, status
 * rows) is unaffected.
 */
export function resolveFleetMembers(): FleetBotSpec[] {
  return [...resolveFleetBots(), resolveDashboardSpec()];
}

/** True if a live fleet supervisor is already running (per fleet-state pid + kill -0). */
export function liveSupervisorPid(): number | undefined {
  const state = readFleetState(fleetStatePath());
  const pid = state?.supervisorPid ?? 0;
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try { process.kill(pid, 0); return pid; } catch { return undefined; }
}

export interface StartFleetResult {
  action: 'started' | 'already-running';
  supervisorPid: number;
  botCount: number;
}

/**
 * Launch the fleet supervisor as a detached, long-lived process (replaces
 * `pm2 start`). Single-supervisor guarantee: if a live supervisor already owns
 * the fleet, this is a no-op ('already-running') — the running supervisor is
 * itself idempotent and keeps the fleet reconciled. The spawned supervisor
 * outlives this CLI (detached + unref), with stdout/err to the botmux log dir;
 * boot persistence (systemd/launchd) re-invokes `botmux start` → here.
 *
 * NOTE: the caller must already hold the fleet-mutation file lock so two
 * concurrent `botmux start` invocations can't both pass the liveness check.
 */
export function startFleetViaSupervisor(): StartFleetResult {
  const bots = resolveFleetBots();
  const existing = liveSupervisorPid();
  if (existing !== undefined) {
    return { action: 'already-running', supervisorPid: existing, botCount: bots.length };
  }
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(join(LOG_DIR, 'supervisor-out.log'), 'a');
  const err = openSync(join(LOG_DIR, 'supervisor-err.log'), 'a');
  const { command, args } = resolveEntrySpawn('supervisor', fleetDistDir());
  const nodeArgs = args.length > 0 && args[0].startsWith('__') ? [] : ['--enable-source-maps'];
  const child = spawn(command, [...nodeArgs, ...args], {
    cwd: CONFIG_DIR,
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env },
  });
  child.unref();
  return { action: 'started', supervisorPid: child.pid ?? 0, botCount: bots.length };
}

const STOP_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;

export interface StopFleetResult {
  action: 'stopped' | 'not-running' | 'timeout';
  supervisorPid: number;
}

/**
 * Stop the whole fleet by signaling the live supervisor and waiting for it to
 * exit (replaces `pm2 stop` + God teardown). SIGTERM triggers the supervisor's
 * own `stopAll()` — graceful SIGTERM→kill_timeout→SIGKILL of every daemon, plus
 * finalizing fleet-state (procs → stopped, supervisorPid → 0). We poll the pid
 * with kill-0 until it's gone; on timeout we escalate to SIGKILL of the
 * supervisor itself (its children still received SIGTERM and self-reap).
 *
 * NOTE: caller must hold the fleet-mutation lock (single stop/start/restart at
 * a time), same contract as startFleetViaSupervisor.
 */
export function stopFleet(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): StopFleetResult {
  const pid = liveSupervisorPid();
  if (pid === undefined) return { action: 'not-running', supervisorPid: 0 };
  try { process.kill(pid, 'SIGTERM'); } catch { return { action: 'not-running', supervisorPid: pid }; }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return { action: 'stopped', supervisorPid: pid };
    sleepSyncMs(STOP_POLL_INTERVAL_MS);
  }
  if (!pidAlive(pid)) return { action: 'stopped', supervisorPid: pid };
  // Supervisor outlasted its graceful window — hard-kill it. Its daemon children
  // already got SIGTERM from stopAll() and will exit on their own.
  try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
  return pidAlive(pid) ? { action: 'timeout', supervisorPid: pid } : { action: 'stopped', supervisorPid: pid };
}

export interface RestartFleetResult {
  stop: StopFleetResult;
  start: StartFleetResult;
}

/**
 * Restart the fleet: stop the live supervisor (if any), then start a fresh one.
 * Because startFleetViaSupervisor re-reads bots.json, this also picks up any
 * config change. Caller must hold the fleet-mutation lock.
 */
export function restartFleet(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): RestartFleetResult {
  const stop = stopFleet(timeoutMs);
  const start = startFleetViaSupervisor();
  return { stop, start };
}

export interface FleetStatusRow {
  name: string;
  appId: string;
  pid: number;
  status: FleetProcState['status'];
  alive: boolean;
  restarts: number;
  lastExitCode: number | null;
  startedAt: string | null;
}

export interface FleetStatus {
  supervisorPid: number;
  supervisorAlive: boolean;
  supervisorStartedAt: string;
  rows: FleetStatusRow[];
}

/**
 * Project a raw FleetState into a status view, cross-checking each recorded pid
 * with a liveness probe so a stale 'online' row whose daemon actually died is
 * reported alive:false. Pure over (state, isAlive) — unit-testable without HOME.
 */
export function projectFleetStatus(
  state: FleetState | null,
  isAlive: (pid: number) => boolean = pidAlive,
): FleetStatus {
  const supervisorPid = state?.supervisorPid ?? 0;
  return {
    supervisorPid,
    supervisorAlive: isAlive(supervisorPid),
    supervisorStartedAt: state?.supervisorStartedAt ?? '',
    rows: (state?.procs ?? []).map((p) => ({
      name: p.name,
      appId: p.appId,
      pid: p.pid,
      status: p.status,
      alive: isAlive(p.pid),
      restarts: p.restarts,
      lastExitCode: p.lastExitCode,
      startedAt: p.startedAt,
    })),
  };
}

/**
 * Read the current fleet status from fleet-state.json (replaces `pm2 status`).
 * Cross-checks each recorded pid with kill-0 so a stale 'online' row whose
 * daemon actually died is reported alive:false — the supervisor reconciles it
 * on its next tick, but status should never lie about liveness in the meantime.
 */
export function readFleetStatus(statePath: string = fleetStatePath()): FleetStatus {
  return projectFleetStatus(readFleetState(statePath));
}

/** Block for `ms` without a busy-spin (one-shot CLI; stalling its loop is fine). */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable → no-op */ }
}

export interface WaitFleetOnlineResult {
  healthy: boolean;
  online: number;
  expected: number;
  /** Names not online+alive at timeout (empty when healthy). */
  pending: string[];
}

/**
 * Poll fleet-state until every configured bot shows online+alive, or timeout.
 * Replaces pm2's synchronous `readAndAssertConfiguredFleetOnline` health gate:
 * the supervisor spawns children asynchronously after a detached start, so the
 * CLI waits here for the fleet to converge before reporting success / committing
 * the restart-summary breadcrumb. Non-fatal by contract — the caller decides
 * what an unhealthy result means (warn vs. throw).
 */
export function waitFleetOnline(
  expectedNames: readonly string[],
  timeoutMs = 30_000,
  statePath: string = fleetStatePath(),
): WaitFleetOnlineResult {
  const expected = expectedNames.length;
  if (expected === 0) return { healthy: true, online: 0, expected: 0, pending: [] };
  const want = new Set(expectedNames);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let pending: string[] = [...want];
  for (;;) {
    const status = readFleetStatus(statePath);
    const onlineNames = new Set(
      status.rows.filter((r) => want.has(r.name) && r.status === 'online' && r.alive).map((r) => r.name),
    );
    pending = [...want].filter((n) => !onlineNames.has(n));
    if (pending.length === 0) return { healthy: true, online: expected, expected, pending: [] };
    if (Date.now() >= deadline) return { healthy: false, online: expected - pending.length, expected, pending };
    sleepSyncMs(250);
  }
}

/** Every supervised member's name — the bot daemons PLUS the dashboard. This is
 *  what `botmux restart` health-gates on (waitFleetOnline), so a restart that
 *  brings the fleet back but leaves the dashboard down is reported unhealthy
 *  rather than silently "ok". */
export function fleetMemberNames(): string[] {
  return resolveFleetMembers().map((m) => m.name);
}

/** Resolve one bot's fleet spec by larkAppId (null if not in bots.json). */
export function resolveFleetBotByAppId(appId: string): FleetBotSpec | null {
  return resolveFleetBots().find((b) => b.appId === appId) ?? null;
}

export type StartBotSupervisorResult =
  | { ok: true; state: 'started' | 'already-online'; name: string }
  | { ok: false; reason: 'not_found' | 'fleet_down' | 'timeout'; message: string; name?: string };

export type StopBotSupervisorResult =
  | { ok: true; state: 'stopped' | 'already-stopped'; name: string }
  | { ok: false; reason: 'not_found' | 'fleet_down' | 'timeout'; message: string; name?: string };

/**
 * Ask the LIVE supervisor to bring one bot online (the `botmux start-bot` core).
 * The supervisor owns every daemon child, so we enqueue a start-bot command,
 * SIGHUP the supervisor to drain it, and poll fleet-state until that bot is
 * online+alive. When no supervisor is running we return fleet_down — a lone bot
 * belongs to `botmux start`, which brings up the whole fleet (matches the old
 * pm2 semantics). Idempotent: already-online short-circuits.
 *
 * `idFactory`/`nowIso` are injected (no Date/random in shared code paths that
 * also run under the workflow sandbox); the CLI passes real ones.
 */
export function startBotViaSupervisor(
  appId: string,
  idFactory: () => string,
  nowIso: () => string,
  timeoutMs = 30_000,
): StartBotSupervisorResult {
  const spec = resolveFleetBotByAppId(appId);
  if (!spec) return { ok: false, reason: 'not_found', message: `appId ${appId} 不在 bots.json 中` };
  const supervisorPid = liveSupervisorPid();
  if (supervisorPid === undefined) {
    return { ok: false, reason: 'fleet_down', message: 'daemon 未在运行，请先 botmux start', name: spec.name };
  }
  // Already online+alive? No-op.
  const existing = readFleetStatus().rows.find((r) => r.name === spec.name);
  if (existing && existing.status === 'online' && existing.alive) {
    return { ok: true, state: 'already-online', name: spec.name };
  }
  enqueueFleetCommand(fleetCommandPath(), {
    id: idFactory(), op: 'start-bot', name: spec.name, appId: spec.appId, botIndex: spec.botIndex, at: nowIso(),
  });
  try { process.kill(supervisorPid, 'SIGHUP'); } catch {
    return { ok: false, reason: 'fleet_down', message: 'supervisor 已不在运行', name: spec.name };
  }
  const health = waitFleetOnline([spec.name], timeoutMs);
  if (health.healthy) return { ok: true, state: 'started', name: spec.name };
  return { ok: false, reason: 'timeout', message: `${spec.name} 未在超时时间内上线`, name: spec.name };
}

/**
 * Ask the LIVE supervisor to stop one bot (the `botmux stop-bot` core). Enqueue a
 * stop-bot command, SIGHUP, poll fleet-state until that bot is no longer
 * online+alive. The supervisor marks it explicit-stop so its SIGTERM exit is not
 * treated as a crash-to-restart. fleet_down when no supervisor is running.
 */
export function stopBotViaSupervisor(
  appId: string,
  idFactory: () => string,
  nowIso: () => string,
  timeoutMs = 15_000,
): StopBotSupervisorResult {
  const spec = resolveFleetBotByAppId(appId);
  if (!spec) return { ok: false, reason: 'not_found', message: `appId ${appId} 不在 bots.json 中` };
  const supervisorPid = liveSupervisorPid();
  if (supervisorPid === undefined) {
    return { ok: false, reason: 'fleet_down', message: 'daemon 未在运行', name: spec.name };
  }
  const existing = readFleetStatus().rows.find((r) => r.name === spec.name);
  // Short-circuit as already-stopped ONLY when the bot is genuinely at rest with
  // no supervisor-side work pending: absent, 'stopped' (pid 0), or 'errored'
  // (parked, no restart timer). A 'launching' bot is mid-crash-backoff — the
  // supervisor still holds a pending restart timer that WILL respawn it, so it is
  // NOT stopped; reporting 'already-stopped' here would be a lie and the bot
  // reappears ~200ms later. 'online' (with or without a live pid) likewise needs
  // the supervisor to act. In all those cases we must enqueue + SIGHUP so the
  // supervisor's stopOneBot cancels the timer and marks it stopped authoritatively.
  const atRest = !existing || existing.status === 'stopped' || existing.status === 'errored';
  if (atRest) {
    return { ok: true, state: 'already-stopped', name: spec.name };
  }
  enqueueFleetCommand(fleetCommandPath(), {
    id: idFactory(), op: 'stop-bot', name: spec.name, appId: spec.appId, botIndex: spec.botIndex, at: nowIso(),
  });
  try { process.kill(supervisorPid, 'SIGHUP'); } catch {
    return { ok: false, reason: 'fleet_down', message: 'supervisor 已不在运行', name: spec.name };
  }
  // Poll until the bot has actually come to rest (stopped/errored/absent), or
  // timeout. 'launching' and 'online' both mean the supervisor is still working
  // (or the restart timer hasn't been cancelled yet), so keep waiting.
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const row = readFleetStatus().rows.find((r) => r.name === spec.name);
    if (!row || row.status === 'stopped' || row.status === 'errored') return { ok: true, state: 'stopped', name: spec.name };
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout', message: `${spec.name} 未在超时时间内停止`, name: spec.name };
    sleepSyncMs(150);
  }
}

