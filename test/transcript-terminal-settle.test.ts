import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeTranscriptTailMidToolCycle, createTranscriptTerminalSettle } from '../src/services/transcript-terminal-settle.js';

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

  it('holds past the bound while the transcript is mid tool cycle (#3702)', () => {
    const proceed = vi.fn();
    const onTimeout = vi.fn();
    let mid = true;
    let awaiting = true;
    createTranscriptTerminalSettle({
      awaitingTerminal: () => awaiting, midToolCycle: () => mid, onTimeout, timeoutMs: 2_000, pollMs: 100, maxHoldMs: 60_000,
    }).request(proceed);
    vi.advanceTimersByTime(30_000);
    expect(proceed).not.toHaveBeenCalled(); // a premature "done" between two tools does not settle the turn
    mid = false; // the final answer block landed (stop_reason end_turn); its closing marker is still unread
    vi.advanceTimersByTime(1_000);
    expect(proceed).not.toHaveBeenCalled(); // the marker gets the normal bound again, not an instant timeout
    awaiting = false;
    vi.advanceTimersByTime(200);
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('after a hold ends, still finalizes once the normal bound runs out', () => {
    const proceed = vi.fn();
    const onTimeout = vi.fn();
    let mid = true;
    createTranscriptTerminalSettle({
      awaitingTerminal: () => true, midToolCycle: () => mid, onTimeout, timeoutMs: 2_000, pollMs: 100, maxHoldMs: 60_000,
    }).request(proceed);
    vi.advanceTimersByTime(10_000);
    mid = false;
    vi.advanceTimersByTime(1_500);
    expect(proceed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_200);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('a probe flipping in and out of the tool cycle still finalizes within maxHoldMs + one bound', () => {
    const proceed = vi.fn();
    let n = 0;
    createTranscriptTerminalSettle({
      awaitingTerminal: () => true, midToolCycle: () => (n++ % 2) === 0, timeoutMs: 2_000, pollMs: 100, maxHoldMs: 20_000,
    }).request(proceed);
    vi.advanceTimersByTime(19_000);
    expect(proceed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000 + 2_000 + 500 - 19_000);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('cancel during a hold drops it without finalizing', () => {
    const proceed = vi.fn();
    const settle = createTranscriptTerminalSettle({
      awaitingTerminal: () => true, midToolCycle: () => true, timeoutMs: 2_000, pollMs: 100, maxHoldMs: 60_000,
    });
    settle.request(proceed);
    vi.advanceTimersByTime(5_000);
    settle.cancel();
    vi.advanceTimersByTime(120_000);
    expect(proceed).not.toHaveBeenCalled();
  });

  it('stops holding at maxHoldMs even if still mid tool cycle', () => {
    const proceed = vi.fn();
    createTranscriptTerminalSettle({
      awaitingTerminal: () => true, midToolCycle: () => true, timeoutMs: 2_000, pollMs: 100, maxHoldMs: 10_000,
    }).request(proceed);
    vi.advanceTimersByTime(9_000);
    expect(proceed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('a mid-cycle probe that throws finalizes as before', () => {
    const proceed = vi.fn();
    createTranscriptTerminalSettle({
      awaitingTerminal: () => true, midToolCycle: () => { throw new Error('unreadable'); }, timeoutMs: 2_000, pollMs: 100,
    }).request(proceed);
    vi.advanceTimersByTime(2_200);
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

  it('reports a bound that ran out, and only that', () => {
    const proceed = vi.fn();
    const onTimeout = vi.fn(() => { expect(proceed).not.toHaveBeenCalled(); });
    let awaiting = true;
    const settle = createTranscriptTerminalSettle({ awaitingTerminal: () => awaiting, onTimeout, timeoutMs: 2_000, pollMs: 100 });
    settle.request(proceed);
    vi.advanceTimersByTime(2_100);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(proceed).toHaveBeenCalledTimes(1);

    settle.request(proceed);
    vi.advanceTimersByTime(300);
    awaiting = false;
    vi.advanceTimersByTime(100);
    expect(proceed).toHaveBeenCalledTimes(2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
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

describe('claudeTranscriptTailMidToolCycle', () => {
  const j = (r: unknown): string => JSON.stringify(r);
  const toolUse = j({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
  const toolResult = (id = 't1'): string => j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const finalText = j({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
  const lines = (...xs: string[]): string => xs.join('\n') + '\n';

  it('assistant stopped for tool_use: mid cycle', () => {
    expect(claudeTranscriptTailMidToolCycle(lines(toolUse))).toBe(true);
  });

  it('tool_result not answered yet (incl. parallel tool results): mid cycle', () => {
    expect(claudeTranscriptTailMidToolCycle(lines(toolUse, toolResult()))).toBe(true);
    const toolUse2 = toolUse.replace('"t1"', '"t2"');
    expect(claudeTranscriptTailMidToolCycle(lines(toolUse, toolUse2, toolResult('t1')))).toBe(true);
    expect(claudeTranscriptTailMidToolCycle(lines(toolUse, toolUse2, toolResult('t1'), toolResult('t2')))).toBe(true);
  });

  it('final answer (end_turn): not mid cycle', () => {
    expect(claudeTranscriptTailMidToolCycle(lines(toolUse, toolResult(), finalText))).toBe(false);
  });

  it('interrupt notice after a tool_result: not mid cycle', () => {
    const interrupted = j({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
    expect(claudeTranscriptTailMidToolCycle(lines(toolUse, toolResult(), interrupted))).toBe(false);
  });

  it('a new prompt or compact summary (string content): not mid cycle', () => {
    const prompt = j({ type: 'user', message: { content: 'next question' } });
    expect(claudeTranscriptTailMidToolCycle(lines(toolUse, toolResult(), prompt))).toBe(false);
  });

  it('skips meta, sidechain and non-message records', () => {
    const meta = j({ type: 'user', isMeta: true, message: { content: 'caveat' } });
    const side = j({ type: 'assistant', isSidechain: true, message: { stop_reason: 'end_turn', content: [] } });
    const sys = j({ type: 'system', subtype: 'informational' });
    expect(claudeTranscriptTailMidToolCycle(lines(toolUse, meta, side, sys))).toBe(true);
  });

  it('a window starting mid-line or unparsable text: falls back to not mid cycle', () => {
    // the 256KB window can open inside a record; a half line that starts with a nested '{' must not parse
    const half = toolUse.slice(toolUse.indexOf('{', 1));
    expect(half.startsWith('{')).toBe(true);
    expect(claudeTranscriptTailMidToolCycle(lines(half))).toBe(false);
    expect(claudeTranscriptTailMidToolCycle(lines(finalText.slice(finalText.indexOf('{', 1)), toolUse))).toBe(true);
    expect(claudeTranscriptTailMidToolCycle('')).toBe(false);
  });
});
