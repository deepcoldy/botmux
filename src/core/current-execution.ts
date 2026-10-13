import { CURRENT_EXECUTION_SCHEMA, isCurrentExecutionDocument, type CurrentExecutionDocument } from '../cli/current-execution.js';
import { attestCurrentExecutionLoopbackPeer, type CurrentTurnPeerAttestationInput } from './current-actor-attestation.js';

/** Synchronous, read-only snapshot. Caller/permission, business success and
 * durable input acceptance are deliberately not implied by an execution proof. */
export function resolveDaemonCurrentExecution(input: CurrentTurnPeerAttestationInput): CurrentExecutionDocument | null {
  const proof = attestCurrentExecutionLoopbackPeer(input);
  if (!proof || proof.ds.session.sessionId !== input.sessionId || proof.ds.worker?.connected === false) return null;
  const document = {
    schema: CURRENT_EXECUTION_SCHEMA, status: 'verified' as const,
    larkAppId: proof.ds.larkAppId, sessionId: input.sessionId, chatId: proof.ds.chatId,
    turnId: proof.turnId, workerGeneration: proof.generation,
    ...(proof.dispatchAttempt !== undefined ? { dispatchAttempt: proof.dispatchAttempt } : {}),
  };
  return isCurrentExecutionDocument(document) ? document : null;
}
