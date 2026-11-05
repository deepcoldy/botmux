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
 * parameters: their `${params.…}` markers stay in the text).
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
  const nodes = withExplicitBots(flow.nodes, (selector) => flow.scope.get(selector)?.larkAppId);
  const { runId: _runId, ...spec } = flow.spec;
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

/** `${params.…}` / `${context.…}` markers left in a flow: an ad-hoc run has
 *  nothing to resolve them with. */
export function unresolvedFlowMarkers(nodes: readonly V3Node[]): { params: string[]; context: string[] } {
  const bindings = collectSavedWorkflowTemplateBindings({ schemaVersion: 2, nodes: nodes as V3Node[] });
  return { params: [...bindings.params].sort(), context: [...bindings.context].sort() };
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
