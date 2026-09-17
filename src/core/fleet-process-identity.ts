import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { readDurableProcessIdentity } from '../utils/process-identity.js';

export interface FleetProcessAttestation {
  pid: number;
  processStart: string;
  /** Present only for legacy rows whose ownership was established by command. */
  commandLine?: string;
  pidNamespace?: string;
}

export interface FleetProcessIdentityRuntime {
  readIdentity(pid: number): string | undefined;
  readCommandLine(pid: number): string | undefined;
  readPidNamespace(pid: number): string | undefined;
  pidExists(pid: number): boolean;
}

export type FleetProcessInspection =
  | { status: 'exact'; attestation: FleetProcessAttestation }
  | { status: 'stale' }
  | { status: 'unverifiable' };

const BUILTIN_FLEET_ENTRY_MARKERS = {
  daemon: { token: '__daemon', script: 'index-daemon.js' },
  dashboard: { token: '__dashboard', script: 'index-dashboard.js' },
} as const;

function commandLineHasArg(commandLine: string, arg: string): boolean {
  const escaped = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s\"'])${escaped}(?:$|[\\s\"'])`).test(commandLine);
}

/**
 * Match one of botmux's built-in fleet roles without tying ownership to the
 * current checkout's absolute dist path. A normal install starts a real
 * `index-*.js` file, while the standalone binary uses a hidden `__*` argv
 * token. Both markers survive upgrades and worktree switches.
 */
export function builtinFleetEntryMatches(
  entry: 'daemon' | 'dashboard',
  commandLine: string,
): boolean {
  const { token, script } = BUILTIN_FLEET_ENTRY_MARKERS[entry];
  if (commandLineHasArg(commandLine, token)) return true;
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s\"'\\\\/])${escaped}(?:$|[\\s\"'])`).test(commandLine);
}

function systemPsBin(): string | undefined {
  for (const candidate of ['/usr/bin/ps', '/bin/ps']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function readFleetProcessCommandLine(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const value = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      // A successful empty read is meaningful (Linux kernel thread / zombie):
      // it is definitely not a user-space botmux process, rather than an
      // unreadable identity that should fail closed.
      return value;
    } catch { return undefined; }
  }
  if (process.platform === 'win32') {
    try {
      const value = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($p) { $p.CommandLine }`,
      ], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return value || undefined;
    } catch { return undefined; }
  }
  const ps = systemPsBin();
  if (!ps) return undefined;
  try {
    const value = execFileSync(ps, ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    }).trim();
    return value || undefined;
  } catch { return undefined; }
}

export const fleetProcessIdentityRuntime: FleetProcessIdentityRuntime = {
  readIdentity: readDurableProcessIdentity,
  readCommandLine: readFleetProcessCommandLine,
  readPidNamespace(pid): string | undefined {
    if (process.platform !== 'linux') return undefined;
    try { return readlinkSync(`/proc/${pid}/ns/pid`) || undefined; }
    catch { return undefined; }
  },
  pidExists(pid): boolean {
    try { process.kill(pid, 0); return true; } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  },
};

/**
 * Bind a persisted PID to one exact process generation. The command matcher is
 * only a one-release compatibility bridge for old rows without processStart; a
 * newly-computed checkout path must never override a persisted birth identity.
 * Identity is sampled twice so a PID recycled during inspection is stale.
 */
export function inspectFleetProcess(
  pid: number,
  recordedProcessStart: string | undefined,
  recordedPidNamespace: string | undefined,
  legacyCommandMatches: (commandLine: string) => boolean,
  runtime: FleetProcessIdentityRuntime = fleetProcessIdentityRuntime,
  verifyPersistedCommand = true,
): FleetProcessInspection {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { status: 'stale' };
  const first = runtime.readIdentity(pid);
  if (recordedProcessStart && first && first !== recordedProcessStart) return { status: 'stale' };
  const pidNamespace = runtime.readPidNamespace(pid);
  if (recordedPidNamespace && pidNamespace && pidNamespace !== recordedPidNamespace) return { status: 'stale' };
  if (!first || (recordedPidNamespace && !pidNamespace)) {
    return runtime.pidExists(pid) ? { status: 'unverifiable' } : { status: 'stale' };
  }
  const commandLine = recordedProcessStart && !verifyPersistedCommand
    ? undefined
    : runtime.readCommandLine(pid);
  if (commandLine === undefined && (!recordedProcessStart || verifyPersistedCommand)) {
    return runtime.pidExists(pid) ? { status: 'unverifiable' } : { status: 'stale' };
  }
  if (commandLine !== undefined && !legacyCommandMatches(commandLine)) return { status: 'stale' };
  const second = runtime.readIdentity(pid);
  if (!second) return runtime.pidExists(pid) ? { status: 'unverifiable' } : { status: 'stale' };
  return first === second
    ? {
      status: 'exact',
      attestation: {
        pid,
        processStart: first,
        ...(commandLine !== undefined ? { commandLine } : {}),
        ...(pidNamespace ? { pidNamespace } : {}),
      },
    }
    : { status: 'stale' };
}

/** Re-check the birth identity immediately before addressing a PID. */
export function signalAttestedFleetProcess(
  target: FleetProcessAttestation,
  signal: NodeJS.Signals,
  runtime: FleetProcessIdentityRuntime = fleetProcessIdentityRuntime,
): boolean {
  if (runtime.readIdentity(target.pid) !== target.processStart) return false;
  if (target.pidNamespace && runtime.readPidNamespace(target.pid) !== target.pidNamespace) return false;
  if (target.commandLine !== undefined && runtime.readCommandLine(target.pid) !== target.commandLine) return false;
  // Narrow the remaining PID-reuse window once more after the command read. A
  // true atomic guarantee would require pidfd (not exposed by Node/Bun); this
  // second generation check prevents a replacement during either read from
  // inheriting the signal.
  if (runtime.readIdentity(target.pid) !== target.processStart) return false;
  if (target.pidNamespace && runtime.readPidNamespace(target.pid) !== target.pidNamespace) return false;
  try {
    process.kill(target.pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
