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
import ts from 'typescript';

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
  return ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

export function loadWorkerFunction<T extends (...args: any[]) => any>(
  name: string,
  scope: Record<string, unknown>,
): T {
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => (key in target ? target[key as string] : (globalThis as any)[key]),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  });
  // eslint-disable-next-line no-new-func
  return new Function('scope', `with (scope) { ${transpiledWorkerFunction(name)}; return ${name}; }`)(proxy) as T;
}
