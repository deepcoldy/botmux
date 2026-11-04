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
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { BotConfig } from '../../bot-registry.js';
import { isStewardBot } from '../../core/decision-board/model.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { birthRun, readGrillState, transition, type GrillState } from './grill-state.js';
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
import type { V3Dag } from './dag.js';
import { validateSpec } from './spec.js';
import { freezeDagBotSnapshots } from './bot-resolve.js';
import { V3_RUN_ENVELOPE_FILE, readRunEnvelope, type V3RunInitiator } from './run-envelope.js';
import type { RunChatBinding } from './grill-state.js';
import { v3FlowSummarySha256, type V3FlowSummary } from './flow-summary.js';
import {
  buildV3BotRoster,
  planV3SketchAssignees,
  v3BotStaticExclusion,
  v3RosterSelectorProblems,
  type V3BotRoster,
  type V3Gate2BotPlan,
} from './bot-assignment.js';
import {
  checkV3BotExecutorEligibility,
  describeV3BotEligibilityCode,
  judgeV3BotEligibility,
  v3BotExecutorTargets,
  type V3BotEligibilityProbe,
  type V3BotEligibilityProblem,
  type V3NodeExecutorTarget,
} from './node-executor-mode.js';
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
  type WorkflowDraftTurn,
} from './draft-store.js';
import { readLinuxBootIdentity, readProcessStartIdentity } from '../../utils/process-identity.js';
import { pidIsSignalable } from '../../utils/process-alive.js';
import {
  buildDraftClarifyKickoff,
  buildDraftClarifyResume,
  buildDraftSpecProblemsTurn,
  parseDraftClarifyOutput,
} from './draft-clarify.js';
import {
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
    return this.code === 'busy' || this.code === 'clarify_unavailable' || this.code === 'launch_running';
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

/** Every clarify session a draft knows of (current + ones whose close failed). */
function draftSessions(draft: WorkflowDraftRecord): Array<{ sessionId: string; headlessId?: string }> {
  const out = new Map<string, { sessionId: string; headlessId?: string }>();
  for (const item of draft.orphanSessions ?? []) out.set(item.sessionId, item);
  // A session moved into the main topic is that topic's now, not the draft's.
  if (draft.clarify.sessionId && draft.clarify.state !== 'migrated') {
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
        if (out.changed || refreshed || healed) this.persist(runDir, draft);
        return out.result;
      });
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private persist(runDir: string, draft: WorkflowDraftRecord): void {
    draft.version += 1;
    draft.updatedAt = this.now().toISOString();
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
  private refreshClarifyInPlace(draft: WorkflowDraftRecord): boolean {
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
      return true;
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
    }
    return true;
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
      try {
        hostApproveSpec(runDir, this.now());
      } catch (error) {
        delete draft.specConfirmation;
        this.persist(runDir, draft);
        throw error;
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
          problems = v3RosterSelectorProblems(dag, roster);
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
      const launch = draft.launch;
      return {
        changed: true,
        result: launch?.chat && launch.grants && Object.keys(launch.grants).length > 0
          ? { chatId: launch.chat.chatId, grants: structuredClone(launch.grants), runDir, grill }
          : undefined,
      };
    });
    // §4.5 第 6 步: a bot swapped out of a launched group keeps no grant there.
    // Best effort now; the launch's grant step retries (and waits for it).
    if (stale && this.deps.launch) {
      try {
        const grill = readGrillState(stale.runDir) ?? stale.grill;
        const wanted = this.launchFlow(stale.runDir, grill).botTargets;
        const failed = await this.revokeStaleLaunchGrants(runId, undefined, wanted, stale.chatId, stale.grants);
        if (failed) this.log(`[workflow-draft] ${failed} (retried at 「继续」)`);
      } catch (error) {
        this.log(`[workflow-draft] revoking swapped-out grants of ${runId} failed: ${errorText(error)}`);
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
    this.mutate(runId, initiator, { baseVersion: input.baseVersion }, ({ draft, grill, runDir }) => {
      this.assertNotArchitecting(runId, draft, grill);
      this.assertStatus(grill, ['dag_ready'], '确认流程');
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
      this.assertNoLaunch(draft, '退回改需求');
      this.assertNotArchitecting(runId, draft, grill);
      this.assertStatus(grill, ['spec_ready', 'spec_approved', 'dag_ready'], '退回改需求');
      hostReviseSpec(runDir, this.now());
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
      if (draft.clarify.state === 'migrated') return { changed: true, result: { old: {}, note: !!draft.launch?.root } };
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
    const sessions = this.mutate(runId, initiator, { allowAbandoned: true, allowDeleted: true }, ({ draft, grill }) => {
      if (!draft.deletedAt) {
        this.assertNotArchitecting(runId, draft, grill);
        const last = Math.max(Date.parse(draft.updatedAt), Date.parse(grill.updatedAt));
        if (!draft.abandonedAt && this.now().getTime() - last < WORKFLOW_DRAFT_STALE_MS) {
          throw err('draft_not_stale', '只能删除已放弃或 30 天没有动静的草稿');
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
    if (!draft.flowConfirmation || !this.confirmationValid(draft, flow)) {
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
    if (!members.ok) throw err('bad_request', members.message);
    const bots = this.deps.loadBots();
    const nameOf = this.deps.nameOf();
    const token = this.reserveLaunch();
    try {
      // `launched`: a second 「拉群开始」 after the start still answers launch_exists.
      this.mutate(runId, initiator, { baseVersion: input.baseVersion, launchOp: true, launched: true }, ({ draft, grill, runDir }) => {
        if (draft.launch) throw err('launch_exists', '已经开始拉群了，点「继续」从中断处接着做');
        if (this.launchRunning(draft)) throw err('launch_running', '正在拉群');
        this.assertNotArchitecting(runId, draft, grill);
        this.assertFlowConfirmed(runDir, draft, grill, bots, nameOf);
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
      let chats: Array<{ chatId: string; name?: string }>;
      try {
        chats = await deps.listChats();
      } catch (error) {
        this.stopLaunch(runId, token, {
          step: 'group', code: 'list_chats_failed', retryable: true,
          message: `上次建群的结果没记录下来，查主 Bot 所在的群失败；为了不重复建群先停在这里：${errorText(error)}`,
        });
        return false;
      }
      const matches = chats.filter((chat) => groupNameHasMarker(chat.name, launch.marker));
      if (matches.length > 0) {
        this.recordLaunchChat(runId, token, { chatId: matches[0]!.chatId, recovered: true });
        if (matches.length > 1) {
          this.launchTx(runId, token, ({ launch: current }) => {
            const known = new Set((current.orphanSuspects ?? []).map((item) => item.chatId));
            const extra = matches.slice(1).filter((chat) => !known.has(chat.chatId))
              .map((chat) => ({ chatId: chat.chatId, ...(chat.name ? { name: chat.name.slice(0, 200) } : {}), note: '群名带同一个标记的另一个群' }));
            if (extra.length === 0) return { changed: false, result: undefined };
            current.orphanSuspects = [...(current.orphanSuspects ?? []), ...extra].slice(-50);
            return { changed: true, result: undefined };
          });
        }
        return true;
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

  /** Step 3: the root card of the main topic (E6). */
  private async launchRootStep(runId: string, token: string): Promise<boolean> {
    const snap = this.launchTx(runId, token, ({ runDir, draft, launch, grill }) => ({
      changed: false,
      result: {
        chatId: launch.chat!.chatId,
        view: this.rootCardView(runId, draft, grill, this.launchFlow(runDir, grill).targets.length),
        // The same uuid on a resend: Feishu answers it with the first message.
        uuid: `wf-root-${launch.marker.slice(1)}-${launch.chat!.chatId.slice(-24)}`,
      },
    }));
    if (!snap.held) return false;
    let messageId: string;
    try {
      messageId = await this.deps.launch!.postRootCard(snap.result.chatId, snap.result.view, snap.result.uuid);
    } catch (error) {
      this.stopLaunch(runId, token, { step: 'root', code: 'post_root_failed', message: `发主话题卡片失败：${errorText(error)}`, retryable: true });
      return false;
    }
    const recorded = this.launchTx(runId, token, ({ launch }) => {
      if (launch.root) return { changed: false, result: undefined };
      launch.root = { messageId, at: this.now().toISOString() };
      return { changed: true, result: undefined };
    });
    return recorded.held;
  }

  /** Step 4: the clarify session moves into the main topic, then a summary
   *  is posted there (E7). A session that no longer exists does not hold
   *  the launch up: the topic then gets its session from its first message. */
  private async launchMigrateStep(runId: string, token: string): Promise<boolean> {
    const deps = this.deps.launch!;
    const snap = this.launchTx(runId, token, ({ draft, launch, grill }) => {
      const spec = this.specFacts(grill);
      return {
        changed: false,
        result: {
          chatId: launch.chat!.chatId,
          rootMessageId: launch.root!.messageId,
          session: draft.clarify.sessionId && draft.clarify.state !== 'disconnected' && draft.clarify.state !== 'closed'
            ? { sessionId: draft.clarify.sessionId, ...(draft.clarify.headlessId ? { headlessId: draft.clarify.headlessId } : {}) }
            : undefined,
          summary: {
            runId,
            title: this.titleOf(draft, grill),
            goal: draft.goal,
            ...(spec?.requirement ? { requirement: spec.requirement } : {}),
            nodes: spec?.nodes ?? [],
          } satisfies LaunchSummaryView,
          uuid: `wf-sum-${launch.marker.slice(1)}-${launch.root!.messageId.slice(-24)}`,
        },
      };
    });
    if (!snap.held) return false;
    const { chatId, rootMessageId, session, summary, uuid } = snap.result;
    let bound: Awaited<ReturnType<DraftLaunchDeps['bindSession']>>;
    if (!session) {
      bound = { ok: false, error: '澄清会话已断开', unavailable: true };
    } else {
      try {
        bound = await deps.bindSession({ ...session, chatId, rootMessageId, title: summary.title });
      } catch (error) {
        bound = { ok: false, error: errorText(error), unavailable: false };
      }
    }
    if (!bound.ok && !bound.unavailable) {
      this.stopLaunch(runId, token, { step: 'migrate', code: 'bind_failed', message: `澄清会话迁入主话题失败：${bound.error}`, retryable: true });
      return false;
    }
    const recorded = this.launchTx(runId, token, ({ draft, launch }) => {
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
    });
    if (!recorded.held) return false;
    // The summary is for people (not compared with anything); its failure is
    // shown, not retried into a second message.
    let summaryMessageId: string | undefined;
    let summaryError: string | undefined;
    try {
      summaryMessageId = await deps.postSummary(rootMessageId, {
        ...summary,
        ...(bound.ok ? {} : { sessionNote: `澄清会话没能迁入（${bound.error}），在主话题里发消息会开一个新会话` }),
      }, uuid);
    } catch (error) {
      summaryError = errorText(error);
    }
    return this.launchTx(runId, token, ({ launch }) => {
      if (!launch.migrate) return { changed: false, result: undefined };
      if (summaryMessageId) launch.migrate.summaryMessageId = summaryMessageId;
      if (summaryError) launch.migrate.summaryError = clip(summaryError, 2000);
      return { changed: true, result: undefined };
    }).held;
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

  /** Revoke the grants of bots that no longer execute any node (both sides,
   *  by the open_ids recorded when they were written — no membership needed). */
  private async revokeStaleLaunchGrants(runId: string, token: string | undefined, wanted: readonly string[], chatId: string,
    grants: NonNullable<WorkflowDraftLaunch['grants']>): Promise<string | undefined> {
    const deps = this.deps.launch!;
    for (const [appId, grant] of Object.entries(grants)) {
      if (wanted.includes(appId)) continue;
      try {
        if (grant.mainSide) await deps.revoke(chatId, this.deps.appId, grant.mainSide);
        if (grant.peerSide) await deps.revoke(chatId, appId, grant.peerSide);
      } catch (error) {
        return `撤销 ${this.deps.nameOf()(appId)} 在这个群的协作授权失败：${errorText(error)}`;
      }
      const drop = ({ launch }: { launch: WorkflowDraftLaunch }) => {
        if (!launch.grants?.[appId]) return { changed: false, result: undefined };
        delete launch.grants[appId];
        if (Object.keys(launch.grants).length === 0) delete launch.grants;
        return { changed: true, result: undefined };
      };
      if (token) {
        if (!this.launchTx(runId, token, drop).held) return undefined;
      } else {
        this.mutate(runId, undefined, { launchOp: true, launched: true, allowAbandoned: true }, ({ draft }) =>
          draft.launch ? drop({ launch: draft.launch }) : { changed: false, result: undefined });
      }
      this.log(`[workflow-draft] launch ${runId}: revoked chat grants of ${appId} in ${chatId}`);
    }
    return undefined;
  }

  /** Step 6: grants between the main bot and every executing bot that
   *  passed step 5, after revoking those of bots swapped out. Idempotent. */
  private async launchGrantStep(runId: string, token: string): Promise<boolean> {
    const snap = this.launchTx(runId, token, ({ runDir, launch, grill }) => ({
      changed: false,
      result: { chatId: launch.chat!.chatId, grants: structuredClone(launch.grants ?? {}), wanted: this.launchFlow(runDir, grill).botTargets },
    }));
    if (!snap.held) return false;
    const { chatId, grants, wanted } = snap.result;
    const revokeError = await this.revokeStaleLaunchGrants(runId, token, wanted, chatId, grants);
    if (revokeError) {
      this.stopLaunch(runId, token, { step: 'grant', code: 'revoke_failed', message: revokeError, retryable: true });
      return false;
    }
    const deps = this.deps.launch!;
    for (const appId of wanted) {
      const have = grants[appId];
      for (const side of ['mainSide', 'peerSide'] as const) {
        if (have?.[side]) continue;
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
          const current = launch.grants?.[appId] ?? { at: this.now().toISOString() };
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
  private async launchCommitStep(runId: string, token: string): Promise<boolean> {
    const bots = this.deps.loadBots();
    const nameOf = this.deps.nameOf();
    const out = this.launchTx(runId, token, ({ runDir, draft, launch, grill }) => {
      const chatId = launch.chat!.chatId;
      const rootMessageId = launch.root!.messageId;
      const envelopePath = join(runDir, V3_RUN_ENVELOPE_FILE);
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
      }
      const confirmation = draft.flowConfirmation;
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
    if (out.result === 'committed') this.log(`[workflow-draft] launch ${runId}: run.json written`);
    return true;
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
      this.mutate(runId, undefined, { allowAbandoned: true, launchOp: true, launched: true }, ({ draft }) => {
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
        if (refreshed || healed) this.persist(runDir, loaded.draft);
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
      } catch (error) {
        flowError = errorText(error);
      }
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
      phase: workflowDraftPhase(grill, draft, confirmationValid),
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
          if (!draft || !launch || draft.orchestratorAppId !== this.deps.appId || launch.state !== 'running') return;
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
          if (refreshed) this.persist(runDir, draft);
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
          if (draft.clarify.sessionId !== entry.sessionId || draft.clarify.state !== 'active' || draft.clarify.pending) {
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
