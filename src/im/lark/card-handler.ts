/**
 * Lark card action handler — processes button clicks and dropdown selections
 * from Feishu interactive cards.
 * Extracted from daemon.ts for modularity.
 */
import { execSync } from 'node:child_process';
import { config } from '../../config.js';
import { getBot, getAllBots, getOwnerOpenId } from '../../bot-registry.js';
import { canOperate } from './event-dispatcher.js';
import { sendUserMessage, updateMessage, deleteMessage, replyMessage } from './client.js';
import { buildSessionCard, buildStreamingCard, buildTuiPromptCard, buildTuiPromptProcessingCard, buildTuiPromptResolvedCard, buildSessionClosedCard, buildGrantResultCard, buildGrantNotifyCard, getCliDisplayName, truncateContent } from './card-builder.js';
import { addChatGrant, addGlobalGrant } from '../../services/grant-store.js';
import { checkNonce, clearPending, markDenied } from './grant-pending.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { logger } from '../../utils/logger.js';
import * as sessionStore from '../../services/session-store.js';
import { loadFrozenCards, saveFrozenCards } from '../../services/frozen-card-store.js';
import { forkWorker, killWorker, scheduleCardPatch, parkStreamCard } from '../../core/worker-pool.js';
import { getSessionWorkingDir, buildNewTopicPrompt, getAvailableBots, persistStreamCardState, resumeSession } from '../../core/session-manager.js';
import type { DaemonToWorker, DisplayMode, TermActionKey } from '../../types.js';
import { sessionKey, sessionAnchorId, frozenDisplayMode } from '../../core/types.js';
import type { DaemonSession } from '../../core/types.js';
import type { ProjectInfo } from '../../services/project-scanner.js';
import { t, localeForBot } from '../../i18n/index.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CardHandlerDeps {
  activeSessions: Map<string, DaemonSession>;
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string) => Promise<string>;
  lastRepoScan: Map<string, ProjectInfo[]>;
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

// ─── Main handler ─────────────────────────────────────────────────────────

export async function handleCardAction(data: CardActionData, deps: CardHandlerDeps, larkAppId?: string): Promise<any> {
  const { activeSessions, lastRepoScan } = deps;
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
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

  // ─── 群内授权卡片动作（grant_chat / grant_global / grant_deny）─────────────
  // 不绑定 session，必须在 session 解析之前处理。owner 强闸门 + nonce 校验。
  if (value?.action && (value.action === 'grant_chat' || value.action === 'grant_global' || value.action === 'grant_deny') && larkAppId) {
    const loc = localeForBot(larkAppId);
    const owner = getOwnerOpenId(larkAppId);
    // owner 强闸门：必须是当前 app 的 owner 本人（比 canOperate 更严）
    if (!operatorOpenId || operatorOpenId !== owner) {
      logger.info(`Grant action "${value.action}" blocked for non-owner: ${operatorOpenId}`);
      return { toast: { type: 'error', content: t('card.grant.toast_owner_only', undefined, loc) } };
    }
    const target = value.target_open_id;
    const grantChatId = value.chat_id;
    const nonce = value.nonce;
    if (!target || !grantChatId || !nonce || !checkNonce(larkAppId, grantChatId, target, nonce)) {
      return { toast: { type: 'error', content: t('card.grant.toast_expired', undefined, loc) } };
    }
    // 拒绝：只把卡更新成「已拒绝」+ 进 deny 冷却，绝不触碰 grant-store。
    // 返回原始卡 body，由 dispatcher 包成 in-place patch（不再走 updateMessage 双写）。
    if (value.action === 'grant_deny') {
      markDenied(larkAppId, grantChatId, target);
      return JSON.parse(buildGrantResultCard('deny', loc));
    }
    // 授权：先落库。落库失败不撤卡、保留 pending（owner 可重试），给 toast。
    const res = value.action === 'grant_chat'
      ? await addChatGrant(larkAppId, grantChatId, target)
      : await addGlobalGrant(larkAppId, target);
    if (!res.ok) {
      logger.warn(`Grant action "${value.action}" store failed: ${res.reason}`);
      return { toast: { type: 'error', content: t('card.grant.toast_failed', { reason: res.reason }, loc) } };
    }
    clearPending(larkAppId, grantChatId, target);
    const kind = value.action === 'grant_chat' ? 'chat' : 'global';
    // 授权成功后：在原线程 @ 被授权人发通知 + 撤回授权卡（用户要求）。
    // 这两步失败不回滚授权（已落库），仅记日志，并兜底用 in-place patch 让 owner 看到结果。
    if (cardMessageId) {
      try {
        await replyMessage(larkAppId, cardMessageId, buildGrantNotifyCard(kind, target, loc), 'interactive', true);
        await deleteMessage(larkAppId, cardMessageId);
        return; // 卡已撤回，无需返回 patch
      } catch (err) {
        logger.warn(`grant notify/withdraw failed (grant still applied): ${err}`);
        // 落到下面的 in-place patch 兜底
      }
    }
    // 兜底（无 card message_id，或撤回/通知失败）：靠 callback 返回 patch 原地更新卡。
    return JSON.parse(buildGrantResultCard(kind, loc));
  }

  const isSensitive = value?.action && ['restart', 'close', 'resume', 'skip_repo', 'get_write_link', 'toggle_stream', 'toggle_display', 'export_text', 'term_action', 'refresh_screenshot', 'takeover', 'disconnect', 'tui_keys', 'tui_text_input'].includes(value.action);
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
    // pendingRepo 阶段，会话发起人（含 chat-granted 用户）可以 skip_repo 起会话——
    // 与 repo 下拉选择同款例外，否则被授权人连自己的首次会话都启动不了。
    const pendingRepoOwnerException =
      value.action === 'skip_repo' && !!ds?.pendingRepo &&
      !!operatorOpenId && operatorOpenId === ds.session.ownerOpenId;
    if (effectiveAppId) {
      if (!pendingRepoOwnerException && !canOperate(effectiveAppId, chatId, operatorOpenId)) {
        logger.info(`Card action "${value.action}" blocked for non-operator user: ${operatorOpenId} (chat=${chatId})`);
        return;
      }
    } else {
      // No resolvable bot context — fall back to union of all allowedUsers
      const allowedUsers = getAllBots().flatMap(b => b.resolvedAllowedUsers);
      if (allowedUsers.length > 0) {
        if (!operatorOpenId || !allowedUsers.includes(operatorOpenId)) {
          logger.info(`Card action "${value.action}" blocked for non-allowed user: ${operatorOpenId}`);
          return;
        }
      }
    }
  }

  // Handle session card button actions (restart/close)
  if (value?.action) {
    const { action: actionType, root_id: rootId } = value;
    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = larkAppId
      ? getSessionByActionValue(activeSessions, rootId, larkAppId, value.session_id, actionType)
      : activeSessions.get(rootId);

    if (ds && !validateCardCliBinding(ds, value)) return;

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
        await sessionReply(rootId, t('card.action.restarted', { cliName }, locDs));
      } else {
        logger.info(`[${tag(ds)}] Re-forking worker via card button`);
        forkWorker(ds, '', ds.hasHistory);
        const cliName = getCliDisplayName(effectiveCliId);
        await sessionReply(rootId, t('card.action.restarted_fresh', { cliName }, locDs));
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
          return adapter.buildResumeCommand?.({
            sessionId: closedSessionId,
            cliSessionId: ds.session.cliSessionId,
          }) ?? null;
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
      await sessionReply(rootId, card, 'interactive');
      logger.info(`[${tag(ds)}] Closed via card button`);
    }

    if (actionType === 'resume') {
      const targetSessionId = value?.session_id;
      const locDsResume = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!targetSessionId) {
        await sessionReply(rootId, t('card.action.resume_missing_session_id', undefined, locDsResume));
      } else {
        const result = resumeSession(targetSessionId, activeSessions);
        if (result.ok) {
          const cliName = getCliDisplayName(result.ds.session.cliId ?? getBot(result.ds.larkAppId).config.cliId);
          await sessionReply(rootId, t('card.action.resume_success', { cliName }, localeForBot(result.ds.larkAppId)));
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
        const writeUrl = `http://${config.web.externalHost}:${ds.workerPort}?token=${ds.workerToken}`;
        const dmCardJson = buildSessionCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          writeUrl,
          ds.session.title || getCliDisplayName(effectiveCliId),
          effectiveCliId,
          true, // showManageButtons — DM card includes restart & close
          !!ds.adoptedFrom, // adoptMode — disconnect, never close-the-CLI
          locDs,
        );
        sendUserMessage(ds.larkAppId, operatorOpenId, dmCardJson, 'interactive').catch(err =>
          logger.warn(`[${tag(ds)}] Failed to DM write link: ${err}`),
        );
        logger.info(`[${tag(ds)}] Sent write link via DM to ${operatorOpenId}`);
      } else {
        await sessionReply(rootId, t('card.action.terminal_not_ready', undefined, locDs));
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
            const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
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
        const readUrl = ds.workerPort ? `http://${config.web.externalHost}:${ds.workerPort}` : '';
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
        const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
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
      if (ds.streamCardId && ds.streamCardId !== '__posting__' && ds.workerPort) {
        const botCfg = getBot(ds.larkAppId).config;
        const effectiveCliId = sessionCliId(ds);
        const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
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
      if (ds.streamCardId && ds.streamCardId !== '__posting__' && ds.workerPort) {
        const botCfg = getBot(ds.larkAppId).config;
        const effectiveCliId = sessionCliId(ds);
        const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
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
        const prompt = buildNewTopicPrompt(
          ds.pendingPrompt ?? '',
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
        );
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
    return;
  }

  // Handle dropdown selections (option-based)
  const option = action?.option;
  if (!option) {
    logger.warn('Card action received but no option or action value');
    return;
  }

  // Handle adopt session selection
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

    // Parse selected session info
    let selected: { tmuxTarget: string; cliPid: number };
    try { selected = JSON.parse(option); } catch { return; }

    // Re-discover to get full session info and validate
    const { discoverAdoptableSessions } = await import('../../core/session-discovery.js');
    const sessions = discoverAdoptableSessions();
    const target = sessions.find(s => s.tmuxTarget === selected.tmuxTarget && s.cliPid === selected.cliPid);
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

  // Handle repo select card (option-based dropdown)
  const selectedPath = option;
  const rootId = action?.value?.root_id;
  logger.info(`Card action: repo switch to ${selectedPath} (root_id: ${rootId})`);

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

  targetDs.workingDir = selectedPath;
  targetDs.session.workingDir = selectedPath;
  sessionStore.updateSession(targetDs.session);

  const locTarget = localeForBot(targetDs.larkAppId);
  if (targetDs.pendingRepo) {
    const selfBot = getBot(targetDs.larkAppId);
    const botCfg = selfBot.config;
    const effectiveCliId = sessionCliId(targetDs);
    // First-time repo selection — now spawn CLI with the original prompt
    targetDs.pendingRepo = false;
    const prompt = buildNewTopicPrompt(
      targetDs.pendingPrompt ?? '',
      targetDs.session.sessionId,
      effectiveCliId,
      botCfg.cliPathOverride,
      targetDs.pendingAttachments,
      targetDs.pendingMentions,
      await getAvailableBots(targetDs.larkAppId, targetDs.chatId),
      targetDs.pendingFollowUps,
      { name: selfBot.botName, openId: selfBot.botOpenId },
      locTarget,
      targetDs.pendingSender,
    );
    targetDs.pendingPrompt = undefined;
    targetDs.pendingAttachments = undefined;
    targetDs.pendingMentions = undefined;
    targetDs.pendingSender = undefined;
    targetDs.pendingFollowUps = undefined;
    forkWorker(targetDs, prompt);
    await sessionReply(rootId, t('cmd.repo.selected_in_pending', { name: displayName }, locTarget));
    logger.info(`[${tag(targetDs)}] Repo selected: ${selectedPath}, spawning CLI`);
  } else {
    // Mid-session repo switch — close old session, start fresh.
    killWorker(targetDs);
    // Park the current card in `frozenCards` so the next POST under the new
    // session sweeps it via recall. closeSession() wipes the on-disk
    // frozen-cards file under the OLD sessionId, but the in-memory Map
    // travels with `targetDs` into the new session and still carries the
    // old messageId for deletion. If fork or POST fails, the parked card
    // stays in the thread instead of vanishing prematurely.
    parkStreamCard(targetDs);
    sessionStore.closeSession(targetDs.session.sessionId);
    const session = sessionStore.createSession(targetDs.chatId, rootId, displayName, targetDs.chatType);
    targetDs.session = session;
    // Pin workingDir + larkAppId onto the new session before forkWorker.
    // Without this, a daemon restart restores the session with an empty
    // workingDir and the worker spawns in the bot's default cwd, so
    // `claude --resume` looks in the wrong .claude/projects/<hash>/ dir and
    // exits code 0 immediately, crash-looping until the rate-limiter trips.
    targetDs.session.workingDir = selectedPath;
    targetDs.session.larkAppId = targetDs.larkAppId;
    sessionStore.updateSession(targetDs.session);
    targetDs.hasHistory = false;
    // Re-persist the parked card under the NEW sessionId so a daemon crash
    // before the next POST doesn't strand it. closeSession() above wiped
    // the on-disk file under the OLD sessionId; without this re-save, the
    // in-memory Map only survives in process memory.
    if (targetDs.frozenCards && targetDs.frozenCards.size > 0) {
      saveFrozenCards(targetDs.session.sessionId, targetDs.frozenCards);
    }
    // Drop the old turn's streaming-card reference so worker_ready POSTs a
    // fresh card for the new session instead of PATCHing the previous one.
    targetDs.streamCardId = undefined;
    targetDs.streamCardNonce = undefined;
    targetDs.streamCardPending = undefined;
    targetDs.lastScreenContent = undefined;
    targetDs.lastScreenStatus = undefined;
    forkWorker(targetDs, '', false);
    await sessionReply(rootId, t('cmd.repo.switched_to', { name: displayName }, locTarget));
    logger.info(`[${tag(targetDs)}] Repo switched to ${selectedPath}, new session created`);
  }

  // Withdraw the repo selection card
  if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
  targetDs.repoCardMessageId = undefined;
}
