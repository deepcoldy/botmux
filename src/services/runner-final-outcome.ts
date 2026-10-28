/** Only MiniMax currently defines this field on its final OSC frame. Do not
 * reinterpret unrelated runners' optional payloads as this protocol. */
export function runnerFinalOutcome(cliId: string | undefined, errorCode: unknown): {
  status: 'completed' | 'failed' | 'cancelled';
  errorCode?: 'turn_budget_exhausted' | 'execution_failed' | 'cancelled';
} {
  if (cliId !== 'minimax' || errorCode === undefined) return { status: 'completed' };
  if (errorCode === 'cancelled') return { status: 'cancelled', errorCode };
  return {
    status: 'failed',
    // Unknown/malformed MiniMax error fields must not become success or leak
    // arbitrary provider text into a machine-readable failure code.
    errorCode: errorCode === 'turn_budget_exhausted' ? errorCode : 'execution_failed',
  };
}
