/**
 * Anti-fork gate for tmux server creation.
 *
 * ─── The orphan-birth mechanism (measured) ──────────────────────────────────
 *
 * A `tmux new-session` client boots a fresh server whenever it cannot transact
 * with one on the socket. Two states look identical to the client but only one
 * is a real cold start:
 *
 *   1. no server bound to the label                → booting is correct;
 *   2. a LIVE server bound to the label is merely unreachable
 *        (slow/overloaded, or its socket file was unlinked)
 *                                                  → booting forks the orphan.
 *
 * Platform difference, both reproduced:
 *   - Linux tmux 3.0a: while the server is busy (SIGSTOP) or its accept
 *     backlog is full, connect()/handshake BLOCKS, so new-session waits and
 *     does NOT fork. A fork happens only when nothing LISTENING is bound to
 *     the pathname anymore — the socket file was unlinked under a live server
 *     (then TWO listeners on one pathname, distinct inodes), or a stale
 *     bound-but-never-listening socket sits at the path (ECONNREFUSED → the
 *     client unlinks and re-binds).
 *   - macOS tmux 3.6a on a heavily loaded host: once the accept backlog
 *     (128) overflows, connect() returns ECONNREFUSED immediately and the
 *     new-session CLIENT process itself unlinks/re-binds and forks a fresh
 *     server, returning success. No socket deletion is needed, and the fork
 *     happens inside the tmux client between our probe and its exec — an
 *     external liveness check cannot close that race.
 *
 * ─── Two version-specific guards ────────────────────────────────────────────
 *
 * The `-N` global client flag ("never start the server even if the command
 * would normally do so", tmux 3.2 — CHANGES "FROM 3.1c TO 3.2") atomically
 * closes the client-internal fork. Measured on macOS 3.6a: with a listener
 * present but refusing, `tmux -N new-session` exits 1 ("no server running"),
 * leaves the inode untouched, and does not fork. It is UNKNOWN on tmux 3.0/3.1
 * (verified: "unknown option -- N"), so use it only when the client is ≥ 3.2.
 *
 * On older clients (< 3.2) there is no -N. Linux is still safe while merely
 * busy (connect blocks), so bounded waiting suffices. The remaining Linux-only
 * orphan case is "socket file unlinked under a live botmux server": tmux
 * recreates its socket on SIGUSR1 (man tmux; verified on 3.0a — display then
 * returns the SAME pid, sessions survive, a new inode is bound). USR1 first
 * unlinks then binds, so it may only target the single, botmux-fingerprinted
 * listener when the path is provably ENOENT — otherwise it could steal a
 * freshly booted successor's path.
 *
 * Decision before every server-booting command:
 *
 *   owner answers                 → run new-session; add -N when the client
 *                                   supports it AND a listener is bound (closes
 *                                   the probe→exec TOCTOU on macOS);
 *   no LISTENING socket bound     → cold boot WITHOUT -N;
 *   listener bound, owner silent:
 *       client ≥ 3.2              → bounded wait; the eventual spawn carries
 *                                   -N, so an ECONNREFUSED during the race
 *                                   errors instead of forking;
 *       client < 3.2, path ENOENT,
 *       exactly one bmx listener  → SIGUSR1 it to recreate the socket, then
 *                                   re-probe and attach;
 *       otherwise                 → bounded wait (never boot, never unlink,
 *                                   never signal a non-botmux server).
 *
 * Only LISTENING unix STREAM sockets count (Flags 00010000, state 01 on
 * Linux /proc/net/unix). Connected (state 02/03) and bound-never-listening
 * (flags 0) sockets carry the pathname too but are not servers.
 *
 * The module never kills a process. SIGUSR1 is socket recovery, not teardown.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import {
  tmuxEnv,
  tmuxVersionAtLeast,
  clientTmuxVersionForEnv,
  type TmuxVersion,
} from '../setup/ensure-tmux.js';

/**
 * Botmux server fingerprint: the server's booting argv carries its first
 * client's `new-session -s bmx-<8hex>|bmx-diag-…|bmx-reap-bootstrap-…` for its
 * whole lifetime on Linux and macOS. Read directly from /proc here (rather than
 * importing worker-pool's listProcesses) so this low-level adapter does not
 * pull in the large worker dependency graph or create a tmux-backend ↔
 * worker-pool import cycle.
 */
function argvCarriesBotmuxSession(cmd: string): boolean {
  return /(?:^|\s)new-session\b.*\s-s\s+(?:bmx(?:-diag)?-[0-9a-f]{8}|bmx-reap-bootstrap-\d+)(?:\s|$)/s.test(cmd);
}

/** Whether pid's booting argv is a botmux tmux server. Linux reads
 *  /proc/<pid>/cmdline directly; non-/proc or any read failure returns false
 *  (fail closed — never signal a process we cannot fingerprint). */
export function procIsBotmuxListener(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    return argvCarriesBotmuxSession(cmdline);
  } catch { return false; }
}

function tmuxSocketArgs(socketName?: string): string[] {
  return socketName ? ['-L', socketName] : [];
}

/** `/proc/net/unix` Flags bit marking a LISTENING (accept-on) unix socket.
 *  The Flags column is hexadecimal: 00010000 == (1 << 16) == __SO_ACCEPTON. */
const UNIX_LISTEN_FLAGS = 0x00010000;

/** Outcome of the owner probe (`display-message -p #{pid}`). */
export type TmuxOwnerProbe =
  | { kind: 'reachable'; pid: number }
  /** tmux authoritatively answered "no server running on …" (kernel found no
   *  bound socket). */
  | { kind: 'no-server' }
  /** A connection-level failure: ECONNREFUSED / ENOENT / lost server. */
  | { kind: 'connect-error' }
  /** Deadline / spawn failure — "can't tell". */
  | { kind: 'unknown' };

/** Pure decision the gate makes on one probe cycle. */
export type BootDirective =
  /** Run new-session now. `noFork` ⇒ prepend the client -N flag (≥3.2) so the
   *  command can never boot a server (attach only). Cold boots use false. */
  | { mode: 'spawn'; noFork: boolean }
  /** Send SIGUSR1 to this single botmux listener to recreate an ENOENT socket,
   *  then re-evaluate. Linux, client < 3.2 only. */
  | { mode: 'recreate-socket'; pid: number }
  /** A live listener is bound but unreachable; sleep and probe again.
   *  `unprotected` marks a platform/tmux with NEITHER -N NOR SIGUSR1 recovery
   *  (e.g. macOS tmux < 3.2): waiting cannot prevent the client's own fork, so
   *  the caller MUST warn loudly rather than claim protection. */
  | { mode: 'wait'; reason: string; unprotected?: boolean };

export interface GuardInputs {
  /** Owner probe result. */
  owner: TmuxOwnerProbe;
  /** Pids with a LISTENING unix STREAM socket bound to a socket path spelling.
   *  `[]` = census read, nothing listening; `null` = census UNREADABLE, which
   *  must fail closed (wait), never collapse to a cold boot. */
  listeners: number[] | null;
  /** Socket file lstat: true/false, null if unstatable for non-ENOENT reasons. */
  filePresent: boolean | null;
  /** Client supports the -N flag (tmux ≥ 3.2). */
  supportsNoFork: boolean;
  /** Whether SIGUSR1 socket recovery is usable (Linux: strong pid/census proof). */
  canSignalRecovery: boolean;
  /** Whether a pid's booting argv carries the botmux bmx-* fingerprint. */
  isBotmuxListener: (pid: number) => boolean;
  /** Process start time (clock ticks since boot); newest listener wins USR1. */
  startTicks: (pid: number) => number | null;
}

export interface TmuxServerGuardSeam {
  owner?: TmuxOwnerProbe;
  probeOwner?: () => TmuxOwnerProbe;
  listeners?: number[];
  listeningServerPids?: () => number[] | null;
  filePresent?: boolean | null;
  socketFilePresent?: () => boolean | null;
  supportsNoFork?: boolean;
  canSignalRecovery?: boolean;
  isBotmuxListener?: (pid: number) => boolean;
  startTicks?: (pid: number) => number | null;
  /** Send SIGUSR1 (defaults to process.kill). */
  recreateSocket?: (pid: number) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Filesystem pathname of a tmux server socket (undefined name = default). */
export function tmuxSocketPath(env: NodeJS.ProcessEnv, uid: number, socketName?: string): string {
  const baseDir = env.TMUX_TMPDIR || '/tmp';
  return join(baseDir, `tmux-${uid}`, socketName || 'default');
}

/** All path spellings a bound socket may be reported under: the given path and
 *  the realpath of its directory joined with the basename (a symlinked
 *  TMUX_TMPDIR makes tmux and the census report different strings). */
export function tmuxSocketPathSpellings(socketPath: string): Set<string> {
  const out = new Set<string>([socketPath]);
  try { out.add(join(realpathSync(dirname(socketPath)), basename(socketPath))); }
  catch { /* realpath unavailable — given spelling only */ }
  return out;
}

/** Live owner probe. A missing socket/connect failure is distinguished from
 *  tmux's authoritative "no server running". Non-new-session commands carry an
 *  implicit never-start since tmux 2.5, so this probe never boots a server. */
/** Owner-probe deadline INSIDE the gate. Deliberately shorter than the 3 s
 *  generic probe: a wedged owner must not let one cycle consume most of the
 *  gate's bounded wait. The gate re-probes across cycles, and after a timeout
 *  the kernel census (fast) is what actually decides. */
export const GUARD_OWNER_PROBE_TIMEOUT_MS = 800;

export function probeTmuxOwner(socketName?: string, env: NodeJS.ProcessEnv = process.env): TmuxOwnerProbe {
  try {
    const out = execFileSync(
      'tmux',
      [...tmuxSocketArgs(socketName), 'display-message', '-p', '#{pid}'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: tmuxEnv(env), timeout: GUARD_OWNER_PROBE_TIMEOUT_MS },
    );
    const pid = Number(out.trim());
    return Number.isInteger(pid) && pid > 0 ? { kind: 'reachable', pid } : { kind: 'unknown' };
  } catch (e: any) {
    if (e?.code === 'ETIMEDOUT' || e?.signal || e?.killed) return { kind: 'unknown' };
    if (e && typeof e.status === 'number') {
      const stderr = String(e.stderr ?? '');
      if (/no server running/i.test(stderr)) return { kind: 'no-server' };
      return { kind: 'connect-error' };
    }
    return { kind: 'unknown' };
  }
}

export interface UnixListenerRow { inode: string; path: string; listening: boolean }

/** Parse /proc/net/unix. Columns: Num RefCount Protocol Flags Type St Inode Path. */
export function parseProcNetUnix(text: string): UnixListenerRow[] {
  const rows: UnixListenerRow[] = [];
  const lines = text.split('\n');
  for (const line of lines.slice(/^\s*Num\b/.test(lines[0] ?? '') ? 1 : 0)) {
    if (!line) continue;
    const cols = line.trimStart().split(/\s+/);
    const flags = parseInt(cols[3] ?? '', 16);
    const type = cols[4];
    const state = cols[5];
    const inode = cols[6];
    const path = cols.slice(7).join(' ');
    if (!inode || Number.isNaN(flags)) continue;
    if (type !== '0001') continue;
    rows.push({ inode, path, listening: state === '01' && (flags & UNIX_LISTEN_FLAGS) === UNIX_LISTEN_FLAGS });
  }
  return rows;
}

/** Linux: pids holding a LISTENING unix STREAM socket bound to any of the
 *  socket path spellings. */
export function linuxListeningServerPids(socketPath: string): number[] | null {
  const spellings = tmuxSocketPathSpellings(socketPath);
  let table: string;
  try { table = readFileSync('/proc/net/unix', 'utf8'); } catch { return null; }
  const listeningInodes = new Set<string>();
  for (const row of parseProcNetUnix(table)) {
    if (row.listening && spellings.has(row.path)) listeningInodes.add(row.inode);
  }
  const pids = new Set<number>();
  let procEntries: string[];
  try { procEntries = readdirSync('/proc'); } catch { return null; }
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let fds: string[];
    try { fds = readdirSync(`/proc/${entry}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target: string;
      try { target = readlinkSync(`/proc/${entry}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && listeningInodes.has(m[1])) { pids.add(pid); break; }
    }
  }
  return [...pids];
}

/**
 * macOS: pids with a BOUND, NAMED unix socket at `socketPath`, via
 * `lsof -U -F pcn`.
 *
 * We deliberately do NOT rely on a lsof "listen state" token: its spelling
 * differs across lsof dialects and is not part of the stable -F contract. A
 * bound server socket renders an absolute NAME (`n/private/tmp/…/default`);
 * client/connected ends render `n->0x…` or a bare `type=STREAM` with no path.
 * Matching an absolute NAME that is not an `->` peer therefore counts a bound
 * socket. This is intentionally CONSERVATIVE — it can mistake a connected end
 * for a bound server and cause one extra bounded wait, but it never
 * under-counts a real listener and so never forks a competitor. Mirrors the
 * proven parseLsofSocketBindings shape shipped in #2149. Callers needing the
 * exact listen/connected split should run on Linux (strong /proc evidence).
 */
export interface LsofListenerResult {
  /** Pids bound to a named socket at one of the socket path spellings. */
  pids: number[];
  /**
   * True when the output had at least one recognizable lsof -F process/name
   * record (`p<pid>` + `n…`). FALSE means the dialect produced no parseable
   * structure at all (unknown/older/newer lsof, garbage) — the caller must
   * treat that census as UNREADABLE (null) and wait, not as "zero listeners".
   * A parseable run that simply has no socket at THIS path still yields
   * recognized=true with an empty pid list (a valid cold/residual-file read).
   */
  recognized: boolean;
}

/** Normalise an lsof -F `n` field: strip a trailing ` type=STREAM` (and any
 *  fields after it). macOS lsof emits the bare path, but some other lsof
 *  builds (notably Linux procps lsof, which this code path does not normally
 *  use) append ` type=STREAM`; stripping it is harmless defensive parsing. */
function normalizeLsofName(raw: string): string {
  const idx = raw.indexOf(' type=');
  return idx >= 0 ? raw.slice(0, idx) : raw;
}

export function parseLsofListenerResult(stdout: string, socketPath: string): LsofListenerResult {
  // Exact path spellings lsof may report (macOS /tmp is a symlink to
  // /private/tmp). Never match by basename suffix: labels like "botmux" and
  // "botmux2" share a directory and must not cross-match.
  const spellings = new Set<string>([socketPath]);
  if (socketPath.startsWith('/tmp/')) spellings.add(`/private${socketPath}`);
  if (socketPath.startsWith('/private/tmp/')) spellings.add(socketPath.slice('/private'.length));

  const pids = new Set<number>();
  let pid: number | null = null;
  let recognized = false;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      if (Number.isInteger(n) && n > 0) { pid = n; recognized = true; }
    } else if (line.startsWith('n') && pid !== null) {
      recognized = true;
      const name = normalizeLsofName(line.slice(1));
      // Bound named socket: a recognized spelling, not a connected-peer
      // "->" record (connected ends render n->0x… or bare ntype=STREAM).
      if (!name.startsWith('->') && spellings.has(name)) pids.add(pid);
    }
  }
  return { pids: [...pids], recognized };
}

/** Back-compat wrapper: just the matching pids. Use parseLsofListenerResult
 *  when the caller must distinguish "no socket on this path" from an
 *  unparseable/unknown lsof dialect. */
export function parseLsofListeners(stdout: string, socketPath: string): number[] {
  return parseLsofListenerResult(stdout, socketPath).pids;
}

function macListeningServerPids(socketPath: string): number[] | null {
  const r = spawnSync('lsof', ['-U', '-F', 'pcn'], {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  // lsof ran but spoke an unrecognized dialect → census UNREADABLE → wait.
  // A recognized run with no bound socket on this path is a legitimate empty
  // list (cold/residual file), so return [] and allow the cold boot.
  const result = parseLsofListenerResult(r.stdout, socketPath);
  return result.recognized ? result.pids : null;
}

export function listeningServersOnPath(socketPath: string, platform: NodeJS.Platform = process.platform): number[] | null {
  if (platform === 'linux') return linuxListeningServerPids(socketPath);
  if (platform === 'darwin') return macListeningServerPids(socketPath);
  return null;
}

function defaultIsBotmuxListener(pid: number): boolean {
  return procIsBotmuxListener(pid);
}

/** Process start time in clock ticks since boot (/proc/<pid>/stat field 22),
 *  used to pick the NEWEST displaced server. Null when unavailable. */
export function procStartTicks(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // after: [state, ppid, pgrp, session, tty_nr, tpgid, flags, minflt,
    // cminflt, majflt, cmajflt, utime, stime, cutime, cstime, priority, nice,
    // num_threads, itrealvalue, starttime(22nd field)]
    const starttime = Number(after[19]);
    return Number.isFinite(starttime) ? starttime : null;
  } catch { return null; }
}

/** -N capability resolved for the SAME environment the pane launch uses (its
 *  PATH's tmux binary), not the daemon's ambient cache. Null version ⇒ false. */
function supportsNoForkForEnv(env: NodeJS.ProcessEnv): boolean {
  const v: TmuxVersion | null = clientTmuxVersionForEnv(env);
  return tmuxVersionAtLeast(v, 3, 2);
}

/**
 * Pure decision core. Deterministic given the probe/census inputs — no
 * syscalls — so every platform and tmux version is unit-testable.
 */
export function decideBootDirective(i: GuardInputs): BootDirective {
  if (i.owner.kind === 'reachable') {
    // An owner answered on THIS label, so a server is already running and this
    // spawn attaches. -N (when supported) closes the macOS probe→exec
    // ECONNREFUSED fork race; no census needed on the happy path.
    return { mode: 'spawn', noFork: i.supportsNoFork };
  }

  // Census unreadable: we cannot prove cold NOR prove a live displaced server.
  // Fail closed — wait within the caller's bounded budget, never boot. (A wedged
  // lsof/timeout must not collapse to a cold boot and fork a competitor.)
  if (i.listeners === null) {
    return {
      mode: 'wait',
      reason: 'owner unreachable and the listener census could not be read; refusing a possibly-competing boot',
      // macOS <3.2 additionally cannot use -N/SIGUSR1; otherwise the wait is
      // still a real protection (the eventual spawn will carry -N when ≥3.2).
      unprotected: !i.supportsNoFork && !i.canSignalRecovery,
    };
  }

  // Census successfully READ and found zero listeners. This is positive cold
  // evidence on BOTH platforms: a busy/backlogged live server is still bound to
  // the pathname and the census (lsof on macOS, /proc on Linux) necessarily
  // sees it, while a socket file left behind after the last session exits,
  // kill-server or SIGKILL has NO process bound to it. The owner answer does
  // not matter — "no server running" and a connect error both describe that
  // dead-file state. Waiting here would deadlock forever against the residual
  // file (a normal occurrence); the two-creators cold-start race is handled by
  // tmux's own socket lock.
  if (i.listeners.length === 0) {
    return { mode: 'spawn', noFork: false };
  }

  // A live listener is bound but the owner is not answering.
  // SIGUSR1 socket recovery only where the pid/census proof is strong (Linux).
  if (i.canSignalRecovery && i.filePresent === false) {
    // Multi-orphan shape: the socket file is gone but one or several botmux server
    // generations still LISTEN on the pathname at the same time.
    // Recover the NEWEST by start time instead of deadlocking. The caller
    // re-runs the census before signalling; older generations go to the reaper.
    const chosen = newestBotmuxListener(i.listeners, i.isBotmuxListener, i.startTicks);
    if (chosen !== null) return { mode: 'recreate-socket', pid: chosen };
  }

  return {
    mode: 'wait',
    reason: `listener(s) ${i.listeners.join(',')} bound but owner unreachable; waiting instead of booting a competing server`,
    // Old client on a non-/proc platform (macOS tmux < 3.2): neither -N nor
    // SIGUSR1 recovery is available, and busy-server forks there. We still hold
    // (fail rather than cold-boot), but must not claim this blocks the fork.
    unprotected: !i.supportsNoFork && !i.canSignalRecovery,
  };
}

/**
 * Resolve one boot cycle on `socketName`: probe, census, decide, and perform a
 * SIGUSR1 recreate when directed (once per resolve call). Returns the
 * directive the caller acts on (spawn/wait). Never execs new-session itself.
 */
export function resolveBootDirective(
  socketName: string | undefined,
  seam: TmuxServerGuardSeam = {},
): BootDirective {
  const env = seam.env ?? process.env;
  if (env.BOTMUX_DISABLE_TMUX_ANTI_FORK === '1') return { mode: 'spawn', noFork: false };
  const platform = seam.platform ?? process.platform;
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const socketPath = tmuxSocketPath(env, uid, socketName);

  const owner = seam.owner
    ?? (seam.probeOwner ? seam.probeOwner() : probeTmuxOwner(socketName, env));
  const supportsNoFork = seam.supportsNoFork ?? supportsNoForkForEnv(env);
  // SIGUSR1 socket recovery is safe only where pid/census/fingerprint proof is
  // strong (Linux /proc). macOS has no /proc and a wider TOCTOU window.
  const canSignalRecovery = seam.canSignalRecovery ?? (platform === 'linux');
  if (owner.kind === 'reachable') {
    // Happy path: a server answered, so attach; -N when supported. No census
    // (an answering owner is necessarily listening).
    return { mode: 'spawn', noFork: supportsNoFork };
  }

  const censusListeners = seam.listeners
    ?? (seam.listeningServerPids ? seam.listeningServerPids() : listeningServersOnPath(socketPath, platform));
  // NOTE: null (unreadable) is preserved and fails closed inside the decision;
  // do NOT coalesce it to [].
  const listeners = censusListeners;
  const filePresent = seam.filePresent
    ?? (seam.socketFilePresent ? seam.socketFilePresent() : (() => {
        try { lstatSync(socketPath); return true; }
        catch (err) { return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? false : null; }
      })());
  const isBotmuxListener = seam.isBotmuxListener ?? defaultIsBotmuxListener;
  const startTicks = seam.startTicks ?? procStartTicks;

  const directive = decideBootDirective({
    owner, listeners, filePresent, supportsNoFork, canSignalRecovery, isBotmuxListener, startTicks,
  });
  if (directive.mode === 'recreate-socket') {
    if (!recoverNewestBotmuxSocket(socketPath, platform, directive.pid, {
      listeningServerPids: seam.listeningServerPids, isBotmuxListener, startTicks, recreateSocket: seam.recreateSocket,
    })) {
      return { mode: 'wait', reason: 'socket state changed before SIGUSR1; not stealing a successor path' };
    }
  }
  return directive;
}

export interface RecoverSocketSeam {
  listeningServerPids?: (path: string, platform: NodeJS.Platform) => number[] | null;
  isBotmuxListener?: (pid: number) => boolean;
  startTicks?: (pid: number) => number | null;
  recreateSocket?: (pid: number) => void;
}

/**
 * Ask the displaced botmux server `expectedPid` (the newest bmx listener chosen
 * by {@link decideBootDirective}) to recreate an ENOENT socket via SIGUSR1.
 *
 * Re-runs the census immediately before signalling: SIGUSR1 first unlinks then
 * binds, so the path must STILL be absent, the pid must STILL listen, and it
 * must STILL be the newest botmux listener. If a successor rebound meanwhile,
 * the signal is withheld (never steal its path). Returns true only when the
 * signal was sent.
 */
export function recoverNewestBotmuxSocket(
  socketPath: string,
  platform: NodeJS.Platform,
  expectedPid: number,
  seam: RecoverSocketSeam = {},
): boolean {
  const census = seam.listeningServerPids ?? listeningServersOnPath;
  const isBotmuxListener = seam.isBotmuxListener ?? defaultIsBotmuxListener;
  const startTicks = seam.startTicks ?? procStartTicks;
  const recreate = seam.recreateSocket ?? ((pid) => { process.kill(pid, 'SIGUSR1'); });

  const fresh = census(socketPath, platform);
  let fileNow: boolean | null;
  try { lstatSync(socketPath); fileNow = true; }
  catch (err) { fileNow = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? false : null; }

  const chosenTicks = startTicks(expectedPid);
  const stillNewest = Array.isArray(fresh)
    && fresh.includes(expectedPid)
    && fresh.filter(p => isBotmuxListener(p))
      .every(p => (startTicks(p) ?? -1) <= (chosenTicks ?? Number.POSITIVE_INFINITY));
  if (fileNow !== false || !stillNewest) return false;
  recreate(expectedPid);
  return true;
}

/**
 * Choose the NEWEST (by /proc start time) botmux-fingerprinted listener for a
 * socket path whose file is gone, or null when there is none / the census is
 * unreadable. Used by both the worker boot gate and the daemon orphan reaper's
 * pre-bootstrap recovery.
 */
export function newestBotmuxListener(
  listeners: number[],
  isBotmuxListener: (pid: number) => boolean,
  startTicks: (pid: number) => number | null,
): number | null {
  const botmux = listeners.filter(p => isBotmuxListener(p));
  if (botmux.length === 0) return null;
  let chosen = botmux[0]!;
  let newestTicks: number | null = startTicks(chosen);
  for (const pid of botmux.slice(1)) {
    const t = startTicks(pid);
    // Unknown ticks never win; a known start time beats an unknown one, and a
    // strictly larger known start time (started later) wins.
    if (t !== null && (newestTicks === null || t > newestTicks)) { chosen = pid; newestTicks = t; }
  }
  return chosen;
}
