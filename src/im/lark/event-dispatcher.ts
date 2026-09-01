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
import { getBot, getAllBots, findOncallChat, getOwnerOpenId, loadBotConfigs, vcMeetingAgentConfigActive, type BotState } from '../../bot-registry.js';
import { config, isVcMeetingAgentGloballyEnabled, vcMeetingAgentGlobalListenerBotAppId } from '../../config.js';
import { getChatInfo, getChatMode, getCachedChatMode, getUserProfile, listChatMessagesUntil, resolveSiblingBotBySenderOpenId, replyMessage, sendMessage, sendUserMessage, isHumanOpenId, updateMessage } from './client.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/bounded-map.js';
import { serializeByAnchor } from '../../utils/anchor-serializer.js';
import { parseForceTopicInvocation } from '../../core/command-handler.js';
import { shouldAutoStartOnNewTopic } from '../../core/auto-start.js';
import { resolveNonsupportMessage, stripLeadingMentions, mentionOpenId, mentionAppId, extractMentionIdentities, messageMentionsBot, type MentionIdentity } from './message-parser.js';
import { recordObservedBots, listObservedBots } from '../../services/observed-bots-store.js';
import { recordObservedBotUnionId } from '../../services/observed-bot-union-ids-store.js';
import { mergeBotOpenIdCrossRef } from '../../services/bot-openid-crossref-store.js';
import { isTeamBot, recordTeamBot } from '../../services/team-bots-store.js';
import { isTeamGroupChat } from '../../services/team-groups-store.js';
import { isPlatformTeamBot, isPlatformHallChat, isPlatformTeamMember } from '../../services/platform-team-store.js';
import { getBotUnionId, recordBotUnionId, recordBotUnionIdFromMentions } from '../../services/bot-union-ids-store.js';
import { getDocSubscription, putDocSubscription, removeDocSubscription, listAllDocSubscriptions, type DocSubscription } from '../../services/doc-subs-store.js';
import { wasPendingReviewNotified, markPendingReviewNotified } from '../../services/under-review-notify-store.js';
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
import { automateOpenPlatformSetup, probeVcMeetingEventSubscription, readDefaultScopeManifest, filterScopeManifest, inspectUnderReviewConfigHints } from '../../setup/open-platform-automation.js';
import { type Brand, larkHosts, normalizeBrand, sdkDomain } from './lark-hosts.js';
import { tryHandleGrantCommand } from './grant-command.js';
import { tryHandleInviteCommand } from './invite-command.js';
import { autoInviteOwnerOnGroupJoin } from '../../services/groups-store.js';
import { tryHandleReplyModeCommand } from './reply-mode-command.js';
import { tryHandleMentionModeCommand } from './mention-mode-command.js';
import { tryHandleSubstituteCommand } from './substitute-command.js';
import { buildGrantCard } from './card-builder.js';
import { openPending, isThrottled, clearPending } from './grant-pending.js';
import { localeForBot, t } from '../../i18n/index.js';
import {
  chatQuotaKey,
  getGrantExpiresAt,
  globalQuotaKey,
  removeExpiredGrant,
} from '../../services/grant-store.js';
import { ForwardFollowupBuffer } from './forward-followup-buffer.js';
import { listForwardFollowups, putForwardFollowup, removeForwardFollowup } from './forward-followup-store.js';
import { claimMessageOnce, _resetCacheForTest as _resetSeenMessagesForTest } from '../../services/seen-message-store.js';
import { ensureDefaultOncallBound } from '../../services/oncall-store.js';
import { getSessionGroup } from '../../services/session-groups-store.js';
import { resolveRegularGroupMode, resolveGroupMentionMode, type GroupMentionMode } from '../../services/chat-reply-mode-store.js';
import { isGoalChat } from '../../services/goal-chat-store.js';
import { buildSummaryCommandPrompt, type SummaryChatKind, type SummaryCommandMatch, type SummaryCommandRuntimeContext } from './summary-command.js';
import { DEFAULT_SUMMARY_PROMPT, summaryRangeFromBotConfig } from '../../services/summary-range-store.js';
import { isSubstituteEnabledForChat } from '../../services/substitute-chat-toggle-store.js';
import { evaluateMessageListener, resolveListenerSenderIdentity, buildListenerBotAppIdToOpenId, collectListenerBotAppIds, type MessageListenerMatch } from '../../services/message-listener.js';
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
import { DEFAULT_GRANT_DURATION_MS, DEFAULT_GRANT_QUOTA } from '../../services/grant-policy.js';
import { readPeerCrossRef, writePeerCrossRef } from '../../services/peer-cross-ref-store.js';

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

/**
 * 给管理员发一条提醒。**返回是否真的发出去了。**
 *
 * 为什么要返回值：多数调用点是 best-effort、不关心成败（所以这里吞掉异常而不是抛，
 * 避免一次 DM 失败中断整条自检流程）。但「按待审版本节流」那处必须知道成败 ——
 * 先记「已通知」再发的话，一次网络失败就把那个版本永久节流掉，人再也收不到提醒，
 * 且是零信号的静默丢失。所以由这里如实回报，让**只有关心的那一处**去判断。
 */
async function dmAdmin(larkAppId: string, adminOpenId: string, content: string, contextTag: string): Promise<boolean> {
  try {
    await sendUserMessage(larkAppId, adminOpenId, content, 'text');
    logger.info(`[${larkAppId}] notified admin ${adminOpenId.substring(0, 12)} about ${contextTag}`);
    return true;
  } catch (err: any) {
    logger.warn(`[${larkAppId}] failed to DM admin about ${contextTag}: ${err?.message ?? err}`);
    return false;
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
 *
 * `opts.disableQrLogin` — when the only thing missing is a non-critical scope,
 *   we still try to grab it (the automation imports the full manifest), but must
 *   NOT pop a second QR code if the cached session is gone. Passing this makes a
 *   missing/expired session fail cleanly (reason `invalid_session`) instead of
 *   prompting a login.
 * `opts.silent` — suppress the admin success DM (used for the opt-in / optional
 *   path so a bot that never asked for the feature isn't pinged; the log line is
 *   enough). Failures are always silent here regardless.
 */
/**
 * `kind`：
 *   • `'fixed'` = 已处理完，调用方停止
 *   • `'under_review'` = 应用正在飞书审核中、配置被写锁。调用方**不该**再让管理员去点
 *     权限链接（审核期间连 scope/update 都被拒，点了也写不进去），也不该说「等审批通过
 *     就好」——触发审批通常意味着有配置不合规，那一版不会自己通过，得人工修配置。
 *   • `'failed'` = 落回人工深链 DM
 *
 * `inReviewVersionId`：仅 `under_review` 时可能有值 —— 当前那个待审版本的 id，用作
 * 「同一个待审版本别重复打扰管理员」的节流 key。**读不到时为 undefined，此时刻意不
 * 节流**（那意味着模型与飞书实际状态不一致，每次都值得说；万一是我们判据有 bug，
 * 节流会掐掉唯一的信号）。
 */
type AutoFixOutcome = { kind: 'fixed' | 'under_review' | 'failed'; inReviewVersionId?: string };

async function tryAutoFixScopes(
  larkAppId: string,
  bot: BotState,
  brand: Brand,
  missingCritical: { name: string; desc: string }[],
  missingOptional: { name: string; desc: string }[],
  opts?: { disableQrLogin?: boolean; silent?: boolean; grantedScopeNames?: { tenant: string[]; user: string[] } },
): Promise<AutoFixOutcome> {
  if (brand !== 'feishu') return { kind: 'failed' };

  try {
    const totalMissing = missingCritical.length + missingOptional.length;
    logger.info(`[${larkAppId}] attempting auto-fix for ${totalMissing} missing scopes via Open Platform...`);
    // 只申请「实际缺失」的那几项：把默认清单裁成缺失集合再传进去，避免
    // 「用缺失项当触发器、却拿完整 manifest（300+ 项）当申请集合」——那会让补一个
    // im:feed_group_v1:read 连带申请日历/文档/表格等一大批 botmux 不校验的权限。
    // 分桶归属仍以默认 manifest 为准（见 filterScopeManifest）。
    const wantedScopeNames = [...missingCritical, ...missingOptional].map(s => s.name);
    const scopeManifest = filterScopeManifest(readDefaultScopeManifest(), wantedScopeNames);
    const result = await automateOpenPlatformSetup({
      appId: bot.config.larkAppId,
      brand,
      maxWaitMs: 60_000,
      disableQrLogin: opts?.disableQrLogin,
      scopeManifest,
      // 已授权集合（按 tenant/user 分桶）：automation 据此对上面这份 manifest 再按桶
      // 各自做一次差集，并按「确有新增」而非「发过 scope/update」置 mutated——「配置本
      // 就齐全」时才能命中无变更短路。分桶是为了不让 tenant 授权误伤 user 桶同名
      // scope（#1044）。与 scopeManifest 叠加安全：缺失判定用的扁平集合是分桶集合的
      // 超集，故本路径上二次差集恒为空操作；它真正兜住的是「裁剪后为空」那一轮。
      // 拿不到 granted（self_manage 冷启动）时不传，退回保守近似。
      grantedScopeNames: opts?.grantedScopeNames,
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
      // ⚠️ `scopeCount === 0` 有三种**互相矛盾**的成因，不能共用一句话。自从申请集合
      // 被裁成「缺失项」后（见上方 filterScopeManifest），它的语义从「整份清单导入了
      // 多少」变成「**缺失的那几项里成功了多少**」，于是 0 不再等于「本来就齐」，
      // 反而最可能是「一项都没补上」——照旧说「所有必需权限已在应用清单中」就成了
      // 恰在全部失败时谎报齐全。三种成因按可诊断性分开：
      //   ① scopeWarning 有值 → scope/update 被租户整批拒了（开放平台明确报错）
      //   ② skippedScopeCount > 0 → 这些名字不在该租户的开放平台目录里，不可授予
      //      （automation 自己 warn 过「not present in the Open Platform catalog」）
      //   ③ 都没有 → 申请集合本就是空的（缺失项已在清单中），才是真的「已齐全」
      // 这句同时进 daemon 日志**和**下面的管理员 DM，DM 开头写着「✅ 已自动修复了
      // 缺失的权限」，一旦这里说反就自相矛盾，管理员会以为不用管。
      const scopeDetail = result.scopeCount > 0
        ? `${result.scopeCount} 项权限已导入${result.skippedScopeCount > 0 ? `（${result.skippedScopeCount} 项跳过）` : ''}`
        : result.scopeWarning
          ? `0 项权限已导入——开放平台拒绝了本次权限申请（${result.scopeWarning}），需到「权限管理」手动开通`
          : result.skippedScopeCount > 0
            ? `0 项权限已导入——这 ${result.skippedScopeCount} 项不在当前租户的开放平台权限目录中，无法自动申请，需到「权限管理」手动开通`
            : '所有必需权限已在应用清单中';
      // 一项都没申请上时，这次自愈**没有**修好任何东西，日志级别也不该是「succeeded」。
      const autoFixEffective = result.scopeCount > 0 || (!result.scopeWarning && result.skippedScopeCount === 0);
      // 数据范围只在**真做了事**或**真出错**时才进日志：常态是「没有待配的」，
      // 那句话对读日志的人零信息量，还会淹没上面真正的 scope 结论。
      const privilegeRangeDetail = result.privilegeRangeCount > 0
        ? `, ${result.privilegeRangeCount} 项权限数据范围已设为「与应用的可用范围一致」`
        : result.privilegeRangeWarning
          ? `, 权限数据范围未能自动配置（${result.privilegeRangeWarning}）`
          : '';
      // 三种结局互斥，判定顺序不能反（#1044 的 publishSkipped 必须最先判）：
      //   ① publishSkipped —— 无变更、**根本没建版本**，报 `version n/a published` 会误导
      //   ② versionWarning —— 建/提交了但回读仍是草稿。「version X published」曾是**谎报**：
      //      `publish/commit` 回 code=0 而版本仍停在未提交草稿态，日志照样写 published，
      //      于是那个草稿一路卡死后续每一次自愈（`app_version/create` 撞 code=10043）。
      //   ③ 正常发布
      const versionDetail = result.publishSkipped
        ? '无变更，已跳过发版'
        : result.versionWarning
          ? `version ${result.versionId ?? 'n/a'} NOT published（${result.versionWarning}）`
          : `version ${result.versionId ?? 'n/a'} ${result.versionReused ? '(复用既有草稿) ' : ''}published`;
      // 「秒过」与「要人审」是两种截然不同的结局，日志必须分开——否则运维看到
      // published 会以为权限已经生效，而实际上可能还在等某个人点同意。
      const approvalDetail = result.approvalAutoPassed === true
        ? '（审批流自动通过，已即时生效）'
        : result.approvalHumanApprovers?.length
          ? `（需人工审批：${result.approvalHumanApprovers.join('、')}）`
          : '';
      const summary =
        `[${larkAppId}] auto-fix ${autoFixEffective ? 'succeeded' : 'could NOT apply the missing scopes'}: ${scopeDetail}${privilegeRangeDetail}, ` +
        `${versionDetail}${approvalDetail}, ` +
        `${result.subscribedEventCount} events subscribed`;
      if (autoFixEffective && !result.versionWarning) logger.info(summary);
      else logger.warn(summary);
      // opt-in / optional-only path: succeeded silently, no admin DM (a bot that
      // never enabled the feature must not be pinged just because a non-critical
      // scope was topped up in the background). The log line above is the record.
      if (opts?.silent) return { kind: 'fixed' };
      // Notify admin that auto-fix worked — even if im:message was missing before,
      // the newly published version should now have it.
      const adminOpenId = getAdminOpenId(bot);
      if (adminOpenId) {
        const fixedList = [...missingCritical, ...missingOptional];
        const missingList = fixedList.map(s => `• ${s.desc} (\`${s.name}\`)`).join('\n');
        // 标题跟着实际结果走：一项都没落地时说「已自动修复」是谎报，管理员会以为
        // 不用管，而这条路径的下游（缺 critical scope）恰恰是最需要人工介入的。
        // 同理「新版本已发布」也不能写死：scope 写进了清单但版本没提交，权限就**不会
        // 生效**，而管理员读到「已发布」只会干等。versionWarning 有值时直接给出
        // 手动收尾的动作。
        //
        // 三种结局要分清，因为「用户接下来该做什么」完全不同：
        //   ① 秒过（审批流全自动通过）→ 已经生效了，什么都不用做
        //   ② 要人审 → 已提交，但在等具体某个人；告诉他等谁，免得重复点或干等
        //   ③ 判不出来 → 保持中性措辞，不猜
        const versionLine = result.versionWarning
          ? `⚠️ 但新版本**没有成功提交发布**（${result.versionWarning}）。权限要等版本发布后才生效。`
          : result.approvalAutoPassed === true
            ? '新版本已提交，审批流**自动通过**，权限已即时生效。'
            : result.approvalHumanApprovers?.length
              ? `新版本已提交，但需要**人工审批**（审批人：${result.approvalHumanApprovers.join('、')}），`
                + '通过后权限才生效——不用重复提交，等审批即可。'
              : '新版本已发布。';
        await dmAdmin(
          larkAppId,
          adminOpenId,
          (autoFixEffective && !result.versionWarning
            ? `✅ botmux 已自动为机器人 "${bot.botName ?? larkAppId}" 修复了缺失的权限：\n\n`
            : `⚠️ botmux 尝试自动为机器人 "${bot.botName ?? larkAppId}" 补齐以下权限，但没能全部落地，需要你手动收尾：\n\n`) +
          `${missingList}\n\n` +
          `${scopeDetail}，${versionLine}\n` +
          `权限变更可能需要 1-2 分钟生效。如仍有问题执行 \`botmux restart\`。`,
          autoFixEffective ? `auto-fixed ${fixedList.length} scopes` : `auto-fix could not apply ${fixedList.length} scopes`,
        );
      }
      return { kind: 'fixed' };
    }

    // Auto-fix failed — log reason. Critical path falls through to a manual
    // deep-link DM; the silent optional-scope top-up path does NOT DM (it just
    // leaves the opt-in scope ungranted), so don't claim a DM fallback there.
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
      app_under_review: '应用正在飞书审核中（配置被开放平台写锁，审批通过后自动恢复）',
    };
    // ⚠️ 泛化标签和具体消息**两个都要打**。这里曾写成
    // `reasons[result.reason] ?? result.message`——`api_error` 在表里有值,`??`
    // 永远短路,于是 `result.message` 一次都进不了日志。线上真实后果:一天 5 次自愈
    // 失败只留下 5 行「开放平台 API 错误」,而被吞掉的那句正是唯一有用的诊断
    // (`code=10043 版本已创建,请刷新`),排查只能靠重放整条链路才拿到。
    // 泛化标签帮人快速归类,具体消息才说得清到底哪儿坏——别再让前者盖掉后者。
    const reasonLabel = reasons[result.reason] ?? result.reason;
    // 审核中不是「修不了」，是「现在不能改、审批通过就好」。日志级别降为 info 并显式
    // 说明不会落回深链 DM——把权限链接推给管理员是**错误的建议**：审核期间开放平台
    // 连 scope/update 都拒（实测 code=10046），点了也写不进去。
    if (result.reason === 'app_under_review') {
      logger.info(
        `[${larkAppId}] auto-fix deferred: ${reasonLabel}` +
        `${result.message ? ` — ${result.message}` : ''}`,
      );
      return { kind: 'under_review', inReviewVersionId: result.inReviewVersionId };
    }
    logger.warn(
      `[${larkAppId}] auto-fix not possible (${result.reason}: ${reasonLabel}` +
      `${result.message ? ` — ${result.message}` : ''}). ` +
      (opts?.silent ? 'Leaving opt-in scope ungranted (no DM).' : 'Falling back to manual deep-link DM.'),
    );
    return { kind: 'failed' };
  } catch (err: any) {
    logger.warn(`[${larkAppId}] auto-fix error: ${err?.message ?? err}` +
      (opts?.silent ? ' — leaving opt-in scope ungranted (no DM)' : ' — falling back to manual DM'));
    return { kind: 'failed' };
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
      // are missing. Try the Open Platform web-session auto-fix to add every
      // botmux-required scope (including self_manage) in one shot — passing the
      // full BOTMUX_REQUIRED_SCOPES so the next restart's self-check finds them
      // all present, without over-applying the whole 300+ scope manifest.
      if (brand === 'feishu') {
        const requiredNow = BOTMUX_REQUIRED_SCOPES.map(s => ({ name: s.name, desc: s.desc }));
        const fixed = await tryAutoFixScopes(larkAppId, bot, brand, requiredNow, []);
        // 审核中同样直接返回：这条路径下游是让管理员去点 self_manage 深链，而审核期间
        // 写锁生效，点了也开不了——等审批通过下次重启自检即可。
        if (fixed.kind !== 'failed') return;
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

    // 按 token 类型分桶的已授权集合，专供 automation 的「无变更短路」按桶做差用。
    // application/v6 每个 scope 条目自带 token_types:(tenant|user)[]（SDK 类型可查）。
    // 之所以不能复用上面的扁平 grantedScopes：约 121 个名字同时在 tenant/user 两桶，
    // tenant/user 是两份独立授权；扁平集合会让「tenant 已授权」误伤 user 桶同名 scope，
    // 把真正缺的 user 权限静默吞掉（PR #1044 R2）。缺 token_types 的条目**两桶都不放**，
    // 退回保守近似（该名字照发 scope/update），宁可多发一版也不少发。
    const grantedScopeBuckets = { tenant: [] as string[], user: [] as string[] };
    for (const s of scopesRaw) {
      const name = typeof s === 'string' ? s : s?.scope;
      if (!name) continue;
      const tokenTypes: unknown = typeof s === 'string' ? undefined : s?.token_types;
      if (Array.isArray(tokenTypes)) {
        if (tokenTypes.includes('tenant')) grantedScopeBuckets.tenant.push(name);
        if (tokenTypes.includes('user')) grantedScopeBuckets.user.push(name);
      }
    }

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
        // VC 现在默认对每个连着飞书的 bot 生效（enabled:false 才是显式退出），所以
        // 就绪自检也要跟着走 vcMeetingAgentConfigActive，而不是只认显式 enabled:true——
        // 否则「默认开」的绝大多数 bot 在启动时永远不做权限体检。
        && !!vcMeetingAgentConfigActive(bot.config)
        && (!globalVcListenerAppId || globalVcListenerAppId === larkAppId)
      ) {
        // 实时语音也默认开启（未配=开），所以 VC 权限体检默认把实时语音 scope 纳入
        // 必需项；只有显式 realtimeVoice.enabled=false 才不查它。
        const requiredVcScopes = bot.config.vcMeetingAgent?.realtimeVoice?.enabled !== false
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
      // All critical scopes present. If an opt-in feature added a non-critical
      // scope that isn't granted yet, top it up SILENTLY — but only when a cached
      // Feishu web session already exists (disableQrLogin makes a missing session
      // fail cleanly with no second QR code and no DM). This makes `botmux restart`
      // actually pick up newly-declared optional scopes (e.g. the foreign-bot
      // group-message scope) without the admin having to visit the Open Platform,
      // while a bot with nothing missing — or no web session — behaves exactly as
      // before (no API call / no prompt / no nag).
      if (missingOptional.length > 0 && brand === 'feishu') {
        const toppedUp = await tryAutoFixScopes(larkAppId, bot, brand, [], missingOptional,
          { disableQrLogin: true, silent: true, grantedScopeNames: grantedScopeBuckets });
        // 只有真的补上了才说「auto-topped-up」：审核中什么都没写进去（开放平台
        // 连 scope/update 都拒），说补上了就是谎报。审核中静默跳过，等审批通过。
        if (toppedUp.kind === 'fixed') {
          logger.info(`[${larkAppId}] auto-topped-up ${missingOptional.length} optional scope(s): ${missingOptional.map(s => s.name).join('、')}`);
          return;
        }
        if (toppedUp.kind === 'under_review') return;
        logger.debug(`[${larkAppId}] optional scope(s) missing (${missingOptional.map(s => s.name).join('、')}); no cached web session to auto-apply — leaving to opt-in feature owner`);
      }
      logger.info(`[${larkAppId}] all critical scopes granted (${BOTMUX_REQUIRED_SCOPES.filter(s => s.critical).length} checked)`);
      return;
    }

    // Auto-fix: try the same Open Platform automation used by `botmux setup`.
    // If a cached Feishu web session exists (~/.botmux/feishu-session.json), we can
    // directly add missing scopes and publish a new version without user interaction.
    // Falls through to manual DM warning if session is missing/expired.
    const autoFixed = await tryAutoFixScopes(larkAppId, bot, brand, missingCritical, missingOptional,
      { grantedScopeNames: grantedScopeBuckets });
    if (autoFixed.kind === 'fixed') return;
    // 审核中：**不推权限深链**（审核期间连 scope/update 都被拒，点了写不进去），
    // 也**不说「等审批通过就好」**——触发审批通常意味着有配置不合规，那一版不会自己
    // 通过（模板建的应用出生带「数据范围=全部」，正撞租户「非必要不申请全员数据」的
    // 加签规则）。所以这里只做一件事：**如实告诉管理员卡在哪、为什么卡、怎么修**。
    if (autoFixed.kind === 'under_review') {
      const summary = missingCritical.map(s => `${s.name} (${s.desc})`).join('、');
      logger.warn(
        `[${larkAppId}] 缺少 ${missingCritical.length} 项必需权限（${summary}），` +
        '但应用有一个版本卡在飞书审核中、配置暂时不可写；需人工修配置后撤回重提，botmux 无法自动解决。',
      );
      const reviewAdmin = getAdminOpenId(bot);
      // 🔴 同一个待审版本只打扰一次。不做节流的话，卡在审核中是个持续数天的状态
      //（线上实测 18 天 / 23 天），而本函数每次 daemon 启动都跑一遍 ⟹ 卡 N 天就发 N 条
      // 一模一样的 DM，等于把这次要消灭的刷屏换个文案请回来。
      // key 用待审版本 id：对齐「事情有没有变化」而非「过了多久」——人撤回重提了新版本，
      // 该说；同一版还卡着，不必再说。拿不到 id 时**刻意不节流**（见 store 注释）。
      const alreadyNotified = wasPendingReviewNotified(
        config.session.dataDir, larkAppId, autoFixed.inReviewVersionId,
      );
      if (reviewAdmin && !alreadyNotified) {
        const rangeHint = await inspectUnderReviewConfigHints(bot.config.larkAppId, brand);
        const delivered = await dmAdmin(
          larkAppId,
          reviewAdmin,
          `⏳ 机器人 "${bot.botName ?? larkAppId}" 还缺 ${missingCritical.length} 项必需权限，`
          + `而它有一个版本**卡在飞书审核中**，开放平台锁定了配置写入，botmux 补不了：\n\n`
          + `${missingCritical.map(s => `• ${s.desc} (\`${s.name}\`)`).join('\n')}\n\n`
          + `**为什么会进审核**：触发企业审批通常说明有配置不合规，最常见是权限的「数据范围」`
          + `没配、默认成「全部/全员」，撞上租户「非必要不申请全员数据，如申请全员范围需提供`
          + `充分理由、视情况加签至 CEO-2」的规则。${rangeHint}\n\n`
          + `**怎么修**（这一版不会自己通过，需要人工）：\n`
          + `1. 开放平台 →「版本管理与发布」→ 点进审核中那一版的**版本详情**，看审批详情里被卡的项\n`
          + `2. 修掉不合规项（如把权限的数据范围从「全部」改成「与应用的可用范围一致」）\n`
          + `3. 在版本详情页点 **Withdraw** 撤回该版本\n`
          + `4. 执行 \`botmux restart\` —— botmux 会自动补齐权限并重新提交\n\n`
          + `⚠️ 直接撤回重提**不管用**：不改配置的话同一条规则会再拦一次。\n`
          + `⚠️ 此时去权限管理页手动点开通也**无效**：审核期间飞书连「申请权限」都拒绝。`,
          `app under review, ${missingCritical.length} scopes deferred`,
        );
        // ⚠️ **发送成功才记账**。反了的话一次网络失败就把这个 versionId 永久节流掉，
        // 管理员再也收不到提醒，而且是零信号的静默丢失，比刷屏更难发现。
        if (delivered) {
          markPendingReviewNotified(config.session.dataDir, larkAppId, autoFixed.inReviewVersionId);
        }
      } else if (alreadyNotified) {
        logger.info(
          `[${larkAppId}] 待审版本 ${autoFixed.inReviewVersionId} 已通知过管理员，本次不重复打扰`,
        );
      }
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

/**
 * Startup: ensure this bot is subscribed to the VC meeting events
 * (`vc.bot.meeting_*` + participant_meeting_joined) so ANY invited bot can
 * receive meeting invites — the physical prerequisite for bot-agnostic
 * auto-join. Check-first: a read-only probe over the cached Feishu web session
 * (no QR at boot); only when events are missing / event mode is wrong do we run
 * the full open-platform automation (which subscribes them AND publishes a
 * version). This mirrors checkRequiredScopes ("fix only when something's
 * missing") so a bot with events already subscribed makes zero mutating calls
 * and never republishes. Best-effort: never throws into boot; apiOnly and
 * VC-disabled bots are skipped by the caller / the active-config gate.
 */
export async function ensureVcMeetingEventsSubscribed(larkAppId: string): Promise<void> {
  const bot = getBot(larkAppId);
  const brand = normalizeBrand(bot.config.brand);
  // Open-platform automation only supports feishu.cn tenants. Skip apiOnly and
  // VC-inactive bots — vcMeetingAgentConfigActive fail-closes both.
  if (brand !== 'feishu') return;
  if (!vcMeetingAgentConfigActive(bot.config)) return;
  try {
    const probe = await probeVcMeetingEventSubscription(larkAppId);
    if (!probe.ok) {
      // No cached web session / expired / network — degrade gracefully. Do NOT
      // pop a QR at boot. Surface once to the admin so they can `botmux setup`.
      logger.info(
        `[${larkAppId}] VC event subscription check skipped (${probe.reason}): ${probe.message}. ` +
        `被邀请进会需先订阅 vc.bot.meeting_* 事件；如该 bot 从未订阅，请运行 \`botmux setup\` 刷新开放平台登录态后重启。`,
      );
      return;
    }
    if (probe.missingVcEvents.length === 0 && probe.eventModeReady) {
      logger.info(`[${larkAppId}] VC meeting events already subscribed (long-connection mode)`);
      return;
    }
    logger.info(
      `[${larkAppId}] VC events missing (${probe.missingVcEvents.join('、') || '事件模式非长连接'}); auto-subscribing via Open Platform...`,
    );
    const result = await automateOpenPlatformSetup({
      appId: bot.config.larkAppId,
      brand,
      maxWaitMs: 60_000,
      disableQrLogin: true,
      onStatus: (msg) => logger.info(`[${larkAppId}] vc-event-autoconfig: ${msg}`),
      onQrCode: () => {
        logger.warn(`[${larkAppId}] vc-event-autoconfig: cached Feishu web session expired; run \`botmux setup\` to refresh, then restart.`);
      },
    });
    if (result.ok) {
      logger.info(`[${larkAppId}] VC events auto-subscribed: ${result.subscribedEventCount} events, version ${result.versionId ?? 'n/a'} published`);
      return;
    }
    // Automation failed (session expired mid-run / api error). Log; DM the admin
    // once so a bot that genuinely lacks the subscription gets a human nudge.
    //
    // 「应用正在审核中」要单独说：审核期间开放平台锁配置写入，刷新登录态**没有用**
    // （不是 session 问题），等审批通过重启即可。给错的操作建议比不给更糟——用户会
    // 反复 `botmux setup` 却始终不见好。
    const underReview = !result.ok && result.reason === 'app_under_review';
    if (underReview) {
      logger.info(`[${larkAppId}] VC event auto-subscribe deferred (app under review): ${result.message}`);
    } else {
      logger.warn(`[${larkAppId}] VC event auto-subscribe failed (${result.reason}): ${result.message}`);
    }
    const adminOpenId = getAdminOpenId(bot);
    if (adminOpenId) {
      await dmAdmin(
        larkAppId,
        adminOpenId,
        `⚠️ botmux 想在启动时自动为机器人 "${bot.botName ?? larkAppId}" 订阅视频会议事件（vc.bot.meeting_*），以便它被拉进会时能自动进会，但自动配置失败：${result.message}\n\n` +
        (underReview
          // ⚠️ 别说「等审批通过就好」：触发审批通常意味着有配置不合规，那一版**不会自己
          // 通过**，说「等」等于让人干等。也别说「刷新登录态」——审核锁住的是配置写入，
          // 不是 session 问题。
          ? '该应用有一个版本**卡在飞书审核中**，配置写入被锁（刷新登录态无效）。触发审批通常说明有配置不合规'
            + '（最常见：权限的「数据范围」默认成「全部/全员」）。需人工处理：开放平台 →「版本管理与发布」→ 该版本详情 → '
            + '看审批详情修掉不合规项 → 点 **Withdraw** 撤回 → 执行 `botmux restart` 重试。不改配置直接撤回重提会被同一条规则再拦。'
          : '请运行 `botmux setup` 刷新飞书开放平台登录态后重启 daemon，botmux 会自动重试。'),
        underReview ? 'vc event auto-subscribe deferred (under review)' : 'vc event auto-subscribe failed',
      );
    }
  } catch (err: any) {
    logger.debug(`[${larkAppId}] VC event subscription check errored: ${err?.message ?? err}`);
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
function scheduleAckSafeEvent(key: string, work: () => Promise<void>, label: string, claim: () => boolean = () => claimEventOnce(key)): boolean {
  if (!claim()) {
    logger.info(`[event-dedupe] duplicate ${label} ignored: ${key}`);
    return false;
  }
  // INVARIANT: the claim above + this setImmediate scheduling must stay fully
  // synchronous (no await before we get here). WS events arrive in order and
  // setImmediate is FIFO, so same-anchor messages reach serializeByAnchor in
  // arrival order ONLY while nothing awaits ahead of the schedule. An await here
  // would reintroduce the kickoff-ordering bug serializeByAnchor guards against.
  setImmediate(() => {
    void work().catch(err => logger.error(`Error handling ${label}: ${err}`));
  });
  return true;
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

/**
 * Synchronous first-stage routing lane for inbound Lark messages.
 *
 * Routing can await bot identity, chat mode, oncall binding, summary expansion,
 * and VC catch-up before it discovers the canonical daemon anchor. Reserving
 * only at that later anchor lets a faster N+1 reach the session before N.
 *
 * This barrier must be chat-wide, not thread-wide: a topic seed has no thread_id
 * and initially looks chat-shaped, while its first reply carries thread_id; both
 * later canonicalize to the seed message_id. Shared-topic aliases likewise fold
 * a thread-shaped event back into a chat owner. Per-thread raw lanes therefore
 * cannot prove arrival order. The barrier is released as soon as canonical work
 * is synchronously enqueued below, so handlers for distinct canonical topics can
 * still run concurrently.
 */
export function rawMessageIngressAnchor(larkAppId: string, message: any): string {
  const chatId = typeof message?.chat_id === 'string' && message.chat_id.trim()
    ? message.chat_id.trim()
    : '__chatless__';
  return `lark-message-routing:${larkAppId}:${chatId}`;
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
    // Feedback primary/reason buttons share an action name. Include their
    // semantic target so a rapid change of choice is not mistaken for a
    // duplicate in-flight click on the previous button.
    feedbackResult: value?.result,
    feedbackReason: value?.reason_key,
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
    // Overload browser-restart buttons all share one action label
    // (`overload_restart_browser`) but target different browsers; include the
    // bundleId so rapidly clicking Arc then Chrome isn't collapsed into one
    // in-flight dedupe key that drops the second click.
    bundleId: value?.bundleId,
  })}`;
}

function shapeCardActionResult(result: any): any {
  // The handler may return:
  //   - an already-shaped Lark response ({toast} and/or {card}) -> pass through;
  //   - a raw card body (e.g. toggle_stream) -> wrap as an in-place card patch.
  if (result && (result.toast || result.card || result.deferredCard)) return result;
  if (result) return { card: { type: 'raw', data: result } };
  // The Lark WS SDK only serializes callback `data` for truthy results. An
  // empty object therefore means "ACK with no UI update", while undefined
  // produces a code-only response that the client rejects as an invalid ACK.
  return {};
}

function serializeRawCardForPatch(cardData: any): string | undefined {
  if (cardData === undefined || cardData === null) return undefined;
  return typeof cardData === 'string' ? cardData : JSON.stringify(cardData);
}

async function patchTimedOutCardActionResult(larkAppId: string, data: any, shapedResult: any): Promise<void> {
  const messageId = cardActionMessageId(data);
  const card = shapedResult?.card ?? shapedResult?.deferredCard;
  if (!messageId || !card) return;
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
    .then(result => {
      if (!result?.deferredCard) return result;
      // ACK the callback before patching. If we await message.patch here, Lark
      // applies the callback completion after the API patch and can restore the
      // pre-click card, making the expanded follow-up flash and disappear.
      setTimeout(() => {
        void patchTimedOutCardActionResult(larkAppId, data, result)
          .catch(err => logger.warn(`Failed to patch deferred card action result: ${err}`));
      }, 0);
      return {};
    })
    .catch(err => {
      logger.error(`Error handling card action: ${err}`);
      return {};
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

/**
 * Drop the cached group stats for one chat — called when a membership-change
 * event that is VISIBLE to this app arrives (user add/delete broadcast, or our
 * own bot being added/removed), so the 1v1 relax gate sees fresh counts on the
 * very next message instead of coasting on stale numbers for up to
 * CHAT_CACHE_TTL. TTL 继续保留,作为事件未订阅（老应用）时的兜底。
 * 注意跨进程边界:「别的 bot 进群/离群」事件只推给当事 bot 自己的 app,
 * 一 bot 一 daemon 部署下此函数够不到兄弟进程的缓存(见 handler 处注释)。
 */
export function invalidateChatStats(larkAppId: string, chatId: string): void {
  if (chatStatsCache.delete(`${larkAppId}:${chatId}`)) {
    logger.debug(`[group-stats] invalidated cached stats for ${chatId} (${larkAppId}): membership changed`);
  }
}

/** Test-only: clear the group-stats cache between cases. */
export function __resetChatStatsForTest(): void {
  chatStatsCache.clear();
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
  for (const [name, openId] of Object.entries(readPeerCrossRef(dataDir, larkAppId))) {
    map.set(name.toLowerCase(), openId);
  }
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
 * Auth-grade local sibling check for the narrow `/repo` exception.
 *
 * Cross-ref proves only "this receiver has seen this sender open_id as some
 * peer" and may be stale or name-poisoned. For authorization we additionally
 * require the Lark-stamped sender union_id to match exactly one currently
 * configured, transport-enabled sibling app's learned own union_id.
 */
export function isVerifiedLocalSiblingBot(
  dataDir: string,
  larkAppId: string,
  senderOpenId: string | undefined,
  senderUnionId: string | undefined,
): boolean {
  const openId = (senderOpenId ?? '').trim();
  const unionId = (senderUnionId ?? '').trim();
  if (!openId || !unionId) return false;

  if (!isKnownPeerBot(dataDir, larkAppId, openId)) return false;

  let matchingConfiguredSiblings = 0;
  try {
    for (const cfg of loadBotConfigs()) {
      const appId = (cfg.larkAppId ?? '').trim();
      if (!appId || appId === larkAppId || cfg.apiOnly === true) continue;
      if (getBotUnionId(dataDir, appId) === unionId) matchingConfiguredSiblings += 1;
      if (matchingConfiguredSiblings > 1) return false;
    }
  } catch {
    return false;
  }
  return matchingConfiguredSiblings === 1;
}

/**
 * Resolve a foreign bot sender's CURRENT display name from its tenant-stable
 * `union_id` — rename-proof, unlike the per-app name→open_id cross-ref.
 *
 * Why this exists: `lookupForeignBotName` historically read the receiver-local
 * cross-ref (`bot-openids-<receiverApp>.json`), which only learns a bot's name
 * when THAT bot is @-mentioned in one of the receiver's own events. When a
 * renamed bot merely *sends* to us (the `[来自 X 的 @mention]` prefix path), no
 * mention of X flows through us, so its cross-ref entry stays frozen at the old
 * name. `union_id` is stamped on every inbound event's `sender.sender_id` and is
 * stable across renames AND shared tenant-wide, so it maps the sender to the one
 * locally-configured sibling that learned the same union_id, whose live
 * `bots-info.json` entry is rewritten by its OWN daemon on every rename
 * (setBotRenamer → writeBotInfoFile). That is the freshest cross-process name.
 *
 * Matches exactly one sibling (same ambiguity guard as isVerifiedLocalSiblingBot).
 * Returns undefined on empty/unknown union_id, ambiguity, or a missing bots-info
 * entry, so the caller falls back to the cross-ref / "Bot". Cross-deployment team
 * peers aren't locally configured, so they return undefined here and rely on the
 * cross-ref (whose stale aliases the writer now evicts on the next @ by new name).
 */
export function resolveSiblingBotNameByUnionId(
  dataDir: string,
  larkAppId: string,
  senderUnionId: string | undefined,
): string | undefined {
  const unionId = (senderUnionId ?? '').trim();
  if (!unionId) return undefined;

  // union_id → the single locally-configured sibling appId that learned it.
  let siblingAppId: string | undefined;
  try {
    for (const cfg of loadBotConfigs()) {
      const appId = (cfg.larkAppId ?? '').trim();
      if (!appId || appId === larkAppId) continue;
      if (getBotUnionId(dataDir, appId) === unionId) {
        if (siblingAppId) return undefined; // two siblings share a union_id → ambiguous
        siblingAppId = appId;
      }
    }
  } catch {
    return undefined;
  }
  if (!siblingAppId) return undefined;

  // appId → current botName from the shared, rename-fresh bots-info.json.
  try {
    const infoPath = join(dataDir, 'bots-info.json');
    if (existsSync(infoPath)) {
      const entries: Array<{ larkAppId?: string; botName?: string | null }> =
        JSON.parse(readFileSync(infoPath, 'utf-8'));
      const name = entries.find(e => e.larkAppId === siblingAppId)?.botName;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  } catch { /* fall through to caller's cross-ref path */ }
  return undefined;
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
 *
 * 调用方只剩 {@link evaluateBotTalk} 一个（bot 闸门的唯一入口）；(1) 的两条腿与
 * evaluateTalk 的 teamBot 腿重合，真正额外放行的是 (2)。保留本谓词是因为它是
 * 「bot 团队信任」的定义所在，且有专属单测（team-peer-trust / platform-team-trust）。
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

  // Update with new mentions that match known bot names
  const entries: Array<{ name: string; openId: string }> = [];
  for (const m of mentionsList) {
    const name = m.name;
    const openId = mentionOpenId(m);
    if (!name || !openId) continue;
    if (!knownBotNames.has(name.toLowerCase())) continue;
    entries.push({ name, openId });
  }

  if (entries.length > 0) {
    try {
      if (mergeBotOpenIdCrossRef(dataDir, larkAppId, entries)) {
        logger.debug(`Updated bot open_id cross-ref for ${larkAppId}`);
      }
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

  // Early-warning: today's WS events carry mention.id as an object; the REST
  // API carries a bare string. A string-form id on the event path means Lark
  // has converged the event onto the REST shape — surface it (once) so a silent
  // @-routing regression announces itself even though the shared gate absorbs it.
  const mentions: any[] = message?.mentions ?? [];
  if (!warnedStringMentionShape && mentions.some((m: any) => typeof m?.id === 'string')) {
    warnedStringMentionShape = true;
    logger.warn(`[${larkAppId}] mention.id arrived in string form on the event path — Lark may have converged the WS event onto the REST shape. mentionOpenId() absorbs it, but verify group @-routing. (logged once per process)`);
  }

  // Single source of truth shared with the poll + dashboard-preview legs.
  return messageMentionsBot(message, larkAppId, botOpenId);
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
    const appId = mentionAppId(m, larkAppId);
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
          if (!uid || uid === botOpenId || uid === larkAppId || uid === 'all') continue;
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

// 替身触发只认「发送者本人当场亲手 @」的消息类型：text（纯文本）/ post（富文本）。
// 转发一张卡片（interactive）或合并转发（merge_forward）时，飞书会把被转发内容
// 里原本的接收人 / at-node 继承进这条消息的顶层 mentions —— 那不是发送者真的
// @ 了替身对象（用户实测：卡片里灰色的「发送给:@某某」被当成了真 @，凭空触发替身
// 在话题外回复）。这类消息一律不触发替身，避免转发误触发。
const SUBSTITUTE_TRIGGER_MESSAGE_TYPES = new Set(['text', 'post']);

export function resolveSubstituteTrigger(
  larkAppId: string,
  message: any,
): import('../../types.js').SubstituteTrigger | undefined {
  const cfg = getBot(larkAppId).config.substituteMode;
  if (!cfg?.enabled || !cfg.targets?.length) return undefined;
  const messageType = message?.message_type ?? message?.msg_type;
  if (!SUBSTITUTE_TRIGGER_MESSAGE_TYPES.has(messageType)) return undefined;
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

function isSubstituteExcludedChat(cfg: { excludedChats?: string[] } | undefined, chatId: string): boolean {
  return cfg?.excludedChats?.includes(chatId) ?? false;
}

function isSubstituteAllowedChat(cfg: { chats?: string[]; excludedChats?: string[] } | undefined, chatId: string): boolean {
  // 黑名单先判且 deny-wins：命中即整段替身触发块短路（连带跳过其后的运行态
  // 开关 isSubstituteEnabledForChat），因此配置黑名单 = 硬关闭，/substitute on
  // 也翻不回来。对普通群与话题群一视同仁，与白名单同层。
  if (isSubstituteExcludedChat(cfg, chatId)) return false;
  if (!cfg?.chats?.length) return true;
  return cfg.chats.includes(chatId);
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

/** 会话类型（与 daemon / DaemonSession 的 chatType 同域）。p2pOpen 腿据此判定。 */
export type ChatKind = 'group' | 'p2p';

/**
 * 全部 talk 放行源的**运行时**枚举（TalkReason 由它派生）。
 *
 * 之所以是数组而不是纯 type：`test/bot-talk-parity.test.ts` 按它逐条核对
 * 「这条腿对人和对 bot 分别是什么行为」，少一格就红。tsconfig 的 include 只有
 * `src/**`，测试不过 tsc——纯类型层的穷尽约束在这里执行不了，必须落到运行时。
 *
 * 新增一条 talk 源时：改 evaluateTalk（人/bot 同时生效）+ 在那张表补一格说明，
 * **不要**去 bot 路由闸里加 OR 腿（那正是 allowedChatGroups 漏掉的老路）。
 */
export const TALK_REASONS = [
  'allowedUser',
  'oncall',
  'peer',
  'teamBot',
  'teamMember',
  'allowedChatGroup',
  'open',
  'chatGrant',
  'globalGrant',
  'p2pOpen',
  'none',
] as const;

export type TalkReason = typeof TALK_REASONS[number];

export interface TalkEvaluation {
  allowed: boolean;
  reason: TalkReason;
  quotaKey?: string;
  /**
   * 仅在 reason==='oncall' 且命中 quotaKey 时可能为 true：本 oncall 用户在**同群**还持有一条
   * 「未过期的显式 chatGrant」。oncall 与 chatGrant 共用同一把 chat quotaKey，owner 给 oncall
   * 用户 /grant「不限」时磁盘上无 quota 记录（= 显式不限），若额度层再按 messageQuota.defaultLimit
   * 懒初始化就会把「显式不限」静默套回 default。带上这个标志让额度层对这种交集**不兜 default**。
   * 显式 N 授权已有 quota 记录，consumeQuota 直接消费现有记录，与本标志无关。
   */
  explicitGrantOverride?: boolean;
  /**
   * 仅在 reason==='oncall' 且该用户同群持有一条**已过期** chatGrant 时给出：透传给
   * consumeQuota，由它在**同一把额度锁内**以「当前 expiry」为权威判定——当前 expiry<=now 则原子清
   *「成员+quota+expiry」并回落 oncall default；当前无 expiry/未来 expiry 则该 grant 仍 live（成员在→
   * 不兜 default 按现有记录/不限消费；成员已被清→普通 oncall→回落 default）。收口进一把锁，杜绝跨
   * await 用陈旧 ev 决策，也不会让过期成员关系残留成永久授权。（pure chatGrant/globalGrant 的过期走
   * grantNotExpired 拒发。）
   */
  expiredGrantCleanup?: { scope: 'chat'; chatId: string; openId: string };
  /**
   * 仅会话群继承腿会给出：这条 chatGrant **实际所在**的 chat（= 出生前那个私聊），
   * 与本次判定的 chatId（会话群）不是同一个。额度耗尽后的 revoke 必须落在它上面，
   * 否则会去删一条会话群上根本不存在的授权 —— 撤销静默失效、硬上限形同虚设。
   */
  grantChatId?: string;
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
  if (!chatId || !openId || !getBot(larkAppId).config.chatGrants?.[chatId]?.includes(openId)) return false;
  return grantNotExpired(larkAppId, 'chat', chatId, openId, chatQuotaKey(chatId, openId));
}

/** 全局对话授权命中判断（人/bot 通用，仅用于 canTalk / bot 路由闸 —— 不给管理命令权）。 */
function hasGlobalGrant(larkAppId: string, openId: string | undefined): boolean {
  if (!openId || !getBot(larkAppId).config.globalGrants?.includes(openId)) return false;
  return grantNotExpired(larkAppId, 'global', undefined, openId, globalQuotaKey(openId));
}

/**
 * oncall 群命中的 talk 判定（chat 维度、与发送者无关）。抽成函数是为了让**会话群**的
 * 存量条目能原样复用旧语义，见 evaluateSessionGroupTalk 的兜底分支。
 */
function oncallTalk(
  bot: ReturnType<typeof getBot>,
  larkAppId: string,
  chatId: string,
  senderOpenId: string | undefined,
): TalkEvaluation {
  const def = bot.config.messageQuota?.defaultLimit;
  if (typeof def === 'number' && Number.isInteger(def) && def > 0 && senderOpenId) {
    // 交集处理：同群若还持有显式 chatGrant，额度由授权决定而非 oncall default。
    // 三态：live 显式授权 → explicitGrantOverride（不兜 default）；已过期 → expiredGrantCleanup
    //（透传给 consumeQuota，锁内以当前 expiry 为准原子清成员+quota+expiry 并回落 default）；
    // 非成员 → 无覆盖，正常走 oncall default 懒初始化。
    const gk = chatQuotaKey(chatId, senderOpenId);
    const isMember = !!bot.config.chatGrants?.[chatId]?.includes(senderOpenId);
    const exp = isMember ? getGrantExpiresAt(larkAppId, gk) : undefined;
    if (isMember && exp !== undefined && Date.now() >= exp) {
      return {
        allowed: true, reason: 'oncall', quotaKey: gk,
        expiredGrantCleanup: { scope: 'chat', chatId, openId: senderOpenId },
      };
    }
    return { allowed: true, reason: 'oncall', quotaKey: gk, explicitGrantOverride: isMember };
  }
  return { allowed: true, reason: 'oncall' };
}

/**
 * 会话群（p2pMode='group' 出生的一人一 bot 群）的 talk 判定 —— 必须排在 oncall 腿之前。
 *
 * 会话群是 bot 为**某一个人的某一次授权**临时开的房间，出生时会顺手写一条 oncall 绑定
 * 来承载 workingDir。若照常走 oncall 腿，那条纯粹为「解目录」而写的绑定就变成了 talk 来源：
 *   • oncall 只看 chatId 不看发送者 → 群里**任何人**（被拉进来的同事）都能免授权发言；
 *   • 未配 messageQuota.defaultLimit → 无 quotaKey → 完全不限额；配了也是**每个新群一份
 *     全新额度**（key 是 chat:<新群>:<user>，与私聊那把 chat:<dm>:<user> 不共享计数）；
 *   • reason 从 chatGrant/globalGrant 变成 oncall → restrictGrantCommands 这道闸静默失效。
 * 一条私聊即可确定性触发，且 oncall 绑定永久留存（onClose 默认 keep）。
 *
 * 因此这里改成：**只有群主（出生时那个 DM 用户）**被放行，且沿用出生时持久化下来的原授权
 * —— 原 quotaKey（同一个计数器）、原 reason（restrictGrantCommands 照旧判定）、原 chat 上的
 * 到期与撤销（hasChatGrant/hasGlobalGrant 每条消息实时复查，owner 一撤销/一过期立即失效）。
 * oncall 在会话群里退回它本来的职责：只解析 workingDir。
 *
 * 返回 undefined = 本腿不表态，继续按 evaluateTalk 的其余通用腿判定（但**不再回落 oncall**）。
 */
function evaluateSessionGroupTalk(
  bot: ReturnType<typeof getBot>,
  larkAppId: string,
  chatId: string,
  senderOpenId: string | undefined,
  entry: { ownerOpenId: string; originReason?: string; originQuotaKey?: string; originChatId?: string },
): TalkEvaluation | undefined {
  // 非群主：这一腿不表态，也不会再落到 oncall —— 被拉进来的人要么自己有授权（用自己的
  // quotaKey 走 chatGrant/globalGrant 腿），要么发不了言。
  if (!senderOpenId || senderOpenId !== entry.ownerOpenId) return undefined;

  // 落盘字段按 string 存（避免与 event-dispatcher 形成 import 环），读回来要校验：
  // 认不出的值一律当「没有 provenance」走下面的存量兜底，绝不据此直接放行。
  const reason = (TALK_REASONS as readonly string[]).includes(entry.originReason ?? '')
    ? entry.originReason as TalkReason
    : undefined;
  if (reason === 'chatGrant') {
    // 实时复查来源私聊上的那条授权：撤销 / 到期都在这里生效（grantNotExpired 还会按
    // **来源 chatId** 排一次条件式清理，不会误删别的 chat 的记录）。
    const originChatId = entry.originChatId;
    if (!originChatId || !hasChatGrant(larkAppId, originChatId, senderOpenId)) return undefined;
    return {
      allowed: true,
      reason: 'chatGrant',
      quotaKey: entry.originQuotaKey ?? chatQuotaKey(originChatId, senderOpenId),
      grantChatId: originChatId,
    };
  }
  if (reason === 'globalGrant') {
    if (!hasGlobalGrant(larkAppId, senderOpenId)) return undefined;
    return {
      allowed: true,
      reason: 'globalGrant',
      quotaKey: entry.originQuotaKey ?? globalQuotaKey(senderOpenId),
    };
  }
  if (reason && reason !== 'none') {
    // 出生时就不带额度的来源（p2pOpen / open / allowedUser / teamMember …）：沿用原
    // reason 放行、不挂 quotaKey —— 与这个人在私聊里的待遇一字不差，不新增也不收紧。
    return { allowed: true, reason };
  }
  // 存量会话群：provenance 是本次修复才加的字段，升级前出生的条目没有它。回退到旧的
  // oncall 语义，但**只对群主**生效（群里其他人的绕过口子照样堵死），以免升级瞬间把已有
  // 会话群全部打成「无权发言」。这些群仍是每群一份额度，直到重新出生 —— 已知且有界。
  if (!findOncallChat(larkAppId, chatId)) return undefined;
  return oncallTalk(bot, larkAppId, chatId, senderOpenId);
}

const expiryCleanupInFlight = new Set<string>();

/**
 * 到期判断是同步安全边界：过期后本条消息立即拒绝；持久化清理由带 observedExpiresAt
 * 条件的原子 RMW 异步完成，避免误删刚续期的授权。
 */
function grantNotExpired(
  larkAppId: string,
  scope: 'chat' | 'global',
  chatId: string | undefined,
  openId: string,
  grantKey: string,
): boolean {
  const expiresAt = getGrantExpiresAt(larkAppId, grantKey);
  if (expiresAt === undefined || Date.now() < expiresAt) return true;
  const cleanupKey = `${larkAppId}:${grantKey}:${expiresAt}`;
  if (!expiryCleanupInFlight.has(cleanupKey)) {
    expiryCleanupInFlight.add(cleanupKey);
    void removeExpiredGrant(larkAppId, scope, chatId, openId, expiresAt)
      .then(result => {
        if (!result.ok) logger.warn(`[grant:${larkAppId}] expiry cleanup failed key=${grantKey} reason=${result.reason}`);
      })
      .catch(err => logger.warn(`[grant:${larkAppId}] expiry cleanup failed key=${grantKey}: ${err}`))
      .finally(() => expiryCleanupInFlight.delete(cleanupKey));
  }
  return false;
}

/** 整群 talk 授权命中判断（裸 `/grant` 写入的 allowedChatGroups）。chat 维度、sender 无关，
 *  与 oncall 同一个安全模型：只放行 canTalk / bot 路由闸，canOperate 绝不读它。 */
function hasAllowedChatGroup(larkAppId: string, chatId: string | undefined): boolean {
  return !!chatId && !!getBot(larkAppId).config.allowedChatGroups?.includes(chatId);
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
    || (bot.config.globalGrants?.length ?? 0) > 0
    // p2pOpen 也是一次显式的权限边界声明：配了它 = 进入限制态。否则「只配 p2pOpen、
    // 没配 allowedUsers」会 fall through 到 open 模式，把**群聊**和 **canOperate** 一起
    // 放开（陌生人能 /restart /cd），与 p2pOpen「只开私聊 talk」的语义正好相反。
    // 此时若没配 allowedUsers → 谁都不能 operate（fail-closed），bot-registry 会告警。
    || bot.config.p2pOpen === true;
}

export function canTalk(
  larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined,
  senderUnionId?: string, memberUnionId?: string, chatType?: ChatKind,
): boolean {
  return evaluateTalk(larkAppId, chatId, senderOpenId, senderUnionId, memberUnionId, chatType).allowed;
}

/**
 * @param senderUnionId  BOT-trust union（teamBot 腿）——调用方必须已按 sender_type
 *   锁定为「飞书盖章的 bot 发送方」（daemon 的 teamTrustUnionId），否则恶意成员把
 *   真人 union 报成 bot 就能让真人继承 bot 信任。
 * @param memberUnionId  发送方 union（teamMember 腿）——可为真人 union（未锁 bot）。
 *   授 talk、不授 operate，要求 union 与本 bot 同属一个平台团队（memberUnionIds
 *   来自平台鉴权的团队成员，非机器自报），不限 chat，故喂真人 union 是安全的。
 * @param chatType  当前会话类型。**仅 p2pOpen 腿读它**；省略时该腿不生效（fail-closed），
 *   所以拿不到 chatType 的调用点保持原语义、不会误放行。
 */
export function evaluateTalk(
  larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined,
  senderUnionId?: string, memberUnionId?: string, chatType?: ChatKind,
): TalkEvaluation {
  const bot = getBot(larkAppId);
  // allowedChatGroups 是"talk-open 的 chat_id 列表"：当前消息来自其中之一即放行（仅 canTalk）。
  // 成员关系隐含在"能在该 chat 发言"里 —— 退群者发不了言自动失权，新人进群即生效，无需成员快照。
  const allowedUsers = bot.resolvedAllowedUsers;
  if (senderOpenId && allowedUsers.includes(senderOpenId)) return { allowed: true, reason: 'allowedUser' };
  // 会话群专用腿，**必须排在 oncall 之前**：会话群里的 oncall 绑定只是出生时为了
  // 承载 workingDir 写下的，不能当作 talk 来源（详见 evaluateSessionGroupTalk）。
  // 命中会话群时无论表不表态，都不再回落 oncall 腿。
  const sessionGroup = chatId ? getSessionGroup(chatId) : undefined;
  if (sessionGroup) {
    const inherited = evaluateSessionGroupTalk(bot, larkAppId, chatId!, senderOpenId, sessionGroup);
    if (inherited) return inherited;
  } else if (chatId && findOncallChat(larkAppId, chatId) && !isGoalChat(chatId)) {
    // Oncall 群命中：默认不限额；仅当 bot 配了 messageQuota.defaultLimit 时，
    // 才挂 chat:<chatId>:<openId> 这一 quotaKey（与 chatGrant 同键、同计数器，
    // 便于 owner 后续 /grant @x N 续杯/重置）。
    return oncallTalk(bot, larkAppId, chatId, senderOpenId);
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
  // 平台团队成员（人）：发送者 union_id 与本 bot 同属某平台团队 → talk 免 grant，
  // 不限群（手动建群 / 原生 /invite 拉的群同样生效，不再要求群 ∈ 平台登记的
  // groupChatIds）。作用域锚在「团队共属」：本 bot ∈ team.bots ∧ 发送者 ∈ 同队
  // memberUnionIds（isPlatformTeamMember 要求同一 team 同时成立），跨团队不泄漏。
  // 只放 talk：canOperate 不引这一腿，/restart 等仍限 allowedUsers。
  if (memberUnionId && isPlatformTeamMember(config.session.dataDir, larkAppId, memberUnionId)) {
    return { allowed: true, reason: 'teamMember' };
  }
  if (hasAllowedChatGroup(larkAppId, chatId)) return { allowed: true, reason: 'allowedChatGroup' };

  // p2pOpen：私聊维度的 talk-open，与 oncall（群维度）同一个安全模型——放行 canTalk，
  // canOperate 一行不读它（管理仍限 allowedUsers）。谁能私聊由飞书应用「可用范围」控制。
  // chatType 省略 → 该腿不生效（fail-closed），未接入 chatType 的调用点语义不变。
  if (chatType === 'p2p' && bot.config.p2pOpen === true) return { allowed: true, reason: 'p2pOpen' };

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

/**
 * BOT 发送方的 talk 判定 —— bot 路由闸（外部 bot @ 本 bot）的**唯一**入口。
 *
 * = 人侧 evaluateTalk 的完整模型 ＋ 一条 bot 专属腿。历史上 bot 侧手抄了一份
 * talk 源子集（oncall / peer / teamBot / chatGrant / globalGrant 的 OR 链），
 * 于是每加一条新 talk 源就漏一次、复发一次同类 bug：oncall 漏过一次、开放模式
 * 漏过一次、allowedChatGroups 又漏一次（owner 整群 `/grant` 后真人能说话、外部 bot
 * 一 @ 仍弹授权卡）。收敛成单一谓词后，**新增 talk 源只需改 evaluateTalk**；
 * test/bot-talk-parity.test.ts 按 TALK_REASONS 逐条盯着这条约束。
 *
 * 与人侧仅有的两条差异，都是刻意的，改动前先读：
 *
 *  1. `isTrustedTeamBotSender`（+，bot 才有）：其中真正额外放行的是**团队拉群**那条腿
 *     ——本群是团队拉群（团队掌控成员）→ 说话的 botmux bot 即视为背书队友，首次接触
 *     也放行，与 oncall 群豁免同构。chat 维度、不看 union，覆盖 sender 事件没带
 *     `union_id` 的情况（此时 gate 前那次 `recordTeamBot` 被 `senderUnionId &&` 短路，
 *     evaluateTalk 的 teamBot 腿必然落空）。**这条不能下沉进 evaluateTalk**：那是人/bot
 *     共用的，加进去等于团队群里任何真人都自动过 canTalk，绕开 teamMember 腿的成员校验
 *     （isPlatformTeamMember 要求 union 与本 bot 同属一个平台团队）。它另外两条 union 锚定
 *     的腿与 evaluateTalk 的 teamBot 腿重合，留着是为了让「bot 团队信任」只有一处定义。
 *
 *  2. `p2pOpen`（−）：不传 chatType → 该腿 fail-closed 不生效。飞书里 bot 之间不存在
 *     私聊，开着只是白扩边界。
 *
 * @param senderUnionId 必须是飞书盖章的 bot 发送方 union（`sender_type ∈ app|bot`），
 *   与 evaluateTalk 的 bot-trust 腿同一契约。真人 union 走 memberUnionId，本函数恒不传。
 */
export function evaluateBotTalk(
  larkAppId: string,
  chatId: string | undefined,
  senderOpenId: string | undefined,
  senderUnionId?: string,
): TalkEvaluation {
  const ev = evaluateTalk(larkAppId, chatId, senderOpenId, senderUnionId);
  if (ev.allowed) return ev;
  return isTrustedTeamBotSender(config.session.dataDir, chatId, senderUnionId)
    ? { allowed: true, reason: 'teamBot' }
    : ev;
}

/** ask 答复者身份上下文（文字作答路径带，卡片点击路径不带）。与 ask-broker 的
 *  AskAnswerActor 同形；放这里是为了让「ask 答复的 talk 分派」有一个生产共用真源，
 *  daemon wiring 与回归测试都调 {@link evaluateAskAnswerTalk}，不各自手抄分派。 */
export interface AskAnswerActorContext {
  botSender?: boolean;
  senderUnionId?: string;
  memberUnionId?: string;
}

/**
 * `botmux ask` 答复者是否可作答（= 该 chat 的 canTalk 门）——ask-broker 注入的
 * canTalkChecker 的**唯一生产实现**，daemon bootstrap 一行转调它。
 *
 * 抽成独立导出函数（而非把分派内联进 daemon setter 闭包）的意义：让**分派谓词本身**
 * 能被回归测试直接咬住——测试对本函数喂真实 team store 状态断言三组行为，改坏这里的
 * 分派逻辑（如退回旧 evaluateTalk / 不认 actor.botSender）会立刻红。注意测试只覆盖到
 * 本函数；daemon setter 的一行转调与 submitCustomReply 的 actor 构造仍靠人工核对
 * （setter 只有一行，不经测试机械覆盖）。
 *
 *  - bot 发送方（actor.botSender）→ evaluateBotTalk（含团队拉群那条 chat 维度腿，
 *    覆盖 sender 事件没带 union_id 的场景），与 dispatcher 外层闸 / quota 复查同源。
 *  - 人 / 无 actor（卡片点击路径）→ evaluateTalk 全模型：actor.senderUnionId 走
 *    teamBot 腿（人路径恒 undefined）、actor.memberUnionId 走 teamMember 腿。
 *    actor 省略时两者都是 undefined → 退化为纯 evaluateTalk(openId, chatType)，
 *    与本次改动前的卡片点击语义完全一致。
 */
export function evaluateAskAnswerTalk(
  larkAppId: string,
  chatId: string | undefined,
  senderOpenId: string | undefined,
  chatType?: ChatKind,
  actor?: AskAnswerActorContext,
): boolean {
  return actor?.botSender
    ? evaluateBotTalk(larkAppId, chatId, senderOpenId, actor.senderUnionId).allowed
    : evaluateTalk(larkAppId, chatId, senderOpenId, actor?.senderUnionId, actor?.memberUnionId, chatType).allowed;
}

/** 一条 thread reply 被判定为「待答 ask 的文字答复」后，拦截器需要的三个已收窄值。 */
export interface AskCustomReplyCandidate {
  senderOpenId: string;
  chatId: string;
  text: string;
}

/**
 * 这条 thread reply 能不能被待答 ask 当成「自定义回复」吞掉——handleThreadReply
 * 里那道拦截器的唯一生产判据。
 *
 * 命中时该消息会走 submitCustomReply settle 掉 ask，**不再**作为新一轮输入转发给
 * CLI。因此只有**真正的纯文字答复**才可以被吞：
 *
 *  - `resourceCount > 0` 一律不吞。文件 / 图片消息也有非空正文（解析器给的
 *    `[文件 1: x.pdf]` / `[图片 1]` 占位文本），只看文本非空会让成员在旧操作卡
 *    有效期内发的新附件被当成旧问题的答案消费掉：新资料不进附件路由，旧 ask 被
 *    一段占位文本 settle。带资源的消息必须落回正常消息 / 附件路由。
 *  - workflow grill 触发（`/workflow [new] <目标>`）不吞：grill 分支只改写
 *    promptContent 后 fall-through，cmdContent 仍是字面量，被吞掉 grill 就永远
 *    不启动。
 *  - 没有 senderOpenId / chatId 时不吞：答复权限与 ask 归属都无从判定。
 *
 * 抽成导出谓词（而非把条件内联进 daemon）的意义与 {@link evaluateAskAnswerTalk}
 * 一致：让**判据本身**能被回归测试直接咬住。拦截命中后的鉴权仍在 broker 内由
 * canTalkChecker 判定，本函数不涉及权限。
 */
export function askCustomReplyCandidate(input: {
  senderOpenId: string | undefined;
  chatId: string | undefined;
  cmdContent: string;
  resourceCount: number;
  isWorkflowGrillTrigger: boolean;
}): AskCustomReplyCandidate | undefined {
  if (!input.senderOpenId || !input.chatId) return undefined;
  if (input.isWorkflowGrillTrigger) return undefined;
  if (input.resourceCount > 0) return undefined;
  const text = input.cmdContent.trim();
  if (!text) return undefined;
  return { senderOpenId: input.senderOpenId, chatId: input.chatId, text };
}

export function canOperate(
  larkAppId: string,
  _chatId: string | undefined,
  senderOpenId: string | undefined,
  senderUnionId?: string | undefined,
): boolean {
  const bot = getBot(larkAppId);
  // 同部署 cross-ref / isKnownPeerBot 只证明「这是一个可路由的 bot 身份」，仅供
  // evaluateTalk 的 peer 腿使用，绝不能隐式升级为管理权限。需要让编排者执行
  // /repo /cd /restart 等命令时，必须命中下面显式支持 operate 的权限源。
  //
  // 跨部署「团队 peer bot」互信 operate（覆盖编排者给
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
 * Daemon 命令统一闸：canOperate 恒放行；此外，bot 配置的 `canTalkDaemonCommands`
 * 名单内的命令降到 canTalk 判定（oncall / allowedChatGroup / grant / p2pOpen 等
 * 对话放行腿命中即可）。名单外或未配置 → 与 canOperate 完全等价（现状不变）。
 *
 * 只作用于 daemon.ts 两条路由的 DAEMON_COMMANDS 统一闸；在统一闸之前特判的命令
 * （/vc-auth /term）与 handler 内部自带 owner 闸的命令（/card /insight）
 * 不受影响——内部闸仍是最终权威（fail-closed）。
 *
 * chatType 省略时 p2pOpen 腿不生效（fail-closed），与 canTalk 语义一致——
 * 私聊路径的调用点必须把 chatType 传进来。
 *
 * botSender：降权到 talk 判定这一段，必须与 dispatcher 外层闸 / quota 复查用**同一个**
 * 谓词。bot 发送方走 evaluateBotTalk（含团队拉群那条 chat 维度腿，覆盖 sender 事件没带
 * union_id 的情况）；否则「团队拉群里外部 bot 能 talk 却执行不了降权到 canTalk 的命令
 * （如 /status）」——单一 talk 谓词在这道 daemon 命令闸继续分叉。不传（人的路径）→
 * 原样走 canTalk / evaluateTalk，语义不变。canOperate 那段人/bot 通用，不受影响。
 *
 * `/repo` 另有一个更窄的同部署 sibling bot 例外：仅当飞书事件把发送方盖章为 bot，
 * receiver cross-ref 命中 sender open_id，且 sender union_id 精确匹配当前仍配置的唯一
 * 本机 sibling app 已学习的自身 union_id 时放行；不把 sibling 提升为 canOperate，也不把其他 daemon 命令降权。
 */
export function canRunDaemonCommand(
  larkAppId: string,
  chatId: string | undefined,
  senderOpenId: string | undefined,
  senderUnionId: string | undefined,
  cmd: string,
  memberUnionId?: string | undefined,
  chatType?: 'p2p' | 'group',
  botSender?: boolean,
  larkStampedBotSender?: boolean,
): boolean {
  if (canOperate(larkAppId, chatId, senderOpenId, senderUnionId)) return true;
  if (cmd === '/repo' && larkStampedBotSender === true
    && isVerifiedLocalSiblingBot(config.session.dataDir, larkAppId, senderOpenId, senderUnionId)) {
    return true;
  }
  const list = getBot(larkAppId).config.canTalkDaemonCommands;
  if (!list?.includes(cmd)) return false;
  return botSender
    ? evaluateBotTalk(larkAppId, chatId, senderOpenId, senderUnionId).allowed
    : canTalk(larkAppId, chatId, senderOpenId, senderUnionId, memberUnionId, chatType);
}

/**
 * 入口 A：无权限者 @bot 时弹授权申请卡（正文 @owner，由 owner 处置）。
 * 受 grant-pending 节流：pending 中 / deny 冷却期内静默不发。开放模式（无 owner）兜底不发。
 */
async function maybeSendGrantRequestCard(
  larkAppId: string, message: any, chatId: string, requesterOpenId: string | undefined, messageData?: any,
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
  const profileName = mentionName || observedName
    ? undefined
    : (await getUserProfile(larkAppId, requesterOpenId).catch(() => null))?.name;
  const shortRequester = `${requesterOpenId.slice(0, 10)}…${requesterOpenId.slice(-4)}`;
  const name = mentionName ?? observedName ?? profileName ?? shortRequester;
  // 把原始消息事件挂在 pending 上：授权成功后可重放，用户无需再 @ 一遍。
  const botConfig = getBot(larkAppId).config;
  const quota = botConfig.messageQuota?.defaultLimit ?? DEFAULT_GRANT_QUOTA;
  const durationMs = botConfig.grantDefaultDurationMs ?? DEFAULT_GRANT_DURATION_MS;
  const nonce = openPending(
    larkAppId,
    chatId,
    requesterOpenId,
    quota,
    messageData,
    durationMs,
  );
  const card = buildGrantCard(
    {
      ownerOpenId: owner,
      targets: [{ openId: requesterOpenId, name: String(name) }],
      chatId,
      nonce,
      mode: 'request',
      quota,
      durationMs,
    },
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
  //
  // 若消息 @ 了别的具体成员（mentionsAnotherMember），群必然不是 1人1bot——
  // 只有群成员能被 @，多出的那个 @ 本身就是人数变化的证据。上游可能还抱着
  // 陈旧缓存 {1,1}（刚拉了新 bot 的 TTL 窗口），这会直接跳过人数查询落到
  // 'ignore'，挡住「用户 @ 新 bot、老 bot 跟着回复」。群聊 @ 策略 never/ambient
  // 在调用方（relax 条款）已先行结算，这里不受影响。
  if (isAllowed && !mentionsAnotherMember(larkAppId, message)) {
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
  /** Set when the turn folded into the group chat-scope session from a Lark
   *  thread whose root was deliberately NOT used as `replyRootId` (an
   *  after-the-fact topic). The reply stays flat, but the session must still be
   *  registered under this root so a later NON-@ message inside that topic
   *  folds back here instead of forking a new thread-scope session. */
  foldedRootId?: string;
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
  /** This turn was triggered by a configured group message listener. */
  messageListener?: MessageListenerMatch;
  /** Earlier topic seed coalesced into this root-linked clarification. */
  forwardSeedData?: any;
  /** Set by the session-group birth flow (p2pMode='group') after it has
   *  re-homed this turn from a DM into a freshly-created session group —
   *  prevents the birth logic from re-triggering on the rewritten context. */
  sessionGroupBirth?: boolean;
  /** This turn was already AUTHORIZED and CHARGED against the source DM, before
   * any session-group side effect was allowed (a quota denial must create no
   * Feishu chat). Set only by the birth flow, immediately after that gate
   * returned true — so the rewritten group turn must neither charge it twice
   * NOR re-decide authorization: the new chat cannot yet carry any chat-scoped
   * grant, so a recheck there only ever produces false negatives, and dropping
   * an already-charged turn is exactly the "charged, then lost the task"
   * failure. See enforceMessageQuotaForCliInput's alreadyAuthorizedAndCharged. */
  sessionGroupQuotaConsumed?: boolean;
  /** Session-group birth only: the in-group intro message id used as the
   *  turn's REPLY anchor (quote target / session rootMessageId), so the first
   *  turn's outputs land in the group. `messageId` stays the ORIGINAL inbound
   *  DM message id — resource downloads and merge-forward expansion must keep
   *  using it (the resource keys belong to the source message, PR review P1). */
  replyAnchorMessageId?: string;
  larkAppId: string;
  /** 本轮 inbound 的接纳阶段标记，由 daemon 的普通消息入口初始化、各接纳点翻转。
   *  必须是共享 mutable box 而非布尔字段：reroute 交接会浅拷贝 ctx
   *  （`{ ...ctx, scope, anchor }`），box 引用随拷贝共享，接纳发生在拷贝之后
   *  也能被最外层 ingress catch 看到。admitted 为 true 后该 catch 不得再提示
   *  重发——本轮已进 durable queue / worker，重发会让同一任务再次入队执行。 */
  ingressAdmission?: { admitted: boolean };
}

interface PendingForwardTopicPayload {
  data: any;
  ctx: RoutingContext;
  ownsSession: boolean;
}

function listenerRoutingContext(input: {
  data: any;
  match: MessageListenerMatch;
  chatId: string;
  messageId: string;
  chatType: 'group' | 'p2p';
  larkAppId: string;
}): PendingForwardTopicPayload {
  return {
    data: input.data,
    ctx: {
      chatId: input.chatId,
      messageId: input.messageId,
      chatType: input.chatType,
      larkAppId: input.larkAppId,
      scope: 'thread',
      anchor: input.messageId,
      messageListener: input.match,
    },
    ownsSession: false,
  };
}

const MESSAGE_LISTENER_POLL_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.BOTMUX_MESSAGE_LISTENER_POLL_INTERVAL_MS) || 30_000,
);
const MESSAGE_LISTENER_BACKFILL_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.BOTMUX_MESSAGE_LISTENER_BACKFILL_WINDOW_MS) || 30 * 60_000,
);
const MESSAGE_LISTENER_BACKFILL_SCAN_LIMIT = Math.max(
  1,
  Number(process.env.BOTMUX_MESSAGE_LISTENER_BACKFILL_SCAN_LIMIT) || 100,
);
const MESSAGE_LISTENER_BACKFILL_PAGE_SIZE = Math.min(50, Math.max(
  1,
  Number(process.env.BOTMUX_MESSAGE_LISTENER_BACKFILL_PAGE_SIZE) || 50,
));

function enabledMessageListenerChatIds(bot: BotState): string[] {
  return Object.entries(bot.config.messageListeners ?? {})
    .filter(([, listener]) => listener?.enabled === true && !!listener.prompt?.trim())
    .map(([chatId]) => chatId);
}

function messageCreateTimeMs(message: any): number | undefined {
  const raw = message?.create_time ?? message?.createTime;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function historyMessageSender(message: any): {
  senderOpenId?: string;
  senderTypeRaw?: string;
  senderIdType?: string;
} {
  const sender = message?.sender ?? {};
  // A bot sender is reported by app_id (cli_) in `sender.id`, but with
  // `with_sender_name=true` (which listChatMessagesUntil always sets) Lark also
  // returns `sender.open_bot_id` — the bot's per-app open_id, IDENTICAL to what
  // /members/bots reports and to what the dashboard bot-picker stores. Prefer it
  // so a third-party bot resolves to the same ou_ the include/exclude lists use
  // (otherwise it stays an unresolvable cli_ and never matches an open_id list).
  const senderId = sender.open_bot_id ?? sender.id ?? sender.open_id ?? sender.user_id ?? sender.app_id
    ?? message?.sender_id?.open_id ?? message?.sender_id?.user_id ?? message?.sender_id?.app_id;
  const rawIdType = sender.id_type ?? sender.sender_id_type;
  // open_bot_id is an open_id even though the row's id_type still says app_id.
  const senderIdType = sender.open_bot_id ? 'open_id' : rawIdType;
  const inferredType = sender.sender_type
    ?? message?.sender_type
    ?? (rawIdType === 'app_id' ? 'app' : undefined);
  return {
    senderOpenId: typeof senderId === 'string' ? senderId : undefined,
    senderTypeRaw: typeof inferredType === 'string' ? inferredType : undefined,
    senderIdType: typeof senderIdType === 'string' ? senderIdType : undefined,
  };
}

function larkReceiveEventFromHistoryMessage(message: any, chatId: string): any {
  const { senderOpenId, senderTypeRaw, senderIdType } = historyMessageSender(message);
  // sender_type and the ID DOMAIN are independent axes. A bot sender keeps
  // sender_type='app', but when we resolved its identity to an open_id (via
  // sender.open_bot_id, senderIdType==='open_id'), the value MUST go in the
  // open_id slot — the whole downstream chain (message-parser senderId,
  // handleNewTopic owner/quote target, --mention-back) reads sender_id.open_id
  // ONLY. Putting an ou_ into { app_id } both mislabels the field and drops the
  // identity (senderId becomes ''). Choose the key by domain, not by type.
  const isBotSenderType = senderIdType === 'app_id' || senderTypeRaw === 'app' || senderTypeRaw === 'bot';
  const isOpenIdDomain = senderIdType === 'open_id'
    || (typeof senderOpenId === 'string' && senderOpenId.startsWith('ou_'));
  return {
    message: {
      ...message,
      message_type: message?.message_type ?? message?.msg_type,
      chat_id: message?.chat_id ?? chatId,
      chat_type: message?.chat_type ?? 'group',
    },
    sender: {
      // Preserve the bot sender_type (talk/quota gates and foreign-bot owner
      // suppression key off it) even when the id itself is an open_id.
      sender_type: senderTypeRaw ?? (isBotSenderType ? 'app' : 'user'),
      sender_id: isOpenIdDomain
        ? { open_id: senderOpenId }
        : isBotSenderType
          ? { app_id: senderOpenId }
          : { open_id: senderOpenId },
    },
  };
}

async function dispatchHumanMessageViaHandlers(
  larkAppId: string,
  handlers: EventHandlers,
  payload: PendingForwardTopicPayload,
  capMs?: number,
): Promise<void> {
  await serializeByAnchor(payload.ctx.anchor, () => {
    const ownsSession = handlers.isSessionOwner?.(payload.ctx.anchor, larkAppId) ?? payload.ownsSession;
    return ownsSession
      ? handlers.handleThreadReply(payload.data, payload.ctx)
      : handlers.handleNewTopic(payload.data, payload.ctx);
  }, capMs);
}

async function dispatchPolledMessageListenerMatch(input: {
  larkAppId: string;
  handlers: EventHandlers;
  data: any;
  match: MessageListenerMatch;
  chatId: string;
  messageId: string;
}): Promise<void> {
  if (!claimMessageOnce(input.larkAppId, input.messageId)) {
    logger.debug(`[message-listener:${input.larkAppId}] polled duplicate ignored msg=${input.messageId.substring(0, 12)}`);
    return;
  }
  logger.info(
    `[message-listener:${input.larkAppId}] matched polled chat=${input.chatId.substring(0, 12)} ` +
    `msg=${input.messageId.substring(0, 12)} sender=${input.match.senderOpenId?.substring(0, 12) ?? '-'}`,
  );
  await dispatchHumanMessageViaHandlers(input.larkAppId, input.handlers, listenerRoutingContext({
    data: input.data,
    match: input.match,
    chatId: input.chatId,
    messageId: input.messageId,
    chatType: 'group',
    larkAppId: input.larkAppId,
  }));
}

async function pollMessageListenersOnce(larkAppId: string, handlers: EventHandlers, now = Date.now()): Promise<void> {
  const bot = getBot(larkAppId);
  const chatIds = enabledMessageListenerChatIds(bot);
  if (chatIds.length === 0) return;

  const cutoff = now - MESSAGE_LISTENER_BACKFILL_WINDOW_MS;
  await ensureBotOpenId(larkAppId).catch(() => { /* degrade; heartbeat retries */ });

  for (const chatId of chatIds) {
    let messages: any[];
    try {
      messages = await listChatMessagesUntil(larkAppId, chatId, {
        pageSize: MESSAGE_LISTENER_BACKFILL_PAGE_SIZE,
        stopAfter: (message, seenCount) => {
          const createdAt = messageCreateTimeMs(message);
          return seenCount >= MESSAGE_LISTENER_BACKFILL_SCAN_LIMIT ||
            (Number.isFinite(createdAt) && (createdAt as number) < cutoff);
        },
      });
    } catch (err) {
      logger.warn(`[message-listener:${larkAppId}] failed to poll chat=${chatId.substring(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Build the app_id→open_id map once per chat (shared with the dashboard
    // preview leg) so bot senders (reported by app_id in history) match sender
    // filters keyed on open_id, and unprovable bots fail closed on exclusion.
    const candidateBotAppIds = collectListenerBotAppIds(messages, historyMessageSender);
    const appIdToOpenId = await buildListenerBotAppIdToOpenId(larkAppId, chatId, candidateBotAppIds);

    for (const message of messages) {
      const messageId = String(message?.message_id ?? '');
      if (!messageId) continue;
      const createdAt = messageCreateTimeMs(message);
      if (Number.isFinite(createdAt) && (createdAt as number) < cutoff) continue;

      const data = larkReceiveEventFromHistoryMessage(message, chatId);
      const rawSender = historyMessageSender(message);
      const resolved = resolveListenerSenderIdentity(rawSender, appIdToOpenId);
      const match = evaluateMessageListener({
        bot,
        chatId,
        message: data.message,
        senderOpenId: resolved.senderOpenId,
        senderTypeRaw: rawSender.senderTypeRaw,
        senderIdentityUnverified: resolved.identityUnverified,
        explicitlyMentionedThisBot: isBotMentioned(larkAppId, data.message, resolved.senderOpenId),
      });
      if (!match) continue;

      await dispatchPolledMessageListenerMatch({
        larkAppId,
        handlers,
        data,
        match,
        chatId,
        messageId,
      }).catch(err => logger.error(`Error handling polled message listener event: ${err}`));
    }
  }
}

export async function __pollMessageListenersOnceForTest(larkAppId: string, handlers: EventHandlers, now = Date.now()): Promise<void> {
  await pollMessageListenersOnce(larkAppId, handlers, now);
}

function usesForwardFollowupDelay(mentionMode: GroupMentionMode): boolean {
  return mentionMode === 'never' || mentionMode === 'ambient';
}

/**
 * Per-app barriers that resolve once `restoreActiveSessions()` completes.
 *
 * Persisted forward-followup seeds are loaded into the in-memory buffer at
 * dispatcher startup (so root-linked clarifications can still pair with them
 * while the WS is already receiving events), but any flush — timer expiry or
 * immediate dispatch — waits for this barrier. Without it, `isSessionOwner`
 * would always return false before sessions are rehydrated, routing thread
 * replies through `handleNewTopic` and potentially duplicating sessions.
 */
const sessionsReadyBarriers = new Map<string, { promise: Promise<void>; resolve: () => void }>();
const sessionsReadyApps = new Set<string>();

/** Mark a bot's active sessions as restored so pending forward-followup seeds can flush. */
export function markForwardFollowupsSessionsReady(larkAppId: string): void {
  sessionsReadyApps.add(larkAppId);
  const barrier = sessionsReadyBarriers.get(larkAppId);
  if (barrier) barrier.resolve();
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
  resolveReplyThreadAlias?: (rootId: string, chatId: string, larkAppId: string) => { chatId: string; sessionId: string; anchor?: string } | null;
  /** True when this chat's chat-scope session already answered `rootId` as a FLAT
   *  top-level turn. Identifies the "user @'d at top level, then opened a 话题 on
   *  that same message" case, where the regular-group fold must keep the turn in
   *  the group session (as it already does) but must NOT anchor the visible reply
   *  into the after-the-fact topic. Genuine "@ inside an existing topic" turns
   *  never match. Best-effort: absent handler ⇒ legacy behavior. */
  chatSessionAnsweredRootAtTopLevel?: (rootId: string, chatId: string, larkAppId: string) => boolean;
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
  /** 授权成功后重放之前被拦截的消息，让用户无需再 @ 一遍。
   *  由 startLarkEventDispatcher 内部注入，daemon 的 cardDeps.replayGrantedMessage 调用。 */
  replayMessageEvent?: (data: any) => void;
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
  const {
    larkAppId, chatId, chatType, message, senderOpenId, messageId, routing,
    forceTopicApplied,
  } = input;
  if (forceTopicApplied) return undefined;
  // This helper only seeds a shared reply topic. A message with both fields is
  // already a reply inside a native thread; folding it would divert an owned
  // thread session back into the group lobby and split one topic's context.
  if (message?.root_id && message?.thread_id) return undefined;
  if (chatType !== 'group') return undefined;
  if (resolveRegularGroupMode(larkAppId, chatId) !== 'shared') return undefined;
  // Seeding a shared topic normally needs an @mention. But the 'never' and
  // 'ambient' mention policies answer non-@ messages too — and in shared mode it
  // must still OPEN a topic (reply in a thread reusing the chat session), not
  // fall back to a flat top-level reply. So allow non-@ seeding under 'never'
  // (unconditional) or 'ambient' — but for 'ambient' NOT when the message
  // @mentions another specific member (person/bot) without @ing us: that is a
  // redirect to someone else, so we back off (mentionsAnotherMember).
  const seedMentionMode = resolveGroupMentionMode(larkAppId, chatId);
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
  routing: { scope: 'thread' | 'chat'; anchor: string; foldedRootId?: string };
  forceTopicApplied?: boolean;
  mentionedThisBot: boolean;
  ownsThreadSession?: boolean;
  /** See EventHandlers.chatSessionAnsweredRootAtTopLevel. */
  answeredRootAtTopLevel?: (rootId: string) => boolean;
}): Promise<string | undefined> {
  const { larkAppId, chatId, chatType, message, routing, forceTopicApplied, mentionedThisBot, ownsThreadSession, answeredRootAtTopLevel } = input;
  if (forceTopicApplied || ownsThreadSession) return undefined;
  if (!mentionedThisBot) return undefined;
  if (chatType !== 'group') return undefined;
  const rootId: string | undefined = message?.root_id;
  const threadId: string | undefined = message?.thread_id;
  if (!rootId || !threadId) return undefined;
  // A genuine native Lark topic is an explicit user-created context boundary,
  // even when this bot first enters on a later reply rather than on the seed.
  // In `chat-topic` mode that boundary is honored — don't fold it into the group
  // lobby. chat / shared are documented to fold native topics into the group
  // session, so they must fall through to the regular-group fold below.
  // Synthetic/shared reply aliases do not use an omt_* thread id and always
  // continue through the fold below regardless of mode.
  if (threadId.startsWith('omt_') && resolveRegularGroupMode(larkAppId, chatId) === 'chat-topic') return undefined;
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
  // 用户先在顶层 @ 了 bot（bot 已按 mode='plain' 平铺答过这条消息），之后才在
  // **同一条消息上手动开启话题**：飞书把话题内的后续消息投递成
  // root_id=<那条原顶层消息> + thread_id=<新建 omt_>。会话折叠回群是对的（上面
  // 已完成），但此时不能再把可见回复钉进这个事后创建的话题 —— 否则用户在顶层
  // @ 得到的回复会跑进一个他并未在其中 @ 过 bot 的话题里。
  //
  // 判据要求 `inThread === false`（答那轮的 inbound 不带 thread_id），所以
  // 「@ 在既有话题里」不会命中：原生话题的开场消息虽然同样记 mode='plain'，但它
  // 带 thread_id ⇒ inThread=true。既有的话题锚定契约（chat/shared fold 用例）
  // 因此保持不变。
  //
  // 只抑制**显示锚点**，不抑制**路由归属**：仍把 rootId 作为 foldedRootId 交出去
  // 登记 alias，否则该话题内后续的非 @ 消息会查不到本会话而另起 thread 会话。
  if (answeredRootAtTopLevel?.(rootId)) {
    logger.info(
      `[reply-mode] thread root=${rootId.substring(0, 12)} was answered flat at top level; ` +
      `folding into chat=${chatId.substring(0, 12)} WITHOUT anchoring the reply into the after-the-fact topic`,
    );
    routing.foldedRootId = rootId;
    return undefined;
  }
  logger.info(`[reply-mode] mentioned thread root=${rootId.substring(0, 12)} folds into chat=${chatId.substring(0, 12)}`);
  return rootId;
}

/** Compute the scope + anchor for an inbound message:
 *   - root_id + thread_id     → thread-scope, anchor = root_id (real Lark 话题)
 *   - 话题群 + no real thread → thread-scope, anchor = message_id (thread seed)
 *   - 普通群 chat-topic + thread_id only → thread-scope, anchor = message_id
 *                               (a native user-created topic seed; other regular
 *                               -group modes fold it per regularGroupRouting)
 *   - p2p (chat, default)     → chat-scope, anchor = chat_id (整段 DM 共用一个
 *                               连续会话)
 *   - p2p thread + no real thread → thread-scope, anchor = message_id (explicit
 *                               opt-out: each DM top-level message starts a fresh
 *                               topic; a reply inside an existing thread carries
 *                               root_id+thread_id and threads into its session)
 *   - 普通群 + no real thread  → resolved regular-group mode:
 *                               new-topic uses thread-scope anchored at
 *                               message_id; chat / shared / chat-topic stay
 *                               chat-scope anchored at chat_id (shared folds into
 *                               a topic post-routing, see maybeApplySharedTopicSeed).
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
  // maybeApplySharedTopicSeed); `chat` is flat top-level; `chat-topic` (the
  // default) is also flat at top level (it only diverges for native topics,
  // where the fold is skipped — see maybeFoldMentionedRegularGroupThreadToChat). resolveRegularGroupMode
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

  // 私聊 chat 模式（默认）：整段 DM 一律折进同一个扁平 chat-scope 会话。必须先于
  // 下面的 real-thread（root_id+thread_id）分支判断 —— 否则用户在 DM 里"回复某条
  // 消息"形成的 thread 形态消息会被提前分流到 thread-scope，破坏"连续单聊会话"
  // 语义（典型触发：thread→chat 模式切换后回复旧 thread，或 Lark 给 DM 回复塞了
  // thread_id）。p2pMode 默认 'chat'；显式 'thread' 回到每条 DM 独立话题的旧行为；
  // 显式 'group'（会话群模式）与 thread 同形路由——每条顶层 DM 都是新锚点，随后由
  // handleNewTopic 的会话群出生流程把会话改道进新建的专属群。群聊不受影响。
  {
    const p2pModeForRouting = getBot(larkAppId)?.config?.p2pMode;
    if (chatType === 'p2p' && p2pModeForRouting !== 'thread' && p2pModeForRouting !== 'group') {
      return { scope: 'chat', anchor: chatId, source: 'p2p' };
    }
  }

  if (rootId && threadId) return { scope: 'thread', anchor: rootId, source: 'real-thread' };

  // 私聊 thread / group 模式（显式 opt-out）：每条 top-level DM 都视为新话题 — 跟
  // 话题群同款，匹配 Lark DM 的话题化行为，把 1:1 对话按消息拆成独立 CLI 进程
  // （group 模式的改道发生在 handleNewTopic，路由形状与 thread 一致）。
  if (chatType === 'p2p') {
    return { scope: 'thread', anchor: messageId, source: 'p2p' };
  }

  // Group chat — fetch chat_mode (cached) to disambiguate 话题群 from 普通群.
  const mode = await getChatMode(larkAppId, chatId);
  if (mode === 'topic') {
    return { scope: 'thread', anchor: messageId, source: 'topic-chat' };
  }
  // A native topic root in a regular group carries thread_id=omt_* but no
  // root_id. In `chat-topic` mode (顶层平铺连续会话；群内原生话题各自独立会话)
  // this seed must start its own thread-scope session instead of folding into
  // the group lobby — otherwise the topic's opening message lands in the shared
  // chat session and only later replies (which carry root_id and hit the
  // real-thread branch above) isolate, breaking chat-topic's own contract.
  //
  // Gated on `chat-topic` ONLY, by design (遵循 /reply-mode 配置):
  //   • chat / shared  — documented to fold native topics into the group session
  //                      (see /reply-mode help); must NOT isolate here.
  //   • new-topic      — regularGroupRouting already returns thread-scope anchored
  //                      at messageId for top-level messages, with the correct
  //                      source=regular-group-thread; letting it fall through keeps
  //                      that source (and its downstream summary/forward semantics).
  // Keep this after the topic-chat check so 话题群 seeds retain source=topic-chat
  // (and therefore autoStartOnNewTopic semantics).
  if (threadId?.startsWith('omt_') && resolveRegularGroupMode(larkAppId, chatId) === 'chat-topic') {
    return { scope: 'thread', anchor: messageId, source: 'real-thread' };
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
  const botConfig = getBot(input.larkAppId).config;
  return {
    chatKind,
    triggerText,
    range: summaryRangeFromBotConfig(botConfig),
    prompt: DEFAULT_SUMMARY_PROMPT,
    summaryMemory: botConfig.summaryMemory === true,
    summaryMemoryPath: typeof botConfig.summaryMemoryPath === 'string' && botConfig.summaryMemoryPath.trim()
      ? botConfig.summaryMemoryPath.trim()
      : 'summary.md',
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
  const forwardFollowups = new ForwardFollowupBuffer<PendingForwardTopicPayload>(
    config.daemon.forwardFollowupWaitMs,
    err => logger.error(`Error flushing delayed topic seed: ${err}`),
  );
  // Barrier that resolves once restoreActiveSessions() completes. Flushes wait
  // on it so isSessionOwner reads the populated activeSessions map. If the app
  // was already marked ready (e.g. tests or a restart within the same process),
  // resolve immediately.
  let resolveSessionsReady!: () => void;
  const sessionsReady = new Promise<void>(resolve => { resolveSessionsReady = resolve; });
  if (sessionsReadyApps.has(larkAppId)) resolveSessionsReady();
  sessionsReadyBarriers.set(larkAppId, { promise: sessionsReady, resolve: resolveSessionsReady });
  const dispatchHumanMessage = async (payload: PendingForwardTopicPayload): Promise<void> => {
    // capMs=0: forward-followup dispatch serializes STRICTLY per anchor (wait for
    // prior same-anchor work to fully settle, no 5s cap fallback to concurrent),
    // so a follow-up never races the seed's in-flight session spawn (PR #597
    // durable turn ownership/ordering). The shared helper's other caller (polled
    // message-listener) keeps serializeByAnchor's default cap.
    await dispatchHumanMessageViaHandlers(larkAppId, handlers, payload, 0);
  };
  const dispatchPersistedForwardFollowup = async (
    seedMessageId: string,
    payload: PendingForwardTopicPayload,
  ): Promise<void> => {
    // Wait for activeSessions to be rehydrated before checking ownership, so a
    // thread reply isn't misrouted to handleNewTopic during daemon startup.
    await sessionsReady;
    await dispatchHumanMessage(payload);
    removeForwardFollowup(larkAppId, seedMessageId);
  };
  // Load persisted seeds into the buffer immediately so root-linked
  // clarifications can pair with them while the WS is already receiving
  // events. Flushes (timer expiry or immediate) wait on sessionsReady above.
  for (const record of listForwardFollowups<PendingForwardTopicPayload>(larkAppId)) {
    const senderOpenId = record.payload?.data?.sender?.sender_id?.open_id as string | undefined;
    const chatId = record.payload?.ctx?.chatId;
    if (!senderOpenId || !chatId || !record.payload?.ctx?.anchor) {
      removeForwardFollowup(larkAppId, record.messageId);
      continue;
    }
    const flush = (payload: PendingForwardTopicPayload) =>
      dispatchPersistedForwardFollowup(record.messageId, payload);
    const remainingMs = record.dueAt - Date.now();
    const isUnpairedSeed = !record.payload.ctx.forwardSeedData;
    const delayStillEnabled = usesForwardFollowupDelay(resolveGroupMentionMode(larkAppId, chatId));
    if (isUnpairedSeed && delayStillEnabled && remainingMs > 0 && forwardFollowups.hold({
      larkAppId,
      chatId,
      senderOpenId,
      messageId: record.messageId,
      payload: record.payload,
      flush,
    }, remainingMs)) {
      logger.info(`[forward-followup] restored pending seed=${record.messageId.substring(0, 12)} remaining=${remainingMs}ms`);
    } else {
      void flush(record.payload).catch(err => logger.error(`Error restoring delayed topic seed: ${err}`));
    }
  }
  const seedRoutingGates = new Map<string, { ready: Promise<void>; complete: () => void }>();
  const waitForSeedRoutingGate = async (messageId: string): Promise<void> => {
    const gate = seedRoutingGates.get(messageId);
    if (!gate) return;
    const timeoutMs = Math.max(1, config.daemon.forwardFollowupWaitMs);
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      gate.ready.then(() => 'ready' as const),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      logger.warn(
        `[forward-followup] seed routing gate timed out after ${timeoutMs}ms `
        + `for root=${messageId.substring(0, 12)}; continuing without pairing`,
      );
    }
  };
  const registerSeedRoutingGate = (messageId: string) => {
    let resolveReady!: () => void;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    let completed = false;
    const gate = {
      ready,
      complete: () => {
        if (completed) return;
        completed = true;
        resolveReady();
        setTimeout(() => {
          if (seedRoutingGates.get(messageId) === gate) seedRoutingGates.delete(messageId);
        }, config.daemon.forwardFollowupWaitMs);
      },
    };
    seedRoutingGates.set(messageId, gate);
    return gate;
  };

  async function processMessageEvent(
    data: any,
    seedRoutingGate?: { ready: Promise<void>; complete: () => void },
  ): Promise<void> {
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
        const senderOpenId = sender.sender_id?.open_id ?? sender.sender_id?.app_id;
        // When Feishu gave us only an app_id (no open_id), this bot sender's
        // identity is not in the open_id domain the listener filters use, so
        // the matcher must fail closed on open_id-based exclusion. Realtime
        // events normally carry open_id; the app_id fallback is the rare case.
        const senderIdentityUnverified = !sender.sender_id?.open_id && !!sender.sender_id?.app_id;
        // Learn the sender's tenant-stable identity for cross-device delivery.
        const senderUnionId = sender.sender_id?.union_id as string | undefined;
        if (senderUnionId && sender.sender_id?.open_id) {
          let resolvedBotName: string | undefined;
          for (const [name, openId] of readBotOpenIdCrossRef(config.session.dataDir, larkAppId)) {
            if (openId === sender.sender_id.open_id) {
              resolvedBotName = name;
              break;
            }
          }
          if (resolvedBotName) {
            if (recordObservedBotUnionId(config.session.dataDir, resolvedBotName, senderUnionId, sender.sender_id.open_id)) {
              logger.info(`[bot-union-id] learned ${resolvedBotName} → ${senderUnionId} (app=${larkAppId})`);
            }
          } else {
            logger.info(`[bot-union-id] observed union_id ${senderUnionId} for openId=${sender.sender_id.open_id} (app=${larkAppId}, name unresolved — not @mentioned here yet, not recorded)`);
          }
        }
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
          void serializeByAnchor(ctx.anchor, () =>
            handlers.handleThreadReply(data, { ...ctx, chatId, messageId, chatType, larkAppId }), 0)
            .catch(err => logger.error(`Error handling message event: ${err}`));
          return;
        }
        // Learn teammate identity from team-assembled groups (the trust root):
        // any bot talking in a 拉群 group is a vouched teammate, so capture its
        // tenant-stable union_id — we then honour it as a teammate in ANY chat
        // (see team-bots-store). Done BEFORE the @mention gate so even a non-@
        // message in a team group teaches us the teammate. Cheap + idempotent.
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
        const botMessageListener = chatType === 'group'
          ? evaluateMessageListener({
              bot: getBot(larkAppId),
              chatId,
              message,
              senderOpenId,
              senderTypeRaw: sender?.sender_type,
              senderIdentityUnverified,
              explicitlyMentionedThisBot: isBotMentioned(larkAppId, message, senderOpenId),
            })
          : undefined;
        if (botMessageListener) {
          logger.info(
            `[message-listener:${larkAppId}] matched bot-sender chat=${chatId.substring(0, 12)} ` +
            `msg=${messageId.substring(0, 12)} sender=${senderOpenId?.substring(0, 12) ?? '-'}`,
          );
          await dispatchHumanMessage(listenerRoutingContext({
            data,
            match: botMessageListener,
            chatId,
            messageId,
            chatType,
            larkAppId,
          })).catch(err => logger.error(`Error handling bot message listener event: ${err}`));
          return;
        }
        // Foreign bot: only route on @mention of us — with one exception.
        //
        // 主动开工 — 场景② (bot sender): 「话题群新话题自动开工」(autoStartOnNewTopic)
        // 覆盖到「其他机器人开的新话题」。人分支在 3271 对非 @ 的话题群新话题种子做
        // 同一判定；bot 消息走本分支，若不在这里补一个等价出口，就会在下面这行 return
        // 掉——所以 bot 开的新话题永远到不了人分支的场景②。判定复用同一个纯函数
        // shouldAutoStartOnNewTopic（形态门：thread-scope + anchor===本消息 + 无会话
        // 占用，天然只认「全新话题种子」，不认话题内回复，故不会自我循环——回复锚定在
        // 话题根 anchor≠messageId），并要求飞书真的把这条非 @ 的 bot 消息推过来
        //（依赖 im:message.group_msg.include_bot:read scope；缺则事件根本不到，静默降级）。
        // sender 受授权门约束（与人分支 + 下游 enforceMessageQuotaForCliInput 同源）：
        // 授权/peer/团队/oncall/开放腿放行的 sender 才自动开工，restricted 下未授权陌生
        // bot 改发授权卡（详见下方 autoTopic 分支）。
        //
        // 收到 im:message.group_msg.include_bot:read 推来的「其他用户/机器人发的群消息」后，
        // 只有满足形态门才免 @ 自动开工；否则保持原有「未 @ 即忽略」语义。
        if (!isBotMentioned(larkAppId, message, undefined)) {
          if (getBot(larkAppId).config.autoStartOnNewTopic === true && chatType === 'group') {
            const seedDecision = await decideRoutingWithSource(larkAppId, message);
            // P3 — 镜像人分支「话题群 → 普通群 (reverse conversion)」那道 forceRefresh
            // 守卫：decideRoutingWithSource 判 topic-chat 种子靠的是**缓存** chat_mode
            //（5min TTL）。管理员把话题群翻回普通群后缓存可能仍是 'topic'，于是一条本该
            // 是普通群顶层的 bot 消息被误判成话题种子，起 thread-scope 会话把回复裹进
            //「其实已是普通群」的新 Lark 话题。无真实 thread_id（= 种子形态，非既有话题内
            // 回复，权威信号不会 stale）时用 forceRefresh 再确认；飞书现在报 'group' 就当
            // 它不是话题种子（降级），不自动开工。这道 API 往返只落在「已呈现 topic 种子
            // 形态的 opt-in 候选」上——与人分支同样的成本取舍（宁可多一次调用，也不用
            // 一个 5min 错建 session 的窗口换省一次调用）。
            let seedIsTopicChat = seedDecision.source === 'topic-chat';
            if (seedIsTopicChat && !message.thread_id) {
              const freshMode = await getChatMode(larkAppId, chatId, { forceRefresh: true });
              if (freshMode === 'group') {
                logger.info(
                  `[chat-mode-converted] ${chatId.substring(0, 12)} chat_mode flipped 'topic' → 'group'; ` +
                  `跳过 bot 新话题自动开工 msg=${messageId.substring(0, 12)}`,
                );
                seedIsTopicChat = false;
              }
            }
            // 与人分支同源：只有真正的话题群顶层种子（source==='topic-chat' 且经 forceRefresh
            // 复核仍是话题群）才是自动开工候选；普通群 /t / 新话题模式产生的同形
            // {thread, anchor=msg} 不算。
            const seedScope = seedIsTopicChat ? seedDecision.scope : 'chat';
            const seedAnchor = seedIsTopicChat ? seedDecision.anchor : chatId;
            const seedOwnsSession = seedScope === 'thread'
              ? (handlers.isSessionOwner?.(seedAnchor, larkAppId) ?? false)
              : false;
            const autoTopic = shouldAutoStartOnNewTopic({
              enabled: true,
              scope: seedScope,
              anchor: seedAnchor,
              messageId,
              chatType,
              ownsSession: seedOwnsSession,
            });
            // Sender 授权门（与人分支 + 下游 enforceMessageQuotaForCliInput 一致）：
            // 自动开工最终仍要经 handleNewTopic 里的 enforceMessageQuotaForCliInput →
            // evaluateBotTalk 复查，restricted 模式（配了 allowlist）下未授权的陌生 bot
            // 会在那里被静默 drop、session 根本不建。所以在这里**先判同一个谓词**：
            //   • allowed → 正常免 @ 自动开工（open 模式 / oncall / 整群授权 / peer /
            //     团队 bot 等任一放行腿命中，与人/下游同源）。
            //   • !allowed（restricted 下的陌生 bot）→ 不建 session，改发一次授权申请卡
            //     给 owner（节流复用 maybeSendGrantRequestCard 内的 isThrottled），让
            //     owner 决定是否把它加进 allowlist——与人分支 @bot 被挡时的 not_allowed
            //     体验一致、可发现，而不是静默吞掉。
            // 只在「真未授权」发卡；已授权但额度耗尽是另一回事（走下游 quota exhausted
            // 语义），不在这里混。授权卡的申请对象是触发 bot 的 open_id，但审批/操作权限
            // 仍只归 owner；此刻不建 session，绝不把触发 bot 写成 owner，也不 --mention-back
            // 回唤它（dispatchHumanMessage 那条才建 session，本分支只发卡后 return）。
            if (autoTopic) {
              const seedBotTalk = evaluateBotTalk(larkAppId, chatId, senderOpenId, senderUnionId);
              if (!seedBotTalk.allowed) {
                logger.info(
                  `[auto-start:新话题] ${chatId.substring(0, 12)} 其他机器人开新话题但未授权（restricted）→ 发授权卡不自动开工 ` +
                  `msg=${messageId.substring(0, 12)} sender=${senderOpenId?.substring(0, 12) ?? '-'}`,
                );
                await maybeSendGrantRequestCard(larkAppId, message, chatId, senderOpenId, data)
                  .catch(err => logger.error(`Error sending grant card for foreign-bot new topic: ${err}`));
                return;
              }
              logger.info(
                `[auto-start:新话题] ${chatId.substring(0, 12)} 其他机器人开新话题免@自动开工 ` +
                `msg=${messageId.substring(0, 12)} sender=${senderOpenId?.substring(0, 12) ?? '-'} reason=${seedBotTalk.reason}`,
              );
              const seedCtx: RoutingContext = { chatId, messageId, chatType, larkAppId, scope: seedScope, anchor: seedAnchor };
              await dispatchHumanMessage({ data, ctx: seedCtx, ownsSession: false })
                .catch(err => logger.error(`Error auto-starting on foreign-bot new topic: ${err}`));
              return;
            }
          }
          return;
        }
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
        // 这个 bot 能不能在本群跟我们说话 —— 判定一次，fold 与下面的 gate 共用同一个
        // 结论（二者之间只有 fold / shared-seed 的路由计算，不改任何授权状态）。
        // 曾经这里是两条手抄的 OR 链，靠人肉保持同步；漏一处就是「能路由但不能 fold」
        // 或「fold 了却弹卡」的二次分裂。
        const botTalk = evaluateBotTalk(larkAppId, chatId, senderOpenId, senderUnionId);
        let replyRootId = await maybeFoldMentionedRegularGroupThreadToChat({
          larkAppId, chatId, chatType, message, routing: ctx, forceTopicApplied: forcedTopic, mentionedThisBot: botTalk.allowed, ownsThreadSession,
          answeredRootAtTopLevel: root => handlers.chatSessionAnsweredRootAtTopLevel?.(root, chatId, larkAppId) ?? false,
        });
        if (!replyRootId) {
          replyRootId = await maybeApplySharedTopicSeed({
            larkAppId, chatId, chatType, message, senderOpenId, messageId, routing: ctx, forceTopicApplied: forcedTopic,
          });
        }
        // Foreign-bot @mention gate: apply the same vetted-peer/talk-only
        // boundary to chat scope, regular-group threads, and native topic
        // threads. Previously native topic replies skipped this outer gate and
        // were silently dropped by daemon's second evaluateTalk check, so the
        // owner never saw a grant card. Owning an existing session is not an
        // authorization source; a revoked/unknown bot must still pass
        // evaluateBotTalk (the single talk predicate — see its doc for the two
        // deliberate human/bot deltas) or prove itself a sibling below.
        //
        // 这里**只判 evaluateBotTalk**。以前是手抄的 OR 链，每加一条 talk 源就漏一次：
        // oncall 漏过、开放模式漏过、allowedChatGroups 又漏过（整群 /grant 后人通 bot 卡）。
        // 要加新的 talk 放行源，改 evaluateTalk（人/bot 同时生效），不要在这里加腿；
        // test/bot-talk-parity.test.ts 会盯着这条约束。
        //
        // 唯一留在闸门里的 bot 专属逻辑是下面的 cross-ref 冷启动自愈：它不是一条
        // 授权来源，而是「同部署兄弟 bot 的身份还没学到」这个**识别**问题的补救。
        if (!botTalk.allowed) {
          // Cold-start self-heal: the cross-ref (bot-openids-<appId>.json) is
          // learned lazily from observed mentions[], so the FIRST bot→bot
          // direct @ from a same-deployment sibling can arrive before the
          // receiver has learned that sibling's receiver-scoped open_id
          // (Lark open_id is per-app). That raced a real sibling into this
          // "unknown external bot" branch and mis-fired a /grant card
          // (regression from ec146a49). Before deciding unknown, confirm the
          // sender against the group's LIVE `/members/bots` roster: accept
          // only when it binds to exactly one locally-configured sibling of
          // the same unique name that independently confirms is_in_chat.
          // Fails closed to the grant card on any API error / ambiguity /
          // genuine external bot — never a name-only shortcut.
          const sibling = await resolveSiblingBotBySenderOpenId(larkAppId, chatId, senderOpenId)
            .catch((err): { ok: false; reason: string } => ({ ok: false, reason: `resolve_threw: ${err?.message ?? String(err)}` }));
          if (sibling.ok) {
            // Persist the newly-proven mapping so subsequent @s from this
            // sibling hit isKnownPeerBot directly (no live API roundtrip).
            updateBotOpenIdCrossRef(config.session.dataDir, larkAppId, [
              { name: sibling.botName, id: { open_id: sibling.senderOpenId } },
            ]);
            logger.info(`Lazy sibling cross-ref backfill: ${sibling.botName} → ${senderOpenId?.substring(0, 12)} (was cold; skipping /grant)`);
          } else {
            logger.info(`Foreign bot @mention not a known sibling (${sibling.reason}); sending grant request card`);
            await maybeSendGrantRequestCard(larkAppId, message, chatId, senderOpenId, data);
            return;
          }
        }
        logger.info(`Bot-to-bot @mention detected (scope=${ctx.scope}): routing to handleThreadReply`);
        // Serialize per anchor — a sub-bot dispatched a /repo prime + kickoff
        // back-to-back into this thread must be handled in order, not raced.
        void serializeByAnchor(ctx.anchor, () =>
          handlers.handleThreadReply(data, { ...ctx, chatId, messageId, chatType, larkAppId, replyRootId }), 0)
          .catch(err => logger.error(`Error handling bot @mention: ${err}`));
        return;
      }

      const senderOpenId = sender?.sender_id?.open_id as string | undefined;
      // 人的 union_id：平台团队成员 talk-免grant 腿（isPlatformTeamMember）要用。
      const humanSenderUnionId = sender?.sender_id?.union_id as string | undefined;
      // defaultOncall 自动绑定必须在 canTalk 权限判断前完成，否则已开 defaultOncall
      // 的群首次 @bot 时 oncallChats 中还没有该 chat → evaluateTalk 判无权限 → 误弹
      // 自助授权申请卡。ensureDefaultOncallBound 本身带 fast-path 短路且 idempotent。
      await ensureDefaultOncallBound(larkAppId, chatId, chatType).catch(err =>
        logger.warn(`[oncall:${larkAppId}] pre-permission auto-bind failed for ${chatId.substring(0, 12)}: ${err}`),
      );
      // 人的路径（bot 发送方已在上面的分支 return）：union 走 memberUnionId 腿，
      // 不进 bot-trust 腿——teamBot 只认 bot-locked union。
      const isAllowed = canTalk(larkAppId, chatId, senderOpenId, undefined, humanSenderUnionId, chatType);

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

      if (await tryHandleMentionModeCommand(larkAppId, message, senderOpenId, isAllowed)) {
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

      // /invite — 把群外 bot 拉进本群的元命令。与 /grant 同款拦截模型（仅 owner，
      // 需明确 @ 本 bot），防止进路由/spawn，也防多 bot 重复执行拉人。
      if (await tryHandleInviteCommand(larkAppId, message, senderOpenId)) {
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
      // 私聊 chat 模式：会话是扁平连续的(整段 DM 一个 chat-scope 会话),但如果这条
      // 消息本身是在某个已存在的话题里回复的(root_id+thread_id),可见回复必须落回
      // 那个话题里,而不是漏到 DM 顶层。decideRouting 已把 scope 折成 chat(会话扁平
      // 语义不变),这里只补 replyRootId 让 sendReply 用 reply_in_thread 锚回话题根。
      // 群聊侧的同类保留由 maybeFold / alias 分支处理(它们 gate chatType==='group',
      // 私聊走不到),故私聊必须在此单独补。仅 p2p:群顶层消息不该被强行塞进话题。
      if (routing.scope === 'chat' && chatType === 'p2p' && message.root_id && message.thread_id) {
        replyRootId = message.root_id;
      }
      const explicitlyMentionedThisBot = isBotMentioned(larkAppId, message, senderOpenId);
      const messageListener = chatType === 'group'
        ? evaluateMessageListener({
            bot: getBot(larkAppId),
            chatId,
            message,
            senderOpenId,
            senderTypeRaw: sender?.sender_type,
            explicitlyMentionedThisBot,
          })
        : undefined;
      if (messageListener) {
        routing.scope = 'thread';
        routing.anchor = messageId;
        routingSource = 'topic-chat';
        replyRootId = undefined;
        logger.info(
          `[message-listener:${larkAppId}] matched chat=${chatId.substring(0, 12)} ` +
          `msg=${messageId.substring(0, 12)} sender=${senderOpenId?.substring(0, 12) ?? '-'}`,
        );
      }
      // Cheap in-memory gate FIRST: skip the getChatMode roundtrip and the
      // per-chat toggle disk read entirely for bots that never configured a
      // substitute target (the overwhelming majority on the hot path).
      const substituteCfg = getBot(larkAppId).config.substituteMode;
      let substituteChatMode: 'group' | 'topic' | undefined;
      // chats 白名单在 getChatMode 之前（纯内存判断走在 API roundtrip 前），
      // 对普通群与话题群统一生效：白名单是「替身可触发的群」清单，与群形态无关。
      if (substituteCfg?.enabled === true && chatType === 'group' && isSubstituteAllowedChat(substituteCfg, chatId)) {
        const chatMode = await getChatMode(larkAppId, chatId);
        const modeSupported = chatMode === 'group'
          // 话题群支持默认开（缺省=开，normalize 只在显式 false 时关）。
          || (chatMode === 'topic' && substituteCfg.topicGroups !== false);
        if (modeSupported && isSubstituteEnabledForChat(larkAppId, chatId)) {
          substituteChatMode = chatMode as 'group' | 'topic';
        }
      }
      // 黑名单硬静默：命中黑名单的群里，一条「本该触发替身」的消息（@ 到了配置的
      // 替身对象、但没有直接 @ 本 bot）必须当作没读到——直接 return，不只是清 trigger。
      // 只清 trigger 不够：消息会继续 fall-through 到通用群消息门，若 bot 在该群有活跃
      // 会话 / 是 solo 群 / mentionMode 放开，仍会被喂进去并弹卡片（用户实测现象）。
      // 直接 @ 本 bot（explicitlyMentionedThisBot）不受影响：黑名单只静音替身代答，
      // 不静音「直接找 bot 问问题」。/substitute 命令已在上方 command 处理器拦截。
      if (substituteCfg?.enabled === true
          && chatType === 'group'
          && !explicitlyMentionedThisBot
          && isSubstituteExcludedChat(substituteCfg, chatId)
          && resolveSubstituteTrigger(larkAppId, message)) {
        logger.info(
          `[substitute:${larkAppId}] excluded chat — dropping @target message ` +
          `msg=${messageId.substring(0, 12)} chat=${chatId.substring(0, 12)}`,
        );
        return;
      }
      let substituteTrigger = substituteChatMode
        ? resolveSubstituteTrigger(larkAppId, message)
        : undefined;
      if (substituteTrigger && !explicitlyMentionedThisBot) {
        const rawText = extractMessageTextForRouting(message);
        const stripped = rawText ? stripLeadingMentions(rawText.trim(), message?.mentions ?? []).trim() : '';
        if (stripped.startsWith('/')) substituteTrigger = undefined;
      }
      if (substituteTrigger && substituteChatMode === 'topic'
          && substituteCfg?.topicActiveSessionTrigger === false
          && (handlers.isSessionOwner?.(routing.anchor, larkAppId) ?? false)) {
        // 话题里已有本 bot 活跃会话 + 用户关掉了「活跃话题也触发」：
        // 单独 @替身对象 是明确转交，必须在任何通用免 @ 规则前直接让路；
        // 只清掉 metadata 不够，1v1 群/mentionMode=never 仍会把消息喂给 bot。
        substituteTrigger = undefined;
        if (!explicitlyMentionedThisBot) {
          logger.debug(
            `[substitute:${larkAppId}] active-topic trigger disabled; backing off ` +
            `msg=${messageId.substring(0, 12)} thread=${String(routing.anchor).substring(0, 12)}`,
          );
          return;
        }
      }
      if (substituteTrigger) {
        if (substituteChatMode === 'group') {
          routing.scope = 'chat';
          routing.anchor = chatId;
          routingSource = 'regular-group-chat';
          // Top-level substitute messages need their own reply anchor so that
          // concurrent triggers from different users in the same chat-scope
          // session don't collapse or thread under the wrong message. Existing
          // real threads keep their root_id.
          replyRootId = (message.root_id && message.thread_id) ? message.root_id : messageId;
        }
        // 话题群：保持 decideRouting 的 thread-scope/话题锚点不动——替身回合
        // 直接搭该话题自己的会话（无会话则由 handleNewTopic 新开），与普通群
        // 「搭群 chat-scope 会话」同构；回复天然落回本话题，无需 replyRootId。
        const configuredTargetId = substituteTrigger.target.openId
          ?? substituteTrigger.target.userId
          ?? substituteTrigger.target.unionId
          ?? 'unknown';
        const configuredTargetForLog = JSON.stringify(configuredTargetId.slice(0, 128));
        logger.info(
          `[substitute:${larkAppId}] mention target=${configuredTargetForLog} ` +
          `msg=${messageId.substring(0, 12)} chat=${chatId.substring(0, 12)} → ${substituteChatMode === 'group' ? 'chat-scope' : `topic thread=${String(routing.anchor).substring(0, 12)}`}`,
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
      const mentionModeForAlias = resolveGroupMentionMode(larkAppId, chatId);
      if (!explicitlyMentionedThisBot
          && mentionModeForAlias !== 'always'
          && !((mentionModeForAlias === 'topic' || mentionModeForAlias === 'ambient') && mentionsAnotherMember(larkAppId, message))
          && routing.scope === 'thread' && message.root_id && message.thread_id && chatType === 'group') {
        const alias = handlers.resolveReplyThreadAlias?.(message.root_id, chatId, larkAppId) ?? null;
        if (alias) {
          const freshMode = await getChatMode(larkAppId, chatId, { forceRefresh: true });
          if (freshMode === 'group') {
            routing.scope = 'chat';
            routing.anchor = alias.anchor ?? alias.chatId;
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
        !messageListener &&
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
        answeredRootAtTopLevel: root => handlers.chatSessionAnsweredRootAtTopLevel?.(root, chatId, larkAppId) ?? false,
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

      const routingText = extractMessageTextForRouting(message);
      const strippedRoutingText = routingText
        ? stripLeadingMentions(routingText.trim(), message?.mentions ?? []).trim()
        : '';
      const isControlCommand = strippedRoutingText.startsWith('/');
      let pairedForwardSeed;
      let stalePendingSeed;
      // Require isAllowed before pairing: a root-linked clarification from a
      // sender who was /revoked within the grace window must not consume the
      // seed from the buffer or overwrite the durable paired record. The seed
      // stays in the buffer and flushes on its original timer. Paired seeds
      // only arise under never/ambient modes, where a legitimate merge always
      // requires isAllowed anyway.
      if (senderOpenId && isAllowed && message.root_id && !isControlCommand) {
        await waitForSeedRoutingGate(message.root_id);
        const pairingInput = {
          larkAppId,
          chatId,
          senderOpenId,
          rootId: message.root_id,
        };
        const pairingMentionMode = resolveGroupMentionMode(larkAppId, chatId);
        const ambientRedirect = pairingMentionMode === 'ambient'
          && !explicitlyMentionedThisBot
          && mentionsAnotherMember(larkAppId, message);
        const pairingDelayEnabled = usesForwardFollowupDelay(pairingMentionMode);
        if (pairingDelayEnabled && !ambientRedirect) {
          pairedForwardSeed = forwardFollowups.take(pairingInput);
        } else if (!pairingDelayEnabled) {
          stalePendingSeed = forwardFollowups.take(pairingInput);
        }
      }
      if (pairedForwardSeed) {
        // The clarification becomes the visible Lark topic root. The earlier
        // forwarded seed is retained only as prompt context, so the bot never
        // emits a reply under the forwarding bubble itself.
        routing.scope = 'thread';
        routing.anchor = messageId;
        routingSource = 'topic-chat';
        replyRootId = undefined;
        ownsSession = false;
        try {
          putForwardFollowup(larkAppId, {
            messageId: pairedForwardSeed.messageId,
            dueAt: Date.now(),
            payload: {
              data,
              ctx: {
                ...pairedForwardSeed.payload.ctx,
                chatId,
                messageId,
                chatType,
                larkAppId,
                scope: 'thread',
                anchor: messageId,
                replyRootId: undefined,
                forwardSeedData: pairedForwardSeed.payload.data,
              },
              ownsSession: false,
            },
          });
        } catch (err) {
          logger.warn(`[forward-followup] failed to persist provisional paired payload: ${err}`);
        }
        logger.info(
          `[forward-followup] merged seed=${pairedForwardSeed.messageId.substring(0, 12)} ` +
          `into msg=${messageId.substring(0, 12)} chat=${chatId.substring(0, 12)}`,
        );
      }

      // Permission gating — same shape as before, just keyed on
      // `ownsSession` (anchor-aware) instead of "rootId presence":
      //
      //   ownsSession + 1v1 group → relax (no @mention required)
      //   ownsSession + multi     → require @mention
      //   !ownsSession (group)    → require @mention + allowlist
      //   p2p                     → allowlist only
      if (chatType === 'group') {
        const mentionMode = resolveGroupMentionMode(larkAppId, chatId);
        // 消息里 @ 了别的具体成员,就已经证明群不是 1人1bot（只有群成员能被 @）——
        // 此刻末条 solo 放行必然不成立,而 stats 只被末条消费,直接跳过这次（可能
        // 昂贵的）人数查询。这在「刚拉了新 bot、用户 @ 新 bot」窗口里尤为重要：
        // 拦截老 bot 的同时不再为它反复刷新陈旧缓存。
        const mentionsOther = mentionsAnotherMember(larkAppId, message);
        let stats: { userCount: number; botCount: number } | null = null;
        if (ownsSession && !replyRootId && !mentionsOther && mentionMode !== 'never') {
          stats = await getGroupStats(larkAppId, chatId);
        }
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
        // handled by the first clause. `mentionMode` 已在块首解析,用于 stats
        // 惰性获取。)
        // 话题群 owned-topic 免@续话不再无条件放行（#336 引入的默认行为回归：
        // 多人群里旁人不 @ 也会触发 bot）。现在与普通群共用同一套「群聊 @ 策略」:
        // 默认 'always' 在多人群里必须 @，想要话题内免@续话就把 mentionMode 配成
        // 'topic'（下方条款已同时覆盖话题群 thread 与普通群 shared topic），
        // 'never'/'ambient' 亦按各自语义生效。1人1bot 的 solo 群仍走末条放行。
        // 注：pairedForwardSeed 仅在 never/ambient 模式下产生，且 ambient redirect
        // 已在配对前排除，故 isAllowed=true 时下方 never/ambient 条款必然放行；
        // 不在此单独加 clause，以免 isAllowed=false 时绕过权限检查。
        // 末条 solo 放行另有 `!mentionsOther` 守卫：消息 @ 了别的具体成员时,
        // 群必然不是 1人1bot（只有群成员能被 @），且是指给别人的——拦住「刚拉新 bot、
        // 缓存仍是陈旧 {1,1} 时老 bot 跟着回复」的误放行。never 条款在前已短路,
        // 故该守卫不影响「群聊 @ 策略」配置的 never 语义。
        const relax = (!!replyRootId && isAllowed)
          || (!!substituteTrigger && isAllowed)
          || !!messageListener
          || (isAllowed && mentionMode === 'never')
          || (isAllowed && mentionMode === 'ambient' && !mentionsOther)
          || (isAllowed && mentionMode === 'topic' && ownsSession && !!message.thread_id && !mentionsOther)
          || (ownsSession && isAllowed && !!stats && !mentionsOther && stats.userCount <= 1 && stats.botCount <= 1);
        if (!relax) {
          const access = await checkGroupMessageAccess(larkAppId, message, chatId, senderOpenId, humanSenderUnionId);
          if (access === 'not_allowed') {
            // 入口 A：无权限者 @bot → 弹授权申请卡（@owner），代替「无操作权限」。
            // 覆盖 ownsSession 真假两种情况，但绝不把该消息喂进已有 session。
            await maybeSendGrantRequestCard(larkAppId, message, chatId, senderOpenId, data);
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
        // 私聊被挡目前是静默丢弃：owner 不在这个 p2p 会话里，把授权申请卡 reply 回来只会
        // 发给陌生人自己（卡上的按钮又是 owner 专属），既不可用又泄露 owner —— 所以不发。
        // 真正的修法是把申请发到 owner 自己的 DM 并加 owner 维度节流，单独一个 PR 做。
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
        messageListener,
        forwardSeedData: pairedForwardSeed?.payload.data,
      };
      if (explicitlyMentionedThisBot) {
        const before = await handlers.beforeSessionTurn?.(data, ctx, { senderOpenId, explicitlyMentionedThisBot });
        if (before?.block) return;
        if (before?.anchorOverride) ctx.anchor = before.anchorOverride;
        ownsSession = handlers.isSessionOwner?.(ctx.anchor, larkAppId) ?? ownsSession;
      }
      const payload = { data, ctx, ownsSession } satisfies PendingForwardTopicPayload;
      const groupMentionMode = resolveGroupMentionMode(larkAppId, chatId);
      const shouldDelayTopicSeed = usesForwardFollowupDelay(groupMentionMode)
        && !pairedForwardSeed
        && !isControlCommand
        && !!senderOpenId
        && routingSource === 'topic-chat'
        && ctx.scope === 'thread'
        && ctx.anchor === messageId
        && !ownsSession;
      if (shouldDelayTopicSeed) {
        try {
          putForwardFollowup(larkAppId, {
            messageId,
            dueAt: Date.now() + config.daemon.forwardFollowupWaitMs,
            payload,
          });
          if (forwardFollowups.hold({
            larkAppId,
            chatId,
            senderOpenId,
            messageId,
            payload,
            flush: delayedPayload => dispatchPersistedForwardFollowup(messageId, delayedPayload),
          })) {
            logger.debug(
              `[forward-followup] holding topic seed msg=${messageId.substring(0, 12)} ` +
              `for ${config.daemon.forwardFollowupWaitMs}ms`,
            );
            return;
          }
          removeForwardFollowup(larkAppId, messageId);
        } catch (err) {
          logger.warn(`[forward-followup] persistence unavailable, dispatching immediately: ${err}`);
        }
      }

      if (pairedForwardSeed) {
        try {
          putForwardFollowup(larkAppId, {
            messageId: pairedForwardSeed.messageId,
            dueAt: Date.now(),
            payload,
          });
        } catch (err) {
          logger.warn(`[forward-followup] failed to persist paired payload before dispatch: ${err}`);
        }
        void dispatchPersistedForwardFollowup(pairedForwardSeed.messageId, payload)
          .catch(err => logger.error(`Error handling paired message event: ${err}`));
        return;
      }

      if (stalePendingSeed) {
        // The mention mode changed while a seed was held. Release the raw chat
        // ingress lane immediately, but enqueue the stale seed before the
        // current reply once session restoration is complete. Both calls append
        // synchronously to the same canonical FIFO; their handler completion is
        // deliberately not awaited by the raw lane.
        void sessionsReady.then(() => {
          void dispatchHumanMessage(stalePendingSeed.payload)
            .then(() => removeForwardFollowup(larkAppId, stalePendingSeed.messageId))
            .catch(err => logger.warn(
              `[forward-followup] failed to flush stale seed=${stalePendingSeed.messageId.substring(0, 12)}; `
              + `continuing current msg=${messageId.substring(0, 12)}: ${err}`,
            ));
          void dispatchHumanMessage(payload)
            .catch(err => logger.error(`Error handling message event: ${err}`));
        }).catch(err => logger.error(`Error awaiting restored sessions for stale seed: ${err}`));
        return;
      }

      // Serialize per anchor so two messages to the same thread/chat are
      // processed in arrival order — never concurrently. Without this a fast
      // second message interleaves with the first's async session-spawn and is
      // dropped (worker-not-ready → re-fork branch). See anchor-serializer.ts.
      // The chat-wide ingress lane protects only asynchronous routing. Once
      // canonical work has been synchronously appended to its own anchor FIFO,
      // release the raw lane so independent topics in the same chat can run
      // concurrently. Same-anchor handlers remain strictly serialized by
      // dispatchHumanMessage's canonical queue.
      void dispatchHumanMessage(payload)
        .catch(err => logger.error(`Error handling message event: ${err}`));
    } catch (err) {
      logger.error(`Error handling message event: ${err}`);
    } finally {
      seedRoutingGate?.complete();
    }
  }

  /** 授权成功后重放之前被拦截的消息，让用户无需再 @ 一遍。
   *  绕过消息去重（原消息在拦截时已 claim 过），直接重新走消息处理流程。
   *  用 setImmediate 异步执行，不阻塞卡片回调。 */
  function replayMessageEvent(data: any): void {
    setImmediate(() => {
      void processMessageEvent(data)
        .catch(err => logger.error(`Error replaying message event after grant: ${err}`));
    });
  }
  // 暴露给 daemon 的 cardDeps.replayGrantedMessage 调用。
  handlers.replayMessageEvent = replayMessageEvent;

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    // 主动开工 — 场景①: the bot was added to a chat. Hand off to the daemon,
    // which gates on the autoStartOnGroupJoin toggle + allowedUser membership.
    // Requires this event to be subscribed for the app in the Feishu console.
    'im.chat.member.bot.added_v1': (data: any) => {
      const chatIdForKey: string | undefined = data?.chat_id;
      const operatorForKey: string | undefined = data?.operator_id?.open_id;
      const eventKey = `im.chat.member.bot.added_v1:${larkAppId}:${eventIdForKey(data) ?? `${chatIdForKey ?? 'unknown'}:${operatorForKey ?? 'unknown'}`}`;
      // 飞书只把 bot.added 推给「进群的那个 bot 自己的 app」(官方文档语義,
      // codex 复审证实),且生产是 PM2「一 bot 一 daemon 进程」(daemon.ts
      // "Load the assigned bot (one daemon per bot)")——同群其他 bot 的缓存在
      // 别的进程,这里够不到,只能清自己的 key。覆盖增量其实很小:新添进群
      // 时本 bot 此前若恰有该群条目（曾被移出又拉回),避免带着上轮陈旧数放行。
      // 「拉了别的 bot 进群→存量 bot 陈旧」方向无事件信号,靠 relax 末条款的
      // mentionsAnotherMember 守卫 + TTL 兜底。
      if (chatIdForKey) invalidateChatStats(larkAppId, chatIdForKey);
      scheduleAckSafeEvent(eventKey, async () => {
      try {
        const chatId: string | undefined = data?.chat_id;
        const operatorOpenId: string | undefined = data?.operator_id?.open_id;
        if (!chatId) return;
        logger.info(`[auto-start:入群] bot added to chat=${chatId.substring(0, 12)} by ${String(operatorOpenId ?? '?').substring(0, 12)}`);
        // 进群先自动拉 owner（不受任何开工开关影响，失败仅日志）：bot 应始终
        // 处于 owner 可见的群里。放在 handleBotAdded 之前，让 autoStart 的
        // D7「群内需有 allowedUser」闸能吃到刚拉进来的 owner。
        await autoInviteOwnerOnGroupJoin(larkAppId, chatId, operatorOpenId)
          .catch(err => logger.warn(`[groups] autoInviteOwner error (bot=${larkAppId} chat=${chatId}): ${err?.message ?? err}`));
        await handlers.handleBotAdded?.(chatId, operatorOpenId, larkAppId);
      } catch (err) {
        logger.error(`Error handling bot-added event: ${err}`);
      }
      }, 'bot-added event');
    },
    // bot.deleted 同样只推给被移出的 bot 自己的 app——清自己的 key 即可(语义
    // 同 bot.added:进程边界上够不到兄弟 daemon;「别的 bot 离群→存量 bot
    // 陈旧」靠①守卫+TTL)。user.added/deleted_v1 推给群内已订阅的所有 bot
    // app,每个 bot 自己的 WS 都收到,各自清自己那条。纯本地 map 删除,同步
    // 处理、即时 ACK,不进 work 队列;去重也不必要——失效是幂等的。
    'im.chat.member.bot.deleted_v1': (data: any) => {
      const chatId: string | undefined = data?.chat_id;
      if (chatId) invalidateChatStats(larkAppId, chatId);
    },
    'im.chat.member.user.added_v1': (data: any) => {
      const chatId: string | undefined = data?.chat_id;
      if (chatId) invalidateChatStats(larkAppId, chatId);
    },
    'im.chat.member.user.deleted_v1': (data: any) => {
      const chatId: string | undefined = data?.chat_id;
      if (chatId) invalidateChatStats(larkAppId, chatId);
    },
    // 文档评论入口（/watch-comment / /subscribe-lark-doc）。notice 事件主要覆盖 @Bot
    // 通知；普通评论由 daemon 应用身份轮询补齐，不依赖逐文件 subscribe API。
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
      const rawMessage = data?.message;
      const ingressAnchor = rawMessageIngressAnchor(larkAppId, rawMessage);
      let seedRoutingGate: { ready: Promise<void>; complete: () => void } | undefined;
      // Reserve the app/chat ingress lane before any routing await. Canonical
      // per-anchor serialization inside processMessageEvent remains the final
      // execution fence after aliases and chat mode are resolved.
      const scheduled = scheduleAckSafeEvent(
        eventKey,
        () => serializeByAnchor(
          ingressAnchor,
          () => processMessageEvent(data, seedRoutingGate),
        ),
        'message event',
        claim,
      );
      const rawSenderType = data?.sender?.sender_type;
      if (
        scheduled
        && config.daemon.forwardFollowupWaitMs > 0
        && rawMessage?.message_id
        && rawMessage.chat_type !== 'p2p'
        && !rawMessage.root_id
        && !rawMessage.thread_id
        && rawSenderType !== 'app'
        && rawSenderType !== 'bot'
      ) {
        seedRoutingGate = registerSeedRoutingGate(rawMessage.message_id);
      }
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

  let listenerPollInFlight = false;
  const listenerPollTimer = setInterval(() => {
    if (listenerPollInFlight) return;
    listenerPollInFlight = true;
    void pollMessageListenersOnce(larkAppId, handlers)
      .catch(err => logger.error(`[message-listener:${larkAppId}] poll failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { listenerPollInFlight = false; });
  }, MESSAGE_LISTENER_POLL_INTERVAL_MS);
  listenerPollTimer.unref();
  const hasListenerBackfill = enabledMessageListenerChatIds(getBot(larkAppId)).length > 0;
  if (hasListenerBackfill) {
    setTimeout(() => {
      if (listenerPollInFlight) return;
      listenerPollInFlight = true;
      void pollMessageListenersOnce(larkAppId, handlers)
        .catch(err => logger.error(`[message-listener:${larkAppId}] initial poll failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { listenerPollInFlight = false; });
    }, 2_000).unref();
    logger.info(
      `[message-listener:${larkAppId}] polling backfill enabled interval=${MESSAGE_LISTENER_POLL_INTERVAL_MS}ms ` +
      `window=${MESSAGE_LISTENER_BACKFILL_WINDOW_MS}ms chats=${enabledMessageListenerChatIds(getBot(larkAppId)).length}`,
    );
  }

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
