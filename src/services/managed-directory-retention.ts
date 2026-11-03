/** Write barrier for operator-managed immutable directories.
 * Scanning and recursive unlink belong to the external collector. Botmux only
 * serializes publication of references with retirement of exact directory inodes.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveBotsConfigFile } from '../core/config-dir.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { readDurableProcessIdentity } from '../utils/process-identity.js';
import type { DatabaseSyncLike, StatementLike } from './sqlite-compat.js';

export interface ManagedDirectoryConfig {
  schemaVersion: 1;
  statePath: string;
  roots: { path: string; hashLength: 40 | 64 }[];
}
export interface DirectoryCandidate { path: string; dev: string; ino: string; ctimeNs: string; references: string[] }
interface Reservation { pid: number; identity?: string; paths: string[] }
interface State {
  schemaVersion: 1;
  pending: Record<string, Reservation>;
  retired: Record<string, { dev: string; ino: string; ctimeNs: string }>;
  cycle?: { id: string; marked: string[] };
}

export function managedDirectoryConfigPath(botsFile = resolveBotsConfigFile()): string {
  return join(dirname(botsFile), '.managed-directories.json');
}

const configurations = new Map<string, ManagedDirectoryConfig | undefined>();

export function loadManagedDirectoryConfig(botsFile?: string): ManagedDirectoryConfig | undefined {
  const path = managedDirectoryConfigPath(botsFile);
  if (configurations.has(path)) return configurations.get(path);
  if (!existsSync(path)) { configurations.set(path, undefined); return undefined; }
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('unsafe_managed_directory_config');
  const config = JSON.parse(readFileSync(path, 'utf8')) as ManagedDirectoryConfig;
  if (config.schemaVersion !== 1 || !isAbsolute(config.statePath)
      || !Array.isArray(config.roots) || config.roots.length === 0
      || config.roots.some(r => !isAbsolute(r.path) || normalize(r.path) !== r.path
        || ![40, 64].includes(r.hashLength))) throw new Error('invalid_managed_directory_config');
  configurations.set(path, config);
  return config;
}

function loadState(config: ManagedDirectoryConfig): State {
  if (!existsSync(config.statePath)) return { schemaVersion: 1, pending: {}, retired: {} };
  if (!lstatSync(config.statePath).isFile()) throw new Error('invalid_retention_state');
  const state = JSON.parse(readFileSync(config.statePath, 'utf8')) as State;
  if (state.schemaVersion !== 1 || !state.pending || !state.retired) throw new Error('invalid_retention_state');
  return state;
}

// Deliberately independent of the generic atomic writer: this is the barrier's
// own journal. Fsync before acknowledging a reference or retirement decision.
function saveState(config: ManagedDirectoryConfig, state: State): void {
  const tmp = config.statePath + '.' + randomUUID() + '.tmp';
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, config.statePath);
    const parent = openSync(dirname(config.statePath), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed, or preserve the original persistence error */ }
  }
}

function managedPath(config: ManagedDirectoryConfig, path: string): boolean {
  return config.roots.some(r => dirname(path) === r.path
    && new RegExp(`^[0-9a-f]{${r.hashLength}}$`).test(path.slice(r.path.length + 1)));
}

export function managedReferences(config: ManagedDirectoryConfig, value: unknown): Set<string> {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v && typeof v === 'object') { Object.values(v).forEach(visit); return; }
    if (typeof v !== 'string') return;
    const texts = [v];
    if (isAbsolute(v) && !v.includes('\n')) {
      texts.push(normalize(v));
      if (!config.roots.some(r => v.startsWith(r.path + '/'))) {
        try { texts.push(realpathSync(v)); } catch { /* lexical check still applies to missing paths */ }
      }
    }
    for (const r of config.roots) {
      const escaped = r.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`${escaped}/[0-9a-f]{${r.hashLength}}(?![0-9a-f])`, 'g');
      for (const text of texts) for (const match of text.matchAll(pattern)) found.add(match[0]);
    }
    if (/^\s*[\[{]/.test(v)) { try { visit(JSON.parse(v)); } catch { /* ordinary text */ } }
  };
  visit(value);
  return found;
}

function alive(reservation: Reservation): boolean {
  try { process.kill(reservation.pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  const identity = readDurableProcessIdentity(reservation.pid);
  return !identity || !reservation.identity || identity === reservation.identity;
}

/** A reservation outlives an asynchronous write / SQLite transaction. It is
 * copied into every scan begun before the publication finishes. No GC lock is
 * held while doing the actual write or awaiting a database lock. */
export function reserveManagedDirectories(value: unknown, previous?: unknown, botsFile?: string): () => void {
  const config = loadManagedDirectoryConfig(botsFile);
  if (!config) return () => {};
  const old = managedReferences(config, previous);
  const paths = [...managedReferences(config, value)].filter(p => !old.has(p));
  if (!paths.length) return () => {};
  const token = randomUUID();
  withFileLockSync(config.statePath, () => {
    const state = loadState(config);
    for (const path of paths) {
      const info = lstatSync(path, { bigint: true });
      const retired = state.retired[path];
      if (!info.isDirectory() || realpathSync(path) !== path
          || (retired?.dev === String(info.dev) && retired.ino === String(info.ino) && retired.ctimeNs === String(info.ctimeNs))) {
        throw new Error('managed_directory_retired_or_unsafe');
      }
    }
    state.pending[token] = { pid: process.pid, identity: readDurableProcessIdentity(process.pid), paths };
    if (state.cycle) state.cycle.marked = [...new Set([...state.cycle.marked, ...paths])];
    saveState(config, state);
  });
  return () => withFileLockSync(config.statePath, () => {
    const state = loadState(config);
    delete state.pending[token];
    saveState(config, state);
  });
}

export function withManagedDirectories<T>(value: unknown, operation: () => T, previous?: unknown, botsFile?: string): T {
  const release = reserveManagedDirectories(value, previous, botsFile);
  try { return operation(); } finally { release(); }
}

export async function withManagedDirectoriesAsync<T>(value: unknown, operation: () => Promise<T>, previous?: unknown, botsFile?: string): Promise<T> {
  const release = reserveManagedDirectories(value, previous, botsFile);
  try { return await operation(); } finally { release(); }
}

export function beginDirectoryCollection(): string {
  const config = loadManagedDirectoryConfig();
  if (!config) throw new Error('managed_directories_not_configured');
  return withFileLockSync(config.statePath, () => {
    const state = loadState(config);
    for (const [key, pending] of Object.entries(state.pending)) if (!alive(pending)) delete state.pending[key];
    const id = randomUUID();
    state.cycle = { id, marked: [...new Set(Object.values(state.pending).flatMap(p => p.paths))] };
    saveState(config, state);
    return id;
  });
}

/** Finish a complete external scan. Newly published references join the mark
 * set, including transitive edges through immutable packages/backups. The
 * durable retirement decision fences all victims before the first rename.
 * A crash or partial rename is resumed without rescanning or reviving victims. */
export function retireManagedDirectories(id: string, candidates: DirectoryCandidate[], retained: string[]): string[] {
  const config = loadManagedDirectoryConfig();
  if (!config) throw new Error('managed_directories_not_configured');
  return withFileLockSync(config.statePath, () => {
    const state = loadState(config);
    if (state.cycle?.id !== id) throw new Error('stale_directory_collection');
    if (new Set(candidates.map(c => c.path)).size !== candidates.length) throw new Error('duplicate_candidate');
    const byPath = new Map(candidates.map(c => [c.path, c]));
    const keep = new Set([...retained, ...state.cycle.marked, ...Object.values(state.pending).flatMap(p => p.paths)]);
    for (const path of keep) for (const ref of byPath.get(path)?.references ?? []) keep.add(ref);
    const victims = candidates.filter(c => !keep.has(c.path));
    for (const candidate of candidates) {
      if (!managedPath(config, candidate.path) || !Array.isArray(candidate.references)) throw new Error('invalid_candidate');
    }
    for (const candidate of victims) {
      const info = lstatSync(candidate.path, { bigint: true });
      if (!info.isDirectory() || String(info.dev) !== candidate.dev || String(info.ino) !== candidate.ino || String(info.ctimeNs) !== candidate.ctimeNs
          || realpathSync(candidate.path) !== candidate.path) throw new Error('candidate_changed');
    }
    for (const c of victims) state.retired[c.path] = { dev: c.dev, ino: c.ino, ctimeNs: c.ctimeNs };
    delete state.cycle;
    saveState(config, state);
    return victims.map(c => quarantine(config, state, c.path));
  });
}

function quarantine(_config: ManagedDirectoryConfig, state: State, path: string): string {
  const retired = state.retired[path];
  const target = join(dirname(path), '.gc-' + path.slice(dirname(path).length + 1) + '-' + retired.dev + '-' + retired.ino);
  if (!existsSync(path)) return target;
  const info = lstatSync(path, { bigint: true });
  if (String(info.dev) !== retired.dev || String(info.ino) !== retired.ino || String(info.ctimeNs) !== retired.ctimeNs) return target; // a newly installed generation
  if (!info.isDirectory() || realpathSync(path) !== path || existsSync(target)) throw new Error('unsafe_retirement');
  renameSync(path, target);
  return target;
}

/** Caller holds the installer lock. This is metadata-only, never recursive
 * deletion: a reinstall can create a fresh inode at the same content hash. */
export function resumeDirectoryRetirement(path?: string): string[] {
  const config = loadManagedDirectoryConfig();
  if (!config) throw new Error('managed_directories_not_configured');
  return withFileLockSync(config.statePath, () => {
    const state = loadState(config);
    if (path && !managedPath(config, path)) throw new Error('invalid_candidate');
    return Object.keys(state.retired).filter(p => !path || p === path).map(p => quarantine(config, state, p));
  });
}

/** All session INSERT/UPDATE paths share this adapter, including offline CAS
 * writers and migration. Reservations remain until COMMIT/ROLLBACK/close, so
 * an uncommitted new workingDir cannot fall between two collection cycles.
 * Exact row CAS may skip unchanged references; ordinary whole-row writes may not. */
export function guardSessionDirectoryWrites(db: DatabaseSyncLike): DatabaseSyncLike {
  if (!loadManagedDirectoryConfig()) return db;
  let transaction = false;
  const pending: (() => void)[] = [];
  const release = () => { for (const done of pending.splice(0)) done(); };
  return {
    exec(sql) {
      db.exec(sql);
      if (/^\s*BEGIN\b/i.test(sql)) transaction = true;
      if (/^\s*(COMMIT|ROLLBACK|END)\s*;?\s*$/i.test(sql)) { transaction = false; release(); }
    },
    prepare(sql): StatementLike {
      const statement = db.prepare(sql);
      if (!/^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE)\s+sessions\b/i.test(sql)) return statement;
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run: (...args) => {
          const previous = /\bAND\s+row\s*=\s*\?\s*$/i.test(sql) ? args.at(-1) : undefined;
          const done = reserveManagedDirectories(args, previous);
          try {
            const result = statement.run(...args);
            if (transaction) pending.push(done); else done();
            return result;
          } catch (error) { done(); throw error; }
        },
      };
    },
    close() { db.close(); transaction = false; release(); },
  };
}
