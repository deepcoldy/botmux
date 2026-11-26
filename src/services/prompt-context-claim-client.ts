/**
 * Bounded retry for the small window between a worker's type-ahead IPC and the
 * daemon's queue registration (or rotating sandbox capability IPC propagation).
 * Only an explicit 404 — or, when `retryOriginUnproven` is enabled in live
 * capability mode, a side-effect-free `403 { error: "origin_unproven" }` — is
 * retried: a transport error may mean the daemon already returned 200 and the
 * response was lost, so retrying it could consume a later candidate after the
 * first successful pop.
 */
export interface PromptContextClaimRetryOptions {
  retryForMs?: number;
  retryIntervalMs?: number;
  retryOriginUnproven?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_FOR_MS = 1_000;
const DEFAULT_RETRY_INTERVAL_MS = 25;

export interface PromptContextOriginClaim {
  capability: string;
  turnId?: string;
  dispatchAttempt?: number;
  ipcPort?: number;
}

/** Build a fresh body for every attempt. In capability mode the managed origin
 * may rotate while a retry is waiting, so the caller supplies a live reader
 * rather than a one-time snapshot. */
export function makePromptContextClaimBody(
  fingerprint: string,
  prefix: string | undefined,
  readOrigin?: () => PromptContextOriginClaim | undefined,
): Record<string, unknown> {
  return buildPromptContextClaimBody(fingerprint, prefix, readOrigin?.());
}

function buildPromptContextClaimBody(
  fingerprint: string,
  prefix: string | undefined,
  claim: PromptContextOriginClaim | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { fingerprint, ...(prefix ? { prefix } : {}) };
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
  request: (body: Record<string, unknown>, claim?: PromptContextOriginClaim) => Promise<Response>;
}, options: PromptContextClaimRetryOptions = {}): Promise<string | undefined> {
  return claimPromptContextEnvelopeWithRetry(
    () => {
      const claim = input.readOrigin?.();
      return input.request(buildPromptContextClaimBody(input.fingerprint, input.prefix, claim), claim);
    },
    {
      ...options,
      retryOriginUnproven: options.retryOriginUnproven ?? Boolean(input.readOrigin),
    },
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
  const retryOriginUnproven = options.retryOriginUnproven === true;
  const deadline = now() + retryForMs;

  for (;;) {
    const res = await request();
    if (res.status === 200) {
      const data = await res.json() as { envelope?: unknown };
      return typeof data?.envelope === 'string' ? data.envelope : undefined;
    }
    if (res.status === 403 && retryOriginUnproven) {
      let errorCode: unknown;
      try {
        const parsed = JSON.parse(await res.text()) as { error?: unknown };
        errorCode = parsed?.error;
      } catch {
        errorCode = undefined;
      }
      if (errorCode !== 'origin_unproven') return undefined;
    } else if (res.status === 404) {
      // Drain the small JSON error body before reusing the loopback connection.
      await res.arrayBuffer();
    } else {
      return undefined;
    }
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    await sleep(Math.min(retryIntervalMs, remaining));
  }
}
