/** Shared execution identity and state semantics. Transport replacement,
 * execution replacement and output recovery have separate identities. */
export const SESSION_EVENT_PROTOCOL_VERSION = 2 as const;
/** New worker boots always negotiate this contract. Legacy output recovery is
 * independent of executor admission; it cannot disable the state authority. */
export function sessionContractsEnabled(): boolean { return true; }
export function contractTerminalStatus(status: unknown, errorCode: unknown): 'succeeded' | 'failed' | 'cancelled' | 'reconciling' {
  if (typeof errorCode === 'string' && (errorCode === 'rpc_turn_aborted'
    || errorCode === 'codex_turn_aborted' || errorCode.startsWith('codex_turn_aborted_')
    || errorCode === 'trae_turn_aborted' || errorCode.startsWith('trae_turn_aborted_'))) return 'cancelled';
  if (status === 'ambiguous' || ['cli_exit', 'worker_exit', 'preempted_by_user_message', 'native_turn_unconfirmed',
    'exited_without_terminal', 'missing_terminal', 'rpc_engine_dead', 'rpc_engine_stopped'].includes(String(errorCode))) return 'reconciling';
  return status === 'completed' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed';
}
export interface ContractSessionRef { appId: string; sessionId: string }
export interface WorkerRef { workerId: string; generation: number }
export interface RuntimeRef { runtimeId: string; epoch: number }
export interface ExecutionRef { executionId: string; turnId: string; dispatchAttempt?: number }
/** A planned internal continuation, not permission to replay the original input. */
export interface RuntimeExecutionContinuation {
  reason: 'traex-auto-model';
  execution: ExecutionRef;
  from: RuntimeRef;
  nativeSessionId: string;
}
export interface RuntimeExecutionContinuationResult {
  execution: ExecutionRef;
  status: 'approved' | 'rejected';
}
export interface RuntimeExecutionContinuationFailure {
  bindingId: string;
  continuation: RuntimeExecutionContinuation;
  notice?: string;
}
/** Local PTY-family backends whose process_start identity a continuation can
 * prove. Remote backends run off-box; zmx launches the CLI itself rather than
 * botmux, so neither can supply the required physical process proof. The host
 * gate and the Worker rotation gate must use this same set. */
export const TRAEX_CONTINUATION_BACKENDS = ['pty', 'tmux', 'zellij', 'herdr'] as const;
export interface RuntimeIdentity {
  backend: string;
  physicalId: string;
  nativeSessionId?: string;
  nativeGeneration?: string;
  proof: 'process_start' | 'native_generation' | 'persistent_lineage' | 'opaque';
}
export type SessionLifecycle = 'active' | 'suspending' | 'suspended' | 'resuming' | 'closing' | 'closed';
export type RuntimePhase = 'starting' | 'ready' | 'retiring' | 'stopped' | 'unresolved';
export type ExecutionPhase = 'queued' | 'submitting' | 'accepted' | 'running' | 'waiting_input' | 'blocked' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled';
export type ControlKind = 'restart' | 'cancel' | 'suspend' | 'resume' | 'close';
export type ControlPhase = 'planned' | 'applying' | 'confirmed' | 'failed_before_effect' | 'rejected' | 'uncertain';
export interface RuntimeContract {
  ref: RuntimeRef;
  identity?: RuntimeIdentity;
  phase: RuntimePhase;
  worker: WorkerRef;
  promptReady: boolean;
  promptReadySequence: number;
  reason?: string;
}
export interface ExecutionContract {
  ref: ExecutionRef;
  runtime?: RuntimeRef;
  phase: ExecutionPhase;
  terminal?: { status: 'succeeded' | 'failed' | 'cancelled'; evidence: string; errorCode?: string };
  output?: { content?: string; availability: 'available' | 'empty' | 'unavailable'; completeness?: 'partial' | 'final' };
  deliveries: Array<{ outputId: string; status: 'delivered' | 'partial' | 'failed' | 'unknown' | 'suppressed'; messageId?: string }>;
  cancelRequested: boolean;
  revision: number;
}
export interface ControlOperation {
  operationId: string;
  kind: ControlKind;
  phase: ControlPhase;
  targetRuntime?: RuntimeRef;
  targetExecution?: ExecutionRef;
  proposedRuntime?: RuntimeRef;
  expectedRevision: number;
  previousLifecycle?: SessionLifecycle;
  error?: string;
}
export interface SessionContract {
  ref: ContractSessionRef;
  revision: number;
  lifecycle: SessionLifecycle;
  worker?: WorkerRef;
  workerOnline: boolean;
  runtimeEpoch: number;
  readinessSequence: number;
  activeRuntime?: RuntimeRef;
  activeOperationId?: string;
}
export type ExecutionAdmissionState = Pick<ExecutionContract, 'ref' | 'runtime' | 'phase'>;
export interface SessionContractBootstrap { version: 2; session: ContractSessionRef; worker: WorkerRef; executions?: ExecutionAdmissionState[]; executionContinuations?: true; executionContinuationFailures?: true }
export interface SessionCommandContext { version: 2; runtime?: RuntimeRef; execution?: ExecutionRef; operationId?: string }
export interface ContractScope {
  runtime?: RuntimeRef;
  execution?: ExecutionRef;
  operationId?: string;
  historical?: boolean;
}
export interface SessionEventContext {
  version: 2;
  session: ContractSessionRef;
  producer: WorkerRef;
  eventId: string;
  sequence: number;
  scope: ContractScope;
  bindingId?: string;
}
export type ContractEvent =
  | { type: 'worker_bound'; worker: WorkerRef }
  | { type: 'worker_online'; worker: WorkerRef }
  | { type: 'worker_lost'; worker: WorkerRef }
  | { type: 'runtime_reserved'; runtime: RuntimeContract }
  | { type: 'runtime_epoch_floor'; epoch: number }
  | { type: 'runtime_bound'; runtime: RuntimeContract; operationId?: string }
  | { type: 'runtime_ready'; runtime: RuntimeRef }
  | { type: 'runtime_busy'; runtime: RuntimeRef }
  | { type: 'runtime_lost'; runtime: RuntimeRef; confirmed: boolean; reason?: string }
  | { type: 'execution_admitted'; execution: ExecutionContract }
  | { type: 'execution_phase'; execution: ExecutionRef; runtime: RuntimeRef; phase: Exclude<ExecutionPhase, 'succeeded' | 'failed' | 'cancelled'> }
  | { type: 'execution_continued'; execution: ExecutionRef; from: RuntimeRef; runtime: RuntimeRef }
  | { type: 'execution_terminal'; execution: ExecutionRef; runtime: RuntimeRef; status: 'succeeded' | 'failed' | 'cancelled' | 'reconciling'; evidence: string; errorCode?: string }
  | { type: 'execution_output'; execution: ExecutionRef; output: NonNullable<ExecutionContract['output']>; delivery?: ExecutionContract['deliveries'][number] }
  | { type: 'control_requested'; operation: ControlOperation }
  | { type: 'control_started'; operationId: string }
  | { type: 'control_result'; operationId: string; phase: Exclude<ControlPhase, 'planned' | 'applying'>; runtime?: RuntimeRef; error?: string };
export interface ContractTransitionInput {
  session: SessionContract;
  runtime?: RuntimeContract;
  execution?: ExecutionContract;
  operation?: ControlOperation;
}
export interface ContractTransition extends ContractTransitionInput {
  retiredOperation?: ControlOperation;
  decision: 'applied' | 'historical' | 'duplicate' | 'stale' | 'conflict';
  reason?: string;
}
export function sameRuntime(left?: RuntimeRef, right?: RuntimeRef): boolean {
  return !!left && !!right && left.runtimeId === right.runtimeId && left.epoch === right.epoch;
}
export function sameWorker(left?: WorkerRef, right?: WorkerRef): boolean {
  return !!left && !!right && left.workerId === right.workerId && left.generation === right.generation;
}
export function sameExecution(left?: ExecutionRef, right?: ExecutionRef): boolean {
  return !!left && !!right && left.executionId === right.executionId && left.turnId === right.turnId && left.dispatchAttempt === right.dispatchAttempt;
}
/** Restart replaces the uncertain executor instead of asserting that an old
 * teardown/interrupt had no effect. Other in-flight controls remain exclusive. */
export function canSupersedeControlOperation(operation: ControlOperation | undefined, kind: ControlKind): boolean {
  return kind === 'close' || (kind === 'restart' && operation?.phase === 'uncertain'
    && (operation.kind === 'suspend' || operation.kind === 'cancel'));
}
export function reusableRuntimeIdentity(left?: RuntimeIdentity, right?: RuntimeIdentity): boolean {
  return !!left && !!right && left.proof !== 'opaque' && left.proof === right.proof
    && left.backend === right.backend && left.physicalId === right.physicalId
    && left.nativeSessionId === right.nativeSessionId && left.nativeGeneration === right.nativeGeneration;
}
export function samePhysicalRuntimeIdentity(left?: RuntimeIdentity, right?: RuntimeIdentity): boolean {
  if (!left || !right || left.backend !== right.backend || left.physicalId !== right.physicalId || left.proof !== right.proof) return false;
  if (left.proof === 'native_generation') return left.nativeGeneration !== undefined && left.nativeGeneration === right.nativeGeneration;
  if (left.proof === 'persistent_lineage') return left.nativeSessionId === right.nativeSessionId;
  return true;
}
export function reduceSessionContract(input: ContractTransitionInput, event: ContractEvent): ContractTransition {
  const state: ContractTransitionInput & { retiredOperation?: ControlOperation } = structuredClone(input);
  const finish = (decision: ContractTransition['decision'], reason?: string): ContractTransition => ({ ...state, decision, ...(reason ? { reason } : {}) });
  const session = state.session;
  switch (event.type) {
    case 'worker_bound':
      if (session.worker && event.worker.generation <= session.worker.generation) return finish(sameWorker(session.worker, event.worker) ? 'duplicate' : 'stale');
      session.worker = event.worker; session.workerOnline = false; return finish('applied');
    case 'worker_online':
      if (!sameWorker(session.worker, event.worker)) return finish('stale');
      session.workerOnline = true; return finish('applied');
    case 'worker_lost':
      if (!sameWorker(session.worker, event.worker)) return finish('historical');
      session.workerOnline = false; return finish('applied');
    case 'runtime_reserved':
      if (event.runtime.ref.epoch <= session.runtimeEpoch) return finish('conflict', 'runtime_epoch_reused');
      session.runtimeEpoch = event.runtime.ref.epoch; state.runtime = event.runtime; return finish('applied');
    case 'runtime_epoch_floor':
      if (!Number.isSafeInteger(event.epoch) || event.epoch < 0) return finish('conflict', 'invalid_runtime_epoch');
      if (event.epoch <= session.runtimeEpoch) return finish('duplicate');
      session.runtimeEpoch = event.epoch; return finish('applied');
    case 'runtime_bound': {
      if (!sameWorker(session.worker, event.runtime.worker)) return finish('stale');
      if (session.lifecycle === 'closed' || session.lifecycle === 'closing') { state.runtime = { ...event.runtime, phase: 'retiring' }; return finish('historical'); }
      if (event.operationId && session.activeOperationId !== event.operationId) { state.runtime = { ...event.runtime, phase: 'retiring' }; return finish('historical'); }
      if (!event.operationId && session.activeOperationId) return finish('conflict', 'runtime_transition_in_progress');
      session.runtimeEpoch = Math.max(session.runtimeEpoch, event.runtime.ref.epoch);
      session.activeRuntime = event.runtime.ref; state.runtime = event.runtime;
      if (session.lifecycle === 'resuming') session.lifecycle = 'active';
      return finish('applied');
    }
    case 'runtime_ready':
    case 'runtime_busy':
      if (!sameRuntime(state.runtime?.ref, event.runtime) || !sameRuntime(session.activeRuntime, event.runtime)) return finish('stale');
      if (!['active', 'resuming'].includes(session.lifecycle)) return finish('stale');
      if (['retiring', 'stopped', 'unresolved'].includes(state.runtime!.phase)) return finish('stale');
      if (session.activeOperationId && state.operation?.kind !== 'restart' && state.operation?.kind !== 'resume') return finish('stale');
      if (event.type === 'runtime_busy' && !state.runtime!.promptReady) return finish('duplicate');
      state.runtime!.promptReady = event.type === 'runtime_ready';
      if (event.type === 'runtime_ready') { state.runtime!.phase = 'ready'; state.runtime!.promptReadySequence++; session.readinessSequence++; }
      return finish('applied');
    case 'runtime_lost':
      if (!sameRuntime(state.runtime?.ref, event.runtime)) return finish('stale');
      state.runtime!.phase = event.confirmed ? 'stopped' : 'unresolved'; state.runtime!.promptReady = false; state.runtime!.reason = event.reason;
      return finish(sameRuntime(session.activeRuntime, event.runtime) ? 'applied' : 'historical');
    case 'execution_admitted':
      if (state.execution) return finish(sameExecution(state.execution.ref, event.execution.ref) ? 'duplicate' : 'conflict');
      state.execution = event.execution; return finish('applied');
    case 'execution_continued':
      if (!sameExecution(state.execution?.ref, event.execution) || !sameRuntime(state.execution?.runtime, event.from)
        || !sameRuntime(state.runtime?.ref, event.runtime) || !sameRuntime(session.activeRuntime, event.runtime)
        || session.lifecycle !== 'active' || session.activeOperationId || state.execution?.cancelRequested
        || state.execution?.terminal || !['submitting', 'accepted', 'running'].includes(state.execution?.phase ?? '')
        || sameRuntime(event.from, event.runtime)) return finish('stale');
      // This logical request was already accepted by the old CLI. Do not
      // make its original bytes runnable again on a fresh worker bootstrap.
      state.execution!.runtime = event.runtime; state.execution!.phase = 'accepted'; state.execution!.revision++;
      return finish('applied');
    case 'execution_phase':
      if (!sameExecution(state.execution?.ref, event.execution) || !sameRuntime(state.execution?.runtime, event.runtime)) return finish('stale');
      if (state.execution!.terminal) return finish('duplicate');
      state.execution!.phase = event.phase; state.execution!.revision++; return finish('applied');
    case 'execution_terminal': {
      if (!sameExecution(state.execution?.ref, event.execution) || (state.execution?.runtime && !sameRuntime(state.execution.runtime, event.runtime))) return finish('stale');
      const execution = state.execution!;
      if (event.status === 'reconciling') {
        if (execution.terminal) return finish('duplicate');
        execution.phase = 'reconciling'; execution.revision++; return finish('applied');
      }
      if (execution.terminal) return finish(execution.terminal.status === event.status ? 'duplicate' : 'conflict', 'contradictory_native_terminal');
      if (!event.evidence || event.evidence === 'observer_loss') return finish('conflict', 'terminal_evidence_required');
      execution.terminal = { status: event.status, evidence: event.evidence, ...(event.errorCode ? { errorCode: event.errorCode } : {}) };
      execution.phase = event.status; execution.revision++;
      if (state.operation?.kind === 'cancel' && state.operation.targetExecution?.executionId === execution.ref.executionId
        && session.activeOperationId === state.operation.operationId) {
        state.operation.phase = 'confirmed'; session.activeOperationId = undefined;
      }
      return finish(sameRuntime(session.activeRuntime, event.runtime) ? 'applied' : 'historical');
    }
    case 'execution_output': {
      if (!sameExecution(state.execution?.ref, event.execution)) return finish('stale');
      const execution = state.execution!;
      if (!execution.output || (event.output.availability === 'available'
        && (execution.output.completeness !== 'final' || event.output.completeness === 'final'))) execution.output = event.output;
      if (event.delivery) {
        const previous = execution.deliveries.find(d => d.outputId === event.delivery!.outputId);
        if (!previous) execution.deliveries.push(event.delivery);
        else if (previous.status !== 'delivered') Object.assign(previous, event.delivery);
      }
      execution.revision++; return finish('historical');
    }
    case 'control_requested': {
      if (session.activeOperationId && !canSupersedeControlOperation(state.operation, event.operation.kind)) return finish('conflict', 'control_operation_in_progress');
      if (event.operation.expectedRevision !== session.revision) return finish('conflict', 'state_revision_changed');
      if (event.operation.targetRuntime && !sameRuntime(session.activeRuntime, event.operation.targetRuntime)) return finish('stale');
      if (session.lifecycle === 'closed' && event.operation.kind !== 'resume') return finish('stale');
      if (state.operation && session.activeOperationId) {
        state.retiredOperation = { ...state.operation, phase: 'uncertain', error: `superseded_by_${event.operation.kind}` };
        if (event.operation.kind === 'restart') session.lifecycle = state.operation.previousLifecycle ?? 'active';
      }
      state.operation = event.operation; session.activeOperationId = event.operation.operationId;
      if (event.operation.kind === 'close') session.lifecycle = 'closing';
      if (event.operation.kind === 'suspend') session.lifecycle = 'suspending';
      if (event.operation.kind === 'resume') session.lifecycle = 'resuming';
      if (event.operation.kind === 'resume') { session.activeRuntime = undefined; session.workerOnline = false; }
      if (event.operation.kind === 'cancel' && state.execution && sameExecution(state.execution.ref, event.operation.targetExecution)) state.execution.cancelRequested = true;
      return finish('applied');
    }
    case 'control_started':
      if (session.activeOperationId !== event.operationId || state.operation?.operationId !== event.operationId) return finish('stale');
      if (state.operation.phase !== 'planned') return finish('duplicate');
      state.operation.phase = 'applying'; return finish('applied');
    case 'control_result': {
      if (state.operation?.operationId !== event.operationId) return finish('stale');
      const operation = state.operation;
      if (operation.phase === 'confirmed' || operation.phase === 'failed_before_effect' || operation.phase === 'rejected') return finish('duplicate');
      operation.phase = event.phase; operation.error = event.error;
      if (session.activeOperationId !== event.operationId) return finish('historical');
      if (event.phase === 'uncertain') return finish('applied');
      session.activeOperationId = undefined;
      if (event.phase === 'confirmed') {
        if (operation.kind === 'close') session.lifecycle = 'closed';
        if (operation.kind === 'suspend') { session.lifecycle = 'suspended'; session.workerOnline = false; }
        if (operation.kind === 'resume') session.lifecycle = 'active';
        if (operation.kind === 'restart' && event.runtime && state.runtime?.phase !== 'retiring') session.activeRuntime = event.runtime;
      } else if (session.lifecycle !== 'closed') session.lifecycle = operation.previousLifecycle ?? 'active';
      return finish('applied');
    }
  }
}
export function contractReadiness(session: SessionContract, runtime?: RuntimeContract): { workerReady: boolean; cliReady: boolean; cliReadyGeneration: number } {
  return {
    workerReady: session.workerOnline && !session.activeOperationId && session.lifecycle === 'active',
    cliReady: session.workerOnline && sameWorker(session.worker, runtime?.worker) && session.lifecycle === 'active' && !session.activeOperationId && sameRuntime(session.activeRuntime, runtime?.ref) && runtime?.phase === 'ready' && runtime.promptReady === true,
    cliReadyGeneration: session.readinessSequence,
  };
}
