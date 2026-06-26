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
 *   workflow approve-dag <id>    → gate-2: dag_ready → dag_approved → kick `v3 run`
 *
 * The CORE operations below take injected deps so they unit-test without a real
 * worker; the CLI wrapper resolves real bot/secret + codex's `runArchitect` +
 * dag.ts's `loadDag`.  grill state is a conversation worktable — it does NOT
 * write the runtime journal (codex 2026-06-02).
 */
import { resolve, sep } from 'node:path';
import {
  birthRun,
  readGrillState,
  transition,
  defaultBaseDir,
  type BirthResult,
  type GrillState,
  type RunChatBinding,
} from './grill-state.js';
import { finalizeSpec, SpecValidationError } from './spec.js';
import { runArchitect as realRunArchitect, type RunArchitectInput, type RunArchitectResult } from './architect.js';
import { loadDag } from './dag.js';
import { isValidRunId } from './ops-projection.js';
import { botToSnapshot } from './bot-resolve.js';
import type { BotSnapshot } from './contract.js';

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
 * Read the grill worker's injected env into a chat binding, or undefined when
 * not running inside a daemon worker (CLI/dev — no card layer).  The worker
 * sets BOTMUX_CHAT_ID / _LARK_APP_ID / _ROOT_MESSAGE_ID / _SESSION_ID on every
 * CLI subprocess (worker.ts).  A binding needs at least larkAppId + chatId to
 * be useful for posting a card; missing either → undefined.
 */
export function chatBindingFromEnv(env: NodeJS.ProcessEnv = process.env): RunChatBinding | undefined {
  const larkAppId = env.BOTMUX_LARK_APP_ID;
  const chatId = env.BOTMUX_CHAT_ID;
  if (!larkAppId || !chatId) return undefined;
  return {
    larkAppId,
    chatId,
    ...(env.BOTMUX_ROOT_MESSAGE_ID ? { rootMessageId: env.BOTMUX_ROOT_MESSAGE_ID } : {}),
    ...(env.BOTMUX_SESSION_ID ? { sessionId: env.BOTMUX_SESSION_ID } : {}),
  };
}

export interface SpecFinalizeOutcome {
  ok: boolean;
  state?: GrillState;
  /** Present on failure — the parse/validate problems that BLOCK handoff. */
  problems?: string[];
}

/** Parse + validate spec.md → write spec.json → status=spec_ready.  On a
 *  SpecValidationError, returns {ok:false, problems} and leaves status untouched
 *  (grill stays grilling and relays the problems to the user). */
export function hostSpecFinalize(runDir: string, now: Date = new Date()): SpecFinalizeOutcome {
  const cur = mustRead(runDir);
  // Guard the status BEFORE finalizeSpec writes spec.json — otherwise an
  // illegal-state call (e.g. re-finalizing after the spec was approved /
  // architected) would overwrite spec.json and only THEN hit the rejected
  // transition, leaving state ⇄ canonical-spec inconsistent (codex review).
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
}

/** gate-1: spec_ready → spec_approved.  Rejects unless status is spec_ready. */
export function hostApproveSpec(runDir: string, now: Date = new Date()): GrillState {
  const cur = mustRead(runDir);
  if (cur.status !== 'spec_ready') {
    throw new HostGuardError(`approve-spec 需要 status=spec_ready，当前 ${cur.status}`);
  }
  return transition(runDir, 'spec_approved', {}, now);
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
  const cur = mustRead(runDir);
  // Accept `spec_approved` (the normal entry) AND `architect_running`
  // (crash-recovery): a prior architect run can be killed AFTER it persisted
  // `architect_running` but BEFORE it could retreat to spec_approved, leaving
  // the status stuck mid-flight.  Without this, the only path out of
  // `architect_running` would be a manual edit — re-running architect would
  // dead-end behind a spec_approved-only guard (codex review 2026-06-02).
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
    const problems = [err instanceof Error ? err.message : String(err)];
    const state = transition(runDir, 'spec_approved', { problems }, now);
    return { ok: false, state, problems };
  }

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
}

/** gate-2: dag_ready → dag_approved.  Returns the recorded dagPath for the
 *  runner.  Rejects unless status is dag_ready. */
export function hostApproveDag(runDir: string, now: Date = new Date()): { state: GrillState; dagPath: string } {
  const cur = mustRead(runDir);
  if (cur.status !== 'dag_ready') {
    throw new HostGuardError(`approve-dag 需要 status=dag_ready，当前 ${cur.status}`);
  }
  if (!cur.dagPath) throw new Error('dag_ready 状态缺 dagPath（内部不一致）');
  const state = transition(runDir, 'dag_approved', {}, now);
  return { state, dagPath: cur.dagPath };
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
  const cur = mustRead(runDir);
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
}

/**
 * 改稿·只改流程：需求没变、只是 DAG 编得不满意时，从 `dag_ready` 退回
 * `spec_approved` 并清掉 stale 的 dag 产物，使 `architect` 在同一份已批准 spec
 * 上重编一张，不必重新 grill。
 */
export function hostReviseDag(runDir: string, now: Date = new Date()): GrillState {
  const cur = mustRead(runDir);
  if (cur.status !== 'dag_ready') {
    throw new HostGuardError(`revise-dag 需要 status=dag_ready，当前 ${cur.status}`);
  }
  return transition(
    runDir,
    'spec_approved',
    { dagPath: undefined, notesPath: undefined, architectManifestPath: undefined, problems: undefined },
    now,
  );
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
export async function cmdWorkflowHost(sub: string, rest: string[]): Promise<void> {
  const baseDir = argValue(rest, '--base-dir') ?? defaultBaseDir();

  switch (sub) {
    case 'new': {
      const goal = firstPositional(rest);
      if (!goal) throw new Error('用法: botmux workflow new "<目标>" [--base-dir <dir>]');
      // grill 经 daemon worker 出生时，env 带话题上下文 → 落 chatBinding，供后续
      // daemon humanGate 发审批卡用（CLI/dev 出生无 env → undefined，不影响）。
      const chatBinding = chatBindingFromEnv();
      const { runId, runDir, state } = hostNew({ goal, baseDir, chatBinding });
      console.log(JSON.stringify({
        runId, runDir, status: state.status, specPath: state.specPath,
        chatBound: !!chatBinding,
      }, null, 2));
      return;
    }
    case 'spec-finalize': {
      const runId = requireRunId(rest);
      const out = hostSpecFinalize(runDirFor(runId, baseDir));
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
      const state = hostApproveSpec(runDirFor(runId, baseDir));
      console.log(JSON.stringify({ runId, status: state.status }, null, 2));
      return;
    }
    case 'revise-spec': {
      const runId = requireRunId(rest);
      const state = hostReviseSpec(runDirFor(runId, baseDir));
      console.log(JSON.stringify({ runId, status: state.status }, null, 2));
      console.log('\n↩️  已退回 grilling，可改 spec.md 再 spec-finalize（原 DAG 产物已作废）。');
      return;
    }
    case 'revise-dag': {
      const runId = requireRunId(rest);
      const state = hostReviseDag(runDirFor(runId, baseDir));
      console.log(JSON.stringify({ runId, status: state.status }, null, 2));
      console.log('\n↩️  已退回 spec_approved，可直接重跑 architect 重编 DAG（需求不变）。');
      return;
    }
    case 'architect': {
      const runId = requireRunId(rest);
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
      const { state, dagPath } = hostApproveDag(runDirFor(runId, baseDir));
      console.log(JSON.stringify({ runId, status: state.status, dagPath }, null, 2));
      console.log(`\n✅ DAG 已批准。开跑：botmux v3 run ${dagPath}`);
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
async function runArchitectCli(runId: string, baseDir: string, rest: string[]): Promise<ArchitectOutcome> {
  const { loadBotConfigs } = await import('../../bot-registry.js');
  const bots = loadBotConfigs();
  if (bots.length === 0) throw new Error('没有可用 bot 配置（bots.json 为空）');
  const selector = argValue(rest, '--bot');
  const bot = selector
    ? bots.find((b) => b.larkAppId === selector || b.name === selector)
    : bots[0];
  if (!bot) throw new Error(`找不到 bot "${selector}"`);

  const secretById = new Map(bots.map((b) => [b.larkAppId, b.larkAppSecret]));
  // Use the authoritative BotConfig → BotSnapshot constructor so restricted bots
  // keep `disableCliBypass` here too — a hand-rolled snapshot that drops it would
  // let the architect goal-worker (writes files / runs commands / produces the
  // dag.json that drives the whole run) silently start with --dangerously-skip-
  // permissions, violating the "downgrade-only" capability invariant.
  const botSnapshot: BotSnapshot = botToSnapshot(bot, argValue(rest, '--working-dir'));

  return hostArchitect(runDirFor(runId, baseDir), {
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
