import type { CloseSessionResult } from './worker-pool.js';

export type BackgroundClose = (
  sessionId: string,
  context: string,
) => Promise<CloseSessionResult>;

export interface BackgroundCloseLogger {
  info(message: string): unknown;
  error(message: string): unknown;
}

const IDEMPOTENCY_FAIL_CLOSE_CONTEXT =
  'idempotency fail-close after exit-convergence write failure';

/**
 * Consume the close result for the idempotency convergence double-failure path.
 * The injected background close reports refusal/residual; this layer owns the
 * caller-specific promise that "fail-closed" is logged only after local close.
 */
export async function runIdempotencyFailClose(
  sessionId: string,
  close: BackgroundClose,
  logger: Pick<BackgroundCloseLogger, 'error'>,
): Promise<void> {
  try {
    const result = await close(sessionId, IDEMPOTENCY_FAIL_CLOSE_CONTEXT);
    if (!result.ok) return;
    logger.error(
      `[idempotency] fail-closed session ${sessionId.slice(0, 8)} `
      + 'after exit-convergence write failure',
    );
  } catch (err) {
    logger.error(
      `[idempotency] fail-close threw for session ${sessionId.slice(0, 8)}; `
      + `close state is UNPROVEN: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Consume a withdraw-driven background close. A refusal is a normal resolved
 * result, not an exception; return false so worker-pool never publishes success.
 * A residual is still a successful LOCAL close and is logged by the wrapper.
 */
export async function runWithdrawAutoClose(
  sessionId: string,
  close: BackgroundClose,
  logger: Pick<BackgroundCloseLogger, 'info' | 'error'>,
): Promise<boolean> {
  try {
    const result = await close(sessionId, 'withdraw auto-close');
    if (!result.ok) return false;
    logger.info(`[${sessionId.slice(0, 8)}] Session auto-closed (message withdrawn)`);
    return true;
  } catch (err) {
    logger.error(
      `[${sessionId.slice(0, 8)}] Withdraw auto-close threw; close state is UNPROVEN: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
