import { groupContextEpoch } from './group-context-prompt.js';
import {
  readGroupContextDeliveryBinding, promoteGroupContextDeliveryEpoch, confirmGroupContextDelivery,
  confirmGroupContextNativeInput, type GroupContextDeliveryBinding, type GroupContextNativeInputProof,
} from './group-context-delivery-store.js';

interface NativeTurnIdentity {
  appId: string; chatId: string; turnId: string; sessionId: string;
  cliId?: string; nativeSessionId?: string; workerGeneration: number;
}

/** Resolve the frozen binding for this exact consumer. A cold first turn is
 * promoted from its provisional `fresh:` epoch only with the real native id and
 * the same input worker generation; an established native conversation is
 * never rebound, and a replacement generation does not inherit the receipt. */
function resolveOwnedBinding(input: NativeTurnIdentity, dataDir?: string): GroupContextDeliveryBinding | undefined {
  if (!Number.isSafeInteger(input.workerGeneration) || input.workerGeneration < 1) return undefined;
  const epoch = groupContextEpoch(input.sessionId, input.nativeSessionId, input.cliId, input.turnId);
  let binding = readGroupContextDeliveryBinding(input.appId, input.chatId, input.turnId, dataDir, epoch)
    ?? readGroupContextDeliveryBinding(input.appId, input.chatId, input.turnId, dataDir,
      groupContextEpoch(input.sessionId, undefined, input.cliId, input.turnId));
  if (!binding || binding.sessionId !== input.sessionId) return undefined;
  if (binding.epoch !== epoch) {
    if (!input.nativeSessionId) return undefined;
    binding = promoteGroupContextDeliveryEpoch(binding, input.nativeSessionId, input.workerGeneration, dataDir);
    if (!binding || binding.epoch !== epoch) return undefined;
  } else if (binding.workerGeneration !== undefined && binding.workerGeneration !== input.workerGeneration) {
    return undefined;
  }
  return binding;
}

function isProvisionalEpoch(epoch: string): boolean {
  try {
    const parts: unknown = JSON.parse(epoch);
    return !Array.isArray(parts) || typeof parts[2] !== 'string' || parts[2].startsWith('fresh:');
  } catch { return true; }
}

/** Caller must have a completed terminal from the currently owned worker. */
export function confirmNativeGroupContextTurn(input: NativeTurnIdentity, dataDir?: string): boolean {
  const binding = resolveOwnedBinding(input, dataDir);
  return !!binding && confirmGroupContextDelivery(binding, dataDir);
}

/** Caller must hold native evidence that this exact dispatched input entered
 * the owned native conversation (exact history/transcript record or an RPC
 * turn acknowledgment), from the currently owned worker generation. Covers the
 * frozen sources immediately so steering, worker replacement or a restart
 * before the terminal cannot repeat them. */
export function confirmNativeGroupContextInput(
  input: NativeTurnIdentity, proof: GroupContextNativeInputProof, dataDir?: string,
): boolean {
  const binding = resolveOwnedBinding(input, dataDir);
  if (!binding) return false;
  // The receipt must name the dispatch generation. A binding whose generation
  // was never reserved cannot prove which worker's input reached the model.
  if (binding.workerGeneration === undefined) return false;
  // A still-provisional native identity cannot be consumed: coverage would be
  // recorded under an epoch no later turn reads, and the binding could never be
  // promoted to the real conversation afterwards. The terminal fallback keeps
  // its existing semantics for that case.
  if (!input.nativeSessionId || isProvisionalEpoch(binding.epoch)) return false;
  return confirmGroupContextNativeInput(binding, proof, dataDir);
}
