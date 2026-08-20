import type { CliId } from '../adapters/cli/types.js';

/** Minimal shape of the runtime session needed to resolve a launch model. */
export type LaunchModelSession = {
  session: { cliId?: CliId; model?: string };
  spawnModelOverride?: string;
};

/** Minimal shape of the live bot config needed to resolve a launch model. */
export type LaunchModelBotConfig = { cliId?: CliId; model?: string };

/**
 * The model botmux passes to the CLI for a given session's next spawn.
 *
 * Unlike `cliId` / `cliRuntime` / `wrapperCli` — which are frozen onto the
 * session at creation so a live conversation never has its runtime swapped
 * underneath it — the model is resolved from the LIVE bot config on every
 * spawn, resume included. Rationale: the model configured in the dashboard is
 * an explicit human choice, and it used to be silently outranked forever by
 * whatever default the session happened to inherit when it was created (the old
 * `session.model` freeze), so a long-running session could never be moved off
 * its original model.
 *
 * Precedence:
 *   1. `spawnModelOverride` — an explicit per-trigger choice (trigger API
 *      `options.model`), in-memory only, see DaemonSession.
 *   2. the live bot config, **only when the session's frozen `cliId` still
 *      matches the bot's** — a session pinned to another CLI (a bot that
 *      switched CLI later, or a Codex App thread takeover that forces
 *      `codex-app`) must not be handed a model string meant for a different
 *      CLI.
 *   3. the model this session was last launched with (`session.model`, stamped
 *      by sessionAgentConfig on every spawn), as a last resort for exactly that
 *      mismatch case: it is the value that CLI actually ran with. Never
 *      consulted while the live config applies, which is what makes a dashboard
 *      edit effective on old sessions.
 *
 * `undefined` → botmux passes no model flag and the CLI resolves its own
 * default (for `claude --resume`, that means the model recorded in the
 * transcript).
 */
export function resolveSessionLaunchModel(
  ds: LaunchModelSession,
  botCfg?: LaunchModelBotConfig,
): string | undefined {
  if (ds.spawnModelOverride) return ds.spawnModelOverride;
  // No live config to consult (deregistered bot / display surfaces that tolerate
  // a missing registry entry) → the session's own record is the best we have.
  if (!botCfg) return ds.session.model;
  const sessionCliId = ds.session.cliId;
  const cliMatchesBot = !sessionCliId || !botCfg.cliId || sessionCliId === botCfg.cliId;
  return cliMatchesBot ? botCfg.model : ds.session.model;
}
