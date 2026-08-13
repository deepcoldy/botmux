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
 * survives session deletion. It is keyed by session id purely to bound the
 * blast radius — an unrelated clean session must not be penalised.
 *
 * Only KEY NAMES are stored, never values. `mojoUnprovableEnvKeys` inspects
 * names only, and these keys routinely carry credentials (`X_JWT_TOKEN` is the
 * one allowlisted name and is therefore never recorded here).
 *
 * Clearing
 * --------
 * There is deliberately NO automatic clear. Removing an entry would assert that
 * the injected process is gone, and nothing available here proves that:
 * `MojoBackend.kill()` sends a bare `SIGTERM` with no escalation and no wait,
 * the worker exits without awaiting its child, and the child may leave detached
 * descendants — so neither a worker exit nor a per-PID check covers the tree.
 * A sound clear needs trustworthy termination of the whole mojo PROCESS GROUP
 * (escalate to SIGKILL, then confirm group quiescence); that machinery does not
 * exist yet, and until it does, retention is the fail-closed side.
 *
 * Cost: a host that once ran a mojo session with a dangerous launcher env keeps
 * that session id unprovable. Device isolation for OTHER sessions is unaffected.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const FILE_NAME = 'mojo-launcher-env-quarantine.json';

interface QuarantineFile {
  version: 1;
  /** sessionId -> unprovable launcher-env key NAMES ever handed to that session. */
  sessions: Record<string, string[]>;
}

/** Cache keyed by resolved path so a dataDir switch (tests) re-reads from disk. */
let cache: { path: string; data: QuarantineFile } | undefined;

function filePath(dataDir?: string): string {
  return join(dataDir ?? config.session.dataDir, FILE_NAME);
}

function emptyFile(): QuarantineFile {
  return { version: 1, sessions: {} };
}

function load(dataDir?: string): QuarantineFile {
  const path = filePath(dataDir);
  if (cache?.path === path) return cache.data;
  let data = emptyFile();
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      // Hand-editable file on a security path: validate rather than trust. A
      // malformed file must not silently become "nothing is quarantined".
      if (parsed && typeof parsed === 'object') {
        const sessions = (parsed as { sessions?: unknown }).sessions;
        if (sessions && typeof sessions === 'object') {
          const clean: Record<string, string[]> = {};
          for (const [sessionId, keys] of Object.entries(sessions as Record<string, unknown>)) {
            if (!Array.isArray(keys)) continue;
            const names = keys.filter((k): k is string => typeof k === 'string' && k.length > 0);
            if (names.length > 0) clean[sessionId] = [...new Set(names)];
          }
          data = { version: 1, sessions: clean };
        }
      }
    }
  } catch (err) {
    // Unreadable/corrupt file. Do NOT fall back to "empty" silently — that is
    // the fail-OPEN direction. Keep whatever is cached and make the failure loud.
    logger.error(
      `[mojo-quarantine] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`
      + ' — treating previously known entries as still quarantined',
    );
    if (cache?.path === path) return cache.data;
  }
  cache = { path, data };
  return data;
}

function persist(data: QuarantineFile, dataDir?: string): void {
  const path = filePath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Atomic replace so a crash mid-write cannot truncate the record into an
    // empty (fail-open) file.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    logger.error(
      `[mojo-quarantine] failed to persist ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Fold unprovable launcher-env key names into this session's durable record.
 *
 * Monotonic union — callers pass whatever the session was handed, and a later
 * clean payload never retracts an earlier dangerous one.
 */
export function recordQuarantinedLauncherEnvKeys(
  sessionId: string,
  keys: readonly string[],
  dataDir?: string,
): void {
  if (keys.length === 0) return;
  const data = load(dataDir);
  const before = data.sessions[sessionId] ?? [];
  const merged = [...new Set([...before, ...keys])];
  if (merged.length === before.length) return;   // nothing new
  data.sessions[sessionId] = merged;
  cache = { path: filePath(dataDir), data };
  persist(data, dataDir);
  logger.warn(
    `[mojo-quarantine] session ${sessionId.slice(0, 8)} recorded unprovable launcher env `
    + `(${merged.join(', ')}); device isolation will not treat it as safe_remote`,
  );
}

/** Durable key names for one session (empty when nothing was ever recorded). */
export function quarantinedLauncherEnvKeys(sessionId: string, dataDir?: string): string[] {
  return load(dataDir).sessions[sessionId] ?? [];
}

/**
 * Session ids with a durable record, INCLUDING sessions whose row is gone.
 *
 * The closed/residual path needs this: an explicit `/close` deletes the row, so
 * the inventory would otherwise lose every trace of an unproven hooked child.
 */
export function quarantinedSessionIds(dataDir?: string): string[] {
  return Object.keys(load(dataDir).sessions);
}

/** Test seam: drop the in-memory cache so the next read hits disk. */
export function resetQuarantineCacheForTest(): void {
  cache = undefined;
}
