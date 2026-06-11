/**
 * ready-gate.test.ts
 *
 * Ready-gate state machine — holds the FIRST prompt for Claude-family CLIs until
 * a SessionStart hook fires a "真就绪" signal (or a fallback timeout elapses), so
 * a cjadk-style startup selector's ❯ (which falsely matches readyPattern) can't
 * trip an early flush that the selector eats.
 *
 * Scenarios pinned (per the task brief): signal-first, signal-after, timeout
 * fallback, resume (re-arm), and the not-armed passthrough that guarantees every
 * other CLI / adopt pane behaves exactly as before.
 *
 * Run: pnpm vitest run test/ready-gate.test.ts
 */
import { describe, it, expect } from 'vitest';
import { ReadyGate, shouldArmReadyGate } from '../src/utils/ready-gate.js';

describe('shouldArmReadyGate', () => {
  const base = { injectsReadyHook: true, adoptMode: false, willReattachPersistent: false };

  it('arms a fresh Claude-family spawn (hook will fire)', () => {
    expect(shouldArmReadyGate(base)).toBe(true);
  });

  it('does NOT arm a non-Claude CLI (no SessionStart hook injected)', () => {
    expect(shouldArmReadyGate({ ...base, injectsReadyHook: false })).toBe(false);
  });

  it('does NOT arm adopt panes (pre-existing, never got our --settings)', () => {
    expect(shouldArmReadyGate({ ...base, adoptMode: true })).toBe(false);
  });

  it('THE REATTACH REGRESSION: does NOT arm a persistent-backend reattach', () => {
    // daemon restart re-attaches an already-running tmux/zellij/herdr Claude
    // WITHOUT re-running its bin/args → no new SessionStart hook fires. Arming
    // would hold the first post-recovery message until the fallback timeout.
    expect(shouldArmReadyGate({ ...base, willReattachPersistent: true })).toBe(false);
  });

  it('reattach exclusion wins even for an otherwise-eligible fresh-looking spawn', () => {
    expect(shouldArmReadyGate({ injectsReadyHook: true, adoptMode: false, willReattachPersistent: true })).toBe(false);
  });
});

describe('ReadyGate', () => {
  it('not armed → never holds, receive() reports no flush needed (other CLIs / adopt)', () => {
    const g = new ReadyGate();
    expect(g.isArmed).toBe(false);
    expect(g.shouldHold()).toBe(false);
    // A stray signal on an un-armed gate releases nothing (nothing was held).
    expect(g.receive()).toBe(false);
    expect(g.shouldHold()).toBe(false);
  });

  it('armed → holds until the signal arrives', () => {
    const g = new ReadyGate();
    g.arm();
    expect(g.isArmed).toBe(true);
    expect(g.shouldHold()).toBe(true);
  });

  it('signal arrives (hook) → release returns true once, then gate stays open', () => {
    const g = new ReadyGate();
    g.arm();
    expect(g.shouldHold()).toBe(true);
    expect(g.receive()).toBe(true);     // transition: holding → open ⇒ caller flushes
    expect(g.isReceived).toBe(true);
    expect(g.shouldHold()).toBe(false); // permanently open for this spawn
  });

  it('duplicate / late signal is idempotent (clear/compact source, or post-timeout fire)', () => {
    const g = new ReadyGate();
    g.arm();
    expect(g.receive()).toBe(true);
    // A second fire (e.g. SessionStart source=clear later in the session, or the
    // timeout firing after the real hook) must NOT trigger another flush.
    expect(g.receive()).toBe(false);
    expect(g.receive()).toBe(false);
    expect(g.shouldHold()).toBe(false);
  });

  it('timeout fallback before any signal → release returns true (flush held prompt)', () => {
    const g = new ReadyGate();
    g.arm();
    expect(g.shouldHold()).toBe(true);
    // Worker fallback timer calls receive() — same transition as the real hook.
    expect(g.receive()).toBe(true);
    expect(g.shouldHold()).toBe(false);
    // The real hook firing afterwards is then a no-op.
    expect(g.receive()).toBe(false);
  });

  it('resume re-arms via a fresh instance (worker recreates per spawn)', () => {
    // First spawn.
    let g = new ReadyGate();
    g.arm();
    expect(g.receive()).toBe(true);
    expect(g.shouldHold()).toBe(false);
    // Respawn / resume: worker assigns a brand-new gate, so the previous
    // received state can't leak and accidentally pass the next first prompt.
    g = new ReadyGate();
    g.arm();
    expect(g.shouldHold()).toBe(true);
    expect(g.isReceived).toBe(false);
  });

  it('arm() is idempotent and order-independent with receive()', () => {
    const g = new ReadyGate();
    g.arm();
    g.arm();
    expect(g.shouldHold()).toBe(true);
    expect(g.receive()).toBe(true);
  });
});
