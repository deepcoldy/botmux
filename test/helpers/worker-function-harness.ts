/**
 * Execute ONE real top-level function of src/worker.ts against an injected
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { contractTerminalStatus, executionObserverSupported } from '../../src/services/session-contract.js';
import * as runtimeReservation from '../../src/services/runtime-reservation.js';
import { isRemoteBackendType } from '../../src/core/persistent-backend.js';
import { traexQuestionFlowVisible } from '../../src/utils/traex-question-page.js';
import { isNativeReasoningEffort } from '../../src/services/native-reasoning-observation.js';
import { readNativeReasoningFooter } from '../../src/utils/native-reasoning-footer.js';
import { readGrokRuntimeObservation } from '../../src/services/grok-runtime-observer.js';

/** TraeX question-page wiring the hold / idle paths call into (see
 *  src/worker.ts "TraeX native question page"): loaded as the real functions,
 *  so a fixture without a question page keeps its old behaviour. */
const TRAEX_QUESTION_FUNCTIONS = [
  'traexQuestionBridgeActive', 'traexQuestionBlockReported', 'traexQuestionHoldBlocks',
  'traexQuestionHoldsHeldInput', 'notifyTraexQuestionInputHeld', 'traexQuestionHoldsIdle',
];
/** Inert stand-in for the worker's TraexQuestionBridge instance (a const, not
 *  a function); a caller that observes it passes its own in `scope`. */
const INERT_TRAEX_QUESTION_BRIDGE = { kick() {}, reset() {}, hasOpenCard: () => false, dispose() {} };

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
  const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === name);
  if (!declaration) throw new Error(`Missing top-level worker function: ${name}`);
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
    if (key === 'confirmedTerminalEffortChoice') return () => undefined;
    if (key === 'contractTerminalStatus') return contractTerminalStatus;
    if (key === 'executionObserverSupported') return executionObserverSupported;
    if (key === 'isNativeReasoningEffort') return isNativeReasoningEffort;
    if (key === 'readNativeReasoningFooter') return readNativeReasoningFooter;
    if (key === 'readGrokRuntimeObservation') return readGrokRuntimeObservation;
    if (typeof key === 'string' && Object.hasOwn(runtimeReservation, key)) return (runtimeReservation as Record<string, unknown>)[key];
    if (key === 'isRemoteBackendType') return isRemoteBackendType;
    if (key === 'traexQuestionFlowVisible') return traexQuestionFlowVisible;
    if (key === 'traexQuestionBridge') return INERT_TRAEX_QUESTION_BRIDGE;
    if (typeof key === 'string' && ['codexAppRuntimeTypeAheadReady', 'sessionEventMetadata', 'bindSessionObservation', 'bindSessionPhysicalObservation', 'bindSessionExecutionEvent', 'restoreCodexAppContractNativeSession', 'spawnCliBody', 'setCaptureIdentity', 'publishAppliedReasoningSelection', 'publishNativeReasoningFooter', 'publishNativeReasoningObservation', ...TRAEX_QUESTION_FUNCTIONS].includes(key)) {
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
    get: (target, key) => key in target ? target[key as string] : (globalThis as any)[key],
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${code}; return handle; }`)(proxy);
}
