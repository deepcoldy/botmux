import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, watch, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { config } from './config.js';
import { replyMessage, resolveAllowedUsers, getMessageDetail } from './im/lark/client.js';
import { loadBotConfigs, registerBot, getBot, getAllBots, findOncallChat } from './bot-registry.js';
import * as sessionStore from './services/session-store.js';
import * as messageQueue from './services/message-queue.js';
import { parseEventMessage, parseApiMessage, extractResources, resolveNonsupportMessage, createImgNumberer, unwrapUserDslContent, stripLeadingMentions, type MessageResource } from './im/lark/message-parser.js';
import { logger } from './utils/logger.js';
import { ensureCjkFontsInstalled } from './utils/font-installer.js';
import type { DaemonToWorker, LarkMessage } from './types.js';
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
  CARD_POSTING_SENTINEL,
} from './core/worker-pool.js';
import { saveFrozenCards, deleteFrozenCards } from './services/frozen-card-store.js';
import { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS, handleCommand } from './core/command-handler.js';
import type { CommandHandlerDeps } from './core/command-handler.js';
import { isCallbackUrl, handleCallbackUrl } from './utils/user-token.js';
import {
  getSessionWorkingDir,
  getProjectScanDir,
  getProjectScanDirs,
  downloadResources,
  formatAttachmentsHint,
  buildNewTopicPrompt,
  buildFollowUpContent,
  getAvailableBots,
  restoreActiveSessions,
  executeScheduledTask,
  persistStreamCardState,
} from './core/session-manager.js';
import { handleCardAction } from './im/lark/card-handler.js';
import type { CardHandlerDeps } from './im/lark/card-handler.js';
import { isBotMentioned, probeBotOpenId, startLarkEventDispatcher, writeBotInfoFile, canOperate } from './im/lark/event-dispatcher.js';

// ─── State ───────────────────────────────────────────────────────────────────

const activeSessions = new Map<string, DaemonSession>();
// Cache last /repo scan results per chat for /repo <number> fallback
const lastRepoScan = new Map<string, import('./services/project-scanner.js').ProjectInfo[]>();
const cliVersionCache = new Map<string, { version: string; lastCheckAt: number }>();
const VERSION_CHECK_INTERVAL = 60_000; // cache 1 min

/**
 * Reply to a message, automatically using reply_in_thread for p2p sessions.
 * Always reply in thread to create/continue a topic.
 * This ensures topic-style replies in all chat types (p2p, group, topic group).
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
  return replyMessage(appId, rootId, content, msgType, true);
}

// ─── PID file ────────────────────────────────────────────────────────────────

function getPidFile(): string {
  const botIndex = process.env.BOTMUX_BOT_INDEX;
  const name = botIndex !== undefined ? `daemon-${botIndex}.pid` : 'daemon.pid';
  return join(config.session.dataDir, name);
}

/** Path to the wrapper bin directory — injected into worker PATH so CLIs
 *  can call `botmux send` / `botmux schedule` without a global npm install. */
const BOTMUX_BIN_DIR = join(homedir(), '.botmux', 'bin');

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

  // Write a thin wrapper script so `botmux` is always in PATH for CLI sessions,
  // regardless of whether the package was installed globally.  The wrapper
  // points at THIS daemon's dist/cli.js, so it's always the same version.
  try {
    mkdirSync(BOTMUX_BIN_DIR, { recursive: true });
    const cliScript = join(__dirname, 'cli.js');  // dist/cli.js
    const wrapper = join(BOTMUX_BIN_DIR, 'botmux');
    const content = `#!/bin/sh\nexec node "${cliScript}" "$@"\n`;
    // Only write if changed (avoid unnecessary disk writes on every restart)
    let existing = '';
    try { existing = readFileSync(wrapper, 'utf-8'); } catch { /* doesn't exist yet */ }
    if (existing !== content) {
      writeFileSync(wrapper, content, { mode: 0o755 });
      logger.info(`Wrapper script written: ${wrapper} → ${cliScript}`);
    }
  } catch (err: any) {
    logger.warn(`Failed to write botmux wrapper script: ${err.message}`);
  }

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
};

// Dependencies passed to card-handler
const cardDeps: CardHandlerDeps = {
  activeSessions,
  sessionReply,
  lastRepoScan,
};

// ─── Merge-forward expansion ────────────────────────────────────────────────

/**
 * Expand a merge_forward message by fetching sub-messages via Lark API.
 * Replaces parsed.content with readable text and collects additional resources.
 */
async function expandMergeForward(
  larkAppId: string, messageId: string, parsed: LarkMessage,
  depth: number = 0,
  numberer = createImgNumberer(),
): Promise<{ extraResources: MessageResource[] }> {
  const MAX_DEPTH = 5;
  const extraResources: MessageResource[] = [];
  try {
    // Lark returns HTTP 500 if user_card_content is combined with a
    // merge_forward message_id, so explicitly disable it here. Interactive
    // sub-messages come back in the simplified "Format A" shape which our
    // card extractor already handles.
    const detail = await getMessageDetail(larkAppId, messageId, { userCardContent: false });
    const subMessages = (detail?.items ?? []).filter((m: any) => m.upper_message_id === messageId);
    if (subMessages.length === 0) return { extraResources };

    const parts: string[] = ['[转发消息]'];
    for (const msg of subMessages) {
      const senderLabel = msg.sender?.sender_type === 'app' ? '机器人' : (msg.sender?.id ?? '未知');
      parts.push(`--- ${senderLabel} ---`);

      // Interactive sub-messages may still carry the simplified "upgrade your
      // client" fallback; unwrap user_dsl before any extraction so both the
      // resource pass and text pass see the real v2 body.
      // Interactive sub-messages arrive via REST as a simplified fallback.
      // Lark's im.message.get never returns user_dsl (even for the bot's own
      // messages, even via direct id lookup), so we can only unwrap when a
      // user_dsl somehow got through. For third-party cards whose simplified
      // form is the "请升级至最新版本客户端" fallback, the real body is
      // unrecoverable from REST.
      if (msg.msg_type === 'interactive') {
        const unwrapped = unwrapUserDslContent(msg.body?.content ?? '');
        if (unwrapped !== null) {
          msg.body = { ...(msg.body ?? {}), content: unwrapped };
        }
      }

      // Resources first so the numberer assigns [图片 N] in attachment order;
      // text extraction below reuses those numbers. Do NOT override messageId —
      // Lark requires the parent merge_forward's message_id to download
      // resources (error 234003 if sub-message ID is used).
      const subResources = extractResources(msg.msg_type ?? 'text', msg.body?.content ?? '', numberer);
      extraResources.push(...subResources);

      // Recursively expand nested merge_forward
      if (msg.msg_type === 'merge_forward' && depth < MAX_DEPTH) {
        const nested: LarkMessage = { content: '[合并转发消息]', msgType: 'merge_forward', messageId: msg.message_id, rootId: '', senderId: msg.sender?.id ?? '', senderType: msg.sender?.sender_type ?? '', createTime: msg.create_time ?? '', mentions: [] };
        const { extraResources: nestedResources } = await expandMergeForward(larkAppId, msg.message_id, nested, depth + 1, numberer);
        parts.push(nested.content);
        extraResources.push(...nestedResources);
      } else {
        const sub = parseApiMessage(msg, numberer);
        parts.push(sub.content);
      }
    }
    parsed.content = parts.join('\n');
    parsed.msgType = 'merge_forward_expanded';
  } catch (err) {
    logger.warn(`Failed to expand merge_forward ${messageId}: ${err}`);
    // Keep original placeholder content
  }
  return { extraResources };
}

// ─── Event handling ──────────────────────────────────────────────────────────

async function handleNewTopic(data: any, chatId: string, messageId: string, chatType: 'group' | 'p2p' = 'group', larkAppId: string): Promise<void> {
  await resolveNonsupportMessage(data, larkAppId);
  const { parsed, resources } = parseEventMessage(data);

  // Expand merge_forward: fetch sub-messages and collect their resources
  if (parsed.msgType === 'merge_forward') {
    const { extraResources } = await expandMergeForward(larkAppId, messageId, parsed);
    resources.push(...extraResources);
  }

  const content = parsed.content.trim();
  // Strip leading @<bot> mentions so "@bot /oncall bind" is recognized as a command.
  const cmdContent = stripLeadingMentions(content, parsed.mentions);
  const senderOpenId: string | undefined = data.sender?.sender_id?.open_id;
  const botCfg = getBot(larkAppId).config;
  logger.info(`New topic: "${content.substring(0, 60)}" (resources: ${resources.length}, active: ${getActiveCount()}, messageId: ${messageId}, chatId: ${chatId}`);

  // Intercept daemon commands in new topics (no session needed for some commands)
  if (cmdContent.startsWith('/')) {
    const cmd = cmdContent.split(/\s+/)[0].toLowerCase();
    if (PASSTHROUGH_COMMANDS.has(cmd)) {
      await sessionReply(messageId, `${cmd} 需要在已有会话内使用（先发一条普通消息启动 CLI）。`, 'text', larkAppId);
      return;
    }
    if (DAEMON_COMMANDS.has(cmd)) {
      // Oncall groups: any member can talk, but daemon commands (except /oncall
      // itself which gates bind/unbind inside) are owner-only.
      if (cmd !== '/oncall' && findOncallChat(larkAppId, chatId) && !canOperate(larkAppId, chatId, senderOpenId)) {
        await sessionReply(messageId, `⚠️ ${cmd} 仅 oncall owner 可执行。`, 'text', larkAppId);
        return;
      }
      const session = sessionStore.createSession(chatId, messageId, cmdContent.substring(0, 50), chatType);
      session.larkAppId = larkAppId;
      session.ownerOpenId = senderOpenId;
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
      // Pass mention-stripped content so /command argument parsing works.
      await handleCommand(cmd, messageId, { ...parsed, content: cmdContent }, commandDeps, larkAppId);
      return;
    }
  }

  // Download attachments
  const { attachments, needLogin } = await downloadResources(larkAppId, messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }
  if (needLogin) {
    sessionReply(messageId, '⚠️ 部分图片/文件下载失败（缺少 User Token）。请在话题中发送 /login 授权后重新发送。', 'text', larkAppId);
  }

  refreshCliVersion(botCfg.cliId, botCfg.cliPathOverride);

  // Create session in pending-repo state — don't spawn CLI yet
  const session = sessionStore.createSession(chatId, messageId, parsed.content.substring(0, 50), chatType);
  session.larkAppId = larkAppId;
  session.ownerOpenId = senderOpenId;
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(messageId);
  messageQueue.appendMessage(messageId, parsed);

  // Oncall group: pin working dir from binding, skip repo selection entirely.
  const oncallEntry = findOncallChat(larkAppId, chatId);
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
    pendingRepo: !oncallEntry,
    pendingPrompt: content,
    pendingAttachments: attachments.length > 0 ? attachments : undefined,
    pendingMentions: parsed.mentions,
    ownerOpenId: senderOpenId,
    currentTurnTitle: content.substring(0, 50),
    workingDir: oncallEntry?.workingDir,
  };
  if (oncallEntry) {
    ds.session.workingDir = oncallEntry.workingDir;
    sessionStore.updateSession(ds.session);
  }
  activeSessions.set(sessionKey(messageId, larkAppId), ds);

  // Oncall-bound chat: spawn CLI immediately with the pinned working dir.
  if (oncallEntry) {
    const selfBot = getBot(larkAppId);
    const prompt = buildNewTopicPrompt(content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId });
    forkWorker(ds, prompt);
    logger.info(`[${tag(ds)}] Oncall-bound chat ${chatId} → workingDir=${oncallEntry.workingDir}, skipped repo select`);
    return;
  }

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
    ds.repoCardMessageId = await sessionReply(messageId, cardJson, 'interactive', larkAppId);
    logger.info(`[${tag(ds)}] Waiting for repo selection (${projects.length} projects)`);
  } else {
    // No projects found — skip repo selection, spawn directly
    ds.pendingRepo = false;
    const selfBot = getBot(larkAppId);
    const prompt = buildNewTopicPrompt(content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId });
    forkWorker(ds, prompt);
    logger.info(`Session ${session.sessionId} ready (no projects to select), total active: ${getActiveCount()}`);
  }
}

async function handleThreadReply(data: any, rootId: string, larkAppId: string): Promise<void> {
  await resolveNonsupportMessage(data, larkAppId);
  const { parsed, resources } = parseEventMessage(data);

  // Expand merge_forward: fetch sub-messages and collect their resources
  if (parsed.msgType === 'merge_forward') {
    const { extraResources } = await expandMergeForward(larkAppId, parsed.messageId, parsed);
    resources.push(...extraResources);
  }

  const content = parsed.content.trim();
  // Strip leading @<bot> mentions so "@bot /restart" is recognized as a command.
  const cmdContent = stripLeadingMentions(content, parsed.mentions);

  // Intercept OAuth callback URLs (from /login flow)
  if (isCallbackUrl(content)) {
    const result = await handleCallbackUrl(content);
    if (result) {
      replyMessage(larkAppId, parsed.messageId, JSON.stringify({ text: result }), 'text', true)
        .catch(err => logger.error(`Failed to reply login result: ${err}`));
      return;
    }
  }

  // Intercept daemon commands
  if (cmdContent.startsWith('/')) {
    const cmd = cmdContent.split(/\s+/)[0].toLowerCase();
    if (PASSTHROUGH_COMMANDS.has(cmd)) {
      const ds = activeSessions.get(sessionKey(rootId, larkAppId));
      if (ds?.worker && !ds.worker.killed) {
        ds.worker.send({ type: 'raw_input', content: cmdContent } as DaemonToWorker);
        ds.lastMessageAt = Date.now();
        logger.info(`[${rootId.substring(0, 12)}] Passthrough ${cmd} → worker`);
      } else {
        sessionReply(rootId, `${cmd} 需要活跃的 CLI 进程，当前话题无运行中的会话。`, 'text', larkAppId);
      }
      return;
    }
    if (DAEMON_COMMANDS.has(cmd)) {
      // Oncall owner gate for thread-reply daemon commands
      const existingDs = activeSessions.get(sessionKey(rootId, larkAppId));
      const threadChatId = existingDs?.chatId ?? data?.message?.chat_id;
      const threadSenderOpenId = parsed.senderId || data?.sender?.sender_id?.open_id;
      if (cmd !== '/oncall' && threadChatId && findOncallChat(larkAppId, threadChatId) && !canOperate(larkAppId, threadChatId, threadSenderOpenId)) {
        sessionReply(rootId, `⚠️ ${cmd} 仅 oncall owner 可执行。`, 'text', larkAppId);
        return;
      }
      // Pass mention-stripped content so /command argument parsing works.
      handleCommand(cmd, rootId, { ...parsed, content: cmdContent }, commandDeps, larkAppId);
      return;
    }
  }

  logger.info(`Thread reply in ${rootId}: ${content.substring(0, 100)} (resources: ${resources.length})`);

  let ds = activeSessions.get(sessionKey(rootId, larkAppId));

  // If another bot already owns this thread, ignore unmentioned replies here as a
  // second line of defense. Explicit @mentions are still allowed to spin up/take over.
  if (!ds) {
    const mentionedThisBot = isBotMentioned(larkAppId, data?.message ?? {}, data?.sender?.sender_id?.open_id);
    const hasOtherBot = [...activeSessions.values()].some(
      s => s.session.rootMessageId === rootId && s.larkAppId !== larkAppId
    );
    if (hasOtherBot && !mentionedThisBot) {
      logger.info(`[${larkAppId}] Ignoring thread ${rootId}; another bot already owns it`);
      return;
    }
  }

  // Download attachments
  const effectiveAppId = ds?.larkAppId ?? larkAppId;
  const { attachments, needLogin } = await downloadResources(effectiveAppId, parsed.messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }
  if (needLogin) {
    sessionReply(rootId, '⚠️ 部分图片/文件下载失败（缺少 User Token）。请在话题中发送 /login 授权后重新发送。', 'text', effectiveAppId);
  }

  // Update last message time
  if (ds) ds.lastMessageAt = Date.now();

  // If waiting for repo selection, buffer the message and remind user
  if (ds?.pendingRepo) {
    // Enrich content with attachment hints and mention metadata (same as normal send)
    let enriched = attachments.length > 0
      ? `${parsed.content}${formatAttachmentsHint(attachments)}`
      : parsed.content;
    if (parsed.mentions && parsed.mentions.length > 0) {
      const mentionLines = parsed.mentions.map(m => {
        const idPart = m.openId ? ` → open_id: ${m.openId}` : '';
        return `- @${m.name}${idPart}`;
      });
      enriched += `\n\n消息中的 @mention：\n${mentionLines.join('\n')}`;
    }
    if (!ds.pendingFollowUps) ds.pendingFollowUps = [];
    ds.pendingFollowUps.push(enriched);
    await sessionReply(rootId, '请先在上方卡片中选择仓库，您的消息已暂存，选择后会自动发送。', 'text', larkAppId);
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
    const senderOId = data.sender?.sender_id?.open_id;
    const session = sessionStore.createSession(chatId, rootId, parsed.content.substring(0, 50), chatType);
    session.larkAppId = larkAppId;
    session.ownerOpenId = senderOId;
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
      pendingMentions: parsed.mentions,
      ownerOpenId: senderOId,
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
      newDs.repoCardMessageId = await sessionReply(rootId, cardJson, 'interactive', larkAppId);
      logger.info(`[${tag(newDs)}] Waiting for repo selection (${projects.length} projects)`);
    } else {
      // No projects found — skip repo selection, spawn directly
      newDs.pendingRepo = false;
      const selfBot = getBot(larkAppId);
      const prompt = buildNewTopicPrompt(parsed.content, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId });
      forkWorker(newDs, prompt);
    }

    return;
  }

  // Send message to worker via IPC
  if (ds.worker && !ds.worker.killed) {
    const dsBotCfgForMsg = getBot(ds.larkAppId).config;
    const msgContent = buildFollowUpContent(parsed.content, ds.session.sessionId, {
      attachments,
      mentions: parsed.mentions,
      isAdoptMode: !!ds.adoptedFrom,
      cliId: dsBotCfgForMsg.cliId,
      cliPathOverride: dsBotCfgForMsg.cliPathOverride,
    });
    // Freeze the previous turn's card at "idle" before starting a new turn
    if (ds.streamCardId && ds.workerPort) {
      const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
      const dsBotCfg = getBot(ds.larkAppId).config;
      const prevTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(dsBotCfg.cliId);
      const prevMode = ds.displayMode ?? 'hidden';
      const frozenCard = buildStreamingCard(
        ds.session.sessionId, ds.session.rootMessageId, readUrl, prevTitle,
        ds.lastScreenContent ?? '', 'idle', dsBotCfg.cliId,
        prevMode, ds.streamCardNonce, ds.currentImageKey,
      );
      // Freeze through the serialization queue to avoid racing with an in-flight PATCH.
      // scheduleCardPatch replaces any stale pending item (latest-wins).
      scheduleCardPatch(ds, frozenCard);

      // Cache frozen card data so historical cards can still be toggled (expand/collapse)
      if (ds.streamCardNonce && ds.streamCardId !== CARD_POSTING_SENTINEL) {
        if (!ds.frozenCards) ds.frozenCards = new Map();
        ds.frozenCards.set(ds.streamCardNonce, {
          messageId: ds.streamCardId,
          content: ds.lastScreenContent ?? '',
          title: prevTitle,
          displayMode: prevMode,
          imageKey: ds.currentImageKey,
        });
        saveFrozenCards(ds.session.sessionId, ds.frozenCards);
      }
    }
    // Mark new turn — next screen_update will create a fresh streaming card
    ds.streamCardPending = true;
    ds.currentTurnTitle = parsed.content.substring(0, 50);
    persistStreamCardState(ds);
    ds.worker.send({ type: 'message', content: msgContent } as DaemonToWorker);
  } else {
    // Worker not running — re-fork with resume. This is a NEW turn, so drop
    // any restored streaming-card reference; worker_ready will POST a fresh
    // card instead of PATCHing the previous turn's card in place.
    logger.info(`[${tag(ds)}] Worker not running, re-forking...`);
    ds.currentTurnTitle = parsed.content.substring(0, 50);
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;
    persistStreamCardState(ds);
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
  const targetBot = getAllBots().find(b => b.botOpenId === signal.targetBotOpenId);
  if (!targetBot) {
    logger.debug(`[bot-mention] No bot found for open_id ${signal.targetBotOpenId}`);
    return;
  }

  const targetAppId = targetBot.config.larkAppId;
  const ds = activeSessions.get(sessionKey(signal.rootMessageId, targetAppId));

  if (ds && ds.worker && !ds.worker.killed) {
    // Target bot has an active session in this thread — send the message.
    // Look up sender name from bots-info.json (each daemon only registers its own bot,
    // so getAllBots() won't find other bots).
    let senderName = 'Bot';
    try {
      const infoPath = join(config.session.dataDir, 'bots-info.json');
      if (existsSync(infoPath)) {
        const entries: Array<{ larkAppId: string; botName: string | null; cliId: string }> = JSON.parse(readFileSync(infoPath, 'utf-8'));
        const sender = entries.find(e => e.larkAppId === signal.senderAppId);
        if (sender) senderName = sender.botName ?? getCliDisplayName(sender.cliId as CliId);
      }
    } catch { /* ignore */ }
    const enrichedParts = [`[来自 ${senderName} 的 @mention]\n${signal.content}`];
    if (!ds.adoptedFrom) {
      const mentionBotCfg = getBot(ds.larkAppId).config;
      const mentionAdapter = createCliAdapterSync(mentionBotCfg.cliId, mentionBotCfg.cliPathOverride);
      if (!mentionAdapter.injectsSessionContext) {
        enrichedParts.push(`Session ID: ${ds.session.sessionId}`);
      }
    }
    const enrichedContent = enrichedParts.join('\n\n');
    ds.lastMessageAt = Date.now();
    ds.streamCardPending = true;
    ds.currentTurnTitle = signal.content.substring(0, 50);
    persistStreamCardState(ds);
    ds.worker.send({ type: 'message', content: enrichedContent } as DaemonToWorker);
    logger.info(`[bot-mention] Routed message from ${signal.senderAppId} to ${targetAppId} in thread ${signal.rootMessageId}`);
  } else {
    logger.debug(`[bot-mention] Target bot ${targetAppId} has no active worker for thread ${signal.rootMessageId}`);
  }
}

function isSignalForMe(signal: BotMentionSignal): boolean {
  return getAllBots().some(b => b.botOpenId === signal.targetBotOpenId);
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
        if (!isSignalForMe(signal)) continue; // not for this daemon, leave for target
        unlinkSync(filePath);
        processBotMentionSignal(signal);
      } catch (err) {
        logger.debug(`[bot-mention] Failed to process signal ${file}: ${err}`);
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
        if (!isSignalForMe(signal)) return; // not for this daemon, leave for target
        unlinkSync(filePath);
        processBotMentionSignal(signal);
      } catch (err) {
        logger.debug(`[bot-mention] Failed to process signal ${filename}: ${err}`);
      }
    }, 50);
  });

  logger.info(`[bot-mention] Watching for signals in ${signalDir}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function startDaemon(botIndex?: number): Promise<void> {
  // 首次启动时后台尝试安装 CJK 字体（Debian/Ubuntu），避免截图中文显示豆腐块。
  // 不阻塞：首张截图可能仍是豆腐块，装完重启 daemon 即可正常。
  ensureCjkFontsInstalled();

  // Load the assigned bot (one daemon per bot)
  const botConfigs = loadBotConfigs();
  const idx = botIndex ?? 0;
  if (idx < 0 || idx >= botConfigs.length) {
    throw new Error(`Invalid BOTMUX_BOT_INDEX=${idx}, only ${botConfigs.length} bot(s) configured`);
  }
  const cfg = botConfigs[idx];
  registerBot(cfg);
  sessionStore.init(cfg.larkAppId);
  logger.info(`Bot ${idx}/${botConfigs.length}: ${cfg.larkAppId} (cli: ${cfg.cliId})`)

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
        return activeSessions.has(sessionKey(rootId, appId));
      },
    });
  }

  // Restore active sessions from previous run
  restoreActiveSessions(activeSessions);

  // Start scheduler in every daemon.  Each daemon owns exactly one bot, so
  // each filters to only execute tasks whose `larkAppId` matches its bot
  // (unmatched tasks are handled by the owning bot's daemon instead; a
  // missing larkAppId falls through to bot-0 as a legacy fallback).
  scheduler.setExecuteCallback((task) => executeScheduledTask(task, activeSessions, refreshCliVersion));
  scheduler.setOwnerFilter(cfg.larkAppId, idx === 0);
  scheduler.startScheduler();

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
