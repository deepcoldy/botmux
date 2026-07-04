/**
 * Working-directory path helpers, kept dependency-light so the CLI entrypoint
 * can import them without dragging in the daemon graph (worker-pool, PTY, …).
 */
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { t, type Locale } from '../i18n/index.js';

export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/**
 * Validate a user-supplied path for `/cd` and `/oncall bind`. Trust model is
 * "owner explicitly chose a directory" — the daemon already runs CLI prompts
 * with full filesystem access, so an allowlist would be theater. We only do
 * the typo guards: exists and is a directory.
 *
 * Auto-create is opt-in (`opts.autoCreate`): only commands where the owner is
 * explicitly typing a fresh path right now (`/cd`, `/oncall bind`) pass it —
 * a missing path gets `mkdir -p` and `created: true` so the caller can tell
 * the user. Every other call site (stored/derived paths at trigger time,
 * dashboard writes, repo cards) keeps the exists-check as its typo guard —
 * silently materializing an empty dir there would mask a stale or mistyped
 * path instead of surfacing it.
 */
export function validateWorkingDir(
  input: string,
  locale?: Locale,
  opts?: { autoCreate?: boolean },
): { ok: true; resolvedPath: string; created?: boolean } | { ok: false; error: string } {
  const resolvedPath = resolve(expandHome(input));
  if (!existsSync(resolvedPath)) {
    if (!opts?.autoCreate) {
      return { ok: false, error: t('cmd.cd.dir_not_exist', { path: resolvedPath }, locale) };
    }
    try {
      mkdirSync(resolvedPath, { recursive: true });
      return { ok: true, resolvedPath, created: true };
    } catch (e: any) {
      return { ok: false, error: t('cmd.cd.cannot_create', { path: resolvedPath, msg: e?.message ?? String(e) }, locale) };
    }
  }
  let isDir = false;
  try { isDir = statSync(resolvedPath).isDirectory(); } catch (e: any) {
    return { ok: false, error: t('cmd.cd.cannot_read', { path: resolvedPath, msg: e?.message ?? String(e) }, locale) };
  }
  if (!isDir) {
    return { ok: false, error: t('cmd.cd.not_a_directory', { path: resolvedPath }, locale) };
  }
  return { ok: true, resolvedPath };
}
