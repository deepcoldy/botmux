/**
 * 普通回复卡右下角操作菜单（打开终端 / 切换模型 / 关闭会话）。
 *
 * 菜单与 canonical footer、可选的语音按钮共享同一行：左侧 weighted 列放
 * footer，右侧 auto 列放控件。整行带稳定顶层 element_id，长卡降级白名单、
 * 群上下文投影与出站回调盖章都按该 ID/组件识别。
 *
 * 菜单为 per-bot opt-in（bots.json `replyCardActions === true`），仅在绑定
 * 了权威会话的普通回复卡上由调用方注入；广播、跨群发布、托管会议与自定义
 * 透传卡不得注入。
 */
import { t, type Locale } from '../../i18n/index.js';
import { coordinationModeIsPrimary } from '../../services/durable-coordination-runtime.js';
import type { ReplyCardFooter } from './md-card.js';

export const REPLY_CARD_ACTIONS_ELEMENT_ID = 'botmux_reply_actions';
export const REPLY_CARD_MENU_ACTION = 'reply_card_menu';

export type ReplyCardMenuOption = 'terminal' | 'model' | 'close';

export interface ReplyCardActionBinding {
  larkAppId: string;
  chatId: string;
  rootId: string;
  sessionId: string;
  /** Shared adopt session: the close item renders as "disconnect". */
  adopt?: boolean;
}

/** Overflow 组件：公共 value 绑定会话，选中项经回调 action.option 上送。 */
export function buildReplyCardActionOverflow(binding: ReplyCardActionBinding, locale?: Locale): Record<string, unknown> {
  // Durable-primary deployments only fence lifecycle actions from the canonical
  // streaming card; an off-card close confirm cannot be admitted there, so the
  // item is hidden (and the handler re-checks live as defense-in-depth).
  const options: Array<{ text: { tag: 'plain_text'; content: string }; value: ReplyCardMenuOption }> = [
    { text: { tag: 'plain_text', content: t('card.reply_actions.terminal', undefined, locale) }, value: 'terminal' },
    { text: { tag: 'plain_text', content: t('card.reply_actions.model', undefined, locale) }, value: 'model' },
    ...(coordinationModeIsPrimary() ? [] : [{
      text: { tag: 'plain_text' as const, content: t(binding.adopt ? 'card.reply_actions.disconnect' : 'card.reply_actions.close', undefined, locale) },
      value: 'close' as const,
    }]),
  ];
  return {
    tag: 'overflow',
    value: {
      action: REPLY_CARD_MENU_ACTION,
      session_id: binding.sessionId,
      root_id: binding.rootId,
      lark_app_id: binding.larkAppId,
      chat_id: binding.chatId,
      ...(binding.adopt ? { adopt: 1 } : {}),
    },
    options,
  };
}

const SPACER_ELEMENT = { tag: 'markdown', text_size: 'notation', content: ' ' };

/**
 * 组装 footer 行。
 * - 无右侧控件：footer 单独作为顶层 markdown（保持既有 element_id 契约）；
 * - 有控件：一行 column_set，footer 占左 weighted 列，每个控件一个 auto 列。
 * 返回 null 当且仅当 footer 与控件同时缺失。
 */
export function buildReplyCardChromeRow(opts: {
  footer: ReplyCardFooter | null;
  controls?: ReadonlyArray<Record<string, unknown>>;
}): Record<string, unknown> | null {
  const controls = (opts.controls ?? []).filter(Boolean);
  if (controls.length === 0) return opts.footer ? opts.footer.element : null;
  return {
    tag: 'column_set',
    element_id: REPLY_CARD_ACTIONS_ELEMENT_ID,
    flex_mode: 'none',
    horizontal_spacing: 'default',
    columns: [
      {
        tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
        elements: [opts.footer?.element ?? SPACER_ELEMENT],
      },
      ...controls.map(control => ({
        tag: 'column', width: 'auto', vertical_align: 'center',
        elements: [control],
      })),
    ],
  };
}
