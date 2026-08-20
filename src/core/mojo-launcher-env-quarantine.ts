/**
 * AUDIT RECORD of dangerous mojo launcher-env KEY NAMES. NOT a security boundary.
 *
 * Trust domain — read this before relying on anything here
 * -------------------------------------------------------
 * This is an ordinary file owned by the same user as the daemon, while the threat
 * it describes is a mojo child hijacked via `PATH` / `LD_PRELOAD` — running as
 * THAT SAME USER. Such a child can simply delete this file. So it cannot be, and
 * is not, the authority for device isolation: an earlier design let a missing file
 * flip `resolveRemoteExecutionProven` from false to true, a credential-boundary
 * fail-open reachable by the very process being policed.
 *
 * The authority lives on evidence the CLI cannot forge or delete:
 *   - the private parent<->worker attestation IPC (`local_process_attestation`)
 *   - live bot config, read at classification time
 *   - the daemon's in-memory per-generation ledger, untouchable by any child
 *     within a daemon lifetime
 * and the rule is POSITIVE proof: a mojo session is `safe_remote` only while all
 * of that is present, otherwise it is blocked (see mojoRemoteExecutionAttested).
 *
 * What this file is still good for
 *   - operator-facing audit: WHICH keys a session was handed, across restarts
 *   - defence in depth: it may only ever ADD a blocker. Its absence must never
 *     unblock anything — which is precisely why safety no longer depends on it.
 *
 * Integrity rules (an honest audit record still has to be honest)
 *   - only KEY NAMES are stored, never values (they routinely carry credentials;
 *     `X_JWT_TOKEN` is the one allowlisted name and is never recorded)
 *   - unreadable / malformed / unknown-version content THROWS rather than reading
 *     as "nothing recorded" — including EACCES, which must not be mistaken for
 *     "file absent"
 *   - every mutation is a FRESH read-modify-write inside a cross-process file
 *     lock, so per-bot daemons sharing a data dir cannot lose updates
 *   - there is deliberately NO clearing API: removal would assert the injected
 *     process is gone, and proving that needs trustworthy termination of the whole
 *     mojo PROCESS GROUP (SIGKILL escalation + group quiescence), which does not
 *     exist yet
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
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // ONLY a genuinely absent file is an empty record. `existsSync` also returns
    // false for EACCES, so gating on it turned "cannot read this" into "nothing is
    // quarantined" — the fail-open direction, and trivially arranged by a
    // same-user process chmod-ing the file.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, sessions: {} };
    }
    throw new MojoQuarantineUnavailableError(
      `cannot read mojo launcher-env quarantine at ${path} `
      + `(${(err as NodeJS.ErrnoException).code ?? 'unknown'}); `
      + 'refusing to treat sessions as unquarantined',
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
  // An unknown version means a writer this build does not understand; applying
  // today's rules could silently drop entries it does not recognise.
  const version = (parsed as { version?: unknown } | null)?.version;
  if (version !== 1) {
    throw new MojoQuarantineUnavailableError(
      `mojo launcher-env quarantine at ${path} has unsupported version ${JSON.stringify(version)}`,
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
    // Filtering these out silently EMPTIED that session's quarantine, so one junk
    // element (`{"sid":[42]}`) unblocked it. Reject the whole file instead.
    for (const k of keys) {
      if (typeof k !== 'string' || k.length === 0) {
        throw new MojoQuarantineUnavailableError(
          `mojo launcher-env quarantine at ${path} has a non-string key name for ${sessionId}`,
        );
      }
    }
    sessions[sessionId] = [...new Set(keys as string[])];
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
