#!/usr/bin/env node
/**
 * Release-time injection of the platform-binary `optionalDependencies` into the
 * MAIN package's package.json, immediately before `npm pack`/`publish`.
 *
 * ── WHY THIS IS NOT JUST CHECKED INTO package.json ─────────────────────────────
 * Two independent reasons, both measured rather than assumed:
 *
 * 1. `bun install --frozen-lockfile` would fail on every CI job. Adding the four
 *    entries to package.json without regenerating bun.lock produces:
 *      error: lockfile had changes, but lockfile is frozen
 *    Verified by reproducing it in a scratch package. Every workflow in this repo
 *    installs with --frozen-lockfile, so a committed-but-unlocked optional dep
 *    turns the whole pipeline red.
 *
 * 2. The versions must equal the release version, and `npm version` does NOT
 *    rewrite dependency ranges — verified: bumping a package to 9.9.9 left its
 *    `optionalDependencies` pinned at "0.0.0". Since the subpackages are published
 *    at the tag's version, a committed "0.0.0" would point at a version that never
 *    exists, npm would silently skip the optional dep (that is what optional
 *    means), and the launcher would find no binary — the exact silent degradation
 *    this whole change exists to remove.
 *
 * Injecting at release time solves both: the lockfile never sees these entries,
 * and the version is whatever the tag says. `npm pack` picks up the mutation from
 * disk (verified: the four entries and the synced version appear inside the packed
 * tarball's package/package.json).
 *
 * Idempotent: running twice with the same version is a no-op.
 *
 *   usage: node scripts/inject-optional-binaries.mjs <version>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (!version) {
  throw new Error('usage: node scripts/inject-optional-binaries.mjs <version>');
}
// Guard the shape: a malformed version (e.g. a stray "v" prefix, which is easy to
// pass by accident since the git tag carries one) would publish a main package
// whose optional deps resolve to nothing.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`invalid version ${JSON.stringify(version)} (expected X.Y.Z or X.Y.Z-tag.N, no leading "v")`);
}

/** The four platform subpackages, matching packages/binary-<platform>-<arch>/. */
export const PLATFORM_PACKAGES = [
  'botmux-darwin-arm64',
  'botmux-darwin-x64',
  'botmux-linux-arm64',
  'botmux-linux-x64',
];

const manifestPath = join(repoRoot, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

if (manifest.version !== version) {
  // The release workflow runs `npm version` before this script, so a mismatch
  // means the steps ran out of order — fail loudly rather than publish a main
  // package whose optional deps point at a different version than itself.
  throw new Error(
    `package.json version (${manifest.version}) !== requested ${version}; `
    + 'run the version-sync step before injecting.',
  );
}

const optional = {};
for (const name of PLATFORM_PACKAGES) optional[name] = version;
manifest.optionalDependencies = { ...manifest.optionalDependencies, ...optional };

// Trailing newline: npm writes one, so keeping it avoids a spurious diff.
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[release] injected optionalDependencies @ ${version}:`);
for (const name of PLATFORM_PACKAGES) console.log(`[release]   ${name}@${version}`);
