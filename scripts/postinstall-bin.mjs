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
 * ── FAIL HARD WHEN THERE IS NO BINARY ──────────────────────────────────────────
 * This used to warn and exit 0, because `bin: {botmux: "dist/cli.js"}` gave every
 * failure a Node fallback to land on. That fallback is gone (it forced the main
 * package to depend on node-pty, which has no linux prebuild and so pulled a whole
 * node-gyp toolchain into every `npm i -g` — an install-time requirement that
 * simply is not met on many machines). With no fallback, exiting 0 without a
 * launcher would leave the user with a `botmux` command that does not exist, and
 * they would find out later with a confusing error. So: no binary → fail the
 * install, loudly, with the reason.
 *
 * The GUARD cases below still exit 0 silently — those are not failures, they are
 * "this is not a global install, there is nothing to do".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, renameSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Abort the install with a reason. There is no Node fallback any more (see header). */
function fail(reason, hint) {
  console.error(`[botmux] ${reason}`);
  if (hint) console.error(`[botmux] ${hint}`);
  process.exit(1);
}

/**
 * Are we on a musl libc distro (Alpine and most slim Docker images)?
 *
 * WHY THIS CHECK EXISTS: npm selects platform subpackages by `os`/`cpu`, and both
 * are identical for glibc and musl (`linux`/`x64`), so on Alpine npm happily
 * installs `botmux-linux-x64` — a glibc-linked binary that dies at exec time with a
 * loader error naming no cause. Without this check we would write a launcher
 * pointing at a binary that cannot run: the worst outcome, because the install
 * "succeeds" and the failure surfaces much later.
 *
 * (npm does support a `libc` field — undocumented in `npm help package-json` but
 * live in the wild, e.g. `@napi-rs/canvas-linux-x64-musl` publishes `libc: musl`.
 * Once botmux ships musl subpackages declaring it, npm will pick the right one on
 * its own and this guard becomes a diagnostic for "the musl package failed to
 * install" rather than "musl is unsupported".)
 *
 * Detection order is authoritative-first, and deliberately conservative: only claim
 * musl when positively observed, so a glibc box is never blocked by a false
 * positive.
 *
 * MEASURED on node:22-alpine: `process.report.getReport().header` has 23 keys and
 * carries NEITHER `glibcVersionRuntime` NOR any musl key. So the report is only
 * useful as a NEGATIVE signal ("glibcVersionRuntime present ⇒ definitely glibc,
 * stop"); on musl it tells us nothing and the loader probe below is what actually
 * decides. Do not add a `header.musl` branch back — Node does not publish one.
 */
function isMuslLinux() {
  if (process.platform !== 'linux') return false;
  // Negative signal only (see above): a reported glibc runtime settles it.
  try {
    if (process.report?.getReport?.()?.header?.glibcVersionRuntime) return false;
  } catch { /* report unavailable; fall through to filesystem probes */ }
  // The ld-musl loader is the direct positive evidence.
  for (const dir of ['/lib', '/usr/lib']) {
    try {
      if (readdirSync(dir).some(f => f.startsWith('ld-musl-'))) return true;
    } catch { /* unreadable; try the next probe */ }
  }
  // Alpine's marker file, for images that moved the loader.
  try {
    if (existsSync('/etc/alpine-release')) return true;
  } catch { /* ignore */ }
  return false;
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

// ── musl (Alpine): select the -musl subpackage ──────────────────────────────────
// This used to be a hard FAIL ("botmux's prebuilt binaries are glibc-linked and
// cannot run on musl"), which was true while only glibc binaries shipped. musl
// binaries now exist, so that message became a lie and the guard would have blocked
// the very platform we just added support for. The #1047 comment predicted this:
// "Once botmux ships musl subpackages declaring it, npm will pick the right one on
// its own and this guard becomes a diagnostic".
//
// npm does the actual selection via each subpackage's `libc` field, so on Alpine it
// installs `botmux-linux-<arch>-musl`. We only have to look for the same name — the
// detection below is what makes the lookup agree with what npm installed.
const MUSL = isMuslLinux();
const SUBPACKAGE = `botmux-${process.platform}-${process.arch}${MUSL ? '-musl' : ''}`;

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
  fail(
    `no prebuilt binary package for ${process.platform}-${process.arch} (${SUBPACKAGE}).`,
    // Do NOT say "it still works via Node" — that fallback is gone (see header).
    // On Windows the daemon cannot run natively at all (PTY/tmux/Unix signals), so
    // WSL is the real answer there, not a Node install.
    'Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64. '
      + 'On Windows, run botmux inside WSL2 (it reports as linux and is fully supported).',
  );
}

if (!existsSync(binary)) {
  fail(
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
  fail(
    `could not write the launcher at ${launcher}: ${err && err.message ? err.message : String(err)}`,
    // NOT "npm's own shim still works" — `bin` was removed with the Node fallback,
    // so there is no other `botmux` on PATH. Give the user something they can act on.
    `Fix the permissions on ${binDir} and retry, or set BOTMUX_INSTALL_DIR and use the `
      + 'standalone installer: curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh',
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
