import { randomUUID } from 'node:crypto';
import type {
  DurableJson,
  DurableSessionRecord,
  DurableSessionLeaseStore,
  DurableSessionStateStore,
  SessionLease,
} from './durable-coordination.js';
import { canonicalJson } from '../utils/canonical-input-hash.js';

export type DurableSessionFacadeStore = DurableSessionLeaseStore & DurableSessionStateStore;

export type DurableSessionExactValueBuilder = (
  current: DurableSessionRecord | undefined,
) => DurableJson;

export type DurableSessionFacadeWriteResult =
  | { kind: 'written'; lease: SessionLease; record: DurableSessionRecord; coalescedCount: number }
  | { kind: 'unchanged'; lease: SessionLease; record: DurableSessionRecord; coalescedCount: number }
  | {
      kind: 'occupied';
      ownerId: string;
      epoch: number;
      leaseUntil: number;
      coalescedCount: number;
    }
  | {
      kind: 'conflict';
      current?: DurableSessionRecord;
      coalescedCount: number;
    }
  | { kind: 'stale_lease'; coalescedCount: number }
  | { kind: 'stopped'; coalescedCount: number };

export interface DurableSessionFacadeStopResult {
  kind: 'stopped' | 'timed_out';
  pendingSessionKeys: string[];
  unreleasedSessionKeys: string[];
}

export interface DurableSessionFacade {
  readonly ownerId: string;
  /** Shadow snapshots may collapse queued updates to the newest value. */
  write(sessionKey: string, value: DurableJson): Promise<DurableSessionFacadeWriteResult>;
  /** Admission writes are FIFO and are never merged across distinct events. */
  writeExact(sessionKey: string, value: DurableJson): Promise<DurableSessionFacadeWriteResult>;
  /** Build one exact FIFO value from the leased current record inside the Session lane. */
  writeExactFromCurrent(
    sessionKey: string,
    buildValue: DurableSessionExactValueBuilder,
  ): Promise<DurableSessionFacadeWriteResult>;
  stop(timeoutMs?: number): Promise<DurableSessionFacadeStopResult>;
  terminate(): void;
}

export interface DurableSessionFacadeOptions {
  store: DurableSessionFacadeStore;
  /** 仅供确定性测试；生产默认值包含进程与随机 boot identity。 */
  ownerId?: string;
  leaseDurationMs?: number;
  shutdownMs?: number;
}

interface PendingWriteBase {
  waiters: Array<{
    resolve: (result: DurableSessionFacadeWriteResult) => void;
    reject: (error: unknown) => void;
  }>;
}

type PendingWrite = PendingWriteBase & (
  | { mode: 'coalesced' | 'exact'; value: DurableJson }
  | { mode: 'exact-current'; buildValue: DurableSessionExactValueBuilder }
);

interface SessionLane {
  sessionKey: string;
  pending: PendingWrite[];
  running?: Promise<void>;
  lease?: SessionLease;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateOwnerId(value: string): string {
  const ownerId = value.trim();
  if (!ownerId || ownerId.length > 256) {
    throw new Error('durable session facade ownerId must contain at most 256 non-empty characters');
  }
  return ownerId;
}

function validateSessionKey(value: string): string {
  const sessionKey = value.trim();
  if (!sessionKey || sessionKey.length > 1_024) {
    throw new Error('durable session facade sessionKey must contain at most 1024 non-empty characters');
  }
  return sessionKey;
}

function cloneDurableJson(value: DurableJson): DurableJson {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('durable session value is not JSON-serializable');
  return JSON.parse(encoded) as DurableJson;
}

function cloneDurableSessionRecord(record: DurableSessionRecord): DurableSessionRecord {
  return { ...record, value: cloneDurableJson(record.value) };
}

function sameDurableJson(left: DurableJson, right: DurableJson): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameSessionLease(left: SessionLease | undefined, right: SessionLease): boolean {
  return left?.sessionKey === right.sessionKey
    && left.ownerId === right.ownerId
    && left.epoch === right.epoch;
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
 * Serialize and coalesce provider-neutral Session state writes by stable key.
 *
 * This facade does not replace botmux's synchronous Session store. It is an
 * asynchronous coordination boundary: one boot-unique owner acquires a
 * fencing lease, reads the durable revision and writes with compare-and-set.
 * Updates queued behind an in-flight write are last-write-wins coalesced, while
 * different session keys may progress independently.
 */
export function createDurableSessionFacade(
  options: DurableSessionFacadeOptions,
): DurableSessionFacade {
  const ownerId = validateOwnerId(
    options.ownerId ?? `session-facade:${process.pid}:${randomUUID()}`,
  );
  const leaseDurationMs = boundedInteger(
    options.leaseDurationMs ?? 60_000,
    'leaseDurationMs',
    1_000,
    300_000,
  );
  const shutdownMs = boundedInteger(options.shutdownMs ?? 5_000, 'shutdownMs', 0, 300_000);
  const lanes = new Map<string, SessionLane>();
  let accepting = true;
  let terminated = false;
  let stopPromise: Promise<DurableSessionFacadeStopResult> | undefined;

  const isStopping = (): boolean => !accepting || terminated;

  const releaseLaneLease = async (lane: SessionLane, lease: SessionLease): Promise<boolean> => {
    try {
      const result = await options.store.releaseSessionLease(lease);
      if (result.kind !== 'applied' && result.kind !== 'stale') return false;
      if (sameSessionLease(lane.lease, lease)) lane.lease = undefined;
      return true;
    } catch {
      return false;
    }
  };

  const stopAfterReleasing = async (
    lane: SessionLane,
    lease: SessionLease,
    coalescedCount: number,
  ): Promise<DurableSessionFacadeWriteResult> => {
    await releaseLaneLease(lane, lease);
    return { kind: 'stopped', coalescedCount };
  };

  const performWrite = async (
    lane: SessionLane,
    batch: PendingWrite,
    coalescedCount: number,
  ): Promise<DurableSessionFacadeWriteResult> => {
    if (isStopping()) return { kind: 'stopped', coalescedCount };
    let acquired;
    try {
      acquired = await options.store.acquireSessionLease({
        sessionKey: lane.sessionKey,
        ownerId,
        leaseDurationMs,
      });
    } catch (error) {
      if (isStopping()) return { kind: 'stopped', coalescedCount };
      throw error;
    }
    if (acquired.kind === 'occupied') {
      lane.lease = undefined;
      if (isStopping()) return { kind: 'stopped', coalescedCount };
      return { ...acquired, coalescedCount };
    }
    lane.lease = acquired.lease;
    if (isStopping()) return await stopAfterReleasing(lane, acquired.lease, coalescedCount);

    try {
      const current = await options.store.readSession(lane.sessionKey);
      if (isStopping()) return await stopAfterReleasing(lane, acquired.lease, coalescedCount);
      const value = batch.mode === 'exact-current'
        ? cloneDurableJson(batch.buildValue(current ? cloneDurableSessionRecord(current) : undefined))
        : batch.value;
      if (batch.mode === 'coalesced' && current && sameDurableJson(current.value, value)) {
        return { kind: 'unchanged', lease: acquired.lease, record: current, coalescedCount };
      }
      const written = await options.store.writeSession({
        lease: acquired.lease,
        expectedRevision: current?.revision ?? null,
        value,
      });
      if (isStopping()) return await stopAfterReleasing(lane, acquired.lease, coalescedCount);
      if (written.kind === 'written') {
        return { kind: 'written', lease: acquired.lease, record: written.record, coalescedCount };
      }
      if (written.kind === 'conflict') {
        return { kind: 'conflict', current: written.current, coalescedCount };
      }
      lane.lease = undefined;
      return { kind: 'stale_lease', coalescedCount };
    } catch (error) {
      if (isStopping()) return await stopAfterReleasing(lane, acquired.lease, coalescedCount);
      throw error;
    }
  };

  const runLane = async (lane: SessionLane): Promise<void> => {
    while (lane.pending.length > 0) {
      const batch = lane.pending.shift()!;
      let result: DurableSessionFacadeWriteResult;
      try {
        result = await performWrite(lane, batch, batch.waiters.length);
      } catch (error) {
        for (const waiter of batch.waiters) waiter.reject(error);
        continue;
      }
      for (const waiter of batch.waiters) waiter.resolve(result);
    }
  };

  const startLane = (lane: SessionLane): void => {
    if (lane.running) return;
    lane.running = runLane(lane).finally(() => {
      lane.running = undefined;
      if (lane.pending.length > 0 && !terminated) startLane(lane);
    });
  };

  const releaseLeases = async (
    deadline: number,
  ): Promise<{ timedOut: boolean; unreleased: string[] }> => {
    const entries = [...lanes.values()].flatMap(lane => lane.lease ? [{ lane, lease: lane.lease }] : []);
    if (entries.length === 0) return { timedOut: false, unreleased: [] };
    const releases = Promise.allSettled(entries.map(async ({ lane, lease }) => {
      await releaseLaneLease(lane, lease);
    }));
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) {
      const settled = await Promise.race([
        releases.then(() => true as const),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 0)),
      ]);
      return {
        timedOut: !settled,
        unreleased: entries
          .filter(({ lane, lease }) => sameSessionLease(lane.lease, lease))
          .map(({ lane }) => lane.sessionKey),
      };
    }
    const timeout = timeoutPromise(remaining);
    const settled = await Promise.race([releases.then(() => true as const), timeout.promise]);
    timeout.cancel();
    return {
      timedOut: !settled,
      unreleased: entries
        .filter(({ lane, lease }) => sameSessionLease(lane.lease, lease))
        .map(({ lane }) => lane.sessionKey),
    };
  };

  return {
    ownerId,
    write: (rawSessionKey, rawValue) => {
      const sessionKey = validateSessionKey(rawSessionKey);
      const value = cloneDurableJson(rawValue);
      if (!accepting || terminated) {
        return Promise.resolve({ kind: 'stopped', coalescedCount: 1 });
      }
      let lane = lanes.get(sessionKey);
      if (!lane) {
        lane = { sessionKey, pending: [] };
        lanes.set(sessionKey, lane);
      }
      return new Promise<DurableSessionFacadeWriteResult>((resolve, reject) => {
        const tail = lane!.pending.at(-1);
        if (tail?.mode === 'coalesced') {
          tail.value = value;
          tail.waiters.push({ resolve, reject });
        } else {
          lane!.pending.push({ mode: 'coalesced', value, waiters: [{ resolve, reject }] });
        }
        startLane(lane!);
      });
    },
    writeExact: (rawSessionKey, rawValue) => {
      const sessionKey = validateSessionKey(rawSessionKey);
      const value = cloneDurableJson(rawValue);
      if (!accepting || terminated) {
        return Promise.resolve({ kind: 'stopped', coalescedCount: 1 });
      }
      let lane = lanes.get(sessionKey);
      if (!lane) {
        lane = { sessionKey, pending: [] };
        lanes.set(sessionKey, lane);
      }
      return new Promise<DurableSessionFacadeWriteResult>((resolve, reject) => {
        lane!.pending.push({ mode: 'exact', value, waiters: [{ resolve, reject }] });
        startLane(lane!);
      });
    },
    writeExactFromCurrent: (rawSessionKey, buildValue) => {
      const sessionKey = validateSessionKey(rawSessionKey);
      if (typeof buildValue !== 'function') {
        return Promise.reject(new Error('durable exact Session value builder must be a function'));
      }
      if (!accepting || terminated) {
        return Promise.resolve({ kind: 'stopped', coalescedCount: 1 });
      }
      let lane = lanes.get(sessionKey);
      if (!lane) {
        lane = { sessionKey, pending: [] };
        lanes.set(sessionKey, lane);
      }
      return new Promise<DurableSessionFacadeWriteResult>((resolve, reject) => {
        lane!.pending.push({ mode: 'exact-current', buildValue, waiters: [{ resolve, reject }] });
        startLane(lane!);
      });
    },
    stop: (timeoutMs = shutdownMs) => {
      if (stopPromise) return stopPromise;
      const budget = boundedInteger(timeoutMs, 'timeoutMs', 0, 300_000);
      accepting = false;
      stopPromise = (async () => {
        const deadline = Date.now() + budget;
        const running = [...lanes.values()].flatMap(lane => lane.running ? [lane.running] : []);
        let drained = running.length === 0;
        if (!drained && budget > 0) {
          const timeout = timeoutPromise(budget);
          drained = await Promise.race([
            Promise.allSettled(running).then(() => true as const),
            timeout.promise,
          ]);
          timeout.cancel();
        }
        const release = await releaseLeases(deadline);
        const pendingSessionKeys = [...lanes.values()]
          .filter(lane => !!lane.running || lane.pending.length > 0)
          .map(lane => lane.sessionKey);
        return {
          kind: drained && !release.timedOut && release.unreleased.length === 0
            ? 'stopped'
            : 'timed_out',
          pendingSessionKeys,
          unreleasedSessionKeys: release.unreleased,
        };
      })();
      return stopPromise;
    },
    terminate: () => {
      accepting = false;
      terminated = true;
      for (const lane of lanes.values()) {
        const pending = lane.pending.splice(0);
        for (const batch of pending) {
          const result: DurableSessionFacadeWriteResult = {
            kind: 'stopped',
            coalescedCount: batch.waiters.length,
          };
          for (const waiter of batch.waiters) waiter.resolve(result);
        }
      }
    },
  };
}
