/**
 * Dashboard workflow drafts — the orchestrating bot's daemon side (design
 * 2026-11-03 workflow-dashboard-orchestration §4.2–4.4, §4.6, §9, D2).
 *
 * Every draft state change happens here, for the draft's recorded initiator
 * only (I6), never by the model (E2): the clarify session only talks and
 * writes spec text. The grill state machine and its host operations
 * (host.ts) are reused unchanged; the draft-only facts live in draft.json
 * (draft-store.ts).
 *
 * Concurrency:
 *   - every write is one critical section under draft.json.lock that
 *     re-reads, checks the preconditions (state, optional `baseVersion` CAS)
 *     and writes; two tabs racing the same confirmation get one success and
 *     one deterministic 409;
 *   - the second confirmation additionally carries the flow-summary digest
 *     the page showed: it confirms exactly that flow or nothing;
 *   - the Architect runs in the background with the existing host lock held
 *     across the worker (hostArchitect, unchanged) and its own
 *     AbortController; nothing here waits on that lock while it runs.
 *
 * Collaborators are injected (clarify session, Architect worker, bots, clock,
 * timers) so the daemon wiring stays thin and tests use fakes.
 */

import { readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { BotConfig } from '../../bot-registry.js';
import { isStewardBot } from '../../core/decision-board/model.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { birthRun, readGrillState, transition, writeGrillState, type GrillState } from './grill-state.js';
import {
  HostGuardError,
  adHocFlowSummary,
  authorizeAdHocRun,
  hostApproveDag,
  hostApproveSpec,
  hostArchitect,
  hostReviseDag,
  hostReviseSpec,
  hostSpecFinalize,
  projectAdHocBotPlan,
  resolveArchitectBotSnapshot,
  withHostMutationLockSync,
  type ArchitectDeps,
} from './host.js';
import { loadDag as realLoadDag } from './dag-loader.js';
import { DagValidationError, validateDag, type V3Dag, type V3Node } from './dag.js';
import { validateSpec } from './spec.js';
import { freezeDagBotSnapshots } from './bot-resolve.js';
import { V3_RUN_ENVELOPE_FILE, artifactRef, readRunEnvelope, type V3RunInitiator } from './run-envelope.js';
import { ParamCoerceFailure, type RawParamInput } from '../shared/params.js';
import {
  SavedWorkflowConflictError,
  SavedWorkflowNotFoundError,
  SavedWorkflowPermissionError,
  listSavedWorkflowCatalog,
  readSavedWorkflowRevision,
  readSavedWorkflowMetadata,
  readSavedWorkflowMetadataSync,
} from './library-store.js';
import { SavedWorkflowSchemaError, type SavedWorkflowGateComparisonAgainst, type SavedWorkflowParamDef } from './library-schema.js';
import { collectSavedWorkflowTemplateBindings } from './template-bindings.js';
import {
  SavedWorkflowServiceError,
  commitDashboardSave,
  dashboardSavedWorkflowId,
  loadDashboardAppendTarget,
  planDashboardRunSave,
  prepareDashboardSavedWorkflowRun,
  withDashboardParamEdits,
  type DashboardSavePlan,
} from './library-service.js';
import {
  SavedWorkflowUnsafeLiteralError,
  buildSavedWorkflowRevisionFromFlow,
  SavedWorkflowRunReplayError,
  commitSavedWorkflowRunInPlace,
  replaySavedWorkflowRunCommit,
  savedWorkflowRunFlow,
} from './library-materialize.js';
import {
  SavedWorkflowParamEditError,
  parseSavedWorkflowParamEdits,
} from './library-params.js';
import type { RunChatBinding } from './grill-state.js';
import { buildV3FlowSummary, v3FlowSummarySha256, type V3FlowSummary } from './flow-summary.js';
import {
  buildV3BotRoster,
  planV3SketchAssignees,
  projectV3Gate2BotPlan,
  v3BotStaticExclusion,
  v3RosterSelectorProblems,
  type V3BotRoster,
  type V3Gate2BotPlan,
} from './bot-assignment.js';
import {
  checkV3BotExecutorEligibility,
  describeV3BotEligibilityCode,
  formatV3PlacementRefusal,
  judgeV3BotEligibility,
  v3BotExecutorTargets,
  v3TargetPlacementProblems,
  type V3BotEligibilityProbe,
  type V3BotEligibilityProblem,
  type V3NodeExecutorTarget,
} from './node-executor-mode.js';
import type { V3MainTopicAvailability } from './placement.js';
import {
  WORKFLOW_DRAFT_MAX_ORPHANS,
  WORKFLOW_LAUNCH_MAX_EXTRA_MEMBERS,
  WORKFLOW_DRAFT_MAX_TURNS,
  WORKFLOW_DRAFT_MAX_TURN_CHARS,
  WORKFLOW_DRAFT_SCHEMA_VERSION,
  WORKFLOW_DRAFT_STALE_MS,
  WorkflowDraftBusyError,
  fileSha256,
  isLaunchedWorkflowDraftDir,
  isWorkflowDraftDir,
  listWorkflowDraftDirs,
  readWorkflowDraft,
  withWorkflowDraftLock,
  workflowDraftPhase,
  workflowDraftRunDir,
  writeWorkflowDraft,
  type WorkflowDraftInitiator,
  type WorkflowDraftLaunch,
  type WorkflowDraftLaunchProblem,
  type WorkflowDraftPhase,
  type WorkflowDraftRecord,
  type WorkflowDraftReservationHolder,
  type WorkflowDraftTemplateRun,
  type WorkflowDraftTurn,
  WORKFLOW_TEMPLATE_RUN_MAX_PARAM_CHARS,
  WORKFLOW_COPY_DAG_FILE,
  workflowTemplateRunNeedsConfirmation,
  type WorkflowDraftCopy,
} from './draft-store.js';
import { readLinuxBootIdentity, readProcessStartIdentity } from '../../utils/process-identity.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import { pidIsSignalable } from '../../utils/process-alive.js';
import {
  WorkflowCopySourceError,
  parseWorkflowCopySource,
  readRunCopyMaterial,
  readTemplateCopyMaterial,
  unresolvedFlowMarkers,
  type WorkflowCopyMaterial,
} from './draft-copy.js';
import {
  buildDraftClarifyKickoff,
  buildDraftCopyClarifyKickoff,
  buildDraftClarifyResume,
  buildDraftSpecProblemsTurn,
  parseDraftClarifyOutput,
} from './draft-clarify.js';
import {
  buildTemplateRunSessionPrompt,
  groupNameHasMarker,
  launchGroupName,
  launchMarker,
  nextLaunchStep,
  parseLaunchExtraMembers,
  type DraftLaunchDeps,
  type LaunchRootCardView,
  type LaunchStep,
  type LaunchSummaryView,
} from './draft-launch.js';

/** The existing Architect budget (architect.ts default), unchanged (§4.4). */
export const DRAFT_ARCHITECT_TIMEOUT_MS = 10 * 60_000;
/**
 * Upper bound on one clarify-session call (create a session / start a turn).
 * Neither waits for the model: creating registers a session, and an async
 * turn returns once the turn is admitted. The slow case is a cold CLI start
 * behind the admission (tens of seconds for the slowest CLIs); 2 minutes is
 * several times that. A call past it is treated as lost: its reservation is
 * released so the draft does not stay locked behind it.
 */
export const DRAFT_CLARIFY_CALL_TIMEOUT_MS = 2 * 60_000;
/** §4.2: a draft whose clarify session got no message for this long has its
 *  CLI process closed; the session record stays for a later resume. */
export const DRAFT_CLARIFY_IDLE_MS = 30 * 60_000;
const RESERVATION_PREFIX = 'reserve:';
/** Feishu deduplicates a message uuid for about an hour; a resend later
 *  than this after the first try is not trusted to be deduplicated. */
export const LAUNCH_UUID_DEDUP_SAFE_MS = 55 * 60_000;
const MAX_GOAL_CHARS = 4_000;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_NOTE_CHARS = 4_000;

// ─── Errors ───────────────────────────────────────────────────────────────

export type WorkflowDraftErrorCode =
  | 'unknown_draft'
  | 'bot_mismatch'
  | 'not_initiator'
  | 'draft_abandoned'
  | 'version_conflict'
  | 'state_conflict'
  | 'busy'
  | 'architect_running'
  | 'clarify_turn_running'
  | 'session_disconnected'
  | 'clarify_unavailable'
  | 'no_spec'
  | 'flow_changed'
  | 'already_confirmed'
  | 'unknown_node'
  | 'bot_not_on_roster'
  | 'dag_invalid'
  | 'draft_not_stale'
  | 'orchestrator_ineligible'
  /** D4: a launch of this draft is running in this daemon right now. */
  | 'launch_running'
  /** D4: 「拉群开始」 again — the launch exists, 「继续」 resumes it. */
  | 'launch_exists'
  /** D4: 「继续」 / 「放弃」 of a launch that was never started. */
  | 'no_launch'
  /** D4: this daemon was built without the launch collaborators. */
  | 'launch_unavailable'
  /** D4: the platform login carries no union_id to put the initiator in the group with. */
  | 'initiator_channel_unavailable'
  /** D4: run.json is written; the draft can only be started now. */
  | 'run_committed'
  /** D4: deleting a launched draft first marks its root card abandoned. */
  | 'root_update_failed'
  /** D4: a message the initiator asked to resend did not go out. */
  | 'post_failed'
  /** D5: no such finished run on this bot. */
  | 'unknown_run'
  /** D5: a template run is not clarified or re-orchestrated (复制 is D6). */
  | 'template_run'
  /** D5: no such template visible to this bot. */
  | 'template_not_found'
  /** D5: a chat-scoped template runs / is appended to only in its chat (I9). */
  | 'template_scope'
  /** D5: the template has no published revision. */
  | 'template_not_published'
  /** D5: parameters missing / of the wrong type, or a 「设为参数」 refused. */
  | 'bad_params'
  /** D5: the result breaks a template rule. */
  | 'template_invalid'
  /** D5: only the owner saves or appends (I9). */
  | 'not_owner'
  /** D5: the template changed since the dialog compared with it. */
  | 'save_conflict'
  /** D5: literals that need an explicit acknowledgement. */
  | 'unsafe_literals'
  /** D6: the run / template to copy could not be read. */
  | 'source_unreadable'
  /** D6: the flow still has `${params.…}` / `${context.…}` markers an ad-hoc run cannot resolve. */
  | 'unresolved_params'
  /** D6: only a draft copied from a run / template does this. */
  | 'not_a_copy'
  | 'bad_request';

const STATUS: Record<WorkflowDraftErrorCode, number> = {
  unknown_draft: 404,
  bot_mismatch: 409,
  not_initiator: 403,
  draft_abandoned: 409,
  version_conflict: 409,
  state_conflict: 409,
  busy: 409,
  architect_running: 409,
  clarify_turn_running: 409,
  session_disconnected: 409,
  clarify_unavailable: 503,
  no_spec: 409,
  flow_changed: 409,
  already_confirmed: 409,
  unknown_node: 404,
  bot_not_on_roster: 422,
  dag_invalid: 422,
  draft_not_stale: 409,
  orchestrator_ineligible: 422,
  launch_running: 409,
  launch_exists: 409,
  no_launch: 409,
  launch_unavailable: 503,
  initiator_channel_unavailable: 422,
  run_committed: 409,
  root_update_failed: 503,
  post_failed: 502,
  unknown_run: 404,
  template_run: 409,
  template_not_found: 404,
  template_scope: 409,
  template_not_published: 409,
  bad_params: 422,
  template_invalid: 422,
  not_owner: 403,
  save_conflict: 409,
  unsafe_literals: 409,
  source_unreadable: 422,
  unresolved_params: 409,
  not_a_copy: 409,
  bad_request: 400,
};

export class WorkflowDraftError extends Error {
  readonly status: number;
  constructor(
    readonly code: WorkflowDraftErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WorkflowDraftError';
    this.status = STATUS[code];
  }

  get retryable(): boolean {
    return this.code === 'busy' || this.code === 'clarify_unavailable' || this.code === 'launch_running' || this.code === 'root_update_failed' || this.code === 'post_failed';
  }
}

const err = (code: WorkflowDraftErrorCode, message: string, details?: Record<string, unknown>) =>
  new WorkflowDraftError(code, message, details);

// ─── Collaborators ────────────────────────────────────────────────────────

export type DraftClarifyResult =
  | { state: 'running' }
  /** `finishedAt`: when the turn ended, if known (the idle clock). */
  | { state: 'completed'; content: string; finishedAt?: string }
  | { state: 'failed'; error?: string }
  /** The session or turn no longer exists. */
  | { state: 'not_found' };

/** The orchestrating bot's headless sessions (session-manager / trigger). */
export interface DraftClarifier {
  create(input: { larkAppId: string; title: string }): Promise<
    { ok: true; headlessId: string; sessionId: string } | { ok: false; error: string }
  >;
  /** Start one turn. `disconnected`: the session cannot take turns anymore. */
  /** Start one turn. `busy`: the session is restarting / being retired
   *  right now; try again shortly. */
  send(input: { larkAppId: string; sessionId: string; headlessId: string; prompt: string; requestId: string }): Promise<
    { ok: true; triggerId: string } | { ok: false; error: string; disconnected: boolean; busy?: true }
  >;
  result(sessionId: string, triggerId: string): DraftClarifyResult;
  /** Close the CLI process, keep the session record (idle, §4.2). False:
   *  this session's process cannot be released now. Called outside the lock. */
  suspend(sessionId: string): boolean | Promise<boolean>;
  /** Close the session and delete its record (abandon / delete). */
  close(input: { sessionId: string; headlessId?: string }): Promise<void>;
}

export interface WorkflowDraftServiceDeps {
  /** This daemon's bot: the only orchestrator it serves. */
  appId: string;
  baseDir: string;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => () => void;
  loadBots: () => BotConfig[];
  nameOf: () => (larkAppId: string) => string;
  roleOf?: () => (larkAppId: string) => string | undefined;
  /** Live daemon registry. The other roster facts of a planned group are
   *  either static (bots.json) or settled when the group is built (§4.4). */
  isDaemonOnline: (larkAppId: string) => boolean;
  clarifier: DraftClarifier;
  runArchitect: ArchitectDeps['runArchitect'];
  loadDag?: (path: string) => unknown;
  architectTimeoutMs?: number;
  /** Test seam for deterministic run ids. */
  randomSuffix?: () => string;
  /** 拉群开始 (§4.5, D4). Absent: launch calls answer launch_unavailable. */
  launch?: DraftLaunchDeps;
  /** The Saved Workflow library's dataDir (D5); default: baseDir's parent,
   *  where `/workflow save` keeps it (~/.botmux). */
  libraryDataDir?: string;
  log?: (message: string) => void;
  /** Whether a reservation's holder process is still running (default: pid
   *  + process start identity, as the file locks check their holders). */
  isHolderAlive?: (holder: WorkflowDraftReservationHolder) => boolean;
}

// ─── Views ────────────────────────────────────────────────────────────────

export interface WorkflowDraftFlowView {
  dag: V3Dag;
  dagSha256: string;
  plan: V3Gate2BotPlan;
  flowSummary: V3FlowSummary;
  flowSummarySha256: string;
  roster: V3BotRoster;
  /** Problems the planned group already shows (static, offline, directory
   *  outputs); membership and grants are checked when the group is built. */
  planProblems: Array<V3BotEligibilityProblem & { why: string }>;
}

export interface WorkflowDraftView {
  runId: string;
  version: number;
  /** Bumped by every DAG / spec change (see the second confirmation). */
  flowRevision: number;
  orchestratorAppId: string;
  initiator: WorkflowDraftInitiator;
  goal: string;
  title: string;
  phase: WorkflowDraftPhase;
  grillStatus: GrillState['status'];
  /** The grill's open problems (spec / Architect / validation). */
  problems?: string[];
  createdAt: string;
  updatedAt: string;
  stale: boolean;
  abandonedAt?: string;
  clarify: {
    state: WorkflowDraftRecord['clarify']['state'];
    pending: boolean;
    turns: WorkflowDraftTurn[];
    specCandidate?: { markdown: string; triggerId?: string };
    error?: string;
  };
  spec?: { markdown?: string; json?: unknown; sha256?: string };
  specConfirmation?: WorkflowDraftRecord['specConfirmation'];
  architect?: WorkflowDraftRecord['architect'] & { elapsedMs: number };
  nodeBots?: WorkflowDraftRecord['nodeBots'];
  flow?: WorkflowDraftFlowView;
  /** Why the flow could not be projected (e.g. a node's bot left bots.json). */
  flowError?: string;
  flowConfirmation?: NonNullable<WorkflowDraftRecord['flowConfirmation']> & { valid: boolean };
  launch?: WorkflowDraftLaunchView;
  /** 运行模板 (D5). `needsConfirmation`: I13 or a swapped bot; `swapped`:
   *  no longer the template as is (commits as an ad-hoc run). */
  template?: WorkflowDraftTemplateRun & {
    needsConfirmation: boolean;
    swapped: boolean;
    /** The owner published another version since this run was prepared: it
     *  still runs the prepared one (shown, not blocking). */
    newerPublished?: { humanVersion: number; revisionId: string };
  };
  /** 基于历史创建 (D6). `prefilled`: 「确认需求」 uses the copied flow
   *  (`prefillDag`, shown read only) instead of the Architect. `unresolved`:
   *  markers left in the current flow (拉群开始 refuses them). */
  copy?: {
    source: WorkflowDraftCopy['source'];
    copiedAt: string;
    prefilled: boolean;
    prefillDag?: V3Dag;
    inputs?: WorkflowDraftCopy['inputs'];
    goalEditedAt?: string;
    unresolved?: { params: string[]; context: string[] };
    prefillStale?: true;
    /** Nodes whose copied bot cannot run them; `resolved`: swapped (or usable again). */
    needsBot?: Array<{ nodeId: string; larkAppId: string; why: string; placeholder?: true; resolved: boolean }>;
  };
}

/** 「改目标」 on a copied draft (§6): keep the flow and only change the text,
 *  or re-orchestrate for the new goal — straight to the Architect (the
 *  requirement text changed) or back to clarifying first. */
export type WorkflowCopyGoalMode = 'text_only' | 'rearchitect' | 'reclarify';

/** 存为模板 (§5.1): what the confirm dialog shows before anything is written. */
export interface WorkflowDraftTemplateSavePreview {
  displayName: string;
  flowSummary: V3FlowSummary;
  flowSummarySha256: string;
  inputs: DashboardSavePlan['revision']['inputs'];
  nodeCount: number;
  gateCount: number;
  lintWarnings: string[];
  /** Append only. */
  target?: {
    workflowId: string;
    displayName: string;
    latestRevision: string;
    humanVersion: number;
    /** Against the latest version and (when another) the published one —
     *  both shown, each naming its base (I10). */
    gateComparisons: SavedWorkflowGateComparisonAgainst[];
  };
  /** The template's nodes with the edits so far (where 「设为参数」 selects
   *  next: edits apply in order, each to the text the previous ones left). */
  dagNodes: V3Node[];
  /** The caller's own global templates of this bot (I9: appendable). */
  appendCandidates: Array<{ workflowId: string; displayName: string; latestRevision: string }>;
}

/** 拉群记录 as the page shows it (§4.5): where it is, what it did. */
export interface WorkflowDraftLaunchView {
  state: WorkflowDraftLaunch['state'];
  /** A step sequence is running in this daemon right now. */
  running: boolean;
  /** The step 「继续」 does next (`unknown` when the flow cannot be read). */
  nextStep: LaunchStep | 'unknown';
  attempt: number;
  groupName: string;
  marker: string;
  extraMembers: string[];
  ownerChannel: WorkflowDraftLaunch['ownerChannel'];
  chat?: WorkflowDraftLaunch['chat'];
  orphanSuspects?: WorkflowDraftLaunch['orphanSuspects'];
  root?: WorkflowDraftLaunch['root'];
  rootManualResends?: WorkflowDraftLaunch['rootManualResends'];
  migrate?: WorkflowDraftLaunch['migrate'];
  check?: WorkflowDraftLaunch['check'];
  grantedBots: string[];
  commit?: WorkflowDraftLaunch['commit'];
  start?: WorkflowDraftLaunch['start'];
  error?: WorkflowDraftLaunch['error'];
  startedAt: string;
  updatedAt: string;
  abandonedAt?: string;
}

/** Non-main executing bots of a flow view (undefined: no readable flow). */
function flowTargetsOf(flow: WorkflowDraftFlowView | undefined): string[] | undefined {
  return flow ? [...new Set(flow.plan.rows.filter((row) => !row.main).map((row) => row.larkAppId))] : undefined;
}

interface MutateOpts {
  baseVersion?: number;
  allowAbandoned?: boolean;
  allowDeleted?: boolean;
  /** A launch operation (D4): not refused by a running launch (it checks itself). */
  launchOp?: boolean;
  /** Also a draft whose launch wrote run.json or started the run. */
  launched?: boolean;
  /** Not activity: leave updatedAt (the staleness clock) as it is. */
  keepUpdatedAt?: boolean;
}

interface ArchitectTask {
  controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
  done: Promise<void>;
}

function sameInitiator(a: WorkflowDraftInitiator, b: WorkflowDraftInitiator): boolean {
  // The person (this app's open_id) AND the login path: a draft started with
  // the local token is not continued by a platform login that happens to map
  // to the same open_id, nor the other way round (§9: 换了登录方式 → 只能看).
  return a.openId === b.openId && a.source === b.source;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** At most `max` characters, the ellipsis included (schema limits are hard). */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function pushTurn(draft: WorkflowDraftRecord, turn: WorkflowDraftTurn): void {
  draft.clarify.turns.push({ ...turn, text: clip(turn.text, WORKFLOW_DRAFT_MAX_TURN_CHARS) });
  if (draft.clarify.turns.length > WORKFLOW_DRAFT_MAX_TURNS) {
    draft.clarify.turns.splice(0, draft.clarify.turns.length - WORKFLOW_DRAFT_MAX_TURNS);
  }
}

const TIMED_OUT = Symbol('timed_out');

/** The live holder check used by file locks: same boot, same process start. */
function defaultHolderAlive(holder: WorkflowDraftReservationHolder): boolean {
  if (holder.bootId) {
    const live = readLinuxBootIdentity();
    if (live !== undefined && live !== holder.bootId) return false;
  }
  if (holder.procStart) {
    const live = readProcessStartIdentity(holder.pid);
    if (live !== undefined) return live === holder.procStart;
  }
  return holder.pid === process.pid || pidIsSignalable(holder.pid);
}

/**
 * The outcome a lost Architect run settles to (boot recovery, or a run whose
 * outcome could not be recorded): a grill that reached 待确认流程 means the
 * attempt did succeed — its DAG is validated and on disk; anything else is
 * an interruption.
 */
function settleLostArchitect(
  draft: WorkflowDraftRecord,
  grillStatus: GrillState['status'] | undefined,
  at: string,
  problems: string[],
): 'succeeded' | 'interrupted' {
  const { problems: _old, ...rest } = draft.architect!;
  if (grillStatus === 'dag_ready') {
    draft.architect = { ...rest, state: 'succeeded', finishedAt: at };
    return 'succeeded';
  }
  draft.architect = { ...rest, state: 'interrupted', finishedAt: at, problems };
  return 'interrupted';
}

/**
 * The clarify session is (or may already be) the main topic's (§4.5 第 4 步):
 * moved, or a move under way whose outcome is not recorded. Nothing closes or
 * suspends it as the draft's; a resumed launch reconciles a pending move.
 */
function clarifySessionInTopic(draft: WorkflowDraftRecord): boolean {
  if (draft.clarify.state === 'migrated') return true;
  const migrate = draft.launch?.migrate;
  return !!migrate && migrate.status !== 'unavailable' && !!draft.clarify.sessionId
    && (migrate.sessionId === undefined || migrate.sessionId === draft.clarify.sessionId);
}

/** Every clarify session a draft knows of (current + ones whose close failed). */
function draftSessions(draft: WorkflowDraftRecord): Array<{ sessionId: string; headlessId?: string }> {
  const out = new Map<string, { sessionId: string; headlessId?: string }>();
  for (const item of draft.orphanSessions ?? []) out.set(item.sessionId, item);
  // A session moved into the main topic is that topic's now, not the draft's.
  if (draft.clarify.sessionId && !clarifySessionInTopic(draft)) {
    out.set(draft.clarify.sessionId, {
      sessionId: draft.clarify.sessionId,
      ...(draft.clarify.headlessId ? { headlessId: draft.clarify.headlessId } : {}),
    });
  }
  return [...out.values()];
}

function readTextOrUndefined(path: string): string | undefined {
  try { return readFileSync(path, 'utf-8'); } catch { return undefined; }
}

/** Planned topic group (§4.4): configured + daemon online are checked for
 *  real; membership and topic sessions pass (every bot of a topic group opens
 *  topic sessions; joining happens at 拉群开始); no grant is written. */
function plannedGroupProbe(bots: readonly BotConfig[], isDaemonOnline: (appId: string) => boolean): V3BotEligibilityProbe {
  const configured = new Set(bots.map((bot) => bot.larkAppId));
  return {
    isConfigured: (appId) => configured.has(appId),
    isDaemonOnline: (appId) => {
      try { return isDaemonOnline(appId); } catch { return false; }
    },
    inChat: async () => 'yes',
    opensTopicSessions: async () => 'yes',
    ensureGrant: async () => {},
  };
}

/** Find (and let the caller rewrite) the goal node a page addresses: a
 *  top-level goal node id, or `<loopId>.<bodyNodeId>`. */
function findGoalNode(dag: Record<string, unknown>, nodeId: string): Record<string, unknown> | undefined {
  const nodes = Array.isArray(dag.nodes) ? dag.nodes as Array<Record<string, unknown>> : [];
  const top = nodes.find((node) => node.id === nodeId && (node.type === undefined || node.type === 'goal'));
  if (top) return top;
  for (const node of nodes) {
    if (node.type !== 'loop' || typeof node.id !== 'string' || !nodeId.startsWith(`${node.id}.`)) continue;
    const bodyId = nodeId.slice(node.id.length + 1);
    const body = (node.body as { nodes?: Array<Record<string, unknown>> } | undefined)?.nodes ?? [];
    const hit = body.find((candidate) => candidate.id === bodyId && (candidate.type === undefined || candidate.type === 'goal'));
    if (hit) return hit;
  }
  return undefined;
}

function countGates(nodes: readonly V3Node[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.humanGate) count += 1;
    if (node.type === 'loop' && node.body) count += countGates(node.body.nodes);
  }
  return count;
}

/** spec.md of a copied spec: the title, the requirement, and the one
 *  canonical json block hostSpecFinalize reads. */
function renderCopySpecMarkdown(spec: { title: string; requirement: string }): string {
  // The narrative is for people; the json block is what is finalized. Fences
  // in the text would read as a second block, so they are defused there (the
  // json block keeps the exact text: JSON escapes its newlines).
  const narrative = (text: string) => text.replace(/`{3,}/g, '``');
  return `# ${narrative(spec.title)}\n\n## 需求\n\n${narrative(spec.requirement)}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`;
}

/** Drop a copy's prefilled flow and what came with it (the nodes needing a
 *  new bot belong to that flow). */
function dropCopyPrefill(draft: WorkflowDraftRecord): boolean {
  const copy = draft.copy;
  if (!copy || (!copy.prefill && !copy.needsBot)) return false;
  delete copy.prefill;
  delete copy.needsBot;
  return true;
}

/** Goal nodes of a DAG by page id (top level, or `<loop>.<body>`) with their bot. */
function goalNodeBots(nodes: readonly V3Node[], prefix = ''): Array<{ nodeId: string; node: V3Node }> {
  const out: Array<{ nodeId: string; node: V3Node }> = [];
  for (const node of nodes) {
    const nodeId = prefix ? `${prefix}.${node.id}` : node.id;
    if (node.type === 'loop' && node.body) out.push(...goalNodeBots(node.body.nodes, nodeId));
    else if (node.type !== 'host') out.push({ nodeId, node });
  }
  return out;
}

/** The parameters a flow (and its spec) still refers to, of those declared. */
function referencedInputs(
  inputs: Record<string, SavedWorkflowParamDef> | undefined,
  dag: V3Dag,
  spec: unknown,
): Record<string, SavedWorkflowParamDef> {
  if (!inputs) return {};
  const used = new Set(collectSavedWorkflowTemplateBindings({ schemaVersion: 2, nodes: dag.nodes }).params);
  const specText = JSON.stringify(spec);
  const out: Record<string, SavedWorkflowParamDef> = {};
  for (const [name, def] of Object.entries(inputs)) {
    if (used.has(name) || specText.includes(`\${params.${name}}`)) out[name] = def as SavedWorkflowParamDef;
  }
  return out;
}

function parseOptionalWorkflowId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^wf_[0-9a-f]{32}$/.test(value)) throw err('bad_request', 'workflowId 不合法');
  return value;
}

/** The save target fields shared by 「存为模板」 from a draft and from a run. */
export function parseSaveTarget(
  input: { expectedLatestRevision?: unknown; displayName?: unknown; requestKey?: unknown },
  workflowId: string | undefined,
): { expectedLatestRevision?: string; displayName?: string; requestKey: string } {
  let expectedLatestRevision: string | undefined;
  if (input.expectedLatestRevision !== undefined) {
    if (typeof input.expectedLatestRevision !== 'string' || !/^rev_[0-9a-f]{64}$/.test(input.expectedLatestRevision)) {
      throw err('bad_request', 'expectedLatestRevision 不合法');
    }
    expectedLatestRevision = input.expectedLatestRevision;
  }
  if (workflowId && !expectedLatestRevision) throw err('bad_request', '追加版本要带上保存框比较过的最新版本 expectedLatestRevision');
  let displayName: string | undefined;
  if (input.displayName !== undefined) {
    if (typeof input.displayName !== 'string' || !input.displayName.trim() || Array.from(input.displayName.trim()).length > 128) {
      throw err('bad_request', '模板名称必须是 1–128 个字符');
    }
    if (workflowId) throw err('bad_request', '追加版本不改模板名称');
    displayName = input.displayName.trim();
  }
  const requestKey = typeof input.requestKey === 'string' ? input.requestKey : '';
  if (requestKey && !/^[A-Za-z0-9_-]{8,64}$/.test(requestKey)) throw err('bad_request', 'requestKey 必须是 8–64 位字母数字');
  if (!workflowId && !requestKey) throw err('bad_request', '新建模板要带 requestKey（8–64 位字母数字）');
  return { ...(expectedLatestRevision ? { expectedLatestRevision } : {}), ...(displayName ? { displayName } : {}), requestKey };
}

// ─── Service ──────────────────────────────────────────────────────────────

export class WorkflowDraftService {
  private readonly tasks = new Map<string, ArchitectTask>();
  /** Send / session-start reservations held by an operation of THIS process.
   *  A reservation on disk that is not here was left by a previous boot or a
   *  failed second step, and is dropped; one that is here is never timed out
   *  (a slow send must not be overtaken by a second tab). */
  private readonly inflight = new Set<string>();
  /** Clarify sessions being suspended right now (outside the lock). */
  private readonly suspending = new Set<string>();
  /** Clarify sessions whose close failed; the sweep retries them. */
  private readonly orphans = new Map<string, { sessionId: string; headlessId?: string }>();
  /** This service instance (one per daemon boot) as a reservation holder. */
  private readonly holder: WorkflowDraftReservationHolder;
  private readonly holderAlive: (holder: WorkflowDraftReservationHolder) => boolean;
  /** Launch operations (D4) running in THIS process, by token. A record on
   *  disk saying 拉群中 whose token is not here was left by an earlier boot:
   *  it is resumable with 「继续」, never resumed by itself. */
  private readonly launchTokens = new Set<string>();
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly loadDag: (path: string) => unknown;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: WorkflowDraftServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return () => clearTimeout(handle);
    });
    this.loadDag = deps.loadDag ?? realLoadDag;
    this.log = deps.log ?? (() => {});
    const procStart = readProcessStartIdentity(process.pid);
    const bootId = readLinuxBootIdentity();
    this.holder = {
      pid: process.pid,
      ...(procStart ? { procStart } : {}),
      ...(bootId ? { bootId } : {}),
      instance: randomUUID(),
    };
    this.holderAlive = deps.isHolderAlive ?? defaultHolderAlive;
  }

  /** A pending entry for a new reservation of this instance. */
  private reservationEntry(reservation: string): { triggerId: string; sentAt: string; holder: WorkflowDraftReservationHolder } {
    return { triggerId: reservation, sentAt: this.now().toISOString(), holder: this.holder };
  }

  /** Race `promise` against the call timeout (on the injected clock). A call
   *  that loses keeps running; `late` sees its eventual result. */
  private async bounded<T>(promise: Promise<T>, late?: (value: T) => void): Promise<T | typeof TIMED_OUT> {
    let cancel = () => {};
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      cancel = this.setTimer(() => resolve(TIMED_OUT), DRAFT_CLARIFY_CALL_TIMEOUT_MS);
    });
    try {
      const winner = await Promise.race([promise, timeout]);
      if (winner === TIMED_OUT && late) void promise.then(late, () => {});
      return winner;
    } finally {
      cancel();
    }
  }

  get appId(): string { return this.deps.appId; }

  // ── shared plumbing ──

  private runDirOf(runId: string, opts: { launched?: boolean } = {}): string {
    const runDir = workflowDraftRunDir(this.deps.baseDir, runId);
    // Checked again under the lock; this keeps a lock file from being
    // created in (or failing on) a dir that is not a draft.
    if (!runDir || !(isWorkflowDraftDir(runDir) || (opts.launched && isLaunchedWorkflowDraftDir(runDir)))) {
      throw err('unknown_draft', `没有这个草稿：${runId}`);
    }
    return runDir;
  }

  /** Load inside the draft lock and check ownership/initiator/state. */
  private loadLocked(
    runId: string,
    runDir: string,
    initiator: WorkflowDraftInitiator | undefined,
    opts: MutateOpts,
  ): { draft: WorkflowDraftRecord; grill: GrillState } {
    if (!(isWorkflowDraftDir(runDir) || (opts.launched && isLaunchedWorkflowDraftDir(runDir)))) {
      throw err('unknown_draft', `没有这个草稿：${runId}`);
    }
    const draft = readWorkflowDraft(runDir);
    const grill = readGrillState(runDir);
    if (!draft || !grill || (draft.deletedAt && !opts.allowDeleted)
      || draft.runId !== runId || grill.runId !== runId || grill.chatBinding) {
      throw err('unknown_draft', `没有这个草稿：${runId}`);
    }
    if (draft.orchestratorAppId !== this.deps.appId) {
      throw err('bot_mismatch', `草稿 ${runId} 属于另一个编排 Bot`, { orchestratorAppId: draft.orchestratorAppId });
    }
    if (initiator && !sameInitiator(initiator, draft.initiator)) {
      throw err('not_initiator', '只有这个草稿的发起人能继续操作；其他人可以查看或复制');
    }
    if (draft.abandonedAt && !opts.allowAbandoned) throw err('draft_abandoned', '这个草稿已放弃');
    if (initiator) {
      // A person's write while this daemon is running the draft's launch is
      // refused outright (two tabs, a bot swap mid-launch): the launch's
      // steps read the flow and the record without holding the lock.
      if (!opts.launchOp && this.launchRunning(draft)) {
        throw err('launch_running', '正在拉群，等这一步结束再操作');
      }
      // run.json is the commit: past it, only the launch may go on (start).
      if (!opts.launched && existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) {
        throw err('run_committed', 'run.json 已写入，这个草稿只能「继续」启动');
      }
    }
    if (opts.baseVersion !== undefined && opts.baseVersion !== draft.version) {
      throw err('version_conflict', '草稿已被更新，请刷新后再操作', { version: draft.version });
    }
    return { draft, grill };
  }

  /** The draft's launch is held by a live operation of THIS process. */
  private launchRunning(draft: WorkflowDraftRecord): boolean {
    const token = draft.launch?.state === 'running' ? draft.launch.token : undefined;
    return !!token && this.launchTokens.has(token);
  }

  /**
   * One write transaction. `fn` mutates `draft` in place (and may call host
   * operations, which take the grill lock inside this one) and returns
   * whether draft.json changed.
   */
  private mutate<T>(
    runId: string,
    initiator: WorkflowDraftInitiator | undefined,
    opts: MutateOpts,
    fn: (ctx: { runDir: string; draft: WorkflowDraftRecord; grill: GrillState; healed: boolean }) => { changed: boolean; result: T },
  ): T {
    const runDir = this.runDirOf(runId, { launched: opts.launched });
    try {
      return withWorkflowDraftLock(runDir, runId, () => {
        const { draft, grill } = this.loadLocked(runId, runDir, initiator, opts);
        const refreshed = this.refreshClarifyInPlace(draft);
        const healed = this.healStaleArchitect(runId, draft, grill);
        const out = fn({ runDir, draft, grill, healed });
        // Self-healing (a dead reservation dropped, a lost Architect outcome)
        // is not activity: it leaves the staleness clock alone (§4.6). A
        // reply landing, or the operation's own change, is activity.
        const active = (out.changed && !opts.keepUpdatedAt) || refreshed === 'activity';
        if (out.changed || refreshed || healed) this.persist(runDir, draft, { keepUpdatedAt: !active });
        return out.result;
      });
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /** `keepUpdatedAt`: a bookkeeping write that is not activity (e.g. the
   *  root card noted abandoned on the way to a delete): the 30-day clock
   *  (§4.6) keeps running. */
  private persist(runDir: string, draft: WorkflowDraftRecord, opts: { keepUpdatedAt?: boolean } = {}): void {
    draft.version += 1;
    if (!opts.keepUpdatedAt) draft.updatedAt = this.now().toISOString();
    writeWorkflowDraft(runDir, draft);
  }

  private mapError(error: unknown): unknown {
    if (error instanceof WorkflowDraftError) return error;
    if (error instanceof WorkflowDraftBusyError) return err('busy', error.message);
    if (error instanceof HostGuardError) {
      return /正在执行另一个 workflow host mutation/.test(error.message)
        ? err('busy', '草稿正在被另一个操作修改，请稍后重试')
        : err('state_conflict', error.message);
    }
    return error;
  }

  /**
   * A draft recorded 编排中 that nothing runs any more — no task in this
   * process and the grill not in architect_running (whose own lock still
   * guards a run elsewhere) — is a lost outcome (e.g. its record could not be
   * written). It becomes 编排中断 in place instead of blocking every write
   * until the next restart. Never awaits; caller holds the draft lock.
   */
  private healStaleArchitect(runId: string, draft: WorkflowDraftRecord, grill: GrillState): boolean {
    if (draft.architect?.state !== 'running' || this.tasks.has(runId) || grill.status === 'architect_running') return false;
    const settled = settleLostArchitect(draft, grill.status, this.now().toISOString(), ['编排的结果没能记录下来，请重新编排']);
    if (settled === 'succeeded') this.flowChanged(draft, { nodeBots: true });
    return true;
  }

  /** Once 拉群开始 began, the requirement stage is closed: the clarify session
   *  may already be the main topic's. Bots can still be swapped (§4.5 第 5 步),
   *  or the launch abandoned. */
  private assertNoLaunch(draft: WorkflowDraftRecord, what: string): void {
    if (draft.launch) throw err('state_conflict', `已经开始拉群，不能再${what}；可以换执行 Bot 或放弃`);
  }

  /** A template run (D5) has no requirement stage: no clarify, no Architect. */
  private assertNotTemplateRun(draft: WorkflowDraftRecord, what: string): void {
    if (draft.template) throw err('template_run', `从模板运行的草稿不能${what}；要改需求或流程请先「复制为新工作流」`);
  }

  /** Whether the flow may go to 拉群开始: confirmed (all four pins) — or, for
   *  a template run that needs no confirmation (I13), still exactly the
   *  prepared revision's flow. */
  private flowReady(draft: WorkflowDraftRecord, flow: { dagSha256: string; specSha256: string; flowSummarySha256: string }): boolean {
    if (draft.template && !workflowTemplateRunNeedsConfirmation(draft)) {
      return flow.dagSha256 === draft.template.dagSha256 && flow.specSha256 === draft.template.specSha256;
    }
    return !!draft.flowConfirmation && this.confirmationValid(draft, flow);
  }

  private libraryDir(): string {
    return this.deps.libraryDataDir ?? dirname(this.deps.baseDir);
  }

  /** Library / parameter failures → the draft error vocabulary. */
  private mapLibraryError(error: unknown): unknown {
    if (error instanceof WorkflowDraftError) return error;
    if (error instanceof SavedWorkflowServiceError) {
      switch (error.code) {
        case 'not_found': return err('template_not_found', '没有这个模板，或它不属于这个编排 Bot');
        case 'scope_mismatch': return err('template_scope', '这是群范围的模板，只能在原群里用 /workflow run');
        case 'not_published': return err('template_not_published', '这个模板还没有发布的版本');
        case 'source_not_owned': return err('not_owner', '只能保存自己发起的运行');
        default: return err('template_invalid', error.message);
      }
    }
    if (error instanceof SavedWorkflowPermissionError) return err('not_owner', '只能给自己的模板追加版本');
    if (error instanceof SavedWorkflowNotFoundError) return err('template_not_found', '没有这个模板');
    if (error instanceof SavedWorkflowConflictError) return err('save_conflict', error.message);
    if (error instanceof ParamCoerceFailure) return err('bad_params', error.message, { issues: error.issues });
    if (error instanceof SavedWorkflowParamEditError) return err('bad_params', error.message, error.index !== undefined ? { index: error.index } : {});
    if (error instanceof SavedWorkflowUnsafeLiteralError) return err('unsafe_literals', error.message, { warnings: [...error.warnings] });
    if (error instanceof SavedWorkflowSchemaError) return err('template_invalid', '保存的内容不符合模板规则', { problems: error.problems });
    if (error instanceof Error && /sensitive parameters are not executable/.test(error.message)) return err('bad_params', error.message);
    // The template rules (template-bindings, the exact compiler) throw plain
    // errors: a flow that breaks them is the request's problem, not a fault.
    if (error instanceof Error && /^(?:Saved Workflow (?:template|has malformed|host|spec)|cannot save workflow:)/.test(error.message)) {
      return err('template_invalid', error.message);
    }
    return this.mapError(error);
  }

  private assertNotArchitecting(runId: string, draft: WorkflowDraftRecord, grill: GrillState): void {
    if (this.tasks.has(runId) || draft.architect?.state === 'running' || grill.status === 'architect_running') {
      throw err('architect_running', '正在编排，先取消或等它结束');
    }
  }

  private assertStatus(grill: GrillState, allowed: readonly GrillState['status'][], what: string): void {
    if (!allowed.includes(grill.status)) {
      throw err('state_conflict', `${what}需要草稿处于 ${allowed.join(' / ')}，当前 ${grill.status}`, { grillStatus: grill.status });
    }
  }

  /**
   * The flow definition (DAG or spec) changed (E5, §4.4): a new flow
   * revision, so the second confirmation is void — the explicit delete and
   * the revision check on every read both say so — and, for a DAG that no
   * longer exists, the per-node choices go too.
   */
  private flowChanged(draft: WorkflowDraftRecord, opts: { nodeBots: boolean }): void {
    draft.flowRevision = (draft.flowRevision ?? 0) + 1;
    delete draft.flowConfirmation;
    if (opts.nodeBots) delete draft.nodeBots;
  }

  // ── clarify session ──

  /** Commit a finished pending turn; true when draft changed. Never awaits. */
  /** `healed`: a left-over reservation dropped, or a lost session noted
   *  (bookkeeping); `activity`: a reply or a failed turn landed. */
  private refreshClarifyInPlace(draft: WorkflowDraftRecord): false | 'healed' | 'activity' {
    const pending = draft.clarify.pending;
    if (!pending) return false;
    if (pending.triggerId.startsWith(RESERVATION_PREFIX)) {
      if (this.inflight.has(pending.triggerId)) return false;
      // Held by another live process (or another instance in this one): it
      // releases it itself, within the call timeout. Ours and not in flight,
      // or its holder is gone: left over, dropped.
      const holder = pending.holder;
      if (holder && holder.instance !== this.holder.instance) {
        let alive = true;
        try { alive = this.holderAlive(holder); } catch { alive = true; }
        if (alive) return false;
      }
      delete draft.clarify.pending;
      return 'healed';
    }
    const sessionId = draft.clarify.sessionId;
    let result: DraftClarifyResult;
    try {
      result = sessionId ? this.deps.clarifier.result(sessionId, pending.triggerId) : { state: 'not_found' };
    } catch {
      return false;
    }
    if (result.state === 'running') return false;
    const at = this.now().toISOString();
    delete draft.clarify.pending;
    // Idle time counts from the last activity: a reply landing is one (when
    // it ended, if known — it may be committed later by a read or the sweep).
    if (result.state !== 'not_found') {
      const ended = result.state === 'completed' && result.finishedAt && Date.parse(result.finishedAt) <= Date.parse(at)
        ? new Date(Date.parse(result.finishedAt)).toISOString()
        : at;
      draft.clarify.lastMessageAt = ended;
    }
    if (result.state === 'completed') {
      const parsed = parseDraftClarifyOutput(result.content);
      pushTurn(draft, {
        role: 'assistant',
        text: parsed.text || result.content,
        at,
        triggerId: pending.triggerId,
        ...(parsed.question ? { question: parsed.question } : {}),
        ...(parsed.specMarkdown ? { hasSpec: true as const } : {}),
      });
      if (parsed.specMarkdown) {
        draft.clarify.specCandidate = { triggerId: pending.triggerId, markdown: parsed.specMarkdown.slice(0, 256_000), at };
      }
      delete draft.clarify.error;
    } else if (result.state === 'failed') {
      const why = result.error ? clip(result.error, 1000) : '这一轮没有产出回复';
      pushTurn(draft, { role: 'system', text: `这一轮失败了：${why}`, at, triggerId: pending.triggerId });
      draft.clarify.error = why;
    } else {
      draft.clarify.state = 'disconnected';
      draft.clarify.error = '会话已断开';
      return 'healed';
    }
    return 'activity';
  }

  private reserve(): string {
    const reservation = `${RESERVATION_PREFIX}${randomUUID()}`;
    this.inflight.add(reservation);
    return reservation;
  }

  /**
   * Send one turn into the clarify session. Reserved under the lock first so
   * two tabs cannot both send; the reservation is replaced by the real turn
   * (or dropped on failure) in a second short transaction.
   */
  private async sendTurn(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: { text: string; display: string; role: 'user' | 'system'; baseVersion?: number },
  ): Promise<WorkflowDraftView> {
    const reservation = this.reserve();
    try {
      const target = this.mutate(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill }) => {
        this.assertNoLaunch(draft, '对话');
        this.assertNotArchitecting(runId, draft, grill);
        this.assertStatus(grill, ['grilling', 'spec_ready'], '对话');
        if (draft.clarify.pending) throw err('clarify_turn_running', '上一轮还没回复');
        if (draft.clarify.state === 'disconnected' || draft.clarify.state === 'closed'
          || !draft.clarify.sessionId || !draft.clarify.headlessId) {
          throw err('session_disconnected', '会话已断开，点「继续」重新起会话');
        }
        if (this.suspending.has(draft.clarify.sessionId)) throw err('busy', '会话正在释放空闲进程，请稍后重试');
        draft.clarify.pending = this.reservationEntry(reservation);
        return { changed: true, result: { sessionId: draft.clarify.sessionId, headlessId: draft.clarify.headlessId } };
      });
      let sent: Awaited<ReturnType<DraftClarifier['send']>>;
      let timedOut = false;
      try {
        const outcome = await this.bounded(this.deps.clarifier.send({
          larkAppId: this.deps.appId, ...target, prompt: input.text, requestId: `${runId}:${reservation}`,
        }));
        if (outcome === TIMED_OUT) {
          timedOut = true;
          sent = { ok: false, error: 'timeout', disconnected: false };
        } else {
          sent = outcome;
        }
      } catch (error) {
        sent = { ok: false, error: errorText(error), disconnected: false };
      }
      let displaced = false;
      this.mutate(runId, undefined, { allowAbandoned: true }, ({ draft }) => {
        const at = this.now().toISOString();
        if (draft.clarify.pending?.triggerId !== reservation) {
          // Someone else changed the draft meanwhile (abandon / continue):
          // this turn is not tracked, so say so instead of reporting success.
          displaced = true;
          if (!sent.ok || draft.abandonedAt) return { changed: false, result: undefined };
          pushTurn(draft, {
            role: 'system',
            text: `这条消息发出时草稿已被另一个操作更新，它的回复不会显示：${clip(input.display, 200)}`,
            at,
          });
          return { changed: true, result: undefined };
        }
        delete draft.clarify.pending;
        if (timedOut) {
          // Treated like a displaced send: the call may still land later, and
          // its reply would not be tracked — say so.
          pushTurn(draft, {
            role: 'system',
            text: `这条消息没有在 ${Math.round(DRAFT_CLARIFY_CALL_TIMEOUT_MS / 60_000)} 分钟内发出去，已放弃等待；如果它稍后送达，回复不会显示：${clip(input.display, 200)}`,
            at,
          });
          draft.clarify.error = '发送超时';
          return { changed: true, result: undefined };
        }
        if (!sent.ok && sent.busy) return { changed: true, result: undefined };
        if (sent.ok) {
          draft.clarify.pending = { triggerId: sent.triggerId, sentAt: at };
          draft.clarify.state = 'active';
          draft.clarify.lastMessageAt = at;
          delete draft.clarify.suspendedAt;
          delete draft.clarify.suspendRefusedAt;
          delete draft.clarify.error;
          pushTurn(draft, { role: input.role, text: input.display, at, triggerId: sent.triggerId });
        } else if (sent.disconnected) {
          draft.clarify.state = 'disconnected';
          draft.clarify.error = '会话已断开';
        } else {
          draft.clarify.error = clip(sent.error, 1000);
        }
        return { changed: true, result: undefined };
      });
      if (displaced) {
        throw err('state_conflict', '消息发出时草稿已被另一个操作更新，这条消息的回复不会显示，请刷新后再发');
      }
      if (timedOut) throw err('clarify_unavailable', '发送超时，请稍后重试');
      if (!sent.ok) {
        if (sent.busy) throw err('busy', '会话正在重启，请稍后重试');
        throw sent.disconnected
          ? err('session_disconnected', '会话已断开，点「继续」重新起会话')
          : err('clarify_unavailable', `没能把消息发给编排 Bot：${clip(sent.error, 300)}`);
      }
    } finally {
      this.inflight.delete(reservation);
    }
    return this.view(runId);
  }

  /**
   * Start a fresh clarify session with `prompt` and record it on the draft —
   * only while `reservation` (taken by the caller under the lock) is still
   * the draft's: otherwise, or when the draft was abandoned / deleted
   * meanwhile, the session just created is closed, never left running.
   * Releases the reservation.
   */
  private async startSession(runId: string, prompt: string, title: string, reservation: string): Promise<void> {
    let created: Awaited<ReturnType<DraftClarifier['create']>> = { ok: false, error: 'not started' };
    let keep = false;
    try {
      try {
        // A create that answers after the timeout made a session nobody
        // records: close it when it lands.
        const outcome = await this.bounded(this.deps.clarifier.create({ larkAppId: this.deps.appId, title }), (late) => {
          if (late.ok) void this.closeOrRemember(undefined, { sessionId: late.sessionId, headlessId: late.headlessId });
        });
        created = outcome === TIMED_OUT ? { ok: false, error: '创建会话超时' } : outcome;
      } catch (error) {
        created = { ok: false, error: errorText(error) };
      }
      let sent: Awaited<ReturnType<DraftClarifier['send']>> | undefined;
      if (created.ok) {
        try {
          const outcome = await this.bounded(this.deps.clarifier.send({
            larkAppId: this.deps.appId,
            sessionId: created.sessionId,
            headlessId: created.headlessId,
            prompt,
            requestId: `${runId}:${reservation}`,
          }));
          sent = outcome === TIMED_OUT ? { ok: false, error: '发送第一轮超时', disconnected: false } : outcome;
        } catch (error) {
          sent = { ok: false, error: errorText(error), disconnected: false };
        }
      }
      const made = created;
      keep = this.mutate(runId, undefined, { allowAbandoned: true }, ({ draft }) => {
        // Abandoned meanwhile, or another operation owns the draft's session
        // slot now: this session is not the draft's.
        if (draft.abandonedAt || draft.clarify.pending?.triggerId !== reservation) return { changed: false, result: false };
        const at = this.now().toISOString();
        delete draft.clarify.pending;
        if (!made.ok) {
          draft.clarify.state = 'disconnected';
          draft.clarify.error = clip(made.error, 1000);
          return { changed: true, result: false };
        }
        draft.clarify.headlessId = made.headlessId;
        draft.clarify.sessionId = made.sessionId;
        delete draft.clarify.suspendedAt;
        delete draft.clarify.suspendRefusedAt;
        if (sent?.ok) {
          draft.clarify.state = 'active';
          draft.clarify.pending = { triggerId: sent.triggerId, sentAt: at };
          draft.clarify.lastMessageAt = at;
          delete draft.clarify.error;
        } else {
          draft.clarify.state = 'disconnected';
          draft.clarify.error = clip(sent?.error ?? '会话没有接受第一轮', 1000);
        }
        return { changed: true, result: true };
      });
    } finally {
      this.inflight.delete(reservation);
      // Not recorded on the draft (refused, abandoned, deleted, or the commit
      // threw): close it here — nothing else knows this session exists.
      if (created.ok && !keep) await this.closeOrRemember(runId, { sessionId: created.sessionId, headlessId: created.headlessId });
    }
  }

  /** Close a clarify session; on failure remember it (in memory, and on the
   *  draft when it still exists) so the sweep retries. */
  private async closeOrRemember(runId: string | undefined, session: { sessionId?: string; headlessId?: string }): Promise<boolean> {
    if (!session.sessionId) return true;
    const entry = { sessionId: session.sessionId, ...(session.headlessId ? { headlessId: session.headlessId } : {}) };
    try {
      await this.deps.clarifier.close(entry);
      this.orphans.delete(entry.sessionId);
      return true;
    } catch (error) {
      this.log(`[workflow-draft] closing clarify session ${entry.sessionId} failed (will retry): ${errorText(error)}`);
      this.orphans.set(entry.sessionId, entry);
      if (runId) {
        try {
          this.mutate(runId, undefined, { allowAbandoned: true, allowDeleted: true }, ({ draft }) => {
            const list = draft.orphanSessions ?? [];
            if (list.some((item) => item.sessionId === entry.sessionId)) return { changed: false, result: undefined };
            draft.orphanSessions = [...list, entry].slice(-WORKFLOW_DRAFT_MAX_ORPHANS);
            return { changed: true, result: undefined };
          });
        } catch { /* in memory still */ }
      }
      return false;
    }
  }

  // ── public operations ──

  /** 新建草稿 (§4.1): a grill run without a chat binding + its clarify session. */
  async create(initiator: WorkflowDraftInitiator, input: { goal: unknown }): Promise<WorkflowDraftView> {
    const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
    if (!goal) throw err('bad_request', '目标不能为空');
    if (goal.length > MAX_GOAL_CHARS) throw err('bad_request', `目标最多 ${MAX_GOAL_CHARS} 个字符`);
    const bot = this.deps.loadBots().find((candidate) => candidate.larkAppId === this.deps.appId);
    if (!bot) throw err('orchestrator_ineligible', '编排 Bot 不在本机 bots.json 里');
    const why = v3BotStaticExclusion(bot);
    if (why) throw err('orchestrator_ineligible', `这个 Bot 不能编排工作流：${why}`);
    // The same rule that keeps the steward off the Architect roster.
    if (isStewardBot(bot.steward)) throw err('orchestrator_ineligible', '管家 Bot 不能当编排 Bot');

    const now = this.now();
    const { runId, runDir } = birthRun({
      goal,
      baseDir: this.deps.baseDir,
      now,
      ...(this.deps.randomSuffix ? { randomSuffix: this.deps.randomSuffix() } : {}),
    });
    const at = now.toISOString();
    const reservation = this.reserve();
    const record: WorkflowDraftRecord = {
      schemaVersion: WORKFLOW_DRAFT_SCHEMA_VERSION,
      runId,
      orchestratorAppId: this.deps.appId,
      initiator,
      goal,
      createdAt: at,
      updatedAt: at,
      version: 1,
      // The session slot is reserved from birth: a second tab's 「继续」 or
      // message waits for this create instead of starting a second session.
      clarify: { state: 'active', turns: [{ role: 'user', text: goal, at }], pending: this.reservationEntry(reservation) },
    };
    try {
      withWorkflowDraftLock(runDir, runId, () => writeWorkflowDraft(runDir, record));
    } catch (error) {
      this.inflight.delete(reservation);
      throw error;
    }
    this.log(`[workflow-draft] created ${runId} app=${this.deps.appId} initiator=${initiator.openId} source=${initiator.source}`);
    await this.startSession(runId, buildDraftClarifyKickoff({ runId, goal }), clip(goal.replace(/\s+/g, ' '), 80), reservation);
    return this.view(runId);
  }

  /**
   * 运行模板 (§5.3): a draft from the published revision of one of this bot's
   * global templates, with the parameters checked and converted by the
   * `/workflow run` rules — no clarify, no Architect: it stands at 待确认流程
   * (draft-born revision, I13) or 已确认流程 (from a finished run), and 拉群开始
   * runs as for any draft. `expectedRevisionId`: the revision the form was
   * built from (a newer publish is refused, not run silently).
   */
  async createFromTemplate(
    initiator: WorkflowDraftInitiator,
    input: { workflowId: unknown; params?: unknown; expectedRevisionId?: unknown },
  ): Promise<WorkflowDraftView> {
    const workflowId = typeof input.workflowId === 'string' ? input.workflowId : '';
    if (!/^wf_[0-9a-f]{32}$/.test(workflowId)) throw err('bad_request', 'workflowId 不合法');
    if (input.expectedRevisionId !== undefined && (typeof input.expectedRevisionId !== 'string' || !/^rev_[0-9a-f]{64}$/.test(input.expectedRevisionId))) {
      throw err('bad_request', 'expectedRevisionId 不合法');
    }
    const params: Record<string, string> = {};
    if (input.params !== undefined) {
      if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) throw err('bad_request', 'params 必须是对象');
      for (const [name, value] of Object.entries(input.params as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw err('bad_params', `参数名不合法：${name}`);
        if (typeof value !== 'string') throw err('bad_params', `参数 ${name} 的值要填文字`);
        if (value.length > WORKFLOW_TEMPLATE_RUN_MAX_PARAM_CHARS) throw err('bad_params', `参数 ${name} 最多 ${WORKFLOW_TEMPLATE_RUN_MAX_PARAM_CHARS} 个字符`);
        params[name] = value;
      }
    }
    const bots = this.deps.loadBots();
    const bot = bots.find((candidate) => candidate.larkAppId === this.deps.appId);
    if (!bot) throw err('orchestrator_ineligible', '编排 Bot 不在本机 bots.json 里');
    const why = v3BotStaticExclusion(bot);
    if (why) throw err('orchestrator_ineligible', `这个 Bot 不能编排工作流：${why}`);
    if (isStewardBot(bot.steward)) throw err('orchestrator_ineligible', '管家 Bot 不能当编排 Bot');

    const rawParams = Object.create(null) as Record<string, RawParamInput>;
    for (const [name, value] of Object.entries(params)) rawParams[name] = { kind: 'string', value };
    let prepared: Awaited<ReturnType<typeof prepareDashboardSavedWorkflowRun>>;
    try {
      prepared = await prepareDashboardSavedWorkflowRun({
        dataDir: this.libraryDir(),
        workflowId,
        actor: { openId: initiator.openId, larkAppId: this.deps.appId },
        rawParams,
      });
    } catch (error) {
      throw this.mapLibraryError(error);
    }
    if (input.expectedRevisionId !== undefined && prepared.revision.revisionId !== input.expectedRevisionId) {
      throw err('save_conflict', '模板已经发布了新版本，请刷新后再运行', { revisionId: prepared.revision.revisionId });
    }
    const now = this.now();
    const displayName = prepared.metadata.displayName;
    const { runId, runDir, state } = birthRun({
      goal: displayName,
      baseDir: this.deps.baseDir,
      now,
      ...(this.deps.randomSuffix ? { randomSuffix: this.deps.randomSuffix() } : {}),
    });
    let record: WorkflowDraftRecord;
    try {
      const { dag, spec } = savedWorkflowRunFlow(prepared.revision, runId);
      // Every node's bot must still be configured here (checked again live
      // at 拉群开始): fail now, not at the end of a launch.
      freezeDagBotSnapshots(dag, bots, { defaultSelector: this.deps.appId });
      const dagPath = join(runDir, 'dag.json');
      atomicWriteFileSync(dagPath, `${JSON.stringify(dag, null, 2)}\n`, { mode: 0o600 });
      atomicWriteFileSync(state.specJsonPath, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
      // The flow is the template's: the grill starts where a confirmed
      // Architect run ends (no clarify, no Architect, §5.3).
      writeGrillState(runDir, { ...state, status: 'dag_ready', dagPath, updatedAt: now.toISOString() });
      const at = now.toISOString();
      record = {
        schemaVersion: WORKFLOW_DRAFT_SCHEMA_VERSION,
        runId,
        orchestratorAppId: this.deps.appId,
        initiator,
        goal: displayName,
        createdAt: at,
        updatedAt: at,
        version: 1,
        clarify: { state: 'closed', turns: [] },
        flowRevision: 0,
        template: {
          workflowId,
          revisionId: prepared.revision.revisionId,
          contentHash: prepared.revision.contentHash,
          humanVersion: prepared.revision.payload.humanVersion,
          displayName,
          ownerOpenId: prepared.metadata.owner.openId,
          params,
          hasInputs: Object.keys(prepared.revision.payload.inputs).length > 0,
          dagSha256: artifactRef(runDir, 'dag.json').sha256,
          specSha256: artifactRef(runDir, 'spec.json').sha256,
          preparedAt: at,
        },
      };
      // draft.json last: until it exists the directory is not a draft.
      withWorkflowDraftLock(runDir, runId, () => writeWorkflowDraft(runDir, record));
    } catch (error) {
      rmSync(runDir, { recursive: true, force: true });
      if (error instanceof WorkflowDraftError) throw error;
      throw err('template_invalid', `模板不能在这里运行：${errorText(error)}`);
    }
    this.log(`[workflow-draft] template run ${runId} of ${workflowId} v${record.template!.humanVersion} by ${initiator.openId} (${initiator.source})`);
    return this.view(runId);
  }

  /**
   * 基于历史创建 (§6, D6): a new draft from a run (finished or not) or one
   * version of a template, with its spec and flow prefilled, at 待确认需求 —
   * the person who copies is its initiator (§7.2: anyone's source may be
   * copied). Checked like an Architect result (spec, DAG, the planned-group
   * roster) before anything is written; a refusal lists the problems. No
   * clarify session, no run record, no artefacts are copied; the source is
   * only read.
   *
   * `larkAppId`: the orchestrating bot chosen on the page; absent, it is the
   * source's (the Dashboard routes there) and must be this daemon's.
   */
  async createFromSource(
    initiator: WorkflowDraftInitiator,
    input: { source: unknown; larkAppId?: unknown },
  ): Promise<WorkflowDraftView> {
    if (input.larkAppId !== undefined && input.larkAppId !== this.deps.appId) {
      throw err('bot_mismatch', '请求的编排 Bot 不是这个 daemon 的 Bot');
    }
    let material: WorkflowCopyMaterial;
    try {
      const ref = parseWorkflowCopySource(input.source);
      material = ref.kind === 'run'
        ? readRunCopyMaterial(this.deps.baseDir, ref.runId)
        : await readTemplateCopyMaterial(this.libraryDir(), ref.workflowId, ref.revisionId);
    } catch (error) {
      if (error instanceof WorkflowCopySourceError) {
        throw err(error.code === 'source_unreadable' ? 'source_unreadable' : error.code, error.message);
      }
      throw error;
    }
    if (input.larkAppId === undefined && material.source.orchestratorAppId !== this.deps.appId) {
      throw err('bot_mismatch', '来源的编排 Bot 不是这个 daemon 的 Bot，请指定编排 Bot');
    }
    const bots = this.deps.loadBots();
    const bot = bots.find((candidate) => candidate.larkAppId === this.deps.appId);
    if (!bot) throw err('orchestrator_ineligible', '编排 Bot 不在本机 bots.json 里');
    const why = v3BotStaticExclusion(bot);
    if (why) throw err('orchestrator_ineligible', `这个 Bot 不能编排工作流：${why}`);
    if (isStewardBot(bot.steward)) throw err('orchestrator_ineligible', '管家 Bot 不能当编排 Bot');
    const roster = await this.plannedRoster(bots, this.deps.nameOf());

    const title = material.spec.title;
    const now = this.now();
    const { runId, runDir, state } = birthRun({
      goal: title,
      baseDir: this.deps.baseDir,
      now,
      ...(this.deps.randomSuffix ? { randomSuffix: this.deps.randomSuffix() } : {}),
    });
    const at = now.toISOString();
    try {
      let spec: ReturnType<typeof validateSpec>;
      let dag: V3Dag;
      // A node whose bot is no longer configured here goes on the
      // orchestrating bot for now and is marked (§5.3: 复制后换 Bot) — the
      // copy is not refused for who executes it, only for its structure.
      const configured = new Set(bots.map((candidate) => candidate.larkAppId));
      const needsBot: NonNullable<WorkflowDraftCopy['needsBot']> = {};
      const placeholders = (nodes: V3Node[], prefix = ''): V3Node[] => nodes.map((node) => {
        const nodeId = prefix ? `${prefix}.${node.id}` : node.id;
        const next: V3Node = { ...node };
        if (node.type !== 'host' && typeof node.bot === 'string' && !configured.has(node.bot)) {
          if (node.type !== 'loop') needsBot[nodeId] = { larkAppId: node.bot, why: '已不在本机 bots.json 里', placeholder: true };
          next.bot = this.deps.appId;
        }
        if (node.type === 'loop' && node.body) next.body = { nodes: placeholders(node.body.nodes, nodeId) };
        return next;
      });
      try {
        spec = validateSpec({ ...material.spec, runId });
      } catch (error) {
        throw err('dag_invalid', '复制来的需求没有通过校验', { problems: (error as { problems?: string[] }).problems ?? [errorText(error)] });
      }
      try {
        dag = validateDag({ ...(material.schemaVersion !== undefined ? { schemaVersion: material.schemaVersion } : {}), runId, nodes: placeholders(material.nodes) });
      } catch (error) {
        throw err('dag_invalid', '复制来的流程没有通过校验', { problems: error instanceof DagValidationError ? error.problems : [errorText(error)] });
      }
      // The planned group's roster (§4.4): a bot that is configured but
      // cannot run a node there (offline, excluded) is kept and marked.
      for (const { nodeId, node } of goalNodeBots(dag.nodes)) {
        const appId = node.bot ?? this.deps.appId;
        if (needsBot[nodeId] || roster.bots.some((candidate) => candidate.larkAppId === appId)) continue;
        const excluded = roster.excluded.find((entry) => entry.larkAppId === appId);
        needsBot[nodeId] = { larkAppId: appId, why: clip(excluded?.why ?? '不在可用 Bot 名单里', 500) };
      }
      try {
        freezeDagBotSnapshots(dag, bots, { defaultSelector: this.deps.appId });
      } catch (error) {
        throw err('dag_invalid', '复制来的流程没有通过校验', { problems: [errorText(error)] });
      }
      const copyPath = join(runDir, WORKFLOW_COPY_DAG_FILE);
      atomicWriteFileSync(copyPath, `${JSON.stringify(dag, null, 2)}\n`, { mode: 0o600 });
      atomicWriteFileSync(state.specPath, renderCopySpecMarkdown(spec), { mode: 0o600 });
      atomicWriteFileSync(state.specJsonPath, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
      // The requirement is written: the grill starts at 待确认需求 (§6).
      writeGrillState(runDir, { ...state, status: 'spec_ready', updatedAt: at });
      const dagSha256 = fileSha256(copyPath);
      const specSha256 = fileSha256(state.specJsonPath);
      if (!dagSha256 || !specSha256) throw new Error('copy.dag.json / spec.json 写入后读不到');
      const source = material.source;
      const what = source.kind === 'run'
        ? `运行 ${source.runId}${source.unfinished ? '（尚未结束，复制的是复制时的版本）' : ''}`
        : `模板「${source.displayName}」v${source.humanVersion}`;
      const inputs = Object.keys(material.inputs).length > 0 ? material.inputs : undefined;
      const record: WorkflowDraftRecord = {
        schemaVersion: WORKFLOW_DRAFT_SCHEMA_VERSION,
        runId,
        orchestratorAppId: this.deps.appId,
        initiator,
        goal: clip(spec.requirement, MAX_GOAL_CHARS),
        createdAt: at,
        updatedAt: at,
        version: 1,
        // No clarify session is copied; 「按新目标重新编排」 starts one.
        clarify: { state: 'disconnected', turns: [{ role: 'system', text: `复制自${what}`, at }] },
        flowRevision: 0,
        copy: {
          source,
          copiedAt: at,
          prefill: { dagSha256, specSha256 },
          ...(Object.keys(needsBot).length ? { needsBot } : {}),
          ...(inputs ? { inputs: inputs as WorkflowDraftCopy['inputs'] } : {}),
        },
      };
      // draft.json last: until it exists the directory is not a draft.
      withWorkflowDraftLock(runDir, runId, () => writeWorkflowDraft(runDir, record));
    } catch (error) {
      rmSync(runDir, { recursive: true, force: true });
      if (error instanceof WorkflowDraftError) throw error;
      throw err('dag_invalid', `复制失败：${errorText(error)}`, { problems: [errorText(error)] });
    }
    const source = material.source;
    this.log(`[workflow-draft] copy ${runId} from ${source.kind === 'run' ? `run ${source.runId}` : `template ${source.workflowId}@${source.revisionId}`} by ${initiator.openId} (${initiator.source})`);
    return this.view(runId);
  }

  /** A copied draft (§6), or not_a_copy. */
  private assertCopy(draft: WorkflowDraftRecord, what: string): WorkflowDraftCopy {
    if (!draft.copy) throw err('not_a_copy', `只有「复制为新工作流」得到的草稿能${what}`);
    return draft.copy;
  }

  /** The prefilled flow still belongs to the requirement on disk: it was
   *  pinned to it, and only 「只改文字」 moves the pin (§6). */
  private copyPrefillUsable(grill: GrillState, draft: WorkflowDraftRecord): boolean {
    const prefill = draft.copy?.prefill;
    return !!prefill && fileSha256(grill.specJsonPath) === prefill.specSha256;
  }

  /** Nodes of a copy still waiting for a new bot: not swapped, and either put
   *  on the orchestrating bot for now or still off the planned roster. */
  private outstandingCopyBots(draft: WorkflowDraftRecord, roster: V3BotRoster): Array<{ nodeId: string; larkAppId: string; why: string }> {
    const out: Array<{ nodeId: string; larkAppId: string; why: string }> = [];
    for (const [nodeId, entry] of Object.entries(draft.copy?.needsBot ?? {})) {
      if (draft.nodeBots?.[nodeId]) continue;
      if (!entry.placeholder && roster.bots.some((candidate) => candidate.larkAppId === entry.larkAppId)) continue;
      out.push({ nodeId, larkAppId: entry.larkAppId, why: entry.why });
    }
    return out;
  }

  /**
   * 「确认需求」 of a copy with its prefilled flow: the copied DAG (checked
   * against its digest and validated again) becomes the draft's flow and the
   * grill goes to 待确认流程 in one write — no Architect (§6). Caller holds
   * the draft lock.
   */
  private applyCopyPrefill(runDir: string, copy: WorkflowDraftCopy): void {
    const prefill = copy.prefill!;
    withHostMutationLockSync(runDir, () => {
      const cur = readGrillState(runDir);
      if (!cur) throw err('state_conflict', 'grill.state.json 不存在');
      if (existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) throw err('state_conflict', 'run 已开始，流程定义不可再改');
      this.assertStatus(cur, ['spec_ready'], '确认需求');
      const copyPath = join(runDir, WORKFLOW_COPY_DAG_FILE);
      if (fileSha256(copyPath) !== prefill.dagSha256) throw err('dag_invalid', '复制来的流程文件被改动过，请退回改需求后重新编排');
      try {
        this.loadDag(copyPath);
      } catch (error) {
        throw err('dag_invalid', '复制来的流程没有通过校验', { problems: (error as { problems?: string[] }).problems ?? [errorText(error)] });
      }
      const dagPath = join(runDir, 'dag.json');
      atomicWriteFileSync(dagPath, readFileSync(copyPath), { mode: 0o600 });
      writeGrillState(runDir, { ...cur, status: 'dag_ready', dagPath, problems: undefined, updatedAt: this.now().toISOString() });
    });
  }

  /**
   * 改目标 on a copy at 待确认需求 (§6):
   *   - text_only: the requirement text changes, the copied flow is kept;
   *   - rearchitect: the requirement text changes and the copied flow is
   *     dropped — 「确认需求」 then runs the Architect;
   *   - reclarify: back to clarifying with a new session for the new goal
   *     (the copied spec as a starting point); the flow is dropped.
   * Both confirmations are void either way.
   */
  async editCopyGoal(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: { goal: unknown; mode: unknown; baseVersion?: number },
  ): Promise<WorkflowDraftView> {
    const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
    if (!goal) throw err('bad_request', '目标不能为空');
    if (goal.length > MAX_GOAL_CHARS) throw err('bad_request', `目标最多 ${MAX_GOAL_CHARS} 个字符`);
    const mode = input.mode;
    if (mode !== 'text_only' && mode !== 'rearchitect' && mode !== 'reclarify') {
      throw err('bad_request', 'mode 只能是 text_only / rearchitect / reclarify');
    }
    const reservation = mode === 'reclarify' ? this.reserve() : undefined;
    let kickoff: { prompt: string; title: string } | undefined;
    try {
      kickoff = this.mutate(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill, runDir }) => {
        const copy = this.assertCopy(draft, '改目标');
        this.assertNoLaunch(draft, '改目标');
        this.assertNotArchitecting(runId, draft, grill);
        this.assertStatus(grill, ['spec_ready'], '改目标');
        const at = this.now().toISOString();
        if (mode === 'reclarify') {
          if (draft.clarify.pending) throw err('clarify_turn_running', '上一轮还没回复');
          const copiedSpecMarkdown = readTextOrUndefined(grill.specPath);
          // The grill moves first: a refusal there leaves the copy as it was.
          // The copied flow is dropped in the same write as the rest; a crash
          // in between leaves a clarifying grill whose next spec drops it.
          hostReviseSpec(runDir, this.now());
          dropCopyPrefill(draft);
          delete draft.specConfirmation;
          this.flowChanged(draft, { nodeBots: true });
          draft.goal = goal;
          pushTurn(draft, { role: 'user', text: goal, at });
          draft.clarify.pending = this.reservationEntry(reservation!);
          return {
            changed: true,
            result: {
              prompt: buildDraftCopyClarifyKickoff({ runId, goal, ...(copiedSpecMarkdown ? { copiedSpecMarkdown } : {}) }),
              title: clip(goal.replace(/\s+/g, ' '), 80),
            },
          };
        }
        // Whether the copied flow still belongs to the requirement being
        // edited: only then does 「只改文字」 carry it over.
        const pinned = this.copyPrefillUsable(grill, draft);
        let spec: Record<string, unknown>;
        try {
          spec = JSON.parse(readFileSync(grill.specJsonPath, 'utf-8')) as Record<string, unknown>;
        } catch (error) {
          throw err('no_spec', `spec.json 读不出来：${errorText(error)}`);
        }
        try {
          validateSpec({ ...spec, requirement: goal });
        } catch (error) {
          throw err('dag_invalid', '改完的需求没有通过校验', { problems: (error as { problems?: string[] }).problems ?? [errorText(error)] });
        }
        const previous = readTextOrUndefined(grill.specPath);
        atomicWriteFileSync(grill.specPath, renderCopySpecMarkdown({ ...spec, requirement: goal } as { title: string; requirement: string }), { mode: 0o600 });
        const finalized = hostSpecFinalize(runDir, this.now());
        if (!finalized.ok) {
          if (previous === undefined) rmSync(grill.specPath, { force: true });
          else atomicWriteFileSync(grill.specPath, previous, { mode: 0o600 });
          throw err('dag_invalid', '改完的需求没有通过校验', { problems: finalized.problems ?? [] });
        }
        this.flowChanged(draft, { nodeBots: true });
        delete draft.specConfirmation;
        draft.goal = goal;
        // Only now that the new requirement is in place: a refused edit keeps
        // the copied flow. A crash before this write leaves a spec the
        // prefill is not pinned to — 「确认需求」 then orchestrates anew.
        if (mode === 'rearchitect' || !pinned) dropCopyPrefill(draft);
        else if (copy.prefill) {
          const specSha256 = fileSha256(grill.specJsonPath);
          if (specSha256) copy.prefill.specSha256 = specSha256;
        }
        if (mode === 'text_only') {
          copy.goalEditedAt = at;
          pushTurn(draft, { role: 'system', text: `目标改为：${clip(goal, 200)}（只改文字，保留复制来的流程）`, at });
        } else {
          pushTurn(draft, { role: 'system', text: `目标改为：${clip(goal, 200)}（确认需求后按新目标重新编排）`, at });
        }
        return { changed: true, result: undefined };
      });
    } catch (error) {
      if (reservation) this.inflight.delete(reservation);
      throw error;
    }
    if (kickoff && reservation) await this.startSession(runId, kickoff.prompt, kickoff.title, reservation);
    return this.view(runId);
  }

  /**
   * 改节点目标 / 完成标准 on a copy at 待确认流程 (§6): a goal node's goal
   * text and its node-specific instructions (`override.systemPromptAppend`,
   * shown as 完成标准与补充要求; empty removes it). Re-validated; the second
   * confirmation is void. Adding or removing nodes and changing dependencies
   * go through 退回改需求 → 重新编排.
   */
  async setNodeText(
    runId: string,
    initiator: WorkflowDraftInitiator,
    nodeId: string,
    input: { goal?: unknown; completion?: unknown; baseVersion?: number },
  ): Promise<WorkflowDraftView> {
    if (input.goal === undefined && input.completion === undefined) throw err('bad_request', '要改 goal 或 completion');
    if (input.goal !== undefined && (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > MAX_GOAL_CHARS)) {
      throw err('bad_request', `goal 必须是 1–${MAX_GOAL_CHARS} 个字符`);
    }
    if (input.completion !== undefined && (typeof input.completion !== 'string' || Buffer.byteLength(input.completion, 'utf-8') > 8000)) {
      throw err('bad_request', 'completion 必须是不超过 8000 字节的文字');
    }
    this.mutate(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill, runDir }) => {
      this.assertCopy(draft, '直接改节点文字');
      this.assertNoLaunch(draft, '改节点');
      this.assertNotArchitecting(runId, draft, grill);
      this.assertStatus(grill, ['dag_ready'], '改节点');
      const dagPath = grill.dagPath;
      if (!dagPath) throw err('state_conflict', '还没有流程图');
      withHostMutationLockSync(runDir, () => {
        if (existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) throw err('state_conflict', 'run 已开始，流程定义不可再改');
        const before = readFileSync(dagPath, 'utf-8');
        const raw = JSON.parse(before) as Record<string, unknown>;
        const node = findGoalNode(raw, nodeId);
        if (!node) throw err('unknown_node', `没有这个任务节点：${nodeId}`);
        if (typeof input.goal === 'string') node.goal = input.goal.trim();
        if (typeof input.completion === 'string') {
          const override = { ...((node.override as Record<string, unknown> | undefined) ?? {}) };
          if (input.completion.trim()) override.systemPromptAppend = input.completion.trim();
          else delete override.systemPromptAppend;
          if (Object.keys(override).length > 0) node.override = override;
          else delete node.override;
        }
        atomicWriteFileSync(dagPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
        try {
          this.loadDag(dagPath);
        } catch (error) {
          atomicWriteFileSync(dagPath, before, { mode: 0o600 });
          throw err('dag_invalid', '改完的流程没有通过校验', { problems: (error as { problems?: string[] }).problems ?? [errorText(error)] });
        }
      });
      this.flowChanged(draft, { nodeBots: false });
      return { changed: true, result: undefined };
    });
    return this.view(runId);
  }

  /**
   * 存为模板 (§5.1) from a draft: only once its second confirmation holds
   * for the flow as it is now; the save re-shows that flow summary and the
   * template version records who confirmed it, when, and the summary.
   * Synchronous under the draft lock; nothing is written.
   */
  private planDraftTemplateSave(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: { flowSummarySha256?: string; paramEdits: ReturnType<typeof parseSavedWorkflowParamEdits> },
  ): { plan: DashboardSavePlan; flowSummary: V3FlowSummary; flowSummarySha256: string } {
    const bots = this.deps.loadBots();
    const nameOf = this.deps.nameOf();
    const actor = { openId: initiator.openId, larkAppId: this.deps.appId };
    return this.mutate(runId, initiator, {}, ({ draft, grill, runDir }) => {
      this.assertNotTemplateRun(draft, '另存为模板');
      this.assertNotArchitecting(runId, draft, grill);
      this.assertStatus(grill, ['dag_ready'], '存为模板');
      let flow: ReturnType<WorkflowDraftService['currentFlow']>;
      try {
        flow = this.currentFlow(runDir, grill, bots, nameOf);
      } catch (error) {
        throw err('dag_invalid', `流程读不出来：${errorText(error)}`);
      }
      const confirmation = draft.flowConfirmation;
      if (!confirmation || !this.confirmationValid(draft, flow)) {
        throw err('flow_changed', '先「确认流程」：只有通过第二道确认的草稿才能存为模板', { flowSummarySha256: flow.flowSummarySha256 });
      }
      if (input.flowSummarySha256 !== undefined && input.flowSummarySha256 !== flow.flowSummarySha256) {
        throw err('flow_changed', '流程在你确认前变了，请看最新的流程摘要再保存', { flowSummarySha256: flow.flowSummarySha256 });
      }
      const spec = validateSpec(JSON.parse(readFileSync(grill.specJsonPath, 'utf-8')) as unknown);
      const snapshots = freezeDagBotSnapshots(flow.dag, bots, { defaultSelector: this.deps.appId });
      let plan: DashboardSavePlan;
      try {
        // A copy of a template keeps its parameters (§6): declared again.
        const inputs = referencedInputs(draft.copy?.inputs as Record<string, SavedWorkflowParamDef> | undefined, flow.dag, spec);
        const built = buildSavedWorkflowRevisionFromFlow({ dag: flow.dag, spec, snapshots }, Object.keys(inputs).length ? { inputs } : {});
        plan = withDashboardParamEdits({
          displayName: built.displayName,
          revision: {
            ...built.revision,
            provenance: {
              kind: 'dashboard_draft',
              draftRunId: runId,
              confirmation: {
                confirmedByOpenId: initiator.openId,
                confirmedAt: this.now().toISOString(),
                flowConfirmedAt: confirmation.confirmedAt,
                flowSummary: flow.flowSummary,
                flowSummarySha256: flow.flowSummarySha256,
              },
            },
          },
          publish: true,
          lintWarnings: built.lintWarnings,
        }, actor, input.paramEdits);
      } catch (error) {
        throw this.mapLibraryError(error);
      }
      return { changed: false, result: { plan, flowSummary: flow.flowSummary, flowSummarySha256: flow.flowSummarySha256 } };
    });
  }

  private async templateSavePreview(
    plan: DashboardSavePlan,
    actor: { openId: string; larkAppId: string },
    workflowId: string | undefined,
    flow: { flowSummary: V3FlowSummary; flowSummarySha256: string },
  ): Promise<WorkflowDraftTemplateSavePreview> {
    let target: WorkflowDraftTemplateSavePreview['target'];
    if (workflowId) {
      try {
        const found = await loadDashboardAppendTarget({ dataDir: this.libraryDir(), workflowId, actor, revision: plan.revision });
        target = {
          workflowId,
          displayName: found.metadata.displayName,
          latestRevision: found.metadata.latestRevision,
          humanVersion: found.latest.payload.humanVersion,
          gateComparisons: found.comparisons,
        };
      } catch (error) {
        throw this.mapLibraryError(error);
      }
    }
    const nodes = plan.revision.dagTemplate.nodes;
    const catalog = await listSavedWorkflowCatalog(this.libraryDir());
    const appendCandidates = catalog.entries
      .filter((entry) => entry.owner.larkAppId === actor.larkAppId && entry.owner.openId === actor.openId && entry.scope.kind === 'global')
      .map((entry) => ({ workflowId: entry.workflowId, displayName: entry.displayName, latestRevision: entry.latestRevision }));
    return {
      appendCandidates,
      dagNodes: nodes,
      displayName: plan.displayName,
      flowSummary: flow.flowSummary,
      flowSummarySha256: flow.flowSummarySha256,
      inputs: plan.revision.inputs,
      nodeCount: nodes.reduce((count, node) => count + 1 + (node.type === 'loop' && node.body ? node.body.nodes.length : 0), 0),
      gateCount: countGates(plan.revision.dagTemplate.nodes),
      lintWarnings: plan.lintWarnings,
      ...(target ? { target } : {}),
    };
  }

  /** The confirm dialog of 「存为模板」: the flow summary again, gates vs the
   *  version appended to (I10), lint warnings. Writes nothing. */
  async previewTemplateSave(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: { workflowId?: unknown; paramEdits?: unknown },
  ): Promise<WorkflowDraftTemplateSavePreview> {
    const workflowId = parseOptionalWorkflowId(input.workflowId);
    let paramEdits: ReturnType<typeof parseSavedWorkflowParamEdits>;
    try { paramEdits = parseSavedWorkflowParamEdits(input.paramEdits); } catch (error) { throw this.mapLibraryError(error); }
    const planned = this.planDraftTemplateSave(runId, initiator, { paramEdits });
    return this.templateSavePreview(planned.plan, { openId: initiator.openId, larkAppId: this.deps.appId }, workflowId, planned);
  }

  /** 「存为模板」: a new global template (owner = the initiator, I9) or a new
   *  version of the initiator's own template. */
  async saveAsTemplate(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: {
      flowSummarySha256: unknown;
      workflowId?: unknown;
      expectedLatestRevision?: unknown;
      displayName?: unknown;
      paramEdits?: unknown;
      requestKey?: unknown;
      acknowledgeUnsafeLiterals?: unknown;
    },
  ): Promise<{ workflowId: string; revisionId: string; humanVersion: number; created: boolean }> {
    const shown = typeof input.flowSummarySha256 === 'string' ? input.flowSummarySha256 : '';
    if (!/^sha256:[0-9a-f]{64}$/.test(shown)) throw err('bad_request', 'flowSummarySha256 必须是保存框里显示的流程摘要哈希');
    const workflowId = parseOptionalWorkflowId(input.workflowId);
    const save = parseSaveTarget(input, workflowId);
    let paramEdits: ReturnType<typeof parseSavedWorkflowParamEdits>;
    try { paramEdits = parseSavedWorkflowParamEdits(input.paramEdits); } catch (error) { throw this.mapLibraryError(error); }
    const actor = { openId: initiator.openId, larkAppId: this.deps.appId };
    const planned = this.planDraftTemplateSave(runId, initiator, { flowSummarySha256: shown, paramEdits });
    if (planned.plan.lintWarnings.length > 0 && input.acknowledgeUnsafeLiterals !== true) {
      throw err('unsafe_literals', '保存的内容里有需要你确认的文字（疑似密钥 / 本机路径 / 群内发消息）', { warnings: planned.plan.lintWarnings });
    }
    try {
      const written = await commitDashboardSave({
        dataDir: this.libraryDir(),
        actor,
        plan: planned.plan,
        ...(workflowId ? { workflowId, ...(save.expectedLatestRevision ? { expectedLatestRevision: save.expectedLatestRevision } : {}) } : {}),
        ...(save.displayName ? { displayName: save.displayName } : {}),
        ...(!workflowId ? { newWorkflowId: dashboardSavedWorkflowId({ sourceKind: 'draft', sourceId: runId, actor, requestKey: save.requestKey }) } : {}),
        ...(workflowId && save.requestKey ? { appendRequest: { sourceKind: 'draft' as const, sourceId: runId, requestKey: save.requestKey } } : {}),
        now: this.now(),
      });
      this.log(`[workflow-draft] saved ${runId} as template ${written.metadata.workflowId} v${written.revision.payload.humanVersion} by ${initiator.openId}`);
      return {
        workflowId: written.metadata.workflowId,
        revisionId: written.revision.revisionId,
        humanVersion: written.revision.payload.humanVersion,
        created: written.created,
      };
    } catch (error) {
      throw this.mapLibraryError(error);
    }
  }

  // ── 存为模板 from a finished run (§5.1, E10) ──

  /** The run's own directory, or unknown_run. Runs of this bot only: the
   *  ownership check (planDashboardRunSave) needs the binding anyway. */
  private finishedRunDir(runId: string): string {
    const runDir = workflowDraftRunDir(this.deps.baseDir, runId);
    if (!runDir || !existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) throw err('unknown_run', `没有这个运行：${runId}`);
    return runDir;
  }

  private planRunSave(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: { allowDraft?: unknown; paramEdits?: unknown },
  ): DashboardSavePlan {
    const runDir = this.finishedRunDir(runId);
    const actor = { openId: initiator.openId, larkAppId: this.deps.appId };
    try {
      const edits = parseSavedWorkflowParamEdits(input.paramEdits);
      return withDashboardParamEdits(planDashboardRunSave({ runDir, actor, allowDraft: input.allowDraft === true }), actor, edits);
    } catch (error) {
      if (error instanceof SavedWorkflowServiceError && error.code === 'source_not_terminal') {
        throw err('state_conflict', '这次运行还没结束，结束后再保存');
      }
      if (error instanceof Error && /cannot publish workflow from a (failed|blocked) run/.test(error.message)) {
        throw err('state_conflict', '这次运行没有成功，只能存成未发布的版本', { needsDraft: true });
      }
      throw this.mapLibraryError(error);
    }
  }

  /** The confirm dialog of 「保存为模板」 on a run: the bots that differ from
   *  the approved flow, gates vs the version appended to (I10), lint. */
  async previewRunSave(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: { workflowId?: unknown; allowDraft?: unknown; paramEdits?: unknown },
  ): Promise<WorkflowDraftTemplateSavePreview & Pick<DashboardSavePlan, 'botChanges' | 'runtimeRevisions' | 'sourceStatus' | 'publish'>> {
    const workflowId = parseOptionalWorkflowId(input.workflowId);
    const plan = this.planRunSave(runId, initiator, input);
    const bots = this.deps.loadBots();
    const nameOf = this.deps.nameOf();
    // The summary of what would be saved, on the same terms as a draft's.
    const dag = { runId: 'saved-template', nodes: plan.revision.dagTemplate.nodes } as V3Dag;
    let flowSummary: V3FlowSummary;
    try {
      const targets = v3BotExecutorTargets(dag, freezeDagBotSnapshots(dag, bots, { defaultSelector: this.deps.appId }));
      flowSummary = buildV3FlowSummary({
        dagNodes: dag.nodes,
        plan: projectV3Gate2BotPlan({ targets, orchestratorAppId: this.deps.appId, nameOf, cliOf: (appId) => bots.find((bot) => bot.larkAppId === appId)?.cliId, reasons: new Map(), assignees: [] }),
      });
    } catch (error) {
      throw err('template_invalid', `模板里的 Bot 在本机找不到：${errorText(error)}`);
    }
    const preview = await this.templateSavePreview(plan, { openId: initiator.openId, larkAppId: this.deps.appId }, workflowId, {
      flowSummary, flowSummarySha256: v3FlowSummarySha256(flowSummary),
    });
    return {
      ...preview,
      ...(plan.botChanges ? { botChanges: plan.botChanges } : {}),
      ...(plan.runtimeRevisions !== undefined ? { runtimeRevisions: plan.runtimeRevisions } : {}),
      ...(plan.sourceStatus ? { sourceStatus: plan.sourceStatus } : {}),
      publish: plan.publish,
    };
  }

  /** 「保存为模板」 on a finished run: only the initiator's own run (I9). */
  async saveRunAsTemplate(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: {
      workflowId?: unknown;
      expectedLatestRevision?: unknown;
      displayName?: unknown;
      paramEdits?: unknown;
      requestKey?: unknown;
      allowDraft?: unknown;
      acknowledgeUnsafeLiterals?: unknown;
    },
  ): Promise<{ workflowId: string; revisionId: string; humanVersion: number; created: boolean; published: boolean }> {
    const workflowId = parseOptionalWorkflowId(input.workflowId);
    const save = parseSaveTarget(input, workflowId);
    const plan = this.planRunSave(runId, initiator, input);
    if (plan.lintWarnings.length > 0 && input.acknowledgeUnsafeLiterals !== true) {
      throw err('unsafe_literals', '保存的内容里有需要你确认的文字（疑似密钥 / 本机路径 / 群内发消息）', { warnings: plan.lintWarnings });
    }
    const actor = { openId: initiator.openId, larkAppId: this.deps.appId };
    try {
      const written = await commitDashboardSave({
        dataDir: this.libraryDir(),
        actor,
        plan,
        ...(workflowId ? { workflowId, ...(save.expectedLatestRevision ? { expectedLatestRevision: save.expectedLatestRevision } : {}) } : {}),
        ...(save.displayName ? { displayName: save.displayName } : {}),
        ...(!workflowId ? { newWorkflowId: dashboardSavedWorkflowId({ sourceKind: 'run', sourceId: runId, actor, requestKey: save.requestKey }) } : {}),
        ...(workflowId && save.requestKey ? { appendRequest: { sourceKind: 'run' as const, sourceId: runId, requestKey: save.requestKey } } : {}),
        now: this.now(),
      });
      this.log(`[workflow-draft] saved run ${runId} as template ${written.metadata.workflowId} v${written.revision.payload.humanVersion} by ${initiator.openId}`);
      return {
        workflowId: written.metadata.workflowId,
        revisionId: written.revision.revisionId,
        humanVersion: written.revision.payload.humanVersion,
        created: written.created,
        published: written.metadata.publishedRevision === written.revision.revisionId,
      };
    } catch (error) {
      throw this.mapLibraryError(error);
    }
  }

  /** One message from the initiator into the clarify session. */
  async sendMessage(runId: string, initiator: WorkflowDraftInitiator, input: { text: unknown; baseVersion?: number }): Promise<WorkflowDraftView> {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) throw err('bad_request', '消息不能为空');
    if (text.length > MAX_MESSAGE_CHARS) throw err('bad_request', `消息最多 ${MAX_MESSAGE_CHARS} 个字符`);
    return this.sendTurn(runId, initiator, { text, display: text, role: 'user', baseVersion: input.baseVersion });
  }

  /** 「继续」(§9): replace a session that cannot be resumed with a new one,
   *  carrying the spec so far and the last turns. */
  async continueClarify(runId: string, initiator: WorkflowDraftInitiator, input: { baseVersion?: number } = {}): Promise<WorkflowDraftView> {
    const reservation = this.reserve();
    let prior: { old: { sessionId?: string; headlessId?: string }; prompt: string; title: string };
    try {
      prior = this.mutate(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill }) => {
        this.assertNoLaunch(draft, '继续对话');
        this.assertNotArchitecting(runId, draft, grill);
        this.assertStatus(grill, ['grilling', 'spec_ready'], '继续对话');
        if (draft.clarify.pending) throw err('clarify_turn_running', '上一轮还没回复');
        if (draft.clarify.sessionId && this.suspending.has(draft.clarify.sessionId)) throw err('busy', '会话正在释放空闲进程，请稍后重试');
        const old = { sessionId: draft.clarify.sessionId, headlessId: draft.clarify.headlessId };
        const specMarkdown = readTextOrUndefined(grill.specPath) ?? draft.clarify.specCandidate?.markdown;
        const prompt = buildDraftClarifyResume({ runId, goal: draft.goal, specMarkdown, turns: draft.clarify.turns });
        // Reserve so a second 「继续」 cannot start a second session.
        draft.clarify.pending = this.reservationEntry(reservation);
        delete draft.clarify.sessionId;
        delete draft.clarify.headlessId;
        return { changed: true, result: { old, prompt, title: clip(draft.goal.replace(/\s+/g, ' '), 80) } };
      });
    } catch (error) {
      this.inflight.delete(reservation);
      throw error;
    }
    await this.closeOrRemember(runId, prior.old);
    await this.startSession(runId, prior.prompt, prior.title, reservation);
    return this.view(runId);
  }

  /**
   * spec 定稿 (§4.3): the latest spec the model wrote, or the person's edited
   * text, through the existing finalize (spec.md → validate → spec.json →
   * spec_ready). On failure nothing changes (spec.md is restored) and the
   * problems come back; with `relayProblems` they also go to the model as
   * the next turn.
   */
  async finalizeSpec(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: { specMarkdown?: unknown; relayProblems?: unknown; baseVersion?: number },
  ): Promise<{ ok: boolean; problems?: string[]; draft: WorkflowDraftView }> {
    if (input.specMarkdown !== undefined && (typeof input.specMarkdown !== 'string' || !input.specMarkdown.trim())) {
      throw err('bad_request', 'specMarkdown 必须是非空字符串');
    }
    const outcome = this.mutate<{ ok: boolean; problems: string[] }>(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill, runDir }) => {
      this.assertNotArchitecting(runId, draft, grill);
      this.assertStatus(grill, ['grilling', 'spec_ready'], 'spec 定稿');
      const markdown = typeof input.specMarkdown === 'string' ? input.specMarkdown : draft.clarify.specCandidate?.markdown;
      if (!markdown) throw err('no_spec', '模型还没有给出 spec');
      const previous = readTextOrUndefined(grill.specPath);
      atomicWriteFileSync(grill.specPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`, { mode: 0o600 });
      const finalized = hostSpecFinalize(runDir, this.now());
      if (!finalized.ok) {
        // A failed re-draft must leave the confirmed-to-be spec as it was:
        // spec.md and spec.json describe the same spec at every gate.
        if (previous === undefined) rmSync(grill.specPath, { force: true });
        else atomicWriteFileSync(grill.specPath, previous, { mode: 0o600 });
        return { changed: false, result: { ok: false, problems: finalized.problems ?? [] } };
      }
      this.flowChanged(draft, { nodeBots: true });
      delete draft.specConfirmation;
      // A spec written in clarifying is a new requirement: a copy's prefilled
      // flow belongs to the one it was copied with (an edit at 待确认需求
      // keeps it — 「只改文字」).
      if (grill.status === 'grilling') dropCopyPrefill(draft);
      return { changed: true, result: { ok: true, problems: [] } };
    });
    if (!outcome.ok && input.relayProblems === true && outcome.problems.length > 0) {
      try {
        await this.sendTurn(runId, initiator, {
          text: buildDraftSpecProblemsTurn(outcome.problems),
          display: `spec 校验没通过，已把问题发给编排 Bot：\n${outcome.problems.map((problem) => `- ${problem}`).join('\n')}`,
          role: 'system',
        });
      } catch (error) {
        this.log(`[workflow-draft] relaying spec problems for ${runId} failed: ${errorText(error)}`);
      }
    }
    return {
      ok: outcome.ok,
      ...(outcome.ok ? {} : { problems: outcome.problems }),
      draft: await this.view(runId),
    };
  }

  /** 第一道确认「确认需求」(§4.3, I6). */
  async approveSpec(runId: string, initiator: WorkflowDraftInitiator, input: { baseVersion?: number } = {}): Promise<WorkflowDraftView> {
    this.mutate(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill, runDir }) => {
      this.assertNotArchitecting(runId, draft, grill);
      this.assertStatus(grill, ['spec_ready'], '确认需求');
      const specSha256 = fileSha256(grill.specJsonPath);
      if (!specSha256) throw err('no_spec', 'spec.json 不存在');
      // Two files: the confirmation record goes first, then the grill moves on.
      // A crash in between leaves 待确认需求 with a stale record that the next
      // approve overwrites; the other order could leave 待编排 with nobody
      // recorded as having confirmed.
      draft.specConfirmation = {
        confirmedByOpenId: initiator.openId,
        confirmedAt: this.now().toISOString(),
        specSha256,
      };
      this.persist(runDir, draft);
      // A copy with its prefilled flow goes straight to 待确认流程 (§6) — for
      // the requirement it was pinned to; a requirement changed since is
      // orchestrated anew.
      const prefilled = this.copyPrefillUsable(grill, draft);
      if (!prefilled && dropCopyPrefill(draft)) this.persist(runDir, draft);
      try {
        if (prefilled) this.applyCopyPrefill(runDir, draft.copy!);
        else hostApproveSpec(runDir, this.now());
      } catch (error) {
        delete draft.specConfirmation;
        this.persist(runDir, draft);
        throw error;
      }
      if (prefilled) {
        this.flowChanged(draft, { nodeBots: true });
        return { changed: true, result: undefined };
      }
      return { changed: false, result: undefined };
    });
    return this.view(runId);
  }

  /**
   * Architect 后台任务 (§4.4, E3): from 待编排 (spec_approved), or as
   * 「重新编排」 from 待确认流程 (dag_ready → revise-dag first) with an optional
   * extra instruction. Returns at once; the page polls the draft.
   */
  async startArchitect(runId: string, initiator: WorkflowDraftInitiator, input: { note?: unknown; baseVersion?: number } = {}): Promise<WorkflowDraftView> {
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.trim().length > MAX_NOTE_CHARS)) {
      throw err('bad_request', `note 必须是不超过 ${MAX_NOTE_CHARS} 个字符的字符串`);
    }
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : undefined;
    const runDir = this.runDirOf(runId);
    this.mutate(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill }) => {
      this.assertNotTemplateRun(draft, '重新编排');
      this.assertNoLaunch(draft, '重新编排');
      this.assertNotArchitecting(runId, draft, grill);
      this.assertStatus(grill, ['spec_approved', 'dag_ready'], '编排');
      if (grill.status === 'dag_ready') hostReviseDag(runDir, this.now());
      this.flowChanged(draft, { nodeBots: true });
      draft.architect = {
        state: 'running',
        attempt: (draft.architect?.attempt ?? 0) + 1,
        startedAt: this.now().toISOString(),
        ...(note ? { note } : {}),
      };
      return { changed: true, result: undefined };
    });
    this.launchArchitect(runId, runDir, note);
    return this.view(runId);
  }

  private launchArchitect(runId: string, runDir: string, note: string | undefined): void {
    const controller = new AbortController();
    const task: ArchitectTask = { controller, cancelled: false, timedOut: false, done: Promise.resolve() };
    this.tasks.set(runId, task);
    const timeoutMs = this.deps.architectTimeoutMs ?? DRAFT_ARCHITECT_TIMEOUT_MS;
    const cancelTimer = this.setTimer(() => {
      task.timedOut = true;
      controller.abort();
    }, timeoutMs);
    task.done = (async () => {
      let ok = false;
      let problems: string[] | undefined;
      try {
        const bots = this.deps.loadBots();
        const nameOf = this.deps.nameOf();
        const roster = await this.plannedRoster(bots, nameOf);
        const grill = readGrillState(runDir);
        if (!grill) throw new Error('grill.state.json 不存在');
        const spec = validateSpec(JSON.parse(readFileSync(grill.specJsonPath, 'utf-8')) as unknown);
        const botAssignment = { roster, assignees: planV3SketchAssignees(spec, roster, bots, nameOf) };
        const botSnapshot = resolveArchitectBotSnapshot(runDir, bots, this.deps.appId);
        const secrets = new Map(bots.map((bot) => [bot.larkAppId, bot.larkAppSecret]));
        // 「重新编排」's instruction rides on a copy of the narrative spec the
        // Architect reads; the confirmed spec.md / spec.json stay untouched.
        let runArchitect = this.deps.runArchitect;
        if (note) {
          const requestPath = join(runDir, 'architect-request.md');
          atomicWriteFileSync(
            requestPath,
            `${readTextOrUndefined(grill.specPath) ?? ''}\n\n## 重新编排说明（发起人补充）\n\n${note}\n`,
            { mode: 0o600 },
          );
          const inner = runArchitect;
          runArchitect = (architectInput) => inner({ ...architectInput, specPath: requestPath });
        }
        if (controller.signal.aborted) throw new Error('编排已取消');
        const outcome = await hostArchitect(runDir, {
          runArchitect,
          loadDag: this.loadDag,
          botSnapshot,
          resolveLarkAppSecret: (id) => secrets.get(id),
          timeoutMs,
          cancelSignal: controller.signal,
          botAssignment,
        }, this.now());
        ok = outcome.ok;
        problems = outcome.problems;
      } catch (error) {
        problems = [errorText(error)];
        this.retreatIfStuck(runDir, problems);
      } finally {
        cancelTimer();
      }
      const state = ok ? 'succeeded' : task.timedOut ? 'timed_out' : task.cancelled ? 'cancelled' : 'failed';
      const why = state === 'timed_out'
        ? [`编排超时（${Math.round(timeoutMs / 60_000)} 分钟）`, ...(problems ?? [])]
        : state === 'cancelled' ? ['编排已取消'] : problems;
      // The task stays registered until its outcome is recorded, so no write
      // in between mistakes it for a lost one. Recording is tried with the
      // problems, then without them; if both fail, the next write or read
      // finds 编排中 with no task and heals it to 编排中断.
      const record = (problemsToKeep: string[] | undefined) => this.mutate(runId, undefined, { allowAbandoned: true }, ({ draft }) => {
        if (draft.architect?.state !== 'running') return { changed: false, result: undefined };
        const { problems: _old, ...rest } = draft.architect;
        draft.architect = {
          ...rest,
          state,
          finishedAt: this.now().toISOString(),
          ...(problemsToKeep && problemsToKeep.length > 0 && !ok ? { problems: problemsToKeep } : {}),
        };
        if (ok) this.flowChanged(draft, { nodeBots: true });
        return { changed: true, result: undefined };
      });
      try {
        try {
          record(why?.map((problem) => clip(problem, 4000)).slice(0, 200));
        } catch (error) {
          this.log(`[workflow-draft] recording architect outcome for ${runId} failed, retrying without details: ${errorText(error).slice(0, 300)}`);
          record(ok ? undefined : ['编排失败，详细原因没能记录']);
        }
      } catch (error) {
        this.log(`[workflow-draft] recording architect outcome for ${runId} failed: ${errorText(error).slice(0, 300)}`);
      } finally {
        this.tasks.delete(runId);
      }
      this.log(`[workflow-draft] architect ${runId} → ${state}`);
    })();
  }

  /** A grill left in architect_running by a failure outside hostArchitect's
   *  own retreat goes back to 待编排 (spec_approved). */
  private retreatIfStuck(runDir: string, problems: string[]): void {
    try {
      withHostMutationLockSync(runDir, () => {
        if (readGrillState(runDir)?.status !== 'architect_running') return;
        if (existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) return;
        transition(runDir, 'spec_approved', { problems }, this.now());
      });
    } catch (error) {
      this.log(`[workflow-draft] retreat ${runDir} failed: ${errorText(error)}`);
    }
  }

  /** 取消编排. The worker is aborted; hostArchitect retreats to 待编排. */
  async cancelArchitect(runId: string, initiator: WorkflowDraftInitiator): Promise<WorkflowDraftView> {
    this.mutate(runId, initiator, {}, ({ draft, healed }) => {
      const task = this.tasks.get(runId);
      // A lost run was just healed to 编排中断: the cancel has its effect.
      if (healed) return { changed: true, result: undefined };
      if (!task || draft.architect?.state !== 'running') throw err('state_conflict', '当前没有在编排');
      task.cancelled = true;
      task.controller.abort();
      return { changed: false, result: undefined };
    });
    return this.view(runId);
  }

  /** The Architect roster for a planned topic group (§4.4, E4). */
  private plannedRoster(bots: BotConfig[], nameOf: (larkAppId: string) => string): Promise<V3BotRoster> {
    return buildV3BotRoster({
      orchestratorAppId: this.deps.appId,
      bots,
      probe: plannedGroupProbe(bots, this.deps.isDaemonOnline),
      nameOf,
      ...(this.deps.roleOf ? { roleOf: this.deps.roleOf() } : {}),
    });
  }

  /**
   * 换执行 Bot (§4.4, E5): only a roster bot; written back into the DAG,
   * re-validated, and the second confirmation is void. A named bot that is
   * now not honoured shows as ⚠️ in the plan / flow summary.
   */
  async setNodeBot(
    runId: string,
    initiator: WorkflowDraftInitiator,
    nodeId: string,
    input: { larkAppId: unknown; baseVersion?: number },
  ): Promise<WorkflowDraftView> {
    const larkAppId = typeof input.larkAppId === 'string' ? input.larkAppId.trim() : '';
    if (!larkAppId) throw err('bad_request', 'larkAppId 不能为空');
    const bots = this.deps.loadBots();
    const roster = await this.plannedRoster(bots, this.deps.nameOf());
    if (!roster.bots.some((bot) => bot.larkAppId === larkAppId)) {
      const excluded = roster.excluded.find((entry) => entry.larkAppId === larkAppId);
      throw err('bot_not_on_roster', excluded ? `${excluded.name}：${excluded.why}` : '这个 Bot 不在可用名单里', {
        ...(excluded ? { why: excluded.why } : {}),
      });
    }
    const stale = this.mutate(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill, runDir }) => {
      this.assertNotArchitecting(runId, draft, grill);
      this.assertStatus(grill, ['dag_ready'], '换执行 Bot');
      // A swapped bot makes a template run an ad-hoc one (复制后启动, §5.3):
      // its `${params.…}` markers would have nothing to resolve them.
      if (draft.template?.hasInputs) {
        throw err('template_run', '这个模板带参数，不能直接换执行 Bot；请先「复制为新工作流」再改');
      }
      const dagPath = grill.dagPath;
      if (!dagPath) throw err('state_conflict', '还没有流程图');
      withHostMutationLockSync(runDir, () => {
        if (existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) throw err('state_conflict', 'run 已开始，流程定义不可再改');
        const before = readFileSync(dagPath, 'utf-8');
        const raw = JSON.parse(before) as Record<string, unknown>;
        const node = findGoalNode(raw, nodeId);
        if (!node) throw err('unknown_node', `没有这个任务节点：${nodeId}`);
        const previous = (typeof node.bot === 'string' ? node.bot : undefined) ?? this.deps.appId;
        node.bot = larkAppId;
        atomicWriteFileSync(dagPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
        let problems: string[];
        try {
          const dag = this.loadDag(dagPath) as V3Dag;
          // A copy may still have other nodes waiting for a new bot: they do
          // not block this swap (「确认流程」 waits for them instead).
          problems = draft.copy ? [] : v3RosterSelectorProblems(dag, roster);
          freezeDagBotSnapshots(dag, bots, { defaultSelector: this.deps.appId });
        } catch (error) {
          problems = (error as { problems?: string[] }).problems ?? [errorText(error)];
        }
        if (problems.length > 0) {
          atomicWriteFileSync(dagPath, before, { mode: 0o600 });
          throw err('dag_invalid', '换完的流程没有通过校验', { problems });
        }
        const earlier = draft.nodeBots?.[nodeId]?.previousLarkAppId ?? previous;
        draft.nodeBots = {
          ...(draft.nodeBots ?? {}),
          [nodeId]: {
            larkAppId,
            ...(earlier !== larkAppId ? { previousLarkAppId: earlier } : {}),
            at: this.now().toISOString(),
          },
        };
      });
      this.flowChanged(draft, { nodeBots: false });
      // §4.5 第 6 步: a bot swapped out of a launched group keeps no grant
      // there. The revoke runs outside the lock, so it holds the launch
      // (a token, as a step does): a concurrent 「继续」 or another swap is
      // refused as launch_running instead of interleaving with it.
      const launch = draft.launch;
      if (!launch?.chat || !launch.grants || !this.deps.launch) return { changed: true, result: undefined };
      const wanted = this.launchFlow(runDir, readGrillState(runDir) ?? grill).botTargets;
      if (!Object.keys(launch.grants).some((appId) => !wanted.includes(appId))) return { changed: true, result: undefined };
      const token = this.reserveLaunch();
      launch.state = 'running';
      launch.token = token;
      launch.updatedAt = this.now().toISOString();
      return { changed: true, result: { token, chatId: launch.chat.chatId } };
    });
    if (stale) {
      try {
        const failed = await this.revokeStaleLaunchGrants(runId, stale.token, stale.chatId);
        if (failed) this.log(`[workflow-draft] ${failed} (retried at 「继续」)`);
      } catch (error) {
        this.log(`[workflow-draft] revoking swapped-out grants of ${runId} failed: ${errorText(error)}`);
      } finally {
        this.launchTokens.delete(stale.token);
        try {
          this.launchTx(runId, stale.token, ({ launch }) => {
            launch.state = 'paused';
            delete launch.token;
            return { changed: true, result: undefined };
          });
        } catch { /* a dead token is taken over by 「继续」 */ }
      }
    }
    return this.view(runId);
  }

  /** The flow facts of the current DAG, synchronously (no roster). */
  private currentFlow(runDir: string, grill: GrillState, bots: BotConfig[], nameOf: (larkAppId: string) => string): {
    dag: V3Dag; dagSha256: string; specSha256: string; targets: V3NodeExecutorTarget[]; flowSummary: V3FlowSummary; flowSummarySha256: string;
  } {
    if (!grill.dagPath) throw new Error('还没有流程图');
    const dag = this.loadDag(grill.dagPath) as V3Dag;
    const dagSha256 = fileSha256(grill.dagPath);
    const specSha256 = fileSha256(grill.specJsonPath);
    if (!dagSha256 || !specSha256) throw new Error('流程图或 spec 读不到');
    const snapshots = freezeDagBotSnapshots(dag, bots, { defaultSelector: this.deps.appId });
    const targets = v3BotExecutorTargets(dag, snapshots);
    const flowSummary = adHocFlowSummary({ runDir, dag, targets, orchestratorAppId: this.deps.appId, bots, nameOf });
    return { dag, dagSha256, specSha256, targets, flowSummary, flowSummarySha256: v3FlowSummarySha256(flowSummary) };
  }

  /**
   * 第二道确认「确认流程」(§4.4, I6): the page sends the flow-summary digest
   * it showed; the record pins that summary, its digest, and the dag/spec
   * digests (the summary has no topology). Already confirmed → 409.
   */
  async approveFlow(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: { flowSummarySha256: unknown; baseVersion?: number },
  ): Promise<WorkflowDraftView> {
    const shown = typeof input.flowSummarySha256 === 'string' ? input.flowSummarySha256 : '';
    if (!/^sha256:[0-9a-f]{64}$/.test(shown)) throw err('bad_request', 'flowSummarySha256 必须是页面显示的流程摘要哈希');
    const bots = this.deps.loadBots();
    const nameOf = this.deps.nameOf();
    const roster = await this.plannedRoster(bots, nameOf);
    this.mutate(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill, runDir }) => {
      this.assertNotArchitecting(runId, draft, grill);
      this.assertStatus(grill, ['dag_ready'], '确认流程');
      // A copy's nodes whose bot cannot run them are swapped first (§6).
      const outstanding = this.outstandingCopyBots(draft, roster);
      if (outstanding.length > 0) {
        throw err('bot_not_on_roster', `先给这些节点换执行 Bot：${outstanding.map((item) => `${item.nodeId}（${item.why}）`).join('、')}`, { nodes: outstanding });
      }
      let flow: ReturnType<WorkflowDraftService['currentFlow']>;
      try {
        flow = this.currentFlow(runDir, grill, bots, nameOf);
      } catch (error) {
        throw err('dag_invalid', `流程读不出来：${errorText(error)}`);
      }
      if (draft.flowConfirmation && this.confirmationValid(draft, flow)) {
        throw err('already_confirmed', '流程已经确认过了', { flowConfirmation: draft.flowConfirmation });
      }
      if (flow.flowSummarySha256 !== shown) {
        throw err('flow_changed', '流程在你确认前变了，请看最新的流程后再确认', { flowSummarySha256: flow.flowSummarySha256 });
      }
      draft.flowConfirmation = {
        confirmedByOpenId: initiator.openId,
        confirmedAt: this.now().toISOString(),
        flowSummary: flow.flowSummary,
        flowSummarySha256: flow.flowSummarySha256,
        dagSha256: flow.dagSha256,
        specSha256: flow.specSha256,
        flowRevision: draft.flowRevision ?? 0,
      };
      return { changed: true, result: undefined };
    });
    return this.view(runId);
  }

  private confirmationValid(draft: WorkflowDraftRecord, flow: { dagSha256: string; specSha256: string; flowSummarySha256: string }): boolean {
    const confirmation = draft.flowConfirmation;
    return !!confirmation
      && confirmation.flowRevision === (draft.flowRevision ?? 0)
      && confirmation.flowSummarySha256 === flow.flowSummarySha256
      && confirmation.dagSha256 === flow.dagSha256
      && confirmation.specSha256 === flow.specSha256;
  }

  /** 「退回改需求」(§4.3/§4.4): back to the clarify panel; both confirmations
   *  and the DAG are void. */
  async reviseSpec(runId: string, initiator: WorkflowDraftInitiator, input: { baseVersion?: number } = {}): Promise<WorkflowDraftView> {
    this.mutate(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill, runDir }) => {
      this.assertNotTemplateRun(draft, '退回改需求');
      this.assertNoLaunch(draft, '退回改需求');
      this.assertNotArchitecting(runId, draft, grill);
      this.assertStatus(grill, ['spec_ready', 'spec_approved', 'dag_ready'], '退回改需求');
      hostReviseSpec(runDir, this.now());
      // A copy's prefilled flow is for the requirement it was copied with: a
      // revised requirement is orchestrated anew (§6). Dropped after the grill
      // moved (a refusal keeps it); a crash in between leaves a clarifying
      // grill whose next spec drops it.
      dropCopyPrefill(draft);
      delete draft.specConfirmation;
      this.flowChanged(draft, { nodeBots: true });
      return { changed: true, result: undefined };
    });
    return this.view(runId);
  }

  /**
   * 放弃: the draft stays (listed as 已放弃); a running Architect is
   * aborted; the clarify session is closed and its record deleted.
   *
   * With a launch (§4.5): refused while it runs (launch_running) and once
   * run.json is written (run_committed, from loadLocked — only 「继续」 to
   * start remains). An
   * existing group is kept; its root card is updated to say 「这次启动已放弃」;
   * a clarify session already moved into the main topic is that topic's and
   * stays. A root card that could not be updated is retried by the next
   * 「放弃」 (which is then accepted on the abandoned draft for that alone).
   */
  async abandon(runId: string, initiator: WorkflowDraftInitiator): Promise<WorkflowDraftView> {
    const outcome = this.mutate(runId, initiator, { allowAbandoned: true }, ({ draft }) => {
      if (draft.abandonedAt) {
        // Only an abandoned launch whose root card does not say so yet.
        if (draft.launch?.root && !draft.launch.root.abandonNoted) return { changed: false, result: { old: {}, note: true } };
        throw err('draft_abandoned', '这个草稿已放弃');
      }
      const task = this.tasks.get(runId);
      if (task) {
        task.cancelled = true;
        task.controller.abort();
      }
      const at = this.now().toISOString();
      draft.abandonedAt = at;
      if (draft.launch) {
        draft.launch.state = 'abandoned';
        draft.launch.abandonedAt = at;
        draft.launch.updatedAt = at;
        delete draft.launch.token;
      }
      if (clarifySessionInTopic(draft)) return { changed: true, result: { old: {}, note: !!draft.launch?.root } };
      const old = { sessionId: draft.clarify.sessionId, headlessId: draft.clarify.headlessId };
      draft.clarify.state = 'closed';
      delete draft.clarify.pending;
      delete draft.clarify.sessionId;
      delete draft.clarify.headlessId;
      return { changed: true, result: { old, note: !!draft.launch?.root } };
    });
    await this.closeOrRemember(runId, outcome.old);
    if (outcome.note) await this.noteRootAbandoned(runId);
    return this.view(runId);
  }

  /**
   * 删除 (§4.6): an abandoned draft, or one without activity for 30 days.
   * Three steps, each safe to repeat: mark deletedAt (from here no other write
   * succeeds and the draft is not listed), close the clarify sessions, and
   * only then remove the run dir. A crash or a refused close after the mark
   * leaves a marked dir that the next delete, the boot recovery or the sweep
   * finishes.
   */
  async delete(runId: string, initiator: WorkflowDraftInitiator): Promise<void> {
    const deletable = (draft: WorkflowDraftRecord, grill: GrillState) => {
      this.assertNotArchitecting(runId, draft, grill);
      const last = Math.max(Date.parse(draft.updatedAt), Date.parse(grill.updatedAt));
      if (!draft.abandonedAt && this.now().getTime() - last < WORKFLOW_DRAFT_STALE_MS) {
        throw err('draft_not_stale', '只能删除已放弃或 30 天没有动静的草稿');
      }
    };
    // A launch that posted its root card: the card says 「这次启动已放弃」
    // before the record goes (the group stays; §4.5). Not updatable → not
    // deleted, retry later.
    // Every other precondition is checked first; a stale launch that was
    // not abandoned is abandoned on the way (so the card and the record never
    // disagree), and neither write counts as activity.
    const needsNote = this.mutate(runId, initiator, { allowAbandoned: true, allowDeleted: true, keepUpdatedAt: true }, ({ draft, grill }) => {
      if (draft.deletedAt) return { changed: false, result: false };
      deletable(draft, grill);
      if (!draft.launch?.root || draft.launch.root.abandonNoted) return { changed: false, result: false };
      if (!draft.abandonedAt) {
        const at = this.now().toISOString();
        draft.abandonedAt = at;
        draft.launch.state = 'abandoned';
        draft.launch.abandonedAt = at;
        delete draft.launch.token;
        return { changed: true, result: true };
      }
      return { changed: false, result: true };
    });
    if (needsNote) await this.noteRootAbandoned(runId);
    const sessions = this.mutate(runId, initiator, { allowAbandoned: true, allowDeleted: true }, ({ draft, grill }) => {
      if (!draft.deletedAt) {
        deletable(draft, grill);
        if (draft.launch?.root && !draft.launch.root.abandonNoted) {
          throw err('root_update_failed', '主话题卡片没能改成「已放弃」，草稿先不删，请稍后重试');
        }
        draft.deletedAt = this.now().toISOString();
      }
      const out = draftSessions(draft);
      draft.clarify.state = 'closed';
      delete draft.clarify.pending;
      return { changed: true, result: out };
    });
    await this.finishDelete(runId, this.runDirOf(runId), sessions);
  }

  /**
   * Steps 2 and 3 of a delete: close every session the draft knows of, and
   * only once all are closed remove the run dir. A close that fails is
   * written to the marked draft's orphanSessions and the dir stays — the
   * marked dir is what lets the sweep / the next boot find and retry it.
   */
  private async finishDelete(runId: string, runDir: string, sessions: Array<{ sessionId: string; headlessId?: string }>): Promise<boolean> {
    let allClosed = true;
    for (const session of sessions) {
      if (!(await this.closeOrRemember(runId, session))) allClosed = false;
    }
    if (!allClosed) {
      this.log(`[workflow-draft] delete of ${runId} waits for its clarify sessions to close`);
      return false;
    }
    if (!existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
    for (const session of sessions) this.orphans.delete(session.sessionId);
    this.log(`[workflow-draft] deleted ${runId}`);
    return true;
  }

  /** Marked-deleted drafts of this bot whose dir is still there (a delete
   *  interrupted after its first step). */
  private interruptedDeletes(): Array<{ runId: string; runDir: string; sessions: Array<{ sessionId: string; headlessId?: string }> }> {
    const out: Array<{ runId: string; runDir: string; sessions: Array<{ sessionId: string; headlessId?: string }> }> = [];
    for (const { runId, runDir } of listWorkflowDraftDirs(this.deps.baseDir)) {
      const draft = readWorkflowDraft(runDir);
      if (!draft?.deletedAt || draft.orchestratorAppId !== this.deps.appId || draft.runId !== runId) continue;
      out.push({ runId, runDir, sessions: draftSessions(draft) });
    }
    return out;
  }

  // ── 拉群开始 (§4.5, D4) ──

  private requireLaunchDeps(): DraftLaunchDeps {
    if (!this.deps.launch) throw err('launch_unavailable', '这个 daemon 不支持拉群开始');
    return this.deps.launch;
  }

  private reserveLaunch(): string {
    const token = `launch:${randomUUID()}`;
    this.launchTokens.add(token);
    return token;
  }

  /** The current flow, and the second confirmation must hold for it — all
   *  four pins: flow summary, DAG bytes, spec bytes, flow revision. */
  private assertFlowConfirmed(
    runDir: string,
    draft: WorkflowDraftRecord,
    grill: GrillState,
    bots: BotConfig[],
    nameOf: (larkAppId: string) => string,
  ): ReturnType<WorkflowDraftService['currentFlow']> {
    this.assertStatus(grill, ['dag_ready'], '拉群开始');
    let flow: ReturnType<WorkflowDraftService['currentFlow']>;
    try {
      flow = this.currentFlow(runDir, grill, bots, nameOf);
    } catch (error) {
      throw err('dag_invalid', `流程读不出来：${errorText(error)}`);
    }
    if (!this.flowReady(draft, flow)) {
      throw err('flow_changed', '流程还没确认，或确认后又改过：请先「确认流程」', { flowSummarySha256: flow.flowSummarySha256 });
    }
    return flow;
  }

  /**
   * 「拉群开始」(§4.5, I6): record the intent (step 1), then run the steps
   * in the background (the page polls). Only from 已确认流程; once a launch
   * exists, 「继续」 resumes it.
   */
  async launch(
    runId: string,
    initiator: WorkflowDraftInitiator,
    input: { groupName?: unknown; extraMembers?: unknown; baseVersion?: number } = {},
  ): Promise<WorkflowDraftView> {
    this.requireLaunchDeps();
    if (input.groupName !== undefined
      && (typeof input.groupName !== 'string' || !input.groupName.trim() || Array.from(input.groupName.trim()).length > 100)) {
      throw err('bad_request', 'groupName 必须是 1–100 个字符的字符串');
    }
    const members = parseLaunchExtraMembers(input.extraMembers, WORKFLOW_LAUNCH_MAX_EXTRA_MEMBERS);
    if (!members.ok) throw err('bad_request', members.message, { reason: members.reason, ...(members.item ? { item: members.item } : {}) });
    const bots = this.deps.loadBots();
    const nameOf = this.deps.nameOf();
    const token = this.reserveLaunch();
    try {
      // `launched`: a second 「拉群开始」 after the start still answers launch_exists.
      this.mutate(runId, initiator, { baseVersion: input.baseVersion, launchOp: true, launched: true }, ({ draft, grill, runDir }) => {
        if (draft.launch) throw err('launch_exists', '已经开始拉群了，点「继续」从中断处接着做');
        if (this.launchRunning(draft)) throw err('launch_running', '正在拉群');
        // The idle sweep is releasing this session's process right now: the
        // move into the main topic would race it.
        if (draft.clarify.sessionId && this.suspending.has(draft.clarify.sessionId)) throw err('busy', '会话正在释放空闲进程，请稍后重试');
        this.assertNotArchitecting(runId, draft, grill);
        const confirmed = this.assertFlowConfirmed(runDir, draft, grill, bots, nameOf);
        if (draft.copy) {
          // A copy commits as an ad-hoc run: nothing resolves a template's
          // parameters there (§6: 参数保留为参数).
          let specJson: unknown;
          try { specJson = JSON.parse(readFileSync(grill.specJsonPath, 'utf-8')) as unknown; } catch { specJson = undefined; }
          const left = unresolvedFlowMarkers(confirmed.dag.nodes, specJson);
          if (left.params.length || left.context.length) {
            throw err('unresolved_params', '流程里还有参数没换成具体内容：先「存为模板」再带参数运行，或把这些参数改成具体文字', left);
          }
        }
        const marker = launchMarker(runId);
        if (!marker) throw err('state_conflict', `runId ${runId} 没有随机段，无法给群名加标记`);
        // I7: the platform login joins by union_id, a local login as the bot
        // owner by its open_id in this app — never both, never a guess.
        if (draft.initiator.source === 'dashboard-platform' && !draft.initiator.unionId) {
          throw err('initiator_channel_unavailable', '平台登录没有带 union_id，无法把发起人拉进群');
        }
        const at = this.now().toISOString();
        const title = typeof input.groupName === 'string' ? input.groupName.trim() : this.titleOf(draft, grill);
        draft.launch = {
          attempt: 1,
          state: 'running',
          token,
          startedAt: at,
          updatedAt: at,
          groupName: launchGroupName(title, marker),
          marker,
          extraMembers: members.members,
          ownerChannel: draft.initiator.source === 'dashboard-platform' ? 'union_id' : 'open_id',
        };
        return { changed: true, result: undefined };
      });
    } catch (error) {
      this.launchTokens.delete(token);
      throw error;
    }
    this.log(`[workflow-draft] launch ${runId} by ${initiator.openId} (${initiator.source})`);
    // In the background, like the Architect: the page polls the draft.
    void this.driveLaunch(runId, token);
    return this.view(runId);
  }

  /**
   * 「继续」(§4.5 断点续做): resume a launch from what its record says. A
   * launch left 拉群中 by an earlier daemon process is resumed only here,
   * never by itself. Before run.json the second confirmation must hold again
   * (a bot swapped at step 5 voids it: 「确认流程」 first).
   */
  async continueLaunch(runId: string, initiator: WorkflowDraftInitiator, input: { baseVersion?: number } = {}): Promise<WorkflowDraftView> {
    this.requireLaunchDeps();
    const bots = this.deps.loadBots();
    const nameOf = this.deps.nameOf();
    const token = this.reserveLaunch();
    let go: boolean;
    try {
      go = this.mutate(runId, initiator, { baseVersion: input.baseVersion, launchOp: true, launched: true }, ({ draft, grill, runDir }) => {
        const launch = draft.launch;
        if (!launch) throw err('no_launch', '还没有开始拉群');
        if (launch.state === 'started') return { changed: false, result: false };
        if (this.launchRunning(draft)) throw err('launch_running', '正在拉群，等这一步结束');
        if (launch.start) {
          // Started earlier; a later operation died holding it.
          launch.state = 'started';
          delete launch.token;
          delete launch.error;
          return { changed: true, result: false };
        }
        if (!launch.commit && !existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) {
          this.assertNotArchitecting(runId, draft, grill);
          this.assertFlowConfirmed(runDir, draft, grill, bots, nameOf);
        }
        launch.state = 'running';
        launch.token = token;
        launch.attempt += 1;
        launch.updatedAt = this.now().toISOString();
        delete launch.error;
        return { changed: true, result: true };
      });
    } catch (error) {
      this.launchTokens.delete(token);
      throw error;
    }
    if (go) void this.driveLaunch(runId, token);
    else this.launchTokens.delete(token);
    return this.view(runId);
  }

  /** 「放弃」 of a launch: the draft's abandon (keeps the group, notes it on
   *  the root card). */
  async abandonLaunch(runId: string, initiator: WorkflowDraftInitiator): Promise<WorkflowDraftView> {
    this.mutate(runId, initiator, { allowAbandoned: true, launchOp: true }, ({ draft }) => {
      if (!draft.launch) throw err('no_launch', '还没有开始拉群');
      return { changed: false, result: undefined };
    });
    return this.abandon(runId, initiator);
  }

  private titleOf(draft: WorkflowDraftRecord, grill: GrillState): string {
    const spec = this.specFacts(grill);
    return spec?.title ?? draft.goal.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  private specFacts(grill: GrillState): { title?: string; requirement?: string; nodes: Array<{ id: string; goal: string }> } | undefined {
    try {
      const spec = JSON.parse(readFileSync(grill.specJsonPath, 'utf-8')) as {
        title?: unknown; requirement?: unknown; nodes?: Array<{ sketchId?: unknown; goal?: unknown }>;
      };
      return {
        ...(typeof spec.title === 'string' && spec.title.trim() ? { title: spec.title.trim().slice(0, 200) } : {}),
        ...(typeof spec.requirement === 'string' && spec.requirement.trim() ? { requirement: spec.requirement.trim().slice(0, 2000) } : {}),
        nodes: (Array.isArray(spec.nodes) ? spec.nodes : [])
          .filter((node) => typeof node?.sketchId === 'string' && typeof node.goal === 'string')
          .slice(0, 50)
          .map((node) => ({ id: node.sketchId as string, goal: (node.goal as string).slice(0, 500) })),
      };
    } catch {
      return undefined;
    }
  }

  /** One launch transaction, only while `token` still holds the launch. */
  private launchTx<T>(
    runId: string,
    token: string,
    fn: (ctx: { runDir: string; draft: WorkflowDraftRecord; launch: WorkflowDraftLaunch; grill: GrillState }) => { changed: boolean; result: T },
  ): { held: true; result: T } | { held: false } {
    return this.mutate<{ held: true; result: T } | { held: false }>(runId, undefined, { launchOp: true, launched: true }, ({ runDir, draft, grill }) => {
      const launch = draft.launch;
      if (!launch || launch.state !== 'running' || launch.token !== token) return { changed: false, result: { held: false } };
      const out = fn({ runDir, draft, launch, grill });
      if (out.changed) launch.updatedAt = this.now().toISOString();
      return { changed: out.changed, result: { held: true, result: out.result } };
    });
  }

  /** Stop at `step` (state 拉群中, 「继续」 resumes), recording why. */
  private stopLaunch(
    runId: string,
    token: string,
    stop: { step: NonNullable<WorkflowDraftLaunch['error']>['step']; code: string; message: string; retryable: boolean },
    patch?: (launch: WorkflowDraftLaunch, draft: WorkflowDraftRecord) => void,
  ): void {
    try {
      this.launchTx(runId, token, ({ launch, draft }) => {
        patch?.(launch, draft);
        launch.state = 'paused';
        delete launch.token;
        launch.error = { ...stop, message: clip(stop.message, 4000), at: this.now().toISOString() };
        return { changed: true, result: undefined };
      });
    } catch (error) {
      // The token is released below; the record stays 拉群中 with a dead
      // token, which 「继续」 takes over.
      this.log(`[workflow-draft] recording launch stop of ${runId} failed: ${errorText(error)}`);
    }
    this.log(`[workflow-draft] launch ${runId} stopped at ${stop.step}: ${stop.code}`);
  }

  /** The flow facts a launch step needs (before run.json). */
  private launchFlow(runDir: string, grill: GrillState): { targets: V3NodeExecutorTarget[]; botTargets: string[] } {
    const bots = this.deps.loadBots();
    const flow = this.currentFlow(runDir, grill, bots, this.deps.nameOf());
    return {
      targets: flow.targets,
      botTargets: [...new Set(flow.targets.map((target) => target.larkAppId).filter((appId) => appId !== this.deps.appId))],
    };
  }

  /** Where the launch held by `token` is; undefined once it is not held. */
  private launchStepOf(runId: string, token: string): LaunchStep | undefined {
    const out = this.launchTx(runId, token, ({ runDir, draft, launch, grill }) => {
      if (launch.commit || existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) {
        return { changed: false, result: launch.commit ? nextLaunchStep(launch, { flowRevision: 0, targets: [] }) : 'commit' as LaunchStep };
      }
      const flow = this.launchFlow(runDir, grill);
      return { changed: false, result: nextLaunchStep(launch, { flowRevision: draft.flowRevision ?? 0, targets: flow.botTargets }) };
    });
    return out.held ? out.result : undefined;
  }

  private async driveLaunch(runId: string, token: string): Promise<void> {
    try {
      for (let round = 0; round < 16; round += 1) {
        let step: LaunchStep | undefined;
        try {
          step = this.launchStepOf(runId, token);
        } catch (error) {
          this.stopLaunch(runId, token, { step: 'interrupted', code: 'flow_unreadable', message: `流程读不出来：${errorText(error)}`, retryable: true });
          return;
        }
        if (!step || step === 'done') return;
        if (!await this.runLaunchStep(runId, token, step)) return;
      }
      this.stopLaunch(runId, token, { step: 'interrupted', code: 'launch_loop', message: '拉群步骤没有推进，请点「继续」重试', retryable: true });
    } catch (error) {
      this.log(`[workflow-draft] launch ${runId} failed: ${errorText(error)}`);
      this.stopLaunch(runId, token, { step: 'interrupted', code: 'internal_error', message: errorText(error), retryable: true });
    } finally {
      this.launchTokens.delete(token);
      try {
        // Whatever ended the run of steps without a recorded stop leaves 拉群中
        // resumable, never held by a token nobody owns.
        this.launchTx(runId, token, ({ launch }) => {
          launch.state = 'paused';
          delete launch.token;
          return { changed: true, result: undefined };
        });
      } catch { /* a dead token is taken over by 「继续」 */ }
    }
  }

  /** One step; true when the next one may follow. */
  private async runLaunchStep(runId: string, token: string, step: LaunchStep): Promise<boolean> {
    switch (step) {
      case 'group': return this.launchGroupStep(runId, token);
      case 'join': return this.launchJoinStep(runId, token);
      case 'root': return this.launchRootStep(runId, token);
      case 'summary': return this.launchSummaryStep(runId, token);
      case 'migrate': return this.launchMigrateStep(runId, token);
      case 'check': return this.launchCheckStep(runId, token);
      case 'grant': return this.launchGrantStep(runId, token);
      case 'commit': return this.launchCommitStep(runId, token);
      case 'start': return this.launchStartStep(runId, token);
      case 'done': return false;
    }
  }

  /** Record the group (first one wins; a different one is a suspect). */
  private recordLaunchChat(runId: string, token: string, chat: {
    chatId: string; recovered?: boolean; shareLink?: string; warnings?: string[];
    initiator?: 'joined' | 'rejected'; ownerTransferError?: string;
  }): void {
    this.launchTx(runId, token, ({ launch }) => {
      const at = this.now().toISOString();
      const facts = {
        ...(chat.initiator ? { initiator: chat.initiator } : {}),
        ...(chat.ownerTransferError ? { ownerTransferError: clip(chat.ownerTransferError, 2000) } : {}),
      };
      if (!launch.chat) {
        launch.chat = {
          chatId: chat.chatId,
          at,
          ...(chat.recovered ? { recovered: true as const } : {}),
          ...(chat.shareLink ? { shareLink: chat.shareLink.slice(0, 2000) } : {}),
          ...(chat.warnings?.length ? { warnings: chat.warnings.slice(0, 20).map((w) => clip(w, 2000)) } : {}),
          ...facts,
        };
        return { changed: true, result: undefined };
      }
      if (launch.chat.chatId !== chat.chatId) {
        launch.orphanSuspects = [...(launch.orphanSuspects ?? []), { chatId: chat.chatId, note: '同一次拉群又建出的另一个群' }].slice(-50);
        return { changed: true, result: undefined };
      }
      if (!chat.shareLink && !chat.warnings?.length && !chat.initiator) return { changed: false, result: undefined };
      Object.assign(launch.chat, facts);
      if (chat.shareLink) launch.chat.shareLink = chat.shareLink.slice(0, 2000);
      if (chat.warnings?.length) launch.chat.warnings = [...(launch.chat.warnings ?? []), ...chat.warnings].slice(0, 20).map((w) => clip(w, 2000));
      return { changed: true, result: undefined };
    });
  }

  /**
   * Step 2: the topic group. A create attempt recorded without a group means
   * it may have succeeded with the record lost: first look for the marker
   * among the main bot's chats (recover), create only when nothing carries it.
   */
  private async launchGroupStep(runId: string, token: string): Promise<boolean> {
    const deps = this.deps.launch!;
    const snap = this.launchTx(runId, token, ({ runDir, draft, launch, grill }) => ({
      changed: false,
      result: { launch: structuredClone(launch), initiator: draft.initiator, botTargets: this.launchFlow(runDir, grill).botTargets },
    }));
    if (!snap.held) return false;
    const { launch, initiator, botTargets } = snap.result;
    if (launch.createAttempts?.length) {
      let chats: Awaited<ReturnType<DraftLaunchDeps['listChats']>>;
      try {
        chats = await deps.listChats();
      } catch (error) {
        this.stopLaunch(runId, token, {
          step: 'group', code: 'list_chats_failed', retryable: true,
          message: `上次建群的结果没记录下来，查主 Bot 所在的群失败；为了不重复建群先停在这里：${errorText(error)}`,
        });
        return false;
      }
      // Only a topic group this launch could have built: the name ends with
      // the marker, and its owner is the main bot (before the transfer) or
      // the initiator (after it). Several such groups: a person decides.
      const matches = chats.filter((chat) => groupNameHasMarker(chat.name, launch.marker)
        && chat.chatMode === 'topic'
        && (chat.ownerId === initiator.openId || deps.isSelfOwner(chat.ownerId)));
      if (matches.length === 1) {
        this.recordLaunchChat(runId, token, { chatId: matches[0]!.chatId, recovered: true });
        return true;
      }
      if (matches.length > 1) {
        this.stopLaunch(runId, token, {
          step: 'group', code: 'recover_ambiguous', retryable: true,
          message: `有 ${matches.length} 个群像是这次拉群建的（群名标记 ${launch.marker}），无法确定是哪个；请在飞书里处理多余的群（改名或解散）后点「继续」`,
        }, (current) => {
          const known = new Set((current.orphanSuspects ?? []).map((item) => item.chatId));
          const extra = matches.filter((chat) => !known.has(chat.chatId))
            .map((chat) => ({ chatId: chat.chatId, ...(chat.name ? { name: chat.name.slice(0, 200) } : {}), note: '候选：群名带这次的标记，主 Bot 或发起人是群主' }));
          if (extra.length) current.orphanSuspects = [...(current.orphanSuspects ?? []), ...extra].slice(-50);
        });
        return false;
      }
      // Nothing carries the marker: those attempts made no group, or one whose
      // name was changed since — listed for a person; a new group is built.
      this.launchTx(runId, token, ({ launch: current }) => {
        const known = new Set((current.orphanSuspects ?? []).map((item) => item.attemptAt));
        const extra = (current.createAttempts ?? []).filter((at) => !known.has(at))
          .map((at) => ({ attemptAt: at, note: '这次建群的结果没记录下来，按群名标记也没找到；如果群名被改过，它可能还在' }));
        if (extra.length === 0) return { changed: false, result: undefined };
        current.orphanSuspects = [...(current.orphanSuspects ?? []), ...extra].slice(-50);
        return { changed: true, result: undefined };
      });
    }
    const parsed = parseLaunchExtraMembers(launch.extraMembers, WORKFLOW_LAUNCH_MAX_EXTRA_MEMBERS);
    if (!parsed.ok) {
      this.stopLaunch(runId, token, { step: 'members', code: 'members_invalid', message: parsed.message, retryable: false });
      return false;
    }
    let extraOpenIds: string[] = [];
    if (parsed.emails.length > 0) {
      let resolved: Awaited<ReturnType<DraftLaunchDeps['resolveEmails']>>;
      try {
        resolved = await deps.resolveEmails(parsed.emails);
      } catch (error) {
        resolved = { ok: false, retryable: true, message: errorText(error) };
      }
      const missing = resolved.ok ? parsed.emails.filter((email) => !resolved.ok || !resolved.openIds.get(email)?.startsWith('ou_')) : parsed.emails;
      if (!resolved.ok || missing.length > 0) {
        this.stopLaunch(runId, token, {
          step: 'members',
          code: resolved.ok || !resolved.retryable ? 'members_unresolved' : 'members_lookup_failed',
          retryable: !resolved.ok && resolved.retryable,
          message: resolved.ok ? `这些邮箱主 Bot 查不到：${missing.join('、')}` : `查额外成员失败：${resolved.message}`,
        });
        return false;
      }
      extraOpenIds = parsed.emails.map((email) => resolved.ok ? resolved.openIds.get(email)! : '');
    }
    const owner = launch.ownerChannel === 'union_id'
      ? { channel: 'union_id' as const, unionId: initiator.unionId! }
      : { channel: 'open_id' as const, openId: initiator.openId };
    // The attempt is on disk before the call: a crash inside it is recovered
    // by the marker, never answered by a second group.
    const marked = this.launchTx(runId, token, ({ launch: current }) => {
      current.createAttempts = [...(current.createAttempts ?? []), this.now().toISOString()].slice(-50);
      return { changed: true, result: undefined };
    });
    if (!marked.held) return false;
    let hooked: string | undefined;
    try {
      const created = await deps.createGroup({
        name: launch.groupName,
        botAppIds: botTargets,
        owner,
        extraOpenIds,
        extraUnionIds: parsed.unionIds,
        onChatCreated: (chatId) => {
          hooked = chatId;
          try { this.recordLaunchChat(runId, token, { chatId }); } catch { /* recorded after the call */ }
        },
      });
      this.recordLaunchChat(runId, token, {
        chatId: created.chatId,
        ...(created.shareLink ? { shareLink: created.shareLink } : {}),
        ...(created.warnings.length ? { warnings: created.warnings } : {}),
        initiator: created.initiatorJoined ? 'joined' : 'rejected',
        ...(created.ownerTransferError ? { ownerTransferError: created.ownerTransferError } : {}),
      });
      return true;
    } catch (error) {
      if (hooked) {
        this.recordLaunchChat(runId, token, { chatId: hooked, warnings: [`建群后续步骤出错：${errorText(error)}`] });
        return true;
      }
      this.stopLaunch(runId, token, { step: 'group', code: 'create_group_failed', message: `建群失败：${errorText(error)}`, retryable: true });
      return false;
    }
  }

  /**
   * Group owner (§4.5 第 2 步, decided): the initiator must be in the group —
   * a refused invite stops the launch here (「继续」 retries); a failed owner
   * transfer is recorded on `chat.ownerTransferError`, shown, and the launch
   * goes on. Also for a group recovered by its marker (unknown either way).
   */
  private async launchJoinStep(runId: string, token: string): Promise<boolean> {
    const snap = this.launchTx(runId, token, ({ draft, launch }) => ({
      changed: false,
      result: {
        chatId: launch.chat!.chatId,
        owner: launch.ownerChannel === 'union_id'
          ? { channel: 'union_id' as const, unionId: draft.initiator.unionId! }
          : { channel: 'open_id' as const, openId: draft.initiator.openId },
      },
    }));
    if (!snap.held) return false;
    let joined: Awaited<ReturnType<DraftLaunchDeps['joinInitiator']>>;
    try {
      joined = await this.deps.launch!.joinInitiator(snap.result.chatId, snap.result.owner);
    } catch (error) {
      joined = { joined: false, error: errorText(error) };
    }
    if (!joined.joined) {
      this.stopLaunch(runId, token, {
        step: 'join', code: 'initiator_not_joined', retryable: true,
        message: `发起人没能进群${joined.error ? `（${joined.error}）` : ''}；请确认发起人对编排 Bot 可见后点「继续」重试`,
      }, (launch) => { if (launch.chat) launch.chat.initiator = 'rejected'; });
      return false;
    }
    return this.launchTx(runId, token, ({ launch }) => {
      if (!launch.chat) return { changed: false, result: undefined };
      launch.chat.initiator = 'joined';
      if (joined.ownerTransferError) launch.chat.ownerTransferError = clip(joined.ownerTransferError, 2000);
      else delete launch.chat.ownerTransferError;
      return { changed: true, result: undefined };
    }).held;
  }

  private rootCardView(runId: string, draft: WorkflowDraftRecord, grill: GrillState, nodeCount: number, abandoned = false): LaunchRootCardView {
    return {
      runId,
      title: this.titleOf(draft, grill),
      initiatorOpenId: draft.initiator.openId,
      nodeCount,
      ...(abandoned ? { abandoned: true } : {}),
    };
  }

  /** Step 3: the root card of the main topic (E6). The uuid and the time of
   *  the first try are recorded BEFORE posting. A resend inside Feishu's uuid
   *  window (about an hour) is answered with the first message; past it the
   *  group is searched for the card first and nothing is sent blindly. */
  private async launchRootStep(runId: string, token: string): Promise<boolean> {
    const deps = this.deps.launch!;
    const snap = this.launchTx(runId, token, ({ runDir, draft, launch, grill }) => {
      const firstTry = !launch.rootPending;
      if (firstTry) {
        launch.rootPending = { uuid: `wf-root-${launch.marker.slice(1)}-${randomUUID().slice(0, 8)}`, at: this.now().toISOString() };
      }
      return {
        changed: firstTry,
        result: {
          chatId: launch.chat!.chatId,
          view: this.rootCardView(runId, draft, grill, this.launchFlow(runDir, grill).targets.length),
          pending: { ...launch.rootPending! },
          firstTry,
        },
      };
    });
    if (!snap.held) return false;
    const { chatId, view, pending, firstTry } = snap.result;
    let messageId: string | undefined;
    if (!firstTry && this.now().getTime() - Date.parse(pending.at) > LAUNCH_UUID_DEDUP_SAFE_MS) {
      let found: string[];
      try {
        found = await deps.findRootCards(chatId, runId, pending.at);
      } catch (error) {
        this.stopLaunch(runId, token, {
          step: 'root', code: 'root_unverified', retryable: true,
          message: `上次发主话题卡片的结果没记下来，已超出飞书去重窗口，查群消息也失败了；为了不重复发卡先停在这里：${errorText(error)}`,
        });
        return false;
      }
      if (found.length !== 1) {
        this.stopLaunch(runId, token, {
          step: 'root', code: 'root_unverified', retryable: true,
          message: found.length === 0
            ? '上次发主话题卡片的结果没记下来，已超出飞书去重窗口，群里也没找到这张卡；请到群里确认后处理'
            : `群里有 ${found.length} 张这个工作流的卡片（${found.join('、')}），无法确定哪张是主话题根；请到群里处理`,
        });
        return false;
      }
      messageId = found[0];
    } else {
      try {
        messageId = await deps.postRootCard(chatId, view, pending.uuid);
      } catch (error) {
        this.stopLaunch(runId, token, { step: 'root', code: 'post_root_failed', message: `发主话题卡片失败：${errorText(error)}`, retryable: true });
        return false;
      }
    }
    const recorded = this.launchTx(runId, token, ({ launch }) => {
      if (launch.root) return { changed: false, result: undefined };
      launch.root = { messageId: messageId!, at: this.now().toISOString() };
      delete launch.rootPending;
      return { changed: true, result: undefined };
    });
    return recorded.held;
  }

  /** Step 4: the clarify session moves into the main topic (E7). The move
   *  is written as under way (`binding`) BEFORE it: from then on nothing
   *  closes or suspends the session as the draft's, and a crash is
   *  reconciled here (the bind is idempotent). A session that no longer
   *  exists does not hold the launch up: the topic then gets its session from
   *  its first message. */
  /**
   * A template run (D5) has no clarify session: open one for the main bot
   * here (a headless session with a short context turn, never a workflow
   * command), recorded on the draft like a clarify session, so the move into
   * the main topic below is D4's binding → bind → migrated. Its own
   * reservation keeps a second operation from opening another; a session
   * whose first turn did not go in is closed and opened again on 「继续」.
   * True when the move may go on.
   */
  private async openTemplateRunSession(runId: string, token: string): Promise<boolean> {
    const reservation = this.reserve();
    type Plan = { prompt: string; title: string } | 'ready' | 'busy';
    let plan: Plan;
    let stale: { sessionId: string; headlessId?: string } | undefined;
    try {
      const out = this.launchTx<Plan>(runId, token, ({ draft, launch }) => {
        const template = draft.template;
        if (!template || launch.migrate?.status === 'binding') return { changed: false, result: 'ready' as const };
        if (draft.clarify.sessionId && draft.clarify.state !== 'disconnected') return { changed: false, result: 'ready' as const };
        if (draft.clarify.pending) return { changed: false, result: 'busy' as const };
        if (draft.clarify.sessionId) {
          // Created, but its first turn did not go in: not relayable as is.
          stale = { sessionId: draft.clarify.sessionId, ...(draft.clarify.headlessId ? { headlessId: draft.clarify.headlessId } : {}) };
          delete draft.clarify.sessionId;
          delete draft.clarify.headlessId;
        }
        draft.clarify.state = 'active';
        draft.clarify.pending = this.reservationEntry(reservation);
        return {
          changed: true,
          result: {
            prompt: buildTemplateRunSessionPrompt({ runId, displayName: template.displayName, humanVersion: template.humanVersion, params: template.params }),
            title: clip(template.displayName.replace(/\s+/g, ' '), 80),
          },
        };
      });
      if (!out.held) {
        this.inflight.delete(reservation);
        return false;
      }
      plan = out.result;
    } catch (error) {
      this.inflight.delete(reservation);
      throw error;
    }
    if (plan === 'ready' || plan === 'busy') {
      this.inflight.delete(reservation);
      if (plan === 'busy') {
        this.stopLaunch(runId, token, { step: 'migrate', code: 'session_busy', retryable: true, message: '主 Bot 的会话正在处理上一步，请稍后点「继续」' });
        return false;
      }
      return true;
    }
    if (stale) await this.closeOrRemember(runId, stale);
    await this.startSession(runId, plan.prompt, plan.title, reservation);
    const opened = this.launchTx(runId, token, ({ draft }) => ({
      changed: false,
      result: draft.clarify.sessionId && draft.clarify.state !== 'disconnected'
        ? undefined
        : draft.clarify.error ?? '会话没有开起来',
    }));
    if (!opened.held) return false;
    if (opened.result !== undefined) {
      this.stopLaunch(runId, token, { step: 'migrate', code: 'session_start_failed', retryable: true, message: `主 Bot 的会话没能开起来：${opened.result}；点「继续」重试` });
      return false;
    }
    return true;
  }

  private async launchMigrateStep(runId: string, token: string): Promise<boolean> {
    const deps = this.deps.launch!;
    if (!await this.openTemplateRunSession(runId, token)) return false;
    const snap = this.launchTx(runId, token, ({ draft, launch, grill }) => {
      const sessionId = launch.migrate?.status === 'binding' ? launch.migrate.sessionId ?? draft.clarify.sessionId : draft.clarify.sessionId;
      const usable = !!sessionId && (launch.migrate?.status === 'binding'
        || (draft.clarify.state !== 'disconnected' && draft.clarify.state !== 'closed'));
      const session = usable
        ? { sessionId: sessionId!, ...(draft.clarify.headlessId && draft.clarify.sessionId === sessionId ? { headlessId: draft.clarify.headlessId } : {}) }
        : undefined;
      let changed = false;
      if (session && launch.migrate?.status !== 'binding') {
        launch.migrate = { status: 'binding', at: this.now().toISOString(), sessionId: session.sessionId };
        changed = true;
      }
      return {
        changed,
        result: { chatId: launch.chat!.chatId, rootMessageId: launch.root!.messageId, session, title: this.titleOf(draft, grill) },
      };
    });
    if (!snap.held) return false;
    const { chatId, rootMessageId, session, title } = snap.result;
    let bound: Awaited<ReturnType<DraftLaunchDeps['bindSession']>>;
    if (!session) {
      bound = { ok: false, error: '澄清会话已断开', unavailable: true };
    } else {
      try {
        bound = await deps.bindSession({ ...session, chatId, rootMessageId, title });
      } catch (error) {
        bound = { ok: false, error: errorText(error), unavailable: false };
      }
    }
    if (!bound.ok && !bound.unavailable) {
      // Stays `binding`: the session is not the draft's to close any more.
      this.stopLaunch(runId, token, { step: 'migrate', code: 'bind_failed', message: `澄清会话迁入主话题失败：${bound.error}`, retryable: true });
      return false;
    }
    return this.launchTx(runId, token, ({ draft, launch }) => {
      const at = this.now().toISOString();
      launch.migrate = bound.ok
        ? { status: 'bound', at, sessionId: session!.sessionId }
        : { status: 'unavailable', at, error: clip(bound.error, 2000) };
      if (bound.ok) {
        draft.clarify.state = 'migrated';
        delete draft.clarify.suspendedAt;
        delete draft.clarify.suspendRefusedAt;
      }
      return { changed: true, result: undefined };
    }).held;
  }

  /** Step 4, second half: the summary in the main topic (for people; not
   *  compared with anything). Same pending-uuid rule as the root card, except
   *  that past the window it is not looked for: it is marked unconfirmed and
   *  never sent a second time. Its failure is shown, not retried. */
  private async launchSummaryStep(runId: string, token: string): Promise<boolean> {
    const snap = this.launchTx(runId, token, ({ draft, launch, grill }) => {
      const migrate = launch.migrate!;
      const firstTry = !migrate.summaryPending;
      if (firstTry) migrate.summaryPending = { uuid: `wf-sum-${launch.marker.slice(1)}-${randomUUID().slice(0, 8)}`, at: this.now().toISOString() };
      const spec = this.specFacts(grill);
      return {
        changed: firstTry,
        result: {
          rootMessageId: launch.root!.messageId,
          pending: { ...migrate.summaryPending! },
          firstTry,
          summary: {
            runId,
            title: this.titleOf(draft, grill),
            goal: draft.goal,
            ...(spec?.requirement ? { requirement: spec.requirement } : {}),
            nodes: spec?.nodes ?? [],
            ...(migrate.status === 'unavailable'
              ? { sessionNote: `澄清会话没能迁入（${migrate.error ?? '会话已断开'}），在主话题里发消息会开一个新会话` }
              : {}),
          } satisfies LaunchSummaryView,
        },
      };
    });
    if (!snap.held) return false;
    const { rootMessageId, pending, firstTry, summary } = snap.result;
    let summaryMessageId: string | undefined;
    let summaryError: string | undefined;
    let unverified = false;
    if (!firstTry && this.now().getTime() - Date.parse(pending.at) > LAUNCH_UUID_DEDUP_SAFE_MS) {
      summaryError = '上次发摘要的结果没记下来，可能已经发出；为了不重复，不再补发';
      unverified = true;
    } else {
      try {
        summaryMessageId = await this.deps.launch!.postSummary(rootMessageId, summary, pending.uuid);
      } catch (error) {
        summaryError = errorText(error);
      }
    }
    return this.launchTx(runId, token, ({ launch }) => {
      if (!launch.migrate) return { changed: false, result: undefined };
      if (summaryMessageId) launch.migrate.summaryMessageId = summaryMessageId;
      if (summaryError) launch.migrate.summaryError = clip(summaryError, 2000);
      if (unverified) launch.migrate.summaryUnverified = true;
      delete launch.migrate.summaryPending;
      return { changed: true, result: undefined };
    }).held;
  }

  /**
   * 「我已在群里确认没有这张卡，重发」(root): only from a launch stopped at
   * root_unverified, by the initiator, with `confirmedAbsent: true`. The card
   * goes out with a NEW uuid (the old one may be past Feishu's window), and
   * who confirmed is recorded. If the card was in fact there, there will be
   * two — the page says so before asking.
   */
  async resendRoot(runId: string, initiator: WorkflowDraftInitiator, input: { confirmedAbsent?: unknown; baseVersion?: number } = {}): Promise<WorkflowDraftView> {
    this.requireLaunchDeps();
    if (input.confirmedAbsent !== true) throw err('bad_request', '需要 confirmedAbsent: true（确认群里没有这张卡）');
    const token = this.reserveLaunch();
    try {
      // `launched`: after the start it still answers (state_conflict).
      this.mutate(runId, initiator, { baseVersion: input.baseVersion, launchOp: true, launched: true }, ({ draft }) => {
        const launch = draft.launch;
        if (!launch) throw err('no_launch', '还没有开始拉群');
        if (this.launchRunning(draft)) throw err('launch_running', '正在拉群，等这一步结束');
        if (launch.root || launch.error?.code !== 'root_unverified' || !launch.rootPending) {
          throw err('state_conflict', '只有停在「主话题卡片未确认」时才能这样重发');
        }
        const at = this.now().toISOString();
        const uuid = `wf-root-${launch.marker.slice(1)}-${randomUUID().slice(0, 8)}`;
        launch.rootPending = { uuid, at };
        launch.rootManualResends = [...(launch.rootManualResends ?? []), { at, byOpenId: initiator.openId, uuid }].slice(-20);
        launch.state = 'running';
        launch.token = token;
        launch.attempt += 1;
        launch.updatedAt = at;
        delete launch.error;
        return { changed: true, result: undefined };
      });
    } catch (error) {
      this.launchTokens.delete(token);
      throw error;
    }
    this.log(`[workflow-draft] launch ${runId}: root card resent after ${initiator.openId} confirmed it absent`);
    void this.driveLaunch(runId, token);
    return this.view(runId);
  }

  /**
   * The same for the summary marked unconfirmed (not a stop: the launch went
   * on). Sent once more with a new uuid, recorded with who confirmed. Allowed
   * after the start too — it is a message for people only.
   */
  async resendSummary(runId: string, initiator: WorkflowDraftInitiator, input: { confirmedAbsent?: unknown } = {}): Promise<WorkflowDraftView> {
    const deps = this.requireLaunchDeps();
    if (input.confirmedAbsent !== true) throw err('bad_request', '需要 confirmedAbsent: true（确认群里没有这条摘要）');
    const token = this.reserveLaunch();
    let target: { rootMessageId: string; summary: LaunchSummaryView; uuid: string; previous: WorkflowDraftLaunch['state'] };
    try {
      target = this.mutate(runId, initiator, { launchOp: true, launched: true }, ({ draft, grill }) => {
        const launch = draft.launch;
        if (!launch) throw err('no_launch', '还没有开始拉群');
        if (this.launchRunning(draft)) throw err('launch_running', '正在拉群，等这一步结束');
        const migrate = launch.migrate;
        if (!launch.root || !migrate?.summaryUnverified || migrate.summaryMessageId) {
          throw err('state_conflict', '只有摘要「未确认」时才能这样重发');
        }
        const spec = this.specFacts(grill);
        const previous = launch.start ? 'started' : launch.state;
        const at = this.now().toISOString();
        // A manual resend that died after posting is resent with the SAME
        // uuid inside Feishu's window (deduplicated); past it, the person
        // confirmed again, so a fresh uuid.
        const earlier = migrate.summaryPending;
        const reuse = earlier?.manual && this.now().getTime() - Date.parse(earlier.at) <= LAUNCH_UUID_DEDUP_SAFE_MS;
        const uuid = reuse ? earlier!.uuid : `wf-sum-${launch.marker.slice(1)}-${randomUUID().slice(0, 8)}`;
        migrate.summaryPending = reuse ? earlier! : { uuid, at, manual: true };
        launch.state = 'running';
        launch.token = token;
        launch.updatedAt = at;
        return {
          changed: true,
          result: {
            rootMessageId: launch.root.messageId,
            uuid,
            previous,
            summary: {
              runId, title: this.titleOf(draft, grill), goal: draft.goal,
              ...(spec?.requirement ? { requirement: spec.requirement } : {}),
              nodes: spec?.nodes ?? [],
            },
          },
        };
      });
    } catch (error) {
      this.launchTokens.delete(token);
      throw error;
    }
    let messageId: string | undefined;
    let failure: string | undefined;
    try {
      messageId = await deps.postSummary(target.rootMessageId, target.summary, target.uuid);
    } catch (error) {
      failure = errorText(error);
    } finally {
      this.launchTokens.delete(token);
      try {
        this.launchTx(runId, token, ({ launch }) => {
          launch.state = target.previous === 'running' ? 'paused' : target.previous;
          delete launch.token;
          if (messageId && launch.migrate) {
            launch.migrate.summaryMessageId = messageId;
            launch.migrate.summaryManualResend = { at: this.now().toISOString(), byOpenId: initiator.openId };
            delete launch.migrate.summaryUnverified;
            delete launch.migrate.summaryError;
            delete launch.migrate.summaryPending;
          }
          return { changed: true, result: undefined };
        });
      } catch { /* a dead token is taken over by 「继续」 */ }
    }
    if (failure) throw err('post_failed', `摘要没能发出：${clip(failure, 300)}`);
    return this.view(runId);
  }

  /**
   * Step 5: every executing bot, live in the new group — in it (a missing one
   * is invited once more: 「重试拉人」), its daemon online, opens topic
   * sessions. Read only: no grant here (step 6 grants only bots that pass).
   */
  private async launchCheckStep(runId: string, token: string): Promise<boolean> {
    const snap = this.launchTx(runId, token, ({ runDir, draft, launch, grill }) => ({
      changed: false,
      result: { chatId: launch.chat!.chatId, flowRevision: draft.flowRevision ?? 0, targets: this.launchFlow(runDir, grill).targets },
    }));
    if (!snap.held) return false;
    const { chatId, flowRevision, targets } = snap.result;
    const deps = this.deps.launch!;
    const probe = deps.probe(chatId);
    const verdicts = new Map<string, Awaited<ReturnType<typeof judgeV3BotEligibility>>>();
    for (const target of targets) {
      const appId = target.larkAppId;
      if (appId === this.deps.appId || verdicts.has(appId)) continue;
      let verdict = await judgeV3BotEligibility(appId, probe, { grant: false });
      if (verdict?.code === 'BOT_NOT_IN_CHAT') {
        try { await deps.addBots(chatId, [appId]); } catch { /* judged again below */ }
        verdict = await judgeV3BotEligibility(appId, probe, { grant: false });
      }
      verdicts.set(appId, verdict);
    }
    const problems: WorkflowDraftLaunchProblem[] = [];
    for (const target of targets) {
      if (target.directoryOutputs) {
        problems.push({ nodeId: target.nodeId, larkAppId: target.larkAppId, code: 'DIRECTORY_OUTPUT', why: describeV3BotEligibilityCode('DIRECTORY_OUTPUT'), detail: target.directoryOutputs.join(', ').slice(0, 2000) });
      }
      const verdict = verdicts.get(target.larkAppId);
      if (verdict) {
        problems.push({
          nodeId: target.nodeId, larkAppId: target.larkAppId, code: verdict.code, why: describeV3BotEligibilityCode(verdict.code),
          ...(verdict.detail ? { detail: clip(verdict.detail, 2000) } : {}),
        });
      }
    }
    const check = { at: this.now().toISOString(), flowRevision, ok: problems.length === 0, problems: problems.slice(0, 200) };
    if (check.ok) {
      return this.launchTx(runId, token, ({ launch }) => {
        launch.check = check;
        return { changed: true, result: undefined };
      }).held;
    }
    const nameOf = this.deps.nameOf();
    this.stopLaunch(runId, token, {
      step: 'check', code: 'bots_ineligible', retryable: true,
      message: ['这些节点的执行 Bot 现在不满足条件：',
        ...problems.map((problem) => `- ${problem.nodeId} → ${nameOf(problem.larkAppId)}：${problem.why}${problem.detail ? `（${problem.detail}）` : ''}`),
        '处理后点「继续」重试；或给节点换 Bot（需要重新确认流程）。'].join('\n'),
    }, (launch) => { launch.check = check; });
    return false;
  }

  /**
   * Revoke the grants of bots that no longer execute any node — both sides:
   * by the open_id recorded when a side was written (no membership needed),
   * or, for a side whose result was lost (`*Pending`), by the receiver
   * resolving the subject app in its own namespace. Run only while `token`
   * holds the launch, so the flow cannot change meanwhile; still, the record
   * is checked again under the lock before and after: a bot that executes a
   * node again, or a run already authorized, is left alone (logged).
   */
  private async revokeStaleLaunchGrants(runId: string, token: string, chatId: string): Promise<string | undefined> {
    const deps = this.deps.launch!;
    const stillStale = (appId: string) => this.launchTx(runId, token, ({ runDir, launch, grill }) => ({
      changed: false,
      result: !!launch.grants?.[appId] && !existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))
        && !this.launchFlow(runDir, grill).botTargets.includes(appId),
    }));
    const snap = this.launchTx(runId, token, ({ launch }) => ({ changed: false, result: structuredClone(launch.grants ?? {}) }));
    if (!snap.held) return undefined;
    for (const [appId, grant] of Object.entries(snap.result)) {
      const before = stillStale(appId);
      if (!before.held) return undefined;
      if (!before.result) continue;
      try {
        // Every open_id recorded for a side, each only with its own receiver.
        for (const openIdOf of new Set([grant.mainSide, grant.mainPending].filter((id): id is string => !!id))) {
          await deps.revoke(chatId, this.deps.appId, openIdOf);
        }
        for (const openIdOf of new Set([grant.peerSide, grant.peerPending].filter((id): id is string => !!id))) {
          await deps.revoke(chatId, appId, openIdOf);
        }
      } catch (error) {
        return `撤销 ${this.deps.nameOf()(appId)} 在这个群的协作授权失败（${errorText(error)}）；`
          + '撤销不要求它还在群里，但需要接收方的 daemon 在线：确认主 Bot 和它的 daemon 都在线后点「继续」';
      }
      const dropped = this.launchTx(runId, token, ({ runDir, launch }) => {
        if (!launch.grants?.[appId]) return { changed: false, result: true };
        if (existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) {
          // Cannot happen while the token is held (run.json is written under
          // it); kept for a person to see rather than silently rewritten.
          this.log(`[workflow-draft] launch ${runId}: grants of ${appId} were revoked after run.json appeared; record kept`);
          return { changed: false, result: false };
        }
        // Gone from Feishu now: also when it executes a node again (the flow
        // changed despite the token), the record goes, so the grant step
        // writes it afresh instead of trusting a revoked grant.
        delete launch.grants[appId];
        if (Object.keys(launch.grants).length === 0) delete launch.grants;
        return { changed: true, result: true };
      });
      if (!dropped.held) return undefined;
      this.log(`[workflow-draft] launch ${runId}: revoked chat grants of ${appId} in ${chatId}`);
    }
    return undefined;
  }

  /** Step 6: grants between the main bot and every executing bot that
   *  passed step 5, after revoking those of bots swapped out. Idempotent. */
  private async launchGrantStep(runId: string, token: string): Promise<boolean> {
    const first = this.launchTx(runId, token, ({ launch }) => ({ changed: false, result: launch.chat!.chatId }));
    if (!first.held) return false;
    const revokeError = await this.revokeStaleLaunchGrants(runId, token, first.result);
    if (revokeError) {
      this.stopLaunch(runId, token, { step: 'grant', code: 'revoke_failed', message: revokeError, retryable: true });
      return false;
    }
    const snap = this.launchTx(runId, token, ({ runDir, launch, grill }) => ({
      changed: false,
      result: { chatId: launch.chat!.chatId, grants: structuredClone(launch.grants ?? {}), wanted: this.launchFlow(runDir, grill).botTargets },
    }));
    if (!snap.held) return false;
    const { chatId, grants, wanted } = snap.result;
    const deps = this.deps.launch!;
    for (const appId of wanted) {
      const have = grants[appId];
      for (const side of ['mainSide', 'peerSide'] as const) {
        if (have?.[side]) continue;
        // The intent first, with the exact open_id the receiver's own app
        // sees for the subject: a grant whose result is lost is still
        // revocable by open_id (no membership needed then).
        const pendingKey = side === 'mainSide' ? 'mainPending' : 'peerPending';
        const receiver = side === 'mainSide' ? this.deps.appId : appId;
        const subject = side === 'mainSide' ? appId : this.deps.appId;
        if (!have?.[pendingKey]) {
          let subjectOpenId: string;
          try {
            subjectOpenId = await deps.resolveSubject(chatId, receiver, subject);
            if (!/^ou_[A-Za-z0-9_-]{1,128}$/.test(subjectOpenId)) throw new Error('换算出的 open_id 不合法');
          } catch (error) {
            this.stopLaunch(runId, token, {
              step: 'grant', code: 'grant_failed', retryable: true,
              message: `${describeV3BotEligibilityCode('COLLABORATION_DENIED')}：${this.deps.nameOf()(appId)}（${errorText(error)}）`,
            });
            return false;
          }
          const intent = this.launchTx(runId, token, ({ launch }) => {
            const current = launch.grants?.[appId] ?? { at: this.now().toISOString() };
            launch.grants = { ...(launch.grants ?? {}), [appId]: { ...current, [pendingKey]: subjectOpenId } };
            return { changed: true, result: undefined };
          });
          if (!intent.held) return false;
        }
        let written: { subjectOpenId: string };
        try {
          written = side === 'mainSide'
            ? await deps.grant(chatId, this.deps.appId, appId)
            : await deps.grant(chatId, appId, this.deps.appId);
          if (!/^ou_[A-Za-z0-9_-]{1,128}$/.test(written.subjectOpenId)) throw new Error('授权返回的 open_id 不合法');
        } catch (error) {
          this.stopLaunch(runId, token, {
            step: 'grant', code: 'grant_failed', retryable: true,
            message: `${describeV3BotEligibilityCode('COLLABORATION_DENIED')}：${this.deps.nameOf()(appId)}（${errorText(error)}）`,
          });
          return false;
        }
        const recorded = this.launchTx(runId, token, ({ launch }) => {
          const current = { ...(launch.grants?.[appId] ?? { at: this.now().toISOString() }) };
          // Normally the same open_id; if the receiver answered another one,
          // both stay recorded (same receiver's namespace) and a revoke
          // removes both.
          if (current[pendingKey] === written.subjectOpenId) delete current[pendingKey];
          launch.grants = { ...(launch.grants ?? {}), [appId]: { ...current, [side]: written.subjectOpenId } };
          return { changed: true, result: undefined };
        });
        if (!recorded.held) return false;
      }
    }
    return true;
  }

  /**
   * Step 7: run.json. Under the draft lock (then the host lock, then the
   * run.json lock — the documented order), the current flow is checked
   * against the second confirmation on all four pins; the run is authorized
   * with the binding this launch produced, the initiator and the
   * confirmation; the grill moves to dag_approved. A run.json already there
   * (crash after it was written) must be this launch's: then it is only
   * recorded.
   */
  /** §5.2 placement hard rules at the Dashboard commit point — the same
   *  gate as `approve-dag` and `resolveV3NodeExecutor`
   *  (`authorizeAdHocRun` / `commitSavedWorkflowRunInPlace` stay pure and
   *  never read the session). Refusal lines; [] = run.json may be written. */
  private commitPlacementProblems(
    targets: readonly V3NodeExecutorTarget[],
    binding: RunChatBinding,
  ): string[] {
    if (!targets.some((target) => target.placement === 'main' && !target.loop)) return [];
    const unavailable: V3MainTopicAvailability = { available: false, why: '无法确认主会话是不是话题里的会话' };
    const mainTopic = this.deps.launch?.mainTopicAvailability?.(binding) ?? unavailable;
    return v3TargetPlacementProblems({
      targets,
      orchestratorAppId: this.deps.appId,
      mainTopic,
      nameOf: this.deps.nameOf(),
    });
  }

  private async launchCommitStep(runId: string, token: string): Promise<boolean> {
    // 运行模板 as is (§5.3): run.json is the template's (saved_definition).
    // A swapped bot made it 复制后启动: the ad-hoc commit below.
    const peek = readWorkflowDraft(this.runDirOf(runId, { launched: true }));
    if (peek?.template && Object.keys(peek.nodeBots ?? {}).length === 0) return this.launchTemplateCommitStep(runId, token, peek.template);
    const bots = this.deps.loadBots();
    const nameOf = this.deps.nameOf();
    type Outcome = undefined | 'stop' | 'again' | 'committed' | { placement: string };
    const out = this.launchTx<Outcome>(runId, token, ({ runDir, draft, launch, grill }) => {
      const chatId = launch.chat!.chatId;
      const rootMessageId = launch.root!.messageId;
      const envelopePath = join(runDir, V3_RUN_ENVELOPE_FILE);
      const binding: RunChatBinding = {
        larkAppId: this.deps.appId,
        chatId,
        chatType: 'group',
        rootMessageId,
        ...(launch.migrate?.status === 'bound' && launch.migrate.sessionId ? { sessionId: launch.migrate.sessionId } : {}),
        ownerOpenId: draft.initiator.openId,
      };
      const initiator: V3RunInitiator = {
        openId: draft.initiator.openId,
        ...(draft.initiator.source === 'dashboard-platform' && draft.initiator.unionId ? { unionId: draft.initiator.unionId } : {}),
        source: draft.initiator.source,
      };
      let placementRefusal: string | undefined;
      if (!existsSync(envelopePath)) {
        let flow: ReturnType<WorkflowDraftService['currentFlow']>;
        try {
          flow = this.currentFlow(runDir, grill, bots, nameOf);
        } catch (error) {
          throw err('dag_invalid', `流程读不出来：${errorText(error)}`);
        }
        if (grill.status !== 'dag_ready' || !draft.flowConfirmation || !this.confirmationValid(draft, flow)) {
          // §9: back to 待确认流程; the page shows the current flow to confirm.
          delete draft.flowConfirmation;
          return { changed: true, result: 'stop' as const };
        }
        const wanted = [...new Set(flow.targets.map((t) => t.larkAppId).filter((appId) => appId !== this.deps.appId))];
        if (nextLaunchStep(launch, { flowRevision: draft.flowRevision ?? 0, targets: wanted }) !== 'commit') {
          return { changed: false, result: 'again' as const };
        }
        // §5.2 hard rules before run.json exists (the Feishu /workflow run
        // entry enforces them at approve-dag; a copied/swapped flow bypassed
        // that entry). A replay below already passed this gate.
        const problems = this.commitPlacementProblems(flow.targets, binding);
        if (problems.length > 0) placementRefusal = formatV3PlacementRefusal(problems);
      }
      if (draft.template && Object.keys(draft.nodeBots ?? {}).length === 0) return { changed: false, result: 'again' as const };
      if (placementRefusal) return { changed: true, result: { placement: placementRefusal } as const };
      const confirmation = draft.flowConfirmation;
      if (existsSync(envelopePath)) {
        // Written before its record could be (crash): it must be exactly this
        // launch's — then authorizeAdHocRun only replays it.
        const existing = readRunEnvelope(runDir, runId);
        const envelope = existing.kind === 'ok' ? existing.envelope : undefined;
        const authorization = envelope?.authorization as { initiator?: V3RunInitiator; flowConfirmation?: { flowSummarySha256?: string } } | undefined;
        if (!envelope || envelope.source.kind !== 'ad_hoc' || envelope.chatBinding?.chatId !== chatId
          || envelope.chatBinding.rootMessageId !== rootMessageId || envelope.chatBinding.larkAppId !== this.deps.appId
          || authorization?.initiator?.openId !== initiator.openId || !authorization.flowConfirmation?.flowSummarySha256) {
          throw err('state_conflict', 'run.json 已存在，但不是这次拉群写的；不会覆盖它');
        }
      }
      const authorized = authorizeAdHocRun(runDir, bots, this.now(), {
        nodeExecutor: 'bot',
        chatBinding: binding,
        initiator,
        flowConfirmation: ({ dag, targets }) => {
          // Exactly what is being frozen must be what was confirmed.
          const flowSummary = adHocFlowSummary({ runDir, dag, targets, orchestratorAppId: this.deps.appId, bots, nameOf });
          const flowSummarySha256 = v3FlowSummarySha256(flowSummary);
          if (!confirmation || flowSummarySha256 !== confirmation.flowSummarySha256) {
            throw err('flow_changed', '要写进 run.json 的流程和确认时的不一样');
          }
          return { confirmedByOpenId: confirmation.confirmedByOpenId, confirmedAt: confirmation.confirmedAt, flowSummary, flowSummarySha256 };
        },
      });
      hostApproveDag(runDir, this.now());
      const authorization = authorized.envelope.authorization as { flowConfirmation?: { flowSummarySha256: string } };
      launch.commit = {
        at: this.now().toISOString(),
        chatId,
        rootMessageId,
        runJsonSha256: fileSha256(envelopePath)!,
        flowSummarySha256: authorization.flowConfirmation!.flowSummarySha256 as `sha256:${string}`,
        dagSha256: authorized.envelope.artifacts.dag.sha256,
        specSha256: authorized.envelope.artifacts.spec!.sha256,
        flowRevision: draft.flowRevision ?? 0,
      };
      return { changed: true, result: 'committed' as const };
    });
    if (!out.held) return false;
    if (out.result === 'stop') {
      this.stopLaunch(runId, token, {
        step: 'commit', code: 'flow_changed', retryable: false,
        message: '流程和第二道确认时的不一致，已回到「待确认流程」：请看最新的流程，重新确认后点「继续」',
      });
      return false;
    }
    if (typeof out.result === 'object' && 'placement' in out.result) {
      // Same recovery shape as flow_changed: the second confirmation is for
      // a flow the hard rules reject, so void it — phase falls back to
      // 待确认流程, where the bot / dependencies can be changed and the flow
      // re-confirmed before 「继续」. Otherwise 「继续」 just re-runs the same
      // refusal with no editable panel.
      this.stopLaunch(runId, token, { step: 'commit', code: 'placement_refused', retryable: false, message: out.result.placement },
        (_launch, draft) => { delete draft.flowConfirmation; });
      return false;
    }
    if (out.result === 'committed') this.log(`[workflow-draft] launch ${runId}: run.json written`);
    return true;
  }

  /**
   * Step 7 of a template run (§5.3): the revision pinned when the run was
   * prepared, committed in place as `source: saved_definition` with the
   * group, the main topic and the initiator (D1: the binding's owner is the
   * initiator). Its flow must still be the prepared one; a draft-born
   * revision's run also needs its 「确认流程」 to hold (I13).
   */
  private async launchTemplateCommitStep(runId: string, token: string, pinned: WorkflowDraftTemplateRun): Promise<boolean> {
    // run.json already written (its record lost): replay it from the run
    // directory alone — the library may have moved on (archived, deleted)
    // and must not wedge a committed run.
    const committed = existsSync(join(this.runDirOf(runId, { launched: true }), V3_RUN_ENVELOPE_FILE));
    let library: { metadata: Awaited<ReturnType<typeof readSavedWorkflowMetadata>>; revision: Awaited<ReturnType<typeof readSavedWorkflowRevision>> } | undefined;
    if (!committed) {
      let libraryError: string | undefined;
      try {
        const metadata = await readSavedWorkflowMetadata(this.libraryDir(), pinned.workflowId);
        const revision = await readSavedWorkflowRevision(this.libraryDir(), pinned.workflowId, pinned.revisionId);
        libraryError = revision.contentHash !== pinned.contentHash ? '模板版本的内容和准备运行时不一样' : this.templateRunnableHere(metadata);
        if (!libraryError) library = { metadata, revision };
      } catch (error) {
        libraryError = `模板读不出来：${errorText(error)}`;
      }
      if (!library) {
        this.stopLaunch(runId, token, { step: 'commit', code: 'template_unavailable', retryable: true, message: libraryError ?? '模板读不出来' });
        return false;
      }
    }
    const bots = this.deps.loadBots();
    const nameOf = this.deps.nameOf();
    type Outcome = 'again' | 'stop' | 'committed' | { unavailable: string } | { placement: string };
    const out = this.launchTx<Outcome>(runId, token, ({ runDir, draft, launch, grill }) => {
      const template = draft.template;
      if (!template || template.revisionId !== pinned.revisionId || Object.keys(draft.nodeBots ?? {}).length > 0) {
        return { changed: false, result: 'again' as const };
      }
      const chatId = launch.chat!.chatId;
      const rootMessageId = launch.root!.messageId;
      const envelopePath = join(runDir, V3_RUN_ENVELOPE_FILE);
      let summarySha: string | undefined;
      let pendingTargets: readonly V3NodeExecutorTarget[] | undefined;
      const exists = existsSync(envelopePath);
      if (!exists) {
        if (!library) return { changed: false, result: 'again' as const };
        // The archive / scope check of the template, again inside the lock:
        // closes the window between the read above and this commit.
        let why: string | undefined;
        try {
          why = this.templateRunnableHere(readSavedWorkflowMetadataSync(this.libraryDir(), pinned.workflowId));
        } catch (error) {
          why = `模板读不出来：${errorText(error)}`;
        }
        if (why) return { changed: false, result: { unavailable: why } };
        let flow: ReturnType<WorkflowDraftService['currentFlow']>;
        try {
          flow = this.currentFlow(runDir, grill, bots, nameOf);
        } catch (error) {
          throw err('dag_invalid', `流程读不出来：${errorText(error)}`);
        }
        if (grill.status !== 'dag_ready' || !this.flowReady(draft, flow)) {
          delete draft.flowConfirmation;
          return { changed: true, result: 'stop' as const };
        }
        if (nextLaunchStep(launch, { flowRevision: draft.flowRevision ?? 0, targets: [...new Set(flow.targets.map((t) => t.larkAppId).filter((appId) => appId !== this.deps.appId))] }) !== 'commit') {
          return { changed: false, result: 'again' as const };
        }
        summarySha = flow.flowSummarySha256;
        // §5.2 hard rules before run.json exists (resolveV3NodeExecutor gates
        // the Feishu entry; this Dashboard commit writes in place without it).
        pendingTargets = flow.targets;
      } else {
        // The record of a replayed commit: the confirmation run.json carries,
        // else the summary of the flow on disk; never a different digest.
        const onRecord = readRunEnvelope(runDir, runId);
        const recorded = onRecord.kind === 'ok'
          ? (onRecord.envelope.authorization as { flowConfirmation?: { flowSummarySha256?: string } }).flowConfirmation?.flowSummarySha256
          : undefined;
        let replayed: string | undefined;
        if (!recorded) {
          try { replayed = this.currentFlow(runDir, grill, bots, nameOf).flowSummarySha256; } catch { replayed = undefined; }
        }
        summarySha = recorded ?? replayed;
      }
      const binding: RunChatBinding = {
        larkAppId: this.deps.appId,
        chatId,
        chatType: 'group',
        rootMessageId,
        ...(launch.migrate?.status === 'bound' && launch.migrate.sessionId ? { sessionId: launch.migrate.sessionId } : {}),
        ownerOpenId: draft.initiator.openId,
      };
      const initiator: V3RunInitiator = {
        openId: draft.initiator.openId,
        ...(draft.initiator.source === 'dashboard-platform' && draft.initiator.unionId ? { unionId: draft.initiator.unionId } : {}),
        source: draft.initiator.source,
      };
      if (pendingTargets) {
        const problems = this.commitPlacementProblems(pendingTargets, binding);
        if (problems.length > 0) return { changed: true, result: { placement: formatV3PlacementRefusal(problems) } };
      }
      const rawParams = Object.create(null) as Record<string, RawParamInput>;
      for (const [name, value] of Object.entries(template.params)) rawParams[name] = { kind: 'string', value };
      // Lock order: draft (held) → grill/host → run.json.
      const replay = (): ReturnType<typeof replaySavedWorkflowRunCommit> | { unavailable: string } => {
        try {
          return replaySavedWorkflowRunCommit(runDir, {
              workflowId: pinned.workflowId,
              revisionId: pinned.revisionId,
              contentHash: pinned.contentHash,
              chatBinding: binding,
              initiatorOpenId: initiator.openId,
            });
        } catch (error) {
          if (error instanceof SavedWorkflowRunReplayError) return { unavailable: error.message };
          throw error;
        }
      };
      const envelope = withHostMutationLockSync(runDir, () => withFileLockSync(envelopePath, () => {
        const written = existsSync(envelopePath)
          ? replay()
          : commitSavedWorkflowRunInPlace({
              runDir,
              metadata: library!.metadata,
              revision: library!.revision,
              rawParams,
              chatBinding: binding,
              initiator,
              expected: { dagSha256: template.dagSha256, specSha256: template.specSha256 },
              bots,
              now: this.now(),
            });
        // The grill is this draft's bookkeeping only: past run.json it reads
        // as approved, like an ad-hoc launch's.
        if ('unavailable' in written) return written;
        const current = readGrillState(runDir);
        if (current?.status === 'dag_ready') transition(runDir, 'dag_approved', {}, this.now());
        return written;
      }));
      if ('unavailable' in envelope) return { changed: false, result: { unavailable: envelope.unavailable } };
      launch.commit = {
        at: this.now().toISOString(),
        chatId,
        rootMessageId,
        runJsonSha256: fileSha256(envelopePath)!,
        ...(summarySha ? { flowSummarySha256: summarySha as `sha256:${string}` } : {}),
        dagSha256: envelope.artifacts.dag.sha256,
        specSha256: envelope.artifacts.spec.sha256,
        flowRevision: draft.flowRevision ?? 0,
      };
      return { changed: true, result: 'committed' as const };
    });
    if (!out.held) return false;
    if (out.result === 'stop') {
      this.stopLaunch(runId, token, {
        step: 'commit', code: 'flow_changed', retryable: false,
        message: '流程和准备运行（或确认）时的不一致：请看最新的流程，确认后点「继续」',
      });
      return false;
    }
    if (typeof out.result === 'object') {
      if ('placement' in out.result) {
        // Void the confirmation (same recovery shape as the ad-hoc path):
        // back to 待确认流程 to change the bot, then 复制后启动 commits the
        // adjusted flow.
        this.stopLaunch(runId, token, { step: 'commit', code: 'placement_refused', retryable: false, message: out.result.placement },
          (_launch, draft) => { delete draft.flowConfirmation; });
        return false;
      }
      this.stopLaunch(runId, token, { step: 'commit', code: 'template_unavailable', retryable: true, message: out.result.unavailable });
      return false;
    }
    if (out.result === 'committed') this.log(`[workflow-draft] launch ${runId}: template run.json ${committed ? 're-recorded' : 'written'} (${pinned.workflowId} v${pinned.humanVersion})`);
    return true;
  }

  /** Why this bot cannot run the template now (archived, chat scope, another bot). */
  private templateRunnableHere(metadata: Awaited<ReturnType<typeof readSavedWorkflowMetadata>>): string | undefined {
    if (metadata.status === 'archived') return '模板已归档，不能再运行';
    if (metadata.scope.kind !== 'global' || metadata.owner.larkAppId !== this.deps.appId) return '模板的范围或所属 Bot 变了，不能在这里运行';
    return undefined;
  }

  /** Step 8: the same start path as `botmux workflow start` (idempotent). */
  private async launchStartStep(runId: string, token: string): Promise<boolean> {
    let started: Awaited<ReturnType<DraftLaunchDeps['startRun']>>;
    try {
      started = await this.deps.launch!.startRun(runId);
    } catch (error) {
      started = { ok: false, status: 500, error: errorText(error) };
    }
    if (!started.ok) {
      this.stopLaunch(runId, token, {
        step: 'start', code: clip(started.error, 64), retryable: true,
        message: `启动失败（HTTP ${started.status}）：${started.error}${started.detail ? `（${started.detail}）` : ''}`,
      });
      return false;
    }
    this.launchTx(runId, token, ({ launch }) => {
      launch.start = { at: this.now().toISOString() };
      launch.state = 'started';
      delete launch.token;
      delete launch.error;
      return { changed: true, result: undefined };
    });
    this.log(`[workflow-draft] launch ${runId}: started`);
    return false;
  }

  /** The root card says 「这次启动已放弃」 (best effort; the next 「放弃」 retries). */
  private async noteRootAbandoned(runId: string): Promise<void> {
    const deps = this.deps.launch;
    if (!deps) return;
    let target: { messageId: string; view: LaunchRootCardView } | undefined;
    try {
      target = this.mutate(runId, undefined, { allowAbandoned: true, launchOp: true, launched: true }, ({ runDir, draft, grill }) => {
        const root = draft.launch?.root;
        if (!root || root.abandonNoted) return { changed: false, result: undefined };
        let nodeCount = 0;
        try { nodeCount = this.launchFlow(runDir, grill).targets.length; } catch { /* unknown */ }
        return { changed: false, result: { messageId: root.messageId, view: this.rootCardView(runId, draft, grill, nodeCount, true) } };
      });
    } catch {
      return;
    }
    if (!target) return;
    try {
      await deps.updateRootCard(target.messageId, target.view);
    } catch (error) {
      this.log(`[workflow-draft] noting abandon on the root card of ${runId} failed: ${errorText(error)}`);
      return;
    }
    try {
      this.mutate(runId, undefined, { allowAbandoned: true, launchOp: true, launched: true, keepUpdatedAt: true }, ({ draft }) => {
        if (!draft.launch?.root || draft.launch.root.abandonNoted) return { changed: false, result: undefined };
        draft.launch.root.abandonNoted = true;
        return { changed: true, result: undefined };
      });
    } catch { /* the next 「放弃」 updates the card again (same content) */ }
  }

  private launchView(draft: WorkflowDraftRecord, targets: string[] | undefined, running: boolean): WorkflowDraftLaunchView {
    const launch = draft.launch!;
    let nextStep: WorkflowDraftLaunchView['nextStep'];
    if (launch.commit || launch.start) nextStep = nextLaunchStep(launch, { flowRevision: 0, targets: [] });
    else if (!targets) nextStep = launch.chat && launch.root && launch.migrate ? 'unknown' : nextLaunchStep(launch, { flowRevision: draft.flowRevision ?? 0, targets: [] });
    else nextStep = nextLaunchStep(launch, { flowRevision: draft.flowRevision ?? 0, targets });
    return {
      state: launch.state === 'running' && !running ? 'paused' : launch.state,
      running,
      nextStep,
      attempt: launch.attempt,
      groupName: launch.groupName,
      marker: launch.marker,
      extraMembers: launch.extraMembers,
      ownerChannel: launch.ownerChannel,
      ...(launch.chat ? { chat: launch.chat } : {}),
      ...(launch.orphanSuspects?.length ? { orphanSuspects: launch.orphanSuspects } : {}),
      ...(launch.root ? { root: launch.root } : {}),
      ...(launch.rootManualResends?.length ? { rootManualResends: launch.rootManualResends } : {}),
      ...(launch.migrate ? { migrate: launch.migrate } : {}),
      ...(launch.check ? { check: launch.check } : {}),
      grantedBots: Object.entries(launch.grants ?? {}).filter(([, g]) => g.mainSide && g.peerSide).map(([appId]) => appId),
      ...(launch.commit ? { commit: launch.commit } : {}),
      ...(launch.start ? { start: launch.start } : {}),
      ...(launch.error ? { error: launch.error } : {}),
      startedAt: launch.startedAt,
      updatedAt: launch.updatedAt,
      ...(launch.abandonedAt ? { abandonedAt: launch.abandonedAt } : {}),
    };
  }

  // ── reads ──

  /** One draft, for any Dashboard admin (§7.2). Commits a finished clarify
   *  turn on the way (mechanical; never a state decision). */
  async view(runId: string): Promise<WorkflowDraftView> {
    const runDir = this.runDirOf(runId, { launched: true });
    let snapshot: { draft: WorkflowDraftRecord; grill: GrillState; launchRunning: boolean };
    try {
      snapshot = withWorkflowDraftLock(runDir, runId, () => {
        const loaded = this.loadLocked(runId, runDir, undefined, { allowAbandoned: true, launched: true });
        const refreshed = this.refreshClarifyInPlace(loaded.draft);
        const healed = this.healStaleArchitect(runId, loaded.draft, loaded.grill);
        if (refreshed || healed) this.persist(runDir, loaded.draft, { keepUpdatedAt: refreshed !== 'activity' });
        // Taken with the record: the view awaits below, and a launch step may
        // finish meanwhile — this record is then still the one it ran on.
        return { ...loaded, launchRunning: this.launchRunning(loaded.draft) };
      });
    } catch (error) {
      throw this.mapError(error);
    }
    const { draft, grill } = snapshot;
    const now = this.now();
    let flow: WorkflowDraftFlowView | undefined;
    let flowError: string | undefined;
    let confirmationValid = false;
    let phaseReady = false;
    if (grill.status === 'dag_ready' && grill.dagPath) {
      try {
        const bots = this.deps.loadBots();
        const nameOf = this.deps.nameOf();
        const current = this.currentFlow(runDir, grill, bots, nameOf);
        const roster = await this.plannedRoster(bots, nameOf);
        const probe = plannedGroupProbe(bots, this.deps.isDaemonOnline);
        const eligibility = await checkV3BotExecutorEligibility({ orchestratorAppId: this.deps.appId, targets: current.targets, probe });
        flow = {
          dag: current.dag,
          dagSha256: current.dagSha256,
          plan: projectAdHocBotPlan(runDir, current.targets, this.deps.appId, bots, nameOf, roster),
          flowSummary: current.flowSummary,
          flowSummarySha256: current.flowSummarySha256,
          roster,
          planProblems: eligibility.ok ? [] : eligibility.problems.map((problem) => ({
            ...problem, why: describeV3BotEligibilityCode(problem.code),
          })),
        };
        confirmationValid = this.confirmationValid(draft, current);
        phaseReady = this.flowReady(draft, current);
      } catch (error) {
        flowError = errorText(error);
      }
    }
    let newerPublished: { humanVersion: number; revisionId: string } | undefined;
    if (draft.template) {
      try {
        const metadata = await readSavedWorkflowMetadata(this.libraryDir(), draft.template.workflowId);
        if (metadata.publishedRevision && metadata.publishedRevision !== draft.template.revisionId) {
          const published = await readSavedWorkflowRevision(this.libraryDir(), draft.template.workflowId, metadata.publishedRevision);
          newerPublished = { humanVersion: published.payload.humanVersion, revisionId: published.revisionId };
        }
      } catch { /* unreadable library: nothing to say */ }
    }
    let copyView: WorkflowDraftView['copy'];
    if (draft.copy) {
      const usable = grill.status === 'spec_ready' && this.copyPrefillUsable(grill, draft);
      let prefillDag: V3Dag | undefined;
      if (usable) {
        try { prefillDag = this.loadDag(join(runDir, WORKFLOW_COPY_DAG_FILE)) as V3Dag; } catch { prefillDag = undefined; }
      }
      let specJson: unknown;
      try { specJson = JSON.parse(readFileSync(grill.specJsonPath, 'utf-8')) as unknown; } catch { specJson = undefined; }
      const nodes = flow ? flow.dag.nodes : prefillDag?.nodes;
      const markers = nodes ? unresolvedFlowMarkers(nodes, specJson) : undefined;
      let needsBot: NonNullable<WorkflowDraftView['copy']>['needsBot'];
      if (draft.copy.needsBot) {
        let outstanding: Set<string> | undefined;
        try {
          const roster = await this.plannedRoster(this.deps.loadBots(), this.deps.nameOf());
          outstanding = new Set(this.outstandingCopyBots(draft, roster).map((item) => item.nodeId));
        } catch { outstanding = undefined; }
        needsBot = Object.entries(draft.copy.needsBot).map(([nodeId, entry]) => ({
          nodeId, ...entry, resolved: outstanding ? !outstanding.has(nodeId) : !!draft.nodeBots?.[nodeId],
        }));
      }
      copyView = {
        source: draft.copy.source,
        copiedAt: draft.copy.copiedAt,
        prefilled: usable && !!prefillDag,
        // The requirement changed since the copy (chat, a hand-edited spec):
        // 「确认需求」 orchestrates anew instead of using the copied flow.
        ...(grill.status === 'spec_ready' && draft.copy.prefill && !usable ? { prefillStale: true } : {}),
        ...(prefillDag ? { prefillDag } : {}),
        ...(draft.copy.inputs ? { inputs: draft.copy.inputs } : {}),
        ...(draft.copy.goalEditedAt ? { goalEditedAt: draft.copy.goalEditedAt } : {}),
        ...(needsBot ? { needsBot } : {}),
        ...(markers && (markers.params.length || markers.context.length) ? { unresolved: markers } : {}),
      };
    }
    const specMarkdown = readTextOrUndefined(grill.specPath);
    const specJsonText = grill.status === 'grilling' ? undefined : readTextOrUndefined(grill.specJsonPath);
    let specJson: unknown;
    try { specJson = specJsonText ? JSON.parse(specJsonText) : undefined; } catch { specJson = undefined; }
    let title = draft.goal.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (specJson && typeof (specJson as { title?: unknown }).title === 'string') title = (specJson as { title: string }).title;
    const updatedAt = draft.updatedAt > grill.updatedAt ? draft.updatedAt : grill.updatedAt;
    return {
      runId,
      version: draft.version,
      flowRevision: draft.flowRevision ?? 0,
      orchestratorAppId: draft.orchestratorAppId,
      initiator: draft.initiator,
      goal: draft.goal,
      title,
      phase: workflowDraftPhase(grill, draft, phaseReady),
      grillStatus: grill.status,
      ...(grill.problems?.length ? { problems: grill.problems } : {}),
      createdAt: draft.createdAt,
      updatedAt,
      stale: now.getTime() - Date.parse(updatedAt) >= WORKFLOW_DRAFT_STALE_MS,
      ...(draft.abandonedAt ? { abandonedAt: draft.abandonedAt } : {}),
      clarify: {
        state: draft.clarify.state,
        pending: !!draft.clarify.pending,
        turns: draft.clarify.turns,
        ...(draft.clarify.specCandidate
          ? { specCandidate: { markdown: draft.clarify.specCandidate.markdown, ...(draft.clarify.specCandidate.triggerId ? { triggerId: draft.clarify.specCandidate.triggerId } : {}) } }
          : {}),
        ...(draft.clarify.error ? { error: draft.clarify.error } : {}),
      },
      ...(specMarkdown !== undefined || specJsonText !== undefined
        ? { spec: {
            ...(specMarkdown !== undefined ? { markdown: specMarkdown } : {}),
            ...(specJson !== undefined ? { json: specJson, sha256: fileSha256(grill.specJsonPath) } : {}),
          } }
        : {}),
      ...(draft.specConfirmation ? { specConfirmation: draft.specConfirmation } : {}),
      ...(draft.architect
        ? { architect: {
            ...draft.architect,
            elapsedMs: Math.max(0, (draft.architect.finishedAt ? Date.parse(draft.architect.finishedAt) : now.getTime()) - Date.parse(draft.architect.startedAt)),
          } }
        : {}),
      ...(draft.nodeBots ? { nodeBots: draft.nodeBots } : {}),
      ...(flow ? { flow } : {}),
      ...(flowError ? { flowError } : {}),
      ...(draft.flowConfirmation ? { flowConfirmation: { ...draft.flowConfirmation, valid: confirmationValid } } : {}),
      ...(draft.launch ? { launch: this.launchView(draft, flowTargetsOf(flow), snapshot.launchRunning) } : {}),
      ...(draft.template ? { template: {
        ...draft.template,
        needsConfirmation: workflowTemplateRunNeedsConfirmation(draft),
        swapped: Object.keys(draft.nodeBots ?? {}).length > 0,
        ...(newerPublished ? { newerPublished } : {}),
      } } : {}),
      ...(copyView ? { copy: copyView } : {}),
    };
  }

  // ── lifecycle ──

  /**
   * Daemon boot (§9): no Architect task survives a restart. A draft of this
   * bot left 编排中 goes back to 待编排 with the reason; its next run starts
   * over. Must run before any task is launched in this process.
   */
  recoverInterrupted(): string[] {
    const recovered: string[] = [];
    for (const { runId, runDir } of listWorkflowDraftDirs(this.deps.baseDir)) {
      if (this.tasks.has(runId)) continue;
      try {
        withWorkflowDraftLock(runDir, runId, () => {
          const draft = readWorkflowDraft(runDir);
          const grill = readGrillState(runDir);
          if (!draft || !grill || draft.deletedAt || draft.orchestratorAppId !== this.deps.appId) return;
          if (draft.architect?.state !== 'running' && grill.status !== 'architect_running') return;
          const problems = ['daemon 重启，编排中断了，请重新编排'];
          if (grill.status === 'architect_running') {
            withHostMutationLockSync(runDir, () => {
              if (readGrillState(runDir)?.status === 'architect_running' && !existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) {
                transition(runDir, 'spec_approved', { problems }, this.now());
              }
            });
          }
          if (draft.architect) {
            const settled = settleLostArchitect(draft, readGrillState(runDir)?.status, this.now().toISOString(), problems);
            if (settled === 'succeeded') this.flowChanged(draft, { nodeBots: true });
          }
          this.persist(runDir, draft);
          recovered.push(runId);
        });
      } catch (error) {
        this.log(`[workflow-draft] recovering ${runId} failed: ${errorText(error)}`);
      }
    }
    if (recovered.length > 0) this.log(`[workflow-draft] interrupted architect → 待编排: ${recovered.join(', ')}`);
    // A launch left 拉群中 by the previous process is NOT resumed: the page
    // offers 「继续」 (§4.5). Its dead token is cleared and the reason recorded.
    for (const { runId, runDir } of listWorkflowDraftDirs(this.deps.baseDir, { launched: true })) {
      try {
        withWorkflowDraftLock(runDir, runId, () => {
          const draft = readWorkflowDraft(runDir);
          const launch = draft?.launch;
          if (!draft || !launch || draft.orchestratorAppId !== this.deps.appId) return;
          // Started is final: a later operation that died while holding the
          // launch (a summary resend) leaves it started, not paused.
          if (launch.start && launch.state !== 'started' && launch.state !== 'abandoned') {
            launch.state = 'started';
            delete launch.token;
            delete launch.error;
            this.persist(runDir, draft, { keepUpdatedAt: true });
            return;
          }
          if (launch.state !== 'running') return;
          if (launch.token && this.launchTokens.has(launch.token)) return;
          launch.state = 'paused';
          delete launch.token;
          launch.error = {
            step: 'interrupted', code: 'daemon_restarted', retryable: true,
            message: 'daemon 重启，拉群中断了；点「继续」从中断处接着做', at: this.now().toISOString(),
          };
          launch.updatedAt = this.now().toISOString();
          this.persist(runDir, draft);
        });
      } catch (error) {
        this.log(`[workflow-draft] recovering launch of ${runId} failed: ${errorText(error)}`);
      }
    }
    // Deletes interrupted after their first step are finished now (the
    // session closes run in the background).
    for (const entry of this.interruptedDeletes()) {
      void this.finishDelete(entry.runId, entry.runDir, entry.sessions).catch((error) => {
        this.log(`[workflow-draft] finishing delete of ${entry.runId} failed: ${errorText(error)}`);
      });
    }
    return recovered;
  }

  /**
   * §4.2: release the CLI process of a clarify session idle for 30 minutes
   * (since its last message or reply); the session record stays and the next
   * message resumes it by its CLI session id. Decided under the lock, done
   * outside it (a send meanwhile is refused as busy), recorded under it
   * again. A session whose process cannot be released is not retried until
   * its next message. Also retries failed session closes and finishes
   * interrupted deletes. Returns the drafts suspended.
   */
  async sweepIdleClarify(): Promise<string[]> {
    const due: Array<{ runId: string; sessionId: string }> = [];
    for (const { runId, runDir } of listWorkflowDraftDirs(this.deps.baseDir)) {
      try {
        withWorkflowDraftLock(runDir, runId, () => {
          const draft = readWorkflowDraft(runDir);
          if (!draft || draft.deletedAt || draft.orchestratorAppId !== this.deps.appId) return;
          for (const orphan of draft.orphanSessions ?? []) {
            if (!this.orphans.has(orphan.sessionId)) this.orphans.set(orphan.sessionId, orphan);
          }
          if (draft.abandonedAt) return;
          const refreshed = this.refreshClarifyInPlace(draft);
          if (refreshed) this.persist(runDir, draft, { keepUpdatedAt: refreshed !== 'activity' });
          // 拉群开始 began: the clarify session is about to move (or moved)
          // into the main topic — its lifetime is the topic's now (§4.2).
          if (draft.launch || clarifySessionInTopic(draft)) return;
          const { clarify } = draft;
          if (clarify.state !== 'active' || clarify.pending || !clarify.sessionId || !clarify.lastMessageAt) return;
          if (this.suspending.has(clarify.sessionId)) return;
          if (clarify.suspendRefusedAt && clarify.suspendRefusedAt >= clarify.lastMessageAt) return;
          if (this.now().getTime() - Date.parse(clarify.lastMessageAt) < DRAFT_CLARIFY_IDLE_MS) return;
          this.suspending.add(clarify.sessionId);
          due.push({ runId, sessionId: clarify.sessionId });
        });
      } catch { /* next sweep */ }
    }
    await this.retryOrphanCloses();
    const suspended: string[] = [];
    for (const entry of due) {
      let ok = false;
      try {
        try { ok = await this.deps.clarifier.suspend(entry.sessionId); } catch { ok = false; }
        this.mutate(entry.runId, undefined, { allowAbandoned: true }, ({ draft }) => {
          if (draft.clarify.sessionId !== entry.sessionId || draft.clarify.state !== 'active' || draft.clarify.pending || draft.launch) {
            return { changed: false, result: undefined };
          }
          if (ok) {
            draft.clarify.state = 'suspended';
            draft.clarify.suspendedAt = this.now().toISOString();
            delete draft.clarify.suspendRefusedAt;
          } else {
            draft.clarify.suspendRefusedAt = this.now().toISOString();
          }
          return { changed: true, result: undefined };
        });
        if (ok) suspended.push(entry.runId);
        else this.log(`[workflow-draft] clarify session ${entry.sessionId} of ${entry.runId} could not release its process; not retried until its next message`);
      } catch { /* recorded next sweep */ } finally {
        this.suspending.delete(entry.sessionId);
      }
    }
    for (const entry of this.interruptedDeletes()) {
      try { await this.finishDelete(entry.runId, entry.runDir, entry.sessions); } catch { /* next sweep */ }
    }
    return suspended;
  }

  /** Retry clarify-session closes that failed (abandon / delete / replace). */
  private async retryOrphanCloses(): Promise<void> {
    for (const entry of [...this.orphans.values()]) {
      try {
        await this.deps.clarifier.close(entry);
      } catch {
        continue;
      }
      this.orphans.delete(entry.sessionId);
      for (const { runId, runDir } of listWorkflowDraftDirs(this.deps.baseDir)) {
        const draft = readWorkflowDraft(runDir);
        if (!draft?.orphanSessions?.some((item) => item.sessionId === entry.sessionId) || draft.deletedAt) continue;
        try {
          this.mutate(runId, undefined, { allowAbandoned: true }, ({ draft: current }) => {
            const rest = (current.orphanSessions ?? []).filter((item) => item.sessionId !== entry.sessionId);
            if (rest.length === (current.orphanSessions ?? []).length) return { changed: false, result: undefined };
            if (rest.length > 0) current.orphanSessions = rest; else delete current.orphanSessions;
            return { changed: true, result: undefined };
          });
        } catch { /* stays listed; closing again is harmless */ }
      }
    }
  }
}
