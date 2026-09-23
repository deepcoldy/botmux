/** Executes the production IPC handler with platform/network seams replaced. */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorityForDispatch, dispatchCallerFromReply, deliverDispatchWithUser, resolveDispatchUser } from '../src/core/dispatch-user-delegation.js';
import { authorizeSessionScopedIpc } from '../src/core/daemon-ipc-session-auth.js';

const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const route = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'ipcRoute'
  && node.expression.arguments[1]?.getText(source) === 'DISPATCH_USER_DELIVERY_ROUTE') as ts.ExpressionStatement;
const handler = (route.expression as ts.CallExpression).arguments[2];
const code = ts.transpileModule('const handler = ' + handler.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const secret = 'test-host-secret';
let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'dispatch-ipc-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

function harness(overrides: Record<string, unknown> = {}, isHost = false) {
  const ds: any = { larkAppId: 'cli_source', chatId: 'oc_source', session: { sessionId: 'source-session' },
    managedTurnOrigin: { capability: 'c'.repeat(64), turnId: 'om_human', dispatchAttempt: 1 },
    activeInteractiveTurn: { turnId: 'om_human', caller: {
      senderType: 'user', requestLarkAppId: 'cli_source', requestUserOpenId: 'ou_alice', requestUserUnionId: 'on_alice',
    } },
  };
  const body = { sessionId: 'source-session', originCapability: 'c'.repeat(64), originTurnId: 'om_human',
    rootId: 'om_root', chatId: 'oc_target', content: '{"zh_cn":{"content":[]}}', targetAppIds: ['cli_target'], ...overrides };
  const send = vi.fn(async () => 'om_kickoff');
  const resolveUnionIdFromOpenId = vi.fn(async () => 'on_alice');
  const scope: any = {
    readJsonBody: async () => body, DISPATCH_REPORT_REGISTER_MAX_BYTES: 65536,
    findActiveBySessionId: (id: string) => id === ds.session.sessionId ? ds : undefined,
    authorizeSessionScopedIpc, isTrustedHostIpcRequest: () => isHost, selfDaemonLarkAppId: 'cli_source',
    jsonRes: (_res: unknown, status: number, value: any) => ({ status, value }),
    getMessageChatId: vi.fn(async () => 'oc_target'), readGroupCollaborationMode: () => undefined,
    evaluateProjectDispatchPolicy: vi.fn(() => ({ ok: true })),
    getBot: () => ({ config: { triggerUserAuth: { enabled: true, tools: ['bytedcli'] } } }),
    dispatchUserForTurn: vi.fn(async () => undefined),
    targetUserForDelegation: vi.fn(async () => 'ou_alice_target'),
    authorityForDispatch, dispatchCallerFromReply, pickTurnReplyTarget: () => undefined,
    resolveUnionIdFromOpenId, replyMessage: send, deliverDispatchWithUser,
    config: { session: { dataDir } }, loadOrCreateDashboardSecret: () => secret, dispatchReportBindingSecretPath: () => '',
  };
  const run = new Function('scope', 'with (scope) { ' + code + '; return handler; }')(scope);
  return { ds, scope, send, run: () => run({}, {}) };
}
const read = () => resolveDispatchUser({ dataDir, secret, appId: 'cli_target', chatId: 'oc_target', rootId: 'om_root', turnId: 'om_kickoff', waitMs: 0 });

describe('dispatch user IPC end-to-end identity binding', () => {
  it.each([false, true])('ignores claimed user identity and binds the actual sent message (host=%s)', async host => {
    const h = harness({ user: 'mallory', requested_by: 'mallory', authority: { openId: 'ou_mallory' }, sourceTurnId: 'forged' }, host);
    expect(await h.run()).toEqual({ status: 200, value: { ok: true, messageId: 'om_kickoff' } });
    expect((await read())?.authority.openId).toBe('ou_alice');
    expect((await read())?.sourceTurnId).toBe('om_human');
    expect(h.send).toHaveBeenCalledExactlyOnceWith('cli_source', 'om_root', expect.any(String), 'post', true);
  });
  it('rejects a stale capability before any message or identity write', async () => {
    const h = harness({ originCapability: 'stale' });
    expect((await h.run()).status).toBe(403);
    expect(h.send).not.toHaveBeenCalled();
    expect(await read()).toBeUndefined();
  });
  it('rejects routing a root into a different chat', async () => {
    const h = harness({ chatId: 'oc_wrong' });
    expect((await h.run()).status).toBe(403);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('does not acquire a human identity from an ordinary peer-bot turn', async () => {
    const h = harness(); h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    expect((await h.run()).status).toBe(200);
    expect(await read()).toBeUndefined();
  });
  it('refuses sending after the active turn changes during identity resolution', async () => {
    const h = harness(); delete h.ds.activeInteractiveTurn.caller.requestUserUnionId;
    h.scope.resolveUnionIdFromOpenId = async () => { h.ds.managedTurnOrigin.turnId = 'om_bob'; return 'on_alice'; };
    expect((await h.run()).status).toBe(409);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('unknown cross-app identity fails before sending a task', async () => {
    const h = harness(); delete h.ds.activeInteractiveTurn.caller.requestUserUnionId;
    h.scope.resolveUnionIdFromOpenId = async () => null;
    expect((await h.run()).status).toBe(502);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('nested dispatch preserves the verified origin and does not adopt the peer identity', async () => {
    const h = harness(); h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    h.scope.dispatchUserForTurn = async () => ({ authority: {
      appId: 'cli_origin', openId: 'ou_original', unionId: 'on_original', tools: ['bytedcli'],
    } });
    expect((await h.run()).status).toBe(200);
    expect((await read())?.authority.openId).toBe('ou_original');
  });
});
