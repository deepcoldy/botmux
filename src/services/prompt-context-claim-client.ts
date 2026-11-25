/**
 * Bounded retry for the small window between a worker's type-ahead IPC and the
 * daemon's queue registration. Only an explicit 404 is retried: a transport
 * error may mean the daemon already returned 200 and the response was lost, so
 * retrying it could consume a later candidate after the first successful pop.
 */
export interface PromptContextClaimRetryOptions {
  retryForMs?: number;
  retryIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_FOR_MS = 1_000;
const DEFAULT_RETRY_INTERVAL_MS = 25;

export interface PromptContextOriginClaim {
  capability: string;
  turnId?: string;
  dispatchAttempt?: number;
}

/** Build a fresh body for every attempt. In capability mode the managed origin
 * may rotate while a 404 retry is waiting, so the caller supplies a live reader
 * rather than a one-time snapshot. */
export function makePromptContextClaimBody(
  fingerprint: string,
  prefix: string | undefined,
  readOrigin?: () => PromptContextOriginClaim | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { fingerprint, ...(prefix ? { prefix } : {}) };
  const claim = readOrigin?.();
  if (claim) {
    body.originCapability = claim.capability;
    if (claim.turnId) body.originTurnId = claim.turnId;
    if (claim.dispatchAttempt !== undefined) body.originDispatchAttempt = claim.dispatchAttempt;
  }
  return body;
}

export function claimPromptContextEnvelopeWithLiveOrigin(input: {
  fingerprint: string;
  prefix?: string;
  readOrigin?: () => PromptContextOriginClaim | undefined;
  request: (body: Record<string, unknown>) => Promise<Response>;
}, options: PromptContextClaimRetryOptions = {}): Promise<string | undefined> {
  return claimPromptContextEnvelopeWithRetry(
    () => input.request(makePromptContextClaimBody(input.fingerprint, input.prefix, input.readOrigin)),
    options,
  );
}

export async function claimPromptContextEnvelopeWithRetry(
  request: () => Promise<Response>,
  options: PromptContextClaimRetryOptions = {},
): Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (async (ms: number) => {
    await new Promise<void>(resolve => setTimeout(resolve, ms));
  });
  const retryForMs = Math.max(0, options.retryForMs ?? DEFAULT_RETRY_FOR_MS);
  const retryIntervalMs = Math.max(1, options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS);
  const deadline = now() + retryForMs;

  for (;;) {
    const res = await request();
    if (res.status === 200) {
      const data = await res.json() as { envelope?: unknown };
      return typeof data?.envelope === 'string' ? data.envelope : undefined;
    }
    if (res.status !== 404) return undefined;
    // Drain the small JSON error body before reusing the loopback connection.
    await res.arrayBuffer();
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    await sleep(Math.min(retryIntervalMs, remaining));
  }
}
