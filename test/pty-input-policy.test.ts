import { describe, expect, it } from 'vitest';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { decideHardTimeoutAction, shouldWriteNow } from '../src/utils/input-gate.js';
import { pendingInputAllowsTypeAhead, shouldStopPendingBatch } from '../src/utils/pending-input-queue.js';
import { inspectPostTerminalComposer, resolvePtyInputPolicy } from '../src/utils/pty-input-policy.js';

describe('resolvePtyInputPolicy', () => {
  it.each([
    { backend: 'pty', authoritative: true, typeAhead: true },
    { backend: 'tmux', authoritative: true, typeAhead: true },
    { backend: 'zmx', authoritative: false, typeAhead: false },
  ])('keeps TraeX input and batching consistent on $backend', ({ authoritative, typeAhead }) => {
    const policy = resolvePtyInputPolicy(createTraexAdapter('/bin/traex'), authoritative);
    const next = { content: 'correction' };
    const busyInput = pendingInputAllowsTypeAhead(policy.supportsTypeAhead, false, next);
    expect(busyInput).toBe(typeAhead);
    expect(shouldWriteNow({
      isPromptReady: false, isFlushing: false, supportsTypeAhead: busyInput, awaitingFirstPrompt: false,
    })).toBe(typeAhead);
    expect(shouldStopPendingBatch({ content: 'first' }, next, policy.allowBackToBackWrites)).toBe(!typeAhead);
    // A missing startup-ready event must not strand a serial backend forever.
    expect(decideHardTimeoutAction(policy.supportsTypeAhead)).toBe(typeAhead ? 'flush' : 'mark-ready');
    // Serial backends still deliver at the next normal ready boundary.
    expect(shouldWriteNow({
      isPromptReady: true, isFlushing: false, supportsTypeAhead: busyInput, awaitingFirstPrompt: false,
    })).toBe(true);
  });

  it.each([true, false])('preserves other adapters on non-authoritative screens with typeAhead=%s', supportsTypeAhead => {
    expect(resolvePtyInputPolicy({ supportsTypeAhead }, false)).toEqual({
      supportsTypeAhead, allowBackToBackWrites: true,
    });
  });

  it('keeps explicit serial fence adapters serial even with authoritative screens', () => {
    expect(resolvePtyInputPolicy({ supportsTypeAhead: false, postTerminalPromptFence: true }, true)).toEqual({
      supportsTypeAhead: false, allowBackToBackWrites: false,
    });
  });

  it('preserves runtime type-ahead activation without bypassing a required viewport fence', () => {
    expect(resolvePtyInputPolicy({}, false, true).supportsTypeAhead).toBe(true);
    expect(resolvePtyInputPolicy({ postTerminalPromptFence: true }, true, true).supportsTypeAhead).toBe(true);
    expect(resolvePtyInputPolicy({ postTerminalPromptFence: true }, false, true)).toEqual({
      supportsTypeAhead: false, allowBackToBackWrites: false,
    });
  });

  it('retains durable input barriers on a healthy type-ahead backend', () => {
    const policy = resolvePtyInputPolicy(createTraexAdapter('/bin/traex'), true);
    expect(pendingInputAllowsTypeAhead(policy.supportsTypeAhead, true, { content: 'correction' })).toBe(false);
    expect(pendingInputAllowsTypeAhead(policy.supportsTypeAhead, false, { content: 'delivery', dispatchAttempt: 1 })).toBe(false);
    expect(shouldStopPendingBatch({ content: 'first' }, { content: 'delivery', dispatchAttempt: 1 }, policy.allowBackToBackWrites)).toBe(true);
  });
});

describe('inspectPostTerminalComposer', () => {
  const adapter = createTraexAdapter('/bin/traex');
  const inspect = (screen: string) => inspectPostTerminalComposer(
    screen, adapter.busyPattern, adapter.staticBusyClearPattern!,
  );

  it('releases a fresh composer above tmux viewport padding', () => {
    const captured = '\x1b[32m❯ Ask TraeCode CLI to do anything\x1b[0m\nContext 65% left\n' + '\n'.repeat(48);
    expect(inspect(captured).ready).toBe(true);
  });

  it('holds when a queue marker follows an older composer', () => {
    expect(inspect('❯ Ask TraeCode CLI to do anything\nQueued for next turn\n' + '\n'.repeat(48)).ready).toBe(false);
  });

  it('releases when a new composer follows an old busy marker', () => {
    expect(inspect('Queued for next turn\n❯ Ask TraeCode CLI to do anything\n').ready).toBe(true);
  });

  it('does not accept a historical composer outside the visible content tail', () => {
    expect(inspect('❯ old prompt\n' + 'working output\n'.repeat(50)).ready).toBe(false);
  });

  it('holds an empty screen', () => {
    expect(inspect('\n'.repeat(50))).toEqual({ ready: false, busyAt: -1, composerAt: -1 });
  });
});
