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
import { openPendingMulti } from './grant-pending.js';
import { revokeGrant, addAllowedChatGroup, removeAllowedChatGroup } from '../../services/grant-store.js';
import { replyMessage } from './client.js';
import { localeForBot, t } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import {
  parseTargetsAfterCommand, isCommandTargetOnly, stripAllMentions,
} from './mention-targets.js';
import { DEFAULT_GRANT_DURATION_MS, DEFAULT_GRANT_QUOTA } from '../../services/grant-policy.js';

export { stripAllMentions };

/** /grant|/revoke 的命令词匹配（带 \b 边界）。共享解析器见 mention-targets.ts。 */
const GRANT_CMD_PATTERN = /\/(?:grant|revoke)\b/i;

/** 取所有非本 bot 的【授权目标】（可以是真人，也可以是另一个 bot——
 *  授权 bot 走同一条路，命中后写本群 chatGrants，放行其在本群拉起 chat-scope 会话）。
 *  按 open_id 去重、保持 @ 顺序，支持一次 /grant @a @b、/revoke @a @b 批量处置。
 *
 *  **只取「命令词 /grant|/revoke 之后」出现的 @**：命令词之前的 @ 是「点名让哪个 bot 执行」
 *  （`@OperatorBot /grant @Grantee`），不是 grantee。否则 owner 一条 `@Claude @Codex /grant`
 *  把两个操作 bot 都前导 @ 了，每个 daemon 会把「另一个 bot」当成目标 → 两 bot 互相授权
 *  （实测 bug）。位置过滤仅在能拿到位置信息（text 形态的 key / post 的节点序）时生效；
 *  纯 mentions 的合成消息（无 content.text）退回历史「全部非本 bot」行为。
 *  实现在 mention-targets.ts（与 /invite 共享）。 */
export function parseGrantTargets(message: any, botOpenId: string | undefined): Array<{ openId: string; name: string }> {
  // /grant 只接受 open_id 主体（授权对象是人 / 群内 bot）。共享解析器现在也收
  // app_id-only 的 mention（/invite 拉群外 bot 用），但那种目标对授权无意义且过去
  // 就被 mentionOpenId 直接 drop——过滤掉 openId 为空的项，保持 grant 行为 byte-parity。
  return parseTargetsAfterCommand(message, botOpenId, GRANT_CMD_PATTERN)
    .filter(t => t.openId)
    .map(t => ({ openId: t.openId, name: t.name }));
}

/**
 * 命令词之后是否存在**任何**目标 mention（含 app_id-only 的群外/协作 bot）。
 * parseGrantTargets 会把 app_id-only 目标 .filter 掉，于是 `@OperatorBot /grant
 * @OtherBot(app_id-only)` 在 operator daemon 里 targets 会变空 → 若据此走裸 /grant
 * 整群授权分支 = 提权（owner 本意是授权某个 bot，却误对全群开放 talk）。用未过滤的
 * raw 解析识别「指了目标但都不可按 open_id 授权」，让 handler fail closed 回 usage。
 */
export function hasAnyTargetMention(message: any, botOpenId: string | undefined): boolean {
  return parseTargetsAfterCommand(message, botOpenId, GRANT_CMD_PATTERN).length > 0;
}

/** 取第一个非本 bot 的目标（单目标场景的便捷封装）。 */
export function parseGrantTarget(message: any, botOpenId: string | undefined): { openId: string; name: string } | undefined {
  return parseGrantTargets(message, botOpenId)[0];
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

/**
 * 本 bot 是否「只是作为 /grant、/revoke 的目标」被 @（@ 出现在命令词之后），
 * 而不是被前导 @ 点名执行命令的操作 bot。命中（仅目标）返回 true，调用方应静默放手——
 * 否则异主目标 bot 会误回 owner_only、同主目标 bot 会把自己剔空后误开整群授权。
 * 实现细节（text/post 双形态、key 前缀歧义规避、open_id + app_id 双判据）见 mention-targets.ts。
 * botAppId（本 bot larkAppId）让 guard 也认 app_id 形态的本 bot @（协作 bot 常以 app_id 被 @）。
 */
export function isGrantTargetOnly(message: any, botOpenId: string | undefined, botAppId?: string): boolean {
  return isCommandTargetOnly(message, botOpenId, GRANT_CMD_PATTERN, botAppId);
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

  // 本 bot 只是作为 /grant、/revoke 的【目标】被 @（`@OperatorBot /grant @ThisBot`，
  // 常见于 owner 用 `/grant @bot` 授权另一个 bot 在本群协作）→ 这条命令是发给前导 @ 的
  // 操作 bot 的，本 bot 的 daemon 必须放手：既不能回 owner_only（异主 bot 会误报「仅 owner
  // 可使用 /grant」），也不能把自己从 targets 剔空后误判成裸 /grant 给整群开授权。
  if (isGrantTargetOnly(message, getBotOpenId(larkAppId), larkAppId)) {
    logger.debug(`[grant:${larkAppId}] ignoring /grant|/revoke where this bot is only a target`);
    return true;  // 拦截（不喂 CLI），但不回复、不改授权——命令属于操作 bot
  }

  // 多 bot 群：必须明确 @ 当前 bot 才由本 daemon 处理；否则吞掉（不喂 CLI）。
  if (!isBotMentioned(larkAppId, message, senderOpenId)) return true;

  const loc = localeForBot(larkAppId);
  const messageId = message.message_id;
  const chatId = message.chat_id;

  // owner 强闸门
  const owner = getOwnerOpenId(larkAppId);
  if (!senderOpenId || senderOpenId !== owner) {
    await replyMessage(larkAppId, messageId, t(isGrant ? 'cmd.grant.owner_only' : 'cmd.revoke.owner_only', undefined, loc))
      .catch(err => logger.debug(`grant owner_only reply failed: ${err}`));
    return true;
  }

  const targets = parseGrantTargets(message, getBotOpenId(larkAppId));

  // 无 @目标（裸 `/grant`、`/grant all`、裸 `/revoke`）→ 整群 talk 授权：把当前 chat 加入/移出
  // allowedChatGroups（chatId 级 talk-open，仅 canTalk，不授 canOperate）。
  if (targets.length === 0) {
    if (!chatId) {
      await replyMessage(larkAppId, messageId, t(isGrant ? 'cmd.grant.usage' : 'cmd.revoke.usage', undefined, loc))
        .catch(err => logger.debug(`grant usage reply failed: ${err}`));
      return true;
    }
    // fail closed：命令后其实**有**目标 mention，只是都是 app_id-only（群外/协作 bot，
    // 被 parseGrantTargets .filter 掉）→ owner 本意是授权某个 bot，绝不能退化成「对全群
    // 开放 talk」的整群授权（operator daemon 视角的提权）。回 usage，明确不按 app_id 授权。
    if (hasAnyTargetMention(message, getBotOpenId(larkAppId))) {
      await replyMessage(larkAppId, messageId, t(isGrant ? 'cmd.grant.usage' : 'cmd.revoke.usage', undefined, loc))
        .catch(err => logger.debug(`grant app-id-target guard reply failed: ${err}`));
      return true;
    }
    // 无 @目标时只接受"整群"意图：精确 `/grant`（空尾巴）或 `/grant all`。带其它 token
    // （尤其 `/grant 5` —— owner 漏 @ 人却写了额度数字）绝不当成整群授权打开 talk，回 usage，
    // 避免把"给某人 5 条额度"误执行成"对全群开放对话"。
    const rest = stripAllMentions(text, message?.mentions ?? []).replace(/^\/(grant|revoke)\b/i, '').trim();
    if (rest !== '' && rest.toLowerCase() !== 'all') {
      await replyMessage(larkAppId, messageId, t(isGrant ? 'cmd.grant.bad_quota' : 'cmd.revoke.usage', undefined, loc))
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
    await replyMessage(larkAppId, messageId, txt)
      .catch(err => logger.debug(`grant whole-chat reply failed: ${err}`));
    logger.info(`[grant:${larkAppId}] ${isGrant ? 'grant' : 'revoke'} whole-chat ${chatId}`);
    return true;
  }

  if (isRevoke) {
    // 逐个撤销，单目标沿用原文案，多目标合并成一条「撤销结果」清单。
    const lines: string[] = [];
    for (const tgt of targets) {
      const r = await revokeGrant(larkAppId, chatId, tgt.openId);
      if (!r.ok) {
        if (targets.length === 1) {
          lines.push(r.reason === 'would_open_bot'
            ? t('cmd.revoke.would_open', undefined, loc)
            : t('cmd.revoke.failed', { reason: r.reason }, loc));
        } else {
          lines.push(r.reason === 'would_open_bot'
            ? t('cmd.revoke.multi_would_open', { name: tgt.name }, loc)
            : t('cmd.revoke.multi_failed', { name: tgt.name, reason: r.reason }, loc));
        }
        continue;
      }
      const scope = `${r.removed.chat ? t('cmd.revoke.scope_chat', undefined, loc) : ''}${r.removed.globalTalk ? t('cmd.revoke.scope_global_talk', undefined, loc) : ''}${r.removed.global ? t('cmd.revoke.scope_global', undefined, loc) : ''}`.trim()
        || t('cmd.revoke.scope_none', undefined, loc);
      lines.push(targets.length === 1
        ? t('cmd.revoke.done', { name: tgt.name, scope }, loc)
        : t('cmd.revoke.multi_ok', { name: tgt.name, scope }, loc));
    }
    const txt = targets.length === 1
      ? lines[0]
      : `${t('cmd.revoke.multi_header', undefined, loc)}\n${lines.join('\n')}`;
    await replyMessage(larkAppId, messageId, txt)
      .catch(err => logger.debug(`revoke reply failed: ${err}`));
    logger.info(`[grant:${larkAppId}] revoke ${targets.length} target(s) in ${chatId}`);
    return true;
  }

  // 解析可选额度：`/grant @x 5`（多目标时对每人各 N 条）。显式数字恒生效；
  // 无数字优先取 per-bot 覆盖值，未配置时使用卡片内置 3 条。
  const pq = parseGrantQuota(text, message?.mentions ?? []);
  if (!pq.ok) {
    await replyMessage(larkAppId, messageId, t('cmd.grant.bad_quota', undefined, loc))
      .catch(err => logger.debug(`grant bad_quota reply failed: ${err}`));
    return true;
  }
  const botConfig = getBot(larkAppId).config;
  const quota = pq.quota ?? botConfig.messageQuota?.defaultLimit ?? DEFAULT_GRANT_QUOTA;
  const durationMs = botConfig.grantDefaultDurationMs ?? DEFAULT_GRANT_DURATION_MS;

  // /grant → 弹一张卡（owner 主动态），列出全部目标；owner 点一次范围按钮即对全部生效。额度（若有）对每个目标各自挂在 pending 上。
  const nonce = openPendingMulti(
    larkAppId,
    chatId,
    targets.map(tgt => tgt.openId),
    quota,
    undefined,
    durationMs,
  );
  const card = buildGrantCard(
    {
      ownerOpenId: owner!,
      targets,
      chatId,
      nonce,
      mode: 'owner',
      quota,
      durationMs,
    },
    loc,
  );
  await replyMessage(larkAppId, messageId, card, 'interactive')
    .catch(err => logger.debug(`grant card reply failed: ${err}`));
  logger.info(`[grant:${larkAppId}] owner /grant card for ${targets.length} target(s) in ${chatId}`);
  return true;
}
