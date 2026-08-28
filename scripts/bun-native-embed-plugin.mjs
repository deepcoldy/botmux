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
      // and resolves relative to utils.js dir. We embed it as a file asset and
      // expose its /$bunfs/ path via `dir` so unixTerminal's helperPath lands on
      // the embedded copy. On linux spawnHelper is null (forkpty, no sidecar) and
      // `dir` is irrelevant to spawning.
      build.onLoad({ filter: /node-pty[\\/]lib[\\/]utils\.js$/ }, () => {
        // Compute the spawn-helper directory literal at BUILD time. On linux
        // spawnHelper is null (forkpty, no sidecar) so `dir` is only cosmetic and
        // we use the embedded .node's own directory. On macOS the embedded helper
        // is a file asset whose /$bunfs/ path is known only at runtime, so there
        // we derive its dir from the imported file path.
        const ptyDirLiteral = JSON.stringify(nodeDirname(ptyNode));
        const helperImport = spawnHelper
          ? `import spawnHelperPath from ${JSON.stringify(spawnHelper)} with { type: 'file' };\nimport { dirname as __dirname_fn } from 'node:path';`
          : `const spawnHelperPath = null;`;
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
            // helper (macOS), hand back its directory so \`dir + '/spawn-helper'\`
            // matches the embedded file path; on linux use the .node's dir literal.
            const dir = spawnHelperPath ? __dirname_fn(spawnHelperPath) : ${ptyDirLiteral};
            return { dir, module: ptyNative };
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
