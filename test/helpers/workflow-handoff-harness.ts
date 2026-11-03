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
import { handleWorkflowHandoffEvent, handleWorkflowNodeReport, type WorkflowNodeReportDeps } from '../../src/core/workflow-handoff-routes.js';
import { readDispatchRegistryLoose } from '../../src/core/workflow-handoff-binding.js';
import type { V3Dag } from '../../src/workflows/v3/dag.js';
import { trackTempDir } from './v3-external-harness.js';

export const SECRET = 'host-binding-secret';
export const MAIN = 'cli_main';
export const CHAT = 'oc_chat';

export class FakeLark {
  readonly sent: Array<{ chatId: string; card: string; uuid: string; id: string }> = [];
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

  sendCard = async (chatId: string, card: string, uuid: string): Promise<string> => {
    const { id, fresh } = this.idFor(uuid, 'card');
    if (fresh) this.sent.push({ chatId, card, uuid, id });
    return id;
  };

  replyCard = async (root: string, card: string, uuid?: string): Promise<string> => {
    if (this.failNextReply) {
      this.failNextReply = false;
      throw new Error('socket hang up');
    }
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
  online: Set<string>;
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
    online: new Set(['cli_a', 'cli_b', MAIN]),
    acceptance: new Map(),
  } as unknown as HandoffWorld;
  world.deps = {
    selfLarkAppId: MAIN,
    dataDir,
    transport: { sendCard: world.lark.sendCard, replyCard: world.lark.replyCard, patchCard: world.lark.patchCard },
    resolveTargetInChat: async (_chatId, target) =>
      world.members.get(target) ?? { ok: false, code: 'BOT_NOT_IN_CHAT', message: `${target} not in chat` },
    isDaemonOnline: (appId) => world.online.has(appId),
    ensureGrant: async (chatId, target) => {
      if (world.grantError) throw new Error(world.grantError);
      world.grants.push({ chatId, target });
    },
    bindingSecret: () => SECRET,
    botName: (appId) => `bot(${appId})`,
    findAcceptance: (input) => world.acceptance.get(input.handoffMessageId),
    stopTarget: async (input) => { world.stops.push(input); },
    startSelfTurn: async (input) => {
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
) {
  const cards: Array<Parameters<WorkflowNodeReportDeps['postReportCard']>> = [];
  const submitted: string[] = [];
  const report = (raw: unknown, session: { sessionId: string; rootMessageId?: string; chatId?: string; larkAppId?: string }) =>
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
        },
      }),
      readRegistry: () => readDispatchRegistryLoose(world.dataDir),
      secret: () => SECRET,
      loadNodeContract: () => undefined,
      forward: async (_binding, event) => orchestrator(event),
      markSubmitted: (sessionId) => { submitted.push(sessionId); },
      postReportCard: async (...args) => { cards.push(args); },
      ...overrides,
    });
  return { report, cards, submitted };
}
