/**
 * Engine-side control functions for external (bot-executed) goal attempts.
 *
 * These are the pure engine entry points a transport (the Feishu wiring) calls
 * when a target bot accepts, stalls, reports blocked, or submits results, and
 * when a human reassigns a node. Every journal write goes through the single
 * journal mutation lock and re-checks that the attempt is still the CURRENT
 * open attempt, so submission / timeout / cancel / reassign races are
 * first-wins by journal order. Callers re-drive the run afterwards.
 *
 * Authorization (who may call these, run.json integrity) is the caller's
 * concern; pass the authorized DAG through `ctx.dag` when available.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fsyncFilesAndDirectorySync } from '../../utils/fs-durability.js';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  type ManifestFile,
  type ManifestFileKind,
} from './artifact-contract.js';
import {
  V3_ARTIFACT_OUTPUT_KEY_RE,
  validateManifestArtifactContract,
} from './artifact-contract-declarations.js';
import { latestAttemptIdFor, nextAttemptIdFor } from './attempt-numbering.js';
import type { BotSnapshot } from './contract.js';
import { revisitBudgetStatus } from './core-control.js';
import {
  DEFAULT_NODE_TIMEOUT_SEC,
  isGoalNode,
  isLoopNode,
  loopInstanceId,
  type V3Dag,
  type V3Node,
} from './dag.js';
import { loadDag } from './dag-loader.js';
import type { StoredEvent, V3ErrorClass, V3LoopRef } from './event-contract.js';
import {
  foldV3ExternalAttempts,
  type V3ExternalAttempt,
} from './external-attempt-ledger.js';
import {
  V3_EXTERNAL_CALL_TIMEOUT_MS,
  V3_EXTERNAL_ERROR_CODES,
  type V3ExternalAttemptRef,
  type V3ExternalNodeExecutor,
  type V3ExternalStopReason,
} from './external-executor.js';
import { readJournal, withJournalMutationSync, type JournalMutation } from './journal.js';
import { ManifestValidationError, readAndValidateManifest } from './manifest.js';
import { readRevisitRequest, validateResult } from './result-contract.js';
import { planV3Revisit } from './revisit-plan.js';
import { materialize, type V3RunSnapshot } from './state.js';

// ─── Current-attempt classification ─────────────────────────────────────────

export type V3ExternalAttemptRejection =
  /** Not an external attempt of this run (or instance mismatch). */
  | 'unknown-attempt'
  /** The run is terminal / blocked; nothing is open. */
  | 'run-not-running'
  | 'already-succeeded'
  /** The instance was superseded by a revisit (or the attempt drained as obsolete). */
  | 'superseded'
  /** A newer attempt of the same instance exists (retry). */
  | 'retried'
  | 'cancelled'
  | 'timed-out'
  | 'reassigned'
  /** Closed for another recorded reason (blocked / failed / run boundary). */
  | 'closed'
  /** The caller's session is not the one that accepted the handoff. */
  | 'session-mismatch';

export type V3CurrentExternalAttempt =
  | { ok: true; attempt: V3ExternalAttempt; snap: V3RunSnapshot }
  | { ok: false; reason: V3ExternalAttemptRejection; attempt?: V3ExternalAttempt };

/**
 * Decide whether `attemptId` is the current open external attempt of its node.
 * Pure over `events`; call it under the journal lock before appending.
 *
 * `expect.sessionId`: omit for engine-internal checks; transport callers pass
 * the reporting session or `null` when they have none. Once the attempt is
 * accepted, only the accepting session may act on it (`null` is refused).
 */
export function classifyExternalAttempt(
  events: readonly StoredEvent[],
  attemptId: string,
  expect: { instanceId?: string; sessionId?: string | null } = {},
): V3CurrentExternalAttempt {
  const attempt = foldV3ExternalAttempts(events).get(attemptId);
  if (!attempt) return { ok: false, reason: 'unknown-attempt' };
  if (expect.instanceId !== undefined && expect.instanceId !== attempt.instanceId) {
    return { ok: false, reason: 'unknown-attempt' };
  }
  const snap = materialize([...events]);
  const newerAttempt = snap.attempts.get(attempt.instanceId ?? attempt.nodeId) !== attemptId;
  const state = attempt.instanceId
    ? snap.instances.get(attempt.instanceId)
    : snap.nodes.get(attempt.nodeId);
  const closed = attempt.closed;
  if (closed) {
    const reason: V3ExternalAttemptRejection =
      closed.kind === 'succeeded' ? 'already-succeeded'
      : closed.kind === 'reassigned' ? 'reassigned'
      : closed.kind === 'cancelled' ? 'cancelled'
      : closed.kind === 'blocked' && closed.errorCode === V3_EXTERNAL_ERROR_CODES.NODE_TIMEOUT ? 'timed-out'
      : closed.kind === 'drained' && closed.reason === 'runCancellation' ? 'cancelled'
      // An obsolete drain follows either an early-release cancel or a revisit.
      : closed.kind === 'drained' && closed.reason === 'obsoleteAttempt'
        ? (state?.status === 'cancelled' ? 'cancelled' : 'superseded')
      : newerAttempt ? 'retried'
      : 'closed';
    return { ok: false, reason, attempt };
  }
  if (snap.cancelRequestId !== undefined) return { ok: false, reason: 'cancelled', attempt };
  if (snap.runStatus !== 'running') return { ok: false, reason: 'run-not-running', attempt };
  if (state?.status === 'superseded') return { ok: false, reason: 'superseded', attempt };
  if (state?.status === 'cancelled') return { ok: false, reason: 'cancelled', attempt };
  if (newerAttempt) return { ok: false, reason: 'retried', attempt };
  if (state?.status !== 'running') return { ok: false, reason: 'closed', attempt };
  if (
    expect.sessionId !== undefined &&
    attempt.sessionId !== undefined &&
    expect.sessionId !== attempt.sessionId
  ) {
    return { ok: false, reason: 'session-mismatch', attempt };
  }
  return { ok: true, attempt, snap };
}

/** Caller-facing session expectation: an absent session is explicit `null`. */
function callerExpectation(input: { instanceId?: string; sessionId?: string }): {
  instanceId?: string;
  sessionId: string | null;
} {
  return {
    ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
    sessionId: input.sessionId ?? null,
  };
}

/** Transport identity of a prepared attempt (undefined before Prepared). */
export function externalAttemptRef(
  runId: string,
  attempt: V3ExternalAttempt,
): V3ExternalAttemptRef | undefined {
  if (!attempt.targetLarkAppId || !attempt.placement || attempt.revision === undefined) {
    return undefined;
  }
  return {
    runId,
    nodeId: attempt.nodeId,
    ...(attempt.instanceId ? { instanceId: attempt.instanceId } : {}),
    attemptId: attempt.attemptId,
    revision: attempt.revision,
    targetLarkAppId: attempt.targetLarkAppId,
    placement: attempt.placement,
  };
}

/** Settle `call` or reject after `timeoutMs` (engine-side bound on every
 *  transport call). The timer never keeps the process alive. */
export async function withExternalCallTimeout<T>(
  call: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`external ${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stop the target bot's turn for `attempt`. Best-effort and idempotent:
 *  failures are returned (never thrown) because the journal close, not the
 *  remote stop, is what invalidates the attempt. The request carries every
 *  identity the handoff may have been delivered under — the idempotency keys
 *  even when no Sent record exists yet. */
export async function stopExternalAttempt(
  executor: V3ExternalNodeExecutor | undefined,
  runId: string,
  attempt: V3ExternalAttempt,
  reason: V3ExternalStopReason,
  timeoutMs: number = V3_EXTERNAL_CALL_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const ref = externalAttemptRef(runId, attempt);
  // Before Prepared nothing can have been delivered, so there is no turn.
  if (!executor || !ref) return { ok: true };
  try {
    await withExternalCallTimeout(Promise.resolve().then(() => executor.stop({
      ...ref,
      reason,
      ...(attempt.idempotency ? { idempotency: attempt.idempotency } : {}),
      ...(attempt.handoffMessageId ? { handoffMessageId: attempt.handoffMessageId } : {}),
      ...(attempt.nodeCardMessageId ? { nodeCardMessageId: attempt.nodeCardMessageId } : {}),
      ...(attempt.threadId ? { threadId: attempt.threadId } : {}),
      ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
    })), timeoutMs, 'stop');
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// ─── Shared context ────────────────────────────────────────────────────────

export interface V3ExternalEngineContext {
  /** Authorized DAG. Defaults to `<runDir>/dag.json`. */
  dag?: V3Dag;
  /** Engine clock (ms). Defaults to Date.now. */
  now?: () => number;
}

function journalPathOf(runDir: string): string {
  return join(runDir, 'journal.ndjson');
}

function dagFor(runDir: string, ctx: V3ExternalEngineContext | undefined): V3Dag {
  return ctx?.dag ?? loadDag(join(runDir, 'dag.json'));
}

function clockOf(ctx: V3ExternalEngineContext | undefined): () => number {
  return ctx?.now ?? Date.now;
}

/** The effective node definition an attempt runs (loop bodies expanded the
 *  same way the runtime's instanceNodeFor does). */
export function externalAttemptNode(
  dag: V3Dag,
  attempt: { nodeId: string; loop?: V3LoopRef },
): V3Node | undefined {
  if (!attempt.loop) return dag.nodes.find((node) => node.id === attempt.nodeId);
  const loopNode = dag.nodes.find((node) => node.id === attempt.loop!.loopId);
  if (!loopNode || !isLoopNode(loopNode)) return undefined;
  const body = loopNode.body.nodes.find((node) => node.id === attempt.loop!.bodyNodeId);
  if (!body) return undefined;
  const ref = attempt.loop;
  return {
    ...body,
    id: loopInstanceId(ref.loopId, ref.iteration, ref.bodyNodeId),
    bot: body.bot ?? loopNode.bot,
    depends: body.depends.map((d) => ({ from: loopInstanceId(ref.loopId, ref.iteration, d.from) })),
    inputs: body.inputs.map((r) => ({
      from: loopInstanceId(ref.loopId, ref.iteration, r.from),
      ...(r.select ? { select: r.select } : {}),
      ...(r.output !== undefined ? { output: r.output } : {}),
    })),
  };
}

function nodeTimeoutMs(node: V3Node | undefined): number {
  return (node?.timeoutSec ?? DEFAULT_NODE_TIMEOUT_SEC) * 1000;
}

/** Resolve an attemptId to its directory, refusing anything outside runDir. */
export function safeExternalAttemptDir(runDir: string, attemptId: string): string {
  const root = resolve(runDir);
  const candidate = resolve(root, attemptId);
  const rel = relative(root, candidate);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`v3 external: attempt path escapes run dir (${attemptId})`);
  }
  return candidate;
}

// ─── Acceptance / stall / bot-reported block ───────────────────────────────

export type V3ExternalRecordOutcome =
  | { ok: true }
  | { ok: false; reason: V3ExternalAttemptRejection };

/**
 * Append `nodeHandoffAccepted` for the current attempt. The node timeout is
 * counted from `acceptedAt` (defaults to now; never later than now).
 * Idempotent for the same session; a different session is rejected.
 */
export function recordExternalAccepted(
  runDir: string,
  input: { attemptId: string; instanceId?: string; sessionId: string; acceptedAt?: number },
  ctx?: V3ExternalEngineContext,
): { ok: true; deadlineAt: number; alreadyAccepted: boolean } | { ok: false; reason: V3ExternalAttemptRejection } {
  const dag = dagFor(runDir, ctx);
  const now = clockOf(ctx)();
  return withJournalMutationSync(journalPathOf(runDir), ({ events, append }) => {
    return appendAcceptedLocked(events, append, dag, input, now);
  });
}

/** Lock-held body of {@link recordExternalAccepted}; the runtime's acceptance
 *  probe shares it so both paths apply the same first-wins rule. */
export function appendAcceptedLocked(
  events: readonly StoredEvent[],
  append: JournalMutation['append'],
  dag: V3Dag,
  input: { attemptId: string; instanceId?: string; sessionId: string; acceptedAt?: number },
  now: number,
): { ok: true; deadlineAt: number; alreadyAccepted: boolean } | { ok: false; reason: V3ExternalAttemptRejection } {
  const current = classifyExternalAttempt(events, input.attemptId, {
    ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
    sessionId: input.sessionId,
  });
  if (!current.ok) return { ok: false, reason: current.reason };
  const { attempt } = current;
  if (attempt.phase === 'accepted') {
    return { ok: true, deadlineAt: attempt.deadlineAt!, alreadyAccepted: true };
  }
  if (attempt.phase === 'dispatched') return { ok: false, reason: 'unknown-attempt' };
  const acceptedAt = Math.min(input.acceptedAt ?? now, now);
  const deadlineAt = acceptedAt + nodeTimeoutMs(externalAttemptNode(dag, attempt));
  append({
    type: 'nodeHandoffAccepted',
    nodeId: attempt.nodeId,
    ...(attempt.instanceId ? { instanceId: attempt.instanceId } : {}),
    attemptId: attempt.attemptId,
    sessionId: input.sessionId,
    acceptedAt,
    deadlineAt,
  }, { durable: true });
  return { ok: true, deadlineAt, alreadyAccepted: false };
}

/** The bot's turn ended without a valid submission (display only). */
export function recordExternalStalled(
  runDir: string,
  input: { attemptId: string; instanceId?: string; sessionId?: string; at?: number },
  ctx?: V3ExternalEngineContext,
): V3ExternalRecordOutcome {
  const at = input.at ?? clockOf(ctx)();
  return withJournalMutationSync(journalPathOf(runDir), ({ events, append }) => {
    const current = classifyExternalAttempt(events, input.attemptId, callerExpectation(input));
    if (!current.ok) return { ok: false, reason: current.reason };
    append({
      type: 'nodeStalled',
      nodeId: current.attempt.nodeId,
      ...(current.attempt.instanceId ? { instanceId: current.attempt.instanceId } : {}),
      attemptId: current.attempt.attemptId,
      at,
    });
    return { ok: true };
  });
}

const BOT_REPORT_MESSAGE_MAX_CHARS = 2000;

/** The target bot said it cannot complete the node (`--status blocked|failed`).
 *  Both settle as `nodeBlocked(BOT_REPORTED_BLOCKED)` with the bot's reason. */
export function reportExternalBlocked(
  runDir: string,
  input: { attemptId: string; instanceId?: string; sessionId?: string; reason: string },
): V3ExternalRecordOutcome {
  const message = input.reason.trim().slice(0, BOT_REPORT_MESSAGE_MAX_CHARS) || 'bot reported blocked';
  return withJournalMutationSync(journalPathOf(runDir), ({ events, append }) => {
    const current = classifyExternalAttempt(events, input.attemptId, callerExpectation(input));
    if (!current.ok) return { ok: false, reason: current.reason };
    append({
      type: 'nodeBlocked',
      nodeId: current.attempt.nodeId,
      ...(current.attempt.instanceId ? { instanceId: current.attempt.instanceId } : {}),
      attemptId: current.attempt.attemptId,
      errorClass: 'workerError',
      errorCode: V3_EXTERNAL_ERROR_CODES.BOT_REPORTED_BLOCKED,
      message,
    }, { durable: true });
    return { ok: true };
  });
}

// ─── Structured submission ─────────────────────────────────────────────────

export interface V3ExternalSubmissionFile {
  /** Declared output key (or, for a node without `outputs`, a logical name). */
  key: string;
  /** Original file name; used as the stored path only for undeclared outputs. */
  name?: string;
  /** Raw bytes, or a readable host path. Size and sha256 are computed here. */
  data: Buffer | { path: string };
  /** Kind for an undeclared output (declared outputs use their declared kind). */
  kind?: ManifestFileKind;
}

export interface V3ExternalSubmission {
  attemptId: string;
  instanceId?: string;
  sessionId?: string;
  files: V3ExternalSubmissionFile[];
  /** Parsed `result.json` value, written by the engine. */
  result?: unknown;
  summary: string;
}

export type V3ExternalSubmissionOutcome =
  | { ok: true; kind: 'succeeded'; manifestPath: string }
  | { ok: true; kind: 'revisit'; toNodeId: string }
  | { ok: true; kind: 'blocked'; errorCode: string }
  | { ok: false; reason: V3ExternalAttemptRejection }
  | { ok: false; reason: 'invalid'; problems: string[] };

const RESULT_FILE = 'result.json';

const MIME_BY_KIND: Record<ManifestFileKind, string> = {
  markdown: 'text/markdown',
  json: 'application/json',
  text: 'text/plain',
  code: 'text/plain',
  log: 'text/plain',
  binary: 'application/octet-stream',
  directory: 'inode/directory',
};

function inferKind(name: string): ManifestFileKind {
  const ext = extname(name).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json') return 'json';
  if (ext === '.txt') return 'text';
  if (ext === '.log') return 'log';
  if ([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt',
    '.c', '.h', '.cc', '.cpp', '.hpp', '.rb', '.sh', '.sql', '.yaml', '.yml', '.toml',
    '.html', '.css', '.diff', '.patch',
  ].includes(ext)) return 'code';
  return 'binary';
}

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' &&
    !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

interface StagedFile {
  key: string;
  path: string;
  kind: ManifestFileKind;
  bytes: Buffer;
}

/** Map submitted files onto output paths per the node contract (no IO). */
function planSubmissionFiles(
  node: V3Node,
  submission: V3ExternalSubmission,
): { ok: true; files: StagedFile[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const files: StagedFile[] = [];
  const usedPaths = new Set<string>();
  const declared = node.outputs;
  for (const [index, file] of submission.files.entries()) {
    const where = `files[${index}] (${JSON.stringify(file.key)})`;
    if (typeof file.key !== 'string' || !V3_ARTIFACT_OUTPUT_KEY_RE.test(file.key)) {
      problems.push(`${where}: key must match ${V3_ARTIFACT_OUTPUT_KEY_RE}`);
      continue;
    }
    let path: string;
    let kind: ManifestFileKind;
    if (declared) {
      const declaration = Object.prototype.hasOwnProperty.call(declared, file.key)
        ? declared[file.key]
        : undefined;
      if (!declaration) {
        problems.push(`${where}: output key is not declared by node "${node.id}" (declared: ${Object.keys(declared).join(', ')})`);
        continue;
      }
      path = declaration.path;
      kind = declaration.kind;
    } else {
      const candidate = file.name !== undefined ? basename(file.name) : file.key;
      if (!isSafeSegment(candidate)) {
        problems.push(`${where}: name must be a plain file name`);
        continue;
      }
      path = candidate;
      kind = file.kind ?? inferKind(candidate);
    }
    if (kind === 'directory') {
      problems.push(`${where}: directory outputs cannot be submitted as files`);
      continue;
    }
    if (usedPaths.has(path)) {
      problems.push(`${where}: output path ${JSON.stringify(path)} is submitted more than once`);
      continue;
    }
    let bytes: Buffer;
    try {
      if (Buffer.isBuffer(file.data)) {
        bytes = file.data;
      } else {
        // lstat: a symlink is refused rather than followed, so a submission
        // can never pull bytes from outside the place it was staged.
        const st = lstatSync(file.data.path);
        if (!st.isFile()) {
          problems.push(`${where}: ${file.data.path} is not a regular file`);
          continue;
        }
        bytes = readFileSync(file.data.path);
      }
    } catch (err) {
      problems.push(`${where}: unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    usedPaths.add(path);
    files.push({ key: file.key, path, kind, bytes });
  }
  if (submission.result !== undefined) {
    if (usedPaths.has(RESULT_FILE)) {
      problems.push('result.json is submitted both as a file and as the structured result');
    } else {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(submission.result, null, 2) as string | undefined;
        if (serialized === undefined) problems.push('result is not JSON-serializable');
      } catch (err) {
        problems.push(`result is not JSON-serializable (${err instanceof Error ? err.message : String(err)})`);
      }
      if (serialized !== undefined) {
        const declaredKey = declared
          ? Object.entries(declared).find(([, declaration]) => declaration.path === RESULT_FILE)?.[0]
          : undefined;
        files.push({ key: declaredKey ?? 'result', path: RESULT_FILE, kind: 'json', bytes: Buffer.from(`${serialized}\n`) });
        usedPaths.add(RESULT_FILE);
      }
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, files };
}

/** Write staged files + the engine-generated manifest into a private dir. */
function stageSubmission(stageDir: string, files: StagedFile[], summary: string): string {
  const workDir = join(stageDir, 'work');
  mkdirSync(workDir, { recursive: true });
  const entries: ManifestFile[] = [];
  for (const file of files) {
    const target = join(workDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes, { flag: 'wx', mode: 0o600 });
    entries.push({
      name: file.key,
      path: file.path,
      kind: file.kind,
      bytes: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
      mime: MIME_BY_KIND[file.kind],
    });
  }
  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    status: 'ok',
    summary,
    files: entries,
  };
  const manifestPath = join(stageDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return manifestPath;
}

type SubmissionVerdict =
  | { kind: 'success' }
  | { kind: 'revisit'; request: { toNodeId: string; reason?: string } }
  | { kind: 'invalid'; problems: string[] };

/** The same contract order as the in-process worker settle path. */
function judgeStagedSubmission(node: V3Node, manifest: Manifest, workDir: string): SubmissionVerdict {
  const revisit = readRevisitRequest(manifest, workDir);
  if (!revisit.ok) return { kind: 'invalid', problems: revisit.problems };
  if (revisit.request) {
    if (!node.revisitTo?.includes(revisit.request.toNodeId)) {
      return {
        kind: 'invalid',
        problems: [`result.json requests revisit to "${revisit.request.toNodeId}", not in node "${node.id}".revisitTo`],
      };
    }
    return { kind: 'revisit', request: revisit.request };
  }
  if (node.resultSchema) {
    const entry = manifest.files.find((f) => f.path === RESULT_FILE);
    if (!entry) {
      return { kind: 'invalid', problems: ['node declares resultSchema but the submission has no result.json'] };
    }
    const res = validateResult(join(workDir, entry.path), node.resultSchema);
    if (!res.ok) return { kind: 'invalid', problems: res.problems ?? ['result.json failed schema validation'] };
  }
  const contract = validateManifestArtifactContract(node.outputs, manifest);
  if (!contract.ok) return { kind: 'invalid', problems: contract.problems };
  return { kind: 'success' };
}

/** Move a crash-left (uncommitted) work/ or manifest aside before installing. */
function moveAsideIfPresent(path: string, tag: string): void {
  if (!existsSync(path)) return;
  renameSync(path, `${path}.uncommitted-${tag}`);
}

/** Durable install intent, written under the journal lock before the first
 *  rename of a submission into the attempt directory and removed once the
 *  verdict is journalled. Its presence after a crash means "installed (or
 *  partly installed) but not recorded". */
export const V3_SUBMISSION_INTENT_FILE = 'submission.intent.json';

interface SubmissionIntent {
  schemaVersion: 1;
  attemptId: string;
  stageTag: string;
}

function submissionIntentPath(attemptDir: string): string {
  return join(attemptDir, V3_SUBMISSION_INTENT_FILE);
}

function writeSubmissionIntent(attemptDir: string, intent: SubmissionIntent): void {
  const path = submissionIntentPath(attemptDir);
  writeFileSync(path, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
  fsyncFilesAndDirectorySync(attemptDir, [path]);
}

function removeSubmissionIntent(attemptDir: string, stageTag: string): void {
  rmSync(submissionIntentPath(attemptDir), { force: true });
  rmSync(join(attemptDir, 'submissions', stageTag), { recursive: true, force: true });
  try {
    rmdirSync(join(attemptDir, 'submissions'));
  } catch {
    // Another staged submission may still be in flight; leave its parent.
  }
}

function readSubmissionIntent(attemptDir: string): SubmissionIntent | 'corrupt' | undefined {
  const path = submissionIntentPath(attemptDir);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SubmissionIntent>;
    if (raw.schemaVersion !== 1 || typeof raw.attemptId !== 'string' || typeof raw.stageTag !== 'string') {
      return 'corrupt';
    }
    if (!/^[0-9a-f-]{36}$/.test(raw.stageTag)) return 'corrupt';
    return { schemaVersion: 1, attemptId: raw.attemptId, stageTag: raw.stageTag };
  } catch {
    return 'corrupt';
  }
}

/** Synchronous re-validation of an installed submission (the engine wrote
 *  these bytes; this proves they are still exactly what the manifest says). */
function verifyInstalledSubmissionSync(
  manifestPath: string,
  workDir: string,
): { ok: true; manifest: Manifest } | { ok: false; problems: string[] } {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
  } catch (err) {
    return { ok: false, problems: [`manifest unreadable: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.status !== 'ok' || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { ok: false, problems: ['manifest is not an engine-generated success manifest'] };
  }
  const root = resolve(workDir);
  const problems: string[] = [];
  for (const file of manifest.files) {
    const target = resolve(root, file.path);
    const rel = relative(root, target);
    if (!rel || isAbsolute(rel) || rel.startsWith('..')) {
      problems.push(`${file.path}: escapes the output directory`);
      continue;
    }
    try {
      if (!lstatSync(target).isFile()) {
        problems.push(`${file.path}: not a regular file`);
        continue;
      }
      const bytes = readFileSync(target);
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        problems.push(`${file.path}: bytes do not match the manifest`);
      }
    } catch (err) {
      problems.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, manifest };
}

/** Append the verdict of an installed submission for the current attempt.
 *  Caller holds the journal lock and has already classified the attempt. */
function appendInstalledVerdictLocked(input: {
  runDir: string;
  dag: V3Dag;
  events: readonly StoredEvent[];
  append: JournalMutation['append'];
  attempt: V3ExternalAttempt;
  verdict: Extract<SubmissionVerdict, { kind: 'success' | 'revisit' }>;
  manifestPath: string;
}): Extract<V3ExternalSubmissionOutcome, { ok: true }> {
  const { attempt, append, events, verdict, manifestPath } = input;
  const identity = {
    nodeId: attempt.nodeId,
    ...(attempt.instanceId ? { instanceId: attempt.instanceId } : {}),
    attemptId: attempt.attemptId,
  };
  if (verdict.kind === 'revisit') {
    // Budget is judged against the locked journal (another revisit may have
    // consumed it since staging).
    const budget = revisitBudgetStatus([...events], attempt.nodeId, verdict.request.toNodeId);
    if (!budget.ok) {
      append({
        type: 'nodeBlocked',
        ...identity,
        errorClass: 'resultInvalid',
        errorCode: 'REVISIT_BUDGET_EXHAUSTED',
        message: budget.detail,
        revisitTo: verdict.request.toNodeId,
      }, { durable: true });
      return { ok: true, kind: 'blocked', errorCode: 'REVISIT_BUDGET_EXHAUSTED' };
    }
    const plan = planV3Revisit({
      runDir: input.runDir,
      dag: input.dag,
      events,
      nodeId: attempt.nodeId,
      instanceId: attempt.instanceId ?? attempt.nodeId,
      attemptId: attempt.attemptId,
      request: verdict.request,
      sourceManifestPath: manifestPath,
    });
    for (const event of plan.events) append(event);
    // A revisit verdict is not a node settle: close the binding explicitly.
    append({ type: 'nodeAttemptDrained', ...identity, reason: 'obsoleteAttempt' }, { durable: true });
    return { ok: true, kind: 'revisit', toNodeId: verdict.request.toNodeId };
  }
  append({ type: 'nodeSucceeded', ...identity, manifestPath }, { durable: true });
  return { ok: true, kind: 'succeeded', manifestPath };
}

/** True when the journal already records the verdict an install produced. */
function installVerdictCommitted(events: readonly StoredEvent[], attemptId: string): boolean {
  return events.some((event) =>
    (event.type === 'nodeSucceeded' && event.attemptId === attemptId) ||
    (event.type === 'nodeRevisitRequested' && event.attemptId === attemptId) ||
    (event.type === 'nodeBlocked' && event.attemptId === attemptId && event.errorCode === 'REVISIT_BUDGET_EXHAUSTED'));
}

export type V3InstallRecovery =
  | { kind: 'none' }
  | { kind: 'committed'; outcome: Extract<V3ExternalSubmissionOutcome, { ok: true }> }
  /** The intent was already journalled; only the marker was left behind. */
  | { kind: 'cleaned' }
  /** The attempt can no longer take it, or the bytes failed re-validation. */
  | { kind: 'discarded' };

/** Lock-held body of {@link settleExternalInstallIntent}. */
function settleInstallIntentLocked(
  runDir: string,
  dag: V3Dag,
  events: readonly StoredEvent[],
  append: JournalMutation['append'],
  attemptId: string,
): V3InstallRecovery {
  const attemptDir = safeExternalAttemptDir(runDir, attemptId);
  const intent = readSubmissionIntent(attemptDir);
  if (intent === undefined) return { kind: 'none' };
  if (intent === 'corrupt' || intent.attemptId !== attemptId) {
    rmSync(submissionIntentPath(attemptDir), { force: true });
    return { kind: 'discarded' };
  }
  const workDir = join(attemptDir, 'work');
  const manifestPath = join(attemptDir, 'manifest.json');
  const stageDir = join(attemptDir, 'submissions', intent.stageTag);
  const discard = (): V3InstallRecovery => {
    if (!installVerdictCommitted(events, attemptId)) {
      moveAsideIfPresent(workDir, intent.stageTag);
      moveAsideIfPresent(manifestPath, intent.stageTag);
    }
    removeSubmissionIntent(attemptDir, intent.stageTag);
    return { kind: 'discarded' };
  };
  if (installVerdictCommitted(events, attemptId)) {
    removeSubmissionIntent(attemptDir, intent.stageTag);
    return { kind: 'cleaned' };
  }
  const current = classifyExternalAttempt(events, attemptId);
  if (!current.ok) return discard();
  const node = externalAttemptNode(dag, current.attempt);
  if (!node || !isGoalNode(node)) return discard();
  // Finish whatever part of the install the crash interrupted.
  if (existsSync(join(stageDir, 'work'))) {
    moveAsideIfPresent(workDir, intent.stageTag);
    renameSync(join(stageDir, 'work'), workDir);
  }
  if (existsSync(join(stageDir, 'manifest.json'))) renameSync(join(stageDir, 'manifest.json'), manifestPath);
  const verified = verifyInstalledSubmissionSync(manifestPath, workDir);
  if (!verified.ok) return discard();
  const verdict = judgeStagedSubmission(node, verified.manifest, workDir);
  if (verdict.kind === 'invalid') return discard();
  const outcome = appendInstalledVerdictLocked({
    runDir, dag, events, append, attempt: current.attempt, verdict, manifestPath,
  });
  removeSubmissionIntent(attemptDir, intent.stageTag);
  return { kind: 'committed', outcome };
}

/**
 * Recovery for design §9.5 row 4 ("提交区有文件，journal 里没有结果"): a
 * submission whose install intent survived a crash is re-validated from the
 * installed bytes and committed if its attempt is still the current one;
 * otherwise the uncommitted install is moved aside. The staging directory is
 * removed either way.
 */
export function settleExternalInstallIntent(
  runDir: string,
  dag: V3Dag,
  attemptId: string,
): V3InstallRecovery {
  if (!existsSync(submissionIntentPath(safeExternalAttemptDir(runDir, attemptId)))) return { kind: 'none' };
  return withJournalMutationSync(journalPathOf(runDir), ({ events, append }) =>
    settleInstallIntentLocked(runDir, dag, events, append, attemptId));
}

/** True when a crash-left install intent exists for the attempt. */
export function hasExternalInstallIntent(runDir: string, attemptId: string): boolean {
  return existsSync(submissionIntentPath(safeExternalAttemptDir(runDir, attemptId)));
}

/**
 * Ingest a structured submission for the CURRENT open attempt (design §7.2
 * step 4). The engine writes the files into a private staging directory,
 * generates `manifest.json` itself (bytes + sha256 computed here), runs the
 * normal manifest validation plus the node's `resultSchema` / `outputs`
 * contract, and only then — under the journal lock, re-checking that the
 * attempt is still current — records a durable install intent, installs
 * `work/` + `manifest.json` into the attempt directory and appends the
 * verdict. Contract problems are returned as `invalid` without touching the
 * journal: the node stays running and the bot may resubmit in the same turn.
 */
export async function ingestExternalSubmission(
  runDir: string,
  submission: V3ExternalSubmission,
  ctx?: V3ExternalEngineContext,
): Promise<V3ExternalSubmissionOutcome> {
  const journalPath = journalPathOf(runDir);
  const expect = callerExpectation(submission);
  // Cheap pre-check so a late/duplicate submission never stages files.
  const pre = classifyExternalAttempt(readJournal(journalPath), submission.attemptId, expect);
  if (!pre.ok) return { ok: false, reason: pre.reason };

  const dag = dagFor(runDir, ctx);
  const node = externalAttemptNode(dag, pre.attempt);
  if (!node || !isGoalNode(node)) return { ok: false, reason: 'unknown-attempt' };

  const planned = planSubmissionFiles(node, submission);
  if (!planned.ok) return { ok: false, reason: 'invalid', problems: planned.problems };

  const attemptDir = safeExternalAttemptDir(runDir, submission.attemptId);
  const stageTag = randomUUID();
  const stageDir = join(attemptDir, 'submissions', stageTag);
  try {
    let stagedManifestPath: string;
    try {
      stagedManifestPath = stageSubmission(stageDir, planned.files, submission.summary);
    } catch (err) {
      // Closed-attempt cleanup may remove `submissions/` under a late caller.
      const latest = classifyExternalAttempt(readJournal(journalPath), submission.attemptId, expect);
      if (!latest.ok) return { ok: false, reason: latest.reason };
      throw err;
    }
    const stagedWorkDir = join(stageDir, 'work');
    let manifest: Manifest;
    try {
      manifest = await readAndValidateManifest(stagedManifestPath, stagedWorkDir);
    } catch (err) {
      const problems = err instanceof ManifestValidationError ? err.problems : [String(err)];
      return { ok: false, reason: 'invalid', problems };
    }
    const verdict = judgeStagedSubmission(node, manifest, stagedWorkDir);
    if (verdict.kind === 'invalid') return { ok: false, reason: 'invalid', problems: verdict.problems };

    const manifestPath = join(attemptDir, 'manifest.json');
    return withJournalMutationSync(journalPath, ({ events, append }): V3ExternalSubmissionOutcome => {
      // A crash-left install for this attempt is settled first: if it
      // commits, this later submission is the duplicate.
      const recovered = settleInstallIntentLocked(runDir, dag, events, append, submission.attemptId);
      if (recovered.kind === 'committed') {
        return {
          ok: false,
          reason: recovered.outcome.kind === 'succeeded' ? 'already-succeeded'
            : recovered.outcome.kind === 'revisit' ? 'superseded'
            : 'closed',
        };
      }
      const current = classifyExternalAttempt(events, submission.attemptId, expect);
      if (!current.ok) return { ok: false, reason: current.reason };

      // Durable intent first: a crash after any rename below is recoverable.
      writeSubmissionIntent(attemptDir, { schemaVersion: 1, attemptId: submission.attemptId, stageTag });
      moveAsideIfPresent(join(attemptDir, 'work'), stageTag);
      renameSync(stagedWorkDir, join(attemptDir, 'work'));
      renameSync(stagedManifestPath, manifestPath);
      const outcome = appendInstalledVerdictLocked({
        runDir, dag, events, append, attempt: current.attempt, verdict, manifestPath,
      });
      removeSubmissionIntent(attemptDir, stageTag);
      return outcome;
    });
  } finally {
    // Losers and invalid submissions leave nothing behind. A crash-left
    // intent keeps its own staging dir until recovery settles it.
    if (!existsSync(submissionIntentPath(attemptDir))) {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }
}

export type V3ExternalStageOutcome =
  | { ok: true; kind: 'staged' }
  | { ok: false; reason: V3ExternalAttemptRejection }
  | { ok: false; reason: 'invalid'; problems: string[] }
  /** Another staged submission already waits for the run's owner. */
  | { ok: false; reason: 'pending' };

/**
 * Design §7.2 step 3 / §9.5 row 4 for a run whose owning daemon is offline:
 * validate a submission exactly like {@link ingestExternalSubmission}, then
 * leave it as a durable install intent in the attempt's staging area WITHOUT
 * touching the journal. The owner commits it on its next drive (cold attach
 * included) through the crash-recovery path ({@link settleExternalInstallIntent}),
 * which re-checks that the attempt is still current and re-validates the bytes;
 * until then no deadline can close the attempt over it. The journal lock is
 * held only to serialize with a concurrent install.
 */
export async function stageExternalSubmissionForInstall(
  runDir: string,
  submission: V3ExternalSubmission,
  ctx?: V3ExternalEngineContext,
): Promise<V3ExternalStageOutcome> {
  const journalPath = journalPathOf(runDir);
  const expect = callerExpectation(submission);
  const pre = classifyExternalAttempt(readJournal(journalPath), submission.attemptId, expect);
  if (!pre.ok) return { ok: false, reason: pre.reason };
  const dag = dagFor(runDir, ctx);
  const node = externalAttemptNode(dag, pre.attempt);
  if (!node || !isGoalNode(node)) return { ok: false, reason: 'unknown-attempt' };
  const planned = planSubmissionFiles(node, submission);
  if (!planned.ok) return { ok: false, reason: 'invalid', problems: planned.problems };

  const attemptDir = safeExternalAttemptDir(runDir, submission.attemptId);
  if (existsSync(submissionIntentPath(attemptDir))) return { ok: false, reason: 'pending' };
  const stageTag = randomUUID();
  const stageDir = join(attemptDir, 'submissions', stageTag);
  let staged = false;
  try {
    const stagedManifestPath = stageSubmission(stageDir, planned.files, submission.summary);
    let manifest: Manifest;
    try {
      manifest = await readAndValidateManifest(stagedManifestPath, join(stageDir, 'work'));
    } catch (err) {
      return { ok: false, reason: 'invalid', problems: err instanceof ManifestValidationError ? err.problems : [String(err)] };
    }
    const verdict = judgeStagedSubmission(node, manifest, join(stageDir, 'work'));
    if (verdict.kind === 'invalid') return { ok: false, reason: 'invalid', problems: verdict.problems };
    return withJournalMutationSync(journalPath, ({ events }): V3ExternalStageOutcome => {
      const current = classifyExternalAttempt(events, submission.attemptId, expect);
      if (!current.ok) return { ok: false, reason: current.reason };
      if (existsSync(submissionIntentPath(attemptDir))) return { ok: false, reason: 'pending' };
      writeSubmissionIntent(attemptDir, { schemaVersion: 1, attemptId: submission.attemptId, stageTag });
      staged = true;
      return { ok: true, kind: 'staged' };
    });
  } finally {
    if (!staged) rmSync(stageDir, { recursive: true, force: true });
  }
}

// ─── Reassignment ──────────────────────────────────────────────────────────

export type V3ReassignOutcome =
  | {
      kind: 'reassigned';
      nodeId: string;
      from: string;
      to: string;
      /** The open attempt this reassignment closed. */
      closedAttemptId?: string;
      /** A blocked node is retried onto the new bot in the same step. */
      nextAttemptId?: string;
      stopError?: unknown;
    }
  | {
      kind: 'rejected';
      reason:
        | 'missing'
        | 'run-not-running'
        | 'unknown-node'
        | 'not-in-bot-set'
        | 'same-bot'
        | 'not-reassignable'
        | 'stale-attempt'
        | 'revise-workflow-required'
        | 'not-bot-run';
    };

/** A caller holding the validated `run.json` passes its pinned executor;
 *  otherwise the runtime's `runStarted.nodeExecutor` stamp (written from that
 *  same validated envelope) decides. Kept free of the envelope parser so the
 *  host-neutral runtime graph carries no third-party schema library. */
function isBotExecutedRun(events: readonly StoredEvent[], pinned: V3ReassignContext['nodeExecutor']): boolean {
  if (pinned !== undefined) return pinned === 'bot';
  return events.some((event) => event.type === 'runStarted' && event.nodeExecutor === 'bot');
}

export interface V3ReassignContext extends V3ExternalEngineContext {
  /** Frozen selector → snapshot (the run's bot set). Defaults to
   *  `<runDir>/bots.snapshot.json`. */
  botSnapshots?: ReadonlyMap<string, BotSnapshot>;
  /** Stops the current attempt's bot turn, when one is open. */
  executor?: V3ExternalNodeExecutor;
  /** The executor pinned by the caller's validated `run.json` (`null` = the
   *  envelope has none). Omitted: the journal's `runStarted` stamp decides. */
  nodeExecutor?: 'bot' | null;
}

function botSnapshotsFor(runDir: string, ctx: V3ReassignContext): ReadonlyMap<string, BotSnapshot> {
  if (ctx.botSnapshots) return ctx.botSnapshots;
  const raw = JSON.parse(readFileSync(join(runDir, 'bots.snapshot.json'), 'utf-8')) as Record<string, BotSnapshot>;
  return new Map(Object.entries(raw));
}

/** Which node-scoped definition a reassign targets: an authored goal node, or
 *  a loop-body expansion already present in the journal. */
function reassignTargetSelector(
  dag: V3Dag,
  events: readonly StoredEvent[],
  nodeId: string,
): string | undefined {
  const authored = dag.nodes.find((node) => node.id === nodeId);
  if (authored) return isGoalNode(authored) ? authored.bot ?? '' : undefined;
  for (const event of events) {
    if (event.type !== 'nodeDispatched' || event.nodeId !== nodeId || !event.loop) continue;
    const body = externalAttemptNode(dag, { nodeId, loop: event.loop });
    return body && isGoalNode(body) ? body.bot ?? '' : undefined;
  }
  return undefined;
}

type ReassignPlan =
  | { kind: 'open'; attempt: V3ExternalAttempt }
  | { kind: 'idle' }
  | { kind: 'blocked'; previousAttemptId: string; nextAttemptId: string; errorClass?: V3ErrorClass; errorCode?: string; reviseRequired: boolean }
  | { kind: 'rejected'; reason: Extract<V3ReassignOutcome, { kind: 'rejected' }>['reason'] };

function planReassign(events: readonly StoredEvent[], nodeId: string, expectedAttemptId?: string): ReassignPlan {
  const snap = materialize([...events]);
  if (snap.runStatus !== 'running' && snap.runStatus !== 'blocked') return { kind: 'rejected', reason: 'run-not-running' };
  const nodeState = snap.nodes.get(nodeId);
  const status = nodeState?.status ?? 'pending';
  const key = nodeState?.effectiveInstanceId ?? nodeId;
  if (status === 'running') {
    const attemptId = snap.attempts.get(key);
    const attempt = attemptId ? foldV3ExternalAttempts(events).get(attemptId) : undefined;
    if (!attempt || attempt.closed) return { kind: 'rejected', reason: 'not-reassignable' };
    if (expectedAttemptId !== undefined && expectedAttemptId !== attempt.attemptId) {
      return { kind: 'rejected', reason: 'stale-attempt' };
    }
    return { kind: 'open', attempt };
  }
  if (status === 'pending' || status === 'gateWaiting') {
    if (expectedAttemptId !== undefined && expectedAttemptId !== snap.attempts.get(key)) {
      return { kind: 'rejected', reason: 'stale-attempt' };
    }
    return { kind: 'idle' };
  }
  if (status === 'blocked') {
    const previousAttemptId = latestAttemptIdFor([...events], key);
    if (!previousAttemptId) return { kind: 'rejected', reason: 'not-reassignable' };
    if (expectedAttemptId !== undefined && expectedAttemptId !== previousAttemptId) {
      return { kind: 'rejected', reason: 'stale-attempt' };
    }
    const blocked = [...events].reverse().find(
      (event): event is StoredEvent & { type: 'nodeBlocked' } =>
        event.type === 'nodeBlocked' && event.attemptId === previousAttemptId,
    );
    return {
      kind: 'blocked',
      previousAttemptId,
      nextAttemptId: nextAttemptIdFor([...events], key),
      ...(blocked?.errorClass ? { errorClass: blocked.errorClass } : {}),
      ...(blocked?.errorCode ? { errorCode: blocked.errorCode } : {}),
      reviseRequired: blocked?.recovery === 'reviseWorkflow',
    };
  }
  return { kind: 'rejected', reason: 'not-reassignable' };
}

/**
 * Reassign a node to another bot of the run's bot set (design §9.2). The next
 * attempt targets `toLarkAppId`; an open attempt is stopped and closed by the
 * `nodeReassigned` event itself (late submissions for it are rejected); a
 * blocked node is retried onto the new bot (new attempt, same instance).
 * Eligibility beyond bot-set membership is enforced by later callers.
 */
export async function reassignNode(
  runDir: string,
  input: {
    nodeId: string;
    toLarkAppId: string;
    by: string;
    expectedAttemptId?: string;
    /** Only move a blocked node (a blocked-card click must never retarget a
     *  running or pending one). The locked re-plan below must then find the
     *  same blocked state, so this holds under the journal lock too. */
    requireBlocked?: boolean;
  },
  ctx: V3ReassignContext = {},
): Promise<V3ReassignOutcome> {
  const journalPath = journalPathOf(runDir);
  if (!existsSync(journalPath)) return { kind: 'rejected', reason: 'missing' };
  // Only bot-executed runs read assignments; elsewhere a reassignment would
  // be recorded while the original worker keeps running.
  if (!isBotExecutedRun(readJournal(journalPath), ctx.nodeExecutor)) return { kind: 'rejected', reason: 'not-bot-run' };
  const dag = dagFor(runDir, ctx);
  const snapshots = botSnapshotsFor(runDir, ctx);
  const botSet = new Set([...snapshots.values()].map((snapshot) => snapshot.larkAppId));
  if (!botSet.has(input.toLarkAppId)) return { kind: 'rejected', reason: 'not-in-bot-set' };

  const before = readJournal(journalPath);
  const selector = reassignTargetSelector(dag, before, input.nodeId);
  if (selector === undefined) return { kind: 'rejected', reason: 'unknown-node' };
  const frozenTarget = snapshots.get(selector)?.larkAppId;
  if (!frozenTarget) return { kind: 'rejected', reason: 'unknown-node' };

  const currentTarget = materialize(before).assignments.get(input.nodeId) ?? frozenTarget;
  if (currentTarget === input.toLarkAppId) return { kind: 'rejected', reason: 'same-bot' };
  const plan = planReassign(before, input.nodeId, input.expectedAttemptId);
  if (plan.kind === 'rejected') return plan;
  if (input.requireBlocked && plan.kind !== 'blocked') return { kind: 'rejected', reason: 'not-reassignable' };
  if (plan.kind === 'blocked' && plan.reviseRequired) {
    return { kind: 'rejected', reason: 'revise-workflow-required' };
  }

  // Stop first (idempotent), then close under the lock: a submission that
  // lands in between wins and the reassignment is reported stale.
  let stopError: unknown;
  if (plan.kind === 'open') {
    const runId = basename(runDir);
    const stopped = await stopExternalAttempt(ctx.executor, runId, plan.attempt, 'reassigned');
    if (!stopped.ok) stopError = stopped.error;
  }

  return withJournalMutationSync(journalPath, ({ events, append }): V3ReassignOutcome => {
    const snap = materialize([...events]);
    const from = snap.assignments.get(input.nodeId) ?? frozenTarget;
    if (from === input.toLarkAppId) return { kind: 'rejected', reason: 'same-bot' };
    const locked = planReassign(events, input.nodeId, input.expectedAttemptId);
    if (locked.kind === 'rejected') return locked;
    if (locked.kind !== plan.kind) return { kind: 'rejected', reason: 'stale-attempt' };
    if (locked.kind === 'open' && plan.kind === 'open' && locked.attempt.attemptId !== plan.attempt.attemptId) {
      return { kind: 'rejected', reason: 'stale-attempt' };
    }
    if (locked.kind === 'blocked' && locked.reviseRequired) {
      return { kind: 'rejected', reason: 'revise-workflow-required' };
    }
    const nodeState = snap.nodes.get(input.nodeId);
    const instanceId = nodeState?.effectiveInstanceId;
    append({
      type: 'nodeReassigned',
      nodeId: input.nodeId,
      ...(instanceId ? { instanceId } : {}),
      ...(locked.kind === 'open' ? { attemptId: locked.attempt.attemptId } : {}),
      from,
      to: input.toLarkAppId,
      by: input.by,
    }, { durable: true });
    if (locked.kind === 'blocked') {
      append({
        type: 'nodeRetryRequested',
        nodeId: input.nodeId,
        ...(instanceId ? { instanceId } : {}),
        previousAttemptId: locked.previousAttemptId,
        nextAttemptId: locked.nextAttemptId,
        reason: 'blockedRetry',
        ...(locked.errorClass ? { previousErrorClass: locked.errorClass } : {}),
        ...(locked.errorCode ? { previousErrorCode: locked.errorCode } : {}),
      }, { durable: true });
    }
    return {
      kind: 'reassigned',
      nodeId: input.nodeId,
      from,
      to: input.toLarkAppId,
      ...(locked.kind === 'open' ? { closedAttemptId: locked.attempt.attemptId } : {}),
      ...(locked.kind === 'blocked' ? { nextAttemptId: locked.nextAttemptId } : {}),
      ...(stopError !== undefined ? { stopError } : {}),
    };
  });
}
