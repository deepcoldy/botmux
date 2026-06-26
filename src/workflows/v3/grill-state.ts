/**
 * v3 grill-phase lifecycle state.
 *
 * The PRE-runtime "front matter" of a run: the status machine tracking
 * grill → architect → human approvals, persisted to `<runDir>/grill.state.json`
 * so a daemon/session restart resumes the right phase without guessing from
 * chat context (codex review 2026-06-02).  The seam is `dag_approved`: after
 * it, the v3 runtime takes over with its own journal.ndjson + STATE (execution
 * truth) and this file stops changing.
 *
 * Kept separate from `state.ts` (the runtime run snapshot) on purpose — grill
 * state is a conversation/orchestration worktable, NOT execution state, and the
 * grill layer must never write the runtime journal (codex 2026-06-02).
 *
 * This module is plain host-side code (CLI/daemon), so `new Date()` is fine —
 * the `Date.now` ban is only inside Workflow() orchestration scripts.
 */
import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type GrillStatus =
  | 'grilling'          // 拷问中，spec 未定型
  | 'spec_ready'        // spec.md/spec.json 已 finalize，等用户确认（gate-1）
  | 'spec_approved'     // 用户确认需求，可跑 architect
  | 'architect_running' // architect goal-worker 合成 dag.json 中
  | 'dag_ready'         // dag.json 合成 + host validateDag 通过，等用户确认（gate-2）
  | 'dag_approved';     // 用户确认 DAG → 交 runtime（seam，之后 runtime 接管）

export const GRILL_STATUS_FILE = 'grill.state.json';
export const GRILL_STATE_SCHEMA_VERSION = 1;

/**
 * Where a daemon-driven run posts its humanGate approval cards.  Captured at
 * run birth from the grill worker's injected env (`BOTMUX_CHAT_ID` /
 * `_LARK_APP_ID` / `_ROOT_MESSAGE_ID` / `_SESSION_ID`).  WHY persist it: the
 * daemon's ability to post a card is NOT from in-process context — after a
 * restart, `cold-attach` reads this off disk to know which topic to re-post a
 * pending gate card to (see humanGate daemon-card design §4.2).  CLI/dev runs
 * (no grill, terminal y/N gate) simply omit it.
 */
export interface RunChatBinding {
  larkAppId: string;
  chatId: string;
  /** thread anchor (rootMessageId) so the card lands in the grill topic. */
  rootMessageId?: string;
  sessionId?: string;
  /** open_id of the grill initiator, if known — used for the approve gate. */
  ownerOpenId?: string;
}

export interface GrillState {
  schemaVersion: number;
  runId: string;
  /** 触发 grill 的原始模糊需求（grill 的种子）. */
  goal: string;
  status: GrillStatus;
  createdAt: string;
  updatedAt: string;
  /** <runDir>/spec.md（grill 写的人读叙事 + fenced json 块）. */
  specPath: string;
  /** <runDir>/spec.json（spec-finalize 物化的 canonical 结构）. */
  specJsonPath: string;
  /** architect 产物路径（dag_ready 起有值；codex 断言3：后续别重猜路径）. */
  dagPath?: string;
  notesPath?: string;
  architectManifestPath?: string;
  /** validateDag / architect 失败的问题列表（供 grill 回修；codex 断言2）. */
  problems?: string[];
  /** 飞书话题绑定（daemon 发 humanGate 审批卡用）；CLI/dev 出生时无. */
  chatBinding?: RunChatBinding;
}

/**
 * Legal forward transitions.  Failures / human "改一下" can step BACK to an
 * earlier phase (so grill can re-converge the spec); you can never skip a gate
 * forward.  In particular `spec_approved` is the only state from which
 * `architect_running` is reachable — the backstop for codex assertion 1.
 *
 * Two self-loops exist on purpose (codex review 2026-06-02):
 *  - `spec_ready → spec_ready`: re-running `spec-finalize` to re-validate a
 *    Gate-1 re-draft in place (the user tweaked the requirement before
 *    approving) — see `hostSpecFinalize`.
 *  - `architect_running → architect_running`: crash-recovery re-entry.  If a
 *    prior `architect` run was killed before it could retreat, the status is
 *    stuck mid-flight; re-running `architect` resumes from here instead of
 *    dead-ending behind the `spec_approved`-only guard.
 */
const LEGAL: Record<GrillStatus, GrillStatus[]> = {
  grilling:          ['grilling', 'spec_ready'],
  spec_ready:        ['spec_ready', 'spec_approved', 'grilling'], // 自环=Gate-1 改稿重校验；回 grilling=revise-spec
  spec_approved:     ['architect_running', 'grilling'],
  architect_running: ['architect_running', 'dag_ready', 'spec_approved', 'grilling'], // 自环=崩溃恢复重入；退回=architect/validate 失败
  dag_ready:         ['dag_approved', 'spec_approved', 'grilling'], // 退回 spec_approved=revise-dag；回 grilling=revise-spec
  dag_approved:      ['dag_approved'],                          // 终态（交给 runtime）
};

export class GrillTransitionError extends Error {
  constructor(public readonly from: GrillStatus, public readonly to: GrillStatus) {
    super(`非法 grill 状态转移：${from} → ${to}`);
    this.name = 'GrillTransitionError';
  }
}

/** Default run root, aligned with `cli-run.ts`'s `~/.botmux/v3-runs`. */
export function defaultBaseDir(): string {
  return join(homedir(), '.botmux', 'v3-runs');
}

function statePath(runDir: string): string {
  return join(runDir, GRILL_STATUS_FILE);
}

/** Atomic write (tmp + rename), mirroring state.ts so a crash never leaves a
 *  half-written grill.state.json. */
export function writeGrillState(runDir: string, state: GrillState): void {
  mkdirSync(runDir, { recursive: true });
  const p = statePath(runDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, p);
}

/**
 * Read a run's grill state, or `undefined` if it's missing OR corrupt
 * (unparseable / mid-write torn JSON).  Defensive-on-purpose (codex review):
 * cold-attach reconcile scans every runDir, so one corrupt grill.state must not
 * throw and kill the whole scan — it just makes that run look stateless.
 */
export function readGrillState(runDir: string): GrillState | undefined {
  const p = statePath(runDir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as GrillState;
  } catch {
    return undefined;
  }
}

/** Slugify a (possibly CJK) goal into a path-safe runId prefix. */
function slug(goal: string): string {
  const s = goal.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s || 'run';
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface BirthResult {
  runId: string;
  runDir: string;
  state: GrillState;
}

/**
 * Birth a run: allocate a runId (`<slug>-<yymmdd-hhmm>` unless one is given —
 * OQ-D), create its runDir, and write the initial `grilling` state.  grill is
 * the birth point of a run; spec.md and the later dag.json both live in runDir.
 */
export function birthRun(opts: {
  goal: string;
  baseDir?: string;
  runId?: string;
  now?: Date;
  /** 飞书话题绑定（grill 经 daemon 出生时带；CLI/dev 出生省略）. */
  chatBinding?: RunChatBinding;
}): BirthResult {
  const baseDir = opts.baseDir ?? defaultBaseDir();
  const now = opts.now ?? new Date();
  const runId = opts.runId ?? `${slug(opts.goal)}-${stamp(now)}`;
  const runDir = join(baseDir, runId);
  const iso = now.toISOString();
  const state: GrillState = {
    schemaVersion: GRILL_STATE_SCHEMA_VERSION,
    runId,
    goal: opts.goal,
    status: 'grilling',
    createdAt: iso,
    updatedAt: iso,
    specPath: join(runDir, 'spec.md'),
    specJsonPath: join(runDir, 'spec.json'),
    ...(opts.chatBinding ? { chatBinding: opts.chatBinding } : {}),
  };
  writeGrillState(runDir, state);
  return { runId, runDir, state };
}

/**
 * Read a run's chat binding off disk (from grill.state.json).  The daemon's
 * run driver + cold-attach recovery use this to know where to post / re-post a
 * humanGate approval card.  Returns undefined for CLI/dev runs (no binding) or
 * a missing/unparseable state file.
 */
export function readRunChatBinding(runDir: string): RunChatBinding | undefined {
  return readGrillState(runDir)?.chatBinding;
}

/**
 * Apply a status transition with a legality check + field patch, atomically.
 * Throws `GrillTransitionError` on an illegal transition (the state-machine
 * backstop behind the friendlier guards the `workflow` subcommands surface).
 */
export function transition(
  runDir: string,
  to: GrillStatus,
  patch: Partial<Omit<GrillState, 'status' | 'runId' | 'schemaVersion'>> = {},
  now: Date = new Date(),
): GrillState {
  const cur = readGrillState(runDir);
  if (!cur) throw new Error(`grill.state.json 不存在于 ${runDir}`);
  if (!LEGAL[cur.status].includes(to)) {
    throw new GrillTransitionError(cur.status, to);
  }
  const next: GrillState = { ...cur, ...patch, status: to, updatedAt: now.toISOString() };
  writeGrillState(runDir, next);
  return next;
}

export function canTransition(from: GrillStatus, to: GrillStatus): boolean {
  return LEGAL[from].includes(to);
}
