import { CODEX_CAPACITY_ERROR_CODE } from './codex-transcript.js';

/** Interpret only the runner-specific structured error field, never prose. */
export function runnerFinalOutcome(cliId: string | undefined, errorCode: unknown): {
  status: 'completed' | 'failed' | 'cancelled';
  errorCode?: string;
} {
  if (cliId === 'codex-app' && errorCode !== undefined) {
    return { status: 'failed', errorCode: errorCode === CODEX_CAPACITY_ERROR_CODE
      ? CODEX_CAPACITY_ERROR_CODE : 'codex_app_turn_failed' };
  }
  if (cliId !== 'minimax' || errorCode === undefined) return { status: 'completed' };
  if (errorCode === 'cancelled') return { status: 'cancelled', errorCode };
  return {
    status: 'failed',
    // Unknown/malformed MiniMax error fields must not become success or leak
    // arbitrary provider text into a machine-readable failure code.
    errorCode: errorCode === 'turn_budget_exhausted' ? errorCode : 'execution_failed',
  };
}

/** The durable receipt and later worker terminal must agree on failure. */
export function codexAppSettlementOutcome(message: { turnFailed?: boolean; turnFailureCode?: string }): {
  status: 'completed' | 'failed'; errorCode?: string;
} {
  if (!message.turnFailed) return { status: 'completed' };
  const outcome = runnerFinalOutcome('codex-app', message.turnFailureCode ?? 'codex_app_turn_failed');
  return { status: 'failed', errorCode: outcome.errorCode };
}
