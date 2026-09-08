import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * botmux 3.18.14's darwin-arm64 binary shipped with an INVALID ad-hoc Mach-O
 * signature. Bun 1.4.0's `bun build --compile` hashed the last partial page
 * zero-padded and left stale signature bytes past the new one (oven-sh/bun#39764,
 * fixed in #39837 → 1.4.1). Every release gate stayed green because the macos-14
 * runner tolerated the bad signature and ran the binary anyway; macOS 27 SIGKILLs
 * it before main(), which is all `botmux upgrade` saw (exit 137).
 *
 * Two gates now exist, and this suite is what keeps them from quietly vanishing —
 * the repo has no workflow lint, so a deleted step is first noticed after a tag
 * has already published (see ci-musl-gate.test.ts for the same reasoning):
 *   • release.yml verifies EVERY darwin binary with `codesign --verify --strict`
 *     (the smoke step only executes the host arch; the cross-built one is not run)
 *   • scripts/smoke-bun-binary.mjs checks the signature before anything else on
 *     darwin, so the PR gate and the release gate agree
 *   • the build Bun is pinned to a version that carries the fix, and every pin in
 *     the repo agrees with package.json's `packageManager`
 *
 * Parsed as text, comments stripped, so prose ABOUT the gate can never satisfy an
 * assertion that the gate exists.
 */

const root = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');

const stripHashComments = (src: string) => src
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
  .join('\n');
const stripJsComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n');

const RELEASE = stripHashComments(read('.github/workflows/release.yml'));
const CI = stripHashComments(read('.github/workflows/ci.yml'));
const GLIBC_SH = stripHashComments(read('scripts/build-linux-glibc-baseline.sh'));
const SMOKE = stripJsComments(read('scripts/smoke-bun-binary.mjs'));
const BUILD = stripJsComments(read('scripts/build-bun-binary.mjs'));
const PKG = JSON.parse(read('package.json')) as { packageManager?: string };

/** The step body from its `- name:` line up to the next step. */
function step(yaml: string, name: string): string {
  const start = yaml.indexOf(`- name: ${name}`);
  if (start < 0) return '';
  const rest = yaml.slice(start + 1);
  const next = rest.search(/\n\s*- name: /);
  return rest.slice(0, next < 0 ? undefined : next);
}

const semver = (v: string) => v.split('.').map(Number) as [number, number, number];
const gte = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
};

/** First Bun version known to write a valid darwin ad-hoc signature (#39837).
 *  A FLOOR, not the pin: package.json may be ahead (it is — 1.4.2), and this
 *  only has to stay at or below it. Deliberately NOT bumped in lockstep, so the
 *  assertion below keeps testing "the pin carries the fix" instead of restating
 *  whatever the pin currently happens to be.
 *  ⚠️ ONLY for the HOST arch — see the build-bun-binary.mjs suite below: 1.4.1
 *  still writes an invalid signature when cross-compiling darwin-x64, and 1.4.2
 *  re-measured identically, so this pin is necessary but NOT sufficient. */
const FIRST_GOOD_BUN = '1.4.1';

describe('release.yml — every darwin binary is codesign-verified before it ships', () => {
  const verify = step(RELEASE, 'Verify Mach-O signatures on every darwin binary');

  it('has the verification step', () => {
    expect(verify).not.toBe('');
  });

  it('runs codesign --verify --strict (strict is what newer macOS enforces)', () => {
    // Anchored to the start of a line so the EXECUTED command must carry --strict.
    // An `echo "codesign --verify --strict $f"` progress line is not a comment and
    // survives stripHashComments; without the anchor it satisfied this assertion
    // while the real invocation had dropped --strict — the exact parameter that
    // separates "rejects 3.18.14's bad signature" from "lets it through".
    expect(verify).toMatch(/^\s*codesign --verify --strict/m);
  });

  it('iterates ALL darwin outputs, not just the host arch the smoke step runs', () => {
    expect(verify).toMatch(/for f in dist-bin\/botmux-darwin-\*/);
  });

  it('fails closed when no darwin binary is present (found=0 → exit 1)', () => {
    // A glob that matches nothing must not turn into a silent pass.
    expect(verify).toMatch(/found=0/);
    expect(verify).toMatch(/\[ "\$found" = 0 \][\s\S]*exit 1/);
  });

  it('skips sourcemap/checksum siblings so a .map file cannot fail (or pass for) the binary', () => {
    // `sourcemap: 'linked'` emits botmux-darwin-<arch>.map next to the binary.
    expect(verify).toMatch(/\*\.map/);
  });

  it('is scoped to the macOS leg (codesign does not exist on Linux runners)', () => {
    expect(verify).toMatch(/runner\.os == 'macOS'/);
  });

  it('runs BEFORE the smoke step in the same job', () => {
    const smokeIdx = RELEASE.indexOf('- name: Smoke-test the host-arch binary');
    const verifyIdx = RELEASE.indexOf('- name: Verify Mach-O signatures on every darwin binary');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(smokeIdx).toBeGreaterThan(verifyIdx);
  });
});

describe('smoke-bun-binary.mjs — the shared smoke checks the signature first on darwin', () => {
  it('verifies with codesign --strict when running on darwin', () => {
    expect(SMOKE).toMatch(/process\.platform === 'darwin'/);
    expect(SMOKE).toMatch(/execFileSync\('codesign', \['--verify', '--strict'/);
  });

  it('treats a bad signature as a hard failure', () => {
    expect(SMOKE).toMatch(/fail\('codesign'/);
  });

  it('does not let a live fleet leak into the scratch fleet through inherited env', () => {
    // Measured: run from inside a botmux session, the smoke supervisor inherited
    // BOTMUX_DAEMON_IPC_PORT (the real daemon) and BOTS_CONFIG (the real registry).
    expect(SMOKE).toMatch(/startsWith\('BOTMUX_'\)/);
    expect(SMOKE).toMatch(/'BOTS_CONFIG'/);
    expect(SMOKE).toMatch(/'SESSION_DATA_DIR'/);
  });
});

describe('build-bun-binary.mjs — re-signs darwin output, because the bun pin is not enough', () => {
  /**
   * MEASURED on the v3.19.0 release run (bun 1.4.1 on the macos-14 runner):
   *   botmux-darwin-arm64: valid on disk                                   ← native
   *   botmux-darwin-x64: invalid signature (code or signature have been modified)
   *   In architecture: x86_64
   *
   * Reproduced locally with bun 1.4.1 by parsing the CodeDirectory and recomputing
   * the page hashes (no macOS required). A bare `bun build --compile` of a two-line
   * hello-world — no repo plugin, no dist/cli.js — shows the same split, so the
   * defect is upstream, not something this repo's native-embed plugin causes:
   *   plain hello → bun-darwin-arm64: VALID   (15095/15095 page hashes)
   *   plain hello → bun-darwin-x64:   INVALID (2/16792 mismatch, incl. slot 0)
   * The x64 CodeDirectory also stops early — codeLimit 68776432 vs signature start
   * 94548464 — leaving ~25 MB outside the signed range.
   *
   * oven-sh/bun#39837 is titled "fix invalid ad-hoc code signature on
   * darwin-arm64" and its test only compiles --target=bun-darwin-arm64; nothing
   * upstream covers x86_64. So bumping the pin again does NOT close this, and
   * these assertions exist so nobody deletes the re-sign after reading
   * "we're already on 1.4.2".
   *
   * RE-MEASURED the same way when the pin moved 1.4.1 → 1.4.2 (1.4.0 as a
   * control, so the check is known to discriminate between versions):
   *   1.4.0 → arm64 INVALID (1/15483)      x64 INVALID (2/17124)
   *   1.4.2 → arm64 VALID   (15075/15075)  x64 INVALID (2/16792, incl. slot 0)
   * Identical split to 1.4.1: the x64 cross-compile cell is still broken.
   */
  it('ad-hoc re-signs with codesign --force --sign -', () => {
    // #39764 reports --remove-signature and BUN_NO_CODESIGN_MACHO_BINARY=1 as NOT
    // working; --force re-signing is the fix confirmed there.
    expect(BUILD).toMatch(/codesign', '--force', '--sign', '-'/);
  });

  it('verifies its own output with --strict, so a bad signature fails the build', () => {
    expect(BUILD).toMatch(/codesign', '--verify', '--strict'/);
  });

  it('throws when signing or verification fails (never warns and continues)', () => {
    expect(BUILD).toMatch(/throw new Error\(`ad-hoc codesign failed/);
    expect(BUILD).toMatch(/throw new Error\(`codesign --verify --strict failed/);
  });

  it('signs on the darwin TARGET, not merely when the host happens to be macOS', () => {
    // The bug is arch-specific and cross-compiled, so keying off the target is
    // what makes darwin-x64 (built on an arm64 runner) get re-signed at all.
    expect(BUILD).toMatch(/if \(platform === 'darwin'\) adhocResignDarwin\(outfile\)/);
  });

  it('degrades to a warning when a darwin target is cross-built off macOS', () => {
    // codesign is macOS-only. release.yml builds darwin on macos-14, so the
    // shipped path always signs; `--all` on a Linux dev box must still work.
    expect(BUILD).toMatch(/process\.platform !== 'darwin'/);
    expect(BUILD).toMatch(/cannot ad-hoc sign/);
  });

  it('re-signs both darwin arches rather than special-casing x64', () => {
    // Idempotent, and keeps working if the arch-conditional upstream bug moves.
    expect(BUILD).not.toMatch(/=== 'x64'[\s\S]{0,80}codesign/);
  });
});

describe('ci.yml — darwin is gated on PRs, not only at release', () => {
  /**
   * Until this job existed, `darwin`/`macos` appeared ZERO times in ci.yml, so the
   * signature failure path was reachable only in a release run — which is how both
   * incidents escaped: 3.18.14 shipped an unrunnable darwin-arm64 binary, and
   * v3.19.0 burned a tag on the cross-built darwin-x64 with no Release behind it.
   *
   * Following the MECHANISM vs MEANS note in ci-musl-gate.test.ts: what must hold
   * is that CI compiles the darwin artifacts on macOS and verifies their signatures
   * with the same strictness the release does — not that any particular job name or
   * runner label is used.
   */
  const job = (() => {
    const start = CI.indexOf('bun-binary-darwin:');
    return start < 0 ? '' : CI.slice(start);
  })();

  it('defines a darwin binary job', () => {
    expect(CI).toMatch(/^ {2}bun-binary-darwin:/m);
  });

  it('MECHANISM: runs on macOS (codesign exists nowhere else)', () => {
    // A linux runner cannot invoke codesign at all, so a darwin job scheduled
    // there could only ever compile — never verify.
    expect(job).toMatch(/runs-on:\s*macos-/);
  });

  it('compiles BOTH darwin arches, since the defect lives in the cross-built one', () => {
    // The v3.19.0 failure was darwin-x64 on an arm64 runner while the native
    // arm64 output was valid on the same run. Building only the host arch would
    // reproduce exactly the blind spot that let it ship.
    expect(job).toContain('bun-darwin-x64');
    expect(job).toContain('bun-darwin-arm64');
  });

  it('THE LOAD-BEARING GATE: codesign --verify --strict, iterating every darwin output', () => {
    // Anchored to line start for the same reason as the release.yml assertion
    // above: an `echo` of the command is not a comment and survives comment
    // stripping, so an unanchored match can be satisfied while the executed
    // command has dropped --strict.
    expect(job).toMatch(/^\s*codesign --verify --strict/m);
    expect(job).toMatch(/for f in dist-bin\/botmux-darwin-\*/);
  });

  it('fails closed when no darwin binary is present (found=0 → exit 1)', () => {
    expect(job).toMatch(/found=0/);
    expect(job).toMatch(/\[ "\$found" = 0 \][\s\S]*exit 1/);
  });

  it('skips .map/.sha256 siblings (codesign rejects a non-Mach-O file)', () => {
    expect(job).toMatch(/\*\.map/);
  });

  it('proves each output is really the arch it is named after', () => {
    // Without this the signature verdict can be VACUOUS: if --target were ignored
    // or the native fell back to the host prebuild, both outputs would be native
    // arm64, codesign would pass them both (native signing was never broken), and
    // the job would be green while darwin-x64 users got an unexecutable binary.
    expect(job).toMatch(/lipo -archs/);
    expect(job).toMatch(/x86_64/);
    // Must fail closed, not merely print the mismatch.
    expect(job).toMatch(/REFUSING[\s\S]{0,200}exit 1/);
  });

  it('EXECUTES the host-arch binary through the shared smoke script', () => {
    // Running it is what proves the embedded darwin native LOADS: node-pty dlopens
    // pty.node at module scope and needs its macOS spawn-helper sidecar, which no
    // linux leg can exercise.
    expect(job).toMatch(/node scripts\/smoke-bun-binary\.mjs/);
  });

  it('stamps a version BEFORE compiling (or the smoke version check cannot pass)', () => {
    // Same ordering constraint as the musl leg: `npm version` must come after
    // install (--frozen-lockfile must see the committed manifest) and before the
    // compile that bakes the value in, else the binary reports the `unknown`
    // sentinel the smoke script rejects.
    const install = job.indexOf('bun install --frozen-lockfile');
    const version = job.indexOf('npm version');
    const compile = job.indexOf('bun scripts/build-bun-binary.mjs');
    expect(install).toBeGreaterThan(-1);
    expect(version).toBeGreaterThan(install);
    expect(compile).toBeGreaterThan(version);
  });

  it('PARITY: the PR gate uses the same builder and smoke script as the release', () => {
    // Parity is the actual invariant — it is what stops the PR gate from being
    // left behind on a weaker path when the release moves on, or vice versa.
    for (const src of [CI, RELEASE]) {
      expect(src).toContain('scripts/build-bun-binary.mjs');
      expect(src).toContain('scripts/smoke-bun-binary.mjs');
    }
  });

  it('tracks the release runner ARCH, so the cross-compiled cell stays covered', () => {
    // Not cosmetic: the defect only exists when darwin-x64 is CROSS-built, which
    // requires an arm64 (Apple silicon) runner — macos-13 is x64 and would make
    // x64 the native output and arm64 the cross-built one. The verify loop covers
    // both, so the gate stays correct either way, but drifting away from the
    // release's runner means CI stops exercising the cell that actually ships.
    const releaseDarwin = RELEASE.split(/-\s+os:/).filter((e) => e.includes('bun-darwin'));
    expect(releaseDarwin).toHaveLength(1);
    const releaseRunner = releaseDarwin[0].match(/^\s*(macos-[\w.]+)/)?.[1];
    expect(releaseRunner, 'could not read the release darwin runner — re-anchor this test').toBeDefined();
    expect(job).toMatch(new RegExp(`runs-on:\\s*${releaseRunner!.replace(/\./g, '\\.')}`));
  });
});

describe('Bun pin — carries the darwin codesign fix and is consistent everywhere', () => {
  const pinned = PKG.packageManager?.match(/^bun@(\d+\.\d+\.\d+)$/)?.[1];

  it('package.json pins a bun version', () => {
    expect(pinned).toBeDefined();
  });

  it(`is at least ${FIRST_GOOD_BUN} (1.4.0 writes an invalid darwin signature)`, () => {
    expect(gte(pinned!, FIRST_GOOD_BUN)).toBe(true);
  });

  it('every setup-bun and npm-installed bun in the workflows uses the same version', () => {
    const versions = new Set<string>();
    for (const src of [RELEASE, CI, GLIBC_SH]) {
      for (const m of src.matchAll(/bun-version:\s*(\d+\.\d+\.\d+)/g)) versions.add(m[1]);
      for (const m of src.matchAll(/bun@(\d+\.\d+\.\d+)/g)) versions.add(m[1]);
    }
    expect(versions.size).toBeGreaterThan(0);
    expect([...versions]).toEqual([pinned]);
  });

  it('the release compile matrix actually installs the pinned bun', () => {
    // Belt and braces for the line that matters most: the job that emits the
    // darwin binaries. A pin drifting only here is exactly the 3.18.14 shape.
    const compileJob = RELEASE.slice(RELEASE.indexOf('bun-binaries:'));
    expect(compileJob).toMatch(new RegExp(`bun-version:\\s*${pinned!.replace(/\./g, '\\.')}`));
  });
});
