import { resolveSessionLaunchModel, resolveSessionModelPinView } from '../../core/session-model.js';
import { modelPinText } from '../../core/model-pin.js';
import { isCodexReasoningEffort, isConfigurableReasoningCliId, reasoningEffortsForCliModel } from '../../services/codex-reasoning-effort.js';
/** Model catalogue and picker shared by /models and the optional reply menu. */
import type { DaemonSession } from '../../core/types.js';
import { getBot, type BotConfig } from '../../bot-registry.js';
import { CONFIG_UNSET } from './card-builder.js';
import { botAcceptsLaunchModel } from '../../core/launch-model-capability.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { staticModelChoices, detectModels, mergeModelChoices } from '../../services/model-catalog.js';
import { modelCatalogProbeContext } from '../../dashboard/model-catalog-request.js';
import { isTtadkWrapper, lookupCliSelectionForBotShape, selectionKeyForBot, ttadkAcceptsModel } from '../../setup/cli-selection.js';
import { t, type Locale } from '../../i18n/index.js';
import { cliHasNoRawPassthroughSurface } from '../../core/passthrough-commands.js';
import { canOperate } from './event-dispatcher.js';
import { deliverEphemeralOrReply, isSessionTransferring, sessionReasoningControl, sessionUsesClaudeCode, supportsClaudeSessionSettings, topicReasoningControl } from '../../core/worker-pool.js';
import { readTraexModelLoads } from '../../services/traex-model-load.js';
import { isRemoteBackendId } from '../../core/remote-cli-ids.js';
import { runtimePathOverride } from '../../adapters/cli/runtime.js';
import { DEFAULT_MODEL_VALUE_PATTERN, MODEL_SLUG_PATTERN, isSessionModelPickerValue, limitModelOptions } from '../../core/model-value-pattern.js';

export interface ModelPickerLoad {
  /** Missing entries and an unavailable query both mean unknown, never idle. */
  loads: ReadonlyMap<string, number> | null;
  checkedAt: number | null;
}

async function pickerLoad(key: string, cfg: BotConfig, session?: DaemonSession): Promise<ModelPickerLoad> {
  const unavailable = { loads: null, checkedAt: null };
  // Only a native local TraeX catalogue advertises load metadata. Do not
  // substitute a host account for a wrapper/remote/session-selected runtime.
  if (key !== 'traex' || cfg.wrapperCli || cfg.cliLaunchMode
    || (session && !sessionModelCatalogueContext(session, cfg).matchesBot)
    || isRemoteBackendId(session?.session.backendType ?? cfg.backendType ?? 'pty')) return unavailable;
  try {
    const probe = modelCatalogProbeContext(key, cfg, process.env);
    if (!probe.runtimeContext) return unavailable;
    const loads = await readTraexModelLoads({
      cliBin: createCliAdapterSync('traex', probe.runtimeExecutable).resolvedBin,
      env: probe.probeEnv,
      cwd: session?.session.workingDir,
      timeoutMs: 2_500,
    });
    return { loads, checkedAt: loads ? Date.now() : null };
  } catch { return unavailable; }
}

function modelOptionLabel(model: string, load: ModelPickerLoad | undefined, loc: Locale): string {
  if (!load) return model;
  const percent = load.loads?.get(model.trim().toLowerCase());
  const label = percent === undefined
    ? t('card.models.load_unknown', undefined, loc)
    : t('card.models.load_percent', { percent }, loc);
  return `${model} · ${label}`;
}

function modelLoadNote(load: ModelPickerLoad | undefined, loc: Locale) {
  if (!load) return [];
  return [{ tag: 'div', text: { tag: 'plain_text', content: load.checkedAt === null
    ? t('card.models.load_unavailable', undefined, loc)
    : t('card.models.load_snapshot', { time: new Date(load.checkedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' }, loc),
  } }];
}

function sessionCliId(ds: DaemonSession) {
  return ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? getBot(ds.larkAppId).config.cliId;
}

function sessionModelCatalogueContext(ds: DaemonSession, bot: BotConfig) {
  const session = ds.session;
  const snapshot = session.cliLaunchSnapshot;
  const launch = snapshot ?? session;
  const cliId = launch.cliId ?? bot.cliId;
  const inheritsLaunchShape = !snapshot && !session.agentFrozen && cliId === bot.cliId;
  const wrapper = launch.wrapperCli ?? (inheritsLaunchShape ? bot.wrapperCli : undefined);
  const launchMode = launch.cliLaunchMode ?? (inheritsLaunchShape ? bot.cliLaunchMode : undefined);
  const botExecutable = bot.cliRuntime?.executable ?? bot.cliPathOverride;
  const executable = launch.cliRuntime ? runtimePathOverride(launch.cliRuntime)
    : launch.cliPathOverride ?? (inheritsLaunchShape ? botExecutable : undefined);
  const configDir = session.cliConfigDir ?? (inheritsLaunchShape ? bot.cliConfigDir : undefined);
  const key = selectionKeyForBot(cliId, wrapper, launchMode);
  const matchesBot = !snapshot && !session.cliInstanceBinding && !session.existingAppServerEndpoint && cliId === bot.cliId
    && (wrapper?.trim() || '') === (bot.wrapperCli?.trim() || '') && launchMode === bot.cliLaunchMode
    && (!!wrapper || executable === botExecutable) && configDir === bot.cliConfigDir
    && (session.codexProfile ?? undefined) === bot.codexProfile;
  // A one-shot probe cannot target a per-session account/profile. Unknown
  // launchers must not substitute the host's native CLI catalogue either.
  const canProbe = !session.cliInstanceBinding && !session.existingAppServerEndpoint
    && !session.codexProfile && !configDir && !!lookupCliSelectionForBotShape(cliId, wrapper, launchMode)
    && (matchesBot || !executable);
  return { key, matchesBot, canProbe };
}

export { DEFAULT_MODEL_VALUE_PATTERN, MODEL_SLUG_PATTERN };

/**
 * Resolve the model-catalogue selection for THIS session's frozen CLI shape.
 * The catalogue functions take a "selection key" (cliId + wrapperCli +
 * launchMode), not a bare cliId — probing a `ttadk codex` session with the
 * bare 'codex' key returns the native codex list instead of the gateway's.
 * Probe inputs (custom executable, injected env, runtime cache identity) are
 * derived through the same helper as the dashboard endpoint so the menu sees
 * exactly the runtime the session is running.
 */
async function detectPickerModels(key: string, botConfig: BotConfig | undefined): Promise<readonly string[] | null> {
  try {
    const probe = modelCatalogProbeContext(key, botConfig, process.env);
    if (!probe.canProbe) return null;
    return await detectModels(key, {
      runtimeContext: probe.runtimeContext,
      probeEnv: probe.probeEnv,
      probeSettingsEnv: probe.probeSettingsEnv,
      runtimeExecutable: probe.runtimeExecutable,
      adapterFactory: requestedCliId => createCliAdapterSync(
        requestedCliId,
        requestedCliId === probe.cliId ? probe.runtimeExecutable : undefined,
      ),
    });
  } catch { return null; }
}

async function resolvedPickerModels(
  appId: string, session?: DaemonSession,
): Promise<readonly string[]> {
  const context = (config: BotConfig) => session ? sessionModelCatalogueContext(session, config) : {
    key: selectionKeyForBot(config.cliId, config.wrapperCli, config.cliLaunchMode),
    matchesBot: true,
    canProbe: !config.codexProfile && !config.cliConfigDir
      && !!lookupCliSelectionForBotShape(config.cliId, config.wrapperCli, config.cliLaunchMode),
  };
  const before = getBot(appId).config;
  const launch = context(before);
  const live = launch.canProbe ? await detectPickerModels(launch.key, launch.matchesBot ? before : undefined) : null;
  const config = getBot(appId).config;
  const current = context(config);
  const compatible = launch.key === current.key && launch.matchesBot === current.matchesBot && current.canProbe;
  const models = mergeModelChoices(staticModelChoices(current.key), compatible ? live : null).models;
  const useConfigured = current.matchesBot && botAcceptsLaunchModel(config)
    && (!isTtadkWrapper(config.wrapperCli) || ttadkAcceptsModel(config.wrapperCli));
  const custom = useConfigured ? config.customModels ?? [] : [];
  const activeModel = session?.activeModel?.trim() || session?.session.model?.trim();
  const fallback = [useConfigured ? config.model : undefined, activeModel, session?.session.modelPin?.model]
    .filter((model): model is string => !!model && !models.includes(model));
  const accepts = session ? isSessionModelPickerValue : (model: string) => DEFAULT_MODEL_VALUE_PATTERN.test(model);
  return [...new Set([...custom, ...fallback, ...models].filter(accepts))];
}

/** The picker and callback resolve the same session-specific catalogue. */
export function sessionModelChoices(ds: DaemonSession): Promise<readonly string[]> {
  return resolvedPickerModels(ds.larkAppId, ds);
}

/** Display metadata must never change which slugs are selectable. */
export async function sessionModelPickerData(ds: DaemonSession) {
  const config = getBot(ds.larkAppId).config;
  const { key } = sessionModelCatalogueContext(ds, config);
  const [models, load] = await Promise.all([
    sessionModelChoices(ds), pickerLoad(key, config, ds),
  ]);
  return { models, load };
}

type ModelPickerAction = 'reply_model_pick' | 'session_model_pick';

export function claudeSettingsPickerVersion(ds: DaemonSession): string {
  const effort = sessionReasoningControl(ds);
  return JSON.stringify([
    ds.workerGeneration, ds.cliReadyGeneration, ds.session.modelPin?.setAt, ds.session.modelPin?.model,
    ds.activeModel, ds.session.model, resolveSessionLaunchModel(ds, getBot(ds.larkAppId).config), effort?.selected,
  ]);
}

export function buildSessionModelPickerCard(
  ds: DaemonSession,
  rootId: string,
  models: readonly string[],
  currentModel: string | undefined,
  loc: Locale,
  action: ModelPickerAction = 'reply_model_pick',
  load?: ModelPickerLoad,
  privateRecipient?: string,
): string {
  // Only render slugs the inject path would accept: a live-detected catalogue
  // entry with exotic characters must not render into a dead option.
  const claude = sessionUsesClaudeCode(ds);
  const claudeEffort = claude ? sessionReasoningControl(ds) : undefined;
  const botConfig = claude || ds.session.modelPin ? getBot(ds.larkAppId).config : undefined;
  const pin = ds.session.modelPin;
  const pinView = pin ? resolveSessionModelPinView(ds, botConfig) : undefined;
  const selection = claude ? pin?.model ?? resolveSessionLaunchModel(ds, botConfig) : currentModel;
  const observedModel = claude ? ds.activeModel : currentModel;
  const observationIsCurrent = !claude || (!ds.session.suspendedColdResume && !ds.statuslineActiveModelStale && !ds.activeModelFromSeed);
  const observedEffort = ds.activeModelFromSeed ? undefined : ds.activeReasoningEffort;
  const startupModelOverride = claude && (ds.session.cliLaunchSnapshot?.startupCommands ?? botConfig?.startupCommands)
    ?.some(command => /^\/model\s+\S/i.test(command.trim()));
  const safeModels = limitModelOptions(models.filter(model => MODEL_SLUG_PATTERN.test(model)), selection, false, observedModel);
  const effort = !claude && action === 'session_model_pick' ? topicReasoningControl(ds) : undefined;
  const binding = {
    session_id: ds.session.sessionId, root_id: rootId, lark_app_id: ds.larkAppId, chat_id: ds.chatId,
    ...(claude ? { claude_settings_version: claudeSettingsPickerVersion(ds), picker_action: action,
      ...(privateRecipient ? { private_recipient: privateRecipient } : {}) } : {}),
  };
  const effortBinding = {
    ...binding,
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
      { tag: 'markdown', content: `**${t(claude ? 'card.session_settings.title' : 'card.reply_actions.model_title', undefined, loc)}**` },
      ...(claude ? [
        { tag: 'div', text: { tag: 'plain_text', content: t('card.session_settings.active', {
          model: !ds.activeModelFromSeed ? ds.activeModel ?? '—' : '—',
          effort: observedEffort && isCodexReasoningEffort(observedEffort)
            ? t(`card.effort.${observedEffort}`, undefined, loc) : observedEffort ?? '—',
        }, loc) } },
        { tag: 'div', text: { tag: 'plain_text', content: t('card.session_settings.scope', undefined, loc) } },
        { tag: 'div', text: { tag: 'plain_text', content: t('card.session_settings.model', undefined, loc) } },
      ] : [{ tag: 'div', text: { tag: 'plain_text', content: loc === 'en'
        ? 'Choosing a model saves a topic pin. Higher-priority launch overrides remain in effect; otherwise the CLI restarts with conversation history and background terminal tasks stop.'
        : '选择模型会保存话题固定；存在更高优先级覆盖时保留覆盖，否则重启 CLI 并保留对话上下文，后台终端任务会停止。' } }]),
      {
        tag: 'action',
        actions: [{
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: selection || t(claude ? 'card.models.cli_default' : 'card.reply_actions.model', undefined, loc) },
          ...(selection && safeModels.includes(selection) ? { initial_option: selection } : {}),
          options: safeModels.map(model => ({
            text: {
              tag: 'plain_text',
              content: modelOptionLabel(model, load, loc)
                + (observationIsCurrent && model === observedModel ? ` ${t('card.reply_actions.model_current', undefined, loc)}` : ''),
            },
            value: model,
          })),
          value: { action, ...binding },
        }],
      },
      ...(startupModelOverride ? [{ tag: 'div', text: { tag: 'plain_text',
        content: t('card.session_settings.startup_model_override', undefined, loc) } }] : []),
      ...(pin ? [
        ...(!claude ? [{ tag: 'div', text: { tag: 'plain_text', content: modelPinText(pinView) } }]
          : pinView?.shadowedBy ? [{ tag: 'div', text: { tag: 'plain_text',
            content: t('card.session_settings.launch_override', { model: pinView.launchModel ?? '—' }, loc) } }] : []),
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: t('card.session_settings.unpin', undefined, loc) },
          value: { action: 'session_model_unpin', expected_pin_set_at: pin.setAt, ...binding } }] },
      ] : []),
      ...(claudeEffort?.choices.length ? [
        { tag: 'div', text: { tag: 'plain_text', content: t('card.session_settings.effort', undefined, loc) } },
        { tag: 'action', actions: [{ tag: 'select_static',
          placeholder: { tag: 'plain_text', content: t('card.effort.select', undefined, loc) },
          ...(claudeEffort.selected ? { initial_option: claudeEffort.selected } : {}),
          ...(claudeEffort.claude?.disabledBy ? { disabled: true } : {}),
          options: claudeEffort.choices.map(level => ({ text: { tag: 'plain_text', content: t(`card.effort.${level}`, undefined, loc) }, value: level })),
          value: { action: 'session_effort_pick', ...binding },
        }] },
        ...(claudeEffort.claude?.disabledBy ? [{ tag: 'div', text: { tag: 'plain_text',
          content: t(`card.effort.claude_${claudeEffort.claude.disabledBy}_override`, undefined, loc) } }] : []),
      ] : []),
      ...modelLoadNote(claude ? undefined : load, loc),
      ...effortElements,
    ],
  });
}

export async function deliverSessionModelPicker(
  ds: DaemonSession, operator: string, render: (privateRecipient?: string) => string,
  reply: (card: string) => Promise<unknown>,
): Promise<void> {
  const privateRecipient = sessionUsesClaudeCode(ds) && ds.scope === 'chat' && ds.chatType !== 'p2p'
    ? operator : undefined;
  await deliverEphemeralOrReply(ds, operator, render(privateRecipient), 'interactive', () => reply(render()));
}

/** Read-only shortcut: a short-lived catalogue helper creates no conversation
 * and never changes the model of the running CLI. */
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
  } else if (sessionUsesClaudeCode(ds) && (!supportsClaudeSessionSettings(ds) || ds.session.principalLane)) {
    notice = t('card.session_settings.unsupported', undefined, loc);
  } else if ((!ds.worker || ds.worker.killed) && !(supportsClaudeSessionSettings(ds) && ds.session.suspendedColdResume)) {
    notice = t('daemon.cmd_needs_active_cli', { cmd: '/models' }, loc);
  } else if (cliHasNoRawPassthroughSurface(sessionCliId(ds), { dshRuntime: getBot(ds.larkAppId).config.dshRuntime })) {
    notice = t('card.reply_actions.model_unsupported', undefined, loc);
  }
  if (notice) { await reply(rootId, notice); return; }
  const worker = ds.worker;
  const generation = ds.workerGeneration;
  const data = await sessionModelPickerData(ds);
  if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId, operatorUnionId)
    || ds.worker !== worker || ds.workerGeneration !== generation || isSessionTransferring(ds)
    || (ds.worker?.killed && !(supportsClaudeSessionSettings(ds) && ds.session.suspendedColdResume))) {
    await reply(rootId, t('card.models.changed', undefined, loc));
    return;
  }
  const models = data.models.filter(model => MODEL_SLUG_PATTERN.test(model));
  const render = (recipient?: string) => models.length > 0
    ? buildSessionModelPickerCard(ds, rootId, models,
      ds.activeModel?.trim() || ds.session.model?.trim() || undefined, loc, 'session_model_pick', data.load, recipient)
    : JSON.stringify({ config: { wide_screen_mode: true }, elements: [
      { tag: 'markdown', content: t('card.reply_actions.model_empty', undefined, loc) },
    ] });
  await deliverSessionModelPicker(ds, operatorOpenId, render, card => reply(rootId, card, 'interactive'));
}

export function defaultModelSelectionKey(appId: string): string {
  const cfg = getBot(appId).config;
  return selectionKeyForBot(cfg.cliId, cfg.wrapperCli, cfg.cliLaunchMode);
}

export function defaultModelChoices(appId: string): Promise<readonly string[]> {
  return resolvedPickerModels(appId);
}

export async function defaultModelPickerData(appId: string) {
  const cfg = getBot(appId).config;
  const key = defaultModelSelectionKey(appId);
  const [models, load] = await Promise.all([
    defaultModelChoices(appId), pickerLoad(key, cfg),
  ]);
  return { models, load };
}

export function buildDefaultModelPickerCard(
  appId: string,
  models: readonly string[],
  currentModel: string | undefined,
  loc: Locale,
  selectionKey: string,
  reasoning?: { cliId: string; effort?: string },
  load?: ModelPickerLoad,
): string {
  const safe = [...models].filter(model => DEFAULT_MODEL_VALUE_PATTERN.test(model));
  if (currentModel && DEFAULT_MODEL_VALUE_PATTERN.test(currentModel) && !safe.includes(currentModel)) safe.unshift(currentModel);
  const choices = [{ text: t('card.models.cli_default', undefined, loc), value: CONFIG_UNSET },
    ...limitModelOptions(safe, currentModel, true).map(model => ({ text: modelOptionLabel(model, load, loc), value: model }))];
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
    ...modelLoadNote(load, loc),
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
  const { models, load } = await defaultModelPickerData(appId);
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
  await reply(rootId, buildDefaultModelPickerCard(appId, models, current.config.model, loc, selectionKey, { cliId: current.config.cliId, effort: current.config.reasoningEffort }, load), 'interactive');
}
