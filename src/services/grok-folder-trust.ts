/**
 * Pre-answer Grok Build's startup folder-trust question for a Botmux-owned
 * spawn, the way Claude (`~/.claude.json` hasTrustDialogAccepted) and Codex
 * (`-c projects={…}`) already are.
 *
 * Why it is needed (Grok ≥1.0.64, "Untrusted folders run only your
 * organization's managed hooks"): while ANY user-level hook exists — and Botmux
 * itself installs `$GROK_HOME/hooks/botmux-*.json` — Grok asks
 * "Do you trust the contents of this directory?" before the composer in every
 * folder except $HOME and `/`. Nobody answers that inside a Botmux pane, so
 * the argv-baked first prompt never starts.
 *
 * Store format (written by Grok itself, toml crate, file mode 0600):
 *
 *   [folders."/root/ec-apply-access"]
 *   trusted = true
 *   decided_at = 1792809756          # unix seconds
 *
 * guarded by flock(LOCK_EX) on `trusted_folders.toml.lock` around a
 * temp-write + rename. Which key Grok consults was measured on 1.0.70 with an
 * isolated GROK_HOME (see resolveGrokTrustFolder): only the exact workspace
 * root counts — trust on a parent folder or on a subdirectory key does not.
 *
 * Contract: only ADD a missing `trusted = true` entry. Existing bytes are kept
 * verbatim (no re-serialization, comments and order survive). An explicit
 * `trusted = false` is the user's decision and is never touched — the caller
 * tells the thread instead. Anything this conservative reader does not fully
 * understand is left alone rather than risk writing a duplicate table that
 * would make Grok reject the whole file.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse as parsePath, resolve } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withExclusiveFileLock } from '../utils/file-flock.js';
import { grokHome } from './grok-paths.js';
import type { WorkspaceTrustOutcome } from '../adapters/cli/types.js';

export const GROK_TRUSTED_FOLDERS_FILE = 'trusted_folders.toml';
const GROK_TRUST_LOCK_TIMEOUT_MS = 3_000;

function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** A directory Grok (gix discovery) accepts as a git dir: a `HEAD` file plus
 *  either its own object store or a `commondir` pointer (linked worktree).
 *  An empty or broken `.git` is not a repository and discovery moves on. */
function isGitDir(gitDir: string): boolean {
  return isFile(join(gitDir, 'HEAD'))
    && (isDirectory(join(gitDir, 'objects')) || isFile(join(gitDir, 'commondir')));
}

/** Trust root for a checkout whose `.git` is a FILE: the main checkout's root
 *  for a linked worktree, the checkout itself for a submodule-style pointer,
 *  undefined when the pointer does not lead to a valid git dir. */
function dotGitFileRoot(dotGitFile: string): string | undefined {
  let gitDir: string;
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGitFile, 'utf-8'));
    if (!m) return undefined;
    gitDir = resolve(dirname(dotGitFile), m[1]);
  } catch {
    return undefined;
  }
  if (!isGitDir(gitDir)) return undefined;
  let commonDir: string;
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf-8').trim());
  } catch {
    return dirname(dotGitFile);
  }
  // `<main>/.git/worktrees/<name>` → commondir `../..` → `<main>/.git`.
  return parsePath(commonDir).base === '.git' ? realpathOr(dirname(commonDir)) : dirname(dotGitFile);
}

/**
 * The folder Grok asks about (and records) for a launch in `workingDir`.
 * Measured on Grok Build 1.0.70 with an isolated GROK_HOME:
 *   - the launch path is realpath'd first (a symlinked cwd records its target);
 *   - outside git, the launch directory itself — trust on a parent folder is
 *     NOT inherited;
 *   - inside a git repository, the repository root — a key for the exact
 *     subdirectory is ignored, and a trusted root covers its subdirectories.
 *     Only a valid git dir counts (an empty `.git` directory is skipped and
 *     the walk continues upward, as gix discovery does);
 *   - inside a linked worktree (`.git` file → gitdir → commondir), the MAIN
 *     checkout's root (Grok reads `commondir`; matches 1.0.67's "worktrees use
 *     their main checkout's saved answers").
 */
export function resolveGrokTrustFolder(workingDir: string): string {
  const launch = realpathOr(workingDir);
  for (let dir = launch; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    const root = isDirectory(dotGit)
      ? (isGitDir(dotGit) ? dir : undefined)
      : isFile(dotGit) ? dotGitFileRoot(dotGit) : undefined;
    if (root) return root;
    if (dirname(dir) === dir) return launch;
  }
}

// ─── Minimal, conservative reader for Grok's trust store ────────────────────

/** Encode a TOML basic string (the form Grok writes for path keys). */
export function tomlBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

const BASIC_ESCAPES: Record<string, string> = {
  b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\',
};

/** Decode a quoted TOML key token (`"…"` basic or `'…'` literal). */
function decodeTomlQuotedKey(token: string): string | undefined {
  if (token.startsWith("'")) return token.slice(1, -1);
  const body = token.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = body[++i];
    if (next === 'u' || next === 'U') {
      const len = next === 'u' ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return undefined;
      out += String.fromCodePoint(parseInt(hex, 16));
      i += len;
    } else if (next !== undefined && BASIC_ESCAPES[next] !== undefined) {
      out += BASIC_ESCAPES[next];
    } else {
      return undefined;
    }
  }
  return out;
}

const QUOTED_KEY = String.raw`("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')`;
const FOLDER_TABLE_HEADER = new RegExp(String.raw`^\s*\[\s*folders\s*\.\s*${QUOTED_KEY}\s*\]\s*(?:#.*)?$`);
const TRUSTED_LINE = /^\s*trusted\s*=\s*(true|false)\s*(?:#.*)?$/;

export type GrokTrustPlan =
  | { kind: 'already-trusted' }
  | { kind: 'explicitly-untrusted' }
  | { kind: 'unrecognized'; reason: string }
  | { kind: 'append'; text: string };

/**
 * Decide what to do with the store's current text for `folder`. Pure.
 * Recognizes exactly the shape Grok writes; any construct that could also
 * define `folders.<key>` some other way (inline/dotted tables, arrays of
 * tables, multi-line strings) makes the result `unrecognized` instead of
 * risking a duplicate key.
 */
export function planGrokFolderTrust(existing: string | undefined, folder: string, decidedAtSec: number): GrokTrustPlan {
  const entry = `[folders.${tomlBasicString(folder)}]\ntrusted = true\ndecided_at = ${Math.floor(decidedAtSec)}\n`;
  if (existing === undefined || existing.trim() === '') return { kind: 'append', text: entry };
  if (existing.includes('"""') || existing.includes("'''")) {
    return { kind: 'unrecognized', reason: 'multi-line string' };
  }

  // undefined: top level; null: some table we do not care about.
  let current: string | null | undefined;
  let found = false;
  let trusted: boolean | undefined;
  for (const line of existing.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      if (trimmed.startsWith('[[')) return { kind: 'unrecognized', reason: 'array of tables' };
      const header = FOLDER_TABLE_HEADER.exec(line);
      if (header) {
        const key = decodeTomlQuotedKey(header[1]);
        if (key === undefined) return { kind: 'unrecognized', reason: 'undecodable folder key' };
        current = key;
        if (key === folder) found = true;
        continue;
      }
      // `[folders]` (dotted keys inside) or `[folders.<bare>…]` / nested keys.
      if (/^\[\s*["']?folders\b/.test(trimmed)) return { kind: 'unrecognized', reason: 'non-standard folders table' };
      current = null;
      continue;
    }
    if (current === undefined && /^["']?folders\b/.test(trimmed)) {
      return { kind: 'unrecognized', reason: 'inline folders table' };
    }
    if (typeof current === 'string' && current === folder) {
      const m = TRUSTED_LINE.exec(line);
      if (m) trusted = m[1] === 'true';
    }
  }
  if (found) {
    if (trusted === true) return { kind: 'already-trusted' };
    if (trusted === false) return { kind: 'explicitly-untrusted' };
    return { kind: 'unrecognized', reason: 'entry without a trusted flag' };
  }
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return { kind: 'append', text: `${existing}${separator}${entry}` };
}

function readStore(path: string): string | undefined {
  try { return readFileSync(path, 'utf-8'); } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
}

export interface EnsureGrokFolderTrustOptions {
  grokHome?: string;
  homeDir?: string;
  nowMs?: () => number;
  lockTimeoutMs?: number;
}

/** Pre-trust the Grok workspace root of `workingDir`. Never throws. */
export async function ensureGrokFolderTrust(
  workingDir: string,
  opts: EnsureGrokFolderTrustOptions = {},
): Promise<WorkspaceTrustOutcome> {
  const home = opts.grokHome ?? grokHome();
  const storePath = join(home, GROK_TRUSTED_FOLDERS_FILE);
  let folder = workingDir;
  try {
    if (!isDirectory(workingDir)) {
      return { status: 'skipped', folder, storePath, reason: 'working directory does not exist' };
    }
    folder = resolveGrokTrustFolder(workingDir);
    // Grok counts $HOME and filesystem roots as trusted without an entry.
    if (folder === parsePath(folder).root || folder === realpathOr(opts.homeDir ?? homedir())) {
      return { status: 'not-needed', folder, storePath };
    }
    if (!isDirectory(home)) {
      // Grok has not run here yet (no login either); do not create its home.
      return { status: 'skipped', folder, storePath, reason: `${home} does not exist` };
    }
    const now = () => Math.floor((opts.nowMs?.() ?? Date.now()) / 1000);
    const decide = (plan: GrokTrustPlan): WorkspaceTrustOutcome | undefined => {
      if (plan.kind === 'already-trusted') return { status: 'already-trusted', folder, storePath };
      if (plan.kind === 'explicitly-untrusted') return { status: 'explicitly-untrusted', folder, storePath };
      if (plan.kind === 'unrecognized') return { status: 'skipped', folder, storePath, reason: `unrecognized ${GROK_TRUSTED_FOLDERS_FILE} (${plan.reason})` };
      return undefined;
    };
    // Unlocked fast path: the common case (already decided) never forks a lock helper.
    const early = decide(planGrokFolderTrust(readStore(storePath), folder, now()));
    if (early) return early;

    const locked = await withExclusiveFileLock(
      `${storePath}.lock`,
      opts.lockTimeoutMs ?? GROK_TRUST_LOCK_TIMEOUT_MS,
      (): WorkspaceTrustOutcome => {
        // Re-read under the lock: Grok or another daemon may have written since.
        const current = readStore(storePath);
        const plan = planGrokFolderTrust(current, folder, now());
        const decided = decide(plan);
        if (decided) return decided;
        if (plan.kind !== 'append') throw new Error('unreachable');
        let mode = 0o600;
        try { if (current !== undefined) mode = statSync(storePath).mode & 0o777; } catch { /* keep 0600 */ }
        atomicWriteFileSync(storePath, plan.text, { mode });
        return { status: 'trusted', folder, storePath };
      },
    );
    if (locked.acquired) return locked.value;
    return {
      status: 'skipped',
      folder,
      storePath,
      reason: locked.reason === 'timeout'
        ? `${GROK_TRUSTED_FOLDERS_FILE}.lock is held by another process`
        : `cannot lock ${GROK_TRUSTED_FOLDERS_FILE}.lock (${locked.detail ?? 'no flock/perl helper'})`,
    };
  } catch (err: any) {
    return { status: 'skipped', folder, storePath, reason: err?.message ?? String(err) };
  }
}

