/**
 * Saved Workflow library schema.
 *
 * A saved workflow is deliberately separate from a v3 run:
 *   - metadata.json is the small mutable index (name/scope/pointers/status)
 *   - revisions/<revisionId>.json is immutable and content addressed
 *
 * This module has no dependency on the legacy workflow definition/runtime.
 * It only reuses the v3 DAG/spec validators, then removes the run-specific
 * `runId` from the persisted template shape.
 */

import { createHash, randomUUID } from 'node:crypto';

import { canonicalJsonStringify } from '../../utils/canonical-json.js';
import type { V3Node } from './dag.js';
import { DagValidationError, isGoalNode, isLoopNode, validateDag } from './dag.js';
import type { Spec } from './contract.js';
import { SpecValidationError, validateSpec } from './spec.js';
import { assertSavedWorkflowTemplateBindings } from './template-bindings.js';
import { V3FlowSummarySchema, v3FlowSummarySha256, type V3FlowSummary } from './flow-summary.js';

// Compatibility export for callers that historically imported the encoder
// from the Saved Workflow schema module.
export { canonicalJsonStringify } from '../../utils/canonical-json.js';

export const SAVED_WORKFLOW_METADATA_SCHEMA_VERSION = 1 as const;
/**
 * The newest revision schema this reader understands (design 2026-11-03
 * workflow-dashboard-orchestration §5.1, D5).
 *
 *   v1  legacy selector-based templates (read-migrated to v2, bytes kept);
 *   v2  stable outputs; every Feishu `/workflow save` / distillation write;
 *   v3  v2 + `provenance`: where a Dashboard save came from — the run it was
 *       saved from (with the nodes whose bot differs from the approved flow),
 *       or the draft whose second confirmation it carries (who, when, the
 *       flow summary). Not derivable from the DAG, so never in `gateDigest`.
 *
 * A revision is written at the lowest schema that can hold it
 * ({@link savedWorkflowRevisionSchemaVersionFor}): without provenance it is
 * byte-identical v2, so the Feishu entries and older daemons are untouched;
 * with provenance it is v3, which an older daemon refuses to read ("newer than
 * supported") instead of silently dropping the confirmation.
 */
export const SAVED_WORKFLOW_REVISION_SCHEMA_VERSION = 3 as const;
/** Lowest schema new revisions are written at (v1 is read-only). */
export const SAVED_WORKFLOW_REVISION_MIN_WRITE_SCHEMA_VERSION = 2 as const;

export const SAVED_WORKFLOW_ID_RE = /^wf_[0-9a-f]{32}$/;
export const SAVED_WORKFLOW_REVISION_ID_RE = /^rev_[0-9a-f]{64}$/;
export const SAVED_WORKFLOW_CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
export const SAVED_WORKFLOW_PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_SAVED_WORKFLOW_PARAM_NAMES = new Set([
  '__proto__', 'prototype', 'constructor',
]);

const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_ALIAS_LENGTH = 128;
const MAX_PARAMS = 128;

export type SavedWorkflowScope =
  | { kind: 'chat'; chatId: string }
  /** Visible across chats owned by the same Lark app/bot, never across apps. */
  | { kind: 'global' };

/** open_id is app-scoped, so ownership must retain the app it came from. */
export interface SavedWorkflowOwner {
  openId: string;
  larkAppId: string;
}

export type SavedWorkflowStatus = 'draft' | 'active' | 'archived';

export interface SavedWorkflowMetadata {
  schemaVersion: typeof SAVED_WORKFLOW_METADATA_SCHEMA_VERSION;
  workflowId: string;
  /** User-facing Unicode name. It is never used as a path segment. */
  displayName: string;
  aliases: string[];
  owner: SavedWorkflowOwner;
  scope: SavedWorkflowScope;
  status: SavedWorkflowStatus;
  /** Newest immutable revision, published or not. */
  latestRevision: string;
  /** Revision that `run` uses. Missing means this workflow is draft-only. */
  publishedRevision?: string;
  createdAt: string;
  updatedAt: string;
}

export type SavedWorkflowParamType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface SavedWorkflowParamDef {
  type: SavedWorkflowParamType;
  required?: boolean;
  default?: unknown;
  description?: string;
  /** Sensitive inputs may be supplied at run time but never have a stored default. */
  sensitive?: boolean;
}

export type SavedWorkflowBuiltinContextRef =
  | 'chatId'
  | 'larkAppId'
  | 'chatType'
  | 'rootMessageId'
  | 'initiatorOpenId';

export interface V3DagTemplate {
  /** Missing/1 is a legacy selector-based template; new revisions require 2. */
  schemaVersion?: 1 | 2;
  nodes: V3Node[];
}

export type V3SpecTemplate = Omit<Spec, 'runId'>;

export interface SavedWorkflowSafety {
  /** Hash of the normalized human gates, protecting against silent gate weakening. */
  gateDigest: string;
  sideEffects: Array<{ nodeId: string; kind: string }>;
}

export interface SavedWorkflowChatSideEffectProblem {
  nodeId: string;
  path: string;
  kind: string;
  guidance: string;
}

/** A node whose executing bot in the saved definition differs from the flow
 *  the source run was approved with (E10). `reassigned`: 受阻卡改派;
 *  `revised`: an applied runtime revision changed it; `added` / `removed`: the
 *  node exists on one side only. */
export interface SavedWorkflowBotChange {
  nodeId: string;
  approvedLarkAppId?: string;
  savedLarkAppId?: string;
  cause: 'reassigned' | 'revised' | 'added' | 'removed';
}

/** The second confirmation a draft-born revision carries (§5.1): the person
 *  who confirmed the flow summary shown when saving, when, and that summary
 *  (normalized content + sha256, flow-summary.ts). */
export interface SavedWorkflowDraftConfirmation {
  confirmedByOpenId: string;
  confirmedAt: string;
  /** The draft's own 「确认流程」 that this save re-confirmed. */
  flowConfirmedAt: string;
  flowSummary: V3FlowSummary;
  flowSummarySha256: string;
}

/** Optional on both kinds: sha256 of the Dashboard save request (owner,
 *  workflow, request key), so a retried append finds the version it already
 *  wrote instead of failing on the moved latest pointer. */
export type SavedWorkflowRevisionProvenance =
  | {
      kind: 'dashboard_run';
      requestId?: string;
      runId: string;
      /** Applied runtime revisions of the source run (§13.8). */
      runtimeRevisions: number;
      botChanges: SavedWorkflowBotChange[];
    }
  | {
      kind: 'dashboard_draft';
      requestId?: string;
      draftRunId: string;
      confirmation: SavedWorkflowDraftConfirmation;
    };

export interface SavedWorkflowRevisionPayloadV1 {
  workflowId: string;
  humanVersion: number;
  createdAt: string;
  createdBy: SavedWorkflowOwner;
  sourceRunId?: string;
  inputs: Record<string, SavedWorkflowParamDef>;
  contextRefs: SavedWorkflowBuiltinContextRef[];
  specTemplate: V3SpecTemplate;
  /** DAG is execution truth; this flag makes documentation drift explicit. */
  specStatus: 'current' | 'stale';
  dagTemplate: V3DagTemplate;
  safety: SavedWorkflowSafety;
  /** v3 only (absent in every v1/v2 revision). */
  provenance?: SavedWorkflowRevisionProvenance;
}

/** Fields supplied by a save compiler; identity/version/provenance are allocated by the store. */
export type SavedWorkflowRevisionDraft = Omit<
  SavedWorkflowRevisionPayloadV1,
  'workflowId' | 'humanVersion' | 'createdAt' | 'createdBy'
>;

export interface StoredSavedWorkflowRevision {
  schemaVersion: number;
  revisionId: string;
  contentHash: string;
  payload: unknown;
}

export interface LoadedSavedWorkflowRevision {
  revisionId: string;
  contentHash: string;
  storedSchemaVersion: number;
  /** The schema the payload is read at: v1 is migrated to 2; v2 and v3 are
   *  read as stored. */
  schemaVersion: 2 | 3;
  payload: SavedWorkflowRevisionPayloadV1;
  migrated: boolean;
}

export class SavedWorkflowSchemaError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid saved workflow:\n  - ${problems.join('\n  - ')}`);
    this.name = 'SavedWorkflowSchemaError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, where: string, problems: string[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${where} must be a non-empty string`);
    return '';
  }
  return value.trim();
}

function validIso(value: unknown, where: string, problems: string[]): string {
  const s = nonEmptyString(value, where, problems);
  if (s && !Number.isFinite(Date.parse(s))) problems.push(`${where} must be an ISO timestamp`);
  return s;
}

function normalizeOwner(value: unknown, where: string, problems: string[]): SavedWorkflowOwner {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return { openId: '', larkAppId: '' };
  }
  return {
    openId: nonEmptyString(value.openId, `${where}.openId`, problems),
    larkAppId: nonEmptyString(value.larkAppId, `${where}.larkAppId`, problems),
  };
}

function normalizeScope(value: unknown, problems: string[]): SavedWorkflowScope {
  if (!isRecord(value)) {
    problems.push('scope must be an object');
    return { kind: 'global' };
  }
  if (value.kind === 'global') return { kind: 'global' };
  if (value.kind === 'chat') {
    return { chatId: nonEmptyString(value.chatId, 'scope.chatId', problems), kind: 'chat' };
  }
  problems.push('scope.kind must be chat or global');
  return { kind: 'global' };
}

function normalizeName(value: unknown, where: string, max: number, problems: string[]): string {
  const out = nonEmptyString(value, where, problems).normalize('NFC');
  if (out.length > max) problems.push(`${where} must be at most ${max} characters`);
  return out;
}

export function validateSavedWorkflowMetadata(raw: unknown): SavedWorkflowMetadata {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new SavedWorkflowSchemaError(['metadata root must be an object']);

  if (raw.schemaVersion !== SAVED_WORKFLOW_METADATA_SCHEMA_VERSION) {
    problems.push(`metadata.schemaVersion must be ${SAVED_WORKFLOW_METADATA_SCHEMA_VERSION}`);
  }
  const workflowId = typeof raw.workflowId === 'string' ? raw.workflowId : '';
  if (!SAVED_WORKFLOW_ID_RE.test(workflowId)) problems.push('workflowId must match wf_<32 lowercase hex>');

  const displayName = normalizeName(raw.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH, problems);
  const aliases: string[] = [];
  if (!Array.isArray(raw.aliases)) {
    problems.push('aliases must be an array');
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < raw.aliases.length; i++) {
      const alias = normalizeName(raw.aliases[i], `aliases[${i}]`, MAX_ALIAS_LENGTH, problems);
      const key = normalizeSavedWorkflowLookupKey(alias);
      if (key && seen.has(key)) problems.push(`aliases contains duplicate ${JSON.stringify(alias)}`);
      if (key) seen.add(key);
      aliases.push(alias);
    }
  }

  const owner = normalizeOwner(raw.owner, 'owner', problems);
  const scope = normalizeScope(raw.scope, problems);
  const statuses: SavedWorkflowStatus[] = ['draft', 'active', 'archived'];
  const status = statuses.includes(raw.status as SavedWorkflowStatus)
    ? raw.status as SavedWorkflowStatus
    : 'draft';
  if (!statuses.includes(raw.status as SavedWorkflowStatus)) {
    problems.push('status must be draft, active, or archived');
  }

  const latestRevision = typeof raw.latestRevision === 'string' ? raw.latestRevision : '';
  if (!SAVED_WORKFLOW_REVISION_ID_RE.test(latestRevision)) {
    problems.push('latestRevision must match rev_<64 lowercase hex>');
  }
  let publishedRevision: string | undefined;
  if (raw.publishedRevision !== undefined) {
    if (typeof raw.publishedRevision !== 'string' || !SAVED_WORKFLOW_REVISION_ID_RE.test(raw.publishedRevision)) {
      problems.push('publishedRevision must match rev_<64 lowercase hex>');
    } else {
      publishedRevision = raw.publishedRevision;
    }
  }
  if (status === 'active' && !publishedRevision) {
    problems.push('active workflow must have publishedRevision');
  }
  if (status === 'draft' && publishedRevision) {
    problems.push('draft workflow cannot have publishedRevision');
  }

  const createdAt = validIso(raw.createdAt, 'createdAt', problems);
  const updatedAt = validIso(raw.updatedAt, 'updatedAt', problems);
  if (createdAt && updatedAt && Date.parse(updatedAt) < Date.parse(createdAt)) {
    problems.push('updatedAt cannot be earlier than createdAt');
  }

  if (problems.length > 0) throw new SavedWorkflowSchemaError(problems);
  return {
    schemaVersion: SAVED_WORKFLOW_METADATA_SCHEMA_VERSION,
    workflowId,
    displayName,
    aliases,
    owner,
    scope,
    status,
    latestRevision,
    ...(publishedRevision ? { publishedRevision } : {}),
    createdAt,
    updatedAt,
  };
}

export function mintSavedWorkflowId(uuid: string = randomUUID()): string {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('workflow UUID must contain exactly 32 hexadecimal characters');
  return `wf_${hex}`;
}

/** Lookup normalization affects discovery only; the original Unicode value is preserved. */
export function normalizeSavedWorkflowLookupKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function isJsonValue(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
}

function defaultMatchesType(type: SavedWorkflowParamType, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value) && isJsonValue(value);
    case 'object': return isRecord(value) && isJsonValue(value);
  }
}

function normalizeInputs(value: unknown, problems: string[]): Record<string, SavedWorkflowParamDef> {
  if (!isRecord(value)) {
    problems.push('inputs must be an object');
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAMS) problems.push(`inputs may contain at most ${MAX_PARAMS} parameters`);
  const out: Record<string, SavedWorkflowParamDef> = {};
  for (const [name, rawDef] of entries) {
    if (!isValidSavedWorkflowParamName(name)) {
      problems.push(
        `input name ${JSON.stringify(name)} must match ${SAVED_WORKFLOW_PARAM_NAME_RE} ` +
        'and must not be __proto__/prototype/constructor',
      );
    }
    if (!isRecord(rawDef)) {
      problems.push(`inputs.${name} must be an object`);
      continue;
    }
    const allowed = new Set(['type', 'required', 'default', 'description', 'sensitive']);
    for (const key of Object.keys(rawDef)) {
      if (!allowed.has(key)) problems.push(`inputs.${name}.${key} is not supported`);
    }
    const types: SavedWorkflowParamType[] = ['string', 'number', 'boolean', 'object', 'array'];
    const type = types.includes(rawDef.type as SavedWorkflowParamType)
      ? rawDef.type as SavedWorkflowParamType
      : 'string';
    if (!types.includes(rawDef.type as SavedWorkflowParamType)) {
      problems.push(`inputs.${name}.type must be string, number, boolean, object, or array`);
    }
    if (rawDef.required !== undefined && typeof rawDef.required !== 'boolean') {
      problems.push(`inputs.${name}.required must be boolean`);
    }
    if (rawDef.sensitive !== undefined && typeof rawDef.sensitive !== 'boolean') {
      problems.push(`inputs.${name}.sensitive must be boolean`);
    }
    if (rawDef.description !== undefined && typeof rawDef.description !== 'string') {
      problems.push(`inputs.${name}.description must be string`);
    }
    const hasDefault = Object.prototype.hasOwnProperty.call(rawDef, 'default');
    if (hasDefault && !defaultMatchesType(type, rawDef.default)) {
      problems.push(`inputs.${name}.default must match declared type ${type} and be finite JSON`);
    }
    if (rawDef.sensitive === true && hasDefault) {
      problems.push(`inputs.${name} is sensitive and cannot have a default`);
    }
    out[name] = {
      type,
      ...(rawDef.required === true ? { required: true } : {}),
      ...(hasDefault ? { default: rawDef.default } : {}),
      ...(typeof rawDef.description === 'string' ? { description: rawDef.description } : {}),
      ...(rawDef.sensitive === true ? { sensitive: true } : {}),
    };
  }
  return out;
}

/** Shared by host-owned compilers before they construct an input definition. */
export function isValidSavedWorkflowParamName(name: string): boolean {
  return SAVED_WORKFLOW_PARAM_NAME_RE.test(name) &&
    !FORBIDDEN_SAVED_WORKFLOW_PARAM_NAMES.has(name);
}

const BUILTIN_CONTEXT_REFS: readonly SavedWorkflowBuiltinContextRef[] = [
  'chatId', 'larkAppId', 'chatType', 'rootMessageId', 'initiatorOpenId',
];

function normalizeContextRefs(value: unknown, problems: string[]): SavedWorkflowBuiltinContextRef[] {
  if (!Array.isArray(value)) {
    problems.push('contextRefs must be an array');
    return [];
  }
  const out: SavedWorkflowBuiltinContextRef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'string' || !BUILTIN_CONTEXT_REFS.includes(item as SavedWorkflowBuiltinContextRef)) {
      problems.push(`contextRefs[${i}] is not a supported built-in context ref`);
      continue;
    }
    if (seen.has(item)) problems.push(`contextRefs contains duplicate ${item}`);
    seen.add(item);
    out.push(item as SavedWorkflowBuiltinContextRef);
  }
  return out;
}

export function validateDagTemplate(raw: unknown): V3DagTemplate {
  if (!isRecord(raw)) throw new SavedWorkflowSchemaError(['dagTemplate must be an object']);
  if (Object.prototype.hasOwnProperty.call(raw, 'runId')) {
    throw new SavedWorkflowSchemaError(['dagTemplate must not contain runId']);
  }
  let nodes: V3Node[];
  try {
    nodes = validateDag({
      ...(raw.schemaVersion !== undefined ? { schemaVersion: raw.schemaVersion } : {}),
      runId: 'saved-template',
      nodes: raw.nodes,
    }).nodes;
  } catch (err) {
    if (err instanceof DagValidationError) throw new SavedWorkflowSchemaError(err.problems.map((p) => `dagTemplate: ${p}`));
    throw err;
  }
  const botProblems: string[] = [];
  validateDirectBotSelectors(nodes, undefined, 'dagTemplate.nodes', botProblems);
  if (botProblems.length > 0) throw new SavedWorkflowSchemaError(botProblems);
  // NOTE: the chat-facing side-effect policy lint is deliberately NOT run here.
  // validateDagTemplate is the structural deserializer shared by the READ path
  // (loadSavedWorkflowRevision → validateSavedWorkflowRevisionPayload), so
  // gating it would retroactively brick already-saved revisions that were legal
  // before the lint existed. The policy check runs only at authoring boundaries:
  // validateSavedWorkflowRevisionDraft and v2 migration throw via
  // assertNoSavedWorkflowChatSideEffects, while exact save
  // (buildSavedWorkflowRevisionBaseline) surfaces the same findings as
  // lintWarnings for an explicit --ack-unsafe acknowledgement.
  return {
    ...(raw.schemaVersion !== undefined ? { schemaVersion: raw.schemaVersion as 1 | 2 } : {}),
    nodes,
  };
}

function validateDirectBotSelectors(
  nodes: V3Node[],
  inheritedBot: string | undefined,
  where: string,
  problems: string[],
): void {
  for (const node of nodes) {
    const effectiveBot = typeof node.bot === 'string' && node.bot.trim() ? node.bot.trim() : inheritedBot;
    if (node.type === 'goal' && !effectiveBot) {
      problems.push(`${where}.${node.id} must declare a direct bot selector`);
    }
    if (node.type === 'loop' && node.body) {
      validateDirectBotSelectors(node.body.nodes, effectiveBot, `${where}.${node.id}.body`, problems);
    }
  }
}

export function validateSpecTemplate(raw: unknown): V3SpecTemplate {
  if (!isRecord(raw)) throw new SavedWorkflowSchemaError(['specTemplate must be an object']);
  if (Object.prototype.hasOwnProperty.call(raw, 'runId')) {
    throw new SavedWorkflowSchemaError(['specTemplate must not contain runId']);
  }
  try {
    const spec = validateSpec({ ...raw, runId: 'saved-template' });
    const { runId: _runId, ...template } = spec;
    return template;
  } catch (err) {
    if (err instanceof SpecValidationError) throw new SavedWorkflowSchemaError(err.problems.map((p) => `specTemplate: ${p}`));
    throw err;
  }
}

function gateProjection(nodes: V3Node[], prefix = ''): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes) {
    const id = prefix ? `${prefix}.${node.id}` : node.id;
    if (node.humanGate) out.push({ id, humanGate: node.humanGate });
    if (node.type === 'loop' && node.body) out.push(...gateProjection(node.body.nodes, id));
  }
  return out;
}

/** One human gate of a template: its position (`<node>` or `<loop>.<body>`)
 *  and its approval rule — the facts `gateDigest` is taken over. */
export interface SavedWorkflowGatePosition {
  nodeId: string;
  humanGate: unknown;
}

export function savedWorkflowGatePositions(dagTemplate: V3DagTemplate): SavedWorkflowGatePosition[] {
  return (gateProjection(dagTemplate.nodes) as Array<{ id: string; humanGate: unknown }>)
    .map((gate) => ({ nodeId: gate.id, humanGate: gate.humanGate }));
}

/**
 * Human gates of a revision against an earlier one (I10): how many, where,
 * and how loose. `removed` are positions the earlier revision gated and this
 * one does not — what 「少了 N 道人工确认」 counts (N = removed.length); a
 * gate that moved is one removed plus one added.
 * `loosened`: the same position where approval got easier —
 *   - `approvers_cleared`: named approvers → none (anyone who can operate the
 *     bot may approve);
 *   - `approvers_added`: someone added to a non-empty list;
 *   - `approve_options_added`: more of the card's options count as approval.
 * Warned at the same level as a removed gate. Removing a named approver, or
 * naming approvers where anyone could approve, narrows: only `changed`.
 * Approvers and approve options compare as sets (order is no change, as in
 * dag-revision). `changed`: any other change of the gate.
 */
export interface SavedWorkflowGateComparison {
  previousCount: number;
  currentCount: number;
  removed: string[];
  added: string[];
  loosened: Array<{ nodeId: string; reason: 'approvers_cleared' | 'approvers_added' | 'approve_options_added'; items: string[] }>;
  changed: string[];
}

function gateList(gate: unknown, key: 'approvers' | 'approveOptions'): string[] {
  const list = (gate as Record<string, unknown> | null)?.[key];
  return Array.isArray(list) ? [...new Set(list.filter((item): item is string => typeof item === 'string'))].sort() : [];
}

/** The gate as compared: approver / approve-option order carries no meaning. */
function comparableGate(gate: unknown): unknown {
  if (!gate || typeof gate !== 'object') return gate;
  const record = gate as Record<string, unknown>;
  return {
    ...record,
    ...(Array.isArray(record.approvers) ? { approvers: gateList(gate, 'approvers') } : {}),
    ...(Array.isArray(record.approveOptions) ? { approveOptions: gateList(gate, 'approveOptions') } : {}),
  };
}

export function compareSavedWorkflowGates(previous: V3DagTemplate, current: V3DagTemplate): SavedWorkflowGateComparison {
  const before = new Map(savedWorkflowGatePositions(previous).map((gate) => [gate.nodeId, gate.humanGate]));
  const after = new Map(savedWorkflowGatePositions(current).map((gate) => [gate.nodeId, gate.humanGate]));
  const loosened: SavedWorkflowGateComparison['loosened'] = [];
  const changed: string[] = [];
  for (const [nodeId, gate] of after) {
    if (!before.has(nodeId)) continue;
    const prior = before.get(nodeId);
    let looser = false;
    // Empty = anyone who can operate the bot; a list allows only those named.
    const was = gateList(prior, 'approvers');
    const now = gateList(gate, 'approvers');
    const addedApprovers = now.filter((approver) => !was.includes(approver));
    if (was.length > 0 && now.length === 0) {
      loosened.push({ nodeId, reason: 'approvers_cleared', items: was });
      looser = true;
    } else if (was.length > 0 && addedApprovers.length > 0) {
      loosened.push({ nodeId, reason: 'approvers_added', items: addedApprovers });
      looser = true;
    }
    const wasApprove = gateList(prior, 'approveOptions');
    const addedApprove = gateList(gate, 'approveOptions').filter((option) => !wasApprove.includes(option));
    if (addedApprove.length > 0) {
      loosened.push({ nodeId, reason: 'approve_options_added', items: addedApprove });
      looser = true;
    }
    if (!looser && canonicalJsonStringify(comparableGate(prior)) !== canonicalJsonStringify(comparableGate(gate))) changed.push(nodeId);
  }
  return {
    previousCount: before.size,
    currentCount: after.size,
    removed: [...before.keys()].filter((id) => !after.has(id)),
    added: [...after.keys()].filter((id) => !before.has(id)),
    loosened,
    changed,
  };
}

/** A comparison against one earlier version, named (I10: shown together). */
export interface SavedWorkflowGateComparisonAgainst {
  base: { kind: 'previous' | 'published'; humanVersion: number; revisionId: string };
  gates: SavedWorkflowGateComparison;
}

const CHAT_SIDE_EFFECT_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'botmux-send', re: /\bbotmux\s+(?:send|reply)\b/i },
  { kind: 'bytedcli-feishu', re: /\bbytedcli\s+feishu\b.*?\b(?:send|reply|message|im|chat)\b(?:[ \t]+(?:send|reply|message|im|chat)\b)*/i },
  { kind: 'lark-cli-im', re: /\blark-cli\b.*?\b(?:send|reply|message|im|chat)\b(?:[ \t]+(?:send|reply|message|im|chat)\b)*/i },
  { kind: 'feishu-openapi-message', re: /\/open-apis\/im\/v1\/(?:messages|chats)\b/i },
  { kind: 'feishu-openapi-message', re: /\b(?:feishu|lark)\b.*?\bopenapi\b.*?\b(?:send|reply|message)\b/i },
  { kind: 'feishu-openapi-message', re: /\bim\.v1\.message\.(?:create|reply|patch)\b/i },
];

function collectStrings(value: unknown, path: string, out: Array<{ path: string; value: string }>): void {
  if (typeof value === 'string') {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(child, `${path}.${key}`, out);
    }
  }
}

function findAffirmativeChatSideEffect(text: string): string | undefined {
  const commands = CHAT_SIDE_EFFECT_PATTERNS.flatMap(({ kind, re }) =>
    [...text.matchAll(new RegExp(`(?=(${re.source}))`, `${re.flags}g`))].map((match) => ({
      start: match.index,
      end: match.index + match[1]!.length,
      kind,
    })))
    .sort((a, b) => a.start - b.start || b.end - a.end)
    // A broad CLI pattern must not swallow a separately named command.
    .filter((command, index, matches) => command.end <= (matches[index + 1]?.start ?? Infinity));
  let previousEnd: number | undefined;
  for (const command of commands) {
    const prefix = text.slice(previousEnd ?? 0, command.start);
    // Only bare list connectors inherit a preceding command's prohibition.
    const continuesList = previousEnd !== undefined &&
      /^[ \t`"'“”‘’]*(?:(?:\/|、|和|或(?:者)?|以及|与|\b(?:and|or)\b)[ \t`"'“”‘’]*)+$/i.test(prefix);
    // Command spans are excluded; keep word-internal slashes and decimal points intact.
    const clausePrefix = prefix
      .split(/(?<!\d)\.|\.(?!\d)|[。；;，,\r\n!?！？]|(?<![A-Za-z0-9])\/|\/(?![A-Za-z0-9])|但是|但|然而|\b(?:but|however)\b/i).at(-1)!;
    if (!continuesList && !/(?:不要|禁止|不得|严禁|勿|\b(?:never|do\s+not|don['’]t|no)\b)/i.test(clausePrefix)) {
      return command.kind;
    }
    previousEnd = command.end;
  }
  return undefined;
}

function pushChatSideEffectProblems(
  node: V3Node,
  nodeId: string,
  where: string,
  problems: SavedWorkflowChatSideEffectProblem[],
): void {
  const strings: Array<{ path: string; value: string }> = [];
  collectStrings(
    {
      goal: node.goal,
      humanGate: node.humanGate,
      override: node.override,
    },
    where,
    strings,
  );
  for (const item of strings) {
    const kind = findAffirmativeChatSideEffect(item.value);
    if (!kind) continue;
    problems.push({
      nodeId,
      path: item.path,
      kind,
      guidance:
        `Move chat notification out of goal node "${nodeId}": split it into ` +
        'businessTask (write result.json/final_message.md) plus a hostExecutor ' +
        'feishu-send/feishu-reply node that reads the upstream result.',
    });
  }
}

export function collectSavedWorkflowChatSideEffectProblems(
  dagTemplate: V3DagTemplate,
): SavedWorkflowChatSideEffectProblem[] {
  const problems: SavedWorkflowChatSideEffectProblem[] = [];
  const visit = (nodes: V3Node[], prefix: string): void => {
    for (const node of nodes) {
      const nodeId = prefix ? `${prefix}.${node.id}` : node.id;
      if (isGoalNode(node)) {
        pushChatSideEffectProblems(
          node,
          nodeId,
          prefix ? `dagTemplate.nodes.${prefix}.${node.id}` : `dagTemplate.nodes.${node.id}`,
          problems,
        );
      } else if (isLoopNode(node)) {
        visit(node.body.nodes, nodeId);
      }
    }
  };
  visit(dagTemplate.nodes, '');
  return problems;
}

export function formatSavedWorkflowChatSideEffectProblems(
  problems: readonly SavedWorkflowChatSideEffectProblem[],
): string[] {
  return problems.map((problem) =>
    `${problem.path} contains chat-facing side effect (${problem.kind}); ${problem.guidance}`);
}

/**
 * Authoring-boundary policy gate. Throw when a to-be-saved DAG template has a
 * chat-facing side effect in a goal node. This is intentionally NOT part of the
 * structural deserializer (validateDagTemplate) or the read path
 * (validateSavedWorkflowRevisionPayload): those are traversed when LOADING an
 * already-saved revision, and gating them would retroactively brick revisions
 * that were legal before the lint existed. Callers on the write/compile/publish
 * side (validateSavedWorkflowRevisionDraft, v2→v3 migration) invoke this so a
 * fresh authored definition must be lint-clean, while old revisions stay
 * loadable/show-able/appendable (and can be fixed by appending a clean
 * revision). Exact save (buildSavedWorkflowRevisionBaseline) does not throw:
 * it reports the same findings as lintWarnings so the user can acknowledge
 * them explicitly with --ack-unsafe.
 */
export function assertNoSavedWorkflowChatSideEffects(dagTemplate: V3DagTemplate): void {
  const chatEffects = formatSavedWorkflowChatSideEffectProblems(
    collectSavedWorkflowChatSideEffectProblems(dagTemplate),
  );
  if (chatEffects.length > 0) throw new SavedWorkflowSchemaError(chatEffects);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function computeSavedWorkflowGateDigest(dagTemplate: V3DagTemplate): string {
  return `sha256:${sha256(canonicalJsonStringify(gateProjection(dagTemplate.nodes)))}`;
}

export function computeSavedWorkflowSideEffects(
  dagTemplate: V3DagTemplate,
): Array<{ nodeId: string; kind: string }> {
  return dagTemplate.nodes
    .filter((node) => node.type === 'host')
    .map((node) => ({ nodeId: node.id, kind: node.executor! }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.kind.localeCompare(right.kind));
}

function normalizeSafety(value: unknown, dagTemplate: V3DagTemplate, problems: string[]): SavedWorkflowSafety {
  if (!isRecord(value)) {
    problems.push('safety must be an object');
    return { gateDigest: computeSavedWorkflowGateDigest(dagTemplate), sideEffects: [] };
  }
  const gateDigest = typeof value.gateDigest === 'string' ? value.gateDigest : '';
  if (!SAVED_WORKFLOW_CONTENT_HASH_RE.test(gateDigest)) {
    problems.push('safety.gateDigest must match sha256:<64 lowercase hex>');
  }
  const expectedGateDigest = computeSavedWorkflowGateDigest(dagTemplate);
  if (gateDigest && gateDigest !== expectedGateDigest) {
    problems.push(`safety.gateDigest does not match dagTemplate gates (expected ${expectedGateDigest})`);
  }
  const sideEffects: Array<{ nodeId: string; kind: string }> = [];
  if (!Array.isArray(value.sideEffects)) {
    problems.push('safety.sideEffects must be an array');
  } else {
    for (let i = 0; i < value.sideEffects.length; i++) {
      const item = value.sideEffects[i];
      if (!isRecord(item)) {
        problems.push(`safety.sideEffects[${i}] must be an object`);
        continue;
      }
      sideEffects.push({
        nodeId: nonEmptyString(item.nodeId, `safety.sideEffects[${i}].nodeId`, problems),
        kind: nonEmptyString(item.kind, `safety.sideEffects[${i}].kind`, problems),
      });
    }
  }
  const expectedSideEffects = computeSavedWorkflowSideEffects(dagTemplate);
  const normalizedSideEffects = [...sideEffects]
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.kind.localeCompare(right.kind));
  if (canonicalJsonStringify(normalizedSideEffects) !== canonicalJsonStringify(expectedSideEffects)) {
    problems.push(
      `safety.sideEffects does not match host nodes (expected ${canonicalJsonStringify(expectedSideEffects)})`,
    );
  }
  return { gateDigest, sideEffects: normalizedSideEffects };
}

const BOT_CHANGE_CAUSES: ReadonlyArray<SavedWorkflowBotChange['cause']> = ['reassigned', 'revised', 'added', 'removed'];

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string, problems: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${where}.${key} is not supported`);
  }
}

/** The executing bot each goal node (incl. loop bodies, `<loop>.<body>`)
 *  names, as the flow summary's node rows key them. */
export function savedWorkflowGoalNodeBots(nodes: readonly V3Node[], prefix = '', inherited?: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const node of nodes) {
    const id = prefix ? `${prefix}.${node.id}` : node.id;
    const bot = typeof node.bot === 'string' && node.bot.trim() ? node.bot.trim() : inherited;
    if (isGoalNode(node)) out.set(id, bot);
    if (isLoopNode(node) && node.body) {
      for (const [childId, childBot] of savedWorkflowGoalNodeBots(node.body.nodes, id, bot)) out.set(childId, childBot);
    }
  }
  return out;
}

function provenanceRequestId(value: Record<string, unknown>, problems: string[]): string | undefined {
  if (value.requestId === undefined) return undefined;
  if (typeof value.requestId !== 'string' || !SAVED_WORKFLOW_CONTENT_HASH_RE.test(value.requestId)) {
    problems.push('provenance.requestId must match sha256:<64 lowercase hex>');
    return undefined;
  }
  return value.requestId;
}

function normalizeProvenance(
  value: unknown,
  ctx: { createdBy: SavedWorkflowOwner; sourceRunId?: string; dagTemplate?: V3DagTemplate },
  problems: string[],
): SavedWorkflowRevisionProvenance | undefined {
  if (!isRecord(value)) {
    problems.push('provenance must be an object');
    return undefined;
  }
  if (value.kind === 'dashboard_run') {
    exactKeys(value, ['kind', 'requestId', 'runId', 'runtimeRevisions', 'botChanges'], 'provenance', problems);
    const requestId = provenanceRequestId(value, problems);
    const runId = nonEmptyString(value.runId, 'provenance.runId', problems);
    if (runId && ctx.sourceRunId !== runId) problems.push('provenance.runId must equal sourceRunId');
    const runtimeRevisions = value.runtimeRevisions;
    if (!Number.isInteger(runtimeRevisions) || (runtimeRevisions as number) < 0) {
      problems.push('provenance.runtimeRevisions must be a non-negative integer');
    }
    const botChanges: SavedWorkflowBotChange[] = [];
    if (!Array.isArray(value.botChanges)) {
      problems.push('provenance.botChanges must be an array');
    } else {
      const seen = new Set<string>();
      value.botChanges.forEach((item, index) => {
        const where = `provenance.botChanges[${index}]`;
        if (!isRecord(item)) {
          problems.push(`${where} must be an object`);
          return;
        }
        exactKeys(item, ['nodeId', 'approvedLarkAppId', 'savedLarkAppId', 'cause'], where, problems);
        const nodeId = nonEmptyString(item.nodeId, `${where}.nodeId`, problems);
        if (nodeId && seen.has(nodeId)) problems.push(`${where}.nodeId duplicates ${nodeId}`);
        seen.add(nodeId);
        if (!BOT_CHANGE_CAUSES.includes(item.cause as SavedWorkflowBotChange['cause'])) {
          problems.push(`${where}.cause must be ${BOT_CHANGE_CAUSES.join(', ')}`);
        }
        const approved = item.approvedLarkAppId === undefined ? undefined : nonEmptyString(item.approvedLarkAppId, `${where}.approvedLarkAppId`, problems);
        const saved = item.savedLarkAppId === undefined ? undefined : nonEmptyString(item.savedLarkAppId, `${where}.savedLarkAppId`, problems);
        if (!approved && !saved) problems.push(`${where} must name the approved or the saved bot`);
        if (approved && saved && approved === saved) problems.push(`${where} names the same bot on both sides`);
        botChanges.push({
          nodeId,
          ...(approved ? { approvedLarkAppId: approved } : {}),
          ...(saved ? { savedLarkAppId: saved } : {}),
          cause: item.cause as SavedWorkflowBotChange['cause'],
        });
      });
    }
    if (ctx.dagTemplate) {
      const bots = savedWorkflowGoalNodeBots(ctx.dagTemplate.nodes);
      for (const change of botChanges) {
        if (change.savedLarkAppId !== undefined && bots.get(change.nodeId) !== change.savedLarkAppId) {
          problems.push(`provenance.botChanges ${change.nodeId}: savedLarkAppId does not match dagTemplate`);
        }
      }
    }
    return {
      kind: 'dashboard_run',
      ...(requestId ? { requestId } : {}),
      runId,
      runtimeRevisions: runtimeRevisions as number,
      botChanges: botChanges.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)),
    };
  }
  if (value.kind === 'dashboard_draft') {
    exactKeys(value, ['kind', 'requestId', 'draftRunId', 'confirmation'], 'provenance', problems);
    const requestId = provenanceRequestId(value, problems);
    const draftRunId = nonEmptyString(value.draftRunId, 'provenance.draftRunId', problems);
    if (ctx.sourceRunId !== undefined) problems.push('a draft-born revision has no sourceRunId');
    const confirmation = value.confirmation;
    if (!isRecord(confirmation)) {
      problems.push('provenance.confirmation must be an object');
      return undefined;
    }
    exactKeys(confirmation, ['confirmedByOpenId', 'confirmedAt', 'flowConfirmedAt', 'flowSummary', 'flowSummarySha256'], 'provenance.confirmation', problems);
    const confirmedByOpenId = nonEmptyString(confirmation.confirmedByOpenId, 'provenance.confirmation.confirmedByOpenId', problems);
    // Only the owner saves (I9): the person who re-confirmed is the creator.
    if (confirmedByOpenId && confirmedByOpenId !== ctx.createdBy.openId) {
      problems.push('provenance.confirmation.confirmedByOpenId must be the revision creator');
    }
    const confirmedAt = validIso(confirmation.confirmedAt, 'provenance.confirmation.confirmedAt', problems);
    const flowConfirmedAt = validIso(confirmation.flowConfirmedAt, 'provenance.confirmation.flowConfirmedAt', problems);
    const parsed = V3FlowSummarySchema.safeParse(confirmation.flowSummary);
    if (!parsed.success) {
      problems.push(`provenance.confirmation.flowSummary is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      return undefined;
    }
    const flowSummary = parsed.data;
    const sha = typeof confirmation.flowSummarySha256 === 'string' ? confirmation.flowSummarySha256 : '';
    if (sha !== v3FlowSummarySha256(flowSummary)) problems.push('provenance.confirmation.flowSummarySha256 does not match flowSummary');
    // The summary is what a person confirmed; it must describe THIS template:
    // the same gates, outward actions and node → bot rows.
    if (ctx.dagTemplate) {
      if (flowSummary.gateDigest !== computeSavedWorkflowGateDigest(ctx.dagTemplate)) {
        problems.push('provenance.confirmation.flowSummary gates do not match dagTemplate');
      }
      if (canonicalJsonStringify(flowSummary.sideEffects) !== canonicalJsonStringify(computeSavedWorkflowSideEffects(ctx.dagTemplate))) {
        problems.push('provenance.confirmation.flowSummary outward actions do not match dagTemplate');
      }
      const bots = savedWorkflowGoalNodeBots(ctx.dagTemplate.nodes);
      const rows = new Map(flowSummary.nodes.map((row) => [row.nodeId, row.larkAppId]));
      if (rows.size !== bots.size || [...bots].some(([nodeId, bot]) => rows.get(nodeId) !== bot)) {
        problems.push('provenance.confirmation.flowSummary node bots do not match dagTemplate');
      }
    }
    return {
      kind: 'dashboard_draft',
      ...(requestId ? { requestId } : {}),
      draftRunId,
      confirmation: { confirmedByOpenId, confirmedAt, flowConfirmedAt, flowSummary, flowSummarySha256: sha },
    };
  }
  problems.push('provenance.kind must be dashboard_run or dashboard_draft');
  return undefined;
}

/** The schema a payload is written at: the lowest that holds it. */
export function savedWorkflowRevisionSchemaVersionFor(payload: Pick<SavedWorkflowRevisionPayloadV1, 'provenance'>): 2 | 3 {
  return payload.provenance ? 3 : SAVED_WORKFLOW_REVISION_MIN_WRITE_SCHEMA_VERSION;
}

/** Revisions this writer produces (and whose canonical bytes it can rebuild). */
export function isWrittenSavedWorkflowRevisionSchema(schemaVersion: number): boolean {
  return schemaVersion >= SAVED_WORKFLOW_REVISION_MIN_WRITE_SCHEMA_VERSION
    && schemaVersion <= SAVED_WORKFLOW_REVISION_SCHEMA_VERSION;
}

export function validateSavedWorkflowRevisionPayload(raw: unknown): SavedWorkflowRevisionPayloadV1 {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new SavedWorkflowSchemaError(['revision payload must be an object']);
  const workflowId = typeof raw.workflowId === 'string' ? raw.workflowId : '';
  if (!SAVED_WORKFLOW_ID_RE.test(workflowId)) problems.push('payload.workflowId must match wf_<32 lowercase hex>');
  const humanVersion = raw.humanVersion;
  if (!Number.isInteger(humanVersion) || (humanVersion as number) < 1) {
    problems.push('payload.humanVersion must be a positive integer');
  }
  const createdAt = validIso(raw.createdAt, 'payload.createdAt', problems);
  const createdBy = normalizeOwner(raw.createdBy, 'payload.createdBy', problems);
  let sourceRunId: string | undefined;
  if (raw.sourceRunId !== undefined) {
    sourceRunId = nonEmptyString(raw.sourceRunId, 'payload.sourceRunId', problems);
  }
  const inputs = normalizeInputs(raw.inputs, problems);
  const contextRefs = normalizeContextRefs(raw.contextRefs, problems);

  let specTemplate: V3SpecTemplate | undefined;
  try { specTemplate = validateSpecTemplate(raw.specTemplate); }
  catch (err) {
    if (err instanceof SavedWorkflowSchemaError) problems.push(...err.problems);
    else throw err;
  }
  const specStatus = raw.specStatus === 'current' || raw.specStatus === 'stale'
    ? raw.specStatus
    : 'current';
  if (raw.specStatus !== 'current' && raw.specStatus !== 'stale') {
    problems.push('specStatus must be current or stale');
  }
  let dagTemplate: V3DagTemplate | undefined;
  try { dagTemplate = validateDagTemplate(raw.dagTemplate); }
  catch (err) {
    if (err instanceof SavedWorkflowSchemaError) problems.push(...err.problems);
    else throw err;
  }
  const safeDag = dagTemplate ?? { nodes: [] };
  if (dagTemplate) {
    try {
      assertSavedWorkflowTemplateBindings(dagTemplate, inputs, contextRefs);
    } catch (err) {
      problems.push(
        `dagTemplate bindings: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const safety = normalizeSafety(raw.safety, safeDag, problems);
  const provenance = raw.provenance === undefined
    ? undefined
    : normalizeProvenance(raw.provenance, { createdBy, ...(sourceRunId ? { sourceRunId } : {}), ...(dagTemplate ? { dagTemplate } : {}) }, problems);

  if (problems.length > 0 || !specTemplate || !dagTemplate) throw new SavedWorkflowSchemaError(problems);
  return {
    workflowId,
    humanVersion: humanVersion as number,
    createdAt,
    createdBy,
    ...(sourceRunId ? { sourceRunId } : {}),
    inputs,
    contextRefs,
    specTemplate,
    specStatus,
    dagTemplate,
    safety,
    ...(provenance ? { provenance } : {}),
  };
}

/**
 * Strict host-owned validation for a revision before the store allocates its
 * identity/version fields. Unknown identity fields are rejected rather than
 * allowed to override the store's authority later.
 */
export function validateSavedWorkflowRevisionDraft(raw: unknown): SavedWorkflowRevisionDraft {
  if (!isRecord(raw)) throw new SavedWorkflowSchemaError(['revision draft must be an object']);
  const allowed = new Set([
    'sourceRunId', 'inputs', 'contextRefs', 'specTemplate', 'specStatus',
    'dagTemplate', 'safety', 'provenance',
  ]);
  const extra = Object.keys(raw).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new SavedWorkflowSchemaError([
      `revision draft has unsupported key(s): ${extra.sort().join(', ')}`,
    ]);
  }
  const normalized = validateSavedWorkflowRevisionPayload({
    workflowId: 'wf_00000000000000000000000000000000',
    humanVersion: 1,
    createdAt: '1970-01-01T00:00:00.000Z',
    createdBy: { openId: 'validation-owner', larkAppId: 'validation-app' },
    ...raw,
  });
  // Authoring boundary: a new revision draft (e.g. distillation submit) must be
  // free of chat-facing side effects. Kept here rather than in
  // validateSavedWorkflowRevisionPayload so the READ path (loadSavedWorkflowRevision)
  // never applies the policy to already-saved revisions.
  assertNoSavedWorkflowChatSideEffects(normalized.dagTemplate);
  if (normalized.dagTemplate.schemaVersion !== 2) {
    throw new SavedWorkflowSchemaError([
      'new Saved Workflow revision requires dagTemplate.schemaVersion=2 and stable outputs/output keys',
    ]);
  }
  const {
    workflowId: _workflowId,
    humanVersion: _humanVersion,
    createdAt: _createdAt,
    createdBy: _createdBy,
    ...draft
  } = normalized;
  return draft;
}

export function computeSavedWorkflowRevisionContentHash(schemaVersion: number, payload: unknown): string {
  return `sha256:${sha256(canonicalJsonStringify({ schemaVersion, payload }))}`;
}

export function buildSavedWorkflowRevision(payload: unknown): StoredSavedWorkflowRevision {
  const normalized = validateSavedWorkflowRevisionPayload(payload);
  // The lowest schema that holds it: a payload without provenance stays the
  // exact v2 bytes (and id) it always was.
  const schemaVersion = savedWorkflowRevisionSchemaVersionFor(normalized);
  const contentHash = computeSavedWorkflowRevisionContentHash(schemaVersion, normalized);
  return {
    schemaVersion,
    revisionId: `rev_${contentHash.slice('sha256:'.length)}`,
    contentHash,
    payload: normalized,
  };
}

type RevisionMigration = (payload: unknown) => unknown;

/**
 * Read migrations are pure and one-way. Immutable files are never rewritten;
 * future schema bumps add `N: payload => payloadV(N+1)` entries here.
 */
const REVISION_MIGRATIONS: Readonly<Partial<Record<number, RevisionMigration>>> = Object.freeze({
  // v2 changes the authoring boundary, not historical bytes. Old revisions
  // remain selector-based and executable; no output contracts are invented.
  1: (payload) => payload,
  // v3 only adds optional `provenance`: a v2 payload is a v3 payload without
  // it. Read-only — the stored bytes and the revision id stay as they are.
  2: (payload) => payload,
});

export function migrateSavedWorkflowRevisionPayload(
  schemaVersion: number,
  payload: unknown,
): { schemaVersion: number; payload: unknown; migrated: boolean } {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new SavedWorkflowSchemaError(['revision.schemaVersion must be a positive integer']);
  }
  if (schemaVersion > SAVED_WORKFLOW_REVISION_SCHEMA_VERSION) {
    throw new SavedWorkflowSchemaError([
      `revision schema ${schemaVersion} is newer than supported ${SAVED_WORKFLOW_REVISION_SCHEMA_VERSION}`,
    ]);
  }
  let version = schemaVersion;
  let next = payload;
  while (version < SAVED_WORKFLOW_REVISION_SCHEMA_VERSION) {
    const migrate = REVISION_MIGRATIONS[version];
    if (!migrate) throw new SavedWorkflowSchemaError([`no saved-workflow read migration from schema ${version}`]);
    next = migrate(next);
    version++;
  }
  return { schemaVersion: version, payload: next, migrated: version !== schemaVersion };
}

export function loadSavedWorkflowRevision(
  raw: unknown,
  expected: { workflowId?: string; revisionId?: string } = {},
): LoadedSavedWorkflowRevision {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new SavedWorkflowSchemaError(['revision root must be an object']);
  const storedSchemaVersion = raw.schemaVersion;
  if (!Number.isInteger(storedSchemaVersion) || (storedSchemaVersion as number) < 1) {
    problems.push('revision.schemaVersion must be a positive integer');
  }
  const revisionId = typeof raw.revisionId === 'string' ? raw.revisionId : '';
  const contentHash = typeof raw.contentHash === 'string' ? raw.contentHash : '';
  if (!SAVED_WORKFLOW_REVISION_ID_RE.test(revisionId)) problems.push('revisionId must match rev_<64 lowercase hex>');
  if (!SAVED_WORKFLOW_CONTENT_HASH_RE.test(contentHash)) problems.push('contentHash must match sha256:<64 lowercase hex>');
  if (expected.revisionId && revisionId !== expected.revisionId) {
    problems.push(`revisionId ${revisionId} does not match expected ${expected.revisionId}`);
  }
  if (Number.isInteger(storedSchemaVersion) && storedSchemaVersion as number >= 1) {
    const computed = computeSavedWorkflowRevisionContentHash(storedSchemaVersion as number, raw.payload);
    if (contentHash && computed !== contentHash) problems.push('revision contentHash does not match payload');
    if (revisionId && revisionId !== `rev_${computed.slice('sha256:'.length)}`) {
      problems.push('revisionId does not match contentHash');
    }
  }
  if (problems.length > 0) throw new SavedWorkflowSchemaError(problems);

  // Verify the immutable stored bytes before transforming them. The original
  // revisionId remains the identity after a read migration.
  const migrated = migrateSavedWorkflowRevisionPayload(storedSchemaVersion as number, raw.payload);
  // Provenance did not exist before v3: an older revision carrying the key
  // was not written by any botmux and is not silently promoted.
  if ((storedSchemaVersion as number) < 3 && isRecord(raw.payload) && Object.prototype.hasOwnProperty.call(raw.payload, 'provenance')) {
    throw new SavedWorkflowSchemaError([`revision schema ${storedSchemaVersion as number} cannot carry provenance`]);
  }
  const payload = validateSavedWorkflowRevisionPayload(migrated.payload);
  if (expected.workflowId && payload.workflowId !== expected.workflowId) {
    throw new SavedWorkflowSchemaError([
      `payload.workflowId ${payload.workflowId} does not match expected ${expected.workflowId}`,
    ]);
  }
  return {
    revisionId,
    contentHash,
    storedSchemaVersion: storedSchemaVersion as number,
    // v1 reads as v2 (as before); v2 and v3 as stored. A v2 revision
    // materializes with the same definition snapshot bytes it always did.
    schemaVersion: (storedSchemaVersion as number) >= 3 ? 3 : 2,
    payload,
    migrated: (storedSchemaVersion as number) < 2,
  };
}
