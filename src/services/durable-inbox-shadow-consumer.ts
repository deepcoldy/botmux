import type { DurableInboxStore, InboxClaim } from './durable-coordination.js';
import {
  observeDurableLarkMessageClaim,
  type DurableLarkMessageObservation,
} from './durable-inbox-shadow.js';

export interface DurableInboxShadowConsumer {
  ready: Promise<void>;
  stop(timeoutMs?: number): Promise<void>;
  terminate(): void;
}

export interface DurableInboxShadowConsumerOptions {
  store: DurableInboxStore;
  workerId: string;
  intervalMs?: number;
  leaseDurationMs?: number;
  retryDelayMs?: number;
  batchSize?: number;
  shutdownMs?: number;
  now?: () => number;
  observe?: (claim: InboxClaim) => DurableLarkMessageObservation;
  onObserved?: (observation: DurableLarkMessageObservation) => void;
  onError?: (error: unknown) => void;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Drain and validate the durable inbox while the existing SQLite route remains
 * authoritative. This consumer intentionally performs no user-visible work:
 * completing a row only proves claim ordering, provider fencing and envelope
 * compatibility before a later primary consumer is allowed to own routing.
 */
export function startDurableInboxShadowConsumer(
  options: DurableInboxShadowConsumerOptions,
): DurableInboxShadowConsumer {
  const workerId = options.workerId.trim();
  if (!workerId || workerId.length > 256) {
    throw new Error('durable inbox shadow workerId must contain at most 256 non-empty characters');
  }
  const intervalMs = boundedInteger(options.intervalMs ?? 1_000, 'intervalMs', 10, 60_000);
  const leaseDurationMs = boundedInteger(
    options.leaseDurationMs ?? 60_000,
    'leaseDurationMs',
    1_000,
    300_000,
  );
  const retryDelayMs = boundedInteger(options.retryDelayMs ?? 30_000, 'retryDelayMs', 1_000, 3_600_000);
  const batchSize = boundedInteger(options.batchSize ?? 32, 'batchSize', 1, 1_000);
  const now = options.now ?? Date.now;
  const observe = options.observe ?? observeDurableLarkMessageClaim;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    for (let index = 0; index < batchSize && !stopped; index++) {
      const claim = await options.store.claimNextInbox({ workerId, leaseDurationMs });
      if (!claim) return;
      if (claim.workerId !== workerId) {
        throw new Error(`durable inbox provider returned a claim owned by ${claim.workerId}`);
      }
      let observation: DurableLarkMessageObservation;
      try {
        observation = observe(claim);
      } catch (error) {
        options.onError?.(error);
        const retry = await options.store.retryInboxClaim({
          claim,
          visibleAt: now() + retryDelayMs,
        });
        if (retry.kind === 'stale') {
          options.onError?.(new Error(`durable inbox shadow retry lost claim ${claim.event.eventId}`));
        }
        continue;
      }
      const completed = await options.store.completeInboxClaim(claim);
      if (completed.kind === 'stale') {
        options.onError?.(new Error(`durable inbox shadow completion lost claim ${claim.event.eventId}`));
        continue;
      }
      options.onObserved?.(observation);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = drain().finally(() => { running = undefined; });
    await running;
  };

  const installInterval = (): void => {
    if (stopped || timer) return;
    timer = setInterval(() => {
      void tick().catch(error => options.onError?.(error));
    }, intervalMs);
    timer.unref?.();
  };

  const ready = (async () => {
    try {
      await tick();
    } catch (error) {
      options.onError?.(error);
    } finally {
      installInterval();
    }
  })();

  const terminate = (): void => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return {
    ready,
    terminate,
    stop: async (timeoutMs?: number) => {
      terminate();
      const pending = running;
      const budget = timeoutMs ?? options.shutdownMs ?? 5_000;
      if (pending && budget > 0) {
        await Promise.race([
          pending,
          new Promise<void>(resolve => { setTimeout(resolve, budget); }),
        ]);
      }
    },
  };
}
