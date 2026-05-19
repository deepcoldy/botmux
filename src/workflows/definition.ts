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

export const HumanGateSchema = z.object({
  // v0 only supports 'before'.  after-step gate would need a different
  // dispatch model (suspend post-success); deferred to v1+.
  stage: z.literal('before'),
  prompt: z.string(),
  approvers: z.array(z.string()).optional(),
  deadlineMs: z.number().int().positive().optional(),
  onTimeout: z.enum(['fail', 'success']).optional(),
});
export type HumanGate = z.infer<typeof HumanGateSchema>;

// JSON Schema is opaque to us — workflow author owns validation rules,
// runtime just feeds the schema to Ajv when validating output.
export const OutputSchemaSchema = z.record(z.unknown());

const NodeBaseShape = {
  depends: z.array(z.string()).optional(),
  humanGate: HumanGateSchema.optional(),
  retryPolicy: RetryPolicySchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  outputSchema: OutputSchemaSchema.optional(),
};

export const SubagentNodeSchema = z.object({
  ...NodeBaseShape,
  type: z.literal('subagent'),
  bot: z.string().min(1),
  prompt: z.string(),
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
  input: z.unknown(),
});
export type HostExecutorNode = z.infer<typeof HostExecutorNodeSchema>;

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
