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
 * Exactly once per event: the issuance record (main-wake-ledger.ts) is
 * written in the trigger's write-ahead hook, immediately before the turn is
 * handed to the session's worker, with the session's turn pointers at that
 * moment. Its create-once file refuses a second issue of the same event, so
 * a restart, a replayed journal or a retried delivery never wakes twice; a
 * delivery that failed before the hook wrote nothing and is retried. A busy
 * main session queues the turn behind its current one (the worker's normal
 * follow-up queue) instead of interrupting it.
 *
 * Runs that are not bot-executed are never read past their envelope.
 */

import { join } from 'node:path';

import type { V3Dag } from '../workflows/v3/dag.js';
import type { RunChatBinding } from '../workflows/v3/grill-state.js';
import { readJournal } from '../workflows/v3/journal.js';
import {
  buildV3MainWakeInstruction,
  pendingV3MainWakes,
  readV3MainWakeProducts,
  type V3MainWakeEvent,
} from '../workflows/v3/main-wake.js';
import { readV3MainWakeIssued, recordV3MainWakeIssued } from '../workflows/v3/main-wake-ledger.js';
import { isValidRunId } from '../workflows/v3/ops-projection.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import { mintWorkflowEventTurnId } from './workflow-event-turn.js';

export interface WorkflowMainWakeSessionView {
  sessionId: string;
  /** What the verifier will compare: the thread root (thread scope) or the
   *  current reply target's root (chat scope). */
  rootMessageId?: string;
  quoteTargetId?: string;
  currentReplyTargetTurnId?: string;
}

export interface WorkflowMainWakeDeps {
  baseDir(): string;
  /** This daemon's bot; only runs it owns are woken. */
  selfLarkAppId(): string | undefined;
  /** A bot-executed run's effective flow; undefined for any other run. */
  loadRun(runDir: string): { dag: V3Dag } | undefined;
  readBinding(runDir: string): RunChatBinding | undefined;
  /** The live session in the run's main topic, if any. */
  mainSessionAt(binding: RunChatBinding): { sessionId: string } | undefined;
  /** Live view of a session (read inside the write-ahead hook). */
  sessionView(sessionId: string): WorkflowMainWakeSessionView | undefined;
  /** `triggerSessionTurn` with daemon-internal controls. */
  deliver(
    request: TriggerRequest,
    internal: { stableTurnId: string; beforeDispatch: (context: { sessionId: string; workerGeneration: number }) => void },
  ): Promise<TriggerResponse>;
  /** Run ids to look at on cold attach. */
  listRunIds(): string[];
  now?(): number;
  warn(message: string): void;
  /** Re-try a failed delivery after this long (default 60 s), at most
   *  {@link WORKFLOW_MAIN_WAKE_MAX_RETRIES} times per event in a row; the next
   *  drive of the run or a restart tries again. */
  retryMs?: number;
  /** Timer seam (tests). */
  setTimer?(fn: () => void, ms: number): { unref?: () => void };
}

/** Timed re-tries of one undelivered event before waiting for the run to
 *  move (a drive) or the daemon to restart: a chat the bot left or a session
 *  that stays unrunnable should not log every minute forever. */
export const WORKFLOW_MAIN_WAKE_MAX_RETRIES = 5;

export interface WorkflowMainWake {
  /** Issue the wakes `runId` owes. Safe to call after every drive. */
  scan(runId: string): Promise<void>;
  /** After a restart: scan every run this daemon owns. */
  coldAttach(): Promise<void>;
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

export function createWorkflowMainWake(deps: WorkflowMainWakeDeps): WorkflowMainWake {
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? 60_000;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  /** `${runId}:${seq}` being delivered by this process. */
  const inFlight = new Set<string>();
  /** One pending re-scan per run after a failed delivery. */
  const retryTimers = new Set<string>();
  /** Timed re-tries used per undelivered event (`${runId}:${seq}`). */
  const timedRetries = new Map<string, number>();
  /** Scans of one run never overlap. */
  const chains = new Map<string, Promise<void>>();

  function scheduleRetry(runId: string, eventSeq: number): void {
    const key = `${runId}:${eventSeq}`;
    const used = timedRetries.get(key) ?? 0;
    if (used >= WORKFLOW_MAIN_WAKE_MAX_RETRIES) return;
    timedRetries.set(key, used + 1);
    if (retryTimers.has(runId)) return;
    retryTimers.add(runId);
    const timer = setTimer(() => {
      retryTimers.delete(runId);
      void scan(runId, { timed: true });
    }, retryMs);
    timer.unref?.();
  }

  async function deliverOne(runId: string, runDir: string, binding: RunChatBinding & { rootMessageId: string }, event: V3MainWakeEvent, events: ReturnType<typeof readJournal>): Promise<void> {
    const turnId = mintWorkflowEventTurnId(runId, event.eventSeq);
    const request = buildWorkflowMainWakeRequest({
      runId,
      event,
      target: deliveryTarget(binding, deps.mainSessionAt(binding)),
      ...(event.kind === 'checkpoint' ? { products: readV3MainWakeProducts(events, event.nodeId) } : {}),
      receivedAt: new Date(now()).toISOString(),
    });
    let recorded = false;
    let recordError: unknown;
    const result = await deps.deliver(request, {
      stableTurnId: turnId,
      // The issuance record is the wake turn's only authority, written at
      // the last moment before the worker gets the turn — with the session's
      // turn pointers as they are now (V3MainWakeRecord). Create-once: for an
      // existing session a failed write (an event already issued) throws,
      // which aborts the dispatch before the worker sees anything. A session
      // the trigger just opened would be left half-started by a throw, so that
      // turn goes ahead without its record instead: every run command in it is
      // refused (fail closed) and the failure is logged below.
      beforeDispatch: ({ sessionId }) => {
        const view = deps.sessionView(sessionId);
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
          if (request.target.sessionId) throw err;
          recordError = err;
        }
      },
    });
    if (result.ok) {
      if (recordError !== undefined) {
        deps.warn(`[workflow-wake:${runId}] wake ${event.eventSeq} started in a new session without its issuance record (its run commands will be refused): ${recordError instanceof Error ? recordError.message : String(recordError)}`);
      }
      return;
    }
    if (recorded || readV3MainWakeIssued(runDir, event.eventSeq)) {
      // Issued (here or by an overlapping delivery) but the turn did not
      // start: never re-issued, so say so instead of failing silently.
      deps.warn(`[workflow-wake:${runId}] wake ${event.eventSeq} was issued but did not start: ${result.errorCode ?? ''} ${result.error ?? ''}`.trim());
      return;
    }
    deps.warn(`[workflow-wake:${runId}] wake ${event.eventSeq} not delivered (${result.errorCode ?? 'error'}: ${result.error ?? ''}); retrying`);
    scheduleRetry(runId, event.eventSeq);
  }

  async function scanOnce(runId: string, opts: { timed?: boolean }): Promise<void> {
    if (!isValidRunId(runId)) return;
    const self = deps.selfLarkAppId();
    if (!self) return;
    const runDir = join(deps.baseDir(), runId);
    const run = deps.loadRun(runDir);
    if (!run) return;
    const binding = deps.readBinding(runDir);
    if (!binding || binding.larkAppId !== self || !binding.chatId || !binding.rootMessageId) return;
    const anchored = binding as RunChatBinding & { rootMessageId: string };
    const events = readJournal(join(runDir, 'journal.ndjson'));
    const pending = pendingV3MainWakes({
      events,
      dag: run.dag,
      isIssued: (seq) => readV3MainWakeIssued(runDir, seq) !== undefined,
    });
    // In journal order, one at a time: the main session sees them in order.
    for (const event of pending) {
      const key = `${runId}:${event.eventSeq}`;
      if (inFlight.has(key)) continue;
      // A drive or a restart (not a timer) starts the re-try budget over.
      if (!opts.timed) timedRetries.delete(key);
      inFlight.add(key);
      try {
        await deliverOne(runId, runDir, anchored, event, events);
      } catch (err) {
        deps.warn(`[workflow-wake:${runId}] wake ${event.eventSeq} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!readV3MainWakeIssued(runDir, event.eventSeq)) scheduleRetry(runId, event.eventSeq);
      } finally {
        inFlight.delete(key);
      }
    }
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
  };
}
