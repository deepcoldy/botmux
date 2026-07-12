/**
 * Grok Build path helpers.
 *
 * Layout (see `~/.grok/README.md` Session Persistence):
 *   $GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/
 *     summary.json
 *     updates.jsonl      — ACP session update stream (bridge source of truth)
 *     chat_history.jsonl
 *     …
 *   $GROK_HOME/sessions/<url-encoded-cwd>/prompt_history.jsonl
 *     — bucket-level submit log: one `{timestamp, session_id, prompt, is_bash}`
 *       line PER SUBMIT, written at submit time even while a turn is running
 *       (verified on grok 0.2.93). The submit-verify source of truth — the
 *       per-session updates.jsonl only records a type-ahead user message at
 *       DEQUEUE time (after the running turn finishes), so it cannot confirm
 *       a busy-turn submit.
 *   $GROK_HOME/sessions/session_search.sqlite
 *   $GROK_HOME/skills/
 *   $GROK_HOME/hooks/
 *   $GROK_HOME/auth.json
 *
 * When the URL-encoded cwd exceeds 255 bytes, Grok uses a slug+hash bucket
 * name and records the real path in a `.cwd` file inside that group. Path
 * helpers resolve via {@link resolveGrokCwdBucketDir} so prompt_history /
 * session dirs stay correct for long / CJK working directories.
 *
 * GROK_HOME is process-level only (daemon env / shell). Per-bot `env.GROK_HOME`
 * is reserved — botmux installs hooks/skills and drains transcripts under the
 * daemon-resolved home; injecting a different home into the CLI only would
 * split-brain (see per-bot-env RESERVED_ENV_KEYS).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Grok's documented max length for an encoded cwd bucket name (bytes). */
export const GROK_ENCODED_CWD_MAX_BYTES = 255;

/** Resolve GROK_HOME (env override, else `~/.grok`). */
export function grokHome(): string {
  const override = process.env.GROK_HOME?.trim();
  return override && override.length > 0 ? override : join(homedir(), '.grok');
}

export function grokSessionsRoot(): string {
  return join(grokHome(), 'sessions');
}

export function grokSkillsDir(): string {
  return join(grokHome(), 'skills');
}

export function grokHooksDir(): string {
  return join(grokHome(), 'hooks');
}

/** URL-encode a working directory the way Grok names session buckets. */
export function encodeGrokCwd(cwd: string): string {
  return encodeURIComponent(cwd);
}

/**
 * Resolve the on-disk sessions bucket directory for `cwd`.
 *
 * 1. Prefer the normal URL-encoded name when that directory already exists.
 * 2. Otherwise scan for a hashed bucket whose `.cwd` file equals `cwd`
 *    (Grok's path when encoded name would exceed 255 bytes).
 * 3. If nothing exists yet, return the preferred encoded path (Grok will
 *    create it for short paths; long paths only appear after TUI startup,
 *    at which point step 2 finds the hashed group).
 */
export function resolveGrokCwdBucketDir(cwd: string): string {
  const root = grokSessionsRoot();
  const encoded = encodeGrokCwd(cwd);
  const preferred = join(root, encoded);
  if (existsSync(preferred)) return preferred;

  if (existsSync(root)) {
    try {
      for (const name of readdirSync(root)) {
        if (name.endsWith('.sqlite') || name.endsWith('.lock')) continue;
        const marker = join(root, name, '.cwd');
        if (!existsSync(marker)) continue;
        try {
          const raw = readFileSync(marker, 'utf8').replace(/\r?\n$/, '');
          // Grok writes the absolute cwd; tolerate a trailing newline only.
          if (raw === cwd || raw.trim() === cwd) return join(root, name);
        } catch { /* ignore unreadable marker */ }
      }
    } catch { /* ignore unreadable root */ }
  }
  return preferred;
}

export function grokSessionDir(sessionId: string, cwd: string): string {
  return join(resolveGrokCwdBucketDir(cwd), sessionId);
}

export function grokUpdatesPath(sessionId: string, cwd: string): string {
  return join(grokSessionDir(sessionId, cwd), 'updates.jsonl');
}

/** Bucket-level submit log (see header) — one line per submit across all
 *  sessions in this cwd. Resolves hashed buckets via `.cwd` when needed. */
export function grokPromptHistoryPath(cwd: string): string {
  return join(resolveGrokCwdBucketDir(cwd), 'prompt_history.jsonl');
}

export function grokSummaryPath(sessionId: string, cwd: string): string {
  return join(grokSessionDir(sessionId, cwd), 'summary.json');
}
