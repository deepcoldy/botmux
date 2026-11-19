/**
 * SAFE, session-scoped reaping of panes inside an unreachable orphaned tmux
 * server.
 *
 * The startup reaper (orphan-tmux-reaper.ts) only terminates whole SERVERS and
 * only behind a default-off switch. An orphan server that cannot be reached on
 * its socket cannot be managed with tmux commands (`list-panes`/`kill-session`
 * only see the reachable server — measured: killing a same-named session
 * through the reachable server kills the WRONG pane). The ONLY handles to an
 * unreachable orphan's panes are kernel pids, so this module reasons entirely
 * from a process snapshot and NEVER shells out to tmux for the orphan.
 *
 * ─── Conservatism (this code can signal a process) ──────────────────────────
 *
 * There is no introspection-based proof that a pane is "idle": a sleeping
 * shell, an editor, a long build and a network/lock-waiting agent all look like
 * one quiet child. Autonomous idle-kill is therefore NOT implemented. The only
 * pane eligible for an automatic signal is a PROVEN-TAKEN-OVER BARE WRAPPER:
 *
 *   1. the reachable server already runs a LIVE session carrying the SAME
 *      botmux instance binding (the orphan copy is provably a duplicate), AND
 *   2. the orphan pane's whole process group is a bare wrapper with NO live CLI
 *      payload (the CLI already exited — only the shell / botmux pipe helpers
 *      / zombies remain), AND
 *   3. NO process anywhere holds a thread-writer lock attributable to the
 *      pane (global veto; includes setsid/double-forked descendants), AND
 *   4. every member is signalable by our uid (one EPERM aborts the pane).
 *
 * Anything else is REPORT-ONLY. The whole sweep fails closed: a single
 * unreadable proc entry / lock table / EPERM boundary suppresses kills for that
 * pass (it may still report), because "no lock holder" must never be confused
 * with "could not enumerate lock holders".
 *
 * Linux only for the destructive path (/proc/locks + fd + pgid give strong
 * proof). On macOS this module reports only.
 */

import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

/** Parse /proc/<pid>/stat into {state,ppid,pgid,startTicks}; null on failure. */
export function parseProcStat(stat: string): { state: string; ppid: number; pgid: number; startTicks: number | null } | null {
  const rp = stat.lastIndexOf(')');
  if (rp < 0) return null;
  const after = stat.slice(rp + 2).split(' ');
  // after[0]=state [1]=ppid [2]=pgrp ... [19]=starttime
  const ppid = Number(after[1]);
  const pgid = Number(after[2]);
  const startTicks = Number(after[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(pgid)) return null;
  return { state: after[0] ?? '?', ppid, pgid, startTicks: Number.isFinite(startTicks) ? startTicks : null };
}

/**
 * Enumerate the pane roots of an unreachable orphan tmux server.
 *
 * A pane root is a direct, non-zombie child of the server that is its OWN
 * process-group leader (tmux puts each pane shell in a fresh pgid/sid):
 * `pgid === pid` AND `pgid !== orphanPid`. This is essential because the
 * server also direct-forks pipe-pane/status helpers (`sh … cat`) which live in
 * the SERVER's own process group (pgid === orphanPid) and, measured, can even
 * carry BOTMUX_CODEX_INSTANCE_BINDING in their environment. Treating such a
 * helper as a pane would aim SIGHUP at a group that contains the orphan
 * server pid — the one process this sweep must never signal. Nested tmux
 * servers and any child sharing the server's pgid are excluded.
 */
export function enumerateOrphanPanes(
  orphanPid: number,
  procs: RichProc[],
  readEnviron: (pid: number) => string | null,
): OrphanPane[] {
  const panes: OrphanPane[] = [];
  for (const p of procs) {
    if (p.ppid !== orphanPid || isZombieState(p.state)) continue;
    // A child that is itself a tmux process (nested server) is not a managed pane.
    if (p.comm === 'tmux') continue;
    // Pane shells lead their own pgid distinct from the server; helpers stay in
    // the server's pgid and must never be treated as panes.
    if (p.pgid === orphanPid || p.pgid !== p.pid) continue;
    const env = readEnviron(p.pid);
    let binding: string | undefined;
    let sessionName: string | undefined;
    if (env) {
      for (const entry of env.split('\0')) {
        if (entry.startsWith('BOTMUX_CODEX_INSTANCE_BINDING=')) binding = entry.slice('BOTMUX_CODEX_INSTANCE_BINDING='.length);
        else if (entry.startsWith('BOTMUX_TMUX_SESSION=')) sessionName = entry.slice('BOTMUX_TMUX_SESSION='.length);
      }
    }
    panes.push({ panePid: p.pid, sessionName: sessionName ?? `pane:${p.pid}`, instanceBinding: binding });
  }
  return panes;
}

function isZombieState(state: string): boolean { return state === 'Z' || state === 'X'; }

/** Richer than worker-pool's ProcSnapshot: the extra /proc/<pid>/stat fields
 *  safe signalling needs. */
export interface RichProc {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  uid: number;
  /** Clock ticks since boot (starttime). Fences pid reuse across re-checks. */
  startTicks: number | null;
  comm: string;
  cmd: string;
}

/** A pane to evaluate: the pane root pid (tmux's pane_pid = the shell tmux
 *  forked), its session name and botmux instance binding. */
export interface OrphanPane {
  panePid: number;
  sessionName: string;
  /** BOTMUX_CODEX_INSTANCE_BINDING read from the orphan pane's environment. */
  instanceBinding?: string;
}

export interface ReapInputs {
  /** Pane roots of the unreachable orphan server. */
  panes: OrphanPane[];
  /** Live process table (with pgid/state/start). */
  procs: RichProc[];
  /** Instance bindings the REACHABLE server currently owns (live sessions). */
  reachableBindings: ReadonlySet<string>;
  /** Pids holding a thread-writer lock anywhere (global veto set). */
  lockHolderPids: ReadonlySet<number>;
  /** Effective uid running the sweep (members must be ours to signal). */
  ownUid: number;
  /** Enable the one narrow destructive action. Default off ⇒ report only. */
  permitBareWrapperReap?: boolean;
  /** Recognise a non-CLI helper process (tmux pipe `cat`, stty, the shell,
   *  botmux program-status-relay, zombies). Everything else is live payload. */
  isHelperComm?: (comm: string, cmd: string) => boolean;
}

export type PaneVerdictReason =
  | 'bare-wrapper-taken-over'
  | 'not-a-duplicate-no-reachable-binding'
  | 'live-cli-payload'
  | 'lock-held'
  | 'unsignalable-member'
  | 'pid-reuse-or-tree-change';

export interface PaneVerdict {
  panePid: number;
  sessionName: string;
  /** Signal the pane process group (SIGHUP, mirroring tmux pane close). */
  kill: boolean;
  /** Every pid that would be signalled (the pgid set), for logging/tests. */
  memberPids: number[];
  reason: PaneVerdictReason;
}

export interface ReapResult {
  verdicts: PaneVerdict[];
  /** True only when the FULL process/lock census was trustworthy. On any
   *  enumeration gap this is false and every `kill` is suppressed (fail
   *  closed) regardless of the predicate. */
  censusComplete: boolean;
}

/** Shell / botmux helper names that may remain in a pane AFTER its CLI exited.
 *  Conservative allowlist; anything not here counts as live CLI payload. */
const BARE_HELPER_COMM = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ash',
  'cat', 'stty', 'sleep', 'env',
  'tmux', 'systemd', // tmux-server-side pipe helper / scope sh parent
]);
const BARE_HELPER_CMD_HINTS = [
  'program-status-relay',
  'pipe-pane',
  'bmx-psr',
  'session-scope',
];

export function defaultIsHelperComm(comm: string, cmd: string): boolean {
  if (BARE_HELPER_COMM.has(comm)) return true;
  // Zombies carry no payload regardless of comm.
  return BARE_HELPER_CMD_HINTS.some(h => cmd.includes(h));
}

function isZombie(state: string): boolean { return state === 'Z' || state === 'X'; }

/**
 * Build the process group of a pane root: pids whose pgid == pane_pid, UNION
 * the ppid subtree. A setsid/forked descendant takes its OWN pgid and is
 * therefore caught by the subtree arm. The two sets MUST agree on membership
 * of non-helper processes: if the subtree contains a live payload not in the
 * pane's pgid, that is an escaped process — the lock veto and payload checks
 * still see it (the sweep scans the full table), but it is NOT signalled with
 * the group. Returns members plus whether any non-zombie member escaped the
 * pgid (a reason to stay report-only).
 */
export function paneProcessGroup(panePid: number, procs: RichProc[]): { members: Set<number>; escapedPayload: boolean } {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const root = byPid.get(panePid);
  const pgid = root?.pgid ?? panePid;
  const members = new Set<number>();
  // pgid arm
  for (const p of procs) if (p.pgid === pgid) members.add(p.pid);
  // subtree arm (BFS)
  const childrenOf = new Map<number, number[]>();
  for (const p of procs) {
    const arr = childrenOf.get(p.ppid);
    if (arr) arr.push(p.pid); else childrenOf.set(p.ppid, [p.pid]);
  }
  const seen = new Set<number>([panePid]);
  const queue = [panePid];
  let escapedPayload = false;
  while (queue.length) {
    const cur = queue.shift()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      const cp = byPid.get(child);
      if (cp) {
        if (cp.pgid !== pgid && !isZombie(cp.state) && !defaultIsHelperComm(cp.comm, cp.cmd)) {
          escapedPayload = true;
        }
      }
      queue.push(child);
    }
  }
  return { members, escapedPayload };
}

/**
 * Evaluate every pane of one unreachable orphan server. Pure: no syscalls, so
 * the safety predicate is exhaustively unit-testable on fake process tables.
 */
export function classifyOrphanPanes(inputs: ReapInputs): ReapResult {
  const isHelper = inputs.isHelperComm ?? defaultIsHelperComm;
  const byPid = new Map(inputs.procs.map(p => [p.pid, p]));
  const verdicts: PaneVerdict[] = [];

  for (const pane of inputs.panes) {
    const { members, escapedPayload } = paneProcessGroup(pane.panePid, inputs.procs);
    const memberList = [...members].sort((a, b) => a - b);

    const reasonFor = (): PaneVerdictReason => {
      // 2. no live CLI payload: every non-zombie member must be a bare helper.
      let livePayload = false;
      let unsignalable = false;
      for (const pid of members) {
        const p = byPid.get(pid);
        if (!p) continue;
        if (isZombie(p.state)) continue;
        if (p.uid !== inputs.ownUid) { unsignalable = true; continue; }
        if (!isHelper(p.comm, p.cmd)) livePayload = true;
      }
      if (unsignalable) return 'unsignalable-member';
      if (livePayload || escapedPayload) return 'live-cli-payload';

      // 3. global lock veto: any member (incl. an escaped descendant by subtree
      // membership via the lock set) holds a thread-writer lock.
      for (const pid of members) if (inputs.lockHolderPids.has(pid)) return 'lock-held';
      // Also veto when a lock holder sits anywhere in the pane's ppid subtree.
      const subtree = new Set<number>([pane.panePid]);
      {
        const childrenOf = new Map<number, number[]>();
        for (const p of inputs.procs) {
          const arr = childrenOf.get(p.ppid);
          if (arr) arr.push(p.pid); else childrenOf.set(p.ppid, [p.pid]);
        }
        const q = [pane.panePid];
        while (q.length) {
          const cur = q.shift()!;
          for (const c of childrenOf.get(cur) ?? []) {
            if (subtree.has(c)) continue;
            subtree.add(c); q.push(c);
          }
        }
      }
      for (const pid of subtree) if (inputs.lockHolderPids.has(pid)) return 'lock-held';

      // GLOBAL, escape-aware veto for the bare-wrapper case. A killable pane is,
      // by construction, one whose CLI has FULLY exited — so there must be no
      // live thread-writer-lock holder anywhere attributable to a displaced
      // server on this label. A setsid/double-forked/reparented-to-init live CLI
      // leaves the pane's pgid AND ppid subtree, but its lock is still held; if
      // ANY thread-lock holder exists host-wide in a kill pass, do not signal a
      // bare-wrapper pane (the residual holder would strand the new session on
      // "open in another app"). This is conservative by design and only gates
      // the opt-in kill; report-only is unaffected.
      if (inputs.lockHolderPids.size > 0) return 'lock-held';

      // 1. proven takeover: a live reachable session owns the same binding.
      const dup = pane.instanceBinding !== undefined && inputs.reachableBindings.has(pane.instanceBinding);
      if (!dup) return 'not-a-duplicate-no-reachable-binding';
      return 'bare-wrapper-taken-over';
    };

    const reason = reasonFor();
    const killable = inputs.permitBareWrapperReap === true && reason === 'bare-wrapper-taken-over';
    verdicts.push({ panePid: pane.panePid, sessionName: pane.sessionName, kill: killable, memberPids: memberList, reason });
  }

  return { verdicts, censusComplete: true };
}

/**
 * Linux: pids holding a codex/traex thread-writer lock, by readlink-ing every
 * `/proc/<pid>/fd` and matching `…/thread-writer-locks/<uuid>.lock` (including
 * the ` (deleted)` suffix). This single source is authoritative: it is
 * path-specific (a /proc/locks WRITE row alone cannot be attributed to a lock
 * PATH — POSIX/flock locks carry no name), it catches deleted-but-held files,
 * and every POSIX/flock holder necessarily has the file open on some fd, so
 * the fd scan cannot miss a live holder.
 *
 * Returns null when enumeration is incomplete (unreadable /proc or an EPERM/
 * EACCES fd boundary), so callers fail closed. A process that vanishes mid-scan
 * (ENOENT/ESRCH) is benign.
 */
export function enumerateThreadLockHolders(): Set<number> | null {
  if (process.platform !== 'linux') return null;
  const holders = new Set<number>();
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return null; }

  let sawAnyProc = false;
  const isBenignExit = (err: unknown): boolean => {
    const code = (err as { code?: string } | null)?.code;
    return code === 'ENOENT' || code === 'ESRCH';
  };
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    sawAnyProc = true;
    const pid = Number(e);
    let fds: string[];
    try { fds = readdirSync(`/proc/${e}/fd`); }
    catch (err) { if (!isBenignExit(err)) return null; continue; }
    for (const fd of fds) {
      let target: string;
      try { target = readlinkSync(`/proc/${e}/fd/${fd}`); }
      catch (err) { if (!isBenignExit(err)) return null; continue; }
      if (/[\\/]thread-writer-locks[\\/][0-9a-fA-F-]{36}\.lock(?: \(deleted\))?$/i.test(target)) {
        holders.add(pid);
        break;
      }
    }
  }
  if (!sawAnyProc) return null;
  return holders;
}

/** uid of a process from /proc/<pid>/status's Uid line. null if unreadable. */
function procUid(pid: number): number | null {
  try {
    for (const line of readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')) {
      if (line.startsWith('Uid:')) {
        const real = Number(line.slice(4).trim().split(/\s+/)[0]);
        return Number.isFinite(real) ? real : null;
      }
    }
  } catch { /* unreadable */ }
  return null;
}

/**
 * Build the rich process table from /proc. Returns null when enumeration is
 * incomplete so the sweep fails closed (never kills on a partial table).
 */
export function loadRichProcsLinux(): RichProc[] | null {
  if (process.platform !== 'linux') return null;
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return null; }
  const out: RichProc[] = [];
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    let statRaw: string; let cmd: string;
    try {
      statRaw = readFileSync(`/proc/${e}/stat`, 'utf8');
      cmd = readFileSync(`/proc/${e}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch { continue; }
    const parsed = parseProcStat(statRaw);
    if (!parsed) continue;
    const uid = procUid(pid);
    out.push({
      pid, ppid: parsed.ppid, pgid: parsed.pgid, state: parsed.state,
      uid: uid ?? -1, startTicks: parsed.startTicks,
      comm: (() => { try { return readFileSync(`/proc/${e}/comm`, 'utf8').trim(); } catch { return ''; } })(),
      cmd,
    });
  }
  return out;
}

/** Read /proc/<pid>/environ (null on EPERM/ENOENT — the sweep treats that as
 *  non-identifiable, not as an error). */
export function readProcEnviron(pid: number): string | null {
  try { return readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return null; }
}

export interface OrphanSweepOptions {
  /** Pids of displaced, unreachable orphan servers on the label pathname. */
  orphanServerPids: number[];
  /** Instance bindings currently owned by the REACHABLE server (live dup
   *  proof). Empty on macOS / when unavailable ⇒ nothing is proven taken over. */
  reachableBindings: ReadonlySet<string>;
  procs: RichProc[] | null;
  lockHolderPids: ReadonlySet<number> | null;
  ownUid: number;
  permitBareWrapperReap?: boolean;
  /** Pane enumeration seam. Defaults to the real /proc enumeration; injected by
   *  tests that must place a pane the live topology would filter out (e.g. a
   *  same-server-pgid helper) so the signalling GUARDS are actually exercised. */
  enumeratePanes?: (orphanPid: number, procs: RichProc[]) => OrphanPane[];
}

export interface OrphanSweepReport {
  censusComplete: boolean;
  panesEvaluated: number;
  killablePgroups: number[];
  /** reason → count, for logging/Dashboard diagnostics. */
  byReason: Record<string, number>;
}

/**
 * Evaluate every pane of every displaced orphan server. Returns a report; the
 * destructive action is enabled ONLY by `permitBareWrapperReap` AND a complete
 * census. This function does not itself signal — the daemon applies
 * `killablePgroups` (SIGHUP) after its own re-check, keeping all syscalls at
 * the edge and the predicate fully testable.
 */
export function planOrphanSessionSweep(opts: OrphanSweepOptions): OrphanSweepReport {
  const byReason: Record<string, number> = {};
  if (opts.procs === null || opts.lockHolderPids === null) {
    return { censusComplete: false, panesEvaluated: 0, killablePgroups: [], byReason };
  }
  let panesEvaluated = 0;
  const killable = new Set<number>();
  const enumerate = opts.enumeratePanes ?? ((pid, procs) => enumerateOrphanPanes(pid, procs, readProcEnviron));
  for (const orphanPid of opts.orphanServerPids) {
    const panes = enumerate(orphanPid, opts.procs);
    const result = classifyOrphanPanes({
      panes,
      procs: opts.procs,
      reachableBindings: opts.reachableBindings,
      lockHolderPids: opts.lockHolderPids,
      ownUid: opts.ownUid,
      permitBareWrapperReap: opts.permitBareWrapperReap,
    });
    if (!result.censusComplete) {
      return { censusComplete: false, panesEvaluated, killablePgroups: [], byReason };
    }
    for (const v of result.verdicts) {
      panesEvaluated += 1;
      byReason[v.reason] = (byReason[v.reason] ?? 0) + 1;
      if (v.kill) for (const m of v.memberPids) killable.add(m);
    }
  }
  return {
    censusComplete: true,
    panesEvaluated,
    killablePgroups: [...killable].sort((a, b) => a - b),
    byReason,
  };
}

/**
 * Daemon-facing periodic sweep over candidate tmux socket labels.
 *
 * Default mode is REPORT-ONLY (safe to run on a schedule): for every label it
 * finds a reachable owner PLUS one or more other botmux-fingerprinted
 * LISTENING servers on the same pathname (the displaced/orphan generations),
 * it reports counts. With `permitBareWrapperReap` it additionally computes the
 * strict kill plan (and signals via the injected `signal`); that destructive
 * mode is default OFF and Linux-only.
 *
 * All heavy syscalls are injected so the function is unit-testable; the
 * production wiring supplies /proc + tmux helpers. Returns a small report the
 * daemon logs.
 */
export interface PeriodicSweepSeam {
  platform?: NodeJS.Platform;
  /** Socket labels to inspect (default + 'botmux' + per-session frozen names). */
  socketNames?: Iterable<string | undefined>;
  listeningPids: (socketPath: string, platform: NodeJS.Platform) => number[] | null;
  socketPath: (socketName: string | undefined) => string;
  reachablePid: (socketName: string | undefined) => number | null;
  isBotmuxPid: (pid: number) => boolean;
  /** Populated only in destructive mode: instance bindings live on the
   *  reachable server (used to prove takeover). */
  reachableBindings?: (socketName: string | undefined) => ReadonlySet<string>;
  loadProcs?: () => RichProc[] | null;
  lockHolders?: () => ReadonlySet<number> | null;
  enumeratePanes?: (orphanPid: number, procs: RichProc[]) => OrphanPane[];
  ownUid?: number;
  permitBareWrapperReap?: boolean;
  /** Receives each signalable member pid of an approved bare-wrapper pane
   *  (all share the pane's process group, vetted same-uid by the plan). */
  signal?: (pid: number) => void;
  log?: (message: string) => void;
}

export interface PeriodicSweepResult {
  labelsScanned: number;
  orphanServers: number;
  panesEvaluated: number;
  /** Pgids signalled (always empty in report-only mode). */
  signalled: number[];
  censusComplete: boolean;
}

export function runPeriodicOrphanSessionSweep(seam: PeriodicSweepSeam): PeriodicSweepResult {
  const platform = seam.platform ?? process.platform;
  if (platform !== 'linux' && seam.permitBareWrapperReap === true) {
    // Strong proof exists only on Linux; never auto-signal elsewhere.
    seam.log?.('[orphan-session-sweep] destructive sweep requested on a non-Linux platform; reporting only');
  }
  const result: PeriodicSweepResult = {
    labelsScanned: 0, orphanServers: 0, panesEvaluated: 0, signalled: [], censusComplete: true,
  };

  for (const socketName of seam.socketNames ?? []) {
    result.labelsScanned += 1;
    const socketPath = seam.socketPath(socketName);
    const listeners = seam.listeningPids(socketPath, platform);
    if (listeners === null) {
      // Unreadable census for one label: report and keep going; do NOT kill on
      // this pass anywhere we cannot fully enumerate.
      seam.log?.(`[orphan-session-sweep] listener census unreadable for ${socketName ?? 'default'}; skipping`);
      result.censusComplete = false;
      continue;
    }
    const reachable = seam.reachablePid(socketName);
    // A single listening server (even if the owner probe is briefly null) is a
    // slow/current server, NEVER an orphan. We need a positive reachable owner
    // AND >=2 distinct listening pids on the label before labelling anything;
    // an owner probe timeout on a saturated server must not turn the only live
    // server into a "displaced" one.
    if (reachable === null) {
      seam.log?.(`[orphan-session-sweep] ${socketName ?? 'default'}: owner unknown (probe timed out / slow server); not classifying orphans`);
      continue;
    }
    if (listeners.length < 2 || !listeners.includes(reachable)) {
      // One listener (or the owner vanished from the census between calls):
      // nothing provably displaced. Skip.
      continue;
    }
    // Orphans = other botmux listeners that are not the reachable owner.
    const orphans = listeners.filter(p => p !== reachable && seam.isBotmuxPid(p));
    if (orphans.length === 0) continue;

    result.orphanServers += orphans.length;
    seam.log?.(`[orphan-session-sweep] ${socketName ?? 'default'}: reachable owner=${reachable}, ${orphans.length} displaced botmux listener(s) ${orphans.join(',')}`);

    // Destructive mode is opt-in and Linux-only. Report-only never enumerates
    // the process table / locks (keeps the default periodic pass cheap).
    const mayKill = seam.permitBareWrapperReap === true
      && platform === 'linux'
      && reachable !== null
      && seam.loadProcs && seam.lockHolders && seam.enumeratePanes && seam.signal;
    if (!mayKill) continue;

    const procs = seam.loadProcs!();
    const lockHolders = seam.lockHolders!();
    const signalPid = seam.signal!;
    if (procs === null || lockHolders === null) { result.censusComplete = false; continue; }
    const plan = planOrphanSessionSweep({
      orphanServerPids: orphans,
      reachableBindings: seam.reachableBindings?.(socketName) ?? new Set<string>(),
      procs, lockHolderPids: lockHolders,
      ownUid: seam.ownUid ?? (typeof process.getuid === 'function' ? process.getuid() : -1),
      permitBareWrapperReap: true,
      enumeratePanes: seam.enumeratePanes,
    });
    result.panesEvaluated += plan.panesEvaluated;
    if (!plan.censusComplete) { result.censusComplete = false; continue; }

    // Owner stability TOCTOU guard: re-probe the reachable owner right before
    // signalling. If it changed (or is gone) the topology moved mid-pass — abort
    // this label rather than act on a stale classification.
    const ownerAfter = seam.reachablePid(socketName);
    if (ownerAfter !== reachable) {
      result.censusComplete = false;
      seam.log?.(`[orphan-session-sweep] ${socketName ?? 'default'}: owner changed mid-pass (${reachable} → ${ownerAfter ?? 'null'}); aborting`);
      continue;
    }
    const listenersAfter = seam.listeningPids(socketPath, platform);
    if (listenersAfter === null || !listenersAfter.includes(reachable)) {
      result.censusComplete = false;
      seam.log?.(`[orphan-session-sweep] ${socketName ?? 'default'}: listener census changed mid-pass; aborting`);
      continue;
    }

    // HARD GUARD: never signal an orphan server pid or any process sharing an
    // orphan server's process group (pipe-pane/status helpers live there). A
    // bare-wrapper pane leads its OWN pgid, so an approved member can never be
    // in one of these groups. If the plan somehow contains such a pid, abort
    // signalling for the whole label rather than risk taking down a server.
    const forbiddenPids = new Set<number>();
    for (const orphanPid of orphans) {
      forbiddenPids.add(orphanPid);
      const serverProc = procs.find(p => p.pid === orphanPid);
      const serverPgid = serverProc?.pgid ?? orphanPid;
      for (const p of procs) if (p.pgid === serverPgid) forbiddenPids.add(p.pid);
    }
    const dangerous = plan.killablePgroups.filter(p => forbiddenPids.has(p));
    if (dangerous.length > 0) {
      result.censusComplete = false;
      seam.log?.(`[orphan-session-sweep] ${socketName ?? 'default'}: refusing to signal server/helper pid(s) ${dangerous.join(',')}; aborting this label`);
      continue;
    }

    for (const pid of plan.killablePgroups) {
      try { signalPid(pid); result.signalled.push(pid); }
      catch (err) { seam.log?.(`[orphan-session-sweep] failed to signal pid ${pid}: ${String(err)}`); }
    }
    seam.log?.(`[orphan-session-sweep] ${socketName ?? 'default'}: ${plan.panesEvaluated} pane(s) evaluated, byReason=${JSON.stringify(plan.byReason)}, signalled=${result.signalled.length}`);
  }
  return result;
}
