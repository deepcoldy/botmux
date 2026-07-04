import { describe, it, expect } from 'vitest';
import { shouldSuppressBridgeEmit, type BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';

const turn = (markTimeMs: number | undefined, isLocal: boolean | undefined = false) =>
  ({ markTimeMs, isLocal });

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();
const markerForContent = (sentAtMs: number, content: string): BridgeSendMarker => {
  const normalized = normalise(content);
  return {
    sentAtMs,
    contentLength: normalized.length,
  } as BridgeSendMarker;
};

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

  it('non-adopt: structured marker suppresses when sent content matches the transcript final', () => {
    const markers: BridgeSendMarker[] = [markerForContent(150, 'final answer body with extra formatting')];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: 'final answer body with extra formatting' },
      200,
      markers,
      false,
    )).toBe(true);
  });

  it('non-adopt: short progress marker does not suppress a materially longer transcript final', () => {
    const markers: BridgeSendMarker[] = [markerForContent(150, 'checking repository state')];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: 'The final answer contains a full implementation plan that was never explicitly sent through botmux send. It includes the deployment boundary, validation commands, rollout order, rollback criteria, and the remaining operational risks.' },
      200,
      markers,
      false,
    )).toBe(false);
  });

  it('non-adopt: short prefix marker does not suppress the missing material final', () => {
    const finalText = 'Plan: keep repository-owned scripts, install them through a setup skill, let a user-level systemd timer own the runtime synchronization loop, document rollback clearly, and validate the service with both a dry-run and a real one-shot sync before enabling the timer.';
    const markers: BridgeSendMarker[] = [markerForContent(150, 'Plan: keep repository-owned scripts')];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText },
      200,
      markers,
      false,
    )).toBe(false);
  });

  it('non-adopt: near-complete send suppresses a same-size rewritten final', () => {
    const finalText = 'Plan: keep repository-owned scripts, install them through a setup skill, let a user-level systemd timer own the runtime synchronization loop, and document rollback clearly.';
    const markers: BridgeSendMarker[] = [markerForContent(150, 'Plan: keep repository-owned scripts, install them through a setup skill, let a user-level timer own synchronization, and document rollback clearly.')];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText },
      200,
      markers,
      false,
    )).toBe(true);
  });

  it('non-adopt: multiple short progress markers do not suppress just because their total length is large', () => {
    const finalText = 'The final answer contains the actual migration plan, validation commands, rollout boundary, and the follow-up risk assessment. It also records the final commit, the exact checks that passed, the deployment switch order, and the rollback condition if the worker stops forwarding replies.';
    const markers: BridgeSendMarker[] = [
      markerForContent(130, 'I am checking the current repository state and reading the relevant files before making a narrow change.'),
      markerForContent(150, 'I found the existing scripts and will compare them before proposing the final plan and validation commands.'),
    ];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText },
      200,
      markers,
      false,
    )).toBe(false);
  });

  it('non-adopt: short transcript follow-up remains suppressed when a structured marker exists', () => {
    const markers: BridgeSendMarker[] = [markerForContent(150, 'full answer was sent through botmux send')];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: '已用 botmux send 发出。' },
      200,
      markers,
      false,
    )).toBe(true);
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
