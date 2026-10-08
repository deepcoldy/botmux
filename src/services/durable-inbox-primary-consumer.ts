import { randomUUID } from 'node:crypto';
import type { DurableInboxStore, InboxClaim } from './durable-coordination.js';
import {
  parseDurableLarkMessageClaim,
  type DurableLarkMessageClaim,
} from './durable-inbox-shadow.js';

export type DurableInboxPrimaryDispatchResult =
  | { kind: 'committed' }
  | { kind: 'ignored'; reason: string };

export interface DurableInboxPrimaryDispatchContext {
  claim: InboxClaim;
  signal: AbortSignal;
}

export interface DurableInboxPrimaryCommit {
  message: DurableLarkMessageClaim;
  result: DurableInboxPrimaryDispatchResult;
}

export interface DurableInboxPrimaryStopResult {
  kind: 'stopped' | 'timed_out';
  inFlight: number;
}

export interface DurableInboxPrimaryConsumer {
  readonly workerId: string;
  ready: Promise<void>;
  stop(timeoutMs?: number): Promise<DurableInboxPrimaryStopResult>;
  terminate(): void;
}

export interface DurableInboxPrimaryConsumerOptions {
  store: DurableInboxStore;
  /** 生产默认值包含进程与随机 boot identity；显式值仅用于测试。 */
  workerId?: string;
  dispatch(
    message: DurableLarkMessageClaim,
    context: DurableInboxPrimaryDispatchContext,
  ): Promise<DurableInboxPrimaryDispatchResult>;
  intervalMs?: number;
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
  retryDelayMs?: number;
  concurrency?: number;
  batchSize?: number;
  shutdownMs?: number;
  now?: () => number;
  onCommitted?: (commit: DurableInboxPrimaryCommit) => void;
  onError?: (error: unknown) => void;
}

interface Slot {
  index: number;
  running?: Promise<void>;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function workerIdFrom(value: string | undefined): string {
  const workerId = (value ?? `primary-inbox:${process.pid}:${randomUUID()}`).trim();
  if (!workerId || workerId.length > 240) {
    throw new Error('durable inbox primary workerId must contain at most 240 non-empty characters');
  }
  return workerId;
}

function timeoutPromise(ms: number): { promise: Promise<false>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    promise: new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), ms);
    }),
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Provider-neutral durable inbox handler for a later primary route.
 *
 * The dispatch callback must return only after the event is durably classified
 * as committed or ignored. Merely appending work to an in-memory queue is not a
 * commit receipt. A stale/failed claim renewal aborts the callback and prevents
 * complete/retry mutations, leaving the row recoverable after its lease.
 *
 * This service deliberately does not wire itself into the daemon. The Lark ACK
 * path must first prove pre-ACK durable enqueue and the existing message router
 * must expose a real durable-admission receipt; until then `primary` stays
 * fail-closed.
 */
export function startDurableInboxPrimaryConsumer(
  options: DurableInboxPrimaryConsumerOptions,
): DurableInboxPrimaryConsumer {
  const workerId = workerIdFrom(options.workerId);
  const intervalMs = boundedInteger(options.intervalMs ?? 500, 'intervalMs', 10, 60_000);
  const leaseDurationMs = boundedInteger(
    options.leaseDurationMs ?? 60_000,
    'leaseDurationMs',
    1_000,
    300_000,
  );
  const renewalIntervalMs = boundedInteger(
    options.renewalIntervalMs ?? Math.max(250, Math.floor(leaseDurationMs / 3)),
    'renewalIntervalMs',
    100,
    leaseDurationMs - 1,
  );
  const retryDelayMs = boundedInteger(options.retryDelayMs ?? 5_000, 'retryDelayMs', 100, 3_600_000);
  const concurrency = boundedInteger(options.concurrency ?? 4, 'concurrency', 1, 32);
  const batchSize = boundedInteger(options.batchSize ?? 32, 'batchSize', 1, 1_000);
  const shutdownMs = boundedInteger(options.shutdownMs ?? 5_000, 'shutdownMs', 0, 300_000);
  const now = options.now ?? Date.now;
  const slots: Slot[] = Array.from({ length: concurrency }, (_, index) => ({ index }));
  const controllers = new Set<AbortController>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let stopPromise: Promise<DurableInboxPrimaryStopResult> | undefined;
  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* observers cannot alter claim state */ }
  };

  const processClaim = async (initialClaim: InboxClaim): Promise<void> => {
    const controller = new AbortController();
    controllers.add(controller);
    let claim = initialClaim;
    let ownershipLost = false;
    let renewing: Promise<void> | undefined;
    const loseOwnership = (error: unknown): void => {
      if (ownershipLost) return;
      ownershipLost = true;
      controller.abort(error);
      reportError(error);
    };
    const renew = (): void => {
      // Graceful stop halts NEW claims but must keep an admitted dispatch
      // fenced until it settles. Only termination/ownership loss aborts renew.
      if (ownershipLost || controller.signal.aborted || renewing) return;
      renewing = options.store.renewInboxClaim({ claim, leaseDurationMs })
        .then(result => {
          if (result.kind === 'stale') {
            loseOwnership(new Error(`durable inbox primary renewal lost claim ${claim.event.eventId}`));
            return;
          }
          if (result.claim) claim = result.claim;
        })
        .catch(error => {
          loseOwnership(new Error(
            `durable inbox primary renewal failed for ${claim.event.eventId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          ));
        })
        .finally(() => { renewing = undefined; });
    };
    const renewalTimer = setInterval(renew, renewalIntervalMs);
    renewalTimer.unref?.();

    let message: DurableLarkMessageClaim | undefined;
    try {
      message = parseDurableLarkMessageClaim(claim);
      const result = await options.dispatch(message, { claim, signal: controller.signal });
      clearInterval(renewalTimer);
      if (renewing) await renewing;
      if (ownershipLost || controller.signal.aborted) return;
      if (result.kind !== 'committed' && result.kind !== 'ignored') {
        throw new Error('durable inbox primary dispatch returned an invalid receipt');
      }
      if (result.kind === 'ignored' && (!result.reason.trim() || result.reason.length > 512)) {
        throw new Error('durable inbox primary ignored result requires a bounded reason');
      }
      const completed = await options.store.completeInboxClaim(claim);
      if (completed.kind === 'stale') {
        loseOwnership(new Error(`durable inbox primary completion lost claim ${claim.event.eventId}`));
        return;
      }
      try {
        options.onCommitted?.({ message, result });
      } catch (error) {
        reportError(new Error(
          `durable inbox primary commit observer failed for ${claim.event.eventId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    } catch (error) {
      clearInterval(renewalTimer);
      if (renewing) await renewing;
      if (ownershipLost || controller.signal.aborted) return;
      reportError(error);
      const retried = await options.store.retryInboxClaim({
        claim,
        visibleAt: now() + retryDelayMs,
      });
      if (retried.kind === 'stale') {
        reportError(new Error(`durable inbox primary retry lost claim ${claim.event.eventId}`));
      }
    } finally {
      clearInterval(renewalTimer);
      controllers.delete(controller);
    }
  };

  const drainSlot = async (slot: Slot): Promise<void> => {
    const slotWorkerId = `${workerId}:${slot.index}`;
    for (let index = 0; index < batchSize && !stopped; index++) {
      let claim: InboxClaim | undefined;
      try {
        claim = await options.store.claimNextInbox({
          workerId: slotWorkerId,
          leaseDurationMs,
        });
      } catch (error) {
        reportError(error);
        return;
      }
      if (!claim) return;
      if (claim.workerId !== slotWorkerId) {
        reportError(new Error(
          `durable inbox provider returned a claim owned by ${claim.workerId}`,
        ));
        return;
      }
      await processClaim(claim);
    }
  };

  const startSlot = (slot: Slot): Promise<void> => {
    if (slot.running) return slot.running;
    slot.running = drainSlot(slot).finally(() => { slot.running = undefined; });
    return slot.running;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    await Promise.all(slots.map(startSlot));
  };

  const installInterval = (): void => {
    if (stopped || timer) return;
    timer = setInterval(() => {
      void tick().catch(reportError);
    }, intervalMs);
    timer.unref?.();
  };

  const ready = tick().catch(error => {
    reportError(error);
  }).finally(installInterval);

  const terminate = (): void => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const controller of controllers) {
      controller.abort(new Error('durable inbox primary consumer terminated'));
    }
  };

  return {
    workerId,
    ready,
    terminate,
    stop: (timeoutMs = shutdownMs) => {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      const budget = boundedInteger(timeoutMs, 'timeoutMs', 0, 300_000);
      stopPromise = (async () => {
        const running = slots.flatMap(slot => slot.running ? [slot.running] : []);
        if (running.length === 0) return { kind: 'stopped', inFlight: 0 };
        if (budget === 0) {
          for (const controller of controllers) {
            controller.abort(new Error('durable inbox primary shutdown timed out'));
          }
          return { kind: 'timed_out', inFlight: running.length };
        }
        const timeout = timeoutPromise(budget);
        const drained = await Promise.race([
          Promise.allSettled(running).then(() => true as const),
          timeout.promise,
        ]);
        timeout.cancel();
        if (drained) return { kind: 'stopped', inFlight: 0 };
        for (const controller of controllers) {
          controller.abort(new Error('durable inbox primary shutdown timed out'));
        }
        return { kind: 'timed_out', inFlight: running.length };
      })();
      return stopPromise;
    },
  };
}
