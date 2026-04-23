/**
 * Worker pool — manages forking, killing, and lifecycle of worker processes.
 * Extracted from daemon.ts for modularity.
 */
import { fork, execSync, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureSkills } from '../skills/installer.js';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import { persistStreamCardState } from './session-manager.js';
import { updateMessage, MessageWithdrawnError } from '../im/lark/client.js';
import { buildStreamingCard, buildSessionCard, buildTuiPromptCard, buildTuiPromptResolvedCard, getCliDisplayName } from '../im/lark/card-builder.js';
import { logger } from '../utils/logger.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
import { getBot, getAllBots } from '../bot-registry.js';
import type { CliId } from '../adapters/cli/types.js';
import type { DaemonToWorker, WorkerToDaemon, Session, DisplayMode } from '../types.js';
import type { DaemonSession } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Callbacks set by daemon at startup ─────────────────────────────────────

export interface WorkerPoolCallbacks {
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string) => Promise<string>;
  getSessionWorkingDir: (ds?: DaemonSession) => string;
  getActiveCount: () => number;
  /** Close a stale session (message withdrawn, etc.) */
  closeSession: (ds: DaemonSession) => void;
}

let callbacks: WorkerPoolCallbacks | undefined;

/**
 * Initialise worker-pool callbacks. Must be called once before forkWorker().
 */
export function initWorkerPool(cb: WorkerPoolCallbacks): void {
  callbacks = cb;
}

function requireCallbacks(): WorkerPoolCallbacks {
  if (!callbacks) throw new Error('WorkerPool not initialised — call initWorkerPool() first');
  return callbacks;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

// Sentinel value for streamCardId while a POST (new card) is in-flight.
// Prevents duplicate card POSTs when multiple screen_updates arrive before
// the first POST returns a real message_id.
export const CARD_POSTING_SENTINEL = '__posting__';

// ─── Card PATCH serialization queue ─────────────────────────────────────────
// Only one PATCH in-flight at a time per session. New PATCHes queue on
// ds.pendingCardJson (latest wins). When the in-flight PATCH completes,
// the pending one is flushed. This prevents concurrent PATCHes to the
// same Feishu message — delivery order is unpredictable and a stale
// screen_update could overwrite a toggle result.

/**
 * Queue a card PATCH. If no PATCH is in-flight, sends immediately.
 * Otherwise stores the card JSON on `ds.pendingCardJson` (overwriting
 * any previously queued value — only the latest state matters).
 */
export function scheduleCardPatch(ds: DaemonSession, cardJson: string): void {
  ds.pendingCardJson = cardJson;
  // Capture the card ID now — by the time flushCardPatch runs, ds.streamCardId
  // may have been overwritten by a new turn's card (CARD_POSTING_SENTINEL).
  ds.pendingCardId = ds.streamCardId;
  if (ds.cardPatchInFlight) return;
  flushCardPatch(ds);
}

function flushCardPatch(ds: DaemonSession): void {
  const json = ds.pendingCardJson;
  const cardId = ds.pendingCardId;
  if (!json || !cardId || cardId === CARD_POSTING_SENTINEL) {
    ds.pendingCardJson = undefined;
    ds.pendingCardId = undefined;
    return;
  }
  ds.pendingCardJson = undefined;
  ds.pendingCardId = undefined;
  ds.cardPatchInFlight = true;
  updateMessage(ds.larkAppId, cardId, json)
    .catch(err => {
      if (err instanceof MessageWithdrawnError) {
        logger.warn(`[${tag(ds)}] Stream card withdrawn, clearing reference`);
        ds.streamCardId = undefined;
        persistStreamCardState(ds);
        return;
      }
      logger.debug(`[${tag(ds)}] Failed to update streaming card: ${err}`);
    })
    .finally(() => {
      ds.cardPatchInFlight = false;
      if (ds.pendingCardJson) {
        flushCardPatch(ds);
      }
    });
}

// ─── Restart rate-limiting ──────────────────────────────────────────────────

export const restartCounts = new Map<string, { count: number; lastAt: number }>();

// ─── Skills installation ────────────────────────────────────────────────────

/** Track which CLI adapters have had skills installed this daemon lifecycle */
const skillsInstalledCliIds = new Set<string>();

/**
 * Ensure built-in skills are installed for a given CLI.
 * Synchronous and idempotent — runs once per CLI per daemon lifecycle.
 */
export function ensureCliSkills(cliId: CliId, cliPathOverride?: string): void {
  if (skillsInstalledCliIds.has(cliId)) return;
  const adapter = createCliAdapterSync(cliId, cliPathOverride);
  ensureSkills(cliId, adapter.skillsDir);
  skillsInstalledCliIds.add(cliId);
}

// ─── Legacy MCP config cleanup ──────────────────────────────────────────────
//
// botmux used to register itself as an MCP server in each CLI's config so the
// CLI could call send_to_thread / get_thread_messages / list_bots.  Those
// tools have since been migrated to `botmux` subcommands + Skills.  The old
// MCP entry is now dead — if we leave it, the CLI will try to spawn a
// non-existent server on startup and users see scary errors.
//
// For each CLI, best-effort remove any `botmux` entry from its MCP config.
// Runs once per CLI per daemon lifecycle, same lifecycle as ensureCliSkills.

/** Track which CLI adapters have had legacy MCP config cleaned this daemon lifecycle */
const legacyMcpCleanedCliIds = new Set<string>();

/** Remove a key from a JSON config file at the given dotted path. Best-effort. */
function removeJsonKey(configPath: string, pathSegments: string[], keyToRemove: string): boolean {
  try {
    if (!existsSync(configPath)) return false;
    const raw = readFileSync(configPath, 'utf-8');
    const data = JSON.parse(raw);
    let node: any = data;
    for (const seg of pathSegments) {
      if (!node || typeof node !== 'object' || !(seg in node)) return false;
      node = node[seg];
    }
    if (!node || typeof node !== 'object' || !(keyToRemove in node)) return false;
    delete node[keyToRemove];
    writeFileSync(configPath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Try running `<cli> mcp remove botmux`. Returns true if the command ran. */
function tryCliMcpRemove(binName: string): boolean {
  try {
    execSync(`${binName} mcp remove botmux`, { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove legacy `botmux` MCP server registration from the given CLI's config.
 * Idempotent — runs once per CLI per daemon lifecycle.  Best-effort: any
 * failure is swallowed; we never want to block worker startup.
 */
export function cleanupLegacyMcpConfig(cliId: CliId): void {
  if (legacyMcpCleanedCliIds.has(cliId)) return;
  legacyMcpCleanedCliIds.add(cliId);

  try {
    const home = homedir();
    switch (cliId) {
      case 'claude-code': {
        // ~/.claude.json → { mcpServers: { botmux } }
        if (removeJsonKey(join(home, '.claude.json'), ['mcpServers'], 'botmux')) {
          logger.info(`[legacy-mcp] Removed botmux entry from ~/.claude.json`);
        }
        break;
      }
      case 'aiden': {
        // ~/.aiden/.mcp.json or cwd/.mcp.json → { mcpServers: { botmux } }
        for (const p of [join(home, '.aiden', '.mcp.json'), join(process.cwd(), '.mcp.json')]) {
          if (removeJsonKey(p, ['mcpServers'], 'botmux')) {
            logger.info(`[legacy-mcp] Removed botmux entry from ${p}`);
          }
        }
        break;
      }
      case 'opencode': {
        // ~/.config/opencode/opencode.json → { mcp: { botmux } } or { mcpServers: { botmux } }
        const p = join(home, '.config', 'opencode', 'opencode.json');
        const removed =
          removeJsonKey(p, ['mcp'], 'botmux') ||
          removeJsonKey(p, ['mcpServers'], 'botmux') ||
          removeJsonKey(p, ['mcp', 'servers'], 'botmux');
        if (removed) logger.info(`[legacy-mcp] Removed botmux entry from ${p}`);
        break;
      }
      case 'coco':
      case 'codex':
      case 'gemini': {
        // These CLIs managed MCP via their own subcommand.  Skip silently if
        // the binary isn't on PATH — nothing to clean then.
        if (tryCliMcpRemove(cliId)) {
          logger.info(`[legacy-mcp] Ran \`${cliId} mcp remove botmux\``);
        }
        break;
      }
    }
  } catch (err) {
    logger.debug(`[legacy-mcp] Cleanup for ${cliId} failed (ignored): ${err}`);
  }
}

/**
 * Ensure per-CLI environment is set up for this daemon lifecycle: install
 * built-in skills and clean up any legacy MCP server registration.
 * Both steps are idempotent and best-effort.
 */
export function ensureCliEnv(cliId: CliId, cliPathOverride?: string): void {
  ensureCliSkills(cliId, cliPathOverride);
  cleanupLegacyMcpConfig(cliId);
}

// ─── Kill worker ────────────────────────────────────────────────────────────

export function killWorker(ds: DaemonSession): void {
  if (!ds.worker || ds.worker.killed) return;
  try {
    ds.worker.send({ type: 'close' } as DaemonToWorker);
  } catch { /* IPC already closed */ }
  // Give worker 2s to clean up, then force kill
  const w = ds.worker;
  setTimeout(() => { if (!w.killed) w.kill('SIGTERM'); }, 2000);
  ds.worker = null;
  ds.workerPort = null;
  ds.workerToken = null;
}

// ─── Fork worker ────────────────────────────────────────────────────────────

export function forkWorker(ds: DaemonSession, prompt: string, resume = false): void {
  const cb = requireCallbacks();
  const bot = getBot(ds.larkAppId);
  const botCfg = bot.config;
  // worker.js lives in the same directory as daemon.js (src/)
  const workerPath = join(__dirname, '..', 'worker.js');
  const cwd = cb.getSessionWorkingDir(ds);
  const t = tag(ds);

  // Guard against double-fork: if a worker is already running, kill it first
  if (ds.worker && !ds.worker.killed) {
    logger.warn(`[${t}] Worker already running (pid: ${ds.worker.pid}), killing before re-fork`);
    try { ds.worker.send({ type: 'close' } as DaemonToWorker); } catch { /* ignore */ }
    try { ds.worker.kill(); } catch { /* ignore */ }
    ds.worker = null;
    ds.workerPort = null;
    ds.workerToken = null;
  }

  ensureCliEnv(botCfg.cliId, botCfg.cliPathOverride);

  // Prepend ~/.botmux/bin to PATH so CLIs can call `botmux send` etc.
  // The wrapper script there is written by the daemon at startup.
  const botmuxBinDir = join(homedir(), '.botmux', 'bin');
  const pathWithBotmux = `${botmuxBinDir}:${process.env.PATH ?? ''}`;

  const worker = fork(workerPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd,
    env: {
      ...process.env,
      PATH: pathWithBotmux,
      CLAUDECODE: undefined,
      BOTMUX: '1',  // Inherited by CLI → MCP server for session detection
      SESSION_DATA_DIR: config.session.dataDir,
      LARK_APP_ID: botCfg.larkAppId,
      LARK_APP_SECRET: botCfg.larkAppSecret,
    },
  });

  // Pipe worker stdout/stderr to daemon logger
  worker.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.info(`[${t}:out] ${trimmed}`);
    }
  });
  worker.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.error(`[${t}:worker] ${trimmed}`);
    }
  });

  // Send init config — use per-bot settings
  const initMsg: DaemonToWorker = {
    type: 'init',
    sessionId: ds.session.sessionId,
    chatId: ds.chatId,
    rootMessageId: ds.session.rootMessageId,
    workingDir: cwd,
    cliId: botCfg.cliId,
    cliPathOverride: botCfg.cliPathOverride,
    backendType: botCfg.backendType ?? config.daemon.backendType,
    prompt,
    resume,
    ownerOpenId: ds.ownerOpenId,
    webPort: ds.session.webPort,
    larkAppId: botCfg.larkAppId,
    larkAppSecret: botCfg.larkAppSecret,
    botName: bot.botName,
    botOpenId: bot.botOpenId,
  };
  worker.send(initMsg);
  ds.initConfig = initMsg;

  // Use shared handler for IPC messages and exit
  setupWorkerHandlers(ds, worker);

  ds.worker = worker;
  ds.spawnedAt = Date.now();
  ds.cliVersion = currentCliVersion;
  sessionStore.updateSessionPid(ds.session.sessionId, worker.pid ?? null);
  logger.info(`[${t}] Worker forked (pid: ${worker.pid}, active: ${cb.getActiveCount()})`);
}

// ─── Shared worker IPC handler ──────────────────────────────────────────────

function setupWorkerHandlers(ds: DaemonSession, worker: ChildProcess): void {
  const cb = requireCallbacks();
  const t = tag(ds);
  const bot = getBot(ds.larkAppId);
  const botCfg = bot.config;

  // Adopt mode flags — computed once, used in all buildStreamingCard calls
  const isAdopt = !!ds.adoptedFrom;
  const showTakeover = isAdopt && !!ds.adoptedFrom?.sessionId;

  worker.on('message', async (msg: WorkerToDaemon) => {
    switch (msg.type) {
      case 'ready': {
        ds.workerPort = msg.port;
        ds.workerToken = msg.token;
        // Persist port so it can be reused after daemon restart
        ds.session.webPort = msg.port;
        sessionStore.updateSession(ds.session);
        const readOnlyUrl = `http://${config.web.externalHost}:${msg.port}`;
        const writeUrl = `${readOnlyUrl}?token=${msg.token}`;
        logger.info(`[${t}] Worker ready, terminal at ${readOnlyUrl}`);

        // If a previous streaming card survived (e.g. daemon restart), try to
        // PATCH it with the new "starting" state instead of POSTing a fresh card.
        // ds.streamCardPending forces a new card (e.g. mid-session repo switch
        // explicitly cleared streamCardId before re-fork — keep that behaviour).
        const restoredCardId =
          ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && !ds.streamCardPending
            ? ds.streamCardId
            : undefined;
        if (restoredCardId) {
          try {
            const initTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
            // Reuse persisted nonce so existing card buttons (toggle/etc) keep working.
            if (!ds.streamCardNonce) ds.streamCardNonce = randomBytes(4).toString('hex');
            const streamCardJson = buildStreamingCard(
              ds.session.sessionId,
              ds.session.rootMessageId,
              readOnlyUrl,
              initTitle,
              ds.lastScreenContent ?? '',
              'starting',
              botCfg.cliId,
              ds.displayMode ?? 'hidden',
              ds.streamCardNonce,
              ds.currentImageKey,
              isAdopt,
              showTakeover,
            );
            await updateMessage(ds.larkAppId, restoredCardId, streamCardJson);
            persistStreamCardState(ds);
            // Re-sync worker's display mode (it starts fresh in 'hidden')
            if (ds.worker && ds.displayMode && ds.displayMode !== 'hidden') {
              ds.worker.send({ type: 'set_display_mode', mode: ds.displayMode } as DaemonToWorker);
            }
            logger.info(`[${t}] Reused existing streaming card ${restoredCardId.substring(0, 12)} after worker (re)start`);
            break;
          } catch (err) {
            // PATCH failed (withdrawn, expired, etc.) — fall through to POST a fresh card.
            logger.info(`[${t}] Failed to reuse existing streaming card (${err instanceof Error ? err.message : err}), posting new one`);
            ds.streamCardId = undefined;
            persistStreamCardState(ds);
          }
        }

        // Send streaming card to group thread (read-only link, will be PATCHed with live output)
        // Set sentinel BEFORE await so concurrent screen_update messages
        // (which can arrive while the POST is in-flight) don't POST a duplicate card.
        ds.streamCardId = CARD_POSTING_SENTINEL;
        try {
          ds.streamCardNonce = randomBytes(4).toString('hex');
          const initTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
          const streamCardJson = buildStreamingCard(
            ds.session.sessionId,
            ds.session.rootMessageId,
            readOnlyUrl,
            initTitle,
            '',
            'starting',
            botCfg.cliId,
            ds.displayMode ?? 'hidden',
            ds.streamCardNonce,
            ds.currentImageKey,
            isAdopt,
            showTakeover,
          );
          ds.streamCardId = await cb.sessionReply(ds.session.rootMessageId, streamCardJson, 'interactive', ds.larkAppId);
          persistStreamCardState(ds);
        } catch (err) {
          if (err instanceof MessageWithdrawnError) {
            logger.warn(`[${t}] Root message withdrawn, closing stale session`);
            killWorker(ds);
            cb.closeSession(ds);
            break;
          }
          logger.warn(`[${t}] Failed to send streaming card, falling back to static card: ${err}`);
          // Clear sentinel so screen_updates can create a streaming card later
          ds.streamCardId = undefined;
          persistStreamCardState(ds);
          // Fallback: send static session card
          try {
            const cardJson = buildSessionCard(
              ds.session.sessionId,
              ds.session.rootMessageId,
              readOnlyUrl,
              ds.session.title || getCliDisplayName(botCfg.cliId),
              botCfg.cliId,
            );
            await cb.sessionReply(ds.session.rootMessageId, cardJson, 'interactive', ds.larkAppId);
          } catch (fallbackErr) {
            if (fallbackErr instanceof MessageWithdrawnError) {
              logger.warn(`[${t}] Root message withdrawn, closing stale session`);
              killWorker(ds);
              cb.closeSession(ds);
              break;
            }
            throw fallbackErr;
          }
        }

        break;
      }

      case 'prompt_ready': {
        logger.info(`[${t}] ${getCliDisplayName(botCfg.cliId)} is ready for input`);
        break;
      }

      case 'screen_update': {
        if (!ds.workerPort) break;
        const prevStatus = ds.lastScreenStatus;
        ds.lastScreenContent = msg.content;
        ds.lastScreenStatus = msg.status;

        const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
        const mode: DisplayMode = ds.displayMode ?? 'hidden';

        if (ds.streamCardPending || !ds.streamCardId) {
          // If a POST is already in-flight, drop this update — it will be
          // picked up by subsequent screen_updates once the card ID lands.
          if (ds.streamCardId === CARD_POSTING_SENTINEL) break;

          // New turn — create a fresh card, old card freezes at its last state.
          // Generate new nonce so old card buttons are distinguishable.
          const isNewTurn = !!ds.streamCardPending;
          ds.streamCardNonce = randomBytes(4).toString('hex');
          // New turn → image_key from previous turn no longer valid
          if (isNewTurn) ds.currentImageKey = undefined;
          const cardJson = buildStreamingCard(
            ds.session.sessionId,
            ds.session.rootMessageId,
            readUrl,
            turnTitle,
            isNewTurn ? '' : msg.content,
            msg.status,
            botCfg.cliId,
            mode,
            ds.streamCardNonce,
            ds.currentImageKey,
            isAdopt,
            showTakeover,
          );
          // Mark POST in-flight so subsequent screen_updates are dropped,
          // not POSTed as duplicate cards.
          ds.streamCardPending = false;
          ds.streamCardId = CARD_POSTING_SENTINEL;
          cb.sessionReply(ds.session.rootMessageId, cardJson, 'interactive', ds.larkAppId)
            .then(msgId => { ds.streamCardId = msgId; persistStreamCardState(ds); })
            .catch(err => {
              if (err instanceof MessageWithdrawnError) {
                logger.warn(`[${t}] Root message withdrawn, closing stale session`);
                killWorker(ds);
                cb.closeSession(ds);
                return;
              }
              logger.debug(`[${t}] Failed to create streaming card: ${err}`);
              ds.streamCardId = undefined;
              persistStreamCardState(ds);
            });
        } else {
          // Same turn — PATCH only on status change. Image PATCHes go through
          // the screenshot_uploaded path; text is no longer a card body mode.
          const statusChanged = prevStatus !== msg.status;
          if (!statusChanged) break;
          const cardJson = buildStreamingCard(
            ds.session.sessionId,
            ds.session.rootMessageId,
            readUrl,
            turnTitle,
            msg.content,
            msg.status,
            botCfg.cliId,
            mode,
            ds.streamCardNonce,
            ds.currentImageKey,
            isAdopt,
            showTakeover,
          );
          scheduleCardPatch(ds, cardJson);
        }
        break;
      }

      case 'screenshot_uploaded': {
        // Drop uploads that arrived during a new-turn handoff — the image_key may
        // reflect previous turn's content. Next 10s cycle picks up fresh content.
        if (ds.streamCardPending) break;
        ds.currentImageKey = msg.imageKey;
        ds.lastScreenStatus = msg.status;
        persistStreamCardState(ds);
        if ((ds.displayMode ?? 'hidden') !== 'screenshot') break;
        if (!ds.streamCardId || ds.streamCardId === CARD_POSTING_SENTINEL || !ds.workerPort) break;
        const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          ds.session.rootMessageId,
          readUrl,
          turnTitle,
          ds.lastScreenContent ?? '',
          msg.status,
          botCfg.cliId,
          'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
          isAdopt,
          showTakeover,
        );
        scheduleCardPatch(ds, cardJson);
        break;
      }

      case 'tui_prompt': {
        // AI detected an interactive TUI prompt — post card to thread
        // Dedup: if a card is already posted for this session, skip
        if (ds.tuiPromptCardId) {
          logger.debug(`[${t}] TUI prompt card already posted, skipping duplicate`);
          break;
        }
        logger.info(`[${t}] TUI prompt detected: ${msg.description}${msg.multiSelect ? ' (multi-select)' : ''}`);
        ds.tuiPromptOptions = msg.options;
        ds.tuiPromptMultiSelect = msg.multiSelect;
        ds.tuiToggledIndices = [];
        ds.currentTurnTitle = msg.description;  // store for card PATCH on toggle
        try {
          const cardJson = buildTuiPromptCard(
            ds.session.rootMessageId,
            ds.session.sessionId,
            msg.description,
            msg.options,
            msg.multiSelect,
          );
          const cardMsgId = await cb.sessionReply(ds.session.rootMessageId, cardJson, 'interactive', ds.larkAppId);
          ds.tuiPromptCardId = cardMsgId;
        } catch (err) {
          logger.warn(`[${t}] Failed to post TUI prompt card: ${err}`);
        }
        break;
      }

      case 'tui_prompt_resolved': {
        // TUI prompt is no longer showing — update card if it exists
        logger.info(`[${t}] TUI prompt resolved${msg.selectedText ? `: ${msg.selectedText}` : ''}`);
        if (ds.tuiPromptCardId) {
          const resolvedCard = buildTuiPromptResolvedCard(msg.selectedText ?? 'Done');
          updateMessage(ds.larkAppId, ds.tuiPromptCardId, resolvedCard).catch(err =>
            logger.debug(`[${t}] Failed to update TUI prompt card: ${err}`),
          );
          ds.tuiPromptCardId = undefined;
          ds.tuiPromptOptions = undefined;
        }
        break;
      }

      case 'claude_exit': {
        logger.info(`[${t}] ${getCliDisplayName(botCfg.cliId)} exited (code: ${msg.code}, signal: ${msg.signal})`);
        ds.hasHistory = true;

        // Do NOT auto-restart in adopt mode — there's nothing to restart
        if (ds.adoptedFrom) {
          logger.info(`[${t}] Adopted session ended`);
          // Freeze the streaming card
          if (ds.streamCardId && ds.workerPort) {
            const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
            const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
            const frozenCard = buildStreamingCard(
              ds.session.sessionId, ds.session.rootMessageId, readUrl, turnTitle,
              ds.lastScreenContent ?? '', 'idle', botCfg.cliId,
              ds.displayMode ?? 'hidden', ds.streamCardNonce, ds.currentImageKey,
              isAdopt, showTakeover,
            );
            scheduleCardPatch(ds, frozenCard);
          }
          killWorker(ds);
          try {
            await cb.sessionReply(ds.session.rootMessageId, '\u23cf 已采纳的 CLI 会话已退出', 'text', ds.larkAppId);
          } catch { /* best effort */ }
          break;
        }

        // Rate-limit auto-restart to prevent crash loops
        const key = ds.session.sessionId;
        const rc = restartCounts.get(key) ?? { count: 0, lastAt: 0 };
        const now = Date.now();
        if (now - rc.lastAt > 60_000) rc.count = 0; // reset after 1 min
        rc.count++;
        rc.lastAt = now;
        restartCounts.set(key, rc);

        if (rc.count > 3) {
          logger.warn(`[${t}] ${getCliDisplayName(botCfg.cliId)} crashed ${rc.count} times in 1 min, not auto-restarting`);
          // Freeze the last streaming card so it doesn't stay at "working" forever
          if (ds.streamCardId && ds.workerPort) {
            const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
            const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
            const frozenCard = buildStreamingCard(
              ds.session.sessionId, ds.session.rootMessageId, readUrl, turnTitle,
              ds.lastScreenContent ?? '', 'idle', botCfg.cliId,
              ds.displayMode ?? 'hidden', ds.streamCardNonce, ds.currentImageKey,
            );
            scheduleCardPatch(ds, frozenCard);
          }
          // Kill the worker process to free resources
          killWorker(ds);
          const cliName = getCliDisplayName(botCfg.cliId);
          try {
            await cb.sessionReply(ds.session.rootMessageId, `\u26a0\ufe0f ${cliName} 在 1 分钟内崩溃 ${rc.count} 次，已停止自动重启。发消息可触发重新启动。`, 'text', ds.larkAppId);
          } catch (replyErr) {
            if (replyErr instanceof MessageWithdrawnError) {
              logger.warn(`[${t}] Root message withdrawn, closing stale session`);
              cb.closeSession(ds);
            }
          }
          break;
        }

        // Auto-restart CLI within the same worker
        if (ds.worker && !ds.worker.killed) {
          logger.info(`[${t}] Auto-restarting ${getCliDisplayName(botCfg.cliId)}...`);
          ds.worker.send({ type: 'restart' } as DaemonToWorker);
        }
        break;
      }

      case 'error': {
        logger.error(`[${t}] Worker error: ${msg.message}`);
        break;
      }

      case 'user_notify': {
        logger.warn(`[${t}] Worker user_notify: ${msg.message}`);
        try {
          await cb.sessionReply(ds.session.rootMessageId, msg.message, 'text', ds.larkAppId);
        } catch (err: any) {
          logger.error(`[${t}] Failed to deliver user_notify to Lark: ${err.message}`);
        }
        break;
      }
    }
  });

  worker.on('exit', (code) => {
    logger.info(`[${t}] Worker process exited (code: ${code})`);
    // Only clear ds.worker if it's still THIS worker — during takeover,
    // the old worker's exit fires AFTER the new worker has been assigned.
    if (ds.worker === worker) {
      ds.worker = null;
      ds.workerPort = null;
    }
  });
}

// ─── Fork adopt worker ──────────────────────────────────────────────────────

export function forkAdoptWorker(ds: DaemonSession): void {
  const cb = requireCallbacks();
  const workerPath = join(__dirname, '..', 'worker.js');
  const t = tag(ds);
  const adopted = ds.adoptedFrom;
  if (!adopted) throw new Error('forkAdoptWorker called without adoptedFrom');

  const bot = getBot(ds.larkAppId);
  const botCfg = bot.config;

  // Guard against double-fork
  if (ds.worker && !ds.worker.killed) {
    logger.warn(`[${t}] Worker already running, killing before adopt-fork`);
    try { ds.worker.send({ type: 'close' } as DaemonToWorker); } catch {}
    try { ds.worker.kill(); } catch {}
    ds.worker = null;
    ds.workerPort = null;
    ds.workerToken = null;
  }

  // No ensureCliSkills — adopt mode attaches to an existing CLI session

  const worker = fork(workerPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd: adopted.cwd ?? ds.workingDir ?? process.cwd(),
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      BOTMUX: '1',
      LARK_APP_ID: botCfg.larkAppId,
      LARK_APP_SECRET: botCfg.larkAppSecret,
    },
  });

  // Pipe worker stdout/stderr
  worker.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.info(`[${t}:out] ${trimmed}`);
    }
  });
  worker.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.error(`[${t}:worker] ${trimmed}`);
    }
  });

  const initMsg: DaemonToWorker = {
    type: 'init',
    sessionId: ds.session.sessionId,
    chatId: ds.chatId,
    rootMessageId: ds.session.rootMessageId,
    workingDir: adopted.cwd,
    cliId: adopted.cliId ?? 'claude-code',
    backendType: 'tmux',
    prompt: '',
    resume: false,
    ownerOpenId: ds.ownerOpenId,
    webPort: ds.session.webPort,
    larkAppId: botCfg.larkAppId,
    larkAppSecret: botCfg.larkAppSecret,
    botName: bot.botName,
    botOpenId: bot.botOpenId,
    adoptMode: true,
    adoptTmuxTarget: adopted.tmuxTarget,
    adoptPaneCols: adopted.paneCols,
    adoptPaneRows: adopted.paneRows,
  };
  worker.send(initMsg);
  ds.initConfig = initMsg;

  // Use shared handler
  setupWorkerHandlers(ds, worker);

  ds.worker = worker;
  ds.spawnedAt = Date.now();
  ds.cliVersion = '';
  logger.info(`[${t}] Adopt worker forked (pid: ${worker.pid}, target: ${adopted.tmuxTarget})`);
}

// ─── Kill stale PIDs ────────────────────────────────────────────────────────

export function killStalePids(activeSessions_: Session[]): void {
  for (const session of activeSessions_) {
    if (!session.pid) continue;
    try {
      // Check if process exists (signal 0 doesn't kill, just checks)
      process.kill(session.pid, 0);
      // Process exists — kill its process group
      logger.info(`Killing stale CLI process (pid: ${session.pid}, session: ${session.sessionId})`);
      try {
        process.kill(-session.pid, 'SIGTERM');
      } catch {
        try { process.kill(session.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    } catch {
      // Process doesn't exist, nothing to clean up
    }
  }

  // Tmux cleanup — check if any bot uses tmux (or the global default is tmux)
  const anyTmux = getAllBots().some(b => (b.config.backendType ?? config.daemon.backendType) === 'tmux')
    || config.daemon.backendType === 'tmux';
  if (anyTmux) {
    const multiBot = getAllBots().length > 1;
    const cliIdFile = join(config.session.dataDir, 'last-cli-id');
    let lastCliId: string | undefined;
    try { lastCliId = readFileSync(cliIdFile, 'utf-8').trim(); } catch { /* first run */ }
    // For tmux cleanup: use global cliId for single-bot compat
    const currentCliId = config.daemon.cliId;

    if (!multiBot && lastCliId && lastCliId !== currentCliId) {
      // Single-bot mode: CLI_ID changed since last run, kill ALL tmux sessions
      logger.info(`CLI_ID changed (${lastCliId} → ${currentCliId}), killing all tmux sessions`);
      for (const name of TmuxBackend.listBotmuxSessions()) {
        TmuxBackend.killSession(name);
      }
    } else {
      // Clean orphaned tmux sessions that belong to THIS bot only.
      // In multi-bot mode each daemon only knows its own sessions — we must
      // not kill tmux sessions that belong to other bots' daemons.
      const activeNames = new Set(
        activeSessions_.map(s => TmuxBackend.sessionName(s.sessionId)),
      );
      const ownedNames = new Set(
        sessionStore.listSessions().map(s => TmuxBackend.sessionName(s.sessionId)),
      );
      for (const name of TmuxBackend.listBotmuxSessions()) {
        if (ownedNames.has(name) && !activeNames.has(name)) {
          logger.info(`Killing orphaned tmux session: ${name}`);
          TmuxBackend.killSession(name);
        }
      }
    }

    // Persist current CLI_ID for next restart (best-effort, single-bot compat)
    try {
      mkdirSync(config.session.dataDir, { recursive: true });
      writeFileSync(cliIdFile, currentCliId);
    } catch (err) {
      logger.warn(`Failed to write ${cliIdFile}: ${err}`);
    }
  }
}

// ─── CLI version (shared with daemon) ─────────────────────────────────────

/** Current CLI version, kept in sync by daemon via setCurrentCliVersion(). */
let currentCliVersion = 'unknown';

export function setCurrentCliVersion(v: string): void {
  currentCliVersion = v;
}

export function getCurrentCliVersion(): string {
  return currentCliVersion;
}
