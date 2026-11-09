import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';

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

function systemPsBin(): string | undefined {
  for (const candidate of ['/usr/bin/ps', '/bin/ps']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const DELETED_SUFFIX = ' (deleted)';

/**
 * PIDs on Linux whose executable image lives under `dir`.
 *
 * Used to prove that no launcher/CLI/helper of a released TRAE runtime can
 * still write its private snapshot directory. A recorded CLI pid alone is not
 * enough: bwrap/forge/scope layers may outlive the leaf and a pre-exec launcher
 * has no traex pid yet.
 *
 * Matching is by physical object as well as path: `/proc/<pid>/exe` is statted
 * through the magic link, so a bind/overlay alias that resolves to a different
 * path but the same inode still matches. The ` (deleted)` suffix is a property
 * of the link text, not of the inode, and is stripped before path comparison.
 *
 * Returns `undefined` when the platform has no proven source (macOS) or `/proc`
 * cannot be read. Callers must treat that as "no additional evidence", never as
 * "nothing is running".
 */
export function findProcessesRunningUnder(dir: string): number[] | undefined {
  if (process.platform !== 'linux') return undefined;
  let canonicalDir: string;
  try {
    canonicalDir = realpathSync(dir);
  } catch {
    return undefined;
  }
  const prefix = canonicalDir.endsWith('/') ? canonicalDir : `${canonicalDir}/`;
  const targetObjects = new Set<string>();
  for (const name of ['traex', 'traex-code-mode-host']) {
    try {
      const st = statSync(`${canonicalDir}/${name}`, { bigint: true });
      targetObjects.add(`${st.dev}:${st.ino}`);
    } catch {
      // The file may have been unlinked while a process still runs it; the
      // path scan below still catches that case through ` (deleted)`.
    }
  }
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return undefined;
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const exeLink = `/proc/${entry}/exe`;
    let link: string;
    try {
      link = readlinkSync(exeLink);
    } catch {
      continue;
    }
    const textPath = link.endsWith(DELETED_SUFFIX) ? link.slice(0, -DELETED_SUFFIX.length) : link;
    let resolvedPath: string | undefined;
    try {
      resolvedPath = realpathSync(exeLink);
    } catch {
      resolvedPath = undefined;
    }
    const normalized = resolvedPath?.endsWith(DELETED_SUFFIX)
      ? resolvedPath.slice(0, -DELETED_SUFFIX.length)
      : resolvedPath;
    if (textPath.startsWith(prefix) || normalized?.startsWith(prefix)) {
      pids.push(pid);
      continue;
    }
    if (targetObjects.size > 0) {
      try {
        const st = statSync(exeLink, { bigint: true });
        if (targetObjects.has(`${st.dev}:${st.ino}`)) pids.push(pid);
      } catch {
        // Gone between readlink and stat: not a live writer.
      }
    }
  }
  return pids;
}
