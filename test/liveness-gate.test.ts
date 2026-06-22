import { describe, it, expect } from 'vitest';
import { LivenessGate, ADOPT_LIVENESS_MAX_FAILURES } from '../src/adapters/backend/liveness-gate.js';

describe('LivenessGate', () => {
  it('only trips after `threshold` consecutive failures', () => {
    const gate = new LivenessGate(3);
    expect(gate.record(false)).toBe(false);   // 1
    expect(gate.consecutiveFailures).toBe(1);
    expect(gate.record(false)).toBe(false);   // 2
    expect(gate.consecutiveFailures).toBe(2);
    expect(gate.record(false)).toBe(true);    // 3 → trips
    expect(gate.consecutiveFailures).toBe(3);
  });

  it('a single success resets the counter (no trip across a recovery)', () => {
    const gate = new LivenessGate(3);
    gate.record(false);
    gate.record(false);
    expect(gate.record(true)).toBe(false);     // recovery resets
    expect(gate.consecutiveFailures).toBe(0);
    expect(gate.record(false)).toBe(false);    // counting starts over
    expect(gate.record(false)).toBe(false);
    expect(gate.consecutiveFailures).toBe(2);  // still under threshold
  });

  it('keeps reporting tripped while failures persist past the threshold', () => {
    const gate = new LivenessGate(2);
    expect(gate.record(false)).toBe(false);
    expect(gate.record(false)).toBe(true);
    expect(gate.record(false)).toBe(true);     // still gone
  });

  it('reset() clears the counter', () => {
    const gate = new LivenessGate(2);
    gate.record(false);
    gate.reset();
    expect(gate.consecutiveFailures).toBe(0);
    expect(gate.record(false)).toBe(false);    // back to needing 2
  });

  it('threshold of 1 trips on the first failure (no debounce)', () => {
    const gate = new LivenessGate(1);
    expect(gate.record(false)).toBe(true);
  });

  it('rejects a threshold below 1', () => {
    expect(() => new LivenessGate(0)).toThrow();
  });

  it('ships a sane default budget (>= 3 so transient hiccups are tolerated)', () => {
    expect(ADOPT_LIVENESS_MAX_FAILURES).toBeGreaterThanOrEqual(3);
  });
});
