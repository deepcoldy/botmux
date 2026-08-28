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

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeNativeEmbedPlugin } from './bun-native-embed-plugin.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Compile targets for the botmux fleet. Kept in sync with release.yml.
const RELEASE_TARGETS = ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64'];

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
 */
function versionToBake() {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch { /* fall through */ }
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

async function buildOne({ target, out }) {
  const { platform, arch } = targetToPlatformArch(target);
  const { ptyNode, spawnHelper } = resolveNodePtyNative(platform, arch);

  const entry = join(REPO_ROOT, 'dist', 'cli.js');
  if (!existsSync(entry)) {
    throw new Error('dist/cli.js missing — run `bun run build` first (this bundles from dist/, it does not run tsc).');
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
    plugins: [makeNativeEmbedPlugin({ ptyNode, spawnHelper })],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`bun build failed for ${target ?? 'host'}`);
  }
  console.log(`✅ built ${outfile} (${target ?? 'host'}; version=${baked}; pty.node=${ptyNode}${spawnHelper ? `, spawn-helper=${spawnHelper}` : ''})`);
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
