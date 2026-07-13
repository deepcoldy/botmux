/**
 * Distinguishes a local source checkout (or git worktree) from a published
 * npm install. Used to disable auto-update for local-dev deployments — running
 * a global package update against a daemon that runs from a git checkout
 * would not take effect and only risks confusion.
 *
 * npm publishes only `dist/` (+ a few root files; see package.json `files`),
 * never `.git` or `src/`, so the presence of either at the package root is a
 * reliable "running from source" signal.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pure check: is `rootDir` a source working copy rather than an npm install? */
export function isLocalDevInstallAt(rootDir: string): boolean {
  return existsSync(join(rootDir, '.git')) || existsSync(join(rootDir, 'src'));
}

let cached: boolean | undefined;

/** Classify this running install. Cached — it cannot change at runtime. */
export function isLocalDevInstall(): boolean {
  if (cached === undefined) cached = isLocalDevInstallAt(packageRoot());
  return cached;
}

/** The running botmux version (from the install's package.json). For an
 *  npm-global install this is the real published version; in a source checkout
 *  it's the unbuilt '0.0.0' (CI injects the real version at publish). */
export function botmuxVersionAt(rootDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function botmuxVersion(): string {
  return botmuxVersionAt(packageRoot());
}

/** Absolute path to this install's CLI entrypoint (`dist/cli.js`). The correct
 *  way to restart is `node <this>/dist/cli.js restart` — a raw `pm2 restart`
 *  would not pick up a changed install dir. */
export function botmuxCliEntryAt(rootDir: string): string {
  return join(rootDir, 'dist', 'cli.js');
}

export function botmuxCliEntry(): string {
  return botmuxCliEntryAt(packageRoot());
}

/** Absolute path to this install's root (the dir holding package.json). For a
 *  source checkout this is the git working tree — used to derive a real version
 *  via `git describe` when package.json is the unbuilt 0.0.0. */
export function botmuxInstallRoot(): string {
  return packageRoot();
}

/** Walk up from this module to the nearest dir containing package.json. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}
