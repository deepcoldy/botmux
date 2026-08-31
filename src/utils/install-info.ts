/**
 * Distinguishes a local source checkout (or git worktree) from a published
 * npm install. Used to disable auto-update for local-dev deployments — running
 * a global package update against a daemon that runs from a git checkout
 * would not take effect and only risks confusion.
 *
 * npm publishes neither `.git` nor `src/` (see package.json `files`), so the
 * presence of either at the package root is a reliable "running from source"
 * signal. That is the whole basis of the check, and it is unaffected by WHICH
 * files the tarball does carry — this comment used to say "npm publishes only
 * `dist/`", which stopped being true when `dist/` was dropped from `files` (it
 * shipped a second, unrunnable Node CLI that imported node-pty, a package the
 * manifest does not depend on). The predicate never depended on that; only the
 * sentence did.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStandaloneBinary } from '../core/self-spawn.js';

/** Pure check: is `rootDir` a source working copy rather than an npm install? */
export function isLocalDevInstallAt(rootDir: string): boolean {
  return existsSync(join(rootDir, '.git')) || existsSync(join(rootDir, 'src'));
}

let cached: boolean | undefined;

/**
 * Classify this running install. Cached — it cannot change at runtime.
 *
 * ⚠️ A COMPILED BINARY IS NEVER A SOURCE CHECKOUT, and the naive check cannot
 * see that. `packageRoot()` walks up looking for package.json; inside a
 * single-file executable there is none on disk (the module graph lives in the
 * virtual `/$bunfs/`), so it returns `/` — and the test then becomes "does the
 * FILESYSTEM ROOT have .git or src?". On this box neither exists so the answer is
 * accidentally correct, but plenty of container images do have `/src`, and there
 * the compiled binary would be misclassified as a dev checkout and sent down the
 * `git pull --ff-only` update path.
 *
 * The standalone check is therefore an explicit early return, not a refinement of
 * the filesystem probe. Node behaviour is bit-for-bit unchanged.
 */
export function isLocalDevInstall(): boolean {
  if (cached === undefined) {
    cached = isStandaloneBinary() ? false : isLocalDevInstallAt(packageRoot());
  }
  return cached;
}

/** Test seam: drop the cached classification. Production never calls this — the
 *  answer genuinely cannot change within one process. */
export function __resetLocalDevInstallCacheForTests(): void {
  cached = undefined;
}

/**
 * The version baked in at compile time by scripts/build-bun-binary.mjs, or
 * undefined when running from Node.
 *
 * WHY THIS EXISTS: every other version lookup ends at a `readFileSync` of the
 * install root's package.json. The compiled single-file executable has NO
 * package.json on disk — its module graph lives in the virtual read-only
 * /$bunfs, and `packageRoot()` below walks up to `/`, which has none. So every
 * such read fails in compiled mode and callers fall back to their sentinel
 * ('unknown' / '0.0.0'). Measured on the published canary: `botmux --version`
 * printed `unknown` and the help banner read `botmux vunknown`.
 *
 * The build substitutes `process.env.BOTMUX_BAKED_VERSION` as a string literal,
 * so under Node the property is simply absent and this returns undefined —
 * leaving the existing disk-read path completely untouched. It is also read
 * through `process.env` deliberately: that keeps it overridable for tests and
 * avoids a bare identifier that tsc would reject.
 */
export function bakedBinaryVersion(): string | undefined {
  const baked = process.env.BOTMUX_BAKED_VERSION;
  if (typeof baked !== 'string') return undefined;
  const trimmed = baked.trim();
  // '0.0.0' is the unbuilt placeholder, not a real version — treat it as absent
  // so a locally-compiled dev binary still falls through to the git-describe
  // path rather than reporting a bogus 0.0.0 as authoritative.
  if (trimmed.length === 0 || trimmed === '0.0.0') return undefined;
  return trimmed;
}

/** The running botmux version (from the install's package.json). For an
 *  npm-global install this is the real published version; in a source checkout
 *  it's the unbuilt '0.0.0' (CI injects the real version at publish). */
export function botmuxVersionAt(rootDir: string): string {
  // The compiled binary has no package.json to read (see bakedBinaryVersion).
  const baked = bakedBinaryVersion();
  if (baked) return baked;
  return diskVersionAt(rootDir);
}

/**
 * The version recorded in `rootDir`'s package.json, IGNORING the baked value.
 *
 * ⚠️ WHY THIS EXISTS — THE BAKED VERSION SHADOWS A COMPLETED UPDATE. `baked` is
 * compiled into the running executable, so `botmuxVersionAt` returns it no matter
 * which directory you ask about. That is right for "what am I running", and WRONG
 * for "what is now installed on disk": after a package-manager update replaces the
 * install tree, a compiled binary asking `botmuxVersionAt(root)` still gets its OWN
 * old version (measured: package.json says 3.19.0, the call returns 3.18.4).
 *
 * The maintenance tick gates its restart on `after !== before`, so that shadowing
 * makes a successful update look like "already on the latest version" — it never
 * restarts onto what it just installed. Post-update reads must therefore use this
 * function, not `botmuxVersionAt`.
 *
 * (Under Node `bakedBinaryVersion()` is undefined, so the two are identical there
 * — which is why this defect only surfaces for the compiled binary.)
 */
export function diskVersionAt(rootDir: string): string {
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
