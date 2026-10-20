import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { authorizeSessionScopedIpc } from '../src/core/daemon-ipc-session-auth.js';
import { dispatchCallerFromReply } from '../src/core/dispatch-user-delegation.js';
import { pickTurnReplyTarget } from '../src/core/reply-target.js';
import { parseScheduledTurnId } from '../src/core/scheduled-turn-provenance.js';

const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const route = source.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'ipcRoute'
  && node.expression.arguments[1]?.getText(source) === 'SCHEDULE_MANAGED_MUTATE_ROUTE') as ts.ExpressionStatement;
const handler = (route.expression as ts.CallExpression).arguments[2];
const callerHelper = source.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'scheduleCallerForTurn');
const code = ts.transpileModule(`${callerHelper?.getText(source) ?? ''}
const handler = ${handler.getText(source)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function harness(action = 'pause', turnId = 'om_human', id = 'a1b2c3d4') {
  const ds: any = {
    larkAppId: 'cli_target', chatId: 'oc_chat', chatType: 'group',
    session: { sessionId: 's1' }, workerGeneration: 7,
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
  const authorizeScheduleSelfManage = vi.fn(async () => undefined);
  const scope: any = {
    readJsonBody: async () => ({ sessionId: 's1', originCapability: 'c'.repeat(64),
      originTurnId: turnId, action, id, prompt: 'changed' }),
    findActiveBySessionId: () => ds, authorizeSessionScopedIpc,
    pickTurnReplyTarget, dispatchCallerFromReply,
    isTrustedHostIpcRequest: () => false,
    getDashboardAdminOpenIds: () => ['ou_admin'],
    parseScheduledTurnId,
    authorizeScheduleSelfManage,
    readGlobalConfig: () => ({ scheduleDelegation: { selfManageEnabled: true } }),
    resolveUnionIdFromOpenId: async () => 'on_admin',
    resolveTargetAppOpenId: async () => ({ status: 'resolved', openId: 'ou_admin' }),
    listChatMemberOpenIds: async () => ['ou_admin'],
    scheduleAuthorityStore: { getRecord: () => record },
    scheduler,
    jsonRes: (_res: unknown, status: number, value: unknown) => ({ status, value }),
  };
  const run = new Function('scope', `with (scope) { ${code}; return handler; }`)(scope);
  return { ds, record, scheduler, authorizeScheduleSelfManage, scope, run: () => run({}, {}) };
}

function configureProviderActor(
  h: ReturnType<typeof harness>,
  action: 'update' | 'remove' | 'pause' | 'resume' | 'run' = 'remove',
): void {
  h.ds.activeInteractiveTurn.caller.senderType = 'bot';
  h.record.kind = 'direct';
  h.record.controlOpenId = 'ou_admin';
  h.record.controlUnionId = 'on_admin';
  h.record.task.enabled = true;
  h.scope.isTrustedHostIpcRequest = () => true;
  h.scope.readJsonBody = async () => ({
    sessionId: 's1',
    originCapability: 'c'.repeat(64),
    originTurnId: 'om_human',
    action,
    id: 'a1b2c3d4',
    prompt: 'changed',
    remoteRunnerSessionTool: true,
    remoteRunnerControllerOpenId: 'ou_admin',
  });
}

describe('managed schedule mutation route', () => {
  it('does not let a bot-authored create grant become pause authority', async () => {
    const h = harness(); h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_mutation_current_human_required' } });
    expect(h.scheduler.disableTask).not.toHaveBeenCalled();
  });

  it.each(['update', 'remove', 'pause', 'resume', 'run'] as const)(
    'lets the negotiated provider Actor %s its own direct task in the current chat',
    async action => {
      const h = harness(action);
      configureProviderActor(h, action);

      expect(await h.run()).toMatchObject({ status: 200, value: { ok: true } });
      const method = { update: 'updateTask', remove: 'removeTask', pause: 'disableTask',
        resume: 'enableTask', run: 'runTaskNow' }[action];
      expect(h.scheduler[method]).toHaveBeenCalledOnce();
    },
  );

  it('rejects a different administrator recorded as the task controller', async () => {
    const h = harness('remove');
    configureProviderActor(h);
    h.record.controlOpenId = 'ou_other_admin';
    // Keep every later guard independently satisfied: removing only the
    // controlOpenId equality must make this test turn green and fail mutation.
    h.record.controlUnionId = 'on_admin';
    h.scope.getDashboardAdminOpenIds = () => ['ou_admin', 'ou_other_admin'];
    h.scope.listChatMemberOpenIds = async () => ['ou_admin', 'ou_other_admin'];

    expect(await h.run()).toMatchObject({
      status: 403,
      value: { error: 'schedule_mutation_operator_denied' },
    });
    expect(h.scheduler.removeTask).not.toHaveBeenCalled();
  });

  it('rejects a controller whose current union id differs from the task authority', async () => {
    const h = harness('remove');
    configureProviderActor(h);
    h.record.controlUnionId = 'on_stale';

    expect(await h.run()).toMatchObject({
      status: 403,
      value: { error: 'schedule_mutation_operator_denied' },
    });
    expect(h.scheduler.removeTask).not.toHaveBeenCalled();
  });

  it('rejects a provider controller that is not a current dashboard administrator', async () => {
    const h = harness('remove');
    configureProviderActor(h);
    h.scope.getDashboardAdminOpenIds = () => [];

    expect(await h.run()).toMatchObject({
      status: 403,
      value: { error: 'schedule_mutation_operator_denied' },
    });
    expect(h.scheduler.removeTask).not.toHaveBeenCalled();
  });

  it('rejects a provider controller that is not a current group member', async () => {
    const h = harness('remove');
    configureProviderActor(h);
    h.scope.listChatMemberOpenIds = async () => [];

    expect(await h.run()).toMatchObject({
      status: 403,
      value: { error: 'schedule_mutation_operator_denied' },
    });
    expect(h.scheduler.removeTask).not.toHaveBeenCalled();
  });

  it.each([
    ['turn id', (h: ReturnType<typeof harness>) => {
      h.ds.managedTurnOrigin.turnId = 'om_replaced';
    }],
    ['worker generation', (h: ReturnType<typeof harness>) => {
      h.ds.workerGeneration += 1;
    }],
    ['origin capability', (h: ReturnType<typeof harness>) => {
      h.ds.managedTurnOrigin.capability = 'd'.repeat(64);
    }],
  ] as const)('rejects a provider mutation when %s changes after async identity checks', async (_name, mutate) => {
    const h = harness('remove');
    configureProviderActor(h);
    h.scope.listChatMemberOpenIds = async () => {
      mutate(h);
      return ['ou_admin'];
    };

    expect(await h.run()).toMatchObject({
      status: 409,
      value: { error: 'schedule_mutation_turn_changed' },
    });
    expect(h.scheduler.removeTask).not.toHaveBeenCalled();
  });

  it('does not let a provider Actor mutate a delegated task', async () => {
    const h = harness('remove');
    configureProviderActor(h);
    h.record.kind = 'delegated';

    expect(await h.run()).toMatchObject({
      status: 403,
      value: { error: 'schedule_mutation_operator_denied' },
    });
    expect(h.scheduler.removeTask).not.toHaveBeenCalled();
  });

  it('keeps a provider Actor confined to its own controller and current chat', async () => {
    const h = harness('remove');
    h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    h.record.kind = 'direct';
    h.record.controlOpenId = 'ou_admin';
    h.record.controlUnionId = 'on_admin';
    h.record.task.chatId = 'oc_other';
    h.scope.isTrustedHostIpcRequest = () => true;
    h.scope.readJsonBody = async () => ({
      sessionId: 's1',
      originCapability: 'c'.repeat(64),
      originTurnId: 'om_human',
      action: 'remove',
      id: 'a1b2c3d4',
      remoteRunnerSessionTool: true,
      remoteRunnerControllerOpenId: 'ou_admin',
    });

    expect(await h.run()).toMatchObject({
      status: 403,
      value: { error: 'schedule_mutation_operator_denied' },
    });
    expect(h.scheduler.removeTask).not.toHaveBeenCalled();
  });

  it('rejects a provider controller on a human-authored mutation turn', async () => {
    const h = harness('remove');
    h.record.kind = 'direct';
    h.record.controlOpenId = 'ou_admin';
    h.record.controlUnionId = 'on_admin';
    h.scope.isTrustedHostIpcRequest = () => true;
    h.scope.readJsonBody = async () => ({
      sessionId: 's1',
      originCapability: 'c'.repeat(64),
      originTurnId: 'om_human',
      action: 'remove',
      id: 'a1b2c3d4',
      remoteRunnerSessionTool: true,
      remoteRunnerControllerOpenId: 'ou_admin',
    });

    expect(await h.run()).toMatchObject({
      status: 403,
      value: { error: 'schedule_session_tool_controller_forbidden' },
    });
    expect(h.scheduler.removeTask).not.toHaveBeenCalled();
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
    expect(h.authorizeScheduleSelfManage).toHaveBeenCalledOnce();
    expect(action === 'pause' ? h.scheduler.disableTask : h.scheduler.removeTask)
      .toHaveBeenCalledWith('a1b2c3d4');
  });

  it.each(['pause', 'remove'] as const)('lets a direct scheduled turn %s only itself', async action => {
    const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
    const h = harness(action, turnId, 'self');
    h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    h.record.kind = 'direct';
    h.record.selfManage = false;
    expect(await h.run()).toMatchObject({ status: 200, value: { ok: true } });
    expect(h.authorizeScheduleSelfManage).toHaveBeenCalledOnce();
    expect(action === 'pause' ? h.scheduler.disableTask : h.scheduler.removeTask)
      .toHaveBeenCalledWith('a1b2c3d4');
  });

  it('treats exact self-removal of an already revoked task as an idempotent success', async () => {
    const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
    const h = harness('remove', turnId, 'self');
    h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    h.record.kind = 'direct';
    h.record.state = 'revoked';
    expect(await h.run()).toMatchObject({ status: 200, value: { ok: true, replay: true } });
    expect(h.authorizeScheduleSelfManage).not.toHaveBeenCalled();
    expect(h.scheduler.removeTask).not.toHaveBeenCalled();
  });

  it('does not extend revoked idempotency from remove to pause', async () => {
    const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
    const h = harness('pause', turnId, 'self');
    h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    h.record.kind = 'direct';
    h.record.state = 'revoked';
    h.authorizeScheduleSelfManage.mockRejectedValue(new Error('schedule authority state is revoked'));
    expect(await h.run()).toMatchObject({
      status: 403,
      value: { error: 'schedule_self_manage_denied' },
    });
    expect(h.authorizeScheduleSelfManage).toHaveBeenCalledOnce();
    expect(h.scheduler.disableTask).not.toHaveBeenCalled();
  });

  it('lets the still-live final turn remove a naturally completed direct task', async () => {
    const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
    const h = harness('remove', turnId, 'self');
    h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    h.record.kind = 'direct';
    h.record.state = 'completed';
    h.record.task.enabled = false;
    h.record.task.disabledReason = 'once_completed';
    expect(await h.run()).toMatchObject({ status: 200, value: { ok: true } });
    expect(h.authorizeScheduleSelfManage).toHaveBeenCalledWith(
      h.record,
      expect.objectContaining({ targetChatId: 'oc_chat' }),
    );
    expect(h.scheduler.removeTask).toHaveBeenCalledWith('a1b2c3d4');
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

describe('direct schedule mutation after the active-turn hint is cleared', () => {
  it.each(['pause', 'resume', 'remove', 'update', 'run'])('allows %s for the current human administrator', async action => {
    const h = harness(action);
    h.ds.activeInteractiveTurn = undefined;
    h.ds.session.replyTargets = { om_human: { senderOpenId: 'ou_admin',
      participants: [{ openId: 'ou_admin', isBot: false }] } };
    h.record.kind = 'direct';
    h.record.task.enabled = true;
    expect(await h.run()).toMatchObject({ status: 200, value: { ok: true } });
    const method = { pause: 'disableTask', resume: 'enableTask', remove: 'removeTask',
      update: 'updateTask', run: 'runTaskNow' }[action]!;
    expect(h.scheduler[method as keyof typeof h.scheduler]).toHaveBeenCalledOnce();
  });

  it.each(['bot', 'unknown', 'other-turn', 'non-admin', 'revoked', 'continuation'] as const)(
    'does not authorize mutation from %s metadata', async mode => {
      const turnId = mode === 'continuation' ? 'bmx-continuation-test' : 'om_human';
      const h = harness('pause', turnId);
      h.ds.activeInteractiveTurn = undefined;
      const sender = mode === 'non-admin' ? 'ou_other' : 'ou_admin';
      h.ds.session.ownerOpenId = 'ou_admin';
      h.ds.session.replyTargets = { [mode === 'other-turn' ? 'om_old' : turnId]: {
        senderOpenId: sender, participants: [{ openId: sender,
          isBot: mode === 'bot' ? true : mode === 'unknown' ? undefined : false }],
      } };
      if (mode === 'revoked') h.ds.managedTurnOrigin = undefined;
      expect((await h.run()).status).toBe(403);
      expect(h.scheduler.disableTask).not.toHaveBeenCalled();
    },
  );
});
