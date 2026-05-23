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

export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  SubagentNodeSchema,
  HostExecutorNodeSchema,
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
 *   3. at least one root node (no deps)
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
  const hasRoot = ids.some((id) => (def.nodes[id]!.depends ?? []).length === 0);
  if (!hasRoot) {
    throw new Error('Workflow has no root node (every node has dependencies)');
  }
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
