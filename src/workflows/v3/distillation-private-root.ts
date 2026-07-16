import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const DISTILLATION_DIR_PREFIX = 'botmux-workflow-distillation-';

export function v3DistillationScratchRoot(
  parent = '/tmp',
  uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
): string {
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('invalid workflow distillation scratch root');
  }
  return join(parent, `${DISTILLATION_DIR_PREFIX}${uid}`);
}

/**
 * Create the Linux host-only scratch root under `/tmp`. Every historical
 * Botmux bwrap plan mounts a fresh tmpfs at `/tmp` before exposing the CLI, so
 * even already-running sandbox namespaces from an older binary cannot observe
 * these host bytes. The uid-qualified 0700 directory also rejects pre-creation
 * or symlink substitution by another local user.
 */
export function ensureV3DistillationScratchRoot(parent = '/tmp'): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const root = v3DistillationScratchRoot(parent, uid);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('invalid workflow distillation scratch root');
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  if (
    !rootStat.isDirectory() || rootStat.isSymbolicLink() ||
    rootStat.uid !== uid ||
    (process.platform !== 'win32' &&
      (rootStat.mode & 0o777) !== 0o700)
  ) {
    throw new Error('invalid workflow distillation scratch root');
  }
  return realpathSync(root);
}
