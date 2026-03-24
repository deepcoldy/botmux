/**
 * Worker pool — manages forking, killing, and lifecycle of worker processes.
 * Extracted from daemon.ts for modularity.
 */
import { fork } from 'node:child_process';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import { getCliDisplayName } from '../utils/cli-display.js';
import { logger } from '../utils/logger.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
import { getBot, getAllBots } from '../bot-registry.js';
import type { CliId } from '../adapters/cli/types.js';
import type { DaemonToWorker, WorkerToDaemon, Session } from '../types.js';
import type { DaemonSession } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Callbacks set by daemon at startup ─────────────────────────────────────

export interface WorkerPoolCallbacks {
  sessionReply: (rootId: string, content: string, msgType?: string, imBotId?: string) => Promise<string>;
  getSessionWorkingDir: (ds?: DaemonSession) => string;
  getActiveCount: () => number;
  /** Close a stale session (message withdrawn, etc.) */
  closeSession: (ds: DaemonSession) => void;
  /** Update (PATCH) an existing IM message (e.g. card). */
  updateMessage: (imBotId: string, messageId: string, content: string) => Promise<void>;
  /** Check whether an error represents a withdrawn/deleted message in the IM platform. */
  isMessageWithdrawn: (err: unknown) => boolean;
  /** Build a streaming card JSON string for live CLI output. */
  buildStreamingCard: (sessionId: string, rootMessageId: string, terminalUrl: string, title: string, content: string, status: 'starting' | 'working' | 'idle', cliId?: CliId, expanded?: boolean, nonce?: string) => string;
  /** Build a static session card JSON string with terminal link + action buttons. */
  buildSessionCard: (sessionId: string, rootMessageId: string, terminalUrl: string, title: string, cliId?: CliId, showManageButtons?: boolean) => string;
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
const CARD_POSTING_SENTINEL = '__posting__';

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
  if (ds.cardPatchInFlight) return;
  flushCardPatch(ds);
}

function flushCardPatch(ds: DaemonSession): void {
  const json = ds.pendingCardJson;
  const cardId = ds.streamCardId;
  if (!json || !cardId || cardId === CARD_POSTING_SENTINEL) {
    ds.pendingCardJson = undefined;
    return;
  }
  ds.pendingCardJson = undefined;
  ds.cardPatchInFlight = true;
  const cb = requireCallbacks();
  cb.updateMessage(ds.imBotId, cardId, json)
    .catch(err => {
      if (cb.isMessageWithdrawn(err)) {
        logger.warn(`[${tag(ds)}] Stream card withdrawn, clearing reference`);
        ds.streamCardId = undefined;
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

// ─── MCP config ─────────────────────────────────────────────────────────────

/** Track which CLI adapters have had MCP config ensured this daemon lifecycle */
const mcpConfiguredCliIds = new Set<string>();

/**
 * Ensure the botmux MCP server is registered globally for a given CLI.
 * Delegates to the CLI adapter which knows the correct config file location.
 */
export function ensureMcpConfig(cliId: CliId, cliPathOverride?: string): void {
  if (mcpConfiguredCliIds.has(cliId)) return;
  const adapter = createCliAdapterSync(cliId, cliPathOverride);
  // Resolve path relative to src/ (one level up from core/)
  const serverScript = join(__dirname, '..', 'index.js');
  adapter.ensureMcpConfig({
    name: 'botmux',
    command: 'node',
    args: [serverScript],
    env: {
      BOTMUX: '1',  // Must be in config env: MCP SDK only passes config env to server subprocess
      SESSION_DATA_DIR: config.session.dataDir,
    },
  });
  mcpConfiguredCliIds.add(cliId);
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
  const bot = getBot(ds.imBotId);
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

  ensureMcpConfig(botCfg.cliId, botCfg.cliPathOverride);

  const worker = fork(workerPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      BOTMUX: '1',  // Inherited by CLI → MCP server for session detection
      IM_BOT_ID: ds.imBotId,
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
    ownerId: ds.ownerId,
    webPort: ds.session.webPort,
    imBotId: ds.imBotId,
  };
  worker.send(initMsg);
  ds.initConfig = initMsg;

  // Handle IPC messages from worker
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

        if (ds.nonStreamingIm) {
          // Send one-time welcome message with terminal URL
          const initTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
          const sessionCard = cb.buildSessionCard(
            ds.session.sessionId, ds.session.rootMessageId, readOnlyUrl, initTitle, botCfg.cliId,
          );
          if (sessionCard) {
            cb.sessionReply(ds.session.rootMessageId, sessionCard, 'interactive', ds.imBotId)
              .catch(err => logger.debug(`[${t}] Failed to send welcome: ${err}`));
          }
          break;
        }

        // Send streaming card to group thread (read-only link, will be PATCHed with live output)
        // Set sentinel BEFORE await so concurrent screen_update messages
        // (which can arrive while the POST is in-flight) don't POST a duplicate card.
        ds.streamCardId = CARD_POSTING_SENTINEL;
        try {
          ds.streamCardNonce = randomBytes(4).toString('hex');
          const initTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
          const streamCardJson = cb.buildStreamingCard(
            ds.session.sessionId,
            ds.session.rootMessageId,
            readOnlyUrl,
            initTitle,
            '',
            'starting',
            botCfg.cliId,
            ds.streamExpanded,
            ds.streamCardNonce,
          );
          if (!streamCardJson) {
            // Non-streaming IM (e.g. WeChat) — send static session card instead, skip streaming
            ds.streamCardId = undefined;
            const sessionCard = cb.buildSessionCard(
              ds.session.sessionId, ds.session.rootMessageId, readOnlyUrl,
              initTitle, botCfg.cliId,
            );
            if (sessionCard) {
              await cb.sessionReply(ds.session.rootMessageId, sessionCard, 'interactive', ds.imBotId);
            }
            break;
          }
          ds.streamCardId = await cb.sessionReply(ds.session.rootMessageId, streamCardJson, 'interactive', ds.imBotId);
        } catch (err) {
          if (cb.isMessageWithdrawn(err)) {
            logger.warn(`[${t}] Root message withdrawn, closing stale session`);
            killWorker(ds);
            cb.closeSession(ds);
            break;
          }
          logger.warn(`[${t}] Failed to send streaming card, falling back to static card: ${err}`);
          // Clear sentinel so screen_updates can create a streaming card later
          ds.streamCardId = undefined;
          // Fallback: send static session card
          try {
            const cardJson = cb.buildSessionCard(
              ds.session.sessionId,
              ds.session.rootMessageId,
              readOnlyUrl,
              ds.session.title || getCliDisplayName(botCfg.cliId),
              botCfg.cliId,
            );
            await cb.sessionReply(ds.session.rootMessageId, cardJson, 'interactive', ds.imBotId);
          } catch (fallbackErr) {
            if (cb.isMessageWithdrawn(fallbackErr)) {
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
        ds.lastScreenContent = msg.content;
        ds.lastScreenStatus = msg.status;

        // Non-streaming IM: only send final output on first idle, skip everything else
        if (ds.nonStreamingIm) {
          if (msg.status === 'idle' && !ds.finalOutputSent) {
            ds.finalOutputSent = true;
            const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
            const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);
            const cardJson = cb.buildStreamingCard(
              ds.session.sessionId, ds.session.rootMessageId, readUrl, turnTitle,
              msg.content, 'idle', botCfg.cliId, ds.streamExpanded, ds.streamCardNonce,
            );
            if (cardJson) {
              cb.sessionReply(ds.session.rootMessageId, cardJson, 'interactive', ds.imBotId)
                .catch(err => logger.debug(`[${t}] Failed to send final output: ${err}`));
            }
          }
          // Reset finalOutputSent when a new turn starts (worker receives new input)
          break;
        }

        const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(botCfg.cliId);

        if (ds.streamCardPending || !ds.streamCardId) {
          // If a POST is already in-flight, drop this update — it will be
          // picked up by subsequent screen_updates once the card ID lands.
          if (ds.streamCardId === CARD_POSTING_SENTINEL) break;

          // New turn — create a fresh card, old card freezes at its last state.
          // Generate new nonce so old card buttons are distinguishable.
          ds.streamCardNonce = randomBytes(4).toString('hex');
          const cardJson = cb.buildStreamingCard(
            ds.session.sessionId,
            ds.session.rootMessageId,
            readUrl,
            turnTitle,
            msg.content,
            msg.status,
            botCfg.cliId,
            ds.streamExpanded,
            ds.streamCardNonce,
          );
          // Empty card JSON = non-streaming IM, skip sending
          if (!cardJson) break;
          // Mark POST in-flight so subsequent screen_updates are dropped,
          // not POSTed as duplicate cards.
          ds.streamCardPending = false;
          ds.streamCardId = CARD_POSTING_SENTINEL;
          cb.sessionReply(ds.session.rootMessageId, cardJson, 'interactive', ds.imBotId)
            .then(msgId => { ds.streamCardId = msgId; })
            .catch(err => {
              if (cb.isMessageWithdrawn(err)) {
                logger.warn(`[${t}] Root message withdrawn, closing stale session`);
                killWorker(ds);
                cb.closeSession(ds);
                return;
              }
              logger.debug(`[${t}] Failed to create streaming card: ${err}`);
              ds.streamCardId = undefined;
            });
        } else {
          // Same turn — queue PATCH (serialized, latest-wins), reuse existing nonce
          const cardJson = cb.buildStreamingCard(
            ds.session.sessionId,
            ds.session.rootMessageId,
            readUrl,
            turnTitle,
            msg.content,
            msg.status,
            botCfg.cliId,
            ds.streamExpanded,
            ds.streamCardNonce,
          );
          if (cardJson) scheduleCardPatch(ds, cardJson);
        }
        break;
      }

      case 'claude_exit': {
        logger.info(`[${t}] ${getCliDisplayName(botCfg.cliId)} exited (code: ${msg.code}, signal: ${msg.signal})`);
        ds.hasHistory = true;

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
            const frozenCard = cb.buildStreamingCard(
              ds.session.sessionId, ds.session.rootMessageId, readUrl, turnTitle,
              ds.lastScreenContent ?? '', 'idle', botCfg.cliId, ds.streamExpanded, ds.streamCardNonce,
            );
            scheduleCardPatch(ds, frozenCard);
          }
          // Kill the worker process to free resources
          killWorker(ds);
          const cliName = getCliDisplayName(botCfg.cliId);
          try {
            await cb.sessionReply(ds.session.rootMessageId, `⚠️ ${cliName} 在 1 分钟内崩溃 ${rc.count} 次，已停止自动重启。发消息可触发重新启动。`, 'text', ds.imBotId);
          } catch (replyErr) {
            if (cb.isMessageWithdrawn(replyErr)) {
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
    }
  });

  worker.on('exit', (code) => {
    logger.info(`[${t}] Worker process exited (code: ${code})`);
    ds.worker = null;
    ds.workerPort = null;
  });

  ds.worker = worker;
  ds.spawnedAt = Date.now();
  ds.cliVersion = currentCliVersion;
  sessionStore.updateSessionPid(ds.session.sessionId, worker.pid ?? null);
  logger.info(`[${t}] Worker forked (pid: ${worker.pid}, active: ${cb.getActiveCount()})`);
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
