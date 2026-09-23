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
  runResultShape: 'text' as 'top-level' | 'structured' | 'text' | 'malformed' | 'missing',
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

vi.mock('../src/services/grant-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/grant-store.js');
  return {
    ...actual,
    consumeQuota: vi.fn(async () => ({
      tracked: false,
      allow: true,
      exhausted: false,
      used: 0,
      limit: 0,
    })),
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
        if (mocks.runResultShape === 'top-level') {
          return {
            query_id: 'q_host_flow',
            content: [{ type: 'text', text: JSON.stringify({ status: 'success', rows: [{ probe_value: 22 }] }) }],
          };
        }
        if (mocks.runResultShape === 'structured') {
          return {
            structuredContent: { status: 'success', query_id: 'q_host_flow', rows: [{ probe_value: 22 }] },
            content: [{ type: 'text', text: JSON.stringify({ status: 'success', rows: [{ probe_value: 22 }] }) }],
          };
        }
        if (mocks.runResultShape === 'malformed') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'success', query_id: 42, rows: [{ probe_value: 22 }] }) }],
          };
        }
        if (mocks.runResultShape === 'missing') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'success', rows: [{ probe_value: 22 }] }) }],
          };
        }
        return {
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
const GRANT_CHAT = 'oc_grant_only';
const ACTOR_OPEN_ID = 'ou_host_actor';
const ACTOR_UNION_ID = 'on_host_actor';
const GRANT_GUEST_OPEN_ID = 'ou_grant_guest';
const GRANT_GUEST_UNION_ID = 'on_grant_guest';
const CAPABILITY = 'ab'.repeat(32);
const COMMAND = '/宿主闭环';
const YAML = `
schemaVersion: 2
status: active
name: 宿主闭环
description: 宿主闭环测试
executor: builtin.data-mcp.readonly
params:
  - name: value
    label: 测试数字
    type: integer
    min: 1
    max: 90
    default: 7
input:
  datasource: tchouse-c
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
  const frozenCommand = await import('../src/services/frozen-command.js');
  const lifecycle = await import('../src/services/frozen-command-lifecycle.js');
  const actionStore = await import('../src/services/frozen-command-action.js');
  const ipc = await import('../src/core/dashboard-ipc-server.js');
  const types = await import('../src/core/types.js');
  const workerPool = await import('../src/core/worker-pool.js');
  return { daemon, registry, frozenCommand, lifecycle, actionStore, ipc, types, workerPool };
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function makeSession(input: {
  scope: 'thread' | 'chat';
  backendType: 'pty' | 'tmux';
  sourceText: string;
  chatId?: string;
  actorOpenId?: string;
  actorUnionId?: string;
  senderType?: 'user' | 'bot' | 'unknown';
}) {
  const turnId = `om_${input.scope}_${input.backendType}_${Math.random().toString(36).slice(2)}`;
  const sessionId = `sess_${input.scope}_${input.backendType}_${Math.random().toString(36).slice(2)}`;
  const chatId = input.chatId ?? CHAT;
  const rootMessageId = input.scope === 'thread' ? `om_root_${sessionId}` : chatId;
  const actorOpenId = input.actorOpenId ?? ACTOR_OPEN_ID;
  const actorUnionId = input.actorUnionId ?? ACTOR_UNION_ID;
  const ds = {
    scope: input.scope,
    chatId,
    chatType: 'group',
    larkAppId: APP,
    workingDir: root,
    worker: null,
    workerPort: null,
    workerToken: null,
    session: {
      sessionId,
      rootMessageId,
      chatId,
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

function ingressEvent(
  messageId: string,
  text: string,
  rootId?: string,
  input: { chatId?: string; openId?: string; unionId?: string } = {},
): any {
  return {
    sender: {
      sender_id: {
        open_id: input.openId ?? ACTOR_OPEN_ID,
        union_id: input.unionId ?? ACTOR_UNION_ID,
      },
      sender_type: 'user',
    },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: input.chatId ?? CHAT,
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

function ingressContext(messageId: string, anchor: string, chatId = CHAT): any {
  return {
    chatId,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    larkAppId: APP,
  };
}

function enableGrantCommandRestriction(chatId = GRANT_CHAT): void {
  const bot = modules.registry.getBot(APP);
  bot.config.restrictGrantCommands = true;
  bot.config.chatGrants = { [chatId]: [GRANT_GUEST_OPEN_ID] };
  mocks.getMessageChatId.mockResolvedValue(chatId);
}

function installApprovedCommand(command: string): void {
  const name = command.replace(/^\//u, '');
  writeFileSync(
    join(root, '.botmux', 'commands', `${name}.yaml`),
    YAML.replaceAll('宿主闭环', name),
  );
  const pending = modules.lifecycle.prepareFrozenCommandTransition({
    dataDir,
    targetBotId: APP,
    workingDir: root,
    command,
    action: 'approve',
    actor: { openId: ACTOR_OPEN_ID, unionId: ACTOR_UNION_ID },
    actorIsAdmin: true,
    reason: `批准 ${command} 用于授权闸测试`,
  });
  modules.lifecycle.confirmFrozenCommandTransition({
    dataDir,
    targetBotId: APP,
    token: pending.token,
    actor: { openId: ACTOR_OPEN_ID, unionId: ACTOR_UNION_ID },
    actorIsAdmin: true,
  });
}

function grantGuestEvent(messageId: string, text: string, rootId?: string): any {
  return ingressEvent(messageId, text, rootId, {
    chatId: GRANT_CHAT,
    openId: GRANT_GUEST_OPEN_ID,
    unionId: GRANT_GUEST_UNION_ID,
  });
}

async function dispatchGrantGuestNewTopic(text: string): Promise<string> {
  const messageId = `om_grant_new_${Math.random().toString(36).slice(2)}`;
  await modules.daemon.__testOnly_handleNewTopic(
    grantGuestEvent(messageId, text),
    ingressContext(messageId, messageId, GRANT_CHAT),
  );
  return messageId;
}

async function dispatchGrantGuestExistingThread(text: string): Promise<{
  rootMessageId: string;
  workerSend: ReturnType<typeof vi.fn>;
}> {
  const rootMessageId = `om_grant_root_${Math.random().toString(36).slice(2)}`;
  await modules.daemon.__testOnly_handleNewTopic(
    ingressEvent(rootMessageId, '初始化授权访客测试会话', undefined, { chatId: GRANT_CHAT }),
    ingressContext(rootMessageId, rootMessageId, GRANT_CHAT),
  );
  const ds = modules.daemon.__testOnly_activeSessions.get(modules.types.sessionKey(rootMessageId, APP));
  expect(ds).toBeDefined();
  ds.activeInteractiveTurn = undefined;
  const workerSend = vi.fn(() => true);
  ds.worker = { killed: false, send: workerSend };
  mocks.cardBodies.length = 0;
  mocks.validateCalls = 0;
  mocks.runCalls = 0;

  const messageId = `om_grant_reply_${Math.random().toString(36).slice(2)}`;
  await modules.daemon.__testOnly_handleThreadReply(
    grantGuestEvent(messageId, text, rootMessageId),
    ingressContext(messageId, rootMessageId, GRANT_CHAT),
  );
  return { rootMessageId, workerSend };
}

async function routeGrantGuestCommand(commandContent: string, chatId = GRANT_CHAT): Promise<void> {
  const cmd = commandContent.trim().split(/\s+/u)[0]!;
  await modules.daemon.__testOnly_routeFrozenCommand({
    cmd,
    commandContent,
    workingDir: root,
    larkAppId: APP,
    chatId,
    chatType: 'group',
    anchor: 'om_grant_route',
    turnId: 'om_grant_route',
    senderOpenId: GRANT_GUEST_OPEN_ID,
    senderUnionId: GRANT_GUEST_UNION_ID,
    senderIsBot: false,
    mentions: [],
    reply: async (_anchor: string, content: string) => {
      mocks.cardBodies.push(content);
      return `om_grant_card_${mocks.cardBodies.length}`;
    },
  });
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

function seedLegacyPendingRun(ds: any, rawArgs = '11'): {
  action: string;
  transition_id: string;
  nonce: string;
} {
  const lifecycle = modules.lifecycle.evaluateFrozenCommandLifecycle({
    dataDir,
    targetBotId: APP,
    workingDir: root,
    command: COMMAND,
  });
  if (lifecycle.kind !== 'active') throw new Error(`expected active command, got ${lifecycle.kind}`);
  const lookup = modules.frozenCommand.lookupFrozenCommand({ workingDir: root, command: COMMAND });
  if (lookup.kind !== 'found') throw new Error(`expected installed command, got ${lookup.kind}`);
  const normalizedArgs = modules.frozenCommand.normalizeFrozenCommandArguments({
    definition: lookup.snapshot.definition,
    rawArgs,
  }).args;
  const created = modules.actionStore.createFrozenCommandAction(dataDir, {
    targetBotId: APP,
    chatId: ds.chatId,
    chatType: ds.chatType,
    rootMessageId: ds.scope === 'thread' ? ds.session.rootMessageId : ds.chatId,
    scope: ds.scope,
    sessionId: ds.session.sessionId,
    turnId: ds.activeInteractiveTurn.turnId,
    dispatchAttempt: ds.managedTurnOrigin.dispatchAttempt ?? 0,
    workingDir: root,
    sourceMessageId: ds.activeInteractiveTurn.turnId,
    sourceContentHash: ds.activeInteractiveTurn.sourceContentHash,
    intentSchemaVersion: 'botmux.frozen-command-intent.v1',
    parserVersion: 'frozen-command-args.v1',
    actorOpenId: ds.activeInteractiveTurn.caller.requestUserOpenId,
    actorUnionId: ds.activeInteractiveTurn.caller.requestUserUnionId,
    command: COMMAND.slice(1),
    rawArgs,
    normalizedArgs,
    datasource: typeof lookup.snapshot.definition.input.datasource === 'string'
      ? lookup.snapshot.definition.input.datasource
      : undefined,
    executorId: lookup.snapshot.definition.executor,
    executorRevision: lifecycle.record.executorRevision!,
    specHash: lifecycle.record.specHash!,
    revisionId: lifecycle.record.stateRevisionId,
  });
  expect(modules.actionStore.bindFrozenCommandActionCard(dataDir, created.record.id, 'om_card_1')).toBe(true);
  mocks.getMessageChatId.mockResolvedValue(ds.chatId);
  return {
    action: 'frozen_command_run_confirm',
    transition_id: created.record.id,
    nonce: created.nonce,
  };
}

async function postHostIntent(
  ds: any,
  input: {
    operation?: 'list' | 'run' | 'approve' | 'retire' | 'restore' | 'revoke';
    rawArgs?: string;
    turnId?: string;
    reason?: string;
    replacement?: string;
    definitionYaml?: string;
    command?: string;
  } = {},
) {
  const operation = input.operation ?? 'run';
  const body = {
    sessionId: ds.session.sessionId,
    larkAppId: APP,
    operation,
    ...(operation === 'run'
      ? { command: COMMAND, rawArgs: input.rawArgs ?? '11' }
      : operation === 'list'
        ? {}
        : {
            command: input.command ?? COMMAND,
            reason: input.reason ?? '宿主状态变更测试',
            ...(input.replacement ? { replacement: input.replacement } : {}),
            ...(input.definitionYaml ? { definitionYaml: input.definitionYaml } : {}),
          }),
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

function latestLifecycleAction(): { action: string; transition_token: string } {
  const parsed = JSON.parse(mocks.cardBodies.at(-1)!) as any;
  const row = parsed.body.elements.find((element: any) => element.tag === 'column_set');
  const button = row.columns[0].elements.find((element: any) => element.tag === 'button');
  return button.behaviors.find((behavior: any) => behavior.type === 'callback').value;
}

function callbackData(
  value: { action: string; transition_id?: string; nonce?: string; transition_token?: string },
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
  mocks.runResultShape = 'text';
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
    frozenCommandAdmins: [ACTOR_UNION_ID],
    workingDir: root,
    defaultWorkingDir: root,
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
    actorIsAdmin: true,
    reason: '宿主闭环测试批准',
  });
  modules.lifecycle.confirmFrozenCommandTransition({
    dataDir,
    targetBotId: APP,
    token: pending.token,
    actor: { openId: ACTOR_OPEN_ID, unionId: ACTOR_UNION_ID },
    actorIsAdmin: true,
  });
}, 30_000);

afterEach(() => {
  modules?.daemon.__testOnly_activeSessions.clear();
  modules?.workerPool.setActiveSessionsRegistry(undefined);
  delete process.env.SESSION_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('Frozen Command host-owned route → callback → Data MCP flow', () => {
  it('parses lifecycle intent with an exact operation-specific shape', () => {
    const base = {
      sessionId: 'sess',
      larkAppId: APP,
      originTurnId: 'om_turn',
    };
    expect(modules.daemon.__testOnly_parseFrozenCommandIntentBody({
      ...base,
      operation: 'approve',
      command: COMMAND,
      reason: '创建命令',
      definitionYaml: YAML,
    })).toMatchObject({ operation: 'approve', command: COMMAND });
    expect(modules.daemon.__testOnly_parseFrozenCommandIntentBody({
      ...base,
      operation: 'approve',
      command: COMMAND,
      reason: '缺少候选内容',
    })).toBeUndefined();
    expect(modules.daemon.__testOnly_parseFrozenCommandIntentBody({
      ...base,
      operation: 'list',
      definitionYaml: YAML,
    })).toBeUndefined();
  });

  it('executes an exact natural-language command in a new topic without creating a CLI session or card', async () => {
    const messageId = `om_direct_new_${Math.random().toString(36).slice(2)}`;
    await modules.daemon.__testOnly_handleNewTopic(
      ingressEvent(messageId, '@_bot 运行 /宿主闭环 11'),
      ingressContext(messageId, messageId),
    );

    expect(modules.daemon.__testOnly_activeSessions.get(modules.types.sessionKey(messageId, APP))).toBeUndefined();
    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
    expect(mocks.cardBodies).toHaveLength(1);
    expect(mocks.cardBodies[0]).toContain('真实链路：');
    expect(mocks.cardBodies[0]).not.toContain('确认执行');
  });

  it('rejects a valid command definition that the current bot has not approved', async () => {
    const command = '未批准';
    writeFileSync(
      join(root, '.botmux', 'commands', `${command}.yaml`),
      YAML
        .replace('status: active\n', '')
        .replaceAll('宿主闭环', command),
    );
    const messageId = `om_unapproved_${Math.random().toString(36).slice(2)}`;

    await modules.daemon.__testOnly_handleNewTopic(
      ingressEvent(messageId, `@_bot /${command} 11`),
      ingressContext(messageId, messageId),
    );

    expect(modules.daemon.__testOnly_activeSessions.get(modules.types.sessionKey(messageId, APP))).toBeUndefined();
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.cardBodies.at(-1)).toContain('尚未完成当前机器人批准');
    expect(mocks.cardBodies.every(body => !body.includes('真实链路：'))).toBe(true);
  });

  it('returns a stable public error when an approved definition drifts', async () => {
    writeFileSync(
      join(root, '.botmux', 'commands', '宿主闭环.yaml'),
      YAML.replace('SELECT {{value}} * 2', 'SELECT {{value}} * 3'),
    );
    const messageId = `om_drifted_${Math.random().toString(36).slice(2)}`;

    await modules.daemon.__testOnly_handleNewTopic(
      ingressEvent(messageId, '@_bot /宿主闭环 11'),
      ingressContext(messageId, messageId),
    );

    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.cardBodies.at(-1)).toContain('固化命令状态异常，已拒绝执行');
    expect(mocks.cardBodies.at(-1)).not.toContain('定义与已批准版本不一致');
  });

  it('executes an exact natural-language command in an existing thread once without forwarding to the CLI', async () => {
    const rootMessageId = `om_direct_root_${Math.random().toString(36).slice(2)}`;
    await modules.daemon.__testOnly_handleNewTopic(
      ingressEvent(rootMessageId, '初始化宿主闭环会话'),
      ingressContext(rootMessageId, rootMessageId),
    );
    const ds = modules.daemon.__testOnly_activeSessions.get(modules.types.sessionKey(rootMessageId, APP));
    expect(ds).toBeDefined();
    const workerSend = vi.fn(() => true);
    ds.worker = { killed: false, send: workerSend };
    mocks.cardBodies.length = 0;
    mocks.validateCalls = 0;
    mocks.runCalls = 0;

    const messageId = `om_direct_reply_${Math.random().toString(36).slice(2)}`;
    await modules.daemon.__testOnly_handleThreadReply(
      ingressEvent(messageId, '运行 /宿主闭环 11 @_bot', rootMessageId),
      ingressContext(messageId, rootMessageId),
    );

    expect(workerSend).not.toHaveBeenCalled();
    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
    expect(mocks.cardBodies).toHaveLength(1);
    expect(mocks.cardBodies[0]).toContain('真实链路：');
    expect(mocks.cardBodies[0]).not.toContain('确认执行');
  });

  it('blocks a grant-only visitor natural-language command in a new topic before Data MCP', async () => {
    enableGrantCommandRestriction();
    installApprovedCommand('/report');

    await dispatchGrantGuestNewTopic('@_bot 运行 /report 11');

    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.cardBodies.at(-1)).toContain('当前授权仅允许普通对话');
    expect(mocks.cardBodies.every(body => !body.includes('真实链路：'))).toBe(true);
  });

  it('blocks a grant-only visitor natural-language command in an existing thread before Data MCP', async () => {
    enableGrantCommandRestriction();
    installApprovedCommand('/report');

    const { workerSend } = await dispatchGrantGuestExistingThread('运行 /report 11 @_bot');

    expect(workerSend).not.toHaveBeenCalled();
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.cardBodies.at(-1)).toContain('当前授权仅允许普通对话');
    expect(mocks.cardBodies.every(body => !body.includes('真实链路：'))).toBe(true);
  });

  it('blocks a grant-only visitor direct non-ASCII command in a new topic before Data MCP', async () => {
    enableGrantCommandRestriction();

    await dispatchGrantGuestNewTopic('@_bot /宿主闭环 11');

    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.cardBodies.at(-1)).toContain('当前授权仅允许普通对话');
    expect(mocks.cardBodies.every(body => !body.includes('真实链路：'))).toBe(true);
  });

  it('blocks a grant-only visitor direct non-ASCII command in an existing thread before Data MCP', async () => {
    enableGrantCommandRestriction();

    const { workerSend } = await dispatchGrantGuestExistingThread('/宿主闭环 11 @_bot');

    expect(workerSend).not.toHaveBeenCalled();
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.cardBodies.at(-1)).toContain('当前授权仅允许普通对话');
    expect(mocks.cardBodies.every(body => !body.includes('真实链路：'))).toBe(true);
  });

  it.each([
    ['/freeze list'],
    ['/freeze rm /宿主闭环 --reason 访客不得发起状态变更'],
    ['/freeze confirm abcdefghijklmnopqrstuvwx'],
  ])('blocks a grant-only visitor across the host-owned %s command family', async (commandContent) => {
    enableGrantCommandRestriction();

    await routeGrantGuestCommand(commandContent);

    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.cardBodies).toHaveLength(1);
    expect(mocks.cardBodies[0]).toContain('当前授权仅允许普通对话');
    expect(mocks.cardBodies[0]).not.toContain('/宿主闭环（revision');
    expect(mocks.cardBodies[0]).not.toContain('确认废弃');
  });

  it('keeps an allowed user eligible for frozen-command direct execution when grant commands are restricted', async () => {
    enableGrantCommandRestriction();
    const messageId = `om_grant_owner_${Math.random().toString(36).slice(2)}`;

    await modules.daemon.__testOnly_handleNewTopic(
      ingressEvent(messageId, '@_bot 运行 /宿主闭环 11', undefined, { chatId: GRANT_CHAT }),
      ingressContext(messageId, messageId, GRANT_CHAT),
    );

    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
    expect(mocks.cardBodies.at(-1)).toContain('真实链路：');
  });

  it('keeps an oncall chat member eligible for frozen-command direct execution when grant commands are restricted', async () => {
    enableGrantCommandRestriction(CHAT);

    await routeGrantGuestCommand('/宿主闭环 11', CHAT);

    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
    expect(mocks.cardBodies.at(-1)).toContain('真实链路：');
  });

  it('keeps an allowed chat-group member eligible for frozen-command direct execution when grant commands are restricted', async () => {
    enableGrantCommandRestriction();
    modules.registry.getBot(APP).config.allowedChatGroups = [GRANT_CHAT];
    const messageId = `om_grant_group_${Math.random().toString(36).slice(2)}`;

    await modules.daemon.__testOnly_handleNewTopic(
      grantGuestEvent(messageId, '@_bot 运行 /宿主闭环 11'),
      ingressContext(messageId, messageId, GRANT_CHAT),
    );

    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
    expect(mocks.cardBodies.at(-1)).toContain('真实链路：');
  });

  it('lets a grant-only visitor unknown natural-language command fall through as ordinary conversation', async () => {
    enableGrantCommandRestriction();
    mocks.forkWorker.mockClear();

    const messageId = await dispatchGrantGuestNewTopic('@_bot 运行 /不存在 11');

    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(modules.daemon.__testOnly_activeSessions.get(modules.types.sessionKey(messageId, APP))).toBeDefined();
    expect(mocks.cardBodies.every(body => !body.includes('当前授权仅允许普通对话'))).toBe(true);
  });

  it('does not mistake an unknown non-ASCII slash path for a restricted frozen command', async () => {
    enableGrantCommandRestriction();
    mocks.forkWorker.mockClear();

    const messageId = await dispatchGrantGuestNewTopic('@_bot /资料目录 请帮我查看这里');

    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(modules.daemon.__testOnly_activeSessions.get(modules.types.sessionKey(messageId, APP))).toBeDefined();
    expect(mocks.cardBodies.every(body => !body.includes('当前授权仅允许普通对话'))).toBe(true);
  });

  it('does not route a bot-authored natural-language command through the host in a new topic', async () => {
    const messageId = `om_direct_bot_new_${Math.random().toString(36).slice(2)}`;
    const event = ingressEvent(messageId, '@_bot 运行 /宿主闭环 11');
    event.sender.sender_type = 'bot';

    await modules.daemon.__testOnly_handleNewTopic(
      event,
      ingressContext(messageId, messageId),
    );

    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.cardBodies.every(body => !body.includes('真实链路：'))).toBe(true);
  });

  it('does not route a bot-authored natural-language command through the host in an existing thread', async () => {
    const rootMessageId = `om_direct_bot_root_${Math.random().toString(36).slice(2)}`;
    await modules.daemon.__testOnly_handleNewTopic(
      ingressEvent(rootMessageId, '初始化宿主闭环会话'),
      ingressContext(rootMessageId, rootMessageId),
    );
    const ds = modules.daemon.__testOnly_activeSessions.get(modules.types.sessionKey(rootMessageId, APP));
    expect(ds).toBeDefined();
    ds.activeInteractiveTurn = undefined;
    ds.worker = { killed: false, send: vi.fn(() => true) };
    mocks.cardBodies.length = 0;
    mocks.validateCalls = 0;
    mocks.runCalls = 0;

    const messageId = `om_direct_bot_reply_${Math.random().toString(36).slice(2)}`;
    const event = ingressEvent(messageId, '运行 /宿主闭环 11 @_bot', rootMessageId);
    event.sender.sender_type = 'bot';
    await modules.daemon.__testOnly_handleThreadReply(
      event,
      ingressContext(messageId, rootMessageId),
    );

    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
    expect(mocks.cardBodies.every(body => !body.includes('真实链路：'))).toBe(true);
  });

  it('does not let a bot sender enumerate frozen commands', async () => {
    const messageId = `om_bot_list_${Math.random().toString(36).slice(2)}`;
    const event = ingressEvent(messageId, '@_bot /freeze list');
    event.sender.sender_type = 'bot';

    await modules.daemon.__testOnly_handleNewTopic(
      event,
      ingressContext(messageId, messageId),
    );

    expect(mocks.cardBodies.at(-1)).toContain('只有身份明确的真人消息可以查看固化命令');
    expect(mocks.cardBodies.at(-1)).not.toContain('/宿主闭环');
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('does not let a bot sender initiate a frozen-command lifecycle transition', async () => {
    const messageId = `om_bot_transition_${Math.random().toString(36).slice(2)}`;
    const event = ingressEvent(
      messageId,
      '@_bot /freeze rm /宿主闭环 --reason 机器人不得发起状态变更',
    );
    event.sender.sender_type = 'bot';

    await modules.daemon.__testOnly_handleNewTopic(
      event,
      ingressContext(messageId, messageId),
    );

    expect(mocks.cardBodies.at(-1)).toContain('只有身份明确的真人消息可以发起固化命令状态变更');
    expect(mocks.cardBodies.at(-1)).not.toContain('确认废弃');
  });

  it('does not let a bot sender confirm a frozen-command lifecycle transition', async () => {
    const pending = modules.lifecycle.prepareFrozenCommandTransition({
      dataDir,
      targetBotId: APP,
      workingDir: root,
      command: COMMAND,
      action: 'retire',
      actor: { openId: ACTOR_OPEN_ID, unionId: ACTOR_UNION_ID },
      actorIsAdmin: true,
      reason: '验证机器人不能确认状态变更',
    });
    const messageId = `om_bot_confirm_${Math.random().toString(36).slice(2)}`;
    const event = ingressEvent(messageId, `@_bot /freeze confirm ${pending.token}`);
    event.sender.sender_type = 'bot';

    await modules.daemon.__testOnly_handleNewTopic(
      event,
      ingressContext(messageId, messageId),
    );

    expect(mocks.cardBodies.at(-1)).toContain('只有身份明确的真人消息可以确认固化命令状态变更');
    expect(modules.lifecycle.evaluateFrozenCommandLifecycle({
      dataDir,
      targetBotId: APP,
      workingDir: root,
      command: COMMAND,
    }).kind).toBe('active');
  });

  it.each([
    ['top-level', 'top-level'],
    ['structuredContent', 'structured'],
    ['content[].text JSON', 'text'],
  ] as const)('persists query_id from the %s MCP result shape', async (_label, shape) => {
    mocks.runResultShape = shape;
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '运行命令' });
    const value = seedLegacyPendingRun(ds);

    await modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP);
    const completed = await waitForStatus(value.transition_id, 'completed');
    expect(completed.queryId).toBe('q_host_flow');
    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
  });

  it.each([
    ['malformed', 'malformed'],
    ['missing', 'missing'],
  ] as const)('fails closed for a %s query_id without replay or model fallback', async (_label, shape) => {
    mocks.runResultShape = shape;
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '运行命令' });
    const value = seedLegacyPendingRun(ds);

    await modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP);
    const failed = await waitForStatus(value.transition_id, 'failed');
    expect(failed).toMatchObject({ errorCode: 'query_id_missing' });
    expect(failed.queryId).toBeUndefined();
    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
    expect(mocks.cardBodies.at(-1)).toContain('不会回退模型');

    await modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP);
    expect(mocks.validateCalls).toBe(1);
    expect(mocks.runCalls).toBe(1);
  });

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

  it.each([
    ['list', { operation: 'list' as const }],
    ['apply', { operation: 'approve' as const, definitionYaml: YAML, reason: '授权访客不得创建命令' }],
    ['rm', { operation: 'retire' as const, reason: '授权访客不得废弃命令' }],
    ['run', { operation: 'run' as const, rawArgs: '11' }],
  ])('rejects grant-only visitors at the host action endpoint for %s without posting a card', async (
    _label,
    request,
  ) => {
    enableGrantCommandRestriction();
    const ds = makeSession({
      scope: 'thread',
      backendType: 'tmux',
      sourceText: '固化命令宿主意图',
      chatId: GRANT_CHAT,
      actorOpenId: GRANT_GUEST_OPEN_ID,
      actorUnionId: GRANT_GUEST_UNION_ID,
    });
    const response = await postHostIntent(ds, request);

    expect(response.statusCode).toBe(403);
    expect(response.payload).toMatchObject({ ok: false, error: 'grant_command_restricted' });
    expect(mocks.cardBodies).toHaveLength(0);
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('keeps the host action endpoint available to allowedUsers when grant commands are restricted', async () => {
    enableGrantCommandRestriction();
    const ds = makeSession({
      scope: 'thread',
      backendType: 'tmux',
      sourceText: '查看固化命令',
      chatId: GRANT_CHAT,
    });
    const response = await postHostIntent(ds, { operation: 'list' });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ status: 'presented', operation: 'list' });
    expect(mocks.cardBodies).toHaveLength(1);
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('rejects a pre-fix grant-only run card when the visitor confirms it', async () => {
    const ds = makeSession({
      scope: 'thread',
      backendType: 'tmux',
      sourceText: '运行命令',
      chatId: GRANT_CHAT,
      actorOpenId: GRANT_GUEST_OPEN_ID,
      actorUnionId: GRANT_GUEST_UNION_ID,
    });
    const value = seedLegacyPendingRun(ds);
    enableGrantCommandRestriction();

    const result = await modules.daemon.__testOnly_handleFrozenCommandCardAction(
      callbackData(value, { open_id: GRANT_GUEST_OPEN_ID, union_id: GRANT_GUEST_UNION_ID }),
      APP,
    );

    expect(result).toMatchObject({ toast: { type: 'error' } });
    expect(modules.actionStore.getFrozenCommandAction(dataDir, value.transition_id)?.status).toBe('pending');
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('rejects a pre-fix grant-only lifecycle card when the visitor confirms it', async () => {
    const guestCommand = '访客旧卡';
    const pending = modules.lifecycle.prepareFrozenCommandTransition({
      dataDir,
      targetBotId: APP,
      workingDir: root,
      command: `/${guestCommand}`,
      action: 'approve',
      actor: { openId: GRANT_GUEST_OPEN_ID, unionId: GRANT_GUEST_UNION_ID },
      reason: '模拟修复前已发出的确认卡',
      candidateYaml: YAML.replaceAll('宿主闭环', guestCommand),
    });
    enableGrantCommandRestriction();

    const result = await modules.daemon.__testOnly_handleFrozenCommandCardAction(
      callbackData(
        { action: 'frozen_command_lifecycle_confirm', transition_token: pending.token },
        { open_id: GRANT_GUEST_OPEN_ID, union_id: GRANT_GUEST_UNION_ID },
      ),
      APP,
    );

    expect(result).toMatchObject({ toast: { type: 'error' } });
    expect(modules.lifecycle.evaluateFrozenCommandLifecycle({
      dataDir,
      targetBotId: APP,
      workingDir: root,
      command: `/${guestCommand}`,
    }).kind).not.toBe('active');
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
      actorIsAdmin: true,
      reason: '另一机器人批准',
    });
    modules.lifecycle.confirmFrozenCommandTransition({
      dataDir,
      targetBotId: 'cli_foreign_bot',
      token: approve.token,
      actor: foreignActor,
      actorIsAdmin: true,
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
schemaVersion: 2
status: active
name: 损坏命令
description: 不应暴露解析细节
executor: builtin.data-mcp.readonly
input:
  sql: SELECT 1
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

  it('lets the recorded owner update without frozenCommandAdmins', async () => {
    const bot = modules.registry.getBot(APP);
    const candidate = YAML.replace('SELECT {{value}} * 2', 'SELECT {{value}} * 4');
    const file = join(root, '.botmux', 'commands', '宿主闭环.yaml');
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '更新固化命令' });

    bot.config.frozenCommandAdmins = undefined;
    const proposal = await postHostIntent(ds, {
      operation: 'approve',
      reason: 'owner 自助更新',
      definitionYaml: candidate,
    });
    expect(proposal.statusCode).toBe(200);
    expect(proposal.payload).toMatchObject({ status: 'awaiting_input', operation: 'approve' });
    expect(readFileSync(file, 'utf8')).toBe(YAML);
    const confirmed = await modules.daemon.__testOnly_handleFrozenCommandCardAction(
      callbackData(latestLifecycleAction()), APP,
    );
    expect(confirmed).toMatchObject({ toast: { type: 'success' } });
    expect(readFileSync(file, 'utf8')).toBe(candidate);
  });

  it('rechecks admin override at card confirmation after the command owner differs', async () => {
    const bot = modules.registry.getBot(APP);
    const otherCommand = '他人命令';
    const otherOwner = { openId: 'ou_other_owner', unionId: 'on_other_owner' };
    const initialYaml = YAML.replaceAll('宿主闭环', otherCommand);
    const candidate = initialYaml.replace('SELECT {{value}} * 2', 'SELECT {{value}} * 4');
    const file = join(root, '.botmux', 'commands', `${otherCommand}.yaml`);
    const creation = modules.lifecycle.prepareFrozenCommandTransition({
      dataDir,
      targetBotId: APP,
      workingDir: root,
      command: `/${otherCommand}`,
      action: 'approve',
      actor: otherOwner,
      reason: '创建他人命令',
      candidateYaml: initialYaml,
    });
    modules.lifecycle.confirmFrozenCommandTransition({
      dataDir,
      targetBotId: APP,
      token: creation.token,
      actor: otherOwner,
    });
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '更新固化命令' });
    bot.config.frozenCommandAdmins = [];
    const deniedProposal = await postHostIntent(ds, {
      operation: 'approve',
      reason: '非 owner 越权覆盖',
      definitionYaml: candidate,
      command: `/${otherCommand}`,
    });
    expect(deniedProposal.statusCode).toBe(403);
    expect(deniedProposal.payload).toMatchObject({ error: 'transition_owner_mismatch' });
    expect(readFileSync(file, 'utf8')).toBe(initialYaml);

    bot.config.frozenCommandAdmins = [ACTOR_UNION_ID];
    const prepared = await postHostIntent(ds, {
      operation: 'approve',
      reason: '确认前撤销管理员权限',
      definitionYaml: candidate,
      command: `/${otherCommand}`,
    });
    expect(prepared.statusCode).toBe(200);
    const value = latestLifecycleAction();

    bot.config.frozenCommandAdmins = [];
    const deniedConfirmation = await modules.daemon.__testOnly_handleFrozenCommandCardAction(
      callbackData(value), APP,
    );
    expect(deniedConfirmation).toMatchObject({ toast: { type: 'error' } });
    expect(readFileSync(file, 'utf8')).toBe(initialYaml);
  });

  it('stages a model-proposed update and publishes it only after the same human clicks once', async () => {
    const candidate = YAML.replace('SELECT {{value}} * 2', 'SELECT {{value}} * 3');
    const file = join(root, '.botmux', 'commands', '宿主闭环.yaml');
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '更新固化命令' });
    const response = await postHostIntent(ds, {
      operation: 'approve',
      reason: '更新宿主闭环口径',
      definitionYaml: candidate,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ status: 'awaiting_input', operation: 'approve' });
    expect(readFileSync(file, 'utf8')).toBe(YAML);
    expect(mocks.cardBodies.at(-1)).toContain('确认更新固化命令');
    expect(mocks.cardBodies.at(-1)).not.toContain('SELECT');
    const value = latestLifecycleAction();

    const denied = await modules.daemon.__testOnly_handleFrozenCommandCardAction(
      callbackData(value, { open_id: 'ou_other', union_id: 'on_other' }), APP,
    );
    expect(denied).toMatchObject({ toast: { type: 'error' } });
    expect(readFileSync(file, 'utf8')).toBe(YAML);

    const confirmed = await modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP);
    expect(confirmed).toMatchObject({ card: { data: { header: { template: 'green' } } } });
    expect(readFileSync(file, 'utf8')).toBe(candidate);
    expect(modules.lifecycle.evaluateFrozenCommandLifecycle({
      dataDir,
      targetBotId: APP,
      workingDir: root,
      command: COMMAND,
    }).kind).toBe('active');
  });

  it('cancels a natural-language retirement without changing the active command', async () => {
    const file = join(root, '.botmux', 'commands', '宿主闭环.yaml');
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '废弃固化命令' });
    const response = await postHostIntent(ds, {
      operation: 'retire',
      reason: '改用新口径',
      replacement: '/新宿主闭环',
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.cardBodies.at(-1)).toContain('确认废弃固化命令');
    const parsed = JSON.parse(mocks.cardBodies.at(-1)!) as any;
    const row = parsed.body.elements.find((element: any) => element.tag === 'column_set');
    const cancel = row.columns[1].elements[0].behaviors[0].value;

    const cancelled = await modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(cancel), APP);
    expect(cancelled).toMatchObject({ card: { data: { header: { template: 'grey' } } } });
    expect(readFileSync(file, 'utf8')).toBe(YAML);
    expect(modules.lifecycle.evaluateFrozenCommandLifecycle({
      dataDir,
      targetBotId: APP,
      workingDir: root,
      command: COMMAND,
    }).kind).toBe('active');
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

  it('keeps legacy run cards bound to the live actor and still requires the actor callback', async () => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '运行命令' });
    delete ds.managedTurnOrigin.dispatchAttempt;
    const value = seedLegacyPendingRun(ds);

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
    ['new-topic', 'pty', '@_bot 请运行固化命令 /宿主闭环，参数 11', '@Current Bot 请运行固化命令 /宿主闭环，参数 11'],
    ['existing-thread', 'tmux', '请运行固化命令 /宿主闭环，参数 11 @_bot', '请运行固化命令 /宿主闭环，参数 11 @Current Bot'],
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
    const value = seedLegacyPendingRun(ds);

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
    const value = seedLegacyPendingRun(ds);
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
    const value = seedLegacyPendingRun(ds);
    const bot = modules.registry.getBot(APP);
    bot.resolvedAllowedUsers = [];
    bot.config.oncallChats = [];
    const result = await modules.daemon.__testOnly_handleFrozenCommandCardAction(callbackData(value), APP);
    expect(result).toMatchObject({ toast: { type: 'error' } });
    expect(modules.actionStore.getFrozenCommandAction(dataDir, value.transition_id)?.status).toBe('pending');
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('rejects the retired host run operation before card or Data MCP calls', async () => {
    const ds = makeSession({ scope: 'chat', backendType: 'pty', sourceText: '运行命令' });
    const response = await postHostIntent(ds, { operation: 'run', rawArgs: '11' });
    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({ ok: false, error: 'frozen_command_run_disabled' });
    expect(mocks.cardBodies).toHaveLength(0);
    expect(mocks.validateCalls).toBe(0);
    expect(mocks.runCalls).toBe(0);
  });

  it('fails closed when an old card crosses definition hash and lifecycle revision', async () => {
    const ds = makeSession({ scope: 'thread', backendType: 'tmux', sourceText: '运行命令' });
    const value = seedLegacyPendingRun(ds);
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
    const value = seedLegacyPendingRun(ds);
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
