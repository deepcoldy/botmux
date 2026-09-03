#!/usr/bin/env bun
/**
 * `bun run verify:binary` — compile the host-arch single-file binary and smoke it.
 *
 * WHY THIS EXISTS: local development runs `node dist/*.js` (source form) 100% of
 * the time, while users run a `bun build --compile` executable where `__dirname`
 * is the virtual `/$bunfs/root`. Every divergence between those forms is
 * therefore invisible locally. Four have shipped: the Dashboard 404ing every
 * request (88e3d7f24), `setup` throwing `找不到 botmux lark-scopes.json`
 * (2ef5c3a58), `--version` printing `unknown` (c6b88e376), and the daemon
 * replacing its own binary with a 47-byte stub (8386f34dd).
 *
 * Compiling turned out to be nearly free — MEASURED 0.9s, against 36s for the
 * `tsc` build it consumes — so the reason nobody verified the compiled form
 * locally was never cost, it was that no single command did it. This is that
 * command. It is deliberately NOT a git hook: CI's `bun-binary` job (MEASURED
 * 72s) and `bun-binary-musl` (87s) already gate every push in parallel with the
 * 612s test job, so a local hook would buy about a minute at the cost of 28s on
 * every push.
 *
 * TWO FRICTIONS IT REMOVES, both hit while doing this by hand:
 *
 *   1. HOST TARGET ONLY, enforced. Cross-compiling looks like it works and does
 *      not: `resolveNodePtyNative()` falls back to the local
 *      `build/Release/pty.node` for every linux target, and node-pty ships no
 *      linux prebuild. VERIFIED — `--target bun-linux-arm64` on this x64 box
 *      exits 0 and produces a real aarch64 ELF with the x86-64 `pty.node` baked
 *      in; it fails at PTY spawn, not at build. (And the host cannot even exec
 *      it: qemu-aarch64 is registered but `/lib/ld-linux-aarch64.so.1` is
 *      absent.) musl is worse still — it MUST be compiled on musl or the wrong
 *      libc gets embedded. So this refuses anything but the host target and says
 *      why, instead of handing over a binary that is silently broken.
 *
 *   2. A REAL VERSION. `versionToBake()` reads package.json, which carries the
 *      placeholder `0.0.0` outside a release; the runtime treats that as "not
 *      baked", so smoke check 1b fails on `unknown` — VERIFIED, that is exactly
 *      what a hand-run hits. CI sidesteps it by stamping a synthetic version
 *      first (ci.yml's "Stamp a synthetic version" step). Rather than making a
 *      developer mutate package.json, this passes the version through the same
 *      `define` the build already supports, via BOTMUX_VERIFY_BAKED_VERSION.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

if (typeof Bun === 'undefined') {
  console.error('verify:binary must run under Bun (`bun run verify:binary`) — the compile step uses Bun.build.');
  process.exit(2);
}

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');

/** The only target this machine can both compile correctly and execute. */
const hostPlatform = process.platform === 'darwin' ? 'darwin' : 'linux';
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const hostTarget = `bun-${hostPlatform}-${hostArch}`;

const requested = argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : hostTarget;
if (requested !== hostTarget) {
  console.error(
    `❌ verify:binary only supports the host target (${hostTarget}); refusing ${requested}.\n\n`
    + 'Cross-compiled binaries from this box are silently broken, not merely untested:\n'
    + '  • node-pty has no linux prebuild, so every linux target embeds THIS machine\'s\n'
    + `    build/Release/pty.node (${hostArch}) — the mismatch surfaces at PTY spawn, not at build time.\n`
    + '  • a musl binary must be compiled ON musl or it links the wrong libc.\n'
    + '  • the host cannot exec a foreign-arch binary anyway, so smoke could not run.\n\n'
    + `Those targets are covered by CI: the \`bun-binary\` job builds ${hostTarget} and\n`
    + '`bun-binary-musl` builds the musl legs inside an Alpine container. Push and let them run.',
  );
  process.exit(2);
}

/**
 * A version to bake. `git describe` mirrors what release.yml stamps from the tag;
 * falling back to a marker keeps the smoke's "not the unknown sentinel" check
 * meaningful in a shallow clone or a tarball with no git metadata.
 */
function localVersion() {
  const r = spawnSync('git', ['describe', '--tags', '--always', '--dirty'], { cwd: REPO_ROOT, encoding: 'utf-8' });
  const described = r.status === 0 ? r.stdout.trim().replace(/^v/, '') : '';
  return described || '0.0.0-local';
}

const DIST = join(REPO_ROOT, 'dist');
if (!existsSync(join(DIST, 'cli.js'))) {
  console.error('❌ dist/cli.js missing — run `bun run build` first (the compile step bundles dist, it does not run tsc).');
  process.exit(2);
}

const outDir = join(REPO_ROOT, 'dist-bin');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `botmux-${hostPlatform}-${hostArch}`);

const version = localVersion();
console.log(`▶ compiling ${hostTarget} (version=${version}) …`);

const compileStart = Date.now();
const compile = spawnSync(
  process.execPath,
  [join(REPO_ROOT, 'scripts', 'build-bun-binary.mjs'), '--target', hostTarget, '--out', out],
  { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, BOTMUX_VERIFY_BAKED_VERSION: version } },
);
if (compile.status !== 0) {
  console.error(`❌ compile failed (exit ${compile.status}).`);
  process.exit(1);
}
console.log(`  compiled in ${((Date.now() - compileStart) / 1000).toFixed(1)}s → ${out}`);

console.log('▶ smoke-testing the compiled binary …');
const smokeStart = Date.now();
// Run the SAME script CI runs, so a local pass and a CI pass mean the same thing.
// It is a Node script by design (an outside observer testing a Bun-built binary).
const smoke = spawnSync('node', [join(REPO_ROOT, 'scripts', 'smoke-bun-binary.mjs'), out], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});
const smokeSecs = ((Date.now() - smokeStart) / 1000).toFixed(1);

if (!keep) {
  try { rmSync(out); } catch { /* best effort — a 170MB artifact, not worth failing over */ }
}

if (smoke.status !== 0) {
  console.error(`\n❌ smoke failed after ${smokeSecs}s. The binary is broken in a way `
    + 'source-form development cannot show; fix before pushing.');
  process.exit(1);
}

console.log(`\n✅ compiled form verified in ${smokeSecs}s of smoke`
  + `${keep ? ` (binary kept at ${out})` : ''}.`);
if (!keep) console.log('   Pass --keep to retain the binary (e.g. for `bun run use:here --binary`).');
