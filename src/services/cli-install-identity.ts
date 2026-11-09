import { readlinkSync, realpathSync, statSync } from 'node:fs';

/**
 * Identity of one executable file, precise enough to tell "the process is
 * still running the binary that was on disk when it started" apart from "the
 * install was replaced under it".
 *
 * `dev` is deliberately NOT part of the comparison: a bind mount / overlay
 * view can present the same file under a different device id, while inode,
 * size and mtime describe the same content. See `compareRunningToInstall`.
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
 */
export function readRunningExeIdentity(pid: number): ExecutableIdentity | undefined {
  if (process.platform !== 'linux') return undefined;
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const procLink = `/proc/${pid}/exe`;
  try {
    // Diagnostic text only. Once the old install is unlinked the link reads
    // `/path/to/old (deleted)`; the file itself is still reachable through the
    // magic link, so we stat the link (not the stripped text path).
    const link = readlinkSync(procLink);
    const path = link.endsWith(DELETED_SUFFIX) ? link.slice(0, -DELETED_SUFFIX.length) : link;
    return statIdentity(procLink, 'linux-proc-exe', path);
  } catch {
    // The process is gone, or /proc is not readable for it. Unknown, never
    // "stale": an unreadable running identity must not trigger a reclaim.
    return undefined;
  }
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
 * - inode changed  → the process holds a different image → `stale`
 * - size/mtime changed on the same inode → the file was rewritten in place
 *   after the process mapped it → `stale`
 * - otherwise → `current`
 *
 * `dev` is intentionally ignored: bind mounts and overlayfs can expose the
 * same physical file with a different device number. Comparing it would turn
 * every aliased view into a false "stale" and cause exactly the churn this
 * mitigation exists to stop. A truly different filesystem with a colliding
 * inode AND identical size/mtime is not reachable through the same entry path
 * within one detection cycle.
 */
export function compareRunningToInstall(
  running: ExecutableIdentity | undefined,
  install: ExecutableIdentity | undefined,
): ExecutableIdentityComparison {
  if (!running || !install) return 'unknown';
  if (running.ino !== install.ino) return 'stale';
  if (running.size !== install.size || running.mtimeNs !== install.mtimeNs) return 'stale';
  return 'current';
}
