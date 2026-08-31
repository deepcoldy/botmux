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
 * each package manager exposes to postinstall (not assumed — probed every case):
 *
 *   `npm i -g botmux`                    → npm_config_global === "true"
 *   installed as someone's local dep     → npm_config_global ABSENT
 *   `pnpm install` INSIDE the botmux repo → npm_config_global ABSENT
 *   `bun add -g botmux`                  → npm_config_global ABSENT (see below)
 *
 * The third case is the dangerous one: a repo-local `pnpm install` DOES run the
 * root package's postinstall. So a `!== "false"` style check would fire during
 * ordinary development and rewrite ~/.botmux/bin/botmux — hijacking the global
 * launcher of whatever fleet shares that HOME (on the dev box that is ~50 live
 * daemons). Hence the env check stays a STRICT `=== "true"`, and there is a second,
 * independent bail-out when we can see we are inside the source checkout.
 *
 * ⚠️ THE FOURTH CASE IS WHY THE ENV CHECK ALONE IS NOT ENOUGH. Bun does pass a few
 * npm_* vars to lifecycle scripts — MEASURED with a probe package whose postinstall
 * dumped its own env, the complete set is:
 *
 *   BUN_INSTALL, BUN_WHICH_IGNORE_CWD, npm_config_user_agent, npm_execpath,
 *   npm_node_execpath
 *
 * — but `npm_config_global` is NOT among them, and that is the one this guard read.
 * So for a perfectly real `bun add -g botmux` the check failed and this script
 * exited 0 without writing anything. MEASURED end to end: `.bun/bin/` empty, no
 * launcher, the platform binary sitting in the download cache, i.e. the user had NO
 * `botmux` command at all. Worse, the obvious workaround did NOT help: `bun pm -g
 * trust botmux` made bun report `1 script ran` while this script still wrote
 * nothing, because the env check had already failed.
 *
 * ⚠️ TWO SEPARATE LAYERS — do not conflate them. (a) bun BLOCKS the script by
 * default (`Blocked N postinstalls`); `bun pm trust` lifts that. (b) even once it
 * runs, this guard killed it. Fixing (b) is what makes `bun pm trust` an actually
 * working workaround. pnpm 10/11 is a different layer again: `onlyBuiltDependencies`
 * means the script does not run at all, so this fix alone does not rescue pnpm —
 * that needs approve-builds/onlyBuiltDependencies or a different mechanism.
 *
 * So the global check is: the env says global (npm/yarn), OR THE INSTALL LOCATION
 * ITSELF says global. The layout list is INLINED in `locationSaysGlobal` below —
 * see the ⚠️ notes there for why importing the repo's classifier from `dist/` was
 * dead code in the published package, and why the inlined version is deliberately
 * stricter on Windows. A source checkout matches no global layout (verified), so
 * this cannot reopen the repo-local hijack that guard 2 also covers.
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
import { spawnSync } from 'node:child_process';
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

// ── Guard 1: only a real global install ─────────────────────────────────────────
// Two independent positive signals (see header). The env check is unchanged and
// still strict; the location check is what makes `bun add -g` / `pnpm add -g` work,
// since those provide no npm_config_* at all.
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here); // scripts/ -> package root

/**
 * Does the install LOCATION say this is a package-manager-owned global tree?
 *
 * ⚠️ WHY THIS IS INLINED INSTEAD OF IMPORTING THE REPO'S CLASSIFIER. The first
 * version did `await import('./dist/utils/global-install.js')` to reuse
 * `detectGlobalInstallManager`. That was DEAD CODE in the published package: #1115
 * removed `dist/` from `package.json` `files`, so the import always ENOENTs, the
 * catch returned false, and the guard silently fell back to env-only — leaving
 * `bun add -g botmux` exactly as broken as before. MEASURED, not reasoned:
 *
 *   git archive origin/master | tar x && npm pack
 *   tar tzf botmux-*.tgz | grep -c '^package/dist/'    → 0
 *
 * and end to end, a real `bun add -g <that tarball>` then running this script the
 * way bun does: exit 0, no launcher. This file is a standalone script with no build
 * step, and neither `dist/` nor `src/` is published, so being SELF-CONTAINED is its
 * natural form — inlining is not a compromise here.
 *
 * ⚠️ AND IT IS DELIBERATELY STRICTER THAN `detectGlobalInstallManager`. That
 * function ends with `platform === 'win32' ? 'npm' : 'unknown'`, so on Windows it
 * cannot tell a global install from a LOCAL dependency — MEASURED:
 *
 *   detectGlobalInstallManager('C:/projects/myapp/node_modules/botmux', 'win32') → 'npm'
 *
 * Harmless where it is used today (a wrong `npm i -g` merely reinstalls), but in
 * THIS file it would mean a Windows local dependency repoints the shared
 * `~/.botmux/bin/botmux` — the exact hijack guard 1 exists to prevent. So the list
 * below recognises only KNOWN GLOBAL layouts and has no platform fallback. Windows
 * npm globals are unaffected: they arrive with `npm_config_global=true` and never
 * reach this check.
 *
 * The layout patterns mirror `detectGlobalInstallManager`'s; a source guard in
 * test/npm-binary-distribution.test.ts pins the two in agreement over a matrix of
 * real global paths, so the duplication cannot drift unnoticed.
 */
function locationSaysGlobal(root) {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  // Every global layout below ends at the main package; anything else is not ours.
  if (!r.endsWith('/node_modules/botmux')) return false;
  return r.endsWith('/lib/node_modules/botmux')                    // npm, POSIX
    || r.includes('/.bun/install/global/node_modules/botmux')      // bun
    || r.includes('/bun/install/global/node_modules/botmux')       // bun, custom BUN_INSTALL
    || r.includes('/.pnpm/')                                       // pnpm virtual store
    || /\/pnpm\/global\/[^/]+\/node_modules\/botmux$/.test(r)      // pnpm 9 global
    || /\/pnpm\/global\/v\d+\/[^/]+\/node_modules\/botmux$/.test(r) // pnpm 11 global
    || /\/pnpm\/store\/v\d+\/links\/@\/botmux\//.test(r);          // pnpm 11 store links
}

if (process.env.npm_config_global !== 'true' && !locationSaysGlobal(pkgRoot)) {
  // Silent: this is the overwhelmingly common case (dev installs, transitive
  // installs). Noise here would appear on every `bun install` in the repo.
  process.exit(0);
}

// ── Guard 2: never act from inside the source checkout ──────────────────────────
// Defence in depth for guard 1. If the package directory we are running from is a
// git checkout of botmux (has .git and src/), this is a developer environment, not
// an installed package — the launcher must not be repointed.
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

// Do not activate a platform package merely because npm selected the right
// os/cpu/libc tuple. That metadata cannot express a glibc symbol-version floor:
// a binary built on Ubuntu 24.04 is still "linux-x64 + glibc", yet its embedded
// node-pty native may require GLIBC_2.34 and die on Debian 10 (glibc 2.28).
//
// Probe the exact candidate before touching the shared launcher. `--version`
// loads the complete compiled module graph (including node-pty), but starts no
// daemon and writes no bot data. A failed global npm update can then roll back
// while every already-running daemon and every shell keeps using the old launcher.
const probe = spawnSync(binary, ['--version'], {
  encoding: 'utf-8',
  timeout: 30_000,
  env: { ...process.env, BOTMUX_INSTALL_PROBE: '1' },
});
if (probe.error || probe.status !== 0) {
  const raw = probe.error?.message || probe.stderr || probe.stdout || `exit ${probe.status ?? probe.signal ?? 'unknown'}`;
  const detail = String(raw).trim().split('\n').slice(0, 8).join(' | ');
  fail(
    `${SUBPACKAGE} cannot run on this host; the existing botmux launcher was not changed.`,
    `${detail || 'candidate probe failed'}. Install a compatible release or upgrade the host OS; `
      + 'do not replace glibc in-place on a live machine.',
  );
}

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

// ── PATH: write it, don't just suggest it ─────────────────────────────────────
// This used to only PRINT `echo 'export PATH=…' >> ~/.profile`. Two problems:
// the user had to act on it, and for zsh users the suggested file is WRONG —
// zsh never reads ~/.profile (measured), so following the hint verbatim left
// `botmux` still not found. There is no `bin` field any more, so PATH is the
// only way this launcher becomes a command; we now write the right startup file
// for the user's actual shell (bash/zsh/fish/other) and tell them what we did.
//
// ⚠️ DO NOT GATE THIS ON `process.env.PATH`. It used to be wrapped in
// `if (!process.env.PATH.split(':').includes(binDir))`, which asks "is binDir on
// the PATH of the process running the install?" — the wrong question. What decides
// whether `botmux` works is whether the user's FUTURE shells get it, i.e. whether a
// startup file says so. The two come apart whenever the installing shell has binDir
// on PATH transiently, and botmux itself creates that situation: the daemon
// prepends `~/.botmux/bin` to every CLI session's PATH (five `prependBotmuxBin`
// call sites in worker.ts / worker-pool.ts). So `npm i -g botmux` run from inside a
// botmux session — or any shell that merely exported the dir — wrote NO startup
// file, printed NO hint, and exited 0; the next terminal then had no `botmux` at
// all, because there is no `bin` field to fall back on. MEASURED with the real
// script against an isolated HOME, changing only PATH:
//   PATH without binDir → writes ~/.zshenv + "open a new terminal" hint
//   PATH with    binDir → zero files, zero output, exit 0   ← the reported bug
// `ensurePathEntry` already asks the right question per file (`fileAlreadyHasEntry`,
// which also recognises a line the user wrote by hand) and reports those as
// `skipped`, so this outer check was redundant as well as wrong.
//
// ⚠️ FAIL-SOFT, and never `fail()`: the launcher is already installed and working
// at this point, so a PATH edit that cannot happen must degrade to the printed
// hint — not abort a successful install. That includes the sibling module simply
// not being there: it ships via package.json `files`, and if a future edit drops
// it (or a mirror repacks the tarball without it) the import throws. Guarding it
// keeps `npm i -g botmux` succeeding either way.
{
  let ensurePathEntry = null;
  try {
    ({ ensurePathEntry } = await import('./install-path-entry.mjs'));
  } catch (err) {
    console.error(`[botmux] PATH helper unavailable (${err && err.message ? err.message : String(err)})`);
  }
  let written = [], skipped = [];
  if (ensurePathEntry) {
    try {
      const r = ensurePathEntry({ installDir: binDir });
      ({ written, skipped } = r);
      for (const f of written) console.log(`[botmux] added ${binDir} to PATH in ${f} (${r.shell})`);
      for (const f of skipped) console.log(`[botmux] ${f} already puts ${binDir} on PATH`);
      for (const { file, error } of r.failed) console.error(`[botmux] could not update ${file}: ${error}`);
    } catch (err) {
      console.error(`[botmux] could not update your shell startup file: ${err && err.message ? err.message : String(err)}`);
    }
  }
  if (written.length > 0) {
    console.log('[botmux] open a new terminal (or re-source that file) and `botmux` will be on PATH');
  } else if (skipped.length === 0) {
    // Nothing written and nothing already present — fall back to telling them.
    // Deliberately not naming a specific file here: the correct one depends on
    // the shell, and naming the wrong one is what caused the original bug.
    console.log(`[botmux] add ${binDir} to your PATH so this launcher is the \`botmux\` your shell finds`);
  }
}
