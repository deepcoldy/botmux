/**
 * Lark event dispatcher — handles WSClient setup, bot identity probing,
 * and message routing (group access checks, @mention detection).
 * Extracted from daemon.ts for modularity.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { join } from 'node:path';
import { getBot, getAllBots, findOncallChat, getOwnerOpenId, type BotState } from '../../bot-registry.js';
import { config } from '../../config.js';
import { getChatInfo, getChatMode, getCachedChatMode, listChatBotMembers, replyMessage, sendUserMessage, isHumanOpenId, updateMessage } from './client.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/bounded-map.js';
import { serializeByAnchor } from '../../utils/anchor-serializer.js';
import { parseForceTopicInvocation } from '../../core/command-handler.js';
import { shouldAutoStartOnNewTopic } from '../../core/auto-start.js';
import { stripLeadingMentions } from './message-parser.js';
import { recordObservedBots } from '../../services/observed-bots-store.js';
import { getDocSubscription, listAllDocSubscriptions, type DocSubscription } from '../../services/doc-subs-store.js';
import { getDocComment, isBotAuthoredReply, hasBotSentinel } from './doc-comment.js';
import { BOTMUX_REQUIRED_SCOPES, DOC_FEATURE_SCOPES, DOC_COMMENT_EVENT, buildScopeDeepLink } from '../../setup/verify-permissions.js';
import { type Brand, larkHosts, normalizeBrand, sdkDomain } from './lark-hosts.js';
import { tryHandleGrantCommand } from './grant-command.js';
import { tryHandleReplyModeCommand } from './reply-mode-command.js';
import { buildGrantCard } from './card-builder.js';
import { openPending, isThrottled } from './grant-pending.js';
import { localeForBot, t } from '../../i18n/index.js';
import { chatQuotaKey, globalQuotaKey } from '../../services/grant-store.js';
import { ensureDefaultOncallBound } from '../../services/oncall-store.js';
import { resolveRegularGroupMode, resolveGroupMentionMode } from '../../services/chat-reply-mode-store.js';

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
  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; botAvatarUrl: string | null; cliId: string };
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
      botAvatarUrl: b.botAvatarUrl ?? null,
      cliId: b.config.cliId,
    });
  }

  // 原子写：一 bot 一 daemon，多个 daemon 进程并发 upsert 同一个 bots-info.json，
  // 裸写会让并发读者看到半截 JSON。（read-merge-write 的 lost-update 仍存在，
  // 但每个 daemon 周期性重写自己的条目，可自愈。）
  atomicWriteFileSync(filePath, JSON.stringify([...map.values()], null, 2) + '\n');
}

/**
 * Probe the bot's own open_id at startup via the Lark bot info API.
 */
/** Per-app in-flight open_id probe, so a startup burst of events shares one probe. */
const inflightOpenIdProbes = new Map<string, Promise<void>>();

/**
 * Ensure the bot's own open_id is resolved before @-detection. `probeBotOpenId`
 * is fired fire-and-forget at daemon startup, so events can arrive while
 * `botOpenId` is still undefined — `isBotMentioned` then can't recognize an @ as
 * ours and silently drops it. The WSClient still ACKs that dropped event, so
 * Lark never redelivers it (the @ is lost until manually re-sent). Awaiting the
 * deduped probe here closes that window: concurrent events share one probe, and
 * each is held only until the open_id lands, then processed normally.
 */
export function ensureBotOpenId(larkAppId: string): Promise<void> {
  if (getBot(larkAppId).botOpenId) return Promise.resolve();
  let inflight = inflightOpenIdProbes.get(larkAppId);
  if (!inflight) {
    inflight = probeBotOpenId(larkAppId).finally(() => inflightOpenIdProbes.delete(larkAppId));
    inflightOpenIdProbes.set(larkAppId, inflight);
  }
  return inflight;
}

export async function probeBotOpenId(larkAppId: string): Promise<void> {
  const bot = getBot(larkAppId);
  if (bot.botOpenId) return; // already known

  const openApi = larkHosts(normalizeBrand(bot.config.brand)).openApi;

  // Call /bot/v3/info to get the bot's open_id using tenant_access_token
  const tokenRes = await fetch(`${openApi}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: bot.config.larkAppId, app_secret: bot.config.larkAppSecret }),
  });
  const tokenData = await tokenRes.json() as any;
  if (tokenData.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${tokenData.msg}`);
  }

  const botRes = await fetch(`${openApi}/open-apis/bot/v3/info/`, {
    headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
  });
  const botData = await botRes.json() as any;
  if (botData.code !== 0) {
    throw new Error(`Failed to get bot info: ${botData.msg}`);
  }

  const openId = botData.bot?.open_id;
  const appName = botData.bot?.app_name;
  const avatarUrl = botData.bot?.avatar_url;
  if (openId) {
    bot.botOpenId = openId;
    if (appName) bot.botName = appName;
    if (avatarUrl) bot.botAvatarUrl = avatarUrl;
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
  const brand = normalizeBrand(bot.config.brand);
  const openApi = larkHosts(brand).openApi;
  try {
    const tokenRes = await fetch(`${openApi}/open-apis/auth/v3/tenant_access_token/internal`, {
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
      `${openApi}/open-apis/application/v6/applications/${bot.config.larkAppId}?lang=zh_cn`,
      { headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` } },
    );
    const infoData = await infoRes.json() as any;

    // 99991672 = 应用身份缺权限。最常见就是 admin:app.info:readonly /
    // application:application:self_manage 都没拿到，导致根本查不到自己的
    // scope 列表。这种"鸡生蛋"情况单独提示：让 admin 开通免审批的
    // self_manage 后下次重启就能自检了。
    if (infoData.code === 99991672) {
      const selfManageAuthUrl = buildScopeDeepLink(bot.config.larkAppId, SELF_MANAGE_SCOPE, brand);
      const targetAuthUrl = buildScopeDeepLink(bot.config.larkAppId, REQUIRED_BOT_AT_SCOPE, brand);
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

    // 文档评论入口就绪自检：仅对「已订阅过文档」的 bot 生效（opt-in，不打扰其他 bot）。
    // ① 校验文档 app 权限是否开通（可查 → 缺则 DM 深链）② 提醒去后台订阅评论事件
    // drive.notice.comment_add_v1（飞书无 API 可查是否已订阅，只能提醒）——让「订阅
    // 成功却收不到评论」这类配置漏项在重启自检时暴露。
    try {
      const docSubs = listAllDocSubscriptions(config.session.dataDir, larkAppId);
      if (docSubs.length > 0) {
        const missingDoc = DOC_FEATURE_SCOPES.filter(s => !grantedScopes.has(s.name));
        if (missingDoc.length > 0) {
          const summary = missingDoc.map(s => `${s.name}(${s.desc})`).join('、');
          logger.error(`[${larkAppId}] 文档评论入口已在用（${docSubs.length} 个订阅）但缺 ${missingDoc.length} 项文档权限：${summary}。评论将收不到/回不了，请到权限管理开通后 botmux restart。`);
          const adminDoc = getAdminOpenId(bot);
          if (adminDoc) {
            const lines = missingDoc.map((s, i) => `${i + 1}. **${s.desc}** (\`${s.name}\`)\n   ${buildScopeDeepLink(bot.config.larkAppId, s.name, brand)}`).join('\n\n');
            await dmAdmin(larkAppId, adminDoc,
              `⚠️ 机器人 "${bot.botName ?? larkAppId}" 已订阅 ${docSubs.length} 个飞书文档（/subscribe-lark-doc），但缺少文档评论所需权限：\n\n${lines}\n\n` +
              `另外请确认开发者后台「事件订阅」里已添加 **\`${DOC_COMMENT_EVENT}\`**（云文档新增评论）事件——该事件无法被自动检测，缺它则评论永远收不到。\n\n开通 + 订阅事件后执行 \`botmux restart\`。`,
              `missing doc-feature scopes: ${missingDoc.map(s => s.name).join(',')}`);
          }
        } else {
          // 权限齐了——事件订阅查不了，仅 info 记一条提醒（不 DM 免重启刷屏）。
          logger.info(`[${larkAppId}] doc-comment 权限齐全（${docSubs.length} 订阅）；请确保后台已订阅事件 ${DOC_COMMENT_EVENT}（无法自动检测）`);
        }
      }
    } catch (err: any) {
      logger.debug(`[${larkAppId}] doc-feature readiness check errored: ${err?.message ?? err}`);
    }

    // Diff against the canonical list. Critical-missing is the main signal;
    // non-critical is mentioned only when something critical is also missing,
    // so deployments don't get nagged about purely optional scopes like
    // `application:application:self_manage`.
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
      `${i + 1}. **${s.desc}** (\`${s.name}\`)\n   ${buildScopeDeepLink(bot.config.larkAppId, s.name, brand)}`,
    ).join('\n\n');
    const optionalBlock = missingOptional.length > 0
      ? `\n\n**可选权限（建议一并开通）**：\n${missingOptional.map(s => `- ${s.desc} (\`${s.name}\`): ${buildScopeDeepLink(bot.config.larkAppId, s.name, brand)}`).join('\n')}`
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
// Bounded: keyed per chat; TTL gates freshness on read, the cap stops the
// entry count growing with every distinct chat the bot ever serves.
const chatStatsCache = new BoundedMap<string, { userCount: number; botCount: number; fetchedAt: number }>(1000);

// ─── Event callback ACK safety ──────────────────────────────────────────────
//
// The Lark WS SDK sends exactly one response frame per event and only AFTER the
// registered handler's promise resolves (WSClient.handleEventData: it awaits
// eventDispatcher.invoke, then sendMessage once). So that frame is the ACK: a
// slow handler delays it past Feishu's 3s budget and triggers a timeout re-push.
// The message path below can spend seconds on OpenAPI lookups + spawning a CLI,
// so we return synchronously and run the heavy work behind setImmediate — the
// handler resolves immediately, the ACK is prompt, and the work runs after.
//
// Dedupe: Feishu re-pushes an un-ACKed/non-200 event at 15s, 5min, 1h, 6h (max
// 4 retries), and its pipeline is at-least-once, so a duplicate can arrive even
// after a timely 200. Fast-ACK keeps us inside 3s so timeout-retries stop
// firing — the realistic duplicate is then a near-simultaneous at-least-once
// copy, which a short-lived claim per stable event key suppresses. The TTL
// covers the 15s/5min/1h retry tiers with margin; the 6h tier is only reachable
// after a sustained ACK failure that fast-ACK prevents, so we don't size for it.
// (We claim-then-ack-success on purpose: a redelivery is always treated as a
//  duplicate, never as recovery — matching the prior swallow-and-ACK behavior.)
const EVENT_CLAIM_TTL_MS = 2 * 60 * 60_000; // 2h — covers the 15s/5min/1h retry tiers
const EVENT_CLAIM_PRUNE_INTERVAL_MS = 5 * 60_000;
const EVENT_CLAIM_PRUNE_SIZE = 5000;
const eventClaims = new Map<string, number>();
let eventClaimsLastPrunedAt = 0;

function pruneEventClaims(now = Date.now()): void {
  eventClaimsLastPrunedAt = now;
  for (const [key, expiresAt] of eventClaims) {
    if (expiresAt <= now) eventClaims.delete(key);
  }
}

function claimEventOnce(key: string): boolean {
  const now = Date.now();
  // Prune under size pressure OR on a time interval, so a busy bot's map stays
  // bounded regardless of call cadence (the size gate alone never fires below
  // the threshold, leaving expired entries pinned for the full TTL).
  if (eventClaims.size > EVENT_CLAIM_PRUNE_SIZE || now - eventClaimsLastPrunedAt > EVENT_CLAIM_PRUNE_INTERVAL_MS) {
    pruneEventClaims(now);
  }
  const expiresAt = eventClaims.get(key);
  if (expiresAt && expiresAt > now) return false;
  eventClaims.set(key, now + EVENT_CLAIM_TTL_MS);
  return true;
}

function scheduleAckSafeEvent(key: string, work: () => Promise<void>, label: string): void {
  if (!claimEventOnce(key)) {
    logger.info(`[event-dedupe] duplicate ${label} ignored: ${key}`);
    return;
  }
  // INVARIANT: claimEventOnce + this setImmediate scheduling must stay fully
  // synchronous (no await before we get here). WS events arrive in order and
  // setImmediate is FIFO, so same-anchor messages reach serializeByAnchor in
  // arrival order ONLY while nothing awaits ahead of the schedule. An await here
  // would reintroduce the kickoff-ordering bug serializeByAnchor guards against.
  setImmediate(() => {
    void work().catch(err => logger.error(`Error handling ${label}: ${err}`));
  });
}

// Fallback for an event that carries no stable id at all. Dedupe must never
// silently DROP a real message, so we hand back a unique key (process it, accept
// a rare duplicate) rather than a content-prefix key that could collide with a
// distinct message and suppress it for the whole TTL.
let unkeyableEventSeq = 0;
function unkeyableEventKey(): string {
  return `__unkeyable__:${++unkeyableEventSeq}`;
}

function eventIdForKey(data: any): string | undefined {
  return data?.event_id ?? data?.uuid ?? data?.header?.event_id ?? data?.event?.event_id;
}

// card.action.trigger is a synchronous callback with a 3s deadline and NO
// re-push (unlike events). If a handler (e.g. restart, which spawns a worker)
// might exceed the budget, we ACK before 3s with a toast and patch the card
// afterwards — missing the deadline otherwise surfaces error 200341 to the user.
// 2500ms leaves headroom for the WS frame round-trip inside the 3s window.
const CARD_ACTION_ACK_TIMEOUT_MS = 2500;
const CARD_ACTION_TIMEOUT = Symbol('card-action-timeout');
const cardActionInFlight = new Set<string>();

function cardActionMessageId(data: any): string | undefined {
  return data?.context?.open_message_id ?? data?.open_message_id;
}

function cardActionKey(larkAppId: string, data: any): string {
  const eventId = eventIdForKey(data);
  if (eventId) return `card.action.trigger:${larkAppId}:${eventId}`;
  const action = data?.action;
  const value = action?.value ?? {};
  return `card.action.trigger:${larkAppId}:${JSON.stringify({
    messageId: cardActionMessageId(data),
    operator: data?.operator?.open_id,
    action: value?.action ?? action?.option ?? action?.tag,
    rootId: value?.root_id,
    sessionId: value?.session_id,
    nonce: value?.card_nonce ?? value?.nonce,
    option: action?.option,
    key: value?.key,
  })}`;
}

function shapeCardActionResult(result: any): any {
  // The handler may return:
  //   - an already-shaped Lark response ({toast} and/or {card}) -> pass through;
  //   - a raw card body (e.g. toggle_stream) -> wrap as an in-place card patch.
  if (result && (result.toast || result.card)) return result;
  if (result) return { card: { type: 'raw', data: result } };
  return undefined;
}

function serializeRawCardForPatch(cardData: any): string | undefined {
  if (cardData === undefined || cardData === null) return undefined;
  return typeof cardData === 'string' ? cardData : JSON.stringify(cardData);
}

async function patchTimedOutCardActionResult(larkAppId: string, data: any, shapedResult: any): Promise<void> {
  const messageId = cardActionMessageId(data);
  if (!messageId || !shapedResult?.card) return;
  const card = shapedResult.card;
  const raw = card.type === 'raw' ? card.data : card;
  const body = serializeRawCardForPatch(raw);
  if (!body) return;
  await updateMessage(larkAppId, messageId, body);
}

async function handleCardActionAckSafe(data: any, larkAppId: string, handlers: EventHandlers): Promise<any> {
  const eventId = eventIdForKey(data);
  const key = cardActionKey(larkAppId, data);

  // Durable dedupe ONLY when the platform gave a stable per-interaction id:
  // suppresses a same-interaction redelivery over the long-connection so a
  // non-idempotent action (restart/close) can't double-fire after the first
  // copy already finished — the in-flight Set alone clears in finally() and
  // would miss that. We deliberately do NOT durably claim the payload-based
  // fallback key: distinct clicks of the same button (e.g. toggling stream
  // on/off) legitimately repeat and must not be pinned for the whole TTL.
  if (eventId && !claimEventOnce(key)) {
    logger.info(`[event-dedupe] duplicate card action ignored (claimed): ${key}`);
    return { toast: { type: 'info', content: t('toast.action_received_no_repeat', undefined, localeForBot(larkAppId)) } };
  }

  if (cardActionInFlight.has(key)) {
    logger.info(`[event-dedupe] duplicate card action ignored while in-flight: ${key}`);
    return { toast: { type: 'info', content: t('toast.action_in_progress', undefined, localeForBot(larkAppId)) } };
  }

  cardActionInFlight.add(key);
  let timedOut = false;
  const work = handlers.handleCardAction(data, larkAppId)
    .then(shapeCardActionResult)
    .catch(err => {
      logger.error(`Error handling card action: ${err}`);
      return undefined;
    });

  void work.then(result => {
    if (!timedOut || !result) return;
    if (!result.card && result.toast) {
      // A toast-only result can't be re-surfaced after we already ACKed with the
      // generic "后台处理中" toast: toasts ride the synchronous callback response,
      // and the message-update API only patches the card. Log rather than drop.
      logger.warn(`[card-action] slow handler resolved to a toast-only result after ACK; not shown to user: ${JSON.stringify(result.toast)}`);
      return;
    }
    return patchTimedOutCardActionResult(larkAppId, data, result)
      .catch(err => logger.warn(`Failed to patch timed-out card action result: ${err}`));
  }).finally(() => {
    cardActionInFlight.delete(key);
  });

  const timeout = new Promise(resolve => setTimeout(resolve, CARD_ACTION_ACK_TIMEOUT_MS, CARD_ACTION_TIMEOUT));
  const result = await Promise.race([work, timeout]);
  if (result === CARD_ACTION_TIMEOUT) {
    timedOut = true;
    logger.warn(`[card-action] handler exceeded ${CARD_ACTION_ACK_TIMEOUT_MS}ms; ACKing first and continuing in background: ${key}`);
    return { toast: { type: 'info', content: t('toast.action_received_bg', undefined, localeForBot(larkAppId)) } };
  }
  return result;
}

/** Test-only: clear callback dedupe claims between cases. */
export function __resetEventClaimsForTest(): void {
  eventClaims.clear();
  cardActionInFlight.clear();
}

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
      atomicWriteFileSync(fp, JSON.stringify(existing, null, 2) + '\n');
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
 * /introduce 不需要任何授权：它只是把群里别的 bot 记进花名册（observed），不授予
 * 任何对话/操作权，所以群里任何人都能用（与 /grant 的 owner 强闸门相反）。
 *
 * Consumed without side effects (still returns true) when:
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
): Promise<boolean> {
  const text = extractMessageTextForRouting(message);
  if (!text) return false;
  // Strip leading @<mention> tokens (using the message's mentions list to
  // tolerate names with spaces) before checking the command position.
  const stripped = stripLeadingMentions(text.trim(), message?.mentions ?? []);
  if (!INTRODUCE_RE.test(stripped)) return false;
  logger.debug(`[${larkAppId}] /introduce from ${senderOpenId ?? 'unknown'} (no auth required)`);

  if (grantCommandRestriction(larkAppId, message.chat_id, senderOpenId).blocked) {
    const loc = localeForBot(larkAppId);
    await replyMessage(larkAppId, message.message_id, JSON.stringify({
      text: t('cmd.grant_restricted', { cmd: '/introduce' }, loc),
    })).catch(err => logger.debug(`introduce grant_restricted reply failed: ${err}`));
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
  // 查通讯录剔除真人：花名册只收 bot——真人混进去会污染 <available_bots> 误导模型，
  // 且不必再「靠人自觉」只 @ bot。self 始终保留（它是本 app open_id 的权威自记录）。
  // 缺 contact 读权限时 isHumanOpenId 一律返回 false → 退回「全部登记」旧行为（见其注释）。
  const humanFlags = await Promise.all(
    all.map(m => (m.openId === selfOpenId ? Promise.resolve(false) : isHumanOpenId(larkAppId, m.openId).catch(() => false))),
  );
  const bots = all.filter((_, i) => !humanFlags[i]);
  try {
    // Persist to the observer-scoped store: these open_ids are scoped to the
    // receiving app (larkAppId), so they're correct for THIS daemon to use
    // when @-mentioning back.
    recordObservedBots(config.session.dataDir, larkAppId, chatId, bots, 'introduce');
  } catch (err) {
    logger.warn(`[${larkAppId}] /introduce: failed to persist observed bots: ${err}`);
  }

  const externalBots = bots.filter(m => m.openId !== selfOpenId);
  const ackText = externalBots.length
    ? `✅ 已认识本群 ${externalBots.length} 个伙伴：${externalBots.map(m => `@${m.name}`).join(' ')}`
    : `ℹ️ 没有可登记的机器人（/introduce 只登记机器人，@ 的若是真人会被忽略）`;
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
// Oncall-bound chats for the receiving bot: talking is open to everyone in the
// group; operating still requires allowedUsers (single source of truth — no
// per-chat owners).
//
// Oncall talk access is bot-scoped. Binding Bot A to a chat does not relax talk
// access for sibling Bot B in the same deployment; Bot B must bind the same chat
// itself, or continue using its own allowedUsers/chatGrants/globalGrants.

export type TalkReason =
  | 'allowedUser'
  | 'oncall'
  | 'peer'
  | 'allowedChatGroup'
  | 'open'
  | 'chatGrant'
  | 'globalGrant'
  | 'none';

export interface TalkEvaluation {
  allowed: boolean;
  reason: TalkReason;
  quotaKey?: string;
}

export type GrantCommandRestrictionReason = 'chatGrant' | 'globalGrant';

export function grantCommandRestriction(
  larkAppId: string,
  chatId: string | undefined,
  senderOpenId: string | undefined,
): { blocked: boolean; reason?: GrantCommandRestrictionReason } {
  const bot = getBot(larkAppId);
  if (bot.config.restrictGrantCommands !== true) return { blocked: false };
  const ev = evaluateTalk(larkAppId, chatId, senderOpenId);
  if (ev.reason === 'chatGrant' || ev.reason === 'globalGrant') {
    return { blocked: true, reason: ev.reason };
  }
  return { blocked: false };
}

/** per-chat per-user 授权命中判断（仅用于 canTalk —— 不给管理命令权）。 */
function hasChatGrant(larkAppId: string, chatId: string | undefined, openId: string | undefined): boolean {
  return !!chatId && !!openId && !!getBot(larkAppId).config.chatGrants?.[chatId]?.includes(openId);
}

/** 全局对话授权命中判断（人/bot 通用，仅用于 canTalk / bot 路由闸 —— 不给管理命令权）。 */
function hasGlobalGrant(larkAppId: string, openId: string | undefined): boolean {
  return !!openId && !!getBot(larkAppId).config.globalGrants?.includes(openId);
}

/**
 * 是否配置了任何白名单（限制态）。判定用 **原始** config.allowedUsers, 不用
 * resolvedAllowedUsers——否则「配了 owner 但启动时邮箱/union 解析失败 → resolved 为空」
 * 会 fall through 成「无白名单 = 全开放」，把误配/解析失败 fail-open 成谁都能 operate。
 * 配了就算限制态：解析为空时成员判定一律落空 → fail-closed（由 owner 修配置）。
 */
function hasConfiguredAllowlist(bot: ReturnType<typeof getBot>): boolean {
  return (bot.config.allowedUsers?.length ?? 0) > 0
    || (bot.config.allowedChatGroups?.length ?? 0) > 0
    || (bot.config.globalGrants?.length ?? 0) > 0;
}

export function canTalk(larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined): boolean {
  return evaluateTalk(larkAppId, chatId, senderOpenId).allowed;
}

export function evaluateTalk(larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined): TalkEvaluation {
  const bot = getBot(larkAppId);
  // allowedChatGroups 是"talk-open 的 chat_id 列表"：当前消息来自其中之一即放行（仅 canTalk）。
  // 成员关系隐含在"能在该 chat 发言"里 —— 退群者发不了言自动失权，新人进群即生效，无需成员快照。
  const allowedUsers = bot.resolvedAllowedUsers;
  if (senderOpenId && allowedUsers.includes(senderOpenId)) return { allowed: true, reason: 'allowedUser' };
  // Oncall 群命中：默认不限额；仅当 bot 配了 messageQuota.defaultLimit 时，
  // 才挂 chat:<chatId>:<openId> 这一 quotaKey（与 chatGrant 同键、同计数器，
  // 便于 owner 后续 /grant @x N 续杯/重置）。
  if (chatId && findOncallChat(larkAppId, chatId)) {
    const def = bot.config.messageQuota?.defaultLimit;
    if (typeof def === 'number' && Number.isInteger(def) && def > 0 && senderOpenId) {
      return { allowed: true, reason: 'oncall', quotaKey: chatQuotaKey(chatId, senderOpenId) };
    }
    return { allowed: true, reason: 'oncall' };
  }
  if (isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)) return { allowed: true, reason: 'peer' };
  if (chatId && bot.config.allowedChatGroups?.includes(chatId)) return { allowed: true, reason: 'allowedChatGroup' };

  // globalGrants 与 allowedChatGroups 同样确立"有白名单"语义：只配 globalGrants 也算限制态，
  // 不能 fall through 到"全开放"。用原始配置判定（见 hasConfiguredAllowlist）：配了 owner
  // 但解析失败时也保持限制态, 不 fail-open。
  if (!hasConfiguredAllowlist(bot)) return { allowed: true, reason: 'open' };

  if (hasChatGrant(larkAppId, chatId, senderOpenId)) {
    return { allowed: true, reason: 'chatGrant', quotaKey: chatQuotaKey(chatId!, senderOpenId!) };
  }
  // 全局对话授权（talk-only，人/bot 通用）：命中即在任意群放行，与 chatGrants 同级、不授 operate。
  if (hasGlobalGrant(larkAppId, senderOpenId)) {
    return { allowed: true, reason: 'globalGrant', quotaKey: globalQuotaKey(senderOpenId!) };
  }
  return { allowed: false, reason: 'none' };
}

export function canOperate(larkAppId: string, _chatId: string | undefined, senderOpenId: string | undefined): boolean {
  const bot = getBot(larkAppId);
  // L1 同部署兄弟 bot 互信 operate：与 canTalk 一致——isKnownPeerBot 只认本部署
  // bots-info.json 里注册过的自家 bot。这不重开 PR #46 的封堵：人的 talk 授权
  // （chatGrant/globalGrant）仍不漏成 operate；这里只放行「自家 bot 之间」的 /
  // 命令（让编排者能对子 bot 跑 /repo /cd 等）。跨团队/外部 bot 仍走 allowedUsers /
  // 后续的 operate 级 grant。
  if (isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)) return true;
  const allowedUsers = bot.resolvedAllowedUsers;
  // globalGrants（与 allowedChatGroups 同理）确立"有白名单"语义：只配 globalGrants 也算限制态，
  // 否则 canOperate 会 fall through 到"全开放"，把 talk-only 授权变成 operate 全开——正是 PR #46
  // 要堵的洞。注意 globalGrants 只进 hasAllowlist 判定，operate 命中仍只认 allowedUsers。
  // 用原始配置判定（hasConfiguredAllowlist）：配了 owner 但解析为空时 fail-closed, 不 fail-open。
  if (!hasConfiguredAllowlist(bot)) return true;
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
  const nonce = openPending(larkAppId, chatId, requesterOpenId, getBot(larkAppId).config.messageQuota?.defaultLimit);
  const card = buildGrantCard(
    { ownerOpenId: owner, targets: [{ openId: requesterOpenId, name: String(name) }], chatId, nonce, mode: 'request' },
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
  /** Chat-scope shared-topic reply target for this turn, if any. */
  replyRootId?: string;
  larkAppId: string;
}

export interface EventHandlers {
  handleCardAction: (data: any, larkAppId: string) => Promise<any>;
  handleNewTopic: (data: any, ctx: RoutingContext) => Promise<void>;
  handleThreadReply: (data: any, ctx: RoutingContext) => Promise<void>;
  /** 主动开工 — 场景①: fired when this bot is added to a chat
   *  (`im.chat.member.bot.added_v1`). The daemon decides whether to auto-start
   *  based on the bot's `autoStartOnGroupJoin` toggle + allowedUser membership.
   *  Best-effort fire-and-forget. `operatorOpenId` is who added the bot. */
  handleBotAdded?: (chatId: string, operatorOpenId: string | undefined, larkAppId: string) => Promise<void>;
  /** Check if this bot owns an active session anchored at the given id
   *  (rootMessageId for thread-scope, chatId for chat-scope). */
  isSessionOwner?: (anchor: string, larkAppId: string) => boolean;
  /** Resolve a persisted topic reply alias back to its owning chat-scope session. */
  resolveReplyThreadAlias?: (rootId: string, chatId: string, larkAppId: string) => { chatId: string; sessionId: string } | null;
  /** Fired when the dispatcher detects that a chat with a live chat-scope
   *  session has been converted to topic mode (chat_mode 'group' → 'topic'
   *  via Lark group settings). Daemon should evict the stale chat-scope
   *  session from its activeSessions map so future routing doesn't hit it
   *  and so scheduler/dashboard sends stop going through sendMessage(chatId)
   *  — which in a 话题群 wraps each top-level message in a fresh topic.
   *  Best-effort fire-and-forget; the dispatcher proceeds either way. */
  onChatModeConverted?: (chatId: string, larkAppId: string) => void;
  /** 文档评论入口（/subscribe-lark-doc）：一条命中订阅的文档评论被喂进其绑定
   *  会话。daemon 负责定位会话、投递给 worker、记录该轮回评论的落点。 */
  handleDocComment?: (ctx: DocCommentContext) => Promise<void>;
}

/** 一条已通过订阅 + 触发范围 + 自触发过滤的文档评论，交给 daemon 投递。 */
export interface DocCommentContext {
  larkAppId: string;
  /** 命中的文档订阅（含 sessionAnchor / scope / chatId）。 */
  sub: DocSubscription;
  /** 触发评论的 comment_id。 */
  commentId: string;
  /** 触发的具体回复 id（作 turnId，回评论落点也按它走）；缺省退回 commentId。 */
  replyId?: string;
  /** 评论纯文本（喂给模型的用户消息）。 */
  text: string;
  /** 评论发表者 open_id。 */
  authorOpenId?: string;
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

async function maybeApplySharedTopicSeed(input: {
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  message: any;
  senderOpenId: string | undefined;
  messageId: string;
  routing: { scope: 'thread' | 'chat'; anchor: string };
  forceTopicApplied?: boolean;
}): Promise<string | undefined> {
  const { larkAppId, chatId, chatType, message, senderOpenId, messageId, routing, forceTopicApplied } = input;
  if (forceTopicApplied) return undefined;
  if (chatType !== 'group') return undefined;
  if (resolveRegularGroupMode(larkAppId, chatId) !== 'shared') return undefined;
  // Seeding a shared topic normally needs an @mention. But under the 'never'
  // mention policy a non-@ message is also answered — and in shared mode it must
  // still OPEN a topic (reply in a thread reusing the chat session), not fall
  // back to a flat top-level reply. So allow non-@ seeding only when never.
  if (!isBotMentioned(larkAppId, message, senderOpenId) && resolveGroupMentionMode(larkAppId) !== 'never') return undefined;
  const freshMode = routing.scope === 'thread'
    ? await getChatMode(larkAppId, chatId, { forceRefresh: true })
    : (getCachedChatMode(larkAppId, chatId) ?? 'group');
  if (freshMode !== 'group') return undefined;
  routing.scope = 'chat';
  routing.anchor = chatId;
  logger.info(`[reply-mode] shared turn msg=${messageId.substring(0, 12)} routes through chat=${chatId.substring(0, 12)}`);
  return messageId;
}

async function maybeFoldMentionedRegularGroupThreadToChat(input: {
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  message: any;
  routing: { scope: 'thread' | 'chat'; anchor: string };
  forceTopicApplied?: boolean;
  mentionedThisBot: boolean;
  ownsThreadSession?: boolean;
}): Promise<string | undefined> {
  const { larkAppId, chatId, chatType, message, routing, forceTopicApplied, mentionedThisBot, ownsThreadSession } = input;
  if (forceTopicApplied || ownsThreadSession) return undefined;
  if (!mentionedThisBot) return undefined;
  if (chatType !== 'group') return undefined;
  const rootId: string | undefined = message?.root_id;
  const threadId: string | undefined = message?.thread_id;
  if (!rootId || !threadId) return undefined;
  const rawText = extractMessageTextForRouting(message);
  if (rawText) {
    const stripped = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
    if (parseForceTopicInvocation(stripped)) return undefined;
  }

  // In a regular group, `chat` and `shared` both mean "use the group's one
  // chat-scope session/context". Lark still reports replies inside an existing
  // topic as root_id+thread_id, so decideRouting's generic real-thread rule
  // would otherwise fork a brand-new thread-scope session every time another
  // human/bot @mentions us inside that topic. Keep the visible reply in the
  // same topic (replyRootId=rootId), but route the turn through the group
  // chat-scope session. `new-topic` is the only mode that intentionally keeps
  // per-topic independent sessions.
  if (resolveRegularGroupMode(larkAppId, chatId) === 'new-topic') return undefined;
  const freshMode = await getChatMode(larkAppId, chatId, { forceRefresh: true });
  if (freshMode !== 'group') return undefined;
  routing.scope = 'chat';
  routing.anchor = chatId;
  logger.info(`[reply-mode] mentioned thread root=${rootId.substring(0, 12)} folds into chat=${chatId.substring(0, 12)}`);
  return rootId;
}

/** Compute the scope + anchor for an inbound message:
 *   - root_id + thread_id     → thread-scope, anchor = root_id (real Lark 话题)
 *   - 话题群 + no real thread → thread-scope, anchor = message_id (thread seed)
 *   - p2p + no real thread    → thread-scope, anchor = message_id (each DM
 *                               top-level message starts a fresh topic; a
 *                               reply inside an existing thread carries
 *                               root_id+thread_id and threads into its session)
 *   - 普通群 + no real thread  → resolved regular-group mode:
 *                               new-topic uses thread-scope anchored at
 *                               message_id; chat / shared stay chat-scope
 *                               anchored at chat_id (shared folds into a topic
 *                               post-routing, see maybeApplySharedTopicSeed).
 *
 *  Why we gate on thread_id (not root_id alone): Lark 客户端的引用气泡 / 快速
 *  回复 UI 有时会给"用户视角的顶层消息"塞 root_id 但**不会**塞 thread_id。
 *  飞书官方文档：root_id/parent_id "仅在回复消息场景会有返回值"；thread_id
 *  "不返回说明该消息非话题消息"。所以 thread_id 才是"是否真的处于话题里"的
 *  权威信号。只看 root_id 会把 quote-bubble 错认为话题回复，把用户从 chat-scope
 *  会话里拽走、又起一个孤立的 thread session。
 *  Exported for unit tests. */
type RoutingSource = 'real-thread' | 'p2p' | 'topic-chat' | 'regular-group-thread' | 'regular-group-chat';

type RoutingDecision = {
  scope: 'thread' | 'chat';
  anchor: string;
  source: RoutingSource;
};

function regularGroupRouting(larkAppId: string, messageId: string, chatId: string): RoutingDecision {
  // tri-state: only `new-topic` forks a fresh thread-scope session. `shared`
  // stays chat-scope here (the topic fold happens post-routing, see
  // maybeApplySharedTopicSeed); `chat` is the flat default. resolveRegularGroupMode
  // is the single decision point so new-topic and shared never both fire.
  if (resolveRegularGroupMode(larkAppId, chatId) === 'new-topic') {
    return { scope: 'thread', anchor: messageId, source: 'regular-group-thread' };
  }
  return { scope: 'chat', anchor: chatId, source: 'regular-group-chat' };
}

async function decideRoutingWithSource(
  larkAppId: string,
  message: any,
): Promise<RoutingDecision> {
  const rootId: string | undefined = message.root_id;
  const threadId: string | undefined = message.thread_id;
  const chatType: string = message.chat_type ?? 'group';
  const messageId: string = message.message_id;
  const chatId: string = message.chat_id;

  // 私聊 chat 模式：整段 DM 一律折进同一个扁平 chat-scope 会话。必须先于下面的
  // real-thread（root_id+thread_id）分支判断 —— 否则用户在 DM 里"回复某条消息"
  // 形成的 thread 形态消息会被提前分流到 thread-scope，破坏"连续单聊会话"语义
  // （典型触发：thread→chat 模式切换后回复旧 thread，或 Lark 给 DM 回复塞了
  // thread_id）。仅 p2p 且 p2pMode==='chat' 命中，群聊 / p2p 默认 thread 模式不受影响。
  if (chatType === 'p2p' && getBot(larkAppId)?.config?.p2pMode === 'chat') {
    return { scope: 'chat', anchor: chatId, source: 'p2p' };
  }

  if (rootId && threadId) return { scope: 'thread', anchor: rootId, source: 'real-thread' };

  // 私聊默认（thread 模式）：每条 top-level DM 都视为新话题 — 跟话题群同款，匹配
  // Lark DM 的话题化默认行为，避免无限把 1:1 对话塞进同一个 CLI 进程里。
  if (chatType === 'p2p') {
    return { scope: 'thread', anchor: messageId, source: 'p2p' };
  }

  // Group chat — fetch chat_mode (cached) to disambiguate 话题群 from 普通群.
  const mode = await getChatMode(larkAppId, chatId);
  if (mode === 'topic') {
    return { scope: 'thread', anchor: messageId, source: 'topic-chat' };
  }
  return regularGroupRouting(larkAppId, messageId, chatId);
}

export async function decideRouting(
  larkAppId: string,
  message: any,
): Promise<{ scope: 'thread' | 'chat'; anchor: string }> {
  const { scope, anchor } = await decideRoutingWithSource(larkAppId, message);
  return { scope, anchor };
}

/** 从评论事件 payload 里挖出 { fileToken, fileType, commentId, replyId,
 *  noticeType, isMentioned, operatorOpenId }。
 *
 *  真机实测 drive.notice.comment_add_v1 的 event 体形如
 *  `{ comment_id, is_mentioned, notice_meta, reply_id }` —— **file_token 不在顶层，
 *  藏在 notice_meta 里**（notice_meta 可能是对象或 JSON 字符串）。故这里展开
 *  notice_meta 并多路径兜底；file_type 拿不到无妨（后续用订阅表里的）。 */
function parseCommentEvent(data: any): {
  fileToken?: string; fileType?: string; commentId?: string; replyId?: string;
  noticeType?: string; isMentioned?: boolean; operatorOpenId?: string; meta?: any;
} {
  const d = data?.event ?? data ?? {};
  let meta = d.notice_meta ?? d.noticeMeta;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { /* 保留原字符串 */ } }
  const m = (meta && typeof meta === 'object') ? meta : {};
  const pick = (k: string) => d[k] ?? m[k] ?? m[k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())];
  return {
    fileToken: pick('file_token') ?? pick('token') ?? pick('obj_token'),
    fileType: pick('file_type') ?? pick('obj_type'),
    commentId: pick('comment_id'),
    replyId: pick('reply_id'),
    noticeType: pick('notice_type'),
    isMentioned: d.is_mentioned === true || m.is_mentioned === true,
    operatorOpenId: d.operator_id?.open_id ?? d.user_id?.open_id ?? m.operator_id?.open_id,
    meta,
  };
}

/** 评论事件入口：去重 ACK-safe 包装 + 订阅匹配 + 自触发/触发范围过滤后转 daemon。 */
function handleCommentEventAckSafe(data: any, larkAppId: string, handlers: EventHandlers): void {
  const parsed = parseCommentEvent(data);
  const eventKey = `drive.comment_add:${larkAppId}:${eventIdForKey(data) ?? `${parsed.fileToken ?? '?'}:${parsed.replyId ?? parsed.commentId ?? '?'}`}`;
  scheduleAckSafeEvent(eventKey, async () => {
    try {
      await processCommentEvent(parsed, larkAppId, handlers);
    } catch (err) {
      logger.error(`Error handling doc-comment event: ${err}`);
    }
  }, 'doc-comment event');
}

async function processCommentEvent(
  parsed: ReturnType<typeof parseCommentEvent>,
  larkAppId: string,
  handlers: EventHandlers,
): Promise<void> {
  if (!handlers.handleDocComment) return;
  const { fileToken, commentId } = parsed;
  if (!fileToken || !commentId) {
    logger.info(`[doc-comment] event dropped: missing fileToken/commentId (fileToken=${fileToken ?? '?'} commentId=${commentId ?? '?'}) — payload 字段路径可能与解析不符`);
    return;
  }

  // 1) 必须是已订阅的文档（per-文档订阅 → 主键命中才处理）
  const sub = getDocSubscription(config.session.dataDir, larkAppId, fileToken);
  if (!sub) {
    logger.info(`[doc-comment] event dropped: file_token=${fileToken.slice(0, 12)} 不在订阅表（已订阅的可 /subscribe-lark-doc list 查；注意 wiki 链接会解析成底层 obj_token）`);
    return;
  }

  // 2) 拉评论 thread 取权威正文 / 作者 / @ 列表（事件 payload 不保证带全），
  //    同时用最新一条回复作为"触发回复"。
  const comment = await getDocComment(larkAppId, { fileToken, fileType: sub.fileType }, commentId);
  if (!comment || comment.replies.length === 0) {
    logger.info(`[doc-comment] event dropped: 取不到评论内容 comment=${commentId.slice(0, 12)}（replies=${comment ? comment.replies.length : 'null'}）`);
    return;
  }
  const trigger = parsed.replyId
    ? comment.replies.find(r => r.replyId === parsed.replyId) ?? comment.replies[comment.replies.length - 1]
    : comment.replies[comment.replies.length - 1];

  // 3) 自触发过滤（防死循环）：bot 的回复可能以应用身份（作者=bot open_id）或回退
  //    用户身份（作者=授权用户，无法靠作者区分）发出。三重保险：①作者==本 bot
  //    ②reply_id 在 bot 创建集合 ③文本含隐形哨兵。任一命中即跳过。
  const selfBotOpenId = getBot(larkAppId).botOpenId;
  if ((selfBotOpenId && trigger.userId === selfBotOpenId) || isBotAuthoredReply(trigger.replyId) || hasBotSentinel(trigger.text)) return;

  // 4) 触发范围：mention-only 要求评论 @ 到本 bot。优先用事件自带的 is_mentioned
  //    （飞书已判好），拿不到再回退按评论正文里的 @person 列表比对 bot open_id。
  if (sub.commentTriggerMode === 'mention-only') {
    const mentioned = parsed.isMentioned === true || (!!selfBotOpenId && trigger.mentions.includes(selfBotOpenId));
    if (!mentioned) {
      logger.info(`[doc-comment] event dropped: mention-only 但未 @ 本 bot (comment=${commentId.slice(0, 12)})`);
      return;
    }
  }

  const text = trigger.text.trim();
  if (!text) return;

  logger.info(`[doc-comment] dispatch file=${fileToken.slice(0, 12)} comment=${commentId.slice(0, 12)} mode=${sub.commentTriggerMode} → session anchor=${sub.sessionAnchor.slice(0, 12)}`);
  await handlers.handleDocComment({
    larkAppId,
    sub,
    commentId,
    replyId: trigger.replyId || commentId,
    text,
    authorOpenId: trigger.userId,
  });
}

/**
 * Create and start the Lark WSClient with event dispatching.
 * Returns the WSClient instance for lifecycle management.
 */
export function startLarkEventDispatcher(larkAppId: string, larkAppSecret: string, handlers: EventHandlers, brand: Brand = 'feishu'): Lark.WSClient {
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    // 主动开工 — 场景①: the bot was added to a chat. Hand off to the daemon,
    // which gates on the autoStartOnGroupJoin toggle + allowedUser membership.
    // Requires this event to be subscribed for the app in the Feishu console.
    'im.chat.member.bot.added_v1': (data: any) => {
      const chatIdForKey: string | undefined = data?.chat_id;
      const operatorForKey: string | undefined = data?.operator_id?.open_id;
      const eventKey = `im.chat.member.bot.added_v1:${larkAppId}:${eventIdForKey(data) ?? `${chatIdForKey ?? 'unknown'}:${operatorForKey ?? 'unknown'}`}`;
      scheduleAckSafeEvent(eventKey, async () => {
      try {
        const chatId: string | undefined = data?.chat_id;
        const operatorOpenId: string | undefined = data?.operator_id?.open_id;
        if (!chatId) return;
        logger.info(`[auto-start:入群] bot added to chat=${chatId.substring(0, 12)} by ${String(operatorOpenId ?? '?').substring(0, 12)}`);
        await handlers.handleBotAdded?.(chatId, operatorOpenId, larkAppId);
      } catch (err) {
        logger.error(`Error handling bot-added event: ${err}`);
      }
      }, 'bot-added event');
    },
    // 文档评论入口（/subscribe-lark-doc）。飞书评论事件命名在 v1/v2 间有差异，
    // 两个候选名都注册（同一处理器）——真机一锤定音后可删冗余。需在开发者后台
    // 订阅对应事件。注意：评论事件是 per-文档 推送（订阅时按 file_token 注册）。
    'drive.file.comment_add_v1': (data: any) => handleCommentEventAckSafe(data, larkAppId, handlers),
    'drive.notice.comment_add_v1': (data: any) => handleCommentEventAckSafe(data, larkAppId, handlers),
    'card.action.trigger': (data: any) => handleCardActionAckSafe(data, larkAppId, handlers),
    // 表情回复事件——一旦在开发者后台订阅了 reaction，SDK 每收到一次都会因
    // 没有 handler 打 "no im.message.reaction.created_v1 handle" 警告刷屏。
    // botmux 不消费表情事件，注册显式 no-op 把这条噪声静默掉。
    'im.message.reaction.created_v1': () => {},
    'im.message.reaction.deleted_v1': () => {},
    'im.message.receive_v1': (data: any) => {
      const messageIdForKey = data?.message?.message_id;
      const eventKey = `im.message.receive_v1:${larkAppId}:${eventIdForKey(data) ?? messageIdForKey ?? unkeyableEventKey()}`;
      scheduleAckSafeEvent(eventKey, async () => {
      try {
        const message = data.message;
        const sender = data.sender;
        if (!message) return;

        // Close the open_id startup race: probeBotOpenId is fire-and-forget at
        // startup, so an @ arriving in that window would hit isBotMentioned with
        // an undefined botOpenId and be silently dropped (the WSClient still ACKs
        // it, so Lark never redelivers → the @ is lost). Await the deduped probe
        // so the @ is recognized. Best-effort: on probe failure we degrade to the
        // prior behavior (the periodic heartbeat retries the probe).
        await ensureBotOpenId(larkAppId).catch(() => { /* degrade; heartbeat retries */ });

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
            // Serialize per anchor so back-to-back messages to the same thread
            // (e.g. dispatch's /repo prime + brief kickoff) don't interleave with
            // the first's async session-spawn. See anchor-serializer.ts.
            await serializeByAnchor(ctx.anchor, () =>
              handlers.handleThreadReply(data, { ...ctx, chatId, messageId, chatType, larkAppId }))
              .catch(err => logger.error(`Error handling message event: ${err}`));
            return;
          }
          // Foreign bot: only route on @mention of us.
          if (!isBotMentioned(larkAppId, message, undefined)) return;
          const decision = await decideRoutingWithSource(larkAppId, message);
          const ctx = { scope: decision.scope, anchor: decision.anchor };
          // Honor `/t` / `/topic` from bot senders too, aligning with the human
          // path so an explicit `@bot /t …` handoff seeds a fresh topic instead of
          // sticking to chat-scope. Applied BEFORE the gate (and the shared-topic
          // fold) so vetting keys on the FINAL routing: `/t` rewrites ctx to a
          // brand-new {thread, messageId} anchor. forceTopicApplied also suppresses
          // the shared-topic fold below — a `/t` seed wins over shared, same
          // precedence as the human path.
          const forcedTopic = maybeApplyForceTopicOverride(ctx, message, messageId);
          if (forcedTopic) {
            logger.info(`[/t] Force-topic override (bot sender): msg=${messageId.substring(0, 12)} → thread-scope, anchor=msg`);
          }
          const ownsThreadSession = ctx.scope === 'thread'
            ? (handlers.isSessionOwner?.(ctx.anchor, larkAppId) ?? false)
            : false;
          const canFoldForeignBotThread = findOncallChat(larkAppId, chatId)
            || isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)
            || hasChatGrant(larkAppId, chatId, senderOpenId)
            || hasGlobalGrant(larkAppId, senderOpenId);
          let replyRootId = await maybeFoldMentionedRegularGroupThreadToChat({
            larkAppId, chatId, chatType, message, routing: ctx, forceTopicApplied: forcedTopic, mentionedThisBot: !!canFoldForeignBotThread, ownsThreadSession,
          });
          if (!replyRootId) {
            replyRootId = await maybeApplySharedTopicSeed({
              larkAppId, chatId, chatType, message, senderOpenId, messageId, routing: ctx, forceTopicApplied: forcedTopic,
            });
          }
          // Regular-group foreign-bot @mention: gate to vetted botmux peers
          // (registered in our bot-openids cross-ref). Fires for legacy chat-scope
          // routing, the new-topic send-shape
          // (decision.source === 'regular-group-thread'), AND a `/t` force-topic
          // seed (forcedTopic) — so random Lark bots cannot silently spawn sessions
          // in 普通群, whether this bot replies in threads or a stranger bot @s us
          // with `/t`. Known Bot A → Bot B handoffs in 普通群 still work.
          //
          // ownsSession is read on ctx.anchor AFTER the `/t` override above. That
          // exemption means "a foreign bot following up into a session we already
          // own" (e.g. a chat-scope session at chatId). A `/t` rewrites the anchor
          // to a fresh messageId where we own nothing, so an unvetted bot can NOT
          // ride the existing chat-scope session's ownership to skip vetting — it
          // must independently hit isKnownPeerBot / chatGrants / globalGrants (or
          // this bot's own oncall chat).
          //
          // 注意 isKnownPeerBot 查的是 cross-ref（bot-openids-<appId>.json），它只
          // 收录 bots-info.json 里有名字的 bot，即本机 daemon 自己配置的 bot
          // （getAllBots）。"别人的 bot" 永远进不了这个 cross-ref，所以 isKnownPeerBot
          // 对外部 bot 恒为 false——这跟 /introduce 是两套独立存储：/introduce 写的是
          // observed-bots-store，只负责让发送方"发现并能 @ 到"对方，过不了这道接收闸。
          //
          // Oncall 群是当前接收 bot 显式部署的协作工作区，canTalk 已对任何成员
          // （含真人）放行；这里对 bot 同等放行，跳过 cross-ref vetting。否则本
          // bot 已绑定的 oncall 群里外部 bot 互相 @ 会被静默丢弃、只有真人能拉起会话。
          // 注意 oncall talk access 是 bot-scoped：一个 bot 的 /oncall bind 不会放开
          // sibling bot 的 talk 权限；如果 sibling bot 也要开放，需要自己绑定同一个 chat。
          //
          // owner 还可用 `/grant @bot` 把外部 bot 加进本群 chatGrants（与真人 /grant
          // 同一存储、同一 per-chat 语义）。命中 chatGrants 的 bot 即便不在 cross-ref，
          // 也与已注册 peer 同等放行——这是「授权外部 bot 在本群协作」的入口。
          // 全局授权（globalGrants）同理：命中即在任意群放行，是上面的全局版。
          if ((ctx.scope === 'chat' || decision.source === 'regular-group-thread' || forcedTopic) && !findOncallChat(larkAppId, chatId)) {
            const ownsSession = handlers.isSessionOwner?.(ctx.anchor, larkAppId) ?? false;
            if (!ownsSession
                && !isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)
                && !hasChatGrant(larkAppId, chatId, senderOpenId)
                && !hasGlobalGrant(larkAppId, senderOpenId)) {
              return;
            }
          }
          logger.info(`Bot-to-bot @mention detected (scope=${ctx.scope}): routing to handleThreadReply`);
          // Serialize per anchor — a sub-bot dispatched a /repo prime + kickoff
          // back-to-back into this thread must be handled in order, not raced.
          await serializeByAnchor(ctx.anchor, () =>
            handlers.handleThreadReply(data, { ...ctx, chatId, messageId, chatType, larkAppId, replyRootId }))
            .catch(err => logger.error(`Error handling bot @mention: ${err}`));
          return;
        }

        const senderOpenId = sender?.sender_id?.open_id as string | undefined;
        // defaultOncall 自动绑定必须在 canTalk 权限判断前完成，否则已开 defaultOncall
        // 的群首次 @bot 时 oncallChats 中还没有该 chat → evaluateTalk 判无权限 → 误弹
        // 自助授权申请卡。ensureDefaultOncallBound 本身带 fast-path 短路且 idempotent。
        await ensureDefaultOncallBound(larkAppId, chatId, chatType).catch(err =>
          logger.warn(`[oncall:${larkAppId}] pre-permission auto-bind failed for ${chatId.substring(0, 12)}: ${err}`),
        );
        const isAllowed = canTalk(larkAppId, chatId, senderOpenId);

        // /introduce — collaboration handshake. Intercept before any routing
        // so the command never reaches a CLI session (each @ed bot's daemon
        // independently records the mentions[] open_ids + names). 无需授权：
        // 任何人都能登记花名册（只记 observed，不授予任何权限）。
        if (await tryHandleIntroduceCommand(larkAppId, message, senderOpenId)) {
          return;
        }

        if (await tryHandleReplyModeCommand(larkAppId, message, senderOpenId, isAllowed)) {
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

        const decision = await decideRoutingWithSource(larkAppId, message);
        const routing: { scope: 'thread' | 'chat'; anchor: string } = {
          scope: decision.scope,
          anchor: decision.anchor,
        };
        let routingSource = decision.source;
        let replyRootId: string | undefined;
        const explicitlyMentionedThisBot = isBotMentioned(larkAppId, message, senderOpenId);

        // Shared-mode follow-up: a non-@ message inside a Lark thread can belong
        // to the regular group's chat-scope session when that root was registered
        // as a shared-topic alias. Whether a 普通群 answers it without an @mention
        // is governed by the bot-global mention policy: 'always' (default) keeps
        // "@ required" so this fold-back is skipped (non-@ thread chatter falls
        // through to the gate below and is ignored — only an explicit @ continues
        // a shared topic); 'topic' and 'never' enable the seamless no-@ fold-back.
        if (!explicitlyMentionedThisBot
            && resolveGroupMentionMode(larkAppId) !== 'always'
            && routing.scope === 'thread' && message.root_id && message.thread_id && chatType === 'group') {
          const alias = handlers.resolveReplyThreadAlias?.(message.root_id, chatId, larkAppId) ?? null;
          if (alias) {
            const freshMode = await getChatMode(larkAppId, chatId, { forceRefresh: true });
            if (freshMode === 'group') {
              routing.scope = 'chat';
              routing.anchor = alias.chatId;
              replyRootId = message.root_id;
              logger.info(`[reply-mode] alias root=${message.root_id.substring(0, 12)} → chat=${alias.chatId.substring(0, 12)} session=${alias.sessionId.substring(0, 8)}`);
            }
          }
        }

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
            const rerouted = regularGroupRouting(larkAppId, messageId, chatId);
            logger.info(
              `[chat-mode-converted] ${chatId.substring(0, 12)} chat_mode flipped 'topic' → 'group'; ` +
              `rerouting msg=${messageId.substring(0, 12)} as ${rerouted.scope}-scope`,
            );
            routing.scope = rerouted.scope;
            routing.anchor = rerouted.anchor;
            routingSource = rerouted.source;
          }
        }

        // 主动开工 — 场景②: capture only genuine topic-group seeds NOW, before
        // `/t` or the regular-group new-topic mode can create the same
        // {thread, anchor=messageId} shape in a regular group. autoStartOnNewTopic
        // is deliberately limited to 话题群.
        const autoTopicSeedScope = routingSource === 'topic-chat' ? routing.scope : 'chat';
        const autoTopicSeedAnchor = routingSource === 'topic-chat' ? routing.anchor : chatId;

        // /t / /topic in 普通群: flip routing to thread-scope so the bot's
        // first reply seeds a fresh Lark thread, even if a chat-scope session
        // is currently active in this chat.
        const forceTopicApplied = maybeApplyForceTopicOverride(routing, message, messageId);
        if (forceTopicApplied) {
          logger.info(`[/t] Force-topic override: msg=${messageId.substring(0, 12)} → thread-scope, anchor=msg`);
        }

        let ownsSession = handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false;

        const ownsThreadSessionBeforeFold = routing.scope === 'thread'
          ? (handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false)
          : false;
        const foldedReplyRootId = await maybeFoldMentionedRegularGroupThreadToChat({
          larkAppId, chatId, chatType, message, routing, forceTopicApplied, mentionedThisBot: explicitlyMentionedThisBot, ownsThreadSession: ownsThreadSessionBeforeFold,
        });
        if (foldedReplyRootId) {
          replyRootId = foldedReplyRootId;
          ownsSession = handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false;
        } else {
          const seedReplyRootId = await maybeApplySharedTopicSeed({
            larkAppId, chatId, chatType, message, senderOpenId, messageId, routing, forceTopicApplied,
          });
          if (seedReplyRootId) {
            replyRootId = seedReplyRootId;
            ownsSession = handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false;
          }
        }

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
        // Skip p2p: a DM is always 'p2p' and can never be a topic group, so the
        // check can only waste a forceRefresh roundtrip (relevant now that
        // p2pMode==='chat' makes DMs land on chat-scope).
        if (routing.scope === 'chat' && ownsSession && chatType !== 'p2p') {
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
          if (ownsSession && !replyRootId) stats = await getGroupStats(larkAppId, chatId);
          // replyRootId means this turn has already been explicitly addressed
          // to the bot by shared-topic logic (possibly from inside an existing
          // Lark thread). Do not re-run the generic group @ gate, which would
          // reject multi-bot thread replies simply because `routing.scope` was
          // folded back to chat-scope.
          //
          // The bot-global mention policy drops the @ requirement:
          //   • 'never' — entirely: any message from a talk-allowed sender is
          //     answered (incl. brand-new non-@ top-level → spawns/continues a
          //     session). Intended for dedicated / on-call groups, not busy chats.
          //   • 'topic' — only inside a topic the bot already owns: a non-@ reply
          //     INSIDE such a thread (new-topic / 话题群 thread the bot owns, or a
          //     shared-topic alias via replyRootId) continues without @, while a
          //     brand-new top-level conversation still requires @.
          // Both gated on isAllowed so restricted groups still only react to
          // permitted senders. (The shared fold-back's replyRootId is already
          // handled by the first clause.)
          const mentionMode = resolveGroupMentionMode(larkAppId);
          const relax = (!!replyRootId && isAllowed)
            || (isAllowed && mentionMode === 'never')
            || (isAllowed && mentionMode === 'topic' && ownsSession && !!message.thread_id)
            || (ownsSession && isAllowed && !!stats && stats.userCount <= 1 && stats.botCount <= 1);
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
              // 主动开工 — 场景②: a non-@ message that seeds a brand-new topic in
              // a 话题群 auto-starts a session when the bot opted in. Everything
              // else (regular-group chatter, thread replies, disabled bots) keeps
              // the original ignore. Sender is intentionally not gated (D4).
              const autoTopic = shouldAutoStartOnNewTopic({
                enabled: getBot(larkAppId).config.autoStartOnNewTopic === true,
                scope: autoTopicSeedScope,
                anchor: autoTopicSeedAnchor,
                messageId,
                chatType,
                ownsSession,
              });
              if (!autoTopic) {
                logger.debug(`Ignoring group message not addressed to bot: ${messageId}`);
                return;
              }
              logger.info(`[auto-start:新话题] ${chatId.substring(0, 12)} 新话题免@自动开工 msg=${messageId.substring(0, 12)}`);
            }
          }
        } else if (!isAllowed) {
          logger.debug(`Ignoring p2p message from non-allowed user: ${senderOpenId}`);
          return;
        }

        const ctx: RoutingContext = { chatId, messageId, chatType, larkAppId, ...routing, replyRootId };
        // Serialize per anchor so two messages to the same thread/chat are
        // processed in arrival order — never concurrently. Without this a fast
        // second message interleaves with the first's async session-spawn and is
        // dropped (worker-not-ready → re-fork branch). See anchor-serializer.ts.
        await serializeByAnchor(ctx.anchor, () => ownsSession
          ? handlers.handleThreadReply(data, ctx)
          : handlers.handleNewTopic(data, ctx))
          .catch(err => logger.error(`Error handling message event: ${err}`));
      } catch (err) {
        logger.error(`Error handling message event: ${err}`);
      }
      }, 'message event');
    },
  });

  // 诊断：包一层 invoke，记录长连接收到的**每一个**事件类型（含未注册的）。
  // 排查云文档评论事件是否真送达 / 实际事件名用——comment 类一律连 payload 关键字段
  // 一起打。日常其它事件只在 DEBUG 下打，避免刷屏。
  // 仅当 dispatcher 真有 invoke 方法时才包（单测里 Lark.EventDispatcher 是 mock，
  // register() 返回的对象没有 invoke → 不包，避免 undefined.bind 抛错）。
  const __origInvoke = typeof (eventDispatcher as any).invoke === 'function'
    ? (eventDispatcher as any).invoke.bind(eventDispatcher)
    : undefined;
  if (__origInvoke) {
    (eventDispatcher as any).invoke = (data: any) => {
      try {
        const et: string = data?.header?.event_type ?? data?.event_type ?? data?.type ?? 'unknown';
        const isCommentish = typeof et === 'string' && et.includes('comment');
        if (isCommentish) {
          const ev = data?.event ?? data;
          const p = parseCommentEvent(data);
          logger.info(`[ws-event] ${larkAppId} event_type=${et} → parsed fileToken=${p.fileToken ?? '?'} commentId=${p.commentId ?? '?'} replyId=${p.replyId ?? '?'} isMentioned=${p.isMentioned} | notice_meta=${JSON.stringify(ev?.notice_meta ?? ev?.noticeMeta ?? null)}`);
        } else if (process.env.DEBUG) {
          logger.info(`[ws-event] ${larkAppId} event_type=${et}`);
        }
      } catch { /* 诊断不阻断分发 */ }
      return __origInvoke(data);
    };
  }

  // Start WSClient
  const wsClient = new Lark.WSClient({
    appId: larkAppId,
    appSecret: larkAppSecret,
    // brand → 长连接域名。国际版租户必须连 larksuite.com，否则收不到任何事件。
    domain: sdkDomain(brand),
    // Default to warn — the SDK is chatty at info ("client ready", reconnect
    // heartbeats, etc.) and floods pm2 error.log when stderr is the only sink.
    // DEBUG=1 widens the level back to info for troubleshooting.
    loggerLevel: process.env.DEBUG ? Lark.LoggerLevel.info : Lark.LoggerLevel.warn,
    // 主机长断网（夜间合盖睡眠、Wi-Fi 切换、VPN 重连）后，SDK 重连要先用 HTTPS 去
    // 飞书换 ws 接入点，这步会 ENOTFOUND / 15s 超时；重连次数由服务端下发且有限，
    // 耗尽后 SDK 置 terminalError 永久放弃，但进程仍 online、PM2 不会兜底 —— 表现为
    // 「必须手动 botmux restart 才能恢复收消息」。下面两道防线让长连接死后自愈。
    //
    // ① pingTimeout：发 ping 后 30s 内无任何 inbound 帧即掐断 socket，触发 close →
    //    SDK 自身重连。专治 TCP 半开连接（没收到 FIN/RST、close 事件不触发）的静默卡死。
    wsConfig: { pingTimeout: 30 },
    // 重连握手卡死（DNS/代理/NAT）兜底，避免单次握手永久 pending。
    handshakeTimeoutMs: 15_000,
    // 重连过程打日志，便于事后从 `pnpm daemon:logs` 复盘（warn 默认看不到这些）。
    onReconnecting: () => logger.warn(`[ws] ${larkAppId} reconnecting…`),
    onReconnected: () => logger.info(`[ws] ${larkAppId} reconnected`),
    onError: (err) => logger.error(`[ws] ${larkAppId} terminal error: ${err.message}`),
  });

  wsClient.start({ eventDispatcher });
  logger.info('Daemon WSClient started');

  // ② SDK 重连耗尽后停在 terminalError（getConnectionStatus().state === 'failed'）并
  //    永久放弃。每分钟探测一次，发现已放弃就 start() 重新发起一轮全新握手 —— start()
  //    会清掉 terminalError 并重新 pullConnectConfig + connect，无需手动重启 daemon。
  //    只在 'failed' 时介入，不打断 SDK 正在进行的 'reconnecting' / 'connecting'。
  let reviving = false;
  const reviveTimer = setInterval(() => {
    if (reviving) return;
    if (wsClient.getConnectionStatus().state !== 'failed') return;
    reviving = true;
    logger.warn(`[ws] ${larkAppId} connection failed (reconnect exhausted), restarting WSClient`);
    wsClient.start({ eventDispatcher })
      .catch(err => logger.error(`[ws] ${larkAppId} WSClient restart failed: ${err?.message ?? err}`))
      .finally(() => { reviving = false; });
  }, 60_000);
  reviveTimer.unref();

  return wsClient;
}
