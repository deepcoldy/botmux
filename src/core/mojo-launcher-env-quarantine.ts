/**
 * Durable quarantine of dangerous mojo launcher-env KEY NAMES.
 *
 * Why this has to be on disk, and why it outlives the session row
 * ---------------------------------------------------------------
 * The device-isolation proof must answer "can a hooked mojo client still be
 * running on this host?". Everything that could answer it in memory has been
 * shown to be insufficient:
 *
 *   - `initConfig.env` is a spawn-time snapshot; a live `/restart` hands the
 *     child a different env without updating it.
 *   - the live bot config can be edited back to clean while the child keeps
 *     running the old env.
 *   - a per-generation in-memory ledger dies with the daemon process, and a
 *     `SIGTERM`-ed mojo child (plus any detached descendants) can outlive it.
 *   - the session ROW disappears on an explicit `/close`, while that same
 *     unproven child may still hold an activated credential.
 *
 * So the record is host-scoped and persisted: it survives a daemon restart and
 * survives session deletion. It is keyed by session id purely to bound the blast
 * radius — an unrelated clean session must not be penalised.
 *
 * Only KEY NAMES are stored, never values. `mojoUnprovableEnvKeys` inspects
 * names only, and these keys routinely carry credentials (`X_JWT_TOKEN` is the
 * one allowlisted name and is therefore never recorded here).
 *
 * Failure policy: every operation fails LOUD, never silently "empty"
 * ------------------------------------------------------------------
 * This is a security ledger, so the usual "best-effort store" conventions are
 * inverted:
 *   - a corrupt/unreadable file THROWS instead of degrading to "nothing is
 *     quarantined" (that is the fail-open direction, and it was the first
 *     version's bug — a truncated file silently unblocked every session).
 *   - a failed write PROPAGATES to the caller rather than being logged and
 *     swallowed, so the daemon cannot believe it recorded a risk it did not.
 *   - every mutation runs a FRESH read-modify-write inside a cross-process file
 *     lock. Reusing a cached snapshot loses updates when several per-bot daemons
 *     share one data dir, and a lost update here means a forgotten hook.
 *
 * Clearing
 * --------
 * There is deliberately NO clearing API. Removing an entry would assert that the
 * injected process is gone, and nothing available here proves that:
 * `MojoBackend.kill()` sends a bare `SIGTERM` with no escalation and no wait, the
 * worker exits without awaiting its child, and the child may leave detached
 * descendants — so neither a worker exit nor a per-PID check covers the tree. A
 * sound clear needs trustworthy termination of the whole mojo PROCESS GROUP
 * (escalate to SIGKILL, then confirm group quiescence); that machinery does not
 * exist yet, and until it does, retention is the fail-closed side.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { config } from '../config.js';
import { withFileLockSync } from '../utils/file-lock.js';

const FILE_NAME = 'mojo-launcher-env-quarantine.json';

interface QuarantineFile {
  version: 1;
  /** sessionId -> unprovable launcher-env key NAMES ever handed to that session. */
  sessions: Record<string, string[]>;
}

/** Thrown instead of degrading to an empty (fail-open) ledger. */
export class MojoQuarantineUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'MojoQuarantineUnavailableError';
  }
}

function filePath(dataDir?: string): string {
  return join(dataDir ?? config.session.dataDir, FILE_NAME);
}

/**
 * Read the ledger from disk. No caching, by design: a cached snapshot would both
 * hide another daemon's writes and let a lost update drop a recorded risk.
 *
 * A missing file is a legitimate empty ledger; anything unparseable is not.
 */
function readStrict(dataDir?: string): QuarantineFile {
  const path = filePath(dataDir);
  if (!existsSync(path)) return { version: 1, sessions: {} };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new MojoQuarantineUnavailableError(
      `cannot read mojo launcher-env quarantine at ${path}; refusing to treat sessions as unquarantined`,
      err,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MojoQuarantineUnavailableError(
      `mojo launcher-env quarantine at ${path} is corrupt; refusing to treat sessions as unquarantined`,
      err,
    );
  }
  const sessionsRaw = (parsed as { sessions?: unknown } | null)?.sessions;
  if (!parsed || typeof parsed !== 'object' || !sessionsRaw || typeof sessionsRaw !== 'object') {
    throw new MojoQuarantineUnavailableError(
      `mojo launcher-env quarantine at ${path} has an unexpected shape; refusing to treat sessions as unquarantined`,
    );
  }
  const sessions: Record<string, string[]> = {};
  for (const [sessionId, keys] of Object.entries(sessionsRaw as Record<string, unknown>)) {
    if (!Array.isArray(keys)) {
      throw new MojoQuarantineUnavailableError(
        `mojo launcher-env quarantine at ${path} has a non-array entry for ${sessionId}`,
      );
    }
    const names = keys.filter((k): k is string => typeof k === 'string' && k.length > 0);
    if (names.length > 0) sessions[sessionId] = [...new Set(names)];
  }
  return { version: 1, sessions };
}

/** Atomic replace via a UNIQUE temp file — a shared `.tmp` name races between daemons. */
function writeStrict(data: QuarantineFile, dataDir?: string): void {
  const path = filePath(dataDir);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw new MojoQuarantineUnavailableError(
      `cannot persist mojo launcher-env quarantine at ${path}; the recorded risk would be lost`,
      err,
    );
  }
}

/**
 * Fold unprovable launcher-env key names into this session's durable record.
 *
 * Monotonic union — callers pass whatever the session was handed, and a later
 * clean payload never retracts an earlier dangerous one.
 *
 * THROWS on any read/write failure: the caller must not proceed believing the
 * risk was recorded.
 */
export function recordQuarantinedLauncherEnvKeys(
  sessionId: string,
  keys: readonly string[],
  dataDir?: string,
): void {
  if (keys.length === 0) return;
  const path = filePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  withFileLockSync(path, () => {
    // Fresh read INSIDE the lock: another daemon may have added entries since.
    const data = readStrict(dataDir);
    const before = data.sessions[sessionId] ?? [];
    const merged = [...new Set([...before, ...keys])];
    if (merged.length === before.length) return;   // nothing new
    data.sessions[sessionId] = merged;
    writeStrict(data, dataDir);
  });
}

/**
 * Durable key names for one session (empty only when nothing was ever recorded).
 *
 * THROWS when the ledger cannot be read — callers on the isolation path must
 * fail closed rather than interpret the error as "clean".
 */
export function quarantinedLauncherEnvKeys(sessionId: string, dataDir?: string): string[] {
  return readStrict(dataDir).sessions[sessionId] ?? [];
}

/**
 * Session ids with a durable record, INCLUDING sessions whose row is gone.
 *
 * The closed/residual path needs this: an explicit `/close` deletes the row, so
 * the inventory would otherwise lose every trace of an unproven hooked child.
 */
export function quarantinedSessionIds(dataDir?: string): string[] {
  return Object.keys(readStrict(dataDir).sessions);
}
