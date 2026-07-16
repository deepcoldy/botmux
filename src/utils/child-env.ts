/**
 * Env vars that must never reach a spawned CLI child. The bot's IM-app creds
 * (a child CLI's own Lark OAuth reads `process.env.LARK_APP_ID` as the app to
 * authorize and gets hijacked by the botmux IM app → no docs scopes → 403
 * loop) and claude-code's nesting marker. The child resolves Lark via the
 * namespaced `BOTMUX_LARK_APP_ID` or via bots.json on disk (im/lark/client.ts);
 * the worker keeps its own bare creds (worker-pool.ts forkWorker) for
 * lark-upload — only the *child* is redacted.
 *
 * Two leak vectors, two layers (both keyed off this list):
 *  - PTY / direct spawn: `redactChildEnv()` deletes them from the env object.
 *  - tmux: the new pane inherits the tmux *server's* global env, which the
 *    client env can't override, so the shell wrapper `unset`s them before exec
 *    (see SHELL_WRAPPER_SCRIPT in tmux-backend.ts).
 */
export const REDACTED_CHILD_ENV_KEYS = ['LARK_APP_ID', 'LARK_APP_SECRET', 'CLAUDECODE'] as const;

/**
 * Botmux-managed, session/bot-scoped env keys that reach the CLI pane via the
 * `/usr/bin/env KEY=VAL` wrapper injection (buildBotmuxEnvAssignments), NOT via
 * the tmux client env. They MUST be stripped from the env handed to the `tmux`
 * binary (see tmuxEnv), because the first `tmux new-session` that boots a server
 * copies its client env into the server's *global* environment — which then
 * leaks into every co-tenant session sharing that socket, including the user's
 * own interactive tmux. A leaked `BOTMUX_SESSION_ID` / `BOTMUX_CHAT_ID` makes a
 * plain Claude Code run in the user's terminal believe it is a botmux session
 * and misroute its AskUserQuestion hook to a Lark thread. Stripping is invisible
 * to botmux's own sessions: the pane still gets the correct per-session values
 * from the env(1) injection, which lands after rcfile load.
 *
 * The `BOTMUX` prefix is swept wholesale by {@link isBotmuxManagedTmuxEnvKey}
 * (covers daemon-internal BOTMUX_BOT_INDEX / BOTMUX_QUIET_RESTART / … that were
 * never meant to reach a pane). These non-prefixed keys come from
 * BOTMUX_INJECTED_ENV_KEYS; the bare IM-app creds are folded in from
 * REDACTED_CHILD_ENV_KEYS so a server botmux bootstraps can never seed them
 * into its global env either.
 */
export const BOTMUX_INJECTED_ENV_KEYS = [
  '__OWNER_OPEN_ID',
  'BOTMUX',
  'SESSION_DATA_DIR',
  'IS_SANDBOX',
  // botmux ask/hooks use these to locate the daemon and route back to the
  // current session/thread. The worker refreshes them per pane/turn.
  'BOTMUX_SESSION_ID',
  'BOTMUX_CHAT_ID',
  // v3 host effects / schedule delivery need chatType inside the pane.
  'BOTMUX_CHAT_TYPE',
  'BOTMUX_LARK_APP_ID',
  'BOTMUX_ROOT_MESSAGE_ID',
  'BOTMUX_TURN_ID',
  'BOTMUX_DISPATCH_ATTEMPT',
  // Loopback port of the owning daemon's agent-facing IPC. Read-isolated CLIs
  // (whose daemon discovery dir is Seatbelt-denied) need it to reach the
  // session-scoped, capability-gated routes (v3 workflow relay, vc-agent).
  // A port marker, not a credential — every route authenticates independently.
  'BOTMUX_DAEMON_IPC_PORT',
  // Keep `botmux bots list` and ready-gated CLIs aligned with daemon config.
  'BOTMUX_LARK_LIST_BOTS_API_ENABLED',
  'BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS',
  'BOTMUX_READY_COMMAND',
  // Hermes profile roots must match the worker-side transcript reader.
  'HERMES_HOME',
  'HERMES_BOTMUX_SOURCE_HOME',
  'HERMES_BOTMUX_PROFILES_ROOT',
  // Per-bot isolated data roots for Claude/Codex.
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  // CLI-specific non-interactive/resume startup controls.
  'CLAUDE_CODE_RESUME_TOKEN_THRESHOLD',
  'CJADK_INTERACTIVE',
] as const;

const TMUX_CLIENT_STRIP_KEYS: ReadonlySet<string> = new Set([
  ...BOTMUX_INJECTED_ENV_KEYS,
  ...REDACTED_CHILD_ENV_KEYS,
]);

/**
 * True for any env key botmux manages and must keep out of the (shared) tmux
 * server global environment. Used by tmuxEnv() to strip the tmux client env and
 * by scrubTmuxServerGlobalEnv() to clean an already-polluted server.
 */
export function isBotmuxManagedTmuxEnvKey(key: string): boolean {
  return key.startsWith('BOTMUX') || TMUX_CLIENT_STRIP_KEYS.has(key);
}

/**
 * Build the base environment for a spawned CLI child: copy the worker's env
 * and REMOVE the keys in REDACTED_CHILD_ENV_KEYS.
 *
 * Why `delete` and not `{ ...env, KEY: undefined }`: node-pty stringifies an
 * `undefined` env value to the literal string "undefined" rather than omitting
 * the key (verified against the bundled node-pty). So `{ ...env, LARK_APP_ID:
 * undefined }` hands the child `LARK_APP_ID="undefined"` — still truthy, so any
 * SDK probing `process.env.LARK_APP_ID` takes the Lark path with appId
 * "undefined". Only deleting the key truly unsets it.
 *
 * NOTE: this covers the PTY path and the tmux *client* env. The tmux *server*
 * global-env vector is closed separately by the wrapper's `unset` — see the
 * comment on REDACTED_CHILD_ENV_KEYS.
 *
 * Returns a fresh object; the input env is not mutated.
 */
export function redactChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of REDACTED_CHILD_ENV_KEYS) delete env[key];
  return env;
}
