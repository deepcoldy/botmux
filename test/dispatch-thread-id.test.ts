/** Execute the real CLI command and message.get wrappers without booting the CLI
 * entry point. Only transport, session storage and daemon IPC are substituted. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { pickTurnReplyTarget } from '../src/core/reply-target.js';
import { isSilentMessageListenerSession, messageListenerSendBlocked } from '../src/core/message-listener-silence.js';
import { parseDispatchArgs } from '../src/cli/dispatch-args.js';
import { readMessageWithinContext } from '../src/im/lark/message-read-context.js';
import { buildDispatchCompletionBrief, buildDispatchMessages, buildProjectDispatchSyncAction,
  buildRepoPrimeText, parseDispatchBotSpec, resolveSendTarget } from '../src/core/dispatch.js';
import { createDispatchReportBinding, hasVerifiedDispatchReportBindingForCaller,
  resolveVerifiedDispatchReportTarget } from '../src/core/dispatch-report-binding.js';
import { isTrustedVcMeetingHostRelayParent } from '../src/services/vc-meeting-send-policy.js';
import { resolveReportRelayFallbackTarget } from '../src/core/report-session-relay.js';

function extract(path: string, names: string[]): string {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const declaration = source.statements.find(node =>
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name);
    if (!declaration) throw new Error('Missing function: ' + name);
    return ts.transpileModule(declaration.getText(source).replace(/^export /, ''), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText.replace(/\bimport\(/g, '__import(');
  }).join('\n');
}

const cliCode = extract('src/cli.ts', ['resolveDispatchThreadId', 'freezeDispatchOriginClaim', 'cmdDispatch',
  // Real (not stubbed) task-tree sync so the default-off gate and its IPC
  // behaviour are exercised; only the HTTP layer (postCurrentSessionDaemonRoute) is a mock.
  'syncDispatchTaskTreeAfterDispatch', 'trySyncDispatchTaskTree']);
// larkGet / larkRequestDeadline live in lark-get.ts (re-exported by client.ts).
const clientCode = extract('src/im/lark/lark-get.ts', ['larkRequestDeadline', 'larkGet'])
  + '\n' + extract('src/im/lark/client.ts', ['getMessageDetail', 'getMessageThreadId']);
const THREAD = 'omt_d4be107c616a';
type Mode = 'dispatch' | 'standby' | 'into';

function harness(mode: Mode, options: {
  chatMode?: 'normal' | 'topic';
  threadId?: unknown;
  failure?: 'permission' | 'network' | 'timeout' | 'send';
  acceptance?: 'accepted' | 'timed_out';
  consentPending?: boolean;
  consentDenied?: boolean;
  taskTreeCardEnabled?: boolean;
  sourceRootMessageId?: string;
  sourceScope?: 'thread' | 'chat';
  sourceCurrentReplyTarget?: { rootMessageId?: string; turnId?: string };
  sourceReplyTargets?: Record<string, { rootMessageId?: string; turnId?: string; quoteOnly?: boolean }>;
  sourceStatus?: string;
  additionalSessions?: Array<{
    sessionId: string; larkAppId: string; chatId: string; scope: 'thread' | 'chat'; status: string;
  }>;
  envTurnId?: string;
  freshTurnId?: string;
  hostRelayAuthorized?: boolean;
  workerPid?: number;
  parentPid?: number;
  resultDelivery?: 'relay' | 'publish' | 'publish-and-relay';
  dispatchRegistry?: Record<string, unknown>;
  bindingSecret?: string;
  resolveBotApps?: (receiver: string, chatId: string, appIds: string[]) => Promise<unknown>;
} = {}) {
  const root = mode === 'into' ? 'om_existing' : 'om_seed';
  const stdout: string[] = [];
  const stderr: string[] = [];
  const steps: string[] = [];
  let currentThreadId: string | undefined = options.chatMode === 'topic' || mode === 'into' ? THREAD : undefined;
  const request = vi.fn(async (input: { signal: AbortSignal }) => {
    steps.push('lookup');
    // A normal-group seed need not carry thread_id until reply_in_thread succeeds.
    expect(steps).toContain('reply');
    if (options.failure === 'network') throw new Error('network unavailable');
    if (options.failure === 'permission') return { code: 99991672, msg: 'permission denied' };
    if (options.failure === 'timeout') {
      return new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
    }
    return { code: 0, data: { items: [{ message_id: root,
      thread_id: Object.hasOwn(options, 'threadId') ? options.threadId : currentThreadId }] } };
  });
  const lookupScope = {
    readMessageWithinContext,
    getBotClient: () => ({ request }),
    logger: { debug: vi.fn() },
  };
  const getMessageThreadId = new Function('scope',
    'with (scope) { ' + clientCode + '; return getMessageThreadId; }')(lookupScope);
  const replyMessage = vi.fn(async (_app: string, target: string, _content: string, _type: string, inThread: boolean,
    _uuid?: string, _context?: unknown, writeOptions?: { beforeWrite?: () => Promise<void> }) => {
    await writeOptions?.beforeWrite?.();
    expect(target).toBe(root);
    expect(inThread).toBe(true);
    if (options.failure === 'send') throw new Error('reply failed');
    steps.push('reply');
    currentThreadId = THREAD;
    return mode === 'standby' ? 'om_prime' : 'om_kickoff';
  });
  const postCurrentSessionDaemonRoute = vi.fn(async (input: { path: string; body: any }) => {
    if (input.path === '/api/dispatch-user/deliver') {
      if (options.consentPending) return { ok: false, json: async () => ({ ok: false, error: 'task_consent_pending' }) };
      if (options.consentDenied) return { ok: false, json: async () => ({ ok: false, error: 'task_consent_denied' }) };
      const messageId = await replyMessage('cli_source', input.body.rootId, input.body.content, 'post', true);
      return { ok: true, json: async () => ({ ok: true, messageId }) };
    }
    steps.push('seed');
    return { ok: true, json: async () => ({ ok: true, dispatchRoot: root }) };
  });
  const persistDispatchLifecycle = vi.fn(async (input: Record<string, unknown>) => ({
    transportState: input.transportState, acceptanceState: input.acceptanceState, errorCode: input.errorCode,
  }));
  const timeoutSignals: AbortController[] = [];
  const timeout = vi.fn((ms: number) => {
    expect(ms).toBe(2_000);
    const controller = new AbortController();
    timeoutSignals.push(controller);
    if (options.failure === 'timeout') queueMicrotask(() => controller.abort(new Error('deadline exceeded')));
    return controller.signal;
  });
  const state = {
    parseDispatchArgs, buildDispatchCompletionBrief, buildDispatchMessages, buildProjectDispatchSyncAction,
    buildRepoPrimeText, parseDispatchBotSpec, resolveSendTarget, pickTurnReplyTarget,
    isSilentMessageListenerSession, messageListenerSendBlocked,
    isTrustedVcMeetingHostRelayParent, resolveReportRelayFallbackTarget,
    resolveSessionContext: () => options.freshTurnId
      ? { sessionId: 'source', turnId: options.freshTurnId }
      : undefined,
    process: {
      env: {
        SESSION_DATA_DIR: '/isolated/data',
        ...(options.envTurnId ? { BOTMUX_TURN_ID: options.envTurnId } : {}),
        ...(options.hostRelayAuthorized ? { BOTMUX_HOST_RELAY_AUTHORIZED: '1' } : {}),
      },
      exitCode: 0,
      ppid: options.parentPid ?? 0,
      exit: (code: number) => { throw new Error('exit:' + code + '\n' + stderr.join('\n')); },
    },
    console: { log: (text: string) => stdout.push(text), error: (text: string) => stderr.push(text) },
    AbortSignal: { timeout },
    assertTurnTransportOrExit: vi.fn(), assertSessionTransportOrExit: vi.fn(),
    // Extracted cmdDispatch calls the machine-wide multi-topic gate; the gate's
    // own refusal path is covered by multi-topic-feature-gate.test.ts, so this
    // receipt/thread-id harness keeps the default-enabled behavior.
    isMultiTopicOrchestrationEnabled: () => true,
    // Extracted cmdDispatch calls the machine-wide task-tree card gate;
    // default-OFF in this harness so the receipt/thread-id tests keep the
    // pre-card shape (no attemptAt, no /dispatch-tree IPC). An explicit
    // taskTreeCardEnabled:true exercises the on path.
    isDispatchTaskTreeCardEnabled: () => options.taskTreeCardEnabled === true,
    // Extracted cmdDispatch checks for a group-secretary patrol turn; these
    // harness turns are ordinary bot turns, so no patrol root applies.
    parseSecretaryPatrolRoot: () => undefined,
    loadSessions: () => new Map([
      ['source', {
        sessionId: 'source', chatId: 'oc_chat', larkAppId: 'cli_source',
        status: options.sourceStatus ?? 'active',
        ...(options.workerPid !== undefined ? { pid: options.workerPid } : {}),
        ...(options.sourceScope ? { scope: options.sourceScope } : {}),
        ...(options.sourceRootMessageId ? { rootMessageId: options.sourceRootMessageId } : {}),
        ...(options.sourceCurrentReplyTarget ? { currentReplyTarget: options.sourceCurrentReplyTarget } : {}),
        ...(options.sourceReplyTargets ? { replyTargets: options.sourceReplyTargets } : {}),
      }],
      ...(options.additionalSessions ?? []).map(session => [session.sessionId, session] as const),
    ]),
    requireSessionById: async (sid: string) => ({
      sessionId: sid, chatId: 'oc_chat', larkAppId: 'cli_source',
      ...(options.workerPid !== undefined ? { pid: options.workerPid } : {}),
      ...(options.sourceScope ? { scope: options.sourceScope } : {}),
      ...(options.sourceRootMessageId ? { rootMessageId: options.sourceRootMessageId } : {}),
      ...(options.sourceCurrentReplyTarget ? { currentReplyTarget: options.sourceCurrentReplyTarget } : {}),
      ...(options.sourceReplyTargets ? { replyTargets: options.sourceReplyTargets } : {}),
    }),
    envPinnedRiffBot: undefined,
    assertProjectDispatchPolicy: vi.fn(async () => {}),
    ensureLocalBotCollaboration: vi.fn(async () => {}),
    resolveDataDir: () => '/isolated/data', join: (...parts: string[]) => parts.join('/'),
    // Host-shaped caller: no isolation channel/relay, so no origin claim to freeze.
    readManagedOriginCapability: () => null,
    readDispatchReportBindingSecret: () => options.bindingSecret,
    hasVerifiedDispatchReportBindingForCaller,
    resolveVerifiedDispatchReportTarget,
    readFileSync: (path: string) => path.endsWith('orchestrate-dispatch.json')
      ? JSON.stringify(options.dispatchRegistry ?? {})
      : '[]',
    waitForExactDispatchAcceptance: vi.fn(async () => ({
      acceptedBotAppIds: options.acceptance === 'accepted' ? ['cli_target'] : [],
      missingBotAppIds: options.acceptance === 'accepted' ? [] : ['cli_target'],
    })),
    persistDispatchLifecycle, postCurrentSessionDaemonRoute,
    DISPATCH_REPORT_REGISTER_ROUTE: '/dispatch-report/register',
    DISPATCH_USER_DELIVERY_ROUTE: '/api/dispatch-user/deliver',
    trySyncProjectDispatch: vi.fn(async () => true),
    __import: async (path: string) => {
      if (path === './bot-registry.js') return {
        getBot: () => ({ config: { topicUnavailablePolicy: 'legacy' } }),
        registerBot: vi.fn(), loadBotConfigs: () => [{ larkAppId: 'cli_source' }, { larkAppId: 'cli_target' }],
      };
      if (path === './im/lark/client.js') return {
        getMessageThreadId, replyMessage,
        resolveCurrentChatBotOpenIdsByLarkAppIds: options.resolveBotApps ?? (async () => ({
          ok: true, mappings: [{ larkAppId: 'cli_target', subjectOpenId: 'ou_target' }],
        })),
      };
      if (path === './core/role-resolver.js') return { readRoleDispatchCompletionEnabled: () => false };
      throw new Error('Unexpected import: ' + path);
    },
  };
  const command = new Function('state', 'with (state) { ' + cliCode + '; return cmdDispatch; }')(state);
  const args = ['--session-id', 'source',
    ...(options.acceptance || options.resolveBotApps ? ['--bot-app', 'cli_target'] : ['--bot', 'ou_target'])];
  if (mode === 'into') args.push('--into', root, '--brief', '完成任务');
  else if (mode === 'standby') args.push('--title', '任务', '--repo', '/repo', '--standby');
  else args.push('--title', '任务', '--brief', '完成任务');
  if (options.resultDelivery) args.push('--result-delivery', options.resultDelivery);
  return { run: () => command(args), root, stdout, stderr, state, steps, request,
    replyMessage, postCurrentSessionDaemonRoute, persistDispatchLifecycle, timeout, timeoutSignals };
}

function oldReceipt(mode: Mode) {
  const common = {
    success: true, sourceSessionId: 'source', targetAppIds: [], transportState: 'dispatched',
    acceptanceState: 'not_requested', errorCode: null, taskSent: mode !== 'standby', mode,
    threadRootId: mode === 'into' ? 'om_existing' : 'om_seed', chatId: 'oc_chat',
    bots: ['ou_target'], collaborationReady: false, projectSynced: true,
  };
  if (mode === 'into') return { ...common, kickoffMessageId: 'om_kickoff' };
  return { ...common, seedMessageId: 'om_seed', repo: mode === 'standby' ? '/repo' : null,
    ...(mode === 'standby' ? { primeMessageId: 'om_prime' } : { kickoffMessageId: 'om_kickoff' }) };
}

for (const chatMode of ['normal', 'topic'] as const) {
  describe(chatMode + ' group dispatch receipts', () => {
    for (const mode of ['dispatch', 'standby', 'into'] as const) {
      it(mode + ' adds only the real topic id after the existing thread reply', async () => {
        const h = harness(mode, { chatMode });
        await h.run();
        expect(h.stderr).toEqual([]);
        expect(h.stdout).toHaveLength(1);
        const { threadId, ...oldFields } = JSON.parse(h.stdout[0]);
        expect(threadId).toBe(THREAD);
        expect(threadId).toMatch(/^omt_[A-Za-z0-9_-]+$/);
        expect(oldFields).toEqual(oldReceipt(mode));
        expect(h.steps).toEqual(mode === 'into' ? ['reply', 'lookup'] : ['seed', 'reply', 'lookup']);
        expect(h.postCurrentSessionDaemonRoute).toHaveBeenCalledTimes(mode === 'dispatch' ? 2 : 1);
        // Card OFF (harness default): no /dispatch-tree call and the dispatch
        // entry gains no attemptAt — exactly the pre-card dispatch shape.
        expect(h.postCurrentSessionDaemonRoute.mock.calls.map(c => c[0]!.path))
          .not.toContain(expect.stringContaining('dispatch-tree'));
        expect((h.persistDispatchLifecycle.mock.calls[0]![0] as Record<string, unknown>).attemptStartedAt)
          .toBeUndefined();
        expect(h.request).toHaveBeenCalledExactlyOnceWith({
          method: 'GET', url: '/open-apis/im/v1/messages/' + h.root,
          params: { with_sender_name: 'true' }, timeout: 2_000, signal: h.timeoutSignals[0].signal,
        });
        expect(h.state.process.exitCode).toBe(0);
      });
    }
  });
}

for (const mode of ['dispatch', 'standby', 'into'] as const) {
  describe(mode + ' task-tree card gate', () => {
    it('OFF: persists no attemptStartedAt and makes no /dispatch-tree IPC (pre-card shape)', async () => {
      const h = harness(mode, { taskTreeCardEnabled: false });
      await h.run();
      expect(h.persistDispatchLifecycle).toHaveBeenCalledTimes(1);
      for (const call of h.persistDispatchLifecycle.mock.calls) {
        expect((call[0] as Record<string, unknown>).attemptStartedAt).toBeUndefined();
      }
      expect(h.postCurrentSessionDaemonRoute.mock.calls.map(c => c[0]!.path))
        .not.toContain(expect.stringContaining('dispatch-tree'));
    });

    it('ON: persists attemptStartedAt and calls the dispatch-tree IPC once', async () => {
      const h = harness(mode, { taskTreeCardEnabled: true });
      await h.run();
      expect((h.persistDispatchLifecycle.mock.calls[0]![0] as Record<string, unknown>).attemptStartedAt)
        .toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
      const treeCalls = h.postCurrentSessionDaemonRoute.mock.calls
        .filter(c => c[0]!.path.includes('dispatch-tree'));
      expect(treeCalls).toHaveLength(1);
    });
  });
}

for (const mode of ['dispatch', 'standby', 'into'] as const) {
  describe(mode + ' metadata failures', () => {
    it.each([undefined, null, '', '   ', 'om_seed', 'omt_', 'omt_bad value', 123])(
      'returns null for unavailable or invalid thread_id %s without changing old fields', async threadId => {
        const h = harness(mode, { threadId });
        await h.run();
        expect(JSON.parse(h.stdout[0])).toEqual({ ...oldReceipt(mode), threadId: null });
        expect(h.stderr).toEqual([]);
        expect(h.state.process.exitCode).toBe(0);
      },
    );
    it.each(['permission', 'network', 'timeout'] as const)('preserves success on %s lookup failure', async failure => {
      const h = harness(mode, { failure });
      await h.run();
      expect(JSON.parse(h.stdout[0])).toEqual({ ...oldReceipt(mode), threadId: null });
      expect(h.stderr).toEqual([]);
      expect(h.state.process.exitCode).toBe(0);
      expect(h.persistDispatchLifecycle).toHaveBeenCalledTimes(1);
      expect(h.request).toHaveBeenCalledTimes(1);
    });
    it('preserves transport failure and does not query metadata after a failed reply', async () => {
      const h = harness(mode, { failure: 'send' });
      await expect(h.run()).rejects.toThrow('exit:1');
      expect(h.stdout).toEqual([]);
      expect(JSON.parse(h.stderr[0])).toEqual({
        success: false, sourceSessionId: 'source', targetAppIds: [], chatId: 'oc_chat',
        threadRootId: h.root, threadId: null, transportState: 'failed', acceptanceState: 'failed',
        errorCode: 'TRANSPORT_FAILED', detail: 'reply failed',
      });
      expect(h.request).not.toHaveBeenCalled();
    });
  });
}

it.each(['dispatch', 'into'] as const)('%s reports a resumable consent wait without failing the task', async mode => {
  const h = harness(mode, { consentPending: true, acceptance: 'accepted' });
  await h.run();
  expect(JSON.parse(h.stderr.at(-1)!)).toMatchObject({ errorCode: 'TASK_CONSENT_PENDING', taskSent: false, threadRootId: h.root });
  expect(h.persistDispatchLifecycle).not.toHaveBeenCalled();
  expect(h.replyMessage).not.toHaveBeenCalled();
});

it.each(['dispatch', 'into'] as const)('%s preserves a task consent refusal without reporting transport failure', async mode => {
  const h = harness(mode, { consentDenied: true, acceptance: 'accepted', taskTreeCardEnabled: true });
  await h.run();
  const result = JSON.parse(h.stderr.at(-1)!);
  expect(result).toMatchObject({
    success: false, taskSent: false, errorCode: 'TASK_CONSENT_DENIED',
    sourceSessionId: 'source', targetAppIds: ['cli_target'], chatId: 'oc_chat', threadRootId: h.root,
  });
  expect(result).not.toHaveProperty('transportState');
  expect(result).not.toHaveProperty('acceptanceState');
  expect(h.stdout).toEqual([]);
  expect(h.state.process.exitCode).toBe(1);
  expect(h.persistDispatchLifecycle).not.toHaveBeenCalled();
  expect(h.replyMessage).not.toHaveBeenCalled();
  expect(h.request).not.toHaveBeenCalled();
  expect(h.postCurrentSessionDaemonRoute.mock.calls.map(c => c[0]!.path))
    .not.toContain(expect.stringContaining('dispatch-tree'));
});

it.each(['dispatch', 'into'] as const)('%s keeps acceptance timeout independent from thread metadata', async mode => {
  const h = harness(mode, { acceptance: 'timed_out' });
  await h.run();
  expect(JSON.parse(h.stdout[0])).toMatchObject({
    success: false, taskSent: true, threadId: THREAD, threadRootId: h.root,
    transportState: 'dispatched', acceptanceState: 'timed_out', errorCode: 'ACCEPTANCE_TIMEOUT',
    accepted: false, acceptedBotAppIds: [], missingBotAppIds: ['cli_target'],
  });
  expect(h.state.process.exitCode).toBe(1);
});

describe('dispatch --bot-app live membership failures', () => {
  // 真实的严格解析器，只替换 larkGet 与本机 Bot 配置。
  function liveResolver(larkGet: (client: { appId: string }, url: string) => Promise<unknown>) {
    const code = extract('src/im/lark/client.ts',
      ['LarkCallTimeoutError', 'promiseWithTimeout', 'listChatBotsViaMembersBots', 'resolveCurrentChatBotOpenIdsByLarkAppIds']);
    const client = (appId: string) => ({ appId });
    const scope = {
      config: { chatBotDiscovery: { listBotsApiTimeoutMs: 20 }, session: { dataDir: '/isolated/data' } },
      getBotClient: client,
      getAllBotClients: () => ['cli_source', 'cli_target'].map(appId => ({ appId, client: client(appId) })),
      readFileSync: () => JSON.stringify([{ larkAppId: 'cli_target', botName: 'Target' }]),
      join: (...parts: string[]) => parts.join('/'),
      larkGet,
    };
    return new Function('scope', 'with (scope) { ' + code + '; return resolveCurrentChatBotOpenIdsByLarkAppIds; }')(scope);
  }
  const hang = () => new Promise<never>(() => {});
  const liveRows = async () => ({ code: 0, data: { items: [{ bot_id: 'ou_target', bot_name: 'Target' }] } });

  it.each([
    ['/members/bots', (_c: { appId: string }, url: string) => (url.endsWith('/members/bots') ? hang() : liveRows())],
    ['is_in_chat', (_c: { appId: string }, url: string) => (url.endsWith('/members/bots') ? liveRows() : hang())],
  ])('names the timeout env var when %s is slower than the deadline', async (_label, larkGet) => {
    const h = harness('dispatch', { resolveBotApps: liveResolver(larkGet) });
    await expect(h.run()).rejects.toThrow('exit:1');
    expect(h.stderr.join('\n')).toContain('BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS');
    expect(h.replyMessage).not.toHaveBeenCalled();
    expect(h.postCurrentSessionDaemonRoute).not.toHaveBeenCalled();
  });

  it.each([
    { code: 99991672, msg: 'permission denied' },
    { code: 232011, msg: 'upstream timed out after 20ms' },
  ])('does not suggest the timeout env var for Feishu business error $code', async body => {
    const h = harness('dispatch', { resolveBotApps: liveResolver(async () => body) });
    await expect(h.run()).rejects.toThrow('exit:1');
    const stderr = h.stderr.join('\n');
    expect(stderr).toContain(String(body.code));
    expect(stderr).not.toContain('BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS');
  });
});

describe('dispatch --into completion protocol gating', () => {
  const SECRET = 'test-into-binding-secret';
  const legacyBinding = () => createDispatchReportBinding(SECRET, {
    dispatchRoot: 'om_existing',
    targetLarkAppId: 'cli_source',
    targetSessionId: 'session-old',
    sourceName: '旧版群编排子任务',
    issuedAt: '2026-08-10T00:00:00.000Z',
  });
  const kickoffText = (h: ReturnType<typeof harness>): string => {
    const content = h.replyMessage.mock.calls[0]?.[2] as string;
    const parsed = JSON.parse(content) as { zh_cn: { content: Array<Array<{ tag: string; text?: string }>> } };
    return parsed.zh_cn.content.flat().filter(node => node.tag === 'text').map(node => node.text).join('\n');
  };

  it('omits botmux report --dispatch-root when --into targets an unregistered topic', async () => {
    const h = harness('into', { acceptance: 'accepted', bindingSecret: SECRET, dispatchRegistry: {} });
    await h.run();
    const text = kickoffText(h);
    expect(text).toContain('完成任务');
    expect(text).not.toContain('botmux report --dispatch-root');
    expect(text).not.toContain('不要在本话题 @ 来源 bot');
  });

  it('omits botmux report --dispatch-root when --into targets a topic bound to another orchestrator', async () => {
    const foreignBinding = createDispatchReportBinding(SECRET, {
      dispatchRoot: 'om_existing',
      targetLarkAppId: 'cli_other_lead',
      targetSessionId: 'other-session',
      targetChatId: 'oc_chat',
      targetScope: 'thread',
      sourceName: '其他编排',
      issuedAt: '2026-11-24T00:00:00.000Z',
    });
    const h = harness('into', {
      acceptance: 'accepted',
      bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: foreignBinding } },
    });
    await h.run();
    expect(kickoffText(h)).not.toContain('botmux report --dispatch-root');
  });

  it('keeps botmux report --dispatch-root when --into targets a verified dispatch bound to this caller', async () => {
    const ownBinding = createDispatchReportBinding(SECRET, {
      dispatchRoot: 'om_existing',
      targetLarkAppId: 'cli_source',
      targetSessionId: 'source',
      targetChatId: 'oc_chat',
      targetScope: 'thread',
      sourceName: '子任务',
      issuedAt: '2026-11-24T00:00:00.000Z',
    });
    const h = harness('into', {
      acceptance: 'accepted',
      bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: ownBinding } },
    });
    await h.run();
    expect(kickoffText(h)).toContain('botmux report --dispatch-root om_existing');
  });

  it('omits legacy report protocol when --into --bot stays in the caller own topic', async () => {
    const h = harness('into', { sourceRootMessageId: 'om_existing' });
    await h.run();
    const text = kickoffText(h);
    expect(text).toContain('完成任务');
    expect(text).not.toContain('botmux report');
    expect(text).not.toContain('不要在本话题 @ 主bot');
  });

  it('keeps botmux report --dispatch-root in chat-scope even when currentReplyTarget or active turn points to the bound topic', async () => {
    const chatBinding = createDispatchReportBinding(SECRET, {
      dispatchRoot: 'om_existing',
      targetLarkAppId: 'cli_source',
      targetSessionId: 'source',
      targetChatId: 'oc_chat',
      targetScope: 'chat',
      sourceName: '群编排子任务',
      issuedAt: '2026-11-24T00:00:00.000Z',
    });
    const hQueuedOverwrite = harness('into', {
      acceptance: 'accepted',
      sourceScope: 'chat',
      envTurnId: 'turn-a',
      sourceReplyTargets: { 'turn-a': { rootMessageId: 'om_topic_a', turnId: 'turn-a' } },
      sourceCurrentReplyTarget: { rootMessageId: 'om_existing', turnId: 'turn-b' },
      bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: chatBinding } },
    });
    await hQueuedOverwrite.run();
    expect(kickoffText(hQueuedOverwrite)).toContain('botmux report --dispatch-root om_existing');

    const hSameTopicActive = harness('into', {
      acceptance: 'accepted',
      sourceScope: 'chat',
      envTurnId: 'turn-b',
      sourceReplyTargets: { 'turn-b': { rootMessageId: 'om_existing', turnId: 'turn-b' } },
      sourceCurrentReplyTarget: { rootMessageId: 'om_existing', turnId: 'turn-b' },
      bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: chatBinding } },
    });
    await hSameTopicActive.run();
    expect(kickoffText(hSameTopicActive)).toContain('botmux report --dispatch-root om_existing');
  });

  it('keeps legacy report protocol when the exact chat turn only quotes the into root', async () => {
    const h = harness('into', {
      sourceScope: 'chat',
      freshTurnId: 'turn-quote',
      sourceReplyTargets: {
        'turn-quote': { rootMessageId: 'om_existing', turnId: 'turn-quote', quoteOnly: true },
      },
    });
    await h.run();
    expect(kickoffText(h)).toContain('--legacy-dispatch');
  });

  it('keeps legacy report protocol when only a stale env turn points to the into root', async () => {
    const h = harness('into', {
      sourceScope: 'chat',
      envTurnId: 'turn-stale-spawn',
      sourceReplyTargets: {
        'turn-stale-spawn': { rootMessageId: 'om_existing', turnId: 'turn-stale-spawn' },
      },
      sourceCurrentReplyTarget: { rootMessageId: 'om_current', turnId: 'turn-current' },
    });
    await h.run();
    expect(kickoffText(h)).toContain('--legacy-dispatch');
  });

  it('uses fresh process-tree turn identity instead of stale env or a later queued reply target', async () => {
    const hSameTurn = harness('into', {
      sourceScope: 'chat',
      freshTurnId: 'turn-a',
      envTurnId: 'turn-stale-spawn',
      sourceReplyTargets: {
        'turn-a': { rootMessageId: 'om_existing', turnId: 'turn-a' },
        'turn-stale-spawn': { rootMessageId: 'om_other', turnId: 'turn-stale-spawn' },
      },
      sourceCurrentReplyTarget: { rootMessageId: 'om_other', turnId: 'turn-b' },
    });
    await hSameTurn.run();
    expect(kickoffText(hSameTurn)).not.toContain('botmux report');

    const hCrossTurn = harness('into', {
      sourceScope: 'chat',
      freshTurnId: 'turn-a',
      envTurnId: 'turn-stale-spawn',
      sourceReplyTargets: {
        'turn-a': { rootMessageId: 'om_topic_a', turnId: 'turn-a' },
        'turn-stale-spawn': { rootMessageId: 'om_existing', turnId: 'turn-stale-spawn' },
      },
      sourceCurrentReplyTarget: { rootMessageId: 'om_existing', turnId: 'turn-b' },
    });
    await hCrossTurn.run();
    expect(kickoffText(hCrossTurn)).toContain('--legacy-dispatch');
  });

  it('accepts env turn identity only for a parent-bound authorized host relay', async () => {
    const base = {
      sourceScope: 'chat' as const,
      envTurnId: 'turn-a',
      hostRelayAuthorized: true,
      workerPid: 4242,
      sourceReplyTargets: { 'turn-a': { rootMessageId: 'om_existing', turnId: 'turn-a' } },
    };
    const hTrusted = harness('into', { ...base, parentPid: 4242 });
    await hTrusted.run();
    expect(kickoffText(hTrusted)).not.toContain('botmux report');

    const hWrongParent = harness('into', { ...base, parentPid: 4343 });
    await hWrongParent.run();
    expect(kickoffText(hWrongParent)).toContain('--legacy-dispatch');
  });

  it.each(['relay', 'publish'] as const)('keeps %s protocol for a proven legacy chat-scope successor', async resultDelivery => {
    const h = harness('into', {
      acceptance: 'accepted',
      resultDelivery,
      sourceScope: 'chat',
      bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: legacyBinding() } },
      additionalSessions: [{
        sessionId: 'session-old', larkAppId: 'cli_source', chatId: 'oc_chat', scope: 'chat', status: 'closed',
      }],
    });
    await h.run();
    const text = kickoffText(h);
    expect(text).toContain('botmux report --dispatch-root om_existing');
    if (resultDelivery === 'publish') expect(text).toContain('--delivery publish');
  });

  it('rejects legacy successor protocol when the original is active or the successor is not unique', async () => {
    const activeOriginal = harness('into', {
      acceptance: 'accepted', sourceScope: 'chat', bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: legacyBinding() } },
      additionalSessions: [{
        sessionId: 'session-old', larkAppId: 'cli_source', chatId: 'oc_chat', scope: 'chat', status: 'active',
      }],
    });
    await activeOriginal.run();
    expect(kickoffText(activeOriginal)).not.toContain('botmux report --dispatch-root');

    const ambiguous = harness('into', {
      acceptance: 'accepted', sourceScope: 'chat', bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: legacyBinding() } },
      additionalSessions: [
        { sessionId: 'session-old', larkAppId: 'cli_source', chatId: 'oc_chat', scope: 'chat', status: 'closed' },
        { sessionId: 'session-other', larkAppId: 'cli_source', chatId: 'oc_chat', scope: 'chat', status: 'active' },
      ],
    });
    await ambiguous.run();
    expect(kickoffText(ambiguous)).not.toContain('botmux report --dispatch-root');

    const fallbackSelectsOther = harness('into', {
      acceptance: 'accepted', sourceScope: 'chat', sourceStatus: 'closed', bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: legacyBinding() } },
      additionalSessions: [
        { sessionId: 'session-old', larkAppId: 'cli_source', chatId: 'oc_chat', scope: 'chat', status: 'closed' },
        { sessionId: 'session-other', larkAppId: 'cli_source', chatId: 'oc_chat', scope: 'chat', status: 'active' },
      ],
    });
    await fallbackSelectsOther.run();
    expect(kickoffText(fallbackSelectsOther)).not.toContain('botmux report --dispatch-root');

    const crossChat = harness('into', {
      acceptance: 'accepted', sourceScope: 'chat', bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: legacyBinding() } },
      additionalSessions: [{
        sessionId: 'session-old', larkAppId: 'cli_source', chatId: 'oc_other', scope: 'chat', status: 'closed',
      }],
    });
    await crossChat.run();
    expect(kickoffText(crossChat)).not.toContain('botmux report --dispatch-root');
  });

  it('rejects a legacy successor when the original session was thread-scope', async () => {
    const h = harness('into', {
      acceptance: 'accepted', resultDelivery: 'publish', sourceScope: 'chat', bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: legacyBinding() } },
      additionalSessions: [{
        sessionId: 'session-old', larkAppId: 'cli_source', chatId: 'oc_chat', scope: 'thread', status: 'closed',
      }],
    });
    await expect(h.run()).rejects.toThrow('exit:1');
    expect(h.replyMessage).not.toHaveBeenCalled();
  });

  it('rejects a moved original row that conflicts with the signed target chat', async () => {
    const movedBinding = createDispatchReportBinding(SECRET, {
      dispatchRoot: 'om_existing',
      targetLarkAppId: 'cli_source',
      targetSessionId: 'session-old',
      targetChatId: 'oc_original',
      targetScope: 'chat',
      sourceName: '群编排子任务',
      issuedAt: '2026-11-24T00:00:00.000Z',
    });
    const h = harness('into', {
      acceptance: 'accepted', sourceScope: 'chat', bindingSecret: SECRET,
      dispatchRegistry: { om_existing: { reportBinding: movedBinding } },
      additionalSessions: [{
        sessionId: 'session-old', larkAppId: 'cli_source', chatId: 'oc_chat', scope: 'chat', status: 'closed',
      }],
    });
    await h.run();
    expect(kickoffText(h)).not.toContain('botmux report --dispatch-root');
  });
});
