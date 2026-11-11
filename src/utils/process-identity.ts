import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { procStatStartTime } from './proc-stat.js';

const LINUX_BOOT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identity suitable for durable process ownership, including across reboots. */
export function readDurableProcessIdentity(pid: number): string | undefined {
  const started = readProcessStartIdentity(pid);
  if (!started) return undefined;
  if (process.platform !== 'linux') return started;
  const boot = readLinuxBootIdentity();
  return boot ? `${boot}:${started}` : undefined;
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
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      },
    ).trim();
    return started || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prefix of a self-reported, approximate birth identity. Used when the exact
 * identity cannot be read from inside the process — notably a macOS Seatbelt
 * sandbox, where exec of the setuid-root `/bin/ps` always fails with EPERM.
 * An outside reader (no sandbox) verifies it with {@link approxStartIdentityMatches}.
 */
export const APPROX_START_IDENTITY_PREFIX = 'approx-start-ms:';
/**
 * Self-reported birth time trails the kernel's by runtime bootstrap (measured
 * ~0.8s incl. ps lstart's whole-second truncation, node and bun alike). Far
 * below macOS PID-reuse time (pids climb to 99999 before wrapping).
 */
const APPROX_START_TOLERANCE_MS = 5_000;

/**
 * Birth identity this process derives about itself without spawning anything.
 * macOS only: that is the one platform {@link approxStartIdentityMatches} can
 * verify from outside; elsewhere an unverifiable identity would let a reused
 * PID pass as the original owner, so callers keep failing closed there.
 */
export function readSelfApproxStartIdentity(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  // performance.timeOrigin is the wall clock sampled once at runtime start, so
  // a clock step later in the process's life (before or after taking a lease)
  // cannot skew it — unlike `Date.now() - process.uptime()`.
  return `${APPROX_START_IDENTITY_PREFIX}${Math.round(performance.timeOrigin)}`;
}

/**
 * Whether `pid` is the process that wrote `identity` (from
 * {@link readSelfApproxStartIdentity}). `undefined` when the real birth time
 * cannot be read here, so the caller decides how to treat an unverifiable pid.
 */
export function approxStartIdentityMatches(pid: number, identity: string): boolean | undefined {
  if (!identity.startsWith(APPROX_START_IDENTITY_PREFIX)) return false;
  const claimed = Number(identity.slice(APPROX_START_IDENTITY_PREFIX.length));
  if (!Number.isSafeInteger(claimed)) return false;
  const actual = readProcessStartEpochMs(pid);
  if (actual === undefined) return undefined;
  return Math.abs(claimed - actual) <= APPROX_START_TOLERANCE_MS;
}

const LSTART_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parse `ps -o lstart=` output produced under LANG=C TZ=UTC0. */
export function parseUtcLstart(lstart: string): number | undefined {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(lstart.trim());
  if (!m) return undefined;
  const month = LSTART_MONTHS.indexOf(m[1]!);
  if (month < 0) return undefined;
  const ms = Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  // Date.UTC normalizes overflow (Nov 31 → Dec 1); reject instead of guessing.
  const back = new Date(ms);
  return back.getUTCMonth() === month && back.getUTCDate() === Number(m[2])
    && back.getUTCHours() === Number(m[3]) && back.getUTCMinutes() === Number(m[4]) && back.getUTCSeconds() === Number(m[5])
    ? ms : undefined;
}

/** Wall-clock birth time of `pid` in epoch ms (whole-second precision), macOS only. */
function readProcessStartEpochMs(pid: number): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  if (process.platform !== 'darwin') return undefined;
  const ps = systemPsBin();
  if (!ps) return undefined;
  try {
    return parseUtcLstart(execFileSync(ps, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', TZ: 'UTC0' },
    }));
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
