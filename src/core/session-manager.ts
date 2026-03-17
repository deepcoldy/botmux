/**
 * Session manager — session helper functions extracted from daemon.ts.
 * Handles working directory resolution, attachment downloads, prompt building,
 * session restoration, and scheduled task execution.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import * as messageQueue from '../services/message-queue.js';
import { downloadMessageResource } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { forkWorker, killStalePids, getCurrentCliVersion } from './worker-pool.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
import { getBot, getAllBots } from '../bot-registry.js';
import type { CliId } from '../adapters/cli/types.js';
import type { LarkAttachment, LarkMention, ScheduledTask } from '../types.js';
import type { MessageResource } from '../im/lark/message-parser.js';
import { sessionKey } from './types.js';
import type { DaemonSession } from './types.js';

// ─── Path helpers ────────────────────────────────────────────────────────────

export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function getSessionWorkingDir(ds?: DaemonSession): string {
  if (ds?.workingDir) return expandHome(ds.workingDir);
  if (ds?.larkAppId) {
    const bot = getBot(ds.larkAppId);
    return expandHome(bot.config.workingDir ?? '~');
  }
  // Fallback for calls without a session (e.g. during restore)
  return expandHome(config.daemon.workingDir);
}

export function getProjectScanDir(ds?: DaemonSession): string {
  // Priority: PROJECT_SCAN_DIR env > parent of current working dir
  if (config.daemon.projectScanDir) {
    return expandHome(config.daemon.projectScanDir);
  }
  const cwd = getSessionWorkingDir(ds);
  return resolve(cwd, '..');
}

/** Return all directories to scan for projects (supports multi-dir WORKING_DIR). */
export function getProjectScanDirs(ds?: DaemonSession): string[] {
  if (ds?.larkAppId) {
    const bot = getBot(ds.larkAppId);
    if (bot.config.projectScanDir) {
      return [expandHome(bot.config.projectScanDir)];
    }
    const dirs = new Set<string>();
    for (const wd of bot.config.workingDirs ?? [bot.config.workingDir ?? '~']) {
      dirs.add(resolve(expandHome(wd), '..'));
    }
    if (ds.workingDir) {
      dirs.add(resolve(expandHome(ds.workingDir), '..'));
    }
    return [...dirs];
  }
  // Fallback to global config
  if (config.daemon.projectScanDir) {
    return [expandHome(config.daemon.projectScanDir)];
  }
  const dirs = new Set<string>();
  for (const wd of config.daemon.workingDirs) {
    dirs.add(resolve(expandHome(wd), '..'));
  }
  if (ds?.workingDir) {
    dirs.add(resolve(expandHome(ds.workingDir), '..'));
  }
  return [...dirs];
}

// ─── Attachment download ─────────────────────────────────────────────────────

export function getAttachmentsDir(messageId: string): string {
  return join(resolve(config.session.dataDir), 'attachments', messageId);
}

export async function downloadResources(larkAppId: string, messageId: string, resources: MessageResource[]): Promise<LarkAttachment[]> {
  if (resources.length === 0) return [];

  const attachments: LarkAttachment[] = [];
  const dir = getAttachmentsDir(messageId);

  for (const res of resources) {
    const savePath = join(dir, res.name);
    try {
      await downloadMessageResource(larkAppId, messageId, res.key, res.type, savePath);
      attachments.push({ type: res.type, path: savePath, name: res.name });
    } catch (err: any) {
      logger.warn(`Failed to download ${res.type} ${res.key}: ${err.message}`);
    }
  }

  return attachments;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

export function formatAttachmentsHint(attachments?: LarkAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';
  const lines = attachments.map(a => `- ${a.path}`);
  return `\n\n附件（使用 Read 工具查看）：\n${lines.join('\n')}`;
}

export function buildNewTopicPrompt(
  userMessage: string,
  sessionId: string,
  cliId: CliId,
  cliPathOverride?: string,
  attachments?: LarkAttachment[],
  mentions?: LarkMention[],
  availableBots?: Array<{ name: string; openId: string; cliId: string }>,
): string {
  const adapter = createCliAdapterSync(cliId, cliPathOverride);
  const hints = adapter.systemHints;

  const noteLines = [
    '- 回复使用 send_to_thread（重要结论、方案确认、最终结果）',
    '- 对于代码修改任务，先通过 send_to_thread 发送执行方案给用户确认后再执行',
    ...hints.map(h => `- ${h}`),
  ];

  // Mention metadata section
  let mentionSection = '';
  if (mentions && mentions.length > 0) {
    const mentionLines = mentions.map(m => {
      const idPart = m.openId ? ` → open_id: ${m.openId}` : '';
      return `- @${m.name}${idPart}`;
    });
    mentionSection = `\n\n消息中的 @mention：\n${mentionLines.join('\n')}`;
  }

  // Available bots section
  let botSection = '';
  if (availableBots && availableBots.length > 0) {
    const botLines = availableBots.map(b =>
      `- ${b.name} (open_id: ${b.openId}, CLI: ${b.cliId})`
    );
    botSection = `\n\n当前群聊中的其他机器人：\n${botLines.join('\n')}\n可通过 send_to_thread 的 mentions 参数 @mention 它们协作，也可用 list_bots 工具查询。`;
  }

  return `你已连接到飞书话题，用户发送了：
---
${userMessage}${formatAttachmentsHint(attachments)}
---

Session ID: ${sessionId}

请处理用户的请求，通过 send_to_thread 回复用户（session_id: "${sessionId}"）。

注意：
${noteLines.join('\n')}${mentionSection}${botSection}`;
}

// ─── Session restore ─────────────────────────────────────────────────────────

export function restoreActiveSessions(activeSessions: Map<string, DaemonSession>): void {
  const sessions = sessionStore.listSessions();
  const active = sessions.filter(s => s.status === 'active');

  if (active.length === 0) {
    logger.info('No active sessions to restore');
    return;
  }

  // Kill any stale CLI processes from previous daemon run
  killStalePids(active);

  logger.info(`Registering ${active.length} active session(s) (no CLI spawn until new messages arrive)...`);

  for (const session of active) {
    messageQueue.ensureQueue(session.rootMessageId);

    const larkAppId = session.larkAppId ?? getAllBots()[0]?.config.larkAppId ?? '';
    activeSessions.set(sessionKey(session.rootMessageId, larkAppId), {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId,
      chatId: session.chatId,
      chatType: session.chatType ?? 'group',
      spawnedAt: Date.now(),
      cliVersion: getCurrentCliVersion(),
      lastMessageAt: Date.now(),
      hasHistory: true,  // restored sessions have prior CLI history
      workingDir: session.workingDir,
    });

    logger.debug(`Registered session ${session.sessionId} (thread: ${session.rootMessageId})`);
  }

  // Tmux mode: auto-fork workers for sessions with surviving tmux sessions
  if (config.daemon.backendType === 'tmux') {
    for (const [, ds] of activeSessions) {
      const tmuxName = TmuxBackend.sessionName(ds.session.sessionId);
      if (TmuxBackend.hasSession(tmuxName)) {
        logger.info(`[${ds.session.sessionId.substring(0, 8)}] Tmux session alive, auto-forking worker to re-attach`);
        forkWorker(ds, '', true);
      }
    }
  }

  logger.info(`Restored ${active.length} session(s)${config.daemon.backendType === 'tmux' ? '' : ', waiting for messages to resume'}`);
}

// ─── Scheduled task execution ────────────────────────────────────────────────

export async function executeScheduledTask(
  task: ScheduledTask,
  activeSessions: Map<string, DaemonSession>,
  refreshCliVersion: (...args: any[]) => boolean,
): Promise<void> {
  const defaultBot = getAllBots()[0];
  if (!defaultBot) { logger.warn('No bots configured, skipping scheduled task'); return; }
  const larkAppId = defaultBot.config.larkAppId;

  const { sendMessage } = await import('../im/lark/client.js');

  // Send a top-level message to create a thread
  const rootMessageId = await sendMessage(
    larkAppId,
    task.chatId,
    `🕐 定时任务「${task.name}」开始执行`,
  );

  // Create a session for this thread
  refreshCliVersion(defaultBot.config.cliId, defaultBot.config.cliPathOverride);
  const session = sessionStore.createSession(task.chatId, rootMessageId, `[定时] ${task.name}`);
  session.larkAppId = larkAppId;
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(rootMessageId);

  const prompt = buildNewTopicPrompt(task.prompt, session.sessionId, defaultBot.config.cliId, defaultBot.config.cliPathOverride);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId: task.chatId,
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: getCurrentCliVersion(),
    lastMessageAt: Date.now(),
    hasHistory: false,
    workingDir: task.workingDir,
  };
  activeSessions.set(sessionKey(rootMessageId, larkAppId), ds);
  forkWorker(ds, prompt);

  logger.info(`[scheduler] Task "${task.name}" spawned (session: ${session.sessionId})`);
}
