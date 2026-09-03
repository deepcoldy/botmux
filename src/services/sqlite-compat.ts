/**
 * SQLite compatibility shim so botmux runs on BOTH runtimes:
 *   • Node (npm / dev): the built-in `node:sqlite` `DatabaseSync` (Node 22+).
 *   • Bun single-file executable: use Bun's built-in `bun:sqlite` `Database`.
 *     (Historically `node:sqlite` did NOT exist under Bun — verified missing on
 *     Bun 1.3.14; Bun 1.4 now ships it, but we keep using `bun:sqlite` under Bun:
 *     it's the native engine, already verified, and switching would be a
 *     behavior change for no benefit. The runtime split stays.)
 *
 * Both back the same tiny synchronous API botmux uses (open, exec, prepare→
 * get/run/all, close), so we expose one `DatabaseSyncLike` interface and pick
 * the backing engine by runtime. Callers import from here instead of
 * importing `node:sqlite` directly.
 *
 * Two open contracts:
 *   • `openDatabaseSyncNow` — best-effort (adapters / feedback): any failure
 *     returns null, including a missing module AND a corrupt file.
 *   • `sqliteEngineAvailable` + `openDatabaseSyncOrThrow` — fail-closed
 *     stores (session-store): module-load failure is "no engine"; a
 *     corrupt/locked file surfaces at first exec/query after the engine
 *     loaded (not a missing runtime). Do not collapse the two.
 *
 * Kept deliberately synchronous to match the existing feedback store's contract
 * (a synchronous write under a busy_timeout serializes concurrent opens without
 * an async barrier — see skill-feedback-store.ts). Both engines are synchronous.
 */

import { createRequire } from 'node:module';

/** The result of a mutating statement: both engines expose changes + rowid. */
export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/** The synchronous statement handle both engines expose (the subset botmux uses). */
export interface StatementLike {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): RunResult;
  all(...params: unknown[]): unknown[];
}

/** The synchronous DB handle both engines expose (the subset botmux uses). */
export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

export interface OpenOptions {
  /** Open read-only (node:sqlite `readOnly` / bun:sqlite `readonly`). */
  readOnly?: boolean;
}

/** True when running under Bun (has the `Bun` global). We back it with
 *  `bun:sqlite` regardless of whether this Bun also exposes node:sqlite (1.4+). */
function isBunRuntime(): boolean {
  // @ts-ignore — Bun global absent under Node/tsc.
  return typeof Bun !== 'undefined';
}

/**
 * Wrap a `bun:sqlite` Database in the DatabaseSyncLike shape. Bun's API is nearly
 * identical (constructor, .exec, .prepare→.get/.run/.all, .close); the only
 * adaptation is the option name (`readonly` vs `readOnly`) handled at open time.
 */
function wrapBunDatabase(db: {
  exec(sql: string): void;
  prepare(sql: string): { get(...p: unknown[]): unknown; run(...p: unknown[]): RunResult; all(...p: unknown[]): unknown[] };
  close(): void;
}): DatabaseSyncLike {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        get: (...params) => stmt.get(...params),
        run: (...params) => stmt.run(...params),
        all: (...params) => stmt.all(...params),
      };
    },
    close: () => db.close(),
  };
}

/**
 * Load `node:sqlite` WITHOUT letting Node print its experimental warning.
 *
 * On Node 22 (the version CI and most installs run) the first load of
 * `node:sqlite` emits
 *   `(node:PID) ExperimentalWarning: SQLite is an experimental feature …`
 * plus a "use --trace-warnings" line, on STDERR. Node 24 no longer does, which
 * is why this went unnoticed on a 24 dev box.
 *
 * For a daemon that is one stray log line. For the CLI it is a real defect: the
 * two lines land in the middle of a full-screen TUI (`botmux list` runs on the
 * alternate screen — the warning scrolls the pinned header off the top), and
 * they pollute the stderr of every agent-facing `botmux` command that touches
 * the session store. Adding a `process.on('warning')` listener does NOT stop
 * it — Node's default printer runs regardless — so the emit itself has to be
 * filtered, narrowly and only for the duration of this require.
 */
function requireNodeSqlite(require: NodeRequire): unknown {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function patchedEmitWarning(warning: unknown, ...rest: unknown[]): void {
    const text = typeof warning === 'string' ? warning : (warning as Error | undefined)?.message ?? '';
    const type = typeof rest[0] === 'string'
      ? rest[0]
      : (rest[0] as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && /\bSQLite\b/i.test(text)) return;
    (originalEmitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function openWithLoadedEngine(path: string, opts: OpenOptions = {}): DatabaseSyncLike {
  const require = createRequire(import.meta.url);
  if (isBunRuntime()) {
    const { Database } = require('bun:sqlite');
    const db = opts.readOnly ? new Database(path, { readonly: true }) : new Database(path);
    return wrapBunDatabase(db as never);
  }
  const { DatabaseSync } = requireNodeSqlite(require) as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => unknown;
  };
  const db = opts.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  return db as unknown as DatabaseSyncLike;
}

/** Probe whether a SQLite engine can be loaded. Does not open a file, so a
 *  corrupt database is not mistaken for a missing runtime. */
export function sqliteEngineAvailable(): boolean {
  try {
    const require = createRequire(import.meta.url);
    if (isBunRuntime()) {
      require('bun:sqlite');
      return true;
    }
    requireNodeSqlite(require);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a SQLite database with the right engine for the current runtime, returning
 * a unified synchronous handle. Async because Node's binding is imported lazily
 * (matches the existing `await import('node:sqlite')` call sites, and keeps the
 * `node:sqlite` specifier out of the Bun bundle's static graph — Bun's bundler
 * would otherwise try to resolve a module that doesn't exist there).
 */
export async function openDatabaseSync(path: string, opts: OpenOptions = {}): Promise<DatabaseSyncLike> {
  if (isBunRuntime()) {
    // Dynamic specifier keeps `bun:sqlite` out of Node's static resolution too.
    const { Database } = await import('bun:sqlite' as string);
    // Omit the options arg entirely when not read-only: both engines reject an
    // explicit `undefined` second arg ("options argument must be an object").
    const db = opts.readOnly ? new Database(path, { readonly: true }) : new Database(path);
    return wrapBunDatabase(db as never);
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = opts.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  // node:sqlite's DatabaseSync already matches DatabaseSyncLike structurally.
  return db as unknown as DatabaseSyncLike;
}

/**
 * Synchronous open, for call sites that must stay sync (e.g. the opencode/traex
 * adapters' `withDb`, which run inside synchronous input-delivery paths). Uses
 * `createRequire` so the runtime-specific specifier stays out of the bundler's
 * static graph. Returns null if the engine can't be loaded OR the open fails
 * (caller degrades), matching the adapters' existing best-effort contract.
 */
export function openDatabaseSyncNow(path: string, opts: OpenOptions = {}): DatabaseSyncLike | null {
  try {
    return openWithLoadedEngine(path, opts);
  } catch {
    return null;
  }
}

/**
 * Synchronous open that distinguishes "no engine" from "engine loaded, file
 * unusable". Module-load errors throw from `require`. Neither runtime validates
 * the file in the constructor, and `PRAGMA busy_timeout` does not either (it is
 * connection-level and touches no page). A corrupt / locked file is rejected by
 * the first PAGE-TOUCHING statement, which differs per path:
 *   • write path (`openDbForOwnStore`): `PRAGMA journal_mode` — inside the helper.
 *   • read path (`openDbForRead`): the helper RETURNS A HANDLE; the caller's
 *     first SELECT throws (`file is not a database`).
 * Either way the throw lands inside a scan loop's try, which rethrows only
 * `SessionStoreSqliteUnavailableError` and skips everything else — so
 * SQLITE_NOTADB stays "skippable store", never "runtime has no SQLite".
 */
export function openDatabaseSyncOrThrow(path: string, opts: OpenOptions = {}): DatabaseSyncLike {
  return openWithLoadedEngine(path, opts);
}
