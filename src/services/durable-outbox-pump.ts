import { randomUUID } from 'node:crypto';
import type {
  DurableJson,
  DurableOutboxRecord,
  DurableOutboxStore,
  OutboxAttempt,
  OutboxMutationResult,
} from './durable-coordination.js';

export type DurableOutboxSafeRetryProof = 'no_side_effect' | 'stable_target_idempotency';

export type DurableOutboxDeliveryResult =
  | { kind: 'delivered'; receipt: DurableJson }
  | {
      kind: 'retry';
      visibleAt: number;
      error: string;
      proof: DurableOutboxSafeRetryProof;
    }
  | { kind: 'ambiguous'; error: string };

export interface DurableOutboxDeliveryContext {
  attempt: OutboxAttempt;
  signal: AbortSignal;
}

export interface DurableOutboxPumpStopResult {
  kind: 'stopped' | 'timed_out';
  inFlight: number;
}

export interface DurableOutboxPump {
  readonly workerId: string;
  ready: Promise<void>;
  stop(timeoutMs?: number): Promise<DurableOutboxPumpStopResult>;
  terminate(): void;
}

export interface DurableOutboxPumpOptions {
  store: DurableOutboxStore;
  /** 生产默认值包含进程与随机 boot identity；显式值仅用于测试。 */
  workerId?: string;
  deliver(
    record: DurableOutboxRecord,
    context: DurableOutboxDeliveryContext,
  ): Promise<DurableOutboxDeliveryResult>;
  intervalMs?: number;
  reservationLeaseMs?: number;
  attemptTimeoutMs?: number;
  concurrency?: number;
  batchSize?: number;
  shutdownMs?: number;
  now?: () => number;
  onDelivered?: (record: DurableOutboxRecord) => void;
  onRetry?: (record: DurableOutboxRecord) => void;
  onAmbiguous?: (record: DurableOutboxRecord) => void;
  onLateResult?: (attempt: OutboxAttempt, result: DurableOutboxDeliveryResult | Error) => void;
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
  const workerId = (value ?? `outbox-pump:${process.pid}:${randomUUID()}`).trim();
  if (!workerId || workerId.length > 240) {
    throw new Error('durable outbox pump workerId must contain at most 240 non-empty characters');
  }
  return workerId;
}

function boundedText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) {
    throw new Error(`${name} must contain at most 2048 non-empty characters`);
  }
  return value;
}

function timeoutPromise(ms: number, controller: AbortController): Promise<{ kind: 'timed_out' }> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      // Resolve the race before abort listeners can settle the delivery promise.
      resolve({ kind: 'timed_out' });
      controller.abort(new Error('durable outbox delivery timed out'));
    }, ms);
    timer.unref?.();
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });
}

/**
 * Pump provider-neutral durable outbox attempts without binding to an IM SDK.
 *
 * The irreversible boundary is `beginOutboxAttempt`, which commits BEFORE the
 * callback can cause an external side effect. A thrown error or timeout is
 * therefore ambiguous by default. Automatic retry is accepted only through an
 * explicit typed result that states the caller proved either no side effect or
 * target-side stable idempotency.
 *
 * This service is intentionally not wired into the daemon yet. Lark payload
 * projection, stable UUID lifetime checks and Session/output admission must be
 * added at the call site before the primary runtime gate can be removed.
 */
export function startDurableOutboxPump(options: DurableOutboxPumpOptions): DurableOutboxPump {
  const workerId = workerIdFrom(options.workerId);
  const intervalMs = boundedInteger(options.intervalMs ?? 500, 'intervalMs', 10, 60_000);
  const reservationLeaseMs = boundedInteger(
    options.reservationLeaseMs ?? 60_000,
    'reservationLeaseMs',
    1_000,
    300_000,
  );
  const attemptTimeoutMs = boundedInteger(
    options.attemptTimeoutMs ?? Math.min(15_000, Math.floor(reservationLeaseMs / 2)),
    'attemptTimeoutMs',
    100,
    Math.floor(reservationLeaseMs / 2),
  );
  const concurrency = boundedInteger(options.concurrency ?? 4, 'concurrency', 1, 32);
  const batchSize = boundedInteger(options.batchSize ?? 32, 'batchSize', 1, 1_000);
  const shutdownMs = boundedInteger(options.shutdownMs ?? 5_000, 'shutdownMs', 0, 300_000);
  const now = options.now ?? Date.now;
  const slots: Slot[] = Array.from({ length: concurrency }, (_, index) => ({ index }));
  const controllers = new Set<AbortController>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let stopPromise: Promise<DurableOutboxPumpStopResult> | undefined;

  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* observers cannot alter attempt state */ }
  };

  const observe = (
    callback: ((record: DurableOutboxRecord) => void) | undefined,
    record: DurableOutboxRecord,
    label: string,
  ): void => {
    try { callback?.(record); }
    catch (error) {
      reportError(new Error(
        `durable outbox ${label} observer failed for ${record.messageId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  };

  const reportMutation = (
    mutation: OutboxMutationResult,
    attempt: OutboxAttempt,
    label: string,
    observer?: (record: DurableOutboxRecord) => void,
  ): void => {
    if (mutation.kind === 'stale') {
      reportError(new Error(`durable outbox ${label} lost attempt ${attempt.record.messageId}`));
      return;
    }
    observe(observer, mutation.record, label);
  };

  const markAmbiguous = async (attempt: OutboxAttempt, error: unknown): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    const mutation = await options.store.markOutboxAmbiguous({
      attempt,
      error: boundedText(message, 'ambiguous error'),
    });
    reportMutation(mutation, attempt, 'ambiguous', options.onAmbiguous);
  };

  const processReservation = async (reservation: Awaited<ReturnType<DurableOutboxStore['reserveNextOutbox']>>): Promise<void> => {
    if (!reservation) return;
    const begun = await options.store.beginOutboxAttempt({ reservation });
    if (begun.kind === 'stale') {
      reportError(new Error(`durable outbox begin lost reservation ${reservation.record.messageId}`));
      return;
    }
    const { attempt } = begun;
    const controller = new AbortController();
    controllers.add(controller);
    const delivery = Promise.resolve().then(() => options.deliver(
      begun.record,
      { attempt, signal: controller.signal },
    ));
    try {
      const deliveryOutcome = delivery.then(
        result => ({ kind: 'result' as const, result }),
        error => ({ kind: 'error' as const, error }),
      );
      const outcome = await Promise.race([
        deliveryOutcome,
        timeoutPromise(attemptTimeoutMs, controller),
      ]);
      if (outcome.kind === 'timed_out') {
        void delivery.then(
          result => options.onLateResult?.(attempt, result),
          error => options.onLateResult?.(
            attempt,
            error instanceof Error ? error : new Error(String(error)),
          ),
        ).catch(() => undefined);
        await markAmbiguous(attempt, new Error('delivery attempt timed out with unknown outcome'));
        return;
      }
      controller.abort(new Error('durable outbox delivery settled'));
      if (outcome.kind === 'error') {
        await markAmbiguous(attempt, new Error(
          `delivery threw with unknown outcome: `
          + `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        ));
        return;
      }
      const result = outcome.result;
      if (!result || typeof result !== 'object') {
        await markAmbiguous(attempt, new Error('delivery returned an invalid result'));
        return;
      }
      if (result.kind === 'delivered') {
        const mutation = await options.store.completeOutboxAttempt({
          attempt,
          receipt: result.receipt,
        });
        reportMutation(mutation, attempt, 'delivery', options.onDelivered);
        return;
      }
      if (result.kind === 'retry') {
        if (result.proof !== 'no_side_effect' && result.proof !== 'stable_target_idempotency') {
          await markAmbiguous(attempt, new Error('delivery retry result lacks a safety proof'));
          return;
        }
        const visibleAt = boundedInteger(result.visibleAt, 'retry visibleAt', now(), 8_640_000_000_000_000);
        const mutation = await options.store.retryOutboxAttempt({
          attempt,
          visibleAt,
          error: boundedText(result.error, 'retry error'),
        });
        reportMutation(mutation, attempt, 'retry', options.onRetry);
        return;
      }
      if (result.kind === 'ambiguous') {
        await markAmbiguous(attempt, result.error);
        return;
      }
      await markAmbiguous(attempt, new Error('delivery returned an unknown result kind'));
    } catch (error) {
      // Once beginAttempt committed, any unclassified local/provider failure is
      // result-unknown. Never downgrade it to automatic retry.
      reportError(error);
      try { await markAmbiguous(attempt, error); }
      catch (settlementError) { reportError(settlementError); }
    } finally {
      controller.abort(new Error('durable outbox attempt finished'));
      controllers.delete(controller);
    }
  };

  const drainSlot = async (slot: Slot): Promise<void> => {
    const slotWorkerId = `${workerId}:${slot.index}`;
    for (let index = 0; index < batchSize && !stopped; index++) {
      let reservation;
      try {
        reservation = await options.store.reserveNextOutbox({
          workerId: slotWorkerId,
          leaseDurationMs: reservationLeaseMs,
        });
      } catch (error) {
        reportError(error);
        return;
      }
      if (!reservation) return;
      if (reservation.workerId !== slotWorkerId) {
        reportError(new Error(
          `durable outbox provider returned a reservation owned by ${reservation.workerId}`,
        ));
        return;
      }
      await processReservation(reservation);
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
    timer = setInterval(() => { void tick().catch(reportError); }, intervalMs);
    timer.unref?.();
  };

  const ready = tick().catch(reportError).finally(installInterval);

  const terminate = (): void => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const controller of controllers) {
      controller.abort(new Error('durable outbox pump terminated'));
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
            controller.abort(new Error('durable outbox shutdown timed out'));
          }
          return { kind: 'timed_out', inFlight: running.length };
        }
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), budget);
        });
        const drained = await Promise.race([
          Promise.allSettled(running).then(() => true as const),
          timeout,
        ]);
        if (timer) clearTimeout(timer);
        if (drained) return { kind: 'stopped', inFlight: 0 };
        for (const controller of controllers) {
          controller.abort(new Error('durable outbox shutdown timed out'));
        }
        return { kind: 'timed_out', inFlight: running.length };
      })();
      return stopPromise;
    },
  };
}
