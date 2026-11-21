/**
 * native_input_consumed covers shared group background, so it may only be sent
 * where the CLI itself evidenced this exact input. Executes the worker's real
 * Claude transcript boundary (helpers/worker-function-harness.ts). Ordinary IM
 * receipt / queue-head ordering during init is executed against a real worker
 * in worker-ordinary-im-init-concurrency.integration.test.ts.
 */
import { basename, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { createQueuedActivationReceiptObserver } from '../src/services/queued-activation-receipts.js';
import {
  readSessionTurns,
  recordSessionTurnInput,
  stageSessionTurnInbound,
  updateSessionTurnNativeAnchor,
} from '../src/services/session-turns.js';

type Notify = (
  turn: { turnId: string; userUuid?: string; isLocal?: boolean; isScheduled?: boolean },
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

  it('forwards userUuid as the native turn anchor when present', () => {
    const h = claudeTranscriptHarness();
    h.notify({ turnId: 'om_turn', userUuid: 'user-uuid-1' }, { fullContentMatch: true, sourceJsonlPath: transcript });
    expect(h.acknowledgeNativeInputConsumed).toHaveBeenCalledExactlyOnceWith(
      'om_turn', 'claude_transcript_user_record', '0f3c1d2e-aaaa-bbbb-cccc-1234567890ab', 'user-uuid-1',
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
      scheduleConsumedQueuedTurnAdvance: vi.fn(),
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

describe('queued activation structured turn receipt', () => {
  async function expectDeferredReceipt(
    result: { submitted: boolean; cliSessionId?: string; unprovenCliSessionId?: string },
    expectedSessionId: string | undefined,
    allowFallback: boolean,
  ) {
    vi.useFakeTimers();
    const receipts = createQueuedActivationReceiptObserver(20);
    const recordStructuredInput = vi.fn();
    const acknowledgeQueuedActivation = vi.fn();
    const scope: Record<string, unknown> = {
      backend: {}, cliSpawnGeneration: 1, cliRestartInProgress: false,
      queuedActivationReceipts: receipts,
      recordStructuredInput,
      persistCliSessionId: vi.fn(),
      codexBridgeFallbackActive: () => false,
      syncFreshCodexNativeSessionTitle: vi.fn(),
      queuePostSubmitNativeSessionTitle: vi.fn(),
      acknowledgeQueuedActivation,
    };
    const observe = loadWorkerFunction<(
      item: { turnId: string; queuedActivationToken: string; structuredSourceTurnIds: string[] },
      recheck: () => typeof result,
      submittedText: string,
    ) => void>('observeQueuedActivationReceipt', scope);
    try {
      observe({
        turnId: 'om_new', queuedActivationToken: 'activation-token',
        structuredSourceTurnIds: ['om_old', 'om_new'],
      }, () => result, 'prepared\r\ninput');
      await vi.advanceTimersByTimeAsync(20);
      expect(recordStructuredInput).toHaveBeenCalledExactlyOnceWith(
        'om_new', 'prepared\r\ninput', ['om_old', 'om_new'], expectedSessionId, allowFallback,
      );
      expect(acknowledgeQueuedActivation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        turnId: 'om_new', queuedActivationToken: 'activation-token',
      }));
    } finally {
      receipts.clear();
      vi.useRealTimers();
    }
  }

  it('records the exact prepared input when the independent receipt watcher confirms', async () => {
    await expectDeferredReceipt({ submitted: true, cliSessionId: 'native-thread' }, 'native-thread', true);
  });

  it('does not inherit an old native session for an unproven deferred candidate', async () => {
    await expectDeferredReceipt({ submitted: true, unprovenCliSessionId: 'candidate-new-thread' }, undefined, false);
  });
});

describe('structured input native session fallback', () => {
  it('keeps an unproven deferred input unbound until owned proof arrives', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-deferred-native-anchor-'));
    const previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    const sessionId = 'fixture-session';
    try {
      for (const turnId of ['om_default', 'om_unproven']) {
        stageSessionTurnInbound(dataDir, sessionId, turnId, {
          via: 'lark', messageId: turnId, text: turnId, placement: { kind: 'chat' },
        });
      }
      const scope: Record<string, unknown> = {
        sessionId,
        lastInitConfig: { cliId: 'codex', cliSessionId: 'old-native-thread' },
        lastSpawnEffectiveCliSessionId: undefined,
        closeRequested: false,
        recordSessionTurnInput,
        log: vi.fn(),
      };
      const record = loadWorkerFunction<(
        turnId: string | undefined,
        input: string,
        sourceTurnIds?: string[],
        cliSessionId?: string,
        allowCliSessionIdFallback?: boolean,
      ) => void>('recordStructuredInput', scope);
      record('om_default', 'default input');
      record('om_unproven', 'unproven input', undefined, undefined, false);

      const beforeProof = readSessionTurns(dataDir, sessionId, 0, 50).turns;
      expect(beforeProof.find(turn => turn.turnId === 'om_default')?.anchor?.cliSessionId)
        .toBe('old-native-thread');
      expect(beforeProof.find(turn => turn.turnId === 'om_unproven')?.anchor?.cliSessionId)
        .toBeUndefined();

      updateSessionTurnNativeAnchor(dataDir, sessionId, 'om_unproven', 'candidate-new-thread');
      expect(readSessionTurns(dataDir, sessionId, 0, 50).turns
        .find(turn => turn.turnId === 'om_unproven')?.anchor?.cliSessionId)
        .toBe('candidate-new-thread');
    } finally {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
