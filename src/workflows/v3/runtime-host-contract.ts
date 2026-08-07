/**
 * Host-neutral contracts for embedding the v3 workflow runtime.
 *
 * These types deliberately avoid daemon, Lark, worker-fence, and Botmux bot
 * configuration details. A host may keep its own durable state and adapt it
 * into this boundary.
 */

import type { V3GoalNode } from './dag.js';

export interface ExecutionContextSnapshot {
  /** Immutable workflow parameters resolved when the run is authorized. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Immutable host identity/context values resolved when the run is authorized. */
  readonly context: Readonly<Record<string, string>>;
}

/**
 * One scheduler-owned execution lease. The id is durable while the signal is
 * process-local; hosts should use the id for audit and the signal for teardown.
 */
export interface AttemptLease {
  readonly attemptId: string;
  readonly signal: AbortSignal;
  /** Opaque provider token passed from the scheduler to the agent executor. */
  readonly hostToken?: unknown;
}

export type AttemptLeaseCloseReason =
  | 'pre_aborted'
  | 'setup_failed';

export interface AttemptLeaseBinding {
  runId: string;
  attemptId: string;
  attemptDir: string;
}

export interface AttemptLeaseAcquisition {
  hostToken?: unknown;
  /** Preserve the legacy Botmux journal marker without imposing it on hosts. */
  auditKind: 'workerFence' | 'attemptLease';
}

export type AttemptLeaseDrainResult =
  /** Exact external ownership is proven closed; journal proof precedes finalization. */
  | { status: 'closed'; finalizeAfterProof(): void }
  /** `pending` is known live ownership; `unknown` means the host cannot prove either state. */
  | { status: 'pending' | 'unknown' };

export interface AttemptLeaseProvider {
  /**
   * Durable/restartable hosts (including Desktop) must back this contract with
   * host-owned execution state. Recovery may return `closed` only after proving
   * the exact executor/terminal attempt stopped; `finalizeAfterProof` runs only
   * after the workflow journal durably records that close.
   */
  acquire(binding: AttemptLeaseBinding): AttemptLeaseAcquisition;
  closeBeforeExecution(
    binding: AttemptLeaseBinding,
    acquisition: AttemptLeaseAcquisition,
    reason: AttemptLeaseCloseReason,
  ): void;
  drainExternallyOwned(binding: AttemptLeaseBinding): AttemptLeaseDrainResult;
  cleanupSettled(
    binding: AttemptLeaseBinding,
    acquisition?: AttemptLeaseAcquisition,
  ): void;
}

export interface ExecutionProfileSnapshot {
  /** Stable profile selector frozen for this run. */
  readonly profileId: string;
  /** Concurrency/capability domain, e.g. a CLI or remote execution backend. */
  readonly executorId: string;
  readonly workingDirectory: string;
  readonly model?: string;
  /**
   * Host-owned, JSON-safe, non-secret adapter configuration. Persist stable
   * credential references here; the executor resolves live secrets itself.
   */
  readonly adapterData?: unknown;
}

export interface AgentSessionInfo {
  sessionId: string;
  webPort?: number;
  token?: string;
}

export interface AgentExecutionRequest {
  runId: string;
  attemptId: string;
  attemptLease: AttemptLease;
  node: V3GoalNode;
  executionProfile: ExecutionProfileSnapshot;
  runDir: string;
  attemptDir: string;
  inputsPath: string;
  outputDir: string;
  env: Record<string, string>;
  timeoutMs: number;
  onSessionReady?: (
    info: AgentSessionInfo & { ptyLogPath?: string },
  ) => void | Promise<void>;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface AgentExecutionResult {
  status: 'ok' | 'fail' | 'cancelled';
  cancelReason?: unknown;
  manifestPath: string;
  sessionInfo?: AgentSessionInfo;
}

export type AgentExecutor = (
  request: AgentExecutionRequest,
) => Promise<AgentExecutionResult>;

export type ExecutorErrorClassification = {
  errorCode: string;
  errorClass: 'retryable' | 'fatal' | 'userFault' | 'manual';
  errorMessage: string;
};

export interface HostSideEffectExecutor<Input = unknown, Output = unknown> {
  readonly provider: string;
  readonly idempotencyTtlMs: number;
  canonicalInput(input: Input): unknown;
  validateBeforeIntent?(
    input: Input,
    nowMs: number,
  ):
    | { ok: true }
    | { ok: false; errorCode: string; message: string };
  invoke(
    input: Input,
    idempotencyKey: string,
  ): Promise<{
    output: Output;
    externalRefs: Record<string, unknown>;
  }>;
  classifyError?(error: unknown): ExecutorErrorClassification | null;
}

export type RegisteredHostExecutor<Input = unknown, Output = unknown> = {
  executor: HostSideEffectExecutor<Input, Output>;
  parseInput(input: unknown): Input;
};

export type HostExecutorRegistry = Map<string, RegisteredHostExecutor>;

export type ReadOnlyLookupResult =
  | {
      found: true;
      externalRefs: Record<string, unknown>;
      evidence?: Record<string, unknown>;
    }
  | { found: false; evidence?: Record<string, unknown> };

export type IdempotentSubmitResult =
  | {
      ok: true;
      externalRefs: Record<string, unknown>;
      evidence?: Record<string, unknown>;
    }
  | {
      ok: false;
      errorCode: string;
      errorClass: 'retryable' | 'fatal' | 'userFault' | 'manual';
      errorMessage: string;
      evidence?: Record<string, unknown>;
    };

export interface ProviderReconciler {
  readonly provider: string;
  readonly requiresEffectInput?: boolean;
  readOnlyLookup?(
    idempotencyKey: string,
    input: unknown,
  ): Promise<ReadOnlyLookupResult>;
  idempotentSubmit?(
    idempotencyKey: string,
    input: unknown,
  ): Promise<IdempotentSubmitResult>;
  canonicalInput?(input: unknown): unknown;
}

export interface HostExecutorPolicyRequest {
  readonly nodeId: string;
  readonly executor: string;
  readonly input: unknown;
  readonly executionContext?: ExecutionContextSnapshot;
}

/**
 * Synchronous by design: authorization must finish before a prepared host
 * effect can be committed or presented for approval.
 */
export type HostExecutorPolicy = (request: HostExecutorPolicyRequest) => void;

export interface GateResolutionRequest {
  nodeId: string;
  prompt: string;
  waitId: string;
  runDir: string;
  hostApproval?: { attemptId: string; approvalDigest: string; inputHash: string };
}

export interface GateResolution {
  resolution: 'approved' | 'rejected';
  by: string;
  selected?: string;
}

export type GateResolver = (request: GateResolutionRequest) => Promise<GateResolution>;
