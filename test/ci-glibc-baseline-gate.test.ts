import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The Linux glibc FLOOR is a shipped-artifact property that nothing in the
 * packaging metadata can express.
 *
 * `pty.node` is embedded into the binary at compile time and node-pty has no linux
 * prebuild, so it is compiled against whatever glibc the BUILDER runs. When
 * `ubuntu-latest` moved to 24.04 the shipped floor silently rose to GLIBC_2.34 —
 * nothing failed at build time, nothing failed on the runner, and the binary died
 * at dlopen on any host older than that (Debian 10 / CentOS 8, both still inside
 * Node 22's own glibc 2.28 support window).
 *
 * Two properties therefore have to hold, and neither is visible in a normal test:
 *   1. PRODUCTION: Linux binaries are built on glibc 2.28 and the embedded native's
 *      highest required GLIBC symbol is asserted before it can be published.
 *   2. PARITY: the PR gate exercises the same boundary as release, so a floor
 *      regression is caught on the PR that causes it rather than after publish.
 *
 * WHAT THESE TESTS DEFEND: not the YAML's shape, but the claim "a Linux release
 * cannot ship a native whose glibc floor exceeds 2.28, and the PR gate proves it".
 * Every assertion corresponds to a change that would leave the rest of the suite
 * green while silently un-gating the floor:
 *   • ci.yml stops using the baseline builder  → back to release-only discovery
 *   • release.yml stops using it (e.g. every
 *     `glibc_baseline` blanked back to '')     → Linux ships from ubuntu-latest
 *                                                again, which is THIS bug
 *   • the readelf floor assertion goes away    → builds on 2.28 but no longer
 *                                                proves what it produced
 *   • the built binary is never executed       → compiles but the native is never
 *                                                dlopen'd, and dlopen is the
 *                                                failure mode
 *
 * MEASURED, and the reason this file exists: blanking all three `glibc_baseline`
 * values in release.yml reverts Linux releases to the broken path, and the 27
 * install/release/binary suites stay at 471/471 green.
 *
 * Deliberately parsed as text rather than YAML, and with comments stripped: the
 * assertions are about specific commands being present, and neither a structurally
 * valid file that runs something else nor prose ABOUT the gate can satisfy them.
 *
 * Sibling suite: test/ci-musl-gate.test.ts guards the structurally identical
 * "wrong libc embedded in a shipped native" hazard for musl. Its MECHANISM vs MEANS
 * note applies here too — assert the invariant (built on the floor, floor proven,
 * binary executed), not the means (docker, manylinux, a particular image).
 */

const CI = readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf-8');
const RELEASE = readFileSync(resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf-8');
const BUILDER = readFileSync(resolve(import.meta.dirname, '../scripts/build-linux-glibc-baseline.sh'), 'utf-8');

/** Strip `#` comments so a claim can never be satisfied by prose ABOUT the claim. */
const stripComments = (text: string) => text
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
  .join('\n');

const CI_CODE = stripComments(CI);
const RELEASE_CODE = stripComments(RELEASE);
const BUILDER_CODE = stripComments(BUILDER);

/** The floor is a single number in three places; drift between them is the hazard. */
const FLOOR = '2.28';

describe('scripts/build-linux-glibc-baseline.sh — the floor is built AND proven', () => {
  it('MECHANISM: refuses to build unless the environment really is the floor', () => {
    // Without this the script is just "build somewhere and hope": a bumped image
    // tag, or a local run on the dev box, would produce a higher-floor native while
    // every log line still said "glibc baseline". The assertion is that the runtime
    // libc is CHECKED, not that any particular image supplies it.
    //
    // ANCHOR THE FLOOR TO THE CHECK ITSELF, not to the file (measured): a bare
    // `toContain('glibc 2.28')` is satisfied by the REFUSING **message** and by the
    // header comment, so weakening the comparison to `grep -q "glibc 2"` — which
    // accepts 2.9, 2.17, 2.29, anything — left all 10 assertions green. Requiring
    // the literal to appear in the matcher invocation that follows `getconf` closes
    // that, while still tolerating a different matcher (grep/awk) or extra flags.
    expect(BUILDER_CODE).toMatch(
      new RegExp(`getconf GNU_LIBC_VERSION[\\s\\S]{0,200}?(?:grep|awk)[^\\n]*glibc ${FLOOR.replace('.', '\\.')}`),
    );
  });

  it('MECHANISM: asserts the embedded native does not exceed the floor', () => {
    // THE load-bearing assertion. Building on 2.28 makes the right native *likely*;
    // reading the symbol versions back out of the artifact is what makes it PROVEN.
    // (`libc: glibc` in npm metadata cannot express this, which is the whole reason
    // the floor regressed unnoticed.)
    expect(BUILDER_CODE).toMatch(/readelf[\s\S]*GLIBC_/);
    expect(BUILDER_CODE).toMatch(/pty\.node/);
    // The comparison must be against the floor, and must FAIL CLOSED. Anchor on the
    // refusal, not on the arithmetic: `sort -V` is one valid way to compare, and
    // pinning it would be a means-level assertion.
    expect(BUILDER_CODE).toMatch(/REFUSING[\s\S]*GLIBC_2\.28|GLIBC_2\.28[\s\S]{0,200}exit 1/);
  });

  it('EXECUTES the binary it produced, in the same environment', () => {
    // Compiling proves the native was found; only RUNNING it proves the native
    // loads. dist/cli.js statically imports node-pty through the backends and
    // node-pty dlopens at module scope, so "the binary ran at all" already covers
    // dlopen — which is precisely the failure this suite exists for.
    expect(BUILDER_CODE).toMatch(/smoke-bun-binary\.mjs/);
  });

  it('the floor assertion runs BEFORE the artifact leaves the container', () => {
    // Order is the difference between a gate and a report. If readelf ran after the
    // binary were copied out, a bad native could still reach /out.
    //
    // ANCHOR CAREFULLY (measured): the first `/out/` in this file is the `docker run
    // -v "$out_dir:/out"` mount argument, which sits near the TOP — above readelf.
    // An assertion using indexOf('/out/') therefore compares against the mount, not
    // the copy, and stays green when the readelf block is moved after the copy (the
    // exact defect this test names). Anchor on the copy command itself.
    const readelfAt = BUILDER_CODE.indexOf('readelf');
    const copyOut = BUILDER_CODE.search(/cp\s+"dist-bin\/\$OUTPUT_NAME"/);
    expect(readelfAt).toBeGreaterThan(-1);
    expect(copyOut, 'the copy-out command was not found — re-anchor this test').toBeGreaterThan(-1);
    expect(copyOut).toBeGreaterThan(readelfAt);
  });
});

describe('ci.yml — the glibc floor is gated on PRs, not only at release', () => {
  it('the Linux binary job builds through the baseline builder', () => {
    // Not "a job exists": the job must route through the floor-enforcing builder.
    // A `bun scripts/build-bun-binary.mjs` straight on ubuntu-latest is the shape
    // that shipped GLIBC_2.34, and it would satisfy any weaker assertion.
    const job = CI_CODE.slice(CI_CODE.indexOf('\n  bun-binary:'));
    const jobOnly = job.slice(0, job.indexOf('\n  bun-binary-musl:'));
    expect(jobOnly).toContain('scripts/build-linux-glibc-baseline.sh');
  });

  it('PARITY: the PR gate and the release use the SAME builder script', () => {
    // The actual invariant. Parity is what stops the PR gate from being left behind
    // on a weaker path while the release moves on (or vice versa).
    expect(CI_CODE).toContain('scripts/build-linux-glibc-baseline.sh');
    expect(RELEASE_CODE).toContain('scripts/build-linux-glibc-baseline.sh');
  });
});

describe('release.yml — every Linux leg stays on the floor', () => {
  it('THE REGRESSION THIS PINS: no Linux leg builds off the baseline path', () => {
    // MEASURED: blanking the three `glibc_baseline` values reverts Linux releases to
    // ubuntu-latest — this exact bug — with 471/471 unrelated tests still green.
    //
    // Asserted per-leg rather than "the string appears somewhere", because the file
    // also contains the darwin leg (which legitimately has no floor) and the musl
    // legs. A single occurrence proves nothing about the leg that ships glibc x64.
    const job = RELEASE_CODE.slice(RELEASE_CODE.indexOf('\n  bun-binaries:'));
    const matrix = job.slice(job.indexOf('include:'), job.indexOf('runs-on:'));

    for (const target of ['bun-linux-x64', 'bun-linux-arm64']) {
      // Each linux target's matrix entry must carry the floor. Entries are separated
      // by `- os:`, so slice the one that names this target.
      const entries = matrix.split(/-\s+os:/).filter((e) => e.includes(target));
      expect(entries, `no matrix entry builds ${target}`).toHaveLength(1);
      // Quote-agnostic on purpose: '2.28', "2.28" and bare 2.28 are the same YAML
      // value, so pinning one style would fail a correct file (measured — an earlier
      // version of this assertion went red on `"2.28"`). What must hold is that the
      // value is the floor and is NOT empty.
      expect(entries[0], `${target} is not pinned to the glibc floor`)
        .toMatch(new RegExp(`glibc_baseline:\\s*['"]?${FLOOR.replace('.', '\\.')}['"]?\\s*$`, 'm'));
    }
  });

  it('darwin is deliberately NOT on the glibc path (it has no glibc)', () => {
    // Guards the opposite error: a blanket floor would send macOS through a Linux
    // container. Documents that the empty value is intentional, so a future reader
    // does not "fix" it into '2.28'.
    const job = RELEASE_CODE.slice(RELEASE_CODE.indexOf('\n  bun-binaries:'));
    const matrix = job.slice(job.indexOf('include:'), job.indexOf('runs-on:'));
    const darwin = matrix.split(/-\s+os:/).filter((e) => e.includes('bun-darwin'));
    expect(darwin).toHaveLength(1);
    expect(darwin[0]).toMatch(/glibc_baseline:\s*''/);
  });

  it('the two build paths are mutually exclusive (no leg builds twice or zero times)', () => {
    // The legs are selected by `if: matrix.glibc_baseline == ''` / `!= ''`. If both
    // guards were ever written the same way, a linux leg would either run the
    // ubuntu-latest compile as well (shipping whichever artifact landed last) or run
    // neither and publish nothing.
    const job = RELEASE_CODE.slice(RELEASE_CODE.indexOf('\n  bun-binaries:'));
    expect(job).toMatch(/if:\s*matrix\.glibc_baseline == ''/);
    expect(job).toMatch(/if:\s*matrix\.glibc_baseline != ''/);
  });

  it('the glibc legs still feed the publish chain (else Linux ships unbuilt)', () => {
    // `binary-subpackages` packs these artifacts into the npm subpackages. npm treats
    // a missing optional dep as a silent no-op, so an unbuilt linux artifact does not
    // fail the publish — it produces a botmux that has no binary on Linux.
    const subpackages = RELEASE_CODE.slice(RELEASE_CODE.indexOf('binary-subpackages:'));
    const needsLine = subpackages.slice(0, subpackages.indexOf('runs-on'));
    expect(needsLine).toContain('bun-binaries');
  });
});
