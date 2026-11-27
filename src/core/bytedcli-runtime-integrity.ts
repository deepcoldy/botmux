import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { ensureBytedcliPrivateDirectory } from './bytedcli-broker-audit.js';

/** Node searches ancestor node_modules and follows package symlinks. Freeze
 * those complete trees, including their canonical targets, before any CLI
 * probe can run. Bounded traversal rejects an unprovable installation. */
export function snapshotBytedcliRuntimeTrees(entrypoint: string, installationRoot: string, runtimeExecutable?: string): {
  readonly protectedPaths: readonly string[]; readonly stillCurrent: () => boolean;
} {
  const fallback = runtimeExecutable ? [join(dirname(dirname(realpathSync(runtimeExecutable))), 'lib', 'node')] : [];
  return snapshotTrees([installationRoot, ...fallback], entrypoint);
}
export function snapshotBytedcliTrustedFiles(paths: readonly string[]): {
  readonly protectedPaths: readonly string[]; readonly stillCurrent: () => boolean;
} {
  if (paths.some(path => !isAbsolute(path))) throw new Error('unsafe_host_file');
  return snapshotTrees(paths);
}
/** A package manager may hardlink this one code file into a shared cache.
 * Never execute/mount that inode: freeze its metadata, copy stable bytes into
 * an independent private inode, and recheck both before each dispatch. The
 * ordinary trusted-files/tree contract continues to reject every hardlink. */
export function snapshotBytedcliDbCodeCopy(candidate: string, snapshotRoot: string,
  write: (fd: number, bytes: Buffer) => void = writeFileSync): {
  readonly executable: string; readonly protectedPaths: readonly string[]; readonly stillCurrent: () => boolean;
} {
  if (!isAbsolute(candidate) || !isAbsolute(snapshotRoot)) throw new Error('unsafe_host_file');
  const source = realpathSync(candidate);
  const before = lstatSync(source);
  if (!before.isFile() || !(before.mode & 0o111) || before.size > 256 * 1024 * 1024) throw new Error('unsafe_runtime_file');
  const sourceSnapshot = snapshotTrees([candidate, source], undefined, source);
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('changed_runtime_file');
    bytes = readFileSync(fd);
    if (!sourceSnapshot.stillCurrent()) throw new Error('changed_runtime_file');
  } finally { closeSync(fd); }
  const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const hash = digest(bytes);
  ensureBytedcliPrivateDirectory(snapshotRoot);
  const executable = join(snapshotRoot, `db-cli-${hash}`);
  const pending = join(snapshotRoot, `.pending-${randomUUID()}`);
  const output = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
  try {
    write(output, bytes); fsyncSync(output);
    // Publish the completed inode atomically without replacing another
    // daemon's frozen copy. A partial .pending file can never become the
    // executable; completed pending links are recovered below after a crash.
    try { linkSync(pending, executable); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { closeSync(output); removeDbPending(pending); }
  const directory = openSync(snapshotRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  const copy = lstatSync(executable);
  if ((copy.mode & 0o777) !== 0o500 || !copy.isFile()
    || process.getuid && copy.uid !== process.getuid()) throw new Error('unsafe_runtime_copy');
  if (digest(readFileSync(executable)) !== hash || !sourceSnapshot.stillCurrent()) throw new Error('changed_runtime_file');
  recoverDbPublication(executable, snapshotRoot, copy);
  const copySnapshot = snapshotBytedcliTrustedFiles([executable]);
  if (!sourceSnapshot.stillCurrent() || !copySnapshot.stillCurrent()) throw new Error('changed_runtime_file');
  return Object.freeze({ executable, protectedPaths: Object.freeze([...sourceSnapshot.protectedPaths, ...copySnapshot.protectedPaths]),
    stillCurrent: () => sourceSnapshot.stillCurrent() && copySnapshot.stillCurrent() });
}
function removeDbPending(path: string): void {
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function recoverDbPublication(executable: string, root: string, verified: Stats): void {
  // A sibling may already be cleaning the same completed publication. Only
  // our UUID pending names in this private directory can be recovered, and
  // every extra hardlink must be accounted for before deleting any alias.
  if (verified.nlink === 1) return;
  const names = readdirSync(root); if (names.length > 100_000) throw new Error('unbounded_runtime_copy');
  const aliases: string[] = [];
  for (const name of names) {
    if (!/^\.pending-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name)) continue;
    const path = join(root, name);
    try { const stat = lstatSync(path); if (stat.isFile() && stat.dev === verified.dev && stat.ino === verified.ino) aliases.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const current = lstatSync(executable);
  if (current.dev !== verified.dev || current.ino !== verified.ino || current.mode !== verified.mode
    || current.uid !== verified.uid || current.size !== verified.size || current.mtimeMs !== verified.mtimeMs) throw new Error('changed_runtime_file');
  if (current.nlink > 1) {
    if (current.nlink !== aliases.length + 1) throw new Error('unproven_runtime_links');
    for (const alias of aliases) removeDbPending(alias);
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  if (lstatSync(executable).nlink !== 1) throw new Error('unproven_runtime_links');
}
function snapshotTrees(initial: readonly string[], entrypoint?: string, copiedHardlinkSource?: string) {
  const roots = new Set<string>(); const absent = new Set<string>();
  const snapshots = new Map<string, Stats>();
  const ancestors = new Map<string, Stats>();
  const pending: string[] = []; let visited = 0;
  const add = (path: string) => {
    if (roots.has(path)) return;
    roots.add(path); pending.push(path);
    let cursor = dirname(path);
    for (;;) {
      if (!ancestors.has(cursor)) {
        try {
          const stat = lstatSync(cursor);
          const stickyHostTmp = stat.isDirectory() && (stat.mode & 0o1000) && stat.uid === 0;
          if (!stat.isSymbolicLink() && (stat.mode & 0o022) && !stickyHostTmp) throw new Error('unsafe_runtime_ancestor');
          ancestors.set(cursor, stat);
          if (ancestors.size > 100_000) throw new Error('unbounded_runtime_ancestors');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (dirname(cursor) === cursor) break;
      cursor = dirname(cursor);
    }
  };
  const search = (leaf: string) => {
    let cursor = dirname(leaf);
    for (;;) {
      const path = join(cursor, 'node_modules');
      add(path);
      if (dirname(cursor) === cursor) break;
      cursor = dirname(cursor);
    }
  };
  for (const path of initial) add(path);
  if (entrypoint) search(entrypoint);
  const visit = (path: string): void => {
    if (snapshots.has(path) || absent.has(path)) return;
    if (++visited > 100_000) throw new Error('unbounded_runtime_tree');
    if (!existsSync(path)) {
      // Broken symlinks are not proof of an absent search root.
      try { lstatSync(path); throw new Error('broken_runtime_link'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      absent.add(path); return;
    }
    const stat = lstatSync(path);
    if ((!stat.isSymbolicLink() && (stat.mode & 0o022)) || process.getuid && stat.uid !== 0 && stat.uid !== process.getuid()) throw new Error('unsafe_runtime_tree');
    snapshots.set(path, stat);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!isAbsolute(target)) throw new Error('unsafe_runtime_link');
      add(target); if (entrypoint) search(target); return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (!stat.isFile() || stat.nlink !== 1 && path !== copiedHardlinkSource) throw new Error('unsafe_runtime_file');
  };
  for (let index = 0; index < pending.length; index++) visit(pending[index]!);
  return Object.freeze({ protectedPaths: Object.freeze([...roots]), stillCurrent: () => {
    try {
      for (const path of absent) { try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; } }
      for (const [path, before] of snapshots) {
        const now = lstatSync(path);
        if (now.dev !== before.dev || now.ino !== before.ino || now.mode !== before.mode || now.uid !== before.uid
          || now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs) return false;
      }
      for (const [path, before] of ancestors) {
        const now = lstatSync(path);
        if (now.dev !== before.dev || now.ino !== before.ino || now.mode !== before.mode || now.uid !== before.uid) return false;
      }
      return true;
    } catch { return false; }
  } });
}
