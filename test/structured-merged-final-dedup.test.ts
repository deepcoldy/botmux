import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridgeQueue, type CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import { checkpointCodexAdoptTurns, restoreCodexAdoptTurns } from '../src/services/codex-adopt-recovery.js';
import { recordBridgeReplyMarker } from '../src/services/bridge-reply-marker.js';
import { drainCodexRollout, type CodexBridgeEvent } from '../src/services/codex-transcript.js';
import {
  bridgeGateInputForTurn,
  bridgePostText,
  buildBridgeSendMarkerContent,
  shouldSuppressBridgeEmit,
  shouldSuppressStructuredFallback,
  structuredFallbackKind,
  type BridgeSendMarker,
} from '../src/services/bridge-fallback-gate.js';

const sessionId = 'managed-session';
const chatId = 'chat';
const rootMessageId = 'topic';
const result = 'Both reports accepted: 17 × 19 = 323; 23 × 29 = 667.';

function mergedTurn(count = 2): CodexPendingTurn {
  const queue = new CodexBridgeQueue(() => 1_000);
  for (let i = 1; i <= count; i++) {
    queue.mark(`report-${i}`, `Worker report ${i}`, i * 100);
    queue.ingest([{
      uuid: `user-${i}`, kind: 'user', text: `Worker report ${i}`,
      timestampMs: i * 100 + 10,
      sourceSessionId: 'provider-session', sourceTurnId: 'merged-execution',
      sourceMessageId: `provider-message-${i}`,
    }]);
  }
  queue.ingest([{
    uuid: 'final', kind: 'assistant_final', text: result, timestampMs: 900,
    sourceSessionId: 'provider-session', sourceTurnId: 'merged-execution',
  }]);
  const ready = queue.drainEmittable();
  expect(ready).toHaveLength(1);
  return ready[0];
}

function gate(turn: CodexPendingTurn) {
  return bridgeGateInputForTurn(sessionId, turn, {
    markTimeMs: turn.markTimeMs, isLocal: turn.isLocal,
    finalText: turn.finalText, terminalStatus: turn.terminalStatus,
  }, chatId, rootMessageId);
}

function finalMarker(overrides: Partial<BridgeSendMarker> = {}): BridgeSendMarker {
  return {
    sessionId, turnId: 'report-1',
    targetChatId: chatId, targetRootMessageId: rootMessageId,
    deliveryKind: 'current_session_send', responseKind: 'final',
    messageId: 'delivered-final', sentAtMs: 800,
    ...buildBridgeSendMarkerContent(result),
    ...overrides,
  };
}

describe('structured merged execution final delivery', () => {
  it.each([2, 3])('delivers an explicit final once after %i native same-turn reports', count => {
    const turn = mergedTurn(count);
    const input = gate(turn);

    expect(shouldSuppressBridgeEmit(input, undefined, [finalMarker()], false)).toBe(true);
    // The model's readable final remains in the CLI; only a second IM delivery is suppressed.
    expect(bridgePostText(turn.finalText!, false)).toBe(result);
    const kind = structuredFallbackKind(input, undefined, [finalMarker()], false, true);
    expect(shouldSuppressStructuredFallback(kind, input, undefined, [finalMarker()], false)).toBe(true);
  });

  it.each([
    ['another BotMux session', { sessionId: 'other-session' }],
    ['an unknown BotMux session', { sessionId: undefined }],
    ['a stale durable attempt', { dispatchAttempt: 0 }],
    ['a durable attempt on a plain IM turn', { dispatchAttempt: 1 }],
    ['another chat', { targetChatId: 'other-chat' }],
    ['another topic', { deliveryKind: 'detoured_send', targetRootMessageId: 'other-topic' }],
    ['an unrelated neighbouring turn', { turnId: 'not-merged' }],
    ['an independent side effect', { terminalIndependent: true }],
  ] as const)('keeps the final visible when the receipt belongs to %s', (_label, override) => {
    expect(shouldSuppressBridgeEmit(gate(mergedTurn()), undefined,
      [finalMarker(override)], false)).toBe(false);
  });

  it('does not turn a short progress send into final delivery', () => {
    const input = { ...gate(mergedTurn()), finalText: result.repeat(10) };
    expect(shouldSuppressBridgeEmit(input, undefined,
      [finalMarker({ responseKind: 'progress', contentLength: 2, previewText: 'OK' })], false)).toBe(false);
  });

  it('still delivers an unsent native final when no receipt exists', () => {
    expect(shouldSuppressBridgeEmit(gate(mergedTurn()), undefined, [], false)).toBe(false);
  });

  it('does not accept merged-turn identity from the fallback payload', () => {
    const input = bridgeGateInputForTurn(sessionId, { turnId: 'independent' }, {
      markTimeMs: 700, isLocal: false, finalText: result,
      supersededTurns: [{ turnId: 'report-1' }],
    }, chatId, rootMessageId);
    expect(shouldSuppressBridgeEmit(input, undefined, [finalMarker()], false)).toBe(false);
  });

  it('does not consume an earlier final after a human adds another request', () => {
    const input = gate(mergedTurn());
    expect(shouldSuppressBridgeEmit(input, undefined,
      [finalMarker({ sentAtMs: 150 })], false)).toBe(false);
  });

  it('compares the same visible body that the fallback would post after a trailing sentinel', () => {
    const input = { ...gate(mergedTurn()), finalText: `${result}\n\nBOTMUX_NOTHING_TO_SEND` };
    expect(shouldSuppressBridgeEmit(input, undefined, [finalMarker()], false)).toBe(true);
  });

  it('does not consume a newly produced answer even when the earlier send finishes after the new input', () => {
    const input = { ...gate(mergedTurn()), finalText: 'A different answer for the newly added request.' };
    expect(shouldSuppressBridgeEmit(input, undefined, [finalMarker()], false)).toBe(false);
  });

  it('compares the complete body beyond a shared truncated preview', () => {
    const prefix = 'x'.repeat(5_000);
    const input = { ...gate(mergedTurn()), finalText: prefix + 'new' };
    expect(shouldSuppressBridgeEmit(input, undefined,
      [finalMarker(buildBridgeSendMarkerContent(prefix + 'old'))], false)).toBe(false);
    expect(shouldSuppressBridgeEmit(input, undefined,
      [finalMarker(buildBridgeSendMarkerContent(prefix + 'new'))], false)).toBe(true);
  });

  it('fails open without a body or successor input boundary', () => {
    const input = gate(mergedTurn());
    expect(shouldSuppressBridgeEmit(input, undefined,
      [finalMarker({ contentLength: undefined, previewText: undefined, contentHash: undefined })], false)).toBe(false);
    expect(shouldSuppressBridgeEmit({ ...input, markTimeMs: undefined }, undefined,
      [finalMarker()], false)).toBe(false);
  });

  it('does not deduplicate a later independent native execution with identical text', () => {
    const queue = new CodexBridgeQueue(() => 1_000);
    queue.mark('report-1', 'first execution', 100, 1);
    queue.ingest([
      { uuid: 'u1', kind: 'user', text: 'first execution', timestampMs: 110,
        sourceSessionId: 'provider-session', sourceTurnId: 'native-first' },
      { uuid: 'a1', kind: 'assistant_final', text: result, timestampMs: 200,
        sourceSessionId: 'provider-session', sourceTurnId: 'native-first' },
    ]);
    const [first] = queue.drainEmittable();
    queue.mark('report-2', 'second execution', 300, 2);
    queue.ingest([
      { uuid: 'u2', kind: 'user', text: 'second execution', timestampMs: 310,
        sourceSessionId: 'provider-session', sourceTurnId: 'native-second' },
      { uuid: 'a2', kind: 'assistant_final', text: result, timestampMs: 400,
        sourceSessionId: 'provider-session', sourceTurnId: 'native-second' },
    ]);
    const [second] = queue.drainEmittable();
    const receipt = finalMarker({ sentAtMs: 190, dispatchAttempt: 1 });

    expect(shouldSuppressBridgeEmit(gate(first), undefined, [receipt], false)).toBe(true);
    expect(shouldSuppressBridgeEmit(gate(second), undefined, [receipt], false)).toBe(false);
  });

  it('does not infer a merged execution across provider sessions with matching native IDs', () => {
    const queue = new CodexBridgeQueue(() => 1_000);
    queue.mark('report-1', 'old session input', 100, 1);
    queue.ingest([{ uuid: 'old-user', kind: 'user', text: 'old session input', timestampMs: 110,
      sourceSessionId: 'provider-old', sourceTurnId: 'same-native-id', sourceMessageId: 'old-message' }]);
    queue.mark('report-2', 'new session input', 200, 2);
    queue.ingest([
      { uuid: 'new-user', kind: 'user', text: 'new session input', timestampMs: 210,
        sourceSessionId: 'provider-new', sourceTurnId: 'same-native-id', sourceMessageId: 'new-message' },
      { uuid: 'new-final', kind: 'assistant_final', text: result, timestampMs: 400,
        sourceSessionId: 'provider-new', sourceTurnId: 'same-native-id' },
    ]);
    const [turn] = queue.drainEmittable();

    expect(shouldSuppressBridgeEmit(gate(turn), undefined, [finalMarker()], false)).toBe(false);
  });

  it('does not let a superseded retry attempt cover its successor', () => {
    const queue = new CodexBridgeQueue(() => 1_000);
    queue.mark('retry-task', 'first attempt', 100, 1);
    queue.ingest([{ uuid: 'retry-u1', kind: 'user', text: 'first attempt', timestampMs: 110,
      sourceSessionId: 'provider', sourceTurnId: 'native', sourceMessageId: 'm1' }]);
    queue.mark('retry-task', 'second attempt', 200, 2);
    queue.ingest([
      { uuid: 'retry-u2', kind: 'user', text: 'second attempt', timestampMs: 210,
        sourceSessionId: 'provider', sourceTurnId: 'native', sourceMessageId: 'm2' },
      { uuid: 'retry-final', kind: 'assistant_final', text: result, timestampMs: 900,
        sourceSessionId: 'provider', sourceTurnId: 'native' },
    ]);
    const [turn] = queue.drainEmittable();
    expect(shouldSuppressBridgeEmit(gate(turn), undefined,
      [finalMarker({ turnId: 'retry-task', dispatchAttempt: 1 })], false)).toBe(false);
  });
});

describe('merged final delivery across checkpoint recovery', () => {
  function replay(options: { wrongNative?: boolean; malformedEvidence?: boolean; successorOnly?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'merged-final-recovery-'));
    try {
      const journal = join(dir, 'pending.json');
      const rollout = join(dir, 'rollout.jsonl');
      const native = { sourceSessionId: 'provider', sourceTurnId: 'native' };
      const inputs: CodexBridgeEvent[] = [
        { uuid: 'u1', kind: 'user', text: 'First worker report', timestampMs: 110,
          ...native, sourceMessageId: 'm1' },
        { uuid: 'u2', kind: 'user', text: 'Second worker report', timestampMs: 210,
          ...native, sourceMessageId: 'm2' },
      ];
      const queue = new CodexBridgeQueue(() => 1_000);
      queue.mark('report-1', inputs[0].text, 100);
      queue.ingest([inputs[0]]);
      checkpointCodexAdoptTurns(journal, rollout, queue);
      queue.mark('report-2', inputs[1].text, 200);
      queue.ingest([inputs[1]]);
      checkpointCodexAdoptTurns(journal, rollout, queue);

      const marker = recordBridgeReplyMarker({
        dataDir: dir, sessionId, turnId: 'report-1', sentAtMs: 800,
        responseKind: 'final', deliveryKind: 'current_session_send',
        messageId: 'ack', content: result, targetChatId: chatId, targetRootMessageId: rootMessageId,
      });
      const receipt = JSON.parse(readFileSync(join(dir, 'turn-sends', `${sessionId}.jsonl`), 'utf8'));
      expect(receipt).toEqual(marker);

      if (options.malformedEvidence) {
        const data = JSON.parse(readFileSync(journal, 'utf8'));
        data.pending[0].mergedExecution = { ...native, supersededTurnIds: [42] };
        writeFileSync(journal, JSON.stringify(data));
      }
      const replayed = options.successorOnly ? inputs.slice(1) : inputs;
      const events: CodexBridgeEvent[] = options.wrongNative
        ? [{ ...inputs[1], sourceTurnId: 'new-native', sourceSessionId: 'new-provider' }]
        : [...replayed];
      events.push({ uuid: 'a', kind: 'assistant_final', text: result, timestampMs: 900,
        ...(options.wrongNative ? { sourceTurnId: 'new-native', sourceSessionId: 'new-provider' } : native) });
      const restored = new CodexBridgeQueue(() => 2_000);
      const recovery = restoreCodexAdoptTurns(journal, rollout, restored, events, 1_500, 2_000);
      restored.absorb(recovery.history);
      restored.ingest(recovery.live);
      const ready = restored.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].finalText).toBe(result);
      return shouldSuppressBridgeEmit(gate(ready[0]), undefined, [receipt], false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([false, true])('keeps acknowledged final delivery across restart (successor-only=%s)', successorOnly => {
    expect(replay({ successorOnly })).toBe(true);
  });

  it('does not carry old credit into a new provider execution after restart', () => {
    expect(replay({ wrongNative: true })).toBe(false);
  });

  it('preserves the pending answer but drops malformed optional merge evidence', () => {
    expect(replay({ malformedEvidence: true })).toBe(false);
  });
});

describe('native Codex rollout merge evidence', () => {
  it.each(['task_complete', 'turn_aborted'])('drops native credit after an unattributable %s', terminal => {
    const dir = mkdtempSync(join(tmpdir(), 'unattributable-native-terminal-'));
    try {
      for (const turnId of [undefined, '']) {
        const path = join(dir, `rollout-${turnId === undefined ? 'missing' : 'empty'}.jsonl`);
        const row = (type: string, payload: unknown, time: number) => JSON.stringify({
          type, payload, timestamp: new Date(time).toISOString(),
        }) + '\n';
        const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
        writeFileSync(path, row('session_meta', { id: 'provider-session' }, 50)
          + row('event_msg', { type: 'task_started', turn_id: 'native' }, 100)
          + row('response_item', user('First report'), 200));
        const first = drainCodexRollout(path, 0);
        appendFileSync(path, row('event_msg', { type: terminal, turn_id: turnId, last_agent_message: 'Prior result' }, 250));
        const boundary = drainCodexRollout(path, first.newOffset, first.state);
        expect(boundary.events).toEqual([]); // No fabricated queue settlement.
        appendFileSync(path, row('response_item', user('Second report'), 300));
        const warm = drainCodexRollout(path, boundary.newOffset, boundary.state);
        const cold = drainCodexRollout(path, boundary.newOffset);
        for (const parsed of [warm, cold]) {
          expect(parsed.events.find(event => event.kind === 'user')?.sourceTurnId).toBeUndefined();
          const queue = new CodexBridgeQueue(() => 1_000);
          queue.mark('report-1', 'First report', 190);
          queue.mark('report-2', 'Second report', 290);
          queue.ingest([...first.events, ...boundary.events, ...parsed.events]);
          queue.ingest([{ uuid: 'final', kind: 'assistant_final', text: result, timestampMs: 900,
            sourceTurnId: 'native', sourceSessionId: 'provider-session' }]);
          const ready = queue.drainEmittable();
          expect(ready).toHaveLength(1);
          expect(shouldSuppressBridgeEmit(gate(ready[0]), undefined, [finalMarker()], false)).toBe(false);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('binds id-less user records to their explicit native lifecycle (cold seek=%s)', coldSeek => {
    const dir = mkdtempSync(join(tmpdir(), 'native-merge-rollout-'));
    try {
      const path = join(dir, 'rollout.jsonl');
      const row = (type: string, payload: unknown, time: number) => JSON.stringify({
        type, payload, timestamp: new Date(time).toISOString(),
      }) + '\n';
      const prefix = row('session_meta', { id: 'provider-session' }, 50)
        + row('event_msg', { type: 'task_started', turn_id: 'native-merged' }, 100);
      writeFileSync(path, prefix);
      const first = drainCodexRollout(path, 0);
      const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
      appendFileSync(path, row('response_item', user('First report'), 200)
        + row('response_item', user('Second report'), 300)
        + row('event_msg', { type: 'task_complete', turn_id: 'native-merged', last_agent_message: result }, 900));
      const rest = drainCodexRollout(path, first.newOffset, coldSeek ? undefined : first.state);
      const inputs = rest.events.filter(event => event.kind === 'user');
      expect(inputs).toHaveLength(2);
      expect(inputs.every(event => event.sourceTurnId === 'native-merged'
        && event.sourceSessionId === 'provider-session')).toBe(true);
      expect(inputs[0].sourceMessageId).not.toBe(inputs[1].sourceMessageId);
      const queue = new CodexBridgeQueue(() => 1_000);
      queue.mark('report-1', 'First report', 190);
      queue.mark('report-2', 'Second report', 290);
      queue.ingest([...first.events, ...rest.events]);
      const ready = queue.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(shouldSuppressBridgeEmit(gate(ready[0]), undefined, [finalMarker()], false)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['task_complete', 'turn_aborted'])('does not retain native credit after %s', terminal => {
    const dir = mkdtempSync(join(tmpdir(), 'closed-native-rollout-'));
    try {
      const path = join(dir, 'rollout.jsonl');
      const rows = [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'closed' } },
        { type: 'event_msg', payload: { type: terminal, turn_id: 'closed', last_agent_message: '' } },
      ];
      writeFileSync(path, rows.map(value => JSON.stringify(value) + '\n').join(''));
      const first = drainCodexRollout(path, 0);
      appendFileSync(path, JSON.stringify({ type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'New unrelated input' }],
      } }) + '\n');
      const rest = drainCodexRollout(path, first.newOffset, first.state);
      expect(rest.events.find(event => event.kind === 'user')?.sourceTurnId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reuse native cursor identity for another rollout at the same byte offset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-rollout-switch-'));
    try {
      const a = join(dir, 'a.jsonl');
      const b = join(dir, 'b.jsonl');
      const prefix = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n'
        + JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } }) + '\n';
      writeFileSync(a, prefix('provider-a'));
      writeFileSync(b, prefix('provider-b'));
      const first = drainCodexRollout(a, 0);
      appendFileSync(b, JSON.stringify({ type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Input in the other rollout' }],
      } }) + '\n');
      const next = drainCodexRollout(b, first.newOffset, first.state);
      expect(next.events.find(event => event.kind === 'user')).toMatchObject({
        sourceTurnId: 'provider-b', sourceSessionId: 'provider-b',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries cold-seek execution proof through a long incremental wait', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-cold-wait-'));
    try {
      const path = join(dir, 'rollout.jsonl');
      const prefix = JSON.stringify({ type: 'session_meta', payload: { id: 'provider' } }) + '\n'
        + JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'native' } }) + '\n';
      const user = (text: string) => JSON.stringify({ type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text }],
      } }) + '\n';
      writeFileSync(path, prefix + user('first cold input'));
      const first = drainCodexRollout(path, Buffer.byteLength(prefix));
      appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: {
        type: 'progress', blob: 'x'.repeat(5 * 1024 * 1024),
      } }) + '\n');
      const waiting = drainCodexRollout(path, first.newOffset, first.state);
      appendFileSync(path, user('second cold input'));
      const next = drainCodexRollout(path, waiting.newOffset, waiting.state);
      expect(next.events.find(event => event.kind === 'user')).toMatchObject({
        sourceTurnId: 'native', sourceSessionId: 'provider',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
