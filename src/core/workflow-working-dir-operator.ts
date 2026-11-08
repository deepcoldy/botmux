/**
 * "May the run's initiator operate this bot?" for a workflow node's Gate-2
 * working dir (design 2026-11-03 §15.4). The answer decides whether
 * {@link checkNodeWorkingDir} only checks that the directory exists (yes) or
 * also holds it to the bot's configured range (no / unknown).
 *
 * "Operate" means what lets a person use `/cd` in a topic of that bot in the
 * run's chat: they pass the `/cd` command gate (`humanCanRunDaemonCommand`
 * with `/cd`) AND are a member of that chat right now — someone who left the
 * group cannot type `/cd` there, even if a chat-wide grant still names the
 * chat. Judged by the executing bot's own daemon, with its own configuration,
 * grants and Lark app.
 *
 * The initiator's open_id is app-scoped: it names them for the run's main bot
 * app only. For any other bot it is never used; their union_id is resolved to
 * that bot's own open_id first. The `/cd` gate also reads the union_id (the
 * platform team member and meeting inviter legs): on the main bot's own app,
 * when the run froze none and the open_id alone does not pass, it is looked
 * up through that app before the gate is asked again — unless that app
 * definitively cannot see it, which leaves the open_id's refusal standing.
 *
 * Three answers: `yes`, `no`, or `unknown` (a lookup failed, timed out, or the
 * identity could not be obtained). The caller treats `unknown` like `no` for
 * the decision — the configured range applies — but says it could not be
 * confirmed, since retrying later may help.
 */

import type { TargetAppOpenIdResolution } from '../im/lark/client.js';
import {
  WorkflowSidebarMembershipCache,
  checkWorkflowViewerChatMembership,
} from './workflow-sidebar-membership.js';

/** Gate-2 (approve-dag, a CLI process) → an executing bot's daemon: may the
 *  initiator of this pending run operate you for this node? Trusted host IPC. */
export const WORKFLOW_WORKING_DIR_OPERATOR_ROUTE = '/api/workflow/working-dir-operator-check';

/** An executing bot's daemon → the run's main bot's daemon: the initiator's
 *  union_id, looked up through the main bot's app (the only app their open_id
 *  belongs to). Answered only for the main bot's own runs that pin (or, before
 *  approval, may pin) a working dir, and only to one of their executing bots. */
export const WORKFLOW_INITIATOR_UNION_ROUTE = '/api/workflow/initiator-union-id';

const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,128}$/;
const UNION_ID_RE = /^on_[A-Za-z0-9_-]{1,128}$/;
const NODE_ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;

export const isWorkflowOpenId = (value: unknown): value is string => typeof value === 'string' && OPEN_ID_RE.test(value);
export const isWorkflowUnionId = (value: unknown): value is string => typeof value === 'string' && UNION_ID_RE.test(value);

export type WorkflowOperateAnswer = 'yes' | 'no' | { unknown: string };

export const isOperateUnknown = (answer: WorkflowOperateAnswer): answer is { unknown: string } =>
  typeof answer === 'object' && answer !== null;

/** The initiator as the operate check sees them. `openId` is valid for
 *  `sourceLarkAppId` (the run's main bot) only. */
export interface WorkflowInitiatorIdentity {
  sourceLarkAppId: string;
  openId?: string;
  unionId?: string;
}

/** An open_id → union_id lookup: `notFound` when the app definitively cannot
 *  give it (the person is not visible to it, the id is invalid or another
 *  app's, a contact scope is missing) — retrying will not help. */
export type WorkflowUnionIdLookup = { unionId: string } | { notFound: string } | { unknown: string };

export interface WorkflowInitiatorOperatesDeps {
  /** union_id → the open_id `larkAppId`'s own app issues for that person. */
  resolveTargetOpenId(larkAppId: string, unionId: string): Promise<TargetAppOpenIdResolution>;
  /** open_id issued by `larkAppId`'s own app → that person's union_id. */
  lookupUnionId(larkAppId: string, openId: string): Promise<WorkflowUnionIdLookup>;
  /** The `/cd` command gate of `larkAppId` for a human with this (own-app)
   *  open_id in `chatId`. */
  canUseCd(larkAppId: string, chatId: string, openId: string, unionId: string | undefined): boolean;
  /** Is this (own-app) open_id a member of `chatId`, as `larkAppId` sees it?
   *  `fresh`: read now, not from a cache. */
  chatMembership(larkAppId: string, chatId: string, openId: string, fresh: boolean): Promise<'member' | 'not_member' | 'unavailable'>;
}

interface WorkflowOperateQuestion {
  larkAppId: string;
  chatId: string;
  initiator: WorkflowInitiatorIdentity;
}

/** The initiator's identity in `larkAppId`'s app and the `/cd` gate — every
 *  part of the operate check except the chat's member list. */
async function initiatorPassesCdGate(
  deps: Omit<WorkflowInitiatorOperatesDeps, 'chatMembership'>,
  input: WorkflowOperateQuestion,
): Promise<{ passes: string } | 'no' | { unknown: string }> {
  const { initiator } = input;
  let openId: string;
  if (input.larkAppId === initiator.sourceLarkAppId && isWorkflowOpenId(initiator.openId)) {
    openId = initiator.openId;
  } else if (isWorkflowUnionId(initiator.unionId)) {
    // Never the main bot's open_id for another app: convert through the
    // tenant-stable union_id, in the executing bot's own app.
    let resolved: TargetAppOpenIdResolution;
    try {
      resolved = await deps.resolveTargetOpenId(input.larkAppId, initiator.unionId);
    } catch {
      return { unknown: '换算发起人在这个 Bot 下的身份时出错' };
    }
    if (resolved.status === 'definitive') return 'no';
    if (resolved.status !== 'resolved' || !isWorkflowOpenId(resolved.openId)) return { unknown: '暂时换算不出发起人在这个 Bot 下的身份' };
    openId = resolved.openId;
  } else {
    return { unknown: '拿不到发起人的跨应用身份（union_id）' };
  }
  const unionId = isWorkflowUnionId(initiator.unionId) ? initiator.unionId : undefined;
  if (deps.canUseCd(input.larkAppId, input.chatId, openId, unionId)) return { passes: openId };
  // A union_id only ever adds legs to the gate: without one, a refusal is
  // not final until it has been looked up (through the open_id's own app).
  if (unionId !== undefined) return 'no';
  let looked: WorkflowUnionIdLookup;
  try {
    looked = await deps.lookupUnionId(input.larkAppId, openId);
  } catch {
    return { unknown: '查询发起人的跨应用身份失败' };
  }
  if ('notFound' in looked) return 'no';
  if ('unknown' in looked) return { unknown: looked.unknown };
  if (!isWorkflowUnionId(looked.unionId)) return { unknown: '查不到发起人的跨应用身份' };
  return deps.canUseCd(input.larkAppId, input.chatId, openId, looked.unionId) ? { passes: openId } : 'no';
}

/** What {@link workflowInitiatorCdGate} answers: `passes` is NOT an operate
 *  `yes` — the chat's member list was not read. */
export type WorkflowCdGateAnswer = 'passes' | 'no' | { unknown: string };

/** {@link workflowInitiatorOperates} without the chat's member list. */
export async function workflowInitiatorCdGate(
  deps: Omit<WorkflowInitiatorOperatesDeps, 'chatMembership'>,
  input: WorkflowOperateQuestion,
): Promise<WorkflowCdGateAnswer> {
  const gate = await initiatorPassesCdGate(deps, input);
  return typeof gate === 'object' && 'passes' in gate ? 'passes' : gate;
}

/** Whether the initiator may operate `larkAppId` in `chatId`. */
export async function workflowInitiatorOperates(
  deps: WorkflowInitiatorOperatesDeps,
  input: WorkflowOperateQuestion & { freshMembership?: boolean },
): Promise<WorkflowOperateAnswer> {
  const gate = await initiatorPassesCdGate(deps, input);
  if (gate === 'no' || 'unknown' in gate) return gate;
  const openId = gate.passes;
  let membership: 'member' | 'not_member' | 'unavailable';
  try {
    membership = await deps.chatMembership(input.larkAppId, input.chatId, openId, input.freshMembership === true);
  } catch {
    membership = 'unavailable';
  }
  if (membership === 'not_member') return 'no';
  if (membership !== 'member') return { unknown: '暂时查不到发起人是否还在群里' };
  return 'yes';
}

/** The production I/O {@link createWorkflowWorkingDirOperatorWiring} needs. */
export interface WorkflowWorkingDirOperatorIo {
  resolveTargetAppOpenId(larkAppId: string, unionId: string): Promise<TargetAppOpenIdResolution>;
  /** open_id → union_id through `larkAppId`'s own app (strict lookup). */
  resolveUnionIdFromOpenId(larkAppId: string, openId: string): Promise<{ status: 'resolved'; unionId: string } | { status: 'unavailable' } | { status: 'retryable'; error: string }>;
  /** The full member list of `chatId` as `larkAppId` sees it (throws when
   *  incomplete). */
  listChatMemberOpenIds(larkAppId: string, chatId: string): Promise<readonly string[]>;
  /** The daemon-command gate a typed command passes (`humanCanRunDaemonCommand`). */
  canRunDaemonCommand(larkAppId: string, chatId: string, openId: string, unionId: string | undefined, cmd: string, chatType: 'group'): boolean;
  /** This daemon's own bot app. */
  selfLarkAppId(): string;
  /** Membership verdict cache (default: a fresh one, as the sidebar uses). */
  membershipCache?: WorkflowSidebarMembershipCache;
  warn?(message: string): void;
}

/** What a daemon's {@link createWorkflowNodeDaemon} gets for §15.4: the
 *  operate check of its own bot (whole, or without the member list), and its
 *  own app's union_id lookup. */
export interface WorkflowWorkingDirOperatorWiring {
  initiatorOperates(input: { larkAppId: string; chatId: string; initiator: WorkflowInitiatorIdentity; freshMembership?: boolean }): Promise<WorkflowOperateAnswer>;
  initiatorCdGate(input: { larkAppId: string; chatId: string; initiator: WorkflowInitiatorIdentity }): Promise<WorkflowCdGateAnswer>;
  lookupOwnUnionId(openId: string): Promise<{ unionId: string } | { unknown: string }>;
}

/** The node gate is exactly the one a typed `/cd` passes. */
const OPERATE_COMMAND = '/cd';

export function createWorkflowWorkingDirOperatorWiring(io: WorkflowWorkingDirOperatorIo): WorkflowWorkingDirOperatorWiring {
  const membershipCache = io.membershipCache ?? new WorkflowSidebarMembershipCache();
  // `appId` must be the app that issued `openId`: always the run's main bot.
  const lookupUnionId = async (appId: string, openId: string): Promise<WorkflowUnionIdLookup> => {
    try {
      const resolved = await io.resolveUnionIdFromOpenId(appId, openId);
      if (resolved.status === 'resolved' && isWorkflowUnionId(resolved.unionId)) return { unionId: resolved.unionId };
      if (resolved.status === 'unavailable') return { notFound: '主 Bot 查不到发起人的跨应用身份' };
      return { unknown: '主 Bot 查询发起人的跨应用身份失败' };
    } catch {
      return { unknown: '主 Bot 查询发起人的跨应用身份失败' };
    }
  };
  const gateDeps: Omit<WorkflowInitiatorOperatesDeps, 'chatMembership'> = {
    resolveTargetOpenId: io.resolveTargetAppOpenId,
    lookupUnionId: async (appId, openId) => {
      const looked = await lookupUnionId(appId, openId);
      if ('notFound' in looked) {
        io.warn?.(`[workflow] ${appId} cannot look up the run initiator's union_id (contact visibility or scope): `
          + 'the /cd gate answers by open_id alone, without its team member / meeting inviter legs');
      }
      return looked;
    },
    canUseCd: (appId, chatId, openId, unionId) => io.canRunDaemonCommand(appId, chatId, openId, unionId, OPERATE_COMMAND, 'group'),
  };
  return {
    initiatorOperates: (input) => workflowInitiatorOperates({
      ...gateDeps,
      // The open_id was issued by (or converted into) this app: the sidebar's
      // own-app principal and its "incomplete list = unavailable". Gate-2
      // reads through the sidebar's short cache; node start reads fresh, so
      // someone who just left the chat no longer counts.
      chatMembership: (appId, chatId, openId, fresh) => {
        const ask = () => checkWorkflowViewerChatMembership({ chatId, principal: { openId } }, {
          resolveOpenIdByUnionId: async () => ({ status: 'transient' }),
          listChatMemberOpenIds: (chat) => io.listChatMemberOpenIds(appId, chat),
        });
        return fresh ? ask() : membershipCache.check({ mainLarkAppId: appId, chatId, principal: { openId } }, ask);
      },
    }, input),
    initiatorCdGate: (input) => workflowInitiatorCdGate(gateDeps, input),
    lookupOwnUnionId: async (openId) => {
      const looked = await lookupUnionId(io.selfLarkAppId(), openId);
      return 'notFound' in looked ? { unknown: looked.notFound } : looked;
    },
  };
}

/** How long one operate answer may take (Lark lookups + daemon IPC) before
 *  it counts as unknown: an inbound handoff waits for it, and a stalled
 *  lookup must not hold the node — the range rule still lets in-range
 *  directories start. */
export const WORKFLOW_OPERATOR_BUDGET_MS = 8_000;

/** `answer`, or unknown once `budgetMs` passed or it failed — never `yes`
 *  for an answer that did not arrive. */
export function withinOperatorBudget(
  answer: Promise<WorkflowOperateAnswer>,
  budgetMs: number = WORKFLOW_OPERATOR_BUDGET_MS,
): Promise<WorkflowOperateAnswer> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ unknown: '查询超时' }), budgetMs);
    (timer as { unref?: () => void }).unref?.();
    answer.then(
      (value) => resolve(value === 'yes' || value === 'no' || isOperateUnknown(value) ? value : { unknown: '查询结果无效' }),
      () => resolve({ unknown: '查询出错' }),
    ).finally(() => clearTimeout(timer));
  });
}

/** Gate-2's question names only the pending run and node; the executing
 *  bot's daemon reads the initiator and chat itself. */
export interface WorkflowWorkingDirOperatorRequest {
  runId: string;
  nodeId: string;
}

export function parseWorkflowWorkingDirOperatorRequest(raw: unknown): WorkflowWorkingDirOperatorRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'runId' && key !== 'nodeId')) return undefined;
  if (typeof body.runId !== 'string' || body.runId.length === 0 || body.runId.length > 256) return undefined;
  if (typeof body.nodeId !== 'string' || !NODE_ID_RE.test(body.nodeId)) return undefined;
  return { runId: body.runId, nodeId: body.nodeId };
}

/** The executing bot asking the main bot for the initiator's union_id. */
export interface WorkflowInitiatorUnionRequest {
  runId: string;
  /** The asking bot. The trusted-host IPC authenticates the host, not which
   *  bot's daemon is asking; this is checked against the run's executing
   *  bots so the route answers only for a run the asker takes part in. */
  requesterLarkAppId: string;
}

export function parseWorkflowInitiatorUnionRequest(raw: unknown): WorkflowInitiatorUnionRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'runId' && key !== 'requesterLarkAppId')) return undefined;
  if (typeof body.runId !== 'string' || body.runId.length === 0 || body.runId.length > 256) return undefined;
  const requester = body.requesterLarkAppId;
  if (typeof requester !== 'string' || requester.length === 0 || requester.length > 256) return undefined;
  return { runId: body.runId, requesterLarkAppId: requester };
}
