/**
 * v3 journal — append-only event stream (the run's audit truth).
 *
 * Codex's v1-review blocker #1: v3 is NOT a "only-mutable-STATE" recoverable
 * system.  `journal.ndjson` is the append-only source of audit truth (one JSON
 * object per line, `ts`-stamped) from which `state.ts` materializes the STATE
 * checkpoint.  Concurrency / retry / gate / cancel / failure-root-cause all
 * leave an ordered trail here.
 *
 * Append-only + line-oriented = crash-tolerant by construction: a torn final
 * line (process died mid-write) is skipped on read; everything before it is
 * intact.  No locking needed for the journal itself — appends are serialized
 * by the single runtime loop (the per-node LOCK guards worker dispatch, not
 * the journal).
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
      // Present ONLY when the retry answers a runtime human-ask: the human's
      // selected option or free-text answer, persisted to `answer.path` (an absolute path, next to
      // the asked attempt).  buildInputs injects it into the retry attempt's
      // GoalInputs as `{from:"human", name:"answer"}` so the agent reads the decision and
      // continues.  Absent for an ordinary blocked retry.
      answer?: { path: string; preview: string; by: string };
    }
  // Gate is per-INSTANCE: `A#001`'s approval must not clear `A#002` after a
  // revisit (constraint 6).  `instanceId` optional for back-compat.
  | { type: 'gateDispatched'; nodeId: string; instanceId?: string; waitId: string }
  | { type: 'gateResolved'; nodeId: string; instanceId?: string; waitId: string; resolution: 'approved' | 'rejected'; by: string; selected?: string }
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
  // A neutral terminal for early-release losers.  This is deliberately NOT
  // nodeFailed(errorClass:'cancelled'): cancellation means "no longer needed",
  // not "requires intervention", and must not trip the fail-fast sweep.
  | {
      type: 'nodeCancelled';
      nodeId: string;
      instanceId?: string;
      attemptId?: string;
      reason: 'earlyReleaseLoser';
      byNodeId: string;
      detail?: string;
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
  | { type: 'runSucceeded' }
  | { type: 'runFailed'; failedNodeId?: string; reason?: V3RunFailureReason; detail?: string }
  // Terminal-for-now: every non-done path is blocked (recoverable).  A retry
  // clears it back to running on replay (see state.ts materialize).
  | { type: 'runBlocked'; blockedNodeId: string };

/** A journal line: the event flattened with its append timestamp (flattened —
 *  not `{ts, event}` — so `grep nodeFailed journal.ndjson` just works). */
export type StoredEvent = V3Event & { ts: number };

// ─── Append ─────────────────────────────────────────────────────────────────

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
  const stored: StoredEvent = { ts: Date.now(), ...event };
  const dir = dirname(journalPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(journalPath, JSON.stringify(stored) + '\n');
  return stored;
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
  const raw = readFileSync(journalPath, 'utf-8');
  const lines = raw.split('\n');
  // Only the last non-empty line can legitimately be a half-written append.
  let lastNonEmpty = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim()) { lastNonEmpty = i; break; }
  }
  const out: StoredEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as StoredEvent);
    } catch (err) {
      if (i === lastNonEmpty) break; // torn final line from an interrupted append — tolerate
      throw new Error(
        `v3 journal corrupted at line ${i + 1} of ${journalPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}
