#!/usr/bin/env node
// Build the JS preamble that embeds the Dashboard frontend into the compiled
// binary. Imported by scripts/bun-native-embed-plugin.mjs, which prepends the
// returned source to `dist/dashboard.js` at compile time.
//
// WHY ANY OF THIS: the Dashboard serves its static frontend by resolving
// `join(__dirname, 'dashboard-web')`. In the compiled single binary `__dirname`
// is the virtual `/$bunfs/root`, so that directory does not exist and EVERY
// asset request fell through to the catch-all 404 — the post-login redirect to
// `/` answered `{"error":"not_found_yet","path":"/"}` and the Dashboard was
// unreachable from a compiled binary while working fine from npm/source.
// `bun build --compile` embeds nothing by itself: only statically traced imports
// are pulled in, and the frontend has no import edge to the server module.
//
// WHY A MANIFEST rather than pointing WEB_DIR at /$bunfs/root: Bun renames each
// embedded file with a content hash (`index.html` → `index-c7k0x1v9.html` —
// MEASURED), so a request path can never address the embedded file directly. The
// extension IS preserved, which keeps the server's extension-based MIME lookup
// working untouched.
//
// WHY INJECTED rather than a generated module the server imports: a static
// `import './dashboard-web-embedded.js'` would make `tsc` and every plain source
// checkout demand an artifact that only exists after `bun run dashboard:bundle`;
// and a runtime `require()` of it does not work at all — Bun embeds only what it
// can trace statically, and MEASURED, requiring the manifest bundled 1 module and
// embedded zero assets, leaving the binary still 404ing everything.
//
// GENERATED, never hand-written: chunk filenames are content-hashed and change on
// every frontend build, so a hand-kept list would rot into 404s for precisely the
// lazy chunks it missed.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = join(REPO_ROOT, 'dist', 'dashboard-web');

/** Every file under `dir`, as WEB_DIR-relative POSIX paths. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) { out.push(...walk(abs)); continue; }
    // Dev-only reload markers are written by `build-dashboard.mjs --watch` and
    // must never ship inside a released binary.
    if (name === '.botmux-dashboard-dev' || name === '.botmux-dashboard-reload') continue;
    out.push(relative(WEB_DIR, abs).split(/[\\/]/).join('/'));
  }
  return out;
}

/**
 * JS source that imports every Dashboard asset as an embedded file and publishes
 * the request-path → embedded-path map on `globalThis`.
 *
 * Throws when the frontend bundle is missing: shipping a binary whose Dashboard
 * 404s on every request is the bug this exists to fix, so fail the BUILD instead
 * of producing that binary again.
 */
export function buildDashboardEmbedPreamble() {
  if (!existsSync(WEB_DIR)) {
    throw new Error(
      `dist/dashboard-web missing — run \`bun run build\` (or \`bun run dashboard:bundle\`) before compiling; `
      + 'a binary without it serves a 404 for every Dashboard request.',
    );
  }
  const rels = walk(WEB_DIR).sort();
  if (rels.length === 0) throw new Error('dist/dashboard-web has no files to embed.');

  const imports = [];
  const entries = [];
  rels.forEach((rel, i) => {
    const id = `__bmxAsset${i}`;
    // Absolute specifier: the preamble is prepended to dist/dashboard.js, and an
    // absolute path is resolvable regardless of that file's own location. The
    // real extension is preserved so Bun's embedded copy keeps it.
    imports.push(`import ${id} from ${JSON.stringify(join(WEB_DIR, rel))} with { type: 'file' };`);
    entries.push(`  ${JSON.stringify(rel)}: ${id},`);
  });

  return [
    '// ── injected by scripts/generate-dashboard-embed.mjs (compiled builds only) ──',
    ...imports,
    // Null prototype: the server looks assets up by REQUEST path, so the map must
    // not answer `__proto__` / `constructor` / `toString` with inherited values.
    // The server also guards its own lookup; this keeps the object itself honest.
    'globalThis.__BOTMUX_DASHBOARD_ASSETS__ = Object.assign(Object.create(null), {',
    ...entries,
    '});',
    '',
  ].join('\n');
}

/** Asset count, for the build log. */
export function dashboardEmbedAssetCount() {
  return existsSync(WEB_DIR) ? walk(WEB_DIR).length : 0;
}
