/**
 * Decide the child CLI's `LARK_APP_*` environment override.
 *
 * By default botmux does **not** leak the bot's bare `LARK_APP_ID` /
 * `LARK_APP_SECRET` into the spawned CLI. The child resolves Lark through the
 * namespaced `BOTMUX_LARK_APP_ID` (used by `botmux send` / `botmux ask`) or
 * through its own OAuth — never the bare names. A bare `LARK_APP_ID` hijacks
 * CLIs that ship their own Lark SDK / OAuth flow: they read
 * `process.env.LARK_APP_ID` as the app to authorize against, pick up botmux's
 * per-bot *IM* app (no `docs:*` scopes), and every doc fetch then 403s in a
 * loop. The worker process itself is **not** spawned through this path, so it
 * keeps its own bare `LARK_APP_*` for `lark-upload` / `config`.
 *
 * `exposeLarkEnvToChild === true` opts back into the legacy (botmux <= 2.x)
 * behavior — bare `LARK_APP_*` are injected into the child. Use it only when
 * an external skill / wrapper deliberately reads bare `LARK_APP_ID` as the
 * *bot* app id and would otherwise break.
 *
 * The returned object is spread onto the child's `env`; an `undefined` value
 * removes the inherited variable (node-pty drops undefined keys; the tmux
 * backend's `buildBotmuxEnvAssignments` skips them — see tmux-backend.ts).
 */
export function childLarkEnvOverride(
  exposeLarkEnvToChild?: boolean,
): { LARK_APP_ID?: undefined; LARK_APP_SECRET?: undefined } {
  return exposeLarkEnvToChild === true
    ? {}
    : { LARK_APP_ID: undefined, LARK_APP_SECRET: undefined };
}
