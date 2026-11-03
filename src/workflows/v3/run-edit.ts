/**
 * Runtime flow edits — the daemon/CLI half of design §13 (the pure engine
 * half is `dag-revision.ts`).
 *
 *   applyV3RunEdit           — `botmux workflow edit`: base check, plan, write
 *                              the revision files, then either take effect
 *                              (`dagRevised`) or wait for the initiator
 *                              (`dagRevisionProposed` + waits/revisions/NNN)
 *   decideV3RevisionProposal — the initiator's 同意 / 拒绝 on the confirmation card
 *   projectV3RunStatus       — `botmux workflow status`
 *   reconcileV3RevisionProposals — cold attach: re-post pending cards, heal a
 *                              decision whose journal half was lost, void
 *                              proposals of runs that ended
 *
 * Every journal decision happens inside the journal lock, so an edit, a card
 * click and a dispatch claim linearize: first come, first served (§13.3).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import { isGoalNode, isHostNode, isLoopNode, type V3Dag } from './dag.js';
import type { BotSnapshot } from './contract.js';
import {
  foldV3Revisions,
  loadEffectiveV3Dag,
  parseV3DagPatch,
  planV3DagRevision,
  snapshotForSelector,
  v3RevisionDigest,
  v3RevisionFilePaths,
  V3_DAG_REVISIONS_DIR,
  V3DagPatchError,
  type V3DagPatch,
  type V3RevisionChanges,
  type V3RevisionPlan,
  type V3RevisionRecord,
} from './dag-revision.js';
import type {
  StoredEvent,
  V3RevisionConfirmReason,
  V3RevisionEffects,
} from './event-contract.js';
import { readJournal, withJournalMutationSync, type JournalMutation } from './journal.js';
import { latestAttemptIdFor, nextAttemptIdFor } from './attempt-numbering.js';
import { materialize, type V3RunSnapshot } from './state.js';
import { loadAuthorizedV3Run, type V3RunEnvelope } from './run-envelope.js';
import { parseFrozenBotSnapshots } from './bot-resolve.js';
import { voidWaitOnce } from './gate-wait-store.js';
import { isValidRunId } from './ops-projection.js';
import type { RunChatBinding } from './grill-state.js';
import { resolveV3RunInitiator, type V3RunEditTurnOrigin } from './cli-daemon-command-authority.js';

// ─── Who may change the flow directly (M1) ────────────────────────────────

export { resolveV3RunInitiator };

export interface V3RunEditCaller {
  /** Authenticated human of the current turn. */
  openId: string;
  origin: V3RunEditTurnOrigin;
}

export type V3RunEditTurnClass = 'initiator' | 'runEvent' | 'other';

/** M1: only the initiator's own turns and turns this run's events woke may
 *  change the flow directly; every other turn's edit becomes a proposal. */
export function classifyV3RunEditTurn(
  initiatorOpenId: string | undefined,
  caller: V3RunEditCaller,
): V3RunEditTurnClass {
  if (caller.origin === 'runEvent') return 'runEvent';
  if (initiatorOpenId && caller.openId === initiatorOpenId) return 'initiator';
  return 'other';
}

/** Main-bot provenance for an edit made in an event-woken turn (§13.6). */
function autoProvenance(caller: V3RunEditCaller, note: string | undefined) {
  return caller.origin === 'runEvent' ? { auto: { by: 'main_bot' as const, reason: note ?? '' } } : {};
}

// ─── Proposal waits (waits/revisions/<NNN>.json) ──────────────────────────

export type V3RevisionWaitStatus = 'pending' | 'approved' | 'rejected' | 'voided';

/** What the confirmation card shows. Display state only: the decision is
 *  re-derived from the journal-pinned patch. */
export interface V3RevisionCardView {
  revision: number;
  baseRevision: number;
  summary: string;
  note?: string;
  reasons: V3RevisionConfirmReason[];
  changes: V3RevisionChanges;
  proposedBy: string;
}

export interface V3RevisionWait {
  runId: string;
  revision: number;
  status: V3RevisionWaitStatus;
  initiatorOpenId?: string;
  view: V3RevisionCardView;
  createdAt: number;
  resolvedAt?: number;
  by?: string;
  cardMessageIds?: string[];
}

export function v3RevisionWaitPath(runDir: string, revision: number): string {
  return join(runDir, 'waits', 'revisions', `${String(revision).padStart(3, '0')}.json`);
}

function writeJsonDurable(path: string, value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  atomicWriteFileSync(path, bytes, { mode: 0o600, durable: true, followTargetSymlink: false });
  return bytes;
}

function ensurePrivateDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`v3 revision: ${path} must be a real directory`);
}

export function readV3RevisionWait(runDir: string, revision: number): V3RevisionWait | undefined {
  const path = v3RevisionWaitPath(runDir, revision);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('v3 revision wait must be a regular file');
  return JSON.parse(readFileSync(path, 'utf-8')) as V3RevisionWait;
}

function writeRevisionWait(runDir: string, wait: V3RevisionWait): void {
  ensurePrivateDir(join(runDir, 'waits'));
  ensurePrivateDir(join(runDir, 'waits', 'revisions'));
  writeJsonDurable(v3RevisionWaitPath(runDir, wait.revision), wait);
}

/** Compare-and-set a pending proposal wait. First decision wins. */
function settleRevisionWaitOnce(
  runDir: string,
  revision: number,
  status: Exclude<V3RevisionWaitStatus, 'pending'>,
  by: string,
): { wait: V3RevisionWait; changed: boolean } | undefined {
  const path = v3RevisionWaitPath(runDir, revision);
  if (!existsSync(path)) return undefined;
  return withFileLockSync(path, () => {
    const wait = readV3RevisionWait(runDir, revision);
    if (!wait) return undefined;
    if (wait.status !== 'pending') return { wait, changed: false };
    const next: V3RevisionWait = { ...wait, status, resolvedAt: Date.now(), by };
    writeRevisionWait(runDir, next);
    return { wait: next, changed: true };
  });
}

/** Remember a confirmation card's message id (best effort). */
export function recordV3RevisionCardMessage(runDir: string, revision: number, messageId: string): void {
  const path = v3RevisionWaitPath(runDir, revision);
  if (!messageId || !existsSync(path)) return;
  withFileLockSync(path, () => {
    const wait = readV3RevisionWait(runDir, revision);
    if (!wait) return;
    const ids = wait.cardMessageIds ?? [];
    if (ids.includes(messageId)) return;
    writeRevisionWait(runDir, { ...wait, cardMessageIds: [...ids, messageId].slice(-8) });
  });
}

// ─── Loading ──────────────────────────────────────────────────────────────

interface LoadedEditableRun {
  runDir: string;
  envelope: V3RunEnvelope;
  approvedDag: V3Dag;
  frozenBots: Map<string, BotSnapshot>;
  binding?: RunChatBinding;
  initiatorOpenId?: string;
}

function runDirFor(baseDir: string, runId: string): string {
  if (!isValidRunId(runId)) throw new Error(`v3: invalid runId "${runId}"`);
  return join(baseDir, runId);
}

function loadEditableRun(baseDir: string, runId: string): LoadedEditableRun {
  const runDir = runDirFor(baseDir, runId);
  const loaded = loadAuthorizedV3Run(runDir, { expectedRunId: runId });
  if (loaded.botSnapshots === undefined) {
    throw new Error(`v3 run ${runId} has no pinned bots.snapshot.json and cannot be edited`);
  }
  const frozenBots = parseFrozenBotSnapshots(loaded.botSnapshots, loaded.dag);
  const initiatorOpenId = resolveV3RunInitiator(loaded.envelope);
  return {
    runDir,
    envelope: loaded.envelope,
    approvedDag: loaded.dag,
    frozenBots,
    ...(loaded.envelope.chatBinding ? { binding: loaded.envelope.chatBinding } : {}),
    ...(initiatorOpenId ? { initiatorOpenId } : {}),
  };
}

function knownBotsFor(frozen: ReadonlyMap<string, BotSnapshot>, additions: ReadonlyMap<string, BotSnapshot>): Map<string, BotSnapshot> {
  const merged = new Map(frozen);
  for (const [selector, snapshot] of additions) if (!merged.has(selector)) merged.set(selector, snapshot);
  return merged;
}

function hasChanges(changes: V3RevisionChanges): boolean {
  return changes.added.length + changes.removed.length + changes.changed.length +
    changes.dependsChanged.length + changes.reassigned.length + changes.rerun.length > 0;
}

/** Point every reassignment at the resolved app id of its target bot. */
function remapAssignTargets(
  effects: V3RevisionEffects,
  bots: ReadonlyMap<string, BotSnapshot>,
): V3RevisionEffects {
  if (!effects.assign) return effects;
  return {
    ...effects,
    assign: effects.assign.map((item) => ({
      ...item,
      to: snapshotForSelector(bots, item.to)?.larkAppId ?? item.to,
    })),
  };
}

/** Re-run the blocked nodes a revision asked for (§13.4 blocked row): the
 *  same `nodeRetryRequested` the existing retry/reassign paths write, so the
 *  run goes blocked → running and the next attempt follows the new flow.
 *  `events` is the journal read before this critical section's appends. */
function appendRevisionRetries(
  events: readonly StoredEvent[],
  append: JournalMutation['append'],
  retries: V3RevisionPlan['retries'],
): void {
  for (const retry of retries) {
    const key = retry.instanceId ?? retry.nodeId;
    const previousAttemptId = latestAttemptIdFor([...events], key);
    if (!previousAttemptId) continue;
    append({
      type: 'nodeRetryRequested',
      nodeId: retry.nodeId,
      ...(retry.instanceId ? { instanceId: retry.instanceId } : {}),
      previousAttemptId,
      nextAttemptId: nextAttemptIdFor([...events], key),
      reason: 'blockedRetry',
      ...(retry.previousErrorClass ? { previousErrorClass: retry.previousErrorClass } : {}),
      ...(retry.previousErrorCode ? { previousErrorCode: retry.previousErrorCode } : {}),
      ...(retry.resetGate ? { resetGate: true } : {}),
    }, { durable: true });
  }
}

// ─── Edit ─────────────────────────────────────────────────────────────────

export interface V3VoidedGate {
  waitId: string;
  nodeId: string;
  prompt: string;
  cardMessageIds: string[];
}

export interface V3VoidedProposal {
  revision: number;
  reason: 'stale' | 'superseded' | 'runEnded';
  view?: V3RevisionCardView;
  cardMessageIds: string[];
}

export type V3RunEditOutcome =
  | {
      kind: 'applied';
      revision: number;
      summary: string;
      changes: V3RevisionChanges;
      voidedGates: V3VoidedGate[];
      voidedProposals: V3VoidedProposal[];
    }
  | {
      kind: 'proposed';
      revision: number;
      summary: string;
      reasons: V3RevisionConfirmReason[];
      view: V3RevisionCardView;
      binding?: RunChatBinding;
      voidedProposals: V3VoidedProposal[];
    }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'invalid'; problems: string[] }
  | { kind: 'rejected'; reason: 'missing' | 'not-editable'; detail?: string };

export interface ApplyV3RunEditInput {
  baseDir: string;
  runId: string;
  /** Untrusted patch JSON (parsed here). */
  patch: unknown;
  baseRevision: number;
  caller: V3RunEditCaller;
  /** Resolve a bot the run has not used yet (proposal-only). Throws when the
   *  selector names no usable bot. */
  resolveNewBotSnapshot: (selector: string) => BotSnapshot;
}

interface WrittenRevision {
  sha256: string;
  patchSha256: string;
  botsSha256?: string;
}

function writeRevisionFiles(
  runDir: string,
  revision: number,
  input: {
    dag: V3Dag;
    patch: V3DagPatch;
    baseRevision: number;
    by: string;
    newBots: ReadonlyMap<string, BotSnapshot>;
  },
): WrittenRevision {
  ensurePrivateDir(join(runDir, V3_DAG_REVISIONS_DIR));
  const paths = v3RevisionFilePaths(runDir, revision);
  // A crash after these writes but before the journal append leaves files no
  // event references; the next edit re-allocates the same number and
  // atomically replaces them.
  const dagBytes = writeJsonDurable(paths.dag, input.dag);
  const patchBytes = writeJsonDurable(paths.patch, {
    revision,
    baseRevision: input.baseRevision,
    by: input.by,
    ops: input.patch.ops,
    ...(input.patch.note ? { note: input.patch.note } : {}),
  });
  let botsSha256: string | undefined;
  if (input.newBots.size > 0) {
    botsSha256 = v3RevisionDigest(writeJsonDurable(paths.bots, Object.fromEntries(input.newBots)));
  }
  return {
    sha256: v3RevisionDigest(dagBytes),
    patchSha256: v3RevisionDigest(patchBytes),
    ...(botsSha256 ? { botsSha256 } : {}),
  };
}

function cardView(
  revision: number,
  baseRevision: number,
  plan: V3RevisionPlan,
  reasons: V3RevisionConfirmReason[],
  note: string | undefined,
  proposedBy: string,
): V3RevisionCardView {
  return {
    revision,
    baseRevision,
    summary: plan.summary,
    ...(note ? { note } : {}),
    reasons,
    changes: plan.changes,
    proposedBy,
  };
}

function voidGateWaits(runDir: string, effects: V3RevisionEffects | undefined): V3VoidedGate[] {
  const out: V3VoidedGate[] = [];
  for (const item of effects?.supersede ?? []) {
    if (!item.waitId) continue;
    try {
      const voided = voidWaitOnce(runDir, item.waitId, 'system-flow-revision');
      if (!voided?.changed) continue;
      out.push({
        waitId: item.waitId,
        nodeId: item.nodeId,
        prompt: voided.wait.prompt,
        cardMessageIds: voided.wait.cardMessageIds ?? [],
      });
    } catch {
      // The journal already voided the decision (replay ignores the waitId);
      // a stuck wait file only loses the in-place card freeze.
    }
  }
  return out;
}

function voidProposalWait(
  runDir: string,
  revision: number,
  reason: V3VoidedProposal['reason'],
): V3VoidedProposal | undefined {
  try {
    const settled = settleRevisionWaitOnce(runDir, revision, 'voided', 'system');
    if (!settled?.changed) return undefined;
    return {
      revision,
      reason,
      view: settled.wait.view,
      cardMessageIds: settled.wait.cardMessageIds ?? [],
    };
  } catch {
    return undefined;
  }
}

/**
 * `botmux workflow edit`. Optimistic concurrency: the edit applies only when
 * `baseRevision` is still the effective revision; otherwise nothing changes
 * and the caller re-reads `workflow status`.
 */
export function applyV3RunEdit(input: ApplyV3RunEditInput): V3RunEditOutcome {
  let patch: V3DagPatch;
  try {
    patch = parseV3DagPatch(input.patch);
  } catch (err) {
    return { kind: 'invalid', problems: err instanceof V3DagPatchError ? err.problems : [String(err)] };
  }
  const runDir = runDirFor(input.baseDir, input.runId);
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return { kind: 'rejected', reason: 'missing' };
  let run: LoadedEditableRun;
  try {
    run = loadEditableRun(input.baseDir, input.runId);
  } catch (err) {
    return { kind: 'rejected', reason: 'not-editable', detail: err instanceof Error ? err.message : String(err) };
  }
  const turn = classifyV3RunEditTurn(run.initiatorOpenId, input.caller);
  const actor = input.caller.openId;
  const auto = autoProvenance(input.caller, patch.note);

  type Locked =
    | Exclude<V3RunEditOutcome, { kind: 'applied' | 'proposed' }>
    | {
        kind: 'committed';
        direct: boolean;
        revision: number;
        baseRevision: number;
        plan: V3RevisionPlan;
        reasons: V3RevisionConfirmReason[];
        voidedRevisions: Array<{ revision: number; reason: V3VoidedProposal['reason'] }>;
      };

  const locked = withJournalMutationSync(journalPath, ({ events, append }): Locked => {
    const snap = materialize([...events]);
    if (snap.runStatus !== 'running' && snap.runStatus !== 'blocked') {
      return { kind: 'rejected', reason: 'not-editable', detail: `run is ${snap.runStatus}` };
    }
    const effective = loadEffectiveV3Dag(runDir, run.approvedDag, events);
    if (input.baseRevision !== effective.revision) {
      return { kind: 'conflict', currentRevision: effective.revision };
    }
    const knownBots = knownBotsFor(run.frozenBots, effective.botAdditions);
    const planned = planV3DagRevision({
      dag: effective.dag,
      approvedDag: run.approvedDag,
      events,
      snap,
      patch,
      knownBots,
    });
    if (!planned.ok) return { kind: 'invalid', problems: planned.problems };
    const plan = planned.plan;
    if (!hasChanges(plan.changes)) return { kind: 'invalid', problems: ['the patch changes nothing'] };

    const newBots = new Map<string, BotSnapshot>();
    const problems: string[] = [];
    for (const selector of plan.changes.newBots) {
      try {
        newBots.set(selector, input.resolveNewBotSnapshot(selector));
      } catch (err) {
        problems.push(`bot "${selector}" cannot run workflow nodes: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (problems.length > 0) return { kind: 'invalid', problems };

    const reasons: V3RevisionConfirmReason[] = [...plan.reasons];
    if (turn === 'other') reasons.unshift('callerNotInitiator');
    const direct = reasons.length === 0;
    const revision = effective.history.maxRevision + 1;
    const written = writeRevisionFiles(runDir, revision, {
      dag: plan.dag,
      patch,
      baseRevision: effective.revision,
      by: actor,
      newBots,
    });
    const effects = remapAssignTargets(plan.effects, knownBotsFor(knownBots, newBots));
    const pending = effective.history.pending;
    const voidedRevisions: Array<{ revision: number; reason: V3VoidedProposal['reason'] }> = [];
    if (direct) {
      append({
        type: 'dagRevised',
        revision,
        baseRevision: effective.revision,
        ...written,
        summary: plan.summary,
        ...(patch.note ? { note: patch.note } : {}),
        by: actor,
        ...auto,
        ...(Object.keys(effects).length > 0 ? { effects } : {}),
      }, { durable: true });
      for (const edge of plan.edges) append(edge, { durable: true });
      appendRevisionRetries(events, append, plan.retries);
      if (pending) {
        append({
          type: 'dagRevisionRejected',
          revision: pending.revision,
          by: 'system',
          reason: 'stale',
          detail: `revision ${revision} took effect first`,
        }, { durable: true });
        voidedRevisions.push({ revision: pending.revision, reason: 'stale' });
      }
    } else {
      if (pending) {
        append({
          type: 'dagRevisionRejected',
          revision: pending.revision,
          by: 'system',
          reason: 'superseded',
          detail: `replaced by proposal ${revision}`,
        }, { durable: true });
        voidedRevisions.push({ revision: pending.revision, reason: 'superseded' });
      }
      append({
        type: 'dagRevisionProposed',
        revision,
        baseRevision: effective.revision,
        ...written,
        summary: plan.summary,
        ...(patch.note ? { note: patch.note } : {}),
        by: actor,
        ...auto,
        reasons,
        touched: plan.touched,
      }, { durable: true });
    }
    return { kind: 'committed', direct, revision, baseRevision: effective.revision, plan, reasons, voidedRevisions };
  });

  if (locked.kind !== 'committed') return locked;
  const voidedProposals = locked.voidedRevisions
    .map((item) => voidProposalWait(runDir, item.revision, item.reason))
    .filter((item): item is V3VoidedProposal => !!item);
  if (locked.direct) {
    return {
      kind: 'applied',
      revision: locked.revision,
      summary: locked.plan.summary,
      changes: locked.plan.changes,
      voidedGates: voidGateWaits(runDir, locked.plan.effects),
      voidedProposals,
    };
  }
  const view = cardView(
    locked.revision,
    locked.baseRevision,
    locked.plan,
    locked.reasons,
    patch.note,
    actor,
  );
  // The journal already holds the proposal; a crash before this wait exists
  // is healed by cold attach (it recreates the wait and re-posts the card).
  writeRevisionWait(runDir, {
    runId: input.runId,
    revision: locked.revision,
    status: 'pending',
    ...(run.initiatorOpenId ? { initiatorOpenId: run.initiatorOpenId } : {}),
    view,
    createdAt: Date.now(),
  });
  return {
    kind: 'proposed',
    revision: locked.revision,
    summary: locked.plan.summary,
    reasons: locked.reasons,
    view,
    ...(run.binding ? { binding: run.binding } : {}),
    voidedProposals,
  };
}

/** The patch file pins the ops plus provenance; only `{ ops, note }` is the
 *  patch itself. */
function parsePinnedPatch(bytes: Buffer): V3DagPatch {
  const raw = JSON.parse(bytes.toString('utf-8')) as { ops?: unknown; note?: unknown };
  return parseV3DagPatch({ ops: raw.ops, ...(raw.note !== undefined ? { note: raw.note } : {}) });
}

// ─── Initiator decision on a proposal ─────────────────────────────────────

export type V3RevisionDecisionOutcome =
  | { kind: 'approved'; revision: number; voidedGates: V3VoidedGate[]; view?: V3RevisionCardView }
  | { kind: 'rejected'; revision: number; view?: V3RevisionCardView }
  | { kind: 'stale'; revision: number; detail: string; view?: V3RevisionCardView }
  | { kind: 'already-decided'; revision: number; status: V3RevisionWaitStatus; view?: V3RevisionCardView }
  | { kind: 'unauthorized' }
  | { kind: 'missing' };

/** Journal half of a decision: re-validate the pinned patch against the
 *  CURRENT flow and node states, then record the outcome. Idempotent. */
function settleProposalInJournal(
  run: LoadedEditableRun,
  revision: number,
  decision: 'approve' | 'reject',
  by: string,
): { kind: 'approved'; effects?: V3RevisionEffects } | { kind: 'rejected' } | { kind: 'stale'; detail: string } {
  const journalPath = join(run.runDir, 'journal.ndjson');
  return withJournalMutationSync(journalPath, ({ events, append }) => {
    const history = foldV3Revisions(events);
    const record = history.records.find((candidate) => candidate.revision === revision);
    if (!record) return { kind: 'stale', detail: 'proposal is not in the journal' };
    if (record.state === 'applied') return { kind: 'approved', ...(record.effects ? { effects: record.effects } : {}) };
    if (record.state === 'rejected') {
      return record.rejected?.reason === 'rejected'
        ? { kind: 'rejected' }
        : { kind: 'stale', detail: `proposal is ${record.rejected?.reason ?? 'closed'}` };
    }
    const snap = materialize([...events]);
    const stale = (detail: string, reason: 'stale' | 'runEnded' = 'stale') => {
      append({ type: 'dagRevisionRejected', revision, by: 'system', reason, detail }, { durable: true });
      return { kind: 'stale' as const, detail };
    };
    if (snap.runStatus !== 'running' && snap.runStatus !== 'blocked') {
      return stale(`run is ${snap.runStatus}`, 'runEnded');
    }
    if (decision === 'reject') {
      append({ type: 'dagRevisionRejected', revision, by, reason: 'rejected' }, { durable: true });
      return { kind: 'rejected' };
    }
    const replanned = replanProposal(run, record, events, snap);
    if (!replanned.ok) return stale(replanned.detail);
    append({
      type: 'dagRevised',
      revision,
      baseRevision: record.baseRevision,
      sha256: record.sha256,
      patchSha256: record.patchSha256,
      ...(record.botsSha256 ? { botsSha256: record.botsSha256 } : {}),
      summary: record.summary,
      ...(record.note ? { note: record.note } : {}),
      by: record.by,
      ...(record.auto ? { auto: record.auto } : {}),
      approval: { by, proposedBy: record.by },
      ...(Object.keys(replanned.effects).length > 0 ? { effects: replanned.effects } : {}),
    }, { durable: true });
    append({ type: 'dagRevisionApproved', revision, by }, { durable: true });
    for (const edge of replanned.edges) append(edge, { durable: true });
    appendRevisionRetries(events, append, replanned.retries);
    return { kind: 'approved', effects: replanned.effects };
  });
}

/** Re-run the proposal's pinned patch against the flow and node states as
 *  they are NOW. The resulting DAG must be byte-identical to what the
 *  initiator was shown; effects (what to stop/re-gate) are recomputed. */
function replanProposal(
  run: LoadedEditableRun,
  record: V3RevisionRecord,
  events: readonly StoredEvent[],
  snap: V3RunSnapshot,
):
  | { ok: true; effects: V3RevisionEffects; edges: V3RevisionPlan['edges']; retries: V3RevisionPlan['retries'] }
  | { ok: false; detail: string } {
  let effective;
  try {
    effective = loadEffectiveV3Dag(run.runDir, run.approvedDag, events);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  if (effective.revision !== record.baseRevision) {
    return { ok: false, detail: `flow moved to revision ${effective.revision}` };
  }
  const paths = v3RevisionFilePaths(run.runDir, record.revision);
  let patch: V3DagPatch;
  let newBots = new Map<string, BotSnapshot>();
  try {
    const patchBytes = readFileSync(paths.patch);
    if (v3RevisionDigest(patchBytes) !== record.patchSha256) return { ok: false, detail: 'patch file digest mismatch' };
    patch = parsePinnedPatch(patchBytes);
    if (record.botsSha256) {
      const botBytes = readFileSync(paths.bots);
      if (v3RevisionDigest(botBytes) !== record.botsSha256) return { ok: false, detail: 'bot snapshot digest mismatch' };
      newBots = new Map(Object.entries(JSON.parse(botBytes.toString('utf-8')) as Record<string, BotSnapshot>));
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const knownBots = knownBotsFor(run.frozenBots, effective.botAdditions);
  const planned = planV3DagRevision({
    dag: effective.dag,
    approvedDag: run.approvedDag,
    events,
    snap,
    patch,
    knownBots,
  });
  if (!planned.ok) return { ok: false, detail: planned.problems.join('; ') };
  const dagBytes = Buffer.from(`${JSON.stringify(planned.plan.dag, null, 2)}\n`, 'utf-8');
  if (v3RevisionDigest(dagBytes) !== record.sha256) {
    return { ok: false, detail: 'the proposal no longer produces the flow that was shown' };
  }
  try {
    if (readFileSync(paths.dag).equals(dagBytes) === false) return { ok: false, detail: 'revision file changed' };
  } catch {
    return { ok: false, detail: 'revision file is missing' };
  }
  return {
    ok: true,
    effects: remapAssignTargets(planned.plan.effects, knownBotsFor(knownBots, newBots)),
    edges: planned.plan.edges,
    retries: planned.plan.retries,
  };
}

/** The initiator's 同意 / 拒绝. Only the initiator may decide (M2). */
export function decideV3RevisionProposal(input: {
  baseDir: string;
  runId: string;
  revision: number;
  decision: 'approve' | 'reject';
  by: string;
}): V3RevisionDecisionOutcome {
  let run: LoadedEditableRun;
  try {
    run = loadEditableRun(input.baseDir, input.runId);
  } catch {
    return { kind: 'missing' };
  }
  const wait = readV3RevisionWait(run.runDir, input.revision);
  if (!wait) return { kind: 'missing' };
  if (!run.initiatorOpenId || input.by !== run.initiatorOpenId) return { kind: 'unauthorized' };
  const settled = settleRevisionWaitOnce(
    run.runDir,
    input.revision,
    input.decision === 'approve' ? 'approved' : 'rejected',
    input.by,
  );
  if (!settled) return { kind: 'missing' };
  if (!settled.changed) {
    return { kind: 'already-decided', revision: input.revision, status: settled.wait.status, view: settled.wait.view };
  }
  return finishDecision(run, input.revision, input.decision, input.by, settled.wait.view);
}

function finishDecision(
  run: LoadedEditableRun,
  revision: number,
  decision: 'approve' | 'reject',
  by: string,
  view: V3RevisionCardView | undefined,
): V3RevisionDecisionOutcome {
  const result = settleProposalInJournal(run, revision, decision, by);
  if (result.kind === 'approved') {
    return { kind: 'approved', revision, voidedGates: voidGateWaits(run.runDir, result.effects), ...(view ? { view } : {}) };
  }
  if (result.kind === 'rejected') return { kind: 'rejected', revision, ...(view ? { view } : {}) };
  // The wait said approved but the journal refused: keep both sides honest.
  try {
    withFileLockSync(v3RevisionWaitPath(run.runDir, revision), () => {
      const current = readV3RevisionWait(run.runDir, revision);
      if (current) writeRevisionWait(run.runDir, { ...current, status: 'voided' });
    });
  } catch {
    // Display state only.
  }
  return { kind: 'stale', revision, detail: result.detail, ...(view ? { view } : {}) };
}

// ─── Cold attach ──────────────────────────────────────────────────────────

export interface V3RevisionRecovery {
  runId: string;
  runDir: string;
  binding?: RunChatBinding;
  /** Pending proposals whose card should be (re)posted. */
  repost: V3RevisionCardView[];
  /** Proposals voided while the daemon was down (freeze their cards). */
  voided: V3VoidedProposal[];
  /** A decision was healed into the journal → drive the run. */
  resume: boolean;
}

/**
 * Daemon startup: a pending proposal is re-posted like a pending gate; a
 * decision whose wait was written but whose journal half was lost is
 * finished now; a proposal of a run that is no longer running is voided.
 */
export function reconcileV3RevisionProposals(baseDir: string, ownerLarkAppId?: string): V3RevisionRecovery[] {
  if (!existsSync(baseDir)) return [];
  const out: V3RevisionRecovery[] = [];
  for (const runId of readdirSync(baseDir)) {
    if (!isValidRunId(runId)) continue;
    const runDir = join(baseDir, runId);
    try {
      if (!statSync(runDir).isDirectory()) continue;
      const journalPath = join(runDir, 'journal.ndjson');
      if (!existsSync(journalPath)) continue;
      const events = readJournal(journalPath);
      if (!events.some((event) => event.type === 'dagRevisionProposed')) continue;
      const run = loadEditableRun(baseDir, runId);
      if (ownerLarkAppId && run.binding?.larkAppId !== ownerLarkAppId) continue;
      const rec: V3RevisionRecovery = {
        runId,
        runDir,
        ...(run.binding ? { binding: run.binding } : {}),
        repost: [],
        voided: [],
        resume: false,
      };
      const history = foldV3Revisions(events);
      const snap = materialize(events);
      const active = snap.runStatus === 'running' || snap.runStatus === 'blocked';
      for (const record of history.records) {
        if (!record.reasons) continue; // a direct revision, never a proposal
        const wait = readV3RevisionWait(runDir, record.revision);
        if (record.state === 'pending') {
          if (!active) {
            settleProposalInJournal(run, record.revision, 'reject', 'system');
            const voided = voidProposalWait(runDir, record.revision, 'runEnded');
            if (voided) rec.voided.push(voided);
            continue;
          }
          if (!wait) {
            // Crash between the journal proposal and its wait file.
            const view = proposalViewFromJournal(run, record, events, snap);
            writeRevisionWait(runDir, {
              runId,
              revision: record.revision,
              status: 'pending',
              ...(run.initiatorOpenId ? { initiatorOpenId: run.initiatorOpenId } : {}),
              view,
              createdAt: Date.now(),
            });
            rec.repost.push(view);
          } else if (wait.status === 'pending') {
            rec.repost.push(wait.view);
          } else if (wait.status === 'approved' || wait.status === 'rejected') {
            // The click landed but its journal half did not.
            finishDecision(run, record.revision, wait.status === 'approved' ? 'approve' : 'reject', wait.by ?? 'system', wait.view);
            rec.resume = true;
          }
        } else if (wait?.status === 'pending') {
          const voided = voidProposalWait(
            runDir,
            record.revision,
            record.rejected?.reason === 'superseded' ? 'superseded'
              : record.rejected?.reason === 'runEnded' ? 'runEnded' : 'stale',
          );
          if (voided) rec.voided.push(voided);
        }
      }
      if (rec.repost.length > 0 || rec.voided.length > 0 || rec.resume) out.push(rec);
    } catch {
      // One corrupt run must not stop the scan (same posture as gates).
      continue;
    }
  }
  return out;
}

function proposalViewFromJournal(
  run: LoadedEditableRun,
  record: V3RevisionRecord,
  events: readonly StoredEvent[],
  snap: V3RunSnapshot,
): V3RevisionCardView {
  const fallback: V3RevisionCardView = {
    revision: record.revision,
    baseRevision: record.baseRevision,
    summary: record.summary,
    ...(record.note ? { note: record.note } : {}),
    reasons: record.reasons ?? [],
    changes: {
      added: [], removed: [], changed: [], dependsChanged: [], reassigned: [], rerun: [],
      newBots: [], hostNodes: [], gateChanges: [],
    },
    proposedBy: record.by,
  };
  try {
    const effective = loadEffectiveV3Dag(run.runDir, run.approvedDag, events);
    const patchBytes = readFileSync(v3RevisionFilePaths(run.runDir, record.revision).patch);
    if (v3RevisionDigest(patchBytes) !== record.patchSha256) return fallback;
    const planned = planV3DagRevision({
      dag: effective.dag,
      approvedDag: run.approvedDag,
      events,
      snap,
      patch: parsePinnedPatch(patchBytes),
      knownBots: knownBotsFor(run.frozenBots, effective.botAdditions),
    });
    return planned.ok ? { ...fallback, changes: planned.plan.changes } : fallback;
  } catch {
    return fallback;
  }
}

/** Should the daemon re-drive after an edit/decision? Only a running run has
 *  anything new to schedule; re-driving a blocked run would just re-announce
 *  its blocked card (a revision that reopens it makes it running again). */
export function v3RunNeedsDriveAfterRevision(baseDir: string, runId: string): boolean {
  try {
    const journalPath = join(runDirFor(baseDir, runId), 'journal.ndjson');
    const status = materialize(readJournal(journalPath)).runStatus;
    return status === 'running' || status === 'cancelling';
  } catch {
    return true;
  }
}

// ─── Status (`botmux workflow status`) ────────────────────────────────────

export interface V3RunStatusNode {
  id: string;
  type: 'goal' | 'host' | 'loop';
  status: string;
  depends: string[];
  goal?: string;
  bot?: { selector?: string; larkAppId?: string };
  executor?: string;
  humanGate?: boolean;
  instanceId?: string;
  attemptId?: string;
  /** Work attempts dispatched for this node across all its instances. */
  attempts: number;
  /** Revision the current attempt was dispatched under. */
  dispatchedUnderRevision?: number;
  loop?: { iteration: number; maxIterations: number; granted: number };
}

export interface V3RunStatusView {
  runId: string;
  runStatus: V3RunSnapshot['runStatus'];
  blockedNodeId?: string;
  failedNodeId?: string;
  /** Pass this as `--base` to `botmux workflow edit`. */
  revision: number;
  nodeExecutor?: 'bot';
  initiatorOpenId?: string;
  nodes: V3RunStatusNode[];
  pendingProposal?: {
    revision: number;
    baseRevision: number;
    summary: string;
    note?: string;
    reasons: V3RevisionConfirmReason[];
    touched: string[];
    by: string;
  };
  history: Array<{
    revision: number;
    state: V3RevisionRecord['state'];
    summary: string;
    note?: string;
    by: string;
    /** Set when the main bot made the change on its own. */
    auto?: V3RevisionRecord['auto'];
    at: number;
    approvedBy?: string;
    rejected?: V3RevisionRecord['rejected'];
  }>;
}

export function projectV3RunStatus(baseDir: string, runId: string): V3RunStatusView {
  const run = loadEditableRun(baseDir, runId);
  const journalPath = join(run.runDir, 'journal.ndjson');
  const events = existsSync(journalPath) ? readJournal(journalPath) : [];
  const snap = materialize(events);
  const effective = loadEffectiveV3Dag(run.runDir, run.approvedDag, events);
  const bots = knownBotsFor(run.frozenBots, effective.botAdditions);
  const attemptCounts = new Map<string, number>();
  const dispatchRevision = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'nodeDispatched' && event.type !== 'hostEffectIntent') continue;
    attemptCounts.set(event.nodeId, (attemptCounts.get(event.nodeId) ?? 0) + 1);
    if (event.type === 'nodeDispatched') dispatchRevision.set(event.attemptId, event.revision ?? 1);
  }
  const nodes: V3RunStatusNode[] = effective.dag.nodes.map((node) => {
    const state = snap.nodes.get(node.id);
    const instanceId = state?.effectiveInstanceId;
    const attemptId = snap.attempts.get(instanceId ?? node.id);
    const bot = isGoalNode(node) || isLoopNode(node) ? snapshotForSelector(bots, node.bot) : undefined;
    const loopState = snap.loops.get(node.id);
    return {
      id: node.id,
      type: node.type,
      status: state?.status ?? 'pending',
      depends: node.depends.map((dep) => dep.from),
      ...(node.goal ? { goal: node.goal } : {}),
      ...(bot || node.bot ? { bot: { ...(node.bot ? { selector: node.bot } : {}), ...(bot ? { larkAppId: bot.larkAppId } : {}) } } : {}),
      ...(isHostNode(node) ? { executor: node.executor } : {}),
      ...(node.humanGate ? { humanGate: true } : {}),
      ...(instanceId ? { instanceId } : {}),
      ...(attemptId ? { attemptId } : {}),
      attempts: attemptCounts.get(node.id) ?? 0,
      ...(attemptId && dispatchRevision.has(attemptId) ? { dispatchedUnderRevision: dispatchRevision.get(attemptId) } : {}),
      ...(isLoopNode(node)
        ? { loop: { iteration: loopState?.iteration ?? 0, maxIterations: node.maxIterations, granted: loopState?.granted ?? 0 } }
        : {}),
    };
  });
  const pending = effective.history.pending;
  const nodeExecutor = 'nodeExecutor' in run.envelope ? run.envelope.nodeExecutor : undefined;
  return {
    runId,
    runStatus: snap.runStatus,
    ...(snap.blockedNodeId ? { blockedNodeId: snap.blockedNodeId } : {}),
    ...(snap.failedNodeId ? { failedNodeId: snap.failedNodeId } : {}),
    revision: effective.revision,
    ...(nodeExecutor ? { nodeExecutor } : {}),
    ...(run.initiatorOpenId ? { initiatorOpenId: run.initiatorOpenId } : {}),
    nodes,
    ...(pending
      ? {
          pendingProposal: {
            revision: pending.revision,
            baseRevision: pending.baseRevision,
            summary: pending.summary,
            ...(pending.note ? { note: pending.note } : {}),
            reasons: pending.reasons ?? [],
            touched: pending.touched ?? [],
            by: pending.by,
          },
        }
      : {}),
    history: effective.history.records.map((record) => ({
      revision: record.revision,
      state: record.state,
      summary: record.summary,
      ...(record.note ? { note: record.note } : {}),
      by: record.by,
      ...(record.auto ? { auto: record.auto } : {}),
      at: record.appliedAt ?? record.ts,
      ...(record.approvedBy ? { approvedBy: record.approvedBy } : {}),
      ...(record.rejected ? { rejected: record.rejected } : {}),
    })),
  };
}

/** Human-readable `workflow status` (the JSON form is `--json`). */
export function formatV3RunStatus(view: V3RunStatusView): string {
  const lines: string[] = [];
  lines.push(`run ${view.runId} · ${view.runStatus} · 第 ${view.revision} 版（edit 用 --base ${view.revision}）`);
  if (view.blockedNodeId) lines.push(`受阻节点：${view.blockedNodeId}`);
  if (view.failedNodeId) lines.push(`失败节点：${view.failedNodeId}`);
  lines.push('节点：');
  for (const node of view.nodes) {
    const bot = node.bot?.larkAppId ?? node.bot?.selector;
    const parts = [
      `  - ${node.id} [${node.type}] ${node.status}`,
      node.depends.length ? `← ${node.depends.join(', ')}` : '',
      bot ? `bot=${bot}` : '',
      node.executor ? `executor=${node.executor}` : '',
      node.humanGate ? 'gate' : '',
      `attempts=${node.attempts}`,
      node.dispatchedUnderRevision && node.dispatchedUnderRevision > 1 ? `派发于第 ${node.dispatchedUnderRevision} 版` : '',
      node.loop ? `loop ${node.loop.iteration}/${node.loop.maxIterations + node.loop.granted}` : '',
    ].filter(Boolean);
    lines.push(parts.join(' '));
  }
  if (view.pendingProposal) {
    const p = view.pendingProposal;
    lines.push(`待确认修改：第 ${p.revision} 版（基于第 ${p.baseRevision} 版）${p.summary} · 原因 ${p.reasons.join(', ')} · 暂停派发 ${p.touched.join(', ') || '无'}`);
  }
  const history = view.history.filter((item) => item.revision > 1);
  if (history.length > 0) {
    lines.push('修改历史：');
    for (const item of history) {
      lines.push(`  - 第 ${item.revision} 版 ${item.state}${item.approvedBy ? '（已确认）' : ''} · ${item.summary}${item.note ? ` · ${item.note}` : ''} · by ${item.auto ? 'main_bot' : item.by}`);
    }
  }
  return lines.join('\n');
}
