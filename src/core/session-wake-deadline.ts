export const SESSION_WAKE_TIMEOUT_MS = 15_000;
export const SESSION_WAKE_DEADLINE_HEADER = 'x-botmux-wake-deadline-ms';

/** Clamp an optional trusted-host deadline to the daemon's own maximum wait. */
export function sessionWakeAcquireTimeoutMs(
  header: string | string[] | undefined,
  nowMs = Date.now(),
): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const requested = typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
  const localDeadlineMs = nowMs + SESSION_WAKE_TIMEOUT_MS;
  const deadlineMs = Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, localDeadlineMs)
    : localDeadlineMs;
  return Math.max(0, deadlineMs - nowMs);
}
