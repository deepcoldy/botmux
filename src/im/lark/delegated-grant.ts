/**
 * 委托授权：受信的 bot 在群里 @ 本 bot 时，把同一条消息里被它点名的其他人写进本群 chatGrants
 * —— 与 owner 在授权卡上点「本群」同效（talk-only，额度/有效期取 /grant 的默认值），省掉
 * 「被点名的人 @ 本 bot → 弹申请卡 → 等 owner 手点」这一轮。
 *
 * 谁算委托方只在 {@link resolveGrantDelegator} 里判定，按来源逐条分支。目前只有一种来源：
 * 与本 bot 同一个 owner 的同机 Bot（isTrustedSameOwnerSiblingBot，受 trustSameOwnerBots
 * 开关控制，默认开）——同一个人的 bot 视同 owner 本人在点名。落库、跳过规则、结果卡与
 * dispatcher 接线对所有来源共用，新增来源不用改它们。
 *
 * 信任锚是飞书盖章的 bot 发送方（调用方只在 sender_type=app|bot 分支调用）；绝不写
 * allowedUsers / allowedChatGroups / globalGrants，不授 canOperate。已经能和本 bot 对话的人
 * （owner、oncall 群成员、已有授权……）跳过，不重复落库。
 */
import { getBot, getBotOpenId } from '../../bot-registry.js';
import { config } from '../../config.js';
import { evaluateTalk, isTrustedSameOwnerSiblingBot } from './event-dispatcher.js';
import { extractMentionIdentities, messageMentionsBot } from './message-parser.js';
import { buildGrantResultCard } from './card-builder.js';
import { isHumanOpenId, replyMessage } from './client.js';
import { addChatGrant } from '../../services/grant-store.js';
import { DEFAULT_GRANT_DURATION_MS, DEFAULT_GRANT_QUOTA } from '../../services/grant-policy.js';
import { localeForBot } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

export interface DelegatedGrantSender {
  /**
   * 发送方的 open_id（本 app 视角）与 app_id：排除发送方自己、判黑名单，也供按 open_id /
   * app_id 匹配的委托来源（如显式名单）使用。
   */
  senderIds: Array<string | undefined>;
  /** 飞书盖章的 bot 发送方 union_id。 */
  senderUnionId?: string;
}

/** 委托来源。新增来源 = 这里加一个值 + {@link resolveGrantDelegator} 里加一条分支。 */
export type GrantDelegatorKind =
  /** 与本 bot 同一个 owner 的同机 Bot（trustSameOwnerBots，默认开）。 */
  | 'sameOwnerBot';

/**
 * 发送方能不能替本 bot 点名授权；能的话返回命中的委托来源（用于日志），否则 undefined。
 *
 * 按来源逐条分支，命中第一条即返回。各来源互相独立：每条分支只看自己的信任依据和自己的
 * 开关（例如 trustSameOwnerBots 只管同机 Bot，不影响 owner 显式列出的外部 bot 名单）。
 * 黑名单否决、非群聊、没 @ 本 bot 等通用前置条件由 {@link applyDelegatedGrants} 统一处理，
 * 分支里不用重复。
 */
export function resolveGrantDelegator(larkAppId: string, sender: DelegatedGrantSender): GrantDelegatorKind | undefined {
  // 来源：与本 bot 同一个 owner 的同机 Bot。
  if (isTrustedSameOwnerSiblingBot(config.session.dataDir, larkAppId, sender.senderUnionId)) return 'sameOwnerBot';
  return undefined;
}

/**
 * 取这条消息里被点名的「其他人」：位置无关（委托语义没有命令词，不能复用 /grant 的
 * 「命令词之后」位置过滤），mentions[] 与 post inline at 两条形态都覆盖。
 * 排除：本 bot（open_id / app_id 两种自我形态）、发送方自己、@all 伪 id、
 * app_id-only 的群外 bot（chatGrant 只收 open_id 主体），按 open_id 去重。
 */
function delegatedGrantTargets(
  message: any,
  selfOpenId: string | undefined,
  selfAppId: string,
  senderIds: Set<string>,
): Array<{ openId: string; name?: string }> {
  const out: Array<{ openId: string; name?: string }> = [];
  const seen = new Set<string>();
  for (const m of extractMentionIdentities(message)) {
    const oid = m.openId;
    if (!oid || !oid.startsWith('ou_')) continue;
    if (selfOpenId && oid === selfOpenId) continue;
    if (m.appId && m.appId === selfAppId) continue;
    if (senderIds.has(oid) || (m.appId && senderIds.has(m.appId))) continue;
    if (seen.has(oid)) continue;
    seen.add(oid);
    out.push({ openId: oid, name: m.name });
  }
  return out;
}

/**
 * 处理一条 @ 了本 bot 的 bot 消息。没 @ 本 bot / 发送方不是委托方（或被拉黑）/ 非群聊 /
 * 没有可授权的人时什么都不做。「必须 @ 了本 bot」在函数内自查，不依赖调用点之前的路由门。
 * 返回本次落库授权的 open_id 列表（首次授权 + 过期后的重新授权；有效期内的既有授权会被上游跳过）。
 *
 * ⚠️ 调用方必须**先**跑完 `bindDefaultOncallBeforeTalk` 再调本函数：defaultOncall 群的
 * oncall 绑定是首条消息时懒写入的，先判 evaluateTalk 会看不到它，于是给本就能说话的人
 * 白写一条 chatGrant、并回一张「你已获授权」卡（oncall 群里属于噪音）。
 */
export async function applyDelegatedGrants(
  larkAppId: string,
  message: any,
  opts: { chatType: 'group' | 'p2p' } & DelegatedGrantSender,
): Promise<string[]> {
  const chatId: string | undefined = message?.chat_id;
  if (opts.chatType !== 'group' || !chatId) return [];
  const selfOpenId = getBotOpenId(larkAppId);
  if (!selfOpenId || !messageMentionsBot(message, larkAppId, selfOpenId)) return [];

  const senders = new Set(opts.senderIds.filter((x): x is string => !!x));
  // 黑名单是 sender 维度的全局否决，必须先于「它是不是委托方」生效：拉黑只拦它自己说话
  // 不够，还得挡住它替别人开门（下游 bot 闸随后丢掉它这条消息，于是「被黑的 bot 授权
  // 成功、自己的消息被吞」，更难排查）。
  if ([...senders].some(id => getBot(larkAppId).resolvedBlockedUsers.includes(id))) return [];
  // 先挑点名对象：绝大多数 bot 消息只 @ 了本 bot，没有可授权的人就不必去读配置判委托方。
  const mentioned = delegatedGrantTargets(message, selfOpenId, larkAppId, senders);
  if (mentioned.length === 0) return [];
  const delegator = resolveGrantDelegator(larkAppId, opts);
  if (!delegator) return [];

  // evaluateTalk 而不是 canTalk：黑名单腿排在 chatGrant 之前，被黑用户 canTalk=false
  // 但绝不能给 ta 落授权、更不能回「已获授权」卡（与 maybeSendGrantRequestCard 的
  // blocked 短路一致）。其余「已能对话」（owner/oncall/peer/已有授权/开放模式）跳过。
  const targets = mentioned.filter((tgt) => {
    const r = evaluateTalk(larkAppId, chatId, tgt.openId);
    return !r.allowed && r.reason !== 'blocked';
  });
  if (targets.length === 0) return [];

  const botConfig = getBot(larkAppId).config;
  const quota = botConfig.messageQuota?.defaultLimit ?? DEFAULT_GRANT_QUOTA;
  const durationMs = botConfig.grantDefaultDurationMs ?? DEFAULT_GRANT_DURATION_MS;
  const expiresAt = Date.now() + durationMs;

  // 逐人落库。能走到这里的人必然还不能对话——有效期内的既有授权已被上面的 evaluateTalk
  // 滤掉，所以成功的只有两种：首次授权，与授权过期后被重新点名（chatGrants 行仍在，
  // 只重置额度/有效期）。两种都要回结果卡：过期后的人需要知道自己又能说话了。
  const granted: Array<{ openId: string; name?: string }> = [];
  for (const tgt of targets) {
    try {
      const r = await addChatGrant(larkAppId, chatId, tgt.openId, quota, expiresAt);
      if (!r.ok) {
        logger.warn(`[grant:${larkAppId}] delegated grant failed for ${tgt.openId}: ${r.reason}`);
        continue;
      }
      granted.push({ openId: tgt.openId, name: tgt.name });
    } catch (err) {
      logger.warn(`[grant:${larkAppId}] delegated grant threw for ${tgt.openId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (granted.length === 0) return [];

  logger.info(`[grant:${larkAppId}] delegated chat grant (${delegator}) by ${[...senders].join('/')} in ${chatId}: ${granted.map(g => g.openId).join(', ')}`);
  // 结果卡与 owner 点卡授权后同款。被授权的 bot 只渲染纯文本名字、不发 <at>，
  // 否则 @ 通知会唤醒对方 bot 误处理这条「已获授权」消息（与 card-handler 授权回调同源处理，
  // 见其 renderGrantAtMentions 的 isBot 约定）。查通讯录失败按 bot 处理（宁可少 @ 一次）。
  const humanFlags = await Promise.all(granted.map(g => isHumanOpenId(larkAppId, g.openId).catch(() => false)));
  const notifyTargets = granted.map((g, i) => ({ openId: g.openId, name: g.name, isBot: !humanFlags[i] }));
  const card = buildGrantResultCard('chat', localeForBot(larkAppId), quota, expiresAt, notifyTargets);
  await replyMessage(larkAppId, message.message_id, card, 'interactive')
    .catch(err => logger.debug(`delegated grant notify failed: ${err}`));
  return granted.map(g => g.openId);
}
