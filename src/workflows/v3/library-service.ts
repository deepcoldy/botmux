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
import { existsSync, promises as fs, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { withFileLock, withFileLockSync } from '../../utils/file-lock.js';
import type { RawParamInput } from '../shared/params.js';
import {
  compileDashboardSavedWorkflowFromRun,
  compileSavedWorkflowFromRun,
  materializeSavedWorkflowRun,
  resolveSavedWorkflowRunParams,
  type CompileSavedWorkflowFromRunOptions,
  type MaterializedSavedWorkflowRun,
} from './library-materialize.js';
import {
  SAVED_WORKFLOW_ID_RE,
  canonicalJsonStringify,
  compareSavedWorkflowGates,
  normalizeSavedWorkflowLookupKey,
  validateSavedWorkflowRevisionPayload,
  type SavedWorkflowBotChange,
  type SavedWorkflowGateComparisonAgainst,
  type SavedWorkflowRevisionDraft,
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
  listSavedWorkflowRevisions,
  loadCurrentSavedWorkflow,
  readSavedWorkflowRevision,
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
import { applySavedWorkflowParamEdits, type SavedWorkflowParamEdit } from './library-params.js';
import { readJournal } from './journal.js';
import { materialize } from './state.js';
import { readGrillState, type RunChatBinding } from './grill-state.js';
import { loadDag } from './dag-loader.js';
import { validateSpec } from './spec.js';
import { freezeDagBotSnapshots, parseFrozenBotSnapshots } from './bot-resolve.js';
import type { V3Dag } from './dag.js';
import {
  resolveV3NodeExecutor,
  v3BotExecutorTargets,
  type V3NodeExecutorPolicy,
  type V3NodeExecutorResolution,
} from './node-executor-mode.js';

export interface SavedWorkflowActorContext {
  actor: SavedWorkflowOwner;
  /** Current invocation chat. Optional for a global-only list/resolve. */
  chatId?: string;
  chatType?: 'group' | 'p2p';
  rootMessageId?: string;
  sessionId?: string;
  /** The current turn was opened by `actor`'s own message (not a scheduled
   *  task or another synthetic turn). Only such a turn may freeze the actor
   *  as a run initiator for 交接带发起人身份 (design §10.2). */
  humanTurn?: boolean;
}

export type SavedWorkflowServiceErrorCode =
  | 'invalid_context'
  | 'source_not_owned'
  // A candidate that passed ownership but is not yet terminal (still running /
  // cancelling / cancelled). Kept distinct from `invalid_context` so the `last`
  // resolver can surface an owned-but-unfinished run without falling back to a
  // misleading "not found", while malformed/no-runStarted candidates (which
  // stay `invalid_context`) are still silently dropped.
  | 'source_not_terminal'
  | 'scope_mismatch'
  | 'not_found'
  | 'ambiguous'
  | 'not_published'
  /** Bot execution is on but a node's bot fails §6.1 (design §6.3). */
  | 'executor_ineligible';

/** Structured detail for `source_not_terminal`, so callers never string-match
 *  the message. `waitingNode` is set when the run is parked on a human gate. */
export interface SourceNotTerminalDetail {
  runId: string;
  runStatus: string;
  waitingNode?: string;
  createdAt?: string;
}

export class SavedWorkflowServiceError extends Error {
  constructor(
    public readonly code: SavedWorkflowServiceErrorCode,
    message: string,
    public readonly matches: SavedWorkflowMetadata[] = [],
    public readonly detail?: SourceNotTerminalDetail,
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
  /** Runtime flow revisions in the source run; the saved definition is its
   *  final effective flow (design §13.8). */
  runtimeRevisions: number;
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
  /** Experimental node executor decision (design §6.3). Omitted = today's
   *  ephemeral execution without consulting any switch. */
  nodeExecutorPolicy?: V3NodeExecutorPolicy;
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
  const snapshot = materialize(events);
  const status = snapshot.runStatus;
  if (status !== 'succeeded' && status !== 'failed' && status !== 'blocked') {
    // Owned-but-unfinished: distinct code + structured detail so the `last`
    // resolver can report the real reason (and node-level gate) instead of a
    // misleading "not found", and downstream never string-matches this message.
    const waitingNode = firstGateWaitingNode(snapshot);
    throw new SavedWorkflowServiceError(
      'source_not_terminal',
      waitingNode
        ? `run ${runId} 还没结束，status=${status}（正在等待 ${waitingNode} 的人工审批），跑完后再 save`
        : `run ${runId} 还没结束，status=${status}，跑完后再 save`,
      [],
      { runId, runStatus: status, ...(waitingNode ? { waitingNode } : {}) },
    );
  }
  return status;
}

/** First node parked on a human gate (`gateWaiting`), if any — surfaced so the
 *  "not terminal" message can name what the run is waiting on. */
function firstGateWaitingNode(snapshot: ReturnType<typeof materialize>): string | undefined {
  for (const [nodeId, state] of snapshot.nodes) {
    if (state.status === 'gateWaiting') return nodeId;
  }
  return undefined;
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
  // Owned runs rejected *only* for being non-terminal. Kept separate so that
  // when there is no saveable terminal run we can point at the real reason
  // instead of a misleading "not found". Ownership is proven before this point
  // (assertSourceOwnedByCaller runs before terminalSourceStatus), so nothing
  // here belongs to another actor.
  const nonTerminal: Array<{ mtimeMs: number; error: SavedWorkflowServiceError }> = [];
  for (const runId of names) {
    if (!isValidRunId(runId)) continue;
    const runDir = join(input.baseDir, runId);
    try {
      const stat = await fs.stat(runDir);
      if (!stat.isDirectory()) continue;
      const candidate = loadOwnedTerminalRunForSave(runDir, context);
      candidates.push({ runDir, createdAt: candidate.loaded.envelope.createdAt, runId });
    } catch (err) {
      // Only owned-but-non-terminal candidates may inform the error. Every other
      // failure — malformed run.json, missing runStarted identity, and crucially
      // `source_not_owned` — is silently dropped so we never leak another actor's
      // runId in a shared chat.
      if (err instanceof SavedWorkflowServiceError && err.code === 'source_not_terminal') {
        nonTerminal.push({ mtimeMs: safeRunDirMtimeMs(runDir), error: err });
      }
      /* malformed/incomplete/foreign candidate is not "last terminal" */
    }
  }
  candidates.sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
  if (candidates.length === 0) {
    // No saveable terminal run. If the only reason we have nothing is an owned
    // run that simply hasn't finished, surface that (most recent first) rather
    // than "not found" — but never mention a run that failed ownership.
    if (nonTerminal.length > 0) {
      nonTerminal.sort((a, b) => b.mtimeMs - a.mtimeMs);
      throw nonTerminal[0]!.error;
    }
    throw notFound('last run');
  }
  return candidates[0]!.runDir;
}

/** Best-effort mtime for ordering non-terminal candidates; 0 if unreadable. */
function safeRunDirMtimeMs(runDir: string): number {
  try { return statSync(runDir).mtimeMs; } catch { return 0; }
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
    return { ...written, sourceStatus: compiled.sourceStatus, created: false, runtimeRevisions: compiled.runtimeRevisions };
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
  return { ...written, sourceStatus: compiled.sourceStatus, created: true, runtimeRevisions: compiled.runtimeRevisions };
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
  return {
    ...written,
    sourceStatus: compiled.sourceStatus,
    created: written.created,
    runtimeRevisions: compiled.runtimeRevisions,
  };
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
): Promise<MaterializedSavedWorkflowRun & { executorNote?: string }> {
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

  const chatBinding: RunChatBinding = {
    larkAppId: context.actor.larkAppId,
    chatId: context.chatId!,
    ...(context.chatType ? { chatType: context.chatType } : {}),
    ...(context.rootMessageId ? { rootMessageId: context.rootMessageId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ownerOpenId: context.actor.openId,
  };
  const executor: V3NodeExecutorResolution = input.nodeExecutorPolicy
    ? await resolveV3NodeExecutor({
        policy: input.nodeExecutorPolicy,
        binding: chatBinding,
        humanTurn: context.humanTurn === true,
        targetsFor: (binding) => {
          // Same freeze the materializer applies for a bot run.
          const templateDag = { runId: 'executor-plan', nodes: current.revision.payload.dagTemplate.nodes } as V3Dag;
          return v3BotExecutorTargets(templateDag, freezeDagBotSnapshots(templateDag, input.bots, {
            defaultSelector: binding.larkAppId,
          }));
        },
      })
    : { kind: 'ephemeral' };
  if (executor.kind === 'refused') {
    throw new SavedWorkflowServiceError('executor_ineligible', executor.message);
  }

  const materialized = materializeSavedWorkflowRun({
    metadata: current.metadata,
    revision: current.revision,
    rawParams: input.rawParams,
    context: {
      initiatorOpenId: context.actor.openId,
      chatBinding,
    },
    bots: input.bots,
    baseDir: input.baseDir,
    runId: input.runId,
    now: input.now,
    ...(executor.kind === 'bot' ? { nodeExecutor: 'bot' as const } : {}),
    ...(executor.kind === 'bot' && executor.handoffIdentity ? { handoffIdentity: executor.handoffIdentity } : {}),
  });
  const executorNote = executor.kind === 'bot' ? executor.summary : executor.note;
  return executorNote ? { ...materialized, executorNote } : materialized;
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

// ─── Dashboard: the four entries without a chat (design 2026-11-03
//     workflow-dashboard-orchestration §5, §7.2, D5) ─────────────────────────
//
// The Feishu forms above all need the invoking chat (visibility, the source
// run's chat, the new run's binding). The Dashboard has none: a Dashboard run
// lives in a group of its own, and the group of a template run only exists
// after 拉群开始. These forms keep every non-chat rule — the owning app, the
// owner (I9), published-only runs — and replace the chat ones:
//   - save / append: the source is the caller's own run (its bound owner and
//     main bot), never a chat match; new templates are global; a chat-scoped
//     template is not appended to from here (its chat rule stays);
//   - list: the whole catalog of every bot (I9: an admin sees all, chat ones
//     labelled) — see `listSavedWorkflowCatalog`;
//   - run: a global, published template only; the binding comes later from
//     拉群开始 (`commitSavedWorkflowRunInPlace`).
// None of the Feishu functions above changes.

export interface DashboardSavePlan {
  displayName: string;
  revision: SavedWorkflowRevisionDraft;
  publish: boolean;
  sourceStatus?: 'succeeded' | 'failed' | 'blocked';
  lintWarnings: string[];
  runtimeRevisions?: number;
  botChanges?: SavedWorkflowBotChange[];
}

/** 「设为参数」 (§5.2) on a plan, then the full revision rules, so the
 *  confirm dialog reports what a save would refuse. */
export function withDashboardParamEdits(
  plan: DashboardSavePlan,
  actor: SavedWorkflowOwner,
  edits: readonly SavedWorkflowParamEdit[],
): DashboardSavePlan {
  const revision = applySavedWorkflowParamEdits(plan.revision, edits);
  validateSavedWorkflowRevisionPayload({
    workflowId: `wf_${'0'.repeat(32)}`,
    humanVersion: 1,
    createdAt: new Date(0).toISOString(),
    createdBy: actor,
    ...revision,
  });
  return { ...plan, revision };
}

/** Gates of the revision being saved against the latest version and, when
 *  that is another one, the published version (I10) — both shown. */
export interface DashboardSaveTarget {
  metadata: SavedWorkflowMetadata;
  latest: SavedWorkflowWriteResult['revision'];
  comparisons: SavedWorkflowGateComparisonAgainst[];
}

/** A terminal run of `actor` (its bound owner on this bot), compiled the
 *  Dashboard way (final flow + bots that ran, E10). */
export function planDashboardRunSave(input: {
  runDir: string;
  actor: SavedWorkflowOwner;
  allowDraft?: boolean;
}): DashboardSavePlan {
  const actor = requireActorContext({ actor: input.actor }).actor;
  const runId = basename(input.runDir);
  if (!isValidRunId(runId)) throw new SavedWorkflowServiceError('invalid_context', `Invalid source runId ${JSON.stringify(runId)}`);
  let loaded: LoadedAuthorizedV3Run;
  try {
    loaded = loadAuthorizedV3Run(input.runDir, { allowedSources: ['ad_hoc', 'saved_definition', 'legacy_v3'] });
  } catch (error) {
    throw new SavedWorkflowServiceError('invalid_context', `Run '${runId}' cannot be read as an authorized run: ${error instanceof Error ? error.message : String(error)}`);
  }
  const binding = loaded.envelope.chatBinding;
  // I9: only the caller's own run, on the bot that orchestrated it.
  if (!binding?.ownerOpenId || binding.larkAppId !== actor.larkAppId || binding.ownerOpenId !== actor.openId) {
    throw new SavedWorkflowServiceError('source_not_owned', `Source run '${runId}' belongs to a different actor`);
  }
  terminalSourceStatus(input.runDir, runId);
  const opts = exactCompileOptions(loaded, input.allowDraft === true, true);
  const compiled = compileDashboardSavedWorkflowFromRun(input.runDir, opts);
  return {
    displayName: compiled.displayName,
    revision: {
      ...compiled.revision,
      provenance: {
        kind: 'dashboard_run',
        runId,
        runtimeRevisions: compiled.runtimeRevisions,
        botChanges: compiled.botChanges,
      },
    },
    publish: compiled.publish,
    sourceStatus: compiled.sourceStatus,
    lintWarnings: compiled.lintWarnings,
    runtimeRevisions: compiled.runtimeRevisions,
    botChanges: compiled.botChanges,
  };
}

/** The template a Dashboard save would append to: the caller's own, global,
 *  not archived — and how its gates compare (I10). */
export async function loadDashboardAppendTarget(input: {
  dataDir: string;
  workflowId: string;
  actor: SavedWorkflowOwner;
  revision: SavedWorkflowRevisionDraft;
}): Promise<DashboardSaveTarget> {
  const actor = requireActorContext({ actor: input.actor }).actor;
  if (!SAVED_WORKFLOW_ID_RE.test(input.workflowId)) throw notFound(input.workflowId);
  let current: SavedWorkflowWriteResult;
  try {
    current = await loadCurrentSavedWorkflow(input.dataDir, input.workflowId, { revision: 'latest', requireActive: false });
  } catch (err) {
    if (err instanceof SavedWorkflowNotFoundError) throw notFound(input.workflowId);
    throw err;
  }
  const metadata = current.metadata;
  if (metadata.owner.larkAppId !== actor.larkAppId || metadata.status === 'archived') throw notFound(input.workflowId);
  if (!sameOwner(metadata.owner, actor)) throw new SavedWorkflowPermissionError(metadata.workflowId);
  if (metadata.scope.kind === 'chat') {
    throw new SavedWorkflowServiceError('scope_mismatch', `Saved Workflow '${metadata.workflowId}' is chat-scoped: append to it in its chat`);
  }
  const comparisons: SavedWorkflowGateComparisonAgainst[] = [{
    base: { kind: 'previous', revisionId: current.revision.revisionId, humanVersion: current.revision.payload.humanVersion },
    gates: compareSavedWorkflowGates(current.revision.payload.dagTemplate, input.revision.dagTemplate),
  }];
  // The published version is what runs today: a draft-only latest must not
  // hide that the new one weakens it. Both comparisons are shown.
  if (metadata.publishedRevision && metadata.publishedRevision !== current.revision.revisionId) {
    const published = await readSavedWorkflowRevision(input.dataDir, input.workflowId, metadata.publishedRevision);
    comparisons.push({
      base: { kind: 'published', revisionId: published.revisionId, humanVersion: published.payload.humanVersion },
      gates: compareSavedWorkflowGates(published.payload.dagTemplate, input.revision.dagTemplate),
    });
  }
  return { metadata, latest: current.revision, comparisons };
}

/**
 * What a retried Dashboard save (new template or append) must match to be
 * answered with what it already wrote: the definition and where it came from
 * — not the moment of confirming (a draft save re-stamps `confirmedAt` on
 * every request) nor the request id. Anything else differing is another save.
 */
function comparableDashboardSave(payload: Pick<SavedWorkflowRevisionDraft, 'sourceRunId' | 'inputs' | 'contextRefs' | 'specTemplate' | 'specStatus' | 'dagTemplate' | 'safety' | 'provenance'>): unknown {
  const provenance = payload.provenance;
  return {
    ...(comparableRevisionDraft(payload as SavedWorkflowWriteResult['revision']['payload']) as Record<string, unknown>),
    ...(provenance?.kind === 'dashboard_draft'
      ? { provenance: {
          kind: provenance.kind,
          draftRunId: provenance.draftRunId,
          flowSummarySha256: provenance.confirmation.flowSummarySha256,
          confirmedByOpenId: provenance.confirmation.confirmedByOpenId,
          flowConfirmedAt: provenance.confirmation.flowConfirmedAt,
        } }
      : provenance?.kind === 'dashboard_run'
        ? { provenance: { kind: provenance.kind, runId: provenance.runId, runtimeRevisions: provenance.runtimeRevisions, botChanges: provenance.botChanges } }
        : {}),
  };
}

/** sha256 of one append request (P3-6): the same dialog retried finds the
 *  version it wrote. */
export function dashboardAppendRequestId(input: { workflowId: string; actor: SavedWorkflowOwner; sourceKind: 'run' | 'draft'; sourceId: string; requestKey: string }): string {
  return `sha256:${createHash('sha256')
    .update(['v3-dashboard-append:v1', input.workflowId, input.actor.larkAppId, input.actor.openId, input.sourceKind, input.sourceId, input.requestKey].join('\0'))
    .digest('hex')}`;
}

/** Deterministic id of a new template from one Dashboard save request: a
 *  retried / double-clicked save lands on the same template. */
export function dashboardSavedWorkflowId(input: { sourceKind: 'run' | 'draft'; sourceId: string; actor: SavedWorkflowOwner; requestKey: string }): string {
  const digest = createHash('sha256')
    .update(['v3-dashboard-save:v1', input.sourceKind, input.sourceId, input.actor.larkAppId, input.actor.openId, input.requestKey].join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `wf_${digest}`;
}

export interface CommitDashboardSaveInput {
  dataDir: string;
  actor: SavedWorkflowOwner;
  plan: DashboardSavePlan;
  /** Append to this template (the caller's own); else a new global one. */
  workflowId?: string;
  /** Append only: the latest revision the confirm dialog compared with. */
  expectedLatestRevision?: string;
  displayName?: string;
  /** New template only: makes a repeated request idempotent. */
  newWorkflowId?: string;
  /** Append only: the request this append belongs to (P3-6). */
  appendRequest?: { sourceKind: 'run' | 'draft'; sourceId: string; requestKey: string };
  now?: Date;
}

export async function commitDashboardSave(input: CommitDashboardSaveInput): Promise<SavedWorkflowWriteResult & { created: boolean; replayed?: boolean }> {
  const actor = requireActorContext({ actor: input.actor }).actor;
  if (input.workflowId !== undefined) {
    const workflowId = input.workflowId;
    // Re-checked under the store's lock by appendSavedWorkflowRevision (owner,
    // archived, expected latest); scope and app here.
    await loadDashboardAppendTarget({ dataDir: input.dataDir, workflowId, actor, revision: input.plan.revision });
    const requestId = input.appendRequest ? dashboardAppendRequestId({ workflowId, actor, ...input.appendRequest }) : undefined;
    const provenance = input.plan.revision.provenance;
    const revision = requestId && provenance ? { ...input.plan.revision, provenance: { ...provenance, requestId } } : input.plan.revision;
    const append = async () => {
      if (requestId) {
        // Already written by this very request (a retry, a second tab).
        for (const existing of await listSavedWorkflowRevisions(input.dataDir, workflowId)) {
          if (existing.payload.provenance?.requestId === requestId && sameOwner(existing.payload.createdBy, actor)) {
            // Same request, same content — a retry. The same key with other
            // content is a different save, never silently answered with the old.
            if (canonicalJsonStringify(comparableDashboardSave(existing.payload)) !== canonicalJsonStringify(comparableDashboardSave(revision))) {
              throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' already has a version from this request with different content`);
            }
            return { metadata: await readSavedWorkflowMetadata(input.dataDir, workflowId), revision: existing, created: false, replayed: true };
          }
        }
      }
      const written = await appendSavedWorkflowRevision(input.dataDir, workflowId, {
        actor,
        revision,
        publish: input.plan.publish,
        ...(input.expectedLatestRevision ? { expectedLatestRevision: input.expectedLatestRevision } : {}),
        now: input.now,
      });
      return { ...written, created: false };
    };
    if (!requestId) return append();
    return withFileLock(join(workflowLibraryRoot(input.dataDir), `.dashboard-append-${workflowId}`), append);
  }
  const workflowId = input.newWorkflowId;
  const create = () => createSavedWorkflow(input.dataDir, {
    ...(workflowId ? { workflowId } : {}),
    displayName: input.displayName ?? input.plan.displayName,
    owner: actor,
    // Dashboard runs each live in a group of their own: 「本群」 means nothing (I9).
    scope: { kind: 'global' },
    revision: input.plan.revision,
    publish: input.plan.publish,
    now: input.now,
  });
  if (!workflowId) return { ...await create(), created: true };
  const root = workflowLibraryRoot(input.dataDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return withFileLock(join(root, `.dashboard-save-${workflowId}`), async () => {
    const existing = await loadExistingDashboardSave(input.dataDir, workflowId, actor, input.plan.revision, input.displayName ?? input.plan.displayName);
    if (existing) return { ...existing, created: false };
    const dir = savedWorkflowDir(input.dataDir, workflowId);
    // Same remnant rule as the card save: our deterministic lock owns it.
    if (existsSync(dir) && !existsSync(join(dir, 'metadata.json'))) await fs.rm(dir, { recursive: true, force: true });
    return { ...await create(), created: true };
  });
}

async function loadExistingDashboardSave(
  dataDir: string,
  workflowId: string,
  actor: SavedWorkflowOwner,
  revision: SavedWorkflowRevisionDraft,
  displayName: string,
): Promise<SavedWorkflowWriteResult | undefined> {
  let current: SavedWorkflowWriteResult;
  try {
    current = await loadCurrentSavedWorkflow(dataDir, workflowId, { revision: 'latest', requireActive: false });
  } catch (err) {
    if (err instanceof SavedWorkflowNotFoundError) return undefined;
    throw err;
  }
  // Same request key, same save — or a conflict: never answer a changed
  // confirmation, source or name with what an earlier request wrote.
  if (!sameOwner(current.metadata.owner, actor) || current.revision.payload.humanVersion !== 1
    || current.metadata.displayName !== displayName.trim().normalize('NFC')
    || canonicalJsonStringify(comparableDashboardSave(current.revision.payload)) !== canonicalJsonStringify(comparableDashboardSave(revision))) {
    throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' already exists with different content`);
  }
  return current;
}

export interface DashboardSavedWorkflowRun {
  metadata: SavedWorkflowMetadata;
  revision: SavedWorkflowWriteResult['revision'];
  resolvedParams: Record<string, unknown>;
}

/**
 * 「运行」 from the Dashboard (§5.3): the published revision of a global
 * template of this bot, with the parameters checked and converted by the
 * `/workflow run` rules. A chat-scoped template stays runnable only in its
 * chat (I9). Nothing is written here.
 */
export async function prepareDashboardSavedWorkflowRun(input: {
  dataDir: string;
  workflowId: string;
  actor: SavedWorkflowOwner;
  rawParams: Record<string, RawParamInput>;
}): Promise<DashboardSavedWorkflowRun> {
  const actor = requireActorContext({ actor: input.actor }).actor;
  if (!SAVED_WORKFLOW_ID_RE.test(input.workflowId)) throw notFound(input.workflowId);
  let metadata: SavedWorkflowMetadata;
  try {
    metadata = await readSavedWorkflowMetadata(input.dataDir, input.workflowId);
  } catch (err) {
    if (err instanceof SavedWorkflowNotFoundError) throw notFound(input.workflowId);
    throw err;
  }
  if (metadata.owner.larkAppId !== actor.larkAppId || metadata.status === 'archived') throw notFound(input.workflowId);
  if (metadata.scope.kind === 'chat') {
    throw new SavedWorkflowServiceError('scope_mismatch', `Saved Workflow '${metadata.workflowId}' is chat-scoped: run it in its chat with /workflow run`);
  }
  if (metadata.status !== 'active' || !metadata.publishedRevision) {
    throw new SavedWorkflowServiceError('not_published', `Saved Workflow '${metadata.workflowId}' has no published revision`);
  }
  let current: SavedWorkflowWriteResult;
  try {
    current = await loadCurrentSavedWorkflow(input.dataDir, input.workflowId, { revision: 'published', requireActive: true });
  } catch (err) {
    if (err instanceof SavedWorkflowNotFoundError) throw notFound(input.workflowId);
    if (err instanceof SavedWorkflowConflictError) {
      throw new SavedWorkflowServiceError('not_published', `Saved Workflow '${input.workflowId}' no longer has an active published revision`);
    }
    throw err;
  }
  // Metadata may have moved between the two reads.
  if (current.metadata.scope.kind !== 'global' || current.metadata.owner.larkAppId !== actor.larkAppId) throw notFound(input.workflowId);
  const resolvedParams = resolveSavedWorkflowRunParams(current.revision, input.rawParams);
  return {
    metadata: current.metadata,
    revision: current.revision,
    resolvedParams,
  };
}
