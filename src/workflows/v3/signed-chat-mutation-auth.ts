/**
 * Authorization for chat-bound mutations arriving on the signed-envelope IPC.
 *
 * The envelope HMAC authenticates the transport, not the caller's current turn.
 * Always require the per-turn session capability too (trustedHost=false), then
 * let the shared relay authorizer derive identity from the daemon's live
 * session and the host schedule-authority store. A standalone/unbound run does
 * not use this helper.
 */
import type { WorkflowDaemonMutation } from './daemon-ipc-client.js';
import {
  authorizeV3SessionRunEditRequest,
  authorizeV3SessionRunMutationRequest,
  type V3SessionRelayAuthInput,
  type V3SessionRelayDecision,
  type V3SessionRunEditDecision,
} from './session-relay.js';

export function authorizeSignedChatMutation(
  input: Omit<V3SessionRelayAuthInput, 'trustedHost' | 'mutation'> & {
    mutation: WorkflowDaemonMutation;
  },
): V3SessionRelayDecision | V3SessionRunEditDecision {
  const relayInput = { ...input, trustedHost: false };
  if (input.mutation === 'edit') {
    return authorizeV3SessionRunEditRequest({ ...relayInput, mutation: 'edit' });
  }
  return authorizeV3SessionRunMutationRequest(relayInput);
}
