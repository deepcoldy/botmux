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
import { downloadMessageResource, listChatBotMembers } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { forkWorker, forkAdoptWorker, killStalePids, getCurrentCliVersion } from './worker-pool.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
import { getBot, getAllBots } from '../bot-registry.js';
import type { CliId } from '../adapters/cli/types.js';
import { validateAdoptTarget } from './session-discovery.js';
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

export async function downloadResources(larkAppId: string, messageId: string, resources: MessageResource[]): Promise<{ attachments: LarkAttachment[]; needLogin: boolean }> {
  if (resources.length === 0) return { attachments: [], needLogin: false };

  const attachments: LarkAttachment[] = [];
  const dir = getAttachmentsDir(messageId);
  let needLogin = false;

  for (const res of resources) {
    const savePath = join(dir, res.name);
    try {
      const resMessageId = res.messageId ?? messageId;
      await downloadMessageResource(larkAppId, resMessageId, res.key, res.type, savePath);
      attachments.push({ type: res.type, path: savePath, name: res.name });
    } catch (err: any) {
      logger.warn(`Failed to download ${res.type} ${res.key}: ${err.message}`);
      if (err.message?.includes('User Token')) needLogin = true;
    }
  }

  return { attachments, needLogin };
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

/** Get bots actually present in the chat (excludes current bot).
 *  Calls Lark OpenAPI to list chat members, then cross-references with
 *  registered bots to enrich with cliId. Falls back to empty on API error. */
export async function getAvailableBots(
  currentAppId: string,
  chatId: string,
): Promise<Array<{ name: string; displayName: string; openId: string }>> {
  try {
    const currentBot = getBot(currentAppId);
    const myCliId = currentBot.config.cliId;
    const chatBots = await listChatBotMembers(currentAppId, chatId);

    return chatBots
      .filter(b => b.name !== myCliId)
      .map(b => ({
        name: b.name,
        displayName: b.displayName,
        openId: b.openId,
      }));
  } catch (err) {
    logger.warn(`Failed to list chat bot members, skipping bot section: ${err}`);
    return [];
  }
}

export function formatAttachmentsHint(attachments?: LarkAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';
  const lines = attachments.map(a => `- (${a.path})`);
  return `\n\n附件（使用 Read 工具查看）：\n${lines.join('\n')}`;
}

export function buildNewTopicPrompt(
  userMessage: string,
  sessionId: string,
  cliId: CliId,
  cliPathOverride?: string,
  attachments?: LarkAttachment[],
  mentions?: LarkMention[],
  availableBots?: Array<{ name: string; displayName: string; openId: string }>,
  followUps?: string[],
): string {
  const adapter = createCliAdapterSync(cliId, cliPathOverride);
  const hints = adapter.systemHints;

  const noteLines = hints.map(h => `- ${h}`);

  // Mention metadata section
  let mentionSection = '';
  if (mentions && mentions.length > 0) {
    const mentionLines = mentions.map(m => {
      const idPart = m.openId ? ` → open_id: ${m.openId}` : '';
      return `- @${m.name}${idPart}`;
    });
    mentionSection = `\n\n消息中的 @mention：\n${mentionLines.join('\n')}`;
  }

  // Available bots section — only show bots NOT already in @mentions
  let botSection = '';
  if (availableBots && availableBots.length > 0) {
    const mentionedOpenIds = new Set(mentions?.map(m => m.openId).filter(Boolean));
    const unmentionedBots = availableBots.filter(b => !mentionedOpenIds.has(b.openId));
    if (unmentionedBots.length > 0) {
      const botLines = unmentionedBots.map(b => `- ${b.displayName} (open_id: ${b.openId})`);
      botSection = `\n\n当前群聊中的其他机器人：\n${botLines.join('\n')}\n可通过 botmux send --mention 参数 @mention 它们协作，也可用 botmux bots list 查询。`;
    }
  }

  // CLIs with injectsSessionContext get Lark context via system prompt,
  // so pass user messages cleanly without wrapper — same format as follow-ups.
  const attachHint = formatAttachmentsHint(attachments);
  const parts: string[] = adapter.injectsSessionContext
    ? [`${userMessage}${attachHint}`]
    : [`用户发送了：\n---\n${userMessage}${attachHint}\n---`];

  // Append follow-up messages buffered during repo selection
  if (followUps && followUps.length > 0) {
    for (const fu of followUps) {
      parts.push(adapter.injectsSessionContext ? fu : `用户追加了：\n---\n${fu}\n---`);
    }
  }

  if (!adapter.injectsSessionContext) {
    parts.push(`Session ID: ${sessionId}`);
  }
  if (noteLines.length > 0) parts.push(noteLines.join('\n'));
  if (mentionSection) parts.push(mentionSection.trim());
  if (botSection) parts.push(botSection.trim());

  return parts.join('\n\n');
}

/**
 * Build the content for a follow-up message (thread reply to an active session).
 * Mirrors buildNewTopicPrompt structure but for subsequent messages.
 * Session ID is omitted for adopt mode and CLIs with injectsSessionContext.
 */
export function buildFollowUpContent(
  content: string,
  sessionId: string,
  opts?: { attachments?: LarkAttachment[]; mentions?: LarkMention[]; isAdoptMode?: boolean; cliId?: CliId; cliPathOverride?: string },
): string {
  const parts: string[] = [
    opts?.attachments && opts.attachments.length > 0
      ? `${content}${formatAttachmentsHint(opts.attachments)}`
      : content,
  ];

  if (!opts?.isAdoptMode) {
    // CLIs with injectsSessionContext get session ID via system prompt + MCP auto-detection
    const skipSessionId = opts?.cliId
      ? createCliAdapterSync(opts.cliId, opts.cliPathOverride).injectsSessionContext
      : false;
    if (!skipSessionId) {
      parts.push(`Session ID: ${sessionId}`);
    }
  }

  if (opts?.mentions && opts.mentions.length > 0) {
    const mentionLines = opts.mentions.map(m => {
      const idPart = m.openId ? ` → open_id: ${m.openId}` : '';
      return `- @${m.name}${idPart}`;
    });
    parts.push(`消息中的 @mention：\n${mentionLines.join('\n')}`);
  }

  // Per-message routing hint — keeps the "use botmux send" instruction
  // close to the latest attention window, preventing long-context forgetting.
  // ~8 tokens per message, negligible cost.
  parts.push('[回复请用 botmux send，终端输出用户看不到]');

  return parts.join('\n\n');
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
    // Adopt sessions: restore if original CLI is still alive, otherwise close
    if (session.title?.startsWith('Adopt:') && session.adoptedFrom) {
      const adopted = session.adoptedFrom;
      if (!validateAdoptTarget(adopted.tmuxTarget, adopted.originalCliPid)) {
        logger.info(`Closing adopt session ${session.sessionId} (original CLI exited)`);
        sessionStore.closeSession(session.sessionId);
        continue;
      }
      // Original CLI still alive — re-register and fork adopt worker
      messageQueue.ensureQueue(session.rootMessageId);
      const larkAppId = session.larkAppId ?? getAllBots()[0]?.config.larkAppId ?? '';
      const ds: DaemonSession = {
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
        hasHistory: false,
        workingDir: adopted.cwd,
        adoptedFrom: adopted as DaemonSession['adoptedFrom'],
      };
      activeSessions.set(sessionKey(session.rootMessageId, larkAppId), ds);
      forkAdoptWorker(ds);
      logger.info(`[${session.sessionId.substring(0, 8)}] Restored adopt session (target: ${adopted.tmuxTarget})`);
      continue;
    }
    // Adopt sessions without persisted metadata — close (legacy)
    if (session.title?.startsWith('Adopt:')) {
      logger.debug(`Closing adopt session ${session.sessionId} (no persisted metadata)`);
      sessionStore.closeSession(session.sessionId);
      continue;
    }
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
  // Resolve which bot to use — prefer the task's original bot so replies come from
  // the same account the user set up the schedule with.
  const allBots = getAllBots();
  if (allBots.length === 0) { logger.warn('No bots configured, skipping scheduled task'); return; }
  const bot =
    (task.larkAppId && allBots.find(b => b.config.larkAppId === task.larkAppId)) ||
    allBots[0];
  const larkAppId = bot.config.larkAppId;

  const { sendMessage, replyMessage } = await import('../im/lark/client.js');

  // Decide where to route: preferred path is to reply inside the original thread.
  // Fallback (legacy tasks without rootMessageId): post a new top-level message.
  let threadRootId: string;
  let isContinuation = false;

  if (task.rootMessageId) {
    try {
      // Reply in the original thread — the returned reply message id is just an
      // anchor for this run; the thread's root remains task.rootMessageId, which
      // is what the session/card system keys off.
      await replyMessage(
        larkAppId,
        task.rootMessageId,
        `🕐 定时任务「${task.name}」开始执行`,
        'text',
        true, // reply_in_thread
      );
      threadRootId = task.rootMessageId;
      isContinuation = true;
    } catch (err: any) {
      logger.warn(`[scheduler] Failed to reply in original thread ${task.rootMessageId} (${err.message}); falling back to new thread`);
      threadRootId = await sendMessage(larkAppId, task.chatId, `🕐 定时任务「${task.name}」开始执行`);
    }
  } else {
    threadRootId = await sendMessage(larkAppId, task.chatId, `🕐 定时任务「${task.name}」开始执行`);
  }

  refreshCliVersion(bot.config.cliId, bot.config.cliPathOverride);

  // If a live session already exists for this thread (user was just chatting in it),
  // inject the prompt as a follow-up message rather than spawning a fresh worker.
  const existing = activeSessions.get(sessionKey(threadRootId, larkAppId));
  if (isContinuation && existing?.worker && !existing.worker.killed) {
    existing.lastMessageAt = Date.now();
    try {
      existing.worker.send({ type: 'message', content: task.prompt });
      logger.info(`[scheduler] Task "${task.name}" injected into live session ${existing.session.sessionId}`);
      return;
    } catch (err: any) {
      logger.warn(`[scheduler] Failed to inject into live session (${err.message}); spawning fresh worker`);
    }
  }

  // Otherwise create a new session bound to the original thread root so all the
  // worker's replies continue to land under that topic in Lark.
  const session = sessionStore.createSession(task.chatId, threadRootId, `[定时] ${task.name}`);
  session.larkAppId = larkAppId;
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(threadRootId);

  const prompt = buildNewTopicPrompt(task.prompt, session.sessionId, bot.config.cliId, bot.config.cliPathOverride);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId: task.chatId,
    chatType: task.chatType === 'p2p' ? 'p2p' : 'group',
    spawnedAt: Date.now(),
    cliVersion: getCurrentCliVersion(),
    lastMessageAt: Date.now(),
    hasHistory: isContinuation, // continuation sessions inherit the old thread's context
    workingDir: task.workingDir,
  };
  activeSessions.set(sessionKey(threadRootId, larkAppId), ds);
  forkWorker(ds, prompt);

  logger.info(`[scheduler] Task "${task.name}" spawned (session: ${session.sessionId}, thread: ${threadRootId}, continuation: ${isContinuation})`);
}
