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
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import { isGoalNode, isHostNode, isLoopNode, type V3Dag } from './dag.js';
import type { BotSnapshot } from './contract.js';
import {
  foldV3Revisions,
  appendMissingV3RevisionFollowUps,
  loadEffectiveV3Dag,
  v3ApprovedBotScope,
  parseV3DagPatch,
  planV3DagRevision,
  missingV3RevisionFollowUps,
  snapshotForSelector,
  v3CurrentExecutorApp,
  v3RevisionFollowUps,
  v3RevisionInvolvedNodes,
  v3RevisionDigest,
  v3RevisionFilePaths,
  V3_DAG_REVISIONS_DIR,
  V3DagPatchError,
  V3_DAG_PATCH_NOTE_MAX,
  type V3DagPatch,
  type V3RerunBudgetBlock,
  v3RevisitBudgetEpoch,
  type V3RevisionChanges,
  type V3RevisionPlan,
  type V3RevisionRecord,
} from './dag-revision.js';
import type {
  StoredEvent,
  V3RevisionConfirmReason,
  V3RevisionEffects,
} from './event-contract.js';
import { readJournal, withJournalMutationSync } from './journal.js';
import { revisitBudgetStatus } from './core-control.js';
import { materialize, type V3RunSnapshot } from './state.js';
import { loadAuthorizedV3Run, type V3RunEnvelope } from './run-envelope.js';
import { parseFrozenBotSnapshots } from './bot-resolve.js';
import { voidWaitOnce } from './gate-wait-store.js';
import { isValidRunId } from './ops-projection.js';
import type { RunChatBinding } from './grill-state.js';
import { resolveV3RunInitiator, type V3RunEditTurnOrigin } from './cli-daemon-command-authority.js';
import { v3ReasonRequiredProblem } from './action-provenance.js';

// ─── Who may change the flow directly (M1) ────────────────────────────────

export { resolveV3RunInitiator };

export interface V3RunEditCaller {
  /** Authenticated human of the current turn. */
  openId: string;
  origin: V3RunEditTurnOrigin;
  /** The CLI runs inside a `workflow-event:` turn: `--reason` is required
   *  (design §13.6, see `v3ReasonRequiredProblem`). */
  wakeTurn?: boolean;
}

export type V3RunEditTurnClass = 'initiator' | 'runEvent' | 'other';

/** M1: only the initiator's own turns and turns this run's events woke may
 *  change the flow directly; every other turn's edit becomes a proposal. */
/**
 * M2 乙: which of a plan's §13.5 reasons still need the initiator's card in
 * this turn. The initiator's own turn applies everything directly except an
 * external action (host node); a turn the main bot opened for the run's own
 * events keeps the whole list; anyone else's turn always proposes.
 */
export function v3ConfirmReasonsForTurn(
  turn: V3RunEditTurnClass,
  planReasons: readonly V3RevisionConfirmReason[],
): V3RevisionConfirmReason[] {
  if (turn === 'initiator') return planReasons.filter((reason) => reason === 'hostNode');
  if (turn === 'other') return ['callerNotInitiator', ...planReasons];
  return [...planReasons];
}

export function classifyV3RunEditTurn(
  initiatorOpenId: string | undefined,
  caller: V3RunEditCaller,
): V3RunEditTurnClass {
  if (caller.origin === 'runEvent') return 'runEvent';
  if (initiatorOpenId && caller.openId === initiatorOpenId) return 'initiator';
  return 'other';
}

/** Operator recorded on a revision: `main_bot` for a change the main bot
 *  made on its own in an event-woken turn, otherwise the turn's open_id. */
export function v3RevisionActor(caller: V3RunEditCaller): string {
  return caller.origin === 'runEvent' ? 'main_bot' : caller.openId;
}

/** Why the main bot acted (§13.6): its `--reason` — mandatory in a wake
 *  turn — else, for a turn that may leave it out (a scheduled turn), the
 *  edit's note, possibly empty. */
function autoProvenance(caller: V3RunEditCaller, note: string | undefined, reason: string | undefined): { auto?: { reason: string } } {
  return caller.origin === 'runEvent' ? { auto: { reason: reason ?? note ?? '' } } : {};
}

function autoOf(value: { auto?: { reason: string } }): { auto?: { reason: string } } {
  return value.auto ? { auto: value.auto } : {};
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
  /** Voided because a direct revision took effect first, but carried onto it
   *  unchanged as this revision: a decision on this one goes there. */
  carriedTo?: number;
  /** Why a voided wait was voided (what its frozen card says). */
  voidReason?: V3VoidedProposal['reason'];
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
  extra: Pick<V3RevisionWait, 'carriedTo' | 'voidReason'> = {},
): { wait: V3RevisionWait; changed: boolean } | undefined {
  const path = v3RevisionWaitPath(runDir, revision);
  if (!existsSync(path)) return undefined;
  return withFileLockSync(path, () => {
    const wait = readV3RevisionWait(runDir, revision);
    if (!wait) return undefined;
    if (wait.status !== 'pending') return { wait, changed: false };
    const next: V3RevisionWait = { ...wait, status, resolvedAt: Date.now(), by, ...extra };
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

// ─── Edit ─────────────────────────────────────────────────────────────────

export interface V3VoidedGate {
  waitId: string;
  nodeId: string;
  prompt: string;
  cardMessageIds: string[];
}

/** Why a direct revision voided a pending proposal instead of carrying it:
 *  `overlap` — the two involve the same nodes; `notApplicable` — on the new
 *  version its patch no longer applies (e.g. a budget the direct revision
 *  spent); `meaningChanged` — it would now change something else or need
 *  other confirmation reasons than its card shows; `carryFailed` — carrying
 *  it could not be recorded. */
export type V3ProposalVoidCause = 'overlap' | 'notApplicable' | 'meaningChanged' | 'carryFailed';

export interface V3VoidedProposal {
  revision: number;
  reason: 'stale' | 'superseded' | 'runEnded';
  /** Set when a direct revision voided it (reason `stale`). */
  cause?: V3ProposalVoidCause;
  view?: V3RevisionCardView;
  cardMessageIds: string[];
}

/** A pending proposal a direct revision did not overlap: it keeps waiting,
 *  re-based onto that revision under the next number. Its card moves along:
 *  `cardMessageIds` are the old card's messages to show `view` in place
 *  (empty: post a new card). */
export interface V3CarriedProposal {
  fromRevision: number;
  revision: number;
  view: V3RevisionCardView;
  cardMessageIds: string[];
}

export type V3RunEditOutcome =
  | {
      kind: 'applied';
      revision: number;
      summary: string;
      changes: V3RevisionChanges;
      voidedGates: V3VoidedGate[];
      /** Pending proposals this revision overlapped: no longer valid. */
      voidedProposals: V3VoidedProposal[];
      carriedProposals: V3CarriedProposal[];
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
  | { kind: 'invalid'; problems: string[]; rerunBudget?: V3RerunBudgetBlock }
  | { kind: 'rejected'; reason: 'missing' | 'not-editable' | 'proposal-pending'; detail?: string };

export interface ApplyV3RunEditInput {
  baseDir: string;
  runId: string;
  /** Untrusted patch JSON (parsed here). */
  patch: unknown;
  baseRevision: number;
  caller: V3RunEditCaller;
  /** `--reason`: why the change is made. Required in a wake turn; in a human
   *  turn it stands in for the patch's `note` when that is absent. */
  reason?: string;
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
  // Changed (supersede) and deleted (cancel) gated nodes both void their wait.
  for (const item of [...(effects?.supersede ?? []), ...(effects?.cancel ?? [])]) {
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
  cause?: V3ProposalVoidCause,
): V3VoidedProposal | undefined {
  try {
    const settled = settleRevisionWaitOnce(runDir, revision, 'voided', 'system', { voidReason: reason });
    if (!settled?.changed) return undefined;
    return {
      revision,
      reason,
      ...(cause ? { cause } : {}),
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
  const reason = input.reason?.trim() || undefined;
  const missingReason = v3ReasonRequiredProblem(input.caller, reason);
  if (missingReason) return { kind: 'invalid', problems: [missingReason] };
  // A human turn's reason is its note when the patch has none (display only).
  if (input.caller.origin === 'human' && reason && !patch.note) {
    patch = { ...patch, note: reason.slice(0, V3_DAG_PATCH_NOTE_MAX) };
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
  if (!run.initiatorOpenId) {
    // Nobody could ever confirm a proposal here, and its touched nodes would
    // pause forever: refuse runtime edits outright.
    return {
      kind: 'rejected',
      reason: 'not-editable',
      detail: '该 run 没有已认证的发起人，无法确认运行中的修改',
    };
  }
  const turn = classifyV3RunEditTurn(run.initiatorOpenId, input.caller);
  const actor = v3RevisionActor(input.caller);
  const auto = autoProvenance(input.caller, patch.note, reason);

  type Locked =
    | Exclude<V3RunEditOutcome, { kind: 'applied' | 'proposed' }>
    | {
        kind: 'committed';
        direct: boolean;
        revision: number;
        baseRevision: number;
        plan: V3RevisionPlan;
        reasons: V3RevisionConfirmReason[];
        voidedRevisions: Array<{ revision: number; reason: V3VoidedProposal['reason']; cause?: V3ProposalVoidCause }>;
        carried: CarriedInJournal[];
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
    const knownBots = v3ApprovedBotScope(run.frozenBots, effective.botAdditions);
    const planned = planV3DagRevision({
      dag: effective.dag,
      approvedDag: run.approvedDag,
      events,
      snap,
      patch,
      knownBots,
      // The initiator's own edit lifts a spent rerun budget itself (M2 乙).
      liftSpentRerunBudget: turn === 'initiator',
    });
    if (!planned.ok) {
      return { kind: 'invalid', problems: planned.problems, ...(planned.rerunBudget ? { rerunBudget: planned.rerunBudget } : {}) };
    }
    const plan = planned.plan;
    if (!hasChanges(plan.changes)) return { kind: 'invalid', problems: ['the patch changes nothing'] };
    const reasons = v3ConfirmReasonsForTurn(turn, plan.reasons);
    const direct = reasons.length === 0;
    if (!direct && plan.budgetGrants.length > 0) {
      // Only a change that takes effect now lifts the budget; one that waits
      // for the card goes through the grant card like any other.
      const spent = plan.budgetGrants[0]!;
      return {
        kind: 'invalid',
        problems: [`ops rerunNode: 节点 "${spent.nodeId}" 的重做额度已用完；这次修改需要发起人确认，请先在「追加重做额度」卡上追加后再提交`],
        rerunBudget: { ...spent, epoch: v3RevisitBudgetEpoch(events, spent.nodeId, spent.tier) },
      };
    }

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

    // Only the initiator (or a turn acting for them) may replace a pending
    // proposal; another member's proposal must not void it.
    if (!direct && turn === 'other' && effective.history.pending) {
      return {
        kind: 'rejected',
        reason: 'proposal-pending',
        detail: `已有待确认的修改（第 ${effective.history.pending.revision} 版），请等发起人处理后再提`,
      };
    }
    const revision = effective.history.maxRevision + 1;
    const written = writeRevisionFiles(runDir, revision, {
      dag: plan.dag,
      patch,
      baseRevision: effective.revision,
      by: actor,
      newBots,
    });
    const effects = remapAssignTargets(plan.effects, v3ApprovedBotScope(knownBots, newBots));
    const pending = effective.history.pending;
    const voidedRevisions: Array<{ revision: number; reason: V3VoidedProposal['reason']; cause?: V3ProposalVoidCause }> = [];
    const carried: CarriedInJournal[] = [];
    if (direct) {
      const appended: StoredEvent[] = [];
      const record = (event: Parameters<typeof append>[0]): void => {
        appended.push(append(event, { durable: true }));
      };
      // Rerun budget the initiator's own edit lifted travels in the
      // revision's own effects (`budgetGrants`, no grant card): one line, so
      // a crash never leaves a lift without the revision that made it.
      record({
        type: 'dagRevised',
        revision,
        baseRevision: effective.revision,
        ...written,
        summary: plan.summary,
        ...(patch.note ? { note: patch.note } : {}),
        by: actor,
        ...auto,
        ...(Object.keys(effects).length > 0 ? { effects } : {}),
      });
      for (const edge of plan.edges) record(edge);
      // Reassign / blocked re-run advance state through their dedicated
      // events, in this same lock (design §13.3).
      for (const followUp of v3RevisionFollowUps(events, {
        retry: effects.retry,
        assign: effects.assign,
        by: actor,
        ...autoOf(auto),
      })) record(followUp);
      if (pending) {
        // A pending proposal this revision does not overlap keeps waiting:
        // re-based onto it under the next number, in this same lock (its
        // touched nodes stay held without a gap). One it overlaps — or that
        // no longer means exactly what its card showed — is void.
        const next = revision + 1;
        let carry: ReturnType<typeof carryPendingProposal> = { ok: false, cause: 'carryFailed' };
        let carriedWritten: WrittenRevision | undefined;
        try {
          carry = carryPendingProposal({
            run,
            pending,
            before: { events, snap, effective, knownBots },
            direct: { plan, revision, events: [...events, ...appended], knownBots: v3ApprovedBotScope(knownBots, newBots) },
          });
          if (carry.ok) {
            carriedWritten = writeRevisionFiles(runDir, next, {
              dag: carry.plan.dag,
              patch: carry.patch,
              baseRevision: revision,
              by: pending.by,
              newBots: carry.newBots,
            });
          }
        } catch {
          // The direct revision is already journaled: a carry that cannot
          // be prepared falls back to voiding the proposal, never to failing.
          carry = { ok: false, cause: 'carryFailed' };
        }
        if (carry.ok && carriedWritten) {
          // One line: the new proposal supersedes the old one as it lands
          // (the fold marks the earlier pending proposal superseded), so a
          // crash can never leave the old one closed without its successor.
          append({
            type: 'dagRevisionProposed',
            revision: next,
            baseRevision: revision,
            ...carriedWritten,
            summary: carry.plan.summary,
            ...(pending.note ? { note: pending.note } : {}),
            by: pending.by,
            ...(pending.auto ? { auto: pending.auto } : {}),
            reasons: [...(pending.reasons ?? [])],
            touched: carry.plan.touched,
            carriedFrom: pending.revision,
          }, { durable: true });
          carried.push({
            fromRevision: pending.revision,
            revision: next,
            view: cardView(next, revision, carry.plan, [...(pending.reasons ?? [])], pending.note, pending.by),
          });
        } else {
          append({
            type: 'dagRevisionRejected',
            revision: pending.revision,
            by: 'system',
            reason: 'stale',
            detail: `revision ${revision} took effect first (${carry.ok ? 'carryFailed' : carry.cause})`,
          }, { durable: true });
          voidedRevisions.push({ revision: pending.revision, reason: 'stale', cause: carry.ok ? 'carryFailed' : carry.cause });
        }
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
    return { kind: 'committed', direct, revision, baseRevision: effective.revision, plan, reasons, voidedRevisions, carried };
  });

  if (locked.kind !== 'committed') return locked;
  // Every voided proposal is listed (so the caller can say why), with its
  // card only when this call is the one that voided its wait.
  const voidedProposals: V3VoidedProposal[] = locked.voidedRevisions.map((item) =>
    voidProposalWait(runDir, item.revision, item.reason, item.cause) ?? {
      revision: item.revision,
      reason: item.reason,
      ...(item.cause ? { cause: item.cause } : {}),
      cardMessageIds: [],
    });
  if (locked.direct) {
    const carriedProposals: V3CarriedProposal[] = [];
    for (const item of locked.carried) {
      const moved = moveProposalWait(runDir, input.runId, run, item);
      if (moved.kind === 'carried') carriedProposals.push(moved.carried);
      else voidedProposals.push(moved.voided);
    }
    return {
      kind: 'applied',
      revision: locked.revision,
      summary: locked.plan.summary,
      changes: locked.plan.changes,
      voidedGates: voidGateWaits(runDir, locked.plan.effects),
      voidedProposals,
      carriedProposals,
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

/** A proposal the journal carried onto a direct revision (see
 *  {@link carryPendingProposal}); its wait moves after the lock. */
interface CarriedInJournal {
  fromRevision: number;
  revision: number;
  view: V3RevisionCardView;
}

/** The turn class a proposal was filed in, read back from who filed it. */
function proposalTurnClass(by: string, initiatorOpenId: string | undefined): V3RunEditTurnClass {
  if (by === 'main_bot') return 'runEvent';
  return initiatorOpenId !== undefined && by === initiatorOpenId ? 'initiator' : 'other';
}

function dagFileBytes(dag: V3Dag): Buffer {
  return Buffer.from(`${JSON.stringify(dag, null, 2)}\n`, 'utf-8');
}

function sameReasons(a: readonly V3RevisionConfirmReason[], b: readonly V3RevisionConfirmReason[]): boolean {
  return a.length === b.length && a.every((reason) => b.includes(reason));
}

/**
 * Inside the journal lock, right after a direct revision was appended: may
 * the pending proposal keep waiting on top of it? Only when the two involve
 * disjoint nodes ({@link v3RevisionInvolvedNodes}) and the proposal, re-based
 * onto the new flow, still means exactly what its card shows — the same
 * changes and the same confirmation reasons for the turn that filed it.
 * Anything else voids it, as before.
 */
function carryPendingProposal(input: {
  run: LoadedEditableRun;
  pending: V3RevisionRecord;
  /** The flow and journal the proposal was filed against. */
  before: {
    events: readonly StoredEvent[];
    snap: V3RunSnapshot;
    effective: { dag: V3Dag };
    knownBots: ReadonlyMap<string, BotSnapshot>;
  };
  /** The direct revision just appended, and the journal including it. */
  direct: {
    plan: V3RevisionPlan;
    revision: number;
    events: readonly StoredEvent[];
    knownBots: ReadonlyMap<string, BotSnapshot>;
  };
}):
  | { ok: true; plan: V3RevisionPlan; patch: V3DagPatch; newBots: Map<string, BotSnapshot> }
  | { ok: false; cause: V3ProposalVoidCause } {
  const { run, pending, before, direct } = input;
  const pinned = readPinnedProposal(run, pending);
  if (!pinned.ok) return { ok: false, cause: 'carryFailed' };
  const shown = planV3DagRevision({
    dag: before.effective.dag,
    approvedDag: run.approvedDag,
    events: before.events,
    snap: before.snap,
    patch: pinned.patch,
    knownBots: before.knownBots,
  });
  if (!shown.ok || v3RevisionDigest(dagFileBytes(shown.plan.dag)) !== pending.sha256) return { ok: false, cause: 'notApplicable' };
  const ours = v3RevisionInvolvedNodes(direct.plan);
  for (const nodeId of v3RevisionInvolvedNodes(shown.plan)) if (ours.has(nodeId)) return { ok: false, cause: 'overlap' };
  const rebased = planV3DagRevision({
    dag: direct.plan.dag,
    approvedDag: run.approvedDag,
    events: direct.events,
    snap: materialize([...direct.events]),
    patch: pinned.patch,
    knownBots: direct.knownBots,
  });
  if (!rebased.ok) return { ok: false, cause: 'notApplicable' };
  const reasons = v3ConfirmReasonsForTurn(proposalTurnClass(pending.by, run.initiatorOpenId), rebased.plan.reasons);
  if (!sameReasons(reasons, pending.reasons ?? [])) return { ok: false, cause: 'meaningChanged' };
  if (JSON.stringify(rebased.plan.changes) !== JSON.stringify(shown.plan.changes)) return { ok: false, cause: 'meaningChanged' };
  return { ok: true, plan: rebased.plan, patch: pinned.patch, newBots: pinned.newBots };
}

/**
 * After the journal carried a proposal (live, right after the lock; or on cold
 * attach, after a crash): the carried revision gets its wait first (kept if a
 * crash left one), then the old wait is voided pointing at it — from then on a
 * decision clicked on the old card is taken for the carried revision. Only
 * when that compare-and-set wins does the carried revision take over the old
 * card's messages (read from the very state the CAS replaced), so its card is
 * shown in place; if a click had already decided the old wait, that card
 * shows the click's outcome and the carried revision gets a card of its own.
 *
 * A carried revision whose wait cannot be written could never be decided (a
 * click on its card would find nothing): it is voided in the journal, and the
 * old wait is voided so its card freezes as void — reported as a voided
 * proposal (`carryFailed`) instead.
 */
function moveProposalWait(
  runDir: string,
  runId: string,
  run: LoadedEditableRun,
  item: CarriedInJournal,
): { kind: 'carried'; carried: V3CarriedProposal } | { kind: 'voided'; voided: V3VoidedProposal } {
  try {
    if (!readV3RevisionWait(runDir, item.revision)) {
      writeRevisionWait(runDir, {
        runId,
        revision: item.revision,
        status: 'pending',
        ...(run.initiatorOpenId ? { initiatorOpenId: run.initiatorOpenId } : {}),
        view: item.view,
        createdAt: Date.now(),
      });
    }
  } catch {
    return { kind: 'voided', voided: abandonCarriedProposal(runDir, item) };
  }
  let inherited: string[] = [];
  try {
    const moved = settleRevisionWaitOnce(runDir, item.fromRevision, 'voided', 'system', {
      carriedTo: item.revision,
      voidReason: 'superseded',
    });
    inherited = moved?.changed ? moved.wait.cardMessageIds ?? [] : [];
    for (const messageId of inherited) recordV3RevisionCardMessage(runDir, item.revision, messageId);
  } catch {
    // The old wait stays as it is: its card stays clickable and a click is
    // refused as stale (its record was superseded); the new card is posted.
  }
  return { kind: 'carried', carried: { ...item, cardMessageIds: inherited } };
}

/** See {@link moveProposalWait}: void a carried revision nobody can decide. */
function abandonCarriedProposal(runDir: string, item: CarriedInJournal): V3VoidedProposal {
  try {
    withJournalMutationSync(join(runDir, 'journal.ndjson'), ({ events, append }) => {
      const record = foldV3Revisions(events).records.find((candidate) => candidate.revision === item.revision);
      if (record?.state !== 'pending') return;
      append({
        type: 'dagRevisionRejected',
        revision: item.revision,
        by: 'system',
        reason: 'stale',
        detail: `carried from revision ${item.fromRevision}, but its wait could not be recorded`,
      }, { durable: true });
    });
  } catch {
    // Cold attach recreates a missing wait for a still-pending proposal.
  }
  return voidProposalWait(runDir, item.fromRevision, 'stale', 'carryFailed') ?? {
    revision: item.fromRevision,
    reason: 'stale',
    cause: 'carryFailed',
    cardMessageIds: [],
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
    for (const followUp of v3RevisionFollowUps(events, {
      retry: replanned.effects.retry,
      assign: replanned.effects.assign,
      by: record.by,
      ...(record.auto ? { auto: record.auto } : {}),
    })) append(followUp, { durable: true });
    return { kind: 'approved', effects: replanned.effects };
  });
}

/** A proposal's pinned patch and new-bot sidecar, digest-verified. */
function readPinnedProposal(
  run: LoadedEditableRun,
  record: Pick<V3RevisionRecord, 'revision' | 'patchSha256' | 'botsSha256'>,
): { ok: true; patch: V3DagPatch; newBots: Map<string, BotSnapshot> } | { ok: false; detail: string } {
  const paths = v3RevisionFilePaths(run.runDir, record.revision);
  try {
    const patchBytes = readFileSync(paths.patch);
    if (v3RevisionDigest(patchBytes) !== record.patchSha256) return { ok: false, detail: 'patch file digest mismatch' };
    const patch = parsePinnedPatch(patchBytes);
    let newBots = new Map<string, BotSnapshot>();
    if (record.botsSha256) {
      const botBytes = readFileSync(paths.bots);
      if (v3RevisionDigest(botBytes) !== record.botsSha256) return { ok: false, detail: 'bot snapshot digest mismatch' };
      newBots = new Map(Object.entries(JSON.parse(botBytes.toString('utf-8')) as Record<string, BotSnapshot>));
    }
    return { ok: true, patch, newBots };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
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
  const pinned = readPinnedProposal(run, record);
  if (!pinned.ok) return pinned;
  const { patch, newBots } = pinned;
  const knownBots = v3ApprovedBotScope(run.frozenBots, effective.botAdditions);
  const planned = planV3DagRevision({
    dag: effective.dag,
    approvedDag: run.approvedDag,
    events,
    snap,
    patch,
    knownBots,
  });
  if (!planned.ok) return { ok: false, detail: planned.problems.join('; ') };
  const dagBytes = dagFileBytes(planned.plan.dag);
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
    effects: remapAssignTargets(planned.plan.effects, v3ApprovedBotScope(knownBots, newBots)),
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
}, hops = 0): V3RevisionDecisionOutcome {
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
    // Carried, unchanged, onto a direct revision that took effect first: the
    // click on the old card is a decision on what it showed, i.e. on the
    // carried revision (bounded: a proposal is carried once per revision).
    if (settled.wait.status === 'voided' && settled.wait.carriedTo !== undefined && hops < 16) {
      return decideV3RevisionProposal({ ...input, revision: settled.wait.carriedTo }, hops + 1);
    }
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
      if (current) writeRevisionWait(run.runDir, { ...current, status: 'voided', voidReason: 'stale' });
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
  /** Carries a crash interrupted, finished now: show each in its old card's
   *  messages (or post a card when there are none). */
  moved: V3CarriedProposal[];
  /** Proposals voided while the daemon was down (freeze their cards). */
  voided: V3VoidedProposal[];
  /** A decision was healed into the journal → drive the run. */
  resume: boolean;
  /** The run owes a revision's lost follow-ups, but its effective flow could
   *  not be loaded, so they were left alone (the caller logs this; proposals
   *  were still reconciled). */
  followUpError?: string;
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
      let events = readJournal(journalPath);
      const hasProposals = events.some((event) => event.type === 'dagRevisionProposed');
      const mayOweFollowUps = missingV3RevisionFollowUps(events).length > 0;
      if (!hasProposals && !mayOweFollowUps) continue;
      const run = loadEditableRun(baseDir, runId);
      if (ownerLarkAppId && run.binding?.larkAppId !== ownerLarkAppId) continue;
      const rec: V3RevisionRecovery = {
        runId,
        runDir,
        ...(run.binding ? { binding: run.binding } : {}),
        repost: [],
        moved: [],
        voided: [],
        resume: false,
      };
      if (mayOweFollowUps) {
        // A revision's reassign / re-run lost its dedicated event to a crash:
        // finish it so the run resumes instead of re-announcing a block. Only
        // nodes of the effective flow are owed anything; if that flow cannot
        // be loaded, leave the follow-ups alone (the drive fails closed on
        // the same error) but still reconcile the proposals below.
        try {
          const effective = loadEffectiveV3Dag(runDir, run.approvedDag, events);
          const result = appendMissingV3RevisionFollowUps(journalPath, {
            revision: effective.revision,
            liveNodeIds: new Set(effective.dag.nodes.map((node) => node.id)),
          });
          if (result.kind === 'stale' || result.count > 0) rec.resume = true;
        } catch (err) {
          rec.followUpError = err instanceof Error ? err.message : String(err);
        }
        events = readJournal(journalPath);
      }
      const history = foldV3Revisions(events);
      const snap = materialize(events);
      const active = snap.runStatus === 'running' || snap.runStatus === 'blocked';
      // A carry the journal holds but whose waits never moved (crash right
      // after its line): the old wait still waits for the move, not a void.
      const unmoved = new Map<number, V3RevisionRecord>();
      if (active) {
        for (const record of history.records) {
          if (record.state !== 'pending' || record.carriedFrom === undefined) continue;
          if (readV3RevisionWait(runDir, record.carriedFrom)?.status === 'pending') unmoved.set(record.carriedFrom, record);
        }
      }
      for (const record of history.records) {
        if (!record.reasons) continue; // a direct revision, never a proposal
        if (unmoved.has(record.revision)) continue; // moved below, with its successor
        const wait = readV3RevisionWait(runDir, record.revision);
        if (record.state === 'pending') {
          if (!active) {
            settleProposalInJournal(run, record.revision, 'reject', 'system');
            const voided = voidProposalWait(runDir, record.revision, 'runEnded');
            if (voided) rec.voided.push(voided);
            continue;
          }
          if (record.carriedFrom !== undefined && (!wait || unmoved.has(record.carriedFrom))) {
            const moved = moveProposalWait(runDir, runId, run, {
              fromRevision: record.carriedFrom,
              revision: record.revision,
              view: wait?.view ?? proposalViewFromJournal(run, record, events, snap),
            });
            if (moved.kind === 'carried') rec.moved.push(moved.carried);
            else rec.voided.push(moved.voided);
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
      if (rec.repost.length > 0 || rec.moved.length > 0 || rec.voided.length > 0 || rec.resume || rec.followUpError) out.push(rec);
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
      knownBots: v3ApprovedBotScope(run.frozenBots, effective.botAdditions),
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
  const bots = v3ApprovedBotScope(run.frozenBots, effective.botAdditions);
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
    // The bot that executes it now (a blocked-card 改派 moves it without
    // touching the definition) — what an edit's reassign is compared with.
    const executorApp = isGoalNode(node) || isLoopNode(node)
      ? v3CurrentExecutorApp(snap, bots, node.id, node.bot)
      : undefined;
    const bot = executorApp ? snapshotForSelector(bots, executorApp) : undefined;
    const selector = executorApp && executorApp !== snapshotForSelector(bots, node.bot)?.larkAppId
      ? [...bots.entries()].find(([, snapshot]) => snapshot.larkAppId === executorApp)?.[0] ?? executorApp
      : node.bot;
    const loopState = snap.loops.get(node.id);
    return {
      id: node.id,
      type: node.type,
      status: state?.status ?? 'pending',
      depends: node.depends.map((dep) => dep.from),
      ...(node.goal ? { goal: node.goal } : {}),
      ...(bot || selector ? { bot: { ...(selector ? { selector } : {}), ...(bot ? { larkAppId: bot.larkAppId } : {}) } } : {}),
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
      lines.push(`  - 第 ${item.revision} 版 ${item.state}${item.approvedBy ? '（已确认）' : ''} · ${item.summary}${item.note ? ` · ${item.note}` : ''} · by ${item.by}`);
    }
  }
  return lines.join('\n');
}

// ─── Rerun budget grant (「追加重做额度」card) ─────────────────────────────

function rerunGrantCardMarkerPath(baseDir: string, runId: string, block: V3RerunBudgetBlock): string {
  return join(runDirFor(baseDir, runId), 'waits', 'rerun-grants', `${block.nodeId}.${block.tier}.${block.epoch}.json`);
}

/** Has a grant card for this exact exhaustion (node, tier, epoch) been posted? */
export function v3RerunGrantCardPosted(baseDir: string, runId: string, block: V3RerunBudgetBlock): boolean {
  return existsSync(rerunGrantCardMarkerPath(baseDir, runId, block));
}

/** In-process: grant cards being posted right now, by (run, node, tier, epoch). */
const rerunGrantCardsInFlight = new Set<string>();

/** Test isolation: forget in-flight posts (a daemon restart does the same). */
export function resetV3RerunGrantCardsInFlight(): void {
  rerunGrantCardsInFlight.clear();
}

export type V3RerunGrantCardPostOutcome = 'posted' | 'already' | 'failed';

/**
 * One grant card per exhaustion. The card is posted FIRST and the marker
 * (with its message id) written after: a crash or a failed post leaves no
 * marker, so the next refusal of the same exhaustion posts again. A crash
 * between the post and the marker can at worst post a second card for the
 * same epoch — harmless, granting is idempotent (`already-granted`).
 * Concurrent refusals inside this process share one post (in-flight key).
 */
export async function postV3RerunGrantCardOnce(input: {
  baseDir: string;
  runId: string;
  block: V3RerunBudgetBlock;
  /** Posts the card; resolves to its message id. */
  post: () => Promise<string | undefined>;
}): Promise<V3RerunGrantCardPostOutcome> {
  const { block } = input;
  const key = `${input.runId}\u0000${block.nodeId}\u0000${block.tier}\u0000${block.epoch}`;
  if (rerunGrantCardsInFlight.has(key) || v3RerunGrantCardPosted(input.baseDir, input.runId, block)) return 'already';
  rerunGrantCardsInFlight.add(key);
  try {
    let messageId: string | undefined;
    try {
      messageId = await input.post();
    } catch {
      return 'failed';
    }
    const runDir = runDirFor(input.baseDir, input.runId);
    ensurePrivateDir(join(runDir, 'waits'));
    ensurePrivateDir(join(runDir, 'waits', 'rerun-grants'));
    try {
      writeFileSync(
        rerunGrantCardMarkerPath(input.baseDir, input.runId, block),
        `${JSON.stringify({ ...block, ...(messageId ? { messageId } : {}), at: Date.now() })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return 'posted';
  } finally {
    rerunGrantCardsInFlight.delete(key);
  }
}

export type V3RerunBudgetGrantOutcome =
  | { kind: 'granted'; tier: 'pair' | 'run' }
  | { kind: 'already-granted' }
  /** The card belongs to an exhaustion the budget has since moved past.
   *  `newerCardPosted`: a card for the current exhaustion is already out. */
  | { kind: 'expired'; newerCardPosted: boolean }
  | { kind: 'unauthorized' }
  | { kind: 'stale'; detail: string }
  | { kind: 'missing' };

/**
 * One more revisit for a `rerunNode` the budget refused. Initiator only.
 * Idempotent: it grants only while the budget for that node is still spent,
 * and grants exactly the tier that is spent now.
 */
export function grantV3RerunBudget(input: {
  baseDir: string;
  runId: string;
  nodeId: string;
  /** Exhaustion the card was posted for: which budget tier, which epoch. */
  tier: 'pair' | 'run';
  epoch: number;
  by: string;
}): V3RerunBudgetGrantOutcome {
  let run: LoadedEditableRun;
  try {
    run = loadEditableRun(input.baseDir, input.runId);
  } catch {
    return { kind: 'missing' };
  }
  if (!run.initiatorOpenId || input.by !== run.initiatorOpenId) return { kind: 'unauthorized' };
  return withJournalMutationSync(join(run.runDir, 'journal.ndjson'), ({ events, append }): V3RerunBudgetGrantOutcome => {
    const status = materialize([...events]).runStatus;
    if (status !== 'running' && status !== 'blocked') return { kind: 'stale', detail: `run is ${status}` };
    const budget = revisitBudgetStatus([...events], input.nodeId, input.nodeId);
    if (budget.ok) return { kind: 'already-granted' };
    const current: V3RerunBudgetBlock = {
      nodeId: input.nodeId, tier: budget.tier, epoch: v3RevisitBudgetEpoch(events, input.nodeId, budget.tier),
    };
    if (current.tier !== input.tier || current.epoch !== input.epoch) {
      return { kind: 'expired', newerCardPosted: v3RerunGrantCardPosted(input.baseDir, input.runId, current) };
    }
    append({
      type: 'revisitBudgetGranted',
      ...(budget.tier === 'pair' ? { sourceNodeId: input.nodeId, toNodeId: input.nodeId } : {}),
      by: input.by,
      reason: 'rerunNode',
    }, { durable: true });
    return { kind: 'granted', tier: budget.tier };
  });
}
