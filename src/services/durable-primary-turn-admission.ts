import type { Session } from '../types.js';

export type DurablePrimaryExistingTurnDisposition = 'committed' | 'retry' | 'ready';
export type DurablePrimaryInputCommit = NonNullable<Session['durablePrimaryInputCommits']>[number];
export type DurablePrimaryWorkerStartBlocker = 'pending-repo' | 'in-flight-claim';

export interface DurablePrimaryTurnRuntimeState {
  session: Pick<Session, 'durablePrimaryInputCommits'>;
  worker?: { killed?: boolean } | null;
  cliReady?: boolean;
  activeInteractiveTurn?: unknown;
  /** A real worker-null start conflict, never a durable recovery journal. */
  workerStartBlocker?: DurablePrimaryWorkerStartBlocker;
}

/** Pure admission decision used before any daemon-side business-turn effect. */
export function durablePrimaryExistingTurnDisposition(
  state: DurablePrimaryTurnRuntimeState,
  turnId: string,
): DurablePrimaryExistingTurnDisposition {
  if (state.session.durablePrimaryInputCommits?.some(item => item.turnId === turnId)) {
    return 'committed';
  }
  if (!state.worker || state.worker.killed) {
    // A dead/missing worker is recoverable through the existing cold-refork
    // path. Treating it as merely busy would leave the durable Inbox row in an
    // unbounded retry loop while this replica keeps renewing the Session lease.
    // Only an already-owned start boundary must remain retry-only.
    return state.workerStartBlocker ? 'retry' : 'ready';
  }
  if (!state.cliReady || state.activeInteractiveTurn) {
    return 'retry';
  }
  return 'ready';
}

export function appendDurablePrimaryInputCommit(
  previous: readonly DurablePrimaryInputCommit[],
  input: Omit<DurablePrimaryInputCommit, 'version'>,
  limit: number,
): { history: DurablePrimaryInputCommit[]; added: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('durable primary input commit limit must be positive');
  }
  if (previous.some(item => item.turnId === input.turnId)) {
    return { history: [...previous], added: false };
  }
  return {
    history: [...previous, { version: 1 as const, ...input }].slice(-limit),
    added: true,
  };
}
