/**
 * Failed-turn bookkeeping for the `/retry` command.
 *
 * A turn that ends `failed` or `ambiguous` records its exact CLI input here
 * (persisted on the Session as `lastFailedTurn`) so the user can re-inject it
 * with `/retry` instead of copy-pasting. Recording is guarded by the session's
 * current reply target: a type-ahead successor already owns the prompt, so the
 * failed predecessor must not capture it.
 *
 * Pure functions only — persistence and IPC stay with the daemon/command-handler
 * callers, mirroring the ordinary-turn-recovery split.
 */
import type { CodexAppTurnInput, FailedTurnRecord } from '../types.js';

/** Cooldown between two `/retry` attempts on the same session. */
export const RETRY_COOLDOWN_MS = 10_000;

/** Whether a turn_terminal event should be recorded as the session's last
 *  failed turn. `completed`/`cancelled` never qualify. When the session's
 *  current reply target already points at a NEWER turn (type-ahead), the
 *  failed turn's prompt has been superseded and must not be captured. */
export function shouldRecordFailedTurn(
  terminal: { turnId: string; status: string },
  currentReplyTargetTurnId: string | undefined,
): boolean {
  if (terminal.status !== 'failed' && terminal.status !== 'ambiguous') return false;
  if (currentReplyTargetTurnId !== undefined && currentReplyTargetTurnId !== terminal.turnId) {
    return false;
  }
  return true;
}

/** Build the persisted record for a failed/interrupted turn. Returns undefined
 *  when there is no CLI input to re-inject (e.g. a turn that died before its
 *  prompt was wrapped). */
export function buildFailedTurnRecord(
  terminal: { turnId: string; status: 'failed' | 'ambiguous'; errorCode?: string },
  sources: { userPrompt?: string; cliInput?: string; codexAppInput?: CodexAppTurnInput },
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

/** Stamp one accepted `/retry` attempt onto the session's record. No-op when
 *  the session has no failed turn recorded. */
export function markRetryAttempt(
  session: { lastFailedTurn?: FailedTurnRecord },
  now: Date = new Date(),
): void {
  const record = session.lastFailedTurn;
  if (!record) return;
  record.retryCount += 1;
  record.lastRetryAt = now.toISOString();
}
