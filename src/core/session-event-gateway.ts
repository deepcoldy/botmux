import type { SessionContractStore } from '../services/session-contract-store.js';
import { sameRuntime, sameWorker, type ContractSessionRef, type SessionEventContext, type WorkerRef } from '../services/session-contract.js';

export type SessionEventAdmission =
  | { kind: 'current'; context: SessionEventContext }
  | { kind: 'historical'; context: SessionEventContext }
  | { kind: 'worker'; context: SessionEventContext }
  | { kind: 'defer'; bindingId: string }
  | { kind: 'reject'; reason: string };
const immutableFacts = new Set(['turn_terminal', 'final_output', 'final_output_offer', 'turn_interrupt_result', 'codex_app_dispatch_persisted', 'restart_result', 'claude_exit']);
// persistent_backend_target is stamped before the CLI spawns, so it can only be worker-scoped.
// session_identity_decision is the worker's report of the spawn it is about to
// make (sandbox / loopback shape). It is sent before the CLI exists, while an
// opening turn is still queued: from inside the reserved binding (held with it
// until the binding settles, so a start that aborts never applies it), or from
// the Codex RPC engine outside any binding. Scoping it to a runtime or turn
// refused it on every start that carries an opening turn and on every RPC
// start, leaving the daemon on the fail-closed single model and every proven
// identity wrapper on exit 77. It grants nothing: the producer is still the
// current worker channel, any execution it names must exist, and the daemon
// handler re-checks generation, session and structural possibility.
// cli_input_backlog reports the worker's own input queue, which outlives runtime
// re-bindings; the worker sends it without a runtime (see sessionEventMetadata).
const workerEvents = new Set(['worker_ipc_ready', 'ready', 'worker_error', 'error', 'transfer_detached', 'runtime_binding', 'runtime_binding_started', 'runtime_binding_aborted', 'turn_input_received', 'turn_input_committed', 'turn_input_rejected', 'turn_interrupt_result', 'restart_result', 'session_ready_ack', 'persistent_backend_target', 'session_identity_decision', 'cli_input_backlog']);
/** A trusted channel supplies producer identity. An event cannot self-upgrade
 * to the current execution instance merely because its IPC worker survived. */
export class SessionEventGateway {
  constructor(readonly store: SessionContractStore, readonly session: ContractSessionRef) {}
  admit(type: string, context: SessionEventContext | undefined, channel: WorkerRef, recoveredOrigin?: SessionEventContext): SessionEventAdmission {
    if (!context || context.version !== 2) return { kind: 'reject', reason: 'session_event_context_missing' };
    if (context.session.appId !== this.session.appId || context.session.sessionId !== this.session.sessionId || !sameWorker(context.producer, channel)) return { kind: 'reject', reason: 'session_event_channel_mismatch' };
    if (!Number.isSafeInteger(context.sequence) || context.sequence < 1 || context.eventId !== `${channel.workerId}:${context.sequence}`) return { kind: 'reject', reason: 'invalid_session_event_sequence' };
    const state = this.store.read(this.session); if (!state) return { kind: 'reject', reason: 'session_contract_missing' };
    const runtime = context.scope.runtime;
    if (!runtime) {
      if (context.scope.execution) {
        const execution = this.store.execution(this.session, context.scope.execution.executionId);
        if (!execution || execution.ref.turnId !== context.scope.execution.turnId || execution.ref.dispatchAttempt !== context.scope.execution.dispatchAttempt) return { kind: 'reject', reason: 'execution_scope_unproven' };
      }
      return workerEvents.has(type) && sameWorker(state.worker, channel) ? { kind: 'worker', context } : { kind: 'reject', reason: 'runtime_scope_missing' };
    }
    const recovery = type === 'final_output' && recoveredOrigin
      && recoveredOrigin.session.appId === this.session.appId && recoveredOrigin.session.sessionId === this.session.sessionId
      && sameRuntime(recoveredOrigin.scope.runtime, runtime)
      && recoveredOrigin.scope.execution?.executionId === context.scope.execution?.executionId
      && (this.store.authorizedProducer(this.session, runtime, recoveredOrigin.producer)
        || this.store.authorizedExecutionObserver(this.session, runtime, recoveredOrigin.producer, recoveredOrigin.scope.execution)
        || (recoveredOrigin.bindingId && this.store.bindingProducer(this.session, recoveredOrigin.bindingId, recoveredOrigin.producer)
          && sameRuntime(this.store.binding(this.session, recoveredOrigin.bindingId)?.ref, runtime)));
    const observation = sameWorker(state.worker, channel) && ['final_output', 'turn_terminal'].includes(type)
      && this.store.authorizedExecutionObserver(this.session, runtime, channel, context.scope.execution);
    if (!this.store.authorizedProducer(this.session, runtime, channel) && !recovery && !observation) return { kind: 'reject', reason: 'runtime_producer_unproven' };
    if (context.scope.execution) {
      const execution = this.store.execution(this.session, context.scope.execution.executionId);
      if (!execution || execution.ref.turnId !== context.scope.execution.turnId || execution.ref.dispatchAttempt !== context.scope.execution.dispatchAttempt
      ) return { kind: 'reject', reason: 'execution_scope_unproven' };
      // A queued turn must persist its dispatch before writing to the runner,
      // so it has no native runtime binding yet. These preparatory events do
      // not bind/start the attempt and still require the current producer.
      // The worker announces capture identity at the CLI write boundary,
      // before turn_execution_started binds the queued execution.
      const unboundCurrent = sameWorker(state.worker, channel) && sameRuntime(state.activeRuntime, runtime)
        && (['turn_execution_started', 'native_input_consumed', 'turn_terminal', 'final_output'].includes(type)
          || (execution.phase === 'queued' && ['managed_turn_origin', 'managed_turn_origin_revoked', 'codex_app_dispatch_transition', 'capture_identity'].includes(type)));
      if (!sameRuntime(execution.runtime, runtime)
        && !(!execution.runtime && (recovery || workerEvents.has(type) || unboundCurrent))) {
        return { kind: 'reject', reason: 'execution_scope_unproven' };
      }
    }
    const continued = !sameRuntime(state.activeRuntime, runtime) && sameWorker(state.worker, channel)
      && this.store.continuedExecution(this.session, runtime, channel, context.scope.execution);
    if (!recovery && !observation && sameWorker(state.worker, channel) && (sameRuntime(state.activeRuntime, runtime) || continued) && state.lifecycle !== 'closed' && state.lifecycle !== 'closing') {
      if (type === 'claude_exit' && this.store.hasPendingRuntimeReplacement(this.session, runtime)) return { kind: 'historical', context };
      return { kind: 'current', context };
    }
    if (immutableFacts.has(type)) return { kind: 'historical', context };
    return { kind: 'reject', reason: 'stale_runtime_scope' };
  }
}
