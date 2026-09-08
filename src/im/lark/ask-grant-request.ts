/**
 * 无权限者点 `botmux ask` 卡片按钮时，弹授权申请卡给 owner（复用对话路径那套授权卡）。
 *
 * 与「对话弹授权卡」（event-dispatcher 的 maybeSendGrantRequestCard，入口 A）的关系：
 * 卡片、pending/nonce 表、owner 处置分支、落库全部复用，**唯一区别是不重放**——
 *
 *   对话路径：openPending 挂上触发消息（messageData），owner 授权后 replayGrantedMessage
 *             重放那条消息，用户无需再 @ 一遍。
 *   ask 路径：故意不挂 messageData（getPendingMessage → undefined → 不触发重放），
 *             因为「点按钮」不是一条可重放的消息：ask 的答案取决于点的是哪个选项，
 *             daemon 侧无从代替用户决定。所以授权通过后**仍需用户再点一次**按钮。
 *             ask 在此期间保持 pending（broker 对 unauthorized 不改状态），再点即生效。
 *
 * ACK 预算：card.action.trigger 只有 3s（botmux 用 2500ms 抢答，见 event-dispatcher
 * 的 CARD_ACTION_ACK_TIMEOUT_MS），超时飞书会自己弹「未在线/超时未响应」盖掉我们的
 * toast。所以本模块**同步决策、异步发卡**：判定（配置/owner/节流）和 openPending 都是
 * 纯内存同步操作，取名字 + 发卡走 fire-and-forget，调用方拿到结论立刻 ACK。
 */
import { getBot, getOwnerOpenId } from '../../bot-registry.js';
import { config } from '../../config.js';
import { localeForBot } from '../../i18n/index.js';
import {
  DEFAULT_GRANT_DURATION_MS,
  DEFAULT_GRANT_QUOTA,
} from '../../services/grant-policy.js';
import { listObservedBots } from '../../services/observed-bots-store.js';
import { logger } from '../../utils/logger.js';
import { buildGrantCard } from './card-builder.js';
import { getUserProfile, replyMessage, sendMessage } from './client.js';
import { clearPending, openPending, throttleReason } from './grant-pending.js';

/** 本次升级的结论。调用方据此选 toast 文案。 */
export type AskGrantRequestOutcome =
  /** 已开卡并在后台发送 → 告诉点击者「已申请授权，通过后再点一次」。 */
  | 'sent'
  /** 该 (bot, chat, 点击者) 已有未处置的申请 → 让他等 owner 处理。 */
  | 'pending'
  /** owner 已经拒绝过，还在 10 分钟冷却期内 → 必须跟 pending 分开说，
   *  否则会把「已被拒绝」说成「等 owner 处理」（pi review F1）。 */
  | 'denied'
  /** 发不了（未配 owner 的开放模式 / bot 关了 autoGrantRequestCards / bot 未注册）
   *  → 调用方回落到原本的「你没有权限回答这个 ask」。 */
  | 'unavailable';

/** ask 卡片定位所需的最小字段（取自 PendingAsk 快照）。 */
export interface AskGrantRequestTarget {
  larkAppId: string;
  chatId: string;
  /** ask 卡片自身的 message_id：授权卡回复到它下面，跟问题贴在一起。 */
  cardMessageId?: string;
  /** thread-scope 时为话题根 `om_`；chat-scope 时为 null。决定是否 reply_in_thread。 */
  rootMessageId: string | null;
}

export interface AskGrantRequestDeps {
  getOwnerOpenId?: typeof getOwnerOpenId;
  throttleReason?: typeof throttleReason;
  openPending?: typeof openPending;
  clearPending?: typeof clearPending;
  /** 读 bot 配置（额度/有效期默认值 + autoGrantRequestCards 开关）。 */
  getBotConfig?: (larkAppId: string) => {
    autoGrantRequestCards?: boolean;
    messageQuota?: { defaultLimit?: number };
    grantDefaultDurationMs?: number;
  };
  /** 展示名解析（异步，不在 ACK 路径上）。 */
  resolveTargetName?: (larkAppId: string, chatId: string, openId: string) => Promise<string>;
  /** 实际投递授权卡（异步，不在 ACK 路径上）。 */
  deliverCard?: (target: AskGrantRequestTarget, cardJson: string) => Promise<void>;
}

/**
 * 同步决定要不要为这个点击者申请授权，并（若要）在后台把授权卡发出去。
 *
 * 返回值只反映**同步**判定；发卡失败会在后台 clearPending，让点击者下次再点能重试
 * （与对话路径发卡失败的处理一致，避免被节流永久压死、owner 永远看不到卡）。
 */
export function requestGrantForAskClicker(
  ask: AskGrantRequestTarget,
  clickerOpenId: string,
  deps: AskGrantRequestDeps = {},
): AskGrantRequestOutcome {
  const ownerOf = deps.getOwnerOpenId ?? getOwnerOpenId;
  const reasonOf = deps.throttleReason ?? throttleReason;
  const open = deps.openPending ?? openPending;
  const clear = deps.clearPending ?? clearPending;
  const readConfig = deps.getBotConfig ?? ((appId: string) => getBot(appId).config);
  const resolveName = deps.resolveTargetName ?? defaultResolveTargetName;
  const deliver = deps.deliverCard ?? defaultDeliverCard;

  const { larkAppId, chatId } = ask;
  try {
    const botConfig = readConfig(larkAppId);
    // 与对话路径同一个开关：owner 关了就一律不弹卡。
    if (botConfig.autoGrantRequestCards === false) return 'unavailable';
    const owner = ownerOf(larkAppId);
    // 开放模式（没配 owner）没人能处置这张卡 —— 不发，回落原 toast。
    if (!owner) return 'unavailable';
    // 节流原因要如实透出：owner 已拒绝（denied 冷却）不能说成「等 owner 处理」。
    const throttled = reasonOf(larkAppId, chatId, clickerOpenId);
    if (throttled) return throttled;

    const quota = botConfig.messageQuota?.defaultLimit ?? DEFAULT_GRANT_QUOTA;
    const durationMs = botConfig.grantDefaultDurationMs ?? DEFAULT_GRANT_DURATION_MS;
    // 第 5 个参数 messageData 故意留空：授权通过后不重放，用户再点一次按钮即可（见文件头）。
    const nonce = open(larkAppId, chatId, clickerOpenId, quota, undefined, durationMs);

    // 取名字 + 发卡都不在 ACK 路径上：失败只回滚 pending，不影响本次 toast。
    void (async () => {
      try {
        const name = await resolveName(larkAppId, chatId, clickerOpenId);
        const cardJson = buildGrantCard(
          {
            ownerOpenId: owner,
            targets: [{ openId: clickerOpenId, name }],
            chatId,
            nonce,
            mode: 'request',
            quota,
            durationMs,
          },
          localeForBot(larkAppId),
        );
        await deliver(ask, cardJson);
      } catch (err) {
        clear(larkAppId, chatId, clickerOpenId);
        logger.debug(`ask grant request card send failed: ${err}`);
      }
    })();

    return 'sent';
  } catch (err) {
    // bot 未注册（getBot 抛）等异常一律降级：ask 点击链路绝不能因为升级授权而挂掉。
    logger.debug(`ask grant request skipped: ${err}`);
    return 'unavailable';
  }
}

/** 名字优先级：observed-bots 花名册（/introduce 登记过的 bot）→ 通讯录 → 截短 open_id。
 *  卡片回调没有 mentions，所以拿不到对话路径那条「本消息 mentions」的免费来源。 */
async function defaultResolveTargetName(
  larkAppId: string,
  chatId: string,
  openId: string,
): Promise<string> {
  const observedName = listObservedBots(config.session.dataDir, larkAppId, chatId)
    .find(b => b.openId === openId)?.name;
  if (observedName) return observedName;
  const profileName = (await getUserProfile(larkAppId, openId).catch(() => null))?.name;
  if (profileName) return profileName;
  return `${openId.slice(0, 10)}…${openId.slice(-4)}`;
}

/** 把授权卡贴到 ask 卡片下面：thread-scope 走 reply_in_thread 留在话题里，
 *  chat-scope 引用回复 ask 卡片，都拿不到锚点时退回群里直发。 */
async function defaultDeliverCard(ask: AskGrantRequestTarget, cardJson: string): Promise<void> {
  // rootMessageId 在 chat-scope 下其实是 chat_id（oc_）而非 message_id，按前缀判真话题。
  const inThread = typeof ask.rootMessageId === 'string' && ask.rootMessageId.startsWith('om_');
  const anchor = ask.cardMessageId?.startsWith('om_')
    ? ask.cardMessageId
    : (inThread ? ask.rootMessageId! : undefined);
  if (anchor) {
    await replyMessage(ask.larkAppId, anchor, cardJson, 'interactive', inThread);
    return;
  }
  await sendMessage(ask.larkAppId, ask.chatId, cardJson, 'interactive');
}
