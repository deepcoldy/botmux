import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateCalls: 0,
  runCalls: 0,
  cardBodies: [] as string[],
  replyMessage: vi.fn(async (_app: string, _anchor: string, body: string) => {
    mocks.cardBodies.push(body);
    return `om_card_${mocks.cardBodies.length}`;
  }),
  sendMessage: vi.fn(async (_app: string, _chat: string, body: string) => {
    mocks.cardBodies.push(body);
    return `om_card_${mocks.cardBodies.length}`;
  }),
  updateMessage: vi.fn(async () => undefined),
  getMessageChatId: vi.fn(async () => 'oc_host_flow'),
  getChatMode: vi.fn(async () => 'group' as const),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  class FakeWSClient { start() {} }
  class FakeEventDispatcher { register() {} }
  return {
    Client: FakeClient,
    WSClient: FakeWSClient,
    EventDispatcher: FakeEventDispatcher,
    LoggerLevel: { info: 2 },
  };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    updateMessage: mocks.updateMessage,
    getMessageChatId: mocks.getMessageChatId,
    getChatMode: mocks.getChatMode,
  };
});

vi.mock('../src/core/plugins/mcp/gateway.js', () => ({
  PluginMcpGateway: class {
    async connect() {}
    async close() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/inMemory.js', () => ({
  InMemoryTransport: {
    createLinkedPair: () => [{}, {}],
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async close() {}
    async listTools() {
      return {
        tools: [
          { name: 'validate_sql_for_user' },
          { name: 'run_query_for_user' },
        ],
      };
    }
    async callTool(input: { name: string }) {
      if (input.name === 'validate_sql_for_user') {
        mocks.validateCalls += 1;
        return {
          content: [{ type: 'text', text: JSON.stringify({ query_plan_id: 'plan_host_flow' }) }],
        };
      }
      if (input.name === 'run_query_for_user') {
        mocks.runCalls += 1;
        return {
          query_id: 'q_host_flow',
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'success', query_id: 'q_host_flow', rows: [{ probe_value: 22 }] }),
          }],
        };
      }
      throw new Error(`unexpected tool: ${input.name}`);
    }
  },
}));

const APP = 'cli_frozen_host_flow';
const CHAT = 'oc_host_flow';
const ACTOR_OPEN_ID = 'ou_host_actor';
const ACTOR_UNION_ID = 'on_host_actor';
const CAPABILITY = 'ab'.repeat(32);
const COMMAND = '/宿主闭环';
const YAML = `
schemaVersion: 1
status: active
name: 宿主闭环
description: 宿主闭环测试
datasource: tchouse-c
params:
  - name: value
    label: 测试数字
    type: integer
    min: 1
    max: 90
    default: 7
sql: SELECT {{value}} * 2 AS probe_value
output:
  prefix: "真实链路："
  maxChars: 20000
onError: fail
`;

type Loaded = Awaited<ReturnType<typeof loadModules>>;
let root = '';
let dataDir = '';
let modules: Loaded;

async function loadModules() {
  const [daemon, registry, lifecycle, actionStore, ipc, types, workerPool] = await Promise.all([
    import('../src/daemon.js'),
    import('../src/bot-registry.js'),
    import('../src/services/frozen-command-lifecycle.js'),
    import('../src/services/frozen-command-action.js'),
    import('../src/core/dashboard-ipc-server.js'),
    import('../src/core/types.js'),
    import('../src/core/worker-pool.js'),
  ]);
  return { daemon, registry, lifecycle, actionStore, ipc, types, workerPool };
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function makeSession(input: {
  scope: 'thread' | 'chat';
  backendType: 'pty' | 'tmux';
  sourceText: string;
  actorOpenId?: string;
  actorUnionId?: string;
  senderType?: 'user' | 'bot';
}) {
  const turnId = `om_${input.scope}_${input.backendType}_${Math.random().toString(36).slice(2)}`;
  const sessionId = `sess_${input.scope}_${input.backendType}_${Math.random().toString(36).slice(2)}`;
  const rootMessageId = input.scope === 'thread' ? `om_root_${sessionId}` : CHAT;
  const actorOpenId = input.actorOpenId ?? ACTOR_OPEN_ID;
  const actorUnionId = input.actorUnionId ?? ACTOR_UNION_ID;
  const ds = {
    scope: input.scope,
    chatId: CHAT,
    chatType: 'group',
    larkAppId: APP,
    workingDir: root,
    worker: null,
    workerPort: null,
    workerToken: null,
    session: {
      sessionId,
      rootMessageId,
      chatId: CHAT,
      chatType: 'group',
      scope: input.scope,
      cliId: 'codex',
      backendType: input.backendType,
      workingDir: root,
      title: 'host flow',
      status: 'active',
      createdAt: new Date().toISOString(),
    },
    managedTurnOrigin: {
      capability: CAPABILITY,
      turnId,
      dispatchAttempt: 1,
      callerOpenId: actorOpenId,
    },
  } as any;
  modules.daemon.__testOnly_setActiveInteractiveTurn(ds, turnId, {
    requestUserOpenId: actorOpenId,
    requestUserUnionId: actorUnionId,
    requestLarkAppId: APP,
    senderType: input.senderType ?? 'user',
  }, input.sourceText);
  modules.daemon.__testOnly_activeSessions.set(modules.types.sessionKey(rootMessageId, APP), ds);
  return ds;
}

class JsonResponse {
  statusCode = 0;
  payload: Record<string, unknown> = {};
  writeHead(status: number) { this.statusCode = status; return this; }
  end(body?: string) {
    this.payload = body ? JSON.parse(body) as Record<string, unknown> : {};
    return this;
  }
}

async function postIntent(ds: any, rawArgs = '11') {
  const body = {
    sessionId: ds.session.sessionId,
    larkAppId: APP,
    operation: 'run',
    command: COMMAND,
    rawArgs,
    originTurnId: ds.managedTurnOrigin.turnId,
    originDispatchAttempt: 1,
    originCapability: CAPABILITY,
  };
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  const res = new JsonResponse();
  const found = await modules.ipc.__testOnly_dispatchIpcRoute(
    'POST', '/api/frozen-command-actions', req, res as unknown as ServerResponse,
  );
  expect(found).toBe(true);
  return res;
}

function latestPreviewAction(): { action: string; transition_id: string; nonce: string } {
  const parsed = JSON.parse(mocks.cardBodies.at(-1)!) as any;
  return parsed.body.elements.find((element: any) => element.tag === 'action').actions[0].value;
}

function callbackData(
  value: { action: string; transition_id: string; nonce: string },
  operator: { open_id?: string; union_id?: string } = {
    open_id: ACTOR_OPEN_ID,
    union_id: ACTOR_UNION_ID,
  },
) {
  return {
    action: { value },
    operator,
    context: { open_message_id: 'om_card_1' },
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
  } as any;
}

async function waitForStatus(id: string, expected: 'completed' | 'failed') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = modules.actionStore.getFrozenCommandAction(dataDir, id);
    if (row?.status === expected) return row;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`action ${id} did not reach ${expected}`);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.validateCalls = 0;
  mocks.runCalls = 0;
  mocks.cardBodies.length = 0;
  mocks.getMessageChatId.mockResolvedValue(CHAT);
  mocks.getChatMode.mockResolvedValue('group');
  root = mkdtempSync(join(tmpdir(), 'botmux-frozen-host-flow-'));
  dataDir = join(root, 'data');
  process.env.SESSION_DATA_DIR = dataDir;
  mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
  writeFileSync(join(root, '.botmux', 'commands', '宿主闭环.yaml'), YAML);
  modules = await loadModules();
  modules.daemon.__testOnly_activeSessions.clear();
  modules.workerPool.setActiveSessionsRegistry(modules.daemon.__testOnly_activeSessions);
  modules.registry.registerBot({
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'codex',
    backendType: 'tmux',
    plugins: ['data-mcp'],
    allowedUsers: [ACTOR_OPEN_ID],
  });
  const pending = modules.lifecycle.prepareFrozenCommandTransition({
    dataDir,
    targetBotId: APP,
    workingDir: root,
    command: COMMAND,
    action: 'approve',
    actor: { openId: ACTOR_OPEN_ID, unionId: ACTOR_UNION_ID },
    reason: '宿主闭环测试批准',
  });
  modules.lifecycle.confirmFrozenCommandTransition({
    dataDir,
    targetBotId: APP,
    token: pending.token,
    actor: { openId: ACTOR_OPEN_ID, unionId: ACTOR_UNION_ID },
  });
});

afterEach(() => {
  modules?.daemon.__testOnly_activeSessions.clear();
  modules?.workerPool.setActiveSessionsRegistry(undefined);
  delete process.env.SESSION_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('Frozen Command host-owned route → callback → Data MCP flow', () => {
  it.each([
    ['thread', 'pty', '@Current Bot 运行 /宿主闭环 11'],
    ['chat', 'tmux', '运行 /宿主闭环 11 @Current Bot'],
  ] as const)('binds the exact human for %s/%s ingress including bot mentions', async (scope, backendType, sourceText) => {
    const ds = makeSession({ scope, backendType, sourceText });
    const response = await postIntent(ds);
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ status: 'awaiting_input', operation: 'run' });
    const value = latestPreviewAction();
    expect(mocks.cardBodies.at(-1)).not.toContain('SELECT');

    await modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP);
    const completed = await waitForStatus(value.transition_id, 'completed');
    expect(completed).toMatchObject({
      actorOpenId: ACTOR_OPEN_ID,
      actorUnionId: ACTOR_UNION_ID,
      sourceContentHash: hash(sourceText),
      queryId: 'q_host_flow',
    });
    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
  });

  it.each([
    ['unknown', {}],
    ['bot-like different actor', { open_id: 'ou_bot', union_id: 'on_bot' }],
    ['different human', { open_id: 'ou_other', union_id: 'on_other' }],
  ] as const)('rejects %s callback identity before Data MCP', async (_label, operator) => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '运行命令' });
    expect((await postIntent(ds)).statusCode).toBe(200);
    const value = latestPreviewAction();
    const result = await modules.daemon.__testOnly_handleFrozenCommandCardAction(
      callbackData(value, operator), APP,
    );
    expect(result).toMatchObject({ toast: { type: 'error' } });
    expect(modules.actionStore.getFrozenCommandAction(dataDir, value.transition_id)?.status).toBe('pending');
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('rechecks current canTalk so a revoked actor cannot use an old card', async () => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '运行命令' });
    expect((await postIntent(ds)).statusCode).toBe(200);
    const value = latestPreviewAction();
    const bot = modules.registry.getBot(APP);
    bot.resolvedAllowedUsers = [];
    const result = await modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP);
    expect(result).toMatchObject({ toast: { type: 'error' } });
    expect(modules.actionStore.getFrozenCommandAction(dataDir, value.transition_id)?.status).toBe('pending');
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('rejects invalid parameters in the creation route with zero Data MCP calls', async () => {
    const ds = makeSession({ scope: 'chat', backendType: 'pty', sourceText: '运行命令' });
    const response = await postIntent(ds, '0');
    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ ok: false, error: 'parameter_integer_out_of_range' });
    expect(mocks.cardBodies).toHaveLength(0);
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('fails closed when an old card crosses definition hash and lifecycle revision', async () => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '运行命令' });
    expect((await postIntent(ds)).statusCode).toBe(200);
    const value = latestPreviewAction();
    const file = join(root, '.botmux', 'commands', '宿主闭环.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('SELECT {{value}} * 2', 'SELECT {{value}} * 3'));
    const replacement = modules.lifecycle.prepareFrozenCommandTransition({
      dataDir,
      targetBotId: APP,
      workingDir: root,
      command: COMMAND,
      action: 'approve',
      actor: { openId: ACTOR_OPEN_ID, unionId: ACTOR_UNION_ID },
      reason: '批准宿主闭环测试的新版本',
    });
    modules.lifecycle.confirmFrozenCommandTransition({
      dataDir,
      targetBotId: APP,
      token: replacement.token,
      actor: { openId: ACTOR_OPEN_ID, unionId: ACTOR_UNION_ID },
    });

    await modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP);
    const failed = await waitForStatus(value.transition_id, 'failed');
    expect(failed.errorCode).toBe('command_revision_changed');
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('uses DB CAS so concurrent double-clicks produce exactly one validate and one run', async () => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '运行命令' });
    expect((await postIntent(ds)).statusCode).toBe(200);
    const value = latestPreviewAction();
    const [first, second] = await Promise.all([
      modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP),
      modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP),
    ]);
    expect([first, second].some(result => (result as any).toast?.content === '该操作已经结算'
      || (result as any).toast?.content === '正在处理中')).toBe(true);
    await waitForStatus(value.transition_id, 'completed');
    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
  });
});
