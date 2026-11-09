import { readlinkSync, realpathSync, statSync } from 'node:fs';

import { readProcessStartIdentity } from '../utils/process-identity.js';

/**
 * Identity of one executable file, precise enough to tell "the process is
 * still running the binary that was on disk when it started" apart from "the
 * install was replaced under it".
 *
 * `dev` IS part of the comparison. Inode numbers are only unique within one
 * filesystem, so dropping the device id would let an unrelated filesystem's
 * inode look like the same object. A different device is `unknown` rather than
 * `current`: a bind/overlay view may still name the same backing file, but
 * that mapping must be proven, not assumed, and an unprovable identity must
 * never authorize an automatic reclaim.
 *
 * `path` is diagnostic only (it is what `readlink`/`realpath` reported); it
 * must never be compared, because an upgrade rewrites the symlink target.
 */
export interface ExecutableIdentity {
  path: string;
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  /** `linux-proc-exe` is the process's own kernel view; `install-stat` is a
   *  filesystem lookup of the configured install entry. */
  source: 'linux-proc-exe' | 'install-stat';
}

export type ExecutableIdentityComparison = 'current' | 'stale' | 'unknown';

/** The ` (deleted)` suffix the kernel appends once an open executable has been
 *  unlinked. It is a property of the path text, not of the inode we stat. */
const DELETED_SUFFIX = ' (deleted)';

function statIdentity(
  statPath: string,
  source: ExecutableIdentity['source'],
  displayPath = statPath,
): ExecutableIdentity | undefined {
  try {
    const st = statSync(statPath, { bigint: true });
    if (!st.isFile()) return undefined;
    return {
      path: displayPath,
      dev: st.dev.toString(),
      ino: st.ino.toString(),
      size: st.size.toString(),
      mtimeNs: st.mtimeNs.toString(),
      source,
    };
  } catch {
    return undefined;
  }
}

/**
 * Identity of the exact executable image a live process is running, from the
 * kernel's own view of it.
 *
 * Linux: `/proc/<pid>/exe` follows the process's mm, so after an in-place
 * install replacement it still resolves to the OLD inode (with a ` (deleted)`
 * suffix when the old file was unlinked). This is the only source that proves
 * what the process actually runs; statting the current install path does not.
 *
 * Other platforms return `undefined` (unknown). macOS has no equivalent proven
 * source here, and the caller must not auto-reclaim on an unknown identity.
 *
 * `expectedProcStart` is the birth token already attested for this pid. The pid
 * can be reused between a previous read and this stat, so the identity is only
 * returned when the process birth is the same before and after the exe read —
 * and matches the caller's expectation when one is supplied. Sending this over
 * private IPC is not proof on its own; the read has to be bound to one process.
 */
export function readRunningExeIdentity(
  pid: number,
  expectedProcStart?: string,
): ExecutableIdentity | undefined {
  if (process.platform !== 'linux') return undefined;
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const procLink = `/proc/${pid}/exe`;
  const before = readProcessStartIdentity(pid);
  if (!before) return undefined;
  if (expectedProcStart !== undefined && before !== expectedProcStart) return undefined;
  try {
    // Diagnostic text only. Once the old install is unlinked the link reads
    // `/path/to/old (deleted)`; the file itself is still reachable through the
    // magic link, so we stat the link (not the stripped text path).
    const link = readlinkSync(procLink);
    const path = link.endsWith(DELETED_SUFFIX) ? link.slice(0, -DELETED_SUFFIX.length) : link;
    const identity = statIdentity(procLink, 'linux-proc-exe', path);
    if (!identity) return undefined;
    // A pid reused between the two reads would otherwise pair one process's
    // birth token with another process's executable.
    return readProcessStartIdentity(pid) === before ? identity : undefined;
  } catch {
    // The process is gone, or /proc is not readable for it. Unknown, never
    // "stale": an unreadable running identity must not trigger a reclaim.
    return undefined;
  }
}

/** Same physical object, with no "unknown" escape hatch: the device AND inode
 *  must match and the metadata must be unchanged. Used to re-validate that a
 *  previously attested running CLI is still the very object a claim named. */
export function sameExecutableObject(
  a: ExecutableIdentity | undefined,
  b: ExecutableIdentity | undefined,
): boolean {
  if (!a || !b) return false;
  return a.dev === b.dev
    && a.ino === b.ino
    && a.size === b.size
    && a.mtimeNs === b.mtimeNs;
}

/**
 * Identity of the file the configured install entry resolves to RIGHT NOW.
 * `realpath` first so a versioned-release symlink (`current -> releases/...`)
 * compares by target inode, not by the stable symlink inode.
 */
export function resolveInstallIdentity(entryPath: string): ExecutableIdentity | undefined {
  if (!entryPath) return undefined;
  try {
    return statIdentity(realpathSync(entryPath), 'install-stat');
  } catch {
    return undefined;
  }
}

/**
 * Does the live process still run the executable that the install entry
 * currently names?
 *
 * - device differs → the two stats are not provably the same physical object
 *   (bind/overlay/scratch alias) → `unknown`, never `current`
 * - inode changed  → the process holds a different image → `stale`
 * - size/mtime changed on the same inode → the file was rewritten in place
 *   after the process mapped it → `stale`
 * - otherwise → `current`
 *
 * The device check is what makes `current` a physical claim instead of a
 * same-numbers guess: inode numbers are only unique per filesystem. A proven
 * launcher/sandbox source mapping can opt in later; until then an unprovable
 * view stays `unknown` and is skipped by the automatic reclaim.
 */
export function compareRunningToInstall(
  running: ExecutableIdentity | undefined,
  install: ExecutableIdentity | undefined,
): ExecutableIdentityComparison {
  if (!running || !install) return 'unknown';
  if (running.dev !== install.dev) return 'unknown';
  if (running.ino !== install.ino) return 'stale';
  if (running.size !== install.size || running.mtimeNs !== install.mtimeNs) return 'stale';
  return 'current';
}

/**
 * `compareRunningToInstall` for a process PROVEN to have been launched from the
 * install entry: the entry, statted right before spawn, must have resolved to
 * the very object the process runs. Otherwise the entry may be a wrapper script
 * or launcher that execs a binary elsewhere; its identity never matches the
 * running image, and that mismatch must not read as an upgrade.
 *
 * The sweep and the pre-suspend re-validation both decide through this, so a
 * queued claim is never judged by a looser rule than the one that queued it.
 */
export function compareLaunchedInstall(
  running: ExecutableIdentity | undefined,
  installAtSpawn: ExecutableIdentity | undefined,
  install: ExecutableIdentity | undefined,
): ExecutableIdentityComparison {
  if (!sameExecutableObject(running, installAtSpawn)) return 'unknown';
  return compareRunningToInstall(running, install);
}
