/** Execute a production closure with explicit host dependencies, matching the
 * worker-function harness while the pool still has no importable host seam. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { controllerForSession } from '../../src/core/session-controller.js';
import { activeSessionKey } from '../../src/core/types.js';
import { isCodexAppCliId } from '../../src/adapters/cli/types.js';
import { contractTerminalStatus, executionObserverSupported, sameExecution } from '../../src/services/session-contract.js';
import { hasConfirmedNativeGrokEffort, noteExplicitEffortPreferenceEdit } from '../../src/core/terminal-effort-writeback.js';
import { assertSessionLaunchModelChoiceAllowed } from '../../src/core/session-model.js';
import { cliModelMayKeepReasoningEffort } from '../../src/services/codex-reasoning-effort.js';
import { runtimeStartRefusal } from '../../src/services/runtime-reservation.js';
import { cotMessageFinishStatus } from '../../src/im/lark/cot-message.js';
import { resetStartingCardHealth } from '../../src/core/starting-card-health.js';
import { ProtectedResultStore } from '../../src/services/protected-result-store.js';
import { hasProtectedSessionMutationOwnership, protectedSessionMutationReasons } from '../../src/core/session-mutation-guard.js';
import { parseScheduledTurnId } from '../../src/core/scheduled-turn-provenance.js';
import { scheduledSessionRun } from '../../src/core/scheduled-send.js';

/** deliverFinalOutput's protected final gate reads `config.session.dataDir` and
 * constructs ProtectedResultStore. Sliced closures do not load module imports,
 * so give the harness a real empty data dir: with no protection index every
 * protected lookup resolves to undefined, leaving existing fixtures unchanged.
 * Created lazily — module import can run before the fenced tmp dir exists. */
let harnessDataDir: string | undefined;
function getHarnessDataDir(): string {
  if (!harnessDataDir) harnessDataDir = mkdtempSync(join(tmpdir(), 'worker-pool-harness-protected-'));
  return harnessDataDir;
}
import {
  cancelAntigravityRotationReplay,
  clearInFlightAntigravityRotation,
  formatAntigravityCooldown,
  tryAntigravityQuotaAutoRotate,
} from '../../src/core/antigravity-rotation.js';
import {
  inspectAntigravityAccounts,
  maskAntigravityEmail,
  rotateAntigravityAccountOnQuotaLimit,
} from '../../src/services/antigravity-accounts.js';

/** Untracked handler fixtures still have the daemon's empty delivery registry.
 * Resolve settlement through production functions so fixtures exercise its
 * identity checks rather than substituting a no-op completion callback. */

/** Module-level weak-state containers owned by worker-pool.ts. Source-sliced
 * closures cannot see the module scope, so each fixture scope gets fresh
 * instances (mirroring the `workerCommittedTurnIds` seeding below). */
const WORKER_POOL_WEAK_CONTAINERS: Record<string, () => WeakMap<object, any> | WeakSet<object>> = {
  workersWithLiveWorkingStatus: () => new WeakMap(),
  visibleStreamingCardStatus: () => new WeakMap(),
  pendingStreamingCardPatchVisibleStatus: () => new WeakMap(),
  inFlightStreamingCardPatchVisibleStatus: () => new WeakMap(),
  completedTerminalTurns: () => new WeakMap(),
  postTerminalDirectSubmitSessions: () => new WeakSet(),
};

function resolvePoolDependency(scope: Record<string, any>, key: string | symbol): unknown {
  if (key in scope) return scope[key as string];
  if (typeof key === 'string' && key in WORKER_POOL_WEAK_CONTAINERS) {
    return scope[key] ??= WORKER_POOL_WEAK_CONTAINERS[key]();
  }
  if (key === 'randomUUID') return randomUUID;
  if (key === 'traexRuntimeDeferredNotice') return scope[key] ??= new Map();
  if (key === 'getDaemonBootId') return scope[key] ??= () => 'worker-pool-test-boot';
  if (key === 'controllerForSession') return controllerForSession;
  if (key === 'activeSessionKey') return activeSessionKey;
  if (key === 'parseScheduledTurnId') return parseScheduledTurnId;
  if (key === 'scheduledSessionRun') return scheduledSessionRun;
  if (key === 'runtimeStartRefusal') return runtimeStartRefusal;
  if (key === 'cotMessageFinishStatus') return cotMessageFinishStatus;
  if (key === 'resetStartingCardHealth') return resetStartingCardHealth;
  if (key === 'hasProtectedSessionMutationOwnership') return hasProtectedSessionMutationOwnership;
  if (key === 'protectedSessionMutationReasons') return protectedSessionMutationReasons;
  if (key === 'cancelAntigravityRotationReplay') return cancelAntigravityRotationReplay;
  if (key === 'clearInFlightAntigravityRotation') return clearInFlightAntigravityRotation;
  if (key === 'formatAntigravityCooldown') return formatAntigravityCooldown;
  if (key === 'tryAntigravityQuotaAutoRotate') return tryAntigravityQuotaAutoRotate;
  if (key === 'inspectAntigravityAccounts') return inspectAntigravityAccounts;
  if (key === 'maskAntigravityEmail') return maskAntigravityEmail;
  if (key === 'rotateAntigravityAccountOnQuotaLimit') return rotateAntigravityAccountOnQuotaLimit;
  if (key === 'isCodexAppCliId') return isCodexAppCliId;
  if (key === 'executionObserverSupported') return executionObserverSupported;
  if (key === 'contractTerminalStatus') return contractTerminalStatus;
  if (key === 'sameExecution') return sameExecution;
  if (key === 'hasConfirmedNativeGrokEffort') return hasConfirmedNativeGrokEffort;
  if (key === 'noteExplicitEffortPreferenceEdit') return noteExplicitEffortPreferenceEdit;
  if (key === 'assertSessionLaunchModelChoiceAllowed') return assertSessionLaunchModelChoiceAllowed;
  if (key === 'cliModelMayKeepReasoningEffort') return cliModelMayKeepReasoningEffort;
  if (key === 'config') return { terminalEffortWriteback: false, session: { dataDir: getHarnessDataDir() } };
  if (key === 'ProtectedResultStore') return ProtectedResultStore;
  if (key === 'pendingOrdinaryImDeliveries') return scope.pendingOrdinaryImDeliveries ??= new Map();
  if (key === 'workerCommittedTurnIds') return scope.workerCommittedTurnIds ??= new WeakMap();
  if (key === 'collectSessionTurnGarbage') return () => {};
  if (typeof key === 'string' && ['canForkRegisteredSession', 'ownsCodexAppFinalDelivery', 'completeWorkerOrdinaryImDelivery',
    'clearOrdinaryImDelivery', 'recordWorkerCommittedTurn', 'speculateStatuslineLaunchGen',
    'recordLaunchModel', 'assistantLiveInputAdmission', 'assistantTransferInputDeliveryAllowed',
    'releaseHeldCotMessage', 'isReplayOfHeldCotTerminal', 'finalizeOrHoldCotMessage',
    'requiredReplyCotHoldKey', 'settleRequiredReplyBackground', 'settleRequiredReplyCotMessage',
    'failRequiredReplyCotHolds', 'clearWorkerRuntimeProvenance',
    'hasInstallChangeMutationOwnership', 'hasInstallChangeSuspendGuard'].includes(key)) {
    return scope[key] ??= loadWorkerPoolFunction(key, scope);
  }
  return (globalThis as any)[key];
}

export function loadWorkerPoolFunction<T extends (...args: any[]) => any>(
  name: string, scope: Record<string, any>,
): T {
  const source = ts.createSourceFile('worker-pool.ts',
    readFileSync('src/core/worker-pool.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing pool function: ${name}`);
  const compiled = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => resolvePoolDependency(target, key),
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${compiled}; return ${name}; }`)(proxy) as T;
}

/** Transitional seam for a production handler closure while its host lifetime
 * still belongs to setupWorkerHandlers. Execute its body, not source assertions. */
export function loadWorkerPoolClosure<T extends (...args: any[]) => any>(name: string, scope: Record<string, any>): T {
  const source = ts.createSourceFile('worker-pool.ts', readFileSync('src/core/worker-pool.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!declaration) throw new Error(`Missing pool closure: ${name}`);
  const compiled = ts.transpileModule(`const ${declaration.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => resolvePoolDependency(target, key),
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${compiled}; return ${name}; }`)(proxy) as T;
}
