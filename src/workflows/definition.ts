/**
 * WorkflowDefinition — canonical JSON shape for v0 workflows
 * (see /tmp/wf-ui-v0.md §3 for the spec).
 *
 * Two node types:
 *   - subagent     — runtime spawns the bot's worker, feeds `prompt`,
 *                    collects `output` JSON.
 *   - hostExecutor — runtime calls the executor registered by `executor`.
 *
 * The schema enforces shape; cross-field invariants (deps reachability,
 * no cycles) are checked by `parseWorkflowDefinition`.  The `revisionId`
 * helper computes a content hash over canonical JSON so semantically
 * equal definitions get identical ids regardless of key ordering.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

// ─── Field schemas ─────────────────────────────────────────────────────────

export const ParamDefSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
  format: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
});
export type ParamDef = z.infer<typeof ParamDefSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive(),
  backoff: z.enum(['fixed', 'exponential']),
  baseMs: z.number().int().positive(),
  factor: z.number().positive().optional(),
  jitter: z.boolean().optional(),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * Output binding — `{ "$ref": "<nodeId>.output.<path>" }` references the
 * `output` of another node's most recent successful work activity.
 *
 * Hard constraints (all enforced at parse time):
 *   - Object MUST be exactly one key (`$ref`), strict — no extra fields.
 *     Half-parsed mixed objects are a footgun: callers might forget the
 *     `$ref` key and silently get a literal object instead of resolved data.
 *   - `$ref` must be a non-empty string; runtime `resolveRef` then enforces
 *     the `.output.` separator + path-segment safety (no `__proto__` etc).
 */
export const OutputRefSpecSchema = z.object({
  $ref: z.string().min(1),
}).strict();
export type OutputRefSpec = z.infer<typeof OutputRefSpecSchema>;

/** A string field that may either be a literal or a single `$ref`. */
export const BoundStringSchema = z.union([z.string(), OutputRefSpecSchema]);
export type BoundString = z.infer<typeof BoundStringSchema>;

/**
 * Recursive JSON allowing `OutputRefSpec` to appear at any leaf or sub-tree.
 *
 * Refusal rule for non-strict `$ref`-bearing objects: an object that has a
 * `$ref` key MUST be an exact strict `OutputRefSpec`.  Mixing `$ref` with
 * other keys is rejected at parse time to keep `$ref` a reserved form.
 */
export const BoundJsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    OutputRefSpecSchema,
    z.array(BoundJsonValueSchema),
    z.record(BoundJsonValueSchema).refine(
      (obj) => !Object.prototype.hasOwnProperty.call(obj, '$ref'),
      { message: '`$ref` must appear in an exact `{ "$ref": <string> }` object — no extra keys allowed' },
    ),
  ]),
);

export const HumanGateSchema = z.object({
  // v0 only supports 'before'.  after-step gate would need a different
  // dispatch model (suspend post-success); deferred to v1+.
  stage: z.literal('before'),
  prompt: BoundStringSchema,
  approvers: z.array(z.string()).optional(),
  deadlineMs: z.number().int().positive().optional(),
  onTimeout: z.enum(['fail', 'success']).optional(),
});
export type HumanGate = z.infer<typeof HumanGateSchema>;

// JSON Schema is opaque to us — workflow author owns validation rules,
// runtime just feeds the schema to Ajv when validating output.
export const OutputSchemaSchema = z.record(z.unknown());

const NodeBaseShape = {
  description: z.string().optional(),
  depends: z.array(z.string()).optional(),
  humanGate: HumanGateSchema.optional(),
  retryPolicy: RetryPolicySchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  outputSchema: OutputSchemaSchema.optional(),
  /**
   * Opt-in escape hatch for a side-effect hostExecutor node that *must* run
   * without a humanGate (e.g. a system-internal cron tick, an explicitly
   * batched send-all script).  Default is unset / false → validator rejects
   * ungated side-effect executors at parse time (`SIDE_EFFECT_EXECUTORS`).
   *
   * Setting this to `true` is the workflow author's audit-trail: "I know
   * this node sends a message / writes to repo / schedules a cron with no
   * human approval — accept the risk."  Prefer `humanGate` whenever the
   * intent is "let an operator confirm before this fires."
   */
  unsafeAllowUngated: z.boolean().optional(),
};

export const SubagentNodeSchema = z.object({
  ...NodeBaseShape,
  type: z.literal('subagent'),
  bot: z.string().min(1),
  prompt: BoundStringSchema,
  workingDir: z.string().optional(),
  modelOverrides: z
    .object({
      model: z.string().optional(),
      reasoningEffort: z.string().optional(),
    })
    .optional(),
  toolPolicy: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
});
export type SubagentNode = z.infer<typeof SubagentNodeSchema>;

export const HostExecutorNodeSchema = z.object({
  ...NodeBaseShape,
  type: z.literal('hostExecutor'),
  executor: z.string().min(1),
  input: BoundJsonValueSchema,
});
export type HostExecutorNode = z.infer<typeof HostExecutorNodeSchema>;

/**
 * Executors that produce externally-visible side effects: sending a Feishu
 * message, scheduling a botmux cron task, etc.  Validator requires a
 * `humanGate.stage='before'` on any node using one of these executors, or
 * an explicit `unsafeAllowUngated: true` opt-in (see NodeBaseShape).
 *
 * Add new executors here as they're registered with the dispatch table —
 * keep this list in lockstep with `runtime.ts`'s side-effect executor
 * registrations.  Read-only / pure-computation executors do NOT belong
 * here; only ones whose execution is observable outside the workflow.
 */
export const SIDE_EFFECT_EXECUTORS: ReadonlySet<string> = new Set([
  'feishu-send',
  'feishu-reply',
  'botmux-schedule',
]);

export function isSideEffectExecutor(executor: string): boolean {
  return SIDE_EFFECT_EXECUTORS.has(executor);
}

// ─── Loop / Decision (v0.2 — see /tmp/wf-loop-v02.md §3.1) ────────────────
//
// `loop` is a control-flow node: it wraps a body sub-graph that re-runs
// until a `decision` terminator approves (or maxIterations hits).
// `decision` is a gate-only node: no work payload, just a humanGate whose
// resolution drives the loop state machine.  Both types must be cross-
// validated by `validateLoopBlocks` after schema parse (membership, no
// nested loops, external deps surfaced on loop.depends, etc.).
//
// Strict object shape — additional keys are rejected at parse time so
// that a workflow author who writes `outputSchema` / `prompt` / `bot` on
// a decision node gets a fail-loud error instead of silently dropped
// fields (codex round 2 N2: decision output contract is runtime-fixed).

export const LoopOutputProjectionSchema = z.object({
  from: z.string().min(1),
}).strict();
export type LoopOutputProjection = z.infer<typeof LoopOutputProjectionSchema>;

export const LoopNodeSchema = z.object({
  type: z.literal('loop'),
  description: z.string().optional(),
  depends: z.array(z.string()).optional(),
  maxIterations: z.number().int().positive(),
  body: z.array(z.string().min(1)).min(1),
  terminate: z.object({
    node: z.string().min(1),
    via: z.literal('humanGate'),
  }).strict(),
  output: LoopOutputProjectionSchema.optional(),
}).strict();
export type LoopNode = z.infer<typeof LoopNodeSchema>;

export const DecisionNodeSchema = z.object({
  type: z.literal('decision'),
  description: z.string().optional(),
  depends: z.array(z.string()).optional(),
  humanGate: HumanGateSchema,
}).strict();
export type DecisionNode = z.infer<typeof DecisionNodeSchema>;

export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  SubagentNodeSchema,
  HostExecutorNodeSchema,
  LoopNodeSchema,
  DecisionNodeSchema,
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

/**
 * Node id constraint: safe path segment for use in activityId and the
 * artifact sidecar path (UI doc §A: `runs/<runId>/attempts/<activityId>/...`).
 * Disallow `/`, `..`, whitespace, etc. so a maliciously authored or
 * imported workflow cannot escape the run directory.
 */
export const NODE_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const NodeIdSchema = z.string().regex(
  NODE_ID_PATTERN,
  'nodeId must match [A-Za-z0-9_.-]+ (no path separators or whitespace)',
);

export const WorkflowDefinitionSchema = z.object({
  workflowId: z.string().min(1),
  version: z.number().int().positive(),
  params: z.record(ParamDefSchema).optional(),
  defaults: z
    .object({
      retryPolicy: RetryPolicySchema.optional(),
      timeoutMs: z.number().int().positive().optional(),
      maxOutputBytes: z.number().int().positive().optional(),
      /**
       * Cap on concurrent dispatch actions (dispatchGate + dispatchWork)
       * within a single runLoop tick.  v0.1.3 first-cut parallelism defaults
       * to 4 — small enough that a wide fan-out won't immediately exhaust
       * worker / OOM headroom, large enough that ~typical 2-3 branch DAGs
       * fully parallelize.  Set higher on workflows that want more throughput.
       *
       * Per-bot serialization is independent of this cap; same-bot siblings
       * still get dispatched one-per-tick regardless of the limit.
       */
      maxConcurrency: z.number().int().positive().optional(),
    })
    .optional(),
  nodes: z.record(NodeIdSchema, WorkflowNodeSchema),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// ─── Canonical JSON stringify ──────────────────────────────────────────────

/**
 * Canonical JSON: object keys sorted recursively, arrays preserved in
 * order, compact (no extra whitespace).  Defined this way so that any
 * authoring-tool round-trip (YAML→JSON, TS builder→JSON) produces an
 * identical string when the underlying data is the same.
 *
 * Numbers are emitted via JSON.stringify so NaN/Infinity (illegal in
 * JSON) round-trip to errors — caller should reject those in schema.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = canonicalize(obj[k]);
  return sorted;
}

// ─── revisionId ────────────────────────────────────────────────────────────

/**
 * revisionId = sha256(canonicalJsonStringify(def)).
 * Use the `version` field for human-readable semantic versions.
 */
export function computeRevisionId(def: WorkflowDefinition): string {
  return (
    'sha256:' +
    createHash('sha256').update(canonicalJsonStringify(def)).digest('hex')
  );
}

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Schema parse + cross-field invariants:
 *   1. every `depends` entry references an existing node
 *   2. graph is acyclic
 *   3. at least one root node (no deps) among scheduler-visible nodes
 *      (loop body nodes are excluded from this check — they're scheduled
 *      by their owning loop block, not the top-level orchestrator)
 *   4. loop / decision cross-field invariants (see `validateLoopBlocks`)
 *
 * Throws on any failure.  Use `WorkflowDefinitionSchema.safeParse(...)`
 * directly if you only need shape checks (no graph validation).
 */
export function parseWorkflowDefinition(raw: unknown): WorkflowDefinition {
  const def = WorkflowDefinitionSchema.parse(raw);
  validateGraph(def);
  return def;
}

function validateGraph(def: WorkflowDefinition): void {
  const ids = Object.keys(def.nodes);
  if (ids.length === 0) {
    throw new Error('Workflow must declare at least one node');
  }
  for (const nodeId of ids) {
    // Defense-in-depth alongside NODE_ID_PATTERN: the regex permits `.`
    // for compound names like `node.v2`, but standalone `.` or `..` —
    // and any segment with `..` — must be banned to keep the artifact
    // sidecar path (`runs/<runId>/attempts/<activityId>/...`) inside
    // the run directory.
    if (nodeId === '.' || nodeId === '..' || nodeId.includes('..')) {
      throw new Error(
        `nodeId '${nodeId}' rejected: path-traversal style ids are not allowed`,
      );
    }
  }
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    for (const dep of node.depends ?? []) {
      if (!def.nodes[dep]) {
        throw new Error(`Node '${nodeId}' depends on unknown node '${dep}'`);
      }
      if (dep === nodeId) {
        throw new Error(`Node '${nodeId}' depends on itself`);
      }
    }
    // Safe-by-default: a hostExecutor node that runs a side-effect executor
    // must either declare `humanGate.stage='before'` or opt into the audit
    // trail via `unsafeAllowUngated: true`.  Catches ungated `feishu-send`
    // and friends at parse time instead of relying on author discipline.
    if (
      node.type === 'hostExecutor' &&
      isSideEffectExecutor(node.executor) &&
      !node.humanGate &&
      !node.unsafeAllowUngated
    ) {
      throw new Error(
        `Node '${nodeId}' runs side-effect executor '${node.executor}' without ` +
        `a humanGate. Add humanGate.stage='before' for human approval, or set ` +
        `unsafeAllowUngated: true to acknowledge the risk explicitly.`,
      );
    }
  }
  detectCycle(def);

  // Loop / decision cross-field validation runs before the root check so
  // we can compute the body-node set used to scope "scheduler-visible
  // roots".
  const bodyNodeIds = validateLoopBlocks(def);

  // Root check: at least one scheduler-visible node has no deps.  Loop
  // body nodes are by construction scheduled by their owning loop, so
  // their "no-deps" status is internal to the loop and must not count
  // toward workflow-level reachability.
  const hasRoot = ids.some(
    (id) => !bodyNodeIds.has(id) && (def.nodes[id]!.depends ?? []).length === 0,
  );
  if (!hasRoot) {
    throw new Error(
      'Workflow has no scheduler-visible root node (every non-loop-body node has dependencies)',
    );
  }
}

/**
 * Loop / decision cross-field validation (v0.2; see /tmp/wf-loop-v02.md §3.4).
 *
 * Returns the set of node ids that belong to some loop's body, so the
 * caller (`validateGraph`) can scope the root-existence check to
 * scheduler-visible nodes only.
 *
 * Throws on any rule violation.  Error messages always include the
 * offending loopId + nodeId so workflow-create skills and authors can
 * self-correct without re-reading the spec.
 */
export function validateLoopBlocks(def: WorkflowDefinition): Set<string> {
  const allLoopBodyIds = new Set<string>();
  // Track which loop owns each body node so we can detect cross-loop
  // body-membership collisions in one pass.
  const bodyOwner = new Map<string, string>();
  // Collect loop blocks up front so cross-block invariants (decision
  // node membership, external deps surfaced on loop.depends, etc.) can
  // be checked with full context.
  const loopBlocks: Array<{ loopId: string; node: LoopNode }> = [];

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (node.type !== 'loop') continue;
    loopBlocks.push({ loopId: nodeId, node });
    for (const bodyId of node.body) {
      // Body id must exist as a top-level node.
      if (!def.nodes[bodyId]) {
        throw new Error(
          `Loop '${nodeId}' body references unknown node '${bodyId}'`,
        );
      }
      // A body node cannot be the loop block itself.
      if (bodyId === nodeId) {
        throw new Error(
          `Loop '${nodeId}' body must not include the loop block itself`,
        );
      }
      // A node can belong to at most one loop body — collisions break
      // iteration / activityId scoping.
      const prev = bodyOwner.get(bodyId);
      if (prev && prev !== nodeId) {
        throw new Error(
          `Loop body node '${bodyId}' is claimed by both '${prev}' and '${nodeId}'; ` +
          `a node can belong to at most one loop body`,
        );
      }
      bodyOwner.set(bodyId, nodeId);
      allLoopBodyIds.add(bodyId);

      // v0.2 rejects nested loops — a body node may not itself be a
      // loop.  Removing this restriction in a future version requires
      // re-checking activityId composition + replay determinism.
      if (def.nodes[bodyId]!.type === 'loop') {
        throw new Error(
          `Loop '${nodeId}' body contains nested loop '${bodyId}'; nested loops are not supported in v0.2`,
        );
      }
    }
    // terminate.node must be in this loop's body and must be a decision.
    const termId = node.terminate.node;
    if (!node.body.includes(termId)) {
      throw new Error(
        `Loop '${nodeId}' terminate.node '${termId}' is not in body [${node.body.join(', ')}]`,
      );
    }
    const termNode = def.nodes[termId];
    if (!termNode || termNode.type !== 'decision') {
      throw new Error(
        `Loop '${nodeId}' terminate.node '${termId}' must be a decision node (got '${termNode?.type ?? 'undefined'}')`,
      );
    }
    // Each loop body must contain exactly one decision node, and (by
    // construction since terminate.node is verified to be a decision in
    // the body above) it must equal terminate.node.
    //
    // Why: `wait.ts` decision-mode treats *any* decision-typed node's
    // reject as a structured `activitySucceeded { resolution: 'rejected' }`
    // blob, regardless of terminator status (the dispatcher has no
    // terminator-vs-non-terminator distinction at resolve time).  So if
    // a body has two decisions, the non-terminator one's reject would
    // silently "succeed" and the body would continue past a rejection
    // the author intended to terminate the loop.  Force authors to use
    // a regular `subagent + humanGate` for intermediate approvals — only
    // the terminator slot is allowed to be a decision.
    const decisionsInBody = node.body.filter(
      (id) => def.nodes[id]?.type === 'decision',
    );
    if (decisionsInBody.length !== 1) {
      throw new Error(
        `Loop '${nodeId}' body must contain exactly one decision node ` +
        `(got ${decisionsInBody.length}: [${decisionsInBody.join(', ')}]) — ` +
        `decision nodes are the loop terminator slot; a non-terminator ` +
        `decision's reject would be silently treated as success by ` +
        `wait.ts decision-mode, letting the body continue past the rejection. ` +
        `Use a regular subagent + humanGate for intermediate approvals.`,
      );
    }
    // output.from (if declared) must be a body node and not the terminator.
    if (node.output) {
      if (!node.body.includes(node.output.from)) {
        throw new Error(
          `Loop '${nodeId}' output.from '${node.output.from}' is not in body [${node.body.join(', ')}]`,
        );
      }
      if (node.output.from === termId) {
        throw new Error(
          `Loop '${nodeId}' output.from '${node.output.from}' must not be the terminate.node ` +
          `(terminator has no work output; pick a body node that produces real output)`,
        );
      }
    }
  }

  // Decision nodes must belong to some loop body (v0.2: no standalone
  // decision use case exists yet; relaxing this needs a separate
  // dispatch model).
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (node.type !== 'decision') continue;
    if (!allLoopBodyIds.has(nodeId)) {
      throw new Error(
        `Decision node '${nodeId}' is not referenced by any loop's body; ` +
        `decision nodes are only valid inside a loop terminate.node slot in v0.2`,
      );
    }
  }

  // External dependency rule (codex round 2 N1): if a body node depends
  // on a node outside the loop body, the loop block itself must list
  // that external dep in its own `depends`.  We refuse to silently
  // promote — the workflow JSON should make every cross-loop edge
  // visible.
  //
  // Outside-the-body deps include any node not in *this* loop's body
  // (siblings, top-level subagent/hostExecutor, other loops).
  for (const { loopId, node: loopNode } of loopBlocks) {
    const bodySet = new Set(loopNode.body);
    const loopDeps = new Set(loopNode.depends ?? []);
    for (const bodyId of loopNode.body) {
      const bodyNode = def.nodes[bodyId]!;
      for (const dep of bodyNode.depends ?? []) {
        if (bodySet.has(dep)) continue; // internal dep — fine
        if (!loopDeps.has(dep)) {
          throw new Error(
            `Loop '${loopId}' body node '${bodyId}' depends on external node '${dep}', ` +
            `but loop '${loopId}' does not list '${dep}' in its own depends — ` +
            `add '${dep}' to loop.depends explicitly so the loop block waits for it`,
          );
        }
      }
    }
  }

  // No external node may depend on a loop body node — outsiders are
  // only allowed to depend on the loop block itself.  This keeps the
  // top-level scheduler unaware of body nodes.
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (allLoopBodyIds.has(nodeId)) continue; // external = non-body
    for (const dep of node.depends ?? []) {
      if (allLoopBodyIds.has(dep)) {
        throw new Error(
          `Node '${nodeId}' depends on loop body node '${dep}'; ` +
          `external dependents must depend on the loop block, not its body — ` +
          `use the loop block id (and optionally declare output.from on the loop) instead`,
        );
      }
    }
  }

  // Sink-loop rule (codex PR #47 round-2 finding #1): a loop block that is
  // a workflow sink (no external dependents) must declare `output.from`.
  // orchestrator.ts only emits `completeRunSucceeded` when the sink activity
  // has an output blob; a loop block without `output.from` never writes
  // `outputs[sinkActivityId]` from `loopFinished`, so the run hangs in
  // `no-progress` after approval.  Force the author to choose at parse time.
  const externalDependents = new Map<string, Set<string>>();
  for (const { loopId } of loopBlocks) externalDependents.set(loopId, new Set());
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (allLoopBodyIds.has(nodeId)) continue;
    for (const dep of node.depends ?? []) {
      const deps = externalDependents.get(dep);
      if (deps) deps.add(nodeId);
    }
  }
  for (const { loopId, node: loopNode } of loopBlocks) {
    if (loopNode.output) continue;
    if ((externalDependents.get(loopId) ?? new Set()).size > 0) continue;
    throw new Error(
      `Loop '${loopId}' has no external dependents (workflow sink) but does not declare 'output.from' — ` +
      `without output.from the loopFinished projection writes no sink output and the run cannot complete (no-progress). ` +
      `Add output.from pointing to a body node, e.g. \`"output": { "from": "${loopNode.body[0]}" }\`.`,
    );
  }

  // Decision-timeout rule (codex PR #47 round-2 finding #2): decision nodes
  // must use `humanGate.onTimeout = 'fail'` (or leave it unset; default is
  // fail).  `onTimeout='success'` is legal at the schema level but
  // `expireWait` writes the succeeded blob as `{ defaultedToTimeout,
  // deadlineAt }` without `resolution`/`by`/`comment`, so the next
  // iteration's `${decisionNode.previous.comment}` bindings hit
  // BindingError.  Statically rule this out at validate time — if the
  // author truly wants "timeout = approve" semantics they can implement
  // it via a wrapper subagent that produces the structured resolution.
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (node.type !== 'decision') continue;
    if (node.humanGate?.onTimeout === 'success') {
      throw new Error(
        `Decision node '${nodeId}' humanGate.onTimeout='success' is not allowed — ` +
        `the timeout fallback would write a succeeded blob missing {resolution, by, comment}, ` +
        `breaking the next iteration's \${${nodeId}.previous.*} bindings. ` +
        `Use onTimeout='fail' (default) so timeout closes the loop via loopFinished(timeout).`,
      );
    }
  }

  return allLoopBodyIds;
}

function detectCycle(def: WorkflowDefinition): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const ids = Object.keys(def.nodes);
  ids.forEach((id) => color.set(id, WHITE));
  const path: string[] = [];

  const visit = (id: string): void => {
    const c = color.get(id);
    if (c === BLACK) return;
    if (c === GRAY) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id].join(' → ');
      throw new Error(`Workflow has cycle: ${cycle}`);
    }
    color.set(id, GRAY);
    path.push(id);
    for (const dep of def.nodes[id]!.depends ?? []) visit(dep);
    path.pop();
    color.set(id, BLACK);
  };

  for (const id of ids) visit(id);
}

// ─── Topological order ────────────────────────────────────────────────────

/**
 * Kahn's algorithm.  Returns nodeIds in dispatch-safe order (deps before
 * dependents).  Ties broken by `Object.keys(nodes)` insertion order so
 * the result is deterministic for a given workflow JSON.
 *
 * Assumes the graph is valid (no cycles); call `parseWorkflowDefinition`
 * first or pass a definition that already came from there.
 */
export function topologicalOrder(def: WorkflowDefinition): string[] {
  const ids = Object.keys(def.nodes);
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  ids.forEach((id) => {
    indeg.set(id, 0);
    children.set(id, []);
  });
  for (const [id, node] of Object.entries(def.nodes)) {
    for (const dep of node.depends ?? []) {
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
      children.get(dep)!.push(id);
    }
  }
  const queue: string[] = [];
  for (const id of ids) if ((indeg.get(id) ?? 0) === 0) queue.push(id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const child of children.get(id)!) {
      indeg.set(child, (indeg.get(child) ?? 0) - 1);
      if ((indeg.get(child) ?? 0) === 0) queue.push(child);
    }
  }
  return order;
}
