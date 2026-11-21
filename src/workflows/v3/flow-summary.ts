/**
 * 流程摘要 — what a person confirms at the second gate ("确认流程"), design
 * 2026-11-03 workflow-dashboard-orchestration §4.4 / §7.3.
 *
 * Three parts, each on the same terms as an existing summary so the page, the
 * Gate-2 reply, saved templates and run.json all mean the same thing:
 *   1. node → executing bot (CLI): the Architect's reason, ⚠️ where a named bot
 *      (`assignee`) is not honoured — the Gate-2 bot plan (#2728,
 *      `projectV3Gate2BotPlan`);
 *   2. outward actions: every host-action node and its kind — template
 *      `safety.sideEffects` (`computeSavedWorkflowSideEffects`);
 *   3. human gates: position and approval rule of every gate — template
 *      `safety.gateDigest` (`computeSavedWorkflowGateDigest`).
 *
 * Recorded as the normalized content plus its sha256. The normalization keeps
 * the digest a function of the confirmed facts only:
 *   - node rows and unplaced ⚠️ entries are sets keyed by id: sorted by
 *     code-unit order (locale-independent), so listing order does not count;
 *   - display names and explanatory `why` texts are left out: renaming a bot
 *     or rewording a hint is not a different flow;
 *   - the gate digest keeps its own (DAG-order) definition unchanged.
 *
 * Shared by Gate-2 `approve-dag` (D1), Dashboard drafts (D2), 拉群开始's
 * pre-write check (D4) and template saves (D5).
 *
 * ⚠️ Coverage: the summary is what a person reads and what templates compare.
 * It does NOT cover the whole flow — topology (depends), node goals, host
 * action inputs and overrides are outside it. Invalidating a confirmation and
 * the check before writing run.json MUST also compare dagSha256 / specSha256
 * (or the draft revision); never treat an equal summary digest alone as
 * "the confirmed flow is unchanged".
 *
 * String fields carry no length caps beyond the upstream DAG/spec validation
 * (node ids, loop `<loop>.<body>` ids and sketch ids are unbounded there): a
 * flow that validates must always be confirmable.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJsonStringify } from '../../utils/canonical-json.js';
import type { V3Node } from './dag.js';
import type { V3Gate2BotPlan } from './bot-assignment.js';
import { computeSavedWorkflowGateDigest, computeSavedWorkflowSideEffects } from './library-schema.js';

export const V3_FLOW_SUMMARY_VERSION = 1 as const;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const text = () => z.string().min(1);

const flowSummaryNodeSchema = z.object({
  nodeId: text(),
  larkAppId: text(),
  cli: text().optional(),
  reason: text().optional(),
  /** ⚠️ the named bot this node was meant for is not honoured. */
  missedAssignee: text().optional(),
}).strict();

const flowSummaryUnplacedSchema = z.object({
  /** `unresolved`: the name matches no / several bots; `no-node`: no node
   *  was given to the named bot. */
  kind: z.enum(['unresolved', 'no-node']),
  sketchId: text(),
  assignee: text(),
  larkAppId: text().optional(),
}).strict();

export const V3FlowSummarySchema = z.object({
  version: z.literal(V3_FLOW_SUMMARY_VERSION),
  nodes: z.array(flowSummaryNodeSchema),
  unplacedAssignees: z.array(flowSummaryUnplacedSchema),
  sideEffects: z.array(z.object({ nodeId: text(), kind: text() }).strict()),
  gateDigest: z.string().regex(SHA256_RE, 'must be sha256:<64 lowercase hex>'),
}).strict();

export type V3FlowSummary = z.infer<typeof V3FlowSummarySchema>;

const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Same content, canonical order. Idempotent. */
export function normalizeV3FlowSummary(summary: V3FlowSummary): V3FlowSummary {
  return {
    version: summary.version,
    nodes: [...summary.nodes].sort((a, b) => byCodeUnit(a.nodeId, b.nodeId) || byCodeUnit(a.larkAppId, b.larkAppId)),
    unplacedAssignees: [...summary.unplacedAssignees].sort((a, b) =>
      byCodeUnit(a.sketchId, b.sketchId) || byCodeUnit(a.kind, b.kind) || byCodeUnit(a.assignee, b.assignee)),
    sideEffects: [...summary.sideEffects].sort((a, b) => byCodeUnit(a.nodeId, b.nodeId) || byCodeUnit(a.kind, b.kind)),
    gateDigest: summary.gateDigest,
  };
}

/** Build the flow summary of a DAG and its Gate-2 bot plan. */
export function buildV3FlowSummary(input: { dagNodes: V3Node[]; plan: V3Gate2BotPlan }): V3FlowSummary {
  const template = { schemaVersion: 2 as const, nodes: input.dagNodes };
  return normalizeV3FlowSummary({
    version: V3_FLOW_SUMMARY_VERSION,
    nodes: input.plan.rows.map((row) => ({
      nodeId: row.nodeId,
      larkAppId: row.larkAppId,
      ...(row.cli ? { cli: row.cli } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.missedAssignee ? { missedAssignee: row.missedAssignee.assignee } : {}),
    })),
    unplacedAssignees: input.plan.unplaced.map((entry) => ({
      kind: entry.kind,
      sketchId: entry.sketchId,
      assignee: entry.assignee,
      ...(entry.kind === 'no-node' ? { larkAppId: entry.larkAppId } : {}),
    })),
    sideEffects: computeSavedWorkflowSideEffects(template),
    gateDigest: computeSavedWorkflowGateDigest(template),
  });
}

/** The exact bytes the digest is taken over. */
export function canonicalV3FlowSummary(summary: V3FlowSummary): string {
  return canonicalJsonStringify(normalizeV3FlowSummary(summary));
}

export function v3FlowSummarySha256(summary: V3FlowSummary): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalV3FlowSummary(summary)).digest('hex')}`;
}
