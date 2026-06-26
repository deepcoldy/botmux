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

import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';

import { loadBotConfigs, type BotConfig } from '../../bot-registry.js';
import { isLoopNode, loadDag } from './dag.js';
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
  type RunChatBinding,
} from './grill-state.js';
import { resolveBotConfig, botToSnapshot } from './bot-resolve.js';
import {
  canResolveGateWait,
  normalizeGateWaitInput,
  readWait,
  resolveWait,
  selectedResolution,
  writePendingWait,
  type GateWaitStatus,
} from './human-gate.js';
import { readJournal, appendEvent, type StoredEvent, type V3ErrorClass } from './journal.js';
import { materialize } from './state.js';
import { isValidRunId } from './ops-projection.js';
import { GOAL_ANSWER_FILE, type GoalAnswer, type GoalAsk, type ValidateManifest } from './contract.js';

/**
 * runId → runDir with a path-traversal guard (codex review #2).  runIds reach
 * the daemon from outside (start IPC, card clicks) — never trust them into a
 * `join` without the allowlist check, so the guard lives in core (not glue).
 */
export function safeRunDir(baseDir: string, runId: string): string {
  if (!isValidRunId(runId)) throw new Error(`v3: invalid runId "${runId}"`);
  return join(baseDir, runId);
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
}

/**
 * Drive a daemon-side v3 run to its next suspension point (a gate) or terminal.
 * Returns the runtime outcome.  Throws on: missing grill state, no approved
 * dag, or awaitingGate with no chatBinding (can't post a card).
 */
export async function driveV3Run(runId: string, deps: V3DaemonRunDeps): Promise<V3RunOutcome> {
  const baseDir = deps.baseDir ?? defaultBaseDir();
  const runDir = safeRunDir(baseDir, runId);

  const grill = readGrillState(runDir);
  if (!grill) throw new Error(`v3 daemon run: no grill state for "${runId}" in ${runDir}`);
  if (!grill.dagPath || !existsSync(grill.dagPath)) {
    throw new Error(`v3 daemon run: "${runId}" has no approved dag (status=${grill.status})`);
  }
  const binding = grill.chatBinding;

  // Was the run ALREADY terminal before this (re-)drive?  A coalesced re-drive or
  // a `/start` retry of a finished run re-runs no work (the journal is terminal),
  // but the notify block below would otherwise re-post cards / re-fire onTerminal
  // — duplicate "done/failed" messages. Capture now, short-circuit after runWorkflow.
  const journalPath = join(runDir, 'journal.ndjson');
  const wasAlreadyTerminal =
    existsSync(journalPath) &&
    ['succeeded', 'failed'].includes(materialize(readJournal(journalPath)).runStatus);

  const bots = (deps.loadBots ?? loadBotConfigs)();
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
  const dag = loadDag(grill.dagPath);

  // suspend mode → no resolveGate (runtime writes the wait + returns awaitingGate).
  const runtimeDeps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };
  const opts: V3RuntimeOptions = {
    baseDir,
    gateMode: 'suspend',
    ...(deps.maxParallel ? { globalConcurrency: deps.maxParallel } : {}),
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
  if (!canResolveGateWait(wait, input.by)) return { kind: 'unauthorized' };
  const resolution = selectedResolution(wait, input.selected);
  if (!resolution) return { kind: 'stale-run', reason: 'no-wait' };

  resolveWait(runDir, input.waitId, resolution, input.by, input.selected);
  const instanceId = snap.nodes.get(wait.nodeId)?.effectiveInstanceId;
  appendEvent(journalPath, {
    type: 'gateResolved',
    // nodeId from the WAIT FILE, not caller input (codex review #1): the wait is
    // the authoritative state — a wrong/stale caller nodeId must not let us write
    // gateResolved for a different node.
    nodeId: wait.nodeId,
    ...(instanceId ? { instanceId } : {}),
    waitId: input.waitId,
    resolution,
    by: input.by,
    selected: input.selected,
  });
  return { kind: 'resolved', resolution };
}

export type V3RetryOutcome =
  | { kind: 'requested'; nodeId: string; previousAttemptId: string; nextAttemptId: string }
  | { kind: 'already-requested'; nodeId: string }
  | { kind: 'stale-run'; reason: 'missing' | 'not-blocked' | 'stale-attempt' | 'loop-node' | 'invalid-answer' };

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
  // Freshness gate (codex blocker): the click must target the CURRENTLY
  // blocked attempt, not an earlier one whose card survived in the chat.
  if (input.expectedAttemptId && input.expectedAttemptId !== info.attemptId) {
    return { kind: 'stale-run', reason: 'stale-attempt' };
  }
  const nextAttemptId = nextAttemptIdFor(events, attemptKey);

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
  const inFlight = new Set<string>();
  const rerunRequested = new Set<string>();

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
        await driveV3Run(runId, {
          baseDir: deps.baseDir,
          loadBots: deps.loadBots,
          makeRunNode: deps.makeRunNode,
          validateManifest: deps.validateManifest,
          maxParallel: deps.maxParallel,
          postGateCard: (binding, gate, rid) => deps.postCard(binding, gate, rid),
          postBlockedCard: deps.postBlockedCard,
          postLoopGrantCard: deps.postLoopGrantCard,
          postRevisitGrantCard: deps.postRevisitGrantCard,
          onTerminal: (rid, outcome, binding) =>
            deps.notifyTerminal ? deps.notifyTerminal(binding, rid, outcome) : Promise.resolve(),
        });
      } while (rerunRequested.has(runId));
    } catch (err) {
      deps.onError?.(runId, err);
    } finally {
      inFlight.delete(runId);
      rerunRequested.delete(runId);
    }
  }

  /** Fire-and-forget drive (card-click / start IPC call this). */
  function driveDetached(runId: string): void {
    void drive(runId);
  }

  async function coldAttach(ownerLarkAppId?: string): Promise<void> {
    let recs: V3GateRecovery[] = [];
    try {
      recs = reconcileV3PendingGates(deps.baseDir, ownerLarkAppId);
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

  return { drive, driveDetached, coldAttach };
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

      const events = readJournal(journalPath);
      const snap = materialize(events);
      if (snap.runStatus === 'succeeded' || snap.runStatus === 'failed') continue;

      if (snap.runStatus === 'blocked') {
        // Blocked run: repost the recovery card (covers the crash window
        // between the runBlocked append and the original card send) — grant
        // card for an exhausted loop, retry card for a blocked node.  Owner-
        // filtered like gates; binding-less (CLI/dev) runs are left alone.
        const grill = readGrillState(runDir);
        const binding = grill?.chatBinding;
        if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) continue;
        if (!binding || !snap.blockedNodeId) continue;
        if (snap.loops.has(snap.blockedNodeId)) {
          const info = loopExhaustedInfoFor(events, snap.blockedNodeId);
          if (grill?.dagPath && existsSync(grill.dagPath)) {
            try {
              const loopNode = loadDag(grill.dagPath).nodes.find((n) => n.id === snap.blockedNodeId);
              if (loopNode && isLoopNode(loopNode)) info.maxIterations = loopNode.maxIterations;
            } catch { /* display-only enrichment — card renders without it */ }
          }
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
        out.push(rec);
        continue;
      }
      // No gate to reconcile.  If nothing is (phantom-)running, the run died in
      // a resumable spot — e.g. crash right after a `nodeRetryRequested` append
      // (before the redrive) or right after start — so re-drive it.  Runs with
      // phantom `running` nodes are the dangling-attempt recovery gap (worker
      // fencing backlog) and are deliberately left alone.
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
        const grill = readGrillState(runDir);
        const binding = grill?.chatBinding;
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
  const gateWaitingNodes = [...snap.nodes.entries()]
    .filter(([, s]) => s.status === 'gateWaiting')
    .map(([id]) => id);
  if (gateWaitingNodes.length === 0) return undefined;

  const grill = readGrillState(runDir); // defensive: undefined on corrupt (won't throw)
  const binding = grill?.chatBinding;

  // Multi-daemon owner filter (codex blocker #1): each bot daemon must only
  // touch runs bound to ITS larkAppId — otherwise every online daemon re-posts
  // / resumes the same pending gate.  A run with no binding (CLI/dev) or a
  // different owner is left for the owning daemon (or nobody).
  if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) return undefined;

  // dag (for humanGate.prompt when re-creating a missing wait).
  const dagNodeGate = new Map<string, ReturnType<typeof normalizeGateWaitInput>>();
  if (grill?.dagPath && existsSync(grill.dagPath)) {
    try {
      for (const n of loadDag(grill.dagPath).nodes) {
        if (n.humanGate?.prompt) dagNodeGate.set(n.id, normalizeGateWaitInput(n.humanGate));
      }
    } catch {
      /* dag unreadable — fall back to a generic prompt below */
    }
  }

  const repost: V3PendingGate[] = [];
  let resume = false;
  for (const nodeId of gateWaitingNodes) {
    // Instance-level waitId mirrors startGate so recovery reads the SAME wait
    // file the dispatch wrote (stale-card protection).
    const instanceId = snap.nodes.get(nodeId)?.effectiveInstanceId;
    const waitId = `${instanceId ?? nodeId}-gate`;
    let wait = readWait(runDir, waitId);
    if (!wait) {
      const gate = dagNodeGate.get(nodeId) ?? normalizeGateWaitInput({ prompt: '(humanGate — 等待人工审批)' });
      wait = writePendingWait(runDir, { waitId, nodeId, ...(instanceId ? { instanceId } : {}), ...gate });
    }
    if (wait.status === 'pending') {
      repost.push({
        nodeId,
        waitId,
        prompt: wait.prompt,
        options: wait.options,
        approveOptions: wait.approveOptions,
        approvers: wait.approvers,
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
      });
      resume = true;
    }
  }
  return { runId, runDir, binding, repost, resume };
}
