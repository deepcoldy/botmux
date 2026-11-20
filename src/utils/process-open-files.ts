import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
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

/** procfs refused this process's fd table: the pid exists, but the kernel's
 *  ptrace access check (PTRACE_MODE_READ_FSCREDS) says no.
 *
 *  `stage` is where it stopped. `readlink` — the directory listed but every
 *  link was refused — is the shape of a process in a user namespace this uid
 *  does not own: a setuid-root bwrap (e.g. Debian 10's /usr/bin/bwrap 0.3.1)
 *  creates the sandbox's namespace as root, and a non-root caller holds no
 *  CAP_SYS_PTRACE over it even with the same uid. `readdir` — the directory
 *  itself is closed — is a non-dumpable process (its fd dir then belongs to
 *  root). Neither is "nothing open", and a sandbox must not be loosened to get
 *  past it; callers that can locate their file some other way do so. */
export interface ProcessOpenFilesDenial {
  code: 'EACCES' | 'EPERM';
  stage: 'readdir' | 'readlink';
}

export type ProcessOpenFilesProbe =
  | { status: 'ok'; targets: string[] }
  | ({ status: 'denied' } & ProcessOpenFilesDenial)
  | { status: 'unavailable' };

function deniedCode(err: unknown): ProcessOpenFilesDenial['code'] | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM' ? code : undefined;
}

const DENIAL_RECORD_MAX = 64;
const denials = new Map<number, ProcessOpenFilesDenial & { atMs: number }>();

function recordProbe(pid: number, probe: ProcessOpenFilesProbe): void {
  denials.delete(pid);
  if (probe.status !== 'denied') return;
  denials.set(pid, { code: probe.code, stage: probe.stage, atMs: Date.now() });
  if (denials.size > DENIAL_RECORD_MAX) {
    const oldest = denials.keys().next().value as number | undefined;
    if (oldest !== undefined) denials.delete(oldest);
  }
}

/** The denial the most recent fd probe of `pid` (by any caller) ran into, so a
 *  later user-facing message can say "permission denied" instead of a generic
 *  "could not find it". Cleared by the next readable probe of the same pid. */
export function processOpenFilesDenial(pid: number): (ProcessOpenFilesDenial & { atMs: number }) | undefined {
  return denials.get(pid);
}

/** An exited process not reaped yet (or being torn down) has no fd table, and
 *  procfs hands its fd directory to root — so it reads exactly like a refused
 *  one to a non-root caller (measured). It is gone, not refused. */
function processExited(pid: number): boolean {
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return true; }
  const state = stat.slice(stat.lastIndexOf(')') + 1).trim().charAt(0);
  return state === 'Z' || state === 'X';
}

function probeProcfs(pid: number, opts: ProcessOpenFilesOptions): ProcessOpenFilesProbe | undefined {
  const fdDir = `/proc/${pid}/fd`;
  if (!existsSync(fdDir)) return undefined;
  let entries: string[];
  try { entries = readdirSync(fdDir); } catch (err) {
    const code = deniedCode(err);
    return code && !processExited(pid) ? { status: 'denied', code, stage: 'readdir' } : { status: 'unavailable' };
  }
  const targets: string[] = [];
  let read = 0;
  let refused: ProcessOpenFilesDenial['code'] | undefined;
  for (const fd of entries) {
    let target: string;
    try { target = readlinkSync(join(fdDir, fd)); } catch (err) {
      // A descriptor closed since readdir is just gone; only a refusal counts.
      refused ??= deniedCode(err);
      continue;
    }
    read++;
    if (opts.skipDeleted && target.endsWith(' (deleted)')) continue;
    targets.push(target);
  }
  // Access is decided per process, not per descriptor: refused links with none
  // readable is a closed fd table, never an empty one.
  if (read === 0 && refused) return { status: 'denied', code: refused, stage: 'readlink' };
  return { status: 'ok', targets };
}

/**
 * Enumerate the filesystem paths a process currently holds open, telling a
 * refused fd table apart from an unavailable one.
 *
 * Linux: `/proc/<pid>/fd` fast path; falls back to lsof when procfs has no
 * entry for the pid. macOS / BSD: `lsof -n -P -p <pid> -Fn`, keeping only
 * `n/` lines (sockets / pipes render as `n->0x…` or other non-path names).
 * `-n -P` skip host / port name resolution, which is what makes a plain
 * `lsof -p` slow or hang on a process with network sockets.
 */
export function probeProcessOpenFiles(
  pid: number,
  opts: ProcessOpenFilesOptions = {},
): ProcessOpenFilesProbe {
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'unavailable' };
  if (IS_LINUX) {
    const procfs = probeProcfs(pid, opts);
    if (procfs) {
      recordProbe(pid, procfs);
      return procfs;
    }
    // procfs has no entry for this pid — fall through to lsof.
  }
  let out: string;
  try {
    out = execFileSync('lsof', ['-n', '-P', '-p', String(pid), '-Fn'], LSOF_EXEC_OPTIONS);
  } catch {
    return { status: 'unavailable' };
  }
  if (typeof out !== 'string') return { status: 'unavailable' };
  const targets: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('n/')) targets.push(line.slice(1));
  }
  return { status: 'ok', targets };
}

/**
 * Enumerate the filesystem paths a process currently holds open.
 *
 * Returns undefined when enumeration is unavailable (unreadable procfs
 * directory, lsof missing / failed / timed out); an array otherwise. A fd
 * table whose directory lists but whose every link is refused still reads as
 * an empty array here, as it always has: callers that must tell "refused" from
 * "nothing open" use {@link probeProcessOpenFiles}.
 */
export function listProcessOpenFiles(
  pid: number,
  opts: ProcessOpenFilesOptions = {},
): string[] | undefined {
  const probe = probeProcessOpenFiles(pid, opts);
  if (probe.status === 'ok') return probe.targets;
  return probe.status === 'denied' && probe.stage === 'readlink' ? [] : undefined;
}
