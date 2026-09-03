/**
 * Inbound-webhook idempotency: collapse an at-least-once upstream's DUPLICATE
 * delivery of the SAME event into a single dispatched turn.
 *
 * WHY THIS IS NOT `idempotency-store.ts`. The repo already has a hardened
 * at-most-once dispatch lease (reserved→attempting, file-locked CAS, boot
 * reconcile) keyed on `options.idempotencyKey`. Its scope lock (trigger-types.ts)
 * admits only a fresh async-virtual trigger: `asyncReturnSessionId` with no
 * `sessionId` / `rootMessageId` / `chatId`, and no wait/dryRun. Exactly ONE
 * webhook shape can satisfy that — dynamic mode with `?async=1` and no chat
 * supplied (verified: that shape validates, while fixed-group, dynamic-with-chat,
 * new-group, plain and wait all return 400). Reusing the lease for that sliver
 * would give one webhook feature two different guarantees depending on the
 * connector's mode, and widening the lock is a separate high-risk change its own
 * comment defers to another PR. So this module solves the strictly weaker,
 * strictly local problem across the WHOLE matrix: "have I already accepted this
 * exact event id?" — at the trusted webhook edge, before any dispatch.
 *
 * GUARANTEE (deliberately weaker than the daemon lease — read this before
 * relying on it). This is a best-effort in-process dedup window, the same
 * strength as the neighbouring HMAC `replayNonces` guard: it collapses the
 * retry storms that actually happen (an upstream re-POSTing seconds to minutes
 * later, e.g. the 33.5s gap in the report that prompted this) and is LOST on
 * dashboard restart. It is not durable at-most-once across a crash. It is
 * deliberately not a file-locked store: the webhook edge is a latency-sensitive
 * hot path (the same reporter asked, in the same thread, for webhook latency to
 * be reduced), and a per-request lock+fsync would tax every honest delivery to
 * defend against a rarer duplicate. Single dashboard process serves /webhook
 * (fleet-runtime resolveDashboardSpec), so one Map covers all inbound traffic.
 *
 * FAIL-OPEN ON AMBIGUITY (opposite of the daemon lease, on purpose). Same key +
 * same body ⇒ provably the same event ⇒ suppress. Same key + DIFFERENT body ⇒
 * the upstream's key is not a reliable unique id (its bug), so we DISPATCH and
 * only record the collision. Dropping a real event (a production alert) is worse
 * than running a duplicate turn — the cost of a duplicate here is "one extra
 * review session", by the reporter's own assessment. The daemon lease answers
 * 409 in this case because it guards money-like at-most-once semantics; this
 * edge guards "never lose an event", so the two must diverge.
 */
import { createHash } from 'node:crypto';

/** How long a delivered key is remembered. Covers realistic upstream retry
 *  ladders (seconds → a few minutes) without letting the map grow forever. */
export const WEBHOOK_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/** Hard cap on remembered keys. A single connector under an alert storm must not
 *  be able to grow this without bound; the oldest entries are dropped first
 *  (insertion-ordered Map ⇒ oldest-first iteration). */
export const WEBHOOK_IDEMPOTENCY_MAX_ENTRIES = 10_000;

/** Upper bound on an accepted key. Mirrors `options.idempotencyKey`'s 200-char
 *  limit so the two contracts can't disagree about what is a usable key. */
export const WEBHOOK_IDEMPOTENCY_MAX_KEY_LENGTH = 200;

/** Hard bound on singleflight waiters parked on ONE reservation. A same-key retry
 *  storm would otherwise pile up a resolver + timer per request for up to the full
 *  window. Past the bound a duplicate is answered `overloaded` — an explicit
 *  verdict, NOT a fake owner-failure: returning "owner failed" would send the
 *  caller straight back into `inspect`, which would immediately be over the bound
 *  again, spinning a microtask hot loop that can starve the owner's own I/O. */
export const WEBHOOK_IDEMPOTENCY_MAX_WAITERS = 64;

interface Entry {
  /** sha256 of the raw request body — binds the key to the event it named. */
  bodyHash: string;
  /** Identity of the CURRENT reservation occupying this slot. A `settle` must
   *  present the same token or it is ignored. Without this, an ABA is possible:
   *  reservation A hangs past the TTL → the slot is reclaimed → a retry creates
   *  reservation B → A's late settle lands on B, because `inFlight` alone cannot
   *  tell the two apart. Verified by probe before this existed: a late failure
   *  DELETED B (letting a concurrent duplicate through) and a late success wrote
   *  A's triggerId into B (pointing duplicates at the wrong turn). */
  token: number;
  /** triggerId of the FIRST accepted delivery, echoed to later duplicates so the
   *  caller can reconcile a suppressed retry against the turn that really ran.
   *  Absent while the first delivery is still in flight (see `inFlight`). */
  triggerId?: string;
  /** True between "accepted for dispatch" and "dispatch returned". A concurrent
   *  duplicate arriving in this window must be suppressed too: the very condition
   *  that makes an upstream retry — a slow/timed-out first request — is also the
   *  condition under which the two deliveries OVERLAP, so a
   *  commit-only-after-dispatch design would let exactly the intended case
   *  through. Empirically verified: without this, two simultaneous duplicates
   *  both dispatched. */
  inFlight: boolean;
  /** Resolvers for duplicates parked on this reservation (singleflight). */
  waiters?: Array<(outcome: JoinOutcome) => void>;
  expiresAt: number;
}

/** Why a singleflight wait ended. Distinct cases demand OPPOSITE handling, so they
 *  must not collapse into one nullable value:
 *   - `ran`      → the first delivery dispatched; fold this duplicate onto it (2xx).
 *   - `released` → it failed / was reclaimed; the event did NOT run, so the waiter
 *                  must RE-INSPECT and may take over as the new owner.
 *   - `aborted`  → OUR client hung up. Stop; do not re-inspect and do not dispatch
 *                  (re-inspecting could make a disconnected request become `first`
 *                  and dispatch, defeating the cancellation). Never touches owner state. */
export type JoinOutcome =
  | { kind: 'ran'; triggerId: string }
  | { kind: 'released' }
  | { kind: 'aborted' };

/** Monotonic source for reservation tokens. Process-local and never reused, so a
 *  token can only ever identify one reservation. */
let nextToken = 1;

export type WebhookIdempotencyDecision =
  /** No key presented, the feature is off for this connector, or the window is at
   *  capacity — behave exactly as if no key had been supplied. */
  | { kind: 'disabled' }
  /** First time this key is seen: RESERVED for this request. The caller must
   *  dispatch and then call `settle` exactly once, passing `token` back so a
   *  reservation that has since been reclaimed cannot be settled by its
   *  predecessor (success → keep as a dedup record; failure → release). */
  | { kind: 'first'; key: string; token: number }
  /** Same key, same body, and the first delivery has ALREADY COMPLETED
   *  successfully. Safe to answer 2xx immediately: the event provably ran. */
  | { kind: 'duplicate'; key: string; firstTriggerId: string }
  /** Same key, same body, but the first delivery is STILL IN FLIGHT — its outcome
   *  is unknown. Must NOT be ACKed as handled: if that first delivery then fails,
   *  a sender that stopped retrying because of our 2xx has lost the event.
   *
   *  `join(signal?)` waits for the real outcome, bounded by the owner
   *  reservation's own deadline (eviction is lazy, so a bare await on a dispatch
   *  that never returns would hang forever) and cancellable via `signal` when our
   *  own client disconnects. See JoinOutcome for how each result must be handled. */
  | { kind: 'in_flight'; key: string; join: (signal?: AbortSignal) => Promise<JoinOutcome> }
  /** Too many duplicates already parked on this reservation. The caller should
   *  answer a RETRYABLE non-2xx (e.g. 503) so the sender comes back later; it must
   *  not dispatch, and must not spin re-inspecting. */
  | { kind: 'overloaded'; key: string }
  /** Same key, different body: the key is not a reliable id. Caller DISPATCHES
   *  anyway (fail-open) — `kind` exists so the caller can log the anomaly. */
  | { kind: 'conflict'; key: string };

/** Per-connector windows, so two connectors can never collide on a key string
 *  (each upstream mints ids in its own namespace). */
const windows = new Map<string, Map<string, Entry>>();

export function hashWebhookBody(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** Resolve and clear an entry's singleflight waiters. */
function releaseWaiters(entry: Entry, outcome: JoinOutcome): void {
  const waiters = entry.waiters;
  if (!waiters?.length) return;
  entry.waiters = [];
  for (const resolve of waiters) resolve(outcome);
}

/** Drop expired entries, then trim settled entries down to the cap.
 *
 *  The expiry sweep is a FULL scan, deliberately. An earlier version broke at the
 *  first live entry on the theory that "TTL is uniform, so expired entries form a
 *  prefix" — that is false: a successful `settle` extends `expiresAt` without
 *  moving the entry in the Map, so insertion order and expiry order diverge.
 *  Verified by probe: an entry inserted second and never settled stayed blocked
 *  past its own deadline because the loop broke at a still-live entry inserted
 *  first. The window is capped, so a full scan is bounded.
 *
 *  The two loops treat an `inFlight` reservation DIFFERENTLY:
 *
 *  - Expiry (time-based): the reservation is reclaimed. This is a deliberate
 *    FAIL-OPEN trade, not a proof of inactivity — the dashboard→daemon call
 *    carries no timeout (`proxyToDaemon` passes no signal), so a wedged dispatch
 *    may never return, or may return after the window. Holding the slot forever
 *    would permanently swallow every retry of that event (probe: still
 *    `duplicate` at TTL x 10000), so past the window we accept a possible second
 *    delivery rather than guarantee event loss. A reclaimed slot cannot be
 *    corrupted by its predecessor's late settle, because `settle` is token-gated.
 *  - Capacity (pressure-based): volume is NOT evidence that a dispatch finished,
 *    so an in-flight reservation is never preempted here. Doing so would let an
 *    alert storm reopen the concurrent/abort double-dispatch hole. When every
 *    entry is in flight there is nothing to reclaim, and `inspect` degrades to
 *    `disabled` rather than growing the window without bound. */
function evict(win: Map<string, Entry>, now: number, room: number): void {
  for (const [key, entry] of win) {
    if (entry.expiresAt <= now) {
      win.delete(key);
      // A reclaimed in-flight reservation may have singleflight waiters; they must
      // learn the event did not run rather than be left hanging.
      releaseWaiters(entry, { kind: 'released' });
    }
  }
  let overflow = win.size - WEBHOOK_IDEMPOTENCY_MAX_ENTRIES + room;
  if (overflow <= 0) return;
  for (const [key, entry] of win) {
    if (entry.inFlight) continue;
    win.delete(key);
    if (--overflow <= 0) break;
  }
}

/**
 * Classify an inbound delivery and, for a `first` verdict, RESERVE the key for
 * this request in the same step.
 *
 * Reserving here (rather than after dispatch) is what makes a CONCURRENT
 * duplicate collapse: an upstream retries precisely because the first request was
 * slow or timed out, which is also when the two deliveries overlap. Node runs this
 * function to completion without interleaving, so check-and-reserve is atomic with
 * respect to other in-flight requests.
 *
 * The reservation is provisional: the caller MUST call `settleWebhookIdempotency`,
 * which either keeps it (dispatch succeeded) or releases it (dispatch failed, so
 * the sender's retry must still be able to run the event).
 */
export function inspectWebhookIdempotency(
  connectorId: string,
  key: string | undefined,
  rawBody: Buffer,
  now: number = Date.now(),
): WebhookIdempotencyDecision {
  const trimmed = key?.trim();
  if (!trimmed || trimmed.length > WEBHOOK_IDEMPOTENCY_MAX_KEY_LENGTH) return { kind: 'disabled' };
  let win = windows.get(connectorId);
  if (!win) {
    win = new Map<string, Entry>();
    windows.set(connectorId, win);
  }
  const existing = win.get(trimmed);
  // Make room for ONE new key when this is not an existing slot, so the cap is a
  // real bound rather than a target that steady-state overshoots by one.
  evict(win, now, existing ? 0 : 1);
  const bodyHash = hashWebhookBody(rawBody);
  const current = win.get(trimmed);
  if (current) {
    if (current.bodyHash !== bodyHash) return { kind: 'conflict', key: trimmed };
    if (current.inFlight) {
      // Outcome unknown — hand back a bounded, cancellable join instead of an ACK.
      if ((current.waiters?.length ?? 0) >= WEBHOOK_IDEMPOTENCY_MAX_WAITERS) {
        return { kind: 'overloaded', key: trimmed };
      }
      const deadlineMs = Math.max(0, current.expiresAt - now);
      const owner = current;
      const join = (signal?: AbortSignal) => new Promise<JoinOutcome>(resolve => {
        let done = false;
        const finish = (outcome: JoinOutcome) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          const list = owner.waiters;
          if (list) {
            const i = list.indexOf(finish);
            if (i >= 0) list.splice(i, 1);   // drop our own resolver, never the owner's slot
          }
          resolve(outcome);
        };
        const onAbort = () => finish({ kind: 'aborted' });
        // Past the owner's deadline the slot is reclaimable, so stop waiting and
        // let the caller re-inspect (it may become the new owner).
        const timer = setTimeout(() => finish({ kind: 'released' }), deadlineMs);
        // Don't hold the process open for a waiter (dashboard shutdown, tests).
        (timer as unknown as { unref?: () => void }).unref?.();
        (owner.waiters ??= []).push(finish);
        if (signal?.aborted) finish({ kind: 'aborted' });
        else signal?.addEventListener?.('abort', onAbort);
      });
      return { kind: 'in_flight', key: trimmed, join };
    }
    return { kind: 'duplicate', key: trimmed, firstTriggerId: current.triggerId! };
  }
  // Capacity is a REAL bound. `evict` cannot make room when every entry is still
  // in flight (it refuses to preempt those), so rather than growing without limit
  // we stop TRACKING new keys: `disabled` means this delivery is dispatched exactly
  // as it would be with no key at all — degraded dedup, never a lost event.
  if (win.size >= WEBHOOK_IDEMPOTENCY_MAX_ENTRIES) return { kind: 'disabled' };
  const token = nextToken++;
  win.set(trimmed, { bodyHash, token, inFlight: true, expiresAt: now + WEBHOOK_IDEMPOTENCY_TTL_MS });
  return { kind: 'first', key: trimmed, token };
}

/**
 * Resolve a reservation made by `inspectWebhookIdempotency`.
 *
 * `token` must be the one handed out with the reservation. A mismatch means this
 * slot now holds a DIFFERENT reservation (the original expired and was reclaimed,
 * then a retry re-reserved it), so the call is ignored — a late settle must never
 * delete or relabel its successor (ABA).
 *
 * `triggerId` present ⇒ the dispatch ran; the record is kept (with the id to echo
 * to later duplicates) for the rest of the TTL.
 *
 * `triggerId` undefined ⇒ the dispatch failed or never happened; the reservation
 * is released so a retry of the same event can run. Never remembering a failure is
 * deliberate: the event did not happen, and an at-least-once sender's retry is the
 * recovery path.
 */
export function settleWebhookIdempotency(
  connectorId: string,
  key: string,
  token: number,
  triggerId: string | undefined,
  now: number = Date.now(),
): void {
  const win = windows.get(connectorId);
  const entry = win?.get(key);
  if (!win || !entry || !entry.inFlight || entry.token !== token) return;
  if (!triggerId) {
    win.delete(key);
    // Waiters must learn the failure, or a duplicate parked on this reservation
    // would wait out the whole window for an event that will never run.
    releaseWaiters(entry, { kind: 'released' });
    return;
  }
  entry.inFlight = false;
  entry.triggerId = triggerId;
  entry.expiresAt = now + WEBHOOK_IDEMPOTENCY_TTL_MS;
  releaseWaiters(entry, { kind: 'ran', triggerId });
}

/** Test-only: drop all remembered keys (module state is process-global). */
export function __testOnly_resetWebhookIdempotency(): void {
  windows.clear();
}

/**
 * Did this dispatch outcome cross the "the turn is running" barrier?
 *
 * `body.ok` is NOT the right question. `waitForSessionFinalOutput` calls
 * `dispatchTurn()` FIRST and only then waits for the final output, so a
 * `wait_timeout` (HTTP 504) reports `ok:false` about a turn that was already
 * forked and is very likely still running. Releasing the key there let an upstream
 * retry the 504 and run the event a second time.
 *
 * Kept in this module (not inline at the call site) so the classification lives
 * next to the semantics it protects and is unit-testable on its own.
 */
export function dispatchDidRun(body: { ok?: boolean; errorCode?: string; triggerId?: string }): boolean {
  if (body.ok) return true;
  // Proven dispatched: the wait timed out, not the dispatch. The triggerId is the
  // turn that is running, so a retry must fold onto it.
  if (body.errorCode === 'wait_timeout' && body.triggerId) return true;
  // Everything else (daemon_offline, bad_request, target_required, bot_not_found,
  // trigger_failed, no_output …) is either provably pre-dispatch or genuinely
  // commit-unknown. For those we keep the fail-open stance the rest of this module
  // takes: release, and accept a possible second delivery rather than risk losing
  // an event that never ran.
  return false;
}
