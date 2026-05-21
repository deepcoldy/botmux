/**
 * Lark event dispatcher — handles WSClient setup, bot identity probing,
 * and message routing (group access checks, @mention detection).
 * Extracted from daemon.ts for modularity.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBot, getAllBots, isChatOncallBoundForAnyBot, getOwnerOpenId, type BotState } from '../../bot-registry.js';
import { config } from '../../config.js';
import { getChatInfo, getChatMode, listChatBotMembers, replyMessage, sendUserMessage } from './client.js';
import { logger } from '../../utils/logger.js';
import { parseForceTopicInvocation } from '../../core/command-handler.js';
import { stripLeadingMentions } from './message-parser.js';
import { recordObservedBots } from '../../services/observed-bots-store.js';
import { BOTMUX_REQUIRED_SCOPES, buildScopeDeepLink } from '../../setup/verify-permissions.js';
import { tryHandleGrantCommand } from './grant-command.js';
import { buildGrantCard } from './card-builder.js';
import { openPending, isThrottled } from './grant-pending.js';
import { localeForBot } from '../../i18n/index.js';

// ─── Bot identity ─────────────────────────────────────────────────────────

/** Set the bot's open_id. Callers should also call writeBotInfoFile() to persist. */
export function setBotOpenId(larkAppId: string, id: string): void {
  getBot(larkAppId).botOpenId = id;
}

/** Persist bot registry info to disk for agent-facing CLI subcommands to read.
 *  Merges current process's bot(s) into the existing file so that
 *  multiple daemon processes (one per bot) don't overwrite each other. */
export function writeBotInfoFile(dataDir: string): void {
  const filePath = join(dataDir, 'bots-info.json');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Read existing entries from other daemon processes
  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
  let existing: BotInfoEntry[] = [];
  try {
    if (existsSync(filePath)) {
      existing = JSON.parse(readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }

  // Build a map keyed by larkAppId, start with existing entries
  const map = new Map<string, BotInfoEntry>();
  for (const entry of existing) {
    if (entry.larkAppId) map.set(entry.larkAppId, entry);
  }

  // Upsert current process's bot(s)
  for (const b of getAllBots()) {
    map.set(b.config.larkAppId, {
      larkAppId: b.config.larkAppId,
      botOpenId: b.botOpenId ?? null,
      botName: b.botName ?? null,
      cliId: b.config.cliId,
    });
  }

  writeFileSync(filePath, JSON.stringify([...map.values()], null, 2) + '\n');
}

/**
 * Probe the bot's own open_id at startup via the Lark bot info API.
 */
export async function probeBotOpenId(larkAppId: string): Promise<void> {
  const bot = getBot(larkAppId);
  if (bot.botOpenId) return; // already known

  // Call /bot/v3/info to get the bot's open_id using tenant_access_token
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: bot.config.larkAppId, app_secret: bot.config.larkAppSecret }),
  });
  const tokenData = await tokenRes.json() as any;
  if (tokenData.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${tokenData.msg}`);
  }

  const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
    headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
  });
  const botData = await botRes.json() as any;
  if (botData.code !== 0) {
    throw new Error(`Failed to get bot info: ${botData.msg}`);
  }

  const openId = botData.bot?.open_id;
  const appName = botData.bot?.app_name;
  if (openId) {
    bot.botOpenId = openId;
    if (appName) bot.botName = appName;
    logger.info(`Bot open_id: ${bot.botOpenId}`);
  } else {
    throw new Error('No open_id in bot info response');
  }
}

// ─── Required-scope check ───────────────────────────────────────────────────
//
// Bot-to-bot @mention 投递依赖 "获取群组中其他机器人和用户@当前机器人的消息"
// 权限（scope: im:message.group_at_msg.include_bot:readonly）。该权限关闭
// 后飞书不会把跨 bot 的事件推到 WSClient，botmux 的 handleThreadReply 收
// 不到，看上去就是"另一个 bot @ 我没反应"——而 botmux 已经把本地 signal-file
// 转发删了，不再有兜底。启动时主动校验一下，缺了就向 allowedUsers[0] 私信
// 提示。
//
// 校验通过飞书 "Get application info" API（应用身份）：
//   GET /open-apis/application/v6/applications/{app_id}?lang=zh_cn
// 返回的 data.app.scopes 是个 {scope, description, ...} 数组，遍历找
// scope 字段是否包含目标 key。
//
// 鸡生蛋约束：调这个 API 自身需要 admin:app.info:readonly 或
// application:application:self_manage 中任一权限。后者免审批，是
// 推荐路径——拿不到 app info 时（飞书返回 99991672）我们就主动私信
// admin 提示开通 self_manage，下次重启就能自检。

const REQUIRED_BOT_AT_SCOPE = 'im:message.group_at_msg.include_bot:readonly';
const SELF_MANAGE_SCOPE = 'application:application:self_manage';

function getAdminOpenId(bot: BotState): string | undefined {
  return bot.resolvedAllowedUsers.find(u => u.startsWith('ou_'));
}

async function dmAdmin(larkAppId: string, adminOpenId: string, content: string, contextTag: string): Promise<void> {
  try {
    await sendUserMessage(larkAppId, adminOpenId, content, 'text');
    logger.info(`[${larkAppId}] notified admin ${adminOpenId.substring(0, 12)} about ${contextTag}`);
  } catch (err: any) {
    logger.warn(`[${larkAppId}] failed to DM admin about ${contextTag}: ${err?.message ?? err}`);
  }
}

export async function checkRequiredScopes(larkAppId: string): Promise<void> {
  const bot = getBot(larkAppId);
  try {
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: bot.config.larkAppId, app_secret: bot.config.larkAppSecret }),
    });
    const tokenData = await tokenRes.json() as any;
    if (tokenData.code !== 0) {
      logger.debug(`[${larkAppId}] scope check skipped: tenant_access_token failed (${tokenData.msg})`);
      return;
    }
    const infoRes = await fetch(
      `https://open.feishu.cn/open-apis/application/v6/applications/${bot.config.larkAppId}?lang=zh_cn`,
      { headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` } },
    );
    const infoData = await infoRes.json() as any;

    // 99991672 = 应用身份缺权限。最常见就是 admin:app.info:readonly /
    // application:application:self_manage 都没拿到，导致根本查不到自己的
    // scope 列表。这种"鸡生蛋"情况单独提示：让 admin 开通免审批的
    // self_manage 后下次重启就能自检了。
    if (infoData.code === 99991672) {
      const selfManageAuthUrl = `https://open.feishu.cn/app/${bot.config.larkAppId}/auth?q=${encodeURIComponent(SELF_MANAGE_SCOPE)}&op_from=openapi&token_type=tenant`;
      const targetAuthUrl = `https://open.feishu.cn/app/${bot.config.larkAppId}/auth?q=${encodeURIComponent(REQUIRED_BOT_AT_SCOPE)}&op_from=openapi&token_type=tenant`;
      logger.warn(
        `[${larkAppId}] scope 自检 API 被拒（99991672）：应用缺少 ${SELF_MANAGE_SCOPE}（免审批）。` +
        `开通后下次 daemon 重启即可自动核验跨 bot @ 必需权限 ${REQUIRED_BOT_AT_SCOPE}。申请链接：${selfManageAuthUrl}`,
      );
      const adminOpenId = getAdminOpenId(bot);
      if (!adminOpenId) {
        logger.warn(`[${larkAppId}] 没有 resolved 的 admin open_id，self_manage 提示仅出现在 daemon 日志`);
        return;
      }
      const dm =
        `⚠️ botmux 想自动核验机器人 "${bot.botName ?? larkAppId}" 是否开通了跨 bot @ 必需权限，但发现应用自身缺少一个**免审批**的辅助权限，因此查不到 scope 列表。\n\n` +
        `**操作步骤（点链接 → 申请开通 → 重启 daemon）**：\n` +
        `1. 开通 ${SELF_MANAGE_SCOPE}（免审批，自动通过）：\n   ${selfManageAuthUrl}\n\n` +
        `2. 顺便确认/开通真正的目标权限 ${REQUIRED_BOT_AT_SCOPE}（"获取群组中其他机器人和用户@当前机器人的消息"，免审批，自动通过）：\n   ${targetAuthUrl}\n\n` +
        `3. \`botmux restart\`，启动后 botmux 会自动复核，结果会再次发到这里。\n\n` +
        `**为什么需要**：botmux 多机器人协作（A 机器人 @ B 机器人）依赖目标权限把跨 bot 事件推送过来；不开通则跨 bot @ 完全失效。`;
      await dmAdmin(larkAppId, adminOpenId, dm, 'self_manage scope (auto-approved) missing');
      return;
    }

    if (infoData.code !== 0) {
      logger.debug(`[${larkAppId}] scope check skipped: app info failed (code=${infoData.code} msg=${infoData.msg ?? ''})`);
      return;
    }
    // Lark 文档示例把 scopes 放在 data.app.scopes；为防响应结构变化，
    // 同时兜底 data.scopes / data.application.scopes，取到的第一个非空数组为准。
    const scopesRaw: any[] =
      infoData.data?.app?.scopes
      ?? infoData.data?.application?.scopes
      ?? infoData.data?.scopes
      ?? [];
    if (!Array.isArray(scopesRaw) || scopesRaw.length === 0) {
      logger.debug(`[${larkAppId}] scope check inconclusive: scopes array empty or shape unexpected — skipping`);
      return;
    }
    const grantedScopes = new Set(
      scopesRaw.map(s => typeof s === 'string' ? s : s?.scope).filter(Boolean) as string[],
    );

    // Diff against the canonical list. Critical-missing is the main signal;
    // non-critical is mentioned only when something critical is also missing,
    // so single-bot deployments don't get nagged about `include_bot:readonly`.
    const missingCritical = BOTMUX_REQUIRED_SCOPES.filter(s => s.critical && !grantedScopes.has(s.name));
    const missingOptional = BOTMUX_REQUIRED_SCOPES.filter(s => !s.critical && !grantedScopes.has(s.name));

    if (missingCritical.length === 0) {
      logger.info(`[${larkAppId}] all critical scopes granted (${BOTMUX_REQUIRED_SCOPES.filter(s => s.critical).length} checked)`);
      return;
    }

    // Log + DM consolidated message listing all missing critical scopes.
    const summaryLine = missingCritical.map(s => `${s.name} (${s.desc})`).join('、');
    logger.error(
      `[${larkAppId}] 缺少 ${missingCritical.length} 项必需权限：${summaryLine}。` +
      `botmux 核心功能（消息收发、附件下载、用户名解析等）会受影响。请到飞书开放平台 → 应用 → 权限管理里申请，开通后 \`botmux restart\`。`,
    );
    const adminOpenId = getAdminOpenId(bot);
    if (!adminOpenId) {
      logger.warn(`[${larkAppId}] no resolved admin open_id in allowedUsers; missing-scope warning visible only in daemon log`);
      return;
    }
    const criticalLines = missingCritical.map((s, i) =>
      `${i + 1}. **${s.desc}** (\`${s.name}\`)\n   ${buildScopeDeepLink(bot.config.larkAppId, s.name)}`,
    ).join('\n\n');
    const optionalBlock = missingOptional.length > 0
      ? `\n\n**可选权限（建议一并开通）**：\n${missingOptional.map(s => `- ${s.desc} (\`${s.name}\`): ${buildScopeDeepLink(bot.config.larkAppId, s.name)}`).join('\n')}`
      : '';
    const dm =
      `⚠️ botmux 启动检查发现机器人 "${bot.botName ?? larkAppId}" 缺少 ${missingCritical.length} 项必需权限\n\n` +
      `**操作步骤（点链接 → 申请开通 → 重启 daemon）**：\n\n` +
      `${criticalLines}\n\n` +
      `开通完成后执行 \`botmux restart\`，botmux 会再次自检并把结果发到这里。${optionalBlock}`;
    await dmAdmin(larkAppId, adminOpenId, dm, `missing scopes: ${missingCritical.map(s => s.name).join(',')}`);
  } catch (err: any) {
    logger.debug(`[${larkAppId}] scope check errored: ${err?.message ?? err}`);
  }
}

// ─── Group chat stats cache ───────────────────────────────────────────────
//
// chat.get returns both user_count (real users only) and bot_count (bots).
// One API call, one cache — used to gate auto-replies in multi-bot/multi-user
// groups (oncall chats often have 3rd-party oncall/form/AI-search bots).

export const CHAT_CACHE_TTL = 5 * 60_000; // 5 minutes
const chatStatsCache = new Map<string, { userCount: number; botCount: number; fetchedAt: number }>();

export async function getGroupStats(larkAppId: string, chatId: string): Promise<{ userCount: number; botCount: number }> {
  const cacheKey = `${larkAppId}:${chatId}`;
  const cached = chatStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CHAT_CACHE_TTL) {
    return { userCount: cached.userCount, botCount: cached.botCount };
  }
  try {
    const info = await getChatInfo(larkAppId, chatId);
    chatStatsCache.set(cacheKey, { userCount: info.userCount, botCount: info.botCount, fetchedAt: Date.now() });
    return info;
  } catch (err) {
    // Soft failure — the fallback below assumes worst case (multi-user,
    // multi-bot → require @mention). No user-visible regression, so debug.
    logger.debug(`Failed to get chat stats for ${chatId}, using safe fallback: ${err}`);
    if (cached) return { userCount: cached.userCount, botCount: cached.botCount };
    // Fallback: assume multi-person, multi-bot → require @mention to be safe.
    return { userCount: 999, botCount: 999 };
  }
}

// ─── Cross-bot open_id mapping ──────────────────────────────────────────
//
// Lark open_id is per-app scoped: Bot A sees a different open_id for Bot B
// than Bot B sees for itself. The self-reported botOpenId (from /bot/v3/info)
// is useless for other bots to @mention.
//
// We build a per-bot cross-reference from event data: when Bot A's event
// handler receives a message that @mentions Bot B, the mention includes
// Bot B's open_id as seen by Bot A's app. We persist this mapping so that
// listChatBotMembers can return correct open_ids.

/** Read the per-bot cross-reference: botName(lowercase) → openId as seen by larkAppId's app */
export function readBotOpenIdCrossRef(dataDir: string, larkAppId: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const fp = join(dataDir, `bot-openids-${larkAppId}.json`);
    if (existsSync(fp)) {
      const data: Record<string, string> = JSON.parse(readFileSync(fp, 'utf-8'));
      for (const [name, openId] of Object.entries(data)) {
        map.set(name.toLowerCase(), openId);
      }
    }
  } catch { /* ignore */ }
  return map;
}

/** Is `senderOpenId` a registered botmux peer (from larkAppId's cross-ref)?
 *  Used to gate chat-scope foreign-bot @mention spawning to vetted peers. */
export function isKnownPeerBot(dataDir: string, larkAppId: string, senderOpenId: string | undefined): boolean {
  if (!senderOpenId) return false;
  for (const openId of readBotOpenIdCrossRef(dataDir, larkAppId).values()) {
    if (openId === senderOpenId) return true;
  }
  return false;
}

/** Update the per-bot cross-reference from @mention data in an event.
 *  mentionsList comes from Lark event message.mentions array. */
export function updateBotOpenIdCrossRef(
  dataDir: string,
  larkAppId: string,
  mentionsList: Array<{ name?: string; id?: { open_id?: string } }>,
): void {
  if (!mentionsList || mentionsList.length === 0) return;

  // Read known bot names from bots-info.json
  const knownBotNames = new Set<string>();
  try {
    const infoPath = join(dataDir, 'bots-info.json');
    if (existsSync(infoPath)) {
      const entries: Array<{ botName: string | null }> = JSON.parse(readFileSync(infoPath, 'utf-8'));
      for (const e of entries) {
        if (e.botName) knownBotNames.add(e.botName.toLowerCase());
      }
    }
  } catch { /* ignore */ }
  if (knownBotNames.size === 0) return;

  // Read existing cross-reference
  const fp = join(dataDir, `bot-openids-${larkAppId}.json`);
  let existing: Record<string, string> = {};
  try {
    if (existsSync(fp)) existing = JSON.parse(readFileSync(fp, 'utf-8'));
  } catch { /* ignore */ }

  // Update with new mentions that match known bot names
  let changed = false;
  for (const m of mentionsList) {
    const name = m.name;
    const openId = m.id?.open_id;
    if (!name || !openId) continue;
    if (!knownBotNames.has(name.toLowerCase())) continue;
    if (existing[name] === openId) continue;
    existing[name] = openId;
    changed = true;
  }

  if (changed) {
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(fp, JSON.stringify(existing, null, 2) + '\n');
      logger.debug(`Updated bot open_id cross-ref for ${larkAppId}: ${JSON.stringify(existing)}`);
    } catch (err) {
      logger.debug(`Failed to write bot open_id cross-ref: ${err}`);
    }
  }
}

// ─── /introduce collaboration handshake ──────────────────────────────────
//
// 用户在群里发 `@A @B /introduce`（顺序任意，带不带额外文本都行），每个被
// @ 的 bot 的 daemon 都会收到一份相同的 mentions[]，里面自带每个被 @ 实体
// 的 (open_id, name)。我们把这些登记进按 chatId 分文件的 observed-bots-store，
// 后续 `botmux bots list` / `<available_bots>` 就能感知到非本机 daemon 启动
// 的协作 bot，并能 @ 回去。
//
// 飞书没有任何公开接口能列出群里 bot 的 open_id（chat-members/get 明文跳过
// bot 成员），这是当前条件下能拿到陌生 bot open_id 的唯一可靠路径。

/** Command-position match: after stripping leading @mentions, the remaining
 *  text must begin with `/introduce` (optionally followed by whitespace).
 *  This is the same approach `parseForceTopicInvocation` takes for /t /topic.
 *  Stricter than a bare token match — "please run /introduce" or similar
 *  quoted/explanatory text won't trigger. */
const INTRODUCE_RE = /^\/introduce(?:\s|$)/i;

/**
 * If `message` is a /introduce command, side-effect it (record observed bots
 * + send ack) and return `true` so the caller skips normal CLI routing.
 *
 * Consumed without side effects (still returns true) when:
 * - sender is not in allowedUsers — silent drop, do not surface "无操作权限"
 * - mentions[] minus self is empty — nothing to learn, ignore quietly
 *
 * Writes ALL mentions including self to the store. Each receiving bot's
 * daemon owns its own per-observer file (see observed-bots-store), so the
 * self entry is the only authoritative record of this app's own open_id
 * in the per-observer view — useful for `botmux bots list` self-identification.
 */
export async function tryHandleIntroduceCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
  isAllowed: boolean,
): Promise<boolean> {
  const text = extractMessageTextForRouting(message);
  if (!text) return false;
  // Strip leading @<mention> tokens (using the message's mentions list to
  // tolerate names with spaces) before checking the command position.
  const stripped = stripLeadingMentions(text.trim(), message?.mentions ?? []);
  if (!INTRODUCE_RE.test(stripped)) return false;

  if (!isAllowed) {
    logger.debug(`[${larkAppId}] /introduce from non-allowed user ${senderOpenId} — silent drop`);
    return true;
  }

  const selfOpenId = getBot(larkAppId).botOpenId;
  const rawMentions: Array<{ name?: string; id?: { open_id?: string } }> = message.mentions ?? [];
  const all = rawMentions
    .map(m => ({ openId: m.id?.open_id ?? '', name: m.name ?? '' }))
    .filter(m => m.openId && m.name);
  const hasExternal = all.some(m => m.openId !== selfOpenId);
  if (!hasExternal) {
    logger.debug(`[${larkAppId}] /introduce ignored: no external bot in mentions`);
    return true;
  }

  const chatId = message.chat_id as string;
  try {
    // Persist to the observer-scoped store: these open_ids are scoped to the
    // receiving app (larkAppId), so they're correct for THIS daemon to use
    // when @-mentioning back.
    recordObservedBots(config.session.dataDir, larkAppId, chatId, all, 'introduce');
  } catch (err) {
    logger.warn(`[${larkAppId}] /introduce: failed to persist observed bots: ${err}`);
  }

  const items = all.map(m => `@${m.name}`).join(' ');
  const ackText = `✅ 已认识本群 ${all.length} 个伙伴：${items}`;
  try {
    await replyMessage(larkAppId, message.message_id, ackText);
  } catch (err) {
    logger.warn(`[${larkAppId}] /introduce ack failed: ${err}`);
  }
  return true;
}

// ─── @mention detection ──────────────────────────────────────────────────

/** Check if the bot was @mentioned in this message */
export function isBotMentioned(larkAppId: string, message: any, _senderOpenId: string | undefined): boolean {
  const botOpenId = getBot(larkAppId).botOpenId;
  if (!botOpenId) {
    // Startup race: events can arrive before probeBotOpenId() resolves the
    // per-bot open_id. Subsequent events succeed once the probe completes,
    // so this is not a real warning — drop to debug to keep error.log clean.
    logger.debug(`[${larkAppId}] Bot open_id not yet known, skipping @mention check`);
    return false;
  }

  // 1. Check message.mentions array (populated for user-sent text messages)
  const mentions: any[] = message.mentions ?? [];
  if (mentions.some((m: any) => m.id?.open_id === botOpenId)) {
    return true;
  }

  // 2. Check post content for inline at tags (bot-sent post messages may not
  //    populate message.mentions — the @mention is embedded in the content structure)
  try {
    const content = JSON.parse(message.content ?? '{}');
    const inner = content.zh_cn ?? content.en_us ?? content;
    if (Array.isArray(inner?.content)) {
      for (const paragraph of inner.content) {
        if (!Array.isArray(paragraph)) continue;
        for (const node of paragraph) {
          if (node.tag === 'at' && node.user_id === botOpenId) return true;
        }
      }
    }
  } catch { /* ignore parse errors */ }

  return false;
}

// ─── Permission gates ────────────────────────────────────────────────────
//
// Two gates:
//   canTalk    — may address the bot in this chat (prompts, thread replies)
//   canOperate — may trigger state-changing actions (card buttons, daemon
//                slash commands like /cd /restart /close /oncall)
//
// Non-oncall chats: both fall back to the bot's allowedUsers.
// Oncall-bound chats: talking is open to everyone in the group; operating
// still requires allowedUsers (single source of truth — no per-chat owners).
//
// Oncall is a chat-level concept: `isChatOncallBoundForAnyBot` returns true
// when ANY bot (this one or a sibling in another daemon) has the chat bound,
// so an unbound sibling doesn't fall back to allowedUsers and reply
// "⚠️ 无操作权限" when @-mentioned in a shared oncall workspace.

/** per-chat per-user 授权命中判断（仅用于 canTalk —— 不给管理命令权）。 */
function hasChatGrant(larkAppId: string, chatId: string | undefined, openId: string | undefined): boolean {
  return !!chatId && !!openId && !!getBot(larkAppId).config.chatGrants?.[chatId]?.includes(openId);
}

export function canTalk(larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined): boolean {
  if (chatId && isChatOncallBoundForAnyBot(chatId)) return true;
  if (isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)) return true;
  if (hasChatGrant(larkAppId, chatId, senderOpenId)) return true;
  const allowedUsers = getBot(larkAppId).resolvedAllowedUsers;
  if (allowedUsers.length === 0) return true;
  return !!senderOpenId && allowedUsers.includes(senderOpenId);
}

export function canOperate(larkAppId: string, _chatId: string | undefined, senderOpenId: string | undefined): boolean {
  const allowedUsers = getBot(larkAppId).resolvedAllowedUsers;
  if (allowedUsers.length === 0) return true;
  return !!senderOpenId && allowedUsers.includes(senderOpenId);
}

/**
 * 入口 A：无权限者 @bot 时弹授权申请卡（正文 @owner，由 owner 处置）。
 * 受 grant-pending 节流：pending 中 / deny 冷却期内静默不发。开放模式（无 owner）兜底不发。
 */
async function maybeSendGrantRequestCard(
  larkAppId: string, message: any, chatId: string, requesterOpenId: string | undefined,
): Promise<void> {
  const owner = getOwnerOpenId(larkAppId);
  if (!owner || !requesterOpenId) return;
  if (isThrottled(larkAppId, chatId, requesterOpenId)) return;
  const name = (message?.mentions ?? []).find((m: any) => m?.id?.open_id === requesterOpenId)?.name
    ?? requesterOpenId;
  const nonce = openPending(larkAppId, chatId, requesterOpenId);
  const card = buildGrantCard(
    { ownerOpenId: owner, requesterOpenId, requesterName: String(name), chatId, nonce, mode: 'request' },
    localeForBot(larkAppId),
  );
  await replyMessage(larkAppId, message.message_id, card, 'interactive')
    .catch(err => logger.debug(`grant request card send failed: ${err}`));
}

// ─── Group message access check ──────────────────────────────────────────

/**
 * Check group message addressing:
 * - 'allowed'     -> sender is allowed, bot was @mentioned or solo group
 * - 'not_allowed' -> bot was @mentioned but sender is not in allowlist
 * - 'ignore'      -> not addressed to bot at all
 */
export async function checkGroupMessageAccess(
  larkAppId: string, message: any, chatId: string, senderOpenId: string | undefined,
): Promise<'allowed' | 'not_allowed' | 'ignore'> {
  const mentioned = isBotMentioned(larkAppId, message, senderOpenId);
  const isAllowed = canTalk(larkAppId, chatId, senderOpenId);

  logger.debug(`Check group message access: mentioned=${mentioned}, isAllowed=${isAllowed}`);
  if (mentioned) {
    return isAllowed ? 'allowed' : 'not_allowed';
  }

  // No @mention — only allow if sender is the sole human in the group
  // AND this is the only bot in the chat. With multiple bots, require @mention
  // to disambiguate.
  if (isAllowed) {
    const { userCount, botCount } = await getGroupStats(larkAppId, chatId);
    logger.debug(`Group user count: ${userCount}, bot count: ${botCount}`);
    if (userCount <= 1 && botCount <= 1) {
      return 'allowed';
    }
  }

  return 'ignore';
}

// ─── Event callbacks ─────────────────────────────────────────────────────

/** Routing context computed from the incoming message — describes the
 *  conversational unit (`scope`) and the addressing key (`anchor`) used
 *  throughout the rest of the system. The dispatcher computes this once
 *  per message and hands it to the daemon's session handlers, so the
 *  daemon never has to re-derive it. */
export interface RoutingContext {
  chatId: string;
  /** message_id of the inbound message that triggered this routing. */
  messageId: string;
  chatType: 'group' | 'p2p';
  /** 'thread' → reply_in_thread to a (real or freshly seeded) thread root.
   *  'chat'   → plain message to the chat (no threading). */
  scope: 'thread' | 'chat';
  /** Routing key. `chatId` for chat-scope, the thread root id for
   *  thread-scope (an existing rootMessageId, or this messageId when
   *  it's the seed of a brand-new thread). */
  anchor: string;
  larkAppId: string;
}

export interface EventHandlers {
  handleCardAction: (data: any, larkAppId: string) => Promise<any>;
  handleNewTopic: (data: any, ctx: RoutingContext) => Promise<void>;
  handleThreadReply: (data: any, ctx: RoutingContext) => Promise<void>;
  /** Check if this bot owns an active session anchored at the given id
   *  (rootMessageId for thread-scope, chatId for chat-scope). */
  isSessionOwner?: (anchor: string, larkAppId: string) => boolean;
  /** Fired when the dispatcher detects that a chat with a live chat-scope
   *  session has been converted to topic mode (chat_mode 'group' → 'topic'
   *  via Lark group settings). Daemon should evict the stale chat-scope
   *  session from its activeSessions map so future routing doesn't hit it
   *  and so scheduler/dashboard sends stop going through sendMessage(chatId)
   *  — which in a 话题群 wraps each top-level message in a fresh topic.
   *  Best-effort fire-and-forget; the dispatcher proceeds either way. */
  onChatModeConverted?: (chatId: string, larkAppId: string) => void;
}

/**
 * Best-effort plain-text extraction from a Lark message for routing-level
 * decisions (currently: `/t` / `/topic` detection). Handles the two common
 * shapes — `text` (`{"text": "..."}`) and `post` (zh_cn/en_us nested
 * paragraphs of `text` / `at` nodes). Other types (image, file, sticker,
 * interactive, …) return null so the caller falls through to the default
 * routing path.
 *
 * Kept deliberately tiny rather than reusing parseEventMessage: the dispatcher
 * runs on every inbound event and we only need a quick text peek before the
 * permission gates / scope override; full parseEventMessage still runs once
 * inside the chosen handler.
 */
export function extractMessageTextForRouting(message: any): string | null {
  if (!message?.content) return null;
  try {
    const obj = JSON.parse(message.content);
    // text shape: {"text":"..."}. Lark stuffs placeholder keys like "@_user_1"
    // into obj.text; the human name only lives in message.mentions[].name. We
    // must resolve keys → @${name} so stripLeadingMentions can strip them
    // before parseForceTopicInvocation sees the content. Mirrors the
    // resolveMentions logic in parseEventMessage.
    if (typeof obj?.text === 'string') {
      let text: string = obj.text;
      const mentions = message?.mentions;
      if (Array.isArray(mentions)) {
        for (const m of mentions) {
          if (m?.key && m?.name) {
            text = text.split(m.key).join(`@${m.name}`);
          }
        }
      }
      return text;
    }
    // post shape: {"zh_cn":{"content":[[{tag:"text",text:"..."},{tag:"at",...}]]}}
    // Post messages keep @mentions as separate `at` nodes (not embedded in
    // text), so the joined text-node content is already clean of placeholders.
    const inner = obj?.zh_cn ?? obj?.en_us ?? obj;
    if (Array.isArray(inner?.content)) {
      const parts: string[] = [];
      for (const para of inner.content) {
        if (!Array.isArray(para)) continue;
        for (const node of para) {
          if (node?.tag === 'text' && typeof node.text === 'string') {
            parts.push(node.text);
          }
        }
      }
      return parts.length > 0 ? parts.join('') : null;
    }
  } catch { /* malformed content — skip */ }
  return null;
}

/**
 * If the inbound message starts with `/t` / `/topic` AND the routing
 * currently lands on chat-scope, override to thread-scope anchored at
 * the inbound message_id. This makes "force topic mode" work even when
 * the bot already owns a chat-scope session in the chat — the dispatcher
 * routes to handleNewTopic at a fresh anchor instead of falling into
 * handleThreadReply on the chat-scope owner.
 *
 * Already-thread messages (real Lark 话题, p2p, 话题群) are left alone:
 * the prefix is still stripped downstream by handleNewTopic.
 */
export function maybeApplyForceTopicOverride(
  routing: { scope: 'thread' | 'chat'; anchor: string },
  message: any,
  messageId: string,
): boolean {
  if (routing.scope !== 'chat') return false;
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const stripped = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  if (!parseForceTopicInvocation(stripped)) return false;
  routing.scope = 'thread';
  routing.anchor = messageId;
  return true;
}

/** Compute the scope + anchor for an inbound message:
 *   - root_id + thread_id     → thread-scope, anchor = root_id (real Lark 话题)
 *   - 话题群 + no real thread → thread-scope, anchor = message_id (thread seed)
 *   - p2p + no real thread    → thread-scope, anchor = message_id (each DM
 *                               top-level message starts a fresh topic; a
 *                               reply inside an existing thread carries
 *                               root_id+thread_id and threads into its session)
 *   - 普通群 + no real thread  → chat-scope, anchor = chat_id (entire group
 *                               is one session)
 *
 *  Why we gate on thread_id (not root_id alone): Lark 客户端的引用气泡 / 快速
 *  回复 UI 有时会给"用户视角的顶层消息"塞 root_id 但**不会**塞 thread_id。
 *  飞书官方文档：root_id/parent_id "仅在回复消息场景会有返回值"；thread_id
 *  "不返回说明该消息非话题消息"。所以 thread_id 才是"是否真的处于话题里"的
 *  权威信号。只看 root_id 会把 quote-bubble 错认为话题回复，把用户从 chat-scope
 *  会话里拽走、又起一个孤立的 thread session。
 *  Exported for unit tests. */
export async function decideRouting(
  larkAppId: string,
  message: any,
): Promise<{ scope: 'thread' | 'chat'; anchor: string }> {
  const rootId: string | undefined = message.root_id;
  const threadId: string | undefined = message.thread_id;
  if (rootId && threadId) return { scope: 'thread', anchor: rootId };

  const chatType: string = message.chat_type ?? 'group';
  const messageId: string = message.message_id;
  const chatId: string = message.chat_id;

  // 私聊：每条 top-level DM 都视为新话题 — 跟话题群同款，匹配 Lark DM 的话题
  // 化默认行为，避免无限把 1:1 对话塞进同一个 CLI 进程里。
  if (chatType === 'p2p') {
    return { scope: 'thread', anchor: messageId };
  }

  // Group chat — fetch chat_mode (cached) to disambiguate 话题群 from 普通群.
  const mode = await getChatMode(larkAppId, chatId);
  if (mode === 'topic') {
    return { scope: 'thread', anchor: messageId };
  }
  return { scope: 'chat', anchor: chatId };
}

/**
 * Create and start the Lark WSClient with event dispatching.
 * Returns the WSClient instance for lifecycle management.
 */
export function startLarkEventDispatcher(larkAppId: string, larkAppSecret: string, handlers: EventHandlers): Lark.WSClient {
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data: any) => {
      try {
        const result = await handlers.handleCardAction(data, larkAppId);
        // The handler may return:
        //   - an already-shaped Lark response ({toast} and/or {card}) → pass through
        //     so toasts (e.g. "仅 owner 可操作") and explicit card payloads render;
        //   - a raw card body (e.g. toggle_stream) → wrap as an in-place card patch
        //     so Lark updates the clicked card without waiting for an API PATCH.
        if (result && (result.toast || result.card)) return result;
        if (result) return { card: { type: 'raw', data: result } };
      } catch (err) {
        logger.error(`Error handling card action: ${err}`);
      }
      return undefined;
    },
    'im.message.receive_v1': async (data: any) => {
      try {
        const message = data.message;
        const sender = data.sender;
        if (!message) return;

        // Learn other bots' open_ids from @mentions in this event.
        // Lark open_id is per-app: these IDs are correct for our app context.
        if (message.mentions?.length > 0) {
          updateBotOpenIdCrossRef(config.session.dataDir, larkAppId, message.mentions);
        }

        const chatId = message.chat_id;
        const chatType = (message.chat_type === 'p2p' ? 'p2p' : 'group') as 'group' | 'p2p';
        const messageId = message.message_id;

        // Bot-originated messages — bots historically only post inside threads
        // (their own thread replies). With chat-scope sessions a bot can also
        // post top-level (its first reply in a chat-scope group), so we still
        // route them through `decideRouting` rather than gating on root_id.
        //
        // 飞书在跨 bot 卡片消息场景实测会把发送方标成 sender_type='bot'（不是
        // 文档里写的 'app'），所以这里两个值都接受，否则那条路径会落到下面的
        // user-message 通用分支，绕开 /close self-message 特判、foreign-bot
        // chat-scope gate（isKnownPeerBot）和"Bot-to-bot @mention detected"
        // 日志。
        const senderType = sender?.sender_type;
        const isBotSenderType = senderType === 'app' || senderType === 'bot';
        if (isBotSenderType) {
          const senderOpenId = sender.sender_id?.open_id;
          const isSelfMessage = senderOpenId === getBot(larkAppId).botOpenId;
          // Self messages: only echoed `/close` commands matter.
          if (isSelfMessage) {
            try {
              const body = JSON.parse(message.content ?? '{}');
              if (body.text?.trim() !== '/close') return;
            } catch {
              return;
            }
            const ctx = await decideRouting(larkAppId, message);
            handlers.handleThreadReply(data, { ...ctx, chatId, messageId, chatType, larkAppId })
              .catch(err => logger.error(`Error handling message event: ${err}`));
            return;
          }
          // Foreign bot: only route on @mention of us.
          if (!isBotMentioned(larkAppId, message, undefined)) return;
          const ctx = await decideRouting(larkAppId, message);
          // Chat-scope foreign-bot @mention without an existing session: gate to
          // vetted botmux peers (registered in our bot-openids cross-ref). This
          // keeps random Lark bots from silently spawning chat-scope sessions
          // in 普通群/p2p, while letting Bot A → Bot B handoffs in 普通群 work
          // (handleThreadReply auto-create + chat-scope inheritance below).
          //
          // 注意 isKnownPeerBot 查的是 cross-ref（bot-openids-<appId>.json），它只
          // 收录 bots-info.json 里有名字的 bot，即本机 daemon 自己配置的 bot
          // （getAllBots）。"别人的 bot" 永远进不了这个 cross-ref，所以 isKnownPeerBot
          // 对外部 bot 恒为 false——这跟 /introduce 是两套独立存储：/introduce 写的是
          // observed-bots-store，只负责让发送方"发现并能 @ 到"对方，过不了这道接收闸。
          //
          // Oncall 群是显式部署的协作工作区，canTalk 已对任何成员（含真人）放行；这里
          // 对 bot 同等放行，跳过 cross-ref vetting。否则 oncall 群里外部 bot 互相 @
          // 会被静默丢弃、只有真人能拉起会话，与 oncall「全员可对话」语义不符。
          if (ctx.scope === 'chat' && !isChatOncallBoundForAnyBot(chatId)) {
            const ownsSession = handlers.isSessionOwner?.(ctx.anchor, larkAppId) ?? false;
            if (!ownsSession && !isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)) {
              return;
            }
          }
          logger.info(`Bot-to-bot @mention detected (scope=${ctx.scope}): routing to handleThreadReply`);
          handlers.handleThreadReply(data, { ...ctx, chatId, messageId, chatType, larkAppId })
            .catch(err => logger.error(`Error handling bot @mention: ${err}`));
          return;
        }

        const senderOpenId = sender?.sender_id?.open_id as string | undefined;
        const isAllowed = canTalk(larkAppId, chatId, senderOpenId);

        // /introduce — collaboration handshake. Intercept before any routing
        // so the command never reaches a CLI session (each @ed bot's daemon
        // independently records the mentions[] open_ids + names).
        if (await tryHandleIntroduceCommand(larkAppId, message, senderOpenId, isAllowed)) {
          return;
        }

        // /grant、/revoke — 群内授权元命令。在路由/spawn 之前拦截（仅 owner，需明确 @ 本 bot），
        // 否则会被当成 prompt 喂给 CLI 会话。
        if (await tryHandleGrantCommand(larkAppId, message, senderOpenId)) {
          return;
        }

        logger.debug('Received message:', message);

        // Diagnostic: record the Lark quote-bubble UI quirk where root_id
        // appears without thread_id. decideRouting now treats this as
        // "no thread" (chat-scope / topic / new-topic depending on context),
        // which is the authoritative behavior. Logging it here so we can spot
        // any future surprise in the wild.
        if (message.root_id && !message.thread_id) {
          logger.info(
            `[routing] root_id w/o thread_id (Lark UI quirk, treating as top-level): ` +
            `msg=${messageId.substring(0, 12)} chat=${chatId.substring(0, 12)} ` +
            `type=${chatType} root=${String(message.root_id).substring(0, 12)} ` +
            `parent=${String(message.parent_id ?? '').substring(0, 12)}`,
          );
        }

        const routing = await decideRouting(larkAppId, message);

        // 话题群 → 普通群 (reverse conversion). Symmetric to the forward check
        // below: when decideRouting lands on thread-scope purely because the
        // *cached* chat_mode said 'topic' (no real thread_id on the message
        // either — i.e. this would seed a brand-new thread), our 5-min cache
        // may be stale from before a flip-back to 普通群. Re-verify with
        // forceRefresh; if Lark now reports 'group', flatten to chat-scope so
        // the bot doesn't keep wrapping every top-level reply in a fresh
        // Lark topic via reply_in_thread.
        //
        // Skip when there's a real thread_id (authoritative thread signal,
        // can't be cache-stale) or when chatType is p2p (DMs always thread).
        // Runs BEFORE /t override so a `@bot /t …` in a now-flat 普通群 still
        // gets the explicit topic seed it asked for.
        if (
          routing.scope === 'thread' &&
          routing.anchor === messageId &&
          !message.thread_id &&
          chatType === 'group'
        ) {
          const freshMode = await getChatMode(larkAppId, chatId, { forceRefresh: true });
          if (freshMode === 'group') {
            logger.info(
              `[chat-mode-converted] ${chatId.substring(0, 12)} chat_mode flipped 'topic' → 'group'; ` +
              `rerouting msg=${messageId.substring(0, 12)} as chat-scope`,
            );
            routing.scope = 'chat';
            routing.anchor = chatId;
          }
        }

        // /t / /topic in 普通群: flip routing to thread-scope so the bot's
        // first reply seeds a fresh Lark thread, even if a chat-scope session
        // is currently active in this chat.
        if (maybeApplyForceTopicOverride(routing, message, messageId)) {
          logger.info(`[/t] Force-topic override: msg=${messageId.substring(0, 12)} → thread-scope, anchor=msg`);
        }

        let ownsSession = handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false;

        // 普通群 → 话题群 conversion detection. Lark group admins can flip
        // chat_mode at any time; our 30/5-min cache lags. If routing landed on
        // chat-scope AND we own a session at this chat, the chat-scope session
        // may be stale from before a conversion. Re-fetch chat_mode with
        // forceRefresh to confirm. If it's now 'topic', the session is dead:
        // sendMessage(chatId) at dispatch time would wrap each reply in a new
        // Lark topic (the user-reported bug). Evict the stale session, then
        // route this message as if it were a brand-new thread seed so
        // handleNewTopic spawns a thread-scope session anchored at messageId.
        // Gate on ownsSession to avoid an API roundtrip on every fresh inbound.
        if (routing.scope === 'chat' && ownsSession) {
          const freshMode = await getChatMode(larkAppId, chatId, { forceRefresh: true });
          if (freshMode === 'topic') {
            logger.info(
              `[chat-mode-converted] ${chatId.substring(0, 12)} chat_mode flipped 'group' → 'topic'; ` +
              `evicting stale chat-scope session and rerouting msg=${messageId.substring(0, 12)} as thread seed`,
            );
            try { handlers.onChatModeConverted?.(chatId, larkAppId); } catch (err) {
              logger.warn(`onChatModeConverted handler threw: ${err}`);
            }
            routing.scope = 'thread';
            routing.anchor = messageId;
            // ownsSession was true on the stale chatId anchor; the new anchor
            // (messageId) is brand-new, so no current session owns it.
            ownsSession = false;
          }
        }

        // Permission gating — same shape as before, just keyed on
        // `ownsSession` (anchor-aware) instead of "rootId presence":
        //
        //   ownsSession + 1v1 group → relax (no @mention required)
        //   ownsSession + multi     → require @mention
        //   !ownsSession (group)    → require @mention + allowlist
        //   p2p                     → allowlist only
        if (chatType === 'group') {
          let stats: { userCount: number; botCount: number } | null = null;
          if (ownsSession) stats = await getGroupStats(larkAppId, chatId);
          const relax = ownsSession && isAllowed && !!stats && stats.userCount <= 1 && stats.botCount <= 1;
          if (!relax) {
            const access = await checkGroupMessageAccess(larkAppId, message, chatId, senderOpenId);
            if (access === 'not_allowed') {
              // 入口 A：无权限者 @bot → 弹授权申请卡（@owner），代替「无操作权限」。
              // 覆盖 ownsSession 真假两种情况，但绝不把该消息喂进已有 session。
              await maybeSendGrantRequestCard(larkAppId, message, chatId, senderOpenId);
              logger.debug(`Ignoring group message from non-allowed user: ${senderOpenId} (grant request card path)`);
              return;
            }
            if (access === 'ignore') {
              logger.debug(`Ignoring group message not addressed to bot: ${messageId}`);
              return;
            }
          }
        } else if (!isAllowed) {
          logger.debug(`Ignoring p2p message from non-allowed user: ${senderOpenId}`);
          return;
        }

        const ctx: RoutingContext = { chatId, messageId, chatType, larkAppId, ...routing };
        const promise = ownsSession
          ? handlers.handleThreadReply(data, ctx)
          : handlers.handleNewTopic(data, ctx);
        promise.catch(err => logger.error(`Error handling message event: ${err}`));
      } catch (err) {
        logger.error(`Error handling message event: ${err}`);
      }
    },
  });

  // Start WSClient
  const wsClient = new Lark.WSClient({
    appId: larkAppId,
    appSecret: larkAppSecret,
    // Default to warn — the SDK is chatty at info ("client ready", reconnect
    // heartbeats, etc.) and floods pm2 error.log when stderr is the only sink.
    // DEBUG=1 widens the level back to info for troubleshooting.
    loggerLevel: process.env.DEBUG ? Lark.LoggerLevel.info : Lark.LoggerLevel.warn,
  });

  wsClient.start({ eventDispatcher });
  logger.info('Daemon WSClient started');

  return wsClient;
}
