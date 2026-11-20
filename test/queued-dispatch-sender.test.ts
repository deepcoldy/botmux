import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { beginReplyTargetTurn, pickTurnReplyTarget } from '../src/core/reply-target.js';
import { authorityForDispatch, dispatchCallerFromReply, resolveDispatchSenderUnionId } from '../src/core/dispatch-user-delegation.js';

// Execute the production queue handler without starting its daemon. The real
// reply registry and identity resolver remain; platform I/O and worker admission
// are the test's controlled seams.
const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'submitQueuedMessage');
if (!declaration) throw new Error('missing queue handler');
const code = ts.transpileModule(declaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
function fixture(options: { sender?: 'user' | 'bot'; accept?: boolean; replace?: boolean } = {}) {
  const ds: any = { larkAppId: 'cli_source', chatId: 'oc_chat', scope: 'thread', worker: { killed: false },
    session: { sessionId: 'queue-session', rootMessageId: 'om_topic', chatId: 'oc_chat',
      workerGeneration: 1, cliSessionId: 'native-thread' } };
  const message: any = { messageId: 'om_queued', senderId: 'ou_alice', senderType: options.sender ?? 'user',
    rootId: 'om_topic', threadId: 'omt_thread', mentions: [] };
  const scope = {
    activeSessions: new Map([['queue-session', ds]]), activeSessionKey: () => 'queue-session',
    config: { session: { dataDir: '/unused' } }, isKnownPeerBot: () => false,
    senderIsBotTriState: (type: string) => type === 'bot',
    resolveSender: async () => ({ openId: message.senderId }),
    getBot: () => ({ botName: 'source', botOpenId: 'ou_bot' }),
    buildFollowUpCliInput: () => 'queued input', sessionPromptInjection: () => undefined,
    beginReplyTargetTurn,
    noteTurnReceived: async () => { if (options.replace) ds.session.workerGeneration = 2; },
    trustedCallerForInboundTurn: async () => ({ senderType: message.senderType,
      requestLarkAppId: 'cli_source', requestUserOpenId: 'ou_alice' }),
    sendWorkerInput: () => options.accept !== false,
    beginNewTurn: () => {}, rememberLastCliInput: () => {}, markSessionActivity: () => {},
    sessionStore: { updateSession: vi.fn() },
  };
  const submit = new Function('scope', `with(scope) { ${code}; return submitQueuedMessage; }`)(scope);
  return { ds, message, submit: () => submit(ds, message, 'queued task', { mode: 'thread', rootMessageId: 'om_topic' }) };
}
describe('/queue preserves the exact dispatch sender', () => {
  it('recovers the queued human after the active caller is gone and Contact is unavailable', async () => {
    const f = fixture();
    expect(await f.submit()).toBe(true);
    const restored = JSON.parse(JSON.stringify(f.ds.session));
    const fromMessage = vi.fn(async () => 'on_from_message');
    const fromContact = vi.fn(async () => null);
    const authority = await authorityForDispatch({
      caller: dispatchCallerFromReply('cli_source', pickTurnReplyTarget(restored, 'om_queued')),
      sourceAppId: 'cli_source', tools: ['bytedcli'],
      resolveUnionId: (app, openId) => resolveDispatchSenderUnionId(
        restored, 'om_queued', app, openId, fromMessage, fromContact),
    });
    expect(authority).toMatchObject({ openId: 'ou_alice', unionId: 'on_from_message' });
    expect(fromMessage).toHaveBeenCalledExactlyOnceWith('cli_source', 'om_queued');
    expect(fromContact).not.toHaveBeenCalled();
  });
  it.each([{ accept: false }, { replace: true }])('removes queued sender evidence after rejection or replacement', async options => {
    const f = fixture(options);
    expect(await f.submit()).toBe(false);
    expect(f.ds.session.replyTargets?.om_queued).toBeUndefined();
    expect(f.ds.session.turnReplyContexts?.om_queued).toBeUndefined();
    expect(dispatchCallerFromReply('cli_source', pickTurnReplyTarget(f.ds.session, 'om_queued'))).toBeUndefined();
  });
  it('does not turn a queued bot into a human delegate', async () => {
    const f = fixture({ sender: 'bot' });
    expect(await f.submit()).toBe(true);
    const resolveUnionId = vi.fn(async () => 'on_should_not_use');
    expect(await authorityForDispatch({
      caller: dispatchCallerFromReply('cli_source', pickTurnReplyTarget(f.ds.session, 'om_queued')),
      sourceAppId: 'cli_source', tools: ['bytedcli'], resolveUnionId,
    })).toBeUndefined();
    expect(resolveUnionId).not.toHaveBeenCalled();
  });
});
