/**
 * Worker pool — manages forking, killing, and lifecycle of worker processes.
 * Extracted from daemon.ts for modularity.
 */
import { execSync, fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, readdirSync, mkdirSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureSkills, ensureAskSkill, ensurePluginSkills, ensureWhiteboardSkill, removeGlobalBotmuxSkills } from '../skills/installer.js';
import { shouldInstallGlobalSkills } from '../skills/injection-mode.js';
import { whiteboardEnabled } from '../services/whiteboard-store.js';
import { cliSupportsNativeUsage } from '../services/transcript-resolver.js';
import { cleanupTraexAskHooks, installHook } from '../adapters/hook-installer.js';
import { hookCommandFor } from '../adapters/hook-command.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { readGlobalConfig } from '../global-config.js';
import * as sessionStore from '../services/session-store.js';
import * as asyncTriggerStore from '../services/async-trigger-store.js';
import {
  markMessageListenerRunPreviewFailed,
  markMessageListenerRunPreviewReplied,
  markMessageListenerRunPreviewRunning,
} from '../services/message-listener-run-preview-store.js';
import { persistStreamCardState, rememberLastCliInput } from './session-manager.js';
import { fallbackTurnId, frozenReplyContextForTurn, isSubstituteTurn } from './reply-target.js';
import { updateMessage, deleteMessage, sendEphemeralCard, sendUserMessage, addReaction, removeReaction, getMessageChatId, MessageWithdrawnError } from '../im/lark/client.js';
import { buildStreamingCard, buildPrivateSnapshotCard, buildSessionCard, buildTuiPromptCard, buildTuiPromptResolvedCard, buildTuiPromptFailedCard, buildRelayedFrozenCard, getCliDisplayName } from '../im/lark/card-builder.js';
import { codexServiceTierBadge } from '../services/codex-service-tier.js';
import { loadFrozenCards, saveFrozenCards } from '../services/frozen-card-store.js';
import { hashUrlForLog, cancelRiffTaskById } from '../adapters/backend/riff-backend.js';
import { logger } from '../utils/logger.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import {
  resolveCliRuntime,
  runtimeInstallationKey,
  runtimePathOverride,
  snapshotCliRuntime,
  type CliRuntimeConfig,
  type CliRuntimeSnapshot,
} from '../adapters/cli/runtime.js';
import { traeHome } from '../services/traex-paths.js';
import { botLocale, localeForBot, t as tr } from '../i18n/index.js';
import { claudeJsonlPathForSession } from '../adapters/cli/claude-code.js';
import { findUniqueClaudeSessionByCwd } from './session-discovery.js';
import {
  buildMarkdownCard,
  buildContextualReplyCard,
  type CardUsageSnapshot,
  type LocalHomeLinkMode,
} from '../im/lark/md-card.js';
import { getSessionUsageSnapshot } from './cost-calculator.js';
import { renderBrandTemplate } from '../im/lark/brand-template.js';
import { replyToDocComment, chunkCommentText, unsubscribeDocFile, removeCommentReaction } from '../im/lark/doc-comment.js';
import { listDocSubscriptionsForSession, removeDocSubscription } from '../services/doc-subs-store.js';
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
import { HerdrBackend } from '../adapters/backend/herdr-backend.js';
import { ZmxBackend } from '../adapters/backend/zmx-backend.js';
import { backendSupportsWebTerminal } from '../adapters/backend/capabilities.js';
import { sandboxEnabled } from '../adapters/backend/sandbox.js';
import {
  isStrongManagedHerdrAgentName,
  managedHerdrAgentName,
} from '../adapters/backend/session-backend-selector.js';
import { isSuspendableBackendType, getSessionPersistentBackendType, persistentBackendTargetForSession, persistentSessionName, killPersistentBackendTarget, killPersistentSession, managedTargetsForCliChange, probePersistentBackendTarget, resolvePairedSpawnBackendType, resolvePersistentBackendTarget } from './persistent-backend.js';
import { withBotTurnMutation } from './bot-turn-mutation-gate.js';
import { getBot, getAllBots, loadBotConfigs, resolveBrandLabel, getLoadedConfigPath, resolveUsageDisplay } from '../bot-registry.js';
import { RestartCoordinator, type RestartObserver } from './restart-coordinator.js';
import { runtimeBuildIdentity } from '../utils/runtime-build-id.js';

/** A random id minted once per daemon process (this lifetime). Stamped onto
 *  isolated persistent panes so a suspend→resume reattach (same id) is
 *  distinguishable from a pane surviving a daemon restart (different id). */
const DAEMON_BOOT_ID = randomUUID();
const restartCoordinator = new RestartCoordinator();
const lifecycleRetiringWorkers = new WeakMap<DaemonSession, Set<ChildProcess>>();
const transferRetiringWorkers = new WeakSet<ChildProcess>();

/** 在完整 Worker 模块加载前接住首条 IPC，避免冷启动耗时被误判为投递失败。 */
function workerForkExecArgv(): string[] {
  const preloadPath = join(__dirname, '..', 'worker-ipc-preload.js');
  return [...process.execArgv, '--import', pathToFileURL(preloadPath).href];
}

function trackLifecycleRetirement(ds: DaemonSession, worker: ChildProcess): void {
  let workers = lifecycleRetiringWorkers.get(ds);
  if (!workers) {
    workers = new Set();
    lifecycleRetiringWorkers.set(ds, workers);
  }
  if (workers.has(worker)) return;
  workers.add(worker);
  const release = (): void => {
    const current = lifecycleRetiringWorkers.get(ds);
    current?.delete(worker);
    if (current?.size === 0) lifecycleRetiringWorkers.delete(ds);
  };
  worker.once('exit', release);
}

function clearLifecycleRetirement(ds: DaemonSession, worker: ChildProcess): void {
  const workers = lifecycleRetiringWorkers.get(ds);
  workers?.delete(worker);
  if (workers?.size === 0) lifecycleRetiringWorkers.delete(ds);
}

/** Symmetric lifecycle fence: relay must not start while another operation is
 * still restarting, spawning, suspending, or closing this worker generation. */
export function isSessionLifecycleInFlight(ds: DaemonSession): boolean {
  return lifecycleRetiringWorkers.has(ds)
    || restartCoordinator.activeAttemptId(ds.session.sessionId) !== undefined
    || (!!ds.worker && !ds.worker.killed && ds.workerReady === false);
}

export function getDaemonBootId(): string {
  return DAEMON_BOOT_ID;
}

function daemonCardLocalHomeLinkMode(ds: DaemonSession): LocalHomeLinkMode {
  // The daemon is outside file/read isolation. Never use its host namespace
  // to disambiguate isolated or remote output; lexical repair performs no
  // filesystem I/O. initConfig.backendType is the backend frozen for the live
  // worker after riff reconciliation; fall back to persisted session metadata
  // while restoring sessions that do not yet have an initConfig.
  const backendType = ds.initConfig?.backendType ?? ds.session.backendType;
  return backendType === 'riff'
    || ds.session.sandbox === true
    || ds.initConfig?.readIsolation === true
    || sandboxEnabled()
    ? 'lexical'
    : 'filesystem';
}

/** Read one frozen native-usage snapshot at the reply boundary. Card delivery
 * remains best-effort even when a CLI has no supported transcript or a usage
 * resolver fails. */
export function getDaemonSessionUsageSnapshot(
  ds: DaemonSession,
  effectiveCliId?: CliId,
  opts?: { fresh?: boolean },
): CardUsageSnapshot {
  try {
    const resolvedCliId = effectiveCliId ?? (
      ds.session.cliId
      ?? ds.session.adoptedFrom?.cliId
      ?? ds.adoptedFrom?.cliId
      ?? getBot(ds.larkAppId).config.cliId
    ) as CliId;
    return getSessionUsageSnapshot({
      cliId: resolvedCliId,
      sessionId: ds.session.sessionId,
      cliSessionId:
        ds.session.cliSessionId
        ?? ds.session.adoptedFrom?.sessionId
        ?? ds.adoptedFrom?.sessionId,
      cwd:
        ds.workingDir
        ?? ds.session.workingDir
        ?? ds.session.adoptedFrom?.cwd
        ?? ds.adoptedFrom?.cwd,
      // Enable the BOT_HOME transcript fallback for CLI-data-redirected /
      // sandboxed bots (same as the ledger and dashboard-row readers). Without
      // it a read-isolated bot's transcript is invisible and the card shows no
      // usage even though it exists under BOT_HOME.
      larkAppId: ds.larkAppId ?? ds.session.larkAppId,
      // Reply cards read at the exact turn boundary (fresh); the live streaming
      // card refreshes on every status tick and rides the reader's reparse
      // throttle instead (fresh:false) to stay off the disk.
      fresh: opts?.fresh ?? true,
    });
  } catch (error) {
    logger.warn(
      `[${ds.session.sessionId.slice(0, 8)}] Failed to read card usage snapshot: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
    return { context: null, tokens: null };
  }
}

/** Reply-card (final output / adopt preamble / local-turn) usage. Only the
 * `'footer'` display mode surfaces usage here; `'streaming'` and `'off'` yield a
 * concrete empty snapshot. Keeping the display decision out of the native usage
 * reader leaves accounting and dashboard consumers intact; the concrete empty
 * snapshot (rather than undefined) also freezes "hidden" over final-output
 * retries. */
export function getDaemonReplyCardUsageSnapshot(
  ds: DaemonSession,
  effectiveCliId?: CliId,
): CardUsageSnapshot {
  try {
    if (resolveUsageDisplay(ds.larkAppId) !== 'footer') {
      return { context: null, tokens: null };
    }
  } catch {
    // Missing runtime config → default 'streaming' → no footer usage.
    return { context: null, tokens: null };
  }
  return getDaemonSessionUsageSnapshot(ds, effectiveCliId);
}

/** Streaming-card usage. Only the `'streaming'` display mode (the default)
 * surfaces usage in the live card body; `'footer'` and `'off'` yield empty.
 * Returns a concrete empty snapshot on any config failure so the streaming
 * renderer stays best-effort. `fresh` forces an exact read at meaningful
 * boundaries (turn end / idle); intra-turn ticks leave it false to ride the
 * reader's reparse throttle and stay off the disk. */
export function getDaemonStreamingCardUsageSnapshot(
  ds: DaemonSession,
  effectiveCliId?: CliId,
  opts?: { fresh?: boolean },
): CardUsageSnapshot {
  try {
    if (resolveUsageDisplay(ds.larkAppId) !== 'streaming') {
      return { context: null, tokens: null };
    }
  } catch {
    // Missing runtime config → default 'streaming' → show usage (best-effort).
  }
  return getDaemonSessionUsageSnapshot(ds, effectiveCliId, { fresh: opts?.fresh ?? false });
}

import { normalizeBrand } from '../im/lark/lark-hosts.js';
import { dashboardEventBus } from './dashboard-events.js';
import { composeRowFromActive, composeRowFromClosed } from './dashboard-rows.js';
import { publishAttentionPatch, publishClosedSessionPatch } from './session-activity.js';
import { knownBotOpenIdsFromCrossRef, type BotMentionEntry } from '../utils/bot-routing.js';
import { emitSessionLifecycleHook, emitSessionStateTransitionHook } from '../services/session-lifecycle-hooks.js';
import { anchorUsageForDaemonSession, recordOwnershipForDaemonSession, recordUsageForDaemonSession, reconcileUsageForDaemonSession } from '../services/usage-ledger.js';
import type { CliId } from '../adapters/cli/types.js';
import { isStructuredBridgeAdoptCli } from '../services/structured-bridge-clis.js';
import { resolveEffectivePluginIds } from './plugins/effective.js';
import { ensureGatewayEntry } from './plugins/mcp/gateway-installer.js';
import type {
  CliTurnPayload,
  CodexAppDeliverySink,
  CodexAppDispatchLedgerEntry,
  CodexAppGenerationCommit,
  CodexAppTurnInput,
  FrozenSessionReplyTarget,
  DaemonToWorker,
  WorkerToDaemon,
  Session,
  DisplayMode,
  QueuedActivationTailEntry,
} from '../types.js';
import {
  appendAcceptedCodexAppDispatch,
  cancelCodexAppDispatch,
  committedCodexAppSequence,
  hasUnsettledCodexAppDispatch,
  prepareCodexAppDispatch,
  retryPreparedCodexAppDispatch,
  retainFreshCodexAppGeneration,
  settleCodexAppDispatch,
} from '../utils/codex-app-dispatch-ledger.js';
import {
  activeSessionKey,
  sessionKey,
  sessionAnchorId,
  storedSessionAnchorId,
  isDocNativeSession,
  larkTransportEnabled,
  type DaemonSession,
} from './types.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import { DONE_REACTION_EMOJI_TYPE } from './pending-response.js';
import { buildTerminalUrl } from './terminal-url.js';
import { prependBotmuxBin, resolveBotmuxWrapperBinDir } from './botmux-wrapper.js';
import { usageLimitStateKey, type CliUsageLimitState } from '../utils/cli-usage-limit.js';
import {
  evaluateVcMeetingManagedSend,
  resolveVcMeetingImTurnOrigin,
} from '../services/vc-meeting-send-policy.js';
import {
  finishVcMeetingImReply,
  prepareVcMeetingDeliveryReply,
  prepareVcMeetingImReply,
} from '../services/vc-meeting-im-reply.js';
import { neutralizeLarkAtTags } from '../services/send-policy.js';
import { recordVcMeetingListenerMessage } from '../services/vc-meeting-listener-message-store.js';
import {
  getVcMeetingListenerTopicRoot,
  recordVcMeetingListenerTopicRoot,
  type VcMeetingListenerTopicKey,
} from '../services/vc-meeting-listener-topic-store.js';
import { parseVcMeetingListenerOutput } from '../services/vc-meeting-listener-output-protocol.js';
import { isLocalCliOpenEnabled, isLocalCliOpenReady } from '../services/local-cli-opener.js';
import { sessionConfiguredRuntimeDisplayName } from './cli-runtime-display.js';
import { isSilentScheduledTurn } from './silent-schedule-turns.js';
import { isTriggerFinalSuppressed } from './trigger-final-suppression.js';
import { writeDeferredTopicBinding } from './deferred-topic-binding.js';
import {
  currentDeviceIsolationFreezeLease,
  deferWorkerSpawnDuringDeviceIsolation,
} from './device-isolation-activation.js';
import {
  buildBotmuxLarkNativeSessionTitle,
  extractBotmuxLarkNativeSessionTitlePrompt,
} from './session-title.js';
import { acknowledgeSessionReady } from './session-ready-handshake.js';
import { recordDispatchInputCommit } from './dispatch.js';
import { sendWorkerIpc } from './worker-ipc.js';

type WindowsForkOptions = ForkOptions & { windowsHide?: boolean };

type WorkerStartupState = {
  ready: boolean;
  failureNotified: boolean;
  /** Init turn attribution frozen at fork. A durable VC delivery is dispatched
   *  (queued) into a not-yet-ready worker; if that worker dies before ready
   *  (fork ENOENT, syntax/import crash, abrupt exit) the fork-level `error` and
   *  pre-ready `exit` paths must route the failure through the same receipt/lease
   *  gate as a structured error, not reply out-of-band. */
  initTurnId?: string;
  initDispatchAttempt?: number;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_SIGTERM_BACKSTOP_MS = 2_000;
const WORKER_SIGKILL_BACKSTOP_MS = 7_000;
const CLOSE_FENCE_WARN_MS = 8_000;
// Peer relay waits 5s for the whole transfer request. Tmux observer detach has
// its own 3s command timeout, so this fence leaves headroom for routing/fork.
// This tight default is load-bearing ONLY for the cross-daemon `/relay --create`
// peer path (dashboard-ipc-server migrate-to-chat), whose transfer must finish
// inside the leader's 5s HTTP abort — otherwise the peer commits the move after
// the leader already reported failure (split-brain; see the busy-refuse comment
// in transferSession). In-process callers have no such ceiling.
const TRANSFER_DETACH_FENCE_MS = 3_500;
// In-process picker relay (card-handler relay_confirm) runs with no HTTP abort
// above it — its card ACK already degrades to a background "处理中" toast at 2.5s
// and the real result is delivered as a visible message. So it can afford a
// larger fence as a last-resort safety net. The COMMON hang, however, is not a
// slow teardown — it's the worker ACKing the detach in ~9ms but then wedging in
// node-pty's native process-exit teardown (a still-open web-terminal client PTY
// blocks `process.exit()` in the reader-thread join; the JS event loop is
// already stopped so the worker cannot self-rescue). We handle that below by
// force-killing the worker once its ACK proves the observer already detached, so
// this fence only bounds the pathological "no ACK at all" case.
export const TRANSFER_DETACH_FENCE_PICKER_MS = 8_000;
// Grace after the worker's transfer_detached ACK before the daemon force-kills
// it. The ACK proves killCli({preserveSandbox:true}) already ran — backend
// detached, CLI/tmux/sandbox left intact for the replacement — so the ACKed
// worker process is disposable. Give it a brief window to exit cleanly on its
// own; if node-pty's exit teardown wedges it (the real bug), SIGKILL it rather
// than stranding the transfer behind the full fence. Short because a healthy
// worker exits within a few ms of the ACK.
const TRANSFER_DETACH_POST_ACK_KILL_MS = 300;
const TRANSFER_FORCE_EXIT_MS = 500;
// Keys the daemon must NOT propagate into a forked worker. GH tokens are the
// bot's, not the agent's. BOTMUX_PM2_GRACEFUL_EXIT_CODE is pm2's private
// graceful-exit sentinel for the daemon/dashboard cores only (see
// pm2-graceful-exit.ts): a worker (or the CLI child it forks — redactChildEnv
// strips it there too) that inherited it would exit 90 instead of 0 on a
// clean foreground stop, which a supervisor reads as a crash.
const WORKER_REDACTED_ENV_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN', 'BOTMUX_PM2_GRACEFUL_EXIT_CODE'] as const;

function workerForkEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of WORKER_REDACTED_ENV_KEYS) delete env[key];
  return env;
}

/** Fresh workers always start with hidden output, so restore the daemon-owned mode. */
function syncWorkerDisplayMode(ds: DaemonSession): void {
  if (!ds.worker || !ds.displayMode || ds.displayMode === 'hidden') return;
  ds.worker.send({ type: 'set_display_mode', mode: ds.displayMode } as DaemonToWorker);
}

// ─── Callbacks set by daemon at startup ─────────────────────────────────────

export interface WorkerSessionReplyOptions {
  uuid?: string;
  quoteMessageId?: string;
  beforeQuoteFallback?: () => void | Promise<void>;
  /** Do not fan meeting-derived content out through user-configured outbound
   * hooks. Dedicated VC replies have one audited external effect: Lark. */
  suppressHook?: boolean;
  /** Exact daemon session that produced this output. Dedicated VC receivers
   * share a visible chat anchor with ordinary sessions, so the anchor alone
   * cannot identify the transcript/lifecycle owner. */
  sourceSessionId?: string;
  /** Exact daemon-frozen destination for a durable turn. */
  replyTarget?: FrozenSessionReplyTarget;
  /** Automatic VC delivery presentation. Explicit human IM replies omit this
   * and continue to follow their quote/thread context. */
  placement?: 'auto' | 'chat' | 'topic';
  meetingTopicKey?: VcMeetingListenerTopicKey;
}

export interface WorkerPoolCallbacks {
  sessionReply: (
    rootId: string,
    content: string,
    msgType?: string,
    larkAppId?: string,
    turnId?: string,
    opts?: WorkerSessionReplyOptions,
  ) => Promise<string>;
  getSessionWorkingDir: (ds?: DaemonSession) => string;
  getActiveCount: () => number;
  /** Close a stale session (message withdrawn, etc.). `false` means the
   * authoritative close failed and the active owner must remain retryable.
   * `void` is retained for older embedders/tests that implement a synchronous
   * best-effort close; the production daemon always returns an exact boolean. */
  closeSession: (ds: DaemonSession) => boolean | void | Promise<boolean | void>;
  /** Re-check the per-bot resident-session cap after a process starts or an
   * over-cap busy session becomes idle. Optional for unit-test callers. */
  enforceLiveSessionCap?: () => void;
  /** Durable consumers subscribe to transcript-backed turn completion here.
   *  Optional so ordinary sessions and tests keep their existing behavior. */
  onTurnTerminal?: (
    ds: DaemonSession,
    terminal: Extract<WorkerToDaemon, { type: 'turn_terminal' }>,
    context: { workerGeneration: number },
  ) => void | Promise<void>;
  /** A hidden fresh-topic schedule can be reclaimed once its exact turn is
   * settled. Transcript-backed CLIs report `terminal`; screen-only/remote
   * adapters use the existing debounced idle edge as a compatibility fallback. */
  onDeferredScheduleTurnSettled?: (
    ds: DaemonSession,
    context: { turnId: string; source: 'terminal' | 'idle' },
  ) => void | Promise<void>;
  /** A process exit makes every unresolved receipt dispatched to this exact
   *  worker generation ambiguous; the receiver decides retry policy. */
  onWorkerExit?: (
    ds: DaemonSession,
    context: { sessionId: string; workerGeneration: number; code: number | null; signal: NodeJS.Signals | null },
  ) => void | Promise<void>;
  /** The managed CLI can crash and auto-restart inside a still-live Node
   *  worker. Durable receipts dispatched to this generation become ambiguous
   *  even though `onWorkerExit` will not fire. */
  onCliExit?: (
    ds: DaemonSession,
    context: { sessionId: string; workerGeneration: number; code: number | null; signal: string | null },
  ) => void | Promise<void>;
  /** Boot recovery worker confirms its old persistent CLI was fenced before
   * receiver delivery endpoints may accept a replay. */
  onReceiverResetReady?: (
    ds: DaemonSession,
    context: { sessionId: string; turnId: string; dispatchAttempt: number },
  ) => void;
  /** Runtime lease-expiry worker confirms the exact attempt is no longer able
   * to execute before the receiver accepts its replay. */
  onDurableExpiryReady?: (
    ds: DaemonSession,
    context: {
      sessionId: string;
      turnId: string;
      dispatchAttempt: number;
      workerGeneration: number;
      disposition: 'queued_removed' | 'cli_fenced';
    },
  ) => void;
  /** Called only after a durable ledger mutation was persisted and its worker
   * ACK was attempted. Runtime CLI-mismatch cleanup may now close the old
   * generation without abandoning a FIFO entry. */
  onCodexAppLedgerDrained?: (ds: DaemonSession) => void | Promise<void>;
  /** The exact queued opening crossed the adapter submission boundary. The
   * daemon may now release its runtime route reservation and flush follow-ups. */
  /** Return false only when a buffered follow-up was not accepted and should
   * be retried. Once accepted, later presentation persistence is best-effort
   * and must not request a delivery retry. */
  onQueuedActivationSubmitted?: (
    ds: DaemonSession,
    activationToken: string,
  ) => boolean | void | Promise<boolean | void>;
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

// ─── Active session registry (daemon-owned, accessor for IPC) ───────────────
// The activeSessions Map physically lives in daemon.ts. To let the dashboard
// IPC server (and other modules) read it without reaching back into daemon, the
// daemon registers its Map here at boot. Helpers below return a snapshot or
// linear-scan by sessionId.
let activeSessionsRegistry: Map<string, DaemonSession> | undefined;

export function setActiveSessionsRegistry(m: Map<string, DaemonSession>): void {
  activeSessionsRegistry = m;
}

export function listActiveSessions(): DaemonSession[] {
  return activeSessionsRegistry ? [...activeSessionsRegistry.values()] : [];
}

/** Linear-scan lookup of the active-sessions Map by `Session.sessionId`.
 *  The Map's actual key is `sessionKey(rootId, larkAppId)` (composite), so we
 *  cannot use Map.get here. */
export function findActiveBySessionId(sessionId: string): DaemonSession | undefined {
  if (!activeSessionsRegistry) return undefined;
  for (const s of activeSessionsRegistry.values()) if (s.session.sessionId === sessionId) return s;
  return undefined;
}

/** Direct access to the active-sessions Map. Reserved for callers that need
 *  to mutate (e.g. resumeSession reactivating a closed record); read-only
 *  callers should prefer listActiveSessions / findActiveBySessionId. */
export function getActiveSessionsRegistry(): Map<string, DaemonSession> | undefined {
  return activeSessionsRegistry;
}

// ─── "Real relayable session" predicate ─────────────────────────────────────

/**
 * True iff this DaemonSession represents a real CLI-backed conversation
 * that's safe to migrate via /relay. Returns false for daemon-command
 * scratch placeholders (the `worker:null + hasHistory:false` records that
 * daemon.ts creates for /help, an unfinished picker /relay, etc.) — those
 * have no CLI history, no tmux, and migrating them yields an empty shell
 * in the target chat with a fake "已就绪" M1.
 *
 * Why not just `!!ds.worker || ds.hasHistory`:
 *   - `ds.worker` is runtime-only; null after daemon restart until
 *     forkWorker re-attaches.
 *   - `ds.hasHistory` is a runtime field too — restoreActiveSessions sets
 *     it `true` UNCONDITIONALLY for any persisted non-adopt session
 *     (session-manager.ts:618). A scratch that survived a restart comes
 *     back with hasHistory:true, defeating the guard.
 *
 * Use persisted markers instead: `ds.session.cliId` and
 * `ds.session.lastCliInput` are written ONLY after a real worker started
 * the CLI (worker-pool's fork path stamps cliId; rememberLastCliInput
 * writes lastCliInput on every input). Daemon-command scratches never set
 * either, so the predicate survives restart and is robust across paths.
 *
 * Apply at every relay surface that consumes a candidate `ds`:
 *   - relay-picker.ts collectRelayPickerEntries (don't list scratches)
 *   - card-handler.ts relay_confirm preflight (don't M1 + transferSession a scratch)
 *   - this file's transferSession depth defense (catch any caller that bypassed both upstream guards)
 *   - command-handler.ts /relay --create leader guard
 */
export function isRelayableRealSession(ds: DaemonSession): boolean {
  if (ds.worker) return true;
  if (ds.session.cliId) return true;
  if (ds.session.lastCliInput) return true;
  return false;
}

/** A worker-less row that never represented a CLI and carries no deferred
 * user intent. Only this narrow class is safe to evict as command scaffolding. */
export function isDisposableCommandScratch(ds: DaemonSession): boolean {
  return !ds.worker
    && !ds.pendingRepo
    && ds.pendingPrompt === undefined
    && ds.pendingRawInput === undefined
    && !ds.adoptedFrom
    && !ds.session.adoptedFrom
    && !ds.session.queued
    && !isRelayableRealSession(ds);
}

// Per-bot opt-out: when true, botmux never posts/patches the live streaming
// session card. Read fresh from the in-memory registry so a dashboard toggle
// takes effect without a daemon restart. The `/card` command can override it
// per-session via `ds.streamingCardForced` (manually summon a live card).
function streamingCardDisabled(ds: DaemonSession, turnId?: string): boolean {
  if (isDocNativeSession(ds)) return true;
  if (ds.streamingCardForced) return false;
  try {
    const cfg = getBot(ds.larkAppId).config;
    return cfg.disableStreamingCard === true
      || (!!ds.chatId && !!cfg.noCardChats?.includes(ds.chatId))
      // Per-turn substitute gate — see streamingCardDisabledFor in daemon.ts.
      // Callers with a turnId (screen updates) get an exact per-turn answer.
      || isSubstituteTurn(ds, turnId);
  } catch { return false; }
}

function silentTurnReactions(ds: DaemonSession): boolean {
  try {
    return getBot(ds.larkAppId).config.silentTurnReactions === true;
  } catch { return false; }
}

function doneReactionEmojiFor(ds: DaemonSession): string {
  try {
    return getBot(ds.larkAppId).config.doneReactionEmoji || DONE_REACTION_EMOJI_TYPE;
  } catch { return DONE_REACTION_EMOJI_TYPE; }
}

/** Worker lifecycle readiness is independent from Web Terminal availability.
 * Legacy/test sessions predate workerReady, so retain the old port inference
 * only while the explicit flag is absent. */
export function workerHasInitialized(ds: DaemonSession): boolean {
  return ds.workerReady === true
    || (ds.workerReady === undefined
      && sessionSupportsWebTerminal(ds)
      && !!(ds.workerPort ?? ds.session.webPort));
}

/** Capability of the backend frozen onto this worker/session generation. */
export function sessionSupportsWebTerminal(ds: DaemonSession): boolean {
  const backendType = ds.initConfig?.backendType ?? ds.session.backendType;
  // Pre-backend-stamp sessions are legacy tmux sessions and retain Web TUI.
  return backendType === undefined || backendSupportsWebTerminal(backendType);
}

/** Empty means this session intentionally has no Web Terminal surface. */
export function readableTerminalUrlFor(ds: DaemonSession): string {
  return sessionSupportsWebTerminal(ds) && (ds.workerPort ?? ds.session.webPort)
    ? buildTerminalUrl(ds)
    : '';
}

// Per-bot opt-in: the writable terminal link to embed directly in the streaming
// card body (token included). Returns undefined unless the bot enabled it AND
// the worker port/token are known. Exported for card-handler's re-renders so the
// link stays put across button-driven card updates.
export function writableTerminalLinkFor(ds: DaemonSession): string | undefined {
  if (!sessionSupportsWebTerminal(ds)) return undefined;
  try {
    if (getBot(ds.larkAppId).config.writableTerminalLinkInCard !== true) return undefined;
  } catch { return undefined; }
  // Riff backend: the sandbox URL is the writable link — no local worker needed.
  if (ds.riffAccessUrl) return ds.riffAccessUrl;
  if (!ds.workerPort || !ds.workerToken) return undefined;
  return buildTerminalUrl(ds, { write: true });
}

function scheduleLocalCliOpenReadinessPatch(ds: DaemonSession): void {
  if (!isLocalCliOpenEnabled() || streamingCardDisabled(ds) || ds.suppressRecoveryCard) {
    ds.pendingLocalCliButtonRefresh = undefined;
    return;
  }
  if (ds.streamCardId === CARD_POSTING_SENTINEL) {
    ds.pendingLocalCliButtonRefresh = true;
    return;
  }
  if (!ds.streamCardId || !workerHasInitialized(ds)) return;
  ds.pendingLocalCliButtonRefresh = undefined;
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const status = ds.usageLimit ? 'limited' : (ds.lastScreenStatus ?? 'starting');
  const cardJson = buildStreamingCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    readableTerminalUrlFor(ds),
    ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg),
    ds.lastScreenContent ?? '',
    status,
    effectiveCliId,
    ds.displayMode ?? 'hidden',
    ds.streamCardNonce,
    ds.currentImageKey,
    !!ds.adoptedFrom,
    false,
    localeForBot(ds.larkAppId),
    status === 'limited' ? ds.usageLimit : undefined,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
  );
  scheduleCardPatch(ds, cardJson);
}

function flushPendingLocalCliOpenReadinessPatch(ds: DaemonSession): void {
  if (!ds.pendingLocalCliButtonRefresh) return;
  ds.pendingLocalCliButtonRefresh = undefined;
  scheduleLocalCliOpenReadinessPatch(ds);
}

/** PATCH a live card when rollout settings change, even if the PTY is static. */
function scheduleCodexServiceTierPatch(ds: DaemonSession): void {
  if (ds.session.vcMeetingReceiver || streamingCardDisabled(ds) || ds.suppressRecoveryCard) {
    ds.pendingCodexTierCardRefresh = undefined;
    return;
  }
  if (ds.streamCardNonce && ds.parkedStreamCardNonce === ds.streamCardNonce) {
    ds.pendingCodexTierCardRefresh = undefined;
    return;
  }
  if (ds.streamCardId === CARD_POSTING_SENTINEL) {
    ds.pendingCodexTierCardRefresh = true;
    return;
  }
  if (!ds.streamCardId || !ds.workerPort) {
    ds.pendingCodexTierCardRefresh = undefined;
    return;
  }
  ds.pendingCodexTierCardRefresh = undefined;
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const status = ds.usageLimit ? 'limited' : (ds.lastScreenStatus ?? 'starting');
  const cardJson = buildStreamingCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    buildTerminalUrl(ds),
    ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId),
    ds.lastScreenContent ?? '',
    status,
    effectiveCliId,
    ds.displayMode ?? 'hidden',
    ds.streamCardNonce,
    ds.currentImageKey,
    !!ds.adoptedFrom,
    false,
    localeForBot(ds.larkAppId),
    status === 'limited' ? ds.usageLimit : undefined,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
  );
  scheduleCardPatch(ds, cardJson);
}

/** How often the live streaming card is re-PATCHed with fresh usage while a
 *  turn executes. 12s stays off the prompt-cache-friendly path; the tick reads
 *  with fresh:true so it bypasses (does not merely out-wait) the usage reader's
 *  15s reparse throttle — the transcript grows per tool step, so each refresh
 *  folds only the newly appended bytes. */
export const USAGE_REFRESH_INTERVAL_MS = 12_000;

/** Single source of truth for "this session should be periodically re-rendering
 *  its streaming card with fresh usage right now". Used by both the arm gate and
 *  the interval tick so arm/clear is a state-boundary invariant, not tied to one
 *  PATCH path. Requires: an actively-working turn, a live (non-sentinel, not a
 *  new-turn handoff) streaming card, the worker initialized (NOT a Web-Terminal
 *  port — ZMX reports ready with port=0), usageDisplay='streaming', and a CLI
 *  that actually has a native-usage transcript (gemini/opencode/pi/… have none
 *  → nothing to show). */
export function usageRefreshShouldRun(ds: DaemonSession): boolean {
  if (ds.lastScreenStatus !== 'working') return false;
  if (streamingCardDisabled(ds) || ds.suppressRecoveryCard) return false;
  // New-turn handoff window: beginNewTurn sets streamCardPending=true and swaps
  // currentTurnTitle while the OLD streamCardId is still present (the live
  // worker is still `working`). A stray tick here would PATCH the previous
  // card with the NEW turn's title/content before the next screen_update's
  // managed/silent gate runs. The POST-in-flight sentinel is also covered.
  if (ds.streamCardPending) return false;
  if (!ds.streamCardId || ds.streamCardId === CARD_POSTING_SENTINEL) return false;
  if (!workerHasInitialized(ds)) return false;
  if (!cliSupportsNativeUsage(sessionCliId(ds, getBot(ds.larkAppId).config))) return false;
  try {
    if (resolveUsageDisplay(ds.larkAppId) !== 'streaming') return false;
  } catch { /* missing config → default streaming → allowed */ }
  return true;
}

/** Re-render the current streaming card with the freshest usage snapshot. The
 *  interval tick is self-correcting: if the session no longer qualifies (turn
 *  settled, card gone, limit, etc.) it clears its own timer, bounding any missed
 *  explicit clear to a single interval. Reads with fresh:true so the periodic
 *  PATCH actually beats the cost reader's 15s reparse throttle. */
export function refreshStreamingCardUsage(ds: DaemonSession): void {
  if (!usageRefreshShouldRun(ds)) {
    clearUsageRefreshTimer(ds);
    return;
  }
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const cardJson = buildStreamingCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    // readableTerminalUrlFor (NOT raw buildTerminalUrl): now that this tick can
    // run for a port=0 backend (ZMX reports ready without a Web Terminal), a raw
    // URL would render a fake `:undefined`/backend-less link. Mirror every other
    // card path — empty string when there is no real terminal.
    readableTerminalUrlFor(ds),
    ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg),
    ds.lastScreenContent ?? '',
    ds.lastScreenStatus ?? 'working',
    effectiveCliId,
    ds.displayMode ?? 'hidden',
    ds.streamCardNonce,
    ds.currentImageKey,
    !!ds.adoptedFrom,
    false,
    localeForBot(ds.larkAppId),
    cardUsageLimit(ds),
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    // fresh:true — the whole point of the tick is to break the 15s throttle so
    // the total/turn usage actually climbs on-screen every interval.
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId, { fresh: true }),
    sessionRuntimeDisplayName(ds, botCfg),
    // Keep the Fast tier badge alive across the periodic refresh: this render
    // path fires every 12s while a turn works, so omitting it would drop the
    // ⚡ badge until the next status-edge PATCH.
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
  );
  scheduleCardPatch(ds, cardJson);
}

function flushPendingCodexServiceTierPatch(ds: DaemonSession): void {
  if (!ds.pendingCodexTierCardRefresh) return;
  ds.pendingCodexTierCardRefresh = undefined;
  scheduleCodexServiceTierPatch(ds);
}

/** Bring the periodic usage refresh in line with current state — arm when the
 *  session qualifies, clear otherwise. Idempotent; safe to call after ANY
 *  lastScreenStatus assignment or streaming-card lifecycle change. This is the
 *  single choke point that makes the timer a state-boundary invariant. */
export function syncUsageRefreshTimer(ds: DaemonSession): void {
  if (usageRefreshShouldRun(ds)) armUsageRefreshTimer(ds);
  else clearUsageRefreshTimer(ds);
}

/** Arm the periodic usage refresh. Idempotent — a running timer is left in
 *  place. Callers gate via syncUsageRefreshTimer/usageRefreshShouldRun; this
 *  just owns the setInterval. */
function armUsageRefreshTimer(ds: DaemonSession): void {
  if (ds.usageRefreshTimer) return;
  ds.usageRefreshTimer = setInterval(() => {
    try { refreshStreamingCardUsage(ds); } catch { /* best-effort */ }
  }, USAGE_REFRESH_INTERVAL_MS);
  // Don't keep the daemon event loop alive solely for this cosmetic refresh.
  ds.usageRefreshTimer.unref?.();
}

/** Stop the periodic usage refresh (turn ended, card gone, session closing). */
function clearUsageRefreshTimer(ds: DaemonSession): void {
  if (ds.usageRefreshTimer) {
    clearInterval(ds.usageRefreshTimer);
    ds.usageRefreshTimer = undefined;
  }
}

/**
 * PATCH the live streaming card with the freshest riff sandbox URL. Mirrors
 * {@link scheduleLocalCliOpenReadinessPatch}: when the card POST is still
 * in-flight (streamCardId === sentinel) the refresh is parked on
 * `pendingRiffUrlCardRefresh` and flushed once the POST lands — the riff
 * accessUrl typically arrives inside exactly that window (task-execute returns
 * within ~1s of the initial card POST), and without the pending flag the
 * in-card writable link would stay stale until the next status-edge PATCH.
 */
export function scheduleRiffAccessUrlPatch(ds: DaemonSession): void {
  if (streamingCardDisabled(ds) || ds.suppressRecoveryCard) {
    ds.pendingRiffUrlCardRefresh = undefined;
    return;
  }
  if (ds.streamCardId === CARD_POSTING_SENTINEL) {
    ds.pendingRiffUrlCardRefresh = true;
    return;
  }
  if (!ds.streamCardId || !ds.riffAccessUrl || !ds.workerPort) return;
  ds.pendingRiffUrlCardRefresh = undefined;
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const status = ds.usageLimit ? 'limited' : (ds.lastScreenStatus ?? 'starting');
  const cardJson = buildStreamingCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    buildTerminalUrl(ds),
    ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg),
    ds.lastScreenContent ?? '',
    status,
    effectiveCliId,
    ds.displayMode ?? 'hidden',
    ds.streamCardNonce,
    ds.currentImageKey,
    !!ds.adoptedFrom,
    false,
    localeForBot(ds.larkAppId),
    status === 'limited' ? ds.usageLimit : undefined,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
  );
  scheduleCardPatch(ds, cardJson);
}

function flushPendingRiffUrlPatch(ds: DaemonSession): void {
  if (!ds.pendingRiffUrlCardRefresh) return;
  ds.pendingRiffUrlCardRefresh = undefined;
  scheduleRiffAccessUrlPatch(ds);
}

function clearPendingLocalCliOpenReadinessPatch(ds: DaemonSession): void {
  ds.pendingLocalCliButtonRefresh = undefined;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

function sessionCliId(ds: DaemonSession, botCfg: { cliId: CliId }): CliId {
  return ds.session.cliId ?? botCfg.cliId;
}

function sessionRuntimeDisplayName(
  ds: DaemonSession,
  botCfg?: { cliRuntime?: CliRuntimeConfig },
): string | undefined {
  const liveRuntime = botCfg
    ? botCfg.cliRuntime
    : getBot(ds.larkAppId).config.cliRuntime;
  return sessionConfiguredRuntimeDisplayName(ds.session, liveRuntime);
}

function sessionCliDisplayName(
  ds: DaemonSession,
  botCfg: { cliId: CliId; cliRuntime?: CliRuntimeConfig },
): string {
  return sessionRuntimeDisplayName(ds, botCfg)
    ?? getCliDisplayName(sessionCliId(ds, botCfg));
}

function storedSessionCliDisplayName(ds: DaemonSession): string {
  try {
    return sessionCliDisplayName(ds, getBot(ds.larkAppId).config);
  } catch {
    return getCliDisplayName((ds.session.cliId ?? ds.initConfig?.cliId ?? 'claude-code') as CliId);
  }
}

function sessionAgentConfig(
  ds: DaemonSession,
  botCfg: { cliId: CliId; cliRuntime?: CliRuntimeConfig; cliPathOverride?: string; wrapperCli?: string; model?: string },
): { cliId: CliId; cliRuntime?: CliRuntimeSnapshot; cliPathOverride?: string; wrapperCli?: string; model?: string; reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' } {
  // Freeze the agent launch config (cli / runtime / cliPath / wrapper / model) onto the
  // session the first time a worker forks, so later bot-level edits never
  // retroactively change a live session — same discipline as `sandbox`.
  //
  // Gated on `agentFrozen`, NOT on `resume`: a session created before these
  // fields existed has `cliId` stamped historically but no frozen wrapper/model,
  // yet it was launching off the live bot config — so its first post-upgrade
  // resume must back-fill the still-missing fields from botCfg to keep launching
  // identically (e.g. a `ttadk codex` wrapper bot must not silently drop to bare
  // `codex`, losing its gateway). `??` preserves whatever is already frozen and
  // only fills the gaps; the marker disambiguates "legacy, never frozen" from
  // "frozen as no-wrapper", so a genuinely wrapper-less session never inherits a
  // wrapper the bot gains later.
  if (!ds.session.agentFrozen) {
    ds.session.cliId = ds.session.cliId ?? botCfg.cliId;
    const runtime = resolveCliRuntime({
      cliId: ds.session.cliId,
      // A partially stamped legacy session's own path is authoritative. Only a
      // session with no frozen path inherits the live bot's structured runtime.
      cliRuntime: ds.session.cliPathOverride ? undefined : botCfg.cliRuntime,
      cliPathOverride: ds.session.cliPathOverride
        ?? (botCfg.cliRuntime ? undefined : botCfg.cliPathOverride),
      context: 'session cliRuntime',
    });
    ds.session.cliRuntime = snapshotCliRuntime(runtime);
    // Shadow-write the path for downgrade compatibility. Official Codex stays
    // undefined, exactly like historical sessions.
    ds.session.cliPathOverride = ds.session.cliPathOverride
      ?? runtimePathOverride(runtime)
      ?? botCfg.cliPathOverride;
    ds.session.wrapperCli = ds.session.wrapperCli ?? botCfg.wrapperCli;
    ds.session.model = ds.session.model ?? botCfg.model;
    ds.session.agentFrozen = true;
    sessionStore.updateSession(ds.session);
  } else {
    let repaired = false;
    if (!ds.session.cliRuntime) {
      // Sessions frozen by older botmux versions never had a runtime snapshot.
      // Derive it strictly from THEIR frozen cli/path; inheriting today's bot
      // runtime here could resume a session under another distribution.
      ds.session.cliRuntime = snapshotCliRuntime(resolveCliRuntime({
        cliId: ds.session.cliId ?? botCfg.cliId,
        cliPathOverride: ds.session.cliPathOverride,
        context: 'frozen session cliRuntime',
      }));
      repaired = true;
    }

    // Once present, the frozen descriptor is the launch source of truth. The
    // path field is only a downgrade-compatibility shadow; repair a missing or
    // stale shadow instead of silently launching another distribution. This is
    // especially important for forward-written sessions that may persist the
    // structured snapshot without the deprecated field.
    if (ds.session.cliRuntime) {
      const frozenPath = runtimePathOverride(ds.session.cliRuntime);
      if (ds.session.cliPathOverride !== frozenPath) {
        ds.session.cliPathOverride = frozenPath;
        repaired = true;
      }
    }
    if (repaired) sessionStore.updateSession(ds.session);
  }
  return {
    cliId: ds.session.cliId ?? botCfg.cliId,
    cliRuntime: ds.session.cliRuntime,
    cliPathOverride: ds.session.cliPathOverride,
    wrapperCli: ds.session.wrapperCli,
    model: ds.session.model,
    reasoningEffort: ds.session.reasoningEffort,
  };
}

function loadKnownBotOpenIdsForApp(larkAppId: string): Set<string> {
  const dataDir = config.session.dataDir;
  let crossRef: Record<string, string> = {};
  const crossRefPath = join(dataDir, `bot-openids-${larkAppId}.json`);
  if (existsSync(crossRefPath)) {
    const parsed = JSON.parse(readFileSync(crossRefPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      crossRef = parsed as Record<string, string>;
    }
  }

  let botEntries: BotMentionEntry[] = [];
  const botInfoPath = join(dataDir, 'bots-info.json');
  if (existsSync(botInfoPath)) {
    const parsed = JSON.parse(readFileSync(botInfoPath, 'utf-8'));
    if (Array.isArray(parsed)) botEntries = parsed as BotMentionEntry[];
  }

  return knownBotOpenIdsFromCrossRef(crossRef, botEntries, larkAppId);
}

/** CLIs whose model→Lark delivery is the daemon's stdout-runner fallback card
 *  (NOT the model calling `botmux send`): mira (Web API runner) and mir (local
 *  mircli runner). They can't @-trigger a peer bot themselves, so for bot-to-bot
 *  handoffs the fallback card must carry the real <at> back to the dispatcher. */
function isRunnerDeliveryCli(cliId?: string): boolean {
  return cliId === 'mira' || cliId === 'mir';
}

function daemonCardFooterRecipientOpenId(ds: DaemonSession, effectiveCliId?: string): string | undefined {
  const owner = ds.session.ownerOpenId;
  if (!owner) {
    // Mira / Mir run through botmux's stdout-runner and cannot execute
    // `botmux send` to @-trigger a peer bot. For bot-to-bot handoffs, address
    // the daemon fallback card back to the original dispatcher so orchestration
    // resumes (the card's real <at> is what re-wakes the dispatching bot).
    if (isRunnerDeliveryCli(effectiveCliId) && ds.session.quoteTargetSenderIsBot && ds.session.creatorOpenId) {
      return ds.session.creatorOpenId;
    }
    return undefined;
  }
  try {
    if (loadKnownBotOpenIdsForApp(ds.larkAppId).has(owner)) {
      // `/repo`-primed dispatch records the dispatching bot as owner (unlike
      // the @-mention auto-create path, which nulls ownerOpenId for bot
      // senders). Same constraint for the stdout-runner CLIs (mira/mir): the
      // daemon fallback card is their only @-trigger channel, so address the
      // dispatcher bot here too.
      return isRunnerDeliveryCli(effectiveCliId) ? owner : undefined;
    }
    return owner;
  } catch {
    return owner;
  }
}

export function clearUsageLimitState(ds: DaemonSession): void {
  if (ds.usageLimitRetryTimer) {
    clearTimeout(ds.usageLimitRetryTimer);
    ds.usageLimitRetryTimer = undefined;
  }
  ds.usageLimit = undefined;
  persistStreamCardState(ds);
}

export function cardUsageLimit(ds: DaemonSession): CliUsageLimitState | undefined {
  return ds.lastScreenStatus === 'limited' ? ds.usageLimit : undefined;
}

function scheduleUsageLimitCardPatch(ds: DaemonSession): void {
  // Dedicated VC receivers keep limit state for dashboard/audit only. A timer
  // must never revive or mutate an old/manual Lark card after the synchronous
  // screen_update path has already suppressed auxiliary UI.
  if (ds.session.vcMeetingReceiver) return;
  if (ds.lastScreenStatus !== 'limited') return;
  if (!ds.streamCardId || ds.streamCardId === CARD_POSTING_SENTINEL || !workerHasInitialized(ds)) return;

  const bot = getBot(ds.larkAppId);
  const effectiveCliId = sessionCliId(ds, bot.config);
  const readUrl = readableTerminalUrlFor(ds);
  const turnTitle = ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, bot.config);
  const cardJson = buildStreamingCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    readUrl,
    turnTitle,
    ds.lastScreenContent ?? '',
    'limited',
    effectiveCliId,
    ds.displayMode ?? 'hidden',
    ds.streamCardNonce,
    ds.currentImageKey,
    !!ds.adoptedFrom,
    false,
    localeForBot(ds.larkAppId),
    ds.usageLimit,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, bot.config),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
  );
  scheduleCardPatch(ds, cardJson);
}

function armUsageLimitRetryTimer(ds: DaemonSession, previous?: CliUsageLimitState): void {
  if (!ds.usageLimit) return;

  if (ds.usageLimitRetryTimer) {
    clearTimeout(ds.usageLimitRetryTimer);
    ds.usageLimitRetryTimer = undefined;
  }

  if (ds.usageLimit.retryReady || ds.usageLimit.retryAtMs <= Date.now()) {
    const wasReady = !!previous?.retryReady;
    ds.usageLimit = { ...ds.usageLimit, retryReady: true };
    persistStreamCardState(ds);
    if (!wasReady) scheduleUsageLimitCardPatch(ds);
    return;
  }

  const key = usageLimitStateKey(ds.usageLimit);
  const delayMs = Math.max(0, ds.usageLimit.retryAtMs - Date.now());
  ds.usageLimitRetryTimer = setTimeout(() => {
    if (!ds.usageLimit || usageLimitStateKey(ds.usageLimit) !== key) return;
    ds.usageLimit = { ...ds.usageLimit, retryReady: true };
    persistStreamCardState(ds);
    scheduleUsageLimitCardPatch(ds);
  }, delayMs);
}

export function restoreUsageLimitRuntimeState(ds: DaemonSession): void {
  if (!ds.usageLimit) return;
  ds.lastScreenStatus = 'limited';
  armUsageLimitRetryTimer(ds);
}

function updateUsageLimitState(ds: DaemonSession, usageLimit?: CliUsageLimitState): void {
  if (!usageLimit) return;

  const previous = ds.usageLimit;
  // Screen updates repeat the same limit every tick while a session sits
  // blocked. Skip the persist + timer re-arm churn unless the limit changed.
  if (
    previous &&
    usageLimitStateKey(previous) === usageLimitStateKey(usageLimit) &&
    previous.retryReady === usageLimit.retryReady
  ) return;

  ds.usageLimit = usageLimit;
  persistStreamCardState(ds);
  armUsageLimitRetryTimer(ds, previous);
}

const WORKER_ERROR_MARKER = '[botmux-worker-error]';

function logWorkerStderr(t: string, line: string): void {
  if (!line) return;
  const taggedLine = `[${t}:err] ${line}`;
  if (line.includes(WORKER_ERROR_MARKER)) {
    logger.error(taggedLine);
    return;
  }
  logger.info(taggedLine);
}

// Sentinel value for streamCardId while a POST (new card) is in-flight.
// Prevents duplicate card POSTs when multiple screen_updates arrive before
// the first POST returns a real message_id.
export const CARD_POSTING_SENTINEL = '__posting__';

/**
 * Move the current streaming card into `frozenCards` without freezing it
 * cosmetically. The next successful card POST will sweep it via
 * `recallFrozenCards`. Used on paths that bypass the normal freeze step
 * (worker dead before a new turn, repo switch tearing down the session) so
 * we never delete the only visible card before its successor exists — if
 * fork / worker_ready / POST fails, the parked card stays in the thread.
 *
 * Lazy-loads `frozenCards` from disk if the in-memory Map is missing
 * (post daemon-restart, before any card-handler action has loaded it).
 * Without this, parking would synthesize an empty Map and the subsequent
 * `saveFrozenCards` would overwrite earlier turns' entries on disk —
 * stranding their cards in the thread with no way to recall them.
 *
 * No-op when there is no live card to park.
 */
export function parkStreamCard(ds: DaemonSession): void {
  if (!ds.streamCardId || ds.streamCardId === CARD_POSTING_SENTINEL) return;
  if (!ds.streamCardNonce) return;
  ds.parkedStreamCardNonce = ds.streamCardNonce;
  if (!ds.frozenCards) ds.frozenCards = loadFrozenCards(ds.session.sessionId);
  ds.frozenCards.set(ds.streamCardNonce, {
    messageId: ds.streamCardId,
    content: ds.lastScreenContent ?? '',
    title: ds.currentTurnTitle ?? '',
    displayMode: ds.displayMode ?? 'hidden',
    imageKey: ds.currentImageKey,
    ...(() => {
      const badge = codexServiceTierBadge(
        sessionCliId(ds, getBot(ds.larkAppId).config),
        ds.codexServiceTier,
      );
      return badge ? { codexServiceTierBadge: badge } : {};
    })(),
  });
  saveFrozenCards(ds.session.sessionId, ds.frozenCards);
}

/**
 * Delete previously-frozen streaming cards from Lark and clear the cache.
 * Called whenever a new streaming card becomes the active one — old turns'
 * cards just add visual clutter when scrolling thread history.
 *
 * Lazy-loads `frozenCards` from disk if the in-memory Map is missing
 * (post daemon-restart). Best-effort delete; failures (already withdrawn,
 * expired) are non-fatal.
 *
 * Skips any entry whose messageId matches `ds.streamCardId` — guards the
 * daemon-restart window where a turn was frozen (entry persisted to disk)
 * but a new card was never POSTed before the crash. After restart the same
 * messageId is the live `streamCardId` again, and recalling it would delete
 * the only card the user can see.
 */
export function recallFrozenCards(ds: DaemonSession): void {
  if (!ds.frozenCards) ds.frozenCards = loadFrozenCards(ds.session.sessionId);
  if (ds.frozenCards.size === 0) return;
  const activeId = ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL
    ? ds.streamCardId
    : undefined;
  const targets: string[] = [];
  for (const [nonce, fc] of [...ds.frozenCards.entries()]) {
    if (activeId && fc.messageId === activeId) continue;
    targets.push(fc.messageId);
    ds.frozenCards.delete(nonce);
  }
  if (targets.length === 0) return;
  saveFrozenCards(ds.session.sessionId, ds.frozenCards);
  for (const messageId of targets) {
    deleteMessage(ds.larkAppId, messageId).catch(() => { /* best-effort */ });
  }
  logger.info(`[${tag(ds)}] Recalled ${targets.length} previous streaming card(s)`);
}

/**
 * Force-post a fresh streaming card for `ds`, bypassing the per-bot
 * `disableStreamingCard` opt-out. Backs the `/card` command: a user can
 * manually summon a live card in an otherwise-quiet session. Parks the current
 * card (if any) first so `recallFrozenCards` withdraws it once the fresh one
 * lands — the thread ends up with a single live card. Returns false when the
 * worker isn't initialized yet, so the caller can surface a friendly "not
 * ready" message. A ready backend without Web Terminal still gets the card.
 *
 * Note: this does NOT itself flip `ds.streamingCardForced` — the caller sets
 * that so the card keeps live-patching afterwards even when the bot opted out.
 */
export async function postFreshStreamingCard(
  ds: DaemonSession,
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string, turnId?: string) => Promise<string>,
): Promise<boolean> {
  // Receiver terminals can contain meeting-derived private context. Never
  // publish one into the listener chat as a streaming-card side channel.
  if (ds.session.vcMeetingReceiver) return false;
  if (isDocNativeSession(ds)) return false;
  if (!workerHasInitialized(ds)) return false;
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const readUrl = readableTerminalUrlFor(ds);
  const title = ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg);
  const status = ds.lastScreenStatus ?? 'idle';

  // Park the current card (no-op when there's none) so the fresh one replaces
  // rather than duplicates it.
  parkStreamCard(ds);

  // Snapshot prior identity for rollback on POST failure (restore all three
  // together so a failed /card leaves no orphaned nonce/pending state).
  const prevCardId = ds.streamCardId;
  const prevNonce = ds.streamCardNonce;
  const prevPending = ds.streamCardPending;

  ds.streamCardNonce = randomBytes(4).toString('hex');
  const cardJson = buildStreamingCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    readUrl,
    title,
    ds.lastScreenContent ?? '',
    status,
    effectiveCliId,
    ds.displayMode ?? 'hidden',
    ds.streamCardNonce,
    ds.currentImageKey,
    !!ds.adoptedFrom,
    false,
    localeForBot(ds.larkAppId),
    cardUsageLimit(ds),
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
  );
  ds.streamCardId = CARD_POSTING_SENTINEL;
  try {
    ds.streamCardId = await sessionReply(sessionAnchorId(ds), cardJson, 'interactive', ds.larkAppId, ds.currentReplyTarget?.turnId);
    // This card is now the live one for the current turn. Clear the new-turn
    // pending flag so the next screen_update PATCHes it instead of POSTing a
    // duplicate (the gate above only suppresses cards when disabled+unforced;
    // /card forces them on, so a stale pending flag would otherwise re-POST).
    ds.streamCardPending = false;
    ds.parkedStreamCardNonce = undefined;
    persistStreamCardState(ds);
    recallFrozenCards(ds);
    flushPendingLocalCliOpenReadinessPatch(ds);
    flushPendingRiffUrlPatch(ds);
    flushPendingCodexServiceTierPatch(ds);
    // Manual /card during a working turn lands a live card whose subsequent
    // screen_updates are working→working (no status edge) — arm the periodic
    // usage refresh here, now that the real id is committed and pending cleared.
    syncUsageRefreshTimer(ds);
    logger.info(`[${tag(ds)}] Posted streaming card via /card`);
    return true;
  } catch (err) {
    ds.streamCardId = prevCardId;
    ds.streamCardNonce = prevNonce;
    ds.streamCardPending = prevPending;
    flushPendingLocalCliOpenReadinessPatch(ds);
    flushPendingRiffUrlPatch(ds);
    flushPendingCodexServiceTierPatch(ds);
    // Rolled back to the prior card identity — re-sync so a restored still-live
    // working card keeps (or resumes) its refresh rather than losing the timer.
    syncUsageRefreshTimer(ds);
    logger.warn(`[${tag(ds)}] /card POST failed: ${err}`);
    return false;
  }
}

/**
 * Audience for a private `/card`: the bot's `allowedUsers` (the canOperate set —
 * owner & co-owners), deduped, `ou_` only. Talk-only grants (`globalGrants` /
 * `chatGrants`) and a bare triggerer are intentionally NOT included: the private
 * card is owner-only. A grant-authorized user who runs `/card` therefore does
 * not receive a card (matches the "授权人不发" rule). Empty when the bot has no
 * `allowedUsers` (fully-open mode → no owner to send to).
 */
export function resolvePrivateCardAudience(ds: DaemonSession): string[] {
  const bot = getBot(ds.larkAppId);
  const set = new Set<string>();
  for (const u of bot.resolvedAllowedUsers) if (u.startsWith('ou_')) set.add(u);
  return [...set];
}

/**
 * Private `/card`: build a one-shot snapshot of the current terminal and send it
 * as an ephemeral (visible-to-one) card to each open_id in `audience`, one API
 * call each (concurrency-capped). Never posts a group-visible card and never
 * patches — privacy is the whole point, so there is deliberately no fallback.
 * Returns per-recipient counts so the caller can report progress without leaking
 * the audience list into the chat.
 */
export async function postPrivateSnapshotCard(
  ds: DaemonSession,
  audience: string[],
): Promise<{ sent: number; total: number; notReady: boolean }> {
  if (!workerHasInitialized(ds)) return { sent: 0, total: audience.length, notReady: true };

  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const readUrl = readableTerminalUrlFor(ds);
  const title = ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg);
  const status = ds.lastScreenStatus ?? 'idle';
  const cardJson = buildPrivateSnapshotCard(
    readUrl, title, status, effectiveCliId, ds.currentImageKey, ds.lastScreenContent ?? '',
    ds.session.sessionId, sessionAnchorId(ds), localeForBot(ds.larkAppId), cardUsageLimit(ds),
    sessionRuntimeDisplayName(ds, botCfg),
  );

  let sent = 0;
  // Cap concurrency: Feishu per-chat ~40 QPS, ephemeral total 50/s.
  const CONCURRENCY = 5;
  for (let i = 0; i < audience.length; i += CONCURRENCY) {
    const batch = audience.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (openId) => {
      try {
        await sendEphemeralCard(ds.larkAppId, ds.chatId, openId, cardJson);
        sent++;
      } catch (err) {
        logger.warn(`[${tag(ds)}] private /card ephemeral send to ${openId.substring(0, 8)}… failed: ${err}`);
      }
    }));
  }
  logger.info(`[${tag(ds)}] private /card: ephemeral sent ${sent}/${audience.length}`);
  return { sent, total: audience.length, notReady: false };
}

/**
 * Deliver the write-enabled session card (the "🔑 获取操作链接" card, which carries
 * a write-token terminal URL + manage buttons) privately to a single operator.
 *
 * Prefers an in-chat "visible-to-you" ephemeral card in a flat group so the
 * operator never has to leave the conversation. Thread-scope sessions and
 * chat-scope sessions currently folded into a thread go straight to DM:
 * Feishu may accept their ephemeral message without rendering it in the topic
 * panel. p2p chats also DM directly (the DM lands in that same 1:1 chat).
 *
 * Other group chats attempt ephemeral first and fall back to DM on ANY failure.
 *
 * Both channels are private, so the DM fallback never leaks the write token —
 * unlike the private /card snapshot (which fails closed), here we fail OVER.
 *
 * Returns the channel actually used, or 'failed' if both errored.
 */
export async function deliverWriteLinkCard(
  ds: DaemonSession,
  operatorOpenId: string,
  cardJson: string,
): Promise<'ephemeral' | 'dm' | 'failed'> {
  const who = operatorOpenId.substring(0, 8);
  const replyTarget = ds.currentReplyTarget ?? ds.session.currentReplyTarget;
  const isThreaded = ds.scope === 'thread'
    || (!!replyTarget?.rootMessageId && replyTarget.quoteOnly !== true);
  if (ds.chatType !== 'p2p' && !isThreaded) {
    try {
      await sendEphemeralCard(ds.larkAppId, ds.chatId, operatorOpenId, cardJson);
      logger.info(`[${tag(ds)}] write link delivered via ephemeral card to ${who}…`);
      return 'ephemeral';
    } catch (err) {
      // Expected in topic/thread groups (18053); any other error is also safe to
      // retry via DM since the DM is private too.
      logger.info(`[${tag(ds)}] ephemeral write-link card unavailable here (${err}); falling back to DM`);
    }
  }
  try {
    await sendUserMessage(ds.larkAppId, operatorOpenId, cardJson, 'interactive');
    logger.info(`[${tag(ds)}] write link delivered via DM to ${who}…`);
    return 'dm';
  } catch (err) {
    logger.warn(`[${tag(ds)}] failed to deliver write link (ephemeral + DM both failed): ${err}`);
    return 'failed';
  }
}

export interface WriteLinkOwnerDelivery {
  ok: boolean;
  error?: 'terminal_unavailable' | 'terminal_unsupported' | 'no_owner' | 'delivery_failed';
  delivered: number;
  total: number;
  channels: Array<'ephemeral' | 'dm' | 'failed'>;
}

/**
 * Build the write-enabled session card (writable terminal URL + manage buttons)
 * for `ds`, or null when the terminal isn't up yet (no worker port/token).
 * Shared by the owner-fanout ({@link deliverWriteLinkCardToOwners}, behind
 * `botmux term-link`) and the single-operator delivery
 * ({@link deliverWritableTerminalCardTo}, behind the `/term` slash command).
 */
export function buildWritableTerminalCard(ds: DaemonSession): string | null {
  if (!sessionSupportsWebTerminal(ds)) return null;
  // Riff backend: the sandbox URL is the writable link — no local worker/token needed.
  if (ds.riffAccessUrl) {
    const botCfg = getBot(ds.larkAppId).config;
    const effectiveCliId = sessionCliId(ds, botCfg);
    return buildSessionCard(
      ds.session.sessionId,
      sessionAnchorId(ds),
      ds.riffAccessUrl,
      ds.session.title || sessionCliDisplayName(ds, botCfg),
      effectiveCliId,
      true,
      !!ds.adoptedFrom,
      localeForBot(ds.larkAppId),
      false,
      sessionRuntimeDisplayName(ds, botCfg),
    );
  }
  const port = ds.workerPort ?? ds.session.webPort;
  if (!port || !ds.workerToken) return null;
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  return buildSessionCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    buildTerminalUrl(ds, { write: true }),
    ds.session.title || sessionCliDisplayName(ds, botCfg),
    effectiveCliId,
    true,             // showManageButtons — write-link card includes restart & close
    !!ds.adoptedFrom, // adoptMode — disconnect, never close-the-CLI
    localeForBot(ds.larkAppId),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    sessionRuntimeDisplayName(ds, botCfg),
  );
}

/**
 * Build the write-enabled session card for `ds` and deliver it privately to the
 * bot's owner(s) — the payload behind the `botmux term-link` CLI command.
 *
 * Mirrors the in-chat "🔑 获取操作链接" button flow ({@link deliverWriteLinkCard}),
 * but fans out to the owner audience ({@link resolvePrivateCardAudience}) instead
 * of a single click-operator: a CLI caller has no Lark identity, so "deliver to
 * the owner(s)" is the closest equivalent of "deliver to the person who asked".
 * Each owner gets an in-chat visible-to-you ephemeral card, auto-falling back to
 * a private DM in topic / p2p chats. The write token therefore only ever rides
 * these private channels — it is never returned to the CLI caller / stdout.
 */
export async function deliverWriteLinkCardToOwners(ds: DaemonSession): Promise<WriteLinkOwnerDelivery> {
  if (!sessionSupportsWebTerminal(ds)) {
    return { ok: false, error: 'terminal_unsupported', delivered: 0, total: 0, channels: [] };
  }
  const cardJson = buildWritableTerminalCard(ds);
  if (!cardJson) return { ok: false, error: 'terminal_unavailable', delivered: 0, total: 0, channels: [] };

  const audience = resolvePrivateCardAudience(ds);
  if (audience.length === 0) return { ok: false, error: 'no_owner', delivered: 0, total: 0, channels: [] };

  const channels: Array<'ephemeral' | 'dm' | 'failed'> = [];
  // Cap concurrency like postPrivateSnapshotCard (Feishu ephemeral ~50/s total).
  const CONCURRENCY = 5;
  for (let i = 0; i < audience.length; i += CONCURRENCY) {
    const batch = audience.slice(i, i + CONCURRENCY);
    channels.push(...await Promise.all(batch.map(openId => deliverWriteLinkCard(ds, openId, cardJson))));
  }
  const delivered = channels.filter(c => c !== 'failed').length;
  return {
    ok: delivered > 0,
    error: delivered > 0 ? undefined : 'delivery_failed',
    delivered,
    total: audience.length,
    channels,
  };
}

/**
 * Deliver the writable-terminal card privately to a single operator — the `/term`
 * slash command's payload (the owner who typed it; owner-gated in command-handler).
 * Same private ephemeral→DM channel as the "🔑 获取操作链接" card button. Returns
 * 'not_ready' when the terminal isn't up yet, else the channel actually used.
 */
export async function deliverWritableTerminalCardTo(
  ds: DaemonSession,
  operatorOpenId: string,
): Promise<'ephemeral' | 'dm' | 'failed' | 'not_ready' | 'unsupported'> {
  if (!sessionSupportsWebTerminal(ds)) return 'unsupported';
  const cardJson = buildWritableTerminalCard(ds);
  if (!cardJson) return 'not_ready';
  return deliverWriteLinkCard(ds, operatorOpenId, cardJson);
}

export interface SubstituteControlCardDelivery {
  sent: number;
  total: number;
}

/**
 * Build the private owner control card used by substitute-mode sessions.
 * Web-capable backends keep the writable-terminal card; backends without a
 * Web Terminal (currently ZMX) still need restart / close controls.
 */
function buildSubstituteControlCard(ds: DaemonSession): string | null {
  const writableCard = buildWritableTerminalCard(ds);
  if (writableCard) return writableCard;

  // A Web-capable backend returning null simply is not ready yet. Preserve the
  // existing retry-on-next-ready behavior instead of sending a partial card.
  if (sessionSupportsWebTerminal(ds)) return null;

  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  return buildSessionCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    '', // Manage-only: this backend intentionally has no Web Terminal URL.
    ds.session.title || sessionCliDisplayName(ds, botCfg),
    effectiveCliId,
    true,
    !!ds.adoptedFrom,
    localeForBot(ds.larkAppId),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    sessionRuntimeDisplayName(ds, botCfg),
  );
}

/**
 * DM a control card to the bot's owner(s) for a substitute-mode session.
 * ZMX receives a manage-only card because it has no Web Terminal surface.
 * Guards against duplicate sends via `session.substituteControlCardSent`.
 */
export async function deliverSubstituteControlCard(ds: DaemonSession): Promise<SubstituteControlCardDelivery> {
  if (ds.session.substituteControlCardSent) return { sent: 0, total: 0 };
  const cardJson = buildSubstituteControlCard(ds);
  if (!cardJson) {
    logger.warn(`[${tag(ds)}] substitute control card skipped: terminal not ready`);
    return { sent: 0, total: 0 };
  }

  const audience = resolvePrivateCardAudience(ds);
  if (audience.length === 0) {
    logger.debug(`[${tag(ds)}] substitute control card skipped: no owner audience`);
    return { sent: 0, total: 0 };
  }

  let sent = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < audience.length; i += CONCURRENCY) {
    const batch = audience.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (openId) => {
      try {
        await sendUserMessage(ds.larkAppId, openId, cardJson, 'interactive');
        sent++;
      } catch (err) {
        logger.warn(`[${tag(ds)}] substitute control card DM to ${openId.substring(0, 8)}… failed: ${err instanceof Error ? err.message : err}`);
      }
    }));
  }

  if (sent > 0) {
    ds.session.substituteControlCardSent = true;
    sessionStore.updateSession(ds.session);
    logger.info(`[${tag(ds)}] substitute control card DM'd to ${sent}/${audience.length} owner(s)`);
  }

  return { sent, total: audience.length };
}

/**
 * Deliver a status confirmation (restart / session-closed / resume) as a
 * "visible-to-the-operator-only" ephemeral message in a plain group; on failure
 * (topic groups reject with 18053) or in p2p, fall back to the normal visible
 * reply (`reply`). `content` is the card JSON when msgType==='interactive',
 * otherwise the plain text. Topic-group / p2p behavior is unchanged.
 *
 * IMPORTANT: ephemeral is only attempted for flat **chat-scope** sessions. The
 * ephemeral API (`ephemeral/v1/send`) takes a `chat_id` only — it has no
 * thread/root anchoring — so for a **thread-scope** session (a 话题 inside a
 * 普通群, or a 话题群 topic) an ephemeral card would escape the topic and land at
 * the group top-level. 话题群 happened to reject ephemeral with 18053 and fall
 * back to the in-thread reply, but a 话题 inside a 普通群 succeeds and leaks the
 * card out of the thread. So thread-scope sessions always take the visible
 * `reply()` path, which routes back into the thread (`reply_in_thread`).
 */
export async function deliverEphemeralOrReply(
  ds: DaemonSession,
  operatorOpenId: string | undefined,
  content: string,
  msgType: 'text' | 'interactive',
  reply: () => Promise<unknown>,
): Promise<void> {
  if (operatorOpenId && ds.chatType !== 'p2p' && ds.scope === 'chat') {
    try {
      // The ephemeral API is card-only (msg_type=text → 10003), so wrap a plain
      // confirmation line into a minimal markdown card.
      const cardJson = msgType === 'interactive' ? content : JSON.stringify({
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content }],
      });
      await sendEphemeralCard(ds.larkAppId, ds.chatId, operatorOpenId, cardJson);
      return;
    } catch (err) {
      // Topic groups (18053) / other → not ephemeral-capable here; reply visibly.
      logger.info(`[${tag(ds)}] ephemeral confirmation unavailable here (${err}); sending visibly`);
    }
  }
  await reply();
}

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
export function scheduleCardPatch(ds: DaemonSession, cardJson: string, turnId?: string): void {
  // Defense-in-depth transport gate: a no-transport session (apiOnly bot or HTTP
  // virtual chat) has no real Feishu card to PATCH. Callers already suppress via
  // managedAuxUiSuppressed, but guarding the flush entry too means a stray direct
  // call can never dial updateMessage on a synthetic id.
  if (!larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })) return;
  // Bot opted out of the streaming card — never patch one into existence.
  // Turn-exact when the caller has turn context (screen updates): a substitute
  // turn arriving mid-PATCH must not suppress a normal turn's card (or vice
  // versa) just because it overwrote the latest-turn slot.
  if (streamingCardDisabled(ds, turnId)) return;
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
        // Only clear streamCardId when the withdrawn message is still the
        // active one. With auto-recall a new turn may have advanced
        // ds.streamCardId past `cardId` while this PATCH was in flight (the
        // recall on the new POST deletes the previous card, which surfaces
        // here as MessageWithdrawnError). Clearing unconditionally would
        // forget the live new card and trigger a duplicate POST on the next
        // screen_update.
        if (ds.streamCardId === cardId) {
          logger.warn(`[${tag(ds)}] Stream card withdrawn, clearing reference`);
          ds.streamCardId = undefined;
          persistStreamCardState(ds);
        } else {
          logger.debug(`[${tag(ds)}] Stale card ${cardId.substring(0, 12)} withdrawn (current: ${ds.streamCardId?.substring(0, 12) ?? 'none'})`);
        }
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

/** Root withdrawal is not an explicit abandon boundary. Preserve a Codex App
 * owner (including its live worker) while any durable FIFO entry is unsettled;
 * only ledger-empty sessions retain the historical stale-root auto-close. */
async function closeWithdrawnSessionIfLedgerEmpty(
  ds: DaemonSession,
  context: string,
): Promise<boolean> {
  if (hasProtectedSessionMutationOwnership(ds)) {
    logger.warn(`[${tag(ds)}] ${context}; preserving session because Codex App dispatch is unsettled`);
    return false;
  }
  logger.warn(`[${tag(ds)}] ${context}; closing ledger-empty stale session`);
  // The callback routes through the authoritative async closeSession helper;
  // never pre-kill a worker before that helper settles its backend boundary.
  try {
    const closed = await requireCallbacks().closeSession(ds);
    if (closed === false) {
      logger.warn(`[${tag(ds)}] ${context}; authoritative close failed, session retained for retry`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(
      `[${tag(ds)}] ${context}; authoritative close threw, session retained for retry: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
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
  const adapter = createCliAdapterSync(cliId, cliPathOverride);
  if (cliId === 'traex') {
    cleanupTraexAskHooks([
      join(traeHome(), 'hooks.json'),
      join(traeHome(), 'cli', 'hooks.json'),
    ]);
  }

  // Claude-family CLIs deliver skills per-session via `--plugin-dir` (no global
  // leak), so they always materialise their plugin dir — the builtin-injection
  // mode does not apply to them. Everything below the branch is the global-dir
  // path (codex/gemini/opencode/…) where the mode decides whether we install.
  if (adapter.pluginDir) {
    const pluginSkillsDir = join(adapter.pluginDir, 'skills');
    // 白板 skill 每次 spawn 重新评估（跟随运行时开关），不进 once-cache。
    ensureWhiteboardSkill(cliId, pluginSkillsDir, whiteboardEnabled());
    if (skillsInstalledCliIds.has(cliId)) return;
    ensurePluginSkills(cliId, adapter.pluginDir);
    if (adapter.hookInstall) {
      try { installHook(cliId, adapter.hookInstall, hookCommandFor(cliId)); }
      catch (err) { logger.warn(`[hook] install failed for ${cliId}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    if (adapter.ensureAskHook) {
      try { adapter.ensureAskHook(); }
      catch (err) { logger.warn(`[hook] ensureAskHook failed for ${cliId}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    ensureAskSkill(cliId, pluginSkillsDir, !adapter.asksViaHook);
    skillsInstalledCliIds.add(cliId);
    return;
  }

  // Global-skillsDir CLIs: only write the shared dir when SOME bot on that dir
  // resolves to `global` mode. `prompt`/`off` keep the dir clean so the user's
  // own standalone `codex`/`gemini` never sees (and mis-fires) botmux skills —
  // those modes deliver the skills via the session prompt instead (see
  // session-manager buildNewTopicPrompt + skills/injection-mode.ts).
  const skillsDir = adapter.skillsDir;
  const globalInstall = skillsDir ? shouldInstallGlobalSkills(skillsDir) : false;
  // 白板 skill + 泄漏清理都**每次 spawn 重新评估**（在 once-cache 之前），保证在
  // CLI 真正执行前生效——而不仅在 daemon 启动那一次：
  //  - 白板：跟随运行时开关，仅 global 模式落全局盘。
  //  - prompt/off 泄漏清理：每个新会话拉起 CLI 前，把共享 skills 目录里的 botmux
  //    技能清掉。这样「运行时从 global 切到 prompt/off」「旧版本或外部重新写入的
  //    残留」都会在下一个会话的 CLI 启动前被扫干净，用户手动跑的独立 codex/gemini
  //    立刻不再看到 botmux 技能，无需等 daemon 重启。只动 `botmux-` 命名空间，
  //    绝不碰用户自定义 skill。
  ensureWhiteboardSkill(cliId, skillsDir, globalInstall && whiteboardEnabled());
  if (!globalInstall && skillsDir) removeGlobalBotmuxSkills(skillsDir);

  if (skillsInstalledCliIds.has(cliId)) return;
  // 安装是稳定动作，留在 once-cache 里跑一次即可（幂等，内容相同不重写）。
  if (globalInstall) ensureSkills(cliId, skillsDir);
  // askUserQuestion 接管策略与 skill 文件无关：hook 该装还得装（Codex 无 hook，
  // 靠 botmux-ask skill / catalog 兜底）。
  if (adapter.hookInstall) {
    try { installHook(cliId, adapter.hookInstall, hookCommandFor(cliId)); }
    catch (err) { logger.warn(`[hook] install failed for ${cliId}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (adapter.ensureAskHook) {
    try { adapter.ensureAskHook(); }
    catch (err) { logger.warn(`[hook] ensureAskHook failed for ${cliId}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  // botmux-ask 兜底 skill 也只在 global 模式落全局盘；prompt 模式它进 catalog，
  // off 模式靠 `botmux ask`（见 help）。
  ensureAskSkill(cliId, skillsDir, globalInstall && !adapter.asksViaHook);
  skillsInstalledCliIds.add(cliId);
}

/**
 * Ensure per-CLI environment is set up for this daemon lifecycle: install
 * built-in skills and the single stable Botmux MCP Gateway entry.
 * Both steps are idempotent and best-effort.
 */
export function ensureCliEnv(cliId: CliId, cliPathOverride?: string): void {
  cleanupGlobalBotmuxSkillsOnce();
  ensureCliSkills(cliId, cliPathOverride);
  const report = ensureGatewayEntry(createCliAdapterSync(cliId, cliPathOverride));
  if (report.warning) logger.warn(`[mcp-gateway] ${cliId}: ${report.warning}`);
}

/** The user's global skills dir that botmux must NOT pollute (Claude now injects
 *  its skills per-session via `--plugin-dir`). Single source of truth for the
 *  path so the early once-pass and the post-restore re-sweep stay in sync. */
const GLOBAL_CLAUDE_SKILLS_DIR = '~/.claude/skills';

/** Unconditionally sweep botmux-owned skills out of the user's global
 *  `~/.claude/skills`. botmux owns the `botmux-` namespace there and injects its
 *  skills per-session via `--plugin-dir`, so anything matching is a leak that
 *  would otherwise surface (and mis-fire) in the user's standalone `claude`.
 *  Idempotent & best-effort — safe to call repeatedly. */
export function sweepGlobalBotmuxSkills(): void {
  removeGlobalBotmuxSkills(GLOBAL_CLAUDE_SKILLS_DIR);
}

let globalBotmuxSkillsCleaned = false;
/** One-time, CLI-independent cleanup of botmux skills that older versions
 *  installed into the global `~/.claude/skills`. Runs early at daemon startup
 *  via ensureCliEnv (CLI-independent: the leak surfaces in standalone `claude`
 *  no matter which CLI THIS daemon's bot uses, so it must NOT be gated on
 *  `adapter.pluginDir`). NOTE: this early pass can lose a restart race — an
 *  outgoing old-build daemon may re-create the dirs a few ms later — so
 *  {@link sweepGlobalBotmuxSkills} is called again post-restore (see daemon.ts)
 *  to catch that on the same startup instead of leaving it until next restart. */
function cleanupGlobalBotmuxSkillsOnce(): void {
  if (globalBotmuxSkillsCleaned) return;
  globalBotmuxSkillsCleaned = true;
  sweepGlobalBotmuxSkills();
}

// ─── Claude Code folder-trust pre-acceptance ─────────────────────────────────
//
// A freshly spawned `claude` in a workingDir that has never been trusted blocks
// on the interactive "Do you trust the files in this folder?" dialog. botmux
// can't answer it — it then mistypes the user's first message into the dialog
// and the session breaks (surfaced as `tmux send-keys … failed`). There is no
// CLI flag to skip it (Claude only auto-skips trust in non-interactive `-p` /
// non-TTY mode, which botmux is not), so we pre-seed the acceptance.

/** Pre-accept Claude Code's per-project folder-trust dialog for `workingDir`.
 *  Claude keys trust off realpath(cwd) (its getcwd(3) is already realpath'd),
 *  so seed that path. Merge-safe + best-effort: only ADDS the flag, never
 *  clobbers other keys; any failure is swallowed so it can't block spawn. */
export function ensureClaudeFolderTrust(workingDir: string, stateJsonPath: string = join(homedir(), '.claude.json')): void {
  try {
    const configPath = stateJsonPath;
    let canonical: string;
    try { canonical = realpathSync(workingDir); } catch { canonical = workingDir; }

    let data: any = {};
    if (existsSync(configPath)) {
      try { data = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { return; }
    }
    if (!data || typeof data !== 'object') return;
    if (!data.projects || typeof data.projects !== 'object') data.projects = {};

    const entry = data.projects[canonical] && typeof data.projects[canonical] === 'object'
      ? data.projects[canonical]
      : (data.projects[canonical] = {});
    if (entry.hasTrustDialogAccepted === true) return; // already trusted — skip write

    entry.hasTrustDialogAccepted = true;
    // 原子写：~/.claude.json 是 Claude Code 的热状态文件，所有并发 claude
    // 实例都在读写，裸写半截会弄坏它们的状态。
    atomicWriteFileSync(configPath, JSON.stringify(data, null, 2));
    logger.info(`[claude-trust] Pre-accepted folder trust for ${canonical}`);
  } catch (err) {
    logger.debug(`[claude-trust] seed failed (ignored): ${err}`);
  }
}

// ─── Kill worker ────────────────────────────────────────────────────────────

export function killWorker(ds: DaemonSession): void {
  restartCoordinator.cancelSession(ds.session.sessionId);
  clearUsageLimitState(ds);
  ds.workerReady = false;
  clearUsageRefreshTimer(ds);
  ds.localProcessAttestation = undefined;
  // A managed-turn capability belongs to one concrete worker generation.
  // Retiring (or observing the absence of) that generation must revoke the
  // daemon-side copy synchronously; the worker may never get a chance to send
  // its ordered revoke IPC on close/crash paths.
  ds.managedTurnOrigin = undefined;
  // The worker/CLI generation is ending — any outstanding stuck-warning card
  // must be invalidated so a late click cannot inject keys into a replacement
  // worker (or into nothing, if no replacement comes).
  invalidateStuckWarning(ds, 'killWorker');
  invalidateTuiPrompt(ds, 'killWorker');
  if (!ds.worker || ds.worker.killed) {
    // No live worker to receive {type:'close'}, so its destroySession() — which
    // tears down the persistent backing session (tmux/herdr/zellij/zmx) — never
    // fires. Those sessions survive a worker exit BY DESIGN (idle-suspend /
    // lazy-restore keep the CLI alive for later resume), so /close on such a
    // session would leave an orphaned CLI running in tmux that still replies.
    // Destroy the backing session directly here so /close always terminates it.
    destroyOrphanedBackingSession(ds);
    return;
  }
  try {
    ds.worker.send({ type: 'close' } as DaemonToWorker);
  } catch { /* IPC already closed */ }
  const w = ds.worker;
  trackLifecycleRetirement(ds, w);
  armCloseFence(ds, w);
  // riff：worker close 分支要有界 await 远端 task-cancel（destroySession 5s×2 重试，
  // 外层 race 8s）。默认 2s SIGTERM backstop 会在取消发出前掐死进程，已关闭话题
  // 的远端任务照跑——冻结为 riff 的会话放宽到 24s（层级：destroy 20s < worker 22s
  // < SIGTERM 24s < SIGKILL 29s；正常路径 worker 自行 exit，不会等满）。
  const closeFrozenType = ds.initConfig?.backendType ?? ds.session.backendType;
  armWorkerKillBackstop(w, tag(ds), closeFrozenType === 'riff' ? 24_000 : WORKER_SIGTERM_BACKSTOP_MS);
  ds.worker = null;
  ds.workerPort = null;
  ds.workerToken = null;
  ds.workerViewToken = null;
}

function clearTransferWorkerState(
  ds: DaemonSession,
  worker: ChildProcess | null,
  reason: string,
): void {
  restartCoordinator.cancelSession(ds.session.sessionId);
  clearUsageLimitState(ds);
  ds.workerReady = false;
  ds.localProcessAttestation = undefined;
  ds.managedTurnOrigin = undefined;
  invalidateStuckWarning(ds, reason);
  invalidateTuiPrompt(ds, reason);
  if (!worker || ds.worker === worker || ds.worker === null) {
    ds.worker = null;
    ds.workerPort = null;
    ds.workerToken = null;
    ds.workerViewToken = null;
  }
}

/**
 * Retire the old worker generation during a routing transfer without applying
 * ordinary `/close` semantics to its backend.
 *
 * The replacement worker reuses the same logical session after this completion
 * fence. Sending `close` here would call `destroySession()` in the old worker
 * and race that replacement's persistent-backend reattach. A worker-less
 * session is already detached, so unlike killWorker() this path must never
 * destroy its orphaned backing resource.
 */
export async function detachWorkerForTransfer(
  ds: DaemonSession,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const w = ds.worker;
  if (!w) {
    clearTransferWorkerState(ds, null, 'detachWorkerForTransfer:no_worker');
    return true;
  }
  if (w.killed && (w.exitCode !== null || w.signalCode !== null)) {
    clearTransferWorkerState(ds, w, 'detachWorkerForTransfer:already_exited');
    return true;
  }

  const requestId = randomUUID();
  transferRetiringWorkers.add(w);
  let acked = false;
  let exited = w.exitCode !== null || w.signalCode !== null;
  let finish!: (completed: boolean) => void;
  const completion = new Promise<boolean>((resolve) => { finish = resolve; });
  const maybeFinish = (): void => {
    if (acked && exited) finish(true);
  };
  // Once the worker ACKs, its observer is already detached (killCli ran); the
  // process itself is disposable. A healthy worker exits within a few ms, but a
  // web-terminal client PTY makes node-pty's process.exit() teardown wedge the
  // process for the whole fence (JS loop already stopped → it can't self-kill).
  // So on ACK, arm a short grace timer, then SIGKILL — turning an 8s stall into
  // a ~300ms one. Cleared if the worker exits on its own first.
  let postAckKillTimer: ReturnType<typeof setTimeout> | undefined;
  const armPostAckKill = (): void => {
    if (postAckKillTimer || exited) return;
    postAckKillTimer = setTimeout(() => {
      if (exited) return;
      logger.info(`[${tag(ds)}] Detach ACK received but worker still alive after ${TRANSFER_DETACH_POST_ACK_KILL_MS}ms (node-pty exit wedge); SIGKILL`);
      try { w.kill('SIGKILL'); } catch { /* already gone */ }
    }, TRANSFER_DETACH_POST_ACK_KILL_MS);
    postAckKillTimer.unref?.();
  };
  const onMessage = (raw: unknown): void => {
    const msg = raw as Partial<WorkerToDaemon>;
    if (msg.type !== 'transfer_detached' || msg.requestId !== requestId) return;
    acked = true;
    armPostAckKill();
    maybeFinish();
  };
  const onExit = (): void => {
    exited = true;
    if (postAckKillTimer) { clearTimeout(postAckKillTimer); postAckKillTimer = undefined; }
    maybeFinish();
  };
  w.on('message', onMessage);
  w.on('exit', onExit);
  const timeout = setTimeout(() => finish(false), opts.timeoutMs ?? TRANSFER_DETACH_FENCE_MS);
  timeout.unref?.();

  // Do not await ChildProcess.send() itself: its callback can stall forever.
  // The independent completion timer is the authority for this bounded fence.
  void sendWorkerIpc(w, { type: 'detach_for_transfer', requestId })
    .catch(() => finish(false));
  const completed = await completion;
  if (postAckKillTimer) { clearTimeout(postAckKillTimer); postAckKillTimer = undefined; }

  // A timed-out detach request may still be queued in Node's IPC channel and
  // arrive later. Never hand new input back to that uncertain worker. SIGKILL
  // skips its ordinary process-exit cleanup, preserving sandbox state and the
  // persistent backing for a source-route cold reattach.
  if (!completed && !exited) {
    logger.warn(`[${tag(ds)}] Transfer detach timed out; hard-retiring old worker`);
    const forcedExit = new Promise<boolean>((resolve) => {
      let settled = false;
      let forcedTimeout: ReturnType<typeof setTimeout>;
      const finish = (didExit: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(forcedTimeout);
        w.off('exit', onForcedExit);
        resolve(didExit);
      };
      const onForcedExit = (): void => finish(true);
      w.once('exit', onForcedExit);
      forcedTimeout = setTimeout(() => finish(false), TRANSFER_FORCE_EXIT_MS);
      forcedTimeout.unref?.();
    });
    try { w.kill('SIGKILL'); } catch { /* already gone */ }
    exited = await forcedExit || exited;
  }

  clearTimeout(timeout);
  w.off('message', onMessage);
  w.off('exit', onExit);
  if (!completed || (ds.worker !== w && ds.worker !== null)) {
    if (exited) clearTransferWorkerState(ds, w, 'detachWorkerForTransfer:forced_exit');
    logger.warn(
      `[${tag(ds)}] Transfer detach fence failed; source routing remains unchanged`,
    );
    return false;
  }

  clearTransferWorkerState(ds, w, 'detachWorkerForTransfer');
  return true;
}

/**
 * Whether a worker-less restart must first destroy the session's persistent
 * backing pane. Adopt sessions are excluded — botmux never owned the user's
 * pane, so killing it would violate the bridge invariant. Pure so the
 * adopt-skip decision is unit-testable without spawning a worker.
 */
export function shouldDestroyPaneBeforeRestart(
  ds: Pick<DaemonSession, 'initConfig' | 'adoptedFrom'>,
): boolean {
  return !ds.initConfig?.adoptMode && !ds.adoptedFrom;
}

/**
 * Destroy a still-alive persistent backing pane (tmux/herdr/zellij/zmx) before a
 * worker-less restart forks a fresh worker. Without this, a session that lost
 * its worker but kept its pane (the normal post-daemon-restart state) would let
 * spawnCli REATTACH the surviving CLI instead of relaunching it — the CLI is
 * never actually restarted, yet prompt-ready still fires `restart_result:
 * succeeded`, so the user sees "restarted" while a wedged CLI stays wedged.
 * Killing the pane first forces a genuine physical fresh spawn, making the
 * success receipt truthful.
 *
 * Fail-safe (codex 复审观察): the kill primitives swallow their own failures
 * (TmuxBackend.killSession `catch {}`, Herdr `runHerdr` returns false), so a
 * plain try/catch here can NEVER observe a failed kill — a wedged tmux server
 * could leave the pane alive and the fork would silently reattach. So we PROBE
 * after killing and retry once if the pane survives, escalating to a loud warn
 * when it still exists. A surviving pane still forks (refusing would strand the
 * session with no restart at all, strictly worse than the original bug), but
 * the warn makes the rare failure diagnosable instead of a silent false
 * success. A fully reattach-proof path (forceFresh signal into spawnCli) is a
 * larger, separate change — tracked as a follow-up, not blocking this fix.
 *
 * Scope: persistent panes only (getSessionPersistentBackendType excludes riff,
 * which never reattaches — it always builds a fresh RiffBackend — and whose
 * remote task must survive a restart to preserve follow-up lineage). Adopt
 * sessions are skipped: botmux never owned the user's pane.
 */
function destroyLivePaneBeforeRestart(ds: DaemonSession): void {
  if (!shouldDestroyPaneBeforeRestart(ds)) return;
  const target = persistentBackendTargetForSession(ds);
  if (!target) return;

  const killOnce = (): void => {
    try {
      killPersistentBackendTarget(target, ds.session.sessionId);
    } catch (err) {
      // The primitives normally swallow their own errors; this only catches a
      // truly unexpected throw (e.g. target resolution). Non-fatal — the probe
      // below is the real signal.
      logger.warn(`[${tag(ds)}] restart: kill of ${target.backendType} pane threw: ${err}`);
    }
  };

  killOnce();
  // Advance a single probe result monotonically through the real retry path so
  // an 'unknown' first probe is never mislabelled as a post-retry survivor:
  //  - 'missing' → gone, fork is genuinely fresh.
  //  - 'unknown' → probe indeterminate (e.g. tmux server hiccup); do NOT retry
  //    and do NOT block the restart — pre-fix always forked, stranding is worse.
  //  - 'exists'  → confirmed alive: warn, kill once more, re-probe. Only this
  //    branch performs (and can report) a retry.
  let probe = probePersistentBackendTarget(target);
  if (probe === 'exists') {
    logger.warn(`[${tag(ds)}] restart: ${target.backendType} pane survived first kill — retrying before refork`);
    killOnce();
    probe = probePersistentBackendTarget(target);
  }
  if (probe === 'exists') {
    // The kill genuinely failed (twice). Forking will likely reattach the live
    // pane (the very bug this guards), so the eventual `restart_result:
    // succeeded` may again be untruthful — but leave a loud, greppable trail.
    logger.error(
      `[${tag(ds)}] restart: ${target.backendType} pane STILL alive after retry — `
      + 'the refork may reattach instead of relaunching (restart success may be untruthful)',
    );
  } else if (probe === 'unknown') {
    // Do NOT over-promise a relaunch: an indeterminate probe could still be a
    // live pane the fork reattaches. Fork proceeds (stranding is worse) but the
    // diagnostic must not claim a fresh relaunch it can't guarantee.
    logger.warn(
      `[${tag(ds)}] restart: ${target.backendType} kill outcome indeterminate — `
      + 'refork may reattach instead of relaunching',
    );
  } else {
    logger.info(
      `[${tag(ds)}] restart: ${target.backendType} pane missing after kill — CLI will physically relaunch`,
    );
  }
}

/**
 * Live-worker /restart 携带的最新 per-bot env（bots.json `env`）。worker 收到
 * restart 时在 respawn 前全量覆盖 lastInitConfig.env —— 否则 live-worker 重启
 * 一直用 fork 时刻的旧快照，dashboard 改完 env（如切 provider 的
 * ANTHROPIC_BASE_URL/TOKEN）后 /restart 并不会生效（只有 refork 路径生效）。
 * 三分态返回：对象 = 最新 env；null = 明确清空（dashboard 已删）；
 * undefined = 取不到（bot 已注销等异常），让 worker 保持快照不动（=旧行为）。
 * 只热更 env 一个字段：sandbox/backendType 是刻意 freeze-once 的设计（见
 * forkWorker init 注释），cliId 换 CLI 会踩 resume transcript 对齐，均不带。
 */
export function latestPerBotEnvForRestart(ds: DaemonSession): Record<string, string> | null | undefined {
  try {
    return getBot(ds.larkAppId).config.env ?? null;
  } catch {
    return undefined;
  }
}

/** Join or start one correlated physical restart for a session. */
export function requestSessionRestart(
  ds: DaemonSession,
  observer: RestartObserver,
): { attemptId: string; joined: boolean } | undefined {
  if (isSessionTransferring(ds)) {
    logger.warn(`[${tag(ds)}] Restart refused while routing transfer is in progress`);
    return undefined;
  }
  return restartCoordinator.request(ds.session.sessionId, observer, attemptId => {
    if (ds.worker && !ds.worker.killed) {
      ds.workerReady = false;
      ds.worker.send({ type: 'restart', attemptId, env: latestPerBotEnvForRestart(ds) } as DaemonToWorker);
      return;
    }
    // No live worker but the persistent pane may still be alive (e.g. after a
    // daemon restart). Tear it down first so forkWorker → spawnCli spawns a
    // fresh CLI instead of reattaching the old one and falsely reporting a
    // successful restart.
    destroyLivePaneBeforeRestart(ds);
    forkWorker(ds, '', {
      resume: ds.hasHistory,
      restartAttemptId: attemptId,
    });
  });
}

export function __testOnly_resetRestartCoordinator(): void {
  restartCoordinator.reset();
}

/**
 * Tear down a persistent backing session (tmux/herdr/zellij/zmx) directly from the
 * daemon when there is no live worker to do it via the 'close' IPC. The session
 * name is deterministic from the session UUID, and each killSession() is a no-op
 * if the session is already gone.
 *
 * Adopt sessions are skipped: botmux never owned the user's pane (ownsSession is
 * false worker-side too), so killing it would violate the bridge invariant of
 * leaving the user's own CLI untouched.
 */
function destroyOrphanedBackingSession(ds: DaemonSession): void {
  if (ds.initConfig?.adoptMode || ds.adoptedFrom) return;
  reclaimParkedCrashDiagnostic(ds);
  // riff：worker 已死时 /close 仍要取消持久化血缘指向的远端任务——否则已关闭
  // 话题的远端 agent 继续拿着注入凭证发消息。fire-and-forget（内部有界+重试）。
  const frozenType = ds.initConfig?.backendType ?? ds.session.backendType;
  if (frozenType === 'riff') {
    const taskId = ds.session.riffParentTaskId;
    if (taskId) {
      try {
        const riffCfg = getBot(ds.larkAppId).config.riff;
        if (riffCfg?.baseUrl) {
          void cancelRiffTaskById(riffCfg, taskId).then((ok) => {
            if (ok) logger.info(`[${tag(ds)}] killWorker: orphan riff task ${taskId} cancelled`);
          });
        }
      } catch { /* bot deregistered — nothing to cancel with */ }
      ds.session.riffParentTaskId = undefined;
      sessionStore.updateSession(ds.session);
    }
    return;
  }
  const backendType = getSessionPersistentBackendType(ds);
  if (!backendType) return;
  try {
    killPersistentBackendTarget(persistentBackendTargetForSession(ds)!, ds.session.sessionId);
    logger.info(`[${tag(ds)}] killWorker: no live worker — destroyed orphaned ${backendType} backing session`);
  } catch (err) {
    logger.warn(`[${tag(ds)}] killWorker: failed to destroy orphaned ${backendType} backing session: ${err}`);
  }
}

/**
 * Reclaim a session's parked crash-diagnostic shell (`bmx-diag-<sid>`) and its
 * captured `.ansi` file. The worker normally tears these down itself (killCli /
 * suspend / next-message retry), but it CAN'T when it is hard-killed
 * (OOM/SIGKILL) while parked — then the daemon must do it, on the next refork
 * (forkWorker) or on close (destroyOrphanedBackingSession). Both ops are no-ops
 * when absent, so this is safe to call unconditionally for tmux sessions.
 */
function reclaimParkedCrashDiagnostic(ds: DaemonSession): void {
  if (getSessionPersistentBackendType(ds) !== 'tmux') return;
  try { TmuxBackend.killSession(TmuxBackend.diagnosticSessionName(ds.session.sessionId)); } catch { /* benign */ }
  try { unlinkSync(join(config.session.dataDir, 'crash-diagnostics', `${ds.session.sessionId}.ansi`)); } catch { /* absent — benign */ }
}

export function suspendWorker(ds: DaemonSession, reason = 'suspended_idle'): boolean {
  if (hasProtectedSessionMutationOwnership(ds)) {
    logger.warn(`[${tag(ds)}] Refused worker suspend (${reason}) while Codex App dispatch ownership is non-empty`);
    return false;
  }
  if (isSessionTransferring(ds)) {
    logger.warn(`[${tag(ds)}] Suspend refused while routing transfer is in progress`);
    return false;
  }
  if (!ds.worker || ds.worker.killed) {
    ds.workerReady = false;
    // There is no live generation that can still own this capability.
    ds.managedTurnOrigin = undefined;
    invalidateTuiPrompt(ds, 'suspendWorker:no_worker');
    return false;
  }
  if (!isSuspendableBackendType(ds.initConfig?.backendType)) return false;

  const w = ds.worker;
  trackLifecycleRetirement(ds, w);
  try {
    w.send({ type: 'suspend' } as DaemonToWorker);
  } catch {
    try { w.kill('SIGTERM'); } catch { /* already gone */ }
  }
  armWorkerKillBackstop(w, tag(ds));

  ds.worker = null;
  ds.workerReady = false;
  ds.localProcessAttestation = undefined;
  ds.workerPort = null;
  ds.workerToken = null;
  ds.workerViewToken = null;
  ds.managedTurnOrigin = undefined;
  // The worker is being suspended — the CLI will be destroyed and cold-resumed
  // later. Invalidate any stuck-warning card so a late click cannot inject keys
  // after the CLI is gone (or into a different CLI on resume).
  invalidateStuckWarning(ds, 'suspendWorker');
  invalidateTuiPrompt(ds, 'suspendWorker');
  // Screen state describes the process we just stopped. Keeping it would make
  // the dashboard hydrate this process-less logical session as idle/working.
  ds.lastScreenStatus = undefined;
  ds.session.webPort = undefined;
  // The worker's suspend handler destroys the backing session + CLI (frees
  // memory), so there is no live CLI to reattach to: the next turn MUST
  // cold-resume from the on-disk transcript. forkWorker(resume=true) builds the
  // CLI's `--resume <cliSessionId>` args, so mark this session as having history
  // (the normal `claude_exit` path that sets this never fires on suspend —
  // process.exit(0) races it). Also persist `suspendedColdResume` to record the
  // deliberate parked state — since the host-reboot fix, restore keeps ANY
  // managed session with a 'missing' backing for lazy resume, so this marker no
  // longer gates that decision; it flags "intentionally parked, expect no
  // worker/pane" for the dormant status label and skips redundant liveness
  // probes. See sweepIdleWorkers + restoreActiveSessions.
  ds.hasHistory = true;
  ds.session.suspendedColdResume = true;
  sessionStore.updateSessionPid(ds.session.sessionId, null);
  sessionStore.updateSession(ds.session);

  if (!ds.exitEventEmitted) {
    ds.exitEventEmitted = true;
    dashboardEventBus.publish({
      type: 'session.update',
      body: {
        sessionId: ds.session.sessionId,
        patch: {
          status: 'dormant',
          webPort: null,
          workerPid: null,
        },
      },
    });
  }
  logger.info(`[${tag(ds)}] Worker + CLI suspended (${reason}); session stays active, cold-resumes from transcript on next message`);
  return true;
}

/**
 * Cash in a queued suspend. Called once the session leaves the producing states
 * it was queued for; a no-op during working/analyzing — that IS why it queued.
 *
 * Callers MUST defer this out of the status handler's synchronous body
 * (queueMicrotask) — suspendWorker clears `ds.worker` and `ds.lastScreenStatus`,
 * and the rest of that handler still reads both to record the usage delta, flip
 * the turn reaction ✋→✅, emit the state-transition hook, and render the final
 * card. Running it inline would skip exactly the turn-completion bookkeeping
 * this whole feature exists to protect.
 *
 * `ownsGeneration` is the calling handler's generation check (`ownsWorkerSession`)
 * and is REQUIRED for correctness, not a nicety: `screenshot_uploaded` writes
 * `lastScreenStatus` with no ownership check of its own, so a stale `idle` from a
 * replaced worker can land on a session that has since re-forked. Without this
 * check the microtask would then suspend the *replacement* worker — mid-reply —
 * which is the exact truncation bug this feature removes. A stale checkpoint
 * keeps the flag pending; only the owning generation may consume it.
 *
 * Deliberately the generation check ALONE, not `ownsLifecycleMutation` (which
 * also folds in "not transferring"): a routing transfer is a temporary refusal,
 * not a lost claim, and it is suspendWorker's own guard to make. Screen updates
 * stop once a session sits quiet, so treating transfer as "not ours" would park
 * the flag with no later checkpoint to revive it — hence the explicit
 * transfer-settled retry below.
 */
function runPendingSuspendIfSettled(ds: DaemonSession, ownsGeneration?: () => boolean): void {
  const reason = ds.pendingSuspendReason;
  if (!reason) return;
  if (ownsGeneration && !ownsGeneration()) return;
  const st = ds.lastScreenStatus;
  if (st !== 'idle' && st !== 'limited') return;
  // Worker already gone (crash / suspended by another path): the goal state is
  // reached, so drop the flag. Falling through to suspendWorker would take its
  // no-worker branch and clear managedTurnOrigin/workerReady for a generation
  // this queued request never owned.
  if (!ds.worker || ds.worker.killed) {
    ds.pendingSuspendReason = undefined;
    return;
  }
  // Clear only on success. suspendWorker refuses mid-routing-transfer (and for a
  // backend that stopped being suspendable), and that refusal is temporary —
  // eating the flag would silently drop the request until the next `suspend all`.
  if (suspendWorker(ds, reason)) {
    ds.pendingSuspendReason = undefined;
    logger.info(`[${tag(ds)}] Deferred suspend fulfilled (${reason}) after turn completed`);
    return;
  }
  // Refused by an in-flight transfer: keeping the flag is not enough on its own.
  // A settled session emits no further screen updates, so there may be no next
  // checkpoint — re-run when the relay gate releases. Returns false when no
  // transfer is active (a non-transfer refusal, e.g. pty), which needs no retry.
  deferUntilSessionTransferSettled(ds, () => runPendingSuspendIfSettled(ds, ownsGeneration));
}

export const __testOnly_runPendingSuspendIfSettled = runPendingSuspendIfSettled;

function armWorkerKillBackstop(w: ChildProcess, label: string, sigtermMs: number = WORKER_SIGTERM_BACKSTOP_MS): void {
  const sigterm = setTimeout(() => {
    if (w.exitCode === null && w.signalCode === null) {
      try { w.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }, sigtermMs);
  const sigkill = setTimeout(() => {
    if (w.exitCode === null && w.signalCode === null) {
      logger.warn(`[${label}] worker did not exit after SIGTERM; escalating to SIGKILL`);
      try { w.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, Math.max(WORKER_SIGKILL_BACKSTOP_MS, sigtermMs + 5000));
  sigterm.unref?.();
  sigkill.unref?.();
  w.once('exit', () => {
    clearTimeout(sigterm);
    clearTimeout(sigkill);
  });
}

type CloseFence = {
  sessionId: string;
  workerGeneration: number;
  promise: Promise<void>;
  resolve: () => void;
  worker: ChildProcess;
};

const closeFences = new Map<string, CloseFence>();

function closeFenceGeneration(ds: DaemonSession): number {
  return ds.workerGeneration ?? ds.session.workerGeneration ?? 0;
}

function closeFenceKey(sessionId: string, workerGeneration: number): string {
  return `${sessionId}:${workerGeneration}`;
}

function closeFenceFor(sessionId: string, workerGeneration: number | undefined): Promise<void> | undefined {
  if (workerGeneration === undefined) return undefined;
  return closeFences.get(closeFenceKey(sessionId, workerGeneration))?.promise;
}

function armCloseFence(ds: DaemonSession, worker: ChildProcess): Promise<void> {
  const sessionId = ds.session.sessionId;
  const workerGeneration = closeFenceGeneration(ds);
  const key = closeFenceKey(sessionId, workerGeneration);
  const existing = closeFences.get(key);
  if (existing) return existing.promise;

  let resolveFence!: () => void;
  const promise = new Promise<void>(resolve => { resolveFence = resolve; });
  const fence: CloseFence = {
    sessionId,
    workerGeneration,
    promise,
    resolve: resolveFence,
    worker,
  };
  closeFences.set(key, fence);
  sessionStore.registerSessionBridgeSendMarkerCleanupFence(sessionId, promise);
  const timer = setTimeout(() => {
    logger.warn(
      `[${sessionId.substring(0, 8)}] worker close fence still waiting; `
      + `generation=${workerGeneration}; bridge markers remain until ACK or worker exit`,
    );
  }, CLOSE_FENCE_WARN_MS);
  timer.unref?.();
  worker.once('exit', resolveFence);
  if (worker.exitCode != null || worker.signalCode != null) {
    queueMicrotask(resolveFence);
  }
  void promise.finally(() => {
    clearTimeout(timer);
    worker.off('exit', resolveFence);
    if (closeFences.get(key) === fence) closeFences.delete(key);
  });
  return promise;
}

function resolveCloseFence(sessionId: string, workerGeneration: number): void {
  closeFences.get(closeFenceKey(sessionId, workerGeneration))?.resolve();
}

// ─── Idempotent session close (dashboard IPC) ───────────────────────────────

type DocCommentReplyTarget = {
  fileToken: string;
  fileType: string;
  commentId: string;
  replyToOpenId?: string;
  replyToName?: string;
  replyId?: string;
  reactionId?: string;
};

function persistedDocCommentTarget(
  session: Session,
  turnId: string,
): DocCommentReplyTarget | undefined {
  return session.docCommentTargets?.[turnId];
}

/** Resolve the daemon-local target first, but fill cleanup identifiers from
 * the persisted per-turn route. After a daemon restart only the latter exists. */
function resolveDocCommentTarget(
  ds: DaemonSession,
  turnId: string,
): DocCommentReplyTarget | undefined {
  const memory = ds.docCommentTurns?.get(turnId);
  const persisted = persistedDocCommentTarget(ds.session, turnId);
  if (!memory) return persisted;
  if (!persisted) return memory;
  return {
    ...persisted,
    ...memory,
    replyId: memory.replyId ?? persisted.replyId,
    reactionId: memory.reactionId ?? persisted.reactionId,
  };
}

/** Consume one successfully-delivered document turn from both runtime and
 * persisted state. Persistence is best-effort: a reply that already landed
 * must never be retried (and duplicated) merely because local cleanup failed. */
function consumeDocCommentTurn(ds: DaemonSession, turnId: string): void {
  if (ds.docCommentTurns) {
    ds.docCommentTurns.delete(turnId);
    if (ds.docCommentTurns.size === 0) ds.docCommentTurns = undefined;
  }
  const targets = ds.session.docCommentTargets;
  if (targets?.[turnId]) {
    delete targets[turnId];
    if (Object.keys(targets).length === 0) ds.session.docCommentTargets = undefined;
    try { sessionStore.updateSession(ds.session); } catch { /* best-effort */ }
  }
}

function collectDocCommentReactionTargets(
  ds: DaemonSession | undefined,
  stored: Session | undefined,
): DocCommentReplyTarget[] {
  const unique = new Map<string, DocCommentReplyTarget>();
  const add = (target: DocCommentReplyTarget): void => {
    if (!target.replyId || !target.reactionId) return;
    const key = `${target.fileToken}\0${target.commentId}\0${target.replyId}\0${target.reactionId}`;
    unique.set(key, target);
  };
  if (ds?.docCommentTurns) {
    for (const target of ds.docCommentTurns.values()) add(target);
  }
  for (const target of Object.values(ds?.session.docCommentTargets ?? {})) add(target);
  if (stored && stored !== ds?.session) {
    for (const target of Object.values(stored.docCommentTargets ?? {})) add(target);
  }
  return [...unique.values()];
}

function clearAllDocCommentTurnState(ds: DaemonSession | undefined, stored: Session | undefined): void {
  if (ds) {
    ds.docCommentTurns = undefined;
    ds.session.docCommentTargets = undefined;
  }
  if (stored && stored !== ds?.session) stored.docCommentTargets = undefined;
}

function sessionAnchorForStoredRow(session: Session): string {
  return session.scope === 'chat' ? session.chatId : session.rootMessageId;
}

function isLegacyApiDocSubscription(managedBy: 'subscribe-lark-doc' | 'watch-comment' | undefined): boolean {
  return managedBy === undefined || managedBy === 'subscribe-lark-doc';
}

/**
 * Perform the close-time teardown that must be proven before callers mutate
 * the active registry or persisted Session row.
 *
 * ZMX is deliberately fail-closed: killManagedSession verifies the managed
 * UUID/generation and throws when ownership is ambiguous. Most close paths go
 * through closeSession(), but repo replacement reuses the live DaemonSession
 * object and therefore cannot call closeSession() without deleting the routing
 * generation it is about to repopulate. Those paths call this synchronous seam
 * first, while every bit of old-session state is still intact.
 *
 * Other backends retain their existing worker-side graceful teardown. Adopted,
 * queued, and already-closed rows never own a ZMX process to destroy.
 */
function teardownAuthoritativePersistentBackingBeforeCloseImpl(
  target: DaemonSession | Session,
  closeWinsTransfer: boolean,
): void {
  const ds = 'session' in target ? (target as DaemonSession) : undefined;
  const session = ds?.session ?? (target as Session);
  if (ds && isSessionTransferring(ds)) {
    if (!closeWinsTransfer) {
      throw new Error('session_transferring');
    }
    // Explicit close wins over relay. The old worker may already be handling
    // detach_for_transfer concurrently, so daemon-side teardown is the only
    // deterministic way to prevent that detach path from skipping ordinary
    // close cleanup (notably a surviving tmux/Herdr/ZMX pane or Riff task).
    destroyOrphanedBackingSession(ds);
  }
  const backendType = ds ? getSessionPersistentBackendType(ds) : session.backendType;
  if (
    backendType !== 'zmx'
    || ds?.initConfig?.adoptMode
    || ds?.adoptedFrom
    || session.adoptedFrom
    || session.queued
    || session.status === 'closed'
  ) return;

  killPersistentSession(
    'zmx',
    persistentSessionName('zmx', session.sessionId),
    session.sessionId,
  );
}

export function teardownAuthoritativePersistentBackingBeforeClose(
  target: DaemonSession | Session,
): void {
  teardownAuthoritativePersistentBackingBeforeCloseImpl(target, false);
}

/**
 * Idempotent close: kill worker if alive, mark Session status='closed' + closedAt,
 * publish session.exited (if a live worker was killed) and session.update
 * (if the persistence row transitioned to closed).
 *
 * Calling this on an unknown sessionId, an already-closed session, or a session
 * whose worker died asynchronously must still resolve with `{ ok: true }`.
 */
export async function closeSession(
  sessionId: string,
): Promise<{ ok: true; alreadyClosed: boolean; known: boolean }> {
  const ds = findActiveBySessionId(sessionId);
  const stored = sessionStore.getOwnedSession(sessionId);
  // Prove fail-closed ZMX teardown before any registry/store mutation. Repo
  // replacement paths reuse the same helper before their own state transition.
  const teardownTarget = ds ?? stored;
  if (teardownTarget) {
    teardownAuthoritativePersistentBackingBeforeCloseImpl(teardownTarget, true);
  }
  let killedLive = false;
  // 会话关闭即可回收其崩溃重启计数；否则每个曾崩溃过的 session 会在 daemon
  // 生命周期内永久占位（restartCounts 此前无任何 delete）。
  restartCounts.delete(sessionId);
  const hadLiveWorker = !!ds?.worker && !ds.worker.killed;
  const closeWorkerGeneration = ds ? closeFenceGeneration(ds) : undefined;
  // Snapshot ownership + transition state before mutating the live object:
  // sessionStore commonly holds the very same Session reference as `ds`.
  const known = !!ds || !!stored;
  const wasOpen = !!stored && stored.status !== 'closed';
  const storedHadDocCommentTargets = Object.keys(stored?.docCommentTargets ?? {}).length > 0;
  const docReactionTargets = collectDocCommentReactionTargets(ds, stored);
  // Per-turn comment routes are transient capabilities. Clear them from both
  // live and owner-scoped persisted objects inside the synchronous close
  // critical section, before any best-effort Lark cleanup can yield.
  clearAllDocCommentTurnState(ds, stored);
  // An idempotent re-close has no status transition for closeSession() to
  // persist, but stale per-turn capabilities must still be removed on disk.
  if (stored && !wasOpen && storedHadDocCommentTargets) {
    sessionStore.updateSession(stored);
  }
  if (ds) {
    // Usage ledger: flush the final delta before the worker goes away (a
    // crash/limited turn may never have reached an idle edge).
    recordUsageForDaemonSession(ds);
    killWorker(ds);
    const activeKey = activeSessionKey(ds);
    if (activeSessionsRegistry?.get(activeKey) === ds) {
      activeSessionsRegistry.delete(activeKey);
    }
    // Mark the captured object too. Async message/card paths may already hold a
    // reference to `ds`; deleting only the registry entry would not stop one of
    // those continuations from re-forking the closed session after its await.
    ds.session.status = 'closed';
    ds.session.closedAt ??= new Date().toISOString();
    killedLive = true;
  }

  // Mutations are bot-owner scoped. getSession() has a read-only cross-file
  // fallback for agent CLI discovery, so it must not authorize close.
  if (wasOpen) {
    if (!ds && stored) destroyUnregisteredPersistentBacking(stored);
    sessionStore.closeSession(sessionId, {
      cleanupBridgeMarkers: !hadLiveWorker,
    });
    const after = sessionStore.getOwnedSession(sessionId);
    if (ds) {
      ds.session.status = 'closed';
      ds.session.closedAt = after?.closedAt ?? ds.session.closedAt;
    }
  }

  if (ds) {
    if (!ds.exitEventEmitted) {
      ds.exitEventEmitted = true;
      dashboardEventBus.publish({
        type: 'session.exited',
        body: { sessionId, reason: 'dashboard_close' },
      });
      emitSessionLifecycleHook(ds, 'session.exit', { reason: 'dashboard_close' });
    }
  }

  // Persistence path — load → mark closed → save (delegated to sessionStore).
  // Mutations are bot-owner scoped. getSession() has a read-only cross-file
  // fallback for agent CLI discovery; using it here lets the wrong daemon see
  // another bot's active row, report a false successful close, then write only
  // its own file (a no-op). The CLI relies on alreadyClosed to decide whether a
  // legacy local fallback is safe, so owner proof must be real.
  if (wasOpen) {
    const after = sessionStore.getOwnedSession(sessionId);
    publishClosedSessionPatch(
      sessionId,
      after?.closedAt ? Date.parse(after.closedAt) : undefined,
      { tokenUsage: after ? composeRowFromClosed(after).tokenUsage : null },
    );
  }

  if (wasOpen && hadLiveWorker) {
    await closeFenceFor(sessionId, closeWorkerGeneration);
    sessionStore.cleanupSessionBridgeSendMarkersNow(sessionId);
  }

  // All authoritative map/status/store/event state above transitions
  // synchronously, before the first await. Lark reaction/unsubscribe cleanup is
  // best-effort and can be slow; it must not leave a resurrection window.
  const cleanupAppId = ds?.larkAppId ?? stored?.larkAppId;
  if (cleanupAppId) {
    for (const target of docReactionTargets) {
      try {
        await removeCommentReaction(
          cleanupAppId,
          { fileToken: target.fileToken, fileType: target.fileType },
          target.commentId,
          target.replyId!,
          target.reactionId!,
        );
      } catch (err: any) {
        logger.debug(
          `[doc-comment] close cleanup could not remove reaction ${target.reactionId}: ${err?.message ?? err}`,
        );
      }
    }

    const anchor = ds ? sessionAnchorId(ds) : stored ? sessionAnchorForStoredRow(stored) : undefined;
    let subs: ReturnType<typeof listDocSubscriptionsForSession> = [];
    try {
      if (anchor) {
        subs = listDocSubscriptionsForSession(config.session.dataDir, cleanupAppId, anchor);
      }
    } catch (err: any) {
      logger.warn(`[doc-comment] failed to list bindings on close for ${sessionId.slice(0, 8)}: ${err?.message ?? err}`);
    }
    for (const sub of subs) {
      try {
        // `/subscribe-lark-doc` (and pre-managedBy legacy rows) owns a
        // per-file remote subscription. `/watch-comment` is app-level event /
        // poller state and must only remove its local routing binding.
        if (isLegacyApiDocSubscription(sub.managedBy)) {
          await unsubscribeDocFile(cleanupAppId, { fileToken: sub.fileToken, fileType: sub.fileType });
        }
      } catch (err: any) {
        logger.warn(
          `[doc-comment] remote unsubscribe failed for ${sub.fileToken.slice(0, 12)} on close: ${err?.message ?? err}`,
        );
      } finally {
        // Local ownership must always be released, even when one remote API
        // call fails; each item is isolated so later bindings still clean up.
        try {
          removeDocSubscription(config.session.dataDir, cleanupAppId, sub.fileToken);
        } catch (err: any) {
          logger.warn(
            `[doc-comment] local binding removal failed for ${sub.fileToken.slice(0, 12)} on close: ${err?.message ?? err}`,
          );
        }
      }
    }
    if (subs.length) logger.info(`[doc-comment] session ${sessionId.slice(0, 8)} closed → removed ${subs.length} doc binding(s)`);
  }

  // alreadyClosed = nothing happened on either path.
  const alreadyClosed = !killedLive && !wasOpen;
  return { ok: true, alreadyClosed, known };
}

/**
 * Close can arrive through daemon IPC before startup restore has registered the
 * persisted row. In that window there is no DaemonSession for killWorker(), but
 * a stamped persistent backing may still be running. Tear down only backends
 * whose ownership is explicit; never touch adopted user panes, queued rows, or
 * legacy rows whose backend is unknown.
 */
export function destroyUnregisteredPersistentBacking(
  session: Session,
  kill: typeof killPersistentBackendTarget = killPersistentBackendTarget,
): boolean {
  if (session.adoptedFrom || session.queued) return false;
  const backendType = session.backendType;
  if (!isSuspendableBackendType(backendType)) return false;
  const target = resolvePersistentBackendTarget(
    backendType,
    session.sessionId,
    session.persistentBackendTarget,
  );
  const targetName = target.backendType === 'herdr' && target.agentName
    ? `${target.sessionName}/${target.agentName}`
    : target.sessionName;
  try {
    kill(target, session.sessionId);
    logger.info(`[${session.sessionId.substring(0, 8)}] Closed unregistered ${backendType} backing ${targetName}`);
    return true;
  } catch (err) {
    logger.warn(
      `[${session.sessionId.substring(0, 8)}] Failed to close unregistered ${backendType} backing ${targetName}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Compare-and-set an entry on an active-sessions Map. A different current
 * occupant always wins; callers must roll back the rejected incoming row.
 * Replaces bare `activeSessions.set(key, ds)` at sites where a silent overwrite
 * would leak the prior entry's worker + leave its store row stuck active.
 *
 * The Map is passed explicitly so callers operate on the same instance they
 * already hold (restoreActiveSessions takes the daemon's Map as a parameter;
 * transferSession reaches it through `activeSessionsRegistry`). In production
 * both refer to the same object — the daemon registers its Map at boot — but
 * decoupling avoids module-state assumptions in tests.
 *
 * Registration is compare-and-set: a different current occupant always wins.
 * The caller owns rollback of its rejected incoming row. This is deliberately
 * non-destructive because the occupant may be a fresh live session created
 * while an older async restore/create continuation was in flight.
 */
export type SetActiveSessionResult =
  | { accepted: true; closedSessionId?: string }
  | {
      accepted: false;
      reason: 'kept_pending_owner';
      keptSessionId: string;
      closedIncomingSessionId: string;
    }
  | {
      accepted: false;
      reason: 'both_pending';
      keptSessionId: string;
      preservedIncomingSessionId: string;
    }
  | {
      accepted: false;
      reason: 'inactive_incoming';
      keptSessionId: string;
      preservedIncomingSessionId: string;
    }
  | {
      accepted: false;
      reason: 'quarantine_reserved';
      keptSessionId: string;
      preservedIncomingSessionId: string;
    }
  | {
      accepted: false;
      reason: 'cleanup_failed';
      keptSessionId: string;
      preservedIncomingSessionId: string;
      cleanupSessionId: string;
      error: string;
    };

const activeSessionKeyLocks = new WeakMap<
  Map<string, DaemonSession>,
  Map<string, Promise<void>>
>();

/** Serialize asynchronous ownership decisions for one registry key. Ordinary
 * bot turn admissions are intentionally concurrent, so a read/await/set helper
 * is not a CAS unless every contender shares this lock. */
export async function withActiveSessionKeyLock<T>(
  map: Map<string, DaemonSession>,
  key: string,
  action: () => Promise<T> | T,
): Promise<T> {
  let locks = activeSessionKeyLocks.get(map);
  if (!locks) {
    locks = new Map();
    activeSessionKeyLocks.set(map, locks);
  }
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => { /* predecessor errors do not poison the lock */ }).then(() => hold);
  locks.set(key, tail);
  await previous.catch(() => { /* predecessor already reported its own error */ });
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

async function closeUnregisteredCollisionLoser(
  map: Map<string, DaemonSession>,
  loser: DaemonSession,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Operate on exact object identity in the caller's registry. Looking up by
  // session id through the daemon-global registry can conflate a non-global
  // restore map (or a stale duplicate object) with an unrelated canonical
  // owner and close the wrong generation.
  const sameIdDifferentOwner = [...map.values()].some(candidate =>
    candidate !== loser && candidate.session.sessionId === loser.session.sessionId)
    || (!!activeSessionsRegistry && activeSessionsRegistry !== map
      && [...activeSessionsRegistry.values()].some(candidate =>
        candidate !== loser && candidate.session.sessionId === loser.session.sessionId));
  if (sameIdDifferentOwner) {
    logger.error(
      `[setActiveSessionSafe] refusing persistence close for ambiguous session id `
      + `${loser.session.sessionId}; preserving every owner`,
    );
    return { ok: false, error: 'ambiguous_session_id' };
  }

  const stored = sessionStore.getSession(loser.session.sessionId);
  try {
    if (stored?.status !== 'closed') {
      sessionStore.closeSession(loser.session.sessionId);
    }
  } catch (err) {
    logger.error(
      `[setActiveSessionSafe] durable loser close failed for ${loser.session.sessionId}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: 'durable_close_failed' };
  }

  killWorker(loser);
  for (const [registeredKey, candidate] of map) {
    if (candidate === loser) map.delete(registeredKey);
  }
  return { ok: true };
}

function removeInactiveRegistration(
  map: Map<string, DaemonSession>,
  key: string,
  ds: DaemonSession,
): boolean {
  if (ds.session.status === 'active') return false;
  // Only remove our exact stale object. A newer session may already own the
  // same routing key and must never be evicted by this continuation.
  if (map.get(key) === ds) map.delete(key);
  logger.warn(
    `[${tag(ds)}] Refusing to register an inactive session ` +
    `(status=${ds.session.status})`,
  );
  return true;
}

function persistedActiveSessionKey(
  session: Session,
  fallbackLarkAppId: string,
): string {
  const larkAppId = session.larkAppId ?? fallbackLarkAppId;
  const anchor = session.vcMeetingReceiver
    ? `vc-receiver:${session.sessionId}`
    : storedSessionAnchorId(session);
  return sessionKey(anchor, larkAppId);
}

/**
 * Return an active persisted row that deliberately reserves this routing key
 * after an inconclusive exact-backend teardown.
 *
 * The store is the durable authority rather than a process-local Set: a daemon
 * restart must not forget the quarantine and create a second runtime beside a
 * possibly-live ZMX/other persistent target. Closed rows are ignored so an
 * operator's successful close immediately releases the route.
 */
export function findQuarantinedRoutingConflict(
  key: string,
  larkAppId: string,
  candidateSessionId?: string,
): Session | undefined {
  try {
    return sessionStore.listSessions().find(session =>
      session.status === 'active'
      && !!session.restoreQuarantinedAt
      && session.sessionId !== candidateSessionId
      && persistedActiveSessionKey(session, larkAppId) === key,
    );
  } catch {
    // Registration still retains its existing in-memory CAS semantics when the
    // store is temporarily unreadable. Restore marks/persists quarantine before
    // yielding, so the normal production path reaches the durable guard.
    return undefined;
  }
}

/** Clear a durable quarantine marker once a live owner has claimed the route.
 * Runtime ownership (the Map + lock) is authoritative for this process even if
 * the persistence write fails; a later update or restore attempt converges the
 * stale on-disk marker. */
function clearRestoreQuarantineMarker(ds: DaemonSession): void {
  if (!ds.session.restoreQuarantinedAt) return;
  delete ds.session.restoreQuarantinedAt;
  try {
    sessionStore.updateSession(ds.session);
  } catch (err) {
    logger.warn(
      `[${tag(ds)}] Registered quarantined session but could not clear its persisted marker: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Synchronous registration gate for creation paths that previously used a
 * bare Map.set(). A daemon close can update the shared Session object while
 * the creator is awaiting Lark/project metadata; never publish that now-closed
 * row back into the live routing map when the continuation resumes.
 */
export function setActiveSessionIfActive(
  map: Map<string, DaemonSession>,
  key: string,
  ds: DaemonSession,
): boolean {
  if (removeInactiveRegistration(map, key, ds)) return false;
  const current = map.get(key);
  if (current && current !== ds) {
    logger.warn(
      `[${tag(ds)}] Refusing to overwrite active routing occupant ` +
      `${current.session.sessionId.substring(0, 8)}`,
    );
    return false;
  }
  const quarantined = findQuarantinedRoutingConflict(key, ds.larkAppId, ds.session.sessionId);
  if (quarantined) {
    logger.warn(
      `[${tag(ds)}] Refusing to occupy routing key reserved by quarantined session `
      + `${quarantined.sessionId.substring(0, 8)}`,
    );
    return false;
  }
  map.set(key, ds);
  clearRestoreQuarantineMarker(ds);
  return true;
}

export async function setActiveSessionSafe(
  map: Map<string, DaemonSession>,
  key: string,
  ds: DaemonSession,
): Promise<SetActiveSessionResult> {
  const canonicalKey = activeSessionKey(ds);
  if (canonicalKey !== key) {
    throw new Error(
      `refusing noncanonical active-session registration: requested=${key} canonical=${canonicalKey}`,
    );
  }
  return withActiveSessionKeyLock(map, key, async () => {
    // Reboot-resume guard (master): a daemon close can flip the shared Session
    // to a non-active status while an async creator/restore awaited Lark/project
    // metadata. Never publish that now-inactive row back into the live map; drop
    // only our exact stale object so a newer owner of the same key is untouched.
    if (ds.session.status !== 'active') {
      if (map.get(key) === ds) map.delete(key);
      logger.warn(
        `[setActiveSessionSafe] refusing to register inactive session `
        + `${ds.session.sessionId.substring(0, 8)} (status=${ds.session.status})`,
      );
      return {
        accepted: false,
        reason: 'inactive_incoming',
        keptSessionId: ds.session.sessionId,
        preservedIncomingSessionId: ds.session.sessionId,
      };
    }
    const prev = map.get(key);
    if (prev && prev !== ds) {
      if (prev.session.sessionId === ds.session.sessionId) {
        logger.error(
          `[setActiveSessionSafe] refusing collision between distinct owners of session id `
          + `${prev.session.sessionId}; preserving both objects and the durable row`,
        );
        return {
          accepted: false,
          reason: 'cleanup_failed',
          keptSessionId: prev.session.sessionId,
          preservedIncomingSessionId: ds.session.sessionId,
          cleanupSessionId: prev.session.sessionId,
          error: 'ambiguous_session_id',
        };
      }
      const prevPending = hasProtectedSessionMutationOwnership(prev);
      const incomingPending = hasProtectedSessionMutationOwnership(ds);
      if (prevPending && incomingPending) {
        logger.error(
          `[setActiveSessionSafe] refusing collision between two unsettled Codex App owners `
          + `${prev.session.sessionId} and ${ds.session.sessionId}; preserving both rows/panes`,
        );
        return {
          accepted: false,
          reason: 'both_pending',
          keptSessionId: prev.session.sessionId,
          preservedIncomingSessionId: ds.session.sessionId,
        };
      }
      if (prevPending) {
        logger.warn(
          `[setActiveSessionSafe] keeping unsettled owner ${prev.session.sessionId.substring(0, 8)}; `
          + `closing ledger-empty incoming ${ds.session.sessionId.substring(0, 8)}`,
        );
        const cleanup = await closeUnregisteredCollisionLoser(map, ds);
        if (!cleanup.ok) {
          return {
            accepted: false,
            reason: 'cleanup_failed',
            keptSessionId: prev.session.sessionId,
            preservedIncomingSessionId: ds.session.sessionId,
            cleanupSessionId: ds.session.sessionId,
            error: cleanup.error,
          };
        }
        return {
          accepted: false,
          reason: 'kept_pending_owner',
          keptSessionId: prev.session.sessionId,
          closedIncomingSessionId: ds.session.sessionId,
        };
      }
      logger.warn(
        `[setActiveSessionSafe] key already occupied by ${prev.session.sessionId.substring(0, 8)} ` +
        `(worker=${prev.worker ? 'live' : 'null'}); closing it before set`,
      );
      const cleanup = await closeUnregisteredCollisionLoser(map, prev);
      if (!cleanup.ok) {
        return {
          accepted: false,
          reason: 'cleanup_failed',
          keptSessionId: prev.session.sessionId,
          preservedIncomingSessionId: ds.session.sessionId,
          cleanupSessionId: prev.session.sessionId,
          error: cleanup.error,
        };
      }
    }
    // Reboot-resume guard (master): a durable quarantine reservation for this
    // route (an inconclusive exact-backend teardown) must block a second runtime
    // beside a possibly-live persistent target, even after the in-memory prev
    // occupant above was closed. Closed rows never match, so an operator close
    // immediately releases the route.
    const quarantined = findQuarantinedRoutingConflict(key, ds.larkAppId, ds.session.sessionId);
    if (quarantined) {
      logger.warn(
        `[setActiveSessionSafe] refusing to occupy routing key reserved by quarantined session `
        + `${quarantined.sessionId.substring(0, 8)}`,
      );
      return {
        accepted: false,
        reason: 'quarantine_reserved',
        keptSessionId: quarantined.sessionId,
        preservedIncomingSessionId: ds.session.sessionId,
      };
    }
    map.set(key, ds);
    clearRestoreQuarantineMarker(ds);
    return {
      accepted: true,
      ...(prev && prev !== ds ? { closedSessionId: prev.session.sessionId } : {}),
    };
  });
}

/**
 * Roll back a freshly-created row rejected by the registration CAS, then read
 * the routing winner *after* that asynchronous rollback finishes.
 *
 * Message handlers use this to hand an already-deduped inbound event to a
 * concurrent HTTP/dashboard/restore winner instead of silently dropping it.
 * The post-await lookup matters: close cleanup must never return a stale object
 * that another continuation replaced while the rollback was in flight.
 */
export async function rollbackRejectedSessionAndGetWinner(
  map: Map<string, DaemonSession>,
  key: string,
  rejected: DaemonSession,
  rollback: (sessionId: string) => Promise<unknown> = closeSession,
): Promise<DaemonSession | undefined> {
  await rollback(rejected.session.sessionId);
  const winner = map.get(key);
  if (!winner || winner === rejected || winner.session.status !== 'active') return undefined;
  return winner;
}

// ─── Session transfer (cross-chat relay) ────────────────────────────────────

type TransferBufferedInput = Extract<
  DaemonToWorker,
  {
    type:
      | 'message'
      | 'raw_input'
      | 'inject_command'
      | 'coco_drive_picker'
      | 'set_display_mode'
      | 'refresh_screen'
      | 'term_action';
  }
>;

type TransferInputGate = {
  messages: TransferBufferedInput[];
  /** At least one external cold-start/wake requested an empty worker fork.
   * Pending raw input is delivered later by prompt_ready, so the empty fork
   * itself still carries user intent even though there is no IPC item yet. */
  needsWorker: boolean;
  /** Routing is no longer inside the detach/commit critical section. Once
   * true, later input may safely trigger another cold reattach if the first
   * replacement lost IPC during startup. */
  released: boolean;
  /** Preserve the caller's test/production fork seam for delayed recovery. */
  forkWorkerImpl?: typeof forkWorker;
  flushing: boolean;
  settledCallbacks: Set<() => void>;
};

const transferInputGates = new WeakMap<DaemonSession, TransferInputGate>();
// Only this module can mark the synchronous replacement fork. External callers
// cannot forge an option that bypasses the transfer gate.
const transferReplacementForkBypass = new WeakSet<DaemonSession>();

const ORDINARY_IM_RECEIPT_TIMEOUT_MS = 2_000;
const ORDINARY_IM_MAX_ATTEMPTS = 2;

type OrdinaryImDelivery = {
  key: string;
  ds: DaemonSession;
  worker: ChildProcess;
  workerGeneration: number;
  message: Extract<DaemonToWorker, { type: 'message' | 'init' }>;
  turnId: string;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
};

/** Exact ordinary-IM turns awaiting the worker's synchronous receipt ACK. The
 * daemon event has already been claimed by Lark dedup at this point, so losing
 * this in-memory delivery without retry would permanently drop the message. */
const pendingOrdinaryImDeliveries = new Map<string, OrdinaryImDelivery>();

function ordinaryImDeliveryKey(ds: DaemonSession, turnId: string, workerGeneration: number): string {
  return `${ds.session.sessionId}:${workerGeneration}:${turnId}`;
}

function clearOrdinaryImDelivery(record: OrdinaryImDelivery): void {
  if (record.timer) clearTimeout(record.timer);
  record.timer = undefined;
  if (pendingOrdinaryImDeliveries.get(record.key) === record) {
    pendingOrdinaryImDeliveries.delete(record.key);
  }
}

function clearOrdinaryImDeliveryTimer(record: OrdinaryImDelivery): void {
  if (record.timer) clearTimeout(record.timer);
  record.timer = undefined;
}

function failOrdinaryImDelivery(record: OrdinaryImDelivery, reason: string): void {
  if (pendingOrdinaryImDeliveries.get(record.key) !== record) return;
  clearOrdinaryImDelivery(record);
  logger.error(
    `[${tag(record.ds)}] Ordinary IM worker delivery failed `
    + `turn=${record.turnId.substring(0, 16)} generation=${record.workerGeneration} `
    + `attempts=${record.attempt} reason=${reason}`,
  );
  if (record.ds.session.vcMeetingReceiver || isSilentScheduledTurn(record.ds, record.turnId)) return;
  const loc = botLocale(getBot(record.ds.larkAppId).config);
  void requireCallbacks().sessionReply(
    sessionAnchorId(record.ds),
    tr('worker.input_delivery_failed', { turnId: record.turnId.substring(0, 16) }, loc),
    'text',
    record.ds.larkAppId,
    record.turnId,
  ).catch(err => logger.error(
    `[${tag(record.ds)}] Failed to report ordinary IM worker delivery failure: `
    + `${err instanceof Error ? err.message : String(err)}`,
  ));
}

function retryOrFailOrdinaryImDelivery(record: OrdinaryImDelivery, reason: string): void {
  if (pendingOrdinaryImDeliveries.get(record.key) !== record) return;
  if (
    record.attempt < ORDINARY_IM_MAX_ATTEMPTS
    && record.ds.worker === record.worker
    && !record.worker.killed
    && record.ds.workerGeneration === record.workerGeneration
    && record.ds.session.workerGeneration === record.workerGeneration
  ) {
    logger.warn(
      `[${tag(record.ds)}] Ordinary IM input missing worker receipt; retrying exact turn `
      + `${record.turnId.substring(0, 16)} on generation ${record.workerGeneration} `
      + `(reason=${reason})`,
    );
    sendOrdinaryImDeliveryAttempt(record);
    return;
  }
  failOrdinaryImDelivery(record, reason);
}

function sendOrdinaryImDeliveryAttempt(record: OrdinaryImDelivery): boolean {
  if (pendingOrdinaryImDeliveries.get(record.key) !== record) return false;
  if (
    record.ds.worker !== record.worker
    || record.worker.killed
    || record.ds.workerGeneration !== record.workerGeneration
    || record.ds.session.workerGeneration !== record.workerGeneration
  ) {
    failOrdinaryImDelivery(record, 'worker_generation_changed');
    return false;
  }

  if (record.timer) clearTimeout(record.timer);
  record.timer = undefined;
  const attempt = ++record.attempt;
  try {
    record.worker.send(record.message, (err) => {
      if (pendingOrdinaryImDeliveries.get(record.key) !== record || record.attempt !== attempt) return;
      if (err) {
        retryOrFailOrdinaryImDelivery(record, `ipc_callback:${err.message}`);
        return;
      }
      logger.info(
        `[${tag(record.ds)}] Ordinary IM input enqueued to worker IPC `
        + `turn=${record.turnId.substring(0, 16)} generation=${record.workerGeneration} attempt=${attempt}`,
      );
    });
  } catch (err) {
    queueMicrotask(() => retryOrFailOrdinaryImDelivery(
      record,
      `ipc_throw:${err instanceof Error ? err.message : String(err)}`,
    ));
    return true;
  }

  // The worker ACKs synchronously when its IPC handler claims the exact turn.
  // Slow CLI startup/processing therefore does not extend this transport-only
  // timeout; the later committed ACK retains input-queue semantics.
  if (pendingOrdinaryImDeliveries.get(record.key) === record) {
    record.timer = setTimeout(() => {
      retryOrFailOrdinaryImDelivery(record, 'receipt_timeout');
    }, ORDINARY_IM_RECEIPT_TIMEOUT_MS);
    record.timer.unref?.();
  }
  return true;
}

function sendOrdinaryImDeliveryTracked(
  ds: DaemonSession,
  message: Extract<DaemonToWorker, { type: 'message' | 'init' }>,
): boolean {
  const turnId = message.turnId;
  const worker = ds.worker;
  const workerGeneration = ds.workerGeneration;
  if (!turnId || !worker || worker.killed || !Number.isSafeInteger(workerGeneration) || (workerGeneration ?? 0) <= 0) {
    return false;
  }
  const key = ordinaryImDeliveryKey(ds, turnId, workerGeneration!);
  if (pendingOrdinaryImDeliveries.has(key)) return true;
  const record: OrdinaryImDelivery = {
    key,
    ds,
    worker,
    workerGeneration: workerGeneration!,
    message,
    turnId,
    attempt: 0,
  };
  pendingOrdinaryImDeliveries.set(key, record);
  return sendOrdinaryImDeliveryAttempt(record);
}

function shouldTrackOrdinaryImDelivery(
  ds: DaemonSession,
  message: Extract<DaemonToWorker, { type: 'message' | 'init' }>,
): boolean {
  return !!message.turnId?.startsWith('om_')
    && message.dispatchAttempt === undefined
    && (message.type !== 'init' || (!!message.prompt && !message.adoptMode))
    && !ds.adoptedFrom
    && !ds.session.vcMeetingReceiver
    && Number.isSafeInteger(ds.workerGeneration)
    && (ds.workerGeneration ?? 0) > 0
    && ds.session.workerGeneration === ds.workerGeneration;
}

function acknowledgeOrdinaryImDeliveryReceipt(
  ds: DaemonSession,
  turnId: string,
  workerGeneration: number,
): void {
  const key = ordinaryImDeliveryKey(ds, turnId, workerGeneration);
  const record = pendingOrdinaryImDeliveries.get(key);
  if (!record) return;
  clearOrdinaryImDeliveryTimer(record);
  logger.info(
    `[${tag(ds)}] Ordinary IM input received by worker `
    + `turn=${turnId.substring(0, 16)} generation=${workerGeneration} attempt=${record.attempt}`,
  );
}

function completeOrdinaryImDelivery(
  ds: DaemonSession,
  turnId: string,
  workerGeneration: number,
): void {
  const key = ordinaryImDeliveryKey(ds, turnId, workerGeneration);
  const record = pendingOrdinaryImDeliveries.get(key);
  if (record) clearOrdinaryImDelivery(record);
}

function rejectOrdinaryImDelivery(
  ds: DaemonSession,
  turnId: string,
  workerGeneration: number,
  reason: string,
): void {
  const key = ordinaryImDeliveryKey(ds, turnId, workerGeneration);
  const record = pendingOrdinaryImDeliveries.get(key);
  if (!record) return;
  retryOrFailOrdinaryImDelivery(record, `worker_rejected:${reason}`);
}

function abandonOrdinaryImDeliveriesForWorker(worker: ChildProcess): void {
  for (const record of pendingOrdinaryImDeliveries.values()) {
    if (record.worker === worker) clearOrdinaryImDelivery(record);
  }
}

export function __testOnly_resetOrdinaryImDeliveries(): void {
  for (const record of pendingOrdinaryImDeliveries.values()) {
    if (record.timer) clearTimeout(record.timer);
  }
  pendingOrdinaryImDeliveries.clear();
}

export function isSessionTransferring(ds: DaemonSession): boolean {
  return transferInputGates.has(ds);
}

/** Register follow-up work that must run only after the relay gate is fully
 * released. Returns false when no transfer is active, so callers can proceed
 * immediately without a check-then-register race. */
export function deferUntilSessionTransferSettled(
  ds: DaemonSession,
  callback: () => void,
): boolean {
  const gate = transferInputGates.get(ds);
  if (!gate) return false;
  gate.settledCallbacks.add(callback);
  return true;
}

function beginTransferInputGate(ds: DaemonSession): TransferInputGate | undefined {
  if (transferInputGates.has(ds)) return undefined;
  const gate: TransferInputGate = {
    messages: [],
    needsWorker: false,
    released: false,
    flushing: false,
    settledCallbacks: new Set(),
  };
  transferInputGates.set(ds, gate);
  return gate;
}

function forkTransferReplacement(
  ds: DaemonSession,
  forkWorkerImpl: typeof forkWorker,
): void {
  transferReplacementForkBypass.add(ds);
  try {
    forkWorkerImpl(ds, '', true);
  } finally {
    transferReplacementForkBypass.delete(ds);
  }
}

function bufferTransferInput(
  ds: DaemonSession,
  message: TransferBufferedInput,
): boolean {
  const gate = transferInputGates.get(ds);
  if (!gate) return false;
  gate.messages.push(message);
  logger.info(
    `[${tag(ds)}] Buffered ${message.type} input during routing transfer`
    + `${'turnId' in message && message.turnId ? ` (turn ${message.turnId.substring(0, 8)})` : ''}`,
  );
  // A committed transfer can retain its gate when the first replacement loses
  // IPC. The next accepted input is also a safe recovery trigger; before
  // commit, released=false prevents an eager fork on the source route.
  if (gate.released && gate.forkWorkerImpl) {
    queueMicrotask(() => {
      if (transferInputGates.get(ds) === gate) {
        releaseTransferInputGate(ds, gate, gate.forkWorkerImpl!);
      }
    });
  }
  return true;
}

/** Route user/automation input through the transfer fence. Messages accepted
 * during detach are replayed byte-for-byte to the replacement generation.
 */
export function sendWorkerSessionInput(
  ds: DaemonSession,
  message: TransferBufferedInput,
): boolean {
  if (bufferTransferInput(ds, message)) return true;
  if (!ds.worker || ds.worker.killed) return false;
  ds.worker.send(message);
  return true;
}

function settleTransferInputGate(
  ds: DaemonSession,
  gate: TransferInputGate,
): void {
  if (transferInputGates.get(ds) !== gate) return;
  transferInputGates.delete(ds);
  const callbacks = [...gate.settledCallbacks];
  gate.settledCallbacks.clear();
  for (const callback of callbacks) {
    queueMicrotask(() => {
      try {
        callback();
      } catch (err) {
        logger.error(
          `[${tag(ds)}] Post-transfer callback failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}

function releaseTransferInputGate(
  ds: DaemonSession,
  gate: TransferInputGate,
  forkWorkerImpl: typeof forkWorker,
  waitForWorkerExit?: ChildProcess,
): void {
  gate.released = true;
  gate.forkWorkerImpl = forkWorkerImpl;
  const flush = (): void => {
    if (transferInputGates.get(ds) !== gate) return;
    if (gate.flushing) return;
    gate.flushing = true;
    try {
    if (
      ds.session.status === 'active'
      && (gate.needsWorker || gate.messages.length > 0)
      && currentDeviceIsolationFreezeLease()
      && deferWorkerSpawnDuringDeviceIsolation(ds.session.sessionId, flush)
    ) {
      logger.info(
        `[${tag(ds)}] Holding transfer-buffered input behind device-isolation freeze`,
      );
      return;
    }
    if (ds.session.status !== 'active') {
      settleTransferInputGate(ds, gate);
      if (gate.messages.length > 0) {
        logger.warn(
          `[${tag(ds)}] Dropping ${gate.messages.length} transfer-buffered input(s); session is no longer active`,
        );
      }
      return;
    }
    const workerUnavailable = (): boolean =>
      !ds.worker || ds.worker.killed || ds.worker.connected === false;
    if (workerUnavailable() && (gate.needsWorker || gate.messages.length > 0)) {
      // Source-route timeout and successful target transfer both preserve CLI
      // history. Start an empty resume generation first, then replay the exact
      // frozen IPC messages in order behind its init message.
      try {
        forkTransferReplacement(ds, forkWorkerImpl);
      } catch (err) {
        gate.needsWorker = true;
        logger.error(
          `[${tag(ds)}] Replacement worker fork failed after routing transfer; `
          + `retaining ${gate.messages.length} buffered input(s): `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
    if (gate.messages.length === 0) {
      gate.needsWorker = false;
      settleTransferInputGate(ds, gate);
      return;
    }
    const worker = ds.worker;
    if (!worker || worker.killed || worker.connected === false) {
      gate.needsWorker = true;
      logger.error(
        `[${tag(ds)}] Unable to replay ${gate.messages.length} transfer-buffered input(s); `
        + 'replacement worker has no live IPC channel, retaining them for recovery',
      );
      return;
    }
    while (gate.messages.length > 0) {
      const message = gate.messages[0];
      try {
        if (
          message.type === 'message'
          && shouldTrackOrdinaryImDelivery(ds, message)
        ) {
          // The transfer gate owns buffering/order; once a replacement
          // generation exists, ordinary IM delivery returns to the same exact
          // receipt protocol as steady-state input. The watchdog remains valid
          // after the gate itself settles.
          if (!sendOrdinaryImDeliveryTracked(ds, message)) {
            throw new Error('replacement worker rejected tracked IM delivery');
          }
        } else {
          worker.send(message);
        }
        gate.messages.shift();
      } catch (err) {
        gate.needsWorker = true;
        logger.error(
          `[${tag(ds)}] Replacement worker IPC failed while replaying ${message.type}; `
          + `retaining ${gate.messages.length} undelivered input(s): `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
        if (
          typeof worker.once === 'function'
          && worker.exitCode === null
          && worker.signalCode === null
        ) {
          worker.once('exit', () => {
            if (ds.worker === worker) ds.worker = null;
            flush();
          });
        }
        return;
      }
    }
    gate.needsWorker = false;
    settleTransferInputGate(ds, gate);
    } finally {
      gate.flushing = false;
    }
  };

  if (
    waitForWorkerExit
    && waitForWorkerExit.exitCode === null
    && waitForWorkerExit.signalCode === null
  ) {
    // Hard retirement is fail-closed: keep buffering until the OS confirms the
    // uncertain old worker can no longer receive a late detach or user input.
    waitForWorkerExit.once('exit', () => {
      clearTransferWorkerState(
        ds,
        waitForWorkerExit,
        'releaseTransferInputGate:late_forced_exit',
      );
      flush();
    });
    return;
  }
  flush();
}

/**
 * Transfer an active session from its current chat to a new chat. The CLI
 * process keeps running inside its tmux session — only the routing fields
 * (chatId, rootMessageId, scope) and activeSessions key are rewritten. After
 * the rewrite, forkWorker spawns a new worker that re-attaches to the same
 * `bmx-<sessionId>` tmux, so the AI's transcript continues without break.
 *
 * Visible side effects:
 *   - Lark messages in the *source* chat remain where they were — we have no
 *     API to move them. Only the worker's *routing* moves; the AI's memory
 *     follows via the CLI's persistent jsonl on disk.
 *   - Cards posted by the prior worker stay in the source chat. We clear
 *     streamCardId/Nonce/imageKey so the new worker posts fresh cards in the
 *     target chat instead of trying to PATCH unreachable old ones.
 *
 * Pre-conditions (entry guards, all checked synchronously up-front — no
 * idle-wait loop; busy workers are refused immediately so the caller can
 * report a deterministic outcome and the user retries when the worker
 * quiets):
 *   - Session must be currently active (live worker + activeSessions entry)
 *   - Source must not be a pendingRepo placeholder (no CLI ever started)
 *   - Source must not be an adopted external-tmux session
 *   - Source worker must be in idle/limited (or already dead) — otherwise
 *     refuse with `worker_busy`
 *   - Target chat must not already host a real chat-scope session for the
 *     same bot (`target_chat_has_session`). Scratch (worker:null) occupants
 *     are NOT a conflict — they're command-time placeholders and we close
 *     them in-line to free the slot before continuing.
 *
 * Idempotent for `same_chat`: returns error without side effects when the
 * source chat equals the target chat.
 */
export async function transferSession(
  sessionId: string,
  targetChatId: string,
  targetRootMessageId: string,
  /**
   * Target chat type.
   *   'group' → topic groups are supported via `targetScope: 'thread'`;
   *             `/relay --create` builds the target by createGroupWithBots so
   *             it's a regular group by construction; the cross-daemon
   *             migrate-to-chat IPC inherits the same target.
   *   'p2p'   → the bot's DM. Flat DMs (p2pMode 'chat') land chat-scope on the
   *             chatId anchor; thread-mode DMs land thread-scope on a DM 话题
   *             root. The session's chatType flips with the move so post-relay
   *             inbound routing / picker labels / reply targeting treat it as
   *             a DM. Carried from the picker card's `target_chat_type`.
   * The runtime check just below catches raw-string casting at module
   * boundaries (mocks, HTTP body parses, future bypasses).
   */
  targetChatType: 'group' | 'p2p',
  /**
   * Target routing scope for the relayed session.
   *   'chat'   → anchor = chatId (flat top-level; `/relay --create`, migrate
   *              IPC, and普通群 flat-mode picker all use this — current behavior).
   *   'thread' → anchor = `targetRootMessageId` (a Lark 话题/thread); replies
   *              go reply_in_thread. Picker computes this via
   *              resolveRelayTargetRouting for 话题群 / new-topic / shared /
   *              线程内回复.
   */
  targetScope: 'thread' | 'chat',
  opts?: {
    /** @internal Override for tests — the real implementation forks a child
     *  process and tries to attach to tmux, neither of which is appropriate
     *  in a unit test environment. Defaults to module-level forkWorker. */
    forkWorkerImpl?: typeof forkWorker;
    /** @internal Override for tests — mirror of forkWorkerImpl for killWorker. */
    killWorkerImpl?: typeof killWorker;
    /** @internal Recursive marker: the bot-wide transfer mutation is held. */
    mutationHeld?: boolean;
    /** @internal Override for tests — mirror of forkWorkerImpl for the
     * transfer-only worker detach path. */
    detachWorkerImpl?: (
      ds: DaemonSession,
    ) => boolean | void | Promise<boolean | void>;
    /** Detach-fence budget (ms) for the observer teardown handshake. Defaults
     *  to the tight TRANSFER_DETACH_FENCE_MS, which the cross-daemon peer path
     *  needs to stay inside the leader's 5s HTTP abort. In-process callers with
     *  no HTTP ceiling (the picker relay_confirm) pass a larger value
     *  (TRANSFER_DETACH_FENCE_PICKER_MS) so a slightly-slow-but-clean teardown
     *  is not misclassified as a failure. Ignored when detachWorkerImpl is set
     *  (test doubles don't observe a real fence). */
    detachTimeoutMs?: number;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Depth defense — unreachable per TS narrowing above, but guards against
  // raw-string casting at module boundaries (mocks, HTTP body parses, etc.).
  if ((targetChatType as string) !== 'group' && (targetChatType as string) !== 'p2p') {
    return { ok: false, error: 'target_chat_type_unsupported' };
  }
  const initial = findActiveBySessionId(sessionId);
  if (!initial) return { ok: false, error: 'session_not_active' };
  if (!opts?.mutationHeld) {
    // Transfer rewrites both the source and target routing identities and may
    // await scratch cleanup.  Drain every admitted turn for this bot first so
    // no source prompt can become durable mid-transfer and no target creator
    // can slip into the cleanup window.
    return withBotTurnMutation(initial.larkAppId, () => transferSession(
      sessionId,
      targetChatId,
      targetRootMessageId,
      targetChatType,
      targetScope,
      { ...opts, mutationHeld: true },
    ));
  }
  const ds = findActiveBySessionId(sessionId);
  if (!ds || ds.session.status !== 'active') return { ok: false, error: 'session_not_active' };
  const sourceSession = ds.session;
  const sourceLifecycleIdentity = JSON.stringify({
    sessionId: sourceSession.sessionId,
    cliId: sourceSession.cliId,
    cliSessionId: sourceSession.cliSessionId,
    backendType: sourceSession.backendType,
    persistentBackendTarget: sourceSession.persistentBackendTarget,
    riffParentTaskId: sourceSession.riffParentTaskId,
    workingDir: sourceSession.workingDir,
    adoptedFrom: sourceSession.adoptedFrom,
    runtimeWorkingDir: ds.workingDir,
    runtimeAdoptedFrom: ds.adoptedFrom,
  });
  if (ds.session.vcMeetingReceiver) return { ok: false, error: 'vc_receiver_not_relayable' };
  if (hasProtectedSessionMutationOwnership(ds)) {
    return { ok: false, error: 'codex_app_dispatch_pending' };
  }
  // Anchor-based identity. A thread-scope session in the SAME chat (different
  // root) is a legitimate cross-topic move, so we refuse only when the target
  // anchor equals the source anchor (relaying a session onto itself). Replaces
  // the old `targetChatId === ds.chatId → same_chat` check, which would have
  // blocked同群话题间搬运.
  const sourceAnchor = sessionAnchorId(ds);
  const targetAnchor = targetScope === 'chat' ? targetChatId : targetRootMessageId;
  if (targetAnchor === sourceAnchor) return { ok: false, error: 'same_anchor' };
  const sourceKey = sessionKey(sourceAnchor, ds.larkAppId);
  const targetKey = sessionKey(targetAnchor, ds.larkAppId);
  const validateSourceIdentity = (): { ok: false; error: string } | undefined => {
    if (
      ds.session.status !== 'active'
      || ds.session !== sourceSession
      || ds.session.sessionId !== sessionId
      || JSON.stringify({
        sessionId: ds.session.sessionId,
        cliId: ds.session.cliId,
        cliSessionId: ds.session.cliSessionId,
        backendType: ds.session.backendType,
        persistentBackendTarget: ds.session.persistentBackendTarget,
        riffParentTaskId: ds.session.riffParentTaskId,
        workingDir: ds.session.workingDir,
        adoptedFrom: ds.session.adoptedFrom,
        runtimeWorkingDir: ds.workingDir,
        runtimeAdoptedFrom: ds.adoptedFrom,
      }) !== sourceLifecycleIdentity
      || activeSessionsRegistry?.get(sourceKey) !== ds
    ) {
      return { ok: false, error: 'session_not_active' };
    }
    return undefined;
  };
  const validateAfterAwait = (): { ok: false; error: string } | undefined => {
    const sourceError = validateSourceIdentity();
    if (sourceError) return sourceError;
    if (currentDeviceIsolationFreezeLease()) {
      return { ok: false, error: 'worker_busy' };
    }
    const targetOccupant = activeSessionsRegistry?.get(targetKey);
    if (targetOccupant && targetOccupant !== ds) {
      return { ok: false, error: 'target_chat_has_session' };
    }
    return undefined;
  };
  // The initial target scan below intentionally permits worker-less command
  // scratches and closes them. At entry only validate source ownership; after
  // those awaited closes the strict validator requires the target to be empty.
  const initialStateError = validateSourceIdentity();
  if (initialStateError) return initialStateError;

  // pendingRepo: the user created a session via M0 but hasn't picked a repo
  // yet, so worker is null and the CLI has never run. Relaying produces an
  // empty new-chat session with no AI memory — refuse so the user finishes
  // setup in the original chat first.
  if (ds.pendingRepo) return { ok: false, error: 'not_started_yet' };

  // Depth defense: daemon-command scratch (worker:null + no persisted CLI
  // markers) must not be migrated. Upstream paths (picker filter, card-
  // handler confirm preflight, /relay --create leader guard) should already
  // refuse these — this catches any caller that bypassed all three (e.g.
  // a future code path, a direct dashboard IPC, a test reaching in
  // manually). Using `isRelayableRealSession` instead of `ds.hasHistory`
  // makes the predicate survive restoreActiveSessions which currently sets
  // hasHistory:true unconditionally (session-manager.ts:618).
  if (!isRelayableRealSession(ds)) return { ok: false, error: 'not_started_yet' };

  // Adopt sessions wrap a CLI process that botmux didn't spawn — the user
  // owns it inside their own tmux pane, so moving routing here would be
  // surprising and we don't control the tmux session's lifecycle. Refuse.
  if (ds.session.adoptedFrom) return { ok: false, error: 'adopt_not_relayable' };

  // Busy worker: refuse immediately rather than waiting. An idle-wait loop
  // (previously 60s) created an asymmetry with the peer-dispatch HTTP
  // timeout (5s) — peer's transferSession was still polling while the
  // leader had already abort+report 'busy', producing reports that
  // disagreed with reality. Cleaner contract: refuse on first miss, let
  // the user retry when the turn settles.
  if (isSessionLifecycleInFlight(ds)) {
    return { ok: false, error: 'worker_busy' };
  }
  const st = ds.lastScreenStatus;
  if (ds.worker && !ds.worker.killed && st !== 'idle' && st !== 'limited') {
    return { ok: false, error: 'worker_busy' };
  }
  if (currentDeviceIsolationFreezeLease()) {
    return { ok: false, error: 'worker_busy' };
  }

  const fkw = opts?.forkWorkerImpl ?? forkWorker;
  // The default detach observes a real fence and takes a per-call timeout; a
  // test double only takes `ds`. Bind the requested fence onto the real impl
  // only — a test double never observes a fence, so the budget is irrelevant
  // (and its narrower signature wouldn't accept it).
  const detachTimeoutMs = opts?.detachTimeoutMs ?? TRANSFER_DETACH_FENCE_MS;
  const detach = opts?.detachWorkerImpl
    ?? ((d: DaemonSession) => detachWorkerForTransfer(d, { timeoutMs: detachTimeoutMs }));
  const transferGate = beginTransferInputGate(ds);
  if (!transferGate) return { ok: false, error: 'worker_busy' };
  let uncertainRetiringWorker: ChildProcess | undefined;
  let sourceDetached = false;
  let routingCommitted = false;

  try {
  // Existing-session guard: a session sharing the *target anchor* would
  // collide on sessionKey(targetAnchor, larkAppId) after the rewrite, and
  // Map.set would silently orphan the prior entry's worker. We split the
  // collision predicate two ways:
  //   - real session (worker !== null): refuse the transfer
  //   - scratch session (worker === null): a daemon-command placeholder
  //     (e.g. the /relay command itself created one when typed in this
  //     chat); the slot is logically free, but the placeholder lingers in
  //     the store with status='active'. Collect and close it so the post-
  //     transfer Map.set doesn't silently overwrite it (which leaves the
  //     scratch as a ghost-active on next daemon restart — exact bug we're
  //     fixing).
  // Anchor-based: chat-scope anchors on chatId, thread-scope on rootMessageId.
  // Only a session at the target anchor collides — same-chat other-topic
  // sessions have a different anchor and are fine (enables同群话题间搬运).
  const scratchesToClose: string[] = [];
  if (activeSessionsRegistry) {
    for (const existing of activeSessionsRegistry.values()) {
      if (existing === ds) continue;
      if (existing.larkAppId !== ds.larkAppId) continue;
      if (sessionAnchorId(existing) !== targetAnchor) continue;
      // A durable dispatch ledger / activation journal makes the occupant a
      // real conflict even when it currently has no worker; only a proven
      // ledger-empty command scratch may be retired.
      if (isDisposableCommandScratch(existing)
        && !hasProtectedSessionMutationOwnership(existing)) {
        scratchesToClose.push(existing.session.sessionId);
        continue;
      }
      return { ok: false, error: 'target_chat_has_session' };
    }
  }
  for (const sid of scratchesToClose) {
    await closeSession(sid);
  }
  // A partially hydrated daemon can have an active target row absent from the
  // runtime map. Durable ownership makes that row a real conflict even when it
  // has worker:null and no legacy CLI markers; only proven ledger-empty
  // scratch rows may be retired.
  const runtimeIds = new Set(activeSessionsRegistry
    ? [...activeSessionsRegistry.values()].map(item => item.session.sessionId)
    : []);
  const persistedTargetConflicts = sessionStore.listSessions().filter(item =>
    item.sessionId !== ds.session.sessionId
    && item.status === 'active'
    && (!item.larkAppId || item.larkAppId === ds.larkAppId)
    && !item.vcMeetingReceiver
    && (item.scope === 'chat' ? item.chatId : item.rootMessageId) === targetAnchor
    && !runtimeIds.has(item.sessionId),
  );
  if (persistedTargetConflicts.some(item =>
    hasProtectedSessionMutationOwnership(item)
    || !!item.cliId
    || !!item.lastCliInput
    || item.queued === true)) {
    return { ok: false, error: 'target_chat_has_session' };
  }
  for (const scratch of persistedTargetConflicts) {
    await closeSession(scratch.sessionId);
  }
  const postScratchStateError = validateAfterAwait();
  if (postScratchStateError) return postScratchStateError;

  const tagPrefix = sessionId.substring(0, 8);
  const oldAnchor = sessionAnchorId(ds);
  const oldChatId = ds.chatId;
  const oldStreamCardId = ds.streamCardId;
  const oldCurrentImageKey = ds.currentImageKey;

  // Scratch/store cleanup above awaited. A fresh source turn may have been
  // admitted during that window; recheck the durable dispatch ledger in the
  // same synchronous section that precedes the destructive detach so transfer
  // never abandons newly durable work.
  if (hasProtectedSessionMutationOwnership(ds)) {
    return { ok: false, error: 'codex_app_dispatch_pending' };
  }

  // Detach only the worker/observer. Persistent backends and Riff keep the
  // owned CLI/task alive so the replacement can reattach below. PTY cannot
  // survive a worker exit and therefore retains its historical cold-resume.
  const sourceWorker = ds.worker ?? undefined;
  let detached: boolean;
  try {
    detached = (await detach(ds)) !== false;
  } catch {
    detached = false;
  }
  if (!detached) {
    // The real detach timeout hard-retires the old worker before returning
    // false. Even with no buffered user input, the unchanged source route
    // therefore needs a cold reattach; otherwise an active session remains
    // silently workerless until some later message happens to wake it.
    transferGate.needsWorker = true;
    if (
      sourceWorker
      && sourceWorker.exitCode === null
      && sourceWorker.signalCode === null
    ) {
      uncertainRetiringWorker = sourceWorker;
    }
    return { ok: false, error: 'worker_detach_timeout' };
  }
  sourceDetached = true;
  const postDetachStateError = validateAfterAwait();
  if (postDetachStateError) return postDetachStateError;

  // Build the source-card snapshot before clearing its runtime fields, but do
  // not PATCH it until the routing commit is irreversible. Marking the card
  // "relayed" before an awaited validation used to leave a false tombstone
  // when a target collision/device freeze won that race.
  let sourceCardFreeze:
    | { cardId: string; cardJson: string }
    | undefined;
  if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL) {
    try {
      const cliId = (ds.session.cliId as CliId | undefined)
        ?? (() => { try { return getBot(ds.larkAppId).config.cliId; } catch { return undefined; } })();
      sourceCardFreeze = {
        cardId: ds.streamCardId,
        cardJson: buildRelayedFrozenCard(
          ds.currentTurnTitle || ds.session.title || '',
          cliId,
          ds.currentImageKey,
          localeForBot(ds.larkAppId),
        ),
      };
    } catch (err) {
      logger.warn(`[${tagPrefix}] build source-chat frozen card failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  activeSessionsRegistry?.delete(sessionKey(oldAnchor, ds.larkAppId));

  // Rewrite routing fields per the requested target scope.
  //   chat-scope:   routes by chatId; `targetRootMessageId` (e.g. an M1 id) is
  //                 stored on rootMessageId but is purely audit/UX.
  //   thread-scope: routes by rootMessageId; `targetRootMessageId` IS the
  //                 routing anchor (the Lark 话题 root) — replies reply_in_thread
  //                 to it, and future inbound messages in that 话题 resolve to
  //                 the same anchor.
  ds.session.chatId = targetChatId;
  ds.session.rootMessageId = targetRootMessageId;
  ds.session.scope = targetScope;
  ds.session.chatType = targetChatType;
  ds.session.lastMessageAt = new Date().toISOString();
  // Card state was pinned to the source chat — clear so the new worker posts
  // a fresh card in the target chat instead of trying to PATCH a message that
  // lives in another chat entirely (the source card was just frozen above).
  ds.session.streamCardId = undefined;
  ds.session.streamCardNonce = undefined;
  ds.session.currentImageKey = undefined;

  // Mirror onto runtime DaemonSession.
  ds.chatId = targetChatId;
  ds.chatType = targetChatType;
  ds.scope = targetScope;
  ds.streamCardId = undefined;
  ds.streamCardNonce = undefined;
  ds.currentImageKey = undefined;

  sessionStore.updateSession(ds.session);

  const newAnchor = sessionAnchorId(ds);
  if (activeSessionsRegistry) {
    if (!setActiveSessionIfActive(activeSessionsRegistry, sessionKey(newAnchor, ds.larkAppId), ds)) {
      return { ok: false, error: 'session_not_active' };
    }
  }
  routingCommitted = true;

  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId,
      patch: {
        chatId: targetChatId,
        rootMessageId: targetRootMessageId,
        scope: targetScope,
        chatType: targetChatType,
      },
    },
  });

  // Best-effort only, and deliberately after the routing commit: an awaited
  // Lark PATCH must never make the source card claim a move that ultimately
  // failed. Do not await network I/O after commit either: transfer completion
  // and replacement startup must not reopen a target/close race window.
  if (sourceCardFreeze) {
    void updateMessage(ds.larkAppId, sourceCardFreeze.cardId, sourceCardFreeze.cardJson)
      .catch((err) => {
        logger.warn(`[${tagPrefix}] freeze source-chat card failed: ${err instanceof Error ? err.message : err}`);
      });
  }

  // forkWorker with resume=true — TmuxBackend.spawn detects the surviving
  // `bmx-<sessionId>` session and re-attaches instead of creating a new one.
  if (
    ds.session.status === 'active'
    && (!activeSessionsRegistry
      || activeSessionsRegistry.get(sessionKey(newAnchor, ds.larkAppId)) === ds)
  ) {
    try {
      forkTransferReplacement(ds, fkw);
    } catch (err) {
      // Routing is already committed. A replacement-spawn failure is an
      // availability problem, not a failed move; keep the gate so the next
      // input can retry on the target route without falsifying the result.
      transferGate.needsWorker = true;
      logger.error(
        `[${tagPrefix}] replacement worker fork failed after transfer commit: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.info(
    `[${tagPrefix}] transferred ${oldChatId} → ${targetChatId} ` +
    `(anchor ${oldAnchor.substring(0, 8)} → ${newAnchor.substring(0, 8)})`,
  );
  return { ok: true };
  } finally {
    if (
      sourceDetached
      && !routingCommitted
      && ds.session.status === 'active'
      && (!activeSessionsRegistry
        || activeSessionsRegistry.get(sourceKey) === ds)
    ) {
      // A target/device/lifecycle race after a successful detach leaves the
      // routing on the source. Reattach even when no user input happened
      // during the critical section; otherwise the active session silently
      // remains workerless until a later message arrives.
      transferGate.needsWorker = true;
    }
    releaseTransferInputGate(ds, transferGate, fkw, uncertainRetiringWorker);
  }
}

/** Backends whose conversation state is a local, copyable transcript file and
 *  whose CLI exposes a native "fork/branch this session" primitive that botmux
 *  can drive at cold spawn (Claude family: `--fork-session`; Codex terminal:
 *  `codex fork <id>`). App-server backends (codex-app, or a codex CLI running in
 *  Hybrid RPC mode) keep state in a live app-server process + SQLite and have no
 *  byte-level fork we can reproduce — they are refused. Riff / other pure-remote
 *  backends have no local rollout to fork either. */
const FORK_CAPABLE_CLI_IDS: ReadonlySet<CliId> = new Set<CliId>([
  'claude-code', 'seed', 'relay', 'codex',
]);

/** True when this session can be byte-level forked via a CLI-native primitive.
 *  Refuses codex-app outright, and refuses a plain `codex` session that is
 *  running in Hybrid RPC mode (its live thread lives in the app-server, not a
 *  forkable local rollout). */
export function isForkCapableSession(ds: DaemonSession): boolean {
  const botCfg = getBot(ds.larkAppId).config;
  const cliId = sessionCliId(ds, botCfg);
  if (!FORK_CAPABLE_CLI_IDS.has(cliId)) return false;
  // Codex terminal mode is forkable; Codex under Hybrid RPC input is not (the
  // thread is an app-server live session, no local rollout to `codex fork`).
  //
  // Read BOTH the live config AND the SPAWN-TIME truth (ds.initConfig): a pane
  // is committed to RPC-or-terminal at spawn (buildArgs runs once) and does NOT
  // hot-swap its argv when the global toggle flips later. So a worker started
  // with codexRpcInput=true that is still running after the operator disables
  // the global default is STILL an RPC pane (live thread in the app-server) —
  // the live config alone (both false) would wrongly re-classify it as terminal
  // and let `/fork` run `codex fork` against a rollout that does not exist.
  // ORing the frozen init flag closes that window (over-refuse, never leak).
  const rpcAtSpawn = ds.initConfig?.codexRpcInput === true;
  if (cliId === 'codex' && (rpcAtSpawn || botCfg.codexRpcInput === true || config.codexRpcInputDefault)) {
    return false;
  }
  return true;
}

/**
 * Fork a session: create a SECOND, independent botmux session that inherits the
 * source's full context at the current node, landing at a different anchor
 * (another group / topic). The source session is left completely untouched and
 * keeps running — this is the non-destructive sibling of {@link transferSession}
 * (relay MOVES one session shell; fork COPIES into a new shell).
 *
 * Context inheritance is delegated to the CLI's native fork primitive
 * (`--fork-session` / `codex fork`) via the child's one-shot
 * `pendingForkSession` marker: the child's first spawn resumes the SOURCE's
 * CLI-native transcript but writes forward into a fresh CLI-minted id. botmux
 * never copies transcript bytes itself.
 *
 * Shares transferSession's front guards (mid-turn / adopt / pendingRepo /
 * vc-receiver / target-anchor occupancy) but performs NONE of its destructive
 * steps (no source card freeze, no worker detach, no source registry delete, no
 * source routing rewrite).
 */
export async function forkSession(
  sessionId: string,
  targetChatId: string,
  targetRootMessageId: string,
  targetChatType: 'group' | 'p2p',
  targetScope: 'thread' | 'chat',
  opts?: {
    forkWorkerImpl?: typeof forkWorker;
    childTitle?: string;
    forkTaskText?: string;
    larkThreadId?: string;
    buildInitialPrompt?: (childSessionId: string) => string | CliTurnPayload;
    turnId?: string;
    senderOpenId?: string;
    senderIsBot?: boolean;
  },
): Promise<{ ok: true; childSessionId: string } | { ok: false; error: string }> {
  if ((targetChatType as string) !== 'group' && (targetChatType as string) !== 'p2p') {
    return { ok: false, error: 'target_chat_type_unsupported' };
  }
  const ds = findActiveBySessionId(sessionId);
  if (!ds) return { ok: false, error: 'session_not_active' };

  // ── Capability gate: only byte-level-forkable backends (§ design doc §4) ──
  if (!isForkCapableSession(ds)) return { ok: false, error: 'fork_unsupported_backend' };

  // ── Front guards (mirror transferSession; a fork needs a clean, complete
  //    source node exactly as a relay does) ──
  if (ds.session.vcMeetingReceiver) return { ok: false, error: 'vc_receiver_not_forkable' };
  if (ds.pendingRepo) return { ok: false, error: 'not_started_yet' };
  if (!isRelayableRealSession(ds)) return { ok: false, error: 'not_started_yet' };
  if (ds.session.adoptedFrom) return { ok: false, error: 'adopt_not_forkable' };
  if (isSessionLifecycleInFlight(ds)) return { ok: false, error: 'worker_busy' };
  const st = ds.lastScreenStatus;
  if (ds.worker && !ds.worker.killed && st !== 'idle' && st !== 'limited') {
    return { ok: false, error: 'worker_busy' };
  }
  if (currentDeviceIsolationFreezeLease()) return { ok: false, error: 'worker_busy' };

  // The source's CLI-native id is what we fork from. Without it there is no
  // transcript node to inherit (should be present for any real session).
  const srcCliSessionId = ds.session.cliSessionId;
  if (!srcCliSessionId) return { ok: false, error: 'not_started_yet' };

  // ── Target anchor occupancy (per-bot; sessionKey carries larkAppId) ──
  const sourceAnchor = sessionAnchorId(ds);
  const targetAnchor = targetScope === 'chat' ? targetChatId : targetRootMessageId;
  if (targetAnchor === sourceAnchor) return { ok: false, error: 'same_anchor' };
  const targetKey = sessionKey(targetAnchor, ds.larkAppId);
  if (activeSessionsRegistry) {
    const scratchesToClose: string[] = [];
    for (const existing of activeSessionsRegistry.values()) {
      if (existing === ds) continue;
      if (existing.larkAppId !== ds.larkAppId) continue;
      if (sessionAnchorId(existing) !== targetAnchor) continue;
      if (isDisposableCommandScratch(existing)) {
        scratchesToClose.push(existing.session.sessionId);
        continue;
      }
      return { ok: false, error: 'target_chat_has_session' };
    }
    for (const sid of scratchesToClose) await closeSession(sid);
    const occupant = activeSessionsRegistry.get(targetKey);
    if (occupant && occupant !== ds) return { ok: false, error: 'target_chat_has_session' };
  }

  // ── Mint the child session row (new botmux sessionId) ──
  const parentTitle = ds.session.title || '';
  const childTitle = opts?.childTitle?.trim()
    || (parentTitle ? `🔱 ${parentTitle}` : '🔱 分身');
  const childSession = sessionStore.createSession(
    targetChatId,
    targetRootMessageId,
    childTitle,
    targetChatType,
    targetScope,
  );
  // Provenance + fork wiring. cliSessionId points at the SOURCE's CLI id: the
  // child's first spawn resumes it and forks forward (pendingForkSession), then
  // the worker persists the child's own new id and clears the marker.
  childSession.forkedFrom = ds.session.sessionId;
  childSession.forkTaskText = opts?.forkTaskText;
  childSession.larkThreadId = opts?.larkThreadId;
  childSession.lastCallerOpenId = opts?.senderOpenId;
  childSession.quoteTargetId = opts?.turnId;
  childSession.quoteTargetSenderOpenId = opts?.senderOpenId;
  childSession.quoteTargetSenderIsBot = opts?.senderIsBot;
  childSession.pendingForkSession = true;
  childSession.cliSessionId = srcCliSessionId;
  childSession.cliId = ds.session.cliId;
  childSession.workingDir = ds.workingDir ?? ds.session.workingDir;
  childSession.ownerOpenId = ds.session.ownerOpenId;
  childSession.backendType = ds.session.backendType;
  // Bot identity on the PERSISTED row. Every other createSession caller sets
  // this immediately after minting (trigger-session / session-manager /
  // card-handler / daemon); the fork child must too. The runtime childDs below
  // carries larkAppId, but if the daemon restarts before the child's first
  // spawn persists its own cliSessionId, restoreActiveSessions resolves the bot
  // via `session.larkAppId ?? getAllBots()[0]` — a missing value silently
  // misattributes the fork to the FIRST bot in the roster (cross-bot identity
  // bug in a multi-bot fleet), and destabilises sandbox transcript/BOT_HOME
  // location.
  childSession.larkAppId = ds.larkAppId;
  // Frozen launch posture — inherit the source's RECORDED decisions wholesale
  // rather than letting forkWorker re-derive them for a brand-new row. Two
  // reasons this is mandatory, not cosmetic:
  //   • sandbox*: a fresh child row has sandbox===undefined, and forkWorker's
  //     cold-spawn runs with resume=true → it hits the "resume + no recorded
  //     decision → sandbox=false" branch meant for pre-sandbox-era legacy
  //     sessions. A fork of a sandboxed session would therefore run UNSANDBOXED
  //     (bwrap credential seal — bots.json deny / sibling appsecrets /
  //     master.key / network deny — silently dropped). This is a security
  //     escape, so copy the recorded decision and its path lists verbatim.
  //   • model / reasoningEffort / cliPathOverride / wrapperCli / agentFrozen:
  //     without these the child's sessionAgentConfig() sees !agentFrozen and
  //     re-freezes from the CURRENT bot config, silently dropping any per-session
  //     /model or /effort override the source carried (reasoningEffort has no
  //     botCfg fallback at all → drops to undefined). Copying the frozen tuple
  //     keeps the clone's launch identity == the source's.
  // readIsolation is intentionally NOT copied: it is not a persisted Session
  // field (forkWorker derives it from botCfg at spawn), and the child runs the
  // SAME bot, so it is preserved automatically. persistentBackendTarget is also
  // intentionally NOT inherited — that is the parent's specific pane/Herdr
  // affinity; the child cold-spawns its own fresh backing.
  childSession.sandbox = ds.session.sandbox;
  childSession.sandboxPaths = ds.session.sandboxPaths;
  childSession.sandboxHidePaths = ds.session.sandboxHidePaths;
  childSession.sandboxReadonlyPaths = ds.session.sandboxReadonlyPaths;
  childSession.sandboxNetwork = ds.session.sandboxNetwork;
  childSession.model = ds.session.model;
  childSession.reasoningEffort = ds.session.reasoningEffort;
  childSession.cliRuntime = ds.session.cliRuntime
    ? { ...ds.session.cliRuntime, update: { ...ds.session.cliRuntime.update } }
    : undefined;
  childSession.cliPathOverride = ds.session.cliPathOverride;
  childSession.wrapperCli = ds.session.wrapperCli;
  childSession.agentFrozen = ds.session.agentFrozen;
  childSession.nativeSessionTitle = childTitle;
  childSession.nativeSessionTitleUserDefined = true;
  sessionStore.updateSession(childSession);

  // ── Build the child runtime DaemonSession (mirrors the restore-path literal;
  //    worker:null → forkWorker cold-spawns a fresh worker for it) ──
  const childDs: DaemonSession = {
    session: childSession,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: ds.larkAppId,
    chatId: targetChatId,
    chatType: targetChatType,
    scope: targetScope,
    spawnedAt: ds.spawnedAt,
    cliVersion: getCurrentCliVersion(),
    lastMessageAt: Date.now(),
    hasHistory: true,           // forked child resumes (forks) prior history on first spawn
    workingDir: ds.workingDir ?? ds.session.workingDir,
    ownerOpenId: ds.session.ownerOpenId,
    // Fresh card in the target anchor — never inherit the source's card id.
    streamCardId: undefined,
    streamCardNonce: undefined,
    displayMode: ds.displayMode ?? 'hidden',
    suppressRecoveryCard: false,
  };

  if (activeSessionsRegistry) {
    if (!(await setActiveSessionSafe(activeSessionsRegistry, targetKey, childDs))) {
      // Target slot was taken between the guard and here — roll back the child
      // row so it doesn't linger as a ghost-active session.
      await closeSession(childSession.sessionId).catch(() => { /* best effort */ });
      return { ok: false, error: 'target_chat_has_session' };
    }
  }

  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: childSession.sessionId,
      patch: {
        chatId: targetChatId,
        rootMessageId: targetRootMessageId,
        scope: targetScope,
        chatType: targetChatType,
      },
    },
  });

  // Cold-spawn the child worker with resume=true → the adapter sees
  // pendingForkSession and passes the native fork flag (--fork-session /
  // codex fork). The SOURCE ds is never touched.
  const fkw = opts?.forkWorkerImpl ?? forkWorker;
  try {
    const initialPrompt = opts?.buildInitialPrompt?.(childSession.sessionId) ?? '';
    if (initialPrompt) {
      rememberLastCliInput(
        childDs,
        opts?.forkTaskText ?? (typeof initialPrompt === 'string' ? initialPrompt : initialPrompt.content),
        initialPrompt,
      );
    }
    fkw(
      childDs,
      initialPrompt,
      opts?.turnId ? { resume: true, turnId: opts.turnId } : true,
    );
  } catch (err) {
    logger.error(
      `[${childSession.sessionId.substring(0, 8)}] fork child worker spawn failed: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    await closeSession(childSession.sessionId).catch(() => { /* best effort */ });
    return { ok: false, error: 'fork_spawn_failed' };
  }

  logger.info(
    `[${sessionId.substring(0, 8)}] forked → child ${childSession.sessionId.substring(0, 8)} `
    + `at anchor ${targetAnchor.substring(0, 8)} (source untouched)`,
  );
  return { ok: true, childSessionId: childSession.sessionId };
}

// ─── Fork worker ────────────────────────────────────────────────────────────

/** True if `p` resolves (via realpath) to the user's home dir. Used to exclude
 *  $HOME — including a symlinked/aliased home or a different textual form — from
 *  the session-workingDir back-fill, so a sibling bot never inherits the home dir.
 *  Falls back to a string compare if realpath can't resolve (e.g. transient race). */
function resolvesToHome(p: string): boolean {
  try { return realpathSync(p) === realpathSync(homedir()); }
  catch { return p === homedir(); }
}

export function codexAppCleanInputAcceptedForSession(ds: DaemonSession): boolean {
  try {
    const botCfg = getBot(ds.larkAppId).config;
    const effectiveCliId = ds.session.cliId ?? botCfg.cliId;
    return effectiveCliId === 'codex-app'
      && botCfg.codexAppCleanInput === true
      && !ds.adoptedFrom;
  } catch {
    // Admission metadata is optional for every other CLI. If bot config is
    // temporarily unavailable, fail closed instead of leaking a clean sidecar.
    return false;
  }
}

function cloneFrozenCodexAppInput(
  input: CodexAppTurnInput | undefined,
  turnId?: string,
): CodexAppTurnInput | undefined {
  if (!input) return undefined;
  const cloned = structuredClone(input);
  if (turnId && !cloned.clientUserMessageId) cloned.clientUserMessageId = turnId;
  return cloned;
}

function canForkRegisteredSession(ds: DaemonSession): boolean {
  const key = activeSessionKey(ds);
  const registered = activeSessionsRegistry ? activeSessionsRegistry.get(key) : ds;
  if (ds.session.status === 'active' && registered === ds) return true;
  if (activeSessionsRegistry && ds.session.status !== 'active' && registered === ds) {
    activeSessionsRegistry.delete(key);
  }
  logger.warn(
    `[${tag(ds)}] Refusing to fork a closed or superseded session ` +
    `(status=${ds.session.status}, registered=${registered === ds})`,
  );
  return false;
}

function codexAppInputForSession(
  ds: DaemonSession,
  input: CodexAppTurnInput | undefined,
  turnId?: string,
): CodexAppTurnInput | undefined {
  if (!input) return undefined;
  if (!codexAppCleanInputAcceptedForSession(ds)) return undefined;
  return cloneFrozenCodexAppInput(input, turnId);
}

function codexAppDeliverySinkForTurn(
  ds: DaemonSession,
  turnId: string,
  dispatchAttempt: number | undefined,
): CodexAppDeliverySink {
  const armedThrough = ds.suppressedFinalOutputTurns?.get(turnId);
  if (dispatchAttempt !== undefined
    && armedThrough !== undefined
    && dispatchAttempt <= armedThrough) return 'suppressed';
  if (ds.session.docCommentTargets?.[turnId] || ds.docCommentTurns?.has(turnId)) {
    return 'doc_comment';
  }
  if (ds.pendingWaitPromises?.has(turnId)) return 'http_wait';
  if (ds.asyncTriggerResults?.has(turnId)) return 'http_async';
  return 'lark';
}

/** A recovered transient/non-IM sink has no safe provider to replay into.
 * Treat it as consumed so the runner can advance, but never fall through to a
 * Lark card. Doc-comment replay also fails closed: chunk posting has no durable
 * per-chunk effect journal yet, so blind crash replay could duplicate comments. */
function codexAppDeliveryMustFailClosed(
  ds: DaemonSession,
  entry: CodexAppDispatchLedgerEntry,
): boolean {
  const sink = entry.deliverySink
    ?? (ds.session.docCommentTargets?.[entry.turnId]
      ? 'doc_comment'
      : ds.chatId.startsWith('http_wait_')
        ? 'http_wait'
        : ds.chatId.startsWith('http_async_')
          ? 'http_async'
          : 'lark');
  if (sink === 'suppressed') return true;
  if (sink === 'doc_comment') return !ds.docCommentTurns?.has(entry.turnId);
  if (sink === 'http_wait') return !ds.pendingWaitPromises?.has(entry.turnId);
  if (sink === 'http_async') return !ds.asyncTriggerResults?.has(entry.turnId);
  return false;
}

function acceptCodexAppDispatch(
  ds: DaemonSession,
  payload: {
    content: string;
    codexAppInput?: CodexAppTurnInput;
    replyTurnId?: string;
    replyTarget?: FrozenSessionReplyTarget;
    quoteTargetId?: string;
    replyTargetSenderOpenId?: string;
    replyTargetSenderIsBot?: boolean;
    queuedActivationToken?: string;
    codexAppSteerable?: true;
  },
  turnId: string | undefined,
  dispatchAttempt: number | undefined,
  vcMeetingImTurnOrigin: ReturnType<typeof resolveVcMeetingImTurnOrigin>,
  opts: { persist?: boolean } = {},
): string | undefined {
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = ds.session.cliId ?? botCfg.cliId;
  if (effectiveCliId !== 'codex-app' || !turnId) return undefined;
  const dispatchId = randomUUID();
  const priorLedger = ds.session.codexAppDispatchLedger;
  ds.session.codexAppDispatchLedger = appendAcceptedCodexAppDispatch(
    ds.session.codexAppDispatchLedger ?? [],
    {
      dispatchId,
      turnId,
      ...(payload.queuedActivationToken
        ? { queuedActivationToken: payload.queuedActivationToken }
        : {}),
      ...(payload.replyTurnId ? { replyTurnId: payload.replyTurnId } : {}),
      ...(payload.replyTarget ? { replyTarget: payload.replyTarget } : {}),
      ...(payload.quoteTargetId ? { quoteTargetId: payload.quoteTargetId } : {}),
      ...(payload.replyTargetSenderOpenId
        ? { replyTargetSenderOpenId: payload.replyTargetSenderOpenId }
        : {}),
      ...(payload.replyTargetSenderIsBot !== undefined
        ? { replyTargetSenderIsBot: payload.replyTargetSenderIsBot }
        : {}),
      deliverySink: codexAppDeliverySinkForTurn(ds, turnId, dispatchAttempt),
      ...(payload.codexAppSteerable ? { codexAppSteerable: true } : {}),
      ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
      content: payload.content,
      ...(payload.codexAppInput ? { codexAppInput: payload.codexAppInput } : {}),
      ...(vcMeetingImTurnOrigin ? { vcMeetingImTurnOrigin } : {}),
    },
  );
  if (opts.persist !== false) {
    try {
      sessionStore.updateSession(ds.session);
    } catch (err) {
      ds.session.codexAppDispatchLedger = priorLedger;
      throw err;
    }
  }
  return dispatchId;
}

function rollbackAcceptedCodexAppDispatch(
  ds: DaemonSession,
  dispatchId: string | undefined,
  turnId: string | undefined,
  dispatchAttempt: number | undefined,
): void {
  if (!dispatchId || !turnId) return;
  const cancelled = cancelCodexAppDispatch(ds.session.codexAppDispatchLedger ?? [], {
    dispatchId,
    turnId,
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
  });
  if (!cancelled.ok) return;
  const priorLedger = ds.session.codexAppDispatchLedger;
  ds.session.codexAppDispatchLedger = cancelled.ledger;
  try {
    sessionStore.updateSession(ds.session);
    if (!hasUnsettledCodexAppDispatch(ds.session.codexAppDispatchLedger)) {
      void Promise.resolve(callbacks?.onCodexAppLedgerDrained?.(ds)).catch(err => {
        logger.error(
          `[${ds.session.sessionId.slice(0, 8)}] post-rollback ledger-drain cleanup failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  } catch {
    ds.session.codexAppDispatchLedger = priorLedger;
  }
}

type QueuedWorkerForkSnapshot = {
  queued: true;
  queuedPrompt: Session['queuedPrompt'];
  queuedCodexAppText: Session['queuedCodexAppText'];
  queuedCodexAppMessageContext: Session['queuedCodexAppMessageContext'];
  queuedActivationPending: Session['queuedActivationPending'];
  queuedActivationToken: Session['queuedActivationToken'];
  queuedActivationInput: Session['queuedActivationInput'];
  queuedActivationTurnId: Session['queuedActivationTurnId'];
  queuedActivationDispatchAttempt: Session['queuedActivationDispatchAttempt'];
  queuedActivationResume: Session['queuedActivationResume'];
  initialStartPending: DaemonSession['initialStartPending'];
};

type QueuedActivationJournalSnapshot = Pick<
  Session,
  | 'queuedActivationPending'
  | 'queuedActivationToken'
  | 'queuedActivationInput'
  | 'queuedActivationTurnId'
  | 'queuedActivationDispatchAttempt'
  | 'queuedActivationResume'
  | 'queuedPrompt'
  | 'queuedCodexAppText'
  | 'queuedCodexAppMessageContext'
  | 'pendingRepoSetup'
>;

function snapshotQueuedActivationJournal(session: Session): QueuedActivationJournalSnapshot {
  return {
    queuedActivationPending: session.queuedActivationPending,
    queuedActivationToken: session.queuedActivationToken,
    queuedActivationInput: session.queuedActivationInput,
    queuedActivationTurnId: session.queuedActivationTurnId,
    queuedActivationDispatchAttempt: session.queuedActivationDispatchAttempt,
    queuedActivationResume: session.queuedActivationResume,
    queuedPrompt: session.queuedPrompt,
    queuedCodexAppText: session.queuedCodexAppText,
    queuedCodexAppMessageContext: session.queuedCodexAppMessageContext,
    pendingRepoSetup: session.pendingRepoSetup
      ? structuredClone(session.pendingRepoSetup)
      : undefined,
  };
}

function restoreQueuedActivationJournal(
  session: Session,
  snapshot: QueuedActivationJournalSnapshot,
): void {
  Object.assign(session, snapshot);
}

function clearQueuedActivationJournal(session: Session): void {
  session.queuedActivationPending = undefined;
  session.queuedActivationToken = undefined;
  session.queuedActivationInput = undefined;
  session.queuedActivationTurnId = undefined;
  session.queuedActivationDispatchAttempt = undefined;
  session.queuedActivationResume = undefined;
  session.queuedPrompt = undefined;
  session.queuedCodexAppText = undefined;
  session.queuedCodexAppMessageContext = undefined;
  session.pendingRepoSetup = undefined;
}

/** A worker disappeared before the exact activation ACK. Re-park non-Codex
 * work from the retained exact input; ACK loss may duplicate, but N can never
 * be silently replaced by a later inbound turn in the same daemon lifetime. */
function reparkUnsubmittedQueuedActivation(ds: DaemonSession, reason: string): boolean {
  if (!ds.session.queuedActivationPending
    || !ds.session.queuedActivationToken
    || ds.session.cliId === 'codex-app') return false;
  ds.session.queued = true;
  ds.session.queuedActivationPending = undefined;
  ds.session.queuedActivationToken = undefined;
  ds.initialStartPending = false;
  ds.initialStartClaimToken = undefined;
  ds.pendingPrompt ??= ds.session.queuedPrompt;
  try {
    sessionStore.updateSession(ds.session);
  } catch (err) {
    // Memory remains explicitly parked while the old durable marker still
    // provides restart recovery on disk.
    logger.error(
      `[${tag(ds)}] Failed to persist queued activation re-park after ${reason}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  logger.warn(`[${tag(ds)}] Re-parked unacknowledged queued activation after ${reason}`);
  return true;
}

/** The opening activation was ACKed, but one of the turns held behind its
 * runtime reservation was not accepted before that worker exited. Promote the
 * exact FIFO head into a new durable queued activation so the next inbound or
 * Dashboard activation reforks it before every remaining tail item. */
function reparkQueuedActivationFollowUpTail(ds: DaemonSession, reason: string): boolean {
  if (!ds.initialStartPending || ds.session.queuedActivationPending) return false;
  const next = ds.pendingQueuedActivationFollowUps?.[0];
  if (!next) return false;
  const matchingCodexEntries = ds.session.cliId === 'codex-app'
    ? (ds.session.codexAppDispatchLedger ?? []).filter(entry =>
      (entry.state === 'accepted' || entry.state === 'prepared')
      && entry.turnId === next.turnId
      && entry.dispatchAttempt === next.dispatchAttempt)
    : [];
  if (matchingCodexEntries.length > 1) {
    logger.error(
      `[${tag(ds)}] Cannot re-park queued follow-up after ${reason}: `
      + `${matchingCodexEntries.length} Codex entries match turn ${next.turnId}`,
    );
    return false;
  }
  const retainedCodexEntry = matchingCodexEntries[0];
  const retainedCodexToken = retainedCodexEntry
    ? (retainedCodexEntry.queuedActivationToken ?? randomUUID())
    : undefined;
  // A failed daemon→worker IPC normally rolls its newly accepted Codex entry
  // back. If that rollback persistence itself failed, the durable FIFO remains
  // authoritative: recover it through a tokened ACK journal instead of
  // creating an invalid queued+unsettled hybrid.
  ds.session.queued = !retainedCodexEntry;
  ds.session.queuedPrompt = next.cliInput.content;
  ds.session.queuedCodexAppText = next.cliInput.codexAppInput?.text;
  ds.session.queuedCodexAppMessageContext = undefined;
  ds.session.queuedActivationInput = next.cliInput;
  ds.session.queuedActivationTurnId = next.turnId;
  ds.session.queuedActivationDispatchAttempt = next.dispatchAttempt;
  ds.session.queuedActivationPending = retainedCodexEntry ? true : undefined;
  ds.session.queuedActivationToken = retainedCodexToken;
  if (retainedCodexEntry && retainedCodexToken) {
    retainedCodexEntry.queuedActivationToken = retainedCodexToken;
  }
  ds.pendingQueuedActivationFollowUps!.shift();
  if (ds.pendingQueuedActivationFollowUps!.length === 0) {
    ds.pendingQueuedActivationFollowUps = undefined;
  }
  ds.pendingPrompt = next.cliInput.content;
  ds.initialStartPending = false;
  ds.initialStartClaimToken = undefined;
  try {
    sessionStore.updateSession(ds.session);
  } catch (err) {
    // Keep the exact head parked in memory. The caller has already fenced the
    // dead worker, so a later inbound can safely retry this owner even if the
    // durable projection is temporarily unavailable.
    logger.error(
      `[${tag(ds)}] Failed to persist queued follow-up re-park after ${reason}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  logger.warn(`[${tag(ds)}] Re-parked unaccepted queued activation follow-up after ${reason}`);
  return true;
}

export const __testOnly_reparkQueuedActivationFollowUpTail = reparkQueuedActivationFollowUpTail;

type AcceptedWorkerForkDispatch = {
  dispatchId: string;
  turnId: string;
  dispatchAttempt?: number;
};

/** Compensate only the durable mutations made before a worker accepts its init
 * IPC. This is one synchronous call stack, so removing the exact dispatch that
 * this fork appended cannot race a later worker transition or damage the FIFO
 * that existed before the attempt. Persist the queued payload and ledger in one
 * write so a daemon crash cannot observe only half of the compensation. */
function rollbackWorkerForkPreInit(
  ds: DaemonSession,
  queuedSnapshot: QueuedWorkerForkSnapshot | undefined,
  acceptedDispatch: AcceptedWorkerForkDispatch | undefined,
): void {
  const exactActivationInput = ds.session.queuedActivationInput;
  const exactActivationTurnId = ds.session.queuedActivationTurnId;
  const exactActivationDispatchAttempt = ds.session.queuedActivationDispatchAttempt;
  const exactActivationResume = ds.session.queuedActivationResume;
  let changed = false;
  if (acceptedDispatch) {
    const cancelled = cancelCodexAppDispatch(
      ds.session.codexAppDispatchLedger ?? [],
      acceptedDispatch,
    );
    if (!cancelled.ok) {
      throw new Error(`failed to cancel pre-init Codex App dispatch: ${cancelled.error}`);
    }
    ds.session.codexAppDispatchLedger = cancelled.ledger;
    changed = true;
  }
  if (queuedSnapshot) {
    ds.session.queued = queuedSnapshot.queued;
    restoreQueuedActivationJournal(ds.session, queuedSnapshot);
    // The activation may have folded a triggering group reply into the final
    // init payload. Retain that exact retry body even though the in-flight
    // marker/token are rolled back with the fenced child.
    ds.session.queuedActivationPending = undefined;
    ds.session.queuedActivationToken = undefined;
    ds.session.queuedActivationInput = exactActivationInput;
    ds.session.queuedActivationTurnId = exactActivationTurnId;
    ds.session.queuedActivationDispatchAttempt = exactActivationDispatchAttempt;
    ds.session.queuedActivationResume = exactActivationResume;
    ds.initialStartPending = queuedSnapshot.initialStartPending;
    changed = true;
  }
  if (changed) sessionStore.updateSession(ds.session);
}

/** Send one normal (non-raw) worker turn while applying the per-bot Codex App
 * clean-input gate at message acceptance time. This freezes the sidecar onto
 * the IPC item, so later config flips do not mutate an already queued turn. */
export function sendWorkerInput(
  ds: DaemonSession,
  payload: string | CliTurnPayload,
  turnId?: string,
  opts: {
    dispatchAttempt?: number;
    /** Explicit positive steer authorization (plain-human-interactive only).
     * Persisted on the accepted ledger entry and forwarded to the worker so the
     * serial runner may steer this turn into an active one. */
    codexAppSteerable?: true;
  } = {},
): boolean {
  const transferGate = transferInputGates.get(ds);
  if ((!ds.worker || ds.worker.killed) && !transferGate) return false;
  const normalized = typeof payload === 'string' ? { content: payload } : payload;
  const effectiveCliId = ds.session.cliId ?? getBot(ds.larkAppId).config.cliId;
  const effectiveTurnId = turnId ?? (effectiveCliId === 'codex-app'
    ? `codex-app-dispatch-${randomUUID()}`
    : undefined);
  const replyTurnId = turnId ? undefined : ds.currentReplyTarget?.turnId;
  const routingTurnId = turnId ?? replyTurnId;
  const replyContext = frozenReplyContextForTurn(ds, routingTurnId);
  const vcMeetingImTurnOrigin = resolveVcMeetingImTurnOrigin(ds.session, routingTurnId);
  let nativeSessionTitlePrompt: string | undefined;
  let nativeSessionTitle: string | undefined;
  if (ds.session.nativeSessionTitleAwaitingContent && !ds.session.nativeSessionTitleUserDefined && !ds.adoptedFrom) {
    const bot = getBot(ds.larkAppId);
    if (effectiveCliId === 'codex') {
      nativeSessionTitlePrompt = extractBotmuxLarkNativeSessionTitlePrompt(
        normalized.codexAppInput?.text ?? normalized.content,
        bot.botName ? [{ name: bot.botName }] : undefined,
      );
      if (nativeSessionTitlePrompt) {
        nativeSessionTitle = buildBotmuxLarkNativeSessionTitle(nativeSessionTitlePrompt);
        ds.session.nativeSessionTitle = nativeSessionTitle;
        ds.session.nativeSessionTitleAwaitingContent = undefined;
        if (ds.initConfig) {
          ds.initConfig.nativeSessionTitle = nativeSessionTitle;
          ds.initConfig.nativeSessionTitlePrompt = nativeSessionTitlePrompt;
        }
        sessionStore.updateSession(ds.session);
      }
    }
  }

  if (hasQueuedActivationAdmissionGate(ds)) {
    const queuedTurnId = effectiveTurnId
      ?? routingTurnId
      ?? `queued-activation-followup-${randomUUID()}`;
    try {
      admitQueuedActivationTail(ds, {
        userPrompt: normalized.content,
        cliInput: {
          content: normalized.content,
          ...(normalized.codexAppInput
            ? { codexAppInput: normalized.codexAppInput }
            : {}),
          // R4-B1: freeze the admission-time steer authorization into the queued
          // tail's frozen payload so promote/repark/restore COPY it verbatim
          // (admission computed once; never re-inferred downstream).
          ...(opts.codexAppSteerable ? { codexAppSteerable: true } : {}),
        },
        turnId: queuedTurnId,
        ...(opts.dispatchAttempt !== undefined
          ? { dispatchAttempt: opts.dispatchAttempt }
          : {}),
      });
      logger.info(
        `[${tag(ds)}] Staged turn ${queuedTurnId} behind queued activation ACK`,
      );
      return true;
    } catch (err) {
      logger.error(
        `[${tag(ds)}] Failed to durably stage turn ${queuedTurnId} behind activation: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  const codexAppInput = codexAppInputForSession(
    ds,
    normalized.codexAppInput,
    effectiveTurnId,
  );
  const codexAppDispatchId = acceptCodexAppDispatch(
    ds,
    {
      content: normalized.content,
      ...(codexAppInput ? { codexAppInput } : {}),
      ...(replyTurnId ? { replyTurnId } : {}),
      replyTarget: replyContext.target,
      ...(replyContext.quoteTargetId ? { quoteTargetId: replyContext.quoteTargetId } : {}),
      ...(replyContext.replyTargetSenderOpenId
        ? { replyTargetSenderOpenId: replyContext.replyTargetSenderOpenId }
        : {}),
      ...(replyContext.replyTargetSenderIsBot !== undefined
        ? { replyTargetSenderIsBot: replyContext.replyTargetSenderIsBot }
        : {}),
      ...(opts.codexAppSteerable ? { codexAppSteerable: true } : {}),
    },
    effectiveTurnId,
    opts.dispatchAttempt,
    vcMeetingImTurnOrigin,
  );
  // Route through sendWorkerSessionInput so an in-flight routing transfer
  // buffers this turn instead of dropping it (master's transfer input gate),
  // while preserving PR #597's accepted-dispatch ledger + reply-context wiring.
  const message: Extract<DaemonToWorker, { type: 'message' }> = {
    type: 'message',
    content: normalized.content,
    ...(codexAppInput ? { codexAppInput } : {}),
    ...(nativeSessionTitle ? { nativeSessionTitle } : {}),
    ...(nativeSessionTitlePrompt ? { nativeSessionTitlePrompt } : {}),
    ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
    ...(replyTurnId ? { replyTurnId } : {}),
    ...(opts.dispatchAttempt !== undefined ? { dispatchAttempt: opts.dispatchAttempt } : {}),
    ...(codexAppDispatchId ? { codexAppDispatchId } : {}),
    ...(opts.codexAppSteerable ? { codexAppSteerable: true } : {}),
    ...(vcMeetingImTurnOrigin
      ? { vcMeetingImTurnOrigin }
      : {}),
  };
  // #597: the accept-ledger entry is already appended above; if the IPC send
  // fails (returns false or throws) we MUST roll it back or the dispatch ledger
  // keeps a phantom accepted turn. master's ordinary-IM-delivery tracking runs
  // inside the same protected send so a tracked delivery still rolls back.
  const performSend = (): boolean => {
    if (!transferGate && shouldTrackOrdinaryImDelivery(ds, message)) {
      return sendOrdinaryImDeliveryTracked(ds, message);
    }
    return sendWorkerSessionInput(ds, message);
  };
  try {
    if (!performSend()) {
      rollbackAcceptedCodexAppDispatch(
        ds,
        codexAppDispatchId,
        effectiveTurnId,
        opts.dispatchAttempt,
      );
      return false;
    }
  } catch {
    rollbackAcceptedCodexAppDispatch(
      ds,
      codexAppDispatchId,
      effectiveTurnId,
      opts.dispatchAttempt,
    );
    return false;
  }
  return true;
}

/** Promote the oldest durable activation successor into a fresh tokened
 * journal and (for Codex App) its single accepted-ledger owner in one store
 * update, then hand it to the current worker. The tail is never shifted merely
 * because ChildProcess.send returned: the promoted journal survives until the
 * adapter ACK carrying this token arrives. */
export function promoteQueuedActivationTail(
  ds: DaemonSession,
  opts: { send?: boolean } = {},
): boolean {
  if (ds.session.queuedActivationPending) return true;
  if (opts.send !== false
    && (!ds.worker || ds.worker.killed)) return false;
  const ordered = [...(ds.session.queuedActivationTail ?? [])]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const head = ordered[0];
  if (!head) return false;

  const priorJournal = snapshotQueuedActivationJournal(ds.session);
  const priorTail = ds.session.queuedActivationTail?.map(entry => ({
    ...entry,
    cliInput: {
      ...entry.cliInput,
      ...(entry.cliInput.codexAppInput
        ? { codexAppInput: structuredClone(entry.cliInput.codexAppInput) }
        : {}),
    },
  }));
  const priorLedger = ds.session.codexAppDispatchLedger?.map(entry => ({ ...entry }));
  const priorPendingPrompt = ds.pendingPrompt;
  const token = randomUUID();
  const replyContext = frozenReplyContextForTurn(ds, head.turnId);
  // The tail entry crossed its admission boundary with the clean-input gate
  // already frozen. Do not re-run that immediate bot-config gate at promotion:
  // a true→false toggle between N+1 admission and N's ACK would otherwise
  // discard N+1's exact sidecar/hidden context. Only fill the deterministic id
  // for legacy entries persisted before admission began stamping it.
  const codexAppInput = cloneFrozenCodexAppInput(
    head.cliInput.codexAppInput,
    head.turnId,
  );
  const exactInput: CliTurnPayload = {
    content: head.cliInput.content,
    ...(codexAppInput ? { codexAppInput } : {}),
    // R5-B1-2: preserve the frozen steer authorization onto the promoted
    // queuedActivationInput so the ensuing fork/accept-ledger COPY (below) sees
    // it. Only `=== true`; a missing/false tail head stays forced-serial.
    ...(head.cliInput.codexAppSteerable === true ? { codexAppSteerable: true as const } : {}),
  };
  const vcMeetingImTurnOrigin = resolveVcMeetingImTurnOrigin(ds.session, head.turnId);

  ds.session.queued = false;
  ds.session.queuedActivationPending = true;
  ds.session.queuedActivationToken = token;
  ds.session.queuedActivationInput = exactInput;
  ds.session.queuedActivationTurnId = head.turnId;
  ds.session.queuedActivationDispatchAttempt = head.dispatchAttempt;
  ds.session.queuedActivationResume = ds.hasHistory;
  ds.session.queuedActivationTail = ordered.slice(1);
  if (ds.session.queuedActivationTail.length === 0) {
    ds.session.queuedActivationTail = undefined;
  }
  ds.pendingPrompt = exactInput.content;
  ds.initialStartPending = true;

  let codexAppDispatchId: string | undefined;
  try {
    codexAppDispatchId = acceptCodexAppDispatch(
      ds,
      {
        content: exactInput.content,
        ...(codexAppInput ? { codexAppInput } : {}),
        queuedActivationToken: token,
        replyTarget: replyContext.target,
        ...(replyContext.quoteTargetId ? { quoteTargetId: replyContext.quoteTargetId } : {}),
        ...(replyContext.replyTargetSenderOpenId
          ? { replyTargetSenderOpenId: replyContext.replyTargetSenderOpenId }
          : {}),
        ...(replyContext.replyTargetSenderIsBot !== undefined
          ? { replyTargetSenderIsBot: replyContext.replyTargetSenderIsBot }
          : {}),
        // R4-B1: COPY the frozen steer authorization from the promoted tail
        // entry's payload onto the accept-ledger (admission computed once; never
        // re-inferred at promote time).
        ...(exactInput.codexAppSteerable ? { codexAppSteerable: true } : {}),
      },
      head.turnId,
      head.dispatchAttempt,
      vcMeetingImTurnOrigin,
      { persist: false },
    );
    sessionStore.updateSession(ds.session);
  } catch (err) {
    restoreQueuedActivationJournal(ds.session, priorJournal);
    ds.session.queuedActivationTail = priorTail;
    ds.session.codexAppDispatchLedger = priorLedger;
    ds.pendingPrompt = priorPendingPrompt;
    logger.error(
      `[${tag(ds)}] Failed to atomically promote queued activation tail ${head.id}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  if (opts.send === false) return true;
  try {
    ds.worker!.send({
      type: 'message',
      content: exactInput.content,
      ...(codexAppInput ? { codexAppInput } : {}),
      turnId: head.turnId,
      ...(head.dispatchAttempt !== undefined
        ? { dispatchAttempt: head.dispatchAttempt }
        : {}),
      ...(codexAppDispatchId ? { codexAppDispatchId } : {}),
      // R6-B2: COPY the frozen steer authorization onto the live-worker IPC — the
      // last hop. Without it a promoted N+1 reaches a live worker with the daemon
      // ledger head steerable=true but the worker reservation false, so a
      // legitimate superseded settlement would be wrongly rejected.
      ...(exactInput.codexAppSteerable === true ? { codexAppSteerable: true as const } : {}),
      queuedActivationToken: token,
      ...(vcMeetingImTurnOrigin ? { vcMeetingImTurnOrigin } : {}),
    } as DaemonToWorker);
  } catch (err) {
    // Durable ownership already moved to the journal (and Codex ledger). Never
    // append another owner on retry; fence this IPC generation and let recovery
    // replay the exact tokened head.
    logger.error(
      `[${tag(ds)}] Worker IPC rejected promoted activation ${head.id}; retaining journal: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    try { ds.worker!.kill(); } catch { /* exit/error path will fence runtime */ }
  }
  return true;
}

export type QueuedActivationTailReservation = Pick<QueuedActivationTailEntry, 'id' | 'order'> & {
  /** Clean-input decision captured synchronously with FIFO order, before any
   * caller-specific async prompt construction. This field is runtime-only. */
  codexAppInputAccepted?: boolean;
};

/** Reserve arrival order synchronously, before any caller-specific prompt
 * rendering may await. Gaps are harmless; reusing an order after a failed
 * durable admission would not be. */
export function reserveQueuedActivationTailAdmission(
  ds: DaemonSession,
): QueuedActivationTailReservation {
  const order = (ds.session.queuedActivationTailNextOrder ?? 0) + 1;
  ds.session.queuedActivationTailNextOrder = order;
  return {
    id: randomUUID(),
    order,
    codexAppInputAccepted: codexAppCleanInputAcceptedForSession(ds),
  };
}

/** Admit one exact successor behind a queued activation. The response boundary
 * is the session-store write: callers must not report acceptance or use live
 * worker IPC unless this returns. `reservation` lets routes reserve FIFO order
 * before asynchronous prompt construction without duplicating persistence
 * logic. */
export function admitQueuedActivationTail(
  ds: DaemonSession,
  entry: Omit<QueuedActivationTailEntry, 'id' | 'order'>,
  reservation: QueuedActivationTailReservation = reserveQueuedActivationTailAdmission(ds),
  opts: { codexAppInputGateFrozen?: boolean } = {},
): QueuedActivationTailEntry {
  const acceptedCodexAppInput = opts.codexAppInputGateFrozen === true
    ? cloneFrozenCodexAppInput(entry.cliInput.codexAppInput, entry.turnId)
    : reservation.codexAppInputAccepted === true
      ? cloneFrozenCodexAppInput(entry.cliInput.codexAppInput, entry.turnId)
      : undefined;
  const admitted: QueuedActivationTailEntry = {
    id: reservation.id,
    order: reservation.order,
    ...entry,
    cliInput: {
      content: entry.cliInput.content,
      ...(acceptedCodexAppInput ? { codexAppInput: acceptedCodexAppInput } : {}),
      // R5-B1-2: preserve the frozen steer authorization across the tail rebuild
      // (only `=== true`, never truthy). Dropping it here silently un-authorized
      // every queued/opening turn — the strip point that defeated the R4 fix.
      ...(entry.cliInput.codexAppSteerable === true ? { codexAppSteerable: true as const } : {}),
    },
  };
  const priorTail = ds.session.queuedActivationTail;
  const next = [...(priorTail ?? [])];
  if (!next.some(candidate => candidate.id === admitted.id)) next.push(admitted);
  next.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  ds.session.queuedActivationTail = next;
  try {
    sessionStore.updateSession(ds.session);
  } catch (err) {
    ds.session.queuedActivationTail = priorTail;
    throw err;
  }
  return admitted;
}

/** True while a live worker's opening activation still owns submission order.
 * Every ingress that sees this state must use admitQueuedActivationTail rather
 * than ordinary worker IPC. */
export function hasQueuedActivationAdmissionGate(ds: DaemonSession): boolean {
  return ds.session.queuedActivationPending === true
    || (ds.session.queuedActivationTail?.length ?? 0) > 0
    || (ds.queuedActivationTailAdmissionsOutstanding ?? 0) > 0
    || ds.queuedActivationTailReleasePending !== undefined
    || (ds.initialStartPending === true
      && ds.session.queuedActivationInput !== undefined);
}

export type ForkResumeOrTurnId = boolean | string | {
  resume?: boolean;
  turnId?: string;
  dispatchAttempt?: number;
  /** The payload is an exact retained activation journal. Do not re-read the
   * live clean-input feature flag on retry/replay. */
  codexAppInputGateFrozen?: boolean;
  /** Correlates a worker restart across the detach/refork boundary so late
   * lifecycle events from the retired worker are not misattributed. */
  restartAttemptId?: string;
  /** At-most-once turn (idempotency lease): the worker must NEVER replay this
   *  input after a CLI exit — not via inflight carry-over, not from the still-
   *  queued pendingMessages. Once the daemon terminalizes the turn, re-executing
   *  it on an auto-restarted CLI would violate at-most-once (codex #776 round-7
   *  finding #1). */
  atMostOnce?: boolean;
};

/** Central quarantine decision for one fork boundary — the SINGLE authority that
 * keeps a restore-time "tail-only quarantine" from being forked incorrectly.
 *
 * A quarantined owner (see restoreActiveSessions) has an old activation-tail head
 * that failed to promote transiently: the head sits un-promoted in the tail with
 * the admission gate held (worker:null). The invariant across EVERY fork boundary
 * (restore reattach, IM inbound refork, web-terminal lazy wake, and any future
 * one) is enforced here so callers cannot each miss it:
 *
 *  - Not quarantined → pass the caller's args through unchanged.
 *  - Quarantined + NON-empty prompt → REFUSE (`fork:false`). forkWorker cannot
 *    verify the caller durably staged this turn behind the old head, so letting
 *    it through could overtake the head. The inbound path must durable-admit the
 *    turn into the tail first, then blank-recover (empty prompt) through here.
 *  - Quarantined + empty prompt → retry the old head's promotion. On failure keep
 *    the flag/gate/worker:null and REFUSE (a blank fork would leave a live worker
 *    beside an unpromoted tail and permanently wedge the FIFO gate). On success,
 *    clear the flag and rewrite the fork to recover the PROMOTED OLD HEAD (never
 *    the caller's turn): Codex App recovers through its ledger with an empty
 *    prompt; a non-Codex CLI resubmits the exact `queuedActivationInput` with the
 *    persisted resume/turn/attempt — mirroring the daemon activation-recovery fork.
 *
 * Extracted (and exported) so the orchestration can be unit-tested without a real
 * tmux/worker: mock `promoteQueuedActivationTail` and assert refuse vs. recover
 * args, then that forkWorker applies them.
 */
export function resolveQuarantinedForkPlan(
  ds: DaemonSession,
  promptInput: string | CliTurnPayload,
  resumeOrTurnId: ForkResumeOrTurnId,
): { fork: boolean; promptInput: string | CliTurnPayload; resumeOrTurnId: ForkResumeOrTurnId } {
  if (!ds.quarantinedActivationTailPromotion) {
    return { fork: true, promptInput, resumeOrTurnId };
  }
  const content = typeof promptInput === 'string' ? promptInput : promptInput.content;
  if (content.length > 0) {
    logger.warn(
      `[${tag(ds)}] Refused non-empty fork of a quarantined tail-only owner; `
      + `caller must durable-admit the turn behind the old head, then blank-recover`,
    );
    return { fork: false, promptInput, resumeOrTurnId };
  }
  if (!promoteQueuedActivationTail(ds, { send: false })) {
    logger.warn(
      `[${tag(ds)}] Quarantined activation-tail promotion still failing at fork boundary; `
      + `keeping worker:null quarantined owner (no fork) to avoid a live worker beside an unpromoted tail`,
    );
    return { fork: false, promptInput, resumeOrTurnId };
  }
  ds.quarantinedActivationTailPromotion = undefined;
  // Promotion succeeded: the old head is now the tokened queued activation. Fork
  // THAT, exactly like the daemon's queuedActivation recovery — Codex App through
  // its dispatch ledger (empty prompt), non-Codex by resubmitting the exact input.
  const recoverThroughCodexLedger =
    (ds.session.cliId ?? getBot(ds.larkAppId).config.cliId) === 'codex-app';
  return {
    fork: true,
    promptInput: recoverThroughCodexLedger ? '' : (ds.session.queuedActivationInput ?? ''),
    resumeOrTurnId: {
      resume: ds.session.queuedActivationResume ?? ds.hasHistory,
      turnId: ds.session.queuedActivationTurnId,
      dispatchAttempt: ds.session.queuedActivationDispatchAttempt,
    },
  };
}

/**
 * Fork (or re-attach) a worker for `ds`.
 *
 * Returns `false` ONLY when a quarantined tail-only owner's promotion could not
 * be recovered at this fork boundary (see resolveQuarantinedForkPlan): the caller
 * MUST treat the session as still worker-less (no live worker was started) and
 * leave the admission gate held. Every other outcome — forked, re-attached,
 * staged behind an ACK, routed through a live owner, or spawn-deferred during
 * device isolation — returns `true`.
 */
export function forkWorker(
  ds: DaemonSession,
  promptInput: string | CliTurnPayload,
  resumeOrTurnId: ForkResumeOrTurnId = false,
): boolean {
  const gatedPrompt = typeof promptInput === 'string' ? { content: promptInput } : promptInput;
  const transferGate = transferInputGates.get(ds);
  if (transferGate && !transferReplacementForkBypass.has(ds)) {
    if (gatedPrompt.content !== '') {
      const gatedTurnId = typeof resumeOrTurnId === 'string'
        ? resumeOrTurnId
        : typeof resumeOrTurnId === 'object' && resumeOrTurnId !== null
        ? resumeOrTurnId.turnId
        : undefined;
      const gatedDispatchAttempt = typeof resumeOrTurnId === 'object' && resumeOrTurnId !== null
        ? resumeOrTurnId.dispatchAttempt
        : undefined;
      sendWorkerInput(ds, promptInput, gatedTurnId, {
        ...(gatedDispatchAttempt !== undefined
          ? { dispatchAttempt: gatedDispatchAttempt }
          : {}),
        // R6-B3 (transfer-gate sibling): sendWorkerInput reads steer
        // authorization from OPTS, not the payload. A steerable opening/refork
        // rerouted through the transfer gate must carry the flag here too, or it
        // silently downgrades true → false like the direct-route branch did.
        ...(gatedPrompt.codexAppSteerable === true ? { codexAppSteerable: true as const } : {}),
      });
    } else {
      transferGate.needsWorker = true;
    }
    logger.info(
      `[${tag(ds)}] Deferred ${gatedPrompt.content === '' ? 'empty ' : ''}worker refork behind routing transfer`,
    );
    if (transferGate.released && transferGate.forkWorkerImpl) {
      queueMicrotask(() => {
        if (transferInputGates.get(ds) === transferGate) {
          releaseTransferInputGate(ds, transferGate, transferGate.forkWorkerImpl!);
        }
      });
    }
    // Buffered/deferred behind the routing transfer: no live worker started
    // now, but the turn is durably staged, so this is not the quarantine
    // refusal that boolean-false signals to callers.
    return true;
  }

  // Device enrollment briefly freezes every daemon before the one-way host
  // marker is installed and legacy local CLIs are torn down. Do this before
  // ANY session mutation or child fork. One deferred spawn per logical session
  // is replayed after the exact freeze lease is released; a session closed by
  // the activation transaction is deliberately not revived.
  if (deferWorkerSpawnDuringDeviceIsolation(ds.session.sessionId, () => {
    if (findActiveBySessionId(ds.session.sessionId) === ds) {
      forkWorker(ds, promptInput, resumeOrTurnId);
    }
  })) {
    logger.info(`[${tag(ds)}] worker spawn deferred during device credential activation`);
    return true;
  }

  // Central quarantine guard — the single source of truth for the tail-only
  // restore quarantine invariant (documented on resolveQuarantinedForkPlan). Runs
  // before ANY prompt derivation or session mutation so a refusal is side-effect
  // free, and so a recovered plan rewrites the prompt/resume args used below.
  const quarantinePlan = resolveQuarantinedForkPlan(ds, promptInput, resumeOrTurnId);
  if (!quarantinePlan.fork) return false;
  promptInput = quarantinePlan.promptInput;
  resumeOrTurnId = quarantinePlan.resumeOrTurnId;

  // Refuse a closed or superseded session before any mutation (master guard).
  if (!canForkRegisteredSession(ds)) return false;

  const promptPayload = typeof promptInput === 'string' ? { content: promptInput } : promptInput;
  const prompt = promptPayload.content;
  // R4-B1: the frozen steer authorization rides on the CliTurnPayload (computed
  // once by the daemon at admission, COPIED here). A bare-string promptInput or a
  // system/recovery opening carries no flag ⇒ forced serial. Never re-inferred.
  const initCodexAppSteerable = typeof promptInput === 'object'
    && promptInput !== null
    && promptInput.codexAppSteerable === true;
  let resume = false;
  let initTurnId: string | undefined;
  let initDispatchAttempt: number | undefined;
  let restartAttemptId: string | undefined;
  let initCodexAppInputGateFrozen = promptInput === ds.session.queuedActivationInput;
  let initAtMostOnce: boolean | undefined;
  if (typeof resumeOrTurnId === 'string') {
    initTurnId = resumeOrTurnId;
  } else if (typeof resumeOrTurnId === 'object' && resumeOrTurnId !== null) {
    resume = resumeOrTurnId.resume === true;
    initTurnId = resumeOrTurnId.turnId;
    initDispatchAttempt = resumeOrTurnId.dispatchAttempt;
    restartAttemptId = resumeOrTurnId.restartAttemptId;
    initCodexAppInputGateFrozen ||= resumeOrTurnId.codexAppInputGateFrozen === true;
    initAtMostOnce = resumeOrTurnId.atMostOnce;
  } else {
    resume = resumeOrTurnId;
  }
  if (ds.session.queuedActivationPending && ds.session.queuedActivationResume !== undefined) {
    resume = ds.session.queuedActivationResume;
  }

  // Central double-fork guard. A live worker with durable ownership must never
  // be killed and replaced: empty reforks are rejected, while a real follow-up
  // is appended through the existing worker's ordinary durable FIFO. Keep this
  // before queued/cwd/sandbox mutations so a rejected refork is side-effect free.
  if (ds.worker && !ds.worker.killed
    && hasProtectedSessionMutationOwnership(ds)) {
    if (prompt.length === 0) {
      logger.warn(`[${tag(ds)}] Refused empty worker refork while durable activation ownership is non-empty`);
      return true;
    }
    if (hasQueuedActivationAdmissionGate(ds)) {
      const turnId = initTurnId
        ?? ds.currentReplyTarget?.turnId
        ?? `queued-activation-followup-${randomUUID()}`;
      admitQueuedActivationTail(ds, {
        userPrompt: prompt,
        cliInput: {
          content: prompt,
          ...(promptPayload.codexAppInput
            ? { codexAppInput: promptPayload.codexAppInput }
            : {}),
          // R5-B1-2: preserve the frozen steer authorization on the double-fork
          // staged tail entry (only `=== true`).
          ...(initCodexAppSteerable ? { codexAppSteerable: true as const } : {}),
        },
        turnId,
        ...(initDispatchAttempt !== undefined
          ? { dispatchAttempt: initDispatchAttempt }
          : {}),
      });
      logger.info(
        `[${tag(ds)}] Staged double-fork prompt behind queued activation ACK `
        + `(turn=${turnId})`,
      );
      return true;
    }
    const routed = sendWorkerInput(ds, promptPayload, initTurnId, {
      ...(initDispatchAttempt !== undefined ? { dispatchAttempt: initDispatchAttempt } : {}),
      // R6-B3: sendWorkerInput reads steer authorization from OPTS (not the
      // payload), so the direct-route double-fork (protected ownership, no
      // activation gate — e.g. only an unsettled ledger) must pass it through
      // opts too. The gate branch above already admits with the flag; this
      // sibling branch would otherwise silently downgrade true → false.
      ...(initCodexAppSteerable ? { codexAppSteerable: true as const } : {}),
    });
    logger[routed ? 'info' : 'warn'](
      `[${tag(ds)}] ${routed ? 'Routed' : 'Failed to route'} double-fork prompt through existing durable owner`,
    );
    return true;
  }

  const cb = requireCallbacks();
  const bot = getBot(ds.larkAppId);
  const botCfg = bot.config;
  // A bare /repo placeholder (and a non-Codex empty group-join setup) owns no
  // model turn. Starting its CLI with an empty prompt must not mint a queued
  // activation token: the worker has nothing to submit and could never ACK it.
  // Real raw openings and clean Codex sidecars remain tokened.
  if (ds.session.queued
    && ds.session.pendingRepoSetup
    && prompt.length === 0
    && !promptPayload.codexAppInput
    && !ds.pendingRawInput
    && (ds.session.queuedActivationTail?.length ?? 0) === 0) {
    const priorJournal = snapshotQueuedActivationJournal(ds.session);
    ds.session.queued = false;
    clearQueuedActivationJournal(ds.session);
    try {
      sessionStore.updateSession(ds.session);
    } catch (err) {
      ds.session.queued = true;
      restoreQueuedActivationJournal(ds.session, priorJournal);
      throw err;
    }
  }
  const queuedForkSnapshot: QueuedWorkerForkSnapshot | undefined = ds.session.queued
    ? {
        queued: true,
        queuedPrompt: ds.session.queuedPrompt,
        queuedCodexAppText: ds.session.queuedCodexAppText,
        queuedCodexAppMessageContext: ds.session.queuedCodexAppMessageContext,
        queuedActivationPending: ds.session.queuedActivationPending,
        queuedActivationToken: ds.session.queuedActivationToken,
        queuedActivationInput: ds.session.queuedActivationInput,
        queuedActivationTurnId: ds.session.queuedActivationTurnId,
        queuedActivationDispatchAttempt: ds.session.queuedActivationDispatchAttempt,
        queuedActivationResume: ds.session.queuedActivationResume,
        initialStartPending: ds.initialStartPending,
      }
    : undefined;
  let acceptedForkDispatch: AcceptedWorkerForkDispatch | undefined;
  let spawnedWorker: ChildProcess | undefined;
  let worker!: ChildProcess;
  let startupState!: WorkerStartupState;
  let initMsg!: DaemonToWorker;
  let agentCfg!: ReturnType<typeof sessionAgentConfig>;
  const t = tag(ds);
  ds.localProcessAttestation = undefined;
  try {
  // worker.js lives in the same directory as daemon.js (src/)
  const workerPath = join(__dirname, '..', 'worker.js');

  // Per-turn authority is never inferred from mutable session state. Human
  // message routes pass their accepted Lark message id explicitly; restore,
  // scheduler, card retry and other system starts stay unattributed. Falling
  // back to currentReplyTarget here would let a later system prompt reuse an
  // older human turn after a worker replacement.
  let initAttributionTurnId = initTurnId
    ?? (queuedForkSnapshot ? ds.session.pendingRepoSetup?.turnId : undefined);
  // Reply routing is frozen only from the same explicitly accepted turn. A
  // system prompt must not borrow an older mutable currentReplyTarget.
  const initReplyTurnId = initTurnId;
  const initReplyContext = prompt.length > 0
    ? frozenReplyContextForTurn(ds, initReplyTurnId)
    : undefined;

  // A fork() whose cwd no longer exists emits an unhandled 'error' (spawn
  // ENOENT) that crashes the WHOLE daemon (→ pm2 crash-loop). Fall back to
  // home so a stale session workingDir can never take the daemon down.
  const rawCwd = cb.getSessionWorkingDir(ds);
  const cwd = rawCwd && existsSync(rawCwd) ? rawCwd : homedir();
  if (cwd !== rawCwd) logger.warn(`[${t}] workingDir "${rawCwd}" does not exist — falling back to ${cwd}`);

  // Materialise the resolved launch dir on the live session. getSessionWorkingDir()
  // falls back to the bot-default workingDir, but the usage ledger and dashboard read
  // `ds.workingDir ?? s.workingDir` RAW (without that fallback). A session that inherits
  // the bot-default workingDir — i.e. one never pinned via /repo or /cd — therefore leaves
  // ds.workingDir undefined, so getSessionTokenUsage() is handed cwd=undefined, cannot
  // locate the CLI transcript, and the session's token usage silently never records.
  // Pinning the resolved cwd here (it equals what the worker actually forked into) closes
  // that gap without touching the persisted session.workingDir "unset = follow default"
  // semantics: this is re-derived on every fork/restore.
  ds.workingDir = cwd;

  // Also persist the effective launch dir onto the SESSION record so a sibling
  // bot @-ed into the same anchor can inherit it (inherit-peer reads the
  // persisted session.workingDir cross-process, even across daemons). Without
  // this, a session running on the bot-default/fallback dir leaves
  // session.workingDir empty and is invisible to cross-bot same-dir inheritance.
  // Only FILL IN a missing workingDir (default/fallback-spawned sessions) — never
  // overwrite an already-pinned value (oncall/repo-card sessions keep their stored
  // form). Persist only a genuinely-resolved dir, never the homedir() crash-fallback
  // (cwd !== rawCwd → a transiently-missing dir can't pin to ~). Also exclude a
  // LEGITIMATELY-resolved homedir: a bot whose workingDir is unset/`~` resolves to
  // $HOME, and pinning that would let a sibling bot inherit $HOME (launch in the home
  // dir with no repo context) instead of getting its own repo card. Compared via
  // realpath so a symlinked/aliased $HOME is excluded too, not just the literal string.
  if (!ds.session.workingDir && cwd === rawCwd && !resolvesToHome(cwd)) {
    ds.session.workingDir = cwd;
    sessionStore.updateSession(ds.session);
  }

  // Sandbox decision is RECORDED ON THE SESSION at creation and reused on
  // restore — so toggling the live bot flag never retroactively (un)sandboxes a
  // historical session. A brand-new session (resume=false) with no recorded
  // decision adopts the live bot flag; a restore (resume=true) with no recorded
  // decision predates the sandbox feature → stays NOT sandboxed.
  if (ds.session.sandbox === undefined) {
    if (!resume) {
      ds.session.sandbox = botCfg.sandbox === true;
      ds.session.sandboxPaths = botCfg.sandboxPaths;
      ds.session.sandboxHidePaths = botCfg.sandboxHidePaths ?? [];
      ds.session.sandboxReadonlyPaths = botCfg.sandboxReadonlyPaths ?? [];
      ds.session.sandboxNetwork = botCfg.sandboxNetwork !== false;
    } else {
      ds.session.sandbox = false;
      ds.session.sandboxHidePaths = [];
      ds.session.sandboxReadonlyPaths = [];
      ds.session.sandboxNetwork = true;
    }
    sessionStore.updateSession(ds.session);
  }

  // Reserve and durably publish the replacement lifetime before killing an
  // existing worker. A failed reservation leaves the old worker untouched;
  // a successful reservation immediately invalidates any late old-worker ACK.
  const workerGeneration = reserveWorkerGeneration(ds);

  // Guard against double-fork: if a worker is already running, kill it first
  if (ds.worker && !ds.worker.killed) {
    const replacedWorker = ds.worker;
    logger.warn(`[${t}] Worker already running (pid: ${replacedWorker.pid}), killing before re-fork`);
    trackLifecycleRetirement(ds, replacedWorker);
    try { replacedWorker.send({ type: 'close' } as DaemonToWorker); } catch { /* ignore */ }
    try { replacedWorker.kill(); } catch { /* ignore */ }
    ds.worker = null;
    ds.workerReady = false;
    ds.workerPort = null;
    ds.workerToken = null;
    ds.workerViewToken = null;
    ds.managedTurnOrigin = undefined;
  }

  // Re-establishing a worker ends the cold-resume-suspended state: clear the
  // persisted marker so a future restart no longer treats this session's
  // backing as a deliberate-missing (a genuine later zombie must still close).
  if (ds.session.suspendedColdResume) {
    ds.session.suspendedColdResume = undefined;
    sessionStore.updateSession(ds.session);
  }

  // Re-establishing a worker also reclaims any crash-diagnostic shell a prior
  // worker left parked but couldn't clean (hard-killed while parked, daemon
  // still alive → next message reforks here). The fresh CLI spawns under the
  // real bmx-<sid>; without this, bmx-diag-<sid> + its .ansi file would leak.
  if (!ds.initConfig?.adoptMode && !ds.adoptedFrom) reclaimParkedCrashDiagnostic(ds);

  agentCfg = sessionAgentConfig(ds, botCfg);
  if (!initTurnId && prompt.length > 0 && agentCfg.cliId === 'codex-app') {
    initAttributionTurnId = `codex-app-dispatch-${randomUUID()}`;
  }
  ensureCliEnv(agentCfg.cliId, agentCfg.cliPathOverride);
  let nativeSessionTitle: string | undefined;
  let nativeSessionTitlePrompt: string | undefined;
  if (agentCfg.cliId === 'codex' && !ds.adoptedFrom) {
    const isFreshNativeSession = !resume && !ds.session.cliSessionId;
    const titlePrompt = extractBotmuxLarkNativeSessionTitlePrompt(
      promptPayload.codexAppInput?.text ?? prompt,
      bot.botName ? [{ name: bot.botName }] : undefined,
    );
    if (isFreshNativeSession && !ds.session.nativeSessionTitleUserDefined) {
      ds.session.nativeSessionTitle = buildBotmuxLarkNativeSessionTitle(
        titlePrompt ? ds.session.title : undefined,
        bot.botName ? [{ name: bot.botName }] : undefined,
        ds.chatType === 'group' ? ds.session.chatDisplayName : undefined,
      );
      ds.session.nativeSessionTitleAwaitingContent = titlePrompt ? undefined : true;
      nativeSessionTitlePrompt = titlePrompt;
      sessionStore.updateSession(ds.session);
    } else if (
      ds.session.nativeSessionTitleAwaitingContent
      && !ds.session.nativeSessionTitleUserDefined
      && titlePrompt
    ) {
      ds.session.nativeSessionTitle = buildBotmuxLarkNativeSessionTitle(titlePrompt);
      ds.session.nativeSessionTitleAwaitingContent = undefined;
      nativeSessionTitlePrompt = titlePrompt;
      sessionStore.updateSession(ds.session);
    } else if (isFreshNativeSession && !ds.session.nativeSessionTitle) {
      ds.session.nativeSessionTitle = ds.session.title;
      sessionStore.updateSession(ds.session);
    }
    if (
      isFreshNativeSession
      || (resume && !!ds.session.cliSessionId && !!ds.session.nativeSessionTitle)
      || (
        resume
        && !!ds.session.nativeSessionTitleAwaitingContent
        && !!ds.session.nativeSessionTitle
      )
      || (!!nativeSessionTitlePrompt && !!ds.session.nativeSessionTitle)
    ) {
      nativeSessionTitle = ds.session.nativeSessionTitle;
    }
  }
  // Claude Code blocks on the interactive folder-trust dialog the first time
  // it runs in an untrusted workingDir; pre-accept it so the spawn doesn't hang.
  // Seed CLI (Claude Code fork) has the same dialog — drive both off the
  // adapter's claude-family fields, writing to each variant's own .claude.json
  // (`~/.claude.json` for claude, `.claude-runtime/.claude.json` for seed).
  const familyAdapter = createCliAdapterSync(agentCfg.cliId, agentCfg.cliPathOverride);
  if (familyAdapter.claudeStateJsonPath) ensureClaudeFolderTrust(cwd, familyAdapter.claudeStateJsonPath);
  const resolvedBackendType = resolvePairedSpawnBackendType(
    agentCfg.cliId,
    ds.session.backendType,
    botCfg.backendType,
    config.daemon.backendType,
  );
  if (ds.session.cliId !== agentCfg.cliId || ds.session.backendType !== resolvedBackendType) {
    ds.session.cliId = agentCfg.cliId;
    ds.session.backendType = resolvedBackendType;
    sessionStore.updateSession(ds.session);
  }

  // Prepend the botmux wrapper bin dir to PATH so CLIs can call `botmux send` etc.
  // Single source of truth (resolveBotmuxWrapperBinDir): core-only → dedicated
  // `<SESSION_DATA_DIR>/bin` (not the shared ~/.botmux/bin), matching where the
  // daemon WROTE the wrapper — else the worker PATH would miss it or a same-HOME
  // fleet wrapper would shadow it (codex P1).
  const botmuxBinDir = resolveBotmuxWrapperBinDir(process.env);
  const pathWithBotmux = prependBotmuxBin(botmuxBinDir, process.env.PATH);

  const forkEnv = workerForkEnv(process.env);
  // Dequeue only after every earlier launch-preparation write has finished.
  // The exact input remains journaled until the worker confirms its adapter
  // submission boundary; daemon send/ready are intentionally too early.
  const recoveredActivationLedgerEntry = ds.session.queuedActivationPending
    ? [...(ds.session.codexAppDispatchLedger ?? [])]
      .reverse()
      .find(entry => entry.state === 'accepted' || entry.state === 'prepared')
    : undefined;
  const queuedActivationToken = queuedForkSnapshot
    ? randomUUID()
    : ds.session.queuedActivationPending
      ? (ds.session.queuedActivationToken
        ?? recoveredActivationLedgerEntry?.queuedActivationToken
        ?? randomUUID())
      : undefined;
  if (queuedForkSnapshot) {
    ds.session.queued = false;
    ds.session.queuedActivationPending = true;
    ds.session.queuedActivationToken = queuedActivationToken;
    ds.session.queuedActivationResume = resume;
    ds.initialStartPending = true;
  } else if (ds.session.queuedActivationPending && queuedActivationToken) {
    // Migrate journals written before the token/ACK protocol. The queued
    // activation is the newest unsettled FIFO entry; stamp the same token onto
    // both journal and entry before the recovery worker can submit it.
    let migrated = ds.session.queuedActivationToken !== queuedActivationToken;
    ds.session.queuedActivationToken = queuedActivationToken;
    ds.initialStartPending = true;
    if (recoveredActivationLedgerEntry
      && recoveredActivationLedgerEntry.queuedActivationToken !== queuedActivationToken) {
      recoveredActivationLedgerEntry.queuedActivationToken = queuedActivationToken;
      migrated = true;
    }
    if (migrated) sessionStore.updateSession(ds.session);
  }

  // Snapshot the prior durable FIFO before accepting this fork's new prompt.
  // A pure reattach receives the full snapshot; a refork carrying N+1 restores
  // old N first and reserves N+1 through the normal worker write path.
  const codexAppRecoveredDispatches = agentCfg.cliId === 'codex-app'
    ? (ds.session.codexAppDispatchLedger ?? []).map(entry => ({ ...entry }))
    : [];
  const promptCodexAppInput = initCodexAppInputGateFrozen
    ? cloneFrozenCodexAppInput(promptPayload.codexAppInput, initAttributionTurnId)
    : codexAppInputForSession(ds, promptPayload.codexAppInput, initAttributionTurnId);
  if (queuedForkSnapshot) {
    ds.session.queuedActivationInput = {
      content: prompt,
      ...(promptCodexAppInput ? { codexAppInput: promptCodexAppInput } : {}),
      // R4-B1: preserve the frozen steer authorization when re-parking N+1 behind
      // a recovery fork (COPY, never re-infer).
      ...(initCodexAppSteerable ? { codexAppSteerable: true } : {}),
    };
    ds.session.queuedActivationTurnId = initAttributionTurnId;
    ds.session.queuedActivationDispatchAttempt = initDispatchAttempt;
  }
  const initVcMeetingImTurnOrigin = resolveVcMeetingImTurnOrigin(
    ds.session,
    initTurnId ?? initReplyTurnId,
  );
  const codexAppDispatchId = prompt.length > 0
    ? acceptCodexAppDispatch(
        ds,
        {
          content: prompt,
          ...(promptCodexAppInput ? { codexAppInput: promptCodexAppInput } : {}),
          ...(queuedActivationToken ? { queuedActivationToken } : {}),
          ...(initReplyTurnId ? { replyTurnId: initReplyTurnId } : {}),
          ...(initReplyContext ? {
            replyTarget: initReplyContext.target,
            ...(initReplyContext.quoteTargetId
              ? { quoteTargetId: initReplyContext.quoteTargetId }
              : {}),
            ...(initReplyContext.replyTargetSenderOpenId
              ? { replyTargetSenderOpenId: initReplyContext.replyTargetSenderOpenId }
              : {}),
            ...(initReplyContext.replyTargetSenderIsBot !== undefined
              ? { replyTargetSenderIsBot: initReplyContext.replyTargetSenderIsBot }
              : {}),
          } : {}),
          // R4-B1: COPY the frozen steer authorization onto the fork's
          // accept-ledger entry so a recovered/opening first turn is steerable
          // exactly as the daemon admitted it (admission computed once; COPIED).
          ...(initCodexAppSteerable ? { codexAppSteerable: true } : {}),
        },
        initAttributionTurnId,
        initDispatchAttempt,
        initVcMeetingImTurnOrigin,
      )
    : undefined;
  if (codexAppDispatchId && initAttributionTurnId) {
    acceptedForkDispatch = {
      dispatchId: codexAppDispatchId,
      turnId: initAttributionTurnId,
      ...(initDispatchAttempt !== undefined
        ? { dispatchAttempt: initDispatchAttempt }
        : {}),
    };
  }
  if (queuedForkSnapshot && !codexAppDispatchId) {
    sessionStore.updateSession(ds.session);
  }

  worker = fork(workerPath, [], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: workerForkExecArgv(),
    cwd,
    env: {
      ...forkEnv,
      PATH: pathWithBotmux,
      CLAUDECODE: undefined,
      BOTMUX: '1',  // Marker so user scripts/skills can detect a botmux-spawned CLI
      SESSION_DATA_DIR: config.session.dataDir,
      BOTMUX_SESSION_ID: ds.session.sessionId,
      LARK_APP_ID: botCfg.larkAppId,
      // Withhold the real secret from the worker's own CLI env for a no-transport
      // session (apiOnly bot or HTTP virtual chat). SEPARATE leak from the
      // init-message larkAppSecret — the spawned CLI env carries it directly from
      // botCfg. Empty it here too so no secret reaches the worker/sandbox.
      LARK_APP_SECRET: larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly }) ? botCfg.larkAppSecret : '',
    },
  } as WindowsForkOptions);
  spawnedWorker = worker;
  startupState = {
    ready: false, failureNotified: false,
    initTurnId: initAttributionTurnId,
    initDispatchAttempt,
  };

  // A fork-level failure (spawn ENOENT, etc.) emits 'error'; without a handler
  // the unhandled event crashes the daemon. It also happens before worker IPC
  // exists, so this daemon-side branch must be the user-visible fallback.
  worker.on('error', (err) => {
    const reason = (err as Error)?.message ?? String(err);
    logger.error(`[${t}] Worker fork error: ${reason}`);
    if (ds.worker === worker) {
      if (ds.session.queuedActivationPending) {
        // The durable opening journal remains authoritative until the adapter
        // proves submission. A failed child must release only its runtime
        // claim so the next generation can replay that exact head.
        ds.initialStartPending = false;
        ds.initialStartClaimToken = undefined;
      } else {
        reparkQueuedActivationFollowUpTail(ds, 'worker error during activation follow-up handoff');
      }
      ds.worker = null;
      ds.workerPort = null;
      ds.workerToken = null;
      ds.workerViewToken = null;
      ds.managedTurnOrigin = undefined;
      try { worker.kill(); } catch { /* best-effort failed-child fence */ }
    }
    if (startupState.failureNotified) return;
    startupState.failureNotified = true;
    emitSessionLifecycleHook(ds, 'session.requires_attention', {
      reason: 'worker_fork_error',
      message: reason,
    });
    // A dedicated VC receiver and a silent schedule have no auxiliary Lark
    // output channel. Keep lifecycle/dashboard state above, but never leak a
    // fork diagnostic into the chat.
    if (ds.session.vcMeetingReceiver || isSilentScheduledTurn(ds, initAttributionTurnId)) {
      logger.info(
        `[${t}] Managed/silent fork failure kept out of auxiliary Lark UI `
        + `turn=${initAttributionTurnId?.slice(0, 12) ?? '-'} attempt=${initDispatchAttempt}: ${reason}`,
      );
      return;
    }
    const cliName = sessionCliDisplayName(ds, botCfg);
    const message = tr('worker.start_failed', { cliName, reason }, botLocale(botCfg));
    void cb.sessionReply(
      sessionAnchorId(ds),
      message,
      'text',
      ds.larkAppId,
      fallbackTurnId(ds, initAttributionTurnId),
      ds.session.vcMeetingReceiver
        ? { sourceSessionId: ds.session.sessionId }
        : undefined,
    ).catch(replyErr => logger.error(`[${t}] Failed to deliver worker fork error to Lark: ${replyErr}`));
  });

  // Pipe worker stdout/stderr to daemon logger.
  // Both go through logger.info → daemon.log (not error.log). Worker stderr
  // is NOT necessarily an error: CLI adapters (claude, codex, etc.) write
  // progress, version banners, deprecation warnings, etc. there. The line
  // is still visible (tagged `:err`) for triage. Real worker faults arrive
  // separately via the IPC `Worker error` branch and stay as logger.error.
  worker.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.info(`[${t}:out] ${trimmed}`);
    }
  });
  worker.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      logWorkerStderr(t, line.trim());
    }
  });

  // Send init config — use per-bot settings
  const runtimeIdentity = runtimeBuildIdentity();
  initMsg = {
    type: 'init',
    sessionId: ds.session.sessionId,
    chatId: ds.chatId,
    chatType: ds.chatType,
    rootMessageId: sessionAnchorId(ds),
    workingDir: cwd,
    cliId: agentCfg.cliId,
    cliRuntime: agentCfg.cliRuntime,
    cliPathOverride: agentCfg.cliPathOverride,
    wrapperCli: agentCfg.wrapperCli,
    launchShell: botCfg.launchShell,
    model: agentCfg.model,
    reasoningEffort: agentCfg.reasoningEffort,
    disableCliBypass: botCfg.disableCliBypass === true,
    codexRpcInput: botCfg.codexRpcInput === true || config.codexRpcInputDefault,
    // Startup commands run on every fresh spawn (incl. resume) so session-only
    // settings like `/effort ultracode` are re-established. Adopt sessions are
    // observed, not driven — forkAdoptWorker intentionally omits this.
    startupCommands: botCfg.startupCommands,
    // Per-bot env (bots.json `env`) — injected into the CLI process only (e.g.
    // ANTHROPIC_BASE_URL/AUTH_TOKEN for a GLM/3rd-party bot). Adopt sessions are
    // observed, not driven, so forkAdoptWorker intentionally omits it.
    env: botCfg.env,
    // Use the decision recorded on the session (above), NOT the live bot flag, so
    // historical sessions never get retroactively sandboxed on restart.
    sandbox: ds.session.sandbox === true,
    sandboxPaths: ds.session.sandboxPaths ?? botCfg.sandboxPaths,
    sandboxHidePaths: ds.session.sandboxHidePaths ?? [],
    sandboxReadonlyPaths: ds.session.sandboxReadonlyPaths ?? [],
    sandboxNetwork: ds.session.sandboxNetwork !== false,
    // Per-bot local read isolation (enforced worker-side; the worker gates it).
    // Sibling data needs no app-id enumeration: per-bot dirs are denied wholesale
    // and per-bot session files by filename pattern (see buildV2DenyPaths).
    // HARD credential boundary for a no-transport session (apiOnly bot OR HTTP
    // virtual chat): force read isolation so the CLI physically cannot read the
    // full bots.json / sibling BOT_HOME / send-cred / lark-cli store — a model
    // that deletes/forges the ancestry marker or bypasses the CLI still cannot
    // build ANY (sibling) Lark client. The pid-marker gate is only friendly
    // early-reject; THIS is the fail-closed boundary. Reuses the existing unified
    // fs-policy (mac+Linux fail-closed); a backend that can't isolate locally
    // refuses to spawn rather than leak creds.
    readIsolation: botCfg.readIsolation === true
      || !larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly }),
    readDenyExtraPaths: botCfg.readDenyExtraPaths ?? [],
    // Identifies THIS daemon lifetime. Stamped onto isolated panes so the worker
    // can tell a suspend→resume reattach (same boot id, still isolated) from a
    // stale pane surviving a daemon restart (different id → kill + cold-spawn).
    daemonBootId: DAEMON_BOOT_ID,
    // Freeze-once: an already-running session keeps the backend stamped at spawn
    // (ds.session.backendType) even if the bot's live `backendType` changed since —
    // otherwise a cold-resume/refork would re-derive from live config and strand
    // the real persistent pane (the stamp is written below; restore reads it via
    // getSessionPersistentBackendType). A brand-new session (no stamp) resolves
    // from live config, so a dashboard backend switch only affects NEW sessions.
    backendType: resolvePairedSpawnBackendType(agentCfg.cliId, ds.session.backendType, botCfg.backendType, config.daemon.backendType),
    // Shared Herdr is not derivable from sessionId: preserve the exact host +
    // managed-agent affinity across daemon/worker replacement.
    persistentBackendTarget: ds.session.persistentBackendTarget,
    backendConfig: botCfg.riff,
    riffParentTaskId: ds.session.riffParentTaskId,
    riffRepoDirs: ds.session.riffRepoDirs,
    deferredScheduleRun: ds.session.deferredScheduleRun,
    ...(nativeSessionTitle ? { nativeSessionTitle } : {}),
    ...(nativeSessionTitlePrompt ? { nativeSessionTitlePrompt } : {}),
    prompt,
    ...(promptCodexAppInput ? { promptCodexAppInput } : {}),
    ...(queuedActivationToken ? { queuedActivationToken } : {}),
    resume,
    // One-shot native fork intent (see Session.pendingForkSession). Only the
    // child's FIRST spawn resumes the SOURCE transcript (cliSessionId still
    // points at the parent's CLI id here) while forking forward into a new id;
    // the worker clears the marker + persists the child's own new id, so a
    // later refork resumes the child normally (pendingForkSession=false).
    forkSession: ds.session.pendingForkSession === true,
    cliSessionId: ds.session.cliSessionId,
    ownerOpenId: ds.ownerOpenId,
    webPort: ds.session.webPort,
    larkAppId: botCfg.larkAppId,
    // Freeze on the session transport capability: a no-transport session
    // (apiOnly bot OR HTTP virtual chat) must not even RECEIVE the real secret —
    // withholding it removes the capability rather than gating a tamperable flag
    // the sandboxed agent could flip. The worker then physically cannot dial
    // Feishu (uploader/cred-write are also skipped downstream on the same test).
    larkAppSecret: larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly }) ? botCfg.larkAppSecret : '',
    apiOnly: botCfg.apiOnly,
    // Freeze the ACTUAL loaded bots-config path (getLoadedConfigPath) so a
    // no-transport worker's fs-policy denies it from a HOST-owned fact, not a
    // guess off BOTS_CONFIG env (which the agent could see/forge). When it lives
    // outside every botmux authority root, buildFsPolicy fails the spawn closed
    // rather than silently masking an arbitrary parent dir (codex P1). Omitted
    // from forkAdoptWorker below — its observe branch returns before fs-policy.
    loadedBotsConfigPath: getLoadedConfigPath(),
    brand: normalizeBrand(botCfg.brand),
    botName: bot.botName,
    botOpenId: bot.botOpenId,
    locale: botLocale(botCfg),
    turnId: initAttributionTurnId,
    ...(initReplyTurnId ? { replyTurnId: initReplyTurnId } : {}),
    dispatchAttempt: initDispatchAttempt,
    ...(codexAppDispatchId ? { codexAppDispatchId } : {}),
    // R4-B1: COPY the frozen steer authorization onto the first-turn init so the
    // worker can fold follow-ups into this opening turn (canSteer requires the
    // group root to be steerable). System/recovery openings carry no flag.
    ...(initCodexAppSteerable ? { codexAppSteerable: true as const } : {}),
    ...(codexAppRecoveredDispatches.length > 0
      ? { codexAppRecoveredDispatches }
      : {}),
    ...((ds.session.codexAppGenerationCommits?.length ?? 0) > 0
      ? { codexAppGenerationCommits: ds.session.codexAppGenerationCommits }
      : {}),
    // At-most-once (idempotency lease): ride the flag on the init message so the
    // worker tags the keyed init prompt no-replay (codex #776 round-7 #1).
    ...(initAtMostOnce ? { atMostOnce: true } : {}),
    vcMeetingImTurnOrigin: initVcMeetingImTurnOrigin,
    pluginBindings: botCfg.plugins,
    skillPolicy: botCfg.skills,
    ...(runtimeIdentity.status === 'known'
      ? { runnerBuildId: runtimeIdentity.id }
      : {}),
    ...(ds.session.runnerBuildId ? { persistedRunnerBuildId: ds.session.runnerBuildId } : {}),
    ...(restartAttemptId ? { restartAttemptId } : {}),
  };
  // A persisted port from an older ZMX implementation must never revive the
  // removed Web TUI or get forwarded as a preferred listen port. The worker
  // will signal lifecycle readiness with port=0 instead.
  if (!backendSupportsWebTerminal(initMsg.backendType)) {
    initMsg.webPort = undefined;
    if (ds.session.webPort !== undefined) {
      ds.session.webPort = undefined;
      sessionStore.updateSession(ds.session);
    }
  }
  ds.initConfig = initMsg;

  // Stamp cliId on the persisted session so the dashboard can show a CLI badge
  // even after the session is closed. Do this before installing worker handlers:
  // a fast worker can emit `ready` immediately after init, and card rendering
  // must see the session-level CLI identity rather than the bot default.
  if (ds.session.cliId !== agentCfg.cliId) {
    ds.session.cliId = agentCfg.cliId;
    sessionStore.updateSession(ds.session);
  }

  // Stamp the resolved backend on the persisted session. Since PTY退役, the
  // worker no longer silently downgrades an unavailable backend (it hard-gates
  // instead), so the requested backend here IS the effective one for any
  // session that actually runs. Restore reads this back (see
  // getSessionPersistentBackendType) so an upgraded daemon doesn't re-derive a
  // session's backend from the now-always-tmux default and misclassify a legacy
  // PTY session as a tmux zombie.
  if (ds.session.backendType !== initMsg.backendType) {
    ds.session.backendType = initMsg.backendType;
    sessionStore.updateSession(ds.session);
  }

  // Use shared handler for IPC messages and exit
  setupWorkerHandlers(ds, worker, startupState, workerGeneration);

  ds.worker = worker;
  if (shouldTrackOrdinaryImDelivery(ds, initMsg)) {
    sendOrdinaryImDeliveryTracked(ds, initMsg);
  } else {
    worker.send(initMsg);
  }
  ds.spawnedAt = Date.now();
  // master: per-runtime-key CLI version (the init send already happened above via
  // the tracked-delivery if/else — do NOT re-send initMsg here).
  ds.cliVersion = getCurrentCliVersion(runtimeInstallationKey({
    cliId: agentCfg.cliId,
    cliRuntime: agentCfg.cliRuntime,
    cliPathOverride: agentCfg.cliPathOverride,
  }));
  // #597: init has been dispatched. A later child 'error' event is ambiguous
  // (init may already be executing), so only synchronous failures before this
  // point are safe to compensate; clear the pre-init compensation handle.
  spawnedWorker = undefined;
  } catch (err) {
    if (ds.worker === spawnedWorker) {
      ds.worker = null;
      ds.workerPort = null;
      ds.workerToken = null;
      ds.workerViewToken = null;
    }
    if (spawnedWorker) {
      try { spawnedWorker.kill(); } catch { /* best-effort pre-init child fence */ }
    }
    try {
      rollbackWorkerForkPreInit(ds, queuedForkSnapshot, acceptedForkDispatch);
    } catch (rollbackErr) {
      logger.error(
        `[${tag(ds)}] Worker pre-init failure could not durably restore queued/FIFO state: `
        + `${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
      );
      throw new AggregateError(
        [err, rollbackErr],
        `Worker pre-init failed and durable rollback failed for ${ds.session.sessionId}`,
      );
    }
    throw err;
  }
  ds.initConfig = initMsg;
  try {
    sessionStore.updateSessionPid(ds.session.sessionId, worker.pid ?? null);
  } catch (err) {
    // Init may already be executing. PID bookkeeping failure must not turn an
    // accepted activation into a retryable error or orphan the attached child.
    logger.error(`[${t}] Failed to persist attached worker pid: ${err instanceof Error ? err.message : String(err)}`);
  }
  logger.info(`[${t}] Worker forked (pid: ${worker.pid}, active: ${cb.getActiveCount()})`);

  // Reset the exit-emit flag for the freshly spawned worker so a subsequent
  // exit publishes again (the previous lifecycle's flag would otherwise mask it).
  ds.exitEventEmitted = false;
  // Notify dashboard SSE subscribers a new session is live.
  try {
    dashboardEventBus.publish({
      type: 'session.spawned',
      body: { session: composeRowFromActive(ds) },
    });
  } catch (err) {
    logger.error(`[${t}] Failed to publish attached worker state: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    cb.enforceLiveSessionCap?.();
  } catch (err) {
    logger.error(`[${t}] Failed to enforce live-session cap after attach: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    emitSessionLifecycleHook(ds, 'session.start', {
      reason: resume ? 'resume' : 'worker_spawn',
      pid: worker.pid ?? null,
    });
  } catch (err) {
    logger.error(`[${t}] Failed to emit attached worker lifecycle hook: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Usage ledger: fresh spawns anchor the baseline so pre-existing transcript
  // history is never billed. Restores reconcile instead — an in-flight turn
  // may have completed inside tmux while the daemon was down, and that work
  // was submitted by botmux (anchoring would swallow it).
  try {
    if (resume) reconcileUsageForDaemonSession(ds);
    else anchorUsageForDaemonSession(ds);
  } catch (err) {
    logger.error(`[${t}] Failed to initialize attached worker usage state: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    recordOwnershipForDaemonSession(ds);
  } catch (err) {
    logger.error(`[${t}] Failed to record attached worker ownership: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

// ─── Shared worker IPC handler ──────────────────────────────────────────────

/**
 * Clear the stuck-warning authority markers WITHOUT patching the card. Used by
 * ACK paths (tui_keys_delivered / stuck_warning_expired) where the caller has
 * already resolved the card to its final state — we only need to drop the
 * nonce/cardId/turnId so a late duplicate click cannot re-inject keys.
 */
export function clearStuckWarningAuthority(ds: DaemonSession): void {
  ds.stuckWarningCardId = undefined;
  ds.stuckWarningTurnId = undefined;
  ds.stuckWarningNonce = undefined;
  ds.stuckWarningPageType = undefined;
  ds.stuckWarningProcessing = false;
  ds.stuckWarningCliLifetime = undefined;
}

/**
 * Resolve any active stuck-warning card (PATCH it to "done") AND clear its
 * markers. Called from every path where the CLI can recover or be replaced:
 * prompt_ready, claude_exit, worker exit/kill/suspend/refork, and the worker's
 * own stale-card notification. Centralising here avoids missing an exit path
 * and leaving a clickable card that can inject keys into a different CLI.
 *
 * ACK paths (tui_keys_delivered / stuck_warning_expired) do NOT use this —
 * they patch the card themselves with a context-specific message and then call
 * clearStuckWarningAuthority() to drop the markers.
 */
export function invalidateStuckWarning(ds: DaemonSession, reason: string): void {
  if (!ds.stuckWarningCardId && !ds.stuckWarningTurnId && ds.stuckWarningNonce === undefined) return;
  const t = tag(ds);
  if (ds.stuckWarningCardId) {
    const locDs = localeForBot(ds.larkAppId);
    const resolvedCard = buildTuiPromptResolvedCard(tr('card.action.tui_done', undefined, locDs), locDs);
    updateMessage(ds.larkAppId, ds.stuckWarningCardId, resolvedCard).catch(err =>
      logger.debug(`[${t}] Failed to resolve stuck-warning card (${reason}): ${err}`),
    );
  }
  logger.debug(`[${t}] invalidateStuckWarning (${reason}): turn=${ds.stuckWarningTurnId ?? 'none'} nonce=${ds.stuckWarningNonce ?? 'none'}`);
  clearStuckWarningAuthority(ds);
}

function hasTuiPromptAuthority(ds: DaemonSession): boolean {
  return ds.tuiPromptCardId !== undefined
    || ds.tuiPromptOptions !== undefined
    || ds.tuiPromptMultiSelect !== undefined
    || ds.tuiToggledIndices !== undefined
    || !!ds.tuiPromptProcessing;
}

/**
 * Drop every daemon-side marker owned by one interactive TUI prompt. The
 * processing flag and option metadata are part of the same authority as the
 * card ID: retaining any subset lets a dead generation block or mutate the
 * next prompt.
 */
function clearTuiPromptAuthority(ds: DaemonSession): void {
  ds.tuiPromptCardId = undefined;
  ds.tuiPromptOptions = undefined;
  ds.tuiPromptMultiSelect = undefined;
  ds.tuiToggledIndices = undefined;
  ds.tuiPromptProcessing = false;
}

/**
 * Retire an outstanding TUI prompt when its worker/CLI lifetime ends. A worker
 * can die after receiving a card click but before acknowledging backend
 * delivery; resolving the card and clearing all authority here prevents that
 * narrow window from permanently occupying the session's prompt slot.
 */
function invalidateTuiPrompt(
  ds: DaemonSession,
  reason: string,
  outcome: 'failed' | 'resolved' = 'failed',
): void {
  if (!hasTuiPromptAuthority(ds)) return;
  const t = tag(ds);
  if (ds.tuiPromptCardId) {
    const locDs = localeForBot(ds.larkAppId);
    const terminalCard = outcome === 'resolved'
      ? buildTuiPromptResolvedCard(tr('card.action.tui_done', undefined, locDs), locDs)
      : buildTuiPromptFailedCard(tr('worker.tui_submit_failed', {
        cliName: storedSessionCliDisplayName(ds),
      }, locDs), locDs);
    updateMessage(ds.larkAppId, ds.tuiPromptCardId, terminalCard).catch(err =>
      logger.debug(`[${t}] Failed to update terminal TUI prompt card (${reason}): ${err}`),
    );
  }
  logger.debug(`[${t}] invalidateTuiPrompt (${reason}): card=${ds.tuiPromptCardId ?? 'none'}`);
  clearTuiPromptAuthority(ds);
  publishAttentionPatch(ds);
}

function setupWorkerHandlers(
  ds: DaemonSession,
  worker: ChildProcess,
  startupState: WorkerStartupState = { ready: false, failureNotified: false },
  reservedWorkerGeneration?: number,
): void {
  const cb = requireCallbacks();
  const t = tag(ds);
  const workerGeneration = reservedWorkerGeneration
    ?? reserveWorkerGeneration(ds);
  if (
    ds.workerGeneration !== workerGeneration
    || ds.session.workerGeneration !== workerGeneration
  ) {
    throw new Error('worker generation reservation changed before IPC setup');
  }
  // Tier authority belongs to this exact worker generation. Start unknown and
  // wait for the new worker's rollout-bound observation; this also clears a
  // Codex badge before a role switch starts a non-Codex worker.
  ds.codexServiceTier = undefined;
  ds.pendingCodexTierCardRefresh = undefined;
  const handlerSession = ds.session;
  const handlerAnchor = sessionAnchorId(ds);
  const handlerLarkAppId = ds.larkAppId;
  const ownsWorkerSession = (): boolean =>
    ds.worker === worker
    && ds.workerGeneration === workerGeneration
    && ds.session.workerGeneration === workerGeneration
    && ds.session === handlerSession
    && ds.session.status === 'active'
    && ds.larkAppId === handlerLarkAppId
    && sessionAnchorId(ds) === handlerAnchor
    && (
      !activeSessionsRegistry
      || activeSessionsRegistry.get(sessionKey(handlerAnchor, handlerLarkAppId)) === ds
    );
  const ownsLifecycleMutation = (): boolean =>
    ownsWorkerSession() && !isSessionTransferring(ds);
  // A new worker generation is starting. As a backstop, invalidate any
  // stuck-warning card posted by the previous generation — explicit kill/suspend/
  // exit paths should already have done this, but fork/refork/takeover paths
  // can leave a stale card that would otherwise inject keys into the new CLI.
  invalidateStuckWarning(ds, 'new_worker_generation');
  invalidateTuiPrompt(ds, 'new_worker_generation');
  // Managed turn authority is issued by one concrete worker lifetime. A
  // replacement must advertise a fresh capability before daemon-mediated
  // exits may use it; carrying the old value across a restore/refork would
  // let stale per-turn authority escape its generation.
  ds.managedTurnOrigin = undefined;
  // Source authorization belongs to one worker lifetime. A replacement worker
  // must announce its own Hermes sources before any stamped final_output is
  // trusted; `/clear` rebinds within the same lifetime accumulate afterwards.
  if (ds.session.cliId === 'hermes' && ds.worker !== worker) {
    ds.hermesBridgeSourceSessionIds = undefined;
  }
  // Worker messages without a turn of their own (first streaming card, crash
  // notices) anchor to the session's current reply-target turn so a shared
  // fold-back topic keeps them in-thread instead of leaking top-level.
  const scopedReply = (
    content: string,
    msgType?: string,
    turnId?: string,
    opts?: Omit<WorkerSessionReplyOptions, 'sourceSessionId'>,
  ) => cb.sessionReply(
    sessionAnchorId(ds),
    content,
    msgType,
    ds.larkAppId,
    fallbackTurnId(ds, turnId),
    ds.session.vcMeetingReceiver
      ? { ...opts, sourceSessionId: ds.session.sessionId }
      : opts,
  );
  const ordinaryManagedSuppression = (
    turnId?: string,
    dispatchAttempt?: number,
  ): boolean => {
    const armedThrough = turnId ? ds.suppressedFinalOutputTurns?.get(turnId) : undefined;
    return dispatchAttempt !== undefined
      && armedThrough !== undefined
      && dispatchAttempt <= armedThrough;
  };
  /** Auxiliary worker UI is never an authorized output channel for a dedicated
   * VC receiver. Dashboard/audit state is still updated before these guards. */
  const managedAuxUiSuppressed = (turnId?: string, dispatchAttempt?: number): boolean => {
    // No-transport session (apiOnly bot or HTTP virtual chat): there is no real
    // Feishu chat to render a card/reaction into. Suppress ALL auxiliary UI at
    // the single source every aux-UI handler funnels through — this is the
    // authoritative fix, NOT a fake "success" message id from sessionReply (a
    // synthetic id would get stored as streamCardId and later scheduleCardPatch
    // → updateMessage would still dial Feishu). Dashboard/web-terminal state is
    // still updated before these guards, so the terminal view is unaffected.
    if (!larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })) return true;
    if (isSilentScheduledTurn(ds, turnId)) return true;
    if (ds.session.vcMeetingReceiver) return true;
    return ordinaryManagedSuppression(turnId, dispatchAttempt);
  };
  /** final_output is the sole exception: listener_thread and exact IM replies
   * may proceed into the durable action ledger; silent/stale attempts do not. */
  const managedFinalOutputSuppressed = (
    turnId?: string,
    dispatchAttempt?: number,
  ): boolean => {
    if (isSilentScheduledTurn(ds, turnId)) return true;
    if (isTriggerFinalSuppressed(ds, turnId)) return true;
    if (!ds.session.vcMeetingReceiver) {
      return ordinaryManagedSuppression(turnId, dispatchAttempt);
    }
    // Resolve every Lark-facing worker event against durable origin state. The
    // receipt freezes responseMode, so terminal→idle updates and daemon restore
    // cannot become loud merely because an in-memory suppression map was
    // cleared/lost. Missing attribution on a dedicated receiver fails closed.
    const decision = evaluateVcMeetingManagedSend(config.session.dataDir, {
      receiverSessionId: ds.session.sessionId,
      receiverSession: true,
      turnId,
      dispatchAttempt,
      currentImTurnOrigin: resolveVcMeetingImTurnOrigin(ds.session, turnId),
      allowTerminalReceipt: true,
    });
    return !decision.ok;
  };
  const bot = getBot(ds.larkAppId);
  const botCfg = bot.config;
  const loc = botLocale(botCfg);
  const notifyStartupFailure = async (
    reason: string,
    turnId?: string,
    dispatchAttempt?: number,
  ): Promise<void> => {
    if (startupState.failureNotified) return;
    startupState.failureNotified = true;
    emitSessionLifecycleHook(ds, 'session.requires_attention', {
      reason: 'worker_start_failed',
      message: reason,
    });
    // A durable VC meeting delivery attempt must not surface its startup/relaunch
    // failure out-of-band. The worker-generation exit is fenced to the receipt
    // (marked ambiguous and retried under the side-effect boundary); a direct
    // sessionReply here would bypass that and could post on a silent delivery.
    // Ordinary IM turns and non-receiver sessions still notify exactly once.
    if (managedAuxUiSuppressed(turnId, dispatchAttempt)) {
      logger.info(
        `[${t}] Managed/silent startup failure kept out of auxiliary Lark UI `
        + `turn=${turnId?.slice(0, 12) ?? '-'} attempt=${dispatchAttempt}: ${reason}`,
      );
      return;
    }
    const cliName = sessionCliDisplayName(ds, botCfg);
    const message = tr('worker.start_failed', { cliName, reason }, loc);
    try {
      await scopedReply(message, 'text', turnId);
    } catch (err: any) {
      logger.error(`[${t}] Failed to deliver worker startup failure to Lark: ${err?.message ?? err}`);
    }
  };

  // Adopt mode flags — computed once, used in all buildStreamingCard calls.
  // Bridge mode (the v3 default for /adopt) hides the legacy takeover button.
  const isAdopt = !!ds.adoptedFrom;
  const showTakeover = false;

  worker.on('message', async (msg: WorkerToDaemon) => {
    // Every IPC message is scoped to the child generation that emitted it.
    // A replaced worker can drain queued messages after the new child has been
    // installed; never let those stale events mutate the replacement's cards,
    // tokens, readiness, transcript metadata, or durable turn state.
    if (ds.worker !== worker) {
      logger.debug(`[${t}] Ignored stale worker message: ${msg.type}`);
      return;
    }
    const effectiveCliId = sessionCliId(ds, botCfg);
    switch (msg.type) {
      case 'persistent_backend_target': {
        ds.session.persistentBackendTarget = msg.target;
        sessionStore.updateSession(ds.session);
        break;
      }
      case 'turn_input_received': {
        if (
          ds.worker !== worker
          || ds.workerGeneration !== workerGeneration
          || ds.session.workerGeneration !== workerGeneration
        ) {
          logger.warn(`[${t}] Ignored turn_input_received from stale worker generation`);
          break;
        }
        acknowledgeOrdinaryImDeliveryReceipt(ds, msg.turnId, workerGeneration);
        break;
      }
      case 'turn_input_rejected': {
        if (
          ds.worker !== worker
          || ds.workerGeneration !== workerGeneration
          || ds.session.workerGeneration !== workerGeneration
        ) {
          logger.warn(`[${t}] Ignored turn_input_rejected from stale worker generation`);
          break;
        }
        rejectOrdinaryImDelivery(ds, msg.turnId, workerGeneration, msg.reason);
        break;
      }
      case 'turn_input_committed': {
        // Bind the receipt to the exact live worker generation. A late ACK
        // from a replaced worker cannot make the replacement appear to have
        // accepted this dispatch turn.
        if (
          ds.worker !== worker
          || ds.workerGeneration !== workerGeneration
          || ds.session.workerGeneration !== workerGeneration
        ) {
          logger.warn(`[${t}] Ignored turn_input_committed from stale worker generation`);
          break;
        }
        // Compatibility/fallback: a commit also proves receipt if the earlier
        // receipt ACK was delayed or dropped on the reverse IPC channel.
        completeOrdinaryImDelivery(ds, msg.turnId, workerGeneration);
        if (recordDispatchInputCommit(ds.session, msg.turnId, workerGeneration)) {
          sessionStore.updateSession(ds.session);
          if (msg.turnId.startsWith('mlrp_turn_')) {
            markMessageListenerRunPreviewRunning(msg.turnId);
          }
        } else {
          logger.warn(`[${t}] Ignored unbound input commit turn=${msg.turnId.slice(0, 16)}`);
        }
        break;
      }
      case 'session_ready_ack': {
        if (ds.worker !== worker) {
          logger.warn(`[${t}] Ignored session_ready_ack from stale worker generation`);
          break;
        }
        acknowledgeSessionReady(msg.requestId);
        break;
      }
      case 'local_process_attestation': {
        // This message arrives over the private parent<->worker IPC channel;
        // unlike .botmux-cli-pids it cannot be forged or deleted by the CLI.
        // Bind it to the daemon's current worker generation so a late message
        // from a replaced worker never attests the replacement process.
        ds.localProcessAttestation = {
          backendType: msg.backendType,
          credentialIsolated: msg.credentialIsolated,
          ...(msg.cliPid !== undefined ? { cliPid: msg.cliPid } : {}),
          ...(msg.cliProcStart !== undefined ? { cliProcStart: msg.cliProcStart } : {}),
          ...(ds.workerGeneration !== undefined
            ? { workerGeneration: ds.workerGeneration }
            : {}),
        };
        break;
      }
      case 'queued_activation_submitted': {
        if (ds.worker !== worker || msg.sessionId !== ds.session.sessionId) break;
        if (!ds.session.queuedActivationPending
          || !ds.session.queuedActivationToken
          || ds.session.queuedActivationToken !== msg.activationToken) {
          logger.warn(`[${t}] Ignored stale queued activation ACK ${msg.activationToken.substring(0, 8)}`);
          break;
        }
        const releaseReservation = async (attempt: number): Promise<void> => {
          if (ds.worker !== worker || !ds.initialStartPending) return;
          try {
            if (cb.onQueuedActivationSubmitted) {
              const released = await cb.onQueuedActivationSubmitted(ds, msg.activationToken);
              if (released === false && ds.worker === worker && ds.initialStartPending) {
                const delayMs = Math.min(100 * (2 ** Math.min(attempt, 6)), 5_000);
                logger.warn(
                  `[${t}] Queued activation follow-up was not accepted (attempt ${attempt + 1}); `
                  + `retrying in ${delayMs}ms`,
                );
                const timer = setTimeout(() => { void releaseReservation(attempt + 1); }, delayMs);
                timer.unref?.();
              }
            } else {
              ds.initialStartPending = false;
              ds.initialStartClaimToken = undefined;
            }
          } catch (err) {
            logger.error(
              `[${t}] Queued activation follow-up release failed unexpectedly; `
              + `delivery was not retried because acceptance is unknown: `
              + `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        };

        const journal = snapshotQueuedActivationJournal(ds.session);
        const persistActivationAck = async (attempt: number): Promise<void> => {
          if (ds.worker !== worker
            || !ds.session.queuedActivationPending
            || ds.session.queuedActivationToken !== msg.activationToken) return;
          clearQueuedActivationJournal(ds.session);
          try {
            sessionStore.updateSession(ds.session);
          } catch (err) {
            restoreQueuedActivationJournal(ds.session, journal);
            const delayMs = Math.min(100 * (2 ** Math.min(attempt, 6)), 5_000);
            logger.error(
              `[${t}] Failed to persist queued activation ACK; retained journal and `
              + `will retry in ${delayMs}ms: ${err instanceof Error ? err.message : String(err)}`,
            );
            const timer = setTimeout(() => { void persistActivationAck(attempt + 1); }, delayMs);
            timer.unref?.();
            return;
          }
          // Crossing the adapter boundary means this session now owns CLI
          // history even if the worker dies before it can publish a session id.
          ds.hasHistory = true;
          await releaseReservation(0);
        };
        await persistActivationAck(0);
        break;
      }

      case 'ready': {
        if (!ownsLifecycleMutation()) {
          logger.warn(`[${t}] Ignored ready from stale/transferring worker generation`);
          break;
        }
        startupState.ready = true;
        ds.workerReady = true;
        // Treat `ready` as a full state boundary for the usage refresh: clear
        // any timer inherited from a PRIOR worker generation up front, so the
        // managed/replyAlreadySent/disabled/recovery/sentinel early-breaks below
        // never keep a dead generation's interval alive. The authorized arm is
        // re-established after a successful card reuse / fresh POST (below). This
        // is the third arm point — without it, an auto-restart mid-`working`
        // (claude_exit rc<=3 → workerReady=false → tick self-clears) would reuse
        // the old card on ready then never re-arm, because the first post-restart
        // screen_update is working→working (statusChanged=false → early break).
        clearUsageRefreshTimer(ds);
        const webPort = Number.isInteger(msg.port) && msg.port > 0 ? msg.port : null;
        ds.workerPort = webPort;
        ds.workerToken = webPort ? msg.token : null;
        ds.workerViewToken = webPort ? (msg.viewToken ?? null) : null;
        // Persist a real port only. port=0 is the explicit ready-without-Web-
        // Terminal sentinel used by backends whose output is not raw ANSI.
        ds.session.webPort = webPort ?? undefined;
        // Dashboard「复现命令」：worker 上报本次冷启的近似复现命令。只存内存字段、
        // 绝不落盘（含凭证）；warm reattach 时 worker 不重算，故为空——这是有意的
        // （reattach 不代表本次新算命令真的执行了）。worker 每次 ready 会重报。
        ds.spawnCommand = msg.spawnCommand;
        sessionStore.updateSession(ds.session);
        const readOnlyUrl = readableTerminalUrlFor(ds);
        if (readOnlyUrl) {
          logger.info(`[${t}] Worker ready, terminal at ${readOnlyUrl.replace(/\?.*$/, '?viewToken=[redacted]')}`);
        } else {
          logger.info(`[${t}] Worker ready (Web Terminal unavailable for this backend)`);
        }
        if (ds.usageLimit) {
          ds.lastScreenStatus = 'limited';
          armUsageLimitRetryTimer(ds);
        }
        // Dashboard: surface the xterm port, or explicitly clear it for a
        // ready backend with no Web Terminal capability.
        dashboardEventBus.publish({
          type: 'session.update',
          body: {
            sessionId: ds.session.sessionId,
            patch: { webPort },
          },
        });

        // Substitute-mode control card: DM owner(s) writable-terminal controls
        // when supported, or manage-only controls for no-Web backends.
        // Consumed before any early break below so avatar-style (card-off) sessions
        // still deliver the owner control card.
        if (ds.pendingSubstituteControlCard) {
          ds.pendingSubstituteControlCard = false;
          void deliverSubstituteControlCard(ds);
        }

        if (managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) {
          logger.info(`[${t}] Managed/silent turn — suppressing ready/streaming card output`);
          break;
        }

        // Pi can finish a very fast startup turn through `botmux send` before
        // Herdr reports idle and the worker emits ready. Posting the initial
        // card now would put a stale "Starting" card *after* the final reply,
        // with no later transcript output to withdraw it (the explicit send
        // intentionally suppresses bridge fallback). Keep the terminal/runtime
        // state above, but suppress this already-completed turn's card.
        if (msg.replyAlreadySent) {
          ds.streamCardPending = false;
          persistStreamCardState(ds);
          logger.info(`[${t}] Explicit reply landed before worker ready — skipping stale starting card`);
          break;
        }

        // Bot opted out of the streaming card: the terminal is up and the
        // final answer will still arrive via `botmux send`; just don't post the
        // live status card. (workerPort/token above are still set so the web
        // terminal + dashboard keep working.) Ready carries the spawning
        // turn's id — gate on THAT turn, not on whichever turn was accepted
        // last (a queued normal turn must not resurrect a substitute turn's
        // initial card, nor the reverse).
        if (streamingCardDisabled(ds, msg.turnId)) {
          logger.info(`[${t}] Streaming card disabled for this bot — skipping card post`);
          break;
        }

        // Restart recovery: stay silent in the group. The session was restored
        // after a daemon restart; don't auto-post/patch a streaming card here.
        // The owner gets a private DM summary instead, and the surviving card
        // (if any) is left untouched. The next real user turn clears this flag
        // (rememberLastCliInput) and the normal card flow resumes.
        if (ds.suppressRecoveryCard) {
          syncWorkerDisplayMode(ds);
          logger.info(`[${t}] Restored session — suppressing recovery streaming card (silent restart)`);
          break;
        }

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
            const initTitle = ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg);
            // Reuse persisted nonce so existing card buttons (toggle/etc) keep working.
            if (!ds.streamCardNonce) ds.streamCardNonce = randomBytes(4).toString('hex');
            // Prefer the last-known screen status when we have one — for /relay
            // resume the worker was idle/limited at transfer time and the
            // CLI didn't actually stop, so showing "starting" right after
            // the M1 "已接力" announcement is misleading. Fresh-spawn worker
            // and post-daemon-restart paths still see lastScreenStatus
            // undefined and fall back to 'starting' (unchanged behavior).
            const initStatus = ds.usageLimit ? 'limited' : (ds.lastScreenStatus ?? 'starting');
            const localCliReadyAtBuild = isLocalCliOpenReady(ds, { cliId: effectiveCliId });
            const codexTierAtBuild = ds.codexServiceTier;
            const streamCardJson = buildStreamingCard(
              ds.session.sessionId,
              sessionAnchorId(ds),
              readOnlyUrl,
              initTitle,
              ds.lastScreenContent ?? '',
              initStatus,
              effectiveCliId,
              ds.displayMode ?? 'hidden',
              ds.streamCardNonce,
              ds.currentImageKey,
              isAdopt,
              showTakeover,
              loc,
              initStatus === 'limited' ? ds.usageLimit : undefined,
              writableTerminalLinkFor(ds),
              localCliReadyAtBuild,
              getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
              sessionRuntimeDisplayName(ds, botCfg),
              codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
            );
            await updateMessage(ds.larkAppId, restoredCardId, streamCardJson);
            if (!ownsLifecycleMutation()) break;
            ds.parkedStreamCardNonce = undefined;
            // Worker IPC handlers may run while the direct restore PATCH is in
            // flight. Re-queue readiness after it completes so an older
            // not-ready payload can never overwrite the cli_session_id PATCH.
            if (!localCliReadyAtBuild && isLocalCliOpenReady(ds, { cliId: effectiveCliId })) {
              scheduleLocalCliOpenReadinessPatch(ds);
            }
            if (ds.codexServiceTier !== codexTierAtBuild) {
              scheduleCodexServiceTierPatch(ds);
            }
            persistStreamCardState(ds);
            // Re-sync worker's display mode (it starts fresh in 'hidden')
            syncWorkerDisplayMode(ds);
            // The restored card is now the active one — withdraw any cards
            // frozen before the daemon went down so they don't pile up in the
            // thread on each restart.
            recallFrozenCards(ds);
            logger.info(`[${t}] Reused existing streaming card ${restoredCardId.substring(0, 12)} after worker (re)start`);
            // Auto-restart recovery: if the reused card is a still-`working`
            // turn, re-arm the periodic usage refresh here. The first
            // post-restart screen_update is typically working→working
            // (statusChanged=false) and would break before the arm choke point.
            syncUsageRefreshTimer(ds);
            break;
          } catch (err) {
            if (!ownsLifecycleMutation()) break;
            // PATCH failed (withdrawn, expired, etc.) — fall through to POST a fresh card.
            logger.info(`[${t}] Failed to reuse existing streaming card (${err instanceof Error ? err.message : err}), posting new one`);
            ds.streamCardId = undefined;
            persistStreamCardState(ds);
          }
        }

        // Send streaming card to group thread (read-only link, will be PATCHed with live output)
        // Set sentinel BEFORE await so concurrent screen_update messages
        // (which can arrive while the POST is in-flight) don't POST a duplicate card.
        // Guard: a concurrent screen_update (e.g. riff's markPromptReady fires
        // screen_update + ready in quick succession) may already have a card POST
        // in-flight. In that case CARD_POSTING_SENTINEL is already set — don't
        // POST a second card; the in-flight POST becomes this turn's card.
        if (ds.streamCardId === CARD_POSTING_SENTINEL) break;
        ds.streamCardId = CARD_POSTING_SENTINEL;
        try {
          ds.streamCardNonce = randomBytes(4).toString('hex');
          const initTitle = ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg);
          // See PATCH-branch comment above re: lastScreenStatus preference.
          // For relay (kill+fork with surviving tmux/CLI), this avoids the
          // jarring "启动中" right after the M1 "已接力" announcement.
          const initStatus = ds.usageLimit ? 'limited' : (ds.lastScreenStatus ?? 'starting');
          const streamCardJson = buildStreamingCard(
            ds.session.sessionId,
            sessionAnchorId(ds),
            readOnlyUrl,
            initTitle,
            // For /relay resume, ds.lastScreenContent is the cached pane
            // from before the kill+fork — using it avoids a blank flash
            // before the first screen_update lands. Fresh worker spawn
            // has lastScreenContent undefined → '' (unchanged).
            ds.lastScreenContent ?? '',
            initStatus,
            effectiveCliId,
            ds.displayMode ?? 'hidden',
            ds.streamCardNonce,
            ds.currentImageKey,
            isAdopt,
            showTakeover,
            loc,
            initStatus === 'limited' ? ds.usageLimit : undefined,
            writableTerminalLinkFor(ds),
            isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
            getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
            sessionRuntimeDisplayName(ds, botCfg),
            codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
          );
          const postedCardId = await scopedReply(streamCardJson, 'interactive', msg.turnId);
          if (!ownsLifecycleMutation()) {
            void deleteMessage(ds.larkAppId, postedCardId).catch(() => { /* best-effort stale-card cleanup */ });
            break;
          }
          ds.streamCardId = postedCardId;
          // This card IS the current turn's live card — clear the new-turn flag
          // so subsequent screen_updates PATCH it (starting → working) instead of
          // POSTing a second card. Without this, a re-fork that happens while
          // streamCardPending is true (new turn + worker had exited) leaves the
          // flag set, the next screen_update takes the new-card POST branch, and
          // this "starting" card is orphaned (never entered frozenCards, so
          // recallFrozenCards can't withdraw it). Mirrors the screen_update POST
          // branch which clears the flag after posting.
          ds.streamCardPending = false;
          ds.parkedStreamCardNonce = undefined;
          persistStreamCardState(ds);
          // Re-sync worker's display mode (it starts fresh in 'hidden')
          syncWorkerDisplayMode(ds);
          // New card is live — recall any cards frozen by previous turns.
          // Done after `streamCardId` is committed so we never delete the old
          // card without a successor visible to the user.
          recallFrozenCards(ds);
          flushPendingLocalCliOpenReadinessPatch(ds);
          flushPendingRiffUrlPatch(ds);
          flushPendingCodexServiceTierPatch(ds);
          // Fresh ready POST: if this turn is already `working` (e.g. relay
          // resume where the CLI kept running), arm here — same authorized arm
          // point as the reuse branch, now that streamCardId is the real id.
          syncUsageRefreshTimer(ds);
        } catch (err) {
          if (!ownsLifecycleMutation()) break;
          if (err instanceof MessageWithdrawnError) {
            await closeWithdrawnSessionIfLedgerEmpty(ds, 'Root message withdrawn while creating worker-ready card');
            break;
          }
          logger.warn(`[${t}] Failed to send streaming card, falling back to static card: ${err}`);
          // Clear sentinel so screen_updates can create a streaming card later
          ds.streamCardId = undefined;
          clearPendingLocalCliOpenReadinessPatch(ds);
          ds.pendingCodexTierCardRefresh = undefined;
          persistStreamCardState(ds);
          // Fallback: send static session card
          try {
            const localCliReadyAtBuild = isLocalCliOpenReady(ds, { cliId: effectiveCliId });
            const cardJson = buildSessionCard(
              ds.session.sessionId,
              sessionAnchorId(ds),
              readOnlyUrl,
              ds.session.title || sessionCliDisplayName(ds, botCfg),
              effectiveCliId,
              undefined,
              !!ds.adoptedFrom,
              loc,
              localCliReadyAtBuild,
              sessionRuntimeDisplayName(ds, botCfg),
            );
            const fallbackCardId = await scopedReply(cardJson, 'interactive', msg.turnId);
            if (!ownsLifecycleMutation()) {
              void deleteMessage(ds.larkAppId, fallbackCardId).catch(() => { /* best-effort stale-card cleanup */ });
              break;
            }
            if (!localCliReadyAtBuild && isLocalCliOpenEnabled()
              && isLocalCliOpenReady(ds, { cliId: effectiveCliId })) {
              const readyCardJson = buildSessionCard(
                ds.session.sessionId,
                sessionAnchorId(ds),
                readOnlyUrl,
                ds.session.title || sessionCliDisplayName(ds, botCfg),
                effectiveCliId,
                undefined,
                !!ds.adoptedFrom,
                loc,
                true,
                sessionRuntimeDisplayName(ds, botCfg),
              );
              try {
                await updateMessage(ds.larkAppId, fallbackCardId, readyCardJson);
              } catch (patchErr) {
                logger.debug(`[${t}] Failed to add local CLI button to fallback card: ${patchErr}`);
              }
            }
          } catch (fallbackErr) {
            if (!ownsLifecycleMutation()) break;
            if (fallbackErr instanceof MessageWithdrawnError) {
              await closeWithdrawnSessionIfLedgerEmpty(ds, 'Root message withdrawn while creating fallback worker-ready card');
              break;
            }
            throw fallbackErr;
          }
        }

        break;
      }

      case 'prompt_ready': {
        if (ds.worker !== worker) break;
        logger.info(`[${t}] ${sessionCliDisplayName(ds, botCfg)} is ready for input`);
        // A live prompt means a (re)spawn reached a working CLI — clear the lazy
        // cold-resume marker set when we parked a crash diagnostic shell. The
        // common retry path respawns IN-PLACE (worker.ts case 'message'), not via
        // forkWorker, so without this the stale marker survives in the store and a
        // LATER genuine zombie (bmx-<sid> actually gone) would be kept active by
        // restore instead of being closed. If retry never reaches a prompt the
        // marker persists, preserving the cross-daemon-restart lazy-retry intent.
        if (ds.session.suspendedColdResume) {
          ds.session.suspendedColdResume = undefined;
          sessionStore.updateSession(ds.session);
        }
        if (ds.pendingRawInput && ds.worker && !ds.worker.killed) {
          const rawInput = ds.pendingRawInput;
          ds.pendingRawInput = undefined;
          const rawTurnId = ds.pendingRawTurnId;
          ds.pendingRawTurnId = undefined;
          // Input buffered while the repo card was pending rides on the SAME
          // IPC: worker message handlers run concurrently (async handlers
          // don't serialize), so a separate `message` IPC could write into
          // the PTY during raw_input's 200ms text→Enter beat. The worker
          // enqueues followUpContent only after the Enter landed.
          const followUp = ds.pendingFollowUpInput;
          ds.pendingFollowUpInput = undefined;
          const followUpCodexAppInput = followUp?.codexAppInputGateFrozen
            ? followUp.codexAppInput
            : codexAppInputForSession(ds, followUp?.codexAppInput);
          sendWorkerSessionInput(ds, {
            type: 'raw_input',
            content: rawInput,
            ...((ds.session.queuedActivationTurnId ?? rawTurnId)
              ? { turnId: ds.session.queuedActivationTurnId ?? rawTurnId }
              : {}),
            followUpContent: followUp?.cliInput,
            ...(followUp?.turnId ? { followUpTurnId: followUp.turnId } : {}),
            ...(followUpCodexAppInput ? { followUpCodexAppInput } : {}),
            ...(ds.session.queuedActivationToken
              ? { queuedActivationToken: ds.session.queuedActivationToken }
              : {}),
          });
          logger.info(`[${t}] Sent pending raw input after prompt_ready: ${rawInput.substring(0, 80)}${followUp ? ` (+follow-up ${followUp.cliInput.length} chars)` : ''}`);
          if (followUp) rememberLastCliInput(ds, followUp.userPrompt, {
            content: followUp.cliInput,
            ...(followUpCodexAppInput ? { codexAppInput: followUpCodexAppInput } : {}),
          }, { codexAppInputAccepted: !!followUpCodexAppInput });
        }
        // CLI reached its prompt — any previously posted stuck warning is stale.
        invalidateStuckWarning(ds, 'prompt_ready');
        invalidateTuiPrompt(ds, 'prompt_ready', 'resolved');
        break;
      }

      case 'runner_build_ready': {
        const identity = runtimeBuildIdentity();
        if (
          ds.worker === worker
          && effectiveCliId === 'codex-app'
          && identity.status === 'known'
          && msg.runnerBuildId === identity.id
        ) {
          ds.session.runnerBuildId = msg.runnerBuildId;
          sessionStore.updateSession(ds.session);
        } else {
          logger.warn(`[${t}] Ignored invalid or stale runner_build_ready`);
        }
        break;
      }

      case 'restart_result': {
        if (ds.worker !== worker) {
          logger.warn(`[${t}] Ignored restart_result from stale worker generation`);
          break;
        }
        restartCoordinator.resolve(ds.session.sessionId, msg.attemptId, msg.status);
        break;
      }

      case 'cli_session_id': {
        const wasLocalCliOpenReady = isLocalCliOpenReady(ds, { cliId: effectiveCliId });
        ds.session.cliSessionId = msg.cliSessionId;
        // One-shot native fork completed: the child now has its OWN CLI-native
        // id (Claude/Codex minted it during --fork-session / codex fork). Clear
        // the pending-fork marker so any later refork resumes THIS transcript
        // instead of re-forking the parent's again.
        if (ds.session.pendingForkSession) {
          ds.session.pendingForkSession = undefined;
          if (ds.initConfig) ds.initConfig.forkSession = false;
        }
        if (ds.adoptedFrom) ds.adoptedFrom.sessionId = msg.cliSessionId;
        if (ds.session.adoptedFrom) ds.session.adoptedFrom.sessionId = msg.cliSessionId;
        sessionStore.updateSession(ds.session);
        // Usage ledger: publish ownership the moment the CLI-native session id
        // is known, so consumers exclude this session from native parsers
        // before its first positive-delta record exists.
        recordOwnershipForDaemonSession(ds);
        if (!managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)
          && !wasLocalCliOpenReady
          && isLocalCliOpenReady(ds, { cliId: effectiveCliId })) {
          scheduleLocalCliOpenReadinessPatch(ds);
        }
        break;
      }

      case 'native_session_title_generated': {
        if (ds.worker !== worker || ds.session.nativeSessionTitleUserDefined) break;
        const title = msg.title.trim();
        if (!title) break;
        ds.session.nativeSessionTitle = title;
        ds.session.nativeSessionTitleAwaitingContent = undefined;
        if (ds.initConfig) {
          ds.initConfig.nativeSessionTitle = title;
          ds.initConfig.nativeSessionTitlePrompt = undefined;
        }
        sessionStore.updateSession(ds.session);
        break;
      }

      case 'codex_service_tier': {
        if (
          ds.worker !== worker
          || ds.workerGeneration !== workerGeneration
          || ds.session.workerGeneration !== workerGeneration
        ) {
          logger.warn(`[${t}] Ignored codex_service_tier from stale worker generation`);
          break;
        }
        ds.codexServiceTier = effectiveCliId === 'codex'
          ? (msg.snapshot ?? undefined)
          : undefined;
        scheduleCodexServiceTierPatch(ds);
        break;
      }

      case 'screen_update': {
        if (!ownsLifecycleMutation()) break;
        // Wait for worker init, independently of Web Terminal availability.
        // ZMX intentionally reports ready with port=0, but its plain-history
        // screenshots and idle/status transitions must keep flowing.
        if (!startupState.ready && !workerHasInitialized(ds)) break;
        const prevStatus = ds.lastScreenStatus;
        updateUsageLimitState(ds, msg.usageLimit);
        ds.lastScreenContent = msg.content;
        ds.lastScreenStatus = (msg.usageLimit ?? ds.usageLimit) ? 'limited' : msg.status;
        // A suspend that arrived mid-turn parked itself here. Defer until this
        // screen_update has finished using process state — suspendWorker nulls
        // `worker` + `lastScreenStatus`, which everything below still reads
        // (usage ledger, turn reactions, transition hook, final card).
        queueMicrotask(() => runPendingSuspendIfSettled(ds, ownsWorkerSession));

        // State-boundary clear: the moment we leave `working` (→ idle/limited),
        // stop the periodic usage refresh immediately — BEFORE the aux-UI /
        // card-disabled / recovery early-breaks below, which would otherwise
        // skip the arm/clear choke point and leave the interval running until it
        // self-corrects or the worker is killed. Arm stays gated below (needs a
        // live card + UI gates); only the clear needs to be unconditional here.
        if (ds.lastScreenStatus !== 'working') clearUsageRefreshTimer(ds);

        // Dashboard: publish a patch only when status truly transitioned, so
        // SSE clients reflect real state changes (starting → working → idle)
        // without flooding on every PTY tick. The screen analyzer is the
        // upstream debouncer — by the time we get here, status flips are
        // already coarse-grained.
        if (prevStatus !== ds.lastScreenStatus) {
          const dashboardRow = composeRowFromActive(ds);
          dashboardEventBus.publish({
            type: 'session.update',
            body: {
              sessionId: ds.session.sessionId,
              patch: {
                status: ds.lastScreenStatus,
                lastMessageAt: ds.lastMessageAt,
                tokenUsage: dashboardRow.tokenUsage,
                previewUserText: dashboardRow.previewUserText,
                previewBotText: dashboardRow.previewBotText,
                previewUserFullText: dashboardRow.previewUserFullText,
                previewBotFullText: dashboardRow.previewBotFullText,
                previewUserAt: dashboardRow.previewUserAt,
                previewBotAt: dashboardRow.previewBotAt,
                previewBotState: dashboardRow.previewBotState,
              },
            },
          });
          emitSessionStateTransitionHook(ds, prevStatus, ds.lastScreenStatus, {
            source: 'screen_update',
            content: msg.content,
          });
          // Usage ledger: any settle-to-idle/limited edge records the delta.
          // Turn reactions are stricter — only flip ✋→✅ after a real busy
          // period (working/analyzing). Cold-start starting→idle (or the first
          // prompt-ready before the turn has gone working) must NOT DONE a
          // message that is still about to be / just being processed. Grok
          // card-off sessions hit this when the ready-gate settle fired idle
          // ~seconds after GoGoGo while the CLI was still running the prompt.
          if (ds.lastScreenStatus === 'idle' || ds.lastScreenStatus === 'limited') {
            recordUsageForDaemonSession(ds);
            if (prevStatus === 'working' || prevStatus === 'analyzing') {
              void finishTurnReactions(ds);
            }
          }
          if (
            ds.lastScreenStatus === 'idle'
            && msg.turnId
            && ds.session.deferredScheduleRun?.turnId === msg.turnId
          ) {
            void cb.onDeferredScheduleTurnSettled?.(ds, { turnId: msg.turnId, source: 'idle' });
          }
          // If every over-cap process was busy, the earlier check deliberately
          // left them alone. Re-check on the first idle edge so capacity is
          // reclaimed immediately instead of waiting for the 60s backstop.
          if (ds.lastScreenStatus === 'idle' && cb.enforceLiveSessionCap) {
            // Defer until this screen_update has finished using process state.
            // The newly-idle session itself may be the oldest eviction target.
            queueMicrotask(cb.enforceLiveSessionCap);
          }
        }

        if (managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) { clearUsageRefreshTimer(ds); break; }

        // Bot opted out of the streaming card — dashboard SSE above already got
        // the status patch; just don't touch any Lark card. Turn-exact: a
        // substitute turn's screen updates stay card-less even after a queued
        // normal turn overwrote currentReplyTarget (and vice versa).
        if (streamingCardDisabled(ds, msg.turnId)) { clearUsageRefreshTimer(ds); break; }

        // Restart recovery: a restored worker may emit screen updates as the CLI
        // redraws on resume. Stay silent (no post/patch) until the first real
        // user turn clears the flag. Dashboard SSE above still reflects status.
        if (ds.suppressRecoveryCard) { clearUsageRefreshTimer(ds); break; }

        const readUrl = readableTerminalUrlFor(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg);
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
            sessionAnchorId(ds),
            readUrl,
            turnTitle,
            isNewTurn ? '' : msg.content,
            ds.lastScreenStatus,
            effectiveCliId,
            mode,
            ds.streamCardNonce,
            ds.currentImageKey,
            isAdopt,
            showTakeover,
            loc,
            cardUsageLimit(ds),
            writableTerminalLinkFor(ds),
            isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
            getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
            sessionRuntimeDisplayName(ds, botCfg),
            codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
          );
          // Mark POST in-flight so subsequent screen_updates are dropped,
          // not POSTed as duplicate cards.
          ds.streamCardPending = false;
          ds.streamCardId = CARD_POSTING_SENTINEL;
          scopedReply(cardJson, 'interactive', msg.turnId)
            .then(msgId => {
              if (!ownsLifecycleMutation()) {
                void deleteMessage(ds.larkAppId, msgId).catch(() => { /* best-effort stale-card cleanup */ });
                return;
              }
              ds.streamCardId = msgId;
              ds.parkedStreamCardNonce = undefined;
              persistStreamCardState(ds);
              // New card live — recall any cards parked by previous turns
              // (user message, bot @mention, adopt-bridge new turn, etc.).
              // This is the main turn-to-turn POST path; without recall here,
              // every long session would leak old streaming cards into the
              // thread.
              recallFrozenCards(ds);
              flushPendingLocalCliOpenReadinessPatch(ds);
              flushPendingRiffUrlPatch(ds);
              flushPendingCodexServiceTierPatch(ds);
              // New-turn POST is the FIRST working screen_update of the turn —
              // the else (same-turn PATCH) branch never runs for it, so arm the
              // periodic usage refresh here (once the real card id exists, not
              // the POSTING sentinel). syncUsageRefreshTimer re-checks state.
              syncUsageRefreshTimer(ds);
            })
            .catch(async err => {
              if (!ownsLifecycleMutation()) return;
              if (err instanceof MessageWithdrawnError) {
                await closeWithdrawnSessionIfLedgerEmpty(ds, 'Root message withdrawn while creating streaming card');
                return;
              }
              logger.debug(`[${t}] Failed to create streaming card: ${err}`);
              ds.streamCardId = undefined;
              clearPendingLocalCliOpenReadinessPatch(ds);
              ds.pendingCodexTierCardRefresh = undefined;
              persistStreamCardState(ds);
            });
        } else {
          // Same turn — PATCH only on status change. Image PATCHes go through
          // the screenshot_uploaded path; text is no longer a card body mode.
          const statusChanged = prevStatus !== ds.lastScreenStatus;
          if (!statusChanged) break;
          const cardJson = buildStreamingCard(
            ds.session.sessionId,
            sessionAnchorId(ds),
            readUrl,
            turnTitle,
            msg.content,
            ds.lastScreenStatus,
            effectiveCliId,
            mode,
            ds.streamCardNonce,
            ds.currentImageKey,
            isAdopt,
            showTakeover,
            loc,
            cardUsageLimit(ds),
            writableTerminalLinkFor(ds),
            isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
            // Turn end (→ idle) reads the exact latest usage; intra-turn status
            // ticks ride the throttle. See getDaemonStreamingCardUsageSnapshot.
            getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId, {
              fresh: ds.lastScreenStatus === 'idle',
            }),
            sessionRuntimeDisplayName(ds, botCfg),
            codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
          );
          scheduleCardPatch(ds, cardJson, msg.turnId);
          // Keep the live usage climbing during a long working phase; stop once
          // the turn settles (idle/limited). State-boundary invariant — one
          // choke point re-evaluates arm/clear after this status assignment.
          syncUsageRefreshTimer(ds);
        }
        break;
      }

      case 'screenshot_uploaded': {
        // Drop uploads that arrived during a new-turn handoff — the image_key may
        // reflect previous turn's content. Next 10s cycle picks up fresh content.
        if (ds.streamCardPending) break;
        ds.currentImageKey = msg.imageKey;
        const prevStatus = ds.lastScreenStatus;
        updateUsageLimitState(ds, msg.usageLimit);
        ds.lastScreenStatus = (msg.usageLimit ?? ds.usageLimit) ? 'limited' : msg.status;
        // Same deferred-suspend checkpoint as the screen_update branch, and
        // deferred for the same reason (see runPendingSuspendIfSettled). This
        // case has NO ownership guard of its own, so passing the predicate is
        // what stops a stale worker's late `idle` from suspending its
        // replacement — the assignment above is already unguarded today.
        queueMicrotask(() => runPendingSuspendIfSettled(ds, ownsWorkerSession));
        emitSessionStateTransitionHook(ds, prevStatus, ds.lastScreenStatus, {
          source: 'screenshot_uploaded',
          imageKey: msg.imageKey,
          content: ds.lastScreenContent ?? '',
        });
        persistStreamCardState(ds);
        // screenshot_uploaded never ARMS the usage refresh — screen_update owns
        // the authorized arm. Here we only tear it down: unconditionally on
        // leaving `working`, and on a managed/silent turn (below) that must not
        // keep a group-visible card ticking. Arming here would let a 12s tick
        // re-render the prior visible card with THIS managed/hidden turn's
        // content — the same leak class as substitute-turn card suppression.
        if (ds.lastScreenStatus !== 'working') clearUsageRefreshTimer(ds);
        if (managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) { clearUsageRefreshTimer(ds); break; }
        if ((ds.displayMode ?? 'hidden') !== 'screenshot') break;
        if (!ds.streamCardId || ds.streamCardId === CARD_POSTING_SENTINEL || !workerHasInitialized(ds)) break;
        const readUrl = readableTerminalUrlFor(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent ?? '',
          ds.lastScreenStatus,
          effectiveCliId,
          'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
          isAdopt,
          showTakeover,
          loc,
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
          isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
          getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId, { fresh: ds.lastScreenStatus === 'idle' }),
          sessionRuntimeDisplayName(ds, botCfg),
          codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
        );
        scheduleCardPatch(ds, cardJson);
        break;
      }

      case 'tui_prompt': {
        // AI detected an interactive TUI prompt — post card to thread
        if (!ownsLifecycleMutation()) {
          logger.info(`[${t}] Ignored TUI prompt from stale worker generation`);
          break;
        }
        // Dedup across both posted and in-flight/cardless prompt state.
        if (hasTuiPromptAuthority(ds)) {
          logger.debug(`[${t}] TUI prompt card already posted, skipping duplicate`);
          break;
        }
        logger.info(`[${t}] TUI prompt detected: ${msg.description}${msg.multiSelect ? ' (multi-select)' : ''}`);
        emitSessionLifecycleHook(ds, 'session.requires_attention', {
          reason: 'tui_prompt',
          description: msg.description,
          optionsCount: msg.options.length,
          optionsPreview: msg.options.slice(0, 5).map(option => ({
            text: option.text,
            label: option.label,
            type: option.type,
            selected: option.selected,
          })),
          multiSelect: msg.multiSelect,
        });
        // Card-only turn label. The dashboard's title is the canonical
        // session.title; publishing this prompt description as `patch.title`
        // would temporarily overwrite a user-issued /rename until refresh.
        ds.currentTurnTitle = msg.description;
        if (managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) {
          logger.info(`[${t}] Managed/silent turn — TUI prompt kept in lifecycle audit only`);
          break;
        }
        // Document-native sessions have no Lark chat/thread destination. Keep
        // the lifecycle audit/title above, but never send a card to their
        // internal `doc:<token>` routing anchor.
        if (isDocNativeSession(ds)) {
          logger.info(`[${t}] Doc-native session — suppressing TUI prompt card`);
          break;
        }
        // The array identity acts as this prompt's in-memory ownership token.
        // Clearing/replacing the prompt changes it, so a late card POST cannot
        // reclaim authority after prompt_ready, worker exit, or replacement.
        // Cardless silent/document prompts deliberately never occupy this slot.
        const promptOptions = msg.options;
        ds.tuiPromptOptions = promptOptions;
        ds.tuiPromptMultiSelect = msg.multiSelect;
        ds.tuiToggledIndices = [];
        ds.tuiPromptProcessing = false;
        try {
          const cardJson = buildTuiPromptCard(
            sessionAnchorId(ds),
            ds.session.sessionId,
            msg.description,
            msg.options,
            msg.multiSelect,
            undefined,
            loc,
          );
          const cardMsgId = await scopedReply(cardJson, 'interactive', msg.turnId);
          const stillOwnsLifecycle = ownsLifecycleMutation();
          if (!stillOwnsLifecycle || ds.tuiPromptOptions !== promptOptions) {
            const terminalCard = stillOwnsLifecycle
              ? buildTuiPromptResolvedCard(tr('card.action.tui_done', undefined, loc), loc)
              : buildTuiPromptFailedCard(tr('worker.tui_submit_failed', {
                cliName: sessionCliDisplayName(ds, botCfg),
              }, loc), loc);
            updateMessage(handlerLarkAppId, cardMsgId, terminalCard).catch(err =>
              logger.debug(`[${t}] Failed to resolve late TUI prompt card: ${err}`),
            );
            break;
          }
          ds.tuiPromptCardId = cardMsgId;
          publishAttentionPatch(ds);
        } catch (err) {
          logger.warn(`[${t}] Failed to post TUI prompt card: ${err}`);
          if (ownsLifecycleMutation() && ds.tuiPromptOptions === promptOptions) {
            clearTuiPromptAuthority(ds);
            publishAttentionPatch(ds);
          }
        }
        break;
      }

      case 'tui_prompt_resolved': {
        if (
          ds.worker !== worker
          || ds.workerGeneration !== workerGeneration
          || ds.session.workerGeneration !== workerGeneration
        ) {
          logger.info(`[${t}] Ignored TUI resolved ACK from stale worker generation`);
          break;
        }
        // TUI prompt is no longer showing — update card if it exists
        logger.info(`[${t}] TUI prompt resolved${msg.selectedText ? `: ${msg.selectedText}` : ''}`);
        if (msg.cardMessageId && ds.tuiPromptCardId !== msg.cardMessageId) {
          logger.info(
            `[${t}] Ignored stale TUI resolved ACK for ${msg.cardMessageId} ` +
            `(active=${ds.tuiPromptCardId ?? 'none'})`,
          );
          break;
        }
        const hadAuthority = hasTuiPromptAuthority(ds);
        if (managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) {
          clearTuiPromptAuthority(ds);
          if (hadAuthority) publishAttentionPatch(ds);
          break;
        }
        if (ds.tuiPromptCardId) {
          const resolvedCard = buildTuiPromptResolvedCard(msg.selectedText ?? tr('card.action.tui_done', undefined, loc), loc);
          updateMessage(ds.larkAppId, ds.tuiPromptCardId, resolvedCard).catch(err =>
            logger.debug(`[${t}] Failed to update TUI prompt card: ${err}`),
          );
        }
        clearTuiPromptAuthority(ds);
        if (hadAuthority) publishAttentionPatch(ds);
        break;
      }

      case 'tui_prompt_submit_failed': {
        if (
          ds.worker !== worker
          || ds.workerGeneration !== workerGeneration
          || ds.session.workerGeneration !== workerGeneration
        ) break;
        const matchesTuiCard = !!msg.cardMessageId
          && ds.tuiPromptCardId === msg.cardMessageId;
        const matchesStuckCard = msg.stuckNonce !== undefined
          && ds.stuckWarningNonce === msg.stuckNonce
          && !!ds.stuckWarningCardId;
        if (!matchesTuiCard && !matchesStuckCard) {
          logger.info(
            `[${t}] Ignored stale TUI submit failure ` +
            `(card=${msg.cardMessageId ?? 'none'}, stuckNonce=${msg.stuckNonce ?? 'none'})`,
          );
          break;
        }

        const failureText = tr('worker.tui_submit_failed', {
          cliName: sessionCliDisplayName(ds, botCfg),
        }, loc);
        if (!managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) {
          const failedCard = buildTuiPromptFailedCard(failureText, loc);
          const failedCardId = matchesTuiCard
            ? ds.tuiPromptCardId
            : ds.stuckWarningCardId;
          if (failedCardId) {
            updateMessage(ds.larkAppId, failedCardId, failedCard).catch(err =>
              logger.debug(`[${t}] Failed to update TUI failure card: ${err}`),
            );
          }
          try {
            await scopedReply(failureText, 'text', msg.turnId);
          } catch (err: any) {
            logger.error(`[${t}] Failed to deliver TUI submit failure: ${err.message}`);
          }
        }

        if (matchesTuiCard) {
          clearTuiPromptAuthority(ds);
        }
        if (matchesStuckCard) clearStuckWarningAuthority(ds);
        publishAttentionPatch(ds);
        break;
      }

      case 'stuck_warning': {
        // Ignore stuck_warning from a stale worker generation — the CLI may have
        // been replaced and a new worker owns the session now.
        if (ds.worker !== worker) break;
        // AI-free StuckDetector fired: a written input hasn't produced a
        // completed turn within the timeout AND the PTY has been quiet, AND the
        // snapshot matches a known Codex hook-review screen. The detector only
        // emits when it matches level 1 or level 2 — there is no "unknown
        // stall" path, so we always build an interactive card with the exact
        // keys the screen documents.
        // Dedup: skip if we already posted a warning for THIS turn, OR if a
        // stuck-warning card is already active (covers the no-turnId case where
        // a second stall fires before the first card is resolved).
        const isDuplicateTurn = msg.turnId !== undefined && ds.stuckWarningTurnId === msg.turnId;
        const hasActiveCard = !!ds.stuckWarningCardId;
        if (isDuplicateTurn || hasActiveCard) {
          logger.debug(`[${t}] Stuck warning dedup skipped (turn=${msg.turnId ?? 'none'}, activeCard=${hasActiveCard})`);
          break;
        }
        // Allocate a daemon-side nonce for this warning (NOT the worker's
        // generation — the daemon is the authority on which warning is active).
        // If the CLI recovers (prompt_ready) or the worker is replaced while the
        // POST is in flight, invalidateStuckWarning clears the nonce; when the
        // POST returns we check it is still current and, if not, resolve the card
        // immediately instead of registering it as active.
        // Allocate a daemon-side nonce for this warning from a monotonic
        // counter that is NEVER cleared (even when the active authority is
        // dropped). This prevents the nonce-reuse race: warning nonce=1 POST
        // awaits → prompt_ready clears active nonce → warning nonce=1 again
        // would let the old POST register against the new authority. With a
        // monotonic counter the second warning gets nonce=2, and the old
        // POST's nonce=1 check fails.
        const nonce = (ds.stuckWarningNonceCounter ?? 0) + 1;
        ds.stuckWarningNonceCounter = nonce;
        ds.stuckWarningNonce = nonce;
        ds.stuckWarningTurnId = msg.turnId;
        ds.stuckWarningCliLifetime = msg.cliLifetime;
        const pageType = msg.matchedPattern;
        ds.stuckWarningPageType = pageType;
        const secs = Math.round(msg.elapsedMs / 1000);
        logger.info(`[${t}] Stuck warning: turn unresolved for ${secs}s (${pageType}) nonce=${nonce}`);
        emitSessionLifecycleHook(ds, 'session.requires_attention', {
          reason: 'stuck_warning',
          elapsedMs: msg.elapsedMs,
          matchedPattern: pageType,
        });
        if (managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) break;

        let description: string;
        let options: Array<{ label: string; text: string; selected: boolean; type: 'confirm' | 'select'; keys: string[] }>;
        if (pageType === 'hook review level 2') {
          // Level 2 — per-hook review: t=trust, Esc=go back. No Enter here.
          description = `⚠️ Codex 卡在单项 hook 审核界面——消息已写入但 ${secs}s 未完成处理。\n\n选择操作以继续，或打开终端手动处理：`;
          options = [
            { label: 't', text: '信任 (trust)', selected: false, type: 'confirm' as const, keys: ['t'] },
            { label: 'Esc', text: '返回 (go back)', selected: false, type: 'select' as const, keys: ['Escape'] },
          ];
        } else {
          // Level 1 — hooks browser: t=trust all, Enter=review hooks, Esc=close.
          description = `⚠️ Codex 卡在 hook 审核界面——消息已写入但 ${secs}s 未完成处理。\n\n选择操作以继续，或打开终端手动处理：`;
          options = [
            { label: 't', text: '信任全部 (trust all)', selected: false, type: 'confirm' as const, keys: ['t'] },
            { label: 'Enter', text: '逐项审核 (review hooks)', selected: false, type: 'select' as const, keys: ['Enter'] },
            { label: 'Esc', text: '关闭 (close)', selected: false, type: 'select' as const, keys: ['Escape'] },
          ];
        }
        try {
          const cardJson = buildTuiPromptCard(
            sessionAnchorId(ds),
            ds.session.sessionId,
            description,
            options,
            false,
            undefined,
            loc,
          );
          const cardMsgId = await scopedReply(cardJson, 'interactive', msg.turnId);
          // Authority check: if the warning was invalidated (prompt_ready,
          // CLI exit, worker replace) OR the worker was replaced while the POST
          // was in flight, resolve the card immediately and do NOT register it
          // as active — a late click would otherwise inject keys into a
          // recovered/replaced CLI. Verify the full tuple: same worker process,
          // same worker generation, same nonce.
          if (ds.worker !== worker || ds.workerGeneration !== workerGeneration || ds.stuckWarningNonce !== nonce) {
            logger.debug(`[${t}] Stuck warning card POSTed but authority stale (nonce=${nonce}, current=${ds.stuckWarningNonce ?? 'none'}, workerGen=${workerGeneration}) — resolving`);
            const locDs = localeForBot(ds.larkAppId);
            const resolvedCard = buildTuiPromptResolvedCard(tr('card.action.tui_done', undefined, locDs), locDs);
            updateMessage(ds.larkAppId, cardMsgId, resolvedCard).catch(err =>
              logger.debug(`[${t}] Failed to resolve stale stuck-warning card: ${err}`),
            );
            break;
          }
          ds.stuckWarningCardId = cardMsgId;
          publishAttentionPatch(ds);
        } catch (err: any) {
          logger.warn(`[${t}] Failed to post stuck warning card: ${err}`);
          // Card send failed — clear markers ONLY if this nonce is still
          // current AND we still own the worker. A newer warning (nonce+1) may
          // have started while this POST was in flight; we must not wipe the
          // newer state.
          if (ds.worker === worker && ds.workerGeneration === workerGeneration && ds.stuckWarningNonce === nonce) {
            clearStuckWarningAuthority(ds);
          }
        }
        break;
      }

      case 'stuck_warning_expired': {
        // Ignore from a stale worker generation.
        if (ds.worker !== worker || ds.workerGeneration !== workerGeneration) break;
        // Worker refused to inject keys from a stuck-warning card because the
        // current screen no longer matches the page type the card was built for.
        // Resolve the card with a "page changed" message so the user knows the
        // action was NOT performed, then clear the authority.
        if (ds.stuckWarningNonce === msg.nonce && ds.stuckWarningCardId) {
          const locDs = localeForBot(ds.larkAppId);
          const resolvedCard = buildTuiPromptResolvedCard('页面已变化，未发送按键', locDs);
          updateMessage(ds.larkAppId, ds.stuckWarningCardId, resolvedCard).catch(err =>
            logger.debug(`[${t}] Failed to update stuck-warning card on expired: ${err}`),
          );
          clearStuckWarningAuthority(ds);
        }
        break;
      }

      case 'tui_keys_delivered': {
        // Ignore from a stale worker generation.
        if (ds.worker !== worker || ds.workerGeneration !== workerGeneration) break;
        // Worker confirmed the keys were written to the PTY. Clear the card
        // authority and render success. We only do this AFTER the worker ACK
        // (not on click), so a rejected click (stuck_warning_expired) does not
        // falsely report success.
        if (ds.stuckWarningNonce === msg.nonce && ds.stuckWarningCardId) {
          const locDs = localeForBot(ds.larkAppId);
          const resolvedCard = buildTuiPromptResolvedCard(tr('card.action.tui_done', undefined, locDs), locDs);
          updateMessage(ds.larkAppId, ds.stuckWarningCardId, resolvedCard).catch(err =>
            logger.debug(`[${t}] Failed to resolve stuck-warning card on delivered: ${err}`),
          );
          clearStuckWarningAuthority(ds);
        }
        break;
      }

      case 'claude_exit': {
        // CLI-generation authority must not outlive the concrete worker/CLI
        // pair that issued it. A delayed message from a replaced Node worker
        // must neither clear nor restart the replacement generation.
        const workerSession = ds.session;
        if (ds.worker !== worker || ds.workerGeneration !== workerGeneration) {
          logger.warn(`[${t}] Ignored claude_exit from stale worker generation`);
          break;
        }
        ds.managedTurnOrigin = undefined;
        // The worker/CLI generation ended. Disable an outstanding stuck-warning
        // card before any replacement worker can be attached; otherwise a late
        // click could inject its keys into the replacement CLI.
        invalidateStuckWarning(ds, 'claude_exit');
        invalidateTuiPrompt(ds, 'claude_exit');
        logger.info(`[${t}] ${sessionCliDisplayName(ds, botCfg)} exited (code: ${msg.code}, signal: ${msg.signal})`);
        ds.hasHistory = true;
        try {
          await cb.onCliExit?.(ds, {
            sessionId: ds.session.sessionId,
            workerGeneration,
            code: msg.code,
            signal: msg.signal,
          });
        } catch (err: any) {
          logger.error(`[${t}] Failed to reconcile CLI exit generation ${workerGeneration}: ${err.message}`);
        }
        // onCliExit may persist/reconcile durable state and therefore yield.
        // A transfer, repo replacement, or worker replacement that won during
        // that await owns all later lifecycle decisions. Never restart/kill its
        // new worker from this stale CLI-exit continuation.
        if (
          ds.worker !== worker
          || ds.workerGeneration !== workerGeneration
          || ds.session !== workerSession
          || isSessionTransferring(ds)
        ) {
          logger.warn(`[${t}] Suppressed stale claude_exit lifecycle continuation`);
          break;
        }
        const suppressExitUi = managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt);

        // Do NOT auto-restart in adopt mode — there's nothing to restart
        if (ds.adoptedFrom) {
          logger.info(`[${t}] Adopted session ended`);
          // Freeze the streaming card
          if (!suppressExitUi && ds.streamCardId && workerHasInitialized(ds)) {
            const readUrl = readableTerminalUrlFor(ds);
            const turnTitle = ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg);
            const frozenCard = buildStreamingCard(
              ds.session.sessionId, sessionAnchorId(ds), readUrl, turnTitle,
              ds.lastScreenContent ?? '', 'idle', effectiveCliId,
              ds.displayMode ?? 'hidden', ds.streamCardNonce, ds.currentImageKey,
              isAdopt, showTakeover, loc, undefined, writableTerminalLinkFor(ds),
              isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
              getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId, { fresh: true }),
              sessionRuntimeDisplayName(ds, botCfg),
              codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
            );
            scheduleCardPatch(ds, frozenCard);
          }
          killWorker(ds);
          // Skip the exit notice when the session was already closed via the
          // ⏏ card button — card-handler already posted "已断开，原 CLI 会话
          // 不受影响" right before killing us, so another exit message here
          // is just noise. Natural exits (user typed `exit`, CLI crashed)
          // leave status='active' and still get the notice.
          if (!suppressExitUi && ds.session.status !== 'closed') {
            try {
              await scopedReply(tr('worker.adopted_session_exited', undefined, loc), 'text', undefined);
            } catch { /* best effort */ }
          }
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
          logger.warn(`[${t}] ${sessionCliDisplayName(ds, botCfg)} crashed ${rc.count} times in 1 min, not auto-restarting`);
          const keepDiagnosticWorker = !!msg.canParkDiagnostic && !!ds.worker && !ds.worker.killed;
          // Freeze the last streaming card so it doesn't stay at "working"
          // forever. Backends without a Web Terminal pass an empty read URL;
          // the card keeps snapshot/manage controls and omits terminal links.
          if (!suppressExitUi && ds.streamCardId && workerHasInitialized(ds)) {
            const readUrl = readableTerminalUrlFor(ds);
            const turnTitle = ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg);
            const frozenCard = buildStreamingCard(
              ds.session.sessionId, sessionAnchorId(ds), readUrl, turnTitle,
              ds.lastScreenContent ?? '', 'idle', effectiveCliId,
              ds.displayMode ?? 'hidden', ds.streamCardNonce, ds.currentImageKey,
              isAdopt, showTakeover, loc, undefined, writableTerminalLinkFor(ds),
              isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
              getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId, { fresh: true }),
              sessionRuntimeDisplayName(ds, botCfg),
              codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
            );
            scheduleCardPatch(ds, frozenCard);
          }
          if (keepDiagnosticWorker) {
            // Ask the worker to park a lightweight tmux diagnostic shell under
            // bmx-diag-<sid> NOW (deferred from its exit so transient restarts
            // don't pay for it). Keep its web server alive so the existing
            // terminal URL can show the startup failure; the next user message
            // tells that same worker to destroy the diagnostic shell and retry.
            ds.workerReady = false;
            ds.worker!.send({ type: 'park_diagnostic' } as DaemonToWorker);
            restartCounts.delete(key);
            ds.lastScreenStatus = 'idle';
            // Diagnostic park keeps the worker alive (no killWorker here), so the
            // periodic usage refresh must be stopped explicitly on this
            // working→idle boundary — the else branch's killWorker already does.
            clearUsageRefreshTimer(ds);
            // Survive a daemon restart: mark this as a deliberate lazy
            // cold-resume. Restore keeps ANY managed session with a 'missing'
            // backing active regardless (re-spawns the CLI on the next
            // message) since the host-reboot fix, so this marker records the
            // parked state (dormant label + skip redundant probes) rather than
            // gating the keep. ds.hasHistory is already true (set at the top of
            // claude_exit); forkWorker clears suspendedColdResume on re-spawn.
            ds.session.suspendedColdResume = true;
            sessionStore.updateSession(ds.session);
          } else {
            // Non-tmux or failed diagnostic parking: keep the historical
            // cleanup path so we do not leave an unusable worker around.
            killWorker(ds);
          }
          const cliName = sessionCliDisplayName(ds, botCfg);
          const parts = [tr('worker.crash_loop_stopped', { cliName, count: rc.count }, loc)];
          if (keepDiagnosticWorker) {
            parts.push(tr('worker.crash_diagnostic_terminal', undefined, loc));
          }
          if (msg.logTail?.trim()) {
            parts.push(`${tr('worker.crash_recent_output', undefined, loc)}\n${msg.logTail.trim()}`);
          }
          if (!suppressExitUi) {
            try {
              await scopedReply(parts.join('\n\n'), 'text', undefined);
            } catch (replyErr) {
              if (replyErr instanceof MessageWithdrawnError && ownsLifecycleMutation()) {
                await closeWithdrawnSessionIfLedgerEmpty(ds, 'Root message withdrawn while sending crash diagnostic');
              }
            }
          }
          break;
        }

        // Auto-restart CLI within the same worker. 捎带最新 per-bot env：崩溃
        // 往往正是旧 env 配的错（如过期 token / 失效 proxy），用户改完 env 后
        // 下一轮 auto-restart 直接用新值恢复，不必再手工 /close。
        if (ds.worker && !ds.worker.killed) {
          logger.info(`[${t}] Auto-restarting ${sessionCliDisplayName(ds, botCfg)}...`);
          ds.workerReady = false;
          ds.worker.send({ type: 'restart', reason: 'cli_crash', env: latestPerBotEnvForRestart(ds) } as DaemonToWorker);
        }
        break;
      }

      case 'error': {
        logger.error(`[${t}] Worker error: ${msg.message}`);
        // `error` is a fatal launch-generation signal. It normally arrives
        // during init, but can also follow a previously-ready worker whose CLI
        // recovery/restart fails; that later failure must remain user-visible.
        await notifyStartupFailure(msg.message, msg.turnId, msg.dispatchAttempt);
        break;
      }

      case 'riff_access_url': {
        if (ds.worker !== worker) {
          logger.warn(`[${t}] Ignored riff_access_url from stale worker: ${msg.accessUrl}`);
          break;
        }
        if (ds.riffAccessUrl === msg.accessUrl) break;
        ds.riffAccessUrl = msg.accessUrl;
        logger.info(`[${t}] Riff sandbox access URL updated (urlhash: ${hashUrlForLog(msg.accessUrl)})`);
        // Dashboard: refresh the session row's Web 终端 link immediately.
        dashboardEventBus.publish({
          type: 'session.update',
          body: { sessionId: ds.session.sessionId, patch: { riffAccessUrl: msg.accessUrl } },
        });
        // Refresh the live streaming card (writable/AIO link) — parks a pending
        // flag when the card POST is still in-flight and flushes once it lands.
        if (!managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) scheduleRiffAccessUrlPatch(ds);
        break;
      }

      case 'riff_task_id': {
        if (ds.worker !== worker) break;
        if (msg.taskId === null) {
          // follow-up 血缘断裂：清掉持久化锚点，否则 daemon 重启会复活已判坏的 parent。
          if (ds.session.riffParentTaskId) {
            ds.session.riffParentTaskId = undefined;
            sessionStore.updateSession(ds.session);
          }
          break;
        }
        if (ds.session.riffParentTaskId === msg.taskId) break;
        // Persist the follow-up lineage anchor: after a daemon restart the
        // rebuilt RiffBackend resumes from this id (resumeParentTaskId) so the
        // next message continues the riff conversation in the warm sandbox
        // instead of cold-booting a context-less fresh task (4-5 min).
        ds.session.riffParentTaskId = msg.taskId;
        sessionStore.updateSession(ds.session);
        break;
      }

      case 'deferred_topic_materialized': {
        if (ds.worker !== worker || msg.sessionId !== ds.session.sessionId) {
          logger.warn(`[${t}] Dropped deferred topic binding from stale/wrong worker`);
          break;
        }
        // Local backends claim through the host-visible sidecar directly. Only
        // Riff needs the terminal-output relay, and terminal text is agent-
        // controlled, so never let a fabricated local line create a binding.
        if ((ds.initConfig?.backendType ?? ds.session.backendType) !== 'riff') {
          logger.warn(`[${t}] Dropped deferred topic relay from non-Riff backend`);
          break;
        }
        const run = ds.session.deferredScheduleRun;
        if (!run || msg.turnId !== run.turnId || !msg.rootMessageId.startsWith('om_')) {
          logger.warn(`[${t}] Dropped deferred topic binding with mismatched run identity`);
          break;
        }
        // Defense in depth for the remote stdout relay: prove the claimed
        // message actually exists in this run's target chat before persisting
        // the host-side binding. This fences fabricated/cross-chat message ids.
        const claimedChatId = await getMessageChatId(ds.larkAppId, msg.rootMessageId);
        if (claimedChatId !== ds.chatId) {
          logger.warn(`[${t}] Dropped deferred topic binding outside target chat`);
          break;
        }
        writeDeferredTopicBinding(config.session.dataDir, {
          sessionId: ds.session.sessionId,
          turnId: run.turnId,
          chatId: ds.chatId,
          larkAppId: ds.larkAppId,
          routingAnchor: run.routingAnchor,
          rootMessageId: msg.rootMessageId,
          createdAt: new Date().toISOString(),
        });
        logger.info(`[${t}] Deferred topic root recorded ${msg.rootMessageId.substring(0, 12)}`);
        break;
      }

      case 'bridge_source_session': {
        if (msg.bridge !== 'hermes') break;
        if (ds.worker !== worker) {
          logger.warn(`[${t}] Ignored Hermes source binding from stale worker: ${msg.sourceSessionId}`);
          break;
        }
        const sourceSessionIds = ds.hermesBridgeSourceSessionIds ??= new Set<string>();
        if (sourceSessionIds.has(msg.sourceSessionId)) break;
        if (sourceSessionIds.size === 0) {
          logger.info(`[${t}] Hermes bridge sourceSessionId bound: ${msg.sourceSessionId}`);
        } else {
          logger.info(`[${t}] Hermes bridge sourceSessionId added after rebind: ${msg.sourceSessionId}`);
        }
        sourceSessionIds.add(msg.sourceSessionId);
        break;
      }

      case 'explicit_reply_observed': {
        if (msg.turnId.startsWith('mlrp_turn_')) {
          markMessageListenerRunPreviewReplied(msg.turnId, {
            sessionId: ds.session.sessionId,
            replyMessageId: msg.messageId,
          });
        }
        break;
      }

      case 'user_notify': {
        logger.warn(`[${t}] Worker user_notify: ${msg.message}`);
        emitSessionLifecycleHook(ds, 'session.requires_attention', {
          reason: 'user_notify',
          message: msg.message,
        });
        if (managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) break;
        try {
          await scopedReply(msg.message, 'text', msg.turnId);
        } catch (err: any) {
          logger.error(`[${t}] Failed to deliver user_notify to Lark: ${err.message}`);
        }
        break;
      }

      case 'steer_accepted': {
        if (ds.worker !== worker) {
          logger.warn(`[${t}] Ignored steer_accepted from stale worker generation`);
          break;
        }
        logger.info(
          `[${t}] Codex App steer accepted `
          + `appTurn=${msg.appTurnId.slice(0, 12)} replyTurn=${msg.turnId.slice(0, 12)}`,
        );
        if (managedAuxUiSuppressed(msg.turnId, undefined)) break;
        try {
          await scopedReply(tr('worker.steer_accepted', undefined, loc), 'text', msg.turnId);
        } catch {
          logger.error(
            `[${t}] Failed to deliver steer acknowledgement `
            + `appTurn=${msg.appTurnId.slice(0, 12)} replyTurn=${msg.turnId.slice(0, 12)} `
            + 'category=delivery',
          );
        }
        break;
      }

      case 'turn_terminal': {
        if (ds.worker !== worker) {
          logger.warn(`[${t}] Ignored turn_terminal from stale worker generation`);
          break;
        }
        if (msg.sessionId !== ds.session.sessionId) {
          logger.warn(
            `[${t}] Dropped turn_terminal with mismatched sessionId ` +
            `(worker=${msg.sessionId}, daemon=${ds.session.sessionId}, turn=${msg.turnId.substring(0, 8)})`,
          );
          break;
        }
        // Defense in depth: the worker sends a token-matched revoke before the
        // terminal IPC, but an older/mixed worker must still lose authority at
        // this exact terminal edge. Tuple-match prevents a late turn N event
        // from clearing a capability already rotated for turn N+1.
        if (ds.managedTurnOrigin?.turnId === msg.turnId
          && ds.managedTurnOrigin.dispatchAttempt === msg.dispatchAttempt) {
          ds.managedTurnOrigin = undefined;
        }
        try {
          await cb.onTurnTerminal?.(ds, msg, { workerGeneration });
        } catch (err: any) {
          // The durable receipt remains non-terminal and can be reconciled;
          // never let a projection/store failure crash the worker IPC loop.
          logger.error(`[${t}] Failed to persist turn_terminal for ${msg.turnId.substring(0, 8)}: ${err.message}`);
        }
        if (msg.turnId.startsWith('mlrp_turn_') && msg.status !== 'completed') {
          markMessageListenerRunPreviewFailed(msg.turnId, {
            sessionId: msg.sessionId,
            error: msg.errorCode ?? msg.status,
          });
        }
        try {
          await cb.onDeferredScheduleTurnSettled?.(ds, { turnId: msg.turnId, source: 'terminal' });
        } catch (err: any) {
          logger.error(`[${t}] Failed to settle deferred schedule turn ${msg.turnId.substring(0, 8)}: ${err.message}`);
        }
        break;
      }

      case 'receiver_reset_ready': {
        if (msg.sessionId !== ds.session.sessionId) {
          logger.warn(`[${t}] Dropped receiver_reset_ready with mismatched sessionId`);
          break;
        }
        cb.onReceiverResetReady?.(ds, {
          sessionId: msg.sessionId,
          turnId: msg.turnId,
          dispatchAttempt: msg.dispatchAttempt,
        });
        break;
      }

      case 'durable_expiry_ready': {
        if (msg.sessionId !== ds.session.sessionId) {
          logger.warn(`[${t}] Dropped durable_expiry_ready with mismatched sessionId`);
          break;
        }
        cb.onDurableExpiryReady?.(ds, {
          sessionId: msg.sessionId,
          turnId: msg.turnId,
          dispatchAttempt: msg.dispatchAttempt,
          workerGeneration,
          disposition: msg.disposition,
        });
        break;
      }

      case 'managed_turn_origin': {
        if (ds.worker !== worker) {
          logger.warn(`[${t}] Ignored managed_turn_origin from stale worker generation`);
          break;
        }
        if (msg.sessionId !== ds.session.sessionId) {
          logger.warn(`[${t}] Dropped managed_turn_origin with mismatched sessionId`);
          break;
        }
        ds.managedTurnOrigin = {
          capability: msg.capability,
          ...(msg.turnId ? { turnId: msg.turnId } : {}),
          ...(msg.dispatchAttempt !== undefined
            ? { dispatchAttempt: msg.dispatchAttempt }
            : {}),
        };
        break;
      }

      case 'managed_turn_origin_revoked': {
        if (ds.worker !== worker) {
          logger.warn(`[${t}] Ignored managed_turn_origin_revoked from stale worker generation`);
          break;
        }
        if (msg.sessionId !== ds.session.sessionId) {
          logger.warn(`[${t}] Dropped managed_turn_origin_revoked with mismatched sessionId`);
          break;
        }
        // Same-worker IPC is ordered, but token-match as well so a delayed
        // revoke can never clear authority already rotated by the next turn.
        if (msg.capability
          && ds.managedTurnOrigin?.capability
          && ds.managedTurnOrigin.capability !== msg.capability) {
          logger.warn(`[${t}] Ignored stale managed turn origin revoke after capability rotation`);
          break;
        }
        if (!msg.capability && ds.managedTurnOrigin
          && (ds.managedTurnOrigin.turnId !== msg.turnId
            || ds.managedTurnOrigin.dispatchAttempt !== msg.dispatchAttempt)) {
          logger.warn(`[${t}] Ignored unbound stale managed turn origin revoke`);
          break;
        }
        ds.managedTurnOrigin = undefined;
        break;
      }

      case 'codex_app_dispatch_transition': {
        const acknowledge = (ok: boolean, error?: string): void => {
          try {
            worker.send({
              type: 'codex_app_dispatch_persisted',
              requestId: msg.requestId,
              ok,
              ...(error ? { error } : {}),
            } as DaemonToWorker);
          } catch { /* worker exit makes the prepared/final state replayable */ }
        };
        if (ds.worker !== worker) {
          acknowledge(false, 'stale_worker_generation');
          break;
        }
        if (msg.sessionId !== ds.session.sessionId) {
          acknowledge(false, 'session_mismatch');
          break;
        }
        const ledger = ds.session.codexAppDispatchLedger ?? [];
        let next: { ok: true; ledger: CodexAppDispatchLedgerEntry[] } | { ok: false; error: string };
        if (msg.operation === 'submit') {
          if (msg.entries.length !== 1) {
            acknowledge(false, 'submit_requires_one_entry');
            break;
          }
          next = prepareCodexAppDispatch(ledger, msg.entries[0]);
        } else if (msg.operation === 'retry') {
          if (msg.entries.length !== 1) {
            acknowledge(false, 'retry_requires_one_entry');
            break;
          }
          next = retryPreparedCodexAppDispatch(ledger, msg.entries[0]);
        } else {
          if (msg.entries.length !== 1) {
            acknowledge(false, 'cancel_requires_one_entry');
            break;
          }
          next = cancelCodexAppDispatch(ledger, msg.entries[0]);
        }
        if (!next.ok) {
          acknowledge(false, next.error);
          break;
        }
        const priorLedger = ds.session.codexAppDispatchLedger;
        ds.session.codexAppDispatchLedger = next.ledger;
        let persisted = false;
        try {
          sessionStore.updateSession(ds.session);
          persisted = true;
          acknowledge(true);
        } catch (err: any) {
          ds.session.codexAppDispatchLedger = priorLedger;
          acknowledge(false, err?.message ?? 'session_store_write_failed');
        }
        if (persisted && !hasUnsettledCodexAppDispatch(ds.session.codexAppDispatchLedger)) {
          try { await cb.onCodexAppLedgerDrained?.(ds); }
          catch (err) { logger.error(`[${t}] post-drain cleanup failed: ${err instanceof Error ? err.message : String(err)}`); }
        }
        break;
      }

      case 'codex_app_generation_active': {
        if (ds.worker !== worker || msg.sessionId !== ds.session.sessionId) break;
        if (!msg.fresh) break;
        const priorCommits = ds.session.codexAppGenerationCommits;
        ds.session.codexAppGenerationCommits = retainFreshCodexAppGeneration(
          ds.session.codexAppGenerationCommits ?? [],
          msg.generation,
        );
        try {
          sessionStore.updateSession(ds.session);
        } catch (err) {
          ds.session.codexAppGenerationCommits = priorCommits;
          logger.error(`[${t}] Failed to persist fresh Codex App generation: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'session_close_ready': {
        resolveCloseFence(msg.sessionId, workerGeneration);
        break;
      }

      case 'final_output': {
        if (msg.codexAppSettlement) {
          const settlement = msg.codexAppSettlement;
          const acknowledge = (ok: boolean, error?: string): void => {
            try {
              worker.send({
                type: 'codex_app_dispatch_persisted',
                requestId: settlement.requestId,
                ok,
                ...(error ? { error } : {}),
              } as DaemonToWorker);
            } catch { /* runner keeps the final unacknowledged for replacement */ }
          };
          if (ds.worker !== worker) {
            acknowledge(false, 'stale_worker_generation');
            break;
          }
          if (msg.sessionId !== ds.session.sessionId) {
            acknowledge(false, 'session_mismatch');
            break;
          }
          if (committedCodexAppSequence(
            ds.session.codexAppGenerationCommits ?? [],
            settlement.generation,
            settlement.seq,
          )) {
            acknowledge(true);
            if (!hasUnsettledCodexAppDispatch(ds.session.codexAppDispatchLedger)) {
              try { await cb.onCodexAppLedgerDrained?.(ds); }
              catch (err) { logger.error(`[${t}] post-drain cleanup failed: ${err instanceof Error ? err.message : String(err)}`); }
            }
            break;
          }
          const identity = {
            dispatchId: settlement.dispatchId,
            turnId: msg.turnId,
            ...(msg.dispatchAttempt !== undefined
              ? { dispatchAttempt: msg.dispatchAttempt }
              : {}),
          };
          const preview = settleCodexAppDispatch(
            ds.session.codexAppDispatchLedger ?? [],
            ds.session.codexAppGenerationCommits ?? [],
            identity,
            settlement.generation,
            settlement.seq,
          );
          if (!preview.ok) {
            acknowledge(false, preview.error);
            break;
          }
          // R4/R5-B4 defense-in-depth: a `steer_superseded` settlement silently
          // advances the FIFO without delivering, so it is ONLY legitimate for a
          // genuine plain-Lark steerable head that STILL has a successor. Reject
          // (ACK=false, no pop, no receiver completion, no mutation) BEFORE the
          // commit block below if the settled entry is not steerable, not an
          // explicit Lark sink, belongs to a VC / durable-receiver / special
          // channel, or is the SOLE remaining head. R5: `deliverySink` must be
          // exactly 'lark' — admission always writes both sink and steerable
          // together, so "steerable=true + sink missing" can only be a
          // mixed/corrupt/legacy ledger and must fail closed, not be treated as
          // safe Lark. And a lone forged superseded (no successor) must never
          // silently commit the only head — the real final would then find no
          // pending turn. preview.ledger is the post-settle remainder.
          if (msg.disposition === 'steer_superseded') {
            const entry = preview.settledEntry;
            const supersededHeadOk = entry.codexAppSteerable === true
              && entry.deliverySink === 'lark'
              && entry.vcMeetingImTurnOrigin === undefined
              && ds.session.vcMeetingReceiver === undefined
              && preview.ledger.length > 0;
            if (!supersededHeadOk) {
              logger.warn(
                `[${t}] Rejected steer_superseded for non-steerable/special/last head `
                + `(turn ${msg.turnId.substring(0, 8)}, sink=${entry.deliverySink ?? 'legacy'}, `
                + `steerable=${entry.codexAppSteerable === true}, successors=${preview.ledger.length})`,
              );
              acknowledge(false, 'superseded_head_not_plain_lark_steerable_with_successor');
              break;
            }
          }
          const key = `${ds.session.sessionId}:${settlement.generation}:${settlement.seq}`;
          let inFlight = codexAppFinalSettlementInFlight.get(key);
          if (!inFlight) {
            inFlight = (async () => {
              const unavailableSinkFailClosed = codexAppDeliveryMustFailClosed(
                ds,
                preview.settledEntry,
              );
              const deliverySuppressed = msg.suppressDelivery === true
                || managedFinalOutputSuppressed(msg.turnId, msg.dispatchAttempt)
                || unavailableSinkFailClosed;
              if (unavailableSinkFailClosed
                && preview.settledEntry.deliverySink !== 'suppressed'
                && msg.suppressDelivery !== true) {
                logger.warn(
                  `[${t}] Codex App recovery suppressed unavailable `
                  + `${preview.settledEntry.deliverySink ?? 'legacy non-Lark'} sink `
                  + `(turn ${msg.turnId.substring(0, 8)})`,
                );
              }
              const alreadyDelivered = ds.lastBridgeEmittedUuid === finalOutputDedupeKey(ds, msg);
              const owned = deliverySuppressed || !msg.content.trim() || alreadyDelivered
                ? true
                : await new Promise<boolean>(resolve => {
                    deliverFinalOutput(
                      ds,
                      msg,
                      t,
                      0,
                      resolve,
                      () => ds.worker === worker
                        && ds.session.sessionId === msg.sessionId,
                      preview.settledEntry.replyTarget,
                    );
                  });
              if (!owned) return false;

              // Re-read after the asynchronous external delivery. A concurrent
              // replacement may already have committed this signed sequence;
              // that is idempotent success, never a second FIFO pop.
              if (committedCodexAppSequence(
                ds.session.codexAppGenerationCommits ?? [],
                settlement.generation,
                settlement.seq,
              )) return true;
              const committed = settleCodexAppDispatch(
                ds.session.codexAppDispatchLedger ?? [],
                ds.session.codexAppGenerationCommits ?? [],
                identity,
                settlement.generation,
                settlement.seq,
              );
              if (!committed.ok) return false;
              if (msg.dispatchAttempt !== undefined) {
                try {
                  // Durable receivers must not depend on the worker surviving
                  // the daemon ACK long enough to emit a later terminal IPC.
                  // Persist the exact completed attempt first; the worker's
                  // ordered duplicate terminal remains idempotent.
                  await cb.onTurnTerminal?.(ds, {
                    type: 'turn_terminal',
                    sessionId: ds.session.sessionId,
                    turnId: msg.turnId,
                    dispatchAttempt: msg.dispatchAttempt,
                    status: 'completed',
                  }, { workerGeneration });
                } catch (err) {
                  logger.error(`[${t}] Failed to persist Codex App settlement terminal: ${err instanceof Error ? err.message : String(err)}`);
                  return false;
                }
              }
              const priorLedger = ds.session.codexAppDispatchLedger;
              const priorCommits = ds.session.codexAppGenerationCommits;
              ds.session.codexAppDispatchLedger = committed.ledger;
              ds.session.codexAppGenerationCommits = committed.commits;
              try {
                // One atomic sessions-file replacement owns both the exact FIFO
                // pop and cumulative runner ACK boundary. Only after this write
                // may the worker acknowledge final-end to the runner.
                sessionStore.updateSession(ds.session);
                return true;
              } catch (err) {
                ds.session.codexAppDispatchLedger = priorLedger;
                ds.session.codexAppGenerationCommits = priorCommits;
                logger.error(`[${t}] Failed to persist Codex App final settlement: ${err instanceof Error ? err.message : String(err)}`);
                return false;
              }
            })().finally(() => codexAppFinalSettlementInFlight.delete(key));
            codexAppFinalSettlementInFlight.set(key, inFlight);
          }
          const persisted = await inFlight;
          acknowledge(persisted, persisted ? undefined : 'final_settlement_failed');
          if (persisted && !hasUnsettledCodexAppDispatch(ds.session.codexAppDispatchLedger)) {
            try { await cb.onCodexAppLedgerDrained?.(ds); }
            catch (err) { logger.error(`[${t}] post-drain cleanup failed: ${err instanceof Error ? err.message : String(err)}`); }
          }
          break;
        }

        // Adopt-bridge: worker harvested the assistant turn from Claude Code's
        // transcript JSONL and forwarded it to us. Dedup with a session-scoped
        // key so a re-drain can't re-send the same answer or cross-suppress
        // another session.
        if (!msg.content || !msg.content.trim()) break;
        if (shouldDropMismatchedFinalOutput(ds, msg, t)) break;
        if (shouldDropMismatchedHermesFinalOutput(ds, msg, t)) break;
        if (managedFinalOutputSuppressed(msg.turnId, msg.dispatchAttempt)) {
          logger.debug(`[${t}] final_output captured/discarded for silent turn ${msg.turnId.substring(0, 8)}`);
          break;
        }
        if (!msg.sessionId) {
          logger.warn(`[${t}] final_output missing sessionId; accepting for compatibility (session=${ds.session.sessionId}, turn=${msg.turnId.substring(0, 8)})`);
        }
        const dedupeKey = finalOutputDedupeKey(ds, msg);
        if (ds.lastBridgeEmittedUuid === dedupeKey) {
          logger.debug(`[${t}] final_output deduped (key ${dedupeKey.substring(0, 48)})`);
          break;
        }
        // Worker pops the turn off its queue right after emit, so it will
        // NOT re-send this payload on its own. Daemon owns retry on
        // transient Lark failures.
        // A real harvested answer is a definitive self-heal signal: if the
        // session was parked in `limited` by a structured rate-limit emit
        // (Claude adopt/bridge sessions where the user recovers in their own
        // terminal — no Lark turn, retry button, or kill to clear it), the
        // model is plainly working again. Clear the stale limit so the card /
        // Dashboard「需要你」 don't stay pinned with a dead retry countdown.
        if (ds.usageLimit) {
          clearUsageLimitState(ds);
          if (ds.lastScreenStatus === 'limited') ds.lastScreenStatus = 'idle';
        }
        if (msg.turnId.startsWith('mlrp_turn_')) {
          markMessageListenerRunPreviewRunning(msg.turnId);
        }
        deliverFinalOutput(
          ds,
          msg,
          t,
          0,
          undefined,
          ownsLifecycleMutation,
        );
        break;
      }

      case 'adopt_preamble': {
        // Adopt-bridge: surface the last completed user/assistant exchange
        // from the adopted CLI session so the Lark thread has context to
        // continue from. Best-effort — failure here just means the user
        // won't see the preamble; adopt itself isn't blocked. Card chrome
        // matches the regular markdown-card path (schema 2.0 + footer) so
        // the assistant body renders with proper code blocks / tables /
        // lists instead of arriving as a wall of plain text.
        if (!ds.adoptedFrom) {
          logger.warn(`[${t}] Ignored adopt_preamble from non-adopt worker`);
          break;
        }
        if (managedAuxUiSuppressed(msg.turnId)) break;
        if (!msg.userText.trim() && !msg.assistantText.trim()) break;
        const recipientOpenId = daemonCardFooterRecipientOpenId(ds, effectiveCliId);
        const cardJson = buildContextualReplyCard({
          title: tr('card.adopt_last_round', undefined, localeForBot(ds.larkAppId)),
          userText: msg.userText,
          assistantText: msg.assistantText,
          assistantLabel: sessionCliDisplayName(ds, botCfg),
          recipientOpenId,
          brand: renderBrandTemplate(resolveBrandLabel(ds.larkAppId), ds.workingDir),
          locale: localeForBot(ds.larkAppId),
          workingDir: ds.workingDir,
          localHomeLinkMode: daemonCardLocalHomeLinkMode(ds),
          usage: getDaemonReplyCardUsageSnapshot(ds, effectiveCliId),
        });
        scopedReply(cardJson, 'interactive', msg.turnId).catch((err: any) => {
          logger.warn(`[${t}] Failed to deliver adopt_preamble to Lark: ${err.message}`);
        });
        break;
      }
    }
  });

  worker.on('exit', (code, signal) => {
    abandonOrdinaryImDeliveriesForWorker(worker);
    const transferRetirement = transferRetiringWorkers.has(worker);
    transferRetiringWorkers.delete(worker);
    clearLifecycleRetirement(ds, worker);
    logger.info(`[${t}] Worker process exited (code: ${code})`);
    // Last-resort startup guard: syntax/import crashes and abrupt exits can
    // happen before the worker sends either ready or a structured error.  Do
    // not leave the originating Lark message unanswered. Intentional close /
    // replacement kills are excluded to avoid noisy false alarms.
    if (!transferRetirement && !startupState.ready && !startupState.failureNotified && !worker.killed && ds.session.status !== 'closed') {
      const reason = tr('worker.start_exited_early', { code: code ?? 'null' }, loc);
      // Carry the frozen init attribution so an abrupt pre-ready exit of a
      // durable VC delivery is fenced to the receipt/lease chain, not replied
      // out-of-band (which could post on a silent delivery).
      void notifyStartupFailure(reason, startupState.initTurnId, startupState.initDispatchAttempt);
    }
    // Clear the current child before notifying durable consumers. A callback
    // may schedule a retry; it must not observe/send to this dead IPC channel.
    // A stale takeover worker never clears the replacement — during takeover the
    // old worker's exit fires AFTER the new worker has been assigned.
    if (ds.worker === worker) {
      restartCoordinator.failSession(ds.session.sessionId);
      if (ds.session.queuedActivationPending) {
        // Journal ownership is backend-independent. The next worker replays
        // this exact head with queuedActivationResume before durable tail N+1.
        ds.initialStartPending = false;
        ds.initialStartClaimToken = undefined;
      } else {
        reparkQueuedActivationFollowUpTail(ds, 'worker exit during activation follow-up handoff');
      }
      ds.worker = null;
      ds.workerReady = false;
      ds.workerPort = null;
      // Dead worker generation — stop the periodic usage refresh immediately
      // instead of waiting a tick for it to self-clear on !workerHasInitialized.
      clearUsageRefreshTimer(ds);
      ds.managedTurnOrigin = undefined;
      // This worker generation is gone. Invalidate any stuck-warning card it
      // posted so a late click cannot inject keys into a replacement worker.
      invalidateStuckWarning(ds, 'worker_exit');
      invalidateTuiPrompt(ds, 'worker_exit');
      // Fence this lifetime before a polling dispatcher can observe its last
      // ACK. Keeping the old receipt is useful audit evidence, but the
      // persisted current generation advances immediately so it cannot count
      // as acceptance after the worker has died. A stale takeover worker never
      // enters this branch and therefore cannot fence the replacement.
      const fencedGeneration = Math.max(
        workerGeneration,
        ds.workerGeneration ?? 0,
        ds.session.workerGeneration ?? 0,
      ) + 1;
      ds.workerGeneration = fencedGeneration;
      ds.session.workerGeneration = fencedGeneration;
      ds.session.pid = undefined;
      sessionStore.updateSession(ds.session);
    }
    if (!transferRetirement) {
      try {
        const notified = cb.onWorkerExit?.(ds, {
          sessionId: ds.session.sessionId,
          workerGeneration,
          code,
          signal,
        });
        void Promise.resolve(notified).catch((err: any) => {
          logger.error(`[${t}] Failed to reconcile worker exit generation ${workerGeneration}: ${err.message}`);
        });
      } catch (err: any) {
        logger.error(`[${t}] Failed to reconcile worker exit generation ${workerGeneration}: ${err.message}`);
      }
    } else {
      logger.info(`[${t}] Suppressed external worker-exit effects for routing transfer`);
    }
    // Notify dashboard, but only once per session lifecycle. The
    // dashboard-driven `closeSession()` path also publishes; whichever
    // fires first wins, the other's emit is suppressed.
    if (!transferRetirement && !ds.exitEventEmitted) {
      ds.exitEventEmitted = true;
      dashboardEventBus.publish({
        type: 'session.exited',
        body: {
          sessionId: ds.session.sessionId,
          reason: code === 0 ? 'graceful' : `exit_code_${code}`,
        },
      });
      emitSessionLifecycleHook(ds, 'session.exit', {
        reason: code === 0 ? 'graceful' : `exit_code_${code}`,
        code,
      });
    }
  });
}

// ─── Bridge final-output delivery (with retry) ──────────────────────────────

const FINAL_OUTPUT_RETRY_BACKOFF_MS = [0, 5000, 15000];  // immediate, +5s, +15s
const codexAppFinalSettlementInFlight = new Map<string, Promise<boolean>>();

function finalOutputDedupeKey(ds: DaemonSession, msg: Extract<WorkerToDaemon, { type: 'final_output' }>): string {
  return `${msg.sessionId ?? ds.session.sessionId}:${msg.lastUuid || msg.turnId}`;
}

function shouldDropMismatchedFinalOutput(
  ds: DaemonSession,
  msg: Extract<WorkerToDaemon, { type: 'final_output' }>,
  t: string,
): boolean {
  if (!msg.sessionId || msg.sessionId === ds.session.sessionId) return false;
  logger.error(
    `[${t}] Dropped final_output with mismatched sessionId ` +
    `(msg=${msg.sessionId}, session=${ds.session.sessionId}, turn=${msg.turnId.substring(0, 8)})`,
  );
  return true;
}

function shouldDropMismatchedHermesFinalOutput(
  ds: DaemonSession,
  msg: Extract<WorkerToDaemon, { type: 'final_output' }>,
  t: string,
): boolean {
  if (ds.session.cliId !== 'hermes') return false;
  const sourceSessionIds = ds.hermesBridgeSourceSessionIds;
  const hasBoundSource = !!sourceSessionIds && sourceSessionIds.size > 0;
  if (!msg.sourceHermesSessionId) {
    if (!hasBoundSource) return false;
    logger.error(
      `[${t}] Dropped Hermes final_output without sourceHermesSessionId ` +
      `(expected one of ${sourceSessionIds!.size} bound sources, session=${ds.session.sessionId}, turn=${msg.turnId.substring(0, 8)})`,
    );
    return true;
  }
  if (sourceSessionIds?.has(msg.sourceHermesSessionId)) return false;
  logger.error(
    `[${t}] Dropped Hermes final_output with mismatched sourceHermesSessionId ` +
    `(msg=${msg.sourceHermesSessionId}, expected one of ${sourceSessionIds?.size ?? 0} bound sources, ` +
    `session=${ds.session.sessionId}, turn=${msg.turnId.substring(0, 8)})`,
  );
  return true;
}

/**
 * Turn-end half of the two-phase turn reactions (auto-on for card-off sessions,
 * i.e. streaming card disabled). The 冲! "received" reactions are added per-message at the daemon
 * acceptance point (`noteTurnReceived`); the screen_update handler calls this
 * only on working|analyzing → idle|limited (not cold-start starting→idle), to
 * flip every pending ✋ on this session to ✅ DONE and clear the list. When
 * silentTurnReactions is enabled after a ✋ has already landed, we only remove
 * that received reaction and do not add DONE. Binding the start to the message
 * (not a status edge) means type-ahead / busy-batched messages each get their
 * own reaction and all settle together here.
 *
 * Every Feishu call is best-effort — a failure only means a missing emoji, so it
 * must never throw into the status pipeline (callers invoke as `void`).
 */
async function finishTurnReactions(ds: DaemonSession): Promise<void> {
  const list = ds.pendingAckReactions;
  if (!list || list.length === 0) return;
  // Detach the batch first so a second idle edge can't double-flip it.
  ds.pendingAckReactions = [];
  // A dedicated receiver has no progress-reaction channel. Clear any stale
  // in-memory entries restored from an older build without touching Lark.
  if (ds.session.vcMeetingReceiver) return;
  const silent = silentTurnReactions(ds);
  const doneEmoji = doneReactionEmojiFor(ds);
  for (const ack of list) {
    if (ack.reactionId) {
      try {
        await removeReaction(ds.larkAppId, ack.messageId, ack.reactionId);
      } catch (err: any) {
        logger.debug(`[reaction] failed to remove received reaction ${ack.reactionId}: ${err?.message ?? err}`);
      }
    }
    if (silent) continue;
    try {
      await addReaction(ds.larkAppId, ack.messageId, doneEmoji);
    } catch (err: any) {
      logger.debug(`[reaction] failed to add done reaction to ${ack.messageId}: ${err?.message ?? err}`);
    }
  }
}

/** Deliver a bridge `final_output` to Lark. The current worker generation pops
 *  the turn at emit time, while replacement recovery may replay it with the
 *  same provider key; the daemon owns bounded transient retries. After 3 attempts we log
 *  and give up — the user's answer is lost; better than leaking memory
 *  via an unbounded retry loop. */
function deliverFinalOutput(
  ds: DaemonSession,
  msg: Extract<WorkerToDaemon, { type: 'final_output' }>,
  t: string,
  attempt: number,
  onComplete?: (owned: boolean) => void,
  isStillOwned: () => boolean = () => true,
  frozenReplyTarget?: FrozenSessionReplyTarget,
  frozenUsage?: CardUsageSnapshot,
): void {
  if (!isStillOwned()) {
    onComplete?.(false);
    return;
  }
  let cardUsage = frozenUsage;
  const managedReceiver = !!ds.session.vcMeetingReceiver;
  // Wait Mode / HTTP Sync Override:
  // If this turn is being waited for by an HTTP webhook request, intercept the
  // output, resolve the Promise immediately, and DO NOT send it to Lark.
  // Dedicated receivers are structurally pinned to their audited listener
  // action and may never be diverted into these generic host-side sinks.
  const waitPromise = managedReceiver ? undefined : ds.pendingWaitPromises?.get(msg.turnId);
  if (waitPromise) {
    waitPromise.resolve(msg.content);
    ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
    logger.info(`[${t}] Intercepted final_output for Wait Mode HTTP request (turn ${msg.turnId.substring(0, 8)})`);
    onComplete?.(true);
    return;
  }

  const asyncResult = managedReceiver ? undefined : ds.asyncTriggerResults?.get(msg.turnId);
  if (asyncResult) {
    const completedAt = Date.now();
    asyncResult.status = 'completed';
    asyncResult.content = msg.content;
    asyncResult.completedAt = completedAt;
    if (msg.usage) asyncResult.usage = msg.usage;
    // Durably persist the outcome so trigger-result can rebuild `completed`
    // (with content + usage) after a daemon restart drops the in-memory Map.
    // Stamp the owning bot for cross-bot isolation.
    asyncTriggerStore.recordCompleted(ds.session.sessionId, msg.turnId, msg.content, completedAt, ds.larkAppId, msg.usage);
    // This idempotent async turn produced its terminal output — clear the
    // worker-exit convergence stamp so a later graceful exit of this generation
    // is not retro-failed (codex #776 round-6 finding #1).
    if (ds.idempotentAsyncTurn?.triggerId === msg.turnId) ds.idempotentAsyncTurn = undefined;
    ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
    logger.info(`[${t}] Captured final_output for Async HTTP request (turn ${msg.turnId.substring(0, 8)})`);
    onComplete?.(true);
    return;
  }
  const cb = requireCallbacks();
  const effectiveCliId = ds.session.cliId ?? getBot(ds.larkAppId).config.cliId;
  const scopedReply = (
    content: string,
    msgType?: string,
    turnId?: string,
    opts?: Omit<WorkerSessionReplyOptions, 'sourceSessionId'>,
  ) => cb.sessionReply(
    sessionAnchorId(ds),
    content,
    msgType,
    ds.larkAppId,
    fallbackTurnId(ds, turnId),
    ds.session.vcMeetingReceiver
      ? { ...opts, sourceSessionId: ds.session.sessionId }
      : opts,
  );
  setTimeout(async () => {
    if (!isStillOwned()) {
      logger.info(`[${t}] Bridge final_output abandoned — worker/session ownership changed`);
      onComplete?.(false);
      return;
    }
    // Guard: if the user closed the session (or it was torn down for any
    // other reason) between attempts, don't post a stale final answer to
    // a closed thread.
    if (ds.session.status === 'closed') {
      logger.info(`[${t}] Bridge final_output abandoned — session closed (turn ${msg.turnId.substring(0, 8)})`);
      onComplete?.(true);
      return;
    }
    try {
      // 文档评论入口分流：本轮若来自飞书文档评论（/watch-comment / /subscribe-lark-doc），把正文
      // 发表为文档评论（而非飞书卡片），状态卡/占位卡仍留在飞书会话起点。
      const docTurn = managedReceiver ? undefined : resolveDocCommentTarget(ds, msg.turnId);
      if (docTurn) {
        // 嵌套回复到用户那条评论 thread（已挂在其下，无需再 ↪ 前缀）。这是兜底路径
        // （模型没显式 botmux send），默认 @ 回原评论人，仅首块加。
        const chunks = chunkCommentText(msg.content);
        for (let i = 0; i < chunks.length; i++) {
          if (!isStillOwned()) { onComplete?.(false); return; }
          await replyToDocComment(ds.larkAppId, { fileToken: docTurn.fileToken, fileType: docTurn.fileType }, docTurn.commentId, chunks[i], i === 0 ? docTurn.replyToOpenId : undefined);
          if (!isStillOwned()) { onComplete?.(false); return; }
        }
        // The user-visible reply is committed. Consume the route and dedupe
        // marker BEFORE best-effort reaction cleanup: a missing/expired
        // reaction must never retry and duplicate the document comment.
        consumeDocCommentTurn(ds, msg.turnId);
        ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
        if (docTurn.reactionId && docTurn.replyId) {
          try {
            await removeCommentReaction(ds.larkAppId,
              { fileToken: docTurn.fileToken, fileType: docTurn.fileType },
              docTurn.commentId, docTurn.replyId, docTurn.reactionId);
          } catch (err: any) {
            logger.debug(
              `[doc-comment] failed to remove completed reaction ${docTurn.reactionId}: ${err?.message ?? err}`,
            );
          }
        }
        logger.info(`[${t}] doc-comment final_output → posted ${chunks.length} comment(s) on file=${docTurn.fileToken.slice(0, 12)} (turn ${msg.turnId.substring(0, 8)})`);
        onComplete?.(true);
        return;
      }

      // A doc-native session has a virtual `doc:<token>` chat anchor, not a
      // Feishu chat/thread. If its per-turn target is missing or corrupt there
      // is no safe fallback destination; suppress instead of trying to post an
      // interactive card to the virtual id.
      if (isDocNativeSession(ds)) {
        ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
        logger.error(
          `[${t}] Suppressed doc-native final_output without comment target ` +
          `(turn ${msg.turnId.substring(0, 8)})`,
        );
        onComplete?.(true);
        return;
      }

      // Wrap the model's reply in the same card chrome `botmux send` uses
      // (schema 2.0 + footer with botmux link + 发送给 owner) so a turn
      // delivered via this fallback path looks identical in the Lark thread
      // to one the model sent itself. Markdown rendering, tables, code
      // blocks all flow through the shared `buildCardBodyElements`.
      //
      // Local-turn variants (kind = 'local-turn' / 'local-turn-headless')
      // also surface the user-side prompt synced from the adopted pane;
      // they use the contextual card so the user prompt sits in a
      // blockquote and only the assistant body goes through full markdown
      // rendering.
      const imOrigin = msg.dispatchAttempt === undefined
        ? resolveVcMeetingImTurnOrigin(ds.session, msg.turnId)
        : undefined;
      const managedDecision = ds.session.vcMeetingReceiver
        ? evaluateVcMeetingManagedSend(config.session.dataDir, {
            receiverSessionId: ds.session.sessionId,
            receiverSession: true,
            turnId: msg.turnId,
            dispatchAttempt: msg.dispatchAttempt,
            currentImTurnOrigin: imOrigin,
            allowTerminalReceipt: true,
          })
        : undefined;
      if (managedDecision && !managedDecision.ok) {
        ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
        logger.warn(
          `[${t}] VC final_output lost current membership authority `
          + `(${managedDecision.errorCode}) turn=${msg.turnId.substring(0, 8)}`,
        );
        onComplete?.(true);
        return;
      }
      const revalidateManagedSend = (): void => {
        if (!ds.session.vcMeetingReceiver) return;
        const current = evaluateVcMeetingManagedSend(config.session.dataDir, {
          receiverSessionId: ds.session.sessionId,
          receiverSession: true,
          turnId: msg.turnId,
          dispatchAttempt: msg.dispatchAttempt,
          currentImTurnOrigin: imOrigin,
          allowTerminalReceipt: true,
        });
        if (!current.ok) {
          throw new Error(
            `VC final_output authority expired (${current.errorCode}): ${current.error}`,
          );
        }
        if (current.kind !== 'listener_thread') {
          throw new Error('VC final_output authority no longer targets the listener thread');
        }
      };
      const listenerOutputOwner = managedDecision?.ok
        && managedDecision.kind === 'listener_thread'
        ? managedDecision.meetingOwner
        : undefined;
      const listenerOutputPlacement = managedDecision?.ok
        && managedDecision.kind === 'listener_thread'
        ? managedDecision.outputPlacement
        : 'auto';
      const listenerOutputProtocol = managedDecision?.ok
        && managedDecision.kind === 'listener_thread'
        ? managedDecision.listenerOutputProtocol
        : 'plain';
      const meetingTopicKey: VcMeetingListenerTopicKey | undefined = !imOrigin
        && listenerOutputOwner
        && listenerOutputPlacement === 'topic'
        ? {
            ...listenerOutputOwner,
            targetChatId: ds.chatId,
          }
        : undefined;
      let visibleAssistantText = msg.content;
      if (!imOrigin
        && listenerOutputOwner
        && msg.dispatchAttempt !== undefined
        && listenerOutputProtocol === 'decision_v1') {
        const controlledOutput = parseVcMeetingListenerOutput(msg.content);
        if (!controlledOutput.ok) {
          ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
          logger.error(
            `[${t}] VC listener output suppressed: invalid control envelope `
            + `(${controlledOutput.reason}) turn=${msg.turnId.substring(0, 8)}`,
          );
          return;
        }
        if (controlledOutput.decision === 'skip') {
          ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
          logger.info(
            `[${t}] VC listener output skipped by agent decision `
            + `(turn ${msg.turnId.substring(0, 8)})`,
          );
          return;
        }
        visibleAssistantText = controlledOutput.content;
      }
      // Meeting-derived text is untrusted card markdown. A model-authored
      // native <at> tag and the ordinary owner footer would both create a
      // second addressing side effect outside the action ledger.
      const safeAssistantText = managedReceiver
        ? neutralizeLarkAtTags(visibleAssistantText)
        : visibleAssistantText;
      const safeUserText = managedReceiver && msg.userText !== undefined
        ? neutralizeLarkAtTags(msg.userText)
        : msg.userText;
      const recipientOpenId = managedReceiver
        ? undefined
        : imOrigin?.replyTargetSenderOpenId
          ?? daemonCardFooterRecipientOpenId(ds, effectiveCliId);
      const localHomeLinkMode = daemonCardLocalHomeLinkMode(ds);
      cardUsage ??= getDaemonReplyCardUsageSnapshot(ds, effectiveCliId);
      const cardJson = msg.kind === 'local-turn' || msg.kind === 'local-turn-headless'
        ? buildContextualReplyCard({
            title: msg.kind === 'local-turn-headless'
              ? tr('card.local_turn_resumed', undefined, localeForBot(ds.larkAppId))
              : tr('card.local_turn', undefined, localeForBot(ds.larkAppId)),
            userText: msg.kind === 'local-turn' ? safeUserText ?? '' : undefined,
            assistantText: safeAssistantText,
            assistantLabel: storedSessionCliDisplayName(ds),
            recipientOpenId,
            brand: renderBrandTemplate(resolveBrandLabel(ds.larkAppId), ds.workingDir),
            locale: localeForBot(ds.larkAppId),
            workingDir: ds.workingDir,
            localHomeLinkMode,
            usage: cardUsage,
          })
        : buildMarkdownCard(
            safeAssistantText,
            recipientOpenId,
            renderBrandTemplate(resolveBrandLabel(ds.larkAppId), ds.workingDir),
            localeForBot(ds.larkAppId),
            ds.workingDir,
            localHomeLinkMode,
            cardUsage,
          );

      const proposedOutput = {
        targetChatId: ds.chatId,
        ...(imOrigin ? { quoteTargetId: imOrigin.larkMessageId } : {}),
        ...(!imOrigin && listenerOutputOwner
          ? { placement: listenerOutputPlacement }
          : {}),
        msgType: 'interactive',
        content: cardJson,
      };
      const preparedImReply = imOrigin
        ? prepareVcMeetingImReply(config.session.dataDir, imOrigin, proposedOutput)
        : undefined;
      const preparedDeliveryReply = !imOrigin
        && listenerOutputOwner
        && msg.dispatchAttempt !== undefined
        ? prepareVcMeetingDeliveryReply(config.session.dataDir, {
            receiverSessionId: ds.session.sessionId,
            stableTurnId: msg.turnId,
            dispatchAttempt: msg.dispatchAttempt,
          }, proposedOutput)
        : undefined;
      const preparedListenerReply = preparedImReply ?? preparedDeliveryReply;
      // Codex App final settlement is delivery-before-commit. If the daemon
      // dies after Lark accepts the reply but before the FIFO/sequence commit,
      // the replacement must retry with the same provider key. Keep the key
      // dispatch-stable (not generation/seq-stable), so the user-visible Lark
      // message is idempotent across crash reconciliation. The existing
      // outbound-hook contract remains unchanged; it is a separate best-effort
      // side effect and is not covered by the provider UUID.
      const codexAppSettlementReply = msg.codexAppSettlement
        ? {
            uuid: `ca_${msg.codexAppSettlement.dispatchId}`.slice(0, 50),
          }
        : undefined;
      if (preparedListenerReply?.kind === 'conflict') {
        ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
        logger.error(
          `[${t}] VC listener fallback suppressed (${preparedListenerReply.reason}) `
          + `turn=${msg.turnId.substring(0, 8)}: ${preparedListenerReply.detail}`,
        );
        onComplete?.(true);
        return;
      }
      const canonicalOutput = preparedListenerReply?.canonicalOutput ?? proposedOutput;
      if (preparedListenerReply?.outputMismatch) {
        logger.warn(
          `[${t}] VC listener reply output_mismatch action=${preparedListenerReply.ref.actionId} `
          + `turn=${msg.turnId}; reusing first canonical output`,
        );
      }
      const recordPrimaryOutput = (messageId: string): void => {
        if (!listenerOutputOwner) return;
        if (meetingTopicKey
          && !getVcMeetingListenerTopicRoot(config.session.dataDir, meetingTopicKey)) {
          const topic = recordVcMeetingListenerTopicRoot(
            config.session.dataDir,
            meetingTopicKey,
            messageId,
          );
          if (!topic.ok) {
            logger.error(
              `[${t}] VC listener topic anchor rejected message=${messageId} reason=${topic.reason}`,
            );
          }
        }
        try {
          const recorded = recordVcMeetingListenerMessage(config.session.dataDir, {
            ...listenerOutputOwner,
            targetChatId: canonicalOutput.targetChatId,
            messageId,
          });
          if (!recorded.ok) {
            logger.warn(
              `[${t}] VC listener-message index rejected message=${messageId} reason=${recorded.reason}`,
            );
          }
        } catch (error) {
          // Lark already accepted the primary message. Never enter the delivery
          // retry loop solely because the auxiliary quote index failed.
          logger.error(
            `[${t}] VC listener-message index write failed after send: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      if (preparedListenerReply?.kind === 'succeeded' && preparedListenerReply.messageId) {
        recordPrimaryOutput(preparedListenerReply.messageId);
        ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
        logger.info(
          `[${t}] VC listener fallback replayed existing provider result `
          + `(turn ${msg.turnId.substring(0, 8)})`,
        );
        onComplete?.(true);
        return;
      }

      // Always deliver the answer as a fresh message — never PATCH a card in
      // place. message.patch is silent (no Feishu notification / unread), which
      // used to swallow the answer; a brand-new message always pings.
      revalidateManagedSend();
      if (!isStillOwned()) {
        onComplete?.(false);
        return;
      }
      const deliveryReplyOptions = preparedListenerReply
        ? {
            uuid: preparedListenerReply.providerKey,
            quoteMessageId: canonicalOutput.quoteTargetId,
            beforeQuoteFallback: revalidateManagedSend,
            // Managed output has one audited external effect (the Lark
            // provider call). Never fan meeting content out to user hooks,
            // including the first attempt and crash reconciliation replay.
            suppressHook: true,
            ...(!imOrigin && listenerOutputOwner
              ? {
                  placement: canonicalOutput.placement ?? 'auto',
                  ...(meetingTopicKey ? { meetingTopicKey } : {}),
                }
              : {}),
          }
        : codexAppSettlementReply;
      const messageId = await scopedReply(
        canonicalOutput.content,
        canonicalOutput.msgType,
        msg.replyTurnId ?? msg.turnId,
        frozenReplyTarget && !managedReceiver
          ? { ...deliveryReplyOptions, replyTarget: frozenReplyTarget }
          : deliveryReplyOptions,
      );
      if (!isStillOwned()) { onComplete?.(true); return; }
      recordPrimaryOutput(messageId);
      if (msg.turnId.startsWith('mlrp_turn_')) {
        markMessageListenerRunPreviewReplied(msg.turnId, {
          sessionId: ds.session.sessionId,
          replyMessageId: messageId,
        });
      }
      if (preparedListenerReply?.kind === 'send' || preparedListenerReply?.kind === 'succeeded') {
        finishVcMeetingImReply(config.session.dataDir, preparedListenerReply.ref, messageId);
      }
      ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
      logger.info(`[${t}] Bridge final_output forwarded (turn ${msg.turnId.substring(0, 8)}, ${msg.content.length} chars, kind=${msg.kind ?? 'bridge'}, attempt ${attempt + 1})`);
      onComplete?.(true);
    } catch (err: any) {
      if (!isStillOwned()) { onComplete?.(false); return; }
      if (err instanceof MessageWithdrawnError) {
        // Withdrawal is permanent for this target, but it is not explicit
        // abandon. Keep an unsettled FIFO owner recoverable; only ledger-empty
        // sessions may commit the dedupe marker and auto-close.
        if (await closeWithdrawnSessionIfLedgerEmpty(
          ds,
          'Root message withdrawn while forwarding final_output',
        )) {
          ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
          onComplete?.(true);
        } else {
          onComplete?.(false);
        }
        return;
      }
      const next = attempt + 1;
      if (next >= FINAL_OUTPUT_RETRY_BACKOFF_MS.length) {
        logger.error(`[${t}] Bridge final_output gave up after ${next} attempts (turn ${msg.turnId.substring(0, 8)}): ${err.message}`);
        if (msg.turnId.startsWith('mlrp_turn_')) {
          markMessageListenerRunPreviewFailed(msg.turnId, {
            sessionId: ds.session.sessionId,
            error: err.message,
          });
        }
        // Don't commit the dedup marker — leave room for any future
        // retransmit (e.g. daemon restart that re-fires the IPC).
        onComplete?.(false);
        return;
      }
      logger.warn(`[${t}] Bridge final_output attempt ${next} failed (${err.message}); retrying in ${FINAL_OUTPUT_RETRY_BACKOFF_MS[next]}ms`);
      deliverFinalOutput(ds, msg, t, next, onComplete, isStillOwned, frozenReplyTarget, cardUsage);
    }
  }, FINAL_OUTPUT_RETRY_BACKOFF_MS[attempt] ?? 0);
}


/** Test-only alias so the retry pipeline can be exercised without a real
 *  fork. Intentionally underscored to discourage non-test callers. */
export const __testOnly_deliverFinalOutput = deliverFinalOutput;
export const __testOnly_setupWorkerHandlers = setupWorkerHandlers;
export const __testOnly_reserveWorkerGeneration = reserveWorkerGeneration;
export const __testOnly_finishTurnReactions = finishTurnReactions;
export const __testOnly_finalOutputDedupeKey = finalOutputDedupeKey;

// ─── Fork adopt worker ──────────────────────────────────────────────────────

function reserveWorkerGeneration(ds: DaemonSession): number {
  const previousDaemonGeneration = ds.workerGeneration;
  const previousSessionGeneration = ds.session.workerGeneration;
  const workerGeneration = Math.max(
    previousDaemonGeneration ?? 0,
    previousSessionGeneration ?? 0,
  ) + 1;
  ds.workerGeneration = workerGeneration;
  ds.session.workerGeneration = workerGeneration;
  try {
    sessionStore.updateSession(ds.session);
  } catch (error) {
    if (previousDaemonGeneration === undefined) delete ds.workerGeneration;
    else ds.workerGeneration = previousDaemonGeneration;
    if (previousSessionGeneration === undefined) delete ds.session.workerGeneration;
    else ds.session.workerGeneration = previousSessionGeneration;
    throw error;
  }
  // Reservation is the first durable proof that the previous generation has
  // lost authority. Clear its TUI slot before any environment check, adapter
  // creation, or fork can throw and strand a clicked card in "processing".
  invalidateTuiPrompt(ds, 'reserve_worker_generation');
  return workerGeneration;
}

/**
 * Is the file sandbox active such that /adopt must be refused? A sandbox can
 * only be established at spawn time (bwrap wrap / Seatbelt profile); adopt
 * attaches to an ALREADY-running host process, so it could only ever run
 * UNsandboxed. From-strict UNION of every source that can require isolation:
 *  - live per-bot `sandbox` / legacy `readIsolation`,
 *  - the global `BOTMUX_SANDBOX=1` (sandboxEnabled()),
 *  - the session's FROZEN sandbox decision (`session.sandbox`, recorded at
 *    creation). forkWorker treats the frozen decision as authoritative, so a
 *    session created sandboxed must stay un-adoptable even if the admin later
 *    toggles the bot's global flag OFF — otherwise its `/adopt` would attach to
 *    an unsandboxed live process. The reverse (bot=true / session=false) is
 *    also caught by the union, which is the safe direction.
 * Callers reject at the ENTRY point (before persisting `adoptedFrom` / replying
 * "adopted") — see command-handler's `/adopt`, the adopt_select card, and the
 * session-manager restore branch. Resume/cold-start is unaffected: those spawn
 * a fresh CLI, which the sandbox wraps normally.
 */
export function adoptSandboxBlocked(
  botCfg: { sandbox?: boolean; readIsolation?: boolean; apiOnly?: boolean },
  session?: { sandbox?: boolean; chatId?: string },
): boolean {
  return botCfg.sandbox === true
    || botCfg.readIsolation === true
    // A core-only (apiOnly) bot — or a session on a synthetic HTTP virtual chat —
    // must NOT adopt-observe a pre-existing external CLI: that CLI runs fully
    // unisolated (the adopt observe branch returns before any fs-policy build),
    // so it could read this host's bots.json / sibling creds on behalf of a
    // no-transport turn. Convert to cold-start instead (same as sandbox adopt).
    || botCfg.apiOnly === true
    || (typeof session?.chatId === 'string'
        && (session.chatId.startsWith('http_async_') || session.chatId.startsWith('http_wait_')))
    || session?.sandbox === true
    || sandboxEnabled();
}

export function forkAdoptWorker(ds: DaemonSession, opts?: { restoredFromMetadata?: boolean; prompt?: string; turnId?: string }): void {
  if (isSessionTransferring(ds)) {
    logger.warn(`[${tag(ds)}] Adopt worker fork refused during routing transfer`);
    return;
  }
  if (!canForkRegisteredSession(ds)) return;
  ds.workerReady = false;
  const cb = requireCallbacks();
  const workerPath = join(__dirname, '..', 'worker.js');
  const t = tag(ds);
  const adopted = ds.adoptedFrom;
  if (!adopted) throw new Error('forkAdoptWorker called without adoptedFrom');

  const bot = getBot(ds.larkAppId);
  const botCfg = bot.config;
  const agentCfg = sessionAgentConfig(ds, botCfg);

  // A file sandbox cannot be applied to an already-running CLI: adopt ATTACHES
  // to an existing host pane/process, and confinement (bwrap wrap on Linux /
  // Seatbelt profile on macOS) can only be established at spawn time — there is
  // no way to retro-fit a sandbox around a live process. Refuse to adopt when
  // the sandbox is active (live bot flag OR the session's FROZEN decision)
  // rather than run it UNsandboxed. Real adopt entry points (`/adopt`, the
  // adopt_select card) reject BEFORE persisting `adoptedFrom`, and the
  // session-manager restore branch converts a sandbox adopt to a cold-start
  // before it ever reaches here; this is the last-line fail-closed backstop,
  // which also strips any stale adopt metadata it is handed.
  if (adoptSandboxBlocked(botCfg, ds.session)) {
    logger.warn(`[${t}] sandbox-enabled session: refusing to adopt existing CLI (would run unsandboxed)`);
    // Strip stale adopt state so the session doesn't linger as a worker=null
    // pseudo-adopt whose NEXT message
    // would still be routed as a bridge/adopt session. It cold-starts sandboxed
    // via the normal resume path instead.
    ds.adoptedFrom = undefined;
    if (ds.session.adoptedFrom) {
      ds.session.adoptedFrom = undefined;
      try { sessionStore.updateSession(ds.session); } catch { /* best-effort */ }
    }
    return;
  }

  // Reserve before replacing an existing bridge worker for the same reason as
  // forkWorker: persistence failure must leave the old lifetime untouched.
  const workerGeneration = reserveWorkerGeneration(ds);

  // Guard against double-fork
  if (ds.worker && !ds.worker.killed) {
    const replacedWorker = ds.worker;
    logger.warn(`[${t}] Worker already running, killing before adopt-fork`);
    trackLifecycleRetirement(ds, replacedWorker);
    try { replacedWorker.send({ type: 'close' } as DaemonToWorker); } catch {}
    try { replacedWorker.kill(); } catch {}
    ds.worker = null;
    ds.workerReady = false;
    ds.workerPort = null;
    ds.workerToken = null;
    ds.workerViewToken = null;
    ds.managedTurnOrigin = undefined;
  }

  // No ensureCliSkills — adopt mode attaches to an existing CLI session

  // Fall back to home if the adopted cwd is gone — a missing fork cwd emits an
  // unhandled 'error' (spawn ENOENT) that would crash the daemon.
  const rawAdoptCwd = adopted.cwd ?? ds.workingDir ?? process.cwd();
  const adoptCwd = rawAdoptCwd && existsSync(rawAdoptCwd) ? rawAdoptCwd : homedir();
  if (adoptCwd !== rawAdoptCwd) logger.warn(`[${t}] adopt cwd "${rawAdoptCwd}" does not exist — falling back to ${adoptCwd}`);
  const forkEnv = workerForkEnv(process.env);
  const worker = fork(workerPath, [], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: workerForkExecArgv(),
    cwd: adoptCwd,
    env: {
      ...forkEnv,
      CLAUDECODE: undefined,
      BOTMUX: '1',
      LARK_APP_ID: botCfg.larkAppId,
      // Withhold the real secret from the adopt worker's CLI env for a
      // no-transport session — same rationale as forkWorker above.
      LARK_APP_SECRET: larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly }) ? botCfg.larkAppSecret : '',
    },
  } as WindowsForkOptions);
  const startupState: WorkerStartupState = { ready: false, failureNotified: false };

  // A fork-level failure emits 'error'; without a handler it crashes the daemon.
  // Adopt has no worker IPC in this case either, so reply from the daemon just
  // like the normal-session fork guard.
  worker.on('error', (err) => {
    const reason = (err as Error)?.message ?? String(err);
    logger.error(`[${t}] Adopt worker fork error: ${reason}`);
    if (startupState.failureNotified) return;
    startupState.failureNotified = true;
    const message = tr('worker.start_failed', {
      cliName: sessionCliDisplayName(ds, botCfg),
      reason,
    }, botLocale(botCfg));
    emitSessionLifecycleHook(ds, 'session.requires_attention', {
      reason: 'worker_fork_error',
      message: reason,
    });
    void cb.sessionReply(
      sessionAnchorId(ds),
      message,
      'text',
      ds.larkAppId,
      fallbackTurnId(ds, undefined),
    ).catch(replyErr => logger.error(`[${t}] Failed to deliver adopt worker fork error to Lark: ${replyErr}`));
  });

  // Pipe worker stdout/stderr — both go through logger.info (→ daemon.log,
  // not error.log). See forkWorker for the rationale.
  worker.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.info(`[${t}:out] ${trimmed}`);
    }
  });
  worker.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      logWorkerStderr(t, line.trim());
    }
  });

  // Bridge mode is gated per-CLI:
  //   - claude-code: needs sessionId to compute jsonl path. PID + cwd let
  //     the worker follow Claude's `/clear` / `/resume` rotations.
  //   - codex: worker resolves the rollout path either from cliSessionId
  //     (passed below when known) or by reading the Codex pid's open fds
  //     in /proc — so we always pass the pid for codex adopt.
  //   - traex: same rollout strategy as codex (byte-identical JSONL format),
  //     only the directory layout (~/.trae/cli/sessions) and finders differ.
  //   - coco: events.jsonl path is `~/.cache/coco/sessions/<sid>/events.jsonl`,
  //     deterministic from cliSessionId. PID is the fallback when discovery
  //     missed (events.jsonl isn't held open continuously, so worker may need
  //     to re-probe via session.log / traces.jsonl fds).
  //   - mtr: worker tails MTR's sqlite transcript, resolving by native sid
  //     when discovery has one or by adopted cwd as a fallback.
  //   - cursor: worker maps the adopt pid → its open store.db fd → chatId →
  //     the append-only agent-transcript JSONL, then harvests final replies
  //     from there (cursor-agent never calls `botmux send`).
  // Other CLIs fall back to legacy screen-capture only.
  const adoptedCliId = adopted.cliId ?? 'claude-code';
  // Claude adopt needs a sessionId to compute bridgeJsonlPath (the worker's
  // claude branch starts its transcript bridge ONLY from bridgeJsonlPath — it
  // has no by-pid fallback like codex/traex/cursor). Discovery resolves the
  // sessionId up front for the common case, but it can still come back empty:
  //   • herdr `agent list` exposes no pid, so a claude with no agent_session
  //     binding has nothing to key ~/.claude/sessions/<pid>.json off;
  //   • tmux discovery can record a launcher pid (node/ttadk/aiden wrapping
  //     claude) when the real-CLI-pid resolver hasn't found the child yet.
  // In BOTH cases fall back to the unique claude session for this cwd. Applies
  // to every adopt source (not just herdr) since the tmux path hits the same
  // undefined-sessionId → no-bridge → replies-never-return failure.
  if (adoptedCliId === 'claude-code' && !adopted.sessionId) {
    const claudeMeta = findUniqueClaudeSessionByCwd(adopted.cwd);
    if (claudeMeta?.sessionId) {
      adopted.sessionId = claudeMeta.sessionId;
      if (ds.session.adoptedFrom) ds.session.adoptedFrom.sessionId = claudeMeta.sessionId;
      sessionStore.updateSession(ds.session);
      logger.info(`[${t}] Resolved Claude session for adopted ${adopted.source ?? 'tmux'} target by cwd`);
    } else {
      logger.warn(`[${t}] Cannot resolve unique Claude session for adopted ${adopted.source ?? 'tmux'} target; final replies may be unavailable`);
    }
  }
  const hasCliPid = typeof adopted.originalCliPid === 'number';
  const bridgeJsonlPath =
    adoptedCliId === 'claude-code' && adopted.sessionId
      ? claudeJsonlPathForSession(adopted.sessionId, adopted.cwd)
      : undefined;
  // cursor: worker resolves the agent-transcript JSONL from the adopt pid's
  // open store.db fd (chatId), or from cliSessionId (= chatId) when discovery
  // captured it — so adopt must forward the pid + cwd like the other
  // transcript-backed CLIs.
  const isStructuredBridge = isStructuredBridgeAdoptCli(adoptedCliId);
  const adoptBackendType = adopted.source === 'herdr' ? 'herdr' : adopted.zellijPaneId ? 'zellij' : 'tmux';

  const initMsg: DaemonToWorker = {
    type: 'init',
    sessionId: ds.session.sessionId,
    chatId: ds.chatId,
    chatType: ds.chatType,
    rootMessageId: sessionAnchorId(ds),
    workingDir: adopted.cwd,
    cliId: adoptedCliId,
    cliRuntime: agentCfg.cliRuntime,
    cliPathOverride: agentCfg.cliPathOverride,
    cliSessionId: isStructuredBridge ? adopted.sessionId : undefined,
    model: agentCfg.model,
    disableCliBypass: botCfg.disableCliBypass === true,
    codexRpcInput: botCfg.codexRpcInput === true || config.codexRpcInputDefault,
    // Adopt is normally observe-only (prompt=''), driven later by 'message'
    // IPCs. But a re-fork triggered by an incoming Lark turn (worker had exited
    // — crash, or the "adopted session ended" kill path) must carry that turn's
    // input so it isn't dropped: the daemon's worker-null branch now routes
    // adopt sessions here instead of forkWorker (which would spawn a fresh
    // bmx-* CLI and lose bridge semantics). The init handler queues this prompt
    // into pendingMessages and the adopt idle detector (setupAdoptIdleDetection
    // → markPromptReady) flushes it to the observed pane, exactly like a
    // live-worker follow-up. Content is already bridge-formatted by the caller
    // (buildReforkCliInput → buildBridgeInputContent), so no <user_message>
    // wrapper leaks into the user's un-injected external CLI.
    prompt: opts?.prompt ?? '',
    turnId: opts?.turnId,
    resume: false,
    ownerOpenId: ds.ownerOpenId,
    webPort: ds.session.webPort,
    larkAppId: botCfg.larkAppId,
    // Freeze on the session transport capability: a no-transport session
    // (apiOnly bot OR HTTP virtual chat) must not even RECEIVE the real secret —
    // withholding it removes the capability rather than gating a tamperable flag
    // the sandboxed agent could flip. The worker then physically cannot dial
    // Feishu (uploader/cred-write are also skipped downstream on the same test).
    larkAppSecret: larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly }) ? botCfg.larkAppSecret : '',
    apiOnly: botCfg.apiOnly,
    brand: normalizeBrand(botCfg.brand),
    botName: bot.botName,
    botOpenId: bot.botOpenId,
    locale: botLocale(botCfg),
    // Zellij adopt targets carry zellijSession+zellijPaneId (observe via
    // dump-screen / drive via action); tmux carries tmuxTarget (pipe-pane).
    // The worker's adopt branch picks the backend from whichever is present.
    backendType: adoptBackendType,
    adoptMode: true,
    adoptSource: adopted.source ?? adoptBackendType,
    adoptTmuxTarget: adopted.tmuxTarget,
    adoptHerdrSessionName: adopted.herdrSessionName,
    adoptHerdrTarget: adopted.herdrTarget,
    adoptHerdrPaneId: adopted.herdrPaneId,
    adoptZellijSession: adopted.zellijSession,
    adoptZellijPaneId: adopted.zellijPaneId,
    adoptPaneCols: adopted.paneCols,
    adoptPaneRows: adopted.paneRows,
    bridgeJsonlPath,
    // PID + cwd: claude uses for `~/.claude/sessions/<pid>.json` resolver;
    // codex uses for `/proc/<pid>/fd` rollout discovery (works even if
    // session-discovery couldn't probe sessionId up-front). zellij adopt ALSO
    // needs the pid unconditionally: ZellijObserveBackend's liveness watches
    // the CLI pid (process.kill(pid,0)) so the worker onExit's when a user-typed
    // CLI exits back to a shell — without it, aiden/gemini/opencode/hermes would
    // fall back to pane-only liveness and keep routing input into the shell.
    adoptCliPid: hasCliPid && (adoptedCliId === 'claude-code' || isStructuredBridge || !!adopted.zellijPaneId) ? adopted.originalCliPid : undefined,
    adoptCwd: hasCliPid && (adoptedCliId === 'claude-code' || isStructuredBridge || !!adopted.zellijPaneId) ? adopted.cwd : undefined,
    // Restored-from-metadata: this fork is recreating an /adopt session after
    // a daemon restart, NOT a fresh /adopt command. The Lark thread already
    // has every prior turn pushed as cards, so the worker should skip the
    // "📜 /adopt 前最后一轮" preamble (it would surface a stale turn from
    // whichever jsonl was current at the original /adopt time, which may be
    // way out of date if the user has /clear'd since).
    adoptRestoredFromMetadata: opts?.restoredFromMetadata === true ? true : undefined,
  };
  worker.send(initMsg);
  ds.initConfig = initMsg;
  // Stamp cliId on the persisted session so the dashboard can show a CLI badge
  // even after the session is closed. Adopt sessions inherit the adopted CLI's id.
  // Do this before installing worker handlers: a fast worker can emit `ready`
  // immediately after init, and card rendering must use the adopted CLI identity.
  const adoptedCliIdTyped = adoptedCliId as CliId;
  if (ds.session.cliId !== adoptedCliIdTyped) {
    ds.session.cliId = adoptedCliIdTyped;
    sessionStore.updateSession(ds.session);
  }

  // Use shared handler
  setupWorkerHandlers(ds, worker, startupState, workerGeneration);

  ds.worker = worker;
  ds.spawnedAt = Date.now();
  ds.cliVersion = '';
  // Persist the bridge worker's pid, exactly like forkWorker. Without it the
  // session row keeps pid=null, so `botmux list` (and killStalePids) judge an
  // adopt session by "process dead AND no bmx-<id> tmux" — but adopt attaches to
  // the user's OWN tmux/zellij pane, never a bmx-* session, so the heuristic
  // always reported it unrecoverable and auto-pruned it to "closed" right after
  // /adopt. Storing the worker pid (botmux's bridge, NOT the user's CLI) makes
  // liveness consistent with normal sessions and leaves the user's CLI alone.
  sessionStore.updateSessionPid(ds.session.sessionId, worker.pid ?? null);
  logger.info(`[${t}] Adopt worker forked (pid: ${worker.pid}, target: ${adopted.tmuxTarget ?? `${adopted.zellijSession}/${adopted.zellijPaneId}`})`);

  ds.exitEventEmitted = false;
  dashboardEventBus.publish({
    type: 'session.spawned',
    body: { session: composeRowFromActive(ds) },
  });
  cb.enforceLiveSessionCap?.();
  emitSessionLifecycleHook(ds, 'session.start', {
    reason: opts?.restoredFromMetadata ? 'adopt_restore' : 'adopt',
    pid: worker.pid ?? null,
    adoptedFrom: adopted.tmuxTarget,
  });
  // Adopted CLIs come with pre-botmux history — anchor it out of the ledger.
  anchorUsageForDaemonSession(ds);
  recordOwnershipForDaemonSession(ds);
}

// ─── Reap orphan workers ────────────────────────────────────────────────────

/** A live process, reduced to what orphan detection needs. */
export interface ProcSnapshot {
  pid: number;
  ppid: number;
  /** Full command line (argv joined by spaces). */
  cmd: string;
}

/**
 * Enumerate live processes as {pid, ppid, cmd}. Linux reads `/proc` directly
 * (the rest of the worker code already relies on /proc); other POSIX shells out
 * to `ps`. Returns `[]` on Windows or on any failure — callers then reap
 * nothing, so "can't tell" can never escalate into a wrong kill.
 */
export function listProcesses(): ProcSnapshot[] {
  if (process.platform === 'win32') return [];
  try {
    if (process.platform === 'linux') {
      const procs: ProcSnapshot[] = [];
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        try {
          // /proc/<pid>/stat = "<pid> (comm) <state> <ppid> ...". `comm` can
          // contain spaces and ')', so read ppid from after the LAST ')'.
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
          const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          const ppid = Number(after[1]); // after = [state, ppid, ...]
          const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
          if (Number.isFinite(ppid)) procs.push({ pid, ppid, cmd });
        } catch { /* exited mid-scan / unreadable — skip */ }
      }
      return procs;
    }
    // macOS / other POSIX. `-ww` defeats command-column truncation.
    const raw = execSync('ps -axww -o pid=,ppid=,command=', { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    const procs: ProcSnapshot[] = [];
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
    }
    return procs;
  } catch {
    return [];
  }
}

/**
 * Reap worker processes orphaned by a previous daemon that died WITHOUT running
 * its graceful shutdown — SIGKILL, OOM, or an uncaught crash. The shutdown()
 * path in daemon.ts already SIGKILLs stragglers on SIGTERM, but a hard kill
 * skips it entirely: the workers get re-parented to init (ppid==1), and because
 * a fresh worker's pid overwrites `session.pid`, killStalePids can never reach
 * them again. Each leaks ~0.5 GB and they pile up across restarts (observed:
 * 22 orphans / 3.3 GB on a dev box; daemon.ts records a prior 841-orphan /
 * ~65 GB incident).
 *
 * Identification is deliberately conservative — a process is reaped only if it
 * BOTH:
 *   1. has ppid==1 — its forking daemon is gone. A live daemon's workers are
 *      parented to that daemon, so this never touches a running worker, even
 *      under the one-daemon-per-bot layout or when several daemons start at
 *      once; and
 *   2. references THIS install's worker script in its command line — so we
 *      never touch another botmux install or an unrelated `worker.js`.
 *
 * Process listing and the kill syscall are injectable for tests. Returns the
 * number of orphans actually reaped.
 */
export function reapOrphanWorkers(opts: {
  procs?: ProcSnapshot[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  workerPath?: string;
} = {}): number {
  if (process.platform === 'win32') return 0;
  const procs = opts.procs ?? listProcesses();
  const kill = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const workerPath = opts.workerPath ?? join(__dirname, '..', 'worker.js');

  let reaped = 0;
  for (const p of procs) {
    if (p.ppid !== 1) continue;                 // parent still alive → not an orphan
    if (!p.cmd.includes(workerPath)) continue;  // not OUR worker script
    try {
      // SIGKILL, not SIGTERM: an orphan can be wedged in a sync code path (the
      // very failure mode that produced it) where SIGTERM is lost. It holds no
      // active session and no IPC channel, so there is nothing to flush.
      kill(p.pid, 'SIGKILL');
      reaped++;
      logger.info(`Reaped orphan worker pid=${p.pid} (forking daemon gone)`);
    } catch { /* already exited, or another daemon won the race — fine */ }
  }
  if (reaped > 0) {
    logger.warn(`Reaped ${reaped} orphan worker(s) leaked by a previous daemon that didn't shut down cleanly.`);
  }
  return reaped;
}

// ─── Kill stale PIDs ────────────────────────────────────────────────────────

export function killStalePids(
  activeSessions_: Session[],
  runtimeSessions?: ReadonlyMap<string, DaemonSession>,
): void {
  // Startup restore runs concurrently with the already-live dispatcher. A
  // message may create/register a fresh worker for a snapshot row before this
  // stale-process sweep starts. Treat the runtime registry as authoritative:
  // never signal the PID of any logical session that is already registered.
  const runtimeSessionIds = new Set(
    runtimeSessions ? [...runtimeSessions.values()].map(ds => ds.session.sessionId) : [],
  );
  for (const session of activeSessions_) {
    if (runtimeSessionIds.has(session.sessionId)) continue;
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

  cleanupPersistentBackendSessions('tmux', activeSessions_, runtimeSessions);
  cleanupPersistentBackendSessions('herdr', activeSessions_, runtimeSessions);
  cleanupPersistentBackendSessions('zmx', activeSessions_, runtimeSessions);
}

/**
 * Sweep dead CLI-pid marker files out of `.botmux-cli-pids/`. Each marker is
 * named for the PID that wrote it; when that PID is gone the file is a landmine —
 * the kernel eventually recycles the number onto an unrelated process, and a
 * `botmux send` climbing its ancestry can then read a since-exited session's
 * marker and route the message into the WRONG bot's session. (Fix A already
 * rejects such a marker at read time by verifying procStart / the env session
 * id; this GC removes the file so the collision can't even be attempted, and
 * keeps the directory from growing without bound — graceful worker exit unlinks
 * its own marker, but SIGKILL / crash / force-kill do not.)
 *
 * Cross-daemon safe: with many daemons sharing one data dir, a DEAD pid cannot
 * belong to any live daemon's session, so unlinking its marker never races a
 * peer. A live pid's marker is always left untouched. The tiny window where a
 * PID is recycled between the liveness probe and unlink is benign — the new
 * owner rewrites its marker on the next turn, and Fix A makes a briefly-missing
 * marker fall back to the correct env id, never to a wrong session.
 *
 * `isPidAlive` is injectable so tests are deterministic regardless of what PIDs
 * the host has actually allocated (picking a "surely-dead" literal is unsafe —
 * it can be below pid_max and collide with a live process on a busy runner).
 * Production uses `process.kill(pid, 0)`: a signal-0 probe that never kills.
 * Conservative on every ambiguity — only a definitively-dead PID is swept.
 */
export function defaultPidLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, never kills
    return true;          // alive → owned by some (possibly peer) daemon
  } catch (err: any) {
    if (err?.code === 'ESRCH') return false; // no such process → dead
    return true; // EPERM (alive, not ours) or unknown error → keep, never guess
  }
}

export function sweepDeadPidMarkers(
  dataDir: string = config.session.dataDir,
  isPidAlive: (pid: number) => boolean = defaultPidLiveness,
): number {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  let entries: string[];
  try { entries = readdirSync(markersDir); }
  catch { return 0; } // dir absent (fresh install) → nothing to sweep
  let removed = 0;
  for (const name of entries) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1) continue; // ignore non-pid files
    if (isPidAlive(pid)) continue;                    // keep live (incl. peer daemons)
    try { unlinkSync(join(markersDir, name)); removed++; }
    catch { /* raced with another sweeper or the owner — fine */ }
  }
  if (removed > 0) logger.info(`Swept ${removed} dead CLI-pid marker(s) from ${markersDir}`);
  return removed;
}

function cleanupPersistentBackendSessions(
  backendType: 'tmux' | 'herdr' | 'zmx',
  activeSessions_: Session[],
  runtimeSessions?: ReadonlyMap<string, DaemonSession>,
): void {
  const storedSessions = sessionStore.listSessions();
  const runtimeSessionRows = runtimeSessions
    ? [...runtimeSessions.values()].map(ds => ds.session)
    : [];
  const anyBackend = getAllBots().some(b => (b.config.backendType ?? config.daemon.backendType) === backendType)
    || config.daemon.backendType === backendType
    || activeSessions_.some(s => s.backendType === backendType)
    || runtimeSessionRows.some(s => s.backendType === backendType)
    || storedSessions.some(s => s.backendType === backendType);
  if (!anyBackend) return;

  const backend = backendType === 'tmux' ? TmuxBackend : backendType === 'zmx' ? ZmxBackend : HerdrBackend;
  const multiBot = getAllBots().length > 1;
  const cliIdFile = join(config.session.dataDir, backendType === 'tmux' ? 'last-cli-id' : `last-cli-id-${backendType}`);
  let lastCliId: string | undefined;
  try { lastCliId = readFileSync(cliIdFile, 'utf-8').trim(); } catch { /* first run */ }
  const currentCliId = config.daemon.cliId;
  // Codex App sessions with an unsettled dispatch ledger must reconcile before
  // any CLI-change sweep tears their backing pane down.
  const unsettledNames = new Set(
    activeSessions_
      .filter(hasProtectedSessionMutationOwnership)
      .map(session => backend.sessionName(session.sessionId)),
  );
  const belongsToBackend = (session: Session) =>
    session.backendType === backendType ||
    (session.backendType === undefined && backendType === 'tmux');
  const activeNames = new Set(
    [...activeSessions_, ...runtimeSessionRows]
      .filter(belongsToBackend)
      .map(s => backend.sessionName(s.sessionId)),
  );
  const runtimeNames = new Set(
    runtimeSessionRows.filter(belongsToBackend).map(s => backend.sessionName(s.sessionId)),
  );
  const ownedSessions = [
    ...storedSessions.filter(belongsToBackend),
    ...activeSessions_.filter(belongsToBackend),
  ];
  const ownedIdsByName = new Map<string, Set<string>>();
  for (const session of ownedSessions) {
    const name = backend.sessionName(session.sessionId);
    const ids = ownedIdsByName.get(name) ?? new Set<string>();
    ids.add(session.sessionId);
    ownedIdsByName.set(name, ids);
  }
  const ownedNames = new Set(ownedIdsByName.keys());
  type ExactHerdrTarget = { sessionName: string; agentName: string };
  const exactHerdrTarget = (session: Session): ExactHerdrTarget | undefined => {
    const target = session.persistentBackendTarget;
    if (target?.backendType !== 'herdr') return undefined;
    const sessionName = target.sessionName.trim();
    const agentName = target.agentName?.trim();
    if (!sessionName || !agentName) return undefined;
    return { sessionName, agentName };
  };
  const exactHerdrTargetKey = (target: ExactHerdrTarget): string =>
    JSON.stringify([target.sessionName, target.agentName]);
  const managedExactHerdrTargets = new Map<string, ExactHerdrTarget>();
  const adoptedExactHerdrTargetKeys = new Set<string>();
  const activeExactHerdrTargetKeys = new Set<string>();
  const runtimeExactHerdrTargetKeys = new Set<string>();
  if (backendType === 'herdr') {
    // An adopted target is user-owned even if a corrupt/legacy managed row
    // happens to point at the same host+agent. Treat any such row as a veto.
    for (const session of [...storedSessions, ...activeSessions_, ...runtimeSessionRows]) {
      const target = exactHerdrTarget(session);
      if (!target) continue;
      const key = exactHerdrTargetKey(target);
      if (session.adoptedFrom) adoptedExactHerdrTargetKeys.add(key);
    }
    // The restore snapshot is the liveness authority for this sweep. Protect
    // every exact active target, including adopted targets and duplicate rows.
    for (const session of activeSessions_) {
      const target = exactHerdrTarget(session);
      if (target) activeExactHerdrTargetKeys.add(exactHerdrTargetKey(target));
    }
    // Dispatcher/IPC are already live while startup restore runs. A newly
    // registered runtime row belongs to the current daemon/current CLI and is
    // authoritative over the stale store snapshot in both ordinary and global
    // CLI-change cleanup.
    for (const session of runtimeSessionRows) {
      const target = exactHerdrTarget(session);
      if (target) runtimeExactHerdrTargetKeys.add(exactHerdrTargetKey(target));
    }
    // Only an explicit persisted agent target proves ownership inside a shared
    // host. Never derive an agent from the session id, and never treat a
    // host-only target as permission to stop the surrounding Herdr session.
    for (const session of ownedSessions) {
      if (session.adoptedFrom || session.queued) continue;
      const target = exactHerdrTarget(session);
      if (!target) continue;
      // Herdr's host is machine-wide. A historical short name
      // (`botmux-<sid8>`) is not enough authority for opportunistic startup
      // deletion: another daemon/data root can own the colliding live pane.
      // Require both the strong 128-bit-era format and the deterministic
      // binding to this complete session id. Legacy targets remain fully
      // supported for reattach and explicit user-requested close.
      if (
        !isStrongManagedHerdrAgentName(target.agentName)
        || target.agentName !== managedHerdrAgentName(
          session.sessionId,
          config.session.dataDir,
        )
      ) continue;
      managedExactHerdrTargets.set(exactHerdrTargetKey(target), target);
    }
  }
  const killManagedExactHerdrTargets = (preserveActive: boolean): void => {
    if (backendType !== 'herdr') return;
    const agentNamesBySession = new Map<string, Set<string>>();
    for (const [key, target] of managedExactHerdrTargets) {
      if (adoptedExactHerdrTargetKeys.has(key)) continue;
      if (runtimeExactHerdrTargetKeys.has(key)) continue;
      if (preserveActive && activeExactHerdrTargetKeys.has(key)) continue;
      const agentNames = agentNamesBySession.get(target.sessionName) ?? new Set<string>();
      agentNames.add(target.agentName);
      agentNamesBySession.set(target.sessionName, agentNames);
    }
    // Batch by host: one `agent list` per distinct positively-owned host, then
    // close only matching live panes. Historical rows that are already gone
    // therefore add no subprocess calls, and duplicate targets collapse.
    for (const [sessionName, agentNames] of agentNamesBySession) {
      logger.info(
        `Killing orphaned herdr agent(s) in ${sessionName}: ${[...agentNames].join(', ')}`,
      );
      HerdrBackend.killAgents(sessionName, agentNames);
    }
  };
  const killOwnedBackendSession = (name: string, exactSessionId?: string): void => {
    if (backendType !== 'zmx') {
      backend.killSession(name);
      return;
    }
    const candidates = exactSessionId
      ? new Set([exactSessionId])
      : ownedIdsByName.get(name);
    if (!candidates || candidates.size !== 1) {
      logger.warn(
        `Refusing ambiguous name-only ZMX cleanup for ${name}; ` +
        `matching stored session ids=${candidates?.size ?? 0}`,
      );
      return;
    }
    try {
      ZmxBackend.killManagedSession(name, [...candidates][0]!);
    } catch (err) {
      logger.warn(`Refusing unsafe ZMX cleanup for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (!multiBot && lastCliId && lastCliId !== currentCliId) {
    logger.info(`CLI_ID changed (${lastCliId} → ${currentCliId}), killing all ${backendType} sessions`);
    // Legacy per-topic hosts are still enumerable by bmx-* name.
    for (const name of backend.listBotmuxSessions()) {
      if (unsettledNames.has(name)) {
        logger.warn(`Preserving ${backendType} ${name}: unsettled Codex App dispatch must reconcile first`);
        continue;
      }
      // A dispatcher-created runtime session already runs the current CLI.
      // Never let the stale last-cli marker tear it down during restore.
      if (runtimeNames.has(name)) continue;
      // ZMX_DIR is a user-wide namespace and bmx-* is deterministic, not an
      // ownership credential. Another checkout/data root can legitimately own
      // a bmx-* daemon, so never kill a name absent from this bot's store/map.
      if (backendType === 'zmx' && !ownedNames.has(name)) continue;
      killOwnedBackendSession(name);
    }
    // Machine-wide Herdr agents are not separate bmx-* sessions. Include
    // persisted inactive rows as well as the active restore snapshot so a CLI
    // switch cannot leave an old executable behind.
    killManagedExactHerdrTargets(false);
  } else {
    for (const name of backend.listBotmuxSessions()) {
      if (ownedNames.has(name) && !activeNames.has(name)) {
        logger.info(`Killing orphaned ${backendType} session: ${name}`);
        killOwnedBackendSession(name);
      }
    }
    killManagedExactHerdrTargets(true);
    for (const session of activeSessions_) {
      if (!belongsToBackend(session)) continue;
      const sessionCliId = session.cliId;
      if (!sessionCliId || !session.larkAppId) continue;
      let botCliId: CliId | undefined;
      try { botCliId = getBot(session.larkAppId).config.cliId; } catch { continue; }
      if (botCliId && sessionCliId !== botCliId) {
        const target = resolvePersistentBackendTarget(
          backendType,
          session.sessionId,
          session.persistentBackendTarget,
        );
        const runtimeOwnsTarget = target.backendType === 'herdr' && target.agentName
          ? runtimeExactHerdrTargetKeys.has(exactHerdrTargetKey({
            sessionName: target.sessionName,
            agentName: target.agentName,
          }))
          : runtimeNames.has(target.sessionName);
        if (runtimeOwnsTarget) continue;
        const label = target.backendType === 'herdr' && target.agentName
          ? `${target.sessionName}/${target.agentName}`
          : target.sessionName;
        logger.info(`CLI mismatch for ${session.sessionId.substring(0, 8)} (session=${sessionCliId}, bot=${botCliId}), killing ${backendType} ${label}`);
        try {
          killPersistentBackendTarget(target, session.sessionId);
        } catch (err) {
          // This sweep runs before restore has registered any persisted rows.
          // One inconclusive identity-verified teardown (notably ZMX) must not
          // abort restoration for every unrelated session. Keep this row active
          // and let closeActiveSessionIfCliMismatch() retry it through the
          // per-session fail-closed path later in the restore pass.
          logger.warn(
            `CLI mismatch cleanup deferred for ${session.sessionId.substring(0, 8)} `
            + `(${backendType} ${label}): ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
      }
    }
  }

  try {
    mkdirSync(config.session.dataDir, { recursive: true });
    atomicWriteFileSync(cliIdFile, currentCliId);
  } catch (err) {
    logger.warn(`Failed to write ${cliIdFile}: ${err}`);
  }
}

// ─── CLI version (shared with daemon) ─────────────────────────────────────

/** Current CLI versions, kept in sync by daemon. The scalar fallback preserves
 * older callers while runtime-aware paths prevent independent distributions
 * from overwriting one another. */
let currentCliVersion = 'unknown';
const currentCliVersions = new Map<string, string>();

export function setCurrentCliVersion(v: string, runtimeKey?: string): void {
  currentCliVersion = v;
  if (runtimeKey) currentCliVersions.set(runtimeKey, v);
}

export function getCurrentCliVersion(runtimeKey?: string): string {
  return runtimeKey ? currentCliVersions.get(runtimeKey) ?? 'unknown' : currentCliVersion;
}
