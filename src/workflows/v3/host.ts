/**
 * v3 grill host controller.
 *
 * The thin orchestration layer that drives a run through the grill → architect
 * → human-approval pipeline.  It is NOT the v3 runtime and NOT the ephemeral
 * pool — it is the `botmux workflow <sub>` command surface the grill skill
 * shells out to, plus the grill.state.json status machine (grill-state.ts).
 *
 *   workflow new "<goal>"        → birth run (runId/runDir), status=grilling
 *   workflow spec-finalize <id>  → parse+validate spec.md → spec.json → spec_ready
 *   workflow approve-spec <id>   → gate-1: spec_ready → spec_approved
 *   workflow architect <id>      → spec_approved → architect_running → (runArchitect
 *                                  + host validateDag) → dag_ready | retreat
 *   workflow approve-dag <id>    → gate-2: dag_ready → dag_approved → kick daemon start
 *
 * The CORE operations below take injected deps so they unit-test without a real
 * worker; the CLI wrapper resolves real bot/secret + codex's `runArchitect` +
 * dag.ts's `loadDag`.  grill state is a conversation worktable — it does NOT
 * write the runtime journal (codex 2026-06-02).
 */
import { existsSync, readFileSync } from 'node:fs';
import { WORKFLOW_DRAFT_FILE } from './draft-store.js';
import { join, resolve, sep } from 'node:path';
import { loadBotConfigs, type BotConfig } from '../../bot-registry.js';
import { validateWorkingDir } from '../../core/working-dir.js';
import { checkBotWorkingDir, realWorkingDir } from '../../core/working-dir-range.js';
import { resolveCurrentTurnProvenance } from '../../core/current-turn-provenance.js';
import { isHumanInboundTurnId } from '../../core/reply-target.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../../utils/file-lock.js';
import {
  birthRun,
  GRILL_STATUS_FILE,
  readGrillState,
  transition,
  defaultBaseDir,
  type BirthResult,
  type GrillState,
  type RunChatBinding,
} from './grill-state.js';
import { finalizeSpec, validateSpec, SpecValidationError } from './spec.js';
import { runArchitect as realRunArchitect, type RunArchitectInput, type RunArchitectResult } from './architect.js';
import { loadDag } from './dag-loader.js';
import { DagValidationError } from './dag.js';
import { isValidRunId } from './ops-projection.js';
import {
  botToSnapshot,
  freezeDagBotSnapshots,
  resolveBotConfig,
  serializeFrozenBotSnapshots,
} from './bot-resolve.js';
import {
  artifactRef,
  feishuRunInitiator,
  frozenHandoffIdentity,
  frozenNodeWorkingDir,
  loadAuthorizedV3Run,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
  readRunEnvelope,
  type PublishRunEnvelopeResult,
  type V3AdHocRunEnvelope,
  type V3FlowConfirmation,
  type V3HandoffIdentityRecord,
  type V3RunInitiator,
} from './run-envelope.js';
import { buildV3FlowSummary, v3FlowSummarySha256 } from './flow-summary.js';
import { V3_SUPPORTED_CLIS, isV3SupportedCli, type BotSnapshot } from './contract.js';
import { isMultiTopicOrchestrationEnabled, workflowHandoffIdentityEnabled, workflowNodeExecutorMode } from '../../global-config.js';
import {
  buildV3BotRoster,
  checkV3Assignees,
  formatV3Gate2BotPlan,
  parseV3AssignmentReasons,
  parseV3PlacementReasons,
  projectV3Gate2BotPlan,
  planV3SketchAssignees,
  v3AssigneeProblems,
  v3RosterSelectorProblems,
  type V3ArchitectBotAssignment,
  type V3BotRoster,
} from './bot-assignment.js';
import { isGoalNode, type V3Dag } from './dag.js';
import { v3PlacementProblems, type V3MainTopicAvailability } from './placement.js';
import {
  checkV3BotExecutorEligibility,
  decideV3NodeExecutor,
  describeV3EphemeralFallback,
  describeV3NodeWorkingDir,
  formatV3BotEligibilityRefusal,
  formatV3PlacementRefusal,
  resolveV3HandoffIdentity,
  v3BotExecutorTargets,
  v3TargetPlacementProblems,
  type V3BotEligibilityProbe,
  type V3HandoffIdentityPolicy,
  type V3BotEligibilityProblem,
  type V3NodeExecutorDecision,
  type V3NodeExecutorSwitch,
  type V3NodeExecutorTarget,
} from './node-executor-mode.js';

// ─── Core operations (dep-injected, pure of CLI / process concerns) ─────────

export function hostNew(opts: {
  goal: string;
  baseDir?: string;
  runId?: string;
  now?: Date;
  chatBinding?: RunChatBinding;
}): BirthResult {
  return birthRun(opts);
}

/**
 * Resolve the grill command's *current-turn* caller into a chat binding.
 * Static worker env is intentionally not an authority: BOTMUX_OWNER_OPEN_ID is
 * the session owner and BOTMUX_TURN_ID/root values go stale in a long-lived
 * CLI. In-session commands must join the fresh process-tree marker to the
 * durable session record; detached/stale calls fail closed.
 *
 * A genuine standalone/dev invocation (no session claim or marker) keeps the
 * old minimal env binding for card experiments, but never claims an owner.
 */
/** The current authenticated turn's id (undefined for a standalone/dev
 *  invocation). Same proof as {@link chatBindingFromEnv}. */
export function currentTurnIdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  startPid: number = process.ppid,
): string | undefined {
  if (!env.SESSION_DATA_DIR) return undefined;
  return resolveCurrentTurnProvenance({
    dataDir: env.SESSION_DATA_DIR,
    envSessionId: env.BOTMUX_SESSION_ID,
    startPid,
  })?.turnId;
}

/**
 * The person who confirms by running this command: the caller of the current
 * turn, only when a human message opened it (`om_…` / `join_…`) AND the
 * provenance proves that caller is a human (a peer bot's message opens an
 * `om_` turn too). A wake-up the main bot acted on by itself — even one a
 * newer message overtook — has no confirmer. Undefined = unknown; callers
 * record nothing rather than guess. May throw like the provenance resolver.
 */
export function currentTurnConfirmerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  startPid: number = process.ppid,
): string | undefined {
  if (!env.SESSION_DATA_DIR) return undefined;
  const provenance = resolveCurrentTurnProvenance({
    dataDir: env.SESSION_DATA_DIR,
    envSessionId: env.BOTMUX_SESSION_ID,
    startPid,
  });
  if (!provenance || !isHumanInboundTurnId(provenance.turnId)) return undefined;
  if (provenance.callerProvenHuman !== true) return undefined;
  if (provenance.workflowRunEvent || provenance.overtakenWorkflowRunEvent) return undefined;
  return provenance.callerOpenId;
}

export function chatBindingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  startPid: number = process.ppid,
): RunChatBinding | undefined {
  if (env.SESSION_DATA_DIR) {
    const provenance = resolveCurrentTurnProvenance({
      dataDir: env.SESSION_DATA_DIR,
      envSessionId: env.BOTMUX_SESSION_ID,
      startPid,
    });
    if (provenance) {
      return {
        larkAppId: provenance.larkAppId,
        chatId: provenance.chatId,
        ...(provenance.chatType ? { chatType: provenance.chatType } : {}),
        ...(provenance.rootMessageId ? { rootMessageId: provenance.rootMessageId } : {}),
        sessionId: provenance.sessionId,
        ownerOpenId: provenance.callerOpenId,
      };
    }
  } else if (env.BOTMUX_SESSION_ID) {
    throw new Error(
      '当前命令声称来自 botmux session，但 SESSION_DATA_DIR 不可用，无法验证本轮调用者',
    );
  }

  // Standalone/dev only. BOTMUX_OWNER_OPEN_ID is deliberately ignored: it is
  // never proof of the human who invoked this turn.
  const larkAppId = env.BOTMUX_LARK_APP_ID;
  const chatId = env.BOTMUX_CHAT_ID;
  if (!larkAppId || !chatId) return undefined;
  return {
    larkAppId,
    chatId,
    ...(env.BOTMUX_CHAT_TYPE === 'group' || env.BOTMUX_CHAT_TYPE === 'p2p'
      ? { chatType: env.BOTMUX_CHAT_TYPE }
      : {}),
    ...(env.BOTMUX_ROOT_MESSAGE_ID ? { rootMessageId: env.BOTMUX_ROOT_MESSAGE_ID } : {}),
  };
}

/**
 * Authorize a non-`new` host mutation against the principal captured when the
 * grill was born. A workflow started in chat is owned by that exact
 * (app, chat, caller) tuple; a later message from the session's static owner or
 * from another participant must not be able to finalize/approve it merely by
 * knowing the run id.
 *
 * Unbound standalone/dev runs remain operable from a standalone CLI. Legacy
 * bindings without an authenticated owner are also dev-only: an in-session
 * caller cannot upgrade them into an owned authorization implicitly.
 */
export function assertWorkflowHostCaller(
  runDir: string,
  current: RunChatBinding | undefined,
): void {
  const state = mustRead(runDir);
  // A Dashboard draft (design 2026-11-03 workflow-dashboard-orchestration
  // §4.2, E2) is advanced only by its orchestrating bot's daemon, for its
  // recorded initiator; no CLI caller may stand in for that person.
  if (existsSync(join(runDir, WORKFLOW_DRAFT_FILE))) {
    throw new HostGuardError(`run ${state.runId} 是 Dashboard 草稿，只能在 Dashboard 上操作`);
  }
  const target = state.chatBinding;
  if (!target) {
    if (current?.ownerOpenId) {
      throw new HostGuardError(
        `run ${state.runId} 是未绑定的 standalone/dev run，不能从 botmux chat turn 修改`,
      );
    }
    return;
  }

  if (!target.ownerOpenId) {
    if (current?.ownerOpenId) {
      throw new HostGuardError(
        `run ${state.runId} 的 chatBinding 缺少已认证 owner，不能从 botmux chat turn 修改`,
      );
    }
    return;
  }
  if (!current?.ownerOpenId) {
    throw new HostGuardError(`run ${state.runId} 绑定了 chat caller，当前命令缺少本轮调用者认证`);
  }
  if (
    current.ownerOpenId !== target.ownerOpenId
    || current.larkAppId !== target.larkAppId
    || current.chatId !== target.chatId
  ) {
    throw new HostGuardError(
      `当前 caller/chat/bot 与 run ${state.runId} 的 grill.chatBinding 不匹配`,
    );
  }
}

export interface SpecFinalizeOutcome {
  ok: boolean;
  state?: GrillState;
  /** Present on failure — the parse/validate problems that BLOCK handoff. */
  problems?: string[];
}

/**
 * All grill-host read/modify/write transactions share one run-scoped lock.
 * `architect` holds it across the worker await because the worker always
 * reuses `architect/attempts/001` and begins by deleting that directory.
 * Without the lock, two calls can delete/mix one another's attempt artifacts.
 *
 * Lock order is deliberately fixed as:
 *
 *   grill.state.json.lock -> run.json.lock
 *
 * Gate-2 authorization follows that order below. No path may acquire the
 * grill lock while already holding run.json.lock, keeping the two-lock
 * transaction deadlock-free.
 */
const HOST_MUTATION_LOCK_WAIT_MS = 500;

function hostMutationLockTarget(runDir: string): string {
  return join(runDir, GRILL_STATUS_FILE);
}

function hostBusyError(runDir: string): HostGuardError {
  return new HostGuardError(
    `run ${mustRead(runDir).runId} 正在执行另一个 workflow host mutation，请稍后重试`,
  );
}

export function withHostMutationLockSync<T>(runDir: string, fn: () => T): T {
  try {
    return withFileLockSync(hostMutationLockTarget(runDir), fn, {
      maxWaitMs: HOST_MUTATION_LOCK_WAIT_MS,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('file-lock timeout waiting for ')) {
      throw hostBusyError(runDir);
    }
    throw err;
  }
}

async function withHostMutationLock<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withFileLock(hostMutationLockTarget(runDir), fn, {
      maxWaitMs: HOST_MUTATION_LOCK_WAIT_MS,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('file-lock timeout waiting for ')) {
      throw hostBusyError(runDir);
    }
    throw err;
  }
}

/**
 * run.json is the create-once execution commit. Once it exists, the mutable
 * grill worktable and every artifact producer must stop: otherwise a
 * post-Gate-2 revise/architect/finalize could overwrite bytes whose digests are
 * already pinned by the envelope. Invalid envelopes also fail closed.
 *
 * Caller must hold the run-scoped host mutation lock.
 */
function assertRunNotCommitted(runDir: string, cur: GrillState, operation: string): void {
  const envelope = readRunEnvelope(runDir, cur.runId);
  if (envelope.kind === 'missing') return;
  if (envelope.kind === 'invalid') {
    throw new HostGuardError(
      `${operation} 被拒绝：run.json 已存在但无效（${envelope.problems.join('; ')}）`,
    );
  }
  throw new HostGuardError(
    `${operation} 被拒绝：run.json 已发布，Gate-2 execution artifacts 已不可变`,
  );
}

/** Parse + validate spec.md → write spec.json → status=spec_ready.  On a
 *  SpecValidationError, returns {ok:false, problems} and leaves status untouched
 *  (grill stays grilling and relays the problems to the user). */
export function hostSpecFinalize(runDir: string, now: Date = new Date()): SpecFinalizeOutcome {
  return withHostMutationLockSync(runDir, () => {
    const cur = mustRead(runDir);
    assertRunNotCommitted(runDir, cur, 'spec-finalize');
    // Guard the status BEFORE finalizeSpec writes spec.json — otherwise an
    // illegal-state call (e.g. re-finalizing after the spec was approved /
    // architected) would overwrite spec.json and only THEN hit the rejected
    // transition, leaving state ⇄ canonical-spec inconsistent.
    // Legal from `grilling` (first finalize) and `spec_ready` (Gate-1 re-draft,
    // re-validate in place).  To revise after spec_approved/dag_ready, step back
    // with `revise-spec` first.
    if (cur.status !== 'grilling' && cur.status !== 'spec_ready') {
      throw new HostGuardError(
        `spec-finalize 需要 status=grilling 或 spec_ready，当前 ${cur.status}（先 revise-spec 退回改稿）`,
      );
    }
    try {
      finalizeSpec(cur.specPath, cur.specJsonPath, cur.runId);
    } catch (err) {
      if (err instanceof SpecValidationError) return { ok: false, problems: err.problems };
      throw err;
    }
    const state = transition(runDir, 'spec_ready', { problems: undefined }, now);
    return { ok: true, state };
  });
}

/** gate-1: spec_ready → spec_approved.  Rejects unless status is spec_ready. */
export function hostApproveSpec(runDir: string, now: Date = new Date()): GrillState {
  return withHostMutationLockSync(runDir, () => {
    const cur = mustRead(runDir);
    assertRunNotCommitted(runDir, cur, 'approve-spec');
    if (cur.status !== 'spec_ready') {
      throw new HostGuardError(`approve-spec 需要 status=spec_ready，当前 ${cur.status}`);
    }
    return transition(runDir, 'spec_approved', {}, now);
  });
}

export interface ArchitectDeps {
  runArchitect: (input: RunArchitectInput) => Promise<RunArchitectResult>;
  /** Throws on an invalid dag (dag.ts loadDag). */
  loadDag: (path: string) => unknown;
  botSnapshot: BotSnapshot;
  resolveLarkAppSecret: (larkAppId: string) => string | undefined | Promise<string | undefined>;
  timeoutMs?: number;
  cancelSignal?: AbortSignal;
  /** Bot runs only (design 2026-11-03 §6): the roster the Architect assigns
   *  from; its dag is then also checked to use roster bots only. */
  botAssignment?: V3ArchitectBotAssignment;
}

export interface ArchitectOutcome {
  ok: boolean;
  state: GrillState;
  problems?: string[];
}

/**
 * spec_approved → architect_running → runArchitect → host loadDag/validateDag.
 * Encodes codex's three assertions:
 *  1. rejects unless status=spec_approved (don't skip gate-1);
 *  2. runArchitect-fail OR validateDag-fail → retreat to spec_approved with the
 *     problems recorded in grill.state.json (so grill can fix the spec) — NOT
 *     dag_ready;
 *  3. on success → dag_ready records dagPath/notesPath/architectManifestPath so
 *     approve-dag and the dashboard never re-guess paths.
 */
export async function hostArchitect(runDir: string, deps: ArchitectDeps, now: Date = new Date()): Promise<ArchitectOutcome> {
  return withHostMutationLock(runDir, async () => {
    const cur = mustRead(runDir);
    assertRunNotCommitted(runDir, cur, 'architect');
    // Accept `spec_approved` (the normal entry) AND `architect_running`
    // (crash-recovery): a prior architect run can be killed AFTER it persisted
    // `architect_running` but BEFORE it could retreat to spec_approved, leaving
    // the status stuck mid-flight.  Without this, the only path out of
    // `architect_running` would be a manual edit — re-running architect would
    // dead-end behind a spec_approved-only guard.
    if (cur.status !== 'spec_approved' && cur.status !== 'architect_running') {
      throw new HostGuardError(`architect 需要 status=spec_approved（先 approve-spec），当前 ${cur.status}`);
    }
    transition(runDir, 'architect_running', { problems: undefined }, now);

    let res: RunArchitectResult;
    try {
      res = await deps.runArchitect({
        runId: cur.runId,
        runDir,
        specPath: cur.specPath,
        specJsonPath: cur.specJsonPath,
        botSnapshot: deps.botSnapshot,
        resolveLarkAppSecret: deps.resolveLarkAppSecret,
        timeoutMs: deps.timeoutMs,
        cancelSignal: deps.cancelSignal,
        ...(deps.botAssignment ? { botAssignment: deps.botAssignment } : {}),
      });
    } catch (err) {
      // Defense in depth: intended Gate-2 publication also takes this host
      // lock, but a foreign/older publisher might not. Never mutate grill
      // state after any run.json appeared during the awaited worker call.
      assertRunNotCommitted(runDir, mustRead(runDir), 'architect');
      const problems = [err instanceof Error ? err.message : String(err)];
      const state = transition(runDir, 'spec_approved', { problems }, now);
      return { ok: false, state, problems };
    }

    assertRunNotCommitted(runDir, mustRead(runDir), 'architect');
    if (res.status !== 'ok' || !res.dagPath || !res.notesPath) {
      const problems = res.problems ?? [
        !res.dagPath ? 'architect 未产出 dag.json' : undefined,
        !res.notesPath ? 'architect 未产出 architect-notes.md' : undefined,
      ].filter((p): p is string => Boolean(p));
      const state = transition(runDir, 'spec_approved', { problems }, now);
      return { ok: false, state, problems };
    }

    // Assertion 2: do NOT trust architect's self-claim — host validates the dag.
    try {
      const dag = deps.loadDag(res.dagPath);
      if (typeof dag !== 'object' || dag === null || (dag as { schemaVersion?: unknown }).schemaVersion !== 2) {
        throw new DagValidationError(['architect dag.json must use schemaVersion 2']);
      }
      if (deps.botAssignment) {
        const mainApp = deps.botAssignment.roster.mainLarkAppId;
        const problems = [
          ...v3RosterSelectorProblems(dag as V3Dag, deps.botAssignment.roster),
          ...v3AssigneeProblems(dag as V3Dag, deps.botAssignment),
          // §5.2 hard rules: sent back to the Architect to re-place.
          ...v3PlacementProblems({
            dag: dag as V3Dag,
            mainLarkAppId: mainApp,
            executorOf: (nodeId) => {
              const node = (dag as V3Dag).nodes.find((candidate) => candidate.id === nodeId);
              return (node && isGoalNode(node) ? node.bot : undefined) ?? mainApp;
            },
            mainTopic: deps.botAssignment.mainTopic ?? { available: false, why: '无法确认主会话是不是话题里的会话' },
          }).map((problem) => problem.message),
        ];
        if (problems.length > 0) throw new DagValidationError(problems);
      }
    } catch (err) {
      const problems = (err as { problems?: string[] }).problems ?? [err instanceof Error ? err.message : String(err)];
      const state = transition(runDir, 'spec_approved', { problems }, now);
      return { ok: false, state, problems };
    }

    const state = transition(
      runDir,
      'dag_ready',
      {
        dagPath: res.dagPath,
        notesPath: res.notesPath,
        architectManifestPath: res.manifestPath,
        problems: undefined,
      },
      now,
    );
    return { ok: true, state };
  });
}

/** gate-2: dag_ready → dag_approved. Returns the recorded dagPath for the
 * runner. A dag_approved retry is accepted only with its valid ad-hoc envelope. */
export function hostApproveDag(runDir: string, now: Date = new Date()): { state: GrillState; dagPath: string } {
  return withHostMutationLockSync(runDir, () => {
    const cur = mustRead(runDir);
    // run.json is the Gate-2 commit, so even the first state transition must
    // verify it. This makes the crash window (published envelope + dag_ready
    // grill state) an ordinary idempotent replay instead of a mutable limbo.
    const committed = readRunEnvelope(runDir, cur.runId);
    if (committed.kind === 'missing') {
      throw new HostGuardError('approve-dag 需先完成 Gate-2 run.json 授权，拒绝仅修改 grill state');
    }
    if (committed.kind === 'invalid') {
      throw new HostGuardError(
        `approve-dag 被拒绝：run.json 已存在但无效（${committed.problems.join('; ')}）`,
      );
    }
    if (committed.envelope.source.kind !== 'ad_hoc') {
      throw new HostGuardError(
        `approve-dag 被拒绝：run.json source=${committed.envelope.source.kind} 不是 ad_hoc Gate-2`,
      );
    }
    loadAuthorizedV3Run(runDir, { expectedRunId: cur.runId, allowedSources: ['ad_hoc'] });

    // Approval is retryable after the create-once execution envelope has been
    // committed. A caller may crash either before or after this transition;
    // both replay states verify the same immutable artifacts.
    if (cur.status === 'dag_approved') {
      return { state: cur, dagPath: join(runDir, 'dag.json') };
    }
    if (cur.status !== 'dag_ready') {
      throw new HostGuardError(`approve-dag 需要 status=dag_ready 或已授权的 dag_approved，当前 ${cur.status}`);
    }
    if (!cur.dagPath) throw new Error('dag_ready 状态缺 dagPath（内部不一致）');
    const state = transition(runDir, 'dag_approved', {}, now);
    return { state, dagPath: join(runDir, 'dag.json') };
  });
}

export interface AdHocRunAuthorizationResult {
  dagPath: string;
  envelope: V3AdHocRunEnvelope;
  publication: PublishRunEnvelopeResult;
}

/**
 * Materialize Gate-2's immutable execution artifacts and publish `run.json`.
 * This must run BEFORE the grill transitions to `dag_approved`: if the process
 * crashes between the two writes, retrying approval verifies/reuses the
 * existing envelope and then finishes the conversation-state transition.
 */
export function authorizeAdHocRun(
  runDir: string,
  bots: BotConfig[],
  now: Date = new Date(),
  opts: {
    workingDirOverride?: string;
    nodeExecutor?: 'bot';
    handoffIdentity?: V3HandoffIdentityRecord;
    /** Bot runs only (design 2026-11-03 workflow-dashboard-orchestration §7.3). */
    initiator?: V3RunInitiator;
    /** Bot runs only: the second-gate record, built inside the lock from the
     *  exact DAG and executing bots being frozen. */
    flowConfirmation?: (frozen: { dag: V3Dag; targets: V3NodeExecutorTarget[] }) => V3FlowConfirmation;
    /** A Dashboard draft (design 2026-11-03 workflow-dashboard-orchestration
     *  §4.5 第 7 步) is born without a chat; its binding (main bot, the group,
     *  the main topic root, the session, the initiator) is produced by
     *  拉群开始 and given here. Refused when the grill has a binding of its own. */
    chatBinding?: RunChatBinding;
  } = {},
): AdHocRunAuthorizationResult {
  // A bot-executed run freezes the directory exactly as an ephemeral one does
  // (every snapshot's workingDir) and also records it in run.json, where the
  // executing bots' daemons read it as an explicit choice to check and apply
  // (design §15.4). Callers pass the absolute, already range-checked path.
  const nodeWorkingDir = opts.nodeExecutor === 'bot' ? opts.workingDirOverride : undefined;
  // The outer host lock prevents Gate-2 from racing any grill RMW / architect
  // attempt. The inner envelope lock serializes this producer with all other
  // run.json publishers. Keep this exact order; see the lock-order invariant
  // above.
  return withHostMutationLockSync(runDir, () => withFileLockSync(join(runDir, 'run.json'), () => {
    // Re-read both state and envelope after acquiring the cross-process lock.
    const cur = mustRead(runDir);

    // Crash-window replay: run.json is the create-once commit. Never rebuild
    // its pinned snapshots from a possibly drifted bots.json. Both dag_ready
    // (published before the state transition) and dag_approved (response lost
    // after transition) are legal idempotent retry states.
    const existing = readRunEnvelope(runDir, cur.runId);
    if (existing.kind === 'ok') {
      if (cur.status !== 'dag_ready' && cur.status !== 'dag_approved') {
        throw new HostGuardError(`approve-dag 需要 status=dag_ready 或已授权的 dag_approved，当前 ${cur.status}`);
      }
      if (existing.envelope.source.kind !== 'ad_hoc') {
        throw new Error(`run.json source=${existing.envelope.source.kind}，不能作为 ad-hoc Gate-2 授权`);
      }
      const adHocEnvelope = existing.envelope as V3AdHocRunEnvelope;
      loadAuthorizedV3Run(runDir, { expectedRunId: cur.runId, allowedSources: ['ad_hoc'] });
      // Re-publish semantically identical bytes through the canonical helper:
      // its idempotent branch heals old/crash-window envelopes by fsyncing all
      // pinned artifacts plus the run directory before we acknowledge replay.
      const publication = publishRunEnvelopeOnce(runDir, adHocEnvelope);
      return {
        dagPath: join(runDir, 'dag.json'),
        envelope: adHocEnvelope,
        publication,
      };
    }
    if (existing.kind === 'invalid') {
      throw new Error(`run.json 已存在但无效，拒绝覆盖：${existing.problems.join('; ')}`);
    }

    // A missing envelope is buildable only before Gate-2 has transitioned.
    // dag_approved+missing is an integrity failure, never a reason to bless
    // today's mutable DAG bytes retroactively.
    if (cur.status !== 'dag_ready') {
      throw new HostGuardError(`approve-dag 需要 status=dag_ready，当前 ${cur.status}`);
    }
    if (!cur.dagPath) throw new Error('dag_ready 状态缺 dagPath（内部不一致）');
    if (opts.chatBinding && cur.chatBinding) {
      throw new HostGuardError('这个 run 出生时已绑定话题，不能再给它另一个绑定');
    }
    const chatBinding = cur.chatBinding ?? opts.chatBinding;
    const dag = loadDag(cur.dagPath);
    if (dag.runId !== cur.runId) {
      throw new Error(`DAG runId=${dag.runId} 与 grill runId=${cur.runId} 不一致`);
    }
    const rawSpec = JSON.parse(readFileSync(cur.specJsonPath, 'utf-8')) as unknown;
    const spec = validateSpec(rawSpec);
    if (spec.runId !== cur.runId) {
      throw new Error(`spec runId=${spec.runId} 与 grill runId=${cur.runId} 不一致`);
    }
    const snapshots = freezeDagBotSnapshots(dag, bots, {
      // A node that omits `bot` inherits the bot where this grill was born,
      // never the first unrelated entry in bots.json. Standalone/dev runs have
      // no binding and retain the legacy first-supported fallback.
      defaultSelector: chatBinding?.larkAppId,
      workingDirOverride: opts.workingDirOverride,
    });

    const dagPath = join(runDir, 'dag.json');
    const specPath = join(runDir, 'spec.json');
    const botSnapshotsPath = join(runDir, 'bots.snapshot.json');
    atomicWriteFileSync(dagPath, `${JSON.stringify(dag, null, 2)}\n`, { mode: 0o600 });
    atomicWriteFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
    atomicWriteFileSync(
      botSnapshotsPath,
      `${JSON.stringify(serializeFrozenBotSnapshots(snapshots), null, 2)}\n`,
      { mode: 0o600 },
    );

    const envelope = makeAdHocRunEnvelope({
      runId: cur.runId,
      createdAt: cur.createdAt,
      authorizedAt: now.toISOString(),
      ...(chatBinding ? { chatBinding } : {}),
      ...(chatBinding?.ownerOpenId ? { authorizedByOpenId: chatBinding.ownerOpenId } : {}),
      ...(opts.nodeExecutor ? { nodeExecutor: opts.nodeExecutor } : {}),
      ...(nodeWorkingDir !== undefined ? { nodeWorkingDir } : {}),
      ...(opts.nodeExecutor && opts.handoffIdentity ? { handoffIdentity: opts.handoffIdentity } : {}),
      ...(opts.nodeExecutor && opts.initiator ? { initiator: opts.initiator } : {}),
      ...(opts.nodeExecutor && opts.flowConfirmation
        ? { flowConfirmation: opts.flowConfirmation({ dag, targets: v3BotExecutorTargets(dag, snapshots) }) }
        : {}),
      artifacts: {
        dag: artifactRef(runDir, 'dag.json'),
        spec: artifactRef(runDir, 'spec.json'),
        botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
      },
    });
    const publication = publishRunEnvelopeOnce(runDir, envelope);
    return { dagPath, envelope, publication };
  }));
}

export interface AdHocNodeExecutorPlanInput {
  switchMode: V3NodeExecutorSwitch;
  multiTopicEnabled: boolean;
  /** `approve-dag --working-dir`. For a `bot` decision it must name an
   *  existing directory inside every executing bot's configured range. */
  workingDirOverride?: string;
  /** Live §6.1 probe for the run's chat; only built for a `bot` decision. */
  probe: (binding: RunChatBinding) => V3BotEligibilityProbe | Promise<V3BotEligibilityProbe>;
  /** §5.2 rule 3, read only when some node is placed in the main topic
   *  (absent = unknown: such a dag is refused). */
  mainTopic?: (binding: RunChatBinding) => V3MainTopicAvailability;
}

export type AdHocNodeExecutorPlan =
  | { kind: 'ephemeral'; decision: Extract<V3NodeExecutorDecision, { mode: 'ephemeral' }> }
  /** `workingDir`: the absolute Gate-2 directory, when one was asked for. */
  | { kind: 'bot'; binding: RunChatBinding; targets: V3NodeExecutorTarget[]; workingDir?: string }
  | { kind: 'refused'; binding: RunChatBinding; targets: V3NodeExecutorTarget[]; problems: V3BotEligibilityProblem[]; workingDir?: string }
  /** The placements break a §5.2 hard rule (messages name the rule). */
  | { kind: 'placementRefused'; binding: RunChatBinding; targets: V3NodeExecutorTarget[]; problems: string[] };

/**
 * Gate-2 executor decision for a not-yet-authorized ad-hoc run (design §6.3):
 * the experimental switch, the run's chat shape and — for a `bot` decision —
 * each goal node's executing bot (frozen exactly as {@link authorizeAdHocRun}
 * will freeze it, default = the bot the grill was born in) checked against
 * §6.1 items 1–4. A `--working-dir` must exist and lie inside every executing
 * bot's configured directory range (§15.4, the main bot included); a node
 * whose bot does not allow it refuses the approval before any live probe.
 * Read-only: nothing is published here.
 */
export async function planAdHocNodeExecutor(
  runDir: string,
  bots: BotConfig[],
  input: AdHocNodeExecutorPlanInput,
): Promise<AdHocNodeExecutorPlan> {
  const cur = mustRead(runDir);
  const decision = decideV3NodeExecutor({
    switchMode: input.switchMode,
    binding: cur.chatBinding,
    multiTopicEnabled: input.multiTopicEnabled,
  });
  if (decision.mode === 'ephemeral') return { kind: 'ephemeral', decision };
  const binding = cur.chatBinding!;
  // Same typo guard as `/cd` (exists, is a directory, never created). What
  // gets frozen is the realpath: absolute because the executing bots' daemons
  // run with other working directories than this command, and with symlinks
  // resolved so a link retargeted later cannot move the node (§15.4).
  let workingDir: string | undefined;
  if (input.workingDirOverride !== undefined) {
    const checked = validateWorkingDir(input.workingDirOverride);
    if (!checked.ok) throw new HostGuardError(`approve-dag --working-dir：${checked.error}`);
    workingDir = realWorkingDir(checked.resolvedPath);
  }
  if (!cur.dagPath) throw new Error('dag_ready 状态缺 dagPath（内部不一致）');
  const dag = loadDag(cur.dagPath);
  const snapshots = freezeDagBotSnapshots(dag, bots, {
    defaultSelector: binding.larkAppId,
    workingDirOverride: workingDir,
  });
  const targets = v3BotExecutorTargets(dag, snapshots);
  if (targets.some((target) => target.placement === 'main')) {
    const placement = v3TargetPlacementProblems({
      targets,
      orchestratorAppId: binding.larkAppId,
      mainTopic: input.mainTopic?.(binding) ?? { available: false, why: '无法确认主会话是不是话题里的会话' },
    });
    if (placement.length > 0) return { kind: 'placementRefused', binding, targets, problems: placement };
  }
  const withDir = workingDir !== undefined ? { workingDir } : {};
  if (workingDir !== undefined) {
    const dirProblems = v3WorkingDirProblems(targets, bots, workingDir);
    if (dirProblems.length > 0) return { kind: 'refused', binding, targets, problems: dirProblems, ...withDir };
  }
  const checked = await checkV3BotExecutorEligibility({
    orchestratorAppId: binding.larkAppId,
    targets,
    probe: await input.probe(binding),
  });
  return checked.ok
    ? { kind: 'bot', binding, targets, ...withDir }
    : { kind: 'refused', binding, targets, problems: checked.problems, ...withDir };
}

/** §15.4 at Gate-2: one problem per node whose executing bot's configured
 *  directory range (bots.json as of now) does not contain `workingDir`. */
function v3WorkingDirProblems(
  targets: readonly V3NodeExecutorTarget[],
  bots: readonly BotConfig[],
  workingDir: string,
): V3BotEligibilityProblem[] {
  const problems: V3BotEligibilityProblem[] = [];
  for (const target of targets) {
    const bot = bots.find((candidate) => candidate.larkAppId === target.larkAppId);
    // An unknown bot is reported by the eligibility check (BOT_NOT_CONFIGURED).
    if (!bot) continue;
    const verdict = checkBotWorkingDir(bot, workingDir);
    if (verdict.ok) continue;
    problems.push({
      nodeId: target.nodeId,
      larkAppId: target.larkAppId,
      code: verdict.reason === 'no_range' ? 'WORKING_DIR_NO_RANGE' : 'WORKING_DIR_OUT_OF_RANGE',
    });
  }
  return problems;
}

/**
 * The Architect's bot roster for a run that will be bot-executed (design
 * 2026-11-03 §6.1/§6.2), or `undefined` for any other run — then nothing is
 * probed and the Architect gets today's prompt. Same decision as Gate-2
 * (switch, chat shape, multi-topic switch), taken from the grill binding.
 */
export async function planArchitectBotAssignment(
  runDir: string,
  bots: BotConfig[],
  input: {
    switchMode: V3NodeExecutorSwitch;
    multiTopicEnabled: boolean;
    probe: (binding: RunChatBinding) => V3BotEligibilityProbe | Promise<V3BotEligibilityProbe>;
    nameOf: (larkAppId: string) => string;
    /** Capability labels; only built for a bot run. */
    roleOf?: () => ((larkAppId: string) => string | undefined) | Promise<(larkAppId: string) => string | undefined>;
    /** §5.2 rule 3: whether nodes may be placed in the main topic. */
    mainTopic?: (binding: RunChatBinding) => V3MainTopicAvailability;
  },
): Promise<V3ArchitectBotAssignment | undefined> {
  const cur = mustRead(runDir);
  const decision = decideV3NodeExecutor({
    switchMode: input.switchMode,
    binding: cur.chatBinding,
    multiTopicEnabled: input.multiTopicEnabled,
  });
  if (decision.mode !== 'bot') return undefined;
  const binding = cur.chatBinding!;
  const roster = await buildV3BotRoster({
    orchestratorAppId: binding.larkAppId,
    bots,
    probe: await input.probe(binding),
    nameOf: input.nameOf,
    ...(input.roleOf ? { roleOf: await input.roleOf() } : {}),
  });
  const spec = validateSpec(JSON.parse(readFileSync(cur.specJsonPath, 'utf-8')) as unknown);
  return {
    roster,
    assignees: planV3SketchAssignees(spec, roster, bots, input.nameOf),
    mainTopic: input.mainTopic?.(binding) ?? { available: false, why: '无法确认主会话是不是话题里的会话' },
  };
}

/**
 * Gate-2 lines for a bot run (design §6.2): node → bot (name, CLI), the
 * Architect's reason from architect-notes.md, and every named bot (`assignee`)
 * the assignment does not honour. Read-only; unreadable notes or spec only
 * drop the reasons / checks.
 */
export function describeAdHocBotPlan(
  runDir: string,
  targets: readonly V3NodeExecutorTarget[],
  orchestratorAppId: string,
  bots: readonly BotConfig[],
  nameOf: (larkAppId: string) => string,
  roster?: V3BotRoster,
): string {
  return formatV3Gate2BotPlan(adHocBotPlanInput(runDir, targets, orchestratorAppId, bots, nameOf, roster));
}

/** The facts {@link describeAdHocBotPlan} prints, for the flow summary. */
function adHocBotPlanInput(
  runDir: string,
  targets: readonly V3NodeExecutorTarget[],
  orchestratorAppId: string,
  bots: readonly BotConfig[],
  nameOf: (larkAppId: string) => string,
  roster?: V3BotRoster,
): Parameters<typeof formatV3Gate2BotPlan>[0] {
  const cur = readGrillState(runDir);
  let reasons = new Map<string, { bot: string; reason: string }>();
  let placementReasons = new Map<string, { placement: string; reason: string }>();
  try {
    if (cur?.notesPath) {
      const notes = readFileSync(cur.notesPath, 'utf-8');
      reasons = parseV3AssignmentReasons(notes);
      placementReasons = parseV3PlacementReasons(notes);
    }
  } catch { /* no reasons */ }
  let assignees: ReturnType<typeof checkV3Assignees> = [];
  try {
    if (cur) {
      const spec = validateSpec(JSON.parse(readFileSync(cur.specJsonPath, 'utf-8')) as unknown);
      const excluded = new Map(roster?.excluded.map((entry) => [entry.larkAppId, entry.why]) ?? []);
      assignees = checkV3Assignees({ spec, targets, bots, nameOf, unavailableWhy: (appId) => excluded.get(appId) });
    }
  } catch { /* no checks */ }
  return {
    targets,
    orchestratorAppId,
    nameOf,
    cliOf: (appId) => bots.find((bot) => bot.larkAppId === appId)?.cliId,
    reasons,
    assignees,
    placementReasons,
  };
}

/**
 * The Gate-2 bot plan (node → bot, CLI, reason, ⚠️) of a not-yet-authorized
 * run, structured — what a Dashboard draft shows (design 2026-11-03
 * workflow-dashboard-orchestration §4.4). Read-only.
 */
export function projectAdHocBotPlan(
  runDir: string,
  targets: readonly V3NodeExecutorTarget[],
  orchestratorAppId: string,
  bots: readonly BotConfig[],
  nameOf: (larkAppId: string) => string,
  roster?: V3BotRoster,
): ReturnType<typeof projectV3Gate2BotPlan> {
  return projectV3Gate2BotPlan(adHocBotPlanInput(runDir, targets, orchestratorAppId, bots, nameOf, roster));
}

/** The flow summary (§4.4) of exactly `dag` with these executing bots: the
 *  one Gate-2 approve-dag records and a Dashboard draft's second gate compares. */
export function adHocFlowSummary(input: {
  runDir: string;
  dag: V3Dag;
  targets: readonly V3NodeExecutorTarget[];
  orchestratorAppId: string;
  bots: readonly BotConfig[];
  nameOf: (larkAppId: string) => string;
}): ReturnType<typeof buildV3FlowSummary> {
  const plan = projectAdHocBotPlan(input.runDir, input.targets, input.orchestratorAppId, input.bots, input.nameOf);
  return buildV3FlowSummary({ dagNodes: input.dag.nodes, plan });
}

/**
 * Gate-2's second-confirmation record for a bot run (design 2026-11-03
 * workflow-dashboard-orchestration §4.4 / §7.3): the flow summary of exactly
 * what is being frozen, who confirmed (when known) and when.
 */
function adHocFlowConfirmation(input: {
  runDir: string;
  dag: V3Dag;
  targets: readonly V3NodeExecutorTarget[];
  orchestratorAppId: string;
  bots: readonly BotConfig[];
  nameOf: (larkAppId: string) => string;
  confirmedByOpenId?: string;
  confirmedAt: Date;
}): V3FlowConfirmation {
  const flowSummary = adHocFlowSummary(input);
  return {
    ...(input.confirmedByOpenId ? { confirmedByOpenId: input.confirmedByOpenId } : {}),
    confirmedAt: input.confirmedAt.toISOString(),
    flowSummary,
    flowSummarySha256: v3FlowSummarySha256(flowSummary),
  };
}

/**
 * When the run's nodes stay on temporary processes, the bots named in the
 * spec (`assignee`) have no effect; say so at Gate-2 instead of silently
 * ignoring them. `undefined` when the spec names nobody.
 */
export function describeIgnoredAssignees(runDir: string): string | undefined {
  try {
    const cur = readGrillState(runDir);
    if (!cur) return undefined;
    const spec = validateSpec(JSON.parse(readFileSync(cur.specJsonPath, 'utf-8')) as unknown);
    const named = spec.nodes.filter((sketch) => sketch.assignee);
    if (named.length === 0) return undefined;
    return `本次节点不交给群里的 Bot 执行，spec 里的点名不生效：${named.map((sketch) => `${sketch.sketchId} →「${sketch.assignee}」`).join('、')}`;
  } catch {
    return undefined;
  }
}

/**
 * 改稿·改需求：把任一 grilling 之后的阶段退回 `grilling`，并清掉已失效的
 * architect 产物（dagPath/notesPath/architectManifestPath）+ problems，让用户
 * 重新 grill / 改 spec.md 再 finalize。改需求意味着已编排的 DAG 作废，所以这里
 * 必须把那些指针清空，否则后续 approve-dag / dashboard 会拿到过期的 dag
 * (codex review 2026-06-02).  从 `grilling`（无可退）和 `dag_approved`（已交
 * runtime）拒绝。
 */
export function hostReviseSpec(runDir: string, now: Date = new Date()): GrillState {
  return withHostMutationLockSync(runDir, () => {
    const cur = mustRead(runDir);
    assertRunNotCommitted(runDir, cur, 'revise-spec');
    if (cur.status === 'grilling') {
      throw new HostGuardError('当前已在 grilling，直接改 spec.md 再 spec-finalize 即可');
    }
    if (cur.status === 'dag_approved') {
      throw new HostGuardError('DAG 已批准并交给 runtime，无法再 revise（如需改动请新建 run）');
    }
    return transition(
      runDir,
      'grilling',
      { dagPath: undefined, notesPath: undefined, architectManifestPath: undefined, problems: undefined },
      now,
    );
  });
}

/**
 * 改稿·只改流程：需求没变、只是 DAG 编得不满意时，从 `dag_ready` 退回
 * `spec_approved` 并清掉 stale 的 dag 产物，使 `architect` 在同一份已批准 spec
 * 上重编一张，不必重新 grill。
 */
export function hostReviseDag(runDir: string, now: Date = new Date()): GrillState {
  return withHostMutationLockSync(runDir, () => {
    const cur = mustRead(runDir);
    assertRunNotCommitted(runDir, cur, 'revise-dag');
    if (cur.status !== 'dag_ready') {
      throw new HostGuardError(`revise-dag 需要 status=dag_ready，当前 ${cur.status}`);
    }
    return transition(
      runDir,
      'spec_approved',
      { dagPath: undefined, notesPath: undefined, architectManifestPath: undefined, problems: undefined },
      now,
    );
  });
}

export class HostGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostGuardError';
  }
}

function mustRead(runDir: string): GrillState {
  const s = readGrillState(runDir);
  if (!s) throw new Error(`grill.state.json 不存在于 ${runDir}`);
  return s;
}

// ─── CLI dispatch (resolves real deps) ──────────────────────────────────────

function runDirFor(runId: string, baseDir: string): string {
  // runId is already validated by `requireRunId` (isValidRunId rejects `/` and
  // a leading `.`, so traversal can't get this far) — this resolve()+prefix
  // check is a defense-in-depth backstop so a runDir can never escape baseDir
  // even if a caller bypasses requireRunId (codex review 2026-06-02).
  const base = resolve(baseDir);
  const dir = resolve(base, runId);
  if (dir !== base && !dir.startsWith(base + sep)) {
    throw new Error(`runId 越界 baseDir：${runId}`);
  }
  return dir;
}

/**
 * `botmux workflow <sub>` host-controller subcommands.  Dispatched from
 * `cmdWorkflow` for the v3-specific verbs (new/spec-finalize/approve-spec/
 * architect/approve-dag); v0.2 verbs (run/create/validate/…) stay in workflow.ts.
 */
export interface WorkflowHostCommandDeps {
  loadBots?: () => BotConfig[];
  /** Test/dev seam; production resolves fresh current-turn provenance. */
  resolveChatBinding?: () => RunChatBinding | undefined;
  /** Experimental node-executor switch (default: live global config). */
  nodeExecutorSwitch?: () => V3NodeExecutorSwitch;
  /** Machine-wide multi-topic switch (default: live global config). */
  multiTopicEnabled?: () => boolean;
  /** §6.1 probe factory (default: live Lark + daemon registry + chat grants). */
  botEligibilityProbe?: (binding: RunChatBinding, bots: BotConfig[]) => V3BotEligibilityProbe | Promise<V3BotEligibilityProbe>;
  /** Bot display names for the Gate-2 summary (default: bots-info.json). */
  botDisplayName?: () => (larkAppId: string) => string;
  /** 交接带发起人身份 switch (default: live global config). */
  handoffIdentitySwitch?: () => boolean;
  /** Seams that freeze the initiator (default: the main bot's live Lark app
   *  + bots.json). Only built while that switch is on. */
  handoffIdentityPolicy?: (bots: BotConfig[]) => V3HandoffIdentityPolicy | Promise<V3HandoffIdentityPolicy>;
  /** The current turn's id (default: fresh current-turn provenance). Read
   *  only to freeze the initiator: only a human-opened turn may. */
  resolveCurrentTurnId?: () => string | undefined;
  /** The person confirming Gate-2 in this turn (default:
   *  {@link currentTurnConfirmerFromEnv}). Undefined / throwing = unknown. */
  resolveCurrentTurnConfirmer?: () => string | undefined;
  /** Capability labels for the Architect roster (default: bot profiles). */
  botRole?: () => (larkAppId: string) => string | undefined;
  /** §5.2 rule 3 (default: the run's persisted main session). */
  mainTopicAvailability?: (binding: RunChatBinding) => V3MainTopicAvailability | Promise<V3MainTopicAvailability>;
  /** Test seam for the architect worker (default: the real ephemeral pool). */
  runArchitect?: ArchitectDeps['runArchitect'];
}

async function liveHandoffIdentityPolicy(bots: BotConfig[]): Promise<V3HandoffIdentityPolicy> {
  // The union_id lookup talks through the main bot's own Lark app; a CLI
  // process registers the configured apps first (as the eligibility probe does).
  const { registerBot } = await import('../../bot-registry.js');
  for (const bot of bots) {
    try { registerBot(bot); } catch { /* an unusable entry simply fails its own lookup */ }
  }
  const { createLiveV3HandoffIdentityPolicy } = await import('../../im/lark/v3-bot-eligibility.js');
  return createLiveV3HandoffIdentityPolicy(bots);
}

async function liveBotEligibilityProbe(binding: RunChatBinding, bots: BotConfig[]): Promise<V3BotEligibilityProbe> {
  // The strict membership resolver talks through the main bot's own Lark app;
  // a CLI process has to register the configured apps first (as dispatch does).
  const { registerBot } = await import('../../bot-registry.js');
  for (const bot of bots) {
    try { registerBot(bot); } catch { /* an unusable entry simply fails its own probe */ }
  }
  const { createLiveV3BotEligibilityProbe } = await import('../../im/lark/v3-bot-eligibility.js');
  return createLiveV3BotEligibilityProbe({
    orchestratorAppId: binding.larkAppId,
    chatId: binding.chatId,
    bots,
  });
}

/** A probe that accepts every bot: the architect preview lists assignments
 *  only; eligibility is checked for real at approve-dag. */
const PREVIEW_PROBE: V3BotEligibilityProbe = {
  isConfigured: () => true,
  isDaemonOnline: () => true,
  inChat: async () => 'yes',
  opensTopicSessions: async () => 'yes',
  ensureGrant: async () => {},
};

async function liveMainTopicAvailability(binding: RunChatBinding): Promise<V3MainTopicAvailability> {
  const { liveV3MainTopicAvailability } = await import('../../im/lark/v3-bot-eligibility.js');
  return liveV3MainTopicAvailability(binding);
}

/** §5.2 rule 3 for the run in `runDir`, resolved once per command (only a
 *  bot run with a chat binding reads the main session). */
async function resolveMainTopic(
  runDir: string,
  deps: WorkflowHostCommandDeps,
): Promise<((binding: RunChatBinding) => V3MainTopicAvailability) | undefined> {
  const binding = readGrillState(runDir)?.chatBinding;
  if (!binding) return undefined;
  let availability: V3MainTopicAvailability;
  try {
    availability = await (deps.mainTopicAvailability ?? liveMainTopicAvailability)(binding);
  } catch (err) {
    availability = { available: false, why: `读不到主会话（${err instanceof Error ? err.message : String(err)}）` };
  }
  return () => availability;
}

async function liveBotDisplayName(): Promise<(larkAppId: string) => string> {
  const { v3BotDisplayNameResolver } = await import('../../im/lark/v3-bot-eligibility.js');
  return v3BotDisplayNameResolver();
}

async function liveBotRole(): Promise<(larkAppId: string) => string | undefined> {
  const [{ getBotCapability }, { config }] = await Promise.all([
    import('../../services/bot-profile-store.js'),
    import('../../config.js'),
  ]);
  return (larkAppId) => getBotCapability(config.session.dataDir, larkAppId) ?? undefined;
}

const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,128}$/;
function isOpenId(value: string | undefined): value is string {
  return typeof value === 'string' && OPEN_ID_RE.test(value);
}

export async function cmdWorkflowHost(
  sub: string,
  rest: string[],
  deps: WorkflowHostCommandDeps = {},
): Promise<void> {
  const baseDir = argValue(rest, '--base-dir') ?? defaultBaseDir();
  const guardedRunDir = (runId: string): string => {
    const runDir = runDirFor(runId, baseDir);
    const current = (deps.resolveChatBinding ?? chatBindingFromEnv)();
    assertWorkflowHostCaller(runDir, current);
    return runDir;
  };

  switch (sub) {
    case 'new': {
      const goal = firstPositional(rest);
      if (!goal) throw new Error('用法: botmux workflow new "<目标>" [--base-dir <dir>]');
      // grill 经 daemon worker 出生时，env 带话题上下文 → 落 chatBinding，供后续
      // daemon humanGate 发审批卡用（CLI/dev 出生无 env → undefined，不影响）。
      const chatBinding = (deps.resolveChatBinding ?? chatBindingFromEnv)();
      const { runId, runDir, state } = hostNew({ goal, baseDir, chatBinding });
      // Tells the grill whether named bots (`assignee`) will matter; approve-dag
      // decides for real.
      const botExecuted = decideV3NodeExecutor({
        switchMode: (deps.nodeExecutorSwitch ?? workflowNodeExecutorMode)(),
        binding: chatBinding,
        multiTopicEnabled: (deps.multiTopicEnabled ?? (() => isMultiTopicOrchestrationEnabled()))(),
      }).mode === 'bot';
      console.log(JSON.stringify({
        runId, runDir, status: state.status, specPath: state.specPath,
        chatBound: !!chatBinding,
        ...(botExecuted ? { nodeExecutor: 'bot' } : {}),
      }, null, 2));
      return;
    }
    case 'spec-finalize': {
      const runId = requireRunId(rest);
      const out = hostSpecFinalize(guardedRunDir(runId));
      if (!out.ok) {
        console.error(`spec 校验失败（先修 spec.md 再 finalize）:\n  - ${out.problems!.join('\n  - ')}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ runId, status: out.state!.status, specJsonPath: out.state!.specJsonPath }, null, 2));
      return;
    }
    case 'approve-spec': {
      const runId = requireRunId(rest);
      const state = hostApproveSpec(guardedRunDir(runId));
      console.log(JSON.stringify({ runId, status: state.status }, null, 2));
      return;
    }
    case 'revise-spec': {
      const runId = requireRunId(rest);
      const state = hostReviseSpec(guardedRunDir(runId));
      console.log(JSON.stringify({ runId, status: state.status }, null, 2));
      console.log('\n↩️  已退回 grilling，可改 spec.md 再 spec-finalize（原 DAG 产物已作废）。');
      return;
    }
    case 'revise-dag': {
      const runId = requireRunId(rest);
      const state = hostReviseDag(guardedRunDir(runId));
      console.log(JSON.stringify({ runId, status: state.status }, null, 2));
      console.log('\n↩️  已退回 spec_approved，可直接重跑 architect 重编 DAG（需求不变）。');
      return;
    }
    case 'architect': {
      const runId = requireRunId(rest);
      const runDir = guardedRunDir(runId);
      const bots = (deps.loadBots ?? loadBotConfigs)();
      const switchMode = (deps.nodeExecutorSwitch ?? workflowNodeExecutorMode)();
      const multiTopicEnabled = (): boolean => (deps.multiTopicEnabled ?? (() => isMultiTopicOrchestrationEnabled()))();
      // Bot runs only (design §6.2): the Architect assigns every goal node a
      // bot from the chat's roster. Any other run gets today's prompt without
      // a single probe.
      let botAssignment: V3ArchitectBotAssignment | undefined;
      let nameOf: ((larkAppId: string) => string) | undefined;
      const mainTopic = switchMode === 'bot' ? await resolveMainTopic(runDir, deps) : undefined;
      if (switchMode === 'bot') {
        nameOf = await (deps.botDisplayName ?? liveBotDisplayName)();
        try {
          botAssignment = await planArchitectBotAssignment(runDir, bots, {
            switchMode,
            multiTopicEnabled: multiTopicEnabled(),
            probe: (binding) => (deps.botEligibilityProbe ?? liveBotEligibilityProbe)(binding, bots),
            nameOf,
            roleOf: deps.botRole ?? liveBotRole,
            ...(mainTopic ? { mainTopic } : {}),
          });
        } catch (err) {
          // Without a roster every node stays on the main bot (the default
          // selector) — the same outcome as an Architect that is unsure.
          const binding = mustRead(runDir).chatBinding;
          if (binding?.larkAppId) {
            botAssignment = {
              roster: {
                mainLarkAppId: binding.larkAppId,
                bots: [{ larkAppId: binding.larkAppId, name: nameOf(binding.larkAppId), cli: bots.find((bot) => bot.larkAppId === binding.larkAppId)?.cliId ?? 'unknown', main: true }],
                excluded: [],
              },
              assignees: [],
              ...(mainTopic ? { mainTopic: mainTopic(binding) } : {}),
            };
          }
          console.error(`（没能取到群里可用的 Bot 名单，本次节点都交给主 Bot：${err instanceof Error ? err.message : String(err)}）`);
        }
      }
      const out = await runArchitectCli(runId, baseDir, rest, {
        bots,
        ...(botAssignment ? { botAssignment } : {}),
        ...(deps.runArchitect ? { runArchitect: deps.runArchitect } : {}),
      });
      if (!out.ok) {
        console.error(`architect/validateDag 失败（已退回 spec_approved，可修 spec 重跑）:\n  - ${out.problems!.join('\n  - ')}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ runId, status: out.state.status, dagPath: out.state.dagPath, notesPath: out.state.notesPath }, null, 2));
      if (!botAssignment) {
        const ignored = describeIgnoredAssignees(runDir);
        if (ignored) console.log(`\n${ignored}`);
      }
      // Gate-2 preview: with the experimental executor switch on, show who
      // will execute each node so the summary can list it before approval
      // (approve-dag re-decides and checks eligibility; this never blocks).
      if (switchMode === 'bot') {
        try {
          const preview = await planAdHocNodeExecutor(runDir, bots, {
            switchMode: 'bot',
            multiTopicEnabled: multiTopicEnabled(),
            workingDirOverride: argValue(rest, '--working-dir'),
            probe: () => PREVIEW_PROBE,
            ...(mainTopic ? { mainTopic } : {}),
          });
          if (preview.kind === 'ephemeral') {
            const fallback = describeV3EphemeralFallback(preview.decision);
            if (fallback) console.log(`\n${fallback}`);
          } else if (preview.kind === 'placementRefused') {
            console.log(`\n${formatV3PlacementRefusal(preview.problems)}`);
          } else {
            console.log(`\n${describeAdHocBotPlan(runDir, preview.targets, preview.binding.larkAppId, bots, nameOf!, botAssignment?.roster)}`);
            console.log('（批准时会再检查每个执行 Bot 是否在本群、daemon 是否在线）');
          }
        } catch { /* preview only */ }
      }
      return;
    }
    case 'approve-dag': {
      const runId = requireRunId(rest);
      const runDir = runDirFor(runId, baseDir);
      // Kept (not just checked): the person of this turn is the confirmer the
      // run records (design 2026-11-03 workflow-dashboard-orchestration §7.3).
      const currentCaller = (deps.resolveChatBinding ?? chatBindingFromEnv)();
      assertWorkflowHostCaller(runDir, currentCaller);
      const workingDirOverride = argValue(rest, '--working-dir');
      if (rest.includes('--working-dir') && (!workingDirOverride?.trim() || workingDirOverride.startsWith('--'))) {
        throw new Error('--working-dir requires a non-empty path');
      }
      const now = new Date();
      // An already-published replay must not depend on today's bots.json just
      // to acknowledge the same Gate-2 decision. The in-lock reader remains
      // authoritative; this read only decides whether bot snapshots are needed.
      const before = readRunEnvelope(runDir, runId);
      const bots = before.kind === 'missing' ? (deps.loadBots ?? loadBotConfigs)() : [];
      // Executor (design §6.3, D1): decided once, here, and frozen into run.json.
      // A replay of an already-published approval never re-decides it.
      const summary: string[] = [];
      let nodeExecutor: 'bot' | undefined;
      let handoffIdentity: V3HandoffIdentityRecord | undefined;
      let initiator: V3RunInitiator | undefined;
      let flowConfirmation: ((frozen: { dag: V3Dag; targets: V3NodeExecutorTarget[] }) => V3FlowConfirmation) | undefined;
      /** Bot mode: the absolute, range-checked `--working-dir`. */
      let botWorkingDir: string | undefined;
      if (before.kind === 'missing') {
        const switchMode = (deps.nodeExecutorSwitch ?? workflowNodeExecutorMode)();
        if (switchMode === 'bot') {
          const mainTopic = await resolveMainTopic(runDir, deps);
          const plan = await planAdHocNodeExecutor(runDir, bots, {
            switchMode,
            multiTopicEnabled: (deps.multiTopicEnabled ?? (() => isMultiTopicOrchestrationEnabled()))(),
            workingDirOverride,
            probe: (binding) => (deps.botEligibilityProbe ?? liveBotEligibilityProbe)(binding, bots),
            ...(mainTopic ? { mainTopic } : {}),
          });
          // §5.2: a hard-rule violation refuses the approval, naming the rule.
          if (plan.kind === 'placementRefused') throw new HostGuardError(formatV3PlacementRefusal(plan.problems));
          if (plan.kind === 'ephemeral') {
            const fallback = describeV3EphemeralFallback(plan.decision);
            if (fallback) summary.push(fallback);
            const ignored = describeIgnoredAssignees(runDir);
            if (ignored) summary.push(ignored);
          } else {
            const nameOf = await (deps.botDisplayName ?? liveBotDisplayName)();
            if (plan.kind === 'refused') {
              throw new HostGuardError(formatV3BotEligibilityRefusal(plan.problems, nameOf, {
                ...(plan.workingDir !== undefined ? { workingDir: plan.workingDir } : {}),
              }));
            }
            botWorkingDir = plan.workingDir;
            // 交接带发起人身份 (design §10.2 item 1): decided once, here, with
            // the executor, and frozen into the same authorization.
            if ((deps.handoffIdentitySwitch ?? workflowHandoffIdentityEnabled)()) {
              const identity = await resolveV3HandoffIdentity(
                plan.binding,
                await (deps.handoffIdentityPolicy ?? liveHandoffIdentityPolicy)(bots),
                { humanTurn: isHumanInboundTurnId((deps.resolveCurrentTurnId ?? currentTurnIdFromEnv)()) },
                { targets: plan.targets, nameOf },
              );
              handoffIdentity = identity.record;
              summary.push(describeAdHocBotPlan(runDir, plan.targets, plan.binding.larkAppId, bots, nameOf));
              if (identity.summary) summary.push(identity.summary);
            } else {
              summary.push(describeAdHocBotPlan(runDir, plan.targets, plan.binding.larkAppId, bots, nameOf));
            }
            if (botWorkingDir !== undefined) summary.push(describeV3NodeWorkingDir(botWorkingDir));
            // Initiator and second confirmation (design 2026-11-03
            // workflow-dashboard-orchestration §7.3, I11): the grill's
            // authenticated initiator, and the person of THIS turn as the
            // confirmer — only when a human message opened it; otherwise (or
            // when the turn cannot be proven) the confirmer is unknown and not
            // written, never guessed, and the approval goes on.
            initiator = feishuRunInitiator(plan.binding.ownerOpenId, handoffIdentity);
            let confirmer: string | undefined;
            try {
              confirmer = (deps.resolveCurrentTurnConfirmer ?? currentTurnConfirmerFromEnv)();
            } catch { /* unproven turn: no confirmer */ }
            // The caller guard above already pinned this turn's caller to the
            // grill's initiator; anything else is not recorded as a confirmer.
            const confirmedByOpenId = isOpenId(confirmer) && confirmer === initiator?.openId
              && confirmer === currentCaller?.ownerOpenId ? confirmer : undefined;
            const orchestratorAppId = plan.binding.larkAppId;
            // A run with no authenticated initiator (standalone / env binding
            // without an ou_ owner) records neither: a confirmation belongs to
            // an initiator (run.json requires one for it).
            if (initiator) {
              flowConfirmation = ({ dag, targets }) => adHocFlowConfirmation({
                runDir, dag, targets, orchestratorAppId, bots, nameOf, confirmedAt: now,
                ...(confirmedByOpenId ? { confirmedByOpenId } : {}),
              });
            }
            nodeExecutor = 'bot';
          }
        } else {
          const ignored = describeIgnoredAssignees(runDir);
          if (ignored) summary.push(ignored);
        }
      } else if (before.kind === 'ok' && 'nodeExecutor' in before.envelope && before.envelope.nodeExecutor === 'bot') {
        summary.push('执行方式：节点交给群里的 Bot 执行（已在首次批准时冻结）');
        if (frozenHandoffIdentity(before.envelope)) summary.push('交接带发起人身份：开（已在首次批准时冻结）');
        const frozenDir = frozenNodeWorkingDir(before.envelope);
        if (frozenDir !== undefined) summary.push(`工作目录：${frozenDir}（已在首次批准时冻结）`);
      }
      const authorized = authorizeAdHocRun(runDir, bots, now, {
        workingDirOverride: nodeExecutor === 'bot' ? botWorkingDir : workingDirOverride,
        ...(nodeExecutor ? { nodeExecutor } : {}),
        ...(handoffIdentity ? { handoffIdentity } : {}),
        ...(initiator ? { initiator } : {}),
        ...(flowConfirmation ? { flowConfirmation } : {}),
      });
      const { state } = hostApproveDag(runDir, now);
      const dagPath = authorized.dagPath;
      const frozenExecutor = 'nodeExecutor' in authorized.envelope ? authorized.envelope.nodeExecutor : undefined;
      console.log(JSON.stringify({
        runId,
        status: state.status,
        dagPath,
        ...(frozenExecutor ? { nodeExecutor: frozenExecutor } : {}),
      }, null, 2));
      for (const line of summary) console.log(`\n${line}`);
      console.log(`\n✅ DAG 已批准。开跑：botmux workflow start ${runId}`);
      return;
    }
    default:
      throw new Error(`未知 workflow 子命令: ${sub}`);
  }
}

/** True when `sub` is a v3 host-controller verb (so cmdWorkflow routes here). */
export function isHostSub(sub: string): boolean {
  return ['new', 'spec-finalize', 'approve-spec', 'revise-spec', 'architect', 'revise-dag', 'approve-dag'].includes(sub);
}

/** Resolve real bot/secret deps and run the architect step. */
export function resolveArchitectBotSnapshot(
  runDir: string,
  bots: BotConfig[],
  explicitSelector?: string,
  workingDirOverride?: string,
): BotSnapshot {
  if (bots.length === 0) throw new Error('没有可用 bot 配置（bots.json 为空）');
  const state = mustRead(runDir);
  const selector = explicitSelector ?? state.chatBinding?.larkAppId;
  const bot = selector
    ? resolveBotConfig(selector, bots)
    : bots.find((candidate) => (
        candidate.disableCliBypass !== true && isV3SupportedCli(candidate.cliId)
      ));
  if (!bot) {
    throw new Error(
      `没有同时满足 bypass + v3 CLI allowlist 的 bot（supported: ${V3_SUPPORTED_CLIS.join(', ')}）`,
    );
  }
  const snapshot = botToSnapshot(bot, workingDirOverride);
  if (!isV3SupportedCli(snapshot.cliId)) {
    throw new Error(
      `v3 architect bot "${bot.name ?? bot.larkAppId}" uses unsupported CLI "${snapshot.cliId}" ` +
      `(supported: ${V3_SUPPORTED_CLIS.join(', ')})`,
    );
  }
  return snapshot;
}

async function runArchitectCli(
  runId: string,
  baseDir: string,
  rest: string[],
  opts: {
    bots: BotConfig[];
    botAssignment?: V3ArchitectBotAssignment;
    runArchitect?: ArchitectDeps['runArchitect'];
  },
): Promise<ArchitectOutcome> {
  const bots = opts.bots;
  const secretById = new Map(bots.map((b) => [b.larkAppId, b.larkAppSecret]));
  // The authoritative constructor rejects disableCliBypass=true: architect and
  // goal workers both require CLI bypass permissions by product contract.
  const runDir = runDirFor(runId, baseDir);
  const botSnapshot = resolveArchitectBotSnapshot(
    runDir,
    bots,
    argValue(rest, '--bot'),
    argValue(rest, '--working-dir'),
  );

  return hostArchitect(runDir, {
    runArchitect: opts.runArchitect ?? realRunArchitect,
    loadDag,
    botSnapshot,
    resolveLarkAppSecret: (id: string) => secretById.get(id),
    ...(opts.botAssignment ? { botAssignment: opts.botAssignment } : {}),
  });
}

// ─── Local arg parsers ──────────────────────────────────────────────────────

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue; }
    return args[i];
  }
  return undefined;
}

function requireRunId(rest: string[]): string {
  const runId = firstPositional(rest);
  if (!runId) throw new Error('用法: botmux workflow <sub> <runId> [--base-dir <dir>]');
  // Reject anything that could escape baseDir (path separators, `..`, leading
  // dot) — these verbs are skill-driven shell commands, so harden the runId
  // before it reaches join/resolve (codex review 2026-06-02).
  if (!isValidRunId(runId)) {
    throw new Error(`非法 runId（只允许字母数字与 . _ -、不得含路径分隔符）：${runId}`);
  }
  return runId;
}
