/**
 * SQLite compatibility shim so botmux runs on BOTH runtimes:
 *   • Node (npm / dev): the built-in `node:sqlite` `DatabaseSync` (Node 22+).
 *   • Bun single-file executable: `node:sqlite` does NOT exist under Bun
 *     (verified: `No such built-in module: node:sqlite` on Bun 1.3.14), so use
 *     Bun's built-in `bun:sqlite` `Database` instead.
 *
 * Both back the same tiny synchronous API botmux uses (open, exec, prepare→
 * get/run/all, close), so we expose one `DatabaseSyncLike` interface and pick
 * the backing engine by runtime. Callers import `openDatabaseSync` here instead
 * of importing `node:sqlite` directly.
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

/** True when running under Bun (has the `Bun` global). node:sqlite is absent here. */
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
 * static graph. Returns null if the engine can't be loaded (caller degrades),
 * matching the adapters' existing best-effort contract.
 */
export function openDatabaseSyncNow(path: string, opts: OpenOptions = {}): DatabaseSyncLike | null {
  try {
    const require = createRequire(import.meta.url);
    if (isBunRuntime()) {
      const { Database } = require('bun:sqlite');
      const db = opts.readOnly ? new Database(path, { readonly: true }) : new Database(path);
      return wrapBunDatabase(db as never);
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = opts.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
    return db as unknown as DatabaseSyncLike;
  } catch {
    return null;
  }
}
