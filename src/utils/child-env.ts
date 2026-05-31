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
