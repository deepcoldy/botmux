import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  DurableInboxStore,
  DurableInsertResult,
  DurableSessionLeaseStore,
  SessionLease,
} from './durable-coordination.js';
import { durableLarkMessageEvent } from './durable-inbox-shadow.js';

export type DurableLarkPrimaryIngressStore = DurableInboxStore & DurableSessionLeaseStore;

export interface DurableLarkIngressLeadership {
  lease: SessionLease;
  signal: AbortSignal;
}

export interface DurableLarkPrimaryIngressStatus {
  kind: 'leader' | 'standby' | 'stopped';
  epoch?: number;
}

export interface DurableLarkPrimaryIngressStopResult {
  kind: 'stopped' | 'timed_out';
  pendingPartitions: number;
  leaseReleased: boolean;
}

export interface DurableLarkPrimaryIngress {
  readonly ownerId: string;
  readonly leaseKey: string;
  ready: Promise<void>;
  status(): DurableLarkPrimaryIngressStatus;
  enqueueBeforeAck(input: {
    eventId: string;
    partitionKey: string;
    data: unknown;
  }): Promise<Exclude<DurableInsertResult, { kind: 'conflict' }>>;
  stop(timeoutMs?: number): Promise<DurableLarkPrimaryIngressStopResult>;
  terminate(): void;
}

export interface DurableLarkPrimaryIngressOptions {
  store: DurableLarkPrimaryIngressStore;
  larkAppId: string;
  /** 生产默认值包含进程与随机 boot identity；显式值仅用于测试。 */
  ownerId?: string;
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
  leadershipProofMaxAgeMs?: number;
  electionIntervalMs?: number;
  ackTimeoutMs?: number;
  shutdownMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
  onLeadershipAcquired?: (leadership: DurableLarkIngressLeadership) => void | Promise<void>;
  onLeadershipLost?: (reason: unknown) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export class DurableLarkIngressNotLeaderError extends Error {
  override readonly name = 'DurableLarkIngressNotLeaderError';
}

export class DurableLarkIngressAckTimeoutError extends Error {
  override readonly name = 'DurableLarkIngressAckTimeoutError';
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedIdentity(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${name} must contain bounded non-empty text`);
  }
  return normalized;
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(error), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function larkMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = (value as Record<string, unknown>).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const messageId = (message as Record<string, unknown>).message_id;
  return typeof messageId === 'string' ? messageId : undefined;
}

/**
 * Own one Lark application's primary ingress lease and persist events before
 * the WS handler resolves (therefore before the SDK emits ACK).
 *
 * This component does not start a WS client itself. The leadership callbacks
 * are the only permitted place for later daemon wiring to start/stop that
 * client. Same-partition writes are chained synchronously at API entry; an ACK
 * timeout rejects the handler but leaves the actual enqueue in that chain, so a
 * redelivery becomes a duplicate instead of overtaking the original write.
 *
 * The lease reuses the public fencing primitive under a reserved key. Client
 * timestamps are strictly increasing only within one leader epoch. A later
 * store-generated sequence (or equivalent proof) is still required before the
 * daemon can claim strict ordering across leader failover.
 */
export function startDurableLarkPrimaryIngress(
  options: DurableLarkPrimaryIngressOptions,
): DurableLarkPrimaryIngress {
  const larkAppId = boundedIdentity(options.larkAppId, 'larkAppId', 256);
  if (!larkAppId.startsWith('cli_')) throw new Error('larkAppId must be a Lark application id');
  const ownerId = boundedIdentity(
    options.ownerId ?? `lark-ingress:${process.pid}:${randomUUID()}`,
    'ownerId',
    256,
  );
  const leaseKey = `botmux.ingress:lark:${larkAppId}`;
  const leaseDurationMs = boundedInteger(
    options.leaseDurationMs ?? 15_000,
    'leaseDurationMs',
    3_000,
    300_000,
  );
  const renewalIntervalMs = boundedInteger(
    options.renewalIntervalMs ?? Math.floor(leaseDurationMs / 3),
    'renewalIntervalMs',
    250,
    Math.floor(leaseDurationMs / 2),
  );
  const leadershipProofMaxAgeMs = boundedInteger(
    options.leadershipProofMaxAgeMs ?? leaseDurationMs - (renewalIntervalMs * 2),
    'leadershipProofMaxAgeMs',
    250,
    leaseDurationMs - renewalIntervalMs,
  );
  const electionIntervalMs = boundedInteger(
    options.electionIntervalMs ?? 1_000,
    'electionIntervalMs',
    100,
    60_000,
  );
  const ackTimeoutMs = boundedInteger(options.ackTimeoutMs ?? 2_000, 'ackTimeoutMs', 100, 2_500);
  const shutdownMs = boundedInteger(options.shutdownMs ?? 5_000, 'shutdownMs', 0, 300_000);
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const partitionTails = new Map<string, Promise<void>>();
  let lease: SessionLease | undefined;
  let leadershipController: AbortController | undefined;
  let leadershipProvedAt = Number.NEGATIVE_INFINITY;
  let electionTimer: NodeJS.Timeout | undefined;
  let electionRunning: Promise<void> | undefined;
  let stopPromise: Promise<DurableLarkPrimaryIngressStopResult> | undefined;
  let stopped = false;
  let lastCreatedAt = -1;
  let leadershipLoss: Promise<void> = Promise.resolve();

  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* observers cannot alter leadership */ }
  };

  const leadershipIsFresh = (): boolean => !!lease
    && !!leadershipController
    && !leadershipController.signal.aborted
    && monotonicNow() - leadershipProvedAt <= leadershipProofMaxAgeMs;

  const notifyLeadershipLost = (reason: unknown): Promise<void> => {
    const notify = async (): Promise<void> => {
      try {
        await options.onLeadershipLost?.(reason);
      } catch (error) {
        reportError(error);
      }
    };
    leadershipLoss = leadershipLoss.then(notify, notify);
    return leadershipLoss;
  };

  const clearLeadership = (reason: unknown): SessionLease | undefined => {
    const previous = lease;
    lease = undefined;
    leadershipProvedAt = Number.NEGATIVE_INFINITY;
    const controller = leadershipController;
    leadershipController = undefined;
    controller?.abort(reason);
    if (controller) void notifyLeadershipLost(reason);
    return previous;
  };

  const acceptLeadership = async (acquired: SessionLease): Promise<void> => {
    const controller = new AbortController();
    lease = acquired;
    leadershipController = controller;
    leadershipProvedAt = monotonicNow();
    try {
      await options.onLeadershipAcquired?.({ lease: acquired, signal: controller.signal });
    } catch (error) {
      const previous = clearLeadership(error);
      reportError(error);
      if (previous) {
        await leadershipLoss;
        try { await options.store.releaseSessionLease(previous); }
        catch (releaseError) { reportError(releaseError); }
      }
    }
  };

  const electOrRenew = async (): Promise<void> => {
    if (stopped) return;
    if (!lease) {
      await leadershipLoss;
      if (stopped) return;
      const acquired = await options.store.acquireSessionLease({
        sessionKey: leaseKey,
        ownerId,
        leaseDurationMs,
      });
      if (acquired.kind === 'occupied') return;
      if (stopped) {
        try { await options.store.releaseSessionLease(acquired.lease); }
        catch (error) { reportError(error); }
        return;
      }
      await acceptLeadership(acquired.lease);
      return;
    }
    const currentLease = lease;
    const currentController = leadershipController;
    const renewed = await options.store.renewSessionLease({ lease: currentLease, leaseDurationMs });
    if (stopped || lease !== currentLease || leadershipController !== currentController) return;
    if (renewed.kind === 'stale') {
      clearLeadership(new Error(`durable Lark ingress lost lease epoch ${currentLease.epoch}`));
      return;
    }
    lease = renewed.lease;
    leadershipProvedAt = monotonicNow();
  };

  const tickElection = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (electionRunning) return electionRunning;
    electionRunning = electOrRenew()
      .catch(error => {
        clearLeadership(error);
        reportError(error);
      })
      .finally(() => { electionRunning = undefined; });
    return electionRunning;
  };

  const installElectionTimer = (): void => {
    if (stopped || electionTimer) return;
    const delayMs = lease ? renewalIntervalMs : electionIntervalMs;
    electionTimer = setTimeout(() => {
      electionTimer = undefined;
      void tickElection().finally(installElectionTimer);
    }, delayMs);
    electionTimer.unref?.();
  };

  const ready = tickElection().finally(installElectionTimer);

  const enqueueBeforeAck: DurableLarkPrimaryIngress['enqueueBeforeAck'] = input => {
    if (stopped || !leadershipIsFresh()) {
      if (lease && !stopped) clearLeadership(new Error('durable Lark ingress leadership proof expired'));
      return Promise.reject(new DurableLarkIngressNotLeaderError('this process is not the current Lark ingress leader'));
    }
    const controller = leadershipController!;
    const expectedEpoch = lease!.epoch;
    let event: ReturnType<typeof durableLarkMessageEvent>;
    let partitionKey: string;
    try {
      const eventId = boundedIdentity(input.eventId, 'eventId', 1_024);
      partitionKey = boundedIdentity(input.partitionKey, 'partitionKey', 1_024);
      if (!partitionKey.startsWith(`lark-message-routing:${larkAppId}:`)) {
        throw new Error('durable Lark ingress partition does not match the application');
      }
      const messageId = larkMessageId(input.data);
      if (!messageId || !messageId.startsWith('om_') || messageId.length > 256
          || eventId !== `im.message.receive_v1:${larkAppId}:${messageId}`) {
        throw new Error('durable Lark ingress event does not match the application message identity');
      }
      const wallNow = now();
      if (!Number.isSafeInteger(wallNow) || wallNow < 0) {
        throw new Error('durable Lark ingress clock is invalid');
      }
      const createdAt = Math.max(wallNow, lastCreatedAt + 1);
      event = durableLarkMessageEvent({
        larkAppId,
        eventId,
        partitionKey,
        data: input.data,
        now: createdAt,
      });
      lastCreatedAt = createdAt;
    } catch (error) {
      return Promise.reject(error);
    }

    const previous = partitionTails.get(partitionKey) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      if (stopped || controller.signal.aborted || leadershipController !== controller
          || lease?.epoch !== expectedEpoch || !leadershipIsFresh()) {
        throw new DurableLarkIngressNotLeaderError('Lark ingress leadership changed before enqueue');
      }
      const result = await options.store.enqueueInbox(event);
      if (result.kind === 'conflict') {
        throw new Error(`durable Lark ingress conflicting duplicate ${event.eventId}`);
      }
      return result;
    });
    const tail = operation.then(() => undefined, error => {
      if (leadershipController === controller) clearLeadership(error);
      reportError(error);
    });
    partitionTails.set(partitionKey, tail);
    void tail.finally(() => {
      if (partitionTails.get(partitionKey) === tail) partitionTails.delete(partitionKey);
    });

    return waitWithTimeout(
      operation,
      ackTimeoutMs,
      new DurableLarkIngressAckTimeoutError(`durable Lark ingress enqueue exceeded ${ackTimeoutMs}ms`),
    );
  };

  const terminate = (): void => {
    stopped = true;
    if (electionTimer) clearTimeout(electionTimer);
    electionTimer = undefined;
    clearLeadership(new Error('durable Lark ingress terminated'));
  };

  return {
    ownerId,
    leaseKey,
    ready,
    enqueueBeforeAck,
    status: () => stopped
      ? { kind: 'stopped' }
      : leadershipIsFresh() && lease
        ? { kind: 'leader', epoch: lease.epoch }
        : { kind: 'standby' },
    terminate,
    stop: (timeoutMs = shutdownMs) => {
      if (stopPromise) return stopPromise;
      const budget = boundedInteger(timeoutMs, 'timeoutMs', 0, 300_000);
      stopped = true;
      if (electionTimer) clearTimeout(electionTimer);
      electionTimer = undefined;
      const deadlineMarker = Symbol('durable Lark ingress shutdown deadline');
      let deadlineTimer: NodeJS.Timeout | undefined;
      const deadline = budget === 0
        ? Promise.resolve(deadlineMarker)
        : new Promise<typeof deadlineMarker>(resolve => {
            deadlineTimer = setTimeout(() => resolve(deadlineMarker), budget);
            deadlineTimer.unref?.();
          });
      stopPromise = (async () => {
        try {
          const pending = [...partitionTails.values()];
          const activeLeadershipLoss = leadershipLoss;
          const drain = Promise.allSettled([
            ...(electionRunning ? [electionRunning] : []),
            ...pending,
            activeLeadershipLoss,
          ]);
          const drained = await Promise.race([
            drain.then(() => true),
            deadline.then(() => false),
          ]);
          if (!drained) {
            clearLeadership(new Error('durable Lark ingress shutdown timed out'));
            return {
              kind: 'timed_out',
              pendingPartitions: partitionTails.size,
              leaseReleased: false,
            };
          }
          const previous = clearLeadership(new Error('durable Lark ingress stopped'));
          const cleaned = await Promise.race([
            leadershipLoss.then(() => true),
            deadline.then(() => false),
          ]);
          if (!cleaned) {
            return { kind: 'timed_out', pendingPartitions: 0, leaseReleased: false };
          }
          if (!previous) return { kind: 'stopped', pendingPartitions: 0, leaseReleased: true };
          if (budget === 0) {
            return { kind: 'timed_out', pendingPartitions: 0, leaseReleased: false };
          }
          const release = Promise.resolve(options.store.releaseSessionLease(previous)).then(
            released => ({ kind: 'released' as const, released }),
            error => ({ kind: 'failed' as const, error }),
          );
          const outcome = await Promise.race([
            release,
            deadline.then(() => ({ kind: 'deadline' as const })),
          ]);
          if (outcome.kind === 'deadline') {
            return { kind: 'timed_out', pendingPartitions: 0, leaseReleased: false };
          }
          if (outcome.kind === 'failed') {
            reportError(outcome.error);
            return { kind: 'timed_out', pendingPartitions: 0, leaseReleased: false };
          }
          return {
            kind: 'stopped',
            pendingPartitions: 0,
            leaseReleased: outcome.released.kind === 'applied' || outcome.released.kind === 'stale',
          };
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        }
      })();
      return stopPromise;
    },
  };
}
