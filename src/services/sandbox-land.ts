/**
 * Sandbox landing (overlayfs model): the project overlay UPPER dir IS the
 * changeset the sandboxed agent produced. We compute a human-readable diff from
 * it (preview/patch via `git diff --no-index` against the real project), and on
 * the owner's confirmation copy the changed files back into the real project.
 *
 * The agent in the sandbox is oblivious it's overlaid — it thinks it edits the
 * real files. So landing is owner-triggered only (the `/land` command or the
 * dashboard button), never by the agent.
 *
 * Upper-layer semantics (overlayfs):
 *   - a regular file in upper           → a new-or-modified file
 *   - a symlink in upper                → a symlink the agent created/changed
 *   - a character device with rdev 0    → a WHITEOUT (the agent deleted the file)
 *   - a dir with xattr trusted.overlay.opaque=y → the dir's lower contents are
 *     hidden. NOTE: overlayfs sets this xattr on BOTH a freshly-created dir AND a
 *     wholesale-replaced dir, so opacity ALONE cannot tell "new" from "replaced".
 *     The real discriminator is whether the dir also exists in the lower (= the
 *     target). We therefore only treat an opaque dir as a wholesale REPLACE (drop
 *     the lower's stale contents) when it ALSO exists in the target; a purely-new
 *     opaque dir is just mkdir'd — never rm -rf'd over unrelated real files.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync, readdirSync, lstatSync, copyFileSync, mkdirSync, rmSync, readFileSync,
  readlinkSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { t, type Locale } from '../i18n/index.js';

export interface LandDiff {
  ok: true;
  empty: boolean;
  patch: string;
  statText: string;   // file list + per-file change kind
  files: number;
  insertions: number;
  deletions: number;
}
export interface LandError { ok: false; error: string }

/** One change the agent made, derived from the overlay upper layer. */
interface UpperChange {
  /** Path relative to the project root. */
  rel: string;
  /** file = regular file; symlink = a link (target in `linkTarget`); delete = a
   *  whiteout; opaque = an opaque dir (REPLACE iff it also exists in the target). */
  kind: 'file' | 'symlink' | 'delete' | 'opaque';
  /** Symlink target string (only for kind:'symlink'). */
  linkTarget?: string;
}

/** Locate the project overlay UPPER dir (= SandboxSpawn.workDir) for a session. */
export function upperDir(dataDir: string, sessionId: string): string {
  return join(dataDir, 'sandboxes', sessionId, 'proj-upper');
}

/**
 * The project LOWER source recorded by prepareSandbox at create time (meta.json).
 * Used to tell a wholesale-REPLACED opaque dir (existed in the lower) from a
 * purely-NEW opaque dir (didn't) — overlayfs marks BOTH opaque, so the lower is
 * the only reliable discriminator, and the LIVE landing target may have drifted
 * (concurrent work) so we must NOT use it for this. Returns '' when unknown
 * (older session / meta missing) → callers fall back to the target.
 */
function projectLower(dataDir: string, sessionId: string): string {
  try {
    const meta = JSON.parse(readFileSync(join(dataDir, 'sandboxes', sessionId, 'meta.json'), 'utf8'));
    return typeof meta?.projectLower === 'string' ? meta.projectLower : '';
  } catch { return ''; }
}

/** True if a path is an overlayfs whiteout (char device, rdev 0). */
function isWhiteout(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isCharacterDevice() && st.rdev === 0;
  } catch { return false; }
}

/**
 * Read the overlay opaque xattr for a dir.
 *   - 'y'   → the dir is opaque
 *   - ''    → the dir is present and NOT opaque (xattr absent)
 *   - null  → could NOT determine (no xattr tooling available / read failed)
 *
 * `getfattr` is provided by the `attr` package and is frequently NOT installed;
 * `trusted.overlay.*` also requires CAP_SYS_ADMIN to read (we run as root). We
 * try getfattr first, then python3's os.getxattr (commonly present), and return
 * null when neither can answer — callers must NOT silently treat null as "not
 * opaque" (that would leak stale lower files); they fail-closed where it matters.
 */
function readOpaqueXattr(p: string): 'y' | '' | null {
  // getfattr (attr package). --only-values prints just the value; ENOATTR → exit≠0.
  const gf = spawnSync('getfattr', ['-n', 'trusted.overlay.opaque', '--only-values', '-h', p], { encoding: 'utf8' });
  if (gf.error == null && typeof gf.status === 'number') {
    if (gf.status === 0) return (gf.stdout ?? '').trim() === 'y' ? 'y' : '';
    // exit≠0 with stderr mentioning "No such attribute"/ENOATTR → present, not opaque.
    const se = (gf.stderr ?? '').toLowerCase();
    if (se.includes('no such attribute') || se.includes('enoattr') || se.includes('not found')) return '';
    // other failure (e.g. permission) → fall through to python.
  }
  // python3's os.getxattr — exit 0 + 'y' on stdout when opaque; exit 0 + '' when
  // the attr is absent; exit 2 only if python itself is unavailable.
  const py = spawnSync('python3', [
    '-c',
    "import os,sys\n" +
    "try:\n" +
    " v=os.getxattr(sys.argv[1],'trusted.overlay.opaque')\n" +
    " sys.stdout.write(v.decode('latin1','replace'))\n" +
    "except OSError as e:\n" +
    " import errno\n" +
    " sys.exit(0) if e.errno in (errno.ENODATA,errno.ENOATTR if hasattr(errno,'ENOATTR') else errno.ENODATA) else sys.exit(3)\n",
    p,
  ], { encoding: 'utf8' });
  if (py.error == null && py.status === 0) return (py.stdout ?? '').trim() === 'y' ? 'y' : '';
  return null; // undeterminable
}

/** Walk the upper layer, classifying every entry into an UpperChange. */
function walkUpper(upper: string): UpperChange[] {
  const changes: UpperChange[] = [];
  const recurse = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = relative(upper, full);
      if (isWhiteout(full)) { changes.push({ rel, kind: 'delete' }); continue; }
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) {
        // A symlink is landed as a symlink (NOT dereferenced into a content copy,
        // which would destroy the link and could snapshot out-of-tree host data).
        let linkTarget = '';
        try { linkTarget = readlinkSync(full); } catch { /* */ }
        changes.push({ rel, kind: 'symlink', linkTarget });
      } else if (st.isDirectory()) {
        // Opacity is recorded; the new-vs-replace decision is deferred to apply
        // (where the target — the lower — is known). Either way we recurse so the
        // dir's surviving children land as their own 'file'/'symlink' changes.
        const opaque = readOpaqueXattr(full);
        if (opaque === 'y' || opaque === null) changes.push({ rel, kind: 'opaque' });
        recurse(full);
      } else if (st.isFile()) {
        changes.push({ rel, kind: 'file' });
      }
      // other special files (fifos/sockets/non-whiteout devices) are skipped.
    }
  };
  recurse(upper);
  return changes;
}

/**
 * Compute the agent's changeset from the session's overlay upper layer, with a
 * human-readable preview (per-file `git diff --no-index` vs the real project).
 */
export function computeSandboxDiff(dataDir: string, sessionId: string, locale?: Locale): LandDiff | LandError {
  const upper = upperDir(dataDir, sessionId);
  if (!existsSync(upper)) return { ok: false, error: t('sandbox.no_clone', undefined, locale) };

  let changes: UpperChange[];
  try { changes = walkUpper(upper); }
  catch (e: any) { return { ok: false, error: t('sandbox.diff_failed', { detail: (e?.message ?? e).toString().slice(0, 300) }, locale) }; }

  if (changes.length === 0) {
    return { ok: true, empty: true, patch: '', statText: '', files: 0, insertions: 0, deletions: 0 };
  }

  // Diff each upper file against the SAME-NAMED real file in the overlay lower
  // (the recorded project root) so modified files show a true unified diff (not
  // the whole file as "added"), then rewrite git's --no-index headers to
  // project-relative a/<rel> b/<rel> — clean for the card AND `git apply`-able as
  // the .patch file. New files diff vs /dev/null; deletions diff lower vs /dev/null.
  const lower = projectLower(dataDir, sessionId);   // real project root ('' if unknown)
  const relDiff = (oldPath: string, newPath: string, rel: string): string => {
    let out = '';
    try { out = spawnSync('git', ['diff', '--no-index', '--', oldPath, newPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? ''; }
    catch { /* */ }
    if (!out) return '';
    return out.split('\n').map(line => {
      if (line.startsWith('diff --git ')) return `diff --git a/${rel} b/${rel}`;
      if (line.startsWith('--- ')) return line.includes('/dev/null') ? '--- /dev/null' : `--- a/${rel}`;
      if (line.startsWith('+++ ')) return line.includes('/dev/null') ? '+++ /dev/null' : `+++ b/${rel}`;
      return line;
    }).join('\n');
  };
  const countPlus = (b: string) => b.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
  const countMinus = (b: string) => b.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length;

  const statLines: string[] = [];
  const patchParts: string[] = [];
  let insertions = 0, deletions = 0, fileCount = 0;
  for (const c of changes) {
    if (c.kind === 'delete') {
      const lowFile = lower ? join(lower, c.rel) : '';
      const body = (lowFile && existsSync(lowFile))
        ? relDiff(lowFile, '/dev/null', c.rel)
        : `diff --git a/${c.rel} b/${c.rel}\ndeleted file\n--- a/${c.rel}\n+++ /dev/null\n`;
      statLines.push(`D  ${c.rel}`);
      deletions += countMinus(body) || 1;
      patchParts.push(body); fileCount++;
      continue;
    }
    if (c.kind === 'symlink') {
      statLines.push(`L  ${c.rel} -> ${c.linkTarget ?? ''}`);
      patchParts.push(`# symlink ${c.rel} -> ${c.linkTarget ?? ''} (recreated on land; not in this text patch)`);
      fileCount++; continue;
    }
    if (c.kind === 'opaque') {
      // Replaced directory; its surviving children land as their own 'file'
      // changes (walkUpper recursed), so no diff body here — just note it.
      statLines.push(`R  ${c.rel}/ (directory replaced)`);
      continue;
    }
    // regular file: modified (exists in lower) vs new
    const upPath = join(upper, c.rel);
    const lowFile = lower ? join(lower, c.rel) : '';
    const isMod = !!(lowFile && existsSync(lowFile));
    const body = relDiff(isMod ? lowFile : '/dev/null', upPath, c.rel)
      || `diff --git a/${c.rel} b/${c.rel}\n(binary or unreadable: ${c.rel})\n`;
    statLines.push(`${isMod ? 'M' : 'A'}  ${c.rel}`);
    insertions += countPlus(body);
    deletions += countMinus(body);
    patchParts.push(body); fileCount++;
  }

  return {
    ok: true,
    empty: false,
    patch: patchParts.join('\n'),
    statText: statLines.join('\n'),
    files: fileCount,
    insertions,
    deletions,
  };
}

/**
 * Apply the session's overlay upper changeset onto the real target project:
 *   - regular file in upper → mkdir -p parent, copy over the real file
 *   - symlink in upper      → recreate the link (NOT a dereferenced copy)
 *   - whiteout              → remove the corresponding real file/dir
 *   - opaque dir            → only when the dir ALSO exists in the target (= a
 *                             wholesale replace): drop the stale lower contents,
 *                             then re-create it (its surviving files arrive as
 *                             separate 'file'/'symlink' changes). A purely-new
 *                             opaque dir is just mkdir'd (never rm -rf'd).
 *
 * Two-phase for safety:
 *   1) PRE-VALIDATE every source is landable (dangling symlink, unreadable regular
 *      file, undeterminable opacity on a dir that exists in the target) BEFORE we
 *      mutate anything — so the common mid-loop failure (a dangling relative
 *      symlink) is caught up front and the real project is left untouched.
 *   2) APPLY; if a per-file op still throws (race / permission / ENOSPC), we
 *      report which files were already applied so the owner isn't told "failed"
 *      with the repo silently half-landed and no clue about its state.
 */
export function applySandboxDiff(targetDir: string, dataDir: string, sessionId: string, locale?: Locale): { ok: true } | LandError {
  const upper = upperDir(dataDir, sessionId);
  if (!existsSync(upper)) return { ok: false, error: t('sandbox.no_clone', undefined, locale) };
  if (!existsSync(targetDir)) return { ok: false, error: t('sandbox.target_not_git', { dir: targetDir }, locale) };

  let changes: UpperChange[];
  try { changes = walkUpper(upper); }
  catch (e: any) { return { ok: false, error: t('sandbox.apply_failed', { detail: (e?.message ?? e).toString().slice(0, 300) }, locale) }; }
  if (changes.length === 0) return { ok: false, error: t('sandbox.nothing_to_land', undefined, locale) };

  // Project LOWER (create-time) — the reliable new-vs-replace discriminator for
  // opaque dirs; '' when unknown → fall back to the live target.
  const lower = projectLower(dataDir, sessionId);
  // Does dir `rel` count as a REPLACE (existed in the lower) vs a fresh NEW dir?
  const existedInLower = (rel: string): boolean =>
    lower ? existsSync(join(lower, rel)) : existsSync(join(targetDir, rel));

  // ── Phase 1: pre-validate — fail-closed BEFORE any mutation ────────────────
  const preErrors: string[] = [];
  for (const c of changes) {
    if (c.kind === 'file') {
      const src = join(upper, c.rel);
      // Resolve via lstat: a regular file must be readable; a broken/special src
      // would make the in-loop copyFileSync throw mid-land. Catch it now.
      try { lstatSync(src); } catch (e: any) { preErrors.push(`${c.rel}: source missing (${e?.code ?? e})`); }
    } else if (c.kind === 'symlink') {
      if (!c.linkTarget) preErrors.push(`${c.rel}: unreadable symlink target`);
    } else if (c.kind === 'opaque') {
      // Only an opaque dir that existed in the LOWER triggers a destructive
      // rm -rf (a wholesale replace). For such a dir, if we could NOT determine
      // opacity (readOpaqueXattr → null, no xattr tooling) we MUST NOT guess
      // "not opaque" (that leaks stale lower files); fail-closed with a clear
      // message. A purely-NEW opaque dir needs no opacity read at all.
      if (existedInLower(c.rel)) {
        const opaque = readOpaqueXattr(join(upper, c.rel));
        if (opaque === null) {
          preErrors.push(`${c.rel}/: cannot determine overlay opacity (install the "attr" package, i.e. getfattr) — refusing to land a possibly-replaced directory without knowing whether to drop its stale contents`);
        }
      }
    }
  }
  if (preErrors.length > 0) {
    return { ok: false, error: t('sandbox.apply_failed', { detail: `pre-flight (no changes applied): ${preErrors.slice(0, 8).join('; ').slice(0, 380)}` }, locale) };
  }

  // ── Phase 2: apply ─────────────────────────────────────────────────────────
  const applied: string[] = [];
  try {
    for (const c of changes) {
      const real = join(targetDir, c.rel);
      if (c.kind === 'delete') {
        try { rmSync(real, { recursive: true, force: true }); } catch { /* already gone */ }
        applied.push(`-${c.rel}`);
        continue;
      }
      if (c.kind === 'opaque') {
        // Wholesale REPLACE only when the dir existed in the LOWER (create-time)
        // — drop its stale contents. A purely-NEW opaque dir is just mkdir'd, so
        // we never rm -rf unrelated real files that drifted into the live target
        // under a path the agent merely created fresh (the new-dir clobber).
        if (existedInLower(c.rel) && existsSync(real)) {
          try { rmSync(real, { recursive: true, force: true }); } catch { /* */ }
        }
        mkdirSync(real, { recursive: true });
        applied.push(`R ${c.rel}/`);
        continue;
      }
      if (c.kind === 'symlink') {
        // Recreate the link verbatim (preserve symlink-ness; do NOT dereference).
        mkdirSync(dirname(real), { recursive: true });
        try { unlinkSync(real); } catch { /* not present */ }
        try { rmSync(real, { recursive: true, force: true }); } catch { /* was a dir */ }
        symlinkSync(c.linkTarget ?? '', real);
        applied.push(`L ${c.rel}`);
        continue;
      }
      // regular file: copy the upper content over the real file.
      mkdirSync(dirname(real), { recursive: true });
      // If a symlink/dir is squatting the target path, clear it first so copy lands a file.
      try { const st = lstatSync(real); if (st.isSymbolicLink() || st.isDirectory()) rmSync(real, { recursive: true, force: true }); } catch { /* */ }
      copyFileSync(join(upper, c.rel), real);
      applied.push(c.rel);
    }
    return { ok: true };
  } catch (e: any) {
    const detail = `${(e?.message ?? e).toString().slice(0, 240)} — already applied (${applied.length}): ${applied.slice(0, 12).join(', ').slice(0, 200)}`;
    return { ok: false, error: t('sandbox.apply_failed', { detail }, locale) };
  }
}
