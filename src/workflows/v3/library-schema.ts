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
import { DagValidationError, validateDag } from './dag.js';
import type { Spec } from './contract.js';
import { SpecValidationError, validateSpec } from './spec.js';
import { assertSavedWorkflowTemplateBindings } from './template-bindings.js';

// Compatibility export for callers that historically imported the encoder
// from the Saved Workflow schema module.
export { canonicalJsonStringify } from '../../utils/canonical-json.js';

export const SAVED_WORKFLOW_METADATA_SCHEMA_VERSION = 1 as const;
export const SAVED_WORKFLOW_REVISION_SCHEMA_VERSION = 1 as const;

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
  nodes: V3Node[];
}

export type V3SpecTemplate = Omit<Spec, 'runId'>;

export interface SavedWorkflowSafety {
  /** Hash of the normalized human gates, protecting against silent gate weakening. */
  gateDigest: string;
  sideEffects: Array<{ nodeId: string; kind: string }>;
}

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
  schemaVersion: typeof SAVED_WORKFLOW_REVISION_SCHEMA_VERSION;
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
    nodes = validateDag({ runId: 'saved-template', nodes: raw.nodes }).nodes;
  } catch (err) {
    if (err instanceof DagValidationError) throw new SavedWorkflowSchemaError(err.problems.map((p) => `dagTemplate: ${p}`));
    throw err;
  }
  const botProblems: string[] = [];
  validateDirectBotSelectors(nodes, undefined, 'dagTemplate.nodes', botProblems);
  if (botProblems.length > 0) throw new SavedWorkflowSchemaError(botProblems);
  return { nodes };
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
    'dagTemplate', 'safety',
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
  const contentHash = computeSavedWorkflowRevisionContentHash(
    SAVED_WORKFLOW_REVISION_SCHEMA_VERSION,
    normalized,
  );
  return {
    schemaVersion: SAVED_WORKFLOW_REVISION_SCHEMA_VERSION,
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
const REVISION_MIGRATIONS: Readonly<Partial<Record<number, RevisionMigration>>> = Object.freeze({});

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
    schemaVersion: SAVED_WORKFLOW_REVISION_SCHEMA_VERSION,
    payload,
    migrated: migrated.migrated,
  };
}
