/**
 * Worker pool — manages forking, killing, and lifecycle of worker processes.
 * Extracted from daemon.ts for modularity.
 */
import { fork } from 'node:child_process';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import { updateMessage } from '../im/lark/client.js';
import { buildStreamingCard, buildSessionCard } from '../im/lark/card-builder.js';
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
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string) => Promise<string>;
  getSessionWorkingDir: (ds?: DaemonSession) => string;
  getActiveCount: () => number;
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
      SESSION_DATA_DIR: config.session.dataDir,
      // LARK_APP_ID/SECRET come from worker process env at runtime
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

  ensureMcpConfig(botCfg.cliId, botCfg.cliPathOverride);

  const worker = fork(workerPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
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

        // Send streaming card to group thread (read-only link, will be PATCHed with live output)
        try {
          const initTitle = ds.currentTurnTitle || ds.session.title || 'Claude Code';
          const streamCardJson = buildStreamingCard(
            ds.session.sessionId,
            ds.session.rootMessageId,
            readOnlyUrl,
            initTitle,
            '',
            'starting',
            botCfg.cliId,
            ds.streamExpanded,
          );
          ds.streamCardId = await cb.sessionReply(ds.session.rootMessageId, streamCardJson, 'interactive', ds.larkAppId);
        } catch (err) {
          logger.warn(`[${t}] Failed to send streaming card, falling back to static card: ${err}`);
          // Fallback: send static session card
          const cardJson = buildSessionCard(
            ds.session.sessionId,
            ds.session.rootMessageId,
            readOnlyUrl,
            ds.session.title || 'Claude Code',
            botCfg.cliId,
          );
          await cb.sessionReply(ds.session.rootMessageId, cardJson, 'interactive', ds.larkAppId);
        }

        break;
      }

      case 'prompt_ready': {
        logger.info(`[${t}] Claude is ready for input`);
        break;
      }

      case 'screen_update': {
        if (!ds.workerPort) break;
        ds.lastScreenContent = msg.content;
        ds.lastScreenStatus = msg.status;
        const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
        const turnTitle = ds.currentTurnTitle || ds.session.title || 'Claude Code';
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          ds.session.rootMessageId,
          readUrl,
          turnTitle,
          msg.content,
          msg.status,
          botCfg.cliId,
          ds.streamExpanded,
        );

        if (ds.streamCardPending || !ds.streamCardId) {
          // New turn — create a fresh card, old card freezes at its last state
          ds.streamCardPending = false;
          cb.sessionReply(ds.session.rootMessageId, cardJson, 'interactive', ds.larkAppId)
            .then(msgId => { ds.streamCardId = msgId; })
            .catch(err => logger.debug(`[${t}] Failed to create streaming card: ${err}`));
        } else {
          // Same turn — PATCH existing card
          updateMessage(ds.larkAppId, ds.streamCardId, cardJson).catch(err => {
            logger.debug(`[${t}] Failed to update streaming card: ${err}`);
            ds.streamCardId = undefined;
          });
        }
        break;
      }

      case 'claude_exit': {
        logger.info(`[${t}] Claude exited (code: ${msg.code}, signal: ${msg.signal})`);
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
          logger.warn(`[${t}] Claude crashed ${rc.count} times in 1 min, not auto-restarting`);
          // Kill the worker process to free resources
          killWorker(ds);
          await cb.sessionReply(ds.session.rootMessageId, `⚠️ Claude 在 1 分钟内崩溃 ${rc.count} 次，已停止自动重启。发消息可触发重新启动。`, 'text', ds.larkAppId);
          break;
        }

        // Auto-restart Claude within the same worker
        if (ds.worker && !ds.worker.killed) {
          logger.info(`[${t}] Auto-restarting Claude...`);
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
  ds.claudeVersion = currentClaudeVersion;
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
      logger.info(`Killing stale Claude process (pid: ${session.pid}, session: ${session.sessionId})`);
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
      // Multi-bot or same CLI_ID: clean orphaned tmux sessions not in active set
      const activeNames = new Set(
        activeSessions_.map(s => TmuxBackend.sessionName(s.sessionId)),
      );
      for (const name of TmuxBackend.listBotmuxSessions()) {
        if (!activeNames.has(name)) {
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

// ─── Claude version (shared with daemon) ────────────────────────────────────

/** Current CLI version, kept in sync by daemon via setCurrentClaudeVersion(). */
let currentClaudeVersion = 'unknown';

export function setCurrentClaudeVersion(v: string): void {
  currentClaudeVersion = v;
}

export function getCurrentClaudeVersion(): string {
  return currentClaudeVersion;
}
