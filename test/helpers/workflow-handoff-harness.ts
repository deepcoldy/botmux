/**
 * Harness for the Feishu handoff transport of bot-executed workflow nodes: a
 * real runtime over a temp run dir (BotRun), the real executor and routes, a
 * fake Lark that de-duplicates by message uuid like Lark does, and a real
 * host-wide registry in a temp data dir.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createV3BotHandoffExecutor, type V3BotHandoffExecutorDeps, type V3SelfTurnRequest, type V3TargetInChat } from '../../src/im/lark/v3-bot-handoff-executor.js';
import { handleWorkflowHandoffEvent, handleWorkflowNodeReport, stageWorkflowNodeSubmission, type WorkflowNodeReportDeps } from '../../src/core/workflow-handoff-routes.js';
import { readDispatchRegistryLoose, workflowHandoffNonce } from '../../src/core/workflow-handoff-binding.js';
import type { V3Dag } from '../../src/workflows/v3/dag.js';
import { trackTempDir } from './v3-external-harness.js';

export const SECRET = 'host-binding-secret';
export const MAIN = 'cli_main';
export const CHAT = 'oc_chat';

export class FakeLark {
  readonly sent: Array<{ chatId: string; card: string; uuid: string; id: string }> = [];
  /** Optional hook run inside replyCard (e.g. a cancel landing mid-send). */
  onReply?: () => void | Promise<void>;
  /** Fail this many upcoming replies (unknown outcome each time). */
  failReplies = 0;
  readonly replies: Array<{ root: string; card: string; uuid?: string; id: string }> = [];
  readonly patches: Array<{ id: string; card: string }> = [];
  private readonly byUuid = new Map<string, string>();
  private seq = 0;
  failNextReply = false;

  private idFor(uuid: string | undefined, prefix: string): { id: string; fresh: boolean } {
    if (uuid && this.byUuid.has(uuid)) return { id: this.byUuid.get(uuid)!, fresh: false };
    const id = `om_${prefix}${++this.seq}`;
    if (uuid) this.byUuid.set(uuid, id);
    return { id, fresh: true };
  }

  /** Optional hook run inside sendCard (the node card). */
  onSend?: () => void | Promise<void>;

  sendCard = async (chatId: string, card: string, uuid: string): Promise<string> => {
    await this.onSend?.();
    const { id, fresh } = this.idFor(uuid, 'card');
    if (fresh) this.sent.push({ chatId, card, uuid, id });
    return id;
  };

  replyCard = async (root: string, card: string, uuid?: string): Promise<string> => {
    if (this.failNextReply || this.failReplies > 0) {
      this.failNextReply = false;
      if (this.failReplies > 0) this.failReplies--;
      throw new Error('socket hang up');
    }
    await this.onReply?.();
    const { id, fresh } = this.idFor(uuid, 'reply');
    if (fresh) this.replies.push({ root, card, ...(uuid ? { uuid } : {}), id });
    return id;
  };

  patchCard = async (id: string, card: string): Promise<void> => {
    this.patches.push({ id, card });
  };
}

export interface HandoffWorld {
  dataDir: string;
  lark: FakeLark;
  selfTurns: V3SelfTurnRequest[];
  stops: Array<{ targetLarkAppId: string; handoffMessageId: string; sessionId?: string; reason: string }>;
  grants: Array<{ chatId: string; target: string }>;
  members: Map<string, V3TargetInChat>;
  /** Bots that fold node-topic replies into one group session (§6.1 item 7). */
  foldsTopics: Set<string>;
  online: Set<string>;
  /** Call order of transport / self-turn / stop side effects. */
  calls: string[];
  acceptance: Map<string, { sessionId: string; acceptedAt?: number }>;
  grantError?: string;
  deps: V3BotHandoffExecutorDeps;
  executor: ReturnType<typeof createV3BotHandoffExecutor>;
}

export function handoffWorld(overrides: Partial<V3BotHandoffExecutorDeps> = {}): HandoffWorld {
  const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wf-handoff-data-')));
  const world = {
    dataDir,
    lark: new FakeLark(),
    selfTurns: [],
    stops: [],
    grants: [],
    members: new Map<string, V3TargetInChat>([
      ['cli_a', { ok: true, openId: 'ou_bot_a' }],
      ['cli_b', { ok: true, openId: 'ou_bot_b' }],
    ]),
    foldsTopics: new Set<string>(),
    online: new Set(['cli_a', 'cli_b', MAIN]),
    calls: [],
    acceptance: new Map(),
  } as unknown as HandoffWorld;
  world.deps = {
    selfLarkAppId: MAIN,
    dataDir,
    transport: { sendCard: world.lark.sendCard, replyCard: world.lark.replyCard, patchCard: world.lark.patchCard },
    resolveTargetInChat: async (_chatId, target) =>
      world.members.get(target) ?? { ok: false, code: 'BOT_NOT_IN_CHAT', message: `${target} not in chat` },
    targetOpensTopicSessions: async (_chatId, target) => (world.foldsTopics.has(target) ? 'no' : 'yes'),
    isDaemonOnline: (appId) => world.online.has(appId),
    ensureGrant: async (chatId, target) => {
      if (world.grantError) throw new Error(world.grantError);
      world.grants.push({ chatId, target });
    },
    bindingSecret: () => SECRET,
    botName: (appId) => `bot(${appId})`,
    findAcceptance: (input) => world.acceptance.get(input.handoffMessageId),
    stopTarget: async (input) => { world.calls.push(`stop:${input.reason}`); world.stops.push(input); },
    startSelfTurn: async (input) => {
      world.calls.push('startSelfTurn');
      world.selfTurns.push(input);
      return { sessionId: `self-${input.handoffMessageId}` };
    },
    ...overrides,
  };
  world.executor = createV3BotHandoffExecutor(world.deps);
  return world;
}

/** The main bot's event route over a BotRun's dir (drive is the caller's). */
export function orchestratorEvent(world: HandoffWorld, baseDir: string, dag: V3Dag, now?: () => number) {
  const drives: string[] = [];
  const route = (raw: unknown) => handleWorkflowHandoffEvent(raw, {
    selfLarkAppId: MAIN,
    baseDir,
    readRegistry: () => readDispatchRegistryLoose(world.dataDir),
    secret: () => SECRET,
    loadRun: () => ({ dag, nodeExecutor: 'bot', chatId: CHAT }),
    drive: (runId) => { drives.push(runId); },
    ...(now ? { now } : {}),
  });
  return { route, drives };
}

/** The executing bot's report route, forwarding in-process to `orchestrator`. */
export function targetReport(
  world: HandoffWorld,
  selfLarkAppId: string,
  orchestrator: (raw: unknown) => ReturnType<typeof handleWorkflowHandoffEvent>,
  overrides: Partial<WorkflowNodeReportDeps> = {},
  stage?: { baseDir: string; dag: V3Dag },
) {
  const stageBaseDir = stage?.baseDir;
  const stageDag = stage?.dag;
  const cards: Array<Parameters<WorkflowNodeReportDeps['postReportCard']>> = [];
  const submitted: string[] = [];
  const report = (raw: unknown, session: {
    sessionId: string;
    rootMessageId?: string;
    chatId?: string;
    larkAppId?: string;
    workflowNode?: { handoffMessageId: string; nonce: string };
  }) =>
    handleWorkflowNodeReport(raw, {
      selfLarkAppId,
      authorize: () => ({
        ok: true,
        session: {
          sessionId: session.sessionId,
          larkAppId: session.larkAppId ?? selfLarkAppId,
          chatId: session.chatId ?? CHAT,
          scope: 'thread',
          ...(session.rootMessageId ? { rootMessageId: session.rootMessageId } : {}),
          ...(session.workflowNode ? { workflowNode: session.workflowNode } : {}),
        },
      }),
      readRegistry: () => readDispatchRegistryLoose(world.dataDir),
      secret: () => SECRET,
      loadNodeContract: () => undefined,
      forward: async (_binding, event) => orchestrator(event),
      stageSubmission: async (binding, input) => {
        if (!stageBaseDir || !stageDag) return { status: 500, body: { ok: false, error: 'no_stage_target' } };
        return stageWorkflowNodeSubmission(stageBaseDir, binding, stageDag, input);
      },
      markSubmitted: (sessionId) => { submitted.push(sessionId); },
      postReportCard: async (...args) => { cards.push(args); },
      ...overrides,
    });
  return { report, cards, submitted };
}

/** The nonce of an attempt's handoff (what the card carries). */
export function nonceOf(attempt: { idempotency?: { handoff: string } }): string {
  return workflowHandoffNonce(SECRET, attempt.idempotency!.handoff);
}
