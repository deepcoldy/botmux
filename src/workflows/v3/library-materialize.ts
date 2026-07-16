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
import { materialize } from './state.js';
import { validateSpec } from './spec.js';
import { mintV3RunId, type RunChatBinding } from './grill-state.js';
import { isValidRunId } from './ops-projection.js';
import {
  computeSavedWorkflowGateDigest,
  computeSavedWorkflowSideEffects,
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
  makeSavedDefinitionRunEnvelope,
  publishRunEnvelopeOnce,
  type LoadedAuthorizedV3Run,
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
  /** Explicit user confirmation after reviewing free-text secret/path lint. */
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
  const normalizedNodes = canonicalizeNodeBots(cloneNodes(loaded.dag.nodes), snapshots);
  const dagTemplate = validateDagTemplate({ nodes: normalizedNodes });
  const { runId: _runId, ...specWithoutRunId } = loaded.spec;
  const specTemplate = validateSpecTemplate(specWithoutRunId);
  const inputs = opts.inputs ?? {};
  const contextRefs = opts.contextRefs ?? collectSavedWorkflowTemplateBindings(dagTemplate).context;
  assertSavedWorkflowTemplateBindings(dagTemplate, inputs, contextRefs);
  const lintWarnings: string[] = [];
  collectSavedWorkflowReusableTextWarnings(dagTemplate, 'dagTemplate', lintWarnings);
  collectSavedWorkflowReusableTextWarnings(specTemplate, 'specTemplate', lintWarnings);
  const revision: SavedWorkflowRevisionDraft = {
    sourceRunId: loaded.envelope.runId,
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
  return { displayName: loaded.spec.title, revision, lintWarnings };
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
  const status = materialize(readJournal(journalPath)).runStatus;
  if (status !== 'succeeded' && status !== 'failed' && status !== 'blocked') {
    throw new Error(`cannot save workflow: source run is not terminal (status=${status})`);
  }
  if (status !== 'succeeded' && opts.allowDraft !== true) {
    throw new Error(`cannot publish workflow from a ${status} run; pass allowDraft to save it as draft`);
  }

  const built = buildSavedWorkflowRevisionBaseline(loaded, opts);
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
  };
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
    runId,
    nodes: cloneNodes(input.revision.payload.dagTemplate.nodes),
  });
  const spec = validateSpec({ ...input.revision.payload.specTemplate, runId });
  const botSnapshots = freezeDagBotSnapshots(dag, input.bots);

  // Reserve the final run id across cooperating CLI/daemon processes. A plain
  // exists+rename sequence can replace an empty directory on POSIX when two
  // callers race with the same explicit runId.
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
