import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const IS_LINUX = platform() === 'linux';

/** Upper bound for one `lsof` probe. These lookups run synchronously on worker
 *  and daemon paths, so an lsof stalled on a slow mount must not freeze the
 *  event loop; a timed-out probe reads as "enumeration unavailable". */
export const LSOF_TIMEOUT_MS = 2_000;

/** Shared bounded options for synchronous `lsof` probes. `-n -P` belong in the
 *  argv (callers only consume file paths), this covers the process limits. */
export const LSOF_EXEC_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  timeout: LSOF_TIMEOUT_MS,
  killSignal: 'SIGKILL',
  maxBuffer: 4 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
};

export interface ProcessOpenFilesOptions {
  /** Drop procfs targets marked ` (deleted)` (unlinked but still open). lsof
   *  output carries no such marker, so this only affects the Linux path. */
  skipDeleted?: boolean;
}

/**
 * Enumerate the filesystem paths a process currently holds open.
 *
 * Linux: `/proc/<pid>/fd` fast path; falls back to lsof when procfs is not
 * readable for the pid. macOS / BSD: `lsof -n -P -p <pid> -Fn`, keeping only
 * `n/` lines (sockets / pipes render as `n->0x…` or other non-path names).
 * `-n -P` skip host / port name resolution, which is what makes a plain
 * `lsof -p` slow or hang on a process with network sockets.
 *
 * Returns undefined only when enumeration itself is unavailable (unreadable
 * procfs, lsof missing / failed / timed out); an empty array means "readable,
 * but nothing open".
 */
export function listProcessOpenFiles(
  pid: number,
  opts: ProcessOpenFilesOptions = {},
): string[] | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      const targets: string[] = [];
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        if (opts.skipDeleted && target.endsWith(' (deleted)')) continue;
        targets.push(target);
      }
      return targets;
    }
    // procfs unreadable for this pid — fall through to lsof.
  }
  let out: string;
  try {
    out = execFileSync('lsof', ['-n', '-P', '-p', String(pid), '-Fn'], LSOF_EXEC_OPTIONS);
  } catch {
    return undefined;
  }
  if (typeof out !== 'string') return undefined;
  const targets: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('n/')) targets.push(line.slice(1));
  }
  return targets;
}
