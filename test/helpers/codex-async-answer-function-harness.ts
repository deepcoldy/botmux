import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// Execute the production function/closure with controlled dependencies, as in
// helpers/worker-function-harness. No assertions inspect source text.
function evaluate(text: string, scope: Record<string, any>): any {
  const js = ts.transpileModule(`const probe = ${text.replace(/^export /, '')};`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
  } }).outputText;
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => key in target ? target[key as string] : (globalThis as any)[key],
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${js}; return probe; }`)(proxy);
}
export function productionFunction(path: string, name: string, scope: Record<string, any>): any {
  const file = ts.createSourceFile(path, readFileSync(join(process.env.CODEX_ASYNC_REVIEW_SOURCE_ROOT ?? '.', path), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing function ${name}`);
  return evaluate(declaration.getText(file), scope);
}
export function delivery(scope: Record<string, any>): any {
  const path = 'src/daemon.ts';
  const file = ts.createSourceFile(path, readFileSync(join(process.env.CODEX_ASYNC_REVIEW_SOURCE_ROOT ?? '.', path), 'utf8'), ts.ScriptTarget.Latest, true);
  let arrow: ts.Node | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'deliverCodexAsyncAnswer') {
      const deps = node.arguments[3];
      if (ts.isObjectLiteralExpression(deps)) arrow = deps.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === 'deliver');
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!arrow || !ts.isPropertyAssignment(arrow)) throw new Error('Missing production async delivery closure');
  return evaluate(arrow.initializer.getText(file), scope);
}
export function productionClass(path: string, name: string, scope: Record<string, any>): any {
  const file = ts.createSourceFile(path, readFileSync(join(process.env.CODEX_ASYNC_REVIEW_SOURCE_ROOT ?? '.', path), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing class ${name}`);
  return evaluate(declaration.getText(file), scope);
}

export function deliveryIsCurrent(scope: Record<string, any>): any {
  const path = 'src/daemon.ts';
  const file = ts.createSourceFile(path, readFileSync(join(process.env.CODEX_ASYNC_REVIEW_SOURCE_ROOT ?? '.', path), 'utf8'), ts.ScriptTarget.Latest, true);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'deliverCodexAsyncAnswer') {
      let parent: ts.Node | undefined = node.parent;
      while (parent && !ts.isBlock(parent)) parent = parent.parent;
      if (parent && ts.isBlock(parent)) {
        for (const statement of parent.statements) {
          if (!ts.isVariableStatement(statement)) continue;
          for (const declaration of statement.declarationList.declarations) {
            if (declaration.name.getText(file) === 'isCurrent') expression = declaration.initializer;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!expression) throw new Error('Missing async delivery current-origin closure');
  return evaluate(expression.getText(file), scope);
}
