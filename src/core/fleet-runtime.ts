/**
 * Fleet runtime resolution — the single source of truth for what the supervisor
 * (and cmdStart) need to launch the fleet: the bot specs, the shared daemon env,
 * the node args, the dist dir, and the state-file path. Mirrors what the old
 * pm2 `ecosystemConfig` computed, minus pm2 itself.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync, openSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { FleetBotSpec, FleetGroupResolution } from './fleet-supervisor.js';
import { pidAlive } from './fleet-supervisor.js';
import { resolveEntrySpawn } from './self-spawn.js';
import { readFleetState } from './fleet-state-store.js';
import { resolveBotmuxDataDir } from './data-dir.js';
import {
  enqueueFleetCommand,
  withdrawFleetCommand,
  type FleetCommandResult,
  type FleetMemberCommandOp,
} from './fleet-command-queue.js';
import { resolveWecomFleetMembers } from './fleet-wecom-members.js';
import { WECOM_GATEWAY_KILL_TIMEOUT_MS } from '../im/wecom/config/gateway-budgets.js';
import { isWecomFleetMemberName } from '../im/wecom/config/fleet-member-name.js';
import { FLEET_DAEMON_EXIT_SLACK_MS, FLEET_SUCCESSOR_SETTLE_MS } from './shutdown-budgets.js';
import type { FleetProcState, FleetState } from './fleet-supervisor-policy.js';
import { FLEET_GRACEFUL_EXIT_CODE } from './fleet-supervisor-policy.js';
import { botProcessName, parseBotConfigsJson } from '../setup/bot-config-editor.js';
import { resolveDaemonEnv } from '../cli/daemon-lifecycle-env.js';
import { scrubDetachedRestartEnvRefresh } from './restart-env-refresh.js';
import type { RestartEnvFallback } from './restart-env-refresh.js';
import { scrubCoreOnlyServiceEnv, stripDashboardH5Env, withoutCoreOnlyFrozenLoopback } from '../utils/child-env.js';
import { scrubSessionTempEnv } from './session-temp.js';
import { findQuotaFallbackCycles } from '../services/quota-fallback.js';
import { findRetiredCliBots } from '../adapters/cli/retired-cli.js';
import {
  inspectFleetProcess,
  signalAttestedFleetProcess,
  type FleetProcessAttestation,
  type FleetProcessIdentityRuntime,
  fleetProcessIdentityRuntime,
  inspectSupervisorState,
} from './fleet-process-identity.js';

export { inspectSupervisorState };

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

/** Path where the supervisor records the outcome of start-member / stop-member. */
export function fleetCommandResultsPath(): string {
  return join(CONFIG_DIR, 'fleet-command-results.json');
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
export type FleetDaemonEnvFileRead =
  | { status: 'loaded'; text: string }
  | { status: 'missing' }
  | { status: 'failed' };

export interface FleetDaemonEnvFileReadOptions {
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => void;
}

const DEFAULT_ENV_FILE_RETRY_DELAYS_MS = [10, 25] as const;

/**
 * Read the optional fleet .env without mistaking an unlink-to-rename update for
 * deletion. The first read happens immediately; only ENOENT enters a finite
 * synchronous quiet period that may recover a replacement which appears while
 * we wait. Exhausting that period is still uncertain: elapsed time is not a
 * writer barrier, so an external unlink-to-rename update may remain in flight.
 * Without an explicit deletion signal we fail safe and let callers retain their
 * authenticated fallback snapshot.
 */
export function readFleetDaemonEnvFile(
  envFilePath = ENV_FILE,
  readTextFile: (path: string) => string = path => readFileSync(path, 'utf-8'),
  statFile: (path: string) => unknown = path => statSync(path),
  options: FleetDaemonEnvFileReadOptions = {},
): FleetDaemonEnvFileRead {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_ENV_FILE_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? sleepSyncMs;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return { status: 'loaded', text: readTextFile(envFilePath) };
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'failed' };
    }

    try {
      statFile(envFilePath);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'failed' };
    }

    if (attempt < retryDelaysMs.length) sleep(retryDelaysMs[attempt]);
  }

  return { status: 'failed' };
}

export function resolveFleetDaemonEnv(
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  envFile: FleetDaemonEnvFileRead | string | undefined = readFleetDaemonEnvFile(),
  options: boolean | StartFleetOptions = Boolean(inheritedEnv.BOTMUX_SESSION_ID?.trim()),
): NodeJS.ProcessEnv {
  // A restart invoked inside a managed session inherits the old daemon's
  // settings. Resolve the persisted lifecycle snapshot before spawning the
  // supervisor; its entrypoint deliberately drops BOTMUX_SESSION_ID, after
  // which it is too late to distinguish a session restart from a shell start.
  const envFileRead: FleetDaemonEnvFileRead = typeof envFile === 'string'
    ? { status: 'loaded', text: envFile }
    : envFile ?? { status: 'missing' };
  const refreshPersistedEnv = typeof options === 'boolean'
    ? options
    : options.refreshPersistedEnv ?? Boolean(inheritedEnv.BOTMUX_SESSION_ID?.trim());
  const inferredSessionRefresh = typeof options !== 'boolean'
    && options.refreshPersistedEnv === undefined
    && Boolean(inheritedEnv.BOTMUX_SESSION_ID?.trim());
  const readFailureFallback = typeof options === 'boolean'
    ? (options ? inheritedEnv : undefined)
    : options.readFailureFallback ?? (inferredSessionRefresh ? inheritedEnv : undefined);
  // From a core-only service's session, its frozen loopback settings are not the
  // fleet's: taken as unset here, they fall back to the persisted file or the
  // defaults instead of moving every Feishu worker and terminal link to 127.0.0.1.
  // scrubCoreOnlyServiceEnv below comes too late for lifecycle keys: they are
  // resolved from this source first.
  const lifecycleSource = withoutCoreOnlyFrozenLoopback(
    envFileRead.status === 'failed' && refreshPersistedEnv ? readFailureFallback ?? {} : inheritedEnv,
    inheritedEnv,
  );
  const defaultDashboardHost = typeof options === 'boolean' ? undefined : options.defaultDashboardHost;
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    ...resolveDaemonEnv(
      lifecycleSource,
      envFileRead.status === 'loaded' ? envFileRead.text : undefined,
      envFileRead.status === 'failed' ? false : refreshPersistedEnv,
      defaultDashboardHost ? { defaultDashboardHost } : undefined,
    ),
  };
  scrubDetachedRestartEnvRefresh(env);
  stripDashboardH5Env(env);
  scrubSessionTempEnv(env);
  // A `botmux start/restart` typed inside a session of a dedicated core-only
  // service (the WeCom managed core, `serve --api-only`) inherits what that
  // service froze: on PTY its whole identity, on every backend its dedicated
  // SESSION_DATA_DIR. No supervised member is ever core-only — left in place,
  // every Feishu daemon would boot the core's synthetic apiOnly bot, or adopt
  // the core's store and repoint the ~/.botmux/.data-dir breadcrumb at it. The
  // scrub drops both, so the pin below re-resolves the fleet's own store
  // (daemon breadcrumb, else ~/.botmux/data). Any other invoker keeps its
  // environment exactly as before.
  scrubCoreOnlyServiceEnv(env);
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
  const list = parseBotConfigsJson(readFileSync(botsJson, 'utf-8'), botsJson);
  return resolveFleetBotsFromEntries(list);
}

/** Pure projection used by startup and regression tests. Cyclic handoff members
 * are intentionally absent; the dashboard is appended separately by
 * resolveFleetMembers(), so operators retain a recovery surface. */
export function resolveFleetBotsFromEntries(list: readonly unknown[]): FleetBotSpec[] {
  const cyclicAppIds = new Set(findQuotaFallbackCycles(list as any[]).flat());
  // Rows on a removed CLI (gemini) are not started either: their daemon would
  // only exit on the same notice in a restart loop (see retired-cli.ts).
  const retiredIndexes = new Set(findRetiredCliBots(list).map(bot => bot.index));
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
  }).filter(spec => !cyclicAppIds.has(spec.appId) && !retiredIndexes.has(spec.botIndex));
}

const LOG_DIR = join(CONFIG_DIR, 'logs');

/** Canonical process name of the dashboard fleet member — byte-identical to the
 *  name the old pm2 ecosystem used, so status/logs correlate across the
 *  migration. */
export const DASHBOARD_PROCESS_NAME = 'botmux-dashboard';

/**
 * The dashboard's fleet spec. The dashboard is supervised exactly like a bot
 * daemon (crash-restart; the 90 graceful sentinel is honoured ONLY when this
 * supervisor itself requested the stop via stopAll/stop-bot — an unsolicited
 * 90 or an outside signal crash-restarts instead; once the fast-restart
 * budget is exhausted, retries continue at the cooldown interval), but
 * runs the `dashboard` entry (index-dashboard.ts) instead of a bot daemon,
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

export function resolveTopicIndexSpec(): FleetBotSpec {
  return {
    name: 'topic-index',
    appId: '',
    botIndex: -1,
    entry: 'topic-indexer',
    logBaseName: 'topic-index',
  };
}

export interface ResolveFleetMembersOptions {
  /** The base env the supervisor gives every member (WeCom members take
   *  `.env` keys only where it has none). Defaults to this process's env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Receives why WeCom members could not be resolved, and per-connection notes. */
  log?: (msg: string) => void;
}

/**
 * Every process the supervisor manages: the bot daemons from bots.json, the
 * dashboard, the topic indexer (unless BOTMUX_TOPIC_SEARCH=0), then one member
 * per WeCom connection whose desired state is `running`. This is the list the
 * supervisor `start()` reconciles. Kept separate from `resolveFleetBots()`,
 * which stays bot-only so bot addressing (start-bot/stop-bot by appId, status
 * rows) is unaffected.
 *
 * WeCom members come last, so without any WeCom configuration the list — and
 * the spawn order — is exactly the members before them. A WeCom
 * source that cannot be read contributes no members and is logged; it never
 * keeps the Feishu bots or the dashboard from starting.
 */
export function resolveFleetMembers(options: ResolveFleetMembersOptions = {}): FleetBotSpec[] {
  return [...resolveFleetBots(), resolveDashboardSpec(), ...(process.env.BOTMUX_TOPIC_SEARCH === '0' ? [] : [resolveTopicIndexSpec()]), ...resolveWecomMembersOrNone(options)];
}

function resolveWecomMembersOrNone(options: ResolveFleetMembersOptions): FleetBotSpec[] {
  try {
    const resolution = resolveWecomGroup(options.baseEnv ?? process.env);
    for (const note of resolution.notes) options.log?.(`wecom: ${note}`);
    return [...resolution.members];
  } catch (err) {
    options.log?.(`wecom: connections not started — ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Fresh resolution of the WeCom member group for the supervisor (boot,
 * start-member / stop-member, SIGHUP reconcile). Reads ~/.botmux/.env each time
 * so a member started later gets the current proxy settings. Throws when the
 * WeCom registry or desired-state file cannot be trusted.
 */
export function resolveWecomGroup(baseEnv: NodeJS.ProcessEnv): FleetGroupResolution & { notes: string[] } {
  return resolveWecomFleetMembers({
    distDir: fleetDistDir(),
    baseEnv,
    readEnvFileText: () => {
      const envFile = readFleetDaemonEnvFile();
      return envFile.status === 'loaded' ? envFile.text : undefined;
    },
  });
}

export function liveSupervisorTarget(
  statePath: string = fleetStatePath(),
  runtime: FleetProcessIdentityRuntime = fleetProcessIdentityRuntime,
): FleetProcessAttestation | undefined {
  const state = readFleetState(statePath);
  const pid = state?.supervisorPid ?? 0;
  if (!state) return undefined;
  const inspection = inspectSupervisorState(state, runtime);
  if (inspection.status === 'unverifiable') {
    throw new Error(`fleet: 无法核验 supervisor pid ${pid} 的进程身份；为避免双实例，已中止操作`);
  }
  return inspection.status === 'exact' ? inspection.attestation : undefined;
}

function attestedSupervisorAlive(
  target: FleetProcessAttestation,
  runtime: FleetProcessIdentityRuntime = fleetProcessIdentityRuntime,
): boolean {
  const inspection = inspectFleetProcess(
    target.pid,
    target.processStart,
    target.pidNamespace,
    commandLine => commandLine === target.commandLine,
    runtime,
  );
  return inspection.status === 'exact';
}

/**
 * Is this exact supervisor generation (pid, birth identity, command line) still
 * running? A different supervisor that took over in the meantime is not it.
 */
export function fleetSupervisorStillRunning(
  target: FleetProcessAttestation,
  runtime: FleetProcessIdentityRuntime = fleetProcessIdentityRuntime,
): boolean {
  return attestedSupervisorAlive(target, runtime);
}

/** True only when fleet-state identifies this exact supervisor generation. */
export function liveSupervisorPid(): number | undefined {
  return liveSupervisorTarget()?.pid;
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
 * NOTE: the caller must already hold the fleet-mutation file lock. That alone
 * does NOT make the check-then-spawn exclusive: the spawned supervisor records
 * itself in fleet-state only after its own boot, so a second `botmux start`
 * in that window still sees no supervisor. The single-owner guarantee is
 * completed supervisor-side by FleetSupervisor's ownership claim, which makes
 * the later of two concurrently spawned supervisors exit without touching
 * anything.
 */
export interface StartFleetOptions {
  refreshPersistedEnv?: boolean;
  readFailureFallback?: RestartEnvFallback;
  defaultDashboardHost?: string;
}

export function startFleetViaSupervisor(options: StartFleetOptions = {}): StartFleetResult {
  const bots = resolveFleetBots();
  const existing = liveSupervisorPid();
  if (existing !== undefined) {
    return { action: 'already-running', supervisorPid: existing, botCount: bots.length };
  }
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  const out = openSync(join(LOG_DIR, 'supervisor-out.log'), 'a');
  const err = openSync(join(LOG_DIR, 'supervisor-err.log'), 'a');
  const { command, args } = resolveEntrySpawn('supervisor', fleetDistDir());
  const nodeArgs = args.length > 0 && args[0].startsWith('__') ? [] : ['--enable-source-maps'];
  const child = spawn(command, [...nodeArgs, ...args], {
    cwd: CONFIG_DIR,
    detached: true,
    stdio: ['ignore', out, err],
    env: resolveFleetDaemonEnv(process.env, readFleetDaemonEnvFile(), options),
  });
  child.unref();
  return { action: 'started', supervisorPid: child.pid ?? 0, botCount: bots.length };
}

const STOP_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;

/**
 * How long a stop waits for the supervisor while a WeCom gateway is live: the
 * gateway's kill timeout plus the same successor/exit slack the Feishu wait
 * (FLEET_DAEMON_EXIT_WAIT_MS) adds to the daemon kill timeout.
 *
 * It has to stay below systemd's default TimeoutStopSec (90 s): the Linux boot
 * unit stops the fleet with `ExecStop=botmux stop` and sets no timeout of its
 * own, so what `botmux stop` does around this wait — starting up, taking the
 * fleet mutation lock, the final check — has to fit in the rest; past 90 s
 * systemd kills what is left of the unit's processes. The gateway's kill timeout
 * counts its core's stop and its drain as running side by side, as they do
 * (im/wecom/config/gateway-budgets.ts), which leaves that rest at about 28 s
 * with the current budgets.
 */
export const WECOM_FLEET_EXIT_WAIT_MS =
  WECOM_GATEWAY_KILL_TIMEOUT_MS + FLEET_SUCCESSOR_SETTLE_MS + FLEET_DAEMON_EXIT_SLACK_MS;

/**
 * The wait a stop/restart gives the supervisor to exit. A gateway's kill
 * timeout is longer than a bot daemon's, and the supervisor only exits after
 * stopAll has seen every child go — cutting the wait short would SIGKILL the
 * supervisor mid-stop and leave fleet-state unfinalized. So while fleet-state
 * shows a live WeCom gateway the wait covers its kill timeout; otherwise (every
 * Feishu-only fleet) it is exactly the caller's `requestedMs`.
 */
export function fleetStopWaitMs(requestedMs: number, state: FleetState | null): number {
  const liveGateway = (state?.procs ?? []).some(p =>
    isWecomFleetMemberName(p.name) && p.status === 'online' && pidAlive(p.pid));
  return liveGateway ? Math.max(requestedMs, WECOM_FLEET_EXIT_WAIT_MS) : requestedMs;
}

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
 * The wait is `timeoutMs`, lengthened only while fleet-state shows a live WeCom
 * gateway (see fleetStopWaitMs).
 *
 * NOTE: caller must hold the fleet-mutation lock (single stop/start/restart at
 * a time), same contract as startFleetViaSupervisor.
 */
export function stopFleet(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): StopFleetResult {
  const target = liveSupervisorTarget();
  if (!target) return { action: 'not-running', supervisorPid: 0 };
  const pid = target.pid;
  const waitMs = fleetStopWaitMs(timeoutMs, readFleetState(fleetStatePath()));
  if (!signalAttestedFleetProcess(target, 'SIGTERM')) return { action: 'not-running', supervisorPid: pid };
  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline) {
    if (!attestedSupervisorAlive(target)) return { action: 'stopped', supervisorPid: pid };
    sleepSyncMs(STOP_POLL_INTERVAL_MS);
  }
  if (!attestedSupervisorAlive(target)) return { action: 'stopped', supervisorPid: pid };
  // Supervisor outlasted its graceful window — hard-kill it. Its daemon children
  // already got SIGTERM from stopAll() and will exit on their own.
  signalAttestedFleetProcess(target, 'SIGKILL');
  return attestedSupervisorAlive(target) ? { action: 'timeout', supervisorPid: pid } : { action: 'stopped', supervisorPid: pid };
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
export interface RestartFleetOptions extends StartFleetOptions {
  timeoutMs?: number;
}

export function restartFleet(options: RestartFleetOptions = {}): RestartFleetResult {
  const stop = stopFleet(options.timeoutMs);
  const start = startFleetViaSupervisor({
    refreshPersistedEnv: options.refreshPersistedEnv,
    readFailureFallback: options.readFailureFallback,
    defaultDashboardHost: options.defaultDashboardHost,
  });
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
  const state = readFleetState(statePath);
  const status = projectFleetStatus(state);
  if (!state || state.supervisorPid <= 1) return status;
  const inspection = inspectSupervisorState(state);
  status.supervisorAlive = inspection.status === 'exact';
  return status;
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

function matchesFleetMember(member: string | FleetBotSpec, row: FleetStatusRow): boolean {
  if (typeof member === 'string') return row.name === member;
  return !member.external && (member.entry ?? 'daemon') === 'daemon' && member.appId
    ? row.appId === member.appId
    : row.name === member.name;
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
  expectedMembers: readonly (string | FleetBotSpec)[],
  timeoutMs = 30_000,
  statePath: string = fleetStatePath(),
): WaitFleetOnlineResult {
  const expected = expectedMembers.length;
  if (expected === 0) return { healthy: true, online: 0, expected: 0, pending: [] };
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const status = readFleetStatus(statePath);
    // Member rows are a projection owned by the supervisor. Never accept old
    // rows merely because their numeric PIDs happen to exist: until the exact
    // supervisor generation is attested, none of its projection proves that the
    // newly-started fleet is healthy. This closes the same cross-namespace/PID
    // reuse hole as stop/restart signalling.
    const pending = expectedMembers.filter(member => !status.supervisorAlive
      || !status.rows.some(row => matchesFleetMember(member, row) && row.status === 'online' && row.alive))
      .map(member => typeof member === 'string' ? member : member.name);
    if (pending.length === 0) return { healthy: true, online: expected, expected, pending: [] };
    if (Date.now() >= deadline) return { healthy: false, online: expected - pending.length, expected, pending };
    sleepSyncMs(250);
  }
}

/** Members `botmux restart` health-gates on: the bot daemons plus the
 *  dashboard. The topic indexer is excluded so a restart never waits on it.
 *
 *  WeCom members are deliberately NOT in it either: a connection replaced by
 *  another instance or holding revoked credentials must not fail a Feishu
 *  restart or roll back an update. Their state is reported separately
 *  (wecomFleetMemberNames). */
export function fleetHealthMembers(): FleetBotSpec[] {
  return resolveFleetMembers().filter((m) => m.entry !== 'topic-indexer' && m.group !== 'wecom');
}

/** Names of the WeCom members the supervisor is expected to run (desired
 *  `running`, configuration present). Empty when there is no WeCom
 *  configuration or it cannot be read. For reporting their state next to the
 *  health gate — e.g. `waitFleetOnline(wecomFleetMemberNames(), …)` and a
 *  warning line per pending name — never for the gate itself. */
export function wecomFleetMemberNames(): string[] {
  try {
    return resolveWecomGroup(process.env).members.map((m) => m.name);
  } catch {
    return [];
  }
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
  const supervisorTarget = liveSupervisorTarget();
  if (!supervisorTarget) {
    return { ok: false, reason: 'fleet_down', message: 'daemon 未在运行，请先 botmux start', name: spec.name };
  }
  // Already online+alive? No-op.
  const existing = readFleetStatus().rows.find((r) => matchesFleetMember(spec, r) && r.status === 'online' && r.alive);
  if (existing && existing.status === 'online' && existing.alive) {
    return { ok: true, state: 'already-online', name: existing.name };
  }
  enqueueFleetCommand(fleetCommandPath(), {
    id: idFactory(), op: 'start-bot', name: spec.name, appId: spec.appId, botIndex: spec.botIndex, at: nowIso(),
  });
  if (!signalAttestedFleetProcess(supervisorTarget, 'SIGHUP')) {
    return { ok: false, reason: 'fleet_down', message: 'supervisor 已不在运行', name: spec.name };
  }
  // The supervisor may retain a pre-rename handle. Wait for the stable app
  // identity instead of timing out after a successful, deduplicated start.
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const status = readFleetStatus();
    const online = status.supervisorAlive && status.rows.find(r => matchesFleetMember(spec, r) && r.status === 'online' && r.alive);
    if (online) return { ok: true, state: 'started', name: online.name };
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout', message: `${spec.name} 未在超时时间内上线`, name: spec.name };
    sleepSyncMs(250);
  }
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
  const supervisorTarget = liveSupervisorTarget();
  if (!supervisorTarget) {
    return { ok: false, reason: 'fleet_down', message: 'daemon 未在运行', name: spec.name };
  }
  const existing = readFleetStatus().rows.filter((r) => matchesFleetMember(spec, r));
  // Short-circuit as already-stopped ONLY when the bot is genuinely at rest with
  // no supervisor-side work pending: absent, 'stopped' (pid 0), or 'errored'
  // (parked, no restart timer). A 'launching' bot is mid-crash-backoff — the
  // supervisor still holds a pending restart timer that WILL respawn it, so it is
  // NOT stopped; reporting 'already-stopped' here would be a lie and the bot
  // reappears ~200ms later. 'online' (with or without a live pid) likewise needs
  // the supervisor to act. In all those cases we must enqueue + SIGHUP so the
  // supervisor's stopOneBot cancels the timer and marks it stopped authoritatively.
  const atRest = existing.every(r => r.status === 'stopped' || r.status === 'errored');
  if (atRest) {
    return { ok: true, state: 'already-stopped', name: spec.name };
  }
  enqueueFleetCommand(fleetCommandPath(), {
    id: idFactory(), op: 'stop-bot', name: spec.name, appId: spec.appId, botIndex: spec.botIndex, at: nowIso(),
  });
  if (!signalAttestedFleetProcess(supervisorTarget, 'SIGHUP')) {
    return { ok: false, reason: 'fleet_down', message: 'supervisor 已不在运行', name: spec.name };
  }
  // Poll until the bot has actually come to rest (stopped/errored/absent), or
  // timeout. 'launching' and 'online' both mean the supervisor is still working
  // (or the restart timer hasn't been cancelled yet), so keep waiting.
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const rows = readFleetStatus().rows.filter((r) => matchesFleetMember(spec, r));
    if (rows.every(r => r.status === 'stopped' || r.status === 'errored')) return { ok: true, state: 'stopped', name: spec.name };
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout', message: `${spec.name} 未在超时时间内停止`, name: spec.name };
    sleepSyncMs(150);
  }
}

export type FleetMemberRequestResult =
  | { ok: true; state: Extract<FleetCommandResult, { ok: true }>['state']; name: string }
  | {
    ok: false;
    reason: Extract<FleetCommandResult, { ok: false }>['reason'] | 'fleet_down' | 'timeout';
    message: string;
    name: string;
  };

/** Default wait for a stop-member: the gateway's whole stop budget plus the
 *  supervisor's exit confirmation and some slack. */
export const FLEET_MEMBER_STOP_WAIT_MS = WECOM_GATEWAY_KILL_TIMEOUT_MS + 10_000;
/** Default wait for a start-member (the supervisor answers once exec succeeded). */
export const FLEET_MEMBER_START_WAIT_MS = 30_000;

export interface FleetMemberSubmitOptions {
  idFactory: () => string;
  nowIso: () => string;
  /** Tests only. */
  paths?: { statePath: string; commandPath: string };
  /** Tests only. */
  identityRuntime?: FleetProcessIdentityRuntime;
}

export type FleetMemberSubmission =
  | { ok: true; id: string; name: string; supervisor: FleetProcessAttestation }
  | { ok: false; reason: 'fleet_down'; message: string; name: string };

/**
 * Hand one group member op (by name) to the LIVE supervisor — the core of
 * `botmux wecom start|stop|restart`: enqueue it and SIGHUP the attested
 * supervisor. The caller waits for the outcome the supervisor records under
 * the returned id (without holding the fleet mutation lock while it waits) and
 * compares the returned supervisor generation to tell whether it is still the
 * one that was asked.
 *
 * fleet_down: no supervisor is running (the desired state still applies on the
 * next `botmux start`), or the signal could not be delivered — then the op is
 * taken back out of the queue, so no later supervisor finds a command whose
 * caller was told it did not go through.
 */
export function submitFleetMemberCommand(
  op: FleetMemberCommandOp,
  name: string,
  options: FleetMemberSubmitOptions,
): FleetMemberSubmission {
  const statePath = options.paths?.statePath ?? fleetStatePath();
  const commandPath = options.paths?.commandPath ?? fleetCommandPath();
  const supervisorTarget = liveSupervisorTarget(statePath, options.identityRuntime);
  if (!supervisorTarget) {
    return { ok: false, reason: 'fleet_down', message: 'daemon 未在运行', name };
  }
  const id = options.idFactory();
  enqueueFleetCommand(commandPath, { id, op, name, appId: '', botIndex: -1, at: options.nowIso() });
  if (!signalAttestedFleetProcess(supervisorTarget, 'SIGHUP', options.identityRuntime)) {
    withdrawFleetCommand(commandPath, id);
    return { ok: false, reason: 'fleet_down', message: 'supervisor 已不在运行', name };
  }
  return { ok: true, id, name, supervisor: supervisorTarget };
}

/**
 * SIGHUP the live supervisor so it reconciles the member groups with their
 * current configuration and desired state (start connections newly set to
 * `running`, stop and remove those set to `stopped` or deleted). For a caller
 * that changed desired state without a per-member command. Returns false when
 * no attested supervisor is running.
 */
export function signalFleetReconcile(
  statePath: string = fleetStatePath(),
  identityRuntime?: FleetProcessIdentityRuntime,
): boolean {
  const supervisorTarget = liveSupervisorTarget(statePath, identityRuntime);
  if (!supervisorTarget) return false;
  return signalAttestedFleetProcess(supervisorTarget, 'SIGHUP', identityRuntime);
}
