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
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export function grokSessionDir(sessionId: string, cwd: string): string {
  return join(grokSessionsRoot(), encodeGrokCwd(cwd), sessionId);
}

export function grokUpdatesPath(sessionId: string, cwd: string): string {
  return join(grokSessionDir(sessionId, cwd), 'updates.jsonl');
}

/** Bucket-level submit log (see header) — one line per submit across all
 *  sessions in this cwd. */
export function grokPromptHistoryPath(cwd: string): string {
  return join(grokSessionsRoot(), encodeGrokCwd(cwd), 'prompt_history.jsonl');
}

export function grokSummaryPath(sessionId: string, cwd: string): string {
  return join(grokSessionDir(sessionId, cwd), 'summary.json');
}
