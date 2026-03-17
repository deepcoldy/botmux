import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config } from './config.js';
import { replyMessage, resolveAllowedUsers } from './im/lark/client.js';
import { loadBotConfigs, registerBot, getBot, getAllBots } from './bot-registry.js';
import * as sessionStore from './services/session-store.js';
import * as messageQueue from './services/message-queue.js';
import { parseEventMessage } from './im/lark/message-parser.js';
import { logger } from './utils/logger.js';
import type { DaemonToWorker } from './types.js';
export type { DaemonSession } from './core/types.js';
import type { DaemonSession } from './core/types.js';
import { sessionKey } from './core/types.js';
import type { CliId } from './adapters/cli/types.js';
import * as scheduler from './core/scheduler.js';
import { scanProjects, scanMultipleProjects } from './services/project-scanner.js';
import { buildRepoSelectCard, buildStreamingCard, getCliDisplayName } from './im/lark/card-builder.js';
import { createCliAdapterSync } from './adapters/cli/registry.js';
import {
  initWorkerPool,
  forkWorker,
  killWorker,
  scheduleCardPatch,
  setCurrentCliVersion,
  getCurrentCliVersion,
} from './core/worker-pool.js';
import { DAEMON_COMMANDS, handleCommand } from './core/command-handler.js';
import type { CommandHandlerDeps } from './core/command-handler.js';
import {
  getSessionWorkingDir,
  getProjectScanDir,
  getProjectScanDirs,
  downloadResources,
  formatAttachmentsHint,
  buildNewTopicPrompt,
  restoreActiveSessions,
  executeScheduledTask,
} from './core/session-manager.js';
import { handleCardAction } from './im/lark/card-handler.js';
import type { CardHandlerDeps } from './im/lark/card-handler.js';
import { probeBotOpenId, startLarkEventDispatcher, writeBotInfoFile } from './im/lark/event-dispatcher.js';

// ─── State ───────────────────────────────────────────────────────────────────

const activeSessions = new Map<string, DaemonSession>();
// Cache last /repo scan results per chat for /repo <number> fallback
const lastRepoScan = new Map<string, import('./services/project-scanner.js').ProjectInfo[]>();
const cliVersionCache = new Map<string, { version: string; lastCheckAt: number }>();
const VERSION_CHECK_INTERVAL = 60_000; // cache 1 min

/**
 * Reply to a message, automatically using reply_in_thread for p2p sessions.
 * In p2p chats, Lark needs reply_in_thread=true to create/continue a thread.
 */
async function sessionReply(rootId: string, content: string, msgType: string = 'text', larkAppId?: string): Promise<string> {
  let ds: DaemonSession | undefined;
  if (larkAppId) {
    ds = activeSessions.get(sessionKey(rootId, larkAppId));
  } else {
    for (const s of activeSessions.values()) {
      if (s.session.rootMessageId === rootId) { ds = s; break; }
    }
  }
  const appId = larkAppId ?? ds?.larkAppId ?? getAllBots()[0]?.config.larkAppId;
  if (!appId) throw new Error('No bot configured');
  const inThread = ds?.chatType === 'p2p';
  return replyMessage(appId, rootId, content, msgType, inThread);
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
  // Write breadcrumb so CLI tools (botmux list/delete) can find the active data dir
  const breadcrumb = join(homedir(), '.botmux', '.data-dir');
  try {
    mkdirSync(join(homedir(), '.botmux'), { recursive: true });
    writeFileSync(breadcrumb, config.session.dataDir, 'utf-8');
  } catch { /* best effort */ }
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

function refreshCliVersion(cliId: CliId, cliPathOverride?: string): boolean {
  const now = Date.now();
  const cached = cliVersionCache.get(cliId);
  if (cached && now - cached.lastCheckAt < VERSION_CHECK_INTERVAL) return false;

  try {
    const adapter = createCliAdapterSync(cliId, cliPathOverride);
    const raw = execFileSync(adapter.resolvedBin, ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    const newVersion = raw.replace(/^[^0-9]*/, '');

    if (newVersion === 'unknown' || !newVersion) return false;

    const oldVersion = cached?.version;
    cliVersionCache.set(cliId, { version: newVersion, lastCheckAt: now });
    // Also update the shared version (used by forkWorker for ds.cliVersion)
    setCurrentCliVersion(newVersion);

    if (oldVersion && oldVersion !== newVersion) {
      logger.info(`CLI version updated: ${oldVersion} → ${newVersion} (${adapter.id})`);
      return true;
    }

    logger.info(`CLI version: ${newVersion} (${adapter.id})`);
    return false;
  } catch (err: any) {
    logger.warn(`Failed to get CLI version for ${cliId}: ${err.message}`);
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

/** Get available bots for prompt injection (excludes current bot). */
function getAvailableBots(currentAppId: string): Array<{ name: string; openId: string; cliId: string }> {
  return getAllBots()
    .filter(b => b.botOpenId && b.config.larkAppId !== currentAppId)
    .map(b => ({
      name: getCliDisplayName(b.config.cliId),
      openId: b.botOpenId!,
      cliId: b.config.cliId,
    }));
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

async function handleNewTopic(data: any, chatId: string, messageId: string, chatType: 'group' | 'p2p' = 'group', larkAppId: string): Promise<void> {
  const { parsed, resources } = parseEventMessage(data);
  const content = parsed.content.trim();
  const senderOpenId: string | undefined = data.sender?.sender_id?.open_id;
  const botCfg = getBot(larkAppId).config;
  logger.info(`New topic: ${messageId} "${content.substring(0, 60)}" (resources: ${resources.length}, active: ${getActiveCount()})`);

  // Intercept daemon commands in new topics (no session needed for some commands)
  if (content.startsWith('/')) {
    const cmd = content.split(/\s+/)[0].toLowerCase();
    if (DAEMON_COMMANDS.has(cmd)) {
      const session = sessionStore.createSession(chatId, messageId, content.substring(0, 50), chatType);
      session.larkAppId = larkAppId;
      sessionStore.updateSession(session);
      activeSessions.set(sessionKey(messageId, larkAppId), {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        larkAppId,
        chatId,
        chatType,
        spawnedAt: Date.now(),
        cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
        lastMessageAt: Date.now(),
        hasHistory: false,
        ownerOpenId: senderOpenId,
      });
      await handleCommand(cmd, messageId, parsed, commandDeps, larkAppId);
      return;
    }
  }

  // Download attachments
  const attachments = await downloadResources(larkAppId, messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }

  refreshCliVersion(botCfg.cliId, botCfg.cliPathOverride);

  // Create session in pending-repo state — don't spawn CLI yet
  const session = sessionStore.createSession(chatId, messageId, parsed.content.substring(0, 50), chatType);
  session.larkAppId = larkAppId;
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(messageId);
  messageQueue.appendMessage(messageId, parsed);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId,
    chatType,
    spawnedAt: Date.now(),
    cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
    lastMessageAt: Date.now(),
    hasHistory: false,
    pendingRepo: true,
    pendingPrompt: content,
    pendingAttachments: attachments.length > 0 ? attachments : undefined,
    ownerOpenId: senderOpenId,
    currentTurnTitle: content.substring(0, 50),
  };
  activeSessions.set(sessionKey(messageId, larkAppId), ds);

  // Show repo selection card
  const scanDirs = getProjectScanDirs(ds).filter(d => existsSync(d));
  let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
  if (scanDirs.length > 0) {
    projects = scanMultipleProjects(scanDirs);
  }
  if (projects.length > 0) {
    lastRepoScan.set(chatId, projects);
    const currentCwd = getSessionWorkingDir(ds);
    const cardJson = buildRepoSelectCard(projects, currentCwd, messageId);
    await sessionReply(messageId, cardJson, 'interactive', larkAppId);
    logger.info(`[${tag(ds)}] Waiting for repo selection (${projects.length} projects)`);
  } else {
    // No projects found — skip repo selection, spawn directly
    ds.pendingRepo = false;
    const prompt = buildNewTopicPrompt(content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, getAvailableBots(larkAppId));
    forkWorker(ds, prompt);
    logger.info(`Session ${session.sessionId} ready (no projects to select), total active: ${getActiveCount()}`);
  }
}

async function handleThreadReply(data: any, rootId: string, larkAppId: string): Promise<void> {
  const { parsed, resources } = parseEventMessage(data);
  const content = parsed.content.trim();

  // Intercept daemon commands
  if (content.startsWith('/')) {
    const cmd = content.split(/\s+/)[0].toLowerCase();
    if (DAEMON_COMMANDS.has(cmd)) {
      handleCommand(cmd, rootId, parsed, commandDeps, larkAppId);
      return;
    }
  }

  logger.info(`Thread reply in ${rootId}: ${content.substring(0, 100)} (resources: ${resources.length})`);

  let ds = activeSessions.get(sessionKey(rootId, larkAppId));

  // If this bot doesn't have a session but another bot does, allow coexistence.
  // Multiple bots can have independent sessions in the same thread — the session
  // key (rootId::larkAppId) already supports this. No need to kill the other bot.
  if (!ds) {
    const hasOtherBot = [...activeSessions.values()].some(
      s => s.session.rootMessageId === rootId && s.larkAppId !== larkAppId
    );
    if (hasOtherBot) {
      logger.info(`[${larkAppId}] Joining thread ${rootId} alongside existing bot session(s)`);
    }
  }

  // Download attachments
  const effectiveAppId = ds?.larkAppId ?? larkAppId;
  const attachments = await downloadResources(effectiveAppId, parsed.messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }

  // Update last message time
  if (ds) ds.lastMessageAt = Date.now();

  // If waiting for repo selection, remind user
  if (ds?.pendingRepo) {
    await sessionReply(rootId, '请先在上方卡片中选择仓库，再发送消息。', 'text', larkAppId);
    return;
  }

  // Route to file queue
  messageQueue.ensureQueue(rootId);
  messageQueue.appendMessage(rootId, parsed);

  if (!ds) {
    // No active session for this thread — auto-create with repo selection
    if (activeSessions.has(sessionKey(rootId, larkAppId))) {
      logger.info(`[${larkAppId}] Session already exists for thread ${rootId}, skipping auto-create`);
      return;
    }

    const chatId: string = data?.message?.chat_id ?? '';
    const chatType = (data?.message?.chat_type === 'p2p' ? 'p2p' : 'group') as 'group' | 'p2p';
    const botCfg = getBot(larkAppId).config;
    logger.info(`No active session for thread ${rootId}, auto-creating new session...`);
    refreshCliVersion(botCfg.cliId, botCfg.cliPathOverride);
    const session = sessionStore.createSession(chatId, rootId, parsed.content.substring(0, 50), chatType);
    session.larkAppId = larkAppId;
    sessionStore.updateSession(session);
    const newDs: DaemonSession = {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId,
      chatId,
      chatType,
      spawnedAt: Date.now(),
      cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
      lastMessageAt: Date.now(),
      hasHistory: false,
      pendingRepo: true,
      pendingPrompt: parsed.content,
      pendingAttachments: attachments.length > 0 ? attachments : undefined,
      ownerOpenId: data.sender?.sender_id?.open_id,
      currentTurnTitle: parsed.content.substring(0, 50),
    };
    activeSessions.set(sessionKey(rootId, larkAppId), newDs);

    // Show repo selection card (same as handleNewTopic)
    const scanDirs2 = getProjectScanDirs(newDs).filter(d => existsSync(d));
    let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
    if (scanDirs2.length > 0) {
      projects = scanMultipleProjects(scanDirs2);
    }
    if (projects.length > 0) {
      lastRepoScan.set(chatId, projects);
      const currentCwd = getSessionWorkingDir(newDs);
      const cardJson = buildRepoSelectCard(projects, currentCwd, rootId);
      await sessionReply(rootId, cardJson, 'interactive', larkAppId);
      logger.info(`[${tag(newDs)}] Waiting for repo selection (${projects.length} projects)`);
    } else {
      // No projects found — skip repo selection, spawn directly
      newDs.pendingRepo = false;
      const prompt = buildNewTopicPrompt(parsed.content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, getAvailableBots(larkAppId));
      forkWorker(newDs, prompt);
    }

    return;
  }

  // Send message to worker via IPC
  if (ds.worker && !ds.worker.killed) {
    // Enrich content with attachment hints and mention metadata for the CLI
    let msgContent = attachments.length > 0
      ? `${parsed.content}${formatAttachmentsHint(attachments)}`
      : parsed.content;

    if (parsed.mentions && parsed.mentions.length > 0) {
      const mentionLines = parsed.mentions.map(m => {
        const idPart = m.openId ? ` → open_id: ${m.openId}` : '';
        return `- @${m.name}${idPart}`;
      });
      msgContent += `\n\n消息中的 @mention：\n${mentionLines.join('\n')}`;
    }
    // Freeze the previous turn's card at "idle" before starting a new turn
    if (ds.streamCardId && ds.workerPort) {
      const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
      const dsBotCfg = getBot(ds.larkAppId).config;
      const prevTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(dsBotCfg.cliId);
      const frozenCard = buildStreamingCard(
        ds.session.sessionId, ds.session.rootMessageId, readUrl, prevTitle,
        ds.lastScreenContent ?? '', 'idle', dsBotCfg.cliId, ds.streamExpanded, ds.streamCardNonce,
      );
      // Freeze through the serialization queue to avoid racing with an in-flight PATCH.
      // scheduleCardPatch replaces any stale pending item (latest-wins).
      scheduleCardPatch(ds, frozenCard);
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
  // Load and register all bots
  const botConfigs = loadBotConfigs();
  for (const cfg of botConfigs) {
    registerBot(cfg);
  }

  writePidFile();

  // Initialise worker pool with daemon callbacks
  initWorkerPool({
    sessionReply,
    getSessionWorkingDir,
    getActiveCount,
    closeSession(ds: DaemonSession) {
      sessionStore.closeSession(ds.session.sessionId);
      activeSessions.delete(sessionKey(ds.session.rootMessageId, ds.larkAppId));
      logger.info(`[${ds.session.sessionId.substring(0, 8)}] Session auto-closed (message withdrawn)`);
    },
  });

  // Per-bot initialization
  for (const bot of getAllBots()) {
    const cfg = bot.config;

    // Refresh CLI version per bot's cliId
    refreshCliVersion(cfg.cliId, cfg.cliPathOverride);

    // Resolve allowed users per bot
    if (bot.resolvedAllowedUsers.length > 0) {
      const hasEmails = bot.resolvedAllowedUsers.some(u => u.includes('@'));
      if (hasEmails) {
        try {
          bot.resolvedAllowedUsers = await resolveAllowedUsers(cfg.larkAppId, bot.resolvedAllowedUsers);
          logger.info(`[${cfg.larkAppId}] Resolved allowedUsers: ${bot.resolvedAllowedUsers.join(', ')}`);
        } catch (err: any) {
          logger.warn(`[${cfg.larkAppId}] Failed to resolve allowedUsers: ${err.message}`);
        }
      }
    }

    // Probe bot open_id and persist to bots-info.json
    probeBotOpenId(cfg.larkAppId).then(() => {
      writeBotInfoFile(config.session.dataDir);
    }).catch(err => {
      logger.warn(`[${cfg.larkAppId}] Bot open_id probe failed: ${err.message}`);
    });

    // Start event dispatcher for this bot
    startLarkEventDispatcher(cfg.larkAppId, cfg.larkAppSecret, {
      handleCardAction: (data, appId) => handleCardAction(data, cardDeps, appId),
      handleNewTopic: (data, chatId, messageId, chatType, appId) =>
        handleNewTopic(data, chatId, messageId, chatType, appId),
      handleThreadReply: (data, rootId, appId) =>
        handleThreadReply(data, rootId, appId),
      isSessionOwner: (rootId, appId) => {
        if (!activeSessions.has(sessionKey(rootId, appId))) return false;
        // Only grant shortcut if no other bot also has a session for this rootId
        for (const s of activeSessions.values()) {
          if (s.session.rootMessageId === rootId && s.larkAppId !== appId) return false;
        }
        return true;
      },
    }, config.session.dataDir);
  }

  // Restore active sessions from previous run
  restoreActiveSessions(activeSessions);

  // Start scheduled task scheduler
  scheduler.setExecuteCallback((task) => executeScheduledTask(task, activeSessions, refreshCliVersion));
  scheduler.startScheduler();

  // Graceful shutdown
  const shutdown = () => {
    logger.info(`Daemon shutting down... (active: ${getActiveCount()})`);
    scheduler.stopScheduler();
    for (const [, ds] of activeSessions) {
      if (ds.worker && !ds.worker.killed) {
        logger.info(`Shutting down worker for session ${ds.session.sessionId}`);
        const backendType = ds.larkAppId
          ? (getBot(ds.larkAppId).config.backendType ?? config.daemon.backendType)
          : config.daemon.backendType;
        if (backendType === 'tmux') {
          // Tmux mode: just kill the worker process — tmux session survives for re-attach.
          // Worker's SIGTERM handler calls backend.kill() which only detaches.
          try { ds.worker.kill('SIGTERM'); } catch { /* ignore */ }
          ds.worker = null;
          ds.workerPort = null;
          ds.workerToken = null;
        } else {
          killWorker(ds);
        }
      }
    }
    removePidFile();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Daemon is running. Press Ctrl+C to stop.');
}
