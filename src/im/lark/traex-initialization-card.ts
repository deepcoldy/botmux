import { TRAEX_INITIALIZATION_MODES } from '../../core/traex-initialization.js';
import type { PendingTraexInitialization, TraexInitializationMode } from '../../core/traex-initialization.js';
import { t, type Locale } from '../../i18n/index.js';

export const TRAEX_INIT_ACTION_START = 'traex_init_start';
export const TRAEX_INIT_ACTION_CANCEL = 'traex_init_cancel';
export const TRAEX_INIT_ACTION_MANUAL_SELECT = 'traex_init_manual_select';
export const TRAEX_INIT_ACTION_WORKTREE_MULTI_SELECT = 'traex_init_worktree_multi_select';
export const TRAEX_INIT_KEY_TARGET = 'traex_init_target';
export const TRAEX_INIT_KEY_MODE = 'traex_init_mode';

function actionValue(
  action: string,
  rootId: string,
  nonce: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { action, root_id: rootId, nonce, ...extra };
}

function selectValue(key: string, rootId: string, nonce: string): Record<string, unknown> {
  return { key, root_id: rootId, nonce };
}

function modeLabelKey(mode: TraexInitializationMode): string {
  return mode === 'forge-pipeline'
    ? 'card.traex_init.start_pipeline'
    : mode === 'forge-pilot'
      ? 'card.traex_init.start_pilot'
      : 'card.traex_init.start_traex';
}

export function buildTraexStartupModeCard(input: {
  rootId: string;
  pending: PendingTraexInitialization;
  locale?: Locale;
}): string {
  const { rootId, pending, locale } = input;
  const selectedLabel = pending.selection.kind === 'worktree'
    ? t('card.traex_init.selection_worktree', { name: pending.selection.label }, locale)
    : pending.selection.kind === 'auto-worktree'
      ? t('card.traex_init.selection_auto_worktree', { path: pending.selection.path }, locale)
      : pending.selection.label;
  const modeOptions = TRAEX_INITIALIZATION_MODES.map(mode => ({
    text: { tag: 'plain_text' as const, content: t(modeLabelKey(mode), undefined, locale) },
    value: mode,
  }));

  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: t('card.traex_init.mode_intro', undefined, locale),
    },
    {
      tag: 'markdown',
      content: `${t('card.traex_init.selected_dir', undefined, locale)} **${selectedLabel}**`,
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: t('card.traex_init.mode_placeholder', undefined, locale) },
          options: modeOptions,
          value: selectValue(TRAEX_INIT_KEY_MODE, rootId, pending.nonce),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('card.traex_init.cancel', undefined, locale) },
          type: 'danger',
          value: actionValue(TRAEX_INIT_ACTION_CANCEL, rootId, pending.nonce),
        },
      ],
    },
  ];

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: t('card.traex_init.mode_title', undefined, locale) },
    },
    elements,
  });
}

export function buildTraexInitializationCancelledCard(locale?: Locale): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: t('card.traex_init.cancelled_title', undefined, locale) },
    },
    elements: [
      { tag: 'markdown', content: t('card.traex_init.cancelled_body', undefined, locale) },
    ],
  });
}
