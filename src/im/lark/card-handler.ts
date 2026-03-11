/**
 * Lark card action handler — processes button clicks and dropdown selections
 * from Feishu interactive cards.
 * Extracted from daemon.ts for modularity.
 */
import { config } from '../../config.js';
import { sendUserMessage } from './client.js';
import { buildSessionCard } from './card-builder.js';
import { logger } from '../../utils/logger.js';
import * as sessionStore from '../../services/session-store.js';
import { forkWorker, killWorker } from '../../core/worker-pool.js';
import { getSessionWorkingDir, buildNewTopicPrompt } from '../../core/session-manager.js';
import type { DaemonToWorker } from '../../types.js';
import type { DaemonSession } from '../../daemon.js';
import type { ProjectInfo } from '../../services/project-scanner.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CardHandlerDeps {
  activeSessions: Map<string, DaemonSession>;
  sessionReply: (rootId: string, content: string, msgType?: string) => Promise<string>;
  lastRepoScan: Map<string, ProjectInfo[]>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

// ─── Main handler ─────────────────────────────────────────────────────────

export async function handleCardAction(data: any, deps: CardHandlerDeps): Promise<void> {
  const { activeSessions, sessionReply, lastRepoScan } = deps;
  const action = data?.action;
  const value = action?.value;

  // Check ALLOWED_USERS for sensitive actions
  const operatorOpenId: string | undefined = data?.operator?.open_id;
  const allowedUsers = config.daemon.allowedUsers;
  const isSensitive = value?.action && ['restart', 'close', 'skip_repo', 'get_write_link'].includes(value.action);
  if (isSensitive && allowedUsers.length > 0) {
    if (!operatorOpenId || !allowedUsers.includes(operatorOpenId)) {
      logger.info(`Card action "${value.action}" blocked for non-allowed user: ${operatorOpenId}`);
      return;
    }
  }

  // Handle session card button actions (restart/close)
  if (value?.action) {
    const { action: actionType, root_id: rootId } = value;
    const ds = activeSessions.get(rootId);

    if (actionType === 'restart' && ds) {
      if (ds.worker) {
        // Worker alive — tell it to restart Claude
        logger.info(`[${tag(ds)}] Restart via card button`);
        ds.worker.send({ type: 'restart' } as DaemonToWorker);
        await sessionReply(rootId, '🔄 已重启 Claude');
      } else {
        // Worker gone (e.g. after daemon restart) — re-fork
        logger.info(`[${tag(ds)}] Re-forking worker via card button`);
        forkWorker(ds, '', ds.hasHistory);
        await sessionReply(rootId, '🔄 已重新启动 Claude');
        // DM card will be sent by the ready handler when worker starts
      }
    }

    if (actionType === 'close' && ds) {
      killWorker(ds);
      sessionStore.closeSession(ds.session.sessionId);
      activeSessions.delete(rootId);
      await sessionReply(rootId, '✅ 会话已关闭');
      logger.info(`[${tag(ds)}] Closed via card button`);
    }

    if (actionType === 'get_write_link' && ds && operatorOpenId) {
      if (ds.workerPort && ds.workerToken) {
        const writeUrl = `http://${config.web.externalHost}:${ds.workerPort}?token=${ds.workerToken}`;
        const dmCardJson = buildSessionCard(
          ds.session.sessionId,
          ds.session.rootMessageId,
          writeUrl,
          ds.session.title || 'Claude Code',
        );
        sendUserMessage(operatorOpenId, dmCardJson, 'interactive').catch(err =>
          logger.warn(`[${tag(ds)}] Failed to DM write link: ${err}`),
        );
        logger.info(`[${tag(ds)}] Sent write link via DM to ${operatorOpenId}`);
      } else {
        await sessionReply(rootId, '⚠️ 终端尚未就绪，请稍后再试。');
      }
    }

    if (actionType === 'skip_repo' && ds && ds.pendingRepo) {
      // Skip repo selection — spawn Claude with default working dir
      ds.pendingRepo = false;
      const prompt = buildNewTopicPrompt(
        ds.pendingPrompt ?? '',
        ds.session.sessionId,
        ds.pendingAttachments,
      );
      ds.pendingPrompt = undefined;
      ds.pendingAttachments = undefined;
      forkWorker(ds, prompt);
      const cwd = getSessionWorkingDir(ds);
      await sessionReply(rootId, `▶️ 已直接开启会话（工作目录：${cwd}）`);
      logger.info(`[${tag(ds)}] Skip repo, spawning Claude in ${cwd}`);
    }
    return;
  }

  // Handle repo select card (option-based dropdown)
  const option = action?.option;
  if (!option) {
    logger.warn('Card action received but no option or action value');
    return;
  }

  const selectedPath = option;
  const rootId = action?.value?.root_id;
  logger.info(`Card action: repo switch to ${selectedPath} (root_id: ${rootId})`);

  if (!rootId) {
    logger.warn('Card action: no root_id in action value');
    return;
  }

  const targetDs = activeSessions.get(rootId);
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
    // First-time repo selection — now spawn Claude with the original prompt
    targetDs.pendingRepo = false;
    const prompt = buildNewTopicPrompt(
      targetDs.pendingPrompt ?? '',
      targetDs.session.sessionId,
      targetDs.pendingAttachments,
    );
    targetDs.pendingPrompt = undefined;
    targetDs.pendingAttachments = undefined;
    forkWorker(targetDs, prompt);
    await sessionReply(rootId, `✅ 已选择 ${displayName}`);
    logger.info(`[${tag(targetDs)}] Repo selected: ${selectedPath}, spawning Claude`);
  } else {
    // Mid-session repo switch — close old session, start fresh
    killWorker(targetDs);
    sessionStore.closeSession(targetDs.session.sessionId);
    const session = sessionStore.createSession(targetDs.chatId, rootId, displayName, targetDs.chatType);
    targetDs.session = session;
    targetDs.hasHistory = false;
    forkWorker(targetDs, '', false);
    await sessionReply(rootId, `🔄 已切换到 ${displayName}\n旧会话已关闭，新会话已创建。`);
    logger.info(`[${tag(targetDs)}] Repo switched to ${selectedPath}, new session created`);
  }
}
