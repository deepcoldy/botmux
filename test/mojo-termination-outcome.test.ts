/**
 * Indictment A: `terminateChildProven()` must not return a bare boolean, and the
 * evidence grade it produces must be the thing a blocker decision consults.
 *
 * These tests are deliberately PLATFORM-INDEPENDENT: they exercise the pure
 * projection `terminationOutcomeFromQuiescence()` and never touch /proc, so they
 * run identically on Linux and macOS (see indictment D).
 *
 * Every assertion here is written to be killed by a mutation of the projection:
 * flipping `boundaryProven` on the diagnostic-clean branch, nulling a residual,
 * or widening `ok` into the gate must all turn a test red.
 */
import { describe, expect, it } from 'bun:test';
import {
  terminationOutcomeFromQuiescence,
  type TurnQuiescence,
} from '../src/adapters/backend/mojo-process-tree.js';

describe('terminationOutcomeFromQuiescence', () => {
  it('grades kernel-level containment as the only boundary proof', () => {
    const outcome = terminationOutcomeFromQuiescence({ kind: 'contained-proven', boundaryProof: true });
    expect(outcome.ok).toBe(true);
    expect(outcome.boundaryProven).toBe(true);
    expect(outcome.evidence).toBe('members-empty');
    expect(outcome.residual).toBeNull();
    expect(outcome.signalsStopped).toBe(true);
  });

  it('refuses to let a clean scan become a boundary proof', () => {
    const outcome = terminationOutcomeFromQuiescence({ kind: 'diagnostic-clean', boundaryProof: false });
    // The whole indictment in one assertion pair: the ladder finished (ok) but
    // the boundary is NOT proven, and the two must not be collapsed.
    expect(outcome.ok).toBe(true);
    expect(outcome.boundaryProven).toBe(false);
    expect(outcome.evidence).toBe('diagnostic-clean');
    // Signalling may stop -- that is ALL a clean scan earns.
    expect(outcome.signalsStopped).toBe(true);
    // ...and it must leave something behind to hold the blocker.
    expect(outcome.residual).not.toBeNull();
    expect(outcome.residual?.deviceIsolation).toBe(true);
  });

  it('reports live members as not ok, with the pids as residual', () => {
    const outcome = terminationOutcomeFromQuiescence({ kind: 'alive', boundaryProof: false, pids: [4242, 4243] });
    expect(outcome.ok).toBe(false);
    expect(outcome.boundaryProven).toBe(false);
    expect(outcome.evidence).toBe('timeout');
    expect(outcome.residual?.pids).toEqual([4242, 4243]);
    expect(outcome.residual?.deviceIsolation).toBe(true);
    // Still worth signalling: something is demonstrably executing.
    expect(outcome.signalsStopped).toBe(false);
  });

  it('never reads "cannot enumerate" as "nothing is running"', () => {
    const outcome = terminationOutcomeFromQuiescence({
      kind: 'unscannable',
      boundaryProof: false,
      reason: 'EACCES on /proc/999/stat',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.boundaryProven).toBe(false);
    expect(outcome.evidence).toBe('unknown');
    expect(outcome.residual?.deviceIsolation).toBe(true);
    expect(outcome.residual?.reason).toContain('EACCES');
  });

  it('treats an unsupported platform as unproven rather than clean', () => {
    const outcome = terminationOutcomeFromQuiescence({
      kind: 'unsupported-platform',
      boundaryProof: false,
      platform: 'darwin',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.boundaryProven).toBe(false);
    expect(outcome.residual?.deviceIsolation).toBe(true);
    expect(outcome.residual?.reason).toContain('darwin');
  });

  describe('invariants that hold across every branch', () => {
    const all: TurnQuiescence[] = [
      { kind: 'contained-proven', boundaryProof: true },
      { kind: 'diagnostic-clean', boundaryProof: false },
      { kind: 'alive', boundaryProof: false, pids: [7] },
      { kind: 'unscannable', boundaryProof: false, reason: 'x' },
      { kind: 'unsupported-platform', boundaryProof: false, platform: 'win32' },
    ];

    it('leaves a residual whenever the boundary is unproven', () => {
      for (const q of all) {
        const outcome = terminationOutcomeFromQuiescence(q);
        if (!outcome.boundaryProven) {
          expect(outcome.residual, `${q.kind} must leave a residual`).not.toBeNull();
          expect(outcome.residual?.deviceIsolation, `${q.kind} must retain device isolation`).toBe(true);
        }
      }
    });

    it('proves the boundary only for kernel-level containment', () => {
      const proven = all.filter(q => terminationOutcomeFromQuiescence(q).boundaryProven).map(q => q.kind);
      expect(proven).toEqual(['contained-proven']);
    });

    it('does not bind boundaryProven to ok', () => {
      // ok===true && boundaryProven===false is the legal, common Linux case; a
      // mutation that returns `ok` from the gate would make this list empty.
      const okButUnproven = all
        .map(q => terminationOutcomeFromQuiescence(q))
        .filter(o => o.ok && !o.boundaryProven);
      expect(okButUnproven).toHaveLength(1);
      expect(okButUnproven[0]?.evidence).toBe('diagnostic-clean');
    });
  });
});
