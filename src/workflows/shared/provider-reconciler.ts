/**
 * Provider recovery contract shared by the v3 host runtime and concrete
 * side-effect executors.
 *
 * This is deliberately independent of the retired v2 event log and resume
 * algorithm.  A reconciler proves what happened at the external provider;
 * the caller owns durable state transitions and retry policy.
 */

export type ReadOnlyLookupResult =
  | { found: true; externalRefs: Record<string, unknown>; evidence?: Record<string, unknown> }
  | { found: false; evidence?: Record<string, unknown> };

export type IdempotentSubmitResult =
  | { ok: true; externalRefs: Record<string, unknown>; evidence?: Record<string, unknown> }
  | {
      ok: false;
      errorCode: string;
      errorClass: 'retryable' | 'fatal' | 'userFault' | 'manual';
      errorMessage: string;
      evidence?: Record<string, unknown>;
    };

/**
 * Provider dedupe windows shared by v3 host execution and frozen v2 replay.
 * These values participate in durable recovery decisions and must not drift.
 */
export const PROVIDER_TTL_MS = {
  'feishu-im': 60 * 60 * 1000,
  'botmux-schedule': Number.MAX_SAFE_INTEGER,
} as const;

export interface ProviderReconciler {
  readonly provider: string;
  /** Whether provider reconciliation requires the exact frozen input bytes. */
  readonly requiresEffectInput?: boolean;
  /** Pure provider lookup keyed by the durable idempotency key. */
  readOnlyLookup?(idempotencyKey: string, input: unknown): Promise<ReadOnlyLookupResult>;
  /** Idempotent re-submit using the original key and verified frozen input. */
  idempotentSubmit?(idempotencyKey: string, input: unknown): Promise<IdempotentSubmitResult>;
  /** Must match the executor's canonicalInput implementation exactly. */
  canonicalInput?(input: unknown): unknown;
}
