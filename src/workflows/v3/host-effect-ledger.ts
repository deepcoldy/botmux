/** Pure replay fold for side-effecting v3 host attempts. */

import type { StoredEvent } from './journal.js';

export interface V3OpenHostEffect {
  nodeId: string;
  instanceId: string;
  attemptId: string;
  executor: string;
  provider: string;
  inputRef: { path: string; sha256: string; bytes: number };
  inputHash: string;
  idempotencyKey: string;
  idempotencyTtlMs: number;
  approvalDigest: string;
  attemptedAtMs: number;
}

export function openV3HostEffects(events: readonly StoredEvent[]): V3OpenHostEffect[] {
  const opened = new Map<string, V3OpenHostEffect>();
  const closed = new Set<string>();
  const deferred = new Map<string, {
    retryCount: number;
    nextRetryAt: number;
    errorCode: string;
  }>();

  for (const event of events) {
    if (event.type === 'hostEffectIntent') {
      if (!Number.isSafeInteger(event.ts) || event.ts < 0) {
        throw new Error(`v3 host effect ledger: invalid intent timestamp for ${event.attemptId}`);
      }
      if (!Number.isSafeInteger(event.idempotencyTtlMs) || event.idempotencyTtlMs < 1) {
        throw new Error(`v3 host effect ledger: invalid provider TTL for ${event.attemptId}`);
      }
      const prior = opened.get(event.attemptId);
      if (prior && !sameIdentity(prior, event)) {
        throw new Error(`v3 host effect ledger: identity changed for ${event.attemptId}`);
      }
      if (prior) continue; // exact duplicate is audit-only; never reopen a closed effect
      opened.set(event.attemptId, {
        nodeId: event.nodeId,
        instanceId: event.instanceId,
        attemptId: event.attemptId,
        executor: event.executor,
        provider: event.provider,
        inputRef: event.inputRef,
        inputHash: event.inputHash,
        idempotencyKey: event.idempotencyKey,
        idempotencyTtlMs: event.idempotencyTtlMs,
        approvalDigest: event.approvalDigest,
        attemptedAtMs: event.ts,
      });
      continue;
    }
    if (event.type === 'hostEffectRetryDeferred') {
      const intent = opened.get(event.attemptId);
      if (!intent || closed.has(event.attemptId)) {
        throw new Error(`v3 host effect ledger: retry deferral has no open intent for ${event.attemptId}`);
      }
      if (intent.nodeId !== event.nodeId || intent.instanceId !== event.instanceId) {
        throw new Error(`v3 host effect ledger: retry deferral identity changed for ${event.attemptId}`);
      }
      if (!Number.isSafeInteger(event.retryCount) || event.retryCount < 1) {
        throw new Error(`v3 host effect ledger: invalid retry count for ${event.attemptId}`);
      }
      if (!Number.isSafeInteger(event.nextRetryAt) || event.nextRetryAt < intent.attemptedAtMs) {
        throw new Error(`v3 host effect ledger: invalid retry deadline for ${event.attemptId}`);
      }
      const prior = deferred.get(event.attemptId);
      if (prior) {
        const exactDuplicate =
          prior.retryCount === event.retryCount &&
          prior.nextRetryAt === event.nextRetryAt &&
          prior.errorCode === event.errorCode;
        if (exactDuplicate) continue;
        if (
          event.retryCount !== prior.retryCount + 1 ||
          event.nextRetryAt < prior.nextRetryAt
        ) {
          throw new Error(`v3 host effect ledger: retry sequence changed for ${event.attemptId}`);
        }
      } else if (event.retryCount !== 1) {
        throw new Error(`v3 host effect ledger: retry sequence must start at 1 for ${event.attemptId}`);
      }
      deferred.set(event.attemptId, {
        retryCount: event.retryCount,
        nextRetryAt: event.nextRetryAt,
        errorCode: event.errorCode,
      });
      continue;
    }
    if (
      event.type !== 'nodeSucceeded' &&
      event.type !== 'nodeFailed' &&
      event.type !== 'nodeBlocked' &&
      event.type !== 'hostEffectUncertain' &&
      !(event.type === 'nodeCancelled' && event.reason === 'runCancelled')
    ) continue;
    if (!event.attemptId) continue;
    const intent = opened.get(event.attemptId);
    if (!intent || closed.has(event.attemptId)) continue;
    if (intent.nodeId !== event.nodeId || intent.instanceId !== event.instanceId) {
      throw new Error(`v3 host effect ledger: close identity changed for ${event.attemptId}`);
    }
    if (event.type === 'hostEffectUncertain' && intent.executor !== event.executor) {
      throw new Error(`v3 host effect ledger: uncertain executor changed for ${event.attemptId}`);
    }
    closed.add(event.attemptId);
  }

  return [...opened.values()].filter((effect) => !closed.has(effect.attemptId));
}

export function hasOpenV3HostEffects(events: readonly StoredEvent[]): boolean {
  return openV3HostEffects(events).length > 0;
}

function sameIdentity(
  left: V3OpenHostEffect,
  right: Extract<StoredEvent, { type: 'hostEffectIntent' }>,
): boolean {
  return left.nodeId === right.nodeId &&
    left.instanceId === right.instanceId &&
    left.attemptId === right.attemptId &&
    left.executor === right.executor &&
    left.provider === right.provider &&
    left.inputRef.path === right.inputRef.path &&
    left.inputRef.sha256 === right.inputRef.sha256 &&
    left.inputRef.bytes === right.inputRef.bytes &&
    left.inputHash === right.inputHash &&
    left.idempotencyKey === right.idempotencyKey &&
    left.idempotencyTtlMs === right.idempotencyTtlMs &&
    left.approvalDigest === right.approvalDigest &&
    left.attemptedAtMs === right.ts;
}
