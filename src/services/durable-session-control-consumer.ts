import { randomUUID } from 'node:crypto';
import {
  DURABLE_INBOX_LANE_SESSION_CONTROL,
  type DurableInboxStore,
  type InboxClaim,
} from './durable-coordination.js';
import {
  parseDurableLarkSessionControlClaim,
  type DurableLarkSessionControlClaim,
} from './durable-lark-session-control.js';

export type DurableSessionControlDispatchResult =
  | { kind: 'settled' }
  | { kind: 'ignored'; reason: string };

export interface DurableSessionControlDispatchContext {
  claim: InboxClaim;
  signal: AbortSignal;
}

export interface DurableSessionControlConsumerOptions {
  store: DurableInboxStore;
  /** 每次 claim 前回读；只返回当前 Pod 可以执行的 session-control 分区。 */
  ownedPartitionKeys(): readonly string[];
  /**
   * Optional failover discovery scope. Exact locally-owned partitions are
   * always attempted first; the prefix is only consulted when no exact claim
   * is available.
   */
  partitionKeyPrefix?: string;
  dispatch(
    control: DurableLarkSessionControlClaim,
    context: DurableSessionControlDispatchContext,
  ): Promise<DurableSessionControlDispatchResult>;
  workerId?: string;
  intervalMs?: number;
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
  retryDelayMs?: number;
  concurrency?: number;
  batchSize?: number;
  shutdownMs?: number;
  now?: () => number;
  onSettled?: (input: {
    control: DurableLarkSessionControlClaim;
    result: DurableSessionControlDispatchResult;
  }) => void;
  onError?: (error: unknown) => void;
}

export interface DurableSessionControlConsumerStopResult {
  kind: 'stopped' | 'timed_out';
  inFlight: number;
}

export interface DurableSessionControlConsumer {
  readonly workerId: string;
  ready: Promise<void>;
  stop(timeoutMs?: number): Promise<DurableSessionControlConsumerStopResult>;
  terminate(): void;
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

function normalizedPartitionKeys(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 10_000) {
    throw new Error('ownedPartitionKeys must return at most 10000 partitions');
  }
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || normalized.length > 1_024 || /[\r\n\0]/.test(normalized)) {
      throw new Error('ownedPartitionKeys returned an invalid partition');
    }
    unique.add(normalized);
  }
  return [...unique];
}

function timeoutPromise(ms: number): { promise: Promise<false>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    promise: new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Owner-routed control consumer。Inbox claim 只保证 lane/partition FIFO；真正的
 * Session fencing、外部副作用 attempt 和 canonical Session 提交由 dispatch 回调完成。
 * 回调只有在这些状态都持久化后才能返回 settled，不能把“已丢进内存队列”当成功。
 */
export function startDurableSessionControlConsumer(
  options: DurableSessionControlConsumerOptions,
): DurableSessionControlConsumer {
  const workerId = (
    options.workerId ?? `session-control:${process.pid}:${randomUUID()}`
  ).trim();
  if (!workerId || workerId.length > 240) {
    throw new Error('durable session control workerId must contain at most 240 non-empty characters');
  }
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
  const partitionKeyPrefix = options.partitionKeyPrefix?.trim();
  if (options.partitionKeyPrefix !== undefined
      && (!partitionKeyPrefix || partitionKeyPrefix.length > 1_024 || /[\r\n\0]/.test(partitionKeyPrefix))) {
    throw new Error('partitionKeyPrefix must contain at most 1024 non-empty characters');
  }
  const slots: Slot[] = Array.from({ length: concurrency }, (_, index) => ({ index }));
  const controllers = new Set<AbortController>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let stopPromise: Promise<DurableSessionControlConsumerStopResult> | undefined;

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
      if (ownershipLost || controller.signal.aborted || renewing) return;
      renewing = options.store.renewInboxClaim({ claim, leaseDurationMs })
        .then(result => {
          if (result.kind === 'stale') {
            loseOwnership(new Error(`durable session control renewal lost ${claim.event.eventId}`));
            return;
          }
          if (result.claim) claim = result.claim;
        })
        .catch(error => loseOwnership(new Error(
          `durable session control renewal failed for ${claim.event.eventId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )))
        .finally(() => { renewing = undefined; });
    };
    const renewalTimer = setInterval(renew, renewalIntervalMs);
    renewalTimer.unref?.();

    let control: DurableLarkSessionControlClaim | undefined;
    try {
      control = parseDurableLarkSessionControlClaim(claim);
      const result = await options.dispatch(control, { claim, signal: controller.signal });
      clearInterval(renewalTimer);
      if (renewing) await renewing;
      if (ownershipLost || controller.signal.aborted) return;
      if (result.kind !== 'settled' && result.kind !== 'ignored') {
        throw new Error('durable session control dispatch returned an invalid result');
      }
      if (result.kind === 'ignored' && (!result.reason.trim() || result.reason.length > 512)) {
        throw new Error('durable session control ignored result requires a bounded reason');
      }
      const completed = await options.store.completeInboxClaim(claim);
      if (completed.kind === 'stale') {
        loseOwnership(new Error(`durable session control completion lost ${claim.event.eventId}`));
        return;
      }
      try { options.onSettled?.({ control, result }); }
      catch (error) { reportError(error); }
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
        reportError(new Error(`durable session control retry lost ${claim.event.eventId}`));
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
        const partitionKeys = normalizedPartitionKeys(options.ownedPartitionKeys());
        if (partitionKeys.length > 0) {
          claim = await options.store.claimNextInbox({
            workerId: slotWorkerId,
            lane: DURABLE_INBOX_LANE_SESSION_CONTROL,
            partitionKeys,
            leaseDurationMs,
          });
        }
        if (!claim && partitionKeyPrefix) {
          claim = await options.store.claimNextInbox({
            workerId: slotWorkerId,
            lane: DURABLE_INBOX_LANE_SESSION_CONTROL,
            partitionKeyPrefix,
            leaseDurationMs,
          });
        }
        if (partitionKeys.length === 0 && !partitionKeyPrefix) return;
      } catch (error) {
        reportError(error);
        return;
      }
      if (!claim) return;
      if (claim.workerId !== slotWorkerId) {
        reportError(new Error(`durable session control claim belongs to ${claim.workerId}`));
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
    timer = setInterval(() => { void tick().catch(reportError); }, intervalMs);
    timer.unref?.();
  };

  const ready = tick().catch(reportError).finally(installInterval);

  const terminate = (): void => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const controller of controllers) {
      controller.abort(new Error('durable session control consumer terminated'));
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
            controller.abort(new Error('durable session control shutdown timed out'));
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
          controller.abort(new Error('durable session control shutdown timed out'));
        }
        return { kind: 'timed_out', inFlight: running.length };
      })();
      return stopPromise;
    },
  };
}
