/** Execute a production closure with explicit host dependencies, matching the
 * worker-function harness while the pool still has no importable host seam. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

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
    get: (target, key) => key in target ? target[key as string] : (globalThis as any)[key],
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${compiled}; return ${name}; }`)(proxy) as T;
}
