import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { detectGlobalInstallManager } from '../src/utils/global-install.js';

/**
 * Pins the npm single-version binary distribution (PR #873).
 *
 * GOAL BEING PROTECTED: `npm i -g botmux` must produce exactly ONE global botmux
 * whose CLI is the self-contained Bun binary. The old `bin: dist/cli.js` +
 * `#!/usr/bin/env node` model gave every installed Node version its own global
 * botmux, and users could not tell which one `botmux` meant.
 *
 * Every assertion below corresponds to a failure mode that was REPRODUCED by hand
 * first, because each one fails silently or destructively in production:
 *   · optionalDependencies committed to package.json → `error: lockfile had
 *     changes, but lockfile is frozen` on every CI job (repo installs with
 *     --frozen-lockfile everywhere).
 *   · `npm version` does not rewrite dependency ranges → a committed "0.0.0" would
 *     point at a version that never exists, npm skips the optional dep, and the
 *     launcher finds no binary. Silent degradation.
 *   · postinstall script not in `files` → `npm i -g` fails outright with
 *     "npm error code 1 ... command sh -c node scripts/postinstall-bin.mjs".
 *   · postinstall firing on a NON-global install → rewrites ~/.botmux/bin/botmux
 *     during ordinary `pnpm install`, hijacking the global launcher of whatever
 *     fleet shares that HOME.
 */

const POSTINSTALL = resolve('scripts/postinstall-bin.mjs');
const INJECT = resolve('scripts/inject-optional-binaries.mjs');
const PLATFORMS = ['botmux-darwin-arm64', 'botmux-darwin-x64', 'botmux-linux-arm64', 'botmux-linux-x64'];

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'botmux-npm-dist-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('package.json — lockfile safety and packaging', () => {
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'));

  it('does NOT commit optionalDependencies (would break --frozen-lockfile everywhere)', () => {
    // The four platform packages are injected at release time instead; see
    // scripts/inject-optional-binaries.mjs. If someone "helpfully" commits them,
    // pnpm-lock.yaml goes stale and every workflow fails at the install step.
    for (const name of PLATFORMS) {
      expect(manifest.optionalDependencies?.[name]).toBeUndefined();
    }
  });

  /**
   * THE PUBLISHED TARBALL MUST NOT CARRY THE NODE FORM.
   *
   * #1047 removed the Node fallback by deleting `bin` and demoting node-pty to a
   * devDependency — but `files` still shipped `dist/` (4221 files, 48 MB unpacked)
   * plus an `ecosystem.config.cjs` whose `script` is `dist/index-daemon.js`. That
   * left a complete, executable, `#!/usr/bin/env node`-shebanged CLI in the tarball
   * whose module graph imports a package the manifest does not depend on.
   *
   * MEASURED on the real published botmux@3.18.8 — extracted, deps installed the way
   * a global install does (`--omit=dev`, so node-pty is absent):
   *   node dist/index-daemon.js
   *   → Fatal error: ERR_MODULE_NOT_FOUND: Cannot find package 'node-pty'
   *     imported from .../dist/adapters/backend/tmux-backend.js
   * which is verbatim the error users reported on 3.18.7/3.18.8. The compiled
   * binary in the platform subpackage embeds pty.node and is unaffected; only this
   * shipped-but-unrunnable second copy of the CLI can produce it.
   *
   * ⚠️ ASSERTED AGAINST REAL `npm pack` OUTPUT, not against the `files` array.
   * `files` is an input to a globbing/ignore-file algorithm, not the artifact: a
   * modelled reading of it can be green while the tarball differs. So this asks npm
   * itself what it would publish.
   */
  it('the PUBLISHED tarball ships no runnable Node form (the node-pty crash users hit)', () => {
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      encoding: 'utf-8',
      cwd: resolve('.'),
      timeout: 120_000,
    });
    // Never let an npm hiccup pass as "no dist/ in the tarball" — that is the
    // vacuous-green direction for a test whose whole job is an absence claim.
    expect(packed.error, `npm pack failed to run: ${packed.error?.message}`).toBeUndefined();
    expect(packed.status, `npm pack exited ${packed.status}: ${packed.stderr}`).toBe(0);
    const paths: string[] = JSON.parse(packed.stdout)[0].files.map((f: { path: string }) => f.path);
    // Proof the probe saw a real file list, so the absence assertions below have
    // something to be absent FROM.
    expect(paths).toContain('package.json');
    expect(paths).toContain('scripts/postinstall-bin.mjs');

    // No second CLI. These three are the entry points a stale `exec node <path>`
    // launcher, a systemd unit, or a hand-run `pm2 start` would land on.
    for (const entry of ['dist/cli.js', 'dist/index-daemon.js', 'dist/worker.js']) {
      expect(paths, `${entry} must not ship: it imports node-pty, which is not a dependency`).not.toContain(entry);
    }
    expect(paths.filter(p => p.startsWith('dist/'))).toEqual([]);
    // The pm2 ecosystem file names dist/index-daemon.js as its `script`. Nothing in
    // the source tree reads it (the supervisor replaced pm2), so its only remaining
    // effect is telling a human to start the broken form by hand.
    expect(paths).not.toContain('ecosystem.config.cjs');
  });

  it('declares no entry point that the tarball does not contain', () => {
    // `main`/`bin` pointing into a dist/ that no longer ships would be a manifest
    // that lies about itself: `require('botmux')` would resolve and then fail on a
    // missing file. The package is a CLI delivered as a compiled binary, so it has
    // no library entry point at all.
    expect(manifest.bin).toBeUndefined();
    expect(manifest.main).toBeUndefined();
  });

  it('ships the postinstall script in `files` (otherwise npm i -g fails hard)', () => {
    expect(manifest.scripts.postinstall).toBe('node scripts/postinstall-bin.mjs');
    // Verified by packing+installing a probe: a missing postinstall target is not
    // a warning, it is `npm error code 1` and the install aborts.
    const shipped = manifest.files.some(
      (f: string) => f === 'scripts/postinstall-bin.mjs' || f === 'scripts/' || f === 'scripts',
    );
    expect(shipped).toBe(true);
  });

  it('the file named in `files` actually exists on disk', () => {
    expect(existsSync(POSTINSTALL)).toBe(true);
  });

  it('ships the PATH helper too (postinstall imports it at install time)', () => {
    // ⚠️ Without this the whole suite stays green while the published tarball
    // silently regresses to "just print a PATH hint": the fixture copies the
    // helper in directly rather than consulting the manifest, and the
    // missing-helper case deliberately asserts fail-soft. So dropping this one
    // `files` line would reintroduce the exact npm bug this PR fixes.
    const helper = 'scripts/install-path-entry.mjs';
    const shipped = manifest.files.some(
      (f: string) => f === helper || f === 'scripts/' || f === 'scripts',
    );
    expect(shipped).toBe(true);
    expect(existsSync(resolve(helper))).toBe(true);
    // And postinstall must actually be the thing that pulls it in.
    expect(readFileSync(POSTINSTALL, 'utf-8')).toContain('./install-path-entry.mjs');
  });
});

describe('inject-optional-binaries — release-time version wiring', () => {
  /** Run the injector against a throwaway copy of a manifest. */
  function run(manifestVersion: string, argVersion: string) {
    const dir = tmp();
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'inject-optional-binaries.mjs'), readFileSync(INJECT));
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'botmux', version: manifestVersion }, null, 2)}\n`,
    );
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'inject-optional-binaries.mjs'), argVersion], {
      encoding: 'utf-8',
    });
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return { ...r, manifest: after };
  }

  it('injects all six platform packages pinned to the release version', () => {
    const { status, manifest } = run('3.20.0', '3.20.0');
    expect(status).toBe(0);
    // Six, not four: the two -musl entries are what give npm anything to select on
    // Alpine. Publishing the musl subpackages without listing them here leaves them
    // on the registry with nothing referencing them — npm never even considers them.
    expect(manifest.optionalDependencies).toEqual({
      'botmux-darwin-arm64': '3.20.0',
      'botmux-darwin-x64': '3.20.0',
      'botmux-linux-arm64': '3.20.0',
      'botmux-linux-arm64-musl': '3.20.0',
      'botmux-linux-x64': '3.20.0',
      'botmux-linux-x64-musl': '3.20.0',
    });
  });

  it('accepts a prerelease version (canary/beta/rc all publish this way)', () => {
    const { status, manifest } = run('3.20.0-canary.3', '3.20.0-canary.3');
    expect(status).toBe(0);
    expect(manifest.optionalDependencies['botmux-linux-x64']).toBe('3.20.0-canary.3');
  });

  it('refuses a leading "v" (the git tag carries one; passing it is an easy slip)', () => {
    const { status, stderr, manifest } = run('3.20.0', 'v3.20.0');
    expect(status).not.toBe(0);
    expect(stderr).toContain('invalid version');
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('refuses when package.json version was not synced first (steps out of order)', () => {
    // Guards against publishing a main package whose optional deps name a
    // different version than the package itself — npm would skip them silently.
    const { status, stderr, manifest } = run('0.0.0', '3.20.0');
    expect(status).not.toBe(0);
    expect(stderr).toContain('!==');
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('is idempotent (release re-runs must not drift)', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'inject-optional-binaries.mjs'), readFileSync(INJECT));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'botmux', version: '3.20.0' }, null, 2)}\n`);
    const script = join(dir, 'scripts', 'inject-optional-binaries.mjs');
    spawnSync(process.execPath, [script, '3.20.0'], { encoding: 'utf-8' });
    const first = readFileSync(join(dir, 'package.json'), 'utf-8');
    spawnSync(process.execPath, [script, '3.20.0'], { encoding: 'utf-8' });
    expect(readFileSync(join(dir, 'package.json'), 'utf-8')).toBe(first);
  });
});

describe('postinstall-bin — writes the launcher ONLY for a real global install', () => {
  /**
   * Build a fake installed-package tree and run the postinstall against an
   * isolated HOME. Never touches the real ~/.botmux (on a dev box that wrapper is
   * shared by every running daemon).
   */
  function runPostinstall(opts: {
    global?: string;
    withSubpackage?: boolean;
    sourceCheckout?: boolean;
    /** Omit scripts/install-path-entry.mjs, to prove the import is fail-soft. */
    withoutPathHelper?: boolean;
    /** Pretend binDir is already on the INSTALLING process's PATH. Note this must
     *  NOT suppress the startup-file write — see the test that pins it. */
    binDirOnPath?: boolean;
    /** $SHELL for the child, which decides WHICH startup file gets the PATH line. */
    shell?: string;
    /** Candidate exits non-zero even for --version (for libc/runtime rejection). */
    brokenBinary?: boolean;
    /** Existing shared launcher that a rejected update must preserve byte-for-byte. */
    existingLauncher?: string;
    /**
     * Place the fake package at this path RELATIVE to the tmp base, instead of
     * `pkg/`. Used to reproduce a package-manager global layout (bun/pnpm), which
     * is the only signal available when no `npm_config_*` is set at all.
     */
    pkgRelPath?: string;
    /** Ship dist/utils/global-install.js, which guard 1's location check imports. */
    withDistPredicate?: boolean;
    /** Run against an EXISTING home from a previous call, the way an upgrade does.
     *  Needed to exercise idempotence across two installs (the startup file has to
     *  survive between them, which a fresh tmp home cannot show). */
    reuseHome?: string;
  }) {
    const base = tmp();
    const home = opts.reuseHome ?? join(base, 'home');
    const pkg = join(base, opts.pkgRelPath ?? 'pkg');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(pkg, 'scripts'), { recursive: true });
    writeFileSync(join(pkg, 'scripts', 'postinstall-bin.mjs'), readFileSync(POSTINSTALL));
    // Guard 1's location check imports the repo's own layout classifier from
    // `dist/` (it ships via package.json `files`). That module has a small import
    // graph, so the fixture must carry ALL of it — a partial copy fails CLOSED and
    // would make this test pass for the wrong reason. Verified against a real
    // `bun add -g botmux` tree: all four files are present in the published package.
    if (opts.withDistPredicate) {
      for (const rel of [
        join('utils', 'global-install.js'),
        join('core', 'binary-install-shape.js'),
        join('core', 'self-spawn.js'),
        join('utils', 'install-info.js'),
      ]) {
        const dest = join(pkg, 'dist', rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(join(__dirname, '..', 'dist', rel)));
      }
    }
    // postinstall imports this sibling to write the PATH entry. It ships via
    // package.json `files`, so the fixture must carry it too — otherwise this
    // exercises a package layout we never publish. (`opts.withoutPathHelper`
    // deliberately omits it, to prove the import is fail-soft.)
    if (!opts.withoutPathHelper) {
      writeFileSync(
        join(pkg, 'scripts', 'install-path-entry.mjs'),
        readFileSync(join(__dirname, '..', 'scripts', 'install-path-entry.mjs')),
      );
    }
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'botmux', version: '3.20.0' }));

    if (opts.sourceCheckout) {
      mkdirSync(join(pkg, 'src'), { recursive: true });
      mkdirSync(join(pkg, '.git'), { recursive: true });
    }

    let binary = '';
    if (opts.withSubpackage !== false) {
      const sub = join(pkg, 'node_modules', `botmux-${process.platform}-${process.arch}`);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, 'package.json'), JSON.stringify({ name: `botmux-${process.platform}-${process.arch}`, version: '3.20.0' }));
      binary = join(sub, 'botmux');
      // Echoes argv so the launcher can be executed, not merely string-matched.
      writeFileSync(binary, opts.brokenBinary
        ? '#!/bin/sh\necho "GLIBC_2.34 not found" >&2\nexit 42\n'
        : '#!/bin/sh\nprintf "BINARY-GOT:%s\\n" "$@"\n', { mode: 0o755 });
      chmodSync(binary, 0o755);
    }

    const launcher = join(home, '.botmux', 'bin', 'botmux');
    if (opts.existingLauncher !== undefined) {
      mkdirSync(join(home, '.botmux', 'bin'), { recursive: true });
      writeFileSync(launcher, opts.existingLauncher, { mode: 0o755 });
    }

    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };
    if (opts.global !== undefined) env.npm_config_global = opts.global;
    if (opts.binDirOnPath) env.PATH = `${join(home, '.botmux', 'bin')}:${process.env.PATH}`;
    if (opts.shell) env.SHELL = opts.shell;

    const r = spawnSync(process.execPath, [join(pkg, 'scripts', 'postinstall-bin.mjs')], {
      encoding: 'utf-8',
      env,
    });
    return { ...r, launcher, binary, home, wrote: existsSync(launcher) };
  }

  it('global install → writes a launcher that execs the platform binary', () => {
    const r = runPostinstall({ global: 'true' });
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(true);
    const content = readFileSync(r.launcher, 'utf-8');
    expect(content).toBe(`#!/bin/sh\nexec "${realpathSync(r.binary)}" "$@"\n`);
    // No node anywhere — the binary is self-contained. `node` as a command word,
    // so a path merely containing "node" cannot produce a false pass.
    expect(content).not.toMatch(/(^|\s)node(\s|$)/m);
  });

  /**
   * PATH is the only thing that turns the launcher into a command (there is no
   * `bin` field), so these two cover the reported "installed fine, still
   * `command not found`" bug and its blast radius.
   */
  it('global install also puts binDir on PATH, in the file the user\'s shell reads', () => {
    const r = runPostinstall({ global: 'true', shell: '/usr/bin/zsh' });
    expect(r.status).toBe(0);
    // zsh reads .zshenv, NOT .profile — writing .profile was the original bug.
    const zshenv = join(r.home, '.zshenv');
    expect(existsSync(zshenv)).toBe(true);
    expect(readFileSync(zshenv, 'utf-8')).toContain(join(r.home, '.botmux', 'bin'));
    expect(existsSync(join(r.home, '.profile'))).toBe(false);
  });

  it('a missing PATH helper degrades to a hint — it must NOT fail the install', () => {
    // The launcher is already written by this point; aborting here would turn a
    // working install into a failed one over a cosmetic step.
    const r = runPostinstall({ global: 'true', withoutPathHelper: true });
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(true);
    expect(`${r.stdout}${r.stderr}`).toContain('PATH');
  });

  /**
   * WRITES THE STARTUP FILE EVEN WHEN binDir IS ALREADY ON THE INSTALLING SHELL'S
   * PATH — this replaces a test that asserted the opposite and thereby pinned a bug.
   *
   * The old contract ("touches no startup file when binDir is already on PATH") was
   * reasoned from upgrade noise: "an upgrade on a machine set up long ago must not
   * keep appending to rc files". The goal is right; the SIGNAL was wrong. It gated
   * on `process.env.PATH`, i.e. the PATH of the process running the install, while
   * what actually decides whether `botmux` works is whether the user's FUTURE shells
   * get it — a property of the startup FILE.
   *
   * Those come apart, and botmux itself pulls them apart: the daemon prepends
   * `~/.botmux/bin` to every CLI session's PATH (five `prependBotmuxBin` call sites
   * in worker.ts / worker-pool.ts). So `npm i -g botmux` run from inside a botmux
   * session hit the gate, wrote NOTHING, printed NOTHING, exited 0 — and since there
   * is no `bin` field to fall back on, the user's next terminal had no `botmux` at
   * all. That is the reported "3.18.8 更新之后找不到 botmux 命令", still reproducing
   * after `exec zsh -l` because the file the login shell reads was never written.
   *
   * Idempotence is still required — it is just enforced where the real answer lives:
   * `ensurePathEntry` consults `fileAlreadyHasEntry` per file (which also recognises
   * a line the user wrote by hand) and reports those as `skipped`. The next test
   * pins that, so "does not append twice" survives without the wrong gate.
   */
  it('writes the startup file even when the INSTALLING shell already has binDir on PATH', () => {
    const r = runPostinstall({ global: 'true', shell: '/usr/bin/zsh', binDirOnPath: true });
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(true);                        // launcher still written
    // The whole point: a transiently-correct PATH must not suppress the file that
    // makes it permanent.
    const zshenv = join(r.home, '.zshenv');
    expect(existsSync(zshenv), 'binDir on the installer PATH must not suppress the startup file').toBe(true);
    expect(readFileSync(zshenv, 'utf-8')).toContain(join(r.home, '.botmux', 'bin'));
    // And the user is told, so they know to open a new terminal.
    expect(r.stdout).toContain('open a new terminal');
  });

  it('does not append twice when the startup file already carries the entry', () => {
    // The idempotence the old PATH gate was reaching for, asserted on the signal
    // that actually governs it. Two installs in the SAME home: the second must
    // report `skipped` and leave exactly one marker line.
    const first = runPostinstall({ global: 'true', shell: '/usr/bin/zsh' });
    expect(first.status).toBe(0);
    const zshenv = join(first.home, '.zshenv');
    expect(existsSync(zshenv)).toBe(true);
    const markers = (text: string) => text.split('\n').filter(l => l.includes('# added by botmux installer')).length;
    expect(markers(readFileSync(zshenv, 'utf-8'))).toBe(1);

    // Re-run against the very same HOME (reuseHome), as an upgrade would.
    const second = runPostinstall({ global: 'true', shell: '/usr/bin/zsh', reuseHome: first.home });
    expect(second.status).toBe(0);
    expect(markers(readFileSync(zshenv, 'utf-8')), 'a re-install must not append a second PATH line').toBe(1);
    expect(second.stdout).toContain('already puts');
  });

  it('SOURCE PIN: the PATH step is not gated on the installing process\'s own PATH', () => {
    // Behavioural coverage above needs the fixture to stage binDir on PATH; this
    // pins the absence of the wrong predicate directly, so a re-add is caught even
    // if someone reshapes the fixture. `process.env.PATH` may legitimately appear
    // elsewhere in the file (it is passed through to the probe spawn), so match the
    // specific gate shape that caused the bug: a membership test of binDir in it.
    const src = readFileSync(POSTINSTALL, 'utf-8');
    const code = src.split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/process\.env\.PATH[^\n]*\.includes\(\s*binDir\s*\)/);
    expect(code).not.toMatch(/if\s*\(\s*!\s*\(?\s*process\.env\.PATH/);
  });

  it('the written launcher actually runs and preserves argument boundaries', () => {
    const r = runPostinstall({ global: 'true' });
    const run = spawnSync(r.launcher, ['send', 'hello world'], { encoding: 'utf-8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('BINARY-GOT:send\nBINARY-GOT:hello world\n');
  });

  it('rejects an unloadable candidate before changing the existing launcher', () => {
    const previous = '#!/bin/sh\necho PREVIOUS_WORKING_BOTMUX\n';
    const r = runPostinstall({
      global: 'true',
      brokenBinary: true,
      existingLauncher: previous,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('cannot run on this host');
    expect(r.stderr).toContain('GLIBC_2.34 not found');
    expect(readFileSync(r.launcher, 'utf-8')).toBe(previous);
  });

  it('npm_config_global ABSENT → writes nothing (this is `pnpm install` in the repo!)', () => {
    // THE dangerous case: a repo-local `pnpm install` DOES run the root
    // postinstall, and npm_config_global is absent (not "false"). A `!== "false"`
    // guard would fire here and repoint the shared global launcher.
    const r = runPostinstall({});
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(false);
  });

  it('npm_config_global="false" → writes nothing', () => {
    const r = runPostinstall({ global: 'false' });
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(false);
  });

  it('THE bun/pnpm BUG: a global LAYOUT with no npm_config_* still writes the launcher', () => {
    // REGRESSION for a shipped defect: bun (and pnpm) pass NO `npm_config_*` to
    // lifecycle scripts, so `npm_config_global` is absent for a perfectly real
    // `bun add -g botmux`. The env-only guard exited 0 silently and wrote nothing —
    // MEASURED end to end on a real `bun add -g botmux@3.18.8`: `.bun/bin/` empty,
    // no launcher, the platform binary only in the download cache, so the user had
    // NO `botmux` command at all. And `bun pm -g trust botmux` did NOT rescue it:
    // bun reported `1 script ran` while this script still wrote nothing.
    //
    // Note `global` is deliberately NOT set — that is the whole point.
    const r = runPostinstall({
      pkgRelPath: join('home', '.bun', 'install', 'global', 'node_modules', 'botmux'),
      withDistPredicate: true,
    });
    expect(r.status).toBe(0);
    expect(r.wrote, r.stderr).toBe(true);
    expect(readFileSync(r.launcher, 'utf-8')).toBe(`#!/bin/sh\nexec "${realpathSync(r.binary)}" "$@"\n`);
  });

  it('SAFETY: a LOCAL dependency install is not mistaken for a global one', () => {
    // The counterweight to the case above. `node_modules/botmux` in someone's
    // project must never repoint the shared launcher — that is the hijack the
    // strict env guard existed to prevent, and the location check must not reopen
    // it. The classifier requires a RECOGNISED GLOBAL layout, not merely a
    // `/node_modules/botmux` suffix.
    const r = runPostinstall({
      pkgRelPath: join('proj', 'node_modules', 'botmux'),
      withDistPredicate: true,
    });
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(false);
  });

  it('THE PUBLISHED SHAPE: works with NO dist/ present, because that is what npm ships', () => {
    // This case previously asserted the opposite ("fail-closed when dist/ is
    // missing"), which encoded the very defect: the check imported
    // `dist/utils/global-install.js`, #1115 removed `dist/` from package.json
    // `files`, so in the real published package the import ENOENTed and the guard
    // fell back to env-only — `bun add -g botmux` stayed broken while the suite was
    // green. The layout list is inlined now, so the published shape (no dist/ at
    // all) MUST work. Verified end to end against a real `npm pack` tarball
    // installed with `bun add -g`.
    const r = runPostinstall({
      pkgRelPath: join('home', '.bun', 'install', 'global', 'node_modules', 'botmux'),
      withDistPredicate: false, // ← exactly what the registry serves
    });
    expect(r.status).toBe(0);
    expect(r.wrote, r.stderr).toBe(true);
  });

  it('inside a source checkout (.git + src/) → writes nothing even when global', () => {
    const r = runPostinstall({ global: 'true', sourceCheckout: true });
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(false);
  });

  it('missing platform subpackage → FAILS the install (there is no Node fallback)', () => {
    // This used to assert exit 0 ("warns but does not abort npm i -g"), which was
    // correct while `bin: {botmux: "dist/cli.js"}` gave every failure a Node path to
    // land on. That fallback was removed (it forced node-pty — and a node-gyp
    // toolchain — into every install), so exiting 0 here would leave the user with a
    // `botmux` command that does not exist and no hint why.
    const r = runPostinstall({ global: 'true', withSubpackage: false });
    expect(r.status).not.toBe(0);
    expect(r.wrote).toBe(false);
    expect(r.stderr).toContain('no prebuilt binary package');
    // The old hint claimed Node still works. It must not come back.
    expect(r.stderr).not.toContain('still works via Node');
    // Windows users need WSL, not a Node install.
    expect(r.stderr).toContain('WSL2');
  });

  it('SOURCE PIN: no `bin` field — that entry point IS the Node fallback', () => {
    // Removing the runtime deps while leaving `bin` wired is the worst combination:
    // the fallback still resolves and then dies on `require('node-pty')`. Pin the
    // absence so a well-meaning re-add is caught here.
    //
    // ⚠️ `bin` was never the only way in. The tarball also shipped `dist/` itself,
    // so a stale `exec node "<root>/dist/cli.js"` launcher left behind by a
    // pre-#1047 install reached the same unrunnable CLI with no `bin` involved —
    // that is the crash users hit on 3.18.7/3.18.8. `dist/` is out of `files` now
    // (asserted against real `npm pack` output above); keep BOTH pins.
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf-8')) as {
      bin?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(manifest.bin).toBeUndefined();
    // node-pty must be a devDependency and NOTHING else. It has an `install` script
    // and ships no linux prebuild, so ANY placement an end user's install would honor
    // (`dependencies` OR `optionalDependencies`) makes npm run node-gyp — measured:
    // `npm i` then compiles pty.node from source on every machine with a compiler.
    // Nobody needs it installed: the single-file binary embeds pty.node at compile
    // time, and the desktop runtime gets it by copy (prepare-desktop-runtime.mjs).
    expect(manifest.dependencies?.['node-pty'], 'node-pty must not be a hard dependency').toBeUndefined();
    expect(manifest.optionalDependencies?.['node-pty'], 'node-pty must not be optional either — npm still runs its install script').toBeUndefined();
    expect(manifest.devDependencies?.['node-pty'], 'node-pty must stay a devDependency (build-bun-binary.mjs resolves it)').toBeTruthy();
    // canvas is the opposite case: no install script (never compiles), and the
    // desktop tree needs `--cpu '*'` to pull both darwin arches, which only works for
    // a dependency `bun install --production` actually installs. Optional fits.
    expect(manifest.dependencies?.['@napi-rs/canvas'], '@napi-rs/canvas must not be a hard dependency').toBeUndefined();
    expect(manifest.optionalDependencies?.['@napi-rs/canvas'], '@napi-rs/canvas must be optional (--production keeps optional, drops dev)').toBeTruthy();
  });

  /**
   * musl detection, driven through the REAL script rather than an extracted copy.
   *
   * Why this deserves tests at all: a false POSITIVE blocks every ordinary glibc
   * install, which is worse than the silent-Alpine-failure it prevents. It was only
   * hand-verified before, so any future "cleanup" of the fs probes would go unnoticed.
   *
   * The script probes `/lib` and `/usr/lib` for `ld-musl-*`, which a test cannot
   * fabricate — so exercise the branch by pointing the script's readdirSync at a
   * fake root via a tiny loader shim, and pin the negative direction (this box is
   * glibc) directly.
   */
  function runPostinstallWithFakeRoot(muslDir: string | null) {
    const base = tmp();
    const home = join(base, 'home');
    const pkg = join(base, 'pkg');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(pkg, 'scripts'), { recursive: true });

    // Rewrite the two probe paths to a directory we control. This keeps the real
    // decision logic (order, short-circuit, try/catch) under test — only the
    // filesystem it looks at is redirected.
    //
    // The glibc short-circuit must also be neutralised: this test box DOES report
    // glibcVersionRuntime, so the function would return false before ever reaching
    // the probe and the fixture could not exercise it. Replacing the report read
    // with `undefined` simulates "running on a musl Node" (measured on
    // node:22-alpine: the header carries no glibc field), which is precisely the
    // situation where the loader probe is the deciding signal.
    const fakeLib = join(base, 'fakelib');
    mkdirSync(fakeLib, { recursive: true });
    if (muslDir) writeFileSync(join(fakeLib, muslDir), '');
    let src = readFileSync(POSTINSTALL, 'utf-8')
      .replace("for (const dir of ['/lib', '/usr/lib'])", `for (const dir of ['${fakeLib}'])`)
      .replace("existsSync('/etc/alpine-release')", 'false')
      .replaceAll('process.platform', "'linux'")
      .replaceAll('process.arch', "'x64'");
    src = src.replace(
      'if (process.report?.getReport?.()?.header?.glibcVersionRuntime) return false;',
      'if (undefined) return false;',
    );
    writeFileSync(join(pkg, 'scripts', 'postinstall-bin.mjs'), src);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'botmux', version: '3.20.0' }));

    const r = spawnSync(process.execPath, [join(pkg, 'scripts', 'postinstall-bin.mjs')], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, HOME: home, npm_config_global: 'true' },
    });
    return { ...r, wrote: existsSync(join(home, '.botmux', 'bin', 'botmux')) };
  }

  it('musl: an ld-musl loader present → looks for the -musl subpackage', () => {
    // INVERTED from the previous contract. This used to assert a hard refusal
    // ("glibc-linked and cannot run on musl"), which was correct only while no musl
    // binary existed. musl subpackages now ship, so refusing would block the very
    // platform we added; instead the lookup must agree with what npm installed —
    // npm selects by each subpackage's `libc` field, so on Alpine that is the
    // `-musl` name.
    const r = runPostinstallWithFakeRoot('ld-musl-x86_64.so.1');
    // The fixture stages the plain (glibc) subpackage only, so resolution fails —
    // but the point is WHICH name it looked for.
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('botmux-linux-x64-musl');
    // The old lie must not come back.
    expect(r.stderr).not.toContain('cannot run on musl');
  });

  it('musl: no loader present → does NOT claim musl (the false-positive direction)', () => {
    // Same fixture with the report short-circuit removed, so the ONLY thing that
    // could claim musl is the probe — and with an empty fake root it must not.
    // This is the direction that matters most: a false positive blocks every
    // ordinary glibc install.
    const r = runPostinstallWithFakeRoot(null);
    expect(r.stderr).not.toContain('glibc-linked');
    // It still fails (no platform subpackage in this fixture), but for the OTHER
    // reason — proving the musl branch was not taken.
    expect(r.stderr).toContain('no prebuilt binary package');
  });

  it.skipIf(process.platform !== 'linux')('glibc short-circuit: a reported glibc runtime settles it before any probe', () => {
    // Unmodified script on this (glibc) box: even though the real /lib may contain
    // anything, glibcVersionRuntime is present so musl must never be claimed.
    expect(process.report.getReport().header.glibcVersionRuntime).toBeTruthy();
    const r = runPostinstall({ global: 'true', withSubpackage: false });
    expect(r.stderr).not.toContain('glibc-linked');
  });

  it('SOURCE PIN: musl detection keeps both signals (report negative + loader probe)', () => {
    // Strip comments first: the surrounding docblock deliberately MENTIONS the
    // rejected `header.musl` idea, and matching prose instead of code would make
    // this assertion fire on its own explanation.
    const code = readFileSync(POSTINSTALL, 'utf-8')
      .split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    // glibcVersionRuntime is used ONLY as a negative signal. Measured on
    // node:22-alpine: the header has 23 keys and carries no musl key at all, so a
    // positive musl branch on the report would be dead code.
    expect(code).toContain('glibcVersionRuntime');
    expect(code).not.toMatch(/header\??\.\s*musl/);
    // The loader probe is what actually decides on Alpine — it must not be removed.
    expect(code).toContain("startsWith('ld-musl-')");
  });

  it('SOURCE PIN: the guard is a STRICT === "true" comparison', () => {    // Behavioral tests above would still pass with `!== "false"` in some shells'
    // env handling, so pin the actual comparison. This is the single line that
    // protects a shared HOME's global launcher.
    const src = readFileSync(POSTINSTALL, 'utf-8');
    expect(src).toContain("process.env.npm_config_global !== 'true'");
    expect(src).not.toContain("!== 'false'");
  });

  it('SOURCE PIN: the location check is SELF-CONTAINED (no dist/ import — it is not published)', () => {
    // The first version of this guard imported `dist/utils/global-install.js` to
    // reuse the repo classifier. That was DEAD CODE in the published package: #1115
    // removed `dist/` from package.json `files`, so the import always ENOENTed, the
    // catch returned false, and the guard fell back to env-only — leaving
    // `bun add -g` exactly as broken as before. Pin that this file never again
    // depends on anything outside its own published set.
    const code = readFileSync(POSTINSTALL, 'utf-8')
      .split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    // `./install-path-entry.mjs` is the ONLY sibling it may import — that one ships.
    const imports = [...code.matchAll(/import\s*\(?\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const spec of imports) {
      if (spec.startsWith('node:')) continue;
      expect(spec, `postinstall must not import ${spec} — check package.json files`)
        .toBe('./install-path-entry.mjs');
    }
    expect(code).not.toContain('dist/');
    // …and the guard actually consults the location check, not merely defines it.
    expect(code).toMatch(/npm_config_global !== 'true'[\s\S]{0,60}locationSaysGlobal/);
  });

  it('PARITY: the inlined layout list agrees with detectGlobalInstallManager on real global paths', () => {
    // The inlined copy is a SECOND implementation of the same rules, which is how
    // two answers drift apart. Rather than trusting a comment, execute both over a
    // matrix of layouts that actually occur and require the same verdict.
    //
    // Extract the inlined predicate from the shipped script and run it for real, so
    // this cannot pass by merely finding similar-looking source text.
    const src = readFileSync(POSTINSTALL, 'utf-8');
    const fn = src.match(/function locationSaysGlobal\(root\) \{[\s\S]*?\n\}/)?.[0];
    expect(fn, 'locationSaysGlobal not found in postinstall').toBeTruthy();
    // eslint-disable-next-line no-new-func
    const inlined = new Function(`${fn}; return locationSaysGlobal;`)() as (r: string) => boolean;

    const GLOBAL_LAYOUTS = [
      '/usr/lib/node_modules/botmux',
      '/usr/local/lib/node_modules/botmux',
      '/root/.bun/install/global/node_modules/botmux',
      '/root/.local/share/pnpm/global/5/.pnpm/botmux@3.18.9/node_modules/botmux',
      '/root/.local/share/pnpm/global/5/node_modules/botmux',
      '/root/.local/share/pnpm/global/v11/abc/node_modules/botmux',
      '/root/.local/share/pnpm/store/v11/links/@/botmux/3.18.9/x/node_modules/botmux',
    ];
    for (const p of GLOBAL_LAYOUTS) {
      expect(inlined(p), `inlined said NOT global: ${p}`).toBe(true);
      expect(detectGlobalInstallManager(p, 'linux'), `classifier said unknown: ${p}`)
        .not.toBe('unknown');
    }

    const NON_GLOBAL = [
      '/app/node_modules/botmux',                  // a local dependency
      '/root/iserver/botmux',                      // a source checkout
      '/app/node_modules/other/node_modules/botmux',
      '/home/u/.botmux/bin',                       // the launcher dir, not a package
    ];
    for (const p of NON_GLOBAL) {
      expect(inlined(p), `inlined claimed global: ${p}`).toBe(false);
      expect(detectGlobalInstallManager(p, 'linux'), `classifier claimed known: ${p}`)
        .toBe('unknown');
    }
  });

  it('STRICTER THAN THE CLASSIFIER: a Windows LOCAL dependency must not count as global', () => {
    // `detectGlobalInstallManager` ends with `platform === 'win32' ? 'npm' : 'unknown'`,
    // so on Windows it cannot distinguish a global install from a local dependency —
    // MEASURED: detectGlobalInstallManager('C:/projects/myapp/node_modules/botmux',
    // 'win32') === 'npm'. That is harmless where it is used today (a wrong
    // `npm i -g` just reinstalls), but in postinstall it would let a Windows LOCAL
    // dependency repoint the shared ~/.botmux/bin/botmux — the exact hijack guard 1
    // exists to prevent. So the inlined version has NO platform fallback.
    const src = readFileSync(POSTINSTALL, 'utf-8');
    const fn = src.match(/function locationSaysGlobal\(root\) \{[\s\S]*?\n\}/)?.[0]!;
    // eslint-disable-next-line no-new-func
    const inlined = new Function(`${fn}; return locationSaysGlobal;`)() as (r: string) => boolean;

    const winLocal = 'C:/projects/myapp/node_modules/botmux';
    // The divergence is deliberate: document it by asserting BOTH sides.
    expect(detectGlobalInstallManager(winLocal, 'win32')).toBe('npm'); // the hazard
    expect(inlined(winLocal)).toBe(false);                             // we refuse it
    expect(inlined('C:\\projects\\myapp\\node_modules\\botmux')).toBe(false); // backslashes too
    // A real Windows npm global is unaffected: it arrives with npm_config_global=true
    // and never reaches this check, which the behavioural test above covers.
  });
});
