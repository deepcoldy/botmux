/**
 * Upgrade migration: hand WeCom gateways that an older Dashboard started over
 * to the fleet.
 *
 * Before WeCom connections were fleet members, the Dashboard spawned each
 * gateway itself (detached) and recorded its birth identity in
 * `~/.botmux/wecom/dashboard-jobs/<configId>.json`. Such a gateway keeps the
 * bot's instance lock and its core's port, so the fleet member started for the
 * same connection could never come up next to it. Before a NEW supervisor is
 * started (`botmux start` with no live supervisor, `botmux restart`, first-use),
 * every such gateway that is still alive is therefore:
 *
 *   1. recorded as desired `running` — unless a person recorded an intent for
 *      the connection at or after the time that Dashboard started the gateway
 *      (`wecom stop` / `wecom start` run after the upgrade but before the first
 *      new supervisor). A later `running` record is left as it is; a later
 *      `stopped` one is kept too, and the gateway is still stopped below: the
 *      connection stays stopped, as `wecom stop` told the person it would. Any
 *      older record, or a time that cannot be read, is overwritten (only an
 *      older Dashboard leaves such a process, so it is the newer intent). A
 *      `stopped` record that carries a reason is not a person's intent but a
 *      fleet gateway's own stop (typically `instance_busy`, caused by this very
 *      old gateway holding the bot's lock), so it is overwritten too;
 *   2. stopped by its birth identity — SIGTERM, a grace period, then SIGKILL;
 *   3. followed by its core: the core the gateway was serving (identified
 *      before the gateway is signalled) must be gone too, and is stopped the
 *      same way when it outlived its gateway (an older gateway records no core
 *      generation, so the gateway's own orphan reclaim cannot find it);
 *   4. forgotten: its job file is deleted.
 *
 * A gateway whose configuration takes its credential from an environment
 * variable (`secretEnv`) that the current environment does not have is left
 * running, with a warning: it works in its own environment, and the fleet
 * started from this one could not run it.
 *
 * A job whose gateway is already gone gets no record (no record = not a
 * member) and loses its file — once its core is known to be gone too. A
 * gateway killed outright (SIGKILL) before the upgrade left its core running:
 * cores of those versions never notice their gateway dying, and the orphan
 * keeps the core port, so every new gateway for the connection fails at once.
 * Such an orphan is stopped (by birth identity, journaled first) only when
 * every piece of evidence holds — its descriptor names a live process of the
 * descriptor's birth, whose parent is not that gateway, on the configured
 * port, while no live process holds the bot's instance lock (no gateway runs
 * the bot, a terminal one included). Anything less leaves it alone with a
 * warning, and the job stays so the next start checks again. A gateway running
 * in a terminal has no job file and is never touched.
 *
 * Every step can be interrupted (the CLI killed, the machine rebooted) and the
 * next run finishes the work: the job file stays until the end, and before any
 * signal is sent the core's identity is journaled into it, so a run that finds
 * the gateway already gone still knows which core to check. Only exact birth
 * identities (pid + start time, plus the pid namespace where recorded) are ever
 * signalled, so a re-run cannot hit a process that merely reuses a pid.
 *
 * Nothing here may keep the Feishu fleet from starting: every failure becomes
 * one warning line and the caller carries on.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { procStatFieldsAfterComm } from '../../utils/proc-stat.js';
import { isLinuxZombie, readLinuxBootIdentity, readProcessStartIdentity } from '../../utils/process-identity.js';
import {
  fleetProcessIdentityRuntime,
  inspectFleetProcess,
  signalAttestedFleetProcess,
  type FleetProcessAttestation,
  type FleetProcessIdentityRuntime,
} from '../../core/fleet-process-identity.js';
import { wecomRoot } from '../../im/wecom/config/discovery.js';
import {
  readWecomFleetDesiredState,
  updateWecomFleetDesiredState,
  type WecomDesiredRecord,
} from '../../im/wecom/config/fleet-desired-state.js';
import { listWecomFleetConnections, type WecomFleetConnection } from '../../im/wecom/config/fleet-members.js';
import { wecomBotRoot } from '../../im/wecom/config/runtime.js';
import { legacyDashboardJobsDir } from './legacy-dashboard-jobs.js';

/** SIGTERM → SIGKILL window for an old gateway. It stops its own core first
 *  (SIGTERM, 5 s, SIGKILL, 5 s in the versions that wrote job files) and then
 *  exits, so this covers its whole shutdown with a little room. */
export const LEGACY_GATEWAY_STOP_GRACE_MS = 15_000;
/** SIGTERM → SIGKILL window for a core that outlived its gateway. */
export const LEGACY_CORE_STOP_GRACE_MS = 10_000;
/** How long a SIGKILLed process may take to disappear. */
export const LEGACY_KILL_WAIT_MS = 5_000;
/**
 * Upper bound of the waiting the migration does, for any number of connections
 * (they are stopped in parallel): gateways, then the cores that outlived them.
 * Process inspection (a `ps` per check on macOS) and the desired-state file
 * lock (5 s at most) come on top.
 */
export const LEGACY_GATEWAY_MIGRATION_MAX_WAIT_MS =
  LEGACY_GATEWAY_STOP_GRACE_MS + LEGACY_KILL_WAIT_MS + LEGACY_CORE_STOP_GRACE_MS + LEGACY_KILL_WAIT_MS;

const POLL_MS = 200;
const JOB_FILE = /^[0-9a-f]{64}\.json$/;
const CORE_BOT_ID = /^local_[a-z0-9_-]+$/;

export type LegacyMigrationStep = 'recorded' | 'gateways-stopped' | 'cores-stopped';

export interface LegacyGatewayMigrationDeps {
  root: string;
  listConnections(): WecomFleetConnection[];
  /** The desired-state records as they are now (listConnections has already
   *  refused an unreadable file). */
  readDesired(): ReadonlyMap<string, WecomDesiredRecord>;
  /** Record these connections as desired `running`, all in one write. */
  markRunning(configIds: readonly string[]): void;
  runtime: FleetProcessIdentityRuntime;
  /** Start identity in the form the core descriptor stores. */
  readStartIdentity(pid: number): string | undefined;
  readParentPid(pid: number): number | undefined;
  /** This boot's id (Linux), for lock holders that recorded one. */
  readBootId(): string | undefined;
  /**
   * When this boot began, for telling a core descriptor written during an
   * earlier boot (its pid and start time say nothing about today's processes:
   * on Linux the start time counts from boot). `not-needed` where start times
   * are absolute (macOS `ps lstart`). Absent: not needed.
   */
  readBootTime?(): { kind: 'known'; ms: number } | { kind: 'unknown' } | { kind: 'not-needed' };
  /** When a file was last written (epoch ms), undefined when it cannot be read. */
  fileWrittenAt?(path: string): number | undefined;
  /** The environment the new supervisor gets (secretEnv checks). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  isZombie(pid: number): boolean;
  signal(target: FleetProcessAttestation, signal: NodeJS.Signals): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  warn(line: string): void;
  info(line: string): void;
  /** Called after each step with the connections it covered; a probe uses it
   *  to interrupt the migration there. */
  afterStep?(step: LegacyMigrationStep, configIds: readonly string[]): void;
}

interface ProcessBirth {
  pid: number;
  processStart: string;
  pidNamespace?: string;
}

interface LegacyJob {
  /** The file as written, kept whole when the journal is added. */
  raw: Record<string, unknown>;
  gateway: ProcessBirth;
  /** When that Dashboard started the gateway (epoch ms), if readable. */
  createdAt?: number;
  /** Journaled by an earlier, interrupted run. */
  journaledCore?: ProcessBirth;
  /** That core was journaled as an orphan of an already-gone gateway. */
  journaledOrphan?: boolean;
  /** An earlier run had a live gateway here (it journaled before signalling it). */
  journaledLive?: boolean;
  /** ... and kept the connection stopped (a person's later stop). */
  journaledKeptStopped?: boolean;
}

interface Candidate {
  connection: WecomFleetConnection;
  path: string;
  job: LegacyJob;
  gateway?: FleetProcessAttestation;
  core?: ProcessBirth;
  /** A person recorded `stopped` after the gateway was started: stop it, keep the record. */
  keepStopped?: boolean;
  /** Its gateway was already gone and `core` is the orphan it left behind. */
  orphan?: boolean;
  /** Its gateway was already gone and a core may still run, unproven: leave it, keep the job. */
  unconfirmed?: boolean;
}

export interface LegacyMigrationSummary {
  /** Connections whose old gateway was stopped and handed to the fleet (by this
   *  run, or by an earlier one this run finished after an interruption). */
  migrated: string[];
  /** Connections whose old gateway was stopped and that stay stopped: a person
   *  recorded `stopped` after that gateway was started. */
  keptStopped: string[];
  /** Job files removed because their gateway was already gone. */
  forgotten: string[];
  /** Connections whose gateway was already gone and whose orphaned core this
   *  run signalled and saw exit; not recorded as running (they stay not running). */
  orphansStopped: string[];
  /** Connections left for the next run (a process that would not go, or an old
   *  gateway the fleet could not run from this environment). */
  remaining: string[];
}

function isBirth(value: unknown): value is ProcessBirth {
  const birth = value as Partial<ProcessBirth> | null;
  return !!birth && typeof birth === 'object'
    && Number.isSafeInteger(birth.pid) && (birth.pid as number) > 1
    && typeof birth.processStart === 'string' && birth.processStart.length > 0
    && (birth.pidNamespace === undefined || typeof birth.pidNamespace === 'string');
}

/** Same shape check the Dashboard that wrote the file applied. */
function readLegacyJob(path: string, configId: string): LegacyJob | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || raw.configId !== configId
    || typeof raw.launchId !== 'string' || typeof raw.botKey !== 'string') {
    return undefined;
  }
  const gateway = { pid: raw.pid, processStart: raw.processStart, pidNamespace: raw.pidNamespace };
  if (!isBirth(gateway)) return undefined;
  const migration = raw.migration as { core?: unknown; orphan?: unknown; keptStopped?: unknown } | undefined;
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined;
  return {
    raw,
    ...(createdAt !== undefined ? { createdAt } : {}),
    gateway: {
      pid: gateway.pid,
      processStart: gateway.processStart,
      ...(gateway.pidNamespace ? { pidNamespace: gateway.pidNamespace } : {}),
    },
    ...(migration && isBirth(migration.core) ? { journaledCore: migration.core } : {}),
    ...(migration && isBirth(migration.core) && migration.orphan === true ? { journaledOrphan: true } : {}),
    ...(migration && typeof migration === 'object' && migration.orphan !== true ? { journaledLive: true } : {}),
    ...(migration && typeof migration === 'object' && migration.keptStopped === true ? { journaledKeptStopped: true } : {}),
  };
}

/**
 * What a person recorded for the connection after its old gateway was started,
 * if anything: `running` / `stopped` from a record whose `updatedAt` is not
 * earlier than the job's `createdAt`; undefined when there is no record, it is
 * older, either time cannot be read, or it carries a reason (a fleet gateway
 * stopped itself, no person decided anything) — then the migration records
 * `running`.
 */
function laterIntent(record: WecomDesiredRecord | undefined, job: LegacyJob): WecomDesiredRecord['desired'] | undefined {
  if (!record || record.reason !== undefined || job.createdAt === undefined) return undefined;
  const updatedAt = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt < job.createdAt) return undefined;
  return record.desired;
}

function inspect(birth: ProcessBirth, runtime: FleetProcessIdentityRuntime) {
  return inspectFleetProcess(birth.pid, birth.processStart, birth.pidNamespace, () => false, runtime, false);
}

function isGone(target: ProcessBirth, deps: LegacyGatewayMigrationDeps): boolean {
  if (!deps.runtime.pidExists(target.pid)) return true;
  return deps.runtime.readIdentity(target.pid) !== target.processStart || deps.isZombie(target.pid);
}

async function waitGone(targets: readonly ProcessBirth[], ms: number, deps: LegacyGatewayMigrationDeps): Promise<ProcessBirth[]> {
  const deadline = deps.now() + ms;
  let alive = targets.filter(target => !isGone(target, deps));
  while (alive.length > 0 && deps.now() < deadline) {
    await deps.sleep(Math.min(POLL_MS, Math.max(1, deadline - deps.now())));
    alive = alive.filter(target => !isGone(target, deps));
  }
  return alive;
}

/** SIGTERM all, wait up to `graceMs`, SIGKILL the rest, wait again. Returns
 *  the ones still alive after that, and the pids a signal was delivered to
 *  (a target already gone when its turn came gets none). */
async function stopAll(
  targets: readonly FleetProcessAttestation[],
  graceMs: number,
  deps: LegacyGatewayMigrationDeps,
): Promise<{ survivors: FleetProcessAttestation[]; signalled: Set<number> }> {
  const signalled = new Set<number>();
  for (const target of targets) {
    if (deps.signal(target, 'SIGTERM')) signalled.add(target.pid);
  }
  const lingering = await waitGone(targets, graceMs, deps) as FleetProcessAttestation[];
  for (const target of lingering) {
    if (deps.signal(target, 'SIGKILL')) signalled.add(target.pid);
  }
  const survivors = await waitGone(lingering, LEGACY_KILL_WAIT_MS, deps) as FleetProcessAttestation[];
  return { survivors, signalled };
}

/**
 * The core this live gateway is serving: the pid in its core descriptor, when
 * that process has the descriptor's start identity AND is the gateway's child.
 * undefined for an external core (nothing to stop) or when that cannot be
 * shown (then the gateway's own shutdown is relied on, with a warning).
 */
function identifyCore(candidate: Candidate, deps: LegacyGatewayMigrationDeps): ProcessBirth | undefined {
  const { connection } = candidate;
  if (connection.config.presence !== 'present') return undefined;
  let managedCore: { stateDir?: unknown; botId?: unknown } | undefined;
  try {
    managedCore = JSON.parse(connection.config.text)?.managedCore;
  } catch {
    return undefined;
  }
  if (!managedCore || typeof managedCore !== 'object') return undefined;
  const { stateDir, botId } = managedCore;
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir) || typeof botId !== 'string' || !CORE_BOT_ID.test(botId)) {
    return undefined;
  }
  const unidentified = (why: string) => {
    deps.warn(`⚠️  企业微信连接 ${connection.memberName}：无法确认旧网关的 core 进程（${why}），`
      + '只停网关并由它自己收掉 core；之后若 core 端口仍被占用，请手动结束该 core。');
    return undefined;
  };
  let descriptor: { pid?: unknown; processStartIdentity?: unknown };
  try {
    descriptor = JSON.parse(readFileSync(join(stateDir, 'dashboard-daemons', `${botId}.json`), 'utf8'));
  } catch {
    return unidentified('没有可读的 core 描述符');
  }
  const pid = descriptor.pid;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 1) return unidentified('描述符里的 pid 无效');
  const corePid = pid as number;
  if (deps.readParentPid(corePid) !== candidate.job.gateway.pid) return unidentified('描述符里的进程不是该网关的子进程');
  if (!descriptor.processStartIdentity || deps.readStartIdentity(corePid) !== descriptor.processStartIdentity) {
    return unidentified('描述符与进程的启动时间不一致');
  }
  const processStart = deps.runtime.readIdentity(corePid);
  if (!processStart) return unidentified('读不到进程出生身份');
  const pidNamespace = deps.runtime.readPidNamespace(corePid);
  return { pid: corePid, processStart, ...(pidNamespace ? { pidNamespace } : {}) };
}

/** Journal the core into the job file before any signal is sent. */
function journal(candidate: Candidate, deps: LegacyGatewayMigrationDeps): void {
  const migration = {
    startedAt: new Date(deps.now()).toISOString(),
    ...(candidate.core ? { core: candidate.core } : {}),
    ...(candidate.orphan ? { orphan: true } : {}),
    ...(candidate.keepStopped ? { keptStopped: true } : {}),
  };
  atomicWriteFileSync(candidate.path, JSON.stringify({ ...candidate.job.raw, migration }), {
    mode: 0o600,
    followTargetSymlink: false,
  });
}

/**
 * What to tell the person about a core that was left alone:
 *  - `kill`: no gateway runs the bot, but the core cannot be proven to be the
 *    old gateway's leftover; ending it by hand once checked is the way out;
 *  - `gateway-running`: a live gateway holds the bot's lock, so the core is in
 *    all likelihood the one it uses — never advise killing it;
 *  - `lock-unknown`: whether a gateway runs the bot cannot be told; ending the
 *    core is advised only after making sure none does.
 */
type OrphanAdvice = 'kill' | 'gateway-running' | 'lock-unknown';

type OrphanVerdict =
  | { kind: 'none' }
  | { kind: 'orphan'; core: ProcessBirth; port: number }
  | { kind: 'unconfirmed'; pid: number; port: number | undefined; why: string; advice: OrphanAdvice; holder?: number };

/** Does a live process hold the bot's instance lock? Same reading of the
 *  holder record as the file lock's own stale-break check. */
function instanceLockHolder(
  file: string,
  deps: LegacyGatewayMigrationDeps,
): { state: 'none' } | { state: 'alive' | 'unknown'; pid?: number } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'none' } : { state: 'unknown' };
  }
  let holder: { pid?: unknown; procStart?: unknown; bootId?: unknown };
  try {
    holder = /^\d+$/.test(text) ? { pid: Number(text) } : JSON.parse(text);
  } catch {
    return { state: 'unknown' };
  }
  const pid = holder?.pid;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 1) return { state: 'unknown' };
  const holderPid = pid as number;
  if (typeof holder.bootId === 'string') {
    const boot = deps.readBootId();
    if (boot !== undefined && boot !== holder.bootId) return { state: 'none' };
  }
  if (!deps.runtime.pidExists(holderPid)) return { state: 'none' };
  if (typeof holder.procStart === 'string') {
    const start = deps.readStartIdentity(holderPid);
    if (start === undefined) return { state: 'unknown', pid: holderPid };
    return start === holder.procStart ? { state: 'alive', pid: holderPid } : { state: 'none' };
  }
  return { state: 'unknown', pid: holderPid };
}

/**
 * The core a gateway that is already gone may have left running. `orphan` only
 * when every piece of evidence holds:
 *  - its descriptor names a live process with the descriptor's start identity;
 *  - no live process holds the bot's instance lock (no gateway, a terminal one
 *    included, is running the bot);
 *  - that process's parent is not the job's gateway (no `ppid == 1` test: on
 *    Linux an orphan is adopted by the nearest subreaper);
 *  - it serves the configured core port;
 *  - its birth identity verifies.
 * `none` when there is nothing to look for (external core), the core is gone
 * (no descriptor, its process gone, the pid now another process's), or the
 * core is the child of the live gateway holding the lock: then it is that
 * gateway's core, not the dead one's, and the job is just a stale record.
 * `unconfirmed` when a core may be running but one of the above cannot be shown.
 */
function identifyOrphanCore(candidate: Candidate, deps: LegacyGatewayMigrationDeps): OrphanVerdict {
  const { connection } = candidate;
  if (connection.config.presence !== 'present') return { kind: 'none' };
  let config: { botId?: unknown; managedCore?: { stateDir?: unknown; botId?: unknown; port?: unknown } } | undefined;
  try {
    config = JSON.parse(connection.config.text);
  } catch {
    return { kind: 'none' };
  }
  const managedCore = config?.managedCore;
  if (!managedCore || typeof managedCore !== 'object') return { kind: 'none' };
  const { stateDir, botId, port } = managedCore;
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir) || typeof botId !== 'string' || !CORE_BOT_ID.test(botId)) {
    return { kind: 'none' };
  }
  const descriptorPath = join(stateDir, 'dashboard-daemons', `${botId}.json`);
  let text: string;
  try {
    text = readFileSync(descriptorPath, 'utf8');
  } catch (err) {
    // A core removes its descriptor when it exits; no descriptor, no core.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return {
      kind: 'unconfirmed', pid: 0, port: undefined, advice: 'kill',
      why: `core 描述符读不出来（${(err as NodeJS.ErrnoException).code ?? 'error'}）`,
    };
  }

  let descriptor: { pid?: unknown; processStartIdentity?: unknown; ipcPort?: unknown };
  try {
    descriptor = JSON.parse(text);
  } catch {
    return { kind: 'unconfirmed', pid: 0, port: undefined, why: 'core 描述符无法解析', advice: 'kill' };
  }
  const descriptorPort = Number.isInteger(descriptor.ipcPort) ? descriptor.ipcPort as number : undefined;
  if (!Number.isSafeInteger(descriptor.pid) || (descriptor.pid as number) <= 1 || typeof descriptor.processStartIdentity !== 'string') {
    return { kind: 'unconfirmed', pid: 0, port: descriptorPort, why: 'core 描述符缺少 pid 或启动时间', advice: 'kill' };
  }
  const pid = descriptor.pid as number;
  const unconfirmed = (why: string, advice: OrphanAdvice = 'kill', holder?: number): OrphanVerdict =>
    ({ kind: 'unconfirmed', pid, port: descriptorPort, why, advice, ...(holder !== undefined ? { holder } : {}) });
  if (!deps.runtime.pidExists(pid)) return { kind: 'none' };
  // A descriptor left by a core of an earlier boot names nothing alive today.
  // On Linux its start time counts from boot, so a process of this boot can
  // carry the same pid and start time by coincidence: such a descriptor must
  // never lead to a signal.
  const boot = deps.readBootTime?.() ?? { kind: 'not-needed' as const };
  if (boot.kind === 'unknown') return unconfirmed('读不到本次开机的时间，无法确认 core 描述符写于本次开机');
  if (boot.kind === 'known') {
    const writtenAt = deps.fileWrittenAt?.(descriptorPath);
    if (writtenAt === undefined) return unconfirmed('读不到 core 描述符的写入时间');
    if (writtenAt < boot.ms) return { kind: 'none' };
  }
  const start = deps.readStartIdentity(pid);
  if (start === undefined) return unconfirmed('读不到该进程的启动时间');
  // Another process now has the pid: the core it named is gone.
  if (start !== descriptor.processStartIdentity) return { kind: 'none' };
  if (typeof config?.botId !== 'string' || !config.botId) return unconfirmed('配置里没有可用的 botId，查不了实例锁');
  const lock = instanceLockHolder(join(wecomBotRoot(config.botId, deps.root), 'instance.lock'), deps);
  const parent = deps.readParentPid(pid);
  if (lock.state === 'alive') {
    // A gateway runs the bot and this core is its child: the core belongs to
    // that gateway, and the job (whose gateway is verified gone) is stale.
    if (parent !== undefined && parent === lock.pid) return { kind: 'none' };
    return unconfirmed(`实例锁由活着的进程 pid ${lock.pid} 持有`, 'gateway-running', lock.pid);
  }
  if (lock.state === 'unknown') {
    return unconfirmed('无法确认机器人实例锁的持有者是否还活着', 'lock-unknown', lock.pid);
  }
  if (parent === undefined) return unconfirmed('读不到该进程的父进程');
  if (parent === candidate.job.gateway.pid) return unconfirmed(`它的父进程仍是 job 记录的网关 pid ${parent}`);
  if (descriptorPort === undefined || port !== descriptorPort) {
    return unconfirmed(`配置的 core 端口 ${String(port)} 与描述符里的 ${String(descriptorPort)} 不一致`);
  }
  const processStart = deps.runtime.readIdentity(pid);
  if (!processStart) return unconfirmed('读不到该进程的出生身份');
  const pidNamespace = deps.runtime.readPidNamespace(pid);
  const inspection = inspect({ pid, processStart, ...(pidNamespace ? { pidNamespace } : {}) }, deps.runtime);
  if (inspection.status === 'stale') return { kind: 'none' };
  if (inspection.status === 'unverifiable') return unconfirmed('无法核验该进程的出生身份');
  const birth = inspection.attestation;
  return {
    kind: 'orphan',
    core: { pid: birth.pid, processStart: birth.processStart, ...(birth.pidNamespace ? { pidNamespace: birth.pidNamespace } : {}) },
    port: descriptorPort,
  };
}

/** The one warning line for a core that was left alone (see OrphanAdvice). */
function unconfirmedOrphanWarning(member: string, verdict: Extract<OrphanVerdict, { kind: 'unconfirmed' }>): string {
  const which = [verdict.pid > 1 ? `pid ${verdict.pid}` : '', verdict.port !== undefined ? `端口 ${verdict.port}` : '']
    .filter(Boolean).join('，');
  const head = `⚠️  企业微信连接 ${member}：旧版 Dashboard 记录的网关已不在`;
  const again = '下一次 `botmux start` / `botmux restart` 会再检查。';
  if (verdict.advice === 'gateway-running') {
    return `${head}，有网关（pid ${verdict.holder}）正在运行这个机器人${which ? `，core ${which}` : ''}；`
      + `旧记录保留到那个网关停止之后，${again}`;
  }
  if (verdict.advice === 'lock-unknown') {
    return `${head}，它的 core 可能还在运行${which ? `（${which}）` : ''}；无法确认是否有网关正在运行这个机器人`
      + `（${verdict.why}），未处理。确认没有网关在运行它之后，若端口仍被占用、新网关一直启动失败，`
      + `再手动结束这个 core${verdict.pid > 1 ? `（kill ${verdict.pid}）` : ''}；${again}`;
  }
  return `${head}，但它的 core 可能还在运行${which ? `（${which}）` : ''}；`
    + `无法确认是旧网关留下的（${verdict.why}），未处理。若它是遗留进程，会让新网关一直启动失败，`
    + `确认后手动结束它${verdict.pid > 1 ? `（kill ${verdict.pid}）` : ''}；${again}`;
}

/**
 * The environment variable a connection's configuration takes its credential
 * from (`secretEnv`), when `env` does not have it (unset or empty). undefined
 * when the configuration names none, or cannot be read (nothing to check).
 */
function missingCredentialEnv(connection: WecomFleetConnection, env: NodeJS.ProcessEnv): string | undefined {
  if (connection.config.presence !== 'present') return undefined;
  let secretEnv: unknown;
  try {
    secretEnv = JSON.parse(connection.config.text)?.secretEnv;
  } catch {
    return undefined;
  }
  if (typeof secretEnv !== 'string' || !secretEnv) return undefined;
  return env[secretEnv] ? undefined : secretEnv;
}

/**
 * Run the migration over every job file in `<root>/dashboard-jobs`. Never
 * throws for anything it finds on disk or in the process table.
 */
export async function migrateLegacyDashboardGateways(deps: LegacyGatewayMigrationDeps): Promise<LegacyMigrationSummary> {
  const summary: LegacyMigrationSummary = { migrated: [], keptStopped: [], forgotten: [], orphansStopped: [], remaining: [] };
  const jobsDir = legacyDashboardJobsDir(deps.root);
  let names: string[];
  try {
    names = readdirSync(jobsDir).filter(name => JOB_FILE.test(name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      deps.warn(`⚠️  读不了 ${jobsDir}（${(err as Error).message}），本次跳过旧 Dashboard 企业微信网关的迁移。`);
    }
    return summary;
  }
  if (names.length === 0) return summary;

  let connections: WecomFleetConnection[];
  try {
    connections = deps.listConnections();
  } catch (err) {
    deps.warn(`⚠️  企业微信连接登记表或期望状态文件无法读取（${(err as Error).message}），`
      + '旧 Dashboard 拉起的网关保持原样，修好后下一次 `botmux start` / `botmux restart` 再迁移。');
    return summary;
  }
  const registered = new Map(connections.map(connection => [connection.configId, connection]));

  let live: Candidate[] = [];
  const gone: Candidate[] = [];
  for (const name of names.sort()) {
    const configId = name.slice(0, 64);
    const connection = registered.get(configId);
    if (!connection) continue;
    const path = join(jobsDir, name);
    const job = readLegacyJob(path, configId);
    if (!job) {
      deps.warn(`⚠️  企业微信连接 ${connection.memberName}：旧 Dashboard 记录 ${path} 无法解析，未处理。`);
      continue;
    }
    const inspection = inspect(job.gateway, deps.runtime);
    if (inspection.status === 'unverifiable') {
      deps.warn(`⚠️  企业微信连接 ${connection.memberName}：无法核验旧 Dashboard 网关（pid ${job.gateway.pid}）的出生身份，未处理。`);
      continue;
    }
    if (inspection.status === 'exact') {
      const variable = missingCredentialEnv(connection, deps.env ?? process.env);
      if (variable) {
        // It runs fine in its own environment; the fleet started from this one
        // would fail at once (credential_env_missing). Leave it be.
        deps.warn(`⚠️  企业微信连接 ${connection.memberName}：配置从环境变量 ${variable} 读取凭据，当前环境里没有这个变量；`
          + `旧版 Dashboard 拉起的网关（pid ${job.gateway.pid}）在它自己的环境里能运行，迁进 fleet 就会断开，因此保持原样。`
          + `在带有 ${variable} 的环境里执行 \`botmux restart\`，或把配置改为凭据文件后，再迁移。`);
        summary.remaining.push(configId);
        continue;
      }
      live.push({ connection, path, job, gateway: inspection.attestation });
    } else {
      gone.push({ connection, path, job });
    }
  }

  if (live.length > 0) {
    try {
      const records = deps.readDesired();
      const toRecord: string[] = [];
      for (const candidate of live) {
        const intent = laterIntent(records.get(candidate.connection.configId), candidate.job);
        if (intent === 'stopped') candidate.keepStopped = true;
        else if (intent !== 'running') toRecord.push(candidate.connection.configId);
      }
      if (toRecord.length > 0) deps.markRunning(toRecord);
    } catch (err) {
      deps.warn(`⚠️  未能把 ${live.map(c => c.connection.memberName).join(', ')} 记为运行（${(err as Error).message}）；`
        + '旧 Dashboard 拉起的网关保持原样，下一次 `botmux start` / `botmux restart` 再迁移。');
      summary.remaining.push(...live.map(candidate => candidate.connection.configId));
      live = [];
    }
  }
  deps.afterStep?.('recorded', live.map(candidate => candidate.connection.configId));

  for (const candidate of live) {
    candidate.core = identifyCore(candidate, deps) ?? candidate.job.journaledCore;
    try {
      journal(candidate, deps);
    } catch (err) {
      // Only an interrupted run needs the journal; this one still knows the core.
      deps.warn(`⚠️  企业微信连接 ${candidate.connection.memberName}：未能记录迁移进度（${(err as Error).message}），继续。`);
    }
  }
  // Gateways already gone: a core journaled by an earlier run is checked again
  // below; otherwise look for an orphan it may have left, journal it before
  // any signal, or warn and keep the job when it cannot be proven.
  for (const candidate of gone) {
    if (candidate.job.journaledCore) {
      candidate.core = candidate.job.journaledCore;
      candidate.orphan = candidate.job.journaledOrphan;
      continue;
    }
    const verdict = identifyOrphanCore(candidate, deps);
    if (verdict.kind === 'orphan') {
      candidate.core = verdict.core;
      candidate.orphan = true;
      try {
        journal(candidate, deps);
      } catch (err) {
        deps.warn(`⚠️  企业微信连接 ${candidate.connection.memberName}：未能记录迁移进度（${(err as Error).message}），继续。`);
      }
    } else if (verdict.kind === 'unconfirmed') {
      candidate.unconfirmed = true;
      deps.warn(unconfirmedOrphanWarning(candidate.connection.memberName, verdict));
    }
  }
  const gatewayStop = await stopAll(live.map(candidate => candidate.gateway!), LEGACY_GATEWAY_STOP_GRACE_MS, deps);
  const gatewaySurvivors = new Set(gatewayStop.survivors.map(target => target.pid));
  deps.afterStep?.('gateways-stopped', live.map(candidate => candidate.connection.configId));

  const settled: Candidate[] = [];
  for (const candidate of live) {
    if (gatewaySurvivors.has(candidate.gateway!.pid)) {
      deps.warn(`⚠️  企业微信连接 ${candidate.connection.memberName}：旧网关（pid ${candidate.gateway!.pid}）`
        + '强制结束后仍未退出，保留其记录，下一次 `botmux start` / `botmux restart` 再处理。');
      summary.remaining.push(candidate.connection.configId);
    } else {
      settled.push(candidate);
    }
  }
  for (const candidate of gone) {
    if (candidate.unconfirmed) {
      summary.remaining.push(candidate.connection.configId);
      continue;
    }
    settled.push(candidate);
  }

  const coreTargets = new Map<Candidate, FleetProcessAttestation>();
  const unverifiedCores = new Set<Candidate>();
  for (const candidate of settled) {
    if (!candidate.core) continue;
    const inspection = inspect(candidate.core, deps.runtime);
    if (inspection.status === 'exact') coreTargets.set(candidate, inspection.attestation);
    if (inspection.status === 'unverifiable') {
      deps.warn(`⚠️  企业微信连接 ${candidate.connection.memberName}：无法核验旧 core（pid ${candidate.core.pid}）的出生身份，`
        + '未处理，保留其记录，下一次 `botmux start` / `botmux restart` 再检查。');
      unverifiedCores.add(candidate);
    }
  }
  const coreStop = await stopAll([...coreTargets.values()], LEGACY_CORE_STOP_GRACE_MS, deps);
  const coreSurvivors = new Set(coreStop.survivors.map(target => target.pid));
  deps.afterStep?.('cores-stopped', settled.map(candidate => candidate.connection.configId));

  for (const candidate of settled) {
    const core = coreTargets.get(candidate);
    if (core && coreSurvivors.has(core.pid)) {
      deps.warn(`⚠️  企业微信连接 ${candidate.connection.memberName}：旧 core（pid ${core.pid}）`
        + '强制结束后仍未退出，保留其记录，下一次 `botmux start` / `botmux restart` 再处理。');
      summary.remaining.push(candidate.connection.configId);
      continue;
    }
    if (unverifiedCores.has(candidate)) {
      summary.remaining.push(candidate.connection.configId);
      continue;
    }
    try {
      unlinkSync(candidate.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        deps.warn(`⚠️  未能删除 ${candidate.path}（${(err as Error).message}）；下一次启动会再清理。`);
      }
    }
    const member = candidate.connection.memberName;
    if (candidate.gateway && candidate.keepStopped) {
      summary.keptStopped.push(candidate.connection.configId);
      deps.info(`企业微信连接 ${member}：已停下旧版 Dashboard 拉起的网关（pid ${candidate.gateway.pid}）；`
        + '按之后记下的「停止」保持停止，需要时执行 `botmux wecom start`。');
    } else if (candidate.gateway) {
      summary.migrated.push(candidate.connection.configId);
      deps.info(`企业微信连接 ${member}：已停下旧版 Dashboard 拉起的网关（pid ${candidate.gateway.pid}），改由 fleet 管理。`);
    } else if (candidate.job.journaledLive) {
      // An earlier run recorded this connection and stopped its gateway, then
      // was interrupted: this run only finished the work.
      const kept = candidate.job.journaledKeptStopped === true;
      (kept ? summary.keptStopped : summary.migrated).push(candidate.connection.configId);
      deps.info(`企业微信连接 ${member}：完成了上一次中断的迁移（旧版 Dashboard 拉起的网关 pid ${candidate.job.gateway.pid} 已停下）`
        + (kept ? '；按之后记下的「停止」保持停止，需要时执行 `botmux wecom start`。' : '，改由 fleet 管理。'));
    } else if (candidate.orphan && core && coreStop.signalled.has(core.pid)) {
      summary.orphansStopped.push(candidate.connection.configId);
      deps.info(`企业微信连接 ${member}：旧网关此前已不在，已停下它留下的 core（pid ${core.pid}）；`
        + `该连接当前未运行，需要时执行 \`botmux wecom start ${candidate.connection.configId}\`。`);
    } else {
      // Nothing of it was running any more (a core journaled by an earlier run
      // included): the job file was all that was left.
      summary.forgotten.push(candidate.connection.configId);
    }
  }
  return summary;
}

/** Parent pid, from /proc on Linux and `ps` elsewhere. */
export function readParentPid(pid: number): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const fields = procStatFieldsAfterComm(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      const parent = Number(fields?.[1]);
      return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
    } catch {
      return undefined;
    }
  }
  const ps = ['/usr/bin/ps', '/bin/ps'].find(candidate => existsSync(candidate));
  if (!ps) return undefined;
  try {
    const out = execFileSync(ps, ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    }).trim();
    const parent = Number(out);
    return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When this boot began: Linux `/proc/stat` `btime` (whole seconds). Elsewhere
 * not needed — process start identities there are absolute times (`ps lstart`),
 * which a process of a later boot cannot repeat.
 */
export function readBootTime(
  platform: NodeJS.Platform = process.platform,
  readProcStat: () => string = () => readFileSync('/proc/stat', 'utf8'),
): { kind: 'known'; ms: number } | { kind: 'unknown' } | { kind: 'not-needed' } {
  if (platform !== 'linux') return { kind: 'not-needed' };
  try {
    const line = readProcStat().split('\n').find(entry => entry.startsWith('btime '));
    const seconds = Number(line?.slice('btime '.length).trim());
    return Number.isSafeInteger(seconds) && seconds > 0 ? { kind: 'known', ms: seconds * 1000 } : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

export function productionLegacyMigrationDeps(
  log: { warn(line: string): void; info(line: string): void },
): LegacyGatewayMigrationDeps {
  const root = wecomRoot();
  const runtime = fleetProcessIdentityRuntime;
  return {
    root,
    listConnections: () => listWecomFleetConnections(root),
    readDesired: () => {
      const snapshot = readWecomFleetDesiredState(root);
      if (snapshot.status !== 'ok') throw new Error(snapshot.reason);
      return snapshot.connections;
    },
    markRunning: configIds => {
      updateWecomFleetDesiredState(connections => {
        // Stamped inside the file's lock, like every other writer: record times follow write order.
        const updatedAt = new Date().toISOString();
        for (const configId of configIds) connections.set(configId, { desired: 'running', updatedAt });
      }, { root });
    },
    runtime,
    readStartIdentity: readProcessStartIdentity,
    readParentPid,
    readBootId: readLinuxBootIdentity,
    readBootTime: () => readBootTime(),
    fileWrittenAt: path => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return undefined;
      }
    },
    env: process.env,
    isZombie: isLinuxZombie,
    signal: (target, signal) => signalAttestedFleetProcess(target, signal, runtime),
    now: Date.now,
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    warn: line => log.warn(line),
    info: line => log.info(line),
  };
}
