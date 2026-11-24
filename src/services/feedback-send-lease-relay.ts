import { acquireFeedbackSendLeaseFor, releaseFeedbackSendLeaseFor } from './feedback-maintenance.js';

/**
 * `botmux send` maintenance lease taken by the daemon on behalf of a session
 * CLI that cannot take it in-process (see acquireFeedbackSendLeaseFor). Same
 * fallback shape as `turn-delivery` and the deferred-topic claim: the CLI
 * tries the local write first and only crosses to its daemon when the session
 * sandbox hides what that write needs.
 */
export const FEEDBACK_SEND_LEASE_ROUTE = 'feedback-send-lease';

const RELAYED_ERRORS = new Set([
  'feedback_storage_maintenance',
  'feedback_process_identity_unavailable',
  'feedback_send_lease_invalid',
  'feedback_send_lease_not_owned',
  'feedback_maintenance_state_invalid',
]);

export interface FeedbackSendLeaseRelayResponse {
  status: 200 | 400 | 409;
  body: { ok: true; lease?: string; releaseToken?: string; processId?: number } | { ok: false; error: string };
}

/** Daemon half. Acquisition uses the authenticated live session; release uses
 * the URL session plus the lease-scoped credential verified from disk. */
export function handleFeedbackSendLeaseRelay(
  dataDir: string,
  sessionId: string,
  body: Record<string, unknown>,
): FeedbackSendLeaseRelayResponse {
  const processId = body.processId;
  const invalid: FeedbackSendLeaseRelayResponse = { status: 400, body: { ok: false, error: 'feedback_send_lease_invalid' } };
  if (typeof processId !== 'number' || !Number.isSafeInteger(processId)) return invalid;
  try {
    if (body.action === 'acquire') {
      const acquired = acquireFeedbackSendLeaseFor(dataDir, { processId, sessionId });
      return { status: 200, body: { ok: true, ...acquired, processId } };
    }
    if (body.action === 'release' && typeof body.lease === 'string' && typeof body.releaseToken === 'string') {
      releaseFeedbackSendLeaseFor(dataDir, {
        lease: body.lease, processId, sessionId, releaseToken: body.releaseToken,
      });
      return { status: 200, body: { ok: true } };
    }
    return invalid;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'feedback_send_lease_invalid') return invalid;
    return { status: 409, body: { ok: false, error: RELAYED_ERRORS.has(message) ? message : 'feedback_send_lease_unavailable' } };
  }
}

const DEFAULT_RELAY_TIMEOUT_MS = 10_000;

export type FeedbackSendLeaseRelay = (
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<{ ok: boolean; status: number; body: unknown }>;

/**
 * Whether the in-process lease failed because the session sandbox hides its
 * prerequisites (own birth identity via the setuid `ps`, or the data dir).
 * Admission refusals, lock contention and corrupt state are real answers and
 * are never retried through the daemon.
 */
export function sendLeaseNeedsDaemon(error: unknown): boolean {
  if (error instanceof Error && error.message === 'feedback_process_identity_unavailable') return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
}

function relayError(response: { status: number; body: unknown }): string {
  const error = (response.body as { error?: unknown } | undefined)?.error;
  return typeof error === 'string' && error ? error : `feedback_send_lease_relay_http_${response.status}`;
}

/** CLI half: local lease first, daemon relay when the sandbox forbids it. */
export async function acquireFeedbackSendLeaseWithRelay(input: {
  acquireLocal: () => () => void;
  relay?: FeedbackSendLeaseRelay;
  processId?: number;
  timeoutMs?: number;
  warn?: (message: string) => void;
}): Promise<() => Promise<void>> {
  let releaseLocal: () => void;
  try {
    releaseLocal = input.acquireLocal();
  } catch (error) {
    if (!input.relay || !sendLeaseNeedsDaemon(error)) throw error;
    const relay = input.relay;
    const processId = input.processId ?? process.pid;
    const timeoutMs = input.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS;
    const request = async (body: Record<string, unknown>) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('feedback_send_lease_relay_timeout');
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      try {
        // The race is required even though the real transport honors AbortSignal:
        // a stalled request must never strand a delivered send or its live lease.
        return await Promise.race([relay(body, controller.signal), expired]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const acquired = await request({ action: 'acquire', processId });
    const lease = (acquired.body as { lease?: unknown } | undefined)?.lease;
    const releaseToken = (acquired.body as { releaseToken?: unknown } | undefined)?.releaseToken;
    if (!acquired.ok || typeof lease !== 'string' || typeof releaseToken !== 'string') throw new Error(relayError(acquired));
    // The daemon names the host pid it recorded (it differs inside a PID namespace).
    const leasePid = (acquired.body as { processId?: unknown }).processId;
    const leaseProcessId = typeof leasePid === 'number' ? leasePid : processId;
    const warn = input.warn ?? ((message: string) => console.error(message));
    return async () => {
      // The message is already delivered: a lost release leaves a lease that
      // turns into an acknowledgeable unknown outcome after this process exits,
      // never a failed send.
      try {
        const released = await request({ action: 'release', processId: leaseProcessId, lease, releaseToken });
        if (!released.ok) warn(`botmux send: feedback send lease release failed: ${relayError(released)}`);
      } catch (error) {
        warn(`botmux send: feedback send lease release failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }
  return async () => releaseLocal();
}
