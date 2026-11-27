/**
 * Worker-local transport for the Claude-family SessionStart ready signal.
 *
 * WHY: the SessionStart hook (`botmux session-ready`) normally reaches its
 * worker through the owning daemon (`/api/session-ready` → `session_ready`
 * IPC). A v3 workflow worker is forked by the ephemeral pool and has no daemon
 * session record, so the daemon answers 200 and drops the signal: every Claude
 * workflow node waited out the ready gate's 45s fallback with its composer
 * already on screen.
 *
 * This channel carries the SAME signal straight to the worker that spawned the
 * CLI. It is only a transport: the worker feeds an accepted signal into its
 * existing SessionStart handler, so the post-hook prompt fence and the
 * fallback timer keep their semantics.
 *
 * Shape: per CLI spawn the worker creates a private 0700 directory and a random
 * nonce, and hands both to the CLI child through reserved `BOTMUX_*` env (per-
 * bot env cannot set reserved keys). The hook writes `{v, nonce, id, source}`
 * with an exclusive temp file + rename; the worker claims the file by renaming
 * it away, reads it without following symlinks, and accepts it only when the
 * nonce matches its current spawn. A stale spawn's hook writes into a directory
 * that was already removed (or carries a nonce the new spawn rejects).
 *
 * Ordering: Claude draws its real prompt only after its SessionStart hooks
 * exit, and the worker's post-hook fence needs that prompt to come AFTER the
 * signal. The daemon route guarantees this by making the hook wait for the
 * worker's ack (2s, fail-open); this channel does the same. After its handler
 * has run, the worker writes an ack naming the spawn nonce and the signal id;
 * the hook accepts only that exact ack, so an old or malformed ack never
 * releases it early.
 *
 * The nonce is not logged anywhere.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, mkdtempSync,
  openSync, readSync, renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

export const SESSION_READY_SIGNAL_FILE_ENV = 'BOTMUX_SESSION_READY_SIGNAL_FILE';
export const SESSION_READY_SIGNAL_NONCE_ENV = 'BOTMUX_SESSION_READY_SIGNAL_NONCE';

const SIGNAL_BASENAME = 'session-ready.json';
const ACK_BASENAME = 'session-ready.ack';
const RECORD_VERSION = 1;
const NONCE_RE = /^[0-9a-f]{64}$/;
const SIGNAL_ID_RE = /^[0-9a-f]{32}$/;
/** SessionStart sources Claude reports today; anything else is carried as unknown. */
const SOURCE_RE = /^[a-z][a-z_-]{0,31}$/;
/** A valid record is ~170 bytes; anything far larger is not ours. */
const MAX_RECORD_BYTES = 1024;

export interface LocalSessionReadyChannel {
  readonly filePath: string;
  /** Compared in constant time; never logged. */
  readonly nonce: string;
  /** Env the worker injects into the CLI child (after configurable env). */
  env(): Record<string, string>;
  /** Remove the private directory with any unconsumed signal/ack. Idempotent. */
  dispose(): void;
}

/** Create the per-spawn channel under `rootDir` (the worker's own tmp). */
export function createLocalSessionReadyChannel(rootDir: string): LocalSessionReadyChannel {
  // mkdtemp creates the directory 0700 owned by this user.
  const dir = mkdtempSync(join(rootDir, 'botmux-ready-'));
  const filePath = join(dir, SIGNAL_BASENAME);
  const nonce = randomBytes(32).toString('hex');
  let disposed = false;
  return {
    filePath,
    nonce,
    env: () => ({ [SESSION_READY_SIGNAL_FILE_ENV]: filePath, [SESSION_READY_SIGNAL_NONCE_ENV]: nonce }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** The channel directory must be a real directory owned by us and closed to others. */
function privateDirectory(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return false; // also rejects a symlinked directory
    const uid = currentUid();
    if (uid !== undefined && st.uid !== uid) return false;
    return (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Exclusive temp file + rename: never writes through a planted entry, and
 *  rename replaces a symlink at the target instead of following it. */
function atomicWrite(dir: string, name: string, body: string): boolean {
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    writeSync(fd, body);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, join(dir, name));
    return true;
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* */ } }
    try { unlinkSync(tmp); } catch { /* */ }
    return false;
  }
}

type RecordRead =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; reason: 'not-regular-file' | 'foreign-owner' | 'too-large' | 'malformed' | 'unreadable' };

/** Read a small JSON object without following symlinks. */
function readRecord(path: string): RecordRead {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code === 'ELOOP' ? 'not-regular-file' : 'unreadable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not-regular-file' };
    const uid = currentUid();
    if (uid !== undefined && st.uid !== uid) return { ok: false, reason: 'foreign-owner' };
    if (st.size > MAX_RECORD_BYTES) return { ok: false, reason: 'too-large' };
    const buf = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_RECORD_BYTES) return { ok: false, reason: 'too-large' };
    let parsed: unknown;
    try { parsed = JSON.parse(buf.subarray(0, n).toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed' };
    return { ok: true, record: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    try { closeSync(fd); } catch { /* best-effort local transport */ }
  }
}

/**
 * Hook side. Returns the id of the signal written, or null when the env does
 * not describe a usable channel or the write fails; the caller then falls back
 * to the daemon route.
 */
export function writeLocalSessionReadySignal(env: NodeJS.ProcessEnv, source: string | undefined): string | null {
  const filePath = env[SESSION_READY_SIGNAL_FILE_ENV];
  const nonce = env[SESSION_READY_SIGNAL_NONCE_ENV];
  if (!filePath || !nonce || !NONCE_RE.test(nonce)) return null;
  if (!isAbsolute(filePath) || basename(filePath) !== SIGNAL_BASENAME) return null;
  const dir = dirname(filePath);
  if (!privateDirectory(dir)) return null;
  const id = randomBytes(16).toString('hex');
  const body = JSON.stringify({
    v: RECORD_VERSION,
    nonce,
    id,
    ...(source && SOURCE_RE.test(source) ? { source } : {}),
  });
  return atomicWrite(dir, SIGNAL_BASENAME, body) ? id : null;
}

export type LocalSessionReadyRead =
  | { kind: 'none' }
  | { kind: 'signal'; id: string; source?: string }
  | { kind: 'invalid'; reason: 'not-regular-file' | 'foreign-owner' | 'too-large' | 'malformed' | 'nonce-mismatch' | 'unreadable' };

let claimSeq = 0;

/**
 * Claim the latest signal by rename before validating it. Writes between
 * polls coalesce; a claimed record cannot be delivered by a later poll.
 */
export function consumeLocalSessionReadySignal(channel: Pick<LocalSessionReadyChannel, 'filePath' | 'nonce'>): LocalSessionReadyRead {
  const claimed = join(dirname(channel.filePath), `.claimed.${process.pid}.${++claimSeq}`);
  try {
    renameSync(channel.filePath, claimed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'invalid', reason: 'unreadable' };
  }
  try {
    const read = readRecord(claimed);
    if (!read.ok) return { kind: 'invalid', reason: read.reason };
    const { v, nonce, id, source } = read.record;
    if (v !== RECORD_VERSION || typeof nonce !== 'string' || !NONCE_RE.test(nonce)
      || typeof id !== 'string' || !SIGNAL_ID_RE.test(id)) {
      return { kind: 'invalid', reason: 'malformed' };
    }
    if (!sameSecret(channel.nonce, nonce)) return { kind: 'invalid', reason: 'nonce-mismatch' };
    return typeof source === 'string' && SOURCE_RE.test(source)
      ? { kind: 'signal', id, source }
      : { kind: 'signal', id };
  } finally {
    try { rmSync(claimed, { recursive: true, force: true }); } catch { /* */ }
  }
}

/** Worker side: the handler for signal `id` has run. Best-effort. */
export function acknowledgeLocalSessionReadySignal(
  channel: Pick<LocalSessionReadyChannel, 'filePath' | 'nonce'>,
  id: string,
): boolean {
  return atomicWrite(dirname(channel.filePath), ACK_BASENAME, JSON.stringify({ v: RECORD_VERSION, nonce: channel.nonce, id }));
}

/**
 * Hook side: wait until the worker acknowledged signal `id`, or `timeoutMs`
 * passes (the daemon route uses the same 2s bound, then lets the hook exit).
 * Only an ack naming this spawn's nonce and this signal's id counts; anything
 * else at the ack path is ignored. Never throws.
 */
export async function waitForLocalSessionReadyAck(
  env: NodeJS.ProcessEnv,
  id: string,
  timeoutMs: number,
  opts: { pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const filePath = env[SESSION_READY_SIGNAL_FILE_ENV];
  const nonce = env[SESSION_READY_SIGNAL_NONCE_ENV];
  if (!filePath || !nonce) return false;
  const ack = join(dirname(filePath), ACK_BASENAME);
  const pollMs = opts.pollMs ?? 20;
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const read = readRecord(ack);
    if (read.ok) {
      const r = read.record;
      if (r.v === RECORD_VERSION && typeof r.nonce === 'string' && sameSecret(nonce, r.nonce) && r.id === id) {
        try { unlinkSync(ack); } catch { /* */ }
        return true;
      }
    }
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}

export interface LocalSessionReadyWatcherTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: LocalSessionReadyWatcherTimers = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * Poll the channel (fs.watch is not relied on: workflow workers have hit
 * EMFILE on it). Stops by itself once `isCurrent()` turns false, so a signal
 * is never delivered to, nor acknowledged on behalf of, a newer spawn.
 */
export function startLocalSessionReadyWatcher(opts: {
  channel: Pick<LocalSessionReadyChannel, 'filePath' | 'nonce'>;
  intervalMs: number;
  isCurrent: () => boolean;
  onSignal: (source: string | undefined) => void;
  onInvalid: (reason: string) => void;
  timers?: LocalSessionReadyWatcherTimers;
}): { stop(): void; poll(): void } {
  const timers = opts.timers ?? defaultTimers;
  let stopped = false;
  let handle: unknown;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (handle !== undefined) timers.clearInterval(handle);
  };
  const poll = (): void => {
    if (stopped) return;
    if (!opts.isCurrent()) { stop(); return; }
    const read = consumeLocalSessionReadySignal(opts.channel);
    if (read.kind === 'invalid') { opts.onInvalid(read.reason); return; }
    if (read.kind !== 'signal') return;
    // Boundary first (the same handler as the daemon route), then release the
    // waiting hook — and only while this spawn is still the current one.
    try {
      opts.onSignal(read.source);
    } catch {
      // The boundary was not established: no ack, the hook times out (fail-open).
      opts.onInvalid('handler-error');
      return;
    }
    if (!stopped && opts.isCurrent()) acknowledgeLocalSessionReadySignal(opts.channel, read.id);
  };
  handle = timers.setInterval(poll, opts.intervalMs);
  // A signal written before the watcher started is picked up right away.
  poll();
  return { stop, poll };
}
