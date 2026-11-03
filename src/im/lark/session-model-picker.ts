/** Model catalogue and picker shared by /models and the optional reply menu. */
import type { DaemonSession } from '../../core/types.js';
import { getBot } from '../../bot-registry.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { staticModelChoices, detectModels, mergeModelChoices } from '../../services/model-catalog.js';
import { modelCatalogProbeContext } from '../../dashboard/model-catalog-request.js';
import { selectionKeyForBot } from '../../setup/cli-selection.js';
import { t, type Locale } from '../../i18n/index.js';
import { cliHasNoRawPassthroughSurface } from '../../core/passthrough-commands.js';
import { canOperate } from './event-dispatcher.js';
import { deliverEphemeralOrReply, isSessionTransferring } from '../../core/worker-pool.js';

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
function resolveSessionModelCatalogue(ds: DaemonSession): {
  key: string;
  staticChoices: readonly string[];
  detect: () => Promise<readonly string[] | null>;
} {
  const cliId = sessionCliId(ds);
  const key = selectionKeyForBot(cliId, ds.session.wrapperCli, ds.session.cliLaunchMode);
  const probe = modelCatalogProbeContext(key, getBot(ds.larkAppId).config, process.env);
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
  const catalogue = resolveSessionModelCatalogue(ds);
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
