#!/usr/bin/env node
/**
 * Fail the build when a non-JS artifact lands in `dist/` without a decision about
 * whether the COMPILED BINARY can reach it.
 *
 * WHY THIS EXISTS: `bun build --compile` embeds nothing by itself — only
 * statically traced imports are pulled in (see the header of
 * scripts/generate-dashboard-embed.mjs). Anything the build merely `cp`s into
 * `dist/` therefore exists for `node dist/cli.js` and does NOT exist inside the
 * binary, where `__dirname` is the virtual `/$bunfs/root`. That mismatch has
 * shipped twice:
 *
 *   • 88e3d7f24 — the whole Dashboard frontend was absent, so EVERY asset
 *     request fell through to the catch-all 404 and the Dashboard was
 *     unreachable from a compiled binary while fine from npm/source.
 *   • 2ef5c3a58 — `readDefaultScopeManifest()` probes three `join(here, …)`
 *     candidates; MEASURED under compile they resolve to `/$bunfs/root/…` and
 *     all miss, so `setup` throws `找不到 botmux lark-scopes.json`.
 *
 * Both were invisible to every test: the unit suite runs `node dist/*.js`, where
 * the files are right there on disk. The failure only exists in a form nothing
 * in the repo executes. Hence a STATIC gate at build time.
 *
 * WHAT IT IS NOT: this does not verify that an embedded asset is actually served
 * correctly — that is smoke-bun-binary.mjs's job (it fetches `/` from a real
 * compiled binary). This gate answers only the cheaper, earlier question: has
 * anyone DECIDED what happens to this file under compile?
 *
 * THE DECISION IS RECORDED IN CODE, not in a list of filenames: a new asset is
 * either covered by a mechanism below, or the build fails and whoever added it
 * has to say which case it is. A bare filename allowlist would let a file be
 * "known" while still being unreachable — exactly the state 2ef5c3a58 was in.
 */

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(REPO_ROOT, 'dist');

/** Generated JS and its sidecars are the compile INPUT, never a runtime read. */
const CODE_SUFFIXES = ['.js', '.js.map', '.d.ts', '.d.ts.map', '.mjs', '.cjs'];

/**
 * How a `dist/` asset can be reachable from the compiled binary.
 *
 * Each entry states the MECHANISM, so a reader can check the claim rather than
 * trust a filename. `covers` is matched against dist-relative POSIX paths.
 */
const EMBED_MECHANISMS = [
  {
    id: 'dashboard-embed-preamble',
    // scripts/generate-dashboard-embed.mjs walks this tree and emits one
    // `import … with { type: 'file' }` per file, so the whole subtree is
    // covered automatically and a NEW file under it needs no action here.
    covers: (rel) => rel.startsWith('dashboard-web/'),
    proof: 'scripts/generate-dashboard-embed.mjs walks dist/dashboard-web and emits a type:"file" import per file',
  },
  {
    id: 'static-json-import',
    // src/cli.ts and src/setup/open-platform-automation.ts both do
    // `import … from './…/lark-scopes.json' with { type: 'json' }`, so --compile
    // traces it into the module graph. The copy under dist/ remains for the Node
    // path; the binary no longer reads it off disk at all.
    //
    // VERIFIED on a real compiled binary via the `__selfcheck` hidden command
    // that shipped with the fix: `{"ok":true,"tenant":171,"user":130}` — before
    // it, `botmux setup` threw `找不到 botmux lark-scopes.json`.
    covers: (rel) => rel === 'setup/lark-scopes.json',
    proof: 'imported with { type: "json" } by cli.ts and setup/open-platform-automation.ts; `<binary> __selfcheck` proves it resolves',
  },
];

/**
 * Assets that deliberately do NOT need to exist inside the binary, each with the
 * reason it is safe. Anything not listed and not covered above fails the build.
 */
const NOT_NEEDED_IN_BINARY = [
  {
    rel: '.runtime-build-id',
    // src/utils/runtime-build-id.ts falls back to hashing the module graph when
    // the artifact is absent; the artifact is a dev/source-checkout fast path.
    reason: 'runtime-build-id.ts treats a missing artifact as "recompute", so absence degrades to a slower path, not a failure',
  },
];


function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) { out.push(...walk(abs)); continue; }
    out.push(relative(DIST, abs).split(/[\\/]/).join('/'));
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error('[audit-embed] dist/ missing — run `bun run build` first.');
  process.exit(2);
}

const assets = walk(DIST)
  .filter((rel) => !CODE_SUFFIXES.some((s) => rel.endsWith(s)))
  .sort();

const unaccounted = [];
for (const rel of assets) {
  if (EMBED_MECHANISMS.some((m) => m.covers(rel))) continue;
  if (NOT_NEEDED_IN_BINARY.some((e) => e.rel === rel)) continue;
  unaccounted.push(rel);
}

// Stale-entry check: an exemption that no longer matches any asset is worse than
// no exemption, because it silently stops protecting anything.
const stale = NOT_NEEDED_IN_BINARY.filter((e) => !assets.includes(e.rel));
if (stale.length > 0) {
  console.error(
    `[audit-embed] ${stale.length} exemption(s) no longer match any dist asset — delete them:\n`
    + stale.map((e) => `  - ${e.rel}`).join('\n'),
  );
  process.exit(1);
}

if (unaccounted.length > 0) {
  console.error(
    `[audit-embed] ${unaccounted.length} asset(s) land in dist/ with no decision about the compiled binary:\n`
    + unaccounted.map((r) => `  - ${r}`).join('\n')
    + '\n\n'
    + 'In the compiled binary `__dirname` is the virtual /$bunfs/root, so a file that is only\n'
    + '`cp`d into dist/ is NOT there — every read of it fails (2ef5c3a58: setup threw\n'
    + '`找不到 botmux lark-scopes.json`; 88e3d7f24: the Dashboard 404ed every request).\n\n'
    + 'Pick one, then re-run:\n'
    + '  (a) make it reachable — import it into the module graph so --compile traces it\n'
    + '      (`with { type: "json" }` for JSON, `with { type: "file" }` for binary assets),\n'
    + '      or extend a mechanism in EMBED_MECHANISMS if a whole subtree is generated;\n'
    + '  (b) if the binary genuinely must not need it, add it to NOT_NEEDED_IN_BINARY\n'
    + '      WITH the reason absence is safe.\n',
  );
  process.exit(1);
}

console.log(`[audit-embed] ${assets.length} dist asset(s) accounted for (compiled-binary reachability decided)`);
