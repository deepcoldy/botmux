import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { procStatStartTime } from './proc-stat.js';

const LINUX_BOOT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINUX_DURABLE_IDENTITY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/i;
const WINDOWS_DURABLE_IDENTITY_RE = /^\d+$/;
const POSIX_UTC_DURABLE_PREFIX = 'utc:';

/** True only for durable birth identities whose value cannot drift when host timezone changes. */
export function isTimezoneStableProcessIdentity(identity: string | undefined): boolean {
  if (!identity) return false;
  return identity.startsWith(POSIX_UTC_DURABLE_PREFIX)
    || LINUX_DURABLE_IDENTITY_RE.test(identity)
    || WINDOWS_DURABLE_IDENTITY_RE.test(identity);
}

/** Match a live durable identity against a recorded one, preserving rolling-upgrade compatibility
 *  for pre-UTC macOS/POSIX rows that still store an untagged local-timezone `lstart` string. */
export function durableProcessIdentityMatches(
  pid: number,
  recorded: string | undefined,
  current: string | undefined,
): boolean {
  if (!recorded || !current) return false;
  if (current === recorded) return true;
  if (process.platform !== 'linux' && process.platform !== 'win32'
    && current.startsWith(POSIX_UTC_DURABLE_PREFIX)
    && !isTimezoneStableProcessIdentity(recorded)) {
    return readProcessStartIdentity(pid) === recorded;
  }
  return false;
}

/** Identity suitable for durable process ownership, including across reboots and timezone changes. */
export function readDurableProcessIdentity(pid: number): string | undefined {
  if (process.platform === 'linux') {
    const started = readProcessStartIdentity(pid);
    if (!started) return undefined;
    const boot = readLinuxBootIdentity();
    return boot ? `${boot}:${started}` : undefined;
  }
  if (process.platform === 'win32') return readProcessStartIdentity(pid);
  const started = readPosixProcessStart(pid, 'UTC0');
  return started ? `${POSIX_UTC_DURABLE_PREFIX}${started}` : undefined;
}

/** A zombie cannot run code or hold service ports, even though kill(0) succeeds. */
export function isLinuxZombie(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
  } catch { return false; }
}

/** Kernel-generated identity that changes on every Linux boot. */
export function readLinuxBootIdentity(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const bootId = readFileSync(
      '/proc/sys/kernel/random/boot_id',
      'utf8',
    ).trim();
    return LINUX_BOOT_ID_RE.test(bootId)
      ? bootId.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stable process-birth identity used to reject stale locks after PID reuse.
 */
export function readProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  if (process.platform === 'linux') {
    try {
      return procStatStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      // Disappeared or unreadable: never fall through to ambient ps.
    }
    return undefined;
  }
  if (process.platform === 'win32') {
    try {
      const started = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; `
          + 'if ($p) { $p.CreationDate.ToUniversalTime().Ticks }',
      ], {
        encoding: 'utf-8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return started || undefined;
    } catch {
      return undefined;
    }
  }
  return readPosixProcessStart(pid);
}

function readPosixProcessStart(pid: number, tz?: string): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const ps = systemPsBin();
  if (!ps) return undefined;
  try {
    const started = execFileSync(
      ps,
      ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf-8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C', ...(tz ? { TZ: tz } : {}) },
      },
    ).trim();
    return started || undefined;
  } catch {
    return undefined;
  }
}

function systemPsBin(): string | undefined {
  for (const candidate of ['/usr/bin/ps', '/bin/ps']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
