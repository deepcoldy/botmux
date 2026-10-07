import { describe, expect, it } from 'vitest';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';

const user = (uuid: string, text: string, timestampMs = 10_000): CodexBridgeEvent =>
  ({ uuid, text, timestampMs, kind: 'user' });

describe('structured queue CoT supersession', () => {
  it('reports the exact retired attempt once, after its last tool result and before successor activity', () => {
    const q = new CodexBridgeQueue(() => 10_000);
    const seen: string[] = [];
    q.setCotObserver((entries, turn) => seen.push(`${turn.turnId}:${entries[0].kind}`));
    q.setCotSupersededObserver(turn => seen.push(`superseded:${turn.turnId}:${turn.dispatchAttempt}`));
    q.mark('first', 'first input', 10_000, 2);
    q.mark('second', 'second input', 10_000, 3);
    const events: CodexBridgeEvent[] = [
      user('u1', 'first input'),
      { uuid: 'c1', timestampMs: 10_001, kind: 'cot', text: '', cotEntries: [{ kind: 'tool_result', id: 'read', result: 'ok' }] },
      user('u2', 'second input', 10_002),
      { uuid: 'c2', timestampMs: 10_003, kind: 'cot', text: '', cotEntries: [{ kind: 'thinking', text: 'continued' }] },
      { uuid: 'f2', timestampMs: 10_004, kind: 'assistant_final', text: 'answer' },
    ];
    q.ingest(events);
    q.ingest(events);
    expect(seen).toEqual(['first:tool_result', 'superseded:first:2', 'second:thinking']);
    // No synthetic durable completion for the retired first turn.
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'second', dispatchAttempt: 3, finalText: 'answer' }]);
  });

  it.each(['unmatched', 'historical', 'absorbed', 'distinct-native', 'preserved', 'completed'])(
    'does not close the timeline for %s input', (scenario) => {
      const q = new CodexBridgeQueue(() => 10_000);
      const superseded: string[] = [];
      q.setCotSupersededObserver(turn => superseded.push(turn.turnId));
      q.mark('first', 'first input', 10_000);
      q.mark('second', 'second input', 10_000);
      q.ingest([{ ...user('u1', 'first input'), ...(scenario === 'distinct-native' ? { sourceTurnId: 'native-1' } : {}) }]);
      const next = { ...user('u2', 'second input'),
        ...(scenario === 'unmatched' ? { text: 'unrelated input' } : {}),
        ...(scenario === 'historical' ? { timestampMs: 1 } : {}),
        ...(scenario === 'distinct-native' ? { sourceTurnId: 'native-2' } : {}),
        ...(scenario === 'preserved' ? { preserveCollecting: true } : {}),
      };
      if (scenario === 'absorbed') q.absorb([next]);
      if (scenario === 'completed') q.ingest([{ uuid: 'f1', timestampMs: 10_001, kind: 'assistant_final', text: 'first answer' }]);
      q.ingest([next]);
      expect(superseded).toEqual([]);
      expect(q.peek().some(turn => turn.turnId === 'first')).toBe(true);
    },
  );

  it('keeps attribution intact if cosmetic cleanup throws', () => {
    const q = new CodexBridgeQueue(() => 10_000);
    q.setCotSupersededObserver(() => { throw new Error('display failed'); });
    q.mark('first', 'first input', 10_000);
    q.mark('second', 'second input', 10_000);
    q.ingest([user('u1', 'first input'), user('u2', 'second input'),
      { uuid: 'f2', timestampMs: 10_001, kind: 'assistant_final', text: 'answer', terminalStatus: 'failed' }]);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'second', terminalStatus: 'failed' }]);
  });

  it('notifies retirement when a fresh local adopted input replaces a Lark turn', () => {
    const q = new CodexBridgeQueue(() => 10_000);
    const superseded: string[] = [];
    q.setLocalTurns(true, 10_000);
    q.setCotSupersededObserver(turn => superseded.push(turn.turnId));
    q.mark('first', 'first input', 10_000);
    q.ingest([user('u1', 'first input'), user('u-local', 'terminal input')]);
    expect(superseded).toEqual(['first']);
    expect(q.peek()).toMatchObject([{ isLocal: true, userText: 'terminal input' }]);
  });
});
