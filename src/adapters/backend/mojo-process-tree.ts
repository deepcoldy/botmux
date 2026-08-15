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
 * Trust domain (read before relying on this)
 * ------------------------------------------
 * This is DETECTION, not an unforgeable boundary. A hijacked child runs as the
 * same user, so a descendant that both setsids AND overwrites its own environ
 * area can still evade enumeration. That residual risk is why the caller must
 * treat "cannot prove empty" as failure and keep the session's device-isolation
 * blocker in place, instead of treating a clean scan as positive proof of safety.
 * Kernel-level containment (cgroup/pid namespace) is the only way to close it
 * fully, and this host does not provide one per session.
 */
import { readFileSync, readdirSync } from 'node:fs';

export interface MojoTreeMember {
  pid: number;
  ppid: number;
  pgid: number;
  /** Which signal matched, for operator-facing logs. */
  via: 'pgid' | 'env' | 'ppid';
}

export type MojoTreeScan =
  | { ok: true; members: MojoTreeMember[] }
  | { ok: false; reason: string };

interface RawProc { pid: number; ppid: number; pgid: number; hasNonce: boolean }

/** Injected into every turn child; inherited by the whole subtree. */
export const MOJO_TREE_NONCE_ENV = 'BOTMUX_MOJO_TREE_NONCE';

/**
 * `/proc/<pid>/stat`: fields 4 and 5 are ppid and pgid, but field 2 (comm) is
 * parenthesised and may itself contain spaces or ')', so it must be cut at the
 * LAST ')' rather than split naively.
 */
function parseStat(text: string): { ppid: number; pgid: number } | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const rest = text.slice(close + 1).trim().split(/\s+/);
  // rest[0] is state, so ppid/pgid are the next two.
  const ppid = Number(rest[1]);
  const pgid = Number(rest[2]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return null;
  return { ppid, pgid };
}

function readProcTable(procRoot: string, nonce: string): RawProc[] | { error: string } {
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch (err) {
    // No /proc (or unreadable) means the tree cannot be enumerated at all. The
    // caller must NOT read that as "nothing is running".
    return { error: `cannot read ${procRoot}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const out: RawProc[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let ppid: number;
    let pgid: number;
    try {
      const parsed = parseStat(readFileSync(`${procRoot}/${name}/stat`, 'utf-8'));
      if (!parsed) continue;
      ppid = parsed.ppid;
      pgid = parsed.pgid;
    } catch {
      // Exited between readdir and read: a vanished process is genuinely not a
      // member, so skipping it is correct (and is not a scan failure).
      continue;
    }
    let hasNonce = false;
    try {
      // Zero-separated. An unreadable environ (permission, or a kernel thread)
      // just means this signal cannot speak for that pid; PGID/PPID still can.
      hasNonce = readFileSync(`${procRoot}/${name}/environ`, 'utf-8').includes(nonce);
    } catch { /* keep false */ }
    out.push({ pid, ppid, pgid, hasNonce });
  }
  return out;
}

/**
 * Every live process still belonging to the turn rooted at `rootPid`.
 *
 * `excludePids` MUST contain the current process (and anything else that must
 * never be signalled): the daemon shares neither the nonce nor the group, but an
 * explicit guard is cheaper than trusting that invariant while sending SIGKILL.
 */
export function scanMojoTree(
  rootPid: number,
  nonce: string,
  opts: { procRoot?: string; excludePids?: readonly number[] } = {},
): MojoTreeScan {
  const procRoot = opts.procRoot ?? '/proc';
  const table = readProcTable(procRoot, nonce);
  if (!Array.isArray(table)) return { ok: false, reason: table.error };

  const excluded = new Set(opts.excludePids ?? []);
  const members = new Map<number, MojoTreeMember>();

  const claim = (p: RawProc, via: MojoTreeMember['via']): void => {
    if (excluded.has(p.pid) || members.has(p.pid)) return;
    members.set(p.pid, { pid: p.pid, ppid: p.ppid, pgid: p.pgid, via });
  };

  for (const p of table) {
    if (p.pid === rootPid || p.pgid === rootPid) claim(p, 'pgid');
    else if (p.hasNonce) claim(p, 'env');
  }
  // Transitive closure over parentage, so an env-scrubbed child of a known member
  // is still claimed. Bounded by the table size, so it cannot loop on a cycle.
  for (let changed = true; changed;) {
    changed = false;
    for (const p of table) {
      if (members.has(p.pid) || excluded.has(p.pid)) continue;
      if (!members.has(p.ppid)) continue;
      // Never walk up into init/the daemon: only DOWN from a known member.
      claim(p, 'ppid');
      changed = true;
    }
  }
  return { ok: true, members: [...members.values()] };
}
