/**
 * Lark card action handler — processes button clicks and dropdown selections
 * from Feishu interactive cards.
 * Extracted from daemon.ts for modularity.
 */
import { execSync } from 'node:child_process';
import { basename as pathBasename } from 'node:path';
import { config } from '../../config.js';
import { getBot, getAllBots, getOwnerOpenId } from '../../bot-registry.js';
import { canOperate, canTalk } from './event-dispatcher.js';
import { updateMessage, deleteMessage, replyMessage, sendMessage, sendUserMessage, sendEphemeralCard, getMessageDetail, isHumanOpenId } from './client.js';
import { buildSessionCard, buildStreamingCard, buildTuiPromptCard, buildTuiPromptProcessingCard, buildTuiPromptResolvedCard, buildSessionClosedCard, buildGrantResultCard, buildGrantNotifyCard, getCliDisplayName, truncateContent, buildConfigCard, buildConfigTextCard, CONFIG_UNSET, buildLandResultCard } from './card-builder.js';
import { computeSandboxDiff, applySandboxDiff } from '../../services/sandbox-land.js';
import { findConfigField, applyConfigField, coerceConfigValue, getConfigCardData } from '../../services/bot-config-store.js';
import { updateBotGrantPrefs } from '../../services/grant-prefs-store.js';
import { writeTeamRoleFile, deleteTeamRoleFile } from '../../core/role-resolver.js';
import { addChatGrant, addGlobalGrant } from '../../services/grant-store.js';
import { checkNonce, clearPending, markDenied, getPendingQuota } from './grant-pending.js';
import { recordObservedBots } from '../../services/observed-bots-store.js';
import {
  handleWorkflowApprovalAction,
  isWorkflowApprovalAction,
  type WorkflowApprovalHandlerDeps,
} from './workflow-card-handler.js';
import { handleAskCardAction, isAskCardAction } from './ask-card.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { decorateResumeForWrapper } from '../../setup/cli-selection.js';
import { logger } from '../../utils/logger.js';
import * as sessionStore from '../../services/session-store.js';
import { loadFrozenCards, saveFrozenCards } from '../../services/frozen-card-store.js';
import { forkWorker, killWorker, scheduleCardPatch, parkStreamCard, clearUsageLimitState, cardUsageLimit, writableTerminalLinkFor, resolvePrivateCardAudience, deliverWriteLinkCard, deliverEphemeralOrReply, CARD_POSTING_SENTINEL } from '../../core/worker-pool.js';
import { getSessionWorkingDir, buildNewTopicPrompt, getAvailableBots, persistStreamCardState, resumeSession, rememberLastCliInput } from '../../core/session-manager.js';
import { publishAttentionPatch } from '../../core/session-activity.js';
import { fallbackTurnId } from '../../core/reply-target.js';
import { validateWorkingDir } from '../../core/working-dir.js';
import type { DaemonToWorker, DisplayMode, TermActionKey } from '../../types.js';
import { sessionKey, sessionAnchorId, frozenDisplayMode } from '../../core/types.js';
import type { DaemonSession } from '../../core/types.js';
import { buildTerminalUrl } from '../../core/terminal-url.js';
import type { ProjectInfo } from '../../services/project-scanner.js';
import { createRepoWorktree } from '../../services/git-worktree.js';
import { t, localeForBot, isLocale, type Locale } from '../../i18n/index.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CardHandlerDeps {
  activeSessions: Map<string, DaemonSession>;
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string, turnId?: string) => Promise<string>;
  lastRepoScan: Map<string, ProjectInfo[]>;
  workflowApprovalDeps?: WorkflowApprovalHandlerDeps;
  workflowApprovalResolved?: (runId: string) => void | Promise<void>;
}

interface CardActionData {
  operator?: { open_id?: string };
  action?: {
    value?: Record<string, string>;
    option?: string;
    form_value?: Record<string, string>;  // V2 form input values
  };
  context?: { open_message_id?: string };
  open_message_id?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

const LEGACY_SELF_HEAL_ACTIONS = new Set(['toggle_display', 'toggle_stream', 'refresh_screenshot']);

// 🔊 语音总结 once-only guard: card message ids that already triggered a voice
// summary. Keyed by the clicked card's message id so any number of users
// clicking the same reply only ever generates ONE voice bubble (防刷屏).
// In-memory (per daemon lifetime) — a restart resets it, which at worst allows
// one re-trigger on an old card; acceptable. Capped to avoid unbounded growth.
const voicedCardIds = new Set<string>();

// Instruction injected into the session when the voice button is clicked. The
// model (which still has its just-sent reply in context) condenses it into
// spoken prose and emits it via `botmux send --voice`. Kept terse and explicit
// so the model produces ONE voice bubble and no stray text card. Resolved per
// the bot's locale so an English-mode bot gets the English instruction.
function voiceSummaryInstruction(locale?: Locale): string {
  return t('card.voice.summary_instruction', undefined, locale);
}

function isLegacySelfHealAction(actionType?: string): boolean {
  return !!actionType && LEGACY_SELF_HEAL_ACTIONS.has(actionType);
}

function getSessionByActionValue(
  activeSessions: Map<string, DaemonSession>,
  rootId: string | undefined,
  larkAppId: string | undefined,
  sessionId: string | undefined,
  actionType: string | undefined,
): DaemonSession | undefined {
  const primary = rootId && larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
  if (primary && (!sessionId || primary.session.sessionId === sessionId)) return primary;

  if (sessionId) {
    for (const ds of activeSessions.values()) {
      if (ds.larkAppId === larkAppId && ds.session.sessionId === sessionId) return ds;
    }
  }

  // Legacy visible cards may carry a stale/closed session_id.  Only redirect
  // self-healing display actions to the current root session; sensitive actions
  // (close/restart/disconnect/get_write_link/term_action/...) must not operate
  // on a different current session just because an old card shared the root.
  if (primary && isLegacySelfHealAction(actionType)) return primary;
  return undefined;
}

function sessionCliId(ds: DaemonSession) {
  return ds.session.cliId ?? getBot(ds.larkAppId).config.cliId;
}

function validateCardCliBinding(ds: DaemonSession, value?: Record<string, string>): boolean {
  const expected = value?.cli_id;
  if (!expected) return true;
  const actual = sessionCliId(ds);
  if (actual === expected) return true;

  // Backward-compat migration path: some already-visible Worker(CoCo) cards
  // were rendered with cli_id=claude-code before the binding fix.  Let only
  // display self-healing actions through so the handler can PATCH the clicked
  // card into the current session/CLI.  Never allow stale mismatched cards to
  // trigger sensitive/session-mutating actions.
  if (expected === 'claude-code' && actual !== 'claude-code' && isLegacySelfHealAction(value?.action)) {
    logger.warn(
      `[${tag(ds)}] Accepting legacy mismatched CLI card for self-heal: ` +
      `action=${value?.action ?? '?'} expected=${expected} actual=${actual}`,
    );
    return true;
  }

  logger.warn(
    `[${tag(ds)}] Ignoring card action from mismatched CLI card: ` +
    `action=${value?.action ?? '?'} expected=${expected} actual=${actual}`,
  );
  return false;
}

/**
 * Commit a resolved working directory onto a repo-select session: pin it, then
 * either fork the pending CLI (first selection) or close + recreate the session
 * (mid-session switch). Shared by the dropdown flow, the worktree flow (which
 * funnels back in with the freshly created worktree path) and the manual
 * directory-entry form. Extracted to module scope so the form-submit branch can
 * reuse the exact same spawn/switch path instead of duplicating it.
 */
async function commitRepoSelection(
  ctx: {
    ds: DaemonSession;
    rootId: string;
    cardMessageId?: string;
    larkAppId?: string;
    activeSessions: Map<string, DaemonSession>;
    sessionReply: (rid: string, content: string, msgType?: string, turnId?: string) => Promise<string>;
  },
  dirPath: string,
  dirLabel: string,
): Promise<void> {
  const { ds, rootId, cardMessageId, larkAppId, activeSessions, sessionReply } = ctx;
  const locTarget = localeForBot(ds.larkAppId);
  // `/close` deletes the active-map entry without touching sessionId or
  // pendingRepo — identity against the map is the only tell that the session
  // this flow captured is gone. Checked alongside the generation snapshots.
  const repoSessionKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
  const sessionStillActive = () => activeSessions.get(repoSessionKey) === ds;
  const commitGenSessionId = ds.session.sessionId;
  ds.workingDir = dirPath;
  ds.session.workingDir = dirPath;
  sessionStore.updateSession(ds.session);

  if (ds.pendingRepo) {
    const selfBot = getBot(ds.larkAppId);
    const botCfg = selfBot.config;
    const effectiveCliId = sessionCliId(ds);
    // First-time repo selection — now spawn CLI with the original prompt
    ds.pendingRepo = false;
    publishAttentionPatch(ds);
    const pendingPrompt = ds.pendingPrompt ?? '';
    const pendingRawInput = ds.pendingRawInput;
    // Raw-input cold start still wraps any input buffered while the repo card
    // was pending — see the skip_repo branch for the rationale.
    const hasBufferedInput =
      pendingPrompt.trim().length > 0 ||
      (ds.pendingAttachments?.length ?? 0) > 0 ||
      (ds.pendingFollowUps?.length ?? 0) > 0;
    const wrappedPrompt = (!pendingRawInput || hasBufferedInput)
      ? buildNewTopicPrompt(
          pendingPrompt,
          ds.session.sessionId,
          effectiveCliId,
          botCfg.cliPathOverride,
          ds.pendingAttachments,
          ds.pendingMentions,
          await getAvailableBots(ds.larkAppId, ds.chatId),
          ds.pendingFollowUps,
          { name: selfBot.botName, openId: selfBot.botOpenId },
          locTarget,
          ds.pendingSender,
          { larkAppId: ds.larkAppId, chatId: ds.chatId },
        )
      : '';
    const prompt = pendingRawInput ? '' : wrappedPrompt;
    // Last-line defence: prompt prep awaited above — if anything replaced
    // OR closed the session in that window, forking now would clobber it
    // (or resurrect a /close'd session).
    if (!sessionStillActive() || ds.session.sessionId !== commitGenSessionId) {
      logger.warn(`[${tag(ds)}] Session replaced or closed while preparing the pending-CLI prompt (${commitGenSessionId} → ${ds.session.sessionId}, active=${sessionStillActive()}) — aborting this fork`);
      return;
    }
    if (pendingRawInput && hasBufferedInput) {
      ds.pendingFollowUpInput = {
        userPrompt: pendingPrompt || (ds.pendingFollowUps?.join('\n\n') ?? ''),
        cliInput: wrappedPrompt,
      };
    }
    rememberLastCliInput(ds, pendingRawInput ?? pendingPrompt, pendingRawInput ?? prompt);
    ds.pendingPrompt = undefined;
    ds.pendingAttachments = undefined;
    ds.pendingMentions = undefined;
    ds.pendingSender = undefined;
    ds.pendingFollowUps = undefined;
    forkWorker(ds, prompt);
    // A card click has no turn of its own — anchor the confirmation to the
    // session's current reply-target turn so a shared fold-back topic keeps
    // it in-thread (same leak as the /repo command path).
    await sessionReply(rootId, t('cmd.repo.selected_in_pending', { name: dirLabel }, locTarget), undefined, fallbackTurnId(ds, undefined));
    logger.info(`[${tag(ds)}] Repo selected: ${dirPath}, spawning CLI`);
  } else {
    // Mid-session repo switch — close old session, start fresh.
    killWorker(ds);
    // Park the current card in `frozenCards` so the next POST under the new
    // session sweeps it via recall. closeSession() wipes the on-disk
    // frozen-cards file under the OLD sessionId, but the in-memory Map
    // travels with `ds` into the new session and still carries the
    // old messageId for deletion. If fork or POST fails, the parked card
    // stays in the thread instead of vanishing prematurely.
    parkStreamCard(ds);
    sessionStore.closeSession(ds.session.sessionId);
    const session = sessionStore.createSession(ds.chatId, rootId, dirLabel, ds.chatType);
    ds.session = session;
    ds.lastUserPrompt = undefined;
    ds.lastCliInput = undefined;
    // Pin workingDir + larkAppId onto the new session before forkWorker.
    // Without this, a daemon restart restores the session with an empty
    // workingDir and the worker spawns in the bot's default cwd, so
    // `claude --resume` looks in the wrong .claude/projects/<hash>/ dir and
    // exits code 0 immediately, crash-looping until the rate-limiter trips.
    ds.session.workingDir = dirPath;
    ds.session.larkAppId = ds.larkAppId;
    sessionStore.updateSession(ds.session);
    ds.hasHistory = false;
    // Re-persist the parked card under the NEW sessionId so a daemon crash
    // before the next POST doesn't strand it. closeSession() above wiped
    // the on-disk file under the OLD sessionId; without this re-save, the
    // in-memory Map only survives in process memory.
    if (ds.frozenCards && ds.frozenCards.size > 0) {
      saveFrozenCards(ds.session.sessionId, ds.frozenCards);
    }
    // Drop the old turn's streaming-card reference so worker_ready POSTs a
    // fresh card for the new session instead of PATCHing the previous one.
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;
    ds.streamCardPending = undefined;
    ds.lastScreenContent = undefined;
    ds.lastScreenStatus = undefined;
    forkWorker(ds, '', false);
    await sessionReply(rootId, t('cmd.repo.switched_to', { name: dirLabel }, locTarget));
    logger.info(`[${tag(ds)}] Repo switched to ${dirPath}, new session created`);
  }

  // Withdraw the repo selection card
  if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
  ds.repoCardMessageId = undefined;
}

// ─── Main handler ─────────────────────────────────────────────────────────

export async function handleCardAction(data: CardActionData, deps: CardHandlerDeps, larkAppId?: string): Promise<any> {
  const { activeSessions, lastRepoScan } = deps;
  // turnId is forwarded only when the caller actually has a turn anchor
  // (e.g. the pendingRepo confirmation) — most card actions have none.
  const sessionReply = (rid: string, content: string, msgType?: string, turnId?: string) =>
    turnId !== undefined
      ? deps.sessionReply(rid, content, msgType, larkAppId, turnId)
      : deps.sessionReply(rid, content, msgType, larkAppId);
  const action = data?.action;
  const value = action?.value;
  const cardMessageId = data?.context?.open_message_id ?? data?.open_message_id;

  if (logger.isDebug()) {
    logger.debug(
      `[card] app=${larkAppId ?? '?'} op=${data?.operator?.open_id ?? '?'} ` +
      `action=${value?.action ?? action?.option ?? '?'} root=${value?.root_id ?? '?'}`,
    );
  }

  // Check ALLOWED_USERS for sensitive actions.
  // Use the receiving bot's allowedUsers — the operator open_id in card actions
  // is scoped to the app that received the callback.
  const operatorOpenId = data?.operator?.open_id;
  // ─── 沙盒落盘卡（land_apply / land_discard）──────────────────────────────────
  // 不绑 session（sessionId + workingDir 都在 value 里）。owner 强闸门：只有 owner 能把
  // 隔离副本的改动应用回真实磁盘。agent 在沙盒里无感，不参与。
  if (value?.action && (value.action === 'land_apply' || value.action === 'land_discard') && larkAppId) {
    const loc = localeForBot(larkAppId);
    const owner = getOwnerOpenId(larkAppId);
    if (!operatorOpenId || operatorOpenId !== owner) {
      logger.info(`Land action "${value.action}" blocked for non-owner: ${operatorOpenId}`);
      return { toast: { type: 'error', content: t('card.land.toast_owner_only', undefined, loc) } };
    }
    if (value.action === 'land_discard') {
      return JSON.parse(buildLandResultCard('discarded', '', loc));
    }
    const sid: string = value.sessionId;
    const wd: string = value.workingDir;
    if (!sid || !wd) return JSON.parse(buildLandResultCard('failed', t('card.land.stale', undefined, loc), loc));
    const d = computeSandboxDiff(config.session.dataDir, sid, loc);
    if (!d.ok) return JSON.parse(buildLandResultCard('failed', d.error, loc));
    if (d.empty) return JSON.parse(buildLandResultCard('discarded', '', loc));
    const a = applySandboxDiff(wd, config.session.dataDir, sid, loc);
    if (!a.ok) return JSON.parse(buildLandResultCard('failed', a.error, loc));
    logger.info(`Land applied: ${d.files} files (+${d.insertions}/-${d.deletions}) → ${wd}`);
    return JSON.parse(buildLandResultCard('applied', t('card.land.applied_body', { files: d.files, ins: d.insertions, del: d.deletions, dir: wd }, loc), loc));
  }
  // ─── 群内授权卡片动作（grant_chat / grant_global / grant_deny，talk-only）─────
  // 不绑定 session，必须在 session 解析之前处理。owner 强闸门 + nonce 校验。
  if (value?.action && (value.action === 'grant_chat' || value.action === 'grant_global' || value.action === 'grant_deny') && larkAppId) {
    const loc = localeForBot(larkAppId);
    const owner = getOwnerOpenId(larkAppId);
    // owner 强闸门：必须是当前 app 的 owner 本人（比 canOperate 更严）
    if (!operatorOpenId || operatorOpenId !== owner) {
      logger.info(`Grant action "${value.action}" blocked for non-owner: ${operatorOpenId}`);
      return { toast: { type: 'error', content: t('card.grant.toast_owner_only', undefined, loc) } };
    }
    // 一次 /grant 可带多个目标（多人/多 bot），共用一张卡 + 同一 nonce。
    // 兼容旧卡（重启前发出的单目标卡只带 target_open_id）：归一成数组。
    const targets: string[] = Array.isArray(value.target_open_ids)
      ? value.target_open_ids
      : (value.target_open_id ? [value.target_open_id] : []);
    const grantChatId = value.chat_id;
    const nonce = value.nonce;
    // 全部 target 都得仍 pending 且 nonce 匹配，否则视为整卡失效。
    if (!targets.length || !grantChatId || !nonce || !targets.every(tt => checkNonce(larkAppId, grantChatId, tt, nonce))) {
      return { toast: { type: 'error', content: t('card.grant.toast_expired', undefined, loc) } };
    }
    // 拒绝：只把卡更新成「已拒绝」+ 全部目标进 deny 冷却，绝不触碰 grant-store。
    // 返回原始卡 body，由 dispatcher 包成 in-place patch（不再走 updateMessage 双写）。
    if (value.action === 'grant_deny') {
      for (const tt of targets) markDenied(larkAppId, grantChatId, tt);
      return JSON.parse(buildGrantResultCard('deny', loc));
    }
    // 授权（talk-only）：grant_chat 写本群 chatGrants，grant_global 写全局 globalGrants，
    // 两者都绝不碰 allowedUsers（operate 只由 bots.json 配）。逐个落库，统计成功/失败。
    const kind = value.action === 'grant_global' ? 'global' as const : 'chat' as const;
    const names: string[] = Array.isArray(value.target_names) ? value.target_names : [];
    const idToName = new Map<string, string>();
    targets.forEach((tt, i) => idToName.set(tt, names[i] ?? ''));
    // 额度挂在 pending 上（/grant @x N 解析所得；多目标共用同一额度）；clearPending 前先读出来。
    const quota = getPendingQuota(larkAppId, grantChatId, targets[0]);
    const granted: string[] = [];
    const failed: Array<{ openId: string; reason: string }> = [];
    for (const tt of targets) {
      const res = kind === 'global'
        ? await addGlobalGrant(larkAppId, tt, quota)
        : await addChatGrant(larkAppId, grantChatId, tt, quota);
      if (res.ok) { clearPending(larkAppId, grantChatId, tt); granted.push(tt); }
      else { failed.push({ openId: tt, reason: res.reason }); logger.warn(`Grant action "${value.action}" store failed for ${tt}: ${res.reason}`); }
    }
    // 全部失败：保留 pending + 不撤卡（owner 可点原卡重试），toast 报错。
    if (granted.length === 0) {
      return { toast: { type: 'error', content: t('card.grant.toast_failed', { reason: failed[0]?.reason ?? 'unknown' }, loc) } };
    }
    // 部分成功：失败 target 的 pending 必须立刻清掉——卡马上要撤回（owner 无法再点原卡重试），
    // 而 pending 无 TTL，isThrottled 会永久挡住失败 target 后续的自助申请直到 daemon 重启。
    // 清掉后失败 target 可重新走 /grant 或自助申请；失败清单下面在原线程明确告知 owner，
    // 不做「撤卡 + 静默失败 + pending 永久卡住」。
    for (const f of failed) clearPending(larkAppId, grantChatId, f.openId);
    // 一次查通讯录判定哪些 grantee 是真人（vs bot），结果同时供下面两处复用：
    //   1. observed 花名册自动登记（只收 bot，剔真人）；
    //   2. 通知卡 @ 渲染（只 @ 真人，bot 用纯文本名字 —— 见下方注释）。
    // 缺 contact 读权限/查询瞬时失败 → 一律按 bot 处理（false）：登记侧沿用历史「全部登记」回退，
    // 通知侧则把对方当 bot 不 @（宁可少 @ 一次真人，也不误唤醒 bot 拉空会话）。
    const humanFlags = await Promise.all(granted.map(id => isHumanOpenId(larkAppId, id).catch(() => false)));
    // /grant @bot 成功后顺带把「bot」目标登记进 observed 花名册（等价内部跑一次 /introduce），
    // 授权 + 可点名一步到位。写的是 observed-bots-store（让本 daemon 能 @ 回对方），不影响
    // isKnownPeerBot 接收闸（那查的是 cross-ref，两套独立存储），零额外路由权。best-effort。
    // 真人**不**登记：查通讯录确认是真人就剔除，避免污染 <available_bots> 误导模型。
    try {
      const botEntries = granted
        .map((id, i) => ({ id, human: humanFlags[i] }))
        .filter(x => !x.human)
        .map(x => ({ openId: x.id, name: idToName.get(x.id) ?? '' }));
      const skipped = granted.length - botEntries.length;
      if (skipped > 0) logger.debug(`grant auto-introduce: skipped ${skipped} confirmed human target(s)`);
      if (botEntries.length > 0) {
        recordObservedBots(config.session.dataDir, larkAppId, grantChatId, botEntries, 'introduce');
      }
    } catch (err) {
      logger.warn(`grant auto-introduce (observed) failed (grant still applied): ${err}`);
    }
    // 通知卡的 grantee 渲染参数：bot 只用纯文本名字（不 <at>，否则唤醒对方 bot 误拉空会话），真人 @ 点名。
    const notifyTargets = granted.map((id, i) => ({ openId: id, name: idToName.get(id) || undefined, isBot: !humanFlags[i] }));
    // 授权成功后：
    //   1. 先同步返回 callback 响应（in-place patch 成「已授权」终态卡），避免飞书等待
    //      太久或 deleteMessage 与 callback 响应竞态导致客户端 300000 报错；
    //   2. 通知卡 + 部分失败告知 + 撤回原卡 走后台 fire-and-forget（不阻塞 callback）。
    const resultCardBody = JSON.parse(buildGrantResultCard(kind, loc));
    if (cardMessageId) {
      let replyInThread = true;
      try {
        const detail = await getMessageDetail(larkAppId, cardMessageId);
        const item = detail?.items?.[0];
        if (!item) throw new Error('no message item in getMessageDetail response');
        replyInThread = Boolean(item.thread_id);
      } catch (err) {
        logger.debug(`grant notify thread-mode probe failed, defaulting to thread reply: ${err}`);
      }
      // fire-and-forget: 通知卡 + 部分失败文字 + 撤回原卡
      Promise.resolve()
        .then(async () => {
          try {
            await replyMessage(larkAppId, cardMessageId, buildGrantNotifyCard(kind, notifyTargets, loc, quota), 'interactive', replyInThread);
          } catch (err) {
            logger.warn(`grant notify failed (grant still applied): ${err}`);
          }
          if (failed.length > 0) {
            const failNames = failed.map(f => idToName.get(f.openId) || f.openId).join('、');
            try {
              await replyMessage(larkAppId, cardMessageId, t('card.grant.partial_failed', { names: failNames }, loc), 'text', replyInThread);
            } catch (err) {
              logger.warn(`grant partial-failure notice failed: ${err}`);
            }
          }
          try {
            await deleteMessage(larkAppId, cardMessageId);
          } catch (err) {
            logger.debug(`grant card withdraw (post-callback) failed: ${err}`);
          }
        })
        .catch(err => logger.error(`grant post-callback background tasks failed: ${err}`));
    }
    return resultCardBody;
  }

  if (isAskCardAction(value?.action)) {
    return handleAskCardAction(data);
  }

  // ─── /relay picker: state-changing actions (select / page / search) ────
  // These three actions all re-render the picker card with updated state:
  //   • relay_select — user clicked a session card → set as selectedSessionId
  //   • relay_page   — user clicked prev/next page → bump page index
  //   • relay_search — user submitted the search form → apply new query (reset page)
  //
  // The card is stateless on the Lark side, so each callback value carries
  // the FULL state (search / page / selected / target_chat_id / root_id);
  // we just compute the new state from the action and re-render.
  if (value?.action && larkAppId && ['relay_select', 'relay_page', 'relay_search'].includes(value.action as string)) {
    const loc = localeForBot(larkAppId);
    const targetChatId = value.target_chat_id;
    const targetRootId = value.root_id;
    // root_id IS the relay target anchor (chatId for chat-scope, 话题 root for
    // thread-scope). target_scope tells the confirm/re-render which it is;
    // target_chat_type (group | p2p) rides along so confirm can flip the
    // session's chatType for DM targets. Default 'group' covers legacy cards.
    const targetScope = (value.target_scope as 'thread' | 'chat') ?? 'chat';
    const targetChatType = (value.target_chat_type as 'group' | 'p2p') ?? 'group';
    const invokerOpenId = value.invoker_open_id as string | undefined;
    if (!targetChatId || !targetRootId || !operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: 'missing_value' }, loc) } };
    }
    // Picker is owner-only: only the user who summoned it may flip pages,
    // search, or select. Otherwise A's invocation in a shared chat could be
    // silently swapped to C's session list when C clicks a button. Cards
    // built before this guard was deployed lack invoker_open_id — we let
    // them through (legacy) rather than break in-flight pickers; new cards
    // are protected from the moment they're rendered.
    if (invokerOpenId && invokerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_invoker', undefined, loc) } };
    }

    // Reconstruct the next state from the action.
    const carriedSearch = (value.search as string) ?? '';
    const carriedPage = Number(value.page ?? 0) || 0;
    const carriedSelected = (value.selected as string) ?? '';

    let nextSearch = carriedSearch;
    let nextPage = carriedPage;
    let nextSelected: string | undefined = carriedSelected || undefined;

    if (value.action === 'relay_search') {
      // v2 input fires `behaviors[].callback` directly — the typed text
      // arrives as action.input_value (NOT form_value), since we're no
      // longer wrapping the input in a form. Reset page on new search.
      nextSearch = String((action as any)?.input_value ?? '').trim();
      nextPage = 0;
      // Don't carry over the selection on a new search — the selected entry
      // may not match the new filter, and even if it does, "I just searched
      // for something else" implies the user is changing what they want.
      nextSelected = undefined;
    } else if (value.action === 'relay_page') {
      nextPage = Number(value.page ?? 0) || 0;
    } else if (value.action === 'relay_select') {
      nextSelected = value.session_id;
    }

    // Exclude by the target ANCHOR (root_id), not chatId — keeps 同群 other-
    // topic sessions in the candidate list on re-render, matching初次渲染.
    const { collectRelayPickerEntries } = await import('../../services/relay-picker.js');
    const entries = await collectRelayPickerEntries(activeSessions, larkAppId, targetRootId, operatorOpenId);
    const { buildRelayPickerCard } = await import('./card-builder.js');
    const cardJson = buildRelayPickerCard(
      entries,
      targetChatId,
      targetRootId,
      // Preserve the original invoker so the re-rendered card stays bound
      // to them. Fall back to operatorOpenId for legacy cards rendered
      // before invoker_open_id was added (shouldn't normally happen since
      // the check above already lets legacy through, but a render needs a
      // string regardless).
      invokerOpenId ?? operatorOpenId,
      loc,
      {
        selectedSessionId: nextSelected,
        searchQuery: nextSearch,
        page: nextPage,
      },
      targetScope,
      targetChatType,
    );
    // Return an updated card body — event-dispatcher wraps this as
    // { card: { type: 'raw', data: <body> } } so Lark patches the picker
    // in place rather than appending a new message.
    return JSON.parse(cardJson);
  }

  // ─── /botconfig 交互卡片：切换布尔开关 / 选择 cli·model·lang / 消息额度，就地刷新 ──
  const CONFIG_CARD_ACTIONS = ['config_toggle', 'config_set', 'config_quota', 'config_text_open', 'config_text_save'];
  if (value?.action && larkAppId && CONFIG_CARD_ACTIONS.includes(value.action)) {
    // 卡片携带的渲染语言（`/botconfig en` 的覆盖）优先；缺省回落 bot 默认。
    const vLoc = (value as any)?.loc;
    const loc = isLocale(vLoc) ? vLoc : localeForBot(larkAppId);
    let cbot;
    try { cbot = getBot(larkAppId); } catch { return { toast: { type: 'error', content: t('cmd.config.no_bot', undefined, loc) } }; }
    // 严格 owner/allowlist 闸（与文字版 /botconfig 同口径）：拒开放模式 + 非 admin。
    const admins = cbot.resolvedAllowedUsers;
    if (admins.length === 0 || !operatorOpenId || !admins.includes(operatorOpenId)) {
      return { toast: { type: 'error', content: t('cmd.config.not_admin', undefined, loc) } };
    }
    const modelChoices = (() => {
      try { return createCliAdapterSync(cbot.config.cliId, cbot.config.cliPathOverride).modelChoices ?? []; } catch { return []; }
    })();
    const reRender = () => {
      const d = getConfigCardData(larkAppId, modelChoices);
      return d ? { card: { type: 'raw' as const, data: JSON.parse(buildConfigCard(d, loc)) } } : {};
    };
    // 「文本设置」子卡：点主卡按钮 → **私信新发**一张含输入框的子卡（v1 form 须新发、
    // 不能 patch，否则空卡）。子卡每个字段一个 form，保存即写、回 toast、卡片保持
    // （不回 card → 不 patch，避免 form 重渲染异常）。
    if (value.action === 'config_text_open') {
      const d = getConfigCardData(larkAppId, modelChoices);
      if (!d) return { toast: { type: 'error', content: t('cmd.config.no_bot', undefined, loc) } };
      try {
        await sendUserMessage(larkAppId, operatorOpenId!, buildConfigTextCard(d, loc), 'interactive');
        return { toast: { type: 'success', content: t('card.config.text_sent', undefined, loc) } };
      } catch {
        return { toast: { type: 'error', content: t('card.config.text_send_fail', undefined, loc) } };
      }
    }
    if (value.action === 'config_text_save') {
      const fk = (value as any)?.field as string | undefined;
      const fv: Record<string, string> = (action as any)?.form_value ?? {};
      const raw = String((fk ? fv[fk] : '') ?? '').trim();
      if (fk === 'teamRole') {
        if (raw) writeTeamRoleFile(larkAppId, raw.slice(0, 4096)); else deleteTeamRoleFile(larkAppId);
        logger.info(`[config:${larkAppId}] team role ${raw ? 'set' : 'cleared'} via card`);
        return { toast: { type: 'success', content: t('card.config.text_saved', undefined, loc) } };
      }
      const spec = fk ? findConfigField(fk) : undefined;
      if (!spec) return { toast: { type: 'error', content: t('cmd.config.unknown_field', { field: fk ?? '?', fields: '' }, loc) } };
      const r = await applyConfigField(larkAppId, spec, raw ? raw : null);
      if (!r.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: r.reason }, loc) } };
      logger.info(`[config:${larkAppId}] text field ${spec.key} saved via card`);
      return { toast: { type: 'success', content: `✓ ${spec.key} = ${r.newText}` } };
    }

    // 消息额度（grant-prefs，非 CONFIG_FIELDS 字段）：'off' = 关闭，正整数 = 设定。
    if (value.action === 'config_quota') {
      const raw = (action as any)?.option ?? '';
      const n = raw === 'off' ? null : Number(raw);
      const limit = n && Number.isInteger(n) && n > 0 ? n : null;
      const qr = await updateBotGrantPrefs(larkAppId, { messageQuotaDefaultLimit: limit });
      if (!qr.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: qr.reason }, loc) } };
      return { toast: { type: 'success', content: `✓ quota = ${limit ?? 'off'}` }, ...reRender() };
    }

    const field = value.field as string | undefined;
    const spec = field ? findConfigField(field) : undefined;
    if (!spec || spec.kind === 'allowedUsers') {
      return { toast: { type: 'error', content: t('cmd.config.unknown_field', { field: field ?? '?', fields: '' }, loc) } };
    }

    let r;
    if (value.action === 'config_toggle') {
      if (spec.kind !== 'boolean') return { toast: { type: 'error', content: t('cmd.config.invalid_bool', { field: spec.key, value: '' }, loc) } };
      const cur = (cbot.config as any)[spec.configKey] === true;
      r = await applyConfigField(larkAppId, spec, !cur);
    } else {
      const raw = (action as any)?.option ?? (action as any)?.input_value ?? '';
      if (raw === CONFIG_UNSET) {
        if (!spec.clearable) return { toast: { type: 'error', content: t('cmd.config.not_clearable', { field: spec.key }, loc) }, ...reRender() };
        r = await applyConfigField(larkAppId, spec, null);
      } else {
        const coerced = coerceConfigValue(spec, raw);
        if (!coerced.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: coerced.reason }, loc) }, ...reRender() };
        r = await applyConfigField(larkAppId, spec, coerced.value);
      }
    }
    if (!r.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: r.reason }, loc) } };
    return { toast: { type: 'success', content: `✓ ${spec.key} = ${r.newText}` }, ...reRender() };
  }

  // ─── /relay picker: confirm transfer (stage 2 → done) ──────────────────
  // The confirm button on the picker card fires this. Same logic as the
  // original (pre-two-stage) relay_pickup action: owner-check, pre-flight
  // conflict check, send M1, transferSession, delete picker card.
  if (value?.action === 'relay_confirm' && larkAppId) {
    const loc = localeForBot(larkAppId);
    const sourceSessionId = value.session_id;
    const targetChatId = value.target_chat_id;
    const targetRootId = value.root_id;
    // root_id IS the target anchor for thread-scope (the 话题 root); for chat-
    // scope the anchor is chatId and root_id is unused for routing.
    // target_chat_type tells transferSession whether the destination is a DM
    // (p2p) so the session's chatType flips with it; legacy cards lack the
    // field and default to 'group' (their pickers never offered DM targets).
    const targetScope = (value.target_scope as 'thread' | 'chat') ?? 'chat';
    const targetChatType = (value.target_chat_type as 'group' | 'p2p') ?? 'group';
    const targetAnchor = targetScope === 'chat' ? targetChatId : targetRootId;
    const invokerOpenId = value.invoker_open_id as string | undefined;
    if (!sourceSessionId || !targetChatId || !targetRootId) {
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: 'missing_value' }, loc) } };
    }
    // Invoker-only confirm: redundant with the ownerOpenId check below in
    // normal flow (invoker = session owner = picker invoker), but defends
    // against the edge case where the source session changed owners after
    // the picker was rendered, OR where the picker was shared/forwarded.
    // Legacy cards (no invoker_open_id) fall through to ownerOpenId only.
    if (invokerOpenId && operatorOpenId && invokerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_invoker', undefined, loc) } };
    }
    // Locate the source session in the in-process registry. Since picker only
    // lists sessions of THIS bot in OTHER chats, the source must live in our
    // activeSessions — if it's gone, treat as not found rather than reaching
    // across daemons (cross-daemon pull is out of v1 scope).
    let sourceDs: DaemonSession | undefined;
    for (const cand of activeSessions.values()) {
      if (cand.larkAppId === larkAppId && cand.session.sessionId === sourceSessionId) {
        sourceDs = cand;
        break;
      }
    }
    if (!sourceDs) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_found', undefined, loc) } };
    }
    if (sourceDs.session.ownerOpenId && sourceDs.session.ownerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_owner', undefined, loc) } };
    }
    // Anchor-based self-relay guard: a thread-scope source in the SAME chat
    // (different 话题) is a legitimate cross-topic move, so refuse only when the
    // source and target anchors are identical.
    if (sessionAnchorId(sourceDs) === targetAnchor) {
      return { toast: { type: 'error', content: t('card.relay.toast_same_chat', undefined, loc) } };
    }
    // Real-session preflight — done BEFORE M1 send so a refusal doesn't
    // leave a misleading "已接力" announcement in the target chat.
    // collectRelayPickerEntries already filters scratches at render time,
    // but a stale picker (rendered before a scratch was created) could
    // still produce a confirm click; this is the depth defense.
    {
      const { isRelayableRealSession } = await import('../../core/worker-pool.js');
      if (!isRelayableRealSession(sourceDs)) {
        return { toast: { type: 'error', content: t('card.relay.toast_not_started_yet', undefined, loc) } };
      }
    }
    // Pre-flight target-chat conflict check — done BEFORE sendMessage M1 so
    // a refusal doesn't leave a misleading "已接力" announcement in the
    // target chat (王皓 caught this in testing). Mirror the same predicate
    // transferSession uses, plus the `!!worker` filter that excludes daemon
    // command scratch sessions (e.g. the /relay command's own session,
    // which shares the bot's larkAppId + chatId but has no worker).
    const targetConflict = [...activeSessions.values()].find(c =>
      c !== sourceDs
      && c.larkAppId === larkAppId
      && sessionAnchorId(c) === targetAnchor
      && !!c.worker
    );
    if (targetConflict) {
      const conflictTitle = targetConflict.session.title || targetConflict.session.sessionId.substring(0, 8);
      // Send as a regular text message in the target chat instead of a
      // popup toast — per王皓's preference for visible/persistent error
      // ("不要用弹窗，就用消息形式"). No toast returned so the operator
      // sees the chat message land where the error actually applies.
      // Pass raw text — sendMessage wraps text-msgType bodies itself; the
      // earlier `JSON.stringify({text: ...})` caused double-wrapping and
      // Lark rendered the JSON literally (王皓 caught this in the M1).
      const errText = t('cmd.relay.target_has_session_msg', { title: conflictTitle }, loc);
      sendMessage(larkAppId, targetChatId, errText, 'text').catch(() => undefined);
      return;
    }
    // Resolve a friendly source chat label for the M1 announcement — falls
    // back to the raw chatId if Lark can't return a name. A p2p source has no
    // chat name (chat.get often fails or returns empty for DMs) — use the
    // locale-aware 单聊 label instead of leaking a raw oc_ id into the M1.
    const { getChatName } = await import('./client.js');
    const sourceLabel = sourceDs.chatType === 'p2p'
      ? t('card.relay.type_p2p', undefined, loc)
      : (await getChatName(larkAppId, sourceDs.chatId)) ?? sourceDs.chatId;
    // Send the M1 announcement.
    //   chat-scope: a plain top-level message; its id becomes the (audit-only)
    //               rootMessageId after the transfer (mirrors /relay --create).
    //   thread-scope: reply_in_thread INTO the target 话题 (anchor) so the
    //               announcement lands in the 话题; the session anchors on the
    //               话题 root (targetAnchor), NOT the M1 id.
    let m1MessageId: string;
    try {
      const m1Text = t(targetChatType === 'p2p' ? 'cmd.relay.m1_announce_dm' : 'cmd.relay.m1_announce', { sourceChat: sourceLabel, groupName: targetChatId }, loc);
      m1MessageId = targetScope === 'thread'
        ? await replyMessage(larkAppId, targetAnchor, m1Text, 'text', /*replyInThread*/ true)
        : await sendMessage(larkAppId, targetChatId, m1Text, 'text');
    } catch (err: any) {
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: err?.message ?? 'send_m1_failed' }, loc) } };
    }
    const { transferSession } = await import('../../core/worker-pool.js');
    // chat-scope → anchor on the M1 id (audit-only); thread-scope → anchor on
    // the 话题 root (targetAnchor) so future replies in the 话题 route here.
    const r = targetScope === 'thread'
      ? await transferSession(sourceDs.session.sessionId, targetChatId, targetAnchor, targetChatType, 'thread')
      : await transferSession(sourceDs.session.sessionId, targetChatId, m1MessageId, targetChatType, 'chat');
    if (!r.ok) {
      // Best-effort: orphan M1 cleanup so a failed transfer doesn't leave a
      // misleading "已接力" message in the target chat (王皓's "明明失败了
      // 却返回成功了" complaint). Race-condition fallback only — the
      // pre-flight checks above should catch the common cases first.
      deleteMessage(larkAppId, m1MessageId).catch(() => { /* leave it */ });
      if (r.error === 'target_chat_has_session') {
        // Lost the race vs the pre-flight check — still surface as a message.
        const errText = t('cmd.relay.target_has_session_msg', { title: '' }, loc);
        sendMessage(larkAppId, targetChatId, errText, 'text').catch(() => undefined);
        return;
      }
      if (r.error === 'adopt_not_relayable') {
        return { toast: { type: 'error', content: t('card.relay.toast_adopt_not_relayable', undefined, loc) } };
      }
      if (r.error === 'worker_busy') {
        return { toast: { type: 'error', content: t('card.relay.toast_worker_busy', undefined, loc) } };
      }
      if (r.error === 'not_started_yet') {
        return { toast: { type: 'error', content: t('card.relay.toast_not_started_yet', undefined, loc) } };
      }
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: r.error }, loc) } };
    }
    // Best-effort: remove the picker card now that the selection resolved.
    if (cardMessageId && larkAppId) {
      deleteMessage(larkAppId, cardMessageId).catch(() => { /* leave it */ });
    }
    return { toast: { type: 'success', content: t('card.relay.toast_success', undefined, loc) } };
  }

  const isSensitive = value?.action && ['restart', 'close', 'resume', 'skip_repo', 'repo_manual_submit', 'retry_last_task', 'get_write_link', 'toggle_stream', 'toggle_display', 'export_text', 'term_action', 'refresh_screenshot', 'takeover', 'disconnect', 'tui_keys', 'tui_text_input', 'wf_approve', 'wf_reject', 'wf_cancel'].includes(value.action);
  if (isSensitive) {
    const rootId = value?.root_id;
    // activeSessions is keyed by sessionKey(anchor, larkAppId) — `${anchor}::${larkAppId}`
    // (double colon). Earlier this was hand-spliced with a single colon and
    // always missed, falling through to the bare-rootId legacy lookup; that
    // worked for permission gating only because chatId came from elsewhere
    // most of the time. Use sessionKey() so the bot-scoped lookup actually
    // hits, and keep the bare-rootId fallback for legacy single-bot cards.
    const ds = rootId
      ? (larkAppId
          ? getSessionByActionValue(activeSessions, rootId, larkAppId, value?.session_id, value?.action)
          : activeSessions.get(rootId))
      : undefined;
    // Resume targets a closed session — fall back to the persistent store so
    // we can still pin chatId/larkAppId for the canOperate gate.
    const closedForCtx = !ds && value?.action === 'resume' && value?.session_id
      ? sessionStore.getSession(value.session_id)
      : undefined;
    const effectiveAppId = larkAppId ?? ds?.larkAppId ?? closedForCtx?.larkAppId;
    const chatId = ds?.chatId ?? closedForCtx?.chatId;
    // pendingRepo 阶段，会话发起人（含 chat-granted 用户）可以 skip_repo / 手动填目录
    // 起会话——与 repo 下拉选择同款例外，否则被授权人连自己的首次会话都启动不了。
    const pendingRepoOwnerException =
      (value.action === 'skip_repo' || value.action === 'repo_manual_submit') && !!ds?.pendingRepo &&
      !!operatorOpenId && operatorOpenId === ds.session.ownerOpenId;
    if (effectiveAppId) {
      if (!pendingRepoOwnerException && !canOperate(effectiveAppId, chatId, operatorOpenId)) {
        logger.info(`Card action "${value.action}" blocked for non-operator user: ${operatorOpenId} (chat=${chatId})`);
        return;
      }
    } else {
      const bots = getAllBots();
      const allowedUsers = bots.flatMap(b => b.resolvedAllowedUsers);
      // globalGrants 与 allowedChatGroups 同理计入 hasAllowlist：只配 globalGrants（talk-only）
      // 也算限制态，否则这条手写 fallback 会算成 false → 敏感动作 fall through 成全开放。
      // 注意只进 hasAllowlist 判定，命中仍只认 allowedUsers（与 canOperate 一致，不授 operate）。
      const hasAllowlist = allowedUsers.length > 0
        || bots.some(b => (b.config.allowedChatGroups?.length ?? 0) > 0)
        || bots.some(b => (b.config.globalGrants?.length ?? 0) > 0);
      if (hasAllowlist && (!operatorOpenId || !allowedUsers.includes(operatorOpenId))) {
        logger.info(`Card action "${value.action}" blocked for non-allowed user: ${operatorOpenId}`);
        return;
      }
    }
  }

  if (isWorkflowApprovalAction(value?.action)) {
    const locWf = localeForBot(larkAppId);
    const result = await handleWorkflowApprovalAction(data, deps.workflowApprovalDeps, locWf);
    const runId = value?.run_id;
    if (result?.ok && !result.duplicate && runId) {
      await deps.workflowApprovalResolved?.(runId);
    }
    // Non-approver: surface a toast so the clicker knows nothing happened
    // (instead of silently leaving the buttons active).
    if (result && !result.ok && result.error === 'not_approver') {
      return { toast: { type: 'warning', content: t('toast.not_in_approver_list', undefined, locWf) } };
    }
    // Successful resolve / reject / cancel: replace the clicked card with a
    // frozen "已通过/已拒绝/已取消" body so the buttons can't be re-submitted
    // from this surface. Duplicate clicks just no-op (the first PATCH already
    // landed).
    if (result?.ok && !result.duplicate && result.resolvedCardJson) {
      try {
        return JSON.parse(result.resolvedCardJson);
      } catch {
        // fall through to undefined
      }
    }
    return;
  }

  // Handle session card button actions (restart/close)
  if (value?.action) {
    const { action: actionType, root_id: rootId } = value;
    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = larkAppId
      ? getSessionByActionValue(activeSessions, rootId, larkAppId, value.session_id, actionType)
      : activeSessions.get(rootId);

    if (ds && !validateCardCliBinding(ds, value)) return;

    // 🔊 语音总结 — no permission gate (任意人可点). Inject a condense-and-speak
    // instruction into the session; the model emits the voice via
    // `botmux send --voice`. Dedup per card so only one voice is generated.
    if (actionType === 'voice_summary') {
      const locDs = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!ds) {
        return { toast: { type: 'warning', content: t('card.voice.toast_session_gone', undefined, locDs) } };
      }
      // 权限：仅 canTalk / canOperate 用户可点；其他人提示需授权（无声门会让人以为按钮坏了）。
      if (!canTalk(ds.larkAppId, ds.chatId, operatorOpenId) && !canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
        logger.info(`[${tag(ds)}] voice_summary blocked for unauthorized user: ${operatorOpenId ?? '?'}`);
        return { toast: { type: 'warning', content: t('card.voice.toast_need_auth', undefined, locDs) } };
      }
      const dedupeKey = cardMessageId ?? `${sessionAnchorId(ds)}::voice`;
      if (voicedCardIds.has(dedupeKey)) {
        return { toast: { type: 'info', content: t('card.voice.toast_already', undefined, locDs) } };
      }
      voicedCardIds.add(dedupeKey);
      if (voicedCardIds.size > 5000) { voicedCardIds.clear(); voicedCardIds.add(dedupeKey); }
      if (ds.worker && !ds.worker.killed) {
        ds.worker.send({ type: 'message', content: voiceSummaryInstruction(locDs) } as DaemonToWorker);
      } else {
        forkWorker(ds, voiceSummaryInstruction(locDs), ds.hasHistory);
      }
      logger.info(`[${tag(ds)}] voice_summary triggered by ${operatorOpenId ?? '?'}`);
      return { toast: { type: 'success', content: t('card.voice.toast_wait', undefined, locDs) } };
    }

    if (actionType === 'restart' && ds) {
      // Adopt sessions: hard-reject. botmux never owned the user's CLI;
      // restarting would mean killing their tmux pane / Claude process,
      // which violates the bridge invariant. Defense in depth — buildSessionCard
      // already omits the restart button when adoptMode=true, but a stale
      // pre-fix card or a malformed action payload could still arrive.
      const locDs = localeForBot(ds.larkAppId);
      if (ds.adoptedFrom) {
        logger.warn(`[${tag(ds)}] Rejected restart on adopt session — would kill user's pane`);
        await sessionReply(rootId, t('card.action.adopt_no_restart', undefined, locDs));
        return;
      }
      const botCfg = getBot(ds.larkAppId).config;
      const effectiveCliId = sessionCliId(ds);
      if (ds.worker) {
        logger.info(`[${tag(ds)}] Restart via card button`);
        ds.worker.send({ type: 'restart' } as DaemonToWorker);
        const cliName = getCliDisplayName(effectiveCliId);
        const restartedMsg = t('card.action.restarted', { cliName }, locDs);
        await deliverEphemeralOrReply(ds, operatorOpenId, restartedMsg, 'text', () => sessionReply(rootId, restartedMsg));
      } else {
        logger.info(`[${tag(ds)}] Re-forking worker via card button`);
        forkWorker(ds, '', ds.hasHistory);
        const cliName = getCliDisplayName(effectiveCliId);
        const restartedFreshMsg = t('card.action.restarted_fresh', { cliName }, locDs);
        await deliverEphemeralOrReply(ds, operatorOpenId, restartedFreshMsg, 'text', () => sessionReply(rootId, restartedFreshMsg));
        // DM card will be sent by the ready handler when worker starts
      }
    }

    if (actionType === 'close' && ds) {
      const closedSessionId = ds.session.sessionId;
      const closedTitle = ds.session.title;
      const botCfg = getBot(ds.larkAppId).config;
      const closedCliId = ds.session.cliId ?? botCfg.cliId;
      const closedAnchor = sessionAnchorId(ds);
      const closedWorkingDir = ds.session.workingDir;
      const cliResumeCommand = (() => {
        try {
          const adapter = createCliAdapterSync(closedCliId, botCfg.cliPathOverride);
          const raw = adapter.buildResumeCommand?.({
            sessionId: closedSessionId,
            cliSessionId: ds.session.cliSessionId,
          }) ?? null;
          return raw ? decorateResumeForWrapper(raw, botCfg.wrapperCli) : null;
        } catch { return null; }
      })();
      killWorker(ds);
      sessionStore.closeSession(closedSessionId);
      activeSessions.delete(sKey);
      const card = buildSessionClosedCard(
        closedSessionId,
        closedAnchor,
        closedTitle,
        closedCliId,
        closedWorkingDir,
        cliResumeCommand,
        localeForBot(ds.larkAppId),
      );
      // The closed card carries session title / CLI name / workingDir / resume
      // command. In private-card mode those must not leak to the group — send the
      // closed card ephemeral to the same owner audience instead. No group
      // fallback on failure (privacy wins; the session is already closed).
      // `value.visibility === 'private'` pins the decision to the card that was
      // clicked, so a card built in private mode stays ephemeral even if the
      // bot's `privateCard` config was turned off in the meantime.
      if (value?.visibility === 'private' || botCfg.privateCard) {
        const audience = resolvePrivateCardAudience(ds);
        for (const openId of audience) {
          await sendEphemeralCard(ds.larkAppId, ds.chatId, openId, card).catch(err =>
            logger.warn(`[${tag(ds)}] private close card ephemeral send to ${openId.substring(0, 8)}… failed: ${err}`));
        }
        logger.info(`[${tag(ds)}] Closed via card button (private close card → ${audience.length} owner(s))`);
      } else {
        await deliverEphemeralOrReply(ds, operatorOpenId, card, 'interactive', () => sessionReply(rootId, card, 'interactive'));
        logger.info(`[${tag(ds)}] Closed via card button`);
      }
    }

    if (actionType === 'resume') {
      const targetSessionId = value?.session_id;
      const locDsResume = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!targetSessionId) {
        await sessionReply(rootId, t('card.action.resume_missing_session_id', undefined, locDsResume));
      } else {
        const result = await resumeSession(targetSessionId, activeSessions);
        if (result.ok) {
          const cliName = getCliDisplayName(result.ds.session.cliId ?? getBot(result.ds.larkAppId).config.cliId);
          const resumeMsg = t('card.action.resume_success', { cliName }, localeForBot(result.ds.larkAppId));
          await deliverEphemeralOrReply(result.ds, operatorOpenId, resumeMsg, 'text', () => sessionReply(rootId, resumeMsg));
          logger.info(`[${targetSessionId.substring(0, 8)}] Resumed via card button`);
        } else if (result.error === 'not_found') {
          await sessionReply(rootId, t('card.action.resume_not_found', { short: targetSessionId.substring(0, 8) }, locDsResume));
        } else if (result.error === 'not_closed') {
          await sessionReply(rootId, t('card.action.resume_not_closed', undefined, locDsResume));
        } else if (result.error === 'anchor_occupied') {
          const detail = result.activeSessionId
            ? t('card.action.resume_anchor_holder', { short: result.activeSessionId.substring(0, 8) }, locDsResume)
            : '';
          await sessionReply(rootId, t('card.action.resume_anchor_occupied', { detail }, locDsResume));
        } else if (result.error === 'adopt_unsupported') {
          await sessionReply(rootId, t('card.action.resume_adopt_unsupported', undefined, locDsResume));
        }
      }
    }

    if (actionType === 'disconnect' && ds) {
      killWorker(ds);
      sessionStore.closeSession(ds.session.sessionId);
      activeSessions.delete(sKey);
      await sessionReply(rootId, t('card.action.disconnected', undefined, localeForBot(ds.larkAppId)));
      logger.info(`[${tag(ds)}] Disconnected (adopt) via card button`);
    }

    if (actionType === 'takeover' && ds && ds.adoptedFrom) {
      await sessionReply(rootId, t('card.action.takeover_retired', undefined, localeForBot(ds.larkAppId)));
      logger.info(`[${tag(ds)}] Legacy takeover action ignored (bridge era; historical card)`);
    }

    if (actionType === 'retry_last_task' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      const cliInput = ds.lastCliInput;
      if (!cliInput) {
        await sessionReply(rootId, t('card.action.retry_last_task_missing', undefined, locDs));
        return;
      }
      if (!ds.usageLimit) {
        await sessionReply(rootId, t('card.action.retry_last_task_unavailable', undefined, locDs));
        return;
      }
      if (!ds.usageLimit.retryReady && ds.usageLimit.retryAtMs > Date.now()) {
        await sessionReply(rootId, t('card.action.retry_last_task_not_ready', { retryLabel: ds.usageLimit.retryLabel }, locDs));
        return;
      }

      clearUsageLimitState(ds);
      ds.lastScreenStatus = 'working';
      ds.streamCardPending = true;
      ds.currentTurnTitle = (ds.lastUserPrompt || ds.currentTurnTitle || ds.session.title || getCliDisplayName(sessionCliId(ds))).substring(0, 50);
      ds.currentImageKey = undefined;
      persistStreamCardState(ds);

      let cardJson: string | undefined;
      if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && ds.workerPort) {
        const readUrl = buildTerminalUrl(ds);
        cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          ds.currentTurnTitle,
          '',
          'working',
          sessionCliId(ds),
          ds.displayMode ?? 'hidden',
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          locDs,
          undefined,
          writableTerminalLinkFor(ds),
        );
        scheduleCardPatch(ds, cardJson);
      }

      if (ds.worker && !ds.worker.killed) {
        ds.worker.send({ type: 'message', content: cliInput } as DaemonToWorker);
      } else {
        forkWorker(ds, cliInput, ds.hasHistory);
      }
      logger.info(`[${tag(ds)}] Retrying last task after usage limit`);
      if (cardJson) {
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      return;
    }

    if (actionType === 'tui_keys' && ds) {
      let keys: string[] = [];
      try { keys = JSON.parse(value?.keys ?? '[]'); } catch { /* bad json */ }
      const isFinal = value?.is_final === '1';
      const optionType = value?.option_type ?? 'select';
      const selectedIndex = Number(value?.selected_index ?? 0);
      const selectedText = value?.selected_text ?? `Option ${selectedIndex + 1}`;

      if (optionType === 'toggle') {
        // Toggle: only update card UI, do NOT send keys to terminal yet.
        // Keys will be sent in batch when confirm is clicked.
        if (!ds.tuiToggledIndices) ds.tuiToggledIndices = [];
        const idx = ds.tuiToggledIndices.indexOf(selectedIndex);
        if (idx >= 0) ds.tuiToggledIndices.splice(idx, 1);
        else ds.tuiToggledIndices.push(selectedIndex);
        logger.info(`[${tag(ds)}] TUI toggle (card only): option ${selectedIndex}, toggled: [${ds.tuiToggledIndices}]`);
        // PATCH card to update ☐/☑ state
        if (cardMessageId && ds.tuiPromptOptions) {
          const locDs = localeForBot(ds.larkAppId);
          const updatedCard = buildTuiPromptCard(
            sessionAnchorId(ds),
            ds.session.sessionId,
            ds.currentTurnTitle || t('card.action.tui_select_title', undefined, locDs),
            ds.tuiPromptOptions,
            true,
            ds.tuiToggledIndices,
            locDs,
          );
          updateMessage(ds.larkAppId, cardMessageId, updatedCard).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to update TUI toggle card: ${err}`),
          );
          try { return JSON.parse(updatedCard); } catch { /* fall through */ }
        }
        return;
      }

      // For confirm: batch all toggled options' keys first, then confirm keys
      if (ds.worker) {
        let allKeys: string[] = [];
        if (ds.tuiToggledIndices?.length && ds.tuiPromptOptions) {
          // Send each toggled option's keys in sequence
          for (const ti of ds.tuiToggledIndices.sort((a, b) => a - b)) {
            const opt = ds.tuiPromptOptions[ti];
            if (opt?.keys?.length) {
              allKeys.push(...opt.keys);
            }
          }
        }
        // Then the action's own keys (confirm/select)
        allKeys.push(...keys);

        if (allKeys.length > 0) {
          ds.worker.send({ type: 'tui_keys', keys: allKeys, isFinal } as DaemonToWorker);
          logger.info(`[${tag(ds)}] TUI keys: [${allKeys.join(',')}] final=${isFinal} — "${selectedText}"`);
        }

        if (isFinal) {
          const resolveText = ds.tuiToggledIndices?.length
            ? ds.tuiToggledIndices.map(i => ds.tuiPromptOptions?.[i]?.text).filter(Boolean).join(', ')
            : selectedText;
          const finalText = resolveText || selectedText;
          const locDs = localeForBot(ds.larkAppId);
          if (cardMessageId) {
            setTimeout(() => {
              const resolvedCard = buildTuiPromptResolvedCard(finalText, locDs);
              updateMessage(ds.larkAppId, cardMessageId, resolvedCard).catch(err =>
                logger.debug(`[${tag(ds)}] Failed to update TUI prompt card: ${err}`),
              );
            }, allKeys.length * 100 + 500);
          }
          ds.tuiPromptCardId = undefined;
          ds.tuiPromptOptions = undefined;
          ds.tuiPromptMultiSelect = undefined;
          ds.tuiToggledIndices = undefined;
          publishAttentionPatch(ds);
          try { return JSON.parse(buildTuiPromptProcessingCard(finalText, locDs)); } catch { /* fall through */ }
        }
      }
    }

    if (actionType === 'tui_text_input' && ds) {
      const inputText = action?.form_value?.tui_custom_input ?? '';
      let inputKeys: string[] = [];
      try { inputKeys = JSON.parse(value?.input_keys ?? '[]'); } catch { /* bad json */ }
      const locDs = localeForBot(ds.larkAppId);
      if (ds.worker && inputText && inputKeys.length > 0) {
        // Atomic IPC — worker handles keys + text in one flow to avoid race
        ds.worker.send({ type: 'tui_text_input', keys: inputKeys, text: inputText } as DaemonToWorker);
        logger.info(`[${tag(ds)}] TUI text input: "${inputText}" (keys: ${JSON.stringify(inputKeys)})`);
        if (cardMessageId) {
          const resolvedCard = buildTuiPromptResolvedCard(inputText, locDs);
          updateMessage(ds.larkAppId, cardMessageId, resolvedCard).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to update TUI prompt card: ${err}`),
          );
        }
        ds.tuiPromptCardId = undefined;
        ds.tuiPromptOptions = undefined;
        publishAttentionPatch(ds);
      }
      try {
        return JSON.parse(buildTuiPromptResolvedCard(inputText || t('card.action.tui_custom_input', undefined, locDs), locDs));
      } catch { /* fall through */ }
    }

    if (actionType === 'get_write_link' && ds && operatorOpenId) {
      const botCfg = getBot(ds.larkAppId).config;
      const effectiveCliId = sessionCliId(ds);
      const locDs = localeForBot(ds.larkAppId);
      if (ds.workerPort && ds.workerToken) {
        const writeUrl = buildTerminalUrl(ds, { write: true });
        const cardJson = buildSessionCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          writeUrl,
          ds.session.title || getCliDisplayName(effectiveCliId),
          effectiveCliId,
          true, // showManageButtons — write-link card includes restart & close
          !!ds.adoptedFrom, // adoptMode — disconnect, never close-the-CLI
          locDs,
        );
        // 普通群发「仅自己可见」私密卡，话题群 / 单聊自动回退私聊 DM（两条通道都私密，
        // 不泄露写入 token）。fire-and-forget，保持卡片回调快速返回。
        void deliverWriteLinkCard(ds, operatorOpenId, cardJson);
      } else {
        // 普通群发「仅自己可见」私密卡；话题群 / 单聊不支持 ephemeral，回退为同样内容的
        // 卡片回复（而非纯文本），三种场景都渲染成卡片，行为不变。
        const notReadyCard = JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{ tag: 'markdown', content: t('card.action.terminal_not_ready', undefined, locDs) }],
        });
        await deliverEphemeralOrReply(ds, operatorOpenId, notReadyCard, 'interactive', () => sessionReply(rootId, notReadyCard, 'interactive'));
      }
    }

    // Display toggle: hidden ↔ screenshot. 'toggle_stream' is the legacy alias
    // from pre-screenshot cards and is mapped to toggle_display semantics.
    if ((actionType === 'toggle_display' || actionType === 'toggle_stream') && ds) {
      const clickedNonce: string | undefined = value?.card_nonce;
      const isFrozenClick = clickedNonce && ds.streamCardNonce && clickedNonce !== ds.streamCardNonce;

      const nextMode = (current: DisplayMode): DisplayMode =>
        current === 'hidden' ? 'screenshot' : 'hidden';

      if (isFrozenClick) {
        // Historical card — toggle using cached state
        if (!ds.frozenCards) ds.frozenCards = loadFrozenCards(ds.session.sessionId);
        const frozen = ds.frozenCards.get(clickedNonce!);
        if (!frozen) {
          // The clicked card can predate the frozen-card cache for the current
          // active session (e.g. a stale Worker card whose session_id/card_nonce
          // came from a now-closed session). Migrate the visible card to the
          // current root session/CLI instead of leaving stale terminal URL/chrome.
          const effectiveCliId = sessionCliId(ds);
          const cur: DisplayMode = ds.displayMode ?? 'hidden';
          const next = nextMode(cur);
          ds.displayMode = next;
          persistStreamCardState(ds);
          if (ds.worker) {
            ds.worker.send({ type: 'set_display_mode', mode: next } as DaemonToWorker);
          }
          if (cardMessageId && ds.workerPort) {
            const readUrl = buildTerminalUrl(ds);
            const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
            const cardJson = buildStreamingCard(
              ds.session.sessionId,
              sessionAnchorId(ds),
              readUrl,
              turnTitle,
              ds.lastScreenContent || '',
              ds.lastScreenStatus || 'working',
              effectiveCliId,
              next,
              ds.streamCardNonce,
              ds.currentImageKey,
              !!ds.adoptedFrom,
              false,
              localeForBot(ds.larkAppId),
              cardUsageLimit(ds),
              writableTerminalLinkFor(ds),
            );
            updateMessage(ds.larkAppId, cardMessageId, cardJson).catch(err =>
              logger.debug(`[${tag(ds)}] Failed to migrate unknown frozen card: ${err}`),
            );
            logger.info(`[${tag(ds)}] Migrated unknown frozen card to ${next} (legacy nonce=${clickedNonce})`);
            try { return JSON.parse(cardJson); } catch { /* fall through */ }
          }
          logger.debug(`[${tag(ds)}] Toggle on unknown frozen card could not migrate: nonce=${clickedNonce}`);
          return;
        }
        // Self-heal known historical cards by migrating the clicked card to the
        // current live session/CLI instead of rebuilding from cached frozen
        // title/content/imageKey. The cache may have been persisted while this
        // thread was bound to a different CLI (or before cli_id existed), and
        // reusing its imageKey is exactly what makes a second click snap back to
        // an old Claude Code screenshot.
        const cur: DisplayMode = ds.displayMode ?? frozenDisplayMode(frozen);
        const next = nextMode(cur);
        ds.displayMode = next;
        persistStreamCardState(ds);
        if (ds.worker) {
          ds.worker.send({ type: 'set_display_mode', mode: next } as DaemonToWorker);
        }
        const effectiveCliId = sessionCliId(ds);
        const readUrl = ds.workerPort ? buildTerminalUrl(ds) : '';
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          next,
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
        );
        updateMessage(ds.larkAppId, frozen.messageId, cardJson).catch(err =>
          logger.debug(`[${tag(ds)}] Failed to migrate frozen card: ${err}`),
        );
        ds.frozenCards.delete(clickedNonce!);
        saveFrozenCards(ds.session.sessionId, ds.frozenCards);
        logger.info(`[${tag(ds)}] Migrated frozen card to current ${next} (legacy nonce=${clickedNonce})`);
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
        return;
      }

      // Current (latest) card — change displayMode + tell worker
      const botCfg = getBot(ds.larkAppId).config;
      const effectiveCliId = sessionCliId(ds);
      const cur: DisplayMode = ds.displayMode ?? 'hidden';
      const next = nextMode(cur);
      ds.displayMode = next;
      persistStreamCardState(ds);
      if (ds.worker) {
        ds.worker.send({ type: 'set_display_mode', mode: next } as DaemonToWorker);
      }
      if (ds.streamCardId && ds.workerPort) {
        const readUrl = buildTerminalUrl(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          next,
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
        );
        if (cardMessageId && cardMessageId !== ds.streamCardId) {
          updateMessage(ds.larkAppId, cardMessageId, cardJson).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to migrate clicked legacy card: ${err}`),
          );
        } else {
          scheduleCardPatch(ds, cardJson);
        }
        logger.info(`[${tag(ds)}] Display mode → ${next}`);
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      logger.info(`[${tag(ds)}] Display mode → ${next}`);
      return;
    }

    // Export current terminal text as a thread reply. One-shot action — the
    // card body itself stays in screenshot mode. For frozen cards, export
    // from the cached frozen content; for the live card, use ds.lastScreenContent.
    if (actionType === 'export_text' && ds) {
      const clickedNonce: string | undefined = value?.card_nonce;
      const isFrozenClick = clickedNonce && ds.streamCardNonce && clickedNonce !== ds.streamCardNonce;
      let content = '';
      if (isFrozenClick) {
        if (!ds.frozenCards) ds.frozenCards = loadFrozenCards(ds.session.sessionId);
        content = ds.frozenCards.get(clickedNonce!)?.content ?? '';
      } else {
        content = ds.lastScreenContent ?? '';
      }
      const locDs = localeForBot(ds.larkAppId);
      const body = content.trim() ? truncateContent(content, locDs) : t('card.action.no_output', undefined, locDs);
      await sessionReply(sessionAnchorId(ds), body);
      logger.info(`[${tag(ds)}] Exported terminal text (${body.length} chars)`);
      return;
    }

    // Manual screenshot refresh — force immediate capture bypassing 10s interval + hash dedup.
    if (actionType === 'refresh_screenshot' && ds) {
      if (ds.worker) {
        ds.worker.send({ type: 'refresh_screen' } as DaemonToWorker);
        logger.info(`[${tag(ds)}] Manual screenshot refresh`);
      }
      // Return the current card JSON so Feishu doesn't revert the displayed
      // image to the originally-POSTed initial frame while waiting for the
      // fresh screenshot PATCH (~1s).
      if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && ds.workerPort) {
        const botCfg = getBot(ds.larkAppId).config;
        const effectiveCliId = sessionCliId(ds);
        const readUrl = buildTerminalUrl(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          ds.displayMode ?? 'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
        );
        if (cardMessageId && cardMessageId !== ds.streamCardId) {
          updateMessage(ds.larkAppId, cardMessageId, cardJson).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to migrate clicked legacy card: ${err}`),
          );
        }
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      return;
    }

    // Quick-action keys (Esc, ^C, Tab, Space, Enter, ←↑↓→, ½ page) — forward to worker.
    if (actionType === 'term_action' && ds) {
      const key = value?.key as TermActionKey | undefined;
      if (!key) return;
      if (ds.worker) {
        ds.worker.send({ type: 'term_action', key } as DaemonToWorker);
        logger.info(`[${tag(ds)}] term_action: ${key}`);
      }
      if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && ds.workerPort) {
        const botCfg = getBot(ds.larkAppId).config;
        const effectiveCliId = sessionCliId(ds);
        const readUrl = buildTerminalUrl(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          ds.displayMode ?? 'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
        );
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      return;
    }

    if (actionType === 'skip_repo' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      if (ds.pendingRepo) {
        const selfBot = getBot(ds.larkAppId);
        const botCfg = selfBot.config;
        const effectiveCliId = sessionCliId(ds);
        // Skip repo selection — spawn CLI with default working dir
        ds.pendingRepo = false;
        publishAttentionPatch(ds);
        const pendingPrompt = ds.pendingPrompt ?? '';
        const pendingRawInput = ds.pendingRawInput;
        // Raw-input cold start still wraps any input buffered while the repo
        // card was pending (follow-ups / attachments) — delivered right after
        // the raw input on prompt_ready instead of being dropped.
        const hasBufferedInput =
          pendingPrompt.trim().length > 0 ||
          (ds.pendingAttachments?.length ?? 0) > 0 ||
          (ds.pendingFollowUps?.length ?? 0) > 0;
        const wrappedPrompt = (!pendingRawInput || hasBufferedInput)
          ? buildNewTopicPrompt(
              pendingPrompt,
              ds.session.sessionId,
              effectiveCliId,
              botCfg.cliPathOverride,
              ds.pendingAttachments,
              ds.pendingMentions,
              await getAvailableBots(ds.larkAppId, ds.chatId),
              ds.pendingFollowUps,
              { name: selfBot.botName, openId: selfBot.botOpenId },
              locDs,
              ds.pendingSender,
              { larkAppId: ds.larkAppId, chatId: ds.chatId },
            )
          : '';
        const prompt = pendingRawInput ? '' : wrappedPrompt;
        if (pendingRawInput && hasBufferedInput) {
          ds.pendingFollowUpInput = {
            userPrompt: pendingPrompt || (ds.pendingFollowUps?.join('\n\n') ?? ''),
            cliInput: wrappedPrompt,
          };
        }
        rememberLastCliInput(ds, pendingRawInput ?? pendingPrompt, pendingRawInput ?? prompt);
        ds.pendingPrompt = undefined;
        ds.pendingAttachments = undefined;
        ds.pendingMentions = undefined;
        ds.pendingSender = undefined;
        ds.pendingFollowUps = undefined;
        forkWorker(ds, prompt);
        const cwd = getSessionWorkingDir(ds);
        await sessionReply(rootId, t('cmd.skip.opened', { cwd }, locDs));
        logger.info(`[${tag(ds)}] Skip repo, spawning CLI in ${cwd}`);
      } else {
        await sessionReply(rootId, t('card.action.continue_using_current_repo', { cwd: getSessionWorkingDir(ds) }, locDs));
      }
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      ds.repoCardMessageId = undefined;
    }

    // Manual working-directory entry from the repo card form. The project scan
    // may not surface every useful directory; this mirrors `/repo <path>` from
    // the card. Permission is gated at the top (isSensitive + pendingRepoOwner
    // exception), same as skip_repo. Always a plain commit — worktree creation
    // needs a scanned git repo root, not an arbitrary path.
    if (actionType === 'repo_manual_submit' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      const rawPath = String(action?.form_value?.repo_manual_path ?? '').trim();
      if (!rawPath) {
        return { toast: { type: 'error', content: t('card.repo.manual_empty', undefined, locDs) } };
      }
      const validation = validateWorkingDir(rawPath, locDs);
      if (!validation.ok) {
        return { toast: { type: 'error', content: validation.error } };
      }
      // A worktree creation in flight holds the commit lock — a manual switch
      // interleaving there would double-fork (same guard as the plain switch).
      if (ds.worktreeCreating) {
        return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locDs) } };
      }
      const selectedPath = validation.resolvedPath;
      const displayName = pathBasename(selectedPath) || selectedPath;
      await commitRepoSelection(
        { ds, rootId, cardMessageId, larkAppId, activeSessions, sessionReply },
        selectedPath,
        displayName,
      );
    }
    return;
  }

  // Handle dropdown selections (option-based)
  const option = action?.option;
  if (!option) {
    logger.warn('Card action received but no option or action value');
    return;
  }

  // Handle adopt session selection
  if (action?.value?.key === 'codex_app_thread_select' && option) {
    const rootId = action?.value?.root_id;
    if (!rootId) return;

    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = activeSessions.get(sKey);
    if (!ds) return;

    if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
      logger.info(`codex_app_thread_select blocked for non-operator user: ${operatorOpenId} (chat=${ds.chatId})`);
      return { toast: { type: 'error', content: t('card.grant.toast_no_repo_perm', undefined, localeForBot(ds.larkAppId)) } };
    }

    let selected: { threadId: string };
    try { selected = JSON.parse(option); } catch { return; }
    if (!selected.threadId) return;

    const botCfg = getBot(ds.larkAppId).config;
    if (botCfg.cliId !== 'codex-app') return;

    const { listCodexAppThreads } = await import('../../services/codex-app-threads.js');
    let threads: Awaited<ReturnType<typeof listCodexAppThreads>>;
    try {
      threads = await listCodexAppThreads({
        codexBin: botCfg.cliPathOverride,
        cwd: getSessionWorkingDir(ds),
        limit: 80,
      });
    } catch (err: any) {
      await sessionReply(rootId, t('cmd.codex_app_adopt.list_failed', { error: err?.message ?? String(err) }, localeForBot(ds.larkAppId)));
      return;
    }
    const target = threads.find(t => t.threadId === selected.threadId);
    if (!target) {
      await sessionReply(rootId, t('cmd.codex_app_adopt.thread_not_found', { threadId: selected.threadId }, localeForBot(ds.larkAppId)));
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      return;
    }

    const { startCodexAppThreadSession } = await import('../../core/command-handler.js');
    await startCodexAppThreadSession(target, ds, { activeSessions, sessionReply: deps.sessionReply, getActiveCount: () => 0, lastRepoScan }, larkAppId);
    if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
    return;
  }

  if (action?.value?.key === 'adopt_select' && option) {
    const rootId = action?.value?.root_id;
    if (!rootId) return;

    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = activeSessions.get(sKey);
    if (!ds) return;

    // /adopt 是管理动作：下拉入口同样要求 canOperate（命令路径已在 daemon 层 gate）。
    if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
      logger.info(`adopt_select blocked for non-operator user: ${operatorOpenId} (chat=${ds.chatId})`);
      return { toast: { type: 'error', content: t('card.grant.toast_no_repo_perm', undefined, localeForBot(ds.larkAppId)) } };
    }

    // Parse selected session info (tmux/herdr: key; zellij: zellijSession+zellijPaneId)
    let selected: { key?: string; source?: string; tmuxTarget?: string; zellijSession?: string; zellijPaneId?: string; cliPid?: number };
    try { selected = JSON.parse(option); } catch { return; }

    // Re-discover to get full session info and validate. Backend determines
    // which discovery to run (re-confirms the pane + pid are still alive).
    const botCfg = getBot(ds.larkAppId).config;
    let target: Awaited<ReturnType<typeof resolveAdoptTarget>>;
    async function resolveAdoptTarget() {
      if (selected.zellijPaneId) {
        const { discoverAdoptableZellijSessions } = await import('../../core/zellij-adopt-discovery.js');
        // Match by (session, paneId) only — a paneId uniquely identifies the
        // pane within a session, and the resolved CLI pid can legitimately
        // differ from the card's snapshot (wrapper⇄native pid shift), so
        // requiring an exact pid match would spuriously report 已退出. Use the
        // freshly-discovered entry (with its current pid).
        return discoverAdoptableZellijSessions(botCfg.cliId)
          .find(s => s.zellijSession === selected.zellijSession && s.zellijPaneId === selected.zellijPaneId);
      }
      const { discoverAdoptableSessions, adoptTargetKey } = await import('../../core/session-discovery.js');
      return discoverAdoptableSessions(botCfg.cliId)
        .find(s => selected.key
          ? adoptTargetKey(s) === selected.key
          : s.tmuxTarget === selected.tmuxTarget && s.cliPid === selected.cliPid);
    }
    // Discovery scans a live process tree and can transiently miss a pane under
    // load (a racing `ps` snapshot); retry a few times before giving up so a
    // momentary miss doesn't surface as "目标 CLI 会话已退出".
    target = await resolveAdoptTarget();
    for (let attempt = 0; !target && attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 150));
      target = await resolveAdoptTarget();
    }
    if (!target) {
      await sessionReply(rootId, t('cmd.adopt.target_exited', undefined, localeForBot(ds.larkAppId)));
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      return;
    }

    // Import and call startAdoptSession
    const { startAdoptSession } = await import('../../core/command-handler.js');
    await startAdoptSession(target, ds, { activeSessions, sessionReply: deps.sessionReply, getActiveCount: () => 0, lastRepoScan }, larkAppId);
    if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
    return;
  }

  // Second adopt filter: resume a session discovered on disk (paseo-style
  // import). Re-spawns the bot's CLI via `--resume <id>` in the recorded cwd.
  if (action?.value?.key === 'adopt_resume_select' && option) {
    const rootId = action?.value?.root_id;
    if (!rootId) return;

    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = activeSessions.get(sKey);
    if (!ds) return;

    if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
      logger.info(`adopt_resume_select blocked for non-operator user: ${operatorOpenId} (chat=${ds.chatId})`);
      return { toast: { type: 'error', content: t('card.grant.toast_no_repo_perm', undefined, localeForBot(ds.larkAppId)) } };
    }

    let selected: { cliSessionId?: string; cwd?: string };
    try { selected = JSON.parse(option); } catch { return; }
    if (!selected.cliSessionId) return;

    // Re-discover from disk to validate the session still exists (and is not
    // already live in another botmux session) before committing to the resume.
    const botCfg = getBot(ds.larkAppId).config;
    const { discoverResumableSessionsForBot, startResumeImportSession } = await import('../../core/command-handler.js');
    const resumable = await discoverResumableSessionsForBot(botCfg.cliId, botCfg.cliPathOverride, activeSessions);
    const target = resumable.find(r => r.cliSessionId === selected.cliSessionId);
    if (!target) {
      await sessionReply(rootId, t('cmd.adopt.resume_not_found', { id: selected.cliSessionId }, localeForBot(ds.larkAppId)));
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      return;
    }

    await startResumeImportSession(target, ds, { activeSessions, sessionReply: deps.sessionReply, getActiveCount: () => 0, lastRepoScan }, larkAppId);
    if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
    return;
  }

  // Handle repo select card (option-based dropdowns: plain switch, or
  // `repo_worktree` = create a worktree from the picked repo and open that).
  const isWorktreeOpen = action?.value?.key === 'repo_worktree';
  const selectedPath = option;
  const rootId = action?.value?.root_id;
  logger.info(`Card action: repo ${isWorktreeOpen ? 'worktree-open' : 'switch'} to ${selectedPath} (root_id: ${rootId})`);

  if (!rootId) {
    logger.warn('Card action: no root_id in action value');
    return;
  }

  const targetDs = larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
  if (!targetDs) {
    logger.warn(`Card action: no active session found for root ${rootId}`);
    return;
  }

  // 权限边界：pendingRepo（首次选 repo 才能 spawn）放行「会话发起人 或 canOperate」，
  // 让本群授权用户能完成自己的首次使用；非 pending 的 mid-session 切换是管理动作，要 canOperate。
  const isSessionOwnerOp = !!operatorOpenId && operatorOpenId === targetDs.session.ownerOpenId;
  const allowRepo = targetDs.pendingRepo
    ? (isSessionOwnerOp || canOperate(targetDs.larkAppId, targetDs.chatId, operatorOpenId))
    : canOperate(targetDs.larkAppId, targetDs.chatId, operatorOpenId);
  if (!allowRepo) {
    logger.info(`Repo card action blocked for ${operatorOpenId} (pending=${targetDs.pendingRepo})`);
    return { toast: { type: 'error', content: t('card.grant.toast_no_repo_perm', undefined, localeForBot(targetDs.larkAppId)) } };
  }

  // Resolve the project name from cached scan
  const cached = lastRepoScan.get(targetDs.chatId);
  const project = cached?.find(p => p.path === selectedPath);
  const displayName = project ? `${project.name} (${project.branch})` : selectedPath;

  const locTarget = localeForBot(targetDs.larkAppId);

  // `/close` deletes the active-map entry without touching sessionId or
  // pendingRepo — identity against the map is the only tell that the session
  // this flow captured is gone. Checked alongside the generation snapshots.
  const repoSessionKey = sessionKey(rootId, larkAppId!);
  const sessionStillActive = () => activeSessions.get(repoSessionKey) === targetDs;

  // Shared commit context for a resolved directory — funnels the dropdown,
  // worktree and manual-entry flows through the same module-level
  // commitRepoSelection (pin dir, then fork pending CLI or close+recreate).
  const commitCtx = { ds: targetDs, rootId, cardMessageId, larkAppId, activeSessions, sessionReply };

  if (isWorktreeOpen) {
    // Worktree creation involves a `git fetch` that can take many seconds —
    // ack the card action immediately with a toast and finish asynchronously.
    // On failure the card (and pendingRepo state) stays put so the user can
    // pick again or fall back to a plain switch.
    if (targetDs.worktreeCreating) {
      // The async path escapes the card-action in-flight dedup — gate repeats
      // here, or two creations would race and the loser's commitSelection
      // would yank the session the winner just spawned.
      return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locTarget) } };
    }
    targetDs.worktreeCreating = true;
    // Session generation snapshot: if another selection lands while git runs
    // (pendingRepo consumed, or the session swapped), committing this worktree
    // afterwards would kill that fresh session — notify instead of switching.
    const startSessionId = targetDs.session.sessionId;
    const wasPending = !!targetDs.pendingRepo;
    const sessionChanged = () =>
      !sessionStillActive() ||
      targetDs.session.sessionId !== startSessionId ||
      !!targetDs.pendingRepo !== wasPending;
    const notSwitched = async (creation: { path: string; branch: string }, when: string) => {
      logger.info(`[${tag(targetDs)}] Worktree ${creation.path} created but session changed ${when} — not switching`);
      await sessionReply(rootId, t('cmd.repo.worktree_created_not_switched', { path: creation.path, branch: creation.branch }, locTarget));
    };
    void (async () => {
      try {
        let creation;
        try {
          creation = await createRepoWorktree(selectedPath);
        } catch (e) {
          logger.warn(`[${tag(targetDs)}] Worktree creation failed for ${selectedPath}: ${e instanceof Error ? e.message : e}`);
          await sessionReply(rootId, t('cmd.repo.worktree_failed', { error: e instanceof Error ? e.message : String(e) }, locTarget));
          return;
        }
        if (sessionChanged()) return notSwitched(creation, 'mid-flight');
        await sessionReply(rootId, t('cmd.repo.worktree_created', {
          path: creation.path, branch: creation.branch, base: creation.baseRef,
        }, locTarget));
        // The reply above awaited a Lark round-trip — a plain switch (which is
        // NOT gated by worktreeCreating) can land in that window. Re-check
        // right before committing, or we'd kill the session it just spawned.
        if (sessionChanged()) return notSwitched(creation, 'during reply');
        try {
          await commitRepoSelection(commitCtx, creation.path, `${pathBasename(creation.path)} (${creation.branch})`);
        } catch (e) {
          // The worktree DOES exist at this point — only the switch failed.
          // Don't report it as a creation failure, or the user retries and
          // trips over "worktree target already exists".
          logger.warn(`[${tag(targetDs)}] Worktree ${creation.path} created but switching failed: ${e instanceof Error ? e.message : e}`);
          await sessionReply(rootId, t('cmd.repo.worktree_switch_failed', { path: creation.path, error: e instanceof Error ? e.message : String(e) }, locTarget));
        }
      } finally {
        targetDs.worktreeCreating = false;
      }
    })();
    return { toast: { type: 'info', content: t('card.repo.toast_worktree_creating', undefined, locTarget) } };
  }

  // Plain switch — blocked while a worktree creation/commit is in flight. The
  // worktree commit awaits (Lark replies, prompt prep) after its generation
  // checks; a plain selection interleaving there would double-fork. One lock
  // gates both kinds until the commit settles.
  if (targetDs.worktreeCreating) {
    return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locTarget) } };
  }
  await commitRepoSelection(commitCtx, selectedPath, displayName);
}
