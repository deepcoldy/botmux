import { existsSync, lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

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
function snapshotTrees(initial: readonly string[], entrypoint?: string) {
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
    } else if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe_runtime_file');
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
