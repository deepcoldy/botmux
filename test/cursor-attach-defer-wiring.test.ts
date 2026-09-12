import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-level wiring assertions for the cursor attach defer state machine.
// The defer logic (classify → select baseline, short-read snapshotComplete)
// is unit-tested in cursor-transcript.test.ts; these tests pin the WORKER
// wiring: the 5 call sites must only clear their pending identity on
// 'attached' (never on 'deferred'), the poller must retry a deferred
// baseline, flushPending must hold input during defer, the 30s fail-safe
// must disable + release, and teardown must clear state WITHOUT re-kicking
// (the exit matrix). Source-level because cursorBridgeAttach touches
// module-level bridge state that is impractical to spin up in a unit test.
// Behavioral coverage (write=0 during defer, one prompt once after attach)
// is provided by the drain-level tests + live verification.

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function functionSlice(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('cursor attach defer wiring', () => {
  it('cursorBridgeAttach returns attached|deferred, defers on !snapshotComplete, and re-kicks on success', () => {
    const body = functionSlice('cursorBridgeAttach', 'codexBridgeDetachFile');
    expect(body).toContain("CursorAttachResult");
    expect(body).toContain("'attached'");
    expect(body).toContain("'deferred'");
    // Fail-safe disabled → don't retry.
    expect(body).toContain('cursorBridgeDisabled');
    // snapshotComplete gate: a short read / missing file defers.
    expect(body).toContain('snapshotOk');
    expect(body).toContain('!full.snapshotComplete');
    expect(body).toContain('!existsSync(path)');
    // The defer branch arms the poller but commits no baseline.
    expect(body).toContain('cursorBaselineDeferred = true');
    expect(body).toContain('cursorDeferStartedAtMs ??= Date.now()');
    expect(body).toContain('codexBridgeStartTimer()');
    expect(body).toContain("return 'deferred'");
    // The commit branch clears the flag and returns attached.
    expect(body).toContain('cursorBaselineDeferred = false');
    expect(body).toContain('cursorDeferStartedAtMs = undefined');
    expect(body).toContain("return 'attached'");
    // Re-kick held input after a successful attach (same live backend).
    expect(body).toContain('if (wasDeferred) void flushPending()');
  });

  it('flushPending holds ALL botmux-controlled PTY input during cursor defer', () => {
    // Use the exact signature to avoid matching flushPendingInjections.
    const start = source.indexOf('async function flushPending(): Promise<void> {');
    const end = source.indexOf('function sendToPty(', start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    // The gate must be cursor-only (not just the flag) and before any
    // shift/mark/write — it sits among the early-return guards.
    expect(body).toContain('codexBridgeIsCursor() && cursorBaselineDeferred');
    // The gate must appear BEFORE the first write/shift.
    const gateIdx = body.indexOf('codexBridgeIsCursor() && cursorBaselineDeferred');
    const writeIdx = body.search(/backend\.(write|sendInput|writeInput)/);
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    if (writeIdx >= 0) expect(gateIdx).toBeLessThan(writeIdx);
  });

  it('poller has a 30s fail-safe that disables the fallback and releases input', () => {
    const pollerCursor = source.slice(
      source.indexOf('if (codexBridgeIsCursor()) {', source.indexOf('codexBridgeStartTimer')),
      source.indexOf('codexBridgeIngest()', source.indexOf('cursorBaselineDeferred')),
    );
    // Fail-safe: timeout check.
    expect(pollerCursor).toContain('CURSOR_DEFER_FAILSAFE_MS');
    expect(pollerCursor).toContain('cursorDeferStartedAtMs');
    // On timeout: disable + clear + detach + re-kick.
    expect(pollerCursor).toContain('cursorBridgeDisabled = true');
    expect(pollerCursor).toContain('cursorBaselineDeferred = false');
    expect(pollerCursor).toContain('codexBridgeDetachFile()');
    expect(pollerCursor).toContain('void flushPending()');
    // Disabled → skip the cursor branch entirely.
    expect(pollerCursor).toContain('if (cursorBridgeDisabled) return');
  });

  it('codexBridgeDetachFile clears defer state WITHOUT re-kicking (rotation exit)', () => {
    const body = functionSlice('codexBridgeDetachFile', 'currentCodexObservedPid');
    expect(body).toContain('cursorBaselineDeferred = false');
    expect(body).toContain('cursorDeferStartedAtMs = undefined');
    // Rotation detach must NOT re-kick — the new attach re-kicks on success.
    expect(body).not.toContain('void flushPending()');
  });

  it('stopCodexBridge clears defer state WITHOUT re-kicking (teardown exit)', () => {
    const body = functionSlice('stopCodexBridge', 'retainSecondaryPathIfStillReferenced');
    expect(body).toContain('cursorBaselineDeferred = false');
    expect(body).toContain('cursorDeferStartedAtMs = undefined');
    expect(body).toContain('cursorBridgeDisabled = false');
    // Teardown must NOT re-kick — held input is taken over by the new
    // generation's ready/init lifecycle, not written to the dying CLI.
    expect(body).not.toContain('void flushPending()');
  });

  it('all 5 cursorBridgeAttach call sites gate pending-clear on the return value', () => {
    // Every cursorBridgeAttach call must inspect its return value so a
    // deferred attach never clears the caller's pending sid/pid.
    const callIndices: number[] = [];
    let idx = source.indexOf('cursorBridgeAttach(');
    while (idx !== -1) {
      // Skip the function definition itself.
      if (!source.slice(idx - 9, idx).includes('function ')) {
        callIndices.push(idx);
      }
      idx = source.indexOf('cursorBridgeAttach(', idx + 1);
    }
    // 5 call sites: timer late-attach, poller defer retry, notify, adopt
    // direct, spawnCli. All must inspect the return value.
    expect(callIndices.length).toBe(5);
    for (const i of callIndices) {
      // Within 200 chars after the call, there must be a return-value check
      // ('attached' or 'deferred') — the caller inspects the result.
      const after = source.slice(i, i + 200);
      expect(after).toMatch(/=== '(attached|deferred)'/);
    }
  });

  it('fail-safe truly disables fallback mark (not just polling)', () => {
    // codexBridgeFallbackActive must check cursorBridgeDisabled, so after
    // the 30s fail-safe the mark path (codexBridgeMarkPendingTurn) is also
    // skipped — not just the poller ingest. Otherwise disabled sessions
    // would pile up 20s attribution heads with no transcript start.
    const fallbackFn = functionSlice('codexBridgeFallbackActive', 'hasStructuredLifecycleBlock');
    expect(fallbackFn).toContain('isCursorFallbackDisabled');
    expect(fallbackFn).toContain('cursorBridgeDisabled');
    // The mark path in flushPending is gated by codexBridgeActive, which is
    // assigned from codexBridgeFallbackActive().
    const flushStart = source.indexOf('async function flushPending(): Promise<void> {');
    const flushEnd = source.indexOf('function sendToPty(', flushStart + 1);
    const flushBody = source.slice(flushStart, flushEnd);
    expect(flushBody).toContain('const codexBridgeActive = codexBridgeFallbackActive()');
    // The mark call must be inside the codexBridgeActive gate.
    const markIdx = flushBody.indexOf('codexBridgeMarkPendingTurn');
    const activeIdx = flushBody.indexOf('codexBridgeActive');
    expect(markIdx).toBeGreaterThan(activeIdx);
  });
});
