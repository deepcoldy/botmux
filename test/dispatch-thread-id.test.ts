/** Execute the real CLI command and message.get wrappers without booting the CLI
 * entry point. Only transport, session storage and daemon IPC are substituted. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { parseDispatchArgs } from '../src/cli/dispatch-args.js';
import { buildDispatchCompletionBrief, buildDispatchMessages, buildProjectDispatchSyncAction,
  buildRepoPrimeText, parseDispatchBotSpec } from '../src/core/dispatch.js';

function extract(path: string, names: string[]): string {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error('Missing function: ' + name);
    return ts.transpileModule(declaration.getText(source).replace(/^export /, ''), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText.replace(/\bimport\(/g, '__import(');
  }).join('\n');
}

const cliCode = extract('src/cli.ts', ['resolveDispatchThreadId', 'cmdDispatch']);
const clientCode = extract('src/im/lark/client.ts', [
  'larkRequestDeadline', 'larkGet', 'getMessageDetail', 'getMessageThreadId',
]);
const THREAD = 'omt_d4be107c616a';
type Mode = 'dispatch' | 'standby' | 'into';

function harness(mode: Mode, options: {
  chatMode?: 'normal' | 'topic';
  threadId?: unknown;
  failure?: 'permission' | 'network' | 'timeout' | 'send';
  acceptance?: 'accepted' | 'timed_out';
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
    getBotClient: () => ({ request }),
    logger: { debug: vi.fn() },
  };
  const getMessageThreadId = new Function('scope',
    'with (scope) { ' + clientCode + '; return getMessageThreadId; }')(lookupScope);
  const replyMessage = vi.fn(async (_app: string, target: string, _content: string, _type: string, inThread: boolean) => {
    expect(target).toBe(root);
    expect(inThread).toBe(true);
    if (options.failure === 'send') throw new Error('reply failed');
    steps.push('reply');
    currentThreadId = THREAD;
    return mode === 'standby' ? 'om_prime' : 'om_kickoff';
  });
  const postCurrentSessionDaemonRoute = vi.fn(async () => {
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
    buildRepoPrimeText, parseDispatchBotSpec,
    process: { env: { SESSION_DATA_DIR: '/isolated/data' }, exitCode: 0,
      exit: (code: number) => { throw new Error('exit:' + code); } },
    console: { log: (text: string) => stdout.push(text), error: (text: string) => stderr.push(text) },
    AbortSignal: { timeout },
    assertTurnTransportOrExit: vi.fn(), assertSessionTransportOrExit: vi.fn(),
    loadSessions: () => new Map([['source', { chatId: 'oc_chat', larkAppId: 'cli_source' }]]),
    envPinnedRiffBot: undefined,
    assertProjectDispatchPolicy: vi.fn(async () => {}),
    ensureLocalBotCollaboration: vi.fn(async () => {}),
    resolveDataDir: () => '/isolated/data', join: (...parts: string[]) => parts.join('/'),
    readFileSync: () => '[]',
    waitForExactDispatchAcceptance: vi.fn(async () => ({
      acceptedBotAppIds: options.acceptance === 'accepted' ? ['cli_target'] : [],
      missingBotAppIds: options.acceptance === 'accepted' ? [] : ['cli_target'],
    })),
    persistDispatchLifecycle, postCurrentSessionDaemonRoute,
    DISPATCH_REPORT_REGISTER_ROUTE: '/dispatch-report/register',
    trySyncProjectDispatch: vi.fn(async () => true),
    __import: async (path: string) => {
      if (path === './bot-registry.js') return {
        registerBot: vi.fn(), loadBotConfigs: () => [{ larkAppId: 'cli_source' }, { larkAppId: 'cli_target' }],
      };
      if (path === './im/lark/client.js') return {
        getMessageThreadId, replyMessage,
        resolveCurrentChatBotOpenIdsByLarkAppIds: async () => ({
          ok: true, mappings: [{ larkAppId: 'cli_target', subjectOpenId: 'ou_target' }],
        }),
      };
      if (path === './core/role-resolver.js') return { readRoleDispatchCompletionEnabled: () => false };
      throw new Error('Unexpected import: ' + path);
    },
  };
  const command = new Function('state', 'with (state) { ' + cliCode + '; return cmdDispatch; }')(state);
  const args = ['--session-id', 'source', ...(options.acceptance ? ['--bot-app', 'cli_target'] : ['--bot', 'ou_target'])];
  if (mode === 'into') args.push('--into', root, '--brief', '完成任务');
  else if (mode === 'standby') args.push('--title', '任务', '--repo', '/repo', '--standby');
  else args.push('--title', '任务', '--brief', '完成任务');
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
        expect(h.postCurrentSessionDaemonRoute).toHaveBeenCalledTimes(mode === 'into' ? 0 : 1);
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
