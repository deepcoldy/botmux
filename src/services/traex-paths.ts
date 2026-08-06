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
 *  session). Used to reverse-map a botmux session id to a TRAE-native session
 *  UUID (buildArgs/buildResumeCommand) and as the session/path index for
 *  rollout-based transcript bridging. */
export function traeStateDbPath(): string {
  return join(traeHome(), 'cli', 'state_5.sqlite');
}

/** Global submit log — TRAE appends one JSON line (`{session_id, ts, text}`,
 *  byte-identical to Codex's format) here on every successful user submit
 *  across all sessions, AT SUBMIT TIME. This is the authoritative submit-
 *  confirmation source: unlike the per-session rollout JSONL, a message parked
 *  by TRAE's type-ahead queue while a turn is running is written here
 *  immediately, whereas the rollout only records it once the running turn
 *  dequeues it (which can exceed the worker's submit-confirmation deadline and
 *  fire a false "submission couldn't be confirmed" warning). Shared by every
 *  TRAE pane under one TRAE_HOME, so a match needs a pid-ownership filter to
 *  avoid attributing a sibling pane's identical text — mirrors codexHistoryPath. */
export function traeHistoryPath(): string {
  return join(traeHome(), 'cli', 'history.jsonl');
}

/** Per-session rollout JSONL files live under dates here, e.g.
 *  sessions/2026/06/04/rollout-<timestamp>-<uuid>.jsonl. The threads table
 *  stores the absolute path per session. */
export function traeSessionsRoot(): string {
  return join(traeHome(), 'cli', 'sessions');
}
