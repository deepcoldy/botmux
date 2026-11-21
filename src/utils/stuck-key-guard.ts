/**
 * Stuck-warning key-injection guard.
 *
 * Extracted from worker.ts's `tui_keys` message handler so the fail-closed
 * boundary (lifetime pre-check, fresh capture, backend/lifetime re-check,
 * page-type re-match, write success/failure → delivered/expired) can be unit
 * tested in isolation. The production handler delegates to this function.
 *
 * Fail-closed contract:
 *   - expected lifetime missing / unequal → no keys written, send expired
 *   - fresh capture returns null or throws  → no keys written, send expired
 *   - backend/lifetime changed after capture, OR page type no longer matches
 *     → no keys written, send expired
 *   - key sequence not allowed for the page (when `allowKeys` is given)
 *     → no keys written, send expired
 *   - write success → send delivered; write returns false or throws → send failed
 *   - with `afterWrite`: after a successful write, wait a short settle, take a
 *     fresh capture on the SAME backend/lifetime, re-classify it and report
 *     what the screen shows now together with `delivered`
 *
 * backend/lifetime are read via getters (not value snapshots) so the guard can
 * re-check LIVE state after `await capture()` — a backend replacement or CLI
 * restart that happens mid-capture must still be detected.
 */
import type { SessionBackend } from '../adapters/backend/types.js';

export interface StuckKeyGuardMessage {
  stuckNonce: number;
  stuckPageType: string;
  stuckCliLifetime?: number;
  keys: string[];
  isFinal: boolean;
}

export interface StuckKeyGuardResult {
  /** What was sent back to the daemon, if anything. */
  sent: 'delivered' | 'expired' | 'failed' | 'none';
  /** Whether keys were actually written to the backend. */
  wroteKeys: boolean;
  /** Post-key observation (only when `afterWrite` is configured and keys were written). */
  after?: StuckKeyAfterObservation;
  /** Expired because the page changed: the fresh capture (same backend and
   *  CLI lifetime) that showed a different page — or none. The caller can
   *  re-evaluate the hold / raise the card for what is on screen now. */
  expiredScreen?: string;
}

/** What the screen shows shortly after a stuck-card key landed. */
export interface StuckKeyAfterObservation {
  /** False when no capture could be taken, or the backend / CLI lifetime
   *  changed while waiting (the screen then says nothing about this key). */
  observed: boolean;
  /** Raw fresh capture (worker-internal; not forwarded to the daemon). */
  screen?: string;
  /** Known blocking page on the fresh capture; undefined = none recognised. */
  pageType?: string;
  /** Bounded plain-text bottom of the fresh capture. */
  screenTail?: string;
}

/** Extra facts reported with `delivered` when `afterWrite` is configured. */
export interface StuckKeyDeliveredDetails {
  key: string | undefined;
  afterObserved: boolean;
  afterPageType?: string;
  afterScreenTail?: string;
}

/**
 * Decide whether to re-arm the stuck detector after a tui_keys click.
 *
 * The detector re-arms ONLY when the card-handler explicitly flagged this as a
 * stuck-warning Enter action (advances to the next review layer) AND keys were
 * actually written. An expired click (CLI recovered, page changed — wroteKeys
 * is false) must NOT re-arm: the detector should stay disarmed until the next
 * real stall, otherwise a recovered CLI could immediately re-trigger a warning.
 */
export function shouldRearmStuckDetector(
  rearmStuckDetector: boolean,
  wroteKeys: boolean,
): boolean {
  return rearmStuckDetector && wroteKeys;
}

export interface StuckKeyGuardDeps {
  /** Live read of the current backend (may change between calls / awaits). */
  getBackend: () => SessionBackend | null;
  /** Live read of the current CLI lifetime nonce (incremented on every backend replacement). */
  getCurrentLifetime: () => number;
  renderCols: number;
  renderRows: number;
  turnId: string | undefined;
  dispatchAttempt: number | undefined;
  /** Fresh PTY capture. Returns null on no-screenshot; may throw. */
  capture: (
    backend: SessionBackend,
    cols: number,
    rows: number,
    opts: { filter: boolean },
  ) => Promise<{ content: string | null } | null>;
  /** Classifier: returns the page type label or undefined if no match. */
  match: (snap: string) => string | undefined;
  /** Writes keys to the backend. Returns true on success, false on failure. */
  writeKeys: (keys: string[], isFinal: boolean) => Promise<boolean>;
  /** Sends a message back to the daemon. */
  sendExpired: (nonce: number, turnId: string | undefined, dispatchAttempt: number | undefined) => void;
  sendDelivered: (
    nonce: number,
    turnId: string | undefined,
    dispatchAttempt: number | undefined,
    details?: StuckKeyDeliveredDetails,
  ) => void;
  sendFailed: (nonce: number, turnId: string | undefined, dispatchAttempt: number | undefined) => void;
  log: (msg: string) => void;
  /** Defence in depth: the exact key sequence the card may write on the
   *  re-matched page (core/stuck-page-catalog isAllowedStuckKeySequence).
   *  Omitted = no key check (legacy callers). */
  allowKeys?: (pageType: string, keys: readonly string[]) => boolean;
  /** Observe the page after a successful write and report it with
   *  `delivered`. Omitted = deliver immediately with no details (legacy). */
  afterWrite?: {
    settleMs: number;
    sleep: (ms: number) => Promise<void>;
    screenTail: (screen: string) => string;
    /** Runs after `delivered` was sent (e.g. re-evaluate the input hold). */
    onObserved?: (observation: StuckKeyAfterObservation) => void;
  };
}

/**
 * Process a stuck-warning card's tui_keys click with full fail-closed guards.
 *
 * Returns a result describing what happened (for testing); production callers
 * use `result.wroteKeys` to decide whether to re-arm the stuck detector.
 */
export async function processStuckWarningTuiKeys(
  msg: StuckKeyGuardMessage,
  deps: StuckKeyGuardDeps,
): Promise<StuckKeyGuardResult> {
  const { stuckNonce, stuckPageType, stuckCliLifetime, keys, isFinal } = msg;
  const {
    getBackend,
    getCurrentLifetime,
    renderCols,
    renderRows,
    turnId,
    dispatchAttempt,
    capture,
    match,
    writeKeys,
    sendExpired,
    sendDelivered,
    sendFailed,
    log,
    allowKeys,
    afterWrite,
  } = deps;

  // P1-2: validate the CLI lifetime the card was issued for BEFORE doing
  // anything else. If the CLI restarted between card post and click,
  // the live lifetime has changed and the card's expected lifetime won't match —
  // fail-closed, do not inject keys into the new CLI. A missing expected
  // lifetime is also rejected (stuck cards must always carry it).
  const currentLifetime = getCurrentLifetime();
  if (stuckCliLifetime === undefined || stuckCliLifetime !== currentLifetime) {
    log(`TUI keys from stale stuck-warning card (nonce=${stuckNonce}, expectedLifetime=${stuckCliLifetime ?? 'none'}, currentLifetime=${currentLifetime}) — CLI replaced since card issued, dropping`);
    sendExpired(stuckNonce, turnId, dispatchAttempt);
    return { sent: 'expired', wroteKeys: false };
  }

  // Freeze the backend identity + CLI lifetime BEFORE capture. If the CLI
  // restarts (new backend object / new cliLifetimeNonce) while we await the
  // capture, the frozen values won't match the live ones and we drop the keys.
  const frozenBackend = getBackend();
  const frozenLifetime = getCurrentLifetime();
  let currentSnap: string | null = null;
  if (frozenBackend) {
    try {
      const fresh = await capture(frozenBackend, renderCols, renderRows, { filter: false });
      currentSnap = fresh?.content ?? null;
    } catch {
      currentSnap = null;
    }
  }

  // Fail-closed: no fresh snapshot OR backend/lifetime changed during capture → expired.
  // Re-read LIVE state via getters — the values may have changed while we awaited capture.
  const liveBackend = getBackend();
  const liveLifetime = getCurrentLifetime();
  if (!currentSnap || frozenBackend !== liveBackend || frozenLifetime !== liveLifetime) {
    log(`TUI keys from stale stuck-warning card (nonce=${stuckNonce}, expected=${stuckPageType}) — fresh capture failed or backend replaced, dropping`);
    sendExpired(stuckNonce, turnId, dispatchAttempt);
    return { sent: 'expired', wroteKeys: false };
  }

  const currentMatch = match(currentSnap);
  if (currentMatch !== stuckPageType) {
    log(`TUI keys from stale stuck-warning card (nonce=${stuckNonce}, expected=${stuckPageType}, current=${currentMatch ?? 'none'}) — dropped, notifying daemon`);
    sendExpired(stuckNonce, turnId, dispatchAttempt);
    return { sent: 'expired', wroteKeys: false, expiredScreen: currentSnap };
  }

  if (allowKeys && !allowKeys(stuckPageType, keys)) {
    log(`TUI keys from stuck-warning card (nonce=${stuckNonce}, page=${stuckPageType}) rejected: key sequence ${JSON.stringify(keys)} is not allowed on this page — dropped`);
    sendExpired(stuckNonce, turnId, dispatchAttempt);
    return { sent: 'expired', wroteKeys: false };
  }

  let writeOk = false;
  try {
    writeOk = await writeKeys(keys, isFinal);
  } catch {
    writeOk = false;
  }
  if (writeOk) {
    if (!afterWrite) {
      sendDelivered(stuckNonce, turnId, dispatchAttempt);
      return { sent: 'delivered', wroteKeys: true };
    }
    const after = await observeAfterWrite(frozenBackend, frozenLifetime, deps, afterWrite);
    sendDelivered(stuckNonce, turnId, dispatchAttempt, {
      key: keys[0],
      afterObserved: after.observed,
      ...(after.observed && after.pageType ? { afterPageType: after.pageType } : {}),
      ...(after.observed && after.screenTail ? { afterScreenTail: after.screenTail } : {}),
    });
    try {
      afterWrite.onObserved?.(after);
    } catch (err: any) {
      log(`Stuck-card post-key hook failed: ${err?.message ?? err}`);
    }
    return { sent: 'delivered', wroteKeys: true, after };
  }
  sendFailed(stuckNonce, turnId, dispatchAttempt);
  return { sent: 'failed', wroteKeys: false };
}

/** Settle, then capture on the backend the key was written to. Any capture
 *  failure, or a backend / lifetime change during the settle or the capture,
 *  yields `observed: false` — never a screen from a different CLI. */
async function observeAfterWrite(
  backend: SessionBackend | null,
  lifetime: number,
  deps: StuckKeyGuardDeps,
  afterWrite: NonNullable<StuckKeyGuardDeps['afterWrite']>,
): Promise<StuckKeyAfterObservation> {
  const stillSame = (): boolean => deps.getBackend() === backend && deps.getCurrentLifetime() === lifetime;
  try {
    await afterWrite.sleep(afterWrite.settleMs);
    if (!backend || !stillSame()) return { observed: false };
    const fresh = await deps.capture(backend, deps.renderCols, deps.renderRows, { filter: false });
    const screen = fresh?.content ?? null;
    if (!screen || !stillSame()) return { observed: false };
    return {
      observed: true,
      screen,
      pageType: deps.match(screen),
      screenTail: afterWrite.screenTail(screen),
    };
  } catch {
    return { observed: false };
  }
}
