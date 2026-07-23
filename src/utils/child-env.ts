/**
 * Env vars that must never reach a spawned CLI child. The bot's IM-app creds
 * (a child CLI's own Lark OAuth reads `process.env.LARK_APP_ID` as the app to
 * authorize and gets hijacked by the botmux IM app → no docs scopes → 403
 * loop), daemon-side GitHub API tokens, and claude-code's nesting marker. The
 * child resolves Lark via the namespaced `BOTMUX_LARK_APP_ID` or via bots.json
 * on disk (im/lark/client.ts); the worker keeps its own bare creds
 * (worker-pool.ts forkWorker) for lark-upload — only the *child* is redacted.
 *
 * Two leak vectors, two layers (both keyed off this list):
 *  - PTY / direct spawn: `redactChildEnv()` deletes them from the env object.
 *  - tmux: the new pane inherits the tmux *server's* global env, which the
 *    client env can't override, so the shell wrapper `unset`s them before exec
 *    (see SHELL_WRAPPER_SCRIPT in tmux-backend.ts).
 */
export const REDACTED_CHILD_ENV_KEYS = [
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'CLAUDECODE',
] as const;

/**
 * Session-level CLI data-root pointers: claude-family → CLAUDE_CONFIG_DIR,
 * codex → CODEX_HOME. Botmux computes these PER SESSION (read isolation pins
 * `<BOT_HOME>/claude|codex`; Seed/Relay pin their fork dirs via adapter
 * spawnEnv), so a value INHERITED from the surrounding environment is always
 * stale. The poisoning path: pm2 persists the env of whichever process ran
 * `botmux start/restart` into every managed app (and into dump.pm2 for
 * resurrect), so one self-upgrade issued from a bot session bakes that
 * session's injected CLAUDE_CONFIG_DIR into ALL daemons and workers — and
 * every non-isolated sibling bot then reads/writes that bot's home. Scrubbed
 * at each process boundary botmux owns: the pm2 invocation env (cli.ts
 * pm2Env), daemon boot (index-daemon.ts) and worker boot (worker.ts) — the
 * boot scrubs cover envs pm2 resurrects from a stale dump. Scrubbing
 * process.env (not just the spawned child's env) keeps worker-side resolvers
 * that consult it dynamically — codex submit confirmation / resume fallback /
 * transcript bridge (services/codex-paths.ts), slash-command discovery
 * (core/command-discovery.ts) — consistent with the CLI child.
 *
 * Do NOT pin a "default" instead of deleting: CLAUDE_CONFIG_DIR=~/.claude is
 * not a no-op — once the var is set, Claude Code reads its state file from
 * $CLAUDE_CONFIG_DIR/.claude.json instead of ~/.claude.json, which lacks
 * hasCompletedOnboarding → every non-isolated session reruns first-run
 * onboarding (theme picker + login).
 *
 * GROK_HOME is deliberately ABSENT: botmux never injects it per session (grok
 * has no per-bot isolation, and per-bot env rejects the key — see
 * core/per-bot-env.ts), so it can never carry a sibling bot's home. Its
 * contract is the opposite of per-session: process-level only, where worker
 * and CLI child must resolve the SAME value (the worker installs ready-gate
 * hooks and drains transcripts under it — see services/grok-paths.ts), so
 * scrubbing it on any single side would split-brain that documented
 * configuration channel.
 */
export const SESSION_CLI_HOME_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;

/** Delete inherited session-level CLI data-root pointers from `env` in place
 *  (see SESSION_CLI_HOME_ENV_KEYS). Values a session actually needs are
 *  computed and re-set AFTER this scrub (worker isolation pins / adapter
 *  spawnEnv). */
export function scrubSessionCliHomeEnv(env: NodeJS.ProcessEnv): void {
  for (const key of SESSION_CLI_HOME_ENV_KEYS) delete env[key];
}

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
  // Session-scoped plugin MCP relay. The worker owns the credential-bearing
  // Gateway; the CLI and its native MCP launcher receive only this socket
  // capability plus a fail-closed marker.
  'BOTMUX_MCP_GATEWAY_SOCKET',
  'BOTMUX_MCP_GATEWAY_REQUIRED',
  // v3 host effects / schedule delivery need chatType inside the pane.
  'BOTMUX_CHAT_TYPE',
  'BOTMUX_LARK_APP_ID',
  'BOTMUX_ROOT_MESSAGE_ID',
  // Session owner (standard name; `__OWNER_OPEN_ID` above is the legacy
  // channel). Custom CLI wrappers read it for per-user permission isolation.
  'BOTMUX_OWNER_OPEN_ID',
  'BOTMUX_TURN_ID',
  'BOTMUX_DISPATCH_ATTEMPT',
  // Pi deferred long-first-prompt extension reads one exact per-session file.
  'BOTMUX_PI_INITIAL_PROMPT_FILE',
  // Loopback port of the owning daemon's agent-facing IPC. Read-isolated CLIs
  // (whose daemon discovery dir is Seatbelt-denied) need it to reach the
  // session-scoped, capability-gated routes (v3 workflow relay, vc-agent).
  // A port marker, not a credential — every route authenticates independently.
  'BOTMUX_DAEMON_IPC_PORT',
  // Fail-closed classification hint for macOS read isolation. This is never
  // authority; cmdSend also checks the host-owned marker + live challenge.
  'BOTMUX_READ_ISOLATED',
  // Unguessable pane/profile authority channel. It selects an exact read carve
  // but is not sufficient without the daemon-rotated capability inside it.
  'BOTMUX_ORIGIN_CHANNEL_ID',
  // Keep `botmux bots list` and ready-gated CLIs aligned with daemon config.
  'BOTMUX_LARK_LIST_BOTS_API_ENABLED',
  'BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS',
  'BOTMUX_READY_COMMAND',
  // Path to a one-shot 0600 Codex App control bootstrap. Only the path reaches
  // the pane; the runner consumes+unlinks the file before app-server starts.
  'BOTMUX_CODEX_APP_CONTROL_BOOTSTRAP',
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

/** Proxy env vars that must reach the CLI child process so it can dial the
 *  upstream API on hosts without direct internet access. Forwarded explicitly
 *  by buildBotmuxEnvAssignments (tmux/tmux-pipe/zellij backends) and
 *  prepareSandbox (bwrap); the pty backend inherits them via the full child env.
 *  Deliberately NOT in BOTMUX_INJECTED_ENV_KEYS: that list drives tmuxEnv()
 *  stripping and scrubTmuxServerGlobalEnv() cleanup — adding proxy keys there
 *  would delete the user's own tmux server proxy config. */
export const PROXY_ENV_KEYS = [
  'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY',
  'no_proxy', 'NO_PROXY', 'all_proxy', 'ALL_PROXY',
] as const;

const TMUX_CLIENT_STRIP_KEYS: ReadonlySet<string> = new Set([
  ...BOTMUX_INJECTED_ENV_KEYS,
  ...REDACTED_CHILD_ENV_KEYS,
  // Strip proxy vars from the tmux CLIENT env so botmux doesn't seed the
  // shared server's global env with daemon-side proxy (which may contain
  // embedded credentials) and leak it to the user's own interactive panes.
  // Deliberately NOT in TMUX_SERVER_GLOBAL_SCRUB_KEYS: we must not delete
  // proxy config the user set on their own tmux server. Per-pane injection
  // via buildBotmuxEnvAssignments reads opts.env directly, so it's unaffected
  // by this client-side strip.
  ...PROXY_ENV_KEYS,
]);

const TMUX_SERVER_GLOBAL_SCRUB_KEYS: ReadonlySet<string> = new Set([
  ...BOTMUX_INJECTED_ENV_KEYS,
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  'CLAUDECODE',
]);

/**
 * True for any env key botmux must keep out of the tmux CLIENT env it hands to
 * the `tmux` binary. This is stricter than server-global scrub: besides
 * botmux-owned routing/profile vars, we also strip daemon-side GitHub tokens so
 * a botmux-started tmux server never seeds them into its shared global env.
 */
export function isBotmuxManagedTmuxEnvKey(key: string): boolean {
  return key.startsWith('BOTMUX') || TMUX_CLIENT_STRIP_KEYS.has(key);
}

/**
 * True for env keys botmux is allowed to repair out of an already-running tmux
 * SERVER global environment. This intentionally excludes user-wide GitHub
 * tokens: botmux panes must `unset` them locally, but daemon startup must not
 * rewrite a shared tmux server's general-purpose env table.
 */
export function isBotmuxManagedTmuxServerGlobalEnvKey(key: string): boolean {
  return key.startsWith('BOTMUX') || TMUX_SERVER_GLOBAL_SCRUB_KEYS.has(key);
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
