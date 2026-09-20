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
  getChatNameAndMode: vi.fn(async () => ({ name: 'Host Flow', mode: 'topic' as const })),
  forkWorker: vi.fn(() => true),
  downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
  getAvailableBots: vi.fn(async () => [] as any[]),
  resolveInboundAudio: vi.fn(async () => ({ kind: 'not_audio' as const })),
  resolveSender: vi.fn(async (_appId: string, openId?: string, senderType?: string) => (
    openId
      ? { openId, unionId: ACTOR_UNION_ID, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
      : undefined
  )),
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
    getChatNameAndMode: mocks.getChatNameAndMode,
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: (...args: any[]) => mocks.forkWorker(...args) };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    downloadResources: (...args: any[]) => mocks.downloadResources(...args),
    getAvailableBots: (...args: any[]) => mocks.getAvailableBots(...args),
  };
});

vi.mock('../src/im/lark/audio-transcribe.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/audio-transcribe.js');
  return { ...actual, resolveInboundAudio: (...args: any[]) => mocks.resolveInboundAudio(...args) };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
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
  // Import daemon first so its worker-pool dependency resolves through the
  // Vitest mock before the test asks for the worker-pool module itself.
  const daemon = await import('../src/daemon.js');
  const registry = await import('../src/bot-registry.js');
  const lifecycle = await import('../src/services/frozen-command-lifecycle.js');
  const actionStore = await import('../src/services/frozen-command-action.js');
  const ipc = await import('../src/core/dashboard-ipc-server.js');
  const types = await import('../src/core/types.js');
  const workerPool = await import('../src/core/worker-pool.js');
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
  senderType?: 'user' | 'bot' | 'unknown';
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
    ...(input.senderType === 'unknown'
      ? {}
      : { senderType: input.senderType ?? 'user' }),
  }, input.sourceText);
  modules.daemon.__testOnly_activeSessions.set(modules.types.sessionKey(rootMessageId, APP), ds);
  return ds;
}

function ingressEvent(messageId: string, text: string, rootId?: string): any {
  return {
    sender: {
      sender_id: { open_id: ACTOR_OPEN_ID, union_id: ACTOR_UNION_ID },
      sender_type: 'user',
    },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      mentions: [{
        key: '@_bot',
        name: 'Current Bot',
        id: { open_id: 'ou_host_bot' },
      }],
      create_time: String(Date.now()),
    },
  };
}

function ingressContext(messageId: string, anchor: string): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    larkAppId: APP,
  };
}

function armManagedOrigin(ds: any): void {
  ds.managedTurnOrigin = {
    capability: CAPABILITY,
    turnId: ds.activeInteractiveTurn.turnId,
    dispatchAttempt: 1,
    callerOpenId: ACTOR_OPEN_ID,
  };
}

async function ingressNewTopic(backendType: 'pty' | 'tmux', rawText: string): Promise<any> {
  const messageId = `om_ingress_new_${Math.random().toString(36).slice(2)}`;
  const bot = modules.registry.getBot(APP);
  bot.config.backendType = backendType;
  await modules.daemon.__testOnly_handleNewTopic(
    ingressEvent(messageId, rawText),
    ingressContext(messageId, messageId),
  );
  const ds = modules.daemon.__testOnly_activeSessions.get(modules.types.sessionKey(messageId, APP));
  expect(ds).toBeDefined();
  armManagedOrigin(ds);
  return ds;
}

async function ingressExistingThread(backendType: 'pty' | 'tmux', rawText: string): Promise<any> {
  const rootMessageId = `om_ingress_root_${Math.random().toString(36).slice(2)}`;
  const bot = modules.registry.getBot(APP);
  bot.config.backendType = backendType;
  await modules.daemon.__testOnly_handleNewTopic(
    ingressEvent(rootMessageId, '初始化宿主闭环会话'),
    ingressContext(rootMessageId, rootMessageId),
  );
  const ds = modules.daemon.__testOnly_activeSessions.get(modules.types.sessionKey(rootMessageId, APP));
  expect(ds).toBeDefined();
  ds.activeInteractiveTurn = undefined;
  ds.worker = { killed: false, send: vi.fn(() => true) };
  const messageId = `om_ingress_reply_${Math.random().toString(36).slice(2)}`;
  await modules.daemon.__testOnly_handleThreadReply(
    ingressEvent(messageId, rawText, rootMessageId),
    ingressContext(messageId, rootMessageId),
  );
  expect(ds.activeInteractiveTurn?.turnId).toBe(messageId);
  armManagedOrigin(ds);
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
  const found = await modules.ipc.__testOnly_dispatchFrozenCommandActionRoute(
    req, res as unknown as ServerResponse,
  );
  expect(found).toBe(true);
  return res;
}

async function postHostIntent(
  ds: any,
  input: { operation?: 'list' | 'run'; rawArgs?: string; turnId?: string } = {},
) {
  const operation = input.operation ?? 'run';
  const body = {
    sessionId: ds.session.sessionId,
    larkAppId: APP,
    operation,
    ...(operation === 'run'
      ? { command: COMMAND, rawArgs: input.rawArgs ?? '11' }
      : {}),
    originTurnId: input.turnId ?? ds.managedTurnOrigin.turnId,
  };
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  const res = new JsonResponse();
  const found = await modules.ipc.__testOnly_dispatchFrozenCommandActionRoute(
    req,
    res as unknown as ServerResponse,
    { trustedHost: true },
  );
  expect(found).toBe(true);
  return res;
}

async function postUntrustedIntentWithoutCapability(ds: any) {
  const req = Readable.from([JSON.stringify({
    sessionId: ds.session.sessionId,
    larkAppId: APP,
    operation: 'list',
    originTurnId: ds.managedTurnOrigin.turnId,
  })]) as unknown as IncomingMessage;
  const res = new JsonResponse();
  const found = await modules.ipc.__testOnly_dispatchFrozenCommandActionRoute(
    req,
    res as unknown as ServerResponse,
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
  mocks.getChatNameAndMode.mockResolvedValue({ name: 'Host Flow', mode: 'topic' });
  mocks.forkWorker.mockReturnValue(true);
  mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
  mocks.getAvailableBots.mockResolvedValue([]);
  mocks.resolveInboundAudio.mockResolvedValue({ kind: 'not_audio' });
  root = mkdtempSync(join(tmpdir(), 'botmux-frozen-host-flow-'));
  dataDir = join(root, 'data');
  process.env.SESSION_DATA_DIR = dataDir;
  mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
  writeFileSync(join(root, '.botmux', 'commands', '宿主闭环.yaml'), YAML);
  modules = await loadModules();
  modules.daemon.__testOnly_activeSessions.clear();
  modules.workerPool.setActiveSessionsRegistry(modules.daemon.__testOnly_activeSessions);
  const bot = modules.registry.registerBot({
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'codex',
    backendType: 'tmux',
    plugins: ['data-mcp'],
    allowedUsers: [ACTOR_OPEN_ID],
    workingDir: root,
    oncallChats: [{ chatId: CHAT, workingDir: root }],
  });
  bot.botOpenId = 'ou_host_bot';
  bot.botName = 'Current Bot';
  bot.resolvedAllowedUsers = [ACTOR_OPEN_ID];
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
}, 30_000);

afterEach(() => {
  modules?.daemon.__testOnly_activeSessions.clear();
  modules?.workerPool.setActiveSessionsRegistry(undefined);
  delete process.env.SESSION_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('Frozen Command host-owned route → callback → Data MCP flow', () => {
  it('allows a trusted host tool runner to list using the exact active turn without a capability file', async () => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '查看固化命令' });
    const response = await postHostIntent(ds, { operation: 'list' });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ status: 'presented', operation: 'list' });
    expect(mocks.cardBodies).toHaveLength(1);
    expect(mocks.cardBodies[0]).not.toContain('SELECT');
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('lists only current-bot commands and keeps parser details out of the business card', async () => {
    const foreignCommand = '外部废弃命令';
    const foreignFile = join(root, '.botmux', 'commands', `${foreignCommand}.yaml`);
    writeFileSync(foreignFile, YAML
      .replace('name: 宿主闭环', `name: ${foreignCommand}`)
      .replace('description: 宿主闭环测试', 'description: 另一机器人的命令'));
    const foreignActor = { openId: 'ou_foreign_actor', unionId: 'on_foreign_actor' };
    const approve = modules.lifecycle.prepareFrozenCommandTransition({
      dataDir,
      targetBotId: 'cli_foreign_bot',
      workingDir: root,
      command: `/${foreignCommand}`,
      action: 'approve',
      actor: foreignActor,
      reason: '另一机器人批准',
    });
    modules.lifecycle.confirmFrozenCommandTransition({
      dataDir,
      targetBotId: 'cli_foreign_bot',
      token: approve.token,
      actor: foreignActor,
    });
    const retire = modules.lifecycle.prepareFrozenCommandTransition({
      dataDir,
      targetBotId: 'cli_foreign_bot',
      workingDir: root,
      command: `/${foreignCommand}`,
      action: 'retire',
      actor: foreignActor,
      reason: '另一机器人已废弃',
    });
    modules.lifecycle.confirmFrozenCommandTransition({
      dataDir,
      targetBotId: 'cli_foreign_bot',
      token: retire.token,
      actor: foreignActor,
    });
    writeFileSync(join(root, '.botmux', 'commands', '损坏命令.yaml'), `
schemaVersion: 1
status: active
name: 损坏命令
description: 不应暴露解析细节
unexpectedInternalField: true
`);

    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '查看固化命令' });
    const response = await postHostIntent(ds, { operation: 'list' });
    expect(response.statusCode).toBe(200);
    const rendered = mocks.cardBodies.at(-1)!;
    expect(rendered).toContain('/宿主闭环');
    expect(rendered).not.toContain(`/${foreignCommand}`);
    expect(rendered).toContain('/损坏命令');
    expect(rendered).toContain('命令定义或状态异常');
    expect(rendered).not.toContain('unexpectedInternalField');
    expect(rendered).not.toContain('包含未知字段');
    expect(rendered).toContain('当前机器人');
    expect(rendered).toContain('Current Bot');
    expect(rendered).toContain('工作目录');
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('keeps missing-capability callers untrusted unless they crossed host HMAC', async () => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '查看固化命令' });
    const response = await postUntrustedIntentWithoutCapability(ds);
    expect(response.statusCode).toBe(403);
    expect(mocks.cardBodies).toHaveLength(0);
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('rejects a trusted host request whose turn id is stale', async () => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '查看固化命令' });
    const response = await postHostIntent(ds, { operation: 'list', turnId: 'om_stale_turn' });
    expect(response.statusCode).toBe(403);
    expect(response.payload).toMatchObject({ ok: false, error: 'origin_identity_mismatch' });
    expect(mocks.cardBodies).toHaveLength(0);
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('binds a trusted host run to the live actor and still requires the actor callback', async () => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '运行命令' });
    delete ds.managedTurnOrigin.dispatchAttempt;
    const response = await postHostIntent(ds);
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ status: 'awaiting_input', operation: 'run' });
    const value = latestPreviewAction();

    await modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP);
    const completed = await waitForStatus(value.transition_id, 'completed');
    expect(completed).toMatchObject({
      actorOpenId: ACTOR_OPEN_ID,
      actorUnionId: ACTOR_UNION_ID,
      dispatchAttempt: 0,
      queryId: 'q_host_flow',
    });
    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
  });

  it.each([
    ['new-topic', 'pty', '@_bot 运行 /宿主闭环 11', '@Current Bot 运行 /宿主闭环 11'],
    ['existing-thread', 'tmux', '运行 /宿主闭环 11 @_bot', '运行 /宿主闭环 11 @Current Bot'],
  ] as const)('binds the exact human through real %s/%s ingress including bot mentions', async (
    ingress,
    backendType,
    rawText,
    normalizedText,
  ) => {
    const ds = ingress === 'new-topic'
      ? await ingressNewTopic(backendType, rawText)
      : await ingressExistingThread(backendType, rawText);
    expect(modules.registry.getBot(APP).config.backendType).toBe(backendType);
    expect(ds.activeInteractiveTurn).toMatchObject({
      caller: {
        requestUserOpenId: ACTOR_OPEN_ID,
        requestUserUnionId: ACTOR_UNION_ID,
        requestLarkAppId: APP,
        senderType: 'user',
      },
      sourceContentHash: hash(normalizedText),
    });
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
      sourceContentHash: hash(normalizedText),
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

  it.each([
    ['bot', 'bot'],
    ['unknown', 'unknown'],
  ] as const)('rejects a %s active turn in the creation route before card or Data MCP', async (
    _label,
    senderType,
  ) => {
    const ds = makeSession({
      scope: 'thread',
      backendType: 'tmux',
      sourceText: '运行命令',
      senderType,
    });
    const response = await postIntent(ds);
    expect(response.statusCode).toBe(403);
    expect(response.payload).toMatchObject({ ok: false, error: 'trusted_human_required' });
    expect(mocks.cardBodies).toHaveLength(0);
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('rechecks current canTalk so a revoked actor cannot use an old card', async () => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '运行命令' });
    expect((await postIntent(ds)).statusCode).toBe(200);
    const value = latestPreviewAction();
    const bot = modules.registry.getBot(APP);
    bot.resolvedAllowedUsers = [];
    bot.config.oncallChats = [];
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
