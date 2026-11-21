/**
 * The executing bot's side of a workflow handoff with a Gate-2 working dir
 * (design 2026-11-03 §15.4), through the REAL daemon route (`handleThreadReply`
 * → handleThreadReplyAdmitted): only the Lark client, the session store, the
 * CLI fork and the run base dir are stand-ins. The handoff is a real signed
 * binding in the host registry, linked to the inbound message id; the run is a
 * real run.json with `nodeWorkingDir`.
 *
 * Pins, on what the daemon actually does with the message:
 *   - out of the bot's range → no session is created and nothing is forked
 *     (the refusal is recorded for the main bot);
 *   - in range → the new session is forked in exactly that directory (not the
 *     bot's default / oncall / inherited one), as a workflow node session;
 *   - an existing session in the node topic that runs elsewhere → the handoff
 *     is not handed to it.
 *
 * Run: bun x vitest run --project unit test/workflow-node-inbound-route.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // The dispatch-report secret lives in dirname(dataDir) and must sit in a
  // directory the current user owns: nest the data dir one level down so its
  // parent is this test's own directory, not the shared /tmp (owned by root
  // on CI runners, which run as a regular user).
  const ownRoot = `${process.env.TMPDIR ?? '/tmp'}/botmux-wf-inbound-${process.pid}`;
  const dataDir = `${ownRoot}/data`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    ownRoot,
    dataDir,
    runsDir: `${dataDir}/v3-runs`,
    replyMessage: vi.fn(async (..._args: any[]) => 'om_reply'),
    sendMessage: vi.fn(async (..._args: any[]) => 'om_sent'),
    getChatMode: vi.fn(async () => 'topic' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'topic' as const })),
    resolveSender: vi.fn(async (_appId: string, openId?: string, senderType?: string) => (
      openId ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const } : undefined
    )),
    forkWorker: vi.fn((..._args: any[]) => undefined),
    sendWorkerInput: vi.fn((..._args: any[]) => true),
    downloadResources: vi.fn(async (..._args: any[]) => ({ attachments: [] as unknown[], needLogin: false })),
    createdSessions: [] as any[],
    createSession: vi.fn(function (chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') {
      const session = {
        sessionId: `sess-wf-${++seq}`, chatId, rootMessageId, title, status: 'active' as const,
        createdAt: new Date().toISOString(), chatType,
      };
      mocks.createdSessions.push(session);
      return session;
    }),
    updateSession: vi.fn(),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    getChatMode: mocks.getChatMode,
    getChatModeStrict: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
    getChatInfo: vi.fn(async () => ({ userCount: 1, botCount: 2 })),
    listChatBotMembers: vi.fn(async () => []),
    resolveAllowedUsersWithMap: vi.fn(async (_appId: string, users: string[]) => ({ resolved: users, map: new Map() })),
    sendUserMessage: vi.fn(async () => 'om_dm'),
    updateMessage: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => 'reaction'),
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return { ...actual, createSession: mocks.createSession, updateSession: mocks.updateSession };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    forkWorker: (...args: any[]) => mocks.forkWorker(...args),
    sendWorkerInput: (...args: any[]) => mocks.sendWorkerInput(...args),
  };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return { ...actual, downloadResources: (...args: any[]) => mocks.downloadResources(...args) };
});

// The daemon's v3 run base dir (normally ~/.botmux/v3-runs).
vi.mock('../src/workflows/v3/grill-state.js', async () => {
  const actual = await vi.importActual<any>('../src/workflows/v3/grill-state.js');
  return { ...actual, defaultBaseDir: () => mocks.runsDir };
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { registerBot, getBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';
import { loadOrCreateDispatchReportBindingSecret } from '../src/core/dispatch-report-binding.js';
import {
  createWorkflowHandoffBinding,
  linkWorkflowHandoffMessage,
  lookupWorkflowHandoffByNonce,
  readDispatchRegistryLoose,
  recordWorkflowHandoffBinding,
  workflowHandoffNonce,
} from '../src/core/workflow-handoff-binding.js';
import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../src/workflows/v3/run-envelope.js';

const CHILD = 'wf_inbound_child_app';
const MAIN = 'wf_inbound_main_app';
const CHILD_OPEN_ID = 'ou_wf_child_bot';
const MAIN_OPEN_ID = 'ou_wf_main_bot';
const OWNER = 'ou_wf_owner';
const CHAT = 'oc_wf_inbound_chat';
const NODE_CARD = 'om_wf_node_card';

let root: string;
let range: string;
let project: string;
let elsewhere: string;
let seq = 0;

function registerChild(workingDirs: string[]): void {
  registerBot({
    larkAppId: CHILD,
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    allowedUsers: [OWNER, MAIN_OPEN_ID],
    defaultWorkingDir: elsewhere,
    workingDirs,
  } as any);
  const bot = getBot(CHILD);
  bot.resolvedAllowedUsers = [OWNER, MAIN_OPEN_ID];
  bot.botOpenId = CHILD_OPEN_ID;
  bot.botName = 'Child';
}

/** A real authorized bot run pinned to `dir`, and its signed, linked handoff. */
async function handoff(dir: string): Promise<{ nonce: string; messageId: string; text: string }> {
  const runId = `wf-inbound-${++seq}`;
  const runDir = join(mocks.runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('dag.json', { schemaVersion: 2, runId, nodes: [{ id: 'write', type: 'goal', goal: 'write', bot: CHILD, depends: [], inputs: [] }] });
  write('spec.json', { schemaVersion: 1, runId, title: 't', requirement: 'r', nodes: [] });
  write('bots.snapshot.json', { [CHILD]: { larkAppId: CHILD, cliId: 'claude-code', workingDir: dir } });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-11-04T00:00:00.000Z',
    authorizedAt: '2026-11-04T00:00:01.000Z',
    chatBinding: { larkAppId: MAIN, chatId: CHAT, chatType: 'group', rootMessageId: 'om_main', ownerOpenId: OWNER },
    nodeExecutor: 'bot',
    nodeWorkingDir: dir,
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  }));
  const secret = loadOrCreateDispatchReportBindingSecret(mocks.dataDir);
  const nonce = workflowHandoffNonce(secret, `idem-${runId}`);
  const messageId = `om_wf_handoff_${seq}`;
  await recordWorkflowHandoffBinding(mocks.dataDir, secret, createWorkflowHandoffBinding(secret, {
    nonce,
    publishRoot: NODE_CARD,
    targetLarkAppId: CHILD,
    targetChatId: CHAT,
    sourceLarkAppId: MAIN,
    workflow: { runId, nodeId: 'write', attemptId: 'write#001/attempts/001', revision: 1 },
  }));
  await linkWorkflowHandoffMessage(mocks.dataDir, secret, nonce, messageId);
  return { nonce, messageId, text: `【工作流任务】t · write\n要做什么：write\n交接编号：${nonce}` };
}

function handoffEvent(text: string, messageId: string): any {
  return {
    sender: { sender_id: { open_id: MAIN_OPEN_ID }, sender_type: 'app' },
    message: {
      message_id: messageId,
      chat_id: CHAT,
      chat_type: 'group',
      message_type: 'text',
      root_id: NODE_CARD,
      thread_id: 'omt_wf_node_topic',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
      mentions: [{ key: '@_user_1', name: 'Child', id: { open_id: CHILD_OPEN_ID }, id_type: 'open_id' }],
    },
  };
}

function ctx(messageId: string): RoutingContext {
  return { chatId: CHAT, messageId, chatType: 'group', scope: 'thread', anchor: NODE_CARD, larkAppId: CHILD } as RoutingContext;
}

function refusalOf(nonce: string): string | undefined {
  const found = lookupWorkflowHandoffByNonce({
    registry: readDispatchRegistryLoose(mocks.dataDir), nonce, secret: loadOrCreateDispatchReportBindingSecret(mocks.dataDir),
  });
  return found.kind === 'workflow' ? found.refusal : undefined;
}

function seedTopicSession(workingDir: string): DaemonSession {
  const session: any = {
    sessionId: 'sess-wf-existing', chatId: CHAT, rootMessageId: NODE_CARD, title: 'chat', status: 'active',
    createdAt: new Date().toISOString(), chatType: 'group', larkAppId: CHILD, ownerOpenId: OWNER, workingDir, scope: 'thread',
  };
  const ds = {
    session, worker: { killed: false }, workerPort: null, workerToken: null, larkAppId: CHILD, chatId: CHAT,
    chatType: 'group', scope: 'thread', spawnedAt: Date.now(), cliVersion: '1.0.0', lastMessageAt: Date.now(),
    hasHistory: true, workingDir,
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(NODE_CARD, CHILD), ds);
  return ds;
}

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(mocks.runsDir, { recursive: true });
  root = mkdtempSync(join(mocks.dataDir, 'dirs-'));
  range = join(root, 'range');
  project = join(range, 'project');
  elsewhere = join(root, 'elsewhere');
  mkdirSync(project, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([]));
  activeSessions.clear();
  mocks.createdSessions.length = 0;
  mocks.getChatMode.mockResolvedValue('topic');
  mocks.sendWorkerInput.mockReturnValue(true);
});

afterAll(() => {
  rmSync(mocks.ownRoot, { recursive: true, force: true });
});

describe('workflow handoff with a working dir on the executing bot\'s daemon (real route)', () => {
  it('in range: the new node session is forked in exactly that directory, not the bot\'s default', async () => {
    registerChild([range]);
    const h = await handoff(project);
    await handleThreadReply(handoffEvent(h.text, h.messageId), ctx(h.messageId));

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const ds = mocks.forkWorker.mock.calls[0]![0] as DaemonSession;
    expect(ds.workingDir).toBe(realpathSync(project));
    expect(ds.session.workingDir).toBe(realpathSync(project));
    expect(ds.session.workflowNode).toMatchObject({ nonce: h.nonce, handoffMessageId: h.messageId });
    expect(refusalOf(h.nonce)).toBeUndefined();
  });

  it('out of range (the bot\'s configuration now): no session is created and nothing is forked', async () => {
    registerChild([elsewhere]);
    const h = await handoff(project);
    await handleThreadReply(handoffEvent(h.text, h.messageId), ctx(h.messageId));

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.createdSessions).toEqual([]);
    expect(activeSessions.size).toBe(0);
    await vi.waitFor(() => expect(refusalOf(h.nonce)).toContain('不在这个 Bot 配置的目录范围内'));
  });

  it('a session already in the node topic that runs elsewhere is not given the handoff', async () => {
    registerChild([range, elsewhere]);
    const ds = seedTopicSession(elsewhere);
    const h = await handoff(project);
    await handleThreadReply(handoffEvent(h.text, h.messageId), ctx(h.messageId));

    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds.session.workflowNode).toBeUndefined();
    await vi.waitFor(() => expect(refusalOf(h.nonce)).toContain('节点话题里已有会话'));
  });

  it('…and one that runs in the directory continues the node', async () => {
    registerChild([range]);
    const ds = seedTopicSession(project);
    const h = await handoff(project);
    await handleThreadReply(handoffEvent(h.text, h.messageId), ctx(h.messageId));

    expect(ds.session.workflowNode).toMatchObject({ nonce: h.nonce });
    expect(mocks.sendWorkerInput.mock.calls.length + mocks.forkWorker.mock.calls.length).toBeGreaterThan(0);
    expect(refusalOf(h.nonce)).toBeUndefined();
  });
});
