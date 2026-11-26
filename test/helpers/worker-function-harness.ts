/**
 * Execute ONE real function or named callback of src/worker.ts against an injected
 * module scope, without importing the worker (its module body installs process
 * IPC/signal handlers and starts runtime services).
 *
 * Same technique as test/worker-codex-session-upgrade.test.ts: locate the
 * function declaration in the TypeScript AST, transpile just that declaration,
 * and evaluate it inside `with (scope)`. The scope is a Proxy that claims every
 * identifier, so reads of worker globals come from the caller's object and —
 * unlike a bare `with` — writes to worker globals land back in that object
 * instead of leaking onto globalThis. Names the caller did not provide fall
 * back to globalThis (JSON, Promise, Error, …).
 *
 * The assertions a caller writes are therefore about what the production code
 * DOES. The coupling to source text is limited to the function's name and the
 * worker globals it reads; renaming either fails loudly (missing function /
 * undefined read), never silently green.
 */
import { awaySummaryFocusRefusal } from '../../src/services/away-summary-focus.js';
import { paneReplyDeliveryFromProcessTree } from '../../src/services/pane-reply-delivery.js';
import { createUsageLimitTracker } from '../../src/utils/usage-limit-tracker.js';
import { REPLY_DELIVERY_ENV } from '../../src/services/send-completion-hint.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, watch as fsWatch } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  cliUsageLimitEpisodeKey,
  isAntigravityNativeLimit,
  isTransientRateLimit,
  reconcileUsageLimitState,
  screenshotUsageLimitDedupSuffix,
  usageLimitEvidenceKey,
} from '../../src/utils/cli-usage-limit.js';
import { supportsAntigravityReadyFooterQuota } from '../../src/adapters/cli/antigravity.js';
import { isCodexAppCliId } from '../../src/adapters/cli/types.js';
import { findAttestedAntigravityConversationId, inspectAntigravityConversationIdByPid } from '../../src/services/antigravity-discovery.js';
import { parseAbsorbedHostBinding, parseSettledAbsorbedTurns } from '../../src/core/session-marker.js';
import { readProcessStartIdentity } from '../../src/utils/process-identity.js';
import { AntigravityNativeQuotaLog, currentAntigravityNativeQuota } from '../../src/services/antigravity-native-quota.js';
import { createAntigravityQuotaStateMachine } from '../../src/services/antigravity-quota-state.js';
import {
  antigravityTurnAnsweredInTranscript,
  antigravityTurnFailedWithoutOutput,
  drainAntigravityTranscript,
  findCompletedAntigravityTurnIdsPaired,
} from '../../src/services/antigravity-transcript.js';
import { minimaxCompactQueueSuppressesPromptReady } from '../../src/core/inject-queue-policy.js';
import { clearStatuslineSnapshot } from '../../src/services/statusline-snapshot.js';
import { contractTerminalStatus, executionObserverSupported } from '../../src/services/session-contract.js';
import * as runtimeReservation from '../../src/services/runtime-reservation.js';
import { isRemoteBackendType } from '../../src/core/persistent-backend.js';
import { traexQuestionFlowVisible } from '../../src/utils/traex-question-page.js';
import { antigravityBlockingPageTail } from '../../src/utils/antigravity-blocking-page.js';
import { isNativeReasoningEffort } from '../../src/services/native-reasoning-observation.js';
import { readNativeReasoningFooter } from '../../src/utils/native-reasoning-footer.js';
import { readGrokRuntimeObservation } from '../../src/services/grok-runtime-observer.js';
import { ClaudeEffortObserver } from '../../src/services/claude-effort-observer.js';
import { TerminalEffortChoiceTracker } from '../../src/services/terminal-effort-choice.js';
import { finalBridgeSendMarkerCoversOwnThread, isBridgeNothingToSendFinal, isFinalBridgeSendMarker, stripTrailingBridgeSentinelLine } from '../../src/services/bridge-fallback-gate.js';
import { TurnSendLedger } from '../../src/services/turn-send-ledger.js';
import { isStructuredNoticeProtocolMessage } from '../../src/services/structured-notice-protocol.js';
import { rewindableErrorCode, transcriptTurnFailedWithoutOutput } from '../../src/core/failed-turn-rewind.js';
import { pruneRewindBackupsBeside, registerRewindBackup, rewindBackupDirForSession } from '../../src/core/rewind-backup-retention.js';
import { readTraexCatalogWithRetry } from '../../src/services/traex-model-catalog-retry.js';
import { traexAutoModelPolicyKey } from '../../src/services/traex-auto-model.js';
import { traexStartupInputReady } from '../../src/core/traex-startup-input.js';
import { traexTerminalInputBlocked } from '../../src/services/traex-terminal-session.js';
import {
  TRAEX_FIRST_PROMPT_SLOW_POLL_MS,
  TraexFirstPromptReadinessPoller,
  TraexNativeViewportEvidenceStore,
  TraexNativeViewportRefreshController,
  isTraexWebInputSettled,
  isValidPaneDimensions,
  nextTraexFirstPromptPollDelayMs,
  paneDimensionsEqual,
  stageNativeViewportInTempRendererSync,
} from '../../src/core/traex-first-prompt-readiness.js';
import { DEFAULT_RENDER_COLS, DEFAULT_RENDER_ROWS } from '../../src/utils/render-dimensions.js';
import { WebTerminalInputController, WebTerminalInputWireState } from '../../src/core/web-terminal-input-controller.js';
import {
  BackgroundTurnAuthorityHold,
  LegacyAgentAckPairer,
  applyClaudeTranscriptEventToAuthorityHold,
  isDeferrableAuthorityReleaseReason,
} from '../../src/core/background-turn-authority.js';
import { backgroundTaskSettledIds, eventTimeMs, isClaudeTurnDurationEvent } from '../../src/services/claude-transcript.js';
import { BusyReadyDeferralTracker, BusyReadyLogThrottle } from '../../src/utils/busy-ready-deferral.js';
import { ClaudePermissionNoticeTracker } from '../../src/services/claude-action-prompt.js';
import {
  inspectAntigravityAccounts,
  reconcileActiveAntigravityToken,
  resolveAntigravitySpawnStoreOptions,
} from '../../src/services/antigravity-accounts.js';
import {
  normalizeBackgroundTranscriptPath,
  normalizeBackgroundTranscriptSegments,
  readBackgroundTranscriptChain,
  writeBackgroundTranscriptChain,
} from '../../src/services/background-transcript-chain.js';
import {
  claudeNativeSessionIdFromJsonlPath,
  matchesQueuedActivationTurn,
  proofFromSubmitRecheckResult,
  recheckResultFromProof,
} from '../../src/services/queued-activation-receipts.js';
import {
  isAuthoritativeClaudeTranscriptTurn,
  isAuthoritativeStructuredTranscriptTurn,
  isAuthoritativeSubmitSendMarker,
} from '../../src/services/submit-confirmation.js';
import { sanitizeClaudeInput } from '../../src/adapters/cli/claude-code.js';

/** Failed-turn rewind wiring that emitTurnTerminal, flushPending and
 *  handleTermAction call into (see src/worker.ts startFailedTurnRewind):
 *  loaded as the real functions, so a fixture with no rewind in flight keeps
 *  its old behaviour. */
const FAILED_TURN_REWIND_FUNCTIONS = [
  'turnFailedWithoutOutput', 'failedTurnRewindWriteEdge', 'stopHeldFailedTurnRewind',
  'waitForRetiringCliQuiescence', 'putBackFailedTurnCut', 'dropStoppedRewindMessage',
  'putBackStoppedRewindCutBeforeWrites', 'restartToPutBackCut', 'settleFailedTurnRewindOffQueue',
  'handOverFailedTurnRewind', 'failedTurnTranscriptScope',
];

/** TraeX question-page wiring the hold / idle paths call into (see
 *  src/worker.ts "TraeX native question page"): loaded as the real functions,
 *  so a fixture without a question page keeps its old behaviour. */
const TRAEX_QUESTION_FUNCTIONS = [
  'traexQuestionBridgeActive', 'traexQuestionBlockReported', 'traexQuestionHoldBlocks',
  'traexQuestionHoldsHeldInput', 'notifyTraexQuestionInputHeld', 'traexQuestionHoldsIdle',
  'traexQuestionHoldsQueuedWrite', 'traexQuestionCapture',
  'traexQuestionSubmitGuard',
];
/** Inert stand-in for the worker's TraexQuestionBridge instance (a const, not
 *  a function); a caller that observes it passes its own in `scope`. */
const INERT_TRAEX_QUESTION_BRIDGE = { kick() {}, reset() {}, hasOpenCard: () => false, dispose() {} };
const INERT_BACKGROUND_TASK_TRACKER = {
  backgroundWait: () => 0,
  hasPendingNonPersistentMonitor: () => false,
  pending: () => 0,
  pendingTurnAgents: () => 0,
  liveTaskIds: () => [] as string[],
  liveTasksSnapshot: () => [],
  liveSinceMsValue: () => 0,
  noteMainTurn() {},
  observe() {},
  launch() {},
  settle() {},
  reset() {},
};
const INERT_BACKGROUND_AUTHORITY_HOLD = {
  phase: () => 'IDLE' as const,
  owner: () => undefined,
  liveFloorMs: () => 0,
  holds: () => false,
  isBackgroundHeld: () => false,
  isIdleWaiting: () => false,
  isWakeActive: () => false,
  hasOwnedWork: () => false,
  nextDeadlineMs: () => undefined,
  noteDurationMarkerObserved() {},
  resetDurationMarkerObserved() {},
  isDurationMarkerObserved: () => false,
  isForegroundProvisionalEndObserved: () => false,
  seedPreexistingLiveTasks() {},
  recordHistoricalSettlement() {},
  onForegroundTurnStarted: () => ({ action: 'none' as const }),
  onTaskLaunched: () => ({ action: 'none' as const }),
  onTaskSettled: () => ({ action: 'none' as const }),
  onPendingWakeRemoved: () => ({ action: 'none' as const }),
  onWakeDelivered: () => ({ action: 'none' as const }),
  onForegroundProvisionalEnd() {},
  onForegroundTurnEnded: () => ({ action: 'none' as const }),
  onForegroundTurnTerminal: () => false,
  onWakeTurnProvisionalEnd: () => ({ action: 'none' as const }),
  onWakeTurnActivity() {},
  onWakeTurnEnded: () => ({ action: 'none' as const }),
  onSuperseded: () => ({ action: 'none' as const }),
  onPromptReady: () => ({ action: 'none' as const }),
  onTick: () => ({ action: 'none' as const }),
  clearIfOwner() {},
  reset() {},
};
const INERT_LEGACY_AGENT_ACK_PAIRER = { observe: () => [] as Array<{ taskId: string; kind: 'agent' }>, reset() {} };
/** The worker's away-summary focus controller, doing nothing unless a test supplies its own. */
const INERT_AWAY_SUMMARY_FOCUS = { request() {}, noteSuggestion() {}, beforeDaemonMessage() {}, noteRecap() {}, noteCliTurnStarted() {}, restore() {}, reset() {}, isBlurred: false, isActive: false };

let parsed: ts.SourceFile | undefined;

function workerSourceFile(): ts.SourceFile {
  parsed ??= ts.createSourceFile(
    'worker.ts',
    readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return parsed;
}

function transpiledWorkerFunction(name: string): string {
  const source = workerSourceFile();
  let declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  // Some lifecycle callbacks capture their spawn-local ownership boundary.
  // Execute the real callback with that boundary injected just like globals,
  // without importing the worker or modelling its timeout decision.
  if (!declaration) {
    const visit = (node: ts.Node): void => {
      if (declaration) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
        && node.initializer && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body)) {
        const arrow = node.initializer;
        declaration = ts.factory.createFunctionDeclaration(
          arrow.modifiers, undefined, name, arrow.typeParameters, arrow.parameters, arrow.type, node.initializer.body,
        );
      } else ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (!declaration) throw new Error(`Missing worker function or callback: ${name}`);
  // Rewrite before transpilation's module classification: an import.meta in
  // an otherwise standalone function would inject module-only boilerplate.
  const transformed = ts.transform(declaration, [context => node => {
    const visit: ts.Visitor = child => {
      if (ts.isPropertyAccessExpression(child) && ts.isMetaProperty(child.expression)
        && child.expression.keywordToken === ts.SyntaxKind.ImportKeyword && child.name.text === 'url') {
        return context.factory.createStringLiteral(pathToFileURL(join(process.cwd(), 'src/worker.ts')).href);
      }
      return ts.visitEachChild(child, visit, context);
    };
    return ts.visitNode(node, visit) as ts.FunctionDeclaration;
  }]);
  const code = ts.createPrinter().printNode(ts.EmitHint.Unspecified, transformed.transformed[0]!, source);
  transformed.dispose();
  return ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

/**
 * Lazy in-scope defaults for worker module-level state that extracted
 * functions/cases reference via `with (scope)`. A harness that does not stub
 * these would otherwise resolve them to undefined and throw (e.g. iterating an
 * undefined Map). Explicitly supplied scope values always win. Returns
 * `undefined` for keys this does not own so callers keep their own fallbacks.
 */
function defaultScopedWorkerState(scope: Record<string, unknown>, key: string | symbol): unknown {
  if (key === 'inFlightKeepaliveFingerprints') {
    return (scope.inFlightKeepaliveFingerprints ??= new Map<string, number>());
  }
  if (key === 'KEEPALIVE_HOOK_CLAIM_MS') {
    return (scope.KEEPALIVE_HOOK_CLAIM_MS ??= 30_000);
  }
  if (key === 'publishedActiveRuntimeSeeded') {
    return (scope.publishedActiveRuntimeSeeded ??= false);
  }
  if (key === 'cliRestartEpoch') return (scope.cliRestartEpoch ??= 0);
  if (key === 'deferredSessionReady') return (scope.deferredSessionReady ??= []);
  if (key === 'settledAbsorbedTurnsByKey') return (scope.settledAbsorbedTurnsByKey ??= new Map());
  if (key === 'pendingAbsorbedReplyDeliveries') return (scope.pendingAbsorbedReplyDeliveries ??= new Map());
  if (key === 'deferredAbsorbedReplyFinals') return (scope.deferredAbsorbedReplyFinals ??= new Map());
  if (key === 'traexFirstPromptReadinessPoller') {
    return (scope.traexFirstPromptReadinessPoller ??= new TraexFirstPromptReadinessPoller());
  }
  if (key === 'traexNativeViewportEvidence') {
    return (scope.traexNativeViewportEvidence ??= new TraexNativeViewportEvidenceStore());
  }
  if (key === 'traexNativeViewportRefresh') {
    return (scope.traexNativeViewportRefresh ??= new TraexNativeViewportRefreshController());
  }
  if (key === 'observedPaneGridRevision') return (scope.observedPaneGridRevision ??= 0);
  if (key === 'traexControlWriteRevision') return (scope.traexControlWriteRevision ??= 0);
  if (key === 'deferredTerminalTurnStarts') return (scope.deferredTerminalTurnStarts ??= new WeakSet());
  if (key === 'sentTerminalTurnStarts') return (scope.sentTerminalTurnStarts ??= new WeakSet());
  if (key === 'backgroundCotHold') return (scope.backgroundCotHold ??= false);
  if (key === 'daemonCotHoldMayBeActive') return (scope.daemonCotHoldMayBeActive ??= false);
  if (key === 'backgroundTasksTrackedForSiblings') return (scope.backgroundTasksTrackedForSiblings ??= false);
  if (key === 'foldBackgroundUpdatesLive') return scope.foldBackgroundUpdatesLive;
  if (key === 'webTerminalInputGeneration') return (scope.webTerminalInputGeneration ??= 0);
  if (key === 'webTerminalSubmitGeneration') return (scope.webTerminalSubmitGeneration ??= 0);
  if (key === 'rawInputWriteGeneration') return (scope.rawInputWriteGeneration ??= 0);
  if (key === 'lastWrittenCliInputWebSubmitGen') return (scope.lastWrittenCliInputWebSubmitGen ??= 0);
  if (key === 'lastWrittenCliInputRawGen') return (scope.lastWrittenCliInputRawGen ??= 0);
  if (key === 'lastWrittenCliInputSpawnGen') {
    return (scope.lastWrittenCliInputSpawnGen ??= (typeof scope.cliSpawnGeneration === 'number' ? scope.cliSpawnGeneration : 0));
  }
  if (key === 'lastWrittenAntigravityTranscriptAnchor') return scope.lastWrittenAntigravityTranscriptAnchor;
  if (key === 'localAttestedCliProcess') return scope.localAttestedCliProcess;
  if (key === 'lastUsageLimitCaptureTurn') return scope.lastUsageLimitCaptureTurn;
  if (key === 'activeTransientRateLimit') return scope.activeTransientRateLimit;
  // noteWebTerminalInput / flushPending begin a fresh usage-limit turn on every
  // submitted input; scopes that do not model limit detection still need a real
  // tracker so the extracted functions never dereference undefined. Explicit
  // scope-supplied trackers (e.g. the Antigravity screen producer) win.
  if (key === 'usageLimitTracker') {
    return (scope.usageLimitTracker ??= createUsageLimitTracker({
      isRateKindSuppressed: () => false,
      isOutputActive: () => false,
    }));
  }
  // Mirrors the worker's non-authoritative-backend branch: empty snapshot string.
  if (key === 'currentUsageLimitSnapshot') return () => '';
  // Real CLI-family predicate for extracted IPC cases; explicit scope stubs win.
  if (key === 'isCodexAppCliId') return (scope.isCodexAppCliId as ((id: string | null | undefined) => boolean) | undefined) ?? isCodexAppCliId;
  if (key === 'antigravityNativeQuotaLog') return scope.antigravityNativeQuotaLog;
  if (key === 'antigravityFoldedReconcilePending') return scope.antigravityFoldedReconcilePending;
  if (key === 'ANTIGRAVITY_FOLDED_RECONCILE_INITIAL_DELAY_MS') return 50;
  if (key === 'ANTIGRAVITY_FOLDED_RECONCILE_MAX_DELAY_MS') return 1_000;
  if (key === 'ANTIGRAVITY_FOLDED_RECONCILE_MAX_ATTEMPTS') return 20;
  if (key === 'ANTIGRAVITY_FOLDED_RECONCILE_MAX_WATCH_WAKEUPS') return 50;
  if (key === 'ANTIGRAVITY_FOLDED_RECONCILE_MAX_WINDOW_MS') return 15_000;
  if (key === 'antigravityQuotaState') {
    if (!scope.antigravityQuotaState) {
      const state = createAntigravityQuotaStateMachine();
      if (scope.antigravityQuotaHistory !== undefined
        || scope.antigravityActiveQuota !== undefined
        || scope.antigravityQuotaCursor !== undefined) {
        state.restore({
          history: scope.antigravityQuotaHistory as any,
          activeQuota: scope.antigravityActiveQuota as any,
          cursor: scope.antigravityQuotaCursor as any,
        });
      }
      const tracker = scope.usageLimitTracker as { addTurnListener?: (fn: (ev: any) => void) => () => void } | undefined;
      tracker?.addTurnListener?.(ev => {
        if (ev.kind === 'beginTurn') {
          scope.activeTransientRateLimit = undefined;
          const adapter = scope.cliAdapter as { id?: string; runnerFramedInput?: boolean } | undefined;
          if (!adapter || (adapter.id === 'antigravity' && !adapter.runnerFramedInput)) {
            state.beginTurn(ev.snapshot);
          }
        } else if (ev.kind === 'answered') {
          const adapter = scope.cliAdapter as { id?: string; runnerFramedInput?: boolean } | undefined;
          if (!adapter || (adapter.id === 'antigravity' && !adapter.runnerFramedInput)) {
            const readQuota = scope.readAntigravityNativeQuota as (() => any) | undefined;
            state.noteTurnAnswered(readQuota?.());
          }
        }
      });
      scope.antigravityQuotaState = state;
    }
    return scope.antigravityQuotaState;
  }
  if (key === 'backgroundAuthorityHold') return INERT_BACKGROUND_AUTHORITY_HOLD;
  if (key === 'legacyAgentAckPairer') return INERT_LEGACY_AGENT_ACK_PAIRER;
  if (key === 'backgroundHoldTimer') return (scope.backgroundHoldTimer ??= null);
  if (key === 'isDeferrableAuthorityReleaseReason') return isDeferrableAuthorityReleaseReason;
  if (key === 'applyClaudeTranscriptEventToAuthorityHold') return applyClaudeTranscriptEventToAuthorityHold;
  if (key === 'BackgroundTurnAuthorityHold') return BackgroundTurnAuthorityHold;
  if (key === 'LegacyAgentAckPairer') return LegacyAgentAckPairer;
  if (key === 'backgroundTaskSettledIds') return backgroundTaskSettledIds;
  if (key === 'eventTimeMs') return eventTimeMs;
  if (key === 'isClaudeTurnDurationEvent') return isClaudeTurnDurationEvent;
  if (key === 'applyBackgroundAuthorityTransition') return () => {};
  if (key === 'supersedeBackgroundAuthorityHold') return () => {};
  if (key === 'scheduleBackgroundHoldTimer') return () => {};
  if (key === 'clearBackgroundHoldTimer') return () => {};
  return undefined;
}

export function loadWorkerFunction<T extends (...args: any[]) => any>(
  name: string,
  scope: Record<string, unknown>,
): T {
  // Resolve newly split worker dependencies through their real implementations.
  // An unscoped fixture exercises legacy IPC; a supplied v2 scope still runs
  // the production metadata and callback fences.
  const dependencies = new Map<string, unknown>();
  const resolve = (key: string | symbol): unknown => {
    if (key in scope) return scope[key as string];
    if (key === 'ClaudePermissionNoticeTracker') return ClaudePermissionNoticeTracker;
    if (key === 'captureClaudePermissionNoticeScreen') {
      if (!dependencies.has(key)) dependencies.set(key, loadWorkerFunction(key, scope));
      return dependencies.get(key);
    }
    if (key === 'WebTerminalInputController') return WebTerminalInputController;
    if (key === 'WebTerminalInputWireState') return WebTerminalInputWireState;
    if (key === 'webTerminalInputControllers' || key === 'webTerminalAttachInputs') {
      if (!dependencies.has(key)) dependencies.set(key, new Set());
      return dependencies.get(key);
    }
    if (key === 'pendingWebTerminalInput' || key === 'webTerminalInputWireDirty'
      || key === 'webTerminalInputWireState' || key === 'markWebTerminalInputWireUncertain') {
      if (!dependencies.has(key)) dependencies.set(key, loadWorkerFunction(key, scope));
      return dependencies.get(key);
    }
    if (key === 'randomUUID') return randomUUID;
    if (key === 'join') return join;
    if (key === 'readBackgroundTranscriptChain') return readBackgroundTranscriptChain;
    if (key === 'writeBackgroundTranscriptChain') return writeBackgroundTranscriptChain;
    if (key === 'normalizeBackgroundTranscriptPath') return normalizeBackgroundTranscriptPath;
    if (key === 'normalizeBackgroundTranscriptSegments') return normalizeBackgroundTranscriptSegments;
    if (key === 'clearStatuslineSnapshot') return clearStatuslineSnapshot;
    if (key === 'confirmedTerminalEffortChoice') return () => undefined;
    if (key === 'noteTerminalEffortInput') return () => {};
    // Most extracted input-path fixtures never model a persistent respawn;
    // keep the new reattach reconciliation inert unless a test loads it as
    // the function under test with its own explicit backend/generation scope.
    if (key === 'recoverSessionRenameAfterPersistentReattach') return () => false;
    if (key === 'recordStructuredInput') return () => {};
    if (key === 'updateSessionTurnNativeAnchor') return () => {};
    if (key === 'claudeEffortObserver') {
      if (!dependencies.has(key)) dependencies.set(key, new ClaudeEffortObserver());
      return dependencies.get(key);
    }
    if (key === 'terminalEffortTracker') {
      if (!dependencies.has(key)) dependencies.set(key, new TerminalEffortChoiceTracker());
      return dependencies.get(key);
    }
    if (key === 'minimaxCompactQueueSuppressesPromptReady') return minimaxCompactQueueSuppressesPromptReady;
    if (key === 'config') return { terminalEffortWriteback: false };
    if (key === 'contractTerminalStatus') return contractTerminalStatus;
    if (key === 'executionObserverSupported') return executionObserverSupported;
    if (key === 'isNativeReasoningEffort') return isNativeReasoningEffort;
    if (key === 'readNativeReasoningFooter') return readNativeReasoningFooter;
    if (key === 'readGrokRuntimeObservation') return readGrokRuntimeObservation;
    if (typeof key === 'string' && Object.hasOwn(runtimeReservation, key)) return (runtimeReservation as Record<string, unknown>)[key];
    if (key === 'isRemoteBackendType') return isRemoteBackendType;
    if (key === 'promptReadinessRevision') return scope.promptReadinessRevision ??= 0;
    if (key === 'traexCatalogEmptyNoticeTurns') return scope.traexCatalogEmptyNoticeTurns ??= new WeakMap();
    if (key === 'busyReadyDeferral') return scope.busyReadyDeferral ??= new BusyReadyDeferralTracker();
    if (key === 'busyReadyLogThrottle') return scope.busyReadyLogThrottle ??= new BusyReadyLogThrottle();
    // Module-level keep-alive provenance state shared with the message-handler
    // proxy; explicit scope stubs still take precedence.
    const keepaliveDefault = defaultScopedWorkerState(scope, key);
    if (keepaliveDefault !== undefined) return keepaliveDefault;
    if (key === 'stripTrailingBridgeSentinelLine') return stripTrailingBridgeSentinelLine;
    if (key === 'isFinalBridgeSendMarker') return isFinalBridgeSendMarker;
    if (key === 'finalBridgeSendMarkerCoversOwnThread') return finalBridgeSendMarkerCoversOwnThread;
    if (key === 'isStructuredNoticeProtocolMessage') return isStructuredNoticeProtocolMessage;
    if (key === 'paneReplyDeliveryFromProcessTree') return paneReplyDeliveryFromProcessTree;
    if (key === 'REPLY_DELIVERY_ENV') return REPLY_DELIVERY_ENV;
    if (key === 'rewindableErrorCode') return rewindableErrorCode;
    if (key === 'transcriptTurnFailedWithoutOutput') return transcriptTurnFailedWithoutOutput;
    if (key === 'pruneRewindBackupsBeside') return pruneRewindBackupsBeside;
    if (key === 'rewindBackupDirForSession') return rewindBackupDirForSession;
    if (key === 'registerRewindBackup') return registerRewindBackup;
    if (key === 'readTraexCatalogWithRetry') return readTraexCatalogWithRetry;
    if (key === 'traexAutoModelPolicyKey') return traexAutoModelPolicyKey;
    if (key === 'reconcileTraexModelCatalog') {
      if (!dependencies.has(key)) dependencies.set(key, loadWorkerFunction(key, scope));
      return dependencies.get(key);
    }
    if (key === 'currentTraexLoadSnapshot') {
      if (!dependencies.has(key)) dependencies.set(key, loadWorkerFunction(key, scope));
      return dependencies.get(key);
    }
    if (key === 'traexQuestionFlowVisible') return traexQuestionFlowVisible;
    if (key === 'antigravityBlockingPageTail') return antigravityBlockingPageTail;
    if (key === 'traexStartupInputReady') return traexStartupInputReady;
    if (key === 'traexTerminalInputBlocked') return traexTerminalInputBlocked;
    if (key === 'TRAEX_FIRST_PROMPT_SLOW_POLL_MS') return TRAEX_FIRST_PROMPT_SLOW_POLL_MS;
    if (key === 'isTraexWebInputSettled') return isTraexWebInputSettled;
    if (key === 'isValidPaneDimensions') return isValidPaneDimensions;
    if (key === 'nextTraexFirstPromptPollDelayMs') return nextTraexFirstPromptPollDelayMs;
    if (key === 'paneDimensionsEqual') return paneDimensionsEqual;
    if (key === 'stageNativeViewportInTempRendererSync') return stageNativeViewportInTempRendererSync;
    if (key === 'DEFAULT_RENDER_COLS') return DEFAULT_RENDER_COLS;
    if (key === 'DEFAULT_RENDER_ROWS') return DEFAULT_RENDER_ROWS;
    if (key === 'reconcileActiveAntigravityToken') return reconcileActiveAntigravityToken;
    if (key === 'inspectAntigravityAccounts') return inspectAntigravityAccounts;
    if (key === 'resolveAntigravitySpawnStoreOptions') return resolveAntigravitySpawnStoreOptions;
    if (key === 'drainAntigravityTranscript') return drainAntigravityTranscript;
    if (key === 'findCompletedAntigravityTurnIdsPaired') return findCompletedAntigravityTurnIdsPaired;
    if (key === 'antigravityTurnFailedWithoutOutput') return antigravityTurnFailedWithoutOutput;
    if (key === 'antigravityTurnAnsweredInTranscript') return antigravityTurnAnsweredInTranscript;
    if (key === 'inspectAntigravityConversationIdByPid') return inspectAntigravityConversationIdByPid;
    if (key === 'findAttestedAntigravityConversationId') return findAttestedAntigravityConversationId;
    if (key === 'readProcessStartIdentity') return readProcessStartIdentity;
    if (key === 'parseAbsorbedHostBinding') return parseAbsorbedHostBinding;
    if (key === 'parseSettledAbsorbedTurns') return parseSettledAbsorbedTurns;
    if (key === 'AntigravityNativeQuotaLog') return AntigravityNativeQuotaLog;
    if (key === 'currentAntigravityNativeQuota') return currentAntigravityNativeQuota;
    if (key === 'supportsAntigravityReadyFooterQuota') return supportsAntigravityReadyFooterQuota;
    if (key === 'isAntigravityNativeLimit') return isAntigravityNativeLimit;
    if (key === 'isTransientRateLimit') return isTransientRateLimit;
    if (key === 'reconcileUsageLimitState') return reconcileUsageLimitState;
    if (key === 'cliUsageLimitEpisodeKey') return cliUsageLimitEpisodeKey;
    if (key === 'usageLimitEvidenceKey') return usageLimitEvidenceKey;
    if (key === 'screenshotUsageLimitDedupSuffix') return screenshotUsageLimitDedupSuffix;
    if (key === 'fsWatch') return fsWatch;
    if (key === 'dirname') return dirname;
    if (key === 'readAntigravityNativeQuota') return () => undefined;
    if (key === 'resolveAntigravityProofTranscriptPath') return () => undefined;
    if (key === 'withAntigravityDirectFailureProof') return (limit: unknown) => limit;
    if (key === 'traexQuestionBridge') return INERT_TRAEX_QUESTION_BRIDGE;
    if (key === 'awaySummaryFocus') return INERT_AWAY_SUMMARY_FOCUS;
    if (key === 'backgroundTaskTracker') return INERT_BACKGROUND_TASK_TRACKER;
    // Fold-background support added a thin observe wrapper called from several
    // worker functions (fingerprint switch, rotation, drain paths). Tests that
    // load those functions but do not exercise background-task bookkeeping get
    // an inert no-op instead of an undefined call; a scope can still override it.
    if (key === 'observeClaudeBackgroundTasks') return scope.observeClaudeBackgroundTasks ?? (() => {});
    if (key === 'awaySummaryFocusRefusal') return awaySummaryFocusRefusal;
    if (key === 'isBridgeNothingToSendFinal') return isBridgeNothingToSendFinal;
    if (key === 'TurnSendLedger') return TurnSendLedger;
    if (key === 'frozenImReplyTurn') {
      if (!dependencies.has(key)) dependencies.set(key, loadWorkerFunction(key, scope));
      return dependencies.get(key);
    }
    if (key === 'proofFromSubmitRecheckResult') return proofFromSubmitRecheckResult;
    if (key === 'recheckResultFromProof') return recheckResultFromProof;
    if (key === 'matchesQueuedActivationTurn') return matchesQueuedActivationTurn;
    if (key === 'claudeNativeSessionIdFromJsonlPath') return claudeNativeSessionIdFromJsonlPath;
    if (key === 'isAuthoritativeClaudeTranscriptTurn') return isAuthoritativeClaudeTranscriptTurn;
    if (key === 'isAuthoritativeStructuredTranscriptTurn') return isAuthoritativeStructuredTranscriptTurn;
    if (key === 'isAuthoritativeSubmitSendMarker') return isAuthoritativeSubmitSendMarker;
    if (key === 'randomBytes') return randomBytes;
    if (key === 'sanitizeClaudeInput') return sanitizeClaudeInput;
    if (typeof key === 'string' && ['settledAbsorbedKey', 'rememberSettledAbsorbedTurn', 'syncSettledAbsorbedTurnsFromParsed', 'retireSkippedQueuedPrefix', 'mergeMarkerQueuedTurnIntoMemory', 'retireAntigravityBridgeTurn', 'rebindAntigravityBridgeTurn', 'warnPromptReadySkipped', 'cancelTurnTerminalReadyRecovery', 'recoverDeferredPromptReadyAtTurnTerminal', 'markPromptReadyFromBusyProbe', 'traexNativeStartupInputIsPending', 'isTraexTmuxViewportBackend', 'isTraexHcViewportBackend', 'isTraexNativeViewportBackend', 'currentTraexCliLifetimeNonce', 'currentTraexGridRevision', 'currentTraexControlWriteRevision', 'currentTraexInterruptGeneration', 'clearTraexStartupWebRecheck', 'currentWebResizedGridFor', 'syncHcPaneSizeFor', 'invalidateTraexNativeViewportEvidence', 'activeTraexNativeViewportEvidence', 'readTraexStartupViewportScreen', 'traexWebInputSettleStatus', 'traexNativeStartupScreenAdmitsPure', 'traexPromptReadyGateBlocks', 'probeAndPublishTraexNativeViewport', 'scheduleTraexNativeViewportRefreshIfNeeded', 'readinessTrackedInput', 'invalidatePromptReadinessEvidence', 'revokePromptReadiness', 'codexAppRuntimeTypeAheadReady', 'sessionEventMetadata', 'bindSessionObservation', 'bindSessionPhysicalObservation', 'bindSessionExecutionEvent', 'restoreCodexAppContractNativeSession', 'backgroundTranscriptChainFilePath', 'persistBackgroundTranscriptChain', 'latestClosedTranscriptOffset', 'prepareBackgroundTranscriptReplay', 'recordBackgroundTranscriptRotation', 'isClaudeFamilyCli', 'spawnCliBody', 'deferSessionReadyUntilRuntimeAssigned', 'takeDeferredSessionReady', 'replayDeferredSessionReady', 'clearDeferredSessionReady', 'setCaptureIdentity', 'cotEntryWellFormed', 'cotEntryWithoutSentinel', 'clearCodexAppInterruptTarget', 'publishAppliedReasoningSelection', 'publishNativeReasoningFooter', 'publishNativeReasoningObservation', 'notifyTraexCatalogEmpty', 'admitTraexCatalogModelBeforeInput', 'requeueUnsubmittedQueuedActivation', 'acknowledgeQueuedActivationToken', 'probeAuthoritativeQueuedActivationEvidence', 'observeAuthoritativeClaudeTurnStart', 'observeAuthoritativeStructuredTurnStart', 'claudeActivationTranscriptPathAllowed', 'prepareAntigravityAccountsCredentialMask', 'reconcileAntigravitySpawnAccount', 'confirmAntigravitySpawnAccount', 'currentAntigravityWrittenInput', 'resetAntigravityNativeQuotaLog', 'cancelAntigravityFoldedReconcilePending', 'armAntigravityFoldedReconcilePending', 'tryReconcilePendingAntigravityFoldedTurns', 'foldBackgroundUpdatesInitEnabled', 'foldBackgroundUpdatesEnabled', 'setFoldBackgroundUpdatesLive', 'resetFoldBackgroundUpdatesStateForInit', 'isSuppressedNonTerminalMonitorWake', 'sendTerminalTurnStarted', 'resolveMonitorWakeCotAnchor', 'computeBackgroundCotHold', 'observePendingMonitorWakeCotActivity', 'flushPendingMonitorWakeCotOnTextlessComplete', ...TRAEX_QUESTION_FUNCTIONS, ...FAILED_TURN_REWIND_FUNCTIONS].includes(key)) {
      if (!dependencies.has(key)) dependencies.set(key, loadWorkerFunction(key, scope));
      return dependencies.get(key);
    }
    return (globalThis as any)[key];
  };
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (_target, key) => resolve(key),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  });
  // eslint-disable-next-line no-new-func
  return new Function('scope', `with (scope) { ${transpiledWorkerFunction(name)}; return ${name}; }`)(proxy) as T;
}

/** Execute one real IPC case without starting the worker's process listeners. */
export function loadWorkerMessageHandler(name: string, scope: Record<string, unknown>): (message: unknown) => Promise<void> {
  const source = workerSourceFile();
  let clause: ts.CaseClause | undefined;
  function visit(node: ts.Node) {
    if (ts.isSwitchStatement(node) && node.expression.getText(source) === 'msg.type') {
      clause = node.caseBlock.clauses.find((item): item is ts.CaseClause =>
        ts.isCaseClause(item) && ts.isStringLiteral(item.expression) && item.expression.text === name);
    }
    if (!clause) ts.forEachChild(node, visit);
  }
  visit(source);
  if (!clause) throw new Error(`Missing worker IPC case: ${name}`);
  const code = ts.transpileModule(`async function handle(msg: any) { switch (msg.type) { ${clause.getText(source)} } }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => {
      if (key in target) return target[key as string];
      // Same lazy module-state defaults as loadWorkerFunction so extracted IPC
      // cases (e.g. prompt_submitted reading the keep-alive map) resolve even
      // when the harness scope does not stub them.
      const scopedDefault = defaultScopedWorkerState(scope, key);
      if (scopedDefault !== undefined) return scopedDefault;
      if (key === 'recordStructuredInput') return () => {};
      if (key === 'recoverSessionRenameAfterPersistentReattach') return () => false;
      if (key === 'updateSessionTurnNativeAnchor') return () => {};
      if (key === 'revokePromptReadiness') return loadWorkerFunction('revokePromptReadiness', scope);
      if (key === 'replayDeferredSessionReady') return loadWorkerFunction('replayDeferredSessionReady', scope);
      if (key === 'resetFoldBackgroundUpdatesStateForInit') return loadWorkerFunction('resetFoldBackgroundUpdatesStateForInit', scope);
      if (key === 'setFoldBackgroundUpdatesLive') return loadWorkerFunction('setFoldBackgroundUpdatesLive', scope);
      return (globalThis as any)[key];
    },
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${code}; return handle; }`)(proxy);
}
