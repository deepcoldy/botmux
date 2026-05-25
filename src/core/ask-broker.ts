/**
 * In-memory broker for `botmux ask` (v0.1.7).
 *
 * Holds the pending-ask registry, runs the deadline timers, and arbitrates
 * click resolution. IM-agnostic: the im/lark side wires a dispatcher via
 * `setCardDispatcher` so the broker doesn't import Lark types.
 *
 * §3 / §6 / §7 / §8 of /tmp/botmux-ask.md.
 */

import { randomUUID } from 'node:crypto';

import { logger } from '../utils/logger.js';
import type {
  AskCardDispatcher,
  AskClickOutcome,
  AskResult,
  CreateAskInput,
  PendingAsk,
} from './ask-types.js';

interface InternalPending extends PendingAsk {
  resolve: (result: AskResult) => void;
  timeoutHandle: NodeJS.Timeout;
  /** epoch ms when settle ran; undefined while still pending. */
  settledAt?: number;
}

const pending = new Map<string, InternalPending>();
let dispatcher: AskCardDispatcher | null = null;

/** Window during which a settled ask is still queryable so race-losers get a
 *  precise `already_settled` outcome (and the card click handler can show
 *  "已被 X 答了" instead of a generic "已失效"). After this window expires,
 *  late clicks fall through to `stale` like any forgotten id. */
const SETTLED_RETENTION_MS = 60_000;

/** Wire the IM-side dispatcher. Called once during daemon bootstrap from
 *  daemon.ts after im/lark/ask-card.ts is constructed. */
export function setCardDispatcher(d: AskCardDispatcher): void {
  dispatcher = d;
}

/** Register a new pending ask. Returns a Promise that settles when:
 *   - a valid click arrives (`kind:'answered'`)
 *   - the deadline elapses (`kind:'timedOut'`)
 *   - the broker invalidates the ask (`kind:'invalidated'`)
 *
 *  Side effects:
 *   - generates askId + nonce
 *   - starts the deadline timer
 *   - dispatches the card; if the card send fails, the ask is immediately
 *     invalidated and the Promise settles with `kind:'invalidated'`.
 *
 *  Throws synchronously only if no dispatcher has been wired — that's a
 *  daemon-misconfiguration bug, not a runtime ask failure.
 */
export function registerAsk(input: CreateAskInput): Promise<AskResult> {
  if (!dispatcher) {
    throw new Error('ask-broker: cardDispatcher not wired — daemon bootstrap bug');
  }

  const askId = randomUUID();
  const nonce = randomUUID().slice(0, 8);
  const createdAt = Date.now();
  const deadlineAt = createdAt + input.timeoutMs;

  return new Promise<AskResult>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      settle(askId, {
        kind: 'timedOut',
        selected: null,
        by: null,
        comment: null,
        timedOut: true,
      });
    }, input.timeoutMs);
    // Don't keep the event loop alive just because an ask is pending.
    timeoutHandle.unref?.();

    const ask: InternalPending = {
      askId,
      nonce,
      larkAppId: input.larkAppId,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      sessionId: input.sessionId,
      approvers: input.approvers,
      options: input.options,
      prompt: input.prompt,
      createdAt,
      deadlineAt,
      settled: false,
      resolve,
      timeoutHandle,
    };
    pending.set(askId, ask);

    // Card dispatch is async — store the messageId once it lands.
    void dispatcher!
      .send(snapshot(ask))
      .then(({ messageId }) => {
        const cur = pending.get(askId);
        if (cur && !cur.settled) cur.cardMessageId = messageId;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn?.(`ask-broker: ${askId} card dispatch failed: ${msg}`);
        settle(askId, {
          kind: 'invalidated',
          reason: `card dispatch failed: ${msg}`,
          selected: null,
          by: null,
          comment: null,
          timedOut: false,
        });
      });
  });
}

/** Resolve attempt from a card-button click. Returns one of the §10 outcomes;
 *  caller (card click handler) maps to user-facing toast.
 *
 *  All four "no-op" outcomes (`unauthorized`/`stale`/`already_settled`) leave
 *  the broker state unchanged so the original CLI Promise keeps waiting for
 *  the real winner or the deadline. */
export function tryResolveAsk(args: {
  askId: string;
  nonce: string;
  selected: string;
  by: string;
}): AskClickOutcome {
  gcSettled();
  const ask = pending.get(args.askId);
  if (!ask) return 'stale';                       // unknown id (daemon restart, GC'd, etc.)
  if (ask.nonce !== args.nonce) return 'stale';   // replayed click from a previous card
  if (ask.settled) return 'already_settled';      // race loser, still within retention window
  if (!ask.approvers.has(args.by)) return 'unauthorized';
  if (!ask.options.some((o) => o.key === args.selected)) return 'stale';

  settle(args.askId, {
    kind: 'answered',
    selected: args.selected,
    by: args.by,
    comment: null,
    timedOut: false,
  });
  return 'accepted';
}

/** Invalidate every pending ask. Intended for daemon shutdown / restart paths
 *  so CLI subprocesses unblock with `kind:'invalidated'` instead of waiting
 *  forever on a dead daemon. Returns the number of asks actually settled
 *  (settled-but-retained entries from the race window are skipped). */
export function invalidateAll(reason: string): number {
  const ids = [...pending.entries()]
    .filter(([, ask]) => !ask.settled)
    .map(([id]) => id);
  for (const id of ids) {
    settle(id, {
      kind: 'invalidated',
      reason,
      selected: null,
      by: null,
      comment: null,
      timedOut: false,
    });
  }
  if (ids.length > 0) {
    logger.info?.(`ask-broker: invalidated ${ids.length} pending ask(s): ${reason}`);
  }
  return ids.length;
}

/** Internal — settle an ask exactly once and notify the dispatcher's onSettle
 *  hook (best-effort, never blocks broker state transitions). The settled
 *  entry stays in the map for `SETTLED_RETENTION_MS` so late race-losers get
 *  a precise `already_settled` outcome; `gcSettled` reaps it afterward. */
function settle(askId: string, result: AskResult): void {
  const ask = pending.get(askId);
  if (!ask || ask.settled) return;
  ask.settled = true;
  ask.settledAt = Date.now();
  clearTimeout(ask.timeoutHandle);
  // Reap older settled entries opportunistically — keeps the map bounded
  // without paying for a dedicated GC timer.
  gcSettled();

  try {
    ask.resolve(result);
  } catch (err) {
    logger.warn?.(
      `ask-broker: ${askId} resolve threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (dispatcher?.onSettle) {
    try {
      void Promise.resolve(dispatcher.onSettle(snapshot(ask), result)).catch((err) => {
        logger.warn?.(
          `ask-broker: ${askId} onSettle failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } catch (err) {
      logger.warn?.(
        `ask-broker: ${askId} onSettle threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Strip broker-internal fields before handing a snapshot to the IM-side
 *  dispatcher. Keeps the dispatcher contract narrow. */
function snapshot(ask: InternalPending): PendingAsk {
  const { resolve: _r, timeoutHandle: _t, settledAt: _sat, ...rest } = ask;
  return rest;
}

/** Drop settled entries that have aged past the retention window. Cheap O(n)
 *  walk — n is tiny in practice (≤ a few dozen pending+recent asks). */
function gcSettled(): void {
  const cutoff = Date.now() - SETTLED_RETENTION_MS;
  for (const [id, ask] of pending) {
    if (ask.settled && ask.settledAt !== undefined && ask.settledAt < cutoff) {
      pending.delete(id);
    }
  }
}

// ---- diagnostics for tests ---------------------------------------------------

/** Count of asks still awaiting a click / timeout — excludes settled entries
 *  retained within the race-loser feedback window. For tests and metrics only. */
export function _pendingCount(): number {
  let n = 0;
  for (const ask of pending.values()) if (!ask.settled) n++;
  return n;
}

/** Read a pending ask by id — for tests only. Returns a snapshot; mutating it
 *  has no effect on broker state. */
export function _getPending(askId: string): PendingAsk | undefined {
  const a = pending.get(askId);
  return a ? snapshot(a) : undefined;
}

/** Reset broker state — for tests only. Does NOT resolve outstanding promises,
 *  so tests must not call this while real CLI processes might be waiting. */
export function _resetForTest(): void {
  for (const ask of pending.values()) clearTimeout(ask.timeoutHandle);
  pending.clear();
  dispatcher = null;
}
