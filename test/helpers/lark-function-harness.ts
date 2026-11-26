import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ProtectedResultStore } from '../../src/services/protected-result-store.js';
import { config } from '../../src/config.js';

/** Isomorphic twin of client.ts's module-private `protectedFinalReceipt`.
 * A sliced function loses sibling declarations, so reply/send slices resolve
 * this copy through the proxy. Keep the guard and lookup identical to the
 * production function; an empty protection index resolves to undefined. */
function protectedFinalReceipt(larkAppId: string, hookContext?: Record<string, unknown>): string | undefined {
  if (hookContext?.protectedFinal !== true || typeof hookContext.sessionId !== 'string'
    || typeof hookContext.turnId !== 'string') return undefined;
  return new ProtectedResultStore(config.session.dataDir)
    .completedFinal(larkAppId, hookContext.sessionId, hookContext.turnId)?.[0];
}

/** Module-level bindings the sliced client functions reference but the test
 * scope does not inject. Resolved only after an explicit scope miss. */
const HARNESS_MODULE_IMPORTS: Record<string, unknown> = {
  ProtectedResultStore,
  config,
  protectedFinalReceipt,
};

/** Execute a real client function without starting its module dependencies.
 * Only the provider and surrounding services are injected; the function body
 * and retry gate remain production code. */
export function loadLarkClientFunction<T extends (...args: any[]) => any>(name: string, scope: Record<string, unknown>): T {
  const source = ts.createSourceFile('client.ts', readFileSync(join(process.cwd(), 'src/im/lark/client.ts'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body);
  if (!declaration) throw new Error(`Missing client function: ${name}`);
  const printed = ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, source).replace(/^export\s+/m, '');
  const code = ts.transpileModule(printed, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  return new Function('scope', `with (scope) { ${code}; return ${name}; }`)(new Proxy(scope, {
    has: (_, key) => key !== Symbol.unscopables,
    get: (target, key) => key in target
      ? target[key as string]
      : (typeof key === 'string' && key in HARNESS_MODULE_IMPORTS
        ? HARNESS_MODULE_IMPORTS[key]
        : (globalThis as any)[key]),
  })) as T;
}
