import { describe, expect, it } from 'vitest';
import { BusyReadyFallbackGate, type BusyProbeObservation } from '../src/utils/busy-ready-fallback.js';

const FALLBACK_MS = 1000;
const STABLE_MS = 400;

function makeGate() {
  return new BusyReadyFallbackGate(() => ({ fallbackMs: FALLBACK_MS, stableScreenMs: STABLE_MS }));
}

/** Build an observation at time t with the given overrides. */
function obs(t: number, rev: number, over: Partial<BusyProbeObservation> = {}): BusyProbeObservation {
  return {
    now: t,
    screenRevision: rev,
    readyPatternVisible: true,
    sessionStateBusy: false,
    transcriptTurnOpen: false,
    cliAlive: true,
    ...over,
  };
}

describe('BusyReadyFallbackGate', () => {
  it('never forces readiness before any observation', () => {
    const gate = makeGate();
    expect(gate.shouldForceReady(obs(0, 0))).toBe(false);
  });

  it('does not fire while the defer episode is shorter than fallbackMs even if stable and composer visible', () => {
    const gate = makeGate();
    gate.observe(obs(0, 7));
    // 999ms in, screen frozen since t=0: below fallbackMs.
    expect(gate.shouldForceReady(obs(999, 7))).toBe(false);
  });

  it('fires once defer >= fallbackMs AND screen frozen >= stableMs with composer visible and CLI alive', () => {
    const gate = makeGate();
    gate.observe(obs(0, 7));
    // t=1000: defer exactly fallbackMs; screen unchanged for 1000 >= stableMs 400.
    expect(gate.shouldForceReady(obs(1000, 7))).toBe(true);
  });

  it('respects the exact fallbackMs boundary', () => {
    const gate = makeGate();
    gate.observe(obs(0, 7));
    expect(gate.shouldForceReady(obs(FALLBACK_MS - 1, 7))).toBe(false);
    expect(gate.shouldForceReady(obs(FALLBACK_MS, 7))).toBe(true);
  });

  it('reverse: a screen that keeps changing (real work) never releases readiness', () => {
    const gate = makeGate();
    gate.observe(obs(0, 1));
    // Revision advances on every tick like a streaming CLI; far past fallbackMs.
    for (let t = 350; t <= 5000; t += 350) {
      const o = obs(t, 1 + Math.floor(t / 350));
      gate.observe(o);
      expect(gate.shouldForceReady(o)).toBe(false);
    }
  });

  it('a single late screen change restarts the stability clock even after fallbackMs elapsed', () => {
    const gate = makeGate();
    gate.observe(obs(0, 7));
    // Long frozen, fallback window elapsed — would fire.
    expect(gate.shouldForceReady(obs(1000, 7))).toBe(true);
    // Then the screen streams a new frame: stability clock resets.
    const o = obs(1100, 8);
    gate.observe(o);
    expect(gate.shouldForceReady(o)).toBe(false);
    // Only once it has been stable again for stableScreenMs does it fire.
    expect(gate.shouldForceReady(obs(1100 + STABLE_MS - 1, 8))).toBe(false);
    expect(gate.shouldForceReady(obs(1100 + STABLE_MS, 8))).toBe(true);
  });

  it('never overrides structured session-state busy', () => {
    const gate = makeGate();
    gate.observe(obs(0, 7, { sessionStateBusy: false }));
    const o = obs(5000, 7, { sessionStateBusy: true });
    gate.observe(o);
    expect(gate.shouldForceReady(o)).toBe(false);
  });

  it('never overrides a transcript that still holds the turn open', () => {
    const gate = makeGate();
    gate.observe(obs(0, 7));
    const o = obs(5000, 7, { transcriptTurnOpen: true });
    gate.observe(o);
    expect(gate.shouldForceReady(o)).toBe(false);
  });

  it('vetoed ticks neither start nor extend the episode', () => {
    const gate = makeGate();
    gate.observe(obs(0, 7, { transcriptTurnOpen: true }));
    gate.observe(obs(3000, 7, { sessionStateBusy: true }));
    // The first unvetoed tick opens the episode: the full window still applies.
    gate.observe(obs(6000, 7));
    expect(gate.shouldForceReady(obs(6000 + FALLBACK_MS - 1, 7))).toBe(false);
    expect(gate.shouldForceReady(obs(6000 + FALLBACK_MS, 7))).toBe(true);
  });

  it('requires positive composer evidence: no ready pattern means no force', () => {
    const gate = makeGate();
    gate.observe(obs(0, 7, { readyPatternVisible: false }));
    const o = obs(5000, 7, { readyPatternVisible: false });
    gate.observe(o);
    expect(gate.shouldForceReady(o)).toBe(false);
  });

  it('does not force on a known-dead CLI but treats unknown liveness as not-dead', () => {
    const gate = makeGate();
    gate.observe(obs(0, 7));
    const dead = obs(5000, 7, { cliAlive: false });
    expect(gate.shouldForceReady(dead)).toBe(false);

    const gate2 = makeGate();
    gate2.observe(obs(0, 7, { cliAlive: undefined }));
    const unknown = obs(5000, 7, { cliAlive: undefined });
    expect(gate2.shouldForceReady(unknown)).toBe(true);
  });

  it('reset() restarts the defer and stability clocks', () => {
    const gate = makeGate();
    gate.observe(obs(0, 7));
    expect(gate.shouldForceReady(obs(5000, 7))).toBe(true);
    gate.reset();
    // Fresh episode starting at t=5000: must wait a full fallbackMs again.
    gate.observe(obs(5000, 9));
    expect(gate.shouldForceReady(obs(5000 + FALLBACK_MS - 1, 9))).toBe(false);
    expect(gate.shouldForceReady(obs(5000 + FALLBACK_MS, 9))).toBe(true);
  });
});
