/**
 * Paths under the botmux install root that the file sandbox must hide.
 *
 * The install root is granted read-only (fs-policy `botmuxInstallRoot`) so the
 * sandboxed `botmux` CLI and the claude hooks can load `dist/` + `node_modules/`.
 * For a git checkout that grant also covered everything a developer keeps
 * next to the code: `.env`, a bots config, browser login state, local data
 * dirs, `.git` (remote URLs may carry tokens). Those are never part of the
 * code, so they are exactly the entries git does not track.
 *
 * Rule: inside a git checkout, every untracked or ignored path git reports
 * (directories collapsed) is masked, except build outputs the runtime loads
 * (any path with a `dist`, `dist-bin` or `node_modules` segment). `.git` is
 * masked too. Tracked files stay readable. A non-git install root (npm
 * package dir, compiled binary) holds only published files → nothing to mask.
 *
 * An untracked directory git reports as a whole is masked as a whole — build
 * outputs the runtime loads live in tracked trees (`dist/`,
 * `packages/<pkg>/dist/`), which git reports on their own.
 *
 * Symlinks are never masked: a masked symlink would make bwrap mount the mask
 * over its TARGET (e.g. an untracked `tools -> /usr/local/bin` would hide the
 * toolchain), and the link itself exposes only its target's name — the
 * target is reachable only if the policy grants it elsewhere.
 *
 * If git cannot list the checkout, fall back to a fixed set of well-known
 * credential names so a missing git binary never fails open on the obvious
 * files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BUILD_OUTPUT_SEGMENTS = new Set(['dist', 'dist-bin', 'node_modules']);

/** Top-level names masked when git is unavailable (gitignore'd secrets this
 *  repo is known to keep in a checkout). */
const FALLBACK_TOP_LEVEL = /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.magic-token|\.magic-apps\.json|\.gdpa|storageState\.json|[^/]*bots[^/]*\.json|data|log|platform|mcp-gateway)$/;

function isBuildOutput(rel: string): boolean {
  return rel.split('/').some(seg => BUILD_OUTPUT_SEGMENTS.has(seg));
}

/** Keep `.example` templates readable (tracked anyway; matters for the fallback). */
function isTemplate(name: string): boolean {
  return name.endsWith('.example');
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** Ambient GIT_DIR / GIT_WORK_TREE / … would point `git -C root` at a
 *  different repository; drop every GIT_* variable. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function gitList(root: string, extra: string[]): string[] {
  const out = execFileSync('git', [
    '-C', root, 'ls-files', '-z', '--others', '--exclude-standard', '--directory', ...extra,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnv(),
  });
  return out.split('\0').filter(Boolean);
}

export interface InstallRootMaskResult {
  paths: string[];
  /** Set when git could not list the checkout and the fixed fallback was used. */
  fallbackReason?: string;
}

/**
 * Absolute paths under `installRoot` to deny inside the sandbox. `installRoot`
 * must already be canonical (the worker passes the realpath it grants).
 */
export function botmuxInstallRootMaskPaths(installRoot: string): InstallRootMaskResult {
  if (!installRoot || !existsSync(join(installRoot, '.git'))) return { paths: [] };
  const abs = (rel: string) => join(installRoot, rel.replace(/\/+$/, ''));
  try {
    // Untracked (not ignored) + ignored, both with directories collapsed.
    const rels = [...gitList(installRoot, []), ...gitList(installRoot, ['--ignored'])];
    const paths = new Set<string>([join(installRoot, '.git')]);
    for (const rel of rels) {
      const clean = rel.replace(/\/+$/, '');
      if (!clean || isBuildOutput(clean) || isTemplate(clean) || isSymlink(abs(clean))) continue;
      paths.add(abs(clean));
    }
    return { paths: [...paths].sort() };
  } catch (err) {
    const paths: string[] = [];
    try {
      for (const name of readdirSync(installRoot)) {
        const path = join(installRoot, name);
        if (FALLBACK_TOP_LEVEL.test(name) && !isTemplate(name) && !isSymlink(path)) paths.push(path);
      }
    } catch { /* unreadable root: nothing is exposed either */ }
    return { paths: paths.sort(), fallbackReason: (err as Error).message.split('\n')[0] };
  }
}
