import { existsSync, readFileSync, statSync } from 'node:fs';
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

export interface SessionScopeProbeOptions {
  platform?: NodeJS.Platform;
  run?: RunSync;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

export function userSystemdBusEnv(options: {
  platform?: NodeJS.Platform;
  uid?: number;
  isSocket?: (path: string) => boolean;
} = {}): Record<string, string> | undefined {
  if ((options.platform ?? process.platform) !== 'linux') return undefined;
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

function memoryControllerPlacementVerified(
  probeUnit: string,
  run: RunSync,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
): boolean {
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
  const readFile = options.readFile ?? (path => readFileSync(path, 'utf8'));
  const memoryControllerSupported = !!controlGroup
    && controllerDelegated(controlGroup, exists, readFile)
    && memoryControllerPlacementVerified(probeUnit, run, exists, readFile);
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
  if (cachedCapabilities && Date.now() - cachedCapabilities.at < 60_000) return cachedCapabilities.value;
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

/** Resolve only our fixed scope supervisor, never an arbitrary interactive
 * shell. Its single foreground child execs systemd-run and then the payload.
 * A missing/ambiguous child retains the shell identity and the input guard. */
export function sessionScopePayloadPid(panePid: number, options: {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
} = {}): number {
  if ((options.platform ?? process.platform) !== 'linux') return panePid;
  const read = options.readFile ?? (path => readFileSync(path, 'utf8'));
  try {
    const argv = read(`/proc/${panePid}/cmdline`).split('\0');
    if (argv[0] !== '/bin/sh' || argv[1] !== '-c'
      || argv[2] !== SCOPE_PARENT_SCRIPT || argv[3] !== SCOPE_PARENT_NAME
      || argv[4] !== 'systemd-run' || argv[5] !== '--user' || argv[6] !== '--scope'
      || argv[7] !== '--quiet' || argv[8] !== '--collect'
      || !/^--unit=botmux-session-[a-z0-9_.-]+\.scope$/.test(argv[9] ?? '')) return panePid;
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
): ScopedCommand {
  if (!capabilities.cleanupSupported) return { bin, args: [...args], capabilities };
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
    args: [...envArgs, '/bin/sh', '-c', SCOPE_PARENT_SCRIPT,
      SCOPE_PARENT_NAME, 'systemd-run', ...scopeArgs],
    unitName,
    capabilities,
  };
}

export function stopSessionScope(
  sessionId: string,
  options: { platform?: NodeJS.Platform; run?: RunSync; unitName?: string } = {},
): boolean {
  if ((options.platform ?? process.platform) !== 'linux') return false;
  const run = options.run ?? defaultRun;
  return run('systemctl', ['--user', 'stop', options.unitName ?? sessionScopeUnitName(sessionId)]).status === 0;
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
}

function scopeOps(options: Partial<ScopeOps>): ScopeOps {
  return {
    run: options.run ?? defaultRun,
    readFile: options.readFile ?? (path => readFileSync(path, 'utf8')),
    sleep: options.sleep ?? (ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }),
    now: options.now ?? Date.now,
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
  if (!controlGroup) return 'processes unknown';
  try {
    const pids = readFile(`/sys/fs/cgroup${controlGroup}/cgroup.procs`).trim().split(/\s+/).filter(Boolean);
    if (pids.length === 0) return 'no processes left';
    return pids.slice(0, 8).map(pid => {
      let command = '?';
      try { command = readFile(`/proc/${pid}/cmdline`).split('\0').filter(Boolean).join(' ').slice(0, 120) || '?'; } catch { /* exited */ }
      return `${pid} ${command}`;
    }).join('; ') + (pids.length > 8 ? `; … ${pids.length - 8} more` : '');
  } catch {
    return 'processes unknown';
  }
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
 *  SIGKILL without waiting for it to settle. */
function retireScope(sessionId: string, unit: string, run: RunSync): boolean {
  if (stopSessionScope(sessionId, { platform: 'linux', run, unitName: unit })) return true;
  run('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit]);
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
  options: { platform?: NodeJS.Platform; run?: RunSync } = {},
): boolean {
  if ((options.platform ?? process.platform) !== 'linux') return false;
  const run = options.run ?? defaultRun;
  for (const unit of listSessionScopeFallbacks(sessionId, run)) retireScope(sessionId, unit, run);
  return stopSessionScope(sessionId, { platform: 'linux', run });
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
 * the old one.
 */
export function releaseSessionScopeForSpawn(
  sessionId: string,
  generation: number,
  options: { platform?: NodeJS.Platform; workerPid?: number; budgetMs?: number } & Partial<ScopeOps> = {},
): SessionScopeRelease {
  const unitName = sessionScopeUnitName(sessionId);
  if ((options.platform ?? process.platform) !== 'linux') return { unitName };
  const { run, readFile, sleep, now } = scopeOps(options);
  const deadline = now() + (options.budgetMs ?? SESSION_SCOPE_RELEASE_BUDGET_MS);
  const fallback = (why: string): SessionScopeRelease => ({
    unitName: sessionScopeFallbackUnitName(sessionId, options.workerPid ?? process.pid, generation),
    blocked: `${unitName} ${why} (${describeScopeProcesses(unitName, run, readFile)})`,
  });
  // Fallback scopes of an earlier worker of this session (its own
  // deterministic name was blocked) hold descendants too.
  for (const unit of listSessionScopeFallbacks(sessionId, run)) {
    if (now() >= deadline) break;
    retireScope(sessionId, unit, run);
  }
  if (now() >= deadline) return fallback('was not checked: scope cleanup ran out of time');
  stopSessionScope(sessionId, { platform: 'linux', run });
  if (scopeNameFree(unitName, run)) return { unitName };
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
  );
  return { scoped, release };
}

export function __testOnly_resetSessionScopeCapabilityCache(): void {
  cachedCapabilities = undefined;
}
