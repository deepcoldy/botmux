import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/** Resolve surviving ancestors too: /home -> /data/home still matters after
 * the task directory itself has been removed. Permission/loop errors are NOT
 * equivalent to a missing directory. */
export function canonicalWorkspacePath(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error('workspace_path_must_be_absolute');
  }
  let cursor = resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(cursor), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink has unknown ownership, not an ordinary missing tail.
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw new Error('dangling_workspace_alias');
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export interface WorkspaceIdentity {
  path: string;
  canonicalPath: string;
  device: string;
  inode: string;
}

export function captureWorkspace(path: string): WorkspaceIdentity {
  const canonicalPath = canonicalWorkspacePath(path);
  if (canonicalPath === parse(canonicalPath).root) throw new Error('filesystem_root_is_not_a_workspace');
  const stat = statSync(canonicalPath, { bigint: true });
  if (!stat.isDirectory()) throw new Error('workspace_is_not_a_directory');
  return { path: resolve(path), canonicalPath, device: String(stat.dev), inode: String(stat.ino) };
}

/** Removal is an additional check on a successful lifecycle event, never the
 * authority to discover/close arbitrary old sessions. */
export function assertWorkspaceRemoved(workspace: WorkspaceIdentity): void {
  for (const path of new Set([workspace.path, workspace.canonicalPath])) {
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('workspace_still_exists_or_path_reused');
  }
}
