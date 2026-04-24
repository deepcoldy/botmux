/**
 * Lark card action handler — processes button clicks and dropdown selections
 * from Feishu interactive cards.
 * Extracted from daemon.ts for modularity.
 */
import { execSync } from 'node:child_process';
import { config } from '../../config.js';
import { getBot, getAllBots } from '../../bot-registry.js';
import { canOperate } from './event-dispatcher.js';
import { sendUserMessage, updateMessage, deleteMessage } from './client.js';
import { buildSessionCard, buildStreamingCard, buildTuiPromptCard, buildTuiPromptProcessingCard, buildTuiPromptResolvedCard, getCliDisplayName, truncateContent } from './card-builder.js';
import { logger } from '../../utils/logger.js';
import * as sessionStore from '../../services/session-store.js';
import { loadFrozenCards, saveFrozenCards } from '../../services/frozen-card-store.js';
import { forkWorker, killWorker, scheduleCardPatch } from '../../core/worker-pool.js';
import { getSessionWorkingDir, buildNewTopicPrompt, getAvailableBots, persistStreamCardState } from '../../core/session-manager.js';
import type { DaemonToWorker, DisplayMode, TermActionKey } from '../../types.js';
import { sessionKey, frozenDisplayMode } from '../../core/types.js';
import type { DaemonSession } from '../../core/types.js';
import type { ProjectInfo } from '../../services/project-scanner.js';

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

// ─── Main handler ─────────────────────────────────────────────────────────

export async function handleCardAction(data: CardActionData, deps: CardHandlerDeps, larkAppId?: string): Promise<any> {
  const { activeSessions, lastRepoScan } = deps;
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const action = data?.action;
  const value = action?.value;
  const cardMessageId = data?.context?.open_message_id ?? data?.open_message_id;

  // Check ALLOWED_USERS for sensitive actions.
  // Use the receiving bot's allowedUsers — the operator open_id in card actions
  // is scoped to the app that received the callback.
  const operatorOpenId = data?.operator?.open_id;
  const isSensitive = value?.action && ['restart', 'close', 'skip_repo', 'get_write_link', 'toggle_stream', 'toggle_display', 'export_text', 'term_action', 'refresh_screenshot', 'takeover', 'disconnect', 'tui_keys', 'tui_text_input'].includes(value.action);
  if (isSensitive) {
    const rootId = value?.root_id;
    // activeSessions here is keyed by sessionKey(rootId, larkAppId); try both
    // the per-bot key and the raw rootId (legacy single-bot shape) so ds
    // lookup works for both code paths.
    const ds = rootId
      ? (larkAppId
          ? activeSessions.get(`${rootId}:${larkAppId}`) ?? activeSessions.get(rootId)
          : activeSessions.get(rootId))
      : undefined;
    const effectiveAppId = larkAppId ?? ds?.larkAppId;
    const chatId = ds?.chatId;
    if (effectiveAppId) {
      if (!canOperate(effectiveAppId, chatId, operatorOpenId)) {
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
    const ds = activeSessions.get(sKey);

    if (actionType === 'restart' && ds) {
      const botCfg = getBot(ds.larkAppId).config;
      if (ds.worker) {
        // Worker alive — tell it to restart CLI
        logger.info(`[${tag(ds)}] Restart via card button`);
        ds.worker.send({ type: 'restart' } as DaemonToWorker);
        const cliName = getCliDisplayName(botCfg.cliId);
        await sessionReply(rootId, `🔄 已重启 ${cliName}`);
      } else {
        // Worker gone (e.g. after daemon restart) — re-fork
        logger.info(`[${tag(ds)}] Re-forking worker via card button`);
        forkWorker(ds, '', ds.hasHistory);
        const cliName = getCliDisplayName(botCfg.cliId);
        await sessionReply(rootId, `🔄 已重新启动 ${cliName}`);
        // DM card will be sent by the ready handler when worker starts
      }
    }

    if (actionType === 'close' && ds) {
      killWorker(ds);
      sessionStore.closeSession(ds.session.sessionId);
      activeSessions.delete(sKey);
      await sessionReply(rootId, '✅ 会话已关闭');
      logger.info(`[${tag(ds)}] Closed via card button`);
    }

    if (actionType === 'disconnect' && ds) {
      killWorker(ds);
      sessionStore.closeSession(ds.session.sessionId);
      activeSessions.delete(sKey);
      await sessionReply(rootId, '⏏ 已断开，原 CLI 会话不受影响');
      logger.info(`[${tag(ds)}] Disconnected (adopt) via card button`);
    }

    if (actionType === 'takeover' && ds && ds.adoptedFrom) {
      const adopted = ds.adoptedFrom;
      if (!adopted.sessionId) {
        await sessionReply(rootId, '⚠️ 无法接管：未找到 CLI session ID');
        return;
      }

      // Kill adopt worker (detaches from user's pane)
      killWorker(ds);

      // Capture adopt info before clearing state
      const origPid = adopted.originalCliPid;
      const paneTarget = adopted.tmuxTarget;
      const resumeSessionId = adopted.sessionId;
      const origCliId = adopted.cliId ?? 'claude-code';

      // Clear adopt state, set up for standard botmux session
      const originalSessionId = adopted.sessionId;
      const originalCwd = adopted.cwd;
      ds.adoptedFrom = undefined;
      ds.session.adoptedFrom = undefined;
      ds.workingDir = originalCwd;
      ds.session.workingDir = originalCwd;
      ds.hasHistory = true;

      // Replace session ID with original CLI session ID for --resume.
      // closeSession mutates the session object in-place (shared reference),
      // so we must re-activate afterwards to prevent the new session from
      // being saved as 'closed'.
      sessionStore.closeSession(ds.session.sessionId);
      ds.session.sessionId = originalSessionId;
      ds.session.status = 'active';
      ds.session.closedAt = undefined;
      // Clear old port so the new worker gets a fresh one (old worker may still hold it)
      ds.session.webPort = undefined;
      // Clear streaming card state so the new worker creates a fresh card
      ds.streamCardId = undefined;
      ds.streamCardNonce = undefined;
      ds.streamCardPending = undefined;
      ds.lastScreenContent = undefined;
      ds.lastScreenStatus = undefined;
      ds.session.streamCardId = undefined;
      ds.session.streamCardNonce = undefined;
      ds.session.displayMode = undefined;
      ds.session.currentImageKey = undefined;
      ds.session.streamExpanded = undefined;
      ds.session.currentTurnTitle = undefined;
      ds.displayMode = undefined;
      ds.currentImageKey = undefined;
      sessionStore.updateSession(ds.session);

      // Fork standard Botmux worker with resume — BEFORE killing original CLI,
      // so the new worker reads the session file while it's still intact.
      forkWorker(ds, '', true);

      // Kill original CLI and echo notice AFTER forkWorker, with a delay to let
      // the new worker read the session file first. Use SIGKILL to prevent the
      // original CLI's shutdown handler from modifying the session file.
      const resumeCmd: Record<string, string> = {
        'claude-code': `claude --resume ${resumeSessionId}`,
        'aiden': `aiden --resume ${resumeSessionId}`,
        'coco': `coco --resume ${resumeSessionId}`,
      };
      const resumeHint = resumeCmd[origCliId] ?? `<cli> --resume ${resumeSessionId}`;
      setTimeout(() => {
        if (origPid) {
          try { process.kill(origPid, 'SIGKILL'); } catch { /* already dead */ }
        }
        try {
          const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
          execSync(`tmux send-keys -t ${esc(paneTarget)} C-c`, { stdio: 'ignore', timeout: 2000 });
          const notice = [
            `printf '\\n\\033[1;33m⚠️  此会话已被 botmux 接管\\033[0m\\n`,
            `session: ${resumeSessionId}\\n`,
            `\\n`,
            `如需恢复本地操作：\\n`,
            `  1. 在飞书中 /close 关闭当前接管会话\\n`,
            `  2. ${resumeHint}\\n`,
            `\\n'`,
          ].join('');
          execSync(`tmux send-keys -t ${esc(paneTarget)} ${esc(notice)} Enter`, { stdio: 'ignore', timeout: 2000 });
        } catch { /* pane may be gone — benign */ }
      }, 1500);

      await sessionReply(rootId, '🔄 已接管会话，MCP 已启用');
      logger.info(`[${tag(ds)}] Takeover: resumed session ${originalSessionId} as standard botmux session`);
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
          const updatedCard = buildTuiPromptCard(
            ds.session.rootMessageId,
            ds.session.sessionId,
            ds.currentTurnTitle || 'Select options',
            ds.tuiPromptOptions,
            true,
            ds.tuiToggledIndices,
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
          if (cardMessageId) {
            setTimeout(() => {
              const resolvedCard = buildTuiPromptResolvedCard(finalText);
              updateMessage(ds.larkAppId, cardMessageId, resolvedCard).catch(err =>
                logger.debug(`[${tag(ds)}] Failed to update TUI prompt card: ${err}`),
              );
            }, allKeys.length * 100 + 500);
          }
          ds.tuiPromptCardId = undefined;
          ds.tuiPromptOptions = undefined;
          ds.tuiPromptMultiSelect = undefined;
          ds.tuiToggledIndices = undefined;
          try { return JSON.parse(buildTuiPromptProcessingCard(finalText)); } catch { /* fall through */ }
        }
      }
    }

    if (actionType === 'tui_text_input' && ds) {
      const inputText = action?.form_value?.tui_custom_input ?? '';
      let inputKeys: string[] = [];
      try { inputKeys = JSON.parse(value?.input_keys ?? '[]'); } catch { /* bad json */ }
      if (ds.worker && inputText && inputKeys.length > 0) {
        // Atomic IPC — worker handles keys + text in one flow to avoid race
        ds.worker.send({ type: 'tui_text_input', keys: inputKeys, text: inputText } as DaemonToWorker);
        logger.info(`[${tag(ds)}] TUI text input: "${inputText}" (keys: ${JSON.stringify(inputKeys)})`);
        if (cardMessageId) {
          const resolvedCard = buildTuiPromptResolvedCard(inputText);
          updateMessage(ds.larkAppId, cardMessageId, resolvedCard).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to update TUI prompt card: ${err}`),
          );
        }
        ds.tuiPromptCardId = undefined;
        ds.tuiPromptOptions = undefined;
      }
      try {
        return JSON.parse(buildTuiPromptResolvedCard(inputText || 'Custom input'));
      } catch { /* fall through */ }
    }

    if (actionType === 'get_write_link' && ds && operatorOpenId) {
      const botCfg = getBot(ds.larkAppId).config;
      if (ds.workerPort && ds.workerToken) {
        const writeUrl = `http://${config.web.externalHost}:${ds.workerPort}?token=${ds.workerToken}`;
        const dmCardJson = buildSessionCard(
          ds.session.sessionId,
          ds.session.rootMessageId,
          writeUrl,
          ds.session.title || getCliDisplayName(botCfg.cliId),
          botCfg.cliId,
          true, // showManageButtons — DM card includes restart & close
        );
        sendUserMessage(ds.larkAppId, operatorOpenId, dmCardJson, 'interactive').catch(err =>
          logger.warn(`[${tag(ds)}] Failed to DM write link: ${err}`),
        );
        logger.info(`[${tag(ds)}] Sent write link via DM to ${operatorOpenId}`);
      } else {
        await sessionReply(rootId, '⚠️ 终端尚未就绪，请稍后再试。');
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
          logger.debug(`[${tag(ds)}] Toggle on unknown frozen card: nonce=${clickedNonce}`);
          return;
        }
        const cur = frozenDisplayMode(frozen);
        const next = nextMode(cur);
        frozen.displayMode = next;
        frozen.expanded = next !== 'hidden';
        const botCfg = getBot(ds.larkAppId).config;
        const readUrl = ds.workerPort ? `http://${config.web.externalHost}:${ds.workerPort}` : '';
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          ds.session.rootMessageId,
          readUrl,
          frozen.title,
          frozen.content,
          'idle',
          botCfg.cliId,
          next,
          clickedNonce,
          frozen.imageKey,
        );
        updateMessage(ds.larkAppId, frozen.messageId, cardJson).catch(err =>
          logger.debug(`[${tag(ds)}] Failed to toggle frozen card: ${err}`),
        );
        saveFrozenCards(ds.session.sessionId, ds.frozenCards);
        logger.info(`[${tag(ds)}] Frozen card toggled to ${next} (nonce=${clickedNonce})`);
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
        return;
      }

      // Current (latest) card — change displayMode + tell worker
      const botCfg = getBot(ds.larkAppId).config;
      const cur: DisplayMode = ds.displayMode ?? 'hidden';
      const next = nextMode(cur);
      ds.displayMode = next;
      persistStreamCardState(ds);
      if (ds.worker) {
        ds.worker.send({ type: 'set_display_mode', mode: next } as DaemonToWorker);
      }
      if (ds.streamCardId && ds.workerPort) {
        const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          ds.session.rootMessageId,
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          botCfg.cliId,
          next,
          ds.streamCardNonce,
          ds.currentImageKey,
        );
        scheduleCardPatch(ds, cardJson);
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
      const body = content.trim() ? truncateContent(content) : '(当前无输出内容)';
      await sessionReply(ds.session.rootMessageId, body);
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
        const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          ds.session.rootMessageId,
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          botCfg.cliId,
          ds.displayMode ?? 'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
        );
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
      // Return the current card JSON so Feishu doesn't revert the displayed
      // image to the originally-POSTed initial frame while waiting for the
      // post-action screenshot PATCH (~1s). Keep status unchanged — Feishu's
      // built-in button spinner already shows that the click registered, and
      // overriding to 'analyzing' was confusing (AI analysis uses that color).
      if (ds.streamCardId && ds.streamCardId !== '__posting__' && ds.workerPort) {
        const botCfg = getBot(ds.larkAppId).config;
        const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          ds.session.rootMessageId,
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          botCfg.cliId,
          ds.displayMode ?? 'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
        );
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      return;
    }

    if (actionType === 'skip_repo' && ds) {
      if (ds.pendingRepo) {
        const selfBot = getBot(ds.larkAppId);
        const botCfg = selfBot.config;
        // Skip repo selection — spawn CLI with default working dir
        ds.pendingRepo = false;
        const prompt = buildNewTopicPrompt(
          ds.pendingPrompt ?? '',
          ds.session.sessionId,
          botCfg.cliId,
          botCfg.cliPathOverride,
          ds.pendingAttachments,
          ds.pendingMentions,
          await getAvailableBots(ds.larkAppId, ds.chatId),
          ds.pendingFollowUps,
          { name: selfBot.botName, openId: selfBot.botOpenId },
        );
        ds.pendingPrompt = undefined;
        ds.pendingAttachments = undefined;
        ds.pendingMentions = undefined;
        ds.pendingFollowUps = undefined;
        forkWorker(ds, prompt);
        const cwd = getSessionWorkingDir(ds);
        await sessionReply(rootId, `▶️ 已直接开启会话（工作目录：${cwd}）`);
        logger.info(`[${tag(ds)}] Skip repo, spawning CLI in ${cwd}`);
      } else {
        // Mid-session: user cancelled repo switch
        await sessionReply(rootId, `继续使用当前仓库：${getSessionWorkingDir(ds)}`);
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

    // Parse selected session info
    let selected: { tmuxTarget: string; cliPid: number };
    try { selected = JSON.parse(option); } catch { return; }

    // Re-discover to get full session info and validate
    const { discoverAdoptableSessions } = await import('../../core/session-discovery.js');
    const sessions = discoverAdoptableSessions();
    const target = sessions.find(s => s.tmuxTarget === selected.tmuxTarget && s.cliPid === selected.cliPid);
    if (!target) {
      await sessionReply(rootId, '⚠️ 目标 CLI 会话已退出');
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

  // Resolve the project name from cached scan
  const cached = lastRepoScan.get(targetDs.chatId);
  const project = cached?.find(p => p.path === selectedPath);
  const displayName = project ? `${project.name} (${project.branch})` : selectedPath;

  targetDs.workingDir = selectedPath;
  targetDs.session.workingDir = selectedPath;
  sessionStore.updateSession(targetDs.session);

  if (targetDs.pendingRepo) {
    const selfBot = getBot(targetDs.larkAppId);
    const botCfg = selfBot.config;
    // First-time repo selection — now spawn CLI with the original prompt
    targetDs.pendingRepo = false;
    const prompt = buildNewTopicPrompt(
      targetDs.pendingPrompt ?? '',
      targetDs.session.sessionId,
      botCfg.cliId,
      botCfg.cliPathOverride,
      targetDs.pendingAttachments,
      targetDs.pendingMentions,
      await getAvailableBots(targetDs.larkAppId, targetDs.chatId),
      targetDs.pendingFollowUps,
      { name: selfBot.botName, openId: selfBot.botOpenId },
    );
    targetDs.pendingPrompt = undefined;
    targetDs.pendingAttachments = undefined;
    targetDs.pendingMentions = undefined;
    targetDs.pendingFollowUps = undefined;
    forkWorker(targetDs, prompt);
    await sessionReply(rootId, `✅ 已选择 ${displayName}`);
    logger.info(`[${tag(targetDs)}] Repo selected: ${selectedPath}, spawning CLI`);
  } else {
    // Mid-session repo switch — close old session, start fresh
    killWorker(targetDs);
    sessionStore.closeSession(targetDs.session.sessionId);
    const session = sessionStore.createSession(targetDs.chatId, rootId, displayName, targetDs.chatType);
    targetDs.session = session;
    targetDs.hasHistory = false;
    // Drop the old turn's streaming-card reference so worker_ready POSTs a
    // fresh card for the new session instead of PATCHing the previous one.
    targetDs.streamCardId = undefined;
    targetDs.streamCardNonce = undefined;
    targetDs.streamCardPending = undefined;
    targetDs.lastScreenContent = undefined;
    targetDs.lastScreenStatus = undefined;
    forkWorker(targetDs, '', false);
    await sessionReply(rootId, `🔄 已切换到 ${displayName}`);
    logger.info(`[${tag(targetDs)}] Repo switched to ${selectedPath}, new session created`);
  }

  // Withdraw the repo selection card
  if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
  targetDs.repoCardMessageId = undefined;
}
