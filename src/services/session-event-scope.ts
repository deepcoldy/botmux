import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { sameRuntime, sameExecution, type ContractSessionRef, type WorkerRef, type RuntimeRef, type ExecutionRef, type SessionEventContext, type RuntimeIdentity, type ExecutionAdmissionState } from './session-contract.js';

export interface CapturedSessionOrigin {
  bindingId: string;
  runtime?: RuntimeRef;
  execution?: ExecutionRef;
  operationId?: string;
}
export interface RuntimeEventBinding {
  bindingId: string;
  physicalId: string;
  runtime?: RuntimeRef;
  proposedRuntime?: RuntimeRef;
  operationId?: string;
  identity?: RuntimeIdentity;
  continuation?: import('./session-contract.js').RuntimeExecutionContinuation;
}
interface Context { binding?: RuntimeEventBinding; execution?: ExecutionRef; operationId?: string }

/** Async work keeps the binding it was created under. Live physical screen
 * callbacks opt in separately; old async callbacks never borrow current state. */
export class WorkerSessionEventScope {
  private readonly storage = new AsyncLocalStorage<Context>();
  private readonly bindings = new Map<string, RuntimeEventBinding>();
  private readonly origins = new Map<string, Array<{ binding: RuntimeEventBinding; execution: ExecutionRef }>>();
  private readonly knownExecutions = new Map<string, ExecutionRef>();
  private readonly admissionStates = new Map<string, ExecutionAdmissionState>();
  private readonly submissions = new Map<string, RuntimeEventBinding>();
  private readonly continuations = new Map<string, RuntimeEventBinding>();
  private current?: RuntimeEventBinding;
  private readonly predecessors = new Map<string, RuntimeEventBinding | undefined>();
  private readonly aborted = new Set<string>();
  private readonly abortReports = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  constructor(readonly session: ContractSessionRef, readonly worker: WorkerRef) {}
  beginRuntime(operationId?: string, physicalId: string = randomUUID()): RuntimeEventBinding {
    const value: RuntimeEventBinding = { bindingId: randomUUID(), physicalId, ...(operationId ? { operationId } : {}) };
    this.predecessors.set(value.bindingId, this.current);
    this.bindings.set(value.bindingId, value); this.current = value; return value;
  }
  assign(bindingId: string, runtime: RuntimeRef): boolean {
    const binding = this.bindings.get(bindingId); if (!binding) return false;
    if (binding.runtime && (binding.runtime.runtimeId !== runtime.runtimeId || binding.runtime.epoch !== runtime.epoch)) throw new Error('runtime_binding_reassigned');
    binding.runtime = runtime; return true;
  }
  currentBinding(): RuntimeEventBinding | undefined { return this.current; }
  bindingSharesCurrentProcess(bindingId: string): boolean {
    const binding = this.bindings.get(bindingId);
    return !!binding && !!this.current && binding.physicalId === this.current.physicalId;
  }
  restoreAfterAbortedStart(binding: RuntimeEventBinding, previous?: RuntimeEventBinding): void {
    if (binding.runtime) return;
    if (previous && this.bindings.get(previous.bindingId) !== previous) throw new Error('previous_runtime_binding_unproven');
    this.aborted.add(binding.bindingId);
    if (this.current !== binding) return;
    let source = this.predecessors.get(binding.bindingId);
    while (source && this.aborted.has(source.bindingId)) source = this.predecessors.get(source.bindingId);
    this.current = source;
  }
  reportAbortedStart(binding: RuntimeEventBinding, report: () => void): void {
    if (!this.aborted.has(binding.bindingId) || this.abortReports.has(binding.bindingId)) return;
    const pending: { timer?: ReturnType<typeof setTimeout> } = {};
    this.abortReports.set(binding.bindingId, pending);
    const retry = (): void => {
      if (this.abortReports.get(binding.bindingId) !== pending) return;
      try { this.run(binding, report); } catch { /* retry until the host confirms persistence */ }
      if (this.abortReports.get(binding.bindingId) !== pending) return;
      pending.timer = setTimeout(retry, 1_000); pending.timer.unref?.();
    };
    retry();
  }
  refuseBinding(bindingId: string): void {
    const binding = this.bindings.get(bindingId);
    if (binding) this.restoreAfterAbortedStart(binding);
  }
  confirmAbortedStart(bindingId: string): void {
    const pending = this.abortReports.get(bindingId); if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.abortReports.delete(bindingId);
  }
  isCurrentContext(): boolean {
    const origin = this.storage.getStore()?.binding;
    // A semantic rebind keeps the physical CLI, so callbacks started with it still drive it.
    return !origin || origin === this.current || sameRuntime(origin.runtime, this.current?.runtime)
      || origin.physicalId === this.current?.physicalId;
  }
  noteAdmission(state: ExecutionAdmissionState): void {
    this.knownExecutions.set(state.ref.executionId, state.ref);
    const previous = this.admissionStates.get(state.ref.executionId);
    if (previous && previous.phase !== 'queued' && state.phase === 'queued') return;
    this.admissionStates.set(state.ref.executionId, structuredClone(state));
  }
  /** Only an explicit host grant may reset the state of an already submitted
   * ordinary turn. Ordinary canSubmit keeps its lifetime duplicate fence. */
  acceptContinuation(bindingId: string, state: ExecutionAdmissionState): boolean {
    const current = this.current;
    const addressed = this.bindings.get(bindingId);
    const binding = state.runtime && this.bindingForRuntime(state.runtime);
    const key = this.turnKey(state.ref.turnId, state.ref.dispatchAttempt);
    const source = this.submissions.get(key);
    const previous = this.admissionStates.get(state.ref.executionId);
    if (!current || !addressed || !binding || !binding.runtime
      || addressed.physicalId !== current.physicalId || binding.physicalId !== current.physicalId
      || !current.identity?.nativeSessionId || current.identity.nativeSessionId !== binding.identity?.nativeSessionId
      || !sameRuntime(state.runtime, binding.runtime) || state.phase !== 'accepted'
      || state.ref.dispatchAttempt !== undefined
      || !sameExecution(this.executionForTurn(state.ref.turnId), state.ref)
      || !source || source.physicalId === binding.physicalId
      || (previous && !['submitting', 'accepted', 'running'].includes(previous.phase))) return false;
    this.continuations.set(key, binding);
    this.admissionStates.set(state.ref.executionId, structuredClone(state));
    this.rememberExecution(state.ref, binding);
    return true;
  }
  canSubmitContinuation(turnId: string, execution: ExecutionRef): boolean {
    const key = this.turnKey(turnId, execution.dispatchAttempt);
    const current = this.current;
    const binding = this.continuations.get(key);
    const state = this.admissionStates.get(execution.executionId);
    const source = this.submissions.get(key);
    return execution.turnId === turnId && execution.dispatchAttempt === undefined
      && sameExecution(this.executionForTurn(turnId), execution)
      && !!current && !!binding && binding.physicalId === current.physicalId
      && !!current.identity?.nativeSessionId && current.identity.nativeSessionId === binding.identity?.nativeSessionId
      && sameRuntime(state?.runtime, binding.runtime) && state?.phase === 'accepted'
      && !!source && source.physicalId !== binding.physicalId;
  }
  enterContinuation(turnId: string, execution: ExecutionRef): void {
    if (!this.canSubmitContinuation(turnId, execution)) throw new Error('execution_continuation_unproven');
    this.enterRuntime(this.continuations.get(this.turnKey(turnId))!, execution);
  }
  canSubmit(turnId?: string, dispatchAttempt?: number, admitted?: ExecutionRef): boolean {
    if (!turnId) return true;
    if (admitted && admitted.turnId !== turnId) return false;
    const execution = admitted ?? this.executionForTurn(turnId, dispatchAttempt);
    if (!execution && [...this.knownExecutions.values()].some(value => value.turnId === turnId)) return false;
    const state = execution ? this.admissionStates.get(execution.executionId) : undefined;
    if (state && state.phase !== 'queued') return false;
    const submission = this.submissions.get(this.turnKey(turnId, admitted?.dispatchAttempt ?? dispatchAttempt));
    return !submission;
  }
  recordSubmission(turnId?: string, dispatchAttempt?: number): void {
    const binding = this.storage.getStore()?.binding ?? this.current;
    if (!binding || !turnId) return;
    this.submissions.set(this.turnKey(turnId, dispatchAttempt), binding);
    this.continuations.delete(this.turnKey(turnId, dispatchAttempt));
    const execution = this.executionForTurn(turnId, dispatchAttempt);
    if (execution) this.noteAdmission({ ref: execution, runtime: binding.runtime ?? binding.proposedRuntime, phase: 'submitting' });
  }
  ownsExecutionEvent(turnId: string, dispatchAttempt?: number): boolean {
    const origin = this.storage.getStore()?.binding;
    if (!origin) return true;
    // A semantic rebind keeps the physical CLI. Observers started with it still
    // own the turns it was given, whichever binding they were captured under.
    const submission = this.submissions.get(this.turnKey(turnId, dispatchAttempt));
    if (submission) return submission === origin || sameRuntime(submission.runtime, origin.runtime) || submission.physicalId === origin.physicalId;
    const execution = this.executionForTurn(turnId, dispatchAttempt);
    const state = execution ? this.admissionStates.get(execution.executionId) : undefined;
    if (state?.runtime) return sameRuntime(state.runtime, origin.runtime) || this.bindingForRuntime(state.runtime)?.physicalId === origin.physicalId;
    return this.isCurrentContext();
  }
  bindingForRuntime(runtime: RuntimeRef): RuntimeEventBinding | undefined {
    return [...this.bindings.values()].find(binding => binding.runtime?.runtimeId === runtime.runtimeId && binding.runtime.epoch === runtime.epoch);
  }
  replayEnvelope(origin: SessionEventContext): SessionEventContext {
    const sequence = ++this.sequence;
    return { version: 2, session: this.session, producer: this.worker,
      eventId: `${this.worker.workerId}:${sequence}`, sequence, scope: structuredClone(origin.scope) };
  }
  contextBinding(): RuntimeEventBinding | undefined { return this.storage.getStore()?.binding; }
  run<T>(binding: RuntimeEventBinding, work: () => T, execution?: ExecutionRef, operationId?: string): T {
    return this.storage.run({ binding, ...(execution ? { execution } : {}), ...(operationId ? { operationId } : {}) }, work);
  }
  enterRuntime(binding: RuntimeEventBinding, execution?: ExecutionRef): void {
    this.storage.enterWith({ binding, ...(execution ? { execution } : {}) });
  }
  executionForTurn(turnId?: string, dispatchAttempt?: number): ExecutionRef | undefined {
    if (!turnId) return undefined;
    const values = this.origins.get(this.turnKey(turnId, dispatchAttempt)) ?? [];
    const known = [...this.knownExecutions.values()].filter(value => value.turnId === turnId && (dispatchAttempt === undefined || value.dispatchAttempt === dispatchAttempt));
    const unique = new Map([...values.map(value => [value.execution.executionId, value.execution] as const), ...known.map(value => [value.executionId, value] as const)]);
    return unique.size === 1 ? [...unique.values()][0] : undefined;
  }
  enterTurn(turnId?: string, dispatchAttempt?: number): void {
    const binding = this.current;
    const execution = this.executionForTurn(turnId, dispatchAttempt);
    if (binding) {
      if (execution) this.rememberExecution(execution, binding);
      this.enterRuntime(binding, execution);
    }
  }
  withExecution<T>(execution: ExecutionRef, work: () => T): T {
    const binding = this.storage.getStore()?.binding ?? this.current;
    if (!binding) throw new Error('execution_runtime_unbound');
    return this.run(binding, work, execution, this.storage.getStore()?.operationId);
  }
  bind<T extends (...args: any[]) => any>(callback: T): T {
    const captured = this.storage.getStore() ?? { binding: this.current };
    return ((...args: Parameters<T>) => this.storage.run(captured, () => callback(...args))) as T;
  }
  bindLivePhysical<T extends (...args: any[]) => any>(callback: T): T {
    const physicalId = (this.storage.getStore()?.binding ?? this.current)?.physicalId;
    return ((...args: Parameters<T>) => {
      if (!this.current || this.current.physicalId !== physicalId) return;
      return this.run(this.current, () => callback(...args));
    }) as T;
  }
  bindExecutionEvent<T extends (...args: any[]) => any>(callback: T,
    select?: (args: Parameters<T>) => { turnId?: string; dispatchAttempt?: number; origin?: CapturedSessionOrigin }): T {
    const captured = this.storage.getStore() ?? { binding: this.current };
    const physicalId = captured.binding?.physicalId;
    return ((...args: Parameters<T>) => {
      const selected = select?.(args);
      let context = this.storage.getStore();
      if (context?.binding?.physicalId !== physicalId) context = undefined;
      if (selected?.origin) {
        const binding = this.bindings.get(selected.origin.bindingId);
        if (!binding || binding.physicalId !== physicalId) return;
        context = { binding, execution: selected.origin.execution, operationId: selected.origin.operationId };
      } else if (selected?.turnId) {
        const candidates = [...this.origins.values()].flat().filter(value => value.binding.physicalId === physicalId
          && value.execution.turnId === selected.turnId && (selected.dispatchAttempt === undefined || value.execution.dispatchAttempt === selected.dispatchAttempt));
        const unique = new Map(candidates.map(value => [value.execution.executionId, value]));
        if (unique.size === 1) { const value = [...unique.values()][0]; context = { binding: value.binding, execution: value.execution }; }
        else if (unique.size > 1) return;
      }
      return this.storage.run(context ?? captured, () => callback(...args));
    }) as T;
  }
  bindObservation<T extends (...args: any[]) => any>(callback: T): T {
    return this.bindExecutionEvent(callback);
  }
  rememberExecution(execution: ExecutionRef, binding = this.storage.getStore()?.binding ?? this.current): void {
    this.knownExecutions.set(execution.executionId, execution);
    if (!binding) return;
    const key = this.turnKey(execution.turnId, execution.dispatchAttempt);
    const values = this.origins.get(key) ?? [];
    if (!values.some(value => value.binding === binding && value.execution.executionId === execution.executionId)) values.push({ binding, execution });
    this.origins.set(key, values);
  }
  rememberObservedExecution(bindingId: string, runtime: RuntimeRef, execution: ExecutionRef): void {
    const source = this.bindings.get(bindingId);
    if (!source) return;
    let binding = [...this.bindings.values()].find(value => value.physicalId === source.physicalId && sameRuntime(value.runtime, runtime));
    if (!binding) {
      binding = { bindingId: randomUUID(), physicalId: source.physicalId, runtime: structuredClone(runtime) };
      this.bindings.set(binding.bindingId, binding);
    }
    this.rememberExecution(execution, binding);
  }
  origin(turnId?: string, dispatchAttempt?: number): CapturedSessionOrigin | undefined {
    const active = this.storage.getStore();
    // The daemon bound the attempt to the runtime it was submitted under.
    // Within one physical CLI that outranks the binding a callback captured.
    const submission = turnId ? this.submissions.get(this.turnKey(turnId, dispatchAttempt)) : undefined;
    if (turnId && active?.binding && submission && submission !== active.binding && submission.physicalId === active.binding.physicalId) {
      const execution = this.executionForTurn(turnId, dispatchAttempt);
      if (execution) return this.snapshot(submission, execution);
    }
    if (active?.binding && active.execution && (!turnId || active.execution.turnId === turnId)) return this.snapshot(active.binding, active.execution);
    if (turnId) {
      const values = this.origins.get(this.turnKey(turnId, dispatchAttempt)) ?? [];
      const inBinding = active?.binding ? values.filter(value => value.binding === active.binding) : values;
      if (inBinding.length === 1) return this.snapshot(inBinding[0].binding, inBinding[0].execution);
      if (inBinding.length > 1) return undefined;
    }
    return active?.binding ? this.snapshot(active.binding) : undefined;
  }
  operationOrigin(operationId: string): CapturedSessionOrigin | undefined {
    const binding = [...this.bindings.values()].find(value => value.operationId === operationId);
    return binding ? this.snapshot(binding) : undefined;
  }
  capture(): CapturedSessionOrigin | undefined {
    const context = this.storage.getStore(); return context?.binding ? { ...this.snapshot(context.binding, context.execution), ...(context.operationId ? { operationId: context.operationId } : {}) } : undefined;
  }
  restore(origin: CapturedSessionOrigin): RuntimeEventBinding {
    let binding = this.bindings.get(origin.bindingId);
    if (!binding) {
      binding = { bindingId: origin.bindingId, physicalId: `restored:${origin.bindingId}`, ...(origin.runtime ? { runtime: origin.runtime } : {}) };
      this.bindings.set(origin.bindingId, binding);
    }
    if (origin.execution) this.rememberExecution(origin.execution, binding);
    return binding;
  }
  envelope(origin?: CapturedSessionOrigin): SessionEventContext & { bindingId?: string } {
    const value = origin ?? this.capture(); const sequence = ++this.sequence;
    return {
      version: 2, session: this.session, producer: this.worker, eventId: `${this.worker.workerId}:${sequence}`, sequence,
      ...(value ? { bindingId: value.bindingId } : {}),
      scope: { ...(value?.runtime ? { runtime: value.runtime } : {}), ...(value?.execution ? { execution: value.execution } : {}),
        ...((value?.operationId ?? this.storage.getStore()?.operationId ?? (value && this.bindings.get(value.bindingId)?.operationId))
          ? { operationId: value?.operationId ?? this.storage.getStore()?.operationId ?? (value && this.bindings.get(value.bindingId)?.operationId) } : {}) },
    };
  }
  private snapshot(binding: RuntimeEventBinding, execution?: ExecutionRef): CapturedSessionOrigin {
    const context = this.storage.getStore();
    const operationId = context?.binding === binding ? context.operationId ?? binding.operationId : binding.operationId;
    return { bindingId: binding.bindingId, ...(binding.runtime ? { runtime: structuredClone(binding.runtime) } : {}), ...(execution ? { execution: structuredClone(execution) } : {}), ...(operationId ? { operationId } : {}) };
  }
  private turnKey(turnId: string, dispatchAttempt?: number): string { return JSON.stringify([turnId, dispatchAttempt ?? null]); }
}
