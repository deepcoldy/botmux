/**
 * Session-identity markers Claude Code exports into every Bash child it runs
 * (`CLAUDECODE` plus the `CLAUDE_CODE_*`/`CLAUDE_PID` family). Any process
 * started from inside a Claude session inherits them, and outside that session
 * they are always stale. The destructive one is CLAUDE_CODE_CHILD_SESSION: a
 * claude CLI that sees it treats itself as a nested subagent session and
 * silently turns OFF transcript persistence — which breaks `--resume`-based
 * continuity (respawn after a tmux session dies, role switch) for every bot.
 *
 * The poisoning path mirrors SESSION_CLI_HOME_ENV_KEYS: pm2 persists the env
 * of whichever process ran `botmux start/restart` (or raw `pm2 start`) into
 * every managed app, so one self-upgrade issued from a bot session bakes the
 * issuing session's markers into all daemons; the next time the shared tmux
 * server is (re)born it forks from the poisoned daemon, seeds its global env
 * with the markers, and every bot CLI on the machine stops saving transcripts.
 *
 * CLAUDE_EFFORT is deliberately absent: it is a behavior knob a user or
 * per-bot env may legitimately set, not a session-identity marker.
 */
export const CLAUDE_SESSION_MARKER_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
] as const;

/**
 * Runtime markers that belong only to a v3 workflow/goal worker.
 *
 * A workflow worker may invoke `botmux restart`; PM2 persists that caller env
 * into the long-lived daemons. If these keys survive, every ordinary worker
 * forked by those daemons mistakes itself for a workflow worker: it skips
 * screen/status updates and goal-only CLI restrictions leak into chat
 * sessions. Keep the complete file-backed goal contract together with the
 * workflow identity fields so a partial scrub cannot leave a normal worker in
 * a hybrid mode.
 *
 * Do not apply this scrub at worker.ts boot: real workflow workers share that
 * entry point and receive these keys explicitly from the ephemeral pool.
 */
export const WORKFLOW_WORKER_ENV_KEYS = [
  'BOTMUX_WORKFLOW',
  'BOTMUX_WORKFLOW_PTY_LOG_PATH',
  'BOTMUX_WORKFLOW_RUN_ID',
  'BOTMUX_WORKFLOW_NODE_ID',
  'BOTMUX_GOAL_PATH',
  'BOTMUX_GOAL_INPUTS_PATH',
  'BOTMUX_GOAL_OUTPUT_DIR',
  'BOTMUX_GOAL_MANIFEST_PATH',
  'BOTMUX_GOAL_ATTEMPT_DIR',
  'BOTMUX_V3_GOAL',
] as const;

/** Remove workflow-only identity from a non-workflow process boundary. */
export function scrubWorkflowWorkerEnv(env: NodeJS.ProcessEnv): void {
  for (const key of WORKFLOW_WORKER_ENV_KEYS) delete env[key];
}

/** Boundary-only companion to the markers. A CLAUDE_EFFORT inherited THROUGH
 *  pm2 → daemon → worker is indistinguishable from the issuing Claude
 *  session's own override and would silently pin that session's
 *  behavior/cost/latency onto every bot, so the boundary scrub drops it. It
 *  stays OUT of REDACTED_CHILD_ENV_KEYS / the pane unset / the server-global
 *  scrub, which keeps the supported config channels working: per-bot `env`
 *  (injected after redact on every backend, PTY included) and — on the
 *  shell-wrapped backends (tmux/zellij) — the pane shell's own profile. The
 *  ambient "export it in the shell that runs `botmux start`" channel is
 *  deliberately sacrificed: at that boundary it cannot be told apart from
 *  contamination. */
const BOUNDARY_ONLY_CLAUDE_ENV_KEYS = ['CLAUDE_EFFORT'] as const;

/** Delete inherited Claude session markers (CLAUDE_SESSION_MARKER_ENV_KEYS,
 *  plus BOUNDARY_ONLY_CLAUDE_ENV_KEYS) from `env` in place. Called at the same
 *  botmux-owned process boundaries as scrubSessionCliHomeEnv — pm2 invocation
 *  env (cli.ts pm2Env), daemon boot (index-daemon.ts), worker boot (worker.ts)
 *  — so a daemon (re)started from inside a Claude session never carries that
 *  session's identity into anything it forks (workers, the shared tmux
 *  server). */
export function scrubClaudeSessionMarkerEnv(env: NodeJS.ProcessEnv): void {
  for (const key of CLAUDE_SESSION_MARKER_ENV_KEYS) delete env[key];
  for (const key of BOUNDARY_ONLY_CLAUDE_ENV_KEYS) delete env[key];
}

/**
 * Env vars that must never reach a spawned CLI child. The bot's IM-app creds
 * (a child CLI's own Lark OAuth reads `process.env.LARK_APP_ID` as the app to
 * authorize and gets hijacked by the botmux IM app → no docs scopes → 403
 * loop), daemon-side GitHub API tokens, and claude-code's session markers
 * (CLAUDE_SESSION_MARKER_ENV_KEYS). The
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
  ...CLAUDE_SESSION_MARKER_ENV_KEYS,
  // Parent-tmux client vars: when the daemon itself was started inside a tmux
  // session, process.env carries TMUX (server socket path) + TMUX_PANE. Leaking
  // these into a spawned CLI makes tmux-aware tools (codex integrates with tmux)
  // try to talk to the daemon's PARENT tmux server — which does not exist inside
  // the file sandbox (fresh /tmp tmpfs), so the connect() ENOENTs and the CLI
  // aborts with "No such file or directory (os error 2)". The tmux/tmux-pipe
  // backends already strip these for their OWN pane launch via tmuxEnv(), but the
  // sandbox path injects childEnv straight into the pane's env(1), so strip at
  // the source. Non-tmux CLIs are unaffected (they don't read TMUX).
  'TMUX',
  'TMUX_PANE',
  // PM2 graceful-exit sentinel (BOTMUX_PM2_GRACEFUL_EXIT_CODE, defined as
  // PM2_GRACEFUL_EXIT_CODE_ENV in pm2-graceful-exit.ts). pm2 bakes it into the
  // daemon/dashboard env so ONLY those two managed cores exit with the sentinel
  // code (90) on graceful stop instead of 0 — otherwise a signal-killed daemon's
  // null→0 code would match stop_exit_codes and suppress crash-autorestart. But
  // it must never reach a session's CLI child: a foreground `botmux serve
  // --api-only` / `daemon` / `dashboard` launched from inside a bot session would
  // inherit the marker and, per gracefulProcessExitCode(), exit 90 on a clean
  // Ctrl+C — a supervisor/launcher then misreads that non-zero code as a crash.
  // Only daemon.ts + dashboard.ts read this key, so stripping it at the child
  // boundary is safe. Kept as a string literal (like the keys above) with a
  // drift-guard test pinning it to PM2_GRACEFUL_EXIT_CODE_ENV.
  'BOTMUX_PM2_GRACEFUL_EXIT_CODE',
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

/**
 * Pin the daemon-selected session owner under the public BOTMUX_* contract and
 * the legacy private name used by older wrappers. ownerOpenId is the only
 * authority: every worker backend must call this after config-controlled env
 * merges, and an ownerless session must delete both keys. Otherwise a managed
 * CLI can observe a stale/different app-scoped owner across backends.
 */
export function applySessionOwnerEnv(
  env: NodeJS.ProcessEnv,
  ownerOpenId: string | undefined,
): void {
  if (ownerOpenId) {
    env.BOTMUX_OWNER_OPEN_ID = ownerOpenId;
    env.__OWNER_OPEN_ID = ownerOpenId;
    return;
  }
  delete env.BOTMUX_OWNER_OPEN_ID;
  delete env.__OWNER_OPEN_ID;
}

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
  // The EXACT bots.json the daemon loaded (getLoadedConfigPath, frozen host-side
  // and pinned by spawnCli). Injected so a CLI child reads the SAME registry even
  // when the daemon runs under a non-default HOME (`HOME=~/alt botmux start`): the
  // child inherits cwd and the BOTMUX_* family but never HOME, so without this it
  // resolves the *default* ~/.botmux, misses its own appId, and every `botmux
  // send` from inside that session fails "Bot not registered". A path, not a
  // credential (the file it names holds secrets; the name does not).
  //
  // Being on THIS list is load-bearing in three separate ways, so do not move it:
  //  · buildBotmuxEnvAssignments forwards it into tmux/zellij panes (without it,
  //    only the pty backend would be fixed);
  //  · isBotmuxManagedTmuxEnvKey strips it from the tmux CLIENT env, so botmux
  //    never seeds a shared server's GLOBAL env with a fleet's registry path;
  //  · PANE_ENV_UNSET_CLAUSE unsets it in the pane wrapper, so a stale value
  //    already in a co-tenant server's global env cannot outrank the pinned one
  //    (BOTS_CONFIG is the TOP of the registry precedence chain — a stale value
  //    silently redirects the child to a foreign registry).
  'BOTS_CONFIG',
  'BOTMUX_ROOT_MESSAGE_ID',
  // Session owner (standard name; `__OWNER_OPEN_ID` above is the legacy
  // channel). Custom CLI wrappers read it for per-user permission isolation.
  'BOTMUX_OWNER_OPEN_ID',
  'BOTMUX_TURN_ID',
  'BOTMUX_DISPATCH_ATTEMPT',
  // Resolved display footer for sandboxed `botmux send`; avoids reading the
  // credential-bearing bots.json from inside the child.
  'BOTMUX_BRAND_LABEL',
  // Read-isolation marker + host-owned apiOnly verdict. Both are decided by the
  // worker (gated on sandboxRequested / cfg.apiOnly) and MUST reach the child:
  // inside the sandbox bots.json is denied, so the CLI has no other way to tell
  // "denied because I'm sandboxed (expected)" from "unreadable (real fault)", nor
  // to know its own apiOnly (a no-transport bot's send-cred.json is denied too).
  // Being on this list also means tmuxEnv()/scrubTmuxServerGlobalEnv() strip them
  // when unset — so a stale value cannot leak into a NON-sandboxed pane.
  'BOTMUX_READ_ISOLATION',
  'BOTMUX_API_ONLY',
  // Per-bot display preference for Context / Token usage
  // ('streaming' | 'footer' | 'off'). Injected explicitly so sandboxed offline
  // fallback cannot drift to the default when bots.json is unreadable.
  'BOTMUX_USAGE_DISPLAY',
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
 *  prepareDirectSandbox (bwrap --setenv); the pty backend inherits them via the
 *  full child env.
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
  // Claude session markers are stale by definition in a server's GLOBAL env
  // table (they can only have been seeded by whatever process booted the
  // server), so unlike user-wide GitHub tokens they are safe to repair out of
  // an already-running server — this is what heals a fleet whose tmux server
  // was born from a poisoned daemon without waiting for the server to die.
  ...CLAUDE_SESSION_MARKER_ENV_KEYS,
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
