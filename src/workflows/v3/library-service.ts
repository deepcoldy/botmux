/**
 * Host-neutral application service for v3 Saved Workflows.
 *
 * The schema/store/materializer modules own persistence and execution
 * contracts.  This layer adds the user-context rules shared by future CLI,
 * IM, and dashboard adapters: source-run ownership, chat/global visibility,
 * explicit name ambiguity, owner-only revision updates, and published-only
 * instantiation.  It has no daemon/session-store dependency; hosts pass the
 * already-authenticated actor + chat context in.
 */

import type { BotConfig } from '../../bot-registry.js';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { withFileLock, withFileLockSync } from '../../utils/file-lock.js';
import type { RawParamInput } from '../shared/params.js';
import {
  compileSavedWorkflowFromRun,
  materializeSavedWorkflowRun,
  type CompileSavedWorkflowFromRunOptions,
  type MaterializedSavedWorkflowRun,
} from './library-materialize.js';
import {
  SAVED_WORKFLOW_ID_RE,
  canonicalJsonStringify,
  normalizeSavedWorkflowLookupKey,
  validateSavedWorkflowRevisionPayload,
  type SavedWorkflowMetadata,
  type SavedWorkflowOwner,
  type SavedWorkflowScope,
} from './library-schema.js';
import {
  SavedWorkflowConflictError,
  SavedWorkflowNotFoundError,
  SavedWorkflowPermissionError,
  appendSavedWorkflowRevision,
  createSavedWorkflow,
  listSavedWorkflows,
  loadCurrentSavedWorkflow,
  readSavedWorkflowMetadata,
  savedWorkflowDir,
  workflowLibraryRoot,
  type SavedWorkflowListResult,
  type SavedWorkflowWriteResult,
} from './library-store.js';
import {
  artifactRef,
  loadAuthorizedV3Run,
  makeLegacyV3RunEnvelope,
  publishRunEnvelopeOnce,
  readRunEnvelope,
  type LoadedAuthorizedV3Run,
} from './run-envelope.js';
import { isValidRunId } from './ops-projection.js';
import { readJournal } from './journal.js';
import { materialize } from './state.js';
import { readGrillState } from './grill-state.js';
import { loadDag } from './dag.js';
import { validateSpec } from './spec.js';
import { parseFrozenBotSnapshots } from './bot-resolve.js';

export interface SavedWorkflowActorContext {
  actor: SavedWorkflowOwner;
  /** Current invocation chat. Optional for a global-only list/resolve. */
  chatId?: string;
  chatType?: 'group' | 'p2p';
  rootMessageId?: string;
  sessionId?: string;
}

export type SavedWorkflowServiceErrorCode =
  | 'invalid_context'
  | 'source_not_owned'
  | 'scope_mismatch'
  | 'not_found'
  | 'ambiguous'
  | 'not_published';

export class SavedWorkflowServiceError extends Error {
  constructor(
    public readonly code: SavedWorkflowServiceErrorCode,
    message: string,
    public readonly matches: SavedWorkflowMetadata[] = [],
  ) {
    super(message);
    this.name = 'SavedWorkflowServiceError';
  }
}

interface SaveTerminalRunBase {
  dataDir: string;
  runDir: string;
  context: SavedWorkflowActorContext;
  /** Failed/blocked sources are draft-only and require this explicit opt-in. */
  allowDraft?: boolean;
  acknowledgeUnsafeLiterals?: boolean;
  now?: Date;
}

export interface SaveTerminalRunAsNewWorkflowInput extends SaveTerminalRunBase {
  workflowId?: never;
  displayName?: string;
  aliases?: string[];
  /** Defaults to the current chat. Global publication must be explicit. */
  scope?: 'chat' | 'global';
}

export interface AppendTerminalRunToWorkflowInput extends SaveTerminalRunBase {
  /** Supplying an id always means append; it never creates implicitly. */
  workflowId: string;
  expectedLatestRevision?: string;
  displayName?: never;
  aliases?: never;
  scope?: never;
}

export type SaveTerminalRunAsWorkflowInput =
  | SaveTerminalRunAsNewWorkflowInput
  | AppendTerminalRunToWorkflowInput;

export type SaveTerminalRunAsWorkflowIdempotentInput =
  Omit<SaveTerminalRunAsNewWorkflowInput, 'allowDraft'> & { allowDraft?: never };

export interface SaveTerminalRunAsWorkflowResult extends SavedWorkflowWriteResult {
  sourceStatus: 'succeeded' | 'failed' | 'blocked';
  created: boolean;
}

/**
 * Stable identity for the default "save this completed run" action. Scope and
 * display name are intentionally excluded: the first valid save wins, so a
 * retried command/card callback can never fork duplicate definitions.
 */
export function savedWorkflowIdForSourceRun(loaded: LoadedAuthorizedV3Run): string {
  const binding = loaded.envelope.chatBinding;
  if (!binding?.ownerOpenId) {
    throw new SavedWorkflowServiceError(
      'source_not_owned',
      `Source run '${loaded.envelope.runId}' has no authenticated owner binding`,
    );
  }
  const specSha256 = 'spec' in loaded.envelope.artifacts
    ? loaded.envelope.artifacts.spec?.sha256 ?? ''
    : '';
  const digest = createHash('sha256')
    .update([
      'v3-terminal-save:v1',
      loaded.envelope.runId,
      loaded.envelope.artifacts.dag.sha256,
      specSha256,
      binding.ownerOpenId,
      binding.larkAppId,
      binding.chatId,
    ].join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `wf_${digest}`;
}

function comparableRevisionDraft(payload: SavedWorkflowWriteResult['revision']['payload']): unknown {
  return {
    ...(payload.sourceRunId ? { sourceRunId: payload.sourceRunId } : {}),
    inputs: payload.inputs,
    contextRefs: payload.contextRefs,
    specTemplate: payload.specTemplate,
    specStatus: payload.specStatus,
    dagTemplate: payload.dagTemplate,
    safety: payload.safety,
  };
}

async function loadMatchingIdempotentSave(
  dataDir: string,
  workflowId: string,
  context: SavedWorkflowActorContext,
  revision: ReturnType<typeof compileSavedWorkflowFromRun>['revision'],
): Promise<SavedWorkflowWriteResult> {
  const current = await loadCurrentSavedWorkflow(dataDir, workflowId, {
    revision: 'latest',
    requireActive: false,
  });
  if (!sameOwner(current.metadata.owner, context.actor)) {
    throw new SavedWorkflowConflictError(
      `Idempotent saved workflow '${workflowId}' belongs to a different owner`,
    );
  }
  if (
    current.metadata.status !== 'active' ||
    current.metadata.publishedRevision !== current.revision.revisionId
  ) {
    throw new SavedWorkflowConflictError(
      `Idempotent saved workflow '${workflowId}' is no longer the active published result`,
    );
  }
  if (
    canonicalJsonStringify(comparableRevisionDraft(current.revision.payload)) !==
    canonicalJsonStringify(revision)
  ) {
    throw new SavedWorkflowConflictError(
      `Idempotent saved workflow '${workflowId}' does not match source run artifacts`,
    );
  }
  return current;
}

async function createSavedWorkflowIdempotently(input: {
  dataDir: string;
  workflowId: string;
  displayName: string;
  aliases?: string[];
  owner: SavedWorkflowOwner;
  scope: SavedWorkflowScope;
  revision: ReturnType<typeof compileSavedWorkflowFromRun>['revision'];
  publish: boolean;
  context: SavedWorkflowActorContext;
  now?: Date;
}): Promise<SavedWorkflowWriteResult & { created: boolean }> {
  const root = workflowLibraryRoot(input.dataDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lockTarget = join(root, `.terminal-save-${input.workflowId}`);
  return withFileLock(lockTarget, async () => {
    try {
      const existing = await loadMatchingIdempotentSave(
        input.dataDir,
        input.workflowId,
        input.context,
        input.revision,
      );
      return { ...existing, created: false };
    } catch (err) {
      if (!(err instanceof SavedWorkflowNotFoundError)) throw err;
    }

    // A process may have died after creating the private directory but before
    // metadata.json became the store's commit marker. The deterministic source
    // lock makes this directory ours; remove only that uncommitted remnant.
    const dir = savedWorkflowDir(input.dataDir, input.workflowId);
    const metadataPath = join(dir, 'metadata.json');
    if (existsSync(dir) && !existsSync(metadataPath)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    try {
      const written = await createSavedWorkflow(input.dataDir, {
        workflowId: input.workflowId,
        displayName: input.displayName,
        aliases: input.aliases,
        owner: input.owner,
        scope: input.scope,
        revision: input.revision,
        publish: input.publish,
        now: input.now,
      });
      return { ...written, created: true };
    } catch (err) {
      if (!(err instanceof SavedWorkflowConflictError)) throw err;
      const existing = await loadMatchingIdempotentSave(
        input.dataDir,
        input.workflowId,
        input.context,
        input.revision,
      );
      return { ...existing, created: false };
    }
  });
}

export interface ListVisibleSavedWorkflowsInput {
  dataDir: string;
  context: SavedWorkflowActorContext;
  includeArchived?: boolean;
  includeDrafts?: boolean;
}

export interface ResolveVisibleSavedWorkflowInput extends ListVisibleSavedWorkflowsInput {
  ref: string;
}

export interface InstantiatePublishedSavedWorkflowInput {
  dataDir: string;
  ref: string;
  context: SavedWorkflowActorContext;
  rawParams?: Record<string, RawParamInput>;
  bots: BotConfig[];
  baseDir: string;
  runId?: string;
  now?: Date;
}

export interface ResolveOwnedTerminalRunInput {
  baseDir: string;
  source: 'last' | string;
  context: SavedWorkflowActorContext;
}

type TerminalSourceStatus = 'succeeded' | 'failed' | 'blocked';

function terminalSourceStatus(runDir: string, runId: string): TerminalSourceStatus {
  const events = readJournal(join(runDir, 'journal.ndjson'));
  const starts = events.filter((event) => event.type === 'runStarted');
  if (starts.length !== 1 || starts[0]!.runId !== runId) {
    throw new SavedWorkflowServiceError(
      'invalid_context',
      `Run '${runId}' has no single matching runStarted identity`,
    );
  }
  const status = materialize(events).runStatus;
  if (status !== 'succeeded' && status !== 'failed' && status !== 'blocked') {
    throw new SavedWorkflowServiceError(
      'invalid_context',
      `Run '${runId}' is not terminal (status=${status})`,
    );
  }
  return status;
}

/**
 * Strictly load a terminal source and opportunistically seal the narrow class
 * of pre-run.json v3 runs whose ownership is still provable from their
 * Gate-2 grill binding. Historical runs without ownerOpenId remain rejected:
 * assigning them to whoever asks first in a shared chat would be an ownership
 * escalation, not a migration.
 */
function loadOwnedTerminalRunForSave(
  runDir: string,
  context: SavedWorkflowActorContext,
): { loaded: LoadedAuthorizedV3Run; status: TerminalSourceStatus } {
  const runId = basename(runDir);
  if (!isValidRunId(runId)) {
    throw new SavedWorkflowServiceError('invalid_context', `Invalid source runId ${JSON.stringify(runId)}`);
  }

  const sealIfNeeded = (): void => {
    const initial = readRunEnvelope(runDir, runId);
    if (initial.kind === 'ok') return;
    if (initial.kind === 'invalid') {
      throw new SavedWorkflowServiceError(
        'invalid_context',
        `Run '${runId}' has an invalid run.json: ${initial.problems.join('; ')}`,
      );
    }

    withFileLockSync(join(runDir, 'run.json'), () => {
      const current = readRunEnvelope(runDir, runId);
      if (current.kind === 'ok') return;
      if (current.kind === 'invalid') {
        throw new SavedWorkflowServiceError(
          'invalid_context',
          `Run '${runId}' has an invalid run.json: ${current.problems.join('; ')}`,
        );
      }

      const grill = readGrillState(runDir);
      const binding = grill?.chatBinding;
      if (
        !grill ||
        grill.runId !== runId ||
        grill.status !== 'dag_approved' ||
        !binding ||
        !binding.ownerOpenId
      ) {
        throw new SavedWorkflowServiceError(
          'invalid_context',
          `Run '${runId}' predates Saved Workflow sealing and its owner cannot be proven. ` +
          'Re-run it on the current version, or migrate it explicitly as an administrator.',
        );
      }
      if (
        binding.ownerOpenId !== context.actor.openId ||
        binding.larkAppId !== context.actor.larkAppId ||
        binding.chatId !== context.chatId
      ) {
        throw new SavedWorkflowServiceError('source_not_owned', `Source run '${runId}' belongs to a different actor`);
      }

      const dagPath = join(runDir, 'dag.json');
      const specPath = join(runDir, 'spec.json');
      const botPath = join(runDir, 'bots.snapshot.json');
      if (![dagPath, specPath, botPath].every(existsSync)) {
        throw new SavedWorkflowServiceError(
          'invalid_context',
          `Run '${runId}' is missing canonical dag/spec/bot artifacts and cannot be sealed for saving`,
        );
      }
      const dag = loadDag(dagPath);
      if (dag.runId !== runId) throw new Error(`legacy DAG runId mismatch: ${dag.runId}`);
      const spec = validateSpec(JSON.parse(readFileSync(specPath, 'utf-8')));
      if (spec.runId !== runId) throw new Error(`legacy spec runId mismatch: ${spec.runId}`);
      parseFrozenBotSnapshots(JSON.parse(readFileSync(botPath, 'utf-8')), dag);
      terminalSourceStatus(runDir, runId);

      publishRunEnvelopeOnce(runDir, makeLegacyV3RunEnvelope({
        runId,
        createdAt: grill.createdAt,
        backfilledAt: new Date().toISOString(),
        original: 'grill',
        basis: 'runtime_started',
        chatBinding: binding,
        artifacts: {
          dag: artifactRef(runDir, 'dag.json'),
          spec: artifactRef(runDir, 'spec.json'),
          botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
        },
      }));
    });
  };

  sealIfNeeded();
  const loaded = loadAuthorizedV3Run(runDir, {
    allowedSources: ['ad_hoc', 'saved_definition', 'legacy_v3'],
  });
  assertSourceOwnedByCaller(loaded, context);
  return { loaded, status: terminalSourceStatus(runDir, runId) };
}

/** Resolve `last` within the authenticated actor+chat scope, never globally. */
export async function resolveOwnedTerminalRunDir(
  input: ResolveOwnedTerminalRunInput,
): Promise<string> {
  const context = requireActorContext(input.context, { requireChat: true });
  if (input.source !== 'last') {
    if (!isValidRunId(input.source)) {
      throw new SavedWorkflowServiceError('invalid_context', `Invalid source runId ${JSON.stringify(input.source)}`);
    }
    const runDir = join(input.baseDir, input.source);
    try {
      const stat = await fs.stat(runDir);
      if (!stat.isDirectory()) throw notFound(input.source);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound(input.source);
      throw err;
    }
    loadOwnedTerminalRunForSave(runDir, context);
    return runDir;
  }

  let names: string[];
  try { names = await fs.readdir(input.baseDir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('last run');
    throw err;
  }
  const candidates: Array<{ runDir: string; createdAt: string; runId: string }> = [];
  for (const runId of names) {
    if (!isValidRunId(runId)) continue;
    const runDir = join(input.baseDir, runId);
    try {
      const stat = await fs.stat(runDir);
      if (!stat.isDirectory()) continue;
      const candidate = loadOwnedTerminalRunForSave(runDir, context);
      candidates.push({ runDir, createdAt: candidate.loaded.envelope.createdAt, runId });
    } catch { /* malformed/incomplete candidate is not "last terminal" */ }
  }
  candidates.sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
  if (candidates.length === 0) throw notFound('last run');
  return candidates[0]!.runDir;
}

/**
 * Save a terminal run exactly as executed.
 *
 * There is deliberately no literal-to-parameter inference here. Ad-hoc runs
 * become zero-parameter definitions. When the source itself came from a saved
 * definition, its already-explicit input/context declarations are preserved
 * from the integrity-pinned definition snapshot.
 */
export async function saveTerminalRunAsWorkflow(
  input: SaveTerminalRunAsWorkflowInput,
): Promise<SaveTerminalRunAsWorkflowResult> {
  const context = requireActorContext(input.context, { requireChat: true });
  const { loaded } = loadOwnedTerminalRunForSave(input.runDir, context);

  const compileOptions = exactCompileOptions(
    loaded,
    input.allowDraft === true,
    input.acknowledgeUnsafeLiterals === true,
  );
  const compiled = compileSavedWorkflowFromRun(input.runDir, compileOptions);

  if (input.workflowId !== undefined) {
    let metadata: SavedWorkflowMetadata;
    try {
      metadata = await readSavedWorkflowMetadata(input.dataDir, input.workflowId);
    } catch (err) {
      if (err instanceof SavedWorkflowNotFoundError) throw notFound(input.workflowId);
      throw err;
    }
    assertMetadataVisibleInContext(metadata, context);
    if (!sameOwner(metadata.owner, context.actor)) {
      throw new SavedWorkflowPermissionError(metadata.workflowId);
    }
    const written = await appendSavedWorkflowRevision(input.dataDir, input.workflowId, {
      actor: context.actor,
      revision: compiled.revision,
      publish: compiled.publish,
      expectedLatestRevision: input.expectedLatestRevision,
      now: input.now,
    });
    return { ...written, sourceStatus: compiled.sourceStatus, created: false };
  }

  const scope: SavedWorkflowScope = input.scope === 'global'
    ? { kind: 'global' }
    : { kind: 'chat', chatId: context.chatId! };
  const written = await createSavedWorkflow(input.dataDir, {
    displayName: input.displayName ?? compiled.displayName,
    aliases: input.aliases,
    owner: context.actor,
    scope,
    revision: compiled.revision,
    publish: compiled.publish,
    now: input.now,
  });
  return { ...written, sourceStatus: compiled.sourceStatus, created: true };
}

/**
 * Card callbacks can be delivered or clicked more than once. This dedicated
 * seam gives that surface stable source-run idempotency without changing the
 * existing `/workflow save` command semantics (which may intentionally create
 * another definition with a different name/scope).
 */
export async function saveTerminalRunAsWorkflowIdempotent(
  input: SaveTerminalRunAsWorkflowIdempotentInput,
): Promise<SaveTerminalRunAsWorkflowResult> {
  const context = requireActorContext(input.context, { requireChat: true });
  const { loaded } = loadOwnedTerminalRunForSave(input.runDir, context);
  const compileOptions = exactCompileOptions(
    loaded,
    false,
    input.acknowledgeUnsafeLiterals === true,
  );
  const compiled = compileSavedWorkflowFromRun(input.runDir, compileOptions);
  const scope: SavedWorkflowScope = input.scope === 'global'
    ? { kind: 'global' }
    : { kind: 'chat', chatId: context.chatId! };
  const workflowId = savedWorkflowIdForSourceRun(loaded);
  const written = await createSavedWorkflowIdempotently({
    workflowId,
    dataDir: input.dataDir,
    displayName: input.displayName ?? compiled.displayName,
    aliases: input.aliases,
    owner: context.actor,
    scope,
    revision: compiled.revision,
    publish: compiled.publish,
    context,
    now: input.now,
  });
  return { ...written, sourceStatus: compiled.sourceStatus, created: written.created };
}

/** List the current chat's workflows plus global workflows. */
export async function listVisibleSavedWorkflows(
  input: ListVisibleSavedWorkflowsInput,
): Promise<SavedWorkflowListResult> {
  const context = requireActorContext(input.context);
  const listed = await listSavedWorkflows(input.dataDir, {
    chatId: context.chatId,
    actor: context.actor,
    includeArchived: input.includeArchived,
    includeDrafts: input.includeDrafts,
  });
  // Archived definitions are management state, not a shared catalog surface.
  // Even when explicitly requested, only their owner sees them.
  return {
    entries: listed.entries.filter((metadata) =>
      metadata.status !== 'archived' || sameOwner(metadata.owner, context.actor)),
    // A malformed directory has no trustworthy app owner. Exposing even its
    // count would leak shared-dataDir state across bots, so user-facing list
    // operations omit it. Store-level diagnostics remain available to ops.
    invalid: [],
  };
}

/**
 * Resolve a visible id/name/alias. Exact workflowId wins; names never silently
 * prefer chat over global, so a collision is returned as an explicit error.
 */
export async function resolveVisibleSavedWorkflow(
  input: ResolveVisibleSavedWorkflowInput,
): Promise<SavedWorkflowMetadata> {
  const ref = input.ref.trim();
  if (!ref) {
    throw new SavedWorkflowServiceError('invalid_context', 'Saved Workflow reference must not be empty');
  }
  const listed = await listVisibleSavedWorkflows(input);
  if (SAVED_WORKFLOW_ID_RE.test(ref)) {
    const exact = listed.entries.find((entry) => entry.workflowId === ref);
    if (exact) return exact;
    throw notFound(ref);
  }

  const key = normalizeSavedWorkflowLookupKey(ref);
  const matches = listed.entries.filter((metadata) =>
    normalizeSavedWorkflowLookupKey(metadata.displayName) === key ||
    metadata.aliases.some((alias) => normalizeSavedWorkflowLookupKey(alias) === key));
  if (matches.length === 0) throw notFound(ref);
  if (matches.length > 1) {
    throw new SavedWorkflowServiceError(
      'ambiguous',
      `Saved Workflow reference ${JSON.stringify(ref)} is ambiguous; use a workflowId`,
      matches,
    );
  }
  return matches[0]!;
}

/** Resolve and re-check visibility after the second metadata/revision read. */
export async function loadVisibleSavedWorkflow(
  input: ResolveVisibleSavedWorkflowInput,
  deps: {
    resolveVisible?: typeof resolveVisibleSavedWorkflow;
    loadCurrent?: typeof loadCurrentSavedWorkflow;
  } = {},
): Promise<SavedWorkflowWriteResult> {
  const context = requireActorContext(input.context);
  const resolveVisible = deps.resolveVisible ?? resolveVisibleSavedWorkflow;
  const loadCurrent = deps.loadCurrent ?? loadCurrentSavedWorkflow;
  const resolved = await resolveVisible({ ...input, context });
  let current: SavedWorkflowWriteResult;
  try {
    current = await loadCurrent(input.dataDir, resolved.workflowId, {
      revision: resolved.publishedRevision ? 'published' : 'latest',
      requireActive: false,
    });
  } catch (err) {
    if (err instanceof SavedWorkflowNotFoundError) throw notFound(resolved.workflowId);
    throw err;
  }
  // Metadata is mutable. Re-check after loading the revision so a concurrent
  // archive/scope/app change cannot disclose the second read through show.
  assertMetadataVisibleInContext(current.metadata, context);
  return current;
}

/** Resolve the active revision and atomically materialize a fresh authorized run. */
export async function instantiatePublishedSavedWorkflow(
  input: InstantiatePublishedSavedWorkflowInput,
): Promise<MaterializedSavedWorkflowRun> {
  const context = requireActorContext(input.context, { requireChat: true });
  const resolved = await resolveVisibleSavedWorkflow({
    dataDir: input.dataDir,
    ref: input.ref,
    context,
    includeDrafts: true,
  });
  if (resolved.status !== 'active' || !resolved.publishedRevision) {
    throw new SavedWorkflowServiceError(
      'not_published',
      `Saved Workflow '${resolved.workflowId}' has no published revision`,
    );
  }

  let current;
  try {
    current = await loadCurrentSavedWorkflow(input.dataDir, resolved.workflowId, {
      revision: 'published',
      requireActive: true,
    });
  } catch (err) {
    if (err instanceof SavedWorkflowNotFoundError) throw notFound(resolved.workflowId);
    if (err instanceof SavedWorkflowConflictError) {
      throw new SavedWorkflowServiceError(
        'not_published',
        `Saved Workflow '${resolved.workflowId}' no longer has an active published revision`,
      );
    }
    throw err;
  }
  // Re-check after the second store read so an archive/scope race cannot make a
  // definition executable after it ceased to be visible to this caller.
  assertMetadataVisibleInContext(current.metadata, context);
  if (current.metadata.status !== 'active' || !current.metadata.publishedRevision) {
    throw new SavedWorkflowServiceError(
      'not_published',
      `Saved Workflow '${current.metadata.workflowId}' has no published revision`,
    );
  }

  return materializeSavedWorkflowRun({
    metadata: current.metadata,
    revision: current.revision,
    rawParams: input.rawParams,
    context: {
      initiatorOpenId: context.actor.openId,
      chatBinding: {
        larkAppId: context.actor.larkAppId,
        chatId: context.chatId!,
        ...(context.chatType ? { chatType: context.chatType } : {}),
        ...(context.rootMessageId ? { rootMessageId: context.rootMessageId } : {}),
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        ownerOpenId: context.actor.openId,
      },
    },
    bots: input.bots,
    baseDir: input.baseDir,
    runId: input.runId,
    now: input.now,
  });
}

function requireActorContext(
  context: SavedWorkflowActorContext,
  opts: { requireChat?: boolean } = {},
): SavedWorkflowActorContext {
  if (!context?.actor?.openId?.trim() || !context.actor.larkAppId?.trim()) {
    throw new SavedWorkflowServiceError(
      'invalid_context',
      'Saved Workflow actor requires non-empty openId and larkAppId',
    );
  }
  if (context.chatId !== undefined && !context.chatId.trim()) {
    throw new SavedWorkflowServiceError('invalid_context', 'Saved Workflow chatId must not be empty');
  }
  if (opts.requireChat && !context.chatId) {
    throw new SavedWorkflowServiceError('invalid_context', 'This Saved Workflow operation requires a chat context');
  }
  return context;
}

function sameOwner(a: SavedWorkflowOwner, b: SavedWorkflowOwner): boolean {
  return a.openId === b.openId && a.larkAppId === b.larkAppId;
}

function assertSourceOwnedByCaller(
  loaded: LoadedAuthorizedV3Run,
  context: SavedWorkflowActorContext,
): void {
  const binding = loaded.envelope.chatBinding;
  if (!binding) {
    throw new SavedWorkflowServiceError(
      'source_not_owned',
      `Source run '${loaded.envelope.runId}' has no authenticated chat owner binding`,
    );
  }
  if (binding.chatId !== context.chatId) {
    throw new SavedWorkflowServiceError(
      'scope_mismatch',
      `Source run '${loaded.envelope.runId}' belongs to a different chat`,
    );
  }
  if (
    binding.larkAppId !== context.actor.larkAppId ||
    !binding.ownerOpenId ||
    binding.ownerOpenId !== context.actor.openId
  ) {
    throw new SavedWorkflowServiceError(
      'source_not_owned',
      `Source run '${loaded.envelope.runId}' belongs to a different actor`,
    );
  }
}

function assertMetadataVisibleInContext(
  metadata: SavedWorkflowMetadata,
  context: SavedWorkflowActorContext,
): void {
  // Treat a cross-app lookup exactly like a missing workflow: callers must not
  // learn whether another bot sharing dataDir owns this id/name.
  if (metadata.owner.larkAppId !== context.actor.larkAppId) throw notFound(metadata.workflowId);
  if (metadata.status === 'archived') throw notFound(metadata.workflowId);
  if (metadata.scope.kind === 'chat' && metadata.scope.chatId !== context.chatId) {
    throw new SavedWorkflowServiceError(
      'scope_mismatch',
      `Saved Workflow '${metadata.workflowId}' belongs to a different chat`,
    );
  }
  if (metadata.status === 'draft' && !sameOwner(metadata.owner, context.actor)) {
    throw notFound(metadata.workflowId);
  }
}

function exactCompileOptions(
  loaded: LoadedAuthorizedV3Run,
  allowDraft: boolean,
  acknowledgeUnsafeLiterals = false,
): CompileSavedWorkflowFromRunOptions {
  const opts: CompileSavedWorkflowFromRunOptions = { allowDraft, acknowledgeUnsafeLiterals };
  if (loaded.envelope.source.kind !== 'saved_definition') return opts;

  const snapshot = loaded.definitionSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('cannot save workflow: saved-definition source has no valid definition snapshot');
  }
  const record = snapshot as Record<string, unknown>;
  const payload = validateSavedWorkflowRevisionPayload(record.definition);
  const source = loaded.envelope.source;
  if (
    record.workflowId !== source.workflowId ||
    record.revisionId !== source.revisionId ||
    record.humanVersion !== source.humanVersion ||
    payload.workflowId !== source.workflowId ||
    payload.humanVersion !== source.humanVersion
  ) {
    throw new Error('cannot save workflow: definition snapshot identity does not match run envelope');
  }
  opts.inputs = payload.inputs;
  opts.contextRefs = payload.contextRefs;
  opts.specStatus = payload.specStatus;
  return opts;
}

function notFound(ref: string): SavedWorkflowServiceError {
  return new SavedWorkflowServiceError(
    'not_found',
    `Saved Workflow ${JSON.stringify(ref)} was not found in the current scope`,
  );
}
