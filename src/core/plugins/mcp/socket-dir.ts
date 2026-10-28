/**
 * Where a session's MCP Gateway socket directory lives, and when it goes away.
 * Kept free of the Gateway server itself so the daemon can name and remove
 * these directories without loading the MCP SDK.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { clearMcpGatewayLaunchRecord, readMcpGatewayLaunchRecord } from './launch-record.js';

/** Root for every Gateway socket directory.
 *
 * spawnCli repoints the worker's own TMPDIR at the per-session scratch tree
 * (~/.cache/botmux/session-tmp/<profile>/<sessionId>, #1592) before the host
 * binds. Following tmpdir() after that would place g.sock ~125 bytes deep on
 * macOS and listen() fails with EINVAL, so the worker pins the inherited root
 * first. Unpinned callers keep the plain tmpdir() behaviour. */
let pinnedGatewaySocketRoot: string | undefined;

export function pinSessionMcpGatewaySocketRoot(root: string): void {
  pinnedGatewaySocketRoot ??= root;
}

export function sessionMcpGatewaySocketRoot(): string {
  return pinnedGatewaySocketRoot ?? tmpdir();
}

/** Deterministic per-session Gateway socket directory.
 *
 * The name is a pure function of (dataDir, sessionId) — NO random component —
 * so a replacement worker (daemon restart / upgrade) re-serves the socket at
 * the exact path a surviving persistent pane's relay already holds in its
 * environment, and the relay can simply reconnect instead of the worker having
 * to kill the pane and cold-resume the CLI.
 *
 * Stays under sessionMcpGatewaySocketRoot() (not dataDir, and not the session
 * scratch TMPDIR) to keep the Unix socket below macOS's short sun_path limit,
 * and keeps the `bmcp-<uid>-` prefix so the existing Seatbelt
 * deny regex (sessionMcpGatewayPathRegex) covers it unchanged. The predictable
 * name is safe because ensurePrivateGatewayDir fails closed unless the
 * directory is a real 0700 directory owned by this uid — a squatter can only
 * DoS session startup, never observe traffic (connections still require the
 * rotating auth token). */
export function sessionMcpGatewaySocketDir(sessionId: string, dataDir: string): string {
  return join(sessionMcpGatewaySocketRoot(), gatewayDirName(sessionId, dataDir, process.getuid?.() ?? 0));
}

/** Deterministic per-session Gateway socket path (see sessionMcpGatewaySocketDir). */
export function sessionMcpGatewaySocketPath(sessionId: string, dataDir: string): string {
  return join(sessionMcpGatewaySocketDir(sessionId, dataDir), 'g.sock');
}

function gatewayDirName(sessionId: string, dataDir: string, uid: number): string {
  const sessionKey = createHash('sha256')
    .update(dataDir)
    .update('\0')
    .update(sessionId)
    .digest('hex')
    .slice(0, 16);
  return `bmcp-${uid}-${sessionKey}`;
}

function isOwnRealDir(path: string, uid: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid;
  } catch { return false; }
}

/**
 * Remove a durably closed session's Gateway directory (socket, auth token) and
 * its launch record (#1937). Only for the logical close, after the worker has
 * exited: a worker generation ending on its own must keep the directory, see
 * the host's close(). The launch record goes too, so if a pane somehow
 * survived the close, resume cold-starts it instead of reattaching a relay to
 * a directory that no longer exists. The recorded path is honoured only when
 * its name is this session's own deterministic name.
 */
export function removeSessionMcpGatewayDir(sessionId: string, dataDir: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const name = gatewayDirName(sessionId, dataDir, uid);
  const dirs = new Set([join(sessionMcpGatewaySocketRoot(), name)]);
  const recorded = readMcpGatewayLaunchRecord(dataDir, sessionId)?.socketPath;
  if (recorded && basename(dirname(recorded)) === name) dirs.add(dirname(recorded));
  for (const dir of dirs) {
    if (isOwnRealDir(dir, uid)) rmSync(dir, { recursive: true, force: true });
  }
  clearMcpGatewayLaunchRecord(dataDir, sessionId);
}

/** Whether something accepts connections on the Unix socket at `path`. */
export function unixSocketAccepting(path: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    const done = (accepting: boolean) => { socket.destroy(); resolve(accepting); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface GatewayDirSweepOptions {
  /** Defaults to sessionMcpGatewaySocketRoot(). */
  root?: string;
  now?: number;
  graceMs?: number;
  /** Which of `needles` (directory names) a live process references; `null`
   *  = cannot tell, and then nothing is removed this round. */
  liveReferences: (needles: readonly string[]) => Promise<ReadonlySet<string> | null>;
  socketAccepting?: (socketPath: string) => Promise<boolean>;
}

const GATEWAY_DIR_SWEEP_GRACE_MS = 60_000;

/**
 * Reclaim Gateway directories nobody serves or uses any more (#1937): a
 * crashed worker, a close that bypassed the worker pool, or a build that
 * predates removeSessionMcpGatewayDir left them behind.
 *
 * Every `bmcp-<uid>-*` directory under the socket root qualifies, whichever
 * data dir it was named for, unless: it belongs to an active session of this
 * data dir; it is younger than the grace window; its socket accepts
 * connections (a live host); or a live process references it — a bwrap
 * sandbox binds the directory BY INODE and a relay carries the socket path, so
 * a surviving persistent pane keeps its directory. Anything else holds only a
 * stale socket file and a token nobody can use; the next host recreates it.
 */
export async function sweepOrphanSessionMcpGatewayDirs(
  dataDir: string,
  protectedSessionIds: ReadonlySet<string>,
  opts: GatewayDirSweepOptions,
): Promise<string[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const root = opts.root ?? sessionMcpGatewaySocketRoot();
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? GATEWAY_DIR_SWEEP_GRACE_MS;
  const accepting = opts.socketAccepting ?? unixSocketAccepting;
  const pattern = new RegExp(`^bmcp-${uid}-[0-9a-f]{16}$`);
  const keep = new Set([...protectedSessionIds].map(id => gatewayDirName(id, dataDir, uid)));
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const candidates: string[] = [];
  for (const name of names) {
    if (!pattern.test(name) || keep.has(name)) continue;
    const dir = join(root, name);
    if (!isOwnRealDir(dir, uid)) continue;
    try { if (now - lstatSync(dir).mtimeMs <= graceMs) continue; } catch { continue; }
    const socketPath = join(dir, 'g.sock');
    if (existsSync(socketPath) && await accepting(socketPath)) continue;
    candidates.push(name);
  }
  if (candidates.length === 0) return [];
  const live = await opts.liveReferences(candidates);
  if (!live) return [];
  const removed: string[] = [];
  for (const name of candidates) {
    if (live.has(name)) continue;
    const dir = join(root, name);
    const socketPath = join(dir, 'g.sock');
    try {
      // A host may have bound this directory since the batch probe (a resume
      // reusing the deterministic path). Re-prove this one directory, then
      // remove it with no await in between.
      if (existsSync(socketPath) && await accepting(socketPath)) continue;
      if (now - lstatSync(dir).mtimeMs <= graceMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch { /* best-effort: the next round retries */ }
  }
  return removed;
}
