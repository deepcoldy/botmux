import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTranscriptTerminalSettle } from '../src/services/transcript-terminal-settle.js';

describe('createTranscriptTerminalSettle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('finalizes immediately when the transcript already shows the terminal', () => {
    const proceed = vi.fn();
    createTranscriptTerminalSettle({ awaitingTerminal: () => false }).request(proceed);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('waits for the terminal marker to land, then finalizes once', () => {
    const proceed = vi.fn();
    let awaiting = true;
    createTranscriptTerminalSettle({ awaitingTerminal: () => awaiting }).request(proceed);
    vi.advanceTimersByTime(250);
    expect(proceed).not.toHaveBeenCalled();
    awaiting = false;
    vi.advanceTimersByTime(100);
    expect(proceed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('gives up after the bound and finalizes anyway', () => {
    const proceed = vi.fn();
    createTranscriptTerminalSettle({ awaitingTerminal: () => true, timeoutMs: 2_000, pollMs: 100 }).request(proceed);
    vi.advanceTimersByTime(1_900);
    expect(proceed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('does not finalize when the agent goes back to work', () => {
    const proceed = vi.fn();
    const settle = createTranscriptTerminalSettle({ awaitingTerminal: () => true });
    settle.request(proceed);
    vi.advanceTimersByTime(300);
    settle.cancel();
    vi.advanceTimersByTime(5_000);
    expect(proceed).not.toHaveBeenCalled();
  });

  it('a newer finished signal replaces the pending one', () => {
    const proceed = vi.fn();
    let awaiting = true;
    const settle = createTranscriptTerminalSettle({ awaitingTerminal: () => awaiting });
    settle.request(proceed);
    vi.advanceTimersByTime(300);
    settle.request(proceed);
    awaiting = false;
    vi.advanceTimersByTime(100);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('finalizes as before when the transcript cannot be read', () => {
    const proceed = vi.fn();
    createTranscriptTerminalSettle({ awaitingTerminal: () => { throw new Error('EIO'); } }).request(proceed);
    expect(proceed).toHaveBeenCalledTimes(1);
  });
});
