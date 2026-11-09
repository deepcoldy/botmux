/**
 * Before a cold `codex resume <thread>`, retire a stale Codex process of the
 * SAME botmux session that still holds the thread's writer lock.
 *
 * Codex allows one writer per conversation: `<CODEX_HOME>/thread-writer-locks/
 * <thread>.lock` is held open by the process that owns the thread. A second
 * `codex resume` of that thread does not wait for it — the TUI stops at
 * "🔒 This conversation is open in another app … press R to retry" and every
 * Lark message after that lands in a pane that will never accept input.
 *
 * botmux reaches that state whenever a restart starts a new pane while the old
 * pane's Codex is still running somewhere it no longer manages (a pane on a
 * replaced tmux server, a pane under a name the new worker did not reattach).
 * Claude Code has no such lock, which is why only Codex sessions wedge.
 *
 * Ownership is proven from the holder's argv: every botmux Codex launch carries
 * `-c shell_environment_policy.set.BOTMUX_SESSION_ID="<session uuid>"`. Only a
 * holder carrying THIS session's id is signalled; a user's own Codex app / IDE
 * / terminal that opened the same conversation is never touched (reported as
 * `foreign`, and the launch proceeds exactly as before this guard existed).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { LSOF_EXEC_OPTIONS } from '../utils/process-open-files.js';
import { pidNotProvablyGone } from '../utils/process-alive.js';

export interface StaleWriterReaperDeps {
  /** Pids holding `lockPath` open; undefined = enumeration unavailable. */
  listLockHolders(lockPath: string): number[] | undefined;
  /** Full command line of `pid` (space-joined); undefined = unreadable. */
  readArgv(pid: number): string | undefined;
  signal(pid: number, sig: NodeJS.Signals): void;
  /** True only when the pid is provably gone (ESRCH). */
  provablyGone(pid: number): boolean;
  now(): number;
  wait(ms: number): Promise<void>;
  lockExists(lockPath: string): boolean;
}

export type StaleWriterReapOutcome =
  /** No lock file for this thread: nothing can be holding it. */
  | { kind: 'no-lock' }
  /** Lock file exists but no live process holds it. */
  | { kind: 'free' }
  /** Holders could not be enumerated; nothing was signalled. */
  | { kind: 'unavailable' }
  /** Every stale holder of this session exited; the thread is free. */
  | { kind: 'reaped'; pids: number[]; forced: boolean }
  /** Holders that do not belong to this session (left alone); `reaped` lists
   *  this session's stale holders that were retired anyway. */
  | { kind: 'foreign'; pids: number[]; reaped: number[] }
  /** This session's stale holder survived SIGKILL within the deadline. */
  | { kind: 'stuck'; pids: number[] };

export function codexThreadWriterLockPath(codexHome: string, threadId: string): string {
  return join(codexHome, 'thread-writer-locks', `${threadId}.lock`);
}

/** The exact argv fragment botmux puts on every Codex launch of a session. */
export function botmuxSessionArgvMarker(sessionId: string): string {
  return `BOTMUX_SESSION_ID=${JSON.stringify(sessionId)}`;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** The worker-side gate: only a COLD resume of a known Codex thread in a pane
 *  botmux launches itself may retire a holder. A reattach targets the live
 *  pane that legitimately holds the lock; RPC / adopt / external app-server /
 *  remote backends do not launch a local TUI resume. */
export function shouldReapStaleCodexWriterBeforeSpawn(input: {
  cliId: string;
  willReattachPersistent: boolean;
  resume: boolean;
  cliSessionId?: string;
  rpcEngine: boolean;
  adoptMode: boolean;
  existingAppServerEndpoint: boolean;
  remoteBackend: boolean;
}): boolean {
  return input.cliId === 'codex'
    && !input.willReattachPersistent
    && input.resume
    && !!input.cliSessionId
    && !input.rpcEngine
    && !input.adoptMode
    && !input.existingAppServerEndpoint
    && !input.remoteBackend;
}

export async function reapStaleCodexThreadWriter(opts: {
  codexHome: string;
  threadId: string;
  sessionId: string;
  /** Pids never to signal (this worker). */
  excludePids?: readonly number[];
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
  deps?: Partial<StaleWriterReaperDeps>;
}): Promise<StaleWriterReapOutcome> {
  const deps: StaleWriterReaperDeps = { ...defaultDeps, ...opts.deps };
  if (!UUID_RE.test(opts.threadId) || !opts.sessionId) return { kind: 'no-lock' };
  const lockPath = codexThreadWriterLockPath(opts.codexHome, opts.threadId);
  if (!deps.lockExists(lockPath)) return { kind: 'no-lock' };
  const holders = deps.listLockHolders(lockPath);
  if (!holders) return { kind: 'unavailable' };
  const excluded = new Set(opts.excludePids ?? []);
  const live = [...new Set(holders)].filter(pid => pid > 0 && !excluded.has(pid) && !deps.provablyGone(pid));
  if (live.length === 0) return { kind: 'free' };

  const marker = botmuxSessionArgvMarker(opts.sessionId);
  const ours: number[] = [];
  const foreign: number[] = [];
  for (const pid of live) {
    const argv = deps.readArgv(pid);
    if (argv !== undefined && argv.includes(marker)) ours.push(pid);
    else foreign.push(pid);
  }
  if (ours.length === 0) return { kind: 'foreign', pids: foreign, reaped: [] };

  const pollMs = opts.pollMs ?? 50;
  const waitGone = async (pids: number[], ms: number): Promise<number[]> => {
    const deadline = deps.now() + ms;
    let remaining = pids.filter(pid => !deps.provablyGone(pid));
    while (remaining.length > 0 && deps.now() < deadline) {
      await deps.wait(pollMs);
      remaining = remaining.filter(pid => !deps.provablyGone(pid));
    }
    return remaining;
  };
  const send = (pids: number[], sig: NodeJS.Signals) => {
    for (const pid of pids) {
      try { deps.signal(pid, sig); } catch { /* already gone / not ours: re-checked below */ }
    }
  };

  // Ownership was read for the whole holder list first; re-prove it per pid
  // immediately before signalling, so a pid that exited and was reused while
  // the other holders were being classified is never sent SIGTERM. A pid that
  // no longer proves ownership is not signalled at all (reported as stuck if
  // it is still alive, since the lock may still be held).
  const signalled: number[] = [];
  const unproven: number[] = [];
  for (const pid of ours) {
    if (deps.readArgv(pid)?.includes(marker) === true) {
      send([pid], 'SIGTERM');
      signalled.push(pid);
    } else if (!deps.provablyGone(pid)) {
      unproven.push(pid);
    }
  }
  if (unproven.length > 0) return { kind: 'stuck', pids: unproven };
  let remaining = await waitGone(signalled, opts.termGraceMs ?? 3_000);
  let forced = false;
  if (remaining.length > 0) {
    forced = true;
    // Re-prove ownership right before the uncatchable signal: never SIGKILL a
    // pid whose argv no longer carries this session's marker (pid reuse).
    const stillOurs = remaining.filter(pid => deps.readArgv(pid)?.includes(marker) === true);
    const gone = remaining.filter(pid => !stillOurs.includes(pid) && deps.provablyGone(pid));
    const lost = remaining.filter(pid => !stillOurs.includes(pid) && !gone.includes(pid));
    if (lost.length > 0) return { kind: 'stuck', pids: lost };
    remaining = stillOurs;
    send(remaining, 'SIGKILL');
    remaining = await waitGone(remaining, opts.killGraceMs ?? 2_000);
  }
  if (remaining.length > 0) return { kind: 'stuck', pids: remaining };
  if (foreign.length > 0) return { kind: 'foreign', pids: foreign, reaped: signalled };
  return { kind: 'reaped', pids: signalled, forced };
}

// ─── Host probes ────────────────────────────────────────────────────────────

const IS_LINUX = process.platform === 'linux';

/** Linux: scan /proc/<pid>/fd for the lock path. Elsewhere: `lsof -t`. */
export function listLockHoldersOnHost(lockPath: string): number[] | undefined {
  if (IS_LINUX && existsSync('/proc/self/fd')) {
    // /proc/<pid>/fd links always name the RESOLVED path; a CODEX_HOME reached
    // through a symlink (symlinked $HOME, bind mounts) must be compared resolved.
    const wanted = new Set([lockPath]);
    try { wanted.add(realpathSync(lockPath)); } catch { /* compare lexically */ }
    for (const path of [...wanted]) wanted.add(`${path} (deleted)`);
    let pids: string[];
    try { pids = readdirSync('/proc').filter(name => /^\d+$/.test(name)); } catch { return undefined; }
    const found: number[] = [];
    for (const pid of pids) {
      // Cheap prefilter: only a Codex process can hold a Codex thread lock.
      // Keeps the per-spawn cost to one small read per process instead of a
      // readlink of every fd on a busy host.
      let cmdline: string;
      try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      if (!/codex/i.test(cmdline)) continue;
      let fds: string[];
      try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; } // not ours / exited
      for (const fd of fds) {
        let target: string;
        try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        if (wanted.has(target)) { found.push(Number(pid)); break; }
      }
    }
    return found;
  }
  try {
    const out = execFileSync('lsof', ['-n', '-P', '-t', '--', lockPath], LSOF_EXEC_OPTIONS);
    return parsePidLines(out);
  } catch (err: any) {
    // lsof exits 1 with empty stdout when nobody holds the file.
    if (err && err.status === 1 && !String(err.stdout ?? '').trim()) return [];
    return undefined;
  }
}

export function parsePidLines(out: string): number[] {
  return out.split('\n').map(line => Number(line.trim())).filter(pid => Number.isInteger(pid) && pid > 0);
}

export function readArgvOnHost(pid: number): string | undefined {
  if (IS_LINUX) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (raw) return raw.split('\0').filter(Boolean).join(' ');
    } catch { /* fall through to ps */ }
  }
  try {
    const out = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], LSOF_EXEC_OPTIONS);
    const line = String(out).trim();
    return line || undefined;
  } catch {
    return undefined;
  }
}

const defaultDeps: StaleWriterReaperDeps = {
  listLockHolders: listLockHoldersOnHost,
  readArgv: readArgvOnHost,
  signal: (pid, sig) => { process.kill(pid, sig); },
  provablyGone: pid => !pidNotProvablyGone(pid),
  now: () => Date.now(),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
  lockExists: path => existsSync(path),
};
