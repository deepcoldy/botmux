import type { EventLog } from '../events/append.js';
import type { ErrorClass, ErrorCode } from '../events/payloads.js';

/**
 * Runtime context handed to every hostExecutor invocation.  The caller
 * (workflow scheduler/worker) is responsible for already having written:
 *   - `attemptCreated` (with this `nodeId/activityId/attemptId`)
 *   - `leaseSigned`
 *   - `activityRunning`
 * before invoking the side-effect protocol.  This context only needs the
 * tuple required to derive `idempotencyKey` plus the event log handle so
 * the protocol can record its 3 events (`effectAttempted`,
 * `activitySucceeded`/`activityFailed`).
 */
export type HostExecutorContext = {
  log: EventLog;
  runId: string;
  workflowId: string;
  revisionId: string;
  nodeId: string;
  activityId: string;
  attemptId: string;
};

/**
 * Classified executor error.  Executors that can give precise error codes
 * (Feishu 230011 etc.) return a typed result; everything else falls back
 * to `UnknownProviderError` / `manual` (events doc v0.1.2 §3.3).
 */
export type ExecutorErrorClassification = {
  errorCode: ErrorCode;
  errorClass: ErrorClass;
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
   * Provider TTL.  Feeds `effectAttempted.idempotencyTtlMs` and the
   * resume reconciler's TTL-vs-manual decision (events doc §4.3.1).
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
