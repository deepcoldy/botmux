import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSessionChildEnv, type EnvPolicy } from '../core/env-policy.js';
import { expandHomePath as expandHome } from '../utils/working-dir.js';

/** TRAE CLI (traex / traecli) stores config, state DB, sessions, and skills
 *  under TRAE_HOME when set; otherwise it defaults to ~/.trae. Keep this
 *  dynamic so tests and child processes that set TRAE_HOME after module load
 *  still resolve correctly. */
export function traeHome(): string {
  return traeHomeFor(process.env);
}

/** TRAE_HOME as `env` resolves it. A per-bot `env.TRAE_HOME` reaches only the
 *  CLI child, not the worker's own process.env, so anything computed FOR the
 *  child (its sandbox binds) must use the child's env, not traeHome(). */
export function traeHomeFor(env: NodeJS.ProcessEnv): string {
  const configured = env.TRAE_HOME?.trim();
  return configured ? expandHome(configured) : join(homedir(), '.trae');
}

/**
 * A per-bot TRAE_HOME reaches only the CLI child, never the worker's own
 * process.env. The worker's readers (state DB / history.jsonl / rollouts /
 * Gateway config, all via traeHome()) must read the root the CLI writes, or
 * submit confirmation and resume lookup look in ~/.trae while the CLI works
 * elsewhere (and the sandbox binds the wrong root). Re-derived from the boot
 * value on every call so a removed override does not stick; with no per-bot
 * value the result is exactly the inherited TRAE_HOME. Adopted panes are left
 * alone: that process was not started with this bot's env. Other CLIs: untouched.
 *
 * The value MUST be composed exactly like the CLI child's env
 * (`buildSessionChildEnv(workerEnv, envPolicy, envUnset)` then the per-bot
 * overlay last): the worker fork already applied the strict policy
 * (buildBotWorkerEnv has no unset parameter), so `envUnset` only bites at
 * THIS boundary, and a blank per-bot value must win over the boot value just
 * like it does in the child (traeHomeFor trims a blank to the default root).
 */
export function pinWorkerTraeHome(env: NodeJS.ProcessEnv, opts: {
  cliId: string;
  adoptMode: boolean;
  perBotEnv: Record<string, string>;
  bootTraeHome: string | undefined;
  envPolicy?: EnvPolicy;
  envUnset?: readonly string[];
}): void {
  if (opts.adoptMode || (opts.cliId !== 'traex' && opts.cliId !== 'coco')) return;
  const bootView: NodeJS.ProcessEnv = opts.bootTraeHome === undefined ? {} : { TRAE_HOME: opts.bootTraeHome };
  const value = {
    ...buildSessionChildEnv(bootView, opts.envPolicy, opts.envUnset),
    ...opts.perBotEnv,
  }.TRAE_HOME?.trim();
  if (value) env.TRAE_HOME = value;
  else delete env.TRAE_HOME;
}

/** TraeX and CoCo share the same Codex-compatible TOML configuration. */
export function traeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(traeHomeFor(env), 'traecli.toml');
}

/** TRAE's state root (SQLite DBs, history, sessions) the sandbox binds
 *  read-write for a child running with `env`. */
export function traeCliStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(traeHomeFor(env), 'cli');
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
