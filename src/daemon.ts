import { ChildProcess, execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config, validateConfig } from './config.js';
import { replyMessage, updateMessage, resolveAllowedUsers } from './im/lark/client.js';
import * as sessionStore from './services/session-store.js';
import * as messageQueue from './services/message-queue.js';
import { parseEventMessage } from './im/lark/message-parser.js';
import { logger } from './utils/logger.js';
import type { Session, DaemonToWorker } from './types.js';
import * as scheduler from './core/scheduler.js';
import { scanProjects } from './services/project-scanner.js';
import { buildRepoSelectCard, buildStreamingCard } from './im/lark/card-builder.js';
import { createCliAdapterSync } from './adapters/cli/registry.js';
import {
  initWorkerPool,
  forkWorker,
  killWorker,
  setCurrentClaudeVersion,
  getCurrentClaudeVersion,
} from './core/worker-pool.js';
import { DAEMON_COMMANDS, handleCommand } from './core/command-handler.js';
import type { CommandHandlerDeps } from './core/command-handler.js';
import {
  getSessionWorkingDir,
  getProjectScanDir,
  downloadResources,
  formatAttachmentsHint,
  buildNewTopicPrompt,
  restoreActiveSessions,
  executeScheduledTask,
} from './core/session-manager.js';
import { handleCardAction } from './im/lark/card-handler.js';
import type { CardHandlerDeps } from './im/lark/card-handler.js';
import { probeBotOpenId, startLarkEventDispatcher } from './im/lark/event-dispatcher.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DaemonSession {
  session: Session;
  worker: ChildProcess | null;   // fork'd worker process
  workerPort: number | null;     // HTTP port for xterm.js
  workerToken: string | null;    // write token for xterm.js
  chatId: string;
  chatType: 'group' | 'p2p';    // p2p chats need reply_in_thread to create topics
  spawnedAt: number;
  claudeVersion: string;
  lastMessageAt: number;
  hasHistory: boolean;   // true after Claude has run at least once for this session
  workingDir?: string;
  initConfig?: DaemonToWorker;   // stored for restart
  pendingRepo?: boolean;         // waiting for repo selection before spawning Claude
  pendingPrompt?: string;        // original user message to send after repo is selected
  pendingAttachments?: import('./types.js').LarkAttachment[];
  ownerOpenId?: string;          // topic creator's open_id — receives write-enabled terminal link via DM
  streamCardId?: string;         // message_id of the streaming card in group (PATCHed with live output)
  streamCardPending?: boolean;    // true when a new turn started, next screen_update creates a new card
  lastScreenContent?: string;    // last screen_update content — used to freeze card at idle
  currentTurnTitle?: string;      // title for the current turn's streaming card
}

// ─── State ───────────────────────────────────────────────────────────────────

const activeSessions = new Map<string, DaemonSession>();
// Cache last /repo scan results per chat for /repo <number> fallback
const lastRepoScan = new Map<string, import('./services/project-scanner.js').ProjectInfo[]>();
let lastVersionCheckAt = 0;
const VERSION_CHECK_INTERVAL = 60_000; // cache 1 min

/**
 * Reply to a message, automatically using reply_in_thread for p2p sessions.
 * In p2p chats, Lark needs reply_in_thread=true to create/continue a thread.
 */
async function sessionReply(rootId: string, content: string, msgType: string = 'text'): Promise<string> {
  const ds = activeSessions.get(rootId);
  const inThread = ds?.chatType === 'p2p';
  return replyMessage(rootId, content, msgType, inThread);
}

// ─── PID file ────────────────────────────────────────────────────────────────

function getPidFile(): string {
  return join(config.session.dataDir, 'daemon.pid');
}

function writePidFile(): void {
  const dir = config.session.dataDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getPidFile(), String(process.pid), 'utf-8');
  logger.info(`PID file written: ${getPidFile()} (pid: ${process.pid})`);
}

function removePidFile(): void {
  const pidFile = getPidFile();
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
    logger.info('PID file removed');
  }
}

// ─── Version tracking ────────────────────────────────────────────────────────

function refreshClaudeVersion(): boolean {
  const now = Date.now();
  if (now - lastVersionCheckAt < VERSION_CHECK_INTERVAL) return false;
  lastVersionCheckAt = now;

  try {
    const adapter = createCliAdapterSync(
      config.daemon.cliId,
      config.daemon.cliPathOverride,
    );
    const raw = execFileSync(adapter.resolvedBin, ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    const newVersion = raw.replace(/^[^0-9]*/, '');

    if (newVersion === 'unknown' || !newVersion) return false;

    const curVer = getCurrentClaudeVersion();
    if (curVer !== 'unknown' && newVersion !== curVer) {
      setCurrentClaudeVersion(newVersion);
      logger.info(`CLI version updated: ${curVer} → ${newVersion} (${adapter.id})`);
      return true;
    }

    setCurrentClaudeVersion(newVersion);
    logger.info(`CLI version: ${getCurrentClaudeVersion()} (${adapter.id})`);
    return false;
  } catch (err: any) {
    logger.warn(`Failed to get CLI version: ${err.message}`);
    return false;
  }
}

// ─── Helpers (local to daemon) ───────────────────────────────────────────────

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

function getActiveCount(): number {
  let count = 0;
  for (const [, ds] of activeSessions) {
    if (ds.worker && !ds.worker.killed) count++;
  }
  return count;
}

// Dependencies passed to command-handler
const commandDeps: CommandHandlerDeps = {
  activeSessions,
  sessionReply,
  getActiveCount,
  lastRepoScan,
};

// Dependencies passed to card-handler
const cardDeps: CardHandlerDeps = {
  activeSessions,
  sessionReply,
  lastRepoScan,
};

// ─── Event handling ──────────────────────────────────────────────────────────

async function handleNewTopic(data: any, chatId: string, messageId: string, chatType: 'group' | 'p2p' = 'group'): Promise<void> {
  const { parsed, resources } = parseEventMessage(data);
  const content = parsed.content.trim();
  const senderOpenId: string | undefined = data.sender?.sender_id?.open_id;
  logger.info(`New topic: ${messageId} "${content.substring(0, 60)}" (resources: ${resources.length}, active: ${getActiveCount()})`);

  // Intercept daemon commands in new topics (no session needed for some commands)
  if (content.startsWith('/')) {
    const cmd = content.split(/\s+/)[0].toLowerCase();
    if (DAEMON_COMMANDS.has(cmd)) {
      const session = sessionStore.createSession(chatId, messageId, content.substring(0, 50), chatType);
      activeSessions.set(messageId, {
        session,
        worker: null,
        workerPort: null,
    workerToken: null,
        chatId,
        chatType,
        spawnedAt: Date.now(),
        claudeVersion: getCurrentClaudeVersion(),
        lastMessageAt: Date.now(),
        hasHistory: false,
        ownerOpenId: senderOpenId,
      });
      await handleCommand(cmd, messageId, parsed, commandDeps);
      return;
    }
  }

  // Download attachments
  const attachments = await downloadResources(messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }

  refreshClaudeVersion();

  // Create session in pending-repo state — don't spawn Claude yet
  const session = sessionStore.createSession(chatId, messageId, parsed.content.substring(0, 50), chatType);
  messageQueue.ensureQueue(messageId);
  messageQueue.appendMessage(messageId, parsed);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    chatId,
    chatType,
    spawnedAt: Date.now(),
    claudeVersion: getCurrentClaudeVersion(),
    lastMessageAt: Date.now(),
    hasHistory: false,
    pendingRepo: true,
    pendingPrompt: content,
    pendingAttachments: attachments.length > 0 ? attachments : undefined,
    ownerOpenId: senderOpenId,
    currentTurnTitle: content.substring(0, 50),
  };
  activeSessions.set(messageId, ds);

  // Show repo selection card
  const scanDir = getProjectScanDir(ds);
  let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
  if (existsSync(scanDir)) {
    projects = scanProjects(scanDir);
  }
  if (projects.length > 0) {
    lastRepoScan.set(chatId, projects);
    const currentCwd = getSessionWorkingDir(ds);
    const cardJson = buildRepoSelectCard(projects, currentCwd, messageId);
    await sessionReply(messageId, cardJson, 'interactive');
    logger.info(`[${tag(ds)}] Waiting for repo selection (${projects.length} projects)`);
  } else {
    // No projects found — skip repo selection, spawn directly
    ds.pendingRepo = false;
    const prompt = buildNewTopicPrompt(content, session.sessionId, attachments);
    forkWorker(ds, prompt);
    logger.info(`Session ${session.sessionId} ready (no projects to select), total active: ${getActiveCount()}`);
  }
}

async function handleThreadReply(data: any, rootId: string): Promise<void> {
  const { parsed, resources } = parseEventMessage(data);
  const content = parsed.content.trim();

  // Intercept daemon commands
  if (content.startsWith('/')) {
    const cmd = content.split(/\s+/)[0].toLowerCase();
    if (DAEMON_COMMANDS.has(cmd)) {
      handleCommand(cmd, rootId, parsed, commandDeps);
      return;
    }
  }

  logger.info(`Thread reply in ${rootId}: ${content.substring(0, 100)} (resources: ${resources.length})`);

  // Download attachments
  const attachments = await downloadResources(parsed.messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }

  // Update last message time
  const ds = activeSessions.get(rootId);
  if (ds) ds.lastMessageAt = Date.now();

  // If waiting for repo selection, remind user
  if (ds?.pendingRepo) {
    await sessionReply(rootId, '请先在上方卡片中选择仓库，再发送消息。');
    return;
  }

  // Route to file queue
  messageQueue.ensureQueue(rootId);
  messageQueue.appendMessage(rootId, parsed);

  if (!ds) {
    // No active session for this thread — auto-create with repo selection
    const chatId: string = data?.message?.chat_id ?? '';
    const chatType = (data?.message?.chat_type === 'p2p' ? 'p2p' : 'group') as 'group' | 'p2p';
    logger.info(`No active session for thread ${rootId}, auto-creating new session...`);
    refreshClaudeVersion();
    const session = sessionStore.createSession(chatId, rootId, parsed.content.substring(0, 50), chatType);
    const newDs: DaemonSession = {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      chatId,
      chatType,
      spawnedAt: Date.now(),
      claudeVersion: getCurrentClaudeVersion(),
      lastMessageAt: Date.now(),
      hasHistory: false,
      pendingRepo: true,
      pendingPrompt: parsed.content,
      pendingAttachments: attachments.length > 0 ? attachments : undefined,
      ownerOpenId: data.sender?.sender_id?.open_id,
      currentTurnTitle: parsed.content.substring(0, 50),
    };
    activeSessions.set(rootId, newDs);

    // Show repo selection card (same as handleNewTopic)
    const scanDir = getProjectScanDir(newDs);
    let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
    if (existsSync(scanDir)) {
      projects = scanProjects(scanDir);
    }
    if (projects.length > 0) {
      lastRepoScan.set(chatId, projects);
      const currentCwd = getSessionWorkingDir(newDs);
      const cardJson = buildRepoSelectCard(projects, currentCwd, rootId);
      await sessionReply(rootId, cardJson, 'interactive');
      logger.info(`[${tag(newDs)}] Waiting for repo selection (${projects.length} projects)`);
    } else {
      // No projects found — skip repo selection, spawn directly
      newDs.pendingRepo = false;
      const prompt = buildNewTopicPrompt(parsed.content, session.sessionId, attachments);
      forkWorker(newDs, prompt);
    }

    return;
  }

  // Send message to worker via IPC
  if (ds.worker && !ds.worker.killed) {
    const msgContent = attachments.length > 0
      ? `${parsed.content}${formatAttachmentsHint(attachments)}`
      : parsed.content;
    // Freeze the previous turn's card at "idle" before starting a new turn
    if (ds.streamCardId && ds.workerPort) {
      const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
      const prevTitle = ds.currentTurnTitle || ds.session.title || 'Claude Code';
      const frozenCard = buildStreamingCard(
        ds.session.sessionId, ds.session.rootMessageId, readUrl, prevTitle,
        ds.lastScreenContent ?? '', 'idle',
      );
      updateMessage(ds.streamCardId, frozenCard).catch(() => {});
    }
    // Mark new turn — next screen_update will create a fresh streaming card
    ds.streamCardPending = true;
    ds.currentTurnTitle = parsed.content.substring(0, 50);
    ds.worker.send({ type: 'message', content: msgContent } as DaemonToWorker);
  } else {
    // Worker not running — re-fork with resume
    logger.info(`[${tag(ds)}] Worker not running, re-forking...`);
    ds.currentTurnTitle = parsed.content.substring(0, 50);
    forkWorker(ds, parsed.content, ds.hasHistory);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function startDaemon(): Promise<void> {
  validateConfig();
  writePidFile();

  // Initialise worker pool with daemon callbacks
  initWorkerPool({
    sessionReply,
    getSessionWorkingDir,
    getActiveCount,
  });

  // Get initial CLI version
  refreshClaudeVersion();
  if (getCurrentClaudeVersion() === 'unknown') {
    logger.warn('Could not detect CLI version at startup');
  }

  // Resolve email prefixes in ALLOWED_USERS to open_ids
  if (config.daemon.allowedUsers.length > 0) {
    const hasEmails = config.daemon.allowedUsers.some(u => !u.startsWith('ou_'));
    if (hasEmails) {
      try {
        config.daemon.allowedUsers = await resolveAllowedUsers(config.daemon.allowedUsers);
        logger.info(`Resolved allowedUsers: ${config.daemon.allowedUsers.join(', ')}`);
      } catch (err: any) {
        logger.warn(`Failed to resolve allowedUsers: ${err.message}`);
      }
    }
  }

  // Probe bot open_id at startup (non-blocking)
  probeBotOpenId().catch(err => {
    logger.warn(`Bot open_id probe failed (will learn from events): ${err.message}`);
  });

  // Restore active sessions from previous run
  restoreActiveSessions(activeSessions);

  // Start scheduled task scheduler
  scheduler.setExecuteCallback((task) => executeScheduledTask(task, activeSessions, refreshClaudeVersion));
  scheduler.startScheduler();

  // Start Lark event dispatcher
  startLarkEventDispatcher({
    handleCardAction: (data) => handleCardAction(data, cardDeps),
    handleNewTopic,
    handleThreadReply,
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info(`Daemon shutting down... (active: ${getActiveCount()})`);
    scheduler.stopScheduler();
    for (const [, ds] of activeSessions) {
      if (ds.worker && !ds.worker.killed) {
        logger.info(`Shutting down worker for session ${ds.session.sessionId}`);
        killWorker(ds);
      }
    }
    removePidFile();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Daemon is running. Press Ctrl+C to stop.');
}
