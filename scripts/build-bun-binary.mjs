#!/usr/bin/env bun
// Build a self-contained botmux single-file executable with `bun build --compile`.
// RUN WITH BUN (uses the programmatic Bun.build API + a build plugin):
//   bun scripts/build-bun-binary.mjs [--target bun-linux-x64] [--out <path>] [--all]
//
// WHY: botmux ships on npm and needs a specific Node runtime on PATH. Users with
// two Node versions installed end up with two competing global `botmux` installs
// that shadow each other and update independently. A single Bun-compiled binary
// bundles the runtime + all JS + native addons, so distribution becomes "download
// one file, run it" with no Node on the machine.
//
// THE HARD PART — native addons: `bun --compile` only auto-embeds a `.node` that
// is *statically* `require()`d. botmux's native deps load theirs via dynamic /
// relative paths that don't survive compilation, so we rewrite their loaders at
// build time via a Bun plugin (bun-native-embed-plugin.mjs):
//   • node-pty — VERIFIED end-to-end on linux-x64: the compiled binary spawns a
//     real PTY when run from a directory with no node_modules. On macOS node-pty
//     also needs a `spawn-helper` sidecar; linux uses forkpty() and does not.
//   • @napi-rs/canvas (card PNG rendering, non-critical) — honors
//     NAPI_RS_NATIVE_LIBRARY_PATH; handled by the runtime bootstrap the plugin
//     injects. Absent native → card render degrades, daemon still runs.
//
// PREREQ: `bun run build` first — this bundles from dist/ (the same artifact npm
// ships); it does NOT recompile TypeScript.
//
// MATRIX: --all cross-compiles darwin/linux × arm64/x64. Only the host-arch
// binary is smoke-tested locally; the rest are verified by CI on native runners
// (.github/workflows/release.yml `bun-binaries`). Windows is excluded — the
// daemon is Unix-only (PTY/tmux/pm2).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeNativeEmbedPlugin } from './bun-native-embed-plugin.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Compile targets for the botmux fleet. Kept in sync with release.yml.
//
// The `-musl` variants exist because Alpine (and most slim Docker images) link
// against musl libc, where a glibc-linked binary does not run at all — it dies in
// the loader with an error that names no cause. npm selects the right one on its
// own: each platform subpackage declares `libc: ["musl"] | ["glibc"]` (undocumented
// in `npm help package-json` but live in the wild, e.g. @napi-rs/canvas ships both).
//
// ⚠️ A musl binary MUST be compiled on musl: `pty.node` is embedded at build time,
// and node-pty has no linux prebuild, so the builder compiles it against whatever
// libc it is running on (verified: glibc box → `NEEDED libc.so.6`, Alpine container
// → `NEEDED libc.musl-x86_64.so.1`). release.yml therefore runs the musl legs inside
// an Alpine container — cross-compiling them from a glibc runner would embed the
// wrong native and fail at PTY spawn, not at build time.
const RELEASE_TARGETS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
  'bun-darwin-x64',
  'bun-darwin-arm64',
];

function parseArgs(argv) {
  const args = { target: undefined, out: undefined, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

/** Map a `bun-<plat>-<arch>` target string to Node's platform/arch tokens. */
function targetToPlatformArch(target) {
  const m = /^bun-(linux|darwin|windows)-(x64|arm64)/.exec(target ?? '');
  if (!m) return { platform: process.platform, arch: process.arch };
  return { platform: m[1] === 'windows' ? 'win32' : m[1], arch: m[2] };
}

/**
 * The version to bake into the binary.
 *
 * WHY BAKE IT: every runtime version lookup ends at a `readFileSync` of the
 * install root's package.json (cli.ts `getVersion`, install-info
 * `botmuxVersionAt`). In compiled mode there IS no package.json on disk — the
 * module graph lives in the virtual read-only /$bunfs and `packageRoot()` walks
 * up to `/`, which has none. Every one of those reads fails, so `botmux
 * --version` printed `unknown` and the help banner read `botmux vunknown`.
 * Measured on the published canary before this fix.
 *
 * Compile time is the only place that knows the version for certain: release.yml
 * stamps package.json from the git tag BEFORE this script runs (the "Sync version
 * from git tag" step), so reading it here captures exactly what is being shipped.
 *
 * LOCAL VERIFICATION OVERRIDE: outside a release, package.json carries the
 * placeholder `0.0.0`, which the runtime deliberately treats as "not baked" (so a
 * local build cannot pass a placeholder off as authoritative). That makes the
 * smoke's version check fail on `unknown` for anyone compiling by hand — measured.
 * `scripts/verify-binary.mjs` therefore passes a `git describe` value through this
 * variable. It is read ONLY as a fallback, never over a real package.json version,
 * so it cannot influence a release build.
 */
function versionToBake() {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    if (typeof pkg.version === 'string' && pkg.version.length > 0 && pkg.version !== '0.0.0') return pkg.version;
  } catch { /* fall through */ }
  const override = process.env.BOTMUX_VERIFY_BAKED_VERSION;
  if (typeof override === 'string' && override.length > 0) return override;
  return '0.0.0';
}

/** Resolve node-pty's compiled `pty.node` (+ macOS spawn-helper) for a target.
 *  On linux the local `build/Release/pty.node` is authoritative; darwin ships
 *  prebuilds under `prebuilds/<plat>-<arch>/`. */
function resolveNodePtyNative(platform, arch) {
  const ptyRoot = dirname(require.resolve('node-pty/package.json'));
  const prebuilt = join(ptyRoot, 'prebuilds', `${platform}-${arch}`, 'pty.node');
  const localBuild = join(ptyRoot, 'build', 'Release', 'pty.node');
  const ptyNode = existsSync(prebuilt) ? prebuilt : localBuild;
  if (!existsSync(ptyNode)) {
    throw new Error(
      `node-pty native not found for ${platform}-${arch}: checked ${prebuilt} and ${localBuild}. ` +
      `Cross-compiling a target whose prebuild isn't present fails closed — build that target on its ` +
      `own runner (where \`bun install\` compiles build/Release/pty.node), as CI does.`,
    );
  }
  const spawnHelper = platform === 'darwin'
    ? join(ptyRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper')
    : null; // linux uses forkpty(), no helper sidecar
  return { ptyNode, spawnHelper: spawnHelper && existsSync(spawnHelper) ? spawnHelper : null };
}

/**
 * Resolve the skia native that `@napi-rs/canvas` loads on a darwin target.
 *
 * WHY: canvas ships its native per arch as an optionalDependency
 * (`@napi-rs/canvas-darwin-<arch>`), and the darwin release leg runs ONE
 * `bun install` on an arm64 runner, which installs only the arm64 package. Bun
 * embeds a `.node` only when the loader's static `require()` resolves at build
 * time, so `botmux-darwin-x64` shipped without skia (v3.40.0): the worker died at
 * module load with `Cannot find native binding`. Here the x64 file is produced
 * explicitly instead — from the lockfile-pinned tarball, sha512-checked against
 * `bun.lock` — and handed to the embed plugin.
 *
 * Linux is not affected: each linux leg builds on its own arch's runner, where
 * the matching package is installed, so this stays darwin-only.
 *
 * Returns the absolute path to the skia `.node`, or throws (fail closed: a
 * darwin binary without canvas would silently lose card rendering).
 */
async function resolveCanvasSkiaNative(platform, arch) {
  const pkg = `@napi-rs/canvas-${platform}-${arch}`;
  const skiaName = `skia.${platform}-${arch}.node`;

  try {
    const local = join(dirname(require.resolve(`${pkg}/package.json`)), skiaName);
    if (existsSync(local)) return local;
  } catch { /* not installed for this arch — fetch the locked tarball below */ }

  // The version and integrity come from bun.lock, not from a live `npm view`,
  // so the fetched bytes are exactly the ones the lockfile pins.
  const lock = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf8');
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = new RegExp(`"${esc}": \\["${esc}@([^"]+)", "([^"]+)", \\{[^}]*\\}, "(sha512-[^"]+)"\\]`).exec(lock);
  if (!entry) throw new Error(`${pkg} is not pinned in bun.lock; cannot resolve its skia native for darwin-${arch}.`);
  const [, version, tarball, integrity] = entry;

  const res = await fetch(tarball);
  if (!res.ok) throw new Error(`fetching ${pkg}@${version} from ${tarball} failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (digest !== integrity) throw new Error(`${pkg}@${version} integrity mismatch: bun.lock ${integrity}, downloaded ${digest}`);

  const dir = mkdtempSync(join(tmpdir(), `botmux-skia-${platform}-${arch}-`));
  const tgz = join(dir, 'canvas.tgz');
  writeFileSync(tgz, bytes);
  const untar = runTool(['tar', '-xzf', tgz, '-C', dir]);
  if (untar.code !== 0) throw new Error(`extracting ${tgz} failed: ${untar.err}`);
  const skia = join(dir, 'package', skiaName);
  if (!existsSync(skia)) throw new Error(`${pkg}@${version} has no ${skiaName} in its tarball`);
  return skia;
}

/** Run a tool, returning exit code + stderr instead of throwing on ENOENT. */
function runTool(argv) {
  try {
    const p = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, err: p.stderr.toString().trim() };
  } catch (e) {
    return { code: -1, err: `could not run \`${argv[0]}\`: ${e?.message ?? e}` };
  }
}

/**
 * Ad-hoc re-sign a compiled darwin binary, then verify it.
 *
 * WHY: `bun build --compile` ad-hoc-signs its own darwin output, but the signer
 * only gets the HOST arch right. On the macos-14 (arm64) release runner,
 * `--target=bun-darwin-x64` therefore lands an INVALID signature. Measured on
 * the v3.19.0 release run, where `codesign --verify --strict` reported:
 *
 *     botmux-darwin-arm64: valid on disk                                  ← native, fine
 *     botmux-darwin-x64: invalid signature (code or signature have been modified)
 *     In architecture: x86_64
 *
 * ...with bun 1.4.1 on the runner — i.e. AFTER the version bump this was
 * supposed to be fixed by. oven-sh/bun#39837 is titled "compile: fix invalid
 * ad-hoc code signature on darwin-arm64" and its test only compiles
 * `--target=bun-darwin-arm64`; nothing upstream covers x86_64. So bumping bun
 * again does NOT close this — don't read "we're on 1.4.2" as "already fixed".
 *
 * RE-MEASURED when the pin moved 1.4.1 → 1.4.2, by cross-compiling a two-line
 * hello-world from linux and recomputing the CodeDirectory page hashes (no
 * macOS required), with 1.4.0 as a control so the check is known to discriminate:
 *   1.4.0 → darwin-arm64: INVALID (1/15483)   darwin-x64: INVALID (2/17124)
 *   1.4.2 → darwin-arm64: VALID   (15075/15075)  darwin-x64: INVALID (2/16792, incl. slot 0)
 * So 1.4.2 changes nothing for the cross-compiled x64 cell: the arch-specific
 * defect is still there and this re-sign is still what makes the shipped
 * darwin-x64 binary runnable.
 * `codesign --force --sign -` is the re-signing fix confirmed in
 * oven-sh/bun#39764 (`BUN_NO_CODESIGN_MACHO_BINARY=1` and `--remove-signature`
 * were both reported there as NOT working).
 *
 * WHY IT MATTERS: recent macOS SIGKILLs a bad-signature binary before `main()`,
 * so 3.18.14 shipped a darwin-x64 build that could not start at all — all
 * `botmux upgrade` saw was a dead process. Nothing caught it, because
 * release.yml's `Smoke-test the host-arch binary` runs only the host arch
 * (arm64), and the arm64 binary was always fine.
 *
 * Idempotent, so this runs for BOTH darwin targets rather than special-casing
 * x64: re-signing the already-valid native output just rewrites an equivalent
 * signature, and not depending on "which arch is currently broken upstream"
 * keeps this correct if the arch-conditional bug moves.
 *
 * Signing needs macOS (`codesign` is an Apple tool), so a darwin binary
 * cross-built from Linux stays unsigned — warn loudly rather than fail, since
 * release.yml builds darwin only on macOS while `--all` on a Linux dev box is a
 * legitimate workflow. This function establishes a structurally valid
 * preliminary signature. Stable releases replace it with the repository's
 * Developer ID identity in `sign-darwin-binaries`; prereleases keep it ad-hoc.
 */
function adhocResignDarwin(outfile) {
  if (process.platform !== 'darwin') {
    console.warn(
      `⚠️  ${outfile}: darwin target cross-built on ${process.platform} — cannot ad-hoc sign, ` +
      `codesign is macOS-only. Recent macOS will SIGKILL this binary before main(). ` +
      `Release builds compile darwin on macOS (release.yml \`bun-binaries\`) and are signed there.`,
    );
    return;
  }
  const signed = runTool(['codesign', '--force', '--sign', '-', outfile]);
  if (signed.code !== 0) throw new Error(`ad-hoc codesign failed for ${outfile}: ${signed.err}`);
  // Verify with the strictness newer macOS applies at exec time, so a bad
  // signature fails the build here instead of on a user's machine. release.yml
  // re-checks this independently after the compile loop; that gate is the
  // fail-closed backstop for the release lane, this one covers every caller.
  const ok = runTool(['codesign', '--verify', '--strict', '--verbose=2', outfile]);
  if (ok.code !== 0) throw new Error(`codesign --verify --strict failed for ${outfile}: ${ok.err}`);
  console.log(`🔐 ad-hoc signed ${outfile}`);
}

async function buildOne({ target, out }) {
  const { platform, arch } = targetToPlatformArch(target);
  const { ptyNode, spawnHelper } = resolveNodePtyNative(platform, arch);
  const skiaNode = platform === 'darwin' ? await resolveCanvasSkiaNative(platform, arch) : null;

  const entry = join(REPO_ROOT, 'dist', 'standalone-entry.js');
  if (!existsSync(entry)) {
    throw new Error('dist/standalone-entry.js missing — run `bun run build` first (this bundles from dist/, it does not run tsc).');
  }

  const outfile = out ?? join(REPO_ROOT, 'dist-bin', target ? target.replace(/^bun-/, 'botmux-') : 'botmux');
  mkdirSync(dirname(outfile), { recursive: true });

  const baked = versionToBake();
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { outfile, ...(target ? { target } : {}) },
    minify: true,
    sourcemap: 'linked',
    // Substituted as a literal at compile time. The runtime reads it through
    // `bakedBinaryVersion()` (src/utils/install-info.ts), which is written so the
    // identifier is absent under Node — where the disk read still works — and only
    // this compiled path needs the constant.
    define: { 'process.env.BOTMUX_BAKED_VERSION': JSON.stringify(baked) },
    plugins: [makeNativeEmbedPlugin({ ptyNode, spawnHelper, skiaNode })],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`bun build failed for ${target ?? 'host'}`);
  }
  if (platform === 'darwin') adhocResignDarwin(outfile);
  console.log(`✅ built ${outfile} (${target ?? 'host'}; version=${baked}; pty.node=${ptyNode}${spawnHelper ? `, spawn-helper=${spawnHelper}` : ''}${skiaNode ? `, skia=${skiaNode}` : ''})`);
  return outfile;
}

async function main() {
  if (typeof Bun === 'undefined') {
    console.error('This script must be run with Bun: `bun scripts/build-bun-binary.mjs ...`');
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.all) {
    for (const target of RELEASE_TARGETS) await buildOne({ target, out: undefined });
  } else {
    await buildOne(args);
  }
}

await main();
