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
import { forkWorker, killStalePids, getCurrentClaudeVersion } from './worker-pool.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { LarkAttachment, ScheduledTask } from '../types.js';
import type { MessageResource } from '../im/lark/message-parser.js';
import type { DaemonSession } from './types.js';

// ─── Path helpers ────────────────────────────────────────────────────────────

export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function getSessionWorkingDir(ds?: DaemonSession): string {
  return expandHome(ds?.workingDir ?? config.daemon.workingDir);
}

export function getProjectScanDir(ds?: DaemonSession): string {
  // Priority: PROJECT_SCAN_DIR env > parent of current working dir
  if (config.daemon.projectScanDir) {
    return expandHome(config.daemon.projectScanDir);
  }
  const cwd = getSessionWorkingDir(ds);
  return resolve(cwd, '..');
}

// ─── Attachment download ─────────────────────────────────────────────────────

export function getAttachmentsDir(messageId: string): string {
  return join(resolve(config.session.dataDir), 'attachments', messageId);
}

export async function downloadResources(messageId: string, resources: MessageResource[]): Promise<LarkAttachment[]> {
  if (resources.length === 0) return [];

  const attachments: LarkAttachment[] = [];
  const dir = getAttachmentsDir(messageId);

  for (const res of resources) {
    const savePath = join(dir, res.name);
    try {
      await downloadMessageResource(messageId, res.key, res.type, savePath);
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

export function buildNewTopicPrompt(userMessage: string, sessionId: string, attachments?: LarkAttachment[]): string {
  const adapter = createCliAdapterSync(config.daemon.cliId, config.daemon.cliPathOverride);
  const hints = adapter.systemHints;

  const noteLines = [
    '- 回复使用 send_to_thread（重要结论、方案确认、最终结果）',
    '- 对于代码修改任务，先通过 send_to_thread 发送执行方案给用户确认后再执行',
    ...hints.map(h => `- ${h}`),
  ];

  return `你已连接到飞书话题，用户发送了：
---
${userMessage}${formatAttachmentsHint(attachments)}
---

Session ID: ${sessionId}

请处理用户的请求，通过 send_to_thread 回复用户（session_id: "${sessionId}"）。

注意：
${noteLines.join('\n')}`;
}

// ─── Session restore ─────────────────────────────────────────────────────────

export function restoreActiveSessions(activeSessions: Map<string, DaemonSession>): void {
  const sessions = sessionStore.listSessions();
  const active = sessions.filter(s => s.status === 'active');

  if (active.length === 0) {
    logger.info('No active sessions to restore');
    return;
  }

  // Kill any stale Claude processes from previous daemon run
  killStalePids(active);

  logger.info(`Registering ${active.length} active session(s) (no Claude spawn until new messages arrive)...`);

  for (const session of active) {
    messageQueue.ensureQueue(session.rootMessageId);

    activeSessions.set(session.rootMessageId, {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      chatId: session.chatId,
      chatType: session.chatType ?? 'group',
      spawnedAt: Date.now(),
      claudeVersion: getCurrentClaudeVersion(),
      lastMessageAt: Date.now(),
      hasHistory: true,  // restored sessions have prior Claude history
      workingDir: session.workingDir,
    });

    logger.debug(`Registered session ${session.sessionId} (thread: ${session.rootMessageId})`);
  }

  logger.info(`Restored ${active.length} session(s), waiting for messages to resume`);
}

// ─── Scheduled task execution ────────────────────────────────────────────────

export async function executeScheduledTask(
  task: ScheduledTask,
  activeSessions: Map<string, DaemonSession>,
  refreshClaudeVersion: () => boolean,
): Promise<void> {
  const { sendMessage } = await import('../im/lark/client.js');

  // Send a top-level message to create a thread
  const rootMessageId = await sendMessage(
    task.chatId,
    `🕐 定时任务「${task.name}」开始执行`,
  );

  // Create a session for this thread
  refreshClaudeVersion();
  const session = sessionStore.createSession(task.chatId, rootMessageId, `[定时] ${task.name}`);
  messageQueue.ensureQueue(rootMessageId);

  const prompt = buildNewTopicPrompt(task.prompt, session.sessionId);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    chatId: task.chatId,
    chatType: 'group',
    spawnedAt: Date.now(),
    claudeVersion: getCurrentClaudeVersion(),
    lastMessageAt: Date.now(),
    hasHistory: false,
    workingDir: task.workingDir,
  };
  activeSessions.set(rootMessageId, ds);
  forkWorker(ds, prompt);

  logger.info(`[scheduler] Task "${task.name}" spawned (session: ${session.sessionId})`);
}
