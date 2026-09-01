import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The musl (Alpine) binary is a SHIPPED artifact whose native differs from every
 * other platform's: `pty.node` is embedded at compile time and node-pty has no
 * linux prebuild, so it is compiled against whatever libc the builder runs on. A
 * glibc native inside a musl binary builds cleanly and fails only when the native
 * is dlopen'd — on the user's machine.
 *
 * That artifact was originally gated ONLY in release.yml, which runs on tag push.
 * So a PR could change the build script, the embed plugin, or node-pty's version
 * and the musl leg was first exercised during a release, after npm had published.
 * ci.yml now carries a musl job too.
 *
 * WHAT THESE TESTS DEFEND: not the YAML's shape, but the claim "the PR gate is not
 * weaker than the release gate for musl". Every assertion below corresponds to a
 * step whose removal would leave CI green while silently un-gating musl:
 *   • no musl job at all              → back to release-only discovery
 *   • builds a non-musl target        → gates the wrong artifact
 *   • no readelf linkage check        → a glibc native ships inside a musl binary
 *   • no smoke run                    → compiles but never executes it (and the
 *     smoke run is what proves the native LOADS — see the dlopen note below)
 *
 * Deliberately parsed as text rather than YAML: the assertions are about specific
 * commands being present, and a text match cannot be satisfied by a structurally
 * valid file that runs something else.
 */

const CI = readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf-8');
const RELEASE = readFileSync(resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf-8');

/** Strip `#` comments so a claim can never be satisfied by prose ABOUT the claim.
 *  (A comment mentioning `--target bun-linux-x64-musl` would otherwise pass an
 *  assertion that the job actually builds that target.) */
const stripComments = (yaml: string) => yaml
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
  .join('\n');

const CI_CODE = stripComments(CI);
const RELEASE_CODE = stripComments(RELEASE);

describe('ci.yml — the musl artifact is gated on PRs, not only at release', () => {
  it('defines a musl binary job', () => {
    expect(CI_CODE).toMatch(/^ {2}bun-binary-musl:/m);
  });

  // ── MECHANISM vs MEANS ───────────────────────────────────────────────────────
  // A cautionary note earned the hard way. The FIRST version of this suite asserted
  //     expect(CI_CODE).toMatch(/container:\s*node:22-alpine/)
  // which was green, and went red when mutated — "has teeth" by the usual test. But
  // `container:` WAS the P0: on an arm64 runner it makes actions/checkout fail
  // outright, and v3.18.0-canary.4's release died on it. That assertion had locked
  // the defect in as the expected shape, so fixing the bug REQUIRED reversing it.
  //
  // Reverse-mutation cannot catch this: an assertion pinning a wrong implementation
  // is indistinguishable from one pinning a right one — both go red when deleted.
  // The lesson is to assert the INVARIANT (the build happens on musl, and we prove
  // the native is musl-linked) rather than the MEANS of achieving it. The means-level
  // checks below are kept deliberately, but only as labelled REGRESSION PINS for one
  // specific known-bad implementation — never as the primary guarantee.

  it('MECHANISM: builds in a musl environment and proves the native is musl-linked', () => {
    // Implementation-agnostic on purpose: satisfied by `docker run`, by a job-level
    // container on an all-x64 matrix, or by a future musl-capable runner. What it
    // does NOT tolerate is compiling the musl target on glibc, which is the actual
    // hazard — `pty.node` is embedded at build time and would be the wrong libc.
    const job = CI_CODE.slice(CI_CODE.indexOf('bun-binary-musl:'));

    // A musl ENVIRONMENT, and note carefully why this is not just /musl/: the word
    // "musl" also appears in `--target bun-linux-x64-musl`, so a bare /alpine|musl/
    // is satisfied by a job that compiles the musl target on plain glibc — the exact
    // hazard. (Measured: against that shape, a bare /alpine|musl/ PASSES.) Match an
    // actual musl image reference instead.
    expect(job).toMatch(/(?:container:\s*|docker run[\s\S]{0,400}?)[\w./:-]*alpine/);

    // The linkage must be PROVEN, not assumed. This is the load-bearing assertion:
    // it is what rejects the glibc-built-musl shape, because the workflow's own
    // readelf gate then fails closed at build time on a native lacking libc.musl.
    expect(job).toMatch(/readelf[\s\S]*libc/);

    expect(job).toContain('--target bun-linux-x64-musl');     // the musl artifact
  });

  it('REGRESSION PIN: no job-level container (arm64 cannot run JS actions in one)', () => {
    // Not the mechanism — one known-bad way of achieving it. GitHub refuses:
    //   "JavaScript Actions in Alpine containers are only supported on x64 Linux
    //    runners. Detected Linux Arm64"
    // The x64 leg was unaffected, which is precisely why this PR gate stayed green
    // while the release's arm64-musl leg died before a single build step ran.
    const job = CI_CODE.slice(CI_CODE.indexOf('bun-binary-musl:'));
    const jobHeader = job.slice(0, job.indexOf('steps:'));
    expect(jobHeader).not.toMatch(/^\s*container:/m);
  });

  it('REGRESSION PIN: does NOT pin --platform (would emulate the wrong arch)', () => {
    // Also a means-level pin. `--platform` would pull a foreign-arch image under
    // qemu and embed a native for the WRONG architecture — the same class of defect
    // as cross-compiling from glibc, reached by a different route.
    const job = CI_CODE.slice(CI_CODE.indexOf('bun-binary-musl:'));
    expect(job).not.toContain('--platform');
  });

  it('EXECUTES the musl binary through the shared smoke script', () => {
    // Running it is what proves the embedded native loads: dist/cli.js statically
    // imports node-pty (via the backends) and node-pty dlopens the native at
    // MODULE scope. Verified by mutation — corrupting the embedded pty.node makes
    // the smoke script die on its FIRST check with ERR_DLOPEN_FAILED, before any
    // check passes. So "the binary ran at all" already covers dlopen.
    expect(CI_CODE).toMatch(/node scripts\/smoke-bun-binary\.mjs dist-bin\/botmux-linux-x64-musl/);
  });

  it('uses the SAME smoke script as the release musl leg (no weaker PR gate)', () => {
    // Parity is the actual invariant. If the release leg ever moves to a stronger
    // script, this catches a PR gate left behind on the old one.
    expect(RELEASE_CODE).toContain('scripts/smoke-bun-binary.mjs');
    expect(CI_CODE).toContain('scripts/smoke-bun-binary.mjs');
  });

  it('stamps a version BEFORE compiling (or the smoke version check cannot pass)', () => {
    // Compiled mode has no package.json on disk, so the version is baked at build
    // time; the repo's 0.0.0 placeholder is treated as "nothing baked" and yields
    // the `unknown` sentinel the smoke script rejects. Order matters: `npm version`
    // must also come AFTER `bun install`, since --frozen-lockfile must see the
    // committed package.json.
    const job = CI_CODE.slice(CI_CODE.indexOf('bun-binary-musl:'));
    const install = job.indexOf('bun install --frozen-lockfile');
    const version = job.indexOf('npm version');
    const compile = job.indexOf('--target bun-linux-x64-musl');
    expect(install).toBeGreaterThan(-1);
    expect(version).toBeGreaterThan(install);
    expect(compile).toBeGreaterThan(version);
  });
});

describe('release.yml — the musl legs stay wired into the publish chain', () => {
  it('still builds BOTH musl arches (ci.yml only canaries x64)', () => {
    // The PR gate deliberately covers one arch (arm64 needs a separate, slower
    // runner). The release must not quietly shrink to match it.
    expect(RELEASE_CODE).toContain('bun-linux-x64-musl');
    expect(RELEASE_CODE).toContain('bun-linux-arm64-musl');
  });

  it('gates the publish jobs on the musl job (else musl subpackages ship unbuilt)', () => {
    // `binary-subpackages` packs the artifacts into npm tarballs. If it does not
    // need the musl job, a musl subpackage could publish without its binary —
    // and npm treats a missing optional dep as a silent no-op.
    const subpackages = RELEASE_CODE.slice(RELEASE_CODE.indexOf('binary-subpackages:'));
    const needsLine = subpackages.slice(0, subpackages.indexOf('runs-on'));
    expect(needsLine).toContain('bun-binaries-musl');
  });

  it('MECHANISM: each musl leg builds on musl and proves the linkage', () => {
    // Implementation-agnostic, like its ci.yml counterpart: what must hold is that
    // the musl artifacts are built in a musl environment with the linkage verified,
    // not that any particular container mechanism is used. Same caveat as there —
    // an alpine IMAGE reference, not a bare /musl/ which the target name satisfies.
    const job = RELEASE_CODE.slice(RELEASE_CODE.indexOf('bun-binaries-musl:'));
    expect(job).toMatch(/(?:container:\s*|docker run[\s\S]{0,400}?)[\w./:-]*alpine/);
    expect(job).toMatch(/readelf[\s\S]*libc/);
  });

  it('REGRESSION PIN: musl legs carry no job-level container (arm64 breaks in one)', () => {
    // THE REGRESSION THIS PINS, and it is not hypothetical: v3.18.0-canary.4's
    // release failed here. With `container: node:22-alpine`, the arm64-musl leg
    // died at actions/checkout ("JavaScript Actions in Alpine containers are only
    // supported on x64 Linux runners"), before a single build step ran. Because
    // `binary-subpackages` and `release` both need this job, the entire publish
    // chain skipped — correctly, but the release produced nothing.
    //
    // Reverting to a job-level container would break arm64 again while leaving the
    // x64 PR gate green, which is exactly how it slipped through the first time.
    const job = RELEASE_CODE.slice(RELEASE_CODE.indexOf('bun-binaries-musl:'));
    const header = job.slice(0, job.indexOf('steps:'));
    expect(header).not.toMatch(/^\s*container:/m);
    expect(job).toContain('docker run');
  });

  it('hands dist-bin back to the host user (Checksums writes INTO it)', () => {
    // THE REGRESSION THIS PINS — v3.18.0-canary.5, and note where it struck: both
    // musl legs BUILT and smoke-PASSED, then `Checksums` died with
    //   dist-bin/botmux-linux-arm64-musl.sha256: Permission denied
    // The container runs as root, `-v` bind mounts share the host inode without
    // remapping ownership, and the runner host user (uid 1001) cannot create files
    // inside a root-owned directory. A job-level `container:` never had this problem
    // because GitHub ran every step as the same user — so the problem was INTRODUCED
    // by moving to `docker run`, and only bites steps that WRITE into dist-bin.
    //
    // Asserted on both workflows even though ci.yml has no step after the container:
    // that asymmetry is how this shipped. Keeping the legs isomorphic means the PR
    // gate exercises the same ownership handoff the release depends on.
    for (const code of [RELEASE_CODE, CI_CODE]) {
      const marker = code.includes('bun-binaries-musl:') ? 'bun-binaries-musl:' : 'bun-binary-musl:';
      const job = code.slice(code.indexOf(marker));
      expect(job).toMatch(/chown -R "\$HOST_UID:\$HOST_GID" dist-bin/);
      // The ids must actually be passed in, or the chown expands to `:` and fails.
      expect(job).toMatch(/-e HOST_UID="\$\(id -u\)" -e HOST_GID="\$\(id -g\)"/);
    }
  });

  it('ci.yml PROVES the host can write into dist-bin, not just that chown is present', () => {
    // The chown assertion above is a source pin: it cannot tell whether the chown
    // actually achieves anything. And CI's own musl job has no step that writes into
    // dist-bin, so a broken chown would leave this gate green — the same structural
    // blindness that let canary.5 ship (the release leg writes there, the PR leg
    // did not). ci.yml therefore carries an explicit host-side write, and it must
    // CREATE a file (sha256sum > file), because read access was never the problem.
    const job = CI_CODE.slice(CI_CODE.indexOf('bun-binary-musl:'));
    const afterContainer = job.slice(job.lastIndexOf('chown -R'));
    expect(afterContainer).toMatch(/sha256sum[\s\S]*>/);
  });
});
