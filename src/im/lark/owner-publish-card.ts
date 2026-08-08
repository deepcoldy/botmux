/**
 * 「仅发起人可见 → 采纳后转全群可见」卡片 —— card-handler 的 owner-publish 分支。
 *
 * 由 `botmux send --owner-only` 发出：bot 用 `sendEphemeralCard` 发一张只有发起人
 * 看得到的卡（顶部标「仅对你可见」），卡底带一个「采纳（转为所有人可见）」按钮。
 * 发起人点击后，删掉这张私密卡，把同样的内容以全群可见的普通卡重发到群里。
 *
 * 约束：ephemeral 卡只在 flat 普通群（chat scope）生效，话题群 / 单聊会被飞书拒
 * （18053），所以本功能只在普通群聊可用（见 client.ts 的 sendEphemeralCard 说明与
 * command-handler.ts 里 relay picker 的同款注释）。
 *
 * 设计对齐 v3-gate-card-handler / ask-card：owner 强闸门 + nonce 一次性核销 +
 * 点击回调里同步返回终态（这里是删私密卡 + 全群重发），不依赖异步 PATCH。
 */
import { logger } from '../../utils/logger.js';
import { t, localeForBot, type Locale } from '../../i18n/index.js';
import { getOwnerOpenId } from '../../bot-registry.js';
import { sendMessage, deleteEphemeralCard } from './client.js';
import { claimOwnerPublish, registerOwnerPublish } from './owner-publish-pending.js';

/** 采纳（转为所有人可见）按钮动作。 */
export const OWNER_PUBLISH_ACTION = 'owner_publish';

export function isOwnerPublishAction(action: unknown): boolean {
  return action === OWNER_PUBLISH_ACTION;
}

/**
 * 把发起人提供的内容卡包成「仅发起人可见 + 采纳按钮」卡。
 *
 * `contentElements` 是要展示（也是采纳后原样发到群里）的卡片 elements；
 * `nonce` 由调用方生成并登记到 owner-publish-pending。这里在内容之下追加一行
 * 「仅对你可见」note 和采纳按钮。采纳后发到群里的卡见 buildOwnerPublishPublicCard。
 */
export function buildOwnerPublishEphemeralCard(
  contentElements: Array<Record<string, unknown>>,
  nonce: string,
  locale?: Locale,
): string {
  const elements: Array<Record<string, unknown>> = [
    ...contentElements,
    { tag: 'hr' },
    {
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: t('card.owner_publish.only_you', undefined, locale) },
      ],
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('card.owner_publish.accept', undefined, locale) },
          type: 'primary',
          value: { action: OWNER_PUBLISH_ACTION, nonce },
        },
      ],
    },
  ];
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements,
  });
}

/** 采纳后发到全群的公开卡：原样内容，无采纳按钮、无「仅对你可见」标注。 */
/** 采纳后发到全群的公开卡：原样内容，无采纳按钮、无「仅对你可见」标注。
 *
 * ⚠️ 安全契约：`contentElements` 必须来自已过 `findDisallowedCardCallback` 校验的
 * 卡片（当前唯一调用方 cli.ts `--owner-only` 用 `normalizeInteractiveCardInput`
 * 归一后的 customCard，或纯文本 markdown 元素）。这些 elements 会原样发到全群，
 * 若含未校验的 callback button，`stampBotmuxCallbackMarkers` 会把它标成 botmux
 * 自己的 callback。切勿新增绕过 normalize 直接塞 elements 的旁路。 */
export function buildOwnerPublishPublicCard(
  contentElements: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: contentElements,
  });
}

export interface OwnerPublishActionValue {
  action?: string;
  nonce?: string;
}

export interface OwnerPublishCardHandlerDeps {
  /** 向全群发公开卡。默认 = 真实 sendMessage。 */
  sendMessage?: typeof sendMessage;
  /** 删掉私密卡。默认 = 真实 deleteEphemeralCard。 */
  deleteEphemeralCard?: typeof deleteEphemeralCard;
}

/**
 * 处理「采纳（转为所有人可见）」点击。
 *
 * 流程：owner 强闸门 → nonce 一次性核销（拿到待发布 payload）→ 删私密卡 +
 * 向全群发公开卡。返回 Lark 卡片回调响应（`{ toast }`）。
 *
 * `cardMessageId` 是被点击的私密卡的 message_id（来自 data.context.open_message_id），
 * 用于删除该私密卡。
 */
export async function handleOwnerPublishAction(
  value: OwnerPublishActionValue,
  operatorOpenId: string | undefined,
  cardMessageId: string | undefined,
  larkAppId: string,
  deps: OwnerPublishCardHandlerDeps = {},
): Promise<{ toast: { type: string; content: string } }> {
  const locale = localeForBot(larkAppId);
  const send = deps.sendMessage ?? sendMessage;
  const delEphemeral = deps.deleteEphemeralCard ?? deleteEphemeralCard;

  const nonce = value.nonce;
  if (!nonce) {
    return { toast: { type: 'warning', content: t('card.owner_publish.toast_stale', undefined, locale) } };
  }

  // owner 强闸门：只有发起人本人能采纳。虽然私密卡本就只对 owner 可见，仍做服务端
  // 校验（对齐 grant/overload 卡），不信任卡片来源。
  const owner = getOwnerOpenId(larkAppId);
  if (!operatorOpenId || operatorOpenId !== owner) {
    logger.info(`owner_publish blocked for non-owner: ${operatorOpenId}`);
    return { toast: { type: 'error', content: t('card.owner_publish.toast_owner_only', undefined, locale) } };
  }

  // nonce 一次性核销：拿到待发布 payload。重复点 / 旧卡 / 重启后 → null。
  const entry = claimOwnerPublish(nonce);
  if (!entry) {
    return { toast: { type: 'info', content: t('card.owner_publish.toast_already', undefined, locale) } };
  }

  // 先发公开卡（correctness 优先）；成功后再删私密卡（best-effort，删失败只是残留一张
  // 仅 owner 可见的私密卡，不影响正确性）。发失败则回滚 nonce 让 owner 可重试
  // ——私密卡还在，按钮仍指向同一 nonce。
  try {
    await send(larkAppId, entry.chatId, entry.publishCardJson, 'interactive');
  } catch (err) {
    logger.warn(`owner_publish send-to-group failed: ${err instanceof Error ? err.message : String(err)}`);
    registerOwnerPublish(nonce, {
      ownerOpenId: entry.ownerOpenId,
      chatId: entry.chatId,
      publishCardJson: entry.publishCardJson,
    });
    return { toast: { type: 'error', content: t('card.owner_publish.toast_publish_failed', undefined, locale) } };
  }
  if (cardMessageId) {
    await delEphemeral(larkAppId, cardMessageId).catch(() => { /* 残留私密卡只是观感问题 */ });
  }
  return { toast: { type: 'success', content: t('card.owner_publish.toast_published', undefined, locale) } };
}
