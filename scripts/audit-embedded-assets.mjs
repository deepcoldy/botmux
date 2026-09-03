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

/**
 * The ASSET-side audit needs a built `dist/`; the READER-side scan below reads only
 * `src/` and needs nothing. Aborting here would therefore make the reader gate
 * unrunnable in a fresh checkout — and its two tests spawn this script, so
 * `vitest run test/setup-app-icon.test.ts` on its own exited 2 before any assertion
 * ran. CI happens to build first, which is exactly why that would have gone unnoticed.
 *
 * So: skip the asset half when dist/ is absent, and say so, rather than exiting. The
 * `--require-dist` flag keeps the build's own invocation strict, so a real build can
 * never silently skip the asset audit.
 */
const REQUIRE_DIST = process.argv.includes('--require-dist');
const distBuilt = existsSync(DIST);
if (!distBuilt && REQUIRE_DIST) {
  console.error('[audit-embed] dist/ missing — run `bun run build` first.');
  process.exit(2);
}

const assets = distBuilt
  ? walk(DIST).filter((rel) => !CODE_SUFFIXES.some((s) => rel.endsWith(s))).sort()
  : [];

const unaccounted = [];
for (const rel of assets) {
  if (EMBED_MECHANISMS.some((m) => m.covers(rel))) continue;
  if (NOT_NEEDED_IN_BINARY.some((e) => e.rel === rel)) continue;
  unaccounted.push(rel);
}

// Stale-entry check: an exemption that no longer matches any asset is worse than
// no exemption, because it silently stops protecting anything.
//
// ⚠️ Only meaningful when dist/ was actually scanned. With `assets` empty (no build),
// EVERY exemption looks rotted and this would fail for a reason that has nothing to do
// with the tree — the same vacuous-verdict shape the reader gate's own probe avoids.
const stale = distBuilt ? NOT_NEEDED_IN_BINARY.filter((e) => !assets.includes(e.rel)) : [];
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

/**
 * ── SECOND GATE: THE READER SIDE ───────────────────────────────────────────────
 *
 * Everything above audits the ASSET side: "this file lands in dist/, is it reachable
 * from the binary?". That question has a blind spot big enough to ship a bug through,
 * and it did — twice for the same reason.
 *
 * `dist/dashboard-web/favicon.png` was fully ACCOUNTED FOR here (the
 * dashboard-embed-preamble mechanism covers the whole `dashboard-web/` subtree), and
 * this audit passed. But `src/setup/open-platform-automation.ts` read that icon by
 * walking `join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard-web',
 * 'favicon.png')` — and the embed preamble is prepended ONLY to `dist/dashboard.js`,
 * reachable ONLY through `globalThis.__BOTMUX_DASHBOARD_ASSETS__`. `setup` runs from
 * the CLI without importing the dashboard entry, so the map is absent and the path is
 * virtual: every install.sh / npm / bun global user got `找不到 botmux 默认应用图标`
 * and could not create a bot.
 *
 * The lesson is that "embedded SOMEWHERE in the binary" is not "reachable from the
 * code that reads it". An asset-side audit cannot see that; only a reader-side one can.
 *
 * So: scan source for asset reads built out of a module-relative directory.
 *
 * ⚠️ THIS MUST NOT BE A SINGLE-LINE MATCH. The first version required the directory
 * derivation and the asset extension on the SAME line, and its positive control (the
 * real pre-fix code, reinstated verbatim) did NOT fire — because the offending shape
 * is two statements:
 *
 *     const here = dirname(fileURLToPath(import.meta.url));   // dir, no extension
 *     …join(here, '..', 'dashboard-web', 'favicon.png')…      // extension, no dir
 *
 * A gate whose control does not fire is worse than no gate: it reports "clean" over
 * the exact defect it was written for. So the scan is two-pass — first collect the
 * identifiers BOUND to a module-relative directory in this file, then flag any asset
 * path built from one of them (or from the derivation inline).
 *
 * ── WHAT THIS GATE DOES AND DOES NOT CATCH ─────────────────────────────────────
 * It catches every SYNTAX that derives a module-relative base: `dirname(
 * fileURLToPath(import.meta.url))`, bare `__dirname`, `import.meta.dirname` (the
 * modern Bun/Node idiom — MEASURED to resolve to the same virtual /$bunfs/root under
 * --compile, so it is the same hazard in a shorter costume), and `new URL('.',
 * import.meta.url)`. Extensions are matched case-insensitively.
 *
 * It does NOT do data-flow analysis, so a directory that reaches the asset line
 * through a hop evades it. KNOWN LIMITATIONS (accepted, not silent):
 *   • a function RETURNS the dir, another call site builds the asset path
 *     (`function baseDir() { return dirname(fileURLToPath(import.meta.url)); }`
 *      then `join(baseDir(), 'x.png')`) — cross-function, the identifier is never
 *      `const`-bound in the file that reads;
 *   • an alias/reassignment hop (`const base = here;` then `join(base, …)`);
 *   • a binding split across lines, or `let here; here = …`;
 *   • destructuring (`const [here] = […]`).
 * These need a real parser/flow analysis; the line-based scan is deliberately the
 * cheap layer that catches the copy-paste shape. If one of them ships, the fix is to
 * strengthen the scan, not to excuse the miss — the two-pass lesson above applies.
 */
const SRC = join(REPO_ROOT, 'src');
/** Extensions whose contents get READ at runtime (not spawned, not imported). */
const ASSET_EXT = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|mp4|wav|json|html|css|txt|md|pem|crt)['"`\s,)\]]/i;
/** How a module-relative base directory is derived (every syntax that resolves to /$bunfs under --compile). */
const MODULE_DIR = /fileURLToPath\(\s*import\.meta\.url\s*\)|\b__dirname\b|import\.meta\.dirname|new URL\([^)]*import\.meta\.url/;
/** `const here = dirname(fileURLToPath(import.meta.url))` → captures `here`. */
const DIR_BINDING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*(?:fileURLToPath\(\s*import\.meta\.url\s*\)|\b__dirname\b|import\.meta\.dirname|new URL\([^)]*import\.meta\.url)/;

/**
 * Source sites allowed to derive an asset path from their own module directory,
 * each with the reason the compiled binary is unaffected. Every entry below was
 * READ before being listed — an exemption added to silence the gate without
 * checking is how the gate stops protecting anything.
 */
const READER_EXEMPTIONS = [
  // NOTE: `src/dashboard.ts` is deliberately NOT listed. It does build paths from
  // `__dirname` (`WEB_DIR`, plus two dev-reload markers), but those markers carry no
  // asset extension so nothing here matches them, and the compiled build serves the
  // frontend from the injected `__BOTMUX_DASHBOARD_ASSETS__` map rather than WEB_DIR.
  // An exemption "just in case" would be exactly the hollow entry the staleness check
  // below rejects — verified by adding it and watching that check fail.
  {
    // `getVersion()` reads package.json only AFTER `bakedBinaryVersion()` misses,
    // and the build bakes the version into the binary precisely so it never gets
    // here (c6b88e376 fixed `--version` printing `unknown`). Fail-soft: catch → 'unknown'.
    file: 'src/cli.ts',
    reason: 'bakedBinaryVersion() short-circuits before the read in compiled builds; the read is try/catch fail-soft',
  },
  {
    // `packageRoot()` walks up looking for package.json and RETURNS A DIRECTORY
    // either way; `isLocalDevInstall()` additionally early-returns for standalone
    // (see its docblock). No asset content is read, so absence degrades, not breaks.
    file: 'src/utils/install-info.ts',
    reason: 'resolves a directory with an explicit standalone early-return; never reads asset content',
  },
  {
    // An OPTIONAL project font override: `tryRegister` is try/catch → false, and the
    // chain falls through to system fonts. Absence is the normal case even under Node.
    file: 'src/utils/screenshot-renderer.ts',
    reason: 'optional font override; tryRegister() returns false and the font chain falls through',
  },
  {
    // Electron main process only. The desktop app ships its own Node runtime and
    // resources tree (scripts/prepare-desktop-runtime.mjs) and is never the
    // `bun build --compile` single-file binary, so /$bunfs never applies.
    file: 'src/desktop/main.ts',
    reason: 'Electron main process, never the compiled single-file binary',
  },
];

function walkSource(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) { out.push(...walkSource(abs)); continue; }
    if (/\.tsx?$/.test(name)) out.push(abs);
  }
  return out;
}

/** Is this line comment/doc text rather than code? */
function isComment(line) {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

const readerOffenders = [];
/** Exemptions that actually suppressed something, so a rotted one can be spotted. */
const exemptionsUsed = new Set();
// Test seam: an extra tree to scan, so a test can prove this gate BITES without
// mutating a real source file (a mutation left behind by a crashed test would be far
// worse than the gap it was checking). Production never sets it.
const extraSrc = process.env.BOTMUX_AUDIT_EXTRA_SRC;
const scanRoots = [SRC, ...(extraSrc ? [extraSrc] : [])].filter((d) => existsSync(d));
/** How many source files were actually read — the honest "did we scan anything" signal. */
let scannedFileCount = 0;
for (const root of scanRoots) {
  for (const abs of walkSource(root)) {
    scannedFileCount += 1;
    const rel = relative(REPO_ROOT, abs).split(/[\\/]/).join('/');
    const lines = readFileSync(abs, 'utf8').split('\n');

    // Pass 1: which identifiers in this file hold a module-relative directory?
    const moduleDirs = new Set();
    for (const line of lines) {
      if (isComment(line)) continue;
      const m = DIR_BINDING.exec(line);
      if (m) moduleDirs.add(m[1]);
    }

    // Pass 2: any asset path built from one of them, or from the derivation inline.
    const hits = [];
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      if (!ASSET_EXT.test(line)) return;
      const inline = MODULE_DIR.test(line);
      const viaBinding = [...moduleDirs].some((id) => new RegExp(`\\b${id}\\b`).test(line));
      if (inline || viaBinding) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
    if (hits.length === 0) continue;

    // Exempt AFTER matching, not before: an exemption that no longer suppresses
    // anything is silently protecting nothing, and the staleness check below says so.
    const exempt = READER_EXEMPTIONS.find((e) => rel === e.file || rel.endsWith(`/${e.file}`));
    if (exempt) { exemptionsUsed.add(exempt.file); continue; }
    readerOffenders.push(...hits);
  }
}

// Skip the staleness check when scanning an extra tree: that run is a targeted probe,
// not the real inventory, so "this exemption matched nothing" carries no information.
// ⚠️ Only meaningful when the REAL src/ tree was scanned. Three ways it becomes
// vacuous, all observed while building this: with `BOTMUX_AUDIT_EXTRA_SRC` the run is a
// targeted probe; with `src/` absent nothing can match; and with an EMPTY-ish `src/`
// (a scratch copy of just this script) `existsSync` is still true while zero files were
// read — that last one is why the guard counts scanned FILES rather than trusting the
// directory to exist. In all three every exemption "looks rotted" for a reason that has
// nothing to do with the exemptions, and a check that fails vacuously trains people to
// ignore it.
const scannedRealSrc = !extraSrc && scannedFileCount > 0;
const staleReaderExemptions = scannedRealSrc
  ? READER_EXEMPTIONS.filter((e) => !exemptionsUsed.has(e.file))
  : [];
if (staleReaderExemptions.length > 0) {
  console.error(
    `[audit-embed] ${staleReaderExemptions.length} reader exemption(s) no longer suppress anything — delete them:\n`
    + staleReaderExemptions.map((e) => `  - ${e.file}`).join('\n')
    + '\n\nAn exemption that matches nothing is worse than none: it reads as "reviewed and safe"\n'
    + 'while protecting nothing, and it hides the next site that moves into that file.\n',
  );
  process.exit(1);
}

if (readerOffenders.length > 0) {
  console.error(
    `[audit-embed] ${readerOffenders.length} source site(s) read an asset from a module-relative path:\n`
    + readerOffenders.map((o) => `  - ${o}`).join('\n')
    + '\n\n'
    + 'In the compiled binary that base directory is the virtual /$bunfs/root, so the read\n'
    + 'MISSES — even with the real file sitting next to the binary. Shipped three times:\n'
    + '  88e3d7f24  Dashboard 404ed every asset request\n'
    + '  2ef5c3a58  setup threw `找不到 botmux lark-scopes.json`\n'
    + '  this gate   setup threw `找不到 botmux 默认应用图标`, blocking bot creation\n\n'
    + 'Put the asset in the MODULE GRAPH instead, so --compile traces it:\n'
    + '  · JSON            → `import x from "./x.json" with { type: "json" }`\n'
    + '  · binary/text     → generate a base64/string constant module and import it\n'
    + '                      (scripts/generate-app-icon-data.mjs is the worked example;\n'
    + '                       `with { type: "file" }` is Bun-only and breaks tsc/tsx/node)\n'
    + 'If the site is genuinely safe, add it to READER_EXEMPTIONS with the reason.\n',
  );
  process.exit(1);
}

console.log(`[audit-embed] ${assets.length} dist asset(s) accounted for (compiled-binary reachability decided)`);
console.log(`[audit-embed] no source site reads an asset from a module-relative path`);
