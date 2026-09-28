import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { authorizeSessionScopedIpc } from '../src/core/daemon-ipc-session-auth.js';

const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const route = source.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'ipcRoute'
  && node.expression.arguments[1]?.getText(source) === 'SCHEDULE_MANAGED_MUTATE_ROUTE') as ts.ExpressionStatement;
const handler = (route.expression as ts.CallExpression).arguments[2];
const code = ts.transpileModule(`const handler = ${handler.getText(source)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function harness(action = 'pause') {
  const turnId = 'om_human';
  const ds: any = {
    larkAppId: 'cli_target', session: { sessionId: 's1' },
    managedTurnOrigin: { capability: 'c'.repeat(64), turnId },
    activeInteractiveTurn: { turnId, caller: {
      senderType: 'user', requestLarkAppId: 'cli_target', requestUserOpenId: 'ou_admin',
    } },
  };
  const scheduler = {
    updateTask: vi.fn(() => ({ ok: true })), removeTask: vi.fn(() => true),
    disableTask: vi.fn(() => true), enableTask: vi.fn(() => true), runTaskNow: vi.fn(() => true),
  };
  const record: any = { kind: 'delegated', state: 'active', task: { id: 'a1b2c3d4' } };
  const scope: any = {
    readJsonBody: async () => ({ sessionId: 's1', originCapability: 'c'.repeat(64),
      originTurnId: turnId, action, id: 'a1b2c3d4', prompt: 'changed' }),
    findActiveBySessionId: () => ds, authorizeSessionScopedIpc,
    isTrustedHostIpcRequest: () => false,
    getDashboardAdminOpenIds: () => ['ou_admin'],
    scheduleAuthorityStore: { getRecord: () => record },
    scheduler,
    jsonRes: (_res: unknown, status: number, value: unknown) => ({ status, value }),
  };
  const run = new Function('scope', `with (scope) { ${code}; return handler; }`)(scope);
  return { ds, record, scheduler, run: () => run({}, {}) };
}

describe('managed schedule mutation route', () => {
  it('does not let a bot-authored create grant become pause authority', async () => {
    const h = harness(); h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_mutation_current_human_required' } });
    expect(h.scheduler.disableTask).not.toHaveBeenCalled();
  });

  it('requires a new authorization to change a delegated task canonical input', async () => {
    const h = harness('update');
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'delegated_schedule_reauthorization_required' } });
    expect(h.scheduler.updateTask).not.toHaveBeenCalled();
  });

  it('allows a current administrator to pause through the host authority path', async () => {
    const h = harness('pause');
    expect(await h.run()).toMatchObject({ status: 200, value: { ok: true } });
    expect(h.scheduler.disableTask).toHaveBeenCalledWith('a1b2c3d4');
  });
});
