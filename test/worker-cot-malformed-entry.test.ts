/**
 * A malformed activity entry (a field its kind promises is missing, or the kind
 * is unknown) is dropped by the
 * worker's CoT intake instead of throwing out of the transcript drain and
 * taking the rest of the turn's activity with it.
 */
import { describe, expect, it, vi } from 'vitest';
import { stripTrailingBridgeSentinelLine } from '../src/services/bridge-fallback-gate.js';
import type { CotEntry } from '../src/types.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function worker(lastInitConfig: Record<string, unknown> = {}) {
  const scope: Record<string, any> = {
    lastInitConfig,
    // The reply card's activity buffer, as in worker.ts.
    THINKING_ACCUMULATED_CAP: 60_000,
    thinkingTurnKey: undefined,
    thinkingTurn: undefined,
    thinkingEntries: [],
    thinkingTotalChars: 0,
    thinkingCapNoted: false,
    scheduleThinkingEmit: vi.fn(),
    flushThinkingUpdate: vi.fn(),
    send: vi.fn(),
    log: vi.fn(),
    stripTrailingBridgeSentinelLine,
  };
  for (const name of ['cotEntryChars', 'cotEntryWithoutSentinel', 'observeCotEntries']) scope[name] = loadWorkerFunction(name, scope);
  return scope;
}

const tail: CotEntry[] = [
  { kind: 'tool_call', id: 'e1', name: 'Edit', args: '{}', subject: '/work/app/src/feature.ts' },
  { kind: 'tool_call', id: 'b1', name: 'Bash', args: '{}', subject: 'git push origin feat/x' },
  { kind: 'text', text: '已推送。\nBOTMUX_NOTHING_TO_SEND' },
];

describe('worker CoT intake', () => {
  it('skips a malformed entry instead of breaking the activity stream', () => {
    const w = worker();
    expect(() => w.observeCotEntries([{ kind: 'text', text: undefined } as any, ...tail], { turnId: 'om_bad' })).not.toThrow();
    expect(w.thinkingEntries.map((entry: CotEntry) => entry.kind)).toEqual(['tool_call', 'tool_call', 'text']);
  });

  it('skips a malformed entry in an adopted session and keeps the sentinel verbatim', () => {
    const w = worker({ adoptMode: true });
    expect(() => w.observeCotEntries([{ kind: 'text', text: undefined } as any, ...tail], { turnId: 'om_bad' })).not.toThrow();
    expect(w.thinkingEntries).toEqual(tail);
  });

  // Every kind's fields are checked, in both modes: a missing string would throw
  // while counting, and an unknown kind would make the running total NaN, which
  // silently switches off the accumulated cap.
  const malformed: Record<string, unknown> = {
    'thinking without text': { kind: 'thinking' },
    'tool_call without name': { kind: 'tool_call', id: 't1', args: '{}' },
    'tool_call without args': { kind: 'tool_call', id: 't1', name: 'Bash' },
    'tool_call with a non-string subject': { kind: 'tool_call', id: 't1', name: 'Bash', args: '{}', subject: 42 },
    'tool_result without result': { kind: 'tool_result', id: 't1' },
    'tool_call with a non-string id': { kind: 'tool_call', id: 7, name: 'Bash', args: '{}' },
    'tool_result without id': { kind: 'tool_result', result: 'ok' },
    'unknown kind': { kind: 'image', url: 'x' },
    'null entry': null,
  };
  for (const adoptMode of [false, true]) {
    for (const [name, entry] of Object.entries(malformed)) {
      it(`skips ${name}${adoptMode ? ' in an adopted session' : ''}`, () => {
        const w = worker({ adoptMode });
        expect(() => w.observeCotEntries([entry as any, ...tail], { turnId: 'om_bad' })).not.toThrow();
        expect(w.thinkingEntries.map((e: CotEntry) => e.kind)).toEqual(['tool_call', 'tool_call', 'text']);
        expect(Number.isFinite(w.thinkingTotalChars)).toBe(true);
      });
    }
  }

  // The progress signal reads the last entry's kind; it reads the last
  // well-formed one, and a batch with none is no observed activity.
  it('reports progress from the last well-formed entry when the last one is malformed', () => {
    const w = worker({ cliId: 'traex' });
    expect(() => w.observeCotEntries([...tail.slice(0, 2), null as any], { turnId: 'om_bad' })).not.toThrow();
    expect(w.send).toHaveBeenCalledExactlyOnceWith({ type: 'turn_progress', turnId: 'om_bad', stage: 'tool_started' });
    expect(w.thinkingEntries).toEqual(tail.slice(0, 2));
  });

  it('reports no progress for a batch with no well-formed entry', () => {
    const w = worker({ cliId: 'traex' });
    expect(() => w.observeCotEntries([null as any, { kind: 'text' } as any], { turnId: 'om_bad' })).not.toThrow();
    expect(w.send).not.toHaveBeenCalled();
    expect(w.thinkingEntries).toEqual([]);
  });
});
