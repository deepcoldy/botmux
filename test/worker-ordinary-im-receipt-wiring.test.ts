/**
 * native_input_consumed covers shared group background, so it may only be sent
 * where the CLI itself evidenced this exact input. Executes the worker's real
 * Claude transcript boundary (helpers/worker-function-harness.ts). Ordinary IM
 * receipt / queue-head ordering during init is executed against a real worker
 * in worker-ordinary-im-init-concurrency.integration.test.ts.
 */
import { basename } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

type Notify = (
  turn: { turnId: string; isLocal?: boolean; isScheduled?: boolean },
  evidence: { fullContentMatch: boolean; sourceJsonlPath?: string },
) => void;

function claudeTranscriptHarness(overrides: Record<string, unknown> = {}) {
  const acknowledgeNativeInputConsumed = vi.fn();
  const scope: Record<string, unknown> = {
    cliAdapter: { claudeDataDir: '/home/u/.claude' },
    lastInitConfig: { cliSessionId: 'configured-session', adoptMode: false },
    basename,
    acknowledgeNativeInputConsumed,
    ...overrides,
  };
  const notify = loadWorkerFunction<Notify>('notifyNativeTranscriptConsumedLarkTurn', scope);
  return { notify, acknowledgeNativeInputConsumed };
}

const transcript = '/home/u/.claude/projects/p/0f3c1d2e-aaaa-bbbb-cccc-1234567890ab.jsonl';

describe('Claude transcript native input consumption receipt', () => {
  it('acknowledges a full transcript match with the transcript-derived native session id', () => {
    const h = claudeTranscriptHarness();
    h.notify({ turnId: 'om_turn' }, { fullContentMatch: true, sourceJsonlPath: transcript });
    expect(h.acknowledgeNativeInputConsumed).toHaveBeenCalledExactlyOnceWith(
      'om_turn', 'claude_transcript_user_record', '0f3c1d2e-aaaa-bbbb-cccc-1234567890ab',
    );
  });

  it('never acknowledges partial matches, local or scheduled turns, adopted or non-Claude sessions', () => {
    const cases: Array<[Parameters<Notify>, Record<string, unknown>]> = [
      [[{ turnId: 'om_partial' }, { fullContentMatch: false, sourceJsonlPath: transcript }], {}],
      [[{ turnId: 'om_local', isLocal: true }, { fullContentMatch: true, sourceJsonlPath: transcript }], {}],
      [[{ turnId: 'om_scheduled', isScheduled: true }, { fullContentMatch: true, sourceJsonlPath: transcript }], {}],
      [[{ turnId: 'om_adopted' }, { fullContentMatch: true, sourceJsonlPath: transcript }],
        { lastInitConfig: { cliSessionId: 'adopted', adoptMode: true } }],
      [[{ turnId: 'om_codex' }, { fullContentMatch: true, sourceJsonlPath: transcript }], { cliAdapter: {} }],
    ];
    for (const [args, overrides] of cases) {
      const h = claudeTranscriptHarness(overrides);
      h.notify(...args);
      expect(h.acknowledgeNativeInputConsumed, args[0].turnId).not.toHaveBeenCalled();
    }
  });
});

describe('consumed input updates addressing without advancing execution', () => {
  it('publishes only a consumed queued input and preserves every final obligation', () => {
    const queue = [{ turnId: 'om_b' }, { turnId: 'om_c' }];
    const snapshots: unknown[] = [];
    const scope: Record<string, unknown> = {
      queuedTypeAheadTurns: queue,
      writeCliPidMarker: () => snapshots.push(structuredClone(queue)),
      inflightInputs: { onTurnStarted: vi.fn() },
      lastWrittenCliInput: undefined,
      send: vi.fn(),
    };
    scope.markReplyInputConsumed = loadWorkerFunction('markReplyInputConsumed', scope);
    const acknowledge = loadWorkerFunction<(id: string, proof: string) => void>('acknowledgeNativeInputConsumed', scope);
    acknowledge('om_b', 'claude_transcript_user_record');
    expect(snapshots).toEqual([[{ turnId: 'om_b', inputConsumed: true }, { turnId: 'om_c' }]]);
    acknowledge('om_b', 'claude_transcript_user_record');
    acknowledge('om_missing', 'codex_history_match');
    expect(snapshots).toHaveLength(1);
    acknowledge('om_c', 'codex_history_match');
    expect(snapshots).toHaveLength(2);
    expect(queue.map(t => t.turnId)).toEqual(['om_b', 'om_c']);
  });
});
