import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { authorizeSessionScopedIpc } from '../src/core/daemon-ipc-session-auth.js';
import { scheduleCreateCapabilities } from '../src/core/dispatch-user-delegation.js';
import { DELEGATED_SCHEDULE_REQUIRED_IDENTITY_TOOLS } from '../src/core/schedule-delegated-runtime.js';
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
const code = ts.transpileModule(`const handler = ${handler.getText(source)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function harness(overrides: Record<string, unknown> = {}) {
  const turnId = 'om_kickoff';
  const ds: any = {
    larkAppId: 'cli_target', chatId: 'oc_chat', chatType: 'group', scope: 'thread',
    session: { sessionId: 'target-session', scope: 'thread', rootMessageId: 'om_root' },
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
    pickTurnReplyTarget: () => ({ rootMessageId: 'om_root' }),
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
    DELEGATED_SCHEDULE_REQUIRED_IDENTITY_TOOLS,
    TRIGGER_USER_AUTH_TOOLS,
    scheduleAuthorityStore: {},
    createHash,
    scheduler: { commitDelegatedTask, addTask: vi.fn() },
  };
  const run = new Function('scope', `with (scope) { ${code}; return handler; }`)(scope);
  return { ds, body, scope, commitDelegatedTask, run: () => run({}, {}) };
}

describe('delegated schedule add route', () => {
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
