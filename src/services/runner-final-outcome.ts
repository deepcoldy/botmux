import { CODEX_CAPACITY_ERROR_CODE } from './codex-transcript.js';
import { isBridgeNothingToSendFinal } from './bridge-fallback-gate.js';

/** Interpret only the runner-specific structured error field, never prose. */
export function runnerFinalOutcome(cliId: string | undefined, errorCode: unknown): {
  status: 'completed' | 'failed' | 'cancelled';
  errorCode?: string;
} {
  if (cliId === 'codex-app' && errorCode === 'cancelled') return { status: 'cancelled', errorCode };
  if (cliId === 'codex-app' && errorCode !== undefined) {
    return { status: 'failed', errorCode: errorCode === CODEX_CAPACITY_ERROR_CODE
      ? CODEX_CAPACITY_ERROR_CODE : 'codex_app_turn_failed' };
  }
  if (!['minimax', 'antigravity'].includes(cliId ?? '') || errorCode === undefined) return { status: 'completed' };
  if (errorCode === 'cancelled') return { status: 'cancelled', errorCode };
  return {
    status: 'failed',
    // Unknown/malformed MiniMax error fields must not become success or leak
    // arbitrary provider text into a machine-readable failure code.
    errorCode: errorCode === 'turn_budget_exhausted' ? errorCode : 'execution_failed',
  };
}

/** The durable receipt and later worker terminal must agree. */
export function codexAppSettlementOutcome(message: {
  turnFailed?: boolean; turnFailureCode?: string; codexAppCancelled?: true;
}): ReturnType<typeof runnerFinalOutcome> {
  if (message.codexAppCancelled) return { status: 'cancelled', errorCode: 'cancelled' };
  if (!message.turnFailed) return { status: 'completed' };
  return runnerFinalOutcome('codex-app', message.turnFailureCode ?? 'codex_app_turn_failed');
}

/**
 * Positive silence evidence for an app-runner final (codex-app, mir, mira, dsh,
 * minimax) in a native IM gateway's core: the model ended the turn with only
 * the BOTMUX_NOTHING_TO_SEND sentinel.
 *
 * There the turn is an async HTTP turn the gateway polls, and nothing else
 * settles a silent runner final: its empty final_output is suppressed before
 * the async result is written, and a terminal without this flag never settles
 * one (worker-pool turn_terminal) — so the poll would read `running` for ever.
 * The transcript/structured bridges already stamp this flag for every process;
 * for app runners it is limited to that core, so every other process keeps its
 * terminal byte for byte. A failed or cancelled turn is never silence; a
 * superseded steer member never reaches here with content (the handler rejects
 * one that carries any), so it can never be a sentinel either.
 */
export function appRunnerSilenceDisposition(input: {
  finalContent: string;
  status: 'completed' | 'failed' | 'cancelled';
  nativeGatewayCore: boolean;
}): 'nothing_to_send' | undefined {
  return input.nativeGatewayCore
    && input.status === 'completed'
    && isBridgeNothingToSendFinal(input.finalContent)
    ? 'nothing_to_send'
    : undefined;
}
