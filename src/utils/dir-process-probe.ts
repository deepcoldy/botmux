/**
 * Which processes have their current directory inside a given directory.
 * Detection only — nothing here signals or kills a process.
 *
 * Linux reads every `/proc/<pid>/cwd`; a pid that vanished or belongs to
 * another user (EACCES) is skipped, since it cannot be told apart from "not in
 * the directory" and other users' processes cannot sit in this user's worktree
 * without it being shared anyway. macOS / other Unix run one bounded
 * `lsof -n -P -d cwd -Fpn` over all processes. When enumeration itself is
 * unavailable (no procfs, lsof missing, failed or timed out) the probe answers
 * `unknown` and callers must not treat the directory as unused.
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { PROCESS_TABLE_MAX_BUFFER } from './exec-limits.js';

export type DirProcessProbe =
  | { status: 'ok'; pids: number[] }
  | { status: 'unknown'; error: string };

export interface DirProcessProbeOptions {
  platform?: NodeJS.Platform;
  procRoot?: string;
  /** Override for tests: resolves to lsof's stdout, rejects when unavailable. */
  runLsof?: () => Promise<string>;
}

const LSOF_TIMEOUT_MS = 5_000;

function insideAny(path: string, roots: readonly string[]): boolean {
  const target = path.endsWith(' (deleted)') ? path.slice(0, -' (deleted)'.length) : path;
  return roots.some(root => target === root || target.startsWith(root + sep));
}

function dirRoots(dir: string): string[] {
  const roots = new Set([resolve(dir)]);
  try { roots.add(realpathSync(dir)); } catch { /* gone — the resolved form is all we have */ }
  return [...roots];
}

/** Parse `lsof -Fpn` output: `p<pid>` opens a process set, `n<path>` names its cwd. */
export function parseLsofCwdOutput(out: string, dir: string): number[] {
  const roots = dirRoots(dir);
  const pids = new Set<number>();
  let pid: number | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    } else if (line.startsWith('n') && pid !== undefined && insideAny(line.slice(1), roots)) {
      pids.add(pid);
    }
  }
  return [...pids];
}

function defaultRunLsof(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-Fpn'], {
      encoding: 'utf-8',
      timeout: LSOF_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
      // lsof exits 1 when some processes could not be inspected; the readable
      // ones are still listed. Anything else (missing binary, timeout) is unknown.
      const code = (error as { code?: unknown } | null)?.code;
      if (error && !(code === 1 && stdout)) {
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

/** Pid entries of a procfs root. Throws when the root cannot be listed. */
function listProcPids(procRoot: string): string[] {
  return readdirSync(procRoot).filter(entry => /^\d+$/.test(entry));
}

export async function findProcessesWithCwdUnder(
  dir: string,
  opts: DirProcessProbeOptions = {},
): Promise<DirProcessProbe> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'linux') {
    const procRoot = opts.procRoot ?? '/proc';
    let entries: string[];
    try {
      entries = listProcPids(procRoot);
    } catch (error) {
      return { status: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    const roots = dirRoots(dir);
    const pids: number[] = [];
    for (const entry of entries) {
      let cwd: string;
      try { cwd = readlinkSync(`${procRoot}/${entry}/cwd`); } catch { continue; }
      if (insideAny(cwd, roots)) pids.push(Number(entry));
    }
    return { status: 'ok', pids };
  }
  try {
    return { status: 'ok', pids: parseLsofCwdOutput(await (opts.runLsof ?? defaultRunLsof)(), dir) };
  } catch (error) {
    return { status: 'unknown', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Which of `needles` a live process references; null = cannot tell. */
export type LiveReferenceProbe = (needles: readonly string[]) => Promise<ReadonlySet<string> | null>;

export interface LiveReferenceProbeOptions {
  platform?: NodeJS.Platform;
  procRoot?: string;
  /** Override for tests: resolves to `ps`'s stdout, rejects when unavailable. */
  runPs?: () => Promise<string>;
  /** Override for tests: the pid whose own line proves environments are shown. */
  selfPid?: number;
}

function defaultRunPs(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // macOS `-E` appends each process's start environment to its command line.
    execFile('ps', ['-E', '-ww', '-A', '-o', 'pid=,command='], {
      encoding: 'utf-8',
      timeout: LSOF_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: PROCESS_TABLE_MAX_BUFFER,
    }, (error, stdout) => (error ? rejectPromise(error) : resolvePromise(stdout)));
  });
}

/**
 * Which of `needles` some live process still references: as a substring of
 * its argv or of the environment it was started with (TMPDIR=…, a bwrap bind
 * source, a Gateway socket path), or — on Linux — as its cwd (equal or
 * below). The per-session directory sweeps (#1748) use it; like the cwd probe
 * above it never signals a process. Linux reads procfs; macOS reads one
 * `ps -E` listing. Null when neither can be read: the caller must not treat a
 * directory as unused on that answer.
 */
export async function findLiveProcessReferences(
  needles: readonly string[],
  opts: LiveReferenceProbeOptions = {},
): Promise<Set<string> | null> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux') {
    let listing: string;
    try { listing = await (opts.runPs ?? defaultRunPs)(); } catch { return null; }
    // A ps that ran but printed no environments would make every directory look
    // unused. Our own line must show ours (PATH=…) before an empty answer counts.
    const selfPid = String(opts.selfPid ?? process.pid);
    const selfLine = listing.split('\n').find(line => line.trimStart().split(/\s/, 1)[0] === selfPid);
    if (!selfLine?.includes('PATH=')) return null;
    return new Set(needles.filter(needle => listing.includes(needle)));
  }
  const procRoot = opts.procRoot ?? '/proc';
  let pids: string[];
  try { pids = listProcPids(procRoot); } catch { return null; }
  const found = new Set<string>();
  if (needles.length === 0) return found;
  for (const pid of pids) {
    let blob = '';
    // Each read is independent: a process may exit, or deny one file, midway.
    try { blob += readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8'); } catch { /* gone */ }
    try { blob += `\0${readFileSync(`${procRoot}/${pid}/environ`, 'utf8')}`; } catch { /* gone / not ours */ }
    let cwd = '';
    try { cwd = readlinkSync(`${procRoot}/${pid}/cwd`); } catch { /* gone / not ours */ }
    for (const needle of needles) {
      if (found.has(needle)) continue;
      if (blob.includes(needle) || cwd === needle || cwd.startsWith(`${needle}/`)) found.add(needle);
    }
    if (found.size === needles.length) break;
  }
  return found;
}
