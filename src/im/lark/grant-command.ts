/**
 * 群内授权元命令：`@bot /grant @user`、`@bot /revoke @user`。
 * 在 dispatcher 路由/spawn 之前拦截，仅 owner 可用。
 * 与 /introduce 不同：必须确认本 bot 被 @（多 bot 群防重复处理），
 * 且解析 target 时排除 bot 自身。
 */
import { getOwnerOpenId, getBotOpenId, getBot } from '../../bot-registry.js';
import { isBotMentioned, extractMessageTextForRouting } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { buildGrantCard } from './card-builder.js';
import { openPending } from './grant-pending.js';
import { revokeGrant, addAllowedChatGroup, removeAllowedChatGroup } from '../../services/grant-store.js';
import { replyMessage } from './client.js';
import { localeForBot, t } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

/** 从 mention 列表取第一个非本 bot 的对象（可以是真人，也可以是另一个 bot——
 *  授权 bot 走同一条路，命中后写本群 chatGrants，放行其在本群拉起 chat-scope 会话）。 */
export function parseGrantTarget(message: any, botOpenId: string | undefined): { openId: string; name: string } | undefined {
  const m = (message?.mentions ?? []).find((x: any) => x?.id?.open_id && x.id.open_id !== botOpenId);
  return m ? { openId: m.id.open_id, name: m.name ?? m.id.open_id } : undefined;
}

/** 把文本里所有 `@<name>` mention token 去掉（split/join，防正则注入），归一空白后 trim。 */
export function stripAllMentions(text: string, mentions: any[]): string {
  let s = text;
  for (const m of mentions ?? []) {
    const name = m?.name;
    if (typeof name === 'string' && name.length) s = s.split(`@${name}`).join(' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 解析 `/grant @x [N]` 里可选的消息额度 N。`text` 已 stripLeadingMentions（去开头 @bot），
 * 这里把剩余所有 `@<name>` mention 也剥掉，剩下应只是 `/grant` 或 `/grant <token>`。
 * N 必须是唯一尾部正整数 token；0 / 负数 / 小数 / 多余尾巴 → { ok:false }（调用方回 usage）。
 */
export function parseGrantQuota(text: string, mentions: any[]): { ok: true; quota?: number } | { ok: false } {
  const mm = /^\/grant(?:\s+(\S+))?$/i.exec(stripAllMentions(text, mentions));
  if (!mm) return { ok: false };                 // 多余尾巴 / 解析不出
  const tok = mm[1];
  if (tok === undefined) return { ok: true, quota: undefined };  // 无数字
  if (!/^\d+$/.test(tok)) return { ok: false };  // 负号 / 小数 / 非数字
  const n = parseInt(tok, 10);
  if (n <= 0) return { ok: false };              // \d+ 已保证整数，仅需挡 0
  return { ok: true, quota: n };
}

/** 返回 true 表示已拦截（不再进入路由/spawn）。 */
export async function tryHandleGrantCommand(
  larkAppId: string, message: any, senderOpenId: string | undefined,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  // 先 strip 掉开头的 @<mention>（含本 bot），否则 `@bot /grant @x` 解析后是
  // `@Claude /grant @x`，正则匹配不到。与 /introduce 同款处理。
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  const isGrant = /^\/grant(\s|$)/i.test(text);
  const isRevoke = /^\/revoke(\s|$)/i.test(text);
  if (!isGrant && !isRevoke) return false;

  // 多 bot 群：必须明确 @ 当前 bot 才由本 daemon 处理；否则吞掉（不喂 CLI）。
  if (!isBotMentioned(larkAppId, message, senderOpenId)) return true;

  const loc = localeForBot(larkAppId);
  const messageId = message.message_id;
  const chatId = message.chat_id;

  // owner 强闸门
  const owner = getOwnerOpenId(larkAppId);
  if (!senderOpenId || senderOpenId !== owner) {
    await replyMessage(larkAppId, messageId, JSON.stringify({ text: t(isGrant ? 'cmd.grant.owner_only' : 'cmd.revoke.owner_only', undefined, loc) }))
      .catch(err => logger.debug(`grant owner_only reply failed: ${err}`));
    return true;
  }

  const target = parseGrantTarget(message, getBotOpenId(larkAppId));

  // 无 @目标（裸 `/grant`、`/grant all`、裸 `/revoke`）→ 整群 talk 授权：把当前 chat 加入/移出
  // allowedChatGroups（chatId 级 talk-open，仅 canTalk，不授 canOperate）。
  if (!target) {
    if (!chatId) {
      await replyMessage(larkAppId, messageId, JSON.stringify({ text: t(isGrant ? 'cmd.grant.usage' : 'cmd.revoke.usage', undefined, loc) }))
        .catch(err => logger.debug(`grant usage reply failed: ${err}`));
      return true;
    }
    // 无 @目标时只接受"整群"意图：精确 `/grant`（空尾巴）或 `/grant all`。带其它 token
    // （尤其 `/grant 5` —— owner 漏 @ 人却写了额度数字）绝不当成整群授权打开 talk，回 usage，
    // 避免把"给某人 5 条额度"误执行成"对全群开放对话"。
    const rest = stripAllMentions(text, message?.mentions ?? []).replace(/^\/(grant|revoke)\b/i, '').trim();
    if (rest !== '' && rest.toLowerCase() !== 'all') {
      await replyMessage(larkAppId, messageId, JSON.stringify({ text: t(isGrant ? 'cmd.grant.bad_quota' : 'cmd.revoke.usage', undefined, loc) }))
        .catch(err => logger.debug(`grant no-target guard reply failed: ${err}`));
      return true;
    }
    let txt: string;
    if (isGrant) {
      const r = await addAllowedChatGroup(larkAppId, chatId);
      txt = !r.ok
        ? t('cmd.grant.chat_failed', { reason: r.reason }, loc)
        : r.created ? t('cmd.grant.chat_done', undefined, loc) : t('cmd.grant.chat_already', undefined, loc);
    } else {
      const r = await removeAllowedChatGroup(larkAppId, chatId);
      txt = !r.ok
        ? t('cmd.revoke.chat_failed', { reason: r.reason }, loc)
        : r.removed ? t('cmd.revoke.chat_done', undefined, loc) : t('cmd.revoke.chat_none', undefined, loc);
    }
    await replyMessage(larkAppId, messageId, JSON.stringify({ text: txt }))
      .catch(err => logger.debug(`grant whole-chat reply failed: ${err}`));
    logger.info(`[grant:${larkAppId}] ${isGrant ? 'grant' : 'revoke'} whole-chat ${chatId}`);
    return true;
  }

  if (isRevoke) {
    const r = await revokeGrant(larkAppId, chatId, target.openId);
    let txt: string;
    if (!r.ok) {
      txt = r.reason === 'would_open_bot'
        ? t('cmd.revoke.would_open', undefined, loc)
        : t('cmd.revoke.failed', { reason: r.reason }, loc);
    } else {
      const scope = `${r.removed.chat ? t('cmd.revoke.scope_chat', undefined, loc) : ''}${r.removed.globalTalk ? t('cmd.revoke.scope_global_talk', undefined, loc) : ''}${r.removed.global ? t('cmd.revoke.scope_global', undefined, loc) : ''}`.trim()
        || t('cmd.revoke.scope_none', undefined, loc);
      txt = t('cmd.revoke.done', { name: target.name, scope }, loc);
    }
    await replyMessage(larkAppId, messageId, JSON.stringify({ text: txt }))
      .catch(err => logger.debug(`revoke reply failed: ${err}`));
    return true;
  }

  // 解析可选额度：`/grant @x 5`。显式数字恒生效；无数字时取 messageQuota.defaultLimit（未配=无限）。
  const pq = parseGrantQuota(text, message?.mentions ?? []);
  if (!pq.ok) {
    await replyMessage(larkAppId, messageId, JSON.stringify({ text: t('cmd.grant.bad_quota', undefined, loc) }))
      .catch(err => logger.debug(`grant bad_quota reply failed: ${err}`));
    return true;
  }
  const quota = pq.quota ?? getBot(larkAppId).config.messageQuota?.defaultLimit;

  // /grant → 弹卡（owner 主动态），owner 点范围按钮完成授权。额度（若有）挂在 pending 上。
  const nonce = openPending(larkAppId, chatId, target.openId, quota);
  const card = buildGrantCard(
    { ownerOpenId: owner!, requesterOpenId: target.openId, requesterName: target.name, chatId, nonce, mode: 'owner' },
    loc,
  );
  await replyMessage(larkAppId, messageId, card, 'interactive')
    .catch(err => logger.debug(`grant card reply failed: ${err}`));
  logger.info(`[grant:${larkAppId}] owner /grant card for ${target.openId} in ${chatId}`);
  return true;
}
