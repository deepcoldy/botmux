/**
 * Worker pool — manages forking, killing, and lifecycle of worker processes.
 * Extracted from daemon.ts for modularity.
 */
import { execSync, type ChildProcess } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, readdirSync, mkdirSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureSkills, ensureAskSkill, ensurePluginSkills, ensureWhiteboardSkill, ensureWorkflowSkills, removeGlobalBotmuxSkills } from '../skills/installer.js';
import { shouldInstallGlobalSkills } from '../skills/injection-mode.js';
import { whiteboardEnabled } from '../services/whiteboard-store.js';
import { cliSupportsNativeUsage } from '../services/transcript-resolver.js';
import { cleanupTraexAskHooks, installHook } from '../adapters/hook-installer.js';
import { hookCommandFor } from '../adapters/hook-command.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mayRestoreWriteAdmission } from '../adapters/backend/destroy-result.js';
import { config } from '../config.js';
import { readGlobalConfig, isWorkflowFeatureEnabled } from '../global-config.js';
import * as sessionStore from '../services/session-store.js';
import * as asyncTriggerStore from '../services/async-trigger-store.js';
import {
  markMessageListenerRunPreviewFailed,
  markMessageListenerRunPreviewReplied,
  markMessageListenerRunPreviewRunning,
} from '../services/message-listener-run-preview-store.js';
import { persistStreamCardState, rememberLastCliInput } from './session-manager.js';
import { spawnWorker, isStandaloneBinary, WORKER_ENTRY_SUBCOMMAND } from './self-spawn.js';
import { resolveSessionLaunchModel } from './session-model.js';
import { fallbackTurnId, frozenReplyContextForTurn, isSubstituteTurn, pickTurnReplyTarget, rehomeReplyTargetState, replyTargetKey } from './reply-target.js';
import { updateMessage, deleteMessage, pinMessage, unpinMessage, sendEphemeralCard, sendUserMessage, addReaction, removeReaction, getMessageChatId, MessageWithdrawnError } from '../im/lark/client.js';
import { buildStreamingCard, buildPrivateSnapshotCard, buildSessionCard, buildTuiPromptCard, buildTuiPromptResolvedCard, buildTuiPromptFailedCard, buildRelayedFrozenCard, buildTurnFailedCard, getCliDisplayName } from '../im/lark/card-builder.js';
import { codexServiceTierBadge } from '../services/codex-service-tier.js';
import { cliModelSupportsReasoningEffort, isConfigurableReasoningCliId } from '../services/codex-reasoning-effort.js';
import { RPC_CAPABLE_CLIS } from '../codex-rpc-lifecycle.js';
import { loadFrozenCards, saveFrozenCards } from '../services/frozen-card-store.js';
import { hashUrlForLog } from '../adapters/backend/riff-backend.js';
import { cancelMojoSessionById } from '../adapters/backend/mojo-backend.js';
import { cleanupMojoIsolatedWorkspace } from '../adapters/backend/mojo-isolated-workspace.js';
import { hasUnprovenContainment } from './mojo-containment.js';
import { MOJO_EXPLICIT_CLOSE_RESULT_TIMEOUT_MS } from '../adapters/backend/mojo-budgets.js';
import {
  buildEffectiveMojoConfig,
  diffMojoSessionIdentity,
  MOJO_IDENTITY_KEYS,
  pickMojoLivePatch,
  isMojoRemoteGone,
  mojoUnprovableEnvKeys,
  pickMojoSessionIdentity,
  type EffectiveMojoConfig,
  type MojoConfig,
  type MojoLivePatch,
} from '../adapters/backend/mojo-types.js';
import { sanitizePerBotEnv } from './per-bot-env.js';
import { normalizeExistingAppServerEndpoint } from './existing-app-server.js';
import {
  isExistingAppServerSharedAdoptPersistedSession,
  isSharedAdoptPersistedSession,
  isSharedAdoptSession,
} from './shared-adopt.js';
import { closeResidualClause } from './close-residual.js';
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
  buildCanonicalFinalReplyCard,
  buildContextualReplyCard,
  type CardUsageSnapshot,
  type LocalHomeLinkMode,
} from '../im/lark/md-card.js';
import { getSessionUsageSnapshot } from './cost-calculator.js';
import { renderBrandTemplate } from '../im/lark/brand-template.js';
import { handleCotThinkingUpdate, finalizeCotMessage, abortCotMessage } from '../im/lark/cot-message.js';
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
import { isRemoteBackendSession, isRemoteBackendType, isSuspendableBackendType, getSessionPersistentBackendType, persistentBackendTargetForSession, persistentSessionName, killPersistentBackendTarget, killPersistentSession, managedTargetsForCliChange, probePersistentBackendTarget, resolvePairedSpawnBackendType, resolvePersistentBackendTarget } from './persistent-backend.js';
import { withBotTurnMutation } from './bot-turn-mutation-gate.js';
import { recordQuarantinedLauncherEnvKeys } from './mojo-launcher-env-quarantine.js';
import { freezeMojoIdentityForSession } from './mojo-session-identity.js';
import { getBot, getAllBots, getOwnerOpenId, loadBotConfigs, resolveBrandLabel, getLoadedConfigPath, getLoadedConfigProvenance, resolveUsageDisplay } from '../bot-registry.js';
import { resolvePricingConfig, type ResolvedModelPricing } from '../services/model-pricing.js';
import { RestartCoordinator, type RestartObserver } from './restart-coordinator.js';
import { runtimeBuildIdentity } from '../utils/runtime-build-id.js';
import { scrubWorkflowWorkerEnv } from '../utils/child-env.js';
import { resolveFeedbackPolicyForDelivery, resolveFeedbackTeamId } from '../services/feedback-policy-resolver.js';

/** A random id minted once per daemon process (this lifetime). Stamped onto
 *  isolated persistent panes so a suspend→resume reattach (same id) is
 *  distinguishable from a pane surviving a daemon restart (different id). */
const DAEMON_BOOT_ID = randomUUID();
const restartCoordinator = new RestartCoordinator();
const lifecycleRetiringWorkers = new WeakMap<DaemonSession, Set<ChildProcess>>();
const transferRetiringWorkers = new WeakSet<ChildProcess>();

/** 从 bot 配置解析定价（bots.json pricing 块 → 内置表）。未配置时返回 undefined。 */
function resolvePricingForBot(larkAppId?: string): ResolvedModelPricing | undefined {
  if (!larkAppId) return undefined;
  return resolvePricingConfig(getBot(larkAppId)?.config?.pricing);
}

/** 在完整 Worker 模块加载前接住首条 IPC，避免冷启动耗时被误判为投递失败。 */
function workerForkExecArgv(): string[] {
  const preloadPath = join(__dirname, '..', 'worker-ipc-preload.js');
  return [...process.execArgv, '--import', pathToFileURL(preloadPath).href];
}

/** Secondary index of the same retirements by session id: the WeakMap above is
 *  keyed by ds OBJECT and not iterable, but the VC fence's producer-liveness
 *  gate must find a dying process after the registry entry (and possibly the
 *  ds reference itself) is gone. Entries release on worker exit, so the map
 *  stays bounded by in-flight retirements. */
const lifecycleRetiringBySessionId = new Map<string, Set<ChildProcess>>();

function trackLifecycleRetirement(ds: DaemonSession, worker: ChildProcess): void {
  let workers = lifecycleRetiringWorkers.get(ds);
  if (!workers) {
    workers = new Set();
    lifecycleRetiringWorkers.set(ds, workers);
  }
  if (workers.has(worker)) return;
  workers.add(worker);
  const sessionId = ds.session.sessionId;
  let byId = lifecycleRetiringBySessionId.get(sessionId);
  if (!byId) {
    byId = new Set();
    lifecycleRetiringBySessionId.set(sessionId, byId);
  }
  byId.add(worker);
  const release = (): void => {
    const current = lifecycleRetiringWorkers.get(ds);
    current?.delete(worker);
    if (current?.size === 0) lifecycleRetiringWorkers.delete(ds);
    const currentById = lifecycleRetiringBySessionId.get(sessionId);
    currentById?.delete(worker);
    if (currentById?.size === 0) lifecycleRetiringBySessionId.delete(sessionId);
  };
  worker.once('exit', release);
}

/**
 * Retiring worker processes for a session id — for liveness gates that outlive
 * the registry entry. A collision loser (or any process-only retirement) is
 * deleted from the registry while its process is still dying; a VC fence armed
 * in that window would otherwise find no ds, skip its producer-liveness gate,
 * and clear on pane probes alone (fifth-round review, A1 residual).
 */
export function retiringWorkersForSession(sessionId: string): ChildProcess[] {
  return [...(lifecycleRetiringBySessionId.get(sessionId) ?? [])];
}

function clearLifecycleRetirement(ds: DaemonSession, worker: ChildProcess): void {
  const workers = lifecycleRetiringWorkers.get(ds);
  workers?.delete(worker);
  if (workers?.size === 0) lifecycleRetiringWorkers.delete(ds);
  const byId = lifecycleRetiringBySessionId.get(ds.session.sessionId);
  byId?.delete(worker);
  if (byId?.size === 0) lifecycleRetiringBySessionId.delete(ds.session.sessionId);
}

/**
 * Start a new worker generation's launcher-env ledger.
 *
 * The previous generation's keys are PARKED, never dropped — and deliberately
 * WITHOUT consulting whether that worker has exited.
 *
 * A worker exit does not prove the dangerous process is gone, and the dangerous
 * env acts on the mojo CLI *child*, not on the worker that parents it:
 *   - `MojoBackend.kill()` sends a bare `SIGTERM`, nulls its handle and reports
 *     `exitCb(0)` immediately — no SIGKILL escalation, no wait. A child that
 *     traps/ignores TERM, or is slow, survives it.
 *   - the worker's close path then runs `killCli()` and `process.exit(0)` without
 *     awaiting the child, so worker exit can precede child death.
 *   - a mojo child may also have detached descendants, so even a per-PID exit
 *     proof would not cover the process tree.
 * `PATH`-substituted launchers and `LD_PRELOAD` hooks live in exactly that child,
 * which is what holds the activated device credential.
 *
 * So the ledger is monotonic for the life of this DaemonSession: it disappears
 * only when the session ends or the daemon restarts (it is in-memory), never on
 * an exit signal we cannot verify. A stricter alternative — escalating to SIGKILL
 * and waiting for process-GROUP quiescence before releasing — is the only way to
 * make release sound, and is deliberately out of scope here: it needs new
 * teardown machinery and would still have to cover descendants, whereas monotonic
 * retention is fail-closed by construction.
 *
 * Cost: a session that was ever handed a dangerous launcher env stays
 * unprovable until it ends. That is an availability trade, not a credential leak.
 *
 * Exported so the behavioural guards can assert this directly — deleting the
 * three call sites used to leave every test green.
 */
export function startNewGenerationEnvLedger(
  ds: DaemonSession,
  initEnv: Record<string, string> | undefined,
): void {
  const parked = new Set([
    ...(ds.mojoRetiringUnprovableEnvKeys ?? []),
    ...(ds.mojoAppliedUnprovableEnvKeys ?? []),
  ]);
  ds.mojoRetiringUnprovableEnvKeys = parked.size > 0 ? [...parked] : undefined;
  ds.mojoAppliedUnprovableEnvKeys = undefined;
  rememberAppliedUnprovableEnvKeys(ds, initEnv);
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
  return (backendType !== undefined && isRemoteBackendType(backendType))
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
      // 定价覆盖：从 bot 配置解析，未配置时 undefined（costCny 缺省）。
      pricing: resolvePricingForBot(ds.larkAppId ?? ds.session.larkAppId),
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
  // Runtime identity is derived from in-memory fields only, so it is available
  // without reading the transcript. The disk read (getDaemonSessionUsageSnapshot)
  // is deferred until we know usage will actually render — a footer/off bot must
  // not pay a per-tick transcript parse just to throw the tokens away.
  const runtimeModel = ds.activeModel?.trim() || ds.session.model?.trim();
  const reasoningEffort = ds.activeReasoningEffort?.trim()
    || ds.session.reasoningEffort?.trim();
  try {
    if (resolveUsageDisplay(ds.larkAppId) !== 'streaming') {
      return {
        context: null,
        tokens: null,
        ...(runtimeModel ? { model: runtimeModel } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
    }
  } catch {
    // Missing runtime config → default 'streaming' → show usage (best-effort).
  }
  const snapshot = getDaemonSessionUsageSnapshot(
    ds,
    effectiveCliId,
    { fresh: opts?.fresh ?? false },
  );
  // Model normally comes from an explicitly-wired executor runtime (TRAE/Codex
  // set ds.activeModel) or launch config. Grok's native snapshot is the one
  // exception: its signals.json exposes a stable user-facing primaryModelId.
  // We still never surface snapshot.tokens.model, which can be an internal
  // routing code for Relay-family CLIs (e.g. `ark/relay-code`).
  const grokModel = effectiveCliId === 'grok' ? snapshot.model?.trim() : undefined;
  const grokReasoningEffort = effectiveCliId === 'grok' ? snapshot.reasoningEffort?.trim() : undefined;
  return {
    ...snapshot,
    ...(runtimeModel ? { model: runtimeModel } : grokModel ? { model: grokModel } : {}),
    ...(reasoningEffort ? { reasoningEffort } : grokReasoningEffort ? { reasoningEffort: grokReasoningEffort } : {}),
  };
}

import { normalizeBrand } from '../im/lark/lark-hosts.js';
import { dashboardEventBus } from './dashboard-events.js';
import {
  publishSessionPreviewCleared,
  takeSessionPreviewTarget,
} from './session-preview-registry.js';
import { composeRowFromActive, composeRowFromClosed } from './dashboard-rows.js';
import { publishAttentionPatch, publishClosedSessionPatch } from './session-activity.js';
import {
  attachOrdinaryTurnRecovery,
  beginOrdinaryTurnRecovery,
  cancelOrdinaryTurnRecoveryForUserInput as cancelOrdinaryRecoveryForUserInput,
  disposeOrdinaryTurnRecovery,
  handleOrdinaryTurnRecoveryTerminal,
  ordinaryTurnRecoveryHandlesTerminal,
  requireOrdinaryTurnRecoveryAttention,
  type OrdinaryTurnRecoveryDispatch,
} from '../services/ordinary-turn-recovery.js';
import { turnRetryOffer, shouldNotifyTurnFailure } from '../services/turn-failure-notice.js';
import { knownBotOpenIdsFromCrossRef, type BotMentionEntry } from '../utils/bot-routing.js';
import { emitSessionLifecycleHook, emitSessionStateTransitionHook } from '../services/session-lifecycle-hooks.js';
import { anchorUsageForDaemonSession, recordOwnershipForDaemonSession, recordUsageForDaemonSession, reconcileUsageForDaemonSession } from '../services/usage-ledger.js';
import type { CliId } from '../adapters/cli/types.js';
import { isStructuredBridgeAdoptCli } from '../services/structured-bridge-clis.js';
import { resolveEffectivePluginIds } from './plugins/effective.js';
import { ensureGatewayEntry } from './plugins/mcp/gateway-installer.js';
import { readPeerCrossRef } from '../services/peer-cross-ref-store.js';
import type {
  CliTurnPayload,
  CodexAppDeliverySink,
  CodexAppDispatchLedgerEntry,
  CodexAppGenerationCommit,
  CodexAppTurnInput,
  FrozenSessionReplyTarget,
  DaemonToWorker,
  TrustedCaller,
  WorkerToDaemon,
  Session,
  DisplayMode,
  StreamStatus,
  QueuedActivationTailEntry,
  ScreenStatus,
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
  remoteRetirementAdmissionPhase,
  type DaemonSession,
} from './types.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import { DONE_REACTION_EMOJI_TYPE } from './pending-response.js';
import { buildTerminalUrl } from './terminal-url.js';
import { prependBotmuxBin, resolveBotmuxWrapperBinDir } from './botmux-wrapper.js';
import { snapshotProcessIdentities } from './current-actor-attestation.js';
import { usageLimitStateKey, isActiveWorkRuntimeStatus, type CliUsageLimitState } from '../utils/cli-usage-limit.js';
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
import { cleanupExplicitSessionBacking } from './explicit-session-backing-cleanup.js';
import { REMOTE_ADMISSION_RESTORE_TIMEOUT_MS } from './shutdown-budgets.js';
import {
  MAX_STARTUP_AUTO_RETRIES,
  isTransientStartupFailure,
  startupAutoRetryDelayMs,
} from './worker-startup-retry.js';
import {
  managedOriginCapabilityPath,
  replaceManagedOriginCapabilityFile,
} from './managed-origin-capability.js';

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
  // Defense in depth for a daemon started from a contaminated PM2 snapshot.
  // Genuine workflow workers bypass this pool and receive their markers from
  // workflows/v3/ephemeral-pool.ts.
  scrubWorkflowWorkerEnv(env);
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

type RemoteWorkerCloseResult = {
  ok: boolean;
  taskId?: string;
  error?: string;
  /** Absent means `retryable`, the historical behaviour. See SessionDestroyResult. */
  recovery?: 'retryable' | 'uncertain' | 'irreversible';
  /** Absent means: derive from `recovery`. See mayRestoreWriteAdmission. */
  admission?: 'restorable' | 'fenced';
  /** Local subtree left unproven by an otherwise successful close. Never
   *  re-derivable here: only the backend saw the evidence grade. */
  residual?: 'local_subtree_unprovable_on_platform' | 'local_subtree_boundary_unproven';
};

const pendingRemoteWorkerCloses = new Map<string, {
  sessionId: string;
  worker: ChildProcess;
  resolve: (result: RemoteWorkerCloseResult) => void;
}>();

export function setActiveSessionsRegistry(m: Map<string, DaemonSession> | undefined): void {
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
  if (ds.session.cliLaunchSnapshot) return true;
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
    isSharedAdoptSession(ds),
    false,
    localeForBot(ds.larkAppId),
    status === 'limited' ? ds.usageLimit : undefined,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
    silentIdleCardFlag(ds),
  );
  scheduleCardPatch(ds, cardJson);
}

function flushPendingLocalCliOpenReadinessPatch(ds: DaemonSession): void {
  if (!ds.pendingLocalCliButtonRefresh) return;
  ds.pendingLocalCliButtonRefresh = undefined;
  scheduleLocalCliOpenReadinessPatch(ds);
}

/** PATCH the live card when the executor reports a different active runtime.
 * Runtime identity stays attached to the streaming usage line. */
function scheduleActiveRuntimePatch(ds: DaemonSession): void {
  if (streamingCardDisabled(ds) || ds.suppressRecoveryCard) {
    ds.pendingActiveRuntimeCardRefresh = undefined;
    return;
  }
  if (ds.streamCardNonce && ds.parkedStreamCardNonce === ds.streamCardNonce) {
    ds.pendingActiveRuntimeCardRefresh = undefined;
    return;
  }
  if (ds.streamCardId === CARD_POSTING_SENTINEL) {
    ds.pendingActiveRuntimeCardRefresh = true;
    return;
  }
  if (!ds.streamCardId || !workerHasInitialized(ds)) {
    ds.pendingActiveRuntimeCardRefresh = undefined;
    return;
  }
  ds.pendingActiveRuntimeCardRefresh = undefined;
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
    isSharedAdoptSession(ds),
    false,
    localeForBot(ds.larkAppId),
    status === 'limited' ? ds.usageLimit : undefined,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
    silentIdleCardFlag(ds),
  );
  scheduleCardPatch(ds, cardJson);
}

function flushPendingActiveRuntimePatch(ds: DaemonSession): void {
  if (!ds.pendingActiveRuntimeCardRefresh) return;
  ds.pendingActiveRuntimeCardRefresh = undefined;
  scheduleActiveRuntimePatch(ds);
}

/** Card-label flag for a turn that completed as DELIBERATE silence (worker
 *  terminal outputDisposition 'nothing_to_send'): every live-card rebuild —
 *  status edges, button toggles, runtime/tier patches — must keep rendering
 *  「已处理 · 判定无需回复」 instead of 「等待输入」 until beginNewTurn clears
 *  the flag, or an unrelated patch would silently revert the label. */
export function silentIdleCardFlag(ds: DaemonSession): boolean {
  return !!ds.silentIdleTurnId;
}

const TURN_EXPLICIT_MENTION_MAX = 64;
/** Posted-receipt memory. Bounded for the same reason as the origin FIFO, and
 *  larger than any plausible replay window within one session's lifetime. */
const SILENT_RECEIPT_DEDUPE_MAX = 64;

/** Provider-level idempotency key for the receipt. A transport timeout can be
 *  commit-unknown: retrying with the same uuid lets Lark collapse the duplicate
 *  even after the in-memory claim is deliberately released for compensation. */
function silentTurnReceiptUuid(sessionId: string, turnId: string): string {
  return `sr_${createHash('sha256')
    .update(`${sessionId}\0${turnId}`, 'utf8')
    .digest('hex')
    .slice(0, 47)}`;
}

/** Evict oldest-first until `set` fits `max` (insertion order === FIFO). */
function trimOldest(set: Set<string>, max: number): void {
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** Record, at dispatch time, whether the Lark message that opened `turnId`
 *  explicitly @-mentioned this bot. Read back at turn_terminal to decide if a
 *  deliberately-silent turn owes an auto receipt (an explicit @ is a dispatched
 *  task — its final status must be reported, silence included).
 *
 *  Only positives are stored: at read time "absent" already means "not
 *  mentioned", so keeping `false` rows would spend the bound on turns that can
 *  never owe a receipt — with type-ahead/queued turns a burst of un-@'d
 *  messages would then evict an older @'d turn that is still in flight and
 *  silently drop its receipt. The bound stays (crashed turns leave entries
 *  unconsumed) but now covers 64 genuinely-pending @'d turns. */
export function recordTurnExplicitMention(ds: DaemonSession, turnId: string, explicitMention: boolean): void {
  if (!turnId) return;
  if (!explicitMention) {
    // Re-dispatch of the same turn without an @ must not inherit a stale yes.
    ds.turnExplicitMentions?.delete(turnId);
    return;
  }
  const set = ds.turnExplicitMentions ?? (ds.turnExplicitMentions = new Set());
  set.delete(turnId);
  set.add(turnId);
  trimOldest(set, TURN_EXPLICIT_MENTION_MAX);
}

function takeTurnExplicitMention(ds: DaemonSession, turnId: string): boolean {
  return ds.turnExplicitMentions?.delete(turnId) ?? false;
}

/** PATCH a live card when rollout settings change, even if the PTY is static. */
function scheduleCodexServiceTierPatch(ds: DaemonSession): void {
  if (streamingCardDisabled(ds) || ds.suppressRecoveryCard) {
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
    isSharedAdoptSession(ds),
    false,
    localeForBot(ds.larkAppId),
    status === 'limited' ? ds.usageLimit : undefined,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
    silentIdleCardFlag(ds),
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
    isSharedAdoptSession(ds),
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
    silentIdleCardFlag(ds),
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
    isSharedAdoptSession(ds),
    false,
    localeForBot(ds.larkAppId),
    status === 'limited' ? ds.usageLimit : undefined,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
    silentIdleCardFlag(ds),
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
  return ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? botCfg.cliId;
}

function ordinaryTurnRecoveryEligible(
  ds: DaemonSession,
  botCfg = getBot(ds.larkAppId).config,
): boolean {
  return sessionCliId(ds, botCfg) === 'claude-code'
    && ds.session.status === 'active'
    && !isSharedAdoptSession(ds)
    && !ds.session.vcMeetingReceiver
    && larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly });
}

function ordinaryTurnRecoveryStillOwnsSession(ds: DaemonSession): boolean {
  if (ds.session.status !== 'active') return false;
  if (!activeSessionsRegistry) return true;
  return activeSessionsRegistry.get(sessionKey(sessionAnchorId(ds), ds.larkAppId)) === ds;
}

function ordinaryTurnRecoveryWarning(
  state: NonNullable<Session['ordinaryTurnRecovery']>,
  locale: ReturnType<typeof localeForBot>,
): string {
  if (state.status === 'exhausted' && state.continuationsStarted >= 2) {
    return tr('worker.ordinary_recovery_exhausted', undefined, locale);
  }
  if (state.lastErrorCode === 'recovery_enqueue_failed') {
    return tr('worker.ordinary_recovery_enqueue_failed', undefined, locale);
  }
  if (state.lastErrorCode === 'recovery_delivery_failed') {
    return tr('worker.ordinary_recovery_delivery_failed', undefined, locale);
  }
  if (state.lastErrorCode === 'recovery_dispatch_interrupted') {
    return tr('worker.ordinary_recovery_dispatch_interrupted', undefined, locale);
  }
  return tr('worker.ordinary_recovery_non_retryable', undefined, locale);
}

/** 构造一张通用失败卡。两条通知路径（recovery warn / claude 终态兜底）共用它，
 *  以免同一件事在两处长得不一样。
 *
 *  重试按钮只在 `lastFailedTurn` 与本次失败**同一轮**时出现：那条记录是按钮的
 *  一次性凭据（handler 用 turnId 逐字比对），没有它就只剩「去看 Web 终端」。
 *  记录缺失是正常情况——turn 在 prompt 被 wrap 前就死掉时 buildFailedTurnRecord
 *  返回 undefined。 */
function buildSessionTurnFailedCard(
  ds: DaemonSession,
  opts: {
    status: 'failed' | 'ambiguous';
    errorCode?: string;
    reason?: string;
    continuations?: number;
    retryable?: boolean;
  },
): string {
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const failedTurn = ds.session.lastFailedTurn;
  const offer = turnRetryOffer({
    status: opts.status,
    ...(opts.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
    ...(opts.retryable !== undefined ? { retryable: opts.retryable } : {}),
  });
  // 没有真人 footer 收件人时才回退 @ bot 管理员（与失败兜底通知同口径，且
  // 绝不 @ bot——那会触发对方新一轮）。
  const mentionOpenId = daemonCardFooterRecipientOpenId(ds, effectiveCliId)
    ?? failureNoticeFallbackMentionOpenId(ds);
  return buildTurnFailedCard({
    rootId: sessionAnchorId(ds),
    sessionId: ds.session.sessionId,
    cliId: effectiveCliId,
    cliName: sessionRuntimeDisplayName(ds) ?? getCliDisplayName(effectiveCliId),
    status: opts.status,
    ...(opts.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    failedAt: new Date(),
    ...(failedTurn?.userPrompt !== undefined ? { task: failedTurn.userPrompt } : {}),
    ...(opts.continuations !== undefined ? { continuations: opts.continuations } : {}),
    retryOffer: offer,
    ...(failedTurn ? { retryTurnId: failedTurn.turnId } : {}),
    ...(mentionOpenId ? { mentionOpenId } : {}),
    terminalUrl: readableTerminalUrlFor(ds),
    locale: localeForBot(ds.larkAppId),
  });
}

/** Attach the crash-safe timer owner for one eligible ordinary Claude/Lark
 * session. Session state is persisted; this runtime registry only owns timers. */
export function ensureOrdinaryTurnRecoveryAttached(
  ds: DaemonSession,
  botCfg = getBot(ds.larkAppId).config,
): boolean {
  if (!ordinaryTurnRecoveryEligible(ds, botCfg)) {
    disposeOrdinaryTurnRecovery(ds.session);
    return false;
  }
  attachOrdinaryTurnRecovery(ds.session, {
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      timer.unref?.();
      return timer;
    },
    cancel: timer => clearTimeout(timer),
    persist: () => sessionStore.updateSession(ds.session),
    enqueue: (dispatch: OrdinaryTurnRecoveryDispatch) => {
      if (!ordinaryTurnRecoveryEligible(ds) || !ordinaryTurnRecoveryStillOwnsSession(ds)) return false;
      try {
        if (!ds.worker || ds.worker.killed || ds.worker.connected === false) {
          return forkWorker(ds, dispatch.prompt, {
            resume: true,
            turnId: dispatch.turnId,
          });
        }
        return sendWorkerInput(ds, dispatch.prompt, dispatch.turnId);
      } catch (err) {
        logger.error(
          `[${tag(ds)}] Failed to enqueue ordinary-turn recovery `
          + `${dispatch.continuation}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    },
    warn: state => {
      const warning = ordinaryTurnRecoveryWarning(state, localeForBot(ds.larkAppId));
      ds.agentAttention = {
        kind: 'blocked',
        reason: warning,
        at: state.alertSentAt ?? Date.now(),
      };
      publishAttentionPatch(ds);
      emitSessionLifecycleHook(ds, 'session.requires_attention', {
        reason: 'ordinary_turn_recovery_exhausted',
        errorCode: state.lastErrorCode,
        logicalTurnId: state.logicalTurnId,
      });
      void requireCallbacks().sessionReply(
        sessionAnchorId(ds),
        buildSessionTurnFailedCard(ds, {
          status: 'failed',
          ...(state.lastErrorCode !== undefined ? { errorCode: state.lastErrorCode } : {}),
          // recovery 走到 warn 一定是「自动续跑救不回来」，把已试次数摊给用户，
          // 免得他以为系统什么都没做。
          continuations: state.continuationsStarted,
          // 这条路径的 retryable 已经在 coordinator 里判过并否掉了（否则不会
          // warn），所以按钮的安全性交给 errorCode 白名单判断，不再谎称 safe。
        }),
        'interactive',
        ds.larkAppId,
        state.logicalTurnId,
      ).catch(err => logger.error(
        `[${tag(ds)}] Failed to deliver ordinary-turn recovery warning: `
        + `${err instanceof Error ? err.message : String(err)}`,
      ));
    },
  });
  const restored = ds.session.ordinaryTurnRecovery;
  if (restored?.alertSentAt
    && (restored.status === 'exhausted' || restored.status === 'attention_required')) {
    ds.agentAttention = {
      kind: 'blocked',
      reason: ordinaryTurnRecoveryWarning(restored, localeForBot(ds.larkAppId)),
      at: restored.alertSentAt,
    };
    publishAttentionPatch(ds);
  }
  return true;
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

/**
 * Keep `session.model` — the record of what this session was last LAUNCHED with —
 * in sync with the model just resolved for a (re)spawn.
 *
 * The record is never the launch source of truth (see resolveSessionLaunchModel);
 * it exists so the CLI-mismatch fallback has something to fall back ON after the
 * bot switches CLI: a session pinned to the old CLI would otherwise lose its
 * model and drop to the CLI default. Not every entry point that hot-swaps
 * `bot.config.cliId` (`/botconfig set cli`, the config card) runs the dashboard's
 * closeCliMismatchedSessionsForBot sweep, so such sessions do survive to respawn.
 *
 * MUST be called from every path that resolves a launch model — daemon refork
 * AND the in-worker respawns (restart IPC / crash-park retry) — or the record
 * silently keeps an older model and a later CLI switch resurrects it.
 *
 * A per-trigger override is deliberately NOT recorded: it is one-shot by
 * contract, and persisting it is exactly the mistake the frozen model was.
 */
function recordLaunchModel(ds: DaemonSession, model: string | undefined): void {
  if (ds.spawnModelOverride) return;
  if (ds.session.model === model) return;
  ds.session.model = model;   // undefined clears a stale record
  sessionStore.updateSession(ds.session);
}

function sessionAgentConfig(
  ds: DaemonSession,
  botCfg: { cliId: CliId; cliRuntime?: CliRuntimeConfig; cliPathOverride?: string; wrapperCli?: string; model?: string; reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'; launchShell?: string; startupCommands?: string[]; env?: Record<string, string>; backendType?: string; riff?: unknown; codexRpcInput?: boolean },
): { cliId: CliId; cliRuntime?: CliRuntimeSnapshot; cliPathOverride?: string; wrapperCli?: string; model?: string; reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'; launchShell?: string; startupCommands?: string[] } {
  const selected = ds.session.cliLaunchSnapshot;
  if (selected) {
    if (selected.cliId.toLowerCase() === 'riff') throw new Error('CLI selection rejected: Riff requires bot-level backend configuration and cannot be selected per session');
    if (botCfg.env && Object.keys(botCfg.env).length > 0) throw new Error('CLI selection rejected: bot env is configured');
    if (botCfg.backendType === 'riff' || botCfg.riff !== undefined) throw new Error('CLI selection rejected: Riff is configured');
    if (botCfg.codexRpcInput === true && !RPC_CAPABLE_CLIS.has(selected.cliId)) {
      throw new Error(`CLI selection rejected: ${selected.cliId} cannot use codexRpcInput`);
    }
    const runtime = selected.cliRuntime ?? undefined;
    const legacyPath = selected.cliPathOverride ?? undefined;
    const wrapperCli = selected.wrapperCli ?? undefined;
    const reasoningEffort = selected.reasoningEffort ?? undefined;
    const launchShell = selected.launchShell ?? undefined;
    const startupCommands = [...selected.startupCommands];
    if (selected.state === 'pending') {
      selected.state = 'resolved';
      ds.session.cliId = selected.cliId;
      ds.session.cliRuntime = runtime;
      ds.session.cliPathOverride = legacyPath;
      ds.session.wrapperCli = wrapperCli;
      ds.session.reasoningEffort = reasoningEffort;
      ds.session.agentFrozen = true;
      sessionStore.updateSession(ds.session);
    }
    // Model is NOT frozen from the snapshot (which carries none): resolve it live
    // like every other spawn (#773) AFTER cliId is stamped, so resolveSessionLaunchModel
    // compares against the selected CLI. Cross-CLI (the /cli use case) → cliMatchesBot
    // is false → no bot model leaks to a different CLI; same-CLI keeps the bot's model
    // and stays consistent with in-place restarts (latestModelForRespawn), which never
    // pass through this snapshot branch. spawnModelOverride is honored automatically.
    const model = resolveSessionLaunchModel(ds, botCfg);
    recordLaunchModel(ds, model);
    return { cliId: selected.cliId, cliRuntime: runtime, cliPathOverride: legacyPath, wrapperCli, model, reasoningEffort, launchShell, startupCommands };
  }
  // Freeze the agent launch config (cli / runtime / cliPath / wrapper) onto the
  // session the first time a worker forks, so later bot-level edits never
  // retroactively change a live session — same discipline as `sandbox`.
  //
  // `model` is deliberately NOT part of the frozen set (see the return below):
  // swapping the CLI *distribution* under a live conversation is what this
  // freeze protects against (a `ttadk codex` wrapper degrading to bare `codex`
  // loses its gateway), whereas the model is an explicit, human-chosen bot
  // setting whose whole point is to take effect. Freezing it made a long
  // session ignore the model configured in the dashboard forever, i.e. an
  // inherited default silently outranked a later explicit choice.
  //
  // Gated on `agentFrozen`, NOT on `resume`: a session created before these
  // fields existed has `cliId` stamped historically but no frozen wrapper,
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
    ds.session.reasoningEffort = isConfigurableReasoningCliId(ds.session.cliId)
      ? ds.session.reasoningEffort ?? botCfg.reasoningEffort
      : undefined;
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
  // Resolved at EVERY spawn, resume included — see resolveSessionLaunchModel.
  const model = resolveSessionLaunchModel(ds, botCfg);
  recordLaunchModel(ds, model);
  // Effort is frozen per session, but whether it is *supported* depends on the
  // model this spawn actually uses — which is resolved live above, not frozen.
  if (ds.session.reasoningEffort
      && !cliModelSupportsReasoningEffort(ds.session.cliId, model, ds.session.reasoningEffort)) {
    ds.session.reasoningEffort = undefined;
    sessionStore.updateSession(ds.session);
  }
  return {
    cliId: ds.session.cliId ?? botCfg.cliId,
    cliRuntime: ds.session.cliRuntime,
    cliPathOverride: ds.session.cliPathOverride,
    wrapperCli: ds.session.wrapperCli,
    model,
    reasoningEffort: ds.session.reasoningEffort,
    launchShell: botCfg.launchShell,
    startupCommands: botCfg.startupCommands,
  };
}

/** @internal test-only: exercise sessionAgentConfig's launch-config resolution
 * (incl. the /cli cliLaunchSnapshot branch's live model resolution) directly,
 * without spawning a real worker. */
export const __testOnly_sessionAgentConfig = sessionAgentConfig;


export { freezeMojoIdentityForSession } from './mojo-session-identity.js';

/**
 * Freeze the control-plane identity of every restored mojo session at daemon
 * startup, instead of waiting for each one's next worker fork.
 *
 * The lazy path left a window: after a restart but before a session was next
 * woken, an operator could change the bot's endpoint/workspace, and the session
 * would then adopt THAT as its "original" identity — pairing a remote lineage
 * created on tenant A with tenant B. Migrating during restore closes it, because
 * restore runs before the dispatcher can deliver a message.
 *
 * A legacy row that already holds a remote lineage cannot be migrated safely (no
 * record of its original control plane), so sessionMojoConfig drops that lineage;
 * this pass reuses the same helper so both entry points behave identically.
 */
export function migrateMojoSessionIdentities(activeSessions: Map<string, DaemonSession>): void {
  let migrated = 0;
  for (const ds of activeSessions.values()) {
    const backendType = ds.initConfig?.backendType ?? ds.session.backendType;
    if (backendType !== 'mojo') continue;
    if (ds.session.mojoIdentity) continue;
    let botCfg;
    try {
      botCfg = getBot(ds.larkAppId).config;
    } catch {
      // Bot deregistered — no config to freeze from. Leave the row untouched so a
      // later re-registration can migrate it.
      continue;
    }
    void botCfg;
    freezeMojoIdentityForSession(ds.session, ds.larkAppId);
    migrated += 1;
  }
  if (migrated > 0) {
    logger.info(`[mojo] froze the control-plane identity of ${migrated} restored session(s)`);
  }
}

/**
 * READ-ONLY frozen launch identity, for teardown paths that must not mutate the
 * session (sessionAgentConfig freezes and writes to the session store).
 *
 * Reads the values frozen at session creation, exactly like a live spawn would.
 * Only a legacy session that was never frozen (`agentFrozen` unset) falls back to
 * the live bot config, mirroring sessionAgentConfig's back-fill.
 *
 * This matters for cancelling an orphaned remote session: the remote session was
 * created through THIS session's wrapper/binary, so cancelling it through a
 * wrapper the bot gained later can hit the wrong gateway or tenant. And because
 * `agentFrozen=true` with `wrapperCli=undefined` explicitly means "frozen as
 * no-wrapper", inheriting a later-added wrapper would break that contract.
 */
function frozenSessionLaunchIdentity(
  ds: DaemonSession,
  botCfg: { cliPathOverride?: string; wrapperCli?: string },
): { cliPathOverride?: string; wrapperCli?: string } {
  if (ds.session.agentFrozen) {
    return {
      cliPathOverride: ds.session.cliPathOverride,
      wrapperCli: ds.session.wrapperCli,
    };
  }
  // Legacy, never frozen: it was launching off the live bot config, so that is
  // the faithful reconstruction.
  return {
    cliPathOverride: ds.session.cliPathOverride ?? botCfg.cliPathOverride,
    wrapperCli: ds.session.wrapperCli ?? botCfg.wrapperCli,
  };
}

/**
 * Resolve the mojo config a session must run on, freezing its control-plane
 * identity the first time and honouring that snapshot forever after.
 *
 * Split by purpose:
 *   - identity (cloud / localDaemon / baseUrl / ppeEnv / workspaceId / agentId)
 *     comes from the FROZEN snapshot. A live edit must not move an existing
 *     session between execution modes or tenants — a cold resume would continue,
 *     and `/close` would cancel, against an endpoint that never created it.
 *   - credentials (jwt / jwtEnv / env) and behaviour knobs (stream /
 *     systemPrompt / idleTimeoutSec) stay LIVE, so a rotated token takes effect
 *     and no plaintext JWT is persisted into session state.
 *
 * `freeze` is false on read-only paths (workerless cancel) so teardown never
 * mutates session state; a session that predates this field then simply runs on
 * live config, exactly as it did before.
 */
/**
 * Resolve the mojo config a session must run on, plus whether its remote lineage
 * may still be used.
 *
 * Returns an explicit state rather than a bare config, because "we have a config"
 * and "this lineage is safe to resume/cancel" are different questions and
 * conflating them is what let a cancel reach the wrong tenant:
 *   - `usable`      — identity is frozen (or freshly frozen); lineage is trusted
 *   - `quarantined` — legacy row with a remote lineage but no frozen identity.
 *                     Nothing records which control plane holds it, so it must not
 *                     be resumed or cancelled automatically.
 *   - `none`        — legacy row with no lineage at all; nothing at risk.
 *
 * Identity (cloud / localDaemon / baseUrl / ppeEnv / workspaceId / agentId) comes
 * from the FROZEN snapshot; credentials (jwt / jwtEnv / env) and behaviour knobs
 * stay LIVE so a rotated token takes effect and no plaintext JWT is persisted.
 *
 * `freeze` is false on read-only paths (workerless cancel) so teardown never
 * mutates session state.
 */
export function sessionMojoConfig(
  ds: DaemonSession,
  botCfg: { mojo?: MojoConfig },
  opts: { freeze: boolean },
): { config: MojoConfig; lineage: 'usable' | 'quarantined' | 'none' } {
  const live = botCfg.mojo ?? {};
  const liveIdentity = pickMojoSessionIdentity(live);

  if (!ds.session.mojoIdentity) {
    // Legacy row, never frozen. Delegate to the shared helper rather than
    // duplicating the freeze/quarantine rules — two copies of this had already
    // started to drift. `undefined` means "predates this field"; an empty object
    // means "frozen with nothing configured", which is why the helper persists
    // `{}` instead of skipping it.
    if (opts.freeze) {
      freezeMojoIdentityForSession(ds.session, ds.larkAppId);
    } else if (ds.session.riffParentTaskId) {
      // Read-only path (teardown): the row still has an unverifiable lineage and
      // we must not write, so report it without mutating.
      return { config: live, lineage: 'quarantined' };
    }
    // Fall through: the helper may have frozen an identity just now, so re-derive
    // the answer from the (possibly updated) row below.
  }

  if (!ds.session.mojoIdentity) {
    // Still unfrozen — the bot was deregistered, so there is nothing to freeze
    // from. Behave as before: usable only if there is no lineage at risk.
    return {
      config: live,
      lineage: ds.session.riffParentTaskId ? 'quarantined' : 'none',
    };
  }

  const frozen = ds.session.mojoIdentity;
  const drift = diffMojoSessionIdentity(frozen, liveIdentity);
  if (drift.length > 0) {
    // Loud on purpose: the operator changed the control plane and this session is
    // deliberately NOT following, which is otherwise invisible.
    logger.warn(
      `[${tag(ds)}] mojo control-plane config changed after session creation; `
      + `keeping the frozen identity (${drift.join(', ')}). `
      + 'Start a new session to use the new configuration.',
    );
  }
  // Live credentials/behaviour, frozen identity.
  const merged: Record<string, unknown> = { ...live };
  for (const key of MOJO_IDENTITY_KEYS) {
    const value = (frozen as Record<string, unknown>)[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  // Upgrade guard (review F1): an identity frozen by a pre-host-default build
  // recorded "localDaemon unset" while double-unset still MEANT the cloud
  // sandbox. Resuming it through the new default would silently flip the
  // session cloud→host — the exact transition the freeze exists to prevent,
  // and the drift log stays silent because frozen and live are both `{}`.
  // Pin those rows to the legacy behaviour; a new session adopts the new
  // default and gets stamped mojoIdentityHostDefault by the freeze helper.
  if ((frozen as Record<string, unknown>).localDaemon === undefined
      && ds.session.mojoIdentityHostDefault !== true) {
    merged.localDaemon = false;
    logger.warn(
      `[${tag(ds)}] mojo identity predates the host-execution default; pinning `
      + 'localDaemon=false (legacy sandbox behaviour) for this session. '
      + 'Close and reopen the session to adopt the new default.',
    );
    // A daemon-log line alone leaves the USER staring at a session where tools
    // and replies silently fail (observed live: the operator retried a pinned
    // session twice believing the new build was broken). Queue the in-chat
    // notice; the next turn with a reply context delivers it once.
    if (ds.session.mojoLegacyPinNoticePending === undefined) {
      ds.session.mojoLegacyPinNoticePending = true;
      // Best-effort persistence: sessionMojoConfig sits on paths that MUST
      // survive an unwritable store (the workerless orphan-cancel chain is
      // explicitly tested for it). A failed save only costs notice dedupe
      // across a restart — the in-memory flag still delivers this run.
      try {
        sessionStore.updateSession(ds.session);
      } catch (err) {
        logger.warn(
          `[${tag(ds)}] could not persist the mojo legacy-pin notice flag `
          + `(will still deliver this run): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  // Quarantine is bound to a specific ID, not to the session.
  //
  // Once an identity is frozen, any lineage created AFTERWARDS was created on that
  // known control plane and is therefore trustworthy. Treating the session as
  // permanently quarantined meant a new session could never be cancelled after its
  // worker died — it kept consuming cloud sandbox time and holding credentials.
  // The parked id remains as an audit record only.
  const active = ds.session.riffParentTaskId;
  const lineage = active === undefined
    ? 'none'
    : (active === ds.session.mojoQuarantinedLineage ? 'quarantined' : 'usable');
  return { config: merged as MojoConfig, lineage };
}

function loadKnownBotOpenIdsForApp(larkAppId: string): Set<string> {
  const dataDir = config.session.dataDir;
  const crossRef = readPeerCrossRef(dataDir, larkAppId);

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
  return cliId === 'mira' || cliId === 'mir' || cliId === 'dsh';
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

/** 失败兜底卡片（turnFailed final_output）的兜底 @ 对象。仅当会话没有任何真人
 *  footer 收件人时使用（典型：bot-to-bot 派发的 ownerless 会话遇到模型网关故障，
 *  没人被 @，故障静默滑过）——回退到 bot 管理员（首个已授权真人 open_id，与
 *  「缺权限警告私信对象」同口径）。返回 undefined = 没有可 @ 的真人，不加提及。 */
function failureNoticeFallbackMentionOpenId(ds: DaemonSession): string | undefined {
  const admin = getOwnerOpenId(ds.larkAppId);
  if (!admin) return undefined;
  try {
    // 管理员名单里混入 bot open_id 时不 @：卡片里 @ 一个 bot 会触发它的新一轮，
    // 失败通知不该产生二次派发。fail closed。
    if (loadKnownBotOpenIdsForApp(ds.larkAppId).has(admin)) return undefined;
  } catch { /* cross-ref 读取失败 → 仍然 @ 配置的管理员（admin 名单本就是真人为主） */ }
  return admin;
}

export function clearUsageLimitState(ds: DaemonSession): void {
  if (ds.usageLimitRetryTimer) {
    clearTimeout(ds.usageLimitRetryTimer);
    ds.usageLimitRetryTimer = undefined;
  }
  ds.usageLimit = undefined;
  // Re-arm the proactive rate-limit notification latch: the next limit episode
  // (even one with the same usageLimitStateKey) must notify the owner again.
  ds.rateLimitNotifiedKey = undefined;
  persistStreamCardState(ds);
}

export function cardUsageLimit(ds: DaemonSession): CliUsageLimitState | undefined {
  return ds.lastScreenStatus === 'limited' ? ds.usageLimit : undefined;
}

function scheduleUsageLimitCardPatch(ds: DaemonSession): void {
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
    isSharedAdoptSession(ds),
    false,
    localeForBot(ds.larkAppId),
    ds.usageLimit,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, bot.config),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
    silentIdleCardFlag(ds),
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

/**
 * Resolve the daemon-side screen status in the presence of a usage limit.
 *
 * Limit state is intentionally sticky across ticks that carry no fresh verdict
 * (the worker re-emits only while the limit text stays on screen; screenshot
 * ticks arrive every 10s), so a recorded limit survives ordinary idle frames
 * and the cooldown card stays up until the user retries. But it must
 * self-heal on evidence of active work: a blocked CLI does not produce
 * `working`/`analyzing` frames, so a limit that survives such a frame was a
 * false positive (a flicker-frame screen scan, or a structured emit the CLI
 * recovered from). Without this the card keeps showing 「限额已达」 for the
 * rest of the turn even though the CLI is demonstrably still running — the
 * reported 误报. The worker-side status gate (detectScreenUsageLimit) prevents
 * the detection while active; this is the daemon-side net for limits recorded
 * during an idle flicker before work resumed.
 */
function resolveUsageAwareScreenStatus(
  ds: DaemonSession,
  workerStatus: ScreenStatus,
  freshUsageLimit: CliUsageLimitState | undefined,
): ScreenStatus {
  if (freshUsageLimit) return 'limited';
  if (ds.usageLimit && isActiveWorkRuntimeStatus(workerStatus)) {
    clearUsageLimitState(ds);
    return workerStatus;
  }
  return ds.usageLimit ? 'limited' : workerStatus;
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
 * Freeze the destination used by one streaming-card POST before dispatch.
 * A POST may await the Lark API while another turn replaces
 * `currentReplyTarget`; callers must commit this captured key rather than
 * re-reading mutable session state after the request resolves.
 */
function captureStreamingCardReplyTarget(
  ds: DaemonSession,
  turnId?: string,
): { turnId: string | undefined; replyTargetKey: string } {
  const effectiveTurnId = fallbackTurnId(ds, turnId);
  const replyContext = frozenReplyContextForTurn(ds, effectiveTurnId);
  return {
    turnId: effectiveTurnId,
    replyTargetKey: replyTargetKey(replyContext.target),
  };
}

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
    replyTargetKey: ds.streamCardReplyTargetKey,
    content: ds.lastScreenContent ?? '',
    title: ds.currentTurnTitle ?? '',
    displayMode: ds.displayMode ?? 'hidden',
    imageKey: ds.currentImageKey,
    ...(silentIdleCardFlag(ds) ? { silentIdle: true } : {}),
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
 * Delete previously-frozen streaming cards from the live card's visible Lark
 * destination and clear those entries from the cache.
 * Called whenever a new streaming card becomes the active one — old turns'
 * cards just add visual clutter when scrolling that destination's history.
 * A chat-scope session may answer in several Lark topics; cards from another
 * topic remain frozen until a successor is posted in that same topic.
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
  const activeReplyTargetKey = ds.streamCardReplyTargetKey;
  const targets: string[] = [];
  for (const [nonce, fc] of [...ds.frozenCards.entries()]) {
    if (activeId && fc.messageId === activeId) continue;
    // Legacy sessions have no destination key. Preserve the old sweep-all
    // behavior only while the live card is also legacy. Once a new card has an
    // exact destination, fail safe: never withdraw an unattributed card that
    // may be visible in another topic.
    if (activeReplyTargetKey && fc.replyTargetKey !== activeReplyTargetKey) continue;
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

/** A streaming-card id is only meaningful once a real Lark message id has
 * replaced the in-flight posting sentinel.  Keep this narrow: this policy is
 * called solely from streamCardId lifecycle paths, never arbitrary cards. */
function isRealStreamingCardId(messageId: string | undefined): messageId is string {
  return typeof messageId === 'string' && messageId.length > 0 && messageId !== CARD_POSTING_SENTINEL;
}

function snapshotStreamingCardIds(ds: DaemonSession): string[] {
  if (!ds.frozenCards) {
    try { ds.frozenCards = loadFrozenCards(ds.session.sessionId); } catch (err) {
      logger.debug(`[${tag(ds)}] could not load frozen cards for Pin cleanup: ${err instanceof Error ? err.message : String(err)}`);
      ds.frozenCards = new Map();
    }
  }
  const ids = new Set<string>();
  if (isRealStreamingCardId(ds.streamCardId)) ids.add(ds.streamCardId);
  for (const frozen of ds.frozenCards.values()) {
    if (isRealStreamingCardId(frozen.messageId)) ids.add(frozen.messageId);
  }
  return [...ids];
}

function snapshotStreamingCardPredecessorIds(
  ds: DaemonSession,
  currentMessageId: string,
): string[] {
  return snapshotStreamingCardIds(ds).filter(id => id !== currentMessageId);
}

const ownedStreamingCardRegistry = new Map<string, Set<string>>();
const streamingCardMutationQueues = new Map<string, Promise<unknown>>();
const pendingPinStreamingCardTasks = new Set<Promise<void>>();
// Test resets deliberately drop process-local provenance while old network work
// may still settle.  The epoch prevents that retired work from forgetting an
// identically-named card recorded by the replacement test/session state.
let ownedStreamingCardRegistryEpoch = 0;

function trackPinStreamingCardTask(task: Promise<void>): void {
  let tracked!: Promise<void>;
  tracked = task.then(
    () => { pendingPinStreamingCardTasks.delete(tracked); },
    () => { pendingPinStreamingCardTasks.delete(tracked); },
  );
  pendingPinStreamingCardTasks.add(tracked);
}

type StreamingCardOwner = Pick<DaemonSession, 'larkAppId'> & {
  session?: Pick<Session, 'sessionId'>;
  sessionId?: string;
};

function ownedStreamingCardRegistryKey(ds: StreamingCardOwner): string {
  return `${ds.session?.sessionId ?? ds.sessionId ?? ''}:${ds.larkAppId}`;
}

function messageMutationQueueKey(larkAppId: string, messageId: string): string {
  return `${larkAppId}:${messageId}`;
}

function rememberOwnedStreamingCard(ds: StreamingCardOwner, messageId: string): void {
  if (!isRealStreamingCardId(messageId)) return;
  const key = ownedStreamingCardRegistryKey(ds);
  let ids = ownedStreamingCardRegistry.get(key);
  if (!ids) {
    ids = new Set();
    ownedStreamingCardRegistry.set(key, ids);
  }
  ids.add(messageId);
}

function forgetOwnedStreamingCard(ds: StreamingCardOwner, messageId: string): void {
  if (!isRealStreamingCardId(messageId)) return;
  const key = ownedStreamingCardRegistryKey(ds);
  const ids = ownedStreamingCardRegistry.get(key);
  ids?.delete(messageId);
  if (ids?.size === 0) ownedStreamingCardRegistry.delete(key);
}

function ownedStreamingCardIds(ds: StreamingCardOwner): string[] {
  const ids = ownedStreamingCardRegistry.get(ownedStreamingCardRegistryKey(ds));
  if (!ids || ids.size === 0) return [];
  return [...ids].filter(isRealStreamingCardId);
}

function queueStreamingCardMessageMutation<T>(
  larkAppId: string,
  messageId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = messageMutationQueueKey(larkAppId, messageId);
  const previous = streamingCardMutationQueues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(task);
  const tail = operation.catch(() => undefined);
  streamingCardMutationQueues.set(key, tail);
  void tail.finally(() => {
    if (streamingCardMutationQueues.get(key) === tail) {
      streamingCardMutationQueues.delete(key);
    }
  });
  return operation;
}

function retainsLarkStreamingCardTransport(ds: DaemonSession): boolean {
  return retainsLarkStreamingCardTransportFor(ds.larkAppId, ds.chatId);
}

function retainsLarkStreamingCardTransportFor(larkAppId: string, chatId: string): boolean {
  try {
    return larkTransportEnabled({ chatId, apiOnly: getBot(larkAppId).config.apiOnly });
  } catch {
    return false;
  }
}

function ownsActiveStreamingCardRegistrySlot(ds: DaemonSession): boolean {
  if (!activeSessionsRegistry) return false;
  const key = sessionKey(sessionAnchorId(ds), ds.larkAppId);
  return activeSessionsRegistry.get(key) === ds;
}

/** Identity captured before posting a streaming card. A successful HTTP POST is
 * not a lifecycle commit: the route can be replaced while it is in flight. */
export type StreamingCardPublicationFence = {
  session: DaemonSession['session'];
  larkAppId: string;
  anchorId: string;
  /** The live id expected while this POST is in flight. For resume reposts this
   * is the prior card id: it must remain current until the fresh card commits. */
  expectedPriorCardId: string | undefined;
};

/** Positive commit fence for a card whose POST has returned. This deliberately
 * fails closed when the active registry is absent or empty: only the exact
 * captured route may publish a card, delete its predecessor, or emit a
 * receipt. */
export function canCommitStreamingCardPublication(
  ds: DaemonSession,
  fence: StreamingCardPublicationFence,
): boolean {
  if (ds.session !== fence.session || ds.session.status !== 'active') return false;
  if (ds.larkAppId !== fence.larkAppId || sessionAnchorId(ds) !== fence.anchorId) return false;
  if (ds.streamCardId !== fence.expectedPriorCardId || isSessionTransferring(ds)) return false;
  if (remoteRetirementAdmissionPhase(ds) !== null || !retainsLarkStreamingCardTransport(ds)) return false;
  return activeSessionsRegistry?.get(sessionKey(fence.anchorId, fence.larkAppId)) === ds;
}

function ownsCurrentStreamingCard(ds: DaemonSession, messageId: string): boolean {
  if (!isRealStreamingCardId(messageId)) return false;
  if (ds.session.status !== 'active' || ds.streamCardId !== messageId || isSessionTransferring(ds)) return false;
  if (remoteRetirementAdmissionPhase(ds) !== null || !retainsLarkStreamingCardTransport(ds)) return false;
  return ownsActiveStreamingCardRegistrySlot(ds);
}

function pinStreamingCardEnabled(ds: DaemonSession): boolean {
  return pinStreamingCardEnabledFor(ds.larkAppId, ds.chatId);
}

function pinStreamingCardEnabledFor(larkAppId: string, chatId?: string): boolean {
  try {
    const config = getBot(larkAppId).config;
    if (config.pinStreamingCard !== true) return false;
    if (chatId && config.noPinStreamingCardChats?.includes(chatId)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Pin provenance is intentionally process-local.  A bot that never opted in
 * must not alter an operator's manual Pin merely because a message happens to
 * be a current/frozen streaming card.  Once opted in, cards visible in the
 * current lifecycle snapshot are safe to retire even if a prior process did
 * not retain the in-memory provenance.
 */
function captureLifecycleStreamingCardCleanupIds(
  larkAppId: string,
  chatId: string,
  owner: StreamingCardOwner,
  knownIds: readonly string[],
): string[] {
  if (!retainsLarkStreamingCardTransportFor(larkAppId, chatId)) return [];
  const ids = new Set(ownedStreamingCardIds(owner));
  if (pinStreamingCardEnabledFor(larkAppId, chatId)) {
    for (const id of knownIds) {
      if (isRealStreamingCardId(id)) ids.add(id);
    }
  }
  return [...ids];
}

/** Pin exactly the current public streaming card.  Pin is deliberately outside
 * the publication success boundary: every failure is swallowed and a late
 * success is compensated with an Unpin of the captured id. */
export async function pinStreamingCardIfEnabled(
  ds: DaemonSession,
  messageId: string,
): Promise<boolean> {
  if (!pinStreamingCardEnabled(ds) || !ownsCurrentStreamingCard(ds, messageId)) return false;
  const appId = ds.larkAppId;
  const operation = queueStreamingCardMessageMutation(appId, messageId, async () => {
    if (!pinStreamingCardEnabled(ds) || !ownsCurrentStreamingCard(ds, messageId)) return false;
    try {
      const pinned = await pinMessage(appId, messageId);
      if (!pinned) return false;
      if (pinStreamingCardEnabled(ds) && ownsCurrentStreamingCard(ds, messageId)) {
        rememberOwnedStreamingCard(ds, messageId);
        return true;
      }
      try {
        // Direct call is required: this callback already runs inside this
        // messageId's mutation queue. Requeueing through
        // unpinStreamingCardIds() would wait on itself forever.
        const unpinned = await unpinMessage(appId, messageId);
        if (unpinned) forgetOwnedStreamingCard(ds, messageId);
      } catch {
        /* stale Pin compensation is best-effort */
      }
    } catch (err) {
      logger.debug(`[${tag(ds)}] streaming-card Pin failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  });
  trackPinStreamingCardTask(operation.then(() => undefined));
  return operation;
}

async function unpinStreamingCardIds(
  larkAppId: string,
  ids: readonly string[],
  owner?: StreamingCardOwner,
): Promise<string[]> {
  const succeeded: string[] = [];
  for (const messageId of ids) {
    const ownershipEpoch = ownedStreamingCardRegistryEpoch;
    const operation = queueStreamingCardMessageMutation(larkAppId, messageId, async () => {
      try {
        const unpinned = await unpinMessage(larkAppId, messageId);
        if (unpinned) {
          if (owner && ownershipEpoch === ownedStreamingCardRegistryEpoch) {
            forgetOwnedStreamingCard(owner, messageId);
          }
          return messageId;
        }
      } catch (err) {
        logger.debug(`[${larkAppId}] streaming-card Unpin failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    });
    trackPinStreamingCardTask(operation.then(() => undefined));
    const unpinnedId = await operation;
    if (unpinnedId) succeeded.push(unpinnedId);
  }
  return succeeded;
}

/** Fire-and-forget Pin QoL chain. Primary publication effects (recall,
 * readiness flushes, timers, successor scheduling) must NOT be delayed by
 * this best-effort API work. */
/**
 * Continue the best-effort Pin work for an already committed streaming-card
 * publication.  Callers must not await this: publication-side effects such as
 * predecessor recall and user receipts are deliberately independent from the
 * Lark Pin API.
 */
export function continuePublishedStreamingCardPinChain(
  ds: DaemonSession,
  messageId: string,
  predecessorIds: readonly string[] = snapshotStreamingCardPredecessorIds(ds, messageId),
): void {
  if (!pinStreamingCardEnabled(ds) || !ownsCurrentStreamingCard(ds, messageId)) return;
  trackPinStreamingCardTask((async () => {
    if (await pinStreamingCardIfEnabled(ds, messageId) && ownsCurrentStreamingCard(ds, messageId)) {
      await unpinStreamingCardIds(ds.larkAppId, predecessorIds, ds);
    }
  })().catch((err) => {
    logger.debug(`[${tag(ds)}] streaming-card Pin chain failed: ${err instanceof Error ? err.message : String(err)}`);
  }));
}

type ReconcileStreamingCardPinMode =
  | { enabled: true }
  | { enabled: false };

/** Reconcile one session after an opt-in setting transition.  Frozen cards are
 * session-wide here (Pins are chat-wide); recallFrozenCards remains topic-aware. */
export async function reconcileStreamingCardPins(
  ds: DaemonSession,
  enabledOrMode: boolean | ReconcileStreamingCardPinMode,
): Promise<void> {
  if (!retainsLarkStreamingCardTransport(ds)) return;
  const mode: ReconcileStreamingCardPinMode = typeof enabledOrMode === 'boolean'
    ? { enabled: enabledOrMode }
    : enabledOrMode;
  const { enabled } = mode;
  const cleanupIds = ownedStreamingCardIds(ds);
  const currentId = isRealStreamingCardId(ds.streamCardId) ? ds.streamCardId : undefined;
  try {
    if (enabled) {
      const frozenIds = snapshotStreamingCardIds(ds).filter(id => id !== currentId);
      if (currentId && await pinStreamingCardIfEnabled(ds, currentId)) {
        await unpinStreamingCardIds(ds.larkAppId, frozenIds, ds);
      }
      return;
    }
    if (cleanupIds.length === 0) return;
    await unpinStreamingCardIds(ds.larkAppId, cleanupIds, ds);
  } catch (err) {
    logger.debug(`[${tag(ds)}] streaming-card Pin reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type PendingBotStreamingCardReconcileRequest = {
  enabled: boolean;
  chatId?: string;
  authoritativeCleanupBySession: Map<string, { chatId: string; ids: string[] }>;
};

type PendingBotStreamingCardReconcile = {
  pending: PendingBotStreamingCardReconcileRequest[];
  running: boolean;
};

const pendingBotStreamingCardReconciles = new Map<string, PendingBotStreamingCardReconcile>();
const BOT_STREAMING_CARD_RECONCILE_BATCH_SIZE = 20;

function snapshotBotStreamingCardReconcileSessions(larkAppId: string): DaemonSession[] {
  if (!activeSessionsRegistry) return [];
  const sessions = new Map<string, DaemonSession>();
  for (const ds of activeSessionsRegistry.values()) {
    if (ds.larkAppId !== larkAppId) continue;
    if (ds.session.status !== 'active') continue;
    if (isSessionTransferring(ds)) continue;
    const key = sessionKey(sessionAnchorId(ds), ds.larkAppId);
    if (activeSessionsRegistry.get(key) !== ds) continue;
    sessions.set(ds.session.sessionId, ds);
  }
  return [...sessions.values()];
}

async function drainBotStreamingCardReconcileQueue(larkAppId: string): Promise<void> {
  const state = pendingBotStreamingCardReconciles.get(larkAppId);
  if (!state || state.running) return;
  state.running = true;
  try {
    while (true) {
      const request = state.pending.shift();
      if (!request) break;
      const { enabled, chatId, authoritativeCleanupBySession } = request;
      // An on->off transition grants authority over the exact card IDs visible
      // at that transition.  This work must not depend on a later active-registry
      // lookup: close/removal can happen while an earlier reconcile request is
      // still draining.  Do not resolve a session again here; a reused session
      // id or a replacement current card must never expand this cleanup scope.
      const authoritativeCleanup = [...authoritativeCleanupBySession]
        .map(([sessionId, { chatId, ids }]) => ({
          owner: { larkAppId, sessionId },
          chatId,
          ids: [...new Set(ids.filter(isRealStreamingCardId))],
        }))
        .filter(({ ids }) => ids.length > 0);
      for (let offset = 0; offset < authoritativeCleanup.length; offset += BOT_STREAMING_CARD_RECONCILE_BATCH_SIZE) {
        const batch = authoritativeCleanup.slice(offset, offset + BOT_STREAMING_CARD_RECONCILE_BATCH_SIZE);
        await Promise.allSettled(batch.map(async ({ owner, chatId, ids }) => {
          try {
            if (!retainsLarkStreamingCardTransportFor(larkAppId, chatId)) return;
            await unpinStreamingCardIds(larkAppId, ids, owner);
          } catch {
            /* captured cleanup remains fail-open */
          }
        }));
      }
      const sessions = snapshotBotStreamingCardReconcileSessions(larkAppId);
      const targetSessions = chatId === undefined
        ? sessions
        : sessions.filter(ds => ds.chatId === chatId);
      for (let offset = 0; offset < targetSessions.length; offset += BOT_STREAMING_CARD_RECONCILE_BATCH_SIZE) {
        const batch = targetSessions.slice(offset, offset + BOT_STREAMING_CARD_RECONCILE_BATCH_SIZE);
        await Promise.allSettled(
          batch.map(async (ds) => {
            try {
              const effectiveEnabled = enabled && pinStreamingCardEnabledFor(ds.larkAppId, ds.chatId);
              await reconcileStreamingCardPins(
                ds,
                effectiveEnabled ? { enabled: true } : { enabled: false },
              );
            } catch {
              /* per-session reconciliation remains fail-open */
            }
          }),
        );
      }
    }
  } finally {
    state.running = false;
    if (pendingBotStreamingCardReconciles.get(larkAppId) === state) {
      if (state.pending.length === 0) {
        pendingBotStreamingCardReconciles.delete(larkAppId);
      } else {
        void drainBotStreamingCardReconcileQueue(larkAppId);
      }
    }
  }
}

function snapshotAuthoritativeCleanupIdsForChat(
  larkAppId: string,
  chatId: string,
): Map<string, { chatId: string; ids: string[] }> {
  return new Map(
    snapshotBotStreamingCardReconcileSessions(larkAppId)
      .filter(ds => ds.chatId === chatId)
      .map(ds => [ds.session.sessionId, { chatId: ds.chatId, ids: snapshotStreamingCardIds(ds) }]),
  );
}

function snapshotAuthoritativeCleanupIdsForBotWideOff(
  larkAppId: string,
): Map<string, { chatId: string; ids: string[] }> {
  let disabledChats: string[] | undefined;
  try {
    disabledChats = getBot(larkAppId).config.noPinStreamingCardChats;
  } catch {
    disabledChats = undefined;
  }
  return new Map(
    snapshotBotStreamingCardReconcileSessions(larkAppId)
      .filter(ds => !disabledChats?.includes(ds.chatId))
      .map(ds => [ds.session.sessionId, { chatId: ds.chatId, ids: snapshotStreamingCardIds(ds) }]),
  );
}

/** Fire-and-forget bot-wide reconciliation so configuration mutation remains
 * responsive even when Lark Pin APIs are slow or unavailable. */
export function reconcileBotStreamingCardPins(
  larkAppId: string,
  enabled: boolean,
  chatId?: string,
  chatEnabled?: boolean,
): void {
  const state = pendingBotStreamingCardReconciles.get(larkAppId);
  const authoritativeCleanupBySession = chatId !== undefined
    ? chatEnabled === false
      ? snapshotAuthoritativeCleanupIdsForChat(larkAppId, chatId)
      : new Map<string, { chatId: string; ids: string[] }>()
    : enabled === false
      ? snapshotAuthoritativeCleanupIdsForBotWideOff(larkAppId)
      : new Map<string, { chatId: string; ids: string[] }>();
  const request: PendingBotStreamingCardReconcileRequest = {
    enabled,
    chatId,
    authoritativeCleanupBySession,
  };
  if (state) {
    state.pending.push(request);
    if (!state.running) trackPinStreamingCardTask(drainBotStreamingCardReconcileQueue(larkAppId));
    return;
  }
  pendingBotStreamingCardReconciles.set(larkAppId, {
    pending: [request],
    running: false,
  });
  trackPinStreamingCardTask(drainBotStreamingCardReconcileQueue(larkAppId));
}

export function __testOnly_resetPinStreamingCardReconcileQueue(): void {
  pendingBotStreamingCardReconciles.clear();
  ownedStreamingCardRegistryEpoch += 1;
  ownedStreamingCardRegistry.clear();
  streamingCardMutationQueues.clear();
  pendingPinStreamingCardTasks.clear();
}

export async function __testOnly_waitForPinStreamingCardIdle(): Promise<void> {
  while (pendingPinStreamingCardTasks.size > 0) {
    await Promise.allSettled([...pendingPinStreamingCardTasks]);
  }
}

/** The first visible state for a newly accepted turn.
 *
 * `starting` is a process/session lifecycle state. A live Grok worker that
 * accepts another turn is already past startup, so surface the turn as working
 * immediately. The worker's structured lifecycle gate will later publish the
 * authoritative terminal state from updates.jsonl.
 */
export function turnStartingCardStatus(ds: DaemonSession, effectiveCliId: CliId): 'limited' | 'working' | 'starting' {
  if (ds.usageLimit) return 'limited';
  if (effectiveCliId === 'grok' && workerHasInitialized(ds)) return 'working';
  return 'starting';
}

/** Incremented for every worker status observation, including same-value edges.
 * A screen update can land while the Feishu starting-card POST is in flight;
 * the revision lets the POST completion distinguish that from the pre-turn
 * cached idle state and immediately reconcile the newly-created card. */
function bumpStreamCardStatusRevision(ds: DaemonSession): void {
  ds.streamCardStatusRevision = (ds.streamCardStatusRevision ?? 0) + 1;
}

/** Re-render a just-created starting card when a newer worker status arrived
 * during its POST. The turn id is forwarded to scheduleCardPatch so a late
 * patch from turn N cannot overwrite turn N+1's card. */
function reconcilePostedStartingCard(ds: DaemonSession, turnId: string | undefined, revisionAtPost: number): void {
  if ((ds.streamCardStatusRevision ?? 0) === revisionAtPost) return;
  if (!ds.streamCardId || ds.streamCardId === CARD_POSTING_SENTINEL || ds.streamCardPending) return;
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const status = ds.usageLimit ? 'limited' : (ds.lastScreenStatus ?? turnStartingCardStatus(ds, effectiveCliId));
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
    isSharedAdoptSession(ds),
    false,
    localeForBot(ds.larkAppId),
    status === 'limited' ? ds.usageLimit : undefined,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId, { fresh: status === 'idle' }),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
    silentIdleCardFlag(ds),
  );
  scheduleCardPatch(ds, cardJson, turnId);
}

/**
 * Post the current turn's starting card as soon as the daemon accepts the
 * inbound message. Terminal redraw is deliberately not part of this trigger:
 * some CLIs consume a turn without emitting another screen_update, which used
 * to leave streamCardPending stuck and suppress cards for every later turn.
 *
 * Only one POST may be in flight per session. If another turn arrives during
 * the request, the generation check preserves that newer pending state and
 * immediately follows with its card after the first POST settles.
 */
export async function postTurnStartingCard(
  ds: DaemonSession,
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string, turnId?: string) => Promise<string>,
  turnId: string,
): Promise<boolean> {
  if (!ds.streamCardPending || ds.streamCardPendingTurnId !== turnId) return false;
  if (remoteRetirementAdmissionPhase(ds)) return false;
  if (ds.streamCardId === CARD_POSTING_SENTINEL) return false;
  if (streamingCardDisabled(ds, turnId)) return false;
  if (!workerHasInitialized(ds)) return false;
  if (!larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })) return false;

  const generation = ds.streamCardTurnGeneration ?? 0;
  const sessionAtPost = ds.session;
  const larkAppIdAtPost = ds.larkAppId;
  const anchorAtPost = sessionAnchorId(ds);
  const registryKeyAtPost = sessionKey(anchorAtPost, larkAppIdAtPost);
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  const previousCardId = ds.streamCardId;
  const previousNonce = ds.streamCardNonce;
  const previousReplyTargetKey = ds.streamCardReplyTargetKey;
  const cardReplyTarget = captureStreamingCardReplyTarget(ds, turnId);
  // A newer turn may have arrived while the previous turn's POST was still in
  // flight, so beginNewTurn could not park that sentinel. Park the now-live
  // predecessor here before replacing its identity.
  parkStreamCard(ds);
  const nonce = randomBytes(4).toString('hex');
  const status = turnStartingCardStatus(ds, effectiveCliId);
  const statusRevisionAtPost = ds.streamCardStatusRevision ?? 0;
  const cardJson = buildStreamingCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    readableTerminalUrlFor(ds),
    ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg),
    '',
    status,
    effectiveCliId,
    ds.displayMode ?? 'hidden',
    nonce,
    undefined,
    isSharedAdoptSession(ds),
    false,
    localeForBot(ds.larkAppId),
    ds.usageLimit,
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
    silentIdleCardFlag(ds),
  );

  ds.streamCardNonce = nonce;
  ds.streamCardId = CARD_POSTING_SENTINEL;
  const ownsPostIdentity = (): boolean =>
    ds.session === sessionAtPost
    && ds.session.status === 'active'
    && ds.larkAppId === larkAppIdAtPost
    && sessionAnchorId(ds) === anchorAtPost
    && !isSessionTransferring(ds)
    && ds.streamCardId === CARD_POSTING_SENTINEL
    && ds.streamCardNonce === nonce
    && activeSessionsRegistry?.get(registryKeyAtPost) === ds;
  const stillOwnsPost = (): boolean =>
    ownsPostIdentity() && remoteRetirementAdmissionPhase(ds) === null;
  const restorePrePostIdentityForRetirement = (): boolean => {
    if (remoteRetirementAdmissionPhase(ds) === null || !ownsPostIdentity()) return false;
    ds.streamCardId = previousCardId;
    ds.streamCardNonce = previousNonce;
    ds.streamCardReplyTargetKey = previousReplyTargetKey;
    persistStreamCardState(ds);
    return true;
  };
  try {
    const messageId = await sessionReply(
      anchorAtPost, cardJson, 'interactive', larkAppIdAtPost, cardReplyTarget.turnId,
    );
    if (!stillOwnsPost()) {
      void deleteMessage(larkAppIdAtPost, messageId).catch(() => { /* best-effort stale-card cleanup */ });
      restorePrePostIdentityForRetirement();
      logger.info(`[${tag(ds)}] Discarded stale starting card for turn ${turnId.substring(0, 12)}`);
      return false;
    }
    ds.streamCardId = messageId;
    ds.streamCardReplyTargetKey = cardReplyTarget.replyTargetKey;
    ds.parkedStreamCardNonce = undefined;
    const superseded = (ds.streamCardTurnGeneration ?? 0) !== generation;
    if (!superseded) {
      ds.streamCardPending = false;
      ds.streamCardPendingTurnId = undefined;
    }
    const predecessorIds = snapshotStreamingCardPredecessorIds(ds, messageId);
    persistStreamCardState(ds);
    recallFrozenCards(ds);
    flushPendingLocalCliOpenReadinessPatch(ds);
    flushPendingRiffUrlPatch(ds);
    flushPendingActiveRuntimePatch(ds);
    flushPendingCodexServiceTierPatch(ds);
    syncUsageRefreshTimer(ds);
    reconcilePostedStartingCard(ds, turnId, statusRevisionAtPost);
    logger.info(`[${tag(ds)}] Posted starting card for turn ${turnId.substring(0, 12)}`);
    continuePublishedStreamingCardPinChain(ds, messageId, predecessorIds);
    if ((ds.streamCardTurnGeneration ?? 0) !== generation && ds.streamCardPendingTurnId) {
      void postTurnStartingCard(ds, sessionReply, ds.streamCardPendingTurnId);
    }
    return true;
  } catch (err) {
    if (!stillOwnsPost()) {
      restorePrePostIdentityForRetirement();
      logger.info(`[${tag(ds)}] Ignored stale starting-card failure for turn ${turnId.substring(0, 12)}`);
      return false;
    }
    ds.streamCardId = previousCardId;
    ds.streamCardNonce = previousNonce;
    ds.streamCardReplyTargetKey = previousReplyTargetKey;
    persistStreamCardState(ds);
    logger.warn(`[${tag(ds)}] Failed to post starting card for turn ${turnId.substring(0, 12)}: ${err}`);
    if ((ds.streamCardTurnGeneration ?? 0) !== generation && ds.streamCardPendingTurnId) {
      void postTurnStartingCard(ds, sessionReply, ds.streamCardPendingTurnId);
    }
    return false;
  }
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
  if (isDocNativeSession(ds)) return false;
  if (!workerHasInitialized(ds)) return false;
  if (remoteRetirementAdmissionPhase(ds)) return false;
  if (!retainsLarkStreamingCardTransport(ds)) return false;
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
  const prevReplyTargetKey = ds.streamCardReplyTargetKey;
  const prevPending = ds.streamCardPending;
  const sessionAtPost = ds.session;
  const appIdAtPost = ds.larkAppId;
  const anchorAtPost = sessionAnchorId(ds);
  const registryKeyAtPost = sessionKey(anchorAtPost, appIdAtPost);
  const cardReplyTarget = captureStreamingCardReplyTarget(ds);

  const postingNonce = randomBytes(4).toString('hex');
  ds.streamCardNonce = postingNonce;
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
    isSharedAdoptSession(ds),
    false,
    localeForBot(ds.larkAppId),
    cardUsageLimit(ds),
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
    silentIdleCardFlag(ds),
  );
  ds.streamCardId = CARD_POSTING_SENTINEL;
  const ownsPost = (): boolean =>
    ds.session === sessionAtPost
    && ds.session.status === 'active'
    && ds.larkAppId === appIdAtPost
    && sessionAnchorId(ds) === anchorAtPost
    && !isSessionTransferring(ds)
    && ds.streamCardId === CARD_POSTING_SENTINEL
    && ds.streamCardNonce === postingNonce
    && activeSessionsRegistry?.get(registryKeyAtPost) === ds;
  const restorePrePostIdentityForRetirement = (): boolean => {
    if (remoteRetirementAdmissionPhase(ds) === null || !ownsPost()) return false;
    ds.streamCardId = prevCardId;
    ds.streamCardNonce = prevNonce;
    ds.streamCardReplyTargetKey = prevReplyTargetKey;
    ds.streamCardPending = prevPending;
    persistStreamCardState(ds);
    return true;
  };
  const stillOwnsPost = (): boolean =>
    ownsPost()
    && remoteRetirementAdmissionPhase(ds) === null
    && retainsLarkStreamingCardTransport(ds);
  try {
    const messageId = await sessionReply(
      anchorAtPost, cardJson, 'interactive', appIdAtPost, cardReplyTarget.turnId,
    );
    if (!stillOwnsPost()) {
      void deleteMessage(appIdAtPost, messageId).catch(() => { /* stale result */ });
      restorePrePostIdentityForRetirement();
      return false;
    }
    ds.streamCardId = messageId;
    ds.streamCardReplyTargetKey = cardReplyTarget.replyTargetKey;
    // This card is now the live one for the current turn. Clear the new-turn
    // pending flag so the next screen_update PATCHes it instead of POSTing a
    // duplicate (the gate above only suppresses cards when disabled+unforced;
    // /card forces them on, so a stale pending flag would otherwise re-POST).
    ds.streamCardPending = false;
    ds.parkedStreamCardNonce = undefined;
    const predecessorIds = snapshotStreamingCardPredecessorIds(ds, messageId);
    persistStreamCardState(ds);
    recallFrozenCards(ds);
    flushPendingLocalCliOpenReadinessPatch(ds);
    flushPendingRiffUrlPatch(ds);
    flushPendingActiveRuntimePatch(ds);
    flushPendingCodexServiceTierPatch(ds);
    // Manual /card during a working turn lands a live card whose subsequent
    // screen_updates are working→working (no status edge) — arm the periodic
    // usage refresh here, now that the real id is committed and pending cleared.
    syncUsageRefreshTimer(ds);
    logger.info(`[${tag(ds)}] Posted streaming card via /card`);
    continuePublishedStreamingCardPinChain(ds, messageId, predecessorIds);
    return true;
  } catch (err) {
    if (stillOwnsPost()) {
      ds.streamCardId = prevCardId;
      ds.streamCardNonce = prevNonce;
      ds.streamCardReplyTargetKey = prevReplyTargetKey;
      ds.streamCardPending = prevPending;
    } else {
      restorePrePostIdentityForRetirement();
    }
    flushPendingLocalCliOpenReadinessPatch(ds);
    flushPendingRiffUrlPatch(ds);
    flushPendingActiveRuntimePatch(ds);
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
      isSharedAdoptSession(ds),
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
    isSharedAdoptSession(ds), // shared adopt — disconnect, never close the source conversation
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
    isSharedAdoptSession(ds),
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
 * IMPORTANT: ephemeral is only attempted for a flat **chat-scope** destination. The
 * ephemeral API (`ephemeral/v1/send`) takes a `chat_id` only — it has no
 * thread/root anchoring — so for a **thread-scope** session (a 话题 inside a
 * 普通群, or a 话题群 topic) an ephemeral card would escape the topic and land at
 * the group top-level. The same applies when a chat-scope session is invoked
 * from a folded thread: callers pass its frozen reply target, and any explicit
 * thread/quote destination takes the visible `reply()` path.
 */
export async function deliverEphemeralOrReply(
  ds: DaemonSession,
  operatorOpenId: string | undefined,
  content: string,
  msgType: 'text' | 'interactive',
  reply: () => Promise<unknown>,
  replyTarget?: FrozenSessionReplyTarget,
): Promise<void> {
  // A chat-scope session can still be invoked from a folded thread. The
  // ephemeral API has no root/thread field, so an explicitly frozen thread or
  // quote target must take the visible reply path even though the session
  // itself remains chat-scoped.
  const allowsEphemeral = replyTarget
    ? replyTarget.mode === 'plain'
    : ds.scope === 'chat';
  if (operatorOpenId && ds.chatType !== 'p2p' && allowsEphemeral) {
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
  let patchSucceeded = false;
  updateMessage(ds.larkAppId, cardId, json)
    .then(() => {
      patchSucceeded = true;
    })
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
      // A re-render can queue the exact same state while this PATCH is in
      // flight. Drop only that adjacent duplicate after confirmed delivery.
      // Failed PATCHes deliberately retain the queued item so it retries, and
      // cardId participates in the comparison so a new turn's card is never
      // mistaken for the card that just completed.
      if (patchSucceeded
        && ds.pendingCardId === cardId
        && ds.pendingCardJson === json) {
        ds.pendingCardJson = undefined;
        ds.pendingCardId = undefined;
      }
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
 * Ensure built-in skills are installed for a given CLI. Synchronous and
 * idempotent. Two cadences:
 *   - Skill FILES (whiteboard / workflow family / built-in skills) are
 *     re-evaluated on EVERY spawn, before the `skillsInstalledCliIds` gate, so
 *     runtime switches (whiteboard, workflow) and user customization (skill body
 *     override / disable) take effect on the next session without a restart.
 *   - Hook install + botmux-ask fallback do not vary at runtime, so they run
 *     once per CLI per daemon lifecycle (behind the gate).
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
    // Workflow skill 家族同理：跟随机器级 workflow 开关，每次 spawn 重新评估，
    // 关闭时删除已装的三个 skill，下一个会话即生效。
    ensureWorkflowSkills(cliId, pluginSkillsDir, isWorkflowFeatureEnabled());
    // 内置 skill 文件跟随用户自定义（正文覆盖 / 停用），必须每次 spawn 重新落盘
    // ——与上面白板 / workflow 同样放在 once-cache 之前，否则改了 skill 正文或
    // 停用某 skill 后，claude 家族（--plugin-dir）的新会话仍读旧文件、要等 daemon
    // 重启才生效，和自定义页「下一个会话即生效」不符。ensureSkills 幂等（内容相同
    // 则跳过），每次 spawn 的代价只是几个小文件的读比对。
    ensurePluginSkills(cliId, adapter.pluginDir);
    if (skillsInstalledCliIds.has(cliId)) return;
    // Hook 接管与 botmux-ask 兜底 skill 不随自定义变化 → 每个 daemon 生命周期装一次即可。
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
  // Workflow skill 家族：仅 global 模式落全局盘，且跟随机器级 workflow 开关。
  // 非 global（prompt/off）由上面的 removeGlobalBotmuxSkills 前缀清理兜底。
  ensureWorkflowSkills(cliId, skillsDir, globalInstall && isWorkflowFeatureEnabled());
  if (!globalInstall && skillsDir) removeGlobalBotmuxSkills(skillsDir);
  // 内置 skill 文件跟随用户自定义（正文覆盖 / 停用），必须每次 spawn 重新落盘
  // ——同白板 / workflow 放在 once-cache 之前。global 模式落全局盘；幂等（内容相同
  // 则跳过），停用的 skill 目录会被 ensureSkills 内部清掉，下一个会话即生效。
  if (globalInstall) ensureSkills(cliId, skillsDir);

  if (skillsInstalledCliIds.has(cliId)) return;
  // 以下都不随自定义变化 → 每个 daemon 生命周期装一次即可。
  // askUserQuestion 接管策略与 skill 文件无关：hook 该装还得装（Codex 无 hook,
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

/**
 * Retire a session's worker (and, worker-less, its orphaned backing session).
 *
 * CONTRACT FOR REMOTE BACKENDS (riff / mojo): a LIVE remote worker is refused
 * unless the call carries the prepare/commit `remoteCloseCommitRequestId` —
 * the function RETURNS WITHOUT RETIRING and the worker keeps running. Callers
 * must not assume success. Today that refusal is absorbed differently per
 * call site:
 *   - /cd (IM + dashboard) rejects remote sessions BEFORE repinning, so this
 *     refusal is never reached from there;
 *   - the explicit-close path always carries the commit requestId;
 *   - crash-loop, collision-loser, VC restore/upgrade and device-isolation
 *     sweeps still call this best-effort and, for a live remote worker, keep
 *     the generation alive with its lineage intact (fail-safe: never a silent
 *     remote cancel). A caller that needs the worker GONE must go through
 *     prepare/commit or the shutdown-detach flow — not this function.
 */
export function killWorker(
  ds: DaemonSession,
  opts: {
    remoteCloseCommitRequestId?: string;
    /** Set by the authoritative mojo close once its cancel is PROVEN, so the
     *  best-effort orphan teardown below does not cancel the same session again. */
    mojoCancelAlreadyProven?: boolean;
  } = {},
): void {
  const closeFrozenType = ds.initConfig?.backendType ?? ds.session.backendType;
  if (ds.worker && !ds.worker.killed
      && closeFrozenType !== undefined
      && isRemoteBackendType(closeFrozenType)
      && !opts.remoteCloseCommitRequestId) {
    // A generic synchronous retirement cannot safely detach ANY remote backend,
    // not just Riff. An accepted create/follow-up may still be waiting for the
    // task id that becomes the only durable lineage anchor — and for Mojo the
    // worker's legacy close path used to answer a request-less `close` with
    // `mojo session cancel`, so every generic retirement (/cd cold restart,
    // crash-loop, collision loser, restore/upgrade) silently and irreversibly
    // cancelled the remote session with no close_result to carry the outcome.
    // Only the prepare/commit flow (remoteCloseCommitRequestId) may retire a
    // live remote worker.
    logger.error(
      `[${tag(ds)}] Refused unprepared live ${closeFrozenType} worker retirement; `
      + 'preserving worker and remote-task lineage',
    );
    return;
  }
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
    destroyOrphanedBackingSession(ds, {
      ...(opts.mojoCancelAlreadyProven ? { skipRemoteCancel: true } : {}),
    });
    if (opts.remoteCloseCommitRequestId
        && ds.remoteCloseState?.requestId === opts.remoteCloseCommitRequestId) {
      ds.remoteCloseState = undefined;
    }
    return;
  }
  try {
    if (opts.remoteCloseCommitRequestId) {
      ds.worker.send({
        type: 'close_commit',
        requestId: opts.remoteCloseCommitRequestId,
      } as DaemonToWorker);
    } else {
      ds.worker.send({ type: 'close' } as DaemonToWorker);
    }
  } catch { /* IPC already closed */ }
  if (opts.remoteCloseCommitRequestId
      && ds.remoteCloseState?.requestId === opts.remoteCloseCommitRequestId) {
    ds.remoteCloseState = undefined;
  }
  const w = ds.worker;
  trackLifecycleRetirement(ds, w);
  armCloseFence(ds, w);
  // riff：worker close 分支要有界 await 远端 task-cancel（destroySession 5s×2 重试，
  // 外层 race 8s）。默认 2s SIGTERM backstop 会在取消发出前掐死进程，已关闭话题
  // 的远端任务照跑——冻结为 riff 的会话放宽到 24s（层级：destroy 20s < worker 22s
  // < SIGTERM 24s < SIGKILL 29s；正常路径 worker 自行 exit，不会等满）。
  // mojo needs the same grace: destroySession() shells out to
  // `mojo session cancel` (CLI timeout up to 60s) and waits for an in-flight
  // turn to publish its lineage first, so 2s kills it before the cancel lands.
  const closeNeedsRemoteGrace = closeFrozenType !== undefined
    && isRemoteBackendType(closeFrozenType);
  armWorkerKillBackstop(w, tag(ds), closeNeedsRemoteGrace ? 24_000 : WORKER_SIGTERM_BACKSTOP_MS);
  ds.worker = null;
  ds.workerPort = null;
  ds.workerToken = null;
  ds.workerViewToken = null;
}

/**
 * Retire the worker PROCESS only — no close semantics of any kind.
 *
 * No `close` IPC (a request-less remote close is refused by the worker, and a
 * local one would destroy the backing session), no remote cancel, lineage and
 * containment handles intact. SIGTERM is sent immediately (the worker's
 * handler runs killCli() — for mojo that is backend.kill(), which by contract
 * never cancels the remote session) and armWorkerKillBackstop guarantees
 * SIGKILL if it wedges.
 *
 * For callers that must make a worker generation DIE while its logical/remote
 * state lives on: the collision loser (its registry entry is deleted right
 * after, so a refused killWorker left a live credential-carrying worker
 * unreachable — the P0-new orphan shape) and the VC runtime-lease fence
 * (which must prove the local producer process dead before admitting replay).
 */
export function retireWorkerProcessOnly(ds: DaemonSession, reason: string): void {
  restartCoordinator.cancelSession(ds.session.sessionId);
  clearUsageLimitState(ds);
  ds.workerReady = false;
  clearUsageRefreshTimer(ds);
  ds.localProcessAttestation = undefined;
  ds.managedTurnOrigin = undefined;
  invalidateStuckWarning(ds, reason);
  invalidateTuiPrompt(ds, reason);
  const w = ds.worker;
  if (w && !w.killed) {
    trackLifecycleRetirement(ds, w);
    try { w.kill('SIGTERM'); } catch { /* already gone */ }
    armWorkerKillBackstop(w, tag(ds));
  }
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
  ds: Pick<DaemonSession, 'initConfig' | 'adoptedFrom' | 'session'>,
): boolean {
  return !isSharedAdoptSession(ds);
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
 * 只热更 env / model 两个字段：sandbox/backendType 是刻意 freeze-once 的设计（见
 * forkWorker init 注释），cliId 换 CLI 会踩 resume transcript 对齐，均不带。
 */
export function latestPerBotEnvForRestart(ds: DaemonSession): Record<string, string> | null | undefined {
  // Two failure modes that must NOT be conflated. The old single try/catch
  // swallowed both, so a quarantine write failure silently returned `undefined`
  // (restart proceeds, risk unrecorded) — the exact fail-open this ledger exists
  // to prevent.
  let env: Record<string, string> | null;
  try {
    env = getBot(ds.larkAppId).config.env ?? null;
  } catch {
    // Bot deregistered: nothing to hot-update. Keep the worker's snapshot (legacy
    // behaviour) — this is a benign, expected state.
    return undefined;
  }
  // Record what this generation is being handed BEFORE the restart is sent.
  //
  // This is the single choke point all four restart senders share (dashboard-ipc
  // operator + working-dir, requestSessionRestart, cli_crash auto-restart), so
  // recording here cannot be missed by adding a fifth caller — which is exactly
  // how the device-isolation proof lost track of the env the running child had
  // actually been given.
  //
  // Accumulate, never replace: the restart may fail or be coalesced, so a later
  // clean env is not evidence that the dangerous child is gone.
  //
  // Any throw here propagates on purpose: the caller must not send a restart while
  // believing a risk was recorded when it was not.
  rememberAppliedUnprovableEnvKeys(ds, env ?? undefined);
  return env;
}

/**
 * Fold the unprovable keys of an env payload into the generation's ledger.
 *
 * Names only — the values can be credentials, and the proof only inspects names.
 * Exported for the restart-timeline tests, which must be able to assert the
 * ledger itself rather than infer it from a classifier result.
 */
export function rememberAppliedUnprovableEnvKeys(
  ds: DaemonSession,
  env: Record<string, string> | undefined,
): void {
  // MOJO ONLY. This choke point is shared by every backend's restart, so an
  // ungated call quarantined codex/tmux sessions as "mojo" forever: a bot with
  // LD_PRELOAD in bots.json env poisoned unrelated backends (cross-backend
  // contamination + permanent unprovability). The ledger exists solely to answer
  // "could a hooked MOJO client still be running", so only mojo may write to it.
  if (!isMojoSession(ds)) return;

  // BOTH env layers. `mojoUnprovableEnvKeys` is fed the top-level per-bot env AND
  // the mojo block's own env: they are peers (see the `init` message), the mojo
  // block wins the merge, and a dangerous key living only in `mojo.env` used to be
  // recorded nowhere — so it survived a daemon restart as "clean".
  const mojoBlockEnv = sessionMojoBlockEnv(ds);
  const keys = mojoUnprovableEnvKeys({ env: { ...(env ?? {}), ...mojoBlockEnv } });
  if (keys.length === 0) return;
  const merged = new Set([...(ds.mojoAppliedUnprovableEnvKeys ?? []), ...keys]);
  ds.mojoAppliedUnprovableEnvKeys = [...merged];
  // Also persist, because the in-memory ledger cannot answer the question after
  // a daemon restart or an explicit /close: the SIGTERM-ed mojo child (and any
  // detached descendants) can outlive both, while still holding an activated
  // credential. The durable record is keyed by session id and never retracted.
  const sessionId = ds.session?.sessionId;
  if (!sessionId) {
    // Cannot key the durable record without a session id. Never swallow this:
    // keeping the risk in memory only is the fail-open direction, and this branch
    // should be unreachable for a real DaemonSession.
    throw new Error(
      '[mojo-quarantine] refusing to lose an unprovable launcher env: session id missing'
      + ` (keys: ${keys.join(', ')})`,
    );
  }
  // Deliberately NOT wrapped in try/catch: a failed persist means the daemon
  // cannot prove this host is clean, and swallowing it would hand back a false
  // "recorded" to every restart sender.
  recordQuarantinedLauncherEnvKeys(sessionId, keys);
}

/** Is this session frozen onto the mojo backend? Prefers the live worker stamp. */
function isMojoSession(ds: DaemonSession): boolean {
  return (ds.initConfig?.backendType ?? ds.session?.backendType) === 'mojo';
}

/**
 * The mojo block's own `env`, from whichever layer the next turn will actually
 * use: the config frozen onto the live worker, else the live bot config.
 */
function sessionMojoBlockEnv(ds: DaemonSession): Record<string, string> {
  const fromInit = (ds.initConfig?.backendConfig as MojoConfig | undefined)?.env;
  if (fromInit) return fromInit;
  try {
    return getBot(ds.larkAppId).config.mojo?.env ?? {};
  } catch {
    return {};
  }
}

/**
 * Live-worker /restart 携带的最新模型（与 env 同一条通道、同一套三分态）。
 *
 * model 不进冻结集合、每次 spawn 按当前 bot 配置解析（见 resolveSessionLaunchModel），
 * 但 `/restart`、dashboard 重启、CLI 崩溃自动重启这三条路**不 refork**：worker 收到
 * restart 后用旧 `lastInitConfig` 原地 respawn。不捎带的话，改完模型再重启起来的还是
 * 旧模型——正是「改配置对存量会话生效」要修的那件事。
 * 三分态：字符串 = 用它；null = 明确不传模型（bot 未配 / 已清空）；
 * undefined = 取不到（bot 已注销等异常），让 worker 保持快照不动（=旧行为）。
 */
export function latestModelForRespawn(ds: DaemonSession): string | null | undefined {
  try {
    const model = resolveSessionLaunchModel(ds, getBot(ds.larkAppId).config);
    // An in-worker respawn IS a launch, so the rule-3 record must converge here
    // too — otherwise `/restart` starts B while the record still says A, and a
    // later CLI hot-switch pulls A back out of the record.
    recordLaunchModel(ds, model);
    return model ?? null;
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
      ds.worker.send({ type: 'restart', attemptId, env: latestPerBotEnvForRestart(ds), model: latestModelForRespawn(ds) } as DaemonToWorker);
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
/**
 * Build the launch config for cancelling a mojo session's remote lineage, or say
 * why it must not be attempted.
 *
 * Shared by the best-effort killWorker teardown and the awaited explicit-close
 * path so the two cannot cancel through DIFFERENT configs — the launch identity
 * and control plane decide which tenant the cancel reaches, so a second copy of
 * these rules drifting would silently cancel against the wrong endpoint.
 */
function resolveMojoCancelLaunch(
  ds: DaemonSession,
  remoteId: string,
  label: string,
): { ok: true; launchCfg: EffectiveMojoConfig } | { ok: false; reason: 'quarantined' | 'bot_gone' } {
  let botCfg;
  try {
    botCfg = getBot(ds.larkAppId).config;
  } catch {
    // Bot deregistered — nothing to cancel WITH. The caller decides what that
    // means; the explicit-close path treats it as a RETRYABLE refusal, because
    // re-registering the bot restores exactly the config this needs.
    logger.warn(
      `[${tag(ds)}] ${label}: cannot cancel mojo session ${remoteId} — bot `
      + `${ds.larkAppId} is deregistered. Lineage retained for manual cleanup.`,
    );
    return { ok: false, reason: 'bot_gone' };
  }
  // mojo needs no baseUrl gate — the CLI resolves its own endpoint, and an absent
  // `mojo` config block is a valid setup.
  //
  // Build the SAME effective config the worker would (shared helper): a bare
  // `botCfg.mojo` carries neither the pinned binary (cliPathOverride) nor the
  // per-bot env holding the JWT, so a bot that ran fine on a custom path/identity
  // would fail to cancel here — the remote session then keeps burning cloud
  // sandbox time while still holding injected credentials.
  //
  // The launch IDENTITY (binary + wrapper) must come from the values FROZEN on the
  // session, not from live bot config: the remote session was created through
  // those, so cancelling through a wrapper the bot gained afterwards can reach the
  // wrong gateway/tenant. Session cwd is not persisted for a dead worker, so that
  // one falls back to the bot's configured working dir.
  const frozenLaunch = frozenSessionLaunchIdentity(ds, botCfg);
  // freeze:false — teardown must not mutate session state. Cancel has to reach the
  // endpoint/tenant that CREATED the remote session, so the frozen control plane
  // matters here as much as the frozen binary.
  const frozenMojo = sessionMojoConfig(ds, botCfg, { freeze: false });
  // A quarantined lineage must NOT be cancelled: nothing records which control
  // plane holds it, so cancelling through the current config could reach a
  // different tenant. Callers capture `remoteId` BEFORE this call, so clearing the
  // field would not have stopped it — the explicit state is what makes the refusal
  // reliable.
  if (frozenMojo.lineage === 'quarantined') {
    logger.warn(
      `[${tag(ds)}] ${label}: NOT cancelling mojo session ${remoteId} — `
      + 'its control plane is unverifiable (quarantined). It is preserved on the '
      + 'session for manual cleanup.',
    );
    return { ok: false, reason: 'quarantined' };
  }
  return {
    ok: true,
    launchCfg: buildEffectiveMojoConfig(frozenMojo.config, {
      cliPathOverride: frozenLaunch.cliPathOverride,
      workingDir: ds.session.workingDir ?? botCfg.defaultWorkingDir ?? botCfg.workingDir,
      env: botCfg.env ? sanitizePerBotEnv(botCfg.env) : undefined,
      wrapperCli: frozenLaunch.wrapperCli,
    }),
  };
}

function destroyOrphanedBackingSession(
  ds: DaemonSession,
  opts: {
    /** The authoritative close already PROVED the remote cancel; firing the
     *  best-effort one again would cancel a second time (and, for an already-gone
     *  session, report a spurious failure). */
    skipRemoteCancel?: boolean;
  } = {},
): void {
  // Traditional `/adopt` observes a user-owned tmux/zellij/Herdr target and
  // must never destroy it. An App Server shared adopt is different: its
  // persistent bmx-* pane is BotMux's own `codex --remote` client, so reclaim
  // that pane while leaving the external App Server untouched.
  if (!isExistingAppServerSharedAdoptPersistedSession(ds.session)
      && isSharedAdoptSession(ds)) return;
  reclaimParkedCrashDiagnostic(ds);
  // Riff cancellation is asynchronous and cannot be made safe from this
  // synchronous best-effort helper. The authoritative closeSession path awaits
  // cancellation before publishing the closed row and retains lineage on
  // failure.
  const frozenType = ds.initConfig?.backendType ?? ds.session.backendType;
  if (frozenType === 'riff') {
    if (ds.session.riffParentTaskId) {
      logger.warn(
        `[${tag(ds)}] worker-less Riff teardown requires awaited explicit close; `
        + `retaining task ${ds.session.riffParentTaskId} for retry`,
      );
    }
    return;
  }
  if (frozenType === 'mojo') {
    // Remote backends persist their lineage in the same field riff uses.
    const remoteId = ds.session.riffParentTaskId;
    if (!remoteId || opts.skipRemoteCancel) return;
    const resolved = resolveMojoCancelLaunch(ds, remoteId, 'killWorker');
    if (!resolved.ok) return;
    // Best-effort ONLY. The authoritative /close path (prepareMojoExplicitClose)
    // awaits the same cancellation before publishing the closed row; this branch
    // exists for the killWorker callers that are not an explicit close (crash
    // retirement, transfer teardown), where there is no result to report to.
    //
    // Clear the lineage ONLY once the remote session is really gone. This used to
    // clear unconditionally right after firing, so a failed cancel erased the only
    // id — the exact leak master's riff change above calls out.
    void cancelMojoSessionById(resolved.launchCfg, remoteId).then((outcome) => {
      // Structured outcome, not a boolean — `if (!outcome)` would be always-false
      // and silently treat every failure as a success (an object is truthy).
      if (!isMojoRemoteGone(outcome)) {
        logger.warn(
          `[${tag(ds)}] killWorker: orphan mojo session ${remoteId} NOT cancelled; `
          + 'retaining the lineage — note nothing retries this automatically, so an '
          + 'explicit /close (which DOES await the cancel) or manual cleanup is required',
        );
        return;
      }
      logger.info(`[${tag(ds)}] killWorker: orphan mojo session ${remoteId} cancelled`);
      ds.session.riffParentTaskId = undefined;
      sessionStore.updateSession(ds.session);
    }).catch((err: unknown) => {
      // Defence in depth for a FIRE-AND-FORGET promise. This helper is
      // synchronous, so there is no caller to reject to: an escaping rejection
      // becomes an unhandledRejection, and the daemon installs no handler for
      // those (only worker.ts does), so Node v22 terminates the process --
      // taking down every OTHER session this daemon serves. The awaited call
      // site already guards itself the same way; tmux-pipe-backend.ts documents
      // a real incident of exactly this shape.
      //
      // Reachable, not theoretical: cancelMojoSessionById constructs a backend
      // before its own try block, so an unreadable containment store throws out
      // of it rather than returning the structured failure its type promises.
      // sessionStore.updateSession above can throw for the same reason (a failed
      // save). Both must degrade to a retained lineage, never to a crash.
      logger.error(
        `[${tag(ds)}] killWorker: orphan mojo cancel for ${remoteId} threw; `
        + `retaining the lineage for explicit /close or manual cleanup: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    });
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

type RemoteClosePreparation =
  | {
      ok: true;
      taskId?: string;
      residual?: CloseResidual;
      /** Move this still-uncancellable lineage into the PARKED slot as part of the
       *  durable close, so the residual decision survives and replays. */
      parkMojoLineage?: string;
    }
  | {
      ok: false;
      error:
        | 'riff_cancel_failed'
        | 'riff_config_missing'
        | 'riff_task_changed'
        | 'riff_worker_close_failed'
        | 'riff_row_inconsistent'
        | 'riff_durable_close_failed'
        | 'riff_close_reconciliation_required'
        | 'remote_shutdown_fence_in_progress'
        // mojo reuses this preparation contract: same problem (a remote,
        // credential-bearing session that must be proven gone before the row is
        // published as closed), same retryable-failure shape.
        | 'mojo_cancel_failed'
        | 'mojo_durable_close_failed'
        | 'mojo_close_reconciliation_required'
        /** Bot deregistered — retryable once it is registered again. */
        | 'mojo_config_missing'
        /** Durable lineage with no active owner to cancel through. */
        | 'mojo_close_identity_missing'
        /**
         * The remote teardown already happened irreversibly, but the local close
         * did not finish. ONLY the local commit may be retried.
         */
        | 'mojo_close_commit_required';
      /**
       * May the caller simply try the SAME close again?
       *
       * This was hardcoded `true`, which contradicted the tri-state it was
       * reporting: an `uncertain` prepare needs explicit reconciliation (a blind
       * retry cannot cancel a session nobody can name), and an `irreversible`
       * one must never re-run the remote cancel. `false` means "do not loop on
       * this; a human/reconciler decides".
       */
      retryable: boolean;
      /**
       * The exact worker verdict, when this refusal came from one. `retryable`
       * appears here too: a close whose WRITES stay fenced may still itself be
       * retryable, and flattening that into `uncertain` would demand manual
       * reconciliation for a failure the retry can clear.
       */
      recovery?: 'retryable' | 'uncertain' | 'irreversible';
      taskId?: string;
    };

async function abortLiveRemoteWorkerClose(
  ds: DaemonSession,
  requestId: string,
  opts: { allowAbsentAfterProvenRestore?: boolean } = {},
): Promise<boolean> {
  if (ds.remoteCloseState?.requestId !== requestId) return false;
  const worker = ds.worker;
  if (!worker || worker.killed) {
    if (opts.allowAbsentAfterProvenRestore) {
      ds.remoteCloseState = undefined;
      return true;
    }
    ds.remoteCloseState = { ...ds.remoteCloseState, phase: 'uncertain' };
    return false;
  }

  const restored = await new Promise<{
    ok: boolean;
    admissionRestored?: boolean;
    fenceReason?: string;
    error?: string;
  }>(resolve => {
    let settled = false;
    const finish = (result: {
      ok: boolean;
      admissionRestored?: boolean;
      fenceReason?: string;
      error?: string;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeListener?.('message', onMessage);
      worker.removeListener?.('exit', onExit);
      resolve(result);
    };
    const onMessage = (raw: unknown): void => {
      const msg = raw as WorkerToDaemon;
      if (msg?.type !== 'close_abort_result' || msg.requestId !== requestId) return;
      if (ds.worker !== worker) {
        finish({ ok: false, error: 'stale_worker_generation' });
        return;
      }
      // `ok` says the abort was HANDLED; `admissionRestored` says whether writes
      // actually came back. A backend holding a latched fence answers ok:true /
      // admissionRestored:false, and inferring restoration from `ok` journalled a
      // cleared fence while write() kept returning false. Absent means `ok`
      // (legacy backends, riff).
      finish({
        ok: msg.ok,
        admissionRestored: msg.admissionRestored ?? msg.ok,
        ...(msg.fenceReason ? { fenceReason: msg.fenceReason } : {}),
        ...(msg.error ? { error: msg.error } : {}),
      });
    };
    const onExit = (): void => finish({
      ok: false,
      error: 'worker_exited_before_close_abort_result',
    });
    const timer = setTimeout(
      () => finish({ ok: false, error: 'close_abort_result_timeout' }),
      REMOTE_ADMISSION_RESTORE_TIMEOUT_MS,
    );
    timer.unref?.();
    worker.on?.('message', onMessage);
    worker.once?.('exit', onExit);
    try {
      worker.send({ type: 'close_abort', requestId } as DaemonToWorker);
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // A handled-but-REFUSED abort must not clear the fence. `ok` alone did, which
  // is the same laundering as before, one path over.
  const admissionRestored = restored.ok && restored.admissionRestored !== false;
  if (admissionRestored && ds.remoteCloseState?.requestId === requestId) {
    ds.remoteCloseState = undefined;
    return true;
  }
  // A proven earlier restore excuses a MISSING ack, never a refused one: the
  // backend just told us writes are still fenced.
  if (opts.allowAbsentAfterProvenRestore
      && restored.admissionRestored !== false
      && ds.remoteCloseState?.requestId === requestId) {
    ds.remoteCloseState = undefined;
    return true;
  }
  if (ds.remoteCloseState?.requestId === requestId) {
    ds.remoteCloseState = { ...ds.remoteCloseState, phase: 'uncertain' };
  }
  logger.warn(
    `[${tag(ds)}] Remote close abort did not restore write admission `
    + `(${restored.fenceReason ?? restored.error ?? 'unknown'}); `
    + 'retaining admission fence pending explicit lineage reconciliation',
  );
  return false;
}

async function prepareLiveRemoteWorkerClose(
  ds: DaemonSession,
  backendType: 'riff' | 'mojo',
): Promise<RemoteClosePreparation> {
  const worker = ds.worker;
  if (!worker || worker.killed) {
    return {
      ok: false,
      error: backendType === 'riff' ? 'riff_worker_close_failed' : 'mojo_cancel_failed',
      retryable: true,
    };
  }
  if (backendType === 'mojo' && ds.remoteCloseState?.phase === 'abort_restored') {
    const restoredState = ds.remoteCloseState;
    try {
      const committed = sessionStore.finishMojoCloseAbort(
        ds.session.sessionId,
        restoredState.requestId,
        {
          admissionRestored: true,
          ...(restoredState.taskId ? { taskId: restoredState.taskId } : {}),
        },
      );
      ds.session.mojoCloseJournal = committed.mojoCloseJournal;
      ds.session.riffParentTaskId = committed.riffParentTaskId;
      ds.remoteCloseState = undefined;
    } catch (err) {
      logger.error(
        `[${tag(ds)}] Mojo admission restore proof could not clear the durable close journal: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        error: 'mojo_durable_close_failed',
        retryable: true,
        ...(restoredState.taskId ? { taskId: restoredState.taskId } : {}),
      };
    }
  }
  if (backendType === 'mojo' && ds.remoteCloseState?.phase === 'prepared') {
    try {
      const committed = sessionStore.markMojoClosePrepared(
        ds.session.sessionId,
        ds.remoteCloseState.requestId,
        ds.remoteCloseState.taskId,
        // The retry must republish the SAME proof, residual included — the
        // original prepare saw the local evidence grade; this replay did not.
        ds.remoteCloseState.localResidual,
      );
      ds.session.mojoCloseJournal = committed.mojoCloseJournal;
      ds.session.riffParentTaskId = committed.riffParentTaskId;
    } catch (err) {
      logger.error(
        `[${tag(ds)}] Mojo close proof could not be persisted for durable commit: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        error: 'mojo_durable_close_failed',
        retryable: true,
        ...(ds.remoteCloseState.taskId ? { taskId: ds.remoteCloseState.taskId } : {}),
      };
    }
    return {
      ok: true,
      ...(ds.remoteCloseState.taskId ? { taskId: ds.remoteCloseState.taskId } : {}),
      // Stored residual → derived at read time (see liveLocalResidual): the
      // journal write above still republishes the original proof verbatim.
      ...(residualField(liveLocalResidual(ds.session.sessionId, ds.remoteCloseState.localResidual))),
    };
  }
  if (ds.remoteShutdownState) {
    return {
      ok: false,
      error: 'remote_shutdown_fence_in_progress',
      retryable: true,
      ...(typeof ds.remoteShutdownState.taskId === 'string' && ds.remoteShutdownState.taskId
        ? { taskId: ds.remoteShutdownState.taskId }
        : {}),
    };
  }
  let takenOverRuntimeState: DaemonSession['remoteCloseState'];
  if (ds.remoteCloseState) {
    const runtimeUncertain = backendType === 'mojo'
      && ds.remoteCloseState.phase === 'uncertain';
    // A runtime `uncertain` fence used to be a dead end: "a blind retry proves
    // nothing" was true when the journal refused every restart, so /close
    // failed with retryable:false for the daemon's whole lifetime and the only
    // exit was a daemon restart — a process-level soft deadlock (third-round
    // review, gate 1). The retry is no longer blind: an explicit close with a
    // LIVE worker re-runs the full destroySession, which can produce fresh
    // evidence. When the runtime fence and the DURABLE journal describe the
    // same failed attempt — same phase, same requestId, same lineage — the
    // fence is cleared and the close re-enters prepare under a new requestId
    // (beginMojoCloseJournal accepts the uncertain takeover). Anything less
    // than an exact match keeps the refusal: a mismatched pair means runtime
    // and disk disagree about which attempt happened, and clearing on that
    // would launder an unknown state.
    const durableForTakeover = ds.session.mojoCloseJournal;
    // Three legs, each covering a REAL production writer of this pair
    // (fourth-round review named the two the exact-match version missed):
    //   phase   — the runtime fence is `uncertain` for every non-irreversible
    //             failed prepare, while the DURABLE phase differs by verdict:
    //             `uncertain` for an uncertain one, `preparing` (with
    //             recovery 'retryable') for a retryable-but-fenced one. Both
    //             pairs describe the same failed attempt; matching only
    //             uncertain/uncertain left retryable+fenced soft-deadlocked
    //             with a durable row that itself promises a retry (gap A).
    //   requestId — exact, always: both sides were written by that attempt.
    //   lineage — equal, or the durable side is a superset (the worker may
    //             have reported the pre-init lineage into the journal while
    //             the runtime fence kept none, gap B). A CONFLICTING pair
    //             still refuses: runtime and disk disagreeing about which
    //             remote session was touched must never be laundered.
    const durablePhaseMatches = durableForTakeover?.phase === 'uncertain'
      || (durableForTakeover?.phase === 'preparing'
        && durableForTakeover.recovery === 'retryable');
    const runtimeTaskId = ds.remoteCloseState.taskId ?? undefined;
    const durableTaskId = durableForTakeover?.taskId ?? undefined;
    const takeoverEligible = runtimeUncertain
      && durableForTakeover !== undefined
      && durablePhaseMatches
      && durableForTakeover.requestId === ds.remoteCloseState.requestId
      && (durableTaskId === runtimeTaskId || runtimeTaskId === undefined);
    if (takeoverEligible) {
      logger.warn(
        `[${tag(ds)}] explicit close takes over ${durableForTakeover.phase} Mojo journal `
        + `(${ds.remoteCloseState.requestId}); re-running the cancel through the live worker`,
      );
      // Cleared only in memory here; restored if the fresh attempt's durable
      // write below fails, so the runtime fence (and everything keyed on it,
      // e.g. the shutdown-detach explicit-close guard) never vanishes without
      // a successor journal actually on disk.
      takenOverRuntimeState = ds.remoteCloseState;
      ds.remoteCloseState = undefined;
    } else if (runtimeUncertain) {
      return {
        ok: false,
        error: 'mojo_close_reconciliation_required',
        retryable: false,
        recovery: 'uncertain',
        ...(ds.remoteCloseState.taskId ? { taskId: ds.remoteCloseState.taskId } : {}),
      };
    } else {
      return {
        ok: false,
        error: backendType === 'riff' ? 'riff_worker_close_failed' : 'mojo_cancel_failed',
        retryable: true,
        ...(ds.remoteCloseState.taskId ? { taskId: ds.remoteCloseState.taskId } : {}),
      };
    }
  }
  const requestId = randomUUID();
  if (backendType === 'mojo') {
    try {
      const committed = sessionStore.beginMojoCloseJournal(
        ds.session.sessionId,
        requestId,
        ds.session.riffParentTaskId,
      );
      ds.session.mojoCloseJournal = committed.mojoCloseJournal;
    } catch (err) {
      // Reinstate a runtime fence the takeover cleared: without this, a failed
      // durable write left the ds fence-less while disk still said uncertain,
      // and guards keyed on ds.remoteCloseState (shutdown-detach's
      // explicit-close check) silently lost their signal.
      if (takenOverRuntimeState) ds.remoteCloseState = takenOverRuntimeState;
      logger.error(
        `[${tag(ds)}] Mojo close journal could not be persisted before cancellation: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        error: 'mojo_durable_close_failed',
        retryable: true,
        ...(ds.session.riffParentTaskId ? { taskId: ds.session.riffParentTaskId } : {}),
      };
    }
  }
  ds.remoteCloseState = {
    phase: 'preparing',
    requestId,
    ...(ds.session.riffParentTaskId ? { taskId: ds.session.riffParentTaskId } : {}),
  };
  let matchedCloseResult = false;
  const result = await new Promise<RemoteWorkerCloseResult>((resolve) => {
    let settled = false;
    const finish = (value: RemoteWorkerCloseResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeListener?.('exit', onExit);
      pendingRemoteWorkerCloses.delete(requestId);
      resolve(value);
    };
    // The worker died mid-prepare, so whatever destroySession() had already done
    // is unknown -- including a completed irreversible cancel. Fence.
    const onExit = (): void => finish({
      ok: false,
      error: 'worker_exited_before_close_result',
      recovery: 'uncertain',
    });
    // Riff's adapter has its own 20s destroy deadline. Mojo may first spend 8s
    // waiting for system/init, then up to 60s in `mojo session cancel`; aborting
    // at the old 23s Riff budget re-opened admission while that irreversible
    // cancellation was still in flight. Stay above both bounded Mojo phases.
    const closeResultTimeoutMs = backendType === 'mojo'
      ? MOJO_EXPLICIT_CLOSE_RESULT_TIMEOUT_MS
      : 23_000;
    const timer = setTimeout(
      // A timed-out prepare may still be running remotely; the outcome is unknown.
      () => finish({ ok: false, error: 'worker_close_result_timeout', recovery: 'uncertain' }),
      closeResultTimeoutMs,
    );
    timer.unref?.();
    worker.once?.('exit', onExit);
    pendingRemoteWorkerCloses.set(requestId, {
      sessionId: ds.session.sessionId,
      worker,
      resolve: value => {
        matchedCloseResult = true;
        finish(value);
      },
    });
    try {
      worker.send({ type: 'close', requestId } as DaemonToWorker);
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const taskId = result.taskId ?? ds.session.riffParentTaskId;
  if (backendType === 'mojo') {
    if (result.ok) {
      try {
        const committed = sessionStore.markMojoClosePrepared(
          ds.session.sessionId,
          requestId,
          taskId,
          // Durable ON PURPOSE: the residual is part of the close outcome, and a
          // daemon restart replaying this prepared journal must still publish
          // `closed_with_residual` (only the worker saw the evidence grade).
          result.residual,
        );
        ds.session.mojoCloseJournal = committed.mojoCloseJournal;
        ds.session.riffParentTaskId = committed.riffParentTaskId;
      } catch (err) {
        // Cancellation is irreversible. The runtime proof stays prepared and
        // admission remains fenced; a retry republishes that same proof without
        // asking the worker to cancel twice — residual included, or the retry
        // would silently downgrade a residual close to a plain one. The durable
        // `preparing` journal makes a daemon crash fail closed rather than
        // resume this generation.
        ds.remoteCloseState = {
          phase: 'prepared',
          requestId,
          ...(taskId ? { taskId } : {}),
          ...(result.residual ? { localResidual: result.residual } : {}),
        };
        logger.error(
          `[${tag(ds)}] Mojo close proof persistence failed after cancellation; `
          + `retaining prepared commit: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          ok: false,
          error: 'mojo_durable_close_failed',
          retryable: true,
          ...(taskId ? { taskId } : {}),
        };
      }

      ds.remoteCloseState = {
        phase: 'prepared',
        requestId,
        ...(taskId ? { taskId } : {}),
        ...(result.residual ? { localResidual: result.residual } : {}),
      };
      logger.info(`[${tag(ds)}] mojo worker close prepared and remote cancellation confirmed`);
      // The remote lineage is confirmed cancelled, but that says nothing about the
      // LOCAL process tree. When the backend could not prove its subtree gone it
      // kept the containment handle, so this row must NOT be published as an
      // ordinary closed one: the device-isolation blocker is still live and an
      // operator reading "closed" would believe a credentialed process was gone.
      //
      // Kept distinct from the remote lineage residual on purpose. That one names a
      // surviving remote task id and asks for remote cleanup; this one names a host
      // subtree and asks for local cleanup, and collapsing them would send the
      // operator after the wrong thing. Hence no taskId here even when one exists —
      // the remote side really was cancelled.
      if (result.residual) {
        logger.warn(
          `[${tag(ds)}] mojo remote cancellation confirmed, but the LOCAL subtree was not `
          + `proven gone (${result.residual}); publishing a residual close so the `
          + 'device-isolation blocker stays visible',
        );
        return {
          ok: true,
          ...(taskId ? { taskId } : {}),
          residual: { reason: result.residual },
        };
      }
      return { ok: true, ...(taskId ? { taskId } : {}) };
    }

    // Only a REVERSIBLE failure may be rolled back. Sending close_abort for every
    // ok:false re-opened write admission after an `uncertain` verdict (an unnamed
    // remote session may exist) and after an `irreversible` one (the remote side is
    // already gone), which laundered both back into `retryable` end to end.
    const recovery = result.recovery ?? 'retryable';
    // Whether writes may be admitted is a DIFFERENT question from whether the
    // close may be retried. Keying the rollback on `recovery` re-opened admission
    // for an unproven local child termination (retryable, yet a credentialed
    // process may still be alive); absent `admission` keeps the historical
    // derivation so riff and older workers are unaffected.
    // Delegated to the shared helper rather than re-implementing the derivation:
    // two copies of this rule is how the daemon drifted back to reading
    // `recovery` and re-opened admission on a latched fence.
    const mayRestore = mayRestoreWriteAdmission({
      ok: false,
      ...(result.recovery ? { recovery: result.recovery } : {}),
      ...(result.admission ? { admission: result.admission } : {}),
    });
    if (!mayRestore) {
      // No abort: the runtime fence stays up, so the session remains active and
      // keeps its device-isolation blocker. But the DURABLE row must also stop
      // saying `preparing` with the pre-prepare task id -- a crash here left a
      // journal that could not be told apart from an interrupted cancel, and
      // silently discarded the exact lineage the worker just reported.
      const irreversible = recovery === 'irreversible';
      let journalled = false;
      try {
        const committed = sessionStore.markMojoCloseUnresolved(
          ds.session.sessionId,
          requestId,
          {
            recovery,
            // The EXACT id from close_result (the pre-init window means the worker
            // may be the first to know it), not the pre-prepare guess.
            ...(taskId ? { taskId } : {}),
            // Persisted verbatim and separately from `recovery`: no close_abort
            // was sent, so writes are still fenced even when the close itself is
            // retryable. Re-deriving this on restore is what re-opened admission.
            admission: 'fenced',
          },
        );
        ds.session.mojoCloseJournal = committed.mojoCloseJournal;
        ds.session.riffParentTaskId = committed.riffParentTaskId;
        journalled = true;
      } catch (err) {
        // Fail closed: keep the runtime fence exactly as strict as the disk state
        // is ambiguous. Never fall back to a rollback.
        logger.error(
          `[${tag(ds)}] Mojo ${recovery} close verdict could not be journalled: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // An irreversible teardown leaves ONLY the local commit outstanding, so the
      // runtime state must be `prepared` -- parking it at `uncertain` made every
      // retry bounce off the fence and the row could never be closed at all.
      // NOTE: the runtime phase deliberately stays `uncertain` for everything
      // that is not a journalled irreversible teardown. A retryable-but-fenced
      // close is recorded as `preparing` in the DURABLE journal (a restart may
      // retry the cancel), but within this process the reconciliation gate
      // refuses a retry either way, so distinguishing the runtime phase here
      // would be an untestable claim.
      ds.remoteCloseState = {
        phase: irreversible && journalled ? 'prepared' : 'uncertain',
        requestId,
        ...(taskId ? { taskId } : {}),
      };
      logger.error(
        `[${tag(ds)}] mojo worker close prepare failed as ${recovery} `
        + `(${result.error ?? 'unknown'}); admission stays fenced, `
        + `journal=${journalled ? ds.session.mojoCloseJournal?.phase ?? 'unknown' : 'unwritten'}`,
      );
      if (!journalled) {
        return {
          ok: false,
          error: 'mojo_durable_close_failed',
          retryable: true,
          recovery,
          ...(taskId ? { taskId } : {}),
        };
      }
      // Fenced but still retryable (an unproven LOCAL termination; the
      // irreversible remote cancel never ran). The close may be retried as a
      // close -- reporting it as `mojo_close_reconciliation_required` would
      // strand a session a plain retry can still finish.
      if (recovery === 'retryable') {
        return {
          ok: false,
          error: 'mojo_cancel_failed',
          retryable: true,
          recovery,
          ...(taskId ? { taskId } : {}),
        };
      }
      return irreversible
        // Retryable, but only as a LOCAL commit: the durable journal is now
        // commit-only, so a retry can never issue a second cancel.
        ? {
            ok: false,
            error: 'mojo_close_commit_required',
            retryable: true,
            recovery,
            ...(taskId ? { taskId } : {}),
          }
        // Unknown outcome: a blind retry proves nothing. Demand reconciliation
        // instead of advertising a retry that cannot succeed.
        : {
            ok: false,
            error: 'mojo_close_reconciliation_required',
            retryable: false,
            recovery,
            ...(taskId ? { taskId } : {}),
          };
    }
    const admissionRestored = await abortLiveRemoteWorkerClose(ds, requestId, {
      allowAbsentAfterProvenRestore: matchedCloseResult,
    });
    // NOTE: no separate "refused" branch here. finishMojoCloseAbort already keeps
    // a durable fenced row when admissionRestored is false; the bug was never its
    // behaviour but the CALLER inventing that flag from `close_abort_result.ok`.
    // An extra branch differing only in which non-clearing row it writes was not
    // distinguishable by any test, so it is not claimed as a fix.
    try {
      const committed = sessionStore.finishMojoCloseAbort(
        ds.session.sessionId,
        requestId,
        { admissionRestored, ...(taskId ? { taskId } : {}) },
      );
      ds.session.mojoCloseJournal = committed.mojoCloseJournal;
      ds.session.riffParentTaskId = committed.riffParentTaskId;
    } catch (err) {
      // The worker may have restored admission, but without a durable journal
      // clear a crash would still be ambiguous. Keep the daemon fence aligned
      // with the disk-side uncertainty instead of accepting new input.
      ds.remoteCloseState = {
        phase: admissionRestored ? 'abort_restored' : 'uncertain',
        requestId,
        ...(taskId ? { taskId } : {}),
      };
      logger.error(
        `[${tag(ds)}] Mojo close abort could not be committed durably: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        error: 'mojo_durable_close_failed',
        retryable: true,
        ...(taskId ? { taskId } : {}),
      };
    }
    logger.warn(
      `[${tag(ds)}] mojo worker close prepare failed: ${result.error ?? 'unknown'}; `
      + `session remains active${taskId ? ` (task ${taskId})` : ''}`,
    );
    return {
      ok: false,
      error: 'mojo_cancel_failed',
      retryable: true,
      ...(taskId ? { taskId } : {}),
    };
  }

  if (result.taskId) {
    ds.session.riffParentTaskId = result.taskId;
    try {
      sessionStore.updateSession(ds.session);
    } catch (err) {
      await abortLiveRemoteWorkerClose(ds, requestId);
      logger.error(
        `[${tag(ds)}] ${backendType} close lineage persistence failed; close aborted: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        error: 'riff_durable_close_failed',
        retryable: true,
        taskId: result.taskId,
      };
    }
  }

  if (!result.ok) {
    await abortLiveRemoteWorkerClose(ds, requestId, {
      allowAbsentAfterProvenRestore: matchedCloseResult,
    });
    logger.warn(
      `[${tag(ds)}] ${backendType} worker close prepare failed: ${result.error ?? 'unknown'}; `
      + `session remains active${taskId ? ` (task ${taskId})` : ''}`,
    );
    return {
      ok: false,
      error: 'riff_worker_close_failed',
      retryable: true,
      ...(taskId ? { taskId } : {}),
    };
  }

  ds.remoteCloseState = {
    phase: 'prepared',
    requestId,
    ...(taskId ? { taskId } : {}),
  };
  logger.info(`[${tag(ds)}] ${backendType} worker close prepared and remote cancellation confirmed`);
  return { ok: true, ...(taskId ? { taskId } : {}) };
}

/** Await remote cancellation for any Riff owner before its durable row is
 * closed. Live workers use prepare/commit; worker-less rows cancel their exact
 * persisted task through current authoritative bot config. */
async function prepareRiffExplicitClose(
  ds: DaemonSession | undefined,
  stored: Session | undefined,
): Promise<RemoteClosePreparation> {
  const session = ds?.session ?? stored;
  if (!session) return { ok: true };
  const backendType = ds?.initConfig?.backendType ?? session.backendType;
  const taskId = session.riffParentTaskId;
  if (ds?.remoteShutdownState) {
    const fencedTaskId = Object.prototype.hasOwnProperty.call(ds.remoteShutdownState, 'taskId')
      ? ds.remoteShutdownState.taskId
      : taskId;
    return {
      ok: false,
      error: 'remote_shutdown_fence_in_progress',
      retryable: true,
      ...(typeof fencedTaskId === 'string' && fencedTaskId ? { taskId: fencedTaskId } : {}),
    };
  }
  if (ds?.remoteCloseState) {
    return {
      ok: false,
      error: 'riff_close_reconciliation_required',
      retryable: true,
      ...(ds.remoteCloseState.taskId ? { taskId: ds.remoteCloseState.taskId } : {}),
    };
  }
  if (backendType !== 'riff') return { ok: true };
  if (
    (ds && isSharedAdoptSession(ds))
    || isSharedAdoptPersistedSession(session)
  ) return { ok: true };

  if (ds?.worker && !ds.worker.killed) {
    if (!stored || stored.status !== 'active') {
      return {
        ok: false,
        error: 'riff_row_inconsistent',
        retryable: true,
        ...(taskId ? { taskId } : {}),
      };
    }
    return prepareLiveRemoteWorkerClose(ds, 'riff');
  }

  const durableBefore = sessionStore.getSession(session.sessionId);
  if (ds && durableBefore
      && ds.session.riffParentTaskId !== durableBefore.riffParentTaskId) {
    const authoritativeTaskId = durableBefore.riffParentTaskId ?? ds.session.riffParentTaskId;
    logger.warn(
      `[${tag(ds)}] explicit close refused before cancellation: runtime/durable Riff lineage differs `
      + `(${ds.session.riffParentTaskId ?? 'none'}/${durableBefore.riffParentTaskId ?? 'none'})`,
    );
    return {
      ok: false,
      error: 'riff_task_changed',
      retryable: true,
      ...(authoritativeTaskId ? { taskId: authoritativeTaskId } : {}),
    };
  }
  if (!taskId) return { ok: true };

  let riffConfig;
  const larkAppId = ds?.larkAppId ?? session.larkAppId;
  try { if (larkAppId) riffConfig = getBot(larkAppId).config.riff; } catch { /* bot removed */ }
  const cleanup = await cleanupExplicitSessionBacking({
    sessionId: session.sessionId,
    backendType,
    riffParentTaskId: taskId,
    riffConfig,
  });
  const closeLabel = ds ? tag(ds) : session.sessionId.slice(0, 8);
  if (!cleanup.ok) {
    logger.warn(
      `[${closeLabel}] explicit close refused: ${cleanup.kind}; `
      + `Riff task ${taskId} remains active and retryable`,
    );
    return {
      ok: false,
      error: cleanup.kind === 'riff_config_missing' ? 'riff_config_missing' : 'riff_cancel_failed',
      retryable: true,
      taskId,
    };
  }
  if (cleanup.kind !== 'cancelled_riff') return { ok: true };

  const latest = sessionStore.getSession(session.sessionId);
  const latestTaskId = latest?.riffParentTaskId;
  const runtimeTaskId = ds?.session.riffParentTaskId;
  if (!latest || latest.status !== 'active' || latestTaskId !== cleanup.taskId
      || (ds && runtimeTaskId !== cleanup.taskId)) {
    logger.warn(
      `[${closeLabel}] explicit close cancelled stale Riff task ${cleanup.taskId}, `
      + `but runtime/durable lineage or status changed to `
      + `${runtimeTaskId ?? 'none'}/${latestTaskId ?? 'none'}/${latest?.status ?? 'missing'}; retry required`,
    );
    return {
      ok: false,
      error: 'riff_task_changed',
      retryable: true,
      taskId: latestTaskId ?? runtimeTaskId ?? cleanup.taskId,
    };
  }

  logger.info(`[${closeLabel}] Riff task ${cleanup.taskId} cancellation prepared for explicit close`);
  return { ok: true, taskId: cleanup.taskId };
}

/**
 * Prove a mojo session's remote lineage is cancelled BEFORE its row is published
 * as closed — the mojo half of what prepareRiffExplicitClose does.
 *
 * Without this, `/close` on a workerless mojo session marked the row closed and
 * returned success while the cancel was still in flight, so a failed cancel left
 * the operator believing the session was gone while the remote one kept running
 * and holding the injected credential. The retained lineage was not a recovery
 * path either: cancelMojoSessionById has exactly one call site (the best-effort
 * killWorker teardown), which a second `/close` can no longer reach because the
 * first close removed the session from the active registry.
 *
 * A live worker uses prepare/commit: MojoBackend.destroySession() awaits the
 * cancel (including the pre-init window), then the daemon durably closes the row
 * before committing worker retirement. A failed durable write keeps the exact
 * generation prepared so retry commits without cancelling twice.
 *
 * An open durable row with no entry in the active registry cannot be cancelled
 * from here at all (every helper the cancel needs is keyed on DaemonSession), so
 * it is refused as retryable rather than published as closed — restoring the owner
 * makes the retry work.
 */
async function prepareMojoExplicitClose(
  ds: DaemonSession | undefined,
  stored: Session | undefined,
): Promise<RemoteClosePreparation> {
  const session = ds?.session ?? stored;
  if (!session) return { ok: true };
  if (
    (ds && isSharedAdoptSession(ds))
    || isSharedAdoptPersistedSession(session)
  ) return { ok: true };
  // A row whose lineage was PARKED (restore-time quarantine moves the id here and
  // clears the active slot) still has a remote session running. It is reported as
  // a residual on every close of this row, including replays of an already-closed
  // one — which is what makes the outcome idempotent instead of degrading to a
  // failure once the owner is gone.
  const parked = mojoCloseResidualForRow(stored ?? session);
  const remoteId = stored ? stored.riffParentTaskId : session.riffParentTaskId;
  const runtimeClose = ds?.session.mojoCloseJournal;
  const storedClose = stored?.mojoCloseJournal;
  if (ds && stored && ds.session !== stored && runtimeClose) {
    const runtimeMatchesDurable = !!storedClose
      && runtimeClose.phase === storedClose.phase
      && runtimeClose.requestId === storedClose.requestId
      && runtimeClose.taskId === storedClose.taskId
      && runtimeClose.updatedAt === storedClose.updatedAt;
    if (!runtimeMatchesDurable) {
      // A runtime copy is not durable authority. In particular, a stale/forged
      // in-memory `prepared` value must never bypass cancellation, while a real
      // prepared store row must not be re-cancelled because a detached runtime
      // copy missed the last sync.
      logger.error(
        `[${session.sessionId.slice(0, 8)}] explicit close refused: runtime/durable Mojo journal mismatch`,
      );
      return {
        ok: false,
        error: 'mojo_close_reconciliation_required',
        retryable: true,
        ...((storedClose?.taskId ?? runtimeClose.taskId ?? remoteId)
          ? { taskId: (storedClose?.taskId ?? runtimeClose.taskId ?? remoteId)! }
          : {}),
      };
    }
  }
  let durableClose = storedClose ?? runtimeClose;
  if (durableClose && !sessionStore.isValidMojoCloseJournal(durableClose)) {
    logger.error(
      `[${session.sessionId.slice(0, 8)}] explicit close refused: malformed Mojo close journal`,
    );
    return {
      ok: false,
      error: 'mojo_close_reconciliation_required',
      retryable: true,
      ...(remoteId ? { taskId: remoteId } : {}),
    };
  }
  // Already closed is normally an idempotent replay. A journal on a closed row
  // is NOT normal (the status transition clears it atomically), so do not flatten
  // that contradictory disk state into an ordinary success.
  if (stored && stored.status === 'closed') {
    if (durableClose) {
      return {
        ok: false,
        error: 'mojo_close_reconciliation_required',
        retryable: true,
        ...((durableClose.taskId ?? remoteId)
          ? { taskId: (durableClose.taskId ?? remoteId)! }
          : {}),
      };
    }
    return parked ? { ok: true, residual: parked } : { ok: true };
  }
  if (durableClose?.phase === 'prepared') {
    // A prior daemon already received and durably recorded the irreversible
    // worker cancellation proof. Finish only the local status/lineage commit;
    // repeating the CLI cancel would turn an idempotent recovery into failure.
    // A parked remote lineage outranks the journal's LOCAL residual in the one
    // slot the response has (it names a live remote session); the local marker
    // still surfaces whenever nothing is parked.
    return {
      ok: true,
      ...((durableClose.taskId ?? remoteId)
        ? { taskId: (durableClose.taskId ?? remoteId)! }
        : {}),
      // The journal's residual is a stored copy of the original proof; whether
      // it still describes reality is the ledger's call (a reboot between the
      // prepare and this replay may have discharged the handle).
      ...(parked
        ? { residual: parked }
        : residualField(liveLocalResidual(session.sessionId, durableClose.localResidual))),
    };
  }
  const matchingRuntimePreparedProof = durableClose?.phase === 'preparing'
    && ds?.remoteCloseState?.phase === 'prepared'
    && ds.remoteCloseState.requestId === durableClose.requestId;
  const matchingRuntimeAbortRestoreProof = durableClose?.phase === 'preparing'
    && ds?.remoteCloseState?.phase === 'abort_restored'
    && ds.remoteCloseState.requestId === durableClose.requestId;
  const hasLiveWorker = !!ds?.worker && !ds.worker.killed;
  if (ds && matchingRuntimePreparedProof && !hasLiveWorker) {
    // Workerless cancellation is irreversible too. If publishing `prepared`
    // failed after the CLI proved cancellation, retain the in-memory proof and
    // let a retry publish that SAME proof before committing the row. Never issue
    // a second cancel merely because the first durable write failed.
    try {
      const committed = sessionStore.markMojoClosePrepared(
        session.sessionId,
        ds.remoteCloseState!.requestId,
        ds.remoteCloseState!.taskId,
        ds.remoteCloseState!.localResidual,
      );
      session.mojoCloseJournal = committed.mojoCloseJournal;
      session.riffParentTaskId = committed.riffParentTaskId;
      return {
        ok: true,
        ...(ds.remoteCloseState!.taskId ? { taskId: ds.remoteCloseState!.taskId } : {}),
        ...(parked
          ? { residual: parked }
          : residualField(liveLocalResidual(session.sessionId, ds.remoteCloseState!.localResidual))),
      };
    } catch (err) {
      logger.error(
        `[${tag(ds)}] Workerless Mojo close proof could not be persisted for durable commit: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        error: 'mojo_durable_close_failed',
        retryable: true,
        ...(ds.remoteCloseState!.taskId ? { taskId: ds.remoteCloseState!.taskId } : {}),
      };
    }
  }
  if (ds && matchingRuntimeAbortRestoreProof && !hasLiveWorker) {
    // No worker admission changed on this path, but the durable intent must be
    // cleared before another cancel attempt is allowed. A failed clear keeps the
    // central admission fence aligned with disk.
    try {
      const restoredState = ds.remoteCloseState!;
      const committed = sessionStore.finishMojoCloseAbort(
        session.sessionId,
        restoredState.requestId,
        {
          admissionRestored: true,
          ...(restoredState.taskId ? { taskId: restoredState.taskId } : {}),
        },
      );
      session.mojoCloseJournal = committed.mojoCloseJournal;
      session.riffParentTaskId = committed.riffParentTaskId;
      ds.remoteCloseState = undefined;
      durableClose = undefined;
    } catch (err) {
      logger.error(
        `[${tag(ds)}] Workerless Mojo abort proof could not clear the durable close journal: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        error: 'mojo_durable_close_failed',
        retryable: true,
        ...(ds.remoteCloseState!.taskId ? { taskId: ds.remoteCloseState!.taskId } : {}),
      };
    }
  }
  const livePreparedProof = matchingRuntimePreparedProof
    && !!ds.worker
    && !ds.worker.killed;
  const liveAbortRestoreProof = matchingRuntimeAbortRestoreProof
    && !!ds.worker
    && !ds.worker.killed;
  if (durableClose && !livePreparedProof && !liveAbortRestoreProof) {
    const journalLineage = durableClose.taskId ?? remoteId;
    // The RECONCILIATION EXIT this journal has always promised (types.ts:
    // "pending explicit reconciliation"). Before it existed, every journal
    // without a matching runtime proof was refused here forever: restore
    // downgraded crashed closes to `uncertain` and quarantined the row
    // unregistered, this branch then refused each /close as
    // reconciliation_required, and CLI-mismatch cleanup re-quarantined it —
    // a permanent brick whose remote session kept credentials, fixable only
    // by hand-editing JSON state (P1-1). Two journal shapes are reconcilable
    // by an EXPLICIT close:
    //   * `uncertain` — no retry can classify the crashed cancel without a
    //     remote status oracle, so the row DRAINS: it closes with the lineage
    //     parked as an explicit residual (same isolation-over-deletion shape
    //     as a quarantined lineage — cleanup is remote, the id is preserved,
    //     and replays keep reporting it).
    //   * `preparing` + recovery 'retryable' — the failed prepare durably
    //     recorded that retrying the cancel is legitimate (P1-2). With a
    //     registered owner the close falls through and re-runs the cancel
    //     under a fresh requestId (beginMojoCloseJournal accepts the restart);
    //     without one there is nothing to cancel through, so it drains like
    //     `uncertain`.
    const retryableJournal = durableClose.phase === 'preparing'
      && durableClose.recovery === 'retryable';
    // NEVER drain past a live worker (P0-new). Draining set the row closed and
    // deleted the registry entry while killWorker's remote guard (P0-2) refused
    // the request-less retirement — the still-running, credential-carrying mojo
    // worker became unreachable by every entry point. A live worker is also the
    // one owner that can produce FRESH evidence, so it falls through to
    // prepare/commit below instead: beginMojoCloseJournal accepts the takeover
    // of an uncertain/retryable journal under the new requestId, the worker
    // re-runs destroySession, and killWorker retires it legally with the commit
    // requestId. (An in-process runtime `uncertain` fence still refuses inside
    // prepareLiveRemoteWorkerClose — deliberately; refusal keeps the worker
    // reachable, which is exactly what the drain violated.)
    const drainable = !hasLiveWorker
      && (durableClose.phase === 'uncertain' || (retryableJournal && !ds));
    if (drainable) {
      logger.warn(
        `[${session.sessionId.slice(0, 8)}] explicit close drains ${durableClose.phase} Mojo `
        + `journal (${durableClose.requestId}): the row closes`
        + (journalLineage
          ? ` and lineage ${journalLineage} is parked as a residual for manual cleanup`
          : ' with no lineage to park'),
      );
      if (!journalLineage) return parked ? { ok: true, residual: parked } : { ok: true };
      return {
        ok: true,
        residual: parked ?? { reason: 'mojo_lineage_quarantined', taskId: journalLineage },
        parkMojoLineage: journalLineage,
      };
    }
    const liveWorkerReconciles = hasLiveWorker
      && (durableClose.phase === 'uncertain' || retryableJournal);
    if (!retryableJournal && !liveWorkerReconciles) {
      logger.warn(
        `[${session.sessionId.slice(0, 8)}] explicit close requires Mojo reconciliation: `
        + `durable journal is ${durableClose.phase} (${durableClose.requestId})`,
      );
      return {
        ok: false,
        error: 'mojo_close_reconciliation_required',
        retryable: true,
        ...(journalLineage ? { taskId: journalLineage } : {}),
      };
    }
    // Fall through: a retryable journal with a registered owner re-runs the
    // cancel (live worker → prepare/commit; workerless → the cancel below),
    // and an uncertain journal with a LIVE worker goes to prepare/commit.
  }
  // A live worker is the only authority that can cover the pre-init window:
  // destroySession waits for system/init, then returns the exact lineage in its
  // close_result. This must run even when the durable row has no id yet.
  if (ds?.worker && !ds.worker.killed) {
    if (!stored || stored.status !== 'active') {
      return {
        ok: false,
        error: 'mojo_close_identity_missing',
        retryable: true,
        ...(remoteId ? { taskId: remoteId } : {}),
      };
    }
    return prepareLiveRemoteWorkerClose(ds, 'mojo');
  }
  // Nothing ACTIVE to cancel: either a clean row, or a parked-only one.
  if (!remoteId) return parked ? { ok: true, residual: parked } : { ok: true };
  if (!ds) {
    // An open durable row carrying a lineage, with no owner in the active
    // registry. Everything the cancel needs (frozen identity, launch identity)
    // hangs off DaemonSession, so this cannot be cancelled from here — and
    // silently publishing it as closed would be the same lie as before, just
    // through a different door. Fail closed; a restore/adopt puts the owner back
    // and makes the retry work.
    logger.warn(
      `[${session.sessionId.slice(0, 8)}] explicit close refused: mojo lineage ${remoteId} `
      + 'has no active owner to cancel through; row stays open',
    );
    return { ok: false, error: 'mojo_close_identity_missing', retryable: true, taskId: remoteId };
  }
  const resolved = resolveMojoCancelLaunch(ds, remoteId, 'explicit close');
  if (!resolved.ok) {
    if (resolved.reason === 'bot_gone') {
      // NOT permanent: re-registering the bot restores the config this needs, so
      // this is retryable and must not close the row behind the operator's back.
      return { ok: false, error: 'mojo_config_missing', retryable: true, taskId: remoteId };
    }
    // Quarantined: cancelling could reach a different tenant, and no retry can
    // ever make an unverifiable control plane verifiable. Refusing forever would
    // strand the row, so the close proceeds — but as an EXPLICIT residual, never
    // as an ordinary success, and the lineage stays on the row for manual cleanup.
    //
    // The id is PARKED as part of the durable close (see parkMojoLineage), which is
    // what makes the decision replayable: a second close reads it back out of the
    // parked slot instead of tripping over an active lineage with no owner.
    return {
      ok: true,
      residual: parked ?? { reason: 'mojo_lineage_quarantined', taskId: remoteId },
      parkMojoLineage: remoteId,
    };
  }

  const requestId = randomUUID();
  try {
    const committed = sessionStore.beginMojoCloseJournal(
      session.sessionId,
      requestId,
      remoteId,
    );
    session.mojoCloseJournal = committed.mojoCloseJournal;
    session.riffParentTaskId = committed.riffParentTaskId;
  } catch (err) {
    logger.error(
      `[${tag(ds)}] Workerless Mojo close journal could not be persisted before cancellation: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: false,
      error: 'mojo_durable_close_failed',
      retryable: true,
      taskId: remoteId,
    };
  }
  ds.remoteCloseState = { phase: 'preparing', requestId, taskId: remoteId };
  const outcome = await cancelMojoSessionById(resolved.launchCfg, remoteId).catch((err: unknown) => ({
    kind: 'failed' as const,
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
  }));
  // Structured, NOT a boolean: `if (!outcome)` on an object is always false and
  // would turn every failure into a silent success. `already_terminal` counts as
  // gone, but only when the classifier could PROVE it (see MojoCancelOutcome).
  if (!isMojoRemoteGone(outcome)) {
    try {
      const committed = sessionStore.finishMojoCloseAbort(
        session.sessionId,
        requestId,
        { admissionRestored: true, taskId: remoteId },
      );
      session.mojoCloseJournal = committed.mojoCloseJournal;
      session.riffParentTaskId = committed.riffParentTaskId;
      ds.remoteCloseState = undefined;
    } catch (err) {
      // There was no live worker admission to restore, but accepting input while
      // disk still says `preparing` would recreate the same split-brain. Retain
      // an abort-restored runtime proof so a retry clears the journal first.
      ds.remoteCloseState = { phase: 'abort_restored', requestId, taskId: remoteId };
      logger.error(
        `[${tag(ds)}] Workerless Mojo close abort could not be committed durably: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        error: 'mojo_durable_close_failed',
        retryable: true,
        taskId: remoteId,
      };
    }
    logger.warn(
      `[${tag(ds)}] explicit close refused: mojo session ${remoteId} could not be `
      + 'cancelled; the row stays open and the lineage is retained so the close is retryable'
      + (outcome.kind === 'failed' ? ` (${outcome.message})` : ''),
    );
    return { ok: false, error: 'mojo_cancel_failed', retryable: true, taskId: remoteId };
  }
  // The workerless local-subtree proof travels ON the outcome (see
  // cancelMojoSessionById): a weak-only proof keeps its containment handle, and
  // this close must say so — durably, so retries and restarts republish it.
  const localResidual = outcome.kind !== 'failed' ? outcome.localResidual : undefined;
  try {
    const committed = sessionStore.markMojoClosePrepared(
      session.sessionId,
      requestId,
      remoteId,
      localResidual,
    );
    session.mojoCloseJournal = committed.mojoCloseJournal;
    session.riffParentTaskId = committed.riffParentTaskId;
  } catch (err) {
    // Cancellation is proven and cannot be rolled back. Keep the runtime proof
    // prepared so the same daemon can publish it on retry; after a crash the
    // durable `preparing` journal remains fenced for explicit reconciliation.
    ds.remoteCloseState = {
      phase: 'prepared',
      requestId,
      taskId: remoteId,
      ...(localResidual ? { localResidual } : {}),
    };
    logger.error(
      `[${tag(ds)}] Workerless Mojo close proof persistence failed after cancellation: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: false,
      error: 'mojo_durable_close_failed',
      retryable: true,
      taskId: remoteId,
    };
  }
  ds.remoteCloseState = {
    phase: 'prepared',
    requestId,
    taskId: remoteId,
    ...(localResidual ? { localResidual } : {}),
  };
  // Deliberately does NOT clear the runtime lineage here. sessionStore commonly
  // holds the very same Session object, so an early clear is visible to the durable
  // save — and if that save then fails, the rollback has already lost the id it
  // would restore while the on-disk row may still carry it. The lineage is cleared
  // atomically with the status change instead (clearRiffParentTaskId), and the
  // repeat-cancel is suppressed with an explicit flag rather than by mutating
  // shared state early.
  logger.info(`[${tag(ds)}] mojo session ${remoteId} cancelled for explicit close`);
  // Workerless twin of MojoBackend.destroySession()'s reap: the close verdict
  // above is already decided, so a reaping failure only leaks an idle daemon
  // (logged inside), never fails the close. Host-mode gating lives inside the
  // helper via the isolated dir's existence — a cloud session never created one.
  void cleanupMojoIsolatedWorkspace(session.sessionId).catch(() => undefined);
  // Cancelling the ACTIVE lineage says nothing about a previously parked one: a row
  // can carry both (restore parked the old id, the session then created a new one).
  // Reporting a plain success here would hide the parked remote session entirely.
  // With nothing parked, the LOCAL residual takes the slot for the same reason.
  return {
    ok: true,
    taskId: remoteId,
    ...(parked
      ? { residual: parked }
      : localResidual
        ? { residual: { reason: localResidual } }
        : {}),
  };
}

/**
 * The residual a row carries because a lineage was PARKED as unverifiable.
 *
 * Read from the parked slot, never from the active one: restore-time quarantine
 * moves the id into `mojoQuarantinedLineage` and clears `riffParentTaskId`, so a
 * check against the active slot misses the production shape completely — the row
 * would close as an ordinary success while its remote session kept running.
 *
 * May hold more than one id (comma-joined) when two unverifiable lineages were
 * parked together; it is passed through verbatim so manual cleanup sees both.
 */
export function mojoCloseResidualForRow(session: Session | undefined): CloseResidual | undefined {
  // A parked REMOTE lineage outranks a local residual: it names a live remote
  // session burning cloud time, the more urgent cleanup, and the response has a
  // single residual slot. The local residual surfaces whenever nothing is parked.
  const parked = session?.mojoQuarantinedLineage;
  if (parked) return { reason: 'mojo_lineage_quarantined', taskId: parked };
  if (session?.mojoLocalResidual) return liveLocalResidual(session.sessionId, session.mojoLocalResidual);
  return undefined;
}

/**
 * Surface a stored LOCAL residual only while its containment handle is still
 * outstanding.
 *
 * The containment-handle ledger is the SOURCE OF TRUTH for the device-isolation
 * blocker; `Session.mojoLocalResidual` (and a journal's `localResidual`) are
 * DERIVED display state with deliberately no clear path of their own: the two
 * paths that discharge a handle — boot reconciliation and operator revoke —
 * operate on the one global ledger, and having them also rewrite session rows
 * would tie a global cleanup to whichever bots' per-bot row files happen to be
 * loaded at the time. Deriving at read time keeps the two stores fork-free: the
 * handle is gone → the "credentialed process may remain on this host" claim is
 * no longer true, report nothing; the ledger cannot be read → we cannot rule the
 * claim out, keep reporting it (fail-closed, matching hasUnprovenContainment's
 * own contract of throwing rather than answering false).
 */
/** Spread helper: `{ residual }` when present, `{}` otherwise. */
function residualField(residual: CloseResidual | undefined): { residual?: CloseResidual } {
  return residual ? { residual } : {};
}

function liveLocalResidual(
  sessionId: string,
  residual: NonNullable<Session['mojoLocalResidual']> | undefined,
): CloseResidual | undefined {
  if (!residual) return undefined;
  try {
    if (!hasUnprovenContainment(sessionId)) return undefined;
  } catch {
    // Unreadable ledger: a handle may exist, so the residual stays reported.
  }
  return { reason: residual };
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

/**
 * Consume a queued suspend claim once its goal state is reached.
 *
 * A claim only ever means "suspend the generation that is producing right now".
 * It is therefore consumed the moment that generation stops running, by ANY
 * route — the deferred checkpoint itself, a `/cd` or read-isolation switch that
 * suspended first, or an outright crash. Leaving it set is not a harmless
 * no-op: `runPendingSuspendIfSettled` fires on the NEXT generation's first
 * screen checkpoint, and its `ownsGeneration` predicate passes there (that
 * worker legitimately owns the session), so the replacement gets suspended for
 * a request that was never about it.
 *
 * The old code did have a "worker already gone → drop the flag" branch, but it
 * lived inside the checkpoint — which by definition stops running once the
 * session goes quiet. The clear needs to hang off the lifecycle events instead.
 */
function clearPendingSuspendClaim(ds: DaemonSession, why: string): void {
  if (ds.pendingSuspendReason === undefined && ds.pendingSuspendGeneration === undefined) return;
  const reason = ds.pendingSuspendReason;
  ds.pendingSuspendReason = undefined;
  ds.pendingSuspendGeneration = undefined;
  logger.debug(`[${tag(ds)}] Cleared queued suspend claim (${reason ?? 'none'}): ${why}`);
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
  // P1-13：suspend 会销毁 CLI 与其子进程，那一代 dev server 随之消失（端口号交还
  // 内核）。会话本身还活着，所以不会走 close 路径——预览必须在这里同步失效，否则
  // 「休眠中」的会话卡片仍然挂着一条指向空端口/别人进程的预览入口。
  const suspendedPreviewTarget = takeSessionPreviewTarget(ds.session);
  sessionStore.updateSessionPid(ds.session.sessionId, null);
  sessionStore.updateSession(ds.session);
  if (suspendedPreviewTarget !== undefined) publishSessionPreviewCleared(ds.session.sessionId);

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
  // Goal state reached. Whoever queued a suspend for this generation got what
  // they asked for — including the paths that never touch the deferred
  // checkpoint (`/cd`, read-isolation switch, sweepIdleWorkers).
  clearPendingSuspendClaim(ds, `suspended (${reason})`);
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
 * `ownsGeneration` is the calling handler's generation check (`ownsWorkerSession`),
 * and it is **defense-in-depth** — not a guard against a race anyone has shown to
 * be reachable today. Two earlier drafts of this comment each claimed a concrete
 * race; both were wrong, so the reasoning is spelled out here to stop a third:
 *
 *   - It is NOT "a stale worker's late `idle` reaches `screenshot_uploaded`":
 *     the message handler's fence (`if (ds.worker !== worker) return`) sits
 *     BEFORE the switch and already drops every message from a replaced worker.
 *   - It is NOT "two microtasks in one tick, the first suspends + re-forks and
 *     the second meets the replacement": `suspendWorker` only nulls `ds.worker`,
 *     it never re-forks (a re-fork is driven by external input, i.e. a later
 *     MACROtask), and the microtask queue drains without letting one in. The
 *     second microtask therefore sees `ds.worker === null` and this predicate
 *     early-returns on that — a replacement is not what it meets.
 *
 * What it does buy: a queued callback can only ever act while its own generation
 * still owns the session. That keeps this deferral safe against future callers,
 * new synchronous side effects between enqueue and drain, and any path that
 * starts re-forking earlier than today. Consuming the claim is a destructive act
 * on a live worker, so it is worth gating even without a demonstrated race.
 * A checkpoint from a generation that no longer owns the session keeps the flag
 * pending; only the owning generation may consume it.
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
  // A claim belongs to the generation that was producing when it was queued.
  // Reaching a LATER generation means its own fulfilment checkpoint never ran
  // (crash, or another path suspended first) — consume it rather than suspend a
  // worker the request never asked about. clearPendingSuspendClaim covers the
  // normal exits; this is the backstop for a claim that slipped past them.
  if (
    ds.pendingSuspendGeneration !== undefined
    && ds.workerGeneration !== undefined
    && ds.pendingSuspendGeneration !== ds.workerGeneration
  ) {
    clearPendingSuspendClaim(ds, 'generation changed');
    return;
  }
  const st = ds.lastScreenStatus;
  if (st !== 'idle' && st !== 'limited') return;
  // Worker already gone (crash / suspended by another path): the goal state is
  // reached, so drop the flag. Falling through to suspendWorker would take its
  // no-worker branch and clear managedTurnOrigin/workerReady for a generation
  // this queued request never owned.
  if (!ds.worker || ds.worker.killed) {
    clearPendingSuspendClaim(ds, 'worker already gone');
    return;
  }
  // Clear only on success. suspendWorker refuses mid-routing-transfer (and for a
  // backend that stopped being suspendable), and that refusal is temporary —
  // eating the flag would silently drop the request until the next `suspend all`.
  if (suspendWorker(ds, reason)) {
    // suspendWorker already consumed the claim (goal state reached); logging
    // here keeps the "fulfilled by the deferred path" signal distinguishable
    // from a suspend that came from anywhere else.
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
    || (ds && isSharedAdoptSession(ds))
    || isSharedAdoptPersistedSession(session)
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

/** Render the live streaming-card JSON for `ds` (🖥️ header + usage line +
 *  显示输出/终端/关闭会话 buttons). Factored so callers outside the normal
 *  screen-update flow — notably the Lark 恢复会话 button — can restore the SAME
 *  card the session had while running, instead of a stripped-down variant.
 *  `status` defaults to the session's last known screen status. */
export function buildStreamingCardJson(ds: DaemonSession, status?: StreamStatus): string {
  const botCfg = getBot(ds.larkAppId).config;
  const effectiveCliId = sessionCliId(ds, botCfg);
  return buildStreamingCard(
    ds.session.sessionId,
    sessionAnchorId(ds),
    readableTerminalUrlFor(ds),
    ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg),
    ds.lastScreenContent ?? '',
    status ?? ds.lastScreenStatus ?? 'starting',
    effectiveCliId,
    ds.displayMode ?? 'hidden',
    ds.streamCardNonce,
    ds.currentImageKey,
    isSharedAdoptSession(ds),
    false,
    localeForBot(ds.larkAppId),
    cardUsageLimit(ds),
    writableTerminalLinkFor(ds),
    isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
    getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
    sessionRuntimeDisplayName(ds, botCfg),
    codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
    silentIdleCardFlag(ds),
  );
}

/**
 * Idempotent close: kill worker if alive, mark Session status='closed' + closedAt,
 * publish session.exited (if a live worker was killed) and session.update
 * (if the persistence row transitioned to closed).
 *
 * Calling this on an unknown sessionId, an already-closed session, or a session
 * whose worker died asynchronously must still resolve with `{ ok: true }`.
 */
/**
 * Why a close left something behind even though the local row closed.
 *
 * Two causes qualify, and they are deliberately NOT merged, because they send the
 * operator to different places:
 *
 *  - `mojo_lineage_quarantined` — REMOTE residual. Nothing records which control
 *    plane holds the remote session, so cancelling could reach a different tenant.
 *    Carries the surviving remote `taskId`; cleanup is remote.
 *  - `local_subtree_*` — LOCAL residual. The remote lineage really was cancelled,
 *    but the backend could not prove its own process subtree on THIS host was gone,
 *    so it kept the containment handle and the device-isolation blocker with it.
 *    No `taskId`: there is no surviving remote id to chase, and offering one would
 *    point cleanup at the wrong system.
 *
 * In both cases refusing forever would strand the row (no retry can make an
 * unverifiable control plane verifiable, nor make an unenumerable host
 * enumerable), so the row closes — but the caller must SAY so rather than showing
 * the ordinary "closed" confirmation.
 */
export interface CloseResidual {
  reason:
    | 'mojo_lineage_quarantined'
    | 'local_subtree_unprovable_on_platform'
    | 'local_subtree_boundary_unproven';
  /** Present only for a REMOTE residual; a local one has no remote id to name. */
  taskId?: string;
}

/**
 * `outcome` is a REQUIRED discriminant on success, not an optional warning field.
 *
 * An optional flag on an otherwise ordinary success is exactly what every call site
 * forgets to read, so making it mandatory does help — but ONLY across a typed call.
 * It is not a completeness guarantee: a consumer that reads just `.ok` compiles
 * fine, and every JSON boundary (the dashboard IPC route, the CLI's daemon POST,
 * the sessions card) erases the type entirely. Reviewing this change found exactly
 * such consumers silently flattening a residual into a plain success.
 *
 * So the invariant is held by the consumer TESTS, not by this type. Any new close
 * consumer needs one.
 */
export type CloseSessionResult =
  | { ok: true; outcome: 'closed'; alreadyClosed: boolean; known: boolean }
  | {
      ok: true;
      outcome: 'closed_with_residual';
      residual: CloseResidual;
      alreadyClosed: boolean;
      known: boolean;
    }
  | ({
      ok: false;
      alreadyClosed: false;
    } & Exclude<RemoteClosePreparation, { ok: true }>);

/**
 * Close from a BACKGROUND path — one with no user surface to report to
 * (trigger-session cleanup, deferred-schedule settlement, sweeps).
 *
 * These callers cannot show a card or a toast, so the only honest thing they can
 * do with a residual or a refusal is make it OBSERVABLE: an uncancelled remote
 * session is still burning cloud time and holding an injected credential, and
 * silently discarding the result is how that became invisible everywhere else.
 *
 * Returns the untouched result so a caller that DOES care can still branch.
 */
export async function closeSessionForBackgroundCleanup(
  sessionId: string,
  context: string,
): Promise<CloseSessionResult> {
  const result = await closeSession(sessionId);
  const tagId = sessionId.slice(0, 8);
  if (!result.ok) {
    logger.error(
      `[${tagId}] ${context}: close REFUSED (${result.error}); the row stays active `
      + 'and its remote session may still be running'
      + (result.taskId ? ` (remote ${result.taskId})` : ''),
    );
    return result;
  }
  if (result.outcome === 'closed_with_residual') {
    // Kind-aware: a LOCAL-subtree residual has no taskId, so the old wording
    // logged "remote session undefined was NOT cancelled" and pointed cleanup at
    // a nonexistent remote session instead of the host process (round-11 P1-2).
    logger.warn(
      `[${tagId}] ${context}: closed locally — ${closeResidualClause(result.residual)} `
      + `(${result.residual.reason})`,
    );
  }
  return result;
}

export async function closeSession(
  sessionId: string,
  opts?: { awaitWorkerExit?: boolean },
): Promise<CloseSessionResult> {
  // `awaitWorkerExit` (default true): whether to block on the worker process
  // actually exiting before returning. A busy CLI wedges in node-pty teardown
  // and only dies at the ~7s SIGKILL backstop, so callers behind a tight ACK
  // window (the Lark card "关闭会话" button, whose callback must ACK inside ~3s
  // or the client surfaces the "code: 300000" toast) pass false: the logical
  // close below is fully synchronous, and killWorker already armed the kill
  // backstop, so the worker WILL die in the background — the caller need not
  // wait for it. Bridge-marker cleanup still runs, deferred behind the fence.
  const awaitWorkerExit = opts?.awaitWorkerExit ?? true;
  const ds = findActiveBySessionId(sessionId);
  const stored = sessionStore.getOwnedSession(sessionId);
  const closeFrozenBackendType = ds?.initConfig?.backendType
    ?? ds?.session.backendType ?? stored?.backendType;
  const isOwnedClose = !(ds && isSharedAdoptSession(ds))
    && !(stored && isSharedAdoptPersistedSession(stored));
  const isOwnedRiffClose = isOwnedClose && closeFrozenBackendType === 'riff';
  const isOwnedMojoClose = isOwnedClose && closeFrozenBackendType === 'mojo';
  const closeJournal = ds?.session.mojoCloseJournal ?? stored?.mojoCloseJournal;
  if (closeJournal && !isOwnedMojoClose) {
    // Never let a Mojo cancellation journal silently disappear through another
    // backend's ordinary close path. It may be corrupt metadata, but only an
    // explicit reconciliation/repair may remove that fence.
    return {
      ok: false,
      alreadyClosed: false,
      error: 'mojo_close_reconciliation_required',
      retryable: true,
      ...(closeJournal.taskId ? { taskId: closeJournal.taskId } : {}),
    };
  }
  // Prove fail-closed ZMX teardown before any registry/store mutation. Repo
  // replacement paths reuse the same helper before their own state transition.
  const teardownTarget = ds ?? stored;
  if (teardownTarget) {
    teardownAuthoritativePersistentBackingBeforeCloseImpl(teardownTarget, true);
  }
  let killedLive = false;
  const hadLiveWorker = !!ds?.worker && !ds.worker.killed;
  const closeWorkerGeneration = ds ? closeFenceGeneration(ds) : undefined;
  // Snapshot ownership + transition state before mutating the live object:
  // sessionStore commonly holds the very same Session reference as `ds`.
  const known = !!ds || !!stored;
  const wasOpen = !!stored && stored.status !== 'closed';
  // Frozen sidecars are deleted by the successful store close. Capture all
  // public streaming-card ids before that transaction, never await their
  // cleanup on the close path.
  const closeAppId = ds?.larkAppId ?? stored?.larkAppId;
  let closeStoredOwner: StreamingCardOwner | undefined;
  let closePinnedStreamingIds: string[] = [];
  if (closeAppId) {
    if (ds) {
      closePinnedStreamingIds = captureLifecycleStreamingCardCleanupIds(
        closeAppId,
        ds.chatId,
        ds,
        snapshotStreamingCardIds(ds),
      );
    } else if (stored) {
      const ids = new Set<string>();
      if (isRealStreamingCardId(stored.streamCardId)) ids.add(stored.streamCardId);
      try {
        for (const frozen of loadFrozenCards(stored.sessionId).values()) {
          if (isRealStreamingCardId(frozen.messageId)) ids.add(frozen.messageId);
        }
      } catch (err) {
        logger.debug(`[${sessionId.slice(0, 8)}] could not load frozen cards for close Pin cleanup: ${err instanceof Error ? err.message : String(err)}`);
      }
      closeStoredOwner = { sessionId: stored.sessionId, larkAppId: closeAppId };
      closePinnedStreamingIds = captureLifecycleStreamingCardCleanupIds(
        closeAppId,
        stored.chatId,
        closeStoredOwner,
        [...ids],
      );
    }
  }
  // P1-13：关闭必须显式广播 `preview: null`。sessionStore.closeSession 会把字段从磁盘
  // 上抹掉，但没有事件——浏览器侧只会收到 `session.exited`，会话卡片上的预览入口就
  // 那么留着，Dashboard 的 preview SSE/WS 也拿不到断流信号。
  const hadPreviewTarget = ds?.session.previewTarget !== undefined
    || stored?.previewTarget !== undefined;
  const storedHadDocCommentTargets = Object.keys(stored?.docCommentTargets ?? {}).length > 0;
  const docReactionTargets = collectDocCommentReactionTargets(ds, stored);

  if (ds) {
    // Usage ledger: flush the final delta before the worker goes away (a
    // crash/limited turn may never have reached an idle edge).
    recordUsageForDaemonSession(ds);
  }

  // Riff and mojo both own a remote, credential-bearing session. Prove
  // cancellation before mutating routing, transient capabilities, or the durable
  // row — publishing "closed" while the cancel is still in flight is how a failed
  // cancel became a silent leak. Other backends retain master's synchronous
  // state-transition path.
  const prepared: RemoteClosePreparation = isOwnedRiffClose
    ? await prepareRiffExplicitClose(ds, stored)
    : isOwnedMojoClose
      ? await prepareMojoExplicitClose(ds, stored)
      : { ok: true };
  if (!prepared.ok) {
    return { ...prepared, alreadyClosed: false };
  }
  // Only when the cancel actually happened: a quarantined / bot-gone mojo session
  // keeps its lineage on the row for manual cleanup.
  const clearMojoLineage = isOwnedMojoClose && !!prepared.taskId;
  // NOTE: the residual is derived from the COMMITTED row at the end of this
  // function, not captured here — the store merges parked ids, so a value computed
  // before the transaction can disagree with what was actually persisted.
  const preparedRemoteRequestId = ds?.remoteCloseState?.phase === 'prepared'
    ? ds.remoteCloseState.requestId
    : undefined;

  // 会话关闭即可回收其崩溃重启计数；否则每个曾崩溃过的 session 会在 daemon
  // 生命周期内永久占位（restartCounts 此前无任何 delete）。
  restartCounts.delete(sessionId);
  // Per-turn comment routes are transient capabilities. Clear them from both
  // live and owner-scoped persisted objects inside the synchronous close
  // critical section, before any best-effort Lark cleanup can yield.
  clearAllDocCommentTurnState(ds, stored);
  // An idempotent re-close has no status transition for closeSession() to
  // persist, but stale per-turn capabilities must still be removed on disk.
  if (stored && !wasOpen && storedHadDocCommentTargets) {
    sessionStore.updateSession(stored);
  }

  // Mutations are bot-owner scoped. getSession() has a read-only cross-file
  // fallback for agent CLI discovery, so it must not authorize close.
  if (wasOpen) {
    if (!ds && stored && !isOwnedRiffClose) destroyUnregisteredPersistentBacking(stored);
    try {
      // Parking is handed to the store as part of ITS transaction rather than
      // pre-written here: the runtime object is not always the authoritative row,
      // and a pre-write survives a failed save (the store's rollback cannot restore
      // a field it never set). Same mistake as the early lineage clear fixed
      // earlier — one layer up.
      sessionStore.closeSession(sessionId, {
        cleanupBridgeMarkers: !hadLiveWorker,
        ...(prepared.parkMojoLineage ? { parkMojoLineage: prepared.parkMojoLineage } : {}),
        // Park a LOCAL residual so an idempotent re-close still reports it — the
        // journal (its runtime home) is wiped by this same transaction.
        ...(prepared.residual
          && prepared.residual.reason !== 'mojo_lineage_quarantined'
          ? { parkLocalResidual: prepared.residual.reason }
          : {}),
        ...(isOwnedRiffClose || clearMojoLineage || prepared.parkMojoLineage
          ? { clearRiffParentTaskId: true }
          : {}),
      });
    } catch (err) {
      if (isOwnedMojoClose
          && (preparedRemoteRequestId || stored?.mojoCloseJournal?.phase === 'prepared')) {
        logger.error(
          `[${sessionId.slice(0, 8)}] Durable session close failed after Mojo cancel; `
          + `retaining prepared commit: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          ok: false,
          alreadyClosed: false,
          error: 'mojo_durable_close_failed',
          retryable: true,
          ...(prepared.taskId ? { taskId: prepared.taskId } : {}),
        };
      }
      if (!isOwnedRiffClose) throw err;
      if (ds && preparedRemoteRequestId) {
        await abortLiveRemoteWorkerClose(ds, preparedRemoteRequestId);
      }
      logger.error(
        `[${sessionId.slice(0, 8)}] Durable session close failed after Riff prepare; `
        + `worker admission restored: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        alreadyClosed: false,
        error: 'riff_durable_close_failed',
        retryable: true,
        ...(prepared.taskId ? { taskId: prepared.taskId } : {}),
      };
    }
    const after = sessionStore.getOwnedSession(sessionId);
    if (ds) {
      ds.session.status = 'closed';
      ds.session.closedAt = after?.closedAt ?? ds.session.closedAt;
      // 活对象与 store 里的行未必是同一个引用；durable close 只清了后者。
      takeSessionPreviewTarget(ds.session);
      // Sync the parking back from the store's committed row. Only reached after a
      // SUCCESSFUL save, and skipped when the two are the same object anyway, so
      // the runtime view cannot end up carrying a park the disk does not have.
      if (after && after !== ds.session) {
        ds.session.mojoCloseJournal = after.mojoCloseJournal;
        if (clearMojoLineage || prepared.parkMojoLineage) {
          ds.session.riffParentTaskId = after.riffParentTaskId;
        }
      }
      if (prepared.parkMojoLineage && after && after !== ds.session) {
        ds.session.mojoQuarantinedLineage = after.mojoQuarantinedLineage;
        ds.session.mojoQuarantineNoticePending = after.mojoQuarantineNoticePending;
      }
    }
    if (hadPreviewTarget) publishSessionPreviewCleared(sessionId);
    const closeStreamingOwner = ds ?? closeStoredOwner;
    if (closeAppId && closeStreamingOwner && closePinnedStreamingIds.length > 0) {
      void unpinStreamingCardIds(closeAppId, closePinnedStreamingIds, closeStreamingOwner);
    }
  }

  if (ds) {
    disposeOrdinaryTurnRecovery(ds.session);
    killWorker(ds, {
      ...(preparedRemoteRequestId ? { remoteCloseCommitRequestId: preparedRemoteRequestId } : {}),
      // The prepare above already proved this cancel; the durable row cleared the
      // lineage in the same transaction. Suppress the best-effort repeat.
      ...(clearMojoLineage ? { mojoCancelAlreadyProven: true } : {}),
    });
    // A transferred/restored exact object may remain under more than one alias.
    // Remove only identity matches, never a same-key successor.
    if (activeSessionsRegistry) {
      for (const [registeredKey, candidate] of activeSessionsRegistry) {
        if (candidate === ds) activeSessionsRegistry.delete(registeredKey);
      }
    }
    // Mark the captured object too. Async message/card paths may already hold a
    // reference to `ds`; deleting only the registry entry would not stop one of
    // those continuations from re-forking the closed session after its await.
    ds.session.status = 'closed';
    ds.session.closedAt ??= new Date().toISOString();
    killedLive = true;
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
    if (awaitWorkerExit) {
      await closeFenceFor(sessionId, closeWorkerGeneration);
      sessionStore.cleanupSessionBridgeSendMarkersNow(sessionId);
    } else {
      // Don't block the caller on the worker exiting (killWorker already armed
      // the SIGKILL backstop). Defer bridge-marker cleanup behind the same
      // fence so a mid-flight send is still credited until the worker ACKs/exits.
      sessionStore.cleanupSessionBridgeSendMarkers(sessionId);
    }
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
  // The local row IS closed, but a remote session was deliberately left running
  // (its control plane could not be verified, so cancelling it might have hit
  // another tenant). Callers must render this differently from an ordinary close.
  // Read the residual back off the authoritative row so it always matches disk
  // (including the merge when a second id was parked). `prepared.residual` is only
  // a fallback for the paths that never reached the store.
  const closeResidual = isOwnedMojoClose
    ? (mojoCloseResidualForRow(sessionStore.getOwnedSession(sessionId) ?? stored ?? ds?.session)
      ?? prepared.residual)
    : undefined;
  if (closeResidual) {
    return {
      ok: true,
      outcome: 'closed_with_residual',
      residual: closeResidual,
      alreadyClosed,
      known,
    };
  }
  return { ok: true, outcome: 'closed', alreadyClosed, known };
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

  // The registry entry is deleted right below, so the loser's worker must be
  // put on a guaranteed path to death here. killWorker refuses an unprepared
  // live remote worker (P0-2) — correct for lineage, but on this path the
  // refusal recreated the P0-new orphan: row closed, registry cleared,
  // credential-carrying worker alive and unreachable. A remote loser is
  // therefore retired process-only: SIGTERM now, SIGKILL by backstop. To be
  // precise about the claim (fourth-round review): this SIGNALS death and arms
  // the escalation — it does not synchronously prove the exit. That is
  // acceptable here because nothing downstream gates on this process being
  // gone (unlike the VC fence, which separately demands exit proof before
  // admitting replay); the registry delete below is safe either way.
  //
  // No remote cancel is issued: the lineage stays on the CLOSED row
  // (riffParentTaskId) as the manual-cleanup handle, mirroring the drain's
  // isolation-over-deletion shape — named in the log below so an operator can
  // actually find it. Local losers keep killWorker so their backing session
  // is destroyed.
  if (isRemoteBackendSession(loser)) {
    if (loser.session.riffParentTaskId) {
      logger.warn(
        `[${tag(loser)}] collision loser owns remote lineage `
        + `${loser.session.riffParentTaskId}; it is NOT cancelled and stays on the closed `
        + 'row for manual cleanup',
      );
    }
    retireWorkerProcessOnly(loser, 'collision_loser');
  } else {
    killWorker(loser);
  }
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
  // Plan B: a VC meeting agent is an ordinary chat-scope session keyed by its
  // normal chat anchor — this must stay in lockstep with activeSessionKey()
  // (core/types.ts) so a restored meeting row re-registers at the SAME slot the
  // live path uses. The vcMeetingReceiver marker is delivery metadata only.
  return sessionKey(storedSessionAnchorId(session), larkAppId);
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

// IPC transport and worker acknowledgement are separate stages. A transport
// timeout may retry because the parent never confirmed enqueue; an ACK timeout
// is only a delayed/ambiguous state because the child may still execute later.
const ORDINARY_IM_TRANSPORT_TIMEOUT_MS = 2_000;
const ORDINARY_IM_ACK_SETTLEMENT_TIMEOUT_MS = 2_000;
const ORDINARY_IM_MAX_ATTEMPTS = 2;

type OrdinaryImDelivery = {
  key: string;
  ds: DaemonSession;
  worker: ChildProcess;
  workerGeneration: number;
  message: Extract<DaemonToWorker, { type: 'message' | 'init' }>;
  turnId: string;
  attempt: number;
  received: boolean;
  transportConfirmed: boolean;
  delayNotified: boolean;
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

function failOrdinaryImDelivery(
  record: OrdinaryImDelivery,
  reason: string,
  messageKey: 'worker.input_delivery_failed' | 'worker.input_retired_unconfirmed'
    = 'worker.input_delivery_failed',
): void {
  if (pendingOrdinaryImDeliveries.get(record.key) !== record) return;
  clearOrdinaryImDelivery(record);
  logger.error(
    `[${tag(record.ds)}] Ordinary IM worker delivery failed `
    + `turn=${record.turnId.substring(0, 16)} generation=${record.workerGeneration} `
    + `attempts=${record.attempt} reason=${reason}`,
  );
  if (record.turnId.startsWith('bmx-recovery-')) {
    requireOrdinaryTurnRecoveryAttention(
      record.ds.session,
      record.turnId,
      'recovery_delivery_failed',
    );
    return;
  }
  // Plan B: a meeting agent is an ordinary chat-scope session. This tracker only
  // ever holds ORDINARY IM turns (durable transcript deliveries use the receipt
  // path, not this map), so a plain user turn's delivery failure must be reported
  // like any session — otherwise the user's message is silently dropped. Only a
  // stamped meeting @mention follow-up stays fenced (isMeetingDrivenTurn); a
  // silent scheduled turn stays suppressed as before. (isMeetingDrivenTurn
  // supersedes the pre-Plan-B `vcMeetingReceiver` blanket check.)
  if (isMeetingDrivenTurn(record.ds, record.turnId) || isSilentScheduledTurn(record.ds, record.turnId)) return;
  const loc = botLocale(getBot(record.ds.larkAppId).config);
  void requireCallbacks().sessionReply(
    sessionAnchorId(record.ds),
    tr(messageKey, { turnId: record.turnId.substring(0, 16) }, loc),
    'text',
    record.ds.larkAppId,
    record.turnId,
  ).catch(err => logger.error(
    `[${tag(record.ds)}] Failed to report ordinary IM worker delivery failure: `
    + `${err instanceof Error ? err.message : String(err)}`,
  ));
}

function delayOrdinaryImDelivery(record: OrdinaryImDelivery): void {
  if (pendingOrdinaryImDeliveries.get(record.key) !== record) return;
  // A delayed notice is only an intermediate status. Keep the delivery record
  // so a later explicit rejection or worker exit can still produce the real
  // terminal outcome instead of silently dropping the turn after telling the
  // user not to resend it.
  clearOrdinaryImDeliveryTimer(record);
  if (record.delayNotified) return;
  record.delayNotified = true;
  logger.warn(
    `[${tag(record.ds)}] Ordinary IM input is still waiting for the worker after IPC enqueue `
    + `turn=${record.turnId.substring(0, 16)} generation=${record.workerGeneration} `
    + `attempt=${record.attempt}`,
  );
  if (
    record.turnId.startsWith('bmx-recovery-')
    || isMeetingDrivenTurn(record.ds, record.turnId)
    || isSilentScheduledTurn(record.ds, record.turnId)
  ) return;
  const loc = botLocale(getBot(record.ds.larkAppId).config);
  const messageKey = record.received
    ? 'worker.input_commit_delayed'
    : 'worker.input_delivery_delayed';
  void requireCallbacks().sessionReply(
    sessionAnchorId(record.ds),
    tr(messageKey, { turnId: record.turnId.substring(0, 16) }, loc),
    'text',
    record.ds.larkAppId,
    record.turnId,
  ).catch(err => logger.error(
    `[${tag(record.ds)}] Failed to report delayed ordinary IM worker delivery: `
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
  record.received = false;
  record.transportConfirmed = false;
  const attempt = ++record.attempt;
  record.timer = setTimeout(() => {
    retryOrFailOrdinaryImDelivery(record, 'ipc_callback_timeout');
  }, ORDINARY_IM_TRANSPORT_TIMEOUT_MS);
  record.timer.unref?.();
  try {
    record.worker.send(record.message, (err) => {
      if (pendingOrdinaryImDeliveries.get(record.key) !== record || record.attempt !== attempt) return;
      if (record.received) return;
      if (err) {
        retryOrFailOrdinaryImDelivery(record, `ipc_callback:${err.message}`);
        return;
      }
      record.transportConfirmed = true;
      clearOrdinaryImDeliveryTimer(record);
      logger.info(
        `[${tag(record.ds)}] Ordinary IM input enqueued to worker IPC `
        + `turn=${record.turnId.substring(0, 16)} generation=${record.workerGeneration} attempt=${attempt}`,
      );
      record.timer = setTimeout(() => {
        delayOrdinaryImDelivery(record);
      }, ORDINARY_IM_ACK_SETTLEMENT_TIMEOUT_MS);
      record.timer.unref?.();
    });
  } catch (err) {
    queueMicrotask(() => retryOrFailOrdinaryImDelivery(
      record,
      `ipc_throw:${err instanceof Error ? err.message : String(err)}`,
    ));
    return true;
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
    received: false,
    transportConfirmed: false,
    delayNotified: false,
  };
  pendingOrdinaryImDeliveries.set(key, record);
  return sendOrdinaryImDeliveryAttempt(record);
}

function shouldTrackOrdinaryImDelivery(
  ds: DaemonSession,
  message: Extract<DaemonToWorker, { type: 'message' | 'init' }>,
): boolean {
  return !!message.turnId
    && (message.turnId.startsWith('om_') || message.turnId.startsWith('bmx-recovery-'))
    && message.dispatchAttempt === undefined
    && (message.type !== 'init' || (!!message.prompt && !message.adoptMode))
    && !isSharedAdoptSession(ds)
    // Plan B: a meeting agent is an ordinary chat-scope session. A plain user
    // turn on it IS an ordinary IM delivery (track it for receipt-ACK + retry so
    // its failure is reported). Only a meeting-driven turn — a stamped @mention
    // follow-up here, since durable deliveries are already excluded by the
    // dispatchAttempt===undefined guard above — stays on the receipt/lease path.
    && !isMeetingDrivenTurn(ds, message.turnId, message.dispatchAttempt)
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
  if (!record.received) {
    record.received = true;
    clearOrdinaryImDeliveryTimer(record);
    record.timer = setTimeout(() => {
      delayOrdinaryImDelivery(record);
    }, ORDINARY_IM_ACK_SETTLEMENT_TIMEOUT_MS);
    record.timer.unref?.();
  }
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

/** A retiring worker's late COMMIT ACK settles only the deliveries tracked
 * against that exact worker object. The record's own worker identity is the
 * authority here — deliberately NOT ds.worker/ds.workerGeneration, which have
 * already moved on (suspend nulls the worker; a replacement fork advances the
 * generation) by the time the ACK drains from the old child. Receipt ACKs are
 * deliberately excluded: a stale receipt is not settlement-grade — the turn
 * can still die unexecuted with the old worker, and swallowing the pending
 * timers on it would silence the original generation's visible failure. */
function completeStaleWorkerOrdinaryImDelivery(worker: ChildProcess, turnId: string): void {
  for (const record of pendingOrdinaryImDeliveries.values()) {
    if (record.worker !== worker || record.turnId !== turnId) continue;
    clearOrdinaryImDelivery(record);
  }
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

function settleOrdinaryImDeliveriesForWorker(
  worker: ChildProcess,
  options: {
    suppressAllFailures: boolean;
    startupOwnedTurnId?: string;
    retiredBeforeCommit?: boolean;
  },
): void {
  for (const record of pendingOrdinaryImDeliveries.values()) {
    if (record.worker !== worker) continue;
    if (options.suppressAllFailures || record.turnId === options.startupOwnedTurnId) {
      // A record still pending here means the daemon never observed the
      // commit ACK — but a fire-and-forget ACK can also be lost when the old
      // child exits right after sending it, so this does NOT prove the turn
      // never entered the CLI. A deliberate lifecycle retirement (suspend /
      // worker replacement) must not turn that into silence, and must not
      // claim certainty either: report an honest unconfirmed outcome that
      // asks the user to check the session before resending. Transfer, close
      // and plain kill keep silent settling.
      if (options.retiredBeforeCommit) {
        failOrdinaryImDelivery(record, 'worker_retired_before_commit', 'worker.input_retired_unconfirmed');
        continue;
      }
      clearOrdinaryImDelivery(record);
      continue;
    }
    const reason = record.received
      ? 'worker_exited_after_receipt'
      : record.transportConfirmed
        ? 'worker_exited_after_ipc_enqueue'
        : 'worker_exited_before_ipc_enqueue';
    failOrdinaryImDelivery(record, reason);
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
  if (isSharedAdoptSession(ds)) return { ok: false, error: 'adopt_not_relayable' };

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
  const sourcePinnedStreamingIds = captureLifecycleStreamingCardCleanupIds(
    ds.larkAppId,
    ds.chatId,
    ds,
    snapshotStreamingCardIds(ds),
  );
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
  rehomeReplyTargetState(ds);

  sessionStore.updateSession(ds.session);

  const newAnchor = sessionAnchorId(ds);
  if (activeSessionsRegistry) {
    if (!setActiveSessionIfActive(activeSessionsRegistry, sessionKey(newAnchor, ds.larkAppId), ds)) {
      return { ok: false, error: 'session_not_active' };
    }
  }
  routingCommitted = true;
  // The route is now durable and the source card identity has been cleared.
  // Unpin exactly the pre-commit capture: a target publication racing after
  // this point must never be selected by source cleanup.
  if (sourcePinnedStreamingIds.length > 0) {
    void unpinStreamingCardIds(ds.larkAppId, sourcePinnedStreamingIds, ds);
  }

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
 *  can drive at cold spawn (Claude family / Grok: `--fork-session`; Codex terminal:
 *  `codex fork <id>`). App-server backends (codex-app, or a codex CLI running in
 *  Hybrid RPC mode) keep state in a live app-server process + SQLite and have no
 *  byte-level fork we can reproduce — they are refused. Riff / other pure-remote
 *  backends have no local rollout to fork either. */
const FORK_CAPABLE_CLI_IDS: ReadonlySet<CliId> = new Set<CliId>([
  'claude-code', 'seed', 'relay', 'codex', 'grok',
]);

/** True when this session can be byte-level forked via a CLI-native primitive.
 *  Refuses codex-app outright, and refuses a plain `codex` session that is
 *  running in Hybrid RPC mode (its live thread lives in the app-server, not a
 *  forkable local rollout). */
export function isForkCapableSession(ds: DaemonSession): boolean {
  const botCfg = getBot(ds.larkAppId).config;
  const cliId = sessionCliId(ds, botCfg);
  if (!FORK_CAPABLE_CLI_IDS.has(cliId)) return false;
  // An external App Server thread is not a local rollout. `codex fork` would
  // resolve against the terminal client's own CODEX_HOME and could fork an
  // unrelated/empty local session, so refuse rather than claiming a copy was
  // made. A future server-side thread/fork primitive can add an explicit path.
  if (ds.session.existingAppServerEndpoint) return false;
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
  if (ds.pendingRepo) return { ok: false, error: 'not_started_yet' };
  if (!isRelayableRealSession(ds)) return { ok: false, error: 'not_started_yet' };
  if (isSharedAdoptSession(ds)) return { ok: false, error: 'adopt_not_forkable' };
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
  //   • reasoningEffort / cliPathOverride / wrapperCli / agentFrozen:
  //     without these the child's sessionAgentConfig() sees !agentFrozen and
  //     re-freezes from the CURRENT bot config, silently dropping any per-session
  //     /effort override the source carried (reasoningEffort has no botCfg
  //     fallback at all → drops to undefined). Copying the frozen tuple keeps
  //     the clone's launch identity == the source's. `model` is no longer a
  //     FROZEN value — it resolves from the live bot config at every spawn — but
  //     the record of what the source last launched with still has to travel:
  //     when the source is pinned to a CLI the bot no longer runs, that record is
  //     the only thing keeping either session off the CLI default (rule 3 in
  //     resolveSessionLaunchModel). Copying it cannot resurrect the old frozen
  //     bug, because the live bot model outranks it whenever the CLIs match.
  //     An explicit per-trigger override rides on the runtime childDs below.
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
  childSession.reasoningEffort = ds.session.reasoningEffort;
  childSession.model = ds.session.model;
  childSession.cliLaunchSnapshot = ds.session.cliLaunchSnapshot
    ? {
        ...ds.session.cliLaunchSnapshot,
        cliRuntime: ds.session.cliLaunchSnapshot.cliRuntime
          ? { ...ds.session.cliLaunchSnapshot.cliRuntime, update: { ...ds.session.cliLaunchSnapshot.cliRuntime.update } }
          : null,
        startupCommands: [...ds.session.cliLaunchSnapshot.startupCommands],
      }
    : undefined;
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
    // Explicit per-trigger model override travels with the runtime session, so a
    // fork of a trigger session launches on the same model the caller asked for.
    ...(ds.spawnModelOverride ? { spawnModelOverride: ds.spawnModelOverride } : {}),
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

/**
 * Recovery-seam at-most-once fence for a keyed follow-up turn (turnIdempotencyKey,
 * PR #818). The turn-level idempotency lease terminalizes an interrupted keyed
 * turn to a durable `failed(dispatch_unknown)` (worker-exit convergence / boot
 * reconcile / same-key retry) and — unlike a fresh async-virtual session — LEAVES
 * the shared session open and un-quarantined (P1-3). So a later refork of that
 * session must NOT resurrect the interrupted turn: `noReplay` only lives on the
 * transient input queues (pendingMessages / inflight), NOT on the durable Codex
 * App dispatch ledger. Without this fence, the recovery path
 * (codexAppRecoveredDispatches → worker init → recoveredAcceptedInputs, keyed on
 * `state==='accepted'` alone) would re-issue `turn/start` for a turn the caller
 * was already told is `failed` at-most-once — the ledger is the third replay
 * channel the lease's noReplay does not reach (codex #818 recovery-seam finding).
 *
 * Fence: for each `accepted` (NEVER `prepared`) ledger entry whose OWNER-MATCHED
 * async terminal is already `failed(dispatch_unknown)`, durably retire the entry
 * via cancelCodexAppDispatch. The retirement is TRANSACTIONAL: if any candidate
 * cannot be exact-cancelled (a prepared successor pins the FIFO, or the entry
 * vanished), the whole batch is rolled back in-memory and the fence THROWS before
 * any persist — never a partial retire, never a fork past a still-live
 * terminalized `accepted`. Idempotent and re-run at EVERY recovery seam, so it
 * also covers the window where the durable failed was written but a crash hit
 * before the exit-time retirement (the durable async truth is authoritative,
 * re-checked here). A `prepared` entry is never cancelled without proof — the
 * runner may have crossed the write boundary; the fence only ever targets
 * `accepted`, and a prepared frame blocking an accepted retirement aborts the
 * fork (above). Owner-scoped: only THIS bot's failed evidence counts, so a
 * foreign/unstamped async record never retires our accepted entry.
 *
 * FAIL-CLOSED (codex #818 recovery-seam round-2). At-most-once forbids replaying
 * a turn the caller was already told is `failed`, so an ambiguous fence THROWS
 * rather than proceeding to fork:
 *   1. Read side uses `asyncTriggerStore.lookupStrict` — a present-but-unreadable
 *      / corrupt terminal file must NOT fold into "no record" (soft `lookup`),
 *      which would let the accepted entry re-enter the recovery snapshot and
 *      replay. ENOENT / absent trigger is a genuine "no terminal" and is fine.
 *   2. Retire persist failure (updateSession EIO): the in-memory ledger is rolled
 *      back to `priorLedger` and the error is RETHROWN, aborting this fork before
 *      the recovery snapshot is taken. `staggeredRecoveryFork` (the boot eager
 *      re-attach caller) already try/catches each fork, isolates the row, and
 *      retains it for a later retry — so the durable ledger + async truth stay
 *      intact and the next seam re-attempts the retirement. Degrading to "replay
 *      once" (the pre-fix behavior) would itself be the P1 we are closing.
 * @throws when the authoritative async truth is unreadable, or the retirement
 *  cannot be durably persisted — the caller (forkWorker) must abort this fork.
 */
function retireTerminalizedCodexAppLedgerEntriesForRecovery(ds: DaemonSession): void {
  const ledger = ds.session.codexAppDispatchLedger;
  if (!ledger || ledger.length === 0) return;
  const ownerLarkAppId = ds.larkAppId;
  const toRetire = ledger.filter(entry =>
    entry.state === 'accepted'
    && (() => {
      // STRICT read: a present-but-unreadable / corrupt terminal file THROWS
      // (fail-closed) instead of folding into "no record" and replaying. ONLY
      // our own durable dispatch_unknown failed counts (async-trigger-store is
      // keyed by sessionId, so a foreign/unstamped terminal on the same
      // sessionId/triggerId must not retire our accepted entry — mirrors the
      // owner-positive-proof gate used everywhere else in the idempotency path).
      const rec = asyncTriggerStore.lookupStrict(ds.session.sessionId, entry.turnId);
      return !!rec
        && rec.ownerLarkAppId === ownerLarkAppId
        && rec.result.status === 'failed'
        && rec.result.reason === 'dispatch_unknown';
    })());
  if (toRetire.length === 0) return;
  // TRANSACTIONAL retirement (codex #818 exact-retirement fail-open). All work is
  // done against an in-memory working copy; nothing is persisted until EVERY
  // owner-matched terminal candidate has been exact-cancelled. If ANY candidate
  // cannot be cancelled — `prepared_successor_exists` (a later prepared frame
  // pins the FIFO) or `dispatch_not_found` (the ledger changed under us) — we
  // restore the in-memory ledger to `priorLedger` and THROW *before* any persist,
  // aborting this fork fail-closed. A `continue`-and-fork would leave that
  // terminalized `accepted` entry to be replayed as `recoveredAcceptedInputs`
  // (the generation fence only constrains `prepared`, never re-adds noReplay to a
  // surviving `accepted`), and a partial persist could retire some while forking
  // the rest. All-or-nothing + fail-closed is the only safe shape.
  const priorLedger = ds.session.codexAppDispatchLedger;
  let workingLedger = [...(ds.session.codexAppDispatchLedger ?? [])];
  const retiredTurnIds: string[] = [];
  for (const entry of toRetire) {
    const cancelled = cancelCodexAppDispatch(workingLedger, {
      dispatchId: entry.dispatchId,
      turnId: entry.turnId,
      ...(entry.dispatchAttempt !== undefined ? { dispatchAttempt: entry.dispatchAttempt } : {}),
    });
    if (!cancelled.ok) {
      // Cannot exact-cancel a terminalized accepted entry (prepared successor /
      // vanished). Abort the whole retirement + fork fail-closed; a later seam
      // re-attempts once the blocking prepared frame settles or the ledger
      // stabilizes. NEVER fall through to fork with a live terminalized accepted.
      ds.session.codexAppDispatchLedger = priorLedger;
      throw new Error(
        `recovery fence could not exact-retire terminalized Codex App dispatch `
        + `turn=${entry.turnId} (${cancelled.error}); aborting fork (fail-closed)`,
      );
    }
    workingLedger = cancelled.ledger;
    retiredTurnIds.push(entry.turnId);
  }
  // Every candidate retired on the working copy — commit ONCE.
  ds.session.codexAppDispatchLedger = workingLedger;
  try {
    sessionStore.updateSession(ds.session);
    for (const turnId of retiredTurnIds) {
      logger.warn(
        `[${ds.session.sessionId.slice(0, 8)}] Recovery fence retired at-most-once terminalized `
        + `Codex App dispatch turn=${turnId.slice(0, 12)} (durable failed:dispatch_unknown; not replayed)`,
      );
    }
    if (!hasUnsettledCodexAppDispatch(ds.session.codexAppDispatchLedger)) {
      void Promise.resolve(callbacks?.onCodexAppLedgerDrained?.(ds)).catch(err => {
        logger.error(
          `[${ds.session.sessionId.slice(0, 8)}] post-recovery-fence ledger-drain cleanup failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  } catch (err) {
    // Persist failed (EIO/ENOSPC). Roll back the in-memory ledger so the durable
    // async truth + the on-disk ledger stay consistent, then RETHROW to ABORT
    // this fork BEFORE the recovery snapshot is taken (fail-closed). Degrading to
    // "let the accepted entry replay once" is exactly the at-most-once violation
    // this fence exists to close, so we must NOT proceed to fork. The boot eager
    // re-attach caller (staggeredRecoveryFork) try/catches each fork, isolates
    // this row, and retains it for a later retry — so the next seam re-attempts
    // the retirement against the intact durable state.
    ds.session.codexAppDispatchLedger = priorLedger;
    logger.error(
      `[${ds.session.sessionId.slice(0, 8)}] Recovery fence could not persist retired ledger; `
      + `aborting fork (fail-closed), will retry next seam: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err instanceof Error
      ? err
      : new Error(`recovery-fence ledger retirement persist failed: ${String(err)}`);
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

/** Finish ordinary-turn recovery bookkeeping only after a fresh Lark turn has
 * crossed its real admission boundary (durable activation tail or worker
 * input). The user turn is already accepted at this point, so persistence
 * failures here are logged without making the caller retry and risk a duplicate
 * execution. */
function recordAdmittedOrdinaryUserTurn(
  ds: DaemonSession,
  turnId: string,
  opts: { beginRecovery: boolean },
): void {
  const priorRecoveryStatus = ds.session.ordinaryTurnRecovery?.status;
  let recoveryBookkeepingSucceeded = false;
  try {
    if (opts.beginRecovery) {
      const state = beginOrdinaryTurnRecovery(ds.session, turnId);
      recoveryBookkeepingSucceeded = state?.logicalTurnId === turnId
        && state.currentTurnId === turnId;
    } else {
      const state = cancelOrdinaryRecoveryForUserInput(ds.session, turnId);
      recoveryBookkeepingSucceeded = state?.status === 'cancelled'
        && state.cancelledByTurnId === turnId;
    }
  } catch (err) {
    logger.error(
      `[${tag(ds)}] Failed to persist ordinary-turn recovery bookkeeping `
      + `after admitting ${turnId.substring(0, 16)}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (recoveryBookkeepingSucceeded
    && (priorRecoveryStatus === 'exhausted' || priorRecoveryStatus === 'attention_required')
    && ds.agentAttention) {
    ds.agentAttention = undefined;
    publishAttentionPatch(ds);
  }
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
    /** At-most-once (idempotency lease): forward to the worker so a keyed
     * follow-up delivered to a LIVE worker is tagged noReplay and never replays
     * onto an auto-restarted CLI after a crash+terminalize (turn-level PR #71).
     * The dormant-fork path rides `atMostOnce` on the fork init instead. */
    atMostOnce?: true;
    trustedCaller?: TrustedCaller;
  } = {},
): boolean {
  const remoteRetirementPhase = remoteRetirementAdmissionPhase(ds);
  if (remoteRetirementPhase) {
    const remoteBackend = (ds.initConfig?.backendType ?? ds.session.backendType) === 'mojo'
      ? 'Mojo'
      : 'Riff';
    logger.warn(
      `[${tag(ds)}] Rejected turn ${turnId ?? '?'} while ${remoteBackend} retirement fence is ${remoteRetirementPhase}`,
    );
    void callbacks?.sessionReply(
      sessionAnchorId(ds),
      tr('worker.remote_close_in_progress', { backend: remoteBackend }, localeForBot(ds.larkAppId)),
      'text',
      ds.larkAppId,
      turnId,
    ).catch(err => {
      logger.warn(
        `[${tag(ds)}] Failed to notify rejected remote close-race turn: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return false;
  }
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
          ...(opts.trustedCaller ? { trustedCaller: opts.trustedCaller } : {}),
        },
        turnId: queuedTurnId,
        ...(opts.dispatchAttempt !== undefined
          ? { dispatchAttempt: opts.dispatchAttempt }
          : {}),
      });
      logger.info(
        `[${tag(ds)}] Staged turn ${queuedTurnId} behind queued activation ACK`,
      );
      if (turnId?.startsWith('om_')) {
        recordAdmittedOrdinaryUserTurn(ds, turnId, { beginRecovery: false });
      }
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
    // A parked (crash-loop stopped) worker respawns the CLI from INSIDE the
    // worker when this message arrives, and that path has no restart IPC to
    // refresh its launch snapshot — so carry the current model on the message
    // itself. Only while parked: an ordinary turn changes no launch config, and
    // an unconditional field would be pure noise on every message.
    ...(ds.crashDiagnosticParked ? { model: latestModelForRespawn(ds) } : {}),
    ...(codexAppInput ? { codexAppInput } : {}),
    ...(nativeSessionTitle ? { nativeSessionTitle } : {}),
    ...(nativeSessionTitlePrompt ? { nativeSessionTitlePrompt } : {}),
    ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
    ...(replyTurnId ? { replyTurnId } : {}),
    ...(opts.dispatchAttempt !== undefined ? { dispatchAttempt: opts.dispatchAttempt } : {}),
    ...(codexAppDispatchId ? { codexAppDispatchId } : {}),
    ...(opts.codexAppSteerable ? { codexAppSteerable: true } : {}),
    ...(opts.atMostOnce ? { atMostOnce: true } : {}),
    ...(opts.trustedCaller ? { trustedCaller: opts.trustedCaller } : {}),
    ...(vcMeetingImTurnOrigin
      ? { vcMeetingImTurnOrigin }
      : {}),
    ...(mojoLivePatchForSession(ds) ?? {}),
  };
  // First moment with a reply context after a restore/resume-time quarantine.
  deliverPendingMojoQuarantineNotice(ds, turnId, opts.dispatchAttempt);
  deliverPendingMojoLegacyPinNotice(ds, turnId, opts.dispatchAttempt);
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
  if (turnId?.startsWith('om_')) {
    recordAdmittedOrdinaryUserTurn(ds, turnId, { beginRecovery: true });
  }
  return true;
}

/**
 * Complete live-credential snapshot to ride along with a turn, so a live mojo
 * session picks up a rotated / cleared JWT without a refork.
 *
 * Sent on EVERY turn rather than only when it differs from the init snapshot. The
 * daemon cannot know which patches a live worker has already applied, so diffing
 * against init was wrong in both directions:
 *   - a deleted `mojo.jwt` produced no patch, leaving the old token in place;
 *   - `init A → patch B → config rolled back to A` compared A against A and sent
 *     nothing, leaving the backend on B.
 * The backend de-duplicates against its own current value, which is the only
 * authoritative source.
 *
 * The control plane is NOT included — it stays frozen for the session's lifetime.
 */
export function mojoLivePatchForSession(ds: DaemonSession): { mojoLivePatch: MojoLivePatch } | undefined {
  const backendType = ds.initConfig?.backendType ?? ds.session.backendType;
  if (backendType !== 'mojo') return undefined;
  let botCfg;
  try {
    botCfg = getBot(ds.larkAppId).config;
  } catch {
    return undefined;
  }
  // Resolves jwtEnv daemon-side across the same layers buildEnv() uses, so the
  // worker receives a value and never an env map.
  return {
    mojoLivePatch: pickMojoLivePatch(botCfg.mojo, {
      genericEnv: botCfg.env ? sanitizePerBotEnv(botCfg.env) : undefined,
    }),
  };
}

/**
 * Is auxiliary UI an authorized output channel for this session/turn?
 *
 * The single source of truth for this policy: setupWorkerHandlers' own
 * `managedAuxUiSuppressed` now delegates here instead of keeping a parallel copy
 * that could drift. Deliberately conservative: a
 * dedicated VC receiver, a silent scheduled turn, or a session with no real Lark
 * transport must never receive a bypass message. Those cases still get the
 * persisted quarantine state for dashboard/audit — the notice is only about the
 * chat channel.
 */
/** Sessions with a quarantine notice send in flight, so it cannot double-post. */
const mojoQuarantineNoticeInFlight = new Set<string>();

/**
 * Auxiliary-UI suppression policy for the **mojo quarantine notice** path.
 *
 * NOTE (Plan B merge, 2026-08): setupWorkerHandlers' `managedAuxUiSuppressed`
 * no longer delegates here — it keeps its own inline copy that gates on
 * `isMeetingDrivenTurn` instead of this function's pre-Plan-B blanket
 * `ds.session.vcMeetingReceiver` check. That blanket check would re-suppress a
 * plain user turn on a meeting-agent chat session (the "手动@不回复" regression),
 * which is exactly why the streaming/aux path had to diverge. This function is
 * therefore currently the mojo-quarantine caller's policy only; migrating it to
 * `isMeetingDrivenTurn` (so the two converge again without the regression) is a
 * tracked follow-up. ordinaryTurnRecoveryEligible (below) carries the same
 * pre-Plan-B blanket and is on the same follow-up.
 *
 * Previously setupWorkerHandlers held this as a closure and the quarantine notice
 * COPIED three of its four checks — dropping `ordinaryManagedSuppression`, so a
 * durable-suppressed turn still posted to Lark. Copying a policy is how the two
 * diverge; this is the shared implementation both now call.
 *
 * Returns true when auxiliary UI must be suppressed.
 */
export function auxUiSuppressedFor(
  ds: DaemonSession,
  turnId?: string,
  dispatchAttempt?: number,
): boolean {
  // No-transport session (apiOnly bot or HTTP virtual chat): there is no real
  // Feishu chat to render into.
  try {
    if (!larkTransportEnabled({
      chatId: ds.chatId,
      apiOnly: getBot(ds.larkAppId).config.apiOnly,
    })) return true;
  } catch {
    // Bot deregistered — fail closed.
    return true;
  }
  if (isSilentScheduledTurn(ds, turnId)) return true;
  if (ds.session.vcMeetingReceiver) return true;
  // Durable ledger: an attempt at or below the armed watermark is a replay whose
  // output already happened (or was deliberately suppressed).
  const armedThrough = turnId ? ds.suppressedFinalOutputTurns?.get(turnId) : undefined;
  return dispatchAttempt !== undefined
    && armedThrough !== undefined
    && dispatchAttempt <= armedThrough;
}

/**
 * Deliver the one-time notice that a mojo session's earlier remote lineage was
 * parked, then clear the flag.
 *
 * Quarantining happens during restore/resume where there is no reply context, so
 * the notice is deferred to the first ACCEPTED turn — hot send and cold fork both
 * call this, since a cold-resumed session goes straight to forkWorker and would
 * otherwise never deliver it.
 *
 * The flag is marked delivered (`false`) only AFTER a successful send, so a
 * transient Lark failure retries on the next turn instead of losing the notice
 * permanently. For a suppressed channel (durable replay / silent schedule / VC
 * receiver / no transport) the flag STAYS PENDING: that turn merely had no
 * authorized output channel, so a later ordinary IM turn delivers it. The
 * quarantine state itself is persisted for dashboard/audit either way.
 */
function deliverPendingMojoQuarantineNotice(
  ds: DaemonSession,
  turnId?: string,
  dispatchAttempt?: number,
): void {
  if (ds.session.mojoQuarantineNoticePending !== true) return;
  // In-flight guard: two turns can be accepted before the first sessionReply
  // resolves, which would post the notice twice.
  if (mojoQuarantineNoticeInFlight.has(ds.session.sessionId)) return;
  const lineage = ds.session.mojoQuarantinedLineage;
  if (!lineage) {
    ds.session.mojoQuarantineNoticePending = undefined;
    sessionStore.updateSession(ds.session);
    return;
  }
  let botCfg;
  try {
    botCfg = getBot(ds.larkAppId).config;
  } catch {
    return; // Bot deregistered — retry once it is back.
  }
  // `false` = DELIVERED, distinct from `undefined` = never queued. Clearing to
  // undefined made the restore migration read it as "old build, never notified"
  // and queue the notice again after every restart.
  const markDelivered = (): void => {
    ds.session.mojoQuarantineNoticePending = false;
    sessionStore.updateSession(ds.session);
  };
  if (auxUiSuppressedFor(ds, turnId, dispatchAttempt)) {
    // Stay PENDING: this turn simply had no authorized channel (durable replay,
    // silent schedule, VC receiver, no transport). A later ordinary IM turn
    // delivers it. The quarantine state itself is already persisted for
    // dashboard/audit either way.
    logger.info(
      `[${tag(ds)}] mojo quarantine notice deferred — no authorized output channel `
      + 'for this turn; still pending',
    );
    return;
  }
  mojoQuarantineNoticeInFlight.add(ds.session.sessionId);
  const message = tr('worker.mojo_lineage_quarantined', { lineage }, botLocale(botCfg));
  void callbacks?.sessionReply(
    sessionAnchorId(ds),
    message,
    'text',
    ds.larkAppId,
    // The turn that actually carried this delivery, not a stale reply target.
    turnId,
    ds.session.vcMeetingReceiver ? { sourceSessionId: ds.session.sessionId } : undefined,
  ).then(markDelivered).catch((err) => {
    // Flag intentionally left set: the next turn retries.
    logger.warn(`[${tag(ds)}] failed to deliver mojo quarantine notice (will retry): ${err}`);
  }).finally(() => {
    mojoQuarantineNoticeInFlight.delete(ds.session.sessionId);
  });
}

const mojoLegacyPinNoticeInFlight = new Set<string>();

/** In-chat twin of the sessionMojoConfig legacy pin's daemon-log warn: without
 *  it the user keeps retrying a session whose tools and replies silently fail
 *  (observed live). Same pending/delivered protocol and suppression rules as
 *  deliverPendingMojoQuarantineNotice above. */
function deliverPendingMojoLegacyPinNotice(
  ds: DaemonSession,
  turnId?: string,
  dispatchAttempt?: number,
): void {
  if (ds.session.mojoLegacyPinNoticePending !== true) return;
  if (mojoLegacyPinNoticeInFlight.has(ds.session.sessionId)) return;
  let botCfg;
  try {
    botCfg = getBot(ds.larkAppId).config;
  } catch {
    return; // Bot deregistered — retry once it is back.
  }
  if (auxUiSuppressedFor(ds, turnId, dispatchAttempt)) {
    logger.info(
      `[${tag(ds)}] mojo legacy-pin notice deferred — no authorized output channel `
      + 'for this turn; still pending',
    );
    return;
  }
  mojoLegacyPinNoticeInFlight.add(ds.session.sessionId);
  const message = tr('worker.mojo_legacy_pinned', {}, botLocale(botCfg));
  void callbacks?.sessionReply(
    sessionAnchorId(ds),
    message,
    'text',
    ds.larkAppId,
    turnId,
    ds.session.vcMeetingReceiver ? { sourceSessionId: ds.session.sessionId } : undefined,
  ).then(() => {
    ds.session.mojoLegacyPinNoticePending = false;
    // Best-effort, same as the queueing side (review N2): the notice IS
    // delivered at this point — a failed persist only risks one duplicate
    // send after a restart, and must not surface as a delivery failure.
    try {
      sessionStore.updateSession(ds.session);
    } catch (err) {
      logger.warn(
        `[${tag(ds)}] mojo legacy-pin notice delivered but the delivered marker could not be `
        + `persisted (may re-send once after a restart): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }).catch((err) => {
    // Flag intentionally left set: the next turn retries.
    logger.warn(`[${tag(ds)}] failed to deliver mojo legacy-pin notice (will retry): ${err}`);
  }).finally(() => {
    mojoLegacyPinNoticeInFlight.delete(ds.session.sessionId);
  });
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
    ...(head.cliInput.trustedCaller ? { trustedCaller: head.cliInput.trustedCaller } : {}),
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
      // Same parked-worker launch-snapshot refresh as the ordinary send.
      ...(ds.crashDiagnosticParked ? { model: latestModelForRespawn(ds) } : {}),
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
      ...(exactInput.trustedCaller ? { trustedCaller: exactInput.trustedCaller } : {}),
      queuedActivationToken: token,
      ...(vcMeetingImTurnOrigin ? { vcMeetingImTurnOrigin } : {}),
    } as DaemonToWorker);
    if (head.turnId.startsWith('om_')) {
      recordAdmittedOrdinaryUserTurn(ds, head.turnId, { beginRecovery: true });
    }
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
      ...(entry.cliInput.trustedCaller ? { trustedCaller: entry.cliInput.trustedCaller } : {}),
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
  trustedCaller?: TrustedCaller;
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
  const remoteRetirementPhase = remoteRetirementAdmissionPhase(ds);
  if (remoteRetirementPhase) {
    // A close/shutdown coordinator owns this exact remote generation. Never
    // spawn a replacement behind its back: a fork can materialize the opening
    // prompt before sendWorkerInput gets a chance to reject it. Route non-empty
    // input through the ordinary fence solely for the user-visible warning.
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
        ...(gatedPrompt.codexAppSteerable === true
          ? { codexAppSteerable: true as const }
          : {}),
      });
    }
    logger.warn(
      `[${tag(ds)}] Refused worker fork while remote retirement fence is ${remoteRetirementPhase}`,
    );
    // The request was handled by the retirement fence; false is reserved for
    // tail-only quarantine promotion failures by this function's contract.
    return true;
  }
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
      const gatedAtMostOnce = typeof resumeOrTurnId === 'object' && resumeOrTurnId !== null
        ? resumeOrTurnId.atMostOnce
        : undefined;
      const gatedTrustedCaller = gatedPrompt.trustedCaller
        ?? (typeof resumeOrTurnId === 'object' && resumeOrTurnId !== null
          ? resumeOrTurnId.trustedCaller
          : undefined);
      sendWorkerInput(ds, promptInput, gatedTurnId, {
        ...(gatedDispatchAttempt !== undefined
          ? { dispatchAttempt: gatedDispatchAttempt }
          : {}),
        // R6-B3 (transfer-gate sibling): sendWorkerInput reads steer
        // authorization from OPTS, not the payload. A steerable opening/refork
        // rerouted through the transfer gate must carry the flag here too, or it
        // silently downgrades true → false like the direct-route branch did.
        ...(gatedPrompt.codexAppSteerable === true ? { codexAppSteerable: true as const } : {}),
        // At-most-once (codex #818 P1-5): a keyed follow-up fork rerouted through
        // the transfer gate to sendWorkerInput must preserve atMostOnce, else the
        // replacement CLI's input is replayable and a crash after the daemon
        // terminalized the turn re-runs it. forkWorker's own init path sets this
        // from resumeOrTurnId.atMostOnce; the reroute must forward it identically.
        ...(gatedAtMostOnce ? { atMostOnce: true as const } : {}),
        ...(gatedTrustedCaller ? { trustedCaller: gatedTrustedCaller } : {}),
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
  const initTrustedCaller = promptPayload.trustedCaller
    ?? (typeof resumeOrTurnId === 'object' && resumeOrTurnId !== null
      ? resumeOrTurnId.trustedCaller
      : undefined);
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
          ...(initTrustedCaller ? { trustedCaller: initTrustedCaller } : {}),
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
      ...(initTrustedCaller ? { trustedCaller: initTrustedCaller } : {}),
    });
    logger[routed ? 'info' : 'warn'](
      `[${tag(ds)}] ${routed ? 'Routed' : 'Failed to route'} double-fork prompt through existing durable owner`,
    );
    return true;
  }

  const cb = requireCallbacks();
  const bot = getBot(ds.larkAppId);
  const botCfg = bot.config;
  if (
    botCfg.existingAppServer
    && botCfg.cliId === 'codex'
    && ds.session.existingAppServerEndpoint === undefined
  ) {
    throw new Error(
      'this BotMux bot attaches only to an existing Codex App conversation; '
      + 'use /adopt to select the thread before sending task input',
    );
  }
  let existingAppServerEndpoint: string | undefined;
  if (ds.session.existingAppServerEndpoint !== undefined) {
    existingAppServerEndpoint = normalizeExistingAppServerEndpoint(
      ds.session.existingAppServerEndpoint,
      `session ${ds.session.sessionId} existingAppServerEndpoint`,
    );
    if (ds.session.cliId !== 'codex') {
      throw new Error(
        'existing Codex App Server session must use cliId "codex"; '
        + 'refusing to launch another CLI against this thread',
      );
    }
    if (!ds.session.cliSessionId) {
      throw new Error(
        'existing Codex App Server session has no selected thread id; '
        + 'use /adopt to select a Codex App conversation first',
      );
    }
    if (ds.session.sandbox === true || botCfg.readIsolation === true) {
      throw new Error(
        'existing Codex App Server attachment cannot run under sandbox/readIsolation; '
        + 'the external app-server would remain outside that boundary',
      );
    }
    // Remote TUI attach always resumes the explicitly selected remote thread.
    // Never let later cold-resume/restart policy demote it into a new local
    // Codex session.
    resume = true;
  }
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
  let initMsg!: Extract<DaemonToWorker, { type: 'init' }>;
  let agentCfg!: ReturnType<typeof sessionAgentConfig>;
  const t = tag(ds);
  ds.localProcessAttestation = undefined;
  try {
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
  if (!isSharedAdoptSession(ds)) reclaimParkedCrashDiagnostic(ds);

  agentCfg = sessionAgentConfig(ds, botCfg);
  if (!initTurnId && prompt.length > 0 && agentCfg.cliId === 'codex-app') {
    initAttributionTurnId = `codex-app-dispatch-${randomUUID()}`;
  }
  ensureCliEnv(agentCfg.cliId, agentCfg.cliPathOverride);
  let nativeSessionTitle: string | undefined;
  let nativeSessionTitlePrompt: string | undefined;
  if (agentCfg.cliId === 'codex' && !isSharedAdoptSession(ds)) {
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
  // FIRST fence out any keyed turn already terminalized to a durable
  // failed(dispatch_unknown): the turn-level idempotency lease (PR #818) leaves
  // the shared session open, so without this the recovery path would replay an
  // at-most-once turn the caller was already told failed (the ledger is the third
  // replay channel `noReplay` does not reach). Idempotent + re-checked here.
  //
  // FAIL-CLOSED via THROW (codex #818 recovery-seam round-3): if the fence cannot
  // PROVE it is safe to build the recovery snapshot — unreadable/corrupt
  // authoritative async terminal, a terminalized accepted entry that cannot be
  // exact-cancelled, or a retirement persist failure — it THROWS. We deliberately
  // do NOT catch-and-`return false` here: `forkWorker`'s bool return is widely
  // IGNORED by callers (the keyed `/api/trigger` dormant path forks and then
  // unconditionally returns `queued`, so a swallowed false would strand the turn
  // `running`), and a `return false` would also bypass the outer
  // `rollbackWorkerForkPreInit` that restores the queued-activation journal
  // mutated above. Letting it throw routes through forkWorker's existing outer
  // catch (pre-init rollback + rethrow) and then the keyed trigger's post-barrier
  // convergence, which durably terminalizes the turn to `failed` (observable,
  // at-most-once) — the correct contract for every fork-failure path.
  if (agentCfg.cliId === 'codex-app') {
    retireTerminalizedCodexAppLedgerEntriesForRecovery(ds);
  }
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

  // Node: fork `dist/worker.js`. Standalone binary: re-exec THIS binary with the
  // hidden `__worker` subcommand over the same IPC channel (see self-spawn.ts).
  worker = spawnWorker({
    distDir: join(__dirname, '..'),
    cwd,
    execArgv: workerForkExecArgv(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
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
    } as NodeJS.ProcessEnv,
  });
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
      const retainExactRetirementGeneration = ds.remoteShutdownState !== undefined
        || ds.remoteCloseState !== undefined;
      if (!retainExactRetirementGeneration) {
        ds.worker = null;
        ds.workerPort = null;
        ds.workerToken = null;
        ds.workerViewToken = null;
        ds.managedTurnOrigin = undefined;
        ds.remoteCloseState = undefined;
      }
      // The retirement coordinator owns a prepared generation. Keep the exact
      // ChildProcess pointer until exit so it can decide whether abort/commit
      // was durably verified.
      try { worker.kill(); } catch { /* best-effort failed-child fence */ }
    }
    if (startupState.failureNotified) return;
    startupState.failureNotified = true;
    emitSessionLifecycleHook(ds, 'session.requires_attention', {
      reason: 'worker_fork_error',
      message: reason,
    });
    // Plan B: a meeting agent is an ordinary chat-scope session. A fork
    // diagnostic must stay out of the chat only for a genuinely meeting-driven
    // opening — a durable transcript delivery (initDispatchAttempt set) or a
    // stamped meeting @mention follow-up — because that path is fenced to the
    // receipt/lease chain and could otherwise leak on a silent delivery. A plain
    // user turn on this session gets its fork failure surfaced like any session
    // (else the user's own turn fails silently). Silent scheduled turns stay
    // suppressed as before.
    const forkErrorMeetingDriven = !!ds.session.vcMeetingReceiver
      && (initDispatchAttempt !== undefined
        || resolveVcMeetingImTurnOrigin(ds.session, initAttributionTurnId) !== undefined);
    if (forkErrorMeetingDriven || isSilentScheduledTurn(ds, initAttributionTurnId)) {
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
      // A meeting-driven turn (listener_thread delivery) that DOES surface must
      // still attribute to the meeting session so the send policy resolves it.
      forkErrorMeetingDriven
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
  const feedbackPolicy = resolveFeedbackPolicyForDelivery({ dataDir: config.session.dataDir, larkAppId: ds.larkAppId, chatId: ds.chatId, bot: botCfg });
  ds.feedbackPolicy = feedbackPolicy;
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
    launchShell: agentCfg.launchShell,
    model: agentCfg.model,
    reasoningEffort: agentCfg.reasoningEffort,
    // dsh runner turn timeout: read live from bot config so tuning bots.json
    // takes effect on the next worker fork without recreating the session.
    turnTimeoutMs: botCfg.turnTimeoutMs,
    // dsh runtime variant (official runner vs dsh-tui PTY TUI).
    dshRuntime: botCfg.dshRuntime,
    disableCliBypass: botCfg.disableCliBypass === true,
    codexBrowser: botCfg.codexBrowser,
    // Existing App Server attachment owns neither an app-server nor a JSON-RPC
    // input channel. It is a normal official remote TUI, so all user input goes
    // through its terminal and must never trigger BotMux's self-owned RPC engine.
    codexRpcInput: existingAppServerEndpoint
      ? false
      : (botCfg.codexRpcInput === true && RPC_CAPABLE_CLIS.has(agentCfg.cliId)) || config.codexRpcInputDefault,
    ...(existingAppServerEndpoint ? { existingAppServerEndpoint } : {}),
    codexAuthSync: botCfg.codexAuthSync ?? 'shared',
    // Startup commands run on every fresh spawn (incl. resume) so session-only
    // settings like `/effort ultracode` are re-established. Adopt sessions are
    // observed, not driven — forkAdoptWorker intentionally omits this.
    startupCommands: agentCfg.startupCommands,
    // Per-bot env (bots.json `env`) — injected into the CLI process only (e.g.
    // ANTHROPIC_BASE_URL/AUTH_TOKEN for a GLM/3rd-party bot). Adopt sessions are
    // observed, not driven, so forkAdoptWorker intentionally omits it.
    env: ds.session.cliLaunchSnapshot ? undefined : botCfg.env,
    // Freeze the normalized sparse reply style at worker spawn. Both the
    // session-rendered botmux-send guide and the CLI card renderer consume the
    // same env snapshot, so a dashboard edit cannot split their behavior inside
    // an already-running pane.
    replyStyle: botCfg.replyStyle,
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
    // Opt-in only, driven purely by explicit per-bot `readIsolation`. A
    // no-transport session (apiOnly bot OR HTTP virtual chat) is NO LONGER
    // force-isolated: disk read scope now follows the owner's own sandbox config,
    // symmetric with a normal chat session (unset/false → not isolated). Accepted
    // trade-off: a no-transport session with no sandbox config can read the full
    // bots.json / sibling BOT_HOME on disk; protecting sibling creds from lateral
    // read on a multi-bot host now depends on the owner explicitly enabling
    // sandbox/readIsolation, not on this force. Two adjacent boundaries are
    // unchanged and independent: (1) this bot's own transport secret is still
    // withheld from the CLI env (gated on larkTransportEnabled below), so a
    // no-transport session cannot drive Botmux's own send path even though it can
    // read the file; (2) mandatory device-credential isolation (worker.ts) still
    // masks the device authority dir / enrolled creds on enrolled hosts. Full-file
    // sandbox stays independently driven worker-side by sandboxRequested
    // (cfg.sandbox || cfg.readIsolation || BOTMUX_SANDBOX=1); session.sandbox is
    // frozen from botCfg.sandbox at create time, so "follow local sandbox" holds.
    readIsolation: botCfg.readIsolation === true,
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
    // One backendConfig channel shared by the remote backends; the selector
    // picks the shape matching backendType. A mojo bot with no `mojo` block is
    // valid (all fields optional), so an undefined here is not an error.
    //
    // mojo goes through sessionMojoConfig so the control-plane identity frozen at
    // creation survives a cold resume: without it, editing the bot between two
    // messages would silently move a live session from cloud to host execution,
    // or resume it against a different tenant/workspace than the one holding its
    // remote session.
    backendConfig: botCfg.backendType === 'mojo' || agentCfg.cliId === 'mojo'
      ? sessionMojoConfig(ds, botCfg, { freeze: true }).config
      : botCfg.riff,
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
    feedback: feedbackPolicy,
    // Freeze the ACTUAL loaded bots-config path (getLoadedConfigPath) so a
    // no-transport worker's fs-policy denies it from a HOST-owned fact, not a
    // guess off BOTS_CONFIG env (which the agent could see/forge). When it lives
    // outside every botmux authority root, buildFsPolicy fails the spawn closed
    // rather than silently masking an arbitrary parent dir (codex P1). Omitted
    // from forkAdoptWorker below — its observe branch returns before fs-policy.
    loadedBotsConfigPath: getLoadedConfigPath(),
    // PROVENANCE of that path: 'loaded' = the daemon actually parsed this exact
    // file (a real registry authority, safe to pin onto CLI children);
    // 'synthetic' = core-only placeholder that was never parsed. The worker must
    // not guess this from the filesystem — existence and provenance are
    // independent facts (see core/config-dir.ts BotsConfigProvenance).
    loadedBotsConfigProvenance: getLoadedConfigProvenance(),
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
    ...(initTrustedCaller ? { trustedCaller: initTrustedCaller } : {}),
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
  // New generation ledger. NOT a plain reset: the previous generation's keys are
  // parked until its worker is observed to exit, because the double-fork guard
  // kills asynchronously and spawns the replacement synchronously.
  startNewGenerationEnvLedger(ds, initMsg.env);
  // Cold-resume path: a workerless session goes straight here without passing
  // through sendWorkerInput, so without this the "notice on the next message"
  // promise was never kept for exactly the sessions most likely to need it.
  deliverPendingMojoQuarantineNotice(ds, initAttributionTurnId, initDispatchAttempt);

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
  if (prompt.length > 0 && initAttributionTurnId?.startsWith('om_')) {
    recordAdmittedOrdinaryUserTurn(ds, initAttributionTurnId, { beginRecovery: true });
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
  // New generation ledger. NOT a plain reset: the previous generation's keys are
  // parked until its worker is observed to exit, because the double-fork guard
  // kills asynchronously and spawns the replacement synchronously.
  startNewGenerationEnvLedger(ds, initMsg.env);
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

/**
 * Plan B: a VC meeting agent is an ordinary chat-scope session that hosts BOTH
 * meeting transcript deliveries and plain user IM turns. A turn is
 * "meeting-driven" only when it is a durable transcript delivery (dispatchAttempt
 * set) or a stamped meeting @mention follow-up (vcMeetingImTurnOrigin). Only
 * meeting-driven turns are subject to the durable silent/listener_thread output
 * policy and the receipt-fenced auxiliary-UI suppression; a plain user turn on
 * this session is an ordinary turn and must post / notify normally (else the
 * user's own reply is silently swallowed — the "手动@机器人也不回复" bug). Shared
 * across setupWorkerHandlers and deliverFinalOutput so every gate stays aligned.
 */
function isMeetingDrivenTurn(
  ds: DaemonSession,
  turnId?: string,
  dispatchAttempt?: number,
): boolean {
  if (!ds.session.vcMeetingReceiver) return false;
  if (dispatchAttempt !== undefined) return true;
  return resolveVcMeetingImTurnOrigin(ds.session, turnId) !== undefined;
}

function currentGatewayCallerOpenId(ds: DaemonSession, turnId: string): string | undefined {
  // The daemon owns this per-turn sender map. The worker contributes only the
  // turn id over private IPC; it can never choose which human that id denotes.
  return pickTurnReplyTarget(ds.session, turnId)?.senderOpenId;
}

function currentTurnProcessIdentities(
  ds: DaemonSession,
  turnId: string | undefined,
): string[] | undefined {
  return turnId && ds.localProcessAttestation?.cliPid
    ? snapshotProcessIdentities(ds.localProcessAttestation.cliPid)
    : undefined;
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
  // Active runtime is likewise authority of this exact worker generation. The
  // new worker republishes it via active_runtime after re-reading the rollout;
  // clear it here so the window between respawn and that first observation
  // cannot leave a stale model/effort tail on the card.
  ds.activeModel = undefined;
  ds.activeReasoningEffort = undefined;
  ds.pendingActiveRuntimeCardRefresh = undefined;
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
      || activeSessionsRegistry.get(activeSessionKey(ds)) === ds
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
    // Plan B: a VC meeting agent is an ordinary chat-scope session, so the live
    // STREAMING CARD is no longer gated here at all — it surfaces through the
    // normal post/patch path like any group session (that was the "看不到流式
    // 卡片" report; those sites dropped their VC guard). What remains funnelled
    // through managedAuxUiSuppressed is out-of-band auxiliary UI (startup-failure
    // notices, usage-limit patches, exit UI): for a genuinely meeting-driven turn
    // — a durable transcript delivery (dispatchAttempt set) or a stamped meeting
    // @mention follow-up — that diagnostic stays fenced to the receipt/retry
    // chain and must never leak out-of-band (a silent delivery especially). A
    // plain user turn on this session has neither marker and notifies normally.
    // (isMeetingDrivenTurn supersedes the pre-Plan-B per-bot-receiver blanket
    // check that master's auxUiSuppressedFor still uses — keeping this inline is
    // the load-bearing "手动@不回复" fix.)
    if (isMeetingDrivenTurn(ds, turnId, dispatchAttempt)) return true;
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
    // Only a genuinely meeting-driven turn is subject to the durable meeting-send
    // policy; a plain user turn on this session posts through the ordinary path
    // (see isMeetingDrivenTurn).
    if (!isMeetingDrivenTurn(ds, turnId, dispatchAttempt)) {
      return ordinaryManagedSuppression(turnId, dispatchAttempt);
    }
    // Resolve every Lark-facing worker event against durable origin state. The
    // receipt freezes responseMode, so terminal→idle updates and daemon restore
    // cannot become loud merely because an in-memory suppression map was
    // cleared/lost. Missing attribution on a meeting-driven turn fails closed.
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
  ensureOrdinaryTurnRecoveryAttached(ds, botCfg);
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
  /**
   * Daemon-side self-heal for TRANSIENT startup/relaunch failures (see
   * worker-startup-retry.ts; 2026-08-23 tmux restart-storm incident). Returns
   * true when a silent bounded retry was scheduled INSTEAD of a user-visible
   * notify. Scope is deliberately narrow:
   *   - only turn-less failures — a turn-carrying failure has a waiting sender
   *     and (for durable VC/at-most-once turns) its own delivery state machine
   *     that must keep owning retries;
   *   - only reasons the classifier deems transient host/backend pressure;
   *   - bounded by MAX_STARTUP_AUTO_RETRIES per failing streak (reset on a
   *     worker generation reaching `ready`), so a persistent failure still
   *     surfaces to the user with the standard card.
   * The retry itself is a blank re-fork (`forkWorker(ds, '', true)`) — exactly
   * what a daemon restart or the next inbound message would do: re-attach when
   * the backing pane survived (the 08-23 case — pane and CLI were alive, only
   * the worker had died), cold `--resume` otherwise.
   */
  const scheduleTransientStartupRetry = (
    reason: string,
    turnId?: string,
    dispatchAttempt?: number,
  ): boolean => {
    if (turnId !== undefined || dispatchAttempt !== undefined) return false;
    if (startupState.failureNotified) return false;
    if (!isTransientStartupFailure(reason)) return false;
    if (ds.session.status !== 'active') return false;
    const attempts = (ds.startupAutoRetry?.attempts ?? 0) + 1;
    if (attempts > MAX_STARTUP_AUTO_RETRIES) return false;
    // Mark this generation handled so the pre-ready exit guard cannot post a
    // duplicate start_exited_early card behind the scheduled retry.
    startupState.failureNotified = true;
    const delayMs = startupAutoRetryDelayMs(ds.session.sessionId, attempts);
    logger.warn(
      `[${t}] Transient worker startup failure (${reason}); `
      + `auto-retry ${attempts}/${MAX_STARTUP_AUTO_RETRIES} in ${Math.round(delayMs / 1000)}s`,
    );
    const timer = setTimeout(() => {
      if (ds.startupAutoRetry?.timer === timer) ds.startupAutoRetry.timer = undefined;
      // Lifecycle guards: the session may have been closed, replaced in the
      // registry, or revived by an inbound message while the timer slept.
      if (ds.session.status !== 'active') return;
      if (ds.worker && !ds.worker.killed) return;
      if (activeSessionsRegistry && activeSessionsRegistry.get(activeSessionKey(ds)) !== ds) return;
      logger.info(
        `[${t}] Auto-retrying worker start (${attempts}/${MAX_STARTUP_AUTO_RETRIES}) `
        + 'after transient startup failure',
      );
      try {
        forkWorker(ds, '', true);
      } catch (err: any) {
        logger.error(`[${t}] Startup auto-retry fork failed: ${err?.message ?? err}`);
      }
    }, delayMs);
    timer.unref?.();
    // An inbound message can revive the session between two failing
    // generations; if the replacement fails too, the previous generation's
    // still-pending timer must not survive as an orphan (its guards make a
    // double blank re-fork merely wasteful, not harmful — but one streak owns
    // exactly one pending retry).
    if (ds.startupAutoRetry?.timer) clearTimeout(ds.startupAutoRetry.timer);
    ds.startupAutoRetry = { attempts, timer };
    return true;
  };

  // Adopt mode flags — computed once, used in all buildStreamingCard calls.
  // Bridge mode (the v3 default for /adopt) hides the legacy takeover button.
  const isAdopt = isSharedAdoptSession(ds);
  const showTakeover = false;

  worker.on('message', async (msg: WorkerToDaemon) => {
    // Every IPC message is scoped to the child generation that emitted it.
    // A replaced worker can drain queued messages after the new child has been
    // installed; never let those stale events mutate the replacement's cards,
    // tokens, readiness, transcript metadata, or durable turn state.
    if (ds.worker !== worker) {
      // A retiring worker's own COMMIT ACK still settles the ordinary
      // deliveries tracked against THAT worker object: suspend detaches
      // ds.worker and a replacement advances the generation BEFORE the old
      // child's fire-and-forget ACKs drain, so without this the exit
      // settlement would report an already-committed turn as unconfirmed.
      // Only the commit ACK is settlement-grade; a stale receipt proves
      // nothing about execution and must keep the visible-failure timers
      // running. Stale workers gain no other authority.
      if (msg.type === 'turn_input_committed') {
        completeStaleWorkerOrdinaryImDelivery(worker, msg.turnId);
      }
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
        // A generation reached ready: the transient-startup failing streak is
        // over. Clear the budget and any still-pending retry timer (an inbound
        // message may have revived the session while a retry slept).
        if (ds.startupAutoRetry) {
          if (ds.startupAutoRetry.timer) clearTimeout(ds.startupAutoRetry.timer);
          ds.startupAutoRetry = undefined;
        }
        // Restore the daemon-owned display mode BEFORE any card handling: a
        // fresh worker always boots with displayMode='hidden', and every early
        // break below (managed / replyAlreadySent / streamingCardDisabled /
        // CARD_POSTING_SENTINEL) used to skip the re-sync entirely. The
        // sentinel break is not even rare: a headless backend (mojo) reaches
        // prompt-ready synchronously on spawn, so screen_update reliably wins
        // the card-POST race and `ready` breaks at the sentinel — the worker
        // then never starts its screenshot loop while the daemon keeps
        // rendering "waiting for first screenshot" forever. Sending before the
        // card exists is safe: at worst the first screenshot_uploaded is
        // dropped by the streamCardPending gate and the next 10s cycle
        // delivers a fresh frame.
        syncWorkerDisplayMode(ds);
        // A live CLI is up again: the parked-diagnostic recovery is over, so the
        // per-message launch-model refresh (see sendWorkerInput) stops here and
        // ordinary restart/refork paths take over again.
        ds.crashDiagnosticParked = undefined;
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
          const currentStreamCardId = ds.streamCardId;
          if (currentStreamCardId && ownsCurrentStreamingCard(ds, currentStreamCardId)) {
            continuePublishedStreamingCardPinChain(ds, currentStreamCardId);
          }
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
          const restoredSession = ds.session;
          const restoredAppId = ds.larkAppId;
          const restoredAnchor = sessionAnchorId(ds);
          const restoredRegistryKey = sessionKey(restoredAnchor, restoredAppId);
          const ownsRestoredCard = (): boolean =>
            ds.session === restoredSession
            && ds.session.status === 'active'
            && ds.larkAppId === restoredAppId
            && sessionAnchorId(ds) === restoredAnchor
            && !isSessionTransferring(ds)
            && ds.streamCardId === restoredCardId
            && activeSessionsRegistry?.get(restoredRegistryKey) === ds;
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
              silentIdleCardFlag(ds),
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
            const predecessorIds = snapshotStreamingCardPredecessorIds(ds, restoredCardId);
            persistStreamCardState(ds);
            recallFrozenCards(ds);
            logger.info(`[${t}] Reused existing streaming card ${restoredCardId.substring(0, 12)} after worker (re)start`);
            // Auto-restart recovery: if the reused card is a still-`working`
            // turn, re-arm the periodic usage refresh here. The first
            // post-restart screen_update is typically working→working
            // (statusChanged=false) and would break before the arm choke point.
            syncUsageRefreshTimer(ds);
            continuePublishedStreamingCardPinChain(ds, restoredCardId, predecessorIds);
            if (!ownsRestoredCard()) break;
            break;
          } catch (err) {
            if (!ownsLifecycleMutation() || !ownsRestoredCard()) break;
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
        const pendingNewTurn = !!ds.streamCardPending;
        const postingGeneration = ds.streamCardTurnGeneration ?? 0;
        const cardReplyTarget = captureStreamingCardReplyTarget(ds, msg.turnId);
        const statusRevisionAtPost = ds.streamCardStatusRevision ?? 0;
        const postingSession = ds.session;
        const postingAppId = ds.larkAppId;
        const postingAnchor = sessionAnchorId(ds);
        const postingRegistryKey = sessionKey(postingAnchor, postingAppId);
        ds.streamCardId = CARD_POSTING_SENTINEL;
        let ownsFreshReadyPost = (): boolean => false;
        let restoreFreshReadyPrePostIdentityForRetirement = (): boolean => false;
        let stillOwnsFreshReadyPost = (): boolean => false;
        try {
          ds.streamCardNonce = randomBytes(4).toString('hex');
          const postingNonce = ds.streamCardNonce;
          ownsFreshReadyPost = (): boolean =>
            ds.session === postingSession
            && ds.session.status === 'active'
            && ds.larkAppId === postingAppId
            && sessionAnchorId(ds) === postingAnchor
            && !isSessionTransferring(ds)
            && ds.streamCardId === CARD_POSTING_SENTINEL
            && ds.streamCardNonce === postingNonce
            && activeSessionsRegistry?.get(postingRegistryKey) === ds;
          restoreFreshReadyPrePostIdentityForRetirement = (): boolean => {
            if (remoteRetirementAdmissionPhase(ds) === null || !ownsFreshReadyPost()) return false;
            ds.streamCardId = undefined;
            persistStreamCardState(ds);
            return true;
          };
          stillOwnsFreshReadyPost = (): boolean =>
            ownsFreshReadyPost()
            && remoteRetirementAdmissionPhase(ds) === null
            && retainsLarkStreamingCardTransport(ds);
          const initTitle = ds.currentTurnTitle || ds.session.title || sessionCliDisplayName(ds, botCfg);
          // See PATCH-branch comment above re: lastScreenStatus preference.
          // For relay (kill+fork with surviving tmux/CLI), this avoids the
          // jarring "启动中" right after the M1 "已接力" announcement.
          const initStatus = pendingNewTurn
            ? turnStartingCardStatus(ds, effectiveCliId)
            : (ds.usageLimit ? 'limited' : (ds.lastScreenStatus ?? 'starting'));
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
            silentIdleCardFlag(ds),
          );
          const postedCardId = await scopedReply(
            streamCardJson, 'interactive', cardReplyTarget.turnId,
          );
          if (!ownsLifecycleMutation() || !stillOwnsFreshReadyPost()) {
            void deleteMessage(postingAppId, postedCardId).catch(() => { /* best-effort stale-card cleanup */ });
            restoreFreshReadyPrePostIdentityForRetirement();
            break;
          }
          ds.streamCardId = postedCardId;
          ds.streamCardReplyTargetKey = cardReplyTarget.replyTargetKey;
          // This card IS the current turn's live card — clear the new-turn flag
          // so subsequent screen_updates PATCH it (starting → working) instead of
          // POSTing a second card. Without this, a re-fork that happens while
          // streamCardPending is true (new turn + worker had exited) leaves the
          // flag set, the next screen_update takes the new-card POST branch, and
          // this "starting" card is orphaned (never entered frozenCards, so
          // recallFrozenCards can't withdraw it). Mirrors the screen_update POST
          // branch which clears the flag after posting.
          const superseded = (ds.streamCardTurnGeneration ?? 0) !== postingGeneration;
          if (!superseded) {
            ds.streamCardPending = false;
            ds.streamCardPendingTurnId = undefined;
          }
          ds.parkedStreamCardNonce = undefined;
          const predecessorIds = snapshotStreamingCardPredecessorIds(ds, postedCardId);
          persistStreamCardState(ds);
          // New card is live — recall any cards frozen by previous turns.
          // Done after `streamCardId` is committed so we never delete the old
          // card without a successor visible to the user.
          recallFrozenCards(ds);
          flushPendingLocalCliOpenReadinessPatch(ds);
          flushPendingRiffUrlPatch(ds);
          flushPendingActiveRuntimePatch(ds);
          flushPendingCodexServiceTierPatch(ds);
          // Fresh ready POST: if this turn is already `working` (e.g. relay
          // resume where the CLI kept running), arm here — same authorized arm
          // point as the reuse branch, now that streamCardId is the real id.
          syncUsageRefreshTimer(ds);
          if (!superseded) {
            reconcilePostedStartingCard(ds, cardReplyTarget.turnId, statusRevisionAtPost);
          }
          continuePublishedStreamingCardPinChain(ds, postedCardId, predecessorIds);
          if ((ds.streamCardTurnGeneration ?? 0) !== postingGeneration && ds.streamCardPendingTurnId) {
            void postTurnStartingCard(ds, cb.sessionReply, ds.streamCardPendingTurnId);
          }
        } catch (err) {
          if (!ownsLifecycleMutation() || !stillOwnsFreshReadyPost()) {
            restoreFreshReadyPrePostIdentityForRetirement();
            break;
          }
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
              isSharedAdoptSession(ds),
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
                isSharedAdoptSession(ds),
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
            // Passthrough commands (/compact, /model, ...) become REAL mojo turns,
            // so they must carry the same credential snapshot a normal message
            // does — otherwise a cleared or rotated JWT simply did not apply here.
            ...(mojoLivePatchForSession(ds) ?? {}),
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

      case 'active_runtime': {
        if (
          ds.worker !== worker
          || ds.workerGeneration !== workerGeneration
          || ds.session.workerGeneration !== workerGeneration
        ) {
          logger.warn(`[${t}] Ignored active_runtime from stale worker generation`);
          break;
        }
        const model = msg.model?.trim() || undefined;
        const reasoningEffort = msg.reasoningEffort?.trim() || undefined;
        if (
          ds.activeModel === model
          && ds.activeReasoningEffort === reasoningEffort
        ) {
          break;
        }
        ds.activeModel = model;
        ds.activeReasoningEffort = reasoningEffort;
        scheduleActiveRuntimePatch(ds);
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
        // Model/effort now flow through the active_runtime channel (Codex
        // publishes them from every turn_context, same as TRAE), so this
        // handler is scoped to the ⚡ service-tier badge only and must NOT
        // also write activeModel/activeReasoningEffort — doing so would race
        // the active_runtime writer and, since thread_settings_applied is not
        // emitted in many sessions, could clobber the good value with a stale
        // one.
        scheduleCodexServiceTierPatch(ds);
        break;
      }

      case 'thinking_update': {
        // Cosmetic CoT channel — never touches settlement. Same stale-worker
        // guard as screen_update; sessionId echo is validated when present.
        // Renders as a native CoT message (message_cot AG-UI stream); any API
        // failure disables it for the turn (self-catching, logged as [cot]).
        if (!ownsLifecycleMutation()) break;
        if (msg.sessionId && msg.sessionId !== ds.session.sessionId) break;
        // Cache even when the CoT switches are off — `/cot show` uses this to
        // summon the bubble mid-turn with everything accumulated so far.
        ds.lastThinkingUpdate = { entries: msg.entries, turnId: msg.turnId, dispatchAttempt: msg.dispatchAttempt };
        handleCotThinkingUpdate(ds, msg);
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
        ds.lastScreenStatus = resolveUsageAwareScreenStatus(ds, msg.status, msg.usageLimit);
        bumpStreamCardStatusRevision(ds);
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
          // fresh:true —— 这是「状态边沿触发的 refresh 读」，transcript 此刻刚追加完
          // 本轮输出。绕过 resolver 对懒创建 rollout 的 30s miss 负缓存，否则首轮
          // (spawn 时 rollout 还没落盘)徽标要等 30s 后某次边沿才出现。
          const dashboardRow = composeRowFromActive(ds, { fresh: true });
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
                // 任务态随运行态边沿一起推：working→idle 时 todo 往往刚变化，
                // 不带上会让看板「待办」列停在旧值。?? null 让清空也能同步（patch 合并）。
                openTodos: dashboardRow.openTodos ?? null,
              },
            },
          });
          emitSessionStateTransitionHook(ds, prevStatus, ds.lastScreenStatus, {
            source: 'screen_update',
            content: msg.content,
          });
          // Usage ledger: any settle-to-idle/limited edge records the delta.
          // Turn reactions are stricter — only flip ✋→✅ after a real busy
          // period (working/analyzing) that settles to IDLE. A limited settle
          // is a blocked turn, not completion: DONE-ing ✋ on working→limited
          // made users think the task finished while the CLI was stuck (the
          // rate-limit notification below owns that attention instead).
          // Cold-start starting→idle (or the first prompt-ready before the turn
          // has gone working) must NOT DONE a message that is still about to be
          // / just being processed. Grok card-off sessions hit this when the
          // ready-gate settle fired idle ~seconds after GoGoGo while the CLI
          // was still running the prompt.
          if (ds.lastScreenStatus === 'idle' || ds.lastScreenStatus === 'limited') {
            recordUsageForDaemonSession(ds);
            if (ds.lastScreenStatus === 'idle' && (prevStatus === 'working' || prevStatus === 'analyzing')) {
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

        // Proactive rate/usage-limit notification. The streaming-card PATCH
        // (card-on) carries no unread/mention signal, and card-off sessions
        // skip card output entirely — so without a fresh message here the owner
        // never learns the CLI is blocked (the turn just stalls). Fire on the
        // working/other→limited edge, AFTER the managed/silent fence above but
        // BEFORE the card-off early-break below (card-off sessions must still
        // get this ping), once per limit episode: the latch is keyed on
        // usageLimitStateKey and reset by clearUsageLimitState (self-heal /
        // turn end), so the same episode's repeated limited ticks stay quiet
        // while the next episode notifies again.
        //
        // Recovery-window exclusion: usageLimit is in-memory. When the CLI got
        // limited WHILE the daemon was down (common for tmux/adopt restores),
        // restore has no usageLimit to seed lastScreenStatus='limited' from,
        // so the first post-restart limited tick is a false (empty→limited)
        // edge. The in-memory latch also died with the old process, so without
        // this guard the restart-silence contract would be broken by one @owner
        // ping. The owner already got the private recovery DM summary; hold the
        // ping until a real user turn clears suppressRecoveryCard.
        if (
          ds.lastScreenStatus === 'limited'
          && prevStatus !== 'limited'
          && ds.usageLimit
          && !ds.suppressRecoveryCard
          && ds.rateLimitNotifiedKey !== usageLimitStateKey(ds.usageLimit)
        ) {
          ds.rateLimitNotifiedKey = usageLimitStateKey(ds.usageLimit);
          const limit = ds.usageLimit;
          const notifyBody = tr(
            limit.kind === 'usage' ? 'worker.rate_limit_notify.usage' : 'worker.rate_limit_notify.rate',
            { cliName: sessionCliDisplayName(ds, botCfg), retryLabel: limit.retryLabel },
            loc,
          );
          const ownerOpenId = ds.session.ownerOpenId;
          const notifyText = ownerOpenId ? `<at id=${ownerOpenId}></at> ${notifyBody}` : notifyBody;
          scopedReply(notifyText, 'text', msg.turnId).catch((err: any) => {
            logger.debug(`[${t}] Failed to deliver rate-limit notification: ${err?.message ?? err}`);
          });
        }

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
          const postingGeneration = ds.streamCardTurnGeneration ?? 0;
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
            silentIdleCardFlag(ds),
          );
          // Mark POST in-flight so subsequent screen_updates are dropped,
          // not POSTed as duplicate cards.
          ds.streamCardPending = false;
          ds.streamCardId = CARD_POSTING_SENTINEL;
          const postingSession = ds.session;
          const postingAppId = ds.larkAppId;
          const postingAnchor = sessionAnchorId(ds);
          const postingRegistryKey = sessionKey(postingAnchor, postingAppId);
          const postingNonce = ds.streamCardNonce;
          const ownsFreshScreenPost = (): boolean =>
            ds.session === postingSession
            && ds.session.status === 'active'
            && ds.larkAppId === postingAppId
            && sessionAnchorId(ds) === postingAnchor
            && !isSessionTransferring(ds)
            && ds.streamCardId === CARD_POSTING_SENTINEL
            && ds.streamCardNonce === postingNonce
            && activeSessionsRegistry?.get(postingRegistryKey) === ds;
          const restoreFreshScreenPrePostIdentityForRetirement = (): boolean => {
            if (remoteRetirementAdmissionPhase(ds) === null || !ownsFreshScreenPost()) return false;
            ds.streamCardId = undefined;
            persistStreamCardState(ds);
            return true;
          };
          const stillOwnsFreshScreenPost = (): boolean =>
            ownsFreshScreenPost()
            && remoteRetirementAdmissionPhase(ds) === null
            && retainsLarkStreamingCardTransport(ds);
          const cardReplyTarget = captureStreamingCardReplyTarget(ds, msg.turnId);
          scopedReply(cardJson, 'interactive', cardReplyTarget.turnId)
            .then(async msgId => {
              if (!ownsLifecycleMutation() || !stillOwnsFreshScreenPost()) {
                void deleteMessage(postingAppId, msgId).catch(() => { /* best-effort stale-card cleanup */ });
                restoreFreshScreenPrePostIdentityForRetirement();
                return;
              }
              ds.streamCardId = msgId;
              ds.streamCardReplyTargetKey = cardReplyTarget.replyTargetKey;
              const superseded = (ds.streamCardTurnGeneration ?? 0) !== postingGeneration;
              if (!superseded) ds.streamCardPendingTurnId = undefined;
              ds.parkedStreamCardNonce = undefined;
              const predecessorIds = snapshotStreamingCardPredecessorIds(ds, msgId);
              persistStreamCardState(ds);
              // New card live — recall any cards parked by previous turns
              // (user message, bot @mention, adopt-bridge new turn, etc.).
              // This is the main turn-to-turn POST path; without recall here,
              // every long session would leak old streaming cards into the
              // thread.
              recallFrozenCards(ds);
              flushPendingLocalCliOpenReadinessPatch(ds);
              flushPendingRiffUrlPatch(ds);
              flushPendingActiveRuntimePatch(ds);
              flushPendingCodexServiceTierPatch(ds);
              // New-turn POST is the FIRST working screen_update of the turn —
              // the else (same-turn PATCH) branch never runs for it, so arm the
              // periodic usage refresh here (once the real card id exists, not
              // the POSTING sentinel). syncUsageRefreshTimer re-checks state.
              syncUsageRefreshTimer(ds);
              continuePublishedStreamingCardPinChain(ds, msgId, predecessorIds);
              if ((ds.streamCardTurnGeneration ?? 0) !== postingGeneration && ds.streamCardPendingTurnId) {
                void postTurnStartingCard(ds, cb.sessionReply, ds.streamCardPendingTurnId);
              }
            })
            .catch(async err => {
              if (!ownsLifecycleMutation() || !stillOwnsFreshScreenPost()) {
                restoreFreshScreenPrePostIdentityForRetirement();
                return;
              }
              if (err instanceof MessageWithdrawnError) {
                await closeWithdrawnSessionIfLedgerEmpty(ds, 'Root message withdrawn while creating streaming card');
                return;
              }
              logger.debug(`[${t}] Failed to create streaming card: ${err}`);
              ds.streamCardId = undefined;
              clearPendingLocalCliOpenReadinessPatch(ds);
              ds.pendingActiveRuntimeCardRefresh = undefined;
              ds.pendingCodexTierCardRefresh = undefined;
              persistStreamCardState(ds);
              if ((ds.streamCardTurnGeneration ?? 0) !== postingGeneration && ds.streamCardPendingTurnId) {
                void postTurnStartingCard(ds, cb.sessionReply, ds.streamCardPendingTurnId);
              }
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
            silentIdleCardFlag(ds),
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
        const prevStatus = ds.lastScreenStatus;
        updateUsageLimitState(ds, msg.usageLimit);
        ds.lastScreenStatus = resolveUsageAwareScreenStatus(ds, msg.status, msg.usageLimit);
        bumpStreamCardStatusRevision(ds);
        // Same deferred-suspend checkpoint as the screen_update branch, and
        // deferred for the same reason (see runPendingSuspendIfSettled).
        // The predicate is defense-in-depth here: the handler's fence already
        // dropped every message from a replaced worker before the switch, so a
        // stale `idle` cannot reach this case at all. Passing it keeps the
        // deferred callback from acting on a generation that stopped owning the
        // session between enqueue and drain.
        queueMicrotask(() => runPendingSuspendIfSettled(ds, ownsWorkerSession));
        emitSessionStateTransitionHook(ds, prevStatus, ds.lastScreenStatus, {
          source: 'screenshot_uploaded',
          imageKey: msg.imageKey,
          content: ds.lastScreenContent ?? '',
        });
        // screenshot_uploaded never ARMS the usage refresh — screen_update owns
        // the authorized arm. Here we only tear it down: unconditionally on
        // leaving `working`, and on a managed/silent turn (below) that must not
        // keep a group-visible card ticking. Arming here would let a 12s tick
        // re-render the prior visible card with THIS managed/hidden turn's
        // content — the same leak class as substitute-turn card suppression.
        if (ds.lastScreenStatus !== 'working') clearUsageRefreshTimer(ds);
        if (managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) {
          clearUsageRefreshTimer(ds);
          persistStreamCardState(ds);
          break;
        }
        // Store the image key only AFTER the managed gate: now that the ready
        // handler re-syncs display mode on every path, a worker can be
        // uploading during a suppressed managed/silent turn — letting that
        // frame into ds.currentImageKey would paste it onto the next visible
        // card render (the same leak class the comment above names).
        ds.currentImageKey = msg.imageKey;
        persistStreamCardState(ds);
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
          silentIdleCardFlag(ds),
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

        if (msg.codexAppActiveWriter === true && effectiveCliId === 'codex-app') {
          // `thread/resume` was explicitly rejected because another Codex
          // app-server currently owns the persisted thread. This is a safe,
          // expected handoff conflict — never spend restart budget or let the
          // generic second-restart policy drop cliSessionId and create a fresh
          // context. Park the logical Botmux session so its next message
          // retries the SAME thread after the external writer releases it.
          const thread = ds.session.cliSessionId ?? ds.session.sessionId;
          logger.warn(
            `[${t}] Codex App resume blocked by external active writer; preserving `
            + `thread ${thread.substring(0, 12)}`,
          );
          const suspended = suspendWorker(ds, 'codex_app_active_writer');
          if (!suspended) {
            // The runner process already exited and there is no safe live
            // backend suspension path. Retire only this Node worker; never
            // destroy the external app-server that owns the thread.
            retireWorkerProcessOnly(ds, 'codex_app_active_writer');
            ds.hasHistory = true;
            ds.session.suspendedColdResume = true;
            sessionStore.updateSession(ds.session);
          }
          if (!suppressExitUi) {
            const threadLabel = `${thread.substring(0, 16)}…`;
            const message = loc === 'zh'
              ? `⚠️ Codex App 历史会话（${threadLabel}）当前正由另一个 Codex App / app-server 持有。`
                + 'BotMux 已保留原上下文，不会新建空会话；请在 App 侧释放该会话后，再发送一条消息重试恢复。'
              : `⚠️ Codex App thread (${threadLabel}) is currently held by another Codex App / app-server writer. `
                + 'BotMux preserved the original context and did not create a fresh session; release it in the App, then send another message to retry.';
            try {
              await scopedReply(message, 'text', msg.turnId);
            } catch (replyErr) {
              logger.error(`[${t}] Failed to report Codex App active-writer conflict: ${replyErr}`);
            }
          }
          break;
        }

        // Do NOT auto-restart in adopt mode — there's nothing to restart
        if (isSharedAdoptSession(ds)) {
          logger.info(`[${t}] Shared adopted session ended`);
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
              silentIdleCardFlag(ds),
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

        // EVERY remote backend is a lineage-owning backend, not a local CLI
        // process. Stop before crash-loop accounting: for riff the restart IPC
        // is a guaranteed no-op, and for mojo it is WORSE than a no-op — the
        // worker executes it, cancelling the remote session and cold-booting a
        // context-less replacement, so treating a mojo backend exit as a local
        // CLI crash silently destroyed remote context (fourth-round review).
        if (isRemoteBackendSession(ds)) {
          const retirementPhase = remoteRetirementAdmissionPhase(ds);
          logger.warn(
            `[${t}] Remote backend exited; automatic restart is unsupported`
            + (retirementPhase ? ` (${retirementPhase})` : ''),
          );
          // Explicit /close and daemon shutdown already own the user-visible
          // lifecycle. Only an unexpected backend exit needs recovery guidance.
          if (!retirementPhase && !suppressExitUi) {
            try {
              await scopedReply(tr('cmd.restart.remote_unsupported', undefined, loc), 'text', undefined);
            } catch (replyErr) {
              if (replyErr instanceof MessageWithdrawnError) {
                logger.warn(`[${t}] Root message withdrawn, closing stale session`);
                cb.closeSession(ds);
              }
            }
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
              silentIdleCardFlag(ds),
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
            // The worker now holds a parked diagnostic shell and will respawn the
            // CLI itself on the next message (no restart IPC in that path), so the
            // next message must carry the current launch model. Cleared once a
            // worker generation reports ready again.
            ds.crashDiagnosticParked = true;
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
          ds.worker.send({ type: 'restart', reason: 'cli_crash', env: latestPerBotEnvForRestart(ds), model: latestModelForRespawn(ds) } as DaemonToWorker);
        }
        break;
      }

      case 'error': {
        logger.error(`[${t}] Worker error: ${msg.message}`);
        // `error` is a fatal launch-generation signal. It normally arrives
        // during init, but can also follow a previously-ready worker whose CLI
        // recovery/restart fails; that later failure must remain user-visible —
        // UNLESS it is a turn-less transient (post-outage restart storm), where
        // a bounded silent re-fork self-heals without waking anyone (08-23:
        // idle sessions got "会话启动失败" cards while their panes were alive).
        if (scheduleTransientStartupRetry(msg.message, msg.turnId, msg.dispatchAttempt)) break;
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
            const priorTaskId = ds.session.riffParentTaskId;
            ds.session.riffParentTaskId = undefined;
            try {
              sessionStore.updateSession(ds.session);
            } catch (err) {
              ds.session.riffParentTaskId = priorTaskId;
              logger.error(
                `[${t}] Failed to clear Riff lineage: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          break;
        }
        if (ds.session.riffParentTaskId === msg.taskId) break;
        // Persist the follow-up lineage anchor: after a daemon restart the
        // rebuilt RiffBackend resumes from this id (resumeParentTaskId) so the
        // next message continues the riff conversation in the warm sandbox
        // instead of cold-booting a context-less fresh task (4-5 min).
        ds.session.riffParentTaskId = msg.taskId;
        try {
          sessionStore.updateSession(ds.session);
        } catch (err) {
          // Retain the newest runtime lineage. A close_result or later task-id
          // event retries persistence; reverting here would make a follow-up
          // target the stale parent while the worker owns the new child.
          logger.error(
            `[${t}] Failed to persist Riff lineage ${msg.taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }

      case 'close_result': {
        const pending = pendingRemoteWorkerCloses.get(msg.requestId);
        if (!pending
          || pending.worker !== worker
          || pending.sessionId !== ds.session.sessionId
          || ds.worker !== worker) {
          logger.warn(`[${t}] Ignored stale/unmatched remote close result ${msg.requestId}`);
          break;
        }
        pendingRemoteWorkerCloses.delete(msg.requestId);
        pending.resolve({
          ok: msg.ok,
          ...(msg.taskId ? { taskId: msg.taskId } : {}),
          ...(msg.error ? { error: msg.error } : {}),
          ...(msg.recovery ? { recovery: msg.recovery } : {}),
          // Forwarded, never re-derived: the backend may keep writes fenced on a
          // close that is otherwise retryable, and only it knows that.
          ...(msg.admission ? { admission: msg.admission } : {}),
          // Same reason, and this one was the leak: an ok:true close carrying a
          // local residual arrived here, lost the field, and was published as an
          // ordinary closed row while the backend still held the containment
          // handle for a subtree it could not prove gone.
          ...(msg.residual ? { residual: msg.residual } : {}),
        });
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
        // Settle this turn's native CoT message, if one is live. Cosmetic and
        // self-catching — must never delay or fail the terminal path
        // (RUN_FINISHED auto-completes the CoT server-side). Also consumes the
        // one-shot `/cot show` force and drops the mid-turn thinking cache (a
        // post-terminal summon would create a bubble nobody ever finishes).
        finalizeCotMessage(ds, msg.turnId, msg.status);
        ds.cotForced = undefined;
        ds.lastThinkingUpdate = undefined;
        const isClaudeProviderFailure = msg.status !== 'completed'
          && sessionCliId(ds, botCfg) === 'claude-code'
          && (msg.errorCode?.startsWith('provider_') ?? false);
        const recoveryOwnsTerminal = ordinaryTurnRecoveryHandlesTerminal(ds.session, msg);
        let recoveryHandled = false;
        try {
          await cb.onTurnTerminal?.(ds, msg, { workerGeneration });
        } catch (err: any) {
          // The durable receipt remains non-terminal and can be reconciled;
          // never let a projection/store failure crash the worker IPC loop.
          logger.error(`[${t}] Failed to persist turn_terminal for ${msg.turnId.substring(0, 8)}: ${err.message}`);
        }
        try {
          handleOrdinaryTurnRecoveryTerminal(ds.session, msg);
          recoveryHandled = recoveryOwnsTerminal;
        } catch (err) {
          // Recovery projection is durable fail-closed state, but a temporary
          // session-store failure must not escape the worker IPC handler. The
          // prior in-memory/persisted state was restored by the coordinator and
          // can be reconciled on the next terminal or daemon restart.
          logger.error(
            `[${t}] Failed to persist ordinary-turn recovery terminal for `
            + `${msg.turnId.substring(0, 8)}: `
            + `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        let nonLarkFailureHandled = false;
        if (isClaudeProviderFailure && !ds.session.vcMeetingReceiver) {
          const failureCode = msg.errorCode ?? msg.status;
          const waitPromise = ds.pendingWaitPromises?.get(msg.turnId);
          if (waitPromise) {
            nonLarkFailureHandled = true;
            ds.pendingWaitPromises?.delete(msg.turnId);
            const failure = new Error(`Claude turn failed: ${failureCode}`);
            if (waitPromise.reject) waitPromise.reject(failure);
            else waitPromise.resolve(`ERROR: ${failure.message}`);
            logger.info(
              `[${t}] Settled Wait Mode HTTP turn ${msg.turnId.substring(0, 8)} `
              + `failed (${failureCode})`,
            );
          }

          const asyncResult = ds.asyncTriggerResults?.get(msg.turnId);
          const asyncSink = !!asyncResult || ds.chatId.startsWith('http_async_');
          if (asyncSink) {
            nonLarkFailureHandled = true;
            const failedAt = Date.now();
            if (asyncResult?.status === 'completed') {
              // final_output is stronger and may have settled immediately before
              // the ordered terminal IPC. Never replace known output with a
              // later failure boundary, even if its best-effort durable write
              // has not landed yet.
              ds.idempotentAsyncTurns?.delete(msg.turnId);
              logger.info(
                `[${t}] Ignored failed terminal for completed async HTTP turn `
                + msg.turnId.substring(0, 8),
              );
            } else {
              if (asyncResult?.status === 'pending') {
                asyncResult.status = 'failed';
                asyncResult.failedAt = failedAt;
                asyncResult.errorCode = 'trigger_failed';
                asyncResult.terminalErrorCode = failureCode;
              }
              try {
                const outcome = asyncTriggerStore.recordTerminalFailureStrict(
                  ds.session.sessionId,
                  msg.turnId,
                  failedAt,
                  ds.larkAppId,
                  failureCode,
                );
                if (outcome === 'already_completed') {
                  // Durable completed proof is stronger. Drop a stale in-memory
                  // pending/failed projection so trigger-result reads that proof.
                  ds.asyncTriggerResults?.delete(msg.turnId);
                }
              } catch (err) {
                // The live failed projection still terminates current-daemon
                // polling. Keep it when durable persistence is unavailable and
                // report the lost restart guarantee explicitly.
                logger.error(
                  `[${t}] Failed to persist async worker terminal for `
                  + `${msg.turnId.substring(0, 8)}: `
                  + `${err instanceof Error ? err.message : String(err)}`,
                );
              }
              ds.idempotentAsyncTurns?.delete(msg.turnId);
              logger.info(
                `[${t}] Settled async HTTP turn ${msg.turnId.substring(0, 8)} `
                + `failed (${failureCode})`,
              );
            }
          }
        }

        // 失败通知的 Lark 出口。原先只覆盖 claude 的 `provider_*` 终态，导致两个
        // 缺口：
        //  1. 结构化 CLI（codex/pi/…）的 `ambiguous` 终态——CLI 进程挂了、输入没
        //     写进去——**一条消息都不发**（Channel B 的 gate 只放 `failed`），
        //     卡片悄悄回到「等待输入」，与「正常干完」在用户眼里完全同形。
        //  2. claude 的通知是纯文本，没有可操作入口。
        // 现在统一走失败卡。仍然刻意**不**碰已经有可见卡片的路径：`failed` 的
        // 结构化终态由 Channel B 的 final_output 卡承载（还带半截答案），在这里
        // 再发一张就是重复通知。
        const structuredFailedOwnsNotice = !isClaudeProviderFailure && msg.status === 'failed';
        const shouldPostFailureCard = shouldNotifyTurnFailure({
          status: msg.status,
          ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
        })
          && !structuredFailedOwnsNotice
          && !nonLarkFailureHandled
          && !recoveryHandled
          && !managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt);
        if (shouldPostFailureCard) {
          const failureCode = msg.errorCode ?? msg.status;
          // agentAttention / dashboard「需要你」仍用纯文本摘要：那一列渲染的是
          // 文本，不是卡片。
          const warning = tr(
            'worker.claude_terminal_failure_unrecovered',
            { errorCode: failureCode },
            loc,
          );
          ds.agentAttention = { kind: 'blocked', reason: warning, at: Date.now() };
          publishAttentionPatch(ds);
          emitSessionLifecycleHook(ds, 'session.requires_attention', {
            reason: 'claude_terminal_failure_unrecovered',
            errorCode: failureCode,
            turnId: msg.turnId,
          });
          try {
            await scopedReply(
              buildSessionTurnFailedCard(ds, {
                status: msg.status === 'ambiguous' ? 'ambiguous' : 'failed',
                ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
                ...(msg.retryable !== undefined ? { retryable: msg.retryable } : {}),
              }),
              'interactive',
              msg.turnId,
            );
          } catch (err) {
            logger.error(
              `[${t}] Failed to deliver turn failure card: `
              + `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        // Async-HTTP settle-on-terminal (core-only completion bug #70): a turn
        // the worker's bridge gate suppressed as GENUINE SILENCE (the model
        // terminated with a bare nothing-to-send sentinel, no `botmux send`)
        // emits turn_terminal but NO final_output, so the async-trigger result
        // would stay `pending` and the poller would hang `running` until timeout.
        // Settle it here with EMPTY content — nothing-to-send is a legitimate
        // completed-with-empty-output for an HTTP task.
        //
        // POSITIVE EVIDENCE ONLY: we settle solely on the worker's explicit
        // `outputDisposition === 'nothing_to_send'` flag, never on a bare
        // `completed`. A bare completed terminal is NOT proof of silence — the
        // RPC-hydration timeout path (worker.ts hydrateCompletedRpcTurn) emits
        // `completed` with no final_output after fs-lag while the real answer is
        // still materializing; settling that empty would mask a lost reply.
        // Guarded further so it never double-settles a final_output-completed
        // turn (pending-only), never touches a managed VC-meeting receiver, and
        // only affects this bot's own pending async result. Feishu turns have no
        // asyncTriggerResults entry, so their silent-turn behavior is unchanged.
        if (msg.status === 'completed'
          && msg.outputDisposition === 'nothing_to_send'
          && !ds.session.vcMeetingReceiver) {
          const pendingAsync = ds.asyncTriggerResults?.get(msg.turnId);
          if (pendingAsync && pendingAsync.status === 'pending') {
            const completedAt = Date.now();
            pendingAsync.status = 'completed';
            pendingAsync.content = '';
            pendingAsync.completedAt = completedAt;
            try {
              asyncTriggerStore.recordCompleted(ds.session.sessionId, msg.turnId, '', completedAt, ds.larkAppId);
            } catch (err: any) {
              logger.error(`[${t}] Failed to persist async terminal-settle for ${msg.turnId.substring(0, 8)}: ${err.message}`);
            }
            // Cleared like the final_output path so worker-exit convergence does
            // not retro-fail this now-completed turn. Per-triggerId delete so a
            // concurrent sibling keyed turn's convergence entry is untouched.
            ds.idempotentAsyncTurns?.delete(msg.turnId);
            logger.info(`[${t}] Settled async HTTP turn ${msg.turnId.substring(0, 8)} completed (empty output; nothing-to-send)`);
          }
        }
        // Deliberate-silence closure (positive evidence only — the same
        // 'nothing_to_send' contract as the async settle above):
        //   ① mark the session so every idle-card rebuild renders
        //     「已处理 · 判定无需回复」 instead of 「等待输入」 (a user cannot
        //     tell "chose silence" from "hung" on the bare idle label), and
        //     re-patch the live card if it already settled to idle before this
        //     terminal arrived (the common ordering);
        //   ② an explicitly-@'d turn is a dispatched task — its final status
        //     must be reported even when that status is "no reply needed", so
        //     post a small auto receipt into the thread. No @ in the receipt:
        //     it must never re-trigger the bot (or a peer bot) that went quiet.
        if (msg.status === 'completed'
          && msg.outputDisposition === 'nothing_to_send'
          && !ds.session.vcMeetingReceiver) {
          // Consume the origin record ONLY when this attempt could actually post:
          // a suppressed attempt that ate the record would leave a later,
          // un-suppressed attempt (dispatchAttempt above the durable watermark)
          // with no way to know the turn was @'d — the same silent drop the
          // send-failure compensation above exists to prevent.
          const receiptSuppressed = managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt);
          const explicitMention = receiptSuppressed ? false : takeTurnExplicitMention(ds, msg.turnId);
          // Lineage gate on the LABEL only: with type-ahead, a follow-up turn is
          // admitted while the previous one still runs, so this terminal can land
          // after a newer turn already opened. Relabelling the live card then
          // would advertise 「已处理 · 判定无需回复」 over a turn that is still
          // working — and beginNewTurn has already passed, so nothing clears it.
          // Unknown lineage (HTTP/async-only sessions) stays trusted.
          if (!ds.currentTurnId || ds.currentTurnId === msg.turnId) {
            ds.silentIdleTurnId = msg.turnId;
            if (ds.lastScreenStatus === 'idle') scheduleActiveRuntimePatch(ds);
          }
          // The RECEIPT is owed regardless of lineage — a dispatched task must
          // report its final status even if a newer turn has since opened.
          const posted = ds.silentReceiptTurnIds ?? (ds.silentReceiptTurnIds = new Set());
          if (explicitMention && !posted.has(msg.turnId)) {
            // Claim BEFORE sending so a replay racing this await cannot double-post;
            // release on failure so a later replay can still close the loop.
            posted.add(msg.turnId);
            trimOldest(posted, SILENT_RECEIPT_DEDUPE_MAX);
            void scopedReply(
              tr('worker.silent_turn_receipt', undefined, localeForBot(ds.larkAppId)),
              'text',
              msg.turnId,
              { uuid: silentTurnReceiptUuid(ds.session.sessionId, msg.turnId) },
            ).catch(err => {
              // Nothing reached the thread: drop the claim AND restore the
              // (already consumed) origin record, so a dispatchAttempt replay
              // retries instead of losing the closure for good.
              posted.delete(msg.turnId);
              recordTurnExplicitMention(ds, msg.turnId, true);
              logger.warn(`[${t}] Failed to post silent-turn receipt for ${msg.turnId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
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
        // Isolated children use one stable per-session pathname visible through
        // an exact Seatbelt/bwrap read carve-out.
        // Only the daemon handler for the CURRENT ChildProcess generation may
        // replace it. Stale workers can still emit IPC, but the identity guard
        // above drops them before filesystem mutation, so they cannot overwrite
        // a successor capability (or unlink it during teardown).
        if (msg.originChannelId) {
          if (!/^[a-f0-9]{64}$/.test(msg.originChannelId)) {
            ds.managedTurnOrigin = undefined;
            logger.error(`[${t}] Refused managed origin publication with an invalid pane channel`);
            break;
          }
          try {
            const ipcPort = Number(process.env.BOTMUX_DAEMON_IPC_PORT);
            replaceManagedOriginCapabilityFile(
              managedOriginCapabilityPath(
                config.session.dataDir,
                msg.sessionId,
                msg.originChannelId,
              ),
              JSON.stringify({
                sessionId: msg.sessionId,
                channelId: msg.originChannelId,
                capability: msg.capability,
                ...(Number.isSafeInteger(ipcPort) && ipcPort > 0 && ipcPort <= 65_535
                  ? { ipcPort }
                  : {}),
                ...(msg.turnId ? { turnId: msg.turnId } : {}),
                ...(msg.dispatchAttempt !== undefined
                  ? { dispatchAttempt: msg.dispatchAttempt }
                  : {}),
              }),
            );
          } catch (err) {
            ds.managedTurnOrigin = undefined;
            logger.error(`[${t}] Failed to publish daemon-owned managed origin capability: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
        }
        const preexistingProcessIdentities = currentTurnProcessIdentities(ds, msg.turnId);
        ds.managedTurnOrigin = {
          capability: msg.capability,
          ...(msg.originChannelId ? { originChannelId: msg.originChannelId } : {}),
          ...(msg.turnId ? { turnId: msg.turnId } : {}),
          ...(msg.dispatchAttempt !== undefined
            ? { dispatchAttempt: msg.dispatchAttempt }
            : {}),
          ...((msg.turnId && currentGatewayCallerOpenId(ds, msg.turnId))
            ? { callerOpenId: currentGatewayCallerOpenId(ds, msg.turnId) }
            : {}),
          ...(preexistingProcessIdentities
            ? { preexistingProcessIdentities }
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
        if (msg.originChannelId
          && ds.managedTurnOrigin?.originChannelId
          && ds.managedTurnOrigin.originChannelId !== msg.originChannelId) {
          logger.warn(`[${t}] Ignored managed_turn_origin_revoked for a different pane channel`);
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
    const transferRetirement = transferRetiringWorkers.has(worker);
    const lifecycleRetirement = lifecycleRetiringWorkers.get(ds)?.has(worker) === true;
    const preReadyExit = !startupState.ready;
    const suppressDeliveryFailure = transferRetirement
      || lifecycleRetirement
      || worker.killed
      || ds.session.status === 'closed';
    settleOrdinaryImDeliveriesForWorker(worker, {
      suppressAllFailures: suppressDeliveryFailure,
      // The startup failure path owns only the initial cold-start turn. Any
      // concurrent follow-up has its own user-visible delivery contract and
      // must not disappear behind the init turn's single failure notice.
      startupOwnedTurnId: !suppressDeliveryFailure && preReadyExit
        ? startupState.initTurnId
        : undefined,
      // A deliberate retirement suppresses the misleading crash/ambiguity
      // notices, but a tracked turn that never committed still owes the user
      // a terminal outcome: it will never run and nothing redelivers it.
      retiredBeforeCommit: lifecycleRetirement
        && !transferRetirement
        && ds.session.status !== 'closed',
    });
    transferRetiringWorkers.delete(worker);
    clearLifecycleRetirement(ds, worker);
    logger.info(`[${t}] Worker process exited (code: ${code})`);
    // Last-resort startup guard: syntax/import crashes and abrupt exits can
    // happen before the worker sends either ready or a structured error.  Do
    // not leave the originating Lark message unanswered. Intentional close /
    // replacement kills are excluded to avoid noisy false alarms.
    if (
      !transferRetirement
      && !lifecycleRetirement
      && preReadyExit
      && !startupState.failureNotified
      && !worker.killed
      && ds.session.status !== 'closed'
    ) {
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
      // A dead worker can no longer refresh its card/usage view.
      clearUsageRefreshTimer(ds);
      // A worker owns the terminal HTTP listener. Persisting its former port
      // after exit leaves the Dashboard proxy routing `/terminal/<session>` to
      // a dead socket until some later ready event overwrites it. Clear both
      // durable and aggregated state now so a persistent backend can be
      // re-attached on demand instead of returning a stale 502.
      ds.session.webPort = undefined;
      // A queued suspend for THIS generation is now moot — the worker it was
      // about is gone. Leaving it set would suspend the replacement on its
      // first idle (the deferred checkpoint's own "worker gone" branch cannot
      // help: it only runs on a screen update that will never arrive).
      clearPendingSuspendClaim(ds, 'worker exited');
      ds.workerToken = null;
      ds.workerViewToken = null;
      ds.managedTurnOrigin = undefined;
      if (ds.remoteCloseState) {
        ds.remoteCloseState = { ...ds.remoteCloseState, phase: 'uncertain' };
      }
      // Do not clear remoteShutdownState here. Only the shutdown coordinator can
      // release a generation after lineage persistence or admission restore.
      // This worker generation is gone. Invalidate any stuck-warning card it
      // posted so a late click cannot inject keys into a replacement worker.
      invalidateStuckWarning(ds, 'worker_exit');
      invalidateTuiPrompt(ds, 'worker_exit');
      // A crashed/killed worker never sends turn_terminal (the only finalize
      // path) — settle any live CoT thinking bubble as interrupted so it
      // doesn't spin until the next daemon restart. Cosmetic, self-catching.
      abortCotMessage(ds);
      ds.lastThinkingUpdate = undefined;
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
      // P1-13：worker 退出（崩溃、被杀、正常结束）同样是权威换代——它带走整棵 CLI
      // 进程树，包括那一代注册的 dev server。与代次围栏并进同一次落盘。
      const exitedPreviewTarget = takeSessionPreviewTarget(ds.session);
      sessionStore.updateSession(ds.session);
      if (exitedPreviewTarget !== undefined) publishSessionPreviewCleared(ds.session.sessionId);
      dashboardEventBus.publish({
        type: 'session.update',
        body: {
          sessionId: ds.session.sessionId,
          patch: { webPort: null, workerPid: null },
        },
      });
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

/**
 * Shutdown-only view of the in-flight Codex App final-settlement promises. Each
 * entry is a `deliverFinalOutput` awaited inside the IPC message handler that
 * has NOT yet reached its `cb.onTurnTerminal` call; a settlement resolving
 * enqueues the turn terminal. During graceful shutdown, after all worker IPC
 * channels have disconnected (so no NEW settlement can be created), the daemon
 * bounded-waits these to settle BEFORE closing the turn-terminal queue
 * admission — otherwise a settlement that resolves post-close would have its
 * terminal refused and lost. Returns a snapshot array (safe to Promise.all).
 */
export function snapshotCodexAppFinalSettlements(): Promise<boolean>[] {
  return [...codexAppFinalSettlementInFlight.values()];
}

/** Current in-flight Codex App final-settlement count. After all worker IPC has
 *  disconnected the map cannot grow, so a re-read of 0 after awaiting the
 *  snapshot confirms settlement quiescence. */
export function codexAppFinalSettlementCount(): number {
  return codexAppFinalSettlementInFlight.size;
}

function finalOutputDedupeKey(ds: DaemonSession, msg: Extract<WorkerToDaemon, { type: 'final_output' }>): string {
  return `${msg.sessionId ?? ds.session.sessionId}:${msg.lastUuid || msg.turnId}`;
}

/**
 * Stable Lark `uuid` idempotency token for an ordinary bridge final_output
 * delivery. Derived from the same identity as the daemon-side dedupe key, so
 * every retry of the same answer — and any duplicate IPC/re-emit of the same
 * turn — collapses into ONE Lark message (the Feishu `uuid` field is
 * idempotent for 1h and returns the original message_id on repeat).
 *
 * Without it, the daemon's own transient-failure retry
 * (`FINAL_OUTPUT_RETRY_BACKOFF_MS`, up to 3 attempts) is at-least-once: an
 * ambiguous first attempt whose reply the server accepted but whose response
 * the client never saw (network error/timeout) creates a brand-new copy on
 * each retry — the user-visible "the answer repeated 3 times" incident. The
 * VC-managed (`vcp_*`) and Codex App settlement (`ca_*`) paths already carry
 * their own stable provider keys; this closes the same gap for the ordinary
 * thread/chat fallback path.
 */
function bridgeFinalOutputUuid(
  ds: DaemonSession,
  msg: Extract<WorkerToDaemon, { type: 'final_output' }>,
): string {
  const seed = finalOutputDedupeKey(ds, msg);
  return `bf_${createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 46)}`;
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
  // Plan B: a meeting agent is an ordinary chat-scope session. Pending ack
  // reactions only ever exist for a real inbound user message (the ✋ is placed
  // when that message arrives — transcript deliveries have no inbound message to
  // react to), so a non-empty list here always belongs to a plain user turn and
  // must settle to ✅ like any session. No VC special-case.
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
async function persistFinalOutputFeedback(
  ds: DaemonSession,
  msg: Extract<WorkerToDaemon, { type: 'final_output' }>,
  content: string,
  effectiveCliId: string,
  messageId: string,
  policy: import('../services/feedback-policy.js').FeedbackPolicy,
  baseCard: Record<string, unknown>,
  requesterSubjectId: string | undefined,
  webhookDestinations: import('../services/feedback-outbox.js').FeedbackWebhookDestination[] | undefined,
  logTag: string,
): Promise<void> {
  try {
    const { getSkillFeedbackStore } = await import('../services/skill-feedback-store.js');
    const feedbackStore = await getSkillFeedbackStore(config.session.dataDir);
    feedbackStore.recordTurnDelivery({
      botAppId: ds.larkAppId,
      sessionId: ds.session.sessionId,
      turnId: msg.turnId,
      nativeSessionId: msg.sourceHermesSessionId ?? ds.session.cliSessionId,
      platform: 'lark',
      platformAppId: ds.larkAppId,
      platformMessageId: messageId,
      chatId: ds.chatId,
      topicRootId: ds.session.rootMessageId,
      dispatchAttempt: msg.dispatchAttempt,
      content,
      cliId: effectiveCliId,
      cliVersion: ds.cliVersion,
      model: ds.session.model,
      reasoningEffort: ds.session.reasoningEffort,
      cardMode: 'feedback',
      status: 'delivered',
      usage: msg.usage,
      policy,
      baseCard,
      requesterSubjectId,
      webhookDestinations,
      context: { ...(resolveFeedbackTeamId({ dataDir: config.session.dataDir, chatId: ds.chatId }) ? { teamId: resolveFeedbackTeamId({ dataDir: config.session.dataDir, chatId: ds.chatId }) } : {}) },
    });
  } catch (error) {
    logger.warn(
      `[${logTag}] Failed to persist final-output feedback delivery: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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
    // This idempotent async turn produced its terminal output — drop its
    // worker-exit convergence entry so a later graceful exit of this generation
    // is not retro-failed (codex #776 round-6 finding #1). Per-triggerId delete so
    // a concurrent sibling keyed turn on the same shared session is untouched
    // (codex #818 P1-1).
    ds.idempotentAsyncTurns?.delete(msg.turnId);
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
      // Plan B: the meeting agent is an ordinary chat-scope session, so it also
      // delivers plain user turns. Apply the durable meeting-send policy ONLY to
      // a genuinely meeting-driven turn (a durable transcript delivery, or a
      // stamped meeting @mention follow-up). A plain user turn is not
      // meeting-driven → managedDecision stays undefined → it delivers through
      // the ordinary path. Without this gate a plain user reply resolves
      // `origin_unproven` and is silently dropped (the "手动@机器人也不回复" bug).
      const managedDecision = isMeetingDrivenTurn(ds, msg.turnId, msg.dispatchAttempt)
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
        if (!isMeetingDrivenTurn(ds, msg.turnId, msg.dispatchAttempt)) return;
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
      // A listener-chat @mention is a direct human IM turn. Its normal sink is
      // already plain text, but an existing receiver context may have taught
      // the model the automatic delivery's decision envelope. Do not expose
      // that internal protocol to the human; recover its user-visible content
      // when the stale envelope is valid. (The trusted per-turn instruction
      // added by the daemon prevents new turns from producing it.)
      if (imOrigin) {
        const directImControlledOutput = parseVcMeetingListenerOutput(msg.content);
        if (directImControlledOutput.ok) {
          visibleAssistantText = directImControlledOutput.decision === 'publish'
            ? directImControlledOutput.content
            : '本次没有生成可展示的答复，请重新提问。';
          logger.warn(
            `[${t}] VC listener IM reply recovered stale control envelope `
            + `turn=${msg.turnId.substring(0, 8)} decision=${directImControlledOutput.decision}`,
          );
        }
      } else if (!imOrigin
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
      // 失败兜底通知正文 @ 真人。有 footer 收件人（真人 owner / 触发者）时其 <at>
      // 已经会提醒，不重复；仅当没有任何真人收件人时（bot-to-bot 派发的会话）回退
      // @ bot 管理员，让模型网关类故障有人看见而不是静默滑过。
      const failureMentionOpenId = msg.turnFailed === true && !managedReceiver && !recipientOpenId
        ? failureNoticeFallbackMentionOpenId(ds)
        : undefined;
      const deliveredAssistantText = failureMentionOpenId
        ? `<at id=${failureMentionOpenId}></at> ${safeAssistantText}`
        : safeAssistantText;
      const localHomeLinkMode = daemonCardLocalHomeLinkMode(ds);
      // forkWorker snapshots the effective policy for this worker lifetime.
      // Keep daemon fallback delivery aligned with the same frozen policy the
      // worker/Riff environment received; live config applies on the next fork.
      const feedbackPolicy = managedReceiver ? undefined : ds.feedbackPolicy;
      const feedbackRequesterSubjectId = recipientOpenId;
      const feedback = feedbackPolicy && feedbackRequesterSubjectId ? { policy: feedbackPolicy } : undefined;
      cardUsage ??= getDaemonReplyCardUsageSnapshot(ds, effectiveCliId);
      const localTurnTitle = msg.kind === 'local-turn-headless'
        ? tr('card.local_turn_resumed', undefined, localeForBot(ds.larkAppId))
        : isExistingAppServerSharedAdoptPersistedSession(ds.session)
          ? tr('card.codex_app_shared_turn', undefined, localeForBot(ds.larkAppId))
          : tr('card.local_turn', undefined, localeForBot(ds.larkAppId));
      const cardJson = msg.kind === 'local-turn' || msg.kind === 'local-turn-headless'
        ? buildContextualReplyCard({
            title: localTurnTitle,
            userText: msg.kind === 'local-turn' ? safeUserText ?? '' : undefined,
            assistantText: safeAssistantText,
            assistantLabel: storedSessionCliDisplayName(ds),
            recipientOpenId,
            brand: renderBrandTemplate(resolveBrandLabel(ds.larkAppId), ds.workingDir),
            locale: localeForBot(ds.larkAppId),
            workingDir: ds.workingDir,
            localHomeLinkMode,
            usage: cardUsage,
            ...(feedback ? { feedback } : {}),
          })
        : buildCanonicalFinalReplyCard({
            markdown: deliveredAssistantText,
            ...(feedback ? { feedback } : {}),
            recipientOpenId,
            brand: renderBrandTemplate(resolveBrandLabel(ds.larkAppId), ds.workingDir),
            locale: localeForBot(ds.larkAppId),
            workingDir: ds.workingDir,
            localHomeLinkMode,
            usage: cardUsage,
          });
      const baseFeedbackCard = feedback ? JSON.parse(cardJson) as Record<string, unknown> : undefined;

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
        if (feedbackPolicy && baseFeedbackCard) {
          await persistFinalOutputFeedback(ds, msg, safeAssistantText, effectiveCliId, preparedListenerReply.messageId, feedbackPolicy!, baseFeedbackCard, feedbackRequesterSubjectId, getBot(ds.larkAppId).config.feedbackWebhooks?.destinations, t);
        }
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
        : codexAppSettlementReply ?? { uuid: bridgeFinalOutputUuid(ds, msg) };
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
      if (feedbackPolicy && baseFeedbackCard && messageId) {
        await persistFinalOutputFeedback(ds, msg, safeAssistantText, effectiveCliId, messageId, feedbackPolicy!, baseFeedbackCard, feedbackRequesterSubjectId, getBot(ds.larkAppId).config.feedbackWebhooks?.destinations, t);
      }
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
export const __testOnly_retireTerminalizedCodexAppLedgerEntriesForRecovery = retireTerminalizedCodexAppLedgerEntriesForRecovery;

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
  // P1-13：换代边界统一清 previewTarget。fork / refork / 切 CLI / adopt 全部经由这里
  // 预留代次，所以这一处就是「上一代 CLI 起的 dev server 已经失去权威」的唯一判据。
  // 并进同一次 updateSession，代次推进与预览清空要么一起落盘、要么一起回滚——否则
  // 会出现「代次已经是新的、磁盘上还留着上一代端口」的中间态，重启后被当成有效路由。
  const previousPreviewTarget = takeSessionPreviewTarget(ds.session);
  try {
    sessionStore.updateSession(ds.session);
  } catch (error) {
    if (previousDaemonGeneration === undefined) delete ds.workerGeneration;
    else ds.workerGeneration = previousDaemonGeneration;
    if (previousSessionGeneration === undefined) delete ds.session.workerGeneration;
    else ds.session.workerGeneration = previousSessionGeneration;
    // 只在原本有目标时写回：预留失败不该给一个从未注册过预览的会话凭空加上这个键。
    if (previousPreviewTarget !== undefined) ds.session.previewTarget = previousPreviewTarget;
    throw error;
  }
  if (previousPreviewTarget !== undefined) publishSessionPreviewCleared(ds.session.sessionId);
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
  // Node: fork `dist/worker.js`. Standalone binary: re-exec THIS binary with the
  // hidden `__worker` subcommand over the same IPC channel (see self-spawn.ts).
  const worker = spawnWorker({
    distDir: join(__dirname, '..'),
    cwd: adoptCwd,
    execArgv: workerForkExecArgv(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...forkEnv,
      CLAUDECODE: undefined,
      BOTMUX: '1',
      LARK_APP_ID: botCfg.larkAppId,
      // Withhold the real secret from the adopt worker's CLI env for a
      // no-transport session — same rationale as forkWorker above.
      LARK_APP_SECRET: larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly }) ? botCfg.larkAppSecret : '',
    } as NodeJS.ProcessEnv,
  });
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
    turnTimeoutMs: botCfg.turnTimeoutMs,
    dshRuntime: botCfg.dshRuntime,
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
  // New generation ledger. NOT a plain reset: the previous generation's keys are
  // parked until its worker is observed to exit, because the double-fork guard
  // kills asynchronously and spawns the replacement synchronously.
  startNewGenerationEnvLedger(ds, initMsg.env);
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
 * This executable's absolute, symlink-resolved path.
 *
 * `process.execPath` is already absolute and kernel-resolved, so this is normally
 * a no-op; realpath is applied anyway so a comparison against a `/proc` argv[0]
 * cannot be defeated by the daemon having been started through a symlink (a
 * released install commonly sits behind `~/.botmux/bin/botmux`). Falls back to the
 * raw value when the path cannot be resolved — a failed realpath must not turn the
 * reaper into a no-op.
 */
function canonicalExecPath(): string {
  try { return realpathSync(process.execPath); } catch { return process.execPath; }
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
  // How THIS install's workers appear in a command line.
  //
  // Node: `<node> <dist>/worker.js` — the script path identifies the install.
  //
  // ⚠️ Compiled single-file binary: there IS no worker.js on disk. spawnWorker()
  // launches `<binary> __worker` (see src/core/self-spawn.ts), while
  // `join(__dirname,'..','worker.js')` evaluates to `/$bunfs/worker.js` — a
  // process-private virtual path that appears in NO command line. MEASURED: a real
  // compiled worker's cmdline is `<binary> __worker`, so the old predicate matched
  // nothing and orphans were NEVER reaped in the compiled form. That is the failure
  // this function exists to prevent: each orphan leaks ~0.5 GB and they accumulate
  // across restarts (daemon.ts records an 841-orphan / ~65 GB incident).
  //
  // The compiled predicate must keep the SAME conservatism the worker.js path had:
  // it identified this install by an ABSOLUTE path, so another botmux install's
  // orphans could never match. A basename-only check loses that — every released
  // install names its binary `botmux`, so install A would reap install B's
  // orphans (verified: with a same-named binary at a different absolute path, a
  // basename check reaps it).
  //
  // So match on the absolute path when the command line carries one. That is the
  // normal case for OUR workers: spawnWorker launches them via
  // `resolveEntrySpawn` → `process.execPath`, which the kernel has already
  // resolved to an absolute path (MEASURED in /proc/<pid>/cmdline:
  // `/…/botmux-linux-x64 __worker`). Only a RELATIVE argv[0] — a binary started
  // by a bare PATH lookup, which our own spawns never produce — falls back to the
  // basename, where cross-install ambiguity is unavoidable but the process was
  // also not started the way we start ours.
  const standalone = isStandaloneBinary();
  const workerPath = opts.workerPath ?? (standalone ? undefined : join(__dirname, '..', 'worker.js'));
  const selfBinary = standalone ? canonicalExecPath() : '';
  const selfBinaryName = standalone ? basename(selfBinary) : '';

  /** Does this command line belong to a worker of THIS install? */
  const isOurWorker = (cmd: string): boolean => {
    if (workerPath !== undefined) return cmd.includes(workerPath);
    // Compiled form: `<binary> __worker`. The token alone is not enough — a
    // process merely mentioning `__worker` (a grep, another install) must be
    // spared.
    if (!cmd.includes(WORKER_ENTRY_SUBCOMMAND)) return false;
    const argv0 = cmd.split(/\s+/, 1)[0] ?? '';
    // Absolute argv[0] → require the exact executable, so a same-named binary
    // from a different install is not ours.
    if (argv0.startsWith('/')) return argv0 === selfBinary;
    // Relative argv[0] (never produced by our own spawns) → basename is all
    // there is to compare.
    return basename(argv0) === selfBinaryName;
  };

  let reaped = 0;
  for (const p of procs) {
    if (p.ppid !== 1) continue;         // parent still alive → not an orphan
    if (!isOurWorker(p.cmd)) continue;  // not OUR worker
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
      // Existing-App-Server share: the worker and its BotMux-owned remote TUI
      // can be in one process group. Reap only the stale worker PID; killing
      // the group would also terminate `codex --remote`, even though the
      // replacement daemon is expected to reattach that client. The external
      // App Server itself is never ours to signal.
      if (isExistingAppServerSharedAdoptPersistedSession(session)) {
        logger.info(`Killing stale shared-App-Server worker only (pid: ${session.pid}, session: ${session.sessionId})`);
        try { process.kill(session.pid, 'SIGTERM'); } catch { /* already gone */ }
        continue;
      }
      // Ordinary managed sessions own their complete process group.
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
      // The remote TUI deliberately uses cliId=codex even when the Bot's
      // default/new-session runtime remains codex-app. This is a shared-adopt
      // binding, not a stale CLI selection, so keep its bmx-* client alive for
      // the restore path. Explicit /detach remains responsible for cleanup.
      if (isExistingAppServerSharedAdoptPersistedSession(session)) continue;
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
