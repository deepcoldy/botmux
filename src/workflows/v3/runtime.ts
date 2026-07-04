/**
 * v3 runtime — the scheduling main loop.
 *
 * Ties the pure pieces together against the SHARED contract:
 *   load dag → freeze bot snapshots → init runDir →
 *   { materialize journal → decideNext → dispatch ready work under caps →
 *     await a settle → repeat } until terminal.
 *
 * Every side effect lives here (journal append, STATE checkpoint, dir layout,
 * goal/inputs/env materialization).  The actual worker spawn (`runNode`) and
 * manifest validation (`validateManifest`) are INJECTED — codex's
 * `ephemeral-pool.ts` / `manifest.ts` provide them, but the runtime compiles
 * against the contract types alone so the two halves build independently.
 *
 * MVP scope: static DAG, fail-fast, no retry (always `attempts/001`).  Retry
 * (`attempts/NNN`) and richer cancel semantics are deferred — see
 * `docs/design/2026-06-01-v3-mvp-engine-split.md`.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';

import {
  DEFAULT_NODE_TIMEOUT_SEC,
  DEFAULT_REVISIT_BUDGET_PER_PAIR,
  DEFAULT_REVISIT_BUDGET_PER_RUN,
  isGoalNode,
  isLoopNode,
  loopInstanceId,
  type V3Dag,
  type V3InputRef,
  type V3LoopExitWhen,
  type V3LoopNode,
  type V3Node,
  type V3ResultSchema,
} from './dag.js';
import { decideNext, type V3Action } from './orchestrator.js';
import { appendEvent, readJournal, type StoredEvent, type V3ErrorClass, type V3LoopRef } from './journal.js';
import { materialize, writeState } from './state.js';
import { normalizeGateWaitInput, writePendingWait } from './human-gate.js';
import {
  ASK_HUMAN_ERROR_CODE,
  GOAL_ASK_FILE,
  GOAL_ENV,
  MANIFEST_FILE_KINDS,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_STATUSES,
  V3_SUPPORTED_CLIS,
  isV3SupportedCli,
  type BotSnapshot,
  type GoalAsk,
  type GoalInputs,
  type Manifest,
  type RunNode,
  type RunNodeRequest,
  type ValidateManifest,
} from './contract.js';

// ─── goal.txt rendering ─────────────────────────────────────────────────────

/**
 * Render the self-contained instruction file the goal-mode agent reads via
 * `$BOTMUX_GOAL_PATH`.  The execution contract (read inputs / write products /
 * write the manifest) lives HERE — in a file — rather than inside the `/goal`
 * command text, because a long multi-line `/goal` argument trips Claude Code's
 * paste-detection (the TUI folds it into a "[Pasted text]" blob and the
 * slash-command parser never fires).  The pool's `buildGoalCommand` therefore
 * sends only a short single-line `/goal` that points the agent at this file.
 *
 * Rendered from `contract.ts` constants so the manifest shape stays a single
 * source of truth shared with codex's validator.
 */
export function renderGoalFile(
  goal: string,
  resultSchema?: V3ResultSchema,
  loopCtx?: { loopId: string; iteration: number; maxIterations: number },
  nodeInstructions?: string,
): string {
  const E = GOAL_ENV;
  const kinds = MANIFEST_FILE_KINDS.join(' | ');
  const [okStatus, failStatus] = MANIFEST_STATUSES;
  const hasEnum = resultSchema && Object.values(resultSchema.properties).some((p) => p.enum);
  const resultSection = resultSchema
    ? [
        '## Structured result (REQUIRED for this node)',
        `This node declares a structured output contract. Write a JSON file \`result.json\` directly under $${E.OUTPUT_DIR} matching this schema (declared property types are enforced at the top level; every \`required\` field must be present):`,
        '',
        '  ' + JSON.stringify(resultSchema),
        '',
        ...(hasEnum
          ? [
              'Fields declaring an `enum` MUST use one of the listed values EXACTLY (case-sensitive) — downstream routing decisions read these values, and anything outside the vocabulary blocks this node.',
              '',
            ]
          : []),
        `List \`result.json\` in the manifest \`files\` array like any other product (its \`path\` is exactly "result.json"). A missing or schema-violating result.json blocks this node.`,
        '',
      ]
    : [];
  const loopSection = loopCtx
    ? [
        '## Loop context',
        `This node runs inside loop "${loopCtx.loopId}", iteration ${loopCtx.iteration} of at most ${loopCtx.maxIterations}.`,
        ...(loopCtx.iteration > 1
          ? [
              'Inputs labeled `previous.<node>` are products of the PREVIOUS iteration (e.g. the last test report). Read them FIRST and fix what they describe — do not redo work that already passed, and do not guess what happened last round.',
            ]
          : []),
        'Report results honestly — a truthful "not passed" routes the rework correctly; a wishful "passed" ships a broken result.',
        '',
      ]
    : [];
  const instructionsSection = nodeInstructions
    ? ['## Node-specific instructions', nodeInstructions, '']
    : [];
  return [
    '# botmux v3 节点任务 / botmux v3 node task',
    '',
    '## Goal',
    goal,
    '',
    ...instructionsSection,
    ...loopSection,
    '## How to complete this node',
    'You are an autonomous agent completing exactly ONE botmux v3 workflow node.',
    'Work toward the goal above until it is done, then stop. Do NOT ask the user with interactive tools (they are disabled in this mode). If you genuinely need a human DECISION to proceed, use the human-ask escape hatch described below (also available as the `botmux-goal-ask` skill).',
    '',
    `- Upstream inputs: the file at $${E.INPUTS_PATH} is a JSON object \`{ "inputs": [...] }\` listing upstream products, each with an absolute \`path\`. Read only the ones the goal needs (it may be empty). If it includes an input entry \`{ "from": "human", "name": "answer", "path": "..." }\`, read that JSON file before continuing. If an \`omitted\` array is present, those declared inputs were intentionally not produced (their workflow branch was not taken) — treat their absence as by-design, do NOT invent their content.`,
    `- Revisit feedback: if any input has \`"from": "revisit"\`, a DOWNSTREAM node sent this node back because its product was inadequate. You MUST read these before doing anything else: \`reason\` (why you were sent back), \`source:*\` (the downstream node's output — the evidence of what was wrong), and \`previous:*\` (YOUR OWN previous output — edit/fix it, do not rewrite from scratch). Address the reason; do not just reproduce the prior output.`,
    `- Output: write ALL products under the directory at $${E.OUTPUT_DIR}. Do NOT write anything outside that directory.`,
    `- Manifest (required): before you finish, write a JSON manifest to $${E.MANIFEST_PATH} with exactly this shape:`,
    '',
    '  {',
    `    "schemaVersion": ${MANIFEST_SCHEMA_VERSION},`,
    `    "status": "${okStatus}" | "${failStatus}",`,
    '    "summary": "<one short line>",',
    '    "files": [',
    `      { "name": "<logical name>", "path": "<RELATIVE to the output dir>", "kind": "<${kinds}>", "bytes": <int>, "sha256": "<hex sha256 of the file; empty string \\"\\" for a directory>", "mime": "<mime type>", "preview": "<optional short excerpt>" }`,
    '    ],',
    `    "error": { "code": "...", "message": "...", "retryable": false }`,
    '  }',
    '',
    `  - On success: status "${okStatus}", at least one file entry, and NO \`error\` field.`,
    `  - On failure: status "${failStatus}", \`error\` required, \`files\` may be empty. Set \`error.retryable\` honestly: \`true\` when a human can unblock you and a fresh attempt could then succeed; \`false\` when retrying cannot help.`,
    `  - Every file \`path\` is relative to $${E.OUTPUT_DIR} ITSELF. A file you wrote directly into that directory has a path that is JUST its filename, e.g. \`"path": "report.md"\`. Do NOT prepend the directory or its folder name (NOT \`"work/report.md"\`) and do NOT use an absolute path — both are rejected.`,
    '',
    ...resultSection,
    `You are DONE only after the manifest at $${E.MANIFEST_PATH} exists and every file it references exists.`,
    'If you cannot complete the goal, write a failure manifest and stop.',
    'If you hit an authentication / authorization / interactive-confirmation wall (a login prompt, an expired token, a permission you cannot grant yourself): do NOT wait for a human and do NOT keep retrying. Immediately write a failure manifest with an \`error.code\` like "AUTH_REQUIRED" and \`error.retryable: true\`, then stop — a human will unblock and retry this node.',
    '',
    '## Asking a human (only when a DECISION truly needs a person)',
    `If — and ONLY if — you cannot proceed without a human's judgement call (a choice only a person can make; NOT something you can research, infer, or decide yourself), use the runtime human-ask:`,
    `  1. Write a JSON file to $${E.ATTEMPT_DIR}/${GOAL_ASK_FILE}. Use \`{ "question": "<one clear question>", "options": ["<2-6 concrete choices>"] }\` for a choice, or \`{ "question": "<one clear question>", "freeText": true }\` when the human must provide details in their own words.`,
    `  2. Write a failure manifest with \`error.code: "${ASK_HUMAN_ERROR_CODE}"\`, \`error.retryable: true\`, and \`summary\` = your question, then STOP.`,
    `A human answers; this node then RE-RUNS with their answer injected into $${E.INPUTS_PATH} as an input entry \`{ "from": "human", "name": "answer", "path": "..." }\`. Read that JSON file's \`selected\` or \`text\` field and continue from there. Prefer deciding yourself — every ask pauses the whole workflow on a person.`,
    '',
  ].join('\n');
}

// ─── Terminal classification + structured-result validation (pure) ──────────

/**
 * Map a node's failure to its terminal kind (the blocked/failed split):
 *   - `blocked`  = semantic/contract failure — retryable via a new attempt
 *   - `failed`   = infrastructure / human-veto / budget — needs intervention
 *
 * `selfReportedFail` marks the special case where the manifest is structurally
 * VALID but declares `status:'fail'` — then the node's own `error.retryable`
 * decides (`false` → failed; `true`/absent → blocked, the agent presumably
 * knows a human can unblock it).
 */
export function classifyTerminal(
  errorClass: V3ErrorClass,
  opts?: { selfReportedFail?: boolean; retryable?: boolean },
): 'blocked' | 'failed' {
  if (opts?.selfReportedFail) return opts.retryable === false ? 'failed' : 'blocked';
  switch (errorClass) {
    case 'manifestInvalid': // agent wrote a bad manifest — a retry may fix it
    case 'resultInvalid':   // result.json missing/violating — same
      return 'blocked';
    case 'workerError':     // process crash = infrastructure
    case 'timeout':         // budget exceeded = infrastructure (for now)
    case 'gateRejected':    // a human said no — retrying won't change that
    case 'cancelled':
      return 'failed';
  }
}

/**
 * Read + validate a goal worker's `ask.json` (the runtime human-ask payload).
 * Defensive: a missing / malformed / out-of-bounds file yields `undefined`, so a
 * broken ask degrades to a plain blocked card rather than crashing the drive —
 * the manifest's `error.message` still carries the question text for the human.
 * Accepts either 2–6 concrete options or `freeText:true`.  Exported for tests.
 */
export function readGoalAsk(askPath: string): GoalAsk | undefined {
  if (!existsSync(askPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(askPath, 'utf-8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  const question = typeof o.question === 'string' ? o.question.trim() : '';
  if (!question) return undefined;
  const hasOptions = Object.prototype.hasOwnProperty.call(o, 'options');
  if (o.freeText === true) {
    if (hasOptions) return undefined;
    return { question, freeText: true };
  }
  const options = Array.isArray(o.options)
    ? o.options.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
    : [];
  if (options.length < 2) return undefined;
  return { question, options: options.slice(0, 6) };
}

/**
 * Merge a node's capability override onto the bot's frozen snapshot (P2).
 * Pure + exported for tests.  Direction is one-way by construction:
 *   - model: node override wins (redirect, not escalation);
 *   - disableCliBypass: sticky-true — `restricted` can SET it, nothing can
 *     clear a bot-level restriction (`inherit` keeps whatever the bot has).
 */
export function mergeNodeCapability(
  snap: BotSnapshot,
  override: V3Node['override'],
): BotSnapshot {
  if (!override) return snap;
  return {
    ...snap,
    ...(override.model ? { model: override.model } : {}),
    ...(snap.disableCliBypass === true || override.permissionMode === 'restricted'
      ? { disableCliBypass: true }
      : {}),
  };
}

/** Validation outcome for an opt-in `result.json` against its node schema. */
export interface ResultValidation {
  ok: boolean;
  problems?: string[];
}

/** Read a worker's cross-node revisit request from `result.json` (if any).  A
 *  revisit is `{ "status": "revisit", "revisitTo": "<ancestor>", "reason"? }`.
 *  Absent result.json / non-revisit status → `{ ok:true }` (no request).  A
 *  malformed revisit (missing/blank revisitTo, non-string reason) → `ok:false`
 *  so the runtime blocks it as resultInvalid.  The ancestor membership check
 *  (toNodeId ∈ node.revisitTo) is the caller's (it has the node). */
/** Two-tier revisit budget check (anti-infinite-loop): a source→target pair may
 *  revisit `DEFAULT_REVISIT_BUDGET_PER_PAIR` times, and the whole run
 *  `DEFAULT_REVISIT_BUDGET_PER_RUN` times, each extendable by a
 *  `revisitBudgetGranted` event.  Counts revisits ALREADY made; returns
 *  `{ok:false, tier, detail}` when this next revisit would exceed a tier —
 *  `tier` tells the grant card which scope to extend (菲菲 review). */
export function revisitBudgetStatus(
  events: StoredEvent[],
  sourceNodeId: string,
  toNodeId: string,
): { ok: true } | { ok: false; tier: 'pair' | 'run'; detail: string } {
  let pairUsed = 0;
  let runUsed = 0;
  let pairGranted = 0;
  let runGranted = 0;
  for (const e of events) {
    if (e.type === 'nodeRevisitRequested') {
      runUsed++;
      if (e.nodeId === sourceNodeId && e.toNodeId === toNodeId) pairUsed++;
    } else if (e.type === 'revisitBudgetGranted') {
      if (e.sourceNodeId === sourceNodeId && e.toNodeId === toNodeId) pairGranted++;
      else if (e.sourceNodeId === undefined && e.toNodeId === undefined) runGranted++;
    }
  }
  const pairLimit = DEFAULT_REVISIT_BUDGET_PER_PAIR + pairGranted;
  const runLimit = DEFAULT_REVISIT_BUDGET_PER_RUN + runGranted;
  if (pairUsed >= pairLimit) {
    return { ok: false, tier: 'pair', detail: `revisit budget exhausted for ${sourceNodeId}->${toNodeId} (${pairUsed}/${pairLimit}) — grant +1 (this pair) to continue` };
  }
  if (runUsed >= runLimit) {
    return { ok: false, tier: 'run', detail: `run-wide revisit budget exhausted (${runUsed}/${runLimit}) — grant +1 (run) to continue` };
  }
  return { ok: true };
}

export function readRevisitRequest(
  manifest: Manifest,
  outputDir: string,
): { ok: true; request?: { toNodeId: string; reason?: string } } | { ok: false; problems: string[] } {
  const entry = manifest.files.find((f) => f.path === 'result.json');
  if (!entry) return { ok: true };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(outputDir, entry.path), 'utf-8'));
  } catch {
    return { ok: true }; // unreadable result.json: not a revisit (resultSchema path reports it)
  }
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).status !== 'revisit') {
    return { ok: true };
  }
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof v.revisitTo !== 'string' || v.revisitTo.trim() === '') {
    problems.push('result.json status "revisit" requires a non-empty string "revisitTo"');
  }
  if (v.reason !== undefined && typeof v.reason !== 'string') {
    problems.push('result.json "reason" must be a string when present');
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    request: {
      toNodeId: v.revisitTo as string,
      ...(typeof v.reason === 'string' && v.reason ? { reason: v.reason } : {}),
    },
  };
}

/**
 * Validate a `result.json` against the node's (already dag-validated) result
 * schema subset.  Top-level types only — see `V3ResultSchema`.  Undeclared
 * extra properties are allowed (JSON-Schema default).
 */
export function validateResult(filePath: string, schema: V3ResultSchema): ResultValidation {
  if (!existsSync(filePath)) return { ok: false, problems: [`result.json not found at ${filePath}`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { ok: false, problems: [`result.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: ['result.json root must be a JSON object'] };
  }
  const obj = parsed as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of schema.required ?? []) {
    if (!(field in obj)) problems.push(`missing required field "${field}"`);
  }
  for (const [name, spec] of Object.entries(schema.properties)) {
    if (!(name in obj)) continue; // absence is only a problem when required
    const v = obj[name];
    const okType =
      spec.type === 'string' ? typeof v === 'string'
      : spec.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : spec.type === 'boolean' ? typeof v === 'boolean'
      : spec.type === 'array' ? Array.isArray(v)
      : typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!okType) {
      problems.push(`field "${name}" must be of type ${spec.type}`);
      continue;
    }
    // Enum enforcement (edge-activation design §1.3): a declared vocabulary
    // is part of the contract — an out-of-vocabulary value is `resultInvalid`
    // (blocked, retryable), same as a type violation.
    if (spec.type === 'string' && spec.enum && !spec.enum.includes(v as string)) {
      problems.push(`field "${name}" must be one of [${spec.enum.join(', ')}] (got ${JSON.stringify(v)})`);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}

/**
 * Evaluate a (dag-validated) loop exit predicate against the observed result
 * field.  Pure + exported for tests.  Type mismatches simply don't match —
 * validateDag already guarantees the field is declared/required with a
 * compatible type, so a mismatch here means the result was tampered with
 * post-validation; not-matching (→ continue/exhausted) is the safe answer.
 */
export function matchLoopExitWhen(when: V3LoopExitWhen, value: unknown): boolean {
  if (when.equals !== undefined) return value === when.equals;
  if (when.notEquals !== undefined) return value !== when.notEquals;
  if (typeof value !== 'number') return false;
  if (when.gt !== undefined) return value > when.gt;
  if (when.gte !== undefined) return value >= when.gte;
  if (when.lt !== undefined) return value < when.lt;
  if (when.lte !== undefined) return value <= when.lte;
  return false;
}

// ─── Attempt numbering (journal-derived — no hardcoded 001) ──────────────────

const ATTEMPT_NNN_RE = /\/attempts\/(\d{3})$/;

function attemptNumber(attemptId: string): number | undefined {
  const m = ATTEMPT_NNN_RE.exec(attemptId);
  return m ? parseInt(m[1]!, 10) : undefined;
}

/**
 * Compute the attemptId the NEXT dispatch of `nodeId` must use, from the
 * journal: an unconsumed `nodeRetryRequested` reservation wins (retry intent
 * is authoritative for the redrive); otherwise max(seen)+1 — which is 001 for
 * a first dispatch.  Dispatch events are the authority for "seen"; a
 * reservation is consumed by a later `nodeDispatched` with the same number.
 */
export function nextAttemptIdFor(events: StoredEvent[], key: string): string {
  // `key` is the dispatch namespace: a runtime instance (`A#001`), a loop body
  // expansion (`loopId.i001.code`), or a legacy nodeId.  Match events by their
  // instance when they carry one, else by nodeId — so `A#002`'s attempts are
  // counted separately from `A#001`'s (constraint 3/5).
  const matches = (e: { nodeId: string; instanceId?: string }): boolean => (e.instanceId ?? e.nodeId) === key;
  let maxSeen = 0;
  let reserved: number | undefined;
  for (const e of events) {
    if (e.type === 'nodeDispatched' && matches(e)) {
      const n = attemptNumber(e.attemptId);
      if (n === undefined) continue;
      maxSeen = Math.max(maxSeen, n);
      if (reserved === n) reserved = undefined; // reservation consumed
    } else if (e.type === 'nodeRetryRequested' && matches(e)) {
      const n = attemptNumber(e.nextAttemptId);
      if (n === undefined) continue;
      reserved = n;
      maxSeen = Math.max(maxSeen, n);
    }
  }
  const n = reserved ?? maxSeen + 1;
  return `${key}/attempts/${String(n).padStart(3, '0')}`;
}

/** Latest dispatched attemptId for a dispatch `key` (the `previousAttemptId` a
 *  retry entrypoint must reference).  `key` is an instance (`A#001`), a loop
 *  body expansion, or a legacy nodeId — matched by `(instanceId ?? nodeId)` so
 *  a retry stays inside the same instance.  Undefined when never dispatched. */
export function latestAttemptIdFor(events: StoredEvent[], key: string): string | undefined {
  let latest: string | undefined;
  for (const e of events) {
    if (e.type === 'nodeDispatched' && (e.instanceId ?? e.nodeId) === key) latest = e.attemptId;
  }
  return latest;
}

// ─── Injected dependencies + options ────────────────────────────────────────

export interface V3RuntimeDeps {
  /** Spawn an ephemeral worker for one goal node (codex's pool). */
  runNode: RunNode;
  /** Validate a node's manifest after the worker exits (codex's manifest.ts). */
  validateManifest: ValidateManifest;
  /** Freeze a node's bot spawn config at run start.  Given `node.bot` (may be
   *  undefined → the run's default bot), returns the snapshot persisted in the
   *  runDir and threaded through `runNode` (never re-resolved mid-run). */
  resolveBotSnapshot: (botId: string | undefined) => BotSnapshot;
  /** Resolve a humanGate.  Required only if the DAG declares any gate; the
   *  runtime throws if a gate is hit without a handler.  (Wired by
   *  `human-gate.ts` post-milestone.) */
  resolveGate?: (req: {
    nodeId: string;
    prompt: string;
    waitId: string;
    runDir: string;
  }) => Promise<{ resolution: 'approved' | 'rejected'; by: string; selected?: string }>;
}

export interface V3RuntimeOptions {
  /** The run lives in `${baseDir}/${dag.runId}`. */
  baseDir: string;
  /** Gate handling model. `blocking` keeps the CLI/dev y/N path; `suspend`
   *  writes the pending wait and returns `awaitingGate` for a daemon/card layer
   *  to resolve and re-drive from disk. */
  gateMode?: 'blocking' | 'suspend'; // default blocking
  /** Concurrency caps (codex's three-layer cap; conservative defaults). */
  globalConcurrency?: number; // default 4
  perBotConcurrency?: number; // default 1
  perCliConcurrency?: number; // default 2
  cancelSignal?: AbortSignal;
}

export interface V3PendingGate {
  nodeId: string;
  waitId: string;
  prompt: string;
  options: string[];
  approveOptions: string[];
  approvers: string[];
}

export type V3RunOutcome =
  | {
      reason: 'terminal';
      // `blocked` is its OWN status — never collapse it into failed (it is the
      // retryable half of the blocked/failed split).
      runStatus: 'succeeded' | 'failed' | 'blocked';
      failedNodeId?: string;
      blockedNodeId?: string;
      failureReason?: 'allSinksSkipped';
      failureDetail?: string;
      runDir: string;
    }
  | { reason: 'awaitingGate'; pendingWaits: V3PendingGate[]; runDir: string };

// ─── Main loop ───────────────────────────────────────────────────────────

/**
 * Run a validated DAG to terminal.  Resumable: if `journal.ndjson` already has
 * events (daemon restart), the loop picks up from the materialized state
 * instead of re-running completed nodes.
 */
export async function runWorkflow(
  dag: V3Dag,
  deps: V3RuntimeDeps,
  opts: V3RuntimeOptions,
): Promise<V3RunOutcome> {
  const runDir = join(opts.baseDir, dag.runId);
  mkdirSync(runDir, { recursive: true });
  const journalPath = join(runDir, 'journal.ndjson');
  const statePath = join(runDir, 'STATE');

  const globalCap = opts.globalConcurrency ?? 4;
  const perBotCap = opts.perBotConcurrency ?? 1;
  const perCliCap = opts.perCliConcurrency ?? 2;
  const gateMode = opts.gateMode ?? 'blocking';

  const nodesById = new Map(dag.nodes.map((n) => [n.id, n]));

  // Freeze bot snapshots once, keyed by the node's `bot` field (''=default),
  // and persist for audit / resume.  Re-resolving mid-run would let a drifted
  // bots.json change cliId/model/workingDir under a retry (codex point 1).
  // Loop body nodes are frozen too (a body node inherits the loop's bot when
  // it has none of its own — mirror instanceNodeFor's resolution).
  const botSnapshots = new Map<string, BotSnapshot>();
  const freezeBot = (bot: string | undefined): void => {
    const key = bot ?? '';
    if (!botSnapshots.has(key)) botSnapshots.set(key, deps.resolveBotSnapshot(bot));
  };
  for (const node of dag.nodes) {
    freezeBot(node.bot);
    if (isLoopNode(node)) {
      for (const b of node.body.nodes) freezeBot(b.bot ?? node.bot);
    }
  }

  // CLI-scope guard (老滕 directive): goal-mode rides the native `/goal`
  // command, which only Claude Code / Codex support.  Fail the whole run up
  // front — clearly — rather than spawning a worker on an unsupported CLI that
  // would never understand `/goal`.
  for (const [key, snap] of botSnapshots) {
    if (!isV3SupportedCli(snap.cliId)) {
      throw new Error(
        `v3 runtime: bot "${key || '<default>'}" resolves to CLI "${snap.cliId}", ` +
        `which is not supported by v3 goal-mode (supported: ${V3_SUPPORTED_CLIS.join(', ')})`,
      );
    }
  }

  writeFileSync(
    join(runDir, 'bots.snapshot.json'),
    JSON.stringify(Object.fromEntries(botSnapshots), null, 2),
  );

  // Persist the dag into the runDir so the dashboard projection can read the
  // node graph (depends → edges) and a resume is self-describing.  Deterministic
  // (same runId ⇒ same dag), so re-writing on resume is harmless.
  writeFileSync(join(runDir, 'dag.json'), JSON.stringify(dag, null, 2));

  // First run only: stamp runStarted (idempotent on resume).
  if (readJournal(journalPath).length === 0) {
    appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
  }

  // In-flight bookkeeping.  Work uses the nodeId as the key; gates use
  // `${nodeId}::gate` so a gated node's work + gate never collide.
  const inFlight = new Map<string, Promise<void>>();
  const botInFlight = new Map<string, number>();
  const cliInFlight = new Map<string, number>();
  const nodeControllers = new Map<string, AbortController>();
  const nodeAbortCleanups = new Map<string, () => void>();

  while (true) {
    const events = readJournal(journalPath);
    const snap = materialize(events);
    writeState(statePath, snap);
    if (snap.runStatus !== 'running') break;

    const actions = decideNext(dag, snap.nodes, snap.loops, snap.edges, snap.instances);

    // Terminal sweep: write the run terminal event, then re-tick so the top of
    // the loop observes it and breaks (single exit path).
    const terminal = actions.find(
      (a) =>
        a.kind === 'completeRunSucceeded' ||
        a.kind === 'completeRunFailed' ||
        a.kind === 'completeRunBlocked',
    );
    if (terminal) {
      if (terminal.kind === 'completeRunSucceeded') {
        appendEvent(journalPath, { type: 'runSucceeded' });
      } else if (terminal.kind === 'completeRunFailed') {
        appendEvent(journalPath, {
          type: 'runFailed',
          failedNodeId: terminal.failedNodeId,
          reason: terminal.reason,
          detail: terminal.detail,
        });
      } else {
        appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: terminal.blockedNodeId });
      }
      continue;
    }

    // Control sweep: each action is one cheap journal append (no worker
    // involved), applied together and re-ticked — same single-exit shape as
    // the terminal sweep.  Work dispatches in the same action list simply
    // re-emerge next tick.  Edge resolution is deliberately serial/control
    // phase (H8): no inFlight, no concurrency slot, no AbortController.
    const controls = actions.filter(
      (a): a is
        | Extract<V3Action, { loopId: string }>
        | Extract<V3Action, { kind: 'resolveEdge' | 'skipNode' }> =>
        a.kind === 'startLoop' ||
        a.kind === 'startLoopIteration' ||
        a.kind === 'evaluateLoopIteration' ||
        a.kind === 'completeLoop' ||
        a.kind === 'resolveEdge' ||
        a.kind === 'skipNode',
    );
    if (controls.length > 0) {
      const eventsForControl = readJournal(journalPath);
      for (const a of controls) {
        if (a.kind === 'resolveEdge') applyResolveEdge(a, eventsForControl);
        else if (a.kind === 'skipNode') {
          appendEvent(journalPath, {
            type: 'nodeSkipped',
            nodeId: a.nodeId,
            reason: 'triggerRuleUnsatisfied',
            detail: a.detail,
          });
        } else applyLoopControl(a);
      }
      continue;
    }

    // Dispatch the ready set under the three-layer cap.  Anything not started
    // this tick (cap hit) is retried next tick.
    let startedThisTick = 0;
    const aborted = opts.cancelSignal?.aborted === true;
    if (!aborted) {
      for (const a of actions) {
        if (inFlight.size >= globalCap) break;
        if (a.kind === 'dispatchWork') {
          // Loop body instances are synthesized from the body definition; the
          // instance id is theirs alone (attempt dirs, journal events, retry).
          const node = a.loop ? instanceNodeFor(a.loop) : nodesById.get(a.nodeId)!;
          const botKey = node.bot ?? '';
          const botSnap = botSnapshots.get(botKey)!;
          if ((botInFlight.get(botKey) ?? 0) >= perBotCap) continue;
          if ((cliInFlight.get(botSnap.cliId) ?? 0) >= perCliCap) continue;
          startWork(node, botSnap, botKey, events, a.loop, a.omitted, a.instanceId);
          startedThisTick++;
        } else if (a.kind === 'dispatchGate') {
          startGate(nodesById.get(a.nodeId)!, a.instanceId);
          startedThisTick++;
        }
      }
    }

    const cancels = actions.filter((a): a is Extract<V3Action, { kind: 'cancelNode' }> =>
      a.kind === 'cancelNode');
    let cancelledThisTick = false;
    for (const a of cancels) {
      cancelledThisTick = applyCancelNode(a) || cancelledThisTick;
    }
    if (cancelledThisTick) continue;

    if (inFlight.size === 0) {
      if (aborted) break; // cancelled with nothing running → stop
      if (startedThisTick === 0) {
        const pendingWaits = gateMode === 'suspend' ? pendingGateWaits(snap.nodes) : [];
        if (pendingWaits.length > 0) {
          return { reason: 'awaitingGate', pendingWaits, runDir };
        }
        // Not terminal, nothing running, nothing dispatchable — a correct
        // decideNext never gets here; guard against an infinite spin.
        throw new Error('v3 runtime: no progress possible and run is not terminal');
      }
    }

    // Wait for at least one in-flight unit to settle before re-evaluating.
    if (inFlight.size > 0) await Promise.race(inFlight.values());
  }

  const finalSnap = materialize(readJournal(journalPath));
  return {
    reason: 'terminal',
    // Map 1:1 — blocked must NOT collapse into failed.  A 'running' snapshot
    // here means the loop exited via cancel-abort with nothing in flight;
    // report that as failed (the run did not complete).
    runStatus:
      finalSnap.runStatus === 'succeeded' ? 'succeeded'
      : finalSnap.runStatus === 'blocked' ? 'blocked'
      : 'failed',
    failedNodeId: finalSnap.failedNodeId,
    failureReason: finalSnap.failureReason,
    failureDetail: finalSnap.failureDetail,
    blockedNodeId: finalSnap.blockedNodeId,
    runDir,
  };

  // ─── closures over runDir / journalPath / caps ──────────────────────────

  function startWork(
    node: V3Node,
    botSnap: BotSnapshot,
    botKey: string,
    events: StoredEvent[],
    loopRef?: V3LoopRef,
    omitted?: GoalInputs['omitted'],
    instanceId?: string,
  ): void {
    // The dispatch key namespaces the attempt dir + journal events.  For a
    // plain node it's the runtime instance (`A#001`); for a loop body it's the
    // expanded node.id (`loopId.i001.code`); legacy/no-instance falls back to
    // node.id.  attempt dir = `<runDir>/<key>/attempts/NNN`.
    const dispatchKey = instanceId ?? node.id;
    // Attempt number derived from the journal: 001 on first dispatch, the
    // reserved nextAttemptId after a blocked retry (no hardcoded 001 — a retry
    // must not overwrite the previous attempt's logs/manifest/pty).
    const attemptId = nextAttemptIdFor(events, dispatchKey);
    const attemptNNN = attemptId.slice(attemptId.lastIndexOf('/') + 1);
    const attemptDir = join(runDir, dispatchKey, 'attempts', attemptNNN);
    const outputDir = join(attemptDir, 'work');
    mkdirSync(outputDir, { recursive: true });

    const goalPath = join(attemptDir, 'goal.txt');
    const loopCtx = loopRef
      ? {
          loopId: loopRef.loopId,
          iteration: loopRef.iteration,
          maxIterations: (nodesById.get(loopRef.loopId) as V3LoopNode).maxIterations,
        }
      : undefined;
    writeFileSync(
      goalPath,
      renderGoalFile(node.goal ?? '', node.resultSchema, loopCtx, node.override?.systemPromptAppend),
    );

    // P2: per-dispatch capability merge — model redirect + sticky restriction.
    const effSnap = mergeNodeCapability(botSnap, node.override);

    const inputsPath = join(attemptDir, 'inputs.json');
    writeFileSync(inputsPath, JSON.stringify(buildInputs(node, events, attemptId, loopRef, omitted), null, 2));

    const manifestPath = join(attemptDir, 'manifest.json');
    const env: Record<string, string> = {
      [GOAL_ENV.GOAL_PATH]: goalPath,
      [GOAL_ENV.INPUTS_PATH]: inputsPath,
      [GOAL_ENV.OUTPUT_DIR]: outputDir,
      [GOAL_ENV.MANIFEST_PATH]: manifestPath,
      [GOAL_ENV.ATTEMPT_DIR]: attemptDir,
      [GOAL_ENV.V3_MARKER]: '1',
    };

    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId, loop: loopRef });
    botInFlight.set(botKey, (botInFlight.get(botKey) ?? 0) + 1);
    cliInFlight.set(botSnap.cliId, (cliInFlight.get(botSnap.cliId) ?? 0) + 1);

    // `isGoalNode` is guaranteed by validateDag (host is rejected), but the
    // contract types `runNode` to V3GoalNode, so narrow explicitly.
    if (!isGoalNode(node)) {
      appendEvent(journalPath, {
        type: 'nodeFailed', nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId,
        errorClass: 'workerError', message: `node "${node.id}" is not a goal node`,
      });
      releaseSlots(botKey, botSnap.cliId);
      return;
    }

    const controller = new AbortController();
    const relayAbort = (): void => controller.abort();
    if (opts.cancelSignal?.aborted) relayAbort();
    else opts.cancelSignal?.addEventListener('abort', relayAbort, { once: true });
    nodeControllers.set(dispatchKey, controller);
    nodeAbortCleanups.set(dispatchKey, () => opts.cancelSignal?.removeEventListener('abort', relayAbort));

    const req: RunNodeRequest = {
      runId: dag.runId,
      attemptId,
      node,
      botSnapshot: effSnap,
      runDir,
      attemptDir,
      inputsPath,
      outputDir,
      env,
      timeoutMs: (node.timeoutSec ?? DEFAULT_NODE_TIMEOUT_SEC) * 1000,
      cancelSignal: controller.signal,
      // Worker terminal is ready mid-run → stamp nodeSessionReady so the
      // dashboard can attach to the LIVE terminal.  Sync appendEvent (no await
      // on the pool's fire-and-forget ready path — codex note).
      onSessionReady: (info) => {
        // Drop the write `token` — never persist it (codex security review):
        // the dashboard view is read-only and doesn't need write access.
        appendEvent(journalPath, {
          type: 'nodeSessionReady',
          nodeId: node.id,
          ...(instanceId ? { instanceId } : {}),
          attemptId,
          sessionInfo: { sessionId: info.sessionId, webPort: info.webPort },
          ptyLogPath: info.ptyLogPath,
        });
      },
    };

    const p = deps
      .runNode(req)
      .then(async (result) => {
        // Final verdict = process outcome AND manifest validation (codex
        // point 4 — NOT v0.2 final_output semantics).  Always validate the
        // manifest so a clean `status:'fail'` manifest yields a precise
        // root cause instead of an opaque process error (codex's advice).
        const verdict = await deps.validateManifest(result.manifestPath, outputDir);
        const manifestSaysOk = verdict.ok && verdict.manifest?.status === 'ok';

        if (result.status === 'ok' && manifestSaysOk) {
          // Cross-node revisit: the worker's result.json may request a jump back
          // to an ancestor (`status:"revisit", revisitTo, reason`).  Recognized
          // BEFORE success/resultSchema — a revisit is not a node success.
          const revisit = readRevisitRequest(verdict.manifest!, outputDir);
          if (!revisit.ok) {
            appendEvent(journalPath, {
              type: 'nodeBlocked', nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId,
              errorClass: 'resultInvalid', message: revisit.problems.join('; '),
            });
            return;
          }
          if (revisit.request) {
            if (!node.revisitTo?.includes(revisit.request.toNodeId)) {
              appendEvent(journalPath, {
                type: 'nodeBlocked', nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId,
                errorClass: 'resultInvalid',
                message: `result.json requests revisit to "${revisit.request.toNodeId}", not in node "${node.id}".revisitTo`,
              });
              return;
            }
            // Anti-infinite-loop: a revisit consumes per-pair + per-run budget.
            // Exhausted → block this node (recoverable) instead of superseding;
            // a human grants +1 (revisitBudgetGranted) then retries.
            const budget = revisitBudgetStatus(readJournal(journalPath), node.id, revisit.request.toNodeId);
            if (!budget.ok) {
              appendEvent(journalPath, {
                type: 'nodeBlocked', nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId,
                errorClass: 'resultInvalid', errorCode: 'REVISIT_BUDGET_EXHAUSTED', message: budget.detail,
                revisitTo: revisit.request.toNodeId,
              });
              return;
            }
            // goal-node dispatches always carry instanceId (首派 #001); the
            // fallback keeps the type total for the legacy/no-instance path.
            appendRevisitEvents(node.id, instanceId ?? node.id, attemptId, revisit.request, result.manifestPath);
            return;
          }
          // Opt-in structured-result contract: the manifest MUST list a
          // `result.json` entry (so it went through the manifest validator's
          // path/hash checks like every other product), and the file must
          // match the node's schema.  A violation BLOCKS (retryable), it does
          // not fail.
          if (node.resultSchema) {
            const entry = verdict.manifest!.files.find((f) => f.path === 'result.json');
            if (!entry) {
              appendEvent(journalPath, {
                type: 'nodeBlocked', nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId,
                errorClass: 'resultInvalid',
                message: 'node declares resultSchema but its manifest lists no "result.json" file',
              });
              return;
            }
            const res = validateResult(join(outputDir, entry.path), node.resultSchema);
            if (!res.ok) {
              appendEvent(journalPath, {
                type: 'nodeBlocked', nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId,
                errorClass: 'resultInvalid',
                message: (res.problems ?? ['result.json failed schema validation']).join('; '),
              });
              return;
            }
          }
          appendEvent(journalPath, {
            type: 'nodeSucceeded', nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId, manifestPath: result.manifestPath,
          });
          return;
        }

        let errorClass: V3ErrorClass;
        let message: string;
        let errorCode: string | undefined;
        let selfReportedFail = false;
        let retryable: boolean | undefined;
        if (!verdict.ok) {
          // Manifest missing / malformed.  If the process itself also failed,
          // the worker crash is the root cause; otherwise it's a bad manifest.
          errorClass = result.status === 'ok' ? 'manifestInvalid' : 'workerError';
          message = (verdict.problems ?? ['manifest missing or invalid']).join('; ');
        } else {
          // Manifest is structurally valid but declares failure (or the
          // process failed despite an ok manifest) — surface the node's own
          // error when present.  A self-reported fail is the agent's "I am
          // blocked, a human can fix this" channel (e.g. AUTH_REQUIRED with
          // retryable:true), so it feeds the blocked/failed split below.
          const m = verdict.manifest!;
          errorClass = 'workerError';
          if (m.status === 'fail' && m.error) {
            message = `${m.error.code}: ${m.error.message}`;
            errorCode = m.error.code;
            if (result.status === 'ok') {
              // Only an intact worker's self-report counts; a crashed process
              // with a leftover fail manifest is still an infrastructure error.
              selfReportedFail = true;
              retryable = m.error.retryable;
            }
          } else {
            message = 'runNode reported process failure';
          }
        }
        const kind = classifyTerminal(errorClass, { selfReportedFail, retryable });
        if (kind === 'blocked') {
          // Runtime human-ask: a self-reported block carrying ASK_HUMAN_ERROR_CODE
          // means the agent wrote a question to ask.json and stopped.  Surface
          // question + options on the blocked event so the daemon posts an ask
          // card; a malformed ask.json degrades to a plain retry card.
          const ask =
            errorCode === ASK_HUMAN_ERROR_CODE
              ? readGoalAsk(join(attemptDir, GOAL_ASK_FILE))
              : undefined;
          appendEvent(journalPath, {
            type: 'nodeBlocked',
            nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId, errorClass, errorCode, message,
            ...(ask ? { ask } : {}),
          });
        } else {
          appendEvent(journalPath, {
            type: 'nodeFailed',
            nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId, errorClass, errorCode, message,
          });
        }
      })
      .catch((err: unknown) => {
        appendEvent(journalPath, {
          type: 'nodeFailed', nodeId: node.id, ...(instanceId ? { instanceId } : {}), attemptId,
          errorClass: 'workerError', message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        // Key by dispatchKey (instance-scoped), NOT node.id: after a cross-node
        // revisit, D#001 and D#002 can be in-flight at once under the same
        // node.id. An unguarded inFlight.delete(node.id) here would let the stale
        // D#001's settle remove the LIVE D#002 entry → a healthy run trips the
        // "no progress possible" guard and crashes. Guard mirrors the controller
        // delete below.
        if (inFlight.get(dispatchKey) === p) inFlight.delete(dispatchKey);
        if (nodeControllers.get(dispatchKey) === controller) {
          nodeControllers.delete(dispatchKey);
          nodeAbortCleanups.get(dispatchKey)?.();
          nodeAbortCleanups.delete(dispatchKey);
        }
        releaseSlots(botKey, botSnap.cliId);
      });
    inFlight.set(dispatchKey, p);
  }

  /** A node's transitive downstream cone (the node itself + every node reachable
   *  via `depends` edges).  The set a revisit to `root` must refresh: `root`'s
   *  product changed, so every result derived from it is stale. */
  function affectedNodesFrom(root: string): string[] {
    const reachable = new Set<string>([root]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of dag.nodes) {
        if (reachable.has(n.id)) continue;
        if (n.depends.some((d) => reachable.has(d.from))) {
          reachable.add(n.id);
          changed = true;
        }
      }
    }
    return [...reachable];
  }

  /** A worker requested a cross-node revisit to ancestor `toNodeId`: journal the
   *  request, then supersede the CURRENT effective instance of the target AND its
   *  whole downstream cone (mark-only, files kept).  materialize then drops their
   *  effectiveInstanceId → decideNext re-dispatches fresh `#NNN` instances. */
  function appendRevisitEvents(
    nodeId: string,
    instanceId: string,
    attemptId: string,
    request: { toNodeId: string; reason?: string },
    sourceManifestPath: string,
  ): void {
    // Capture feedback paths BEFORE the supersede sweep, while the target's
    // current effective instance + its successful manifest are still resolvable.
    const events0 = readJournal(journalPath);
    const snap = materialize(events0);
    const targetEff = snap.nodes.get(request.toNodeId)?.effectiveInstanceId;
    const targetSucc = targetEff
      ? [...events0].reverse().find((e): e is StoredEvent & { type: 'nodeSucceeded' } =>
          e.type === 'nodeSucceeded' && (e.instanceId ?? e.nodeId) === targetEff)
      : undefined;
    // Persist the reason as a file the target's fresh instance can Read.  The
    // journal stores runDir-RELATIVE paths (run-dir portability + no abs-path
    // leakage into projections/cards); buildInputs resolves to absolute on read.
    let reasonPathRel: string | undefined;
    if (request.reason) {
      const dir = join(runDir, 'revisits');
      mkdirSync(dir, { recursive: true });
      const abs = join(dir, `${instanceId.replace(/[#/]/g, '-')}-reason.md`);
      writeFileSync(abs, `# Revisit reason (from ${nodeId} / ${instanceId})\n\n${request.reason}\n`);
      reasonPathRel = relative(runDir, abs);
    }
    appendEvent(journalPath, {
      type: 'nodeRevisitRequested',
      nodeId, instanceId, attemptId, toNodeId: request.toNodeId,
      ...(request.reason ? { reason: request.reason } : {}),
      ...(reasonPathRel ? { reasonPath: reasonPathRel } : {}),
      sourceManifestPath: relative(runDir, sourceManifestPath),
      ...(targetSucc ? { targetPreviousManifestPath: relative(runDir, targetSucc.manifestPath) } : {}),
    });
    for (const affectedNodeId of affectedNodesFrom(request.toNodeId)) {
      const eff = snap.nodes.get(affectedNodeId)?.effectiveInstanceId;
      if (!eff) continue; // never-dispatched downstream node has nothing to supersede
      appendEvent(journalPath, {
        type: 'nodeInstanceSuperseded',
        nodeId: affectedNodeId, instanceId: eff, byNodeId: request.toNodeId, reason: 'refresh',
      });
    }
  }

  function startGate(node: V3Node, instanceId?: string): void {
    // Instance-level waitId so a revisit's fresh gate (`A#002-gate`) gets its own
    // wait file + card nonce, never overwriting the superseded `A#001-gate`
    // (stale-card protection).  Legacy/no-instance → `<nodeId>-gate`.
    const waitId = `${instanceId ?? node.id}-gate`;
    const gate = normalizeGateWaitInput(node.humanGate!);
    appendEvent(journalPath, { type: 'gateDispatched', nodeId: node.id, ...(instanceId ? { instanceId } : {}), waitId });

    if (gateMode === 'suspend') {
      writePendingWait(runDir, { waitId, nodeId: node.id, ...(instanceId ? { instanceId } : {}), ...gate });
      return;
    }

    if (!deps.resolveGate) {
      throw new Error(
        `v3 runtime: node "${node.id}" has a humanGate but no resolveGate handler was injected`,
      );
    }
    // Instance-scoped, like the work path (and the waitId above): a cross-node
    // revisit can leave D#001's gate in flight while D#002's gate is re-dispatched
    // under the same node.id. Keying by node.id + an unguarded delete would let
    // D#001's gate settle remove the LIVE D#002 entry → "no progress possible" crash.
    const key = `${instanceId ?? node.id}::gate`;
    const p = deps
      .resolveGate({ nodeId: node.id, prompt: gate.prompt, waitId, runDir })
      .then(({ resolution, by, selected }) => {
        // Carry instanceId (mirror gateDispatched + the daemon suspend path): a
        // gateResolved WITHOUT it falls into state.ts's legacy per-node branch,
        // so a late D#001 gate resolve after a revisit re-dispatched D#002 would
        // overwrite node D's view → pollute the live D#002 instance.
        appendEvent(journalPath, { type: 'gateResolved', nodeId: node.id, ...(instanceId ? { instanceId } : {}), waitId, resolution, by, selected });
      })
      .catch(() => {
        // A gate that errors out is treated as rejected (fail-fast); the
        // run-failure root cause is the rejection, recorded on the journal.
        appendEvent(journalPath, { type: 'gateResolved', nodeId: node.id, ...(instanceId ? { instanceId } : {}), waitId, resolution: 'rejected', by: 'system' });
      })
      .finally(() => {
        if (inFlight.get(key) === p) inFlight.delete(key);
      });
    inFlight.set(key, p);
  }

  /** Synthesize the effective node a body instance runs as: the body
   *  definition re-id'd into the iteration namespace, with internal deps /
   *  inputs mapped to instance ids and the bot inherited from the loop. */
  function instanceNodeFor(ref: V3LoopRef): V3Node {
    const loopNode = nodesById.get(ref.loopId) as V3LoopNode;
    const bodyDef = loopNode.body.nodes.find((b) => b.id === ref.bodyNodeId)!;
    return {
      ...bodyDef,
      id: loopInstanceId(ref.loopId, ref.iteration, ref.bodyNodeId),
      bot: bodyDef.bot ?? loopNode.bot,
      depends: bodyDef.depends.map((d) => ({ from: loopInstanceId(ref.loopId, ref.iteration, d.from) })),
      inputs: bodyDef.inputs.map((r) => ({
        from: loopInstanceId(ref.loopId, ref.iteration, r.from),
        ...(r.select ? { select: r.select } : {}), // P3: 实例化时保留 selector
      })),
    };
  }

  /** Translate one loop-control action into its single journal append. */
  function applyLoopControl(a: Extract<V3Action, { loopId: string }>): void {
    if (a.kind === 'startLoop') {
      appendEvent(journalPath, { type: 'loopStarted', loopId: a.loopId });
      return;
    }
    if (a.kind === 'startLoopIteration') {
      appendEvent(journalPath, { type: 'loopIterationStarted', loopId: a.loopId, iteration: a.iteration });
      return;
    }
    const loopNode = nodesById.get(a.loopId) as V3LoopNode;
    if (a.kind === 'completeLoop') {
      // Seal the loop with a nodeSucceeded on the LOOP id carrying the output
      // projection's manifest — downstream deps gating + buildInputs then
      // treat the loop exactly like any done node.
      const events = readJournal(journalPath);
      const outInstId = loopInstanceId(a.loopId, a.iteration, loopNode.output.from);
      const succ = [...events]
        .reverse()
        .find((e): e is StoredEvent & { type: 'nodeSucceeded' } =>
          e.type === 'nodeSucceeded' && e.nodeId === outInstId);
      if (!succ) {
        // Engine anomaly — the decision said exit but the output instance has
        // no success record.  Fail loudly rather than fabricate a product.
        appendEvent(journalPath, {
          type: 'nodeFailed', nodeId: a.loopId, attemptId: `${a.loopId}/iterations/${String(a.iteration).padStart(3, '0')}`,
          errorClass: 'workerError',
          message: `loop "${a.loopId}" decided exit but output node "${outInstId}" has no nodeSucceeded`,
        });
        return;
      }
      appendEvent(journalPath, {
        type: 'nodeSucceeded', nodeId: a.loopId, attemptId: succ.attemptId, manifestPath: succ.manifestPath,
      });
      return;
    }
    // evaluateLoopIteration: read the exit instance's structured result and
    // record the decision.  Every input here was already validated when the
    // exit node succeeded (resultSchema is mandatory on the exit node), so an
    // unreadable result is an engine anomaly → 'exhausted' (blocks for a
    // human) rather than a silent extra round.
    const events = readJournal(journalPath);
    const exitInstId = loopInstanceId(a.loopId, a.iteration, loopNode.exit.node);
    const succ = [...events]
      .reverse()
      .find((e): e is StoredEvent & { type: 'nodeSucceeded' } =>
        e.type === 'nodeSucceeded' && e.nodeId === exitInstId);
    const key = loopNode.exit.when.path.slice('result.'.length);
    let matched = false;
    let observed = `${loopNode.exit.when.path}=<unreadable>`;
    if (succ) {
      try {
        const manifest = JSON.parse(readFileSync(succ.manifestPath, 'utf-8')) as Manifest;
        const entry = manifest.files.find((f) => f.path === 'result.json');
        if (entry) {
          const result = JSON.parse(
            readFileSync(join(dirname(succ.manifestPath), 'work', entry.path), 'utf-8'),
          ) as Record<string, unknown>;
          observed = `${loopNode.exit.when.path}=${JSON.stringify(result[key])}`;
          matched = matchLoopExitWhen(loopNode.exit.when, result[key]);
        }
      } catch {
        // fall through with matched=false, observed=<unreadable>
      }
    }
    const granted = events.filter(
      (e) => e.type === 'loopIterationGranted' && e.loopId === a.loopId,
    ).length;
    const effectiveMax = loopNode.maxIterations + granted;
    const anomalous = observed.endsWith('<unreadable>');
    const decision = matched ? 'exit' : !anomalous && a.iteration < effectiveMax ? 'continue' : 'exhausted';
    appendEvent(journalPath, {
      type: 'loopIterationDecision', loopId: a.loopId, iteration: a.iteration, decision,
      detail: `${observed} (iteration ${a.iteration}/${effectiveMax})`,
    });
  }

  /** Resolve one conditional edge by reading the source's latest successful
   *  result.json exactly once, then journaling the boolean verdict. */
  function applyResolveEdge(
    a: Extract<V3Action, { kind: 'resolveEdge' }>,
    events: StoredEvent[],
  ): void {
    // Scope the verdict to the CURRENT effective instances of source/target so a
    // revisit's `A#001->B#001` verdict never bleeds onto `A#002->B#002`
    // (constraint 1).  Legacy/no-instance falls back to the bare nodeId.
    const snap = materialize(events);
    const fromInstanceId = snap.nodes.get(a.from)?.effectiveInstanceId;
    const toInstanceId = snap.nodes.get(a.to)?.effectiveInstanceId;
    const fromKey = fromInstanceId ?? a.from;
    const instPair = { ...(fromInstanceId ? { fromInstanceId } : {}), ...(toInstanceId ? { toInstanceId } : {}) };
    const target = nodesById.get(a.to);
    const dep = target?.depends.find((d) => d.from === a.from);
    if (!target || !dep?.when) {
      appendEvent(journalPath, {
        type: 'edgeResolved',
        from: a.from,
        to: a.to,
        ...instPair,
        sourceAttemptId: latestAttemptIdFor(events, fromKey) ?? `${fromKey}/attempts/unknown`,
        active: false,
        detail: 'edge predicate missing at resolution time',
      });
      return;
    }

    const succ = [...events]
      .reverse()
      .find((e): e is StoredEvent & { type: 'nodeSucceeded' } =>
        e.type === 'nodeSucceeded' && (e.instanceId ?? e.nodeId) === fromKey);
    const sourceAttemptId = succ?.attemptId ?? `${fromKey}/attempts/unknown`;
    const key = dep.when.path.slice('result.'.length);
    let active = false;
    let detail = `${dep.when.path}=<unreadable>`;
    if (succ) {
      try {
        const manifest = JSON.parse(readFileSync(succ.manifestPath, 'utf-8')) as Manifest;
        const entry = manifest.files.find((f) => f.path === 'result.json');
        if (entry) {
          const result = JSON.parse(
            readFileSync(join(dirname(succ.manifestPath), 'work', entry.path), 'utf-8'),
          ) as Record<string, unknown>;
          detail = `${dep.when.path}=${JSON.stringify(result[key])}`;
          active = matchLoopExitWhen(dep.when, result[key]);
        }
      } catch {
        // The source's resultSchema should make this unreachable; keep the run
        // progressing deterministically and surface the anomaly in detail.
      }
    }
    appendEvent(journalPath, {
      type: 'edgeResolved',
      from: a.from,
      to: a.to,
      ...instPair,
      sourceAttemptId,
      active,
      detail,
    });
  }

  function applyCancelNode(a: Extract<V3Action, { kind: 'cancelNode' }>): boolean {
    const events = readJournal(journalPath);
    const snap = materialize(events);
    const status = snap.nodes.get(a.nodeId)?.status ?? 'pending';
    if (status !== 'pending' && status !== 'gateWaiting' && status !== 'running') return false;

    // Stamp the cancelled INSTANCE so a later instance (`A#002` after a revisit)
    // settles freely — the cancel suppression in materialize keys by instance.
    const instanceId = snap.nodes.get(a.nodeId)?.effectiveInstanceId;
    const attemptId = latestAttemptIdFor(events, instanceId ?? a.nodeId);
    appendEvent(journalPath, {
      type: 'nodeCancelled',
      nodeId: a.nodeId,
      ...(instanceId ? { instanceId } : {}),
      attemptId,
      reason: 'earlyReleaseLoser',
      byNodeId: a.byNodeId,
      detail: a.detail,
    });

    nodeControllers.get(instanceId ?? a.nodeId)?.abort();
    // Match startGate's instance-scoped gate key so the right instance's gate
    // in-flight entry is cleared (not a stale node.id-keyed one that never existed).
    const gateKey = `${instanceId ?? a.nodeId}::gate`;
    if (inFlight.has(gateKey)) inFlight.delete(gateKey);
    return true;
  }

  function pendingGateWaits(state: Map<string, { status: string; effectiveInstanceId?: string }>): V3PendingGate[] {
    const waits: V3PendingGate[] = [];
    for (const node of dag.nodes) {
      if (state.get(node.id)?.status !== 'gateWaiting') continue;
      const prompt = node.humanGate?.prompt;
      if (!prompt) continue;
      const gate = normalizeGateWaitInput(node.humanGate!);
      // Instance-level waitId mirrors startGate (stale-card protection).
      const instanceId = state.get(node.id)?.effectiveInstanceId;
      waits.push({ nodeId: node.id, waitId: `${instanceId ?? node.id}-gate`, ...gate });
    }
    return waits;
  }

  function releaseSlots(botKey: string, cliId: string): void {
    botInFlight.set(botKey, Math.max(0, (botInFlight.get(botKey) ?? 1) - 1));
    cliInFlight.set(cliId, Math.max(0, (cliInFlight.get(cliId) ?? 1) - 1));
  }

  /** Resolve a node's upstream products into its `GoalInputs` (absolute paths).
   *  Reads each upstream's already-validated manifest from the latest
   *  `nodeSucceeded` event; the manifest's relative `path` is joined onto the
   *  upstream outputDir (`<manifestDir>/work`) to produce an absolute path the
   *  downstream agent can Read directly.
   *
   *  Loop body instances additionally receive (a) the LOOP's outer inputs —
   *  every body node may read what the loop consumes — and (b) from iteration
   *  2 on, the previous iteration's `feedback` products, labeled
   *  `previous.<bodyId>` so the agent can tell rework context from fresh
   *  upstream input.
   *
   *  `omitted` (edge-activation design §6): declared inputs the engine layer
   *  determined must NOT be injected (edge inactive / source skipped) — they
   *  are excluded from resolution AND surfaced to the agent so the absence
   *  reads as by-design.  Empty/absent → exactly today's behavior. */
  function buildInputs(
    node: V3Node,
    events: StoredEvent[],
    attemptId: string,
    loopRef?: V3LoopRef,
    omitted?: GoalInputs['omitted'],
  ): GoalInputs {
    const inputs: GoalInputs['inputs'] = [];
    const omittedFrom = new Set((omitted ?? []).map((o) => o.from));
    // Resolve upstream products by the source's CURRENT effective instance, NOT
    // by nodeId-latest (stale-instance blocker): after a revisit, a stale `A#001` worker
    // can settle LATE; nodeId-latest would then hand `A#001`'s old product to
    // `B#002`.  Keying by effectiveInstanceId pins it to `A#002`.
    const snap = materialize(events);

    // Runtime human-ask answer: when THIS dispatch is the retry a human-ask was
    // answered into, inject the persisted answer as `{from:'human', name:'answer'}`
    // so the agent reads the decision and resumes instead of re-asking.
    const answeredRetry = [...events].reverse().find(
      (e): e is StoredEvent & { type: 'nodeRetryRequested' } =>
        e.type === 'nodeRetryRequested' && e.nodeId === node.id &&
        e.nextAttemptId === attemptId && !!e.answer,
    );
    if (answeredRetry?.answer) {
      inputs.push({
        from: 'human',
        name: 'answer',
        path: answeredRetry.answer.path,
        kind: 'json',
        preview: answeredRetry.answer.preview,
      });
    }

    // Latest success for a dispatch `key` (an effective instance `A#002`, a loop
    // body expansion, or a legacy nodeId), matched by `(instanceId ?? nodeId)`.
    const latestSuccess = (key: string) =>
      [...events]
        .reverse()
        .find((e): e is StoredEvent & { type: 'nodeSucceeded' } =>
          e.type === 'nodeSucceeded' && (e.instanceId ?? e.nodeId) === key);

    const pushFrom = (
      label: string,
      nodeId: string,
      filter?: (f: Manifest['files'][number]) => boolean,
    ): void => {
      // Pin to the source's current effective instance (falls back to nodeId for
      // loop bodies / legacy with no instance).
      const key = snap.nodes.get(nodeId)?.effectiveInstanceId ?? nodeId;
      const succ = latestSuccess(key);
      if (!succ) return; // deps are gated upstream — defensive skip
      const upstreamOutputDir = join(dirname(succ.manifestPath), 'work');
      const manifest = JSON.parse(readFileSync(succ.manifestPath, 'utf-8')) as Manifest;
      for (const f of manifest.files) {
        if (filter && !filter(f)) continue;
        inputs.push({
          from: label,
          ...(succ.instanceId ? { instanceId: succ.instanceId } : {}),
          name: f.name,
          path: join(upstreamOutputDir, f.path),
          kind: f.kind,
          preview: f.preview,
        });
      }
    };

    // Push every file of a manifest at a known (absolute) path — used for
    // revisit feedback where the manifest is referenced directly off the
    // nodeRevisitRequested event (requester / target-prior), not via a
    // nodeSucceeded lookup.  Names are prefixed so the agent can tell the
    // feedback pieces apart (`revisit/source:…`, `revisit/previous:…`).
    // Journal stores runDir-relative revisit paths; resolve to absolute for read.
    const resolveRunPath = (p: string): string => (isAbsolute(p) ? p : join(runDir, p));
    const pushManifestByPath = (label: string, manifestPath: string | undefined, namePrefix: string): void => {
      if (!manifestPath) return;
      const abs = resolveRunPath(manifestPath);
      if (!existsSync(abs)) return;
      let manifest: Manifest;
      try {
        manifest = JSON.parse(readFileSync(abs, 'utf-8')) as Manifest;
      } catch {
        return;
      }
      const outDir = join(dirname(abs), 'work');
      for (const f of manifest.files) {
        inputs.push({
          from: label,
          name: `${namePrefix}:${f.name}`,
          path: join(outDir, f.path),
          kind: f.kind,
          preview: f.preview,
        });
      }
    };

    // P3 selector misses collected during resolution — merged into `omitted`
    // so the agent reads the gap as a known contract issue, not silence.
    const selectorMisses: Array<{ from: string; reason: 'selectorMiss' }> = [];
    const pushRef = (ref: V3InputRef): void => {
      const filter = ref.select
        ? (f: Manifest['files'][number]) =>
            ref.select!.name !== undefined ? f.name === ref.select!.name : f.path === ref.select!.path
        : undefined;
      const before = inputs.length;
      pushFrom(ref.from, ref.from, filter);
      if (ref.select && inputs.length === before) {
        selectorMisses.push({ from: ref.from, reason: 'selectorMiss' });
      }
    };

    for (const ref of node.inputs) {
      if (omittedFrom.has(ref.from)) continue; // branch not taken — surfaced via `omitted`
      pushRef(ref);
    }

    // Cross-node revisit feedback: when THIS node is a revisit target, its fresh
    // instance is sent back blind unless we hand it (1) WHY it was sent back,
    // (2) the requester's output (where it went wrong), (3) its OWN prior output
    // (so it edits rather than rewrites).  All as `from:"revisit"` inputs; the
    // goal.txt instructs the agent to read them first.  A plain first run / a
    // cone node that wasn't the target has no such event → nothing injected.
    const revisitReq = [...events].reverse().find(
      (e): e is StoredEvent & { type: 'nodeRevisitRequested' } =>
        e.type === 'nodeRevisitRequested' && e.toNodeId === node.id);
    if (revisitReq) {
      if (revisitReq.reasonPath) {
        inputs.push({ from: 'revisit', name: 'reason', path: resolveRunPath(revisitReq.reasonPath), kind: 'markdown', preview: revisitReq.reason });
      }
      pushManifestByPath('revisit', revisitReq.sourceManifestPath, 'source');
      pushManifestByPath('revisit', revisitReq.targetPreviousManifestPath, 'previous');
    }

    if (loopRef) {
      const loopNode = nodesById.get(loopRef.loopId) as V3LoopNode;
      // (a) The loop's outer inputs (e.g. `prepare`'s products) flow into
      // every body instance of every iteration.
      for (const ref of loopNode.inputs) pushRef(ref);
      // (b) Declared previous-iteration feedback.
      if (loopRef.iteration > 1) {
        for (const fb of loopNode.feedback) {
          const dot = fb.lastIndexOf('.');
          const bodyId = fb.slice(0, dot);
          const kind = fb.slice(dot + 1);
          const prevInstId = loopInstanceId(loopRef.loopId, loopRef.iteration - 1, bodyId);
          const label = `previous.${bodyId}`;
          if (kind === 'manifest') {
            const succ = latestSuccess(prevInstId);
            if (succ) {
              inputs.push({ from: label, name: 'manifest', path: succ.manifestPath, kind: 'json' });
            }
          } else {
            // 'result' → just result.json; 'files' → the whole product set.
            pushFrom(label, prevInstId, kind === 'result' ? (f) => f.path === 'result.json' : undefined);
          }
        }
      }
    }
    // Dedupe by (label, path) — `feedback: ["test.result", "test.files"]`
    // legitimately overlaps on result.json; one entry is enough.
    const seen = new Set<string>();
    const allOmitted = [...(omitted ?? []), ...selectorMisses];
    return {
      inputs: inputs.filter((i) => {
        const key = JSON.stringify([i.from, i.path]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      ...(allOmitted.length > 0 ? { omitted: allOmitted } : {}),
    };
  }
}
