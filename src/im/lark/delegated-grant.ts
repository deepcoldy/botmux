/**
 * 委托授权：受信 bot（`grantDelegateBots`）在群里 @ 本 bot 时，把同一条消息里被它点名的
 * 其他人写进本群 chatGrants —— 与 owner 在授权卡上点「本群」同效（talk-only，额度/有效期
 * 取 /grant 的默认值），省掉「被点名的人 @ 本 bot → 弹申请卡 → 等 owner 手点」这一轮。
 *
 * 典型用法：外部平台用自己的 bot 建群拉人，再发一张 @本 bot 的开场卡，卡里同时 @ 提需求的人；
 * 平台自己点名的人就是它想让本 bot 服务的人，无需 owner 逐个批。
 *
 * 信任锚是飞书盖章的 bot 发送方（调用方只在 sender_type=app|bot 分支调用）+ owner 在
 * bots.json 显式列出的 bot 身份；绝不写 allowedUsers / allowedChatGroups / globalGrants，
 * 不授 canOperate。已经能和本 bot 对话的人（owner、oncall 群成员、已有授权……）跳过，不重复落库。
 */
import { getBot, getBotOpenId } from '../../bot-registry.js';
import { evaluateTalk } from './event-dispatcher.js';
import { extractMentionIdentities } from './message-parser.js';
import { buildGrantResultCard } from './card-builder.js';
import { isHumanOpenId, replyMessage } from './client.js';
import { addChatGrant } from '../../services/grant-store.js';
import { DEFAULT_GRANT_DURATION_MS, DEFAULT_GRANT_QUOTA } from '../../services/grant-policy.js';
import { localeForBot } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

/** 发送方是否是本 bot 配置的委托授权 bot。open_id（本 app 视角）或 app_id 任一命中即算。 */
export function isGrantDelegateSender(larkAppId: string, senderIds: Array<string | undefined>): boolean {
  const delegates = getBot(larkAppId).config.grantDelegateBots;
  if (!delegates?.length) return false;
  return senderIds.some(id => !!id && delegates.includes(id));
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
    if (!oid || !oid.startsWith('ou_') || oid === 'all') continue;
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
 * 处理一条已确认 @ 了本 bot 的 bot 消息。发送方不是委托 bot（或被拉黑）/ 非群聊 /
 * 没有可授权的人时什么都不做。
 * 返回本次落库授权的 open_id 列表（首次授权 + 过期后的重新授权；有效期内的既有授权会被上游跳过）。
 *
 * ⚠️ 调用方必须**先**跑完 `bindDefaultOncallBeforeTalk` 再调本函数：defaultOncall 群的
 * oncall 绑定是首条消息时懒写入的，先判 evaluateTalk 会看不到它，于是给本就能说话的人
 * 白写一条 chatGrant、并回一张「你已获授权」卡（oncall 群里属于噪音）。
 */
export async function applyDelegatedGrants(
  larkAppId: string,
  message: any,
  opts: { chatType: 'group' | 'p2p'; senderIds: Array<string | undefined> },
): Promise<string[]> {
  const chatId: string | undefined = message?.chat_id;
  if (opts.chatType !== 'group' || !chatId) return [];
  if (!isGrantDelegateSender(larkAppId, opts.senderIds)) return [];

  const senders = new Set(opts.senderIds.filter((x): x is string => !!x));
  // 黑名单是 sender 维度的全局否决，必须先于「它是不是委托 bot」生效：否则 owner 拉黑
  // 某个 bot 之后，只要 bots.json 里还留着它的 grantDelegateBots 条目，它照样能给别人
  // 发本群 talk 授权 —— 拉黑只拦它自己说话，拦不住它替别人开门（下游 bot 闸随后丢掉它
  // 这条消息，于是「被黑的 bot 授权成功、自己的消息被吞」，更难排查）。
  if ([...senders].some(id => getBot(larkAppId).resolvedBlockedUsers.includes(id))) {
    logger.info(`[grant:${larkAppId}] delegated grant skipped: delegate sender is blocked in ${chatId}`);
    return [];
  }
  // evaluateTalk 而不是 canTalk：黑名单腿排在 chatGrant 之前，被黑用户 canTalk=false
  // 但绝不能给 ta 落授权、更不能回「已获授权」卡（与 maybeSendGrantRequestCard 的
  // blocked 短路一致）。其余「已能对话」（owner/oncall/peer/已有授权/开放模式）跳过。
  const targets = delegatedGrantTargets(message, getBotOpenId(larkAppId), larkAppId, senders)
    .filter((tgt) => {
      const r = evaluateTalk(larkAppId, chatId, tgt.openId);
      return !r.allowed && r.reason !== 'blocked';
    });
  if (targets.length === 0) return [];

  const botConfig = getBot(larkAppId).config;
  const quota = botConfig.messageQuota?.defaultLimit ?? DEFAULT_GRANT_QUOTA;
  const durationMs = botConfig.grantDefaultDurationMs ?? DEFAULT_GRANT_DURATION_MS;
  const expiresAt = Date.now() + durationMs;

  // 逐人落库。注意：能走到这里的 canTalk 必为 false——有效期内的既有授权在上游
  // evaluateTalk 已被过滤，所以这里成功的只有两种人：首次授权（created=true）与
  // 授权过期后被重新点名（chatGrants 行仍在 → created=false，仅重置额度/有效期）。
  // 两种都要回结果卡：过期后的人需要知道自己又能说话了。
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

  logger.info(`[grant:${larkAppId}] delegated chat grant by ${[...senders].join('/')} in ${chatId}: ${granted.map(g => g.openId).join(', ')}`);
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
