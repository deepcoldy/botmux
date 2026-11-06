import { modelPinView, cliMatchesBot, type ModelPin } from './model-pin.js';
import { cliModelSupportsReasoningEffort, reasoningEffortsForCliModel, type CodexReasoningEffort } from '../services/codex-reasoning-effort.js';
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
    modelPin?: ModelPin;
    cliSessionId?: string;
    traexAutoModelRuntime?: TraexAutoModelRuntimeState;
    groupDefaultModels?: GroupDefaultModels;
    scope?: 'thread' | 'chat';
    chatType?: 'group' | 'p2p';
    adoptedFrom?: unknown;
    dispatchLaunchSpec?: { effective: { model: string; reasoningEffort?: CodexReasoningEffort } };
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
  } else if (ds.session.modelPin && cliMatchesBot(ds.session, botCfg)) {
    logicalModel = ds.session.modelPin.model;
  } else {
    const groupModel = resolveSessionGroupSettings(ds, cliId).model;
    if (groupModel) {
      logicalModel = groupModel;
    } else if (!botCfg) {
      logicalModel = ds.session.model;
    } else {
      const sessionCliId = ds.session.cliId;
      logicalModel = cliMatchesBot({ cliId: sessionCliId }, botCfg) ? botCfg.model : ds.session.model;
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
 * underneath it — sessions without a topic pin or group model use the LIVE bot config on every
 * spawn, resume included. Rationale: the model configured in the dashboard is
 * an explicit human choice, and it used to be silently outranked forever by
 * whatever default the session happened to inherit when it was created (the old
 * `session.model` freeze), so a long-running session could never be moved off
 * its original model.
 *
 * Precedence: dispatchLaunchSpec → spawnModelOverride → explicit modelPin
 * (only while cliMatchesBot) → captured group defaults → live bot model
 * (only while cliMatchesBot) → session.model launch record. A pin is a user
 * action, never a frozen copy of a bot default (#773), and can be cleared.
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

/** A topic override is used only for the model it was chosen for. */
export function resolveTopicReasoningEffort(
  session: { topicReasoningEffort?: { model: string; effort: CodexReasoningEffort } },
  cliId: string, model: string | undefined, fallback: CodexReasoningEffort | undefined,
): CodexReasoningEffort | undefined {
  const selected = session.topicReasoningEffort;
  return cliId === 'traex' && selected && typeof selected.model === 'string'
    && selected.model.trim().toLowerCase() === model?.trim().toLowerCase()
    && reasoningEffortsForCliModel(cliId, model).includes(selected.effort) ? selected.effort : fallback;
}

/** Pin effort follows only its model, including when a one-shot override wins. */
export function resolveSessionLaunchEffort(
  ds: LaunchModelSession & { session: { topicReasoningEffort?: { model: string; effort: CodexReasoningEffort } } },
  botCfg: LaunchModelBotConfig | undefined, model: string | undefined,
  fallback: CodexReasoningEffort | undefined,
): CodexReasoningEffort | undefined {
  const cliId = ds.session.cliId ?? botCfg?.cliId ?? '';
  const prior = resolveTopicReasoningEffort(ds.session, cliId, model, fallback);
  const pin = ds.session.modelPin;
  if (pin && ds.session.dispatchLaunchSpec) return ds.session.dispatchLaunchSpec.effective.reasoningEffort;
  if (!pin || !cliMatchesBot(ds.session, botCfg) || pin.model.toLowerCase() !== model?.toLowerCase() || !pin.effort) return prior;
  return cliModelSupportsReasoningEffort(cliId, model, pin.effort) ? pin.effort
    : prior && cliModelSupportsReasoningEffort(cliId, model, prior) ? prior : undefined;
}

/** All presentation surfaces describe the same resolved launch, never just the row. */
export function resolveSessionModelPinView(
  ds: LaunchModelSession & { activeModel?: string; activeReasoningEffort?: string; session: { reasoningEffort?: CodexReasoningEffort; topicReasoningEffort?: { model: string; effort: CodexReasoningEffort } } },
  botCfg?: LaunchModelBotConfig,
) {
  const model = resolveSessionLaunchModel(ds, botCfg);
  const effort = resolveSessionLaunchEffort(ds, botCfg, model, ds.session.reasoningEffort);
  const currentEffort = resolveTopicReasoningEffort(ds.session, ds.session.cliId ?? botCfg?.cliId ?? '', ds.activeModel, undefined)
    ?? ds.session.reasoningEffort ?? ds.activeReasoningEffort;
  return modelPinView(ds.session, botCfg, { spawnModelOverride: ds.spawnModelOverride, model, effort,
    currentModel: ds.activeModel, currentEffort });
}
