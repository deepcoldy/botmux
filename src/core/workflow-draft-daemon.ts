/**
 * Dashboard workflow drafts on the orchestrating bot's daemon (design
 * 2026-11-03 workflow-dashboard-orchestration §4.2–4.4, §4.6, §7.2, D2):
 * the IPC routes, and the production collaborators of the draft service.
 *
 * Routes (all under {@link WORKFLOW_DRAFTS_PATH}, deliberately outside the
 * workflow daemon-mutation protocol):
 *
 *   POST /drafts                                {larkAppId, goal, project?}  新建
 *   GET  /drafts/:runId                                                 读（管理员）
 *   POST /drafts/:runId/messages                {text}                  对话一轮
 *   POST /drafts/:runId/clarify/continue        {project?}              「继续」
 *   POST /drafts/:runId/spec                    {specMarkdown?, relayProblems?}  定稿 / 改完重新校验
 *   POST /drafts/:runId/approve-spec                                    第一道确认
 *   POST /drafts/:runId/architect               {note?}                 编排 / 重新编排
 *   POST /drafts/:runId/architect/cancel                                取消编排
 *   POST /drafts/:runId/nodes/:nodeId/bot       {larkAppId}             换执行 Bot
 *   POST /drafts/:runId/approve-flow            {flowSummarySha256}     第二道确认
 *   POST /drafts/:runId/revise-spec                                     退回改需求
 *   POST /drafts/:runId/abandon                                         放弃
 *   POST /drafts/:runId/delete                                          删除
 *   POST /drafts/:runId/launch                  {groupName?, extraMembers?}  拉群开始（D4）
 *   POST /drafts/:runId/launch/continue                                 断点续做
 *   POST /drafts/:runId/launch/abandon                                  放弃（群保留）
 *   POST /drafts/:runId/launch/resend-root      {confirmedAbsent: true} 人工确认群里没有根卡片后重发
 *   POST /drafts/:runId/launch/resend-summary   {confirmedAbsent: true} 人工确认群里没有摘要后重发
 *   POST /drafts/:runId/template/preview        {workflowId?, paramEdits?}   存为模板的确认框（D5）
 *   POST /drafts/:runId/template/save           {flowSummarySha256, …}       存为模板（D5）
 *   POST /drafts/from-source                    {source, larkAppId?, project?}  复制为新工作流（D6）
 *   POST /drafts/:runId/copy/goal               {goal, mode}            复制的草稿改目标（D6）
 *   POST /drafts/:runId/nodes/:nodeId/text      {goal?, completion?}    复制的草稿改节点文字（D6）
 *   POST /drafts/:runId/handoff/prepare         {toLarkAppId}           换编排 Bot 第 1 步（现编排 Bot：记目标、关澄清会话）
 *   POST /drafts/:runId/handoff/accept          {token}                 换编排 Bot 第 2 步（新编排 Bot：接管、起新会话）
 *   POST /drafts/:runId/handoff/cancel                                  取消更换（现编排 Bot）
 *
 * Templates (D5, under {@link WORKFLOW_LIBRARY_PATH}; reads are the
 * Dashboard's own, from disk):
 *
 *   POST /library/runs/:runId/save/preview      {workflowId?, paramEdits?, allowDraft?}  保存为模板的确认框
 *   POST /library/runs/:runId/save              {workflowId?, expectedLatestRevision?, displayName?, paramEdits?, requestKey?, …}
 *   POST /library/:workflowId/run               {params, expectedRevisionId?, project?}  运行模板 → 草稿
 *
 * Projects ({@link WORKFLOW_PROJECTS_PATH}): where this bot's drafts are
 * clarified — its default dir, or the Feishu repo picker's candidates to
 * pick from (`project` above must be one of them):
 *
 *   GET  /projects                                                      新建表单的「项目」
 *
 * The launch record is part of GET /drafts/:runId (`launch`).
 *
 * Every write body may carry `baseVersion` (CAS on the draft version).
 *
 * Authorization, in this order, on the daemon (the page's disabled buttons
 * are display only, §7.2):
 *   1. the request passed the trusted-host signature;
 *   2. `workflow.enabled` and `workflow.nodeExecutor = bot`;
 *   3. writes: the D1 initiator resolution (incl. the I1 canOperate gate),
 *      then the service compares it with the draft's recorded initiator (I6).
 * Reads need 1 and 2 only (any Dashboard admin may look, §7.2).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { config } from '../config.js';
import { loadBotConfigs } from '../bot-registry.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { v3BotDisplayNameResolver } from '../im/lark/v3-bot-eligibility.js';
import { getBotCapability } from '../services/bot-profile-store.js';
import { logger } from '../utils/logger.js';
import { defaultBaseDir } from '../workflows/v3/grill-state.js';
import { runArchitect } from '../workflows/v3/architect.js';
import {
  WorkflowDraftError,
  WorkflowDraftService,
  type DraftClarifier,
  type DraftClarifyResult,
  type WorkflowDraftProjects,
} from '../workflows/v3/draft-service.js';
import type { WorkflowDraftInitiator } from '../workflows/v3/draft-store.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import type { DaemonSession } from './types.js';
import { initiatorFailureBody, type WorkflowInitiatorResolution } from './workflow-initiator.js';
import { joinLaunchInitiator, type DraftLaunchDeps } from '../workflows/v3/draft-launch.js';
import { createLiveV3BotEligibilityProbe } from '../im/lark/v3-bot-eligibility.js';
import { buildV3LaunchRootCard, buildV3LaunchSummaryText, isLaunchRootCardOf } from '../im/lark/v3-launch-card.js';
import { getMessageDetail, listChatMessagesUntil, replyMessage, resolveAllowedUsersWithMap, sendMessage, updateMessage } from '../im/lark/client.js';
import { createGroupWithBots, transferGroupOwner } from '../services/group-creator.js';
import { addBotToChat, addUsersToChatByOpenId, addUsersToChatByUnionId, getChatOwner, listChatMemberDisplays, listChats } from '../services/groups-store.js';
import { requestExactChatGrant } from '../cli/exact-chat-grant-client.js';
import { loadDaemonIpcSecret } from './daemon-ipc-auth.js';
import { resolveWorkflowEntryLink } from './workflow-entry-link.js';
import { getBotBrand, getBotOpenId } from '../bot-registry.js';

export const WORKFLOW_DRAFTS_PATH = '/api/v3/orchestration/drafts';
export const WORKFLOW_LIBRARY_PATH = '/api/v3/orchestration/library';
export const WORKFLOW_PROJECTS_PATH = '/api/v3/orchestration/projects';

/** How far back (messages) / how many candidates are read in full when
 *  looking for a root card past Feishu's uuid window. */
const ROOT_CARD_SCAN_MAX = 500;
const ROOT_CARD_DETAIL_MAX = 30;

/** How often the daemon closes idle clarify processes (§4.2). */
const IDLE_SWEEP_MS = 5 * 60_000;

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;

export interface WorkflowDraftIpcContext {
  appId: () => string;
  featureEnabled: () => boolean;
  trustedHost: (req: IncomingMessage) => boolean;
  /** D1's `dashboardWorkflowInitiator`. */
  resolveInitiator: (req: IncomingMessage) => Promise<WorkflowInitiatorResolution>;
  service: () => WorkflowDraftService | undefined;
  readJsonBody: (req: IncomingMessage) => Promise<unknown>;
  jsonRes: (res: ServerResponse, status: number, body: unknown) => void;
}

function bodyObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function baseVersionOf(body: Record<string, unknown>): number | undefined | 'bad' {
  if (body.baseVersion === undefined) return undefined;
  return typeof body.baseVersion === 'number' && Number.isInteger(body.baseVersion) && body.baseVersion >= 1
    ? body.baseVersion
    : 'bad';
}

function hasRequestBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  if (typeof length === 'string' && /^\d+$/.test(length)) return Number(length) > 0;
  return req.headers['transfer-encoding'] !== undefined;
}

function decodeParam(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

/**
 * Register the draft routes on the daemon IPC server. `route` is
 * dashboard-ipc-server's `ipcRoute`.
 */
export function registerWorkflowDraftIpcRoutes(
  route: (method: string, path: string, handler: Handler) => void,
  ctx: WorkflowDraftIpcContext,
): void {
  const fail = (res: ServerResponse, status: number, error: string, extra: Record<string, unknown> = {}) =>
    ctx.jsonRes(res, status, { ok: false, error, retryable: false, ...extra });

  /** Gates 1–2; the service when they pass. */
  const gate = (req: IncomingMessage, res: ServerResponse): WorkflowDraftService | undefined => {
    if (!ctx.trustedHost(req)) { fail(res, 401, 'untrusted_caller'); return undefined; }
    if (!ctx.featureEnabled()) { fail(res, 409, 'feature_disabled'); return undefined; }
    const service = ctx.service();
    if (!service || !ctx.appId()) { fail(res, 503, 'drafts_unavailable'); return undefined; }
    return service;
  };

  const respondError = (res: ServerResponse, error: unknown, what: string) => {
    if (error instanceof WorkflowDraftError) {
      ctx.jsonRes(res, error.status, { ok: false, error: error.code, message: error.message, retryable: error.retryable, ...error.details });
      return;
    }
    logger.warn(`[workflow-draft] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    ctx.jsonRes(res, 500, { ok: false, error: 'internal_error', retryable: true });
  };

  /** A write route: gates, the verified initiator, the JSON body. */
  const write = (
    path: string,
    fn: (input: {
      service: WorkflowDraftService;
      initiator: WorkflowDraftInitiator;
      body: Record<string, unknown>;
      baseVersion?: number;
      runId: string;
      params: Record<string, string>;
    }) => Promise<unknown>,
  ) => route('POST', path, async (req, res, params) => {
    const service = gate(req, res);
    if (!service) return;
    const runId = decodeParam(params.runId) ?? '';
    // Every write names its initiator and carries a JSON object body, `{}` at
    // least: a body-less request may have taken the platform's direct path,
    // where nobody is identified (D1 review).
    if (!hasRequestBody(req)) return fail(res, 400, 'json_body_required');
    let raw: unknown;
    try { raw = await ctx.readJsonBody(req); } catch { return fail(res, 400, 'invalid_json'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(res, 400, 'json_body_required');
    const resolved = await ctx.resolveInitiator(req);
    if (!resolved.ok) return ctx.jsonRes(res, resolved.status, initiatorFailureBody(resolved));
    const body = bodyObject(raw);
    const baseVersion = baseVersionOf(body);
    if (baseVersion === 'bad') return fail(res, 400, 'bad_request', { message: 'baseVersion 必须是正整数' });
    try {
      const result = await fn({ service, initiator: resolved.initiator, body, ...(baseVersion ? { baseVersion } : {}), runId, params });
      ctx.jsonRes(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (error) {
      respondError(res, error, `${path} ${runId}`);
    }
  });

  write(WORKFLOW_DRAFTS_PATH, async ({ service, initiator, body }) => {
    // The Dashboard routed this to the bot it names; a mis-routed create must
    // not birth a draft under another orchestrator.
    if (body.larkAppId !== ctx.appId()) {
      throw new WorkflowDraftError('bot_mismatch', '请求的编排 Bot 不是这个 daemon 的 Bot');
    }
    return { draft: await service.create(initiator, { goal: body.goal, project: body.project }) };
  });

  // 复制为新工作流（D6）: the copier is the new draft's initiator.
  write(`${WORKFLOW_DRAFTS_PATH}/from-source`, async ({ service, initiator, body }) =>
    ({ draft: await service.createFromSource(initiator, {
      source: body.source,
      ...(body.larkAppId !== undefined ? { larkAppId: body.larkAppId } : {}),
      project: body.project,
    }) }));

  route('GET', WORKFLOW_PROJECTS_PATH, async (req, res) => {
    const service = gate(req, res);
    if (!service) return;
    try {
      ctx.jsonRes(res, 200, { ok: true, project: service.projectOptions() });
    } catch (error) {
      respondError(res, error, 'projects');
    }
  });

  route('GET', `${WORKFLOW_DRAFTS_PATH}/:runId`, async (req, res, params) => {
    const service = gate(req, res);
    if (!service) return;
    const runId = decodeParam(params.runId) ?? '';
    try {
      ctx.jsonRes(res, 200, { ok: true, draft: await service.view(runId) });
    } catch (error) {
      respondError(res, error, `view ${runId}`);
    }
  });

  const draftPath = (tail: string) => `${WORKFLOW_DRAFTS_PATH}/:runId/${tail}`;
  write(draftPath('messages'), async ({ service, initiator, body, baseVersion, runId }) =>
    ({ draft: await service.sendMessage(runId, initiator, { text: body.text, baseVersion }) }));
  write(draftPath('clarify/continue'), async ({ service, initiator, body, baseVersion, runId }) =>
    ({ draft: await service.continueClarify(runId, initiator, { baseVersion, project: body.project }) }));
  write(draftPath('spec'), async ({ service, initiator, body, baseVersion, runId }) =>
    service.finalizeSpec(runId, initiator, { specMarkdown: body.specMarkdown, relayProblems: body.relayProblems, baseVersion }));
  write(draftPath('approve-spec'), async ({ service, initiator, baseVersion, runId }) =>
    ({ draft: await service.approveSpec(runId, initiator, { baseVersion }) }));
  write(draftPath('architect'), async ({ service, initiator, body, baseVersion, runId }) =>
    ({ draft: await service.startArchitect(runId, initiator, { note: body.note, baseVersion }) }));
  write(draftPath('architect/cancel'), async ({ service, initiator, runId }) =>
    ({ draft: await service.cancelArchitect(runId, initiator) }));
  write(draftPath('nodes/:nodeId/bot'), async ({ service, initiator, body, baseVersion, runId, params }) => {
    const nodeId = decodeParam(params.nodeId);
    if (!nodeId) throw new WorkflowDraftError('bad_request', 'nodeId 不合法');
    return { draft: await service.setNodeBot(runId, initiator, nodeId, { larkAppId: body.larkAppId, baseVersion }) };
  });
  write(draftPath('nodes/:nodeId/text'), async ({ service, initiator, body, baseVersion, runId, params }) => {
    const nodeId = decodeParam(params.nodeId);
    if (!nodeId) throw new WorkflowDraftError('bad_request', 'nodeId 不合法');
    return { draft: await service.setNodeText(runId, initiator, nodeId, { goal: body.goal, completion: body.completion, baseVersion }) };
  });
  write(draftPath('copy/goal'), async ({ service, initiator, body, baseVersion, runId }) =>
    ({ draft: await service.editCopyGoal(runId, initiator, { goal: body.goal, mode: body.mode, baseVersion }) }));
  write(draftPath('approve-flow'), async ({ service, initiator, body, baseVersion, runId }) =>
    ({ draft: await service.approveFlow(runId, initiator, { flowSummarySha256: body.flowSummarySha256, baseVersion }) }));
  write(draftPath('revise-spec'), async ({ service, initiator, baseVersion, runId }) =>
    ({ draft: await service.reviseSpec(runId, initiator, { baseVersion }) }));
  write(draftPath('abandon'), async ({ service, initiator, runId }) =>
    ({ draft: await service.abandon(runId, initiator) }));
  write(draftPath('delete'), async ({ service, initiator, runId }) => {
    await service.delete(runId, initiator);
    return { deleted: runId };
  });
  write(draftPath('launch'), async ({ service, initiator, body, baseVersion, runId }) =>
    ({ draft: await service.launch(runId, initiator, { groupName: body.groupName, extraMembers: body.extraMembers, baseVersion }) }));
  write(draftPath('launch/continue'), async ({ service, initiator, baseVersion, runId }) =>
    ({ draft: await service.continueLaunch(runId, initiator, { baseVersion }) }));
  write(draftPath('launch/abandon'), async ({ service, initiator, runId }) =>
    ({ draft: await service.abandonLaunch(runId, initiator) }));
  write(draftPath('launch/resend-root'), async ({ service, initiator, body, baseVersion, runId }) =>
    ({ draft: await service.resendRoot(runId, initiator, { confirmedAbsent: body.confirmedAbsent, baseVersion }) }));
  // 换编排 Bot: prepare / cancel on the current orchestrator, accept on the
  // target — the Dashboard routes accept to the bot the handoff names; the
  // service checks that this daemon is that bot.
  write(draftPath('handoff/prepare'), async ({ service, initiator, body, baseVersion, runId }) =>
    service.prepareHandoff(runId, initiator, { toLarkAppId: body.toLarkAppId, baseVersion }));
  write(draftPath('handoff/accept'), async ({ service, initiator, body, runId }) =>
    ({ draft: await service.acceptHandoff(runId, initiator, { token: body.token }) }));
  write(draftPath('handoff/cancel'), async ({ service, initiator, runId }) =>
    ({ draft: await service.cancelHandoff(runId, initiator) }));
  write(draftPath('launch/resend-summary'), async ({ service, initiator, body, runId }) =>
    ({ draft: await service.resendSummary(runId, initiator, { confirmedAbsent: body.confirmedAbsent }) }));

  // ── 模板（D5）──
  write(draftPath('template/preview'), async ({ service, initiator, body, runId }) =>
    ({ preview: await service.previewTemplateSave(runId, initiator, { workflowId: body.workflowId, paramEdits: body.paramEdits }) }));
  write(draftPath('template/save'), async ({ service, initiator, body, runId }) =>
    ({ saved: await service.saveAsTemplate(runId, initiator, {
      flowSummarySha256: body.flowSummarySha256,
      workflowId: body.workflowId,
      expectedLatestRevision: body.expectedLatestRevision,
      displayName: body.displayName,
      paramEdits: body.paramEdits,
      requestKey: body.requestKey,
      acknowledgeUnsafeLiterals: body.acknowledgeUnsafeLiterals,
    }) }));
  write(`${WORKFLOW_LIBRARY_PATH}/runs/:runId/save/preview`, async ({ service, initiator, body, runId }) =>
    ({ preview: await service.previewRunSave(runId, initiator, { workflowId: body.workflowId, allowDraft: body.allowDraft, paramEdits: body.paramEdits }) }));
  write(`${WORKFLOW_LIBRARY_PATH}/runs/:runId/save`, async ({ service, initiator, body, runId }) =>
    ({ saved: await service.saveRunAsTemplate(runId, initiator, {
      workflowId: body.workflowId,
      expectedLatestRevision: body.expectedLatestRevision,
      displayName: body.displayName,
      paramEdits: body.paramEdits,
      requestKey: body.requestKey,
      allowDraft: body.allowDraft,
      acknowledgeUnsafeLiterals: body.acknowledgeUnsafeLiterals,
    }) }));
  write(`${WORKFLOW_LIBRARY_PATH}/:workflowId/run`, async ({ service, initiator, body, params }) =>
    ({ draft: await service.createFromTemplate(initiator, {
      workflowId: decodeParam(params.workflowId),
      params: body.params,
      expectedRevisionId: body.expectedRevisionId,
      project: body.project,
    }) }));
}

// ─── 拉群开始 collaborators (D4) ──────────────────────────────────────────

export interface ProductionDraftLaunchInput {
  appId: string;
  /** The daemon's own `workflow start` path (daemon.ts). */
  startRun: DraftLaunchDeps['startRun'];
  /** Headless bind into the main topic (dashboard-ipc-server). */
  bindSession: DraftLaunchDeps['bindSession'];
  /** §5.2 rule 3: main-topic availability from the bound session. */
  mainTopicAvailability: DraftLaunchDeps['mainTopicAvailability'];
}

/** Lark, sessions and grants for 拉群开始, all through the main bot's own app
 *  (and each receiver's own daemon for its side of a grant). */
export function createProductionDraftLaunchDeps(input: ProductionDraftLaunchInput): DraftLaunchDeps {
  const { appId } = input;
  const entry = (runId: string) => resolveWorkflowEntryLink({ mainLarkAppId: appId, runId, brand: getBotBrand(appId) });
  const receiverDaemon = (larkAppId: string) => {
    const daemon = findOnlineDaemon(larkAppId, config.session.dataDir);
    if (!daemon) throw new Error(`receiver daemon offline: ${larkAppId}`);
    return daemon;
  };
  return {
    async resolveEmails(emails) {
      const resolved = await resolveAllowedUsersWithMap(appId, emails);
      const openIds = new Map<string, string>();
      for (const email of emails) {
        const openId = resolved.map.get(email);
        if (openId?.startsWith('ou_')) openIds.set(email, openId);
      }
      if (openIds.size < emails.length && resolved.errored) {
        return { ok: false, retryable: true, message: '通讯录查询暂时失败，请稍后重试' };
      }
      return { ok: true, openIds };
    },
    async createGroup(group) {
      const owner = group.owner;
      const result = await createGroupWithBots({
        creatorLarkAppId: appId,
        larkAppIds: group.botAppIds,
        name: group.name,
        chatMode: 'topic',
        userOpenIds: [...(owner.channel === 'open_id' ? [owner.openId] : []), ...group.extraOpenIds],
        ownerUnionIds: [...(owner.channel === 'union_id' ? [owner.unionId] : []), ...group.extraUnionIds],
        ...(owner.channel === 'open_id' ? { transferOwnerTo: owner.openId } : { transferOwnerUnionId: owner.unionId }),
        // No kickoff, no role bootstrap, no @-notice: the root card is the
        // group's first top-level message, and nothing wakes a bot.
        ownerNotice: false,
        onChatCreated: group.onChatCreated,
      });
      const initiatorJoined = owner.channel === 'open_id'
        ? !result.invalidUserIds.includes(owner.openId)
        : !result.invalidOwnerUnionIds.includes(owner.unionId);
      const warnings: string[] = [];
      const extraUsers = result.invalidUserIds.filter((id) => owner.channel !== 'open_id' || id !== owner.openId);
      const extraUnions = result.invalidOwnerUnionIds.filter((id) => owner.channel !== 'union_id' || id !== owner.unionId);
      if (result.invalidBotIds.length) warnings.push(`这些 Bot 没拉进群：${result.invalidBotIds.join('、')}`);
      if (extraUsers.length || extraUnions.length) warnings.push(`这些成员没拉进群：${[...extraUsers, ...extraUnions].join('、')}`);
      return {
        chatId: result.chatId,
        ...(result.shareLink ? { shareLink: result.shareLink } : {}),
        warnings,
        initiatorJoined,
        ...(initiatorJoined && result.transferError ? { ownerTransferError: result.transferError } : {}),
      };
    },
    async joinInitiator(chatId, owner) {
      const id = owner.channel === 'open_id' ? owner.openId : owner.unionId;
      // The member list is read by open_id in the main bot's own app; a
      // union_id is turned into that app's open_id there first (no open_id
      // ever comes from another app).
      const memberOpenId = async (): Promise<string> => {
        if (owner.channel === 'open_id') return owner.openId;
        const resolved = await resolveAllowedUsersWithMap(appId, [owner.unionId]);
        const openId = resolved.map.get(owner.unionId);
        if (!openId?.startsWith('ou_')) throw new Error('发起人的 union_id 在编排 Bot 的应用里换算不出 open_id');
        return openId;
      };
      return joinLaunchInitiator(id, {
        owner: () => getChatOwner(appId, chatId, owner.channel),
        isMember: async () => {
          const openId = await memberOpenId();
          return (await listChatMemberDisplays(appId, chatId)).some((member) => member.openId === openId);
        },
        invite: async () => {
          const added = owner.channel === 'open_id'
            ? await addUsersToChatByOpenId(appId, chatId, [owner.openId])
            : await addUsersToChatByUnionId(appId, chatId, [owner.unionId]);
          return { invalid: added.invalidUserIds.length > 0 };
        },
        transferOwner: async () => {
          const transferred = await transferGroupOwner({ creatorLarkAppId: appId, chatId, ownerId: id, ownerIdType: owner.channel });
          return transferred.transferError ? { error: transferred.transferError } : {};
        },
      });
    },
    listChats: async () => (await listChats(appId)).map((chat) => ({
      chatId: chat.chatId,
      ...(chat.name ? { name: chat.name } : {}),
      ...(chat.chatMode ? { chatMode: chat.chatMode } : {}),
      ...(chat.ownerId ? { ownerId: chat.ownerId } : {}),
    })),
    isSelfOwner: (ownerId) => !!ownerId && (ownerId === appId || ownerId === getBotOpenId(appId)),
    async findRootCards(chatId, runId, sinceIso) {
      // Newest first, back to the first try (a minute of slack for clock
      // skew), bounded. The list API gives schema-2.0 cards as a placeholder,
      // so every candidate — the main bot's own top-level interactive
      // message — is read in full and matched on its signature row.
      const sinceMs = Date.parse(sinceIso) - 60_000;
      if (!Number.isFinite(sinceMs)) throw new Error('inconclusive: 首次尝试时间不合法');
      const timeOf = (message: any) => Number(message?.create_time);
      const scanned = await listChatMessagesUntil(appId, chatId, {
        pageSize: 50,
        stopAfter: (message: any, seen: number) => !(timeOf(message) >= sinceMs) || seen >= ROOT_CARD_SCAN_MAX,
      });
      // Anything that makes "not found" unprovable is inconclusive — the
      // caller then stops as for a failed lookup, never as "not there":
      //   a time that is not a millisecond timestamp (missing, or seconds),
      //   a scan cut by its cap before reaching the first try.
      const oldest = scanned[0];
      if (scanned.some((message: any) => !Number.isFinite(timeOf(message)) || timeOf(message) < 1e12)) {
        throw new Error('inconclusive: 群消息的时间无法判断');
      }
      if (scanned.length >= ROOT_CARD_SCAN_MAX && oldest && timeOf(oldest) >= sinceMs) {
        throw new Error(`inconclusive: 首次尝试之后的群消息超过 ${ROOT_CARD_SCAN_MAX} 条`);
      }
      const selfOpenId = getBotOpenId(appId);
      const candidates = scanned
        .filter((message: any) => message?.msg_type === 'interactive' && message.deleted !== true
          && (message?.sender?.sender_type === 'app' || message?.sender?.sender_type === 'bot')
          && (message.sender.id === appId || (!!selfOpenId && message.sender.id === selfOpenId))
          && !message.root_id && !message.parent_id
          && Number(message.create_time) >= sinceMs
          && /^om_[A-Za-z0-9_-]{1,128}$/.test(String(message.message_id)))
        .map((message: any) => String(message.message_id));
      if (candidates.length > ROOT_CARD_DETAIL_MAX) {
        throw new Error(`inconclusive: 首次尝试之后主 Bot 发的卡片超过 ${ROOT_CARD_DETAIL_MAX} 张`);
      }
      const found: string[] = [];
      for (const messageId of candidates) {
        const detail = await getMessageDetail(appId, messageId, { userCardContent: true });
        if (isLaunchRootCardOf(detail?.items?.[0]?.body?.content, runId)) found.push(messageId);
      }
      return found;
    },
    async addBots(chatId, botAppIds) {
      await addBotToChat(appId, chatId, botAppIds);
    },
    postRootCard: (chatId, view, uuid) => sendMessage(appId, chatId, buildV3LaunchRootCard(view, entry(view.runId)), 'interactive', uuid),
    async updateRootCard(messageId, view) {
      await updateMessage(appId, messageId, buildV3LaunchRootCard(view, entry(view.runId)));
    },
    postSummary: (rootMessageId, view, uuid) =>
      replyMessage(appId, rootMessageId, buildV3LaunchSummaryText(view, entry(view.runId)?.url), 'text', true, uuid),
    bindSession: input.bindSession,
    probe: (chatId) => createLiveV3BotEligibilityProbe({ orchestratorAppId: appId, chatId, bots: loadBotConfigs() }),
    async grant(chatId, receiver, subject) {
      const body = await requestExactChatGrant({
        daemon: receiverDaemon(receiver),
        secret: loadDaemonIpcSecret(),
        receiverLarkAppId: receiver,
        chatId,
        operation: 'grant',
        subjectLarkAppIds: [subject],
      });
      const mapping = (body.subjectMappings as Array<{ larkAppId?: string; subjectOpenId?: string }> | undefined)
        ?.find((item) => item.larkAppId === subject);
      if (!mapping?.subjectOpenId) throw new Error('授权结果里没有对方的 open_id');
      return { subjectOpenId: mapping.subjectOpenId };
    },
    async revoke(chatId, receiver, subjectOpenId) {
      await requestExactChatGrant({
        daemon: receiverDaemon(receiver),
        secret: loadDaemonIpcSecret(),
        receiverLarkAppId: receiver,
        chatId,
        operation: 'revoke',
        subjectOpenIds: [subjectOpenId],
      });
    },
    async resolveSubject(chatId, receiver, subjectAppId) {
      const body = await requestExactChatGrant({
        daemon: receiverDaemon(receiver),
        secret: loadDaemonIpcSecret(),
        receiverLarkAppId: receiver,
        chatId,
        operation: 'resolve',
        subjectLarkAppIds: [subjectAppId],
      });
      const mapping = (body.subjectMappings as Array<{ larkAppId?: string; subjectOpenId?: string }> | undefined)
        ?.find((item) => item.larkAppId === subjectAppId);
      if (!mapping?.subjectOpenId) throw new Error('接收方没有给出对方的 open_id');
      return mapping.subjectOpenId;
    },
    startRun: input.startRun,
    mainTopicAvailability: input.mainTopicAvailability,
  };
}

// ─── Production collaborators ─────────────────────────────────────────────

export interface ProductionDraftClarifierDeps {
  activeSessions: () => Map<string, DaemonSession> | undefined;
  createHeadlessSession: (
    activeSessions: Map<string, DaemonSession>,
    args: { larkAppId: string; title: string; workingDir: string; failureDiagnostics: true },
  ) => Promise<{ ok: true; headlessId: string; sessionId: string } | { ok: false; error: string }>;
  triggerSessionTurn: (req: TriggerRequest, deps: { larkAppId: string; activeSessions: Map<string, DaemonSession> }) => Promise<TriggerResponse>;
  lookupTriggerResult: (sessionId: string, triggerId: string) => TriggerResponse;
  sessionStatus: (sessionId: string) => string | undefined;
  suspendWorker: (ds: DaemonSession, reason: string) => boolean;
  /** tmux / herdr / zellij / zmx: the process can go dormant. */
  isSuspendable: (ds: DaemonSession) => boolean;
  /** Not remote, not in transfer, no protected dispatch ownership. */
  canRetireWorker: (ds: DaemonSession) => boolean;
  killWorker: (ds: DaemonSession) => void;
  /** A worker of this session is being retired / restarted right now. */
  lifecycleInFlight: (ds: DaemonSession) => boolean;
  closeSession: (sessionId: string) => Promise<unknown>;
  deleteHeadlessRecord: (headlessId: string) => void;
}

/** The clarify session over the daemon's own headless-session machinery
 *  (the same calls `/api/headless/sessions`, `/api/trigger` and
 *  `/trigger-result` make), in process. */
export function createProductionDraftClarifier(deps: ProductionDraftClarifierDeps): DraftClarifier {
  const findActive = (sessionId: string): DaemonSession | undefined => {
    for (const ds of deps.activeSessions()?.values() ?? []) {
      if (ds.session.sessionId === sessionId) return ds;
    }
    return undefined;
  };
  return {
    async create({ larkAppId, title, workingDir }) {
      const active = deps.activeSessions();
      if (!active) return { ok: false, error: 'registry_unavailable' };
      // The failure panel reads this session's failed turns (provider error,
      // screen tail); no other session pays for capturing them.
      return deps.createHeadlessSession(active, { larkAppId, title, workingDir, failureDiagnostics: true });
    },
    async send({ larkAppId, sessionId, headlessId, prompt, requestId }) {
      const active = deps.activeSessions();
      if (!active) return { ok: false, error: 'registry_unavailable', disconnected: false };
      // A closed session is not resumed here: 「继续」 starts a fresh one with
      // the spec so far (§9).
      const status = deps.sessionStatus(sessionId);
      if (!status || status === 'closed') return { ok: false, error: 'session_closed', disconnected: true };
      // Between retiring a worker (idle release, restart) and the old worker's
      // exit, a turn would race the dying process: ask to retry instead.
      const live = findActive(sessionId);
      if (live && deps.lifecycleInFlight(live)) return { ok: false, error: 'session_lifecycle_in_flight', disconnected: false, busy: true };
      const request: TriggerRequest = {
        source: {
          type: 'headless',
          connectorId: 'botmux-workflow-draft',
          requestId: `${headlessId}:${requestId}`.slice(0, 256),
          receivedAt: new Date().toISOString(),
        },
        target: { kind: 'turn', botId: larkAppId, sessionId },
        envelope: {
          format: 'botmux.headless.v1',
          sourceName: 'botmux workflow draft',
          trusted: false,
          payload: { prompt },
          rawText: prompt,
        },
        instruction: prompt,
        options: { asyncReturnSessionId: true },
      };
      const response = await deps.triggerSessionTurn(request, { larkAppId, activeSessions: active });
      if (response.ok && response.triggerId) return { ok: true, triggerId: response.triggerId };
      return {
        ok: false,
        error: response.error ?? response.errorCode ?? 'trigger_failed',
        disconnected: response.errorCode === 'session_not_found',
      };
    },
    result(sessionId, triggerId): DraftClarifyResult {
      const response = deps.lookupTriggerResult(sessionId, triggerId);
      if (response.state === 'completed') {
        return { state: 'completed', content: response.output?.content ?? '', ...(response.finishedAt ? { finishedAt: response.finishedAt } : {}) };
      }
      if (response.state === 'running') return { state: 'running' };
      if (response.state === 'failed') {
        return {
          state: 'failed',
          ...(response.error ? { error: response.error } : {}),
          ...(response.terminalErrorCode ? { errorCode: response.terminalErrorCode } : {}),
          ...(response.terminalErrorDetail ? { errorDetail: response.terminalErrorDetail } : {}),
          ...(response.terminalScreenTail ? { terminalTail: response.terminalScreenTail } : {}),
        };
      }
      return { state: 'not_found' };
    },
    suspend(sessionId) {
      const ds = findActive(sessionId);
      if (!ds) return true; // nothing live: the goal state already holds
      if (!ds.worker || ds.worker.killed) return true;
      if (deps.isSuspendable(ds)) return deps.suspendWorker(ds, 'workflow_draft_idle');
      // A pty-like backend cannot go dormant: retire the worker as /cd does
      // there — the session record stays and the next message cold-starts the
      // CLI with resume. A remote backend (riff / mojo) is never retired this
      // way, nor a session in transfer or holding dispatch ownership.
      if (!deps.canRetireWorker(ds)) return false;
      ds.hasHistory = true;
      deps.killWorker(ds);
      return true;
    },
    async close({ sessionId, headlessId }) {
      if (deps.sessionStatus(sessionId) && deps.sessionStatus(sessionId) !== 'closed') {
        const result = await deps.closeSession(sessionId);
        // A refused close leaves the session active: report it so the draft
        // keeps the id and the sweep retries.
        if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
          throw new Error(`close refused: ${String((result as { error?: unknown }).error ?? 'unknown')}`);
        }
      }
      if (headlessId) deps.deleteHeadlessRecord(headlessId);
    },
  };
}

let installed: WorkflowDraftService | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

/** The daemon's draft service (one per daemon process). */
export function workflowDraftService(): WorkflowDraftService | undefined {
  return installed;
}

/**
 * Daemon boot: build the service for this bot, return drafts left 编排中 by
 * the previous process to 待编排 (§9), and start the idle sweep (§4.2). Also
 * the test seam: tests install a service with fake collaborators.
 */
export function installWorkflowDraftService(service: WorkflowDraftService, opts: { sweep?: boolean } = {}): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
  installed = service;
  service.recoverInterrupted();
  if (opts.sweep !== false) {
    sweepTimer = setInterval(() => {
      void service.sweepIdleClarify().catch(() => {});
    }, IDLE_SWEEP_MS);
    sweepTimer.unref?.();
  }
}

export function resetWorkflowDraftServiceForTests(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
  installed = undefined;
}

export function createProductionWorkflowDraftService(
  appId: string,
  clarifier: DraftClarifier,
  projects: WorkflowDraftProjects,
  launch?: DraftLaunchDeps,
): WorkflowDraftService {
  return new WorkflowDraftService({
    appId,
    baseDir: defaultBaseDir(),
    loadBots: () => loadBotConfigs(),
    nameOf: () => v3BotDisplayNameResolver(),
    roleOf: () => (larkAppId) => getBotCapability(config.session.dataDir, larkAppId) ?? undefined,
    isDaemonOnline: (larkAppId) => {
      try { return findOnlineDaemon(larkAppId, config.session.dataDir) !== null; } catch { return false; }
    },
    daemonReadsNodeProjectDir: (larkAppId) => {
      try { return findOnlineDaemon(larkAppId, config.session.dataDir)?.workflowNodeProjectDir === 'v1'; } catch { return false; }
    },
    clarifier,
    projects,
    runArchitect,
    ...(launch ? { launch } : {}),
    log: (message) => logger.info(message),
  });
}
