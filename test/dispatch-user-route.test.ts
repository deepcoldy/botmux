import { matchingScheduleBotGrant, botScheduleAuthority } from '../src/core/schedule-bot-grant.js';
/** Executes the production IPC handler with platform/network seams replaced. */
import { readFileSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorityForDispatch, dispatchCallerFromReply, deliverDispatchWithUser, resolveDispatchUser, scheduleCreateCapabilities, DISPATCH_USER_DELIVERY_MAX_BYTES } from '../src/core/dispatch-user-delegation.js';
import { fallbackTurnId, frozenReplyContextForTurn } from '../src/core/reply-target.js';
import { authorizeSessionScopedIpc } from '../src/core/daemon-ipc-session-auth.js';
import { readJsonBody, JsonBodyTooLargeError } from '../src/core/dashboard-ipc-server.js';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';

import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { drainTraexRollout } from '../src/services/traex-transcript.js';
import { isStructuredBridgeLifecycleBlockingCli } from '../src/services/structured-bridge-clis.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { validateCodexAppManagedSendOrigin } from '../src/utils/codex-app-dispatch-ledger.js';
import {
  isDispatchOriginNotSendableError,
  isolatedDispatchOutputSinkAllowed,
  withIsolatedDispatchSinkFence,
} from '../src/core/dispatch-output-sink.js';

const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const route = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'ipcRoute'
  && node.expression.arguments[1]?.getText(source) === 'DISPATCH_USER_DELIVERY_ROUTE') as ts.ExpressionStatement;
const handler = (route.expression as ts.CallExpression).arguments[2];
const sourceGuards = ['sourceTopicWriteOptions', 'sessionTopicWriteOptions'].map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error('Missing source guard: ' + name);
  return declaration.getText(source);
}).join('\n');
const code = ts.transpileModule(sourceGuards + '\nconst handler = ' + handler.getText(source), {
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
    readJsonBody: async () => body, DISPATCH_USER_DELIVERY_MAX_BYTES, JsonBodyTooLargeError,
    findActiveBySessionId: (id: string) => id === ds.session.sessionId ? ds : undefined,
    authorizeSessionScopedIpc, isTrustedHostIpcRequest: () => isHost, selfDaemonLarkAppId: 'cli_source',
    validateCodexAppManagedSendOrigin, isCodexAppCliId,
    isolatedDispatchOutputSinkAllowed, withIsolatedDispatchSinkFence, isDispatchOriginNotSendableError,
    jsonRes: (_res: unknown, status: number, value: any) => ({ status, value }),
    lookupMessageChatId: vi.fn(async () => 'oc_target'), readGroupCollaborationMode: () => undefined,
    evaluateProjectDispatchPolicy: vi.fn(() => ({ ok: true })),
    getBot: () => ({ config: { triggerUserAuth: { enabled: true, tools: ['bytedcli'] } } }),
    dispatchUserForTurn: vi.fn(async () => undefined),
    targetUserForDelegation: vi.fn(async () => 'ou_alice_target'),
    fallbackTurnId, frozenReplyContextForTurn,
    authorityForDispatch, scheduleCreateCapabilities, dispatchCallerFromReply, pickTurnReplyTarget: () => undefined,
    matchingScheduleBotGrant, botScheduleAuthority,
    readGlobalConfig: () => ({ scheduleDelegation: { createEnabled: true } }),
    getDashboardAdminOpenIds: () => ['ou_alice'],
    resolveUnionIdFromOpenId, replyMessage: send, deliverDispatchWithUser,
    config: { session: { dataDir } }, loadOrCreateDispatchReportBindingSecret: () => secret,
    logger: { info: vi.fn() },
  };
  const run = new Function('scope', 'with (scope) { ' + code + '; return handler; }')(scope);
  return { ds, scope, send, body, run: (req: unknown = {}) => run(req, {}) };
}
const read = () => resolveDispatchUser({ dataDir, secret, appId: 'cli_target', chatId: 'oc_target', rootId: 'om_root', turnId: 'om_kickoff', waitMs: 0 });

// Run the actual worker screen-ready gate against a real transcript queue.
// Stop at its release boundary: the remainder only schedules UI/input work.
const workerSource = ts.createSourceFile('worker.ts', readFileSync('src/worker.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const readyCode = ts.transpileModule(['hasStructuredLifecycleBlock', 'traexFirstPromptViewportRejects', 'markPromptReady'].map(name => {
  const node = workerSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!node) throw new Error(`missing worker function ${name}`);
  return node.getText(workerSource);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
function screenReady(queue: CodexBridgeQueue, cliId = 'traex', quotaPending: unknown = undefined) {
  const released = Symbol('released');
  const release = vi.fn(() => { throw released; });
  const scope = {
    lastInitConfig: { cliId }, codexBridgeQueue: queue, isStructuredBridgeLifecycleBlockingCli, isCodexAppCliId,
    rpcTurnsAwaitingActivation: new Set(), rpcLifecycleFailClosedOwners: new Set(), rpcTerminalHydrationOwners: new Set(),
    idleDetector: { isStartupPending: () => false, reset: vi.fn(), isReadyEvidenceWeak: () => false },
    remoteRunnerRecoveredTurnInFlight: false,
    traexQuotaPending: quotaPending,
    bareShellLaunchBlocked: false, currentInputDeliveryQuarantine: () => false,
    currentPostTerminalInputFence: () => false, isPromptReady: false,
    stopStructuredStartGraceRecheck: vi.fn(), cliRestartInProgress: false,
    stopBusyPatternIdleProbe: vi.fn(), readyGate: { shouldHold: () => false },
    awaitingPostSessionStartPromptEvidence: false, isSettlingFirstFlush: false,
    freshnessInputQueue: { onPromptReady: () => 'continue' }, spawnArgvTurnStartGateHolds: () => false,
    spawnArgvInitialPromptBusy: false, ptyOutputGeneration: { snapshot: () => 1 },
    structuredRejectedReadyEvidenceGeneration: undefined, log: vi.fn(),
    scheduleStructuredStartGraceRecheck: vi.fn(), flushQueuedInputAfterTurnStartEvidence: vi.fn(),
    durableTurnInFlight: false, preserveActiveTurnAuthorityForReady: false,
    releaseActiveTurnAuthority: release,
    queuedTurnAdvanceConsumedForPrompt: undefined, queuedTypeAheadTurns: [],
    syncQueuedTurnsFromMarkerDisk: () => false,
    decideQueuedReadyTransition,
    // These cases drive a turn already in flight, so the first prompt has been
    // admitted; the traex viewport veto (covered by the startup integration
    // suite) is inert here.
    awaitingFirstPrompt: false,
    // ...and no startup dialog can be up (covered by
    // worker-claude-startup-dialog.integration.test.ts).
    probeStartupBlocker: () => null,
  };
  const run = new Function('scope', `with (scope) { ${readyCode}; return markPromptReady; }`)(scope);
  try { run(); } catch (err) { if (err !== released) throw err; }
  return release.mock.calls.length > 0;
}

describe('dispatch user IPC end-to-end identity binding', () => {
  it.each(['completed', 'failed', 'aborted'] as const)('keeps TRAE human delegation through transient screen-idle until %s', async outcome => {
    const h = harness({}, true); // sandbox off: host IPC authentication is available
    const path = join(dataDir, 'rollout.jsonl');
    const record = (type: string, payload: object) => JSON.stringify({
      timestamp: '2026-01-01T00:00:01.000Z', type, payload,
    }) + '\n';
    writeFileSync(path, record('event_msg', { type: 'user_message', message: 'delegate query', turn_id: 'native_turn' })
      + record('event_msg', { type: 'agent_message', message: 'I will delegate the query.' })
      + record('response_item', { type: 'function_call', name: 'Bash', arguments: '{}', call_id: 'call_dispatch' }));
    const queue = new CodexBridgeQueue();
    queue.mark('om_human', 'delegate query', Date.parse('2026-01-01T00:00:00.000Z'));
    const started = drainTraexRollout(path, 0);
    queue.ingest(started.events);
    expect(queue.hasBlockingTurn()).toBe(true);
    // A quiet/redrawn PTY is not a terminal while the transcript is running.
    expect(screenReady(queue)).toBe(false);
    expect((await h.run()).status).toBe(200);
    expect((await read())?.authority.openId).toBe('ou_alice');
    expect((await read())?.sourceTurnId).toBe('om_human');
    appendFileSync(path, record('event_msg', outcome === 'aborted'
      ? { type: 'turn_aborted', turn_id: 'native_turn', reason: 'interrupted' }
      : { type: 'task_complete', turn_id: 'native_turn', last_agent_message: 'done',
          ...(outcome === 'failed' ? { error: { message: 'provider failed' } } : {}) }));
    queue.ingest(drainTraexRollout(path, started.newOffset).events);
    expect(screenReady(queue)).toBe(true);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'om_human',
      ...(outcome !== 'completed' ? { terminalStatus: outcome === 'failed' ? 'failed' : 'ambiguous' } : {}) }]);
  });
  it('keeps the existing Codex lifecycle gate and does not turn a bare TRAE mark into permanent busy', () => {
    const queue = new CodexBridgeQueue();
    queue.mark('om_human', 'query');
    expect(screenReady(queue)).toBe(true);
    queue.confirmPendingTurn('om_human');
    expect(screenReady(queue)).toBe(false);
    queue.ingest([{ kind: 'user', text: 'query', uuid: 'u', timestampMs: Date.now() }]);
    expect(screenReady(queue, 'codex')).toBe(false);
  });
  it('keeps the ready gate closed while a traex quota recovery lookup is pending', () => {
    const queue = new CodexBridgeQueue();
    queue.mark('om_human', 'query');
    expect(screenReady(queue)).toBe(true);
    expect(screenReady(queue, 'traex', { turnId: 'om_human' })).toBe(false);
  });
  it.each([undefined, { capability: 'p'.repeat(64), policyCapability: 'p'.repeat(64) }])(
    'rejects host dispatch without live turn authority instead of silently sending without a human', async origin => {
      const h = harness({}, true);
      h.ds.managedTurnOrigin = origin;
      expect(await h.run()).toMatchObject({ status: 403, value: { error: 'dispatch_turn_unproven' } });
      expect(h.send).not.toHaveBeenCalled();
      expect(await read()).toBeUndefined();
    });
  it.each(['legacy', 'disabled', 'no-tools'])('does not resolve delegation when it is not requested (%s)', async mode => {
    const h = harness(mode === 'legacy' ? { targetAppIds: [], hasLegacyBots: true } : {});
    delete h.ds.activeInteractiveTurn.caller.requestUserUnionId;
    if (mode !== 'legacy') h.scope.getBot = () => ({ config: { triggerUserAuth: {
      enabled: mode !== 'disabled', tools: mode === 'disabled' ? ['bytedcli'] : [],
    } } });
    h.scope.dispatchUserForTurn = vi.fn(async () => { throw new Error('corrupt store'); });
    h.scope.resolveUnionIdFromOpenId = vi.fn(async () => { throw new Error('contact unavailable'); });
    expect((await h.run()).status).toBe(200);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.scope.dispatchUserForTurn).not.toHaveBeenCalled();
    expect(h.scope.resolveUnionIdFromOpenId).not.toHaveBeenCalled();
    expect(await read()).toBeUndefined();
  });
  it.each([0, 1])('enforces the complete UTF-8 body boundary (extra bytes=%s)', async extra => {
    const h = harness({ targetAppIds: [], content: '授权测试' });
    const prefixBytes = Buffer.byteLength(JSON.stringify(h.body));
    h.body.content += 'x'.repeat(DISPATCH_USER_DELIVERY_MAX_BYTES - prefixBytes + extra);
    const bytes = Buffer.from(JSON.stringify(h.body));
    const req = Readable.from([bytes.subarray(0, 30000), bytes.subarray(30000)]) as any;
    req.headers = {}; // Exercise streaming byte counting, not just Content-Length.
    h.scope.readJsonBody = readJsonBody;
    const result = await h.run(req);
    expect(result.status).toBe(extra ? 413 : 200);
    if (extra) {
      expect(result.value).toEqual({ ok: false, error: 'dispatch_body_too_large', maxBytes: DISPATCH_USER_DELIVERY_MAX_BYTES });
      expect(h.send).not.toHaveBeenCalled();
    } else expect(h.send).toHaveBeenCalledOnce();
  });
  it.each([false, true])('ignores claimed user identity and binds the actual sent message (host=%s)', async host => {
    const h = harness({ user: 'mallory', requested_by: 'mallory', authority: { openId: 'ou_mallory' }, sourceTurnId: 'forged' }, host);
    expect(await h.run()).toEqual({ status: 200, value: { ok: true, messageId: 'om_kickoff' } });
    expect((await read())?.authority.openId).toBe('ou_alice');
    expect((await read())?.sourceTurnId).toBe('om_human');
    expect(h.send).toHaveBeenCalledExactlyOnceWith('cli_source', 'om_root', expect.any(String), 'post', true,
      undefined, undefined, expect.objectContaining({ beforeWrite: expect.any(Function) }));
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
  it('treats unavailable root lookup as a provider failure, not a route mismatch', async () => {
    const h = harness();
    h.scope.lookupMessageChatId = vi.fn(async () => { throw new Error('network unavailable'); });
    expect(await h.run()).toMatchObject({ status: 502, value: { error: 'dispatch_delivery_failed' } });
    expect(h.send).not.toHaveBeenCalled();
    expect(await read()).toBeUndefined();
  });
  it('refuses a root whose successful lookup contains no chat', async () => {
    const h = harness();
    h.scope.lookupMessageChatId = vi.fn(async () => null);
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'dispatch_chat_mismatch' } });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('does not acquire a human identity from an ordinary peer-bot turn', async () => {
    const h = harness(); h.ds.activeInteractiveTurn.caller.senderType = 'bot';
    expect((await h.run()).status).toBe(200);
    expect(await read()).toBeUndefined();
  });
  it('issues schedule scope without triggerUserAuth and only from a direct human turn', async () => {
    const h = harness({ delegateScheduleCreate: true });
    h.scope.getBot = () => ({ config: {} });
    expect((await h.run()).status).toBe(200);
    const delegated = await read();
    expect(delegated?.domain).toBe('botmux.dispatch-user.v2');
    expect(delegated && scheduleCreateCapabilities(delegated.authority)).toEqual([
      expect.objectContaining({ action: 'schedule:create', targetAppId: 'cli_target', allowedRunScopes: [] }),
    ]);

    const bot = harness({ delegateScheduleCreate: true });
    bot.scope.getBot = () => ({ config: {} });
    bot.ds.activeInteractiveTurn.caller.senderType = 'bot';
    expect(await bot.run()).toMatchObject({ status: 403, value: { error: 'schedule_delegation_source_operator_denied' } });
  });
  it('does not let a talk-only human request persistent schedule authority', async () => {
    const h = harness({ delegateScheduleCreate: true });
    h.scope.getBot = () => ({ config: {} });
    h.scope.getDashboardAdminOpenIds = () => [];
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_delegation_source_operator_denied' } });
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each(['bot', 'report'])('issues host bot grants on %s-triggered turns without personal credentials', async kind => {
    const h = harness();
    h.ds.chatId = 'oc_target';
    h.ds.activeInteractiveTurn = { turnId: 'om_human', caller: { senderType: 'bot', requestLarkAppId: 'cli_source' } };
    if (kind === 'report') h.ds.activeInteractiveTurn = undefined;
    h.scope.readGlobalConfig = () => ({ scheduleDelegation: { createEnabled: true, selfManageEnabled: true,
      botGrants: [{ id: 'team', sourceAppId: 'cli_source', targetAppIds: ['cli_target'],
        chatIds: ['oc_target'], controllerUnionId: 'on_sponsor' }] } });
    h.scope.resolveTargetAppOpenId = vi.fn(async () => ({ status: 'resolved', openId: 'ou_alice' }));
    expect((await h.run()).status).toBe(200);
    const payload = await read();
    expect(payload?.authority.tools).toEqual([]);
    expect(payload?.authority.unionId).toBe('on_sponsor');
    expect(payload && scheduleCreateCapabilities(payload.authority)).toEqual([
      expect.objectContaining({ botGrantId: 'team', allowedRunScopes: [], allowSelfManage: true }),
    ]);
  });
  it('does not accept a non-admin sponsor for a host bot grant', async () => {
    const h = harness();
    h.ds.chatId = 'oc_target';
    h.ds.activeInteractiveTurn = { turnId: 'om_human', caller: { senderType: 'bot', requestLarkAppId: 'cli_source' } };
    h.scope.readGlobalConfig = () => ({ scheduleDelegation: { createEnabled: true,
      botGrants: [{ id: 'team', sourceAppId: 'cli_source', targetAppIds: ['cli_target'],
        chatIds: ['oc_target'], controllerUnionId: 'on_sponsor' }] } });
    h.scope.resolveTargetAppOpenId = vi.fn(async () => ({ status: 'resolved', openId: 'ou_other' }));
    expect(await h.run()).toMatchObject({ status: 403, value: { error: 'schedule_bot_grant_controller_denied' } });
    expect(h.send).not.toHaveBeenCalled();
  });
  describe('host bot grant versus the person driving the source turn', () => {
    // The sponsor resolves to a second, real administrator: had the grant
    // replaced the dispatch, the signed record would carry ou_sponsor/on_sponsor
    // and no tools instead of the caller's own identity.
    const withGrant = (h: ReturnType<typeof harness>, grant: boolean) => {
      h.scope.readGlobalConfig = () => ({ scheduleDelegation: { createEnabled: true, selfManageEnabled: true,
        ...(grant ? { botGrants: [{ id: 'team', sourceAppId: 'cli_source', targetAppIds: ['cli_target'],
          chatIds: ['oc_target'], controllerUnionId: 'on_sponsor' }] } : {}) } });
      h.scope.getDashboardAdminOpenIds = () => ['ou_alice', 'ou_sponsor'];
      h.scope.resolveTargetAppOpenId = vi.fn(async () => ({ status: 'resolved', openId: 'ou_sponsor' }));
      // The source turn runs inside the granted chat, so only the caller decides.
      h.ds.chatId = 'oc_target';
    };
    const flags = {
      plain: {}, delegate: { delegateScheduleCreate: true }, 'no-delegate': { suppressScheduleCreate: true },
    } as const;
    const cells = (['plain', 'delegate', 'no-delegate'] as const)
      .flatMap(flag => [true, false].map(grant => [flag, grant] as const));

    // Matching names the target chat; the grant also requires the dispatch to
    // be made from a granted chat, so reaching the source bot elsewhere (here a
    // p2p chat) and naming the granted chat with --chat-id gets nothing.
    it('does not apply a grant to a dispatch made outside the granted chats', async () => {
      const carol = { senderType: 'user', requestLarkAppId: 'cli_source',
        requestUserOpenId: 'ou_carol', requestUserUnionId: 'on_carol' };
      const explicit = harness({ delegateScheduleCreate: true });
      withGrant(explicit, true);
      Object.assign(explicit.ds, { chatId: 'oc_p2p_carol', chatType: 'p2p' });
      explicit.ds.activeInteractiveTurn = { turnId: 'om_human', caller: carol };
      expect(await explicit.run()).toMatchObject({ status: 403,
        value: { error: 'schedule_delegation_source_operator_denied' } });
      expect(explicit.send).not.toHaveBeenCalled();

      const bot = harness();
      withGrant(bot, true);
      bot.ds.chatId = 'oc_other_group';
      bot.ds.activeInteractiveTurn = { turnId: 'om_human', caller: { senderType: 'bot', requestLarkAppId: 'cli_source' } };
      expect((await bot.run()).status).toBe(200);
      expect(await read()).toBeUndefined();
      expect(bot.scope.resolveTargetAppOpenId).not.toHaveBeenCalled();
    });

    // A bot turn may carry a person's delegation from upstream. The grant
    // treats it like any other non-administrator turn: the dispatch is signed
    // for the controller; `--no-delegate schedule:create` keeps the upstream
    // person's immediate tools.
    it('replaces an inherited delegation on a bot turn unless the dispatch opts out', async () => {
      const upstream = { appId: 'cli_upstream', openId: 'ou_h', unionId: 'on_h', tools: ['bytedcli'] };
      const botTurn = { turnId: 'om_human', caller: { senderType: 'bot', requestLarkAppId: 'cli_source' } };
      const granted = harness();
      withGrant(granted, true);
      granted.ds.activeInteractiveTurn = botTurn;
      granted.scope.dispatchUserForTurn = vi.fn(async () => ({ authority: upstream }));
      expect((await granted.run()).status).toBe(200);
      const signed = await read();
      expect(signed?.authority).toMatchObject({ openId: 'ou_sponsor', unionId: 'on_sponsor', tools: [] });
      expect(granted.scope.dispatchUserForTurn).not.toHaveBeenCalled();

      rmSync(join(dataDir, 'dispatch-user-delegations.json'), { force: true });
      const optOut = harness({ suppressScheduleCreate: true });
      withGrant(optOut, true);
      optOut.ds.activeInteractiveTurn = botTurn;
      optOut.scope.dispatchUserForTurn = vi.fn(async () => ({ authority: upstream }));
      expect((await optOut.run()).status).toBe(200);
      const kept = await read();
      expect(kept?.authority).toMatchObject({ appId: 'cli_upstream', openId: 'ou_h', unionId: 'on_h', tools: ['bytedcli'] });
      expect(scheduleCreateCapabilities(kept!.authority)).toEqual([]);
    });

    // Host run scopes describe personal credentials a task may keep; a service
    // grant carries none, so a source bot without those tools still qualifies.
    it('does not require the source bot to hold the host run scopes for a service grant', async () => {
      const h = harness();
      withGrant(h, true);
      const policy = h.scope.readGlobalConfig();
      h.scope.readGlobalConfig = () => ({ scheduleDelegation: { ...policy.scheduleDelegation, runScopes: ['bytedcli'] } });
      h.scope.getBot = () => ({ config: {} });
      h.ds.activeInteractiveTurn = { turnId: 'om_human', caller: { senderType: 'bot', requestLarkAppId: 'cli_source' } };
      expect((await h.run()).status).toBe(200);
      expect(scheduleCreateCapabilities((await read())!.authority)).toEqual([
        expect.objectContaining({ botGrantId: 'team', allowedRunScopes: [] }),
      ]);
    });

    it.each(cells)('keeps an administrator\'s own %s dispatch unchanged (grant configured: %s)', async (flag, grant) => {
      const h = harness(flags[flag]);
      withGrant(h, grant);
      expect((await h.run()).status).toBe(200);
      const payload = await read();
      expect(payload?.authority).toMatchObject({
        appId: 'cli_source', openId: 'ou_alice', unionId: 'on_alice', tools: ['bytedcli'],
      });
      const caps = scheduleCreateCapabilities(payload!.authority);
      if (flag === 'delegate') {
        // schedule:create comes from the administrator's own v2 delegation.
        expect(caps).toEqual([expect.objectContaining({ action: 'schedule:create', targetAppId: 'cli_target',
          targetChatId: 'oc_target', allowSelfManage: true })]);
        expect(caps[0].botGrantId).toBeUndefined();
      } else {
        expect(caps).toEqual([]);
      }
      expect(h.scope.resolveTargetAppOpenId).not.toHaveBeenCalled();
    });

    it('keeps an administrator\'s restored turn on their own identity too', async () => {
      const h = harness();
      withGrant(h, true);
      h.ds.activeInteractiveTurn = undefined;
      h.scope.pickTurnReplyTarget = () => ({ senderOpenId: 'ou_alice',
        participants: [{ openId: 'ou_alice', isBot: false }] });
      expect((await h.run()).status).toBe(200);
      const payload = await read();
      expect(payload?.authority).toMatchObject({ openId: 'ou_alice', unionId: 'on_alice', tools: ['bytedcli'] });
      expect(scheduleCreateCapabilities(payload!.authority)).toEqual([]);
    });

    // The grant matches on app and chat only. A person who is not an
    // administrator but can talk to the source bot there gets the service
    // authority, exactly like a bot turn; opting out keeps their own tools.
    it('gives a non-administrator the documented service authority, and their own tools on opt-out', async () => {
      const carol = { senderType: 'user', requestLarkAppId: 'cli_source',
        requestUserOpenId: 'ou_carol', requestUserUnionId: 'on_carol' };
      const granted = harness();
      withGrant(granted, true);
      granted.ds.activeInteractiveTurn = { turnId: 'om_human', caller: carol };
      expect((await granted.run()).status).toBe(200);
      const signed = await read();
      expect(signed?.authority).toMatchObject({ openId: 'ou_sponsor', unionId: 'on_sponsor', tools: [] });
      expect(scheduleCreateCapabilities(signed!.authority)).toEqual([
        expect.objectContaining({ botGrantId: 'team', allowedRunScopes: [], allowSelfManage: true }),
      ]);
      expect(granted.scope.logger.info).toHaveBeenCalledWith(expect.stringMatching(
        /auto-attached schedule:create .*trigger=user:ou_carol grant=team signer=ou_sponsor /));

      rmSync(join(dataDir, 'dispatch-user-delegations.json'), { force: true });
      const optOut = harness({ suppressScheduleCreate: true });
      withGrant(optOut, true);
      optOut.ds.activeInteractiveTurn = { turnId: 'om_human', caller: carol };
      expect((await optOut.run()).status).toBe(200);
      const own = await read();
      expect(own?.authority).toMatchObject({ openId: 'ou_carol', unionId: 'on_carol', tools: ['bytedcli'] });
      expect(scheduleCreateCapabilities(own!.authority)).toEqual([]);
      expect(optOut.scope.resolveTargetAppOpenId).not.toHaveBeenCalled();
    });
  });
  it('can default schedule delegation by source orchestrator and honors one-shot opt-out', async () => {
    const enabled = harness();
    enabled.scope.getBot = () => ({ config: {} });
    enabled.scope.readGlobalConfig = () => ({ scheduleDelegation: {
      createEnabled: true, defaultOnDispatchFromBotAppIds: ['cli_source'],
    } });
    expect((await enabled.run()).status).toBe(200);
    expect((await read())?.domain).toBe('botmux.dispatch-user.v2');
    expect(enabled.scope.logger.info).toHaveBeenCalledWith(expect.stringContaining(
      '[schedule-delegation:audit] auto-attached schedule:create',
    ));

    rmSync(dataDir, { recursive: true, force: true });
    dataDir = mkdtempSync(join(tmpdir(), 'dispatch-ipc-'));
    const suppressed = harness({ suppressScheduleCreate: true });
    suppressed.scope.getBot = () => ({ config: {} });
    suppressed.scope.readGlobalConfig = enabled.scope.readGlobalConfig;
    expect((await suppressed.run()).status).toBe(200);
    expect(await read()).toBeUndefined();
  });
  it('binds configured bytedcli run scope and self-management into a default grant', async () => {
    const h = harness();
    h.scope.readGlobalConfig = () => ({ scheduleDelegation: {
      createEnabled: true,
      defaultOnDispatchFromBotAppIds: ['cli_source'],
      runScopes: ['bytedcli'],
      selfManageEnabled: true,
    } });
    expect((await h.run()).status).toBe(200);
    const delegated = await read();
    expect(delegated && scheduleCreateCapabilities(delegated.authority)).toEqual([
      expect.objectContaining({ allowedRunScopes: ['bytedcli'], allowSelfManage: true }),
    ]);
  });
  it('refuses persistent bytedcli scope when the source bot does not govern that tool', async () => {
    const h = harness({ delegateScheduleCreate: true });
    h.scope.getBot = () => ({ config: { triggerUserAuth: { enabled: true, tools: ['lark-cli'] } } });
    h.scope.readGlobalConfig = () => ({ scheduleDelegation: {
      createEnabled: true, runScopes: ['bytedcli'],
    } });
    expect(await h.run()).toMatchObject({
      status: 403,
      value: { error: 'schedule_delegation_source_run_scope_unavailable' },
    });
    expect(h.send).not.toHaveBeenCalled();
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
