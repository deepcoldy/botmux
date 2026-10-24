import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { authorizeSessionScopedIpc } from '../src/core/daemon-ipc-session-auth.js';
import { dispatchCallerFromReply, scheduleCreateCapabilities } from '../src/core/dispatch-user-delegation.js';
import { pickTurnReplyTarget, registryTurnMayAuthenticateHuman } from '../src/core/reply-target.js';
import { computeInputHash } from '../src/utils/canonical-input-hash.js';
import { SCHEDULE_DELEGATION_DEFAULT_MAX_TASKS_PER_TURN } from '../src/global-config.js';
import { TRIGGER_USER_AUTH_TOOLS } from '../src/services/trigger-user-auth.js';

const source = ts.createSourceFile(
  'daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true,
);
const route = source.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'ipcRoute'
  && node.expression.arguments[1]?.getText(source) === 'SCHEDULE_DELEGATED_ADD_ROUTE') as ts.ExpressionStatement;
const handler = (route.expression as ts.CallExpression).arguments[2];
const callerHelper = source.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'scheduleCallerForTurn');
const code = ts.transpileModule(`${callerHelper?.getText(source) ?? ''}
const handler = ${handler.getText(source)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function harness(overrides: Record<string, unknown> = {}) {
  const turnId = 'om_kickoff';
  const ds: any = {
    larkAppId: 'cli_target', chatId: 'oc_chat', chatType: 'group', scope: 'thread',
    workingDir: '/repo',
    session: { sessionId: 'target-session', scope: 'thread', rootMessageId: 'om_root',
      replyTargets: { [turnId]: { rootMessageId: 'om_root' } } },
    workerGeneration: 7,
    managedTurnOrigin: { capability: 'c'.repeat(64), turnId },
    activeInteractiveTurn: { turnId, caller: {
      senderType: 'bot', requestLarkAppId: 'cli_target', requestUserOpenId: 'ou_peer_bot',
    } },
  };
  const body: any = {
    sessionId: 'target-session', originCapability: 'c'.repeat(64), originTurnId: turnId,
    task: { id: 'a1b2c3d4', name: 'poll', schedule: 'every 30m', prompt: 'check',
      workingDir: '/repo', chatId: 'oc_chat', rootMessageId: 'om_root',
      executionPosition: 'topic', larkAppId: 'cli_target' },
    ...overrides,
  };
  const commitDelegatedTask = vi.fn(() => ({ ok: true, replay: false,
    task: { ...body.task, enabled: true, createdAt: '2026-09-28T00:00:00.000Z' } }));
  const scope: any = {
    readJsonBody: async () => body,
    findActiveBySessionId: () => ds,
    authorizeSessionScopedIpc,
    isTrustedHostIpcRequest: () => false,
    selfDaemonLarkAppId: 'cli_target',
    jsonRes: (_res: unknown, status: number, value: unknown) => ({ status, value }),
    readGlobalConfig: () => ({ scheduleDelegation: { createEnabled: true } }),
    getBot: () => ({ config: { triggerUserAuth: { enabled: true,
      tools: ['lark-cli', 'bytedcli'] } } }),
    pickTurnReplyTarget, dispatchCallerFromReply, registryTurnMayAuthenticateHuman,
    dispatchUserForTurn: async () => ({
      domain: 'botmux.dispatch-user.v2', deliveryId: 'delivery-1', messageId: turnId,
      sourceSessionId: 'source-session', sourceAppId: 'cli_source', sourceTurnId: 'om_human',
      rootId: 'om_root', chatId: 'oc_chat', targetAppIds: ['cli_target'],
      issuedAt: Date.now(),
      authority: { appId: 'cli_source', openId: 'ou_user_source', unionId: 'on_user', tools: [],
        capabilities: [{ action: 'schedule:create', targetAppId: 'cli_target', targetChatId: 'oc_chat',
          allowedExecutionPositions: ['top-level', 'topic'], allowedRunScopes: [] }] },
    }),
    scheduleCreateCapabilities,
    resolveTargetAppOpenId: async () => ({ status: 'resolved', openId: 'ou_user_target' }),
    getDashboardAdminOpenIds: () => ['ou_user_target'],
    listChatMemberOpenIds: async () => ['ou_user_target'],
    resolveUnionIdFromOpenId: async () => 'on_user',
    computeInputHash,
    SCHEDULE_DELEGATION_DEFAULT_MAX_TASKS_PER_TURN,
    TRIGGER_USER_AUTH_TOOLS,
    scheduleAuthorityStore: {},
    createHash,
    scheduler: { commitDelegatedTask, addTask: vi.fn((task: unknown) => task) },
  };
  const run = new Function('scope', `with (scope) { ${code}; return handler; }`)(scope);
  return { ds, body, scope, commitDelegatedTask, run: () => run({}, {}) };
}

describe('delegated schedule add route', () => {
  it('aligns a Remote Runner bot turn with its provider-selected developer Actor', async () => {
    const h = harness({
      remoteRunnerSessionTool: true,
      remoteRunnerControllerOpenId: 'ou_user_target',
    });
    h.scope.readGlobalConfig = () => ({});
    h.scope.getBot = () => ({ config: {} });
    expect(await h.run()).toMatchObject({
      status: 201,
      value: { task: { ownerOpenId: 'ou_user_target', ownerUnionId: 'on_user' } },
    });
    expect(h.scope.scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({
      ownerOpenId: 'ou_user_target', ownerUnionId: 'on_user',
    }));
    expect(h.commitDelegatedTask).not.toHaveBeenCalled();
  });

  it('rejects a provider-selected Actor outside a frozen Remote Runner relay', async () => {
    const h = harness({ remoteRunnerControllerOpenId: 'ou_user_target' });
    expect(await h.run()).toMatchObject({ status: 400, value: { error: 'invalid_schedule_request' } });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it.each(['human', 'not-admin', 'not-member', 'no-union'] as const)(
    'revalidates a provider-selected Actor: %s', async mode => {
      const h = harness({
        remoteRunnerSessionTool: true,
        remoteRunnerControllerOpenId: 'ou_user_target',
      });
      h.scope.readGlobalConfig = () => ({});
      if (mode === 'human') h.ds.activeInteractiveTurn.caller.senderType = 'user';
      if (mode === 'not-admin') h.scope.getDashboardAdminOpenIds = () => [];
      if (mode === 'not-member') h.scope.listChatMemberOpenIds = async () => [];
      if (mode === 'no-union') h.scope.resolveUnionIdFromOpenId = async () => null;
      const result = await h.run();
      expect(result).toMatchObject({
        status: 403,
        value: { error: mode === 'human'
          ? 'schedule_session_tool_controller_forbidden'
          : 'schedule_delegation_operator_denied' },
      });
      expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
    },
  );

  it('refuses a provider-selected Actor if the worker generation changes during resolution', async () => {
    const h = harness({
      remoteRunnerSessionTool: true,
      remoteRunnerControllerOpenId: 'ou_user_target',
    });
    h.scope.readGlobalConfig = () => ({});
    h.scope.resolveUnionIdFromOpenId = async () => {
      h.ds.workerGeneration++;
      return 'on_user';
    };
    expect(await h.run()).toMatchObject({
      status: 409,
      value: { error: 'schedule_delegation_turn_changed' },
    });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it('redeems an exact single-hop dispatch as one anonymous-run task', async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ status: 201, value: { ok: true, replay: false } });
    expect(h.commitDelegatedTask).toHaveBeenCalledWith(expect.objectContaining({
      grantId: 'dispatch:delivery-1:cli_target',
      sourceMessageId: 'om_kickoff', sourceSessionId: 'source-session',
      targetTurnId: 'om_kickoff', targetGeneration: 7,
      maxTasksPerTurn: SCHEDULE_DELEGATION_DEFAULT_MAX_TASKS_PER_TURN,
      control: { openId: 'ou_user_target', unionId: 'on_user',
        credentialOpenId: 'ou_user_source', runScopes: [], selfManage: false },
      params: expect.objectContaining({ larkAppId: 'cli_target', chatId: 'oc_chat',
        executionPosition: 'topic', rootMessageId: 'om_root' }),
    }));
  });

  it('persists bytedcli run scope and self-management only when target policy supports both', async () => {
    const h = harness();
    h.scope.readGlobalConfig = () => ({ scheduleDelegation: {
      createEnabled: true, runScopes: ['bytedcli'], selfManageEnabled: true,
    } });
    h.scope.dispatchUserForTurn = async () => ({
      domain: 'botmux.dispatch-user.v2', deliveryId: 'delivery-1', messageId: 'om_kickoff',
      sourceSessionId: 'source-session', sourceAppId: 'cli_source', sourceTurnId: 'om_human',
      rootId: 'om_root', chatId: 'oc_chat', targetAppIds: ['cli_target'], issuedAt: Date.now(),
      authority: { appId: 'cli_source', openId: 'ou_user_source', unionId: 'on_user', tools: ['bytedcli'],
        capabilities: [{ action: 'schedule:create', targetAppId: 'cli_target', targetChatId: 'oc_chat',
          allowedExecutionPositions: ['top-level', 'topic'], allowedRunScopes: ['bytedcli'],
          allowSelfManage: true }] },
    });
    expect((await h.run()).status).toBe(201);
    expect(h.commitDelegatedTask).toHaveBeenCalledWith(expect.objectContaining({
      control: {
        openId: 'ou_user_target', unionId: 'on_user', credentialOpenId: 'ou_user_source',
        runScopes: ['bytedcli'], selfManage: true,
      },
    }));
  });

  it('rejects persistent scope when the target does not govern every identity tool', async () => {
    const h = harness();
    h.scope.getBot = () => ({ config: { triggerUserAuth: {
      enabled: true, tools: ['bytedcli'],
    } } });
    expect(await h.run()).toMatchObject({
      status: 403,
      value: { error: 'schedule_delegation_target_identity_isolation_required' },
    });
    expect(h.commitDelegatedTask).not.toHaveBeenCalled();
  });

  it('returns a clear forbidden response when the turn task limit is exhausted', async () => {
    const h = harness();
    h.commitDelegatedTask.mockReturnValue({ ok: false, error: 'grant_task_limit' });
    expect(await h.run()).toEqual({
      status: 403,
      value: { ok: false, error: 'grant_task_limit' },
    });
  });

  it.each([
    [{ executionPosition: 'new-topic' }, 'schedule_delegation_scope_invalid'],
    [{ followActive: true }, 'schedule_delegation_scope_invalid'],
    [{ chatId: 'oc_other' }, 'schedule_delegation_scope_invalid'],
    [{ rootMessageId: 'om_other' }, 'schedule_delegation_root_mismatch'],
  ])('rejects delegated scope expansion %o', async (patch, error) => {
    const h = harness(); Object.assign(h.body.task, patch);
    expect(await h.run()).toMatchObject({ value: { ok: false, error } });
    expect(h.commitDelegatedTask).not.toHaveBeenCalled();
  });

  it('does not accept inherited or v1 tool authority as schedule permission', async () => {
    const h = harness();
    h.scope.dispatchUserForTurn = async () => ({
      domain: 'botmux.dispatch-user.v1', deliveryId: 'd', messageId: 'om_kickoff',
      sourceSessionId: 's', sourceAppId: 'cli_source', sourceTurnId: 'om_human',
      rootId: 'om_root', chatId: 'oc_chat', targetAppIds: ['cli_target'], issuedAt: Date.now(),
      authority: { appId: 'cli_source', openId: 'ou_user', unionId: 'on_user', tools: ['bytedcli'] },
    });
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_delegation_missing' } });
  });

  it('preserves host-terminal creation through HMAC without treating it as delegation', async () => {
    const h = harness({ sessionId: '' });
    h.scope.findActiveBySessionId = () => undefined;
    h.scope.isTrustedHostIpcRequest = () => true;
    h.scope.scheduler.addTask = vi.fn((value: unknown) => value);
    expect(await h.run()).toMatchObject({ status: 201, value: { ok: true } });
    expect(h.scope.scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1b2c3d4', larkAppId: 'cli_target',
    }));
    expect(h.commitDelegatedTask).not.toHaveBeenCalled();
  });
});

function directHumanHarness() {
  const h = harness();
  h.scope.readGlobalConfig = () => ({});
  h.ds.activeInteractiveTurn = undefined;
  h.ds.session.replyTargets.om_kickoff = {
    rootMessageId: 'om_root', senderOpenId: 'ou_user_target',
    participants: [{ openId: 'ou_user_target', isBot: false }],
  };
  h.body.task.executionPosition = 'new-topic';
  delete h.body.task.rootMessageId;
  return h;
}

describe('until-done schedule creation', () => {
  const untilDone = { deadline: '2026-11-20T00:00:00.000Z' };

  it('passes until-done and notify settings from a direct human turn to addTask', async () => {
    const h = directHumanHarness();
    h.body.task.untilDone = untilDone;
    h.body.task.notify = ['failing', 'expired'];
    expect(await h.run()).toMatchObject({ status: 201, value: { ok: true } });
    expect(h.scope.scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({
      untilDone, notify: ['failing', 'expired'], ownerOpenId: 'ou_user_target',
    }));
  });

  it('passes until-done settings from the host terminal to addTask', async () => {
    const h = harness({ sessionId: '' });
    h.scope.findActiveBySessionId = () => undefined;
    h.scope.isTrustedHostIpcRequest = () => true;
    h.body.task.untilDone = { retryMinutes: 360 };
    expect(await h.run()).toMatchObject({ status: 201, value: { ok: true } });
    expect(h.scope.scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({
      untilDone: { retryMinutes: 360 },
    }));
  });

  it.each([
    ['untilDone', untilDone],
    ['notify', ['failing']],
  ] as const)('keeps %s out of a bot-delegated grant', async (field, value) => {
    const h = harness();
    h.body.task[field] = value;
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_delegation_scope_invalid' } });
    expect(h.commitDelegatedTask).not.toHaveBeenCalled();
  });

  it.each([
    ['untilDone', 'tomorrow'],
    ['untilDone', { deadline: 20261120 }],
    ['untilDone', { retryMinutes: '6h' }],
    ['notify', 'failing'],
    ['notify', [1]],
  ] as const)('rejects malformed %s %j before any commit', async (field, value) => {
    const h = directHumanHarness();
    h.body.task[field] = value;
    expect(await h.run()).toMatchObject({ status: 400, value: { error: 'schedule_delegation_scope_invalid' } });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });
});

describe('direct schedule creation after the active-turn hint is cleared', () => {
  it.each(['om_current_topic', 'om_explicit_destination'])('keeps creator notifications in the current topic when executing in %s', async root => {
    const h = directHumanHarness();
    h.ds.scope = h.ds.session.scope = 'chat';
    h.ds.session.rootMessageId = 'om_unrelated_first_message';
    h.ds.session.replyTargets.om_kickoff.rootMessageId = 'om_current_topic';
    h.ds.session.currentReplyTarget = { turnId: 'om_queued', rootMessageId: 'om_queued_topic' };
    h.body.task.executionPosition = 'topic';
    h.body.task.rootMessageId = root;
    expect(await h.run()).toMatchObject({ status: 201, value: { task: {
      rootMessageId: root, creatorRootMessageId: 'om_current_topic',
    } } });
    expect(h.scope.scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({
      rootMessageId: root, creatorRootMessageId: 'om_current_topic',
    }));
  });

  it.each(['thread', 'chat'] as const)('uses the exact human sender in %s scope with delegation disabled', async scope => {
    const h = directHumanHarness();
    h.ds.scope = h.ds.session.scope = scope;
    expect(await h.run()).toMatchObject({ status: 201, value: { task: {
      ownerOpenId: 'ou_user_target', ownerUnionId: 'on_user', executionPosition: 'new-topic',
    } } });
    expect(h.scope.scheduler.addTask).toHaveBeenCalledOnce();
    expect(h.commitDelegatedTask).not.toHaveBeenCalled();
    expect(h.ds.activeInteractiveTurn).toBeUndefined();
  });

  it('keeps the authenticated active caller authoritative', async () => {
    const h = directHumanHarness();
    h.ds.activeInteractiveTurn = { turnId: 'om_kickoff', caller: {
      senderType: 'user', requestLarkAppId: 'cli_target', requestUserOpenId: 'ou_user_target',
      requestUserUnionId: 'on_active_user',
    } };
    h.ds.session.replyTargets = {};
    expect(await h.run()).toMatchObject({ status: 201, value: { task: { ownerUnionId: 'on_active_user' } } });
  });

  it('accepts a Remote Runner session tool only inside its frozen chat, root, and working directory', async () => {
    const h = directHumanHarness();
    h.body.remoteRunnerSessionTool = true;
    h.body.task.executionPosition = 'topic';
    h.body.task.rootMessageId = 'om_root';
    expect(await h.run()).toMatchObject({ status: 201, value: { task: {
      chatId: 'oc_chat', rootMessageId: 'om_root', workingDir: '/repo',
    } } });
  });

  it.each([
    [{ chatId: 'oc_other' }, 'schedule_session_tool_scope_invalid'],
    [{ workingDir: '/tmp/evil' }, 'schedule_session_tool_scope_invalid'],
    [{ rootMessageId: 'om_other' }, 'schedule_session_tool_root_mismatch'],
  ])('rejects Remote Runner direct scope expansion %o', async (patch, error) => {
    const h = directHumanHarness();
    h.body.remoteRunnerSessionTool = true;
    h.body.task.executionPosition = 'topic';
    h.body.task.rootMessageId = 'om_root';
    Object.assign(h.body.task, patch);
    expect(await h.run()).toMatchObject({ status: 403, value: { error } });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it('rejects a Remote Runner root outside topic execution', async () => {
    const h = directHumanHarness();
    h.body.remoteRunnerSessionTool = true;
    h.body.task.rootMessageId = 'om_root';
    expect(await h.run()).toMatchObject({
      status: 400,
      value: { error: 'schedule_session_tool_root_forbidden' },
    });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it.each([
    { senderType: 'bot', requestLarkAppId: 'cli_target' },
    { senderType: 'user', requestLarkAppId: 'cli_other' },
    { senderType: 'user', requestLarkAppId: 'cli_target', source: 'schedule_creator' },
  ])('does not override a non-direct active caller: %o', async caller => {
    const h = directHumanHarness();
    h.ds.activeInteractiveTurn = { turnId: 'om_kickoff', caller };
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_delegation_disabled' } });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it.each([true, undefined])('does not treat isBot=%s as a human', async isBot => {
    const h = directHumanHarness();
    h.ds.session.replyTargets.om_kickoff.participants[0].isBot = isBot;
    expect((await h.run()).status).toBe(403);
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it('does not borrow another turn, session owner, or client-supplied creator', async () => {
    const h = directHumanHarness();
    const reply = h.ds.session.replyTargets.om_kickoff;
    h.ds.session.replyTargets = { om_old: reply };
    h.ds.session.currentReplyTarget = { ...reply, turnId: 'om_old' };
    h.ds.session.ownerOpenId = 'ou_user_target';
    h.ds.session.ownerUnionId = 'on_user';
    h.ds.activeInteractiveTurn = { turnId: 'om_old', caller: {
      senderType: 'user', requestLarkAppId: 'cli_target', requestUserOpenId: 'ou_user_target',
    } };
    Object.assign(h.body.task, { ownerOpenId: 'ou_user_target', ownerUnionId: 'on_user' });
    expect((await h.run()).status).toBe(403);
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it.each(['schedule:a1b2c3d4:run', 'bmx-continuation-test'])('rejects copied reply metadata for synthetic turn %s', async turnId => {
    const h = directHumanHarness();
    h.ds.session.replyTargets[turnId] = h.ds.session.replyTargets.om_kickoff;
    h.ds.managedTurnOrigin.turnId = h.body.originTurnId = turnId;
    expect((await h.run()).status).toBe(403);
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'stale-capability'] as const)('requires a live exact origin: %s', async mode => {
    const h = directHumanHarness();
    if (mode === 'revoked') h.ds.managedTurnOrigin = undefined;
    if (mode === 'stale-capability') h.body.originCapability = 'd'.repeat(64);
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_delegation_origin_unproven' } });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it.each(['not-admin', 'not-member', 'no-union'] as const)('preserves the operator check: %s', async mode => {
    const h = directHumanHarness();
    if (mode === 'not-admin') h.scope.getDashboardAdminOpenIds = () => [];
    if (mode === 'not-member') h.scope.listChatMemberOpenIds = async () => [];
    if (mode === 'no-union') h.scope.resolveUnionIdFromOpenId = async () => null;
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_delegation_operator_denied' } });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it.each(['turn', 'worker', 'capability'] as const)('refuses commit if %s changes during identity lookup', async mode => {
    const h = directHumanHarness();
    h.scope.resolveUnionIdFromOpenId = async () => {
      if (mode === 'turn') h.ds.managedTurnOrigin.turnId = 'om_next';
      if (mode === 'worker') h.ds.workerGeneration++;
      if (mode === 'capability') h.ds.managedTurnOrigin.capability = 'd'.repeat(64);
      return 'on_user';
    };
    expect(await h.run()).toMatchObject({ status: 409, value: { error: 'schedule_delegation_turn_changed' } });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });
});

describe('auto-start-on-join first turn (join_ synthetic id)', () => {
  const JOIN_TURN_ID = 'join_9f2b1caa-0000-4000-8000-000000000000';
  function joinHarness() {
    const h = directHumanHarness();
    h.ds.managedTurnOrigin.turnId = h.body.originTurnId = JOIN_TURN_ID;
    // The registry entry handleBotAdded writes at session birth: the operator
    // who added the bot, with the mention-safe incomplete window marker.
    h.ds.session.replyTargets = {
      [JOIN_TURN_ID]: {
        senderOpenId: 'ou_user_target',
        participants: [{ openId: 'ou_user_target', isBot: false }],
        participantsIncomplete: true,
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
    };
    return h;
  }

  it('resolves the operator who added the bot as the direct human creator', async () => {
    const h = joinHarness();
    expect(await h.run()).toMatchObject({ status: 201, value: { task: {
      ownerOpenId: 'ou_user_target', ownerUnionId: 'on_user',
    } } });
    expect(h.scope.scheduler.addTask).toHaveBeenCalledOnce();
    expect(h.commitDelegatedTask).not.toHaveBeenCalled();
  });

  it('still fails closed when the join turn entry carries no human sender', async () => {
    const h = joinHarness();
    h.ds.session.replyTargets = { [JOIN_TURN_ID]: { updatedAt: '2026-10-19T00:00:00.000Z' } };
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_delegation_disabled' } });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });

  it.each(['bmx-recovery-123', 'schedule:a1b2c3d4:run'])('keeps other synthetic prefixes excluded: %s', async turnId => {
    const h = joinHarness();
    h.ds.session.replyTargets[turnId] = h.ds.session.replyTargets[JOIN_TURN_ID];
    h.ds.managedTurnOrigin.turnId = h.body.originTurnId = turnId;
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_delegation_disabled' } });
    expect(h.scope.scheduler.addTask).not.toHaveBeenCalled();
  });
});

// Exercise the production IPC cases as well as the production route. External
// side effects are stubbed; no live worker or daemon is started by this test.
it('creates after same-turn revoke/republication without reviving the busy hint', async () => {
  const source = ts.createSourceFile('worker-pool.ts', readFileSync('src/core/worker-pool.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const cases: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)
      && ['managed_turn_origin', 'managed_turn_origin_revoked'].includes(node.expression.text)) {
      cases.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(cases).toHaveLength(2);
  const ipcCode = ts.transpileModule(`switch (msg.type) { ${cases.join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const h = directHumanHarness();
  const worker = {};
  h.ds.worker = worker;
  h.ds.activeInteractiveTurn = { turnId: 'om_kickoff', caller: {
    senderType: 'user', requestLarkAppId: 'cli_target', requestUserOpenId: 'ou_user_target',
  } };
  const scope = { ds: h.ds, worker, t: 'test', botCfg: {}, randomBytes,
    logger: { warn: vi.fn(), error: vi.fn() },
    currentGatewayCallerOpenId: (ds: any, turnId: string) => pickTurnReplyTarget(ds.session, turnId)?.senderOpenId,
    currentTurnProcessIdentities: () => undefined,
    noteTurnDispatchAttempt: vi.fn(), ensureAutomaticTaskContinuationLease: vi.fn(),
  };
  const dispatch = new Function('scope', 'msg', `with (scope) { ${ipcCode} }`);
  dispatch(scope, { type: 'managed_turn_origin_revoked', sessionId: 'target-session',
    turnId: 'om_kickoff', capability: 'c'.repeat(64) });
  expect(h.ds.activeInteractiveTurn).toBeUndefined();
  expect((await h.run()).status).toBe(403);
  dispatch(scope, { type: 'managed_turn_origin', sessionId: 'target-session',
    turnId: 'om_kickoff', capability: 'd'.repeat(64) });
  h.body.originCapability = 'd'.repeat(64);
  expect(h.ds.managedTurnOrigin.callerOpenId).toBe('ou_user_target');
  expect(await h.run()).toMatchObject({ status: 201, value: { task: {
    ownerOpenId: 'ou_user_target', ownerUnionId: 'on_user', executionPosition: 'new-topic',
  } } });
  expect(h.ds.activeInteractiveTurn).toBeUndefined();
  expect(h.scope.scheduler.addTask).toHaveBeenCalledOnce();
});
