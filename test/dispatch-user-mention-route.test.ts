/**
 * `botmux send --mention <bot on this machine>` handoff (D2): the production
 * prepare/bind IPC handlers, executed with platform/network seams replaced,
 * and the receiving side resolving the signed record they leave behind.
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorityForDispatch, dispatchCallerFromReply, resolveDispatchUser, registerPendingDispatchUser,
  readPendingDispatchUser, bindPendingDispatchUser, dropPendingDispatchUser, handoffMessageMatches, readHandoffMessage,
  dispatchUserStorePath,
} from '../src/core/dispatch-user-delegation.js';
import { authorizeSessionScopedIpc } from '../src/core/daemon-ipc-session-auth.js';
import { delegatesOnMention } from '../src/services/trigger-user-auth.js';

const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function routeHandler(routeConstant: string): string {
  const route = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'ipcRoute'
    && node.expression.arguments[1]?.getText(source) === routeConstant) as ts.ExpressionStatement | undefined;
  if (!route) throw new Error('Missing production route ' + routeConstant);
  return (route.expression as ts.CallExpression).arguments[2].getText(source);
}
const authorizer = source.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'authorizeMentionHandoffRequest');
if (!authorizer) throw new Error('Missing authorizeMentionHandoffRequest');
const code = ts.transpileModule([
  authorizer.getText(source),
  'const prepare = ' + routeHandler('DISPATCH_USER_MENTION_PREPARE_ROUTE'),
  'const bind = ' + routeHandler('DISPATCH_USER_MENTION_BIND_ROUTE'),
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

const secret = 'test-host-secret';
const CAP = 'c'.repeat(64);
let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'mention-handoff-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

const human = { senderType: 'user', requestLarkAppId: 'cli_source', requestUserOpenId: 'ou_alice', requestUserUnionId: 'on_alice' };
function harness(options: {
  triggerUserAuth?: unknown;
  caller?: unknown;
  localBots?: string[];
  messageDetail?: unknown;
  /** Provider failures before the message becomes readable. */
  readFailures?: number;
  /** This bot and the turn it is in (default: cli_source, a turn sent by a human). */
  appId?: string;
  turnId?: string;
  /** Whether the delegated human still passes this chat's access checks. */
  delegatedUserAllowed?: boolean;
} = {}) {
  const appId = options.appId ?? 'cli_source';
  const turnId = options.turnId ?? 'om_human';
  const ds: any = { larkAppId: appId, chatId: 'oc_chat', session: { sessionId: 'source-session' },
    managedTurnOrigin: { capability: CAP, turnId, dispatchAttempt: 1 },
    activeInteractiveTurn: { turnId, caller: options.caller ?? human },
  };
  let body: any = {};
  let readFailures = options.readFailures ?? 0;
  const getMessageDetail = vi.fn(async (_app: string, messageId: string) => {
    if (readFailures-- > 0) throw new Error('get message: 230002 message not found');
    return options.messageDetail ?? {
      items: [{ message_id: messageId, chat_id: 'oc_chat', create_time: String(Date.now()),
        sender: { id: appId, id_type: 'app_id', sender_type: 'app' } }],
    };
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const scope: any = {
    readJsonBody: async () => body,
    findActiveBySessionId: (id: string) => id === ds.session.sessionId ? ds : undefined,
    authorizeSessionScopedIpc, isTrustedHostIpcRequest: () => false, selfDaemonLarkAppId: appId,
    jsonRes: (_res: unknown, status: number, value: any) => ({ status, value }),
    // The daemon's own lookup of a delegation already bound to this turn's message.
    dispatchUserForTurn: (session: any, turn: string) => resolveDispatchUser({
      dataDir, secret, appId: session.larkAppId, chatId: session.chatId, turnId: turn, waitMs: 0 }),
    targetUserForDelegation: vi.fn(async (_session: unknown, user: any) =>
      options.delegatedUserAllowed === false ? undefined : user.openId),
    getBot: () => ({ config: { larkAppId: appId,
      triggerUserAuth: 'triggerUserAuth' in options ? options.triggerUserAuth : { enabled: true, tools: ['bytedcli'] } } }),
    delegatesOnMention,
    loadBotConfigsCached: () => (options.localBots ?? ['cli_source', 'cli_target', 'cli_third']).map(larkAppId => ({ larkAppId })),
    authorityForDispatch, dispatchCallerFromReply, pickTurnReplyTarget: () => undefined,
    resolveUnionIdFromOpenId: vi.fn(async () => 'on_alice'),
    registerPendingDispatchUser, readPendingDispatchUser, bindPendingDispatchUser, dropPendingDispatchUser,
    handoffMessageMatches, readHandoffMessage, getMessageDetail,
    config: { session: { dataDir } }, loadOrCreateDispatchReportBindingSecret: () => secret, logger,
  };
  const routes = new Function('scope', 'with (scope) { ' + code + '; return { prepare, bind }; }')(scope);
  const call = (handler: (req: unknown, res: unknown) => Promise<any>, next: Record<string, unknown>) => {
    body = { sessionId: 'source-session', originCapability: CAP, originTurnId: turnId, originDispatchAttempt: 1, ...next };
    return handler({}, {});
  };
  return {
    ds, scope, logger, getMessageDetail,
    prepare: (next: Record<string, unknown> = {}) => call(routes.prepare, { chatId: 'oc_chat', targetAppIds: ['cli_target'], ...next }),
    bind: (next: Record<string, unknown>) => call(routes.bind, next),
  };
}
const receive = (input: { turnId?: string; rootId?: string; appId?: string; chatId?: string } = {}) => resolveDispatchUser({
  dataDir, secret, appId: input.appId ?? 'cli_target', chatId: input.chatId ?? 'oc_chat',
  turnId: input.turnId ?? 'om_handoff', waitMs: 0, ...(input.rootId ? { rootId: input.rootId } : {}),
});
const store = () => JSON.parse(readFileSync(dispatchUserStorePath(dataDir), 'utf8'));

describe('mention handoff: prepare', () => {
  it('signs the direct human of this turn for the local target bot', async () => {
    const h = harness();
    const prepared = await h.prepare();
    expect(prepared).toMatchObject({ status: 200, value: { ok: true, delegated: true, targetAppIds: ['cli_target'] } });
    const pending = readPendingDispatchUser(dataDir, secret, prepared.value.deliveryId)!;
    expect(pending).toMatchObject({
      sourceAppId: 'cli_source', sourceSessionId: 'source-session', sourceTurnId: 'om_human', chatId: 'oc_chat',
      targetAppIds: ['cli_target'],
      authority: { appId: 'cli_source', openId: 'ou_alice', unionId: 'on_alice', tools: ['bytedcli'] },
    });
    expect(pending.rootId).toBeUndefined();
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('[dispatch-user:audit] mention-prepare'));
  });

  it.each([
    ['delegateOnMention is off', { triggerUserAuth: { enabled: true, tools: ['bytedcli'], delegateOnMention: false } }, {}, 'delegate_on_mention_off'],
    ['trigger-user auth is off', { triggerUserAuth: undefined }, {}, 'delegate_on_mention_off'],
    ['the turn came from a bot', { caller: { senderType: 'bot', requestLarkAppId: 'cli_source', requestUserOpenId: 'ou_bot' } }, {}, 'no_direct_human'],
    ['the turn is a scheduled fire', { caller: { ...human, source: 'schedule_creator', taskId: 't1' } }, {}, 'no_direct_human'],
    ['the target bot is not on this machine', { localBots: ['cli_source'] }, {}, 'no_local_bot'],
    ['the only target is this bot', {}, { targetAppIds: ['cli_source'] }, 'no_local_bot'],
    ['the message goes to another chat', {}, { chatId: 'oc_other' }, 'other_chat'],
  ])('signs nothing when %s', async (_label, options, next, reason) => {
    const h = harness(options as any);
    expect(await h.prepare(next)).toEqual({ status: 200, value: { ok: true, delegated: false, reason } });
    expect(() => store()).toThrow();
  });

  it('logs why a handoff carried no sender', async () => {
    const h = harness({ caller: { senderType: 'bot', requestLarkAppId: 'cli_source', requestUserOpenId: 'ou_bot' } });
    await h.prepare();
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('mention-prepare skipped source=cli_source chat=oc_chat reason=no_direct_human'));
  });

  it('refuses a caller that cannot prove the live turn', async () => {
    const h = harness();
    expect(await h.prepare({ originCapability: 'd'.repeat(64) })).toMatchObject({ status: 403 });
  });
});

describe('mention handoff: a delegated turn hands the same person on', () => {
  const peerBot = { senderType: 'bot', requestLarkAppId: 'cli_target', requestUserOpenId: 'ou_source_bot' };
  // Hop 1: a human asks cli_source, which @-mentions cli_target in om_handoff.
  async function firstHop(tools = ['bytedcli']) {
    const h = harness({ triggerUserAuth: { enabled: true, tools } });
    const { value: { deliveryId } } = await h.prepare();
    await h.bind({ deliveryId, messageId: 'om_handoff' });
  }

  it('re-signs the inherited sender when the delegated bot @-mentions the next one', async () => {
    await firstHop();
    // Hop 2: cli_target, in the turn started by om_handoff (sent by a bot), @-mentions cli_third.
    const h = harness({ appId: 'cli_target', turnId: 'om_handoff', caller: peerBot,
      triggerUserAuth: { enabled: true, tools: ['bytedcli', 'lark-cli'] } });
    const prepared = await h.prepare({ targetAppIds: ['cli_third'] });
    expect(prepared).toMatchObject({ status: 200, value: { ok: true, delegated: true, targetAppIds: ['cli_third'] } });
    // Same person, issued by the original app, never widened beyond the inherited tools.
    expect(readPendingDispatchUser(dataDir, secret, prepared.value.deliveryId)).toMatchObject({
      sourceAppId: 'cli_target', sourceTurnId: 'om_handoff', targetAppIds: ['cli_third'],
      authority: { appId: 'cli_source', openId: 'ou_alice', unionId: 'on_alice', tools: ['bytedcli'] },
    });
    expect(await h.bind({ deliveryId: prepared.value.deliveryId, messageId: 'om_handoff_2' }))
      .toEqual({ status: 200, value: { ok: true, bound: true } });
    expect((await receive({ appId: 'cli_third', turnId: 'om_handoff_2' }))?.authority)
      .toMatchObject({ openId: 'ou_alice', tools: ['bytedcli'] });
  });

  it('signs nothing when the inherited person no longer passes this chat\'s checks', async () => {
    await firstHop();
    const h = harness({ appId: 'cli_target', turnId: 'om_handoff', caller: peerBot, delegatedUserAllowed: false });
    expect(await h.prepare({ targetAppIds: ['cli_third'] }))
      .toEqual({ status: 200, value: { ok: true, delegated: false, reason: 'delegated_caller_not_allowed' } });
  });

  it('signs nothing when this bot shares no tool with the inherited delegation', async () => {
    await firstHop(['bytedcli']);
    const h = harness({ appId: 'cli_target', turnId: 'om_handoff', caller: peerBot,
      triggerUserAuth: { enabled: true, tools: ['lark-cli'] } });
    expect(await h.prepare({ targetAppIds: ['cli_third'] }))
      .toEqual({ status: 200, value: { ok: true, delegated: false, reason: 'no_shared_tool' } });
  });

  it('a bot turn whose message carries no delegation still hands on nobody', async () => {
    await firstHop();
    const h = harness({ appId: 'cli_target', turnId: 'om_unrelated', caller: peerBot });
    expect(await h.prepare({ targetAppIds: ['cli_third'] }))
      .toEqual({ status: 200, value: { ok: true, delegated: false, reason: 'no_direct_human' } });
  });
});

describe('mention handoff: bind', () => {
  it('binds to the exact message this bot posted, which the receiver then resolves wherever it landed', async () => {
    const h = harness();
    const { value: { deliveryId } } = await h.prepare();
    expect(await h.bind({ deliveryId, messageId: 'om_handoff' })).toEqual({ status: 200, value: { ok: true, bound: true } });
    expect(h.getMessageDetail).toHaveBeenCalledWith('cli_source', 'om_handoff', { userCardContent: false });
    // A regular group (no thread), a quote reply and a thread reply all resolve the exact message.
    for (const rootId of [undefined, 'om_quoted', 'om_thread_root']) {
      expect((await receive({ rootId }))?.authority).toMatchObject({ openId: 'ou_alice', unionId: 'on_alice', tools: ['bytedcli'] });
    }
    // Not another message, another chat, or a bot it was not addressed to.
    expect(await receive({ turnId: 'om_other' })).toBeUndefined();
    expect(await receive({ chatId: 'oc_other' })).toBeUndefined();
    expect(await receive({ appId: 'cli_bystander' })).toBeUndefined();
    expect(Object.keys(store()).filter(key => key.startsWith('pending:'))).toEqual([]);
  });

  it('accepts its own card that Lark stamps as a bot message', async () => {
    const h = harness({ messageDetail: { items: [{ message_id: 'om_handoff', chat_id: 'oc_chat',
      create_time: String(Date.now()), sender: { id: 'cli_source', id_type: 'app_id', sender_type: 'bot' } }] } });
    const { value: { deliveryId } } = await h.prepare();
    expect(await h.bind({ deliveryId, messageId: 'om_handoff' })).toEqual({ status: 200, value: { ok: true, bound: true } });
    expect(await receive()).toBeDefined();
  });

  it('retries a message that is not readable yet right after the send', async () => {
    const h = harness({ readFailures: 2 });
    const { value: { deliveryId } } = await h.prepare();
    expect(await h.bind({ deliveryId, messageId: 'om_handoff' })).toEqual({ status: 200, value: { ok: true, bound: true } });
    expect(h.getMessageDetail).toHaveBeenCalledTimes(3);
    expect(await receive()).toBeDefined();
  });

  it('gives up and withdraws the registration when the message stays unreadable', async () => {
    const h = harness({ readFailures: 3 });
    const { value: { deliveryId } } = await h.prepare();
    expect(await h.bind({ deliveryId, messageId: 'om_handoff' })).toMatchObject({ status: 502, value: { error: 'handoff_bind_failed' } });
    expect(h.getMessageDetail).toHaveBeenCalledTimes(3);
    expect(readPendingDispatchUser(dataDir, secret, deliveryId)).toBeUndefined();
    expect(await receive()).toBeUndefined();
  });

  it.each([
    ['another sender', { sender: { id: 'cli_other_bot', sender_type: 'app' } }],
    ['another bot stamped as a bot message', { sender: { id: 'cli_other_bot', id_type: 'app_id', sender_type: 'bot' } }],
    ['an id that is not an app id', { sender: { id: 'cli_source', id_type: 'open_id', sender_type: 'bot' } }],
    ['a sender that is not a bot at all', { sender: { id: 'cli_source', id_type: 'app_id', sender_type: 'user' } }],
    ['a human sender', { sender: { id: 'ou_someone', sender_type: 'user' } }],
    ['another chat', { chat_id: 'oc_other' }],
    ['a message older than the registration', { create_time: String(Date.now() - 10 * 60_000) }],
  ])('refuses and withdraws the registration for a message from %s', async (_label, patch) => {
    const h = harness({
      messageDetail: { items: [{ message_id: 'om_handoff', chat_id: 'oc_chat', create_time: String(Date.now()),
        sender: { id: 'cli_source', sender_type: 'app' }, ...patch }] },
    });
    const { value: { deliveryId } } = await h.prepare();
    expect(await h.bind({ deliveryId, messageId: 'om_handoff' })).toMatchObject({ status: 403, value: { error: 'handoff_message_mismatch' } });
    expect(await receive()).toBeUndefined();
    expect(readPendingDispatchUser(dataDir, secret, deliveryId)).toBeUndefined();
  });

  it('withdraws the registration when the send failed', async () => {
    const h = harness();
    const { value: { deliveryId } } = await h.prepare();
    expect(await h.bind({ deliveryId })).toEqual({ status: 200, value: { ok: true, bound: false } });
    expect(readPendingDispatchUser(dataDir, secret, deliveryId)).toBeUndefined();
  });

  it('never binds a registration made by another session', async () => {
    const h = harness();
    const { value: { deliveryId } } = await h.prepare();
    h.ds.session.sessionId = 'other-session';
    const other = harness();
    other.ds.session.sessionId = 'other-session';
    expect(await other.bind({ sessionId: 'other-session', deliveryId, messageId: 'om_handoff' }))
      .toMatchObject({ status: 404, value: { error: 'handoff_registration_missing' } });
  });
});

describe('dispatch records keep their thread binding', () => {
  it('a threaded dispatch record still needs the receiver to be in that thread', async () => {
    const pending = await registerPendingDispatchUser({ dataDir, secret, payload: {
      sourceAppId: 'cli_source', sourceSessionId: 's', sourceTurnId: 'om_human', rootId: 'om_root', chatId: 'oc_chat',
      targetAppIds: ['cli_target'], authority: { appId: 'cli_source', openId: 'ou_alice', unionId: 'on_alice', tools: ['bytedcli'] },
    } });
    await bindPendingDispatchUser({ dataDir, secret, deliveryId: pending.payload.deliveryId, messageId: 'om_handoff' });
    expect(await receive({ rootId: 'om_root' })).toBeDefined();
    expect(await receive()).toBeUndefined();
    expect(await receive({ rootId: 'om_elsewhere' })).toBeUndefined();
  });
});

describe('mention handoff routes accept an isolated CLI', () => {
  it('admits both routes on the session capability alone (no host secret), POST only', async () => {
    const { routeHasNarrowUntrustedAuth } = await import('../src/core/dashboard-ipc-server.js');
    const { DISPATCH_USER_MENTION_PREPARE_ROUTE, DISPATCH_USER_MENTION_BIND_ROUTE } = await import('../src/core/dispatch-user-delegation.js');
    for (const route of [DISPATCH_USER_MENTION_PREPARE_ROUTE, DISPATCH_USER_MENTION_BIND_ROUTE]) {
      expect(routeHasNarrowUntrustedAuth('POST', route)).toBe(true);
      expect(routeHasNarrowUntrustedAuth('GET', route)).toBe(false);
      expect(routeHasNarrowUntrustedAuth('POST', `${route}/x`)).toBe(false);
    }
  });
});
