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

/** First Bun version known to write a valid darwin ad-hoc signature (#39837). */
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
