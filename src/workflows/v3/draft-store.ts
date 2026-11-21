/**
 * Dashboard workflow drafts — the on-disk record (design 2026-11-03
 * workflow-dashboard-orchestration §2 草稿, §4.2–4.4, §4.6, D2).
 *
 * A draft is an ordinary grill run without a chat binding: a v3 run dir under
 * `~/.botmux/v3-runs/<runId>` with `grill.state.json` (the existing state
 * machine, unchanged) and no `run.json`. Everything the grill state cannot
 * hold lives beside it in `draft.json`:
 *
 *   - the orchestrating bot and the initiator (who alone may write, I6);
 *   - the clarify session (a headless session of the orchestrating bot) and
 *     its turns;
 *   - the Architect background task;
 *   - the two confirmations, each pinned to content digests so any later
 *     change of the flow definition voids them (E5, §4.4);
 *   - abandon / delete marks.
 *
 * Writes are read-modify-write under `draft.json.lock` with a monotonically
 * increasing `version` (callers may CAS on it). Lock order, fixed:
 *
 *   draft.json.lock -> grill.state.json.lock -> run.json.lock
 *
 * The draft lock is never held across an await, and nothing that holds the
 * grill lock takes the draft lock.
 *
 * Pure fs: the Dashboard reads the list from disk with this module; the
 * orchestrating bot's daemon is the only writer (draft-service.ts).
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';

import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { FileLockTimeoutError, withFileLockSync } from '../../utils/file-lock.js';
import { readGrillState, type GrillState, type GrillStatus } from './grill-state.js';
import { V3_RUN_ENVELOPE_FILE } from './run-envelope.js';
import { V3FlowSummarySchema } from './flow-summary.js';
import { isValidRunId } from './ops-projection.js';
import {
  WORKFLOW_DRAFT_FAILURE_CATEGORIES,
  WORKFLOW_DRAFT_FAILURE_CODE_RE,
  WORKFLOW_DRAFT_FAILURE_STEPS,
} from './draft-failure.js';

export const WORKFLOW_DRAFT_FILE = 'draft.json';
export const WORKFLOW_DRAFT_SCHEMA_VERSION = 1 as const;
/** §4.6: a draft without activity for this long is greyed out and deletable. */
export const WORKFLOW_DRAFT_STALE_MS = 30 * 24 * 60 * 60_000;
/** Turns kept in draft.json (the oldest drop first). */
export const WORKFLOW_DRAFT_MAX_TURNS = 200;
/** One turn's text is cut here; a spec candidate has its own field. */
export const WORKFLOW_DRAFT_MAX_TURN_CHARS = 64_000;
/** Clarify sessions whose close failed, kept for the sweep to retry. */
export const WORKFLOW_DRAFT_MAX_ORPHANS = 20;
/** Orchestrator handoffs remembered (the oldest drop first). */
export const WORKFLOW_DRAFT_MAX_HANDOFFS = 20;
/** Bots whose model outcomes a draft remembers (the oldest drop first). */
export const WORKFLOW_DRAFT_MAX_MODEL_CALL_BOTS = 20;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const iso = z.string().min(1).max(64);
const sha = z.string().regex(SHA256_RE);
const openId = z.string().regex(/^ou_[A-Za-z0-9_-]{1,128}$/);

const initiatorSchema = z.object({
  openId,
  unionId: z.string().min(1).max(128).optional(),
  source: z.enum(['dashboard-local', 'dashboard-platform']),
}).strict();

const questionSchema = z.object({
  question: z.string().min(1).max(4000),
  options: z.array(z.string().min(1).max(1000)).max(20),
  recommended: z.string().min(1).max(1000).optional(),
}).strict();

const turnSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string().max(WORKFLOW_DRAFT_MAX_TURN_CHARS + 16),
  at: iso,
  triggerId: z.string().min(1).max(256).optional(),
  question: questionSchema.optional(),
  hasSpec: z.literal(true).optional(),
}).strict();

const reservationHolderSchema = z.object({
  pid: z.number().int().min(1),
  procStart: z.string().min(1).max(256).optional(),
  bootId: z.string().min(1).max(256).optional(),
  instance: z.string().min(1).max(64),
}).strict();

export type WorkflowDraftReservationHolder = z.infer<typeof reservationHolderSchema>;

const clarifySchema = z.object({
  headlessId: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  /** active: process may be live; suspended: idle-closed process, record kept
   *  (the next message resumes by CLI session id); disconnected: cannot be
   *  resumed — 「继续」 starts a new one; closed: abandoned/deleted;
   *  migrated: moved into the main topic by 拉群开始 (D4) — from then on it is
   *  that topic's session, never closed or suspended as a draft's. */
  state: z.enum(['active', 'suspended', 'disconnected', 'closed', 'migrated']),
  pending: z.object({
    triggerId: z.string().min(1).max(256),
    sentAt: iso,
    /** For a reservation: the process (and service instance) holding it, so
     *  another process only drops it once that holder is gone. */
    holder: reservationHolderSchema.optional(),
  }).strict().optional(),
  /** Last activity: a message sent or a reply landed (idle clock, §4.2). */
  lastMessageAt: iso.optional(),
  suspendedAt: iso.optional(),
  /** The process could not be released (non-suspendable backend); not
   *  retried until the next message. */
  suspendRefusedAt: iso.optional(),
  error: z.string().max(2000).optional(),
  turns: z.array(turnSchema).max(WORKFLOW_DRAFT_MAX_TURNS),
  /** The latest spec the model wrote (spec.md format), not yet finalized. */
  specCandidate: z.object({
    triggerId: z.string().min(1).max(256).optional(),
    markdown: z.string().min(1).max(256_000),
    at: iso,
  }).strict().optional(),
}).strict();

const architectSchema = z.object({
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']),
  attempt: z.number().int().min(1),
  startedAt: iso,
  finishedAt: iso.optional(),
  /** 「重新编排」's extra instruction for this attempt. */
  note: z.string().min(1).max(4000).optional(),
  problems: z.array(z.string().max(4000)).max(200).optional(),
}).strict();

const specConfirmationSchema = z.object({
  confirmedByOpenId: openId,
  confirmedAt: iso,
  specSha256: sha,
}).strict();

const flowConfirmationSchema = z.object({
  confirmedByOpenId: openId,
  confirmedAt: iso,
  flowSummary: V3FlowSummarySchema,
  flowSummarySha256: sha,
  /** The summary omits topology, goal texts, inputs and host content; the
   *  dag / spec digests and the draft's flow revision are compared as well. */
  dagSha256: sha,
  specSha256: sha,
  flowRevision: z.number().int().min(0),
}).strict();

const nodeOverrideSchema = z.object({
  larkAppId: z.string().min(1).max(128),
  /** The Architect's choice this override replaced. */
  previousLarkAppId: z.string().min(1).max(128).optional(),
  at: iso,
}).strict();

/** Raw parameter values as entered on the Dashboard (text; converted by the
 *  `/workflow run` rules when the run is prepared and again at commit). */
export const WORKFLOW_TEMPLATE_RUN_MAX_PARAM_CHARS = 16_000;

/**
 * 运行模板 (design 2026-11-03 workflow-dashboard-orchestration §5.3, D5): a
 * draft born from a published Saved Workflow revision instead of a clarify
 * session. Its dag.json / spec.json are that revision's flow under this run id
 * (pinned by digest); 拉群开始 commits it as `source: saved_definition`.
 * Swapping a node's bot makes it no longer "the template as is": it then needs
 * 「确认流程」 and commits as an ad-hoc run (复制后启动, §6).
 */
const templateRunSchema = z.object({
  workflowId: z.string().regex(/^wf_[0-9a-f]{32}$/),
  revisionId: z.string().regex(/^rev_[0-9a-f]{64}$/),
  contentHash: sha,
  humanVersion: z.number().int().min(1),
  displayName: z.string().min(1).max(256),
  /** The template's owner (who saves versions) — not the run's initiator. */
  ownerOpenId: openId,
  params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(WORKFLOW_TEMPLATE_RUN_MAX_PARAM_CHARS)),
  /** The revision declares inputs: its flow carries `${params.…}` markers,
   *  which an ad-hoc run (a swapped bot) could not resolve. */
  hasInputs: z.boolean(),
  dagSha256: sha,
  specSha256: sha,
  preparedAt: iso,
}).strict();

export type WorkflowDraftTemplateRun = z.infer<typeof templateRunSchema>;

/**
 * 基于历史创建 (design 2026-11-03 workflow-dashboard-orchestration §6, D6):
 * a draft copied from a run or a template version. Its spec and flow were
 * prefilled; it stands at 待确认需求 with no clarify session. Both
 * confirmations are still needed (the content may have been edited); 「确认需求」
 * puts the prefilled flow (`copy.dag.json`, pinned by digest) in place
 * instead of running the Architect. A copy commits as an ordinary ad-hoc run.
 */
export const WORKFLOW_COPY_DAG_FILE = 'copy.dag.json';

const copyParamSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().max(4000).optional(),
  sensitive: z.boolean().optional(),
}).strict();

const copySourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run'),
    runId: z.string().min(1).max(256),
    runStatus: z.string().min(1).max(32),
    /** Not finished when copied: the copy is the flow as it stood then. */
    unfinished: z.boolean(),
    runtimeRevisions: z.number().int().min(0),
    orchestratorAppId: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({
    kind: z.literal('template'),
    workflowId: z.string().regex(/^wf_[0-9a-f]{32}$/),
    revisionId: z.string().regex(/^rev_[0-9a-f]{64}$/),
    humanVersion: z.number().int().min(1),
    displayName: z.string().min(1).max(256),
    ownerOpenId: openId,
    orchestratorAppId: z.string().min(1).max(128),
    scope: z.enum(['global', 'chat']),
  }).strict(),
]);

const copySchema = z.object({
  source: copySourceSchema,
  copiedAt: iso,
  /** The prefilled flow, used by 「确认需求」 instead of the Architect — for
   *  the requirement it is pinned to (`specSha256`, moved along by 「只改文字」):
   *  a requirement changed any other way (chat, a hand-edited spec) is
   *  orchestrated anew. Gone once the requirement is sent back (退回改需求)
   *  or re-orchestrated. */
  prefill: z.object({ dagSha256: sha, specSha256: sha }).strict().optional(),
  /** Nodes whose copied bot cannot run them in a planned group (left
   *  bots.json, offline, excluded): kept, or — for a bot no longer configured
   *  here — put on the orchestrating bot for now. The page asks for a new
   *  bot; 「确认流程」 waits until each is swapped (or usable again). */
  needsBot: z.record(z.string().min(1).max(512), z.object({
    larkAppId: z.string().min(1).max(128),
    why: z.string().min(1).max(500),
    /** The bot was not in bots.json: the node is on the orchestrating bot. */
    placeholder: z.literal(true).optional(),
  }).strict()).optional(),
  /** Parameters kept from a template (§6: 参数保留为参数); 存为模板 declares
   *  them again, 拉群开始 refuses a flow that still has their markers. */
  inputs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), copyParamSchema).optional(),
  /** The goal was edited with 「只改文字」 (the flow kept). */
  goalEditedAt: iso.optional(),
}).strict();

export type WorkflowDraftCopy = z.infer<typeof copySchema>;

const chatIdSchema = z.string().regex(/^oc_[A-Za-z0-9_-]{1,128}$/);
const messageIdSchema = z.string().regex(/^om_[A-Za-z0-9_-]{1,128}$/);
const appIdSchema = z.string().min(1).max(128);

/** 群名末尾的标记：`#<runId 最后 8 位随机段>`（§4.5 第 1 步）。 */
export const WORKFLOW_LAUNCH_MARKER_RE = /^#[0-9a-f]{8}$/;
export const WORKFLOW_LAUNCH_MAX_EXTRA_MEMBERS = 20;

const launchProblemSchema = z.object({
  nodeId: z.string().min(1).max(512),
  larkAppId: appIdSchema,
  code: z.string().min(1).max(64),
  why: z.string().max(2000),
  detail: z.string().max(2000).optional(),
}).strict();

/**
 * 拉群记录（§4.5 断点续做）。每一步完成就落一项；「继续」按已有的项决定下一步，
 * 从不重做已落盘的外部副作用：
 *   intent  —— 本记录本身（群名、标记、成员、群主通道），建群前先落盘；
 *   createAttempts —— 每次调建群接口之前记一笔：有它、没有 chat ⟹ 可能已建成，
 *                     先按标记反查认回；
 *   chat    —— 群 id（建群返回即落盘，或按标记认回）；
 *   root    —— 主话题根卡片的消息 id；
 *   migrate —— 澄清会话迁入主话题的结果 + 摘要消息；
 *   check   —— 实时检查（按 flowRevision 作数：流程变了就重查）；
 *   grants  —— 已写的群内协作授权，带两侧各自命名空间里的 open_id，撤销不需要对方在群；
 *   commit  —— run.json 已写（及其摘要）；
 *   start   —— 已启动。
 */
const launchSchema = z.object({
  attempt: z.number().int().min(1),
  /** running: a step sequence of a live operation is in progress (its token
   *  names it); paused: stopped at a step (see `error`) or interrupted —
   *  「继续」 resumes; started: done; abandoned: 「放弃」. */
  state: z.enum(['running', 'paused', 'started', 'abandoned']),
  token: z.string().min(1).max(256).optional(),
  startedAt: iso,
  updatedAt: iso,
  groupName: z.string().min(1).max(64),
  marker: z.string().regex(WORKFLOW_LAUNCH_MARKER_RE),
  /** Raw extra members as entered: email or union_id (on_…). */
  extraMembers: z.array(z.string().min(1).max(256)).max(WORKFLOW_LAUNCH_MAX_EXTRA_MEMBERS),
  /** I7 / §4.5 第 2 步：发起人进群并当群主的唯一通道（不混用）。 */
  ownerChannel: z.enum(['union_id', 'open_id']),
  createAttempts: z.array(iso).max(50).optional(),
  chat: z.object({
    chatId: chatIdSchema,
    at: iso,
    /** Found by its marker after a create whose result was not recorded. */
    recovered: z.literal(true).optional(),
    shareLink: z.string().max(2000).optional(),
    /** Non-fatal: invites that did not go through. */
    warnings: z.array(z.string().max(2000)).max(20).optional(),
    /** The initiator is in the group (`joined`), or Feishu refused to add
     *  them (`rejected` — the launch stops here until they are). Absent
     *  (a group recovered by its marker): not known yet, checked again. */
    initiator: z.enum(['joined', 'rejected']).optional(),
    /** Making the initiator the group owner failed: shown, not fatal. */
    ownerTransferError: z.string().max(2000).optional(),
  }).strict().optional(),
  /** 可能留下的孤儿群：extra chats carrying this marker, or create attempts
   *  whose chat could not be found by it. Handled by a person. */
  orphanSuspects: z.array(z.object({
    chatId: chatIdSchema.optional(),
    name: z.string().max(200).optional(),
    attemptAt: iso.optional(),
    note: z.string().max(500),
  }).strict()).max(50).optional(),
  /** About to post the root card: its uuid and when it was first tried.
   *  Feishu dedups a uuid for about an hour only — later a resend is checked
   *  against the group's messages first, never sent blindly. */
  rootPending: z.object({ uuid: z.string().min(1).max(64), at: iso }).strict().optional(),
  /** The initiator confirmed in the group that no root card is there and
   *  asked to send it again (a fresh uuid): who and when. */
  rootManualResends: z.array(z.object({ at: iso, byOpenId: openId, uuid: z.string().min(1).max(64) }).strict()).max(20).optional(),
  root: z.object({
    messageId: messageIdSchema,
    at: iso,
    /** The root card says 「这次启动已放弃」. */
    abandonNoted: z.literal(true).optional(),
  }).strict().optional(),
  /** binding: the move is under way (written before it) — the session may
   *  already be the main topic's, so nothing closes or suspends it; 「继续」
   *  reconciles. bound / unavailable: the outcome. */
  migrate: z.object({
    status: z.enum(['binding', 'bound', 'unavailable']),
    at: iso,
    sessionId: z.string().min(1).max(256).optional(),
    error: z.string().max(2000).optional(),
    /** About to post the summary (same uuid rule as the root card);
     *  `manual`: a resend the initiator asked for. */
    summaryPending: z.object({ uuid: z.string().min(1).max(64), at: iso, manual: z.literal(true).optional() }).strict().optional(),
    summaryMessageId: messageIdSchema.optional(),
    summaryError: z.string().max(2000).optional(),
    /** The summary's post outlived the uuid window unrecorded: it may or may
     *  not be in the topic (not resent by itself). */
    summaryUnverified: z.literal(true).optional(),
    /** Sent again after the initiator confirmed it was not there. */
    summaryManualResend: z.object({ at: iso, byOpenId: openId }).strict().optional(),
  }).strict().optional(),
  check: z.object({
    at: iso,
    flowRevision: z.number().int().min(0),
    ok: z.boolean(),
    problems: z.array(launchProblemSchema).max(200),
  }).strict().optional(),
  /** Per executing bot: the talk-only grants between it and the main bot in
   *  this chat. `mainSide`: this bot's open_id in the main bot's namespace
   *  (main receives); `peerSide`: the main bot's open_id in this bot's
   *  namespace (it receives). Each is used only with the app that issued it.
   *  Before a side is written its open_id — resolved by that receiver in its
   *  own app — is recorded as `*Pending`; after, it moves to the side. A grant
   *  whose answer was lost is thus revocable by open_id, also once the
   *  subject has left the group. */
  grants: z.record(appIdSchema, z.object({
    at: iso,
    mainSide: openId.optional(),
    peerSide: openId.optional(),
    mainPending: openId.optional(),
    peerPending: openId.optional(),
  }).strict()).optional(),
  commit: z.object({
    at: iso,
    chatId: chatIdSchema,
    rootMessageId: messageIdSchema,
    runJsonSha256: sha,
    /** Absent only for a replayed template commit whose flow could not be
     *  summarised (the committed run.json stands on its own). */
    flowSummarySha256: sha.optional(),
    dagSha256: sha,
    specSha256: sha,
    flowRevision: z.number().int().min(0),
  }).strict().optional(),
  start: z.object({ at: iso }).strict().optional(),
  error: z.object({
    step: z.enum(['members', 'group', 'join', 'root', 'summary', 'migrate', 'check', 'grant', 'commit', 'start', 'interrupted']),
    code: z.string().min(1).max(64),
    message: z.string().max(4000),
    at: iso,
    retryable: z.boolean(),
  }).strict().optional(),
  abandonedAt: iso.optional(),
}).strict();

/** Raw failure text kept on a draft (credential shapes masked, clipped). */
export const WORKFLOW_DRAFT_FAILURE_DETAIL_MAX = 2000;
/** Terminal output tail kept on a draft (plain text, masked, clipped). */
export const WORKFLOW_DRAFT_FAILURE_TERMINAL_MAX = 4000;

/**
 * A model call of the orchestrating bot that failed (clarify turn, clarify
 * session start, Architect): the closed-set category and error code (the
 * page's heading), where, which bot with its CLI and its bots.json `model`
 * (only when configured), and — to show the person what actually happened —
 * the raw error text and the terminal output tail (credential shapes masked,
 * clipped), plus the clarify session id the page opens a terminal for
 * (draft-failure.ts).
 */
const failureSummaryShape = {
  category: z.enum(WORKFLOW_DRAFT_FAILURE_CATEGORIES),
  code: z.string().regex(WORKFLOW_DRAFT_FAILURE_CODE_RE).optional(),
  step: z.enum(WORKFLOW_DRAFT_FAILURE_STEPS),
  larkAppId: appIdSchema,
  cliId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
  at: iso,
};
const failureSummarySchema = z.object(failureSummaryShape).strict();
const failureSchema = z.object({
  ...failureSummaryShape,
  detail: z.string().min(1).max(WORKFLOW_DRAFT_FAILURE_DETAIL_MAX).optional(),
  terminalTail: z.string().min(1).max(WORKFLOW_DRAFT_FAILURE_TERMINAL_MAX).optional(),
  sessionId: z.string().min(1).max(256).optional(),
}).strict();

export type WorkflowDraftFailure = z.infer<typeof failureSchema>;
/** What the orchestrator picker learns of a bot's failure: no raw text. */
export type WorkflowDraftFailureSummary = z.infer<typeof failureSummarySchema>;

/**
 * 换编排 Bot (handoff) under way: the current orchestrator (still the owner)
 * has recorded the target and is closing its clarify sessions (`closing`), or
 * has closed them (`ready`). Ownership moves in ONE write by the target's
 * daemon (orchestratorAppId := target, handoff removed), under the draft lock
 * and only for this token — never two owners, never none.
 */
const handoffSchema = z.object({
  toAppId: appIdSchema,
  token: z.string().regex(/^[0-9a-f-]{36}$/),
  state: z.enum(['closing', 'ready']),
  at: iso,
}).strict();

/**
 * One 换编排 Bot in the draft's history: who, from which bot to which, when,
 * and the first confirmation's confirmer before and after. Every open_id is
 * recorded as ITS app saw it (`from*` under fromAppId, `to*` under toAppId) —
 * never one app's open_id reused under the other.
 */
const handoffHistorySchema = z.object({
  fromAppId: appIdSchema,
  toAppId: appIdSchema,
  token: z.string().regex(/^[0-9a-f-]{36}$/),
  at: iso,
  by: z.object({
    source: initiatorSchema.shape.source,
    fromOpenId: openId,
    toOpenId: openId,
    /** A platform login's union_id (the same on both apps). */
    unionId: z.string().min(1).max(128).optional(),
  }).strict().optional(),
  /** The first confirmation (确认需求) restamped for the new app. */
  specConfirmation: z.object({
    fromOpenId: openId,
    toOpenId: openId,
  }).strict().optional(),
}).strict();

export type WorkflowDraftHandoffRecord = z.infer<typeof handoffHistorySchema>;

export const WorkflowDraftRecordSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_DRAFT_SCHEMA_VERSION),
  runId: z.string().min(1).max(256),
  orchestratorAppId: z.string().min(1).max(128),
  initiator: initiatorSchema,
  goal: z.string().min(1).max(8000),
  createdAt: iso,
  updatedAt: iso,
  version: z.number().int().min(1),
  /** The project its clarify session runs in: the orchestrator's default
   *  dir, or one of its repo-picker candidates chosen at creation. Drafts
   *  from before projects have none until a session reopens in one. */
  projectDir: z.string().min(1).max(4096).optional(),
  clarify: clarifySchema,
  architect: architectSchema.optional(),
  /** Bumped by every write that changes the DAG or the spec; a second
   *  confirmation holds for the revision it was given at only. */
  flowRevision: z.number().int().min(0).optional(),
  /** Per goal node: the executing bot a person chose on the page. */
  nodeBots: z.record(z.string().min(1).max(512), nodeOverrideSchema).optional(),
  specConfirmation: specConfirmationSchema.optional(),
  flowConfirmation: flowConfirmationSchema.optional(),
  abandonedAt: iso.optional(),
  deletedAt: iso.optional(),
  /** 拉群开始 (§4.5, D4). */
  launch: launchSchema.optional(),
  /** 运行模板 (§5.3, D5): born from a Saved Workflow revision. */
  template: templateRunSchema.optional(),
  /** 基于历史创建 (§6, D6): copied from a run or a template version. */
  copy: copySchema.optional(),
  orphanSessions: z.array(z.object({
    sessionId: z.string().min(1).max(256),
    headlessId: z.string().min(1).max(256).optional(),
  }).strict()).max(WORKFLOW_DRAFT_MAX_ORPHANS).optional(),
  /** The latest model failure of the current orchestrator that nothing has
   *  answered since (cleared by a reply, a new attempt, a handoff). */
  failure: failureSchema.optional(),
  /** Per bot that orchestrated this draft: its last model call that went
   *  through and its last failure (survives handoffs; the orchestrator
   *  picker's "最近一次调用模型失败" reads it). */
  modelCalls: z.record(appIdSchema, z.object({
    okAt: iso.optional(),
    failure: failureSummarySchema.optional(),
  }).strict()).optional(),
  handoff: handoffSchema.optional(),
  handoffs: z.array(handoffHistorySchema).max(WORKFLOW_DRAFT_MAX_HANDOFFS).optional(),
}).strict();

export type WorkflowDraftRecord = z.infer<typeof WorkflowDraftRecordSchema>;
export type WorkflowDraftInitiator = z.infer<typeof initiatorSchema>;
export type WorkflowDraftTurn = z.infer<typeof turnSchema>;
export type WorkflowDraftQuestion = z.infer<typeof questionSchema>;
export type WorkflowDraftArchitect = z.infer<typeof architectSchema>;
export type WorkflowDraftFlowConfirmation = z.infer<typeof flowConfirmationSchema>;
export type WorkflowDraftLaunch = z.infer<typeof launchSchema>;
export type WorkflowDraftLaunchProblem = z.infer<typeof launchProblemSchema>;
export type WorkflowDraftHandoff = z.infer<typeof handoffSchema>;

export class WorkflowDraftBusyError extends Error {
  constructor(runId: string) {
    super(`草稿 ${runId} 正在被另一个操作修改，请稍后重试`);
    this.name = 'WorkflowDraftBusyError';
  }
}

const DRAFT_LOCK_WAIT_MS = 2_000;

function draftPath(runDir: string): string {
  return join(runDir, WORKFLOW_DRAFT_FILE);
}

/** draft.json, or undefined when missing / unreadable / not this schema. */
export function readWorkflowDraft(runDir: string): WorkflowDraftRecord | undefined {
  let raw: string;
  try {
    if (!lstatSync(draftPath(runDir)).isFile()) return undefined;
    raw = readFileSync(draftPath(runDir), 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const parsed = WorkflowDraftRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Validate then write atomically (0600). Throws on a malformed record. */
export function writeWorkflowDraft(runDir: string, record: WorkflowDraftRecord): void {
  const checked = WorkflowDraftRecordSchema.parse(record);
  atomicWriteFileSync(draftPath(runDir), `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600 });
}

/** The run-scoped draft lock (sync: never hold it across an await). */
export function withWorkflowDraftLock<T>(runDir: string, runId: string, fn: () => T): T {
  try {
    return withFileLockSync(draftPath(runDir), fn, { maxWaitMs: DRAFT_LOCK_WAIT_MS });
  } catch (err) {
    if (err instanceof FileLockTimeoutError) throw new WorkflowDraftBusyError(runId);
    throw err;
  }
}

/** `sha256:<hex>` of a file's bytes, or undefined when it cannot be read. */
export function fileSha256(path: string | undefined): `sha256:${string}` | undefined {
  if (!path) return undefined;
  try {
    return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  } catch {
    return undefined;
  }
}

/** The run dir of `runId` under `baseDir`, or undefined for anything that
 *  is not a plain run id inside it. */
export function workflowDraftRunDir(baseDir: string, runId: string): string | undefined {
  if (!isValidRunId(runId)) return undefined;
  const root = resolve(baseDir);
  const dir = resolve(root, runId);
  if (dir === root || !dir.startsWith(root + sep)) return undefined;
  return dir;
}

/**
 * A Dashboard draft: draft.json + grill.state.json, not started (no
 * journal), and no run.json yet — or a run.json its own 拉群开始 wrote and has
 * not started (§4.5 第 7、8 步之间：「继续」直接启动). Once started it is a
 * run, shown by /api/v3/runs.
 */
export function isWorkflowDraftDir(runDir: string): boolean {
  if (!existsSync(draftPath(runDir)) || !existsSync(join(runDir, 'grill.state.json'))) return false;
  if (existsSync(join(runDir, 'journal.ndjson'))) return false;
  if (!existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) return true;
  // Written by this draft's own launch (possibly before its commit could be
  // recorded): still the draft, 「继续」 finishes it.
  return readWorkflowDraft(runDir)?.launch !== undefined;
}

/** A draft dir whose 拉群开始 has started the run (routing only: the launch
 *  calls stay answerable, e.g. a second tab's 「继续」). */
export function isLaunchedWorkflowDraftDir(runDir: string): boolean {
  if (!existsSync(draftPath(runDir)) || !existsSync(join(runDir, 'grill.state.json'))) return false;
  return readWorkflowDraft(runDir)?.launch !== undefined;
}

/**
 * What a draft is doing, for the list and the page (§4.6):
 *   clarifying 澄清中 · spec_ready 待确认需求 · awaiting_architect 待编排 ·
 *   architect_running 编排中 · dag_ready 待确认流程 · flow_confirmed 已确认流程 ·
 *   launching 拉群中 · started 已启动 · abandoned 已放弃.
 *
 * A launch whose second confirmation went void (a bot was swapped at step 5)
 * shows 待确认流程 again; confirming resumes it as 拉群中.
 *
 * `flowConfirmationValid` is the caller's verdict on the recorded second
 * confirmation (digests still match); without it a recorded one counts.
 */
export type WorkflowDraftPhase =
  | 'clarifying'
  | 'spec_ready'
  | 'awaiting_architect'
  | 'architect_running'
  | 'dag_ready'
  | 'flow_confirmed'
  | 'abandoned'
  | 'committed'
  /** 拉群中 (D4): a launch is under way (running or stopped at a step). */
  | 'launching'
  /** 拉群开始 finished: the run is started. */
  | 'started';

/**
 * A template run needs 「确认流程」 only once a node's bot was swapped: it is
 * then no longer the template as is (§5.3, 复制后启动). A version saved from a
 * draft runs directly (I13, decided 11-05): its saved confirmation goes into
 * run.json instead.
 */
export function workflowTemplateRunNeedsConfirmation(draft: Pick<WorkflowDraftRecord, 'template' | 'nodeBots'>): boolean {
  if (!draft.template) return true;
  return Object.keys(draft.nodeBots ?? {}).length > 0;
}

/** A template run's flow files are still the prepared revision's. */
export function templateRunFlowIntact(grill: GrillState, draft: WorkflowDraftRecord): boolean {
  const template = draft.template;
  return !!template
    && fileSha256(grill.dagPath) === template.dagSha256
    && fileSha256(grill.specJsonPath) === template.specSha256;
}

export function workflowDraftPhase(
  grill: Pick<GrillState, 'status'>,
  draft: Pick<WorkflowDraftRecord, 'abandonedAt' | 'architect' | 'flowConfirmation' | 'launch'> & Partial<Pick<WorkflowDraftRecord, 'template' | 'nodeBots'>>,
  flowConfirmationValid?: boolean,
): WorkflowDraftPhase {
  if (draft.abandonedAt) return 'abandoned';
  if (draft.launch?.start) return 'started';
  if (draft.launch && (draft.launch.commit || grill.status === 'dag_approved')) return 'launching';
  if (draft.architect?.state === 'running' || grill.status === 'architect_running') return 'architect_running';
  const byStatus: Record<GrillStatus, WorkflowDraftPhase> = {
    grilling: 'clarifying',
    spec_ready: 'spec_ready',
    spec_approved: 'awaiting_architect',
    architect_running: 'architect_running',
    dag_ready: 'dag_ready',
    dag_approved: 'committed',
  };
  const phase = byStatus[grill.status];
  // A template run that needs no confirmation (I13) stands where a confirmed
  // flow does; `flowConfirmationValid` then says its files are intact.
  const confirmed = draft.template && !workflowTemplateRunNeedsConfirmation(draft) ? true : !!draft.flowConfirmation;
  // §5.2 refused the flow at the commit step (nothing written): the launch is
  // paused for editing, not underway. Show 待确认流程 so the bot swap / node
  // edits are reachable; for a no-confirmation template run a swap is the
  // recovery (it then confirms as an ad-hoc flow). Once the flow is
  // re-confirmed (flowConfirmation back), stop falling back: the launch is
  // underway again and 「继续」 must be available.
  const placementRefused = draft.launch?.error?.code === 'placement_refused'
    && !draft.launch.commit && !draft.launch.start && grill.status === 'dag_ready'
    && !draft.flowConfirmation;
  if (phase === 'dag_ready' && confirmed && flowConfirmationValid !== false && !placementRefused) {
    return draft.launch ? 'launching' : 'flow_confirmed';
  }
  return phase;
}

export interface WorkflowDraftSummary {
  runId: string;
  title: string;
  goal: string;
  orchestratorAppId: string;
  initiator: WorkflowDraftInitiator;
  phase: WorkflowDraftPhase;
  grillStatus: GrillStatus;
  createdAt: string;
  updatedAt: string;
  /** §4.6: 30 days without activity — greyed out, deletable. */
  stale: boolean;
  /** 运行模板 (D5): the template this run comes from. */
  template?: { workflowId: string; humanVersion: number; displayName: string };
  /** 基于历史创建 (D6): where it was copied from. */
  copiedFrom?: { kind: 'run'; runId: string; unfinished: boolean } | { kind: 'template'; workflowId: string; humanVersion: number; displayName: string };
}

function specTitle(grill: GrillState): string | undefined {
  try {
    const spec = JSON.parse(readFileSync(grill.specJsonPath, 'utf-8')) as { title?: unknown };
    return typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim().slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

/** The second confirmation still matches the dag and spec bytes on disk (the
 *  flow summary itself needs bots.json, so only the daemon compares it). */
export function flowConfirmationMatchesFiles(grill: GrillState, draft: WorkflowDraftRecord): boolean {
  if (draft.template && !workflowTemplateRunNeedsConfirmation(draft)) return templateRunFlowIntact(grill, draft);
  const confirmation = draft.flowConfirmation;
  if (!confirmation) return false;
  return confirmation.flowRevision === (draft.flowRevision ?? 0)
    && fileSha256(grill.dagPath) === confirmation.dagSha256
    && fileSha256(grill.specJsonPath) === confirmation.specSha256;
}

export function summarizeWorkflowDraft(runDir: string, now: Date = new Date()): WorkflowDraftSummary | undefined {
  if (!isWorkflowDraftDir(runDir)) return undefined;
  const draft = readWorkflowDraft(runDir);
  const grill = readGrillState(runDir);
  if (!draft || !grill || draft.deletedAt || grill.runId !== draft.runId || grill.chatBinding) return undefined;
  const updatedAt = draft.updatedAt > grill.updatedAt ? draft.updatedAt : grill.updatedAt;
  return {
    runId: draft.runId,
    title: specTitle(grill) ?? draft.goal.replace(/\s+/g, ' ').trim().slice(0, 200),
    goal: draft.goal,
    orchestratorAppId: draft.orchestratorAppId,
    initiator: draft.initiator,
    phase: workflowDraftPhase(grill, draft, flowConfirmationMatchesFiles(grill, draft)),
    grillStatus: grill.status,
    createdAt: draft.createdAt,
    updatedAt,
    stale: now.getTime() - Date.parse(updatedAt) >= WORKFLOW_DRAFT_STALE_MS,
    ...(draft.template ? { template: { workflowId: draft.template.workflowId, humanVersion: draft.template.humanVersion, displayName: draft.template.displayName } } : {}),
    ...(draft.copy ? { copiedFrom: copiedFromOf(draft.copy) } : {}),
  };
}

export function copiedFromOf(copy: WorkflowDraftCopy): NonNullable<WorkflowDraftSummary['copiedFrom']> {
  return copy.source.kind === 'run'
    ? { kind: 'run', runId: copy.source.runId, unfinished: copy.source.unfinished }
    : { kind: 'template', workflowId: copy.source.workflowId, humanVersion: copy.source.humanVersion, displayName: copy.source.displayName };
}

/** Run dirs under `baseDir` that are drafts (any bot, any state); with
 *  `launched`, also those whose launch has started the run. */
export function listWorkflowDraftDirs(baseDir: string, opts: { launched?: boolean } = {}): Array<{ runId: string; runDir: string }> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidRunId(entry.name)
      && (isWorkflowDraftDir(join(baseDir, entry.name)) || (!!opts.launched && isLaunchedWorkflowDraftDir(join(baseDir, entry.name)))))
    .map((entry) => ({ runId: entry.name, runDir: join(baseDir, entry.name) }));
}

/** Every draft under `baseDir` (newest activity first). */
export function listWorkflowDrafts(baseDir: string, now: Date = new Date()): WorkflowDraftSummary[] {
  if (!existsSync(baseDir)) return [];
  const out: WorkflowDraftSummary[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    const summary = summarizeWorkflowDraft(join(baseDir, entry.name), now);
    if (summary && summary.runId === entry.name) out.push(summary);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** The orchestrating bot of a draft, for routing (the Dashboard proxy). */
export function workflowDraftOwner(baseDir: string, runId: string): string | undefined {
  const runDir = workflowDraftRunDir(baseDir, runId);
  if (!runDir || (!isWorkflowDraftDir(runDir) && !isLaunchedWorkflowDraftDir(runDir))) return undefined;
  const draft = readWorkflowDraft(runDir);
  // A marked-deleted draft still routes, so a repeated delete can finish it;
  // a launched one too, so its launch calls answer deterministically.
  return draft && draft.runId === runId ? draft.orchestratorAppId : undefined;
}

/**
 * Per bot: its latest model failure across the given drafts, when no later
 * model call of that bot went through (a reply landed, an Architect run
 * succeeded). Read from the records only — nothing calls a model to find out.
 */
export function latestModelFailures(records: Iterable<Pick<WorkflowDraftRecord, 'modelCalls'>>): Map<string, WorkflowDraftFailureSummary> {
  const okAt = new Map<string, string>();
  const failed = new Map<string, WorkflowDraftFailureSummary>();
  for (const record of records) {
    for (const [appId, calls] of Object.entries(record.modelCalls ?? {})) {
      if (calls.okAt && calls.okAt > (okAt.get(appId) ?? '')) okAt.set(appId, calls.okAt);
      if (calls.failure && calls.failure.at > (failed.get(appId)?.at ?? '')) failed.set(appId, calls.failure);
    }
  }
  for (const [appId, failure] of failed) {
    const ok = okAt.get(appId);
    if (ok && ok >= failure.at) failed.delete(appId);
  }
  return failed;
}

/** {@link latestModelFailures} over every draft dir under `baseDir` (launched
 *  ones too: their records still hold the outcomes). */
export function recentModelFailures(baseDir: string): Map<string, WorkflowDraftFailureSummary> {
  const records: WorkflowDraftRecord[] = [];
  for (const { runDir } of listWorkflowDraftDirs(baseDir, { launched: true })) {
    const record = readWorkflowDraft(runDir);
    if (record?.modelCalls) records.push(record);
  }
  return latestModelFailures(records);
}
