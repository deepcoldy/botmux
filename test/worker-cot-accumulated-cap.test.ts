/**
 * The accumulated CoT shipped per turn stays within THINKING_ACCUMULATED_CAP
 * entry by entry: one long entry or a large batch no longer carries the total
 * past it, and the timeline ends with the「…」node as soon as the cap is hit.
 */
import { describe, expect, it, vi } from 'vitest';
import { stripTrailingBridgeSentinelLine } from '../src/services/bridge-fallback-gate.js';
import { publicReplyCardTools } from '../src/im/lark/turn-reply-card.js';
import type { CotEntry } from '../src/types.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const CAP = 100;

function worker(realFlush = false) {
  const scope: Record<string, any> = {
    lastInitConfig: {},
    THINKING_ACCUMULATED_CAP: CAP,
    thinkingTurnKey: undefined,
    thinkingTurn: undefined,
    thinkingEntries: [],
    thinkingTotalChars: 0,
    thinkingCapNoted: false,
    thinkingEmitTimer: null,
    thinkingLastEmitMs: 0,
    sessionId: 'session-cot-cap',
    clearTimeout: vi.fn(),
    scheduleThinkingEmit: vi.fn(),
    flushThinkingUpdate: vi.fn(),
    send: vi.fn(),
    log: vi.fn(),
    stripTrailingBridgeSentinelLine,
  };
  for (const name of ['cotEntryChars', 'cotEntryWithoutSentinel', 'observeCotEntries']) scope[name] = loadWorkerFunction(name, scope);
  if (realFlush) {
    // A controllable one-shot timer token: the real flush clears it and sends
    // synchronously, while observeCotEntries keeps its production scheduling.
    scope.scheduleThinkingEmit = vi.fn(() => { scope.thinkingEmitTimer = {}; });
    scope.flushThinkingUpdate = loadWorkerFunction('flushThinkingUpdate', scope);
  }
  return scope;
}

const ellipsis: CotEntry = { kind: 'thinking', text: '…' };

describe('worker CoT accumulated cap', () => {
  it('cuts one entry longer than the cap to what fits and ends with the ellipsis at once', () => {
    const w = worker();
    w.observeCotEntries([{ kind: 'thinking', text: 'x'.repeat(CAP + 1) }], { turnId: 'om_long' });
    expect(w.thinkingTotalChars).toBe(CAP);
    expect(w.thinkingEntries).toEqual([{ kind: 'thinking', text: 'x'.repeat(CAP) }, ellipsis]);
    expect(w.thinkingCapNoted).toBe(true);
    expect(w.scheduleThinkingEmit).toHaveBeenCalledTimes(1);
  });

  it('stops a batch at the cap instead of appending all of it', () => {
    const w = worker();
    const batch: CotEntry[] = [
      { kind: 'text', text: 'a'.repeat(60) },
      { kind: 'text', text: 'b'.repeat(60) },
      { kind: 'text', text: 'c'.repeat(60) },
    ];
    w.observeCotEntries(batch, { turnId: 'om_batch' });
    expect(w.thinkingTotalChars).toBe(CAP);
    expect(w.thinkingEntries).toEqual([batch[0], { kind: 'text', text: 'b'.repeat(40) }, ellipsis]);
  });

  it('leaves out a tool entry that does not fit rather than cutting its args', () => {
    const w = worker();
    const text: CotEntry = { kind: 'text', text: 't'.repeat(90) };
    const tool: CotEntry = { kind: 'tool_call', id: 'c1', name: 'Bash', args: JSON.stringify({ command: 'y'.repeat(40) }) };
    w.observeCotEntries([text, tool], { turnId: 'om_tool' });
    expect(w.thinkingEntries).toEqual([text, ellipsis]);
    expect(w.thinkingTotalChars).toBe(90);
  });

  it('adds the ellipsis once and nothing more after the cap', () => {
    const w = worker();
    w.observeCotEntries([{ kind: 'thinking', text: 'x'.repeat(CAP + 5) }], { turnId: 'om_after' });
    w.observeCotEntries([{ kind: 'text', text: 'more' }], { turnId: 'om_after' });
    expect(w.thinkingEntries.filter((e: CotEntry) => e.kind === 'thinking' && e.text === '…')).toHaveLength(1);
    expect(w.thinkingEntries.at(-1)).toEqual(ellipsis);
    expect(w.thinkingTotalChars).toBe(CAP);
  });

  it('does not split a surrogate pair at the cut', () => {
    const w = worker();
    w.observeCotEntries([{ kind: 'text', text: 'a'.repeat(CAP - 1) + '😀tail' }], { turnId: 'om_emoji' });
    expect(w.thinkingEntries[0]).toEqual({ kind: 'text', text: 'a'.repeat(CAP - 1) });
    expect(w.thinkingEntries[1]).toEqual(ellipsis);
  });

  it('keeps entries that fit exactly, and a turn under the cap is unchanged', () => {
    const w = worker();
    const exact: CotEntry[] = [{ kind: 'text', text: 'a'.repeat(50) }, { kind: 'text', text: 'b'.repeat(50) }];
    w.observeCotEntries(exact, { turnId: 'om_exact' });
    expect(w.thinkingEntries).toEqual(exact);
    expect(w.thinkingTotalChars).toBe(CAP);
    expect(w.thinkingCapNoted).toBe(false);
  });

  it('never reopens the timeline after a dropped tool entry left residual budget', () => {
    const w = worker();
    const text: CotEntry = { kind: 'text', text: 't'.repeat(90) };
    const tool: CotEntry = { kind: 'tool_call', id: 'c1', name: 'Bash', args: JSON.stringify({ command: 'y'.repeat(40) }) };
    w.observeCotEntries([text, tool], { turnId: 'om_tool_residual' });
    // A later batch in the same turn: small entries would fit in the residual
    // 10 chars, a large one would overshoot again. Neither may land after the
    // ellipsis, and no second ellipsis node may appear.
    w.observeCotEntries([
      { kind: 'text', text: 'a'.repeat(5) },
      { kind: 'text', text: 'z'.repeat(30) },
    ], { turnId: 'om_tool_residual' });
    expect(w.thinkingEntries).toEqual([text, ellipsis]);
    expect(w.thinkingEntries.filter((e: CotEntry) => e.kind === 'thinking' && e.text === '…')).toHaveLength(1);
    expect(w.thinkingEntries.at(-1)).toEqual(ellipsis);
    expect(w.thinkingTotalChars).toBe(90);
  });

  it('keeps the ellipsis terminal when a surrogate back-off left one char of budget', () => {
    const w = worker();
    w.observeCotEntries([{ kind: 'text', text: 'a'.repeat(CAP - 1) + '😀tail' }], { turnId: 'om_emoji_residual' });
    w.observeCotEntries([{ kind: 'text', text: 'q' }], { turnId: 'om_emoji_residual' });
    expect(w.thinkingEntries).toEqual([{ kind: 'text', text: 'a'.repeat(CAP - 1) }, ellipsis]);
    expect(w.thinkingEntries.at(-1)).toEqual(ellipsis);
    expect(w.thinkingTotalChars).toBe(CAP - 1);
  });

  it('pairs an already displayed tool when its oversized result crosses the cap', () => {
    const w = worker(true);
    const text: CotEntry = { kind: 'text', text: 't'.repeat(80) };
    const call = { kind: 'tool_call', id: 'c1', name: 'Bash', args: '1234567890' } satisfies CotEntry;
    const completion: CotEntry = { kind: 'tool_result', id: call.id, result: '' };
    w.observeCotEntries([text, call], { turnId: 'om_result_crosses_cap' });
    w.flushThinkingUpdate();
    expect(w.send.mock.lastCall![0].entries).toEqual([text, call]);

    w.observeCotEntries([{ kind: 'tool_result', id: call.id, result: 'r'.repeat(20) }], { turnId: 'om_result_crosses_cap' });
    expect(w.thinkingEntries).toEqual([text, call, completion, ellipsis]);
    expect(w.thinkingTotalChars).toBe(94);
    expect(w.thinkingCapNoted).toBe(true);

    w.flushThinkingUpdate();
    const update = w.send.mock.lastCall![0];
    expect(update.entries).toEqual([text, call, completion, ellipsis]);
    expect(publicReplyCardTools(update.entries, true)).toHaveLength(1);
    expect(publicReplyCardTools(update.entries, true)[0]).toMatchObject({ id: call.id, completed: true, result: '' });
  });

  it('keeps a capped ellipsis off the wire until a late result pairs its open tool', () => {
    const w = worker(true);
    const call = { kind: 'tool_call', id: 'c1', name: 'Bash', args: '1234567890' } satisfies CotEntry;
    const head: CotEntry = { kind: 'text', text: 'x'.repeat(CAP - call.name.length - call.args.length) };
    const completion: CotEntry = { kind: 'tool_result', id: call.id, result: '' };
    w.observeCotEntries([call], { turnId: 'om_result_after_cap' });
    w.flushThinkingUpdate();
    w.observeCotEntries([{ kind: 'text', text: 'x'.repeat(CAP + 20) }], { turnId: 'om_result_after_cap' });
    expect(w.thinkingEntries).toEqual([call, head, ellipsis]);

    // The tool is still running: neither a synthetic completion nor the
    // terminal ellipsis may cross the daemon's append-only boundary yet.
    w.flushThinkingUpdate();
    let update = w.send.mock.lastCall![0];
    expect(update.entries).toEqual([call, head]);
    expect(publicReplyCardTools(update.entries, true)[0].completed).toBeUndefined();

    w.observeCotEntries([{ kind: 'tool_result', id: call.id, result: 'late output' }], { turnId: 'om_result_after_cap' });
    w.flushThinkingUpdate();
    update = w.send.mock.lastCall![0];
    expect(update.entries).toEqual([call, head, completion, ellipsis]);
    expect(publicReplyCardTools(update.entries, true)[0]).toMatchObject({ id: call.id, completed: true, result: '' });
  });

  it('settles an unresolved capped tool only at the final flush', () => {
    const w = worker(true);
    const call = { kind: 'tool_call', id: 'c1', name: 'Bash', args: '1234567890' } satisfies CotEntry;
    const head: CotEntry = { kind: 'text', text: 'x'.repeat(CAP - call.name.length - call.args.length) };
    const completion: CotEntry = { kind: 'tool_result', id: call.id, result: '' };
    w.observeCotEntries([call, { kind: 'text', text: 'x'.repeat(CAP + 20) }], { turnId: 'om_no_result_terminal' });
    w.flushThinkingUpdate();
    expect(w.send.mock.lastCall![0].entries).toEqual([call, head]);

    w.flushThinkingUpdate(true);
    const update = w.send.mock.lastCall![0];
    expect(update.entries).toEqual([call, head, completion, ellipsis]);
    expect(publicReplyCardTools(update.entries, true)[0]).toMatchObject({ id: call.id, completed: true, result: '' });
  });
});
