import { execFileSync, type ChildProcess } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, watch, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { config } from './config.js';
import { statSync } from 'node:fs';
import { getChatMode, replyMessage, resolveAllowedUsersWithMap, sendMessage, updateMessage } from './im/lark/client.js';
import { loadBotConfigs, registerBot, getBot, getAllBots, findOncallChatForAnyBot, type BotState, type OncallChat } from './bot-registry.js';
import * as sessionStore from './services/session-store.js';
import * as chatFirstSeenStore from './services/chat-first-seen-store.js';
import { autoBindOncallFromDefault } from './services/oncall-store.js';
import * as scheduleStore from './services/schedule-store.js';
import * as messageQueue from './services/message-queue.js';
import { parseEventMessage, resolveNonsupportMessage, stripLeadingMentions, type MessageResource } from './im/lark/message-parser.js';
import { expandMergeForward } from './im/lark/merge-forward.js';
import { buildQuoteHint } from './im/lark/quote-hint.js';
import { logger } from './utils/logger.js';
import { checkAllowedChatGroupsConfig } from './services/allowed-chat-groups.js';
import { ensureCjkFontsInstalled } from './utils/font-installer.js';
import { invalidWorkingDirs } from './utils/working-dir.js';
import type { DaemonToWorker, LarkMessage } from './types.js';
export type { DaemonSession } from './core/types.js';
import type { DaemonSession } from './core/types.js';
import { sessionKey, sessionAnchorId } from './core/types.js';
import type { CliId } from './adapters/cli/types.js';
import * as scheduler from './core/scheduler.js';
import { scanProjects, scanMultipleProjects } from './services/project-scanner.js';
import { buildRepoSelectCard, buildStreamingCard, getCliDisplayName } from './im/lark/card-builder.js';
import { t as tr, botLocale, localeForBot } from './i18n/index.js';
import { createCliAdapterSync } from './adapters/cli/registry.js';
import {
  initWorkerPool,
  setActiveSessionsRegistry,
  forkWorker,
  killWorker,
  scheduleCardPatch,
  setCurrentCliVersion,
  getCurrentCliVersion,
  CARD_POSTING_SENTINEL,
  parkStreamCard,
  closeSession as closeSessionHelper,
  ensureCliEnv,
  writableTerminalLinkFor,
} from './core/worker-pool.js';
import { ipcRoute, jsonRes, readJsonBody, setBotName, setLarkAppId, startIpcServer } from './core/dashboard-ipc-server.js';
import { saveFrozenCards, deleteFrozenCards } from './services/frozen-card-store.js';
import { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS, handleCommand, parseSlashCommandInvocation, parseForceTopicInvocation } from './core/command-handler.js';
import type { CommandHandlerDeps } from './core/command-handler.js';
import { findInheritablePeer } from './core/inherit-peer.js';
import { isCallbackUrl, handleCallbackUrl } from './utils/user-token.js';
import {
  getSessionWorkingDir,
  getProjectScanDir,
  getProjectScanDirs,
  expandHome,
  downloadResources,
  formatAttachmentsHint,
  buildNewTopicPrompt,
  buildFollowUpContent,
  buildBridgeInputContent,
  buildReforkPrompt,
  getAvailableBots,
  restoreActiveSessions,
  executeScheduledTask,
  persistStreamCardState,
  rememberLastCliInput,
} from './core/session-manager.js';
import { handleCardAction } from './im/lark/card-handler.js';
import type { CardHandlerDeps } from './im/lark/card-handler.js';
import {
  executeWorkflowCommand,
  resolveBotSnapshot,
  type WorkflowCommandResult,
} from './im/lark/workflow-slash-command.js';
import { workflowRunDetailUrl } from './im/lark/workflow-cards.js';
import {
  buildWorkflowStartingCard,
  buildWorkflowProgressCard,
  buildAttemptDeeplinkEnricher,
} from './im/lark/workflow-progress-card.js';
import { EventLog as WorkflowEventLog } from './workflows/events/append.js';
import { replay as replayWorkflow } from './workflows/events/replay.js';
import { isBotMentioned, probeBotOpenId, startLarkEventDispatcher, writeBotInfoFile, canOperate, isKnownPeerBot, checkRequiredScopes, type RoutingContext } from './im/lark/event-dispatcher.js';
import { learnFromMentions, resolveSender, flushIdentityCacheSync } from './im/lark/identity-cache.js';
import { renderSenderTag } from './core/session-manager.js';
import { markSessionActivity } from './core/session-activity.js';
import { WorkflowEventWatcher, handleWorkflowFanoutEvent } from './workflows/fanout.js';
import type { WorkflowRuntimeContext, WorkerSpawnFn } from './workflows/runtime.js';
import { runLoop } from './workflows/loop.js';
import type { RunLoopResult } from './workflows/loop.js';
import { createWorkflowDaemonSpawn } from './workflows/daemon-spawn.js';
import { createDaemonSpawnFn } from './workflows/spawn-bot.js';
import { attachColdWorkflowRunsForDaemon } from './workflows/cold-attach.js';
import { getRunsDir } from './workflows/runs-dir.js';
import { loadEffectInputSidecar } from './workflows/effect-input.js';
import { isValidWorkflowId } from './workflows/catalog.js';
import { triggerWorkflowRun } from './workflows/trigger-run.js';
import type { RawParamInput } from './workflows/params.js';
import type { AbortCancelReason } from './workflows/runtime.js';
import {
  createDefaultHostExecutorRegistry,
  createDefaultProviderReconcilers,
} from './workflows/hostExecutors/registry.js';
import {
  cancelWorkflowRun,
  guardWorkflowRunCancelChatScope,
  isTerminalRunStatus,
} from './workflows/cancel-run.js';
import { requestCancel } from './workflows/cancel.js';
import { resolveWait } from './workflows/wait.js';
import { replay } from './workflows/events/replay.js';
import { isValidRunId, readRunSnapshot } from './workflows/ops-projection.js';
import { AttemptResumeManager } from './workflows/attempt-resume.js';
import {
  setCardDispatcher as setAskCardDispatcher,
  registerAsk as registerAskBroker,
} from './core/ask-broker.js';
import { parseAskBody, resolveAskApprovers } from './core/ask-api.js';
import { createLarkAskCardDispatcher } from './im/lark/ask-card.js';

// ─── State ───────────────────────────────────────────────────────────────────

const activeSessions = new Map<string, DaemonSession>();
const workflowEventWatchers = new Map<string, WorkflowEventWatcher>();
/**
 * Per-run state for active workflow loops.
 *
 * `aborters` is published by runLoop each tick so that
 * `cancelWorkflowRunOnDaemon` can fire AbortControllers immediately when
 * a cancel request arrives (v0.1.4-a).  `cancelling` deduplicates
 * concurrent cancel calls — if a second cancel comes in while we're
 * still finalizing the first, it awaits the in-flight finalize instead
 * of re-firing.
 */
type CancelOnDaemonOk = {
  ok: true;
  runId: string;
  status: string;
  alreadyTerminal: boolean;
  cancelEventId?: string;
  loopReason?: string;
  pending?: boolean;
  lastSeq: number;
};
const workflowRuns = new Map<string, {
  ctx: WorkflowRuntimeContext;
  running?: Promise<RunLoopResult>;
  aborters?: Map<string, AbortController>;
  cancelling?: Promise<CancelOnDaemonOk>;
}>();
// v0.1.5 slice 1: run-level progress card index.  daemon-internal only
// (codex contract boundary 2: daemon restart drops the cardMessageId
// and we accept losing card updates for that run — the dashboard link
// inside any prior card still works).
const workflowRunCards = new Map<string, {
  cardMessageId: string;
  larkAppId: string;
  chatId: string;
  /**
   * Per-runId update-promise chain.  fanout events arrive faster than
   * `updateMessage` finishes, so multiple `updateWorkflowProgressCard`
   * calls race — the older snapshot's PATCH can land AFTER the newer
   * one's, overwriting `red` (failed) with `blue` (still-running).
   * Chain so each update awaits the previous one's PATCH before
   * reading the log + sending its own.
   */
  updateChain: Promise<void>;
}>();
const workflowAttemptResumes = new AttemptResumeManager({
  runsDir: getRunsDir(),
  externalHost: config.web.externalHost,
  resolveBot: (larkAppId, terminal) => {
    try {
      const bot = getBot(larkAppId);
      return {
        larkAppId: bot.config.larkAppId,
        larkAppSecret: bot.config.larkAppSecret,
        cliId: terminal.cliId ?? bot.config.cliId,
        cliPathOverride: bot.config.cliPathOverride,
        backendType: bot.config.backendType,
        botName: bot.botName ?? terminal.botName,
        botOpenId: bot.botOpenId,
        locale: botLocale(bot.config),
      };
    } catch {
      return undefined;
    }
  },
});
// Cache last /repo scan results per chat for /repo <number> fallback
const lastRepoScan = new Map<string, import('./services/project-scanner.js').ProjectInfo[]>();
const cliVersionCache = new Map<string, { version: string; lastCheckAt: number }>();
const VERSION_CHECK_INTERVAL = 60_000; // cache 1 min

function parsePositiveIntEnv(name: string): number {
  const raw = process.env[name];
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(`[memdiag] ignoring invalid ${name}=${JSON.stringify(raw)}`);
    return 0;
  }
  return Math.floor(parsed);
}

function formatMiB(bytes: number | undefined): string {
  if (!Number.isFinite(bytes)) return 'n/a';
  return `${((bytes ?? 0) / 1024 / 1024).toFixed(1)}MiB`;
}

function summarizeActiveResources(): string {
  if (typeof process.getActiveResourcesInfo !== 'function') return 'unavailable';
  const counts = new Map<string, number>();
  for (const name of process.getActiveResourcesInfo()) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return 'none';
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 16)
    .map(([name, count]) => `${name}:${count}`)
    .join(',');
}

function logMemoryDiagnostics(reason: string): void {
  const usage = process.memoryUsage();
  const external = usage.external ?? 0;
  const arrayBuffers = usage.arrayBuffers ?? 0;
  const nativeOther = Math.max(0, usage.rss - usage.heapTotal - external);
  logger.info(
    `[memdiag] reason=${reason} ` +
    `rss=${formatMiB(usage.rss)} ` +
    `heapUsed=${formatMiB(usage.heapUsed)} ` +
    `heapTotal=${formatMiB(usage.heapTotal)} ` +
    `external=${formatMiB(external)} ` +
    `arrayBuffers=${formatMiB(arrayBuffers)} ` +
    `nativeOther~=${formatMiB(nativeOther)} ` +
    `activeSessions=${activeSessions.size} ` +
    `workflowRuns=${workflowRuns.size} ` +
    `workflowWatchers=${workflowEventWatchers.size} ` +
    `resources=${summarizeActiveResources()}`,
  );
}

function startMemoryDiagnostics(): ReturnType<typeof setInterval> | undefined {
  const intervalMs = parsePositiveIntEnv('BOTMUX_MEMORY_DIAG_INTERVAL_MS');
  if (!intervalMs) return undefined;
  logger.info(`[memdiag] enabled intervalMs=${intervalMs}`);
  logMemoryDiagnostics('startup');
  const timer = setInterval(() => logMemoryDiagnostics('interval'), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * Reply into a session — scope-aware.
 *
 * `anchor` is whatever the caller has at hand:
 *   - thread-scope sessions → rootMessageId
 *   - chat-scope sessions  → chatId
 *
 * Behaviour:
 *   - thread-scope (or no matching DS, the legacy default) → reply with
 *     reply_in_thread=true to the anchor message_id
 *   - chat-scope                                           → send a plain
 *     message to ds.chatId (no reply, no thread). Cards / button values
 *     embed the chatId so handleCardAction can route back into the same
 *     session.
 *
 * Lark message ids start with `om_` and chat ids with `oc_`, so the two
 * address spaces never collide; the lookup just tries both.
 */
async function sessionReply(anchor: string, content: string, msgType: string = 'text', larkAppId?: string): Promise<string> {
  let ds: DaemonSession | undefined;
  if (larkAppId) {
    ds = activeSessions.get(sessionKey(anchor, larkAppId));
  } else {
    for (const s of activeSessions.values()) {
      if (sessionAnchorId(s) === anchor) { ds = s; break; }
    }
  }
  const appId = larkAppId ?? ds?.larkAppId ?? getAllBots()[0]?.config.larkAppId;
  if (!appId) throw new Error('No bot configured');

  // Chat-scope: post a plain message to the chat. No reply_in_thread → keeps
  // the conversation flat in 普通群. The card layer carries chatId in its button
  // values, so handleCardAction routes back via sessionKey(chatId).
  //
  // If a 普通群 is converted to a 话题群 while this chat-scope session is alive,
  // a top-level sendMessage would create a brand-new topic for every reply.
  // Force-refresh chat_mode at dispatch time and fall back to the session's
  // original triggering message as the thread anchor.
  //
  // Detect chat-scope from either ds.scope or anchor's `oc_` prefix. The
  // prefix fallback covers the close-button race: card-handler deletes ds
  // from activeSessions BEFORE sending the close-confirmation reply, so by
  // the time we run, ds is gone — but the anchor (chatId, oc_xxx) is enough
  // to know we should sendMessage, not reply_in_thread to a non-message-id.
  if (ds?.scope === 'chat' || anchor.startsWith('oc_')) {
    const chatId = ds?.chatId ?? anchor;
    if (ds?.scope === 'chat' && ds.session.rootMessageId) {
      const mode = await getChatMode(appId, chatId, { forceRefresh: true });
      if (mode === 'topic') {
        logger.warn(`[routing] Chat-scope session ${ds.session.sessionId.substring(0, 8)} is now topic-mode; replying in original thread ${ds.session.rootMessageId.substring(0, 12)}`);
        return replyMessage(appId, ds.session.rootMessageId, content, msgType, true);
      }
    }
    return sendMessage(appId, chatId, content, msgType);
  }

  // Thread-scope (or unknown / legacy): reply in thread.
  return replyMessage(appId, anchor, content, msgType, true);
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

// ─── Daemon descriptor (dashboard registry) ─────────────────────────────────
// Each per-bot daemon publishes a self-descriptor JSON at
// ~/.botmux/data/dashboard-daemons/<larkAppId>.json so the dashboard sibling
// process can discover all running daemons. The file is touched every 30s as
// a heartbeat (mtime drives offline detection) and removed on graceful exit.

const DAEMON_REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');

interface DaemonDescriptor {
  larkAppId: string;
  botName: string;
  botIndex: number;
  ipcPort: number;
  pid: number;
  startedAt: number;
  lastHeartbeat: number;
  /**
   * Resolved open_ids from this bot's allowedUsers config (post-email
   * resolution). Surfaced so the dashboard's create-group flow can pick a
   * creator whose app scope contains the operator. Emails stripped so dashboard
   * never sees them; empty if the bot has no allowlist configured.
   */
  resolvedAllowedUsers: string[];
}

function writeDaemonDescriptor(d: DaemonDescriptor): void {
  mkdirSync(DAEMON_REGISTRY_DIR, { recursive: true });
  const fp = join(DAEMON_REGISTRY_DIR, `${d.larkAppId}.json`);
  writeFileSync(fp, JSON.stringify(d), { mode: 0o600 });
}

function removeDaemonDescriptor(larkAppId: string): void {
  const fp = join(DAEMON_REGISTRY_DIR, `${larkAppId}.json`);
  if (existsSync(fp)) {
    try { unlinkSync(fp); } catch { /* ignore */ }
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

export function attachWorkflowEventWatcher(runId: string, ctx?: WorkflowRuntimeContext): WorkflowEventWatcher {
  if (ctx) {
    // v0.1.4-a: wire registerAborters so runLoop's per-tick AbortController
    // map is reachable from `cancelWorkflowRunOnDaemon` without having to
    // poll the EventLog.  Wrap idempotently — if the caller already set
    // one, prefer ours so the workflowRuns entry stays the source of truth.
    ctx.registerAborters = (aborters) => {
      const entry = workflowRuns.get(runId);
      if (!entry) return;
      if (aborters) entry.aborters = aborters;
      else delete entry.aborters;
    };
    const existingRun = workflowRuns.get(runId);
    workflowRuns.set(runId, { ...existingRun, ctx });
  }
  const existing = workflowEventWatchers.get(runId);
  if (existing) return existing;
  const watcher = new WorkflowEventWatcher(
    runId,
    async (event) => {
      // Progress card refresh is best-effort and runs first so a stale
      // card never hangs around through approval / terminal events.
      // Errors are swallowed inside updateWorkflowProgressCard.
      await updateWorkflowProgressCard(runId);
      await handleWorkflowFanoutEvent(event);
    },
    {
      onError: (err) => logger.warn(
        `[workflow:${runId}] fanout failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    },
  );
  workflowEventWatchers.set(runId, watcher);
  watcher.ready.catch((err) => {
    workflowEventWatchers.delete(runId);
    logger.warn(
      `[workflow:${runId}] watcher failed to start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  return watcher;
}

async function driveWorkflowRun(runId: string): Promise<RunLoopResult> {
  const entry = workflowRuns.get(runId);
  if (!entry) {
    throw new Error(`workflow runtime context not registered: ${runId}`);
  }
  if (entry.running) return entry.running;

  entry.running = runLoop(entry.ctx)
    .then(async (result) => {
      logger.info(`[workflow:${runId}] loop stopped: ${result.reason} (ticks=${result.ticks})`);
      if (result.reason === 'terminal') {
        // Codex round 1 blocker: patch the final card BEFORE cleanup deletes
        // the cardMessageId, otherwise the watcher's drain may run too late
        // and the user is stuck looking at a "running" tile forever.
        await updateWorkflowProgressCard(runId);
        cleanupWorkflowRun(runId);
      }
      return result;
    })
    .catch((err) => {
      logger.warn(`[workflow:${runId}] loop failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    })
    .finally(() => {
      const current = workflowRuns.get(runId);
      if (current) current.running = undefined;
    });

  return entry.running;
}

function cleanupWorkflowRun(runId: string): void {
  workflowRuns.delete(runId);
  workflowRunCards.delete(runId);
  const watcher = workflowEventWatchers.get(runId);
  if (watcher) {
    watcher.close();
    workflowEventWatchers.delete(runId);
  }
}

/**
 * v0.1.5 slice 1: progress card update path.
 *
 * Replay the run's EventLog → build a fresh card JSON → PATCH the
 * previously-sent message.  Failure is logged at warn and swallowed —
 * codex contract boundary 1: workflow runtime semantics must never
 * depend on Feishu PATCH succeeding.
 *
 * Called after every event the fanout watcher sees, BEFORE handing the
 * event off to handleWorkflowFanoutEvent (so an approval card landing
 * doesn't race the progress card's "waiting" state).
 */
async function updateWorkflowProgressCard(runId: string): Promise<void> {
  const card = workflowRunCards.get(runId);
  if (!card) return;
  // Chain on the previous update so two fanout-triggered updates can't
  // race and PATCH out of order (which manifests as the card briefly
  // flipping back to an older state, e.g. red → blue after a failed
  // run).  Each call awaits the predecessor's PATCH to land first.
  const next = card.updateChain.then(async () => {
    // Re-fetch the card entry — it may have been GC'd between when
    // we were enqueued and when our turn came (e.g. terminal cleanup
    // ran while we were waiting).
    const current = workflowRunCards.get(runId);
    if (!current) return;
    try {
      const log = new WorkflowEventLog(runId, getRunsDir());
      const snapshot = replayWorkflow(await log.readAll());
      // Pull node count from the live workflow definition if we still
      // hold a runtime context for this run — `snapshot.nodes` only
      // contains TRIGGERED nodes so its size grows as the run
      // progresses and gives a misleading "X / Y" fraction otherwise.
      // (e.g. 1/2 when first node fires → 2/3 at end on a 3-node wf).
      const runtimeEntry = workflowRuns.get(runId);
      const totalNodes = runtimeEntry?.ctx.def?.nodes
        ? Object.keys(runtimeEntry.ctx.def.nodes).length
        : undefined;
      const cardJson = buildWorkflowProgressCard(snapshot, {
        // v0.1.5 slice 3: hand the per-row "查看当前终端" link to the
        // dashboard deeplink contract codex set up in slice 2 (3335adc).
        enrichWithTerminalLink: buildAttemptDeeplinkEnricher(runId, snapshot),
        totalNodes,
      });
      await updateMessage(current.larkAppId, current.cardMessageId, cardJson);
    } catch (err) {
      logger.warn(
        `[workflow:${runId}] progress card update failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
  card.updateChain = next;
  await next;
}

async function cancelWorkflowRunOnDaemon(
  runId: string,
  reason: string,
  opts: { expectedChatId?: string; by?: string } = {},
): Promise<{
  ok: true;
  runId: string;
  status: string;
  alreadyTerminal: boolean;
  cancelEventId?: string;
  loopReason?: string;
  pending?: boolean;
  lastSeq: number;
} | {
  ok: false;
  error: string;
  status?: string;
}> {
  if (!isValidRunId(runId)) return { ok: false, error: 'bad_run_id' };

  if (opts.expectedChatId) {
    const scope = await guardWorkflowRunCancelChatScope(getRunsDir(), runId, opts.expectedChatId);
    if (!scope.ok) return scope;
  }

  const entry = workflowRuns.get(runId);
  if (entry?.running) {
    const snapshot = replay(await entry.ctx.log.readAll());
    if (isTerminalRunStatus(snapshot.run.status)) {
      return {
        ok: true,
        runId,
        status: snapshot.run.status,
        alreadyTerminal: true,
        lastSeq: snapshot.lastSeq,
      };
    }
    // Dedup concurrent cancel calls (codex round 3 M1).  The first caller
    // synchronously assigns `entry.cancelling` BEFORE any await so a
    // second caller arriving mid-flight sees the in-flight promise and
    // returns the same result instead of re-writing `cancelRequested` or
    // re-firing aborters.
    if (entry.cancelling) {
      return await entry.cancelling;
    }
    const cancelling = startRunningCancel(entry, runId, reason, opts.by ?? 'dashboard');
    entry.cancelling = cancelling;
    cancelling.catch((err) => {
      logger.warn(
        `[workflow:${runId}] cancel foreground failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }).finally(() => {
      const e = workflowRuns.get(runId);
      if (e && e.cancelling === cancelling) delete e.cancelling;
    });
    return await cancelling;
  }

  const current = workflowRuns.get(runId);
  if (!current) {
    const snapshot = await readRunSnapshot(getRunsDir(), runId);
    if (!snapshot) return { ok: false, error: 'unknown_run' };
    if (isTerminalRunStatus(snapshot.run.status)) {
      return {
        ok: true,
        runId,
        status: snapshot.run.status,
        alreadyTerminal: true,
        lastSeq: snapshot.lastSeq,
      };
    }
    return { ok: false, error: 'workflow_not_attached', status: snapshot.run.status };
  }

  const result = await cancelWorkflowRun({
    ctx: current.ctx,
    reason,
    by: opts.by ?? 'dashboard',
    actor: 'human',
    maxTicks: 200,
  });
  if (isTerminalRunStatus(result.snapshot.run.status)) {
    await updateWorkflowProgressCard(runId);
    cleanupWorkflowRun(runId);
  }
  return {
    ok: true,
    runId,
    status: result.snapshot.run.status,
    alreadyTerminal: result.alreadyTerminal,
    cancelEventId: result.cancelEventId,
    loopReason: result.loopResult?.reason,
    lastSeq: result.snapshot.lastSeq,
  };
}

/**
 * Foreground portion of the running-cancel chain (v0.1.4-a, codex round 3 M1).
 *
 * Returns the API response object the caller surfaces to the dashboard /
 * IM caller.  Synchronously starts a background task that awaits the
 * running loop draining and then drives `cancelWorkflowRun` to finalize
 * the cancel chain (cancelDelivered → activityCanceled → nodeCanceled →
 * runCanceled).
 *
 * The function is wrapped in an IIFE'd async closure by the caller and
 * assigned to `entry.cancelling` BEFORE awaiting it, so that a
 * concurrent second cancel call sees the in-flight promise and dedupes
 * onto it instead of re-writing `cancelRequested` or re-firing
 * aborters.
 */
async function startRunningCancel(
  entry: { ctx: WorkflowRuntimeContext; running?: Promise<RunLoopResult>; aborters?: Map<string, AbortController> },
  runId: string,
  reason: string,
  by: string,
): Promise<CancelOnDaemonOk> {
  const snapshot = replay(await entry.ctx.log.readAll());
  if (isTerminalRunStatus(snapshot.run.status)) {
    return {
      ok: true,
      runId,
      status: snapshot.run.status,
      alreadyTerminal: true,
      cancelEventId: snapshot.cancelledRunIntent?.cancelOriginEventId,
      lastSeq: snapshot.lastSeq,
    };
  }

  // 1) Write `cancelRequested` if not already present.
  let cancelEventId = snapshot.cancelledRunIntent?.cancelOriginEventId;
  if (!cancelEventId) {
    const cancel = await requestCancel(
      entry.ctx.log,
      { target: { kind: 'run', runId }, reason, by },
      'human',
    );
    cancelEventId = cancel.eventId;
  }

  // 2) Fire all in-flight dispatch aborters so workers stop ASAP instead
  //    of waiting for the EventLog 200ms polling fallback.
  if (entry.aborters && entry.aborters.size > 0) {
    const abortReason: AbortCancelReason = { cancelOriginEventId: cancelEventId };
    for (const ac of entry.aborters.values()) {
      if (!ac.signal.aborted) ac.abort(abortReason);
    }
  }

  // 3) Fire-and-forget background finalize: await the running loop, then
  //    drive `cancelWorkflowRun` to terminate the run.  Idempotent so a
  //    redundant invocation (e.g. via a separate cold-attach path) is
  //    safe — replay short-circuits on already-terminal.
  void (async () => {
    try {
      await entry.running?.catch(() => {});
    } finally {
      const current = workflowRuns.get(runId);
      if (current) {
        try {
          const result = await cancelWorkflowRun({
            ctx: current.ctx,
            reason,
            by,
            actor: 'human',
            maxTicks: 200,
          });
          if (isTerminalRunStatus(result.snapshot.run.status)) {
            await updateWorkflowProgressCard(runId);
            cleanupWorkflowRun(runId);
          }
        } catch (err) {
          logger.warn(
            `[workflow:${runId}] cancel finalize failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  })();

  const after = replay(await entry.ctx.log.readAll());
  return {
    ok: true,
    runId,
    status: after.run.status,
    alreadyTerminal: false,
    cancelEventId,
    loopReason: 'already-running',
    pending: true,
    lastSeq: after.lastSeq,
  };
}

/**
 * Result shape for dashboard-side approve/reject — uniform `{ ok, error,
 * hint?, message? }` failure envelope as agreed with codex so the dashboard
 * UI only has to render `hint ?? message ?? error`.
 */
type ResolveDashboardWaitResult =
  | {
      ok: true;
      runId: string;
      resolution: 'approved' | 'rejected';
      activityId: string;
      attemptId: string;
      resolvedAt: number;
      lastSeq: number;
      /** True when the run was already terminal before this call (idempotent). */
      alreadyTerminal?: boolean;
      /** True when the resolveWait wrote but driveWorkflowRun hasn't
       *  finished propagating downstream nodes yet. */
      pending?: boolean;
    }
  | {
      ok: false;
      error:
        | 'bad_run_id'
        | 'unknown_run'
        | 'workflow_not_attached'
        | 'no_open_wait'
        | 'ambiguous_wait'
        | 'needs_lark_approval'
        | 'internal_error';
      hint?: string;
      message?: string;
      status?: string;
    };

async function resolveDashboardWait(
  runId: string,
  resolution: 'approved' | 'rejected',
  comment: string | undefined,
): Promise<ResolveDashboardWaitResult> {
  if (!isValidRunId(runId)) return { ok: false, error: 'bad_run_id' };

  const entry = workflowRuns.get(runId);
  if (!entry) {
    const snapshot = await readRunSnapshot(getRunsDir(), runId);
    if (!snapshot) return { ok: false, error: 'unknown_run' };
    if (isTerminalRunStatus(snapshot.run.status)) {
      // Treat as benign idempotent success — the wait was already resolved
      // by an earlier action (Lark card, CLI, or this dashboard).
      return {
        ok: true,
        runId,
        resolution,
        activityId: '',
        attemptId: '',
        resolvedAt: snapshot.updatedAt,
        lastSeq: snapshot.lastSeq,
        alreadyTerminal: true,
      };
    }
    return {
      ok: false,
      error: 'workflow_not_attached',
      status: snapshot.run.status,
      hint: 'Run not attached to this daemon (perhaps still cold). Try again shortly or check daemon logs.',
    };
  }

  const events = await entry.ctx.log.readAll();
  const snapshot = replay(events);
  const updatedAt = events[events.length - 1]?.timestamp ?? Date.now();
  if (isTerminalRunStatus(snapshot.run.status)) {
    return {
      ok: true,
      runId,
      resolution,
      activityId: '',
      attemptId: '',
      resolvedAt: updatedAt,
      lastSeq: snapshot.lastSeq,
      alreadyTerminal: true,
    };
  }

  // Find the unique pending human-gate wait.  Other wait kinds (time /
  // condition) aren't approvable through this dashboard route; restricting
  // to human-gate matches codex's API contract and keeps the surface tight.
  // `approvers` lives on the original waitCreated event payload, not on
  // replay state — pull it from there so we don't reshape replay AttemptState
  // for a single auth check.
  const waitEventsByActivity = new Map<string, { approvers?: string[] }>();
  for (const ev of events) {
    if (ev.type !== 'waitCreated') continue;
    const p = ev.payload as { activityId?: string; approvers?: unknown };
    if (typeof p.activityId !== 'string') continue;
    const approvers = Array.isArray(p.approvers)
      ? p.approvers.filter((x): x is string => typeof x === 'string')
      : undefined;
    // Last waitCreated for the activity wins (re-create case).
    waitEventsByActivity.set(p.activityId, { approvers });
  }

  const candidates: Array<{ activityId: string; attemptId: string; approvers?: string[] }> = [];
  for (const activityId of snapshot.danglingWaits) {
    const activity = snapshot.activities.get(activityId);
    const at = activity?.attempts[activity.attempts.length - 1];
    if (!at?.wait || at.wait.waitKind !== 'human-gate') continue;
    candidates.push({
      activityId,
      attemptId: at.attemptId,
      approvers: waitEventsByActivity.get(activityId)?.approvers,
    });
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      error: 'no_open_wait',
      hint: 'No pending humanGate wait on this run.',
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: 'ambiguous_wait',
      hint:
        `Run has ${candidates.length} pending humanGate waits; dashboard cannot ` +
        `pick one yet. Use the Lark approval card.`,
    };
  }
  const target = candidates[0]!;
  // approvers allowlist non-empty → preserve restricted-approval semantics.
  // Dashboard cookie auth doesn't carry user identity, so we don't try to
  // satisfy the allowlist from this path — defer to the Lark card.
  // Read approvers from the wait state (we stashed it on the candidate).
  if ((target.approvers?.length ?? 0) > 0) {
    return {
      ok: false,
      error: 'needs_lark_approval',
      hint:
        'This gate has an approver allowlist; the Lark approval card is the ' +
        'only path that authenticates the approver identity.',
    };
  }

  try {
    const resolved = await resolveWait(
      entry.ctx.log,
      {
        activityId: target.activityId,
        attemptId: target.attemptId,
        resolution,
        by: 'dashboard',
        comment,
      },
      // v0.2: pass def so resolveWait can write activitySucceeded for
      // `decision` node reject instead of activityFailed.  entry.ctx.def
      // is the live, in-memory snapshot already loaded for this run.
      { def: entry.ctx.def },
    );
    const after = replay(await entry.ctx.log.readAll());
    // Fire-and-forget re-drive — same pattern as Lark card path
    // (workflowApprovalResolved hook).  Don't await; the dashboard caller
    // only needs the wait resolution to be persisted before responding.
    driveWorkflowRun(runId).catch((err) => {
      logger.warn(
        `[workflow:${runId}] re-entry after dashboard approval failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });
    logger.info(
      `[workflow:${runId}] wait ${target.activityId}/${target.attemptId} resolved=${resolution} via dashboard`,
    );
    return {
      ok: true,
      runId,
      resolution,
      activityId: target.activityId,
      attemptId: target.attemptId,
      resolvedAt: resolved.resolutionEvent.timestamp,
      lastSeq: after.lastSeq,
      pending: !isTerminalRunStatus(after.run.status),
    };
  } catch (err) {
    return {
      ok: false,
      error: 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function attachColdWorkflowRuns(ownerLarkAppId: string): Promise<void> {
  const runsDir = getRunsDir();
  try {
    const result = await attachColdWorkflowRunsForDaemon({
      runsDir,
      ownerLarkAppId,
      isAttached: (runId) => workflowRuns.has(runId),
      makeContext: (run, log) => ({
        log,
        def: run.def,
        spawnSubagent: workflowSpawnFn(),
        hostExecutors: createDefaultHostExecutorRegistry(),
        reconcilers: createDefaultProviderReconcilers(),
        loadEffectInput: (activityId, attemptId) =>
          loadEffectInputSidecar(log, activityId, attemptId),
      }),
      attachWatcher: (runId, ctx) => attachWorkflowEventWatcher(runId, ctx),
      driveRun: (runId) => driveWorkflowRun(runId),
      onSkip: (runId, reason) => logger.debug(`[workflow:${runId}] cold-scan skipped: ${reason}`),
      onAttached: (run) => {
        logger.info(
          `[workflow:${run.runId}] cold-attached status=${run.snapshot.run.status} ` +
            `danglingEffects=${run.snapshot.danglingEffectAttempted.length} ` +
            `danglingWaits=${run.snapshot.danglingWaits.length}`,
        );
      },
      onDriveError: (runId, err) => {
        logger.warn(
          `[workflow:${runId}] cold-scan drive failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    });
    if (result.discovered === 0) {
      logger.info(`[workflow] cold-scan: no active runs for ${ownerLarkAppId}`);
    }
  } catch (err) {
    logger.warn(
      `[workflow] cold-scan failed for ${ownerLarkAppId}; continuing daemon startup: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Build the daemon-backed WorkerSpawnFn lazily.  We avoid touching
 * bot-registry at module-init time (it isn't loaded yet); each call
 * resolves credentials by the workflow node's `bot` name, falling
 * back to the IM larkAppId if the bot rename hasn't propagated.
 *
 * Multi-daemon: each process registers only its own bot in memory, but
 * workflow subagent nodes may target sibling bots (e.g. coco/aiden) that
 * live in other daemon processes. The shared bots.json is the source of
 * truth across daemons, so we fall back to it when the in-memory
 * registry misses.
 */
function workflowSpawnFn(): WorkerSpawnFn {
  const daemonDeps = createWorkflowDaemonSpawn({
    resolveLarkCredentials: (botName) => {
      const bot = getAllBots().find(
        (b) => b.config.name === botName || b.botName === botName || b.config.larkAppId === botName,
      );
      if (bot) {
        return {
          larkAppId: bot.config.larkAppId,
          larkAppSecret: bot.config.larkAppSecret,
        };
      }
      const siblingConfigs = loadBotConfigs();
      const sibling = siblingConfigs.find(
        (c) => c.name === botName || c.larkAppId === botName,
      );
      if (!sibling) {
        throw new Error(`workflow: bot '${botName}' not found in registry`);
      }
      return {
        larkAppId: sibling.larkAppId,
        larkAppSecret: sibling.larkAppSecret,
      };
    },
  });
  return createDaemonSpawnFn(daemonDeps);
}

async function handleWorkflowCommandIfAny(
  content: string,
  anchor: string,
  chatId: string,
  larkAppId: string,
  initiator: string | undefined,
): Promise<boolean> {
  // Captured by the `onRunCreated` closure so the trailing text reply can be
  // suppressed when the run-level progress card already landed.  Codex
  // round 1 medium: "single self-updating tile" promise breaks if we also
  // dump a `Workflow loop stopped: …` line at the end.
  let startingCardSent = false;
  const result = await executeWorkflowCommand(
    {
      content,
      chatId,
      larkAppId,
      initiator: initiator ?? 'unknown',
    },
    {
      attachWorkflowEventWatcher,
      spawnSubagent: workflowSpawnFn(),
      runLoopFn: (ctx) => driveWorkflowRun(ctx.log.runId),
      cancelWorkflowRunFn: (runId, reason, opts) => cancelWorkflowRunOnDaemon(runId, reason, opts),
      onRunCreated: async (info) => {
        // v0.1.5 slice 1: send the run-level progress card so the user
        // sees a single self-updating tile.  Best-effort: if the card
        // send fails we still fall back to a plain-text "started"
        // reply so they at least see the runId.
        try {
          const cardJson = buildWorkflowStartingCard({
            runId: info.runId,
            workflowId: info.workflowId,
          });
          const cardMessageId = await sessionReply(anchor, cardJson, 'interactive', larkAppId);
          if (chatId) {
            workflowRunCards.set(info.runId, {
              cardMessageId,
              larkAppId,
              chatId,
              updateChain: Promise.resolve(),
            });
          }
          startingCardSent = true;
        } catch (err) {
          logger.warn(
            `[workflow:${info.runId}] failed to send progress card (falling back to text): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          try {
            await sessionReply(
              anchor,
              `Workflow started: ${info.workflowId}\nrunId: ${info.runId}\nWeb: ${workflowRunDetailUrl(info.runId)}`,
              'text',
              larkAppId,
            );
          } catch (fallbackErr) {
            logger.warn(
              `[workflow:${info.runId}] failed to send start reply: ${
                fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
              }`,
            );
          }
        }
      },
    },
  );
  if (!result.handled) return false;

  if (!result.ok) {
    await sessionReply(
      anchor,
      `Workflow 命令失败：${result.error}${result.usage ? `\n${result.usage}` : ''}`,
      'text',
      larkAppId,
    );
    return true;
  }

  // Skip the trailing text echo only for `run` commands whose progress card
  // landed — the card already shows status/runId/web link, and the card
  // patch path covers final state.  `cancel` keeps the text since cancel
  // doesn't drive `onRunCreated` and may target a card-less run.
  if (result.command === 'run' && startingCardSent) {
    return true;
  }

  await sessionReply(anchor, formatWorkflowCommandResult(result), 'text', larkAppId);
  return true;
}

function formatWorkflowCommandResult(result: Extract<WorkflowCommandResult, { ok: true }>): string {
  if (result.command === 'cancel') {
    if (result.alreadyTerminal) {
      return `Workflow already terminal: ${result.status}\nrunId: ${result.runId}`;
    }
    if (result.pending) {
      return `Workflow cancel requested; waiting for running activity to drain.\nrunId: ${result.runId}\nstatus: ${result.status}`;
    }
    return `Workflow cancel processed.\nrunId: ${result.runId}\nstatus: ${result.status}`;
  }
  const status =
    result.loopResult.reason === 'awaiting-wait'
      ? '等待审批'
      : result.loopResult.reason;
  const next =
    result.loopResult.reason === 'awaiting-wait'
      ? '\n请在群里查看审批卡，点击后 workflow 会继续执行。'
      : '';
  return `Workflow loop stopped: ${status}\nrunId: ${result.runId}${next}`;
}

function getActiveCount(): number {
  let count = 0;
  for (const [, ds] of activeSessions) {
    if (ds.worker && !ds.worker.killed) count++;
  }
  return count;
}

/**
 * Freeze the previous turn's streaming card at "idle" and mark a new turn so the
 * next screen_update from the worker POSTs a fresh streaming card instead of
 * PATCH-ing the previous one. Shared by the normal-message path and the
 * passthrough slash-command path (/model, /clear, /compact, etc.) — without
 * this, passthrough commands silently PATCH the previous card and the user
 * sees no visible response.
 */
function beginNewTurn(ds: DaemonSession, title: string): void {
  const previousUsageLimit = ds.usageLimit;
  const previousStatus = ds.lastScreenStatus === 'limited' && previousUsageLimit ? 'limited' : 'idle';
  if (ds.streamCardId && ds.workerPort) {
    const readUrl = `http://${config.web.externalHost}:${ds.workerPort}`;
    const dsBotCfg = getBot(ds.larkAppId).config;
    const prevTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(dsBotCfg.cliId);
    const prevMode = ds.displayMode ?? 'hidden';
    const frozenCard = buildStreamingCard(
      ds.session.sessionId, sessionAnchorId(ds), readUrl, prevTitle,
      ds.lastScreenContent ?? '', previousStatus, dsBotCfg.cliId,
      prevMode, ds.streamCardNonce, ds.currentImageKey,
      !!ds.adoptedFrom, false, localeForBot(ds.larkAppId), previousUsageLimit,
      writableTerminalLinkFor(ds),
    );
    scheduleCardPatch(ds, frozenCard);

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
  if (ds.usageLimitRetryTimer) {
    clearTimeout(ds.usageLimitRetryTimer);
    ds.usageLimitRetryTimer = undefined;
  }
  ds.usageLimit = undefined;
  ds.streamCardPending = true;
  ds.currentTurnTitle = title.substring(0, 50);
  ds.currentImageKey = undefined;
  persistStreamCardState(ds);
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
  workflowApprovalResolved: (runId) => {
    driveWorkflowRun(runId).catch((err) => {
      logger.warn(`[workflow:${runId}] re-entry after approval failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  },
};

function dashboardWaitStatus(error: ResolveDashboardWaitResult & { ok: false }): number {
  switch (error.error) {
    case 'bad_run_id': return 400;
    case 'unknown_run': return 404;
    case 'workflow_not_attached': return 409;
    case 'no_open_wait': return 409;
    case 'ambiguous_wait': return 409;
    case 'needs_lark_approval': return 403;
    case 'internal_error': return 500;
  }
}

for (const [path, resolution] of [
  ['/api/workflows/runs/:runId/approve', 'approved'] as const,
  ['/api/workflows/runs/:runId/reject', 'rejected'] as const,
]) {
  ipcRoute('POST', path, async (req, res, params) => {
    let body: { comment?: unknown };
    try {
      body = await readJsonBody<{ comment?: unknown }>(req);
    } catch {
      return jsonRes(res, 400, { ok: false, error: 'bad_json' });
    }
    const comment =
      typeof body.comment === 'string' && body.comment.trim()
        ? body.comment.trim()
        : undefined;
    const result = await resolveDashboardWait(params.runId, resolution, comment);
    if (!result.ok) {
      return jsonRes(res, dashboardWaitStatus(result), result);
    }
    return jsonRes(res, 200, result);
  });
}

function attemptResumeStatus(error: { error: string }): number {
  switch (error.error) {
    case 'bad_run_id':
    case 'bad_attempt_id':
    case 'bad_json':
      return 400;
    case 'no_terminal_sidecar':
    case 'resume_not_running':
      return 404;
    case 'missing_cli_session_id':
    case 'missing_lark_app_id':
    case 'bot_not_registered':
      return 409;
    default:
      return 500;
  }
}

ipcRoute(
  'POST',
  '/api/workflows/runs/:runId/attempts/:activityId/:attemptId/resume',
  async (_req, res, params) => {
    const result = await workflowAttemptResumes.start({
      runId: params.runId,
      activityId: params.activityId,
      attemptId: params.attemptId,
    });
    if (!result.ok) return jsonRes(res, attemptResumeStatus(result), result);
    return jsonRes(res, 200, result);
  },
);

ipcRoute(
  'POST',
  '/api/workflows/runs/:runId/attempts/:activityId/:attemptId/resume/end',
  async (req, res, params) => {
    let body: { reason?: unknown };
    try {
      body = await readJsonBody<{ reason?: unknown }>(req);
    } catch {
      return jsonRes(res, 400, { ok: false, error: 'bad_json' });
    }
    const result = await workflowAttemptResumes.end({
      runId: params.runId,
      activityId: params.activityId,
      attemptId: params.attemptId,
      reason:
        typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim()
          : 'ended_by_dashboard',
    });
    if (!result.ok) return jsonRes(res, attemptResumeStatus(result), result);
    return jsonRes(res, 200, result);
  },
);

ipcRoute('POST', '/api/workflows/runs/:runId/cancel', async (req, res, params) => {
  let body: { reason?: unknown };
  try {
    body = await readJsonBody<{ reason?: string }>(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : 'cancelled via dashboard';
  const result = await cancelWorkflowRunOnDaemon(params.runId, reason);
  if (!result.ok) {
    const status =
      result.error === 'bad_run_id' ? 400 :
        result.error === 'unknown_run' ? 404 :
          result.error === 'workflow_not_attached' ? 409 :
            result.error === 'wrong_chat' ? 403 :
              500;
    return jsonRes(res, status, result);
  }
  return jsonRes(res, 200, result);
});

ipcRoute('POST', '/api/workflows/definitions/:id/run', async (req, res, params) => {
  const workflowId = params.id;
  if (!isValidWorkflowId(workflowId)) {
    return jsonRes(res, 400, { ok: false, error: 'bad_id' });
  }
  let body: { params?: unknown; chatBinding?: unknown };
  try {
    body = await readJsonBody<{ params?: unknown; chatBinding?: unknown }>(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  const chatBinding = parseTriggerChatBinding(body.chatBinding);
  if (!chatBinding) {
    return jsonRes(res, 400, { ok: false, error: 'missing_chat_binding' });
  }
  if (body.params !== undefined) {
    if (typeof body.params !== 'object' || body.params === null || Array.isArray(body.params)) {
      return jsonRes(res, 400, { ok: false, error: 'bad_params_shape' });
    }
  }
  // Convert JSON-channel params (decoded values) into the shared RawParamInput
  // map.  String-channel coercion stays on the IM `/workflow run` path.
  const rawParams: Record<string, RawParamInput> = {};
  for (const [k, v] of Object.entries((body.params as Record<string, unknown> | undefined) ?? {})) {
    rawParams[k] = { kind: 'json', value: v };
  }

  const result = await triggerWorkflowRun(
    {
      workflowId,
      rawParams,
      chatBinding,
      initiator: 'dashboard',
    },
    {
      spawnSubagent: workflowSpawnFn(),
      botResolver: resolveBotSnapshot,
      makeRuntimeContext: (log, def, spawnSubagent) => ({
        log,
        def,
        spawnSubagent,
        hostExecutors: createDefaultHostExecutorRegistry(),
        reconcilers: createDefaultProviderReconcilers(),
        loadEffectInput: (activityId, attemptId) =>
          loadEffectInputSidecar(log, activityId, attemptId),
      }),
      attachRuntime: (runId, ctx) => attachWorkflowEventWatcher(runId, ctx),
      driveRun: (runId) => {
        driveWorkflowRun(runId).catch((err) => {
          logger.warn(
            `[workflow:${runId}] dashboard-trigger drive failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      },
    },
  );
  if (!result.ok) {
    const status =
      result.error === 'unknown_workflow' ? 404 :
        result.error === 'invalid_params' ? 400 :
          500;
    return jsonRes(res, status, result);
  }
  return jsonRes(res, 200, result);
});

// ─── botmux ask v0.1.7 IPC route ─────────────────────────────────────────────
//
// CLI side: `botmux ask buttons --options "..."` POSTs here and keeps the
// connection open until the broker settles the ask. Long keep-alive is OK —
// the request's lifetime is bounded by `body.timeoutMs` which the broker
// enforces. Default fetch on the CLI side has no read timeout.

ipcRoute('POST', '/api/asks', async (req, res) => {
  let raw: unknown;
  try {
    raw = await readJsonBody<unknown>(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  const parsed = parseAskBody(raw);
  if ('error' in parsed) return jsonRes(res, 400, { ok: false, error: parsed.error });

  const approvers = resolveAskApprovers({
    larkAppId: parsed.larkAppId,
    sessionId: parsed.sessionId,
    explicit: parsed.approvers,
    getBotAllowedUsers: (id) => {
      try { return getBot(id).resolvedAllowedUsers; } catch { return []; }
    },
    getSessionOwner: (sid) => {
      for (const ds of activeSessions.values()) {
        if (ds.session.sessionId === sid) return ds.ownerOpenId;
      }
      return undefined;
    },
  });
  if (approvers.size === 0) {
    // Nobody can answer — fail loud rather than registering a
    // guaranteed-timeout. CLI side maps this to exit 2.
    return jsonRes(res, 400, { ok: false, error: 'no_approvers' });
  }

  const result = await registerAskBroker({
    larkAppId: parsed.larkAppId,
    chatId: parsed.chatId,
    rootMessageId: parsed.rootMessageId,
    sessionId: parsed.sessionId,
    approvers,
    questions: parsed.questions,
    timeoutMs: parsed.timeoutMs,
  });
  return jsonRes(res, 200, result);
});

// ─── adopt-session 查询端点 ───────────────────────────────────────────────────
// CLI side（botmux hook）通过祖先 PID 匹配 adopt 会话，路由 askUserQuestion。
// GET /api/adopt-session/:pid — 返回该 pid 对应的 adopt 会话路由信息。
// 仅匹配**当前活跃**的 adopt 会话（按 originalCliPid）。残留风险：OS 的 PID 复用——
// 若原 adopt 的 Claude 已退出、同号 PID 被别的进程复用，理论上可能误命中；但 hook
// 进程是该 Claude 的子孙，只有 Claude 仍在跑时其祖先链里才会出现这个 PID，且 session
// 必须仍在 activeSessions 里，复用窗口极小，可接受（不为此引入进程级鉴权）。
ipcRoute('GET', '/api/adopt-session/:pid', (_req, res, params) => {
  const pid = Number(params.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return jsonRes(res, 400, { ok: false, error: 'bad_pid' });
  }
  for (const ds of activeSessions.values()) {
    if (ds.adoptedFrom?.originalCliPid === pid) {
      return jsonRes(res, 200, {
        sessionId: ds.session.sessionId,
        chatId: ds.chatId,
        larkAppId: ds.larkAppId,
        rootMessageId: sessionAnchorId(ds),
      });
    }
  }
  return jsonRes(res, 404, { ok: false, error: 'no_adopt_session' });
});

function parseTriggerChatBinding(
  raw: unknown,
): { chatId: string; larkAppId: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as { chatId?: unknown; larkAppId?: unknown };
  if (typeof r.chatId !== 'string' || !r.chatId.trim()) return undefined;
  if (typeof r.larkAppId !== 'string' || !r.larkAppId.trim()) return undefined;
  return { chatId: r.chatId.trim(), larkAppId: r.larkAppId.trim() };
}

// ─── Event handling ──────────────────────────────────────────────────────────

/**
 * Default-oncall is a uniform forward-only policy: whenever the toggle is
 * on, ANY chat the bot is currently in — old or newly added, doesn't matter —
 * gets auto-bound to the configured workingDir on its next observed topic,
 * unless it's already bound (`findOncallChatForAnyBot` upstream) or the user
 * has opted out via tombstone.
 *
 * Returns the binding entry on success, undefined when any precondition
 * fails or the lock-internal authoritative check (in `autoBindOncallFromDefault`)
 * sees a concurrent tombstone / existing binding.
 */
async function maybeAutoBindDefaultOncall(
  larkAppId: string,
  chatId: string,
  chatType: 'group' | 'p2p',
): Promise<OncallChat | undefined> {
  if (chatType !== 'group') return undefined; // oncall is group-only by design
  const bot = getBot(larkAppId);
  const def = bot.config.defaultOncall;
  if (!def?.enabled || !def.workingDir) return undefined;

  // Fast-path tombstone check against the in-memory snapshot — avoids taking
  // the lock when we already know we'd skip. The AUTHORITATIVE re-check lives
  // inside autoBindOncallFromDefault under the file lock, so a race with a
  // concurrent unbind (which writes the tombstone) is still safe.
  const autobound = bot.config.defaultOncallAutoboundChats ?? [];
  if (autobound.includes(chatId)) return undefined;

  // Validate workingDir at fire time too — directory might have been
  // deleted/moved since the dashboard save validated it. Skipping (vs.
  // crashing) lets the user fix the path without losing other bot config.
  const resolved = expandHome(def.workingDir);
  let isDir = false;
  try { isDir = statSync(resolved).isDirectory(); } catch { /* not a dir */ }
  if (!isDir) {
    logger.warn(
      `[${larkAppId}] defaultOncall workingDir invalid (${resolved}); ` +
      `skipping auto-bind for chat=${chatId}`,
    );
    return undefined;
  }

  const r = await autoBindOncallFromDefault(larkAppId, chatId, def.workingDir);
  if (!r.ok) {
    logger.warn(`[${larkAppId}] defaultOncall auto-bind failed: chat=${chatId} reason=${r.reason}`);
    return undefined;
  }
  if (r.skipped) {
    // Lock-internal authoritative check disagreed with our fast-path —
    // tombstone or binding raced in. Fine, just don't surface a binding.
    logger.info(`[${larkAppId}] defaultOncall auto-bind skipped chat=${chatId} reason=${r.skipped}`);
    return undefined;
  }
  logger.info(
    `[${larkAppId}] defaultOncall auto-bound chat=${chatId} → ${def.workingDir}`,
  );
  return r.entry;
}

/**
 * Resolve this bot's `defaultWorkingDir` for a new-topic spawn, if any.
 * Unlike `defaultOncall`, this is a pure runtime fallback: no state is
 * written to bots.json and the chat is NOT bound to oncall (so the
 * permission model stays unchanged). `/cd <path>` can still switch the
 * working dir mid-session; the next new topic falls back to this default.
 *
 * Returns the expanded path when the configured field points to a real
 * directory; logs and returns undefined when the path is missing/invalid
 * so the caller falls through to the repo-select card instead of
 * spawning into a bad cwd.
 */
function resolveBotDefaultWorkingDir(larkAppId: string): string | undefined {
  const raw = getBot(larkAppId).config.defaultWorkingDir;
  if (!raw) return undefined;
  const resolved = expandHome(raw);
  try {
    if (statSync(resolved).isDirectory()) return resolved;
  } catch { /* not a dir */ }
  logger.warn(
    `[${larkAppId}] defaultWorkingDir invalid (${resolved}); ` +
    `falling back to repo-select card`,
  );
  return undefined;
}

/**
 * Resolve the pinned working dir for a brand-new topic via the layered lookup:
 *   1) an existing oncall binding (this bot or a sibling)
 *   2) this bot's defaultOncall — auto-binds a brand-new chat when the flag is on
 *      (this WRITES state, so it must run identically on every spawn path)
 *   3) a sibling session's workingDir (cross-bot / chat-scope inheritance)
 *   4) this bot's `defaultWorkingDir` (pure runtime fallback)
 * Returns the dir plus the oncall / inherited source so callers can log the reason.
 * Shared by the normal spawn path and the first-message `/repo` command branch so
 * both honor the defaultOncall auto-bind the same way.
 */
async function resolvePinnedWorkingDir(ctx: {
  scope: 'thread' | 'chat';
  anchor: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  larkAppId: string;
}) {
  let oncallEntry = findOncallChatForAnyBot(ctx.chatId);
  if (!oncallEntry) {
    oncallEntry = await maybeAutoBindDefaultOncall(ctx.larkAppId, ctx.chatId, ctx.chatType);
  }
  const inheritedFrom = !oncallEntry
    ? findInheritablePeer({ scope: ctx.scope, anchor: ctx.anchor, chatId: ctx.chatId, chatType: ctx.chatType, selfAppId: ctx.larkAppId })
    : null;
  const botDefaultWorkingDir = (!oncallEntry && !inheritedFrom)
    ? resolveBotDefaultWorkingDir(ctx.larkAppId)
    : undefined;
  const pinnedWorkingDir = oncallEntry?.workingDir ?? inheritedFrom?.workingDir ?? botDefaultWorkingDir;
  return { pinnedWorkingDir, oncallEntry, inheritedFrom };
}

async function replyInvalidWorkingDirs(
  anchor: string,
  larkAppId: string,
  ds: DaemonSession,
): Promise<boolean> {
  const bot = getBot(larkAppId);
  const invalid = invalidWorkingDirs({
    workingDir: ds.workingDir ?? bot.config.workingDir ?? '~',
    workingDirs: ds.workingDir ? undefined : bot.config.workingDirs,
  });
  if (invalid.length === 0) return false;

  ds.pendingRepo = false;
  activeSessions.delete(sessionKey(anchor, larkAppId));
  sessionStore.closeSession(ds.session.sessionId);
  const msg = tr('cmd.repo.working_dir_not_exist', {
    dirs: invalid.map(d => `\`${d}\``).join(', '),
  }, localeForBot(larkAppId));
  await sessionReply(anchor, msg, 'text', larkAppId);
  logger.warn(`[${tag(ds)}] configured workingDir missing: ${invalid.join(', ')}`);
  return true;
}

async function handleNewTopic(data: any, ctx: RoutingContext): Promise<void> {
  const { chatId, messageId, chatType, larkAppId } = ctx;
  // scope/anchor are mutable here: `/t` / `/topic` may flip a 普通群 chat-scope
  // routing into thread-scope so the bot's first reply seeds a Lark thread.
  let scope = ctx.scope;
  let anchor = ctx.anchor;
  await resolveNonsupportMessage(data, larkAppId);
  const { parsed, resources } = parseEventMessage(data);

  // Expand merge_forward: fetch sub-messages and collect their resources
  if (parsed.msgType === 'merge_forward') {
    const { extraResources } = await expandMergeForward(larkAppId, messageId, parsed);
    resources.push(...extraResources);
  }

  // Free-path identity learning — mentions carry (name, open_id) pairs, so
  // every event that flows through us teaches the cache without touching
  // the contact API. Must run before any await on the sender resolver.
  learnFromMentions(larkAppId, parsed.mentions);

  let content = parsed.content.trim();
  // Strip leading @<bot> mentions so "@bot /oncall bind" is recognized as a command.
  let cmdContent = stripLeadingMentions(content, parsed.mentions);

  // `/t` / `/topic` — force the bot to reply in a thread, even in 普通群.
  // In 普通群 the inbound message is chat-scope by default; override to
  // thread-scope anchored at the user's message_id so sessionReply() uses
  // reply_in_thread=true and seeds a fresh Lark thread. In 话题群 / p2p
  // (already thread-scope) it's just a prefix strip — no routing change.
  // Empty prompt is allowed: the user can fill it in while the repo card is
  // pending (pendingFollowUps in handleThreadReply picks up subsequent text).
  const forceTopic = parseForceTopicInvocation(cmdContent);
  if (forceTopic) {
    if (scope === 'chat') {
      scope = 'thread';
      anchor = messageId;
    }
    content = forceTopic.prompt;
    parsed.content = forceTopic.prompt;
    cmdContent = forceTopic.prompt;
    logger.info(`[/t] Force-topic invocation: prompt="${forceTopic.prompt.substring(0, 60)}" (scope=${scope}, anchor=${anchor.substring(0, 12)})`);
  }

  const senderOpenId: string | undefined = data.sender?.sender_id?.open_id;
  const senderUnionId: string | undefined = data.sender?.sender_id?.union_id;
  const botCfg = getBot(larkAppId).config;
  logger.info(`New session: "${content.substring(0, 60)}" (scope=${scope}, anchor=${anchor.substring(0, 12)}, resources: ${resources.length}, active: ${getActiveCount()}, messageId: ${messageId}, chatId: ${chatId})`);

  if (await handleWorkflowCommandIfAny(cmdContent, anchor, chatId, larkAppId, senderOpenId)) {
    return;
  }

  // Intercept daemon commands in new topics (no session needed for some commands)
  const invocation = parseSlashCommandInvocation(cmdContent);
  if (invocation) {
    const { cmd, content: commandContent } = invocation;
    if (PASSTHROUGH_COMMANDS.has(cmd)) {
      await sessionReply(anchor, tr('daemon.cmd_requires_session', { cmd }, localeForBot(larkAppId)), 'text', larkAppId);
      return;
    }
    if (DAEMON_COMMANDS.has(cmd)) {
      // Daemon commands (incl. /oncall) ALWAYS require canOperate, in every chat.
      // No-op for allowedUsers (they pass canOperate anyway); the point is to deny
      // chat-granted users (who only pass canTalk) management commands like
      // /cd /restart /oncall bind. Previously this gate only fired in oncall chats,
      // which left a hole once per-chat grants flow through canTalk.
      if (!canOperate(larkAppId, chatId, senderOpenId)) {
        await sessionReply(anchor, tr('daemon.cmd_allowed_users_only', { cmd }, localeForBot(larkAppId)), 'text', larkAppId);
        return;
      }
      // Same rootMessageId reasoning as below in the main spawn path:
      // thread-scope MUST anchor on the thread root or sessionAnchorId() will
      // disagree with activeSessions's key and downstream card buttons silently
      // break. Chat-scope keeps the inbound messageId as audit only.
      const cmdRootIdForStore = scope === 'thread' ? anchor : messageId;
      const session = sessionStore.createSession(chatId, cmdRootIdForStore, cmdContent.substring(0, 50), chatType);
      const now = Date.now();
      session.larkAppId = larkAppId;
      session.ownerOpenId = senderOpenId;
      session.ownerUnionId = senderUnionId;
      session.lastCallerOpenId = senderOpenId;
      session.lastMessageAt = new Date(now).toISOString();
      session.scope = scope;

      // First-message `/repo`: seed the same pending-repo state the card flow
      // uses, so the `/repo` handler launches the CLI straight away —
      // `/repo <arg>` in that repo, bare `/repo` in the default workingDir —
      // instead of taking the mid-session close+recreate path or re-showing the
      // card. Use the SAME pinned-dir resolver as the normal spawn path (incl.
      // defaultOncall auto-bind) so a bound/auto-bound chat still launches in the
      // right place when no arg is given.
      let cmdPending: Partial<DaemonSession> | undefined;
      if (cmd === '/repo') {
        const { pinnedWorkingDir } = await resolvePinnedWorkingDir({ scope, anchor, chatId, chatType, larkAppId });
        if (pinnedWorkingDir) session.workingDir = pinnedWorkingDir;
        // pendingPrompt is empty (the message *is* the command), so the CLI just
        // boots and waits for the user's next message; no sender tag needed.
        cmdPending = { pendingRepo: true, pendingPrompt: '', workingDir: pinnedWorkingDir };
      }
      sessionStore.updateSession(session);
      activeSessions.set(sessionKey(anchor, larkAppId), {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        larkAppId,
        chatId,
        chatType,
        scope,
        spawnedAt: Date.parse(session.createdAt) || now,
        cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
        lastMessageAt: now,
        hasHistory: false,
        ownerOpenId: senderOpenId,
        ...cmdPending,
      });
      // Pass mention-stripped content so /command argument parsing works.
      await handleCommand(cmd, anchor, { ...parsed, content: commandContent }, commandDeps, larkAppId);
      return;
    }
  }

  // Download attachments
  const { attachments, needLogin } = await downloadResources(larkAppId, messageId, resources);
  if (attachments.length > 0) {
    parsed.attachments = attachments;
  }
  if (needLogin) {
    sessionReply(anchor, tr('daemon.download_failed_need_login', undefined, localeForBot(larkAppId)), 'text', larkAppId);
  }

  // First-turn quote-reply: when the user @s the bot via Lark's "quote" UI as
  // the very first interaction (no active session yet), the same hint that
  // handleThreadReply prepends needs to ride along here too. Without it, the
  // bot never learns about the quoted message_id and `botmux quoted` is dead
  // weight on first turns. `content` (post force-topic-strip) is what the
  // worker will see; promptContent wraps it for prompt-building paths but
  // leaves `content` untouched for title / log substring uses.
  const promptContent = buildQuoteHint(parsed, scope, anchor) + content;

  // Resolve sender identity for <sender> tag injection. The first call to
  // resolveSender for an unseen open_id may await contact.v3.user.get with a
  // short budget; subsequent calls hit the cache and are sync-fast.
  const newTopicSender = await resolveSender(larkAppId, senderOpenId, parsed.senderType);

  refreshCliVersion(botCfg.cliId, botCfg.cliPathOverride);

  // Create session in pending-repo state — don't spawn CLI yet.
  // For thread-scope, rootMessageId == anchor (the thread root). Critical
  // because sessionAnchorId() uses rootMessageId for thread-scope, and the
  // session card's button payload (value.root_id) flows from there back into
  // activeSessions.get(sessionKey(rootId, larkAppId)) — if rootMessageId is
  // the inbound message_id instead of the thread root, every restart/close/
  // disconnect click silently no-ops.
  // For chat-scope, rootMessageId stores the seed message_id (audit only);
  // routing keys off chatId via sessionAnchorId(), so any value works.
  const rootIdForStore = scope === 'thread' ? anchor : messageId;
  const session = sessionStore.createSession(chatId, rootIdForStore, parsed.content.substring(0, 50), chatType);
  const now = Date.now();
  session.larkAppId = larkAppId;
  session.ownerOpenId = senderOpenId;
  session.ownerUnionId = senderUnionId;
  session.lastCallerOpenId = senderOpenId;
  // First turn of a brand-new topic: seed quoteTarget* so the very first
  // `botmux send` can --mention-back / 引用 the triggering message (chat scope).
  // Without this the first reply hits hasQuoteTargetSender=false (exit 2) and
  // chat-scope首条不引用. Use the event's sender open_id (correct app scope).
  session.quoteTargetId = parsed.messageId;
  session.quoteTargetSenderOpenId = senderOpenId;
  session.quoteTargetSenderIsBot = parsed.senderType === 'app' || parsed.senderType === 'bot';
  session.lastMessageAt = new Date(now).toISOString();
  session.scope = scope;
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(anchor);
  messageQueue.appendMessage(anchor, parsed);

  // Pin the working dir via the layered oncall / inherit / default lookup
  // (auto-binds a defaultOncall chat as a side effect). Shared with the
  // first-message `/repo` command branch so both paths stay consistent.
  const { pinnedWorkingDir, oncallEntry, inheritedFrom } = await resolvePinnedWorkingDir({ scope, anchor, chatId, chatType, larkAppId });
  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId,
    chatType,
    scope,
    spawnedAt: Date.parse(session.createdAt) || now,
    cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
    lastMessageAt: now,
    hasHistory: false,
    pendingRepo: !pinnedWorkingDir,
    pendingPrompt: promptContent,
    pendingAttachments: attachments.length > 0 ? attachments : undefined,
    pendingMentions: parsed.mentions,
    pendingSender: newTopicSender,
    ownerOpenId: senderOpenId,
    currentTurnTitle: content.substring(0, 50),
    workingDir: pinnedWorkingDir,
  };
  if (pinnedWorkingDir) {
    ds.session.workingDir = pinnedWorkingDir;
    sessionStore.updateSession(ds.session);
  }
  activeSessions.set(sessionKey(anchor, larkAppId), ds);

  // Pinned (oncall binding or inherited from sibling bot): spawn CLI immediately.
  if (pinnedWorkingDir) {
    if (await replyInvalidWorkingDirs(anchor, larkAppId, ds)) return;
    const selfBot = getBot(larkAppId);
    const prompt = buildNewTopicPrompt(promptContent, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId }, localeForBot(larkAppId), newTopicSender, { larkAppId, chatId });
    rememberLastCliInput(ds, promptContent, prompt);
    forkWorker(ds, prompt);
    const reason = oncallEntry
      ? `oncall-bound chat ${chatId}`
      : inheritedFrom
      ? `inherited from sibling session ${inheritedFrom.sessionId.substring(0, 8)} (app=${inheritedFrom.larkAppId ?? 'unknown'})`
      : `bot defaultWorkingDir`;
    logger.info(`[${tag(ds)}] ${reason} → workingDir=${pinnedWorkingDir}, skipped repo select`);
    return;
  }

  // Show repo selection card
  if (await replyInvalidWorkingDirs(anchor, larkAppId, ds)) return;
  const scanDirs = getProjectScanDirs(ds).filter(d => existsSync(d));
  let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
  if (scanDirs.length > 0) {
    projects = scanMultipleProjects(scanDirs);
  }
  if (projects.length > 0) {
    lastRepoScan.set(chatId, projects);
    const currentCwd = getSessionWorkingDir(ds);
    const cardJson = buildRepoSelectCard(projects, currentCwd, anchor, localeForBot(larkAppId));
    ds.repoCardMessageId = await sessionReply(anchor, cardJson, 'interactive', larkAppId);
    logger.info(`[${tag(ds)}] Waiting for repo selection (${projects.length} projects)`);
  } else {
    // No projects found — skip repo selection, spawn directly
    ds.pendingRepo = false;
    const selfBot = getBot(larkAppId);
    const prompt = buildNewTopicPrompt(promptContent, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, chatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId }, localeForBot(larkAppId), newTopicSender, { larkAppId, chatId });
    rememberLastCliInput(ds, promptContent, prompt);
    forkWorker(ds, prompt);
    logger.info(`Session ${session.sessionId} ready (no projects to select), total active: ${getActiveCount()}`);
  }
}

/** Reverse-lookup a foreign bot's display name for a sender open_id observed on
 *  this app's WS events. Priority:
 *    1) bot-openids-${larkAppId}.json — per-app cross-ref populated by
 *       updateBotOpenIdCrossRef when @mentions go through us. Open_id is
 *       per-app scoped, so this is the authoritative map for this larkAppId.
 *    2) bots-info.json — fallback for bots not yet in our cross-ref but
 *       registered as botmux peers (matches by their self-reported open_id;
 *       only works when the peer's app id space coincides with ours).
 *  Returns "Bot" if neither lookup hits — keeps the prefix readable rather
 *  than blocking the message.
 */
function lookupForeignBotName(senderOpenId: string, larkAppId: string): string {
  try {
    const fp = join(config.session.dataDir, `bot-openids-${larkAppId}.json`);
    if (existsSync(fp)) {
      const data: Record<string, string> = JSON.parse(readFileSync(fp, 'utf-8'));
      for (const [name, openId] of Object.entries(data)) {
        if (openId === senderOpenId) return name;
      }
    }
  } catch { /* fall through */ }
  try {
    const infoPath = join(config.session.dataDir, 'bots-info.json');
    if (existsSync(infoPath)) {
      const entries: Array<{ larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string }> = JSON.parse(readFileSync(infoPath, 'utf-8'));
      const hit = entries.find(e => e.botOpenId === senderOpenId);
      if (hit) return hit.botName ?? getCliDisplayName(hit.cliId as CliId);
    }
  } catch { /* */ }
  return 'Bot';
}

async function handleThreadReply(data: any, ctx: RoutingContext): Promise<void> {
  const { chatId: ctxChatId, chatType: ctxChatType, scope, anchor, larkAppId } = ctx;
  await resolveNonsupportMessage(data, larkAppId);
  const { parsed, resources } = parseEventMessage(data);

  // Expand merge_forward: fetch sub-messages and collect their resources
  if (parsed.msgType === 'merge_forward') {
    const { extraResources } = await expandMergeForward(larkAppId, parsed.messageId, parsed);
    resources.push(...extraResources);
  }

  learnFromMentions(larkAppId, parsed.mentions);

  // Foreign bot @mention prefix: when sender is another botmux bot，把内容包成
  // [来自 X 的 @mention]\n<原文> 喂给 worker，让 CLI 知道这是另一个 bot 发的——
  // 不是用户直接发的——后续不需要按"对话用户"的方式处理。signal-file 路径
  // 删掉之前由 processBotMentionSignal 拼，现在统一在这里拼。仅影响发给
  // worker 的 prompt 内容，title / 命令解析 / 日志还是用原 parsed.content。
  //
  // 检测策略走双轨：
  //   1) `sender.sender_type === 'app' | 'bot'` —— 飞书事件标注为机器人发送。
  //      'app' 是文档里的常规值；'bot' 是实测中跨 bot @ 卡片消息到接收方时
  //      飞书实际给的值（与 'app' 等价对待，少依赖一次 cross-ref 学习）。
  //   2) sender 的 open_id 在我们本 app 的 cross-ref（bot-openids-<appId>.json）
  //      里能匹配到一个 botmux 同伴名字 —— 兜底覆盖 sender_type 又变其他取值
  //      或者全无的边角情况，前提是之前已通过 @mention 学习链路记录过对方。
  const senderOpenIdForPrefix = parsed.senderId || data?.sender?.sender_id?.open_id;
  const selfBotOpenId = getBot(larkAppId).botOpenId;
  const isBotSenderType = parsed.senderType === 'app' || parsed.senderType === 'bot';
  const isForeignBot =
    !!senderOpenIdForPrefix &&
    senderOpenIdForPrefix !== selfBotOpenId &&
    (isBotSenderType ||
      isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenIdForPrefix));
  const foreignBotName = isForeignBot ? lookupForeignBotName(senderOpenIdForPrefix!, larkAppId) : undefined;
  const botSenderPrefix = isForeignBot
    ? `${tr('daemon.foreign_bot_mention_prefix', { botName: foreignBotName! }, localeForBot(larkAppId))}\n`
    : '';

  const promptContent = buildQuoteHint(parsed, scope, anchor) + botSenderPrefix + parsed.content;
  if (isForeignBot) {
    logger.info(
      `[${larkAppId}] foreign-bot @mention prefix attached: sender=${senderOpenIdForPrefix?.substring(0, 12)} ` +
      `senderType=${parsed.senderType} via=${isBotSenderType ? 'sender_type' : 'cross-ref'}`,
    );
  }

  // resolveSender is deferred until we know the message actually needs prompt
  // injection. callback URLs, daemon commands, and "other bot owns this
  // anchor" all return early; routing them through resolveSender first would
  // tack the 800ms budget onto paths that never see the sender tag. Use the
  // helper below at every actual injection point.
  let threadSenderCached: import('./im/lark/identity-cache.js').ResolvedSender | undefined;
  let threadSenderResolved = false;
  const getThreadSender = async (): Promise<typeof threadSenderCached> => {
    if (threadSenderResolved) return threadSenderCached;
    threadSenderResolved = true;
    threadSenderCached = await resolveSender(
      larkAppId,
      senderOpenIdForPrefix,
      parsed.senderType,
      isForeignBot ? { type: 'bot', name: foreignBotName !== 'Bot' ? foreignBotName : undefined } : undefined,
    );
    return threadSenderCached;
  };

  const content = parsed.content.trim();
  // Strip leading @<bot> mentions so "@bot /restart" is recognized as a command.
  const cmdContent = stripLeadingMentions(content, parsed.mentions);

  // Intercept OAuth callback URLs (from /login flow)
  if (isCallbackUrl(content)) {
    const result = await handleCallbackUrl(content);
    if (result) {
      // Route through sessionReply so chat-scope (普通群) lands as a plain
      // chat message instead of a forced new thread.
      sessionReply(anchor, result, 'text', larkAppId)
        .catch(err => logger.error(`Failed to reply login result: ${err}`));
      return;
    }
  }

  if (await handleWorkflowCommandIfAny(
    cmdContent,
    anchor,
    ctxChatId ?? data?.message?.chat_id,
    larkAppId,
    parsed.senderId || data?.sender?.sender_id?.open_id,
  )) {
    return;
  }

  // Intercept daemon commands
  const invocation = parseSlashCommandInvocation(cmdContent);
  if (invocation) {
    const { cmd, content: commandContent } = invocation;
    if (PASSTHROUGH_COMMANDS.has(cmd)) {
      // 语义边界（刻意保留，非疏漏）：passthrough（/model /clear /compact 等）按
      // “发给 CLI 的对话输入”处理，因此不过下面 DAEMON_COMMANDS 的 oncall
      // canOperate 闸 —— oncall 放行的就是对话输入，canOperate 只管 botmux
      // daemon/card 层操作。副作用：oncall 群里被放行的成员（含外部 bot）能对
      // 已存在的 session 发这些命令（清上下文/换模型，需已有活跃 worker，无法凭空
      // 拉起）。TODO（后续产品决策）：是否把 CLI passthrough 也纳入 canOperate，
      // 收紧到与 daemon 命令同档；这会同时改变真人 oncall 成员的现有行为，应单独评估。
      const ds = activeSessions.get(sessionKey(anchor, larkAppId));
      if (ds?.worker && !ds.worker.killed) {
        // Mark a new turn so the CLI's response to /model, /clear, /compact, etc.
        // shows up as a fresh streaming card instead of silently PATCH-ing the
        // previous turn's card.
        beginNewTurn(ds, commandContent);
        ds.worker.send({ type: 'raw_input', content: commandContent } as DaemonToWorker);
        markSessionActivity(ds);
        logger.info(`[${anchor.substring(0, 12)}] Passthrough ${cmd} → worker`);
      } else {
        sessionReply(anchor, tr('daemon.cmd_needs_active_cli', { cmd }, localeForBot(larkAppId)), 'text', larkAppId);
      }
      return;
    }
    if (DAEMON_COMMANDS.has(cmd)) {
      // canOperate gate for thread-reply daemon commands — required in every chat
      // (see spawn-path gate above). Denies chat-granted users management commands.
      const existingDs = activeSessions.get(sessionKey(anchor, larkAppId));
      const threadChatId = existingDs?.chatId ?? ctxChatId ?? data?.message?.chat_id;
      const threadSenderOpenId = parsed.senderId || data?.sender?.sender_id?.open_id;
      if (!canOperate(larkAppId, threadChatId, threadSenderOpenId)) {
        sessionReply(anchor, tr('daemon.cmd_allowed_users_only', { cmd }, localeForBot(larkAppId)), 'text', larkAppId);
        return;
      }
      // Pass mention-stripped content so /command argument parsing works.
      handleCommand(cmd, anchor, { ...parsed, content: commandContent }, commandDeps, larkAppId);
      return;
    }
  }

  logger.info(`Reply in ${scope}-scope session ${anchor.substring(0, 12)}: ${content.substring(0, 100)} (resources: ${resources.length})`);

  let ds = activeSessions.get(sessionKey(anchor, larkAppId));

  // If another bot already owns this anchor, ignore unmentioned replies here as a
  // second line of defense. Explicit @mentions are still allowed to spin up/take over.
  // For chat-scope: another bot's session in the same chat is keyed by its own chatId.
  // For thread-scope: same rootMessageId may have peer sessions across bots.
  if (!ds) {
    const mentionedThisBot = isBotMentioned(larkAppId, data?.message ?? {}, data?.sender?.sender_id?.open_id);
    const hasOtherBot = [...activeSessions.values()].some(s => {
      if (s.larkAppId === larkAppId) return false;
      if (s.scope === 'chat') return s.chatId === ctxChatId && scope === 'chat';
      return s.session.rootMessageId === anchor;
    });
    if (hasOtherBot && !mentionedThisBot) {
      logger.info(`[${larkAppId}] Ignoring ${scope}-scope ${anchor}; another bot already owns it`);
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
    sessionReply(anchor, tr('daemon.download_failed_need_login', undefined, localeForBot(effectiveAppId)), 'text', effectiveAppId);
  }

  // Update last message time + last caller (used by `botmux send` to address
  // reply cards to whoever triggered this turn — matters in oncall groups
  // where the caller is often not the session owner).
  if (ds) {
    markSessionActivity(ds);
    const callerOpenId = parsed.senderId || data?.sender?.sender_id?.open_id;
    // quoteTargetId changes every inbound message (always a new message_id), so
    // — unlike lastCallerOpenId — persist unconditionally. Powers `botmux send`'s
    // default chat-scope quote chain + --mention-back.
    ds.session.quoteTargetId = parsed.messageId;
    ds.session.quoteTargetSenderOpenId = callerOpenId;
    ds.session.quoteTargetSenderIsBot = isForeignBot;
    if (callerOpenId && ds.session.lastCallerOpenId !== callerOpenId) {
      ds.session.lastCallerOpenId = callerOpenId;
    }
    sessionStore.updateSession(ds.session);
  }

  // If waiting for repo selection, buffer the message and remind user
  if (ds?.pendingRepo) {
    // Enrich content with attachment hints and mention metadata (same as normal send)
    let enriched = attachments.length > 0
      ? `${promptContent}${formatAttachmentsHint(attachments)}`
      : promptContent;
    if (parsed.mentions && parsed.mentions.length > 0) {
      const mentionLines = parsed.mentions.map(m => {
        const idPart = m.openId ? ` → open_id: ${m.openId}` : '';
        return `- @${m.name}${idPart}`;
      });
      enriched += `\n\n${tr('daemon.enriched_mentions_label', undefined, localeForBot(larkAppId))}\n${mentionLines.join('\n')}`;
    }
    // Stamp a buffered follow-up with its own <sender> tag ONLY when it comes
    // from a different user than the first message (ds.pendingSender) — the
    // deferred spawn already carries that sender's <sender> block, and the
    // follow-ups now fold into the same <user_message>, so a same-user tag is
    // pure duplication. A differing sender still gets attributed so the CLI can
    // tell multi-user buffered messages apart after repo selection unlocks.
    const followUpSender = await getThreadSender();
    if (followUpSender?.openId && followUpSender.openId !== ds.pendingSender?.openId) {
      const followUpSenderTag = renderSenderTag(followUpSender);
      if (followUpSenderTag) enriched = `${followUpSenderTag}\n${enriched}`;
    }
    if (!ds.pendingFollowUps) ds.pendingFollowUps = [];
    ds.pendingFollowUps.push(enriched);
    await sessionReply(anchor, tr('daemon.choose_repo_first', undefined, localeForBot(larkAppId)), 'text', larkAppId);
    return;
  }

  // Route to file queue (keyed by anchor: rootMessageId for thread, chatId for chat)
  messageQueue.ensureQueue(anchor);
  messageQueue.appendMessage(anchor, parsed);

  if (!ds) {
    // No active session at this anchor — auto-create. This branch is mostly a
    // safety net; the dispatcher routes here only when isSessionOwner() returns
    // true, but races (between check and execution, or session-closed events)
    // can land us here.
    if (activeSessions.has(sessionKey(anchor, larkAppId))) {
      logger.info(`[${larkAppId}] Session already exists for ${scope}-scope ${anchor}, skipping auto-create`);
      return;
    }

    const autoCreateChatId: string = ctxChatId ?? data?.message?.chat_id ?? '';
    const autoCreateChatType = ctxChatType ?? (data?.message?.chat_type === 'p2p' ? 'p2p' : 'group') as 'group' | 'p2p';
    const botCfg = getBot(larkAppId).config;
    logger.info(`No active session for ${scope}-scope ${anchor}, auto-creating new session...`);
    refreshCliVersion(botCfg.cliId, botCfg.cliPathOverride);
    const senderOId = data.sender?.sender_id?.open_id;
    const senderUId = data.sender?.sender_id?.union_id;
    // For thread-scope: rootMessageId = anchor (real thread root).
    // For chat-scope:   rootMessageId = the message_id that triggered this auto-create
    //                   (used as audit trail; routing key is chatId).
    const rootIdForStore = scope === 'thread' ? anchor : parsed.messageId;
    const session = sessionStore.createSession(autoCreateChatId, rootIdForStore, parsed.content.substring(0, 50), autoCreateChatType);
    const now = Date.now();
    // Bot-started handoff sessions have no human owner; keeping the bot as
    // owner makes daemon-generated footers wake that bot again.
    const ownerOpenId = isForeignBot ? undefined : senderOId;
    const ownerUnionId = isForeignBot ? undefined : senderUId;
    session.larkAppId = larkAppId;
    session.ownerOpenId = ownerOpenId;
    session.ownerUnionId = ownerUnionId;
    session.lastCallerOpenId = senderOId;
    session.quoteTargetId = parsed.messageId;
    session.quoteTargetSenderOpenId = senderOId;
    session.quoteTargetSenderIsBot = isForeignBot;
    session.lastMessageAt = new Date(now).toISOString();
    session.scope = scope;
    sessionStore.updateSession(session);

    // Oncall group: pin working dir from the chat-level binding, even if a
    // sibling bot (running in another daemon) is the one that persisted it.
    // Defaults auto-bind path mirrors handleNewTopic — keep both call sites
    // in sync (this is the auto-create branch that fires when routing lands
    // here without an active session, e.g. chat-scope first-reply paths).
    let oncallEntry = findOncallChatForAnyBot(autoCreateChatId);
    if (!oncallEntry) {
      oncallEntry = await maybeAutoBindDefaultOncall(larkAppId, autoCreateChatId, autoCreateChatType);
    }

    // Cross-bot / chat-scope inheritance — see findInheritablePeer comments.
    const inheritedFrom = !oncallEntry
      ? findInheritablePeer({
          scope,
          anchor,
          chatId: autoCreateChatId,
          chatType: autoCreateChatType,
          selfAppId: larkAppId,
        })
      : null;

    // Last-resort fallback: this bot's `defaultWorkingDir`. See handleNewTopic
    // for the symmetric block — both call sites must stay in sync.
    const botDefaultWorkingDir = (!oncallEntry && !inheritedFrom)
      ? resolveBotDefaultWorkingDir(larkAppId)
      : undefined;

    const pinnedWorkingDir = oncallEntry?.workingDir ?? inheritedFrom?.workingDir ?? botDefaultWorkingDir;
    // Now we know the message will spawn or pend a real session — resolve
    // sender (may await contact API budget) since every downstream branch
    // injects it either into the immediate prompt or stashes it on
    // pendingSender for the deferred spawn.
    const autoCreateSender = await getThreadSender();
    const newDs: DaemonSession = {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId,
      chatId: autoCreateChatId,
      chatType: autoCreateChatType,
      scope,
      spawnedAt: Date.parse(session.createdAt) || now,
      cliVersion: cliVersionCache.get(botCfg.cliId)?.version ?? 'unknown',
      lastMessageAt: now,
      hasHistory: false,
      pendingRepo: !pinnedWorkingDir,
      pendingPrompt: promptContent,
      pendingAttachments: attachments.length > 0 ? attachments : undefined,
      pendingMentions: parsed.mentions,
      pendingSender: autoCreateSender,
      ownerOpenId,
      currentTurnTitle: parsed.content.substring(0, 50),
      workingDir: pinnedWorkingDir,
    };
    if (pinnedWorkingDir) {
      newDs.session.workingDir = pinnedWorkingDir;
      sessionStore.updateSession(newDs.session);
    }
    activeSessions.set(sessionKey(anchor, larkAppId), newDs);

    // Pinned (oncall binding or inherited from peer bot in same thread):
    // spawn CLI immediately, skip repo selection.
    if (pinnedWorkingDir) {
      if (await replyInvalidWorkingDirs(anchor, larkAppId, newDs)) return;
      const selfBot = getBot(larkAppId);
      const prompt = buildNewTopicPrompt(promptContent, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, autoCreateChatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId }, localeForBot(larkAppId), autoCreateSender, { larkAppId, chatId: autoCreateChatId });
      rememberLastCliInput(newDs, promptContent, prompt);
      forkWorker(newDs, prompt);
      const reason = oncallEntry
        ? `oncall-bound chat ${autoCreateChatId}`
        : inheritedFrom
        ? `inherited from peer session ${inheritedFrom.sessionId.substring(0, 8)} (app=${inheritedFrom.larkAppId ?? 'unknown'})`
        : `bot defaultWorkingDir`;
      logger.info(`[${tag(newDs)}] ${reason} → workingDir=${pinnedWorkingDir}, skipped repo select`);
      return;
    }

    // Show repo selection card (same as handleNewTopic)
    if (await replyInvalidWorkingDirs(anchor, larkAppId, newDs)) return;
    const scanDirs2 = getProjectScanDirs(newDs).filter(d => existsSync(d));
    let projects: import('./services/project-scanner.js').ProjectInfo[] = [];
    if (scanDirs2.length > 0) {
      projects = scanMultipleProjects(scanDirs2);
    }
    if (projects.length > 0) {
      lastRepoScan.set(autoCreateChatId, projects);
      const currentCwd = getSessionWorkingDir(newDs);
      const cardJson = buildRepoSelectCard(projects, currentCwd, anchor, localeForBot(larkAppId));
      newDs.repoCardMessageId = await sessionReply(anchor, cardJson, 'interactive', larkAppId);
      logger.info(`[${tag(newDs)}] Waiting for repo selection (${projects.length} projects)`);
    } else {
      // No projects found — skip repo selection, spawn directly
      newDs.pendingRepo = false;
      const selfBot = getBot(larkAppId);
      const prompt = buildNewTopicPrompt(promptContent, session.sessionId, botCfg.cliId, botCfg.cliPathOverride, attachments, parsed.mentions, await getAvailableBots(larkAppId, autoCreateChatId), undefined, { name: selfBot.botName, openId: selfBot.botOpenId }, localeForBot(larkAppId), autoCreateSender, { larkAppId, chatId: autoCreateChatId });
      rememberLastCliInput(newDs, promptContent, prompt);
      forkWorker(newDs, prompt);
    }

    return;
  }

  // Send message to worker via IPC
  if (ds.worker && !ds.worker.killed) {
    const dsBotCfgForMsg = getBot(ds.larkAppId).config;
    // Adopt mode: the adopted CLI is the user's external process and was
    // never injected with botmux's skill / system prompt. Sending it the
    // `<user_message>` / `<botmux_reminder>` / `<session_id>` wrappers
    // surfaces those tags verbatim in its UI (the user reported Codex
    // showing raw XML on every Lark message). Use the bridge raw-input
    // builder for ALL adopt sessions regardless of cliId — transcript
    // harvest (Claude bridge or Codex bridge) handles the reply path
    // out-of-band.
    const isBridge = !!ds.adoptedFrom;
    const selfBot = getBot(ds.larkAppId);
    const msgContent = isBridge
      ? buildBridgeInputContent(promptContent, {
          attachments,
          mentions: parsed.mentions,
          selfMention: { name: selfBot.botName, openId: selfBot.botOpenId },
        })
      : buildFollowUpContent(promptContent, ds.session.sessionId, {
          attachments,
          mentions: parsed.mentions,
          isAdoptMode: false,
          cliId: dsBotCfgForMsg.cliId,
          cliPathOverride: dsBotCfgForMsg.cliPathOverride,
          sender: await getThreadSender(),
          larkAppId,
          chatId: ds.session.chatId,
        });
    beginNewTurn(ds, parsed.content);
    rememberLastCliInput(ds, promptContent, msgContent);
    ds.worker.send({ type: 'message', content: msgContent } as DaemonToWorker);
  } else {
    // Worker not running — re-fork with resume. This is a NEW turn, so drop
    // any restored streaming-card reference; worker_ready will POST a fresh
    // card instead of PATCHing the previous turn's card in place.
    logger.info(`[${tag(ds)}] Worker not running, re-forking...`);
    if (ds.usageLimitRetryTimer) {
      clearTimeout(ds.usageLimitRetryTimer);
      ds.usageLimitRetryTimer = undefined;
    }
    ds.usageLimit = undefined;
    ds.currentTurnTitle = parsed.content.substring(0, 50);
    // The cosmetic freeze step (above) is gated on a live worker. With no
    // worker we just park the current card in frozenCards — the upcoming
    // new POST will recall it. Parking instead of deleting preserves the
    // "old card stays until a new one is live" invariant: if fork /
    // worker_ready / POST fails, the user still sees the previous card.
    parkStreamCard(ds);
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;
    // This is a new turn even though the worker is currently down. Force the
    // first screen_update from the re-forked worker to POST a fresh card and
    // drop any persisted screenshot from the previous turn. Otherwise a stale
    // image_key (for example an old Claude Code frame) can be reused on the
    // new Worker card until the next screenshot upload, which makes a fresh
    // @mention appear to resurrect the wrong CLI UI.
    ds.streamCardPending = true;
    ds.currentImageKey = undefined;
    persistStreamCardState(ds);
    // Wrap the user message in the same `<user_message>` / `<session_id>` /
    // `<botmux_reminder>` envelope as live-worker turns. Without this, the
    // initial prompt that worker queues for the freshly-spawned CLI is the
    // raw user text — the CLI sees no botmux routing context and stops calling
    // `botmux send`, posting answers to its own terminal instead. Hits resume
    // (after /close) and daemon-restart paths; both go through this branch
    // because worker=null at that point.
    const dsBotCfgForFork = getBot(ds.larkAppId).config;
    const selfBot = getBot(ds.larkAppId);
    const wrappedPrompt = buildReforkPrompt(ds, promptContent, {
      attachments,
      mentions: parsed.mentions,
      cliId: dsBotCfgForFork.cliId,
      cliPathOverride: dsBotCfgForFork.cliPathOverride,
      selfMention: { name: selfBot.botName, openId: selfBot.botOpenId },
      sender: await getThreadSender(),
    });
    rememberLastCliInput(ds, promptContent, wrappedPrompt);
    forkWorker(ds, wrappedPrompt, ds.hasHistory);
  }
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
  // 启动即为本 bot 的 CLI 预装环境（skills + askUserQuestion hook + 兜底 skill）。
  // 关键：adopt 路径会跳过 ensureCliSkills，若重启后第一次就是 adopt 一个外部
  // claude 会话，必须保证此时全局 ~/.claude/settings.json 已带 hook——否则"全局
  // hook 适配 adopt"不成立。这里幂等、best-effort，不阻塞启动。
  try { ensureCliEnv(cfg.cliId, cfg.cliPathOverride); }
  catch (err) { logger.warn(`[hook] startup ensureCliEnv failed for ${cfg.cliId}: ${err instanceof Error ? err.message : String(err)}`); }
  sessionStore.init(cfg.larkAppId);
  chatFirstSeenStore.init(cfg.larkAppId);
  // Watch schedules.json for external writes (e.g. `botmux schedule add`
  // running in a separate node process) so dashboard event bus stays in sync.
  scheduleStore.startExternalWriteWatcher();
  logger.info(`Bot ${idx}/${botConfigs.length}: ${cfg.larkAppId} (cli: ${cfg.cliId})`)
  setAskCardDispatcher(createLarkAskCardDispatcher());

  writePidFile();
  const memoryDiagnostics = startMemoryDiagnostics();

  // Publish self-descriptor for the dashboard registry. The dashboard sibling
  // process discovers running daemons by scanning ~/.botmux/data/dashboard-daemons/
  // and watching for mtime updates (heartbeat) / file removal (shutdown).
  const ipcPort = config.dashboard.ipcBasePort + idx;
  const desc: DaemonDescriptor = {
    larkAppId: cfg.larkAppId,
    botName: cfg.larkAppId,
    botIndex: idx,
    ipcPort,
    pid: process.pid,
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    // Strip email-form entries — the dashboard only needs resolved open_ids,
    // and the email→open_id resolution below will rewrite this field.
    resolvedAllowedUsers: getBot(cfg.larkAppId).resolvedAllowedUsers.filter(u => !u.includes('@')),
  };
  // Initialise worker pool with daemon callbacks
  initWorkerPool({
    sessionReply,
    getSessionWorkingDir,
    getActiveCount,
    closeSession(ds: DaemonSession) {
      // Route through the dashboard-aware helper so session.exited / session.update
      // events fire for withdrawn-message / crash / adopt-exit teardown paths too,
      // matching the dashboard-driven close.
      void closeSessionHelper(ds.session.sessionId).catch(() => { /* idempotent */ });
      logger.info(`[${ds.session.sessionId.substring(0, 8)}] Session auto-closed (message withdrawn)`);
    },
  });
  // Expose the activeSessions Map (owned by daemon) to worker-pool readers,
  // so dashboard IPC and other consumers can list/lookup live sessions.
  setActiveSessionsRegistry(activeSessions);
  // Seed dashboard IPC botName with the bot's config id; the friendly name from
  // /bot/v3/info is wired into the registry descriptor (below) but the IPC server
  // also needs its own copy for SessionRow.botName.
  setBotName(cfg.larkAppId);
  setLarkAppId(cfg.larkAppId);

  // Bind dashboard IPC HTTP server BEFORE publishing the registry descriptor.
  // Otherwise the dashboard process can race-fetch the IPC port from the
  // descriptor and hit ECONNREFUSED before we're listening — that left every
  // newly-started daemon's hydrate failing on dashboard startup. Binds to
  // 127.0.0.1 only since the dashboard sibling runs on the same host.
  const ipcHandle = await startIpcServer({ port: ipcPort, host: '127.0.0.1' });
  logger.info(`[dashboard-ipc] listening on 127.0.0.1:${ipcHandle.port} (bot ${idx})`);

  // Now that the IPC port is actually listening, publish the descriptor so
  // the dashboard can discover us and successfully fetch /api/sessions etc.
  desc.lastHeartbeat = Date.now();
  writeDaemonDescriptor(desc);
  const descriptorHeartbeat = setInterval(() => {
    desc.lastHeartbeat = Date.now();
    try { writeDaemonDescriptor(desc); } catch { /* best effort */ }
  }, 30_000);
  // Don't keep the event loop alive on this interval alone.
  if (typeof descriptorHeartbeat.unref === 'function') descriptorHeartbeat.unref();

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
          // 同时拿到 raw→open_id 映射，供 /revoke 反查删除 email 形式的 raw 条目（R2#2）。
          const { resolved, map } = await resolveAllowedUsersWithMap(cfg.larkAppId, bot.resolvedAllowedUsers);
          bot.resolvedAllowedUsers = resolved;
          bot.rawAllowedUserResolution = map;
          logger.info(`[${cfg.larkAppId}] Resolved allowedUsers: ${bot.resolvedAllowedUsers.join(', ')}`);
        } catch (err: any) {
          logger.warn(`[${cfg.larkAppId}] Failed to resolve allowedUsers: ${err.message}`);
        }
      }
      // Republish the descriptor with the post-resolution open_ids so the
      // dashboard's create-group flow can pick this bot as creator using the
      // operator's scope-correct open_id. Best-effort; the periodic heartbeat
      // will eventually catch up too.
      desc.resolvedAllowedUsers = bot.resolvedAllowedUsers.filter(u => !u.includes('@'));
      try { writeDaemonDescriptor(desc); } catch { /* best effort */ }
    }

    checkAllowedChatGroupsConfig(bot);

    // Probe bot open_id and persist to bots-info.json. When the friendly
    // botName comes back from /bot/v3/info, refresh the dashboard descriptor
    // so the registry shows "Claude" / "Codex" instead of the raw app id.
    probeBotOpenId(cfg.larkAppId).then(() => {
      writeBotInfoFile(config.session.dataDir);
      const probedName = bot.botName;
      if (probedName && probedName !== desc.botName) {
        desc.botName = probedName;
        try { writeDaemonDescriptor(desc); } catch { /* best effort */ }
      }
    }).catch(err => {
      // Probe runs in background and is retried by the periodic heartbeat;
      // a single failure here is not actionable. Surface as debug only.
      logger.debug(`[${cfg.larkAppId}] Bot open_id probe failed (will retry): ${err.message}`);
    });

    // Required-scope check: 启动后 best-effort 校验
    // im:message.group_at_msg.include_bot:readonly。缺失会 logger.error +
    // 私信 allowedUsers[0]。校验异步，跑失败不影响 daemon。
    checkRequiredScopes(cfg.larkAppId).catch(err => {
      logger.debug(`[${cfg.larkAppId}] required-scope check failed: ${err?.message ?? err}`);
    });

    // Start event dispatcher for this bot
    startLarkEventDispatcher(cfg.larkAppId, cfg.larkAppSecret, {
      handleCardAction: (data, appId) => handleCardAction(data, cardDeps, appId),
      handleNewTopic: (data, ctx) => handleNewTopic(data, ctx),
      handleThreadReply: (data, ctx) => handleThreadReply(data, ctx),
      isSessionOwner: (anchor, appId) => activeSessions.has(sessionKey(anchor, appId)),
      // Chat was converted 普通群 → 话题群 while we held a chat-scope session.
      // Evict it from the routing map so subsequent inbound messages can land
      // on a fresh thread-scope session (dispatcher already rerouted this turn
      // to handleNewTopic). The worker is left running on purpose: the user may
      // still have its web terminal open, and `/close` is the canonical cleanup
      // path. Scheduler tasks tied to this session keep their `scope='chat'`
      // semantics — that's an edge case worth following up on, not blocking
      // the main fix.
      onChatModeConverted: (chatId, appId) => {
        const key = sessionKey(chatId, appId);
        const evicted = activeSessions.delete(key);
        logger.info(`[chat-mode-converted] ${chatId.substring(0, 12)} evicted=${evicted}; worker (if any) keeps running until /close`);
      },
    });
  }

  // Restore active sessions from previous run
  await restoreActiveSessions(activeSessions);

  await attachColdWorkflowRuns(cfg.larkAppId);

  // Start scheduler in every daemon.  Each daemon owns exactly one bot, so
  // each filters to only execute tasks whose `larkAppId` matches its bot
  // (unmatched tasks are handled by the owning bot's daemon instead; a
  // missing larkAppId falls through to bot-0 as a legacy fallback).
  scheduler.setExecuteCallback((task) => executeScheduledTask(task, activeSessions, refreshCliVersion));
  scheduler.setOwnerFilter(cfg.larkAppId, idx === 0);
  scheduler.startScheduler();

  // Graceful shutdown. Sends SIGTERM (or `{type:'close'}` IPC via killWorker)
  // to every worker, then waits up to SHUTDOWN_GRACE_MS for them to exit
  // before sending SIGKILL to stragglers. Without the wait, daemon
  // `process.exit(0)` races worker signal delivery — and any worker whose
  // main thread is in a sync code path (e.g. the bridge fingerprint scan
  // bug fixed in v2.9.2) loses the signal and survives as a ppid=1 orphan
  // forever (we'd accumulated 841 such orphans across daemon restarts,
  // consuming ~65 GB of RAM until manually SIGKILL'd).
  const SHUTDOWN_GRACE_MS = 3000;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Daemon shutting down... (active: ${getActiveCount()})`);
    scheduler.stopScheduler();
    for (const watcher of workflowEventWatchers.values()) watcher.close();
    workflowEventWatchers.clear();
    workflowRuns.clear();
    clearInterval(descriptorHeartbeat);
    if (memoryDiagnostics) clearInterval(memoryDiagnostics);
    removeDaemonDescriptor(cfg.larkAppId);
    ipcHandle.close().catch(() => { /* swallow */ });

    const pendingExits: Array<Promise<void>> = [];
    const survivors: ChildProcess[] = [];
    for (const [, ds] of activeSessions) {
      if (ds.worker && !ds.worker.killed) {
        logger.info(`Shutting down worker for session ${ds.session.sessionId}`);
        const w = ds.worker;
        // Capture the exit promise BEFORE killWorker nulls ds.worker.
        if (w.exitCode === null && w.signalCode === null) {
          pendingExits.push(new Promise<void>(resolve => {
            w.once('exit', () => resolve());
          }));
          survivors.push(w);
        }
        const backendType = ds.larkAppId
          ? (getBot(ds.larkAppId).config.backendType ?? config.daemon.backendType)
          : config.daemon.backendType;
        if (backendType === 'tmux') {
          // Tmux mode: just kill the worker process — tmux session survives for re-attach.
          // Worker's SIGTERM handler calls backend.kill() which only detaches.
          try { w.kill('SIGTERM'); } catch { /* ignore */ }
          ds.worker = null;
          ds.workerPort = null;
          ds.workerToken = null;
        } else {
          killWorker(ds);
        }
      }
    }

    if (pendingExits.length > 0) {
      const timeout = new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS));
      await Promise.race([Promise.all(pendingExits), timeout]);
      let stragglers = 0;
      for (const w of survivors) {
        if (w.exitCode === null && w.signalCode === null) {
          stragglers++;
          try { w.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }
      if (stragglers > 0) {
        logger.warn(`${stragglers}/${survivors.length} worker(s) didn't exit within ${SHUTDOWN_GRACE_MS}ms — SIGKILL'd to prevent ppid=1 orphans.`);
      }
    }

    // Flush any pending identity-cache writes before exit. The cache uses a
    // 2s debounce on disk persistence to dedupe writes from chatty groups; on
    // SIGTERM we want anything learned since the last flush to land.
    flushIdentityCacheSync();

    removePidFile();
    process.exit(0);
  };

  process.on('SIGTERM', () => { shutdown().catch(err => { logger.error(`shutdown failed: ${err?.message ?? err}`); process.exit(1); }); });
  process.on('SIGINT', () => { shutdown().catch(err => { logger.error(`shutdown failed: ${err?.message ?? err}`); process.exit(1); }); });
  // Best-effort cleanup on plain `exit` (e.g. uncaught fatal). No worker
  // shutdown here since the process is already on its way out — just remove
  // the descriptor so the dashboard doesn't see a phantom daemon.
  process.on('exit', () => {
    clearInterval(descriptorHeartbeat);
    if (memoryDiagnostics) clearInterval(memoryDiagnostics);
    removeDaemonDescriptor(cfg.larkAppId);
    // Plain-exit path (uncaught fatal, manual process.exit) bypasses the
    // graceful shutdown above. flushIdentityCacheSync is synchronous and
    // idempotent — safe to call here as a belt-and-suspenders save.
    flushIdentityCacheSync();
  });

  logger.info('Daemon is running. Press Ctrl+C to stop.');
}
