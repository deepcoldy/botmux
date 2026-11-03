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
  /** `path` is the realpath-normalized root; `literalPath` is the configured
   * spelling, so references persisted through a symlinked ancestor keep
   * matching after the root is canonicalized at load time. */
  roots: { path: string; literalPath?: string; hashLength: 40 | 64 }[];
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
      || !Array.isArray(config.roots) || config.roots.length === 0) {
    throw new Error('invalid_managed_directory_config');
  }
  const roots = config.roots.map(r => {
    if (!isAbsolute(r.path) || normalize(r.path) !== r.path
      || ![40, 64].includes(r.hashLength)) throw new Error('invalid_managed_directory_config');
    // A root reached through a symlinked ancestor (/srv -> /data/srv) is a
    // normal deployment shape. Retirement identity is recorded by realpath, so
    // both the literal and real spellings must resolve to the same root.
    let canonical = r.path;
    try { canonical = realpathSync(r.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { path: canonical, literalPath: r.path, hashLength: r.hashLength };
  });
  const normalized: ManagedDirectoryConfig = { schemaVersion: 1, statePath: config.statePath, roots };
  configurations.set(path, normalized);
  return normalized;
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

function rootNames(root: { path: string; literalPath?: string }): string[] {
  return root.literalPath && root.literalPath !== root.path
    ? [root.path, root.literalPath]
    : [root.path];
}

function managedPath(config: ManagedDirectoryConfig, path: string): boolean {
  return config.roots.some(r => rootNames(r).some(prefix => dirname(path) === prefix
    && new RegExp(`^[0-9a-f]{${r.hashLength}}$`).test(path.slice(prefix.length + 1))));
}

/** Canonical key for a path that names a managed version: the realpath form
 * while the inode exists, the lexical form once it is gone. Returns undefined
 * for paths outside every configured root or non-hex siblings. */
function canonicalManagedPath(config: ManagedDirectoryConfig, path: string): string | undefined {
  if (!managedPath(config, path)) return undefined;
  try {
    const real = realpathSync(path);
    return managedPath(config, real) ? real : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return normalize(path);
    throw error;
  }
}

/** Every lexical spelling of one managed version across a root's real and
 * configured names, WITHOUT touching the filesystem. Collector-supplied sets
 * (retained, reference edges, resume targets) use this: the symlink at a root
 * can disappear between the external scan and retire, so a literal-spelling
 * assertion must still match the real-spelling candidate (and vice versa). */
function lexicalManagedKeys(config: ManagedDirectoryConfig, path: string): string[] {
  const out = new Set<string>();
  for (const root of config.roots) {
    const names = rootNames(root);
    let base: string | undefined;
    for (const prefix of names) {
      if (dirname(path) === prefix) { base = path.slice(prefix.length + 1); break; }
    }
    if (base === undefined || !new RegExp(`^[0-9a-f]{${root.hashLength}}$`).test(base)) continue;
    for (const name of names) out.add(join(name, base));
  }
  return [...out];
}

/** Collector-provided path/edge spelling(s) resolved to state keys. */
function collectorKeys(config: ManagedDirectoryConfig, path: string): string[] {
  return lexicalManagedKeys(config, path)
    .map(key => canonicalManagedPath(config, key))
    .filter((key): key is string => !!key);
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
      if (!config.roots.some(r => rootNames(r).some(prefix => v.startsWith(prefix + '/')))) {
        try { texts.push(realpathSync(v)); } catch { /* lexical check still applies to missing paths */ }
      }
    }
    for (const r of config.roots) {
      for (const rootName of rootNames(r)) {
        const escaped = rootName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`${escaped}/[0-9a-f]{${r.hashLength}}(?![0-9a-f])`, 'g');
        for (const text of texts) for (const match of text.matchAll(pattern)) {
          const canonical = canonicalManagedPath(config, match[0]);
          if (canonical) found.add(canonical);
        }
      }
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
  const registered = withFileLockSync(config.statePath, () => {
    const state = loadState(config);
    const present: string[] = [];
    for (const path of paths) {
      let info;
      try {
        info = lstatSync(path, { bigint: true });
      } catch (error) {
        // A record naming a version that is absent (never installed, already
        // quarantined, restored from a backup made elsewhere) has nothing to
        // protect and must not make whole-snapshot writes fail forever.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const retired = state.retired[path];
      let real = path;
      try { real = realpathSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // removed between the two calls
        throw error;
      }
      if (!info.isDirectory() || real !== path
          || (retired?.dev === String(info.dev) && retired.ino === String(info.ino) && retired.ctimeNs === String(info.ctimeNs))) {
        throw new Error('managed_directory_retired_or_unsafe');
      }
      present.push(path);
    }
    if (!present.length) return false;
    state.pending[token] = { pid: process.pid, identity: readDurableProcessIdentity(process.pid), paths: present };
    if (state.cycle) state.cycle.marked = [...new Set([...state.cycle.marked, ...present])];
    saveState(config, state);
    return true;
  });
  if (!registered) return () => {};
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
    // Everything is keyed by the canonical (realpath while present) spelling,
    // so a collector that hands over the symlinked form and one that hands
    // over the real form describe the same candidate.
    const normalized: { path: string; candidate: DirectoryCandidate }[] = [];
    for (const candidate of candidates) {
      if (!Array.isArray(candidate.references)) throw new Error('invalid_candidate');
      const path = canonicalManagedPath(config, candidate.path);
      if (!path) throw new Error('invalid_candidate');
      normalized.push({ path, candidate: { ...candidate, path } });
    }
    if (new Set(normalized.map(c => c.path)).size !== normalized.length) throw new Error('duplicate_candidate');
    const byPath = new Map(normalized.map(c => [c.path, c.candidate]));
    const canonicalReferences = (refs: readonly string[]): string[] =>
      refs.flatMap(ref => collectorKeys(config, ref));
    for (const entry of normalized) entry.candidate.references = canonicalReferences(entry.candidate.references);
    const keep = new Set<string>([
      ...retained.flatMap(r => collectorKeys(config, r)),
      ...state.cycle.marked,
      ...Object.values(state.pending).flatMap(p => p.paths),
    ]);
    // Set iteration visits newly added dependencies too; a snapshot would only
    // preserve one edge. Deduplication also makes cycles terminate.
    for (const path of keep) for (const ref of byPath.get(path)?.references ?? []) keep.add(ref);
    const victims = normalized.filter(c => !keep.has(c.path));
    for (const { path, candidate } of victims) {
      const info = lstatSync(path, { bigint: true });
      if (!info.isDirectory() || String(info.dev) !== candidate.dev || String(info.ino) !== candidate.ino || String(info.ctimeNs) !== candidate.ctimeNs
          || realpathSync(path) !== path) throw new Error('candidate_changed');
    }
    for (const { path, candidate } of victims) {
      state.retired[path] = { dev: candidate.dev, ino: candidate.ino, ctimeNs: candidate.ctimeNs };
    }
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
    let wanted: string[] | undefined;
    if (path) {
      wanted = collectorKeys(config, path);
      if (!wanted.length) throw new Error('invalid_candidate');
    }
    return Object.keys(state.retired).filter(p => !wanted || wanted.includes(p)).map(p => quarantine(config, state, p));
  });
}

/** All session INSERT/UPDATE paths share this adapter, including offline CAS
 * writers and migration. Reservations remain until COMMIT/ROLLBACK/close, so
 * an uncommitted new workingDir cannot fall between two collection cycles.
 * Exact row CAS may skip unchanged references; ordinary whole-row writes may not.
 *
 * A failed COMMIT/END can leave the transaction open (e.g. SQLITE_BUSY), so
 * its reservations stay until a successful retry, ROLLBACK or close. A
 * statement that rolls back the whole transaction (ON CONFLICT ROLLBACK,
 * SQLITE_FULL/IOERR) makes the caller's defensive ROLLBACK fail with "no
 * transaction is active" on both SQLite engines. Updating `transaction` only
 * after a successful exec would then leave it stuck at true and leak every
 * later reservation. Defensive ROLLBACK must still clear that state. Sessions
 * writes must therefore use plain BEGIN/COMMIT/
 * ROLLBACK single statements (never SAVEPOINT or multi-statement strings). */
export function guardSessionDirectoryWrites(db: DatabaseSyncLike): DatabaseSyncLike {
  if (!loadManagedDirectoryConfig()) return db;
  let transaction = false;
  const pending: (() => void)[] = [];
  const release = () => { for (const done of pending.splice(0)) done(); };
  const finishTransaction = () => { transaction = false; release(); };
  return {
    exec(sql) {
      if (/^\s*BEGIN\b/i.test(sql)) {
        // On failure the transaction never opened: leave the state false so a
        // caller's follow-up ROLLBACK is a harmless no-op release.
        db.exec(sql);
        transaction = true;
        return;
      }
      if (/^\s*(?:COMMIT|END)\s*;?\s*$/i.test(sql)) {
        db.exec(sql);
        finishTransaction();
        return;
      }
      if (/^\s*ROLLBACK\s*;?\s*$/i.test(sql)) {
        // The engine may already have rolled back implicitly; the caller's
        // defensive ROLLBACK must not leave later writes in a phantom transaction.
        try { db.exec(sql); } finally { finishTransaction(); }
        return;
      }
      db.exec(sql);
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
