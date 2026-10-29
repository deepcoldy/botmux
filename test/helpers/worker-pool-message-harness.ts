import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the pool's actual IPC branches without starting a daemon/fleet.
export function loadWorkerPoolMessageHandlers(names: string[], scope: Record<string, unknown>) {
  const pool = ts.createSourceFile('worker-pool.ts', readFileSync(new URL('../../src/core/worker-pool.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const clauses: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && names.includes(node.expression.text)) clauses.push(node.getText(pool));
    ts.forEachChild(node, visit);
  }
  visit(pool);
  if (clauses.length !== names.length) throw new Error('pool IPC handler missing');
  const code = ts.transpileModule(`function handle(msg: any) { switch (msg.type) { ${clauses.join('\n')} } }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('scope', `with (scope) { ${code}; return handle; }`)(scope);
}

