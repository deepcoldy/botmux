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
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { loadBotConfigs, type BotConfig } from '../../bot-registry.js';
import { resolveCurrentTurnProvenance } from '../../core/current-turn-provenance.js';
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
import { loadDag } from './dag.js';
import { isValidRunId } from './ops-projection.js';
import {
  botToSnapshot,
  freezeDagBotSnapshots,
  resolveBotConfig,
  serializeFrozenBotSnapshots,
} from './bot-resolve.js';
import {
  artifactRef,
  loadAuthorizedV3Run,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
  readRunEnvelope,
  type PublishRunEnvelopeResult,
  type V3AdHocRunEnvelope,
} from './run-envelope.js';
import { V3_SUPPORTED_CLIS, isV3SupportedCli, type BotSnapshot } from './contract.js';

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

function withHostMutationLockSync<T>(runDir: string, fn: () => T): T {
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
      deps.loadDag(res.dagPath);
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
): AdHocRunAuthorizationResult {
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
      defaultSelector: cur.chatBinding?.larkAppId,
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
      ...(cur.chatBinding ? { chatBinding: cur.chatBinding } : {}),
      ...(cur.chatBinding?.ownerOpenId ? { authorizedByOpenId: cur.chatBinding.ownerOpenId } : {}),
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
      console.log(JSON.stringify({
        runId, runDir, status: state.status, specPath: state.specPath,
        chatBound: !!chatBinding,
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
      guardedRunDir(runId);
      const out = await runArchitectCli(runId, baseDir, rest);
      if (!out.ok) {
        console.error(`architect/validateDag 失败（已退回 spec_approved，可修 spec 重跑）:\n  - ${out.problems!.join('\n  - ')}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ runId, status: out.state.status, dagPath: out.state.dagPath, notesPath: out.state.notesPath }, null, 2));
      return;
    }
    case 'approve-dag': {
      const runId = requireRunId(rest);
      const runDir = guardedRunDir(runId);
      const now = new Date();
      // An already-published replay must not depend on today's bots.json just
      // to acknowledge the same Gate-2 decision. The in-lock reader remains
      // authoritative; this read only decides whether bot snapshots are needed.
      const before = readRunEnvelope(runDir, runId);
      const bots = before.kind === 'missing' ? (deps.loadBots ?? loadBotConfigs)() : [];
      const authorized = authorizeAdHocRun(runDir, bots, now);
      const { state } = hostApproveDag(runDir, now);
      const dagPath = authorized.dagPath;
      console.log(JSON.stringify({ runId, status: state.status, dagPath }, null, 2));
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

async function runArchitectCli(runId: string, baseDir: string, rest: string[]): Promise<ArchitectOutcome> {
  const bots = loadBotConfigs();
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
    runArchitect: realRunArchitect,
    loadDag,
    botSnapshot,
    resolveLarkAppSecret: (id: string) => secretById.get(id),
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
