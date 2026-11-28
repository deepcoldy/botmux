import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { scheduledSessionRun, settleScheduledSessionRun } from '../../src/core/scheduled-send.js';
import { parseScheduledTurnId } from '../../src/core/scheduled-turn-provenance.js';
import { loadWorkerPoolFunction } from './worker-pool-function-harness.js';

// Execute the pool's actual IPC branches without starting a daemon/fleet.
export function loadWorkerPoolMessageHandlers(names: string[], scope: Record<string, unknown>, asynchronous = false) {
  if (!('config' in scope)) scope.config = { terminalEffortWriteback: false };
  if (!('collectSessionTurnGarbage' in scope)) scope.collectSessionTurnGarbage = () => {};
  if (!('cb' in scope)) scope.cb = {};
  if (!('settleScheduledSessionRun' in scope)) scope.settleScheduledSessionRun = settleScheduledSessionRun;
  // The sliced branches run under a raw `with (scope)`: module-level imports in
  // worker-pool.ts are not in scope, so every free binding the branch references
  // must be injected here. Master's scheduled-run branches call these two.
  if (!('scheduledSessionRun' in scope)) scope.scheduledSessionRun = scheduledSessionRun;
  if (!('parseScheduledTurnId' in scope)) scope.parseScheduledTurnId = parseScheduledTurnId;
  if (!('settleScheduledRunBinding' in scope)) scope.settleScheduledRunBinding = loadWorkerPoolFunction('settleScheduledRunBinding', scope);
  if (!('scheduledRunTriggerForWorker' in scope)) scope.scheduledRunTriggerForWorker = loadWorkerPoolFunction('scheduledRunTriggerForWorker', scope);
  const pool = ts.createSourceFile('worker-pool.ts', readFileSync(new URL('../../src/core/worker-pool.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const clauses: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && names.includes(node.expression.text)) clauses.push(node.getText(pool));
    ts.forEachChild(node, visit);
  }
  visit(pool);
  if (clauses.length !== names.length) throw new Error('pool IPC handler missing');
  const code = ts.transpileModule(`${asynchronous ? 'async ' : ''}function handle(msg: any) { switch (msg.type) { ${clauses.join('\n')} } }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('scope', `with (scope) { ${code}; return handle; }`)(scope);
}

