import { isConfigurableReasoningCliId, reasoningEffortsForCliModel } from '../../services/codex-reasoning-effort.js';
/** Model catalogue and picker shared by /models and the optional reply menu. */
import type { DaemonSession } from '../../core/types.js';
import { getBot, type BotConfig } from '../../bot-registry.js';
import { CONFIG_UNSET } from './card-builder.js';
import { botAcceptsLaunchModel } from '../../core/launch-model-capability.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { staticModelChoices, detectModels, mergeModelChoices } from '../../services/model-catalog.js';
import { modelCatalogProbeContext } from '../../dashboard/model-catalog-request.js';
import { selectionKeyForBot } from '../../setup/cli-selection.js';
import { t, type Locale } from '../../i18n/index.js';
import { cliHasNoRawPassthroughSurface } from '../../core/passthrough-commands.js';
import { canOperate } from './event-dispatcher.js';
import { deliverEphemeralOrReply, isSessionTransferring, topicReasoningControl } from '../../core/worker-pool.js';

function sessionCliId(ds: DaemonSession) {
  return ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? getBot(ds.larkAppId).config.cliId;
}

export const MODEL_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/**
 * Resolve the model-catalogue selection for THIS session's frozen CLI shape.
 * The catalogue functions take a "selection key" (cliId + wrapperCli +
 * launchMode), not a bare cliId — probing a `ttadk codex` session with the
 * bare 'codex' key returns the native codex list instead of the gateway's.
 * Probe inputs (custom executable, injected env, runtime cache identity) are
 * derived through the same helper as the dashboard endpoint so the menu sees
 * exactly the runtime the session is running.
 */
function resolveModelCatalogue(key: string, botConfig: BotConfig): {
  key: string;
  staticChoices: readonly string[];
  detect: () => Promise<readonly string[] | null>;
} {
  const probe = modelCatalogProbeContext(key, botConfig, process.env);
  return {
    key,
    staticChoices: staticModelChoices(key),
    detect: () => detectModels(key, {
      runtimeContext: probe.runtimeContext,
      probeEnv: probe.probeEnv,
      runtimeExecutable: probe.runtimeExecutable,
      adapterFactory: requestedCliId => createCliAdapterSync(
        requestedCliId,
        requestedCliId === probe.cliId ? probe.runtimeExecutable : undefined,
      ),
    }),
  };
}

/** One accept rule shared by the picker render and the submission whitelist:
 * live non-empty wins, otherwise the curated static list. Building both from
 * this keeps the offered options and the inject whitelist on identical terms. */
export async function sessionModelChoices(ds: DaemonSession): Promise<readonly string[]> {
  const key = selectionKeyForBot(sessionCliId(ds), ds.session.wrapperCli, ds.session.cliLaunchMode);
  const catalogue = resolveModelCatalogue(key, getBot(ds.larkAppId).config);
  const live = await catalogue.detect().catch(() => null);
  return mergeModelChoices(catalogue.staticChoices, live).models;
}

export function buildSessionModelPickerCard(
  ds: DaemonSession,
  rootId: string,
  models: readonly string[],
  currentModel: string | undefined,
  loc: Locale,
  action: 'reply_model_pick' | 'session_model_pick' = 'reply_model_pick',
): string {
  // Only render slugs the inject path would accept: a live-detected catalogue
  // entry with exotic characters must not render into a dead option.
  const safeModels = models.filter(model => MODEL_SLUG_PATTERN.test(model));
  const effort = action === 'session_model_pick' ? topicReasoningControl(ds) : undefined;
  const effortBinding = {
    session_id: ds.session.sessionId, root_id: rootId, lark_app_id: ds.larkAppId, chat_id: ds.chatId,
    expected_model: currentModel ?? '',
    expected_effort: ds.session.topicReasoningEffort?.effort ?? '',
    expected_effort_model: ds.session.topicReasoningEffort?.model ?? '',
    worker_generation: String(ds.workerGeneration ?? 0), cli_generation: String(ds.cliReadyGeneration ?? 0),
  };
  const effortElements = effort && effort.choices.length ? [
    { tag: 'div', text: { tag: 'plain_text', content: t('card.topic_effort.title', undefined, loc) } },
    { tag: 'action', actions: [{ tag: 'select_static',
      placeholder: { tag: 'plain_text', content: effort.selected ?? t('card.topic_effort.title', undefined, loc) },
      ...(effort.selected && effort.choices.includes(effort.selected) ? { initial_option: effort.selected } : {}),
      options: effort.choices.map(level => ({ text: { tag: 'plain_text', content: level }, value: level })),
      value: { action: 'session_effort_pick', ...effortBinding },
    }] },
    { tag: 'div', text: { tag: 'plain_text', content: t('card.topic_effort.state', { active: effort.active ?? '—', selected: effort.selected ?? '—' }, loc) } },
    ...(effort.pending ? [
      { tag: 'div', text: { tag: 'plain_text', content: t('card.topic_effort.reload_note', undefined, loc) } },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: t('card.topic_effort.apply', undefined, loc) },
        value: { action: 'session_effort_apply', effort: effort.selected, ...effortBinding },
      }] },
    ] : []),
  ] : [];
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'markdown', content: `**${t('card.reply_actions.model_title', undefined, loc)}**` },
      {
        tag: 'action',
        actions: [{
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: currentModel || t('card.reply_actions.model', undefined, loc) },
          ...(currentModel && safeModels.includes(currentModel) ? { initial_option: currentModel } : {}),
          options: safeModels.slice(0, 50).map(model => ({
            text: {
              tag: 'plain_text',
              content: model === currentModel
                ? `${model} ${t('card.reply_actions.model_current', undefined, loc)}`
                : model,
            },
            value: model,
          })),
          value: { action, session_id: ds.session.sessionId, root_id: rootId, lark_app_id: ds.larkAppId, chat_id: ds.chatId },
        }],
      },
      ...effortElements,
    ],
  });
}

/** Read-only shortcut: opening the picker never starts a CLI or changes a model. */
export async function showSessionModelPicker(
  ds: DaemonSession,
  rootId: string,
  operatorOpenId: string,
  operatorUnionId: string | undefined,
  reply: (rootId: string, content: string, msgType?: string) => Promise<string>,
  loc: Locale,
): Promise<void> {
  let notice: string | undefined;
  if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId, operatorUnionId)) {
    notice = t('daemon.cmd_allowed_users_only', { cmd: '/models' }, loc);
  } else if (isSessionTransferring(ds)) {
    notice = t('cmd.session.transfer_in_progress', undefined, loc);
  } else if (!ds.worker || ds.worker.killed) {
    notice = t('daemon.cmd_needs_active_cli', { cmd: '/models' }, loc);
  } else if (cliHasNoRawPassthroughSurface(sessionCliId(ds), { dshRuntime: getBot(ds.larkAppId).config.dshRuntime })) {
    notice = t('card.reply_actions.model_unsupported', undefined, loc);
  }
  if (notice) { await reply(rootId, notice); return; }
  const models = (await sessionModelChoices(ds)).filter(model => MODEL_SLUG_PATTERN.test(model));
  const card = models.length > 0
    ? buildSessionModelPickerCard(ds, rootId, models,
      ds.activeModel?.trim() || ds.session.model?.trim() || undefined, loc, 'session_model_pick')
    : JSON.stringify({ config: { wide_screen_mode: true }, elements: [
      { tag: 'markdown', content: t('card.reply_actions.model_empty', undefined, loc) },
    ] });
  await deliverEphemeralOrReply(ds, operatorOpenId, card, 'interactive', () => reply(rootId, card, 'interactive'));
}

export function defaultModelSelectionKey(appId: string): string {
  const cfg = getBot(appId).config;
  return selectionKeyForBot(cfg.cliId, cfg.wrapperCli, cfg.cliLaunchMode);
}

export async function defaultModelChoices(appId: string): Promise<readonly string[]> {
  const cfg = getBot(appId).config;
  const key = selectionKeyForBot(cfg.cliId, cfg.wrapperCli, cfg.cliLaunchMode);
  const catalogue = resolveModelCatalogue(key, cfg);
  const live = await catalogue.detect().catch(() => null);
  return mergeModelChoices(catalogue.staticChoices, live).models;
}

export function buildDefaultModelPickerCard(
  appId: string,
  models: readonly string[],
  currentModel: string | undefined,
  loc: Locale,
  selectionKey: string,
  reasoning?: { cliId: string; effort?: string },
): string {
  const safe = [...new Set(models)].filter(model => MODEL_SLUG_PATTERN.test(model));
  if (currentModel && MODEL_SLUG_PATTERN.test(currentModel)) {
    const existing = safe.indexOf(currentModel);
    if (existing >= 0) safe.splice(existing, 1);
    safe.unshift(currentModel);
  }
  const choices = [{ text: t('card.models.cli_default', undefined, loc), value: CONFIG_UNSET },
    ...safe.slice(0, 49).map(model => ({ text: model, value: model }))];
  const initial = currentModel && choices.some(c => c.value === currentModel) ? currentModel : CONFIG_UNSET;
  const efforts = reasoning ? reasoningEffortsForCliModel(reasoning.cliId, currentModel) : [];
  const effortControls = reasoning && isConfigurableReasoningCliId(reasoning.cliId) ? [
    { tag: 'div', text: { tag: 'plain_text', content: t('card.models.effort_title', undefined, loc) } },
    { tag: 'action', actions: [{ tag: 'select_static',
      initial_option: efforts.some(effort => effort === reasoning.effort) ? reasoning.effort : CONFIG_UNSET,
      placeholder: { tag: 'plain_text', content: reasoning.effort || t('card.models.effort_default', undefined, loc) },
      options: [{ text: { tag: 'plain_text', content: t('card.models.effort_default', undefined, loc) }, value: CONFIG_UNSET },
        ...efforts.map(effort => ({ text: { tag: 'plain_text', content: effort }, value: effort }))],
      value: { action: 'models_default_effort_pick', lark_app_id: appId,
        selection_key: selectionKey, expected_model: currentModel?.trim() || '', loc },
    }] },
    ...(efforts.length ? [] : [{ tag: 'div', text: { tag: 'plain_text', content: t('card.models.effort_unavailable', undefined, loc) } }]),
  ] : [];

  return JSON.stringify({ config: { wide_screen_mode: true }, elements: [
    { tag: 'markdown', content: t('card.models.default_title', undefined, loc) },
    { tag: 'div', text: { tag: 'plain_text', content: t('card.models.default_effect', undefined, loc) } },
    { tag: 'action', actions: [{ tag: 'select_static',
      initial_option: initial,
      placeholder: { tag: 'plain_text', content: currentModel || t('card.models.cli_default', undefined, loc) },
      options: choices.map(c => ({ text: { tag: 'plain_text', content: c.text }, value: c.value })),
      value: { action: 'models_default_pick', lark_app_id: appId, selection_key: selectionKey, loc },
    }] },
    ...effortControls,
  ] });
}

/** Bot defaults use the same strict admin gate as /botconfig, not chat grants. */
export async function showDefaultModelPicker(
  appId: string,
  rootId: string,
  operatorOpenId: string,
  reply: (rootId: string, content: string, msgType?: string) => Promise<string>,
  loc: Locale,
): Promise<void> {
  const bot = getBot(appId);
  if (!bot.resolvedAllowedUsers.length || !bot.resolvedAllowedUsers.includes(operatorOpenId)) {
    await reply(rootId, t('cmd.config.not_admin', undefined, loc));
    return;
  }
  if (!botAcceptsLaunchModel(bot.config)) {
    await reply(rootId, t('card.models.default_unsupported', undefined, loc));
    return;
  }
  const selectionKey = defaultModelSelectionKey(appId);
  const models = await defaultModelChoices(appId);
  // Reading the catalogue can yield; re-read defaults and permission for display.
  const current = getBot(appId);
  if (!current.resolvedAllowedUsers.includes(operatorOpenId)) {
    await reply(rootId, t('cmd.config.not_admin', undefined, loc));
    return;
  }
  if (defaultModelSelectionKey(appId) !== selectionKey || !botAcceptsLaunchModel(current.config)) {
    await reply(rootId, t('card.models.changed', undefined, loc));
    return;
  }
  await reply(rootId, buildDefaultModelPickerCard(appId, models, current.config.model, loc, selectionKey, { cliId: current.config.cliId, effort: current.config.reasoningEffort }), 'interactive');
}
