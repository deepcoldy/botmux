import { describe, expect, it } from 'vitest';

import {
  isRetryableAskHttpStatus,
  shouldReturnAskStartupNotReady,
} from '../src/core/ask-types.js';

/**
 * Executable decision seams for two ask-resume behaviours that used to be
 * asserted only against source text (codex round-3: source regex can't be the
 * contract). Both predicates are now PURE functions that the daemon `/api/asks`
 * handler (shouldReturnAskStartupNotReady) and cli.ts `postAsk`
 * (isRetryableAskHttpStatus) import and call at runtime — so these tests
 * exercise the SAME code the production path runs, not a copy.
 *
 * The runtime WIRING (that daemon.ts actually calls the guard before the 403,
 * and postAsk actually gates its retry on the classifier) is covered by
 * behavioural tests: test/cmd-hook.test.ts drives postAsk's retry loop end to
 * end against a stub daemon returning 503 vs 4xx.
 */

describe('postAsk retry classifier (codex P1-3 seam)', () => {
  it('502/503/504 are retryable (daemon up but transiently unready)', () => {
    expect(isRetryableAskHttpStatus(502)).toBe(true);
    expect(isRetryableAskHttpStatus(503)).toBe(true);
    expect(isRetryableAskHttpStatus(504)).toBe(true);
  });

  it('deterministic 4xx are NOT retryable (fail identically forever → passthrough)', () => {
    for (const s of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableAskHttpStatus(s)).toBe(false);
    }
  });

  it('other 5xx that are not the startup/ready band are NOT retryable', () => {
    // 500/501 are treated as deterministic here: the daemon answered decisively,
    // not "restarting". Only the 502/503/504 unready band is retried.
    expect(isRetryableAskHttpStatus(500)).toBe(false);
    expect(isRetryableAskHttpStatus(501)).toBe(false);
  });

  it('2xx is never classified retryable (success is not an error to retry)', () => {
    expect(isRetryableAskHttpStatus(200)).toBe(false);
  });
});

describe('daemon /api/asks startup readiness guard (codex P1-2 seam)', () => {
  it('unknown session + restore not finished → 503 startup_not_ready', () => {
    expect(shouldReturnAskStartupNotReady({
      hasSession: false, sessionsRestored: false,
    })).toBe(true);
  });

  it('once restore has finished, a still-unknown session does NOT get 503 (falls through to 403/proceed)', () => {
    expect(shouldReturnAskStartupNotReady({
      hasSession: false, sessionsRestored: true,
    })).toBe(false);
  });

  it('a session that already resolved never hits the startup guard', () => {
    expect(shouldReturnAskStartupNotReady({
      hasSession: true, sessionsRestored: false,
    })).toBe(false);
  });

  it('a reconnecting unsandbox hook (trusted-host transport) is NOT exempted during restore — it is exactly who must 503 (codex P1-2)', () => {
    // A normal unsandbox tmux hook reaches /api/asks via the HMAC fetchDaemonIpc
    // (trusted-host) path. The earlier gate exempted trusted callers, letting
    // this hook slip past 503 during the descriptor-published-but-not-restored
    // window and register a lost non-resumable ask. The predicate no longer
    // takes trustedHost at all: an unknown session mid-restore ALWAYS 503s,
    // regardless of how it authenticated.
    expect(shouldReturnAskStartupNotReady({
      hasSession: false, sessionsRestored: false,
    })).toBe(true);
  });
});
