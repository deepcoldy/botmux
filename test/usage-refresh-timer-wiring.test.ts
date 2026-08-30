import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for the periodic usage-refresh timer wiring (PR #637 follow-up).
 *
 * Behavioral unit tests (recall-frozen-cards.test.ts) drive the pure predicate
 * and the interval tick, but they cannot exercise the full screen_update / ready
 * IPC handlers. These invariants are exactly the "a call site forgot / used the
 * wrong flag" failures codex flagged during review, so a source invariant is the
 * right guard — reverting any fix makes the matched substring disappear and the
 * assertion fails. Each check is anchored to a unique, human-meaningful line.
 */
const WORKER_POOL = 'src/core/worker-pool.ts';

function read(rel: string): string {
  return readFileSync(resolve(rel), 'utf8');
}

/** Return the body of `functionName` up to its terminating `\n}` at column 0. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end === -1 ? undefined : end + 2);
}

/** Slice from a `case '<name>': {` to the next top-level `case '` (or a
 *  bounded tail). Top-level cases are indented 6 spaces in this switch, so we
 *  anchor on `\n      case '` — internal blocks never match that, unlike a bare
 *  `\n      }\n` which truncates at the first nested block close. */
function switchCaseBody(source: string, caseName: string): string {
  const start = source.indexOf(`case '${caseName}': {`);
  if (start === -1) throw new Error(`case not found: ${caseName}`);
  const next = source.indexOf("\n      case '", start + 10);
  return source.slice(start, next === -1 ? Math.min(start + 14000, source.length) : next);
}

describe('usage-refresh timer wiring (source lock)', () => {
  const src = read(WORKER_POOL);

  it('the interval tick reads usage with fresh:true (breaks the 15s cost-reader throttle)', () => {
    // The whole point of the 12s tick is to beat USAGE_REPARSE_MIN_INTERVAL_MS
    // (15s). Without fresh:true the reader serves the throttled cached value and
    // the on-card total/turn usage would not climb until t=24s+.
    const body = functionBody(src, 'export function refreshStreamingCardUsage(ds: DaemonSession): void {');
    expect(body).toContain('getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId, { fresh: true })');
    // Cross-backend: use readableTerminalUrlFor (→ '' when no Web Terminal), NOT
    // raw buildTerminalUrl — otherwise a port=0 backend (ZMX), which now enters
    // the tick after the workerHasInitialized gate, renders a fake terminal URL.
    expect(body).toContain('readableTerminalUrlFor(ds)');
    expect(body).not.toContain('buildTerminalUrl(ds)');
  });

  it('the arm predicate rejects the new-turn handoff window (streamCardPending)', () => {
    // beginNewTurn keeps the OLD streamCardId while flipping streamCardPending
    // and the turn title — a tick here would PATCH the previous card with the
    // new turn's content.
    const body = functionBody(src, 'export function usageRefreshShouldRun(ds: DaemonSession): boolean {');
    expect(body).toContain('if (ds.streamCardPending) return false;');
    // Capability + ZMX-safe + display gates all present in the single predicate.
    expect(body).toContain('cliSupportsNativeUsage(');
    expect(body).toContain('workerHasInitialized(ds)');
    expect(body).toContain("resolveUsageDisplay(ds.larkAppId) !== 'streaming'");
    // Must NOT gate on the Web Terminal port (ZMX reports ready with port=0).
    expect(body).not.toContain('!ds.workerPort');
  });

  it('the screen_update case arms at BOTH authorized points (new-card POST .then + same-turn PATCH)', () => {
    // This is the ORIGINAL main regression: without an arm in the new-turn POST
    // .then and in the same-turn PATCH branch, a turn never refreshes. Lock both.
    const body = switchCaseBody(src, 'screen_update');
    const arms = body.split('syncUsageRefreshTimer(ds)').length - 1;
    expect(arms).toBe(2);
    // The POST arm must be anchored AFTER the real card id is committed (not the
    // POSTING sentinel), i.e. it follows `ds.streamCardId = msgId;`.
    const msgIdAt = body.indexOf('ds.streamCardId = msgId;');
    const postArmAt = body.indexOf('syncUsageRefreshTimer(ds)', msgIdAt);
    expect(msgIdAt).toBeGreaterThan(-1);
    expect(postArmAt).toBeGreaterThan(msgIdAt);
  });

  it('every screen_update early gate that denies a visible card clears the timer', () => {
    // A working→working managed/silent/disabled/recovery turn must tear down a
    // stale timer from a prior visible turn — not leave it ticking on an
    // unauthorized card. Each gate is `{ clearUsageRefreshTimer(ds); break; }`.
    expect(src).toContain('if (managedAuxUiSuppressed(msg.turnId, msg.dispatchAttempt)) { clearUsageRefreshTimer(ds); break; }');
    expect(src).toContain('if (streamingCardDisabled(ds, msg.turnId)) { clearUsageRefreshTimer(ds); break; }');
    expect(src).toContain('if (ds.suppressRecoveryCard) { clearUsageRefreshTimer(ds); break; }');
  });

  it('screenshot_uploaded is clear-only — it never arms the timer', () => {
    // Arming here would let a tick re-render the prior group-visible card with a
    // managed/hidden turn's content. screen_update owns the authorized arm.
    const body = switchCaseBody(src, 'screenshot_uploaded');
    expect(body).toContain('clearUsageRefreshTimer(ds)');
    expect(body).not.toContain('armUsageRefreshTimer(');
    expect(body).not.toContain('syncUsageRefreshTimer(');
  });

  it('killWorker and dead-generation worker exit clear the timer', () => {
    const kill = functionBody(src, 'export function killWorker(');
    expect(kill).toContain('clearUsageRefreshTimer(ds)');
    // The `ds.worker === worker` exit branch (dead generation) also clears.
    const exitIdx = src.indexOf("worker.on('exit'");
    expect(exitIdx).toBeGreaterThan(-1);
    // Slice the whole exit handler (up to its terminating `\n  });`) instead of
    // a fixed byte budget: the handler legitimately grows (delivery settlement,
    // retirement notices) and a fixed window truncates before the
    // dead-generation cleanup branch this lock is anchored to.
    const exitEnd = src.indexOf('\n  });', exitIdx);
    expect(exitEnd).toBeGreaterThan(exitIdx);
    const exitBody = src.slice(exitIdx, exitEnd);
    // Whole-handler containment is not enough: an unconditional clear at the
    // handler tail (a stale old-worker exit wiping the replacement's timer)
    // would still match. Pin the clear INSIDE the dead-generation branch by
    // requiring it between the branch guard and a marker that is still inside
    // that branch (`ds.session.webPort = undefined;`).
    const branchIdx = exitBody.indexOf('if (ds.worker === worker) {');
    expect(branchIdx).toBeGreaterThan(-1);
    const clearIdx = exitBody.indexOf('clearUsageRefreshTimer(ds)');
    const branchMarkerIdx = exitBody.indexOf('ds.session.webPort = undefined;');
    expect(clearIdx).toBeGreaterThan(branchIdx);
    expect(branchMarkerIdx).toBeGreaterThan(clearIdx);
    // Exactly one clear in the handler — a second, unconditional one would
    // also break the pinned-position reasoning above.
    expect(exitBody.indexOf('clearUsageRefreshTimer(ds)', clearIdx + 1)).toBe(-1);
  });

  it('the ready handler is a full boundary: clears on entry, re-arms after card reuse and fresh POST', () => {
    const ready = switchCaseBody(src, 'ready');
    // Entry clear (dead prior-generation timer must not survive the early breaks).
    expect(ready).toContain('clearUsageRefreshTimer(ds)');
    // Two authorized re-arm points inside ready (reuse + fresh POST).
    const arms = ready.split('syncUsageRefreshTimer(ds)').length - 1;
    expect(arms).toBeGreaterThanOrEqual(2);
  });

  it('manual /card (postFreshStreamingCard) syncs on both success and rollback', () => {
    // Fourth live-card-identity entry point: a /card during a working turn lands
    // a card whose later screen_updates are working→working (no status edge), so
    // it must arm on success; the catch restores the prior card id and must
    // re-sync so a rollback never strands the timer.
    const body = functionBody(src, 'export async function postFreshStreamingCard(');
    const arms = body.split('syncUsageRefreshTimer(ds)').length - 1;
    expect(arms).toBe(2);
  });
});
