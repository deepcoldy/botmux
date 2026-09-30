// Bun build plugin: make botmux's native addons AND the Dashboard frontend
// survive `bun build --compile`.
//
// `bun --compile` embeds a `.node` only when it is *statically* `require()`d in
// the bundle. botmux's native deps load theirs through dynamic/relative paths
// (node-pty: relative require inside lib/utils.js; @napi-rs/canvas: platform
// detection in js-binding.js), so the compiled binary can't find them at runtime
// (the source tree's node_modules is gone; paths resolve inside /$bunfs/). This
// plugin replaces those loaders at build time with ones that statically require
// the exact embedded `.node` we hand it, so Bun bundles + serves it.
//
// The Dashboard's static frontend has the same shape of problem — it is reached
// via a `__dirname`-derived directory that does not exist in a compiled binary —
// and is fixed the same way, by injecting static embedded-file imports. See the
// `dist/dashboard.js` hook at the bottom.
//
// Exported as a factory so both build-bun-binary.mjs and any programmatic caller
// pass the resolved native paths explicitly (no env/global coupling).
//
// VERIFIED (linux-x64): with the node-pty rewrite below, a compiled binary run
// from a directory with no node_modules spawns a real PTY. The canvas rewrite is
// best-effort (card rendering is non-critical) and validated structurally, not
// yet on a headless render inside a compiled binary — noted honestly for review.

import { readFileSync } from 'node:fs';
import { dirname as nodeDirname } from 'node:path';
import { buildDashboardEmbedPreamble } from './generate-dashboard-embed.mjs';

/**
 * @param {{ ptyNode: string, spawnHelper: string|null, skiaNode?: string|null }} opts
 *   ptyNode      absolute path to node-pty's pty.node for the TARGET platform
 *   spawnHelper  absolute path to node-pty's spawn-helper (macOS only; null on linux)
 *   skiaNode     absolute path to @napi-rs/canvas's skia .node (optional)
 */
export function makeNativeEmbedPlugin({ ptyNode, spawnHelper, skiaNode = null }) {
  return {
    name: 'botmux-native-embed',
    setup(build) {
      // ── node-pty ──────────────────────────────────────────────────────────
      // Replace lib/utils.js so loadNativeModule('pty') returns the embedded
      // native. The `require(<abs .node>)` here is what makes Bun embed it.
      // spawn-helper (macOS): node-pty computes it as `native.dir + '/spawn-helper'`
      // and resolves relative to utils.js dir. We embed it as a file asset, then
      // materialize it in a private content-addressed temp directory: the kernel
      // cannot posix_spawn Bun's virtual /$bunfs/ path. On linux spawnHelper is
      // null (forkpty, no sidecar) and `dir` is irrelevant to spawning.
      build.onLoad({ filter: /node-pty[\\/]lib[\\/]utils\.js$/ }, () => {
        // Compute the spawn-helper directory literal at BUILD time. On linux
        // spawnHelper is null (forkpty, no sidecar) so `dir` is only cosmetic and
        // we use the embedded .node's own directory. On macOS the embedded helper
        // is a file asset whose /$bunfs/ path is known only at runtime, so there
        // we derive its dir from the imported file path.
        const ptyDirLiteral = JSON.stringify(nodeDirname(ptyNode));
        const helperImport = spawnHelper
          ? `
            import embeddedSpawnHelperPath from ${JSON.stringify(spawnHelper)} with { type: 'file' };
            import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
            import { createHash } from 'node:crypto';
            import { dirname as __dirname_fn, join as __join_fn } from 'node:path';
            import { tmpdir as __tmpdir_fn } from 'node:os';

            let materializedSpawnHelperPath = null;
            function ensurePrivateDirectory(path, uid) {
              mkdirSync(path, { recursive: true, mode: 0o700 });
              const stat = lstatSync(path);
              if (!stat.isDirectory() || stat.isSymbolicLink()
                  || (typeof uid === 'number' && stat.uid !== uid)) {
                throw new Error('botmux-native-embed: unsafe native cache directory ' + path);
              }
              chmodSync(path, 0o700);
            }
            function materializeSpawnHelper() {
              if (materializedSpawnHelperPath) return materializedSpawnHelperPath;
              const bytes = readFileSync(embeddedSpawnHelperPath);
              const digest = createHash('sha256').update(bytes).digest('hex');
              const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
              const tempRoot = process.env.BOTMUX_NATIVE_TMPDIR || __tmpdir_fn();
              const root = __join_fn(tempRoot, 'botmux-native-' + uid);
              ensurePrivateDirectory(root, uid);
              const dir = __join_fn(root, digest);
              ensurePrivateDirectory(dir, uid);
              const target = __join_fn(dir, 'spawn-helper');
              let current = null;
              try {
                const targetStat = lstatSync(target);
                if (targetStat.isFile() && !targetStat.isSymbolicLink()
                    && (typeof uid !== 'number' || targetStat.uid === uid)) {
                  current = readFileSync(target);
                }
              } catch {}
              if (!current || !current.equals(bytes)) {
                const temp = target + '.' + process.pid + '.tmp';
                writeFileSync(temp, bytes, { mode: 0o700 });
                chmodSync(temp, 0o700);
                renameSync(temp, target);
              }
              chmodSync(target, 0o700);
              materializedSpawnHelperPath = target;
              return target;
            }
          `
          : `
            const materializedSpawnHelperPath = null;
            function materializeSpawnHelper() { return null; }
          `;
        const contents = `
          ${helperImport}
          const ptyNative = require(${JSON.stringify(ptyNode)});
          export function assign(target, ...sources) {
            sources.forEach(s => Object.keys(s).forEach(k => target[k] = s[k]));
            return target;
          }
          export function loadNativeModule(name) {
            if (name !== 'pty') throw new Error('botmux-native-embed: unexpected native module ' + name);
            // node-pty derives the spawn-helper path from \`dir\`. With an embedded
            // helper (macOS), materialize it outside Bun's virtual /$bunfs before
            // handing back its directory: posix_spawn is a kernel operation and
            // cannot execute Bun's virtual file path. Linux uses forkpty and has
            // no helper sidecar.
            const helperPath = materializeSpawnHelper();
            const dir = helperPath ? __dirname_fn(helperPath) : ${ptyDirLiteral};
            return { dir, helperPath, module: ptyNative };
          }
        `;
        return { contents, loader: 'js' };
      });

      // ── @napi-rs/canvas (optional, card PNG rendering) ──────────────────────
      // Only wired when a skia .node path is supplied. canvas's js-binding.js
      // honors NAPI_RS_NATIVE_LIBRARY_PATH; we embed the .node and set that env
      // var (once, at process start) to its extracted path via a tiny shim that
      // js-binding imports first. Kept behind a flag so a build without canvas
      // native still compiles (card render just degrades).
      if (skiaNode) {
        build.onLoad({ filter: /@napi-rs[\\/]canvas[\\/]js-binding\.js$/ }, (args) => {
          const original = readFileSync(args.path, 'utf8');
          const preamble = `
            import skiaPath from ${JSON.stringify(skiaNode)} with { type: 'file' };
            if (!process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
              process.env.NAPI_RS_NATIVE_LIBRARY_PATH = skiaPath;
            }
          `;
          return { contents: preamble + '\n' + original, loader: 'js' };
        });
      }

      // ── Dashboard frontend ────────────────────────────────────────────────
      // Same class of problem as the natives above, for static assets: the
      // Dashboard resolves its frontend as `join(__dirname, 'dashboard-web')`,
      // which in a compiled binary points into the virtual /$bunfs/ and does not
      // exist — so every asset request fell through to the catch-all 404 and the
      // Dashboard was completely unreachable from a binary (npm/source were
      // fine). Prepend static `type: 'file'` imports for the whole bundle plus
      // the request-path → embedded-path map the server reads.
      build.onLoad({ filter: /[\\/]dist[\\/]dashboard\.js$/ }, (args) => {
        const original = readFileSync(args.path, 'utf8');
        return { contents: buildDashboardEmbedPreamble() + '\n' + original, loader: 'js' };
      });
    },
  };
}
