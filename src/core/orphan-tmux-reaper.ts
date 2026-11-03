/**
 * Reap tmux SERVERS orphaned by a previous daemon generation.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * `reapOrphanWorkers()` (worker-pool.ts) reaps botmux `__worker` processes
 * whose daemon was hard-killed. It does NOT touch the tmux server those
 * workers used — tmux servers survive daemon death by design.
 *
 * Failure mode (measured in production 2026-10-22, botmux 3.48 / tmux 3.6a):
 *   1. daemon dies / is restarted (upgrade, crash, host maintenance). The old
 *      tmux server keeps running with every managed pane in it.
 *   2. the new daemon's tmux traffic fails to reach the old server for any
 *      reason (probe timeout under load, socket path cleaned from /tmp, …)
 *      and a SECOND server is born, rebinding the SAME socket path. The old
 *      server keeps its unlinked socket and is now unreachable: `tmux -L
 *      <name> list-sessions` cannot see it, so botmux can never manage or
 *      kill it again.
 *   3. the new daemon cold-resumes the restored sessions. Each managed CLI
 *      (e.g. codex) is a long-lived process inside the OLD server still
 *      holding its per-session file locks. The fresh resume in the NEW server
 *      cannot acquire the lock and parks on the user-visible
 *      "🔒 This conversation is open in another app — Close it there and
 *      press R" screen. Observed: 19/48 sessions blocked at once; the orphan
 *      tree leaked ~13 GB RSS and a few CLIs kept spinning on forked
 *      sub-threads.
 *
 * ─── Managed sockets (post-#2107) ───────────────────────────────────────────
 *
 * Managed sessions are frozen to a tmux socket name in
 * `persistentBackendTarget.socketName`:
 *   • `undefined` — the host DEFAULT server (`$TMUX_TMPDIR/tmux-<uid>/default`),
 *     where every pre-#2107 record and /adopt live;
 *   • `'botmux'` (DEFAULT_MANAGED_TMUX_SOCKET) — the dedicated, isolated
 *     server (`$TMUX_TMPDIR/tmux-<uid>/botmux`) every NEW managed session
 *     uses.
 * The reaper MUST walk every socket a restored session can live on, not just
 * the default — on a host that has only ever run #2107-or-newer builds the
 * default socket hosts zero managed panes and a default-only census reaps
 * nothing while the actual displaced `-L botmux` server keeps every lock.
 *
 * ─── Identification ────────────────────────────────────────────────────────
 *
 * Because the displaced server is invisible on the socket, it is identified
 * the same way the incident was diagnosed live:
 *   • a kernel census of unix listeners bound to the socket pathname
 *     (/proc/net/unix on Linux, lsof -U on macOS — both keep reporting the
 *     ORIGINAL bound pathname after unlink; verified on Linux 5.15 and macOS
 *     tmux 3.6a);
 *   • `tmux -L <name> display-message -p '#{pid}'` names the reachable owner;
 *     any OTHER tmux process listening on the same pathname is displaced;
 *   • and it is provably botmux-spawned: the server process's booting argv
 *     carries `new-session -s bmx-…` / `bmx-diag-…` / `bmx-reap-bootstrap-…`
 *     (Linux /proc/<pid>/cmdline and macOS `ps` both keep the first client's
 *     argv for the server's whole lifetime). A server whose booting argv is a
 *     user's own interactive session is never reaped even when botmux panes
 *     later attach to it: on a shared socket its user sessions die too, so
 *     the conservative choice is to leave it.
 *
 * ─── Conservatism ──────────────────────────────────────────────────────────
 *
 *   • Census-first: a socket with NO listener in the kernel census is skipped
 *     outright — no probe and, crucially on the default socket, no server is
 *     ever booted just to probe (that would recreate the shared-server
 *     footprint #2107 exists to remove). tmux does not auto-spawn a server on
 *     a missing socket for display/list/has-session (verified: clean ENOENT),
 *     so probing a populated path is side-effect-free; the ONLY place a server
 *     may be booted is the disposable bootstrap, and only when a listener
 *     already exists that no reachable owner answers for.
 *   • Never reaps while the reachable owner cannot be identified (probe
 *     timeout / spawn failure). A busy server's accept backlog can momentarily
 *     answer ECONNREFUSED; "can't tell" never escalates into a kill.
 *   • Never reaps a process without a botmux fingerprint — a user's own
 *     interactive tmux is left strictly alone.
 *   • Cross-daemon safe: several per-bot daemons share the hosts' tmux
 *     sockets; per-pid bootstrap names avoid collisions, and racing peers
 *     simply get ESRCH on the kill.
 *   • Default OFF: daemon.ts invokes this only when the machine-wide
 *     experimental Dashboard switch is enabled. BOTMUX_DISABLE_ORPHAN_TMUX_REAP
 *     =1 remains an emergency kill-switch on top of that.
 *   • SIGTERM is followed by a bounded liveness wait so restore cold-resumes
 *     only after tmux's orderly pane teardown (which releases managed CLIs'
 *     file locks); a server still alive at the deadline is left and reported,
 *     never escalated to SIGKILL (the session-scope teardown on the recovery
 *     path handles stragglers independently).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync, readlinkSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { ProcSnapshot } from './worker-pool.js';
import { listProcesses } from './worker-pool.js';
import { tmuxEnv } from '../setup/ensure-tmux.js';
import {
  preferredManagedTmuxSocket,
  managedTmuxCandidateSockets,
  tmuxSocketArgs,
} from '../adapters/backend/tmux-socket.js';
import { logger } from '../utils/logger.js';

/** A pid holding a unix socket bound to a pathname. */
export interface SocketBinding {
  pid: number;
  /** Bound socket pathname (server listeners only — client ends have none). */
  path: string;
}

type SocketName = string | undefined;

/** Result of a reachable-owner probe against one tmux socket. */
type OwnerProbe =
  | { kind: 'reachable'; pid: number }
  | { kind: 'down' }
  | { kind: 'unknown' };

interface ReaperSeam {
  /** Live process table. Defaults to the shared {@link listProcesses}. */
  procs?: ProcSnapshot[];
  /** Pid → bound unix-socket pathnames. Defaults: /proc/net/unix, lsof. */
  socketBindings?: SocketBinding[];
  /**
   * Pid of the tmux server answering on the DEFAULT socket, or null when no
   * reachable server can be identified (timeout / spawn failure). Used ONLY by
   * the back-compat single-socket {@link reapOrphanTmuxServers} entry point;
   * the multi-socket orchestrator probes each socket itself.
   */
  reachableServerPid?: number | null;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Liveness probe used for the bounded post-SIGTERM wait. Defaults to kill -0. */
  isAlive?: (pid: number) => boolean;
  /** Wait used by the post-SIGTERM bounded wait. Defaults to a synchronous sleep. */
  sleep?: (ms: number) => void;
  /** Second owner-pid probe for the TOCTOU guard. Tests inject it; defaults to a
   *  fresh `tmux display-message` probe on the same socket. */
  reProbeReachableServerPid?: (socketName: SocketName) => number | null;
  /** First owner-pid probe. Tests inject it; defaults to a live tmux probe. */
  probeReachableServerPid?: (socketName: SocketName) => number | null;
  /**
   * Per-socket reachable-owner probe for the orchestrator: 'reachable' carries
   * the pid; 'down' means tmux authoritatively answered "no server" (a bootstrap
   * may boot one); 'unknown' is a timeout/spawn failure (skip this socket).
   */
  probeOwner?: (socketName: SocketName) => OwnerProbe;
  /** Boot a disposable bootstrap session on the socket to pin a fresh owner. */
  bootstrap?: (socketName: SocketName, sessionName: string) => boolean;
  /** Remove a bootstrap session previously created on the socket. */
  cleanupBootstrap?: (socketName: SocketName, sessionName: string) => void;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  platform?: NodeJS.Platform;
}

/** argv[0] of a process is the tmux binary. */
function isTmuxBinary(cmd: string): boolean {
  return basename(cmd.split(/\s+/, 1)[0] ?? '') === 'tmux';
}

/**
 * The booting session of every botmux tmux server is named `bmx-<id>` /
 * `bmx-diag-<id>` (TmuxBackend.sessionName / diagnosticSessionName) and the
 * server inherits the first `tmux new-session -s bmx-…` client's argv on both
 * macOS and Linux for its whole lifetime (Linux only renames the thread COMM;
 * /proc cmdline keeps the original argv). The reaper's own one-shot bootstrap
 * session is included: it can itself boot a fresh server whose argv stays
 * `bmx-reap-bootstrap-<pid>` forever (later real sessions attach, they do not
 * change the server argv), so without this alternative a server the reaper
 * booted would be unreapable after the next socket displacement.
 *
 * The fingerprint is socket-agnostic: it must match no matter which socket the
 * booting `new-session` targeted (default / `-L botmux` / a recorded name).
 */
export function argvCarriesBotmuxSession(cmd: string): boolean {
  // Require the `new-session` subcommand: a bare `-s` also belongs to grep,
  // tmux's own `kill-session -s`, etc., which must not match.
  return /(?:^|\s)new-session\b.*\s-s\s+(?:bmx(?:-diag)?-[0-9a-f]{8}|bmx-reap-bootstrap-\d+)(?:\s|$)/s.test(cmd);
}

/** Filesystem pathname of a tmux server socket (undefined name = default). */
export function defaultSocketPath(
  env: NodeJS.ProcessEnv,
  uid: number,
  socketName?: string,
): string {
  const baseDir = env.TMUX_TMPDIR || '/tmp';
  return join(baseDir, `tmux-${uid}`, socketName || 'default');
}

/**
 * Every pathname a listener on `socketPath` might be reported under. macOS
 * /tmp is a symlink to /private/tmp: tmux's bind(2) resolves it, so lsof
 * reports the REAL path. realpath on the socket FILE itself fails with
 * EOPNOTSUPP on macOS (it is not a regular file), so the parent DIRECTORY is
 * canonicalized. On Linux /tmp is real and the two spellings coincide.
 */
function socketPathSpellings(socketPath: string): Set<string> {
  try {
    const real = join(realpathSync(dirname(socketPath)), basename(socketPath));
    return new Set([socketPath, real]);
  } catch {
    return new Set([socketPath]);
  }
}

/**
 * Linux: map pids to unix socket PATHNAMES they LISTEN on, via
 * /proc/net/unix (inode → pathname) + /proc/<pid>/fd/* (pid → inode).
 * Connected client endpoints have an empty Path column and never appear.
 * A listener whose socket file was unlinked KEEPS its original bound pathname
 * in /proc/net/unix (no "(deleted)" suffix on this kernel family) — this is
 * what makes a displaced server visible to the census at all.
 */
function linuxSocketBindings(): SocketBinding[] {
  const rows = readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1);
  const inodeToPath = new Map<string, string>();
  for (const line of rows) {
    const cols = line.trimStart().split(/\s+/);
    // Num RefCount Protocol Flags Type St Inode Path
    const path = cols[7];
    const inode = cols[6];
    if (path && inode) inodeToPath.set(inode, path);
  }
  const bindings: SocketBinding[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let fds: string[];
    try { fds = readdirSync(`/proc/${entry}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target: string;
      try { target = readlinkSync(`/proc/${entry}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (!m) continue;
      const path = inodeToPath.get(m[1]);
      if (path) bindings.push({ pid, path });
    }
  }
  return bindings;
}

/**
 * macOS / other Unix: parse one `lsof -U -F pcn` dump. Records are `p<pid>`
 * then per-open-file lines (`f…`, `t…`, `n<name>`). A bound unix server
 * socket renders its absolute pathname; a connected client end renders
 * `->0x…`, which is filtered out. After unlink the listener KEEPS its
 * original bound pathname (verified on macOS 15 / tmux 3.6a).
 */
export function parseLsofSocketBindings(stdout: string): SocketBinding[] {
  const bindings: SocketBinding[] = [];
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && pid !== null) {
      const path = line.slice(1);
      if (path.startsWith('/')) bindings.push({ pid, path });
    }
  }
  return bindings;
}

function macSocketBindings(): SocketBinding[] {
  // lsof ships at /usr/sbin on macOS and is not present in some minimal Linux
  // images; it is only invoked on darwin here. Bound the call so a wedged
  // lsof can never block daemon startup (fail closed → reap nothing).
  const r = spawnSync('lsof', ['-U', '-F', 'pcn'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return [];
  return parseLsofSocketBindings(r.stdout);
}

function defaultSocketBindings(platform: NodeJS.Platform): SocketBinding[] {
  try {
    if (platform === 'linux') return linuxSocketBindings();
    if (platform === 'darwin') return macSocketBindings();
  } catch (err) {
    logger.warn(`[tmux-reaper] socket census failed, skipping reap: ${err instanceof Error ? err.message : String(err)}`);
  }
  return [];
}

/**
 * Probe the tmux server currently answering on a socket.
 *
 * Returns a pid on a clean answer; 'down' on tmux's authoritative "no server
 * on this socket" reply (ENOENT / no server running — no server is spawned by
 * display-message on a missing socket, verified on tmux 3.3a and 3.6a);
 * 'unknown' on a deadline or spawn failure — a healthy server's accept
 * backlog can momentarily overflow into ECONNREFUSED, which must never be
 * read as "down".
 */
function probeOwnerOnSocket(socketName: SocketName): OwnerProbe {
  try {
    const out = execFileSync('tmux', [...tmuxSocketArgs(socketName), 'display-message', '-p', '#{pid}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: tmuxEnv(),
      timeout: 3000,
    });
    const pid = Number(out.trim());
    return Number.isInteger(pid) && pid > 0 ? { kind: 'reachable', pid } : { kind: 'unknown' };
  } catch (e: any) {
    if (e?.code === 'ETIMEDOUT' || e?.signal) return { kind: 'unknown' };
    if (e && typeof e.status === 'number') return { kind: 'down' };
    return { kind: 'unknown' };
  }
}

/** Back-compat single-socket pid probe (null collapses 'down' and 'unknown'). */
function reachableTmuxServerPid(socketName: SocketName = undefined): number | null {
  const r = probeOwnerOnSocket(socketName);
  return r.kind === 'reachable' ? r.pid : null;
}

/**
 * Daemon-startup gate. The reaper performs automatic process kills, so it runs
 * only for the tmux backend AND the machine-wide experimental Dashboard switch
 * (default OFF). The env kill-switch inside the orchestrator is a separate,
 * independent layer.
 */
export function orphanTmuxReaperEnabled(backendType: string, featureEnabled: boolean): boolean {
  return backendType === 'tmux' && featureEnabled;
}

const BOOTSTRAP_PREFIX = 'bmx-reap-bootstrap-';

/** Create a disposable bootstrap session to pin a fresh reachable owner. */
function bootstrapOwner(socketName: SocketName, sessionName: string): boolean {
  try {
    execFileSync(
      'tmux',
      [...tmuxSocketArgs(socketName), 'new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24'],
      { stdio: ['ignore', 'ignore', 'pipe'], env: tmuxEnv(), timeout: 5000 },
    );
    return true;
  } catch (err) {
    logger.warn(`[tmux-reaper] tmux bootstrap failed on ${socketName ?? 'default'}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function removeBootstrap(socketName: SocketName, sessionName: string): void {
  try {
    execFileSync('tmux', [...tmuxSocketArgs(socketName), 'kill-session', '-t', sessionName], {
      stdio: 'ignore',
      env: tmuxEnv(),
      timeout: 3000,
    });
  } catch { /* server already gone / concurrent cleanup — benign */ }
}

/**
 * Bounded wait after SIGTERM for tmux's orderly shutdown (pane teardown is what
 * releases managed CLIs' per-session file locks). The signal itself returning
 * proves nothing — the server may still be closing panes when restore starts.
 * A server still alive at the deadline is left running and reported; SIGKILL is
 * deliberately not used because recovery's session-scope teardown handles
 * straggler panes independently.
 */
const SERVER_EXIT_WAIT_TIMEOUT_MS = 3000;
const SERVER_EXIT_WAIT_POLL_MS = 100;

/**
 * Core single-socket reap: given the reachable owner pid, terminate every
 * OTHER botmux-fingerprinted tmux process listening on that socket's
 * pathnames. Shared by the multi-socket orchestrator and the back-compat
 * {@link reapOrphanTmuxServers} entry point.
 */
function reapSocketOrphans(opts: {
  socketName: SocketName;
  liveOwnerPid: number;
  socketPaths: Set<string>;
  bindings: SocketBinding[];
  procs: ProcSnapshot[];
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => void;
  reProbe: () => number | null;
  socketPathForLog: string;
}): number {
  const { socketName, liveOwnerPid, socketPaths, bindings, procs, socketPathForLog } = opts;
  const procByPid = new Map(procs.map(p => [p.pid, p]));

  const candidatePids = new Set<number>();
  for (const b of bindings) {
    if (!socketPaths.has(b.path)) continue;
    if (b.pid === liveOwnerPid) continue;
    const proc = procByPid.get(b.pid);
    if (proc && isTmuxBinary(proc.cmd)) candidatePids.add(b.pid);
  }
  if (candidatePids.size === 0) return 0;

  // TOCTOU guard: the reachable owner could have died (and a fresh server
  // rebound) between the pid probe and the socket census. If its identity
  // changed, the candidates are no longer trustworthy — leave everything for
  // the next startup rather than risk a wrong kill.
  const ownerNow = opts.reProbe();
  if (ownerNow !== liveOwnerPid) {
    logger.warn(`[tmux-reaper] reachable server changed during reap on ${socketName ?? 'default'} (${liveOwnerPid} → ${ownerNow}); skipping this pass`);
    return 0;
  }

  let reaped = 0;
  for (const pid of candidatePids) {
    const proc = procByPid.get(pid)!;

    // Botmux fingerprint: the server's booting argv. A user-booted server that
    // later hosts attached bmx panes is deliberately NOT fingerprinted —
    // killing it on a shared socket would kill the user's sessions too.
    if (!argvCarriesBotmuxSession(proc.cmd)) continue;

    let signaled: 'term' | 'esrch' | 'error' = 'term';
    try {
      // SIGTERM, not SIGKILL: tmux performs an orderly shutdown and closes its
      // panes itself, which releases the managed CLIs' per-session file locks
      // — cold-resumed sessions then recover immediately. Measured: the
      // incident server (743 descendants) exited within seconds of SIGTERM.
      opts.kill(pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        signaled = 'esrch';
      } else {
        signaled = 'error';
        logger.warn(`[tmux-reaper] failed to signal orphaned tmux server pid=${pid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (signaled === 'error') continue;
    if (signaled === 'esrch') {
      reaped += 1;
      continue;
    }

    // Bounded wait for the orderly teardown before restore cold-resumes managed
    // CLIs (a pane ignoring SIGHUP can survive its server, in which case the
    // lock is not released here; recovery's session-scope teardown is the
    // independent backstop).
    let alive = opts.isAlive(pid);
    let waited = 0;
    while (alive && waited < SERVER_EXIT_WAIT_TIMEOUT_MS) {
      opts.sleep(SERVER_EXIT_WAIT_POLL_MS);
      waited += SERVER_EXIT_WAIT_POLL_MS;
      alive = opts.isAlive(pid);
    }
    if (alive) {
      logger.warn(`[tmux-reaper] orphaned tmux server pid=${pid} still alive ${SERVER_EXIT_WAIT_TIMEOUT_MS}ms after SIGTERM; leaving it for this pass (restore may contend on its CLI locks; session-scope teardown is the backstop)`);
      continue;
    }
    reaped += 1;
    logger.warn(`[tmux-reaper] reaped orphaned tmux server pid=${pid}: unreachable on ${socketPathForLog} (socket ${socketName ?? 'default'}) but still hosting botmux sessions (previous daemon generation gone)`);
  }
  return reaped;
}

/**
 * Back-compat single-socket entry point (DEFAULT socket). Kept for callers and
 * the unit tests that pin one reachable pid via the seam; the daemon uses the
 * multi-socket {@link ensureServerThenReapOrphanTmuxServers}.
 */
export function reapOrphanTmuxServers(opts: ReaperSeam = {}): number {
  const env = opts.env ?? process.env;
  if (env.BOTMUX_DISABLE_ORPHAN_TMUX_REAP === '1') return 0;
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') return 0;
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  if (uid < 0) return 0;

  const liveOwnerPid = opts.reachableServerPid !== undefined
    ? opts.reachableServerPid
    : (opts.probeReachableServerPid ?? reachableTmuxServerPid)(undefined);
  if (liveOwnerPid === null || liveOwnerPid === undefined) return 0;

  const socketPath = defaultSocketPath(env, uid, undefined);
  const bindings = opts.socketBindings ?? defaultSocketBindings(platform);
  if (bindings.length === 0) return 0;
  const procs = opts.procs ?? listProcesses();
  const kill = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const sleep = opts.sleep ?? defaultSleep;

  return reapSocketOrphans({
    socketName: undefined,
    liveOwnerPid,
    socketPaths: socketPathSpellings(socketPath),
    bindings,
    procs,
    kill,
    isAlive,
    sleep,
    socketPathForLog: socketPath,
    reProbe: () => {
      if (opts.reachableServerPid === undefined || opts.reProbeReachableServerPid !== undefined) {
        return (opts.reProbeReachableServerPid ?? reachableTmuxServerPid)(undefined);
      }
      return liveOwnerPid;
    },
  });
}

function defaultIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    // EPERM means alive but not ours to signal — treat as alive (do not reap).
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function defaultSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Sockets the daemon walks at startup: every socket a persisted ACTIVE tmux
 * session is frozen to, plus the default socket (legacy / #2107-prior records
 * and /adopt) and the current preferred managed socket (new sessions).
 */
export function reaperCandidateSocketNames(
  recordedSocketNames: Iterable<string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  const push = (name: string | undefined) => { if (!out.includes(name)) out.push(name); };
  for (const name of recordedSocketNames) push(name);
  for (const name of managedTmuxCandidateSockets(undefined, preferredManagedTmuxSocket(env))) push(name);
  return out;
}

/**
 * Multi-socket daemon-startup entry point.
 *
 * For each candidate socket (default + dedicated + any per-session frozen
 * name):
 *   1. kernel census of listeners bound to its pathname — NONE ⇒ skip without
 *      probing or booting anything (census-first, no shared-server churn);
 *   2. probe the reachable owner (`tmux -L <name> display-message`);
 *      • reachable → reap displaced listeners against it;
 *      • tmux-authoritative "down" WITH a listener present ⇒ a displaced,
 *        unreachable server exists: boot a disposable per-pid-named bootstrap
 *        session to pin a fresh reachable owner (a bare `tmux start-server`
 *        cannot pin: exit-empty=on kills it on client disconnect), re-probe,
 *        reap, then remove the bootstrap;
 *      • unknown (timeout / spawn failure) ⇒ skip this socket.
 *
 * `socketNames` defaults to the production candidate set; tests inject a seam
 * object for every side-effecting operation. Returns servers reaped.
 */
export function ensureServerThenReapOrphanTmuxServers(
  opts: ReaperSeam & { socketNames?: Array<string | undefined> } = {},
): number {
  const env = opts.env ?? process.env;
  if (env.BOTMUX_DISABLE_ORPHAN_TMUX_REAP === '1') return 0;
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') return 0;
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  if (uid < 0) return 0;

  const socketNames = opts.socketNames
    ?? reaperCandidateSocketNames([], env);
  const bindings = opts.socketBindings ?? defaultSocketBindings(platform);
  const procs = opts.procs ?? listProcesses();
  const probeOwner = opts.probeOwner ?? probeOwnerOnSocket;
  const bootstrap = opts.bootstrap ?? bootstrapOwner;
  const cleanupBootstrap = opts.cleanupBootstrap ?? removeBootstrap;
  const kill = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const sleep = opts.sleep ?? defaultSleep;

  let total = 0;
  for (const socketName of socketNames) {
    const socketPath = defaultSocketPath(env, uid, socketName);
    const socketPaths = socketPathSpellings(socketPath);
    const listeners = bindings.filter(b => socketPaths.has(b.path));

    // Census-first: nothing bound on this pathname ⇒ no server to identify and
    // no orphan to reap. Never boot a server here — on the default socket that
    // would recreate exactly the shared footprint #2107 removed, and on any
    // socket it would be a boot with nothing to reclaim (restore itself
    // replaces a stale/absent socket the normal way on first new-session).
    if (listeners.length === 0) continue;

    let owner = probeOwner(socketName);
    let bootstrappedSession: string | null = null;
    if (owner.kind === 'unknown') {
      logger.warn(`[tmux-reaper] owner probe inconclusive on ${socketName ?? 'default'}; skipping this socket`);
      continue;
    }
    if (owner.kind === 'down') {
      // A listener exists but no reachable owner answers — the displaced
      // server scenario. Pin a fresh owner with a bootstrap session.
      bootstrappedSession = `${BOOTSTRAP_PREFIX}${process.pid}`;
      if (!bootstrap(socketName, bootstrappedSession)) continue;
      const reProbed = probeOwner(socketName);
      if (reProbed.kind !== 'reachable') {
        cleanupBootstrap(socketName, bootstrappedSession);
        logger.warn(`[tmux-reaper] fresh owner unreachable after bootstrap on ${socketName ?? 'default'}; skipping this socket`);
        continue;
      }
      owner = reProbed;
    }

    try {
      total += reapSocketOrphans({
        socketName,
        liveOwnerPid: owner.pid,
        socketPaths,
        bindings: listeners,
        procs,
        kill,
        isAlive,
        sleep,
        socketPathForLog: socketPath,
        reProbe: () => {
          const r = probeOwner(socketName);
          return r.kind === 'reachable' ? r.pid : null;
        },
      });
    } finally {
      if (bootstrappedSession) cleanupBootstrap(socketName, bootstrappedSession);
    }
  }
  if (total > 0) {
    logger.warn(`[tmux-reaper] reaped ${total} orphaned tmux server(s) from a previous daemon generation; managed CLI file locks released before session restore.`);
  }
  return total;
}
