import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { authorizeSessionScopedIpc } from '../src/core/daemon-ipc-session-auth.js';
import { parseScheduledTurnId } from '../src/core/scheduled-turn-provenance.js';

const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const route = source.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'ipcRoute'
  && node.expression.arguments[1]?.getText(source) === 'SCHEDULE_MANAGED_MUTATE_ROUTE') as ts.ExpressionStatement;
const handler = (route.expression as ts.CallExpression).arguments[2];
const code = ts.transpileModule(`const handler = ${handler.getText(source)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function harness(action = 'pause', turnId = 'om_human', id = 'a1b2c3d4') {
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
  const record: any = { kind: 'delegated', state: 'active', selfManage: false,
    task: { id: 'a1b2c3d4', chatId: 'oc_chat' } };
  const authorizeDelegatedScheduleSelfManage = vi.fn(async () => undefined);
  const scope: any = {
    readJsonBody: async () => ({ sessionId: 's1', originCapability: 'c'.repeat(64),
      originTurnId: turnId, action, id, prompt: 'changed' }),
    findActiveBySessionId: () => ds, authorizeSessionScopedIpc,
    isTrustedHostIpcRequest: () => false,
    getDashboardAdminOpenIds: () => ['ou_admin'],
    parseScheduledTurnId,
    authorizeDelegatedScheduleSelfManage,
    readGlobalConfig: () => ({ scheduleDelegation: { selfManageEnabled: true } }),
    resolveTargetAppOpenId: async () => ({ status: 'resolved', openId: 'ou_admin' }),
    listChatMemberOpenIds: async () => ['ou_admin'],
    scheduleAuthorityStore: { getRecord: () => record },
    scheduler,
    jsonRes: (_res: unknown, status: number, value: unknown) => ({ status, value }),
  };
  const run = new Function('scope', `with (scope) { ${code}; return handler; }`)(scope);
  return { ds, record, scheduler, authorizeDelegatedScheduleSelfManage, run: () => run({}, {}) };
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

  it.each(['pause', 'remove'] as const)('allows a delegated scheduled turn to %s only itself', async action => {
    const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
    const h = harness(action, turnId, 'self');
    h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    h.record.selfManage = true;
    expect(await h.run()).toMatchObject({ status: 200, value: { ok: true } });
    expect(h.authorizeDelegatedScheduleSelfManage).toHaveBeenCalledOnce();
    expect(action === 'pause' ? h.scheduler.disableTask : h.scheduler.removeTask)
      .toHaveBeenCalledWith('a1b2c3d4');
  });

  it('does not let a scheduled turn manage another task or force-run itself', async () => {
    const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
    const other = harness('pause', turnId, 'deadbeef');
    other.ds.activeInteractiveTurn.caller.senderType = 'bot';
    expect(await other.run()).toMatchObject({ status: 403, value: { error: 'schedule_mutation_current_human_required' } });

    const runSelf = harness('run', turnId, 'self');
    runSelf.ds.activeInteractiveTurn.caller.senderType = 'bot';
    expect(await runSelf.run()).toMatchObject({ status: 403, value: { error: 'schedule_mutation_current_human_required' } });
  });

  it('refuses to force-run a paused task (must resume first)', async () => {
    const h = harness('run');
    h.record.kind = 'direct';
    h.record.task = { id: 'a1b2c3d4', chatId: 'oc_chat', enabled: false };
    expect(await h.run()).toMatchObject({ status: 409, value: { error: 'schedule_task_disabled' } });
    expect(h.scheduler.runTaskNow).not.toHaveBeenCalled();
  });
});
