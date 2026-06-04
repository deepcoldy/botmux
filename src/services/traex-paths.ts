import { homedir } from 'node:os';
import { join } from 'node:path';

function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}

/** TRAE CLI (traex / traecli) stores config, state DB, sessions, and skills
 *  under TRAE_HOME when set; otherwise it defaults to ~/.trae. Keep this
 *  dynamic so tests and child processes that set TRAE_HOME after module load
 *  still resolve correctly. */
export function traeHome(): string {
  const configured = process.env.TRAE_HOME?.trim();
  return configured ? expandHome(configured) : join(homedir(), '.trae');
}

/** SQLite database holding the `threads` table (one row per interactive
 *  session). Used as the submit-verification source of truth because traex
 *  (unlike codex) does not write a flat history.jsonl. */
export function traeStateDbPath(): string {
  return join(traeHome(), 'cli', 'state_5.sqlite');
}

/** Per-session rollout JSONL files live under dates here, e.g.
 *  sessions/2026/06/04/rollout-<timestamp>-<uuid>.jsonl. The threads table
 *  stores the absolute path per session. */
export function traeSessionsRoot(): string {
  return join(traeHome(), 'cli', 'sessions');
}
