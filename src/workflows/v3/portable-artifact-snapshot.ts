import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export interface DirectoryBinding {
  path: string;
  realPath: string;
  stats: BigIntStats;
}

export interface FileSnapshot {
  path: string;
  bytes: Buffer;
  sha256: string;
}

function pathInside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameInode(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function bindArtifactDirectory(
  path: string,
  label: string,
  parent?: DirectoryBinding,
): DirectoryBinding {
  const lexicalPath = resolve(path);
  const stats = lstatSync(lexicalPath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`v3 final outputs: ${label} must be a real directory: ${lexicalPath}`);
  }
  const realPath = realpathSync(lexicalPath);
  if (parent && !pathInside(parent.realPath, realPath)) {
    throw new Error(`v3 final outputs: ${label} escapes ${parent.path}: ${realPath}`);
  }
  return { path: lexicalPath, realPath, stats };
}

export function assertArtifactDirectoryBinding(
  binding: DirectoryBinding,
  label: string,
): void {
  const current = lstatSync(binding.path, { bigint: true });
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || !sameInode(binding.stats, current)
    || realpathSync(binding.path) !== binding.realPath
  ) {
    throw new Error(`v3 final outputs: ${label} changed during validation: ${binding.path}`);
  }
}

export function readStableArtifactFile(
  path: string,
  label: string,
  parent: DirectoryBinding,
): FileSnapshot {
  const lexicalPath = resolve(path);
  const beforeName = lstatSync(lexicalPath, { bigint: true });
  if (beforeName.isSymbolicLink() || !beforeName.isFile()) {
    throw new Error(`v3 final outputs: ${label} must be a real regular file: ${lexicalPath}`);
  }
  const beforeReal = realpathSync(lexicalPath);
  if (!pathInside(parent.realPath, beforeReal)) {
    throw new Error(`v3 final outputs: ${label} escapes ${parent.path}: ${beforeReal}`);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(lexicalPath, constants.O_RDONLY | noFollow);
  try {
    const beforeRead = fstatSync(fd, { bigint: true });
    if (!beforeRead.isFile() || !sameInode(beforeName, beforeRead)) {
      throw new Error(`v3 final outputs: ${label} changed before read: ${lexicalPath}`);
    }
    const bytes = readFileSync(fd);
    const afterRead = fstatSync(fd, { bigint: true });
    const afterName = lstatSync(lexicalPath, { bigint: true });
    if (
      !sameStableFile(beforeRead, afterRead)
      || afterName.isSymbolicLink()
      || !afterName.isFile()
      || !sameStableFile(afterRead, afterName)
      || realpathSync(lexicalPath) !== beforeReal
    ) {
      throw new Error(`v3 final outputs: ${label} changed during read: ${lexicalPath}`);
    }
    assertArtifactDirectoryBinding(parent, `${label} parent`);
    return {
      path: beforeReal,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    closeSync(fd);
  }
}
