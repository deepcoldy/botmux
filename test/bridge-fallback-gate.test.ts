import { describe, it, expect } from 'vitest';
import { shouldSuppressBridgeEmit, type BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';

const turn = (markTimeMs: number | undefined, isLocal: boolean | undefined = false) =>
  ({ markTimeMs, isLocal });

describe('shouldSuppressBridgeEmit', () => {
  it('adopt mode never suppresses, even with markers in window', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 150 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, true)).toBe(false);
    expect(shouldSuppressBridgeEmit(turn(100, true), undefined, markers, true)).toBe(false);
  });

  it('non-adopt: isLocal turn always suppressed (skip web-terminal echo to Lark)', () => {
    expect(shouldSuppressBridgeEmit(turn(100, true), 200, [], false)).toBe(true);
  });

  it('non-adopt: emits when no marker landed in window', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 50 }, { sentAtMs: 250 }];
    // window is [100, 200); both markers fall outside
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(false);
  });

  it('non-adopt: suppresses when a marker is inside [markTimeMs, nextBoundaryMs)', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 150 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(true);
  });

  it('non-adopt: marker exactly at lower bound suppresses (>= boundary)', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 100 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(true);
  });

  it('non-adopt: marker exactly at upper bound does NOT suppress (< boundary)', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 200 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(false);
  });

  it('non-adopt: last ready turn with no next boundary uses +inf upper bound', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 5_000_000 }];
    expect(shouldSuppressBridgeEmit(turn(100), undefined, markers, false)).toBe(true);
  });

  it('non-adopt: marker BEFORE turn does not suppress (it belongs to a previous turn)', () => {
    // Concretely: turn1 mark=100 + send=150, then turn2 mark=200 + no send.
    // turn2 window is [200, +inf); send=150 falls outside; turn2 must emit.
    const markers: BridgeSendMarker[] = [{ sentAtMs: 150 }];
    expect(shouldSuppressBridgeEmit(turn(200), undefined, markers, false)).toBe(false);
  });

  it('non-adopt: type-ahead — a send inside turn2 window does NOT suppress turn1', () => {
    // turn1 mark=100 (no send for it), turn2 mark=200 + send=250.
    // turn1 is the first ready, nextBoundary=200 (turn2). markers in [100,200) is empty → emit turn1.
    const markers: BridgeSendMarker[] = [{ sentAtMs: 250 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(false);
  });

  it('non-adopt: turn without markTimeMs degrades to "never suppress"', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 999 }];
    expect(shouldSuppressBridgeEmit(turn(undefined), undefined, markers, false)).toBe(false);
  });

  it('non-adopt: empty marker list → no suppression (regardless of bounds)', () => {
    expect(shouldSuppressBridgeEmit(turn(100), 200, [], false)).toBe(false);
  });

  it('non-adopt: multiple markers — any one inside window triggers suppress', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 50 }, { sentAtMs: 175 }, { sentAtMs: 500 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(true);
  });
});
