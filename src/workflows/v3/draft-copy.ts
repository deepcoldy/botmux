/**
 * 基于历史创建 (design 2026-11-03 workflow-dashboard-orchestration §6, D6):
 * the read-only side — what a new draft copies from a run or from one
 * version of a template.
 *
 * Reading a source never changes it:
 *   - a run is read through its authorized artifacts (run.json → digests →
 *     dag / spec / bots), its journal and its applied runtime revisions,
 *     exactly the way a saved template reads a finished run — but without
 *     the "finished, your own, of this bot" rules of saving (copying is for
 *     anyone's run, finished or not). Nothing is locked or written.
 *   - a template version is read as stored (any version, published or not).
 *
 * What comes out is a definition with no run id: goal nodes carry the bot
 * that actually ran them (a run) or the bot the template names, the spec
 * without its run id, and the template's parameter declarations (kept as
 * parameters: their `${params.…}` markers stay in the text). A run that was
 * itself started from a template is copied as it ran: its parameters are
 * replaced by the values it ran with (`params.resolved.json`), so the copy
 * has none left (§6: run 取最终生效的版本).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { V3Node } from './dag.js';
import type { Spec } from './contract.js';
import { loadAuthorizedV3Run, RunEnvelopeIntegrityError } from './run-envelope.js';
import { readJournal } from './journal.js';
import { materialize, type V3RunStatus } from './state.js';
import { readV3RunFinalFlow } from './library-materialize.js';
import {
  SavedWorkflowNotFoundError,
  readSavedWorkflowMetadata,
  readSavedWorkflowRevision,
} from './library-store.js';
import { SAVED_WORKFLOW_ID_RE, type SavedWorkflowParamDef } from './library-schema.js';
import { isValidRunId } from './ops-projection.js';
import { collectSavedWorkflowTemplateBindings } from './template-bindings.js';

/** What the request names (`POST /drafts/from-source`). */
export type WorkflowCopySourceRef =
  | { kind: 'run'; runId: string }
  | { kind: 'template'; workflowId: string; revisionId: string };

export class WorkflowCopySourceError extends Error {
  constructor(
    readonly code: 'bad_request' | 'unknown_run' | 'template_not_found' | 'source_unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowCopySourceError';
  }
}

const REVISION_ID_RE = /^rev_[0-9a-f]{64}$/;

export function parseWorkflowCopySource(raw: unknown): WorkflowCopySourceRef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkflowCopySourceError('bad_request', 'source 必须是对象：{kind:"run", runId} 或 {kind:"template", workflowId, revisionId}');
  }
  const source = raw as Record<string, unknown>;
  if (source.kind === 'run') {
    if (typeof source.runId !== 'string' || !isValidRunId(source.runId)) throw new WorkflowCopySourceError('bad_request', 'source.runId 不合法');
    return { kind: 'run', runId: source.runId };
  }
  if (source.kind === 'template') {
    if (typeof source.workflowId !== 'string' || !SAVED_WORKFLOW_ID_RE.test(source.workflowId)) {
      throw new WorkflowCopySourceError('bad_request', 'source.workflowId 不合法');
    }
    if (typeof source.revisionId !== 'string' || !REVISION_ID_RE.test(source.revisionId)) {
      throw new WorkflowCopySourceError('bad_request', 'source.revisionId 不合法');
    }
    return { kind: 'template', workflowId: source.workflowId, revisionId: source.revisionId };
  }
  throw new WorkflowCopySourceError('bad_request', 'source.kind 只能是 run 或 template');
}

/** A run counts as finished once it can no longer change. */
export function isFinishedV3RunStatus(status: V3RunStatus | 'not_started'): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export type WorkflowCopySourceRecord =
  | {
    kind: 'run';
    runId: string;
    /** The run's status at the moment of the copy. */
    runStatus: V3RunStatus | 'not_started';
    /** Not finished: the copy is the flow as it stood then (§6). */
    unfinished: boolean;
    /** Runtime revisions applied before the copy (the flow copied includes them). */
    runtimeRevisions: number;
    /** The run's main bot, when it is bound to one. */
    orchestratorAppId?: string;
  }
  | {
    kind: 'template';
    workflowId: string;
    revisionId: string;
    humanVersion: number;
    displayName: string;
    /** The template's owner (who may append to it, I9). */
    ownerOpenId: string;
    orchestratorAppId: string;
    scope: 'global' | 'chat';
  };

export interface WorkflowCopyMaterial {
  source: WorkflowCopySourceRecord;
  /** The DAG schema version the source uses (absent = legacy 1). */
  schemaVersion?: number;
  nodes: V3Node[];
  spec: Omit<Spec, 'runId'>;
  /** Parameters the template declares, kept as parameters. */
  inputs: Record<string, SavedWorkflowParamDef>;
}

/** The run dir of a run under `baseDir`, or unknown_run. */
function runDirOf(baseDir: string, runId: string): string {
  const runDir = join(baseDir, runId);
  if (!isValidRunId(runId) || !existsSync(join(runDir, 'run.json'))) {
    throw new WorkflowCopySourceError('unknown_run', `没有这个运行：${runId}`);
  }
  return runDir;
}

/** The main bot a run is bound to (routing: the default orchestrator of a
 *  copy), read without verifying the artifacts. */
export function runCopyDefaultOrchestrator(baseDir: string, runId: string): string | undefined {
  try {
    const runDir = runDirOf(baseDir, runId);
    const loaded = loadAuthorizedV3Run(runDir, { expectedRunId: runId });
    return loaded.envelope.chatBinding?.larkAppId;
  } catch {
    return undefined;
  }
}

/**
 * The flow of a run as it stands now: the final effective version (applied
 * runtime revisions included, pending proposals not) and, per goal node,
 * the bot that ran it (a reassignment wins). Finished or not, any source
 * kind with a spec and pinned bots. Read only.
 */
export function readRunCopyMaterial(baseDir: string, runId: string): WorkflowCopyMaterial {
  const runDir = runDirOf(baseDir, runId);
  let loaded: ReturnType<typeof loadAuthorizedV3Run>;
  try {
    loaded = loadAuthorizedV3Run(runDir, { expectedRunId: runId });
  } catch (error) {
    if (error instanceof RunEnvelopeIntegrityError && error.code === 'envelope_missing') {
      throw new WorkflowCopySourceError('unknown_run', `没有这个运行：${runId}`);
    }
    throw new WorkflowCopySourceError('source_unreadable', `这个运行的记录读不出来：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!loaded.spec || loaded.botSnapshots === undefined) {
    throw new WorkflowCopySourceError('source_unreadable', '这个运行没有 spec 或 Bot 快照，不能复制');
  }
  const journalPath = join(runDir, 'journal.ndjson');
  const started = existsSync(journalPath);
  let flow: ReturnType<typeof readV3RunFinalFlow>;
  let runStatus: V3RunStatus | 'not_started';
  try {
    const events = started ? readJournal(journalPath) : [];
    const snap = materialize(events);
    runStatus = started ? snap.runStatus : 'not_started';
    flow = readV3RunFinalFlow(runDir, loaded, events, snap);
  } catch (error) {
    throw new WorkflowCopySourceError('source_unreadable', `这个运行的流程读不出来：${error instanceof Error ? error.message : String(error)}`);
  }
  // Every goal node names the bot that runs it (an inherited default is
  // resolved through the frozen snapshots), so the copy does not depend on
  // which bot orchestrates it.
  let nodes = withExplicitBots(flow.nodes, (selector) => flow.scope.get(selector)?.larkAppId);
  let { runId: _runId, ...spec } = flow.spec;
  if (loaded.envelope.source.kind === 'saved_definition') {
    const values = resolvedParamValues(loaded.resolvedParams);
    nodes = substituteParams(nodes, values) as V3Node[];
    spec = substituteParams(spec, values) as typeof spec;
  }
  const orchestratorAppId = loaded.envelope.chatBinding?.larkAppId;
  return {
    source: {
      kind: 'run',
      runId,
      runStatus,
      unfinished: !isFinishedV3RunStatus(runStatus),
      runtimeRevisions: flow.effective.history.applied.length,
      ...(orchestratorAppId ? { orchestratorAppId } : {}),
    },
    ...(flow.effective.dag.schemaVersion !== undefined ? { schemaVersion: flow.effective.dag.schemaVersion } : {}),
    nodes,
    spec,
    inputs: {},
  };
}

/** One version of a template, as stored (published or not). Archived
 *  templates are not offered. */
export async function readTemplateCopyMaterial(dataDir: string, workflowId: string, revisionId: string): Promise<WorkflowCopyMaterial> {
  let metadata: Awaited<ReturnType<typeof readSavedWorkflowMetadata>>;
  let revision: Awaited<ReturnType<typeof readSavedWorkflowRevision>>;
  try {
    metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
    if (metadata.status === 'archived') throw new SavedWorkflowNotFoundError(workflowId);
    revision = await readSavedWorkflowRevision(dataDir, workflowId, revisionId);
  } catch (error) {
    if (error instanceof SavedWorkflowNotFoundError) throw new WorkflowCopySourceError('template_not_found', '没有这个模板或这个版本');
    throw new WorkflowCopySourceError('source_unreadable', `模板读不出来：${error instanceof Error ? error.message : String(error)}`);
  }
  if (revision.payload.workflowId !== workflowId) throw new WorkflowCopySourceError('template_not_found', '没有这个模板或这个版本');
  const payload = revision.payload;
  const owner = metadata.owner.larkAppId;
  const nodes = withExplicitBots(clone(payload.dagTemplate.nodes), (selector) => selector || owner);
  return {
    source: {
      kind: 'template',
      workflowId,
      revisionId,
      humanVersion: payload.humanVersion,
      displayName: metadata.displayName,
      ownerOpenId: metadata.owner.openId,
      orchestratorAppId: owner,
      scope: metadata.scope.kind,
    },
    ...(payload.dagTemplate.schemaVersion !== undefined ? { schemaVersion: payload.dagTemplate.schemaVersion } : {}),
    nodes,
    spec: clone(payload.specTemplate) as Omit<Spec, 'runId'>,
    inputs: clone(payload.inputs),
  };
}

/** The template's owning bot (routing), or undefined. */
export async function templateCopyDefaultOrchestrator(dataDir: string, workflowId: string): Promise<string | undefined> {
  try {
    const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
    return metadata.status === 'archived' ? undefined : metadata.owner.larkAppId;
  } catch {
    return undefined;
  }
}

const SPEC_MARKER_RE = /\$\{(params|context)\.([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;

/** `${params.…}` / `${context.…}` markers left in a flow (and, given, its
 *  spec): an ad-hoc run has nothing to resolve them with. */
export function unresolvedFlowMarkers(nodes: readonly V3Node[], spec?: unknown): { params: string[]; context: string[] } {
  const bindings = collectSavedWorkflowTemplateBindings({ schemaVersion: 2, nodes: nodes as V3Node[] });
  const params = new Set<string>(bindings.params);
  const context = new Set<string>(bindings.context);
  if (spec !== undefined) {
    for (const match of JSON.stringify(spec).matchAll(SPEC_MARKER_RE)) {
      (match[1] === 'params' ? params : context).add(match[2]!);
    }
  }
  return { params: [...params].sort(), context: [...context].sort() };
}

/** The `params` a template run ran with (`params.resolved.json`). */
function resolvedParamValues(raw: unknown): Record<string, unknown> {
  const params = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { params?: unknown }).params : undefined;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new WorkflowCopySourceError('source_unreadable', '这个从模板运行的 run 没有可读的参数值（params.resolved.json）');
  }
  return params as Record<string, unknown>;
}

const PARAM_TEXT_RE = /\$\{params\.([A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z0-9_]+)*)\}/g;

function paramAt(values: Record<string, unknown>, path: string): { found: boolean; value?: unknown } {
  let cursor: unknown = values;
  for (const segment of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, segment)) return { found: false };
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true, value: cursor };
}

/**
 * Parameters → the values a template run ran with: a `${params.x}` in text
 * becomes the value's text (a structured value as JSON); a host input's exact
 * `{ "$ref": "params.x" }` becomes the value itself. Context markers stay
 * (they name the source run's chat, not the copy's). A name with no value
 * stays as it is (and is refused later as unresolved).
 */
export function substituteParams(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    if (!value.includes('${params.')) return value;
    return value.replace(PARAM_TEXT_RE, (whole, path: string) => {
      const hit = paramAt(values, path);
      if (!hit.found) return whole;
      return typeof hit.value === 'string' ? hit.value : JSON.stringify(hit.value);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substituteParams(item, values));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === '$ref' && typeof record.$ref === 'string' && record.$ref.startsWith('params.')) {
    const hit = paramAt(values, record.$ref.slice('params.'.length));
    return hit.found ? clone(hit.value) : clone(record);
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) out[key] = substituteParams(child, values);
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Goal and loop nodes with `bot` set to a concrete app id (inherited by
 *  loop bodies as the runtime does). */
function withExplicitBots(nodes: V3Node[], resolve: (selector: string) => string | undefined, inherited = ''): V3Node[] {
  return nodes.map((node) => {
    if (node.type === 'host') return node;
    const selector = node.bot ?? inherited;
    const appId = resolve(selector) ?? node.bot;
    const next: V3Node = { ...node, ...(appId ? { bot: appId } : {}) };
    if (node.type === 'loop' && node.body) next.body = { nodes: withExplicitBots(node.body.nodes, resolve, selector) };
    return next;
  });
}
