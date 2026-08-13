/**
 * Regression: recovery-seam at-most-once fence for the turn-level idempotency key
 * (turnIdempotencyKey, PR #818). A keyed follow-up delivered to a LIVE codex-app
 * worker records a durable `accepted` entry on the Codex App dispatch ledger. If
 * that turn is interrupted, the turn lease terminalizes it to a durable
 * `failed(dispatch_unknown)` (the caller is told "not run, at-most-once") but —
 * unlike a fresh async-virtual session — LEAVES the shared session open and
 * un-quarantined. The daemon then eager-reforks that session at boot
 * (restoreActiveSessions → durable-owner → forkWorker), and the recovery path
 * (`codexAppRecoveredDispatches` → worker init → `recoveredAcceptedInputs`, keyed
 * on `state==='accepted'` ALONE, with no `noReplay`) would otherwise re-issue
 * `turn/start` for a turn the caller already saw as `failed`.
 *
 * The fence (`retireTerminalizedCodexAppLedgerEntriesForRecovery`, run inside
 * forkWorker BEFORE the recovery snapshot) durably retires exactly those
 * `accepted` entries whose OWNER-MATCHED async terminal is
 * `failed(dispatch_unknown)`, so they never reach the recovery snapshot — while
 * leaving pending / completed / prepared / foreign-owned entries untouched.
 *
 * Drives the REAL async-trigger-store (temp SESSION_DATA_DIR) + the REAL ledger
 * helpers; only session-store.updateSession is stubbed so persistence is
 * observable without a real sessions file.
 *
 * Run:  pnpm vitest run test/codex-app-recovery-terminalized-fence.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DaemonSession } from '../src/core/types.js';
import type { CodexAppDispatchLedgerEntry } from '../src/types.js';

let tempDir: string;
let prevDataDir: string | undefined;

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Observe durable persistence without a real sessions-*.json write.
const updateSessionMock = vi.fn();
vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-store.js')>();
  return { ...actual, updateSession: (...a: any[]) => updateSessionMock(...a) };
});

import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import { __testOnly_retireTerminalizedCodexAppLedgerEntriesForRecovery as retireFence } from '../src/core/worker-pool.js';

const APP = 'app_recovery_fence';
const OTHER_APP = 'app_other_bot';
const SID = 'sess_shared_codex_app';

let dispatchSeq = 0;
function accepted(turnId: string, content = 'keyed follow-up'): CodexAppDispatchLedgerEntry {
  return { dispatchId: `disp-${turnId}-${dispatchSeq++}`, turnId, state: 'accepted', content, dispatchAttempt: 1 };
}
function prepared(turnId: string, content = 'in-flight'): CodexAppDispatchLedgerEntry {
  return { dispatchId: `disp-${turnId}-${dispatchSeq++}`, turnId, state: 'prepared', content, dispatchAttempt: 1 };
}

function ds(ledger: CodexAppDispatchLedgerEntry[], larkAppId = APP): DaemonSession {
  return {
    session: { sessionId: SID, chatId: 'oc_x', rootMessageId: '', scope: 'chat', status: 'active',
      createdAt: '2026-06-01T00:00:00.000Z', larkAppId, cliId: 'codex-app', codexAppDispatchLedger: ledger },
    worker: null, workerPort: null, workerToken: null, larkAppId,
    chatId: 'oc_x', chatType: 'group', scope: 'chat', spawnedAt: 1, cliVersion: 'test',
    lastMessageAt: 1, hasHistory: true, workingDir: '/tmp',
  } as unknown as DaemonSession;
}

/** Write a raw (possibly malformed) async-trigger file for SID, ensuring the
 *  store directory exists first (the store's own ensureDir hasn't run yet when
 *  we bypass recordFailedStrict to inject a corrupt shape). */
function writeRawAsyncTriggerFile(contents: string): void {
  mkdirSync(join(tempDir, 'async-triggers'), { recursive: true });
  writeFileSync(join(tempDir, 'async-triggers', `${SID}.json`), contents, 'utf-8');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'codex-recovery-fence-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tempDir;
  updateSessionMock.mockClear();
  dispatchSeq = 0;
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('codex-app recovery fence — terminalized keyed turn is not replayed (PR #818)', () => {
  it('retires an accepted entry whose OWN async terminal is failed(dispatch_unknown), keeps a pending sibling', () => {
    const term = accepted('turn-terminalized');
    const live = accepted('turn-still-pending');
    const session = ds([term, live]);
    // Owner-matched durable dispatch_unknown for the terminalized turn; a plain
    // pending record for the sibling (never terminalized).
    asyncTriggerStore.recordFailedStrict(SID, term.turnId, Date.now(), APP, 'dispatch_unknown');
    asyncTriggerStore.recordPending(SID, live.turnId, Date.now(), APP);

    retireFence(session);

    const remaining = session.session.codexAppDispatchLedger!.map(e => e.turnId);
    // The terminalized turn is durably retired → it can never reach the recovery
    // snapshot → never replayed as turn/start.
    expect(remaining).not.toContain('turn-terminalized');
    // The pending sibling is untouched (a legitimate not-yet-run turn must still resume).
    expect(remaining).toContain('turn-still-pending');
    expect(updateSessionMock).toHaveBeenCalledTimes(1); // durable persist happened
  });

  it('is a no-op when the async terminal is completed (completed wins — never retire a finished turn)', () => {
    const done = accepted('turn-completed');
    const session = ds([done]);
    asyncTriggerStore.recordCompleted(SID, done.turnId, 'the answer', Date.now(), APP);

    retireFence(session);

    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-completed');
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('is a no-op for a foreign-owned dispatch_unknown (owner-positive-proof: only OUR failed retires OUR entry)', () => {
    const term = accepted('turn-foreign-failed');
    const session = ds([term], APP);
    // A foreign bot wrote failed on the SAME sessionId/triggerId (adversarial /
    // sessionId collision). ownerLarkAppId != our APP → must be ignored.
    asyncTriggerStore.recordFailedStrict(SID, term.turnId, Date.now(), OTHER_APP, 'dispatch_unknown');

    retireFence(session);

    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-foreign-failed');
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('never retires a PREPARED entry even when its async terminal is failed (crossed write boundary → generation fence owns it)', () => {
    const prep = prepared('turn-prepared');
    const session = ds([prep]);
    asyncTriggerStore.recordFailedStrict(SID, prep.turnId, Date.now(), APP, 'dispatch_unknown');

    retireFence(session);

    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-prepared');
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('THROWS (fail-closed, no partial retire) when a terminalized accepted head cannot be exact-cancelled due to a prepared successor', () => {
    // accepted head is terminalized(failed), but a later PREPARED frame pins the
    // FIFO → cancelCodexAppDispatch refuses (prepared_successor_exists). The
    // generation fence only constrains the PREPARED frame; it never re-adds
    // noReplay to the surviving `accepted`, so a `continue`-and-fork would let the
    // worker replay the terminalized head as recoveredAcceptedInputs. Transactional
    // + fail-closed: abort the whole fork and leave the ledger intact for a later
    // seam (once the prepared frame settles).
    const head = accepted('turn-terminalized-head');
    const succ = prepared('turn-prepared-successor');
    const session = ds([head, succ]);
    asyncTriggerStore.recordFailedStrict(SID, head.turnId, Date.now(), APP, 'dispatch_unknown');

    expect(() => retireFence(session)).toThrow(/exact-retire|prepared_successor_exists/);
    // Ledger untouched (nothing retired, nothing persisted) — the terminalized
    // head is NOT force-removed past the prepared frame, and the fork is aborted.
    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId))
      .toEqual(['turn-terminalized-head', 'turn-prepared-successor']);
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('THROWS all-or-nothing when ONE of several terminalized candidates cannot be cancelled (no partial persist)', () => {
    // Two terminalized accepted turns; the SECOND is blocked by a prepared frame
    // after it. A per-item `continue` would persist the first retirement then fork
    // with the second still live. Transactional: NEITHER is persisted; abort.
    const a = accepted('turn-batch-a');
    const b = accepted('turn-batch-b');
    const blocker = prepared('turn-batch-blocker');
    const session = ds([a, b, blocker]);
    asyncTriggerStore.recordFailedStrict(SID, a.turnId, Date.now(), APP, 'dispatch_unknown');
    asyncTriggerStore.recordFailedStrict(SID, b.turnId, Date.now(), APP, 'dispatch_unknown');

    expect(() => retireFence(session)).toThrow();
    // ALL entries survive — no partial retirement was committed.
    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId))
      .toEqual(['turn-batch-a', 'turn-batch-b', 'turn-batch-blocker']);
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('is idempotent — a second recovery seam with the entry already gone does nothing', () => {
    const term = accepted('turn-idem');
    const session = ds([term]);
    asyncTriggerStore.recordFailedStrict(SID, term.turnId, Date.now(), APP, 'dispatch_unknown');

    retireFence(session);
    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).not.toContain('turn-idem');
    updateSessionMock.mockClear();
    // Re-run at the next fork seam: nothing left to retire.
    retireFence(session);
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('re-checks the durable truth every seam (failed persisted, ledger retirement not yet done → this fork completes it)', () => {
    // Models codex\'s window: exit-time best-effort retirement never ran (or crashed
    // right after the durable failed landed), so the accepted entry is still on the
    // ledger at the NEXT fork. The recovery seam re-reads the authoritative async
    // truth and finishes the retirement — no reliance on exit-time cleanup.
    const term = accepted('turn-window');
    const session = ds([term]);
    asyncTriggerStore.recordFailedStrict(SID, term.turnId, Date.now(), APP, 'dispatch_unknown');

    retireFence(session);

    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).not.toContain('turn-window');
    expect(updateSessionMock).toHaveBeenCalledTimes(1);
  });
});

// ── FAIL-CLOSED fault injection (codex #818 recovery-seam round-2): an ambiguous
//    fence must ABORT the fork (throw), never fall back to replaying the turn.
describe('codex-app recovery fence — fail-closed on ambiguity (PR #818)', () => {
  it('retire persist failure (updateSession EIO) → THROWS + rolls back the in-memory ledger (no partial retire, next seam retries)', () => {
    const term = accepted('turn-persist-eio');
    const session = ds([term]);
    asyncTriggerStore.recordFailedStrict(SID, term.turnId, Date.now(), APP, 'dispatch_unknown');
    // Simulate a durable persistence failure at the retire step.
    updateSessionMock.mockImplementationOnce(() => { throw new Error('simulated EIO on sessions write'); });

    // Fail-closed: the fence throws so forkWorker aborts BEFORE building the
    // recovery snapshot — degrading to "replay once" would be the very P1 we close.
    expect(() => retireFence(session)).toThrow(/EIO/);
    // In-memory ledger rolled back to the pre-retire state so the durable async
    // truth + the ledger stay consistent; the entry survives for the next seam.
    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-persist-eio');
  });

  it('present-but-corrupt authoritative async terminal → THROWS (strict read; never folds corrupt into "no record" and replays)', () => {
    const term = accepted('turn-corrupt-truth');
    const session = ds([term]);
    // Write a genuine durable failed, then CORRUPT the on-disk terminal file
    // (models a transiently unreadable / damaged async-trigger file). A soft
    // lookup would fold this into "no terminal" and let the accepted entry
    // re-enter the recovery snapshot; the strict read must throw instead.
    asyncTriggerStore.recordFailedStrict(SID, term.turnId, Date.now(), APP, 'dispatch_unknown');
    writeRawAsyncTriggerFile('{ this is not valid json');

    expect(() => retireFence(session)).toThrow();
    // Nothing retired, nothing persisted — the entry is preserved for a later
    // seam once the terminal file is readable again (fail-closed, not fail-open).
    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-corrupt-truth');
  });

  it('genuinely ABSENT async terminal (ENOENT / no such trigger) is NOT an error → no retire, fork proceeds', () => {
    // A keyed accepted entry with NO async record at all (turn never terminalized):
    // strict read returns undefined for ENOENT / absent trigger, so the fence is a
    // clean no-op and the fork proceeds normally (only failed:dispatch_unknown retires).
    const live = accepted('turn-no-terminal-yet');
    const session = ds([live]);
    // No recordFailedStrict / recordPending → the async-triggers file for SID does not exist.
    expect(() => retireFence(session)).not.toThrow();
    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-no-terminal-yet');
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('syntactically-valid JSON with a NON-plain-object `results` (array) → THROWS (not misread as "absent trigger")', () => {
    // codex #818 strict-shape: `results: []` is valid JSON and `typeof [] ===
    // "object"`, so a bare typeof gate lets it through; the precise trigger lookup
    // then yields undefined and would be read as "no terminal" → fail-open replay.
    // The strict shape check must reject a non-plain-object results and THROW.
    const term = accepted('turn-array-results');
    const session = ds([term]);
    writeRawAsyncTriggerFile(
      JSON.stringify({ ownerLarkAppId: APP, latestTriggerId: term.turnId, results: [] }),
    );

    expect(() => retireFence(session)).toThrow(/invalid shape|corrupt/i);
    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-array-results');
  });

  it('present-but-malformed hit result (null / invalid status) → THROWS (never read as a usable/absent terminal)', () => {
    // A plain-object file whose specific result entry is malformed (null, or an
    // invalid status). Reading it as "no terminal" (or trusting a bad status)
    // would fail-open; the runtime result-shape guard must throw.
    const term = accepted('turn-bad-result');
    const session = ds([term]);
    writeRawAsyncTriggerFile(
      JSON.stringify({ ownerLarkAppId: APP, latestTriggerId: term.turnId, results: { [term.turnId]: null } }),
    );

    expect(() => retireFence(session)).toThrow(/invalid shape|corrupt/i);
    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-bad-result');
  });

  it('a `failed` hit with a bad/absent `reason` → THROWS (discriminated validation; not silently un-retired and replayed)', () => {
    // codex #818 strict-schema: recordFailedStrict is the SOLE writer of a `failed`
    // result and always stamps reason:'dispatch_unknown' + errorCode:'no_output' +
    // failedAt. A `failed` with any other/absent reason is corrupt. If the strict
    // read only checked status/createdAt, this would pass, then the fence's
    // `reason==='dispatch_unknown'` sub-gate would skip it → the accepted entry
    // re-enters the recovery snapshot and REPLAYS (the original P1, reopened).
    // Fail-closed: discriminated validation throws.
    const term = accepted('turn-bad-reason');
    const session = ds([term]);
    writeRawAsyncTriggerFile(
      JSON.stringify({
        ownerLarkAppId: APP,
        latestTriggerId: term.turnId,
        results: { [term.turnId]: { status: 'failed', createdAt: 1, reason: 'not_dispatch_unknown', errorCode: 'no_output', failedAt: 2 } },
      }),
    );

    expect(() => retireFence(session)).toThrow(/invalid shape|corrupt/i);
    // Not retired, not persisted, not replayed — preserved for a later seam.
    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-bad-reason');
  });

  it('a `failed` hit MISSING failedAt → THROWS (all three failed-conditional fields required)', () => {
    const term = accepted('turn-failed-no-failedat');
    const session = ds([term]);
    writeRawAsyncTriggerFile(
      JSON.stringify({
        ownerLarkAppId: APP,
        latestTriggerId: term.turnId,
        results: { [term.turnId]: { status: 'failed', createdAt: 1, reason: 'dispatch_unknown', errorCode: 'no_output' } },
      }),
    );

    expect(() => retireFence(session)).toThrow(/invalid shape|corrupt/i);
    expect(updateSessionMock).not.toHaveBeenCalled();
  });
});
