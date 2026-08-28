#!/usr/bin/env node
/**
 * postinstall: point the single global `botmux` launcher at the platform binary.
 *
 * WHY THIS EXISTS
 * The old model was `bin: {botmux: dist/cli.js}` with a `#!/usr/bin/env node`
 * shebang, so the CLI ran on whatever Node resolved first. With two Node versions
 * installed, each carries its OWN global botmux and users could not tell which one
 * `botmux` meant or which one an update touched. The fix: ship the self-contained
 * Bun single-file executable (its own runtime embedded, no Node needed) via npm
 * optional platform subpackages, and have exactly ONE launcher point at it.
 *
 * npm installs only the subpackage whose `os`/`cpu` match (that is what optional
 * platform deps do), so we look up whichever one actually landed and write a
 * launcher that `exec`s its binary.
 *
 * ── THE GUARD (do not loosen this) ──────────────────────────────────────────────
 * We only write the launcher for a REAL global install. Empirically measured what
 * npm/pnpm expose to postinstall (not assumed — probed all three cases):
 *
 *   `npm i -g botmux`                    → npm_config_global === "true"
 *   installed as someone's local dep     → npm_config_global ABSENT
 *   `pnpm install` INSIDE the botmux repo → npm_config_global ABSENT
 *
 * The third case is the dangerous one: a repo-local `pnpm install` DOES run the
 * root package's postinstall. So a `!== "false"` style check would fire during
 * ordinary development and rewrite ~/.botmux/bin/botmux — hijacking the global
 * launcher of whatever fleet shares that HOME (on the dev box that is ~50 live
 * daemons). Hence the guard is a STRICT `=== "true"`, and there is a second,
 * independent bail-out when we can see we are inside the source checkout.
 *
 * ── FAIL SOFT, ALWAYS ───────────────────────────────────────────────────────────
 * A postinstall that throws aborts `npm i -g`. Nothing here is worth failing an
 * install over: if we cannot find the binary or cannot write the launcher, we warn
 * with actionable text and exit 0. npm's own `bin` shim still exists as a fallback
 * path, so the user is never left with nothing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SUBPACKAGE = `botmux-${process.platform}-${process.arch}`;

/** Warn + exit 0. Never fail the install (see header). */
function bail(reason, hint) {
  console.warn(`[botmux] ${reason}`);
  if (hint) console.warn(`[botmux] ${hint}`);
  process.exit(0);
}

// ── Guard 1: only a real `npm i -g` (strict equality; see header) ───────────────
if (process.env.npm_config_global !== 'true') {
  // Silent: this is the overwhelmingly common case (dev installs, transitive
  // installs). Noise here would appear on every `pnpm install` in the repo.
  process.exit(0);
}

// ── Guard 2: never act from inside the source checkout ──────────────────────────
// Defence in depth for guard 1. If the package directory we are running from is a
// git checkout of botmux (has .git and src/), this is a developer environment, not
// an installed package — the launcher must not be repointed.
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here); // scripts/ -> package root
if (existsSync(join(pkgRoot, '.git')) && existsSync(join(pkgRoot, 'src'))) {
  process.exit(0);
}

// ── Locate the platform binary ─────────────────────────────────────────────────
// Resolve through Node's own resolver rather than guessing at node_modules layout:
// npm, pnpm, and yarn lay out global installs differently (nested, hoisted,
// symlinked store), and hand-built paths break on at least one of them. We resolve
// the subpackage's package.json (an explicit export path that always exists) and
// take its directory.
let binary;
try {
  const require = createRequire(join(pkgRoot, 'package.json'));
  const manifest = require.resolve(`${SUBPACKAGE}/package.json`);
  binary = join(dirname(manifest), 'botmux');
} catch {
  bail(
    `no prebuilt binary package for ${process.platform}-${process.arch} (${SUBPACKAGE}).`,
    'Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64. '
      + 'The `botmux` command still works via Node if this platform is unsupported.',
  );
}

if (!existsSync(binary)) {
  bail(
    `${SUBPACKAGE} is installed but its binary is missing (${binary}).`,
    'Try reinstalling: npm i -g botmux --force',
  );
}

// The binary must be executable or the launcher's `exec` fails at RUN time — long
// after install, with a confusing error. npm preserves the exec bit from the
// tarball, but a repacked/mirrored registry may not, so repair it here rather than
// trusting it.
try {
  const mode = statSync(binary).mode;
  if ((mode & 0o111) === 0) chmodSync(binary, 0o755);
} catch { /* best effort; the exec below will surface a real problem */ }

// ── Write the single launcher ──────────────────────────────────────────────────
// Same path + same atomic-write discipline as the daemon and `pnpm use:here` use
// (src/daemon.ts, scripts/claim-botmux-bin.mjs), because concurrent CLI sessions
// `exec` this file constantly and a half-written script breaks every `botmux send`
// in flight. Three parts, none optional: realpath first (else we rename over a
// symlink's own inode), a unique temp name, and an explicit chmod (creation mode is
// masked by umask — under umask 077, 0o755 lands as 0o700).
const binDir = join(homedir(), '.botmux', 'bin');
const launcher = join(binDir, 'botmux');
// `exec` replaces the shell process, so signals/exit codes pass straight through
// to the binary. No `node` anywhere in this launcher — that is the entire point.
const content = `#!/bin/sh\nexec "${binary}" "$@"\n`;

function atomicWrite(file, data, mode) {
  let target = file;
  try { target = realpathSync(file); }
  catch {
    try { target = join(realpathSync(dirname(file)), basename(file)); }
    catch { /* parent missing too; keep as-is */ }
  }
  const tmp = `${target}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* may not exist */ }
    throw err;
  }
}

try {
  mkdirSync(binDir, { recursive: true });
  let existing = '';
  try { existing = readFileSync(launcher, 'utf-8'); } catch { /* first install */ }
  if (existing !== content) {
    atomicWrite(launcher, content, 0o755);
  }
  console.log(`[botmux] launcher → ${binary}`);
} catch (err) {
  bail(
    `could not write the launcher at ${launcher}: ${err && err.message ? err.message : String(err)}`,
    'The `botmux` command may still work via npm\'s own shim.',
  );
}

// ── PATH hint ─────────────────────────────────────────────────────────────────
// Mirrors install.sh. Without ~/.botmux/bin on PATH the launcher we just wrote is
// never the `botmux` the user's shell resolves.
const pathEntries = (process.env.PATH ?? '').split(':');
if (!pathEntries.includes(binDir)) {
  console.log(`[botmux] add ${binDir} to your PATH so this launcher is the \`botmux\` your shell finds:`);
  console.log(`[botmux]   echo 'export PATH="${binDir}:$PATH"' >> ~/.profile && . ~/.profile`);
}
