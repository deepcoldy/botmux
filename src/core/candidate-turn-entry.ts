import {
  CandidateTurnDurability,
  type CandidateTurnAcceptInput,
  type CandidateTurnDispatch,
  type CandidateTurnReceipt,
  type CandidateSubmitEvidence,
  type CandidateTerminalEvidence,
} from '../services/candidate-turn-durability.js';

export interface CandidateTurnEntryDeps {
  dataDir: string;
  receiverBootId: string;
  workerGeneration: number;
  dispatch(turn: CandidateTurnDispatch): void | Promise<void>;
  /** Dispatch has a durable claim but its delivery outcome is ambiguous. The
   * daemon uses this to fence the exact attempt before any replay. */
  onAmbiguousDispatch?(receipt: CandidateTurnReceipt, error: unknown): void | Promise<void>;
  onReceipt?(receipt: CandidateTurnReceipt): void | Promise<void>;
}

async function publish(
  receipt: CandidateTurnReceipt,
  deps: CandidateTurnEntryDeps,
): Promise<void> {
  await deps.onReceipt?.(receipt);
}

/** Production Candidate inbound boundary: fsync accepted before making the
 * existing worker/session dispatch callable. Only the stream head is claimed,
 * so busy follow-ups remain durable and ordered without another runtime queue. */
export async function acceptCandidateTurnFromDaemon(
  input: CandidateTurnAcceptInput,
  deps: CandidateTurnEntryDeps,
): Promise<{ receipt: CandidateTurnReceipt; dispatched: boolean }> {
  const turns = new CandidateTurnDurability({ dataDir: deps.dataDir });
  const accepted = await turns.accept(input);
  await publish(accepted.receipt, deps);
  const claim = await turns.claimHead(input.candidateDispatchId, {
    receiverBootId: deps.receiverBootId,
    workerGeneration: deps.workerGeneration,
  });
  if (claim.kind !== 'dispatch') return { receipt: accepted.receipt, dispatched: false };
  try {
    await deps.dispatch(claim.dispatch);
  } catch (error) {
    await deps.onAmbiguousDispatch?.(claim.receipt, error);
    throw error;
  }
  return { receipt: claim.receipt, dispatched: true };
}

export async function submitCandidateTurnFromWorker(input: {
  candidateDispatchId: string;
  turnId: string;
  dispatchAttempt: number;
  workerGeneration: number;
  evidence: CandidateSubmitEvidence;
}, deps: CandidateTurnEntryDeps): Promise<CandidateTurnReceipt> {
  const turns = new CandidateTurnDurability({ dataDir: deps.dataDir });
  const receipt = await turns.markSubmitted(input);
  await publish(receipt, deps);
  return receipt;
}

/** Terminal settlement releases exactly one ordered successor. The successor
 * uses the same BotMux Session and the existing sendWorkerInput/forkWorker
 * path supplied by daemon. */
export async function settleCandidateTurnFromWorker(input: {
  candidateDispatchId: string;
  turnId: string;
  dispatchAttempt: number;
  workerGeneration: number;
  status: 'completed' | 'failed';
  evidence: CandidateTerminalEvidence;
}, deps: CandidateTurnEntryDeps): Promise<CandidateTurnReceipt> {
  const turns = new CandidateTurnDurability({ dataDir: deps.dataDir });
  const receipt = await turns.markTerminal(input);
  await publish(receipt, deps);
  const next = await turns.claimHead(input.candidateDispatchId, {
    receiverBootId: deps.receiverBootId,
    workerGeneration: deps.workerGeneration,
  });
  if (next.kind === 'dispatch') {
    try {
      await deps.dispatch(next.dispatch);
    } catch (error) {
      await deps.onAmbiguousDispatch?.(next.receipt, error);
      throw error;
    }
  }
  return receipt;
}

/** A dispatched Candidate turn with no native Runtime identity sits in the
 * crash window between PTY submit and native transcript discovery. Its submit
 * outcome is ambiguous, so replay is unsafe. Persist a terminal failure for
 * the exact attempt instead of manufacturing another dispatch. */
export async function settleCandidateTurnWithUnknownRuntimeIdentity(
  receipt: CandidateTurnReceipt,
  deps: CandidateTurnEntryDeps,
): Promise<CandidateTurnReceipt> {
  if (receipt.status !== 'accepted'
    || receipt.dispatchAttempt < 1
    || receipt.nativeSessionId) {
    throw new Error('Candidate unknown-runtime recovery requires a dispatched accepted turn');
  }
  return settleCandidateTurnFromWorker({
    candidateDispatchId: receipt.candidateDispatchId,
    turnId: receipt.turnId,
    dispatchAttempt: receipt.dispatchAttempt,
    workerGeneration: receipt.workerGeneration,
    status: 'failed',
    evidence: {
      kind: 'runtime_terminal',
      nativeSessionId: `unresolved:${receipt.botmuxSessionId}`,
      transcriptRef: [
        'recovery',
        receipt.candidateDispatchId,
        receipt.turnId,
        `attempt-${receipt.dispatchAttempt}`,
        'native_session_unknown',
      ].join(':'),
    },
  }, deps);
}
