/**
 * Lark event dispatcher — handles WSClient setup, bot identity probing,
 * and message routing (group access checks, @mention detection).
 * Extracted from daemon.ts for modularity.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { ProxyAgent } from 'proxy-agent';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { join } from 'node:path';
import { getBot, getAllBots, findOncallChat, getOwnerOpenId, type BotState } from '../../bot-registry.js';
import { config, isVcMeetingAgentGloballyEnabled, vcMeetingAgentGlobalListenerBotAppId } from '../../config.js';
import { getChatInfo, getChatMode, getCachedChatMode, listChatBotMembers, replyMessage, sendMessage, sendUserMessage, isHumanOpenId, updateMessage } from './client.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/bounded-map.js';
import { serializeByAnchor } from '../../utils/anchor-serializer.js';
import { parseForceTopicInvocation } from '../../core/command-handler.js';
import { shouldAutoStartOnNewTopic } from '../../core/auto-start.js';
import { resolveNonsupportMessage, stripLeadingMentions, mentionOpenId, extractMentionIdentities, type MentionIdentity } from './message-parser.js';
import { recordObservedBots, listObservedBots } from '../../services/observed-bots-store.js';
import { isTeamBot, recordTeamBot } from '../../services/team-bots-store.js';
import { isTeamGroupChat } from '../../services/team-groups-store.js';
import { isPlatformTeamBot, isPlatformHallChat, isPlatformTeamMemberChat } from '../../services/platform-team-store.js';
import { recordBotUnionId, recordBotUnionIdFromMentions } from '../../services/bot-union-ids-store.js';
import { getDocSubscription, putDocSubscription, removeDocSubscription, listAllDocSubscriptions, type DocSubscription } from '../../services/doc-subs-store.js';
import { getDocComment, isBotAuthoredReply, hasBotSentinel, commentTriggerAllowed, BOT_REPLY_SENTINEL } from './doc-comment.js';
import {
  BOTMUX_REQUIRED_SCOPES,
  DOC_FEATURE_SCOPES,
  DOC_WATCH_SCOPES,
  DOC_COMMENT_EVENT,
  VC_MEETING_BOT_EVENTS,
  VC_MEETING_FEATURE_SCOPES,
  VC_MEETING_REALTIME_VOICE_SCOPES,
  buildEventSubDeepLink,
  buildScopeDeepLink,
} from '../../setup/verify-permissions.js';
import { automateOpenPlatformSetup } from '../../setup/open-platform-automation.js';
import { type Brand, larkHosts, normalizeBrand, sdkDomain } from './lark-hosts.js';
import { tryHandleGrantCommand } from './grant-command.js';
import { tryHandleReplyModeCommand } from './reply-mode-command.js';
import { tryHandleSubstituteCommand } from './substitute-command.js';
import { buildGrantCard } from './card-builder.js';
import { openPending, isThrottled, clearPending } from './grant-pending.js';
import { localeForBot, t } from '../../i18n/index.js';
import { chatQuotaKey, globalQuotaKey } from '../../services/grant-store.js';
import { claimMessageOnce, _resetCacheForTest as _resetSeenMessagesForTest } from '../../services/seen-message-store.js';
import { ensureDefaultOncallBound } from '../../services/oncall-store.js';
import { resolveRegularGroupMode, resolveGroupMentionMode } from '../../services/chat-reply-mode-store.js';
import { buildSummaryCommandPrompt, type SummaryChatKind, type SummaryCommandMatch, type SummaryCommandRuntimeContext } from './summary-command.js';
import { DEFAULT_SUMMARY_PROMPT, summaryRangeFromBotConfig } from '../../services/summary-range-store.js';
import { isSubstituteEnabledForChat } from '../../services/substitute-chat-toggle-store.js';
import {
  parseVcMeetingPushEvent,
  VC_BOT_MEETING_ACTIVITY_EVENT,
  VC_BOT_MEETING_ENDED_EVENT,
  VC_BOT_MEETING_INVITED_EVENT,
  VC_PARTICIPANT_MEETING_JOINED_EVENT,
  type VcMeetingPushEventType,
} from '../../vc-agent/push-source.js';
import type { VcMeetingPushContext, VcMeetingPushEventKind } from '../../vc-agent/types.js';
import type { VcMeetingImTurnOrigin } from '../../types.js';

// 大厅回执互教的防环闸：每进程对同一打卡者只回一次（见 hall swallow 分支）。
const hallEchoReplied = new Set<string>();

function vcMeetingEventPayloadForLog(data: any): string {
  try {
    return JSON.stringify(data?.event ?? data);
  } catch (err) {
    return `[unserializable:${err instanceof Error ? err.message : String(err)}]`;
  }
}

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

/**
 * Try to auto-fix missing scopes using the same Open Platform web-session
 * automation that powers `botmux setup`. If ~/.botmux/feishu-session.json holds
 * a valid cached session, this adds all botmux-required scopes and publishes
 * a new app version — no user interaction needed.
 *
 * Returns `true` if scopes were successfully applied (caller should stop),
 * `false` to fall through to the manual DM warning.
 */
async function tryAutoFixScopes(
  larkAppId: string,
  bot: BotState,
  brand: Brand,
  missingCritical: { name: string; desc: string }[],
  missingOptional: { name: string; desc: string }[],
): Promise<boolean> {
  if (brand !== 'feishu') return false;

  try {
    logger.info(`[${larkAppId}] attempting auto-fix for ${missingCritical.length} missing scopes via Open Platform...`);
    const result = await automateOpenPlatformSetup({
      appId: bot.config.larkAppId,
      brand,
      maxWaitMs: 60_000,
      onStatus: (msg) => logger.info(`[${larkAppId}] auto-fix: ${msg}`),
      onQrCode: (info) => {
        logger.warn(
          `[${larkAppId}] auto-fix: cached Feishu web session expired, QR login needed. ` +
          `Run \`botmux setup\` to refresh session, or manually apply scopes from deep links below. ` +
          `QR text (first 80 chars): ${info.qrText.substring(0, 80)}...`,
        );
      },
    });

    if (result.ok) {
      const scopeDetail = result.scopeCount > 0
        ? `${result.scopeCount} 项权限已导入${result.skippedScopeCount > 0 ? `（${result.skippedScopeCount} 项跳过）` : ''}`
        : '所有必需权限已在应用清单中';
      logger.info(
        `[${larkAppId}] auto-fix succeeded: ${scopeDetail}, ` +
        `version ${result.versionId ?? 'n/a'} published, ` +
        `${result.subscribedEventCount} events subscribed`,
      );
      // Notify admin that auto-fix worked — even if im:message was missing before,
      // the newly published version should now have it.
      const adminOpenId = getAdminOpenId(bot);
      if (adminOpenId) {
        const missingList = missingCritical.map(s => `• ${s.desc} (\`${s.name}\`)`).join('\n');
        const optionalNote = missingOptional.length > 0
          ? `\n\n另有 ${missingOptional.length} 项可选权限未开通：${missingOptional.map(s => s.name).join('、')}`
          : '';
        await dmAdmin(
          larkAppId,
          adminOpenId,
          `✅ botmux 已自动为机器人 "${bot.botName ?? larkAppId}" 修复了缺失的权限：\n\n${missingList}\n\n` +
          `${scopeDetail}，新版本已发布。\n` +
          `权限变更可能需要 1-2 分钟生效。如仍有问题执行 \`botmux restart\`。${optionalNote}`,
          `auto-fixed ${missingCritical.length} scopes`,
        );
      }
      return true;
    }

    // Auto-fix failed — log reason and fall through to manual DM.
    const reasons: Record<string, string> = {
      missing_session: '无可用的 Feishu Web session',
      invalid_session: 'Web session 已失效',
      login_failed: 'Web session 登录失败',
      qr_expired: '需要扫码但二维码已过期',
      timeout: '等待扫码超时',
      unsupported_brand: '仅支持 feishu.cn 租户',
      network: '网络错误',
      missing_csrf: '开放平台页面未返回 CSRF token',
      scope_mapping_failed: '权限映射失败',
      api_error: '开放平台 API 错误',
    };
    logger.warn(
      `[${larkAppId}] auto-fix not possible (${result.reason}: ${reasons[result.reason] ?? result.message}). ` +
      `Falling back to manual deep-link DM.`,
    );
    return false;
  } catch (err: any) {
    logger.warn(`[${larkAppId}] auto-fix error: ${err?.message ?? err} — falling back to manual DM`);
    return false;
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
      // Chicken-and-egg: app lacks self_manage so we can't even check what scopes
      // are missing. Try the Open Platform web-session auto-fix to add ALL
      // required scopes (including self_manage) in one shot.
      if (brand === 'feishu') {
        const fixed = await tryAutoFixScopes(larkAppId, bot, brand,
          [{ name: SELF_MANAGE_SCOPE, desc: '应用自查 (免审批)' }], []);
        if (fixed) return;
      }
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
        const hasWatch = docSubs.some(s => s.managedBy === 'watch-comment');
        // Historical records have no managedBy and belong to the legacy
        // /subscribe-lark-doc flow, which still needs every OAuth/subscribe scope.
        const hasApiSubscribe = docSubs.some(s => s.managedBy !== 'watch-comment');
        const requiredDocScopes = [
          ...(hasWatch ? DOC_WATCH_SCOPES : []),
          ...(hasApiSubscribe ? DOC_FEATURE_SCOPES : []),
        ].filter((scope, index, all) => all.findIndex(s => s.name === scope.name) === index);
        const missingDoc = requiredDocScopes.filter(s => !grantedScopes.has(s.name));
        const featureLabel = [
          hasWatch ? '/watch-comment' : '',
          hasApiSubscribe ? '/subscribe-lark-doc' : '',
        ].filter(Boolean).join(' + ');
        if (missingDoc.length > 0) {
          const summary = missingDoc.map(s => `${s.name}(${s.desc})`).join('、');
          logger.error(`[${larkAppId}] ${featureLabel} 已在用（${docSubs.length} 个绑定）但缺 ${missingDoc.length} 项文档权限：${summary}。评论将收不到/回不了，请到权限管理开通后 botmux restart。`);
          const adminDoc = getAdminOpenId(bot);
          if (adminDoc) {
            const lines = missingDoc.map((s, i) => `${i + 1}. **${s.desc}** (\`${s.name}\`)\n   ${buildScopeDeepLink(bot.config.larkAppId, s.name, brand)}`).join('\n\n');
            await dmAdmin(larkAppId, adminDoc,
              `⚠️ 机器人 "${bot.botName ?? larkAppId}" 已通过 ${featureLabel} 绑定 ${docSubs.length} 个飞书文档，但缺少对应权限：\n\n${lines}\n\n` +
              `另外请确认开发者后台「事件订阅」里已添加 **\`${DOC_COMMENT_EVENT}\`**（云文档新增评论）事件——该事件无法被自动检测，缺它则评论永远收不到。\n\n开通 + 订阅事件后执行 \`botmux restart\`。`,
              `missing doc-feature scopes: ${missingDoc.map(s => s.name).join(',')}`);
          }
        } else {
          // 权限齐了——事件订阅查不了，仅 info 记一条提醒（不 DM 免重启刷屏）。
          logger.info(`[${larkAppId}] ${featureLabel} 文档权限齐全（${docSubs.length} 绑定）；请确保后台已订阅事件 ${DOC_COMMENT_EVENT}（无法自动检测）`);
        }
      }
    } catch (err: any) {
      logger.debug(`[${larkAppId}] doc-feature readiness check errored: ${err?.message ?? err}`);
    }

    // VC meeting agent readiness: app scopes can be checked; Open Platform event
    // subscription status cannot be listed via public API, so we surface the
    // exact required event keys as an explicit operator checklist.
    try {
      const globalVcListenerAppId = vcMeetingAgentGlobalListenerBotAppId();
      if (
        isVcMeetingAgentGloballyEnabled()
        && bot.config.vcMeetingAgent?.enabled === true
        && (!globalVcListenerAppId || globalVcListenerAppId === larkAppId)
      ) {
        const requiredVcScopes = bot.config.vcMeetingAgent.realtimeVoice?.enabled === true
          ? [...VC_MEETING_FEATURE_SCOPES, ...VC_MEETING_REALTIME_VOICE_SCOPES]
          : VC_MEETING_FEATURE_SCOPES;
        const missingVc = requiredVcScopes.filter(s => !grantedScopes.has(s.name));
        const eventList = VC_MEETING_BOT_EVENTS.map(e => `\`${e}\``).join('、');
        const eventSubUrl = buildEventSubDeepLink(bot.config.larkAppId, brand);
        if (missingVc.length > 0) {
          const summary = missingVc.map(s => `${s.name}(${s.desc})`).join('、');
          logger.error(
            `[${larkAppId}] vcMeetingAgent 已启用但缺 ${missingVc.length} 项 VC 权限：${summary}。` +
            `会议智能体入会/读事件可能失败。请到权限管理开通，并确认事件订阅页包含 ${VC_MEETING_BOT_EVENTS.join(', ')}。`,
          );
          const adminVc = getAdminOpenId(bot);
          if (adminVc) {
            const lines = missingVc.map((s, i) => `${i + 1}. **${s.desc}** (\`${s.name}\`)\n   ${buildScopeDeepLink(bot.config.larkAppId, s.name, brand)}`).join('\n\n');
            await dmAdmin(larkAppId, adminVc,
              `⚠️ 机器人 "${bot.botName ?? larkAppId}" 已启用 \`vcMeetingAgent\`，但缺少会议智能体所需权限：\n\n${lines}\n\n` +
              `另外请确认开发者后台「事件订阅」里已添加这 3 个事件：${eventList}\n\n` +
              `事件订阅页：${eventSubUrl}\n\n` +
              `注意：飞书目前没有公开 API 可自动确认这 3 个事件是否已订阅/发布；缺事件时 daemon 只会收不到 push，不会有运行时错误。开通 + 发布后执行 \`botmux restart\`。`,
              `missing vc-meeting scopes: ${missingVc.map(s => s.name).join(',')}`);
          }
        } else {
          logger.info(
            `[${larkAppId}] vcMeetingAgent VC 权限齐全；请确保后台事件订阅页已添加 ${VC_MEETING_BOT_EVENTS.join(', ')} ` +
            `并已发布（无法自动检测）：${eventSubUrl}`,
          );
        }
      }
    } catch (err: any) {
      logger.debug(`[${larkAppId}] vc-meeting readiness check errored: ${err?.message ?? err}`);
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

    // Auto-fix: try the same Open Platform automation used by `botmux setup`.
    // If a cached Feishu web session exists (~/.botmux/feishu-session.json), we can
    // directly add missing scopes and publish a new version without user interaction.
    // Falls through to manual DM warning if session is missing/expired.
    const autoFixed = await tryAutoFixScopes(larkAppId, bot, brand, missingCritical, missingOptional);
    if (autoFixed) return;

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

// `claim` defaults to the in-memory event-id claim; the message path passes a
// persistent message_id claim (claimMessageOnce) so a daemon restart or the 6h
// re-push tier can't replay an already-handled message. The claim MUST be fully
// synchronous (see INVARIANT below) — both claimEventOnce and claimMessageOnce are.
function scheduleAckSafeEvent(key: string, work: () => Promise<void>, label: string, claim: () => boolean = () => claimEventOnce(key)): void {
  if (!claim()) {
    logger.info(`[event-dedupe] duplicate ${label} ignored: ${key}`);
    return;
  }
  // INVARIANT: the claim above + this setImmediate scheduling must stay fully
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
    // Detail actions can share action labels across rows; include row ids so
    // rapid clicks on different rows do not collide in the in-flight dedupe key.
    scheduleId: value?.schedule_id,
    runId: value?.run_id,
    nonce: value?.card_nonce ?? value?.nonce,
    option: action?.option,
    key: value?.key,
    // Settings toggles share one action; distinguish the target field/value.
    field: value?.field,
    next_value: value?.next_value,
    // Pagination actions share one action; distinguish the target page.
    page: value?.page,
    // Navigation context and page size affect the card that will be rebuilt.
    origin: value?.origin,
    pageSize: value?.page_size,
    // `dashboard_scope` distinguishes the global tool-panel card from a
    // per-bot view that might happen to be open on the same module. Without
    // it a rapid global→per-bot click sequence within the dedupe window
    // would hash-collide and the second click would be silently dropped.
    dashboardScope: value?.dashboard_scope,
    // Groups detail/actions can share the same `dash_groups_*` action within
    // one card but target different chat/bot cells. Include both ids so
    // managing bot A in group X doesn't dedupe bot B in group Y.
    chatId: value?.chat_id,
    appId: value?.app_id,
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
  // The message path now dedupes via the persistent seen-message store; clear its
  // in-memory cache too so cases reusing the same message_id don't suppress each other.
  _resetSeenMessagesForTest();
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

/**
 * Should a FOREIGN bot sender be trusted to collaborate (route/spawn a session)
 * WITHOUT `/grant`, because it's a teammate? Two trust sources, both rooted in
 * tenant-stable identity or team-controlled group membership — never a name:
 *
 *  1. **Learned teammate** — its `union_id` (from the inbound event's
 *     `sender.sender_id.union_id`) is in the team-bot store, i.e. we've seen it
 *     vouched inside a team-assembled group before. Honoured in ANY chat.
 *  2. **Team-assembled group** — the chat itself is a 拉群 group (team-controlled
 *     membership), so a botmux bot speaking there is a vouched teammate even on
 *     first contact (mirrors the existing oncall-chat exemption).
 *
 * `isKnownPeerBot` (same-deployment siblings) is checked separately by callers;
 * this covers cross-deployment TEAM peers. Returns false when neither holds, so
 * the caller falls back to the /grant request card.
 *
 * 平台团队与旧版联邦团队同权：isPlatformTeamBot（平台 team-sync 下发的团队 bot
 * union_id roster）与 isTeamBot（团队群里学来的 union_id）都是 union_id 锚定的
 * bot 专属信任；平台拉的团队群则经 platform: 前缀镜像进 team-groups，走同一个
 * isTeamGroupChat。两条路都算团队模式，都不需要 /grant。
 */
export function isTrustedTeamBotSender(
  dataDir: string,
  chatId: string | undefined,
  senderUnionId: string | undefined,
): boolean {
  return isTeamBot(dataDir, senderUnionId)
    || isPlatformTeamBot(dataDir, senderUnionId)
    || isTeamGroupChat(dataDir, chatId);
}

/** Update the per-bot cross-reference from @mention data in an event.
 *  mentionsList comes from Lark event message.mentions array. */
export function updateBotOpenIdCrossRef(
  dataDir: string,
  larkAppId: string,
  mentionsList: Array<{ name?: string; id?: { open_id?: string } | string; id_type?: string }>,
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
    const openId = mentionOpenId(m);
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
  const rawMentions: Array<{ name?: string; id?: { open_id?: string } | string; id_type?: string }> = message.mentions ?? [];
  const all = rawMentions
    .map(m => ({ openId: mentionOpenId(m) ?? '', name: m.name ?? '' }))
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

/** One-shot guard so the mention-shape early-warning logs at most once per
 *  process instead of flooding once Lark converges the shapes (see below). */
let warnedStringMentionShape = false;

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

  // 1. Check message.mentions array (populated for user-sent text messages).
  //    mentionOpenId() tolerates both the WS event object shape and the REST
  //    string shape, so a Lark mention-shape change can't silently break
  //    @-detection (which would make the bot ignore every @ with no error).
  const mentions: any[] = message.mentions ?? [];
  // Early-warning: today's WS events carry mention.id as an object; the REST
  // API carries a bare string. A string-form id on the event path means Lark
  // has converged the event onto the REST shape — surface it (once) so a silent
  // @-routing regression announces itself even though mentionOpenId absorbs it.
  if (!warnedStringMentionShape && mentions.some((m: any) => typeof m?.id === 'string')) {
    warnedStringMentionShape = true;
    logger.warn(`[${larkAppId}] mention.id arrived in string form on the event path — Lark may have converged the WS event onto the REST shape. mentionOpenId() absorbs it, but verify group @-routing. (logged once per process)`);
  }
  if (mentions.some((m: any) => mentionMatchesBot(m, larkAppId, botOpenId))) {
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

/** Does this message @mention a *specific other member* (a person or bot that
 *  is NOT this bot)? Used by the 'ambient' mention policy to decide whether to
 *  back off: under 'ambient' the bot answers un-@ messages, but if the user
 *  explicitly addresses SOMEONE ELSE it stays quiet (the redirect carve-out).
 *  `@all` addresses everyone including this bot, so it is NOT an "other member"
 *  and does NOT trigger backoff. Mirrors isBotMentioned's two shapes:
 *  message.mentions[] (user text) and inline `at` nodes in post content. */
export function mentionsAnotherMember(larkAppId: string, message: any): boolean {
  const botOpenId = getBot(larkAppId).botOpenId;

  // 1. message.mentions array (populated for user-sent text messages)
  const mentions: any[] = message.mentions ?? [];
  for (const m of mentions) {
    // mentionOpenId() tolerates both the WS event object shape ({ open_id }) and
    // the REST bare-string shape. Bot mentions may also arrive as app_id
    // (id_type='app_id' / { app_id }) with no open_id; isBotMentioned handles
    // that shape via mentionMatchesBot(), so the redirect/yield check must too.
    const oid = mentionOpenId(m);
    if (oid) {
      if (oid === botOpenId) continue; // that's me
      if (oid === 'all') continue;     // @all → everyone incl. me
      return true;                     // a specific other member
    }
    const appId = mentionAppId(m);
    if (appId) {
      if (appId === larkAppId) continue; // that's me, addressed by app_id
      if (appId === 'all') continue;
      return true;                       // another bot addressed by app_id
    }
  }

  // 2. inline `at` nodes in post content (bot-sent / rich messages)
  try {
    const content = JSON.parse(message.content ?? '{}');
    const inner = content.zh_cn ?? content.en_us ?? content;
    if (Array.isArray(inner?.content)) {
      for (const paragraph of inner.content) {
        if (!Array.isArray(paragraph)) continue;
        for (const node of paragraph) {
          if (node.tag !== 'at') continue;
          const uid: string | undefined = node.user_id;
          if (!uid || uid === botOpenId || uid === 'all') continue;
          return true;
        }
      }
    }
  } catch { /* ignore parse errors */ }

  return false;
}

function substituteTargetMatchesMention(target: {
  openId?: string;
  userId?: string;
  unionId?: string;
}, mention: MentionIdentity): boolean {
  return Boolean(
    (target.openId && mention.openId === target.openId) ||
    (target.userId && mention.userId === target.userId) ||
    (target.unionId && mention.unionId === target.unionId),
  );
}

export function resolveSubstituteTrigger(
  larkAppId: string,
  message: any,
): import('../../types.js').SubstituteTrigger | undefined {
  const cfg = getBot(larkAppId).config.substituteMode;
  if (!cfg?.enabled || !cfg.targets?.length) return undefined;
  const mentions = extractMentionIdentities(message);
  for (const mention of mentions) {
    const target = cfg.targets.find(t => substituteTargetMatchesMention(t, mention));
    if (!target) continue;
    return {
      target: {
        name: target.name,
        openId: target.openId,
        userId: target.userId,
        unionId: target.unionId,
      },
      observedMention: {
        name: mention.name,
        openId: mention.openId,
        userId: mention.userId,
        unionId: mention.unionId,
      },
      disclosure: cfg.disclosure ?? 'prefix',
    };
  }
  return undefined;
}

function mentionMatchesBot(m: any, larkAppId: string, botOpenId?: string): boolean {
  const openId = mentionOpenId(m);
  if (botOpenId && openId === botOpenId) return true;

  // Some Lark event payloads identify bot mentions by app_id:
  //   { id_type: "app_id", id: "cli_xxx" }
  // Treat that as an explicit mention of this daemon, but do not let app_id
  // flow through mentionOpenId(), which is persisted and used as an open_id.
  const appId = mentionAppId(m);
  return Boolean(larkAppId && appId === larkAppId);
}

function mentionIdType(m: any): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  if (typeof m.id_type === 'string') return m.id_type;
  if (typeof m.idType === 'string') return m.idType;
  return undefined;
}

function mentionAppId(m: any): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  if (typeof m.appId === 'string') return m.appId;
  if (typeof m.app_id === 'string') return m.app_id;
  const idType = mentionIdType(m);
  if (idType === 'app_id' && typeof m.id === 'string') return m.id;
  if (m.id && typeof m.id === 'object' && typeof m.id.app_id === 'string') return m.id.app_id;
  return undefined;
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
  | 'teamBot'
  | 'teamMember'
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

export function canTalk(
  larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined,
  senderUnionId?: string, memberUnionId?: string,
): boolean {
  return evaluateTalk(larkAppId, chatId, senderOpenId, senderUnionId, memberUnionId).allowed;
}

/**
 * @param senderUnionId  BOT-trust union（teamBot 腿）——调用方必须已按 sender_type
 *   锁定为「飞书盖章的 bot 发送方」（daemon 的 teamTrustUnionId），否则恶意成员把
 *   真人 union 报成 bot 就能让真人继承 bot 信任。
 * @param memberUnionId  发送方 union（teamMember 腿）——可为真人 union（未锁 bot）。
 *   仅授 chat 作用域内的 talk、不授 operate，且要求 union 在该团队的成员名单里
 *   （memberUnionIds 来自平台鉴权的团队成员，非机器自报），故喂真人 union 是安全的。
 */
export function evaluateTalk(
  larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined,
  senderUnionId?: string, memberUnionId?: string,
): TalkEvaluation {
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
  // 跨部署团队 peer bot（旧版联邦学来的 union_id / 平台 roster 下发的 union_id）——
  // 与 isKnownPeerBot 兄弟 bot 对等的 talk 放行。没有这一腿，外部 bot 闸门
  //（isTrustedTeamBotSender）放进来的团队 bot 消息会在 enforceMessageQuotaForCliInput
  // 的 evaluateTalk 复查处被静默丢弃（受限 bot 上 #332 的端到端断点）。仅认租户
  // 稳定 union_id（bot 专属，人不会进这两张表），不看 chatId，不授 operate。
  if (senderUnionId && (isTeamBot(config.session.dataDir, senderUnionId) || isPlatformTeamBot(config.session.dataDir, senderUnionId))) {
    return { allowed: true, reason: 'teamBot' };
  }
  // 平台团队成员（人）：发送者 union_id 是本群所属平台团队的成员 → talk 免 grant。
  // 严格 chat 作用域（isPlatformTeamMemberChat 要求成员与群在同一团队），只放 talk：
  // canOperate 不引这一腿，/restart 等仍限 allowedUsers。授权用户在团队群里 @ bot 即免卡。
  if (memberUnionId && isPlatformTeamMemberChat(config.session.dataDir, chatId, memberUnionId)) {
    return { allowed: true, reason: 'teamMember' };
  }
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

export function canOperate(
  larkAppId: string,
  _chatId: string | undefined,
  senderOpenId: string | undefined,
  senderUnionId?: string | undefined,
): boolean {
  const bot = getBot(larkAppId);
  // L1 同部署兄弟 bot 互信 operate：与 canTalk 一致——isKnownPeerBot 只认本部署
  // bots-info.json 里注册过的自家 bot。这不重开 PR #46 的封堵：人的 talk 授权
  // （chatGrant/globalGrant）仍不漏成 operate；这里只放行「自家 bot 之间」的 /
  // 命令（让编排者能对子 bot 跑 /repo /cd 等）。
  if (isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)) return true;
  // L2 跨部署「团队 peer bot」互信 operate（与 L1 兄弟 bot 对等，覆盖编排者给
  // 队友派 /repo /cd 等）。**只认租户稳定的 union_id**（isTeamBot / 平台 roster），
  // 不走 isTrustedTeamBotSender 的「团队群成员」分支——那条按 chat 放行是 sender
  // 无关的，会把「团队群里的真人」也误放进 operate，破坏 allowedUsers 边界。union_id
  // 是发送方专属、且必须先被团队背书（团队群学习 / 平台 roster）才进表，人不会命中。
  if (isTeamBot(config.session.dataDir, senderUnionId)) return true;
  if (isPlatformTeamBot(config.session.dataDir, senderUnionId)) return true;
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
  if (getBot(larkAppId).config.autoGrantRequestCards === false) return;
  const owner = getOwnerOpenId(larkAppId);
  if (!owner || !requesterOpenId) return;
  if (isThrottled(larkAppId, chatId, requesterOpenId)) return;
  // 名字优先级：本消息 mentions（真人发送方、被 @ 目标都在此）→ observed-bots 花名册
  // （/introduce 登记过的 (open_id,name)）→ 裸 open_id 兜底。外部 bot 发送方不在自己
  // 消息的 mentions 里（那是 @ 目标），只靠 mentions 会让 owner 只看到 open_id。
  const mentionName = (message?.mentions ?? []).find((m: any) => mentionOpenId(m) === requesterOpenId)?.name;
  const observedName = mentionName
    ? undefined
    : listObservedBots(config.session.dataDir, larkAppId, chatId).find(b => b.openId === requesterOpenId)?.name;
  const name = mentionName ?? observedName ?? requesterOpenId;
  const nonce = openPending(larkAppId, chatId, requesterOpenId, getBot(larkAppId).config.messageQuota?.defaultLimit);
  const card = buildGrantCard(
    { ownerOpenId: owner, targets: [{ openId: requesterOpenId, name: String(name) }], chatId, nonce, mode: 'request' },
    localeForBot(larkAppId),
  );
  await replyMessage(larkAppId, message.message_id, card, 'interactive')
    .catch(err => {
      // 发卡失败必须撤掉刚开的 pending，否则该发送方被节流压死、owner 永远看不到卡片，
      // 只能等 daemon 重启或别的 target 触发全表 prune 才恢复。清掉后下次 @ 会重试发卡。
      clearPending(larkAppId, chatId, requesterOpenId);
      logger.debug(`grant request card send failed: ${err}`);
    });
}

// ─── Group message access check ──────────────────────────────────────────

/**
 * Check group message addressing:
 * - 'allowed'     -> sender is allowed, bot was @mentioned or solo group
 * - 'not_allowed' -> bot was @mentioned but sender is not in allowlist
 * - 'ignore'      -> not addressed to bot at all
 */
export async function checkGroupMessageAccess(
  larkAppId: string, message: any, chatId: string, senderOpenId: string | undefined, memberUnionId?: string,
): Promise<'allowed' | 'not_allowed' | 'ignore'> {
  const mentioned = isBotMentioned(larkAppId, message, senderOpenId);
  // 群消息访问检查只在人路径调用，union 走 memberUnionId 腿（不进 bot-trust）。
  const isAllowed = canTalk(larkAppId, chatId, senderOpenId, undefined, memberUnionId);

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
   *  it's the seed of a brand-new thread). A beforeSessionTurn hook may
   *  replace it with a daemon-owned synthetic anchor for a dedicated receiver
   *  session; the visible chatId/scope remain unchanged. */
  anchor: string;
  /** Chat-scope shared-topic reply target for this turn, if any. */
  replyRootId?: string;
  /** Command prompt that should be sent to the CLI instead of raw text. */
  promptOverride?: string;
  /** Durable VC routing succeeded but the bounded pre-turn catch-up did not.
   * Prompt builders must surface this instead of pretending context is fresh. */
  vcMeetingContextMayLag?: boolean;
  /** The receiver belongs to an ended meeting whose final delivery is sealed.
   * Explicit human follow-ups still reuse that transcript, but meeting-side
   * effects remain closed. */
  vcMeetingContextLifecycle?: 'active' | 'sealed';
  /** Daemon-derived authority snapshot for an explicit human IM turn routed
   * into one dedicated meeting receiver. Never populated from message text. */
  vcMeetingImTurnOrigin?: VcMeetingImTurnOrigin;
  /** Metadata for the summary command that produced promptOverride. */
  summaryCommand?: SummaryCommandRuntimeContext;
  /** This turn was triggered by @mentioning a configured substitute person. */
  substituteTrigger?: import('../../types.js').SubstituteTrigger;
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
  /** 文档评论入口（/watch-comment / /subscribe-lark-doc）：一条命中文档绑定的评论被喂进
   *  会话。daemon 负责定位会话、投递给 worker、记录该轮回评论的落点。 */
  handleDocComment?: (ctx: DocCommentContext) => Promise<boolean>;
  /** VC bot meeting push events (`vc.bot.meeting_*_v1`). ACK-safe; daemon owns meeting session state. */
  handleVcMeetingPush?: (ctx: VcMeetingPushContext) => Promise<void>;
  /** Best-effort hook before a human inbound turn reaches the CLI session. Used
   *  by VC meeting listener groups to catch up pending meeting context before a
   *  user asks the selected agent a follow-up question. */
  beforeSessionTurn?: (
    data: any,
    ctx: RoutingContext,
    meta: { senderOpenId?: string; explicitlyMentionedThisBot: boolean },
  ) => Promise<void | { anchorOverride?: string; block?: boolean }>;
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
  /** 局部评论选中的文档原文。 */
  selectedText?: string;
  /** 触发回复之前，该评论串已有的讨论。 */
  priorReplies?: Array<{ authorOpenId?: string; text: string }>;
  /** 是否为整篇文档的全文评论。 */
  isWhole?: boolean;
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
  // Seeding a shared topic normally needs an @mention. But the 'never' and
  // 'ambient' mention policies answer non-@ messages too — and in shared mode it
  // must still OPEN a topic (reply in a thread reusing the chat session), not
  // fall back to a flat top-level reply. So allow non-@ seeding under 'never'
  // (unconditional) or 'ambient' — but for 'ambient' NOT when the message
  // @mentions another specific member (person/bot) without @ing us: that is a
  // redirect to someone else, so we back off (mentionsAnotherMember).
  const seedMentionMode = resolveGroupMentionMode(larkAppId);
  if (!isBotMentioned(larkAppId, message, senderOpenId)
      && !(seedMentionMode === 'never'
        || (seedMentionMode === 'ambient' && !mentionsAnotherMember(larkAppId, message)))) return undefined;
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
  // chat-scope session. `new-topic` and `chat-topic` are the modes that
  // intentionally keep per-topic independent sessions — they must NOT fold:
  // new-topic forks every top-level @ too, while chat-topic keeps top level
  // flat but lets each native Lark topic run its own session.
  const mode = resolveRegularGroupMode(larkAppId, chatId);
  if (mode === 'new-topic' || mode === 'chat-topic') return undefined;
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
  // Only `new-topic` forks a fresh thread-scope session for a TOP-LEVEL @.
  // `shared` stays chat-scope here (the topic fold happens post-routing, see
  // maybeApplySharedTopicSeed); `chat` is the flat default; `chat-topic` is also
  // flat at top level (it only diverges for native topics, where the fold is
  // skipped — see maybeFoldMentionedRegularGroupThreadToChat). resolveRegularGroupMode
  // is the single decision point so the modes never both fire.
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

async function classifySummaryChatKind(input: {
  larkAppId: string;
  chatId: string;
  routingSource: RoutingSource;
}): Promise<SummaryChatKind | undefined> {
  if (input.routingSource === 'topic-chat') return 'topic';
  if (input.routingSource === 'regular-group-chat' || input.routingSource === 'regular-group-thread') return 'regularGroup';
  // Real thread replies can occur in topic groups and in regular groups that
  // use threaded replies. Ask Lark for the current chat mode only for explicit
  // /summary so normal routing does not pay this extra lookup.
  if (input.routingSource === 'real-thread') {
    const mode = await getChatMode(input.larkAppId, input.chatId, { forceRefresh: true });
    return mode === 'topic' ? 'topic' : 'regularGroup';
  }
  return undefined;
}

const SUMMARY_COMMAND_RE = /^\/summary(?:\s|$)/i;

function summaryCommandText(message: any): string | undefined {
  const text = extractMessageTextForRouting(message);
  if (!text) return undefined;
  const stripped = stripLeadingMentions(text.trim(), message?.mentions ?? []).trim();
  return SUMMARY_COMMAND_RE.test(stripped) ? stripped : undefined;
}

async function resolveSummaryCommandMatch(input: {
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  routingSource: RoutingSource;
  message: any;
  senderOpenId: string | undefined;
}): Promise<SummaryCommandMatch | undefined> {
  if (input.chatType !== 'group') return undefined;
  if (!isBotMentioned(input.larkAppId, input.message, input.senderOpenId)) return undefined;
  const triggerText = summaryCommandText(input.message);
  if (!triggerText) return undefined;
  const chatKind = await classifySummaryChatKind(input);
  if (!chatKind) return undefined;
  return {
    chatKind,
    triggerText,
    range: summaryRangeFromBotConfig(getBot(input.larkAppId).config),
    prompt: DEFAULT_SUMMARY_PROMPT,
  };
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

function handleVcMeetingPushEventAckSafe(
  data: any,
  larkAppId: string,
  handlers: EventHandlers,
  kind: VcMeetingPushEventKind,
  eventType: VcMeetingPushEventType,
): void {
  const parsed = parseVcMeetingPushEvent({ data, larkAppId, kind, eventType });
  const eventKey = `${eventType}:${larkAppId}:${parsed.eventId ?? unkeyableEventKey()}`;
  scheduleAckSafeEvent(eventKey, async () => {
    if (!handlers.handleVcMeetingPush) {
      logger.info(`[vc-agent] ${eventType} ignored: daemon has no VC meeting handler`);
      return;
    }
    await handlers.handleVcMeetingPush(parsed);
  }, `vc-meeting ${kind} event`);
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

  // 1) 查订阅表；未订阅的文档 @bot 时自动创建 mention-only 订阅（任何人都可以
  //    通过在文档里 @bot 触发 bot 回复，不需要 owner 预先订阅。/watch-comment 命令
  //    管理持久订阅才需要 owner 权限）。
  //    注意：auto-sub 先创建占位，但如果后续审计硬门失败会回滚（非 owner 触发
  //    且通知 owner 失败时不允许留下订阅记录）。
  let sub = getDocSubscription(config.session.dataDir, larkAppId, fileToken);
  let autoCreatedSub = false;
  if (!sub) {
    const operatorOpenId = parsed.operatorOpenId;
    const botCfg = getBot(larkAppId).config;
    const mappedDir = botCfg.docRepoMap?.[fileToken];
    const autoSub: DocSubscription = {
      fileToken,
      fileType: parsed.fileType || 'docx',
      sessionAnchor: `doc:${fileToken}`,
      sessionId: undefined,
      scope: 'chat',
      chatId: `doc:${fileToken}`,
      commentTriggerMode: 'mention-only',
      managedBy: 'watch-comment',
      ownerOpenId: operatorOpenId || getOwnerOpenId(larkAppId),
      workingDir: mappedDir,
      createdAt: Date.now(),
    };
    putDocSubscription(config.session.dataDir, larkAppId, autoSub);
    sub = autoSub;
    autoCreatedSub = true;
    logger.info(`[doc-comment] auto-subscribed file=${fileToken.slice(0, 12)} by @mention (mention-only${mappedDir ? `, wd=${mappedDir}` : ''}, anchor=doc:${fileToken.slice(0, 12)}, requester=${operatorOpenId?.slice(0, 12) || '?'})`);
  }

  // 关掉 open_id 启动竞态：probeBotOpenId 在启动时 fire-and-forget，若评论事件
  // 在该窗口内到达，下面 mention-only 闸 / 自触发过滤会拿到 undefined 的 botOpenId
  // → 合法的 @bot 评论被误丢（事件已被 ACK，飞书不会重投，@ 永久丢失）。await
  // 去重后的探针把 open_id 补齐；探针失败则降级（心跳会重试）。
  await ensureBotOpenId(larkAppId).catch(() => { /* degrade; heartbeat retries */ });

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
  const triggerIndex = Math.max(0, comment.replies.indexOf(trigger));

  // 3) 自触发过滤（防死循环）：bot 的回复可能以应用身份（作者=bot open_id）或回退
  //    用户身份（作者=授权用户，无法靠作者区分）发出。三重保险：①作者==本 bot
  //    ②reply_id 在 bot 创建集合 ③文本含隐形哨兵。任一命中即跳过。
  const selfBotOpenId = getBot(larkAppId).botOpenId;
  if ((selfBotOpenId && trigger.userId === selfBotOpenId) || isBotAuthoredReply(trigger.replyId) || hasBotSentinel(trigger.text)) return;

  // 4) 触发范围闸（mention-only 仅当评论真的 @ 了本 bot 才触发）。
  //    ⚠️ 必须以拉到的评论正文 @person(open_id) 列表为准，不能信事件自带的
  //    `is_mentioned`——它表示「评论里存在任意 @」，@ 别人时也是 true，曾导致
  //    「@ 同事的评论也被误触发」。详见 commentTriggerAllowed 注释。
  if (!commentTriggerAllowed(sub.commentTriggerMode, trigger.mentions, selfBotOpenId)) {
    logger.info(`[doc-comment] event dropped: mention-only 但未 @ 本 bot (comment=${commentId.slice(0, 12)} isMentioned=${parsed.isMentioned} mentions=${trigger.mentions.length} self=${selfBotOpenId ? selfBotOpenId.slice(0, 10) : '?'})`);
    return;
  }

  const text = trigger.text.trim();
  if (!text) return;

  // 审计硬门：非 owner @bot 触发时，必须成功通知 owner 才允许回复。
  // 通知失败 = owner 无法感知 = 越权，直接拒绝响应并回滚 auto-sub。
  // （owner 自己触发的不通知，直接放行。）
  const ownerOpenId = getOwnerOpenId(larkAppId);
  const requesterOpenId = parsed.operatorOpenId;
  const isOwnerTrigger = ownerOpenId && requesterOpenId && requesterOpenId === ownerOpenId;
  if (!isOwnerTrigger) {
    const rollbackAutoSub = () => { if (autoCreatedSub) removeDocSubscription(config.session.dataDir, larkAppId, fileToken); };
    if (!ownerOpenId) {
      logger.warn(`[doc-comment] non-owner @mention but no ownerOpenId configured — rejecting (audit gate) file=${fileToken.slice(0, 12)} requester=${requesterOpenId?.slice(0, 12) || '?'}`);
      rollbackAutoSub();
      return;
    }
    try {
      const loc = localeForBot(larkAppId);
      const requesterName = requesterOpenId?.slice(0, 12) || '?';
      const notifyText = [
        t('daemon.doc_mention_notify_title', undefined, loc),
        '',
        t('daemon.doc_mention_notify_body', { requester: requesterName, token: fileToken.slice(0, 12) }, loc),
        '',
        `📄 \`${fileToken}\``,
        `💬 ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`,
      ].join('\n');
      await sendUserMessage(larkAppId, ownerOpenId, notifyText);
    } catch (e) {
      logger.warn(`[doc-comment] non-owner @mention but owner notification failed — rejecting (audit gate) file=${fileToken.slice(0, 12)} requester=${requesterOpenId?.slice(0, 12) || '?'} err=${e instanceof Error ? e.message : String(e)}`);
      rollbackAutoSub();
      return;
    }
  }

  logger.info(`[doc-comment] dispatch file=${fileToken.slice(0, 12)} comment=${commentId.slice(0, 12)} mode=${sub.commentTriggerMode} → session anchor=${sub.sessionAnchor.slice(0, 12)}`);
  await handlers.handleDocComment({
    larkAppId,
    sub,
    commentId,
    replyId: trigger.replyId || commentId,
    text,
    selectedText: comment.quote,
    priorReplies: comment.replies.slice(0, triggerIndex).map(reply => ({
      authorOpenId: reply.userId,
      text: reply.text.replaceAll(BOT_REPLY_SENTINEL, '').trim(),
    })).filter(reply => reply.text.length > 0),
    isWhole: comment.isWhole,
    authorOpenId: trigger.userId,
  });
}

const LARK_WS_PROXY_ENV_KEYS = [
  'npm_config_https_proxy',
  'NPM_CONFIG_HTTPS_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'npm_config_proxy',
  'NPM_CONFIG_PROXY',
  'all_proxy',
  'ALL_PROXY',
] as const;

function createLarkWsAgent(): ProxyAgent | undefined {
  const hasSecureProxy = LARK_WS_PROXY_ENV_KEYS.some(key => process.env[key]?.trim());
  if (!hasSecureProxy) return undefined;

  const agent = new ProxyAgent();
  const resolveEnvProxy = agent.getProxyForUrl;
  agent.getProxyForUrl = (url, req) => {
    const target = new URL(url);
    if (target.protocol === 'wss:') target.protocol = 'https:';
    else if (target.protocol === 'ws:') target.protocol = 'http:';
    return resolveEnvProxy(target.href, req);
  };
  return agent;
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
    // 文档评论入口（/watch-comment / /subscribe-lark-doc）。notice 事件主要覆盖 @Bot
    // 通知；旧逐文件订阅还可能收到 file 事件。`/watch-comment --all` 的普通评论由
    // daemon 应用身份轮询补齐，不依赖逐文件 subscribe API。
    'drive.file.comment_add_v1': (data: any) => handleCommentEventAckSafe(data, larkAppId, handlers),
    'drive.notice.comment_add_v1': (data: any) => handleCommentEventAckSafe(data, larkAppId, handlers),
    [VC_BOT_MEETING_INVITED_EVENT]: (data: any) =>
      handleVcMeetingPushEventAckSafe(data, larkAppId, handlers, 'meeting_invited', VC_BOT_MEETING_INVITED_EVENT),
    [VC_BOT_MEETING_ACTIVITY_EVENT]: (data: any) =>
      handleVcMeetingPushEventAckSafe(data, larkAppId, handlers, 'meeting_activity', VC_BOT_MEETING_ACTIVITY_EVENT),
    [VC_BOT_MEETING_ENDED_EVENT]: (data: any) =>
      handleVcMeetingPushEventAckSafe(data, larkAppId, handlers, 'meeting_ended', VC_BOT_MEETING_ENDED_EVENT),
    [VC_PARTICIPANT_MEETING_JOINED_EVENT]: (data: any) =>
      handleVcMeetingPushEventAckSafe(data, larkAppId, handlers, 'participant_meeting_joined', VC_PARTICIPANT_MEETING_JOINED_EVENT),
    'card.action.trigger': (data: any) => handleCardActionAckSafe(data, larkAppId, handlers),
    // 表情回复事件——一旦在开发者后台订阅了 reaction，SDK 每收到一次都会因
    // 没有 handler 打 "no im.message.reaction.created_v1 handle" 警告刷屏。
    // botmux 不消费表情事件，注册显式 no-op 把这条噪声静默掉。
    'im.message.reaction.created_v1': () => {},
    'im.message.reaction.deleted_v1': () => {},
    'im.message.receive_v1': (data: any) => {
      // Dedupe by message_id (stable across re-pushes / event_id re-mints /
      // daemon restarts), persisted so the 6h re-push tier or a restart can't
      // replay an already-handled message. Fall back to the in-memory event-id
      // claim only when message_id is absent (shouldn't happen for real messages).
      const messageIdForKey = data?.message?.message_id;
      const eventKey = `im.message.receive_v1:${larkAppId}:${messageIdForKey ?? eventIdForKey(data) ?? unkeyableEventKey()}`;
      const claim = messageIdForKey
        ? () => claimMessageOnce(larkAppId, messageIdForKey)
        : () => claimEventOnce(eventKey);
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
          // Learn our OWN union_id from any @ of ourselves: Lark stamps every
          // mention with the target's union_id, and mention-driven delivery
          // works even where the self-message echo never arrives（无 receive-all
          // scope 的应用收不到自己发的消息；bot-only 大厅实测完全不推事件）。
          if (recordBotUnionIdFromMentions(config.session.dataDir, larkAppId, getBot(larkAppId).botOpenId, message.mentions)) {
            logger.info(`[${larkAppId}] learned own bot union_id from @mention`);
          }
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
          // Self messages: learn our OWN union_id from the echo first (the only
          // reliable source — see bot-union-ids-store; reported to the platform
          // on heartbeat for the team roster), then only echoed `/close` matters.
          if (isSelfMessage) {
            const selfUnionId = sender.sender_id?.union_id as string | undefined;
            if (selfUnionId && recordBotUnionId(config.session.dataDir, larkAppId, selfUnionId)) {
              logger.info(`[${larkAppId}] learned own bot union_id from self-message echo`);
            }
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
          // Learn teammate identity from team-assembled groups (the trust root):
          // any bot talking in a 拉群 group is a vouched teammate, so capture its
          // tenant-stable union_id — we then honour it as a teammate in ANY chat
          // (see team-bots-store). Done BEFORE the @mention gate so even a non-@
          // message in a team group teaches us the teammate. Cheap + idempotent.
          const senderUnionId = sender.sender_id?.union_id as string | undefined;
          if (senderUnionId && isTeamGroupChat(config.session.dataDir, chatId)) {
            recordTeamBot(config.session.dataDir, { unionId: senderUnionId });
          }
          // 机器人大厅：bot 消息只用于身份登记（上面已学 sender union / mentions
          // 自学 / cross-ref），绝不当任务路由——大厅打卡会点名 @ 同伴，不吞掉的话
          // 接收 bot 会把打卡当任务拉起会话在大厅里回话（实测）。只吞 bot 发送方：
          // 人类经隐藏入口进大厅后 @ bot 仍正常应答。
          if (isPlatformHallChat(config.session.dataDir, chatId)) {
            // 回执互教：打卡者点名了我们且带 #hall-echo（= 它还没学到自己的
            // union_id）→ @ 回它一次。open_id 直接取事件 sender_id（本 app 视角，
            // 无需 cross-ref），打卡者从回执的 mentions[] 学到自己。每进程每发送者
            // 只回一次；回执不带标记，链路必然终止。
            try {
              const text: unknown = JSON.parse(message.content ?? '{}')?.text;
              if (
                typeof text === 'string' && text.includes('#hall-echo') && senderOpenId &&
                isBotMentioned(larkAppId, message, undefined) &&
                !hallEchoReplied.has(`${larkAppId}::${senderOpenId}`)
              ) {
                hallEchoReplied.add(`${larkAppId}::${senderOpenId}`);
                void sendMessage(larkAppId, chatId, `<at user_id="${senderOpenId}"></at> 已登记`, 'text')
                  .then(() => logger.info(`[${larkAppId}] hall echo reply sent to ${senderOpenId.substring(0, 12)}`))
                  .catch((e) => logger.warn(`[${larkAppId}] hall echo reply failed: ${(e as Error).message}`));
              }
            } catch { /* content 非 JSON → 忽略 */ }
            logger.debug(`[${larkAppId}] hall bot message swallowed after learning (chat=${chatId.substring(0, 12)})`);
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
            || isTrustedTeamBotSender(config.session.dataDir, chatId, senderUnionId)
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
          //
          // 团队 bot 免 /grant：isTrustedTeamBotSender 命中（sender 的租户稳定
          // union_id 已学进 team-bots，或本群就是团队拉群组建的协作群）即放行——
          // 与「同部署兄弟 bot」(isKnownPeerBot) 对等，但覆盖跨部署的团队 peer。
          // 这正是「加入团队即免 introduce/grant」的接收闸：身份只认 union_id /
          // 团队群成员，绝不认自报名字（防同名 bot 冒名蹭权）。
          //
          // 开放模式（未配任何 allowlist：allowedUsers / allowedChatGroups /
          // globalGrants 全空）与人侧 evaluateTalk 的 `reason:'open'`（1011 行）对齐：
          // 「谁都能触发」本应人、bot 同权。过去这道 gate 漏了这一腿，导致开放模式下
          // 外部 bot @ 仍被丢弃，必须真人先 @ 一次建 session（ownsSession=true）才救活。
          // 补上 hasConfiguredAllowlist 短路后两条路径统一：一旦配了任一 allowlist，
          // 立刻恢复「限制态」设闸，安全边界不变。
          if ((ctx.scope === 'chat' || decision.source === 'regular-group-thread' || forcedTopic)
              && !findOncallChat(larkAppId, chatId)
              && hasConfiguredAllowlist(getBot(larkAppId))) {
            const ownsSession = handlers.isSessionOwner?.(ctx.anchor, larkAppId) ?? false;
            if (!ownsSession
                && !isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)
                && !isTrustedTeamBotSender(config.session.dataDir, chatId, senderUnionId)
                && !hasChatGrant(larkAppId, chatId, senderOpenId)
                && !hasGlobalGrant(larkAppId, senderOpenId)) {
              await maybeSendGrantRequestCard(larkAppId, message, chatId, senderOpenId);
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
        // 人的 union_id：平台团队成员 talk-免grant 腿（isPlatformTeamMemberChat）要用。
        const humanSenderUnionId = sender?.sender_id?.union_id as string | undefined;
        // defaultOncall 自动绑定必须在 canTalk 权限判断前完成，否则已开 defaultOncall
        // 的群首次 @bot 时 oncallChats 中还没有该 chat → evaluateTalk 判无权限 → 误弹
        // 自助授权申请卡。ensureDefaultOncallBound 本身带 fast-path 短路且 idempotent。
        await ensureDefaultOncallBound(larkAppId, chatId, chatType).catch(err =>
          logger.warn(`[oncall:${larkAppId}] pre-permission auto-bind failed for ${chatId.substring(0, 12)}: ${err}`),
        );
        // 人的路径（bot 发送方已在上面的分支 return）：union 走 memberUnionId 腿，
        // 不进 bot-trust 腿——teamBot 只认 bot-locked union。
        const isAllowed = canTalk(larkAppId, chatId, senderOpenId, undefined, humanSenderUnionId);

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

        if (await tryHandleSubstituteCommand(larkAppId, message, senderOpenId)) {
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
        // Cheap in-memory gate FIRST: skip the getChatMode roundtrip and the
        // per-chat toggle disk read entirely for bots that never configured a
        // substitute target (the overwhelming majority on the hot path).
        let substituteTrigger = getBot(larkAppId).config.substituteMode?.enabled === true
          && chatType === 'group'
          && await getChatMode(larkAppId, chatId) === 'group'
          && isSubstituteEnabledForChat(larkAppId, chatId)
          ? resolveSubstituteTrigger(larkAppId, message)
          : undefined;
        if (substituteTrigger && !explicitlyMentionedThisBot) {
          const rawText = extractMessageTextForRouting(message);
          const stripped = rawText ? stripLeadingMentions(rawText.trim(), message?.mentions ?? []).trim() : '';
          if (stripped.startsWith('/')) substituteTrigger = undefined;
        }
        if (substituteTrigger) {
          routing.scope = 'chat';
          routing.anchor = chatId;
          routingSource = 'regular-group-chat';
          if (message.root_id && message.thread_id) replyRootId = message.root_id;
          const configuredTargetId = substituteTrigger.target.openId
            ?? substituteTrigger.target.userId
            ?? substituteTrigger.target.unionId
            ?? 'unknown';
          const configuredTargetForLog = JSON.stringify(configuredTargetId.slice(0, 128));
          logger.info(
            `[substitute:${larkAppId}] mention target=${configuredTargetForLog} ` +
            `msg=${messageId.substring(0, 12)} chat=${chatId.substring(0, 12)} → chat-scope`,
          );
        }

        // Shared-mode follow-up: a non-@ message inside a Lark thread can belong
        // to the regular group's chat-scope session when that root was registered
        // as a shared-topic alias. Whether a 普通群 answers it without an @mention
        // is governed by the bot-global mention policy: 'always' (default) keeps
        // "@ required" so this fold-back is skipped (non-@ thread chatter falls
        // through to the gate below and is ignored — only an explicit @ continues
        // a shared topic); 'topic', 'never' and 'ambient' enable the seamless
        // no-@ fold-back. Carve-out: under 'topic' / 'ambient', a non-@ reply
        // that @mentions another specific member (person/bot) is a redirect to
        // someone else → back off, don't fold it in (mentionsAnotherMember).
        // 'never' stays unconditional by design.
        const mentionModeForAlias = resolveGroupMentionMode(larkAppId);
        if (!explicitlyMentionedThisBot
            && mentionModeForAlias !== 'always'
            && !((mentionModeForAlias === 'topic' || mentionModeForAlias === 'ambient') && mentionsAnotherMember(larkAppId, message))
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
        const forceTopicApplied = substituteTrigger ? false : maybeApplyForceTopicOverride(routing, message, messageId);
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
            routingSource = 'topic-chat';
            // ownsSession was true on the stale chatId anchor; the new anchor
            // (messageId) is brand-new, so no current session owns it.
            ownsSession = false;
          }
        }

        const summaryCommandMatch = await resolveSummaryCommandMatch({
          larkAppId,
          chatId,
          chatType,
          routingSource,
          message,
          senderOpenId,
        });
        const summaryCommandTriggered = !!summaryCommandMatch && isAllowed;

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
          //   • 'never' — answer EVERY un-@ message from talk-allowed senders
          //     (incl. brand-new non-@ top-level → spawns/continues a session),
          //     unconditionally. Intended for dedicated / on-call groups.
          //   • 'ambient' — like 'never' (answer un-@ messages), EXCEPT when the
          //     message @mentions another specific member (person/bot) without
          //     @ing us — that is a redirect to someone else, so we back off and
          //     stay quiet (mentionsAnotherMember). @all does not count as a
          //     redirect. Best for multi-bot / multi-person groups that want a
          //     default responder which yields the moment you address someone else.
          //   • 'topic' — only inside a topic the bot already owns: a non-@ reply
          //     INSIDE such a thread (new-topic / 话题群 thread the bot owns, or a
          //     shared-topic alias via replyRootId) continues without @, while a
          //     brand-new top-level conversation still requires @. If the user
          //     explicitly @mentions another member/bot without @ing this bot,
          //     treat it as a hand-off and stay quiet.
          // Both gated on isAllowed so restricted groups still only react to
          // permitted senders. (The shared fold-back's replyRootId is already
          // handled by the first clause.)
          const mentionMode = resolveGroupMentionMode(larkAppId);
          // 话题群 owned-topic 免@续话不再无条件放行（#336 引入的默认行为回归：
          // 多人群里旁人不 @ 也会触发 bot）。现在与普通群共用同一套「群聊 @ 策略」:
          // 默认 'always' 在多人群里必须 @，想要话题内免@续话就把 mentionMode 配成
          // 'topic'（下方条款已同时覆盖话题群 thread 与普通群 shared topic），
          // 'never'/'ambient' 亦按各自语义生效。1人1bot 的 solo 群仍走末条放行。
          const relax = (!!replyRootId && isAllowed)
            || (!!substituteTrigger && isAllowed)
            || (isAllowed && mentionMode === 'never')
            || (isAllowed && mentionMode === 'ambient' && !mentionsAnotherMember(larkAppId, message))
            || (isAllowed && mentionMode === 'topic' && ownsSession && !!message.thread_id && !mentionsAnotherMember(larkAppId, message))
            || (ownsSession && isAllowed && !!stats && stats.userCount <= 1 && stats.botCount <= 1);
          if (!relax) {
            const access = await checkGroupMessageAccess(larkAppId, message, chatId, senderOpenId, humanSenderUnionId);
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

        const promptOverride = summaryCommandTriggered && summaryCommandMatch
          ? await buildSummaryCommandPrompt({ larkAppId, chatId, message, match: summaryCommandMatch })
          : undefined;
        if (promptOverride && summaryCommandMatch) {
          logger.info(
            `[summary-command] matched msg=${messageId.substring(0, 12)} ` +
            `chat=${chatId.substring(0, 12)} kind=${summaryCommandMatch.chatKind}`,
          );
        }
        const ctx: RoutingContext = {
          chatId,
          messageId,
          chatType,
          larkAppId,
          ...routing,
          replyRootId,
          promptOverride,
          summaryCommand: summaryCommandTriggered && summaryCommandMatch
            ? { name: 'summary-command', chatKind: summaryCommandMatch.chatKind }
            : undefined,
          substituteTrigger,
        };
        if (explicitlyMentionedThisBot) {
          const before = await handlers.beforeSessionTurn?.(data, ctx, { senderOpenId, explicitlyMentionedThisBot });
          if (before?.block) return;
          if (before?.anchorOverride) ctx.anchor = before.anchorOverride;
          ownsSession = handlers.isSessionOwner?.(ctx.anchor, larkAppId) ?? ownsSession;
        }
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
      }, 'message event', claim);
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
        const isVcMeeting = typeof et === 'string' && (et.startsWith('vc.bot.meeting_') || et === VC_PARTICIPANT_MEETING_JOINED_EVENT);
        if (isCommentish) {
          const ev = data?.event ?? data;
          const p = parseCommentEvent(data);
          logger.info(`[ws-event] ${larkAppId} event_type=${et} → parsed fileToken=${p.fileToken ?? '?'} commentId=${p.commentId ?? '?'} replyId=${p.replyId ?? '?'} isMentioned=${p.isMentioned} | notice_meta=${JSON.stringify(ev?.notice_meta ?? ev?.noticeMeta ?? null)}`);
        } else if (isVcMeeting) {
          const kind: VcMeetingPushEventKind = et === VC_BOT_MEETING_INVITED_EVENT
            ? 'meeting_invited'
            : et === VC_BOT_MEETING_ENDED_EVENT
              ? 'meeting_ended'
              : et === VC_PARTICIPANT_MEETING_JOINED_EVENT
                ? 'participant_meeting_joined'
                : 'meeting_activity';
          const parsed = parseVcMeetingPushEvent({ data, larkAppId, kind, eventType: et as VcMeetingPushEventType });
          logger.info(`[ws-event] ${larkAppId} event_type=${et} eventId=${parsed.eventId ?? '?'} meetingId=${parsed.meeting.id || '?'} items=${Array.isArray((data?.event ?? data)?.meeting_actitivty_items) ? (data?.event ?? data).meeting_actitivty_items.length : '?'}`);
          if (et === VC_BOT_MEETING_ACTIVITY_EVENT && process.env.DEBUG) {
            logger.info(`[ws-event:raw] ${larkAppId} event_type=${et} eventId=${parsed.eventId ?? '?'} payload=${vcMeetingEventPayloadForLog(data)}`);
          }
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
    // `proxy-from-env` treats WSS_PROXY as distinct from HTTPS_PROXY, while
    // Lark's preceding Axios bootstrap request uses HTTPS proxy semantics.
    // The custom resolver keeps both phases aligned and still honors NO_PROXY.
    agent: createLarkWsAgent(),
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
