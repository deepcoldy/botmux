/**
 * Provider classification consumed by the v3 host runtime. This type is
 * intentionally independent of the retired v2 event schema; v3 validates
 * and bounds values before persisting them in its journal.
 */
export type ExecutorErrorClassification = {
  errorCode: string;
  errorClass: 'retryable' | 'fatal' | 'userFault' | 'manual';
  /** Human-readable detail; truncated to 4KB upstream. */
  errorMessage: string;
};

/**
 * A side-effecting hostExecutor (send / reply / schedule in v0).  Pure
 * executors (transform / bots / history / quoted / sub-agent) have a
 * separate interface in `pure.ts` because they skip `effectAttempted`.
 */
export interface SideEffectingExecutor<Input, Output> {
  /** Identifier embedded in `effectAttempted.provider`. */
  readonly provider: string;

  /**
   * Provider TTL used by durable recovery to choose safe re-submit vs manual
   * reconciliation.
   */
  readonly idempotencyTtlMs: number;

  /**
   * Convert the typed `Input` into the canonical shape that's hashed
   * into `effectAttempted.inputHash`.  Codex round 2 / 4 invariant: this
   * MUST include every field that participates in the external effect
   * (e.g. for Feishu reply: `receive_id`, `root_message_id`, `msg_type`,
   * `content`) so that retries can detect input drift.
   */
  canonicalInput(input: Input): unknown;

  /**
   * Pure, last-moment validation of a previously frozen/approved payload.
   * This runs immediately before the durable provider intent is published.
   * It must not mutate provider state. Time-sensitive inputs (notably a
   * one-shot schedule) use it to force a fresh attempt + fresh approval when
   * the approved payload is no longer executable.
   */
  validateBeforeIntent?(
    input: Input,
    nowMs: number,
  ):
    | { ok: true }
    | { ok: false; errorCode: string; message: string };

  /**
   * Invoke the provider.  `idempotencyKey` is the runtime-derived
   * dedupe token (≤ 50 chars) that callers should forward to the
   * provider's idempotency knob (Feishu uuid / schedule task id).
   */
  invoke(
    input: Input,
    idempotencyKey: string,
  ): Promise<{
    output: Output;
    /**
     * Provider-returned identifiers stored in
     * `activitySucceeded.externalRefs`.  Type-specific (send/reply →
     * `{ messageId }`, schedule → `{ taskId }`).
     */
    externalRefs: Record<string, unknown>;
  }>;

  /**
   * Map an `invoke` error to an event-typed error.  Returning `null`
   * (or omitting the method) falls back to the protocol default:
   *   `{ UnknownProviderError, manual }`.
   * Codex round 2: TTL-class errors are `manual` (need human resolution),
   * lease/worker/network errors stay `retryable`.
   */
  classifyError?(err: unknown): ExecutorErrorClassification | null;
}
