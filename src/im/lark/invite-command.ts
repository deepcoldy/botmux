/**
 * 拉 bot 进群元命令：`@bot /invite @目标bot [@目标bot2 ...]`，也支持
 * `@bot /invite --app cli_xxx（可多个）` 直接按 app_id 拉任意飞书应用。
 *
 * 与 /grant 同款拦截模型（在 dispatcher 路由/spawn 之前处理，见 event-dispatcher）：
 *  - 必须明确 @ 本 bot 才执行（多 bot 群防重复处理）——执行方（inviter）必须本身
 *    在群内，飞书要求 inviter 是群成员，本 bot 处理这条消息天然满足；
 *  - 仅 owner 可用（对齐 /grant 的权限模型）；
 *  - 命令词之后的 @ 才是目标（共享 mention-targets.ts 的位置解析）。
 *
 * 目标 mention → larkAppId 的解析不走群成员表（目标恰恰不在群里），改查
 * 部署级共享花名册 bots-info.json（每个 daemon 启动时 merge 写入），按显示名
 * 唯一匹配（大小写不敏感，与 /group 的 knownBotNames 判定同款）；重名 / 查无
 * 时按目标报错，并提示用 --app 直通。已在群内的目标（live 群 bot 成员表能
 * 对上的）跳过并报「已在群内」，幂等。
 *
 * 拉人走 services/groups-store.ts 的 addBotToChat（proxy=本 bot），与 /group、
 * dashboard groups 面板、vc-agent 共用同一封装；批量失败时回退逐个拉（镜像
 * group-creator 的批处理回退）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOwnerOpenId, getBotOpenId } from '../../bot-registry.js';
import { config } from '../../config.js';
import { isBotMentioned, extractMessageTextForRouting } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { addBotToChat } from '../../services/groups-store.js';
import { listChatBotMembers, replyMessage } from './client.js';
import type { ChatBotMember } from './client.js';
import { localeForBot, t } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import { parseTargetsAfterCommand, isCommandTargetOnly, stripAllMentions } from './mention-targets.js';

const INVITE_CMD_PATTERN = /\/invite\b/i;

/** app_id 的合法形状（飞书自建/商店应用均为 cli_ 前缀）。 */
const APP_ID_PATTERN = /^cli_[A-Za-z0-9]+$/;

/** 飞书 chatMembers.create 的 id_list 上限很小（实测 >5 即 400，见 group-creator），按 5 一批。 */
const INVITE_BATCH_SIZE = 5;

interface BotsInfoEntry { larkAppId: string; botName: string | null }

/** 读部署共享花名册 bots-info.json；文件缺失/损坏按空花名册处理（名字解析全部走不通，提示 --app）。 */
export function readBotsInfoEntries(): BotsInfoEntry[] {
  try {
    const p = join(config.session.dataDir, 'bots-info.json');
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e: any) => typeof e?.larkAppId === 'string' && e.larkAppId);
  } catch {
    return [];
  }
}

interface ParsedInviteArgs {
  /** --app 指定的 app_id（按出现顺序、去重）。 */
  appIds: string[];
  /** --app 后跟的非法 token（非 cli_ 形状）。 */
  badAppTokens: string[];
  /** 剥掉 /invite、所有 @、所有 --app x 之后的残余文本（应为空，否则 usage）。 */
  leftover: string;
}

/** 从已 stripLeadingMentions 的命令文本解析 --app 参数。 */
export function parseInviteArgs(text: string, mentions: any[]): ParsedInviteArgs {
  // 先剥 mention 显示名（避免 @名字 里的空格干扰 token 切分），再去命令词。
  const body = stripAllMentions(text, mentions).replace(INVITE_CMD_PATTERN, ' ');
  const appIds: string[] = [];
  const badAppTokens: string[] = [];
  const leftoverTokens: string[] = [];
  const tokens = body.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const inline = /^--app=(\S+)$/.exec(tok);
    if (inline) {
      (APP_ID_PATTERN.test(inline[1]) ? appIds : badAppTokens).push(inline[1]);
      continue;
    }
    if (tok === '--app') {
      const next = tokens[++i];
      if (next === undefined) { badAppTokens.push(''); continue; }
      (APP_ID_PATTERN.test(next) ? appIds : badAppTokens).push(next);
      continue;
    }
    leftoverTokens.push(tok);
  }
  return { appIds: [...new Set(appIds)], badAppTokens, leftover: leftoverTokens.join(' ') };
}

/** 批量拉人；整批全失败且 >1 个时回退逐个拉（镜像 group-creator 的批处理回退）。 */
async function addBotsResilient(larkAppId: string, chatId: string, ids: string[]) {
  let results: { id: string; ok: boolean; error?: string }[] = [];
  for (let i = 0; i < ids.length; i += INVITE_BATCH_SIZE) {
    const batch = ids.slice(i, i + INVITE_BATCH_SIZE);
    let r = await addBotToChat(larkAppId, chatId, batch);
    if (batch.length > 1 && r.every(x => !x.ok)) {
      // 整批失败可能是单个坏 id 拖累全批 → 逐个隔离重试，让好 id 落进去。
      const perId: typeof r = [];
      for (const id of batch) perId.push(...await addBotToChat(larkAppId, chatId, [id]));
      r = perId;
    }
    results.push(...r);
  }
  return results;
}

/** 返回 true 表示已拦截（不再进入路由/spawn）。 */
export async function tryHandleInviteCommand(
  larkAppId: string, message: any, senderOpenId: string | undefined,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  // 先 strip 掉开头的 @<mention>（含本 bot），否则 `@bot /invite @x` 匹配不到命令词。
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  if (!/^\/invite(\s|$)/i.test(text)) return false;

  const myOpenId = getBotOpenId(larkAppId);
  const messageId = message.message_id;
  const chatId = message.chat_id;
  const loc = localeForBot(larkAppId);
  const reply = (key: string, params?: Record<string, string | number>) =>
    replyMessage(larkAppId, messageId, t(key, params, loc))
      .catch(err => logger.debug(`invite ${key} reply failed: ${err}`));

  // 本 bot 只是作为 /invite 的【目标】被 @（`@OperatorBot /invite @ThisBot`）→ 命令属于
  // 前导 @ 的操作 bot，本 bot 必须静默放手（同 /grant 的 target-only 守卫）。传 larkAppId
  // 让 guard 也认 app_id 形态的本 bot @（群外/协作 bot 常以 app_id 被 @，只认 open_id 会漏判）。
  if (isCommandTargetOnly(message, myOpenId, INVITE_CMD_PATTERN, larkAppId)) {
    logger.debug(`[invite:${larkAppId}] ignoring /invite where this bot is only a target`);
    return true;
  }

  // 私聊拉不了成员。必须在 isBotMentioned 选举门之前：DM 里没有群成员表、用户
  // @ 不出本 bot，放选举门后面这条提示永远不可达，用户只会看到沉默。
  if (message?.chat_type === 'p2p') {
    await reply('cmd.invite.p2p');
    return true;
  }

  // 多 bot 群：必须明确 @ 当前 bot 才由本 daemon 处理；否则吞掉（不喂 CLI）。
  if (!isBotMentioned(larkAppId, message, senderOpenId)) return true;

  // owner 强闸门（对齐 /grant）。
  const owner = getOwnerOpenId(larkAppId);
  if (!senderOpenId || senderOpenId !== owner) {
    await reply('cmd.invite.owner_only');
    return true;
  }

  if (!chatId) {
    await reply('cmd.invite.usage');
    return true;
  }

  const mentionTargets = parseTargetsAfterCommand(message, myOpenId, INVITE_CMD_PATTERN);
  const args = parseInviteArgs(text, message?.mentions ?? []);
  if (args.badAppTokens.length > 0 || args.leftover) {
    await reply('cmd.invite.usage');
    return true;
  }
  if (mentionTargets.length === 0 && args.appIds.length === 0) {
    await reply('cmd.invite.usage');
    return true;
  }

  // live 群 bot 成员表：already-in-chat 判定的权威源。拿不到就降级为空表——
  // 飞书 API 自身对重复拉人也是幂等报错，不至于出错事（与 /group 对 listChatBotMembers
  // 的容错一致）。
  let roster: ChatBotMember[] = [];
  try {
    roster = await listChatBotMembers(larkAppId, chatId);
  } catch (e: any) {
    logger.warn(`[invite:${larkAppId}] failed to list chat bot members (already-in-chat detection degraded): ${e?.message ?? e}`);
  }
  const rosterOpenIds = new Set(roster.map(m => m.openId));
  const rosterAppIds = new Set(roster.map(m => m.larkAppId).filter(Boolean));
  const rosterNameById = new Map(roster.filter(m => m.larkAppId).map(m => [m.larkAppId, m.displayName || m.name || m.larkAppId]));

  const botsInfo = readBotsInfoEntries();
  const byLowerName = new Map<string, BotsInfoEntry[]>();
  for (const e of botsInfo) {
    const k = e.botName?.toLowerCase();
    if (!k) continue;
    (byLowerName.get(k) ?? byLowerName.set(k, []).get(k)!).push(e);
  }
  const nameOf = (appId: string) =>
    botsInfo.find(e => e.larkAppId === appId)?.botName ?? rosterNameById.get(appId) ?? appId;

  const toInvite: string[] = [];
  const already: string[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];

  for (const tgt of mentionTargets) {
    // 已在群内：open_id 命中 live 成员表即跳过（app_id 形态目标无 open_id，靠下方 appId 分支的 rosterAppIds 判定）。
    if (tgt.openId && rosterOpenIds.has(tgt.openId)) { already.push(tgt.name); continue; }
    // 目标 mention 自带 app_id（飞书对「群外 bot」的 @ 形态）→ app_id 就是待拉 id，
    // 直接用，跳过名字→花名册解析（更可靠，规避重名/查无）。
    if (tgt.appId) {
      if (tgt.appId === larkAppId || rosterAppIds.has(tgt.appId)) already.push(tgt.name);
      else if (!toInvite.includes(tgt.appId)) toInvite.push(tgt.appId);
      continue;
    }
    // 仅有 open_id（无 app_id）：按显示名查部署花名册解析出 app_id。
    const candidates = tgt.name ? (byLowerName.get(tgt.name.toLowerCase()) ?? []) : [];
    if (candidates.length === 1) {
      const appId = candidates[0].larkAppId;
      if (appId === larkAppId || rosterAppIds.has(appId)) already.push(tgt.name);
      else if (!toInvite.includes(appId)) toInvite.push(appId);
    } else if (candidates.length > 1) {
      ambiguous.push(t('cmd.invite.ambiguous_item', { name: tgt.name, apps: candidates.map(c => c.larkAppId).join('、') }, loc));
    } else {
      unresolved.push(tgt.name || tgt.openId);
    }
  }
  for (const appId of args.appIds) {
    if (appId === larkAppId || rosterAppIds.has(appId)) already.push(nameOf(appId));
    else if (!toInvite.includes(appId)) toInvite.push(appId);
  }

  const added: string[] = [];
  const failed: string[] = [];
  if (toInvite.length > 0) {
    const results = await addBotsResilient(larkAppId, chatId, toInvite);
    for (const r of results) {
      if (r.ok) added.push(nameOf(r.id));
      else failed.push(t('cmd.invite.failed_item', { name: nameOf(r.id), reason: r.error ?? 'unknown' }, loc));
    }
  }

  const sections: string[] = [];
  if (added.length) sections.push(t('cmd.invite.ok', { names: added.join('、') }, loc));
  if (already.length) sections.push(t('cmd.invite.already', { names: [...new Set(already)].join('、') }, loc));
  if (unresolved.length) sections.push(t('cmd.invite.unresolved', { names: [...new Set(unresolved)].join('、') }, loc));
  if (ambiguous.length) sections.push(...ambiguous);
  if (failed.length) sections.push(...failed);
  const body = sections.join('\n') || t('cmd.invite.usage', undefined, loc);
  await replyMessage(larkAppId, messageId,
    toInvite.length > 0 || already.length > 0 ? t('cmd.invite.header', undefined, loc) + '\n' + body : body,
  ).catch(err => logger.debug(`invite result reply failed: ${err}`));
  logger.info(
    `[invite:${larkAppId}] chat=${chatId} added=[${added}] already=[${already}] ` +
    `unresolved=[${unresolved}] ambiguous=${ambiguous.length} failed=[${failed}]`,
  );
  return true;
}
