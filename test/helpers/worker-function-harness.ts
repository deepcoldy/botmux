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
import { REPLY_DELIVERY_ENV } from '../../src/services/send-completion-hint.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
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
import { finalBridgeSendMarkerCoversOwnThread, isFinalBridgeSendMarker, stripTrailingBridgeSentinelLine } from '../../src/services/bridge-fallback-gate.js';
import { rewindableErrorCode, transcriptTurnFailedWithoutOutput } from '../../src/core/failed-turn-rewind.js';
import { pruneRewindBackupsBeside, registerRewindBackup, rewindBackupDirForSession } from '../../src/core/rewind-backup-retention.js';
import { readTraexCatalogWithRetry } from '../../src/services/traex-model-catalog-retry.js';
import { traexAutoModelPolicyKey } from '../../src/services/traex-auto-model.js';
import { traexStartupInputReady } from '../../src/core/traex-startup-input.js';
import { WebTerminalInputController, WebTerminalInputWireState } from '../../src/core/web-terminal-input-controller.js';
import { BusyReadyDeferralTracker, BusyReadyLogThrottle } from '../../src/utils/busy-ready-deferral.js';
import { ClaudePermissionNoticeTracker } from '../../src/services/claude-action-prompt.js';
import {
  inspectAntigravityAccounts,
  reconcileActiveAntigravityToken,
  resolveAntigravitySpawnStoreOptions,
} from '../../src/services/antigravity-accounts.js';
import { drainAntigravityTranscript } from '../../src/services/antigravity-transcript.js';
import {
  normalizeBackgroundTranscriptPath,
  normalizeBackgroundTranscriptSegments,
  readBackgroundTranscriptChain,
  writeBackgroundTranscriptChain,
} from '../../src/services/background-transcript-chain.js';

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
const INERT_BACKGROUND_TASK_TRACKER = { backgroundWait: () => 0 };
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
  if (key === 'pendingAbsorbedReplyDeliveries') return (scope.pendingAbsorbedReplyDeliveries ??= new Map());
  if (key === 'deferredAbsorbedReplyFinals') return (scope.deferredAbsorbedReplyFinals ??= new Map());
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
    if (key === 'reconcileActiveAntigravityToken') return reconcileActiveAntigravityToken;
    if (key === 'inspectAntigravityAccounts') return inspectAntigravityAccounts;
    if (key === 'resolveAntigravitySpawnStoreOptions') return resolveAntigravitySpawnStoreOptions;
    if (key === 'drainAntigravityTranscript') return drainAntigravityTranscript;
    if (key === 'traexQuestionBridge') return INERT_TRAEX_QUESTION_BRIDGE;
    if (key === 'awaySummaryFocus') return INERT_AWAY_SUMMARY_FOCUS;
    if (key === 'backgroundTaskTracker') return INERT_BACKGROUND_TASK_TRACKER;
    if (key === 'awaySummaryFocusRefusal') return awaySummaryFocusRefusal;
    if (typeof key === 'string' && ['retireAntigravityBridgeTurn', 'rebindAntigravityBridgeTurn', 'warnPromptReadySkipped', 'cancelTurnTerminalReadyRecovery', 'recoverDeferredPromptReadyAtTurnTerminal', 'markPromptReadyFromBusyProbe', 'traexNativeStartupInputIsPending', 'readinessTrackedInput', 'invalidatePromptReadinessEvidence', 'revokePromptReadiness', 'codexAppRuntimeTypeAheadReady', 'sessionEventMetadata', 'bindSessionObservation', 'bindSessionPhysicalObservation', 'bindSessionExecutionEvent', 'restoreCodexAppContractNativeSession', 'backgroundTranscriptChainFilePath', 'persistBackgroundTranscriptChain', 'latestClosedTranscriptOffset', 'prepareBackgroundTranscriptReplay', 'recordBackgroundTranscriptRotation', 'spawnCliBody', 'deferSessionReadyUntilRuntimeAssigned', 'takeDeferredSessionReady', 'replayDeferredSessionReady', 'clearDeferredSessionReady', 'setCaptureIdentity', 'cotEntryWellFormed', 'cotEntryWithoutSentinel', 'clearCodexAppInterruptTarget', 'publishAppliedReasoningSelection', 'publishNativeReasoningFooter', 'publishNativeReasoningObservation', 'notifyTraexCatalogEmpty', 'admitTraexCatalogModelBeforeInput', 'requeueUnsubmittedQueuedActivation', 'prepareAntigravityAccountsCredentialMask', 'reconcileAntigravitySpawnAccount', 'confirmAntigravitySpawnAccount', ...TRAEX_QUESTION_FUNCTIONS, ...FAILED_TURN_REWIND_FUNCTIONS].includes(key)) {
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
      return (globalThis as any)[key];
    },
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${code}; return handle; }`)(proxy);
}
