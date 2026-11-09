import { existsSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { WorkerConfig } from '../global-config.js';

export interface SessionScopeCapabilities {
  cleanupSupported: boolean;
  memoryControllerSupported: boolean;
  reason?: string;
}

type RunSync = (
  command: string,
  args: readonly string[],
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

export interface PidNamespaceProbeOptions {
  platform?: NodeJS.Platform;
  run?: RunSync;
  readlink?: (path: string) => string;
  readFile?: (path: string) => string;
}

export interface SessionScopeProbeOptions extends PidNamespaceProbeOptions {
  exists?: (path: string) => boolean;
}

const CAPABILITY_CACHE_MS = 60_000;

const readUtf8 = (path: string): string => readFileSync(path, 'utf8');

/** `readlink /proc/<pid>/ns/pid` inside the kernel's initial PID namespace: its
 *  inode is the fixed PROC_PID_INIT_INO (0xEFFFFFFC) on every Linux since 3.8. */
export const INITIAL_PID_NAMESPACE = 'pid:[4026531836]';

export type SystemdPidNamespace =
  /** `namespace`: this process's, as `readlink /proc/self/ns/pid` prints it. */
  | { shared: true; basis: 'initial-namespace' | 'user-bus'; namespace: string }
  | { shared: false; reason: string };

/**
 * Whether the user systemd manager resolves PIDs in this process's own PID
 * namespace. Every scope operation here hands it a PID as a plain number —
 * systemd 252's StartTransientUnit takes no pidfd, and `systemd-run --scope`
 * sends its own getpid() — which the manager looks up in ITS namespace. From an
 * inner namespace that still reaches the host's user bus (bwrap --unshare-pid
 * with /run shared) that number names an unrelated host process: the manager
 * moves it into the new scope, and stopping that scope kills it.
 *
 * - In the initial PID namespace the answer is yes without asking anyone: the
 *   host's user manager (user@.service, forked by PID 1) lives there too.
 * - Anywhere else, yes only when the manager is proven to be in this very
 *   namespace: /proc must number this namespace (NSpid has one column); the
 *   process listening on the user bus socket must be visible and in it (the
 *   kernel translates SO_PEERCRED into our namespace, and reports 0, which
 *   busctl omits, for a peer in an outer one); and it must be the process the
 *   bus names as org.freedesktop.systemd1. That is the socket-activated bus a
 *   user manager sets up for itself: it listens, and the bus daemon it spawns
 *   numbers PIDs as we do. The bus reports PIDs as numbered on its own side,
 *   so on its own its answer proves nothing — under a remounted /proc that
 *   number can belong to an unrelated local process — and a bus served by a
 *   standalone daemon or relayed by a local proxy is refused, being
 *   indistinguishable here from one served from outside.
 *
 * Anything that cannot be established counts as not shared.
 */
export function probeSystemdPidNamespace(options: PidNamespaceProbeOptions = {}): SystemdPidNamespace {
  if ((options.platform ?? process.platform) !== 'linux') {
    return { shared: false, reason: 'PID namespaces exist only on Linux' };
  }
  const readlink = options.readlink ?? (path => readlinkSync(path));
  const namespaceOf = (pid: string): string | undefined => {
    try { return readlink(`/proc/${pid}/ns/pid`); } catch { return undefined; }
  };
  const own = namespaceOf('self');
  if (!own) return { shared: false, reason: 'cannot read this process\'s PID namespace (/proc/self/ns/pid)' };
  if (own === INITIAL_PID_NAMESPACE) return { shared: true, basis: 'initial-namespace', namespace: own };

  const notShared = (why: string): SystemdPidNamespace => ({
    shared: false,
    reason: `this process runs in PID namespace ${own}, not the initial one, and ${why}; `
      + 'a PID handed to user systemd could name a different process there',
  });
  const readFile = options.readFile ?? readUtf8;
  let nspid: string[] = [];
  try {
    nspid = /^NSpid:[ \t]*(.*)$/m.exec(readFile('/proc/self/status'))?.[1].trim().split(/\s+/) ?? [];
  } catch { /* unreadable: decided below */ }
  if (nspid.length !== 1) return notShared('/proc here does not number that namespace');

  const run = options.run ?? defaultRun;
  const status = run('busctl', ['--user', '--augment-creds=no', 'status']);
  const peerPid = status.status === 0 ? /^PID=([1-9]\d*)$/m.exec(status.stdout ?? '')?.[1] : undefined;
  if (!peerPid) return notShared('the user bus is served from outside it (no peer PID visible here)');
  const peerNamespace = namespaceOf(peerPid);
  if (peerNamespace !== own) {
    return notShared(`the user bus peer (PID ${peerPid}) runs in ${peerNamespace ?? 'an unreadable PID namespace'}`);
  }

  const reply = run('busctl', [
    '--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
    'GetConnectionUnixProcessID', 's', 'org.freedesktop.systemd1',
  ]);
  const managerPid = reply.status === 0 ? /^u ([1-9]\d*)$/.exec((reply.stdout ?? '').trim())?.[1] : undefined;
  if (!managerPid) {
    const detail = reply.error?.message || reply.stderr?.trim() || reply.stdout?.trim() || `exit ${reply.status ?? 'unknown'}`;
    return notShared(`the bus did not tell the user systemd's PID (${detail})`);
  }
  if (managerPid !== peerPid) {
    return notShared(`the user bus is not served by user systemd itself (bus peer PID ${peerPid}, `
      + `user systemd PID ${managerPid} as the bus numbers it)`);
  }
  return { shared: true, basis: 'user-bus', namespace: own };
}

let cachedPidNamespace: { value: SystemdPidNamespace; at: number } | undefined;

/** Cached {@link probeSystemdPidNamespace}. A shared verdict is kept for the
 *  life of the process, so scopes created under it stay stoppable when a later
 *  bus query fails; a refusal is checked again after CAPABILITY_CACHE_MS, as
 *  the user bus may simply not have been up yet. */
export function systemdPidNamespace(
  probe: () => SystemdPidNamespace = probeSystemdPidNamespace,
  now: () => number = Date.now,
): SystemdPidNamespace {
  if (cachedPidNamespace && (cachedPidNamespace.value.shared || now() - cachedPidNamespace.at < CAPABILITY_CACHE_MS)) {
    return cachedPidNamespace.value;
  }
  const value = probe();
  cachedPidNamespace = { value, at: now() };
  return value;
}

function scopesOffReason(pidNamespace: Extract<SystemdPidNamespace, { shared: false }>): string {
  return `user systemd scopes are off: ${pidNamespace.reason}`;
}

export function userSystemdBusEnv(options: {
  platform?: NodeJS.Platform;
  uid?: number;
  isSocket?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
} = {}): Record<string, string> | undefined {
  if ((options.platform ?? process.platform) !== 'linux') return undefined;
  const env = options.env ?? process.env;
  if (env.BOTMUX_FENCED_RUN === '1') {
    // scripts/fenced-run.ts exports exactly the bus its child may use, none by
    // default. Deriving /run/user/<uid>/bus here, even to complete a single
    // variable, would hand the fenced child the real user manager.
    const declared: Record<string, string> = {};
    if (env.XDG_RUNTIME_DIR) declared.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR;
    if (env.DBUS_SESSION_BUS_ADDRESS) declared.DBUS_SESSION_BUS_ADDRESS = env.DBUS_SESSION_BUS_ADDRESS;
    return Object.keys(declared).length > 0 ? declared : undefined;
  }
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) return undefined;
  const runtimeDir = `/run/user/${uid}`;
  const busPath = `${runtimeDir}/bus`;
  const isSocket = options.isSocket ?? (path => {
    try { return statSync(path).isSocket(); } catch { return false; }
  });
  if (!isSocket(busPath)) return undefined;
  return {
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}`,
  };
}

function defaultRun(
  command: string,
  args: readonly string[],
): ReturnType<RunSync> {
  return spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...userSystemdBusEnv() },
  });
}

function controllerDelegated(
  controlGroup: string,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
): boolean {
  // Deliberately require cgroup v2. On cgroup-v1/hybrid hosts an accepted
  // MemoryMax property can land only in name=systemd and provide no memory
  // containment; reporting that as enforceable would be a false guarantee.
  if (!exists('/sys/fs/cgroup/cgroup.controllers')) return false;
  const path = `/sys/fs/cgroup${controlGroup}`.replace(/\/+$/, '');
  try {
    const controllers = readFile(`${path}/cgroup.controllers`).trim().split(/\s+/);
    const enabled = readFile(`${path}/cgroup.subtree_control`).trim().split(/\s+/)
      .map(value => value.replace(/^\+/, ''));
    return controllers.includes('memory') && enabled.includes('memory');
  } catch {
    return false;
  }
}

/** Whether a scope with MemoryMax set really lands in a cgroup that enforces it:
 *  starts a disposable 16 MB probe scope and reads its memory.max back. */
export function memoryControllerPlacementVerified(
  probeUnit: string,
  options: {
    run: RunSync;
    exists: (path: string) => boolean;
    readFile: (path: string) => string;
    pidNamespace: SystemdPidNamespace;
  },
): boolean {
  const { run, exists, readFile } = options;
  // The probe's systemd-run hands over its own PID; across namespaces the 16 MB
  // limit and the stop below would land on an unrelated process.
  if (!options.pidNamespace.shared) return false;
  const unit = `${probeUnit}-memory.scope`;
  const limit = '16777216';
  try {
    // systemd-run --scope waits for its payload, so start the disposable probe
    // in a background shell, then inspect the live scope's ACTUAL ControlGroup.
    // The unit name is process-derived and contains no shell-controlled input.
    const started = run('sh', [
      '-c',
      'systemd-run --user --scope --quiet --collect --unit="$1" '
        + '--property=MemoryMax=16777216 sleep 5 >/dev/null 2>&1 &',
      'sh',
      unit,
    ]);
    if (started.status !== 0) return false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const shown = run('systemctl', [
        '--user', 'show', unit, '--property=ControlGroup', '--value',
      ]);
      const controlGroup = shown.status === 0 ? shown.stdout.trim() : '';
      if (controlGroup) {
        const memoryMax = `/sys/fs/cgroup${controlGroup}/memory.max`;
        return exists(memoryMax) && readFile(memoryMax).trim() === limit;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    return false;
  } catch {
    return false;
  } finally {
    run('systemctl', ['--user', 'stop', unit]);
  }
}

export function probeSessionScopeCapabilities(
  options: SessionScopeProbeOptions = {},
): SessionScopeCapabilities {
  if ((options.platform ?? process.platform) !== 'linux') {
    return {
      cleanupSupported: false,
      memoryControllerSupported: false,
      reason: 'user systemd scopes are available only on Linux',
    };
  }
  const run = options.run ?? defaultRun;
  const pidNamespace = probeSystemdPidNamespace({ ...options, run });
  if (!pidNamespace.shared) {
    return { cleanupSupported: false, memoryControllerSupported: false, reason: scopesOffReason(pidNamespace) };
  }
  const probeUnit = `botmux-scope-probe-${process.pid}`;
  const scope = run('systemd-run', [
    '--user', '--scope', '--quiet', '--collect', `--unit=${probeUnit}`, 'true',
  ]);
  if (scope.status !== 0) {
    const detail = scope.error?.message || scope.stderr?.trim() || `exit ${scope.status ?? 'unknown'}`;
    return {
      cleanupSupported: false,
      memoryControllerSupported: false,
      reason: `user systemd scope probe failed: ${detail}`,
    };
  }

  const manager = run('systemctl', ['--user', 'show', '--property=ControlGroup', '--value']);
  const controlGroup = manager.status === 0 ? manager.stdout.trim() : '';
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? readUtf8;
  const memoryControllerSupported = !!controlGroup
    && controllerDelegated(controlGroup, exists, readFile)
    && memoryControllerPlacementVerified(probeUnit, { run, exists, readFile, pidNamespace });
  return {
    cleanupSupported: true,
    memoryControllerSupported,
    ...(!memoryControllerSupported
      ? { reason: 'scope cleanup works, but a delegated cgroup-v2 memory controller was not verified' }
      : {}),
  };
}

let cachedCapabilities: { value: SessionScopeCapabilities; at: number } | undefined;

export function sessionScopeCapabilities(): SessionScopeCapabilities {
  if (cachedCapabilities && Date.now() - cachedCapabilities.at < CAPABILITY_CACHE_MS) return cachedCapabilities.value;
  const value = probeSessionScopeCapabilities();
  cachedCapabilities = { value, at: Date.now() };
  return value;
}

export function sessionScopeUnitName(sessionId: string): string {
  return `${sessionScopeUnitStem(sessionId)}.scope`;
}

function sessionScopeUnitStem(sessionId: string): string {
  const safe = sessionId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 96);
  return `botmux-session-${safe || 'unknown'}`;
}

/** Name used when the deterministic unit is still held by a scope that would
 *  not stop (see {@link releaseSessionScopeForSpawn}). Worker pid + spawn
 *  generation keep it unique across worker restarts of the same session. */
export function sessionScopeFallbackUnitName(sessionId: string, workerPid: number, generation: number): string {
  return `${sessionScopeUnitStem(sessionId)}-p${workerPid}g${generation}.scope`;
}

/** Whether `unit` is this session's scope: the deterministic name or one of
 *  its spawn-generation fallbacks. */
export function isSessionScopeUnitFor(sessionId: string, unit: string): boolean {
  const stem = sessionScopeUnitStem(sessionId);
  if (unit === `${stem}.scope`) return true;
  if (!unit.startsWith(`${stem}-p`) || !unit.endsWith('.scope')) return false;
  return /^\d+g\d+$/.test(unit.slice(stem.length + 2, -'.scope'.length));
}

const SESSION_SCOPE_UNIT_RE = /^botmux-session-[a-z0-9_.-]+\.scope$/;

/** Whether a systemd unit is a per-session cleanup scope botmux itself created
 *  (see {@link sessionScopeUnitName} / {@link wrapCommandInSessionScope}). The
 *  fleet cgroup move may leave ONLY one of these: every other unit was chosen
 *  by whoever launched the supervisor and must keep owning it. */
export function isBotmuxSessionScopeUnit(unit: string): boolean {
  return SESSION_SCOPE_UNIT_RE.test(unit);
}

export interface ScopedCommand {
  bin: string;
  args: string[];
  unitName?: string;
  capabilities: SessionScopeCapabilities;
}

/**
 * Whether `pid` has exited and is only waiting to be reaped (a zombie). Such a
 * process is nobody's launch payload. A login shell that runs a hook in the
 * background (autojump, …) and then execs leaves exactly this: an unreaped
 * child under whatever it exec'd into, which never reaps it. Counting it as a
 * child would make a single-payload launch layer look ambiguous forever.
 * Linux only; an unreadable stat (process gone, other platforms) is "no".
 */
export function isZombieProcess(
  pid: number,
  read: (path: string) => string = path => readFileSync(path, 'utf8'),
): boolean {
  try {
    const stat = read(`/proc/${pid}/stat`);
    const close = stat.lastIndexOf(')');
    const state = close >= 0 ? stat.slice(close + 2, close + 3) : '';
    return state === 'Z' || state === 'X';
  } catch {
    return false;
  }
}

const SCOPE_PARENT_SCRIPT = '"$@"; status=$?; exit "$status"';
const SCOPE_PARENT_NAME = 'botmux-session-scope';
/** `$1`: the PID namespace the worker vetted. Anywhere else, drop systemd-run
 *  and its options and run the payload unscoped. */
const SCOPE_PIDNS_SCRIPT = 'ns=$1; shift; [ "$(readlink /proc/self/ns/pid 2>/dev/null)" = "$ns" ] '
  + '|| { while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done; shift; }; exec "$@"';
const SCOPE_PIDNS_NAME = 'botmux-scope-pidns';
const SCOPE_RUN_ARGS = ['systemd-run', '--user', '--scope', '--quiet', '--collect'];

/** The unit a botmux scope supervisor (wrapCommandInSessionScope) was started
 *  for, read from its /proc cmdline; undefined for any other process. */
function scopeSupervisorUnit(pid: string | number, read: (path: string) => string): string | undefined {
  try {
    const argv = read(`/proc/${pid}/cmdline`).split('\0');
    if (argv[0] !== '/bin/sh' || argv[1] !== '-c'
      || argv[2] !== SCOPE_PARENT_SCRIPT || argv[3] !== SCOPE_PARENT_NAME) return undefined;
    // Panes launched before the namespace check run systemd-run directly.
    const checked = argv[4] === '/bin/sh' && argv[5] === '-c' && argv[6] === SCOPE_PIDNS_SCRIPT
      && argv[7] === SCOPE_PIDNS_NAME && /^pid:\[\d+\]$/.test(argv[8] ?? '');
    const run = checked ? 9 : 4;
    if (SCOPE_RUN_ARGS.some((arg, i) => argv[run + i] !== arg)) return undefined;
    return /^--unit=(botmux-session-[a-z0-9_.-]+\.scope)$/.exec(argv[run + SCOPE_RUN_ARGS.length] ?? '')?.[1];
  } catch {
    return undefined;
  }
}

/** Resolve only our fixed scope supervisor, never an arbitrary interactive
 * shell. Its single foreground child (the namespace check, in panes that have
 * it) execs systemd-run and then the payload.
 * A missing/ambiguous child retains the shell identity and the input guard. */
export function sessionScopePayloadPid(panePid: number, options: {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
} = {}): number {
  if ((options.platform ?? process.platform) !== 'linux') return panePid;
  const read = options.readFile ?? (path => readFileSync(path, 'utf8'));
  if (!scopeSupervisorUnit(panePid, read)) return panePid;
  try {
    const children = read(`/proc/${panePid}/task/${panePid}/children`).trim().split(/\s+/)
      .filter(child => !(/^[1-9]\d*$/.test(child) && isZombieProcess(Number(child), read)));
    if (children.length !== 1 || !/^[1-9]\d*$/.test(children[0])) return panePid;
    const child = Number(children[0]);
    return Number.isSafeInteger(child) && child > 1 && child !== panePid ? child : panePid;
  } catch {
    return panePid;
  }
}

export function wrapCommandInSessionScope(
  sessionId: string,
  bin: string,
  args: readonly string[],
  workerConfig?: WorkerConfig,
  capabilities = sessionScopeCapabilities(),
  systemdEnv = userSystemdBusEnv(),
  unitName = sessionScopeUnitName(sessionId),
  pidNamespace?: SystemdPidNamespace,
): ScopedCommand {
  if (!capabilities.cleanupSupported) return { bin, args: [...args], capabilities };
  // systemd-run hands the manager its own PID (probeSystemdPidNamespace).
  const namespace = pidNamespace ?? systemdPidNamespace();
  if (!namespace.shared) {
    return {
      bin,
      args: [...args],
      capabilities: { cleanupSupported: false, memoryControllerSupported: false, reason: scopesOffReason(namespace) },
    };
  }
  const scopeArgs = [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    `--unit=${unitName}`,
    '--property=KillMode=control-group',
  ];
  if (capabilities.memoryControllerSupported && workerConfig?.sessionMemoryMaxBytes !== undefined) {
    scopeArgs.push(`--property=MemoryMax=${workerConfig.sessionMemoryMaxBytes}`);
  }
  scopeArgs.push('--', bin, ...args);
  const envArgs = systemdEnv
    ? Object.entries(systemdEnv).map(([key, value]) => `${key}=${value}`)
    : [];
  return {
    // Put the bus address on the pane argv boundary. Persistent backends do not
    // all forward arbitrary caller env keys, and a long-lived tmux server may
    // have started before the login bus existed.
    bin: '/usr/bin/env',
    // Keep the pane PID outside the owned scope. Some tmux versions move that
    // PID into their own cgroup from the server after fork; an exec-only wrapper
    // lets that late move steal the CLI from our scope. The post-command status
    // handling prevents sh from execing systemd-run, while preserving foreground
    // stdin and the payload's exit status (an async shell list would lose stdin).
    // systemd-run runs in the pane, which shares this worker's PID namespace
    // only if the backend server was started from it: its child checks before
    // exec'ing systemd-run, keeping the one PID that becomes the payload.
    args: [...envArgs, '/bin/sh', '-c', SCOPE_PARENT_SCRIPT, SCOPE_PARENT_NAME,
      '/bin/sh', '-c', SCOPE_PIDNS_SCRIPT, SCOPE_PIDNS_NAME, namespace.namespace,
      'systemd-run', ...scopeArgs],
    unitName,
    capabilities,
  };
}

/**
 * How much earlier than its scope a process must have started to count as
 * foreign. The scope supervisor forks systemd-run, which attaches itself when
 * the scope starts and then execs the CLI in place, so the CLI predates its
 * scope by that bus round trip (2–9 s seen on a loaded host), and whatever it
 * starts is younger still. The CLI is also recognised by its parent, the
 * supervisor started for this very unit, so a manager that took longer than
 * this to start the scope does not make it foreign. A host process that a PID
 * mix-up moved into a scope has usually been running since boot.
 */
export const SCOPE_FOREIGN_PROCESS_LEAD_MS = 5 * 60_000;

/** Unit of `starttime` in /proc/<pid>/stat (USER_HZ) on every Linux ABI botmux runs on. */
const PROC_STAT_TICKS_PER_SECOND = 100;

/** PIDs in a unit's cgroup, numbered in this namespace: cgroup v2, the hybrid
 *  unified mount, or the v1 `name=systemd` tree. */
function scopeCgroupPids(controlGroup: string, readFile: (path: string) => string): string[] | undefined {
  for (const root of ['/sys/fs/cgroup', '/sys/fs/cgroup/unified', '/sys/fs/cgroup/systemd']) {
    let procs: string;
    try { procs = readFile(`${root}${controlGroup}/cgroup.procs`); } catch { continue; }
    // A process outside this PID namespace reads back as 0 (v2) or not at all (v1).
    return procs.split(/\s+/).filter(pid => /^[1-9]\d*$/.test(pid));
  }
  return undefined;
}

function processCommand(pid: string, readFile: (path: string) => string): string {
  try { return readFile(`/proc/${pid}/cmdline`).split('\0').filter(Boolean).join(' ').slice(0, 120) || '?'; } catch { return '?'; }
}

function listProcesses(pids: readonly string[], readFile: (path: string) => string): string {
  return pids.slice(0, 8).map(pid => `${pid} ${processCommand(pid, readFile)}`).join('; ')
    + (pids.length > 8 ? `; … ${pids.length - 8} more` : '');
}

/** /proc/<pid>/stat fields from the third (state) on. */
function processStatFields(pid: string, readFile: (path: string) => string): string[] | undefined {
  try {
    const stat = readFile(`/proc/${pid}/stat`);
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  } catch {
    return undefined;
  }
}

/** Start of a process in ms since boot. systemd's *Monotonic timestamps share
 *  that origin; they part only across a suspend, and then a process looks
 *  younger than it is, never older. */
function processStartMs(stat: readonly string[]): number | undefined {
  const ticks = Number(stat[19]);
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks * 1000 / PROC_STAT_TICKS_PER_SECOND : undefined;
}

/** Processes in `unit` that started more than SCOPE_FOREIGN_PROCESS_LEAD_MS
 *  before the scope did, other than a child of the unit's own supervisor.
 *  Empty when there are none, and whenever that cannot be told (no start
 *  time, cgroup or /proc unreadable). */
function foreignScopeProcesses(
  unit: string,
  shown: { activeEnterTimestampMonotonic: string; controlGroup: string },
  readFile: (path: string) => string,
): string[] {
  const scopeStartedUs = Number(shown.activeEnterTimestampMonotonic);
  if (!shown.controlGroup || !Number.isSafeInteger(scopeStartedUs) || scopeStartedUs <= 0) return [];
  const cutoffMs = scopeStartedUs / 1000 - SCOPE_FOREIGN_PROCESS_LEAD_MS;
  return (scopeCgroupPids(shown.controlGroup, readFile) ?? []).filter(pid => {
    const stat = processStatFields(pid, readFile);
    if (!stat) return false;
    const startedMs = processStartMs(stat);
    return startedMs !== undefined && startedMs < cutoffMs && scopeSupervisorUnit(stat[1], readFile) !== unit;
  });
}

/** `absent`: systemd does not know the unit, so there was nothing to stop. */
type ScopeStop = { outcome: 'stopped' | 'failed' | 'absent' } | { outcome: 'refused'; message: string };

/** `systemctl stop`, unless the scope holds processes botmux cannot have
 *  launched in it: then scope and processes are left alone. */
function stopScope(unit: string, run: RunSync, readFile: (path: string) => string): ScopeStop {
  const shown = run('systemctl', [
    '--user', 'show', unit,
    '--property=LoadState', '--property=ActiveEnterTimestampMonotonic', '--property=ControlGroup',
  ]);
  const property = (name: string): string => (shown.status === 0
    ? new RegExp(`^${name}=(.*)$`, 'm').exec(shown.stdout ?? '')?.[1].trim() ?? ''
    : '');
  if (property('LoadState') === 'not-found') return { outcome: 'absent' };
  const foreign = foreignScopeProcesses(unit, {
    activeEnterTimestampMonotonic: property('ActiveEnterTimestampMonotonic'),
    controlGroup: property('ControlGroup'),
  }, readFile);
  if (foreign.length > 0) {
    return {
      outcome: 'refused',
      message: `left ${unit} running: it holds processes that started over `
        + `${SCOPE_FOREIGN_PROCESS_LEAD_MS / 60_000} min before the scope, so botmux did not launch them `
        + `(${listProcesses(foreign, readFile)})`,
    };
  }
  return { outcome: run('systemctl', ['--user', 'stop', unit]).status === 0 ? 'stopped' : 'failed' };
}

export interface SessionScopeStopOptions {
  platform?: NodeJS.Platform;
  run?: RunSync;
  readFile?: (path: string) => string;
  /** Defaults to the cached {@link systemdPidNamespace}. */
  pidNamespace?: SystemdPidNamespace;
  /** Told why a scope was left running. */
  warn?: (message: string) => void;
}

/** Scopes are touched only where they can be ours: a process that may not hand
 *  PIDs to this manager never created one, and the processes inside are not
 *  visible to the foreign-process check from there either. */
function scopesReachable(options: { platform?: NodeJS.Platform; pidNamespace?: SystemdPidNamespace }): boolean {
  return (options.platform ?? process.platform) === 'linux'
    && (options.pidNamespace ?? systemdPidNamespace()).shared;
}

export function stopSessionScope(
  sessionId: string,
  options: SessionScopeStopOptions & { unitName?: string } = {},
): boolean {
  if (!scopesReachable(options)) return false;
  const { run, readFile, warn } = scopeOps(options);
  const stop = stopScope(options.unitName ?? sessionScopeUnitName(sessionId), run, readFile);
  if (stop.outcome === 'refused') warn(stop.message);
  return stop.outcome === 'stopped';
}

export interface SessionScopeRelease {
  /** Unit name the next launch must use. */
  unitName: string;
  /** Why the deterministic name could not be reused (absent when it could). */
  blocked?: string;
}

interface ScopeOps {
  run: RunSync;
  readFile: (path: string) => string;
  sleep: (ms: number) => void;
  now: () => number;
  warn: (message: string) => void;
}

function scopeOps(options: Partial<ScopeOps>): ScopeOps {
  return {
    run: options.run ?? defaultRun,
    readFile: options.readFile ?? readUtf8,
    sleep: options.sleep ?? (ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }),
    now: options.now ?? Date.now,
    warn: options.warn ?? (message => console.warn(message)),
  };
}

function scopeActiveState(unit: string, run: RunSync): string | undefined {
  const shown = run('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--value']);
  return shown.status === 0 ? shown.stdout.trim() : undefined;
}

/** A unit name systemd-run can create again: never loaded, or stopped. A
 *  failed unit keeps its name until reset-failed. Unknown (systemctl itself
 *  failed) is treated as free: the launch then reports systemd's own error. */
function scopeNameFree(unit: string, run: RunSync): boolean {
  const state = scopeActiveState(unit, run);
  if (state === 'failed') {
    run('systemctl', ['--user', 'reset-failed', unit]);
    return scopeActiveState(unit, run) !== 'failed';
  }
  return state === undefined || state === '' || state === 'inactive';
}

function describeScopeProcesses(unit: string, run: RunSync, readFile: (path: string) => string): string {
  const shown = run('systemctl', ['--user', 'show', unit, '--property=ControlGroup', '--value']);
  const controlGroup = shown.status === 0 ? shown.stdout.trim() : '';
  const pids = controlGroup ? scopeCgroupPids(controlGroup, readFile) : undefined;
  if (!pids) return 'processes unknown';
  return pids.length === 0 ? 'no processes left' : listProcesses(pids, readFile);
}

/** Spawn-generation fallback scopes of this session that systemd still knows. */
function listSessionScopeFallbacks(sessionId: string, run: RunSync): string[] {
  const listed = run('systemctl', [
    '--user', 'list-units', '--all', '--plain', '--no-legend', '--full',
    `${sessionScopeUnitStem(sessionId)}-p*.scope`,
  ]);
  if (listed.status !== 0) return [];
  return listed.stdout.split('\n').map(line => line.trim().split(/\s+/)[0] ?? '')
    .filter(unit => unit !== sessionScopeUnitName(sessionId) && isSessionScopeUnitFor(sessionId, unit));
}

/** Stop a scope; one that will not stop (payload ignoring SIGTERM) gets a
 *  SIGKILL without waiting for it to settle, one holding foreign processes
 *  neither. */
function retireScope(unit: string, ops: ScopeOps): boolean {
  const stop = stopScope(unit, ops.run, ops.readFile);
  if (stop.outcome === 'stopped') return true;
  if (stop.outcome === 'refused') ops.warn(stop.message);
  else if (stop.outcome === 'failed') ops.run('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit]);
  return false;
}

/**
 * Stop every scope this session owns: the deterministic unit and any
 * spawn-generation fallback. Found through systemd rather than remembered in
 * the worker, so a worker that reattached a persistent pane (and never ran the
 * launch that picked a fallback name) still retires it on close / restart.
 * Returns whether the deterministic unit stopped cleanly.
 */
export function stopAllSessionScopes(
  sessionId: string,
  options: SessionScopeStopOptions = {},
): boolean {
  if (!scopesReachable(options)) return false;
  const ops = scopeOps(options);
  for (const unit of listSessionScopeFallbacks(sessionId, ops.run)) retireScope(unit, ops);
  const stop = stopScope(sessionScopeUnitName(sessionId), ops.run, ops.readFile);
  if (stop.outcome === 'refused') ops.warn(stop.message);
  return stop.outcome === 'stopped';
}

/** Upper bound for the synchronous retire-before-launch work. Each systemctl
 *  call is itself capped at 5s; past this budget the launch stops waiting and
 *  moves to a fresh name. */
export const SESSION_SCOPE_RELEASE_BUDGET_MS = 8_000;

/**
 * Retire this session's previous scopes before a fresh launch and pick the
 * unit name to launch under. The deterministic name is reused only once that
 * unit is really gone: `systemctl stop` can fail or time out (a payload that
 * ignores SIGTERM keeps the scope deactivating for TimeoutStopSec), and
 * launching under a still-loaded name fails with "Unit … already exists" on
 * every retry. Such a scope gets a SIGKILL; if it still survives, the launch
 * moves to a spawn-generation name and `blocked` says which processes held
 * the old one. A scope holding foreign processes is left running the same way.
 */
export function releaseSessionScopeForSpawn(
  sessionId: string,
  generation: number,
  options: { platform?: NodeJS.Platform; workerPid?: number; budgetMs?: number; pidNamespace?: SystemdPidNamespace }
    & Partial<ScopeOps> = {},
): SessionScopeRelease {
  const unitName = sessionScopeUnitName(sessionId);
  if (!scopesReachable(options)) return { unitName };
  const ops = scopeOps(options);
  const { run, readFile, sleep, now } = ops;
  const deadline = now() + (options.budgetMs ?? SESSION_SCOPE_RELEASE_BUDGET_MS);
  const fallbackUnitName = sessionScopeFallbackUnitName(sessionId, options.workerPid ?? process.pid, generation);
  const fallback = (why: string): SessionScopeRelease => ({
    unitName: fallbackUnitName,
    blocked: `${unitName} ${why} (${describeScopeProcesses(unitName, run, readFile)})`,
  });
  // Fallback scopes of an earlier worker of this session (its own
  // deterministic name was blocked) hold descendants too.
  for (const unit of listSessionScopeFallbacks(sessionId, run)) {
    if (now() >= deadline) break;
    retireScope(unit, ops);
  }
  if (now() >= deadline) return fallback('was not checked: scope cleanup ran out of time');
  const stop = stopScope(unitName, run, readFile);
  if (stop.outcome === 'refused') return { unitName: fallbackUnitName, blocked: stop.message };
  if (stop.outcome === 'absent' || scopeNameFree(unitName, run)) return { unitName };
  run('systemctl', ['--user', 'kill', '--signal=SIGKILL', unitName]);
  while (now() < deadline) {
    if (scopeNameFree(unitName, run)) return { unitName };
    sleep(50);
  }
  return fallback(`is still ${scopeActiveState(unitName, run) || 'loaded'} after stop and SIGKILL`);
}

/**
 * The launch-time half: retire the old scopes, then wrap the command under
 * whichever unit name is actually free.
 */
export function prepareSessionScopedLaunch(
  sessionId: string,
  generation: number,
  bin: string,
  args: readonly string[],
  workerConfig?: WorkerConfig,
  options: Parameters<typeof releaseSessionScopeForSpawn>[2] & {
    capabilities?: SessionScopeCapabilities;
    systemdEnv?: Record<string, string> | undefined;
  } = {},
): { scoped: ScopedCommand; release: SessionScopeRelease } {
  const release = releaseSessionScopeForSpawn(sessionId, generation, options);
  const scoped = wrapCommandInSessionScope(
    sessionId,
    bin,
    args,
    workerConfig,
    options.capabilities ?? sessionScopeCapabilities(),
    'systemdEnv' in options ? options.systemdEnv : userSystemdBusEnv(),
    release.unitName,
    options.pidNamespace,
  );
  return { scoped, release };
}

export function __testOnly_resetSessionScopeCapabilityCache(): void {
  cachedCapabilities = undefined;
  cachedPidNamespace = undefined;
}
