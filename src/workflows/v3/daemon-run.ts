/**
 * Daemon-driven v3 run — the Feishu-product execution path (vs `cli-run.ts`'s
 * dev/dogfood terminal path).  Mirrors v0.2's `driveWorkflowRun`, but for the
 * v3 engine and with **suspend-mode gates**:
 *
 *   - `gateMode:'suspend'`: when a humanGate is reached the runtime writes the
 *     pending wait file + returns `awaitingGate` WITHOUT awaiting a decision —
 *     no in-memory promise to lose on a daemon restart.
 *   - This driver posts the approval card(s) for each pending gate and returns.
 *     It does NOT hold the run.  A card click resolves the wait (+ appends
 *     `gateResolved`) and RE-INVOKES `driveV3Run` for a fresh replay that picks
 *     up the now-`gateCleared` node and continues.
 *
 * Stateless by design (recovery source = runDir dag/journal/wait/chatBinding).
 * The daemon owns a lightweight per-runId in-flight guard around this so two
 * concurrent clicks / start can't double-spawn.
 */

import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';

import { loadBotConfigs, type BotConfig } from '../../bot-registry.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../../utils/file-lock.js';
import { isHostNode, isLoopNode, loadDag, type V3Dag } from './dag.js';
import {
  runWorkflow,
  nextAttemptIdFor,
  latestAttemptIdFor,
  revisitBudgetStatus,
  type V3RuntimeDeps,
  type V3RuntimeOptions,
  type V3RunOutcome,
  type V3PendingGate,
} from './runtime.js';
import { createEphemeralPool } from './ephemeral-pool.js';
import { readAndValidateManifest, ManifestValidationError } from './manifest.js';
import {
  readGrillState,
  defaultBaseDir,
  GRILL_STATUS_FILE,
  type GrillState,
  type RunChatBinding,
} from './grill-state.js';
import {
  resolveBotConfig,
  botToSnapshot,
  freezeDagBotSnapshots,
  parseFrozenBotSnapshots,
  serializeFrozenBotSnapshots,
} from './bot-resolve.js';
import {
  loadAuthorizedV3Run,
  artifactRef,
  makeLegacyV3RunEnvelope,
  publishRunEnvelopeOnce,
  readRunEnvelope,
  RunEnvelopeIntegrityError,
  type V3RunEnvelope,
} from './run-envelope.js';
import {
  canResolveGateWait,
  normalizeGateWaitInput,
  readWait,
  resolveWait,
  resolveWaitOnce,
  selectedResolution,
  v3GateWaitId,
  writePendingWait,
  type GateWait,
  type GateWaitStatus,
} from './human-gate.js';
import {
  readJournal,
  appendEvent,
  withJournalMutationSync,
  type StoredEvent,
  type V3ErrorClass,
} from './journal.js';
import { materialize } from './state.js';
import { openV3WorkerAttempts } from './attempt-ledger.js';
import { openV3HostEffects } from './host-effect-ledger.js';
import { readAndVerifyV3PreparedHostInput } from './host-execution.js';
import { composeV3HostGatePrompt, renderV3HostInputPreview } from './host-bindings.js';
import { V3_DRIVE_LEASE_MAX_WAIT_MS, v3DriveLeaseTarget } from './drive-lease.js';
import {
  createDefaultHostExecutorRegistry,
  createDefaultProviderReconcilers,
} from '../hostExecutors/registry.js';
import { isValidRunId } from './ops-projection.js';
import { GOAL_ANSWER_FILE, type GoalAnswer, type GoalAsk, type ValidateManifest } from './contract.js';
import { validateSpec } from './spec.js';

/**
 * runId → runDir with a path-traversal guard (codex review #2).  runIds reach
 * the daemon from outside (start IPC, card clicks) — never trust them into a
 * `join` without the allowlist check, so the guard lives in core (not glue).
 */
export function safeRunDir(baseDir: string, runId: string): string {
  if (!isValidRunId(runId)) throw new Error(`v3: invalid runId "${runId}"`);
  return join(baseDir, runId);
}

export interface V3RunExecutionContext {
  dag: V3Dag;
  binding?: RunChatBinding;
  /** Present for immutable envelope-backed ad-hoc/saved runs. */
  botSnapshots?: Map<string, import('./contract.js').BotSnapshot>;
  envelope?: V3RunEnvelope;
  resolvedWorkflowData?: { params: Record<string, unknown>; context: Record<string, string> };
  /** False only for the one-version legacy grill fallback. */
  authorizedArtifacts: boolean;
}

export type V3RunStartPreflight =
  | {
    ok: true;
    context: V3RunExecutionContext;
    /** Compatibility detail for old callers/tests; saved runs have no grill. */
    grill?: GrillState & { dagPath: string };
  }
  | {
    ok: false;
    error:
      | 'no_grill_state'
      | 'dag_not_approved'
      | 'approved_dag_missing'
      | 'approved_dag_invalid'
      | 'run_envelope_invalid'
      | 'run_source_not_daemon_startable';
    status?: GrillState['status'];
    detail?: string;
  };

function parseResolvedWorkflowData(raw: unknown): {
  params: Record<string, unknown>;
  context: Record<string, string>;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('params.resolved.json must be an object');
  }
  const root = raw as Record<string, unknown>;
  const extra = Object.keys(root).filter((key) => key !== 'params' && key !== 'context');
  if (extra.length > 0) throw new Error(`params.resolved.json has unsupported key(s): ${extra.join(', ')}`);
  if (!root.params || typeof root.params !== 'object' || Array.isArray(root.params)) {
    throw new Error('params.resolved.json.params must be an object');
  }
  if (!root.context || typeof root.context !== 'object' || Array.isArray(root.context)) {
    throw new Error('params.resolved.json.context must be an object');
  }
  const context = root.context as Record<string, unknown>;
  if (Object.values(context).some((value) => typeof value !== 'string')) {
    throw new Error('params.resolved.json.context values must be strings');
  }
  return {
    params: { ...(root.params as Record<string, unknown>) },
    context: { ...(context as Record<string, string>) },
  };
}

function assertResolvedWorkflowContextMatchesBinding(
  data: { context: Record<string, string> },
  binding: RunChatBinding | undefined,
): void {
  if (!binding) {
    throw new Error('saved definition run must carry an authorized chatBinding');
  }
  const expected: Record<string, string | undefined> = {
    chatId: binding.chatId,
    larkAppId: binding.larkAppId,
    chatType: binding.chatType,
    rootMessageId: binding.rootMessageId,
    initiatorOpenId: binding.ownerOpenId,
  };
  for (const [key, actual] of Object.entries(data.context)) {
    if (!Object.prototype.hasOwnProperty.call(expected, key)) continue;
    if (!expected[key] || expected[key] !== actual) {
      throw new Error(
        `params.resolved.json context.${key} does not match run.json chatBinding`,
      );
    }
  }
}

function parseSavedDefinitionWorkflowData(
  raw: unknown,
  binding: RunChatBinding | undefined,
): { params: Record<string, unknown>; context: Record<string, string> } {
  const data = parseResolvedWorkflowData(raw);
  assertResolvedWorkflowContextMatchesBinding(data, binding);
  return data;
}

function bindingWorkflowData(binding: RunChatBinding | undefined): {
  params: Record<string, unknown>;
  context: Record<string, string>;
} | undefined {
  if (!binding) return undefined;
  return {
    params: {},
    context: {
      chatId: binding.chatId,
      larkAppId: binding.larkAppId,
      ...(binding.chatType ? { chatType: binding.chatType } : {}),
      ...(binding.rootMessageId ? { rootMessageId: binding.rootMessageId } : {}),
      ...(binding.ownerOpenId ? { initiatorOpenId: binding.ownerOpenId } : {}),
    },
  };
}

function mutationIntegrityError(detail: string): RunEnvelopeIntegrityError {
  return new RunEnvelopeIntegrityError(
    'envelope_invalid',
    `v3 run mutation authorization failed: ${detail}`,
  );
}

function assertLegacyMutationIdentity(runDir: string): void {
  const expectedRunId = basename(runDir);
  const journalPath = join(runDir, 'journal.ndjson');
  const events = readJournal(journalPath);
  const starts = events.filter((event) => event.type === 'runStarted');
  if (starts.length !== 1 || starts[0]!.runId !== expectedRunId) {
    const seen = starts.map((event) => event.runId).join(', ') || '(none)';
    throw mutationIntegrityError(
      `legacy journal identity mismatch: directory=${expectedRunId}, runStarted=${seen}`,
    );
  }

  const grillPath = join(runDir, GRILL_STATUS_FILE);
  const grill = readGrillState(runDir);
  if (existsSync(grillPath) && !grill) {
    throw mutationIntegrityError('legacy grill state exists but is unreadable');
  }
  if (grill) {
    if (grill.runId !== expectedRunId) {
      throw mutationIntegrityError(
        `legacy grill identity mismatch: directory=${expectedRunId}, grill=${grill.runId}`,
      );
    }
    if (grill.status !== 'dag_approved') {
      throw mutationIntegrityError(
        `legacy grill is not Gate-2 approved (status=${grill.status})`,
      );
    }
  }

  const candidateDagPaths = new Set<string>();
  const canonicalDagPath = join(runDir, 'dag.json');
  if (existsSync(canonicalDagPath)) candidateDagPaths.add(canonicalDagPath);
  if (grill?.dagPath) {
    const runRoot = resolve(runDir);
    const approvedDagPath = resolve(grill.dagPath);
    const rel = relative(runRoot, approvedDagPath);
    if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw mutationIntegrityError('legacy approved DAG path must stay inside its run directory');
    }
    if (!existsSync(approvedDagPath)) {
      throw mutationIntegrityError('legacy approved DAG is missing');
    }
    candidateDagPaths.add(approvedDagPath);
  }
  if (candidateDagPaths.size === 0) {
    throw mutationIntegrityError('legacy run has no verifiable DAG');
  }
  for (const dagPath of candidateDagPaths) {
    let dag: V3Dag;
    try {
      dag = loadDag(dagPath);
    } catch (err) {
      throw mutationIntegrityError(
        `legacy DAG is invalid (${dagPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (dag.runId !== expectedRunId) {
      throw mutationIntegrityError(
        `legacy DAG identity mismatch: directory=${expectedRunId}, dag=${dag.runId}`,
      );
    }
  }
}

/**
 * Mutation authorization boundary for card/CLI recovery actions.
 *
 * Envelope-backed runs re-verify every pinned artifact immediately before a
 * wait file or journal can change. Only a genuinely missing run.json may use
 * the one-release legacy path, which still requires directory, journal, grill,
 * and DAG identities to agree. An existing invalid/tampered envelope never
 * falls back to legacy state.
 */
export function assertV3RunIntegrityForMutation(runDir: string): void {
  const expectedRunId = basename(runDir);
  const envelope = readRunEnvelope(runDir, expectedRunId);
  if (envelope.kind === 'invalid') {
    throw mutationIntegrityError(envelope.problems.join('; '));
  }
  if (envelope.kind === 'missing') {
    assertLegacyMutationIdentity(runDir);
    return;
  }

  const loaded = loadAuthorizedV3Run(runDir, { expectedRunId });
  if (loaded.botSnapshots !== undefined) {
    parseFrozenBotSnapshots(loaded.botSnapshots, loaded.dag);
  }
  if (loaded.envelope.source.kind === 'saved_definition') {
    parseSavedDefinitionWorkflowData(loaded.resolvedParams, loaded.envelope.chatBinding);
  }
}

function assertPathInsideRunDir(runDir: string, path: string, label: string): string {
  const runRoot = resolve(runDir);
  const candidate = resolve(path);
  const rel = relative(runRoot, candidate);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside its run directory`);
  }
  return candidate;
}

function loadLegacyDagForStart(
  runDir: string,
  grill: GrillState & { dagPath: string },
): V3Dag {
  const expectedRunId = basename(runDir);
  if (grill.runId !== expectedRunId) {
    throw new Error(`legacy run identity mismatch: directory=${expectedRunId}, grill=${grill.runId}`);
  }
  const approvedDagPath = assertPathInsideRunDir(runDir, grill.dagPath, 'legacy approved DAG path');
  if (!existsSync(approvedDagPath)) throw new Error('legacy approved DAG is missing');

  const journalPath = join(runDir, 'journal.ndjson');
  const events = readJournal(journalPath);
  if (events.length > 0) {
    const starts = events.filter((event) => event.type === 'runStarted');
    if (starts.length !== 1 || starts[0]!.runId !== expectedRunId) {
      throw new Error(
        `legacy journal identity mismatch: directory=${expectedRunId}, ` +
        `runStarted=${starts.map((event) => event.runId).join(', ') || '(none)'}`,
      );
    }
  }

  // Once runtime has created the canonical root DAG, it is execution truth.
  // Before first dispatch the approved grill DAG is the only available source.
  const canonicalDagPath = join(runDir, 'dag.json');
  const dag = loadDag(existsSync(canonicalDagPath) ? canonicalDagPath : approvedDagPath);
  if (dag.runId !== expectedRunId) {
    throw new Error(`legacy DAG identity mismatch: directory=${expectedRunId}, dag=${dag.runId}`);
  }
  return dag;
}

/**
 * Gate-2 authorization seam shared by the daemon IPC and the actual driver.
 * Checking only `dagPath` is insufficient: architect writes that path while
 * the run is still `dag_ready`, before the user has approved the DAG.
 */
export function preflightV3RunStart(runDir: string): V3RunStartPreflight {
  const envelopeRead = readRunEnvelope(runDir);
  if (envelopeRead.kind === 'invalid') {
    return {
      ok: false,
      error: 'run_envelope_invalid',
      detail: envelopeRead.problems.join('; '),
    };
  }
  if (envelopeRead.kind === 'ok') {
    if (envelopeRead.envelope.source.kind === 'manual_cli') {
      return {
        ok: false,
        error: 'run_source_not_daemon_startable',
        detail: 'manual_cli runs are local-only',
      };
    }
    try {
      const loaded = loadAuthorizedV3Run(runDir, {
        allowedSources: ['ad_hoc', 'saved_definition', 'legacy_v3'],
      });
      const botSnapshots = loaded.botSnapshots === undefined
        ? undefined
        : parseFrozenBotSnapshots(loaded.botSnapshots, loaded.dag);
      const resolvedWorkflowData = loaded.envelope.source.kind === 'saved_definition'
        ? parseSavedDefinitionWorkflowData(loaded.resolvedParams, loaded.envelope.chatBinding)
        : bindingWorkflowData(loaded.envelope.chatBinding);
      return {
        ok: true,
        context: {
          dag: loaded.dag,
          binding: loaded.envelope.chatBinding,
          ...(botSnapshots ? { botSnapshots } : {}),
          ...(resolvedWorkflowData ? { resolvedWorkflowData } : {}),
          envelope: loaded.envelope,
          authorizedArtifacts: true,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: 'run_envelope_invalid',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // One-version compatibility: a run created before run.json existed may still
  // start from the old Gate-2 grill marker. Existing-but-corrupt envelopes
  // never reach this fallback.
  const grill = readGrillState(runDir);
  if (!grill) return { ok: false, error: 'no_grill_state' };
  if (grill.status !== 'dag_approved') {
    return { ok: false, error: 'dag_not_approved', status: grill.status };
  }
  if (!grill.dagPath) {
    return { ok: false, error: 'approved_dag_missing', status: grill.status };
  }
  try {
    const approvedGrill = grill as GrillState & { dagPath: string };
    const dag = loadLegacyDagForStart(runDir, approvedGrill);
    return {
      ok: true,
      grill: approvedGrill,
      context: {
        dag,
        binding: grill.chatBinding,
        ...(bindingWorkflowData(grill.chatBinding)
          ? { resolvedWorkflowData: bindingWorkflowData(grill.chatBinding)! }
          : {}),
        authorizedArtifacts: false,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.message === 'legacy approved DAG is missing') {
      return {
        ok: false,
        error: 'approved_dag_missing',
        status: grill.status,
      };
    }
    return {
      ok: false,
      error: 'approved_dag_invalid',
      status: grill.status,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Seal a pre-run.json grill run immediately before its first worker dispatch.
 * Legacy Gate-2 bytes were never digest-pinned, so the envelope is honest
 * about that historical limitation; from this point onward the canonical DAG
 * and bot identities are immutable and every retry/resume verifies them.
 */
function sealLegacyV3Run(
  runDir: string,
  grill: GrillState & { dagPath: string },
  preflightDag: V3Dag,
  bots: BotConfig[],
): V3RunExecutionContext {
  return withFileLockSync(join(runDir, 'run.json'), () => {
    const current = readRunEnvelope(runDir);
    if (current.kind === 'invalid') {
      throw new Error(`legacy run envelope is invalid: ${current.problems.join('; ')}`);
    }
    if (current.kind === 'ok') {
      if (current.envelope.source.kind === 'manual_cli') {
        throw new Error('manual_cli runs are local-only');
      }
      const loaded = loadAuthorizedV3Run(runDir, {
        allowedSources: ['ad_hoc', 'saved_definition', 'legacy_v3'],
      });
      const botSnapshots = loaded.botSnapshots === undefined
        ? undefined
        : parseFrozenBotSnapshots(loaded.botSnapshots, loaded.dag);
      const resolvedWorkflowData = loaded.envelope.source.kind === 'saved_definition'
        ? parseSavedDefinitionWorkflowData(loaded.resolvedParams, loaded.envelope.chatBinding)
        : bindingWorkflowData(loaded.envelope.chatBinding);
      return {
        dag: loaded.dag,
        binding: loaded.envelope.chatBinding,
        ...(botSnapshots ? { botSnapshots } : {}),
        ...(resolvedWorkflowData ? { resolvedWorkflowData } : {}),
        envelope: loaded.envelope,
        authorizedArtifacts: true,
      };
    }

    const runId = basename(runDir);
    if (grill.runId !== runId || preflightDag.runId !== runId) {
      throw new Error(
        `legacy run identity changed before sealing: directory=${runId}, ` +
        `grill=${grill.runId}, dag=${preflightDag.runId}`,
      );
    }

    const canonicalDagPath = join(runDir, 'dag.json');
    if (existsSync(canonicalDagPath)) {
      const canonicalDag = loadDag(canonicalDagPath);
      if (JSON.stringify(canonicalDag) !== JSON.stringify(preflightDag)) {
        throw new Error('legacy canonical DAG changed between preflight and sealing');
      }
    } else {
      atomicWriteFileSync(
        canonicalDagPath,
        `${JSON.stringify(preflightDag, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    const dag = loadDag(canonicalDagPath);

    const botPath = join(runDir, 'bots.snapshot.json');
    let botSnapshots;
    if (existsSync(botPath)) {
      const raw = JSON.parse(readFileSync(botPath, 'utf-8')) as unknown;
      botSnapshots = parseFrozenBotSnapshots(raw, dag);
    } else {
      botSnapshots = freezeDagBotSnapshots(dag, bots);
      atomicWriteFileSync(
        botPath,
        `${JSON.stringify(serializeFrozenBotSnapshots(botSnapshots), null, 2)}\n`,
        { mode: 0o600 },
      );
    }

    const artifacts: import('./run-envelope.js').V3LegacyRunEnvelope['artifacts'] = {
      dag: artifactRef(runDir, 'dag.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    };
    const specPath = join(runDir, 'spec.json');
    if (existsSync(specPath)) {
      try {
        const spec = validateSpec(JSON.parse(readFileSync(specPath, 'utf-8')));
        if (spec.runId === runId) artifacts.spec = artifactRef(runDir, 'spec.json');
      } catch {
        // Historical specs were optional and not execution inputs. Omit an
        // unverifiable/corrupt one rather than blessing it into the envelope.
      }
    }

    const journalEvents = readJournal(join(runDir, 'journal.ndjson'));
    const legacyEnvelope = makeLegacyV3RunEnvelope({
      runId,
      createdAt: grill.createdAt,
      backfilledAt: new Date().toISOString(),
      original: 'grill',
      basis: journalEvents.length > 0 ? 'runtime_started' : 'grill_dag_approved',
      ...(grill.chatBinding ? { chatBinding: grill.chatBinding } : {}),
      artifacts,
    });
    publishRunEnvelopeOnce(runDir, legacyEnvelope);

    const loaded = loadAuthorizedV3Run(runDir, { allowedSources: ['legacy_v3'] });
    return {
      dag: loaded.dag,
      binding: loaded.envelope.chatBinding,
      botSnapshots: parseFrozenBotSnapshots(loaded.botSnapshots, loaded.dag),
      ...(bindingWorkflowData(loaded.envelope.chatBinding)
        ? { resolvedWorkflowData: bindingWorkflowData(loaded.envelope.chatBinding)! }
        : {}),
      envelope: loaded.envelope,
      authorizedArtifacts: true,
    };
  });
}

/** Envelope-first binding lookup shared by daemon routes, card handlers, and
 * cold attach. Corrupt run.json fails closed; only a genuinely missing
 * envelope may use the one-version grill fallback. */
export function readV3RunChatBinding(runDir: string): RunChatBinding | undefined {
  const envelope = readRunEnvelope(runDir);
  if (envelope.kind === 'ok') return envelope.envelope.chatBinding;
  if (envelope.kind === 'invalid') return undefined;
  return readGrillState(runDir)?.chatBinding;
}

/** Verified DAG for recovery/display logic, with the same missing-only legacy
 * fallback as the start path. */
export function loadV3RunDagForRecovery(runDir: string): V3Dag | undefined {
  const envelope = readRunEnvelope(runDir);
  if (envelope.kind === 'ok') {
    try { return loadAuthorizedV3Run(runDir).dag; } catch { return undefined; }
  }
  if (envelope.kind === 'invalid') return undefined;
  const grill = readGrillState(runDir);
  if (!grill?.dagPath || !existsSync(grill.dagPath)) return undefined;
  try { return loadDag(grill.dagPath); } catch { return undefined; }
}

interface TrustedHostGateMaterial {
  waitId: string;
  nodeId: string;
  instanceId: string;
  prompt: string;
  options: string[];
  approveOptions: string[];
  approvers: string[];
  hostApproval: { attemptId: string; approvalDigest: string; inputHash: string };
}

/** Rebuild the host approval UI from authorized DAG + durable prepared bytes.
 * waits/*.json is mutable delivery state and is never trusted as the approval
 * object by itself. */
function trustedHostGateMaterial(
  runDir: string,
  runId: string,
  nodeId: string,
  instanceId: string,
  events: readonly StoredEvent[],
): TrustedHostGateMaterial | undefined {
  const dag = loadV3RunDagForRecovery(runDir);
  const node = dag?.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || !isHostNode(node) || !node.humanGate) return undefined;
  const dispatched = [...events].reverse().find(
    (event): event is StoredEvent & { type: 'gateDispatched' } =>
      event.type === 'gateDispatched' &&
      event.nodeId === nodeId &&
      event.instanceId === instanceId &&
      !!event.hostApproval,
  );
  if (!dispatched?.hostApproval) return undefined;
  const prepared = [...events].reverse().find(
    (event): event is StoredEvent & { type: 'hostInputPrepared' } =>
      event.type === 'hostInputPrepared' &&
      event.nodeId === nodeId &&
      event.instanceId === instanceId &&
      event.attemptId === dispatched.hostApproval!.attemptId,
  );
  const registered = createDefaultHostExecutorRegistry().get(node.executor);
  if (!prepared || !registered) return undefined;
  if (
    prepared.approvalDigest !== dispatched.hostApproval.approvalDigest ||
    prepared.inputHash !== dispatched.hostApproval.inputHash
  ) return undefined;
  try {
    const artifact = readAndVerifyV3PreparedHostInput({
      runDir,
      inputRef: prepared.inputRef,
      expected: { ...prepared, runId },
      registered,
    });
    const authored = normalizeGateWaitInput(node.humanGate);
    const hostApproval = {
      attemptId: prepared.attemptId,
      approvalDigest: prepared.approvalDigest,
      inputHash: prepared.inputHash,
    };
    return {
      nodeId,
      instanceId,
      waitId: v3GateWaitId(nodeId, instanceId, hostApproval),
      ...authored,
      prompt: composeV3HostGatePrompt(
        authored.prompt,
        renderV3HostInputPreview(node.executor, artifact.prepared.parsedInput, prepared.inputHash),
      ),
      hostApproval,
    };
  } catch {
    return undefined;
  }
}

function waitMatchesTrustedHostGate(wait: GateWait, trusted: TrustedHostGateMaterial): boolean {
  return wait.waitId === trusted.waitId &&
    wait.nodeId === trusted.nodeId &&
    wait.instanceId === trusted.instanceId &&
    wait.prompt === trusted.prompt &&
    JSON.stringify(wait.options) === JSON.stringify(trusted.options) &&
    JSON.stringify(wait.approveOptions) === JSON.stringify(trusted.approveOptions) &&
    JSON.stringify(wait.approvers) === JSON.stringify(trusted.approvers) &&
    JSON.stringify(wait.hostApproval) === JSON.stringify(trusted.hostApproval);
}

export type V3TerminalOutcome = Extract<V3RunOutcome, { reason: 'terminal' }>;

/** What the daemon needs to render a blocked-node retry card. */
export interface V3BlockedInfo {
  nodeId: string;
  attemptId: string;
  errorClass?: V3ErrorClass;
  errorCode?: string;
  message?: string;
  /** Present when the block is a runtime human-ask (errorCode === ASK_HUMAN):
   *  the agent's question → the daemon posts an ask card instead of a plain
   *  retry card. */
  ask?: GoalAsk;
  /** Present when errorCode === 'REVISIT_BUDGET_EXHAUSTED': the ancestor this
   *  node tried to revisit → the daemon posts a revisit-grant card. */
  revisitTo?: string;
  /** No generic retry may mint a fresh idempotency key for this attempt. */
  retryForbidden?: 'host-effect-uncertain';
}

/** Latest `nodeBlocked` details for a node (card content).  Falls back to a
 *  bare nodeId/attempt when the journal has no blocked event (shouldn't
 *  happen for a blocked run, but the card must still render). */
export function blockedInfoFor(events: StoredEvent[], nodeId: string): V3BlockedInfo {
  let found: V3BlockedInfo | undefined;
  for (const e of events) {
    if (e.type === 'nodeBlocked' && e.nodeId === nodeId) {
      found = {
        nodeId,
        attemptId: e.attemptId,
        errorClass: e.errorClass,
        errorCode: e.errorCode,
        message: e.message,
        ...(e.ask ? { ask: e.ask } : {}),
        ...(e.revisitTo ? { revisitTo: e.revisitTo } : {}),
      };
    } else if (e.type === 'hostEffectUncertain' && e.nodeId === nodeId) {
      found = {
        nodeId,
        attemptId: e.attemptId,
        errorClass: 'workerError',
        errorCode: e.errorCode,
        message: '外部操作的最终状态无法确认，请先在目标系统完成对账；为避免重复副作用，普通重试已禁用。',
        retryForbidden: 'host-effect-uncertain',
      };
    }
  }
  return found ?? { nodeId, attemptId: latestAttemptIdFor(events, nodeId) ?? `${nodeId}/attempts/001` };
}

/** What the daemon needs to render a revisit-budget grant card.  Derived from
 *  the blocked event (source/target/attempt) + a re-run budget check (which tier
 *  is exhausted — the card must grant the RIGHT scope, 菲菲 review).  Returns
 *  undefined when `nodeId` isn't actually blocked on REVISIT_BUDGET_EXHAUSTED. */
export interface V3RevisitBudgetBlockedInfo {
  sourceNodeId: string;
  toNodeId: string;
  attemptId: string;
  tier: 'pair' | 'run';
  detail: string;
}
export function revisitBudgetBlockedInfoFor(
  events: StoredEvent[],
  nodeId: string,
): V3RevisitBudgetBlockedInfo | undefined {
  const info = blockedInfoFor(events, nodeId);
  if (info.errorCode !== 'REVISIT_BUDGET_EXHAUSTED' || !info.revisitTo) return undefined;
  const status = revisitBudgetStatus(events, nodeId, info.revisitTo);
  // Exhausted at block time; if a grant already lifted it the card is stale —
  // fall back to 'pair' tier + the recorded message for a still-renderable card.
  return {
    sourceNodeId: nodeId,
    toNodeId: info.revisitTo,
    attemptId: info.attemptId,
    tier: status.ok ? 'pair' : status.tier,
    detail: status.ok ? (info.message ?? 'revisit budget') : status.detail,
  };
}

/** What the daemon needs to render an exhausted-loop grant card. */
export interface V3LoopExhaustedInfo {
  loopId: string;
  /** The iteration the loop exhausted at (= the grant card's freshness key). */
  iteration: number;
  /** Authored bound — filled when the dag is loadable (display only). */
  maxIterations?: number;
  /** Extra iterations already granted. */
  granted: number;
  /** Last decision detail (e.g. `result.passed=false (iteration 3/3)`). */
  detail?: string;
}

/** Fold the exhausted-loop card content from the journal.  Pure. */
export function loopExhaustedInfoFor(events: StoredEvent[], loopId: string): V3LoopExhaustedInfo {
  const ls = materialize(events).loops.get(loopId);
  let detail: string | undefined;
  for (const e of events) {
    if (e.type === 'loopIterationDecision' && e.loopId === loopId) detail = e.detail;
  }
  return { loopId, iteration: ls?.iteration ?? 0, granted: ls?.granted ?? 0, detail };
}

export interface V3DaemonRunDeps {
  /** runs root (default ~/.botmux/v3-runs). */
  baseDir?: string;
  /** bot config source (default live bots.json) — injectable for tests. */
  loadBots?: () => BotConfig[];
  /** Build the ephemeral pool's runNode — injectable for tests. Default = real pool. */
  makeRunNode?: (resolveLarkAppSecret: (larkAppId: string) => string | undefined) => V3RuntimeDeps['runNode'];
  /** Manifest validator — injectable for tests. Default = real readAndValidateManifest wrapper. */
  validateManifest?: ValidateManifest;
  /** Post (or re-post) a humanGate approval card for a pending gate to the bound topic. */
  postGateCard: (binding: RunChatBinding, gate: V3PendingGate, runId: string) => Promise<void>;
  /** Post a blocked-node retry card.  Optional — when absent (or no binding),
   *  a blocked outcome falls through to `onTerminal` like failed/succeeded. */
  postBlockedCard?: (binding: RunChatBinding, info: V3BlockedInfo, runId: string) => Promise<void>;
  /** Post an exhausted-loop grant card (+1 iteration).  Optional — same
   *  fallthrough semantics as postBlockedCard. */
  postLoopGrantCard?: (binding: RunChatBinding, info: V3LoopExhaustedInfo, runId: string) => Promise<void>;
  /** Post a revisit-budget grant card (+1 revisit).  Optional — same fallthrough
   *  semantics as postBlockedCard.  Chosen over the plain blocked card when the
   *  block is a `REVISIT_BUDGET_EXHAUSTED`. */
  postRevisitGrantCard?: (binding: RunChatBinding, info: V3RevisitBudgetBlockedInfo, runId: string) => Promise<void>;
  /** Report a terminal run (final card / message).  Optional. */
  onTerminal?: (runId: string, outcome: V3TerminalOutcome, binding?: RunChatBinding) => Promise<void>;
  maxParallel?: number;
  /** Low-latency interrupt delivery. Durable intent always lives in journal. */
  cancelSignal?: AbortSignal;
}

/**
 * Drive a daemon-side v3 run to its next suspension point (a gate) or terminal.
 * Returns the runtime outcome.  Throws on: missing grill state, no approved
 * dag, or awaitingGate with no chatBinding (can't post a card).
 */
export async function driveV3Run(runId: string, deps: V3DaemonRunDeps): Promise<V3RunOutcome> {
  const baseDir = deps.baseDir ?? defaultBaseDir();
  const runDir = safeRunDir(baseDir, runId);

  const preflight = preflightV3RunStart(runDir);
  if (!preflight.ok && preflight.error === 'no_grill_state') {
    throw new Error(`v3 daemon run: no grill state for "${runId}" in ${runDir}`);
  }
  if (!preflight.ok) {
    if (
      preflight.error === 'run_envelope_invalid' ||
      preflight.error === 'run_source_not_daemon_startable'
    ) {
      throw new Error(
        `v3 daemon run: "${runId}" authorization failed (${preflight.error})` +
        (preflight.detail ? `: ${preflight.detail}` : ''),
      );
    }
    throw new Error(`v3 daemon run: "${runId}" has no approved dag (status=${preflight.status ?? 'unknown'})`);
  }
  let context = preflight.context;

  // Was the run ALREADY terminal before this (re-)drive?  A coalesced re-drive or
  // a `/start` retry of a finished run re-runs no work (the journal is terminal),
  // but the notify block below would otherwise re-post cards / re-fire onTerminal
  // — duplicate "done/failed" messages. Capture now, short-circuit after runWorkflow.
  const journalPath = join(runDir, 'journal.ndjson');
  const wasAlreadyTerminal =
    existsSync(journalPath) &&
    ['succeeded', 'failed', 'cancelled'].includes(materialize(readJournal(journalPath)).runStatus);

  const bots = (deps.loadBots ?? loadBotConfigs)();
  if (!context.authorizedArtifacts) {
    if (!preflight.grill) {
      throw new Error(`v3 daemon run: legacy run "${runId}" has no approved grill basis`);
    }
    context = sealLegacyV3Run(runDir, preflight.grill, context.dag, bots);
  }
  const binding = context.binding;
  // Secret resolver by larkAppId from live bots.json; no env fallback (contract).
  const secretById = new Map(bots.map((b) => [b.larkAppId, b.larkAppSecret]));
  const resolveLarkAppSecret = (larkAppId: string): string | undefined => secretById.get(larkAppId);

  // codex's throw-based validator → runtime's result-style seam (override-able for tests).
  const validateManifest: ValidateManifest = deps.validateManifest ?? (async (manifestPath, outputDir) => {
    try {
      const manifest = await readAndValidateManifest(manifestPath, outputDir);
      return { ok: true, manifest };
    } catch (e) {
      return { ok: false, problems: e instanceof ManifestValidationError ? e.problems : [String(e)] };
    }
  });

  const resolveBotSnapshot = (botId: string | undefined) => botToSnapshot(resolveBotConfig(botId, bots));

  const runNode = (deps.makeRunNode ?? defaultMakeRunNode)(resolveLarkAppSecret);
  const dag = context.dag;

  // suspend mode → no resolveGate (runtime writes the wait + returns awaitingGate).
  const runtimeDeps: V3RuntimeDeps = {
    runNode,
    validateManifest,
    resolveBotSnapshot,
    hostExecutors: createDefaultHostExecutorRegistry(),
    hostReconcilers: createDefaultProviderReconcilers(),
  };
  const opts: V3RuntimeOptions = {
    baseDir,
    gateMode: 'suspend',
    ...(context.botSnapshots ? { frozenBotSnapshots: context.botSnapshots } : {}),
    ...(context.authorizedArtifacts ? { authorizedArtifacts: true } : {}),
    ...(context.resolvedWorkflowData ? { resolvedWorkflowData: context.resolvedWorkflowData } : {}),
    ...(deps.maxParallel ? { globalConcurrency: deps.maxParallel } : {}),
    ...(deps.cancelSignal ? { cancelSignal: deps.cancelSignal } : {}),
  };

  const outcome = await runWorkflow(dag, runtimeDeps, opts);

  if (wasAlreadyTerminal) {
    // Re-drive of an already-finished run: no work re-ran, so don't re-post
    // gate/blocked cards or re-fire onTerminal (would duplicate the terminal msg).
    return outcome;
  }

  if (outcome.reason === 'awaitingGate') {
    if (!binding) {
      // No chat binding (e.g. not born via grill) → can't post a card.  The
      // wait files are on disk; surface rather than silently strand the run.
      throw new Error(
        `v3 daemon run "${runId}" is awaiting gate(s) but has no chatBinding — cannot post approval card`,
      );
    }
    for (const gate of outcome.pendingWaits) {
      await deps.postGateCard(binding, gate, runId);
    }
  } else if (outcome.runStatus === 'blocked' && outcome.blockedNodeId && binding) {
    // Blocked = terminal-for-now.  Two distinct causes, two distinct cards:
    //   - exhausted LOOP (blockedNodeId is a loop id; nothing "failed", the
    //     work just didn't converge) → grant card (+1 iteration);
    //   - blocked node/instance (contract failure) → retry card (new attempt).
    const events = readJournal(join(runDir, 'journal.ndjson'));
    const isLoop = materialize(events).loops.has(outcome.blockedNodeId);
    const revisitBudget = revisitBudgetBlockedInfoFor(events, outcome.blockedNodeId);
    if (isLoop && deps.postLoopGrantCard) {
      const info = loopExhaustedInfoFor(events, outcome.blockedNodeId);
      const loopNode = dag.nodes.find((n) => n.id === outcome.blockedNodeId);
      if (loopNode && isLoopNode(loopNode)) info.maxIterations = loopNode.maxIterations;
      await deps.postLoopGrantCard(binding, info, runId);
    } else if (revisitBudget && deps.postRevisitGrantCard) {
      // Revisit budget exhausted → grant card (+1 revisit), not a plain retry.
      await deps.postRevisitGrantCard(binding, revisitBudget, runId);
    } else if (!isLoop && deps.postBlockedCard) {
      await deps.postBlockedCard(binding, blockedInfoFor(events, outcome.blockedNodeId), runId);
    } else {
      await deps.onTerminal?.(runId, outcome, binding);
    }
  } else {
    await deps.onTerminal?.(runId, outcome, binding);
  }

  return outcome;
}

function defaultMakeRunNode(
  resolveLarkAppSecret: (larkAppId: string) => string | undefined,
): V3RuntimeDeps['runNode'] {
  const { runNode } = createEphemeralPool({ resolveLarkAppSecret });
  return runNode;
}

export type V3GateClickOutcome =
  | { kind: 'resolved'; resolution: 'approved' | 'rejected' }
  | { kind: 'already-settled'; status: GateWaitStatus }
  | { kind: 'unauthorized' }
  | { kind: 'stale-run'; reason: 'terminal' | 'missing' | 'no-wait' | 'stale-node' };

/**
 * Resolve a humanGate approval-card click.  Idempotent + terminal-safe (codex
 * review #5):
 *   1. run terminal / journal missing → `stale-run` (caller toasts, does NOT
 *      redrive — a finished run must not be pulled back to life by a stale card).
 *   2. wait missing / non-pending → `stale-run`(no-wait) / `already-settled`
 *      (caller toasts, no redrive — guards repeat clicks).
 *   3. pending → `resolveWait` (atomic — THE idempotency guard) THEN append
 *      `gateResolved`.  Returns `resolved` → caller redrives.
 *
 * Order is wait-first on purpose: a crash between the two leaves the wait
 * settled (future clicks → already-settled, no double-resolve); the rare
 * wait-resolved-but-journal-missing gap is healed by cold-attach reconcile.
 * If the journal append throws, this throws — the caller must warn and NOT
 * fake UI success (codex #5).
 */
export function resolveV3GateClick(
  baseDir: string,
  runId: string,
  input: { waitId: string; selected: string; by: string },
): V3GateClickOutcome {
  const runDir = safeRunDir(baseDir, runId);
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return { kind: 'stale-run', reason: 'missing' };
  assertV3RunIntegrityForMutation(runDir);
  const snap = materialize(readJournal(journalPath));
  if (snap.runStatus !== 'running') return { kind: 'stale-run', reason: 'terminal' };

  const wait = readWait(runDir, input.waitId);
  if (!wait) return { kind: 'stale-run', reason: 'no-wait' };
  if (wait.status !== 'pending') return { kind: 'already-settled', status: wait.status };
  if (snap.nodes.get(wait.nodeId)?.status !== 'gateWaiting') {
    return { kind: 'stale-run', reason: 'stale-node' };
  }
  // Stale-card guard: the wait must belong to the node's CURRENT effective
  // instance.  A revisit makes a fresh instance + gate (`A#002-gate`); an old
  // `A#001-gate` card must NOT resolve the new instance's gate.
  if (wait.instanceId && wait.instanceId !== snap.nodes.get(wait.nodeId)?.effectiveInstanceId) {
    return { kind: 'stale-run', reason: 'stale-node' };
  }
  const dagNode = loadV3RunDagForRecovery(runDir)?.nodes.find((node) => node.id === wait.nodeId);
  const trustedHost = dagNode && isHostNode(dagNode) && wait.instanceId
    ? trustedHostGateMaterial(runDir, runId, wait.nodeId, wait.instanceId, readJournal(journalPath))
    : undefined;
  if (dagNode && isHostNode(dagNode)) {
    if (!trustedHost || !waitMatchesTrustedHostGate(wait, trustedHost)) {
      return { kind: 'stale-run', reason: 'no-wait' };
    }
  }
  if (!canResolveGateWait(wait, input.by)) return { kind: 'unauthorized' };
  const resolution = selectedResolution(wait, input.selected);
  if (!resolution) return { kind: 'stale-run', reason: 'no-wait' };

  const settled = resolveWaitOnce(
    runDir,
    input.waitId,
    resolution,
    input.by,
    input.selected,
  );
  if (!settled.changed) {
    return { kind: 'already-settled', status: settled.wait.status };
  }
  const resolvedWait = settled.wait;
  if (trustedHost && !waitMatchesTrustedHostGate(resolvedWait, trustedHost)) {
    appendEvent(journalPath, {
      type: 'gateResolved',
      nodeId: trustedHost.nodeId,
      instanceId: trustedHost.instanceId,
      waitId: trustedHost.waitId,
      resolution: 'rejected',
      by: 'system-host-wait-integrity',
      hostApproval: trustedHost.hostApproval,
    });
    return { kind: 'resolved', resolution: 'rejected' };
  }
  const instanceId = snap.nodes.get(resolvedWait.nodeId)?.effectiveInstanceId;
  appendEvent(journalPath, {
    type: 'gateResolved',
    // nodeId from the WAIT FILE, not caller input (codex review #1): the wait is
    // the authoritative state — a wrong/stale caller nodeId must not let us write
    // gateResolved for a different node.
    nodeId: resolvedWait.nodeId,
    ...(instanceId ? { instanceId } : {}),
    waitId: input.waitId,
    resolution,
    by: input.by,
    selected: input.selected,
    ...(trustedHost
      ? { hostApproval: trustedHost.hostApproval }
      : resolvedWait.hostApproval ? { hostApproval: resolvedWait.hostApproval } : {}),
  });
  return { kind: 'resolved', resolution };
}

export type V3RunCancelOutcome =
  | { kind: 'requested'; cancelRequestId: string }
  | { kind: 'already-requested'; cancelRequestId: string }
  | { kind: 'already-cancelled'; cancelRequestId?: string }
  | { kind: 'already-terminal'; status: 'succeeded' | 'failed' }
  | { kind: 'stale-run'; reason: 'missing' };

const CANCEL_ACTOR_MAX = 128;
const CANCEL_REASON_MAX = 500;

/**
 * Durable, idempotent run-cancel mutation shared by CLI, IM, cards and the
 * dashboard daemon endpoint. The journal lock is the linearization boundary:
 * a true terminal committed first wins; otherwise the first cancel request
 * wins and every repeat reuses its id.
 */
export function requestV3RunCancel(
  baseDir: string,
  runId: string,
  input: { by: string; reason?: string },
): V3RunCancelOutcome {
  const runDir = safeRunDir(baseDir, runId);
  if (!existsSync(runDir)) return { kind: 'stale-run', reason: 'missing' };
  assertV3RunIntegrityForMutation(runDir);

  const by = input.by.trim();
  if (!by || by.length > CANCEL_ACTOR_MAX || /[\r\n\0]/.test(by)) {
    throw new Error(`v3 cancel actor must be 1-${CANCEL_ACTOR_MAX} safe characters`);
  }
  const reason = input.reason?.trim();
  if (reason !== undefined && (reason.length === 0 || reason.length > CANCEL_REASON_MAX || /[\0]/.test(reason))) {
    throw new Error(`v3 cancel reason must be 1-${CANCEL_REASON_MAX} characters`);
  }

  const journalPath = join(runDir, 'journal.ndjson');
  return withJournalMutationSync(journalPath, ({ events, append }) => {
    const snap = materialize([...events]);
    if (snap.runStatus === 'cancelled') {
      return { kind: 'already-cancelled', cancelRequestId: snap.cancelRequestId };
    }
    if (snap.runStatus === 'succeeded' || snap.runStatus === 'failed') {
      return { kind: 'already-terminal', status: snap.runStatus };
    }
    if (snap.runStatus === 'cancelling' && snap.cancelRequestId) {
      return { kind: 'already-requested', cancelRequestId: snap.cancelRequestId };
    }
    const cancelRequestId = `cancel-${randomUUID()}`;
    append({
      type: 'runCancelRequested',
      cancelRequestId,
      by,
      ...(reason ? { reason } : {}),
    }, { durable: true });
    return { kind: 'requested', cancelRequestId };
  });
}

export type V3RetryOutcome =
  | { kind: 'requested'; nodeId: string; previousAttemptId: string; nextAttemptId: string }
  | { kind: 'already-requested'; nodeId: string }
  | { kind: 'stale-run'; reason: 'missing' | 'not-blocked' | 'stale-attempt' | 'loop-node' | 'invalid-answer' | 'host-effect-uncertain' };

type V3RetryAnswerInput =
  | { selected: string; by: string }
  | { text: string; by: string };

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

const HUMAN_ANSWER_PREVIEW_MAX_CHARS = 200;

function answerPreview(s: string): string {
  return s.length <= HUMAN_ANSWER_PREVIEW_MAX_CHARS
    ? s
    : `${s.slice(0, HUMAN_ANSWER_PREVIEW_MAX_CHARS)}...`;
}

/**
 * Append a retry intent for a blocked node (the resume entrypoint — daemon
 * card click and `botmux workflow retry` both land here).  Recovery-first +
 * idempotent (codex v2 of the blocked design):
 *   1. fresh `materialize(readJournal)` — the journal is the recovery source;
 *      a node that already succeeded / re-dispatched is seen as such.
 *   2. the target node must STILL be materialized `blocked`.  A node already
 *      reset to pending by an unconsumed `nodeRetryRequested` → already-requested
 *      (no second append); anything else → stale.
 *   3. `expectedAttemptId` (card clicks pass the card's attempt): the retry is
 *      only valid for the attempt that is CURRENTLY blocked — a stale card from
 *      attempt 001 must not advance attempt 002's blocked to 003 (codex
 *      blocker, slice-1 review).  The card nonce alone only proves the card's
 *      own integrity, not freshness.  CLI omits it ("retry whatever is blocked").
 *   4. append `nodeRetryRequested` with the reserved nextAttemptId and the
 *      previous blocked event's errorClass/errorCode copied in for audit.
 * The caller re-drives (materialize folds the retry into pending → orchestrator
 * re-dispatches with the reserved attempt number).
 */
export function requestV3Retry(
  baseDir: string,
  runId: string,
  input: { nodeId?: string; expectedAttemptId?: string; answer?: V3RetryAnswerInput } = {},
): V3RetryOutcome {
  const runDir = safeRunDir(baseDir, runId);
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return { kind: 'stale-run', reason: 'missing' };
  assertV3RunIntegrityForMutation(runDir);

  const events = readJournal(journalPath);
  const snap = materialize(events);
  // Target resolution: explicit nodeId > the run's blocked pointer > a node
  // with an unconsumed retry reservation (a prior retry already cleared the
  // blocked pointer — the idempotent repeat-call path).
  const retryKeyFor = (id: string): string => snap.nodes.get(id)?.effectiveInstanceId ?? id;
  const nodeId =
    input.nodeId ??
    snap.blockedNodeId ??
    [...snap.nodes.keys()].find((id) => unconsumedRetryEvent(events, retryKeyFor(id)) !== undefined);
  if (!nodeId) return { kind: 'stale-run', reason: 'not-blocked' };
  // An exhausted LOOP blocks the run too, but "retry an attempt" is the wrong
  // verb for it — the recovery is a grant (+1 iteration).  Route loudly.
  if (snap.loops.has(nodeId)) return { kind: 'stale-run', reason: 'loop-node' };

  const status = snap.nodes.get(nodeId)?.status;
  if (status === 'pending') {
    // An unconsumed retry reservation already reset this node — idempotent
    // no-op (a second click / a CLI retry racing the card must not double-append).
    const pendingRetry = unconsumedRetryEvent(events, retryKeyFor(nodeId));
    if (pendingRetry) {
      // The repeat-call is only "the same retry" when it references the attempt
      // that retry was FOR — a stale older card is not an idempotent repeat.
      if (input.expectedAttemptId && input.expectedAttemptId !== pendingRetry.previousAttemptId) {
        return { kind: 'stale-run', reason: 'stale-attempt' };
      }
      return { kind: 'already-requested', nodeId };
    }
    return { kind: 'stale-run', reason: 'not-blocked' };
  }
  if (status !== 'blocked') return { kind: 'stale-run', reason: 'not-blocked' };

  // Constraint 5: a retry stays in the SAME instance — key attempt numbering by
  // the blocked node's effective instance (`A#001`), not the bare nodeId, so the
  // new attempt is `A#001/attempts/002` (NOT a new instance).  Legacy runs with
  // no instance fall back to nodeId.
  const instanceId = snap.nodes.get(nodeId)?.effectiveInstanceId;
  const attemptKey = instanceId ?? nodeId;
  const previousAttemptId = latestAttemptIdFor(events, attemptKey);
  if (!previousAttemptId) return { kind: 'stale-run', reason: 'not-blocked' };
  const info = blockedInfoFor(events, nodeId);
  if (events.some((event) =>
    (event.type === 'hostEffectIntent' || event.type === 'hostEffectUncertain') &&
    event.attemptId === previousAttemptId)) {
    return { kind: 'stale-run', reason: 'host-effect-uncertain' };
  }
  // Freshness gate (codex blocker): the click must target the CURRENTLY
  // blocked attempt, not an earlier one whose card survived in the chat.
  if (input.expectedAttemptId && input.expectedAttemptId !== info.attemptId) {
    return { kind: 'stale-run', reason: 'stale-attempt' };
  }
  const nextAttemptId = nextAttemptIdFor(events, attemptKey);
  const resetGate = events.some((event) =>
    event.type === 'hostInputPrepared' && event.attemptId === previousAttemptId);

  // Runtime human-ask answer: persist the chosen option next to the asked
  // attempt (answer.json) and carry its path on the retry event — buildInputs
  // injects it into the next attempt as `{from:'human', name:'answer'}`.  Plain
  // blocked retries pass no answer and this whole block is skipped.  Core
  // validates membership against the current ask, because a card nonce proves
  // freshness/integrity but not that `selected` is one of the authored options.
  let answer: { path: string; preview: string; by: string } | undefined;
  if (input.answer) {
    if (!info.ask) {
      return { kind: 'stale-run', reason: 'invalid-answer' };
    }
    if ('selected' in input.answer) {
      if (info.ask.freeText === true || !info.ask.options.includes(input.answer.selected)) {
        return { kind: 'stale-run', reason: 'invalid-answer' };
      }
    } else {
      if (info.ask.freeText !== true || input.answer.text.trim() === '') {
        return { kind: 'stale-run', reason: 'invalid-answer' };
      }
    }
    const answerPath = join(runDir, previousAttemptId, GOAL_ANSWER_FILE);
    const payload: GoalAnswer =
      'text' in input.answer
        ? { text: input.answer.text, by: input.answer.by }
        : { selected: input.answer.selected, by: input.answer.by };
    atomicWriteJson(answerPath, payload);
    answer = {
      path: answerPath,
      preview: answerPreview('text' in payload ? payload.text : payload.selected),
      by: payload.by,
    };
  }

  appendEvent(journalPath, {
    type: 'nodeRetryRequested',
    nodeId,
    ...(instanceId ? { instanceId } : {}),
    previousAttemptId,
    nextAttemptId,
    reason: 'blockedRetry',
    previousErrorClass: info.errorClass,
    previousErrorCode: info.errorCode,
    ...(resetGate ? { resetGate: true } : {}),
    ...(answer ? { answer } : {}),
  });
  return { kind: 'requested', nodeId, previousAttemptId, nextAttemptId };
}

export type V3RevisitGrantOutcome =
  | { kind: 'granted'; scope: 'pair' | 'run'; retry: V3RetryOutcome }
  | { kind: 'invalid'; reason: 'partial-pair' | 'pair-source-mismatch' }
  | { kind: 'stale-run'; reason: 'missing' | 'not-budget-blocked' | 'stale-attempt' };

/** Grant +1 revisit budget after a run blocked on `REVISIT_BUDGET_EXHAUSTED`,
 *  then resume (the revisit analogue of a loop-iteration grant).  Atomic
 *  "continue": append `revisitBudgetGranted` AND retry the blocked node so it
 *  re-attempts its revisit within the extended budget — one entry, like the
 *  card's one-click.  Guards (菲菲 review):
 *   - the run MUST currently be blocked on a `REVISIT_BUDGET_EXHAUSTED` node
 *     (freshness + idempotency: after grant+retry the node is pending, so a
 *     repeat call is `not-budget-blocked` and adds NO further budget);
 *   - PAIR grant ⇒ both sourceNodeId+toNodeId, and sourceNodeId MUST be the
 *     blocked node; RUN grant ⇒ neither; a half-filled pair is rejected (never
 *     silently widened to a run grant);
 *   - `expectedAttemptId` (card passes it) must match the blocked attempt. */
export function requestRevisitGrant(
  baseDir: string,
  runId: string,
  input: { sourceNodeId?: string; toNodeId?: string; by: string; reason?: string; expectedAttemptId?: string },
): V3RevisitGrantOutcome {
  const runDir = safeRunDir(baseDir, runId);
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return { kind: 'stale-run', reason: 'missing' };
  assertV3RunIntegrityForMutation(runDir);

  // Reject a half-filled pair before touching state (never widen to run grant).
  const hasSource = input.sourceNodeId !== undefined;
  const hasTo = input.toNodeId !== undefined;
  if (hasSource !== hasTo) return { kind: 'invalid', reason: 'partial-pair' };
  const pair = hasSource && hasTo;

  // Freshness: must currently be blocked on a budget-exhausted node.
  const events = readJournal(journalPath);
  const snap = materialize(events);
  const blockedNodeId = snap.blockedNodeId;
  if (!blockedNodeId) return { kind: 'stale-run', reason: 'not-budget-blocked' };
  const info = blockedInfoFor(events, blockedNodeId);
  if (info.errorCode !== 'REVISIT_BUDGET_EXHAUSTED') return { kind: 'stale-run', reason: 'not-budget-blocked' };
  if (input.expectedAttemptId && input.expectedAttemptId !== info.attemptId) {
    return { kind: 'stale-run', reason: 'stale-attempt' };
  }
  // A pair grant must target the blocked node as its source.
  if (pair && input.sourceNodeId !== blockedNodeId) return { kind: 'invalid', reason: 'pair-source-mismatch' };

  // Recovery-safe grant (code review): the node can be blocked on
  // REVISIT_BUDGET_EXHAUSTED yet have budget ALREADY ok — that's the crash
  // window where a prior call appended `revisitBudgetGranted` but died before the
  // retry.  Re-granting there would double the budget for one approval.  So only
  // append the grant while the budget is STILL exhausted; otherwise just resume
  // (retry) the half-applied grant.  Both paths are idempotent: after the retry
  // the node is pending, so a further click is `not-budget-blocked`.
  const stillExhausted = info.revisitTo
    ? !revisitBudgetStatus(events, blockedNodeId, info.revisitTo).ok
    : true; // no recorded target → can't re-check; treat as exhausted (append once)
  if (stillExhausted) {
    appendEvent(journalPath, {
      type: 'revisitBudgetGranted',
      ...(pair ? { sourceNodeId: input.sourceNodeId, toNodeId: input.toNodeId } : {}),
      by: input.by,
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }
  // Resume: retry the blocked node so it re-runs and re-requests its revisit
  // within the now-extended budget (reuses requestV3Retry's idempotency/guards).
  const retry = requestV3Retry(baseDir, runId, { nodeId: blockedNodeId, expectedAttemptId: info.attemptId });
  return { kind: 'granted', scope: pair ? 'pair' : 'run', retry };
}

export type V3LoopGrantOutcome =
  | { kind: 'granted'; loopId: string; fromIteration: number; nextIteration: number }
  | { kind: 'already-granted'; loopId: string }
  | { kind: 'stale-run'; reason: 'missing' | 'not-exhausted' | 'stale-iteration' };

/**
 * Grant ONE extra iteration to an exhausted-blocked loop (the loop analogue
 * of `requestV3Retry` — daemon grant-card click and `botmux workflow grant`
 * both land here).  Same recovery-first discipline:
 *   1. fresh `materialize(readJournal)` — the journal is the only truth.
 *   2. the target loop must STILL be exhausted-blocked.  An unconsumed grant
 *      (`pendingGrant`) → already-granted (idempotent, no second append).
 *   3. `expectedIteration` (card clicks pass the card's iteration): the grant
 *      is only valid for the iteration the loop exhausted at — a stale card
 *      from an earlier exhaustion must not grant a second silent round
 *      (expectedAttemptId's lesson, ported).  CLI omits it.
 *   4. append `loopIterationGranted`; the caller re-drives (materialize folds
 *      the grant into a running loop → orchestrator starts iteration N+1).
 */
export function requestV3LoopGrant(
  baseDir: string,
  runId: string,
  input: { loopId?: string; expectedIteration?: number; by?: string } = {},
): V3LoopGrantOutcome {
  const runDir = safeRunDir(baseDir, runId);
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return { kind: 'stale-run', reason: 'missing' };
  assertV3RunIntegrityForMutation(runDir);

  const events = readJournal(journalPath);
  const snap = materialize(events);
  // Target: explicit loopId > the run's blocked pointer when it IS a loop >
  // a loop with an unconsumed grant (the idempotent repeat-call path).
  const loopId =
    input.loopId ??
    (snap.blockedNodeId && snap.loops.has(snap.blockedNodeId) ? snap.blockedNodeId : undefined) ??
    [...snap.loops.entries()].find(([, ls]) => ls.pendingGrant)?.[0];
  const ls = loopId ? snap.loops.get(loopId) : undefined;
  if (!loopId || !ls) return { kind: 'stale-run', reason: 'not-exhausted' };

  if (input.expectedIteration !== undefined && input.expectedIteration !== ls.iteration) {
    // Freshness gate: the card was rendered for the iteration the loop
    // exhausted at; a newer exhaustion (or a consumed grant) invalidates it.
    return { kind: 'stale-run', reason: 'stale-iteration' };
  }
  if (ls.pendingGrant) return { kind: 'already-granted', loopId };
  if (snap.nodes.get(loopId)?.status !== 'blocked' || ls.lastDecision !== 'exhausted') {
    return { kind: 'stale-run', reason: 'not-exhausted' };
  }

  appendEvent(journalPath, {
    type: 'loopIterationGranted', loopId, fromIteration: ls.iteration, by: input.by,
  });
  return { kind: 'granted', loopId, fromIteration: ls.iteration, nextIteration: ls.iteration + 1 };
}

/** The `nodeRetryRequested` for `key` whose reserved attempt has not yet been
 *  consumed by a matching `nodeDispatched` (undefined when none pending).  `key`
 *  matches by `(instanceId ?? nodeId)` so a stale retry on an OLD instance isn't
 *  mistaken for the current instance's pending retry (constraint 5 / review #3). */
function unconsumedRetryEvent(
  events: StoredEvent[],
  key: string,
): Extract<StoredEvent, { type: 'nodeRetryRequested' }> | undefined {
  const matches = (e: { nodeId: string; instanceId?: string }): boolean => (e.instanceId ?? e.nodeId) === key;
  let pending: Extract<StoredEvent, { type: 'nodeRetryRequested' }> | undefined;
  for (const e of events) {
    if (e.type === 'nodeRetryRequested' && matches(e)) pending = e;
    else if (e.type === 'nodeDispatched' && matches(e) && e.attemptId === pending?.nextAttemptId) {
      pending = undefined;
    }
  }
  return pending;
}

export interface V3GateRecovery {
  runId: string;
  runDir: string;
  binding?: RunChatBinding;
  /** pending gates whose approval card the daemon should (re)post. */
  repost: V3PendingGate[];
  /** blocked node whose retry card the daemon should (re)post — covers the
   *  crash window between the `runBlocked` append and the card send. */
  repostBlocked?: V3BlockedInfo;
  /** exhausted loop whose grant card the daemon should (re)post — the loop
   *  flavor of the same crash window. */
  repostLoopGrant?: V3LoopExhaustedInfo;
  /** revisit-budget-exhausted node whose grant card the daemon should (re)post —
   *  the revisit flavor of the same crash window. */
  repostRevisitGrant?: V3RevisitBudgetBlockedInfo;
  /** true when a resolved-but-unjournaled gate was healed → daemon should driveV3Run. */
  resume: boolean;
}

export interface V3GateRunnerDeps {
  baseDir?: string;
  /** Post (or re-post) a gate's approval card to its topic.  The daemon builds
   *  the card + sends via Lark (kept here so this module has no `im/` import). */
  postCard: (binding: RunChatBinding, gate: V3PendingGate, runId: string) => Promise<void>;
  /** Post (or re-post) a blocked node's retry card. */
  postBlockedCard?: (binding: RunChatBinding, info: V3BlockedInfo, runId: string) => Promise<void>;
  /** Post (or re-post) an exhausted loop's grant card. */
  postLoopGrantCard?: (binding: RunChatBinding, info: V3LoopExhaustedInfo, runId: string) => Promise<void>;
  /** Post (or re-post) a revisit-budget-exhausted node's grant card. */
  postRevisitGrantCard?: (binding: RunChatBinding, info: V3RevisitBudgetBlockedInfo, runId: string) => Promise<void>;
  /** Notify a terminal run (optional, daemon-supplied). */
  notifyTerminal?: (binding: RunChatBinding | undefined, runId: string, outcome: V3TerminalOutcome) => Promise<void>;
  /** Best-effort observability hooks. They must never affect run semantics. */
  onDriveBegin?: (runId: string) => void | Promise<void>;
  onDriveEnd?: (runId: string) => void | Promise<void>;
  /** runtime deps passthrough (tests inject; daemon uses real pool). */
  loadBots?: V3DaemonRunDeps['loadBots'];
  makeRunNode?: V3DaemonRunDeps['makeRunNode'];
  validateManifest?: V3DaemonRunDeps['validateManifest'];
  maxParallel?: number;
  /** error sink (default: swallow).  Daemon passes its logger.warn. */
  onError?: (runId: string, err: unknown) => void;
}

/**
 * The daemon's v3 gate run-controller: an in-flight-guarded `drive(runId)`
 * (mirrors v0.2's driveWorkflowRun re-entry) + a `coldAttach()` that re-arms
 * pending gates on startup.  Stateless except the in-flight set — recovery
 * source is always the runDir.
 */
export function createV3GateRunner(deps: V3GateRunnerDeps) {
  const baseDir = deps.baseDir ?? defaultBaseDir();
  const inFlight = new Set<string>();
  const rerunRequested = new Set<string>();
  const activeControllers = new Map<string, AbortController>();

  const invokeLifecycleHook = (
    hook: ((runId: string) => void | Promise<void>) | undefined,
    runId: string,
    phase: 'begin' | 'end',
  ): void => {
    if (!hook) return;
    void Promise.resolve()
      .then(() => hook(runId))
      .catch((err) => deps.onError?.(runId, new Error(
        `v3 progress ${phase} hook failed: ${err instanceof Error ? err.message : String(err)}`,
      )));
  };

  async function drive(runId: string): Promise<void> {
    // Coalesce (codex blocker #2): if a drive is already in flight for this run,
    // DON'T silently no-op — a click that resolved a gate + called driveDetached
    // while the prior drive was busy (e.g. slow postCard) would otherwise be
    // dropped and the run would stall at gateCleared/pending.  Mark a rerun and
    // let the active drive loop pick it up after it finishes.
    if (inFlight.has(runId)) {
      rerunRequested.add(runId);
      return;
    }
    inFlight.add(runId);
    try {
      do {
        rerunRequested.delete(runId); // clear before the run; a request DURING re-sets it
        invokeLifecycleHook(deps.onDriveBegin, runId, 'begin');
        const controller = new AbortController();
        activeControllers.set(runId, controller);
        try {
          // The in-memory guard above prevents duplicate drives inside one
          // daemon.  This lease extends the same invariant across rolling
          // restarts / an accidental second daemon: only the process that owns
          // the live worker promises may schedule, drain peers, or publish a
          // run boundary.
          // A cancel request itself uses the independent journal lock, so it
          // can still wake the lease holder while a second daemon waits here.
          const leaseTarget = v3DriveLeaseTarget(baseDir, runId);
          let leaseSettled = false;
          while (!leaseSettled) {
            try {
              await withFileLock(leaseTarget, async () => {
                // A durable cancel can land while driveV3Run is no longer in
                // runtime (for example it is awaiting a slow gate-card POST).
                // Re-fold under the SAME lease before releasing ownership so
                // the request cannot be stranded between runtime and transport.
                do {
                  await driveV3Run(runId, {
                    baseDir,
                    loadBots: deps.loadBots,
                    makeRunNode: deps.makeRunNode,
                    validateManifest: deps.validateManifest,
                    maxParallel: deps.maxParallel,
                    cancelSignal: controller.signal,
                    postGateCard: (binding, gate, rid) => deps.postCard(binding, gate, rid),
                    postBlockedCard: deps.postBlockedCard,
                    postLoopGrantCard: deps.postLoopGrantCard,
                    postRevisitGrantCard: deps.postRevisitGrantCard,
                    onTerminal: (rid, outcome, binding) =>
                      deps.notifyTerminal ? deps.notifyTerminal(binding, rid, outcome) : Promise.resolve(),
                  });
                } while (currentRunStatus(baseDir, runId) === 'cancelling');
              }, { maxWaitMs: V3_DRIVE_LEASE_MAX_WAIT_MS });
              leaseSettled = true;
            } catch (err) {
              // A second daemon may legitimately wait longer than one lock
              // window while the owner drains a wedged CLI or a Lark request.
              // Durable cancellation must keep a waiter alive until the lease
              // is released; ordinary duplicate drives may still fail fast.
              const lockTimedOut = err instanceof Error && err.message.includes('file-lock timeout waiting for');
              if (lockTimedOut && currentRunStatus(baseDir, runId) === 'cancelling') continue;
              throw err;
            }
          }
        } finally {
          if (activeControllers.get(runId) === controller) activeControllers.delete(runId);
          invokeLifecycleHook(deps.onDriveEnd, runId, 'end');
        }
      } while (rerunRequested.has(runId));
    } catch (err) {
      deps.onError?.(runId, err);
    } finally {
      inFlight.delete(runId);
      rerunRequested.delete(runId);
      activeControllers.delete(runId);
    }
  }

  /** Fire-and-forget drive (card-click / start IPC call this). */
  function driveDetached(runId: string): void {
    void drive(runId);
  }

  /** Deliver an already-durable cancel request to the active runtime and make
   *  sure a fresh replay runs even when the request raced post-card/teardown. */
  function cancelAndDrive(runId: string, cancelRequestId: string): void {
    const controller = activeControllers.get(runId);
    if (controller && !controller.signal.aborted) {
      controller.abort({ kind: 'run', cancelRequestId });
    }
    driveDetached(runId);
  }

  async function coldAttach(ownerLarkAppId?: string): Promise<void> {
    let recs: V3GateRecovery[] = [];
    try {
      recs = reconcileV3PendingGates(baseDir, ownerLarkAppId);
    } catch (err) {
      deps.onError?.('(cold-attach)', err);
      return;
    }
    for (const rec of recs) {
      if (rec.binding) {
        // When `resume` is true a self-healed gate lets the run be re-driven, and
        // that drive (driveV3Run, suspend mode) re-posts every STILL-pending gate
        // itself. Posting rec.repost here too would double-send the pending gate's
        // card in the "one gate healed + another still pending" case, so skip it
        // and let the drive own the re-post (codex nit #10). The blocked/loop/
        // revisit grant reposts always carry resume:false, so they're unaffected.
        if (!rec.resume) {
          for (const gate of rec.repost) {
            try {
              await deps.postCard(rec.binding, gate, rec.runId);
            } catch (err) {
              deps.onError?.(rec.runId, err);
            }
          }
        }
        if (rec.repostBlocked && deps.postBlockedCard) {
          try {
            await deps.postBlockedCard(rec.binding, rec.repostBlocked, rec.runId);
          } catch (err) {
            deps.onError?.(rec.runId, err);
          }
        }
        if (rec.repostLoopGrant && deps.postLoopGrantCard) {
          try {
            await deps.postLoopGrantCard(rec.binding, rec.repostLoopGrant, rec.runId);
          } catch (err) {
            deps.onError?.(rec.runId, err);
          }
        }
        if (rec.repostRevisitGrant && deps.postRevisitGrantCard) {
          try {
            await deps.postRevisitGrantCard(rec.binding, rec.repostRevisitGrant, rec.runId);
          } catch (err) {
            deps.onError?.(rec.runId, err);
          }
        }
      }
      if (rec.resume) driveDetached(rec.runId);
    }
  }

  return { drive, driveDetached, cancelAndDrive, coldAttach };
}

function currentRunStatus(baseDir: string, runId: string): ReturnType<typeof materialize>['runStatus'] | undefined {
  try {
    const journalPath = join(safeRunDir(baseDir, runId), 'journal.ndjson');
    if (!existsSync(journalPath)) return undefined;
    return materialize(readJournal(journalPath)).runStatus;
  } catch {
    // The actual drive path reports integrity/journal errors. This helper is
    // only a retry predicate and must never convert corruption into a spin.
    return undefined;
  }
}

/**
 * Cold-attach reconcile (daemon startup, codex review #2/#3).  Finds v3 runs
 * suspended at a humanGate and reconciles the journal↔wait-file atomic window
 * BOTH ways:
 *   - node `gateWaiting` + wait file MISSING (crash between the `gateDispatched`
 *     append and `writePendingWait`) → re-create the pending wait from the
 *     dag's `humanGate.prompt`, then repost a card.
 *   - node `gateWaiting` + wait RESOLVED (crash between `resolveWait` and the
 *     `gateResolved` append) → append the missing `gateResolved` → resume.
 *   - node `gateWaiting` + wait pending → just repost a card.
 * Skips terminal runs.  Pure file IO + journal append — the daemon decides what
 * to post / drive from the returned list.
 */
export function reconcileV3PendingGates(baseDir: string = defaultBaseDir(), ownerLarkAppId?: string): V3GateRecovery[] {
  if (!existsSync(baseDir)) return [];
  const out: V3GateRecovery[] = [];
  for (const runId of readdirSync(baseDir)) {
    if (!isValidRunId(runId)) continue; // skip non-run dirs / unsafe names (codex #2)
    const runDir = join(baseDir, runId);
    try {
      if (!statSync(runDir).isDirectory()) continue;
      const journalPath = join(runDir, 'journal.ndjson');
      if (!existsSync(journalPath)) continue;
      // Recovery may recreate a missing wait or heal a resolved wait by
      // appending gateResolved. Apply the same authorization boundary as live
      // clicks before cold-attach can mutate or repost anything for this run.
      assertV3RunIntegrityForMutation(runDir);

      const events = readJournal(journalPath);
      const snap = materialize(events);
      const hasOpenAttempts =
        openV3WorkerAttempts(events).length > 0 || openV3HostEffects(events).length > 0;
      if (
        snap.runStatus === 'succeeded' ||
        snap.runStatus === 'failed' ||
        snap.runStatus === 'cancelled'
      ) {
        if (!hasOpenAttempts) continue;
        const binding = readV3RunChatBinding(runDir);
        if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) continue;
        if (!binding) continue;
        // Pre-barrier histories may have published a terminal before a peer
        // outer process closed. Re-drive only to clean resources; driveV3Run's
        // already-terminal guard suppresses duplicate terminal notification.
        out.push({ runId, runDir, binding, repost: [], resume: true });
        continue;
      }

      if (snap.runStatus === 'cancelling') {
        const binding = readV3RunChatBinding(runDir);
        if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) continue;
        // Never repost stale gate/retry cards while cancellation is in
        // progress. A cold drive converges pending/gated nodes immediately;
        // workers from the dead daemon exit on IPC disconnect.
        out.push({ runId, runDir, binding, repost: [], resume: true });
        continue;
      }

      if (snap.runStatus === 'blocked') {
        if (hasOpenAttempts) {
          const binding = readV3RunChatBinding(runDir);
          if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) continue;
          if (!binding) continue;
          // Cleanup must finish before the retry/grant card is visible: an
          // immediate click must never overlap a pre-block bypass worker.
          out.push({ runId, runDir, binding, repost: [], resume: true });
          continue;
        }
        // Blocked run: repost the recovery card (covers the crash window
        // between the runBlocked append and the original card send) — grant
        // card for an exhausted loop, retry card for a blocked node.  Owner-
        // filtered like gates; binding-less (CLI/dev) runs are left alone.
        const binding = readV3RunChatBinding(runDir);
        if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) continue;
        if (!binding || !snap.blockedNodeId) continue;
        if (snap.loops.has(snap.blockedNodeId)) {
          const info = loopExhaustedInfoFor(events, snap.blockedNodeId);
          const recoveryDag = loadV3RunDagForRecovery(runDir);
          const loopNode = recoveryDag?.nodes.find((n) => n.id === snap.blockedNodeId);
          if (loopNode && isLoopNode(loopNode)) info.maxIterations = loopNode.maxIterations;
          out.push({ runId, runDir, binding, repost: [], repostLoopGrant: info, resume: false });
        } else {
          // Revisit-budget block → grant card; otherwise the plain retry card.
          const revisitBudget = revisitBudgetBlockedInfoFor(events, snap.blockedNodeId);
          if (revisitBudget) {
            out.push({ runId, runDir, binding, repost: [], repostRevisitGrant: revisitBudget, resume: false });
          } else {
            out.push({
              runId, runDir, binding,
              repost: [],
              repostBlocked: blockedInfoFor(events, snap.blockedNodeId),
              resume: false,
            });
          }
        }
        continue;
      }

      // runStatus === 'running'
      const rec = reconcileOneRun(runId, runDir, journalPath, snap, ownerLarkAppId);
      if (rec) {
        // A pending gate may coexist with an attempt owned by the dead daemon.
        // Let the drive fence/requeue it first; that drive will post every gate
        // still pending after resource convergence.
        out.push(hasOpenAttempts ? { ...rec, repost: [], resume: true } : rec);
        continue;
      }
      if (hasOpenAttempts) {
        const binding = readV3RunChatBinding(runDir);
        if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) continue;
        if (!binding) continue;
        out.push({ runId, runDir, binding, repost: [], resume: true });
        continue;
      }
      // No gate or open attempt to reconcile. If nothing is materialized as
      // running, the run died in a resumable control spot — e.g. crash right
      // after `nodeRetryRequested` or start — so re-drive it. Open worker
      // attempts were handled above by the unified fence barrier; a remaining
      // running node without an open ledger record is malformed/legacy state
      // and stays fail-closed here.
      //
      // Composite LOOP nodes are excluded from the phantom check (codex loop
      // review blocker): a loop is 'running' in PURE CONTROL states with no
      // worker behind it — right after loopStarted / a continue-decision / a
      // grant, the runtime's next tick derives the follow-up from the journal.
      // A crash in those windows must resume, or the run sticks forever (most
      // reproducible: grant click → loopIterationGranted appended → crash
      // before redrive).  Body INSTANCES still count as real in-flight.
      const hasRunning = [...snap.nodes.entries()].some(
        ([id, s]) => s.status === 'running' && !snap.loops.has(id),
      );
      if (!hasRunning) {
        const binding = readV3RunChatBinding(runDir);
        if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) continue;
        if (!binding) continue; // CLI/dev runs are not the daemon's to adopt
        out.push({ runId, runDir, binding, repost: [], resume: true });
      }
    } catch {
      // best-effort (codex #3): a single corrupt run (torn journal / bad
      // grill.state / IO error) must not kill the whole cold-attach scan.
      continue;
    }
  }
  return out;
}

function reconcileOneRun(
  runId: string,
  runDir: string,
  journalPath: string,
  snap: ReturnType<typeof materialize>,
  ownerLarkAppId?: string,
): V3GateRecovery | undefined {
  const events = readJournal(journalPath);
  const gateWaitingNodes = [...snap.nodes.entries()]
    .filter(([, s]) => s.status === 'gateWaiting')
    .map(([id]) => id);
  if (gateWaitingNodes.length === 0) return undefined;

  const binding = readV3RunChatBinding(runDir);

  // Multi-daemon owner filter (codex blocker #1): each bot daemon must only
  // touch runs bound to ITS larkAppId — otherwise every online daemon re-posts
  // / resumes the same pending gate.  A run with no binding (CLI/dev) or a
  // different owner is left for the owning daemon (or nobody).
  if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) return undefined;

  // dag (for humanGate.prompt when re-creating a missing wait).
  const dagNodeGate = new Map<string, ReturnType<typeof normalizeGateWaitInput> & {
    hostApproval?: { attemptId: string; approvalDigest: string; inputHash: string };
  }>();
  const trustedHostGates = new Map<string, TrustedHostGateMaterial>();
  const recoveryDag = loadV3RunDagForRecovery(runDir);
  if (recoveryDag) {
    for (const n of recoveryDag.nodes) {
      if (!n.humanGate?.prompt) continue;
      const gate = normalizeGateWaitInput(n.humanGate);
      if (!isHostNode(n)) {
        dagNodeGate.set(n.id, gate);
        continue;
      }
      const instanceId = snap.nodes.get(n.id)?.effectiveInstanceId;
      if (!instanceId) continue;
      const trusted = trustedHostGateMaterial(runDir, runId, n.id, instanceId, events);
      if (trusted) {
        trustedHostGates.set(n.id, trusted);
        dagNodeGate.set(n.id, trusted);
      }
    }
  }

  const repost: V3PendingGate[] = [];
  let resume = false;
  for (const nodeId of gateWaitingNodes) {
    // Instance-level waitId mirrors startGate so recovery reads the SAME wait
    // file the dispatch wrote (stale-card protection).
    const instanceId = snap.nodes.get(nodeId)?.effectiveInstanceId;
    const recoveredGate = dagNodeGate.get(nodeId);
    const trustedHostGate = trustedHostGates.get(nodeId);
    const dispatchedHostApproval = [...events].reverse().find(
      (event): event is StoredEvent & { type: 'gateDispatched' } =>
        event.type === 'gateDispatched' &&
        event.nodeId === nodeId &&
        event.instanceId === instanceId &&
        !!event.hostApproval,
    )?.hostApproval;
    const waitId = v3GateWaitId(
      nodeId,
      instanceId,
      trustedHostGate?.hostApproval ?? recoveredGate?.hostApproval ?? dispatchedHostApproval,
    );
    let wait = readWait(runDir, waitId);
    const recoveryNode = recoveryDag?.nodes.find((node) => node.id === nodeId);
    if (recoveryNode && isHostNode(recoveryNode)) {
      if (!trustedHostGate) {
        // The mutable wait can never substitute for missing/corrupt frozen
        // input. Reject with the token from the durable dispatch, if any.
        appendEvent(journalPath, {
          type: 'gateResolved',
          nodeId,
          ...(instanceId ? { instanceId } : {}),
          waitId,
          resolution: 'rejected',
          by: 'system-host-input-unrecoverable',
          ...(dispatchedHostApproval ? { hostApproval: dispatchedHostApproval } : {}),
        });
        resume = true;
        continue;
      }
      if (wait?.status === 'pending' && !waitMatchesTrustedHostGate(wait, trustedHostGate)) {
        // Pending delivery state is safe to repair because no human decision
        // has landed. Re-render from authorized DAG + verified sidecar.
        wait = writePendingWait(runDir, trustedHostGate);
      } else if (wait && wait.status !== 'pending' && !waitMatchesTrustedHostGate(wait, trustedHostGate)) {
        appendEvent(journalPath, {
          type: 'gateResolved',
          nodeId,
          ...(instanceId ? { instanceId } : {}),
          waitId,
          resolution: 'rejected',
          by: 'system-host-wait-integrity',
          hostApproval: trustedHostGate.hostApproval,
        });
        resume = true;
        continue;
      }
    }
    if (!wait) {
      const gate = dagNodeGate.get(nodeId);
      if (!gate && recoveryNode && isHostNode(recoveryNode)) {
        // A host gate is approval of one frozen input hash. If that input
        // cannot be verified, never recreate a generic/static card that could
        // approve different bytes; reject the gate and surface a failed run.
        const dispatched = [...events].reverse().find(
          (event): event is StoredEvent & { type: 'gateDispatched' } =>
            event.type === 'gateDispatched' && event.nodeId === nodeId && event.instanceId === instanceId,
        );
        appendEvent(journalPath, {
          type: 'gateResolved',
          nodeId,
          ...(instanceId ? { instanceId } : {}),
          waitId,
          resolution: 'rejected',
          by: 'system-host-input-unrecoverable',
          ...(dispatched?.hostApproval ? { hostApproval: dispatched.hostApproval } : {}),
        });
        resume = true;
        continue;
      }
      const safeGate = gate ?? normalizeGateWaitInput({ prompt: '(humanGate — 等待人工审批)' });
      wait = writePendingWait(runDir, { waitId, nodeId, ...(instanceId ? { instanceId } : {}), ...safeGate });
    }
    if (wait.status === 'pending') {
      const display = trustedHostGate ?? wait;
      repost.push({
        nodeId,
        waitId,
        prompt: display.prompt,
        options: display.options,
        approveOptions: display.approveOptions,
        approvers: display.approvers,
        ...(trustedHostGate
          ? { hostApproval: trustedHostGate.hostApproval }
          : wait.hostApproval ? { hostApproval: wait.hostApproval } : {}),
      });
    } else {
      // resolved wait but node still gateWaiting → journal lost gateResolved → heal.
      // nodeId from the wait file (authoritative, codex #1).
      appendEvent(journalPath, {
        type: 'gateResolved',
        nodeId: wait.nodeId,
        ...(snap.nodes.get(wait.nodeId)?.effectiveInstanceId ? { instanceId: snap.nodes.get(wait.nodeId)!.effectiveInstanceId } : {}),
        waitId,
        resolution: wait.status,
        by: wait.by ?? 'system',
        selected: wait.selected,
        ...(trustedHostGate
          ? { hostApproval: trustedHostGate.hostApproval }
          : wait.hostApproval ? { hostApproval: wait.hostApproval } : {}),
      });
      resume = true;
    }
  }
  return { runId, runDir, binding, repost, resume };
}
