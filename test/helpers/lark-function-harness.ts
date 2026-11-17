import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** Execute a real client function without starting its module dependencies.
 * Only the provider and surrounding services are injected; the function body
 * and retry gate remain production code. */
export function loadLarkClientFunction<T extends (...args: any[]) => any>(name: string, scope: Record<string, unknown>): T {
  const source = ts.createSourceFile('client.ts', readFileSync(join(process.cwd(), 'src/im/lark/client.ts'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body);
  if (!declaration) throw new Error(`Missing client function: ${name}`);
  const printed = ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, source).replace(/^export\s+/m, '');
  const code = ts.transpileModule(printed, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function('scope', `with (scope) { ${code}; return ${name}; }`)(new Proxy(scope, {
    has: (_, key) => key !== Symbol.unscopables,
    get: (target, key) => key in target ? target[key as string] : (globalThis as any)[key],
  })) as T;
}
