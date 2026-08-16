import type { WorkerToDaemon } from '../types.js';
import type { Session } from '../types.js';
import {
  getSkillFeedbackStore,
  type SkillFeedbackStore,
  type TurnCompletionEventPayload,
} from './skill-feedback-store.js';

export async function persistTurnTerminal(input: {
  dataDir: string;
  botAppId: string;
  session: Pick<Session, 'sessionId'>;
  terminal: Pick<Extract<WorkerToDaemon, { type: 'turn_terminal' }>, 'turnId' | 'dispatchAttempt' | 'status'>;
  store?: SkillFeedbackStore;
}): Promise<TurnCompletionEventPayload | undefined> {
  const store = input.store ?? await getSkillFeedbackStore(input.dataDir);
  return store.recordTurnTerminal({
    botAppId: input.botAppId,
    sessionId: input.session.sessionId,
    turnId: input.terminal.turnId,
    dispatchAttempt: input.terminal.dispatchAttempt,
    status: input.terminal.status,
  });
}

// ---------------------------------------------------------------------------
// Nonblocking, tracked, deduplicated turn-terminal persistence queue.
//
// The daemon's per-turn onTurnTerminal must not block the Node event loop on a
// synchronous SQLite write (node:sqlite is synchronous; a cross-process write
// lock held by a `botmux send --response-kind final` subprocess previously
// stalled the whole loop up to busy_timeout). This queue instead uses the
// store's nonblocking tryRecordTurnTerminal (busy_timeout borrowed to 0) and
// retries busy turns on a timer, yielding the loop between attempts. Work is
// tracked so graceful shutdown can drain it (fire-and-forget would drop the
// last turn's persistence if the daemon exited immediately after).
// ---------------------------------------------------------------------------

export interface EnqueueTurnTerminalInput {
  dataDir: string;
  botAppId: string;
  sessionId: string;
  terminal: Pick<Extract<WorkerToDaemon, { type: 'turn_terminal' }>, 'turnId' | 'dispatchAttempt' | 'status'>;
  onError?: (error: unknown) => void;
  /** Test/tuning knobs. */
  retryBaseMs?: number;
  maxRetryMs?: number;
  maxAttempts?: number;
}

interface PendingItem {
  input: EnqueueTurnTerminalInput;
  attempts: number;
  promise: Promise<void>;
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingItem>();
// Admission gate: once shutdown drain begins we stop accepting new work so the
// drain can reach a true quiescent point. Without this, drainTurnTerminalQueue
// only snapshots the promises live at call time, but the worker may not be
// stopped yet and onTurnTerminal could enqueue AFTER the snapshot, so the drain
// could report 0 while a just-enqueued terminal is silently skipped.
let admissionClosed = false;

function dedupeKey(i: EnqueueTurnTerminalInput): string {
  return `${i.botAppId}|${i.sessionId}|${i.terminal.turnId}|${i.terminal.dispatchAttempt ?? 0}`;
}

/**
 * Enqueue a turn terminal for nonblocking persistence. Returns a promise that
 * settles when the terminal is durably recorded (or permanently gives up after
 * maxAttempts). Re-enqueuing the same (bot,session,turn,attempt) while one is
 * in flight returns the existing promise — the write is idempotent, so a repeat
 * signal need not queue twice. But if the repeat carries a DIFFERENT terminal
 * status for the same key, that is a real conflict (the store would throw
 * turn_terminal_status_conflict on commit); surface it immediately via onError
 * instead of silently letting the first-arrived status win.
 * Never rejects: terminal failures are surfaced via onError and the promise
 * resolves so a caller awaiting drain cannot hang. After shutdown drain closes
 * admission, new enqueues are refused (surfaced via onError) — the daemon is
 * stopping and the durable outbox / next boot reconcile; accepting here would
 * race the drain and could be silently dropped.
 */
export function enqueueTurnTerminal(input: EnqueueTurnTerminalInput): Promise<void> {
  const key = dedupeKey(input);
  const existing = pending.get(key);
  if (existing) {
    if (existing.input.terminal.status !== input.terminal.status) {
      input.onError?.(new Error(
        `turn_terminal_status_conflict_enqueue:${input.terminal.turnId.slice(0, 12)}:`
        + `${existing.input.terminal.status}!=${input.terminal.status}`,
      ));
    }
    return existing.promise;
  }
  if (admissionClosed) {
    input.onError?.(new Error(`turn_terminal_persist_refused_shutdown:${input.terminal.turnId.slice(0, 12)}`));
    return Promise.resolve();
  }

  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  const item: PendingItem = { input, attempts: 0, promise, resolve };
  pending.set(key, item);
  // Kick off asynchronously so the caller's stack unwinds first (the store
  // resolve is async, and even the first attempt must not run inline).
  queueMicrotask(() => { void attempt(key); });
  return promise;
}

/** Classify an error thrown while opening the store or attempting the write.
 *  Busy/lock and transient FS pressure are recoverable (retry within bounds);
 *  schema-newer, status conflict, and corruption are permanent (give up). */
function isPermanentPersistError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  return message.includes('turn_terminal_status_conflict')
    || message.includes('skill_feedback_schema_newer')
    || message.includes('skill_feedback_schema_invalid')
    || message.includes('malformed')
    || message.includes('not a database');
}

async function attempt(key: string): Promise<void> {
  const item = pending.get(key);
  if (!item) return;
  const { input } = item;
  const maxAttempts = input.maxAttempts ?? 50;
  item.attempts += 1;
  try {
    const store = await getSkillFeedbackStore(input.dataDir);
    const result = store.tryRecordTurnTerminal({
      botAppId: input.botAppId,
      sessionId: input.sessionId,
      turnId: input.terminal.turnId,
      dispatchAttempt: input.terminal.dispatchAttempt,
      status: input.terminal.status,
    });
    if (result.done) { finish(key); return; }
    // Write lock busy: reschedule with capped backoff, yielding the loop.
    if (item.attempts >= maxAttempts) {
      input.onError?.(new Error(`turn_terminal_persist_gave_up:${input.terminal.turnId.slice(0, 12)}:busy_after_${item.attempts}`));
      finish(key);
      return;
    }
    scheduleRetry(key, item, input);
  } catch (error) {
    // A store-open failure (concurrent-migration lock, transient FS/ENOSPC) is
    // often recoverable: getSkillFeedbackStore evicts the rejected promise so
    // the next attempt reopens, and "next turn" will NOT re-enqueue this key —
    // so finishing here would permanently lose this terminal. Retry within
    // bounds; only a provably permanent error (schema newer, status conflict,
    // corruption) or exhausting the bound gives up.
    if (isPermanentPersistError(error) || item.attempts >= maxAttempts) {
      input.onError?.(error);
      finish(key);
      return;
    }
    input.onError?.(error); // surface each transient failure, but keep retrying
    scheduleRetry(key, item, input);
  }
}

function scheduleRetry(key: string, item: PendingItem, input: EnqueueTurnTerminalInput): void {
  const base = input.retryBaseMs ?? 25;
  const cap = input.maxRetryMs ?? 500;
  const delay = Math.min(base * item.attempts, cap);
  item.timer = setTimeout(() => { void attempt(key); }, delay);
  item.timer.unref?.();
}

function finish(key: string): void {
  const item = pending.get(key);
  if (!item) return;
  if (item.timer) clearTimeout(item.timer);
  pending.delete(key);
  item.resolve();
}

/**
 * Close admission and await all in-flight turn-terminal persistence, bounded by
 * timeoutMs. Called during graceful shutdown so the last turns are not lost.
 * Closing admission FIRST removes the race where a terminal enqueued after the
 * snapshot is skipped. Loops until the queue is truly empty (not a static
 * snapshot) so items rescheduled onto a backoff timer are also awaited. Returns
 * the count still pending when the bound elapsed (0 = fully drained).
 * Best-effort: a nonzero return is logged by the caller, not fatal — the
 * durable outbox and next-boot reconciliation cover anything not flushed.
 */
export async function drainTurnTerminalQueue(timeoutMs = 3000): Promise<number> {
  admissionClosed = true;
  if (pending.size === 0) return 0;
  // Keepalive: the queue's retry timers are unref'd (so they never hold the
  // process open on their own), and graceful shutdown invokes this drain from a
  // fire-and-forget SIGTERM handler that nobody awaits. Without a ref'd handle
  // the event loop could see "nothing left to do" and exit while an unref'd
  // retry is still pending, truncating the drain. Hold ONE ref'd timer for the
  // drain's lifetime and release it in finally.
  const keepalive = setInterval(() => { /* ref'd no-op: keep the loop alive during drain */ }, 1000);
  try {
    const deadline = Date.now() + timeoutMs;
    while (pending.size > 0 && Date.now() < deadline) {
      const remainingMs = Math.max(0, deadline - Date.now());
      const all = Promise.all([...pending.values()].map(item => item.promise));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), remainingMs); timer.unref?.(); });
      await Promise.race([all.then(() => 'drained' as const), timeout]);
      if (timer) clearTimeout(timer);
      // Re-check pending.size: items rescheduled onto a backoff timer (whose
      // promise was not in this snapshot's resolved set) are picked up next loop.
    }
    return pending.size;
  } finally {
    clearInterval(keepalive);
  }
}

/** Test-only: current in-flight count. */
export function __testOnly_pendingTurnTerminalCount(): number {
  return pending.size;
}

/** Test-only: reopen admission (drain closes it for the process otherwise). */
export function __testOnly_reopenTurnTerminalAdmission(): void {
  admissionClosed = false;
}
