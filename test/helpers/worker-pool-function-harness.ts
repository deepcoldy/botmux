/** Execute a production closure with explicit host dependencies, matching the
 * worker-function harness while the pool still has no importable host seam. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { controllerForSession } from '../../src/core/session-controller.js';
import { isCodexAppCliId } from '../../src/adapters/cli/types.js';
import { contractTerminalStatus, executionObserverSupported, sameExecution } from '../../src/services/session-contract.js';
import { hasConfirmedNativeGrokEffort, noteExplicitEffortPreferenceEdit } from '../../src/core/terminal-effort-writeback.js';
import { assertSessionLaunchModelChoiceAllowed } from '../../src/core/session-model.js';
import { cliModelMayKeepReasoningEffort } from '../../src/services/codex-reasoning-effort.js';
import { runtimeStartRefusal } from '../../src/services/runtime-reservation.js';

/** Untracked handler fixtures still have the daemon's empty delivery registry.
 * Resolve settlement through production functions so fixtures exercise its
 * identity checks rather than substituting a no-op completion callback. */
function resolvePoolDependency(scope: Record<string, any>, key: string | symbol): unknown {
  if (key in scope) return scope[key as string];
  if (key === 'controllerForSession') return controllerForSession;
  if (key === 'runtimeStartRefusal') return runtimeStartRefusal;
  if (key === 'isCodexAppCliId') return isCodexAppCliId;
  if (key === 'executionObserverSupported') return executionObserverSupported;
  if (key === 'contractTerminalStatus') return contractTerminalStatus;
  if (key === 'sameExecution') return sameExecution;
  if (key === 'hasConfirmedNativeGrokEffort') return hasConfirmedNativeGrokEffort;
  if (key === 'noteExplicitEffortPreferenceEdit') return noteExplicitEffortPreferenceEdit;
  if (key === 'assertSessionLaunchModelChoiceAllowed') return assertSessionLaunchModelChoiceAllowed;
  if (key === 'cliModelMayKeepReasoningEffort') return cliModelMayKeepReasoningEffort;
  if (key === 'config') return { terminalEffortWriteback: false };
  if (key === 'pendingOrdinaryImDeliveries') return scope.pendingOrdinaryImDeliveries ??= new Map();
  if (key === 'workerCommittedTurnIds') return scope.workerCommittedTurnIds ??= new WeakMap();
  if (typeof key === 'string' && ['ownsCodexAppFinalDelivery', 'completeWorkerOrdinaryImDelivery',
    'clearOrdinaryImDelivery', 'recordWorkerCommittedTurn'].includes(key)) {
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
