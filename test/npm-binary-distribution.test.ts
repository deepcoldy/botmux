import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

  it('injects all four platform packages pinned to the release version', () => {
    const { status, manifest } = run('3.20.0', '3.20.0');
    expect(status).toBe(0);
    expect(manifest.optionalDependencies).toEqual({
      'botmux-darwin-arm64': '3.20.0',
      'botmux-darwin-x64': '3.20.0',
      'botmux-linux-arm64': '3.20.0',
      'botmux-linux-x64': '3.20.0',
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
  }) {
    const base = tmp();
    const home = join(base, 'home');
    const pkg = join(base, 'pkg');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(pkg, 'scripts'), { recursive: true });
    writeFileSync(join(pkg, 'scripts', 'postinstall-bin.mjs'), readFileSync(POSTINSTALL));
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
      writeFileSync(binary, '#!/bin/sh\nprintf "BINARY-GOT:%s\\n" "$@"\n', { mode: 0o755 });
      chmodSync(binary, 0o755);
    }

    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };
    if (opts.global !== undefined) env.npm_config_global = opts.global;

    const r = spawnSync(process.execPath, [join(pkg, 'scripts', 'postinstall-bin.mjs')], {
      encoding: 'utf-8',
      env,
    });
    const launcher = join(home, '.botmux', 'bin', 'botmux');
    return { ...r, launcher, binary, wrote: existsSync(launcher) };
  }

  it('global install → writes a launcher that execs the platform binary', () => {
    const r = runPostinstall({ global: 'true' });
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(true);
    const content = readFileSync(r.launcher, 'utf-8');
    expect(content).toBe(`#!/bin/sh\nexec "${r.binary}" "$@"\n`);
    // No node anywhere — the binary is self-contained. `node` as a command word,
    // so a path merely containing "node" cannot produce a false pass.
    expect(content).not.toMatch(/(^|\s)node(\s|$)/m);
  });

  it('the written launcher actually runs and preserves argument boundaries', () => {
    const r = runPostinstall({ global: 'true' });
    const run = spawnSync(r.launcher, ['send', 'hello world'], { encoding: 'utf-8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('BINARY-GOT:send\nBINARY-GOT:hello world\n');
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

  it('inside a source checkout (.git + src/) → writes nothing even when global', () => {
    const r = runPostinstall({ global: 'true', sourceCheckout: true });
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(false);
  });

  it('missing platform subpackage → warns but EXITS 0 (a throw aborts npm i -g)', () => {
    const r = runPostinstall({ global: 'true', withSubpackage: false });
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(false);
    expect(r.stderr).toContain('no prebuilt binary package');
  });

  it('SOURCE PIN: the guard is a STRICT === "true" comparison', () => {
    // Behavioral tests above would still pass with `!== "false"` in some shells'
    // env handling, so pin the actual comparison. This is the single line that
    // protects a shared HOME's global launcher.
    const src = readFileSync(POSTINSTALL, 'utf-8');
    expect(src).toContain("process.env.npm_config_global !== 'true'");
    expect(src).not.toContain("!== 'false'");
  });
});
