#!/usr/bin/env node

/**
 * Stale-proof TypeScript builds.
 *
 * `tsc --outDir dist` never removes outputs whose sources were deleted. That
 * is unsafe for a retirement release: an old v2 runtime could otherwise stay
 * publishable forever. Remove only the repository-owned real `dist/` tree
 * before compiling. A failed build then leaves no stale deployable fallback.
 */
import { lstat, readFile, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));
if (packageJson?.name !== 'botmux') {
  throw new Error(`refusing to clean unrecognized repository root: ${repoRoot}`);
}
const distDir = resolve(repoRoot, 'dist');
if (basename(distDir) !== 'dist') {
  throw new Error(`refusing to clean unexpected build directory: ${distDir}`);
}

try {
  const stat = await lstat(distDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing to clean non-directory or symlink build output: ${distDir}`);
  }
  await rm(distDir, { recursive: true, force: false });
} catch (err) {
  if (err?.code !== 'ENOENT') throw err;
}
