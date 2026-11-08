/**
 * Saved Workflow compiler + run materializer.
 *
 * Save is intentionally exact by default: it freezes the approved DAG/spec
 * and canonical bot identities, but does not guess which literals should turn
 * into parameters. A future distiller may submit an explicit parameterized
 * draft through the same schema/host validation seam.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import type { BotConfig } from '../../bot-registry.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { fsyncDirectorySyncPortable } from '../../utils/fs-durability.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import {
  coerceWorkflowParams,
  validateWorkflowParamSchema,
  type RawParamInput,
} from '../shared/params.js';
import { isGoalNode, isLoopNode, validateDag, type V3Dag, type V3Node } from './dag.js';
import {
  freezeDagBotSnapshots,
  parseFrozenBotSnapshots,
  serializeFrozenBotSnapshots,
} from './bot-resolve.js';
import { readJournal } from './journal.js';
import { loadEffectiveV3Dag, snapshotForSelector, v3ApprovedBotScope } from './dag-revision.js';
import { materialize } from './state.js';
import { validateSpec } from './spec.js';
import { mintV3RunId, type RunChatBinding } from './grill-state.js';
import { isValidRunId } from './ops-projection.js';
import {
  computeSavedWorkflowGateDigest,
  computeSavedWorkflowSideEffects,
  savedWorkflowGoalNodeBots,
  type SavedWorkflowBotChange,
  collectSavedWorkflowChatSideEffectProblems,
  formatSavedWorkflowChatSideEffectProblems,
  validateDagTemplate,
  validateSpecTemplate,
  type LoadedSavedWorkflowRevision,
  type SavedWorkflowBuiltinContextRef,
  type SavedWorkflowMetadata,
  type SavedWorkflowParamDef,
  type SavedWorkflowRevisionDraft,
} from './library-schema.js';
import {
  artifactRef,
  loadAuthorizedV3Run,
  feishuRunInitiator,
  makeSavedDefinitionRunEnvelope,
  publishRunEnvelopeOnce,
  readRunEnvelope,
  type LoadedAuthorizedV3Run,
  type V3HandoffIdentityRecord,
  type V3FlowConfirmation,
  type V3RunInitiator,
  type V3SavedDefinitionRunEnvelope,
} from './run-envelope.js';
import type { BotSnapshot, Spec } from './contract.js';
import {
  assertSavedWorkflowTemplateBindings,
  collectSavedWorkflowTemplateBindings,
} from './template-bindings.js';

export interface CompiledSavedWorkflowFromRun {
  displayName: string;
  revision: SavedWorkflowRevisionDraft;
  sourceStatus: 'succeeded' | 'failed' | 'blocked';
  publish: boolean;
  lintWarnings: string[];
  /** Runtime flow revisions that took effect in the source run (design
   *  §13.8): the saved definition is the FINAL effective flow. */
  runtimeRevisions: number;
}

/**
 * Exact-save found literals that are risky to freeze into a reusable
 * definition. Warning strings contain only a field path and a risk class (not
 * the matched value), so an IM adapter may safely render them for confirmation.
 */
export class SavedWorkflowUnsafeLiteralError extends Error {
  readonly warningDigest: string;

  constructor(public readonly warnings: readonly string[]) {
    const normalized = [...warnings];
    super(
      `Saved Workflow lint requires confirmation:\n- ${normalized.join('\n- ')}\n` +
      'Review/redact these literals, or explicitly acknowledgeUnsafeLiterals.',
    );
    this.name = 'SavedWorkflowUnsafeLiteralError';
    this.warningDigest = createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
  }
}

export interface CompileSavedWorkflowFromRunOptions {
  /** Non-successful runs can only become a draft and require explicit opt-in. */
  allowDraft?: boolean;
  /** Explicit distiller/editor output. Default exact save has no params. */
  inputs?: Record<string, SavedWorkflowParamDef>;
  contextRefs?: SavedWorkflowBuiltinContextRef[];
  specStatus?: 'current' | 'stale';
  /** Explicit user confirmation after reviewing free-text lint warnings. */
  acknowledgeUnsafeLiterals?: boolean;
}

export type BuildSavedWorkflowRevisionBaselineOptions = Pick<
  CompileSavedWorkflowFromRunOptions,
  'inputs' | 'contextRefs' | 'specStatus'
>;

export interface BuiltSavedWorkflowRevisionBaseline {
  displayName: string;
  revision: SavedWorkflowRevisionDraft;
  lintWarnings: string[];
}

function cloneNodes(nodes: V3Node[]): V3Node[] {
  return JSON.parse(JSON.stringify(nodes)) as V3Node[];
}

function canonicalizeNodeBots(
  nodes: V3Node[],
  snapshots: ReadonlyMap<string, BotSnapshot>,
  inheritedSelector?: string,
): V3Node[] {
  return nodes.map((node) => {
    if (!isGoalNode(node) && !isLoopNode(node)) return { ...node };
    const selector = node.bot ?? inheritedSelector ?? '';
    const snapshot = snapshots.get(selector);
    if (!snapshot) {
      throw new Error(
        `cannot save workflow: bots.snapshot.json has no frozen bot for selector ` +
        `${JSON.stringify(selector || '<default>')} (node ${node.id})`,
      );
    }
    const next: V3Node = { ...node, bot: snapshot.larkAppId };
    if (isLoopNode(next)) {
      next.body = {
        nodes: canonicalizeNodeBots(next.body.nodes, snapshots, selector),
      };
    }
    return next;
  });
}

export function collectSavedWorkflowReusableTextWarnings(
  value: unknown,
  path: string,
  warnings: string[],
): void {
  if (typeof value === 'string') {
    if (/(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s"']{6,}/i.test(value)) {
      warnings.push(`${path} looks like an embedded secret`);
    }
    if (/(?:^|[\s"'])(?:\/(?:Users|home|root|tmp|etc|var)\/[^\s"']+|[A-Za-z]:\\[^\s"']+)/.test(value)) {
      warnings.push(`${path} contains an absolute machine-local path`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSavedWorkflowReusableTextWarnings(item, `${path}[${index}]`, warnings));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectSavedWorkflowReusableTextWarnings(child, `${path}.${key}`, warnings);
    }
  }
}

/**
 * Pure exact-revision compiler over one already authenticated/digest-checked
 * run read. It performs no path or journal IO, so callers cannot accidentally
 * rebuild a baseline from a different set of source bytes.
 */
export function buildSavedWorkflowRevisionBaseline(
  loaded: LoadedAuthorizedV3Run,
  opts: BuildSavedWorkflowRevisionBaselineOptions = {},
): BuiltSavedWorkflowRevisionBaseline {
  if (!loaded.spec) throw new Error('cannot save workflow: source run has no validated spec.json');
  if (loaded.botSnapshots === undefined) {
    throw new Error('cannot save workflow: source run has no pinned bots.snapshot.json');
  }
  const snapshots = parseFrozenBotSnapshots(loaded.botSnapshots, loaded.dag);
  return buildSavedWorkflowRevisionFromFlow({
    dag: loaded.dag,
    spec: loaded.spec,
    snapshots,
    sourceRunId: loaded.envelope.runId,
  }, opts);
}

/**
 * The exact revision of one flow (a DAG, its spec and the bots it is frozen
 * with): what a terminal run ran, or what a confirmed Dashboard draft would
 * run (§5.1). Pure: no path or journal IO.
 */
export function buildSavedWorkflowRevisionFromFlow(
  flow: { dag: V3Dag; spec: Spec; snapshots: ReadonlyMap<string, BotSnapshot>; sourceRunId?: string },
  opts: BuildSavedWorkflowRevisionBaselineOptions = {},
): BuiltSavedWorkflowRevisionBaseline {
  const hasLegacySelector = (nodes: V3Dag['nodes']): boolean => nodes.some((node) =>
    node.inputs.some((input) => input.select !== undefined)
    || (node.type === 'loop' && node.body !== undefined && hasLegacySelector(node.body.nodes)));
  if (flow.dag.schemaVersion !== 2 && hasLegacySelector(flow.dag.nodes)) {
    throw new Error(
      'cannot save workflow: source run uses legacy artifact selectors; revise it to schemaVersion 2 with stable outputs/output keys first',
    );
  }
  const normalizedNodes = canonicalizeNodeBots(cloneNodes(flow.dag.nodes), flow.snapshots);
  const dagTemplate = validateDagTemplate({ schemaVersion: 2, nodes: normalizedNodes });
  const { runId: _runId, ...specWithoutRunId } = flow.spec;
  const specTemplate = validateSpecTemplate(specWithoutRunId);
  const inputs = opts.inputs ?? {};
  const contextRefs = opts.contextRefs ?? collectSavedWorkflowTemplateBindings(dagTemplate).context;
  assertSavedWorkflowTemplateBindings(dagTemplate, inputs, contextRefs);
  const lintWarnings = formatSavedWorkflowChatSideEffectProblems(
    collectSavedWorkflowChatSideEffectProblems(dagTemplate),
  );
  collectSavedWorkflowReusableTextWarnings(dagTemplate, 'dagTemplate', lintWarnings);
  collectSavedWorkflowReusableTextWarnings(specTemplate, 'specTemplate', lintWarnings);
  const revision: SavedWorkflowRevisionDraft = {
    ...(flow.sourceRunId !== undefined ? { sourceRunId: flow.sourceRunId } : {}),
    inputs,
    contextRefs,
    specTemplate,
    specStatus: opts.specStatus ?? 'current',
    dagTemplate,
    safety: {
      gateDigest: computeSavedWorkflowGateDigest(dagTemplate),
      sideEffects: computeSavedWorkflowSideEffects(dagTemplate),
    },
  };
  return { displayName: flow.spec.title, revision, lintWarnings };
}

/** Exact run → revision draft. No heuristic literal replacement. */
export function compileSavedWorkflowFromRun(
  runDir: string,
  opts: CompileSavedWorkflowFromRunOptions = {},
): CompiledSavedWorkflowFromRun {
  const loaded = loadAuthorizedV3Run(runDir, {
    allowedSources: ['ad_hoc', 'saved_definition', 'legacy_v3'],
  });
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) throw new Error('cannot save workflow: source run has not started');
  const events = readJournal(journalPath);
  const status = materialize(events).runStatus;
  if (status !== 'succeeded' && status !== 'failed' && status !== 'blocked') {
    throw new Error(`cannot save workflow: source run is not terminal (status=${status})`);
  }
  if (status !== 'succeeded' && opts.allowDraft !== true) {
    throw new Error(`cannot publish workflow from a ${status} run; pass allowDraft to save it as draft`);
  }

  // Save what actually ran: the final effective flow (authorized DAG plus
  // every applied runtime revision, digest-verified) and the bots it used.
  const effective = loadEffectiveV3Dag(runDir, loaded.dag, events);
  const source: LoadedAuthorizedV3Run = effective.revision === 1
    ? loaded
    : {
        ...loaded,
        dag: effective.dag,
        botSnapshots: Object.fromEntries(v3ApprovedBotScope(
          new Map(Object.entries(loaded.botSnapshots as Record<string, BotSnapshot>)),
          effective.botAdditions,
        )),
      };
  const built = buildSavedWorkflowRevisionBaseline(source, opts);
  const { lintWarnings } = built;
  if (lintWarnings.length > 0 && opts.acknowledgeUnsafeLiterals !== true) {
    throw new SavedWorkflowUnsafeLiteralError(lintWarnings);
  }
  return {
    displayName: built.displayName,
    revision: built.revision,
    sourceStatus: status,
    publish: status === 'succeeded',
    lintWarnings,
    runtimeRevisions: effective.history.applied.length,
  };
}

// ─── Dashboard save from a terminal run (design 2026-11-03 §5.1, E10) ─────

export interface CompiledDashboardSavedWorkflowFromRun extends CompiledSavedWorkflowFromRun {
  /** Nodes whose bot in the saved definition is not the one approved. */
  botChanges: SavedWorkflowBotChange[];
}

/** Goal node by id: top level, or `<loop>.<body>`. */
function findTemplateGoalNode(nodes: V3Node[], nodeId: string): V3Node | undefined {
  const top = nodes.find((node) => node.id === nodeId && isGoalNode(node));
  if (top) return top;
  for (const node of nodes) {
    if (!isLoopNode(node) || !nodeId.startsWith(`${node.id}.`)) continue;
    const bodyId = nodeId.slice(node.id.length + 1);
    const hit = node.body.nodes.find((candidate) => candidate.id === bodyId && isGoalNode(candidate));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * A run's final effective flow and the bots that ran it (design 2026-11-03
 * §5.1 E10, §6): the authorized DAG plus every applied runtime revision
 * (digest-verified; a pending proposal is not part of it), with each goal
 * node's bot replaced by the one a recorded reassignment moved it to. Works
 * on a run that has not finished (or not started: no journal yet). Read
 * only: nothing in the run dir is written.
 */
export function readV3RunFinalFlow(
  runDir: string,
  loaded: LoadedAuthorizedV3Run,
  events: ReturnType<typeof readJournal>,
  snap: ReturnType<typeof materialize> = materialize(events),
): {
  frozen: Map<string, BotSnapshot>;
  effective: ReturnType<typeof loadEffectiveV3Dag>;
  nodes: V3Node[];
  scope: Map<string, BotSnapshot>;
  reassigned: Set<string>;
  spec: Spec;
} {
  if (loaded.botSnapshots === undefined || !loaded.spec) {
    throw new Error('cannot save workflow: source run has no pinned bots.snapshot.json / spec.json');
  }
  const frozen = parseFrozenBotSnapshots(loaded.botSnapshots, loaded.dag);
  const effective = loadEffectiveV3Dag(runDir, loaded.dag, events);
  const scope = v3ApprovedBotScope(frozen, effective.botAdditions);

  // The bots that ran: every recorded reassignment wins over the definition.
  const nodes = cloneNodes(effective.dag.nodes);
  const reassigned = new Set<string>();
  for (const [nodeId, larkAppId] of snap.assignments) {
    const node = findTemplateGoalNode(nodes, nodeId);
    if (!node) continue;
    if (!snapshotForSelector(scope, larkAppId)) {
      throw new Error(`cannot save workflow: node ${nodeId} was reassigned to ${larkAppId}, which is outside the run's approved bots`);
    }
    if (!scope.has(larkAppId)) scope.set(larkAppId, snapshotForSelector(scope, larkAppId)!);
    node.bot = larkAppId;
    reassigned.add(nodeId);
  }
  return { frozen, effective, nodes, scope, reassigned, spec: loaded.spec };
}

/**
 * Like {@link compileSavedWorkflowFromRun}, plus what the Dashboard save
 * promises (E10): the final effective flow AND the bots that actually ran
 * it — a node reassigned on its blocked card (`nodeReassigned`) is saved
 * with the bot it was reassigned to — and which nodes differ from the flow
 * the run was approved with. Feishu `/workflow save` keeps its own compiler,
 * unchanged.
 */
export function compileDashboardSavedWorkflowFromRun(
  runDir: string,
  opts: CompileSavedWorkflowFromRunOptions = {},
): CompiledDashboardSavedWorkflowFromRun {
  const loaded = loadAuthorizedV3Run(runDir, {
    allowedSources: ['ad_hoc', 'saved_definition', 'legacy_v3'],
  });
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) throw new Error('cannot save workflow: source run has not started');
  const events = readJournal(journalPath);
  const snap = materialize(events);
  const status = snap.runStatus;
  if (status !== 'succeeded' && status !== 'failed' && status !== 'blocked') {
    throw new Error(`cannot save workflow: source run is not terminal (status=${status})`);
  }
  if (status !== 'succeeded' && opts.allowDraft !== true) {
    throw new Error(`cannot publish workflow from a ${status} run; pass allowDraft to save it as draft`);
  }
  const { frozen, effective, nodes, scope, reassigned, spec } = readV3RunFinalFlow(runDir, loaded, events, snap);
  const built = buildSavedWorkflowRevisionFromFlow({
    dag: { ...effective.dag, nodes },
    spec,
    snapshots: scope,
    sourceRunId: loaded.envelope.runId,
  }, opts);
  if (built.lintWarnings.length > 0 && opts.acknowledgeUnsafeLiterals !== true) {
    throw new SavedWorkflowUnsafeLiteralError(built.lintWarnings);
  }

  // Approved flow → its bots, on the same terms as the saved template.
  const approved = savedWorkflowGoalNodeBots(canonicalizeNodeBots(cloneNodes(loaded.dag.nodes), frozen));
  const saved = savedWorkflowGoalNodeBots(built.revision.dagTemplate.nodes);
  const botChanges: SavedWorkflowBotChange[] = [];
  for (const [nodeId, savedBot] of saved) {
    const approvedBot = approved.get(nodeId);
    if (!approved.has(nodeId)) {
      botChanges.push({ nodeId, ...(savedBot ? { savedLarkAppId: savedBot } : {}), cause: 'added' });
    } else if (approvedBot !== savedBot) {
      botChanges.push({
        nodeId,
        ...(approvedBot ? { approvedLarkAppId: approvedBot } : {}),
        ...(savedBot ? { savedLarkAppId: savedBot } : {}),
        cause: reassigned.has(nodeId) ? 'reassigned' : 'revised',
      });
    }
  }
  for (const [nodeId, approvedBot] of approved) {
    if (!saved.has(nodeId)) botChanges.push({ nodeId, ...(approvedBot ? { approvedLarkAppId: approvedBot } : {}), cause: 'removed' });
  }
  botChanges.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return {
    displayName: built.displayName,
    revision: built.revision,
    sourceStatus: status,
    publish: status === 'succeeded',
    lintWarnings: built.lintWarnings,
    runtimeRevisions: effective.history.applied.length,
    botChanges,
  };
}

// ─── Template run started from the Dashboard (§5.3, D5) ───────────────────

/** The DAG and spec a revision runs as under `runId` — exactly what
 *  {@link materializeSavedWorkflowRun} writes. */
export function savedWorkflowRunFlow(revision: LoadedSavedWorkflowRevision, runId: string): { dag: V3Dag; spec: Spec } {
  const dag = validateDag({
    ...(revision.payload.dagTemplate.schemaVersion !== undefined
      ? { schemaVersion: revision.payload.dagTemplate.schemaVersion }
      : {}),
    runId,
    nodes: cloneNodes(revision.payload.dagTemplate.nodes),
  });
  const spec = validateSpec({ ...revision.payload.specTemplate, runId });
  return { dag, spec };
}

/** Parameters → typed values, by the same rules as `/workflow run`. Refuses
 *  sensitive parameters as the materializer does. */
export function resolveSavedWorkflowRunParams(
  revision: LoadedSavedWorkflowRevision,
  rawParams: Record<string, RawParamInput>,
): Record<string, unknown> {
  const sensitiveParams = Object.entries(revision.payload.inputs)
    .filter(([, definition]) => definition.sensitive === true)
    .map(([name]) => name);
  if (sensitiveParams.length > 0) {
    throw new Error(
      `Saved Workflow sensitive parameters are not executable yet (${sensitiveParams.join(', ')}): ` +
      'P0 does not persist secrets in run artifacts; use a bot-managed credential or remove sensitive=true.',
    );
  }
  const paramSchema = { params: revision.payload.inputs };
  validateWorkflowParamSchema(paramSchema);
  return coerceWorkflowParams(paramSchema, rawParams);
}

export interface CommitSavedWorkflowRunInPlaceInput {
  runDir: string;
  metadata: SavedWorkflowMetadata;
  revision: LoadedSavedWorkflowRevision;
  rawParams: Record<string, RawParamInput>;
  chatBinding: RunChatBinding;
  initiator: V3RunInitiator;
  /** The dag.json / spec.json digests pinned when the run was prepared. */
  expected: { dagSha256: string; specSha256: string };
  bots: BotConfig[];
  now?: Date;
}

/**
 * What run.json records for a version saved from a Dashboard draft (I13,
 * 11-05): that version's own second confirmation, as saved — who, when, the
 * summary. Undefined for every other version (Feishu saves, a finished run).
 */
export function savedWorkflowRunFlowConfirmation(revision: LoadedSavedWorkflowRevision): V3FlowConfirmation | undefined {
  const provenance = revision.payload.provenance;
  if (provenance?.kind !== 'dashboard_draft') return undefined;
  const { confirmedByOpenId, confirmedAt, flowSummary, flowSummarySha256 } = provenance.confirmation;
  return { confirmedByOpenId, confirmedAt, flowSummary, flowSummarySha256: flowSummarySha256 as `sha256:${string}` };
}

export interface SavedWorkflowRunCommitIdentity {
  workflowId: string;
  revisionId: string;
  /** The revision's content hash pinned when the run was prepared. */
  contentHash: string;
  chatBinding: Pick<RunChatBinding, 'larkAppId' | 'chatId' | 'rootMessageId'>;
  initiatorOpenId: string;
}

/**
 * A template run's run.json is already there (written before its record could
 * be): accept it only as exactly this commit — same revision and pinned
 * content, chat, topic, initiator, confirmation — verified against the run
 * directory's own artifacts (definition.snapshot.json is the definition it
 * ran with), then re-published idempotently (fsync heal). The library is not
 * read: whatever happened to the template since (archived, deleted, a newer
 * version) does not change a committed run.
 */
/** A committed template run.json that is not this commit's: shown on the
 *  page (commit / template_unavailable), never overwritten. */
export class SavedWorkflowRunReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavedWorkflowRunReplayError';
  }
}

export function replaySavedWorkflowRunCommit(runDir: string, expected: SavedWorkflowRunCommitIdentity): V3SavedDefinitionRunEnvelope {
  const runId = basename(runDir);
  const existing = readRunEnvelope(runDir, runId);
  if (existing.kind !== 'ok') {
    throw new SavedWorkflowRunReplayError(existing.kind === 'invalid' ? `run.json 已存在但无效，拒绝覆盖：${existing.problems.join('; ')}` : 'run.json 不存在');
  }
  const envelope = existing.envelope;
  const authorization = envelope.authorization as { initiator?: V3RunInitiator };
  if (envelope.source.kind !== 'saved_definition'
    || envelope.source.workflowId !== expected.workflowId
    || envelope.source.revisionId !== expected.revisionId
    || envelope.chatBinding?.chatId !== expected.chatBinding.chatId
    || envelope.chatBinding.rootMessageId !== expected.chatBinding.rootMessageId
    || envelope.chatBinding.larkAppId !== expected.chatBinding.larkAppId
    || authorization.initiator?.openId !== expected.initiatorOpenId) {
    throw new SavedWorkflowRunReplayError('run.json 已存在，但不是这次模板运行写的；不会覆盖它');
  }
  let loaded: LoadedAuthorizedV3Run;
  try {
    loaded = loadAuthorizedV3Run(runDir, { expectedRunId: runId, allowedSources: ['saved_definition'] });
  } catch (error) {
    // A pinned artifact's bytes no longer match run.json (digest), or the
    // recorded confirmation is not the snapshot's.
    throw new SavedWorkflowRunReplayError(`run.json 已写，但运行目录里的模板定义或产物和它记录的摘要对不上，不能接着启动：${error instanceof Error ? error.message : String(error)}`);
  }
  // Redundant with the check above (run.json pins definition.snapshot.json
  // by sha256, and the snapshot's revisionId is content-derived): kept as a
  // cheap direct statement of what the replay promises — the prepared version.
  const snapshot = loaded.definitionSnapshot as { contentHash?: unknown } | undefined;
  if (snapshot?.contentHash !== expected.contentHash) {
    throw new SavedWorkflowRunReplayError('run.json 已存在，但它的模板定义不是准备运行时那一版；不会覆盖它');
  }
  return publishRunEnvelopeOnce(runDir, envelope).envelope as V3SavedDefinitionRunEnvelope;
}

/**
 * Commit a template run whose directory already exists (a Dashboard
 * template-run draft, §5.3): dag.json / spec.json were written when it was
 * prepared — they must still be exactly the revision's flow under this runId
 * with the pinned digests — and the rest of what
 * {@link materializeSavedWorkflowRun} writes is added now that the group and
 * main topic exist: bot snapshots, resolved parameters and context, the
 * definition snapshot, then run.json (`source: saved_definition`, bot
 * executed, with the initiator). run.json is the commit; a run.json already
 * there must be this exact commit's (same revision, chat, topic, initiator)
 * and is returned as is (crash replay), never rewritten.
 */
export function commitSavedWorkflowRunInPlace(input: CommitSavedWorkflowRunInPlaceInput): V3SavedDefinitionRunEnvelope {
  const runDir = input.runDir;
  const runId = basename(runDir);
  if (input.metadata.workflowId !== input.revision.payload.workflowId) {
    throw new Error('Saved Workflow metadata/revision workflowId mismatch');
  }
  if (input.metadata.owner.larkAppId !== input.chatBinding.larkAppId) {
    throw new Error(`Saved Workflow '${input.metadata.workflowId}' cannot be materialized outside its owning app`);
  }
  if (input.metadata.scope.kind !== 'global') {
    throw new Error(`Saved Workflow '${input.metadata.workflowId}' is chat-scoped: run it in its chat with /workflow run`);
  }
  if (input.initiator.openId !== input.chatBinding.ownerOpenId) {
    throw new Error('the run initiator must be the chat binding owner');
  }
  const existing = readRunEnvelope(runDir, runId);
  if (existing.kind === 'invalid') throw new Error(`run.json 已存在但无效，拒绝覆盖：${existing.problems.join('; ')}`);
  if (existing.kind === 'ok') {
    return replaySavedWorkflowRunCommit(runDir, {
      workflowId: input.metadata.workflowId,
      revisionId: input.revision.revisionId,
      contentHash: input.revision.contentHash,
      chatBinding: input.chatBinding,
      initiatorOpenId: input.initiator.openId,
    });
  }
  const flowConfirmation = savedWorkflowRunFlowConfirmation(input.revision);
  assertSavedWorkflowTemplateBindings(
    input.revision.payload.dagTemplate,
    input.revision.payload.inputs,
    input.revision.payload.contextRefs,
  );
  const resolvedParams = resolveSavedWorkflowRunParams(input.revision, input.rawParams);
  const resolvedContext = resolveContext(input.revision.payload.contextRefs, {
    chatBinding: input.chatBinding,
    initiatorOpenId: input.initiator.openId,
  });
  const { dag, spec } = savedWorkflowRunFlow(input.revision, runId);
  // The prepared files are what was shown (and, for a draft-born revision,
  // confirmed): exactly the revision's flow, byte-pinned.
  for (const [file, value, sha] of [
    ['dag.json', dag, input.expected.dagSha256],
    ['spec.json', spec, input.expected.specSha256],
  ] as const) {
    const ref = artifactRef(runDir, file);
    if (ref.sha256 !== sha) throw new Error(`${file} changed since the template run was prepared`);
    const onDisk = JSON.parse(readFileSync(join(runDir, file), 'utf-8')) as unknown;
    if (JSON.stringify(onDisk) !== JSON.stringify(value)) throw new Error(`${file} is not this revision's flow`);
  }
  const botSnapshots = freezeDagBotSnapshots(dag, input.bots, { defaultSelector: input.chatBinding.larkAppId });
  const now = input.now ?? new Date();
  writeJson0600(join(runDir, 'bots.snapshot.json'), serializeFrozenBotSnapshots(botSnapshots));
  writeJson0600(join(runDir, 'params.resolved.json'), { params: resolvedParams, context: resolvedContext });
  writeJson0600(join(runDir, 'definition.snapshot.json'), {
    schemaVersion: 1,
    workflowId: input.metadata.workflowId,
    revisionId: input.revision.revisionId,
    contentHash: input.revision.contentHash,
    humanVersion: input.revision.payload.humanVersion,
    storedSchemaVersion: input.revision.storedSchemaVersion,
    materializedSchemaVersion: input.revision.schemaVersion,
    definition: input.revision.payload,
    instantiatedAt: now.toISOString(),
  });
  const envelope = makeSavedDefinitionRunEnvelope({
    runId,
    workflowId: input.metadata.workflowId,
    revisionId: input.revision.revisionId,
    humanVersion: input.revision.payload.humanVersion,
    createdAt: now.toISOString(),
    authorizedAt: now.toISOString(),
    chatBinding: input.chatBinding,
    nodeExecutor: 'bot',
    initiator: input.initiator,
    ...(flowConfirmation ? { flowConfirmation } : {}),
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
      resolvedParams: artifactRef(runDir, 'params.resolved.json'),
      definitionSnapshot: artifactRef(runDir, 'definition.snapshot.json'),
    },
  });
  return publishRunEnvelopeOnce(runDir, envelope).envelope as V3SavedDefinitionRunEnvelope;
}

export interface SavedWorkflowMaterializeContext {
  chatBinding?: RunChatBinding;
  initiatorOpenId?: string;
}

export interface MaterializeSavedWorkflowRunInput {
  metadata: SavedWorkflowMetadata;
  revision: LoadedSavedWorkflowRevision;
  rawParams?: Record<string, RawParamInput>;
  context?: SavedWorkflowMaterializeContext;
  bots: BotConfig[];
  baseDir: string;
  runId?: string;
  now?: Date;
  /** Frozen into run.json (design §6.3). With `bot`, a node without its own
   *  `bot` is executed by the run's own bot rather than the first configured
   *  supported bot. Absent = today's ephemeral execution, unchanged. */
  nodeExecutor?: 'bot';
  /** The initiator frozen for 交接带发起人身份 (design §10.2); only with
   *  `nodeExecutor: 'bot'`. The initiator is `context.chatBinding.ownerOpenId`. */
  handoffIdentity?: V3HandoffIdentityRecord;
}

export interface MaterializedSavedWorkflowRun {
  runId: string;
  runDir: string;
  dag: V3Dag;
  spec: Spec;
  resolvedParams: Record<string, unknown>;
  resolvedContext: Partial<Record<SavedWorkflowBuiltinContextRef, string>>;
  botSnapshots: Map<string, BotSnapshot>;
  envelope: V3SavedDefinitionRunEnvelope;
}

function resolveContext(
  refs: readonly SavedWorkflowBuiltinContextRef[],
  context: SavedWorkflowMaterializeContext | undefined,
): Partial<Record<SavedWorkflowBuiltinContextRef, string>> {
  const binding = context?.chatBinding;
  const available: Partial<Record<SavedWorkflowBuiltinContextRef, string | undefined>> = {
    chatId: binding?.chatId,
    larkAppId: binding?.larkAppId,
    chatType: binding?.chatType,
    rootMessageId: binding?.rootMessageId,
    initiatorOpenId: context?.initiatorOpenId ?? binding?.ownerOpenId,
  };
  const resolved: Partial<Record<SavedWorkflowBuiltinContextRef, string>> = {};
  for (const ref of refs) {
    const value = available[ref];
    if (!value) throw new Error(`Saved Workflow requires context.${ref}, but it is unavailable`);
    resolved[ref] = value;
  }
  return resolved;
}

function writeJson0600(path: string, value: unknown): void {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Published revision → fresh immutable v3 run directory. */
export function materializeSavedWorkflowRun(
  input: MaterializeSavedWorkflowRunInput,
): MaterializedSavedWorkflowRun {
  if (input.metadata.workflowId !== input.revision.payload.workflowId) {
    throw new Error('Saved Workflow metadata/revision workflowId mismatch');
  }
  if (input.metadata.status !== 'active' || input.metadata.publishedRevision !== input.revision.revisionId) {
    throw new Error('Saved Workflow revision is not the active published revision');
  }
  if (input.metadata.owner.larkAppId !== input.context?.chatBinding?.larkAppId) {
    throw new Error(
      `Saved Workflow '${input.metadata.workflowId}' cannot be materialized outside its owning app`,
    );
  }
  if (
    input.metadata.scope.kind === 'chat' &&
    input.metadata.scope.chatId !== input.context?.chatBinding?.chatId
  ) {
    throw new Error(
      `Saved Workflow '${input.metadata.workflowId}' cannot be materialized outside its chat scope`,
    );
  }
  assertSavedWorkflowTemplateBindings(
    input.revision.payload.dagTemplate,
    input.revision.payload.inputs,
    input.revision.payload.contextRefs,
  );

  const now = input.now ?? new Date();
  const runId = input.runId ?? mintV3RunId(input.metadata.displayName, now);
  if (!isValidRunId(runId)) throw new Error(`invalid Saved Workflow runId: ${JSON.stringify(runId)}`);
  mkdirSync(input.baseDir, { recursive: true, mode: 0o700 });
  const runDir = join(input.baseDir, runId);

  const sensitiveParams = Object.entries(input.revision.payload.inputs)
    .filter(([, definition]) => definition.sensitive === true)
    .map(([name]) => name);
  if (sensitiveParams.length > 0) {
    throw new Error(
      `Saved Workflow sensitive parameters are not executable yet (${sensitiveParams.join(', ')}): ` +
      'P0 does not persist secrets in run artifacts; use a bot-managed credential or remove sensitive=true.',
    );
  }

  const paramSchema = { params: input.revision.payload.inputs };
  // v3 owns a strict revision schema, so fail loudly even when this low-level
  // materializer is called with an object not loaded through library-store.
  // The shared coercer itself stays permissive for the v2 migration window.
  validateWorkflowParamSchema(paramSchema);
  const resolvedParams = coerceWorkflowParams(
    paramSchema,
    input.rawParams ?? {},
  );
  const resolvedContext = resolveContext(input.revision.payload.contextRefs, input.context);
  const dag = validateDag({
    ...(input.revision.payload.dagTemplate.schemaVersion !== undefined
      ? { schemaVersion: input.revision.payload.dagTemplate.schemaVersion }
      : {}),
    runId,
    nodes: cloneNodes(input.revision.payload.dagTemplate.nodes),
  });
  const spec = validateSpec({ ...input.revision.payload.specTemplate, runId });
  const botSnapshots = freezeDagBotSnapshots(dag, input.bots, input.nodeExecutor === 'bot'
    ? { defaultSelector: input.context?.chatBinding?.larkAppId }
    : {});

  // Reserve the final run id across cooperating CLI/daemon processes. A plain
  // exists+rename sequence can replace an empty directory on POSIX when two
  // callers race with the same explicit runId.
  const initiator = feishuRunInitiator(input.context?.chatBinding?.ownerOpenId, input.handoffIdentity);
  const savedConfirmation = savedWorkflowRunFlowConfirmation(input.revision);
  return withFileLockSync(runDir, () => {
    if (existsSync(runDir)) throw new Error(`v3 run already exists: ${runId}`);

    // Stage under the same base filesystem, but keep the staged run directory's
    // basename equal to runId because publishRunEnvelopeOnce validates it.
    const stagingRoot = join(input.baseDir, `.staging-${randomUUID()}`);
    const stagedRunDir = join(stagingRoot, runId);
    mkdirSync(stagedRunDir, { recursive: true, mode: 0o700 });
    try {
      writeJson0600(join(stagedRunDir, 'dag.json'), dag);
      writeJson0600(join(stagedRunDir, 'spec.json'), spec);
      writeJson0600(
        join(stagedRunDir, 'bots.snapshot.json'),
        serializeFrozenBotSnapshots(botSnapshots),
      );
      writeJson0600(join(stagedRunDir, 'params.resolved.json'), {
        params: resolvedParams,
        context: resolvedContext,
      });
      writeJson0600(join(stagedRunDir, 'definition.snapshot.json'), {
        schemaVersion: 1,
        workflowId: input.metadata.workflowId,
        revisionId: input.revision.revisionId,
        contentHash: input.revision.contentHash,
        humanVersion: input.revision.payload.humanVersion,
        storedSchemaVersion: input.revision.storedSchemaVersion,
        materializedSchemaVersion: input.revision.schemaVersion,
        definition: input.revision.payload,
        instantiatedAt: now.toISOString(),
      });
      const artifacts = {
        dag: artifactRef(stagedRunDir, 'dag.json'),
        spec: artifactRef(stagedRunDir, 'spec.json'),
        botSnapshots: artifactRef(stagedRunDir, 'bots.snapshot.json'),
        resolvedParams: artifactRef(stagedRunDir, 'params.resolved.json'),
        definitionSnapshot: artifactRef(stagedRunDir, 'definition.snapshot.json'),
      };
      const envelope = makeSavedDefinitionRunEnvelope({
        runId,
        workflowId: input.metadata.workflowId,
        revisionId: input.revision.revisionId,
        humanVersion: input.revision.payload.humanVersion,
        createdAt: now.toISOString(),
        authorizedAt: now.toISOString(),
        ...(input.context?.chatBinding ? { chatBinding: input.context.chatBinding } : {}),
        ...(input.nodeExecutor ? { nodeExecutor: input.nodeExecutor } : {}),
        ...(input.nodeExecutor && input.handoffIdentity ? { handoffIdentity: input.handoffIdentity } : {}),
        // The run's initiator (design 2026-11-03 workflow-dashboard-orchestration
        // §7.3): the `/workflow run` sender, bot runs only.
        ...(input.nodeExecutor === 'bot' && initiator ? { initiator } : {}),
        // A version saved from a Dashboard draft carries its confirmation (I13).
        ...(savedConfirmation ? { flowConfirmation: savedConfirmation } : {}),
        artifacts,
      });
      publishRunEnvelopeOnce(stagedRunDir, envelope);
      renameSync(stagedRunDir, runDir);
      rmSync(stagingRoot, { recursive: true, force: true });
      // publishRunEnvelopeOnce made the staged directory's contents durable;
      // persist the cross-directory rename before reporting a runnable final
      // path. Directory fsync may be unsupported on a narrow set of hosts, in
      // which case the portable helper deliberately degrades to best-effort.
      fsyncDirectorySyncPortable(input.baseDir);
      return {
        runId,
        runDir,
        dag,
        spec,
        resolvedParams,
        resolvedContext,
        botSnapshots,
        envelope,
      };
    } catch (err) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw err;
    }
  });
}

/** Convenience for tests/command responses. */
export function savedWorkflowRunIdFromDir(runDir: string): string {
  return basename(runDir);
}

/** Convenience for callers that need to derive the runs root from a runDir. */
export function savedWorkflowRunsRoot(runDir: string): string {
  return dirname(runDir);
}
