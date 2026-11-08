/**
 * Daemon wiring of the main-bot wake-up (design 2026-11-03 §13.6, M6): for a
 * bot-executed run this daemon owns, every wake-worthy event
 * (`pendingV3MainWakes`: a node stuck or failed, a bot reporting it cannot do
 * a node, a checkpoint node completing) opens one turn in the run's main
 * session, turn id `workflow-event:<runId>:<eventSeq>`.
 *
 * Delivery reuses the report relay's synthetic trigger (`triggerSessionTurn`,
 * envelope `trusted: false`): the event data is untrusted, the instruction is
 * the daemon's own. The main session is the live session in the run's main
 * topic; when none is live, the same trigger opens a new session in that
 * topic — exactly what a message to the topic would do — rather than reviving
 * a session someone closed (see `deliveryTarget`).
 *
 * Only to an idle session, as a turn of its own, one at a time. A CLI with
 * type-ahead (Claude Code and others) folds input that arrives mid-turn into
 * the turn that is running, and the process marker keeps naming that turn:
 * the event would then be handled under that person's identity. So a wake
 * waits here, in the daemon, while the main session is busy (`sessionState`,
 * checked again synchronously right before the hand-over) or still has a
 * wake handed to it whose turn was not seen to end, and goes out when it is
 * idle again (`onScreenStatus`, `onTurnEnded`, plus a slow poll). The
 * hand-over also asks the worker to queue it behind any turn that starts in
 * the same instant (`queueAfterActiveTurn`) instead of folding it in.
 *
 * Exactly once per event: the issuance record (main-wake-ledger.ts) is
 * written in the trigger's write-ahead hook — the last moment before the turn
 * reaches the worker of an idle session, i.e. when its own turn starts — with
 * the session's turn pointers at that moment. Its create-once file refuses a
 * second issue of the same event. A delivery that failed before the hook is
 * retried (a bounded number of times on a timer; a drive, a restart or the
 * session becoming idle starts over); a worker that synchronously refused the
 * turn gets its record taken back and is retried; a turn that may have
 * started is never issued again.
 *
 * Checkpoints (checkpoint-hold.ts): the dependants of a checkpoint success
 * wait until it is released — when the wake turn ends (its terminal, or the
 * session going idle after a working screen of that very turn), when the
 * session that took it is closed or its CLI stops (`wakeSessionEnded`), when
 * the wake cannot be delivered (retries used up), or at the safety cap
 * {@link WORKFLOW_CHECKPOINT_HOLD_MAX_MS}. A wake queued behind another turn
 * is not released by that turn's end. After a restart (nothing of the turn
 * in memory) a hold whose wake already went out is released as soon as the
 * session that took it is proven idle — looked at on every scan, poll and
 * idle edge, whatever came before it.
 *
 * Runs that are not bot-executed are never read past their envelope.
 */

import { join } from 'node:path';

import type { DaemonSession } from './types.js';
import type { V3Dag } from '../workflows/v3/dag.js';
import type { RunChatBinding } from '../workflows/v3/grill-state.js';
import { readJournal } from '../workflows/v3/journal.js';
import {
  buildV3MainWakeInstruction,
  pendingV3MainWakes,
  readV3MainWakeProducts,
  type V3MainWakeEvent,
} from '../workflows/v3/main-wake.js';
import {
  readV3MainWakeIssued,
  recordV3MainWakeIssued,
  retractV3MainWakeIssued,
} from '../workflows/v3/main-wake-ledger.js';
import {
  releaseV3Checkpoint,
  v3CheckpointMarkedSince,
  v3CheckpointSuccesses,
  type V3CheckpointReleaseReason,
} from '../workflows/v3/checkpoint-hold.js';
import { isValidRunId } from '../workflows/v3/ops-projection.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import { mintWorkflowEventTurnId, parseWorkflowEventTurnId } from './workflow-event-turn.js';

/** How a wake sees a session ({@link workflowMainWakeSessionState}). */
export type WorkflowMainWakeSessionState = 'idle' | 'busy' | 'starting' | 'stopped' | 'gone';

/**
 * The daemon's own evidence about a session, as a wake needs it
 * (cli-idle-wait's idle proof):
 *  - `gone`: closed, or not known;
 *  - `busy`: a live CLI in a turn or not ready for one (prompt not ready,
 *    screen not idle) — or the daemon still restoring after a restart: a CLI
 *    that survived it (tmux and the other persistent backends) may be in the
 *    middle of a turn in a pane no worker watches yet;
 *  - `starting`: no CLI yet, its first start on its way (opening input, repo
 *    choice): a wake handed to it is that start's turn;
 *  - `stopped`: active, but no CLI runs for it: a turn handed to it is over;
 *    a new hand-over starts a fresh CLI whose first turn it is;
 *  - `idle`: a live CLI, prompt ready, screen idle.
 */
export function workflowMainWakeSessionState(
  ds: DaemonSession | undefined,
  opts: { sessionsRestored: boolean },
): WorkflowMainWakeSessionState {
  if (!ds || ds.session.status !== 'active') return 'gone';
  if (!opts.sessionsRestored) return 'busy';
  if (!ds.worker || ds.worker.killed) {
    return ds.initialStartPending || ds.pendingRepo || ds.pendingRepoCommitInFlight ? 'starting' : 'stopped';
  }
  return ds.cliReady && (ds.lastScreenStatus === undefined || ds.lastScreenStatus === 'idle') ? 'idle' : 'busy';
}

export interface WorkflowMainWakeSessionView {
  sessionId: string;
  /** What the verifier will compare: the thread root (thread scope) or the
   *  current reply target's root (chat scope). */
  rootMessageId?: string;
  quoteTargetId?: string;
  currentReplyTargetTurnId?: string;
  /** The trigger just opened this session (its first start is pending):
   *  aborting the hand-over now would leave it half-started. */
  opening?: boolean;
}

export interface WorkflowMainWakeDeliveryControls {
  stableTurnId: string;
  /** Ask the worker to queue the turn behind one already running. */
  queueAfterActiveTurn: true;
  beforeDispatch: (context: { sessionId: string; workerGeneration: number }) => void;
  /** The worker refused the input synchronously, before accepting it. */
  onDispatchRefused: () => void;
}

export interface WorkflowMainWakeDeps {
  baseDir(): string;
  /** This daemon's bot; only runs it owns are woken. */
  selfLarkAppId(): string | undefined;
  /** A bot-executed run's effective flow (and its approved flow, for when
   *  each checkpoint mark took effect); undefined for any other run. */
  loadRun(runDir: string): { dag: V3Dag; authorizedDag?: V3Dag } | undefined;
  readBinding(runDir: string): RunChatBinding | undefined;
  /** The live session in the run's main topic, if any. */
  mainSessionAt(binding: RunChatBinding): { sessionId: string } | undefined;
  /** Live view of a session (read inside the write-ahead hook). */
  sessionView(sessionId: string): WorkflowMainWakeSessionView | undefined;
  /** {@link workflowMainWakeSessionState} of a session. A wake is handed
   *  over to anything but a `busy` one (with no live CLI the trigger starts
   *  one whose first turn is the wake). */
  sessionState(sessionId: string): WorkflowMainWakeSessionState;
  /** `triggerSessionTurn` with daemon-internal controls. */
  deliver(request: TriggerRequest, internal: WorkflowMainWakeDeliveryControls): Promise<TriggerResponse>;
  /** Re-drive a run after a checkpoint was released. */
  drive(runId: string): void;
  /** Run ids to look at on cold attach. */
  listRunIds(): string[];
  now?(): number;
  warn(message: string): void;
  /** Wait this long before re-trying a failed delivery (default 60 s). */
  retryMs?: number;
  /** Timer seam (tests). */
  setTimer?(fn: () => void, ms: number): { unref?: () => void };
}

/** Timed re-tries of one undelivered event before waiting for the run to
 *  move (a drive), the main session to become idle, or the daemon to
 *  restart: a chat the bot left or a session that stays unrunnable should
 *  not log every minute forever. */
export const WORKFLOW_MAIN_WAKE_MAX_RETRIES = 5;
/** How often a run with a wake waiting (busy session, back-off, open
 *  checkpoint hold) is looked at again without any other signal. */
export const WORKFLOW_MAIN_WAKE_POLL_MS = 15_000;
/** Safety cap: a checkpoint never holds its dependants longer than this
 *  after it completed, whatever happens to its wake. One hour leaves a busy
 *  main session time to finish and the main bot time to review. */
export const WORKFLOW_CHECKPOINT_HOLD_MAX_MS = 60 * 60_000;

export interface WorkflowMainWake {
  /** Issue the wakes `runId` owes. Safe to call after every drive. */
  scan(runId: string): Promise<void>;
  /** After a restart: scan every run this daemon owns. */
  coldAttach(): Promise<void>;
  /** Every screen update of a session: its status, the one before, and the
   *  turn its worker is on. */
  onScreenStatus(sessionId: string, update: { status: string; prevStatus?: string; turnId?: string }): void;
  /** A turn of a session reached its terminal. */
  onTurnEnded(sessionId: string, turnId: string): void;
}

/** Where a wake goes: the main topic's live session, else the main topic
 *  itself (the trigger opens a session there — the path a message to the
 *  topic takes). A closed main session is not resumed: someone closed it,
 *  and resuming is not what the topic's own messages do either. */
function deliveryTarget(
  binding: RunChatBinding & { rootMessageId: string },
  live: { sessionId: string } | undefined,
): TriggerRequest['target'] {
  return live
    ? { kind: 'turn', botId: binding.larkAppId, sessionId: live.sessionId }
    : { kind: 'turn', botId: binding.larkAppId, chatId: binding.chatId, rootMessageId: binding.rootMessageId };
}

export function buildWorkflowMainWakeRequest(input: {
  runId: string;
  event: V3MainWakeEvent;
  target: TriggerRequest['target'];
  products?: ReturnType<typeof readV3MainWakeProducts>;
  receivedAt: string;
}): TriggerRequest {
  const { runId, event } = input;
  const turnId = mintWorkflowEventTurnId(runId, event.eventSeq);
  const rawText = event.kind === 'checkpoint' ? input.products?.summary : event.message;
  return {
    source: { type: 'workflow', connectorId: 'botmux-workflow-wake', requestId: turnId, receivedAt: input.receivedAt },
    target: input.target,
    envelope: {
      format: 'botmux-workflow-event/v1',
      sourceName: 'Workflow',
      trusted: false,
      payload: {
        runId,
        eventSeq: event.eventSeq,
        event: event.kind,
        nodeId: event.nodeId,
        attemptId: event.attemptId,
        ...(event.outcome ? { outcome: event.outcome } : {}),
        ...(event.errorClass ? { errorClass: event.errorClass } : {}),
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(event.kind === 'checkpoint' && input.products
          ? { files: input.products.files, ...(input.products.result ? { result: input.products.result } : {}) }
          : {}),
      },
      ...(rawText ? { rawText } : {}),
    },
    instruction: buildV3MainWakeInstruction(runId, event),
  };
}

/** Thrown from the write-ahead hook when the session turned out busy at the
 *  last moment: nothing was handed over, the wake waits. */
class WakeDeferred extends Error {}

/** A wake this process handed to a session (or, after a restart, found
 *  issued for a checkpoint that still holds), until its turn is seen to end. */
interface HandedOverWake {
  runId: string;
  eventSeq: number;
  turnId: string;
  checkpoint: boolean;
  /** A working screen of this very turn was seen: its worker was on it. */
  seenRunning?: boolean;
  /** Found after a restart: this process never saw it start. */
  restored?: boolean;
  /** When this process took it on. */
  at: number;
}

export function createWorkflowMainWake(deps: WorkflowMainWakeDeps): WorkflowMainWake {
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? 60_000;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const keyOf = (runId: string, eventSeq: number): string => `${runId}:${eventSeq}`;
  /** Being delivered by this process. */
  const inFlight = new Set<string>();
  /** Delivered into a session the trigger opened, whose record could not be
   *  written: never delivered again (the turn ran, without authority). */
  const deliveredUnrecorded = new Set<string>();
  /** Failed deliveries: attempts used and when the next may run. */
  const backoff = new Map<string, { used: number; nextAt: number }>();
  /** Retries used up; waiting for a drive, an idle session or a restart. */
  const gaveUp = new Set<string>();
  /** Runs with a wake waiting for this session to be idle. */
  const waitingOn = new Map<string, Set<string>>();
  /** Wakes handed to each session whose turn was not seen to end: the next
   *  wake for that session waits for them, and a checkpoint's end releases
   *  it. */
  const handedOver = new Map<string, HandedOverWake[]>();
  /** One pending poll per run. */
  const polls = new Set<string>();
  /** Scans of one run never overlap. */
  const chains = new Map<string, Promise<void>>();

  function ensurePoll(runId: string): void {
    if (polls.has(runId)) return;
    polls.add(runId);
    const timer = setTimer(() => {
      polls.delete(runId);
      void scan(runId, { timed: true });
    }, WORKFLOW_MAIN_WAKE_POLL_MS);
    timer.unref?.();
  }

  function waitFor(sessionId: string, runId: string): void {
    const runs = waitingOn.get(sessionId) ?? new Set<string>();
    runs.add(runId);
    waitingOn.set(sessionId, runs);
    ensurePoll(runId);
  }

  function release(runId: string, eventSeq: number, reason: V3CheckpointReleaseReason): void {
    const runDir = join(deps.baseDir(), runId);
    const run = deps.loadRun(runDir);
    if (!run) return;
    const authorized = run.authorizedDag ?? run.dag;
    let outcome: 'released' | 'not-held';
    try {
      outcome = releaseV3Checkpoint(join(runDir, 'journal.ndjson'), {
        eventSeq,
        reason,
        dag: run.dag,
        markedSince: (events) => v3CheckpointMarkedSince(runDir, authorized, events),
      });
    } catch (err) {
      deps.warn(`[workflow-wake:${runId}] releasing checkpoint ${eventSeq} failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (outcome !== 'released') return;
    if (reason !== 'wakeTurnEnded') {
      deps.warn(`[workflow-wake:${runId}] checkpoint ${eventSeq} released without the main bot's review (${reason}); the flow goes on as it was`);
    }
    deps.drive(runId);
  }

  function track(sessionId: string, entry: HandedOverWake): void {
    const list = handedOver.get(sessionId) ?? [];
    list.push(entry);
    handedOver.set(sessionId, list);
    if (entry.checkpoint) ensurePoll(entry.runId);
  }

  function untrack(sessionId: string, entry: HandedOverWake): void {
    const rest = (handedOver.get(sessionId) ?? []).filter((candidate) => candidate !== entry);
    if (rest.length > 0) handedOver.set(sessionId, rest);
    else handedOver.delete(sessionId);
    rescanWaiting(sessionId);
  }

  /** Runs waiting for `sessionId` are looked at again. */
  function rescanWaiting(sessionId: string): void {
    const runs = waitingOn.get(sessionId);
    if (!runs) return;
    waitingOn.delete(sessionId);
    for (const runId of runs) void scan(runId);
  }

  /** Wakes of `sessionId` whose turn ended: out of the way of the next
   *  wake, checkpoints released. */
  function endWakes(sessionId: string, match: (entry: HandedOverWake) => boolean, reason: V3CheckpointReleaseReason): void {
    const list = handedOver.get(sessionId);
    if (!list) return;
    const ended = list.filter(match);
    if (ended.length === 0) return;
    const rest = list.filter((entry) => !match(entry));
    if (rest.length > 0) handedOver.set(sessionId, rest);
    else handedOver.delete(sessionId);
    for (const entry of ended) {
      if (entry.checkpoint) release(entry.runId, entry.eventSeq, reason);
    }
    rescanWaiting(sessionId);
  }

  /** What the session's state alone proves about the wakes handed to it:
   *  closed or no CLI — over; idle — over for the ones found after a restart
   *  (nothing else tells which turn is running there). Never in the way of
   *  later wakes for longer than the hold cap. */
  function settle(sessionId: string): void {
    if (!handedOver.has(sessionId)) return;
    const state = deps.sessionState(sessionId);
    if (state === 'gone' || state === 'stopped') {
      endWakes(sessionId, () => true, 'wakeSessionEnded');
      return;
    }
    if (state === 'idle') endWakes(sessionId, (entry) => entry.restored === true, 'wakeTurnEnded');
    endWakes(sessionId, (entry) => now() - entry.at >= WORKFLOW_CHECKPOINT_HOLD_MAX_MS, 'holdTimeout');
  }

  /** A failed delivery: schedule the next try, or give up (and let a
   *  checkpoint go) once the timed retries are used up. */
  function failed(runId: string, event: V3MainWakeEvent, why: string): void {
    const key = keyOf(runId, event.eventSeq);
    const state = backoff.get(key) ?? { used: 0, nextAt: 0 };
    if (state.used >= WORKFLOW_MAIN_WAKE_MAX_RETRIES) {
      backoff.delete(key);
      gaveUp.add(key);
      deps.warn(`[workflow-wake:${runId}] wake ${event.eventSeq} not delivered (${why}); giving up after ${WORKFLOW_MAIN_WAKE_MAX_RETRIES} retries until the next drive, the main session becoming idle, or a restart（放弃重试，等下次 drive 或重启）`);
      if (event.kind === 'checkpoint') release(runId, event.eventSeq, 'wakeNotDelivered');
      return;
    }
    backoff.set(key, { used: state.used + 1, nextAt: now() + retryMs });
    deps.warn(`[workflow-wake:${runId}] wake ${event.eventSeq} not delivered (${why}); retry ${state.used + 1}/${WORKFLOW_MAIN_WAKE_MAX_RETRIES} in ${Math.round(retryMs / 1000)}s`);
    ensurePoll(runId);
  }

  async function deliverOne(
    runId: string,
    runDir: string,
    binding: RunChatBinding & { rootMessageId: string },
    event: V3MainWakeEvent,
    events: ReturnType<typeof readJournal>,
  ): Promise<void> {
    const key = keyOf(runId, event.eventSeq);
    const live = deps.mainSessionAt(binding);
    // Busy now, or another wake handed to it not seen to end: wait in the
    // daemon rather than type into a running turn or queue behind one.
    if (live) {
      settle(live.sessionId);
      if (handedOver.has(live.sessionId) || deps.sessionState(live.sessionId) === 'busy') {
        waitFor(live.sessionId, runId);
        return;
      }
    }
    const turnId = mintWorkflowEventTurnId(runId, event.eventSeq);
    const request = buildWorkflowMainWakeRequest({
      runId,
      event,
      target: deliveryTarget(binding, live),
      ...(event.kind === 'checkpoint' ? { products: readV3MainWakeProducts(events, event.nodeId) } : {}),
      receivedAt: new Date(now()).toISOString(),
    });
    let recorded = false;
    let recordError: unknown;
    let refused = false;
    let deliveredTo: string | undefined;
    let deferredOn: string | undefined;
    let inFlightEntry: HandedOverWake | undefined;
    let result: TriggerResponse;
    try {
      result = await deps.deliver(request, {
        stableTurnId: turnId,
        queueAfterActiveTurn: true,
        // The issuance record is the wake turn's only authority, written at
        // the last moment before the worker of an idle session gets the turn
        // — with the session's turn pointers as they are now
        // (V3MainWakeRecord). Throwing here aborts the hand-over before the
        // worker sees anything: when the session turned busy or got another
        // wake meanwhile (the wake waits), or when the record cannot be
        // written (an event already issued). A session the trigger just
        // opened would be left half-started by a throw, so that turn goes
        // ahead without its record instead: every run command in it is
        // refused (fail closed), and it is never delivered again. A wake that
        // goes ahead is the session's wake in flight from here on — before
        // the trigger returns, so a wake of another run reaching its own hook
        // meanwhile waits.
        beforeDispatch: ({ sessionId }) => {
          const view = deps.sessionView(sessionId);
          // A session with a wake in flight existed before this trigger (it
          // did not open it): no half-started session to leave behind.
          if (handedOver.has(sessionId) || (!view?.opening && deps.sessionState(sessionId) === 'busy')) {
            deferredOn = sessionId;
            throw new WakeDeferred(`session ${sessionId} is busy`);
          }
          deliveredTo = sessionId;
          try {
            recordV3MainWakeIssued(runDir, {
              runId,
              eventSeq: event.eventSeq,
              turnId,
              sessionId,
              larkAppId: binding.larkAppId,
              chatId: binding.chatId,
              ...(view?.rootMessageId ? { rootMessageId: view.rootMessageId } : {}),
              issuedAt: now(),
              turnPointersAtIssue: {
                ...(view?.quoteTargetId ? { quoteTargetId: view.quoteTargetId } : {}),
                ...(view?.currentReplyTargetTurnId ? { currentReplyTargetTurnId: view.currentReplyTargetTurnId } : {}),
              },
            });
            recorded = true;
          } catch (err) {
            if (!view?.opening) throw err;
            recordError = err;
          }
          inFlightEntry = { runId, eventSeq: event.eventSeq, turnId, checkpoint: event.kind === 'checkpoint', at: now() };
          track(sessionId, inFlightEntry);
        },
        onDispatchRefused: () => { refused = true; },
      });
    } catch (err) {
      if (deferredOn !== undefined) {
        waitFor(deferredOn, runId);
        return;
      }
      if (deliveredTo && inFlightEntry) untrack(deliveredTo, inFlightEntry);
      throw err;
    }
    if (result.ok && !refused) {
      backoff.delete(key);
      if (recordError !== undefined) {
        deliveredUnrecorded.add(key);
        deps.warn(`[workflow-wake:${runId}] wake ${event.eventSeq} started in a new session without its issuance record (its run commands will be refused; it is not delivered again): ${recordError instanceof Error ? recordError.message : String(recordError)}`);
      }
      return;
    }
    // Not handed over after all: out of the way of the session's next wake.
    if (deliveredTo && inFlightEntry) untrack(deliveredTo, inFlightEntry);
    // The worker provably never had it: take the record back and retry.
    if (refused && recorded) {
      try {
        retractV3MainWakeIssued(runDir, event.eventSeq, turnId);
        recorded = false;
      } catch (err) {
        deps.warn(`[workflow-wake:${runId}] taking back the record of refused wake ${event.eventSeq} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (recorded || readV3MainWakeIssued(runDir, event.eventSeq)) {
      // Issued (here or by an overlapping delivery) but the turn may not have
      // started: never re-issued, so say so instead of failing silently.
      deps.warn(`[workflow-wake:${runId}] wake ${event.eventSeq} was issued but did not start: ${result.errorCode ?? ''} ${result.error ?? ''}`.trim());
      if (event.kind === 'checkpoint') release(runId, event.eventSeq, 'wakeNotDelivered');
      return;
    }
    failed(runId, event, `${result.errorCode ?? 'error'}: ${result.error ?? ''}`);
    // The main session may only be not ready yet (choosing a directory, its
    // first start): it becoming idle is the next chance, retries or not.
    if (live) waitFor(live.sessionId, runId);
  }

  async function scanOnce(runId: string, opts: { timed?: boolean }): Promise<void> {
    if (!isValidRunId(runId)) return;
    const self = deps.selfLarkAppId();
    if (!self) return;
    const runDir = join(deps.baseDir(), runId);
    const binding = deps.readBinding(runDir);
    if (!binding || binding.larkAppId !== self) return;
    const run = deps.loadRun(runDir);
    if (!run) return;
    const events = readJournal(join(runDir, 'journal.ndjson'));
    const markedSince = v3CheckpointMarkedSince(runDir, run.authorizedDag ?? run.dag, events);
    const unreleased = v3CheckpointSuccesses({ events, dag: run.dag, markedSince }).filter((success) => !success.released);
    // Never hold forever: the safety cap, and a run that cannot be woken at
    // all (no main topic to wake it in) lets its checkpoints go at once.
    const wakeable = !!binding.chatId && !!binding.rootMessageId;
    const holding = unreleased.filter((success) => {
      if (!wakeable) release(runId, success.eventSeq, 'wakeNotDelivered');
      else if (now() - success.at >= WORKFLOW_CHECKPOINT_HOLD_MAX_MS) release(runId, success.eventSeq, 'holdTimeout');
      else return true;
      return false;
    });
    if (!wakeable) return;
    const anchored = binding as RunChatBinding & { rootMessageId: string };
    // After a restart (nothing of this in memory): a checkpoint whose wake
    // already went out waits for the session that took it to be proven idle
    // — its turn has ended, or was lost with the old process.
    for (const success of holding) {
      const issued = readV3MainWakeIssued(runDir, success.eventSeq);
      if (!issued) continue;
      const tracked = [...handedOver.values()].some((list) =>
        list.some((entry) => entry.runId === runId && entry.eventSeq === success.eventSeq));
      if (tracked) continue;
      track(issued.sessionId, {
        runId, eventSeq: success.eventSeq, turnId: issued.turnId, checkpoint: true, restored: true, at: now(),
      });
    }
    // Every look at the run looks at the sessions holding its wakes again:
    // closed, CLI stopped, or (after a restart) idle by now.
    const sessionsHolding = [...handedOver].filter(([, list]) => list.some((entry) => entry.runId === runId)).map(([id]) => id);
    for (const sessionId of sessionsHolding) settle(sessionId);
    const pending = pendingV3MainWakes({
      events,
      dag: run.dag,
      markedSince,
      isIssued: (seq) => readV3MainWakeIssued(runDir, seq) !== undefined,
    });
    // In journal order: the main session sees them in order, each as its own
    // turn — once one is handed over the session has a wake in flight, so the
    // next waits (deliverOne) until that turn ended.
    for (const event of pending) {
      const key = keyOf(runId, event.eventSeq);
      if (inFlight.has(key)) continue;
      if (deliveredUnrecorded.has(key)) {
        deps.warn(`[workflow-wake:${runId}] wake ${event.eventSeq} already ran without its record; not delivered again`);
        continue;
      }
      // A drive, an idle session or a restart (not a timer) starts over.
      if (!opts.timed) {
        backoff.delete(key);
        gaveUp.delete(key);
      }
      if (gaveUp.has(key)) continue;
      const state = backoff.get(key);
      if (state && now() < state.nextAt) {
        ensurePoll(runId);
        continue;
      }
      inFlight.add(key);
      try {
        await deliverOne(runId, runDir, anchored, event, events);
      } catch (err) {
        if (!readV3MainWakeIssued(runDir, event.eventSeq)) {
          failed(runId, event, err instanceof Error ? err.message : String(err));
        } else {
          deps.warn(`[workflow-wake:${runId}] wake ${event.eventSeq} failed after it was issued: ${err instanceof Error ? err.message : String(err)}`);
          if (event.kind === 'checkpoint') release(runId, event.eventSeq, 'wakeNotDelivered');
        }
      } finally {
        inFlight.delete(key);
      }
    }
    // Keep looking while a checkpoint still holds (the cap above).
    if (holding.length > 0) ensurePoll(runId);
  }

  function scan(runId: string, opts: { timed?: boolean } = {}): Promise<void> {
    const previous = chains.get(runId) ?? Promise.resolve();
    const run = previous.then(() => scanOnce(runId, opts), () => scanOnce(runId, opts));
    const tail = run.then(() => undefined, () => undefined);
    chains.set(runId, tail);
    void tail.then(() => { if (chains.get(runId) === tail) chains.delete(runId); });
    return run;
  }

  return {
    scan: (runId) => scan(runId),
    coldAttach: async () => {
      for (const runId of deps.listRunIds()) {
        try {
          await scan(runId);
        } catch (err) {
          deps.warn(`[workflow-wake:${runId}] cold attach failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    onScreenStatus: (sessionId, { status, prevStatus, turnId }) => {
      const list = handedOver.get(sessionId);
      if (list && turnId && (status === 'working' || status === 'analyzing')) {
        for (const entry of list) if (entry.turnId === turnId) entry.seenRunning = true;
      }
      if (status !== 'idle' || prevStatus === 'idle') return;
      // Went idle: the end of a wake turn seen running (the fallback for CLIs
      // without a turn terminal) — not of one still queued behind the turn
      // that just ended; after a restart, idle proven now.
      endWakes(sessionId, (entry) => entry.seenRunning === true, 'wakeTurnEnded');
      settle(sessionId);
      rescanWaiting(sessionId);
    },
    onTurnEnded: (sessionId, turnId) => {
      if (!parseWorkflowEventTurnId(turnId)) return;
      endWakes(sessionId, (entry) => entry.turnId === turnId, 'wakeTurnEnded');
    },
  };
}
