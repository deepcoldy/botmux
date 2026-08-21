/**
 * v3 runtime ⇄ ephemeral-pool IPC contract.
 *
 * This is the SHARED boundary between the two halves of the v3 engine:
 *   - scheduling / persistence side (claude): `runtime.ts` calls `runNode`,
 *     consumes the returned manifest, writes the next node's `inputs.json`.
 *   - execution / IPC side (codex): `ephemeral-pool.ts` implements `runNode`
 *     (spawns a throwaway worker in goal-mode), `manifest.ts` implements the
 *     `Manifest` validator.
 *
 * Both sides import the *types* from here so the contract can't silently drift.
 * Implementations live in their owners' files; this module is types + frozen
 * string constants only (no runtime logic).  See
 * `docs/design/2026-06-01-v3-mvp-engine-split.md` §2 for prose.
 */

import type { CliId } from '../../adapters/cli/types.js';
import type { CodexReasoningEffort } from '../../services/codex-reasoning-effort.js';
import type { V3GoalNode } from './dag.js';
import type { RunChatBinding } from './grill-state.js';
import type { V3ArmedAttemptWorkerFence } from './worker-fence.js';
import type { AttemptLease } from './runtime-host-contract.js';
import type { ManifestFileKind } from './artifact-contract.js';

// ─── Manifest (node product declaration) ───────────────────────────────────

export {
  MANIFEST_FILE_KINDS,
  MANIFEST_PREVIEW_MAX_BYTES,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_STATUSES,
  MANIFEST_SUMMARY_MAX_BYTES,
} from './artifact-contract.js';
export type {
  Manifest,
  ManifestFile,
  ManifestFileKind,
  ManifestStatus,
  ManifestValidationResult,
  ValidateManifest,
} from './artifact-contract.js';

// ─── Downstream inputs (runtime writes, goal-mode reads) ────────────────────

/**
 * Written by the runtime at `BOTMUX_GOAL_INPUTS_PATH` for each node, resolved
 * from the manifests of the node's upstream `inputs.from`.  Unlike the
 * manifest, the `path` here is ABSOLUTE so the consuming agent can `Read` it
 * directly without knowing the upstream layout.
 */
export interface GoalInputs {
  inputs: Array<{
    from: string;          // upstream nodeId
    name: string;          // logical file name (from upstream manifest)
    path: string;          // ABSOLUTE path, ready to Read
    kind: ManifestFileKind;
    preview?: string;
  }>;
  /** Declared inputs NOT injected: edge resolved inactive / source skipped
   *  (edge-activation design §6) or a P3 per-file selector matched nothing in
   *  the upstream manifest ('selectorMiss').  Telling the agent "this absence
   *  is known" stops it from hallucinating the missing product. */
  omitted?: Array<{
    from: string;
    reason: 'edgeInactive' | 'sourceSkipped' | 'sourceCancelled' | 'earlyRelease' | 'selectorMiss';
  }>;
}

// ─── goal-mode env contract (runtime fills, skill reads) ────────────────────

/**
 * The fixed env keys the runtime injects into every goal-mode worker.  The
 * `botmux-goal` skill / bootstrap prompt reads these by name — keeping the
 * names here (not magic strings scattered across files) is the contract.
 */
export const GOAL_ENV = {
  /** Path to the single-sentence goal text file. */
  GOAL_PATH: 'BOTMUX_GOAL_PATH',
  /** Path to this node's resolved `GoalInputs` JSON. */
  INPUTS_PATH: 'BOTMUX_GOAL_INPUTS_PATH',
  /** Directory the worker may write products into (and ONLY here). */
  OUTPUT_DIR: 'BOTMUX_GOAL_OUTPUT_DIR',
  /** Path the worker MUST write its `Manifest` to before exiting. */
  MANIFEST_PATH: 'BOTMUX_GOAL_MANIFEST_PATH',
  /** This attempt's directory (logs, manifest, work/ live under it). */
  ATTEMPT_DIR: 'BOTMUX_GOAL_ATTEMPT_DIR',
  /** Set to '1' — marks a goal-mode run so worker chat/card/ask side effects
   *  stay silent (codex point 4). */
  V3_MARKER: 'BOTMUX_V3_GOAL',
} as const;

// ─── Runtime human-ask (goal worker → human, rides the blocked+retry rail) ──

/**
 * A goal worker that needs a human decision mid-run does NOT block in-process.
 * Instead it writes its question to `GOAL_ASK_FILE` under the attempt
 * dir, then exits with a fail manifest carrying `error.code = ASK_HUMAN_ERROR_CODE`
 * and `error.retryable: true`.  classifyTerminal routes that to `blocked` (the
 * retryable half), and the daemon posts an ask card instead of a plain retry
 * card.  When the human answers, the daemon writes `GOAL_ANSWER_FILE` next to the
 * ask and re-dispatches the node; the next attempt's GoalInputs injects the
 * answer as `{from:'human', name:'answer'}`.  No suspend machinery, no held worker — it
 * is the ordinary blocked→retry lifecycle with question/answer payloads bolted
 * onto the two journal events.
 */
export const ASK_HUMAN_ERROR_CODE = 'ASK_HUMAN';

/** Filename (relative to the attempt dir) the goal worker writes its
 *  {@link GoalAsk} to before exiting with an ASK_HUMAN fail manifest. */
export const GOAL_ASK_FILE = 'ask.json';

/** Filename (relative to the *asked* attempt's dir) the daemon writes the
 *  human's {@link GoalAnswer} to; the retry's GoalInputs points at this path. */
export const GOAL_ANSWER_FILE = 'answer.json';

export type { GoalAnswer, GoalAsk } from './event-contract.js';

// ─── Supported CLIs ─────────────────────────────────────────────────────────

/**
 * v3 goal-mode is delivered via the native `/goal` command.  Keep this list
 * capability-based and explicit. Claude Code, Codex, Seed, and Traex have
 * direct `/goal` execution evidence (Traex 0.200.16+ also needs its automation
 * hook-trust flag). Relay is admitted from its exact Claude-family adapter and
 * slash-command compatibility with Seed; a Relay-binary smoke remains pending
 * on hosts where that binary is installed. The manifest watcher and goal env
 * contract are CLI-neutral after dispatch. The runtime rejects a run whose
 * nodes resolve to any other CLI at start time.
 */
export const V3_SUPPORTED_CLIS: readonly CliId[] = [
  'claude-code',
  'codex',
  'seed',
  'traex',
  'relay',
];

export function isV3SupportedCli(cliId: CliId): boolean {
  return V3_SUPPORTED_CLIS.includes(cliId);
}

// ─── BotSnapshot (frozen at run start) ──────────────────────────────────────

/**
 * The spawn-relevant bot config, FROZEN when the run starts and persisted in
 * the runDir.  The pool spawns ephemeral workers from this snapshot rather
 * than re-reading `bots.json` at execution time, so a retry / daemon-restart
 * reproduces the original cliId / model / reasoning effort / workingDir even
 * if the live bot config drifted (codex point 1).
 *
 * Deliberately omits `larkAppSecret`: secrets are not written into the runDir.
 * The pool re-reads the secret by `larkAppId` from the live registry at spawn
 * (secret rotation is not the drift we're guarding against).  If we later need
 * fully-hermetic replay we can revisit, but not at the cost of secrets on disk.
 */
export interface BotSnapshot {
  larkAppId: string;
  cliId: CliId;
  cliPathOverride?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  /** Frozen per-bot sandbox policy. Workflow workers must not silently lose
   *  these fields when spawning outside the main forkWorker path. */
  sandbox?: boolean;
  /** New three-tier fs-policy lists (deny-by-default). Carried alongside the
   *  legacy fields so a workflow worker builds the SAME policy as a normal
   *  session; without it the readWrite tier + user-expressed deny are lost. */
  sandboxPaths?: { readWrite?: string[]; readOnly?: string[]; deny?: string[] };
  sandboxHidePaths?: string[];
  sandboxReadonlyPaths?: string[];
  sandboxNetwork?: boolean;
  /** The resolved working directory for this run. */
  workingDir: string;
}

// ─── runNode (the single call across the boundary) ──────────────────────────

/** Returned alongside the result so dashboard terminal / replay / resume can
 *  attach later without a contract change (codex point 1).  All optional —
 *  MVP may leave it undefined. */
export interface WorkerSessionInfo {
  sessionId: string;
  webPort?: number;
  token?: string;
}

export interface RunNodeRequest {
  runId: string;
  /** Stable id e.g. `research/attempts/001`, used for sessionId / log naming. */
  attemptId: string;
  /** Host-neutral scheduler ownership. New runtime calls always provide this;
   * optional during the compatibility window for older RunNode adapters. */
  attemptLease?: AttemptLease;
  node: V3GoalNode;
  /** Frozen at run start; do NOT re-resolve the bot here. */
  botSnapshot: BotSnapshot;
  runDir: string;
  attemptDir: string;
  inputsPath: string;
  outputDir: string;
  /** Already includes the GOAL_ENV keys; pool merges into the worker env. */
  env: Record<string, string>;
  /** The run's authenticated chat binding (recorded by the daemon at run
   *  birth).  The pool threads it into the worker init so the CLI child sees
   *  the standard BOTMUX_* identity env (real chatId / ownerOpenId / …)
   *  instead of synthetic `v3-chat-*` values — custom CLI wrappers rely on
   *  `BOTMUX_OWNER_OPEN_ID` for per-user permission isolation.  Absent for
   *  standalone/dev runs → synthetic values, no owner env. */
  chatBinding?: RunChatBinding;
  /** Durable pre-fork ownership record. The pool must activate this exact
   * fence before it sends init, and may resolve only after outer `close`. */
  workerFence?: V3ArmedAttemptWorkerFence;
  timeoutMs: number;
  cancelSignal?: AbortSignal;
  /** Called as soon as the worker web terminal is ready, before the node
   *  reaches terminal.  Runtime uses this to append `nodeSessionReady` so the
   *  dashboard can attach to an in-flight node instead of waiting for
   *  RunNodeResult at completion. */
  onSessionReady?: (info: WorkerSessionInfo & { ptyLogPath?: string }) => void | Promise<void>;
  /** Defaults to `${attemptDir}/stdout.log` when omitted. */
  stdoutPath?: string;
  /** Defaults to `${attemptDir}/stderr.log` when omitted. */
  stderrPath?: string;
}

export interface RunNodeResult {
  /** Process-level outcome.  Final node verdict = this AND manifest validation
   *  (runtime validates the manifest at `manifestPath` after `runNode`
   *  resolves — codex point 4: NOT v0.2 final_output semantics). */
  status: 'ok' | 'fail' | 'cancelled';
  /** Preserved AbortSignal.reason for a cancelled worker. The runtime treats
   *  this as audit/control metadata only; it is never rendered to users. */
  cancelReason?: unknown;
  /** Where the worker wrote its manifest (defaults to attemptDir/manifest.json
   *  but returned explicitly so the layout stays the pool's choice within
   *  attemptDir). */
  manifestPath: string;
  sessionInfo?: WorkerSessionInfo;
}

/**
 * Implemented by `ephemeral-pool.ts` (codex), called by `runtime.ts` (claude).
 * Spawns one throwaway worker that runs the node's goal in goal-mode, waits
 * for it to exit (or the timeout / cancel to fire), and resolves with the
 * process outcome + manifest location.  The pool does NOT interpret the
 * manifest — the runtime validates it.
 */
export type RunNode = (req: RunNodeRequest) => Promise<RunNodeResult>;

// ─── Spec (grill 产物 → architect 输入) ──────────────────────────────────────

export const SPEC_SCHEMA_VERSION = 1;

/**
 * One prospective node in the requirement-decomposition sketch.  grill writes
 * these (the WHAT); architect turns them into formal dag.json nodes (the HOW).
 *
 * `input_needs` is FREE TEXT ("需要 research 阶段产出的竞品事实"), NOT a list of
 * upstream sketchIds — grill must not draw edges; architect parses `input_needs`
 * into the dag's `depends`. (codex review 2026-06-02.)  `risk_gate` → dag.json
 * humanGate on the corresponding node.
 */
export interface SpecNodeSketch {
  sketchId: string;
  goal: string;
  input_needs: string[];
  expected_outputs: string[];
  acceptance: string;
  risk_gate: boolean;
  unknowns: string[];
}

/**
 * The canonical, machine-readable spec.  `workflow spec-finalize` parses the
 * fenced ```json block out of spec.md, validates it, and materializes this as
 * `spec.json` (parse/validate failure blocks handoff — codex review 2026-06-02).
 * architect reads `spec.json` for STRUCTURE; `spec.md` is narrative context only.
 *
 * Node sketch ships as fenced JSON (not YAML) — dependency-free, mirrors v0.2's
 * JSON workflow definitions, and an LLM emits valid JSON reliably.
 */
export interface Spec {
  schemaVersion: number;
  runId: string;
  title: string;
  /** grill 收敛后的清晰需求陈述. */
  requirement: string;
  /** 整体验收标准（人读叙事在 spec.md，这里给 architect 的结构化副本）. */
  acceptance?: string;
  /** 明确不做的. */
  nonGoals?: string[];
  nodes: SpecNodeSketch[];
}

// ─── Architect seam ─────────────────────────────────────────────────────────
// `runArchitect(...)` + its `RunArchitectInput`/`RunArchitectResult` live in
// `architect.ts` (codex owns the architect goal-worker).  The host controller
// imports them from there directly — they are NOT redefined here (one-directional
// host→architect call, not a bidirectional injection contract like RunNode).
// The host still runs loadDag/validateDag on the returned dagPath; it does NOT
// trust architect's self-claim of validity. (seam agreed w/ codex 2026-06-02.)
