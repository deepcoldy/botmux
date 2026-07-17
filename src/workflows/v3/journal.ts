/**
 * v3 journal — append-only event stream (the run's audit truth).
 *
 * Codex's v1-review blocker #1: v3 is NOT a "only-mutable-STATE" recoverable
 * system.  `journal.ndjson` is the append-only source of audit truth (one JSON
 * object per line, `ts`-stamped) from which `state.ts` materializes the STATE
 * checkpoint.  Concurrency / retry / gate / cancel / failure-root-cause all
 * leave an ordered trail here.
 *
 * Append-only + line-oriented is crash-tolerant only when the next writer
 * repairs an interrupted FINAL line first. Read-only projections may ignore
 * that tail, but appending after it would concatenate two JSON objects and
 * permanently corrupt the history. Every mutation therefore takes the same
 * cross-process journal lock and repairs an unterminated tail before writing
 * the next event.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { fsyncDirectorySyncPortable } from '../../utils/fs-durability.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import type { GoalAsk } from './contract.js';

// ─── Event taxonomy ─────────────────────────────────────────────────────────

/** Why a node failed — drives fail-fast root-cause reporting + retry policy
 *  (`classifyTerminal` maps each class to `blocked` or `failed`).
 *  `gateRejected` / `cancelled` are user-driven; the rest are faults. */
export type V3ErrorClass =
  | 'workerError'      // ephemeral worker crashed / non-zero exit
  | 'manifestInvalid'  // worker exited ok but manifest failed validation
  | 'resultInvalid'    // result.json missing / unparsable / fails the node's resultSchema
  | 'timeout'          // node exceeded its wall-clock budget
  | 'gateRejected'     // human rejected the approval gate
  | 'cancelled';       // run cancelled out from under the node

export type V3RunFailureReason = 'allSinksSkipped';

/** Bounded, privacy-safe identity for an external effect whose final provider
 *  outcome cannot be proved. Full inputs/errors stay in the protected attempt
 *  artifacts and logs; terminal cards only need this machine-readable tuple. */
export interface V3UncertainHostEffect {
  nodeId: string;
  instanceId: string;
  attemptId: string;
  executor: string;
  errorCode: string;
}

/**
 * The MVP event union.  Static DAG + fail-fast, so the lifecycle is small:
 * run boundaries, per-node dispatch/settle, and gate dispatch/resolve.  Retry
 * (`attempts/NNN`) is modeled by `attemptId` on dispatch/settle events — a new
 * attempt is just another `nodeDispatched` with a fresh `attemptId`.
 */
/**
 * Structured loop reference carried on body-instance dispatches.  The expanded
 * nodeId (`repairLoop.i001.code`) is an OPAQUE key — projections/dashboards
 * group by THIS field and never parse the id string (body ids may themselves
 * contain dots).
 */
export interface V3LoopRef {
  loopId: string;
  iteration: number;
  bodyNodeId: string;
}

export type V3Event =
  | { type: 'runStarted'; runId: string }
  // `instanceId` (`A#001`) identifies the RUNTIME instance of definition node
  // `nodeId`.  A cross-node revisit supersedes an instance and the node gets a
  // fresh one (`A#002`); `attemptId` is a try WITHIN an instance
  // (`A#001/attempts/002`, from a blocked / human-ask retry).  Optional for
  // back-compat: pre-instance-layer events and loop body expansions (which
  // carry their own expanded nodeId) omit it, and consumers fall back to
  // nodeId-keyed behavior (instance restoration design 2026-06-08).
  | { type: 'nodeDispatched'; nodeId: string; instanceId?: string; attemptId: string; loop?: V3LoopRef }
  // Host preparation is NOT a dispatch and carries no claim that a provider
  // call began. It freezes the exact parsed input before a runtime gate. The
  // host rail intentionally never emits nodeDispatched/worker-fence events.
  | {
      type: 'hostInputPrepared';
      nodeId: string;
      instanceId: string;
      attemptId: string;
      executor: string;
      provider: string;
      inputRef: { path: string; sha256: string; bytes: number };
      inputHash: string;
      idempotencyKey: string;
      idempotencyTtlMs: number;
      approvalDigest: string;
    }
  // The linearization boundary for an external side effect. Durable BEFORE
  // provider invocation; recovery of an open intent must use this exact
  // attempt/key/input and must never mint a generic orphan retry.
  | {
      type: 'hostEffectIntent';
      nodeId: string;
      instanceId: string;
      attemptId: string;
      executor: string;
      provider: string;
      inputRef: { path: string; sha256: string; bytes: number };
      inputHash: string;
      idempotencyKey: string;
      idempotencyTtlMs: number;
      approvalDigest: string;
    }
  // Close proof for the host ledger when the provider outcome cannot be
  // established without risking a duplicate effect. Ordinary runs become
  // blocked; cancellation carries the bounded identities into runCancelled.
  | {
      type: 'hostEffectUncertain';
      nodeId: string;
      instanceId: string;
      attemptId: string;
      executor: string;
      reason:
        | 'ttlExpired'
        | 'inputUnrecoverable'
        | 'outputUnrecoverable'
        | 'definitionMismatch'
        | 'unknownProvider'
        | 'inputHashMismatch'
        | 'providerUncertain';
      errorCode: string;
    }
  | {
      type: 'hostEffectRetryDeferred';
      nodeId: string;
      instanceId: string;
      attemptId: string;
      retryCount: number;
      nextRetryAt: number;
      errorCode: string;
    }
  // Durable proof that the attempt's pre-fork worker fence was published
  // before factory.spawn(). Recovery treats a missing/corrupt fence after this
  // marker as unknown until process discovery proves no outer worker remains.
  | { type: 'nodeWorkerFenceArmed'; nodeId: string; instanceId?: string; attemptId: string }
  // Written when the node's worker web terminal is ready (mid-run) so the
  // dashboard can attach to an in-flight node's LIVE terminal instead of waiting
  // for completion.  Kept even if the node later fails (terminal info survives).
  // NOTE: deliberately NO web-terminal `token` here — it's a WRITE token, and
  // read-only "watch the subagent" doesn't need it; persisting it would turn
  // write access into a durable artifact (codex security review 2026-06-02).
  | { type: 'nodeSessionReady'; nodeId: string; instanceId?: string; attemptId: string; sessionInfo: { sessionId: string; webPort?: number }; ptyLogPath?: string }
  | { type: 'nodeSucceeded'; nodeId: string; instanceId?: string; attemptId: string; manifestPath: string }
  // `errorCode` carries the node's self-reported `manifest.error.code` (e.g.
  // AUTH_REQUIRED) so dashboards see the real cause, not just the coarse class.
  | { type: 'nodeFailed'; nodeId: string; instanceId?: string; attemptId: string; errorClass: V3ErrorClass; errorCode?: string; message?: string }
  // Semantic/contract failure — recoverable.  classifyTerminal(errorClass,
  // retryable) decides blocked-vs-failed; blocked halts the run like failed
  // but is retryable via `nodeRetryRequested` (journal event, NOT in-memory).
  // `ask` is present ONLY when the block is a runtime human-ask (errorCode ===
  // ASK_HUMAN_ERROR_CODE): the goal worker's question, read from the attempt's
  // ask.json.  The daemon renders an ask card instead of a plain retry card;
  // everything else is identical to a contract-failure block.
  | { type: 'nodeBlocked'; nodeId: string; instanceId?: string; attemptId: string; errorClass: V3ErrorClass; errorCode?: string; message?: string; ask?: GoalAsk;
      // Set only when errorCode === 'REVISIT_BUDGET_EXHAUSTED': the ancestor this
      // node tried to revisit.  The grant card reads it to label the source→target
      // pair + pick the grant scope (the revisit was budget-blocked before any
      // nodeRevisitRequested was journaled, so the target isn't recorded elsewhere).
      revisitTo?: string }
  // Retry intent for a blocked node.  Appended by the retry entrypoint (CLI /
  // daemon card click).  materialize() resets the node to pending and records
  // `nextAttemptId` as the attempt reservation; the orchestrator then re-
  // dispatches naturally.  `previousErrorClass`/`previousErrorCode` are copied
  // from the blocked event purely for audit (grep the journal and see WHY this
  // retry happened) — they do not participate in the state machine.
  | {
      type: 'nodeRetryRequested';
      nodeId: string;
      // The instance being retried.  A blocked / human-ask retry stays in the
      // SAME instance — `previousAttemptId`/`nextAttemptId` are attempts under
      // this `instanceId` (`A#001/attempts/002`).  This is NOT a revisit: a
      // revisit makes a NEW instance via nodeInstanceSuperseded + re-dispatch.
      instanceId?: string;
      previousAttemptId: string;
      nextAttemptId: string;
      reason: 'blockedRetry';
      previousErrorClass?: V3ErrorClass;
      previousErrorCode?: string;
      /** Host pre-intent retry must approve the newly frozen attempt again. */
      resetGate?: boolean;
      // Present ONLY when the retry answers a runtime human-ask: the human's
      // selected option or free-text answer, persisted to `answer.path` (an absolute path, next to
      // the asked attempt).  buildInputs injects it into the retry attempt's
      // GoalInputs as `{from:"human", name:"answer"}` so the agent reads the decision and
      // continues.  Absent for an ordinary blocked retry.
      answer?: { path: string; preview: string; by: string };
    }
  // Gate is per-INSTANCE: `A#001`'s approval must not clear `A#002` after a
  // revisit (constraint 6).  `instanceId` optional for back-compat.
  | { type: 'gateDispatched'; nodeId: string; instanceId?: string; waitId: string;
      hostApproval?: { attemptId: string; approvalDigest: string; inputHash: string } }
  | { type: 'gateResolved'; nodeId: string; instanceId?: string; waitId: string; resolution: 'approved' | 'rejected'; by: string; selected?: string;
      hostApproval?: { attemptId: string; approvalDigest: string; inputHash: string } }
  // ── edge activation lifecycle ──
  // Conditional edge predicates read a source node's validated result.json
  // exactly once, then persist the verdict here.  Replay / dashboards /
  // decideNext consume this event and never re-read result.json.
  // `fromInstanceId`/`toInstanceId` scope the verdict to a concrete instance
  // pair so a revisit's `A#001->B#001` verdict never bleeds onto the fresh
  // `A#002->B#002` edge (constraint 1).  `from`/`to` stay as definition-layer
  // labels for the dashboard; both optional for back-compat.
  | {
      type: 'edgeResolved';
      from: string;
      to: string;
      fromInstanceId?: string;
      toInstanceId?: string;
      sourceAttemptId: string;
      active: boolean;
      detail?: string;
    }
  // A node whose triggerRule cannot be satisfied is a terminal skipped node.
  // It is not a failure and does not trigger fail-fast; its outgoing edges
  // become inactive by pure derivation from node state + static DAG.
  | { type: 'nodeSkipped'; nodeId: string; reason: 'triggerRuleUnsatisfied'; detail?: string }
  // A neutral terminal for early-release losers and run-level cancellation.
  // This is deliberately NOT nodeFailed(errorClass:'cancelled'): cancellation
  // means "no longer needed", not "requires intervention", and must not trip
  // the fail-fast sweep.  `byNodeId` is mandatory only for an early-release
  // winner; user cancellation carries the durable run-level actor instead.
  | ({
      type: 'nodeCancelled';
      nodeId: string;
      instanceId?: string;
      attemptId?: string;
      detail?: string;
    } & (
      | { reason: 'earlyReleaseLoser'; byNodeId: string }
      | { reason: 'runCancelled'; cancelRequestId: string }
    ))
  // Durable resource close proof for an attempt whose normal node verdict was
  // intentionally discarded (terminal peer teardown, obsolete revisit/
  // early-release work, or crash recovery). This event may be appended after a
  // run terminal while cleaning up a pre-fix history; it never changes the run
  // verdict by itself.
  | {
      type: 'nodeAttemptDrained';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      reason: 'terminalPeer' | 'obsoleteAttempt' | 'orphanRecovery' | 'runCancellation';
    }
  // ── cross-node revisit / instance lifecycle (instance restoration 2026-06-08) ──
  // A node's worker emitted result.json `status:"revisit"` requesting a jump
  // back to ancestor `toNodeId` (must be in the node's `revisitTo`).  Audit +
  // the trigger for the supersede sweep the runtime appends next.  `reason` is
  // the worker's free-text "why" (the cross-node analogue of a block reason).
  | {
      type: 'nodeRevisitRequested';
      nodeId: string;
      instanceId: string;
      attemptId: string;
      toNodeId: string;
      reason?: string;
      // Feedback paths (runDir-relative) the target's fresh instance reads via
      // `from:"revisit"` inputs — so it knows WHY it was sent back, WHAT the
      // downstream found, and WHAT it itself produced last time, instead of
      // re-running blind.  reasonPath: the reason text file (runtime-written);
      // sourceManifestPath: the requesting node's manifest (its products are the
      // "where it went wrong" evidence); targetPreviousManifestPath: the target's
      // own prior (now-superseded) manifest (so it edits, not rewrites).
      reasonPath?: string;
      sourceManifestPath?: string;
      targetPreviousManifestPath?: string;
    }
  // The revisit invalidates a runtime instance: the target's current effective
  // instance AND every already-materialized instance in its downstream cone are
  // superseded (marked, never deleted — files stay for audit + as the
  // `targetPreviousManifestPath` snapshot).  `byNodeId` = the revisit target
  // that triggered the refresh.  materialize sets the instance `superseded` and
  // recomputes the node's `effectiveInstanceId`, so decideNext re-dispatches a
  // fresh `#NNN`.  This is the "refresh" the dashboard shows on those nodes.
  | {
      type: 'nodeInstanceSuperseded';
      nodeId: string;
      instanceId: string;
      byNodeId: string;
      reason: 'refresh';
    }
  // A human granted extra revisit budget after the run blocked on exhaustion
  // (the revisit analogue of loopIterationGranted).  A PAIR grant (both
  // sourceNodeId + toNodeId set) bumps one source→target edge's allowance by 1;
  // a RUN grant (neither set) bumps the run-wide allowance by 1.  Consumed by
  // the next budget check in the runtime's revisit recognition.
  | {
      type: 'revisitBudgetGranted';
      sourceNodeId?: string;
      toNodeId?: string;
      by: string;
      reason?: string;
    }
  // ── structured loop lifecycle ──
  // A loop is a composite node: its body expands into REAL journal-level nodes
  // per iteration (instance ids via loopInstanceId), so dispatch/settle/retry
  // reuse the node events above.  These events only mark the loop's own state
  // machine: started → (iterationStarted → [body runs] → iterationDecision)* →
  // done (decision 'exit', sealed by a nodeSucceeded on the LOOP id carrying
  // the output projection's manifest) | blocked (decision 'exhausted').
  | { type: 'loopStarted'; loopId: string }
  | { type: 'loopIterationStarted'; loopId: string; iteration: number }
  // The runtime's verdict after an iteration's body completed: evaluate
  // exit.when on the exit node's result.json.  `exit` ends the loop, `continue`
  // schedules the next iteration, `exhausted` (predicate unmatched at the
  // iteration budget) blocks the loop — recoverable via loopIterationGranted.
  | {
      type: 'loopIterationDecision';
      loopId: string;
      iteration: number;
      decision: 'exit' | 'continue' | 'exhausted';
      /** Human-readable why (e.g. `result.passed=false (2/3 iterations used)`). */
      detail?: string;
    }
  // A human granted ONE extra iteration to an exhausted-blocked loop (the
  // loop analogue of nodeRetryRequested — journal event, never an in-memory
  // patch).  Consumed by the next loopIterationStarted.
  | { type: 'loopIterationGranted'; loopId: string; fromIteration: number; by?: string }
  // Durable user intent is its own boundary.  Runtime treats every later
  // non-cancellation settle as stale, aborts live workers, neutral-cancels all
  // unfinished nodes, then appends runCancelled.  A crash between these two
  // records is recoverable by replay + cold re-drive.
  | { type: 'runCancelRequested'; cancelRequestId: string; by: string; reason?: string }
  | {
      type: 'runCancelled';
      cancelRequestId: string;
      by: string;
      uncertainHostEffects?: V3UncertainHostEffect[];
    }
  | { type: 'runSucceeded' }
  | { type: 'runFailed'; failedNodeId?: string; reason?: V3RunFailureReason; detail?: string }
  // Terminal-for-now: every non-done path is blocked (recoverable).  A retry
  // clears it back to running on replay (see state.ts materialize).
  | { type: 'runBlocked'; blockedNodeId: string };

/** A journal line: the event flattened with its append timestamp (flattened —
 *  not `{ts, event}` — so `grep nodeFailed journal.ndjson` just works). */
export type StoredEvent = V3Event & { ts: number };

// ─── Append ─────────────────────────────────────────────────────────────────

export interface JournalMutation {
  /** Lazy snapshot; access it before calling append when doing read/check/write. */
  readonly events: readonly StoredEvent[];
  /** Append while retaining the mutation's already-held cross-process lock. */
  append(event: V3Event, options?: { durable?: boolean }): StoredEvent;
}

function fsyncFile(journalPath: string): void {
  const fd = openSync(journalPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Parse NDJSON while optionally tolerating only the physical unterminated tail. */
function parseJournalText(
  raw: string,
  journalPath: string,
  tolerateTornFinal: boolean,
): StoredEvent[] {
  const lines = raw.split('\n');
  const out: StoredEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as StoredEvent);
    } catch (err) {
      // Only the physical final segment can be torn. An invalid line followed
      // by a newline is committed corruption even when trailing whitespace
      // makes it the last non-empty line.
      if (tolerateTornFinal && i === lines.length - 1 && !raw.endsWith('\n')) break;
      throw new Error(
        `v3 journal corrupted at line ${i + 1} of ${journalPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/**
 * Validate committed records and normalize an unterminated tail before a
 * writer appends. A syntactically complete JSON tail is preserved and sealed
 * with `\n`; an incomplete tail is truncated to the last newline. Repair
 * bytes are fsynced before the next append, and any already-terminated corrupt
 * record fails closed.
 */
function repairJournalTailForMutation(journalPath: string): void {
  if (!existsSync(journalPath)) return;
  // The healthy hot path reads one byte, not the full journal. Runtime and
  // host control paths already replay before deciding what to append; this
  // boundary's extra responsibility is preventing a torn physical tail from
  // being glued to the next record.
  const probeFd = openSync(journalPath, 'r');
  try {
    const size = fstatSync(probeFd).size;
    if (size === 0) return;
    const lastByte = Buffer.allocUnsafe(1);
    readSync(probeFd, lastByte, 0, 1, size - 1);
    if (lastByte[0] === 0x0a) return;
  } finally {
    closeSync(probeFd);
  }

  // Recovery is exceptional, so a full validation/read here is intentional:
  // it proves every committed prefix line before repairing only the tail.
  const raw = readFileSync(journalPath);
  parseJournalText(raw.toString('utf-8'), journalPath, true);
  const lastNewline = raw.lastIndexOf(0x0a);
  const tail = raw.subarray(lastNewline + 1).toString('utf-8');
  let completeJson = false;
  if (tail.trim()) {
    try {
      JSON.parse(tail.trim());
      completeJson = true;
    } catch {
      // A read-only projection may ignore this tail; mutation removes it so
      // the next JSON object can never be glued onto the interrupted record.
    }
  }

  if (completeJson) {
    appendFileSync(journalPath, '\n');
    fsyncFile(journalPath);
  } else {
    const fd = openSync(journalPath, 'r+');
    try {
      ftruncateSync(fd, lastNewline + 1);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  // Conservative: explicitly persist the repair boundary as a whole, even
  // though truncating an existing inode does not normally change its dirent.
  fsyncDirectorySyncPortable(dirname(journalPath));
}

/**
 * Run one read/check/append mutation under the journal's sole lock. Callers
 * such as start-intent use this instead of nesting a file lock around
 * appendEvent (the generic file lock is deliberately non-reentrant).
 */
export function withJournalMutationSync<T>(
  journalPath: string,
  fn: (mutation: JournalMutation) => T,
): T {
  const dir = dirname(journalPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return withFileLockSync(journalPath, () => {
    repairJournalTailForMutation(journalPath);
    let eventsSnapshot: StoredEvent[] | undefined;
    let appended = false;
    let journalExisted = existsSync(journalPath);
    const append = (event: V3Event, options: { durable?: boolean } = {}): StoredEvent => {
      const stored: StoredEvent = { ts: Date.now(), ...event };
      const created = !journalExisted;
      appendFileSync(journalPath, JSON.stringify(stored) + '\n');
      appended = true;
      journalExisted = true;
      if (options.durable) {
        fsyncFile(journalPath);
        if (created) fsyncDirectorySyncPortable(dirname(journalPath));
      }
      return stored;
    };
    return fn({
      get events() {
        // Generic appendEvent never pays a full replay. Atomic read/check/
        // append callers opt in by accessing this lazy snapshot.
        if (appended && eventsSnapshot === undefined) {
          throw new Error('journal mutation events must be read before the first append');
        }
        return eventsSnapshot ??= readJournal(journalPath);
      },
      append,
    });
  });
}

/**
 * Append one event as a single NDJSON line.  Stamps `ts` (epoch ms) at write
 * time.  Creates the parent directory if missing so the very first
 * `runStarted` doesn't require the caller to pre-create the runDir.
 *
 * Synchronous on purpose: the runtime loop must observe its own writes in
 * order, and the journal is the linearization point — an async append would
 * open a window where `decideNext` runs against stale state.
 */
export function appendEvent(journalPath: string, event: V3Event): StoredEvent {
  return withJournalMutationSync(journalPath, ({ append }) => append(event));
}

/**
 * Append an event and force both its bytes and a newly-created journal dirent
 * to stable storage before returning. Reserved for host acknowledgement
 * boundaries (for example `/start` returning HTTP 202) and resource-close
 * proofs that must reach disk before a worker fence is removed. Other hot
 * runtime transitions keep using {@link appendEvent}.
 */
export function appendEventDurable(journalPath: string, event: V3Event): StoredEvent {
  return withJournalMutationSync(journalPath, ({ append }) => append(event, { durable: true }));
}

// ─── Read / replay ────────────────────────────────────────────────────────

/**
 * Read every event in append order.  Tolerates a torn FINAL line (crash
 * mid-append) but throws on any earlier unparseable line — a mid-file parse
 * failure is real corruption, and silently dropping a middle event would
 * desync the replayed state (e.g. a lost `nodeSucceeded` leaves the node
 * looking pending forever), so fail loud instead (codex hardening #11).
 * Returns `[]` if the file does not exist yet (a run that never started).
 */
export function readJournal(journalPath: string): StoredEvent[] {
  if (!existsSync(journalPath)) return [];
  return parseJournalText(readFileSync(journalPath, 'utf-8'), journalPath, true);
}
