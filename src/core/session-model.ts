import { groupModelSettings, type GroupDefaultModels, type GroupModelSettings } from './group-default-models.js';
import type { CliId } from '../adapters/cli/types.js';
import {
  TRAEX_AUTO_MODEL_ID,
  validTraexAutoModelRuntime,
  type TraexAutoModelConfig,
  type TraexAutoModelRuntimeState,
} from '../services/traex-auto-model.js';

/** Minimal shape of the runtime session needed to resolve a launch model. */
export type LaunchModelSession = {
  session: {
    cliId?: CliId;
    model?: string;
    cliSessionId?: string;
    traexAutoModelRuntime?: TraexAutoModelRuntimeState;
    groupDefaultModels?: GroupDefaultModels;
    scope?: 'thread' | 'chat';
    chatType?: 'group' | 'p2p';
    adoptedFrom?: unknown;
    dispatchLaunchSpec?: { effective: { model: string } };
  };
  spawnModelOverride?: string;
};

/** Scope is checked at launch: some creation paths assign it after creating the row. */
export function resolveSessionGroupSettings(ds: LaunchModelSession, cliId: string | undefined): GroupModelSettings {
  const isTopic = ds.session.scope !== 'chat' && ds.session.chatType !== 'p2p' && !ds.session.adoptedFrom;
  return isTopic && (cliId === 'codex' || cliId === 'claude-code')
    ? groupModelSettings(ds.session.groupDefaultModels?.[cliId]) : {};
}

/** Minimal shape of the live bot config needed to resolve a launch model. */
export type LaunchModelBotConfig = {
  cliId?: CliId;
  model?: string;
  traexAutoModel?: TraexAutoModelConfig;
};

export type SessionLaunchModelChoice = {
  model?: string;
  traexAutoModel?: TraexAutoModelConfig;
};

/**
 * Resolve both the concrete launch model and the optional virtual-auto policy.
 *
 * `auto` is reserved as a BotMux virtual model for TraeX. It is never forwarded
 * to the CLI. A valid ordered allowlist resolves it to the first model; a
 * missing/invalid policy resolves to no model instead of accidentally asking
 * TraeX or a future provider to interpret a different `auto` meaning.
 */
export function resolveSessionLaunchModelChoice(
  ds: LaunchModelSession,
  botCfg?: LaunchModelBotConfig,
): SessionLaunchModelChoice {
  const cliId = ds.session.cliId ?? botCfg?.cliId;
  let logicalModel: string | undefined;
  if (ds.session.dispatchLaunchSpec) {
    logicalModel = ds.session.dispatchLaunchSpec.effective.model;
  } else if (ds.spawnModelOverride) {
    logicalModel = ds.spawnModelOverride;
  } else {
    const groupModel = resolveSessionGroupSettings(ds, cliId).model;
    if (groupModel) {
      logicalModel = groupModel;
    } else if (!botCfg) {
      logicalModel = ds.session.model;
    } else {
      const sessionCliId = ds.session.cliId;
      const cliMatchesBot = !sessionCliId || !botCfg.cliId || sessionCliId === botCfg.cliId;
      logicalModel = cliMatchesBot ? botCfg.model : ds.session.model;
    }
  }

  if (cliId !== 'traex' || logicalModel?.trim().toLowerCase() !== TRAEX_AUTO_MODEL_ID) {
    return { model: logicalModel };
  }
  const auto = botCfg?.traexAutoModel;
  if (!auto?.enabled || auto.models.length === 0) return {};
  const runtime = ds.session.traexAutoModelRuntime;
  return {
    model: validTraexAutoModelRuntime(auto, runtime, ds.session.cliSessionId) ? runtime.model : auto.models[0],
    traexAutoModel: auto,
  };
}

/**
 * The model botmux passes to the CLI for a given session's next spawn.
 *
 * Unlike `cliId` / `cliRuntime` / `wrapperCli` — which are frozen onto the
 * session at creation so a live conversation never has its runtime swapped
 * underneath it — sessions without a group model use the LIVE bot config on every
 * spawn, resume included. Rationale: the model configured in the dashboard is
 * an explicit human choice, and it used to be silently outranked forever by
 * whatever default the session happened to inherit when it was created (the old
 * `session.model` freeze), so a long-running session could never be moved off
 * its original model.
 *
 * Precedence:
 *   1. `spawnModelOverride` — an explicit per-trigger choice (trigger API
 *      `options.model`), in-memory only, see DaemonSession.
 *   2. the group default captured at topic creation, for the selected CLI.
 *      Later group edits never alter this snapshot.
 *   3. the live bot config, **only when the session's frozen `cliId` still
 *      matches the bot's** — a session pinned to another CLI (a bot that
 *      switched CLI later, or a Codex App thread takeover that forces
 *      `codex-app`) must not be handed a model string meant for a different
 *      CLI.
 *   4. the model this session was last launched with (`session.model`, stamped
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
  return resolveSessionLaunchModelChoice(ds, botCfg).model;
}
