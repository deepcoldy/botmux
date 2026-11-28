import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { procStatStartTime } from './proc-stat.js';

const LINUX_BOOT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fleet-only wire format: `ps lstart` rendered in UTC, not the host's zone. */
export const FLEET_LSTART_UTC_V1_PREFIX = 'lstart-utc-v1:';

/** Identity suitable for durable process ownership, including across reboots. */
export function readDurableProcessIdentity(pid: number): string | undefined {
  const started = readProcessStartIdentity(pid);
  if (!started) return undefined;
  if (process.platform !== 'linux') return started;
  const boot = readLinuxBootIdentity();
  return boot ? `${boot}:${started}` : undefined;
}

/**
 * Fleet state adds a versioned, timezone-stable POSIX format without changing
 * the other durable lease/session protocols that use the function above.
 *
 * A recorded legacy `lstart` must be read with the legacy renderer as well:
 * otherwise every live macOS fleet member would look stale immediately after
 * upgrade. Callers doing a fresh write omit `recordedIdentity`.
 */
export function readFleetDurableProcessIdentity(
  pid: number,
  recordedIdentity?: string,
): string | undefined {
  if (process.platform === 'linux' || process.platform === 'win32') {
    return readDurableProcessIdentity(pid);
  }
  if (recordedIdentity && !recordedIdentity.startsWith(FLEET_LSTART_UTC_V1_PREFIX)) {
    return readDurableProcessIdentity(pid);
  }
  const started = readPosixProcessStartIdentity(pid, 'UTC0');
  return started ? `${FLEET_LSTART_UTC_V1_PREFIX}${started}` : undefined;
}

/** Only stable fleet identity formats may prove that a live PID was recycled. */
export function canFleetIdentityProvePidReuse(
  identity: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'linux' || platform === 'win32') return true;
  return identity.startsWith(FLEET_LSTART_UTC_V1_PREFIX)
    && identity.length > FLEET_LSTART_UTC_V1_PREFIX.length;
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
  return readPosixProcessStartIdentity(pid);
}

function readPosixProcessStartIdentity(pid: number, timeZone?: 'UTC0'): string | undefined {
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
        env: { PATH: '/usr/bin:/bin', LANG: 'C', ...(timeZone ? { TZ: timeZone } : {}) },
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
