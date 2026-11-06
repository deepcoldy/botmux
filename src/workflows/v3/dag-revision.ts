/**
 * Runtime flow revisions (design §13): `dag.json` stays revision 1 — the
 * digest-locked DAG `run.json` authorized — and every later change is a full
 * DAG file under `dag-revisions/<NNN>.json` plus the patch that produced it.
 * The journal decides which revisions are in effect:
 *
 *   dagRevised          — a revision took effect (direct, or an approved
 *                         proposal); carries the file digests and the state
 *                         effects on already-dispatched work
 *   dagRevisionProposed — a revision waiting for the initiator's confirmation
 *   dagRevisionApproved / dagRevisionRejected — the confirmation outcome
 *
 * This module is the daemon-free half: patch parsing, the pure revision fold,
 * verified loading of the effective DAG, and the pure planner that applies a
 * patch to the current DAG under the §13.4 node-state rules and classifies it
 * against the §13.5 confirmation list. Writing revision files, the turn
 * classification (M1) and the confirmation card live with the daemon.
 *
 * A run that never revised has no `dagRevised` event, so every helper here
 * returns the authorized DAG untouched and reads no extra file.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  DagValidationError,
  DEFAULT_NODE_TIMEOUT_SEC,
  isHostNode,
  isLoopNode,
  loopInstanceId,
  V3_DAG_SEGMENT_RE,
  validateDag,
  type V3Dag,
  type V3Node,
} from './dag.js';
import type {
  StoredEvent,
  V3AutoProvenance,
  V3Event,
  V3RevisionConfirmReason,
  V3RevisionEffects,
} from './event-contract.js';
import type { BotSnapshot } from './contract.js';
import type { Manifest } from './artifact-contract.js';
import { normalizeGateWaitInput } from './gate-policy.js';
import { matchLoopExitWhen, revisitBudgetStatus } from './core-control.js';
import { latestAttemptIdFor, nextAttemptIdFor } from './attempt-numbering.js';
import { materialize } from './state.js';
import { withJournalMutationSync } from './journal.js';
import { affectedNodesFrom } from './revisit-plan.js';
import { v3NodePlacement, v3PlacementProblems } from './placement.js';
import type { V3RunSnapshot } from './state.js';

// ─── Files ────────────────────────────────────────────────────────────────

export const V3_DAG_REVISIONS_DIR = 'dag-revisions';

export interface V3RevisionFilePaths {
  dag: string;
  patch: string;
  bots: string;
}

export function v3RevisionStem(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 2) {
    throw new Error(`v3 revision: invalid revision number ${revision}`);
  }
  return String(revision).padStart(3, '0');
}

export function v3RevisionFilePaths(runDir: string, revision: number): V3RevisionFilePaths {
  const stem = v3RevisionStem(revision);
  const dir = join(runDir, V3_DAG_REVISIONS_DIR);
  return {
    dag: join(dir, `${stem}.json`),
    patch: join(dir, `${stem}.patch.json`),
    bots: join(dir, `${stem}.bots.json`),
  };
}

/** `sha256:<hex>` of exact bytes — the same digest form as run.json pins. */
export function v3RevisionDigest(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export class V3RevisionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V3RevisionIntegrityError';
  }
}

function readPinnedFile(path: string, expected: string, label: string): Buffer {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new V3RevisionIntegrityError(`${label} is missing (${path})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new V3RevisionIntegrityError(`${label} must be a regular file (${path})`);
  }
  const dirStat = lstatSync(dirname(path));
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new V3RevisionIntegrityError(`${label} directory must be a real directory`);
  }
  const bytes = readFileSync(path);
  const actual = v3RevisionDigest(bytes);
  if (actual !== expected) {
    throw new V3RevisionIntegrityError(`${label} digest mismatch (journal ${expected}, file ${actual})`);
  }
  return bytes;
}

// ─── Patch format (design §13.2) ──────────────────────────────────────────

export type V3DagPatchOp =
  | { op: 'addNode'; node: Record<string, unknown> }
  | { op: 'removeNode'; nodeId: string }
  | { op: 'updateNode'; nodeId: string; set: Record<string, unknown> }
  | {
      op: 'setDepends';
      nodeId: string;
      depends: unknown[];
      inputs?: unknown[];
      /** `null` restores the default (all_success). */
      triggerRule?: unknown;
    }
  | { op: 'reassign'; nodeId: string; bot: string }
  | { op: 'rerunNode'; nodeId: string };

export interface V3DagPatch {
  ops: V3DagPatchOp[];
  /** Free-text note shown next to the generated summary. */
  note?: string;
}

export const V3_DAG_PATCH_MAX_OPS = 64;
export const V3_DAG_PATCH_NOTE_MAX = 200;

/** Fields `updateNode.set` may touch. Identity (`id`/`type`), wiring
 *  (`depends`/`inputs`/`triggerRule` → setDepends) and the executing bot
 *  (`bot` → reassign) have dedicated ops so their state rules stay explicit.
 *  `null` deletes an optional field. */
export const V3_UPDATE_NODE_FIELDS = [
  'goal',
  'outputs',
  'resultSchema',
  'timeoutSec',
  'humanGate',
  'override',
  'revisitTo',
  'checkpoint',
  'placement',
  'input',
  'maxIterations',
  'body',
  'exit',
  'feedback',
  'output',
] as const;

const UPDATE_FIELDS = new Set<string>(V3_UPDATE_NODE_FIELDS);
/** On a loop that already started only its budget may change (§13.4). */
const STARTED_LOOP_FIELDS = new Set<string>(['maxIterations']);

export class V3DagPatchError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid workflow patch:\n  - ${problems.join('\n  - ')}`);
    this.name = 'V3DagPatchError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/** Strictly parse an untrusted patch. Accepts `{ ops, note? }` or a bare op
 *  array. Throws `V3DagPatchError` listing every problem. */
export function parseV3DagPatch(raw: unknown): V3DagPatch {
  const problems: string[] = [];
  const container = Array.isArray(raw) ? { ops: raw } : raw;
  if (!isPlainObject(container)) throw new V3DagPatchError(['patch must be an object { ops: [...] } or an op array']);
  for (const key of onlyKeys(container, ['ops', 'note'])) problems.push(`unknown patch key "${key}"`);
  let note: string | undefined;
  if (container.note !== undefined) {
    if (typeof container.note !== 'string' || container.note.trim().length === 0) {
      problems.push('note must be a non-empty string');
    } else if (container.note.trim().length > V3_DAG_PATCH_NOTE_MAX) {
      problems.push(`note must be at most ${V3_DAG_PATCH_NOTE_MAX} characters`);
    } else {
      note = container.note.trim();
    }
  }
  if (!Array.isArray(container.ops) || container.ops.length === 0) {
    throw new V3DagPatchError([...problems, 'ops must be a non-empty array']);
  }
  if (container.ops.length > V3_DAG_PATCH_MAX_OPS) {
    throw new V3DagPatchError([...problems, `at most ${V3_DAG_PATCH_MAX_OPS} ops per edit`]);
  }
  const ops: V3DagPatchOp[] = [];
  container.ops.forEach((candidate, index) => {
    const where = `ops[${index}]`;
    if (!isPlainObject(candidate)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const nodeIdOk = (): boolean => {
      if (typeof candidate.nodeId !== 'string' || !V3_DAG_SEGMENT_RE.test(candidate.nodeId)) {
        problems.push(`${where}.nodeId must be a node id`);
        return false;
      }
      return true;
    };
    const extra = (allowed: string[]): boolean => {
      const unknown = onlyKeys(candidate, allowed);
      for (const key of unknown) problems.push(`${where} (${String(candidate.op)}) has unknown key "${key}"`);
      return unknown.length === 0;
    };
    switch (candidate.op) {
      case 'addNode':
        if (!extra(['op', 'node'])) return;
        if (!isPlainObject(candidate.node)) {
          problems.push(`${where}.node must be an object`);
          return;
        }
        ops.push({ op: 'addNode', node: candidate.node });
        return;
      case 'removeNode':
      case 'rerunNode':
        if (!extra(['op', 'nodeId']) || !nodeIdOk()) return;
        ops.push({ op: candidate.op, nodeId: candidate.nodeId as string });
        return;
      case 'updateNode': {
        if (!extra(['op', 'nodeId', 'set']) || !nodeIdOk()) return;
        if (!isPlainObject(candidate.set) || Object.keys(candidate.set).length === 0) {
          problems.push(`${where}.set must be a non-empty object`);
          return;
        }
        const bad = Object.keys(candidate.set).filter((key) => !UPDATE_FIELDS.has(key));
        if (bad.length > 0) {
          problems.push(
            `${where}.set cannot change ${bad.join(', ')} ` +
            '(use setDepends for depends/inputs/triggerRule, reassign for bot; id/type are fixed)',
          );
          return;
        }
        ops.push({ op: 'updateNode', nodeId: candidate.nodeId as string, set: candidate.set });
        return;
      }
      case 'setDepends':
        if (!extra(['op', 'nodeId', 'depends', 'inputs', 'triggerRule']) || !nodeIdOk()) return;
        if (!Array.isArray(candidate.depends)) {
          problems.push(`${where}.depends must be an array`);
          return;
        }
        if (candidate.inputs !== undefined && !Array.isArray(candidate.inputs)) {
          problems.push(`${where}.inputs must be an array`);
          return;
        }
        ops.push({
          op: 'setDepends',
          nodeId: candidate.nodeId as string,
          depends: candidate.depends,
          ...(candidate.inputs !== undefined ? { inputs: candidate.inputs as unknown[] } : {}),
          ...(candidate.triggerRule !== undefined ? { triggerRule: candidate.triggerRule } : {}),
        });
        return;
      case 'reassign':
        if (!extra(['op', 'nodeId', 'bot']) || !nodeIdOk()) return;
        if (typeof candidate.bot !== 'string' || candidate.bot.trim().length === 0) {
          problems.push(`${where}.bot must be a non-empty bot selector or larkAppId`);
          return;
        }
        ops.push({ op: 'reassign', nodeId: candidate.nodeId as string, bot: candidate.bot.trim() });
        return;
      default:
        problems.push(
          `${where}.op must be one of addNode | removeNode | updateNode | setDepends | reassign | rerunNode ` +
          `(got ${JSON.stringify(candidate.op)})`,
        );
    }
  });
  if (problems.length > 0) throw new V3DagPatchError(problems);
  return { ops, ...(note ? { note } : {}) };
}

// ─── Revision history (pure fold) ─────────────────────────────────────────

export type V3RevisionState = 'applied' | 'pending' | 'rejected';

export interface V3RevisionRecord {
  revision: number;
  baseRevision: number;
  sha256: string;
  patchSha256: string;
  botsSha256?: string;
  summary: string;
  note?: string;
  /** Who made the change (proposer, for confirmed proposals). */
  by: string;
  /** Reason the main bot gave for an automatic change (`by: 'main_bot'`). */
  auto?: { reason: string };
  state: V3RevisionState;
  /** Journal time the revision was first recorded. */
  ts: number;
  /** Journal time it took effect (applied only). */
  appliedAt?: number;
  reasons?: V3RevisionConfirmReason[];
  touched?: string[];
  approvedBy?: string;
  rejected?: { by: string; reason: Extract<V3Event, { type: 'dagRevisionRejected' }>['reason']; detail?: string };
  effects?: V3RevisionEffects;
  /** The proposal this one was carried from (see `dagRevisionProposed`). */
  carriedFrom?: number;
}

export interface V3RevisionHistory {
  /** Effective revision number (1 = the authorized `dag.json`). */
  current: number;
  /** Every recorded revision, in the order it first appeared. */
  records: V3RevisionRecord[];
  /** Applied revisions in journal (= application) order. */
  applied: V3RevisionRecord[];
  /** The single proposal awaiting confirmation, if any. */
  pending?: V3RevisionRecord;
  /** Highest revision number ever allocated (≥ 1). */
  maxRevision: number;
}

/**
 * Fold the revision events. Pure and deterministic. The chain is checked as
 * it is folded: every applied revision must be based on the revision in
 * effect at that point of the journal, numbers are never reused, and an
 * approval must match the exact proposal bytes — anything else is journal
 * corruption and throws (callers fail closed).
 *
 * A proposal whose base is no longer current is reported as rejected/stale
 * even when the writer crashed before journaling that verdict.
 */
export function foldV3Revisions(events: readonly StoredEvent[]): V3RevisionHistory {
  let current = 1;
  let maxRevision = 1;
  const records: V3RevisionRecord[] = [];
  const byRevision = new Map<number, V3RevisionRecord>();
  const applied: V3RevisionRecord[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'dagRevisionProposed': {
        if (byRevision.has(event.revision) || event.revision <= maxRevision) {
          throw new V3RevisionIntegrityError(`revision ${event.revision} was allocated twice`);
        }
        for (const prior of records) {
          if (prior.state !== 'pending') continue;
          prior.state = 'rejected';
          prior.rejected = { by: 'system', reason: 'superseded' };
        }
        const record: V3RevisionRecord = {
          revision: event.revision,
          baseRevision: event.baseRevision,
          sha256: event.sha256,
          patchSha256: event.patchSha256,
          ...(event.botsSha256 ? { botsSha256: event.botsSha256 } : {}),
          summary: event.summary,
          ...(event.note ? { note: event.note } : {}),
          by: event.by,
          ...(event.auto ? { auto: event.auto } : {}),
          state: 'pending',
          ts: event.ts,
          reasons: [...event.reasons],
          touched: [...event.touched],
          ...(event.carriedFrom !== undefined ? { carriedFrom: event.carriedFrom } : {}),
        };
        records.push(record);
        byRevision.set(event.revision, record);
        maxRevision = event.revision;
        break;
      }
      case 'dagRevised': {
        if (event.baseRevision !== current) {
          throw new V3RevisionIntegrityError(
            `revision ${event.revision} is based on ${event.baseRevision} but ${current} was in effect`,
          );
        }
        let record = byRevision.get(event.revision);
        if (event.approval) {
          if (
            !record ||
            record.state !== 'pending' ||
            record.sha256 !== event.sha256 ||
            record.patchSha256 !== event.patchSha256 ||
            record.botsSha256 !== event.botsSha256 ||
            record.baseRevision !== event.baseRevision
          ) {
            throw new V3RevisionIntegrityError(
              `approved revision ${event.revision} does not match a pending proposal`,
            );
          }
          record.approvedBy = event.approval.by;
        } else {
          if (record || event.revision <= maxRevision) {
            throw new V3RevisionIntegrityError(`revision ${event.revision} was allocated twice`);
          }
          record = {
            revision: event.revision,
            baseRevision: event.baseRevision,
            sha256: event.sha256,
            patchSha256: event.patchSha256,
            ...(event.botsSha256 ? { botsSha256: event.botsSha256 } : {}),
            summary: event.summary,
            ...(event.note ? { note: event.note } : {}),
            by: event.by,
            ...(event.auto ? { auto: event.auto } : {}),
            state: 'pending',
            ts: event.ts,
          };
          records.push(record);
          byRevision.set(event.revision, record);
          maxRevision = event.revision;
        }
        record.state = 'applied';
        record.appliedAt = event.ts;
        if (event.effects) record.effects = event.effects;
        applied.push(record);
        current = event.revision;
        break;
      }
      case 'dagRevisionApproved': {
        const record = byRevision.get(event.revision);
        if (record && !record.approvedBy) record.approvedBy = event.by;
        break;
      }
      case 'dagRevisionRejected': {
        const record = byRevision.get(event.revision);
        if (record?.state === 'pending') {
          record.state = 'rejected';
          record.rejected = {
            by: event.by,
            reason: event.reason,
            ...(event.detail ? { detail: event.detail } : {}),
          };
        }
        break;
      }
      default:
        break;
    }
  }
  let pending: V3RevisionRecord | undefined;
  for (const record of records) {
    if (record.state !== 'pending') continue;
    if (record.baseRevision !== current) {
      record.state = 'rejected';
      record.rejected = { by: 'system', reason: 'stale' };
      continue;
    }
    pending = record;
  }
  return { current, records, applied, ...(pending ? { pending } : {}), maxRevision };
}

/** Cheap check used inside journal critical sections. */
export function currentV3Revision(events: readonly StoredEvent[]): number {
  let current = 1;
  for (const event of events) if (event.type === 'dagRevised') current = event.revision;
  return current;
}

// ─── Effective DAG (verified IO) ──────────────────────────────────────────

export interface V3EffectiveDag {
  dag: V3Dag;
  revision: number;
  history: V3RevisionHistory;
  /** Bot snapshots brought in by applied revisions (selector → snapshot). */
  botAdditions: Map<string, BotSnapshot>;
}

function parseRevisionDag(bytes: Buffer, base: V3Dag, label: string): V3Dag {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf-8')) as unknown;
  } catch (err) {
    throw new V3RevisionIntegrityError(`${label} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  let dag: V3Dag;
  try {
    dag = validateDag(raw);
  } catch (err) {
    throw new V3RevisionIntegrityError(
      `${label} failed validation: ${err instanceof DagValidationError ? err.problems.join('; ') : String(err)}`,
    );
  }
  if (dag.runId !== base.runId) throw new V3RevisionIntegrityError(`${label} belongs to run ${dag.runId}`);
  if ((dag.schemaVersion ?? 1) !== (base.schemaVersion ?? 1)) {
    throw new V3RevisionIntegrityError(`${label} changed the DAG schemaVersion`);
  }
  return dag;
}

/** Shape-check a revision bot sidecar (selector → snapshot). Execution
 *  support is validated by the runtime with the same check as frozen ones. */
export function parseRevisionBotSnapshots(raw: unknown, label = 'revision bot snapshots'): Map<string, BotSnapshot> {
  if (!isPlainObject(raw)) throw new V3RevisionIntegrityError(`${label} must be an object`);
  const out = new Map<string, BotSnapshot>();
  for (const [selector, value] of Object.entries(raw)) {
    if (!isPlainObject(value) || typeof value.larkAppId !== 'string' || value.larkAppId.length === 0 ||
      typeof value.cliId !== 'string' || typeof value.workingDir !== 'string') {
      throw new V3RevisionIntegrityError(`${label}[${JSON.stringify(selector)}] is not a bot snapshot`);
    }
    out.set(selector, value as unknown as BotSnapshot);
  }
  return out;
}

/** Read one revision's files, verifying every digest the journal pinned. */
export function readVerifiedV3Revision(
  runDir: string,
  record: Pick<V3RevisionRecord, 'revision' | 'sha256' | 'patchSha256' | 'botsSha256'>,
  base: V3Dag,
): { dag: V3Dag; bots: Map<string, BotSnapshot> } {
  const paths = v3RevisionFilePaths(runDir, record.revision);
  const label = `dag-revisions/${v3RevisionStem(record.revision)}`;
  const dag = parseRevisionDag(readPinnedFile(paths.dag, record.sha256, `${label}.json`), base, `${label}.json`);
  // The patch is the audit record of what changed and who asked: it is
  // pinned like the DAG, so a rewritten `.patch.json` fails closed too.
  readPinnedFile(paths.patch, record.patchSha256, `${label}.patch.json`);
  let bots = new Map<string, BotSnapshot>();
  if (record.botsSha256) {
    const bytes = readPinnedFile(paths.bots, record.botsSha256, `${label}.bots.json`);
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf-8')) as unknown;
    } catch {
      throw new V3RevisionIntegrityError(`${label}.bots.json is not JSON`);
    }
    bots = parseRevisionBotSnapshots(raw, `${label}.bots.json`);
  }
  return { dag, bots };
}

/**
 * The DAG `decideNext` must schedule against: revision 1 plus every applied
 * revision in journal order. Every applied revision's files are verified
 * against the digests in its event (fail closed). Without revisions this is
 * `base` itself and no file is read.
 */
export function loadEffectiveV3Dag(
  runDir: string,
  base: V3Dag,
  events: readonly StoredEvent[],
): V3EffectiveDag {
  const history = foldV3Revisions(events);
  const botAdditions = new Map<string, BotSnapshot>();
  if (history.applied.length === 0) return { dag: base, revision: 1, history, botAdditions };
  let dag = base;
  for (const record of history.applied) {
    const verified = readVerifiedV3Revision(runDir, record, base);
    dag = verified.dag;
    for (const [selector, snapshot] of verified.bots) botAdditions.set(selector, snapshot);
  }
  return { dag, revision: history.current, history, botAdditions };
}

/** Effective DAG for read paths that should degrade rather than throw. */
export function tryLoadEffectiveV3Dag(
  runDir: string,
  base: V3Dag,
  events: readonly StoredEvent[],
): V3EffectiveDag | undefined {
  try {
    return loadEffectiveV3Dag(runDir, base, events);
  } catch {
    return undefined;
  }
}

/** Snapshot lookup for a node's bot selector: exact selector first, then a
 *  snapshot whose larkAppId equals the selector (revisions normalize to the
 *  selector key, but saved/legacy DAGs may carry app ids). */
/** The app id that executes `nodeId` now: the latest reassignment (the
 *  blocked-card 改派 or an applied revision's reassign), else the bot its
 *  definition names. `undefined` when neither resolves. */
export function v3CurrentExecutorApp(
  snap: Pick<V3RunSnapshot, 'assignments'>,
  bots: ReadonlyMap<string, BotSnapshot>,
  nodeId: string,
  definedSelector: string | undefined,
): string | undefined {
  return snap.assignments.get(nodeId) ?? snapshotForSelector(bots, definedSelector)?.larkAppId;
}

export function snapshotForSelector(
  snapshots: ReadonlyMap<string, BotSnapshot>,
  selector: string | undefined,
): BotSnapshot | undefined {
  const key = selector ?? '';
  const exact = snapshots.get(key);
  if (exact) return exact;
  if (!key) return undefined;
  for (const snapshot of snapshots.values()) if (snapshot.larkAppId === key) return snapshot;
  return undefined;
}

// ─── Done-node products (for wiring checks at apply time) ─────────────────

export interface V3DoneNodeProducts {
  manifest: Manifest;
  manifestPath: string;
  attemptId: string;
  instanceId?: string;
  /** Parsed `result.json`, when the manifest lists one and it parses. */
  result?: Record<string, unknown>;
}

/** The validated products of a done node's CURRENT instance, read from the
 *  manifest its `nodeSucceeded` recorded. Undefined when unreadable. */
export function readV3DoneNodeProducts(
  events: readonly StoredEvent[],
  snap: V3RunSnapshot,
  nodeId: string,
): V3DoneNodeProducts | undefined {
  const key = snap.nodes.get(nodeId)?.effectiveInstanceId ?? nodeId;
  let success: Extract<StoredEvent, { type: 'nodeSucceeded' }> | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'nodeSucceeded' && (event.instanceId ?? event.nodeId) === key) {
      success = event;
      break;
    }
  }
  if (!success) return undefined;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(success.manifestPath, 'utf-8')) as Manifest;
  } catch {
    return undefined;
  }
  if (!manifest || !Array.isArray(manifest.files)) return undefined;
  let result: Record<string, unknown> | undefined;
  const entry = manifest.files.find((file) => file.path === 'result.json');
  if (entry) {
    const resultPath = join(dirname(success.manifestPath), 'work', entry.path);
    if (existsSync(resultPath)) {
      try {
        const parsed = JSON.parse(readFileSync(resultPath, 'utf-8')) as unknown;
        if (isPlainObject(parsed)) result = parsed;
      } catch {
        // An unreadable result simply cannot activate a predicate.
      }
    }
  }
  return {
    manifest,
    manifestPath: success.manifestPath,
    attemptId: success.attemptId,
    ...(success.instanceId ? { instanceId: success.instanceId } : {}),
    ...(result ? { result } : {}),
  };
}

// ─── Planner (pure apart from the injected product reader) ────────────────

export type V3NodeLifecycle =
  | 'notStarted'
  | 'pendingInstance'
  | 'gateWaiting'
  | 'running'
  | 'blocked'
  | 'loopRunning'
  | 'done'
  | 'closed';

export function v3NodeLifecycle(snap: V3RunSnapshot, node: V3Node): V3NodeLifecycle {
  const state = snap.nodes.get(node.id);
  const status = state?.status ?? 'pending';
  if (isLoopNode(node) && snap.loops.has(node.id)) {
    if (status === 'done') return 'done';
    if (status === 'running' || status === 'blocked') return 'loopRunning';
  }
  switch (status) {
    case 'pending':
      return state?.effectiveInstanceId ? 'pendingInstance' : 'notStarted';
    case 'gateWaiting':
      return 'gateWaiting';
    case 'running':
      return 'running';
    case 'blocked':
      return 'blocked';
    case 'done':
      return 'done';
    default:
      return 'closed';
  }
}

export interface V3RevisionChanges {
  added: string[];
  removed: string[];
  /** Existing nodes whose definition changed (excluding pure rewiring). */
  changed: string[];
  dependsChanged: string[];
  reassigned: Array<{ nodeId: string; from?: string; to: string }>;
  rerun: string[];
  /** Bot selectors not yet in the run's approved bot set. */
  newBots: string[];
  /** Host (external side-effect) nodes added or changed. */
  hostNodes: string[];
  gateChanges: Array<{ nodeId: string; change: 'added' | 'removed' | 'changed' }>;
}

export interface V3RevisionPlan {
  dag: V3Dag;
  summary: string;
  changes: V3RevisionChanges;
  /** Empty = may take effect directly (for an M1-qualified turn). */
  reasons: V3RevisionConfirmReason[];
  /** Existing nodes held back from dispatch while a proposal is pending. */
  touched: string[];
  effects: V3RevisionEffects;
  /** Conditional edges from already-done sources, resolved once now. */
  edges: Array<Extract<V3Event, { type: 'edgeResolved' }>>;
  /** Rerun budget this revision lifts by itself (only when the planner was
   *  allowed to — the initiator's own edit, M2 乙): one more revisit per
   *  entry, as many as its re-runs need. Also in `effects.budgetGrants`, so
   *  the lift is journaled in the same line as the revision. */
  budgetGrants: Array<{ nodeId: string; tier: 'pair' | 'run' }>;
  /** Blocked nodes to re-run: journaled as `nodeRetryRequested` right after
   *  the revision (attempt ids are allocated under the journal lock). */
  retries: Array<{
    nodeId: string;
    instanceId?: string;
    previousErrorClass?: Extract<V3Event, { type: 'nodeBlocked' }>['errorClass'];
    previousErrorCode?: string;
  }>;
}

export interface PlanV3DagRevisionInput {
  /** Current effective DAG. */
  dag: V3Dag;
  /** The authorized revision 1 (baselines for §13.5 budget checks). */
  approvedDag: V3Dag;
  events: readonly StoredEvent[];
  snap: V3RunSnapshot;
  patch: V3DagPatch;
  /** Every bot snapshot already approved for this run (frozen + revisions). */
  knownBots: ReadonlyMap<string, BotSnapshot>;
  /** A `rerunNode` whose revisit budget is spent adds one more instead of
   *  being refused (`plan.budgetGrants`). Set only for the initiator's own
   *  turn, whose edits take effect without a confirmation card (M2 乙). */
  liftSpentRerunBudget?: boolean;
  /** Injected for tests; defaults to reading the done node's manifest. */
  readProducts?: (nodeId: string) => V3DoneNodeProducts | undefined;
}

/** A rerun refused because the revisit budget is spent: the initiator can
 *  grant one more through the 「追加重做额度」card. */
export interface V3RerunBudgetBlock {
  nodeId: string;
  tier: 'pair' | 'run';
  /** Which exhaustion this is (see {@link v3RevisitBudgetEpoch}): one grant
   *  card per epoch; a card from an older epoch is expired. */
  epoch: number;
}

/** Which exhaustion of `nodeId`'s rerun budget at `tier` this is: the number
 *  of grants that lift exactly that tier — the node's own pair grants for
 *  `pair`, run-wide grants for `run`. An exhausted tier only reopens through
 *  such a grant, so repeated refusals of one exhaustion share an epoch, and a
 *  grant that cannot lift it (another node's pair, or a run-wide grant while
 *  this node's own pair is spent) leaves its card valid. */
export function v3RevisitBudgetEpoch(
  events: readonly StoredEvent[],
  nodeId: string,
  tier: 'pair' | 'run',
): number {
  let epoch = 0;
  for (const event of events) {
    if (event.type === 'dagRevised') {
      // An initiator's edit that lifted the budget itself (M2 乙).
      for (const grant of event.effects?.budgetGrants ?? []) {
        if (tier === 'run' ? grant.tier === 'run' : grant.tier === 'pair' && grant.nodeId === nodeId) epoch++;
      }
      continue;
    }
    if (event.type !== 'revisitBudgetGranted') continue;
    const runWide = event.sourceNodeId === undefined && event.toNodeId === undefined;
    if (tier === 'run' ? runWide : event.sourceNodeId === nodeId && event.toNodeId === nodeId) epoch++;
  }
  return epoch;
}

export type PlanV3DagRevisionResult =
  | { ok: true; plan: V3RevisionPlan }
  | { ok: false; problems: string[]; rerunBudget?: V3RerunBudgetBlock };

type RawNode = Record<string, unknown> & { id: string };

function cloneRaw<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (isPlainObject(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]]));
    }
    return v;
  });
}

function gatePolicy(node: V3Node | undefined): string | undefined {
  if (!node?.humanGate) return undefined;
  const normalized = normalizeGateWaitInput(node.humanGate);
  return canonical({
    options: normalized.options,
    approveOptions: normalized.approveOptions,
    approvers: [...normalized.approvers].sort(),
  });
}

function effectiveTimeout(node: V3Node | undefined): number {
  return node?.timeoutSec ?? DEFAULT_NODE_TIMEOUT_SEC;
}

function nodeDefinitionWithoutWiring(node: V3Node): unknown {
  const { depends: _depends, inputs: _inputs, triggerRule: _triggerRule, bot: _bot, ...rest } = node;
  return rest;
}

/** What the node's executor works on: its definition minus the checkpoint
 *  mark, which only says whether the main bot looks at the result once the
 *  node is done (§13.6), and minus the placement, which only says where the
 *  not-yet-started node will be handed off (§5.2). Toggling either never
 *  invalidates work in progress or a gate approval. */
function nodeWorkDefinition(node: V3Node): unknown {
  const { checkpoint: _checkpoint, placement: _placement, ...rest } = nodeDefinitionWithoutWiring(node) as V3Node;
  return rest;
}

function collectBotSelectors(node: V3Node, inherited?: string): Array<{ nodeId: string; selector: string }> {
  const out: Array<{ nodeId: string; selector: string }> = [];
  if (node.type === 'goal' || node.type === 'loop') {
    const selector = node.bot ?? inherited;
    if (selector) out.push({ nodeId: node.id, selector });
    if (isLoopNode(node)) {
      for (const body of node.body.nodes) out.push(...collectBotSelectors(body, selector));
    }
  }
  return out;
}

function resolveSelectorKey(
  knownBots: ReadonlyMap<string, BotSnapshot>,
  selector: string,
): { key: string; known: boolean } {
  if (knownBots.has(selector)) return { key: selector, known: true };
  for (const [key, snapshot] of knownBots) {
    if (snapshot.larkAppId === selector) return { key, known: true };
  }
  return { key: selector, known: false };
}

/** The bot selector a goal/loop node's definition names. */
function definedBotOf(node: V3Node | undefined): string | undefined {
  return node && (node.type === 'goal' || node.type === 'loop') ? node.bot : undefined;
}

function hasHistory(snap: V3RunSnapshot, nodeId: string, events: readonly StoredEvent[]): boolean {
  if (snap.nodes.has(nodeId) || snap.loops.has(nodeId)) return true;
  const prefix = `${nodeId}#`;
  for (const instanceId of snap.instances.keys()) if (instanceId.startsWith(prefix)) return true;
  return events.some((event) => 'nodeId' in event && event.nodeId === nodeId);
}

function latestGateWaitId(events: readonly StoredEvent[], nodeId: string, instanceId: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'gateDispatched' && event.nodeId === nodeId && event.instanceId === instanceId) {
      return event.waitId;
    }
  }
  return undefined;
}

/** What blocked the node's current attempt (for re-run eligibility). */
function latestBlockOf(
  events: readonly StoredEvent[],
  snap: V3RunSnapshot,
  nodeId: string,
):
  | { kind: 'nodeBlocked'; errorClass?: Extract<V3Event, { type: 'nodeBlocked' }>['errorClass']; errorCode?: string; reviseRequired: boolean }
  | { kind: 'hostUncertain' }
  | undefined {
  const key = snap.nodes.get(nodeId)?.effectiveInstanceId ?? nodeId;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'hostEffectUncertain' && (event.instanceId ?? event.nodeId) === key) return { kind: 'hostUncertain' };
    if (event.type === 'nodeBlocked' && (event.instanceId ?? event.nodeId) === key) {
      return {
        kind: 'nodeBlocked',
        errorClass: event.errorClass,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        reviseRequired: event.recovery === 'reviseWorkflow',
      };
    }
  }
  return undefined;
}

function summarize(changes: V3RevisionChanges): string {
  const parts: string[] = [];
  if (changes.added.length) parts.push(`+${changes.added.length} 节点`);
  if (changes.removed.length) parts.push(`-${changes.removed.length} 节点`);
  if (changes.changed.length) parts.push(`改 ${changes.changed.length} 节点`);
  if (changes.dependsChanged.length) parts.push(`改依赖 ${changes.dependsChanged.length}`);
  if (changes.reassigned.length) parts.push(`改派 ${changes.reassigned.length}`);
  if (changes.rerun.length) parts.push(`重做 ${changes.rerun.length}`);
  return parts.length > 0 ? parts.join('、') : '无实质变化';
}

/**
 * Apply `patch` to the current effective DAG and decide what it means for a
 * running run. Returns problems instead of throwing, so callers can surface
 * every rule the edit broke at once.
 *
 * §13.4 rules enforced here (node state → allowed ops):
 *   not started          everything
 *   gate waiting         change / reassign / remove (pending gate voided)
 *   running              change / reassign / remove; never rewire
 *   blocked              change / reassign / remove (fresh instance)
 *   done                 only rerunNode (Revisit semantics + budget), or new
 *                        downstream nodes
 *   skipped / cancelled  nothing (add a new node instead)
 *   loop running         only maxIterations; remove the whole loop otherwise
 * Host nodes with an external effect in flight cannot change at all.
 */
export function planV3DagRevision(input: PlanV3DagRevisionInput): PlanV3DagRevisionResult {
  const { dag, approvedDag, events, snap, patch, knownBots } = input;
  const readProducts = input.readProducts ?? ((nodeId: string) => readV3DoneNodeProducts(events, snap, nodeId));
  const problems: string[] = [];
  if (snap.runStatus !== 'running' && snap.runStatus !== 'blocked') {
    return { ok: false, problems: [`run is ${snap.runStatus}; only a running or blocked run can be edited`] };
  }

  const originalById = new Map(dag.nodes.map((node) => [node.id, node]));
  const raw: RawNode[] = cloneRaw(dag.nodes) as unknown as RawNode[];
  const indexOf = (nodeId: string): number => raw.findIndex((node) => node.id === nodeId);
  const added = new Set<string>();
  const removed = new Set<string>();
  const updated = new Set<string>();
  const dependsChanged = new Set<string>();
  const reassigned = new Map<string, { from?: string; to: string }>();
  /** Who executed each node a reassign op names, read ONCE, before any op
   *  of this patch ran (a blocked-card 改派 first, then the bot its
   *  definition names): every op of the patch compares against the same
   *  starting point, never against an earlier op's target. */
  const executorAtStart = new Map<string, string | undefined>();
  /** The last reassign target per existing node; resolved into `reassigned`
   *  once every op ran (a round trip back to the start is no move at all). */
  const reassignTargets = new Map<string, string>();
  const rerun = new Set<string>();
  let rerunBudget: V3RerunBudgetBlock | undefined;
  const budgetGrants: V3RevisionPlan['budgetGrants'] = [];
  /** The journal as it will read once this revision took effect, as far as
   *  the revisit budget is concerned: this patch's accepted reruns spend it
   *  and its lifts extend it (exactly what the `dagRevised` effects record),
   *  so every later op of the patch is checked against both. */
  const budgetLedger = (): StoredEvent[] => [
    ...events,
    ...(rerun.size > 0 || budgetGrants.length > 0
      ? [{ type: 'dagRevised', effects: { rerun: [...rerun], budgetGrants: [...budgetGrants] } } as unknown as StoredEvent]
      : []),
  ];
  /** Blocked nodes the patch asks to run again (rerunNode, or a reassign). */
  const retryBlocked = new Set<string>();
  const rerunBlockedOps = new Set<string>();
  const openHostEffectNodes = new Set<string>();
  for (const event of events) {
    if (event.type === 'hostEffectIntent') openHostEffectNodes.add(event.nodeId);
    else if (
      (event.type === 'nodeSucceeded' || event.type === 'nodeFailed' || event.type === 'nodeBlocked') &&
      openHostEffectNodes.has(event.nodeId)
    ) openHostEffectNodes.delete(event.nodeId);
  }

  const lifecycleOf = (nodeId: string): V3NodeLifecycle | undefined => {
    const original = originalById.get(nodeId);
    if (!original || added.has(nodeId)) return undefined;
    return v3NodeLifecycle(snap, original);
  };
  const editable = (nodeId: string, where: string, what: string): V3NodeLifecycle | undefined => {
    if (indexOf(nodeId) < 0) {
      problems.push(`${where}: node "${nodeId}" is not in the current flow`);
      return undefined;
    }
    const lifecycle = lifecycleOf(nodeId);
    if (lifecycle === 'done') {
      problems.push(`${where}: node "${nodeId}" is done — it cannot be ${what}; use rerunNode or add a downstream node`);
      return undefined;
    }
    if (lifecycle === 'closed') {
      problems.push(`${where}: node "${nodeId}" is ${snap.nodes.get(nodeId)?.status} — add a new node instead`);
      return undefined;
    }
    const original = originalById.get(nodeId);
    if (original && isHostNode(original) && lifecycle === 'running') {
      problems.push(`${where}: host node "${nodeId}" is executing its external effect and cannot be ${what}`);
      return undefined;
    }
    return lifecycle ?? 'notStarted';
  };
  const normalizeBot = (selector: string): string => resolveSelectorKey(knownBots, selector).key;
  const normalizeNodeBots = (node: Record<string, unknown>): void => {
    if (typeof node.bot === 'string' && node.bot.trim()) node.bot = normalizeBot(node.bot.trim());
    const body = (node.body as { nodes?: unknown } | undefined)?.nodes;
    if (Array.isArray(body)) {
      for (const child of body) if (isPlainObject(child)) normalizeNodeBots(child);
    }
  };

  patch.ops.forEach((op, index) => {
    const where = `ops[${index}] ${op.op}`;
    switch (op.op) {
      case 'addNode': {
        const node = cloneRaw(op.node);
        const id = node.id;
        if (typeof id !== 'string' || !V3_DAG_SEGMENT_RE.test(id)) {
          problems.push(`${where}: node.id must be a path-safe node id`);
          return;
        }
        if (indexOf(id) >= 0) {
          problems.push(`${where}: node "${id}" already exists`);
          return;
        }
        if (removed.has(id) || hasHistory(snap, id, events)) {
          problems.push(`${where}: node id "${id}" was used earlier in this run — pick a new id`);
          return;
        }
        normalizeNodeBots(node);
        raw.push(node as RawNode);
        added.add(id);
        return;
      }
      case 'removeNode': {
        const lifecycle = editable(op.nodeId, where, 'removed');
        if (!lifecycle) return;
        raw.splice(indexOf(op.nodeId), 1);
        if (added.has(op.nodeId)) added.delete(op.nodeId);
        else removed.add(op.nodeId);
        updated.delete(op.nodeId);
        dependsChanged.delete(op.nodeId);
        reassignTargets.delete(op.nodeId);
        return;
      }
      case 'updateNode': {
        const lifecycle = editable(op.nodeId, where, 'changed');
        if (!lifecycle) return;
        if (lifecycle === 'loopRunning') {
          const bad = Object.keys(op.set).filter((key) => !STARTED_LOOP_FIELDS.has(key));
          if (bad.length > 0) {
            problems.push(
              `${where}: loop "${op.nodeId}" is running — only maxIterations may change ` +
              '(wait for it to finish, or remove the whole loop and add a new one)',
            );
            return;
          }
        }
        const node = raw[indexOf(op.nodeId)]!;
        // §5.2: a node is handed off where its placement says when it starts;
        // once an attempt went out (or the node ran before), its retries and
        // revisits stay where it is. Only a node that has not started — or
        // still waits at its gate, nothing handed off yet — may move.
        if (Object.prototype.hasOwnProperty.call(op.set, 'placement')
          && lifecycle !== 'notStarted' && lifecycle !== 'gateWaiting') {
          const wanted = op.set.placement === null ? 'topic' : op.set.placement;
          if (wanted !== v3NodePlacement(node as unknown as V3Node)) {
            problems.push(`${where}: node "${op.nodeId}" has already started — its placement cannot change (only a node that has not started may move between the main topic and a node topic)`);
            return;
          }
        }
        for (const [key, value] of Object.entries(op.set)) {
          if (value === null) delete node[key];
          else node[key] = cloneRaw(value);
        }
        if (op.set.body !== undefined) normalizeNodeBots({ body: node.body });
        if (!added.has(op.nodeId)) updated.add(op.nodeId);
        return;
      }
      case 'setDepends': {
        const lifecycle = editable(op.nodeId, where, 'rewired');
        if (!lifecycle) return;
        if (lifecycle !== 'notStarted') {
          problems.push(`${where}: node "${op.nodeId}" has already started — its dependencies cannot change`);
          return;
        }
        const node = raw[indexOf(op.nodeId)]!;
        node.depends = cloneRaw(op.depends);
        if (op.inputs !== undefined) node.inputs = cloneRaw(op.inputs);
        if (op.triggerRule === null) delete node.triggerRule;
        else if (op.triggerRule !== undefined) node.triggerRule = cloneRaw(op.triggerRule);
        if (!added.has(op.nodeId)) dependsChanged.add(op.nodeId);
        return;
      }
      case 'reassign': {
        const lifecycle = editable(op.nodeId, where, 'reassigned');
        if (!lifecycle) return;
        const node = raw[indexOf(op.nodeId)]!;
        if (node.type !== 'goal' && node.type !== 'loop') {
          problems.push(`${where}: only goal or loop nodes run on a bot ("${op.nodeId}" is ${String(node.type)})`);
          return;
        }
        if (lifecycle === 'loopRunning') {
          problems.push(`${where}: loop "${op.nodeId}" is running — its body cannot move to another bot`);
          return;
        }
        const target = normalizeBot(op.bot);
        if (added.has(op.nodeId)) {
          node.bot = target;
          return;
        }
        // Who executes the node now: a blocked-card reassignment moves it
        // without touching its definition, so the definition's bot (as it
        // was before this patch) is only the fallback.
        if (!executorAtStart.has(op.nodeId)) {
          executorAtStart.set(
            op.nodeId,
            v3CurrentExecutorApp(snap, knownBots, op.nodeId, definedBotOf(originalById.get(op.nodeId))),
          );
        }
        node.bot = target;
        reassignTargets.set(op.nodeId, target);
        return;
      }
      case 'rerunNode': {
        if (indexOf(op.nodeId) < 0 || added.has(op.nodeId)) {
          problems.push(`${where}: node "${op.nodeId}" is not in the current flow`);
          return;
        }
        const lifecycle = lifecycleOf(op.nodeId);
        if (lifecycle === 'blocked') {
          // A blocked node re-runs as an ordinary retry (same instance, next
          // attempt) — no revisit budget; checked against the block below.
          retryBlocked.add(op.nodeId);
          rerunBlockedOps.add(op.nodeId);
          return;
        }
        if (lifecycle !== 'done') {
          problems.push(`${where}: only a done or blocked node can be re-run ("${op.nodeId}" is ${snap.nodes.get(op.nodeId)?.status ?? 'pending'})`);
          return;
        }
        const original = originalById.get(op.nodeId)!;
        if (original.type !== 'goal') {
          problems.push(`${where}: only goal nodes can be re-run (re-running a ${original.type} node would replay it)`);
          return;
        }
        // The same node named twice is still one re-run: one revisit spent.
        if (rerun.has(op.nodeId)) return;
        let budget = revisitBudgetStatus(budgetLedger(), op.nodeId, op.nodeId);
        // The initiator's own edit lifts whatever this one re-run needs —
        // its own pair tier and/or the run tier, one revisit each — so the
        // revision never leaves the budget overspent.
        for (let tiers = 0; !budget.ok && input.liftSpentRerunBudget && tiers < 2; tiers++) {
          budgetGrants.push({ nodeId: op.nodeId, tier: budget.tier });
          budget = revisitBudgetStatus(budgetLedger(), op.nodeId, op.nodeId);
        }
        if (!budget.ok) {
          problems.push(
            `${where}: 节点 "${op.nodeId}" 的重做额度已用完（${budget.tier === 'pair' ? '本节点' : '整个 run'}的 Revisit 额度）；` +
            '需要发起人在「追加重做额度」卡上同意后再提交这次修改',
          );
          rerunBudget = { nodeId: op.nodeId, tier: budget.tier, epoch: v3RevisitBudgetEpoch(events, op.nodeId, budget.tier) };
          return;
        }
        rerun.add(op.nodeId);
        return;
      }
    }
  });
  // Every reassign op ran: what moves is only the net change, from where the
  // node executed when the patch began to its last target. A node that ends
  // where it started is not moved (its running turn is not stopped) and its
  // definition keeps the bot it had. Compared as app ids, after selector
  // resolution; an unresolvable target is always a move.
  for (const [nodeId, target] of reassignTargets) {
    const startApp = executorAtStart.get(nodeId);
    const original = definedBotOf(originalById.get(nodeId));
    const targetApp = snapshotForSelector(knownBots, target)?.larkAppId;
    if (targetApp !== undefined && targetApp === startApp) {
      const node = raw[indexOf(nodeId)]!;
      if (original === undefined) delete node.bot;
      else node.bot = original;
      continue;
    }
    const from = startApp !== undefined ? resolveSelectorKey(knownBots, startApp).key : original;
    reassigned.set(nodeId, { ...(from ? { from } : {}), to: target });
  }
  if (problems.length > 0) return { ok: false, problems, ...(rerunBudget ? { rerunBudget } : {}) };

  let next: V3Dag;
  try {
    next = validateDag({
      ...(dag.schemaVersion !== undefined ? { schemaVersion: dag.schemaVersion } : {}),
      runId: dag.runId,
      nodes: raw,
    });
  } catch (err) {
    return {
      ok: false,
      problems: err instanceof DagValidationError ? err.problems : [err instanceof Error ? err.message : String(err)],
    };
  }
  const nextById = new Map(next.nodes.map((node) => [node.id, node]));
  const approvedById = new Map(approvedDag.nodes.map((node) => [node.id, node]));

  // §5.2 hard rules 1 and 2 on the flow as it will run: who executes each
  // node after this revision (this patch's reassignment, else an earlier
  // one, else its definition). Rule 3 is the entry point's (it needs the
  // main session; see applyV3RunEdit).
  const mainApp = snapshotForSelector(knownBots, '')?.larkAppId ?? '';
  const placementProblems = v3PlacementProblems({
    dag: next,
    mainLarkAppId: mainApp,
    executorOf: (nodeId) => {
      const move = reassigned.get(nodeId);
      if (move) return snapshotForSelector(knownBots, move.to)?.larkAppId ?? move.to;
      const defined = definedBotOf(nextById.get(nodeId));
      return (added.has(nodeId) ? undefined : snap.assignments.get(nodeId))
        ?? snapshotForSelector(knownBots, defined)?.larkAppId ?? defined ?? mainApp;
    },
  });
  if (placementProblems.length > 0) return { ok: false, problems: placementProblems.map((problem) => problem.message) };

  // Updates that turned out to be no-ops do not count as changes.
  const changed = [...updated].filter((nodeId) => {
    const before = originalById.get(nodeId);
    const after = nextById.get(nodeId);
    return !!before && !!after && canonical(nodeDefinitionWithoutWiring(before)) !== canonical(nodeDefinitionWithoutWiring(after));
  });
  // A checkpoint-only change is recorded like any change but redoes nothing.
  const workChanged = changed.filter((nodeId) =>
    canonical(nodeWorkDefinition(originalById.get(nodeId)!)) !== canonical(nodeWorkDefinition(nextById.get(nodeId)!)));
  const rewired = [...dependsChanged].filter((nodeId) => {
    const before = originalById.get(nodeId);
    const after = nextById.get(nodeId);
    return !!before && !!after && canonical({ d: before.depends, i: before.inputs, t: before.triggerRule }) !==
      canonical({ d: after.depends, i: after.inputs, t: after.triggerRule });
  });

  // ── Wiring onto done nodes (§13.4 extra checks) ──
  const edges: Array<Extract<V3Event, { type: 'edgeResolved' }>> = [];
  const wiringNodes = [...added, ...rewired];
  for (const nodeId of wiringNodes) {
    const node = nextById.get(nodeId)!;
    const before = originalById.get(nodeId);
    for (const dep of node.depends) {
      if (snap.nodes.get(dep.from)?.status !== 'done') continue;
      const products = readProducts(dep.from);
      if (!products) {
        problems.push(`node "${nodeId}" depends on done node "${dep.from}" whose products cannot be read`);
        continue;
      }
      for (const inputRef of node.inputs.filter((ref) => ref.from === dep.from)) {
        if (inputRef.output !== undefined) {
          const source = nextById.get(dep.from);
          const declared = source?.type === 'loop'
            ? source.body?.nodes.find((body) => body.id === source.output?.from)?.outputs?.[inputRef.output]
            : source?.outputs?.[inputRef.output];
          if (!declared || !products.manifest.files.some((file) => file.path === declared.path)) {
            problems.push(
              `node "${nodeId}" reads output "${inputRef.output}" of done node "${dep.from}", ` +
              'which is not in that node\'s manifest',
            );
          }
        } else if (inputRef.select) {
          const hit = products.manifest.files.some((file) =>
            (inputRef.select!.name === undefined || file.name === inputRef.select!.name) &&
            (inputRef.select!.path === undefined || file.path === inputRef.select!.path));
          if (!hit) {
            problems.push(`node "${nodeId}" selects a product of done node "${dep.from}" that is not in its manifest`);
          }
        }
      }
      if (!dep.when) continue;
      const fromInstanceId = snap.nodes.get(dep.from)?.effectiveInstanceId;
      const edgeKey = `${fromInstanceId ?? dep.from}->${nodeId}`;
      const priorDep = before?.depends.find((candidate) => candidate.from === dep.from);
      if (snap.edges.has(edgeKey)) {
        if (canonical(priorDep?.when) !== canonical(dep.when)) {
          problems.push(
            `conditional edge "${dep.from}" → "${nodeId}" was already resolved and cannot be redefined; add a new node instead`,
          );
        }
        continue;
      }
      const key = dep.when.path.slice('result.'.length);
      const value = products.result?.[key];
      edges.push({
        type: 'edgeResolved',
        from: dep.from,
        to: nodeId,
        ...(fromInstanceId ? { fromInstanceId } : {}),
        sourceAttemptId: products.attemptId,
        active: products.result ? matchLoopExitWhen(dep.when, value) : false,
        detail: products.result ? `${dep.when.path}=${JSON.stringify(value)}` : `${dep.when.path}=<unreadable>`,
      });
    }
  }

  // ── Effects on dispatched work ──
  const supersede = new Map<string, { nodeId: string; instanceId: string; waitId?: string }>();
  const cancel: NonNullable<V3RevisionEffects['cancel']> = [];
  const addSupersede = (nodeId: string): void => {
    const state = snap.nodes.get(nodeId);
    const instanceId = state?.effectiveInstanceId;
    if (!instanceId || supersede.has(instanceId)) return;
    const waitId = state?.status === 'gateWaiting' ? latestGateWaitId(events, nodeId, instanceId) : undefined;
    supersede.set(instanceId, { nodeId, instanceId, ...(waitId ? { waitId } : {}) });
  };
  // A blocked node has no live attempt to invalidate (§13.4 blocked row): it
  // re-runs only when asked (rerunNode, or a reassign — the same path as the
  // existing reassign), as a retry that reopens the run; a definition-only
  // change leaves it blocked for a later retry.
  const retries: V3RevisionPlan['retries'] = [];
  const regate: NonNullable<V3RevisionEffects['regate']> = [];
  for (const nodeId of [...new Set([...workChanged, ...reassigned.keys()])]) {
    if (v3NodeLifecycle(snap, originalById.get(nodeId)!) === 'blocked') {
      if (reassigned.has(nodeId)) retryBlocked.add(nodeId);
      // Its gate approval covered the OLD definition: however the node is
      // retried later, it must pass the (new) gate again.
      const state = snap.nodes.get(nodeId);
      if (workChanged.includes(nodeId) && state?.gateCleared && state.effectiveInstanceId && nextById.get(nodeId)?.humanGate) {
        regate.push({ nodeId, instanceId: state.effectiveInstanceId });
      }
      continue;
    }
    addSupersede(nodeId);
  }
  for (const nodeId of retryBlocked) {
    if (removed.has(nodeId)) continue;
    const blockedEvent = latestBlockOf(events, snap, nodeId);
    if (blockedEvent?.kind === 'hostUncertain') {
      problems.push(`node "${nodeId}" has an external effect whose outcome is unknown; reconcile it before re-running`);
      continue;
    }
    if (blockedEvent?.reviseRequired && !workChanged.includes(nodeId)) {
      problems.push(`node "${nodeId}" broke its output contract; change its definition in the same edit to re-run it`);
      continue;
    }
    const instanceId = snap.nodes.get(nodeId)?.effectiveInstanceId;
    // A changed definition re-passes its gate through `regate` (a fresh
    // instance); a pure reassign keeps the approval, like the existing path.
    retries.push({
      nodeId,
      ...(instanceId ? { instanceId } : {}),
      ...(blockedEvent?.errorClass ? { previousErrorClass: blockedEvent.errorClass } : {}),
      ...(blockedEvent?.errorCode ? { previousErrorCode: blockedEvent.errorCode } : {}),
    });
  }
  for (const nodeId of rerun) {
    for (const coneId of affectedNodesFrom(next, nodeId)) {
      const coneNode = nextById.get(coneId)!;
      const coneState = snap.nodes.get(coneId)?.status;
      if (isHostNode(coneNode) && (coneState === 'done' || coneState === 'running' || openHostEffectNodes.has(coneId))) {
        problems.push(`rerunNode "${nodeId}" would replay host node "${coneId}", whose external effect already ran`);
        continue;
      }
      if (isLoopNode(coneNode) && snap.loops.has(coneId)) {
        problems.push(`rerunNode "${nodeId}" would have to restart loop "${coneId}", which already started`);
        continue;
      }
      addSupersede(coneId);
    }
  }
  for (const nodeId of removed) {
    const original = originalById.get(nodeId)!;
    const state = snap.nodes.get(nodeId);
    const lifecycle = v3NodeLifecycle(snap, original);
    if (lifecycle === 'notStarted') continue;
    if (lifecycle === 'loopRunning') {
      const loopState = snap.loops.get(nodeId);
      cancel.push({ nodeId });
      if (loopState && loopState.iteration > 0 && isLoopNode(original)) {
        for (const body of original.body.nodes) {
          const bodyId = loopInstanceId(nodeId, loopState.iteration, body.id);
          const bodyStatus = snap.nodes.get(bodyId)?.status;
          if (bodyStatus === 'running' || bodyStatus === 'gateWaiting' || bodyStatus === 'blocked') {
            const attemptId = snap.attempts.get(bodyId);
            cancel.push({ nodeId: bodyId, ...(attemptId ? { attemptId } : {}) });
          }
        }
      }
      continue;
    }
    const instanceId = state?.effectiveInstanceId;
    const attemptId = snap.attempts.get(instanceId ?? nodeId);
    const waitId = lifecycle === 'gateWaiting' && instanceId ? latestGateWaitId(events, nodeId, instanceId) : undefined;
    cancel.push({
      nodeId,
      ...(instanceId ? { instanceId } : {}),
      ...(attemptId && (lifecycle === 'running' || lifecycle === 'blocked') ? { attemptId } : {}),
      // Deleting a node voids its pending approval exactly like changing it.
      ...(waitId ? { waitId } : {}),
    });
  }
  if (problems.length > 0) return { ok: false, problems };

  // ── §13.5 classification ──
  const reasons = new Set<V3RevisionConfirmReason>();
  // Every selector the new flow runs on must already be approved for this
  // run; anything else is a new bot (normalized above where the op named it).
  const newBots = [...new Set(next.nodes.flatMap((node) => collectBotSelectors(node))
    .map((entry) => entry.selector)
    .filter((selector) => !resolveSelectorKey(knownBots, selector).known))];
  if (newBots.length > 0) reasons.add('newBot');
  const hostNodes: string[] = [];
  for (const nodeId of added) if (isHostNode(nextById.get(nodeId)!)) hostNodes.push(nodeId);
  for (const nodeId of [...changed, ...rewired]) {
    if (isHostNode(nextById.get(nodeId)!) && !hostNodes.includes(nodeId)) hostNodes.push(nodeId);
  }
  if (hostNodes.length > 0) reasons.add('hostNode');
  const gateChanges: V3RevisionChanges['gateChanges'] = [];
  for (const nodeId of changed) {
    const before = gatePolicy(originalById.get(nodeId));
    const after = gatePolicy(nextById.get(nodeId));
    if (before === after) {
      if (canonical(originalById.get(nodeId)?.humanGate ?? null) !== canonical(nextById.get(nodeId)?.humanGate ?? null)) {
        gateChanges.push({ nodeId, change: 'changed' });
      }
      continue;
    }
    if (before && !after) {
      gateChanges.push({ nodeId, change: 'removed' });
      reasons.add('gateRelaxed');
    } else if (!before && after) {
      gateChanges.push({ nodeId, change: 'added' });
    } else {
      gateChanges.push({ nodeId, change: 'changed' });
      reasons.add('gateRelaxed');
    }
  }
  for (const nodeId of added) if (nextById.get(nodeId)?.humanGate) gateChanges.push({ nodeId, change: 'added' });
  // Deleting a gated node whose gate has not been passed yet deletes a human
  // approval (§13.5 category 3).
  for (const nodeId of removed) {
    if (!originalById.get(nodeId)?.humanGate || snap.nodes.get(nodeId)?.gateCleared) continue;
    gateChanges.push({ nodeId, change: 'removed' });
    reasons.add('gateRelaxed');
  }
  const timeoutRaised = (after: V3Node, before: V3Node, baseline: V3Node): boolean =>
    effectiveTimeout(after) > Math.max(effectiveTimeout(baseline), effectiveTimeout(before));
  for (const nodeId of changed) {
    const before = originalById.get(nodeId)!;
    const after = nextById.get(nodeId)!;
    const baseline = approvedById.get(nodeId) ?? before;
    if (after.type === 'goal' && timeoutRaised(after, before, baseline)) reasons.add('budgetExpanded');
    if (isLoopNode(after) && isLoopNode(before)) {
      const baselineMax = isLoopNode(baseline) ? baseline.maxIterations : before.maxIterations;
      if (after.maxIterations > Math.max(baselineMax, before.maxIterations)) reasons.add('budgetExpanded');
      // Category 4 covers the loop's body nodes too.
      for (const body of after.body.nodes) {
        const priorBody = before.body.nodes.find((candidate) => candidate.id === body.id);
        if (!priorBody) continue;
        const baselineBody = (isLoopNode(baseline) ? baseline.body.nodes.find((candidate) => candidate.id === body.id) : undefined) ?? priorBody;
        if (timeoutRaised(body, priorBody, baselineBody)) reasons.add('budgetExpanded');
      }
    }
  }
  if (next.nodes.length > approvedDag.nodes.length * 2) reasons.add('budgetExpanded');

  const changes: V3RevisionChanges = {
    added: [...added],
    removed: [...removed],
    changed,
    dependsChanged: rewired,
    reassigned: [...reassigned.entries()].map(([nodeId, value]) => ({ nodeId, ...value })),
    rerun: [...rerun, ...[...rerunBlockedOps].filter((nodeId) => !removed.has(nodeId))],
    newBots,
    hostNodes,
    gateChanges,
  };
  const touched = new Set<string>([...removed, ...changed, ...rewired, ...reassigned.keys(), ...retryBlocked]);
  for (const entry of supersede.values()) touched.add(entry.nodeId);
  const effects: V3RevisionEffects = {
    ...(supersede.size > 0 ? { supersede: [...supersede.values()] } : {}),
    ...(cancel.length > 0 ? { cancel } : {}),
    ...(rerun.size > 0 ? { rerun: [...rerun] } : {}),
    ...(budgetGrants.length > 0 ? { budgetGrants: [...budgetGrants] } : {}),
    ...(regate.length > 0 ? { regate } : {}),
    ...(retries.length > 0
      ? { retry: retries.map((retry) => ({ nodeId: retry.nodeId, ...(retry.instanceId ? { instanceId: retry.instanceId } : {}) })) }
      : {}),
    ...(reassigned.size > 0
      ? {
          assign: [...reassigned.entries()].map(([nodeId, value]) => {
            const snapshot = snapshotForSelector(knownBots, value.to);
            const fromSnapshot = snapshotForSelector(knownBots, value.from);
            return {
              nodeId,
              ...(fromSnapshot?.larkAppId ?? value.from ? { from: fromSnapshot?.larkAppId ?? value.from } : {}),
              to: snapshot?.larkAppId ?? value.to,
            };
          }),
        }
      : {}),
  };
  return {
    ok: true,
    plan: {
      dag: next,
      summary: summarize(changes),
      changes,
      reasons: [...reasons],
      touched: [...touched].filter((nodeId) => originalById.has(nodeId)),
      effects,
      edges,
      budgetGrants,
      retries,
    },
  };
}

/**
 * Every node a revision involves: the existing nodes it touches (changed,
 * rewired, reassigned, removed, re-run — with the downstream instances a
 * re-run replaces), the nodes it adds, and every node an added or rewired
 * node now depends on. Two revisions with disjoint sets change separate parts
 * of the flow: one taking effect leaves the other's meaning intact.
 */
export function v3RevisionInvolvedNodes(plan: Pick<V3RevisionPlan, 'dag' | 'changes' | 'touched'>): Set<string> {
  const involved = new Set<string>([
    ...plan.touched,
    ...plan.changes.added,
    ...plan.changes.removed,
    ...plan.changes.changed,
    ...plan.changes.dependsChanged,
    ...plan.changes.reassigned.map((item) => item.nodeId),
    ...plan.changes.rerun,
  ]);
  const wired = new Set([...plan.changes.added, ...plan.changes.dependsChanged]);
  for (const node of plan.dag.nodes) {
    if (!wired.has(node.id)) continue;
    for (const dep of node.depends) involved.add(dep.from);
  }
  return involved;
}

/** Is a node (or a loop body instance of it) held back by a pending
 *  proposal? Loop body instance ids map back to their loop. */
/**
 * The run's approved bot scope (§13.5): the snapshots frozen at approval plus
 * every bot the initiator approved into the run on a revision card (the
 * `dag-revisions/NNN.bots.json` of applied revisions — `botAdditions` of the
 * effective flow). The one definition of "approved": confirming an edit
 * (a bot outside it is a `newBot`), reassigning from the blocked card, and
 * the engine's reassignment all read it. Frozen entries win a selector clash.
 */
export function v3ApprovedBotScope(
  frozen: ReadonlyMap<string, BotSnapshot>,
  botAdditions: ReadonlyMap<string, BotSnapshot>,
): Map<string, BotSnapshot> {
  const scope = new Map(frozen);
  for (const [selector, snapshot] of botAdditions) if (!scope.has(selector)) scope.set(selector, snapshot);
  return scope;
}

/** A pending proposal touches `nodeId` (or the loop it runs in): answering
 *  its ask or reassigning it now would be overtaken by the proposal's
 *  decision, so both wait for the revision card to be decided. */
export function v3PendingProposalHolds(events: readonly StoredEvent[], nodeId: string): boolean {
  const pending = foldV3Revisions(events).pending;
  if (!pending) return false;
  const loopId = events.find((event): event is Extract<StoredEvent, { type: 'nodeDispatched' }> =>
    event.type === 'nodeDispatched' && event.nodeId === nodeId && !!event.loop)?.loop?.loopId;
  return v3NodeHeldByProposal(new Set(pending.touched), nodeId, loopId);
}

export function v3NodeHeldByProposal(
  pendingTouched: ReadonlySet<string> | undefined,
  nodeId: string,
  loopId?: string,
): boolean {
  if (!pendingTouched || pendingTouched.size === 0) return false;
  return pendingTouched.has(nodeId) || (loopId !== undefined && pendingTouched.has(loopId));
}

// ─── Dedicated follow-up events (design §13.3) ────────────────────────────

type FollowUpEvent = Extract<V3Event, { type: 'nodeRetryRequested' | 'nodeReassigned' }>;

/**
 * The dedicated events a revision's reassignments and blocked re-runs
 * advance state through, written in the same journal lock right after its
 * `dagRevised`. `events` is the journal BEFORE that lock's appends. A retry is
 * produced only while its node is still blocked on the recorded instance.
 */
export function v3RevisionFollowUps(
  events: readonly StoredEvent[],
  input: {
    retry?: ReadonlyArray<{ nodeId: string; instanceId?: string }>;
    assign?: ReadonlyArray<{ nodeId: string; from?: string; to: string }>;
    by: string;
    auto?: V3AutoProvenance;
    /** Node ids of the effective flow, when known: follow-ups for nodes no
     *  longer in it are skipped. */
    liveNodeIds?: ReadonlySet<string>;
  },
): FollowUpEvent[] {
  const out: FollowUpEvent[] = [];
  const provenance = { by: input.by, ...(input.auto ? { auto: input.auto } : {}) };
  const snap = materialize([...events]);
  for (const item of input.assign ?? []) {
    // A node a later revision removed is never reassigned after the fact.
    if (snap.nodes.get(item.nodeId)?.status === 'cancelled') continue;
    if (input.liveNodeIds && !input.liveNodeIds.has(item.nodeId)) continue;
    out.push({
      type: 'nodeReassigned',
      nodeId: item.nodeId,
      ...(snap.nodes.get(item.nodeId)?.effectiveInstanceId ? { instanceId: snap.nodes.get(item.nodeId)!.effectiveInstanceId } : {}),
      from: item.from ?? snap.assignments.get(item.nodeId) ?? '',
      to: item.to,
      ...provenance,
    });
  }
  for (const item of input.retry ?? []) {
    const state = snap.nodes.get(item.nodeId);
    if (state?.status !== 'blocked' || state.effectiveInstanceId !== item.instanceId) continue;
    const key = item.instanceId ?? item.nodeId;
    const previousAttemptId = latestAttemptIdFor([...events], key);
    if (!previousAttemptId) continue;
    const blocked = latestBlockOf(events, snap, item.nodeId);
    out.push({
      type: 'nodeRetryRequested',
      nodeId: item.nodeId,
      ...(item.instanceId ? { instanceId: item.instanceId } : {}),
      previousAttemptId,
      nextAttemptId: nextAttemptIdFor([...events], key),
      reason: 'blockedRetry',
      ...(blocked?.kind === 'nodeBlocked' && blocked.errorClass ? { previousErrorClass: blocked.errorClass } : {}),
      ...(blocked?.kind === 'nodeBlocked' && blocked.errorCode ? { previousErrorCode: blocked.errorCode } : {}),
      ...provenance,
    });
  }
  return out;
}

/**
 * Crash reconciliation (drive and cold attach): a `dagRevised` whose
 * recorded reassignment / blocked re-run has no dedicated event after it
 * lost its second append. Returns the missing events (idempotent: once
 * appended they satisfy the check). Nothing is owed after a cancel request.
 */
export function missingV3RevisionFollowUps(
  events: readonly StoredEvent[],
  liveNodeIds?: ReadonlySet<string>,
): FollowUpEvent[] {
  if (!events.some((event) => event.type === 'dagRevised' && (event.effects?.retry || event.effects?.assign))) return [];
  const snap = materialize([...events]);
  if (snap.runStatus !== 'running' && snap.runStatus !== 'blocked') return [];
  const missing: FollowUpEvent[] = [];
  events.forEach((event, index) => {
    if (event.type !== 'dagRevised' || (!event.effects?.retry && !event.effects?.assign)) return;
    const later = events.slice(index + 1);
    const assign = (event.effects.assign ?? []).filter((item) => !later.some((after) =>
      (after.type === 'nodeReassigned' && after.nodeId === item.nodeId) ||
      (after.type === 'dagRevised' && after.effects?.assign?.some((other) => other.nodeId === item.nodeId))));
    const retry = (event.effects.retry ?? []).filter((item) => !later.some((after) =>
      after.type === 'nodeRetryRequested' && after.nodeId === item.nodeId));
    if (assign.length === 0 && retry.length === 0) return;
    missing.push(...v3RevisionFollowUps(events, {
      assign,
      retry,
      by: event.by,
      ...(event.auto ? { auto: event.auto } : {}),
      ...(liveNodeIds ? { liveNodeIds } : {}),
    }));
  });
  return missing;
}

/**
 * Append the follow-ups revisions still owe, under the journal lock — but only
 * while the flow is still the one `liveNodeIds` was read from. A newer
 * revision landing between the caller's read and this lock may have removed a
 * node that never started (so nothing marks it cancelled): `stale` tells the
 * caller to re-read the flow and try again.
 */
export function appendMissingV3RevisionFollowUps(
  journalPath: string,
  scope: { revision: number; liveNodeIds: ReadonlySet<string> },
): { kind: 'appended'; count: number } | { kind: 'stale' } {
  return withJournalMutationSync(journalPath, ({ events, append }) => {
    if (currentV3Revision(events) !== scope.revision) return { kind: 'stale' as const };
    const missing = missingV3RevisionFollowUps(events, scope.liveNodeIds);
    for (const event of missing) append(event, { durable: true });
    return { kind: 'appended' as const, count: missing.length };
  });
}
