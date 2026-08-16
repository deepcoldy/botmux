/**
 * Which processes still belong to a mojo turn, and are they gone yet?
 *
 * Why a PGID is not enough
 * ------------------------
 * Signalling `-pgid` looked sufficient, but a descendant can call `setsid()` (or
 * be spawned with `detached: true`) and become the leader of a NEW group and
 * session. It then survives every `kill(-pgid)` aimed at the original group while
 * still holding the inherited `X_JWT_TOKEN`. Reparenting to init also destroys the
 * PPID chain once the direct child exits, so neither PGID nor parentage alone can
 * enumerate the subtree.
 *
 * The three signals below are therefore unioned, because each covers the others'
 * blind spot:
 *   - PGID           the common case, and the only one that works before /proc
 *                    has been read
 *   - env nonce      a unique value injected into the turn's environment. It is
 *                    inherited by every descendant and survives setsid, a new
 *                    session, and reparenting to init
 *   - PPID chain     catches a descendant that scrubbed its own environ but is
 *                    still parented inside the tree
 *
 * Trust domain: this is a DIAGNOSTIC SIGNAL, not a boundary
 * --------------------------------------------------------
 * A hijacked child runs as the same user, so a descendant that both setsids AND
 * overwrites its own environ area can still evade enumeration. Reading a clean
 * scan as "the credential is now unreachable" is therefore unsound, and the type
 * system now says so: a successful scan is stamped `evidence: 'diagnostic'`, and
 * `quiescenceFromScan()` maps even an EMPTY member list to
 * `{ kind: 'diagnostic-clean', boundaryProof: false }`. Only a kernel-level
 * container (per-session cgroup v2 / pid namespace, see mojo-containment) can
 * produce `boundaryProof: true`. Callers must keep the session's
 * device-isolation blocker whenever `boundaryProof` is false — including the
 * clean-scan case.
 *
 * Fail-closed
 * -----------
 * Only ENOENT means "this pid exited between readdir and read", which is a
 * genuine non-member and safe to skip. EVERY other read or parse error means the
 * table we built is incomplete, and an incomplete table can hide a survivor, so
 * it fails the WHOLE scan instead of silently shrinking the result. The one
 * documented exception is EACCES/EPERM on `environ` (see readEnviron).
 */
import { readFileSync, readdirSync } from 'node:fs';

export interface MojoTreeMember {
  pid: number;
  ppid: number;
  pgid: number;
  /** Which signal matched, for operator-facing logs. */
  via: 'pgid' | 'env' | 'ppid';
  /**
   * True only when `/proc/<pid>/stat` field 3 is exactly `Z`.
   *
   * A zombie has already been reaped by the kernel: it executes no instructions
   * and cannot use the injected credential, it merely waits for its parent to
   * collect the exit status. Counting one as a survivor blocks the close forever
   * for a process that can do nothing — a safe direction, but an unrecoverable
   * one. Anything OTHER than a definite `Z` (including a state we could not read)
   * is treated as executing, so the discount can never be a free pass.
   */
  zombie: boolean;
}

/**
 * Why a scan could not be completed. Every variant is fail-closed at the call
 * site; the split exists so an operator can tell a permanently unscannable host
 * (`unsupported-platform`) from a transient or partial read failure.
 */
export type MojoTreeScanFailure =
  | { kind: 'unsupported-platform'; platform: string }
  | { kind: 'proc-unreadable'; detail: string }
  | { kind: 'proc-entry-unreadable'; pid: number; detail: string }
  | { kind: 'proc-entry-unparsable'; pid: number; detail: string };

export type MojoTreeScan =
  | {
      ok: true;
      /**
       * Never 'proof'. Present so a reader cannot mistake `ok: true` for a
       * credential-boundary guarantee — see the trust-domain note above.
       */
      evidence: 'diagnostic';
      members: MojoTreeMember[];
      /**
       * Pids whose `environ` was unreadable for a benign reason, so the env-nonce
       * signal could not speak for them. Surfaced rather than swallowed.
       */
      envBlindSpots: number[];
    }
  | { ok: false; failure: MojoTreeScanFailure; reason: string };

/**
 * Whether a turn subtree is gone, and — crucially — whether that answer is
 * strong enough to drop a credential blocker.
 *
 * `boundaryProof` is the ONLY field a blocker decision may consult. It is true
 * exclusively for `contained-proven`, which this module never produces: it is
 * reserved for the kernel-level containment handle.
 */
export type TurnQuiescence =
  | { kind: 'contained-proven'; boundaryProof: true }
  | { kind: 'diagnostic-clean'; boundaryProof: false }
  | { kind: 'alive'; boundaryProof: false; pids: number[] }
  | { kind: 'unscannable'; boundaryProof: false; reason: string }
  | { kind: 'unsupported-platform'; boundaryProof: false; platform: string };

/**
 * Identity of a pid that is stable across pid recycling.
 *
 * A bare pid is NOT a stable handle: the kernel recycles pids, so between
 * remembering `rootPid` and signalling it the number can belong to an unrelated
 * process — and `kill(-rootPid, SIGKILL)` would then take down a stranger's
 * process group. `starttime` (field 22 of /proc/<pid>/stat, in clock ticks since
 * boot) distinguishes a recycled pid, and `bootId` makes the pair meaningful
 * across a reboot, after which every starttime restarts from zero and a
 * persisted record would otherwise appear to match.
 */
export interface MojoProcessIdentity {
  pid: number;
  bootId: string;
  starttime: number;
}

export type MojoIdentityRead =
  | { ok: true; identity: MojoProcessIdentity }
  | { ok: false; failure: MojoTreeScanFailure; reason: string };

/** Injected into every turn child; inherited by the whole subtree. */
export const MOJO_TREE_NONCE_ENV = 'BOTMUX_MOJO_TREE_NONCE';

interface RawProc { pid: number; ppid: number; pgid: number; hasNonce: boolean; zombie: boolean }

interface ParsedStat { ppid: number; pgid: number; starttime: number; state: string }

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `/proc/<pid>/stat`: field 2 (comm) is parenthesised and may itself contain
 * spaces or ')', so the numeric tail must be cut at the LAST ')' rather than
 * split naively. After that cut, rest[0] is field 3 (state), so field N is
 * rest[N - 3]: ppid=4, pgid=5, starttime=22.
 */
function parseStat(text: string): ParsedStat | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const state = rest[0] ?? '';
  const ppid = Number(rest[1]);
  const pgid = Number(rest[2]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return null;
  // starttime is only needed for identity checks; a stat line truncated before
  // field 22 still yields a usable tree member, so it degrades to NaN here and
  // is rejected by readProcessIdentity instead of failing enumeration.
  const starttime = Number(rest[19]);
  return { ppid, pgid, starttime, state };
}

/** Boot id, so a persisted (pid, starttime) pair cannot survive a reboot. */
function readBootId(procRoot: string): { ok: true; bootId: string } | { ok: false; detail: string } {
  try {
    const raw = readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf-8').trim();
    if (raw.length === 0) return { ok: false, detail: 'boot_id is empty' };
    return { ok: true, bootId: raw };
  } catch (err) {
    return { ok: false, detail: `cannot read boot_id: ${messageOf(err)}` };
  }
}

/**
 * `/proc` is a Linux interface. On any other platform the layout either does not
 * exist or does not mean the same thing, so enumeration is refused OUTRIGHT
 * rather than allowed to fail its way into a misleading "nothing is running".
 *
 * An explicit `procRoot` override opts back in: that is how a test points the
 * scanner at a synthetic tree, and it is never set in production.
 */
export function mojoTreeScanSupported(
  opts: { platform?: string; procRootOverridden?: boolean } = {},
): boolean {
  if (opts.procRootOverridden) return true;
  return (opts.platform ?? process.platform) === 'linux';
}

function unsupportedScan(platform: string): MojoTreeScan & { ok: false } {
  return {
    ok: false,
    failure: { kind: 'unsupported-platform', platform },
    reason:
      `process-tree enumeration needs Linux /proc; platform is ${platform}. `
      + 'Quiescence cannot be established, so the caller must keep the blocker.',
  };
}

/**
 * `environ` is the one place a non-ENOENT error is tolerated.
 *
 * Scanning all of `/proc` necessarily touches OTHER users' processes, whose
 * environ is 0400 root-or-owner; EACCES there is the normal case, not a fault,
 * and failing the scan on it would make every multi-tenant host permanently
 * unscannable. It is not a blind spot that matters either: our descendants
 * inherit our uid, so a process we cannot read cannot be one of them. It is
 * still reported via `envBlindSpots` instead of being silently dropped.
 */
function readEnviron(
  procRoot: string,
  name: string,
): { state: 'read'; text: string } | { state: 'gone' } | { state: 'blind' } | { state: 'error'; detail: string } {
  try {
    return { state: 'read', text: readFileSync(`${procRoot}/${name}/environ`, 'utf-8') };
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT') return { state: 'gone' };
    if (code === 'EACCES' || code === 'EPERM') return { state: 'blind' };
    return { state: 'error', detail: messageOf(err) };
  }
}

function readProcTable(
  procRoot: string,
  nonce: string,
):
  | { ok: true; table: RawProc[]; envBlindSpots: number[] }
  | { ok: false; failure: MojoTreeScanFailure; reason: string } {
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch (err) {
    // No /proc (or unreadable) means the tree cannot be enumerated at all. The
    // caller must NOT read that as "nothing is running".
    return {
      ok: false,
      failure: { kind: 'proc-unreadable', detail: messageOf(err) },
      reason: `cannot read ${procRoot}: ${messageOf(err)}`,
    };
  }

  const table: RawProc[] = [];
  const envBlindSpots: number[] = [];

  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);

    let parsed: ParsedStat | null;
    try {
      parsed = parseStat(readFileSync(`${procRoot}/${name}/stat`, 'utf-8'));
    } catch (err) {
      // ENOENT: exited between readdir and read. A vanished process is genuinely
      // not a member, so skipping it is correct and is not a scan failure.
      if (errnoOf(err) === 'ENOENT') continue;
      // Anything else (EACCES, EIO, ...) means we cannot account for this pid.
      // An unaccounted pid could be the survivor we are looking for, so the whole
      // scan fails rather than quietly omitting it.
      return {
        ok: false,
        failure: { kind: 'proc-entry-unreadable', pid, detail: messageOf(err) },
        reason: `cannot read ${procRoot}/${name}/stat: ${messageOf(err)}`,
      };
    }
    if (parsed === null) {
      // A stat line we cannot parse is NOT an absent process. Skipping it used to
      // hide a live member behind a formatting surprise; fail instead.
      return {
        ok: false,
        failure: { kind: 'proc-entry-unparsable', pid, detail: 'unparsable stat line' },
        reason: `cannot parse ${procRoot}/${name}/stat`,
      };
    }

    const environ = readEnviron(procRoot, name);
    if (environ.state === 'gone') continue;          // raced us after stat; not a member
    if (environ.state === 'error') {
      return {
        ok: false,
        failure: { kind: 'proc-entry-unreadable', pid, detail: environ.detail },
        reason: `cannot read ${procRoot}/${name}/environ: ${environ.detail}`,
      };
    }
    if (environ.state === 'blind') envBlindSpots.push(pid);

    table.push({
      pid,
      ppid: parsed.ppid,
      pgid: parsed.pgid,
      // Only a definite 'Z' counts; an unreadable or surprising state must not
      // become an excuse to discount a live process.
      zombie: parsed.state === 'Z',
      // Zero-separated; a substring test is enough for a unique nonce.
      hasNonce: environ.state === 'read' && environ.text.includes(nonce),
    });
  }

  return { ok: true, table, envBlindSpots };
}

/**
 * Every live process still belonging to the turn rooted at `rootPid`.
 *
 * `excludePids` MUST contain the current process (and anything else that must
 * never be signalled): the daemon shares neither the nonce nor the group, but an
 * explicit guard is cheaper than trusting that invariant while sending SIGKILL.
 *
 * A successful result is a diagnostic signal only; see `quiescenceFromScan`.
 */
export function scanMojoTree(
  rootPid: number,
  nonce: string,
  opts: { procRoot?: string; excludePids?: readonly number[]; platform?: string } = {},
): MojoTreeScan {
  const platform = opts.platform ?? process.platform;
  if (!mojoTreeScanSupported({ platform, procRootOverridden: opts.procRoot !== undefined })) {
    return unsupportedScan(platform);
  }
  const procRoot = opts.procRoot ?? '/proc';
  const read = readProcTable(procRoot, nonce);
  if (!read.ok) return read;

  const excluded = new Set(opts.excludePids ?? []);
  const members = new Map<number, MojoTreeMember>();

  const claim = (p: RawProc, via: MojoTreeMember['via']): void => {
    if (excluded.has(p.pid) || members.has(p.pid)) return;
    members.set(p.pid, { pid: p.pid, ppid: p.ppid, pgid: p.pgid, via, zombie: p.zombie });
  };

  for (const p of read.table) {
    if (p.pid === rootPid || p.pgid === rootPid) claim(p, 'pgid');
    else if (p.hasNonce) claim(p, 'env');
  }
  // Transitive closure over parentage, so an env-scrubbed child of a known member
  // is still claimed. Bounded by the table size, so it cannot loop on a cycle.
  for (let changed = true; changed;) {
    changed = false;
    for (const p of read.table) {
      if (members.has(p.pid) || excluded.has(p.pid)) continue;
      if (!members.has(p.ppid)) continue;
      // Never walk up into init/the daemon: only DOWN from a known member.
      claim(p, 'ppid');
      changed = true;
    }
  }
  return {
    ok: true,
    evidence: 'diagnostic',
    members: [...members.values()],
    envBlindSpots: read.envBlindSpots,
  };
}

/**
 * Map a scan onto a quiescence verdict — WITHOUT ever minting boundary proof.
 *
 * An empty member list becomes `diagnostic-clean`, whose `boundaryProof` is
 * false, because enumeration cannot see a descendant that setsid'd and scrubbed
 * its environ. Callers keep the blocker unless `boundaryProof` is true.
 */
export function quiescenceFromScan(scan: MojoTreeScan): TurnQuiescence {
  if (!scan.ok) {
    if (scan.failure.kind === 'unsupported-platform') {
      return { kind: 'unsupported-platform', boundaryProof: false, platform: scan.failure.platform };
    }
    return { kind: 'unscannable', boundaryProof: false, reason: scan.reason };
  }
  // Zombies are discounted: already reaped, executing nothing, incapable of using
  // the credential. Keeping them would block the close forever on a process that
  // cannot act — safe in direction but impossible to recover from. Only a definite
  // 'Z' is discounted (see MojoTreeMember.zombie), so an unreadable state still
  // counts as executing.
  const executing = scan.members.filter(m => !m.zombie);
  if (executing.length > 0) {
    return { kind: 'alive', boundaryProof: false, pids: executing.map(m => m.pid) };
  }
  return { kind: 'diagnostic-clean', boundaryProof: false };
}

/** Read the recycle-proof identity of a pid. */
export function readProcessIdentity(
  pid: number,
  opts: { procRoot?: string; platform?: string } = {},
): MojoIdentityRead {
  const platform = opts.platform ?? process.platform;
  if (!mojoTreeScanSupported({ platform, procRootOverridden: opts.procRoot !== undefined })) {
    const failed = unsupportedScan(platform);
    return { ok: false, failure: failed.failure, reason: failed.reason };
  }
  const procRoot = opts.procRoot ?? '/proc';

  const boot = readBootId(procRoot);
  if (!boot.ok) {
    return { ok: false, failure: { kind: 'proc-unreadable', detail: boot.detail }, reason: boot.detail };
  }

  let text: string;
  try {
    text = readFileSync(`${procRoot}/${pid}/stat`, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'proc-entry-unreadable', pid, detail: messageOf(err) },
      reason: `cannot read ${procRoot}/${pid}/stat: ${errnoOf(err) ?? messageOf(err)}`,
    };
  }

  const parsed = parseStat(text);
  if (parsed === null || !Number.isInteger(parsed.starttime)) {
    return {
      ok: false,
      failure: { kind: 'proc-entry-unparsable', pid, detail: 'no usable starttime in stat' },
      reason: `cannot parse starttime from ${procRoot}/${pid}/stat`,
    };
  }

  return { ok: true, identity: { pid, bootId: boot.bootId, starttime: parsed.starttime } };
}

/** Same process, or a recycled pid wearing its number? */
export function sameProcessIdentity(a: MojoProcessIdentity, b: MojoProcessIdentity): boolean {
  return a.pid === b.pid && a.bootId === b.bootId && a.starttime === b.starttime;
}

export type TreeGroupSignalOutcome =
  | { kind: 'signalled' }
  /** The pid now belongs to a DIFFERENT process; nothing was signalled. */
  | { kind: 'identity-mismatch'; expected: MojoProcessIdentity; actual: MojoProcessIdentity }
  /** The root pid is already gone; nothing to signal, and nothing was. */
  | { kind: 'gone' }
  /** Identity could not be established, so signalling was refused. */
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'unsupported-platform'; platform: string };

/**
 * `kill(-rootPid, signal)` — but ONLY after proving the pid is still the process
 * we spawned.
 *
 * A bare group kill on a remembered pid is a footgun: pids recycle, so after the
 * turn root exits the number can name an unrelated process, and negating it
 * signals THAT process's whole group. Everything except a verified match
 * therefore signals nothing at all; refusing to kill is always recoverable,
 * killing the wrong group is not.
 */
export function signalTurnTreeGroup(
  expected: MojoProcessIdentity,
  signal: NodeJS.Signals,
  opts: { procRoot?: string; platform?: string; kill?: (target: number, sig: NodeJS.Signals) => void } = {},
): TreeGroupSignalOutcome {
  const read = readProcessIdentity(expected.pid, opts);
  if (!read.ok) {
    if (read.failure.kind === 'unsupported-platform') {
      return { kind: 'unsupported-platform', platform: read.failure.platform };
    }
    // A vanished root is the expected happy path late in teardown.
    if (read.failure.kind === 'proc-entry-unreadable' && /ENOENT|no such file/i.test(read.reason)) {
      return { kind: 'gone' };
    }
    return { kind: 'unverifiable', reason: read.reason };
  }
  if (!sameProcessIdentity(expected, read.identity)) {
    return { kind: 'identity-mismatch', expected, actual: read.identity };
  }

  const kill = opts.kill ?? ((target, sig) => { process.kill(target, sig); });
  try {
    kill(-expected.pid, signal);
  } catch {
    // Raced us between the identity read and the signal: the group is gone.
    return { kind: 'gone' };
  }
  return { kind: 'signalled' };
}
