import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, watch, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config } from './config.js';
import {
  replyMessage,
  resolveAllowedUsers,
  downloadMessageResource,
  listChatBotMembers,
  sendMessage as larkSendMessage,
  MessageWithdrawnError,
} from './im/lark/client.js';
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
import {
  buildRepoSelectCard,
  buildStreamingCard as larkBuildStreamingCard,
  buildSessionCard as larkBuildSessionCard,
} from './im/lark/card-builder.js';
import { getCliDisplayName } from './utils/cli-display.js';
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
  getAvailableBots,
  restoreActiveSessions,
  executeScheduledTask,
} from './core/session-manager.js';
import { handleCardAction } from './im/lark/card-handler.js';
import type { CardHandlerDeps } from './im/lark/card-handler.js';
import { probeBotOpenId, startLarkEventDispatcher, writeBotInfoFile } from './im/lark/event-dispatcher.js';
import { createImAdapter } from './im/registry.js';

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
async function sessionReply(rootId: string, content: string, msgType: string = 'text', imBotId?: string): Promise<string> {
  let ds: DaemonSession | undefined;
  if (imBotId) {
    ds = activeSessions.get(sessionKey(rootId, imBotId));
  } else {
    for (const s of activeSessions.values()) {
      if (s.session.rootMessageId === rootId) { ds = s; break; }
    }
  }
  const botId = imBotId ?? ds?.imBotId ?? getAllBots()[0]?.imBotId;
  if (!botId) throw new Error('No bot configured');

  // Route through adapter if available
  const adapter = getBot(botId).adapter;
  if (adapter) {
    const format = msgType === 'interactive' ? 'rich' as const : 'text' as const;
    return adapter.replyMessage(rootId, content, format);
  }
  // Fallback to direct Lark call (should not happen after full migration)
  const inThread = ds?.chatType === 'p2p';
  return replyMessage(botId, rootId, content, msgType, inThread);
}

// ─── PID file ────────────────────────────────────────────────────────────────

function getPidFile(): string {
  const botIndex = process.env.BOTMUX_BOT_INDEX;
  const name = botIndex !== undefined ? `daemon-${botIndex}.pid` : 'daemon.pid';
  return join(config.session.dataDir, name);
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


// Dependencies passed to command-handler
const commandDeps: CommandHandlerDeps = {
  activeSessions,
  sessionReply,
  getActiveCount,
  lastRepoScan,
  buildRepoSelectCard,
  deleteMessage: async (imBotId, messageId) => {
    const { deleteMessage: larkDelete } = await import('./im/lark/client.js');
    await larkDelete(imBotId, messageId);
  },
  listChatBots: listChatBotMembers,
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
  logger.info(`New topic: "${content.substring(0, 60)}" (resources: ${resources.length}, active: ${getActiveCount()}, messageId: ${messageId}, chatId: ${chatId}`);

  // Intercept daemon commands in new topics (no session needed for some commands)
  if (content.startsWith('/')) {
    const cmd = content.split(/\s+/)[0].toLowerCase();
    if (DAEMON_COMMANDS.has(cmd)) {
      const session = sessionStore.createSession(chatId, messageId, content.substring(0, 50), chatType);
      session.imBotId = larkAppId;
      sessionStore.updateSession(session);
      activeSessions.set(sessionKey(messageId, larkAppId), {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        imBotId: larkAppId,
        chatId,
        chatType,
        spawnedAt: Date.now(),
        cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
        lastMessageAt: Date.now(),
        hasHistory: false,
        ownerId: senderOpenId,
      });
      await handleCommand(cmd, messageId, parsed, commandDeps, larkAppId);
      return;
    }
  }

  // Download attachments
  const attachments = await downloadResources(larkAppId, messageId, resources, downloadMessageResource);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }

  refreshCliVersion(botCfg.cliId, botCfg.cliPathOverride);

  // Create session in pending-repo state — don't spawn CLI yet
  const session = sessionStore.createSession(chatId, messageId, parsed.content.substring(0, 50), chatType);
  session.imBotId = larkAppId;
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(messageId);
  messageQueue.appendMessage(messageId, parsed);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    imBotId: larkAppId,
    chatId,
    chatType,
    spawnedAt: Date.now(),
    cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
    lastMessageAt: Date.now(),
    hasHistory: false,
    pendingRepo: true,
    pendingPrompt: content,
    pendingAttachments: attachments.length > 0 ? attachments : undefined,
    pendingMentions: parsed.mentions?.map(m => ({ key: m.key, name: m.name, userId: m.openId })),
    ownerId: senderOpenId,
    currentTurnTitle: content.substring(0, 50),
  };
  activeSessions.set(sessionKey(messageId, larkAppId), ds);

  const adapterCapabilities = getBot(larkAppId).adapter?.capabilities;

  if (adapterCapabilities && !adapterCapabilities.cards) {
    // Non-card IM (e.g. WeChat): skip repo selection, auto-start with default workingDir
    ds.pendingRepo = false;
    const prompt = buildNewTopicPrompt(content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId, listChatBotMembers));
    forkWorker(ds, prompt);
    logger.info(`Session ${session.sessionId} ready (no-card IM, skipping repo selection), total active: ${getActiveCount()}`);
    return;
  }

  // Show repo selection card (card-capable IMs only)
  const scanDirs = getProjectScanDirs(ds).filter(d => existsSync(d));
  let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
  if (scanDirs.length > 0) {
    projects = scanMultipleProjects(scanDirs);
  }
  if (projects.length > 0) {
    lastRepoScan.set(chatId, projects);
    const currentCwd = getSessionWorkingDir(ds);
    const cardJson = buildRepoSelectCard(projects, currentCwd, messageId);
    ds.repoCardMessageId = await sessionReply(messageId, cardJson, 'interactive', larkAppId);
    logger.info(`[${tag(ds)}] Waiting for repo selection (${projects.length} projects)`);
  } else {
    // No projects found — skip repo selection, spawn directly
    ds.pendingRepo = false;
    const prompt = buildNewTopicPrompt(content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId, listChatBotMembers));
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
  // key (rootId::imBotId) already supports this. No need to kill the other bot.
  if (!ds) {
    const hasOtherBot = [...activeSessions.values()].some(
      s => s.session.rootMessageId === rootId && s.imBotId !== larkAppId
    );
    if (hasOtherBot) {
      logger.info(`[${larkAppId}] Joining thread ${rootId} alongside existing bot session(s)`);
    }
  }

  // Download attachments
  const effectiveAppId = ds?.imBotId ?? larkAppId;
  const attachments = await downloadResources(effectiveAppId, parsed.messageId, resources, downloadMessageResource);
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
    session.imBotId = larkAppId;
    sessionStore.updateSession(session);
    const newDs: DaemonSession = {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      imBotId: larkAppId,
      chatId,
      chatType,
      spawnedAt: Date.now(),
      cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
      lastMessageAt: Date.now(),
      hasHistory: false,
      pendingRepo: true,
      pendingPrompt: parsed.content,
      pendingAttachments: attachments.length > 0 ? attachments : undefined,
      pendingMentions: parsed.mentions?.map(m => ({ key: m.key, name: m.name, userId: m.openId })),
      ownerId: data.sender?.sender_id?.open_id,
      currentTurnTitle: parsed.content.substring(0, 50),
    };
    activeSessions.set(sessionKey(rootId, larkAppId), newDs);

    const newAdapterCapabilities = getBot(larkAppId).adapter?.capabilities;

    if (newAdapterCapabilities && !newAdapterCapabilities.cards) {
      // Non-card IM: skip repo selection, auto-start with default workingDir
      newDs.pendingRepo = false;
      const prompt = buildNewTopicPrompt(parsed.content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId, listChatBotMembers));
      forkWorker(newDs, prompt);
      logger.info(`[${tag(newDs)}] Auto-created session (no-card IM, skipping repo selection)`);
    } else {
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
        newDs.repoCardMessageId = await sessionReply(rootId, cardJson, 'interactive', larkAppId);
        logger.info(`[${tag(newDs)}] Waiting for repo selection (${projects.length} projects)`);
      } else {
        // No projects found — skip repo selection, spawn directly
        newDs.pendingRepo = false;
        const prompt = buildNewTopicPrompt(parsed.content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId, listChatBotMembers));
        forkWorker(newDs, prompt);
      }
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
      const dsBotCfg = getBot(ds.imBotId).config;
      const prevTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(dsBotCfg.cliId);
      const frozenCard = larkBuildStreamingCard(
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

// ─── Bot-to-bot mention routing ───────────────────────────────────────────────

interface BotMentionSignal {
  rootMessageId: string;
  chatId: string;
  chatType?: string;
  senderAppId: string;
  targetBotOpenId: string;
  content: string;
  messageId: string;
  timestamp: number;
}

function processBotMentionSignal(signal: BotMentionSignal): void {
  // Find the target bot by open_id
  const targetBot = getAllBots().find(b => b.botUserId === signal.targetBotOpenId);
  if (!targetBot) {
    logger.debug(`[bot-mention] No bot found for open_id ${signal.targetBotOpenId}`);
    return;
  }

  const targetAppId = targetBot.imBotId;
  const ds = activeSessions.get(sessionKey(signal.rootMessageId, targetAppId));

  if (ds && ds.worker && !ds.worker.killed) {
    // Target bot has an active session in this thread — send the message
    const senderBot = getAllBots().find(b => b.imBotId === signal.senderAppId);
    const senderName = senderBot?.botName ?? (senderBot ? getCliDisplayName(senderBot.config.cliId) : 'Bot');
    const enrichedContent = `[来自 ${senderName} 的 @mention]\n${signal.content}`;
    ds.lastMessageAt = Date.now();
    ds.streamCardPending = true;
    ds.currentTurnTitle = signal.content.substring(0, 50);
    ds.worker.send({ type: 'message', content: enrichedContent } as DaemonToWorker);
    logger.info(`[bot-mention] Routed message from ${signal.senderAppId} to ${targetAppId} in thread ${signal.rootMessageId}`);
  } else {
    logger.debug(`[bot-mention] Target bot ${targetAppId} has no active worker for thread ${signal.rootMessageId}`);
  }
}

function startBotMentionWatcher(): void {
  const signalDir = join(config.session.dataDir, 'bot-mentions');
  if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true });

  // Process any existing signal files (from before daemon started)
  try {
    for (const file of readdirSync(signalDir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(signalDir, file);
      try {
        const signal: BotMentionSignal = JSON.parse(readFileSync(filePath, 'utf-8'));
        unlinkSync(filePath);
        processBotMentionSignal(signal);
      } catch (err) {
        logger.debug(`[bot-mention] Failed to process signal ${file}: ${err}`);
        try { unlinkSync(join(signalDir, file)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // Watch for new signal files
  watch(signalDir, (event, filename) => {
    if (event !== 'rename' || !filename?.endsWith('.json')) return;
    const filePath = join(signalDir, filename);
    // Small delay to ensure the file is fully written
    setTimeout(() => {
      try {
        if (!existsSync(filePath)) return; // already processed or deleted
        const signal: BotMentionSignal = JSON.parse(readFileSync(filePath, 'utf-8'));
        unlinkSync(filePath);
        processBotMentionSignal(signal);
      } catch (err) {
        logger.debug(`[bot-mention] Failed to process signal ${filename}: ${err}`);
        try { unlinkSync(filePath); } catch { /* ignore */ }
      }
    }, 50);
  });

  logger.info(`[bot-mention] Watching for signals in ${signalDir}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function startDaemon(botIndex?: number): Promise<void> {
  // Load the assigned bot (one daemon per bot)
  const botConfigs = loadBotConfigs();
  const idx = botIndex ?? 0;
  if (idx < 0 || idx >= botConfigs.length) {
    throw new Error(`Invalid BOTMUX_BOT_INDEX=${idx}, only ${botConfigs.length} bot(s) configured`);
  }
  const cfg = botConfigs[idx];
  const botState = registerBot(cfg);
  // Create IM adapter — this registers Lark client for getBotClient() calls
  const adapter = createImAdapter(cfg);
  botState.adapter = adapter;
  sessionStore.init(botState.imBotId);
  logger.info(`Bot ${idx}/${botConfigs.length}: ${botState.imBotId} (cli: ${cfg.cliId})`)

  writePidFile();

  // Initialise worker pool with daemon callbacks
  initWorkerPool({
    sessionReply,
    getSessionWorkingDir,
    getActiveCount,
    closeSession(ds: DaemonSession) {
      sessionStore.closeSession(ds.session.sessionId);
      activeSessions.delete(sessionKey(ds.session.rootMessageId, ds.imBotId));
      logger.info(`[${ds.session.sessionId.substring(0, 8)}] Session auto-closed (message withdrawn)`);
    },
    updateMessage: async (imBotId, messageId, content) => {
      const adapter = getBot(imBotId).adapter;
      if (adapter && !adapter.capabilities.updateMessage) {
        // No-op for IMs that don't support message updates (e.g. WeChat)
        return;
      }
      const { updateMessage: larkUpdate } = await import('./im/lark/client.js');
      await larkUpdate(imBotId, messageId, content);
    },
    isMessageWithdrawn: (err) => err instanceof MessageWithdrawnError,
    buildStreamingCard: (sessionId, rootMessageId, terminalUrl, title, content, status, cliId, expanded, nonce) => {
      // Route card building through the session's adapter
      const ds = [...activeSessions.values()].find(s => s.session.sessionId === sessionId);
      const adapter = ds ? getBot(ds.imBotId).adapter : undefined;
      if (adapter && !adapter.capabilities.updateMessage) {
        // Non-updateMessage IM (WeChat): only send on idle (final result), suppress working/starting
        if (status !== 'idle') return '';
        const card = adapter.cards.buildStreamingCard({ sessionId, rootMessageId, terminalUrl, title, content, status });
        return typeof card.payload === 'string' ? card.payload : JSON.stringify(card.payload);
      }
      if (adapter) {
        const card = adapter.cards.buildStreamingCard({ sessionId, rootMessageId, terminalUrl, title, content, status });
        return typeof card.payload === 'string' ? card.payload : JSON.stringify(card.payload);
      }
      return larkBuildStreamingCard(sessionId, rootMessageId, terminalUrl, title, content, status, cliId, expanded, nonce);
    },
    buildSessionCard: (sessionId, rootMessageId, terminalUrl, title, cliId, showManageButtons) => {
      const ds = [...activeSessions.values()].find(s => s.session.sessionId === sessionId);
      const adapter = ds ? getBot(ds.imBotId).adapter : undefined;
      if (adapter) {
        const card = adapter.cards.buildSessionCard({ sessionId, rootMessageId, terminalUrl, title });
        return typeof card.payload === 'string' ? card.payload : JSON.stringify(card.payload);
      }
      return larkBuildSessionCard(sessionId, rootMessageId, terminalUrl, title, cliId, showManageButtons);
    },
  });

  // Per-bot initialization
  for (const bot of getAllBots()) {
    const cfg = bot.config;

    // Refresh CLI version per bot's cliId
    refreshCliVersion(cfg.cliId, cfg.cliPathOverride);

    // Resolve allowed users per bot (Lark-specific: email → open_id resolution)
    if (bot.resolvedAllowedUsers.length > 0 && cfg.im === 'lark') {
      const hasEmails = bot.resolvedAllowedUsers.some(u => u.includes('@'));
      if (hasEmails) {
        try {
          bot.resolvedAllowedUsers = await resolveAllowedUsers(cfg.larkAppId, bot.resolvedAllowedUsers);
          logger.info(`[${bot.imBotId}] Resolved allowedUsers: ${bot.resolvedAllowedUsers.join(', ')}`);
        } catch (err: any) {
          logger.warn(`[${bot.imBotId}] Failed to resolve allowedUsers: ${err.message}`);
        }
      }
    }

    // Lark-specific initialization
    if (cfg.im === 'lark') {
      // Probe bot open_id and persist to bots-info.json
      probeBotOpenId(cfg.larkAppId).then(() => {
        writeBotInfoFile(config.session.dataDir);
      }).catch(err => {
        logger.warn(`[${bot.imBotId}] Bot open_id probe failed: ${err.message}`);
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
            if (s.session.rootMessageId === rootId && s.imBotId !== appId) return false;
          }
          return true;
        },
      });
    } else {
      // Non-Lark IM (e.g. WeChat): start adapter with ImEventHandler
      const imBotId = bot.imBotId;
      const imHandler: import('./im/types.js').ImEventHandler = {
        async onNewTopic(msg, chatId, chatType) {
          // WeChat messages arrive as ImMessage; wrap into the Lark-style handler path
          // by constructing a synthetic "parsed" + calling the same session creation logic.
          const content = msg.content.trim();
          const botCfg = getBot(imBotId).config;

          refreshCliVersion(botCfg.cliId, botCfg.cliPathOverride);

          // Use senderId as rootMessageId (WeChat has no thread, one session per user)
          const rootId = `wx-${msg.senderId}`;
          const session = sessionStore.createSession(chatId, rootId, content.substring(0, 50), chatType);
          session.imBotId = imBotId;
          // Persist WeChat context for MCP tools (runs in separate process without poller)
          const wxPoller = (adapter as import('./im/weixin/adapter.js').WeixinImAdapter).getPoller?.();
          session.weixinUserId = msg.senderId;
          session.weixinContextToken = wxPoller?.getContextToken(msg.senderId) ?? '';
          sessionStore.updateSession(session);
          messageQueue.ensureQueue(rootId);

          const parsed = { messageId: msg.id, rootId, senderId: msg.senderId, senderType: msg.senderType, msgType: msg.msgType, content, createTime: msg.createTime };
          messageQueue.appendMessage(rootId, parsed);

          const ds: DaemonSession = {
            session,
            worker: null,
            workerPort: null,
            workerToken: null,
            imBotId,
            chatId,
            chatType,
            spawnedAt: Date.now(),
            cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
            lastMessageAt: Date.now(),
            hasHistory: false,
            pendingRepo: false,
            pendingPrompt: content,
            ownerId: msg.senderId,
            currentTurnTitle: content.substring(0, 50),
          };
          activeSessions.set(sessionKey(rootId, imBotId), ds);

          const prompt = buildNewTopicPrompt(content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride);
          forkWorker(ds, prompt);

          // Register session in adapter's poller so replies route correctly
          const wxAdapter = adapter as import('./im/weixin/adapter.js').WeixinImAdapter;
          wxAdapter.getPoller()?.registerSession(msg.senderId, sessionKey(rootId, imBotId));

          logger.info(`[weixin] New session ${session.sessionId.substring(0, 8)} for user ${msg.senderId.substring(0, 16)}`);
        },

        async onThreadReply(msg, threadId) {
          const sk = threadId;
          const ds = activeSessions.get(sk);
          if (!ds) {
            logger.warn(`[weixin] Reply to unknown session: ${sk}`);
            return;
          }
          ds.lastMessageAt = Date.now();
          // Update persisted contextToken so MCP tools can use it
          const wxPoll = (adapter as import('./im/weixin/adapter.js').WeixinImAdapter).getPoller?.();
          const latestCt = wxPoll?.getContextToken(msg.senderId);
          if (latestCt) {
            ds.session.weixinContextToken = latestCt;
            sessionStore.updateSession(ds.session);
          }
          const content = msg.content.trim();
          if (!content) return;

          // Intercept daemon commands
          if (content.startsWith('/')) {
            const cmd = content.split(/\s+/)[0].toLowerCase();
            if (DAEMON_COMMANDS.has(cmd)) {
              const parsed = { messageId: msg.id, rootId: ds.session.rootMessageId, senderId: msg.senderId, senderType: msg.senderType, msgType: msg.msgType, content, createTime: msg.createTime };
              await handleCommand(cmd, ds.session.rootMessageId, parsed, commandDeps, imBotId);
              return;
            }
          }

          // Forward to CLI via message queue
          const parsed = { messageId: msg.id, rootId: ds.session.rootMessageId, senderId: msg.senderId, senderType: msg.senderType, msgType: msg.msgType, content, createTime: msg.createTime };
          messageQueue.appendMessage(ds.session.rootMessageId, parsed);

          // If worker exited, auto-restart
          if (!ds.worker || ds.worker.killed) {
            const botCfg = getBot(imBotId).config;
            refreshCliVersion(botCfg.cliId, botCfg.cliPathOverride);
            ds.streamCardPending = true;
            ds.currentTurnTitle = content.substring(0, 50);
            forkWorker(ds, content, true);
          }
        },

        async onCardAction(_action) {
          // WeChat has no card actions — no-op
        },
      };

      adapter.start(imHandler).catch(err => {
        logger.error(`[${bot.imBotId}] Adapter start failed: ${err.message}`);
      });
    }
  }

  // Restore active sessions from previous run
  restoreActiveSessions(activeSessions);

  // Start scheduled task scheduler (only on bot 0 to avoid duplicates)
  if (idx === 0) {
    scheduler.setExecuteCallback((task) => executeScheduledTask(task, activeSessions, refreshCliVersion, larkSendMessage));
    scheduler.startScheduler();
  }

  // Watch for bot-to-bot mention signals from MCP send_to_thread tool.
  // Lark WSClient does not deliver events for bot-sent messages, so the MCP
  // tool writes signal files that the daemon picks up and routes internally.
  startBotMentionWatcher();

  // Graceful shutdown
  const shutdown = () => {
    logger.info(`Daemon shutting down... (active: ${getActiveCount()})`);
    scheduler.stopScheduler();
    for (const [, ds] of activeSessions) {
      if (ds.worker && !ds.worker.killed) {
        logger.info(`Shutting down worker for session ${ds.session.sessionId}`);
        const backendType = ds.imBotId
          ? (getBot(ds.imBotId).config.backendType ?? config.daemon.backendType)
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
