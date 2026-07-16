/**
 * Zellij socket probe — attribute a (possibly renamed) zellij session socket
 * FILE to the server PID that owns it. Runs as a standalone child script
 * (`node zellij-socket-probe.js <socketPath> <candidatePid>...`) so the
 * parent's sync findServerPid can spawnSync it.
 *
 * Why this exists: `zellij action rename-session` (what the session-manager
 * plugin drives) renames the session's socket FILE, but both the server's
 * argv AND the kernel's bound-address string (/proc/net/unix Path column)
 * keep the spawn-time path forever (verified live on 0.44.1). Session names
 * are also REUSABLE after a rename frees them, so two servers can share the
 * same spawn-time path — any lookup keyed on names/paths (argv tail, bound
 * path) can bind the WRONG server (Codex review findings #1/#2 on PR #468).
 * The only sound mapping is per-connection causality, established here.
 *
 * Attribution protocol (all snapshots are of candidate servers' /proc/<pid>/fd
 * socket inodes, filtered to inodes whose /proc/net/unix row is bound under
 * the socket dir — i.e. accepted zellij-session sockets, not random fds):
 *   1. snapshot BEFORE, then open CONNECTIONS (2 of them) to the socket file
 *      and HOLD both;
 *   2. after 300ms, snapshot DURING — the owner has accept()ed our
 *      connections by now, gaining CONNECTIONS inodes; then close our ends;
 *   3. after 150ms, snapshot FINAL — the owner's accepted sockets disappear.
 * A pid owns the file iff it gained AT LEAST `CONNECTIONS` dir-bound inodes
 * during the hold that all vanished after our close. Why ≥2 and not ≥1
 * (Codex delta finding on d12cb049): with a single connection, a stray SHORT
 * client hitting a sibling inside the window is observationally identical to
 * our own accept — if the target's accept is also slow (invisible in DURING),
 * the sibling becomes the sole "owner" and a single-connection probe
 * misattributes instead of failing closed. Requiring the full connection
 * COUNT means one stray sibling connection can never qualify; mimicry now
 * needs ≥2 shorts to the same sibling inside one window. ≥ (not ==) keeps
 * the target attributable when extra短 clients (e.g. concurrent discovery's
 * own `zellij action` calls) also hit it during the window. A long-lived
 * sibling client never qualifies (doesn't vanish). Multiple qualifiers →
 * exit 3, fail-closed.
 *
 * The residual coincidence (≥2 shorts to one sibling in-window while the
 * target stays slow) is squashed by the PARENT: a successful attribution is
 * only trusted after an independent second probe agrees on the same pid
 * (see findServerPid) — the pattern would have to repeat across two
 * disjoint windows.
 *
 * Output: the owner PID on stdout, exit 0. Non-zero on any failure (connect
 * refused / no owner attributable / ambiguous) — callers treat all of these
 * as "not found" (宁缺勿错). Linux-only (/proc).
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Kernel socket inodes bound under `dir` per /proc/net/unix content. Pure. */
export function unixInodesUnderDir(procNetUnix: string, dir: string): Set<string> {
  const inodes = new Set<string>();
  for (const line of procNetUnix.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 8 && cols[7]!.startsWith(`${dir}/`)) inodes.add(cols[6]!);
  }
  return inodes;
}

/** Socket inodes among fd link targets (`socket:[123]` → "123"). Pure. */
export function socketInodesFromFdLinks(links: string[]): Set<string> {
  const inodes = new Set<string>();
  for (const l of links) {
    const m = l.match(/^socket:\[(\d+)\]$/);
    if (m) inodes.add(m[1]!);
  }
  return inodes;
}

/** How many simultaneous connections one probe run opens (and therefore the
 *  minimum appear∧vanish inode count a candidate must show to qualify). */
export const PROBE_CONNECTIONS = 2;

/**
 * The pids whose fd table gained AT LEAST `minCount` dir-bound socket inodes
 * between `before` and `during` that are gone again in `final` — i.e. the
 * accept()/close() lifecycle of OUR probe connections. Pure (testable): the
 * causal core. `minCount` must equal the number of connections the probe
 * opened: a single stray short-lived sibling connection then can never
 * qualify on its own (the Codex combo finding — target accept slow + one
 * sibling short in-window — yields zero candidates, fail-closed).
 */
export function attributeOwners(
  pids: number[],
  before: Map<number, Set<string>>,
  during: Map<number, Set<string>>,
  final: Map<number, Set<string>>,
  dirBoundInodes: Set<string>,
  minCount: number,
): number[] {
  return pids.filter(pid => {
    const b = before.get(pid) ?? new Set();
    const d = during.get(pid) ?? new Set();
    const f = final.get(pid) ?? new Set();
    const gainedThenVanished = [...d].filter(ino => !b.has(ino) && dirBoundInodes.has(ino) && !f.has(ino));
    return gainedThenVanished.length >= minCount;
  });
}

function snapFds(pid: number): Set<string> {
  const links: string[] = [];
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try { links.push(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { /* fd raced away */ }
    }
  } catch { /* process gone or fd table not readable */ }
  return socketInodesFromFdLinks(links);
}

function main(socketPath: string, pids: number[]): void {
  const dir = dirname(socketPath);
  const snapAll = () => new Map(pids.map(p => [p, snapFds(p)]));
  const before = snapAll();
  const clients = Array.from({ length: PROBE_CONNECTIONS }, () => connect(socketPath));
  const destroyAll = () => { for (const c of clients) c.destroy(); };
  let connected = 0;
  for (const c of clients) {
    c.on('error', () => { destroyAll(); process.exit(1); });
    c.on('connect', () => {
      connected++;
      if (connected < clients.length) return;
      // All connections up — give the server a beat to accept() every one.
      setTimeout(() => {
        const during = snapAll();
        const bound = unixInodesUnderDir(readFileSync('/proc/net/unix', 'utf-8'), dir);
        destroyAll();
        setTimeout(() => {
          const owners = attributeOwners(pids, before, during, snapAll(), bound, PROBE_CONNECTIONS);
          if (owners.length === 1) {
            process.stdout.write(String(owners[0]));
            process.exit(0);
          }
          process.exit(3); // 0 = accepts not (all) observed; >1 = concurrent-client race
        }, 150);
      }, 300);
    });
  }
  setTimeout(() => { destroyAll(); process.exit(2); }, 5000).unref();
}

// Only run when executed directly (the pure helpers are also imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sock = process.argv[2];
  const pids = process.argv.slice(3).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!sock || pids.length === 0) process.exit(64);
  main(sock, pids);
}
