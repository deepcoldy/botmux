import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { DaemonSession } from './types.js';
import { config } from '../config.js';
import { sessionContractStore, type SessionContractStore } from '../services/session-contract-store.js';
import {
  contractReadiness, sameWorker, sameRuntime, sameExecution, type ContractSessionRef, type WorkerRef, type RuntimeRef,
  type RuntimeIdentity, type SessionEventContext, type ContractEvent, type ExecutionRef, type ControlKind,
  type ControlOperation, type RuntimeContract, type RuntimeExecutionContinuation,
  TRAEX_CONTINUATION_BACKENDS,
  sessionContractsEnabled,
  contractTerminalStatus,
  samePhysicalRuntimeIdentity,
} from '../services/session-contract.js';
import { SessionEventGateway, type SessionEventAdmission } from './session-event-gateway.js';
import { isOutputJournalAppId } from '../services/universal-output-handoff.js';
import { commitPrimarySessionContract, sessionContractPrimary } from './session-contract-primary.js';

export type SessionContractBootstrap = import('../services/session-contract.js').SessionContractBootstrap;
export interface WorkerContractContext extends SessionEventContext { bindingId?: string }
export type ControlledWorkerMessage = { type: string; sessionContract?: WorkerContractContext; turnId?: string; dispatchAttempt?: number; [key: string]: unknown };
const eventScope = new AsyncLocalStorage<SessionEventAdmission>();
const controllers = new WeakMap<DaemonSession, SessionController>();

export { sessionContractsEnabled } from '../services/session-contract.js';

/** Canonical state lives in the contract store. Old flags are a compatible
 * read model; scoped events and native control receipts are its only writers. */
export class SessionController {
  readonly ref: ContractSessionRef;
  readonly store: SessionContractStore;
  readonly gateway: SessionEventGateway;
  private primaryRevision = 0;
  private primaryQueue = Promise.resolve();
  private readonly abortedBindings = new Set<string>();
  constructor(readonly ds: DaemonSession, store?: SessionContractStore) {
    this.ref = { appId: ds.larkAppId, sessionId: ds.session.sessionId };
    this.store = store ?? sessionContractStore(config.session.dataDir, ds.larkAppId);
    if (ds.session.sessionRuntimeContract && sessionContractPrimary(ds.larkAppId)) {
      this.store.restore(ds.session.sessionRuntimeContract);
      this.primaryRevision = ds.session.sessionRuntimeContract.session.revision;
    }
    this.store.ensure(this.ref, { closed: ds.session.status === 'closed', suspended: ds.session.suspendedColdResume, readinessSequence: ds.cliReadyGeneration });
    this.gateway = new SessionEventGateway(this.store, this.ref);
    for (const key of ['workerReady', 'cliReady', 'cliReadyGeneration'] as const) {
      Object.defineProperty(ds, key, { enumerable: true, configurable: true, get: () => contractReadiness(this.store.read(this.ref)!, this.store.runtime(this.ref))[key], set: () => {} });
    }
  }
  refresh(): void {
    const state = this.store.read(this.ref)!;
    this.ds.session.sessionLifecycle = state.lifecycle;
    this.ds.session.sessionContractRevision = state.revision;
    this.ds.session.status = state.lifecycle === 'closed' ? 'closed' : 'active';
  }
  flushPrimary(): Promise<void> {
    if (!sessionContractPrimary(this.ref.appId)) return Promise.resolve();
    const snapshot = this.store.snapshot(this.ref);
    const pending = this.primaryQueue.then(async () => {
      if (snapshot.session.revision <= this.primaryRevision) return;
      await commitPrimarySessionContract(this.ds.session, snapshot, this.primaryRevision);
      this.primaryRevision = snapshot.session.revision;
      this.ds.session.sessionRuntimeContract = snapshot;
    });
    this.primaryQueue = pending; return pending;
  }
  bindWorker(generation: number): SessionContractBootstrap {
    const previous = this.store.read(this.ref)?.worker;
    const worker = previous?.generation === generation ? previous : { workerId: randomUUID(), generation };
    this.store.bindWorker(this.ref, worker); this.refresh(); return { version: 2, session: this.ref, worker, executionContinuations: true,
      executions: this.store.executions(this.ref).map(({ ref, runtime, phase }) => ({ ref, runtime, phase })) };
  }
  private executionContinuationSupported(): boolean {
    const cfg = this.ds.initConfig;
    return cfg?.cliId === 'traex' && cfg.traexAutoModel?.enabled === true
      && !cfg.adoptMode && !cfg.existingAppServerEndpoint && !cfg.wrapperCli
      && (TRAEX_CONTINUATION_BACKENDS as readonly string[]).includes(cfg.backendType);
  }
  reserveBinding(bindingId: string, worker: WorkerRef, continuation?: RuntimeExecutionContinuation): RuntimeRef {
    const state = this.store.read(this.ref)!;
    if (!sameWorker(state.worker, worker)) throw new Error('stale_runtime_registration');
    if (continuation && !this.executionContinuationSupported()) {
      throw new Error('execution_continuation_not_supported');
    }
    const value = this.store.atomic(() => {
      const runtime = this.store.reserveRuntime(this.ref, worker, bindingId);
      if (continuation) this.store.planExecutionContinuation(this.ref, bindingId, runtime, worker, continuation);
      return runtime;
    });
    this.refresh(); return value;
  }
  bindRuntime(bindingId: string, worker: WorkerRef, identity: RuntimeIdentity, operationId?: string, continuesBindingId?: string): RuntimeContract {
    if (this.abortedBindings.has(bindingId)) throw new Error('runtime_reservation_abandoned');
    const existing = this.store.binding(this.ref, bindingId);
    if (existing && !this.store.bindingProducer(this.ref, bindingId, worker)) throw new Error('runtime_binding_producer_mismatch');
    const proposed = existing ?? { ref: this.reserveBinding(bindingId, worker) };
    const runtime = this.store.atomic(() => {
      // Only the worker's own active runtime can be continued in-process.
      const predecessor = continuesBindingId && this.store.bindingProducer(this.ref, continuesBindingId, worker)
        ? this.store.binding(this.ref, continuesBindingId)?.ref : undefined;
      const state = this.store.read(this.ref);
      const continued = predecessor && sameRuntime(predecessor, state?.activeRuntime) ? predecessor : undefined;
      // The live runtime re-reporting its own identity, e.g. the native session
      // id a resumed Claude first shows at its first write, after the resume
      // was confirmed at the prompt.
      const live = this.store.binding(this.ref, bindingId);
      const enrichesActive = state?.lifecycle === 'active' && !!live?.identity && sameRuntime(live.ref, state.activeRuntime);
      // The operation that spawned the live CLI may already be confirmed;
      // continuing or enriching that CLI is not part of it.
      const operation = (continued || enrichesActive) && !state?.activeOperationId ? undefined : operationId;
      const bound = this.store.bindRuntime(this.ref, proposed.ref, worker, identity, operation);
      if (continued && !sameRuntime(continued, bound.ref) && sameRuntime(this.store.read(this.ref)?.activeRuntime, bound.ref)) {
        this.store.continueRuntime(this.ref, continued, bound.ref, worker);
        this.store.inheritExecutionContinuation(this.ref, continuesBindingId!, bindingId, worker);
      }
      return bound;
    });
    // Physical binding is a fact even if granting execution continuation fails.
    // A later registration retries the grant without erasing that live process.
    if (this.executionContinuationSupported()) this.store.commitExecutionContinuation(this.ref, bindingId, worker);
    else this.store.rejectExecutionContinuation(this.ref, bindingId);
    this.refresh(); return runtime;
  }
  bindingMayStart(bindingId: string): boolean {
    return !this.abortedBindings.has(bindingId) && this.store.binding(this.ref, bindingId)?.phase === 'starting';
  }
  abandonBinding(bindingId: string, worker: WorkerRef, eventId: string, reason = 'runtime_start_aborted'): boolean {
    const runtime = this.store.binding(this.ref, bindingId);
    if (!runtime || runtime.identity || !this.store.bindingProducer(this.ref, bindingId, worker)) return false;
    // Remember the worker's no-spawn evidence before a fallible durable write,
    // so an older reservation await cannot release a contradictory permit.
    this.abortedBindings.add(bindingId);
    this.store.atomic(() => {
      this.store.apply(this.ref, { type: 'runtime_lost', runtime: runtime.ref, confirmed: true, reason }, eventId);
      this.store.discardDeferred(this.ref, bindingId);
    });
    this.refresh(); return true;
  }
  admitsRegistration(type: string, bindingId: string, context: SessionEventContext | undefined, worker: WorkerRef): boolean {
    if (!context || context.bindingId !== bindingId) return false;
    const admission = this.gateway.admit(type, { ...context, scope: {} }, worker);
    return admission.kind === 'worker';
  }
  nativeSignal(bindingId: unknown, nativeSessionId?: unknown, turnId?: string, dispatchAttempt?: number): import('../services/session-contract.js').SessionCommandContext | undefined {
    if (typeof bindingId !== 'string') return this.unboundNativeSignal(nativeSessionId, turnId, dispatchAttempt);
    const source = this.store.binding(this.ref, bindingId); if (!source) return undefined;
    const current = this.store.runtime(this.ref);
    const owner = this.store.read(this.ref)?.worker;
    if (!source.identity && owner && this.store.bindingProducer(this.ref, bindingId, owner)) return { version: 2, runtime: source.ref };
    if (sameRuntime(source.ref, current?.ref)) return { version: 2, runtime: source.ref };
    const execution = turnId ? this.store.executions(this.ref, turnId, dispatchAttempt)[0] : undefined;
    // Hooks keep the binding their CLI was spawned under; the worker only
    // accepts commands aimed at its current runtime.
    if (current && owner && sameWorker(current.worker, owner) && this.store.runtimeContinues(this.ref, source.ref, current.ref, owner)) {
      const ranHere = execution?.runtime && this.store.runtimeContinues(this.ref, source.ref, execution.runtime, owner)
        && this.store.runtimeContinues(this.ref, execution.runtime, current.ref, owner);
      return { version: 2, runtime: current.ref, ...(ranHere ? { execution: execution!.ref } : {}) };
    }
    const executor = execution?.runtime ? this.store.runtime(this.ref, execution.runtime.runtimeId) : undefined;
    if (executor?.identity && samePhysicalRuntimeIdentity(source.identity, executor.identity)) return { version: 2, runtime: executor.ref, execution: execution!.ref };
    if (typeof nativeSessionId === 'string' && current?.identity?.nativeSessionId === nativeSessionId
      && samePhysicalRuntimeIdentity(source.identity, current.identity)) return { version: 2, runtime: current.ref };
    return undefined;
  }
  /** A CLI launched before runtime bindings existed has no binding ID in its
   * hook environment. Only a settled, sole current runtime may adopt it. */
  private unboundNativeSignal(nativeSessionId?: unknown, turnId?: string, dispatchAttempt?: number): import('../services/session-contract.js').SessionCommandContext | undefined {
    const state = this.store.read(this.ref)!; const current = this.store.runtime(this.ref);
    if (!current?.identity || state.lifecycle !== 'active' || state.activeOperationId || !sameWorker(current.worker, state.worker)
      || !['starting', 'ready'].includes(current.phase) || this.store.hasPendingRuntimeReplacement(this.ref, current.ref)) return undefined;
    if (typeof nativeSessionId === 'string' && current.identity.nativeSessionId !== undefined && current.identity.nativeSessionId !== nativeSessionId) return undefined;
    const execution = turnId ? this.store.executions(this.ref, turnId, dispatchAttempt)[0] : undefined;
    if (execution?.runtime && !sameRuntime(execution.runtime, current.ref)) return undefined;
    return { version: 2, runtime: current.ref, ...(execution ? { execution: execution.ref } : {}) };
  }
  admitInput(turnId: string, dispatchAttempt?: number, admissionId?: string): ExecutionRef {
    const execution = this.store.atomic(() => {
      const value = this.store.admitExecution(this.ref, turnId, dispatchAttempt, admissionId);
      const sourceMessageId = this.ds.session.turnReplyContexts?.[turnId]?.sourceMessageId;
      this.store.rememberResultBinding(this.ref, { ref: { botId: this.ref.appId, sessionId: this.ref.sessionId, turnId, dispatchAttempt },
        source: { kind: this.ds.chatId?.startsWith('http') ? 'http' : 'im', chatId: this.ds.chatId,
          ...(sourceMessageId ? { messageId: sourceMessageId } : {}) }, workerGeneration: this.store.read(this.ref)?.worker?.generation ?? 1 });
      return value;
    }); this.refresh(); return execution.ref;
  }
  currentRuntime(): RuntimeRef | undefined { return this.store.read(this.ref)?.activeRuntime; }
  command(message: { type: string; turnId?: string; dispatchAttempt?: number; attemptId?: string; sessionCommand?: import('../services/session-contract.js').SessionCommandContext }): import('../services/session-contract.js').SessionCommandContext {
    const execution = message.sessionCommand?.execution ?? (message.turnId ? this.store.executions(this.ref, message.turnId, message.dispatchAttempt)[0]?.ref : undefined);
    const operation = message.attemptId ? this.operation(message.attemptId) : this.operation();
    const target = execution ? this.store.execution(this.ref, execution.executionId)?.runtime ?? this.currentRuntime() : this.currentRuntime();
    return message.sessionCommand ?? { version: 2, ...(target ? { runtime: target } : {}),
      ...(execution ? { execution } : {}), ...(operation ? { operationId: operation.operationId } : {}) };
  }
  operation(operationId?: string): ControlOperation | undefined { return this.store.operation(this.ref, operationId); }
  beginControl(kind: ControlKind, operationId?: string, execution?: ExecutionRef): { operation: ControlOperation; joined: boolean } {
    const value = this.store.beginOperation(this.ref, kind, { operationId, execution }); this.refresh(); return value;
  }
  controlStarted(operationId: string): boolean { const result = this.store.apply(this.ref, { type: 'control_started', operationId }); this.refresh(); return result.decision === 'applied'; }
  controlResult(operationId: string, phase: 'confirmed' | 'failed_before_effect' | 'rejected' | 'uncertain', runtime?: RuntimeRef, error?: string): void {
    this.store.apply(this.ref, { type: 'control_result', operationId, phase, ...(runtime ? { runtime } : {}), ...(error ? { error } : {}) }); this.refresh();
  }
  allowsInput(): boolean {
    const state = this.store.read(this.ref)!;
    return state.lifecycle === 'active' && !state.activeOperationId;
  }
  /** User input is not owned by a control operation: the worker queues it
   * across restart/resume, and an unverified suspend leaves the executor live. */
  acceptsUserInput(): boolean {
    return !['closing', 'closed'].includes(this.store.read(this.ref)!.lifecycle);
  }
  prepareResume(): string | undefined {
    if (this.store.read(this.ref)!.lifecycle !== 'suspended') return this.operation()?.kind === 'resume' ? this.operation()!.operationId : undefined;
    const { operation } = this.beginControl('resume'); this.controlStarted(operation.operationId); return operation.operationId;
  }
  /** Operation the first runtime of a newly forked worker binds under. A new
   * worker replaces whatever executor an unverified suspend/cancel left. */
  prepareWorkerStart(requested?: string): string | undefined {
    const resume = this.prepareResume(); if (requested || resume) return requested ?? resume;
    let operation = this.operation();
    if (operation?.phase === 'uncertain' && (operation.kind === 'suspend' || operation.kind === 'cancel')) {
      operation = this.beginControl('restart').operation; this.controlStarted(operation.operationId);
    }
    return operation?.kind === 'restart' ? operation.operationId : undefined;
  }
  currentAuthority(): boolean {
    const active = eventScope.getStore();
    if (!active) return this.allowsInput();
    if (active.kind !== 'current' && active.kind !== 'worker') return false;
    const state = this.store.read(this.ref)!;
    const runtime = active.context.scope.runtime;
    return sameWorker(state.worker, active.context.producer) && (!runtime || sameRuntime(state.activeRuntime, runtime)
      || this.store.continuedExecution(this.ref, runtime, active.context.producer, active.context.scope.execution)) && !['closing', 'closed', 'suspended'].includes(state.lifecycle);
  }
  run<T>(admission: SessionEventAdmission, work: () => T): T { return eventScope.run(admission, work); }
  outputOrigin(origin: SessionEventContext): SessionEventContext | undefined {
    const value = structuredClone(origin);
    if (value.session.appId !== this.ref.appId || value.session.sessionId !== this.ref.sessionId) return undefined;
    if (value.bindingId && this.store.bindingProducer(this.ref, value.bindingId, value.producer)) value.scope.runtime = this.store.binding(this.ref, value.bindingId)?.ref;
    const runtime = value.scope.runtime;
    if (!runtime || (!this.store.authorizedProducer(this.ref, runtime, value.producer)
      && !this.store.authorizedExecutionObserver(this.ref, runtime, value.producer, value.scope.execution)
      && !(value.bindingId && this.store.bindingProducer(this.ref, value.bindingId, value.producer)))) return undefined;
    if (value.scope.execution) {
      const execution = this.store.execution(this.ref, value.scope.execution.executionId);
      if (!execution || (execution.runtime && !sameRuntime(execution.runtime, runtime))) return undefined;
    }
    return value;
  }
  ingest(message: ControlledWorkerMessage, channel: WorkerRef, recoveredOrigin?: SessionEventContext): SessionEventAdmission {
    return this.store.atomic(() => this.ingestInside(message, channel, recoveredOrigin));
  }
  private ingestInside(message: ControlledWorkerMessage, channel: WorkerRef, recoveredOrigin?: SessionEventContext): SessionEventAdmission {
    const metadata = message.sessionContract;
    if (!metadata || metadata.version !== 2 || !sameWorker(metadata.producer, channel)) return { kind: 'reject', reason: 'session_event_context_missing' };
    const context: WorkerContractContext = structuredClone(metadata);
    const sidecar = message.type === 'final_output' ? message.sessionOutputOrigin as SessionEventContext | undefined : undefined;
    if (sidecar && (sidecar.session.appId !== this.ref.appId || sidecar.session.sessionId !== this.ref.sessionId
      || (sidecar.scope.execution && (sidecar.scope.execution.turnId !== message.turnId
        || (context.scope.execution && sidecar.scope.execution.executionId !== context.scope.execution.executionId))))) return { kind: 'reject', reason: 'output_origin_conflict' };
    if (recoveredOrigin) {
      if (context.scope.runtime && !sameRuntime(context.scope.runtime, recoveredOrigin.scope.runtime)) return { kind: 'reject', reason: 'output_runtime_conflict' };
      context.scope.runtime = recoveredOrigin.scope.runtime;
    }
    if (sidecar) {
      const proven = this.outputOrigin(sidecar);
      const binding = context.bindingId && this.store.bindingProducer(this.ref, context.bindingId, channel) ? this.store.binding(this.ref, context.bindingId) : undefined;
      const scopedRuntime = context.scope.runtime ?? binding?.ref;
      if (!proven || (scopedRuntime && !sameRuntime(scopedRuntime, proven.scope.runtime))) return { kind: 'reject', reason: 'output_origin_conflict' };
    }
    if (message.type === 'restart_result' && context.scope.operationId !== message.attemptId) return { kind: 'reject', reason: 'restart_operation_mismatch' };
    // Turn authority must refer to an existing admission. Origin publication
    // and revocation cannot create an attempt through the legacy inference path.
    if (['turn_input_received', 'turn_input_committed', 'turn_input_rejected', 'turn_interrupt_result', 'managed_turn_origin', 'managed_turn_origin_revoked'].includes(message.type)
      && message.turnId && !context.scope.execution) return { kind: 'reject', reason: 'execution_scope_missing' };
    if (context.session.appId !== this.ref.appId || context.session.sessionId !== this.ref.sessionId
      || !Number.isSafeInteger(context.sequence) || context.sequence < 1 || context.eventId !== `${channel.workerId}:${context.sequence}`
      || (message.turnId && context.scope.execution && (message.turnId !== context.scope.execution.turnId || ('dispatchAttempt' in message && message.dispatchAttempt !== context.scope.execution.dispatchAttempt)))) return { kind: 'reject', reason: 'session_event_reference_mismatch' };
    if (context.scope.execution && !sameExecution(this.store.execution(this.ref, context.scope.execution.executionId)?.ref, context.scope.execution)) return { kind: 'reject', reason: 'execution_scope_unproven' };
    if (context.bindingId) {
      const runtime = this.store.binding(this.ref, context.bindingId);
      if (runtime && this.store.bindingProducer(this.ref, context.bindingId, channel)) {
        if (context.scope.runtime && !sameRuntime(context.scope.runtime, runtime.ref)) return { kind: 'reject', reason: 'runtime_binding_scope_mismatch' };
        const waitsForBinding = message.type === 'restart_result' && message.status === 'succeeded';
        // A start that never bound can still report why it failed; that report
        // is worker-scoped and must outlive the released reservation.
        const failureReport = message.type === 'error' || message.type === 'worker_error' || (message.type === 'restart_result' && message.status !== 'succeeded');
        if (!runtime.identity && !failureReport && ['stopped', 'retiring'].includes(runtime.phase)) return { kind: 'reject', reason: 'runtime_reservation_abandoned' };
        if (!runtime.identity && !failureReport && (waitsForBinding || !['ready', 'turn_input_received', 'turn_input_committed', 'turn_input_rejected', 'restart_result', 'session_ready_ack', 'persistent_backend_target'].includes(message.type))) {
          this.store.deferEvent(this.ref, context.bindingId, context.eventId, context.sequence, message);
          return { kind: 'defer', bindingId: context.bindingId };
        }
        if (runtime.identity) context.scope.runtime = runtime.ref;
      }
    }
    if (sidecar) {
      const proven = this.outputOrigin(sidecar);
      if (!proven || (context.scope.runtime && !sameRuntime(context.scope.runtime, proven.scope.runtime))
        || (context.scope.execution && proven.scope.execution && context.scope.execution.executionId !== proven.scope.execution.executionId)) return { kind: 'reject', reason: 'output_origin_conflict' };
    }
    if (!context.scope.execution && typeof message.turnId === 'string' && context.scope.runtime && this.store.authorizedProducer(this.ref, context.scope.runtime, channel)) {
      const preliminary = this.gateway.admit(message.type, context, channel);
      if (preliminary.kind === 'reject' || preliminary.kind === 'defer') return preliminary;
      const existing = this.store.executions(this.ref, message.turnId, message.dispatchAttempt);
      const current = this.currentRuntime();
      // A turn the CLI starts itself is reported under the binding it was
      // spawned with; an in-process continuation moved that CLI to `current`.
      if (current && !sameRuntime(current, context.scope.runtime) && !existing.some(value => sameRuntime(value.runtime, context.scope.runtime))
        && this.store.runtimeContinues(this.ref, context.scope.runtime, current, channel)) context.scope.runtime = current;
      if (existing.length === 1) context.scope.execution = existing[0].ref;
      else if (!existing.length && sameRuntime(current, context.scope.runtime)) context.scope.execution = this.admitInput(message.turnId, message.dispatchAttempt);
    }
    const uncertainTerminal = message.type === 'turn_terminal' && contractTerminalStatus(message.status, message.errorCode) === 'reconciling';
    if (['turn_terminal', 'final_output', 'turn_execution_started', 'native_input_consumed'].includes(message.type) && !context.scope.execution) return { kind: 'reject', reason: 'execution_scope_missing' };
    const admission = this.gateway.admit(message.type, context, channel, recoveredOrigin);
    if (admission.kind === 'reject' || admission.kind === 'defer') return admission;
    const runtime = context.scope.runtime; const execution = context.scope.execution;
    if (execution && runtime && !recoveredOrigin && !uncertainTerminal && ['turn_execution_started', 'native_input_consumed', 'turn_terminal', 'final_output'].includes(message.type)) {
      try { this.store.bindQueuedExecution(this.ref, execution, runtime); }
      catch { return { kind: 'reject', reason: 'execution_runtime_conflict' }; }
    }
    if (runtime && ['prompt_ready', 'screen_update', 'active_runtime', 'remote_backend_state', 'remote_usage', 'usage_update', 'cli_session_id'].includes(message.type)
      && !this.store.acceptObservation(this.ref, channel, runtime, context.sequence)) return { kind: 'reject', reason: 'stale_observation_sequence' };
    let event: ContractEvent | undefined;
    if (message.type === 'ready') event = { type: 'worker_online', worker: channel };
    if (message.type === 'prompt_ready' && runtime) event = { type: 'runtime_ready', runtime };
    if (message.type === 'screen_update' && runtime && message.status === 'working') event = { type: 'runtime_busy', runtime };
    if (message.type === 'claude_exit' && runtime) event = { type: 'runtime_lost', runtime, confirmed: true, reason: 'native_exit' };
    if (message.type === 'turn_execution_started' && runtime && execution) event = { type: 'execution_phase', runtime, execution, phase: 'submitting' };
    if (message.type === 'native_input_consumed' && runtime && execution) event = { type: 'execution_phase', runtime, execution, phase: 'accepted' };
    if (message.type === 'turn_terminal' && runtime && execution) {
      const code = typeof message.errorCode === 'string' ? message.errorCode : undefined;
      event = { type: 'execution_terminal', runtime, execution,
        status: contractTerminalStatus(message.status, code),
        evidence: code === 'preempted_by_user_message' ? 'caller_interrupt_boundary' : uncertainTerminal ? 'observer_loss' : 'native_terminal', ...(code ? { errorCode: code } : {}) };
    }
    if (message.type === 'final_output' && execution) event = { type: 'execution_output', execution, output: { availability: message.content ? 'available' : 'empty', ...(typeof message.content === 'string' ? { content: message.content } : {}), completeness: message.turnFailed ? 'partial' : 'final' } };
    if (message.type === 'restart_result' && typeof message.attemptId === 'string') event = { type: 'control_result', operationId: message.attemptId, phase: message.status === 'succeeded' ? 'confirmed' : message.untouched ? 'failed_before_effect' : message.status === 'failed' ? 'rejected' : 'uncertain', ...(runtime ? { runtime } : {}), ...(message.status === 'failed' && typeof message.category === 'string' ? { error: message.category } : {}) };
    if (message.type === 'turn_interrupt_result' && context.scope.operationId) {
      const operation = this.operation(context.scope.operationId);
      if (!operation || operation.kind !== 'cancel' || operation.targetExecution?.turnId !== message.turnId
        || (operation.targetRuntime && !sameRuntime(operation.targetRuntime, runtime))) return { kind: 'reject', reason: 'cancel_operation_mismatch' };
      event = { type: 'control_result', operationId: operation.operationId, phase: message.delivered ? 'confirmed' : message.reason === 'delivery_failed' ? 'uncertain' : 'rejected' };
    }
    if (event) {
      const result = this.store.apply(this.ref, event, context.eventId); this.refresh();
      if (result.decision === 'conflict' || result.decision === 'stale') return { kind: 'reject', reason: result.reason ?? `contract_${result.decision}` };
    }
    if (message.type === 'claude_exit' && runtime) {
      let currentPhysicalExit = false;
      // The exit callback keeps the binding its CLI was spawned under.
      const exited = new Map<string, RuntimeContract>();
      for (const ref of [runtime, ...this.store.continuedRuntimes(this.ref, runtime, channel)]) {
        for (const sibling of this.store.physicalRuntimes(this.ref, ref)) exited.set(sibling.ref.runtimeId, sibling);
      }
      for (const sibling of exited.values()) {
        if (!sameRuntime(sibling.ref, runtime)) this.store.apply(this.ref, { type: 'runtime_lost', runtime: sibling.ref, confirmed: true, reason: 'physical_exit' }, `${context.eventId}:${sibling.ref.runtimeId}`);
        this.store.markUnresolvedExecutions(this.ref, sibling.ref);
        if (sameRuntime(sibling.ref, this.currentRuntime())) currentPhysicalExit = true;
      }
      this.refresh();
      const current = this.currentRuntime();
      if (currentPhysicalExit && current && !this.store.hasPendingRuntimeReplacement(this.ref, current)) return { kind: 'current', context: { ...context, scope: { ...context.scope, runtime: current } } };
    }
    return admission;
  }
  workerLost(worker: WorkerRef): void {
    this.store.apply(this.ref, { type: 'worker_lost', worker });
    const runtime = this.store.runtime(this.ref);
    if (runtime && sameWorker(runtime.worker, worker)) {
      this.store.apply(this.ref, { type: 'runtime_lost', runtime: runtime.ref, confirmed: false, reason: 'worker_disconnected' });
      this.store.markUnresolvedExecutions(this.ref, runtime.ref);
    }
    this.refresh();
  }
}
export function controllerForSession(ds: DaemonSession, bootstrap = false): SessionController | undefined {
  if (!sessionContractsEnabled() || !isOutputJournalAppId(ds.larkAppId)) return undefined;
  if (!bootstrap && !ds.initConfig?.sessionContract && ds.session.sessionContractRevision === undefined) return undefined;
  let controller = controllers.get(ds);
  if (!controller) { controller = new SessionController(ds); controllers.set(ds, controller); }
  return controller;
}
