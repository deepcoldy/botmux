/**
 * Build the base environment for a spawned CLI child: copy the worker's env
 * and REMOVE the variables that must never leak into the child.
 *
 * Why `delete` and not `{ ...env, KEY: undefined }`: node-pty stringifies an
 * `undefined` env value to the literal string "undefined" rather than omitting
 * the key (verified against the bundled node-pty). So `{ ...env, LARK_APP_ID:
 * undefined }` hands the child `LARK_APP_ID="undefined"` — still truthy, so any
 * SDK probing `process.env.LARK_APP_ID` takes the Lark path with appId
 * `"undefined"`. The tmux backend leaks it the same way: `tmuxEnv()` spreads
 * this same object into `pty.spawn('tmux', …)`, so the pane inherits the
 * stringified value. Only deleting the key truly unsets it on both backends.
 *
 * Redacted keys:
 * - `LARK_APP_ID` / `LARK_APP_SECRET`: the bot's IM-app creds. The worker keeps
 *   its own copy (worker-pool.ts forkWorker) for `lark-upload` etc., but a child
 *   CLI that ships its own Lark OAuth reads `process.env.LARK_APP_ID` as the app
 *   to authorize and gets hijacked by the botmux IM app (no docs scopes → 403
 *   loop). The child never needs them: `botmux send` loads creds from bots.json
 *   (im/lark/client.ts), `botmux ask` routes via `BOTMUX_LARK_APP_ID`.
 * - `CLAUDECODE`: claude-code's own marker; removed so a spawned claude-code
 *   doesn't believe it's nested inside another claude-code session.
 *
 * Returns a fresh object; the input env is not mutated.
 */
export function redactChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.LARK_APP_ID;
  delete env.LARK_APP_SECRET;
  delete env.CLAUDECODE;
  return env;
}
