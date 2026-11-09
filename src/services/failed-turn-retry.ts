/**
 * Failed-turn bookkeeping for the `/retry` command.
 *
 * A turn that ends `failed` or `ambiguous` records its exact CLI input here
 * (persisted on the Session as `lastFailedTurn`) so the user can re-inject it
 * with `/retry` instead of copy-pasting. The daemon verifies the input's exact
 * dispatch turn before invoking this builder; reply routing is not input ownership.
 *
 * Pure functions only — persistence and IPC stay with the daemon/command-handler
 * callers, mirroring the ordinary-turn-recovery split.
 */
import type { CodexAppTurnInput, FailedTurnRecord, TrustedCaller } from '../types.js';

/** Cooldown between two `/retry` attempts on the same session. */
export const RETRY_COOLDOWN_MS = 10_000;

/** Build the persisted record for a failed/interrupted turn. Returns undefined
 *  when there is no CLI input to re-inject (e.g. a turn that died before its
 *  prompt was wrapped). */
export function buildFailedTurnRecord(
  terminal: { turnId: string; status: 'failed' | 'ambiguous'; errorCode?: string },
  sources: { userPrompt?: string; cliInput?: string; codexAppInput?: CodexAppTurnInput;
    trustedCaller?: TrustedCaller; originalTurnId?: string; silent?: boolean },
  now: Date = new Date(),
): FailedTurnRecord | undefined {
  if (!sources.cliInput) return undefined;
  return {
    turnId: terminal.turnId,
    userPrompt: sources.userPrompt ?? sources.cliInput,
    cliInput: sources.cliInput,
    ...(sources.codexAppInput ? { codexAppInput: sources.codexAppInput } : {}),
    failedAt: now.toISOString(),
    ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
    status: terminal.status,
    retryCount: 0,
    ...(sources.silent ? { silent: true } : {}),
    ...(sources.trustedCaller ? { trustedCaller: { ...sources.trustedCaller } } : {}),
    ...(sources.originalTurnId ? { originalTurnId: sources.originalTurnId } : {}),
  };
}

/** Remaining cooldown in ms before `/retry` may fire again (0 = ready). */
export function retryCooldownRemaining(
  record: FailedTurnRecord,
  now: Date = new Date(),
  cooldownMs: number = RETRY_COOLDOWN_MS,
): number {
  if (!record.lastRetryAt) return 0;
  const last = new Date(record.lastRetryAt).getTime();
  if (Number.isNaN(last)) return 0;
  return Math.max(0, cooldownMs - (now.getTime() - last));
}

/** What one accepted attempt changed, so an attempt that provably never ran
 *  can give its cooldown back (see refundRetryAttempt). */
export interface RetryAttemptReceipt {
  turnId: string;
  previousRetryCount: number;
  previousRetryAt?: string;
  stampedAt: string;
}

/** Stamp one accepted `/retry` attempt onto the session's record. No-op when
 *  the session has no failed turn recorded. */
export function markRetryAttempt(
  session: { lastFailedTurn?: FailedTurnRecord },
  now: Date = new Date(),
): RetryAttemptReceipt | undefined {
  const record = session.lastFailedTurn;
  if (!record) return undefined;
  const receipt: RetryAttemptReceipt = {
    turnId: record.turnId,
    previousRetryCount: record.retryCount,
    ...(record.lastRetryAt ? { previousRetryAt: record.lastRetryAt } : {}),
    stampedAt: now.toISOString(),
  };
  record.retryCount += 1;
  record.lastRetryAt = receipt.stampedAt;
  return receipt;
}

/** Undo the attempt behind `receipt`. Only while the record is still that
 *  failed turn with that stamp on top: a newer failure or a later attempt
 *  keeps its own cooldown. Returns whether anything changed. */
export function refundRetryAttempt(
  session: { lastFailedTurn?: FailedTurnRecord },
  receipt: RetryAttemptReceipt,
): boolean {
  const record = session.lastFailedTurn;
  if (
    !record
    || record.turnId !== receipt.turnId
    || record.retryCount !== receipt.previousRetryCount + 1
    || record.lastRetryAt !== receipt.stampedAt
  ) return false;
  record.retryCount = receipt.previousRetryCount;
  if (receipt.previousRetryAt) record.lastRetryAt = receipt.previousRetryAt;
  else delete record.lastRetryAt;
  return true;
}
