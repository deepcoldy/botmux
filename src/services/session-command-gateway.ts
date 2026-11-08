import { sameRuntime, type RuntimeRef, type SessionCommandContext } from './session-contract.js';

const receipts = new Set(['runtime_contract_assigned', 'runtime_contract_reserved', 'runtime_binding_aborted_ack', 'runtime_binding_refused', 'execution_contract_assigned', 'final_output_settled', 'final_output_accepted',
  'codex_app_dispatch_persisted', 'codex_app_text_persisted', 'deployment_continuation_cancelled',
  'link_ref_register_result', 'link_ref_resolve_result', 'link_ref_restore_mode_result',
  'worker_ipc_probe', 'close_abort']);

/** All executor commands share this fence, independent of backend or input
 * channel. A recovery receipt may address an older effect without controlling
 * the current executor. */
export function admitSessionCommand(type: string, context: SessionCommandContext | undefined, current?: RuntimeRef,
  attemptId?: string): { allowed: boolean; reason?: string } {
  if (type === 'init' || receipts.has(type)) return { allowed: true };
  if (!context || context.version !== 2) return { allowed: false, reason: 'session_command_context_missing' };
  if (['restart', 'interrupt_turn', 'suspend', 'close', 'close_commit', 'raw_input', 'term_action', 'inject_command', 'session_ready', 'turn_idle', 'codex_cli_effort', 'codex_app_effort'].includes(type) && !context.runtime
    && !(type === 'close' && !current && context.operationId)) return { allowed: false, reason: 'runtime_target_missing' };
  if (context.runtime && !sameRuntime(context.runtime, current)) return { allowed: false, reason: 'stale_runtime_target' };
  if (type === 'restart' && (!attemptId || attemptId !== context.operationId)) return { allowed: false, reason: 'restart_operation_mismatch' };
  return { allowed: true };
}
