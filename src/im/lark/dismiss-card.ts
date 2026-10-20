/**
 * `/dismiss` 的确认卡与点击后的「已提交」卡。
 *
 * 确认按钮把 `confirmation_state` 原样带回，card-handler 再以
 * `/dismiss --confirm=<state>` 重入 handleCommand —— 校验、关会话、解散群只有一条路径。
 */
import { t, type Locale } from '../../i18n/index.js';
import { TABLE_AUTO_ROW_STYLE } from './table-style.js';

export const DISMISS_CONFIRM_ACTION = 'dismiss_confirm';

/** 卡片表格一行：哪个 Bot、哪个会话（已由调用方渲染成纯文本）。 */
export interface DismissCardRow {
  bot: string;
  task: string;
}

export function buildDismissConfirmCard(args: {
  chatId: string;
  invokerOpenId: string;
  confirmationState: string;
  rows: DismissCardRow[];
  loc: Locale;
}): string {
  const { loc, rows } = args;
  const elements: unknown[] = [
    {
      tag: 'markdown',
      content: rows.length > 0
        ? t('cmd.dismiss.card_steps', { count: String(rows.length) }, loc)
        : t('cmd.dismiss.card_steps_no_session', undefined, loc),
    },
  ];
  if (rows.length > 0) {
    elements.push({
      tag: 'table',
      page_size: 10,
      ...TABLE_AUTO_ROW_STYLE,
      columns: [
        { name: 'bot', display_name: t('cmd.dismiss.col_bot', undefined, loc), data_type: 'text', width: '140px' },
        { name: 'task', display_name: t('cmd.dismiss.col_session', undefined, loc), data_type: 'text', width: 'auto' },
      ],
      rows,
    });
  }
  elements.push(
    { tag: 'hr' },
    { tag: 'markdown', content: t('cmd.dismiss.card_keep', undefined, loc) },
    { tag: 'markdown', content: `<font color='grey'>${t('cmd.dismiss.card_note', undefined, loc)}</font>` },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: t('cmd.dismiss.confirm_button', undefined, loc) },
      type: 'danger',
      behaviors: [{
        type: 'callback',
        value: {
          action: DISMISS_CONFIRM_ACTION,
          chat_id: args.chatId,
          invoker_open_id: args.invokerOpenId,
          confirmation_state: args.confirmationState,
        },
      }],
    },
  );
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `⚠️ ${t('cmd.dismiss.card_title', undefined, loc)}` },
      template: 'red',
    },
    body: { direction: 'vertical', elements },
  });
}

/** 点击确认后原地替换：去掉按钮，防止重复点击，并说明结果会从哪里来。 */
export function buildDismissSubmittedCard(loc: Locale): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `⏳ ${t('cmd.dismiss.card_title', undefined, loc)}` },
      template: 'grey',
    },
    body: {
      direction: 'vertical',
      elements: [{ tag: 'markdown', content: t('cmd.dismiss.submitted', undefined, loc) }],
    },
  };
}
