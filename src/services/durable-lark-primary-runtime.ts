import type { DurableCoordinationStore, OutboxAttempt } from './durable-coordination.js';
import {
  createDurableLarkCanonicalDispatch,
  type DurableLarkCanonicalDispatchOptions,
} from './durable-lark-canonical-dispatch.js';
import {
  startDurableInboxPrimaryConsumer,
  type DurableInboxPrimaryConsumer,
  type DurableInboxPrimaryStopResult,
} from './durable-inbox-primary-consumer.js';
import {
  startDurableLarkPrimaryIngress,
  type DurableLarkIngressLeadership,
  type DurableLarkPrimaryIngress,
  type DurableLarkPrimaryIngressStatus,
  type DurableLarkPrimaryIngressStopResult,
} from './durable-lark-primary-ingress.js';
import {
  startDurableOutboxPump,
  type DurableOutboxDeliveryResult,
  type DurableOutboxPump,
  type DurableOutboxPumpOptions,
  type DurableOutboxPumpStopResult,
} from './durable-outbox-pump.js';
import {
  createDurableSessionFacade,
  type DurableSessionFacade,
  type DurableSessionFacadeStopResult,
} from './durable-session-facade.js';

export interface DurableLarkPrimaryRuntimeOptions {
  store: DurableCoordinationStore;
  larkAppId: string;
  handleCanonical: DurableLarkCanonicalDispatchOptions['handle'];
  deliverOutbox: DurableOutboxPumpOptions['deliver'];
  onLeadershipAcquired?: (leadership: DurableLarkIngressLeadership) => void | Promise<void>;
  onLeadershipLost?: (reason: unknown) => void | Promise<void>;
  onError?: (error: unknown) => void;
  ingressOwnerId?: string;
  inboxWorkerId?: string;
  outboxWorkerId?: string;
  sessionOwnerId?: string;
  ingressElectionIntervalMs?: number;
  inboxIntervalMs?: number;
  outboxIntervalMs?: number;
  outboxReservationLeaseMs?: number;
  outboxAttemptTimeoutMs?: number;
  shutdownMs?: number;
}

export interface DurableLarkPrimaryRuntimeStopResult {
  kind: 'stopped' | 'timed_out';
  ingress: DurableLarkPrimaryIngressStopResult;
  inbox: DurableInboxPrimaryStopResult;
  outbox: DurableOutboxPumpStopResult;
  session: DurableSessionFacadeStopResult;
}

export interface DurableLarkPrimaryRuntime {
  readonly ingress: DurableLarkPrimaryIngress;
  readonly inbox: DurableInboxPrimaryConsumer;
  readonly outbox: DurableOutboxPump;
  readonly session: DurableSessionFacade;
  ready: Promise<void>;
  status(): DurableLarkPrimaryIngressStatus;
  stop(timeoutMs?: number): Promise<DurableLarkPrimaryRuntimeStopResult>;
  terminate(): void;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/** Compose the disabled-state primary data plane under one shutdown budget. */
export function startDurableLarkPrimaryRuntime(
  options: DurableLarkPrimaryRuntimeOptions,
): DurableLarkPrimaryRuntime {
  const shutdownMs = boundedInteger(options.shutdownMs ?? 10_000, 'shutdownMs', 0, 300_000);
  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* observers cannot alter reconciliation */ }
  };
  const session = createDurableSessionFacade({
    store: options.store,
    ...(options.sessionOwnerId ? { ownerId: options.sessionOwnerId } : {}),
    shutdownMs,
  });
  const dispatch = createDurableLarkCanonicalDispatch({
    facade: session,
    handle: options.handleCanonical,
  });
  const inbox = startDurableInboxPrimaryConsumer({
    store: options.store,
    dispatch,
    ...(options.inboxWorkerId ? { workerId: options.inboxWorkerId } : {}),
    ...(options.inboxIntervalMs === undefined ? {} : { intervalMs: options.inboxIntervalMs }),
    shutdownMs,
    onError: reportError,
  });
  const outbox = startDurableOutboxPump({
    store: options.store,
    deliver: options.deliverOutbox,
    ...(options.outboxWorkerId ? { workerId: options.outboxWorkerId } : {}),
    ...(options.outboxIntervalMs === undefined ? {} : { intervalMs: options.outboxIntervalMs }),
    ...(options.outboxReservationLeaseMs === undefined
      ? {}
      : { reservationLeaseMs: options.outboxReservationLeaseMs }),
    ...(options.outboxAttemptTimeoutMs === undefined
      ? {}
      : { attemptTimeoutMs: options.outboxAttemptTimeoutMs }),
    shutdownMs,
    onError: reportError,
    onLateResult: (attempt: OutboxAttempt, result: DurableOutboxDeliveryResult | Error) => {
      // Timeout already committed ambiguous. Only an exact delivered receipt
      // may reconcile that same attempt; late retry/error outcomes stay closed.
      if (result instanceof Error || result.kind !== 'delivered') return;
      void options.store.completeOutboxAttempt({ attempt, receipt: result.receipt }).then(
        mutation => {
          if (mutation.kind === 'stale') {
            reportError(new Error(
              `durable outbox late receipt lost attempt ${attempt.record.messageId}`,
            ));
          }
        },
        reportError,
      );
    },
  });
  const ingress = startDurableLarkPrimaryIngress({
    store: options.store,
    larkAppId: options.larkAppId,
    ...(options.ingressOwnerId ? { ownerId: options.ingressOwnerId } : {}),
    ...(options.ingressElectionIntervalMs === undefined
      ? {}
      : { electionIntervalMs: options.ingressElectionIntervalMs }),
    shutdownMs,
    onLeadershipAcquired: options.onLeadershipAcquired,
    onLeadershipLost: options.onLeadershipLost,
    onError: reportError,
  });
  let stopPromise: Promise<DurableLarkPrimaryRuntimeStopResult> | undefined;
  const ready = Promise.all([inbox.ready, outbox.ready, ingress.ready]).then(() => undefined);
  const remaining = (deadline: number): number => Math.max(0, deadline - Date.now());

  return {
    ingress,
    inbox,
    outbox,
    session,
    ready,
    status: () => ingress.status(),
    stop: (timeoutMs = shutdownMs) => {
      if (stopPromise) return stopPromise;
      const budget = boundedInteger(timeoutMs, 'timeoutMs', 0, 300_000);
      const deadline = Date.now() + budget;
      stopPromise = (async () => {
        const ingressResult = await ingress.stop(remaining(deadline));
        const inboxResult = await inbox.stop(remaining(deadline));
        const outboxResult = await outbox.stop(remaining(deadline));
        const sessionResult = await session.stop(remaining(deadline));
        return {
          kind: ingressResult.kind === 'stopped'
            && inboxResult.kind === 'stopped'
            && outboxResult.kind === 'stopped'
            && sessionResult.kind === 'stopped'
            ? 'stopped'
            : 'timed_out',
          ingress: ingressResult,
          inbox: inboxResult,
          outbox: outboxResult,
          session: sessionResult,
        };
      })();
      return stopPromise;
    },
    terminate: () => {
      ingress.terminate();
      inbox.terminate();
      outbox.terminate();
      session.terminate();
    },
  };
}
