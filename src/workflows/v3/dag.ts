/**
 * v3 DAG definition — schema, loader, validator, topological order.
 *
 * The v3 runtime (LLM-driven workflow) loads a hand-written `dag.json`,
 * validates it, and walks it in topological order with deps gating.  This
 * module is the *schema half* of the engine: pure data + validation, no IO
 * side effects beyond reading the file in `loadDag`.
 *
 * Deliberately standalone from v0.2's `definition.ts` — v3 nodes are a much
 * smaller surface (goal / host, no loop / decision / fanout) and coupling the
 * two schemas would drag v0.2's complexity into the new engine.  See
 * `docs/design/2026-06-01-v3-mvp-engine-split.md` §3 for the authored shape.
 */

import { readFileSync } from 'node:fs';

// ─── Schema ──────────────────────────────────────────────────────────────

/**
 * `goal` — an LLM node driven by the `botmux-goal` skill (single goal, one
 *   ephemeral worker).  `host` — a deterministic side-effect node (feishu-send
 *   / base write / schedule) that does NOT route through an LLM.  MVP runs
 *   `goal` nodes end to end; `host` is reserved in the schema so the runtime
 *   can grow into it without a breaking change (it is rejected at validate
 *   time until the executor lands — see `validateDag`).
 * `loop` — a composite node wrapping a bounded sub-pipeline (structured rework:
 *   `code -> test` until the test's structured result passes).  The outer DAG
 *   stays acyclic — rework NEVER appears as a back-edge; it only exists inside
 *   an explicit loop body.  See docs/design/2026-06-06-v3-structured-loop-design.md.
 */
export type V3NodeType = 'goal' | 'host' | 'loop';

export const NODE_KINDS: readonly V3NodeType[] = ['goal', 'host', 'loop'];

/** Default per-node wall-clock budget when a node omits `timeoutSec`.
 *  Generous on purpose: completion is detected by the manifest watcher
 *  (seconds after the agent finishes), so the timeout only fires for hung
 *  nodes — a long default costs nothing on the happy path.  The architect is
 *  prompted to set per-node `timeoutSec` explicitly for long tasks. */
export const DEFAULT_NODE_TIMEOUT_SEC = 1800;

/** Hard ceiling for per-node `timeoutSec` (4h) — rejects runaway budgets the
 *  architect might hallucinate while still allowing genuinely long tasks. */
export const MAX_NODE_TIMEOUT_SEC = 14400;

/** A humanGate frozen at authoring time — the runtime never lets a node
 *  add / skip a gate at runtime (design Q10). */
export interface V3HumanGate {
  /** Approval-card body shown to the human reviewer. */
  prompt: string;
  /** Button option keys shown on the approval card. */
  options?: string[];
  /** Selecting any of these options maps to `resolution:'approved'`. */
  approveOptions?: string[];
  /** Empty = any operator allowed by the outer daemon permission gate. */
  approvers?: string[];
}

export const DEFAULT_HUMAN_GATE_OPTIONS: readonly string[] = ['approve', 'reject'];
export const MAX_HUMAN_GATE_OPTIONS = 8;
export const MAX_HUMAN_GATE_OPTION_LENGTH = 32;

/**
 * Declares that this node consumes an upstream node's products.  MVP pulls the
 * upstream node's *whole* manifest (all files) into this node's `inputs.json`;
 * a per-file selector is deferred (design §2.3).  Invariant: `from` MUST also
 * appear in the node's `depends` — you can only read outputs of a node you
 * wait for.
 */
export interface V3InputRef {
  /** Upstream nodeId whose manifest files become this node's inputs. */
  from: string;
  /** P3 per-file selector: pull ONE named product instead of the whole
   *  manifest.  Exactly one of `name` (manifest logical name) / `path`
   *  (manifest relative path) when present.  A selector that matches nothing
   *  at dispatch time is surfaced to the agent via `GoalInputs.omitted`
   *  (reason 'selectorMiss') — absence reads as a contract gap, not silence. */
  select?: { name?: string; path?: string };
}

/**
 * A normalized incoming edge (edge-activation design 2026-06-06 §1.1).
 * Authored as either a plain string (`"build"`) or an object
 * (`{ "from": "review", "when": {...} }`); validateDag normalizes both to this
 * shape.  No `when` = unconditional (source `done` ⇒ active).  With `when`,
 * the edge's activation is decided ONCE by the runtime reading the source's
 * `result.json` and journaled as `edgeResolved` — never re-read afterwards.
 *
 * `from` values are deduped per node: P0 supports at most ONE edge per
 * (from, to) pair, so `(from, to)` is a stable idempotency key for
 * `edgeResolved`.  Express OR over outcomes inside the source's structured
 * result instead of authoring parallel conditional edges.
 */
export interface V3DependRef {
  from: string;
  /** Predicate over the SOURCE node's structured result — same shape and
   *  validation as a loop exit predicate (`result.<key>` + exactly one
   *  comparison operator, declared + required + type-compatible). */
  when?: V3EdgeWhen;
}

/** Edge predicates reuse the loop-exit predicate shape verbatim. */
export type V3EdgeWhen = V3LoopExitWhen;

/**
 * Join semantics over a node's incoming edges (design §1.2).  Evaluated ONCE,
 * only after every incoming edge has settled (source done/skipped and any
 * predicate journaled) — no early release, no loser cancellation in P0.
 */
export type V3TriggerRule = 'all_success' | 'one_success' | { quorum: number };

/**
 * Per-node capability override (P2, edge-activation follow-up).  Merged onto
 * the bot's frozen `BotSnapshot` at dispatch time — the node can RESTRICT or
 * redirect, never escalate:
 *   - `model` picks a different model for THIS node (cost control: cheap
 *     models for research nodes, strong models for code nodes);
 *   - `permissionMode:'restricted'` forces the CLI's permission bypass OFF for
 *     this node.  There is deliberately NO 'bypass' value — a node on a
 *     restricted bot cannot grant itself what the bot does not have (the
 *     no-escalation red line is structural, not a runtime check);
 *   - `systemPromptAppend` adds node-specific instructions to the goal file.
 * `toolsSubset` is deferred — it needs a per-CLI capability matrix across the
 * daemon init/worker/adapter chain (P2b).
 */
export interface V3CapabilityOverride {
  model?: string;
  permissionMode?: 'inherit' | 'restricted';
  systemPromptAppend?: string;
}

export const MAX_OVERRIDE_MODEL_LENGTH = 64;
export const MAX_OVERRIDE_SYSTEM_PROMPT_APPEND = 8000;

/**
 * Opt-in structured-output contract — a deliberately TINY subset of
 * JSON-Schema (flat object, primitive-typed properties, optional required
 * list).  Hand-validated (no deps, repo style); anything outside the subset
 * is rejected at validateDag time so the architect can never author a schema
 * the runtime's validator cannot execute.
 *
 * NOT supported (first slice): nested schemas, array item types, patterns.
 * `type:'array'|'object'` properties validate the TOP-LEVEL type only.
 * `enum` is supported on STRING properties only (edge-activation design §1.3)
 * — it is the decision-vocabulary anchor for edge predicates: validateDag
 * cross-checks `equals`/`notEquals` operands against the source field's enum,
 * so a typo'd decision value fails at validate time, not at runtime.
 */
export interface V3ResultSchema {
  type: 'object';
  properties: Record<string, { type: V3ResultFieldType; enum?: string[] }>;
  required?: string[];
}

export type V3ResultFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

const RESULT_FIELD_TYPES: readonly V3ResultFieldType[] = ['string', 'number', 'boolean', 'array', 'object'];

/** Caps on the resultSchema subset (anti-runaway: a giant schema bloats the
 *  goal prompt and the validator).  Checked at validateDag time. */
export const RESULT_SCHEMA_MAX_PROPERTIES = 32;
export const RESULT_SCHEMA_MAX_BYTES = 4096;

/** Caps on a string property's `enum` (anti prompt-bloat; counted inside the
 *  4KB schema budget like everything else). */
export const RESULT_ENUM_MAX_VALUES = 16;
export const RESULT_ENUM_MAX_VALUE_LENGTH = 64;

/** Backstop ceiling for `maxIterations` — like the timeout cap, it rejects a
 *  runaway budget the architect might hallucinate; a human can still grant
 *  extra iterations one at a time once the loop blocks. */
export const MAX_LOOP_ITERATIONS = 20;

/** Cross-node revisit budgets (anti-infinite-loop).  Two tiers:
 *  - PER-PAIR (source→target): how many times one node may revisit one ancestor
 *    before the run blocks — default 1 (a node sends each ancestor back once;
 *    expected multi-round rework belongs in a structured loop, not ad-hoc
 *    revisit).  Pinpoints which edge is ping-ponging.
 *  - PER-RUN: total revisits across the whole run — a generous backstop so many
 *    distinct pairs (or many nodes revisiting) can't run away.
 *  Exhaustion blocks the run; a human grants +1 (revisitBudgetGranted). */
export const DEFAULT_REVISIT_BUDGET_PER_PAIR = 1;
export const DEFAULT_REVISIT_BUDGET_PER_RUN = 8;

// ─── Loop schema ─────────────────────────────────────────────────────────

/**
 * Exit predicate over the exit node's structured result.  Deliberately tiny:
 * `path` is fixed to `result.<key>` (the resultSchema subset is flat, so there
 * is nothing deeper to address) and exactly ONE comparison operator must be
 * set.  validateDag cross-checks the key against the exit node's resultSchema
 * (declared AND required, operator type-compatible), so "field missing at
 * runtime" is a validate-time impossibility, not a runtime branch.
 *
 * No `continue.when` counterpart — when the predicate does not match, the loop
 * implicitly continues (until maxIterations).  Two independent predicates
 * would create undefined both-match / neither-match states.
 */
export interface V3LoopExitWhen {
  /** `result.<key>` — a key of the exit node's resultSchema. */
  path: string;
  equals?: string | number | boolean;
  notEquals?: string | number | boolean;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

const LOOP_WHEN_OPERATORS = ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte'] as const;

export interface V3LoopExit {
  /** Body nodeId whose structured result decides the loop's exit. */
  node: string;
  when: V3LoopExitWhen;
}

/** Which body node's final-iteration manifest is the loop's outward product
 *  (what downstream `inputs: [{from: <loopId>}]` reads).  Defaults to the
 *  exit node, but a repair loop usually exports the WORKER's product (`code`),
 *  not the gate's (`test`). */
export interface V3LoopOutput {
  from: string;
}

export interface V3Node {
  /** Unique within the DAG; also used as a runDir path segment, so it is
   *  constrained to `[A-Za-z0-9._-]`. */
  id: string;
  type: V3NodeType;
  /** Required + non-empty for `goal` nodes; the single-sentence objective. */
  goal?: string;
  /** Which bot/CLI runs this node.  MVP dogfoods a single CLI, but the field
   *  is per-node so a mixed-backend DAG is a non-breaking extension. */
  bot?: string;
  /** Normalized incoming edges.  Authored as `string | {from, when?}`;
   *  validateDag normalizes to `V3DependRef[]` (edge-activation design §1.1).
   *  Unconditional edges gate on source `done`; `when` edges additionally
   *  gate on the journaled `edgeResolved` verdict. */
  depends: V3DependRef[];
  /** Join semantics over incoming edges; defaults to 'all_success' (exactly
   *  today's behavior).  Only meaningful on nodes with ≥1 incoming edge. */
  triggerRule?: V3TriggerRule;
  /** Per-node capability override (restrict/redirect only — see
   *  V3CapabilityOverride).  Goal nodes (incl. loop body nodes) only; a loop
   *  composite never spawns a worker, so it rejects this field. */
  override?: V3CapabilityOverride;
  /** Upstream products to thread in as inputs (every `from` ⊆ `depends`). */
  inputs: V3InputRef[];
  /** Wall-clock budget in seconds; falls back to DEFAULT_NODE_TIMEOUT_SEC. */
  timeoutSec?: number;
  /** Optional human approval gate, evaluated *before* the node's work runs. */
  humanGate?: V3HumanGate | null;
  /** Opt-in structured-output contract: when set, the node must write a
   *  `result.json` (listed in its manifest files) matching this schema; a
   *  violation blocks (not fails) the node.  Absent → zero behavior change. */
  resultSchema?: V3ResultSchema;
  /** Definition-level revisit exits (cross-node回溯).  When this node's
   *  `result.json` returns `{ "status": "revisit", "revisitTo": "<A>" }`, the
   *  runtime may revisit ancestor node `<A>` — but ONLY if `<A>` is listed
   *  here.  Default (absent / empty) = the node cannot revisit anything.
   *  validateDag enforces every entry is an ANCESTOR (transitive `depends`),
   *  so a revisit can never create a forward jump or a cycle in the run. */
  revisitTo?: string[];

  // ── loop-only fields (type === 'loop'; see V3LoopNode) ──
  /** Hard iteration bound; the loop blocks (recoverable, human can grant +1)
   *  when it is exhausted without the exit predicate matching. */
  maxIterations?: number;
  /** The per-iteration sub-pipeline.  Goal nodes only — no nesting, no
   *  humanGate inside a body (both first-cut restrictions). */
  body?: { nodes: V3Node[] };
  /** Structured exit condition; not matching ⇒ implicit continue. */
  exit?: V3LoopExit;
  /** Previous-iteration products threaded into the NEXT iteration's inputs.
   *  Entries are `<bodyId>.result` | `<bodyId>.files` | `<bodyId>.manifest`. */
  feedback?: string[];
  /** Outward product projection (defaults to exit.node). */
  output?: V3LoopOutput;
  /** Only supported value (and the default): 'blocked'. */
  onExhausted?: 'blocked';
  /** Only supported value (and the default): 'fresh' — every iteration's every
   *  body node runs a fresh ephemeral worker.  `resumeWithinLoop` is deferred. */
  sessionPolicy?: 'fresh';
}

/** A `V3Node` narrowed to a goal node — `goal` is guaranteed present.  This is
 *  what crosses into `runNode` (the pool only ever runs goal nodes in MVP). */
export interface V3GoalNode extends V3Node {
  type: 'goal';
  goal: string;
}

/** Narrowing guard: a validated goal node always has a non-empty `goal`. */
export function isGoalNode(node: V3Node): node is V3GoalNode {
  return node.type === 'goal' && typeof node.goal === 'string' && node.goal.length > 0;
}

/** A `V3Node` narrowed to a loop node — validateDag guarantees every loop
 *  field is present and normalized (output defaulted to exit.node, feedback
 *  defaulted to `[]`). */
export interface V3LoopNode extends V3Node {
  type: 'loop';
  maxIterations: number;
  body: { nodes: V3Node[] };
  exit: V3LoopExit;
  feedback: string[];
  output: V3LoopOutput;
}

/** Narrowing guard for validated loop nodes. */
export function isLoopNode(node: V3Node): node is V3LoopNode {
  return node.type === 'loop';
}

/**
 * The expanded id a body node instance runs under in iteration N:
 * `repairLoop.i001.code`.  Path-safe by construction (loopId/bodyId are
 * SEGMENT_RE, `.` is in the charset) and free of the `:` the blocked-card
 * nonce uses as a separator.  OPAQUE — never parse this string back; journal
 * events carry a structured `loop: {loopId, iteration, bodyNodeId}` instead.
 */
export function loopInstanceId(loopId: string, iteration: number, bodyNodeId: string): string {
  return `${loopId}.i${String(iteration).padStart(3, '0')}.${bodyNodeId}`;
}

export interface V3Dag {
  /** Stable id for this run; used as the runDir name, so path-segment safe. */
  runId: string;
  nodes: V3Node[];
}

// ─── Validation ─────────────────────────────────────────────────────────

/** Thrown by `validateDag` / `loadDag` with every problem found, not just the
 *  first — authoring a DAG by hand is iterative, so surface the full list. */
export class DagValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid v3 dag.json:\n  - ${problems.join('\n  - ')}`);
    this.name = 'DagValidationError';
  }
}

/** Node ids and runId double as filesystem path segments under the runDir. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate an untrusted parsed value into a `V3Dag`.  Pure — throws
 * `DagValidationError` with the full problem list on any violation, otherwise
 * returns a normalized dag (defaults filled, `humanGate: undefined` → `null`).
 *
 * Checks: runId shape; non-empty unique path-safe node ids; known `type`;
 * `goal` non-empty for goal nodes; `host` rejected (executor not yet built);
 * `depends` reference existing nodes, no self-dep, no dup `from` (P0: one
 * edge per (from,to)); edge predicates validated against the SOURCE's
 * resultSchema (goal-with-schema sources only); `triggerRule` shape/bounds;
 * `inputs.from` reference existing nodes AND appear in `depends`; acyclic
 * (delegated to `topologicalOrder`, conditional edges included).
 */
export function validateDag(raw: unknown): V3Dag {
  const problems: string[] = [];

  if (!isObject(raw)) {
    throw new DagValidationError(['root must be a JSON object']);
  }
  if (typeof raw.runId !== 'string' || !SEGMENT_RE.test(raw.runId)) {
    problems.push(`runId must be a path-safe string matching ${SEGMENT_RE} (got ${JSON.stringify(raw.runId)})`);
  }
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new DagValidationError([...problems, 'nodes must be a non-empty array']);
  }

  const ids = new Set<string>();
  const nodes: V3Node[] = [];
  // Edge predicates parked until every node (and thus every source's
  // resultSchema) is collected — validated in the cross-node pass below.
  const pendingWhens: PendingWhen[] = [];

  for (let i = 0; i < raw.nodes.length; i++) {
    const n = raw.nodes[i];
    const where = `nodes[${i}]`;
    if (!isObject(n)) {
      problems.push(`${where} must be an object`);
      continue;
    }
    const id = n.id;
    if (typeof id !== 'string' || !SEGMENT_RE.test(id)) {
      problems.push(`${where}.id must be a path-safe string matching ${SEGMENT_RE} (got ${JSON.stringify(id)})`);
      continue;
    }
    if (ids.has(id)) {
      problems.push(`duplicate node id "${id}"`);
      continue;
    }
    ids.add(id);

    const type = n.type;
    if (type !== 'goal' && type !== 'host' && type !== 'loop') {
      problems.push(`node "${id}".type must be one of ${NODE_KINDS.join(' | ')} (got ${JSON.stringify(type)})`);
      continue;
    }
    if (type === 'host') {
      problems.push(`node "${id}": type "host" is reserved but not yet executable in MVP — use "goal"`);
      continue;
    }

    const depends = normDepends(n.depends, `node "${id}"`, problems, { ownerId: id, list: pendingWhens });
    const fromList = depends.map((d) => d.from);
    if (fromList.includes(id)) problems.push(`node "${id}" depends on itself`);
    if (new Set(fromList).size !== fromList.length) problems.push(`node "${id}".depends has duplicates`);

    const triggerRule = normTriggerRule(n.triggerRule, depends.length, `node "${id}"`, problems);

    const inputs = normInputs(n.inputs, id, problems);

    if (type === 'loop') {
      const loopFields = normLoopFields(n, id, problems);
      if (loopFields) {
        nodes.push({
          id,
          type,
          goal: typeof n.goal === 'string' ? n.goal : undefined,
          bot: typeof n.bot === 'string' ? n.bot : undefined,
          depends,
          triggerRule,
          inputs,
          humanGate: null,
          ...loopFields,
        });
      }
      continue;
    }

    if (typeof n.goal !== 'string' || n.goal.trim() === '') {
      problems.push(`goal node "${id}".goal must be a non-empty string`);
    }

    const timeoutSec = normTimeoutSec(n.timeoutSec, `node "${id}"`, problems);

    const resultSchema = normResultSchema(n.resultSchema, id, problems);

    const humanGate = normHumanGate(n.humanGate, `node "${id}"`, problems);

    const override = normOverride(n.override, `node "${id}"`, problems);

    const revisitTo = normRevisitTo(n.revisitTo, id, problems);

    nodes.push({
      id,
      type,
      goal: typeof n.goal === 'string' ? n.goal : undefined,
      bot: typeof n.bot === 'string' ? n.bot : undefined,
      depends,
      triggerRule,
      override,
      inputs,
      timeoutSec,
      humanGate,
      resultSchema,
      ...(revisitTo ? { revisitTo } : {}),
    });
  }

  // Cross-node reference checks — only meaningful once ids are collected.
  for (const node of nodes) {
    for (const dep of node.depends) {
      if (!ids.has(dep.from)) problems.push(`node "${node.id}" depends on unknown node "${dep.from}"`);
    }
    for (const inp of node.inputs) {
      if (!ids.has(inp.from)) {
        problems.push(`node "${node.id}".inputs references unknown node "${inp.from}"`);
      } else if (!node.depends.some((d) => d.from === inp.from)) {
        problems.push(`node "${node.id}".inputs.from "${inp.from}" must also be in depends`);
      }
    }
    // revisitTo: each target must exist AND be a (transitive) ANCESTOR of this
    // node — a revisit only ever jumps BACKWARD, so the definition graph stays
    // acyclic and the supersede cone is well-defined (cross-node回溯 design).
    if (node.revisitTo && node.revisitTo.length > 0) {
      const ancestors = ancestorsOf(node.id, nodes);
      for (const target of node.revisitTo) {
        if (!ids.has(target)) {
          problems.push(`node "${node.id}".revisitTo references unknown node "${target}"`);
        } else if (target === node.id) {
          problems.push(`node "${node.id}".revisitTo cannot point at itself`);
        } else if (!ancestors.has(target)) {
          problems.push(
            `node "${node.id}".revisitTo "${target}" must be an ancestor (reachable via depends) — revisit only jumps backward`,
          );
        }
      }
    }
  }

  // Edge-predicate validation (design §2): the source must be a goal node
  // declaring a resultSchema — loop sources are forbidden in P0 (a loop's
  // outward manifest belongs to its output-projection body node; put an
  // explicit verifier goal after the loop instead), and host sources are
  // unreachable (host itself is rejected above).  The predicate reuses the
  // loop-exit validator: declared + required key, exactly one operator,
  // type-compatible, enum-reconciled.
  const nodeById = new Map(nodes.map((nn) => [nn.id, nn]));
  for (const pw of pendingWhens) {
    const source = nodeById.get(pw.ref.from);
    if (!source) continue; // unknown `from` already reported above
    if (source.type !== 'goal') {
      problems.push(
        `${pw.where}: conditional edge source "${pw.ref.from}" must be a goal node ` +
          `(P0 forbids loop sources — add a verifier goal after the loop and branch on ITS result)`,
      );
      continue;
    }
    if (!source.resultSchema) {
      problems.push(
        `${pw.where}: conditional edge source "${pw.ref.from}" must declare a resultSchema — the predicate reads its structured result`,
      );
      continue;
    }
    const when = normLoopExitWhen(pw.raw, source.resultSchema, pw.where, problems);
    if (when) pw.ref.when = when;
  }

  // Loop expansion namespace guard: iteration instances run under
  // `<loopId>.iNNN.<bodyId>` (see loopInstanceId), so no OTHER top-level id may
  // sit inside a loop's dot-prefix — an authored `repairLoop.i001.code` node
  // would collide with the expansion.  Plain ids may still contain dots.
  for (const node of nodes) {
    if (node.type !== 'loop') continue;
    for (const other of ids) {
      if (other !== node.id && other.startsWith(`${node.id}.`)) {
        problems.push(
          `node id "${other}" collides with loop "${node.id}" expansion namespace ("${node.id}.*")`,
        );
      }
    }
  }

  if (problems.length > 0) throw new DagValidationError(problems);

  const dag: V3Dag = { runId: raw.runId as string, nodes };
  // Cycle detection: topologicalOrder throws on a cycle.  Run it here so
  // loadDag rejects a cyclic DAG up front rather than mid-run.
  topologicalOrder(dag);
  return dag;
}

function normHumanGate(raw: unknown, where: string, problems: string[]): V3HumanGate | null {
  if (raw == null) return null;
  if (!isObject(raw) || typeof raw.prompt !== 'string' || raw.prompt.trim() === '') {
    problems.push(`${where}.humanGate must be { prompt: <non-empty string>, options?, approveOptions?, approvers? } or null`);
    return null;
  }

  let options = [...DEFAULT_HUMAN_GATE_OPTIONS];
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) {
      problems.push(`${where}.humanGate.options must be a non-empty string array`);
    } else {
      const parsed = parseUniqueStringList(
        raw.options,
        `${where}.humanGate.options`,
        problems,
        { allowEmptyList: false, maxItems: MAX_HUMAN_GATE_OPTIONS, maxLength: MAX_HUMAN_GATE_OPTION_LENGTH },
      );
      if (parsed) options = parsed;
    }
  }

  let approveOptions: string[] | undefined;
  if (raw.approveOptions !== undefined) {
    if (!Array.isArray(raw.approveOptions)) {
      problems.push(`${where}.humanGate.approveOptions must be a non-empty string array`);
    } else {
      approveOptions = parseUniqueStringList(
        raw.approveOptions,
        `${where}.humanGate.approveOptions`,
        problems,
        { allowEmptyList: false, maxLength: MAX_HUMAN_GATE_OPTION_LENGTH },
      );
    }
  }
  approveOptions ??= options.includes('approve') ? ['approve'] : [options[0]!];
  for (const opt of approveOptions) {
    if (!options.includes(opt)) {
      problems.push(`${where}.humanGate.approveOptions value ${JSON.stringify(opt)} must also appear in options`);
    }
  }

  let approvers: string[] = [];
  if (raw.approvers !== undefined) {
    if (!Array.isArray(raw.approvers)) {
      problems.push(`${where}.humanGate.approvers must be a string array`);
    } else {
      approvers = parseUniqueStringList(
        raw.approvers,
        `${where}.humanGate.approvers`,
        problems,
        { allowEmptyList: true },
      ) ?? [];
    }
  }

  return { prompt: raw.prompt, options, approveOptions, approvers };
}

function parseUniqueStringList(
  raw: unknown[],
  where: string,
  problems: string[],
  opts: { allowEmptyList: boolean; maxItems?: number; maxLength?: number },
): string[] | undefined {
  const values: string[] = [];
  const seen = new Set<string>();
  if (!opts.allowEmptyList && raw.length === 0) {
    problems.push(`${where} must not be empty`);
  }
  if (opts.maxItems !== undefined && raw.length > opts.maxItems) {
    problems.push(`${where} supports at most ${opts.maxItems} entries`);
  }
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      problems.push(`${where} entries must be non-empty strings`);
      continue;
    }
    if (opts.maxLength !== undefined && item.length > opts.maxLength) {
      problems.push(`${where} entry ${JSON.stringify(item)} exceeds ${opts.maxLength} characters`);
    }
    if (seen.has(item)) {
      problems.push(`${where} has duplicate value ${JSON.stringify(item)}`);
      continue;
    }
    seen.add(item);
    values.push(item);
  }
  return problems.some((p) => p.startsWith(where)) ? undefined : values;
}

function normStringArray(v: unknown, where: string, problems: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    problems.push(`${where} must be an array of strings`);
    return [];
  }
  return v as string[];
}

/** An edge predicate parked during the per-node pass: validated against the
 *  SOURCE node's resultSchema in the cross-node pass, then written back into
 *  `ref.when`. */
interface PendingWhen {
  where: string;
  ref: V3DependRef;
  raw: Record<string, unknown>;
}

/**
 * Normalize a `depends` array of `string | { from, when? }` entries into
 * `V3DependRef[]`.  `when` objects are NOT validated here (the source's
 * resultSchema may not be collected yet) — they are parked in `whenSink` for
 * the cross-node pass.  `whenSink === undefined` means conditional edges are
 * not allowed in this position (loop bodies, first cut).
 */
function normDepends(
  v: unknown,
  where: string,
  problems: string[],
  whenSink?: { ownerId: string; list: PendingWhen[] },
): V3DependRef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    problems.push(`${where}.depends must be an array of nodeId strings or { from, when? } objects`);
    return [];
  }
  const out: V3DependRef[] = [];
  for (let j = 0; j < v.length; j++) {
    const entry = v[j];
    if (typeof entry === 'string') {
      out.push({ from: entry });
      continue;
    }
    if (isObject(entry) && typeof entry.from === 'string') {
      const extra = Object.keys(entry).filter((k) => k !== 'from' && k !== 'when');
      if (extra.length > 0) {
        problems.push(`${where}.depends[${j}] has unsupported key(s): ${extra.join(', ')} (allowed: from, when)`);
        continue;
      }
      const ref: V3DependRef = { from: entry.from };
      if (entry.when !== undefined) {
        if (!whenSink) {
          problems.push(`${where}.depends[${j}].when: conditional edges are not supported inside a loop body (first cut)`);
          continue;
        }
        if (!isObject(entry.when)) {
          problems.push(`${where}.depends[${j}].when must be an object`);
          continue;
        }
        whenSink.list.push({
          where: `${where}.depends[${j}].when (edge "${entry.from}" -> "${whenSink.ownerId}")`,
          ref,
          raw: entry.when,
        });
      }
      out.push(ref);
      continue;
    }
    problems.push(`${where}.depends[${j}] must be a nodeId string or { from, when? }`);
  }
  return out;
}

/**
 * Validate `triggerRule` (design §1.2).  Bounds depend on the node's indegree:
 * a join rule on a node with no incoming edges is an authoring error, and a
 * quorum must be satisfiable (1..indegree).
 */
function normTriggerRule(
  v: unknown,
  indegree: number,
  where: string,
  problems: string[],
): V3TriggerRule | undefined {
  if (v === undefined) return undefined;
  if (v === 'all_success' || v === 'one_success') {
    if (indegree === 0) {
      problems.push(`${where}.triggerRule requires at least one incoming edge (depends is empty)`);
      return undefined;
    }
    return v;
  }
  if (isObject(v)) {
    const extra = Object.keys(v).filter((k) => k !== 'quorum');
    if (extra.length > 0) {
      problems.push(`${where}.triggerRule object only supports { quorum: N } (got extra: ${extra.join(', ')})`);
      return undefined;
    }
    if (indegree === 0) {
      problems.push(`${where}.triggerRule requires at least one incoming edge (depends is empty)`);
      return undefined;
    }
    const q = v.quorum;
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > indegree) {
      problems.push(`${where}.triggerRule.quorum must be an integer in [1, ${indegree}] (got ${JSON.stringify(q)})`);
      return undefined;
    }
    return { quorum: q };
  }
  problems.push(`${where}.triggerRule must be 'all_success' | 'one_success' | { quorum: N }`);
  return undefined;
}

/**
 * Validate the per-node capability override (P2).  Fail-loud on unknown keys
 * (incl. the deferred `toolsSubset` — better an explicit "not yet" than a
 * field the runtime silently ignores).  `permissionMode` has no 'bypass'
 * value BY CONSTRUCTION — the no-escalation red line lives in the type, not
 * in a runtime check.
 */
function normOverride(
  v: unknown,
  where: string,
  problems: string[],
): V3CapabilityOverride | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) {
    problems.push(`${where}.override must be an object`);
    return undefined;
  }
  const known = new Set(['model', 'permissionMode', 'systemPromptAppend']);
  const extra = Object.keys(v).filter((k) => !known.has(k));
  if (extra.length > 0) {
    const hint = extra.includes('toolsSubset') ? ' (toolsSubset is deferred — P2b)' : '';
    problems.push(`${where}.override has unsupported key(s): ${extra.join(', ')}${hint} (allowed: model, permissionMode, systemPromptAppend)`);
    return undefined;
  }
  const out: V3CapabilityOverride = {};
  if (v.model !== undefined) {
    if (typeof v.model !== 'string' || v.model.trim() === '' || v.model.length > MAX_OVERRIDE_MODEL_LENGTH) {
      problems.push(`${where}.override.model must be a non-empty string ≤${MAX_OVERRIDE_MODEL_LENGTH} chars`);
      return undefined;
    }
    out.model = v.model.trim();
  }
  if (v.permissionMode !== undefined) {
    if (v.permissionMode !== 'inherit' && v.permissionMode !== 'restricted') {
      problems.push(`${where}.override.permissionMode must be 'inherit' | 'restricted' (there is no 'bypass' — a node can only reduce privilege)`);
      return undefined;
    }
    out.permissionMode = v.permissionMode;
  }
  if (v.systemPromptAppend !== undefined) {
    if (
      typeof v.systemPromptAppend !== 'string' ||
      v.systemPromptAppend.trim() === '' ||
      Buffer.byteLength(v.systemPromptAppend, 'utf-8') > MAX_OVERRIDE_SYSTEM_PROMPT_APPEND
    ) {
      problems.push(`${where}.override.systemPromptAppend must be a non-empty string ≤${MAX_OVERRIDE_SYSTEM_PROMPT_APPEND} bytes`);
      return undefined;
    }
    out.systemPromptAppend = v.systemPromptAppend;
  }
  if (Object.keys(out).length === 0) {
    problems.push(`${where}.override must set at least one of model / permissionMode / systemPromptAppend`);
    return undefined;
  }
  return out;
}

function normTimeoutSec(v: unknown, where: string, problems: string[]): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    problems.push(`${where}.timeoutSec must be a positive number`);
    return undefined;
  }
  if (v > MAX_NODE_TIMEOUT_SEC) {
    problems.push(`${where}.timeoutSec ${v} exceeds the ${MAX_NODE_TIMEOUT_SEC}s (4h) ceiling`);
    return undefined;
  }
  return v;
}

/** Normalize `revisitTo`: an optional array of non-empty path-safe node ids.
 *  Shape only here; the ancestor / existence cross-checks run once all ids are
 *  collected (validateDag's cross-node pass). */
function normRevisitTo(v: unknown, id: string, problems: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    problems.push(`node "${id}".revisitTo must be an array of node ids`);
    return undefined;
  }
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      problems.push(`node "${id}".revisitTo entries must be non-empty node-id strings`);
      continue;
    }
    out.push(entry);
  }
  if (new Set(out).size !== out.length) problems.push(`node "${id}".revisitTo has duplicates`);
  return out.length > 0 ? out : undefined;
}

/** Transitive ancestors of `nodeId` over `depends` edges (the set of nodes
 *  from which `nodeId` is reachable downstream).  Used to constrain
 *  `revisitTo` to backward-only jumps.  Pure BFS over the (acyclic-by-design)
 *  definition graph. */
function ancestorsOf(nodeId: string, nodes: V3Node[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const queue = [...(byId.get(nodeId)?.depends.map((d) => d.from) ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const dep of byId.get(cur)?.depends ?? []) queue.push(dep.from);
  }
  return seen;
}

/**
 * Validate + normalize a loop node's composite fields.  Self-contained: the
 * body is its own little DAG (goal nodes only, internal refs, acyclic), and
 * exit/feedback/output all reference INTO the body, so every cross-check lives
 * here rather than in the top-level pass.  Returns `undefined` (with problems
 * pushed) on any violation.
 */
function normLoopFields(
  n: Record<string, unknown>,
  id: string,
  problems: string[],
): Pick<V3LoopNode, 'maxIterations' | 'body' | 'exit' | 'feedback' | 'output' | 'onExhausted' | 'sessionPolicy'> | undefined {
  const where = `loop node "${id}"`;
  const before = problems.length;

  // Fields that make no sense on a composite node — reject loudly rather than
  // silently ignore (same fail-loud stance as the resultSchema subset).
  if (n.timeoutSec !== undefined) {
    problems.push(`${where}.timeoutSec is not supported — set timeoutSec on body nodes instead`);
  }
  if (n.resultSchema !== undefined) {
    problems.push(`${where}.resultSchema is not supported — declare it on the exit body node`);
  }
  if (n.humanGate != null) {
    problems.push(`${where}.humanGate is not supported (first cut) — gate an upstream node instead`);
  }
  if (n.onExhausted !== undefined && n.onExhausted !== 'blocked') {
    problems.push(`${where}.onExhausted only supports "blocked"`);
  }
  if (n.sessionPolicy !== undefined && n.sessionPolicy !== 'fresh') {
    problems.push(`${where}.sessionPolicy only supports "fresh" (resumeWithinLoop is deferred)`);
  }
  if (n.override !== undefined) {
    problems.push(`${where}.override is not supported — a loop composite never spawns a worker; set override on body nodes instead`);
  }

  let maxIterations: number | undefined;
  if (typeof n.maxIterations !== 'number' || !Number.isInteger(n.maxIterations) || n.maxIterations < 1) {
    problems.push(`${where}.maxIterations must be a positive integer`);
  } else if (n.maxIterations > MAX_LOOP_ITERATIONS) {
    problems.push(`${where}.maxIterations ${n.maxIterations} exceeds the ${MAX_LOOP_ITERATIONS} ceiling`);
  } else {
    maxIterations = n.maxIterations;
  }

  // ── body: a small inline DAG of goal nodes ──
  const bodyRaw = n.body;
  if (!isObject(bodyRaw) || !Array.isArray(bodyRaw.nodes) || bodyRaw.nodes.length === 0) {
    problems.push(`${where}.body.nodes must be a non-empty array`);
    return undefined; // exit/feedback/output are unverifiable without a body
  }
  const bodyBefore = problems.length;
  const bodyIds = new Set<string>();
  const bodyNodes: V3Node[] = [];
  for (let j = 0; j < bodyRaw.nodes.length; j++) {
    const b = bodyRaw.nodes[j];
    const bwhere = `${where}.body.nodes[${j}]`;
    if (!isObject(b)) {
      problems.push(`${bwhere} must be an object`);
      continue;
    }
    const bid = b.id;
    if (typeof bid !== 'string' || !SEGMENT_RE.test(bid)) {
      problems.push(`${bwhere}.id must be a path-safe string matching ${SEGMENT_RE} (got ${JSON.stringify(bid)})`);
      continue;
    }
    if (bodyIds.has(bid)) {
      problems.push(`${where}.body has duplicate node id "${bid}"`);
      continue;
    }
    bodyIds.add(bid);
    if (b.type !== 'goal') {
      problems.push(`${where}.body node "${bid}": only "goal" nodes are allowed in a loop body (no nested loops, no host)`);
      continue;
    }
    if (typeof b.goal !== 'string' || b.goal.trim() === '') {
      problems.push(`${where}.body node "${bid}".goal must be a non-empty string`);
    }
    if (b.humanGate != null) {
      problems.push(`${where}.body node "${bid}".humanGate is not supported inside a loop body (first cut)`);
    }
    if (b.triggerRule !== undefined) {
      problems.push(`${where}.body node "${bid}".triggerRule is not supported inside a loop body (first cut)`);
    }
    // No whenSink: conditional edges are rejected inside a body (first cut).
    const bdepends = normDepends(b.depends, `${where}.body node "${bid}"`, problems);
    const bFromList = bdepends.map((d) => d.from);
    if (bFromList.includes(bid)) problems.push(`${where}.body node "${bid}" depends on itself`);
    if (new Set(bFromList).size !== bFromList.length) problems.push(`${where}.body node "${bid}".depends has duplicates`);
    const binputs = normInputs(b.inputs, `${id}.body.${bid}`, problems);
    const btimeout = normTimeoutSec(b.timeoutSec, `${where}.body node "${bid}"`, problems);
    const bschema = normResultSchema(b.resultSchema, `${id}.body.${bid}`, problems);
    const boverride = normOverride(b.override, `${where}.body node "${bid}"`, problems);
    bodyNodes.push({
      id: bid,
      type: 'goal',
      goal: typeof b.goal === 'string' ? b.goal : undefined,
      bot: typeof b.bot === 'string' ? b.bot : undefined,
      depends: bdepends,
      override: boverride,
      inputs: binputs,
      timeoutSec: btimeout,
      humanGate: null,
      resultSchema: bschema,
    });
  }
  // Body-internal references.
  for (const bn of bodyNodes) {
    for (const dep of bn.depends) {
      if (!bodyIds.has(dep.from)) problems.push(`${where}.body node "${bn.id}" depends on unknown body node "${dep.from}"`);
    }
    for (const inp of bn.inputs) {
      if (!bodyIds.has(inp.from)) {
        problems.push(`${where}.body node "${bn.id}".inputs references unknown body node "${inp.from}"`);
      } else if (!bn.depends.some((d) => d.from === inp.from)) {
        problems.push(`${where}.body node "${bn.id}".inputs.from "${inp.from}" must also be in depends`);
      }
    }
  }
  // Body acyclic — only checkable once its refs are sane (topologicalOrder
  // assumes valid deps).
  if (problems.length === bodyBefore && bodyNodes.length === bodyRaw.nodes.length) {
    try {
      topologicalOrder({ runId: 'body', nodes: bodyNodes });
    } catch (err) {
      if (err instanceof DagValidationError) {
        for (const p of err.problems) problems.push(`${where}.body: ${p}`);
      } else {
        throw err;
      }
    }
  }

  // ── exit ──
  let exit: V3LoopExit | undefined;
  const exitRaw = n.exit;
  if (!isObject(exitRaw) || typeof exitRaw.node !== 'string' || !isObject(exitRaw.when)) {
    problems.push(`${where}.exit must be { node: <bodyId>, when: { path, <operator> } }`);
  } else if (!bodyIds.has(exitRaw.node)) {
    problems.push(`${where}.exit.node "${exitRaw.node}" is not a body node`);
  } else {
    const exitNode = bodyNodes.find((b) => b.id === exitRaw.node);
    if (!exitNode?.resultSchema) {
      problems.push(`${where}.exit.node "${exitRaw.node}" must declare a resultSchema — the exit decision reads its structured result`);
    } else {
      const when = normLoopExitWhen(exitRaw.when, exitNode.resultSchema, `${where}.exit.when`, problems);
      if (when) exit = { node: exitRaw.node, when };
    }
  }

  // ── feedback: previous-iteration product references ──
  const feedback: string[] = [];
  if (n.feedback !== undefined) {
    if (!Array.isArray(n.feedback) || n.feedback.some((x) => typeof x !== 'string')) {
      problems.push(`${where}.feedback must be an array of strings`);
    } else {
      for (const ref of n.feedback as string[]) {
        const dot = ref.lastIndexOf('.');
        const bodyId = dot > 0 ? ref.slice(0, dot) : '';
        const kind = dot > 0 ? ref.slice(dot + 1) : '';
        if (!bodyIds.has(bodyId) || !['result', 'files', 'manifest'].includes(kind)) {
          problems.push(`${where}.feedback "${ref}" must be <bodyId>.result | <bodyId>.files | <bodyId>.manifest`);
          continue;
        }
        if (kind === 'result' && !bodyNodes.find((b) => b.id === bodyId)?.resultSchema) {
          problems.push(`${where}.feedback "${ref}" requires body node "${bodyId}" to declare a resultSchema`);
          continue;
        }
        if (feedback.includes(ref)) {
          problems.push(`${where}.feedback has duplicate "${ref}"`);
          continue;
        }
        feedback.push(ref);
      }
    }
  }

  // ── output projection (defaults to the exit node) ──
  let output: V3LoopOutput | undefined;
  if (n.output !== undefined) {
    if (!isObject(n.output) || typeof n.output.from !== 'string' || !bodyIds.has(n.output.from)) {
      problems.push(`${where}.output must be { from: <bodyId> }`);
    } else {
      output = { from: n.output.from };
    }
  } else if (exit) {
    output = { from: exit.node };
  }

  if (problems.length > before || maxIterations === undefined || !exit || !output) return undefined;
  return {
    maxIterations,
    body: { nodes: bodyNodes },
    exit,
    feedback,
    output,
    onExhausted: 'blocked',
    sessionPolicy: 'fresh',
  };
}

/**
 * Validate the exit predicate against the exit node's resultSchema:
 * `path` must be `result.<key>` for a DECLARED + REQUIRED key, and the single
 * comparison operator must be type-compatible with the key (boolean/string →
 * equals/notEquals; number → also gt/gte/lt/lte; array/object → unusable).
 */
function normLoopExitWhen(
  v: Record<string, unknown>,
  schema: V3ResultSchema,
  where: string,
  problems: string[],
): V3LoopExitWhen | undefined {
  const unknown = Object.keys(v).filter((k) => k !== 'path' && !(LOOP_WHEN_OPERATORS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    problems.push(`${where} has unsupported keyword(s): ${unknown.join(', ')} (allowed: path + one of ${LOOP_WHEN_OPERATORS.join('/')})`);
    return undefined;
  }
  const m = typeof v.path === 'string' ? /^result\.([A-Za-z0-9_-]+)$/.exec(v.path) : null;
  if (!m) {
    problems.push(`${where}.path must be "result.<key>" (the resultSchema subset is flat — no deeper paths)`);
    return undefined;
  }
  const key = m[1]!;
  const prop = schema.properties[key];
  if (!prop) {
    problems.push(`${where}.path references "${key}", which is not declared in the exit node's resultSchema`);
    return undefined;
  }
  if (!(schema.required ?? []).includes(key)) {
    problems.push(`${where}.path references "${key}", which must be in the exit node's resultSchema.required (otherwise the field may be absent at runtime)`);
    return undefined;
  }
  const ops = LOOP_WHEN_OPERATORS.filter((op) => v[op] !== undefined);
  if (ops.length !== 1) {
    problems.push(`${where} must set exactly ONE operator (${LOOP_WHEN_OPERATORS.join('/')})`);
    return undefined;
  }
  const op = ops[0]!;
  const operand = v[op];
  if (prop.type === 'array' || prop.type === 'object') {
    problems.push(`${where}: cannot compare "${key}" — exit predicates only support string/number/boolean fields`);
    return undefined;
  }
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    if (prop.type !== 'number') {
      problems.push(`${where}.${op} requires "${key}" to be a number field (it is ${prop.type})`);
      return undefined;
    }
    if (typeof operand !== 'number' || !Number.isFinite(operand)) {
      problems.push(`${where}.${op} must be a finite number`);
      return undefined;
    }
  } else {
    // equals / notEquals — operand must match the field's primitive type.
    if (typeof operand !== prop.type) {
      problems.push(`${where}.${op} must be a ${prop.type} to match "${key}"`);
      return undefined;
    }
    // Enum reconciliation (edge-activation design §2.3): when the field
    // declares a vocabulary, an operand outside it is a validate-time typo,
    // not a runtime surprise — the seedclaw `decision_values` equivalent.
    if (prop.type === 'string' && prop.enum && !prop.enum.includes(operand as string)) {
      problems.push(
        `${where}.${op} value ${JSON.stringify(operand)} is not in "${key}"'s enum [${prop.enum.join(', ')}]`,
      );
      return undefined;
    }
  }
  return { path: v.path as string, [op]: operand } as V3LoopExitWhen;
}

/**
 * Validate the opt-in `resultSchema` against the supported subset.  Strict on
 * purpose: unknown keywords are REJECTED (not ignored) so a schema the
 * validator silently wouldn't enforce can never enter a dag (codex v2 of the
 * blocked design).  Caps: ≤32 properties, ≤4KB serialized, flat (depth 1).
 */
function normResultSchema(v: unknown, id: string, problems: string[]): V3ResultSchema | undefined {
  if (v === undefined || v === null) return undefined;
  const where = `node "${id}".resultSchema`;
  if (!isObject(v)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  const knownTop = new Set(['type', 'properties', 'required']);
  for (const key of Object.keys(v)) {
    if (!knownTop.has(key)) {
      problems.push(`${where} has unsupported keyword "${key}" (subset allows: type/properties/required)`);
      return undefined;
    }
  }
  if (v.type !== 'object') {
    problems.push(`${where}.type must be "object"`);
    return undefined;
  }
  if (!isObject(v.properties) || Object.keys(v.properties).length === 0) {
    problems.push(`${where}.properties must be a non-empty object`);
    return undefined;
  }
  const props = Object.entries(v.properties);
  if (props.length > RESULT_SCHEMA_MAX_PROPERTIES) {
    problems.push(`${where} has ${props.length} properties (max ${RESULT_SCHEMA_MAX_PROPERTIES})`);
    return undefined;
  }
  const properties: Record<string, { type: V3ResultFieldType; enum?: string[] }> = {};
  for (const [name, spec] of props) {
    if (!isObject(spec)) {
      problems.push(`${where}.properties.${name} must be an object`);
      return undefined;
    }
    for (const key of Object.keys(spec)) {
      if (key !== 'type' && key !== 'enum') {
        problems.push(`${where}.properties.${name} has unsupported keyword "${key}" (subset allows: type, enum)`);
        return undefined;
      }
    }
    if (!RESULT_FIELD_TYPES.includes(spec.type as V3ResultFieldType)) {
      problems.push(`${where}.properties.${name}.type must be one of ${RESULT_FIELD_TYPES.join(' | ')}`);
      return undefined;
    }
    let enumValues: string[] | undefined;
    if (spec.enum !== undefined) {
      // enum on STRING fields only (edge-activation design §1.3) — it anchors
      // edge-predicate vocabulary; other types have nothing to enumerate.
      if (spec.type !== 'string') {
        problems.push(`${where}.properties.${name}.enum is only supported on string fields (it is ${String(spec.type)})`);
        return undefined;
      }
      if (!Array.isArray(spec.enum) || spec.enum.length === 0 || spec.enum.some((x) => typeof x !== 'string' || x.length === 0)) {
        problems.push(`${where}.properties.${name}.enum must be a non-empty array of non-empty strings`);
        return undefined;
      }
      if (spec.enum.length > RESULT_ENUM_MAX_VALUES) {
        problems.push(`${where}.properties.${name}.enum has ${spec.enum.length} values (max ${RESULT_ENUM_MAX_VALUES})`);
        return undefined;
      }
      if (new Set(spec.enum).size !== spec.enum.length) {
        problems.push(`${where}.properties.${name}.enum has duplicates`);
        return undefined;
      }
      const tooLong = (spec.enum as string[]).filter((x) => x.length > RESULT_ENUM_MAX_VALUE_LENGTH);
      if (tooLong.length > 0) {
        problems.push(`${where}.properties.${name}.enum value(s) exceed ${RESULT_ENUM_MAX_VALUE_LENGTH} chars: ${tooLong.join(', ')}`);
        return undefined;
      }
      enumValues = spec.enum as string[];
    }
    properties[name] = enumValues ? { type: spec.type as V3ResultFieldType, enum: enumValues } : { type: spec.type as V3ResultFieldType };
  }
  let required: string[] | undefined;
  if (v.required !== undefined) {
    if (!Array.isArray(v.required) || v.required.some((x) => typeof x !== 'string')) {
      problems.push(`${where}.required must be an array of strings`);
      return undefined;
    }
    const unknown = (v.required as string[]).filter((r) => !(r in properties));
    if (unknown.length > 0) {
      problems.push(`${where}.required references undeclared properties: ${unknown.join(', ')}`);
      return undefined;
    }
    if (new Set(v.required).size !== v.required.length) {
      problems.push(`${where}.required has duplicates`);
      return undefined;
    }
    required = v.required as string[];
  }
  const schema: V3ResultSchema = required ? { type: 'object', properties, required } : { type: 'object', properties };
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf-8');
  if (bytes > RESULT_SCHEMA_MAX_BYTES) {
    problems.push(`${where} serializes to ${bytes} bytes (max ${RESULT_SCHEMA_MAX_BYTES})`);
    return undefined;
  }
  return schema;
}

function normInputs(v: unknown, id: string, problems: string[]): V3InputRef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    problems.push(`node "${id}".inputs must be an array`);
    return [];
  }
  const out: V3InputRef[] = [];
  for (let j = 0; j < v.length; j++) {
    const inp = v[j];
    if (!isObject(inp) || typeof inp.from !== 'string') {
      problems.push(`node "${id}".inputs[${j}] must be { from: <nodeId>, select? }`);
      continue;
    }
    const extra = Object.keys(inp).filter((k) => k !== 'from' && k !== 'select');
    if (extra.length > 0) {
      problems.push(`node "${id}".inputs[${j}] has unsupported key(s): ${extra.join(', ')} (allowed: from, select)`);
      continue;
    }
    if (inp.select === undefined) {
      out.push({ from: inp.from });
      continue;
    }
    // P3 selector: exactly one of name/path, both non-empty strings.
    if (!isObject(inp.select)) {
      problems.push(`node "${id}".inputs[${j}].select must be { name: <string> } or { path: <string> }`);
      continue;
    }
    const selKeys = Object.keys(inp.select);
    const badKeys = selKeys.filter((k) => k !== 'name' && k !== 'path');
    if (badKeys.length > 0 || selKeys.length !== 1) {
      problems.push(`node "${id}".inputs[${j}].select must set exactly ONE of name / path`);
      continue;
    }
    const selVal = inp.select.name ?? inp.select.path;
    if (typeof selVal !== 'string' || selVal.trim() === '') {
      problems.push(`node "${id}".inputs[${j}].select.${selKeys[0]} must be a non-empty string`);
      continue;
    }
    out.push({
      from: inp.from,
      select: inp.select.name !== undefined ? { name: selVal } : { path: selVal },
    });
  }
  return out;
}

// ─── Loader ─────────────────────────────────────────────────────────────

/** Read + JSON.parse + validate a `dag.json` at `path`.  Throws
 *  `DagValidationError` on a malformed graph and a plain `Error` on read /
 *  parse failure (so callers can distinguish "bad file" from "bad graph"). */
export function loadDag(path: string): V3Dag {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`v3: cannot read dag.json at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`v3: dag.json at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateDag(parsed);
}

// ─── Topological order ─────────────────────────────────────────────────

/**
 * Deterministic topological order via Kahn's algorithm.  Ties (nodes with the
 * same remaining in-degree available at once) are broken by ascending id so
 * the schedule is stable across runs — important for reproducible journals.
 * Throws if the graph contains a cycle (lists the offending nodes).
 *
 * Assumes `depends` already reference existing nodes; `validateDag` enforces
 * that before calling here.
 */
export function topologicalOrder(dag: V3Dag): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>(); // dep → dependents
  for (const node of dag.nodes) {
    indeg.set(node.id, indeg.get(node.id) ?? 0);
    if (!adj.has(node.id)) adj.set(node.id, []);
  }
  for (const node of dag.nodes) {
    // Conditional and unconditional edges alike count for ordering/acyclicity
    // (edge-activation design H2): an edge that may never activate is still a
    // structural edge — the graph must be acyclic regardless of run outcomes.
    for (const dep of node.depends) {
      indeg.set(node.id, (indeg.get(node.id) ?? 0) + 1);
      adj.get(dep.from)!.push(node.id);
    }
  }

  // Ready set kept sorted for deterministic tie-breaking.
  const ready = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = indeg.get(next)! - 1;
      indeg.set(next, d);
      if (d === 0) {
        // Insert keeping `ready` sorted.
        const pos = lowerBound(ready, next);
        ready.splice(pos, 0, next);
      }
    }
  }

  if (order.length !== dag.nodes.length) {
    const stuck = dag.nodes.map((n) => n.id).filter((id) => !order.includes(id));
    throw new DagValidationError([`dag has a cycle among nodes: ${stuck.join(', ')}`]);
  }
  return order;
}

/** Index of the first element in sorted `arr` not less than `x`. */
function lowerBound(arr: string[], x: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
